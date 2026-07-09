## crosscut-X1 · Token & Cost Accounting

#### (a) Opening Explanation

This stage exists so the agent can measure how much model work it used, how long that work took, and how much it cost across both the main LLM and any subagents. An LLM is the language model call itself, and a subagent is a smaller agent the main agent asks to do part of the job. Without this stage, the run would still work, but you would lose basic visibility: Was this step expensive? Did latency spike? Did a subagent quietly consume most of the budget? This logic sits across the loop rather than in one single step because usage is created everywhere an LLM call happens, then gathered into final run totals near the end.

#### (b) Main Flow

1. Before an LLM call, the system snapshots the current token counters.
   This matters because token totals on the chat object are cumulative. To know what *this one call* used, the stage saves the “before” values, then compares them to the totals after the call.

2. After the call, it turns the delta into step-level metrics.
   `_count_total_tokens()` (sum the tokens present in a chat history) helps answer “how large is the conversation context?” The repeated before/after pattern records prompt, completion, and cache token use for the specific step, including error cases. That way failed calls do not disappear from accounting.

3. It also records latency for each API request.
   `_track_api_request_time()` (store request duration in milliseconds) exists so cost is not the only thing you can inspect. A run can be cheap but slow, and that still matters.

4. When subagents are involved, their usage is folded in separately.
   `_extract_usage_metrics()` (pull usage numbers out of a subagent result) and `_update_subagent_metrics()` (add those numbers into the running subagent totals) make sure nested work is not lost. `_append_subagent_response_step()` (add the subagent’s result back into the main run as a step) is one place where this accounting gets attached to the visible trace.

5. If detailed rollout collection is enabled, full subagent call records are saved too.
   This is not required for basic accounting. It exists for deeper inspection when you want to understand where a run spent its budget in detail.

6. At the end of the loop, these running numbers are flushed into final context totals.
   The key design choice is that main-chat usage and subagent usage are tracked separately during the run, then combined at the end. That keeps attribution clear while still producing one total for the whole trial.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-api-request-times` — each time an LLM API call finishes, the elapsed time is appended so latency can be summarized later
- writes: `reg-subagent-metrics` — updated whenever a subagent returns usage data, so nested LLM cost does not vanish from the run totals
- writes: `_subagent_rollout_details` — when rollout-detail collection is enabled, full subagent records are stored for later inspection
- reads: `reg-subagent-metrics` — read at final aggregation time so trial totals include subagent usage in addition to the main chat
- reads: `reg-api-request-times` — used later for run-level reporting or summary metrics
- triggers downstream: `crosscut-X2 Output Length Limiting` — after per-call usage and timing are attached to the current step, the pipeline continues to the next cross-cutting control

#### (d) Pipeline Hand-Off

Upstream stages produce prompts, summaries, and actual LLM or subagent calls that consume tokens and time. This stage turns that raw consumption into tracked metrics on steps and run-level accumulators, which later stages use for final reporting, budgeting, and understanding where the agent spent its effort.

<details id="fn-terminus2_count_total_tokens">
<summary><b>Terminus2._count_total_tokens</b> — terminus_2.py:527-531 · Chat transcript token counting helper</summary>

> **Stage context**: This entry is a small accounting utility inside the Token & Cost Accounting stage. In the shown code, it only imports `token_counter` and returns `token_counter(model=self._model_name, messages=chat.messages)`.

**What this code does**

`_count_total_tokens` returns one integer token count for a `Chat`. It reads `self._model_name` and `chat.messages`, passes both directly to `litellm.utils.token_counter`, and does not mutate instance state.

**Interface · params / IO**

`(self, chat: Chat) -> int`

- params: `chat`: `Chat` — source of the `messages` list passed to `token_counter`
- reads: `self._model_name`, `chat.messages`
- returns: the integer returned by `token_counter(model=self._model_name, messages=chat.messages)`
- effects: imports `token_counter` from `litellm.utils` inside the function body

**Execution flow**

1. Import `token_counter` from `litellm.utils` inside `_count_total_tokens`.
2. Read `self._model_name` and `chat.messages`.
3. Return `token_counter(model=self._model_name, messages=chat.messages)`.

**Source**

```python
    def _count_total_tokens(self, chat: Chat) -> int:
        """Count total tokens across all messages in the chat."""
        from litellm.utils import token_counter

        return token_counter(model=self._model_name, messages=chat.messages)
```

**Non-obvious design decisions**

- The function imports `token_counter` inside the function body instead of at module scope.
- The helper delegates all counting work to `litellm.utils.token_counter`; this code adds no intermediate processing around `chat.messages` or `self._model_name`.

**Relations**

- **Callers**: none shown in the provided source excerpt
- **Core callees**: litellm.utils.token_counter
- **Config / state sources**: self._model_name; chat.messages
- **Results to**: direct return value to this function's caller

</details>


<details id="fn-terminus2_extract_usage_metrics">
<summary><b>Terminus2._extract_usage_metrics</b> — terminus_2.py:638-655 · Normalize usage object into four metrics</summary>

> **Stage context**: This helper turns a `usage_info` object into a fixed `(prompt_tokens, completion_tokens, cached_tokens, cost_usd)` tuple. Within token-and-cost accounting, it provides a small normalization boundary that complements `_count_total_tokens`: `_count_total_tokens` derives one aggregate token count from a `Chat`, while this function reads precomputed per-field usage attributes from `usage_info` and returns them without touching instance state.

**What this code does**

`_extract_usage_metrics` accepts one `usage_info` input and returns four normalized metrics. If `usage_info` is falsy, it returns the literal fallback tuple `(0, 0, 0, 0)`. If `usage_info` is truthy, it requires `prompt_tokens`, `completion_tokens`, `cache_tokens`, and `cost_usd` attributes, and it only normalizes `cost_usd` by replacing values `<= 0` with `0`. It does not read or write any `self` state.

**Interface · params / IO**

`(self, usage_info) -> tuple[int, int, int, float]`

- params: `self`: `Terminus2` — instance receiver; unused by this method; `usage_info`: `?` — usage object to read; if truthy, it must expose `prompt_tokens`, `completion_tokens`, `cache_tokens`, and `cost_usd`
- returns: A 4-tuple `(prompt_tokens, completion_tokens, cached_tokens, cost_usd)`; returns `(0, 0, 0, 0)` when `usage_info` is falsy

**Execution flow**

1. Check `usage_info` with `if not usage_info`; if that condition holds, return the literal zero tuple `(0, 0, 0, 0)` immediately.
2. Otherwise, read `usage_info.prompt_tokens`, `usage_info.completion_tokens`, and `usage_info.cache_tokens` directly for the first three tuple positions.
3. Read `usage_info.cost_usd` and place it in the fourth position only when `usage_info.cost_usd > 0`; otherwise place `0` there.
4. Return the assembled 4-item tuple without mutating any instance attribute.

**Source**

```python
    def _extract_usage_metrics(self, usage_info) -> tuple[int, int, int, float]:
        """Extract and normalize metrics from usage info.

        Args:
            usage_info: Usage information from LLM response

        Returns:
            Tuple of (prompt_tokens, completion_tokens, cached_tokens, cost_usd)
        """
        if not usage_info:
            return 0, 0, 0, 0

        return (
            usage_info.prompt_tokens,
            usage_info.completion_tokens,
            usage_info.cache_tokens,
            usage_info.cost_usd if usage_info.cost_usd > 0 else 0,
        )
```

**Non-obvious design decisions**

- The guard uses broad falsiness, not an explicit `None` check. That means any falsy `usage_info` triggers the fallback `(0, 0, 0, 0)`, which keeps the return shape stable with one branch.
- The truthy path reads attributes directly instead of using `getattr` defaults. This keeps the function strict about the expected `usage_info` interface and avoids silently inventing per-field values when the object shape is wrong.
- The code normalizes only `cost_usd`, and only when `cost_usd <= 0`. It leaves token counts untouched, so the function applies a narrow correction rather than rewriting every field.

**Relations**

- **Callers**: Unknown from this source excerpt; Methods that already hold a `usage_info` object and need a fixed four-value metrics tuple
- **Core callees**: none; direct attribute access on `usage_info.prompt_tokens`; direct attribute access on `usage_info.completion_tokens`; direct attribute access on `usage_info.cache_tokens`; direct attribute access on `usage_info.cost_usd`
- **Config / state sources**: `usage_info` truthiness controls the zero-tuple fallback; `usage_info.cost_usd` value controls the fourth-field normalization
- **Results to**: the immediate caller as a returned metrics tuple; code that needs a uniform `(prompt_tokens, completion_tokens, cached_tokens, cost_usd)` representation
- **Related siblings**: `Terminus2._count_total_tokens` computes one total token count from a `Chat`, whereas `_extract_usage_metrics` re-expresses an existing `usage_info` object as four separate metrics.

</details>


<details id="fn-terminus2_update_subagent_metrics">
<summary><b>Terminus2._update_subagent_metrics</b> — terminus_2.py:624-636 · Subagent usage accumulator update helper</summary>

> **Stage context**: This helper handles one narrow part of the token-and-cost accounting stage: it folds one `usage_info` record into `self._subagent_metrics`. It sits alongside `_extract_usage_metrics` and `_count_total_tokens`, but unlike those helpers it mutates stored totals instead of returning derived values.

**What this code does**

`_update_subagent_metrics` accepts one `usage_info` object and returns `None`. If `usage_info` is falsy, it exits without changing state. Otherwise, it reads `usage_info.prompt_tokens`, `completion_tokens`, `cache_tokens`, and `cost_usd`, then adds each value into the matching `self._subagent_metrics.total_*` field.

**Interface · params / IO**

`(self, usage_info) -> None`

- params: `usage_info`: `object with `prompt_tokens`, `completion_tokens`, `cache_tokens`, and `cost_usd` attributes` — usage record supplying numeric token and cost values
- reads: `self._subagent_metrics.total_prompt_tokens`, `self._subagent_metrics.total_completion_tokens`, `self._subagent_metrics.total_cached_tokens`, `self._subagent_metrics.total_cost_usd`
- returns: None; the product is an in-place update of `self._subagent_metrics` totals
- effects: increments `self._subagent_metrics.total_prompt_tokens` by `usage_info.prompt_tokens`; increments `self._subagent_metrics.total_completion_tokens` by `usage_info.completion_tokens`; increments `self._subagent_metrics.total_cached_tokens` by `usage_info.cache_tokens`; increments `self._subagent_metrics.total_cost_usd` by `usage_info.cost_usd`

**Execution flow**

1. Check `if not usage_info`; if the argument is falsy, return immediately and leave `self._subagent_metrics` unchanged.
2. Read `self._subagent_metrics.total_prompt_tokens` and `usage_info.prompt_tokens`, then write back their sum to `self._subagent_metrics.total_prompt_tokens`.
3. Read `self._subagent_metrics.total_completion_tokens` and `usage_info.completion_tokens`, then write back their sum to `self._subagent_metrics.total_completion_tokens`.
4. Read `self._subagent_metrics.total_cached_tokens` and `usage_info.cache_tokens`, then write back their sum to `self._subagent_metrics.total_cached_tokens`.
5. Read `self._subagent_metrics.total_cost_usd` and `usage_info.cost_usd`, then write back their sum to `self._subagent_metrics.total_cost_usd`.

**Source**

```python
    def _update_subagent_metrics(self, usage_info) -> None:
        """Update subagent metrics with usage information from an LLM response.

        Args:
            usage_info: Usage information from LLM response containing token counts and cost
        """
        if not usage_info:
            return

        self._subagent_metrics.total_prompt_tokens += usage_info.prompt_tokens
        self._subagent_metrics.total_completion_tokens += usage_info.completion_tokens
        self._subagent_metrics.total_cached_tokens += usage_info.cache_tokens
        self._subagent_metrics.total_cost_usd += usage_info.cost_usd
```

**Non-obvious design decisions**

- The broad guard `if not usage_info` treats any falsy value as "no usage data" and makes the function a no-op in that case. This avoids attribute access on missing input, but it also means the check is not limited to `None`.
- The function updates each metric field directly with `+=` instead of normalizing or validating per-field values first. That keeps this helper focused on accumulation, but it assumes `usage_info` already exposes usable numeric attributes.

**Relations**

- **Callers**: internal code that has a `usage_info` object and wants to accumulate it into `self._subagent_metrics`
- **Core callees**: none
- **Config / state sources**: `usage_info.prompt_tokens`; `usage_info.completion_tokens`; `usage_info.cache_tokens`; `usage_info.cost_usd`; `self._subagent_metrics.total_prompt_tokens`; `self._subagent_metrics.total_completion_tokens`; `self._subagent_metrics.total_cached_tokens`; `self._subagent_metrics.total_cost_usd`
- **Results to**: `self._subagent_metrics.total_prompt_tokens`; `self._subagent_metrics.total_completion_tokens`; `self._subagent_metrics.total_cached_tokens`; `self._subagent_metrics.total_cost_usd`
- **Related siblings**: `Terminus2._extract_usage_metrics` also works with usage fields, but it returns normalized values instead of mutating state.; `Terminus2._count_total_tokens` is another accounting helper in this stage, but it computes a fresh token count from a `Chat` instead of updating an accumulator.
- **📊 Register interactions**: ✏️ writes `reg-subagent-metrics` — increments four stored subagent total fields

</details>


<details id="fn-terminus2_append_subagent_response_step">
<summary><b>Terminus2._append_subagent_response_step</b> — terminus_2.py:1711-1761 · Append subagent response step with optional usage metrics</summary>

> **Stage context**: This helper records one subagent LLM reply as a `Step` and, when available, attaches token and cost data to that step. It runs inside the stage's broader token-and-cost accounting flow, but this function itself only serializes caller-supplied `usage_info` into `Step.metrics`. Unlike siblings such as `_extract_usage_metrics` and `_update_subagent_metrics`, it does not aggregate totals; it only appends a trajectory record.

**What this code does**

`_append_subagent_response_step` adds one agent-authored `Step` to the caller-provided `steps` list for a subagent response. It reads `response`, `step_id`, `subagent_name`, and the truthiness of `usage_info`, and it falls back to `self._model_name` when `response.model_name` is missing. If `usage_info` is truthy, it also builds a `Metrics` object from `usage_info` and `response` fields; otherwise it logs a warning and appends the step without metrics. The appended `Step` always includes `reasoning_content=response.reasoning_content`.

**Interface · params / IO**

`(self, steps: list[Step], step_id: int, response: LLMResponse, usage_info, subagent_name: str) -> None`

- params: `steps`: `list[Step]` — target trajectory list that receives the new `Step`; `step_id`: `int` — identifier written into the appended `Step.step_id`; `response`: `LLMResponse` — subagent LLM output supplying content, reasoning, model name, token ids, and logprobs; `usage_info`: `?` — truthiness-gated usage payload; when truthy, supplies prompt/completion/cache tokens and cost; `subagent_name`: `str` — name inserted into the warning message when `usage_info` is falsy
- reads: `self._model_name`, `self.logger`
- returns: None; the real product is one appended `Step` in `steps`, always carrying `reasoning_content=response.reasoning_content` and sometimes carrying `metrics`
- effects: appends one `Step` object to the provided `steps` list; emits `self.logger.warning(...)` when `usage_info` is falsy; reads current UTC time via `datetime.now(timezone.utc).isoformat()` for the step timestamp

**Execution flow**

1. Check `if usage_info:` by truthiness. Truthy values take the metrics path; any falsy value takes the warning/no-metrics path.
2. On the truthy branch, build and append a `Step` with `step_id=step_id`, `timestamp=datetime.now(timezone.utc).isoformat()`, `source="agent"`, `model_name=response.model_name or self._model_name`, `message=response.content`, and `reasoning_content=response.reasoning_content`.
3. Still on the truthy branch, attach `metrics=Metrics(...)` with exact field mappings: `prompt_tokens=usage_info.prompt_tokens`, `completion_tokens=usage_info.completion_tokens`, `cached_tokens=usage_info.cache_tokens`, `cost_usd=usage_info.cost_usd if usage_info.cost_usd > 0 else None`, `prompt_token_ids=response.prompt_token_ids`, `completion_token_ids=response.completion_token_ids`, and `logprobs=response.logprobs`.
4. On the falsy branch, log `Failed to get token usage for {subagent_name}` through `self.logger.warning(...)`.
5. Then append a `Step` with the same core response fields as above—`step_id`, UTC `timestamp`, `source="agent"`, fallback `model_name`, `message=response.content`, and `reasoning_content=response.reasoning_content`—but without a `metrics` object.

**Source**

```python
    def _append_subagent_response_step(
        self,
        steps: list[Step],
        step_id: int,
        response: LLMResponse,
        usage_info,
        subagent_name: str,
    ) -> None:
        """Append a response step with conditional metrics to trajectory steps.

        Args:
            steps: List of steps to append to
            step_id: ID for the new step
            response: LLM response
            usage_info: Usage info (may be None)
            subagent_name: Name of subagent for warning message
        """
        if usage_info:
            steps.append(
                Step(
                    step_id=step_id,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    source="agent",
                    model_name=response.model_name or self._model_name,
                    message=response.content,
                    reasoning_content=response.reasoning_content,
                    metrics=Metrics(
                        prompt_tokens=usage_info.prompt_tokens,
                        completion_tokens=usage_info.completion_tokens,
                        cached_tokens=usage_info.cache_tokens,
                        cost_usd=usage_info.cost_usd
                        if usage_info.cost_usd > 0
                        else None,
                        prompt_token_ids=response.prompt_token_ids,
                        completion_token_ids=response.completion_token_ids,
                        logprobs=response.logprobs,
                    ),
                )
            )
        else:
            self.logger.warning(f"Failed to get token usage for {subagent_name}")
            steps.append(
                Step(
                    step_id=step_id,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    source="agent",
                    model_name=response.model_name or self._model_name,
                    message=response.content,
                    reasoning_content=response.reasoning_content,
                )
            )
```

**Non-obvious design decisions**

- It gates metrics attachment on `if usage_info:` instead of checking only for `None`. That makes any falsy payload follow the warning path, which avoids dereferencing missing token fields but also treats all falsy values as unusable usage data.
- It always appends a `Step`, even when usage data is unavailable. This preserves the response record in `steps` and isolates the failure to a warning plus missing `metrics` rather than dropping the subagent output entirely.
- It uses `response.model_name or self._model_name` for `Step.model_name`. This keeps the step populated when the response omits a model name, using the instance's configured model as a local fallback.
- It stores `cost_usd` only when `usage_info.cost_usd > 0`, otherwise `None`. This is a visible local choice in this function: token counts are copied through directly, but non-positive cost values are omitted from the serialized metrics.

**Relations**

- **Callers**: Terminus2._run_subagent
- **Core callees**: Step(...); Metrics(...); datetime.now(timezone.utc).isoformat(); self.logger.warning(...)
- **Config / state sources**: self._model_name; self.logger
- **Results to**: the caller-provided `steps` list; subagent trajectory records stored by the caller; warning log output when `usage_info` is falsy
- **Related siblings**: Terminus2._extract_usage_metrics; Terminus2._update_subagent_metrics

</details>


<details id="fn-terminus2_track_api_request_time">
<summary><b>Terminus2._track_api_request_time</b> — terminus_2.py:657-665 · Append one API latency sample in milliseconds</summary>

> **Stage context**: This helper contributes one timing sample to the instance's accumulated API request timings. It runs after a caller has already captured a `start_time`, and it only records the elapsed duration; it does not aggregate, normalize, or report the data itself.

**What this code does**

`_track_api_request_time` takes a previously captured `start_time` and records one elapsed request duration in milliseconds. It reads the current time with `time.time()`, computes `(end_time - start_time) * 1000`, appends that numeric value to `self._api_request_times`, and returns `None`.

**Interface · params / IO**

`(self, start_time: float) -> None`

- params: `start_time`: `float` — Earlier timestamp, expected to come from `time.time()`
- reads: `self._api_request_times`
- returns: None; the real product is one appended latency sample in `self._api_request_times`
- effects: Appends one elapsed-milliseconds value to `self._api_request_times`; Reads wall-clock time via `time.time()`

**Execution flow**

1. Call `time.time()` to capture `end_time` at the moment this helper runs.
2. Compute `request_time_ms` from the caller-supplied `start_time` and the new `end_time` using `(end_time - start_time) * 1000`.
3. Append `request_time_ms` to `self._api_request_times`.

**Source**

```python
    def _track_api_request_time(self, start_time: float) -> None:
        """Track API request time from start timestamp.

        Args:
            start_time: Start time from time.time()
        """
        end_time = time.time()
        request_time_ms = (end_time - start_time) * 1000
        self._api_request_times.append(request_time_ms)
```

**Non-obvious design decisions**

- The helper samples the end timestamp internally instead of accepting an `end_time` argument. That keeps the call site small and ensures the recorded duration always ends exactly where this method runs.
- This method has no branches, validation, or error handling. The code assumes `start_time` is a valid timestamp and leaves any bad-input behavior to normal Python arithmetic and attribute errors.

**Relations**

- **Callers**: Any method that captured a request `start_time` and wants to record one elapsed API-call duration
- **Core callees**: `time.time`; `self._api_request_times.append`
- **Config / state sources**: `self._api_request_times`
- **Results to**: `self._api_request_times` for later consumers of accumulated request timings
- **📊 Register interactions**: ✏️ writes `reg-api-request-times` — append one elapsed request-time sample

</details>
