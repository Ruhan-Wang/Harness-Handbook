## side-S1 · Context Summarization

#### (a) Opening Explanation

This stage exists to shrink the agent’s conversation when the prompt is getting too full to continue safely. Terminus 2 keeps a growing chat history, but the model has a context limit: once too much history is packed in, the next LLM call can become expensive, fragile, or impossible. Context Summarization owns that pressure-release job. It turns a long working history into a compact handoff the agent can keep using. It can run in two places: proactively when free context is running low, or reactively after a context-length failure. Its job is not to finish the task. Its job is to preserve the important parts of the task so the main loop can keep going without losing the plot.

#### (b) Main Flow

1. The stage starts only when context pressure is high.  
   There are two entry paths. A proactive check runs before things get too tight. A reactive path runs after an LLM call failed because the context was too long. In both cases, the system decides that the current conversation needs to be compressed.

2. `_summarize()` (runs the context-compression ritual) builds a handoff from the old history.  
   The point is not “make a short summary” in the abstract. The point is “preserve enough working memory that the agent can continue the same task in a smaller prompt.”

3. It does that with three subagents, because one summary alone is often too lossy.  
   First, one subagent writes a detailed narrative of what happened so far.  
   Second, another subagent looks at that narrative plus the original task and the current terminal screen (the live shell view the agent can inspect remotely) and asks clarifying questions about what is still missing.  
   Third, a final subagent answers those questions from the old chat history.  
   This design exists to recover details a one-pass summary would miss, especially current state, unresolved problems, and important facts that only become obviously relevant when someone asks follow-up questions.

4. The stage also records evidence for those subagent runs.  
   `_run_subagent()` (launches one helper agent run and captures its result) is used for each of the three passes. Those runs get their own trajectory records so later inspection can show how the summary handoff was produced. That matters for debugging and audit, but it is not the main purpose of the stage.

5. Before leaving, this stage prepares a fresh, smaller main chat state.  
   The old long conversation is replaced inside this stage with a minimal three-message conversation built around the question set. This is important: the reset of the main chat happens here, not later. The actual answers become the handoff prompt that will let the main agent continue from compressed context.

6. Finally, the stage emits pending artifacts for later pipeline stages.  
   It does not itself attach the handoff into the visible trajectory or consume the subagent references. Instead, it leaves behind two pending outputs: the handoff prompt and the subagent trajectory references. Later stages record and consume those artifacts.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-pending-handoff-prompt` — written when summarization finishes; holds the compressed handoff text that later stages will attach/consume so the main agent can continue with less context
- writes: `reg-pending-subagent-refs` — written when the three summarization subagents finish; stores references to their saved trajectories so later stages can record that evidence
- writes: `reg-summarization-count` — incremented each time `_summarize` runs; used as bookkeeping for how often context compression happened
- triggers downstream: `stage-4.5` — after this stage has created pending summarization artifacts, the next recording step can pick up the subagent refs

#### (d) Pipeline Hand-Off

Upstream, this stage receives a live agent state whose chat history has become too large, either detected early or after a context-length failure. It produces two pending artifacts—a compressed handoff prompt and subagent trajectory references—plus a reset smaller main chat; downstream stages then record those artifacts and use the handoff to continue the run without the old full history.

<details id="fn-terminus2_summarize">
<summary><b>Terminus2._summarize</b> — terminus_2.py:746-960 · Three-subagent chat-to-handoff summarizer</summary>

> **Stage context**: This function is the stage's core summarization routine. It takes the current `Chat` state and rewrites that state into a compact handoff conversation while also producing a separate handoff prompt for the next agent turn. Within this stage, it is the only entry shown here and it delegates the three actual model calls to `_run_subagent`.

**What this code does**

The function turns `chat.messages`, `original_instruction`, and the current tmux screen into a resumable handoff package. If `chat.messages` is empty, it returns `(original_instruction, None)` without changing state. Otherwise it increments `self._summarization_count`, runs three subagents in sequence, replaces `chat._messages` with `[system, question_prompt, model_questions]`, resets the chat response chain, and returns a handoff prompt plus three `SubagentTrajectoryRef` values.

**Interface · params / IO**

`(self, chat: Chat, original_instruction: str, session: TmuxSession) -> tuple[str, list[SubagentTrajectoryRef] | None]`

- params: `chat`: `Chat` — Live conversation history to summarize and then rewrite; `original_instruction`: `str` — Original task text embedded into all summarization prompts; `session`: `TmuxSession` — Terminal session used to capture the current pane for question generation
- reads: `self._session_id`, `self._summarization_count`, `self._model_name`
- returns: A tuple `(handoff_prompt, subagent_trajectory_refs)`. On the empty-chat branch it returns `(original_instruction, None)`. On the summarization path it returns a handoff prompt built from `answers_response.content` and a three-item list of `SubagentTrajectoryRef` objects from the summary, questions, and answers subagents.
- effects: Increments `self._summarization_count`; Reads and then replaces `chat._messages` with `[chat.messages[0], {"role": "user", "content": question_prompt}, {"role": "assistant", "content": model_questions}]`; Calls `chat.reset_response_chain()` after replacing the message list; Captures the current tmux pane with `session.capture_pane(capture_entire=False)`; Builds copied trajectory steps via `_prepare_copied_trajectory_steps(...)` for the summary and answers subagents; Appends two synthetic copied `Step` records to `answers_steps`: one user step for `summary_prompt`, and one agent step for `summary_response.content` carrying `reasoning_content=summary_response.reasoning_content`, `model_name=summary_response.model_name or self._model_name`, `is_copied_context=True`, and an `extra` note that metrics were already recorded

**Execution flow**

1. If `len(chat.messages) == 0`, return `original_instruction` and `None` immediately; otherwise increment `self._summarization_count` and start collecting `subagent_trajectory_refs`.
2. Build the summary subagent context from the current unwound `chat.messages`: compute `steps_to_include = 1 + (len(chat.messages) - 1) // 2`, copy that many trajectory steps with `_prepare_copied_trajectory_steps(...)`, compose `summary_prompt` from `original_instruction`, and call `_run_subagent(...)` with `message_history=chat.messages`.
3. Capture the live terminal with `session.capture_pane(capture_entire=False)`, compose `question_prompt` from `original_instruction`, `summary_response.content`, and the captured screen, then call `_run_subagent(...)` with `message_history=[]` to get `model_questions`.
4. Prepare the answers subagent from the same copied base trajectory, then append two extra copied `Step` objects that mirror the summary exchange: a copied user `summary_prompt` step and a copied agent `summary_response` step with `model_name` fallback to `self._model_name`, propagated `reasoning_content`, `is_copied_context=True`, and an `extra` note.
5. Build `answer_request_prompt` from `model_questions`, build `answers_message_history` as `chat.messages` plus the summary prompt/response pair, and call `_run_subagent(...)` to obtain detailed answers.
6. Replace `chat._messages` with the original system message, the synthesized `question_prompt`, and the model's questions only; reset the response chain; then return a `handoff_prompt` that embeds `answers_response.content` and tells the next agent to continue without asking more questions.

**Source**

```python
    async def _summarize(
        self, chat: Chat, original_instruction: str, session: TmuxSession
    ) -> tuple[str, list[SubagentTrajectoryRef] | None]:
        """Create a summary of the agent's work to pass to a new agent instance.

        This method implements a three-step context summarization process using separate
        subagents to compress conversation history while preserving critical information:

        **Step 1: Summary Generation (SUBAGENT 1)**
        - Message history: Unwound chat.messages (limited context after token freeing)
        - Prompt: Generate comprehensive summary of all work completed so far
        - Response: summary_response.content (detailed narrative of progress)

        **Step 2: Question Asking (SUBAGENT 2)**
        - Message history: [] (fresh start, no conversation context)
        - Prompt: Given the original task, summary from Step 1, and current terminal screen,
        generate questions about information missing from the summary.
        - Response: model_questions (list of clarifying questions)

        **Step 3: Answer Providing (SUBAGENT 3)**
        - Message history: chat.messages + [summary_prompt, summary_response] (extended context)
        - Prompt: Given the questions from Step 2, answer the questions based on full conversation history.
        - Response: answers_response.content (detailed answers)

        **Final handoff:**
        - Chat history replaced with: [system, question_prompt (which includes summary from step 1), model_questions]
        - Result: Compressed context that preserves critical task-specific information, allowing
        the main agent to continue working on the task without losing context.

        **Why three steps?** This question-answer approach ensures the summarization doesn't
        lose important details - the questions subagent identifies gaps, and the answers
        subagent (with full context) fills them in.

        Args:
            chat: Chat object containing conversation history (may be unwound)
            original_instruction: The original task instruction from user
            session: TmuxSession for capturing current terminal state

        Returns:
            tuple: (handoff_prompt, subagent_trajectory_refs)
                - handoff_prompt: The prompt to continue with (includes answers + instructions)
                - subagent_trajectory_refs: List of 3 SubagentTrajectoryRef objects, or None if summarization failed
        """
        if len(chat.messages) == 0:
            return original_instruction, None

        # Increment summarization count
        self._summarization_count += 1
        subagent_trajectory_refs = []

        # ===== SUBAGENT 1: Summary Generation =====
        summary_session_id = (
            f"{self._session_id}-summarization-{self._summarization_count}-summary"
        )

        # Trajectory needs to reflect what is sent to LLM: essentially the previous chat
        # history, minus the messages that were removed to free up tokens.
        # Calculate how many trajectory steps to include based on remaining chat messages:
        # - Chat has: [system, agent1, user1, agent2, user2, ...]
        # - Trajectory has: [step1_system, step2_agent, step3_agent, ...]
        # - Formula: steps_to_include = 1 + (num_messages - 1) // 2
        steps_to_include = 1 + (len(chat.messages) - 1) // 2
        summary_steps, step_id_counter = self._prepare_copied_trajectory_steps(
            steps_to_include
        )

        summary_prompt = f"""You are about to hand off your work to another AI agent.
            Please provide a comprehensive summary of what you have
            accomplished so far on this task:

Original Task: {original_instruction}

Based on the conversation history, please provide a detailed summary covering:
1. **Major Actions Completed** - List each significant command you executed
            and what you learned from it.
2. **Important Information Learned** - A summary of crucial findings, file
            locations, configurations, error messages, or system state discovered.
3. **Challenging Problems Addressed** - Any significant issues you
            encountered and how you resolved them.
4. **Current Status** - Exactly where you are in the task completion process.


Be comprehensive and detailed. The next agent needs to understand everything
            that has happened so far in order to continue."""

        summary_response, summary_trajectory_ref = await self._run_subagent(
            prompt=summary_prompt,
            message_history=chat.messages,
            steps=summary_steps,
            session_id=summary_session_id,
            agent_name="terminus-2-summarization-summary",
            filename_suffix="summary",
            summary_text=f"Context summarization {self._summarization_count}: Step 1 - Summary generation",
            subagent_name_for_logging="summary generation LLM call",
        )
        subagent_trajectory_refs.append(summary_trajectory_ref)

        # ===== SUBAGENT 2: Question Asking =====
        current_screen = await session.capture_pane(capture_entire=False)
        questions_session_id = (
            f"{self._session_id}-summarization-{self._summarization_count}-questions"
        )
        questions_steps = []

        question_prompt = f"""You are picking up work from a previous AI agent on this task:

**Original Task:** {original_instruction}

**Summary from Previous Agent:**
{summary_response.content}

**Current Terminal Screen:**
{current_screen}

Please begin by asking several questions (at least five, more if necessary)
about the current state of the solution that are not answered in the summary
from the prior agent. After you ask these questions you will be on your own,
so ask everything you need to know."""

        questions_response, questions_trajectory_ref = await self._run_subagent(
            prompt=question_prompt,
            message_history=[],
            steps=questions_steps,
            session_id=questions_session_id,
            agent_name="terminus-2-summarization-questions",
            filename_suffix="questions",
            summary_text=f"Context summarization {self._summarization_count}: Step 2 - Question asking",
            subagent_name_for_logging="questions subagent",
        )
        model_questions = questions_response.content
        subagent_trajectory_refs.append(questions_trajectory_ref)

        # ===== SUBAGENT 3: Answer Providing =====
        answers_session_id = (
            f"{self._session_id}-summarization-{self._summarization_count}-answers"
        )

        # Reuse the actual trajectory steps (same as summary subagent)
        # At this point, chat.messages has the same unwound history as in summary subagent
        answers_steps, step_id_counter = self._prepare_copied_trajectory_steps(
            steps_to_include
        )

        # Add the summary prompt and response steps that are part of the message history
        # Mark these as copied context since they were already part of the summary subagent trajectory
        answers_steps.append(
            Step(
                step_id=step_id_counter,
                timestamp=datetime.now(timezone.utc).isoformat(),
                source="user",
                message=summary_prompt,
                is_copied_context=True,
            )
        )
        step_id_counter += 1

        answers_steps.append(
            Step(
                step_id=step_id_counter,
                timestamp=datetime.now(timezone.utc).isoformat(),
                source="agent",
                model_name=summary_response.model_name or self._model_name,
                message=summary_response.content,
                reasoning_content=summary_response.reasoning_content,
                is_copied_context=True,
                extra={
                    "note": "Copied from summary subagent - metrics already recorded there"
                },
            )
        )
        step_id_counter += 1

        answer_request_prompt = (
            "The next agent has a few questions for you, please answer each of them one by one in detail:\n\n"
            + model_questions
        )

        # The answer subagent should see: unwound chat history + summary prompt + summary response
        answers_message_history = chat.messages + [
            {"role": "user", "content": summary_prompt},
            {"role": "assistant", "content": summary_response.content},
        ]

        answers_response, answers_trajectory_ref = await self._run_subagent(
            prompt=answer_request_prompt,
            message_history=answers_message_history,
            steps=answers_steps,
            session_id=answers_session_id,
            agent_name="terminus-2-summarization-answers",
            filename_suffix="answers",
            summary_text=f"Context summarization {self._summarization_count}: Step 3 - Answer providing",
            subagent_name_for_logging="answers subagent",
        )
        subagent_trajectory_refs.append(answers_trajectory_ref)

        # Update chat history with the handoff context
        # Note: We only include questions, not answers. The answers will be provided
        # via the handoff_prompt to the next agent iteration.
        chat._messages = [
            chat.messages[0],
            {"role": "user", "content": question_prompt},
            {"role": "assistant", "content": model_questions},
        ]
        chat.reset_response_chain()

        handoff_prompt = (
            "Here are the answers the other agent provided.\n\n"
            + answers_response.content
            + "\n\n"
            + "Continue working on this task from where the previous agent left off."
            " You can no longer ask questions. Please follow the spec to interact with "
            "the terminal."
        )

        return handoff_prompt, subagent_trajectory_refs
```

**Non-obvious design decisions**

- It uses three separate subagents instead of one direct summary because the code explicitly inserts a gap-finding phase: the questions subagent sees only `original_instruction`, `summary_response.content`, and `current_screen`, while the answers subagent gets the broader `answers_message_history`. This splits compression from verification so missing details can surface before handoff.
- It computes `steps_to_include` from `len(chat.messages)` and recreates copied steps with `_prepare_copied_trajectory_steps(...)` rather than reusing all prior trajectory records. That keeps each subagent's recorded context aligned with the unwound message history actually sent to the model.
- The questions subagent runs with `message_history=[]` even though other inputs are rich. That choice forces its questions to come from the summary and current screen, which makes it probe for omissions in the handoff package instead of leaning on hidden conversation context.
- The final rewritten chat stores only `[system, question_prompt, model_questions]` and omits `answers_response.content` from `chat._messages`. The code instead places the answers in the returned `handoff_prompt`, separating persistent compressed context from the one-shot continuation instruction.
- The synthetic copied summary-response `Step` in `answers_steps` preserves `summary_response.reasoning_content` and uses `summary_response.model_name or self._model_name` while marking the step with `is_copied_context=True` and an `extra` note. This keeps the answers subagent's trajectory faithful to the context it saw without implying that this function should count that prior summary call's metrics twice.

**Relations**

- **Callers**: Internal Terminus2 code paths that need to compress `Chat` history before continuing
- **Core callees**: Terminus2._prepare_copied_trajectory_steps; Terminus2._run_subagent; TmuxSession.capture_pane; Chat.reset_response_chain
- **Config / state sources**: `self._session_id` for per-subagent session ids; `self._summarization_count` for naming and summary labels; `self._model_name` as fallback for the copied summary-response step; `chat.messages` as the source conversation and system message
- **Results to**: Returned `handoff_prompt` for downstream continuation logic; Returned `list[SubagentTrajectoryRef]` for downstream trajectory linking; Mutated `chat._messages` as the new compressed conversation state; Updated `self._summarization_count` for later metadata/reporting
- **📊 Register interactions**: 👁 reads `reg-chat-messages` — uses current chat history as summarization source; ✏️ writes `reg-chat-messages` — stores [system, question_prompt, model_questions], not answers; ✏️ writes `reg-summarization-count` — increments once per summarization invocation

</details>


<details id="fn-terminus2_prepare_copied_trajectory_steps">
<summary><b>Terminus2._prepare_copied_trajectory_steps</b> — terminus_2.py:1695-1709 · Clone trajectory prefix for subagent handoff context</summary>

> **Stage context**: This helper supports the context-summarization stage by packaging part of the main run's trajectory for reuse by summarization subagents. `_summarize` calls it when it needs a safe snapshot of prior `Step` records to attach to subagent work. Unlike `_summarize`, it does not alter chat state or counters; it only prepares copied history and the next local step number.

**What this code does**

The function takes `steps_to_include` and returns a copied prefix of `self._trajectory_steps` plus the next step id for that copied list. It deep-copies only the first `steps_to_include` steps, then sanitizes the copy by calling `_remove_metrics_from_copied_steps`. It does not mutate instance state or the original trajectory.

**Interface · params / IO**

`(self, steps_to_include: int) -> tuple[list[Step], int]`

- params: `steps_to_include`: `int` — Number of leading entries to take from `self._trajectory_steps`
- reads: `self._trajectory_steps`
- returns: A tuple `(copied_steps, next_step_id)`, where `copied_steps` is a sanitized deep copy of `self._trajectory_steps[:steps_to_include]` and `next_step_id` is `len(copied_steps) + 1`

**Execution flow**

1. Slice `self._trajectory_steps` to the first `steps_to_include` entries and deep-copy that prefix into `copied_steps`.
2. Pass `copied_steps` to `_remove_metrics_from_copied_steps` so the copied `Step` records no longer carry metric fields.
3. Compute `next_step_id` from the copied list length as `len(copied_steps) + 1`.
4. Return the sanitized `copied_steps` together with `next_step_id`.

**Source**

```python
    def _prepare_copied_trajectory_steps(
        self, steps_to_include: int
    ) -> tuple[list[Step], int]:
        """Prepare trajectory steps for subagent by copying and removing metrics.

        Args:
            steps_to_include: Number of steps to include from main trajectory

        Returns:
            Tuple of (copied_steps, next_step_id)
        """
        copied_steps = copy.deepcopy(self._trajectory_steps[:steps_to_include])
        self._remove_metrics_from_copied_steps(copied_steps)
        next_step_id = len(copied_steps) + 1
        return copied_steps, next_step_id
```

**Non-obvious design decisions**

- It uses `copy.deepcopy(...)` on `self._trajectory_steps[:steps_to_include]` so later edits to subagent history cannot leak back into the main trajectory. Reusing the original objects would make the subagent snapshot fragile.
- It strips metrics through `_remove_metrics_from_copied_steps` before returning the copy, which keeps reused history focused on narrative state instead of token or cost accounting noise. Leaving metrics in place would mix bookkeeping from the main run into subagent-specific artifacts.
- It derives `next_step_id` from `len(copied_steps) + 1` after sanitization, so callers can continue numbering within the copied snapshot without inspecting the original trajectory.

**Relations**

- **Callers**: Terminus2._summarize
- **Core callees**: copy.deepcopy; Terminus2._remove_metrics_from_copied_steps
- **Config / state sources**: self._trajectory_steps; reg-trajectory-steps
- **Results to**: Terminus2._summarize subagent trajectory setup; Subagent-local copied `Step` history; Caller-managed next step numbering for copied trajectory context
- **Related siblings**: Terminus2._summarize
- **📊 Register interactions**: 👁 reads `reg-trajectory-steps` — copies a prefix of main trajectory

</details>


<details id="fn-terminus2_remove_metrics_from_copied_steps">
<summary><b>Terminus2._remove_metrics_from_copied_steps</b> — terminus_2.py:1675-1693 · Sanitize copied trajectory steps for subagent context</summary>

> **Stage context**: This helper supports the summarization side flow by cleaning copied trajectory history before subagents see it. `_prepare_copied_trajectory_steps` calls it after deep-copying a prefix of `self._trajectory_steps`, so the copied context keeps its structure but drops any embedded metrics. It complements `_prepare_copied_trajectory_steps` by doing the in-place sanitization step that `_summarize` ultimately relies on when building subagent inputs.

**What this code does**

The function takes `steps: list[Step]` and mutates each `Step` in place. For every copied step, it sets `step.is_copied_context = True`; if `step.metrics` is present, it clears that field and adds `step.extra["note"]` explaining that the metrics were intentionally omitted. It returns `None`; its real product is a sanitized copied step list that preserves trajectory context without carrying duplicated accounting data.

**Interface · params / IO**

`(steps: list[Step]) -> None`

- params: `steps`: `list[Step]` — Copied trajectory steps to sanitize in place
- returns: Returns `None`; produces in-place updates to each `Step` in `steps`.
- effects: Sets `step.is_copied_context` on every element of `steps`; Clears `step.metrics` when that field is truthy; Initializes `step.extra` to `{}` when needed before writing a note; Writes `step.extra["note"]` when metrics were removed

**Execution flow**

1. Iterate over each `step` in the `steps` argument and mark it as copied context by setting `step.is_copied_context = True`.
2. Check `step.metrics`; when it is present, clear it by assigning `None` so the copied record no longer carries metric data.
3. If metrics were removed and `step.extra` is currently `None`, replace it with an empty dict so the function has a place to store provenance metadata.
4. Record an explanatory `step.extra["note"]` that says the metrics were omitted because they are already recorded in the parent trajectory.

**Source**

```python
    def _remove_metrics_from_copied_steps(steps: list[Step]) -> None:
        """Remove metrics from copied trajectory steps and mark as copied context.

        Args:
            steps: List of trajectory steps to modify in-place
        """
        for step in steps:
            # Mark all copied steps with is_copied_context=True
            step.is_copied_context = True

            # Remove metrics to avoid duplication
            if step.metrics:
                step.metrics = None
                if step.extra is None:
                    step.extra = {}
                step.extra["note"] = (
                    "Metrics omitted to avoid duplication - already recorded in parent trajectory"
                )
```

**Non-obvious design decisions**

- It marks every copied step with `step.is_copied_context = True`, even when a step had no `metrics`. That separate flag preserves provenance for the whole copied prefix instead of using missing metrics as an implicit signal.
- It removes `step.metrics` only when `step.metrics` is truthy. That avoids manufacturing note metadata for steps that never had metrics, so the copied record distinguishes "metrics intentionally stripped" from "no metrics were present."
- It writes an explicit `step.extra["note"]` after clearing metrics. This keeps downstream readers from mistaking `metrics = None` for lost data or incomplete logging; the note ties the omission to duplication avoidance in the parent trajectory.
- It mutates the copied `Step` objects in place instead of returning a new list. That matches `_prepare_copied_trajectory_steps`, which already deep-copies the source steps and then hands this helper a list meant only for sanitization.

**Relations**

- **Callers**: `Terminus2._prepare_copied_trajectory_steps`
- **Core callees**: none
- **Config / state sources**: `steps` argument; `step.metrics`; `step.extra`
- **Results to**: Sanitized copied-step list returned by `Terminus2._prepare_copied_trajectory_steps`; Subagent trajectory context assembled for the summarization flow; `Terminus2._summarize` indirectly, through copied history prepared for subagents
- **Related siblings**: `Terminus2._prepare_copied_trajectory_steps` deep-copies the prefix, then delegates sanitization here; `Terminus2._summarize` consumes subagent context whose copied trajectory steps have been cleaned by this helper

</details>


<details id="fn-terminus2_run_subagent">
<summary><b>Terminus2._run_subagent</b> — terminus_2.py:667-744 · Execute one summarization subagent exchange</summary>

> **Stage context**: This helper is the shared execution path for each of `_summarize`'s three subagents: summary generation, question asking, and answer providing. `_summarize` invokes it once per subagent so each run gets the same prompt/response trajectory shape, timing capture, metrics accounting, and saved trajectory artifact. It complements `_summarize` by handling one subagent exchange, while siblings like `_prepare_copied_trajectory_steps` and `_remove_metrics_from_copied_steps` prepare sanitized context for those subagent trajectories.

**What this code does**

The function runs one subagent LLM call from prompt to persisted trajectory reference. It takes a `prompt`, prior `message_history`, and mutable `steps`, appends prompt and response `Step` entries, calls `self._llm`, records request timing and usage through helper methods, saves the subagent trajectory, and returns both the `LLMResponse` and a `SubagentTrajectoryRef`. Its main side effects are mutating `steps`, updating shared subagent accounting through helper methods, and writing a trajectory artifact.

**Interface · params / IO**

`(self, prompt: str, message_history: list[dict], steps: list[Step], session_id: str, agent_name: str, filename_suffix: str, summary_text: str, subagent_name_for_logging: str = "subagent") -> tuple[LLMResponse, SubagentTrajectoryRef]`

- params: `prompt`: `str` — Prompt text sent as the subagent's user message; `message_history`: `list[dict]` — Prior chat context passed into `self._llm.call`; `steps`: `list[Step]` — Mutable subagent trajectory step list to extend with prompt and response; `session_id`: `str` — Session identifier forwarded to `_save_subagent_trajectory`; `agent_name`: `str` — Subagent identity stored with the saved trajectory; `filename_suffix`: `str` — Per-subagent suffix for the trajectory filename; `summary_text`: `str` — Human-readable description recorded in the returned trajectory reference; `subagent_name_for_logging`: `str` — Label forwarded when appending the response step
- reads: `self._llm`, `self._llm_call_kwargs`
- returns: A tuple `(response, trajectory_ref)` where `response` is the `LLMResponse` from `self._llm.call` and `trajectory_ref` is the `SubagentTrajectoryRef` returned by `_save_subagent_trajectory`.
- effects: Mutates the passed-in `steps` list by appending a prompt `Step`; Mutates the passed-in `steps` list again through `_append_subagent_response_step`; Updates subagent timing/accounting through `_track_api_request_time`; Updates `self`'s subagent metrics through `_update_subagent_metrics`; Records rollout detail through `_collect_subagent_rollout_detail`; Persists a subagent trajectory through `_save_subagent_trajectory`

**Execution flow**

1. It assigns the next two step ids from `len(steps) + 1`, appends a new user-sourced `Step` containing `prompt`, and reserves the following id for the model response.
2. It records `start_time`, calls `self._llm.call(prompt=prompt, message_history=message_history, **self._llm_call_kwargs)`, and stores the resulting `LLMResponse` in `response`.
3. After the call returns, it feeds `start_time` into `_track_api_request_time` and extracts `usage_info = response.usage` for downstream accounting.
4. It passes `usage_info` to `_update_subagent_metrics`, then appends the model reply to `steps` by calling `_append_subagent_response_step(steps, response_step_id, response, usage_info, subagent_name_for_logging)`.
5. It forwards the full `response` to `_collect_subagent_rollout_detail`, then saves the subagent run with `_save_subagent_trajectory(session_id=session_id, agent_name=agent_name, steps=steps, usage_info=usage_info, filename_suffix=filename_suffix, summary_text=summary_text)`.
6. It returns the raw `response` together with the saved `trajectory_ref` so `_summarize` can use the text output and keep a stable reference to the persisted subagent artifact.

**Source**

```python
    async def _run_subagent(
        self,
        prompt: str,
        message_history: list[dict],
        steps: list[Step],
        session_id: str,
        agent_name: str,
        filename_suffix: str,
        summary_text: str,
        subagent_name_for_logging: str = "subagent",
    ) -> tuple[LLMResponse, SubagentTrajectoryRef]:
        """Run a subagent and return its response and trajectory reference.

        This helper encapsulates the common pattern of:
        1. Appending the prompt step to the trajectory
        2. Calling the LLM with the prompt and message history
        3. Tracking API request time
        4. Updating subagent metrics
        5. Appending the response step to the trajectory
        6. Collecting rollout details
        7. Saving the subagent trajectory

        Args:
            prompt: The prompt to send to the LLM
            message_history: The message history to provide context
            steps: The trajectory steps (will be modified to include prompt and response steps)
            session_id: Session ID for the subagent
            agent_name: Name of the subagent (e.g., "terminus-2-summarization-summary")
            filename_suffix: Suffix for trajectory filename (e.g., "summary", "questions", "answers")
            summary_text: Human-readable summary for the trajectory ref
            subagent_name_for_logging: Name used in logging messages

        Returns:
            tuple: (LLM response, SubagentTrajectoryRef)
        """
        # Append the prompt step
        prompt_step_id = len(steps) + 1
        steps.append(
            Step(
                step_id=prompt_step_id,
                timestamp=datetime.now(timezone.utc).isoformat(),
                source="user",
                message=prompt,
            )
        )
        response_step_id = prompt_step_id + 1

        start_time = time.time()
        response: LLMResponse = await self._llm.call(
            prompt=prompt,
            message_history=message_history,
            **self._llm_call_kwargs,
        )
        self._track_api_request_time(start_time)

        usage_info = response.usage
        self._update_subagent_metrics(usage_info)

        self._append_subagent_response_step(
            steps,
            response_step_id,
            response,
            usage_info,
            subagent_name_for_logging,
        )

        self._collect_subagent_rollout_detail(response)

        trajectory_ref = self._save_subagent_trajectory(
            session_id=session_id,
            agent_name=agent_name,
            steps=steps,
            usage_info=usage_info,
            filename_suffix=filename_suffix,
            summary_text=summary_text,
        )

        return response, trajectory_ref
```

**Non-obvious design decisions**

- The helper centralizes the prompt-call-account-save sequence so all three `_summarize` subagents produce the same trajectory structure and accounting. Duplicating this logic in `_summarize` would make step numbering, usage capture, and saved references easier to drift apart across subagents.
- It accepts `steps` as a mutable list instead of creating a local copy. That lets the caller control exactly which prior context appears in the saved subagent trajectory, but it also means the caller must intentionally manage list reuse and preparation.
- It updates request timing and subagent metrics immediately after `self._llm.call` and before saving the trajectory. This keeps the saved artifact aligned with the call that actually produced `response`; delaying those updates would make partial failures or later mutations harder to account for consistently.
- It returns both `LLMResponse` and `SubagentTrajectoryRef` instead of only the model text. `_summarize` needs the response content to build the next subagent prompt and also needs the trajectory reference for later bookkeeping, so this helper preserves both products in one call.

**Relations**

- **Callers**: Terminus2._summarize
- **Core callees**: self._llm.call; Terminus2._track_api_request_time; Terminus2._update_subagent_metrics; Terminus2._append_subagent_response_step; Terminus2._collect_subagent_rollout_detail; Terminus2._save_subagent_trajectory
- **Config / state sources**: self._llm; self._llm_call_kwargs
- **Results to**: Returned `LLMResponse` feeds the next `_summarize` subagent prompt; Returned `SubagentTrajectoryRef` is accumulated by `_summarize` for later stage bookkeeping; Saved trajectory artifact becomes the persisted record for this subagent run; Updated subagent metrics contribute to stage-5 aggregated metadata via `reg-subagent-metrics`
- **Related siblings**: Terminus2._summarize uses this helper three times to implement the full summarization ritual; Terminus2._prepare_copied_trajectory_steps can prepare copied trajectory context before subagent trajectories are built; Terminus2._remove_metrics_from_copied_steps sanitizes copied steps so subagent context does not duplicate accounting data
- **📊 Register interactions**: ✏️ writes `reg-subagent-metrics` — updates usage totals for this subagent call; ✏️ writes `reg-api-request-times` — records elapsed time after LLM returns

</details>


<details id="fn-terminus2_collect_subagent_rollout_detail">
<summary><b>Terminus2._collect_subagent_rollout_detail</b> — terminus_2.py:600-622 · Capture subagent rollout metadata for later persistence</summary>

> **Stage context**: This helper sits inside the context-summarization subagent path, where `_run_subagent` records extra diagnostics from each subagent LLM call. `_summarize` drives the three-subagent ritual, `_run_subagent` handles each call and trajectory artifact, and this function adds optional rollout payloads from the returned `LLMResponse` into the subagent-specific detail store.

**What this code does**

The function inspects one `LLMResponse` and extracts any available rollout fields from `response.prompt_token_ids`, `response.completion_token_ids`, `response.logprobs`, and `response.extra`. If `self._collect_rollout_details` is false, it does nothing. Otherwise, when at least one of those fields is present, it appends a normalized `RolloutDetail` record to `self._subagent_rollout_details`; its real output is that in-memory append.

**Interface · params / IO**

`(self, response: LLMResponse) -> None`

- params: `response`: `LLMResponse` — Subagent LLM result object that may carry token IDs, logprobs, and provider-specific extras
- reads: `self._collect_rollout_details`, `self._subagent_rollout_details`
- returns: Returns `None`; when collection is enabled and any rollout fields exist, the real product is one appended `RolloutDetail` entry in `self._subagent_rollout_details`.
- effects: Appends a `RolloutDetail` dict to `self._subagent_rollout_details`

**Execution flow**

1. Check `self._collect_rollout_details`; if the flag is false, exit immediately without inspecting `response` further.
2. Start an empty `rollout_detail` dict and copy in `response.prompt_token_ids`, `response.completion_token_ids`, and `response.logprobs` only when each field is `is not None`.
3. If `response.extra` is present, rebuild it as `{"key": [value]}` pairs so each extra value also fits the rollout-list schema.
4. Append `rollout_detail` to `self._subagent_rollout_details` only when the dict is non-empty, so blank responses do not create empty detail records.

**Source**

```python
    def _collect_subagent_rollout_detail(self, response: LLMResponse) -> None:
        """Collect rollout details from a subagent LLM response.

        Args:
            response: The LLM response containing token IDs and logprobs
        """
        if not self._collect_rollout_details:
            return

        rollout_detail: RolloutDetail = {}
        if response.prompt_token_ids is not None:
            rollout_detail["prompt_token_ids"] = [response.prompt_token_ids]
        if response.completion_token_ids is not None:
            rollout_detail["completion_token_ids"] = [response.completion_token_ids]
        if response.logprobs is not None:
            rollout_detail["logprobs"] = [response.logprobs]
        if response.extra is not None:
            rollout_detail["extra"] = {
                key: [value] for key, value in response.extra.items()
            }

        if rollout_detail:
            self._subagent_rollout_details.append(rollout_detail)
```

**Non-obvious design decisions**

- The early return on `self._collect_rollout_details` keeps rollout capture fully optional. That avoids growing `_subagent_rollout_details` or touching response payloads when the caller has not enabled this diagnostics path.
- The code uses explicit `is not None` checks for every response field, instead of truthiness checks. That preserves empty-but-valid payloads such as empty token lists or empty extra mappings, which would be lost if the code treated falsy values as absent.
- The function wraps every captured payload in a single-element list, including each `response.extra` value. That keeps subagent data aligned with a rollout-oriented schema that expects per-response sequences, even though this helper handles only one `LLMResponse` at a time.
- The final `if rollout_detail:` gate skips empty records. Without that guard, enabled collection would accumulate placeholder entries for responses that expose none of the tracked rollout fields.

**Relations**

- **Callers**: Terminus2._run_subagent
- **Core callees**: list.append on `self._subagent_rollout_details`
- **Config / state sources**: `self._collect_rollout_details` enables or disables capture; `response.prompt_token_ids`; `response.completion_token_ids`; `response.logprobs`; `response.extra`
- **Results to**: `self._subagent_rollout_details` for later rollout-detail consumption; Subagent bookkeeping performed alongside `_run_subagent` trajectory capture; Context-summarization subagent diagnostics initiated by `_summarize`
- **Related siblings**: Terminus2._run_subagent; Terminus2._summarize

</details>


<details id="fn-terminus2_save_subagent_trajectory">
<summary><b>Terminus2._save_subagent_trajectory</b> — terminus_2.py:1763-1828 · Persist one summarization subagent trajectory</summary>

> **Stage context**: This helper turns one summarization subagent run into a saved trajectory artifact and a lightweight reference that the parent run can keep. `_run_subagent` calls it after recording the subagent's prompt/response steps and usage data. In this stage, it supplies the per-subagent artifacts that `_summarize` later returns alongside the handoff prompt.

**What this code does**

The function takes a subagent `session_id`, `agent_name`, recorded `steps`, raw `usage_info`, a `filename_suffix`, and a human-readable `summary_text`, then packages them into a `Trajectory`. It reads model and run metadata from `self._model_name`, `self._session_id`, `self._summarization_count`, `self.logs_dir`, `self.version()`, and `_extract_usage_metrics()`, writes a JSON trajectory file under `self.logs_dir`, and returns a `SubagentTrajectoryRef` pointing to that filename. If the file write fails, it logs the error but still returns the reference object.

**Interface · params / IO**

`(self, session_id: str, agent_name: str, steps: list[Step], usage_info, filename_suffix: str, summary_text: str) -> SubagentTrajectoryRef`

- params: `session_id`: `str` — Session id to store in the subagent trajectory and returned reference; `agent_name`: `str` — Agent name for the `Trajectory.agent.name` field; `steps`: `list[Step]` — Recorded subagent trajectory steps to embed in the saved artifact; `usage_info`: `?` — Raw LLM usage payload passed to `_extract_usage_metrics()`; `filename_suffix`: `str` — Suffix used in the output filename and log messages; `summary_text`: `str` — Human-readable label stored in `SubagentTrajectoryRef.extra["summary"]`
- reads: `self._model_name`, `self._session_id`, `self._summarization_count`, `self.logs_dir`, `self.logger`, `self.version`, `self._extract_usage_metrics`
- returns: A `SubagentTrajectoryRef` with the subagent `session_id`, the output filename in `trajectory_path`, and `extra={"summary": summary_text}`
- effects: Writes a trajectory JSON file to `self.logs_dir / f"trajectory.summarization-{self._summarization_count}-{filename_suffix}.json"`; Emits a debug log on successful save; Emits an error log if the save raises an exception

**Execution flow**

1. It calls `self._extract_usage_metrics(usage_info)` and unpacks `total_prompt`, `total_completion`, `total_cached`, and `total_cost` for the subagent run.
2. It builds a `Trajectory` object that carries the passed `session_id`, `agent_name`, and `steps`, plus an `Agent` block populated from `self.version() or "unknown"`, `self._model_name`, and `extra={"parent_session_id": self._session_id, "summarization_index": self._summarization_count}`.
3. It builds `FinalMetrics` from the extracted usage values and stores `total_cost_usd` only when `total_cost > 0`; otherwise it stores `None`.
4. It derives `trajectory_path` under `self.logs_dir` using the current `self._summarization_count` and the provided `filename_suffix`.
5. Inside a `try` block, it serializes the trajectory with `format_trajectory_json(trajectory.to_json_dict())`, writes that JSON to `trajectory_path`, and logs a debug message naming the saved file.
6. If the write fails, it catches `Exception`, logs an error with `save_error`, and then still returns a `SubagentTrajectoryRef` that points to the intended filename and carries `summary_text` in `extra`.

**Source**

```python
    def _save_subagent_trajectory(
        self,
        session_id: str,
        agent_name: str,
        steps: list[Step],
        usage_info,
        filename_suffix: str,
        summary_text: str,
    ) -> SubagentTrajectoryRef:
        """Save a subagent trajectory to disk and return its reference.

        Args:
            session_id: Session ID for the subagent
            agent_name: Name of the subagent (e.g., "terminus-2-summarization-summary")
            steps: List of trajectory steps
            usage_info: Usage information from LLM response
            filename_suffix: Suffix for trajectory filename (e.g., "summary", "questions", "answers")
            summary_text: Human-readable summary for the trajectory ref extra field

        Returns:
            SubagentTrajectoryRef for inclusion in parent trajectory
        """
        total_prompt, total_completion, total_cached, total_cost = (
            self._extract_usage_metrics(usage_info)
        )

        trajectory = Trajectory(
            session_id=session_id,
            agent=Agent(
                name=agent_name,
                version=self.version() or "unknown",
                model_name=self._model_name,
                extra={
                    "parent_session_id": self._session_id,
                    "summarization_index": self._summarization_count,
                },
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_prompt,
                total_completion_tokens=total_completion,
                total_cached_tokens=total_cached,
                total_cost_usd=total_cost if total_cost > 0 else None,
            ),
        )

        trajectory_path = (
            self.logs_dir
            / f"trajectory.summarization-{self._summarization_count}-{filename_suffix}.json"
        )
        try:
            with open(trajectory_path, "w") as f:
                f.write(format_trajectory_json(trajectory.to_json_dict()))
            self.logger.debug(
                f"{filename_suffix.capitalize()} subagent trajectory saved to {trajectory_path}"
            )
        except Exception as save_error:
            self.logger.error(
                f"Failed to save {filename_suffix} subagent trajectory: {save_error}"
            )

        return SubagentTrajectoryRef(
            session_id=session_id,
            trajectory_path=str(trajectory_path.name),
            extra={"summary": summary_text},
        )
```

**Non-obvious design decisions**

- It embeds `parent_session_id` and `summarization_index` in `Agent.extra` so each subagent artifact stays linked to the parent run and the specific summarization pass. Without that extra metadata, later inspection would have to infer lineage from filenames alone.
- It converts `self.version()` to `self.version() or "unknown"` so the saved artifact always has a usable version string. The alternative would preserve `None`, but that would make downstream readers handle a missing version field.
- It stores `total_cost_usd` only when `total_cost > 0`. That avoids writing a misleading zero-cost value when usage extraction did not produce a meaningful cost.
- It catches save errors and still returns `SubagentTrajectoryRef` instead of failing the summarization flow. That choice favors keeping the parent summarization ritual alive, even if one artifact file could not be written; propagating the exception here would make `_run_subagent` fail after already producing a model response.

**Relations**

- **Callers**: Terminus2._run_subagent
- **Core callees**: Terminus2._extract_usage_metrics; Terminus2.version; Trajectory; Agent; FinalMetrics; format_trajectory_json; SubagentTrajectoryRef
- **Config / state sources**: self._model_name; self._session_id; self._summarization_count; self.logs_dir
- **Results to**: returns `SubagentTrajectoryRef` to `Terminus2._run_subagent`; saved JSON artifact under `self.logs_dir`; `Terminus2._summarize`, via `_run_subagent`, includes these refs in its return tuple; parent trajectory linkage later consumes the subagent refs recorded by the summarization flow
- **Related siblings**: Terminus2._run_subagent records the subagent steps and calls this saver; Terminus2._summarize orchestrates the three subagent runs whose artifacts this function persists
- **📊 Register interactions**: 👁 reads `reg-summarization-count` — name file and tag summarization pass

</details>


<details id="fn-terminus2_convert_chat_messages_to_steps">
<summary><b>Terminus2._convert_chat_messages_to_steps</b> — terminus_2.py:1830-1888 · Convert chat dicts into trajectory steps</summary>

> **Stage context**: This helper reshapes chat-style message records into `Step` objects. Within the summarization side flow, it serves as an adapter from `chat_messages` plus an optional handoff prompt to the trajectory format used elsewhere.

**What this code does**

The function takes `chat_messages`, an optional `additional_user_message`, and a `mark_as_copied` flag, then returns a new `list[Step]`. It reads each message with direct `msg["role"]` and `msg["content"]` indexing, maps `"assistant"` messages to `Step(source="agent")`, and uses `self._last_response_model_name or self._model_name` for those assistant-derived steps. If `mark_as_copied` is true, it marks each converted step with `is_copied_context=True`. If `additional_user_message` is truthy, it appends one final `user` step and intentionally leaves that appended step unmarked as copied.

**Interface · params / IO**

`(self, chat_messages: list[dict], additional_user_message: str | None = None, mark_as_copied: bool = False) -> list[Step]`

- params: `chat_messages`: `list[dict]` — input chat records; each item is read via `msg["role"]` and `msg["content"]`; `additional_user_message`: `str | None` — optional final user message appended only when this value is truthy; `mark_as_copied`: `bool` — flag that marks each converted chat-derived step as copied context
- reads: `self._last_response_model_name`, `self._model_name`
- returns: A newly built `list[Step]` representing the converted chat history, plus one appended final user step when `additional_user_message` is truthy.

**Execution flow**

1. Initialize an empty `steps` list and start `step_id` at `1`.
2. Iterate through `chat_messages`, read each entry with `msg["role"]` and `msg["content"]`, and build one `Step` per message.
3. For `role == "assistant"`, create `Step(source="agent", message=content, model_name=self._last_response_model_name or self._model_name)`; for every other role, keep `source=role` and omit `model_name`.
4. If `mark_as_copied` is true, set `step.is_copied_context = True` on each converted chat-derived step, then append the step and increment `step_id`.
5. After all chat messages, if `additional_user_message` is truthy, append one more `Step` with the current `step_id`, `source="user"`, and `message=additional_user_message`.
6. Return the assembled `steps` list.

**Source**

```python
    def _convert_chat_messages_to_steps(
        self,
        chat_messages: list[dict],
        additional_user_message: str | None = None,
        mark_as_copied: bool = False,
    ) -> list[Step]:
        """Convert chat messages to trajectory steps.

        Args:
            chat_messages: List of chat messages with 'role' and 'content' fields
            additional_user_message: Optional additional user message to append as final step
            mark_as_copied: If True, mark all steps with is_copied_context=True (for continuation trajectories)

        Returns:
            List of Step objects representing the chat history
        """
        steps = []
        step_id = 1

        for msg in chat_messages:
            role = msg["role"]
            content = msg["content"]

            # Map chat role to trajectory source
            if role == "assistant":
                source = "agent"
                step = Step(
                    step_id=step_id,
                    source=source,
                    message=content,
                    model_name=self._last_response_model_name or self._model_name,
                )
            else:
                source = role
                step = Step(
                    step_id=step_id,
                    source=source,
                    message=content,
                )

            # Mark as copied context if this is for a continuation trajectory
            if mark_as_copied:
                step.is_copied_context = True

            steps.append(step)
            step_id += 1

        # Add the additional user message if provided
        # Note: The additional user message is NOT marked as copied since it's the new handoff prompt
        if additional_user_message:
            steps.append(
                Step(
                    step_id=step_id,
                    source="user",
                    message=additional_user_message,
                )
            )

        return steps
```

**Non-obvious design decisions**

- The code remaps chat `role == "assistant"` to trajectory `source="agent"` instead of preserving the original label. That choice is explicit in the branch and keeps assistant-originated steps distinct from raw chat-role naming.
- Assistant-derived steps use `self._last_response_model_name or self._model_name`, so the function prefers the most recent response model name but falls back when that value is absent or falsey. The code applies this only to assistant messages; other roles never get a `model_name` here.
- The appended handoff step is gated by `if additional_user_message:`, not an `is not None` check. Empty strings therefore do not create a trailing user step.
- When `mark_as_copied` is true, the function marks only the steps created from `chat_messages`. The comment and code both exclude the optional appended user step from copied-context marking.

**Relations**

- **Callers**: unknown from this excerpt
- **Core callees**: `Step(...)` constructor
- **Config / state sources**: `self._last_response_model_name`; `self._model_name`
- **Results to**: returns a `list[Step]` to its caller; returned steps can feed trajectory-building code; returned copied-context flags reflect the `mark_as_copied` argument; returned final user step reflects `additional_user_message` when truthy
- **Related siblings**: `Terminus2._prepare_copied_trajectory_steps` also works with copied-context trajectory material; `Terminus2._remove_metrics_from_copied_steps` mutates copied `Step` objects after they exist

</details>
