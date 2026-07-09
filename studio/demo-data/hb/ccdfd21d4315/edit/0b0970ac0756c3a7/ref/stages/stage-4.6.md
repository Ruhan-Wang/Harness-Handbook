### 4.6 · Error Branch

#### (a) Opening Explanation

This stage exists to catch a bad LLM reply before the agent acts on it. Sometimes the model returns output that cannot be parsed into the expected shape, so the system does not have a safe command list, plan, or handoff to trust. Instead of guessing, Terminus 2 stops the normal action path and turns the parse failure into a repair prompt for the next LLM turn. That is the whole job here: detect “we could not understand your answer,” record that failed turn in the trajectory, and ask for a corrected reply. It sits between “we got an LLM response” and “go run commands,” because this is the last safe place to prevent malformed output from becoming real terminal actions.

#### (b) Main Flow

1. The stage checks whether parser feedback says the last LLM answer was invalid.  
   In practice, it looks for an `"ERROR:"` signal in `feedback`. That means the model answered, but not in a form the agent can safely use.

2. If there was a parse error, the stage rebuilds `prompt` into a repair message.  
   The new prompt basically says: your previous response had formatting or parsing problems, here is the error, please try again.  
   `_get_error_response_type()` (figures out the human-readable label for the expected response shape) is used so the retry message names the kind of answer the parser wanted. That gives the model a more precise correction target.

3. The stage still records this failed turn as part of the run history.  
   That matters because the agent should remember that the model did answer, even if the answer was unusable. The stored step uses the raw LLM text as the agent message, not a cleaned analysis or plan, because parsing never succeeded. It also attaches the repair prompt as an observation result, plus per-step metrics like token cache use and cost.

4. Then the stage stops this iteration early.  
   It does **not** run commands. It does **not** check for completion. It does **not** enter the normal loop tail. The only next move is: go back around and ask the LLM again with the error-repair prompt.

5. Why this design matters: it keeps malformed model output in the “conversation repair” lane instead of the “real-world action” lane.  
   Without this branch, the agent would either crash, lose the failure context, or worse, try to act on half-parsed output.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: 无 — this stage is not associated with any explicit skeleton register in the provided input
- reads: 无 — no explicit skeleton register is named for this stage in the provided input
- clears: 无 — no explicit skeleton register is cleared here in the provided input
- triggers downstream: stage-4.9 Command Execute → Observation → Trajectory Step — **not triggered** when parser feedback contains `"ERROR:"`; this stage `continue`s and skips command execution for the iteration

#### (d) Pipeline Hand-Off

Upstream, this stage receives an LLM reply plus parser feedback saying that reply could not be understood. It produces a retry prompt and a recorded error step, then sends the loop back to another LLM attempt instead of handing anything to command execution.

<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1378-1420 · Parser-error repair prompt and trajectory logging</summary>

> **Stage context**: This region handles the `if feedback and "ERROR:" in feedback` branch inside `Terminus2._run_agent_loop`. It runs after an LLM response produced parser feedback, rebuilds `prompt` for a repair attempt, records the failed raw response as a `Step`, and ends this loop iteration with `continue`. This is the first translated region for this stage, so it stands alone here.

**What this code does**

When `feedback` contains `"ERROR:"`, this branch replaces the next-iteration `prompt` with a parser-repair message that embeds `feedback` and the label from `self._get_error_response_type()`. It computes per-step token and cost deltas from `chat.total_*` counters and the `tokens_before_*` / `cost_before` snapshots, then appends one agent `Step` to `self._trajectory_steps` using the raw `llm_response.content`, a corrective `ObservationResult(content=prompt)`, and `Metrics` built from the deltas and token/logprob fields on `llm_response`. It may also copy `llm_response.model_name` into `self._last_response_model_name`, and it returns no value because it exits this loop pass via `continue`.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `Terminus2` — Owns loop state, model defaults, and trajectory storage; `feedback`: `?` — Parser feedback string tested for `"ERROR:"`; `chat`: `?` — Source of cumulative token and cost counters: `total_cache_tokens`, `total_cost`, `total_input_tokens`, `total_output_tokens`; `tokens_before_cache`: `?` — Earlier cache-token snapshot used to compute this step's delta; `cost_before`: `?` — Earlier cost snapshot used to compute this step's delta; `tokens_before_input`: `?` — Earlier prompt-token snapshot used to compute this step's delta; `tokens_before_output`: `?` — Earlier completion-token snapshot used to compute this step's delta; `llm_response`: `?` — Raw model response; supplies content, reasoning, model name, token ids, and logprobs
- reads: `self._get_error_response_type`, `self._trajectory_steps`, `self._model_name`
- returns: None; the branch's product is a rewritten local `prompt`, an optional write to `self._last_response_model_name`, and one appended `Step` in `self._trajectory_steps`, then `continue` skips the rest of the current loop iteration.
- effects: Writes local `prompt` to a parser-repair message; May write `self._last_response_model_name` when `llm_response.model_name` is truthy; Appends one `Step(...)` to `self._trajectory_steps`; Calls `datetime.now(timezone.utc).isoformat()` to stamp the recorded step; Ends the current loop iteration with `continue`

**Execution flow**

1. Check `feedback` and enter this branch only when it is truthy and contains `"ERROR:"`.
2. Rebuild local `prompt` from `feedback` plus `self._get_error_response_type()`, using the fixed text `"Previous response had parsing errors:"` and `"Please fix these issues and provide a proper ..."`.
3. Compute `cache_tokens_used = chat.total_cache_tokens - tokens_before_cache` and `step_cost = chat.total_cost - cost_before`.
4. If `llm_response.model_name` is truthy, copy it into `self._last_response_model_name`.
5. Append one `Step` to `self._trajectory_steps` with `step_id=len(self._trajectory_steps) + 1`, `timestamp=datetime.now(timezone.utc).isoformat()`, `source="agent"`, `model_name=llm_response.model_name or self._model_name`, `message=llm_response.content`, `reasoning_content=llm_response.reasoning_content`, and `observation.results=[ObservationResult(content=prompt)]`.
6. Build `Step.metrics` from counter deltas and response metadata: prompt/completion token deltas from `chat.total_input_tokens` and `chat.total_output_tokens`, `cached_tokens` only when `cache_tokens_used > 0`, `cost_usd` only when `step_cost > 0`, plus `llm_response.prompt_token_ids`, `completion_token_ids`, and `logprobs`.
7. Execute `continue` to skip the remainder of the current loop iteration.

**Source**

```python
            if feedback and "ERROR:" in feedback:
                prompt = (
                    f"Previous response had parsing errors:\n{feedback}\n\n"
                    f"Please fix these issues and provide a proper "
                    f"{self._get_error_response_type()}."
                )
                # For error cases, we still want to record the step
                # Use the raw response as the message since parsing failed
                cache_tokens_used = chat.total_cache_tokens - tokens_before_cache
                step_cost = chat.total_cost - cost_before

                if llm_response.model_name:
                    self._last_response_model_name = llm_response.model_name
                self._trajectory_steps.append(
                    Step(
                        step_id=len(self._trajectory_steps) + 1,
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        source="agent",
                        model_name=llm_response.model_name or self._model_name,
                        message=llm_response.content,
                        reasoning_content=llm_response.reasoning_content,
                        observation=Observation(
                            results=[
                                ObservationResult(
                                    content=prompt,
                                )
                            ]
                        ),
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
                continue
```

**Non-obvious design decisions**

- The recorded `Step.message` uses `llm_response.content` rather than any parsed structure. The nearby comment anchors this choice: parsing failed, so the branch preserves the raw model output in the trajectory.
- The branch updates `self._last_response_model_name` only when `llm_response.model_name` is truthy, but the stored `Step.model_name` still falls back to `self._model_name`. That split avoids overwriting the remembered last-response model with an empty value while still guaranteeing a model name in the trajectory record.
- The metrics writer suppresses non-positive `cached_tokens` and `cost_usd` by storing `None` unless the computed delta is greater than zero. This keeps the `Metrics` payload from claiming cache use or cost for a step when the counter difference is zero or negative.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: self._get_error_response_type(); datetime.now(timezone.utc).isoformat(); Step(...); Observation(...); ObservationResult(...); Metrics(...)
- **Config / state sources**: `feedback` branch condition; `chat.total_cache_tokens`, `chat.total_cost`, `chat.total_input_tokens`, `chat.total_output_tokens`; `tokens_before_cache`, `cost_before`, `tokens_before_input`, `tokens_before_output`; `llm_response.model_name`, `llm_response.content`, `llm_response.reasoning_content`; `llm_response.prompt_token_ids`, `llm_response.completion_token_ids`, `llm_response.logprobs`; `self._model_name` fallback
- **Results to**: local `prompt`; `self._last_response_model_name`; `self._trajectory_steps`; current loop control via `continue`
- **📊 Register interactions**: ✏️ writes `reg-trajectory-steps` — append parser-error agent step with observation

</details>


<details id="fn-terminus2_get_error_response_type">
<summary><b>Terminus2._get_error_response_type</b> — terminus_2.py:472-484 · Parser-name to error-label mapper</summary>

> **Stage context**: This helper supplies the short response-type label used by the stage's parser-error path. Within the provided stage materials, the sibling entry for `Terminus2._run_agent_loop` states that the error branch calls `self._get_error_response_type()` while rebuilding the repair prompt after a parse failure.

**What this code does**

This function maps `self._parser_name` to the human-readable label used in error text. It returns `"JSON response"` for `"json"` and `"response"` for `"xml"`. It does not write any state. If `self._parser_name` matches neither branch, it raises `ValueError` whose message includes the unsupported parser name and instructs the caller to use `'json'` or `'xml'`.

**Interface · params / IO**

`(self) -> str`

- params: `self`: `?` — Instance providing `_parser_name`
- reads: `self._parser_name`
- returns: A short error-message label: `"JSON response"` when `self._parser_name == "json"`, or `"response"` when `self._parser_name == "xml"`; otherwise it raises `ValueError` with a message that embeds `self._parser_name` and says to use `'json'` or `'xml'`.

**Execution flow**

1. Check `self._parser_name` against the first supported value, `"json"`, and return the literal label `"JSON response"` when it matches.
2. Otherwise check `self._parser_name` against the second supported value, `"xml"`, and return the literal label `"response"` when it matches.
3. If neither condition matches, take the `else` branch and raise `ValueError` with `f"Unknown parser_name: {self._parser_name}. Use 'json' or 'xml'."`.

**Source**

```python
    def _get_error_response_type(self) -> str:
        """Return the response type name for error messages.

        Examples: 'JSON response', 'response'
        """
        if self._parser_name == "json":
            return "JSON response"
        elif self._parser_name == "xml":
            return "response"
        else:
            raise ValueError(
                f"Unknown parser_name: {self._parser_name}. Use 'json' or 'xml'."
            )
```

**Non-obvious design decisions**

- The mapping is explicit and closed: the code recognizes only two parser names, `"json"` and `"xml"`, instead of falling back to a default label for unknown values.
- The XML branch returns the generic string `"response"` rather than a parser-specific label such as `"XML response"`; this wording is an observed code choice in the `elif self._parser_name == "xml"` branch.
- The function fails fast on unsupported configuration. The `else` branch raises `ValueError` immediately, and its message both echoes the bad `self._parser_name` value and names the allowed values `'json'` and `'xml'`.

**Relations**

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: ValueError
- **Config / state sources**: self._parser_name
- **Results to**: Parser-error prompt text built in `Terminus2._run_agent_loop`; Exception path for unsupported parser configuration
- **Related siblings**: Terminus2._run_agent_loop: uses this label when the parser-error branch rebuilds the repair prompt

</details>

<!-- card placed by resync (stage stage-4.6) -->

<details id="fn-terminus2_split_trajectory_on_summarization">
<summary><b>Terminus2._split_trajectory_on_summarization</b> — terminus_2.py:1884-1909 · Split trajectory at summarization continuation boundary</summary>

> **Stage context**: This helper implements the linear-history branch of stage `stage-4.6` when `_run_agent_loop` consumes `reg-pending-handoff-prompt`. Instead of appending a new user step, it closes the current trajectory segment and prepares a continuation trajectory that carries prior context forward. It is the stage's split mechanism behind the sibling summary that says `_run_agent_loop` may call `_split_trajectory_on_summarization(...)` rather than writing directly into `_trajectory_steps`.

**What this code does**

`_split_trajectory_on_summarization` cuts the current trajectory at the summarization boundary and prepares in-memory state for the continuation segment. It reads `_summary_round_count`, `_session_id`, and, if present, `_chat.messages`; it writes a trajectory file through `_dump_trajectory_with_continuation_index`, updates `_session_id`, and replaces `_trajectory_steps` with copied-context steps derived from prior chat history. The `handoff_prompt` parameter is accepted by the interface but this body does not inspect it.

**Interface · params / IO**

`(self, handoff_prompt: str) -> None`

- params: `handoff_prompt`: `str` — handoff text passed from the summarization path; unused in this body
- reads: `self._summary_round_count`, `self._session_id`, `self._chat`, `self._chat.messages`
- returns: None; the real product is persisted trajectory output plus updated continuation state in `self._session_id` and `self._trajectory_steps`.
- effects: Calls `self._dump_trajectory_with_continuation_index(...)` to write the finished trajectory segment; Writes `self._session_id` to a continuation id based on the current summary round count; Replaces `self._trajectory_steps` with converted steps from `self._chat.messages[:-1]` when `self._chat` is present

**Execution flow**

1. It dumps the current trajectory segment by calling `_dump_trajectory_with_continuation_index(self._summary_round_count - 1)`, using `_summary_round_count` to choose the continuation file index.
2. It rewrites `_session_id` to `"{base}-cont-{self._summary_round_count}"`, where `base` comes from `self._session_id.split('-cont-')[0]` so any earlier continuation suffix is removed first.
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
- **Config / state sources**: self._summary_round_count; self._session_id; self._chat.messages
- **Results to**: Persisted trajectory segment selected by `_dump_trajectory_with_continuation_index`; self._session_id for subsequent continuation output; self._trajectory_steps consumed by later trajectory appends and dumps in the main loop
- **Related siblings**: Terminus2._run_agent_loop: consumes `reg-pending-handoff-prompt` and chooses this helper in linear-history mode instead of appending a `source="user"` step
- **📊 Register interactions**: 👁 reads `reg-summary-round-count` — choose dump index and continuation suffix; ✏️ writes `reg-trajectory-steps` — replace with copied-context continuation steps; 👁 reads `reg-chat-messages` — rebuild continuation steps from prior chat

</details>
