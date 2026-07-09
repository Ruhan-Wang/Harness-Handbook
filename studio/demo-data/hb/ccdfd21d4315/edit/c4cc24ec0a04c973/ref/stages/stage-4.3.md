### 4.3 · LLM Query

#### (a) Opening Explanation

This stage exists to turn the current conversation state into an actual model answer, and to keep the loop alive when that call hits model limits or transient API failures. It sits right after stage-4.2, which may have prepared a summary handoff in advance, and right before stage-4.4, which parses the reply. Its job is not just “call the LLM.” It also records per-episode logging, snapshots token and cost totals before the call, and owns last-minute recovery if the request is too large or the output is cut off. That matters because token overflow is discovered at call time, not just earlier in the pipeline. Without this stage, the agent would fail at the exact moment it needs a usable response.

#### (b) Main Flow

1. `_setup_episode_logging()` (pick log paths for this episode) runs so this specific model interaction can be traced later.  
   This stage owns the moment where a new LLM exchange is about to happen, so it is the right place to attach episode-specific logs and baseline metrics.

2. The loop snapshots token and cost totals before the call.  
   The point is simple: after the call returns, the agent can tell what this one interaction consumed rather than only knowing the cumulative totals.

3. `_handle_llm_interaction()` (the thin wrapper for “get the next model reply”) hands control to `_query_llm()` (the actual provider call plus recovery logic).  
   On the success path, this produces the primary output of the stage: the raw LLM response object/text that stage-4.4 will parse.

4. If the request is too large and the provider raises `ContextLengthExceededError`, recovery happens here, after the failed call.  
   First, `_unwind_messages_to_free_tokens()` removes older message history to make room. Then this stage tries to rebuild enough context through a three-step fallback: full summarize, then a shorter one-shot summary from the LLM, then a final no-LLM fallback that uses a tail of terminal output. If this reactive path creates a handoff summary, it writes `reg-pending-handoff-prompt` so later stages can reshape the conversation history cleanly.  
   This stage owns that recovery because this is where the system learns the prompt is still too big despite the proactive probe in stage-4.2.

5. If the provider cuts off the answer and raises `OutputLengthExceededError`, this stage first tries to salvage the partial reply.  
   That salvage path only works for the XML parser, because truncated XML can sometimes still be repaired into something parseable. If salvage fails, the stage sends a clear error back to the model and asks again. The goal is to recover a usable reply without making downstream parsing guess at broken output.

6. Other exceptions are treated differently.  
   The `@retry` wrapper is for ordinary transient failures around the query path, such as flaky provider/API errors. It retries up to three times. It does **not** mean every failure mode is blindly retried first: context overflow and output truncation have their own explicit recovery branches inside `_query_llm()`.

7. On any successful call, this stage also records the request duration in `reg-api-request-times`.  
   That does not affect control flow, but it gives the system timing data for later metadata and diagnostics.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-api-request-times` — appended during successful/attempted LLM query timing capture so later stages can report per-request latency
- writes: `reg-pending-handoff-prompt` — written only if reactive overflow recovery in this stage generates a summary-handoff prompt after a context-length failure
- triggers downstream: `stage-4.4 Response Parse` — once this stage has a usable raw LLM response, whether from the normal call path or a recovery path

#### (d) Pipeline Hand-Off

From stage-4.2, this stage inherits a prepared prompt state and possibly a proactively prepared handoff summary if the system already suspected the context was getting large. It produces the concrete thing stage-4.4 needs next: a raw model reply to parse, plus timing data and, in overflow cases, a pending handoff prompt that later stages can use to repair or split history.

<details id="fn-terminus2_setup_episode_logging">
<summary><b>Terminus2._setup_episode_logging</b> — terminus_2.py:512-525 · Prepare per-episode LLM logging file paths</summary>

> **Stage context**: This helper supports stage-4.3 by setting up the filesystem locations that hold prompt/response diagnostics for one LLM episode. `_run_agent_loop` invokes it immediately before the stage's LLM call path so later logic can write `debug.json`, `prompt.txt`, and `response.txt` consistently. In this stage it is setup-only; the actual LLM interaction and retry/fallback handling happen in `_handle_llm_interaction` and `_query_llm`.

**What this code does**

`_setup_episode_logging` turns `logging_dir` and `episode` into three per-episode file paths. If `logging_dir` is `None`, it disables episode logging by returning `(None, None, None)`. Otherwise it creates the `episode-{episode}` directory on disk and returns paths for `debug.json`, `prompt.txt`, and `response.txt` inside that directory.

**Interface · params / IO**

`(self, logging_dir: Path | None, episode: int) -> tuple[Path | None, Path | None, Path | None]`

- params: `self`: `?` — Terminus2 instance; unused except as method receiver; `logging_dir`: `Path | None` — Optional base directory that enables episode-specific logging; `episode`: `int` — Episode number used in the `episode-{episode}` subdirectory name
- returns: A 3-tuple of `Path | None` values for `debug.json`, `prompt.txt`, and `response.txt`; returns `(None, None, None)` when `logging_dir` is `None`
- effects: Creates `logging_dir / f"episode-{episode}"` on disk with `mkdir(parents=True, exist_ok=True)` when logging is enabled

**Execution flow**

1. Check `logging_dir`. If it is `None`, return `None, None, None` and skip all filesystem work.
2. Build `episode_logging_dir` as `logging_dir / f"episode-{episode}"` to give this episode its own namespace.
3. Create `episode_logging_dir` with `mkdir(parents=True, exist_ok=True)` so later writes can assume the directory exists.
4. Return three file paths under `episode_logging_dir`: `debug.json`, `prompt.txt`, and `response.txt`.

**Source**

```python
    def _setup_episode_logging(
        self, logging_dir: Path | None, episode: int
    ) -> tuple[Path | None, Path | None, Path | None]:
        if logging_dir is None:
            return None, None, None

        episode_logging_dir = logging_dir / f"episode-{episode}"
        episode_logging_dir.mkdir(parents=True, exist_ok=True)

        return (
            episode_logging_dir / "debug.json",
            episode_logging_dir / "prompt.txt",
            episode_logging_dir / "response.txt",
        )
```

**Non-obvious design decisions**

- The `logging_dir is None` branch disables logging by contract and returns a full tuple of `None` placeholders. That lets callers keep one unpacking shape whether logging is on or off, instead of branching around separate path variables.
- The function centralizes the `episode-{episode}` naming scheme and file names in one place. That avoids duplicating path construction across the stage-4.3 LLM call path, where prompt, response, and debug artifacts must stay aligned.
- It creates the directory eagerly with `exist_ok=True`. That favors idempotent setup before writing diagnostics and avoids forcing downstream code to handle missing-parent errors or repeated setup.

**Relations**

- **Callers**: `Terminus2._run_agent_loop` immediately before an LLM interaction
- **Core callees**: `Path.mkdir` on `episode_logging_dir`
- **Config / state sources**: `logging_dir` argument from the caller's logging configuration; `episode` argument from the current loop iteration
- **Results to**: Returned path tuple feeds the stage-4.3 LLM interaction path; Later diagnostic writes target `debug.json`; Later prompt capture writes target `prompt.txt`; Later model output capture writes target `response.txt`
- **Related siblings**: `Terminus2._handle_llm_interaction` consumes the prepared paths during the actual LLM call flow; `Terminus2._query_llm` performs the request whose prompt/response artifacts these paths are meant to hold

</details>


<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1302-1319 (2 regions) · prepare per-call baselines, then await the LLM interaction result</summary>

> **Stage context**: This mapped slice of `Terminus2._run_agent_loop` does two things in sequence. It first captures local inputs for this call: `logging_paths` from `_setup_episode_logging(...)` and four cumulative usage counters from `chat`. It then awaits `_handle_llm_interaction(...)` and binds its six returned values to local names for later use in the surrounding function.

### What this code does

This slice starts by assigning `logging_paths = self._setup_episode_logging(logging_dir, episode)`. It then snapshots `chat.total_input_tokens`, `chat.total_output_tokens`, `chat.total_cache_tokens`, and `chat.total_cost` into local `*_before` variables. After those baselines are recorded, it awaits `self._handle_llm_interaction(chat, prompt, logging_paths, original_instruction, self._session)`. The awaited result is unpacked into `commands`, `is_task_complete`, `feedback`, `analysis`, `plan`, and `llm_response`.

### Interface · params / IO

`async def _run_agent_loop(self, chat, prompt, logging_dir, episode, original_instruction):`

- params: `self`: `Terminus2` — owner of helper methods and session state; `chat`: `?` — source of cumulative usage counters and argument to `_handle_llm_interaction`; `prompt`: `?` — prompt value forwarded to `_handle_llm_interaction`; `logging_dir`: `?` — input forwarded to `_setup_episode_logging`; `episode`: `?` — input forwarded to `_setup_episode_logging`; `original_instruction`: `?` — value forwarded to `_handle_llm_interaction`
- reads: `self._session`, `chat.total_input_tokens`, `chat.total_output_tokens`, `chat.total_cache_tokens`, `chat.total_cost`
- returns: This slice does not return. Its direct products are local bindings: `logging_paths`, four `*_before` usage baselines, and the six values unpacked from `_handle_llm_interaction(...)`.
- effects: awaits `self._handle_llm_interaction(...)`; calls `self._setup_episode_logging(...)` and stores its return value

### Overall structure

| Region | Lines | Role | Terminal state |
|---|---|---|---|
| 1 | 1296-1303 | collect logging paths and usage baselines | continues with the awaited `_handle_llm_interaction(...)` call |
| 2 | 1304-1313 | await and unpack LLM interaction outputs | continues in the surrounding function with six local result variables bound |

---

#### Region 1 · collect logging paths and usage baselines (terminus_2.py:1296-1303)

The code first assigns `logging_paths` from `self._setup_episode_logging(logging_dir, episode)`. It then reads the cumulative counters `chat.total_input_tokens`, `chat.total_output_tokens`, `chat.total_cache_tokens`, and `chat.total_cost` and stores them in `tokens_before_input`, `tokens_before_output`, `tokens_before_cache`, and `cost_before`. These names make the values explicit pre-call checkpoints. Control then moves to the awaited interaction call in the next region.

> ⤵ This region calls [`Terminus2._setup_episode_logging`](#fn-terminus2_setup_episode_logging) — derive `logging_paths` for this call

```python
            logging_paths = self._setup_episode_logging(logging_dir, episode)

            # Track token counts and cost before this step
            tokens_before_input = chat.total_input_tokens
            tokens_before_output = chat.total_output_tokens
            tokens_before_cache = chat.total_cache_tokens
            cost_before = chat.total_cost

```

---

#### Region 2 · await and unpack LLM interaction outputs (terminus_2.py:1304-1313)

This region awaits `self._handle_llm_interaction(chat, prompt, logging_paths, original_instruction, self._session)`. The awaited result must be a six-item tuple, because the code unpacks it into `commands`, `is_task_complete`, `feedback`, `analysis`, `plan`, and `llm_response`. The region's work is only the call and tuple binding. After unpacking, the surrounding function can use those locals.

> ⤵ This region calls [`Terminus2._handle_llm_interaction`](#fn-terminus2_handle_llm_interaction) — produce six values for local bindings

```python
            (
                commands,
                is_task_complete,
                feedback,
                analysis,
                plan,
                llm_response,
            ) = await self._handle_llm_interaction(
                chat, prompt, logging_paths, original_instruction, self._session
            )
```


---

### Non-obvious design decisions (cross-region)

- The code snapshots the cumulative `chat.total_*` and `chat.total_cost` counters into local `*_before` variables before the awaited `_handle_llm_interaction(...)` call. This is a deliberate checkpoint pattern: later code can compare post-call totals against these pre-call baselines to compute per-call deltas.

### Relations

- **Callers**: Terminus2._run_agent_loop
- **Core callees**: Terminus2._setup_episode_logging; Terminus2._handle_llm_interaction
- **Config / state sources**: self._session; chat.total_input_tokens; chat.total_output_tokens; chat.total_cache_tokens; chat.total_cost; logging_dir; episode
- **Results to**: local `logging_paths`; local `tokens_before_input`; local `tokens_before_output`; local `tokens_before_cache`; local `cost_before`; local `commands`; local `is_task_complete`; local `feedback`; local `analysis`; local `plan`; local `llm_response`
- **Related siblings**: Terminus2._setup_episode_logging

</details>


<details id="fn-terminus2_handle_llm_interaction">
<summary><b>Terminus2._handle_llm_interaction</b> — terminus_2.py:1192-1194 · awaits core LLM query into local response</summary>

> **Stage context**: This region sits inside `Terminus2._handle_llm_interaction` during the stage's actual model call. It runs after sibling code has prepared `chat`, `prompt`, and `logging_paths`, and before later code in the same function inspects `llm_response`.

**What this code does**

This region awaits `self._query_llm(...)` with the current local inputs `chat`, `prompt`, `logging_paths`, `original_instruction`, and `session`. It stores the awaited result in local `llm_response`. The snippet shows a simple await-assignment and no direct state mutation.

**Interface · params / IO**

`region inputs: local names `chat`, `prompt`, `logging_paths`, `original_instruction`, `session`; bound method `self._query_llm``

- params: `chat`: `?` — local conversation object passed through to `_query_llm`; `prompt`: `?` — local prompt value forwarded to `_query_llm`; `logging_paths`: `?` — local logging destination tuple forwarded to `_query_llm`; `original_instruction`: `?` — local original instruction forwarded to `_query_llm`; `session`: `?` — local session value forwarded to `_query_llm`; `self._query_llm`: `callable` — bound async helper invoked and awaited
- reads: `self._query_llm`
- returns: binds local `llm_response` to the awaited result of `self._query_llm(...)`

**Execution flow**

1. Call `self._query_llm` with `chat`, `prompt`, `logging_paths`, `original_instruction`, and `session`.
2. Await that call and assign the resulting value to local `llm_response`.

**Source**

```python
        llm_response = await self._query_llm(
            chat, prompt, logging_paths, original_instruction, session
        )
```

**Non-obvious design decisions**

- No non-obvious behavior is visible here. The region is a direct await-assignment, and any retry, logging, or fallback policy lives outside this line range.

**Relations**

- **Callers**: Terminus2._handle_llm_interaction
- **Core callees**: Terminus2._query_llm
- **Config / state sources**: self._query_llm; local `chat`; local `prompt`; local `logging_paths`; local `original_instruction`; local `session`
- **Results to**: local `llm_response` in `Terminus2._handle_llm_interaction`
- **Related siblings**: Terminus2._setup_episode_logging; Terminus2._run_agent_loop

</details>


<details id="fn-terminus2_query_llm">
<summary><b>Terminus2._query_llm</b> — terminus_2.py:1008-1182 (7 regions) · Primary LLM call with overflow recovery and retry shaping</summary>

> **Stage context**: This function sits under `_handle_llm_interaction`, which simply awaits it and returns the resulting `llm_response`. The owning stage snapshots token and cost totals before this call, so `_query_llm` focuses on making the request, timing it, logging prompt/response files, and recovering from the two modeled LLM overflow failures.

### What this code does

`_query_llm` sends `prompt` through `chat.chat(...)` and returns the resulting LLM response on the normal path. It optionally writes `prompt` and response text to the per-episode files supplied in `logging_paths`, and it records each actual `chat.chat(...)` duration in `self._api_request_times`. If `ContextLengthExceededError` occurs, it switches to a three-level recovery path: unwind history, try full `_summarize(...)`, then a short one-shot summary, then a screen-only fallback prompt. If `OutputLengthExceededError` occurs, it first asks `self._parser` to salvage a valid partial answer from `truncated_response`; otherwise it injects a corrective user message into `chat.messages` and recursively retries. Any other exception is only logged here and then re-raised for the surrounding retry policy.

### Interface · params / IO

`async def _query_llm(self, chat, prompt, logging_paths, original_instruction, session)`

- params: `chat`: `?` — Active chat object used for `chat.chat(...)`, message history, and response-chain reset; `prompt`: `?` — Current prompt text to send, or later the corrective retry message; `logging_paths`: `?` — Tuple unpacked as `(logging_path, prompt_path, response_path)` from `_setup_episode_logging`; `original_instruction`: `?` — Task instruction reused when building summarization fallback prompts; `session`: `?` — Live terminal session required for screen capture during context-overflow recovery
- reads: `self._llm_call_kwargs`, `self._enable_summarize`, `self._llm`, `self._parser`, `self.logger`
- returns: An LLM response object on the normal and context-overflow paths; on successful output-overflow salvage it returns the salvaged response value directly
- effects: Appends request timings to `self._api_request_times`; Writes prompt text to `prompt_path` when provided; Writes response or corrective text to `response_path` when provided; May mutate `self._pending_subagent_refs` and `self._pending_handoff_prompt` during full summarization fallback; May mutate `chat.messages` and call `chat.reset_response_chain()` before recursive retry; May unwind chat history via `_unwind_messages_to_free_tokens(...)`

### Overall structure

| Region | Lines | Role | Terminal state |
|---|---|---|---|
| 1 | 1002-1020 | Normal request, timing, and file logging | Returns `llm_response` on success; otherwise control moves into exception handling |
| 2 | 1024-1034 | Context-overflow gate and pre-recovery trimming | Raises if summarization is disabled or `session` is missing; otherwise continues to fallback prompt construction |
| 3 | 1035-1079 | Construct summary-based replacement prompt | Produces `summary_prompt`, optionally logs it, then proceeds to retry the chat call |
| 4 | 1080-1099 | Retry chat with fallback prompt | Returns fallback `llm_response`, or a canned technical-difficulties response if retry fails |
| 5 | 1102-1127 | Attempt parser-based salvage of truncated output | Returns salvaged content when available; otherwise continues to corrective retry setup |
| 6 | 1128-1172 | Build corrective retry after unsalvageable truncation | Recursively calls `_query_llm(...)` with an error prompt after updating chat history |
| 7 | 1175-1176 | Log and re-raise unknown failure | Raises the original exception to the caller |

---

#### Region 1 · Normal request, timing, and file logging (terminus_2.py:1002-1020)

This path unpacks `logging_paths` into `logging_path`, `prompt_path`, and `response_path`, then writes the outgoing `prompt` when `prompt_path is not None`. It wraps the main `await chat.chat(...)` call with `time.time()` measurements and appends the elapsed milliseconds to `self._api_request_times`. On success, it optionally writes `llm_response.content` to `response_path` and returns the `llm_response` object immediately. Any exception leaves this region through the surrounding exception handlers rather than being handled inline here.

```python
        logging_path, prompt_path, response_path = logging_paths

        if prompt_path is not None:
            prompt_path.write_text(prompt)

        try:
            start_time = time.time()
            llm_response = await chat.chat(
                prompt,
                logging_path=logging_path,
                **self._llm_call_kwargs,
            )
            end_time = time.time()
            request_time_ms = (end_time - start_time) * 1000
            self._api_request_times.append(request_time_ms)

            if response_path is not None:
                response_path.write_text(llm_response.content)
            return llm_response
```

---

#### Region 2 · Context-overflow gate and pre-recovery trimming (terminus_2.py:1024-1034)

This region handles the `ContextLengthExceededError` entry into fallback logic. It first checks `self._enable_summarize`; when that flag is off, it logs the condition and re-raises instead of attempting recovery. It also requires `session` for the later screen-based fallbacks and raises `RuntimeError` if no session is available. When both gates pass, it calls `_unwind_messages_to_free_tokens(chat, target_free_tokens=4000)` to shrink the live chat history before building any replacement prompt.

> ⤵ This region calls [`Terminus2._unwind_messages_to_free_tokens`](#fn-terminus2_unwind_messages_to_free_tokens) — Trim history before retrying after context overflow

```python
            if not self._enable_summarize:
                self.logger.debug("Context length exceeded and summarization is OFF.")
                raise

            self.logger.debug("Context length exceeded. Using fallback summarization.")

            if session is None:
                raise RuntimeError("Cannot handle context length error without session")

            self._unwind_messages_to_free_tokens(chat, target_free_tokens=4000)

```

---

#### Region 3 · Construct summary-based replacement prompt (terminus_2.py:1035-1079)

This region builds `summary_prompt` through three fallback levels. It first tries `await self._summarize(chat, original_instruction, session)`; when that succeeds, it stores `subagent_trajectory_refs` in `self._pending_subagent_refs` and stores the produced handoff text in `self._pending_handoff_prompt`. If full summarization fails, it captures the current terminal view from `session.capture_pane(...)`, asks `self._llm.call(...)` for a brief continuation summary, and wraps that into a new prompt. If that also fails, it falls back to a no-LLM prompt that combines `original_instruction` with the last 1000 characters of the current screen. Before handing off to the retry region, it writes the synthesized `summary_prompt` to `prompt_path` when logging is enabled.

> ⤵ This region calls [`Terminus2._summarize`](#fn-terminus2_summarize) — Produce full handoff prompt and subagent refs

```python
            summary_prompt = None
            # Fallback 1: Try full summary
            try:
                self.logger.debug("SUMMARIZATION: Attempting full summary")
                summary_prompt, subagent_trajectory_refs = await self._summarize(
                    chat, original_instruction, session
                )
                # Store subagent_refs to include in the trajectory
                self._pending_subagent_refs = subagent_trajectory_refs
                # Store handoff prompt to add as a user step
                self._pending_handoff_prompt = summary_prompt
                self.logger.debug("SUMMARIZATION: Full summary succeeded")
            except Exception as e:
                self.logger.debug(f"SUMMARIZATION: Full summary failed: {e}")

            # Fallback 2: Try short summary
            if summary_prompt is None:
                try:
                    self.logger.debug("SUMMARIZATION: Attempting short summary")
                    current_screen = await session.capture_pane(capture_entire=False)
                    limited_screen = current_screen[-1000:] if current_screen else ""

                    short_prompt = f"Briefly continue this task: {original_instruction}\n\nCurrent state: {limited_screen}\n\nNext steps (2-3 sentences):"

                    short_llm_response: LLMResponse = await self._llm.call(
                        prompt=short_prompt,
                        **self._llm_call_kwargs,
                    )
                    summary_prompt = f"{original_instruction}\n\nSummary: {short_llm_response.content}"
                    self.logger.debug("SUMMARIZATION: Short summary succeeded")
                except Exception as e:
                    self.logger.error(f"SUMMARIZATION: Short summary failed: {e}")

            # Fallback 3: Ultimate fallback (no LLM calls)
            if summary_prompt is None:
                self.logger.debug("SUMMARIZATION: Using ultimate fallback")
                current_screen = await session.capture_pane(capture_entire=False)
                limited_screen = current_screen[-1000:] if current_screen else ""
                summary_prompt = (
                    f"{original_instruction}\n\nCurrent state: {limited_screen}"
                )

            if prompt_path is not None:
                prompt_path.write_text(summary_prompt)

```

---

#### Region 4 · Retry chat with fallback prompt (terminus_2.py:1080-1099)

This region sends `summary_prompt` through the same `chat.chat(...)` path as the normal request and records the retry duration in `self._api_request_times`. If this second `chat.chat(...)` also raises, the code logs the failure and substitutes a minimal `LLMResponse(content="Technical difficulties. Please continue with the task.")` instead of propagating the error. It then optionally writes the resulting content to `response_path` and returns the fallback response.

```python
            try:
                start_time = time.time()
                llm_response = await chat.chat(
                    summary_prompt,
                    logging_path=logging_path,
                    **self._llm_call_kwargs,
                )
                end_time = time.time()
                request_time_ms = (end_time - start_time) * 1000
                self._api_request_times.append(request_time_ms)

            except Exception as e:
                self.logger.error(f"Even fallback chat failed: {e}")
                llm_response = LLMResponse(
                    content="Technical difficulties. Please continue with the task."
                )

            if response_path is not None:
                response_path.write_text(llm_response.content)
            return llm_response
```

---

#### Region 5 · Attempt parser-based salvage of truncated output (terminus_2.py:1102-1127)

This region handles `OutputLengthExceededError` by pulling `truncated_response` from the exception, with a placeholder string when that attribute is absent. It only attempts structured salvage when `self._parser` exposes `salvage_truncated_response`, which matches the comment that this path is XML-parser-specific. When salvage succeeds, it logs that the truncated output still contains a valid answer, optionally writes the salvaged text to `response_path`, and returns early. If no salvageable response exists, control falls through to the corrective retry logic.

```python
            self.logger.debug(f"Output length exceeded: {e}")

            truncated_response = getattr(
                e, "truncated_response", "[TRUNCATED RESPONSE NOT AVAILABLE]"
            )

            # Try to salvage a valid response from the truncated output
            # Only available for XML parser
            salvaged_response = None
            has_multiple_blocks = False

            if hasattr(self._parser, "salvage_truncated_response"):
                salvaged_response, has_multiple_blocks = (
                    self._parser.salvage_truncated_response(truncated_response)
                )

            if salvaged_response:
                self.logger.debug(
                    "Output exceeded length but found valid response. "
                    "Using truncated version."
                )

                if response_path is not None:
                    response_path.write_text(salvaged_response)

                return salvaged_response
```

---

#### Region 6 · Build corrective retry after unsalvageable truncation (terminus_2.py:1128-1172)

This region turns an unsalvageable truncated output into a new prompt that tells the model to re-issue its request within the actual output limit. It tries `self._parser.parse_response(truncated_response)` only to extract `parse_result.warning`; parse failures are logged at debug level and do not block recovery. It derives `limit_str` from `self._llm.get_model_output_limit()`, builds `error_msg`, then appends the failed exchange into `chat.messages` as a user/assistant pair and calls `chat.reset_response_chain()`. If `response_path` exists, it writes the corrective message there, then recursively calls `_query_llm(...)` with `prompt=error_msg` so the normal request machinery runs again.

> ⤵ This region calls [`Terminus2._query_llm`](#fn-terminus2_query_llm) — Retry through the same request pipeline recursively

```python

            # If we get here, we couldn't salvage a valid response
            # Try to parse the truncated response to get warnings
            warnings_text = ""
            try:
                parse_result = self._parser.parse_response(truncated_response)
                if parse_result.warning:
                    warnings_text = (
                        f"\n\nParser warnings from your truncated response:\n"
                        f"{parse_result.warning}"
                    )
            except Exception as parse_error:
                self.logger.debug(f"Failed to parse truncated response: {parse_error}")

            # Get the actual output limit for the model
            output_limit = self._llm.get_model_output_limit()
            if output_limit is not None:
                limit_str = f"{output_limit} tokens"
            else:
                limit_str = "the maximum output length"

            error_msg = (
                "ERROR!! NONE of the actions you just requested were performed "
                f"because you exceeded {limit_str}. "
                f"Your outputs must be less than {limit_str}. Re-issue this request, "
                f"breaking it into chunks each of which is less than {limit_str}."
            )

            if warnings_text:
                error_msg += warnings_text

            chat.messages.append({"role": "user", "content": prompt})
            chat.messages.append({"role": "assistant", "content": truncated_response})
            chat.reset_response_chain()

            if response_path is not None:
                response_path.write_text(error_msg)

            return await self._query_llm(
                chat=chat,
                prompt=error_msg,
                logging_paths=logging_paths,
                original_instruction=original_instruction,
                session=session,
            )
```

---

#### Region 7 · Log and re-raise unknown failure (terminus_2.py:1175-1176)

This final exception path catches any remaining `Exception` not handled by the overflow-specific branches. It records the failure with `self.logger.error(...)` and immediately re-raises the same exception. The caller therefore sees the original error, which matches the stage description that higher-level retry logic handles generic failures.

```python
            self.logger.error(f"Unknown Error in LLM interaction: {e}")
            raise e
```


---

### Non-obvious design decisions (cross-region)

- The function distinguishes two overflow classes instead of treating all failures alike: `ContextLengthExceededError` triggers history reduction plus prompt replacement, while `OutputLengthExceededError` tries to preserve the model's partial work through `self._parser.salvage_truncated_response(...)` before asking for a retry.
- Context-overflow recovery is deliberately layered. It prefers `_summarize(...)` first because that path can also populate `self._pending_subagent_refs` and `self._pending_handoff_prompt`, but it still keeps a short-summary path and a no-LLM terminal-screen fallback so the run can continue when summarization helpers fail.
- Request timing is only appended around actual `chat.chat(...)` calls, both on the normal path and the summary-prompt retry path. The short-summary helper call `self._llm.call(...)` is not timed here, which keeps `self._api_request_times` aligned with primary chat requests rather than every auxiliary model call.
- When output truncation cannot be salvaged, the code inserts the failed prompt and truncated assistant text into `chat.messages` and calls `chat.reset_response_chain()` before recursion. That preserves conversational context about the failed attempt while forcing the next request to start a fresh response chain.
- The fallback chat retry after context overflow degrades to a canned `LLMResponse` instead of raising again. By contrast, unknown exceptions are re-raised untouched. This split keeps the known overflow path user-recoverable while leaving generic fault handling to the outer retry wrapper described by the owning stage.

### Relations

- **Callers**: Terminus2._handle_llm_interaction
- **Core callees**: chat.chat; Terminus2._unwind_messages_to_free_tokens; Terminus2._summarize; session.capture_pane; self._llm.call; self._parser.salvage_truncated_response; self._parser.parse_response; chat.reset_response_chain
- **Config / state sources**: self._llm_call_kwargs; self._enable_summarize; self._llm; self._parser
- **Results to**: Terminus2._handle_llm_interaction; episode prompt/response log files from `_setup_episode_logging`; stage-5 context metadata via `self._api_request_times`
- **Related siblings**: Terminus2._setup_episode_logging; Terminus2._run_agent_loop; Terminus2._handle_llm_interaction; Terminus2._summarize
- **📊 Register interactions**: ✏️ writes `reg-api-request-times` — Append elapsed ms for each chat.chat call; ✏️ writes `reg-pending-subagent-refs` — Store summarization subagent refs on full-summary success; ✏️ writes `reg-pending-handoff-prompt` — Store fallback handoff prompt from full summary; ✏️ writes `reg-chat-messages` — Append failed prompt and truncated assistant output

</details>


<details id="fn-terminus2_unwind_messages_to_free_tokens">
<summary><b>Terminus2._unwind_messages_to_free_tokens</b> — terminus_2.py:574-598 · Context-history trimming before LLM retry</summary>

> **Stage context**: This helper supports stage 4.3's context-length recovery path. `_query_llm` calls it after `ContextLengthExceededError` to shrink `chat.messages` before trying the summarization fallback chain. Compared with sibling `_query_llm`, this function does not talk to the model; it only rewrites the live chat history and clears response-chain state so the next attempt starts from the shorter transcript.

**What this code does**

`_unwind_messages_to_free_tokens` trims recent history from a `Chat` until the model context has at least `target_free_tokens` available. It reads the model limit from `self._llm`, measures current usage through `self._count_total_tokens(chat)`, mutates `chat._messages` to a shorter prefix, and then resets the chat's response chain. It returns `None`; its product is the shortened `chat` state plus a debug log that reports the remaining message count and approximate free-token budget.

**Interface · params / IO**

`(self, chat: Chat, target_free_tokens: int = 4000) -> None`

- params: `chat`: `Chat` — Live conversation history to trim in place; `target_free_tokens`: `int` — Minimum free context budget to reach before stopping
- reads: `self._llm`, `self._count_total_tokens`, `self.logger`
- returns: Returns `None`; the real result is an in-place reduction of `chat` history and a reset response chain.
- effects: Mutates `chat._messages` by dropping recent messages; Calls `chat.reset_response_chain()` after trimming; Emits a debug log through `self.logger.debug(...)`

**Execution flow**

1. It reads `context_limit` from `self._llm.get_model_context_limit()` to establish the maximum token budget for this model.
2. While `chat.messages` still has more than one message, it recomputes `current_tokens = self._count_total_tokens(chat)` and `free_tokens = context_limit - current_tokens`, then stops once `free_tokens >= target_free_tokens`.
3. If more space is needed, it shortens history by assigning `chat._messages = chat.messages[:-2]`, which removes the most recent two messages as one pair; the loop keeps the first message because of the `while len(chat.messages) > 1` guard.
4. After the loop, it calls `chat.reset_response_chain()` so any derived response-chain state matches the shortened message list.
5. It recalculates free space from the final `chat` state and logs `len(chat.messages)` plus the approximate remaining budget.

**Source**

```python
    def _unwind_messages_to_free_tokens(
        self, chat: Chat, target_free_tokens: int = 4000
    ) -> None:
        """Remove recent messages until we have enough free tokens."""
        context_limit = self._llm.get_model_context_limit()

        while len(chat.messages) > 1:  # Keep at least the first message
            current_tokens = self._count_total_tokens(chat)
            free_tokens = context_limit - current_tokens

            if free_tokens >= target_free_tokens:
                break

            # Remove the most recent pair of messages (user + assistant)
            if len(chat.messages) >= 2:
                chat._messages = chat.messages[:-2]
            else:
                break

        chat.reset_response_chain()
        free_tokens = context_limit - self._count_total_tokens(chat)
        self.logger.debug(
            f"Unwound messages. Remaining messages: {len(chat.messages)}, "
            f"Free tokens: approximately {free_tokens}"
        )
```

**Non-obvious design decisions**

- It preserves at least the first message by looping only while `len(chat.messages) > 1`. That keeps the conversation anchored to its original opening context instead of allowing a complete wipe, which would make the retry less grounded.
- It removes history in two-message chunks via `chat.messages[:-2]` instead of single messages. The comment names these as a `user + assistant` pair, so the function favors keeping turn structure coherent over extracting the smallest possible amount of text each iteration.
- It recomputes token usage on every pass with `self._count_total_tokens(chat)` rather than estimating the impact of the removed messages. That costs repeated counting work, but it stays aligned with the model's actual token accounting as the remaining transcript changes.
- It always calls `chat.reset_response_chain()` after trimming, even if the loop made no cuts. That avoids leaving response-chain state tied to a longer prior message list, which matters because `_query_llm` will reuse the same `chat` object on the recovery path.

**Relations**

- **Callers**: Terminus2._query_llm
- **Core callees**: self._llm.get_model_context_limit; self._count_total_tokens; chat.reset_response_chain; self.logger.debug
- **Config / state sources**: self._llm; target_free_tokens
- **Results to**: Mutated `chat.messages` consumed by `Terminus2._query_llm` fallback retries; Reset response-chain state used by the next `chat.chat(...)` attempt; Debug logging stream for context-recovery diagnostics
- **Related siblings**: Terminus2._query_llm; Terminus2._handle_llm_interaction
- **📊 Register interactions**: ✏️ writes `reg-chat-messages` — trim live history during context recovery

</details>


<details id="fn-terminus2_parse_skill_frontmatter">
<summary><b>Terminus2._parse_skill_frontmatter</b> — terminus_2.py:404-420 · Parse SKILL.md frontmatter into prompt-ready metadata</summary>

> **Stage context**: This helper sits upstream of the stage-4.3 LLM query path. `_build_skills_section` uses it while assembling the skills text that will later be embedded in the prompt sent through `_handle_llm_interaction` and `_query_llm`. Unlike the stage's sibling functions that manage logging, token pressure, and LLM retries, this function only filters a skill document down to the two fields the prompt builder needs.

**What this code does**

`_parse_skill_frontmatter` inspects the start of a `SKILL.md` `content` string for a YAML frontmatter block and extracts only `name` and `description`. It returns `{"name": ..., "description": ...}` when the frontmatter exists, parses as YAML, and produces a mapping containing both keys. If the frontmatter is missing, malformed, or incomplete, it returns `None`. It reads no instance state and mutates nothing.

**Interface · params / IO**

`(content: str) -> dict[str, str] | None`

- params: `content`: `str` — Full `SKILL.md` text to inspect for leading YAML frontmatter
- returns: Either a two-key dictionary containing `name` and `description`, or `None` when extraction fails any validation step

**Execution flow**

1. It matches `content` against the leading-frontmatter pattern `r"^---\n(.*?)\n---"` with `re.DOTALL` and stops immediately with `None` if no opening block appears at the start.
2. If the regex matches, it parses the captured block with `yaml.safe_load(match.group(1))`.
3. If `yaml.safe_load(...)` raises `yaml.YAMLError`, it catches that specific parse failure and returns `None`.
4. It validates that the parsed object `fm` is a `dict` and that both `"name"` and `"description"` are present; otherwise it returns `None`.
5. On the success path, it returns a new dictionary containing only `{"name": fm["name"], "description": fm["description"]}`.

**Source**

```python
    def _parse_skill_frontmatter(content: str) -> dict[str, str] | None:
        """Parse YAML frontmatter from SKILL.md content, returning name and description."""
        import re

        import yaml

        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        if not match:
            return None
        try:
            fm = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            return None
        if not isinstance(fm, dict) or "name" not in fm or "description" not in fm:
            return None
        return {"name": fm["name"], "description": fm["description"]}
```

**Non-obvious design decisions**

- It fails closed at every validation step (`not match`, `yaml.YAMLError`, missing keys) so a bad skill file does not break prompt assembly in `_build_skills_section`. The alternative would be to raise and force the caller to handle malformed skill metadata.
- It uses `yaml.safe_load(...)` instead of a more permissive loader to keep frontmatter parsing limited to basic YAML data structures. That fits the function's narrow goal: read metadata, not execute or construct arbitrary objects.
- It returns only `name` and `description` even if `fm` contains more keys. That keeps the contract small and aligned with the prompt builder's immediate need, rather than leaking the whole frontmatter schema outward.

**Relations**

- **Callers**: Terminus2._build_skills_section
- **Core callees**: `re.match`; `yaml.safe_load`
- **Config / state sources**: `content` argument
- **Results to**: Skill metadata selection inside `Terminus2._build_skills_section`; Prompt text that is later consumed by `Terminus2._handle_llm_interaction`; Prompt text that is later sent by `Terminus2._query_llm`
- **Related siblings**: Terminus2._handle_llm_interaction; Terminus2._query_llm

</details>
