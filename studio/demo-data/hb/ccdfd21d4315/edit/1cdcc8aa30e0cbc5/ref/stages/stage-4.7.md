### 4.7 · Command Execute → Observation → Trajectory Step

#### (a) Opening Explanation

This stage exists to turn “the agent asked to do something” into “the system now has a durable record of what happened next.” It owns the normal path after the model has chosen terminal commands: run them in the terminal, capture the result, decide what the agent should see as the next observation, and save that whole step into the trajectory. The trajectory is the run log the agent builds over time. This stage sits between decision and control flow. Upstream, the model has already produced commands and maybe claimed the task is done. Downstream, the loop needs a clean observation and a reliable completion signal so it can either continue or stop.

#### (b) Main Flow

1. `_execute_commands()` (send the chosen keystrokes to the terminal and wait for output) runs the agent’s commands in a tmux session, a terminal you can drive remotely.  
   Its job is simple: turn intent into real terminal effects, then bring back either output or a timeout message. Without this step, the agent would only be planning, never acting.

2. The stage then converts raw terminal output into an observation the next model call can use.  
   This is not just formatting. It decides what the agent should be told next:
   - if completion was already pending, the raw output can serve as the final confirmation path
   - if the agent just claimed `is_task_complete` for the first time, the stage does **not** stop immediately; it asks for confirmation instead
   - otherwise it gives the usual terminal output, trimmed to a safe length and possibly prefixed with warnings

3. It also records what the agent just did as tool calls.  
   A tool call here is a structured record like “run this bash command” or “mark task complete.” This matters because the trajectory should show not just text, but the concrete actions the agent took.

4. The stage appends a new step to the trajectory.  
   This is the canonical record of the run: what the agent said, what it tried, what came back, and basic metrics. If you want to reconstruct the run later, this is the source of truth.

5. Finally, `_dump_trajectory()` (write the trajectory JSON to disk) persists that record immediately.  
   This exists for crash safety. If the process dies mid-run, you still keep the work done so far instead of losing the latest step.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-pending-completion` — written when the agent first claims the task is complete; set to True so completion becomes a two-step confirmation instead of a one-shot stop
- writes: `reg-pending-completion` — written in the normal non-completion path as False so stale completion intent does not leak into later turns
- writes: `reg-trajectory-steps` — appended after command execution so this turn becomes part of the canonical run record
- reads: `reg-pending-completion` — snapshot before mutation to tell whether this is the first completion claim or the confirmed follow-up
- clears: `reg-pending-completion` — cleared in the normal path by setting it False when no completion confirmation should remain active
- triggers downstream: `stage-4.10 Completion Gate + Loop Control` — after observation and trajectory step are built, the next stage decides whether the loop should stop or continue

#### (d) Pipeline Hand-Off

Upstream gives this stage parsed commands, the agent’s message, and any claimed completion intent. This stage turns that into terminal output, a user-facing observation, structured action records, and a persisted trajectory step; the next stage uses those results to decide whether to keep looping or exit cleanly.

<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1422-1547 · execute commands and append agent trajectory step</summary>

> **Stage context**: This region is the main body of stage-4.9 after command parsing has already produced `commands` and the agent response has already been classified with `is_task_complete`. It runs `_execute_commands(...)`, updates `_pending_completion` based on the completion-confirmation state, then records the agent-side `Step` in `_trajectory_steps`. In this stage, it sits between earlier response parsing and the later trajectory dump described for `_dump_trajectory`.

**What this code does**

This region executes the parsed `commands` against `self._session`, builds an `observation` string from `terminal_output`, and appends a new agent `Step` to `self._trajectory_steps`. It also conditionally updates `self._pending_completion`, conditionally updates `self._last_response_model_name`, and converts parsed commands and task-complete claims into trajectory `tool_calls` unless `_save_raw_content_in_trajectory` is enabled. The durable outputs here are state mutations and the appended trajectory record; `timeout_occurred`, `was_pending_completion`, and `observation` stay local in the shown code.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `Terminus2` — owner object; supplies session, settings, helpers, and mutable run state; `commands`: `?` — enclosing-scope parsed command list passed to `_execute_commands` and optionally translated into `ToolCall`s; `is_task_complete`: `?` — enclosing-scope completion flag that selects the completion-confirmation branch and optional `mark_task_complete` tool call; `feedback`: `?` — enclosing-scope prior warning text; if it contains `"WARNINGS:"`, the normal observation gets prefixed; `chat`: `?` — enclosing-scope chat accumulator used to compute token and cost deltas; `tokens_before_cache`: `?` — pre-call cache-token snapshot for `cached_tokens` delta; `cost_before`: `?` — pre-call cost snapshot for `cost_usd` delta; `tokens_before_input`: `?` — pre-call prompt-token snapshot for `prompt_tokens` delta; `tokens_before_output`: `?` — pre-call completion-token snapshot for `completion_tokens` delta; `episode`: `?` — enclosing-scope episode number used to build `tool_call_id` values; `llm_response`: `?` — enclosing-scope LLM response object; supplies model name, reasoning content, token ids, and logprobs; `message_content`: `?` — enclosing-scope agent message stored in the appended `Step.message`
- reads: `self._session`, `self._pending_completion`, `self._save_raw_content_in_trajectory`, `self._trajectory_steps`, `self._model_name`, `self._last_response_model_name`
- returns: None; the real product is a possible update to `self._pending_completion`, an optional update to `self._last_response_model_name`, and one appended agent `Step` in `self._trajectory_steps`.
- effects: awaits `self._execute_commands(commands, self._session)` to interact with the live session; may set `self._pending_completion = True` on the first `is_task_complete` branch; may set `self._pending_completion = False` on the non-complete branch; does not modify `self._pending_completion` when `is_task_complete` is true and it was already true; may set `self._last_response_model_name` if `llm_response.model_name` is truthy; appends one `Step` to `self._trajectory_steps`

**Execution flow**

1. It calls `await self._execute_commands(commands, self._session)` and captures `(timeout_occurred, terminal_output)`. In the shown region, only `terminal_output` is used later; `timeout_occurred` is not referenced again.
2. It snapshots `was_pending_completion = self._pending_completion` before any mutation. In the shown lines, that snapshot is only captured; no later branch reads `was_pending_completion` here.
3. It builds `observation` from three code paths keyed by `is_task_complete`, `self._pending_completion`, and `feedback`: confirmed-complete uses raw `terminal_output`; first-time completion sets `self._pending_completion = True` and uses `_get_completion_confirmation_message(terminal_output)`; the normal path sets `self._pending_completion = False` and uses `_limit_output_length(terminal_output)`, optionally prefixed with `feedback` when `feedback` contains `"WARNINGS:"`.
4. It computes per-step usage deltas from the enclosing snapshots: `cache_tokens_used = chat.total_cache_tokens - tokens_before_cache` and `step_cost = chat.total_cost - cost_before`.
5. It initializes `tool_calls` and `observation_results`, then branches on `self._save_raw_content_in_trajectory`. In non-raw mode, it creates one `ToolCall(function_name="bash_command", ...)` per item in `commands`, optionally appends `ToolCall(function_name="mark_task_complete", arguments={})`, and appends `ObservationResult(content=observation)` in exactly three cases: after any non-empty `commands`; after `is_task_complete` when `commands` is empty; or after neither commands nor task completion. In raw-content mode, it skips `tool_calls` generation but still appends one `ObservationResult(content=observation)`.
6. It conditionally stores `llm_response.model_name` into `self._last_response_model_name`, then appends a `Step` built from `message_content`, `llm_response` fields, the computed `tool_calls`, `Observation(results=observation_results)`, and `Metrics(...)` token/cost deltas.

**Source**

```python
            timeout_occurred, terminal_output = await self._execute_commands(
                commands,
                self._session,
            )

            # Capture the pending completion state before potentially modifying it
            was_pending_completion = self._pending_completion

            # Construct the observation (what gets sent back to the LLM)
            if is_task_complete:
                if self._pending_completion:
                    observation = terminal_output
                else:
                    self._pending_completion = True
                    observation = self._get_completion_confirmation_message(
                        terminal_output
                    )
            else:
                self._pending_completion = False
                if feedback and "WARNINGS:" in feedback:
                    observation = (
                        f"Previous response had warnings:\n{feedback}\n\n"
                        f"{self._limit_output_length(terminal_output)}"
                    )
                else:
                    observation = self._limit_output_length(terminal_output)

            # Record the step in trajectory
            cache_tokens_used = chat.total_cache_tokens - tokens_before_cache
            step_cost = chat.total_cost - cost_before

            # Create tool_calls array from commands and task completion
            # Note: Although Terminus 2 doesn't offer native tool calling (it uses text-based command parsing),
            # we represent parsed commands as tool calls for better trajectory analysis and compatibility with tooling.
            # However, when raw_content mode is enabled, we skip tool_calls generation to preserve the raw LLM response.
            tool_calls: list[ToolCall] | None = None
            observation_results: list[ObservationResult] = []

            if not self._save_raw_content_in_trajectory:
                # Only create tool_calls when NOT in raw_content mode
                tool_calls_list: list[ToolCall] = []

                if commands:
                    for i, cmd in enumerate(commands):
                        tool_call_id = f"call_{episode}_{i + 1}"
                        tool_calls_list.append(
                            ToolCall(
                                tool_call_id=tool_call_id,
                                function_name="bash_command",
                                arguments={
                                    "keystrokes": cmd.keystrokes,
                                    "duration": cmd.duration_sec,
                                },
                            )
                        )

                    # Add observation result after all tool calls are created
                    # Note: All commands share the same terminal output in this architecture,
                    # so we omit source_call_id to indicate the observation applies to the entire step.
                    observation_results.append(
                        ObservationResult(
                            content=observation,
                        )
                    )

                # Add task_complete as a tool call if the agent marked the task complete
                if is_task_complete:
                    task_complete_call_id = f"call_{episode}_task_complete"
                    tool_calls_list.append(
                        ToolCall(
                            tool_call_id=task_complete_call_id,
                            function_name="mark_task_complete",
                            arguments={},
                        )
                    )
                    # If there are no commands, we still need to add an observation result
                    if not commands:
                        observation_results.append(
                            ObservationResult(
                                content=observation,
                            )
                        )
                elif not commands:
                    # No commands and no task completion, just the observation
                    observation_results.append(
                        ObservationResult(
                            content=observation,
                        )
                    )

                tool_calls = tool_calls_list or None
            else:
                # In raw_content mode, just add observation without tool_calls
                observation_results.append(
                    ObservationResult(
                        content=observation,
                    )
                )

            # Build the step object using Pydantic models
            if llm_response.model_name:
                self._last_response_model_name = llm_response.model_name
            self._trajectory_steps.append(
                Step(
                    step_id=len(self._trajectory_steps) + 1,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    source="agent",
                    model_name=llm_response.model_name or self._model_name,
                    message=message_content,
                    reasoning_content=llm_response.reasoning_content,
                    tool_calls=tool_calls,
                    observation=Observation(results=observation_results),
                    metrics=Metrics(
                        prompt_tokens=chat.total_input_tokens - tokens_before_input,
                        completion_tokens=chat.total_output_tokens
                        - tokens_before_output,
                        cached_tokens=cache_tokens_used
                        if cache_tokens_used > 0
                        else None,
                        cost_usd=step_cost if step_cost > 0 else None,
                        prompt_token_ids=llm_response.prompt_token_ids,
                        completion_token_ids=llm_response.completion_token_ids,
                        logprobs=llm_response.logprobs,
                    ),
                )
            )
```

**Non-obvious design decisions**

- The completion path uses a two-step gate around `_pending_completion`: the first `is_task_complete` claim flips `_pending_completion` to `True` and replaces the plain output with `_get_completion_confirmation_message(...)`, while a later `is_task_complete` when `_pending_completion` is already true leaves the flag unchanged and keeps raw `terminal_output`. This preserves a confirmation round instead of treating the first completion claim as final.
- The code records parsed text commands as synthetic `ToolCall` entries even though execution already happened through `_execute_commands(...)`. The comment ties this to trajectory analysis and tooling compatibility; the alternative would be to keep only free-form message text and lose structured command metadata.
- Raw-content mode disables only `tool_calls` creation. It still records `ObservationResult`, wraps it in `Observation`, computes `Metrics`, and appends a normal `Step`, which preserves trajectory continuity while avoiding a derived command structure.
- The metrics serializer stores `cached_tokens` and `cost_usd` only when their deltas are positive; otherwise it writes `None` instead of `0`. That keeps the trajectory from implying a meaningful cached-token or cost measurement when the computed delta is not above zero.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: Terminus2._execute_commands; Terminus2._get_completion_confirmation_message; Terminus2._limit_output_length; ToolCall; ObservationResult; Observation; Metrics; Step; datetime.now
- **Config / state sources**: self._session; self._pending_completion; self._save_raw_content_in_trajectory; self._model_name; self._trajectory_steps
- **Results to**: self._pending_completion; self._last_response_model_name; self._trajectory_steps
- **📊 Register interactions**: 👁 reads `reg-pending-completion` — snapshot before mutation; branch on current state; ✏️ writes `reg-pending-completion` — set True on first completion claim; ✏️ writes `reg-pending-completion` — set False on non-complete branch; ✏️ writes `reg-trajectory-steps` — append one agent Step record

</details>


<details id="fn-terminus2_execute_commands">
<summary><b>Terminus2._execute_commands</b> — terminus_2.py:1223-1253 · batch tmux command executor with timeout fallback</summary>

> **Stage context**: This helper handles the command-execution part of stage 4.9 before the stage builds an observation and appends a trajectory step. `_run_agent_loop` calls it after it has parsed the LLM response into `Command` objects. Its result feeds the sibling logic in `_run_agent_loop` that decides whether to show raw terminal output, a completion-confirmation prompt, or a warning-prefixed observation.

**What this code does**

`_execute_commands` runs each `Command` in `commands` against the provided `session` and returns a pair `(timeout_occurred, terminal_output)`. It reads `self._timeout_template` to format timeout feedback and uses `self._limit_output_length(...)` to bound any terminal text it returns. The function does not mutate Terminus state; its only external effect is sending keystrokes to the `TmuxSession` and reading incremental terminal output from that session.

**Interface · params / IO**

`async def _execute_commands(
        self,
        commands: list[Command],
        session: TmuxSession,
    ) -> tuple[bool, str]`

- params: `commands`: `list[Command]` — parsed terminal commands to execute in order; `session`: `TmuxSession` — active terminal session used to send keys and read output
- reads: `self._timeout_template`, `self._limit_output_length`
- returns: A `tuple[bool, str]`: `True` plus a formatted timeout message if any `session.send_keys(...)` raises `TimeoutError`, otherwise `False` plus the length-limited incremental terminal output after the batch.
- effects: awaits `session.send_keys(...)` for each command; awaits `session.get_incremental_output()` to read terminal output

**Execution flow**

1. Iterate through `commands` in order and call `await session.send_keys(command.keystrokes, block=False, min_timeout_sec=command.duration_sec)` for each one.
2. If `session.send_keys(...)` raises `TimeoutError`, stop the batch immediately and return `True` with `self._timeout_template.format(...)`, filling in `command.duration_sec`, `command.keystrokes`, and a bounded snapshot from `self._limit_output_length(await session.get_incremental_output())`.
3. If every command finishes without a timeout, fetch the latest incremental terminal text with `await session.get_incremental_output()`, pass it through `self._limit_output_length(...)`, and return that string with `False`.

**Source**

```python
    async def _execute_commands(
        self,
        commands: list[Command],
        session: TmuxSession,
    ) -> tuple[bool, str]:
        """Execute a batch of commands in the terminal.

        Args:
            commands: List of commands to execute
            session: TmuxSession instance

        Returns:
            Tuple of (timeout_occurred, terminal_output)
        """
        for command in commands:
            try:
                await session.send_keys(
                    command.keystrokes,
                    block=False,
                    min_timeout_sec=command.duration_sec,
                )
            except TimeoutError:
                return True, self._timeout_template.format(
                    timeout_sec=command.duration_sec,
                    command=command.keystrokes,
                    terminal_state=self._limit_output_length(
                        await session.get_incremental_output()
                    ),
                )

        return False, self._limit_output_length(await session.get_incremental_output())
```

**Non-obvious design decisions**

- It converts `TimeoutError` into ordinary text output instead of re-raising. That lets `_run_agent_loop` handle timeout feedback through the same observation path it uses for normal terminal output, rather than adding a separate exception path higher in the loop.
- It returns as soon as one command times out. That keeps the terminal state aligned with the failing command; continuing to later commands after a timeout would blur which command produced the problem and could compound terminal state drift.
- It always bounds returned terminal text with `self._limit_output_length(...)`, including the timeout branch. That trades away full terminal history to keep observations manageable for the downstream agent loop and trajectory recording.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: TmuxSession.send_keys; TmuxSession.get_incremental_output; Terminus2._limit_output_length
- **Config / state sources**: self._timeout_template; self._limit_output_length
- **Results to**: Terminus2._run_agent_loop receives `timeout_occurred`; Terminus2._run_agent_loop uses returned text as the basis for `observation`; stage-4.9 completion-confirmation logic consumes the returned terminal output; stage-4.9 trajectory append logic records the resulting observation in `reg-trajectory-steps` via `_run_agent_loop`
- **Related siblings**: Terminus2._run_agent_loop: consumes this helper's `(timeout_occurred, terminal_output)` and turns it into the stage's observation and trajectory step.

</details>
