## 🔄 State Flow Reference

### 🔄 `reg-pending-completion`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__):
  - `terminus_2.py:293  (`__init__`)`
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1584  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:1444  (`_run_agent_loop`)`
  - `terminus_2.py:1449  (`_run_agent_loop`)`
- Reads:
  - `terminus_2.py:1437  (`_run_agent_loop`)`
  - `terminus_2.py:1441  (`_run_agent_loop`)`
<!-- code-sites:end -->

**Purpose**: This register prevents the agent from trusting a single completion signal.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `stage-4.9` / input does not specify — written when the FIRST `is_task_complete` result appears, so the loop can mark completion as only a candidate, not a final stop
- **Read**:
  - `stage-4.9` / input does not specify — read as a snapshot to `was_pending_completion`, so the current iteration knows whether a prior completion candidate already exists
  - `stage-4.10` / input does not specify — read as a gate to decide whether the loop should actually return
- **Clear / Refill**: input does not specify

**Cross-Iteration Behavior**:
Iteration N writes the completion candidate.

Iteration N+1 reads that pending state at `stage-4.9` and `stage-4.10` before allowing real completion.

**Why This Design**:
The loop wants confirmation, not a one-shot exit. This register creates a small memory between iterations, so completion becomes a two-step handoff instead of a brittle single observation that could end the run too early.

### 🔄 `reg-pending-handoff-prompt`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1586  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:1046  (`_query_llm`)`
  - `terminus_2.py:1296  (`_run_agent_loop`)`
  - `terminus_2.py:1356  (`_run_agent_loop`)`
- Reads:
  - `terminus_2.py:309  (`__init__`)`
  - `terminus_2.py:1339  (`_run_agent_loop`)`
  - `terminus_2.py:1344  (`_run_agent_loop`)`
  - `terminus_2.py:1353  (`_run_agent_loop`)`
<!-- code-sites:end -->

**Purpose**: This register gives the summarization side flow a way to pause normal chat history and hand a compressed prompt back into the main loop at the right point.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `stage-4.2` / `side-S1` — written when the proactive summarize probe triggers and `_summarize` produces a summary-handoff prompt for later insertion
  - `stage-4.3` / `side-S1` — written when the reactive fallback path triggers the same summarization ritual mid-iteration
- **Read**:
  - `stage-4.6` / input does not specify — read to decide whether to append a user step or trigger a linear-history split
- **Clear / Refill**: cleared when consumed at `stage-4.6`; refill comes from `side-S1` through either trigger path

**Cross-Iteration Behavior**:
single-iteration

**Why This Design**:
Summarization happens off to the side, but the result must re-enter the canonical trial record in order. This register is that handoff line. It lets `_summarize` produce a prompt early, then lets `stage-4.6` splice it into the right structural place without mixing summarization logic into every later stage.

### 🔄 `reg-pending-subagent-refs`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1585  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:1044  (`_query_llm`)`
  - `terminus_2.py:1294  (`_run_agent_loop`)`
  - `terminus_2.py:1336  (`_run_agent_loop`)`
- Reads:
  - `terminus_2.py:306  (`__init__`)`
  - `terminus_2.py:1320  (`_run_agent_loop`)`
  - `terminus_2.py:1330  (`_run_agent_loop`)`
<!-- code-sites:end -->

**Purpose**: This register keeps the evidence of summarization work alive long enough for the main loop to record where that summary came from.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `stage-4.2` / `side-S1` — written when the proactive summarize probe runs `_summarize`, storing one trajectory reference per summarization subagent for later recording
  - `stage-4.3` / `side-S1` — written on the reactive fallback path for the same reason
- **Read**:
  - `stage-4.5` / input does not specify — read so the loop can record those subagent trajectory references under a `"system"` trajectory step
- **Clear / Refill**: cleared after `stage-4.5` consumes it; refilled only by `side-S1`

**Cross-Iteration Behavior**:
single-iteration

**Why This Design**:
The summary text alone is not enough. The system also wants provenance for the summarization ritual. This register carries that provenance from the side flow back to the trajectory writer, so the trial record can show not just that a summary appeared, but which subagent traces support it.

### 🔄 `reg-n-episodes`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1580  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:1280  (`_run_agent_loop`)`
- Reads:
  - `terminus_2.py:296  (`__init__`)`
  - `terminus_2.py:1668  (`run`)`
<!-- code-sites:end -->

**Purpose**: This register gives the system a stable count of how many loop passes actually happened, so teardown can describe the run it is closing.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `stage-4.1` / input does not specify — incremented at loop entry, so each iteration stamps itself into a run-level counter before the body proceeds
- **Read**:
  - `stage-5` / input does not specify — read when surfaced in `context.metadata`
- **Clear / Refill**: none

**Cross-Iteration Behavior**:
Iteration N increments the count.

Iteration N+1 sees the accumulated total because the register survives and keeps growing across loop passes until teardown reads the final value.

**Why This Design**:
The run needs one simple thread of continuity across all iterations. This register is that thread. It is not about one stage’s local logic; it is about giving the whole run a monotonic notion of progress that can be reported after the loop ends.

### 🔄 `reg-summarization-count`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1581  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:788  (`_summarize`)`
- Reads:
  - `terminus_2.py:303  (`__init__`)`
  - `terminus_2.py:793  (`_summarize`)`
  - `terminus_2.py:833  (`_summarize`)`
  - `terminus_2.py:841  (`_summarize`)`
  - `terminus_2.py:867  (`_summarize`)`
  - `terminus_2.py:875  (`_summarize`)`
  - `terminus_2.py:931  (`_summarize`)`
  - `terminus_2.py:1670  (`run`)`
  - `terminus_2.py:1802  (`_save_subagent_trajectory`)`
  - `terminus_2.py:1816  (`_save_subagent_trajectory`)`
  - `terminus_2.py:1906  (`_split_trajectory_on_summarization`)`
  - `terminus_2.py:1910  (`_split_trajectory_on_summarization`)`
  - `terminus_2.py:1956  (`_dump_trajectory_with_continuation_index`)`
  - `terminus_2.py:1992  (`_dump_trajectory`)`
<!-- code-sites:end -->

**Purpose**: This register prevents summarization from being an invisible side effect by counting how often the compression ritual was invoked across the run.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `side-S1` / `_summarize` — incremented every time the summarization ritual runs, regardless of which trigger path entered it
- **Read**:
  - `stage-5` / input does not specify — read when surfaced in `context.metadata`
- **Clear / Refill**: none

**Cross-Iteration Behavior**:
Iteration N may call `_summarize` and increase the count.

Later iterations inherit that total, and `stage-5` reads the final accumulated value after the loop ends.

**Why This Design**:
Summarization changes how the run was managed, so the system wants that activity visible at teardown. Keeping the count in its own register lets the side flow report its footprint without polluting the main chat path or forcing the loop body to reconstruct summarization history after the fact.

### 🔄 `reg-trajectory-steps`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1578  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:1321  (`_run_agent_loop`)`
  - `terminus_2.py:1348  (`_run_agent_loop`)`
  - `terminus_2.py:1393  (`_run_agent_loop`)`
  - `terminus_2.py:1534  (`_run_agent_loop`)`
  - `terminus_2.py:1629  (`run`)`
  - `terminus_2.py:1918  (`_split_trajectory_on_summarization`)`
- Reads:
  - `terminus_2.py:299  (`__init__`)`
  - `terminus_2.py:1319  (`_run_agent_loop`)`
  - `terminus_2.py:1323  (`_run_agent_loop`)`
  - `terminus_2.py:1350  (`_run_agent_loop`)`
  - `terminus_2.py:1395  (`_run_agent_loop`)`
  - `terminus_2.py:1536  (`_run_agent_loop`)`
  - `terminus_2.py:1711  (`_prepare_copied_trajectory_steps`)`
  - `terminus_2.py:1969  (`_dump_trajectory_with_continuation_index`)`
<!-- code-sites:end -->

**Purpose**: This register gives the run one canonical place where scattered loop events become an ordered trial history.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**:
  - `stage-3` / `_reset_per_run_state` — reset at run onset so a new run starts with a fresh trajectory
- **Write**:
  - `stage-4.5` / input does not specify — appended when pending subagent references are recorded
  - `stage-4.6` / input does not specify — appended when a pending handoff prompt becomes a user step or when a split is triggered
  - `stage-4.8` / input does not specify — appended on the error branch
  - `stage-4.9` / input does not specify — appended during command execution, observation capture, and trajectory-step recording
  - `stage-4.9` / `_dump_trajectory` — written to disk
  - `stage-5` / `_dump_trajectory` — written to disk again during teardown
- **Read**:
  - `stage-4.9` / `_dump_trajectory` — read for persistence
  - `stage-5` / `_dump_trajectory` — read for persistence
- **Clear / Refill**: cleared at `stage-3`; then refilled incrementally through loop-stage appends

**Cross-Iteration Behavior**:
Iteration N appends steps.

Iteration N+1 sees the full prior sequence and appends more, so the register grows into the run’s complete ordered history until teardown persists it.

**Why This Design**:
Many stages produce facts, but the system still needs one shared memory of “what happened.” This register is that memory. It lets side-flow outputs, errors, commands, and observations all converge into one ordered record that can survive the loop and be dumped to disk as the trial narrative.

### 🔄 `reg-chat-messages`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state): (none)
- Other writes:
  - `terminus_2.py:584  (`_unwind_messages_to_free_tokens`)`
  - `terminus_2.py:939  (`_summarize`)`
  - `terminus_2.py:1160  (`_query_llm`)`
  - `terminus_2.py:1161  (`_query_llm`)`
- Reads:
  - `terminus_2.py:529  (`_count_total_tokens`)`
  - `terminus_2.py:575  (`_unwind_messages_to_free_tokens`)`
  - `terminus_2.py:583  (`_unwind_messages_to_free_tokens`)`
  - `terminus_2.py:591  (`_unwind_messages_to_free_tokens`)`
  - `terminus_2.py:750  (`_summarize`)`
  - `terminus_2.py:761  (`_summarize`)`
  - `terminus_2.py:784  (`_summarize`)`
  - `terminus_2.py:802  (`_summarize`)`
  - `terminus_2.py:828  (`_summarize`)`
  - `terminus_2.py:879  (`_summarize`)`
  - `terminus_2.py:919  (`_summarize`)`
  - `terminus_2.py:940  (`_summarize`)`
  - `terminus_2.py:1673  (`run`)`
  - `terminus_2.py:1919  (`_split_trajectory_on_summarization`)`
<!-- code-sites:end -->

**Purpose**: This register gives the LLM query path a current conversation window, while still allowing summarization to replace that window when history gets too large.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `side-S1` / `_summarize` — replaces the live history with a 3-message `[system, question_prompt, model_questions]` sequence
- **Read**:
  - `stage-4.3` / `_query_llm` — consumed as the live conversation history sent to the LLM
- **Clear / Refill**: replaced, not merely appended, by the summarization side flow; other refill behavior is input does not specify

**Cross-Iteration Behavior**:
Iteration N may have its chat history replaced by `side-S1`.

Iteration N+1 then queries the LLM against that compressed message set unless later writes change it again.

**Why This Design**:
The LLM needs a prompt history, but the full history can become too heavy. This register is the active prompt channel. Because summarization can rewrite it wholesale, the system can carry forward only the context it still needs instead of dragging the full prior transcript through every later call.

### 🔄 `reg-asciinema-markers`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1587  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:1999  (`_record_asciinema_marker`)`
- Reads:
  - `terminus_2.py:292  (`__init__`)`
<!-- code-sites:end -->

**Purpose**: This register lets loop-time events leave timing marks for a later recording pass that does not run inside the core loop.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `stage-4.7` / `_record_asciinema_marker` — appends `(timestamp, label)` tuples as markers accumulate during the run
- **Read**:
  - `stage-6` / `TmuxSession.stop()` — consumed during framework-triggered recording post-process to merge the collected markers into the cast output
- **Clear / Refill**: none specified

**Cross-Iteration Behavior**:
Iteration N records markers into the list.

Later iterations keep adding more. After the run, `stage-6` consumes the full accumulated marker stream during post-processing.

**Why This Design**:
Recording post-process happens after the main work is done, but the timing labels only exist while the loop is live. This register bridges that gap. It lets the loop emit markers when events happen, then hands the whole accumulated set to the external recording path once `TmuxSession.stop()` is reached.

### 🔄 `reg-subagent-metrics`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__):
  - `terminus_2.py:312  (`__init__`)`
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1582  (`_reset_per_run_state`)`
- Other writes: (none)
- Reads:
  - `terminus_2.py:628  (`_update_subagent_metrics`)`
  - `terminus_2.py:629  (`_update_subagent_metrics`)`
  - `terminus_2.py:630  (`_update_subagent_metrics`)`
  - `terminus_2.py:631  (`_update_subagent_metrics`)`
  - `terminus_2.py:1655  (`run`)`
  - `terminus_2.py:1659  (`run`)`
  - `terminus_2.py:1663  (`run`)`
  - `terminus_2.py:1665  (`run`)`
<!-- code-sites:end -->

**Purpose**: This register keeps subagent cost and token usage separate so the main chat path can stay clean while the run still reports total resource use.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `crosscut-X1` / input does not specify — updated as a separate `SubagentMetrics` accumulator for subagent token and cost usage
- **Read**:
  - `stage-5` / input does not specify — folded into trial totals during run teardown
- **Clear / Refill**: none specified

**Cross-Iteration Behavior**:
Iteration N adds subagent usage into the accumulator.

Iteration N+1 inherits that running total, and `stage-5` finally folds the whole register into the trial totals.

**Why This Design**:
Subagents matter to total spend, but they are not the same as the main chat loop. This register creates a dedicated accounting lane. That separation makes later reporting clearer: the system can preserve a clean main-chat metric stream during execution, then combine everything only when it builds the final run totals.

### 🔄 `reg-api-request-times`

<!-- code-sites:start -->
**Code sites (authoritative — exact lines grepped from the source):**
- Init (in __init__): (none)
- Reset (in _reset_per_run_state):
  - `terminus_2.py:1579  (`_reset_per_run_state`)`
- Other writes:
  - `terminus_2.py:660  (`_track_api_request_time`)`
  - `terminus_2.py:1017  (`_query_llm`)`
  - `terminus_2.py:1090  (`_query_llm`)`
- Reads:
  - `terminus_2.py:295  (`__init__`)`
  - `terminus_2.py:1669  (`run`)`
<!-- code-sites:end -->

**Purpose**: This register preserves the per-call latency trail so teardown can describe how the LLM path behaved over the whole run.

**Lifecycle**:
- **Default Value**: input does not specify
- **Reset**: input does not specify
- **Write**:
  - `stage-4.3` / `_query_llm` — appended inside the function’s try-blocks with elapsed milliseconds for LLM calls
  - `crosscut-X1` / `_track_api_request_time` — appended through the timing tracker path
- **Read**:
  - `stage-5` / input does not specify — surfaced in `context.metadata`
- **Clear / Refill**: none specified

**Cross-Iteration Behavior**:
Iteration N appends one or more request times.

Iteration N+1 keeps the existing list and adds more entries, and `stage-5` reads the accumulated latency history for final metadata.

**Why This Design**:
One request time is just a local fact. The run needs the whole latency trail. This register turns scattered timings from `_query_llm` and `_track_api_request_time` into a shared run-level channel, so teardown can report API behavior without re-reading logs or reconstructing timing after execution.
