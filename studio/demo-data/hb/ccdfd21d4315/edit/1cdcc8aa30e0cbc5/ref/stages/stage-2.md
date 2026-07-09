## 2 · Environment Setup

#### (a) Opening Explanation

This stage exists to turn a configured trial into a live terminal the agent can actually use. Upstream, the agent already knows its fixed settings: pane size, extra environment variables, default user, and whether terminal recording should be enabled. But none of that matters until there is a real shell running inside the trial environment. That is the job here.

Environment Setup owns one thing: creating and starting the tmux session (a terminal you can drive remotely) that the rest of the agent will talk to. It sits between static setup and active execution. Without it, the next stage would have plans and prompts but no terminal to observe, type into, or record.

#### (b) Main Flow

1. `Terminus2.setup()` (prepare this trial’s live terminal) is called once for the trial.
   - Its purpose is not to make decisions.
   - Its job is to bind the agent to the specific `environment` it was given for this run.

2. Inside that, `TmuxSession.__init__()` (create a remote-controlled terminal wrapper) is used to package together:
   - the target trial environment
   - terminal size
   - extra environment variables
   - default user
   - optional asciinema recording paths  
     Asciinema is a terminal recording format, so this is where recording gets attached if the trial asked for it.

3. Then `TmuxSession.start()` (actually launch the terminal session) makes that wrapper real.
   - This is the moment the agent goes from “configured” to “able to interact.”
   - After this, later stages can send commands, read screen output, and treat the terminal as the agent’s workspace.

4. This stage stops there on purpose.
   - It does not run the task.
   - It does not inspect output.
   - It only guarantees: when `run()` begins, a usable terminal already exists.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: 无
- reads: 无
- clears: 无
- triggers downstream: `stage-3 Run Onset` — after the tmux session has been created and started successfully

#### (d) Pipeline Hand-Off

Upstream gives this stage frozen configuration from stage-1 plus the concrete trial environment selected by the Harbor orchestrator. This stage produces a live tmux-backed terminal session, which stage-3 can immediately enter and use as the execution surface for the agent loop.

<details id="fn-terminus2_setup">
<summary><b>Terminus2.setup</b> — terminus_2.py:355-374 · Initialize and start the trial tmux session</summary>

> **Stage context**: This stage creates the terminal session that the rest of the trial will use. `Terminus2.setup` runs once per trial after the Harbor orchestrator has provided a concrete `environment` and before `run()` begins. In this stage, it is the entry point that materializes constructor-time terminal settings into a live `TmuxSession` bound to the trial paths.

**What this code does**

`Terminus2.setup` builds a `TmuxSession` for the supplied `environment`, optionally wiring in asciinema recording paths when `_record_terminal_session` is enabled. It reads terminal sizing and environment configuration from instance state, stores the created session in `self._session`, and then starts that session asynchronously. The method returns `None`; its real product is a running tmux-backed terminal bound to the trial environment.

**Interface · params / IO**

`(self, environment: BaseEnvironment) -> None`

- params: `self`: `?` — The `Terminus2` instance that owns configuration and receives the created session.; `environment`: `BaseEnvironment` — The trial environment that provides `trial_paths` and `default_user` for the session.
- reads: `self._record_terminal_session`, `self._tmux_pane_width`, `self._tmux_pane_height`, `self._extra_env`
- returns: Returns `None`; it writes `self._session` and starts the tmux session.
- effects: Writes `self._session` with a new `TmuxSession` instance; Starts the session by awaiting `self._session.start()`; Uses `environment.trial_paths.agent_dir` to choose a local recording destination when recording is enabled

**Execution flow**

1. Check `self._record_terminal_session` to decide whether to derive asciinema paths or leave both recording path arguments as `None`.
2. When recording is enabled, build `local_recording_path` from `environment.trial_paths.agent_dir / "recording.cast"` and `remote_recording_path` from `EnvironmentPaths.agent_dir / "recording.cast"`.
3. Create `TmuxSession(...)` with the session name from `self.name()`, the provided `environment`, a fixed pane log path at `EnvironmentPaths.agent_dir / "terminus_2.pane"`, the two recording-path arguments, pane dimensions from `self._tmux_pane_width` and `self._tmux_pane_height`, extra environment from `self._extra_env`, and the user from `environment.default_user`.
4. Store that `TmuxSession` in `self._session` and await `self._session.start()` so the terminal is live before later stages use it.

**Source**

```python
    async def setup(self, environment: BaseEnvironment) -> None:
        if self._record_terminal_session:
            local_recording_path = environment.trial_paths.agent_dir / "recording.cast"
            remote_recording_path = EnvironmentPaths.agent_dir / "recording.cast"
        else:
            local_recording_path = None
            remote_recording_path = None

        self._session = TmuxSession(
            session_name=self.name(),
            environment=environment,
            logging_path=EnvironmentPaths.agent_dir / "terminus_2.pane",
            local_asciinema_recording_path=local_recording_path,
            remote_asciinema_recording_path=remote_recording_path,
            pane_width=self._tmux_pane_width,
            pane_height=self._tmux_pane_height,
            extra_env=self._extra_env,
            user=environment.default_user,
        )
        await self._session.start()
```

**Non-obvious design decisions**

- It always constructs `TmuxSession` with `local_asciinema_recording_path` and `remote_asciinema_recording_path`, and disables recording by passing `None` for both. This keeps session construction on one path instead of splitting into separate constructor call shapes.
- It derives two recording paths from different roots: `environment.trial_paths.agent_dir` for the local artifact location and `EnvironmentPaths.agent_dir` for the in-environment location. That separation lets the session know both where the cast should exist inside the environment and where the harness expects to collect it outside.
- It takes the session user from `environment.default_user` instead of a cached self field. That choice binds the shell identity to the concrete trial environment, while pane size and `extra_env` stay fixed from constructor configuration.

**Relations**

- **Callers**: Harbor-orchestrated trial setup flow that invokes `Terminus2.setup(environment)` before `run()`
- **Core callees**: `TmuxSession`; `TmuxSession.start`; `self.name`
- **Config / state sources**: `self._record_terminal_session`; `self._tmux_pane_width`; `self._tmux_pane_height`; `self._extra_env`; `environment.trial_paths.agent_dir`; `environment.default_user`; `EnvironmentPaths.agent_dir`
- **Results to**: `self._session` for later trial interaction; the live tmux terminal used by later `run()` logic; optional asciinema output at `recording.cast`; pane log output at `EnvironmentPaths.agent_dir / "terminus_2.pane"`

</details>


<details id="fn-tmuxsession_init">
<summary><b>TmuxSession.__init__</b> — tmux_session.py:28-57 · Initialize tmux session configuration and recording state</summary>

> **Stage context**: This constructor prepares the `TmuxSession` object that stage-2 will later start for a trial environment. `Terminus2.setup` invokes it while assembling the session described in the sibling entry, then hands the initialized object off to `TmuxSession.start`. In this stage, its job is to freeze session configuration, validate pane sizing, and seed bookkeeping fields needed by later setup and teardown paths.

**What this code does**

`TmuxSession.__init__` captures the session name, bound `environment`, logging and optional asciinema paths, pane size, extra environment variables, and optional `user` into instance state. It validates `pane_width` and `pane_height` by coercing them through `int(...)` and rejecting non-positive values with `ValueError`. It returns `None`; the real result is a fully initialized `TmuxSession` object with recording flags, marker storage, and buffer cache set to known defaults.

**Interface · params / IO**

`(self, session_name: str, environment: BaseEnvironment, logging_path: Path | PurePosixPath, local_asciinema_recording_path: Path | None, remote_asciinema_recording_path: Path | PurePosixPath | None, pane_width: int = 160, pane_height: int = 40, extra_env: dict[str, str] | None = None, user: str | int | None = None)`

- params: `session_name`: `str` — tmux session identifier stored in `_session_name`; `environment`: `BaseEnvironment` — trial environment bound to `self.environment`; `logging_path`: `Path | PurePosixPath` — path for terminal logging stored in `_logging_path`; `local_asciinema_recording_path`: `Path | None` — host-side recording destination stored in `_local_asciinema_recording_path`; `remote_asciinema_recording_path`: `Path | PurePosixPath | None` — environment-side recording destination stored in `_remote_asciinema_recording_path`; `pane_width`: `int` — requested tmux pane width, validated then stored in `_pane_width`; `pane_height`: `int` — requested tmux pane height, validated then stored in `_pane_height`; `extra_env`: `dict[str, str] | None` — extra environment variables, normalized into `_extra_env`; `user`: `str | int | None` — default execution user stored in `_user`
- returns: Returns `None`; its real product is initialized instance state for later `TmuxSession.start`/`stop` work.
- effects: writes `self._pane_width`; writes `self._pane_height`; writes `self._logging_path`; writes `self._local_asciinema_recording_path`; writes `self._remote_asciinema_recording_path`; writes `self._session_name`; writes `self._logger`; writes `self._previous_buffer`; writes `self._disable_recording`; writes `self.environment`; writes `self._markers`; writes `self._extra_env`; writes `self._user`; raises `ValueError` for non-integer or non-positive pane dimensions

**Execution flow**

1. It coerces `pane_width` and `pane_height` through `int(...)` and raises `ValueError("pane_width and pane_height must be valid integers.")` if either conversion fails.
2. It rejects zero or negative dimensions by checking `_pane_width <= 0 or _pane_height <= 0` and raising `ValueError("pane_width and pane_height must be positive integers.")`.
3. It stores the session-level configuration from the arguments into `_logging_path`, `_local_asciinema_recording_path`, `_remote_asciinema_recording_path`, `_session_name`, `environment`, and `_user`.
4. It seeds runtime helpers and bookkeeping with `_logger = logger`, `_previous_buffer = None`, `_disable_recording = False`, `_markers = []`, and `_extra_env = extra_env or {}`.

**Source**

```python
    def __init__(
        self,
        session_name: str,
        environment: BaseEnvironment,
        logging_path: Path | PurePosixPath,
        local_asciinema_recording_path: Path | None,
        remote_asciinema_recording_path: Path | PurePosixPath | None,
        pane_width: int = 160,
        pane_height: int = 40,
        extra_env: dict[str, str] | None = None,
        user: str | int | None = None,
    ):
        try:
            self._pane_width = int(pane_width)
            self._pane_height = int(pane_height)
        except (ValueError, TypeError):
            raise ValueError("pane_width and pane_height must be valid integers.")
        if self._pane_width <= 0 or self._pane_height <= 0:
            raise ValueError("pane_width and pane_height must be positive integers.")
        self._logging_path = logging_path
        self._local_asciinema_recording_path = local_asciinema_recording_path
        self._remote_asciinema_recording_path = remote_asciinema_recording_path
        self._session_name = session_name
        self._logger = logger
        self._previous_buffer: str | None = None
        self._disable_recording = False
        self.environment = environment
        self._markers: list[tuple[float, str]] = []
        self._extra_env: dict[str, str] = extra_env or {}
        self._user = user
```

**Non-obvious design decisions**

- It validates pane size at construction time, not when tmux starts. That makes bad `pane_width` and `pane_height` fail immediately in `Terminus2.setup` instead of surfacing later during session startup.
- It runs both size inputs through `int(...)` before storing them. This accepts integer-like inputs while still rejecting unusable values through the `except (ValueError, TypeError)` path.
- It normalizes `extra_env` with `extra_env or {}` so later code can treat `_extra_env` as a dictionary without repeated `None` checks. The trade-off is that an explicitly empty dict and `None` become equivalent.
- It initializes recording-related state even when the recording paths may be `None`. Keeping `_disable_recording`, `_markers`, and `_previous_buffer` present from the start gives later methods one consistent object shape.

**Relations**

- **Callers**: `Terminus2.setup`; stage-2 environment setup flow that constructs the per-trial terminal session
- **Core callees**: `int`; `ValueError`
- **Config / state sources**: `Terminus2.setup` passes `session_name`, `environment`, and recording paths; stage-1-crystallized pane sizing feeds `pane_width` and `pane_height`; stage-1-crystallized environment overrides feed `extra_env`; stage-1-crystallized default user feeds `user`
- **Results to**: `TmuxSession.start` consumes `_session_name`, pane sizing, paths, and environment binding; `TmuxSession.stop` can consume `_markers` and recording flags later in the trial lifecycle; later buffer-handling code can read and update `_previous_buffer`; `Terminus2.setup` stores the constructed object in `self._session` and starts it
- **Related siblings**: `Terminus2.setup` builds this object and then starts it
- **📊 Register interactions**: ✏️ writes `reg-asciinema-markers` — initialize empty marker list for later recording

</details>


<details id="fn-tmuxsession_start">
<summary><b>TmuxSession.start</b> — tmux_session.py:429-470 · boot tmux session and optional terminal recording</summary>

> **Stage context**: This method performs the concrete startup work for the `TmuxSession` that `Terminus2.setup` created earlier in stage-2. `Terminus2.setup` calls it once per trial, after `TmuxSession.__init__` has frozen session configuration such as `_user`, pane sizing, and recording paths. Within this stage, it is the step that turns stored configuration into a live remote tmux shell, with optional asciinema capture enabled inside that shell.

**What this code does**

`TmuxSession.start` starts the remote tmux session represented by this object, using `self.environment` to run commands as `self._user`. It first ensures tmux is available, then launches the session, tries to raise tmux scrollback history, and, when `_remote_asciinema_recording_path` is set, starts an `asciinema rec --stdin` process in the pane and uploads a timestamp helper script. It returns `None`; its real result is a prepared remote terminal session, or a `RuntimeError` if session startup itself fails.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `TmuxSession` — session object holding the bound `environment`, startup command, logging, user, and optional recording paths
- reads: `self.environment`, `self._tmux_start_session`, `self._user`, `self._logger`, `self._remote_asciinema_recording_path`, `self._GET_ASCIINEMA_TIMESTAMP_SCRIPT_HOST_PATH`, `self.GET_ASCIINEMA_TIMESTAMP_SCRIPT_CONTAINER_PATH`
- returns: `None`; the real product is a running remote tmux session with enlarged history when possible and optional asciinema recording setup.
- effects: calls `self._attempt_tmux_installation()` before startup; executes the tmux start command in the remote `environment`; raises `RuntimeError` if the tmux start command returns a non-zero `return_code`; executes `tmux set-option -g history-limit 10000000` in the remote `environment`; logs a warning through `_logger` if the history-limit command fails; when `_remote_asciinema_recording_path` is set, sends keys to the tmux pane to start `asciinema rec --stdin ...`; when `_remote_asciinema_recording_path` is set, sends `clear` to the tmux pane; when `_remote_asciinema_recording_path` is set, uploads the asciinema timestamp helper script into the remote environment

**Execution flow**

1. It calls `_attempt_tmux_installation()` to make sure tmux is present before trying to open the session.
2. It runs `self._tmux_start_session` through `self.environment.exec(..., user=self._user)` and treats any non-zero `return_code` as fatal by raising `RuntimeError` with `start_session_result.stderr`.
3. It then asks tmux to use a large scrollback buffer by executing `tmux set-option -g history-limit 10000000` as `self._user`.
4. If that history-limit command fails, it logs a warning with `_logger.warning(...)` and continues instead of aborting startup.
5. If `_remote_asciinema_recording_path` is set, it starts asciinema inside the tmux pane by calling `send_keys(...)` with `asciinema rec --stdin ...` followed by `Enter`, using `min_timeout_sec=1.0` to give recording startup time.
6. Still under the recording branch, it clears the pane with another `send_keys(...)` call so the captured shell starts from a clean screen.
7. Finally, under the same recording condition, it uploads the helper script from `_GET_ASCIINEMA_TIMESTAMP_SCRIPT_HOST_PATH` to `GET_ASCIINEMA_TIMESTAMP_SCRIPT_CONTAINER_PATH` in the remote environment.

**Source**

```python
    async def start(self) -> None:
        await self._attempt_tmux_installation()
        start_session_result = await self.environment.exec(
            command=self._tmux_start_session, user=self._user
        )
        if start_session_result.return_code != 0:
            raise RuntimeError(
                f"Failed to start tmux session. Error: {start_session_result.stderr}"
            )

        history_limit = 10_000_000
        command = f"tmux set-option -g history-limit {history_limit}"
        set_history_result = await self.environment.exec(
            command=command, user=self._user
        )
        if set_history_result.return_code != 0:
            self._logger.warning(
                "Failed to increase tmux history-limit: %s",
                (set_history_result.stderr or "").strip(),
            )

        if self._remote_asciinema_recording_path:
            self._logger.debug("Starting recording.")
            await self.send_keys(
                keys=[
                    f"asciinema rec --stdin {self._remote_asciinema_recording_path}",
                    "Enter",
                ],
                min_timeout_sec=1.0,
            )
            await self.send_keys(
                keys=[
                    "clear",
                    "Enter",
                ],
            )

        if self._remote_asciinema_recording_path:
            await self.environment.upload_file(
                source_path=self._GET_ASCIINEMA_TIMESTAMP_SCRIPT_HOST_PATH,
                target_path=str(self.GET_ASCIINEMA_TIMESTAMP_SCRIPT_CONTAINER_PATH),
            )
```

**Non-obvious design decisions**

- It makes tmux session creation a hard requirement but treats scrollback tuning as optional. The branch on `start_session_result.return_code` raises immediately, while the branch on `set_history_result.return_code` only logs, so the code preserves a usable shell even when tmux refuses the larger history setting.
- It gates all recording work on `_remote_asciinema_recording_path` instead of a separate flag. That keeps recording setup tied to the presence of a concrete destination path; without that path, starting `asciinema rec` would not have enough information to produce a file.
- It starts recording from inside the tmux pane with `send_keys(...)` rather than as an out-of-band process through `environment.exec(...)`. That choice keeps the recorder attached to the same interactive shell stream that the agent will use, which is necessary for `--stdin` capture.
- It sends `clear` right after launching asciinema so the recording begins from a clean terminal view instead of including startup noise. The alternative would preserve whatever shell text preceded recording, which would make the capture harder to read.
- It uploads the timestamp helper script only when recording is enabled. That avoids modifying the remote environment with recording-specific files during non-recorded trials.

**Relations**

- **Callers**: `Terminus2.setup`; stage-2 environment setup flow that starts the per-trial `TmuxSession`
- **Core callees**: `TmuxSession._attempt_tmux_installation`; `environment.exec`; `TmuxSession.send_keys`; `environment.upload_file`; `_logger.warning`; `_logger.debug`
- **Config / state sources**: `TmuxSession.__init__` populates `_tmux_start_session`; `TmuxSession.__init__` stores the bound `environment`; `TmuxSession.__init__` stores `_user`; `TmuxSession.__init__` stores `_remote_asciinema_recording_path`; `Terminus2.setup` decides whether recording paths are passed into `TmuxSession`
- **Results to**: the remote trial environment now has a live tmux session; later terminal I/O methods operate against the started pane; optional asciinema output is written to `_remote_asciinema_recording_path`; the uploaded timestamp helper script is available for later recording-related use; `TmuxSession.stop` in stage-6 can later shut down the session and finalize recording artifacts
- **Related siblings**: `Terminus2.setup` creates the `TmuxSession` and awaits this method; `TmuxSession.__init__` validates and stores the startup configuration that this method consumes

</details>
