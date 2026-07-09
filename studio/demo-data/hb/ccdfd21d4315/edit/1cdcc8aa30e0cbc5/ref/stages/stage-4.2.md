### 4.2 · Proactive Summarize Probe

#### (a) Opening Explanation

This stage exists to catch context pressure early and prepare a summary handoff before the next LLM call fails or becomes inefficient. In plain terms, it asks: “Do we still have enough room in the model’s context window, or should we compress the conversation now?” Its job is not to record anything yet. Its job is to decide whether proactive summarization is needed and, if so, stage the resulting summary artifacts for later recording. It sits just before the main LLM query on purpose. That placement gives the agent one last chance to shrink history before sending another prompt, while still keeping the current iteration’s bookkeeping consistent.

#### (b) Main Flow

1. This stage first checks whether proactive summarization is even allowed.  
   It only runs when there is an `original_instruction` to anchor the summary to, and when proactive summarization is enabled.

2. Then it calls `_check_proactive_summarization()` (check remaining context room, and if needed run summarization).  
   This is the key control point:

   - **If there is still enough context space:** do nothing and continue normally.
   - **If space is below the threshold:** this helper does not just return a warning flag. It runs the full summarization side flow, `side-S1`, and gets back summary artifacts.

3. If summarization happened, this stage stores the returned artifacts in pending registers.  
   Those artifacts are:
   - a **handoff prompt**: the summary text that can stand in for older conversation history
   - **subagent refs**: references to work done by subagents (smaller helper agents invoked by the main agent)

4. It does **not** write the trajectory record itself.  
   That delay is intentional. The agent is still in the middle of an iteration, so this stage only stages the artifacts. Later recorder stages decide how to write them into history in a consistent way.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-pending-handoff-prompt` — written only when proactive summarization actually runs, so a later recorder stage can persist the summary handoff in this same iteration
- writes: `reg-pending-subagent-refs` — written alongside the handoff prompt when summarization runs, so later recording can preserve references to subagent work
- triggers downstream: `stage-4.3 LLM Query` — always continues here after the check, whether the result was “no summary needed” or “summary artifacts staged”

#### (d) Pipeline Hand-Off

Upstream, this stage inherits a live chat history plus the original task instruction, right after loop-entry checks have allowed the iteration to proceed. It produces either nothing or a staged summary handoff package; then the pipeline moves on in two steps: first to the normal `stage-4.3 LLM Query`, and later in the same iteration to recorder stages 4.5 / 4.6, which consume the pending artifacts and write them into the trajectory.

<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1283-1294 · Proactive summarization probe and deferred handoff staging</summary>

> **Stage context**: This region is the stage-4.2 gate for proactive summarization inside `Terminus2._run_agent_loop`. It runs only when both `original_instruction` and `self._enable_summarize` are truthy, and it delegates the actual probe to `_check_proactive_summarization(...)`. If that helper returns a truthy result, this region stages the returned prompt and subagent references on pending `self._` fields for later handling elsewhere in the loop.

**What this code does**

This region conditionally checks whether proactive summarization should run, using `chat`, `original_instruction`, and `self._session`. When `_check_proactive_summarization(...)` returns a truthy `(prompt, subagent_refs)` pair, it stores `subagent_refs` in `self._pending_subagent_refs` and `prompt` in `self._pending_handoff_prompt`. If either gate is false, or the helper returns a falsy value, this region leaves state unchanged.

**Interface · params / IO**

`region interface within `Terminus2._run_agent_loop`: uses `(self, chat, original_instruction)` -> no direct return; may write pending summarization state`

- params: `self`: `Terminus2` — owner object; supplies summarization config, session, and pending-state fields; `chat`: `?` — active chat state passed into `_check_proactive_summarization(...)`; `original_instruction`: `?` — truthiness gate and original user instruction passed to the summarization probe
- reads: `self._enable_summarize`, `self._session`
- returns: none; the product is conditional writes to pending summarization fields
- effects: awaits `self._check_proactive_summarization(chat, original_instruction, self._session)` when both gates are truthy; writes `self._pending_subagent_refs` when the helper returns a truthy result; writes `self._pending_handoff_prompt` when the helper returns a truthy result

**Execution flow**

1. Check the two gates: `original_instruction` must be truthy and `self._enable_summarize` must be truthy.
2. When both gates pass, await `_check_proactive_summarization(chat, original_instruction, self._session)` and capture its return in `proactive_summary_result`.
3. Test `proactive_summary_result` by truthiness, not by an explicit `is not None` check.
4. When the result is truthy, unpack it into `prompt, subagent_refs` and store `subagent_refs` in `self._pending_subagent_refs`.
5. Store `prompt` in `self._pending_handoff_prompt`, matching the inline comments that these values are deferred for later addition as a system step and a user step.

**Source**

```python
            if original_instruction and self._enable_summarize:
                proactive_summary_result = await self._check_proactive_summarization(
                    chat,
                    original_instruction,
                    self._session,
                )
                if proactive_summary_result:
                    prompt, subagent_refs = proactive_summary_result
                    # Store subagent_refs to add a system step later
                    self._pending_subagent_refs = subagent_refs
                    # Also store the handoff prompt to add as a user step
                    self._pending_handoff_prompt = prompt
```

**Non-obvious design decisions**

- This region uses a double gate, `original_instruction` and `self._enable_summarize`, before calling `_check_proactive_summarization(...)`. That avoids probing summarization when the loop lacks the original instruction context or when summarization is disabled by configuration.
- It stages the helper's outputs in `self._pending_subagent_refs` and `self._pending_handoff_prompt` instead of acting on them immediately. The inline comments tie that choice to deferred recording: one value is kept to add a system step later, and the other is kept to add a user step later.
- The `if proactive_summary_result:` branch accepts only truthy returns from `_check_proactive_summarization(...)`. That is slightly broader than checking for a specific sentinel such as `None`, so the helper's falsy outputs all mean 'do not stage anything' here.

**Relations**

- **Callers**: `Terminus2._run_agent_loop`
- **Core callees**: `Terminus2._check_proactive_summarization`
- **Config / state sources**: `self._enable_summarize`; `self._session`; `original_instruction`
- **Results to**: `self._pending_subagent_refs`; `self._pending_handoff_prompt`; `reg-pending-subagent-refs`; `reg-pending-handoff-prompt`
- **📊 Register interactions**: ✏️ writes `reg-pending-subagent-refs` — store returned subagent refs when probe is truthy; ✏️ writes `reg-pending-handoff-prompt` — store returned prompt when probe is truthy

</details>


<details id="fn-terminus2_check_proactive_summarization">
<summary><b>Terminus2._check_proactive_summarization</b> — terminus_2.py:957-981 · Proactive token-budget summarization probe</summary>

> **Stage context**: This helper implements the stage-4.2 probe that decides whether the current chat is close enough to the model context limit to trigger the summarization side flow. The main loop calls it only when proactive summarization is enabled and `original_instruction` exists. Unlike its caller, it does not store pending handoff data itself; it only returns the `(prompt, subagent_refs)` payload that `Terminus2._run_agent_loop` may place into the pending registers.

**What this code does**

The function measures remaining context budget for `chat` by combining `self._llm.get_model_context_limit()` with `self._count_total_tokens(chat)`. If the estimated free space is below `self._proactive_summarization_threshold`, it runs `self._summarize(chat, original_instruction, session)` and returns that routine's handoff prompt plus any `SubagentTrajectoryRef` list. If the threshold is not crossed, or summarization raises, it returns `None` and only emits a log message.

**Interface · params / IO**

`(self, chat: Chat, original_instruction: str, session: TmuxSession) -> tuple[str, list[SubagentTrajectoryRef] | None] | None`

- params: `chat`: `Chat` — Current live conversation whose token load is checked; `original_instruction`: `str` — Original user/task instruction forwarded into `_summarize`; `session`: `TmuxSession` — Active tmux session forwarded into `_summarize`
- reads: `self._llm`, `self._count_total_tokens`, `self._proactive_summarization_threshold`, `self._summarize`, `self.logger`
- returns: Either `(summary_prompt, subagent_trajectory_refs)` from `_summarize`, or `None` when free tokens stay above the threshold or summarization fails.
- effects: Emits a debug log when the proactive threshold triggers; Emits an error log if `_summarize` raises; May trigger the `_summarize` side flow, which performs broader external/stateful work outside this helper

**Execution flow**

1. Read the model context cap from `self._llm.get_model_context_limit()`, count current chat tokens with `self._count_total_tokens(chat)`, and derive `free_tokens` as the remaining budget.
2. Compare `free_tokens` against `self._proactive_summarization_threshold` to decide whether proactive summarization should run.
3. When the threshold is crossed, write a debug message through `self.logger.debug(...)` that includes the approximate free-token count.
4. Call `await self._summarize(chat, original_instruction, session)` inside a `try` block and return its `(summary_prompt, subagent_trajectory_refs)` result unchanged.
5. If `_summarize` raises, log the exception through `self.logger.error(...)` and fall through to `None` instead of propagating the failure.
6. Return `None` when the threshold is not crossed or when summarization failed.

**Source**

```python
    async def _check_proactive_summarization(
        self, chat: Chat, original_instruction: str, session: TmuxSession
    ) -> tuple[str, list[SubagentTrajectoryRef] | None] | None:
        """Check if we should proactively summarize due to token usage.

        Returns:
            tuple: (summary_prompt, subagent_trajectory_ref) if summarization occurred, None otherwise
        """
        context_limit = self._llm.get_model_context_limit()
        current_tokens = self._count_total_tokens(chat)
        free_tokens = context_limit - current_tokens

        if free_tokens < self._proactive_summarization_threshold:
            self.logger.debug(
                f"Proactively summarizing. Free tokens: approximately {free_tokens}"
            )
            try:
                summary_prompt, subagent_trajectory_refs = await self._summarize(
                    chat, original_instruction, session
                )
                return (summary_prompt, subagent_trajectory_refs)
            except Exception as e:
                self.logger.error(f"Error in proactively summarizing: {e}")

        return None
```

**Non-obvious design decisions**

- It uses `free_tokens < self._proactive_summarization_threshold` instead of waiting for an actual overflow condition. That gives the main loop room to summarize before the next LLM call runs out of context; the alternative would be a later, riskier trigger.
- It treats token pressure as an estimate built from `get_model_context_limit()` and `_count_total_tokens(chat)`. The debug message even says `approximately`, which shows the function prefers a practical budget check over exact accounting.
- It catches all `Exception` from `_summarize`, logs the failure, and returns `None`. This keeps the agent loop moving on the normal path instead of turning a summarization problem into a hard stop.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: self._llm.get_model_context_limit; self._count_total_tokens; self._summarize; self.logger.debug; self.logger.error
- **Config / state sources**: self._proactive_summarization_threshold; self._llm
- **Results to**: Terminus2._run_agent_loop stores returned prompt into `self._pending_handoff_prompt` when truthy; Terminus2._run_agent_loop stores returned refs into `self._pending_subagent_refs` when truthy; stage-4.5 via `reg-pending-subagent-refs` after caller stores them; stage-4.6 via `reg-pending-handoff-prompt` after caller stores it
- **Related siblings**: Terminus2._run_agent_loop: gates this helper on `original_instruction` and `_enable_summarize`, then records any returned handoff data into pending registers
- **📊 Register interactions**: 👁 reads `reg-chat-messages` — counts current chat tokens from live history

</details>
