## 5 · Run Teardown

#### (a) Opening Explanation

This stage exists to turn a messy, just-finished run into a clean final record. By the time the agent loop stops, the system may have ended normally, returned early because the session died, or crashed with an exception. Teardown makes those endings look consistent from the outside. Its job is to gather the last run-wide facts, fold subagent usage into the main totals, attach final metadata, and write one last trajectory snapshot. It sits at the very end of `Terminus2.run()` inside the `finally` block, which means it runs no matter how the loop ended. Without it, the trial could finish with incomplete metrics, missing rollout details, or an on-disk record that stops one step too early.

#### (b) Main Flow

1. `Terminus2.run()` enters its `finally` block because the run is over, regardless of why it ended.  
   This is the stage boundary: final context cleanup and final record capture for the run.

2. It combines the main chat's rollout details with the separately collected subagent rollout details.  
   A subagent is a smaller helper agent called during the run. Its activity is tracked off to the side so the main chat stays clean while the loop is still active. Teardown is where those two views get merged into one trial-level story.

3. It folds subagent token usage into the final trial totals.  
   During the run, main-chat usage and subagent usage are tracked separately on purpose. That keeps per-chat accounting simple while the agent is working. At teardown, those numbers are added together so the final context reflects the true cost of the whole run, not just the main chat.

4. It sets the final cost field, but only if the result is meaningful.  
   If the computed cost is zero or below, the stored value becomes `None`. This avoids pretending there was a billable cost when there effectively was not.

5. It attaches final metadata such as episode count, API request times, and summarization count.  
   This is not new live state for the loop. It is a compact summary of what happened during the run, prepared for anything that reads the finished context later.

6. It optionally includes `all_messages` when `_store_all_messages` is enabled.  
   That branch is simple: if full message retention was requested, teardown adds them; if not, it leaves them out to save space and avoid over-recording.

7. `Terminus2._dump_trajectory()` (write the in-memory step history to disk) runs one last time.  
   The loop may already have dumped trajectory data incrementally, but this final write matters because teardown has just finalized the run-level context. Without this last dump, the file on disk could miss the final totals and end-state that only become complete here.

#### (c) 📊 State Flow

**📊 State Flow**

- reads: `reg-subagent-metrics` — read at teardown so subagent token and cost totals can be folded into the final run-level totals published on `context`
- reads: `reg-n-episodes` — read to publish the final episode count into `context.metadata`
- reads: `reg-summarization-count` — read to publish how many summarization passes happened during the run
- reads: `reg-api-request-times` — read to publish per-request latency history into `context.metadata`
- reads: `reg-trajectory-steps` — read by `_dump_trajectory()` so the final on-disk trajectory includes the complete recorded step sequence
- triggers downstream: `stage-6 Recording Post-process (External)` — after teardown has finalized `context` and written the final trajectory snapshot, external post-processing can consume that finished record

#### (d) Pipeline Hand-Off

Upstream stages leave this stage with a finished-or-aborted run, accumulated step history, and metrics still split across main-agent and subagent tracking. This stage turns that into a finalized `context` plus the last on-disk trajectory write, which the next step—an external post-process, not another internal loop stage—can treat as the authoritative trial record.

<details id="fn-terminus2_run">
<summary><b>Terminus2.run</b> — terminus_2.py:1637-1665 · Context totals and metadata finalization region</summary>

> **Stage context**: This region performs the stage's visible bookkeeping work on `context`. It runs after prior stage-5 translations would have finished any earlier teardown work, and it focuses on exporting accumulated run data plus making a final `_dump_trajectory()` call. This is the first translated entry in the stage, so there are no translated sibling cross-references yet.

**What this code does**

This region copies accumulated rollout and token-accounting data from `self` into `context`. It merges main-chat data from `self._chat` with subagent data from `self._subagent_rollout_details` and `self._subagent_metrics`, builds `context.metadata` from several counters, and optionally includes `self._chat.messages` when `self._store_all_messages` is true. It then calls `_dump_trajectory()`; the visible product of the region is updated `context` fields plus that method call.

**Interface · params / IO**

`(self, context, ...unseen...) -> unknown in this region`

- params: `self`: `?` — owner of chat, subagent accumulators, counters, and `_dump_trajectory()`; `context`: `?` — external result object that receives rollout details, token totals, cost, and metadata
- reads: `self._chat.rollout_details`, `self._subagent_rollout_details`, `self._chat.total_input_tokens`, `self._subagent_metrics.total_prompt_tokens`, `self._chat.total_output_tokens`, `self._subagent_metrics.total_completion_tokens`, `self._chat.total_cache_tokens`, `self._subagent_metrics.total_cached_tokens`, `self._chat.total_cost`, `self._subagent_metrics.total_cost_usd`, `self._n_episodes`, `self._api_request_times`, `self._summary_round_count`, `self._store_all_messages`, `self._chat.messages`
- returns: No return is visible in this region; its product is mutation of `context` and a call to `_dump_trajectory()`.
- effects: writes `context.rollout_details`; writes `context.n_input_tokens`; writes `context.n_output_tokens`; writes `context.n_cache_tokens`; writes `context.cost_usd`; writes `context.metadata`; conditionally writes `context.metadata["all_messages"]`; calls `self._dump_trajectory()`

**Execution flow**

1. Set `context.rollout_details` to the concatenation of `self._chat.rollout_details` and `self._subagent_rollout_details`.
2. Compute aggregate token totals by adding `self._chat` totals to the matching fields on `self._subagent_metrics`, then store them in `context.n_input_tokens`, `context.n_output_tokens`, and `context.n_cache_tokens`.
3. Add `self._chat.total_cost` and `self._subagent_metrics.total_cost_usd`, then store that value in `context.cost_usd` only when the sum is greater than zero; otherwise store `None`.
4. Build `context.metadata` with `n_episodes` from `self._n_episodes`, `api_request_times_msec` from `self._api_request_times`, and `summarization_count` from `self._summary_round_count`.
5. If `self._store_all_messages` is true, extend `context.metadata` with an `all_messages` entry taken from `self._chat.messages`.
6. Call `self._dump_trajectory()` after the `context` assignments.

**Source**

```python
            context.rollout_details = (
                self._chat.rollout_details + self._subagent_rollout_details
            )

            # Include subagent metrics in context totals
            context.n_input_tokens = (
                self._chat.total_input_tokens
                + self._subagent_metrics.total_prompt_tokens
            )
            context.n_output_tokens = (
                self._chat.total_output_tokens
                + self._subagent_metrics.total_completion_tokens
            )
            context.n_cache_tokens = (
                self._chat.total_cache_tokens
                + self._subagent_metrics.total_cached_tokens
            )
            total_cost = self._chat.total_cost + self._subagent_metrics.total_cost_usd
            context.cost_usd = total_cost if total_cost > 0 else None
            context.metadata = {
                "n_episodes": self._n_episodes,
                "api_request_times_msec": self._api_request_times,
                "summarization_count": self._summarization_count,
            }
            if self._store_all_messages:
                context.metadata["all_messages"] = self._chat.messages

            # Dump trajectory to JSON
            self._dump_trajectory()
```

**Non-obvious design decisions**

- The region keeps subagent accounting separate until export time: it reads main-chat totals from `self._chat` and subagent totals from `self._subagent_metrics`, then combines them only when filling `context`. That preserves the distinction in the internal accumulators while still publishing one set of totals.
- The cost field uses an explicit `total_cost > 0` check and writes `None` otherwise. This chooses a sentinel for zero-or-negative totals instead of always exposing a numeric value.
- The metadata dictionary is created in one assignment and then conditionally extended with `all_messages` under `if self._store_all_messages:`. That keeps the optional payload isolated behind one flag instead of mixing it into the base metadata shape.

**Relations**

- **Callers**: `Terminus2.run` region containing this snippet
- **Core callees**: `self._dump_trajectory()`
- **Config / state sources**: `self._store_all_messages` gates whether full chat history is exported; `self._chat` supplies rollout details, token totals, cost, and optional messages; `self._subagent_metrics` supplies subagent token and cost totals; `self._subagent_rollout_details` supplies additional rollout records; `self._summary_round_count` supplies the exported summarization_count metadata value
- **Results to**: `context.rollout_details`; `context.n_input_tokens`; `context.n_output_tokens`; `context.n_cache_tokens`; `context.cost_usd`; `context.metadata`; `self._dump_trajectory()` side effect
- **📊 Register interactions**: 👁 reads `reg-subagent-metrics` — fold subagent token and cost totals; 👁 reads `reg-n-episodes` — publish episode count into metadata; 👁 reads `reg-summary-round-count` — publish summarization count into metadata; 👁 reads `reg-api-request-times` — publish request timings into metadata; 👁 reads `reg-chat-messages` — read messages for optional all_messages export; 👁 reads `reg-trajectory-steps` — indirectly consumed by called `_dump_trajectory()`

</details>


<details id="fn-terminus2_dump_trajectory">
<summary><b>Terminus2._dump_trajectory</b> — terminus_2.py:1979-1981 · Wrapper for trajectory dump continuation index</summary>

> **Stage context**: This unit is a thin wrapper around `self._dump_trajectory_with_continuation_index(...)`. In this body, its only visible role is to supply `self._summary_round_count` as the argument instead of requiring a caller to provide that value.

**What this code does**

`_dump_trajectory` reads `self._summary_round_count` and passes it to `self._dump_trajectory_with_continuation_index(...)`. It returns `None` and does not directly write any `self` attributes or registers. Any serialization or I/O behavior belongs to the callee, not to this wrapper body.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `?` — Bound `Terminus2` instance that provides `_summary_round_count` and `_dump_trajectory_with_continuation_index`
- reads: `self._summary_round_count`, `self._dump_trajectory_with_continuation_index (method lookup and invocation)`
- returns: Returns `None`; the visible product of this body is the delegated call to `self._dump_trajectory_with_continuation_index(self._summary_round_count)`.
- effects: Invokes `self._dump_trajectory_with_continuation_index(self._summary_round_count)`; Writes no `self` fields or registers directly in this body

**Execution flow**

1. Read `self._summary_round_count` from the instance.
2. Call `self._dump_trajectory_with_continuation_index(...)` with that count as the sole argument.
3. Return `None` after the delegated call completes.

**Source**

```python
    def _dump_trajectory(self) -> None:
        """Dump trajectory data to JSON file following ATIF format."""
        self._dump_trajectory_with_continuation_index(self._summary_round_count)
```

**Non-obvious design decisions**

- The wrapper hardcodes `self._summary_round_count` as the continuation index instead of accepting an argument. That visible choice fixes the argument source at this call site and keeps callers from supplying a different index through this method.

**Relations**

- **Callers**: `Terminus2` methods that want the default continuation index wrapper
- **Core callees**: `Terminus2._dump_trajectory_with_continuation_index`
- **Config / state sources**: `self._summary_round_count`
- **Results to**: The delegated call to `self._dump_trajectory_with_continuation_index(...)`
- **Related siblings**: `Terminus2.run` calls `_dump_trajectory()` in the translated sibling synopsis
- **📊 Register interactions**: 👁 reads `reg-summary-round-count` — used as continuation index argument

</details>


<details id="fn-terminus2_dump_trajectory_with_continuation_index">
<summary><b>Terminus2._dump_trajectory_with_continuation_index</b> — terminus_2.py:1911-1977 · Serialize trajectory segment to JSON log</summary>

> **Stage context**: This helper is the file-writing end of trajectory dumping. The sibling `Terminus2._dump_trajectory` supplies the `continuation_index`; this function turns current in-memory state into a validated `Trajectory`, chooses the output filename, and writes JSON under `self.logs_dir`.

**What this code does**

`_dump_trajectory_with_continuation_index` builds a `Trajectory` record for the current run state and writes it to a JSON file. It requires a live `_context`; otherwise it logs a warning and returns without writing anything. The written file includes final token and cost totals, agent metadata, the current `steps`, and optional continuation linkage when `_linear_history` and the `continuation_index` rules apply. It returns `None`; its visible product is the file write plus debug or error logging.

**Interface · params / IO**

`(self, continuation_index: int) -> None`

- params: `continuation_index`: `int` — Index that controls continuation metadata and the output filename
- reads: `self._context`, `self._context.n_input_tokens`, `self._context.n_output_tokens`, `self._context.n_cache_tokens`, `self._context.cost_usd`, `self._parser_name`, `self._temperature`, `self._llm_kwargs`, `self._linear_history`, `self._summary_round_count`, `self._session_id`, `self._model_name`, `self._trajectory_steps`, `self.logs_dir`, `self.logger`, `self.name()`, `self.version()`
- returns: None; the real product is a trajectory JSON file written via `Trajectory(...).to_json_dict()`, `format_trajectory_json(...)`, and `f.write(...)`, or a logged warning/error when dumping does not proceed
- effects: logs a warning with `self.logger.warning(...)` and returns early when `self._context` is missing; writes a JSON file under `self.logs_dir`; logs a debug message with the chosen path after a successful write; logs an error message if opening, serializing, formatting, or writing raises inside the `try` block

**Execution flow**

1. It first checks `self._context`. If that attribute is falsy, it logs `"No context available, skipping trajectory dump"` through `self.logger.warning(...)` and returns.
2. It builds `final_metrics` from `_context` token and cost fields. The code preserves prompt and completion totals directly, uses `_context.n_cache_tokens or 0` for cached tokens, and converts falsy `_context.cost_usd` values to `None`.
3. It assembles `agent_extra` starting with `{"parser": self._parser_name}`. It adds `"temperature"` only when `self._temperature is not None`, adds `"llm_kwargs"` only when `self._llm_kwargs` is truthy, and adds `"continuation_index"` only when both `self._linear_history` and `continuation_index > 0` hold.
4. It initializes `continued_trajectory_ref = None`, then may replace it with `f"trajectory.cont-{continuation_index + 1}.json"` when `self._linear_history` is true and `continuation_index < self._summary_round_count`.
5. It constructs a `Trajectory` with `session_id=self._session_id`, an `Agent` built from `self.name()`, `self.version() or "unknown"`, `self._model_name`, and `agent_extra`, plus `steps=self._trajectory_steps`, the `final_metrics`, and the computed `continued_trajectory_ref`.
6. Before entering the `try/except`, it chooses the output path: `trajectory.cont-{continuation_index}.json` for linear-history continuation files (`self._linear_history` and `continuation_index > 0`), otherwise `trajectory.json`.
7. Inside the `try`, it opens the selected path for writing, serializes the model with `trajectory.to_json_dict()`, formats that JSON with `format_trajectory_json(...)`, writes the resulting string, and logs a debug message. Any exception from that block is caught and logged with `self.logger.error(...)`.

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

- The early `if not self._context` guard avoids emitting a partial file with no trial metrics source. The function chooses to skip the dump and record a warning instead of inventing defaults.
- The metric normalization is intentionally uneven: `_context.n_cache_tokens or 0` forces a numeric cached-token count, while `_context.cost_usd if self._context.cost_usd else None` turns any falsy cost into `None`. That preserves the distinction the code makes between token counts and an absent-or-falsy cost field.
- The `agent_extra` rules are precise and not all truthiness-based. `self._temperature` uses `is not None`, so `0` is preserved as a meaningful configured value, while `self._llm_kwargs` must be truthy before the function includes it.
- Continuation metadata is split across two branches on purpose. The file gets its own `continuation_index` only for continuation files (`continuation_index > 0`), while `continued_trajectory_ref` appears only when the current segment should point to a later one (`continuation_index < self._summary_round_count` under `_linear_history`).
- The broad `try/except Exception` wraps the actual file write and serialization path and converts failures into `self.logger.error(...)`. This keeps trajectory-dump failures from escaping this helper.

**Relations**

- **Callers**: `Terminus2._dump_trajectory`
- **Core callees**: `FinalMetrics(...)`; `Agent(...)`; `Trajectory(...)`; `trajectory.to_json_dict()`; `format_trajectory_json(...)`; `open(...)`; `self.logger.warning(...)`; `self.logger.debug(...)`; `self.logger.error(...)`; `self.name()`; `self.version()`
- **Config / state sources**: `self._parser_name`; `self._temperature`; `self._llm_kwargs`; `self._linear_history`; `self._model_name`; `self.logs_dir`; `self._summary_round_count`
- **Results to**: JSON file at `self.logs_dir / "trajectory.json"`; JSON file at `self.logs_dir / f"trajectory.cont-{continuation_index}.json"`; warning/debug/error log output through `self.logger`
- **Related siblings**: `Terminus2._dump_trajectory`: passes `self._summarization_count` as the `continuation_index` argument
- **📊 Register interactions**: 👁 reads `reg-summary-round-count` — checks `continuation_index < self._summary_round_count`; 👁 reads `reg-trajectory-steps` — passes current steps into `Trajectory(..., steps=...)`

</details>


<details id="fn-tmuxsession_stop">
<summary><b>TmuxSession.stop</b> — tmux_session.py:473-493 · stop remote asciinema and fetch local cast</summary>

> **Stage context**: This region is the recording-shutdown part of `TmuxSession.stop`. It runs only when `self._remote_asciinema_recording_path` is set, and it handles the final remote-to-local cast transfer when `self._local_asciinema_recording_path` is also set.

**What this code does**

This region attempts to stop an active remote asciinema recording and, when configured, downloads the finished cast file to a local path. It reads `self._remote_asciinema_recording_path` to decide whether to do any recording teardown, uses `self.send_keys(...)` and `self.environment.download_file(...)`, and may create the local parent directory for `self._local_asciinema_recording_path`. It returns no value; its visible product is the attempted recorder shutdown plus an optional local cast file.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `TmuxSession` — session object that holds recording paths, logger, and environment access
- reads: `self._remote_asciinema_recording_path`, `self._logger`, `self._local_asciinema_recording_path`, `self.environment`
- returns: None; the real product is sending `C-d`, waiting briefly, and optionally downloading the remote cast file to the local filesystem.
- effects: logs `Stopping recording.` with `self._logger.debug(...)`; awaits `self.send_keys(keys=["C-d"], min_timeout_sec=0.1)`; imports `asyncio` inside the branch and awaits `asyncio.sleep(0.5)`; may create `self._local_asciinema_recording_path.parent` with `mkdir(parents=True, exist_ok=True)`; may download a file with `self.environment.download_file(source_path=str(self._remote_asciinema_recording_path), target_path=self._local_asciinema_recording_path)`

**Execution flow**

1. Check `self._remote_asciinema_recording_path`; if it is falsy, this region does nothing.
2. Log `Stopping recording.` and attempt recorder shutdown by awaiting `self.send_keys(keys=["C-d"], min_timeout_sec=0.1)`.
3. Import `asyncio` inside this branch and await `asyncio.sleep(0.5)` to pause before any file transfer.
4. If `self._local_asciinema_recording_path` is set, create its parent directory with `parents=True, exist_ok=True`.
5. Still in that local-path branch, call `self.environment.download_file(...)` with `source_path=str(self._remote_asciinema_recording_path)` and `target_path=self._local_asciinema_recording_path`.

**Source**

```python
        if self._remote_asciinema_recording_path:
            self._logger.debug("Stopping recording.")
            await self.send_keys(
                keys=["C-d"],
                min_timeout_sec=0.1,
            )

            # Wait a moment for the recording to finish writing
            import asyncio

            await asyncio.sleep(0.5)

            if self._local_asciinema_recording_path:
                self._local_asciinema_recording_path.parent.mkdir(
                    parents=True, exist_ok=True
                )
                # Ensure recording exists locally before merging markers
                await self.environment.download_file(
                    source_path=str(self._remote_asciinema_recording_path),
                    target_path=self._local_asciinema_recording_path,
                )
```

**Non-obvious design decisions**

- The code waits `0.5` seconds after sending `C-d` because the inline comment says it wants to give the recording time to finish writing before download.
- It creates the local parent directory only when `self._local_asciinema_recording_path` exists, so local filesystem setup stays tied to the download path branch.
- It converts `self._remote_asciinema_recording_path` with `str(...)` at the `download_file` call site, which matches the callee's `source_path` argument shape used here without changing how the path is stored on `self`.

**Relations**

- **Callers**: `TmuxSession.stop`
- **Core callees**: `self.send_keys`; `asyncio.sleep`; `self.environment.download_file`; `Path.mkdir` on `self._local_asciinema_recording_path.parent`
- **Config / state sources**: `self._remote_asciinema_recording_path` gates all work; `self._local_asciinema_recording_path` gates directory creation and download; `self.environment` supplies file transfer; `self._logger` supplies debug logging
- **Results to**: remote recording process via `send_keys(keys=["C-d"], min_timeout_sec=0.1)`; local filesystem under `self._local_asciinema_recording_path.parent`; local cast file at `self._local_asciinema_recording_path` when download runs; debug log output

</details>
