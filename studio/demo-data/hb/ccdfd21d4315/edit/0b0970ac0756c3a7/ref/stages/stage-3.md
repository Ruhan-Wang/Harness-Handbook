## 3 · Run Onset

#### (a) Opening Explanation

This stage exists to turn a prepared environment into a clean, first-class run that the agent can actually reason over. Environment setup gave Terminus 2 a place to act. Run Onset makes that place usable for *this specific task*. It clears leftovers from any earlier run, captures the current terminal view, builds the full starting instruction, and records that starting point as the first item in the run’s trajectory (the canonical step-by-step record of what happened). This stage sits right before the core loop because the loop should only begin once the agent has a fresh identity, a clear prompt, and an accurate picture of the terminal. Without this stage, the loop would start half-blind and with stale state mixed in.

#### (b) Main Flow

1. ` _reset_per_run_state()` (clear run-specific memory) runs first.  
   Its job is to wipe data that only makes sense for one run: old trajectory steps, counters, pending handoffs, subagent bookkeeping, timestamps, and the current session id. This matters because the same `Terminus2` instance can be reused. Without a reset here, one task could leak into the next.

2. A fresh `Chat(...)` object is created.  
   Chat is the thin wrapper around the LLM call. A new one is made here so the upcoming run has its own clean conversation context rather than inheriting transient state from a prior run.

3. The agent captures the initial terminal screen with `session.get_incremental_output()`.  
   This is the agent’s first real observation. The terminal is the world it acts in, so the loop should start from what is actually on screen now, not from assumptions.

4. The user instruction is expanded before the first prompt is built.  
   If MCP servers are present, their description is added. MCP servers are external tools exposed to the agent through a standard interface. Then `_build_skills_section()` (assemble the dynamic list of available skills) adds the current capabilities the agent can use. This matters because the model should know both the task and the tools it has before it plans.

5. The initial prompt is formatted from the instruction plus terminal state.  
   This creates the starting package the model will reason over: what to do, what tools exist, and what the terminal currently looks like.

6. That prompt is written as trajectory step 1 with `source="user"`.  
   This is important for traceability. The run now has an explicit starting record, so later steps can be understood relative to a known beginning.

7. Only then does control pass into the iteration loop, wrapped in `try`/`finally`.  
   The key idea is that the core loop should begin only after initialization is complete and the run has a durable starting record.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `reg-trajectory-steps` — writes the initial prompt as step 1 so the run has a canonical starting record
- reads: `reg-trajectory-steps` — this stage treats it as prior-run data that must not carry forward
- clears: `reg-trajectory-steps` — `_reset_per_run_state()` clears it so stale history does not leak into the new run
- triggers downstream: `stage-4 Iteration Loop ★ Core ★` — once reset, prompt construction, and initial observation are complete

#### (d) Pipeline Hand-Off

Upstream gives this stage a ready environment: the terminal/session exists, but it is not yet packaged as a fresh run. This stage turns that into a clean run start — fresh per-run state, a complete initial prompt, the first terminal snapshot, and trajectory step 1 — which the iteration loop then consumes as the basis for all further thinking and action.

<details id="fn-terminus2_reset_per_run_state">
<summary><b>Terminus2._reset_per_run_state</b> — terminus_2.py:1563-1578 · Per-run state reset and session id selection</summary>

> **Stage context**: This helper opens stage-3 by clearing state that must not leak across separate `Terminus2.run()` invocations. `Terminus2.run` calls it before it creates the fresh `Chat`, captures terminal output, and seeds the initial prompt. In this stage, it is the boundary between long-lived instance configuration and run-scoped accumulators.

**What this code does**

`_reset_per_run_state` reinitializes all run-scoped fields on `self` before a new `run()` begins. It takes no inputs beyond `self`, reads `_user_provided_session_id`, and overwrites the trajectory list, timing list, counters, pending handoff/completion state, marker storage, subagent tracking, and `_session_id`. Its only product is this reset state on the reused `Terminus2` instance.

**Interface · params / IO**

`(self) -> None`

- params: `self`: `?` — The `Terminus2` instance whose run-scoped state is being reinitialized.
- reads: `self._user_provided_session_id`
- returns: Returns `None`; it prepares a clean per-run state on `self` for the upcoming `run()` invocation.
- effects: Writes `self._trajectory_steps`; Writes `self._api_request_times`; Writes `self._n_episodes`; Writes `self._summary_round_count`; Writes `self._subagent_metrics`; Writes `self._subagent_rollout_details`; Writes `self._pending_completion`; Writes `self._pending_subagent_refs`; Writes `self._pending_handoff_prompt`; Writes `self._timestamped_markers`; Writes `self._session_id`; Constructs a new `SubagentMetrics()` instance; May generate a UUID via `uuid.uuid4()` when no user session id is supplied

**Execution flow**

1. Replace per-run collection fields with empty containers: `_trajectory_steps`, `_api_request_times`, `_subagent_rollout_details`, and `_timestamped_markers` become fresh empty lists.
2. Reset run counters to their starting values by setting `_n_episodes` and `_summary_round_count` to `0`.
3. Replace `_subagent_metrics` with a new `SubagentMetrics()` accumulator for this run.
4. Clear cross-iteration pending state by setting `_pending_completion` to `False` and `_pending_subagent_refs` and `_pending_handoff_prompt` to `None`.
5. Choose the run's session id by reusing `_user_provided_session_id` when it is truthy, otherwise generating `str(uuid.uuid4())` and storing it in `_session_id`.

**Source**

```python
    def _reset_per_run_state(self) -> None:
        """Reset all per-run state. The same Terminus2 instance is reused
        across multiple `run()` invocations in multi-step trials, so any
        accumulator that should be scoped to a single step must be reset here.
        """
        self._trajectory_steps = []
        self._api_request_times = []
        self._n_episodes = 0
        self._summarization_count = 0
        self._subagent_metrics = SubagentMetrics()
        self._subagent_rollout_details = []
        self._pending_completion = False
        self._pending_subagent_refs = None
        self._pending_handoff_prompt = None
        self._timestamped_markers = []
        self._session_id = self._user_provided_session_id or str(uuid.uuid4())
```

**Non-obvious design decisions**

- The function centralizes all run-scoped resets in one place because the class instance survives across multiple `run()` calls. Without this dedicated scrub step, old `_trajectory_steps`, counters, or pending flags could bleed into the next trial step.
- It creates fresh containers and a fresh `SubagentMetrics()` object instead of trying to clear nested state in place. That avoids carrying over references or partially reset subagent accounting.
- It preserves a caller-supplied `_user_provided_session_id` but falls back to a generated UUID when none is present. This balances stable external session naming with automatic uniqueness for ordinary runs.

**Relations**

- **Callers**: Terminus2.run
- **Core callees**: SubagentMetrics; uuid.uuid4
- **Config / state sources**: self._user_provided_session_id
- **Results to**: stage-3 `Terminus2.run` setup that constructs a fresh `Chat`; stage-3 initial prompt seeding into `_trajectory_steps`; stage-4 iteration loop, which starts counting episodes from `_n_episodes == 0`; stage-4.5 / 4.6 / 4.8 / 4.9, which append new run data into cleared accumulators; stage-5 metadata and totals assembly, which reads per-run counters and timings
- **📊 Register interactions**: ♻️ resets `reg-pending-completion` — start new run with no completion pending; ♻️ resets `reg-pending-handoff-prompt` — clear stale summary handoff prompt; ♻️ resets `reg-pending-subagent-refs` — clear stale subagent trajectory refs; ♻️ resets `reg-n-episodes` — restart iteration counter at zero; ♻️ resets `reg-summary-round-count` — restart summarization count for run; ♻️ resets `reg-trajectory-steps` — begin fresh trajectory for this run; ♻️ resets `reg-asciinema-markers` — discard markers from prior run; ♻️ resets `reg-subagent-metrics` — replace subagent accounting accumulator; ♻️ resets `reg-api-request-times` — clear per-request timing history

</details>


<details id="fn-terminus2_run">
<summary><b>Terminus2.run</b> — terminus_2.py:1586-1625 · run setup and initial prompt seeding</summary>

> **Stage context**: This region performs the front half of `Terminus2.run()` before the main iteration loop starts. It follows `Terminus2._reset_per_run_state`, then establishes the fresh chat/session context and seeds the first trajectory entry that the loop will build on. Within stage 3, it is the bridge from reset state to a fully prepared first prompt.

**What this code does**

This region prepares a new run from the current `instruction`, `environment`, and `context`. It resets run-scoped state, creates a fresh `Chat` in `self._chat`, verifies that `self._session` exists, captures the current terminal output, augments the instruction with `mcp_servers` details and `_build_skills_section(environment)`, formats `_prompt_template`, and records that formatted prompt as the first `Step` in `_trajectory_steps`. It does not return a value; its product is initialized run state plus an initial user-authored trajectory record.

**Interface · params / IO**

`(self, instruction: str, environment: dict[str, str], context: ContextT) -> TrialT`

- params: `self`: `Terminus2` — runner instance that owns session, prompt, and run-scoped state; `instruction`: `str` — base task instruction to augment and embed in the initial prompt; `environment`: `dict[str, str]` — environment mapping passed into `_build_skills_section`; `context`: `ContextT` — per-run context object stored on `self._context`
- reads: `self._llm`, `self._interleaved_thinking`, `self._session`, `self.mcp_servers`, `self._prompt_template`, `self._trajectory_steps`
- returns: No direct return in this region; it produces initialized run state on `self`, a formatted initial prompt, and the first appended trajectory step.
- effects: calls `self._reset_per_run_state()` to clear and rotate run-local state; writes `self._chat` with a new `Chat(self._llm, interleaved_thinking=self._interleaved_thinking)`; writes `self._context`; awaits `self._session.get_incremental_output()` to read external terminal state; calls `self._limit_output_length(...)` to truncate terminal output for prompting; awaits `self._build_skills_section(environment)`; appends a new `Step(...)` to `self._trajectory_steps`

**Execution flow**

1. Reset run-scoped fields with `self._reset_per_run_state()`, create a fresh `Chat` in `self._chat` from `_llm` and `_interleaved_thinking`, and store the incoming `context` on `self._context`.
2. Validate that `self._session` is present; if it is `None`, stop immediately with `RuntimeError("Session is not set")`.
3. Read the current terminal snapshot by awaiting `self._session.get_incremental_output()`, then pass that output through `_limit_output_length(...)` to produce `terminal_state` for the first prompt.
4. Start from `instruction` as `augmented_instruction`, and if `self.mcp_servers` is non-empty, append a generated `MCP Servers:` section that describes each server from its `name`, `transport`, and either `command` plus `args` or `url`.
5. Build a dynamic skills block with `await self._build_skills_section(environment)` and append it to `augmented_instruction` when the returned `skills_section` is truthy.
6. Format `self._prompt_template` with `instruction=augmented_instruction` and `terminal_state=terminal_state`, then append that prompt to `self._trajectory_steps` as `Step(step_id=1, source="user", ...)` with a UTC ISO timestamp.

**Source**

```python
        self._reset_per_run_state()
        self._chat = Chat(self._llm, interleaved_thinking=self._interleaved_thinking)
        self._context = context

        if self._session is None:
            raise RuntimeError("Session is not set")

        # Get the terminal state for the initial prompt
        terminal_state = self._limit_output_length(
            await self._session.get_incremental_output()
        )

        augmented_instruction = instruction
        if self.mcp_servers:
            mcp_info = "\n\nMCP Servers:\nThe following MCP servers are available for this task.\n"
            for s in self.mcp_servers:
                if s.transport == "stdio":
                    args_str = " ".join(s.args)
                    mcp_info += f"- {s.name}: stdio transport, command: {s.command} {args_str}\n"
                else:
                    mcp_info += f"- {s.name}: {s.transport} transport, url: {s.url}\n"
            augmented_instruction = instruction + mcp_info

        skills_section = await self._build_skills_section(environment)
        if skills_section:
            augmented_instruction += skills_section

        initial_prompt = self._prompt_template.format(
            instruction=augmented_instruction,
            terminal_state=terminal_state,
        )

        self._trajectory_steps.append(
            Step(
                step_id=1,
                timestamp=datetime.now(timezone.utc).isoformat(),
                source="user",
                message=initial_prompt,
            )
        )
```

**Non-obvious design decisions**

- It creates a brand-new `Chat` after `_reset_per_run_state()` instead of reusing an existing one. That keeps `chat.messages` isolated per run; reuse would risk carrying old model history into a new trial.
- It raises on `self._session is None` before prompt construction. That fails fast at the first point where terminal state is required; a later failure would leave partially initialized run state and a misleading first prompt.
- It captures terminal output through `_limit_output_length(await self._session.get_incremental_output())` before formatting `_prompt_template`. This bounds prompt size using a dedicated limiter instead of embedding raw terminal output, which would make prompt growth depend directly on session backlog.
- It embeds `mcp_servers` and `_build_skills_section(environment)` into the instruction text itself rather than storing them separately on the step. That makes the exact prompt content visible in the first trajectory `Step`, at the cost of duplicating derived context into the recorded message.

**Relations**

- **Callers**: `Terminus2.run`
- **Core callees**: `Terminus2._reset_per_run_state`; `Chat`; `Terminus2._limit_output_length`; `TmuxSession.get_incremental_output` via `self._session`; `Terminus2._build_skills_section`; `self._prompt_template.format`; `Step`
- **Config / state sources**: `self._llm`; `self._interleaved_thinking`; `self.mcp_servers`; `self._prompt_template`; `self._session`
- **Results to**: `self._chat` for later LLM interaction; `self._context` for later run stages; `self._trajectory_steps` as the seed of the run record; the subsequent iteration loop in `Terminus2.run`
- **Related siblings**: `Terminus2._reset_per_run_state`: clears all run-scoped registers before this region seeds fresh state
- **📊 Register interactions**: ♻️ resets `reg-pending-completion` — cleared indirectly by `_reset_per_run_state`; ♻️ resets `reg-pending-handoff-prompt` — cleared indirectly by `_reset_per_run_state`; ♻️ resets `reg-pending-subagent-refs` — cleared indirectly by `_reset_per_run_state`; ♻️ resets `reg-n-episodes` — zeroed indirectly by `_reset_per_run_state`; ♻️ resets `reg-summarization-count` — zeroed indirectly by `_reset_per_run_state`; ♻️ resets `reg-trajectory-steps` — cleared before seeding first step; ✏️ writes `reg-trajectory-steps` — append initial prompt as user step; ♻️ resets `reg-asciinema-markers` — cleared indirectly by `_reset_per_run_state`; ♻️ resets `reg-subagent-metrics` — cleared indirectly by `_reset_per_run_state`; ♻️ resets `reg-api-request-times` — cleared indirectly by `_reset_per_run_state`

</details>


<details id="fn-terminus2_build_skills_section">
<summary><b>Terminus2._build_skills_section</b> — terminus_2.py:419-470 · Remote skills XML section builder</summary>

> **Stage context**: This helper runs during stage-3 prompt assembly, before `Terminus2.run()` enters its main loop. `run()` uses it alongside MCP-server augmentation to expand the initial instruction text. Unlike `_reset_per_run_state`, it does not prepare mutable run state; it only probes the provided `environment` and returns optional prompt content.

**What this code does**

`_build_skills_section` inspects `self.skills_dir` in the given `environment` and looks for `SKILL.md` files one directory below it. For each discovered file, it reads the file content, parses frontmatter through `self._parse_skill_frontmatter`, and collects `(fm["name"], fm["description"], skill_md_path)` entries. It returns `None` when `self.skills_dir` is falsy, `environment.is_dir(self.skills_dir)` is false, the `find` command fails or yields blank output, or no files survive the `cat` and frontmatter checks. Otherwise it returns an indented `<available_skills>` XML string and does not mutate instance state.

**Interface · params / IO**

`(self, environment: BaseEnvironment) -> str | None`

- params: `environment`: `BaseEnvironment` — Remote filesystem and command-execution backend used for directory checks and file reads
- reads: `self.skills_dir`, `self._parse_skill_frontmatter`
- returns: `None` for all early-exit cases, or a newline-prefixed XML string from `xml.etree.ElementTree.tostring(...)` containing one `<skill>` per surviving entry
- effects: Calls `environment.is_dir(self.skills_dir)`; Runs `environment.exec(..., timeout_sec=10)` with a `find ... -name SKILL.md -type f | sort` command; Runs `environment.exec(f"cat {shlex.quote(skill_md_path)}", timeout_sec=10)` for each discovered path

**Execution flow**

1. Return `None` immediately if `self.skills_dir` is falsy, then return `None` again if `await environment.is_dir(self.skills_dir)` is false.
2. Scan the remote directory by calling `environment.exec(...)` with `find {shlex.quote(self.skills_dir)} -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort` and `timeout_sec=10`; return `None` if the command fails, if `stdout` is missing, or if `stdout.strip()` is empty.
3. Split the `find` output into `skill_md_paths`, initialize `entries`, and for each path run `environment.exec(f"cat {shlex.quote(skill_md_path)}", timeout_sec=10)`.
4. Skip a path when `cat_result.return_code != 0` or `cat_result.stdout` is falsy; otherwise parse the file text with `self._parse_skill_frontmatter(cat_result.stdout)` and skip the path again if that parser returns `None`.
5. For each successful parse, append exactly `(fm["name"], fm["description"], skill_md_path)` to `entries`.
6. Return `None` if `entries` is empty; otherwise import `Element`, `SubElement`, `indent`, and `tostring`, build an `<available_skills>` tree with `<name>`, `<description>`, and `<location>` children, indent it with two spaces, and return `"\n" + tostring(root, encoding="unicode")`.

**Source**

```python
    async def _build_skills_section(self, environment: BaseEnvironment) -> str | None:
        """Discover Agent Skills in skills_dir and return an <available_skills> XML block.

        Follows the Agent Skills spec: scans for subdirectories containing SKILL.md
        inside the remote environment, parses YAML frontmatter for name/description,
        and provides the absolute path so the model can ``cat`` the file to activate
        a skill.
        """
        if not self.skills_dir:
            return None

        if not await environment.is_dir(self.skills_dir):
            return None

        # List subdirectories containing SKILL.md in the remote environment
        result = await environment.exec(
            f"find {shlex.quote(self.skills_dir)} -mindepth 2 -maxdepth 2"
            " -name SKILL.md -type f | sort",
            timeout_sec=10,
        )

        if result.return_code != 0 or not result.stdout or not result.stdout.strip():
            return None

        skill_md_paths = result.stdout.strip().splitlines()
        entries: list[tuple[str, str, str]] = []  # (name, description, location)

        for skill_md_path in skill_md_paths:
            cat_result = await environment.exec(
                f"cat {shlex.quote(skill_md_path)}", timeout_sec=10
            )
            if cat_result.return_code != 0 or not cat_result.stdout:
                continue
            fm = self._parse_skill_frontmatter(cat_result.stdout)
            if fm is None:
                continue
            entries.append((fm["name"], fm["description"], skill_md_path))

        if not entries:
            return None

        from xml.etree.ElementTree import Element, SubElement, indent, tostring

        root = Element("available_skills")
        for name, description, location in entries:
            skill = SubElement(root, "skill")
            SubElement(skill, "name").text = name
            SubElement(skill, "description").text = description
            SubElement(skill, "location").text = location

        indent(root, space="  ")
        return "\n" + tostring(root, encoding="unicode")
```

**Non-obvious design decisions**

- The function treats every discovery problem as absence, not as an exception path. The repeated `return None` checks around `self.skills_dir`, `environment.is_dir(...)`, the `find` result, `cat` results, and `self._parse_skill_frontmatter(...)` keep prompt construction tolerant of missing or unusable skill data instead of making `run()` fail.
- It performs all discovery through `environment.exec(...)` and `environment.is_dir(...)` instead of local filesystem APIs. That choice keeps the scan aligned with the remote execution context that owns `skills_dir`; using local file access here would inspect the wrong machine.
- It preserves the discovered `skill_md_path` verbatim in the `<location>` element. The code does not normalize or reinterpret the path, which avoids inventing path semantics and makes the XML reflect exactly what the remote `find` command returned.
- The XML helpers are imported only after `if not entries: return None`. That defers XML-tree setup work to the only path that needs it and keeps the no-skills path cheap.

**Relations**

- **Callers**: Terminus2.run
- **Core callees**: environment.is_dir; environment.exec; self._parse_skill_frontmatter; shlex.quote; xml.etree.ElementTree.Element; xml.etree.ElementTree.SubElement; xml.etree.ElementTree.indent; xml.etree.ElementTree.tostring
- **Config / state sources**: self.skills_dir
- **Results to**: Terminus2.run uses the returned string from `_build_skills_section(environment)` while augmenting the initial instruction
- **Related siblings**: Terminus2.run; Terminus2._reset_per_run_state

</details>
