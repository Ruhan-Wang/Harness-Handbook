## 4 · Iteration Loop ★ Core ★

#### (a) Opening Explanation

This stage exists to give the agent a controlled place to think, act, observe results, and decide whether to continue. It is the core work loop of Terminus 2. A single prompt is not enough for real terminal work, because the agent often needs several rounds: inspect the machine, ask the LLM (the language model), run commands, read outputs, and revise the plan. This loop owns that repeat-until-done behavior. It sits after run setup and before final result packaging. Its job is to keep progress moving across iterations while carrying just enough state from one turn to the next: completion confirmation, summary handoff when context gets too large, and the growing trajectory record of what happened.

#### (b) Main Flow

1. `run()` (the top-level entry point for one task) hands control to `_run_agent_loop()` because this is where actual task progress happens, not setup.

2. `_run_agent_loop()` runs the agent in repeated episodes. Each episode is one full pass through the in-iteration stages: check whether the session is still usable, gather context, query the LLM, record what happened, and decide whether to stop.

3. The loop exists because terminal work is incremental. The agent rarely knows the full answer up front. It needs a place to react to new command output and keep adjusting.

4. This stage also owns the stop conditions. It can end because:
   - the task looks complete twice in a row, which is a guard against false finishes,
   - the tmux session (a terminal you can drive remotely) dies,
   - or the maximum number of episodes is reached.

5. It carries cross-iteration memory in a few small registers instead of recomputing everything each time. That is important for two reasons:
   - completion needs a two-step confirmation,
   - and long runs may need a summary handoff when the LLM context gets too full.

6. `_record_asciinema_marker()` (records timestamped labels for terminal replay) supports observability, not decision-making. It helps later stages and humans understand where important moments happened in the run.

7. `_dump_trajectory()`, and `_dump_trajectory_with_continuation_index()` (write the run history to disk, with support for split or continued histories), exist so the loop leaves behind a durable record. That matters because the loop is the main source of truth about what the agent tried, saw, and concluded.

8. In short, this stage is the agent’s heartbeat. Without it, the system would have setup and teardown, but no place where real multi-step work happens.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-n-episodes` — incremented at loop entry so the system knows which iteration it is on and can report that later in metadata
- writes: `reg-pending-completion` — set when the agent first believes the task is complete, so the next iteration can confirm before returning
- writes: `reg-pending-handoff-prompt` — set when the run needs a summary handoff because context is getting too large; this preserves continuity into the next iteration
- writes: `reg-pending-subagent-refs` — set alongside the handoff prompt so later stages can record references to summarization subagents in the trajectory
- writes: `reg-trajectory-steps` — appended throughout the loop as the canonical history of system notes, user-facing handoff material, assistant actions, and completion checks
- writes: `reg-asciinema-markers` — updated when markers are recorded so terminal replay can later show notable points in the run
- writes: `reg-api-request-times` — appended during LLM calls so the final run metadata can describe API timing
- reads: `reg-pending-completion` — checked to tell the difference between “first time we think we are done” and “confirmed done, now return”
- reads: `reg-pending-handoff-prompt` — consumed on the next iteration to inject the summary handoff into the working history
- reads: `reg-pending-subagent-refs` — consumed on the next iteration to log the summarization subagent outputs into the trajectory
- reads: `reg-trajectory-steps` — used when dumping the trajectory so the current run history is persisted
- clears: `reg-pending-handoff-prompt` — cleared after the handoff is consumed so the same summary is not replayed again
- clears: `reg-pending-subagent-refs` — cleared after those refs are recorded so they are not duplicated
- triggers downstream: `stage-4.1 Loop Entry Gates` — each new episode enters the per-iteration pipeline
- triggers downstream: `stage-5` — when the loop ends by confirmed completion, dead session, or episode limit, final result packaging takes over

#### (d) Pipeline Hand-Off

Upstream, stage 3 gives this loop a clean per-run state and a live task context. This stage turns that starting state into the full run history, stop decision, and carry-over registers that the inner sub-stages use each iteration, then hands the finished trajectory and metadata-ready state to downstream finalization in stage 5.

<details id="fn-terminus2_run">
<summary><b>Terminus2.run</b> — terminus_2.py:1638-1644 · enter core agent iteration loop</summary>

> **Stage context**: This region hands execution from `Terminus2.run` into stage 4's main loop. It runs when `run` reaches the `try` block that wraps the core work phase, and it delegates to `_run_agent_loop` with the prepared prompt, active chat object, logging directory, and instruction text. As the first translated entry in this stage, it is the stage boundary handoff rather than an in-loop step.

**What this code does**

This region awaits `self._run_agent_loop(...)` to start the main agent iteration loop. It passes four named inputs: local `initial_prompt`, `self._chat`, `self.logs_dir`, and local `instruction`. The shown code does not use any immediate return value from `_run_agent_loop`; its visible effect is the transfer of control into that coroutine inside a surrounding `try` block.

**Interface · params / IO**

`(self, instruction) -> ?`

- params: `instruction`: `?` — original user instruction from `Terminus2.run`
- reads: `self._chat`, `self.logs_dir`
- returns: The shown region does not return a value; it awaits `_run_agent_loop(...)` and ignores any immediate result in these lines.
- effects: enters `self._run_agent_loop`; passes control into the stage-4 core loop within a `try` block

**Execution flow**

1. Enter the `try` block in `Terminus2.run` and prepare to delegate to the core loop.
2. Await `self._run_agent_loop` using keyword arguments: `initial_prompt=initial_prompt`, `chat=self._chat`, `logging_dir=self.logs_dir`, and `original_instruction=instruction`.
3. Do not capture or use any direct return value from `_run_agent_loop` in the shown region.

**Source**

```python
        try:
            await self._run_agent_loop(
                initial_prompt=initial_prompt,
                chat=self._chat,
                logging_dir=self.logs_dir,
                original_instruction=instruction,
            )
```

**Non-obvious design decisions**

- The call uses explicit keyword arguments, not positional arguments. That makes the handoff contract visible at the call site: `_run_agent_loop` receives four separately named inputs.
- The code passes both local `initial_prompt` and local `instruction` as distinct arguments (`initial_prompt` and `original_instruction`). The region preserves them as separate channels instead of collapsing them into one value.
- The delegation sits inside a `try` block. This region shows that exceptions from `_run_agent_loop` are meant to flow to later handlers in `run`, rather than being handled at the call expression itself.

**Relations**

- **Callers**: Terminus2.run
- **Core callees**: Terminus2._run_agent_loop
- **Config / state sources**: local `initial_prompt` from earlier setup in `Terminus2.run`; `self._chat`; `self.logs_dir`; method parameter `instruction`
- **Results to**: control transfers into `Terminus2._run_agent_loop`; exceptions propagate to later `try` handlers in `Terminus2.run` that are not shown here

</details>


<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1355-1367 · Agent message-content selection branch</summary>

> **Stage context**: This region sits inside `Terminus2._run_agent_loop`'s core iteration logic and prepares the local text payload stored in `message_content`. It runs after earlier code has produced `llm_response`, `analysis`, and `plan`, and before later code in the same loop can use that local result. Relative to the already translated `Terminus2.run`, this is one internal branch within the loop that `run` hands control to.

**What this code does**

This region chooses the local `message_content` value from two sources. If `self._save_raw_content_in_trajectory` is true, it copies `llm_response.content` verbatim. Otherwise, it builds labeled text from truthy `analysis` and `plan`, joining present parts with `"\n"`, or falling back to `""` when neither value is present.

**Interface · params / IO**

`region locals: reads `self._save_raw_content_in_trajectory`, `llm_response.content`, `analysis`, `plan`; writes local `message_content` (`message_parts` only in the non-raw branch); no return in this snippet`

- params: `llm_response.content`: `?` — raw LLM text copied directly when `self._save_raw_content_in_trajectory` is enabled; `analysis`: `?` — optional local text included as `Analysis: ...` in the structured branch when truthy; `plan`: `?` — optional local text included as `Plan: ...` in the structured branch when truthy
- reads: `self._save_raw_content_in_trajectory`
- returns: none; this snippet's product is the local assignment to `message_content`
- effects: writes local `message_content`; writes local `message_parts` only when `self._save_raw_content_in_trajectory` is false

**Execution flow**

1. Check `self._save_raw_content_in_trajectory` to select raw-versus-structured message construction.
2. In the raw branch, assign `message_content = llm_response.content` with no parsing, relabeling, or fallback handling.
3. In the structured branch, create local `message_parts = []` and append `f"Analysis: {analysis}"` only if `analysis` is truthy.
4. Still in the structured branch, append `f"Plan: {plan}"` only if `plan` is truthy, then assign `message_content` to `"\n".join(message_parts)` when any parts exist, else `""`.

**Source**

```python

            # Create message content from analysis and plan, or use raw response if raw_content is enabled
            if self._save_raw_content_in_trajectory:
                # Use the raw LLM response content for SFT data export
                message_content = llm_response.content
            else:
                # Parse into structured format (analysis + plan)
                message_parts = []
                if analysis:
                    message_parts.append(f"Analysis: {analysis}")
                if plan:
                    message_parts.append(f"Plan: {plan}")
                message_content = "\n".join(message_parts) if message_parts else ""
```

**Non-obvious design decisions**

- The `self._save_raw_content_in_trajectory` switch preserves `llm_response.content` exactly in one mode. That avoids any loss or reshaping of the model output that would happen if the code always rebuilt text from `analysis` and `plan` labels.
- The structured branch includes `analysis` and `plan` only when each value is truthy. That prevents empty labeled lines such as `Analysis: ` or `Plan: ` from appearing when one field is missing.
- The structured branch falls back to `""` when `message_parts` stays empty. That makes the absence of both `analysis` and `plan` explicit without inventing placeholder text.

**Relations**

- **Callers**: `Terminus2._run_agent_loop` enclosing iteration body; `Terminus2.run` indirectly, by awaiting `_run_agent_loop`
- **Core callees**: `message_parts.append`; `"\n".join`
- **Config / state sources**: `self._save_raw_content_in_trajectory`
- **Results to**: local `message_content` in the enclosing `_run_agent_loop` scope; local `message_parts` in the structured branch
- **Related siblings**: `Terminus2.run`: transfers control into `_run_agent_loop`

</details>


<details id="fn-terminus2_record_asciinema_marker">
<summary><b>Terminus2._record_asciinema_marker</b> — terminus_2.py:1995-1996 · No-op asciinema marker hook</summary>

> **Stage context**: This helper sits in stage 4 as the marker-recording hook that `_run_agent_loop` can call when an iteration reaches a point worth labeling in the terminal recording. In the current code, it does not participate in the loop's state machine and produces no marker output. It relates to its siblings by preserving the call shape that stage-4.7 uses, while leaving the rest of `_run_agent_loop` unchanged.

**What this code does**

`_record_asciinema_marker` accepts `marker_text: str` and immediately returns `None`. It does not inspect `marker_text`, read any `self` state, or write any instance or external state. Its visible behavior is therefore a deliberate no-op at the marker insertion points used by `_run_agent_loop`.

**Interface · params / IO**

`(self, marker_text: str) -> None`

- params: `marker_text`: `str` — Requested marker label from the caller
- returns: Returns `None`; it produces no side effect.

**Execution flow**

1. Receive the `marker_text` argument from the caller.
2. Return immediately without using `marker_text` and without touching any `self._*` state.

**Source**

```python
    def _record_asciinema_marker(self, marker_text: str) -> None:
        return
```

**Non-obvious design decisions**

- The method keeps a dedicated `_record_asciinema_marker(...)` hook even though the body is only `return`. This preserves a stable call site for `_run_agent_loop` instead of forcing marker-related conditionals into the loop itself.
- The implementation ignores `marker_text` on purpose. That choice avoids partial or hidden marker behavior; any real recording logic would need to be added explicitly rather than inferred from the method name.

**Relations**

- **Callers**: `Terminus2._run_agent_loop` at stage-4.7 marker points
- **Core callees**: none; the body only executes `return`
- **Config / state sources**: none; it reads no `self._*` attributes; `marker_text` parameter supplied by the caller
- **Results to**: Returns `None` to the immediate caller; Leaves `reg-asciinema-markers` unchanged; Leaves the surrounding `_run_agent_loop` control flow to continue normally
- **Related siblings**: `Terminus2._run_agent_loop` uses this hook inside the main iteration loop; `Terminus2.run` reaches this helper only indirectly by entering `_run_agent_loop`

</details>


<details id="fn-terminus2_dump_trajectory">
<summary><b>Terminus2._dump_trajectory</b> — terminus_2.py:1990-1992 · Trajectory dump wrapper using summarization count</summary>

> **Stage context**: This entry is a thin wrapper around `_dump_trajectory_with_continuation_index`. In the visible code, its role is only to forward one piece of instance state, `self._summarization_count`, into that helper and return `None`.

**What this code does**

`_dump_trajectory` takes only `self` and performs no work of its own beyond one delegated call. It reads `self._summarization_count`, passes that value to `_dump_trajectory_with_continuation_index(...)`, and returns `None`. Any JSON creation, file output, or other persistence effects happen inside the callee, not in this wrapper.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `?` — Terminus2 instance providing `_summarization_count` and the dump helper
- reads: `self._summarization_count`
- returns: Returns `None`; its visible product is delegating the dump request to `_dump_trajectory_with_continuation_index`.
- effects: Invokes `self._dump_trajectory_with_continuation_index(self._summarization_count)`; Has no direct state writes of its own; any external effects are delegated to the callee

**Execution flow**

1. Read the current `self._summarization_count` value from instance state.
2. Call `self._dump_trajectory_with_continuation_index(...)` and pass `self._summarization_count` as the single argument.
3. Return `None` without any additional local processing.

**Source**

```python
    def _dump_trajectory(self) -> None:
        """Dump trajectory data to JSON file following ATIF format."""
        self._dump_trajectory_with_continuation_index(self._summarization_count)
```

**Non-obvious design decisions**

- The wrapper hardcodes `self._summarization_count` as the argument source instead of accepting a continuation index parameter. The visible effect is that callers of `_dump_trajectory` cannot supply a different index through this wrapper.
- The function delegates all dump work to `_dump_trajectory_with_continuation_index` rather than implementing serialization logic inline. In this snippet, `_dump_trajectory` acts only as a forwarding entry point.

**Relations**

- **Callers**: Unspecified callers that want the default continuation-indexed trajectory dump
- **Core callees**: Terminus2._dump_trajectory_with_continuation_index
- **Config / state sources**: self._summarization_count
- **Results to**: _dump_trajectory_with_continuation_index receives the forwarded continuation index; Any persisted trajectory output is produced by the callee, not by this wrapper
- **📊 Register interactions**: 👁 reads `reg-summarization-count` — forwards current count to dump helper

</details>


<details id="fn-terminus2_dump_trajectory_with_continuation_index">
<summary><b>Terminus2._dump_trajectory_with_continuation_index</b> — terminus_2.py:1922-1988 · trajectory JSON writer with continuation metadata</summary>

> **Stage context**: This helper is the concrete write path behind the stage's trajectory-dump checkpoints. `Terminus2._dump_trajectory` forwards `self._summarization_count` into it, while this function handles the actual JSON assembly, filename choice, and disk write. It sits beside the no-op marker recorder and provides the durable artifact for the loop's in-memory trajectory state.

**What this code does**

`_dump_trajectory_with_continuation_index` serializes the current trajectory into a JSON file, using the `continuation_index` argument plus runtime state from `self`. It reads token and cost totals from `_context`, builds `Agent`, `FinalMetrics`, and `Trajectory` models, chooses either `trajectory.json` or `trajectory.cont-<n>.json`, and writes the formatted JSON to disk. If `_context` is falsy, it logs a warning and returns without writing. It does not mutate agent state and returns `None`.

**Interface · params / IO**

`(self, continuation_index: int) -> None`

- params: `continuation_index`: `int` — continuation number used in metadata and filename selection
- reads: `self._context.n_input_tokens`, `self._context.n_output_tokens`, `self._context.n_cache_tokens`, `self._context.cost_usd`, `self._parser_name`, `self._temperature`, `self._llm_kwargs`, `self._linear_history`, `self._summarization_count`, `self._session_id`, `self._model_name`, `self._trajectory_steps`, `self.logs_dir`, `self.logger`
- returns: Returns `None`; its real product is a trajectory JSON file written to `self.logs_dir`, or only log output if it skips or fails.
- effects: logs a warning through `self.logger.warning(...)` and returns early when `self._context` is falsy; opens the chosen trajectory path with `open(trajectory_path, "w")`, which overwrites any existing file; writes formatted JSON with `f.write(json_str)` inside a `with open(..., "w") as f` block; logs success through `self.logger.debug(...)` after a successful write; logs failure through `self.logger.error(...)` if any exception is raised in the write block

**Execution flow**

1. It first checks `if not self._context:`. On that branch, it emits `self.logger.warning("No context available, skipping trajectory dump")` and returns immediately.
2. On the write path, it builds `FinalMetrics` from `_context.n_input_tokens`, `_context.n_output_tokens`, `_context.n_cache_tokens or 0`, and `_context.cost_usd if self._context.cost_usd else None`.
3. It builds `agent_extra` starting with `{"parser": self._parser_name}` and then conditionally adds `temperature`, `llm_kwargs`, and `continuation_index` only when `self._temperature is not None`, `self._llm_kwargs` is truthy, and `self._linear_history and continuation_index > 0` respectively.
4. It computes `continued_trajectory_ref` as `None` by default, then changes it to `f"trajectory.cont-{continuation_index + 1}.json"` only when `self._linear_history` is true and `continuation_index < self._summarization_count`.
5. It constructs a `Trajectory` model from `self._session_id`, an `Agent` built from `self.name()`, `self.version() or "unknown"`, `self._model_name`, and `agent_extra`, plus `self._trajectory_steps`, the `FinalMetrics`, and the computed `continued_trajectory_ref`.
6. It chooses the output path: `self.logs_dir / f"trajectory.cont-{continuation_index}.json"` when `self._linear_history and continuation_index > 0`, otherwise `self.logs_dir / "trajectory.json"`.
7. Inside `try:`, it enters `with open(trajectory_path, "w") as f:`, calls `format_trajectory_json(trajectory.to_json_dict())` to produce `json_str`, and then writes that string with `f.write(json_str)`.
8. If the write succeeds, it logs `self.logger.debug(f"Trajectory dumped to {trajectory_path}")`; if any exception is raised in the `try` block, it catches it and logs `self.logger.error(f"Failed to dump trajectory: {e}")`.

**Source**

```python
    def _dump_trajectory_with_continuation_index(self, continuation_index: int) -> None:
        """Dump trajectory data to JSON file with specified continuation index.

        Args:
            continuation_index: The continuation index to use for filename and metadata.
                               For the initial trajectory, use 0.
                               For the first continuation, use 1, etc.
        """
        if not self._context:
            self.logger.warning("No context available, skipping trajectory dump")
            return

        # Construct the trajectory using Pydantic models for validation
        final_metrics = FinalMetrics(
            total_prompt_tokens=self._context.n_input_tokens,
            total_completion_tokens=self._context.n_output_tokens,
            total_cached_tokens=self._context.n_cache_tokens or 0,
            total_cost_usd=self._context.cost_usd if self._context.cost_usd else None,
        )

        agent_extra: dict[str, Any] = {
            "parser": self._parser_name,
        }
        if self._temperature is not None:
            agent_extra["temperature"] = self._temperature
        if self._llm_kwargs:
            agent_extra["llm_kwargs"] = self._llm_kwargs
        if self._linear_history and continuation_index > 0:
            agent_extra["continuation_index"] = continuation_index

        # Determine if this trajectory will be continued
        # In linear_history mode, when saving during summarization (i.e., continuation_index < _summarization_count),
        # this trajectory will have a continuation
        continued_trajectory_ref = None
        if self._linear_history and continuation_index < self._summarization_count:
            # This trajectory segment will be continued in the next file
            next_continuation_index = continuation_index + 1
            continued_trajectory_ref = f"trajectory.cont-{next_continuation_index}.json"

        trajectory = Trajectory(
            session_id=self._session_id,
            agent=Agent(
                name=self.name(),
                version=self.version() or "unknown",
                model_name=self._model_name,
                extra=agent_extra,
            ),
            steps=self._trajectory_steps,
            final_metrics=final_metrics,
            continued_trajectory_ref=continued_trajectory_ref,
        )

        # Determine trajectory filename based on continuation index
        if self._linear_history and continuation_index > 0:
            trajectory_path = (
                self.logs_dir / f"trajectory.cont-{continuation_index}.json"
            )
        else:
            trajectory_path = self.logs_dir / "trajectory.json"

        try:
            with open(trajectory_path, "w") as f:
                json_str = format_trajectory_json(trajectory.to_json_dict())
                f.write(json_str)
            self.logger.debug(f"Trajectory dumped to {trajectory_path}")
        except Exception as e:
            self.logger.error(f"Failed to dump trajectory: {e}")
```

**Non-obvious design decisions**

- The function gates all serialization work on `if not self._context:`. That branch makes the missing-context case visible through a warning log and prevents any attempt to read `_context` fields.
- It uses conditional inserts into `agent_extra` rather than populating every possible key. As written, `temperature`, `llm_kwargs`, and `continuation_index` are absent unless their branch conditions pass.
- It uses two separate continuation-related conditions: one controls whether `agent_extra["continuation_index"]` appears (`_linear_history and continuation_index > 0`), and another controls whether `continued_trajectory_ref` points at the next file (`_linear_history and continuation_index < self._summarization_count`).
- The file write sits inside a broad `except Exception as e:` block that only logs the error. In this function, write failures do not propagate to the caller.

**Relations**

- **Callers**: `Terminus2._dump_trajectory`
- **Core callees**: `FinalMetrics(...)`; `Agent(...)`; `Trajectory(...)`; `self.name()`; `self.version()`; `format_trajectory_json(...)`; `trajectory.to_json_dict()`; `open(...)`; `f.write(...)`
- **Config / state sources**: `self._parser_name`; `self._temperature`; `self._llm_kwargs`; `self._linear_history`; `self._model_name`; `self.logs_dir`
- **Results to**: writes `self.logs_dir / "trajectory.json"`; writes `self.logs_dir / f"trajectory.cont-{continuation_index}.json"` when `_linear_history` and `continuation_index > 0`; emits debug/warning/error messages through `self.logger`
- **Related siblings**: `Terminus2._dump_trajectory` is the thin wrapper that passes `self._summarization_count` into this function
- **📊 Register interactions**: 👁 reads `reg-summarization-count` — compares against `continuation_index` for continuation ref; 👁 reads `reg-trajectory-steps` — serializes current step list into `Trajectory`

</details>
