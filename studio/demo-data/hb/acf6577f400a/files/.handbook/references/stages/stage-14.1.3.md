# Hook execution and stop-continue mediation  `stage-14.1.3`

This stage is the system’s checkpoint network. It runs user-configured hooks, which are small external commands, at key moments in the conversation: session start, prompt submit, tool use, permission checks, compaction, and stopping. The registry and engine module are the front desk. They build the hook system, list hooks, preview them, and route events to the right runner, while still supporting the older notify path. Discovery finds hook definitions in config, policy, and plugins, then checks whether they are trusted. The dispatcher chooses which hooks match an event. The command runner starts those hooks as real processes, sends them JSON input, and captures results. The output parser turns their printed text into decisions the system understands, and output spill saves oversized output to a temp file with a short preview. The runtime connects all this back to the main conversation, progress reporting, telemetry, and added context. Event handlers apply the decisions: start and prompt hooks may add context or stop work; pre- and post-tool hooks may block, rewrite, warn, or continue; permission hooks approve or deny; compaction hooks guard history shrinking; stop hooks decide whether to end, block, or continue.

## Files in this stage

### Registry and runtime entrypoints
These files expose the public hook APIs and connect session-level runtime flows to the hook engine and legacy notification path.

### `hooks/src/registry.rs`

`orchestration` · `startup and hook event handling`

Hooks are small external actions that Codex can run at important moments, such as when a session starts, before a tool runs, after a tool runs, or when the user submits a prompt. This file gives the rest of the program one simple object, `Hooks`, instead of making every caller know how hooks are loaded, trusted, previewed, and executed.

Think of it like a reception desk. Other parts of the app say, “A session is starting” or “A tool is about to run,” and this file sends that request to the right hook machinery. Most modern hook work is delegated to `ClaudeHooksEngine`, which knows how to discover and run configured hook handlers. The file also keeps a small older path called `after_agent`, built from `legacy_notify_argv`, for legacy notification-style hooks.

The `HooksConfig` struct gathers all the setup choices: whether hooks are enabled, whether trust checks are bypassed, configuration layers, plugin-provided hook sources, startup warnings, and shell settings. `list_hooks` uses similar configuration to discover hook entries for display without executing them. `command_from_argv` is a small helper that turns a command-line-style list of strings into an executable process command.

#### Function details

##### `Hooks::default`  (lines 54–56)

```
fn default() -> Self
```

**Purpose**: Creates a `Hooks` registry using all default settings. This is useful when code needs a hook registry but has no special configuration to provide.

**Data flow**: It starts with no input from the caller, creates a default `HooksConfig`, and passes that into `Hooks::new`. The result is a ready-to-use `Hooks` object with default behavior.

**Call relations**: This is the convenience path into `Hooks::new`. Instead of duplicating setup logic, it relies on the normal constructor to build the registry.

*Call graph*: 2 external calls (new, default).


##### `Hooks::new`  (lines 60–82)

```
fn new(config: HooksConfig) -> Self
```

**Purpose**: Builds the main hook registry from configuration. It turns legacy notify settings into old-style hooks and builds the newer hook engine for all modern hook events.

**Data flow**: It receives a `HooksConfig`. If a legacy notify command is present and usable, it converts it into an `after_agent` hook. It also passes feature flags, trust settings, config layers, plugin hook sources, warnings, and shell settings into `ClaudeHooksEngine::new`. It returns a `Hooks` object containing both the legacy hooks and the engine.

**Call relations**: This is the main setup function. It is called when building hooks from configuration, when creating sessions and test contexts, when previewing session-start hooks, and in permission-hook tests. After construction, later methods on `Hooks` use the stored engine or legacy hook list.

*Call graph*: calls 1 internal fn (new); called by 6 (install_mcp_permission_request_hook, build_hooks_for_config, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, preview_session_start_hooks, execve_permission_request_hook_short_circuits_prompt).


##### `Hooks::startup_warnings`  (lines 84–86)

```
fn startup_warnings(&self) -> &[String]
```

**Purpose**: Returns warnings collected while setting up hooks. A caller can show these to the user so hook configuration problems are visible early.

**Data flow**: It reads the warning list stored inside the hook engine and returns it as a borrowed slice. It does not change anything.

**Call relations**: After `Hooks::new` builds the engine, this method gives the rest of the app a safe way to read the engine’s startup warnings.

*Call graph*: calls 1 internal fn (warnings).


##### `Hooks::hooks_for_event`  (lines 88–92)

```
fn hooks_for_event(&self, hook_event: &HookEvent) -> &[Hook]
```

**Purpose**: Finds the legacy hooks that apply to a particular legacy hook event. At present, it maps the `AfterAgent` event to the stored `after_agent` hook list.

**Data flow**: It receives a `HookEvent`, checks which kind of event it is, and returns the matching slice of legacy `Hook` objects. It does not run the hooks.

**Call relations**: This is an internal helper used by `Hooks::dispatch`. `dispatch` asks it which legacy hooks are relevant before executing them.

*Call graph*: called by 1 (dispatch).


##### `Hooks::dispatch`  (lines 94–107)

```
async fn dispatch(&self, hook_payload: HookPayload) -> Vec<HookResponse>
```

**Purpose**: Runs the legacy hooks for a given hook payload, one after another. It stops early if a hook says the operation should be aborted.

**Data flow**: It receives a `HookPayload`, uses the payload’s event to find matching legacy hooks, then executes each hook asynchronously. It collects each `HookResponse` into a vector. If a response says to abort, it stops running more hooks and returns the responses collected so far.

**Call relations**: This is the runner for the older hook path. It depends on `Hooks::hooks_for_event` to choose hooks, then calls each hook’s execution method and returns the outcomes to the caller.

*Call graph*: calls 1 internal fn (hooks_for_event); 1 external calls (with_capacity).


##### `Hooks::preview_session_start`  (lines 109–114)

```
fn preview_session_start(
        &self,
        request: &SessionStartRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows what session-start hooks would run, without actually running them. This helps callers explain or display hook activity before it happens.

**Data flow**: It receives a session-start request by reference, passes it to the engine’s preview method, and returns a list of hook run summaries. No hook side effects occur.

**Call relations**: This is a thin public doorway into the engine. Callers use `Hooks`, and `Hooks` delegates the preview work to `ClaudeHooksEngine`.

*Call graph*: calls 1 internal fn (preview_session_start).


##### `Hooks::preview_pre_tool_use`  (lines 116–121)

```
fn preview_pre_tool_use(
        &self,
        request: &PreToolUseRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run before a tool is used, without executing them. This is useful for transparency and planning.

**Data flow**: It receives a pre-tool-use request by reference, forwards it to the engine, and returns summary records describing the matching hooks.

**Call relations**: This method keeps callers from talking directly to the engine. It simply hands the preview request to the engine’s pre-tool-use preview function.

*Call graph*: calls 1 internal fn (preview_pre_tool_use).


##### `Hooks::preview_permission_request`  (lines 123–128)

```
fn preview_permission_request(
        &self,
        request: &PermissionRequestRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run for a permission request, without running them. Permission requests are moments where Codex asks whether an action should be allowed.

**Data flow**: It receives a permission request by reference, sends it to the engine’s preview function, and returns hook run summaries.

**Call relations**: This is part of the public `Hooks` facade. It delegates the real matching and summary-building work to `ClaudeHooksEngine`.

*Call graph*: calls 1 internal fn (preview_permission_request).


##### `Hooks::preview_post_tool_use`  (lines 130–135)

```
fn preview_post_tool_use(
        &self,
        request: &PostToolUseRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run after a tool has been used, without executing them. This lets the system report planned post-tool hook behavior safely.

**Data flow**: It receives a post-tool-use request by reference, forwards it to the engine, and returns summaries of the hooks that would match.

**Call relations**: The method is a pass-through from the registry API to the engine’s post-tool-use preview logic.

*Call graph*: calls 1 internal fn (preview_post_tool_use).


##### `Hooks::run_session_start`  (lines 137–143)

```
async fn run_session_start(
        &self,
        request: SessionStartRequest,
        turn_id: Option<String>,
    ) -> SessionStartOutcome
```

**Purpose**: Runs hooks that should fire when a session starts. These hooks can perform setup or return information that affects the session-start flow.

**Data flow**: It receives a `SessionStartRequest` and an optional turn identifier, passes both into the engine asynchronously, waits for completion, and returns a `SessionStartOutcome`.

**Call relations**: Callers use this method when the session-start event actually happens. The registry delegates execution to the engine, which performs the hook work and produces the outcome.

*Call graph*: calls 1 internal fn (run_session_start).


##### `Hooks::run_pre_tool_use`  (lines 145–147)

```
async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome
```

**Purpose**: Runs hooks before a tool is used. These hooks can inspect or influence whether and how the tool action should proceed.

**Data flow**: It receives a `PreToolUseRequest`, gives it to the engine asynchronously, and returns the resulting `PreToolUseOutcome`.

**Call relations**: This is the public execution path for pre-tool hooks. It hands the request to the engine, which decides which configured hooks apply and runs them.

*Call graph*: calls 1 internal fn (run_pre_tool_use).


##### `Hooks::run_permission_request`  (lines 149–154)

```
async fn run_permission_request(
        &self,
        request: PermissionRequestRequest,
    ) -> PermissionRequestOutcome
```

**Purpose**: Runs hooks for a permission request. These hooks can help decide or shape the response when Codex needs approval for an action.

**Data flow**: It receives a `PermissionRequestRequest`, forwards it to the engine asynchronously, and returns a `PermissionRequestOutcome`.

**Call relations**: When permission logic reaches the hook stage, it calls this registry method. The method delegates execution to the engine and returns the engine’s decision-shaped result.

*Call graph*: calls 1 internal fn (run_permission_request).


##### `Hooks::run_post_tool_use`  (lines 156–158)

```
async fn run_post_tool_use(&self, request: PostToolUseRequest) -> PostToolUseOutcome
```

**Purpose**: Runs hooks after a tool has finished. These hooks can react to the tool result, such as logging, cleanup, or follow-up checks.

**Data flow**: It receives a `PostToolUseRequest`, sends it to the engine asynchronously, and returns a `PostToolUseOutcome`.

**Call relations**: This is the registry’s public post-tool execution entry. The actual hook selection and running are done by the engine.

*Call graph*: calls 1 internal fn (run_post_tool_use).


##### `Hooks::preview_pre_compact`  (lines 160–165)

```
fn preview_pre_compact(
        &self,
        request: &PreCompactRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run before conversation compaction, without executing them. Compaction means shortening or summarizing stored conversation context.

**Data flow**: It receives a pre-compact request by reference, passes it to the engine, and returns summaries of matching hooks.

**Call relations**: This method is a preview doorway. It lets callers ask the registry what the engine would do before compaction, while avoiding side effects.

*Call graph*: calls 1 internal fn (preview_pre_compact).


##### `Hooks::run_pre_compact`  (lines 167–169)

```
async fn run_pre_compact(&self, request: PreCompactRequest) -> PreCompactOutcome
```

**Purpose**: Runs hooks before conversation compaction. These hooks can inspect or influence the compaction step before it happens.

**Data flow**: It receives a `PreCompactRequest`, forwards it to the engine asynchronously, and returns a `PreCompactOutcome`.

**Call relations**: When the compaction process reaches its pre-hook phase, this method passes control to the engine and returns the outcome.

*Call graph*: calls 1 internal fn (run_pre_compact).


##### `Hooks::preview_post_compact`  (lines 171–176)

```
fn preview_post_compact(
        &self,
        request: &PostCompactRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run after conversation compaction, without executing them. This gives visibility into follow-up hook activity.

**Data flow**: It receives a post-compact request by reference, delegates to the engine, and returns hook run summaries.

**Call relations**: This is the registry-level preview path for post-compaction hooks. The engine does the matching and summary creation.

*Call graph*: calls 1 internal fn (preview_post_compact).


##### `Hooks::run_post_compact`  (lines 178–180)

```
async fn run_post_compact(&self, request: PostCompactRequest) -> StatelessHookOutcome
```

**Purpose**: Runs hooks after conversation compaction has happened. These hooks are stateless here, meaning they return a general success or result rather than changing a larger hook-specific state.

**Data flow**: It receives a `PostCompactRequest`, sends it to the engine asynchronously, and returns a `StatelessHookOutcome`.

**Call relations**: After compaction, callers use this method to trigger configured post-compact hooks through the engine.

*Call graph*: calls 1 internal fn (run_post_compact).


##### `Hooks::preview_user_prompt_submit`  (lines 182–187)

```
fn preview_user_prompt_submit(
        &self,
        request: &UserPromptSubmitRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run when the user submits a prompt, without actually running them. This can help explain what automation is attached to user input.

**Data flow**: It receives a user-prompt-submit request by reference, forwards it to the engine, and returns summaries of matching hooks.

**Call relations**: This is a public preview wrapper. The registry accepts the request and the engine performs the hook matching.

*Call graph*: calls 1 internal fn (preview_user_prompt_submit).


##### `Hooks::run_user_prompt_submit`  (lines 189–194)

```
async fn run_user_prompt_submit(
        &self,
        request: UserPromptSubmitRequest,
    ) -> UserPromptSubmitOutcome
```

**Purpose**: Runs hooks when the user submits a prompt. These hooks can inspect or affect the submitted prompt flow.

**Data flow**: It receives a `UserPromptSubmitRequest`, passes it into the engine asynchronously, and returns a `UserPromptSubmitOutcome`.

**Call relations**: When prompt submission reaches the hook stage, this method is the registry entry point. It delegates to the engine and returns the engine’s outcome.

*Call graph*: calls 1 internal fn (run_user_prompt_submit).


##### `Hooks::preview_stop`  (lines 196–201)

```
fn preview_stop(
        &self,
        request: &StopRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Shows which hooks would run when a stop event occurs, without executing them. A stop event is part of shutting down or ending an operation.

**Data flow**: It receives a stop request by reference, sends it to the engine’s preview function, and returns hook run summaries.

**Call relations**: This method exposes stop-hook previewing through the registry facade while keeping the actual matching inside the engine.

*Call graph*: calls 1 internal fn (preview_stop).


##### `Hooks::run_stop`  (lines 203–205)

```
async fn run_stop(&self, request: StopRequest) -> StopOutcome
```

**Purpose**: Runs hooks for a stop event. These hooks can perform final checks, cleanup, or other configured stop-time actions.

**Data flow**: It receives a `StopRequest`, forwards it to the engine asynchronously, and returns a `StopOutcome`.

**Call relations**: When a stop event is actually being processed, callers use this method. The registry hands the request to the engine and returns the result.

*Call graph*: calls 1 internal fn (run_stop).


##### `list_hooks`  (lines 208–223)

```
fn list_hooks(config: HooksConfig) -> HookListOutcome
```

**Purpose**: Discovers configured hooks and returns them for display, without running them. If the hook feature is turned off, it returns an empty result.

**Data flow**: It receives a `HooksConfig`. If hooks are disabled, it returns the default empty `HookListOutcome`. If hooks are enabled, it asks the discovery system to find hook handlers using config layers, plugin sources, plugin warnings, and trust settings. It returns the discovered hook entries plus any warnings.

**Call relations**: This function is separate from `Hooks::new` because listing hooks is different from running hooks. It calls the discovery layer directly to produce a report-style outcome.

*Call graph*: calls 1 internal fn (discover_handlers); 1 external calls (default).


##### `command_from_argv`  (lines 225–233)

```
fn command_from_argv(argv: &[String]) -> Option<Command>
```

**Purpose**: Turns a command-line-style list of strings into a process command that can be run later. The first string is the program name, and the rest are its arguments.

**Data flow**: It receives a slice of strings. If the slice is empty, or if the first string is empty, it returns `None` because there is no valid program to run. Otherwise it creates a `tokio::process::Command`, attaches the remaining strings as arguments, and returns it inside `Some`.

**Call relations**: This is a small utility used wherever hook code needs to convert stored command arguments into an executable command. It relies on Tokio’s process command type, which is used for running external programs asynchronously.

*Call graph*: 1 external calls (new).


### `core/src/hook_runtime.rs`

`orchestration` · `cross-cutting during session turns, tool calls, approvals, compaction, and shutdown`

Hooks let users or organizations add custom checks and actions around a Codex session, like “before running a tool, inspect the command” or “when a session starts, add extra instructions.” This file is the runtime layer that makes those hooks fit safely into the normal turn flow. Without it, hooks might not run at the right time, users would not see hook start and finish events, and decisions like blocking a tool call or stopping a turn would be lost.

The file follows a repeated pattern. First it builds a request using the current session, turn id, working directory, model, transcript path, permission mode, and sometimes tool input or subagent information. Then it asks the hook system for a preview, so the UI can be told which hooks are starting. It runs the hooks, emits completion events, and records measurements and analytics. Some hooks can return extra context; this file turns that text into developer messages and adds them to the conversation, like slipping notes into the transcript for the model to read later.

It also knows about special cases: thread-spawned subagents get subagent hook targets, internal subagents skip lifecycle hooks, legacy after-agent hooks still run, and compaction hooks can stop a compaction process.

#### Function details

##### `ContextInjectingHookOutcome::from`  (lines 85–99)

```
fn from(value: UserPromptSubmitOutcome) -> Self
```

**Purpose**: Converts hook outcomes that can add extra context into one common internal shape. This lets session-start hooks and user-prompt hooks be treated the same way after they finish.

**Data flow**: It receives a hook outcome with completed hook events, a stop flag, and added context strings. It ignores the detailed stop reason, keeps the events, and produces a `ContextInjectingHookOutcome` containing a simpler `HookRuntimeOutcome`.

**Call relations**: This conversion is used by `run_context_injecting_hook` after it awaits either a session-start hook run or a user-prompt-submit hook run. That shared helper can then emit completion events and return the same kind of result to its caller.


##### `run_pending_session_start_hooks`  (lines 103–156)

```
async fn run_pending_session_start_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
) -> bool
```

**Purpose**: Runs any session-start hooks that are waiting to fire. These hooks can add context to the conversation or ask the runtime to stop early.

**Data flow**: It reads pending start sources from the session one by one. For each one, it builds a request with session details, model, permission mode, transcript path, and the correct target: a normal session start or a thread-spawned subagent start. It previews the hooks, runs them, records any added context, and returns `true` if a hook says the session should stop.

**Call relations**: The main turn runner calls this near the start of a turn. It uses `hook_permission_mode` to describe the approval setting, `subagent_hook_context` when the turn belongs to a thread-spawned subagent, and `run_context_injecting_hook` for the common start/complete event flow.

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

**Purpose**: Runs hooks before a tool is allowed to execute. These hooks can let the tool proceed, change the tool input, add context, or block the tool call with a message.

**Data flow**: It receives the session, turn, tool id, tool name, and tool input. It builds a stable hook request, emits “hook started” events, runs matching pre-tool hooks, emits completion events, records any added context, and returns either `Continue` with optional updated input or `Blocked` with a human-readable reason.

**Call relations**: Tool dispatch calls this before executing a tool. It relies on `thread_spawn_subagent_hook_context` to include subagent details when needed, `hook_permission_mode` to describe approval behavior, and the emit/record helpers to keep the session transcript and UI in sync.

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

**Purpose**: Runs hooks when Codex is about to ask for permission, such as approval for a tool action. These hooks can optionally supply a decision so the normal approval path can be adjusted.

**Data flow**: It receives a permission request payload, session and turn information, and a run id suffix. It builds a request with the tool name, aliases, input, transcript path, model, and permission mode, emits started events, runs permission hooks, emits completed events, and returns an optional decision.

**Call relations**: Approval-related paths call this before or during permission prompts. It uses the same event helpers as other hook types, but unlike pre-tool hooks it does not change tool input or record extra context.

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

**Purpose**: Runs hooks after a tool has successfully produced output. This gives hooks a chance to observe the tool input and response after the fact.

**Data flow**: It receives the tool id, public tool name, matcher aliases, hook-safe tool input, and hook-safe tool response. It builds a request, emits started events, runs matching post-tool hooks, emits completed events, and returns the full post-tool outcome.

**Call relations**: Tool dispatch calls this after a successful tool run. It depends on callers to pass the stable hook-facing data, then uses `thread_spawn_subagent_hook_context`, `hook_permission_mode`, and event emitters to fit the hook run into the session flow.

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

**Purpose**: Runs stop hooks when a turn is ending. Stop hooks can inspect the final assistant message and may influence whether stopping work continues.

**Data flow**: It reads whether the turn is a normal session, a thread-spawned subagent, or an internal subagent. It builds either a normal stop request or a subagent stop request, including transcript paths when available. It emits started events, runs stop hooks, emits completed events, removes the events from the returned outcome, and returns the remaining stop outcome.

**Call relations**: The main turn runner calls this near turn completion. It calls `subagent_hook_context` for thread-spawned subagents, skips internal subagents, uses `hook_permission_mode`, and sends all visible hook progress through the shared event helpers.

*Call graph*: calls 4 internal fn (emit_hook_completed_events, emit_hook_started_events, hook_permission_mode, subagent_hook_context); called by 1 (run_turn); 3 external calls (default, take, warn!).


##### `run_pre_compact_hooks`  (lines 368–393)

```
async fn run_pre_compact_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    trigger: CompactionTrigger,
) -> PreCompactHookOutcome
```

**Purpose**: Runs hooks just before conversation compaction starts. Compaction means shortening or summarizing stored context so the system can keep working within limits.

**Data flow**: It receives the session, turn, and compaction trigger. It labels the trigger as manual or automatic, builds a pre-compaction request, emits started events, runs the hooks, emits completed events, and returns whether compaction should continue or stop.

**Call relations**: Local and remote compaction tasks call this before compacting. It uses `compaction_trigger_label` for the hook-facing trigger text and `thread_spawn_subagent_hook_context` so subagent compactions carry the right context.

*Call graph*: calls 4 internal fn (compaction_trigger_label, emit_hook_completed_events, emit_hook_started_events, thread_spawn_subagent_hook_context); called by 3 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner).


##### `run_post_compact_hooks`  (lines 405–430)

```
async fn run_post_compact_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    trigger: CompactionTrigger,
) -> PostCompactHookOutcome
```

**Purpose**: Runs hooks after conversation compaction has happened. These hooks can observe the compaction event and can ask the surrounding flow to stop.

**Data flow**: It receives session and turn information plus the compaction trigger. It builds a post-compaction request, emits started events, runs the hooks, emits completed events, and returns either `Continue` or `Stopped`.

**Call relations**: Compaction tasks call this after local or remote compaction work. It mirrors `run_pre_compact_hooks`, using the same trigger-label and subagent-context helpers.

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

**Purpose**: Runs the older “after agent” hook format after an agent turn. This keeps backward compatibility for hook configurations that predate the newer hook system.

**Data flow**: It receives the recent response items and optional last assistant message. It extracts user messages from the input, dispatches the legacy hook payload, logs failures, remembers the first failure that says to abort, and if needed sends an error event to the session. It returns `true` when the turn completion was aborted.

**Call relations**: The main turn runner calls this after agent work. It does not use the newer preview/completed event path; instead it talks to the older hook dispatcher and reports aborts as session error events.

*Call graph*: called by 1 (run_turn); 5 external calls (now, format!, iter, Error, warn!).


##### `inspect_pending_input`  (lines 500–537)

```
async fn inspect_pending_input(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    pending_input_item: &TurnInput,
) -> HookRuntimeOutcome
```

**Purpose**: Inspects input before it is recorded into the conversation. For normal user text, it runs user-prompt-submit hooks that may add context or stop the turn.

**Data flow**: It receives a pending turn input. If the input is user text, it builds a prompt-submit hook request, previews and runs those hooks, and returns whether to stop plus any added context. If the input is already a response item or inter-agent communication, it returns a no-op outcome.

**Call relations**: Input-recording flows call this before committing pending input. It uses `run_context_injecting_hook` for the common hook event flow and `thread_spawn_subagent_hook_context` and `hook_permission_mode` to fill in request details.

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

**Purpose**: Records a pending input item into the session transcript, then records any context that hooks added. This is the point where inspected input becomes part of the conversation history.

**Data flow**: It receives one pending input and a list of added context strings. Depending on the input kind, it records a user prompt, response item, or inter-agent communication. Then it turns the added context into developer messages and records those too.

**Call relations**: The input flow calls this after `inspect_pending_input` has run. It hands extra context to `record_additional_contexts`, keeping hook-added notes next to the input they relate to.

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

**Purpose**: Provides the common run pattern for hooks that can add context to the conversation. It keeps session-start and user-prompt-submit hook handling consistent.

**Data flow**: It receives preview information and a future hook result. It emits started events from the preview, waits for the hook outcome, converts that outcome into a common shape, emits completed events, and returns the stop flag plus added context.

**Call relations**: `run_pending_session_start_hooks` and `inspect_pending_input` call this instead of duplicating the same start-run-complete sequence. It delegates event sending to `emit_hook_started_events` and `emit_hook_completed_events`.

*Call graph*: calls 2 internal fn (emit_hook_completed_events, emit_hook_started_events); called by 2 (inspect_pending_input, run_pending_session_start_hooks).


##### `HookRuntimeOutcome::record_additional_contexts`  (lines 584–592)

```
async fn record_additional_contexts(
        self,
        sess: &Arc<Session>,
        turn_context: &Arc<TurnContext>,
    ) -> bool
```

**Purpose**: Records the extra context carried by a hook outcome and then returns the hook’s stop decision. It is a small convenience method for flows that need both actions in order.

**Data flow**: It consumes a `HookRuntimeOutcome`, sends its context strings to `record_additional_contexts`, and then returns the original `should_stop` value.

**Call relations**: `run_pending_session_start_hooks` uses this after running a context-injecting hook, so added context is stored before the caller reacts to a possible stop request.

*Call graph*: calls 1 internal fn (record_additional_contexts).


##### `record_additional_contexts`  (lines 595–607)

```
async fn record_additional_contexts(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    additional_contexts: Vec<String>,
)
```

**Purpose**: Adds hook-provided context text to the conversation as developer messages. This lets later model work see the extra information supplied by hooks.

**Data flow**: It receives a list of context strings. It converts them into response items with `additional_context_messages`; if the list is empty it does nothing. Otherwise it records those items in the session conversation.

**Call relations**: Several hook flows call this after hooks return extra context, including pre-tool and input-recording paths. It is also called by `HookRuntimeOutcome::record_additional_contexts`, which wraps the same behavior.

*Call graph*: calls 1 internal fn (additional_context_messages); called by 6 (record_additional_contexts, record_pending_input, run_pre_tool_use_hooks, run_hooks_and_record_inputs, on_task_finished, dispatch_any_with_terminal_outcome).


##### `additional_context_messages`  (lines 609–615)

```
fn additional_context_messages(additional_contexts: Vec<String>) -> Vec<ResponseItem>
```

**Purpose**: Turns raw hook context strings into conversation items that look like developer messages. Keeping each string separate preserves order and boundaries.

**Data flow**: It receives a vector of strings. For each string, it creates a `HookAdditionalContext`, converts that into a contextual user fragment, and finally into a response item. It returns the list of response items.

**Call relations**: `record_additional_contexts` uses this before writing hook context into the transcript. A test also calls it directly to confirm the messages stay separate and ordered.

*Call graph*: called by 2 (record_additional_contexts, additional_context_messages_stay_separate_and_ordered).


##### `emit_hook_started_events`  (lines 617–632)

```
async fn emit_hook_started_events(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    preview_runs: Vec<HookRunSummary>,
)
```

**Purpose**: Notifies the session that one or more hook runs have started. This lets clients show hook activity as it happens.

**Data flow**: It receives preview summaries for hook runs. For each summary, it wraps it in a `HookStarted` event with the current turn id and sends it through the session event channel.

**Call relations**: All modern hook runners call this before awaiting hook execution. It is the “starting bell” paired with `emit_hook_completed_events`, which sends the “finished” messages.

*Call graph*: called by 7 (run_context_injecting_hook, run_permission_request_hooks, run_post_compact_hooks, run_post_tool_use_hooks, run_pre_compact_hooks, run_pre_tool_use_hooks, run_turn_stop_hooks); 1 external calls (HookStarted).


##### `emit_hook_completed_events`  (lines 634–645)

```
async fn emit_hook_completed_events(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    completed_events: Vec<HookCompletedEvent>,
)
```

**Purpose**: Notifies the session that hook runs have finished, while also recording metrics and analytics for each run. This keeps users, operators, and product analytics in agreement about what happened.

**Data flow**: It receives completed hook events. For each one, it records telemetry metrics, sends an analytics fact, and emits a `HookCompleted` event to the session.

**Call relations**: Every modern hook runner calls this after hook execution. It calls `emit_hook_completed_metrics` and `track_hook_completed_analytics` before sending the visible completion event.

*Call graph*: calls 2 internal fn (emit_hook_completed_metrics, track_hook_completed_analytics); called by 7 (run_context_injecting_hook, run_permission_request_hooks, run_post_compact_hooks, run_post_tool_use_hooks, run_pre_compact_hooks, run_pre_tool_use_hooks, run_turn_stop_hooks); 1 external calls (HookCompleted).


##### `emit_hook_completed_metrics`  (lines 647–661)

```
fn emit_hook_completed_metrics(turn_context: &TurnContext, completed: &HookCompletedEvent)
```

**Purpose**: Records operational measurements for a completed hook run. These measurements help answer questions like how many hooks ran and how long they took.

**Data flow**: It receives the turn context and one completed hook event. It converts the hook run into metric tags, increments a hook-run counter, and if a duration is available records that duration.

**Call relations**: `emit_hook_completed_events` calls this for each completed hook. It uses `hook_run_metric_tags` to turn hook details into stable label strings for the telemetry system.

*Call graph*: calls 1 internal fn (hook_run_metric_tags); called by 1 (emit_hook_completed_events); 2 external calls (from_millis, try_from).


##### `track_hook_completed_analytics`  (lines 663–673)

```
fn track_hook_completed_analytics(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    completed: &HookCompletedEvent,
)
```

**Purpose**: Sends a product analytics record for a completed hook run. This is separate from low-level telemetry and focuses on the hook event, source, and final status.

**Data flow**: It receives the session, turn context, and completed event. It builds a tracking context and hook fact, then sends them to the session’s analytics client.

**Call relations**: `emit_hook_completed_events` calls this after metrics are recorded. It uses `hook_run_analytics_payload` to build the exact analytics data.

*Call graph*: calls 1 internal fn (hook_run_analytics_payload); called by 1 (emit_hook_completed_events).


##### `hook_run_analytics_payload`  (lines 675–695)

```
fn hook_run_analytics_payload(
    thread_id: String,
    turn_context: &TurnContext,
    completed: &HookCompletedEvent,
) -> (codex_analytics::TrackEventsContext, HookRunFact)
```

**Purpose**: Builds the analytics payload for a completed hook run. It chooses the right thread id, turn id, model name, hook event name, hook source, and hook status.

**Data flow**: It receives a thread id, turn context, and completed hook event. It prefers the turn id stored on the completed event, but falls back to the current turn context if the event has none. It returns a tracking context plus a hook-run fact.

**Call relations**: `track_hook_completed_analytics` uses this before sending analytics. Tests call it directly to verify both the explicit-turn-id and fallback-turn-id cases.

*Call graph*: called by 3 (hook_run_analytics_payload_falls_back_to_turn_context_id, hook_run_analytics_payload_uses_completed_turn_id, track_hook_completed_analytics); 1 external calls (build_track_events_context).


##### `hook_run_metric_tags`  (lines 697–736)

```
fn hook_run_metric_tags(run: &HookRunSummary) -> [(&'static str, &'static str); 3]
```

**Purpose**: Converts hook run details into simple text labels for metrics. Metrics systems usually need stable short strings rather than rich enum values.

**Data flow**: It receives a hook run summary. It maps the hook event name, hook source, and status into lowercase or display-friendly strings, then returns those three tag pairs.

**Call relations**: `emit_hook_completed_metrics` calls this for every completed hook. Tests check that the labels match the analytics shape and include all expanded hook sources.

*Call graph*: called by 1 (emit_hook_completed_metrics).


##### `hook_permission_mode`  (lines 738–747)

```
fn hook_permission_mode(turn_context: &TurnContext) -> String
```

**Purpose**: Translates the turn’s approval policy into the permission-mode string expected by hooks. This gives hooks a simple view of whether permissions are being bypassed.

**Data flow**: It reads the approval policy from the turn context. If approvals are set to never ask, it returns `bypassPermissions`; otherwise it returns `default`.

**Call relations**: Most hook request builders call this so hooks receive a consistent permission mode. It is used for session start, prompt submit, tool hooks, permission hooks, and stop hooks.

*Call graph*: called by 6 (inspect_pending_input, run_pending_session_start_hooks, run_permission_request_hooks, run_post_tool_use_hooks, run_pre_tool_use_hooks, run_turn_stop_hooks).


##### `thread_spawn_subagent_hook_context`  (lines 749–759)

```
fn thread_spawn_subagent_hook_context(
    sess: &Arc<Session>,
    turn_context: &TurnContext,
) -> Option<SubagentHookContext>
```

**Purpose**: Adds subagent identity information to hook requests, but only for subagents created by thread spawning. Other sessions do not get this extra field.

**Data flow**: It reads the session source from the turn context. If the turn belongs to a thread-spawned subagent, it builds and returns a `SubagentHookContext`; otherwise it returns `None`.

**Call relations**: Tool, prompt, permission, and compaction hook builders call this when filling in optional subagent data. It delegates the actual context construction to `subagent_hook_context`.

*Call graph*: calls 1 internal fn (subagent_hook_context); called by 6 (inspect_pending_input, run_permission_request_hooks, run_post_compact_hooks, run_post_tool_use_hooks, run_pre_compact_hooks, run_pre_tool_use_hooks).


##### `subagent_hook_context`  (lines 761–768)

```
fn subagent_hook_context(sess: &Arc<Session>, agent_role: &Option<String>) -> SubagentHookContext
```

**Purpose**: Builds the small identity record that hooks use to recognize a subagent. It includes an agent id and an agent type.

**Data flow**: It reads the session thread id and the optional agent role. The thread id becomes the agent id, and the role becomes the agent type; if no role is provided, it uses the default agent role name.

**Call relations**: `run_pending_session_start_hooks`, `run_turn_stop_hooks`, and `thread_spawn_subagent_hook_context` call this whenever they need hook-facing subagent identity information.

*Call graph*: called by 3 (run_pending_session_start_hooks, run_turn_stop_hooks, thread_spawn_subagent_hook_context).


##### `compaction_trigger_label`  (lines 770–775)

```
fn compaction_trigger_label(value: CompactionTrigger) -> &'static str
```

**Purpose**: Turns the compaction trigger into the short text label expected by hooks. This hides the internal enum behind a stable hook contract.

**Data flow**: It receives a compaction trigger value. It returns `manual` for user-requested compaction and `auto` for automatic compaction.

**Call relations**: Both pre-compaction and post-compaction hook runners call this while building their hook requests.

*Call graph*: called by 2 (run_post_compact_hooks, run_pre_compact_hooks).


##### `tests::additional_context_messages_stay_separate_and_ordered`  (lines 798–829)

```
fn additional_context_messages_stay_separate_and_ordered()
```

**Purpose**: Checks that multiple hook-added context strings become multiple developer messages in the same order. This protects against accidentally merging notes together.

**Data flow**: It creates two sample context strings, converts them with `additional_context_messages`, and inspects the resulting response items. It asserts that there are two developer messages with the original text in order.

**Call relations**: This test directly exercises the conversion helper used by `record_additional_contexts`, guarding the transcript behavior that hook users would notice.

*Call graph*: calls 1 internal fn (additional_context_messages); 2 external calls (assert_eq!, vec!).


##### `tests::hook_run_analytics_payload_uses_completed_turn_id`  (lines 832–848)

```
async fn hook_run_analytics_payload_uses_completed_turn_id()
```

**Purpose**: Checks that analytics use the turn id supplied by a completed hook event when it is present. This matters when the hook event carries a more precise turn id than the surrounding context.

**Data flow**: It creates a test session and a completed hook event with `turn-from-hook`. It builds the analytics payload and asserts that the payload uses that turn id, the expected thread id, model slug, event name, source, and status.

**Call relations**: This test calls `hook_run_analytics_payload`, which is normally used by `track_hook_completed_analytics` during hook completion reporting.

*Call graph*: calls 2 internal fn (hook_run_analytics_payload, make_session_and_context); 2 external calls (assert_eq!, sample_hook_run).


##### `tests::hook_run_analytics_payload_falls_back_to_turn_context_id`  (lines 851–864)

```
async fn hook_run_analytics_payload_falls_back_to_turn_context_id()
```

**Purpose**: Checks that analytics still get a turn id when the completed hook event does not include one. The fallback keeps analytics records complete.

**Data flow**: It creates a test session and a completed hook event with no turn id. It builds the analytics payload and asserts that the turn id comes from the current turn context while source and status still come from the hook run.

**Call relations**: This test covers the fallback path inside `hook_run_analytics_payload`, which is used when `track_hook_completed_analytics` records completed hook runs.

*Call graph*: calls 2 internal fn (hook_run_analytics_payload, make_session_and_context); 2 external calls (assert_eq!, sample_hook_run).


##### `tests::hook_run_metric_tags_match_analytics_shape`  (lines 867–890)

```
fn hook_run_metric_tags_match_analytics_shape()
```

**Purpose**: Checks that metric labels for hook name, source, and status use the expected strings. This helps keep telemetry labels consistent with analytics concepts.

**Data flow**: It builds sample hook runs with different sources and compares the output of `hook_run_metric_tags` to the expected tag arrays.

**Call relations**: This test protects the helper used by `emit_hook_completed_metrics`, so completed hook metrics remain easy to group and query.

*Call graph*: 2 external calls (assert_eq!, sample_hook_run).


##### `tests::hook_run_metric_tags_include_expanded_hook_sources`  (lines 893–904)

```
fn hook_run_metric_tags_include_expanded_hook_sources()
```

**Purpose**: Checks that newer or more specific hook sources are represented in metric tags. This prevents those sources from being collapsed or mislabeled.

**Data flow**: It builds a sample hook run with a legacy managed-config MDM source and asserts that `hook_run_metric_tags` returns the exact expected source label.

**Call relations**: This test focuses on the source-mapping part of `hook_run_metric_tags`, which is used whenever hook completion metrics are recorded.

*Call graph*: 2 external calls (assert_eq!, sample_hook_run).


##### `tests::sample_hook_run`  (lines 906–923)

```
fn sample_hook_run(status: HookRunStatus, source: HookSource) -> HookRunSummary
```

**Purpose**: Creates a reusable fake hook run summary for tests. It keeps the test cases focused on the fields they care about: status and source.

**Data flow**: It receives a hook status and hook source, fills in the rest of the hook-run fields with fixed sample values, and returns a `HookRunSummary`.

**Call relations**: The metric and analytics tests call this helper to build realistic completed hook data without repeating the same setup in each test.

*Call graph*: 2 external calls (new, test_path_buf).


### `hooks/src/legacy_notify.rs`

`io_transport` · `after-agent hook notification`

When the agent finishes responding, some older tools expect to be told by running a command and passing one final JSON argument to it. This file builds that old-style message and defines a hook named `legacy_notify` that launches the configured command.

The main idea is simple: take the modern hook payload, translate it into the older notification format, turn that into JSON, and append it to the command-line arguments. The JSON says that an agent turn completed, and includes the thread id, turn id, current working directory, optional client name, the user input messages, and the last assistant message if there is one.

The file also deliberately silences the launched command’s standard input, output, and error streams. In plain terms, the notification command is started in the background and is not allowed to read from or write to the main program’s terminal. If the command cannot be started, the hook reports a failure but allows the main program to continue.

The tests protect the exact old JSON shape, including names like `thread-id` and `agent-turn-complete`. That matters because outside scripts may depend on those exact names.

#### Function details

##### `legacy_notify_json`  (lines 28–41)

```
fn legacy_notify_json(payload: &HookPayload) -> Result<String, serde_json::Error>
```

**Purpose**: Builds the backward-compatible JSON string that older notification commands expect. It translates the current hook payload into the older `agent-turn-complete` message format.

**Data flow**: It receives a `HookPayload`, reads the completed-agent event inside it, and copies out the thread id, turn id, working directory, client name, input messages, and last assistant message. It then serializes that information into a JSON string. The result is either that JSON text or a JSON serialization error if something goes wrong.

**Call relations**: This is the translator used when the legacy notification needs its final command-line argument. The test `tests::legacy_notify_json_matches_historical_wire_shape` calls it to make sure the produced JSON still matches the historical format.

*Call graph*: called by 1 (legacy_notify_json_matches_historical_wire_shape); 1 external calls (to_string).


##### `notify_hook`  (lines 43–70)

```
fn notify_hook(argv: Vec<String>) -> Hook
```

**Purpose**: Creates the actual `legacy_notify` hook that can run an external notification command. Someone uses this when they want the program to notify an older integration after the agent finishes a turn.

**Data flow**: It receives the command arguments as a list of strings and stores them safely so the hook can use them later. When the hook runs, it turns those strings into a command, adds the legacy JSON payload as the last argument if serialization succeeds, disconnects the command from standard input/output/error, and tries to start it. It returns success if there is no command or if the command starts, and returns a non-stopping failure if the command cannot be launched.

**Call relations**: This function packages the notification behavior into a `Hook` object for the wider hook system. When that hook is triggered with a payload, it prepares the external command and relies on the legacy JSON-building logic before spawning the process.

*Call graph*: 1 external calls (new).


##### `tests::expected_notification_json`  (lines 85–96)

```
fn expected_notification_json() -> Value
```

**Purpose**: Creates the reference JSON value that the tests expect. It is the saved example of the old notification format that must not accidentally change.

**Data flow**: It builds a test working directory path and combines it with fixed example ids, messages, and client information. The output is a JSON value used as the comparison target in tests.

**Call relations**: The test functions call this helper so they compare against the same expected legacy message shape. It keeps the test expectation in one place instead of repeating the full JSON object.

*Call graph*: 2 external calls (test_path_buf, json!).


##### `tests::test_user_notification`  (lines 99–116)

```
fn test_user_notification() -> Result<()>
```

**Purpose**: Checks that the internal `UserNotification` value serializes into the exact JSON shape older users expect. This protects field names, the event type name, and optional fields.

**Data flow**: It creates a sample `AgentTurnComplete` notification, serializes it to JSON text, parses that text back into a generic JSON value, and compares it with the shared expected JSON. The test passes only if the serialized form matches exactly.

**Call relations**: This test focuses on the notification data type itself. It uses `tests::expected_notification_json` as the known-good shape and catches accidental changes to the serialization rules.

*Call graph*: 5 external calls (assert_eq!, test_path_buf, from_str, to_string, vec!).


##### `tests::legacy_notify_json_matches_historical_wire_shape`  (lines 119–145)

```
fn legacy_notify_json_matches_historical_wire_shape() -> Result<()>
```

**Purpose**: Checks that `legacy_notify_json` produces the same old JSON format when given a real hook payload. This protects the full translation from modern hook data to legacy notification data.

**Data flow**: It builds a realistic `HookPayload` for an after-agent event, including ids, current directory, client name, input text, and assistant text. It passes that payload into `legacy_notify_json`, parses the returned JSON string, and compares it with the expected JSON value. The test changes nothing outside itself.

**Call relations**: This test exercises the public conversion function rather than only the lower-level notification enum. It confirms that the hook payload fields are copied into the legacy wire format correctly.

*Call graph*: calls 3 internal fn (legacy_notify_json, from_string, new); 5 external calls (assert_eq!, now, test_path_buf, from_str, vec!).


### Engine foundation
These files discover configured hooks, assemble the engine, execute commands, parse outputs, and manage oversized output handling.

### `hooks/src/engine/mod.rs`

`orchestration` · `startup and hook event handling`

Hooks are outside commands that Codex can run at certain moments, such as before a tool is used, after a prompt is submitted, or when a session stops. This file acts like the switchboard for those hooks. Without it, the rest of the program would have to know where hooks come from, how to find the right ones for each event, how to run them, and how to clean up large hook output.

At startup, `ClaudeHooksEngine::new` either creates an empty engine if hooks are disabled, or asks the discovery code to find hook definitions from configuration and plugins. It stores the resulting handlers, any warnings found while loading them, the shell command used to execute hooks, and an output spiller. The spiller is a safety valve: if hook output is too large to keep inline, it can move that text elsewhere and replace it with a smaller reference.

After startup, callers use this engine in two main ways. Preview methods answer “which hooks would run?” without actually running commands. Run methods execute the matching hooks for a specific event and return the event-specific outcome. Most of the detailed event behavior lives in the event modules; this file keeps the public shape consistent and adds shared cleanup, especially output spilling.

#### Function details

##### `ConfiguredHandler::run_id`  (lines 55–62)

```
fn run_id(&self) -> String
```

**Purpose**: Builds a stable, human-readable identifier for one configured hook run. This is useful when showing summaries for hooks that are running or have completed.

**Data flow**: It reads the handler’s event name, display order, and source file path. It turns the event name into a short label, joins those pieces into one string, and returns that string as the hook run identifier.

**Call relations**: Summary-building code calls this when it needs a compact name for a hook. It relies on `ConfiguredHandler::event_name_label` to make the event name readable before handing the final identifier back to the summary.

*Call graph*: called by 2 (completed_summary, running_summary); 1 external calls (format!).


##### `ConfiguredHandler::event_name_label`  (lines 64–77)

```
fn event_name_label(&self) -> &'static str
```

**Purpose**: Turns the internal event name value into the short text label used in hook identifiers. It keeps labels consistent across all hook summaries.

**Data flow**: It reads the handler’s event name. It matches that value to a fixed lowercase label such as `pre-tool-use` or `session-start`, then returns that label.

**Call relations**: It is used inside `ConfiguredHandler::run_id` as a helper. The rest of the system benefits indirectly because summaries get clear, predictable event names.


##### `ClaudeHooksEngine::new`  (lines 108–138)

```
fn new(
        enabled: bool,
        bypass_hook_trust: bool,
        config_layer_stack: Option<&ConfigLayerStack>,
        plugin_hook_sources: Vec<PluginHookSource>,
        plugin_hook_load_warn
```

**Purpose**: Creates the hook engine used by the rest of the program. It either starts with no hooks when hooks are disabled, or discovers configured hooks from configuration layers and plugins.

**Data flow**: It receives settings such as whether hooks are enabled, whether trust checks should be bypassed, configuration layers, plugin-provided hooks, plugin loading warnings, and the shell used to run commands. If hooks are disabled, it returns an engine with no handlers. If hooks are enabled, it loads generated schemas, discovers hook handlers and warnings, creates an output spiller, and returns a ready-to-use engine.

**Call relations**: Startup and tests call this to build the engine before any hook event can be previewed or run. It hands discovery work to `discover_handlers`, initializes schema support through `generated_hook_schemas`, and creates the shared `HookOutputSpiller` used later by run methods.

*Call graph*: calls 3 internal fn (discover_handlers, generated_hook_schemas, new); called by 18 (allow_managed_hooks_only_false_keeps_unmanaged_hooks, allow_managed_hooks_only_in_config_toml_does_not_enable_policy, allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks, allow_managed_hooks_only_skips_unmanaged_plugin_hooks, discovers_hooks_from_json_and_toml_in_the_same_layer, malformed_hooks_json_is_reported_as_startup_warning, plugin_hook_load_warnings_are_startup_warnings, plugin_hook_sources_expand_plugin_placeholders, plugin_hook_sources_run_with_plugin_env_and_plugin_source (+8 more)); 1 external calls (new).


##### `ClaudeHooksEngine::warnings`  (lines 140–142)

```
fn warnings(&self) -> &[String]
```

**Purpose**: Returns startup warnings found while loading hook configuration. Callers use this to show users problems that did not fully stop the program.

**Data flow**: It reads the engine’s stored warning list and returns it as a borrowed list. Nothing is changed.

**Call relations**: Startup warning reporting calls this after the engine has been created. The warnings originally come from hook discovery done in `ClaudeHooksEngine::new`.

*Call graph*: called by 1 (startup_warnings).


##### `ClaudeHooksEngine::preview_session_start`  (lines 144–149)

```
fn preview_session_start(
        &self,
        request: &SessionStartRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Shows which session-start hooks would run for a given session-start request, without actually running any external commands.

**Data flow**: It receives a session-start request and reads the engine’s configured handlers. It asks the session-start event module to match the request against those handlers and returns run summaries.

**Call relations**: Higher-level preview code calls this when it wants a dry run for session-start hooks. This method delegates the event-specific matching to the session-start module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_session_start).


##### `ClaudeHooksEngine::preview_pre_tool_use`  (lines 151–153)

```
fn preview_pre_tool_use(&self, request: &PreToolUseRequest) -> Vec<HookRunSummary>
```

**Purpose**: Shows which hooks would run before a tool is used. It lets the caller inspect the planned hook activity without executing commands.

**Data flow**: It receives a pre-tool-use request and the engine’s handler list. It passes both to the pre-tool-use event module, which returns summaries of matching hooks.

**Call relations**: Preview callers use this before tool execution. The method is a thin bridge from the engine to the pre-tool-use event logic.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_pre_tool_use).


##### `ClaudeHooksEngine::preview_permission_request`  (lines 155–160)

```
fn preview_permission_request(
        &self,
        request: &PermissionRequestRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Shows which permission-request hooks would run for a permission decision. This is a dry run only.

**Data flow**: It receives a permission-request request, reads the configured handlers, and asks the permission-request event module to produce hook run summaries.

**Call relations**: Higher-level preview code calls this when permission-related hook behavior needs to be displayed. The permission-request event module does the actual matching.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_permission_request).


##### `ClaudeHooksEngine::preview_post_tool_use`  (lines 162–167)

```
fn preview_post_tool_use(
        &self,
        request: &PostToolUseRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Shows which hooks would run after a tool has been used. It does not execute the hook commands.

**Data flow**: It receives a post-tool-use request and passes it, along with the configured handlers, to the post-tool-use event module. The result is a list of summaries for hooks that would match.

**Call relations**: Preview callers use this after a tool-use scenario is known. This method keeps the engine API consistent while the post-tool-use module handles the details.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_post_tool_use).


##### `ClaudeHooksEngine::run_session_start`  (lines 169–181)

```
async fn run_session_start(
        &self,
        request: SessionStartRequest,
        turn_id: Option<String>,
    ) -> SessionStartOutcome
```

**Purpose**: Runs the hooks that should fire when a session starts. It also checks any extra context returned by hooks and spills overly large text if needed.

**Data flow**: It receives a session-start request and an optional turn identifier. It saves the session ID, passes the request to the session-start event runner with the shell and handlers, then post-processes the returned additional context through the output spiller. It returns the updated session-start outcome.

**Call relations**: The session-start event path calls this to actually execute hooks. It delegates hook execution to the session-start module, then calls `ClaudeHooksEngine::maybe_spill_texts` so large hook-provided context does not overload later processing.

*Call graph*: calls 2 internal fn (maybe_spill_texts, run); called by 1 (run_session_start).


##### `ClaudeHooksEngine::run_pre_tool_use`  (lines 183–191)

```
async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome
```

**Purpose**: Runs hooks before a tool is used. These hooks can influence or add context to the tool-use flow.

**Data flow**: It receives a pre-tool-use request and keeps the session ID. It asks the pre-tool-use event module to run matching hooks using the configured shell, then sends any returned additional context through output spilling. It returns the adjusted outcome.

**Call relations**: The tool-use flow calls this just before using a tool. The event module runs the actual hook commands, and `ClaudeHooksEngine::maybe_spill_texts` cleans up large returned text.

*Call graph*: calls 2 internal fn (maybe_spill_texts, run); called by 1 (run_pre_tool_use).


##### `ClaudeHooksEngine::run_permission_request`  (lines 193–198)

```
async fn run_permission_request(
        &self,
        request: PermissionRequestRequest,
    ) -> PermissionRequestOutcome
```

**Purpose**: Runs hooks that participate in a permission request. These hooks can help decide or report on whether an action should be allowed.

**Data flow**: It receives a permission-request request. It passes the request, handler list, and shell to the permission-request event module, then returns that module’s outcome directly.

**Call relations**: The permission flow calls this when a permission decision needs hook input. Unlike some other run methods, it does not do output spilling here because this outcome does not contain the same large context fields.

*Call graph*: calls 1 internal fn (run); called by 1 (run_permission_request).


##### `ClaudeHooksEngine::run_post_tool_use`  (lines 200–214)

```
async fn run_post_tool_use(
        &self,
        request: PostToolUseRequest,
    ) -> PostToolUseOutcome
```

**Purpose**: Runs hooks after a tool has completed. It also makes sure large feedback or context returned by hooks is safely spilled if needed.

**Data flow**: It receives a post-tool-use request and saves the session ID. It runs matching hooks through the post-tool-use event module, then processes returned additional context and optional feedback text through the output spiller. It returns the updated post-tool-use outcome.

**Call relations**: The tool-use flow calls this after tool execution. The post-tool-use module handles command execution, while this method adds shared output cleanup through `ClaudeHooksEngine::maybe_spill_texts` and `ClaudeHooksEngine::maybe_spill_text`.

*Call graph*: calls 3 internal fn (maybe_spill_text, maybe_spill_texts, run); called by 1 (run_post_tool_use).


##### `ClaudeHooksEngine::preview_pre_compact`  (lines 216–218)

```
fn preview_pre_compact(&self, request: &PreCompactRequest) -> Vec<HookRunSummary>
```

**Purpose**: Shows which hooks would run before a compacting step. Compacting means reducing or summarizing conversation context so it fits better.

**Data flow**: It receives a pre-compact request and reads the configured handlers. It asks the compact event module for summaries of matching pre-compact hooks and returns them.

**Call relations**: Preview code for compacting calls this before any real pre-compact hooks are run. The compact module owns the matching rules.

*Call graph*: calls 1 internal fn (preview_pre); called by 1 (preview_pre_compact).


##### `ClaudeHooksEngine::run_pre_compact`  (lines 220–222)

```
async fn run_pre_compact(&self, request: PreCompactRequest) -> PreCompactOutcome
```

**Purpose**: Runs hooks before compacting happens. These hooks can participate in or affect the pre-compaction step.

**Data flow**: It receives a pre-compact request, passes it with the handler list and shell to the compact event module, and returns the pre-compact outcome from that module.

**Call relations**: The compaction flow calls this before compacting context. This engine method delegates the actual hook execution to the compact module’s pre-compact runner.

*Call graph*: calls 1 internal fn (run_pre); called by 1 (run_pre_compact).


##### `ClaudeHooksEngine::preview_post_compact`  (lines 224–226)

```
fn preview_post_compact(&self, request: &PostCompactRequest) -> Vec<HookRunSummary>
```

**Purpose**: Shows which hooks would run after compacting finishes. It is a dry run and does not execute commands.

**Data flow**: It receives a post-compact request and the engine’s handler list. It asks the compact event module to identify matching post-compact hooks and returns their summaries.

**Call relations**: Compaction preview code calls this after a hypothetical compacting step. The compact module performs the event-specific matching.

*Call graph*: calls 1 internal fn (preview_post); called by 1 (preview_post_compact).


##### `ClaudeHooksEngine::run_post_compact`  (lines 228–233)

```
async fn run_post_compact(
        &self,
        request: PostCompactRequest,
    ) -> StatelessHookOutcome
```

**Purpose**: Runs hooks after compacting has completed. These are stateless hooks, meaning the returned outcome is simple and not tied to extra stored context in this method.

**Data flow**: It receives a post-compact request, sends it with the handlers and shell to the compact event module, and returns the resulting stateless hook outcome.

**Call relations**: The compaction flow calls this after context has been compacted. The compact module runs the commands and produces the outcome.

*Call graph*: calls 1 internal fn (run_post); called by 1 (run_post_compact).


##### `ClaudeHooksEngine::preview_user_prompt_submit`  (lines 235–240)

```
fn preview_user_prompt_submit(
        &self,
        request: &UserPromptSubmitRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Shows which hooks would run when a user submits a prompt. It lets the program preview hook behavior without running external commands.

**Data flow**: It receives a user-prompt-submit request and reads the engine’s handler list. It passes both to the user-prompt-submit event module and returns hook run summaries.

**Call relations**: Prompt-submission preview code calls this before actual hook execution. The user-prompt-submit module decides which handlers match.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_user_prompt_submit).


##### `ClaudeHooksEngine::run_user_prompt_submit`  (lines 242–253)

```
async fn run_user_prompt_submit(
        &self,
        request: UserPromptSubmitRequest,
    ) -> UserPromptSubmitOutcome
```

**Purpose**: Runs hooks when the user submits a prompt. It also protects the system from overly large extra context returned by those hooks.

**Data flow**: It receives a user-prompt-submit request and saves its session ID. It runs matching hooks through the user-prompt-submit event module, then sends returned additional context through the output spiller. It returns the updated outcome.

**Call relations**: The prompt-submission flow calls this when a real user prompt arrives. The event module runs the hook commands, and `ClaudeHooksEngine::maybe_spill_texts` performs shared large-output cleanup.

*Call graph*: calls 2 internal fn (maybe_spill_texts, run); called by 1 (run_user_prompt_submit).


##### `ClaudeHooksEngine::preview_stop`  (lines 255–257)

```
fn preview_stop(&self, request: &StopRequest) -> Vec<HookRunSummary>
```

**Purpose**: Shows which hooks would run when a session or process stop event occurs. It does not run those hooks.

**Data flow**: It receives a stop request and the configured handlers. It asks the stop event module to produce summaries for matching hooks and returns those summaries.

**Call relations**: Stop preview code calls this before an actual stop hook run. The stop module handles the matching details.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_stop).


##### `ClaudeHooksEngine::run_stop`  (lines 259–266)

```
async fn run_stop(&self, request: StopRequest) -> StopOutcome
```

**Purpose**: Runs hooks for a stop event. It also checks continuation prompt fragments returned by hooks and spills large content when needed.

**Data flow**: It receives a stop request and saves the session ID. It runs matching hooks through the stop event module, then sends any returned continuation fragments through the output spiller. It returns the updated stop outcome.

**Call relations**: The stop flow calls this when stop hooks need to execute. The stop module runs the hook commands, and `ClaudeHooksEngine::maybe_spill_prompt_fragments` applies the shared large-output safety step.

*Call graph*: calls 2 internal fn (maybe_spill_prompt_fragments, run); called by 1 (run_stop).


##### `ClaudeHooksEngine::maybe_spill_texts`  (lines 268–272)

```
async fn maybe_spill_texts(&self, session_id: ThreadId, texts: Vec<String>) -> Vec<String>
```

**Purpose**: Passes a list of hook-produced text blocks through the output spiller. This prevents very large hook text from being carried around inline when it should be stored separately.

**Data flow**: It receives a session ID and a list of strings. It gives both to the shared output spiller, waits for the spiller to decide what to keep or replace, and returns the resulting list of strings.

**Call relations**: Several run methods call this after event-specific hook execution returns additional context. It centralizes the large-output cleanup so each event runner does not need to repeat that logic.

*Call graph*: calls 1 internal fn (maybe_spill_texts); called by 4 (run_post_tool_use, run_pre_tool_use, run_session_start, run_user_prompt_submit).


##### `ClaudeHooksEngine::maybe_spill_text`  (lines 274–279)

```
async fn maybe_spill_text(&self, session_id: ThreadId, text: Option<String>) -> Option<String>
```

**Purpose**: Applies output spilling to one optional text value. It leaves missing text alone and only processes real text.

**Data flow**: It receives a session ID and either some text or no text. If there is text, it sends it to the output spiller and wraps the result back as present text. If there is no text, it returns no text.

**Call relations**: `ClaudeHooksEngine::run_post_tool_use` calls this for optional feedback returned by post-tool-use hooks. It is the single-text version of the shared output spilling step.

*Call graph*: calls 1 internal fn (maybe_spill_text); called by 1 (run_post_tool_use).


##### `ClaudeHooksEngine::maybe_spill_prompt_fragments`  (lines 281–289)

```
async fn maybe_spill_prompt_fragments(
        &self,
        session_id: ThreadId,
        fragments: Vec<codex_protocol::items::HookPromptFragment>,
    ) -> Vec<codex_protocol::items::HookPromptFra
```

**Purpose**: Applies output spilling to hook-produced prompt fragments. A prompt fragment is a piece of text or prompt content that may be used later as continuation input.

**Data flow**: It receives a session ID and a list of hook prompt fragments. It passes them to the output spiller, which may replace large content with safer references, and returns the updated fragments.

**Call relations**: `ClaudeHooksEngine::run_stop` calls this after stop hooks return continuation fragments. It lets the stop flow reuse the same large-output protection used elsewhere in the engine.

*Call graph*: calls 1 internal fn (maybe_spill_prompt_fragments); called by 1 (run_stop).


### `hooks/src/engine/discovery.rs`

`orchestration` · `config load / hook discovery`

Hooks are user- or admin-defined commands that run at certain moments, such as before a tool is used. This file solves the problem of collecting those hook definitions from several places without accidentally running something unsafe or unsupported. Without it, the engine would not know which hooks exist, where they came from, whether users disabled them, or whether they should be trusted enough to run.

The main flow starts in `discover_handlers`. It gathers saved hook state, builds a discovery policy, then looks through managed requirements, configuration layers, and plugin-provided hooks. For each source, it loads hook definitions from either `hooks.json` or the `hooks` section of `config.toml`, records warnings for bad files, and avoids reading the same JSON hook folder twice.

The file then normalizes each hook into two outputs. One output is a visible `HookListEntry`, used to show the user what hooks exist and their trust status. The other is a `ConfiguredHandler`, which is only created when the hook is enabled and trusted, or when trust checks are explicitly bypassed. This is like a building lobby: everyone is logged at reception, but only people with permission get past the security door.

It also marks where each hook came from, handles managed hooks differently from user hooks, chooses Windows-specific commands when needed, fills plugin environment placeholders, and skips unsupported hook types with clear warnings.

#### Function details

##### `HookDiscoveryPolicy::allows`  (lines 58–60)

```
fn allows(self, source: &HookHandlerSource<'_>) -> bool
```

**Purpose**: Decides whether a hook source is allowed under the current discovery rules. Its main rule is whether the system is restricted to managed hooks only.

**Data flow**: It receives a policy and a hook source description. If managed-only mode is off, it lets the source through; if managed-only mode is on, it only lets the source through when the source is marked as managed. It returns a simple yes-or-no result.

**Call relations**: This is called by `append_hook_events` before any hook definitions from a source are expanded. It acts as an early gate so disallowed sources never become hook entries or runnable handlers.

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

**Purpose**: Collects hooks from all known places and returns the final discovery result: runnable handlers, listable hook entries, and warnings. This is the main entry point for hook discovery.

**Data flow**: It takes an optional config layer stack, plugin hook sources, existing plugin warnings, and a flag that can bypass trust checks. It reads hook state, builds a policy, loads managed hooks, config-file hooks, JSON hooks, TOML hooks, and plugin hooks, then returns a `DiscoveryResult` containing what can run, what can be displayed, and anything suspicious or invalid that was found.

**Call relations**: Higher-level setup code calls this when it needs the hook engine configured. Inside, it delegates source-specific work to `append_managed_requirement_handlers`, `load_hooks_json`, `load_toml_hooks_from_layer`, `append_hook_events`, and `append_plugin_hook_sources`.

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

**Purpose**: Adds hooks that come from managed requirements, which are rules supplied by an administrator or central policy. Managed hooks are treated as trusted policy-controlled hooks.

**Data flow**: It receives the growing handler list, hook entry list, warning list, display order, config stack, saved hook state, and policy. If there are managed hooks in the requirements, it finds their source path and source type, then passes their hook definitions into the normal hook-expansion path.

**Call relations**: `discover_handlers` calls this before ordinary config layers are processed. It hands the actual hook parsing and entry creation to `append_hook_events` after labeling the source as managed.

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

**Purpose**: Adds hooks supplied by plugins and prepares plugin-specific environment values for those hooks. This lets plugin hook commands refer to their plugin folders without hard-coding paths.

**Data flow**: It receives plugin hook source records and the shared discovery output lists. For each plugin, it builds environment variables such as `PLUGIN_ROOT` and `PLUGIN_DATA`, labels the source as a plugin, and sends the plugin’s hook definitions onward. The shared handler and entry lists may grow, and warnings may be added.

**Call relations**: `discover_handlers` calls this after config-based hooks are processed. It delegates each plugin’s hook definitions to `append_hook_events`, which applies policy, trust, and normalization.

*Call graph*: calls 2 internal fn (plugin_hook_key_source, append_hook_events); called by 1 (discover_handlers); 1 external calls (new).


##### `managed_hooks_source_path`  (lines 261–273)

```
fn managed_hooks_source_path(
    managed_hooks: &ManagedHooksRequirementsToml,
    requirement_source: Option<&RequirementSource>,
) -> AbsolutePathBuf
```

**Purpose**: Chooses the best path to show for managed hooks. It prefers the real managed hook directory for the current platform, but falls back to a useful policy source path when needed.

**Data flow**: It receives managed hook requirements and an optional description of where those requirements came from. If the managed directory is absolute and can be normalized, it returns that path. Otherwise it returns a fallback path based on the requirement source.

**Call relations**: `append_managed_requirement_handlers` uses this so managed hook entries have a meaningful source location. If no real directory is suitable, it relies on `fallback_managed_hooks_source_path`.

*Call graph*: calls 3 internal fn (managed_dir_for_current_platform, fallback_managed_hooks_source_path, from_absolute_path); called by 1 (append_managed_requirement_handlers).


##### `fallback_managed_hooks_source_path`  (lines 275–301)

```
fn fallback_managed_hooks_source_path(
    requirement_source: Option<&RequirementSource>,
) -> AbsolutePathBuf
```

**Purpose**: Creates a reasonable display path for managed hooks when there is no direct hook directory to use. Some managed sources are not normal files, so this builds synthetic paths for them.

**Data flow**: It receives an optional requirement source. File-backed sources return their file path; policy sources such as MDM or enterprise-managed settings become artificial but readable paths. Enterprise names and IDs are escaped before being placed into the path.

**Call relations**: `managed_hooks_source_path` calls this when it cannot use a platform-specific managed hook directory. It uses `synthetic_layer_path` to create absolute paths and `escape_xml_text` to keep enterprise display values safe.

*Call graph*: calls 2 internal fn (escape_xml_text, synthetic_layer_path); called by 1 (managed_hooks_source_path); 1 external calls (format!).


##### `load_hooks_json`  (lines 303–344)

```
fn load_hooks_json(
    config_folder: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Option<(AbsolutePathBuf, HookEventsToml)>
```

**Purpose**: Reads hook definitions from a `hooks.json` file inside a config folder. It turns file read or parse failures into warnings instead of crashing discovery.

**Data flow**: It receives an optional folder path and the warning list. If the folder or file is missing, it returns nothing. If the file exists, it reads text, parses JSON into hook data, normalizes the path, and returns the source path plus hooks only when hooks are present.

**Call relations**: `discover_handlers` calls this for config layers that may have a JSON hook file. When it succeeds, the returned hook events are later passed to `append_hook_events`.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (discover_handlers); 3 external calls (format!, read_to_string, from_str).


##### `load_toml_hooks_from_layer`  (lines 346–364)

```
fn load_toml_hooks_from_layer(
    layer: &ConfigLayerEntry,
    warnings: &mut Vec<String>,
) -> Option<(AbsolutePathBuf, HookEventsToml)>
```

**Purpose**: Extracts hook definitions from the `hooks` section of a config layer’s TOML data. TOML is the project’s main configuration format.

**Data flow**: It receives one config layer and the warning list. It finds the layer’s source path, looks for a `hooks` value, tries to deserialize it into hook events, and returns those events only if they are not empty. Parse errors become warnings.

**Call relations**: `discover_handlers` calls this while walking config layers. It uses `config_toml_source_path` for attribution, then sends successful hook events into the same path as JSON hooks.

*Call graph*: calls 1 internal fn (config_toml_source_path); called by 1 (discover_handlers); 2 external calls (deserialize, format!).


##### `config_toml_source_path`  (lines 366–386)

```
fn config_toml_source_path(layer: &ConfigLayerEntry) -> AbsolutePathBuf
```

**Purpose**: Finds or constructs the path that should be shown for a config layer’s `config.toml`. This keeps hook warnings and list entries tied back to where the hook came from.

**Data flow**: It receives a config layer entry. For file-backed layers, it returns the real file path. For project layers, it builds the path under the project’s `.codex` folder or hook config folder. For virtual sources such as MDM, enterprise policy, or session flags, it returns a synthetic absolute path.

**Call relations**: `discover_handlers` and `load_toml_hooks_from_layer` call this whenever they need to label TOML-based hooks. It uses `synthetic_layer_path` for sources that do not live in a normal file.

*Call graph*: calls 2 internal fn (hooks_config_folder, synthetic_layer_path); called by 2 (discover_handlers, load_toml_hooks_from_layer); 1 external calls (format!).


##### `synthetic_layer_path`  (lines 388–398)

```
fn synthetic_layer_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Turns a made-up display path into an absolute path object. This is used for configuration sources that are real but not stored as normal files.

**Data flow**: It receives a string such as `<mdm:domain:key>/config.toml`. It resolves that string against a platform-appropriate root, like `/` on Unix-like systems or `C:\` on Windows, and returns an absolute path buffer.

**Call relations**: `config_toml_source_path` and `fallback_managed_hooks_source_path` call this when they need a path-shaped label for virtual policy sources.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 2 (config_toml_source_path, fallback_managed_hooks_source_path).


##### `escape_xml_text`  (lines 400–413)

```
fn escape_xml_text(value: &str) -> String
```

**Purpose**: Escapes special characters in text before inserting it into synthetic enterprise-managed paths. This prevents names containing characters like `<` or `&` from making the path confusing or unsafe to display.

**Data flow**: It receives a text value and walks through each character. Special XML-like characters are replaced with safe written-out forms such as `&lt;` and `&amp;`; all other characters are copied. It returns the escaped string.

**Call relations**: `fallback_managed_hooks_source_path` uses this for enterprise-managed policy names and IDs before building synthetic paths.

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

**Purpose**: Applies the discovery policy to one source of hook events and, if allowed, expands those events into concrete hook entries and runnable handlers.

**Data flow**: It receives the shared output lists, source information, hook event definitions, and policy. If the source is not allowed, it returns without changing anything. Otherwise it breaks the hook events into event names and matcher groups, then passes each group onward.

**Call relations**: This is the common doorway used by managed requirements, config layers, and plugins. It calls `HookDiscoveryPolicy::allows` first, then delegates detailed per-hook processing to `append_matcher_groups`.

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

**Purpose**: Turns grouped hook definitions into display entries and, when safe, runnable command handlers. This is where most validation, trust checking, enabling, and command normalization happens.

**Data flow**: It receives matcher groups for one event and source. For each group, it chooses the matcher pattern, validates it when needed, then walks each hook handler. Command hooks get platform-specific command selection, timeout defaults, a stable trust hash, plugin environment substitution, enabled/trusted checks, and a display entry. If the hook is enabled and trusted, it also becomes a runnable handler. Unsupported or invalid hooks add warnings and are skipped.

**Call relations**: `append_hook_events` calls this after splitting hook data by event. It uses helper functions such as `command_hook_hash`, `hook_enabled`, `hook_trusted_hash`, and `hook_trust_status` to decide what should merely be listed versus what may run.

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

**Purpose**: Creates a stable identity hash for a command hook so the system can tell whether the hook is the same one the user previously trusted. Equivalent hooks from JSON and TOML should produce the same trust identity.

**Data flow**: It receives the event name, matcher, original matcher group, and normalized handler. It rebuilds a small normalized hook identity, converts it to TOML-shaped data, and produces a version string from that data. The returned string is used as the hook’s current hash.

**Call relations**: `append_matcher_groups` calls this before checking trust. The hash it returns is compared with saved trusted hashes by `hook_trust_status`.

*Call graph*: called by 1 (append_matcher_groups); 6 external calls (try_from, version_for_toml, clone, hook_event_key_label, unreachable!, vec!).


##### `hook_trust_status`  (lines 589–603)

```
fn hook_trust_status(
    is_managed: bool,
    current_hash: &str,
    trusted_hash: Option<&str>,
) -> HookTrustStatus
```

**Purpose**: Classifies whether a hook is managed, trusted, modified, or untrusted. This protects users from silently running changed or never-approved commands.

**Data flow**: It receives whether the hook is managed, the hook’s current hash, and an optional saved trusted hash. Managed hooks immediately become `Managed`. Unmanaged hooks are `Trusted` if the hashes match, `Modified` if a saved hash exists but differs, or `Untrusted` if no trusted hash exists.

**Call relations**: `append_matcher_groups` calls this while deciding whether to create a runnable `ConfiguredHandler` and while filling the visible `HookListEntry`.

*Call graph*: called by 1 (append_matcher_groups).


##### `hook_enabled`  (lines 605–607)

```
fn hook_enabled(is_managed: bool, state: Option<&HookStateToml>) -> bool
```

**Purpose**: Decides whether a hook is enabled. Managed hooks are always enabled, while unmanaged hooks can be disabled by saved user state.

**Data flow**: It receives whether the hook is managed and an optional saved hook state. If managed, it returns true. Otherwise it returns false only when the saved state explicitly says `enabled = false`; missing state or missing value means enabled.

**Call relations**: `append_matcher_groups` uses this before allowing a hook to run and before recording the enabled flag in the hook list.

*Call graph*: called by 1 (append_matcher_groups).


##### `hook_trusted_hash`  (lines 609–613)

```
fn hook_trusted_hash(is_managed: bool, state: Option<&HookStateToml>) -> Option<&str>
```

**Purpose**: Fetches the saved trusted hash for an unmanaged hook. Managed hooks do not need this because policy itself is treated as trusted.

**Data flow**: It receives whether the hook is managed and optional saved state. For managed hooks it returns nothing. For unmanaged hooks it returns the saved trusted hash if one exists.

**Call relations**: `append_matcher_groups` calls this and then passes the result to `hook_trust_status`.

*Call graph*: called by 1 (append_matcher_groups).


##### `hook_metadata_for_config_layer_source`  (lines 615–630)

```
fn hook_metadata_for_config_layer_source(source: &ConfigLayerSource) -> (HookSource, bool)
```

**Purpose**: Maps a config layer’s origin to the hook source label and whether it counts as managed. This creates consistent source attribution for hook entries.

**Data flow**: It receives a config layer source, such as system, user, project, MDM, or enterprise-managed. It returns a pair: the public hook source category and a true-or-false managed marker.

**Call relations**: `discover_handlers` calls this for each config layer before loading hooks from that layer. The result is stored in `HookHandlerSource` and later copied into hook entries and runnable handlers.

*Call graph*: called by 1 (discover_handlers).


##### `hook_source_for_requirement_source`  (lines 632–652)

```
fn hook_source_for_requirement_source(source: Option<&RequirementSource>) -> HookSource
```

**Purpose**: Maps a managed requirements source to the hook source label used in discovery output. For combined requirement sources, it uses the first contributor as the best available label.

**Data flow**: It receives an optional requirement source. It matches known sources such as MDM, system requirements, legacy managed config, enterprise-managed requirements, composite sources, or unknown, and returns the corresponding `HookSource` value.

**Call relations**: `append_managed_requirement_handlers` calls this when preparing managed requirement hooks for `append_hook_events`.

*Call graph*: called by 1 (append_managed_requirement_handlers).


##### `tests::source_path`  (lines 675–677)

```
fn source_path() -> AbsolutePathBuf
```

**Purpose**: Provides a reusable absolute test path for hook source files. This keeps tests short and consistent.

**Data flow**: It builds `/tmp/hooks.json` as a test path and converts it into the absolute path type used by the production code. The resulting path is returned to the test.

**Call relations**: Many tests call this before constructing a fake hook source for `append_matcher_groups`.

*Call graph*: 1 external calls (test_path_buf).


##### `tests::hook_source`  (lines 679–681)

```
fn hook_source() -> HookSource
```

**Purpose**: Provides a fixed hook source value for tests. It represents hooks coming from the system source.

**Data flow**: It takes no input and returns `HookSource::System`. Nothing else is changed.

**Call relations**: The test helper `tests::hook_handler_source` uses this, and several assertions compare discovered handlers against this expected source.


##### `tests::hook_handler_source`  (lines 683–697)

```
fn hook_handler_source(
        path: &'a AbsolutePathBuf,
        hook_states: &'a std::collections::HashMap<String, HookStateToml>,
    ) -> super::HookHandlerSource<'a>
```

**Purpose**: Builds a managed test hook source description. Tests use it to exercise discovery behavior without constructing every field by hand each time.

**Data flow**: It receives a source path and saved hook state map. It fills in source metadata, marks the source as managed, disables trust bypass, uses no plugin environment, and returns a `HookHandlerSource`.

**Call relations**: Tests pass its result into `append_matcher_groups` when they want hooks to behave like trusted managed/system hooks.

*Call graph*: calls 1 internal fn (display); 2 external calls (hook_source, new).


##### `tests::unmanaged_hook_handler_source`  (lines 699–714)

```
fn unmanaged_hook_handler_source(
        path: &'a AbsolutePathBuf,
        hook_states: &'a std::collections::HashMap<String, HookStateToml>,
        bypass_hook_trust: bool,
    ) -> super::HookHan
```

**Purpose**: Builds an unmanaged test hook source description. This is used to test user-level trust and disablement behavior.

**Data flow**: It receives a path, saved hook states, and a trust-bypass flag. It creates a `HookHandlerSource` marked as a user source, not managed, with no plugin environment, and returns it.

**Call relations**: Trust-related tests pass this helper’s output into `append_matcher_groups` to check how untrusted, trusted, disabled, and bypassed hooks behave.

*Call graph*: calls 1 internal fn (display); 1 external calls (new).


##### `tests::composite_requirement_hook_source_uses_primary_source`  (lines 717–734)

```
fn composite_requirement_hook_source_uses_primary_source()
```

**Purpose**: Checks that composite managed requirements use their first source as the public hook source label. This preserves a predictable attribution rule.

**Data flow**: It builds a composite requirement source with a system source first and an enterprise source second. It calls `hook_source_for_requirement_source` and asserts that the result is `HookSource::System`.

**Call relations**: This test covers the composite-source branch used by `append_managed_requirement_handlers` during managed hook discovery.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::enterprise_managed_synthetic_path_escapes_display_fields`  (lines 737–749)

```
fn enterprise_managed_synthetic_path_escapes_display_fields()
```

**Purpose**: Checks that enterprise-managed synthetic paths escape special characters in names and IDs. This makes sure display paths remain safe and unambiguous.

**Data flow**: It builds an enterprise-managed requirement source containing characters such as `<`, `>`, `&`, and quotes. It asks for the fallback managed hook source path and verifies that escaped text is present while raw unsafe text is not.

**Call relations**: This test exercises `fallback_managed_hooks_source_path`, which in turn relies on `escape_xml_text` for enterprise display values.

*Call graph*: 2 external calls (assert!, fallback_managed_hooks_source_path).


##### `tests::command_group`  (lines 751–762)

```
fn command_group(matcher: Option<&str>) -> MatcherGroup
```

**Purpose**: Creates a simple matcher group containing one `echo hello` command hook. Tests use it as a small standard hook fixture.

**Data flow**: It receives an optional matcher string. It builds a `MatcherGroup` with that matcher and one command hook with default timeout, no Windows override, no async behavior, and no status message.

**Call relations**: Several tests pass this fixture into `append_matcher_groups` to focus on matcher, trust, and discovery behavior rather than hook construction.

*Call graph*: 1 external calls (vec!).


##### `tests::user_prompt_submit_ignores_invalid_matcher_during_discovery`  (lines 765–797)

```
fn user_prompt_submit_ignores_invalid_matcher_during_discovery()
```

**Purpose**: Verifies that an invalid matcher is ignored for a user-prompt-submit event when that event does not use the matcher in the same way. The hook should still be discovered.

**Data flow**: It creates empty output lists, a managed hook source, and a command group with an invalid matcher string. After calling `append_matcher_groups`, it checks that there are no warnings and that one runnable handler was produced with no matcher.

**Call relations**: This test directly exercises `append_matcher_groups` and the event-specific matcher logic it gets from `matcher_pattern_for_event`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::pre_tool_use_keeps_valid_matcher_during_discovery`  (lines 800–832)

```
fn pre_tool_use_keeps_valid_matcher_during_discovery()
```

**Purpose**: Verifies that a valid matcher for a pre-tool-use hook is preserved. This ensures hooks can target specific tools.

**Data flow**: It creates a pre-tool-use command group with matcher `^Bash$`, runs `append_matcher_groups`, and asserts that the resulting handler keeps that matcher and the expected command fields.

**Call relations**: This test confirms that `append_matcher_groups` accepts valid matcher patterns and copies them into runnable handlers.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::bypass_hook_trust_allows_enabled_untrusted_handlers`  (lines 835–862)

```
fn bypass_hook_trust_allows_enabled_untrusted_handlers()
```

**Purpose**: Verifies that trust bypass mode allows an enabled but untrusted unmanaged hook to run. This is useful for special modes where trust checks are intentionally skipped.

**Data flow**: It creates an unmanaged hook source with trust bypass enabled and no saved trusted hash. After discovery, it checks that one handler and one hook entry exist, and that the entry still reports `Untrusted`.

**Call relations**: This test exercises the trust gate inside `append_matcher_groups`, especially the rule that bypass affects whether a hook runs but does not rewrite its trust status.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, source_path, unmanaged_hook_handler_source, new, vec!).


##### `tests::bypass_hook_trust_respects_disabled_handlers`  (lines 865–898)

```
fn bypass_hook_trust_respects_disabled_handlers()
```

**Purpose**: Verifies that trust bypass does not override a user-disabled hook. A disabled hook should stay non-runnable even when trust checks are bypassed.

**Data flow**: It creates saved hook state marking a specific unmanaged hook as disabled, then runs discovery with trust bypass enabled. It asserts that no runnable handlers are produced, while the hook entry still exists and is marked disabled and untrusted.

**Call relations**: This test covers the interaction between `hook_enabled`, trust bypass, and `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 7 external calls (new, assert_eq!, format!, source_path, unmanaged_hook_handler_source, from, vec!).


##### `tests::pre_tool_use_treats_star_matcher_as_match_all`  (lines 901–921)

```
fn pre_tool_use_treats_star_matcher_as_match_all()
```

**Purpose**: Checks that a `*` matcher for a pre-tool-use hook is accepted as a match-all pattern. This lets a hook apply broadly to all tools.

**Data flow**: It builds a command group with matcher `*`, runs `append_matcher_groups`, and asserts that one handler is produced with the matcher still set to `*`.

**Call relations**: This test verifies matcher validation behavior used inside `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::post_tool_use_keeps_valid_matcher_during_discovery`  (lines 924–945)

```
fn post_tool_use_keeps_valid_matcher_during_discovery()
```

**Purpose**: Verifies that valid matchers also work for post-tool-use hooks. This keeps targeting behavior consistent before and after tool execution.

**Data flow**: It builds a post-tool-use command group with matcher `Edit|Write`, runs discovery, and checks that the handler has the post-tool-use event and the same matcher.

**Call relations**: This test directly checks `append_matcher_groups` for another hook event type.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::toml_hook_discovery_ignores_malformed_state_entries`  (lines 948–978)

```
fn toml_hook_discovery_ignores_malformed_state_entries()
```

**Purpose**: Verifies that malformed saved hook state does not prevent valid TOML hook definitions from loading. Bad state should not break hook discovery.

**Data flow**: It creates a config layer containing a malformed `hooks.state` entry plus a valid session-start hook. It calls `load_toml_hooks_from_layer` and asserts that the valid hook loads and no warning is produced for the malformed state.

**Call relations**: This test exercises `load_toml_hooks_from_layer`, showing that hook definitions can be parsed even when unrelated state entries are malformed.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, test_path_buf, config_with_malformed_state_and_session_start_hook, load_toml_hooks_from_layer).


##### `tests::pre_tool_use_resolves_windows_command_override_during_discovery`  (lines 981–1017)

```
fn pre_tool_use_resolves_windows_command_override_during_discovery()
```

**Purpose**: Checks that command hooks choose the Windows-specific command on Windows and the normal command elsewhere. This keeps cross-platform hook configuration working.

**Data flow**: It creates a command hook with both `command` and `command_windows`, runs `append_matcher_groups`, and asserts that the resulting command matches the current operating system.

**Call relations**: This test covers the platform selection logic inside `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::config_with_malformed_state_and_session_start_hook`  (lines 1019–1036)

```
fn config_with_malformed_state_and_session_start_hook() -> TomlValue
```

**Purpose**: Builds a test configuration value containing one bad hook state entry and one valid session-start hook. It is a fixture for TOML hook loading tests.

**Data flow**: It creates JSON-shaped data, including malformed `enabled` state and a valid command hook, then converts it into the TOML value type used by config layers. The constructed value is returned.

**Call relations**: `tests::toml_hook_discovery_ignores_malformed_state_entries` calls this to feed `load_toml_hooks_from_layer`.

*Call graph*: 2 external calls (from_value, json!).


##### `tests::hook_metadata_for_config_layer_source_discards_source_details`  (lines 1039–1092)

```
fn hook_metadata_for_config_layer_source_discards_source_details()
```

**Purpose**: Verifies that detailed config layer sources are mapped to the expected broad hook source categories and managed flags. This keeps public attribution simple and stable.

**Data flow**: It creates examples of system, user, project, MDM, enterprise-managed, session, and legacy sources. For each one, it calls `hook_metadata_for_config_layer_source` and checks the returned source label and managed status.

**Call relations**: This test protects the source-labeling behavior used by `discover_handlers` before it processes hooks from config layers.

*Call graph*: 2 external calls (assert_eq!, test_path_buf).


### `hooks/src/engine/command_runner.rs`

`io_transport` · `hook execution`

This file is the bridge between the hook engine and the outside world. A hook is not run inside this Rust code directly; it is launched as a separate command, like asking another program to do a job and then reading its reply. Without this file, configured hooks could not actually execute, and the rest of the engine would have nothing concrete to report.

The main flow starts by building the command line to run. If the user configured a specific shell program, that shell is used. Otherwise the file chooses the normal system shell: `cmd.exe` on Windows, or `$SHELL` with a `/bin/sh` fallback on Unix-like systems. The hook command is then passed to that shell, along with any environment variables from the handler.

When the process starts, this file writes the provided JSON into the process standard input, which is the usual text channel a command can read from. It also captures standard output and standard error, the two text channels commands use to return normal messages and error messages. A timeout protects the system from a hook that never finishes. The result is packed into `CommandRunResult`, including start and end times, duration, exit code, captured text, and any launch, input, wait, or timeout error.

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

**Purpose**: Runs one configured hook command and returns a complete report of what happened. Someone uses this when the hook engine needs to turn a handler configuration into an actual process run, with JSON input and captured results.

**Data flow**: It receives the shell settings, the configured handler, a JSON string to send to the hook, and the working directory where the command should run. It records the start time, builds the command, starts the child process, writes the JSON into its input, waits for it to finish within the handler's timeout, and reads its output streams. It returns a `CommandRunResult` containing timing, exit code if there is one, captured standard output and error, and an error message if spawning, writing, waiting, or timing out failed.

**Call relations**: This is called by `execute_handlers` when the engine is ready to run a hook handler. It asks `build_command` to prepare the process command first, then takes over the live process work: starting it, feeding it input, waiting for output, and turning the whole run into a structured result for the caller.

*Call graph*: calls 1 internal fn (build_command); called by 1 (execute_handlers); 8 external calls (from_secs, now, piped, from_utf8_lossy, new, now, format!, timeout).


##### `build_command`  (lines 103–117)

```
fn build_command(shell: &CommandShell, handler: &ConfiguredHandler) -> Command
```

**Purpose**: Creates the operating-system command object that will later be launched. It decides whether to use a default shell or a configured shell, adds the hook command text, and attaches the handler's environment variables.

**Data flow**: It receives shell settings and a configured handler. If no shell program is configured, it asks `default_shell_command` for the platform's normal shell and adds the handler command to it. If a shell program is configured, it starts that program, adds the configured shell arguments, then adds the handler command. It returns a prepared `Command` object, but does not run it yet.

**Call relations**: `run_command` calls this before launching a hook process. `build_command` hides the command-line setup details from `run_command`, and calls `default_shell_command` only when the configuration has not named a shell explicitly.

*Call graph*: calls 1 internal fn (default_shell_command); called by 1 (run_command); 1 external calls (new).


##### `default_shell_command`  (lines 119–135)

```
fn default_shell_command() -> Command
```

**Purpose**: Chooses a sensible default shell for the current operating system. This lets hook commands run even when the configuration does not name a shell program.

**Data flow**: It reads an environment variable from the host machine: `COMSPEC` on Windows, or `SHELL` on non-Windows systems. If that variable is missing, it falls back to `cmd.exe` on Windows or `/bin/sh` elsewhere. It returns a command already set up with the shell flag used to execute a command string, such as `/C` on Windows or `-lc` on Unix-like systems.

**Call relations**: `build_command` calls this when no custom shell program was provided. It supplies the basic shell wrapper, and `build_command` then adds the actual hook command that should be run.

*Call graph*: called by 1 (build_command); 2 external calls (new, var).


### `hooks/src/engine/output_parser.rs`

`io_transport` · `hook output parsing during request handling`

Hooks are outside commands that can influence what the system does next. They communicate by printing JSON text to standard output, which is the normal text stream a command writes back to its caller. This file is the translator between that outside JSON language and the engine’s simpler Rust structures.

The main job is to parse each kind of hook result: session start, tool use before or after it happens, permission requests, user prompt submission, stop events, and compacting events. Each parser first checks that the output is real JSON shaped like an object. Then it converts the common fields, such as whether processing should continue, whether output should be hidden, and whether there is a system message. After that, it reads the fields that only make sense for that hook type.

A lot of the file is careful rule-checking. For example, if a hook says “block this action,” it must give a non-empty reason. Some fields are recognized from the wire format but are not allowed here, so the parser records an invalid reason instead of blindly applying them. This is like a customs desk: the form may be readable, but some requests are not permitted to pass through.

#### Function details

##### `parse_session_start`  (lines 93–100)

```
fn parse_session_start(stdout: &str) -> Option<SessionStartOutput>
```

**Purpose**: Reads the JSON output from a session-start hook and turns it into a session-start result. It keeps any extra context the hook wants to add.

**Data flow**: It receives raw stdout text from the hook. It asks the shared JSON parser to decode it into the session-start wire shape, then passes the common fields and optional additional context into the shared session-start builder. It returns either a filled SessionStartOutput or nothing if the text was empty, not JSON, or the wrong shape.

**Call relations**: When the wider hook engine finishes running a session-start command, parse_completed calls this parser. This function relies on parse_json for safe decoding and session_start_output for the final internal shape.

*Call graph*: calls 2 internal fn (parse_json, session_start_output); called by 1 (parse_completed).


##### `parse_subagent_start`  (lines 102–109)

```
fn parse_subagent_start(stdout: &str) -> Option<SessionStartOutput>
```

**Purpose**: Reads the JSON output from a subagent-start hook and turns it into the same internal shape used for session-start output. A subagent is a smaller helper agent, so its start event carries similar information.

**Data flow**: It takes raw stdout text, decodes it as the subagent-start wire format, extracts universal fields and optional additional context, and produces a SessionStartOutput. If decoding fails, it returns nothing.

**Call relations**: The general parse_completed flow calls this after a subagent-start hook completes. It shares the same builder as parse_session_start so both start events are interpreted consistently.

*Call graph*: calls 2 internal fn (parse_json, session_start_output); called by 1 (parse_completed).


##### `session_start_output`  (lines 111–119)

```
fn session_start_output(
    universal: HookUniversalOutputWire,
    additional_context: Option<String>,
) -> SessionStartOutput
```

**Purpose**: Builds the internal result object used for session-start-like events. It avoids duplicating the same conversion code for session starts and subagent starts.

**Data flow**: It receives universal wire fields plus optional extra context. It converts the universal wire fields into UniversalOutput and places both pieces into a SessionStartOutput.

**Call relations**: parse_session_start and parse_subagent_start hand their decoded data to this helper. It delegates the common-field conversion to UniversalOutput::from.

*Call graph*: calls 1 internal fn (from); called by 2 (parse_session_start, parse_subagent_start).


##### `parse_pre_tool_use`  (lines 121–182)

```
fn parse_pre_tool_use(stdout: &str) -> Option<PreToolUseOutput>
```

**Purpose**: Reads output from a hook that runs before a tool is used. It decides whether the hook blocks the tool, adds context, updates the tool input, or has returned an unsupported request.

**Data flow**: It takes raw stdout, decodes the pre-tool-use JSON, converts the common fields, then checks which decision style the hook used. If the output is valid, it may return a block reason or an updated input value. If the output asks for something unsupported, it records an invalid reason and withholds the action result.

**Call relations**: parse_completed calls this when a pre-tool-use hook finishes. It uses parse_json for decoding, UniversalOutput::from for common fields, and the pre-tool-use validation helpers to protect the engine from unsupported or incomplete decisions.

*Call graph*: calls 3 internal fn (from, parse_json, unsupported_pre_tool_use_universal); called by 1 (parse_completed).


##### `parse_permission_request`  (lines 184–205)

```
fn parse_permission_request(stdout: &str) -> Option<PermissionRequestOutput>
```

**Purpose**: Reads output from a hook that decides whether a permission request should be allowed or denied. It also checks for reserved fields that this engine deliberately does not accept.

**Data flow**: It receives stdout text, decodes permission-request JSON, converts common fields, checks universal and hook-specific restrictions, and then converts a valid allow or deny decision into the internal enum. If the output contains unsupported fields, it returns the parsed common data with an invalid reason instead of a decision.

**Call relations**: parse_completed uses this during normal hook processing, and the tests call it directly to confirm reserved fields are rejected. It depends on parse_json, UniversalOutput::from, and permission-request validation and decision conversion helpers.

*Call graph*: calls 3 internal fn (from, parse_json, unsupported_permission_request_universal); called by 4 (permission_request_rejects_reserved_interrupt_field, permission_request_rejects_reserved_updated_input_field, permission_request_rejects_reserved_updated_permissions_field, parse_completed).


##### `parse_post_tool_use`  (lines 207–239)

```
fn parse_post_tool_use(stdout: &str) -> Option<PostToolUseOutput>
```

**Purpose**: Reads output from a hook that runs after a tool has been used. It can report extra context or request that the result be blocked, but only with a valid non-empty reason.

**Data flow**: It takes stdout, decodes post-tool-use JSON, converts common fields, checks whether unsupported universal or hook-specific fields were used, and checks whether a block decision has a real reason. It returns a PostToolUseOutput that says whether blocking is actually allowed, what reason was given, and whether anything was invalid.

**Call relations**: parse_completed calls this after post-tool-use hooks. The function uses parse_json for decoding, UniversalOutput::from for common fields, invalid_block_message for a standard error message, and post-tool-use validation helpers before allowing a block.

*Call graph*: calls 4 internal fn (from, invalid_block_message, parse_json, unsupported_post_tool_use_universal); called by 1 (parse_completed); 1 external calls (matches!).


##### `parse_pre_compact`  (lines 241–248)

```
fn parse_pre_compact(stdout: &str) -> Option<PreCompactOutput>
```

**Purpose**: Reads output from a hook that runs before compaction. Compaction means reducing or summarizing stored conversation context.

**Data flow**: It receives stdout, decodes it as pre-compact JSON, converts universal fields, and returns a PreCompactOutput. This parser does not currently apply extra validation beyond successful JSON decoding and common-field conversion.

**Call relations**: parse_pre_completed calls this during the pre-compaction flow. It uses parse_json and UniversalOutput::from.

*Call graph*: calls 2 internal fn (from, parse_json); called by 1 (parse_pre_completed).


##### `parse_post_compact`  (lines 250–257)

```
fn parse_post_compact(stdout: &str) -> Option<StatelessHookOutput>
```

**Purpose**: Reads output from a hook that runs after compaction and returns a stateless hook result. Stateless here means the parser only keeps common output information and no event-specific decision.

**Data flow**: It takes stdout, decodes post-compact JSON, converts the universal fields, and returns a StatelessHookOutput with no invalid reason set. If the JSON is absent or malformed, it returns nothing.

**Call relations**: This is the post-compaction counterpart to parse_pre_compact. It uses parse_json for the wire format and UniversalOutput::from for the shared fields.

*Call graph*: calls 2 internal fn (from, parse_json).


##### `parse_user_prompt_submit`  (lines 259–281)

```
fn parse_user_prompt_submit(stdout: &str) -> Option<UserPromptSubmitOutput>
```

**Purpose**: Reads output from a hook that runs when a user submits a prompt. It can allow the prompt through, block it with a reason, or add context.

**Data flow**: It receives raw stdout, decodes the user-prompt-submit JSON, checks whether the hook asked to block, and verifies that a block has a non-empty reason. It returns the common fields, the block decision if valid, the reason, any invalid-block message, and optional extra context.

**Call relations**: parse_completed calls this when a user prompt hook finishes. It uses parse_json, UniversalOutput::from, and invalid_block_message to apply the shared blocking rule.

*Call graph*: calls 3 internal fn (from, invalid_block_message, parse_json); called by 1 (parse_completed); 1 external calls (matches!).


##### `parse_stop`  (lines 283–291)

```
fn parse_stop(stdout: &str) -> Option<StopOutput>
```

**Purpose**: Reads output from a hook that runs when the main session is stopping. It can request that stopping be blocked, but only with a clear reason.

**Data flow**: It takes stdout, decodes stop-event JSON, and passes the universal fields, decision, reason, and event name into the shared stop builder. It returns a StopOutput or nothing if parsing fails.

**Call relations**: parse_completed calls this for normal stop hooks. It shares the stop_output helper with parse_subagent_stop so both stop events follow the same validation rules.

*Call graph*: calls 2 internal fn (parse_json, stop_output); called by 1 (parse_completed).


##### `parse_subagent_stop`  (lines 293–301)

```
fn parse_subagent_stop(stdout: &str) -> Option<StopOutput>
```

**Purpose**: Reads output from a hook that runs when a subagent stops. It uses the same internal stop result as the main stop event.

**Data flow**: It receives stdout, decodes the subagent-stop wire format, and sends the common fields, decision, reason, and subagent event name to the shared stop builder. The result is a StopOutput or nothing if the text cannot be parsed.

**Call relations**: parse_completed calls this for subagent stop hooks. It relies on parse_json for decoding and stop_output for the shared block-reason checks.

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

**Purpose**: Builds a StopOutput for both main stop and subagent stop events. It enforces the rule that a block decision must include a non-empty reason.

**Data flow**: It receives universal wire fields, an optional block decision, an optional reason, and the event name for error wording. It converts the universal fields, checks whether blocking is valid, and returns a StopOutput with blocking enabled only if the reason passes validation.

**Call relations**: parse_stop and parse_subagent_stop call this after decoding their JSON. It uses UniversalOutput::from for shared fields and invalid_block_message for the standard missing-reason error.

*Call graph*: calls 2 internal fn (from, invalid_block_message); called by 2 (parse_stop, parse_subagent_stop); 1 external calls (matches!).


##### `UniversalOutput::from`  (lines 328–335)

```
fn from(value: HookUniversalOutputWire) -> Self
```

**Purpose**: Converts the shared hook output fields from the wire format into the internal UniversalOutput type. These are the fields that many hook events have in common.

**Data flow**: It receives HookUniversalOutputWire, copies over the continue flag, stop reason, suppress-output flag, and system message, and returns a UniversalOutput. No outside state is changed.

**Call relations**: Nearly every parser calls this after JSON decoding. It is the central adapter between the schema module’s wire names and the engine’s internal names.

*Call graph*: called by 8 (parse_permission_request, parse_post_compact, parse_post_tool_use, parse_pre_compact, parse_pre_tool_use, parse_user_prompt_submit, session_start_output, stop_output).


##### `parse_json`  (lines 338–351)

```
fn parse_json(stdout: &str) -> Option<T>
```

**Purpose**: Safely decodes hook stdout into a requested JSON-backed Rust type. It refuses empty text and JSON that is not an object.

**Data flow**: It trims the input text, returns nothing if it is empty, tries to parse it as JSON, checks that the top-level value is an object, and then converts it into the requested wire type. On any failure, it returns nothing instead of throwing an error.

**Call relations**: All event-specific parsers call this first. It uses serde_json, the project’s JSON library, to parse text and then deserialize it into the correct wire structure.

*Call graph*: called by 10 (parse_permission_request, parse_post_compact, parse_post_tool_use, parse_pre_compact, parse_pre_tool_use, parse_session_start, parse_stop, parse_subagent_start, parse_subagent_stop, parse_user_prompt_submit); 2 external calls (from_str, from_value).


##### `looks_like_json`  (lines 353–356)

```
fn looks_like_json(stdout: &str) -> bool
```

**Purpose**: Makes a quick guess about whether stdout starts like JSON. It is a lightweight check used before deeper parsing.

**Data flow**: It receives stdout text, ignores leading whitespace, and returns true if the first meaningful character is `{` or `[`. It does not prove the JSON is valid; it only answers whether it appears JSON-like.

**Call relations**: The broader parsing flows call this before choosing JSON-style parsing paths. It complements parse_json, which performs the real decoding and validation.

*Call graph*: called by 7 (parse_completed, parse_pre_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed).


##### `invalid_block_message`  (lines 358–360)

```
fn invalid_block_message(event_name: &str) -> String
```

**Purpose**: Creates the standard error text for a hook that says “block” but does not give a meaningful reason. This keeps wording consistent across hook types.

**Data flow**: It receives the event name, inserts it into a fixed sentence, and returns that sentence as a String. It changes no state.

**Call relations**: Blocking parsers and validators call this whenever they detect a missing or blank reason. It is used for post-tool-use, user-prompt-submit, stop-style events, and legacy pre-tool-use decisions.

*Call graph*: called by 4 (parse_post_tool_use, parse_user_prompt_submit, stop_output, unsupported_pre_tool_use_legacy_decision); 1 external calls (format!).


##### `unsupported_pre_tool_use_universal`  (lines 362–372)

```
fn unsupported_pre_tool_use_universal(universal: &UniversalOutput) -> Option<String>
```

**Purpose**: Checks whether a pre-tool-use hook used common output fields that are not allowed for that event. It protects the engine from treating unsupported controls as valid.

**Data flow**: It receives a UniversalOutput and examines continue_processing, stop_reason, and suppress_output. If one of those fields is not allowed in this context, it returns a clear invalid-reason message; otherwise it returns nothing.

**Call relations**: parse_pre_tool_use calls this before accepting any pre-tool-use decision. If it reports a problem, the parser records the invalid reason and avoids applying the requested action.

*Call graph*: called by 1 (parse_pre_tool_use).


##### `unsupported_permission_request_universal`  (lines 374–384)

```
fn unsupported_permission_request_universal(universal: &UniversalOutput) -> Option<String>
```

**Purpose**: Checks whether a permission-request hook used common output fields that are not supported for permission decisions. This prevents confusing global controls from changing permission behavior.

**Data flow**: It receives a UniversalOutput and checks for continue:false, a stop reason, or suppress-output. It returns the first matching invalid-reason message, or nothing if the common fields are acceptable.

**Call relations**: parse_permission_request calls this before converting an allow or deny decision. A reported problem stops the decision from being applied.

*Call graph*: called by 1 (parse_permission_request).


##### `unsupported_post_tool_use_universal`  (lines 386–392)

```
fn unsupported_post_tool_use_universal(universal: &UniversalOutput) -> Option<String>
```

**Purpose**: Checks the common fields for post-tool-use output and rejects suppress-output, which is not supported for that event.

**Data flow**: It receives a UniversalOutput. If suppress_output is true, it returns an invalid-reason message; otherwise it returns nothing.

**Call relations**: parse_post_tool_use calls this as part of deciding whether the hook’s output can be trusted and applied.

*Call graph*: called by 1 (parse_post_tool_use).


##### `unsupported_permission_request_hook_specific_output`  (lines 394–407)

```
fn unsupported_permission_request_hook_specific_output(
    decision: Option<&PermissionRequestDecisionWire>,
) -> Option<String>
```

**Purpose**: Checks permission-request decision details for fields that are reserved or unsupported. These fields may exist in the broader schema, but this engine does not allow them here.

**Data flow**: It receives an optional permission decision. If there is no decision, it returns nothing. If the decision includes updated input, updated permissions, or interrupt:true, it returns the matching invalid-reason message; otherwise it returns nothing.

**Call relations**: The permission-request parser uses this after checking common fields. Its result helps decide whether a parsed permission decision should be accepted or replaced by an invalid reason.


##### `permission_request_decision`  (lines 409–422)

```
fn permission_request_decision(
    decision: &PermissionRequestDecisionWire,
) -> PermissionRequestDecision
```

**Purpose**: Converts a valid permission-request wire decision into the engine’s simpler allow-or-deny decision. It also supplies a default denial message when the hook does not provide one.

**Data flow**: It receives a wire decision. For allow, it returns PermissionRequestDecision::Allow. For deny, it trims the optional message and uses it if non-empty, otherwise it returns a deny decision with a standard fallback message.

**Call relations**: parse_permission_request uses this only after validation has passed. It relies on trimmed_reason to avoid treating whitespace as a real denial message.


##### `unsupported_post_tool_use_hook_specific_output`  (lines 424–432)

```
fn unsupported_post_tool_use_hook_specific_output(
    output: &crate::schema::PostToolUseHookSpecificOutputWire,
) -> Option<String>
```

**Purpose**: Checks post-tool-use-specific output for an unsupported tool-output replacement field. This makes sure the hook cannot silently change a tool result through a field the engine does not implement.

**Data flow**: It receives the post-tool-use hook-specific output. If updated_mcp_tool_output is present, it returns an invalid-reason message; otherwise it returns nothing.

**Call relations**: parse_post_tool_use uses this during validation of hook-specific fields before deciding whether any block decision should count.


##### `unsupported_pre_tool_use_hook_specific_output`  (lines 434–475)

```
fn unsupported_pre_tool_use_hook_specific_output(
    output: &crate::schema::PreToolUseHookSpecificOutputWire,
) -> Option<String>
```

**Purpose**: Validates the newer pre-tool-use hook-specific decision fields. It checks that input updates, allow, ask, and deny decisions follow the rules this engine supports.

**Data flow**: It receives pre-tool-use hook-specific output. It rejects updated input unless the decision is allow, rejects allow without an updated input, rejects ask entirely, requires deny to include a non-empty reason, and rejects a reason without a decision. It returns a specific invalid-reason message or nothing if the output is acceptable.

**Call relations**: parse_pre_tool_use uses this when the hook used the hook-specific decision format. It calls invalid_pre_tool_use_reason_message for the special deny-without-reason case and uses the shared trimming rule to judge whether a reason is meaningful.

*Call graph*: calls 1 internal fn (invalid_pre_tool_use_reason_message); 1 external calls (matches!).


##### `unsupported_pre_tool_use_legacy_decision`  (lines 477–500)

```
fn unsupported_pre_tool_use_legacy_decision(
    decision: Option<&PreToolUseDecisionWire>,
    reason: Option<&str>,
) -> Option<String>
```

**Purpose**: Validates the older pre-tool-use decision fields. This lets the parser support old-style output while still enforcing today’s rules.

**Data flow**: It receives an optional old-style decision and optional reason. It rejects approve as unsupported, accepts block only if the reason is non-empty, and rejects a reason that appears without any decision. It returns an invalid-reason message or nothing.

**Call relations**: parse_pre_tool_use uses this when no newer hook-specific decision fields are present. It calls invalid_block_message for the standard block-without-reason wording.

*Call graph*: calls 1 internal fn (invalid_block_message).


##### `invalid_pre_tool_use_reason_message`  (lines 502–505)

```
fn invalid_pre_tool_use_reason_message() -> String
```

**Purpose**: Creates the standard error text for a pre-tool-use deny decision that lacks a meaningful deny reason.

**Data flow**: It takes no input and returns a fixed String explaining that permissionDecision:deny needs a non-empty permissionDecisionReason.

**Call relations**: unsupported_pre_tool_use_hook_specific_output calls this for the deny-without-reason case so that message stays consistent.

*Call graph*: called by 1 (unsupported_pre_tool_use_hook_specific_output).


##### `trimmed_reason`  (lines 507–514)

```
fn trimmed_reason(reason: &str) -> Option<String>
```

**Purpose**: Turns a reason string into a clean optional message. Blank or whitespace-only text is treated as no reason at all.

**Data flow**: It receives a string slice, trims whitespace from both ends, and returns the trimmed text if anything remains. If the result is empty, it returns nothing.

**Call relations**: Decision conversion and validation helpers use this whenever a human-readable reason is required. It is the small shared rule that prevents spaces from counting as an explanation.


##### `tests::permission_request_rejects_reserved_updated_input_field`  (lines 524–544)

```
fn permission_request_rejects_reserved_updated_input_field()
```

**Purpose**: Tests that permission-request output is marked invalid when it tries to use the reserved updatedInput field.

**Data flow**: It builds a sample JSON permission-request response with behavior allow and updatedInput present. It parses that response and checks that the returned invalid_reason is the expected unsupported-updatedInput message.

**Call relations**: This test calls parse_permission_request directly. It proves the permission-request validation path catches one reserved field before any allow decision is applied.

*Call graph*: calls 1 internal fn (parse_permission_request); 2 external calls (assert_eq!, json!).


##### `tests::permission_request_rejects_reserved_updated_permissions_field`  (lines 547–567)

```
fn permission_request_rejects_reserved_updated_permissions_field()
```

**Purpose**: Tests that permission-request output is marked invalid when it tries to use the reserved updatedPermissions field.

**Data flow**: It creates sample JSON with an allow decision and updatedPermissions present. After parsing, it compares the parser’s invalid_reason with the expected unsupported-updatedPermissions message.

**Call relations**: This test exercises parse_permission_request’s hook-specific validation. It guards against future changes accidentally allowing permission updates through this parser.

*Call graph*: calls 1 internal fn (parse_permission_request); 2 external calls (assert_eq!, json!).


##### `tests::permission_request_rejects_reserved_interrupt_field`  (lines 570–590)

```
fn permission_request_rejects_reserved_interrupt_field()
```

**Purpose**: Tests that permission-request output is marked invalid when it sets interrupt:true. The field is recognized but not supported for this event.

**Data flow**: It builds sample JSON containing an allow decision with interrupt set to true. It parses the JSON and asserts that the invalid_reason reports unsupported interrupt:true.

**Call relations**: This test calls parse_permission_request and checks the reserved-field rejection path. It helps ensure the engine does not start honoring interrupt behavior by accident.

*Call graph*: calls 1 internal fn (parse_permission_request); 2 external calls (assert_eq!, json!).


### `hooks/src/output_spill.rs`

`io_transport` · `hook execution output preparation`

Hooks can produce a lot of text. Sending all of that text back into the model can waste the model’s limited reading space, called a token budget. This file acts like an overflow shelf: short hook output is passed through unchanged, but very long output is stored on disk and only a compact preview is shown.

The main type is HookOutputSpiller. When it is created, it chooses a folder inside the operating system’s temporary directory, under hook_outputs. When asked to process hook text, it first estimates how many tokens the text would use. If the text fits under the limit, nothing special happens. If it is too large, the file builds a unique path for that thread, creates the needed folder, and writes the full text there. The returned text becomes a truncated head-and-tail style preview, followed by a note saying where the full hook output was saved.

If saving fails, the code does not stop the whole hook flow. It logs a warning and falls back to returning only a truncated preview. This means the model still gets something useful, even if the full text could not be preserved.

#### Function details

##### `HookOutputSpiller::new`  (lines 20–25)

```
fn new() -> Self
```

**Purpose**: Creates a HookOutputSpiller ready to save large hook outputs. It chooses a stable temporary folder where spilled hook text will be written.

**Data flow**: It reads the operating system’s temporary directory, turns it into an absolute path, appends the hook_outputs folder name, and stores that as the spiller’s output directory. The result is a new HookOutputSpiller value.

**Call relations**: This is the setup step for the spiller. Later, when hook output needs to be checked, the other methods use the directory chosen here as the base place for saved full outputs.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 1 (new); 1 external calls (temp_dir).


##### `HookOutputSpiller::maybe_spill_text`  (lines 33–61)

```
async fn maybe_spill_text(&self, thread_id: ThreadId, text: String) -> String
```

**Purpose**: Checks one piece of hook text and either returns it unchanged or saves the full version to disk and returns a shorter replacement. This protects the model-visible hook output budget without throwing away the full text.

**Data flow**: It takes a thread id and a text string. First it estimates the text size in tokens. If the text is small enough, it returns the original string. If it is too large, it builds a unique file path, creates the parent folder, and writes the full text there. On success, it returns a truncated preview with the saved file path added. If directory creation or writing fails, it logs a warning and returns only a truncated preview.

**Call relations**: This is the central worker in the file. The batch methods call it once per plain text item or prompt fragment. It relies on hook_output_path to choose a safe unique filename, and on spilled_hook_output_preview to build the final model-visible replacement after the full output has been saved.

*Call graph*: calls 2 internal fn (hook_output_path, spilled_hook_output_preview); called by 3 (maybe_spill_text, maybe_spill_prompt_fragments, maybe_spill_texts); 6 external calls (approx_token_count, formatted_truncate_text, create_dir_all, write, Tokens, warn!).


##### `HookOutputSpiller::maybe_spill_texts`  (lines 63–73)

```
async fn maybe_spill_texts(
        &self,
        thread_id: ThreadId,
        texts: Vec<String>,
    ) -> Vec<String>
```

**Purpose**: Applies the single-text spilling behavior to a list of hook output strings. It is useful when several hook outputs need the same size protection.

**Data flow**: It takes a thread id and a list of strings. It creates a new list of the same expected size, sends each string through maybe_spill_text, and collects the returned strings. The output is a new list where each item is either unchanged or replaced by a preview plus saved-file note.

**Call relations**: This is a convenience wrapper around maybe_spill_text. Instead of making callers write the loop themselves, it performs the same spill check for every text item in order.

*Call graph*: calls 1 internal fn (maybe_spill_text); called by 1 (maybe_spill_texts); 1 external calls (with_capacity).


##### `HookOutputSpiller::maybe_spill_prompt_fragments`  (lines 75–88)

```
async fn maybe_spill_prompt_fragments(
        &self,
        thread_id: ThreadId,
        fragments: Vec<HookPromptFragment>,
    ) -> Vec<HookPromptFragment>
```

**Purpose**: Applies hook-output spilling to prompt fragments while preserving each fragment’s hook run identity. A prompt fragment is a piece of text plus metadata saying which hook run produced it.

**Data flow**: It takes a thread id and a list of HookPromptFragment values. For each fragment, it sends only the fragment text through maybe_spill_text, then builds a new fragment with the possibly shortened text and the original hook_run_id unchanged. The result is a new list of prompt fragments safe to show within the output budget.

**Call relations**: This method adapts the core maybe_spill_text behavior for structured prompt data. It is used when the caller has hook prompt fragments rather than plain strings, and it keeps the metadata attached while changing only the visible text when needed.

*Call graph*: calls 1 internal fn (maybe_spill_text); called by 1 (maybe_spill_prompt_fragments); 1 external calls (with_capacity).


##### `hook_output_path`  (lines 91–95)

```
fn hook_output_path(output_dir: &AbsolutePathBuf, thread_id: ThreadId) -> AbsolutePathBuf
```

**Purpose**: Builds the file path where one oversized hook output should be saved. It keeps outputs grouped by thread and gives each saved file a unique name.

**Data flow**: It receives the base output directory and a thread id. It appends the thread id as a folder name, then appends a newly generated unique .txt filename. The result is an absolute path for one saved hook output file.

**Call relations**: maybe_spill_text calls this when it has decided the text is too large. The returned path is then used both for writing the full output and for telling the user or model where that full output can be found.

*Call graph*: calls 1 internal fn (join); called by 1 (maybe_spill_text); 2 external calls (format!, to_string).


##### `spilled_hook_output_preview`  (lines 101–107)

```
fn spilled_hook_output_preview(text: &str, path: &AbsolutePathBuf) -> String
```

**Purpose**: Builds the replacement text shown after a hook output has been spilled to disk. It includes a shortened preview and a clear note pointing to the full saved file.

**Data flow**: It takes the original long text and the file path where the full text was saved. It first creates the footer containing that path, estimates how much of the token budget the footer uses, and subtracts that from the preview budget. It then truncates the original text to fit the remaining budget and appends the footer. The result is a single string that stays within the intended limit while still showing where to recover the full output.

**Call relations**: maybe_spill_text calls this after successfully writing the full text to disk. This function is the final packaging step: it turns the saved output path and the long original text into the compact message that will be visible to the model.

*Call graph*: called by 1 (maybe_spill_text); 3 external calls (approx_token_count, format!, Tokens).


### `hooks/src/engine/dispatcher.rs`

`orchestration` · `hook dispatch during event handling`

Hooks are user-defined commands that run at important moments, like before a tool is used, after a tool finishes, when a session starts, or when the system stops. This file answers three practical questions: which hooks apply right now, how do we run them, and how do we report what happened?

First, it filters the configured hook list by event name. For some events it also checks a matcher, which is like a simple rule saying “only run this hook for Bash” or “run this hook for Edit or Write.” For prompt submission and stop events, matchers are ignored, so every hook for that event runs.

Then it can run the chosen command hooks at the same time. Even though they may finish in any order, the final returned list is put back into the original configured order. The actual finish order is still recorded separately, which is useful for reporting what happened in real time.

Finally, it builds hook run summaries. These summaries say whether a hook is running or completed, where it came from, when it started and ended, and what output entries it produced. Without this file, hook events would not reliably find the right commands, execute them, or produce consistent status information for the rest of the system.

#### Function details

##### `select_handlers`  (lines 27–34)

```
fn select_handlers(
    handlers: &[ConfiguredHandler],
    event_name: HookEventName,
    matcher_input: Option<&str>,
) -> Vec<ConfiguredHandler>
```

**Purpose**: Chooses the configured hook handlers that match one event and, optionally, one matcher input such as a tool name. It is the simple entry point for the common case where there is only one name to match against.

**Data flow**: It receives a list of configured handlers, the event currently happening, and maybe one text value to match. It turns that optional text into a small list and passes the real selection work onward. It returns a new list containing only the handlers that should run.

**Call relations**: Tests call this function to check everyday hook selection cases, such as stop hooks, tool hooks, compact hooks, and declaration order. Internally it delegates to select_handlers_for_matcher_inputs so the same matching rules are shared with callers that need to test several possible names for one event.

*Call graph*: calls 1 internal fn (select_handlers_for_matcher_inputs); called by 19 (compact_hooks_match_trigger, post_tool_use_matches_tool_name, pre_tool_use_matches_tool_name, pre_tool_use_regex_alternation_matches_each_tool_name, pre_tool_use_star_matcher_matches_all_tools, select_handlers_keeps_duplicate_stop_handlers, select_handlers_keeps_overlapping_session_start_matchers, select_handlers_preserves_declaration_order, user_prompt_submit_ignores_matcher, preview_post (+9 more)).


##### `select_handlers_for_matcher_inputs`  (lines 36–68)

```
fn select_handlers_for_matcher_inputs(
    handlers: &[ConfiguredHandler],
    event_name: HookEventName,
    matcher_inputs: &[&str],
) -> Vec<ConfiguredHandler>
```

**Purpose**: Chooses handlers for an event when there may be several possible matcher names for the same thing. This prevents one hook from running twice just because more than one alias matches it.

**Data flow**: It reads the full configured handler list, keeps only handlers for the requested event, then applies matcher rules where that event type supports matching. If there are several matcher inputs, it checks whether any of them match, but it still includes each handler at most once. The output is a cloned list of matching handlers in their original order.

**Call relations**: select_handlers uses this as its worker for the one-input case. Hook preview and run paths also call it when an event may have compatibility names or aliases, and the alias-focused test checks that a combined matcher is selected once rather than repeated.

*Call graph*: called by 8 (select_handlers, pre_tool_use_aliases_match_once_per_handler, preview, run, preview, run, preview, run); 1 external calls (iter).


##### `running_summary`  (lines 70–87)

```
fn running_summary(handler: &ConfiguredHandler) -> HookRunSummary
```

**Purpose**: Creates a status record saying that a hook command has started and is currently running. This lets the rest of the system show hook activity before the command has finished.

**Data flow**: It takes one configured handler and copies identifying details from it, such as the event name, source, display order, and optional status message. It adds a fresh start time, marks the status as running, leaves completion fields empty, and returns a HookRunSummary.

**Call relations**: This function uses the handler’s run identifier and scope_for_event to fill in stable reporting fields. It is used by hook-running flows when they need to announce or store that a hook run has begun.

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

**Purpose**: Runs a group of selected hook command handlers concurrently and parses each command result into the caller’s chosen output type. It lets hooks run efficiently while still returning results in the configured order.

**Data flow**: It receives the shell to use, handlers to run, input JSON to send to each command, the working directory, an optional turn id, and a parser function. For every handler, it starts run_command with the same input and directory. As each command finishes, it records that finish position, parses the command result, then later sorts everything back into the original handler order. It returns the parsed results.

**Call relations**: Several hook event runners call this when they have already selected which hooks should run. It hands each command to run_command for the actual process execution, then hands each result to the parser supplied by the caller so different hook events can interpret command output in their own way.

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

**Purpose**: Creates the final status record for a hook command after it has finished. This is the completed counterpart to running_summary.

**Data flow**: It receives the original handler, the command run timing/result information, a final status such as success or failure, and output entries to include. It combines those into a HookRunSummary with start time, completion time, duration, source details, event details, and entries filled in. The returned summary is ready for reporting or storage.

**Call relations**: Event-specific parse functions call this after command execution so every hook event reports completion in the same format. It relies on scope_for_event for the scope field and on the handler’s run identifier for consistent tracking.

*Call graph*: calls 2 internal fn (run_id, scope_for_event); called by 8 (parse_completed, parse_pre_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed).


##### `scope_for_event`  (lines 142–154)

```
fn scope_for_event(event_name: HookEventName) -> HookScope
```

**Purpose**: Decides whether a hook run belongs to the whole thread or just the current turn. A thread is the broader conversation, while a turn is one user/system exchange inside it.

**Data flow**: It receives a hook event name and maps it to a HookScope value. Session and subagent start events are treated as thread-wide. Tool use, prompt submission, compacting, subagent stop, and stop events are treated as turn-scoped. It returns that scope.

**Call relations**: running_summary and completed_summary both call this so started and finished hook reports agree about the lifetime of each event.

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

**Purpose**: Builds a small test hook handler with the fields needed by the selection tests. It keeps the tests focused on matching behavior instead of repeating setup details.

**Data flow**: It receives an event name, optional matcher text, command text, and display order. It fills in the remaining handler fields with test defaults, including a fake hooks file path, user source, timeout, and empty environment map. It returns a ConfiguredHandler ready for use in tests.

**Call relations**: The test cases use this helper whenever they need sample handlers. It calls the test path helper to create a stable fake source path.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::select_handlers_keeps_duplicate_stop_handlers`  (lines 187–208)

```
fn select_handlers_keeps_duplicate_stop_handlers()
```

**Purpose**: Checks that two stop hooks with the same command are both kept. This matters because duplicate-looking hooks may be intentionally configured separately.

**Data flow**: The test creates two stop handlers, asks select_handlers for stop hooks, and checks that both come back in order. Nothing outside the test is changed.

**Call relations**: It exercises select_handlers for the Stop event, where matchers are not used and all handlers for that event should be selected.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::select_handlers_keeps_overlapping_session_start_matchers`  (lines 211–232)

```
fn select_handlers_keeps_overlapping_session_start_matchers()
```

**Purpose**: Checks that different session-start hooks are both selected when their matchers overlap. A broad matcher should not hide another matching hook.

**Data flow**: The test creates two session-start handlers with patterns that both match the same input, then selects handlers for that input. It verifies that both handlers are returned in display order.

**Call relations**: It calls select_handlers to confirm that matching is done per configured handler and that overlapping rules do not collapse separate handlers into one.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::compact_hooks_match_trigger`  (lines 235–255)

```
fn compact_hooks_match_trigger()
```

**Purpose**: Checks that compact hooks are selected based on the compact trigger text, such as manual versus automatic. This keeps hooks from firing for the wrong kind of compact action.

**Data flow**: The test builds one manual and one automatic pre-compact handler, then selects using the manual trigger. It verifies that only the manual handler is returned.

**Call relations**: It calls select_handlers for a PreCompact event and confirms the matcher behavior used by compact-related hook flows.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_matches_tool_name`  (lines 258–278)

```
fn pre_tool_use_matches_tool_name()
```

**Purpose**: Checks that before-tool hooks match the tool name correctly. For example, a Bash hook should run before Bash but not before Edit.

**Data flow**: The test creates two PreToolUse handlers, one for Bash and one for Edit. It selects using Bash as the matcher input and verifies that only the Bash handler is chosen.

**Call relations**: It calls select_handlers to validate the filtering rules used before a tool command runs.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::post_tool_use_matches_tool_name`  (lines 281–301)

```
fn post_tool_use_matches_tool_name()
```

**Purpose**: Checks that after-tool hooks also match the tool name correctly. The same tool-specific filtering should apply after a tool finishes.

**Data flow**: The test creates two PostToolUse handlers, one for Bash and one for Edit. It selects using Bash and confirms that only the Bash handler is returned.

**Call relations**: It calls select_handlers to validate the filtering rules used after a tool command has completed.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_star_matcher_matches_all_tools`  (lines 304–324)

```
fn pre_tool_use_star_matcher_matches_all_tools()
```

**Purpose**: Checks that a star matcher acts like “match everything” for before-tool hooks. This supports hooks that should run for any tool.

**Data flow**: The test creates a catch-all PreToolUse handler and a specific Edit handler. It selects using Bash and confirms that the catch-all handler is selected while the Edit-only handler is not.

**Call relations**: It calls select_handlers and indirectly verifies the shared matcher helper behavior used by the dispatcher.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_regex_alternation_matches_each_tool_name`  (lines 327–342)

```
fn pre_tool_use_regex_alternation_matches_each_tool_name()
```

**Purpose**: Checks that a matcher can name several tools in one pattern, such as Edit or Write. It also checks that tools outside the pattern do not match.

**Data flow**: The test creates one PreToolUse handler with a matcher that accepts Edit or Write. It runs selection for Edit, Write, and Bash, then verifies that the first two select the handler and Bash does not.

**Call relations**: It calls select_handlers multiple times to confirm regular-expression style matching works for tool names.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_aliases_match_once_per_handler`  (lines 345–387)

```
fn pre_tool_use_aliases_match_once_per_handler()
```

**Purpose**: Checks that when several compatibility names describe one tool action, each configured handler is selected only once. This avoids accidentally running a combined hook multiple times.

**Data flow**: The test creates handlers for apply_patch, Write, Edit, and one combined matcher covering all three. It selects with all three matcher inputs at once and verifies that four handlers come back, not extra duplicates, in the expected order.

**Call relations**: It calls select_handlers_for_matcher_inputs directly because this is the multi-input case that select_handlers wraps for simpler calls.

*Call graph*: calls 1 internal fn (select_handlers_for_matcher_inputs); 2 external calls (assert_eq!, vec!).


##### `tests::user_prompt_submit_ignores_matcher`  (lines 390–415)

```
fn user_prompt_submit_ignores_matcher()
```

**Purpose**: Checks that user prompt submission hooks are selected even if their matcher is specific or invalid. For this event, matcher text is intentionally ignored.

**Data flow**: The test creates two UserPromptSubmit handlers, one with a normal-looking matcher and one with invalid pattern text. It selects handlers for the event and verifies that both are returned.

**Call relations**: It calls select_handlers to confirm the dispatcher does not try to evaluate matchers for UserPromptSubmit events.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::select_handlers_preserves_declaration_order`  (lines 418–446)

```
fn select_handlers_preserves_declaration_order()
```

**Purpose**: Checks that selected handlers stay in the same order they were configured. Order matters because users may expect hooks to run or display in that sequence.

**Data flow**: The test creates three stop handlers named first, second, and third. It selects stop handlers and verifies that the returned commands are still first, second, and third.

**Call relations**: It calls select_handlers for the Stop event and protects the dispatcher’s promise that filtering does not reorder matching handlers.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


### Lifecycle and prompt hooks
These event handlers cover session and prompt lifecycle moments, including startup, stop mediation, and compaction-related decisions.

### `hooks/src/events/session_start.rs`

`orchestration` · `startup and subagent startup`

A “hook” is an external command the application runs at a chosen moment, like a doorbell that can trigger custom actions when someone enters. This file is responsible for the start-of-session doorbell. It covers two closely related events: starting the main session, and starting a subagent. First it identifies which configured hook commands match the event. Then it builds a JSON message with details such as the session id, working folder, transcript path, model, permission mode, and start reason or agent type. That JSON is sent to each matching command through the hook dispatcher.

After the commands finish, this file translates their results into application-friendly outcomes. Successful plain text output becomes extra context for the model. Well-formed hook JSON can add warnings and context. Bad JSON-looking output is treated as an error rather than being silently fed to the model. For `SessionStart` only, hook JSON can say “continue: false”, which marks the run as stopped and records a reason. `SubagentStart` deliberately ignores that stop signal, so subagent hooks can add context but cannot block the subagent. Without this file, startup hooks would not run, their output would not be interpreted safely, and custom startup checks or context injection would not work.

#### Function details

##### `SessionStartSource::as_str`  (lines 31–38)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns the internal start reason into the short text value that hook configuration and hook input JSON expect. For example, it converts the `Startup` variant into `"startup"`.

**Data flow**: It receives one `SessionStartSource` value → matches it to its named reason → returns a fixed lowercase string. It does not change any state.

**Call relations**: This is used when the start target needs a matcher value and when `run` builds the JSON sent to session-start hook commands. It gives the rest of the hook pipeline a stable text label instead of exposing Rust enum names.


##### `StartHookTarget::event_name`  (lines 64–69)

```
fn event_name(&self) -> HookEventName
```

**Purpose**: Identifies which hook event name applies to the current start target: main session start or subagent start. This lets the dispatcher choose the right configured commands.

**Data flow**: It reads the `StartHookTarget` value → checks whether it is `SessionStart` or `SubagentStart` → returns the matching `HookEventName`. It has no side effects.

**Call relations**: `preview` and `run` call this before asking the dispatcher to select matching handlers. It is the small adapter that connects this file’s start-target type to the shared hook dispatch system.


##### `StartHookTarget::matcher_input`  (lines 71–76)

```
fn matcher_input(&self) -> &str
```

**Purpose**: Provides the extra matching text used to narrow which hooks should run. For a session start this is the start source, and for a subagent start this is the agent type.

**Data flow**: It reads the target → for a session start, converts the source to text; for a subagent start, borrows the agent type text → returns that string slice for matching. It does not modify anything.

**Call relations**: `preview` and `run` pass this value to the dispatcher along with the event name. That allows hook configuration to say things like “only run for resume starts” or “only run for this kind of agent.”


##### `preview`  (lines 94–106)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &SessionStartRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Shows which session-start or subagent-start hooks would run, without actually running their commands. This is useful for displaying planned hook activity to a caller.

**Data flow**: It receives all configured handlers and a start request → asks the dispatcher to select the handlers matching the request’s event and matcher text → converts each selected handler into a “running” summary → returns those summaries. Nothing is executed.

**Call relations**: `preview_session_start` calls this when it needs a dry-run style view. Internally, this function relies on `StartHookTarget::event_name`, `StartHookTarget::matcher_input`, and the dispatcher’s selection and summary helpers.

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

**Purpose**: Runs the matching start hooks and combines their results into one outcome for the caller. It is the main workflow for turning a session-start request into completed hook events, stop decisions, and extra model context.

**Data flow**: It receives configured handlers, a command shell, a start request, and an optional turn id → selects matching hooks → builds the correct JSON input for either session start or subagent start → runs each command through the dispatcher → reads each parsed result → returns the completed hook events, whether the session should stop, the first stop reason, and all added context. If JSON input cannot be serialized, it returns failure hook events instead of running commands.

**Call relations**: `run_session_start` calls this as the public flow for executing start hooks. This function hands matching and command execution to the dispatcher, uses schema types to build hook input, uses `serialization_failure_outcome` if input creation fails, and asks `parse_completed` to interpret each command result after execution.

*Call graph*: calls 7 internal fn (execute_handlers, select_handlers, flatten_additional_contexts, serialization_failure_hook_events, serialization_failure_outcome, from_path, new); called by 1 (run_session_start); 3 external calls (new, format!, to_string).


##### `parse_completed`  (lines 217–335)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<SessionStartHandlerData>
```

**Purpose**: Interprets the result of one finished start hook command. It decides whether the hook succeeded, failed, added model context, produced a warning, or stopped a normal session start.

**Data flow**: It receives the handler that ran, the command’s exit details and output, and an optional turn id → checks for command errors or nonzero exit codes → if successful, parses recognized hook JSON or treats plain text as added context → rejects output that looks like broken JSON → builds a completed hook event plus internal data such as stop flags and context strings → returns that parsed package.

**Call relations**: The dispatcher calls this during `run` after each command finishes, and the tests call it directly to verify edge cases. It delegates JSON interpretation to the output parser, uses common helpers to record extra context, and uses the dispatcher to create the final run summary.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_session_start, parse_subagent_start, append_additional_context); called by 5 (continue_false_preserves_context_for_later_turns, invalid_json_like_stdout_fails_instead_of_becoming_model_context, plain_stdout_becomes_model_context, subagent_start_continue_false_is_ignored, subagent_start_plain_stdout_becomes_model_context); 3 external calls (new, format!, panic!).


##### `serialization_failure_outcome`  (lines 337–344)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> SessionStartOutcome
```

**Purpose**: Builds a safe fallback outcome when the file cannot create the JSON input needed for hook commands. It preserves the failure events but avoids pretending hooks ran successfully.

**Data flow**: It receives already-created failure hook events → wraps them in a `SessionStartOutcome` → sets stopping to false, clears the stop reason, and returns no added context. It does not run any commands.

**Call relations**: `run` calls this when serializing either session-start or subagent-start input fails. It keeps that exceptional path small and consistent with the normal outcome shape.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::plain_stdout_becomes_model_context`  (lines 362–385)

```
fn plain_stdout_becomes_model_context()
```

**Purpose**: Checks that ordinary text printed by a successful session-start hook is treated as extra context for the model. This protects the simple hook author experience: print text, and it becomes context.

**Data flow**: It creates a fake session-start handler and a fake successful command result with stdout → passes them to `parse_completed` → asserts that the parsed data contains the trimmed text as context and that the completed event records a context entry.

**Call relations**: This test calls the local `handler` and `run_result` helpers, then exercises `parse_completed` directly. It verifies one of the main behaviors that `run` relies on after the dispatcher executes hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_preserves_context_for_later_turns`  (lines 388–421)

```
fn continue_false_preserves_context_for_later_turns()
```

**Purpose**: Checks what happens when a session-start hook returns JSON saying the session should stop. It confirms that the stop reason is recorded while the hook’s added context is still preserved.

**Data flow**: It builds a fake successful command result containing session-start JSON with `continue: false`, a stop reason, and additional context → sends it to `parse_completed` → asserts that the parsed data says to stop, keeps the reason, keeps the context, and records both context and stop entries.

**Call relations**: This test uses `handler` and `run_result` to focus only on output parsing. It guards the behavior that only normal session-start hooks can block further processing.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::invalid_json_like_stdout_fails_instead_of_becoming_model_context`  (lines 424–451)

```
fn invalid_json_like_stdout_fails_instead_of_becoming_model_context()
```

**Purpose**: Checks that broken JSON-looking output is treated as a hook error, not as model context. This matters because accidentally feeding malformed control data to the model could hide a hook bug.

**Data flow**: It creates a fake successful command result whose stdout begins like JSON but is invalid → passes it to `parse_completed` → asserts that no context is added and the hook run is marked failed with a clear error message.

**Call relations**: This test calls `handler`, `run_result`, and `parse_completed`. It protects the branch where `parse_completed` asks the output parser whether stdout looks like JSON after parsing fails.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::subagent_start_plain_stdout_becomes_model_context`  (lines 454–478)

```
fn subagent_start_plain_stdout_becomes_model_context()
```

**Purpose**: Checks that a subagent-start hook can add context by printing plain text. It also confirms that the subagent turn id is carried into the completed event.

**Data flow**: It creates a fake subagent-start handler and a successful command result with plain stdout → calls `parse_completed` with a turn id → verifies that the text becomes context, the run is completed, and the completed event keeps that turn id.

**Call relations**: This test uses `handler_for` to make a subagent handler and `run_result` for fake command output. It validates the subagent path that `run` uses when dispatching `SubagentStart` hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler_for, run_result).


##### `tests::subagent_start_continue_false_is_ignored`  (lines 481–509)

```
fn subagent_start_continue_false_is_ignored()
```

**Purpose**: Checks that subagent-start hooks cannot stop processing even if their JSON says `continue: false`. They are allowed to add context, but not to block the subagent.

**Data flow**: It creates a fake subagent-start hook result containing JSON with `continue: false`, a stop reason, and additional context → passes it to `parse_completed` → asserts that stopping is not requested, no stop reason is stored, and the context is still recorded.

**Call relations**: This test calls `handler_for`, `run_result`, and `parse_completed`. It protects the intentional difference between `SessionStart` and `SubagentStart` behavior inside `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler_for, run_result).


##### `tests::handler`  (lines 511–513)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a default fake handler for session-start tests. It saves each test from repeating the same setup.

**Data flow**: It takes no input → calls `handler_for` with the session-start event name → returns the configured fake handler.

**Call relations**: Several tests call this when they need a normal session-start handler. It delegates the actual construction to `tests::handler_for`.

*Call graph*: 1 external calls (handler_for).


##### `tests::handler_for`  (lines 515–527)

```
fn handler_for(event_name: HookEventName) -> ConfiguredHandler
```

**Purpose**: Builds a fake configured hook handler for a chosen event name. Tests use it to simulate either a session-start hook or a subagent-start hook without loading real configuration.

**Data flow**: It receives a hook event name → fills in a `ConfiguredHandler` with a dummy command, timeout, source path, ordering, and empty environment → returns that handler. It uses a test path helper to create an absolute source path.

**Call relations**: `tests::handler` and the subagent tests call this helper. The returned handler is then passed into `parse_completed` so tests can check parsing behavior for different hook event names.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 529–539)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Creates a fake command-run result for tests. This lets tests describe only the exit code and output they care about.

**Data flow**: It receives an optional exit code, stdout text, and stderr text → wraps them with fixed timing values and no execution error → returns a `CommandRunResult` as if a hook command had already run.

**Call relations**: All parser-focused tests use this helper before calling `parse_completed`. It replaces the real command runner so the tests can focus on how completed output is interpreted.


### `hooks/src/events/user_prompt_submit.rs`

`orchestration` · `request handling, when a user prompt is submitted`

A “hook” is a user- or system-configured command that Codex runs at a specific moment, like a checkpoint. This file covers the UserPromptSubmit checkpoint: the moment after the user enters a prompt but before the rest of the turn proceeds. Without it, configured commands would not get a chance to review the prompt, block it for policy or safety reasons, or attach extra background information for the model.

The main flow is simple. First, the file finds all configured handlers that apply to the UserPromptSubmit event. Then it packages the current turn information into JSON: session id, turn id, working directory, model name, permission mode, transcript path, subagent details, and the prompt text itself. That JSON is sent to each matching command through the dispatcher.

When each command finishes, this file interprets the result. A normal text response becomes extra context. A structured JSON response can say “continue,” “stop,” “block,” give a reason, or provide additional context. Exit code 2 is treated specially as a blocking decision, but only if the command writes a reason to standard error. The file then combines all hook results into one outcome: completed hook events for reporting, whether processing should stop, the first stop reason, and all extra context gathered from the hooks.

#### Function details

##### `preview`  (lines 49–61)

```
fn preview(
    handlers: &[ConfiguredHandler],
    _request: &UserPromptSubmitRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Shows which UserPromptSubmit hooks would run, without actually running them. This is useful for displaying planned hook activity before work starts.

**Data flow**: It receives the full list of configured handlers and a request object, though the request contents are not needed here. It filters the handlers down to those for the UserPromptSubmit event, turns each selected handler into a “running” summary, and returns those summaries.

**Call relations**: The higher-level preview_user_prompt_submit flow calls this when it wants a dry-run view. This function relies on select_handlers to choose the relevant hooks, then asks the dispatcher to format each selected hook as a running summary.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_user_prompt_submit).


##### `run`  (lines 63–131)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: UserPromptSubmitRequest,
) -> UserPromptSubmitOutcome
```

**Purpose**: Runs all matching UserPromptSubmit hooks and combines their answers into one decision for the rest of the turn. It is the main entry point in this file for actually executing prompt-submission hooks.

**Data flow**: It receives configured handlers, a command shell for running external commands, and the prompt-submission request. It selects matching hooks, converts the request into JSON, executes each hook command, parses the completed results, and returns a UserPromptSubmitOutcome containing hook reports, whether to stop, a stop reason if any, and extra context strings for the model.

**Call relations**: The higher-level run_user_prompt_submit flow calls this when a prompt has been submitted. This function asks the dispatcher to select and execute handlers, passes parse_completed as the per-command result interpreter, uses common helpers to report serialization failures and combine extra context, and returns the final outcome to its caller.

*Call graph*: calls 7 internal fn (execute_handlers, select_handlers, flatten_additional_contexts, serialization_failure_hook_events, serialization_failure_outcome, from_path, from); called by 1 (run_user_prompt_submit); 3 external calls (new, format!, to_string).


##### `parse_completed`  (lines 133–265)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<UserPromptSubmitHandlerData>
```

**Purpose**: Turns one finished hook command into a clear hook result: completed, failed, blocked, or stopped. It also extracts any message that should be shown to the user and any extra context that should be saved for the model.

**Data flow**: It receives the handler that ran, the raw command result, and the optional turn id. It checks for command errors, exit codes, standard output, and standard error. It parses structured JSON output when present, treats plain successful output as additional context, handles exit code 2 as a block with a required reason, and produces a ParsedHandler containing a completed hook event plus internal data such as should_stop, stop_reason, and collected context.

**Call relations**: The dispatcher uses this function after each executed hook command in the run flow. The unit tests also call it directly to check important edge cases. Inside, it delegates JSON recognition and parsing to output_parser, uses common helpers for context and trimmed text, and asks the dispatcher to build the final completed summary.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_user_prompt_submit, append_additional_context, trimmed_non_empty); called by 4 (claude_block_decision_blocks_processing, claude_block_decision_requires_reason, continue_false_preserves_context_for_later_turns, exit_code_two_blocks_processing); 2 external calls (new, format!).


##### `serialization_failure_outcome`  (lines 267–274)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> UserPromptSubmitOutcome
```

**Purpose**: Builds a safe outcome for the case where Codex cannot turn the hook input into JSON. This lets the caller report the failure without pretending any hook successfully ran.

**Data flow**: It receives already-created hook completion events that describe the serialization failure. It returns a UserPromptSubmitOutcome with those events, no stop request, no stop reason, and no added context.

**Call relations**: The run function calls this only when preparing the JSON input for hook commands fails. The failure events are created by a common helper, and this function wraps them in the same outcome shape used by normal hook execution.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::continue_false_preserves_context_for_later_turns`  (lines 292–325)

```
fn continue_false_preserves_context_for_later_turns()
```

**Purpose**: Checks that a hook can both stop processing and still provide additional context. This protects the behavior where context from a stopped turn is preserved instead of thrown away.

**Data flow**: It creates a fake successful command result whose JSON says continue is false, gives a stop reason, and includes additional context. It passes that into parse_completed, then verifies that the parsed data says to stop, keeps the stop reason, keeps the context, and reports both a context entry and a stop entry.

**Call relations**: This test calls the local handler and run_result helpers to build test inputs, then calls parse_completed directly. It uses assertions to lock down how parse_completed should behave for a stop response with context.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::claude_block_decision_blocks_processing`  (lines 328–361)

```
fn claude_block_decision_blocks_processing()
```

**Purpose**: Checks that a structured block decision from a hook really blocks the prompt. It also verifies that extra context is still recorded alongside the blocking feedback.

**Data flow**: It builds a fake command result with JSON saying the decision is block, the reason is “slow down,” and additional context is present. After parse_completed runs, the test confirms that processing should stop, the reason is saved, the status is Blocked, and the output entries include both context and feedback.

**Call relations**: This test exercises parse_completed directly, using the test helper functions for a sample handler and command result. It protects the block-decision branch used when hooks return structured JSON.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::claude_block_decision_requires_reason`  (lines 364–392)

```
fn claude_block_decision_requires_reason()
```

**Purpose**: Checks that a hook is not allowed to block without explaining why. This prevents silent blocking, which would be confusing to users and callers.

**Data flow**: It creates a fake successful command result whose JSON says decision is block but does not include a non-empty reason. It passes that into parse_completed and verifies that the result is a failure, does not stop processing through the normal block path, and reports an error message.

**Call relations**: This test calls parse_completed with helper-built inputs. It confirms that parse_completed rejects malformed block decisions instead of treating them as valid policy feedback.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_blocks_processing`  (lines 395–418)

```
fn exit_code_two_blocks_processing()
```

**Purpose**: Checks the shortcut rule that exit code 2 means the hook wants to block the prompt, as long as it writes a reason to standard error. This supports simple hook scripts that do not emit structured JSON.

**Data flow**: It builds a fake command result with exit code 2 and standard error text saying “blocked by policy.” It passes that into parse_completed and verifies that processing should stop, the reason is saved, the status is Blocked, and the feedback entry contains the trimmed reason.

**Call relations**: This test calls parse_completed directly with inputs from the local helpers. It protects the special exit-code behavior that parse_completed uses for simple blocking hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::handler`  (lines 420–432)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a sample configured UserPromptSubmit hook for the tests. It keeps the test setup short and consistent.

**Data flow**: It builds and returns a ConfiguredHandler with the UserPromptSubmit event name, a simple command string, a timeout, a fake source path, and default fields such as no matcher and an empty environment.

**Call relations**: The tests call this helper whenever they need a handler to pass into parse_completed. It uses the test path helper to create a stable fake hooks configuration path.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 434–444)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Creates a sample command result for the tests. It lets each test focus on the exit code and output text that matter for that scenario.

**Data flow**: It receives an optional exit code, standard output text, and standard error text. It returns a CommandRunResult with fixed timing fields, those supplied outputs, and no command-level error.

**Call relations**: The tests call this helper before calling parse_completed. It provides controlled command results so each test can check one parsing rule at a time.


### `hooks/src/events/stop.rs`

`domain_logic` · `end-of-turn hook execution`

A hook is an outside command that the system calls at a specific moment, like ringing a doorbell before leaving a room. This file covers the moment when work is about to stop. It supports two related events: a normal Stop event and a SubagentStop event for a smaller helper agent.

First, it can preview which configured hook commands would run for a given stop request. When actually running, it selects matching hooks, builds a JSON message describing the session, current folder, model, permission mode, transcript paths, and last assistant message, then sends that JSON to each hook command through the shared dispatcher.

The most important part is interpreting what the hook command says back. A hook can allow stopping, request that processing stop immediately with a reason, or block the stop and provide feedback such as “retry with tests.” That feedback is turned into continuation prompt fragments so the assistant can keep going with specific instructions. The file is strict about malformed output: invalid JSON, missing reasons for block decisions, failed commands, or strange exit codes become failed hook runs rather than silent guesses.

If several hooks run, their results are combined. A stop decision wins over block decisions. If nothing stops but one or more hooks block, their feedback is joined in declaration order.

#### Function details

##### `StopHookTarget::event_name`  (lines 47–52)

```
fn event_name(&self) -> HookEventName
```

**Purpose**: This chooses the protocol event name that matches the kind of stop being processed. It lets the rest of the hook system treat a normal assistant stop and a subagent stop as two distinct hook events.

**Data flow**: It reads the StopHookTarget value. If the target is a normal stop, it returns the Stop event name; if it is a subagent stop, it returns the SubagentStop event name. Nothing else is changed.

**Call relations**: The preview and run flows call this before selecting handlers, so the dispatcher only considers hook commands registered for the correct stop event.


##### `StopHookTarget::matcher_input`  (lines 54–59)

```
fn matcher_input(&self) -> Option<&str>
```

**Purpose**: This provides the optional matching text used to narrow down which stop hooks apply. For subagent stops, the agent type can be used as the match key; for normal stops, there is no extra match key.

**Data flow**: It reads the StopHookTarget value. A normal stop produces no matcher input, while a subagent stop produces the agent type as text. It only returns a borrowed view of existing data.

**Call relations**: The preview and run flows pass this to the dispatcher together with the event name, so configured handlers can be filtered before any command is run.


##### `preview`  (lines 81–93)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &StopRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: This answers the question, “Which stop hooks would run for this request?” without actually running any external commands. It is useful for showing planned hook activity to callers or user interfaces.

**Data flow**: It receives the full list of configured handlers and a stop request. It asks the dispatcher to select only the handlers matching the request’s stop event and optional matcher input, then converts each selected handler into a running summary. It returns those summaries and does not change the request or handlers.

**Call relations**: This is called by the higher-level preview_stop flow. It relies on StopHookTarget::event_name and StopHookTarget::matcher_input indirectly through the request, then hands selection work to the dispatcher.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_stop).


##### `run`  (lines 95–200)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: StopRequest,
) -> StopOutcome
```

**Purpose**: This is the main worker for stop hooks. It selects the right hook commands, sends them a JSON description of the stop moment, waits for their results, and returns the combined decision.

**Data flow**: It receives configured handlers, a command shell used to run external commands, and a StopRequest. It filters matching handlers; if none match, it returns an empty outcome. Otherwise it builds the correct JSON input for either Stop or SubagentStop, runs the selected commands in the request’s working directory, parses each completed command, combines their decisions, and returns hook event records plus final flags such as should_stop or should_block.

**Call relations**: This is called by the higher-level run_stop flow. It uses the dispatcher to select and execute hook commands, uses parse_completed as the callback that understands each command’s output, and uses aggregate_results to turn many hook answers into one final StopOutcome. If JSON input cannot be created, it asks common hook code to create failure events and wraps them with serialization_failure_outcome.

*Call graph*: calls 7 internal fn (execute_handlers, select_handlers, serialization_failure_hook_events, aggregate_results, serialization_failure_outcome, from_path, from_string); called by 1 (run_stop); 3 external calls (new, format!, to_string).


##### `parse_completed`  (lines 202–371)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<StopHandlerData>
```

**Purpose**: This translates one finished hook command into a structured result the system can trust. It decides whether that hook completed normally, failed, stopped processing, or blocked stopping with feedback.

**Data flow**: It receives the handler that ran, the command’s exit information, and an optional turn id. It inspects command errors, exit code, standard output, and standard error. For successful commands, it parses event-specific JSON from standard output. For exit code 2, it treats non-empty standard error as feedback to continue. It returns a completed hook event plus StopHandlerData showing stop/block decisions and any continuation prompt fragments.

**Call relations**: The dispatcher calls this after each hook command finishes during run. The tests call it directly to check edge cases. Inside, it uses the output parser for Stop or SubagentStop JSON, shared text trimming for reasons, and dispatcher summary creation so the final event log has consistent status and entries.

*Call graph*: calls 4 internal fn (completed_summary, parse_stop, parse_subagent_stop, trimmed_non_empty); called by 7 (block_decision_with_blank_reason_fails_instead_of_blocking, block_decision_with_reason_sets_continuation_prompt, block_decision_without_reason_is_invalid, continue_false_overrides_block_decision, exit_code_two_uses_stderr_feedback_only, exit_code_two_without_stderr_does_not_block, invalid_stdout_fails_instead_of_silently_nooping); 4 external calls (new, format!, panic!, unreachable!).


##### `aggregate_results`  (lines 373–407)

```
fn aggregate_results(
    results: impl IntoIterator<Item = &'a StopHandlerData>,
) -> StopHandlerData
```

**Purpose**: This combines several individual hook decisions into one overall decision. It defines the priority rule: any stop decision wins; otherwise, block decisions are collected together.

**Data flow**: It receives a collection of StopHandlerData values. It checks whether any hook requested stopping, takes the first stop reason if present, and only considers blocking if nothing requested stopping. If blocking applies, it joins all block reasons and gathers all continuation fragments from blocking hooks. It returns one combined StopHandlerData value.

**Call relations**: The run function calls this after all selected hooks have finished. A test also calls it directly to confirm that multiple block reasons are joined in declaration order.

*Call graph*: calls 1 internal fn (join_text_chunks); called by 2 (run, aggregate_results_concatenates_blocking_reasons_in_declaration_order); 3 external calls (into_iter, iter, new).


##### `serialization_failure_outcome`  (lines 409–418)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> StopOutcome
```

**Purpose**: This creates a safe stop outcome for the rare case where the system cannot turn the request into JSON for a hook command. It records the failure events but does not stop or block the assistant.

**Data flow**: It receives already-created hook completion events that describe the serialization failure. It wraps them in a StopOutcome with all decision flags set to false and no continuation fragments. It does not inspect or modify the events.

**Call relations**: The run function calls this after common serialization-failure reporting has produced hook events. It is the final fallback path before returning to the higher-level stop runner.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::block_decision_with_reason_sets_continuation_prompt`  (lines 439–464)

```
fn block_decision_with_reason_sets_continuation_prompt()
```

**Purpose**: This test checks the happy path for a hook that blocks stopping and gives a useful reason. It proves that the reason becomes both the block reason and the continuation prompt sent back to the assistant.

**Data flow**: It builds a fake handler and a fake successful command result whose output says to block with the reason “retry with tests.” It passes them into parse_completed and compares the parsed data and run status with the expected blocked result.

**Call relations**: This test exercises parse_completed directly, using the local handler and run_result helpers to avoid running a real external command.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::block_decision_without_reason_is_invalid`  (lines 467–483)

```
fn block_decision_without_reason_is_invalid()
```

**Purpose**: This test checks that a hook cannot block stopping without explaining why. That matters because the assistant needs feedback in order to continue usefully.

**Data flow**: It creates a fake successful hook output with a block decision but no reason. After parse_completed reads it, the test expects no block decision to be recorded and expects the hook run to be marked failed with a clear error message.

**Call relations**: This test calls parse_completed directly and confirms the validation rule used during real hook execution.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_overrides_block_decision`  (lines 486–508)

```
fn continue_false_overrides_block_decision()
```

**Purpose**: This test checks the priority rule inside one hook response: an explicit request to stop overrides a block decision in the same output. It prevents mixed messages from being treated as a request to continue.

**Data flow**: It feeds parse_completed a fake output containing continue:false, a stop reason, and also a block decision. The parsed result is expected to request stopping, keep the stop reason, and produce no block reason or continuation prompt.

**Call relations**: This test calls parse_completed with local fake data. It documents the same priority rule that aggregate_results applies across multiple hooks: stopping wins over blocking.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_uses_stderr_feedback_only`  (lines 511–532)

```
fn exit_code_two_uses_stderr_feedback_only()
```

**Purpose**: This test checks the legacy or alternate signal where a hook exits with code 2 to block stopping. In that case, standard error is treated as the feedback text.

**Data flow**: It creates a fake command result with exit code 2, ignored standard output, and standard error containing “retry with tests.” After parse_completed runs, the test expects a blocked status, that reason as feedback, and a continuation prompt fragment.

**Call relations**: This test calls parse_completed directly and verifies the special exit-code path used during real hook execution.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_without_stderr_does_not_block`  (lines 535–553)

```
fn exit_code_two_without_stderr_does_not_block()
```

**Purpose**: This test checks that exit code 2 is not enough by itself to block stopping. The hook must also provide non-empty feedback text.

**Data flow**: It feeds parse_completed a fake command result with exit code 2 and blank standard error. The parsed result should stay at the default no-decision state, while the completed run should be marked failed with an explanatory error.

**Call relations**: This test directly exercises parse_completed’s validation for the exit-code-2 blocking path.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::block_decision_with_blank_reason_fails_instead_of_blocking`  (lines 556–572)

```
fn block_decision_with_blank_reason_fails_instead_of_blocking()
```

**Purpose**: This test checks that whitespace does not count as a real block reason. It protects the assistant from being asked to continue without meaningful instructions.

**Data flow**: It sends parse_completed a fake successful JSON response with decision:block and a reason made only of spaces. The result should not block, and the hook run should be marked failed with the same missing-reason error used when the reason is absent.

**Call relations**: This test calls parse_completed directly and relies on the same trimming behavior used in production.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::invalid_stdout_fails_instead_of_silently_nooping`  (lines 575–591)

```
fn invalid_stdout_fails_instead_of_silently_nooping()
```

**Purpose**: This test checks that malformed hook output is treated as a failure rather than ignored. That makes hook problems visible instead of silently changing behavior.

**Data flow**: It creates a fake successful command result whose standard output is not valid JSON. parse_completed should return default decision data and a completed run marked failed with an invalid-output error.

**Call relations**: This test directly exercises parse_completed’s parsing-failure branch for normal Stop hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::aggregate_results_concatenates_blocking_reasons_in_declaration_order`  (lines 594–629)

```
fn aggregate_results_concatenates_blocking_reasons_in_declaration_order()
```

**Purpose**: This test checks how feedback from several blocking hooks is combined. It confirms that reasons keep their configured order and are separated clearly.

**Data flow**: It creates two StopHandlerData values that both block with different reasons and prompt fragments. It passes them to aggregate_results and expects one blocked result with the reasons joined as “first”, blank line, “second”, plus both prompt fragments preserved.

**Call relations**: This test calls aggregate_results directly, covering the same combining step that run uses after all hook commands finish.

*Call graph*: calls 1 internal fn (aggregate_results); 2 external calls (assert_eq!, vec!).


##### `tests::handler`  (lines 631–643)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: This helper builds a sample configured Stop hook for the tests. It gives parse_completed enough handler metadata to create realistic completed-run summaries.

**Data flow**: It takes no input. It returns a ConfiguredHandler with the Stop event name, a dummy command, a timeout, a fake source path, and other fixed fields. It does not run the command.

**Call relations**: Several tests call this helper before calling parse_completed, so they can focus on output parsing behavior instead of repeating setup data.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 645–655)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: This helper builds a fake command result for the tests. It lets tests describe only the exit code, standard output, and standard error that matter for parsing.

**Data flow**: It receives an optional exit code, stdout text, and stderr text. It returns a CommandRunResult with fixed timing values, those supplied streams, and no command-level error.

**Call relations**: The parse_completed tests call this helper to simulate different hook command outcomes without launching real processes.


### `hooks/src/events/compact.rs`

`orchestration` · `during pre- and post-compaction hook handling`

This file is the bridge between the compaction lifecycle and external hook commands. A hook is a user-configured command that Codex runs at a certain event, like “before compaction” or “after compaction.” Without this file, those commands would not receive the right context, their results would not be interpreted, and a hook would not be able to pause or stop compaction-related work.

The flow is much like giving a stage crew a cue sheet. First, the file finds which configured hook commands match the event: PreCompact or PostCompact, plus the specific trigger such as a manual compaction. Preview functions report what would run. Run functions actually build a JSON message with details like session id, turn id, current folder, model, transcript path, subagent information, and trigger. That JSON is handed to the dispatcher, which starts each command in the chosen shell.

After a command finishes, this file turns the raw result into a clear hook event. It records failures, non-zero exit codes, missing exit codes, warning messages, and stop requests. Plain text output is ignored unless it looks like structured JSON. For PreCompact and PostCompact, a hook can return “continue: false” to stop later processing and optionally explain why.

#### Function details

##### `preview_pre`  (lines 58–70)

```
fn preview_pre(
    handlers: &[ConfiguredHandler],
    request: &PreCompactRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Shows which PreCompact hook commands would run for this request, without actually running them. This is useful when the system wants to display planned hook activity before doing the work.

**Data flow**: It receives the full list of configured handlers and a pre-compaction request. It filters that list to handlers for the PreCompact event and the request’s trigger, then turns each matching handler into a short running summary. The result is a list of summaries and no outside state is changed.

**Call relations**: A higher-level preview flow, preview_pre_compact, calls this when it needs to explain upcoming pre-compaction hook work. This function asks the dispatcher to choose matching handlers, then asks the dispatcher to format each one as a running summary.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_pre_compact).


##### `run_pre`  (lines 72–123)

```
async fn run_pre(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PreCompactRequest,
) -> PreCompactOutcome
```

**Purpose**: Runs all matching PreCompact hooks and reports whether any of them asked the system to stop before compaction. It is the main execution path for hooks that happen before compaction.

**Data flow**: It receives configured handlers, a command shell, and a pre-compaction request. It selects matching handlers; if there are none, it returns an empty successful outcome. Otherwise it converts the request into JSON, runs the handlers in the request’s working directory, parses each completed command, and returns completed hook events plus a combined stop decision and reason.

**Call relations**: run_pre_compact calls this when pre-compaction hooks need to actually run. This function relies on pre_command_input_json to build the command input, dispatcher::execute_handlers to start commands, and parse_pre_completed to interpret each command’s result. If JSON creation fails, it uses common::serialization_failure_hook_events to turn that failure into hook events instead of crashing the flow.

*Call graph*: calls 4 internal fn (execute_handlers, select_handlers, serialization_failure_hook_events, pre_command_input_json); called by 1 (run_pre_compact); 2 external calls (new, format!).


##### `pre_command_input_json`  (lines 125–138)

```
fn pre_command_input_json(request: &PreCompactRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Builds the JSON input sent to a PreCompact hook command. This gives the external command enough context to know what session, turn, model, folder, trigger, and optional subagent it is being run for.

**Data flow**: It receives a PreCompactRequest. It pulls out subagent fields if present, converts the optional transcript path into the schema’s nullable string form, formats IDs and paths as strings, and serializes everything into one JSON string. It returns either that string or a serialization error.

**Call relations**: run_pre calls this just before executing hook commands. The test tests::pre_compact_input_includes_lifecycle_metadata also calls it to make sure the hook receives the expected lifecycle metadata.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run_pre, pre_compact_input_includes_lifecycle_metadata); 1 external calls (to_string).


##### `preview_post`  (lines 140–152)

```
fn preview_post(
    handlers: &[ConfiguredHandler],
    request: &PostCompactRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Shows which PostCompact hook commands would run for this request, without running them. It is the post-compaction counterpart to preview_pre.

**Data flow**: It receives configured handlers and a post-compaction request. It filters handlers to the PostCompact event and the request’s trigger, then converts each match into a summary. It returns those summaries without changing anything else.

**Call relations**: preview_post_compact calls this during the preview path for post-compaction hooks. The function delegates matching and summary formatting to the dispatcher.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_post_compact).


##### `run_post`  (lines 154–205)

```
async fn run_post(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PostCompactRequest,
) -> StatelessHookOutcome
```

**Purpose**: Runs all matching PostCompact hooks and reports whether any hook asked later processing to stop. This is used after compaction has already happened.

**Data flow**: It receives configured handlers, a shell, and a post-compaction request. It selects matching handlers; if none match, it returns an empty outcome. If handlers match, it serializes the request to JSON, runs the commands in the request’s current directory, parses their results, and returns completed hook events plus any stop request and reason.

**Call relations**: run_post_compact calls this when post-compaction hooks need to execute. It uses post_command_input_json for the command input, dispatcher::execute_handlers for running commands, and parse_post_completed for interpreting results. If input serialization fails, it reports that through common::serialization_failure_hook_events.

*Call graph*: calls 4 internal fn (execute_handlers, select_handlers, serialization_failure_hook_events, post_command_input_json); called by 1 (run_post_compact); 2 external calls (new, format!).


##### `post_command_input_json`  (lines 207–220)

```
fn post_command_input_json(request: &PostCompactRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Builds the JSON input sent to a PostCompact hook command. It packages the same kind of lifecycle information as the pre-compaction input, but labels the event as PostCompact.

**Data flow**: It receives a PostCompactRequest. It extracts subagent data if present, converts paths and IDs into strings, includes model and trigger information, and serializes the full command input as JSON. It returns the JSON string or an error if serialization fails.

**Call relations**: run_post calls this before launching post-compaction hook commands. The test tests::post_compact_input_includes_lifecycle_metadata calls it to verify the shape of the JSON sent to hooks.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run_post, post_compact_input_includes_lifecycle_metadata); 1 external calls (to_string).


##### `parse_pre_completed`  (lines 228–313)

```
fn parse_pre_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<CompactHandlerData>
```

**Purpose**: Turns the raw result of one PreCompact hook command into a structured completed hook event. It also detects whether the hook asked the system to stop before compaction.

**Data flow**: It receives the handler that ran, the command’s stdout, stderr, exit code, timing, and possible launch error, plus the turn id. If the command failed to start, exited badly, or returned invalid PreCompact JSON, it records a failure entry. If it returned valid hook JSON with a warning, it records that warning. If it returned continue:false, it marks the run as stopped, saves the stop reason, and creates a stop entry. It returns a parsed handler result containing the user-visible completed event and the internal stop data.

**Call relations**: dispatcher::execute_handlers uses this as the parser supplied by run_pre. Several tests call it directly to confirm important behavior: unsupported block decisions fail, continue:false stops the flow, and ordinary plain stdout is ignored.

*Call graph*: calls 4 internal fn (completed_summary, looks_like_json, parse_pre_compact, trimmed_non_empty); called by 3 (block_decision_is_not_supported_for_pre_compact, continue_false_stops_before_compaction, pre_compact_ignores_plain_stdout); 1 external calls (new).


##### `parse_post_completed`  (lines 315–327)

```
fn parse_post_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<CompactHandlerData>
```

**Purpose**: Turns the raw result of one PostCompact hook command into a structured completed hook event. It is a thin wrapper that supplies the PostCompact label and parser to the shared parsing helper.

**Data flow**: It receives a handler, command result, and optional turn id. It forwards those values to parse_completed along with the PostCompact event label and the post-compaction output parser. It returns the parsed hook result produced by the shared helper.

**Call relations**: dispatcher::execute_handlers uses this through run_post. The tests for post-compaction stopping and plain stdout call it directly. Internally it hands the real interpretation work to parse_completed.

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

**Purpose**: Provides the shared parsing rules for stateless compact hooks, currently used by PostCompact. It converts process results into user-facing hook status, warnings, errors, and stop decisions.

**Data flow**: It receives the handler, the command’s raw result, an optional turn id, an event label, and a function that knows how to parse that event’s JSON output. It checks for launch errors, exit codes, stdout, stderr, valid hook JSON, invalid JSON-looking output, warning messages, and continue:false stop requests. It returns a parsed handler result with a completed event and compact hook data saying whether processing should stop.

**Call relations**: parse_post_completed calls this to avoid duplicating the general compact-hook parsing logic. It calls completed_summary to build the final run summary and uses helper functions to recognize JSON-looking output and trim useful error text from stderr.

*Call graph*: calls 3 internal fn (completed_summary, looks_like_json, trimmed_non_empty); called by 1 (parse_post_completed); 2 external calls (new, format!).


##### `tests::pre_compact_input_includes_lifecycle_metadata`  (lines 438–455)

```
fn pre_compact_input_includes_lifecycle_metadata()
```

**Purpose**: Checks that PreCompact hook input JSON contains the expected lifecycle details. This protects the contract that external hook commands rely on.

**Data flow**: It builds a sample pre-compaction request, serializes it with pre_command_input_json, parses the JSON back into a generic value, and compares it with the exact expected fields. Nothing is returned; the test passes or fails.

**Call relations**: This test calls pre_command_input_json and tests::pre_request. It confirms that the JSON-building helper used by run_pre includes session, turn, folder, event name, model, trigger, and transcript path information.

*Call graph*: calls 1 internal fn (pre_command_input_json); 3 external calls (assert_eq!, pre_request, from_str).


##### `tests::post_compact_input_includes_lifecycle_metadata`  (lines 458–475)

```
fn post_compact_input_includes_lifecycle_metadata()
```

**Purpose**: Checks that PostCompact hook input JSON contains the expected lifecycle details. It makes sure post-compaction hooks receive the same essential context as pre-compaction hooks, with the correct event name.

**Data flow**: It creates a sample post-compaction request, serializes it with post_command_input_json, parses the JSON, and compares it against the expected object. The output is the test result.

**Call relations**: This test calls post_command_input_json and tests::post_request. It guards the input contract used by run_post before hook commands are launched.

*Call graph*: calls 1 internal fn (post_command_input_json); 3 external calls (assert_eq!, post_request, from_str).


##### `tests::block_decision_is_not_supported_for_pre_compact`  (lines 478–497)

```
fn block_decision_is_not_supported_for_pre_compact()
```

**Purpose**: Verifies that a PreCompact hook cannot use a block-style decision response. This matters because this hook type uses the universal continue/stop format instead.

**Data flow**: It creates a fake successful command result whose stdout contains JSON with decision:block. It sends that through parse_pre_completed and checks that the parsed run is marked failed with an invalid PreCompact JSON error. The test produces no normal value; it passes if the assertions hold.

**Call relations**: This test calls tests::handler and tests::run_result to build the inputs, then calls parse_pre_completed. It documents a boundary in the PreCompact hook output format.

*Call graph*: calls 1 internal fn (parse_pre_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_stops_before_compaction`  (lines 500–517)

```
fn continue_false_stops_before_compaction()
```

**Purpose**: Verifies that a PreCompact hook can stop processing by returning continue:false. This is the safety valve that lets a hook prevent compaction from going ahead.

**Data flow**: It creates a fake successful command result with JSON saying continue:false and a stop reason. It parses that result and checks that the status is stopped, should_stop is true, the reason is saved, and the completed event contains a stop entry.

**Call relations**: This test calls tests::handler, tests::run_result, and parse_pre_completed. It proves the stop signal that run_pre later aggregates is correctly extracted from one hook result.

*Call graph*: calls 1 internal fn (parse_pre_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::post_compact_continue_false_stops_after_compaction`  (lines 520–544)

```
fn post_compact_continue_false_stops_after_compaction()
```

**Purpose**: Verifies that a PostCompact hook can ask later processing to stop by returning continue:false. Even though compaction already happened, the system can still pause the surrounding flow.

**Data flow**: It creates a fake successful post-compaction command result with continue:false and a stop reason. It parses the result and checks that the parsed status, stop flag, saved reason, and stop output entry all match expectations.

**Call relations**: This test calls tests::handler, tests::run_result, and parse_post_completed. It confirms that parse_post_completed and its shared helper parse post-compaction stop requests correctly.

*Call graph*: calls 1 internal fn (parse_post_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::pre_compact_ignores_plain_stdout`  (lines 547–556)

```
fn pre_compact_ignores_plain_stdout()
```

**Purpose**: Verifies that ordinary text printed by a PreCompact hook is ignored when it is not structured hook JSON. This lets hook scripts log simple messages without accidentally creating warnings or errors.

**Data flow**: It creates a fake successful command result with plain stdout text. It parses it as a PreCompact result and checks that the status remains completed and there are no output entries.

**Call relations**: This test calls tests::handler, tests::run_result, and parse_pre_completed. It protects the parsing rule used when run_pre processes real hook command output.

*Call graph*: calls 1 internal fn (parse_pre_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::post_compact_ignores_plain_stdout`  (lines 559–568)

```
fn post_compact_ignores_plain_stdout()
```

**Purpose**: Verifies that ordinary text printed by a PostCompact hook is ignored when it is not structured hook JSON. This keeps casual logging separate from hook control messages.

**Data flow**: It creates a fake successful post-compaction command result with plain stdout. It parses it and checks that the run is completed with no entries.

**Call relations**: This test calls tests::handler, tests::run_result, and parse_post_completed. It confirms the same plain-output behavior for the post-compaction parser.

*Call graph*: calls 1 internal fn (parse_post_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::pre_request`  (lines 570–581)

```
fn pre_request() -> super::PreCompactRequest
```

**Purpose**: Builds a sample PreCompactRequest for tests. It keeps repeated test setup short and consistent.

**Data flow**: It creates fixed values for a session id, turn id, no subagent, current directory, no transcript path, model name, and manual trigger. It returns a ready-to-use PreCompactRequest.

**Call relations**: The pre-compaction input JSON test calls this helper. It supplies predictable request data so the expected JSON can be compared exactly.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (test_path_buf).


##### `tests::post_request`  (lines 583–594)

```
fn post_request() -> super::PostCompactRequest
```

**Purpose**: Builds a sample PostCompactRequest for tests. It mirrors tests::pre_request but uses a post-compaction request type and a different fixed session id.

**Data flow**: It creates a fixed post-compaction request with session id, turn id, no subagent, test current directory, no transcript path, model name, and manual trigger. It returns that request.

**Call relations**: The post-compaction input JSON test calls this helper. It provides stable input for checking post_command_input_json.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (test_path_buf).


##### `tests::handler`  (lines 596–608)

```
fn handler(event_name: HookEventName) -> ConfiguredHandler
```

**Purpose**: Builds a sample configured hook handler for tests. It represents a user hook command without needing to load a real hooks file.

**Data flow**: It receives the hook event name to use. It fills in a command, timeout, status message, source path, source type, display order, and empty environment map, then returns a ConfiguredHandler.

**Call relations**: Parser tests call this helper before calling parse_pre_completed or parse_post_completed. It gives those parser functions enough handler metadata to build completed hook summaries.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 610–620)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Builds a fake command execution result for tests. It lets tests simulate different hook outputs and exit codes without running an actual external process.

**Data flow**: It receives an optional exit code, stdout text, and stderr text. It combines them with fixed timing values and no launch error, then returns a CommandRunResult.

**Call relations**: The parser tests call this helper to feed controlled command results into parse_pre_completed and parse_post_completed. This makes each test focus on parsing behavior instead of process execution.


### Tool and permission hooks
These event handlers mediate tool execution and approval requests, aggregating hook outputs into blocking, context, and allow-deny outcomes.

### `hooks/src/events/pre_tool_use.rs`

`orchestration` · `request handling, immediately before a tool call is executed`

This file is the checkpoint before the agent uses a tool, such as running a shell command or calling another service. Think of it like a security guard at a workshop door: before a tool is handed over, configured checks can look at the request and say “go ahead,” “do not do that,” “remember this extra note,” or “use this changed input instead.”

The main input is a PreToolUseRequest. It carries the session and turn identifiers, the current folder, the model name, the permission mode, the tool name, the tool call id, and the tool’s JSON input. The main output is a PreToolUseOutcome. It reports which hook commands ran, whether the tool should be blocked, why it was blocked, any extra context to give back to the model, and any rewritten tool input.

The flow is simple. First, the file finds configured hook handlers whose matcher fits the tool name or one of its aliases. Then it turns the request into JSON and sends that JSON to each selected hook command. When commands finish, it reads their exit codes and output. Exit code 2 with a message means “block.” Valid hook JSON can also deny the tool, add context, or provide updated input. If several hooks rewrite the input, the rewrite from the hook that finished last wins. If any hook blocks the call, rewrites are ignored.

#### Function details

##### `preview`  (lines 54–69)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &PreToolUseRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Shows which pre-tool-use hooks would run for a given tool call, without actually running them. This is useful for reporting planned hook activity to the rest of the system.

**Data flow**: It receives configured handlers and a tool-use request. It builds the possible matcher names from the real tool name and aliases, selects handlers for the PreToolUse event, then turns each selected handler into a run summary tied to the specific tool use id. It returns those summaries and changes nothing else.

**Call relations**: Higher-level preview code calls this when it wants to display pending hook runs. Internally it relies on shared matcher-building logic and the dispatcher’s handler selection, then wraps each selected run with tool-use-specific identity information.

*Call graph*: calls 2 internal fn (select_handlers_for_matcher_inputs, matcher_inputs); called by 3 (preview_pre_tool_use, preview_and_completed_run_ids_include_tool_use_id, serialization_failure_run_ids_include_tool_use_id).


##### `run`  (lines 71–142)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PreToolUseRequest,
) -> PreToolUseOutcome
```

**Purpose**: Runs all matching pre-tool-use hooks and combines their answers into one decision about the tool call. This is the main function that decides whether the tool proceeds, is blocked, gets extra model context, or receives rewritten input.

**Data flow**: It receives configured handlers, a command shell used to execute hook commands, and the full request. It selects matching handlers, serializes the request into JSON, runs the handlers, parses each result, combines block decisions and extra context, and chooses the latest completed input rewrite unless the tool was blocked. It returns a PreToolUseOutcome containing completed hook events and the final decision.

**Call relations**: The broader hook engine calls this from the pre-tool-use runner. It hands selection to the dispatcher, input building to command_input_json, result interpretation to parse_completed through the dispatcher, context flattening to shared common code, and rewrite selection to latest_updated_input.

*Call graph*: calls 8 internal fn (execute_handlers, select_handlers_for_matcher_inputs, flatten_additional_contexts, matcher_inputs, serialization_failure_hook_events_for_tool_use, command_input_json, latest_updated_input, serialization_failure_outcome); called by 1 (run_pre_tool_use); 2 external calls (new, format!).


##### `latest_updated_input`  (lines 148–162)

```
fn latest_updated_input(
    results: &[dispatcher::ParsedHandler<PreToolUseHandlerData>],
) -> Option<Value>
```

**Purpose**: Chooses which rewritten tool input should be used when more than one hook suggests a rewrite. The rule is that the hook that actually finished last wins.

**Data flow**: It receives parsed hook results. It looks only at results that contain an updated input, pairs each rewrite with that hook’s completion order, and picks the rewrite with the highest completion order. It returns that JSON value, or nothing if no hook rewrote the input.

**Call relations**: run calls this after all matching hooks have finished. It exists because reporting stays in configured order, but rewrite conflicts are resolved by completion order.

*Call graph*: called by 1 (run); 1 external calls (iter).


##### `command_input_json`  (lines 170–186)

```
fn command_input_json(request: &PreToolUseRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Builds the JSON text that is sent to a pre-tool-use hook on standard input. It gives the hook enough context to make a policy decision or rewrite the tool input.

**Data flow**: It receives a PreToolUseRequest. It copies fields such as session id, turn id, current folder, model, permission mode, canonical tool name, tool input, and tool use id into the schema expected by hook commands, then serializes that structure into a JSON string. It returns either the JSON text or a serialization error.

**Call relations**: run calls this before executing selected hooks. The tests also call it directly to ensure the JSON uses the request’s real tool name, not an internal matcher alias.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run, command_input_uses_request_tool_name); 1 external calls (to_string).


##### `parse_completed`  (lines 188–303)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<PreToolUseHandlerData>
```

**Purpose**: Turns the raw result of one hook command into a structured hook completion event and the decision data needed by the caller. It is where exit codes, standard output, and standard error become meanings like completed, failed, or blocked.

**Data flow**: It receives the handler that ran, the command’s exit code and output, and an optional turn id. If the command failed to run, it records an error. If it exited successfully, it tries to parse meaningful pre-tool-use JSON from standard output; valid output can add warnings, context, blocking feedback, or updated input. Exit code 2 blocks only if standard error contains a reason. Other bad exits become failures. It returns a parsed handler containing the completed event, extracted decision data, and a placeholder completion order that the dispatcher later fills in.

**Call relations**: The dispatcher calls this after each hook command finishes during run. Many tests call it directly because it contains the important contract between hook command output and system behavior.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_pre_tool_use, append_additional_context, trimmed_non_empty); called by 13 (additional_context_is_recorded, deprecated_approve_decision_fails_open, deprecated_block_decision_blocks_processing, deprecated_block_decision_with_additional_context_blocks_processing, exit_code_two_blocks_processing, invalid_json_like_stdout_fails_instead_of_becoming_noop, last_completed_updated_input_wins, permission_decision_allow_can_update_input, permission_decision_allow_without_updated_input_fails_open, permission_decision_deny_blocks_processing (+3 more)); 2 external calls (new, format!).


##### `serialization_failure_outcome`  (lines 305–313)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> PreToolUseOutcome
```

**Purpose**: Builds a safe default outcome when the system cannot serialize the hook input JSON. It records the failure events but does not block the tool by itself.

**Data flow**: It receives hook completion events that describe serialization failure. It puts them into a PreToolUseOutcome with no block, no reason, no extra context, and no updated input. The returned outcome lets the caller report the failure while continuing without a hook decision.

**Call relations**: run calls this only after command_input_json fails. The failure events themselves are built by shared common hook-reporting code.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::command_input_uses_request_tool_name`  (lines 336–345)

```
fn command_input_uses_request_tool_name()
```

**Purpose**: Checks that hook input JSON contains the canonical tool name from the request. This prevents internal aliases used for matching from leaking into audit or policy data.

**Data flow**: It creates a sample request, changes its tool name, serializes it with command_input_json, parses the JSON back, and verifies the tool_name field. Nothing outside the test is changed.

**Call relations**: This test calls the same serialization helper used by run. It protects the contract described in command_input_json.

*Call graph*: calls 1 internal fn (command_input_json); 3 external calls (assert_eq!, request_for_tool_use, from_str).


##### `tests::permission_decision_deny_blocks_processing`  (lines 348–376)

```
fn permission_decision_deny_blocks_processing()
```

**Purpose**: Verifies that modern hook JSON with a deny decision blocks the tool call. It also checks that the denial reason is shown as feedback.

**Data flow**: It feeds parse_completed a successful command result whose standard output says permissionDecision is deny. It expects parsed data to say the tool should block, with the provided reason, and expects the completed run status to be Blocked.

**Call relations**: This test exercises parse_completed directly with a fake handler and fake command result. It confirms how dispatcher-parsed hook output will affect run.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::permission_decision_allow_can_update_input`  (lines 379–401)

```
fn permission_decision_allow_can_update_input()
```

**Purpose**: Verifies that a hook can allow a tool call while rewriting the tool input. This is the positive path for input changes.

**Data flow**: It passes parse_completed a successful hook output containing permissionDecision allow and an updatedInput object. It expects no block and expects the rewritten command JSON to be stored as updated_input.

**Call relations**: This test focuses on parse_completed, which run later uses to gather possible rewrites from all hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::last_completed_updated_input_wins`  (lines 404–430)

```
fn last_completed_updated_input_wins()
```

**Purpose**: Checks the conflict rule for multiple input rewrites. The rewrite from the hook that finished later should win, even if that hook was configured earlier.

**Data flow**: It creates two parsed hook results with different updated inputs, manually assigns completion order values, and calls latest_updated_input. It expects the rewrite with the later completion order to be returned.

**Call relations**: This test directly protects the helper used by run after all hook commands have completed.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::permission_decision_allow_without_updated_input_fails_open`  (lines 433–461)

```
fn permission_decision_allow_without_updated_input_fails_open()
```

**Purpose**: Confirms that an allow decision without an updated input is treated as an invalid hook response, but does not block the tool. “Fails open” means the hook is marked failed while the tool is not stopped.

**Data flow**: It gives parse_completed a successful hook output containing permissionDecision allow but no updatedInput. It expects no block, no rewrite, a Failed status, and an error message explaining the unsupported response.

**Call relations**: This test documents one edge of the hook output format handled inside parse_completed.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::deprecated_block_decision_blocks_processing`  (lines 464–492)

```
fn deprecated_block_decision_blocks_processing()
```

**Purpose**: Checks that the older hook format using decision: block still blocks the tool. This keeps compatibility with existing hook scripts.

**Data flow**: It passes parse_completed old-style JSON with a block decision and reason. It expects the parsed data to block the tool and the completed run to contain feedback with that reason.

**Call relations**: This test shows that parse_completed accepts both current and deprecated hook output forms.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::deprecated_block_decision_with_additional_context_blocks_processing`  (lines 495–529)

```
fn deprecated_block_decision_with_additional_context_blocks_processing()
```

**Purpose**: Verifies that the older block format can also carry extra context for the model. The tool should still be blocked, and the context should be preserved.

**Data flow**: It sends parse_completed old-style block JSON plus a hookSpecificOutput additionalContext field. It expects parsed data to include both the block reason and the extra context, and expects the run entries to show context followed by feedback.

**Call relations**: This test exercises parse_completed together with the common helper that records additional context.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::unsupported_permission_decision_fails_open`  (lines 532–560)

```
fn unsupported_permission_decision_fails_open()
```

**Purpose**: Checks that an unsupported modern permission decision is treated as hook failure, not as a block. This avoids letting unclear hook output accidentally stop tool use.

**Data flow**: It feeds parse_completed JSON with permissionDecision ask. It expects no block, no rewrite, a Failed status, and an error entry naming the unsupported decision.

**Call relations**: This test guards parse_completed’s validation of modern hook output.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::deprecated_approve_decision_fails_open`  (lines 563–587)

```
fn deprecated_approve_decision_fails_open()
```

**Purpose**: Checks that the old approve decision is no longer accepted as a successful decision. The hook is marked failed, but the tool is not blocked.

**Data flow**: It passes parse_completed old-style JSON with decision approve. It expects empty decision data, a Failed status, and an error explaining that the decision is unsupported.

**Call relations**: This test protects backward-compatibility boundaries in parse_completed: some old forms are accepted, but not all.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::additional_context_is_recorded`  (lines 590–624)

```
fn additional_context_is_recorded()
```

**Purpose**: Verifies that hook-provided extra context is captured and included in user-visible hook entries. This lets a hook tell the model something useful while also making a decision.

**Data flow**: It gives parse_completed modern JSON that denies the tool and includes additionalContext. It expects the parsed data to include that context and the block reason, with matching context and feedback entries in the completed run.

**Call relations**: This test exercises parse_completed’s path that calls shared common code to append additional context.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::plain_stdout_is_ignored`  (lines 627–645)

```
fn plain_stdout_is_ignored()
```

**Purpose**: Checks that ordinary non-JSON text printed by a successful hook is ignored. This lets simple scripts print harmless messages without changing the decision.

**Data flow**: It passes parse_completed a successful command result with plain text on standard output. It expects the hook to be marked completed with no block, no context, no rewrite, and no entries.

**Call relations**: This test covers parse_completed’s fallback behavior when output is not meaningful hook JSON.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::invalid_json_like_stdout_fails_instead_of_becoming_noop`  (lines 648–672)

```
fn invalid_json_like_stdout_fails_instead_of_becoming_noop()
```

**Purpose**: Verifies that broken JSON-looking output is treated as an error, not silently ignored. This helps catch mistakes in hook scripts.

**Data flow**: It sends parse_completed standard output that starts like JSON but is malformed. It expects no block, but the hook run status becomes Failed with an invalid JSON output message.

**Call relations**: This test covers the path where parse_completed asks the output parser whether text looks like JSON after parsing failed.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_blocks_processing`  (lines 675–699)

```
fn exit_code_two_blocks_processing()
```

**Purpose**: Checks the simpler blocking convention where a hook exits with code 2 and writes the reason to standard error. This supports hooks that do not emit structured JSON.

**Data flow**: It passes parse_completed a command result with exit code 2 and a standard error message. It expects the parsed data to block with the trimmed message and the completed run to be Blocked with feedback.

**Call relations**: This test protects one of parse_completed’s non-JSON control paths.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::preview_and_completed_run_ids_include_tool_use_id`  (lines 702–723)

```
fn preview_and_completed_run_ids_include_tool_use_id()
```

**Purpose**: Verifies that previewed and completed hook run identifiers include the tool use id. This keeps hook records tied to the exact tool call they refer to.

**Data flow**: It creates a request with a known tool use id, asks preview for planned runs, then parses a completed hook and wraps it with the same tool use id. It checks that both identifiers match the expected format.

**Call relations**: This test connects preview, parse_completed, and shared hook-completion wrapping code to ensure they agree on run identity.

*Call graph*: calls 3 internal fn (hook_completed_for_tool_use, parse_completed, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, run_result).


##### `tests::serialization_failure_run_ids_include_tool_use_id`  (lines 726–739)

```
fn serialization_failure_run_ids_include_tool_use_id()
```

**Purpose**: Checks that even serialization failure events use the same tool-use-specific run identifiers as normal previews. This keeps error reporting consistent.

**Data flow**: It creates a request, gets preview run ids, creates serialization-failure hook events for the same handler and tool use id, and compares the ids. It does not execute any hook command.

**Call relations**: This test links preview with the shared serialization-failure reporting path used by run when command_input_json fails.

*Call graph*: calls 2 internal fn (serialization_failure_hook_events_for_tool_use, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, vec!).


##### `tests::handler`  (lines 741–753)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a sample configured pre-tool-use hook handler for tests. It gives tests a consistent fake hook command and matcher.

**Data flow**: It builds a ConfiguredHandler with the PreToolUse event, a Bash matcher, a command string, timeout, source path, display order, and empty environment. It returns that handler to the test that requested it.

**Call relations**: Most tests call this helper before calling parse_completed or preview, so they do not repeat setup details.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 755–765)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Creates a fake command execution result for tests. It lets tests describe a hook’s exit code and output without actually running a command.

**Data flow**: It receives an optional exit code, standard output text, and standard error text. It wraps them with fixed timing fields and no execution error, then returns a CommandRunResult.

**Call relations**: The parse_completed tests use this helper to simulate different hook command outcomes.


##### `tests::request_for_tool_use`  (lines 767–781)

```
fn request_for_tool_use(tool_use_id: &str) -> super::PreToolUseRequest
```

**Purpose**: Creates a sample pre-tool-use request for tests. It represents a Bash tool call with a simple command input.

**Data flow**: It receives a tool use id and fills in a request with a new session id, fixed turn id, no subagent, a test current directory, model and permission strings, tool name Bash, no aliases, and JSON tool input. It returns the complete request.

**Call relations**: Preview and serialization tests call this helper so they can focus on run ids and serialized fields rather than request setup.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, test_path_buf, json!).


### `hooks/src/events/post_tool_use.rs`

`domain_logic` · `after each tool call`

When the system finishes using a tool, such as a shell command or an external MCP tool, this file decides which post-tool hooks should run, sends them a clear JSON summary of the tool call, and interprets their replies. Without this file, hooks could not react after a tool ran, so users would lose a way to catch risky output, add reminders for the model, or stop the current flow.

The main path starts by matching the tool name against configured hook rules. A preview function can show which hooks would run, while the run function actually executes them. Before execution, the request is turned into JSON. That JSON includes the session, turn, current directory, model, permission mode, tool name, tool input, tool response, and tool-use id.

After each hook command finishes, parse_completed translates its result into system events. Exit code 0 usually means success, but JSON on standard output can still ask to block, stop, add context, or show warnings. Exit code 2 is treated as a block if the hook wrote feedback to standard error. Bad JSON-looking output is reported as a hook failure, while plain text output is ignored. The file then combines all hook results into one outcome: completed hook events, whether normal processing should be blocked, extra context for the model, and optional feedback text.

#### Function details

##### `preview`  (lines 53–68)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &PostToolUseRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Shows which post-tool-use hooks would run for a given tool call, without actually running them. This is useful for displaying pending hook activity before the real work happens.

**Data flow**: It receives a list of configured hooks and a post-tool-use request. It builds the set of tool names and aliases that can match hook rules, selects the matching PostToolUse handlers, and turns each selected handler into a run summary tied to the specific tool-use id. It returns those summaries and does not change anything.

**Call relations**: Higher-level preview code calls this when it needs to report upcoming post-tool hooks. It relies on the shared matcher-building helper and the dispatcher’s handler selection, then wraps each selected handler using the common tool-use summary format.

*Call graph*: calls 2 internal fn (select_handlers_for_matcher_inputs, matcher_inputs); called by 3 (preview_post_tool_use, preview_and_completed_run_ids_include_tool_use_id, serialization_failure_run_ids_include_tool_use_id).


##### `run`  (lines 70–137)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PostToolUseRequest,
) -> PostToolUseOutcome
```

**Purpose**: Actually runs all matching post-tool-use hooks and combines their decisions. This is the main function used after a tool has produced a result.

**Data flow**: It receives configured hooks, a command shell for running hook commands, and the full post-tool-use request. It selects matching handlers; if none match, it returns an empty, non-blocking outcome. If handlers do match, it serializes the request into JSON, runs each hook command with that JSON as input, parses each completed command, then combines their added context, block decisions, feedback, and completed events into one outcome.

**Call relations**: The broader post-tool-use event flow calls this after a tool finishes. It delegates matching to the dispatcher, JSON creation to command_input_json, command execution to execute_handlers, result interpretation to parse_completed, and final text/context combining to common helpers.

*Call graph*: calls 8 internal fn (execute_handlers, select_handlers_for_matcher_inputs, flatten_additional_contexts, join_text_chunks, matcher_inputs, serialization_failure_hook_events_for_tool_use, command_input_json, serialization_failure_outcome); called by 1 (run_post_tool_use); 2 external calls (new, format!).


##### `command_input_json`  (lines 145–162)

```
fn command_input_json(request: &PostToolUseRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Builds the JSON message that is sent to a selected post-tool-use hook through its standard input. This gives the hook command all the facts it needs about the tool call it is judging.

**Data flow**: It reads the request fields, including session, turn, subagent information, current directory, model, permission mode, canonical tool name, tool input, tool response, and tool-use id. It converts optional paths and subagent data into schema-friendly fields, then serializes everything into a JSON string. The output is either that JSON string or a serialization error.

**Call relations**: run calls this before executing any hook commands. A test also calls it directly to make sure the JSON uses the real tool name from the request, not an internal matcher alias.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run, command_input_uses_request_tool_name); 1 external calls (to_string).


##### `parse_completed`  (lines 164–300)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<PostToolUseHandlerData>
```

**Purpose**: Turns one finished hook command into a structured hook event plus the decisions that matter to the model. It is the translator between raw process output and system behavior.

**Data flow**: It receives the handler that ran, the command’s exit code, standard output, standard error, timing/error information, and the optional turn id. It checks for execution errors first, then interprets exit codes and any JSON output. From that it builds user-visible entries such as errors, warnings, feedback, stops, or added context, and records whether the hook blocked processing. It returns a parsed handler result containing the completed event and this post-tool-specific data.

**Call relations**: The dispatcher uses this as the parser callback after each hook command run. Tests exercise it heavily because it defines the important policy: JSON decisions can block or stop, exit code 2 can block with feedback, invalid hook output fails the hook, and plain non-JSON output is ignored.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_post_tool_use, append_additional_context, trimmed_non_empty); called by 8 (additional_context_is_recorded, block_decision_stops_normal_processing, continue_false_stops_with_reason, continue_false_without_reason_synthesizes_feedback, exit_two_blocks_with_feedback, plain_stdout_is_ignored_for_post_tool_use, preview_and_completed_run_ids_include_tool_use_id, unsupported_updated_mcp_tool_output_fails_open); 2 external calls (new, format!).


##### `serialization_failure_outcome`  (lines 302–309)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> PostToolUseOutcome
```

**Purpose**: Creates the fallback outcome used when the system cannot even build the JSON input for hooks. It reports the failure events but does not block the tool flow.

**Data flow**: It receives already-created hook completed events that describe the serialization failure. It wraps them in a PostToolUseOutcome with no block decision, no added context, and no feedback message.

**Call relations**: run calls this only on the error path after command_input_json fails. The actual failure events are prepared by a common helper so they still look like normal hook completion records.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::command_input_uses_request_tool_name`  (lines 332–341)

```
fn command_input_uses_request_tool_name()
```

**Purpose**: Checks that hook input JSON keeps the request’s real tool name. This prevents internal matching aliases from leaking into the hook input where consumers expect the canonical name.

**Data flow**: It builds a sample request, changes its tool_name to apply_patch, serializes it with command_input_json, parses the JSON back into a value, and verifies that the tool_name field is apply_patch.

**Call relations**: This test calls the same JSON builder that run uses before hook execution. It protects the contract documented in command_input_json: matcher aliases may help select hooks, but the hook receives the true tool name.

*Call graph*: calls 1 internal fn (command_input_json); 3 external calls (assert_eq!, request_for_tool_use, from_str).


##### `tests::block_decision_stops_normal_processing`  (lines 344–364)

```
fn block_decision_stops_normal_processing()
```

**Purpose**: Verifies that a hook can ask to block further processing by returning a post-tool-use JSON decision. This protects the safety-check behavior of post-tool hooks.

**Data flow**: It creates a fake successful command result whose standard output says decision block with a reason. It feeds that into parse_completed and checks that the parsed data says should_block is true, includes feedback for the model, and marks the run as Blocked.

**Call relations**: This test exercises parse_completed directly, using helper functions to build a handler and command result. It confirms the path that run later relies on when combining all hook decisions.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::additional_context_is_recorded`  (lines 367–393)

```
fn additional_context_is_recorded()
```

**Purpose**: Verifies that a hook can add extra context for the model after seeing a tool result. This allows hooks to pass useful notes forward without blocking anything.

**Data flow**: It creates a fake successful hook output containing PostToolUse-specific additionalContext JSON. It parses that result and checks that the context is stored for the model and also appears as a Context entry in the completed hook event.

**Call relations**: This test calls parse_completed because that function is responsible for recognizing extra context. It protects the behavior later used by run when it gathers all added context from multiple hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::unsupported_updated_mcp_tool_output_fails_open`  (lines 396–423)

```
fn unsupported_updated_mcp_tool_output_fails_open()
```

**Purpose**: Checks that an unsupported post-tool hook feature is reported as a hook failure but does not block the main flow. “Fails open” here means the bad hook result is logged as failed, while normal processing is allowed to continue.

**Data flow**: It creates a fake successful hook process that returns JSON with unsupported updatedMCPToolOutput. It parses the result and checks that no block or feedback is produced, while the completed run status is Failed with a clear error entry.

**Call relations**: This test focuses on parse_completed’s validation of parsed hook JSON. It ensures unsupported output is visible to users but is not accidentally treated as a reason to block.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_two_blocks_with_feedback`  (lines 426–442)

```
fn exit_two_blocks_with_feedback()
```

**Purpose**: Verifies the legacy/simple blocking path where a hook exits with code 2 and writes feedback to standard error. This gives hook authors a non-JSON way to block.

**Data flow**: It creates a fake command result with exit code 2 and stderr text. It parses the result and checks that should_block becomes true, the stderr text becomes model feedback, and the run status is Blocked.

**Call relations**: This test calls parse_completed with a helper-built handler and run result. It protects the exit-code convention that run depends on when executing real hook commands.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_stops_with_reason`  (lines 445–472)

```
fn continue_false_stops_with_reason()
```

**Purpose**: Checks that a hook can stop the current processing flow by returning continue false with a stop reason and model-facing reason. This is different from blocking a tool result; it tells the system not to continue the broader operation.

**Data flow**: It creates a fake successful hook output containing continue false, stopReason, and reason. After parsing, it checks that the run status is Stopped, the stop entry uses the stopReason, and the model feedback uses the reason.

**Call relations**: This test exercises parse_completed’s stop-handling branch. It makes sure the dispatcher-facing completed event and the model-facing feedback are both filled correctly.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_without_reason_synthesizes_feedback`  (lines 475–498)

```
fn continue_false_without_reason_synthesizes_feedback()
```

**Purpose**: Verifies that when a hook says continue false without giving a reason, the system creates a useful default message. This avoids leaving users and the model with an unexplained stop.

**Data flow**: It builds a fake successful hook output with only continue false. parse_completed turns that into a Stopped run, adds a default Stop entry, and records the same default text as feedback for the model.

**Call relations**: This test calls parse_completed to protect the default-message fallback used when hook authors omit optional explanation fields.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::plain_stdout_is_ignored_for_post_tool_use`  (lines 501–518)

```
fn plain_stdout_is_ignored_for_post_tool_use()
```

**Purpose**: Checks that ordinary non-JSON standard output from a successful hook is ignored. This lets hook commands print incidental text without causing warnings or failures.

**Data flow**: It creates a fake successful command result with plain text on stdout. It parses the result and checks that there is no block, no added context, no feedback, no event entries, and the run status remains Completed.

**Call relations**: This test verifies parse_completed’s tolerant behavior for plain text. It matters because real scripts may accidentally print harmless output.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::preview_and_completed_run_ids_include_tool_use_id`  (lines 521–542)

```
fn preview_and_completed_run_ids_include_tool_use_id()
```

**Purpose**: Verifies that both previewed hook runs and completed hook runs include the tool-use id in their run id. This lets the system connect a hook result to the exact tool call it belongs to.

**Data flow**: It builds a sample request, asks preview for matching runs, and checks the preview id. Then it parses a fake completed hook result, wraps it as a tool-use completion event, and checks that the completed id matches the same pattern.

**Call relations**: This test connects preview, parse_completed, and the common hook_completed_for_tool_use helper. It protects consistency between the pre-run display and the final completion event.

*Call graph*: calls 3 internal fn (hook_completed_for_tool_use, parse_completed, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, run_result).


##### `tests::serialization_failure_run_ids_include_tool_use_id`  (lines 545–558)

```
fn serialization_failure_run_ids_include_tool_use_id()
```

**Purpose**: Checks that even serialization-failure hook events include the tool-use id in their run id. This keeps error reporting tied to the exact tool call that triggered the hook.

**Data flow**: It builds a sample request and gets the preview run id. It then creates serialization-failure completion events for the same handler and request, and verifies the failure event id matches the preview style.

**Call relations**: This test uses preview and the common serialization-failure helper. It protects the error path that run uses when command_input_json cannot produce hook input.

*Call graph*: calls 2 internal fn (serialization_failure_hook_events_for_tool_use, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, vec!).


##### `tests::handler`  (lines 560–572)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a sample configured PostToolUse hook for tests. It gives tests a consistent fake hook rule and command to parse or preview against.

**Data flow**: It constructs a ConfiguredHandler with a PostToolUse event name, a Bash matcher, a command string, timeout, display text, source path, source type, order, and empty environment. The result is a ready-to-use test handler.

**Call relations**: Most tests call this helper before invoking preview or parse_completed. It keeps the test setup short and consistent so each test can focus on one behavior.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 574–584)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Creates a sample command execution result for tests. It lets tests describe only the exit code and output they care about.

**Data flow**: It receives an optional exit code, stdout text, and stderr text. It fills in fixed start/end times, duration, and no execution error, then returns a CommandRunResult.

**Call relations**: The parse_completed tests call this helper to simulate different hook command outcomes, such as success, blocking exit code, invalid output, or plain text output.


##### `tests::request_for_tool_use`  (lines 586–601)

```
fn request_for_tool_use(tool_use_id: &str) -> super::PostToolUseRequest
```

**Purpose**: Creates a sample post-tool-use request for tests. It represents a Bash tool call that echoed hello and returned a simple successful response.

**Data flow**: It receives a tool-use id and fills in a new session id, a fixed turn id, current directory, model, permission mode, tool name, empty aliases, JSON tool input, and JSON tool response. It returns a complete PostToolUseRequest.

**Call relations**: Preview and serialization tests call this helper to build realistic requests without repeating all fields. It supplies the request data that preview and command_input_json expect.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, test_path_buf, json!).


### `hooks/src/events/permission_request.rs`

`orchestration` · `permission approval path`

This file exists so outside policy checks can participate in the moment when the system is about to ask whether a tool may run. A hook here is like a security desk before the main approval desk: it can wave something through, stop it with a reason, or say nothing and let the usual approval process continue.

The flow has two parts. First, `preview` finds which configured hook commands match the tool being considered, so the user interface can show that those hooks are pending. Later, `run` finds the same matching hooks, builds a JSON message describing the request, runs each hook command, and turns their outputs into `HookCompletedEvent` records that can be shown in the transcript.

The important behavior is how multiple hook decisions are combined. A denial always wins, even if another hook allowed the request. If nobody denies but one or more hooks allow, the final result is allow. If no hook makes a decision, the normal permission flow continues. This conservative rule prevents a broad “allow” rule from accidentally overriding a more specific “deny” rule.

The file also protects the rest of the system from bad hook behavior. If a hook crashes, exits strangely, or returns malformed JSON, that is recorded as a failed hook run rather than silently treated as permission.

#### Function details

##### `preview`  (lines 67–85)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &PermissionRequestRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Finds the permission-request hooks that would run for a particular tool request, without actually running them. This lets the interface show pending hook rows before the approval decision is made.

**Data flow**: It receives the full configured hook list and the current permission request. It turns the tool name and any aliases into matcher inputs, asks the dispatcher which handlers match the `PermissionRequest` event, and converts those matches into short run summaries. It returns those summaries and does not change the request or execute any commands.

**Call relations**: This is called by `preview_permission_request` before the real hook execution. It relies on shared matching helpers, especially `matcher_inputs` and `select_handlers_for_matcher_inputs`, so previewing and running use the same selection rules.

*Call graph*: calls 2 internal fn (select_handlers_for_matcher_inputs, matcher_inputs); called by 1 (preview_permission_request).


##### `run`  (lines 87–148)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PermissionRequestRequest,
) -> PermissionRequestOutcome
```

**Purpose**: Runs all permission-request hooks that match the current tool request and produces both transcript-visible hook events and an optional final permission decision. This is the main execution path for this file.

**Data flow**: It receives configured handlers, a command shell used to run hook commands, and a request containing details such as the session, working directory, model, tool name, and tool input. It selects matching handlers, builds the JSON input they should receive, executes them, parses each completed run, and combines any allow or deny decisions. It returns a `PermissionRequestOutcome` containing completed hook events plus either allow, deny with a message, or no decision.

**Call relations**: This is called by `run_permission_request` when the approval path reaches the hook stage. It uses `build_command_input` to prepare the hook payload, hands execution to `execute_handlers`, uses `parse_completed` as the per-hook result parser, and then calls `resolve_permission_request_decision` to turn many hook opinions into one final verdict.

*Call graph*: calls 6 internal fn (execute_handlers, select_handlers_for_matcher_inputs, matcher_inputs, serialization_failure_hook_events_for_tool_use, build_command_input, resolve_permission_request_decision); called by 1 (run_permission_request); 3 external calls (new, format!, to_string).


##### `resolve_permission_request_decision`  (lines 153–170)

```
fn resolve_permission_request_decision(
    decisions: impl IntoIterator<Item = &'a PermissionRequestDecision>,
) -> Option<PermissionRequestDecision>
```

**Purpose**: Combines several hook decisions into one safe final answer. Its rule is simple: any deny wins; otherwise an allow is kept; otherwise there is no hook verdict.

**Data flow**: It receives an ordered set of hook decisions. As it reads them, it remembers if it has seen an allow, but immediately returns a cloned deny decision if it sees one. The output is a single optional decision: deny, allow, or nothing.

**Call relations**: This is called by `run` after all matching hooks have finished and their outputs have been parsed. It is the policy fold that keeps a specific block from being overridden by another hook’s allow.

*Call graph*: called by 1 (run).


##### `build_command_input`  (lines 172–187)

```
fn build_command_input(request: &PermissionRequestRequest) -> PermissionRequestCommandInput
```

**Purpose**: Builds the structured input object that will be serialized to JSON and sent to each permission-request hook command. This gives hooks the context they need to decide whether a tool action should be allowed.

**Data flow**: It reads fields from the permission request, including session ID, turn ID, optional subagent information, transcript path, working directory, model, permission mode, tool name, and tool input. It converts paths and optional subagent data into the schema format expected by hook commands. It returns a `PermissionRequestCommandInput` ready to be turned into JSON.

**Call relations**: This is called by `run` just before hook commands are executed. Its output is serialized and passed into `execute_handlers`, so every hook receives the same clear description of the permission request.

*Call graph*: calls 2 internal fn (from_path, from); called by 1 (run).


##### `parse_completed`  (lines 189–291)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<PermissionRequestHandlerData>
```

**Purpose**: Turns one finished hook command run into a transcript event plus any permission decision hidden in its output. It also classifies failures, denials, warnings, and malformed output in a consistent way.

**Data flow**: It receives the handler that ran, the command result with standard output, standard error, exit code, and possible execution error, plus the optional turn ID. If the command failed to run, it records an error. If it exited successfully, it tries to parse permission-request JSON from stdout; that JSON may contain a warning, an allow, a deny message, or an invalid-output reason. If it exits with code 2 and writes a non-empty stderr message, that is treated as a denial. Other nonzero or missing exit statuses become failures. It returns a parsed handler object containing the completed hook event and any allow/deny decision.

**Call relations**: This function is supplied to `execute_handlers` by `run`, so it is invoked for each hook command after it finishes. It uses `parse_permission_request` and `looks_like_json` to understand hook stdout, `trimmed_non_empty` to read denial text from stderr, and `completed_summary` to package the result for the rest of the hook system.

*Call graph*: calls 4 internal fn (completed_summary, looks_like_json, parse_permission_request, trimmed_non_empty); 2 external calls (new, format!).


##### `tests::permission_request_deny_overrides_earlier_allow`  (lines 301–315)

```
fn permission_request_deny_overrides_earlier_allow()
```

**Purpose**: Checks that a denial still wins even when an earlier hook allowed the request. This protects the most important safety rule in the decision-combining logic.

**Data flow**: It creates two decisions: first allow, then deny with a message. It passes them into `resolve_permission_request_decision` and expects the result to be the denial with the same message. Nothing outside the test is changed.

**Call relations**: This test exercises `resolve_permission_request_decision` directly. It represents the case where one policy layer permits an action but a later, more specific layer blocks it.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_request_returns_allow_when_no_handler_denies`  (lines 318–328)

```
fn permission_request_returns_allow_when_no_handler_denies()
```

**Purpose**: Checks that the final decision is allow when at least one hook allows and no hook denies. This confirms that hooks can positively approve a request.

**Data flow**: It creates two allow decisions, passes them into `resolve_permission_request_decision`, and expects the result to be allow. It only verifies the returned value.

**Call relations**: This test calls `resolve_permission_request_decision` directly. It covers the non-blocking path used by `run` when all deciding hooks agree to allow the tool action.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_request_returns_none_when_no_handler_decides`  (lines 331–335)

```
fn permission_request_returns_none_when_no_handler_decides()
```

**Purpose**: Checks that the system returns no hook verdict when there are no decisions to combine. This preserves the normal approval flow when hooks stay silent.

**Data flow**: It creates an empty list of decisions, passes it into `resolve_permission_request_decision`, and expects `None` as the result. It does not produce side effects.

**Call relations**: This test calls `resolve_permission_request_decision` directly. It represents the path where `run` found no allow or deny decision in any completed hook output.

*Call graph*: 2 external calls (new, assert_eq!).
