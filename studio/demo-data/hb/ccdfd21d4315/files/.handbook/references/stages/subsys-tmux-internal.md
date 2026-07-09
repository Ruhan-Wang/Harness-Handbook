## subsys-tmux-internal · Tmux internal helpers

#### (a) Opening Explanation

This stage exists to make terminal control reliable enough for the rest of the agent to treat tmux as a stable execution surface. A tmux session is a terminal you can drive remotely. That sounds simple, but in practice the system must first make sure tmux is available, start or reuse a session, send text without accidentally running half-finished commands, and read back only the new terminal output instead of the whole screen every time.

So this stage owns the low-level mechanics of “talk to tmux safely.” It sits underneath setup and command execution. Higher stages decide what to run. This stage makes sure there is a usable terminal, that keystrokes land correctly, and that later stages can poll for fresh output as the command runs.

#### (b) Main Flow

1. First, it makes sure tmux exists on the machine.  
   `_detect_system_info()` (figures out what kind of system it is) and `_attempt_tmux_installation()` (tries to install tmux if it is missing) exist because the agent cannot rely on every environment already having tmux. If tmux is already present, this path is skipped. If not, it chooses an install path, such as `_get_combined_install_command()` (builds package-manager install commands), `_build_tmux_from_source()` (fallback build path), and `_install_asciinema_with_pip()` where recording support is also needed.

2. Then it establishes a terminal session the agent can keep using.  
   `_tmux_start_session()` (starts or attaches to a tmux session) matters because command execution is not one isolated shell call. The agent needs continuity: current directory, shell state, and running process output must survive across turns. Reusing a session preserves that continuity. Starting a new one gives the agent a clean place to work when none exists yet.

3. After that, callers can repeatedly write input into the session.  
   `send_keys()` (the main “send this text to the terminal” helper) is here to turn caller-provided text into tmux-safe keystrokes. `_prepare_keys()` (normalizes the text before sending) and `_split_key_for_tmux()` (breaks input into pieces tmux can accept) handle the mismatch between ordinary strings and tmux key input rules.

4. Before sending, it checks whether the input should actually trigger execution.  
   `_is_enter_key()` (recognizes Enter), `_ends_with_newline()` (checks if text would submit a command), `_is_executing_command()` (checks whether the session is already busy), and `_prevent_execution()` (blocks accidental submission) exist for safety. This is why the stage is not just a dumb pipe. If the agent is still typing or the shell is already running something, blindly sending Enter could fire the wrong command or corrupt the interaction.

5. It then chooses how hard to wait on the send.  
   `_send_blocking_keys()` (send and wait for tmux to take them) and `_send_non_blocking_keys()` (send and return quickly) reflect two different needs. Some callers need confidence that the terminal has accepted the input before they continue. Others just want to inject keys and keep moving. This branch exists to balance correctness and responsiveness.

6. The actual delivery into tmux happens at the bottom.  
   `_tmux_send_keys()` (issues the low-level tmux send operation) is the last mile. Its internal flush step helps avoid text getting stuck in buffers or arriving in the wrong chunks. This helper layer exists so higher stages never need to care about tmux quoting, splitting, or transport details.

7. On the read side, it pulls back the visible terminal state.  
   `_tmux_capture_pane()` (captures the current tmux pane contents) and `_get_visible_screen()` (gets the current visible text) are how the system observes what happened after a command was sent. Without this, the LLM would have no current terminal evidence to reason over.

8. It does not return the whole screen every time. It returns what changed.  
   `get_incremental_output()` (returns only newly appeared terminal text) compares the latest capture against a previous baseline. `_find_new_content()` (finds the new suffix or changed segment) is important because repeated full-screen snapshots are noisy. Later stages usually want “what happened since last poll,” not “everything still visible on screen.”

9. The result is a stable read/write service for execution.  
   Higher stages ask for command setup, key send, and output polling. This stage turns those requests into safe terminal interaction with continuity across the life of the run.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `无` — no pipeline register is written by this stage; it mainly updates object-local tmux session state and the external tmux session itself
- reads: `无` — no skeleton register is read directly; caller-provided input text and existing tmux/session state are consumed instead
- clears: `无` — no pipeline register is cleared here
- triggers downstream: `无` — this helper layer does not itself advance the pipeline; its callers do

Additional real runtime data flow in this unit:

- install-or-skip: reads system facts from the host environment, then either skips if tmux already exists or issues install/build commands so later execution has a terminal backend
- start-or-reuse session: reads object-local/external session identity; if a tmux session already exists it is reused for continuity, otherwise a new one is started
- safe-send: reads caller input text, checks whether it ends with newline or Enter, checks whether execution should be blocked, then transforms/splits that text and writes it into the tmux pane
- incremental-read: reads the current visible pane snapshot, compares it to the prior screen baseline, derives only the newly appeared content, then updates the remembered baseline for the next poll and returns the incremental text to the caller

#### (d) Pipeline Hand-Off

Upstream stages decide that the agent needs a live terminal, a command sent, or fresh output polled; this helper layer turns that intent into a working tmux session plus safe read/write behavior. Downstream execution and observation stages consume the two things it makes possible: reliable command delivery into the terminal and incremental terminal text coming back out.

<details id="fn-tmuxsession_send_keys">
<summary><b>TmuxSession.send_keys</b> — tmux_session.py:613-654 · Dispatch tmux key input through blocking policy</summary>

> **Stage context**: This helper is the stage's common entry point for pushing keystrokes or commands into an already-running tmux session. Internal setup, execution, and teardown code call it when they need one normalized send path instead of choosing `_send_blocking_keys` or `_send_non_blocking_keys` directly. In this stage, it sits above the lower-level send helpers and below higher-level tmux orchestration.

**What this code does**

`TmuxSession.send_keys` accepts `keys` plus timing and blocking controls, normalizes them through `_prepare_keys`, and then sends them into tmux through either the blocking or non-blocking path. It returns no value. Its real effect is external: it emits input to the active tmux session, optionally waits for completion, and logs the chosen send details through `_logger`.

**Interface · params / IO**

`(self, keys: str | list[str], block: bool = False, min_timeout_sec: float = 0.0, max_timeout_sec: float = 180.0)`

- params: `keys`: `str | list[str]` — Requested command text or key sequence to inject into tmux; `block`: `bool` — Caller preference for waiting on command completion; `min_timeout_sec`: `float` — Minimum post-send wait used only on the non-blocking path; `max_timeout_sec`: `float` — Upper bound for waiting when the final path is blocking
- reads: `self._logger`
- returns: None; it delivers `keys` to the tmux session and may wait for completion depending on the resolved blocking mode
- effects: writes debug log messages through `self._logger.debug(...)`; sends input to the active tmux session via `_send_blocking_keys(...)` or `_send_non_blocking_keys(...)`; may wait up to `max_timeout_sec` on the blocking path; may sleep or delay for at least `min_timeout_sec` on the non-blocking path

**Execution flow**

1. If `block` is `True` and `min_timeout_sec > 0.0`, it logs a debug message that `min_timeout_sec` will be ignored.
2. It calls `_prepare_keys(keys=keys, block=block)` and receives `prepared_keys` plus the resolved `is_blocking` flag.
3. It logs the outgoing `prepared_keys` together with `min_timeout_sec` and `max_timeout_sec` for send-time diagnostics.
4. If `is_blocking` is true, it awaits `_send_blocking_keys(keys=prepared_keys, max_timeout_sec=max_timeout_sec)`.
5. Otherwise, it awaits `_send_non_blocking_keys(keys=prepared_keys, min_timeout_sec=min_timeout_sec)`.

**Source**

```python
    async def send_keys(
        self,
        keys: str | list[str],
        block: bool = False,
        min_timeout_sec: float = 0.0,
        max_timeout_sec: float = 180.0,
    ):
        """
        Execute a command in the tmux session.

        Args:
            keys (str): The keys to send to the tmux session.
            block (bool): Whether to wait for the command to complete.
            min_timeout_sec (float): Minimum time in seconds to wait after executing.
                Defaults to 0.
            max_timeout_sec (float): Maximum time in seconds to wait for blocking
                commands. Defaults to 3 minutes.
        """
        if block and min_timeout_sec > 0.0:
            self._logger.debug("min_timeout_sec will be ignored because block is True.")

        prepared_keys, is_blocking = self._prepare_keys(
            keys=keys,
            block=block,
        )

        self._logger.debug(
            f"Sending keys: {prepared_keys}"
            f" min_timeout_sec: {min_timeout_sec}"
            f" max_timeout_sec: {max_timeout_sec}"
        )

        if is_blocking:
            await self._send_blocking_keys(
                keys=prepared_keys,
                max_timeout_sec=max_timeout_sec,
            )
        else:
            await self._send_non_blocking_keys(
                keys=prepared_keys,
                min_timeout_sec=min_timeout_sec,
            )
```

**Non-obvious design decisions**

- It resolves the final blocking policy through `_prepare_keys(...)` instead of trusting the raw `block` argument alone. That lets key normalization change or infer blocking behavior in one place; without that extra return value, callers or this method would need to duplicate command-specific blocking rules.
- It keeps both timeout arguments in the interface even though the blocking branch ignores `min_timeout_sec`. The explicit debug message documents that trade-off at runtime, which is cheaper than raising or silently dropping the value because callers can use one uniform API for both send modes.
- It centralizes logging before dispatch so both send paths share the same visibility into `prepared_keys` and timeout inputs. If each lower-level helper logged independently, the common intent and normalized payload would be easier to lose or report inconsistently.

**Relations**

- **Callers**: Internal tmux session startup helpers that inject shell setup commands; Internal command-execution paths in `TmuxSession` that run user or harness commands; Internal shutdown/cleanup helpers that send terminating input to tmux
- **Core callees**: `TmuxSession._prepare_keys`; `TmuxSession._send_blocking_keys`; `TmuxSession._send_non_blocking_keys`; `self._logger.debug`
- **Config / state sources**: `keys` argument; `block` argument; `min_timeout_sec` argument; `max_timeout_sec` argument
- **Results to**: Active tmux pane input stream; Blocking wait path in `_send_blocking_keys`; Non-blocking delay path in `_send_non_blocking_keys`; Debug log output for tmux command tracing

</details>


<details id="fn-tmuxsession_prepare_keys">
<summary><b>TmuxSession._prepare_keys</b> — tmux_session.py:544-569 · Normalize tmux key payloads for tracked execution</summary>

> **Stage context**: This helper sits under the tmux subsystem's send path and prepares raw `keys` just before tmux input dispatch. `TmuxSession.send_keys` calls it to decide whether a requested send can stay simple or must become a completion-tracked blocking sequence. Compared with its sibling `TmuxSession.send_keys`, this function does not talk to tmux itself; it only reshapes the payload and returns the blocking decision.

**What this code does**

`TmuxSession._prepare_keys` accepts `keys` as either a single string or a list of strings plus a `block` request. It returns a `(prepared_keys, is_blocking)` tuple after normalizing `keys` to a list and, when appropriate, converting a command-submitting key sequence into a completion-tracked form. It reads `_is_executing_command`, `_prevent_execution`, and `_TMUX_COMPLETION_COMMAND`, and it does not mutate instance state or produce external effects.

**Interface · params / IO**

`(self, keys: str | list[str], block: bool) -> tuple[list[str], bool]`

- params: `keys`: `str | list[str]` — Incoming tmux key payload to normalize and possibly rewrite; `block`: `bool` — Caller request to wait for command completion
- reads: `self._is_executing_command`, `self._prevent_execution`, `self._TMUX_COMPLETION_COMMAND`
- returns: A tuple `(prepared_keys, is_blocking)` where `prepared_keys` is always a `list[str]` and `is_blocking` reports whether the send should use the blocking completion-tracked path

**Execution flow**

1. If `keys` arrives as a `str`, wrap it into a one-item list so downstream code always works with `list[str]`.
2. Check the early-exit conditions: if `block` is false, `keys` is empty, or `self._is_executing_command(keys[-1])` says the final key does not submit a command, return the current `keys` and `False`.
3. When the caller asked for blocking and the last key would execute a command, call `self._prevent_execution(keys)` to remove or neutralize the original execution keystroke before submission.
4. Append `self._TMUX_COMPLETION_COMMAND` and a final `"Enter"` so the command runs with an explicit completion marker, then return the rewritten `keys` and `True`.

**Source**

```python
    def _prepare_keys(
        self,
        keys: str | list[str],
        block: bool,
    ) -> tuple[list[str], bool]:
        """
        Prepare keys for sending to the terminal.

        Args:
            keys (str | list[str]): The keys to send to the terminal.
            block (bool): Whether to wait for the command to complete.

        Returns:
            tuple[list[str], bool]: The keys to send to the terminal and whether the
                the keys are blocking.
        """
        if isinstance(keys, str):
            keys = [keys]

        if not block or not keys or not self._is_executing_command(keys[-1]):
            return keys, False

        keys = self._prevent_execution(keys)
        keys.extend([self._TMUX_COMPLETION_COMMAND, "Enter"])

        return keys, True
```

**Non-obvious design decisions**

- It only enables blocking when `self._is_executing_command(keys[-1])` recognizes the final key as a submit action. That avoids treating arbitrary key sends as waitable commands; the alternative would force blocking logic onto input sequences that never start a command.
- It rewrites the execution sequence through `self._prevent_execution(keys)` before appending `self._TMUX_COMPLETION_COMMAND`. That preserves a single controlled submission point; leaving the original execution key in place could run the command before the completion marker is injected.
- It returns `False` for the blocking flag on every early exit, even when the caller passed `block=True`. That keeps the return value tied to what downstream code can reliably wait for, not just to the caller's preference.

**Relations**

- **Callers**: `TmuxSession.send_keys`
- **Core callees**: `self._is_executing_command`; `self._prevent_execution`
- **Config / state sources**: `block` parameter; `keys` parameter; `self._TMUX_COMPLETION_COMMAND`
- **Results to**: `TmuxSession.send_keys` uses the returned boolean to choose blocking vs non-blocking send; `TmuxSession.send_keys` forwards the returned key list into tmux input emission
- **Related siblings**: `TmuxSession.send_keys` delegates key normalization and blocking preparation here before sending

</details>


<details id="fn-tmuxsession_is_executing_command">
<summary><b>TmuxSession._is_executing_command</b> — tmux_session.py:526-527 · Combine two command-execution predicates</summary>

> **Stage context**: This helper sits in the tmux internal-helper stage as a very small predicate wrapper. The code shown only combines `self._is_enter_key(key)` and `self._ends_with_newline(key)` into one boolean result, so its role here is to centralize that combined test in one place.

**What this code does**

`TmuxSession._is_executing_command` takes one `key` string and returns the boolean result of `self._is_enter_key(key) or self._ends_with_newline(key)`. It does not read or write any `self._` attributes directly in this body. It has no side effects beyond calling those two helper predicates, with normal `or` short-circuit behavior.

**Interface · params / IO**

`(self, key: str) -> bool`

- params: `key`: `str` — input string passed to both delegated predicate helpers
- returns: A `bool` equal to `self._is_enter_key(key) or self._ends_with_newline(key)`.

**Execution flow**

1. Call `self._is_enter_key(key)` first and use its boolean result as the left side of the `or` expression.
2. If that first result is truthy, let `or` short-circuit and return immediately without calling `self._ends_with_newline(key)`.
3. If the first result is falsy, call `self._ends_with_newline(key)` and return that second boolean result.

**Source**

```python
    def _is_executing_command(self, key: str) -> bool:
        return self._is_enter_key(key) or self._ends_with_newline(key)
```

**Non-obvious design decisions**

- The method delegates the actual tests to `_is_enter_key` and `_ends_with_newline` instead of adding any inline string logic here. That keeps this function limited to combining two existing predicates.
- The body uses `or`, so either delegated predicate is sufficient for a `True` result. The code adds no extra filtering, precedence rules, or post-processing beyond that combined truth test.
- Using `or` also preserves Python short-circuit evaluation, which avoids calling `_ends_with_newline(key)` when `_is_enter_key(key)` already returned truthy.

**Relations**

- **Callers**: Internal code that wants the combined result of `_is_enter_key(key)` and `_ends_with_newline(key)`
- **Core callees**: TmuxSession._is_enter_key; TmuxSession._ends_with_newline
- **Config / state sources**: `key` argument
- **Results to**: Immediate boolean return value to this method's caller
- **Related siblings**: TmuxSession._prepare_keys references `_is_executing_command` while normalizing key input.

</details>


<details id="fn-tmuxsession_is_enter_key">
<summary><b>TmuxSession._is_enter_key</b> — tmux_session.py:511-512 · Enter-key membership predicate</summary>

> **Stage context**: This entry is a tiny internal helper in the tmux helper stage. In the provided source, it only classifies one `key` string by checking membership in `self._ENTER_KEYS` and returns that boolean result.

**What this code does**

`TmuxSession._is_enter_key` takes one `key` string and returns whether that value appears in `self._ENTER_KEYS`. It reads that configured key collection and produces a boolean. It does not mutate instance state and has no external side effects.

**Interface · params / IO**

`(self, key: str) -> bool`

- params: `key`: `str` — Key token to test against `self._ENTER_KEYS`
- reads: `self._ENTER_KEYS`
- returns: Boolean result of `key in self._ENTER_KEYS`

**Execution flow**

1. Read `self._ENTER_KEYS` from the instance.
2. Return the boolean result of the membership test `key in self._ENTER_KEYS`.

**Source**

```python
    def _is_enter_key(self, key: str) -> bool:
        return key in self._ENTER_KEYS
```

**Non-obvious design decisions**



**Relations**

- **Config / state sources**: self._ENTER_KEYS
- **Results to**: Direct boolean return to the immediate caller

</details>


<details id="fn-tmuxsession_ends_with_newline">
<summary><b>TmuxSession._ends_with_newline</b> — tmux_session.py:514-516 · newline-suffix predicate for tmux command detection</summary>

> **Stage context**: This helper lives in the tmux internal-helper stage and supports the subsystem's logic for recognizing when a key payload would submit a command. `TmuxSession._is_executing_command` invokes it alongside `TmuxSession._is_enter_key` to classify a `key` string before higher-level send logic decides whether to use completion-tracked blocking behavior. It is narrower than a general text utility because it only serves tmux session key handling.

**What this code does**

`TmuxSession._ends_with_newline` checks whether the input `key` matches the session's trailing-newline pattern in `self._ENDS_WITH_NEWLINE_PATTERN`. It returns `True` when `re.search(...)` finds a match and `False` otherwise. The function reads one instance attribute and the `key` argument, and it does not mutate instance state or produce external side effects.

**Interface · params / IO**

`(self, key: str) -> bool`

- params: `key`: `str` — tmux key payload to test for a newline-style suffix
- reads: `self._ENDS_WITH_NEWLINE_PATTERN`
- returns: Boolean indicating whether `key` contains a suffix that matches `self._ENDS_WITH_NEWLINE_PATTERN`

**Execution flow**

1. Call `re.search` with `self._ENDS_WITH_NEWLINE_PATTERN` and the input `key`, producing a match object or `None` in `result`.
2. Return `result is not None` so callers receive a strict boolean instead of the raw regex match object.

**Source**

```python
    def _ends_with_newline(self, key: str) -> bool:
        result = re.search(self._ENDS_WITH_NEWLINE_PATTERN, key)
        return result is not None
```

**Non-obvious design decisions**

- It centralizes newline-style command-submission detection behind `self._ENDS_WITH_NEWLINE_PATTERN` instead of hard-coding string checks here, so the matching rule stays configurable at the session level.
- It uses `result is not None` to normalize the regex outcome to a plain `bool`, which keeps callers like `TmuxSession._is_executing_command` working with a simple predicate rather than a truthy match object.

**Relations**

- **Callers**: TmuxSession._is_executing_command
- **Core callees**: re.search
- **Config / state sources**: self._ENDS_WITH_NEWLINE_PATTERN
- **Results to**: The boolean feeds `TmuxSession._is_executing_command`'s `or` predicate.; That classification informs `TmuxSession._prepare_keys` when it decides whether a key sequence should become completion-tracked blocking input.; Through those siblings, the result ultimately affects `TmuxSession.send_keys` dispatch behavior.
- **Related siblings**: TmuxSession._is_executing_command combines this predicate with `TmuxSession._is_enter_key`.; TmuxSession._prepare_keys uses command-execution detection to choose blocking/completion handling.

</details>


<details id="fn-tmuxsession_prevent_execution">
<summary><b>TmuxSession._prevent_execution</b> — tmux_session.py:529-542 · Strip command-submitting tail from tmux key list</summary>

> **Stage context**: This helper sits under the tmux send-key preparation path. `_prepare_keys` invokes it when a blocking send must avoid actually submitting the shell command yet, so the session can append its completion-tracking command first. It complements `_is_executing_command`, `_is_enter_key`, and `_ends_with_newline` by turning their execution detection rules into a sanitized key sequence.

**What this code does**

`TmuxSession._prevent_execution` takes a `list[str]` of tmux key tokens and returns a copied list whose tail no longer triggers command execution. It removes trailing Enter-style tokens or trims trailing newline characters from the last token until `_is_executing_command(keys[-1])` becomes false. It does not mutate instance state, and it avoids mutating the caller's input by starting from `keys.copy()`.

**Interface · params / IO**

`(self, keys: list[str]) -> list[str]`

- params: `keys`: `list[str]` — Input tmux key-token sequence to sanitize before later send-key handling
- reads: `self._NEWLINE_CHARS`
- returns: A new `list[str]` derived from `keys` with any trailing command-submission effect removed

**Execution flow**

1. Copy `keys` with `keys.copy()` so later edits stay local to this helper.
2. Check the current tail token with `_is_executing_command(keys[-1])` and keep looping while the list is non-empty and the tail would still submit a command.
3. If the tail token is an Enter-style token according to `_is_enter_key(keys[-1])`, remove that whole token with `pop()`.
4. Otherwise strip trailing newline characters from the tail with `keys[-1].rstrip(self._NEWLINE_CHARS)`.
5. Replace the last token with the stripped value when it remains non-empty; if stripping removes the whole token, drop that token instead.
6. Return the sanitized copied list once the tail no longer counts as an execution trigger or the list becomes empty.

**Source**

```python
    def _prevent_execution(self, keys: list[str]) -> list[str]:
        keys = keys.copy()
        while keys and self._is_executing_command(keys[-1]):
            if self._is_enter_key(keys[-1]):
                keys.pop()
            else:
                stripped_key = keys[-1].rstrip(self._NEWLINE_CHARS)

                if stripped_key:
                    keys[-1] = stripped_key
                else:
                    keys.pop()

        return keys
```

**Non-obvious design decisions**

- It works on `keys.copy()` instead of mutating the incoming list so `_prepare_keys` can safely inspect and rewrite key sequences without surprising its caller. In-place mutation would couple this helper to upstream list ownership.
- It loops until `_is_executing_command(keys[-1])` is false, not just once, because the tail can contain stacked execution triggers such as multiple Enter tokens or a token that still ends with newline characters after one trim. A single-pass cleanup would leave some command-submitting cases intact.
- It treats standalone Enter tokens and newline-bearing text tokens differently by branching on `_is_enter_key(keys[-1])`. That preserves as much of the user's original text as possible: pure Enter keys disappear, while mixed content only loses its trailing newline suffix.

**Relations**

- **Callers**: TmuxSession._prepare_keys
- **Core callees**: TmuxSession._is_executing_command; TmuxSession._is_enter_key
- **Config / state sources**: self._NEWLINE_CHARS
- **Results to**: TmuxSession._prepare_keys returns the sanitized list as part of `(prepared_keys, is_blocking)`; TmuxSession.send_keys indirectly uses the sanitized keys after `_prepare_keys` normalization; Blocking command-submission rewriting in the tmux send-key path
- **Related siblings**: TmuxSession._prepare_keys; TmuxSession._is_executing_command; TmuxSession._is_enter_key; TmuxSession._ends_with_newline

</details>


<details id="fn-tmuxsession_send_non_blocking_keys">
<summary><b>TmuxSession._send_non_blocking_keys</b> — tmux_session.py:594-611 · Dispatch tmux keys without completion waiting</summary>

> **Stage context**: This helper is the low-level non-blocking send path inside the tmux session subsystem. `TmuxSession.send_keys` reaches it after `_prepare_keys` has normalized the key list and decided that the caller should not wait for command completion. Within this stage, it sits below the orchestration-facing API and only handles command dispatch plus minimum pacing.

**What this code does**

`TmuxSession._send_non_blocking_keys` takes a prepared `list[str]` of tmux key tokens and a `min_timeout_sec` floor, sends those keys to the active tmux session, and returns no value. It uses `self._tmux_send_keys(keys)` to obtain one or more tmux commands, then runs each command through `self.environment.exec(..., user=self._user)`. If any send command fails (`result.return_code != 0`), it raises `RuntimeError`; otherwise it may sleep long enough to ensure the whole call lasts at least `min_timeout_sec` seconds.

**Interface · params / IO**

`(self, keys: list[str], min_timeout_sec: float)`

- params: `self`: `?` — tmux session object that provides command construction, environment access, and user context; `keys`: `list[str]` — prepared tmux key tokens to inject into the active session; `min_timeout_sec`: `float` — minimum wall-clock duration the call should occupy after dispatch starts
- reads: `self._tmux_send_keys`, `self.environment`, `self._user`
- returns: None; its real product is sending input into tmux and optionally delaying to satisfy the minimum timeout
- effects: executes tmux send-key commands through `self.environment.exec(...)`; raises `RuntimeError` when an underlying tmux send command returns a non-zero status; sleeps via `asyncio.sleep(...)` when dispatch finished faster than `min_timeout_sec`

**Execution flow**

1. Record `start_time_sec = time.time()` so the function can measure total dispatch latency against `min_timeout_sec`.
2. Call `self._tmux_send_keys(keys)` and iterate over each generated tmux command string.
3. For each `command`, await `self.environment.exec(command=command, user=self._user)` to send that piece of input under the configured session user.
4. Check `result.return_code` after each exec call, and raise `RuntimeError` with `self.environment.session_id` and `result.stderr` if any command failed.
5. After all commands succeed, compute `elapsed_time_sec = time.time() - start_time_sec`.
6. If `elapsed_time_sec < min_timeout_sec`, await `asyncio.sleep(min_timeout_sec - elapsed_time_sec)` to fill only the remaining time.

**Source**

```python
    async def _send_non_blocking_keys(
        self,
        keys: list[str],
        min_timeout_sec: float,
    ):
        start_time_sec = time.time()

        for command in self._tmux_send_keys(keys):
            result = await self.environment.exec(command=command, user=self._user)
            if result.return_code != 0:
                raise RuntimeError(
                    f"{self.environment.session_id}: failed to send non-blocking keys: {result.stderr}"
                )

        elapsed_time_sec = time.time() - start_time_sec

        if elapsed_time_sec < min_timeout_sec:
            await asyncio.sleep(min_timeout_sec - elapsed_time_sec)
```

**Non-obvious design decisions**

- It measures elapsed time from before the first send and only sleeps for the remaining gap because `min_timeout_sec` is a minimum pacing guarantee, not an unconditional extra delay. A fixed post-send sleep would over-delay calls whose tmux dispatch already consumed enough time.
- It checks `result.return_code` after every `environment.exec(...)` and raises immediately on the first failure so callers do not assume later keys were delivered after an earlier send command already failed. Ignoring that status would hide partial-delivery problems.
- It routes execution through `self.environment.exec(..., user=self._user)` instead of invoking tmux directly here so this helper stays aligned with the session environment abstraction and the configured execution identity.

**Relations**

- **Callers**: `TmuxSession.send_keys` when `_prepare_keys` selects non-blocking delivery
- **Core callees**: `self._tmux_send_keys`; `self.environment.exec`; `time.time`; `asyncio.sleep`
- **Config / state sources**: `self._user` supplies the exec user; `self.environment.session_id` supplies failure context for the error message; `keys` comes from `TmuxSession._prepare_keys` normalization
- **Results to**: active tmux session receives the requested key input; `TmuxSession.send_keys` gets completion or a raised `RuntimeError`; caller-observed timing is stretched to at least `min_timeout_sec`
- **Related siblings**: `TmuxSession.send_keys` chooses this helper versus the blocking path; `TmuxSession._prepare_keys` normalizes `keys` before this helper receives them

</details>


<details id="fn-tmuxsession_send_blocking_keys">
<summary><b>TmuxSession._send_blocking_keys</b> — tmux_session.py:571-592 · Blocking tmux key sender with completion wait</summary>

> **Stage context**: This helper handles the synchronous half of tmux input delivery inside the internal tmux session layer. `TmuxSession.send_keys` reaches it after `_prepare_keys` has converted an execution-triggering key sequence into a completion-tracked form and requested blocking behavior. It complements `TmuxSession._send_non_blocking_keys`: both send prepared keys through tmux, but this variant also waits for tmux's completion channel before returning.

**What this code does**

`TmuxSession._send_blocking_keys` takes a prepared `keys` list and a `max_timeout_sec` limit, sends the keys into tmux, then waits for `tmux wait done` to report completion. It returns no value. Its real work is external: it runs tmux-related commands through `self.environment.exec(...)`, raises `RuntimeError` if any send command fails, raises `TimeoutError` if the wait command does not complete successfully, and logs the total blocking duration through `self._logger.debug(...)`.

**Interface · params / IO**

`(self, keys: list[str], max_timeout_sec: float)`

- params: `keys`: `list[str]` — Prepared tmux key tokens to inject into the active session; `max_timeout_sec`: `float` — Upper bound for the blocking `tmux wait done` call
- reads: `self.environment`, `self._user`, `self._tmux_send_keys`, `self._logger`
- returns: None; the real product is sending input to tmux and waiting until the session signals command completion
- effects: Runs one or more tmux send commands via `self.environment.exec(command=..., user=self._user)`; Runs `timeout {max_timeout_sec}s tmux wait done` via `self.environment.exec(...)`; Raises `RuntimeError` when a send command returns a non-zero `return_code`; Raises `TimeoutError` when the blocking wait command returns a non-zero `return_code`; Emits a debug log line through `self._logger.debug(...)`

**Execution flow**

1. It records `start_time_sec = time.time()` so it can report total blocking duration after the wait completes.
2. It expands the prepared `keys` through `self._tmux_send_keys(keys)` and executes each resulting tmux send command with `self.environment.exec(..., user=self._user)`.
3. After each send attempt, it checks `result.return_code`; if any send command fails, it stops immediately and raises `RuntimeError` with `self.environment.session_id` and `result.stderr` in the message.
4. Once all send commands succeed, it runs `timeout {max_timeout_sec}s tmux wait done` through `self.environment.exec(..., user=self._user)` to block until tmux signals completion.
5. It treats any non-zero return from the wait command as a timeout condition and raises `TimeoutError` that names `max_timeout_sec`.
6. If the wait succeeds, it computes `elapsed_time_sec` from the saved start time and logs the completion time with `self._logger.debug(...)`.

**Source**

```python
    async def _send_blocking_keys(
        self,
        keys: list[str],
        max_timeout_sec: float,
    ):
        start_time_sec = time.time()

        for command in self._tmux_send_keys(keys):
            result = await self.environment.exec(command=command, user=self._user)
            if result.return_code != 0:
                raise RuntimeError(
                    f"{self.environment.session_id}: failed to send blocking keys: {result.stderr}"
                )

        result = await self.environment.exec(
            f"timeout {max_timeout_sec}s tmux wait done", user=self._user
        )
        if result.return_code != 0:
            raise TimeoutError(f"Command timed out after {max_timeout_sec} seconds")

        elapsed_time_sec = time.time() - start_time_sec
        self._logger.debug(f"Blocking command completed in {elapsed_time_sec:.2f}s.")
```

**Non-obvious design decisions**

- It separates send failure from completion timeout. The first loop raises `RuntimeError` on a bad `return_code`, while the later wait path raises `TimeoutError`. That split preserves whether tmux rejected the input itself or the command failed to finish within `max_timeout_sec`.
- It waits on `tmux wait done` instead of inferring completion from the send command results. Sending keys only confirms that tmux accepted input; the explicit wait channel lets the caller block on downstream command completion, which matches the blocking behavior prepared by `_prepare_keys`.
- It routes key delivery through `self._tmux_send_keys(keys)` rather than assuming one shell command per request. That keeps the blocking helper compatible with the same key-normalization and command-expansion scheme used by `TmuxSession._send_non_blocking_keys`.

**Relations**

- **Callers**: TmuxSession.send_keys
- **Core callees**: self._tmux_send_keys; self.environment.exec; self._logger.debug; time.time
- **Config / state sources**: self._user; self.environment.session_id
- **Results to**: Active tmux session receives the prepared key sequence; Caller resumes only after `tmux wait done` succeeds; `TmuxSession.send_keys` receives `RuntimeError` on send failure; `TmuxSession.send_keys` receives `TimeoutError` when blocking completion exceeds `max_timeout_sec`
- **Related siblings**: TmuxSession.send_keys orchestrates the blocking vs non-blocking branch before calling this helper.; TmuxSession._prepare_keys produces the completion-tracked `keys` list that makes this blocking wait meaningful.; TmuxSession._send_non_blocking_keys` uses the same `_tmux_send_keys` expansion but skips the `tmux wait done` phase.

</details>


<details id="fn-tmuxsession_tmux_send_keys">
<summary><b>TmuxSession._tmux_send_keys</b> — tmux_session.py:341-392 · Batch tmux send-keys command builder</summary>

> **Stage context**: This helper sits under the tmux input-sending paths and turns normalized key tokens into executable `tmux send-keys` shell commands. `TmuxSession._send_non_blocking_keys` and `TmuxSession._send_blocking_keys` call it after `TmuxSession.send_keys` and `TmuxSession._prepare_keys` finish deciding what keys to emit. Within this stage, it is the command-packing layer that bridges prepared key lists to actual `environment.exec(...)` calls.

**What this code does**

`TmuxSession._tmux_send_keys` takes a `list[str]` of tmux key tokens and returns a `list[str]` of shell command strings, each starting with `tmux send-keys -t <session>`. It reads `self._session_name` and `self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH`, shell-quotes each key with `shlex.quote(...)`, and splits the work across multiple commands when one combined command would be too long. If an individual key still exceeds the limit by itself, it delegates to `self._split_key_for_tmux(...)` to break that key into quoted chunks. It does not mutate instance state and has no external effects by itself.

**Interface · params / IO**

`(self, keys: list[str]) -> list[str]`

- params: `keys`: `list[str]` — Prepared tmux key tokens to encode into one or more `tmux send-keys` commands
- reads: `self._session_name`, `self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH`
- returns: A `list[str]` of fully formed `tmux send-keys -t ...` shell command strings sized to stay within `self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH`

**Execution flow**

1. It builds the fixed command prefix from `self._session_name` as `"tmux send-keys -t " + shlex.quote(self._session_name)` and reads the size limit from `self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH`.
2. It shell-quotes every entry in `keys`, assembles one candidate command in `single`, and returns `[single]` immediately when `len(single) <= max_len`.
3. If the single-command fast path fails, it starts accumulating quoted keys into `current_escaped` and tracks the current command length in `current_len`; the nested `_flush()` closes the current batch into `commands` and resets the accumulator.
4. For each original `key`, it computes that key's quoted size as `addition = 1 + len(shlex.quote(key))` and either appends it to the current batch, starts a fresh batch with it after `_flush()`, or treats it as individually oversized.
5. When one key cannot fit even in an empty command (`len(prefix) + addition > max_len`), it computes `max_escaped = max_len - len(prefix) - 1` and asks `self._split_key_for_tmux(key, max_escaped)` for pre-quoted chunks.
6. It then packs those `chunk_escaped` pieces into `current_escaped`, flushing between chunks when needed, and finally flushes any remaining batch before returning `commands`.

**Source**

```python
    def _tmux_send_keys(self, keys: list[str]) -> list[str]:
        """Build one or more ``tmux send-keys`` commands for *keys*.

        If the shell-escaped command would exceed the tmux command-length
        limit, the keys are spread across multiple commands so that each
        individual command stays within the limit.  Oversized single keys
        are split into sub-strings whose quoted form fits.
        """
        prefix = "tmux send-keys -t " + shlex.quote(self._session_name)
        max_len = self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH

        escaped_keys = [shlex.quote(key) for key in keys]
        single = prefix + " " + " ".join(escaped_keys)
        if len(single) <= max_len:
            return [single]

        commands: list[str] = []
        current_escaped: list[str] = []
        current_len = len(prefix)

        def _flush() -> None:
            nonlocal current_len
            if current_escaped:
                commands.append(prefix + " " + " ".join(current_escaped))
                current_escaped.clear()
                current_len = len(prefix)

        for key in keys:
            escaped = shlex.quote(key)
            addition = 1 + len(escaped)  # space + quoted key

            if current_len + addition <= max_len:
                current_escaped.append(escaped)
                current_len += addition
            elif len(prefix) + addition <= max_len:
                _flush()
                current_escaped.append(escaped)
                current_len = len(prefix) + addition
            else:
                _flush()
                max_escaped = max_len - len(prefix) - 1
                for chunk_escaped in self._split_key_for_tmux(key, max_escaped):
                    if current_len + 1 + len(chunk_escaped) <= max_len:
                        current_escaped.append(chunk_escaped)
                        current_len += 1 + len(chunk_escaped)
                    else:
                        _flush()
                        current_escaped.append(chunk_escaped)
                        current_len = len(prefix) + 1 + len(chunk_escaped)

        _flush()
        return commands
```

**Non-obvious design decisions**

- The `single` fast path avoids the batching loop when all quoted keys already fit under `max_len`. That keeps the common case simple and avoids unnecessary per-key bookkeeping in `commands`, `current_escaped`, and `_flush()`.
- The function measures length after `shlex.quote(...)`, not from raw key text, because the shell command limit applies to the escaped command string that tmux will receive. Using raw lengths would undercount keys that need quoting or escaping.
- It batches by command length instead of emitting one tmux command per key so the send path can stay compact while still honoring `self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH`. The alternative would be simpler but would create many more `tmux send-keys` invocations.
- It handles the oversized-single-key case with `self._split_key_for_tmux(...)` instead of failing outright once a quoted key exceeds the limit. That fallback preserves the ability to send long pasted text through the same interface.

**Relations**

- **Callers**: TmuxSession._send_non_blocking_keys; TmuxSession._send_blocking_keys
- **Core callees**: shlex.quote; TmuxSession._split_key_for_tmux
- **Config / state sources**: self._session_name; self._TMUX_SEND_KEYS_MAX_COMMAND_LENGTH
- **Results to**: TmuxSession._send_non_blocking_keys iterates returned commands through `self.environment.exec(...)`; TmuxSession._send_blocking_keys iterates returned commands through `self.environment.exec(...)` before waiting for completion
- **Related siblings**: TmuxSession.send_keys; TmuxSession._prepare_keys; TmuxSession._send_non_blocking_keys; TmuxSession._send_blocking_keys

</details>


<details id="fn-tmuxsession_tmux_send_keys_flush">
<summary><b>TmuxSession._tmux_send_keys._flush</b> — tmux_session.py:361-366 · nested tmux command chunk flusher</summary>

> **Stage context**: This helper lives inside the tmux internal command builder for key sending. The enclosing `_tmux_send_keys` logic invokes it when it needs to emit the currently buffered escaped key fragments as one command string. Within this stage, it serves as a tiny batching primitive under `TmuxSession._tmux_send_keys`, which is the sibling that constructs the full `tmux send-keys` command list.

**What this code does**

`TmuxSession._tmux_send_keys._flush` takes no parameters and returns `None`. It reads the closure variables `current_escaped`, `commands`, and `prefix`, and if `current_escaped` is non-empty it appends one assembled command string to `commands`, clears `current_escaped`, and resets the nonlocal `current_len` to `len(prefix)`. When `current_escaped` is empty, it is a no-op and leaves both `commands` and `current_len` unchanged.

**Interface · params / IO**

`() -> None`

- reads: `closure variable `current_escaped``, `closure variable `commands``, `closure variable `prefix``
- returns: None; its real product is conditional mutation of the enclosing command buffer state
- effects: appends one string to closure list `commands` when `current_escaped` is non-empty; clears closure list `current_escaped` when `current_escaped` is non-empty; writes nonlocal `current_len = len(prefix)` when `current_escaped` is non-empty; does nothing when `current_escaped` is empty

**Execution flow**

1. Declare `current_len` as `nonlocal`, so assignments update the enclosing `_tmux_send_keys` length tracker.
2. Check `if current_escaped:` and stop immediately if that buffer is empty.
3. Build one command string from `prefix + " " + " ".join(current_escaped)` and append it to `commands`.
4. Clear `current_escaped` and reset `current_len` to `len(prefix)` for the next chunk.

**Source**

```python
        def _flush() -> None:
            nonlocal current_len
            if current_escaped:
                commands.append(prefix + " " + " ".join(current_escaped))
                current_escaped.clear()
                current_len = len(prefix)
```

**Non-obvious design decisions**

- The explicit `if current_escaped:` guard avoids emitting a command that contains only `prefix`. The direct consequence is that an empty buffer produces no append, no clear, and no `current_len` reset.
- The reset target is `len(prefix)`, not `0`. That keeps the enclosing length tracker aligned with a fresh command that already includes the fixed `prefix` portion.

**Relations**

- **Callers**: the enclosing `TmuxSession._tmux_send_keys` function
- **Core callees**: `commands.append(...)`; `" ".join(current_escaped)`; `current_escaped.clear()`; `len(prefix)`
- **Config / state sources**: closure variable `prefix` from the enclosing `TmuxSession._tmux_send_keys` scope; closure variable `current_escaped` from the enclosing `TmuxSession._tmux_send_keys` scope; closure variable `commands` from the enclosing `TmuxSession._tmux_send_keys` scope; nonlocal `current_len` from the enclosing `TmuxSession._tmux_send_keys` scope
- **Results to**: closure list `commands` in the enclosing `TmuxSession._tmux_send_keys` scope; closure list `current_escaped` in the enclosing `TmuxSession._tmux_send_keys` scope; nonlocal `current_len` in the enclosing `TmuxSession._tmux_send_keys` scope; `TmuxSession._tmux_send_keys`, which returns the accumulated `commands` list
- **Related siblings**: `TmuxSession._tmux_send_keys`

</details>


<details id="fn-tmuxsession_split_key_for_tmux">
<summary><b>TmuxSession._split_key_for_tmux</b> — tmux_session.py:394-410 · quoted key splitter for tmux command length limits</summary>

> **Stage context**: This helper supports the tmux-internal command-building path by breaking one oversized key payload into smaller shell-quoted pieces. `TmuxSession._tmux_send_keys` invokes it only when a single quoted key would exceed that method's command-length budget. It sits below the sibling send/wait helpers: `_tmux_send_keys` assembles commands, and this function only prepares safe quoted fragments for that assembly.

**What this code does**

`TmuxSession._split_key_for_tmux` takes one raw `key` string and a `max_escaped_len` limit, then returns a `list[str]` of `shlex.quote(...)`-escaped chunks. Each returned chunk's escaped form is no longer than `max_escaped_len`. The function reads only its arguments, calls `shlex.quote(...)`, and does not mutate object state or perform external I/O.

**Interface · params / IO**

`(key: str, max_escaped_len: int) -> list[str]`

- params: `key`: `str` — raw key text that may be too large to send as one quoted tmux argument; `max_escaped_len`: `int` — maximum allowed length for each `shlex.quote(...)` result
- returns: a `list[str]` of quoted fragments derived from `key`, each fragment already escaped with `shlex.quote(...)` and each escaped string bounded by `max_escaped_len`

**Execution flow**

1. Initialize `chunks` as the output list and `remaining` as the unsplit suffix of `key`.
2. While `remaining` is non-empty, binary-search the prefix length between `1` and `len(remaining)` using `lo`, `hi`, and `best`.
3. For each candidate `mid`, measure `len(shlex.quote(remaining[:mid]))`; keep larger prefixes when that escaped length fits within `max_escaped_len`, otherwise shrink the search range.
4. After the search, append `shlex.quote(remaining[:best])` to `chunks` and remove that raw prefix from `remaining`.
5. Repeat until no text remains, then return `chunks`.

**Source**

```python
    def _split_key_for_tmux(key: str, max_escaped_len: int) -> list[str]:
        """Split *key* into ``shlex.quote``-d chunks each ≤ *max_escaped_len*."""
        chunks: list[str] = []
        remaining = key
        while remaining:
            lo, hi, best = 1, len(remaining), 1
            while lo <= hi:
                mid = (lo + hi) // 2
                if len(shlex.quote(remaining[:mid])) <= max_escaped_len:
                    best = mid
                    lo = mid + 1
                else:
                    hi = mid - 1
            chunks.append(shlex.quote(remaining[:best]))
            remaining = remaining[best:]
        return chunks
```

**Non-obvious design decisions**

- It measures `len(shlex.quote(...))` instead of raw substring length because shell escaping can expand the text. That choice keeps `_tmux_send_keys` aligned with actual command-string size, whereas splitting on raw length could still produce an overlong quoted argument.
- It uses a binary search over prefix size (`lo`, `hi`, `best`) to find the largest fitting chunk each round. That avoids a slower character-by-character scan when `key` is long and many trial prefixes would need repeated quoting.
- It returns already-quoted strings rather than raw fragments so the caller can splice them directly into the tmux command builder. The alternative would require `_tmux_send_keys` to re-quote every fragment and duplicate the same length logic.

**Relations**

- **Callers**: `TmuxSession._tmux_send_keys` when one individual key still exceeds `_TMUX_SEND_KEYS_MAX_COMMAND_LENGTH` after quoting
- **Core callees**: `shlex.quote` to escape each trial prefix and each committed chunk
- **Config / state sources**: `max_escaped_len` argument supplied by `TmuxSession._tmux_send_keys`; `key` argument supplied by the tmux command-construction path
- **Results to**: `TmuxSession._tmux_send_keys`, which inserts the returned quoted chunks into `tmux send-keys` command strings; The command list later consumed by `_send_non_blocking_keys`; The command list later consumed by `_send_blocking_keys`
- **Related siblings**: `TmuxSession._tmux_send_keys` delegates here for oversized keys; `TmuxSession._send_non_blocking_keys` executes commands built from these chunks; `TmuxSession._send_blocking_keys` executes and waits on commands built from these chunks

</details>


<details id="fn-tmuxsession_attempt_tmux_installation">
<summary><b>TmuxSession._attempt_tmux_installation</b> — tmux_session.py:76-151 · tmux and asciinema prerequisite installer</summary>

> **Stage context**: This helper belongs to the tmux-internal stage because it prepares external tmux-related prerequisites rather than sending keys or managing session flow. Within this stage, it complements lower-level helpers by ensuring the required binaries exist before later tmux command helpers can succeed.

**What this code does**

`TmuxSession._attempt_tmux_installation` checks whether `tmux` is already available and, when `_remote_asciinema_recording_path` is set, whether `asciinema` is available too. It returns `None` after either doing nothing, attempting one combined package-manager install, or falling back to per-tool installers when no package manager is usable, no combined install command is produced, package installation fails, or post-install verification still fails. The method does not update instance fields in this excerpt, but it runs multiple remote commands as `root` and emits debug or warning logs.

**Interface · params / IO**

`async def _attempt_tmux_installation(self) -> None`

- params: `self`: `TmuxSession` — session object that provides environment access, config, logging, and installer helpers
- reads: `self.environment`, `self._remote_asciinema_recording_path`, `self._logger`, `self._detect_system_info`, `self._get_combined_install_command`, `self._build_tmux_from_source`, `self._install_asciinema_with_pip`
- returns: None
- effects: executes `tmux -V` as `root` to probe whether tmux is installed; may execute `asciinema --version` as `root` to probe whether asciinema is installed; logs installation status and chosen installation path through `self._logger.debug(...)` and `self._logger.warning(...)`; calls `self._detect_system_info()` to discover package-manager information; may execute one combined package-manager install command from `_get_combined_install_command(...)` as `root`; after a successful combined install command, may re-run `tmux -V` as `root` to verify tmux; after a successful combined install command, may re-run `asciinema --version` as `root` to verify asciinema; may call `self._build_tmux_from_source()` if tmux is still missing or package-manager installation is unavailable/unsuccessful; may call `self._install_asciinema_with_pip()` if asciinema is still missing or package-manager installation is unavailable/unsuccessful

**Execution flow**

1. It probes `tmux` with `self.environment.exec(command="tmux -V", user="root")` and records `tmux_installed` from `return_code == 0`. It derives `needs_asciinema` from `self._remote_asciinema_recording_path is not None`.
2. If `needs_asciinema` is true, it probes `asciinema` with `asciinema --version` and records `asciinema_installed` from the return code. Otherwise it normalizes `asciinema_installed = True`, so later checks can treat the non-recording case as already satisfied.
3. If both tools are already considered installed, it logs `Both tmux and asciinema are already installed` and returns before building `tools_needed`.
4. Otherwise it builds `tools_needed` from the missing binaries, logs `Installing: ...`, then calls `_detect_system_info()` and checks `system_info["package_manager"]`.
5. When a package manager exists, it asks `_get_combined_install_command(system_info, tools_needed)` for one install command. If that command is truthy, it logs the package-manager path and executes the combined install as `root`.
6. If that combined install command returns success (`result.return_code == 0`), it verifies each previously missing tool separately: failed `tmux -V` verification triggers `_build_tmux_from_source()`, and failed `asciinema --version` verification triggers `_install_asciinema_with_pip()`. After those verification-time fallbacks, it returns from the function.
7. The final fallback block runs only when there is no package manager, `_get_combined_install_command(...)` returns a falsey value, or the combined install command finishes with a nonzero return code. In that case it independently installs missing tools with `_build_tmux_from_source()` for tmux and `_install_asciinema_with_pip()` for asciinema, with warning logs before each call.

**Source**

```python
    async def _attempt_tmux_installation(self) -> None:
        """
        Install both tmux and asciinema in a single operation for efficiency.
        """
        # Check what's already installed
        tmux_result = await self.environment.exec(command="tmux -V", user="root")
        tmux_installed = tmux_result.return_code == 0

        needs_asciinema = self._remote_asciinema_recording_path is not None
        if needs_asciinema:
            asciinema_result = await self.environment.exec(
                command="asciinema --version", user="root"
            )
            asciinema_installed = asciinema_result.return_code == 0
        else:
            asciinema_installed = True

        if tmux_installed and asciinema_installed:
            self._logger.debug("Both tmux and asciinema are already installed")
            return

        tools_needed = []
        if not tmux_installed:
            tools_needed.append("tmux")
        if needs_asciinema and not asciinema_installed:
            tools_needed.append("asciinema")

        self._logger.debug(f"Installing: {', '.join(tools_needed)}")

        # Detect system and package manager
        system_info = await self._detect_system_info()

        if system_info["package_manager"]:
            install_command = self._get_combined_install_command(
                system_info, tools_needed
            )
            if install_command:
                self._logger.debug(
                    f"Installing tools using {system_info['package_manager']}: {install_command}"
                )
                result = await self.environment.exec(
                    command=install_command, user="root"
                )

                if result.return_code == 0:
                    # Verify installations
                    if not tmux_installed:
                        verify_tmux = await self.environment.exec(
                            command="tmux -V", user="root"
                        )
                        if verify_tmux.return_code != 0:
                            self._logger.warning(
                                "tmux installation verification failed"
                            )
                            await self._build_tmux_from_source()

                    if needs_asciinema and not asciinema_installed:
                        verify_asciinema = await self.environment.exec(
                            command="asciinema --version", user="root"
                        )
                        if verify_asciinema.return_code != 0:
                            self._logger.warning(
                                "asciinema installation verification failed"
                            )
                            await self._install_asciinema_with_pip()

                    return

        # Fallback to individual installations
        if not tmux_installed:
            self._logger.warning("Installing tmux from source...")
            await self._build_tmux_from_source()

        if needs_asciinema and not asciinema_installed:
            self._logger.warning("Installing asciinema via pip...")
            await self._install_asciinema_with_pip()
```

**Non-obvious design decisions**

- It tries one combined package-manager install via `_get_combined_install_command(system_info, tools_needed)` before per-tool fallbacks. That choice favors a single remote install transaction when the platform supports it; installing each tool separately would add extra package-manager calls.
- It does not trust a zero exit code from the combined install command alone. The explicit post-install `tmux -V` and `asciinema --version` checks let it recover with targeted fallbacks for just the tool that still failed verification.
- It sets `asciinema_installed = True` when `_remote_asciinema_recording_path` is `None`. That normalization collapses the non-recording case into the same later conditionals instead of carrying a separate branch through every install decision.
- It returns immediately when both probes already succeed. That avoids constructing an empty `tools_needed` list, avoids a misleading install log, and skips unnecessary system-detection work.

**Relations**

- **Callers**: unproven from this excerpt
- **Core callees**: self.environment.exec; TmuxSession._detect_system_info; TmuxSession._get_combined_install_command; TmuxSession._build_tmux_from_source; TmuxSession._install_asciinema_with_pip
- **Config / state sources**: self._remote_asciinema_recording_path; system_info["package_manager"] from `_detect_system_info()`
- **Results to**: remote host package state for `tmux`; remote host package state for `asciinema`; subsequent tmux-related helpers that rely on external `tmux` availability; recording-related behavior that relies on external `asciinema` availability when `_remote_asciinema_recording_path` is set
- **Related siblings**: `TmuxSession._send_non_blocking_keys`, `TmuxSession._send_blocking_keys`, and `TmuxSession._tmux_send_keys` assume tmux commands can run; this helper is the prerequisite-install side of that internal support.

</details>


<details id="fn-tmuxsession_detect_system_info">
<summary><b>TmuxSession._detect_system_info</b> — tmux_session.py:153-215 · Remote OS and package-manager probe</summary>

> **Stage context**: This helper gathers basic host facts for the tmux subsystem's dependency-install path. `_attempt_tmux_installation` calls it before choosing how to install `tmux` or related tools. Within this stage, it sits below the public setup flow: unlike the sibling send-key helpers, it does not interact with tmux directly and only characterizes the remote system.

**What this code does**

`TmuxSession._detect_system_info` probes the remote machine for an OS family and the first available package manager, then returns those findings in a small dictionary. It uses `self.environment.exec(...)` to read `/etc/os-release`, run `uname -s`, and test a fixed list of package-manager binaries as `root`. The returned dict always has the keys `os`, `package_manager`, and `update_command`, with values left as `None` when detection does not succeed. The method does not mutate session state; its only side effect is a debug log through `self._logger.debug(...)`.

**Interface · params / IO**

`(self) -> dict`

- params: `self`: `?` — tmux session instance providing `environment.exec` and `_logger`
- reads: `self.environment`, `self._logger`
- returns: A `dict` with keys `os`, `package_manager`, and `update_command`; this code fills `os` and `package_manager` when it can and leaves unmatched fields as `None`.
- effects: Runs remote shell commands through `self.environment.exec(...)` as `root`; Emits one debug log with the final `system_info` dict via `self._logger.debug(...)`

**Execution flow**

1. It initializes `system_info` with `{"os": None, "package_manager": None, "update_command": None}` so the return shape stays stable even when detection fails.
2. It queries two OS-identification sources through `self.environment.exec(...)`: `cat /etc/os-release 2>/dev/null || echo 'not found'` and `uname -s`, both as `root`.
3. It scans the hard-coded `package_managers` list in priority order (`apt-get`, `dnf`, `yum`, `apk`, `pacman`, `brew`, `pkg`, `zypper`) and stores the first name whose `which <pm>` check returns code `0` in `system_info["package_manager"]`.
4. It prefers `/etc/os-release` content when that command succeeded and its `stdout` does not contain `"not found"`; it lowercases the text and maps recognizable substrings to coarse labels such as `debian-based`, `rhel-based`, `alpine`, or `arch`.
5. If `/etc/os-release` did not yield usable data, it falls back to `uname -s` and maps `darwin` to `macos` or `freebsd` to `freebsd`.
6. It logs the completed `system_info` dict and returns it to the caller.

**Source**

```python
    async def _detect_system_info(self) -> dict:
        """
        Detect the operating system and available package managers.
        """
        system_info: dict[str, str | None] = {
            "os": None,
            "package_manager": None,
            "update_command": None,
        }

        # Check for OS release files
        os_release_result = await self.environment.exec(
            command="cat /etc/os-release 2>/dev/null || echo 'not found'",
            user="root",
        )

        # Check uname for system type
        uname_result = await self.environment.exec(command="uname -s", user="root")

        # Detect package managers by checking if they exist
        package_managers = [
            "apt-get",
            "dnf",
            "yum",
            "apk",
            "pacman",
            "brew",
            "pkg",
            "zypper",
        ]

        for pm_name in package_managers:
            check_result = await self.environment.exec(
                command=f"which {pm_name} >/dev/null 2>&1", user="root"
            )
            if check_result.return_code == 0:
                system_info["package_manager"] = pm_name
                break

        # Try to determine OS from available info
        if (
            os_release_result.return_code == 0
            and os_release_result.stdout
            and "not found" not in os_release_result.stdout
        ):
            stdout_lower = os_release_result.stdout.lower()
            if "ubuntu" in stdout_lower or "debian" in stdout_lower:
                system_info["os"] = "debian-based"
            elif "fedora" in stdout_lower or "rhel" in stdout_lower:
                system_info["os"] = "rhel-based"
            elif "alpine" in stdout_lower:
                system_info["os"] = "alpine"
            elif "arch" in stdout_lower:
                system_info["os"] = "arch"
        elif uname_result.return_code == 0 and uname_result.stdout:
            stdout_lower = uname_result.stdout.lower()
            if "darwin" in stdout_lower:
                system_info["os"] = "macos"
            elif "freebsd" in stdout_lower:
                system_info["os"] = "freebsd"

        self._logger.debug(f"Detected system: {system_info}")
        return system_info
```

**Non-obvious design decisions**

- It prefers `/etc/os-release` over `uname -s` because the `if ... elif ...` structure treats release-file data as the primary source. That choice gives Linux distribution-level grouping such as `debian-based` or `rhel-based`; relying on `uname` first would collapse many Linux variants into less useful generic platform names.
- It uses a fixed package-manager priority list and stops at the first successful `which` result. That makes the result deterministic on systems that expose multiple managers, while a collect-all approach would force later code such as `_attempt_tmux_installation` to choose among several candidates.
- It returns a dict with all expected keys pre-populated to `None` instead of omitting unknown fields. That keeps downstream installation logic simple because callers can inspect `system_info["os"]` and `system_info["package_manager"]` without guarding for missing keys.

**Relations**

- **Callers**: `TmuxSession._attempt_tmux_installation`
- **Core callees**: `self.environment.exec`; `self._logger.debug`
- **Config / state sources**: `self.environment` supplies remote command execution; `self._logger` supplies debug logging; Local `package_managers` list defines package-manager detection priority
- **Results to**: Returned `system_info` dict feeds `_attempt_tmux_installation`'s dependency-install decisions; `system_info["package_manager"]` identifies which installer path the caller can attempt; `system_info["os"]` gives the caller a coarse OS-family label for installation heuristics; Debug log records the detected environment for setup diagnostics
- **Related siblings**: `TmuxSession._attempt_tmux_installation` consumes this probe result while deciding whether and how to install `tmux` and `asciinema`

</details>


<details id="fn-tmuxsession_get_combined_install_command">
<summary><b>TmuxSession._get_combined_install_command</b> — tmux_session.py:217-241 · Package-manager install command selector</summary>

> **Stage context**: This helper stays at the tmux subsystem's internal command-building layer. It turns detected package-manager info into one shell command string for installing multiple tools, alongside lower-level helpers such as `_detect_system_info` and `_attempt_tmux_installation`. Unlike the execution-oriented siblings, it only formats a command and performs no remote work.

**What this code does**

`TmuxSession._get_combined_install_command` takes `system_info` and `tools`, reads `system_info.get("package_manager")`, and returns one package-manager-specific install command string. If that value is falsy, not a `str`, or not one of the supported keys, it returns `""`. The method does not read or write instance state and has no side effects.

**Interface · params / IO**

`(self, system_info: dict, tools: list[str]) -> str`

- params: `self`: `TmuxSession` — bound session instance; unused by this method's body; `system_info`: `dict` — source of `system_info.get("package_manager")`; `tools`: `list[str]` — tool names joined into the package list string
- returns: A shell command string for the supported package manager named by `system_info.get("package_manager")`, or `""` when that value is falsy, not a string, or unsupported.

**Execution flow**

1. Read `package_manager = system_info.get("package_manager")`.
2. Guard early: if `package_manager` is falsy or `not isinstance(package_manager, str)`, return `""` before building any command.
3. Join `tools` with spaces into `packages` so one command can name every requested package.
4. Build the fixed `install_commands` mapping for `apt-get`, `dnf`, `yum`, `apk`, `pacman`, `brew`, `pkg`, and `zypper`; the `apt-get` entry uniquely uses `DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y {packages}`.
5. Return `install_commands.get(package_manager, "")`, which yields the selected command for a supported key or `""` for an unsupported string.

**Source**

```python
    def _get_combined_install_command(self, system_info: dict, tools: list[str]) -> str:
        """
        Get the appropriate installation command for multiple tools based on system info.
        """
        package_manager = system_info.get("package_manager")

        if not package_manager or not isinstance(package_manager, str):
            return ""

        # Build the package list
        packages = " ".join(tools)

        # Package manager commands with non-interactive flags
        install_commands = {
            "apt-get": f"DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y {packages}",
            "dnf": f"dnf install -y {packages}",
            "yum": f"yum install -y {packages}",
            "apk": f"apk add --no-cache {packages}",
            "pacman": f"pacman -S --noconfirm {packages}",
            "brew": f"brew install {packages}",
            "pkg": f"ASSUME_ALWAYS_YES=yes pkg install -y {packages}",
            "zypper": f"zypper install -y -n {packages}",
        }

        return install_commands.get(package_manager, "")
```

**Non-obvious design decisions**

- It returns `""` for both invalid and unsupported `package_manager` values. That gives callers one sentinel for 'no usable combined command' instead of raising or splitting error cases.
- It centralizes package-manager differences in one literal `install_commands` dictionary. That keeps the supported set explicit in code and avoids scattered conditional formatting.
- It embeds non-interactive flags directly in each template, such as `-y`, `--noconfirm`, `--no-cache`, `ASSUME_ALWAYS_YES=yes`, and `-n`. This choice makes the returned command ready for unattended use rather than requiring callers to know per-manager flags.
- It gives `apt-get` a special `update && install` template instead of treating it like the other managers. The code makes that package-manager-specific prerequisite explicit at command construction time.

**Relations**

- **Callers**: `TmuxSession._attempt_tmux_installation`
- **Core callees**: `system_info.get`; `isinstance`; " ".join; `dict.get` on `install_commands`
- **Config / state sources**: `system_info.get("package_manager")`; `tools`
- **Results to**: Returned command string consumed by the direct caller; Empty-string sentinel for unsupported or invalid package-manager input
- **Related siblings**: `TmuxSession._detect_system_info` supplies the package-manager field this helper reads.; `TmuxSession._attempt_tmux_installation` is the sibling that decides whether to use the returned command.

</details>


<details id="fn-tmuxsession_build_tmux_from_source">
<summary><b>TmuxSession._build_tmux_from_source</b> — tmux_session.py:243-285 · source-build fallback for tmux installation</summary>

> **Stage context**: This helper sits at the bottom of the tmux installation path and handles the last-resort case where normal package-based installation did not yield a usable `tmux` binary. It is invoked from the fallback branch of `TmuxSession._attempt_tmux_installation`. Within this stage, it complements sibling helpers such as `TmuxSession._detect_system_info` and `TmuxSession._get_combined_install_command`: those helpers try to install via package managers, while this method bypasses that flow and compiles tmux directly.

**What this code does**

`TmuxSession._build_tmux_from_source` tries to install build prerequisites, download the hardcoded tmux 3.4 release tarball, compile it under `/tmp`, install it to `/usr/local`, and then verify that a `tmux` binary runs. It takes no explicit arguments beyond `self` and returns `None`. The real outputs are remote shell actions executed through `self.environment.exec(...)` as `root` and status/error logs emitted through `self._logger`.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `TmuxSession` — session object providing `environment` and `_logger`
- reads: `self.environment`, `self._logger`
- returns: Returns `None`; its real product is a best-effort remote source build and a verification attempt for `tmux`.
- effects: Runs multiple remote shell commands through `self.environment.exec(...)` as `root`; May update package indexes and install build dependencies on the remote machine; Downloads `tmux-3.4.tar.gz` into `/tmp` on the remote machine; Builds and installs tmux from source with `./configure --prefix=/usr/local`, `make`, and `make install`; Emits debug or error logs through `self._logger`

**Execution flow**

1. It enters a broad `try` block and prepares `dep_commands`, a fixed list of distro-specific shell commands for `apt-get`, `yum`, `dnf`, and `apk` that install compilers, headers, and `curl`.
2. It loops over `dep_commands` and runs each one with `await self.environment.exec(command=cmd, user="root")`, stopping at the first command whose `result.return_code` is `0`.
3. It assembles one `build_cmd` string that changes into `/tmp`, downloads the hardcoded tmux 3.4 tarball from GitHub, extracts it, enters `tmux-3.4`, configures with `--prefix=/usr/local`, then runs `make` and `make install`.
4. It executes `build_cmd` as `root` with `self.environment.exec(...)`; the method does not inspect that command's return code before moving on.
5. It verifies installation by running `tmux -V || /usr/local/bin/tmux -V` as `root` and checks `verify_result.return_code`.
6. If verification succeeds, it logs a debug message that source installation worked; otherwise it logs an error that installation from source failed. If any exception escapes the command calls or string handling, the `except Exception as e` block logs that build-from-source failed, including the exception text.

**Source**

```python
    async def _build_tmux_from_source(self) -> None:
        """
        Build tmux from source as a fallback option.
        """
        try:
            # Install build dependencies based on detected system - with non-interactive flags
            dep_commands = [
                "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential libevent-dev libncurses5-dev curl",
                "yum groupinstall -y 'Development Tools' && yum install -y libevent-devel ncurses-devel curl",
                "dnf groupinstall -y 'Development Tools' && dnf install -y libevent-devel ncurses-devel curl",
                "apk add --no-cache build-base libevent-dev ncurses-dev curl",
            ]

            # Try to install build dependencies
            for cmd in dep_commands:
                result = await self.environment.exec(command=cmd, user="root")
                if result.return_code == 0:
                    break

            # Download and build tmux
            build_cmd = (
                "cd /tmp && "
                "curl -L https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz -o tmux.tar.gz && "
                "tar -xzf tmux.tar.gz && "
                "cd tmux-3.4 && "
                "./configure --prefix=/usr/local && "
                "make && "
                "make install"
            )

            result = await self.environment.exec(command=build_cmd, user="root")

            # Verify installation
            verify_result = await self.environment.exec(
                command="tmux -V || /usr/local/bin/tmux -V", user="root"
            )
            if verify_result.return_code == 0:
                self._logger.debug("tmux successfully built and installed from source")
            else:
                self._logger.error("Failed to install tmux from source")

        except Exception as e:
            self._logger.error(f"Failed to build tmux from source: {e}")
```

**Non-obvious design decisions**

- It uses a best-effort dependency loop over `dep_commands` instead of first reusing detected package-manager metadata. That choice lets the source-build fallback stay self-contained, but it also means the method accepts the first working package command silently and does not report which dependency path it used.
- It hardcodes the download URL, extracted directory name, and `./configure --prefix=/usr/local` in `build_cmd`. This keeps the fallback deterministic, but it trades away version configurability and assumes the remote build environment matches tmux 3.4's build requirements.
- It treats verification as the success criterion, not the `build_cmd` return code. That makes sense for a recovery path because a usable `tmux` binary is what matters, but it also means the method can proceed past a failed build command and only surface failure at the final `tmux -V || /usr/local/bin/tmux -V` check.
- It catches `Exception` broadly and only logs the error. This prevents a last-resort installation attempt from crashing the caller, but the trade-off is that callers receive no structured failure signal beyond the absence of a successful verification log.

**Relations**

- **Callers**: TmuxSession._attempt_tmux_installation
- **Core callees**: self.environment.exec; self._logger.debug; self._logger.error
- **Config / state sources**: `self.environment` supplies remote command execution; `self._logger` records success and failure messages
- **Results to**: remote machine package/build state; caller-visible availability of `tmux` for later tmux session setup; installation fallback outcome within `TmuxSession._attempt_tmux_installation`; debug/error logs consumed by operators or test diagnostics
- **Related siblings**: TmuxSession._attempt_tmux_installation; TmuxSession._detect_system_info; TmuxSession._get_combined_install_command

</details>


<details id="fn-tmuxsession_install_asciinema_with_pip">
<summary><b>TmuxSession._install_asciinema_with_pip</b> — tmux_session.py:287-323 · Fallback pip-based asciinema installer</summary>

> **Stage context**: This helper covers one narrow fallback path inside the tmux setup internals: getting `asciinema` onto the remote machine when package-manager installation did not already solve it. `_attempt_tmux_installation` invokes it as a last-resort installer for the recording tool, alongside sibling helpers that detect the system, choose package-manager commands, and build tmux from source when needed. It stays at the implementation-detail layer because it only executes remote install commands and reports success or failure through logs.

**What this code does**

`TmuxSession._install_asciinema_with_pip` tries to provision `python3-pip`, then install `asciinema` with either `pip3` or `pip`, and finally confirms that `asciinema --version` runs. It takes no explicit arguments beyond `self` and returns `None`. The method does not change stored session fields; its real effects are remote commands run through `self.environment.exec(...)` as `root` and status/error messages emitted through `self._logger`.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `TmuxSession` — session helper context that provides `environment` and `_logger`
- reads: `self.environment`, `self._logger`
- returns: Returns `None`; the real product is a best-effort remote installation attempt plus debug/error logging.
- effects: runs multiple remote shell commands through `self.environment.exec(...)`; runs all install and verification commands as `user="root"`; logs success with `self._logger.debug(...)`; logs failure paths and caught exceptions with `self._logger.error(...)`

**Execution flow**

1. Build a fixed `pip_install_commands` list with distro-specific commands for installing `python3-pip` or equivalent.
2. Run those `pip_install_commands` one by one through `self.environment.exec(command=cmd, user="root")` and stop that loop after the first command whose `result.return_code` is `0`.
3. Build `pip_commands` as `"pip3 install asciinema"` and `"pip install asciinema"`, then try them in order with the same remote executor.
4. After any pip install command succeeds, run `asciinema --version` as `root`; if `verify_result.return_code` is `0`, log a debug success message and return immediately.
5. If no pip command leads to a successful verification, log `"Failed to install asciinema using pip"`.
6. Wrap the whole sequence in `try/except`; if any exception escapes the command attempts, catch it and log `"Failed to install asciinema with pip: {e}"` instead of re-raising.

**Source**

```python
    async def _install_asciinema_with_pip(self) -> None:
        """
        Install asciinema using pip as a fallback.
        """
        try:
            # Try to install python3-pip first - with non-interactive flags
            pip_install_commands = [
                "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pip",
                "yum install -y python3-pip",
                "dnf install -y python3-pip",
                "apk add --no-cache python3 py3-pip",
            ]

            # Try to install pip
            for cmd in pip_install_commands:
                result = await self.environment.exec(command=cmd, user="root")
                if result.return_code == 0:
                    break

            # Install asciinema using pip
            pip_commands = ["pip3 install asciinema", "pip install asciinema"]

            for cmd in pip_commands:
                result = await self.environment.exec(command=cmd, user="root")
                if result.return_code == 0:
                    # Verify installation
                    verify_result = await self.environment.exec(
                        command="asciinema --version", user="root"
                    )
                    if verify_result.return_code == 0:
                        self._logger.debug("asciinema successfully installed using pip")
                        return

            self._logger.error("Failed to install asciinema using pip")

        except Exception as e:
            self._logger.error(f"Failed to install asciinema with pip: {e}")
```

**Non-obvious design decisions**

- It uses a multi-command fallback list in `pip_install_commands` and `pip_commands` because the code needs to survive different Linux families and different pip executable names. A single hardcoded installer would be shorter, but it would fail on systems that use another package manager or expose only `pip` or only `pip3`.
- It verifies with `asciinema --version` after a nominally successful pip install because a zero exit from `pip install asciinema` does not guarantee that the `asciinema` executable is actually runnable in the target environment. Skipping verification would make the helper report success too early.
- It catches broad `Exception` and converts it into an error log because this helper is a best-effort fallback under `_attempt_tmux_installation`, not the primary control path. Propagating every exception would make the larger installation routine more brittle when one fallback command crashes or the remote executor raises.

**Relations**

- **Callers**: `TmuxSession._attempt_tmux_installation`
- **Core callees**: `self.environment.exec`; `self._logger.debug`; `self._logger.error`
- **Config / state sources**: `self.environment` provides remote command execution; `self._logger` provides status/error reporting; hardcoded `pip_install_commands` sequence; hardcoded `pip_commands` sequence
- **Results to**: remote machine package state may gain `python3-pip`; remote machine Python environment may gain `asciinema`; `_attempt_tmux_installation` continues after this helper returns; logs document whether the pip fallback succeeded or failed
- **Related siblings**: `TmuxSession._attempt_tmux_installation` decides when to use this fallback; `TmuxSession._detect_system_info` handles package-manager probing for the primary install path; `TmuxSession._get_combined_install_command` builds package-manager install commands for the non-pip path; `TmuxSession._build_tmux_from_source` is a separate last-resort installer for tmux itself

</details>


<details id="fn-tmuxsession_tmux_start_session">
<summary><b>TmuxSession._tmux_start_session</b> — tmux_session.py:325-339 · Build detached tmux session launch command</summary>

> **Stage context**: This helper sits in the tmux-internal stage as the string builder for session creation. `TmuxSession.start` uses it when startup needs the exact remote shell command that creates the tmux session and begins logging pane output. Compared with siblings such as `_tmux_send_keys`, which build later interaction commands, this method only prepares the initial `tmux new-session` invocation.

**What this code does**

`TmuxSession._tmux_start_session` builds and returns one shell command string that exports fixed terminal defaults, starts a detached tmux session, and attaches pane-output logging. It reads `self._extra_env`, `self._pane_width`, `self._pane_height`, `self._session_name`, and `self._logging_path`. The method does not mutate instance state and does not execute the command itself.

**Interface · params / IO**

`(self) -> str`

- params: `self`: `TmuxSession` — Session object that supplies tmux launch settings
- reads: `self._extra_env`, `self._pane_width`, `self._pane_height`, `self._session_name`, `self._logging_path`
- returns: One shell command string that exports `TERM` and `SHELL`, runs `tmux new-session` with optional `-e KEY=value` entries, fixed pane dimensions, detached session name, and a `pipe-pane` clause that writes pane output to `self._logging_path`.
- effects: none

**Execution flow**

1. It formats `self._extra_env.items()` into one `env_options` string, emitting one `-e <quoted KEY=value>` fragment per pair and shell-quoting each combined assignment with `shlex.quote(...)`.
2. It prefixes the final command with `export TERM=xterm-256color && export SHELL=/bin/bash &&` to force those two environment values in the launching shell.
3. It inserts `env_options`, `self._pane_width`, `self._pane_height`, and `self._session_name` into a detached `tmux new-session ... -d -s <session> 'bash --login'` command.
4. It appends `\; pipe-pane -t <session> 'cat > <logging_path>'` so tmux pipes pane output for that session into `self._logging_path`.
5. It returns the assembled command string without running it.

**Source**

```python
    def _tmux_start_session(self) -> str:
        # Build environment variable options for tmux new-session -e KEY=value
        env_options = "".join(
            f"-e {shlex.quote(f'{key}={value}')} "
            for key, value in self._extra_env.items()
        )

        return (
            f"export TERM=xterm-256color && "
            f"export SHELL=/bin/bash && "
            f"tmux new-session {env_options}-x {self._pane_width} -y {self._pane_height} -d -s {self._session_name} 'bash --login' \\; "
            f"pipe-pane -t {self._session_name} "
            f"'cat > {self._logging_path}'"
        )
```

**Non-obvious design decisions**

- It quotes each combined `KEY=value` item with `shlex.quote(...)` before placing it after `-e`. That choice protects values in `self._extra_env` from shell parsing issues; emitting raw `KEY=value` text would make spaces or shell metacharacters in values unsafe.
- It hard-codes `TERM=xterm-256color` and `SHELL=/bin/bash` in the command prefix instead of relying on the remote process environment. That makes session startup more predictable for the login shell and tmux terminal behavior, at the cost of less flexibility.
- It adds `pipe-pane` directly to the startup command rather than leaving logging as a separate later step. That couples session creation with output capture so logging starts immediately, which avoids losing early pane output between creation and a follow-up command.

**Relations**

- **Callers**: `TmuxSession.start` during tmux session startup; Internal tmux setup flow that prepares the remote terminal environment
- **Core callees**: `shlex.quote` for each `KEY=value` environment assignment
- **Config / state sources**: `self._extra_env` for injected tmux environment variables; `self._pane_width` for `tmux new-session -x`; `self._pane_height` for `tmux new-session -y`; `self._session_name` for session target and `pipe-pane -t`; `self._logging_path` for pane output destination
- **Results to**: Returned command string to the tmux startup path for execution on the remote shell; Creation of the detached tmux session named by `self._session_name` once a caller executes it; Persistent pane-output capture to `self._logging_path` once a caller executes it
- **Related siblings**: `TmuxSession._tmux_send_keys` builds later `tmux send-keys` command strings against the same session name; `TmuxSession._attempt_tmux_installation` handles tool availability before startup can succeed

</details>


<details id="fn-tmuxsession_tmux_capture_pane">
<summary><b>TmuxSession._tmux_capture_pane</b> — tmux_session.py:412-427 · tmux pane capture command builder</summary>

> **Stage context**: This helper belongs to the tmux subsystem's internal command builders. Higher-level capture logic calls it when it needs a shell command that reads pane text from the active tmux session, while this method keeps the tmux CLI details local to one place. It pairs with `_tmux_start_session`, which builds the session-start command, but unlike that sibling it targets later observation of an already-running session.

**What this code does**

`TmuxSession._tmux_capture_pane` builds and returns one `tmux capture-pane` shell command string. It takes `capture_entire` to choose between visible-pane capture and full-scrollback capture, and it reads `self._session_name` to target the current tmux session. The method returns only the command text; it does not execute tmux, mutate instance state, or perform I/O.

**Interface · params / IO**

`(self, capture_entire: bool = False) -> str`

- params: `capture_entire`: `bool` — Selects whether to include full pane history instead of only the current visible pane.
- reads: `self._session_name`
- returns: A single shell command string of the form `tmux capture-pane -p ... -t <session>`.

**Execution flow**

1. It checks `capture_entire` and chooses `extra_args = ["-S", "-"]` when full-history capture is requested, or `extra_args = []` otherwise.
2. It assembles a command token list starting with `"tmux"`, `"capture-pane"`, and `"-p"`, inserts any `extra_args`, then appends `"-t"` and `self._session_name` as the tmux target.
3. It joins those tokens with spaces and returns the finished command string.

**Source**

```python
    def _tmux_capture_pane(self, capture_entire: bool = False) -> str:
        if capture_entire:
            extra_args = ["-S", "-"]
        else:
            extra_args = []

        return " ".join(
            [
                "tmux",
                "capture-pane",
                "-p",
                *extra_args,
                "-t",
                self._session_name,
            ]
        )
```

**Non-obvious design decisions**

- The branch hides the tmux-specific full-history switch behind `capture_entire`. Callers only choose a boolean, while this helper owns the less obvious `-S -` detail.
- The command always includes `-p`, so the helper produces a stdout-oriented capture command rather than a command that writes into a tmux buffer. That keeps the result usable by higher-level code that wants to read pane text directly.
- It returns a shell string instead of executing tmux itself. That keeps this method aligned with other low-level builders in this stage, such as `_tmux_start_session`, and leaves execution policy to the caller.

**Relations**

- **Callers**: `TmuxSession.capture_pane`
- **Core callees**: `str.join`
- **Config / state sources**: `self._session_name`
- **Results to**: The caller's tmux command execution step that actually runs the returned shell string; `TmuxSession.capture_pane` response assembly
- **Related siblings**: `TmuxSession._tmux_start_session` also returns a tmux shell command string without executing it

</details>


<details id="fn-tmuxsession_get_incremental_output">
<summary><b>TmuxSession.get_incremental_output</b> — tmux_session.py:675-710 · Incremental tmux output snapshot with screen fallback</summary>

> **Stage context**: This helper sits in the tmux internal-helper stage and turns pane captures into a caller-facing terminal text block. It works alongside lower-level tmux capture helpers such as `TmuxSession._tmux_capture_pane`, but unlike those command builders it performs async capture, diffing, and `_previous_buffer` state updates.

**What this code does**

`TmuxSession.get_incremental_output` captures the pane's full buffer, compares it against the stored `_previous_buffer`, and returns one labeled string. On the first call, it stores the full buffer and always returns `Current Terminal Screen:` with `_get_visible_screen()`. On later calls, it stores the new full buffer and returns either `New Terminal Output:` with `_find_new_content(...)`, or `Current Terminal Screen:` when the diff is empty/whitespace-only or when `_find_new_content(...)` returns `None`.

**Interface · params / IO**

`(self) -> str`

- params: `self`: `?` — tmux session object providing capture, diff, visible-screen, and `_previous_buffer` state
- reads: `self._previous_buffer`, `self.capture_pane(capture_entire=True)`, `self._find_new_content(current_buffer)`, `self._get_visible_screen()`
- returns: A formatted `str`. First invocation always returns `Current Terminal Screen:\n{visible_screen}` after saving the first full-buffer snapshot. Later invocations return `New Terminal Output:\n{new_content}` when `_find_new_content(current_buffer)` returns a non-empty, non-whitespace string; otherwise they return `Current Terminal Screen:\n{visible_screen}`.
- effects: writes `self._previous_buffer = current_buffer` on every path after `capture_pane(...)` succeeds; awaits pane-capture and screen/diff helpers

**Execution flow**

1. Await `self.capture_pane(capture_entire=True)` and keep the result in `current_buffer`.
2. If `self._previous_buffer is None`, save `current_buffer` into `_previous_buffer`, await `self._get_visible_screen()`, and return it under the `Current Terminal Screen:` label.
3. Otherwise, await `self._find_new_content(current_buffer)` to compare the new full buffer against the previously stored one.
4. Assign `self._previous_buffer = current_buffer` before choosing the return branch, so the next call compares against this latest full-buffer snapshot.
5. If `new_content is not None` and `new_content.strip()` is non-empty, return `New Terminal Output:` with that diff text.
6. If `new_content is not None` but `new_content.strip()` is empty, await `self._get_visible_screen()` and return the current screen instead of an empty diff.
7. If `new_content is None`, await `self._get_visible_screen()` and return the current screen because this branch treats the diff as unavailable.

**Source**

```python
    async def get_incremental_output(self) -> str:
        """
        Get either new terminal output since last call, or current screen if
        unable to determine.

        This method tracks the previous buffer state and attempts to find new content
        by comparing against the current full buffer. This provides better handling for
        commands with large output that would overflow the visible screen.

        Returns:
            str: Formatted output with either "New Terminal Output:" or
                 "Current Terminal Screen:"
        """
        current_buffer = await self.capture_pane(capture_entire=True)

        # First capture - no previous state
        if self._previous_buffer is None:
            self._previous_buffer = current_buffer
            visible_screen = await self._get_visible_screen()
            return f"Current Terminal Screen:\n{visible_screen}"

        # Try to find new content
        new_content = await self._find_new_content(current_buffer)

        # Update state
        self._previous_buffer = current_buffer

        if new_content is not None:
            if new_content.strip():
                return f"New Terminal Output:\n{new_content}"
            else:
                # No new content, show current screen
                return f"Current Terminal Screen:\n{await self._get_visible_screen()}"
        else:
            # Couldn't reliably determine new content, fall back to current screen
            return f"Current Terminal Screen:\n{await self._get_visible_screen()}"
```

**Non-obvious design decisions**

- The function treats `self._previous_buffer is None` as a special first-capture case and returns the visible screen, not the full captured buffer. That avoids presenting a first diff when no earlier baseline exists.
- It separates `new_content is None` from `new_content.strip()` being empty. The code preserves a distinction between an unavailable diff result and a diff result that contains no visible new text, even though both branches fall back to `Current Terminal Screen:`.
- It updates `_previous_buffer` immediately after `_find_new_content(current_buffer)` returns, before either fallback branch. Because of that assignment order, even a whitespace-only diff or `None` diff still advances the comparison baseline for the next call.
- It uses the full pane capture via `capture_pane(capture_entire=True)` for comparison, then uses `_get_visible_screen()` only for returned fallbacks. That keeps diffing based on more than the visible screen while still returning a compact screen snapshot when incremental output is not usable.

**Relations**

- **Callers**: unknown caller that awaits `TmuxSession.get_incremental_output()` for a formatted terminal text block
- **Core callees**: `TmuxSession.capture_pane(capture_entire=True)`; `TmuxSession._find_new_content(current_buffer)`; `TmuxSession._get_visible_screen()`
- **Config / state sources**: `self._previous_buffer` baseline state; `current_buffer` produced from `capture_pane(capture_entire=True)`; `new_content` produced from `_find_new_content(current_buffer)`
- **Results to**: the awaiting caller as one labeled `str`; `self._previous_buffer` for the next incremental comparison
- **Related siblings**: `TmuxSession._tmux_capture_pane` builds the tmux capture command that underlies pane capture behavior

</details>


<details id="fn-tmuxsession_find_new_content">
<summary><b>TmuxSession._find_new_content</b> — tmux_session.py:665-673 · Heuristic tmux buffer suffix extractor</summary>

> **Stage context**: This helper supports incremental tmux output tracking inside the internal tmux subsystem. `TmuxSession.get_incremental_output` calls it after a fresh full-buffer capture to decide whether the new capture extends the prior `_previous_buffer` snapshot. It complements `TmuxSession._tmux_capture_pane`, which obtains the raw pane text, and feeds its result back into `TmuxSession.get_incremental_output` for user-facing terminal updates.

**What this code does**

`TmuxSession._find_new_content` inspects `current_buffer` against the stored `self._previous_buffer` and returns a suffix of `current_buffer` when the prior snapshot appears inside the new capture. It treats a missing prior buffer as `""` and trims surrounding whitespace from the stored snapshot before matching. When it cannot find the prior snapshot in `current_buffer`, it returns `None`. The method does not mutate instance state and performs no I/O.

**Interface · params / IO**

`(self, current_buffer: str) -> str | None`

- params: `current_buffer`: `str` — freshly captured tmux pane buffer to compare against the stored prior snapshot
- reads: `self._previous_buffer`
- returns: A `str` slice from `current_buffer` treated as newly visible content, or `None` when the previous snapshot is not found in the current buffer.

**Execution flow**

1. Load the prior snapshot from `self._previous_buffer`, substitute `""` when it is `None`, and normalize the stored value with `.strip()` into `pb`.
2. Check whether the normalized prior content `pb` appears anywhere in `current_buffer` with `if pb in current_buffer:`.
3. When containment succeeds, compute a starting index from the match position in `current_buffer`, but replace that index with `pb.rfind("\n")` when `pb` contains a newline.
4. Return `current_buffer[idx:]` as the suffix to report; otherwise return `None` when no containment match exists.

**Source**

```python
    async def _find_new_content(self, current_buffer: str) -> str | None:
        pb = "" if self._previous_buffer is None else self._previous_buffer.strip()
        if pb in current_buffer:
            idx = current_buffer.index(pb)
            # Find the end of the previous buffer content
            if "\n" in pb:
                idx = pb.rfind("\n")
            return current_buffer[idx:]
        return None
```

**Non-obvious design decisions**

- It uses substring containment on `pb` instead of a real diff algorithm. That keeps the helper cheap and simple for repeated pane captures in `TmuxSession.get_incremental_output`, but it can only recognize extension-like cases where the old buffer still appears in the new one.
- It calls `.strip()` on `self._previous_buffer` before matching. This makes the comparison less sensitive to leading or trailing whitespace drift between captures, but it also means the match no longer preserves exact buffer boundaries.
- It special-cases multiline `pb` by switching to `pb.rfind("\n")` before slicing `current_buffer`. That favors returning content from the last prior line break onward rather than trying to compute the minimal exact delta, which is a coarse but simple heuristic.

**Relations**

- **Callers**: `TmuxSession.get_incremental_output`
- **Core callees**: `str.strip` on `self._previous_buffer`; substring containment check `pb in current_buffer`; `current_buffer.index(pb)`; `pb.rfind("\n")`
- **Config / state sources**: `self._previous_buffer` provides the prior captured pane buffer
- **Results to**: `TmuxSession.get_incremental_output` uses the returned suffix to build `New Terminal Output:`; `TmuxSession.get_incremental_output` falls back to `Current Terminal Screen:` when this returns `None`; incremental terminal-output reporting for the tmux session; downstream user-visible execution updates derived from pane captures
- **Related siblings**: `TmuxSession.get_incremental_output` stores `_previous_buffer` and decides whether to call this helper; `TmuxSession._tmux_capture_pane` builds the tmux command that produces the buffers compared here

</details>


<details id="fn-tmuxsession_get_visible_screen">
<summary><b>TmuxSession._get_visible_screen</b> — tmux_session.py:662-663 · Async wrapper for visible tmux pane capture</summary>

> **Stage context**: This helper sits in the tmux internal-helper stage as a tiny async convenience method. It gives the subsystem one named entry point for the visible screen by forwarding to `capture_pane(capture_entire=False)`. Unlike `_tmux_capture_pane`, which builds a shell command string, this method awaits a higher-level capture method and returns its text result.

**What this code does**

`TmuxSession._get_visible_screen` is an async wrapper that callers must `await`. It asks `self.capture_pane(...)` for pane contents with `capture_entire=False` and returns that string unchanged. The method does not read or write any `self._` fields itself. Any actual capture I/O happens inside `capture_pane`, not in this wrapper body.

**Interface · params / IO**

`(self) -> str`

- params: `self`: `?` — bound `TmuxSession` instance that exposes `capture_pane`
- returns: A screen-text `str` produced by awaiting `self.capture_pane(capture_entire=False)`.
- effects: none in this wrapper itself; it delegates any I/O to `capture_pane`

**Execution flow**

1. Await `self.capture_pane(...)` with the fixed argument `capture_entire=False`.
2. Return the awaited result unchanged as the method's `str` output.

**Source**

```python
    async def _get_visible_screen(self) -> str:
        return await self.capture_pane(capture_entire=False)
```

**Non-obvious design decisions**

- The method hard-codes `capture_entire=False` instead of exposing that flag at this level. That keeps the visible-screen request distinct from broader pane capture in the call site.
- This wrapper adds no local processing around `capture_pane`. It preserves the delegated method's return value directly, which avoids duplicating capture logic here.

**Relations**

- **Callers**: `TmuxSession.get_incremental_output`
- **Core callees**: `self.capture_pane`
- **Config / state sources**: Fixed literal argument `capture_entire=False`
- **Results to**: Returned directly to the awaiting caller as visible screen text
- **Related siblings**: `TmuxSession._tmux_capture_pane` builds the lower-level tmux shell command for pane capture.; `TmuxSession.get_incremental_output` uses `_get_visible_screen()` when it needs the current on-screen view.

</details>
