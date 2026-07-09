### 4.8 · Completion Gate + Loop Control

#### (a) Opening Explanation

This stage exists to stop the agent from ending too early. By the time execution reaches here, the agent has already run a command, seen the result, and may believe the task is done. The problem is that agents often claim success one turn too soon. So this stage acts as a completion gate: it does not trust a single “I’m finished” signal. It asks for a second confirmation on the next turn before it really exits. If the task is not complete, it simply feeds the latest observation back into the loop so the agent can think again. In other words, this stage owns the decision between three paths: continue working, ask for completion confirmation, or finally stop.

#### (b) Main Flow

1. The stage looks at the result of the just-finished turn.
   It checks whether the agent currently thinks the task is complete, and whether that same completion claim was already pending from the previous turn.

2. If this is the first completion claim, it does **not** end the run yet.
   Instead, it uses `_get_completion_confirmation_message()` (builds the follow-up prompt that asks the agent to confirm it is truly done) and sends that back into the loop as the next prompt.  
   Why: one completion claim is cheap and often wrong. The extra turn is a safety check.

3. If the agent says the task is complete **again** on the next turn, the loop returns.
   This is the real exit. At that point, the system has two consecutive signals that the work is done.

4. If the task is not complete, the stage takes the normal path.
   It sets the next prompt to the latest observation, usually terminal output (text from the shell after the command ran), so the next loop iteration can reason over fresh evidence and decide what to do next.

5. `Terminus2._run_agent_loop()` (the main think-act-observe loop for the agent) owns this control point because this is where the system must choose whether to keep iterating or stop.
   This logic belongs at the end of the iteration body, after the agent has both acted and seen the result.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: 无 — this stage is not mapped to any explicit skeleton register in the provided input
- reads: 无 — completion and pending-confirmation signals are used here in code flow, but no explicit register IDs were provided for them
- clears: 无
- triggers downstream: `subsys-parser-internal Parser internal helpers` — on the normal continue path, when the loop sets the next prompt and starts another iteration
- triggers downstream: `subsys-parser-internal Parser internal helpers` — on the first completion claim, when the confirmation prompt is injected and the loop continues
- triggers downstream: 无 — on second consecutive completion confirmation, the loop returns and no next stage runs

#### (d) Pipeline Hand-Off

Upstream, this stage receives the finished turn: the latest observation from command execution, plus the agent’s current judgment about whether the task is done. It produces either a final stop, a confirmation prompt, or the normal next prompt, and that output determines whether the next loop iteration begins and feeds back into parsing and planning.

<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1556-1567 · Loop-exit gate and prompt carry-forward</summary>

> **Stage context**: This region runs at the end of one `_run_agent_loop` iteration. It uses the current iteration results—`is_task_complete`, `was_pending_completion`, and `observation`—to decide whether the loop returns, continues immediately with a confirmation prompt, or falls through with the terminal output as the next `prompt`. Within stage 4.10, this is the stage's control gate.

**What this code does**

This region first calls `_dump_trajectory()` to persist the current trajectory state. It then inspects `is_task_complete` together with `was_pending_completion` to choose one of three outcomes: early `return` on a second consecutive completion signal, `prompt = observation` plus `continue` on a first completion signal, or `prompt = observation` on the normal path. Its direct outputs are loop control (`return` or `continue`) and reassignment of the local `prompt` variable.

**Interface · params / IO**

`(self, prompt: str) -> None`

- params: `self`: `Terminus2` — owning runner instance; supplies `_dump_trajectory()` and trajectory state; `prompt`: `str` — current loop prompt; this region may replace it with `observation` for the next iteration; `is_task_complete`: `?` — local completion flag read by this region; `was_pending_completion`: `?` — local snapshot of prior pending-completion state used to confirm completion; `observation`: `?` — local observation text forwarded into `prompt` on both non-return paths
- reads: `self._trajectory_steps (indirectly via `_dump_trajectory()`)`, `other instance state consumed by `self._dump_trajectory()` for serialization/output`
- returns: Returns `None` only on the confirmed-complete branch; otherwise the real product is loop control (`continue` or fallthrough) and updated local `prompt`.
- effects: calls `self._dump_trajectory()` to write trajectory data to external storage; reassigns local `prompt` to `observation` on both non-return paths; issues `continue` on the first-completion branch; issues early `return` on the confirmed-complete branch

**Execution flow**

1. Call `self._dump_trajectory()` before making the loop-control decision.
2. If `is_task_complete` is true and `was_pending_completion` is also true, treat this as the second consecutive completion signal and `return` immediately.
3. If `is_task_complete` is true but `was_pending_completion` is false, set `prompt = observation` and `continue` so the next iteration uses that confirmation text.
4. If `is_task_complete` is false, skip the completion gate and set `prompt = observation` on the normal path.
5. The explicit `continue` in the first-completion branch bypasses the trailing `prompt = observation`, which is why `prompt = observation` appears both inside that branch and after the `if`.

**Source**

```python
            self._dump_trajectory()

            if is_task_complete:
                if was_pending_completion:
                    # Task is confirmed complete (this is the second time task_complete was True), return
                    return
                else:
                    # First completion attempt - ask for confirmation and continue
                    prompt = observation
                    continue

            prompt = observation
```

**Non-obvious design decisions**

- The code uses a two-step completion gate anchored to `is_task_complete` and `was_pending_completion`. The inline comments define the first `True` as a 'First completion attempt' and the second consecutive `True` as 'Task is confirmed complete'.
- The region persists state with `_dump_trajectory()` before any `return` or `continue`. That ordering ensures the current iteration's trajectory is written even when the loop exits immediately or restarts from the first-completion branch.
- The first-completion path sets `prompt = observation` inside the branch because the following `continue` skips the shared trailing assignment. The duplicated assignment keeps both non-return paths feeding `observation` into the next prompt.

**Relations**

- **Callers**: `Terminus2._run_agent_loop` iteration tail
- **Core callees**: `Terminus2._dump_trajectory`
- **Config / state sources**: `is_task_complete` local result from earlier in `_run_agent_loop`; `was_pending_completion` local snapshot from earlier in `_run_agent_loop`; `observation` local output from earlier in `_run_agent_loop`; instance trajectory state read indirectly by `_dump_trajectory()`
- **Results to**: local `prompt` for the next `_run_agent_loop` iteration; loop control in `_run_agent_loop` via `continue`; function exit from `_run_agent_loop` via early `return`; persisted trajectory output written by `_dump_trajectory()`
- **📊 Register interactions**: 👁 reads `reg-pending-completion` — uses `was_pending_completion` to confirm second completion

</details>


<details id="fn-terminus2_get_completion_confirmation_message">
<summary><b>Terminus2._get_completion_confirmation_message</b> — terminus_2.py:489-510 · Build completion reconfirmation prompt for active parser</summary>

> **Stage context**: This helper supports the stage-4.10 completion gate by generating the exact follow-up prompt used on the first completion claim. `_run_agent_loop` uses its return value when it needs the agent to confirm completion for a second consecutive turn. It complements the sibling loop-control logic by supplying the parser-specific wording that stage-4.10 feeds back as the next `prompt`.

**What this code does**

The function builds a confirmation message from `terminal_output` and the current parser mode in `self._parser_name`. It returns one string that embeds the terminal state and tells the agent which completion token to repeat: JSON uses `"task_complete": true`, while XML uses `<task_complete>true</task_complete>`. It does not mutate instance state or perform I/O. If `self._parser_name` is neither `"json"` nor `"xml"`, it raises `ValueError`.

**Interface · params / IO**

`(self, terminal_output: str) -> str`

- params: `terminal_output`: `str` — Current terminal state to embed in the confirmation prompt
- reads: `self._parser_name`
- returns: A parser-specific completion confirmation message string that includes `terminal_output` and instructs the agent to repeat the completion marker

**Execution flow**

1. Read `self._parser_name` to choose the response format that the follow-up prompt must target.
2. If `self._parser_name == "json"`, return a message that includes `terminal_output` and tells the agent to include `"task_complete": true` again in its JSON response.
3. If `self._parser_name == "xml"`, return a message that includes `terminal_output` and tells the agent to include `<task_complete>true</task_complete>` again in its XML response.
4. For any other `self._parser_name`, raise `ValueError` with the unsupported name in the message instead of returning a fallback prompt.

**Source**

```python
    def _get_completion_confirmation_message(self, terminal_output: str) -> str:
        """Return the format-specific task completion confirmation message."""
        if self._parser_name == "json":
            return (
                f"Current terminal state:\n{terminal_output}\n\n"
                "Are you sure you want to mark the task as complete? "
                "This will trigger your solution to be graded and you won't be able to "
                'make any further corrections. If so, include "task_complete": true '
                "in your JSON response again."
            )
        elif self._parser_name == "xml":
            return (
                f"Current terminal state:\n{terminal_output}\n\n"
                "Are you sure you want to mark the task as complete? "
                "This will trigger your solution to be graded and you won't be able to "
                "make any further corrections. If so, include "
                "<task_complete>true</task_complete> again."
            )
        else:
            raise ValueError(
                f"Unknown parser_name: {self._parser_name}. Use 'json' or 'xml'."
            )
```

**Non-obvious design decisions**

- It branches explicitly on `self._parser_name` so the confirmation text matches the active output schema exactly. A generic confirmation prompt would risk the agent reconfirming in the wrong format and breaking the parser contract.
- It embeds `terminal_output` directly into the returned string. That keeps the confirmation tied to the current terminal state the agent is about to finalize against, rather than asking for a blind second confirmation.
- It raises `ValueError` in the `else` branch instead of defaulting to one format. That fail-fast choice exposes parser misconfiguration immediately; a silent default would produce a misleading prompt and likely cause a harder-to-debug downstream parse failure.

**Relations**

- **Callers**: `Terminus2._run_agent_loop` when the first completion signal needs explicit reconfirmation
- **Core callees**: none
- **Config / state sources**: `self._parser_name` selects JSON versus XML wording
- **Results to**: Returned string becomes the confirmation question fed back into `_run_agent_loop` as the next `prompt`; Its text supports the two-step completion gate described by stage-4.10
- **Related siblings**: `Terminus2._run_agent_loop` consumes this helper's string during the stage-4.10 continue path

</details>
