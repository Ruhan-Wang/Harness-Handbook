### 4.1 · Loop Entry Gates

#### (a) Opening Explanation

This stage exists to do two things at the very top of every loop iteration: stamp the iteration with the current episode number, and decide whether the agent is still allowed to continue because its terminal is still alive. That sounds small, but it protects the rest of the loop from running on a dead terminal and gives later telemetry a stable, user-facing iteration count. It sits right at loop entry because both facts matter before anything else happens. The rest of the pipeline should only run if there is still a live tmux session (a terminal you can drive remotely). If that session is gone, there is nothing useful left to observe, plan, or act on.

#### (b) Main Flow

1. The loop first updates the episode counter.
   
   `self._n_episodes = episode + 1` turns the internal zero-based loop index into a 1-based count people can read in logs and metadata. This stage does it early so the iteration is already stamped even if the loop stops immediately after. That gives downstream reporting a consistent “which attempt was this?” value.

2. Then it checks whether the terminal still exists.
   
   `is_session_alive()` (asks whether the tmux session is still running) is the real gate here. Its job is not to produce LLM context or agent state. Its job is to answer a simple control question: can the agent safely keep going?

3. The result becomes a continue-or-exit decision.
   
   If the session is alive, the loop continues to `stage-4.2 Proactive Summarize Probe`. If it is dead, this stage logs that the session ended and terminates the loop/run from inside the loop body. No later stage in this iteration runs.

This is basically a guardrail. Without it, later stages would try to reason about or act on a terminal that no longer exists.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-n-episodes` — written at the start of each iteration to store the 1-based episode count for user-facing telemetry; this stamp happens before the liveness gate so the attempted iteration is still counted consistently
- reads: no tracked registers — this stage does not consume any tracked register as input
- clears: no tracked registers — this stage leaves all tracked state unchanged except for the episode-count write
- triggers downstream: `stage-4.2 Proactive Summarize Probe` — continue to next stage if the tmux session is alive; otherwise terminate the loop/run and skip all downstream stages

Session liveness is checked from external runtime/session state, not from a tracked register, and it does not write any tracked register besides `reg-n-episodes`.

#### (d) Pipeline Hand-Off

Upstream hands this stage a fresh loop iteration. This stage produces two outputs: an updated episode register for later metadata, and a control-flow decision about whether the loop may continue. If the terminal is alive, downstream stages inherit a stamped iteration and keep running; if not, no downstream stage runs at all.

<details id="fn-tmuxsession_is_session_alive">
<summary><b>TmuxSession.is_session_alive</b> — tmux_session.py:518-524 · tmux session liveness probe</summary>

> **Stage context**: This function supplies the loop-entry liveness check for stage `stage-4.1`. `Terminus2._run_agent_loop` calls it at the start of each iteration, after updating the user-facing episode counter, to decide whether the loop should continue. In this stage, it is the gate that can end the loop early when the backing tmux session no longer exists.

**What this code does**

`TmuxSession.is_session_alive` checks whether the tmux session named by `self._session_name` still exists in `self.environment` for `self._user`. It returns `True` when the probe command succeeds and `False` when it does not. The method does not change instance state; its only external action is invoking `self.environment.exec(...)` with a tmux existence check.

**Interface · params / IO**

`async def is_session_alive(self) -> bool`

- params: `self`: `?` — bound `TmuxSession` instance that provides environment, session name, and user
- reads: `self.environment`, `self._session_name`, `self._user`
- returns: A boolean: `True` if `self.environment.exec(...)` reports `return_code == 0` for `tmux has-session -t <session>`, otherwise `False`.
- effects: Runs `tmux has-session -t <session>` through `self.environment.exec(...)` as `self._user`

**Execution flow**

1. Build the probe command from `self._session_name` as `tmux has-session -t <session>`.
2. Call `await self.environment.exec(...)` with that command and `user=self._user`, and capture the result object in `result`.
3. Convert the probe outcome to a boolean by testing `result.return_code == 0` and return that value.

**Source**

```python
    async def is_session_alive(self) -> bool:
        """Check if the tmux session is still alive."""
        result = await self.environment.exec(
            command="tmux has-session -t {}".format(self._session_name),
            user=self._user,
        )
        return result.return_code == 0
```

**Non-obvious design decisions**

- It treats tmux's exit status as the single source of truth by checking `result.return_code == 0`. That avoids parsing command output, which would add format assumptions that `tmux has-session` does not require.
- It delegates execution to `self.environment.exec(...)` and passes `user=self._user` instead of running locally or assuming a default user. That keeps the liveness check aligned with the same execution context that owns the tmux session.

**Relations**

- **Callers**: `Terminus2._run_agent_loop` at stage `stage-4.1` uses the returned boolean as the loop-entry gate
- **Core callees**: `self.environment.exec`; external command `tmux has-session`
- **Config / state sources**: `self._session_name` supplies the tmux target name; `self._user` selects the execution user; `self.environment` provides the command-execution backend
- **Results to**: Returns a boolean to `Terminus2._run_agent_loop`; Feeds the stage-4.1 branch that logs "Session has ended" and returns from the loop on `False`

</details>


<details id="fn-terminus2_run_agent_loop">
<summary><b>Terminus2._run_agent_loop</b> — terminus_2.py:1266-1287 · loop setup and per-iteration liveness gate</summary>

> **Stage context**: This region opens `Terminus2._run_agent_loop` and performs the stage's two entry-gate duties before later loop work can proceed. It runs once at loop startup to validate required objects and reset run-level accounting on `self._context`, then runs at the top of each iteration to publish the 1-based episode counter and stop immediately if the tmux session is already gone. Its liveness check delegates to the sibling `TmuxSession.is_session_alive` translation.

**What this code does**

This region verifies that `self._context` and `self._session` are present, seeds the working `prompt` from `initial_prompt`, and resets aggregate token and cost fields on `self._context`. It then enters the episode loop, writes `self._n_episodes` as a 1-based counter for the current iteration, and probes `self._session.is_session_alive()`. If the session is dead at iteration start, it logs a debug message and returns from `_run_agent_loop` immediately.

**Interface · params / IO**

`(self, initial_prompt: str) -> None`

- params: `self`: `Terminus2` — agent runner instance that owns context, session, counters, and logger; `initial_prompt`: `str` — starting prompt text copied into the loop's working `prompt`
- reads: `self._context`, `self._session`, `self._max_episodes`, `self.logger`
- returns: Returns `None`; its real product is initialized run context plus either entry into the episode loop or an early loop exit when the session is dead.
- effects: writes local `prompt = initial_prompt` for later loop use; sets `self._context.n_input_tokens = 0`; sets `self._context.n_output_tokens = 0`; sets `self._context.n_cache_tokens = 0`; sets `self._context.cost_usd = None`; writes `self._n_episodes = episode + 1` each iteration; awaits `self._session.is_session_alive()`; emits `self.logger.debug(...)` before early return when the session is not alive; raises `RuntimeError` if `self._context` is `None`; raises `RuntimeError` if `self._session` is `None`

**Execution flow**

1. Check `self._context`; if it is `None`, raise `RuntimeError` because the loop requires a bound run context.
2. Copy `initial_prompt` into local `prompt`, then reset shared run totals on `self._context`: `n_input_tokens`, `n_output_tokens`, `n_cache_tokens`, and `cost_usd`.
3. Check `self._session`; if it is `None`, raise `RuntimeError` because the loop cannot interact with the terminal session without it.
4. Start `for episode in range(self._max_episodes)` and publish the user-facing iteration number with `self._n_episodes = episode + 1`.
5. At the top of each iteration, await `self._session.is_session_alive()`; if it returns `False`, log `Session has ended, breaking out of agent loop` and `return` from `_run_agent_loop`.

**Source**

```python
        if self._context is None:
            raise RuntimeError("Agent context is not set. This should never happen.")

        prompt = initial_prompt

        self._context.n_input_tokens = 0
        self._context.n_output_tokens = 0
        self._context.n_cache_tokens = 0
        self._context.cost_usd = None

        if self._session is None:
            raise RuntimeError("Session is not set. This should never happen.")

        # Step ID offset accounts for initial steps in the trajectory:
        # Step 1: system message (includes task instruction)
        # Steps 2+: agent episodes (starting from episode 0)

        for episode in range(self._max_episodes):
            self._n_episodes = episode + 1
            if not await self._session.is_session_alive():
                self.logger.debug("Session has ended, breaking out of agent loop")
                return
```

**Non-obvious design decisions**

- The region fails fast on missing `self._context` and `self._session` with `RuntimeError` instead of trying to recover. That keeps later loop code from running against impossible state and makes these invariants explicit.
- It resets `self._context` token and cost aggregates here, at loop entry, so per-run accounting starts from a known baseline. Deferring that reset to later stages would mix setup concerns with per-episode work and risk carrying stale totals across runs.
- It stores `self._n_episodes` as `episode + 1`, not the zero-based loop index. That matches user-facing telemetry expectations, while the loop still uses Python's natural zero-based `range(self._max_episodes)` internally.
- It checks session liveness at the start of every iteration and returns immediately on failure. This centralizes the only non-completion early-exit path inside the loop; letting later stages discover a dead session would spread shutdown handling across unrelated code.

**Relations**

- **Callers**: `Terminus2.run`, via its call into `Terminus2._run_agent_loop`
- **Core callees**: `TmuxSession.is_session_alive`; `self.logger.debug`
- **Config / state sources**: `initial_prompt` argument; `self._context`; `self._session`; `self._max_episodes`
- **Results to**: later regions of `Terminus2._run_agent_loop`, which consume local `prompt` and the initialized context totals; `stage-5` metadata surfacing through `self._n_episodes` and `self._context` aggregate fields; `Terminus2.run` finally-path, which still executes after this region returns early; debug logs that record session-ended loop termination
- **Related siblings**: `TmuxSession.is_session_alive` supplies the session-exists probe used by this gate.
- **📊 Register interactions**: ✏️ writes `reg-n-episodes` — set to 1-based count each iteration

</details>
