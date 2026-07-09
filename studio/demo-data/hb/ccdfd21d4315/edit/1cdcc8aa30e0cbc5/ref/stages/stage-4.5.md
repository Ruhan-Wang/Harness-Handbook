### 4.5 · Pending Handoff Prompt → User Step (or Split)

#### (a) Opening Explanation

This stage exists to turn a generated handoff prompt into actual conversation history in the right form for the next stretch of work. Earlier stages may decide the agent needs a summary handoff prompt: a compact message that carries forward what matters after a summarization boundary. But that prompt is only sitting in a register. This stage is the point where the system commits it into the trajectory, which is the recorded sequence of steps the agent uses as history. It sits after the model response has been parsed, because only then does the system know whether a handoff is needed, and before later control flow, because the next iteration must see the right history shape.

#### (b) Main Flow

1. The stage checks `reg-pending-handoff-prompt`.

   If it is empty, there is nothing to do. If it has a value, the system has already decided that future work must continue from a summarized handoff rather than raw earlier history.

2. It then chooses between two ways to represent that handoff.

   In non-linear mode, the handoff is added directly as a `user` step. This makes the prompt explicit in the live trajectory, so the next model call can read it like any other user message.

3. In linear-history mode, it uses `_split_trajectory_on_summarization()` (cuts the current recorded run at the summary boundary and starts a fresh continuation record).

   This exists because linear history wants one clean, forward-only story. Instead of inserting an extra visible step, the system starts the next trajectory as if the handoff were the natural starting context.

4. After either path, it clears the pending prompt.

   That matters because the handoff is a one-time bridge. If it stayed around, later iterations could replay it and duplicate context.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-pending-handoff-prompt` — written earlier in the loop when a summary handoff prompt is produced and needs to be carried into history
- reads: `reg-pending-handoff-prompt` — used here to decide whether a handoff must be materialized, and whether to append a user step or split the trajectory
- clears: `reg-pending-handoff-prompt` — cleared after the handoff is committed so it is not applied again on a later iteration
- triggers downstream: `stage-4.8 Error Branch` — transition continues after this stage once the handoff has either been recorded or skipped

#### (d) Pipeline Hand-Off

Upstream stages produce a parsed response and, in some cases, a pending summary handoff prompt that says how the next context should begin. This stage turns that pending prompt into durable history—either as an explicit user step or as a new continuation trajectory—so downstream logic works with the correct conversation state rather than a temporary register.

<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1318-1354 · Consumes pending summarization artifacts into trajectory</summary>

> **Stage context**: This region implements the stage-4.6 handoff materialization step inside `Terminus2._run_agent_loop`. It runs after the summarization side flow may have populated deferred state, and before later loop stages append model or completion-related steps. In this stage, it works as the consumer for artifacts produced earlier by the summarization path: stage-4.5 records stored subagent references, and this region then handles the pending handoff prompt according to `_linear_history`.

**What this code does**

This region consumes two deferred pieces of summarization state: `_pending_subagent_refs` and `_pending_handoff_prompt`. If subagent refs exist, it appends a synthetic `Step` with `source="system"` to `_trajectory_steps`; if a handoff prompt exists, it either calls `_split_trajectory_on_summarization(...)` in linear-history mode or appends a `source="user"` step in non-linear mode. It always clears each pending field after consuming it, so the result is updated trajectory state rather than a direct return value.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `?` — Terminus2 instance holding pending summarization state and trajectory
- reads: `self._pending_subagent_refs`, `self._trajectory_steps`, `self._pending_handoff_prompt`, `self._linear_history`
- returns: None; the product is mutation of `_trajectory_steps` and clearing of pending summarization fields
- effects: appends a synthetic system `Step` to `self._trajectory_steps` when `self._pending_subagent_refs` is set; sets `self._pending_subagent_refs = None` after recording refs; may call `self._split_trajectory_on_summarization(self._pending_handoff_prompt)` in linear-history mode; appends a user `Step` to `self._trajectory_steps` when `self._pending_handoff_prompt` is set and `self._linear_history` is false; sets `self._pending_handoff_prompt = None` after consumption

**Execution flow**

1. Check `self._pending_subagent_refs`; when present, append a `Step` to `self._trajectory_steps` with `source="system"`, a fixed summarization message, and an `ObservationResult(subagent_trajectory_ref=self._pending_subagent_refs)` payload.
2. Clear `self._pending_subagent_refs` after recording the summarization reference step so the same refs do not get emitted again.
3. Check `self._pending_handoff_prompt`; when present, branch on `self._linear_history` to decide how the handoff enters trajectory state.
4. If `self._linear_history` is true, call `_split_trajectory_on_summarization(self._pending_handoff_prompt)` and rely on the split path to carry the handoff into the continuation trajectory instead of appending a local step.
5. If `self._linear_history` is false, append a `Step` to `self._trajectory_steps` with `source="user"` and `message=self._pending_handoff_prompt`.
6. Clear `self._pending_handoff_prompt` after either branch completes.

**Source**

```python
            if self._pending_subagent_refs:
                self._trajectory_steps.append(
                    Step(
                        step_id=len(self._trajectory_steps) + 1,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        source="system",
                        message="Performed context summarization and handoff to continue task.",
                        observation=Observation(
                            results=[
                                ObservationResult(
                                    subagent_trajectory_ref=self._pending_subagent_refs
                                )
                            ]
                        ),
                    )
                )
                self._pending_subagent_refs = None

            # Handle handoff prompt based on linear_history mode
            if self._pending_handoff_prompt:
                # If linear_history mode is enabled, split trajectory immediately WITHOUT adding handoff step
                # The handoff step will be added to the continuation trajectory during the split
                if self._linear_history:
                    self._split_trajectory_on_summarization(
                        self._pending_handoff_prompt
                    )
                else:
                    # For non-linear mode, add the handoff prompt as a user step
                    self._trajectory_steps.append(
                        Step(
                            step_id=len(self._trajectory_steps) + 1,
                            timestamp=datetime.now(timezone.utc).isoformat(),
                            source="user",
                            message=self._pending_handoff_prompt,
                        )
                    )
                self._pending_handoff_prompt = None
```

**Non-obvious design decisions**

- The `_linear_history` branch avoids appending the handoff prompt in the current trajectory before calling `_split_trajectory_on_summarization(...)`. The code comment makes the intent explicit: in linear history, the split boundary owns that handoff so the prompt appears only in the continuation record. Appending it here would duplicate or misplace the transition.
- The region records `_pending_subagent_refs` as a synthetic `source="system"` step with an `Observation` payload instead of folding those refs into the handoff prompt text. That keeps subagent provenance structured in `_trajectory_steps` and separate from the user-facing continuation message.
- Both pending fields are cleared immediately after consumption. This favors one-shot deferred registers over recomputation or idempotent rechecks; the alternative would risk replaying the same summarization artifacts on later loop passes.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: Step; Observation; ObservationResult; datetime.now; timezone.utc; Terminus2._split_trajectory_on_summarization
- **Config / state sources**: self._linear_history; self._pending_subagent_refs; self._pending_handoff_prompt; self._trajectory_steps
- **Results to**: reg-trajectory-steps; reg-pending-subagent-refs; reg-pending-handoff-prompt; later trajectory dumping in stage-4.9 and stage-5
- **Related siblings**: stage-4.5 consumes the same summarization event stream to record subagent refs under trajectory state; side-S1 produces both `_pending_subagent_refs` and `_pending_handoff_prompt` earlier in the iteration
- **📊 Register interactions**: 👁 reads `reg-pending-subagent-refs` — consume stored summarization subagent refs; ✏️ writes `reg-trajectory-steps` — append synthetic system summarization step; 🧹 clears `reg-pending-subagent-refs` — remove refs after recording; 👁 reads `reg-pending-handoff-prompt` — check for deferred handoff prompt; ✏️ writes `reg-trajectory-steps` — append user handoff in non-linear mode; 🧹 clears `reg-pending-handoff-prompt` — remove prompt after split or append

</details>


<details id="fn-terminus2_split_trajectory_on_summarization">
<summary><b>Terminus2._split_trajectory_on_summarization</b> — terminus_2.py:1895-1920 · Split trajectory at summarization continuation boundary</summary>

> **Stage context**: This helper implements the linear-history branch of stage `stage-4.6` when `_run_agent_loop` consumes `reg-pending-handoff-prompt`. Instead of appending a new user step, it closes the current trajectory segment and prepares a continuation trajectory that carries prior context forward. It is the stage's split mechanism behind the sibling summary that says `_run_agent_loop` may call `_split_trajectory_on_summarization(...)` rather than writing directly into `_trajectory_steps`.

**What this code does**

`_split_trajectory_on_summarization` cuts the current trajectory at the summarization boundary and prepares in-memory state for the continuation segment. It reads `_summarization_count`, `_session_id`, and, if present, `_chat.messages`; it writes a trajectory file through `_dump_trajectory_with_continuation_index`, updates `_session_id`, and replaces `_trajectory_steps` with copied-context steps derived from prior chat history. The `handoff_prompt` parameter is accepted by the interface but this body does not inspect it.

**Interface · params / IO**

`(self, handoff_prompt: str) -> None`

- params: `handoff_prompt`: `str` — handoff text passed from the summarization path; unused in this body
- reads: `self._summarization_count`, `self._session_id`, `self._chat`, `self._chat.messages`
- returns: None; the real product is persisted trajectory output plus updated continuation state in `self._session_id` and `self._trajectory_steps`.
- effects: Calls `self._dump_trajectory_with_continuation_index(...)` to write the finished trajectory segment; Writes `self._session_id` to a continuation id based on the current summarization count; Replaces `self._trajectory_steps` with converted steps from `self._chat.messages[:-1]` when `self._chat` is present

**Execution flow**

1. It dumps the current trajectory segment by calling `_dump_trajectory_with_continuation_index(self._summarization_count - 1)`, using `_summarization_count` to choose the continuation file index.
2. It rewrites `_session_id` to `"{base}-cont-{self._summarization_count}"`, where `base` comes from `self._session_id.split('-cont-')[0]` so any earlier continuation suffix is removed first.
3. If `_chat` exists, it rebuilds `_trajectory_steps` from `self._chat.messages[:-1]` via `_convert_chat_messages_to_steps(..., mark_as_copied=True)`.
4. That rebuilt trajectory intentionally excludes the last chat message, leaving the normal agent-loop path to append that response later rather than duplicating it here.

**Source**

```python
    def _split_trajectory_on_summarization(self, handoff_prompt: str) -> None:
        """Split trajectory on summarization when linear_history is enabled.

        Saves current trajectory segment and resets for continuation with full linear history.

        Args:
            handoff_prompt: The handoff prompt containing answers
        """
        # Save current trajectory segment before creating a continuation
        # When _summarization_count is 1, dump to trajectory.json (continuation_index = 0)
        # When _summarization_count is 2, dump to trajectory.cont-1.json (continuation_index = 1)
        self._dump_trajectory_with_continuation_index(self._summarization_count - 1)

        # Create new session_id for continuation
        self._session_id = (
            f"{self._session_id.split('-cont-')[0]}-cont-{self._summarization_count}"
        )

        # After dumping the trajectory till the summarization stage, reset trajectory by
        # converting from chat messages (excluding the last response which will be added
        # by the normal agent loop flow). Mark all these steps as copied context since they
        # were already present in the previous trajectory segment.
        if self._chat:
            self._trajectory_steps = self._convert_chat_messages_to_steps(
                self._chat.messages[:-1], mark_as_copied=True
            )
```

**Non-obvious design decisions**

- It computes the dump index as `_summarization_count - 1` because the file being closed is the pre-continuation segment, while the new `_session_id` uses the current `_summarization_count` for the segment that follows. Using the same number for both would blur the boundary between the finished file and the newly started continuation.
- It reconstructs `_trajectory_steps` from `_chat.messages` instead of carrying the old step list forward verbatim so the continuation starts from the live chat history and can mark those entries as copied context with `mark_as_copied=True`. Reusing the old list would not encode which steps were inherited from the prior segment.
- It slices `self._chat.messages[:-1]` rather than all messages because the last response belongs to the normal loop's later append path. Including it here would duplicate that response across the split boundary.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: Terminus2._dump_trajectory_with_continuation_index; Terminus2._convert_chat_messages_to_steps
- **Config / state sources**: self._summarization_count; self._session_id; self._chat.messages
- **Results to**: Persisted trajectory segment selected by `_dump_trajectory_with_continuation_index`; self._session_id for subsequent continuation output; self._trajectory_steps consumed by later trajectory appends and dumps in the main loop
- **Related siblings**: Terminus2._run_agent_loop: consumes `reg-pending-handoff-prompt` and chooses this helper in linear-history mode instead of appending a `source="user"` step
- **📊 Register interactions**: 👁 reads `reg-summarization-count` — choose dump index and continuation suffix; ✏️ writes `reg-trajectory-steps` — replace with copied-context continuation steps; 👁 reads `reg-chat-messages` — rebuild continuation steps from prior chat

</details>
