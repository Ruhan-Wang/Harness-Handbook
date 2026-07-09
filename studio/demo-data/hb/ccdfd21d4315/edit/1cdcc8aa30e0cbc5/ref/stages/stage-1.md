## 1 · Configuration Crystallization

#### (a) Opening Explanation

This stage exists to turn a messy one-time constructor call into a stable agent identity the rest of the pipeline can trust. At this point, the system has not started a task yet. It only has user-supplied settings, many of which overlap, have defaults, or affect later stages in subtle ways. Configuration Crystallization owns that cleanup. It decides which settings actually win, builds the long-lived interfaces the agent will reuse across tasks, finds the prompt and timeout template files on disk, and creates every per-run register in a known empty state. Without this stage, later stages would need to keep re-checking config, guessing defaults, and defending against stale state from an earlier run on the same agent instance.

#### (b) Main Flow

1. **Normalize constructor inputs into one clear policy.**  
   `Terminus2.__init__()` (build the agent object) first resolves the user-facing settings that can conflict. The main example is the episode limit: both the old `episodes` argument and the current `max_episodes` argument may appear. This stage settles that once, up front, so the rest of the agent sees a single final limit instead of carrying deprecation logic forever. This is the “decide what this agent is” step.

2. **Derive fixed lifetime configuration.**  
   Once the inputs are normalized, the stage turns them into immutable instance choices: model details, parser choice, summarization behavior, terminal sizing, trajectory settings, and backend options. ` _resolve_model_info()` helps pin down model-related metadata. `_get_parser()` picks the parser, meaning the component that turns model output into structured agent actions. This matters because later stages should not be negotiating these choices again; they should inherit a settled configuration.

3. **Create the long-lived LLM interface.**  
   `_init_llm()` builds the Chat client, a thin wrapper around the language model backend. This stage owns it because model/backend setup is expensive and belongs to the agent’s lifetime, not to each task run. By creating it here, later stages can simply use “the agent’s LLM” rather than re-building the connection each time.

4. **Locate and load shared templates.**  
   `_get_prompt_template_path()` and `_get_timeout_template_path()` compute where the prompt and timeout templates live on disk, and the constructor loads those template contents for later use. This is important because the agent’s behavior depends not just on code, but also on the text scaffolding fed to the model. Doing this once keeps later stages focused on filling templates, not hunting for files.

5. **Reset every per-run register to an empty starting state.**  
   Even though this stage runs once per agent lifetime, it still declares all run-scoped fields now: trajectory steps, pending completion, pending subagent references, pending handoff prompt, asciinema markers, subagent metrics, API request times, summarization count, episode counter, and session id. The point is simple: a newly created agent should begin with no leftover work in flight. This clean baseline is what lets the next stage start a task without defensive cleanup.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `trajectory steps` — default-initialized during construction to an empty starting value, so a fresh agent has no prior action history attached
- writes: `pending completion` — default-initialized as empty/none, because no model response is waiting to be consumed before the first run
- writes: `pending subagent refs` — default-initialized as empty, since no subagent (a smaller agent invoked by the main agent) exists yet
- writes: `pending handoff prompt` — default-initialized as empty/none, because no handoff to another agent is in progress
- writes: `asciinema markers` — default-initialized as empty, since no terminal recording markers exist before any task starts
- writes: `subagent metrics` — default-initialized to empty counters/collections, because no subagent work has happened yet
- writes: `api request times` — default-initialized as empty, so latency/accounting starts from zero for the first run
- writes: `summarization count` — default-initialized to zero, because no summarization has occurred yet
- writes: `n_episodes` — default-initialized to zero, since the agent has not entered any episode loop yet
- writes: `session id` — default-initialized to an empty/unset value, because no runtime session has been established yet
- clears: `trajectory steps` — cleared by construction in the sense that a new instance starts with no inherited trajectory from any previous task
- clears: `pending completion` — cleared by construction so no stale completion leaks into the first run
- clears: `pending subagent refs` — cleared by construction so no orphaned subagent handles carry over
- clears: `pending handoff prompt` — cleared by construction so no earlier handoff request survives
- clears: `asciinema markers` — cleared by construction so recording state starts clean
- clears: `subagent metrics` — cleared by construction so accounting is per-run rather than inherited
- clears: `api request times` — cleared by construction so timing data starts fresh
- clears: `summarization count` — cleared by construction to prevent old summarization totals from leaking forward
- clears: `n_episodes` — cleared by construction so the loop counter starts at zero
- clears: `session id` — cleared by construction so a later run can assign a fresh session identity
- triggers downstream: `stage-2 Environment Setup` — after constructor inputs are normalized, lifetime configuration is fixed, templates are loaded, and all per-run registers exist in known default state

#### (d) Pipeline Hand-Off

Upstream, there is no prior runtime stage yet; this stage takes raw constructor arguments supplied when the agent instance is created. It produces a fully configured agent with fixed lifetime settings, loaded template text, a ready LLM client, and clean per-run registers, which `stage-2 Environment Setup` can then use to build the task-specific runtime environment.

<details id="fn-terminus2_init">
<summary><b>Terminus2.__init__</b> — terminus_2.py:145-332 · Agent constructor and configuration freezer</summary>

> **Stage context**: This entry is the stage-1 constructor that crystallizes user-supplied options into the agent's long-lived instance state. It runs once at agent creation, before any setup or task loop work, and prepares the objects and defaults that later stages consume. In this stage, it is the primary source of the agent's immutable operating policy, including LLM, parser, prompt templates, iteration limits, and per-run registers.

**What this code does**

`Terminus2.__init__` builds a `Terminus2` agent from constructor inputs such as `model_name`, parser choice, summarization settings, tmux sizing, trajectory options, and backend kwargs. It validates that `model_name` is present, resolves model metadata, creates the LLM client through `_init_llm`, selects the parser through `_get_parser`, loads prompt and timeout templates from disk, and stores the resulting configuration on `self`. It also initializes the per-run fields and counters that later stages mutate, including trajectory storage, pending completion and handoff state, summarization bookkeeping, API timing history, and session identifiers.

**Interface · params / IO**

`(self, logs_dir: Path, model_name: str | None = None, max_turns: int | None = None, parser_name: str = "json", api_base: str | None = None, temperature: float | None = None, reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] | None = None, collect_rollout_details: bool = False, session_id: str | None = None, enable_summarize: bool = True, proactive_summarization_threshold: int = 8000, max_thinking_tokens: int | None = None, model_info: dict | None = None, trajectory_config: TrajectoryConfig | None = None, tmux_pane_width: int = 160, tmux_pane_height: int = 40, store_all_messages: bool = False, record_terminal_session: bool = True, interleaved_thinking: bool = False, suppress_max_turns_warning: bool = False, use_responses_api: bool = False, llm_backend: LLMBackend | str = LLMBackend.LITELLM, llm_kwargs: dict | None = None, llm_call_kwargs: dict[str, Any] | None = None, extra_env: dict[str, str] | None = None, *args, **kwargs)`

- params: `logs_dir`: `Path` — log directory forwarded to the base agent constructor; `model_name`: `str | None` — required LLM model identifier; stored on `self` and passed into model resolution and LLM init; `max_turns`: `int | None` — preferred iteration limit; takes precedence over deprecated episode-style inputs; `parser_name`: `str` — parser selector stored in `_parser_name` for `_get_parser`; `api_base`: `str | None` — optional API endpoint base URL forwarded to `_init_llm`; `temperature`: `float | None` — optional sampling temperature stored on `self` and passed to `_init_llm`; `reasoning_effort`: `Literal["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] | None` — optional effort hint stored and forwarded to `_init_llm`; `collect_rollout_details`: `bool` — toggles extra rollout capture and is forwarded to `_init_llm`; `session_id`: `str | None` — optional external session identifier; preserved and used as the runtime session id when provided; `enable_summarize`: `bool` — master toggle for summarization behavior; `proactive_summarization_threshold`: `int` — free-token threshold for proactive summarization; `max_thinking_tokens`: `int | None` — optional extended-thinking token limit forwarded to `_init_llm`; `model_info`: `dict | None` — optional custom model metadata merged by `_resolve_model_info`; `trajectory_config`: `TrajectoryConfig | None` — optional trajectory behavior map for raw-content and linear-history flags; `tmux_pane_width`: `int` — default tmux pane width stored for later session creation; `tmux_pane_height`: `int` — default tmux pane height stored for later session creation; `store_all_messages`: `bool` — controls whether full chat messages are retained in result metadata; `record_terminal_session`: `bool` — controls whether terminal recordings should be captured; `interleaved_thinking`: `bool` — controls whether reasoning content is retained in chat history; `suppress_max_turns_warning`: `bool` — suppresses the warning emitted when a finite episode limit is configured; `use_responses_api`: `bool` — forwarded to `_init_llm` to choose response API behavior; `llm_backend`: `LLMBackend | str` — backend selector forwarded to `_init_llm`; `llm_kwargs`: `dict | None` — extra constructor kwargs for the LLM client; stored and forwarded; `llm_call_kwargs`: `dict[str, Any] | None` — default per-call kwargs copied into `_llm_call_kwargs`; `extra_env`: `dict[str, str] | None` — extra environment variables stored for later execution context use; `args`: `?` — extra positional arguments forwarded to `super().__init__`; `kwargs`: `?` — extra keyword arguments forwarded to `super().__init__` and inspected for deprecated `episodes` and `max_episodes`
- reads: `self.logger`
- returns: None; its real product is a fully initialized `Terminus2` instance with persistent configuration and default runtime registers.
- effects: calls `super().__init__(logs_dir, model_name, *args, **kwargs)`; raises `ValueError` when `model_name` is `None`; calls `_resolve_model_info(model_name, model_info)`; calls `_init_llm(...)` and stores the resulting client in `_llm`; calls `_get_parser()` and stores the parser in `_parser`; reads prompt and timeout template files via `_get_prompt_template_path().read_text()` and `_get_timeout_template_path().read_text()`; emits deprecation and max-turn-limit warnings through `self.logger.warning(...)`; generates a UUID with `uuid.uuid4()` when `session_id` is absent; writes `_extra_env`, `_model_name`, `_last_response_model_name`, `_parser_name`, `_collect_rollout_details`, `_reasoning_effort`, `_llm`, `_parser`, `_prompt_template`, `_timeout_template`, `_temperature`, `_max_episodes`, `_chat`, `_context`, `_timestamped_markers`, `_pending_completion`, `_session`, `_api_request_times`, `_n_episodes`, `_user_provided_session_id`, `_session_id`, `_trajectory_steps`, `_record_terminal_session`, `_llm_call_kwargs`, `_summarization_count`, `_pending_subagent_refs`, `_pending_handoff_prompt`, `_subagent_metrics`, `_subagent_rollout_details`, `_enable_summarize`, `_proactive_summarization_threshold`, `_tmux_pane_width`, `_tmux_pane_height`, `_trajectory_config`, `_save_raw_content_in_trajectory`, `_linear_history`, `_store_all_messages`, `_interleaved_thinking`, and `_llm_kwargs`

**Execution flow**

1. It forwards `logs_dir`, `model_name`, `*args`, and `**kwargs` to `super().__init__`, stores `extra_env` in `_extra_env`, requires a non-`None` `model_name`, and records core model/parser settings in `_model_name`, `_parser_name`, `_collect_rollout_details`, and `_reasoning_effort`.
2. It resolves model metadata with `_resolve_model_info(model_name, model_info)`, then constructs the LLM client by calling `_init_llm(...)` with backend, model, temperature, API, session, thinking, and model-info inputs.
3. It selects the parser with `_get_parser()`, loads the prompt and timeout template text from the paths returned by `_get_prompt_template_path()` and `_get_timeout_template_path()`, and stores `temperature` in `_temperature`.
4. It checks deprecated episode-style inputs in `kwargs`: warns when `episodes` is present, computes `final_max_episodes` by precedence `max_turns` > `kwargs['max_episodes']` > `kwargs['episodes']`, warns about an artificial turn limit unless `suppress_max_turns_warning` is set, and falls back to `1000000` when no limit is supplied.
5. It initializes the runtime references and counters that start empty or unset: `_chat`, `_context`, `_timestamped_markers`, `_pending_completion`, `_session`, `_api_request_times`, `_n_episodes`, `_trajectory_steps`, `_summarization_count`, `_pending_subagent_refs`, `_pending_handoff_prompt`, and `_subagent_rollout_details`.
6. It finalizes identity and behavior flags by preserving `session_id` in `_user_provided_session_id`, generating `_session_id` when needed, copying `llm_call_kwargs` into `_llm_call_kwargs`, creating `_subagent_metrics`, storing summarization and tmux settings, expanding `trajectory_config` into `_save_raw_content_in_trajectory` and `_linear_history`, and recording output-retention and thinking options in `_store_all_messages`, `_interleaved_thinking`, and `_llm_kwargs`.

**Source**

```python
    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        max_turns: int | None = None,
        parser_name: str = "json",
        api_base: str | None = None,
        temperature: float | None = None,
        reasoning_effort: Literal[
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "default"
        ]
        | None = None,
        collect_rollout_details: bool = False,
        session_id: str | None = None,
        enable_summarize: bool = True,
        proactive_summarization_threshold: int = 8000,
        max_thinking_tokens: int | None = None,
        model_info: dict | None = None,
        trajectory_config: TrajectoryConfig | None = None,
        tmux_pane_width: int = 160,
        tmux_pane_height: int = 40,
        store_all_messages: bool = False,
        record_terminal_session: bool = True,
        interleaved_thinking: bool = False,
        suppress_max_turns_warning: bool = False,
        use_responses_api: bool = False,
        llm_backend: LLMBackend | str = LLMBackend.LITELLM,
        llm_kwargs: dict | None = None,
        llm_call_kwargs: dict[str, Any] | None = None,
        extra_env: dict[str, str] | None = None,
        *args,
        **kwargs,
    ):
        """Initialize Terminus 2 agent.

        Args:
            logs_dir: Directory to store logs
            model_name: Name of the model to use
            max_episodes: Maximum number of episodes (default: 1000000)
            parser_name: Parser to use - "json" or "xml" (default: "json")
            api_base: Base URL for the API endpoint
            temperature: Optional sampling temperature. If unset, no temperature is
                passed to the LLM backend. (default: None)
            reasoning_effort: Qualitative or quantitative measure of effort (default: None)
            collect_rollout_details: Whether to collect detailed rollout data including token IDs.
                NOTE: Rollout details will be incomplete if context summarization occurs.
                See class docstring for details. (default: False)
            session_id: Session ID for the agent (default: None)
            enable_summarize: Whether to enable context summarization (default: True)
            proactive_summarization_threshold: Number of free tokens below which to trigger
                proactive summarization. Set to 0 to disable proactive summarization. (default: 8000)
            max_thinking_tokens: Maximum thinking tokens for Anthropic extended thinking mode.
                Minimum value is 1024. (default: None)
            model_info: Optional dict containing model information for custom models.
                Used to register the model with litellm. Common fields include:
                - max_input_tokens: Maximum input tokens (context length)
                - max_output_tokens: Maximum output tokens
                - input_cost_per_token: Cost per input token (optional)
                - output_cost_per_token: Cost per output token (optional)
                (default: None)
            trajectory_config: Optional TrajectoryConfig containing trajectory-related configurations.
                Available options:
                - raw_content (bool): If True, dump raw LLM responses into trajectory without
                  parsing into tool_calls. Useful for SFT data export. (default: False)
                - linear_history (bool): If True, split trajectory into separate files when context
                  summarization occurs, ensuring each trajectory represents a continuous linear
                  history sent to the LLM. When False, keep all steps from the main agent
                  in a single trajectory file despite chat history resets. (default: False)
                (default: None)
            tmux_pane_width: Starting tmux pane width (maps to `tmux -x`, default: 160)
            tmux_pane_height: Starting tmux pane height (maps to `tmux -y`, default: 40)
            record_terminal_session: Whether to capture terminal recordings via asciinema.
                (default: True)
            interleaved_thinking: Whether to include reasoning content in chat history
                and send to litellm in next round's conversation (default: False)
            suppress_max_turns_warning: Whether to suppress the warning about artificially
                limiting max_turns (default: False)
            llm_backend: LLM backend to use. Use LLMBackend.LITELLM or "litellm".
                (default: LLMBackend.LITELLM)
            llm_kwargs: Additional kwargs to pass to the LLM constructor.
                (default: None)
            llm_call_kwargs: Extra kwargs to forward to LLM calls (e.g., extra_body).
            **kwargs: Additional arguments
        """
        super().__init__(logs_dir, model_name, *args, **kwargs)
        self._extra_env = extra_env

        if model_name is None:
            raise ValueError("model_name is required for Terminus 2")

        self._model_name = model_name
        self._last_response_model_name: str | None = None
        self._parser_name = parser_name
        self._collect_rollout_details = collect_rollout_details
        self._reasoning_effort = reasoning_effort
        resolved_model_info = self._resolve_model_info(model_name, model_info)

        self._llm = self._init_llm(
            llm_backend=llm_backend,
            model_name=model_name,
            temperature=temperature,
            collect_rollout_details=collect_rollout_details,
            llm_kwargs=llm_kwargs,
            api_base=api_base,
            session_id=session_id,
            max_thinking_tokens=max_thinking_tokens,
            reasoning_effort=reasoning_effort,
            model_info=resolved_model_info,
            use_responses_api=use_responses_api,
        )
        self._parser = self._get_parser()
        self._prompt_template = self._get_prompt_template_path().read_text()
        self._timeout_template = self._get_timeout_template_path().read_text()
        self._temperature = temperature

        # Handle deprecated 'episodes' kwarg
        episodes_from_kwargs = kwargs.get("episodes")
        if episodes_from_kwargs is not None:
            self.logger.warning(
                "The 'episodes' parameter is deprecated and will be removed in a future version. "
                "Please use 'max_turns' instead."
            )

        # Determine the final max episodes value with proper precedence:
        # 1. max_turns (new parameter)
        # 2. max_episodes (deprecated but still supported)
        # 3. episodes from kwargs (deprecated)
        # 4. Default value of 1000000
        final_max_episodes = None
        if max_turns is not None:
            final_max_episodes = max_turns
        elif kwargs.get("max_episodes") is not None:
            final_max_episodes = kwargs.get("max_episodes")
        elif episodes_from_kwargs is not None:
            final_max_episodes = episodes_from_kwargs

        if final_max_episodes is not None:
            if not suppress_max_turns_warning:
                self.logger.warning(
                    f"max_turns (f.k.a. max_episodes) artificially limited to {final_max_episodes}. "
                    "Consider removing this limit for better task completion."
                )
            self._max_episodes = final_max_episodes
        else:
            self._max_episodes = 1000000
        self._chat: Chat | None = None
        self._context: AgentContext | None = None
        self._timestamped_markers: list[tuple[float, str]] = []
        self._pending_completion = False
        self._session: TmuxSession | None = None
        self._api_request_times: list[float] = []
        self._n_episodes: int = 0
        self._user_provided_session_id: str | None = session_id
        self._session_id = session_id if session_id else str(uuid.uuid4())
        self._trajectory_steps: list[Step] = []
        self._record_terminal_session = record_terminal_session
        self._llm_call_kwargs = dict(llm_call_kwargs) if llm_call_kwargs else {}

        self._summarization_count: int = (
            0  # Track number of summarization subagents created
        )
        self._pending_subagent_refs: list[SubagentTrajectoryRef] | None = (
            None  # Track subagent refs to include in next step
        )
        self._pending_handoff_prompt: str | None = (
            None  # Track handoff prompt to include as user step
        )
        self._subagent_metrics = SubagentMetrics()  # Track subagent metrics separately
        self._subagent_rollout_details: list[
            RolloutDetail
        ] = []  # Track rollout details for each subagent
        self._enable_summarize = (
            enable_summarize  # Toggle for proactive and context limit summarization
        )
        self._proactive_summarization_threshold = proactive_summarization_threshold
        self._tmux_pane_width = tmux_pane_width
        self._tmux_pane_height = tmux_pane_height

        # Trajectory configuration
        self._trajectory_config = trajectory_config or {}
        self._save_raw_content_in_trajectory = self._trajectory_config.get(
            "raw_content", False
        )
        self._linear_history = self._trajectory_config.get("linear_history", False)
        # Optional: include full chat messages in TrialResult metadata (can be large)
        self._store_all_messages = store_all_messages
        self._interleaved_thinking = interleaved_thinking
        self._llm_kwargs = llm_kwargs
```

**Non-obvious design decisions**

- It keeps backward compatibility for older iteration-limit names by explicitly reading `kwargs.get("max_episodes")` and `kwargs.get("episodes")`, but it gives `max_turns` top precedence. That lets newer callers override legacy paths without ambiguity while still warning users away from deprecated names.
- It distinguishes between a caller-supplied `session_id` and the actual runtime identifier by storing both `_user_provided_session_id` and `_session_id`, and generating a UUID only when `session_id` is missing. This preserves provenance about whether the session id came from outside while still guaranteeing a usable id for every agent instance.
- It copies `llm_call_kwargs` with `dict(llm_call_kwargs)` instead of storing the incoming mapping directly. That avoids later mutation of the caller's dictionary leaking into the agent's default call configuration.
- It allocates separate summarization and subagent bookkeeping fields such as `_summarization_count`, `_pending_subagent_refs`, `_pending_handoff_prompt`, and `_subagent_metrics` during construction instead of mixing them into generic chat state. That separation makes later stages track subagent effects independently from the main conversation and metrics.

**Relations**

- **Callers**: external code that instantiates `Terminus2`; factory or CLI paths that create a `Terminus2` agent before `setup()` or `run()`; tests that construct `Terminus2` with custom model and trajectory settings
- **Core callees**: `super().__init__`; `_resolve_model_info`; `_init_llm`; `_get_parser`; `_get_prompt_template_path`; `_get_timeout_template_path`; `uuid.uuid4`; `self.logger.warning`
- **Config / state sources**: `model_name`; `max_turns`; `kwargs['max_episodes']`; `kwargs['episodes']`; `parser_name`; `temperature`; `reasoning_effort`; `session_id`; `enable_summarize`; `proactive_summarization_threshold`; `trajectory_config`; `tmux_pane_width`; `tmux_pane_height`; `record_terminal_session`; `store_all_messages`; `interleaved_thinking`; `llm_backend`; `llm_kwargs`; `llm_call_kwargs`; `api_base`; `model_info`; `extra_env`
- **Results to**: `_llm` and `_parser` consumed by later query/parse stages; `_prompt_template` and `_timeout_template` used when building agent prompts and timeout messaging; `_max_episodes` used by the main iteration loop as the run limit; `_session_id` and tmux dimensions used when creating terminal sessions; `_trajectory_steps` later appended and dumped by trajectory-writing stages; `_pending_completion`, `_pending_subagent_refs`, and `_pending_handoff_prompt` used by later loop control and summarization-handshake stages; `_api_request_times`, `_summarization_count`, `_n_episodes`, and `_subagent_metrics` surfaced in final run metadata
- **📊 Register interactions**: ✏️ writes `reg-pending-completion` — initialize completion confirmation state to False; ✏️ writes `reg-pending-handoff-prompt` — initialize pending summarization handoff prompt to None; ✏️ writes `reg-pending-subagent-refs` — initialize pending subagent refs to None; ✏️ writes `reg-n-episodes` — initialize iteration counter to zero; ✏️ writes `reg-summarization-count` — initialize summarization invocation counter to zero; ✏️ writes `reg-trajectory-steps` — initialize empty trajectory step list; ✏️ writes `reg-asciinema-markers` — initialize empty timestamped marker list; ✏️ writes `reg-subagent-metrics` — create separate subagent metrics accumulator; ✏️ writes `reg-api-request-times` — initialize empty API timing history

</details>


<details id="fn-terminus2_resolve_model_info">
<summary><b>Terminus2._resolve_model_info</b> — terminus_2.py:334-346 · Resolve constructor model metadata fallback</summary>

> **Stage context**: This helper runs during stage-1 while `Terminus2.__init__` converts constructor inputs into stable instance configuration. It decides what model metadata object the constructor should keep before `_init_llm` and later runtime stages rely on that configuration. Among this stage's helpers, it is the narrow policy point for `model_info`, complementing `__init__`'s broader setup work.

**What this code does**

`Terminus2._resolve_model_info` chooses the model metadata dictionary from `provided_model_info` and `model_name`. It returns the caller-supplied `provided_model_info` immediately when that argument is truthy; otherwise it checks whether `model_name` contains the hosted-vLLM marker string `"hosted_vllm"`. For that special case it emits a warning through `self.logger.warning` and still returns `None`, leaving later code to proceed with fallback metadata behavior. It does not write any agent fields.

**Interface · params / IO**

`(self, model_name: str | None, provided_model_info: dict | None) -> dict | None`

- params: `self`: `Terminus2` — agent instance providing `logger`; `model_name`: `str | None` — configured model identifier used for hosted-vLLM detection; `provided_model_info`: `dict | None` — optional caller-supplied metadata dictionary to prefer
- reads: `self.logger`
- returns: A model info `dict` when `provided_model_info` is supplied; otherwise `None`
- effects: Emits a warning log through `self.logger.warning` when `model_name` contains `"hosted_vllm"` and `provided_model_info` is missing

**Execution flow**

1. Check `provided_model_info` first; if it is truthy, return that dictionary unchanged.
2. If no model info was supplied, inspect `model_name` and look for the substring `"hosted_vllm"`.
3. When that hosted-vLLM pattern matches, call `self.logger.warning(...)` with guidance about setting `model_info` fields such as token limits and costs.
4. Return `None` as the fallback result when no explicit model info is available.

**Source**

```python
    def _resolve_model_info(
        self, model_name: str | None, provided_model_info: dict | None
    ) -> dict | None:
        if provided_model_info:
            return provided_model_info
        if model_name and "hosted_vllm" in model_name:
            self.logger.warning(
                "Model info is required when using hosted_vllm models. "
                "Please set `model_info` in your Terminus 2 configuration with "
                "`max_input_tokens`, `max_output_tokens`, and cost fields. "
                "Falling back to LiteLLM defaults, which may cause context or pricing issues."
            )
        return None
```

**Non-obvious design decisions**

- It gives absolute precedence to `provided_model_info`. That keeps constructor-supplied metadata authoritative and avoids second-guessing explicit caller configuration from `model_name` heuristics.
- It treats hosted-vLLM as a warn-and-continue case, not a hard failure. The warning text explains the risk—bad context sizing or pricing estimates—while still allowing startup to proceed with LiteLLM defaults.
- It uses a simple substring check on `model_name` (`"hosted_vllm" in model_name`) instead of schema validation or provider parsing. That keeps this helper narrowly scoped, but means its special handling only covers names that follow that convention.

**Relations**

- **Callers**: `Terminus2.__init__` during constructor-time configuration resolution
- **Core callees**: `self.logger.warning`
- **Config / state sources**: `model_name` constructor argument; `provided_model_info` constructor argument; `self.logger` instance logger
- **Results to**: Returned to `Terminus2.__init__` for storage in the agent's configuration state; Influences what metadata later LLM setup uses when `_init_llm` runs; Determines whether startup proceeds with explicit model metadata or `None`; Produces a constructor-time warning for hosted-vLLM configurations missing `model_info`
- **Related siblings**: `Terminus2.__init__` orchestrates this helper alongside `_init_llm` and `_get_parser` during stage-1

</details>


<details id="fn-terminus2_init_llm">
<summary><b>Terminus2._init_llm</b> — terminus_2.py:74-143 · LLM backend selector and constructor adapter</summary>

> **Stage context**: Within the configuration stage, `_init_llm` is the backend-specific factory for the agent's chat client. This entry only covers the constructor dispatch visible in `_init_llm` itself: it normalizes `llm_backend`, prepares constructor kwargs, and returns the chosen backend instance. It complements sibling helpers such as `Terminus2._resolve_model_info`, which supplies one of this function's inputs but is not invoked here.

**What this code does**

`Terminus2._init_llm` builds and returns a `BaseLLM`-compatible object from `llm_backend`, `model_name`, `temperature`, `collect_rollout_details`, `llm_kwargs`, and the LiteLLM-only settings. It shallow-copies `llm_kwargs`, injects `temperature` only when `temperature is not None`, and then dispatches to either `LiteLLM` or `TinkerLLM`. It does not read or write any `self._` state. For an unrecognized backend it raises `ValueError`; import errors or constructor errors from the selected backend also propagate.

**Interface · params / IO**

`(self, llm_backend: LLMBackend | str, model_name: str, temperature: float | None, collect_rollout_details: bool, llm_kwargs: dict | None, api_base: str | None, session_id: str | None, max_thinking_tokens: int | None, reasoning_effort: str | None, model_info: dict | None, use_responses_api: bool) -> BaseLLM`

- params: `llm_backend`: `LLMBackend | str` — Backend selector; normalized to a string value for branch matching; `model_name`: `str` — Model identifier passed through to the chosen backend constructor; `temperature`: `float | None` — Optional sampling temperature; added to constructor kwargs only when not `None`; `collect_rollout_details`: `bool` — Flag forwarded to both supported backends; `llm_kwargs`: `dict | None` — Optional extra constructor kwargs; shallow-copied with `dict(llm_kwargs or {})` and unpacked with `**constructor_kwargs`; `api_base`: `str | None` — LiteLLM API base URL; `session_id`: `str | None` — LiteLLM session identifier; `max_thinking_tokens`: `int | None` — LiteLLM extended-thinking token cap; `reasoning_effort`: `str | None` — LiteLLM reasoning-effort setting; `model_info`: `dict | None` — LiteLLM model metadata for custom models; `use_responses_api`: `bool` — LiteLLM Responses API toggle
- returns: The constructed backend instance: either a `LiteLLM(...)` result or a `TinkerLLM(...)` result
- effects: Imports `TinkerLLM` lazily inside the `LLMBackend.TINKER.value` branch; May trigger external side effects or exceptions from `LiteLLM(...)` or `TinkerLLM(...)` constructors; Raises `ValueError` when `llm_backend` does not match a supported backend value

**Execution flow**

1. Normalize `llm_backend` into `backend_value` by using `.value` when the input is an `LLMBackend` enum instance and leaving it unchanged otherwise.
2. Create `constructor_kwargs` as a shallow copy of `llm_kwargs` with `dict(llm_kwargs or {})`, then add `constructor_kwargs["temperature"] = temperature` only when `temperature is not None`.
3. If `backend_value` matches `LLMBackend.LITELLM.value`, construct and return `LiteLLM` with the shared inputs plus LiteLLM-only arguments such as `api_base`, `session_id`, `max_thinking_tokens`, `reasoning_effort`, `model_info`, and `use_responses_api`.
4. If `backend_value` matches `LLMBackend.TINKER.value`, import `TinkerLLM` inside that branch, then construct and return it with `model_name`, `collect_rollout_details`, and `**constructor_kwargs`.
5. For any other `backend_value`, raise `ValueError` whose message includes the original `llm_backend!r` and the supported string values from `[b.value for b in LLMBackend]`.

**Source**

```python
    def _init_llm(
        self,
        llm_backend: LLMBackend | str,
        model_name: str,
        temperature: float | None,
        collect_rollout_details: bool,
        llm_kwargs: dict | None,
        # LiteLLM-specific args
        api_base: str | None,
        session_id: str | None,
        max_thinking_tokens: int | None,
        reasoning_effort: str | None,
        model_info: dict | None,
        use_responses_api: bool,
    ) -> BaseLLM:
        """Initialize the LLM backend based on llm_backend parameter.

        Args:
            llm_backend: The LLM backend to use.
            model_name: Name of the model.
            temperature: Sampling temperature, if explicitly configured.
            collect_rollout_details: Whether to collect token IDs and logprobs.
            llm_kwargs: Additional kwargs passed to the LLM constructor.
            api_base: Base URL for LiteLLM API endpoint.
            session_id: Session ID for LiteLLM.
            max_thinking_tokens: Max thinking tokens for LiteLLM extended thinking.
            reasoning_effort: Reasoning effort level for LiteLLM.
            model_info: Model info dict for LiteLLM custom models.
            use_responses_api: Whether to use the Responses API.

        Returns:
            An initialized LLM instance.

        Raises:
            ValueError: If llm_backend is not a recognized backend.
        """
        # Normalize enum to string value for matching
        backend_value = (
            llm_backend.value if isinstance(llm_backend, LLMBackend) else llm_backend
        )
        constructor_kwargs = dict(llm_kwargs or {})
        if temperature is not None:
            constructor_kwargs["temperature"] = temperature

        match backend_value:
            case LLMBackend.LITELLM.value:
                return LiteLLM(
                    model_name=model_name,
                    api_base=api_base,
                    collect_rollout_details=collect_rollout_details,
                    session_id=session_id,
                    max_thinking_tokens=max_thinking_tokens,
                    reasoning_effort=reasoning_effort,
                    model_info=model_info,
                    use_responses_api=use_responses_api,
                    **constructor_kwargs,
                )
            case LLMBackend.TINKER.value:
                from harbor.llms.tinker import TinkerLLM

                return TinkerLLM(
                    model_name=model_name,
                    collect_rollout_details=collect_rollout_details,
                    **constructor_kwargs,
                )
            case _:
                raise ValueError(
                    f"Unknown llm_backend: {llm_backend!r}. "
                    f"Supported backends: {[b.value for b in LLMBackend]}"
                )
```

**Non-obvious design decisions**

- It normalizes enum inputs up front with `llm_backend.value if isinstance(llm_backend, LLMBackend) else llm_backend` so callers can pass either the enum or its raw string value without duplicating each backend branch.
- It copies `llm_kwargs` into `constructor_kwargs` before augmentation instead of mutating the caller's dict. That keeps `_init_llm` free to inject `temperature` without changing shared input state outside the function.
- It gates temperature injection with `if temperature is not None:`. This preserves the distinction between an omitted temperature and an explicit numeric setting; always passing a default would force backend behavior that the caller did not request.
- It imports `TinkerLLM` only inside the Tinker branch. That avoids making every call depend on `harbor.llms.tinker` being importable when the selected backend is actually LiteLLM.
- Its error message uses `llm_backend!r` rather than `backend_value` for the failing input, while the supported list comes from `[b.value for b in LLMBackend]`. That keeps diagnostics anchored to the caller's original argument but presents the accepted values in their normalized string form.

**Relations**

- **Callers**: Terminus2.__init__
- **Core callees**: `LiteLLM` constructor; `TinkerLLM` constructor; `dict(...)` for shallow-copying `llm_kwargs`
- **Config / state sources**: `llm_backend` argument; `model_name` argument; `temperature` argument; `collect_rollout_details` argument; `llm_kwargs` argument; `api_base` argument; `session_id` argument; `max_thinking_tokens` argument; `reasoning_effort` argument; `model_info` argument; `use_responses_api` argument
- **Results to**: Return value consumed by the caller as the selected LLM client; Backend constructor receives normalized and augmented `constructor_kwargs`
- **Related siblings**: Terminus2._resolve_model_info supplies a possible `model_info` input but is separate from this dispatch logic

</details>


<details id="fn-terminus2_get_parser">
<summary><b>Terminus2._get_parser</b> — terminus_2.py:376-385 · Parser selector for configured response format</summary>

> **Stage context**: This method is a small configuration helper on `Terminus2`. Its body only shows a dispatch on `self._parser_name` to choose a parser class, with no state mutation and no interaction with other helpers visible here.

**What this code does**

`Terminus2._get_parser` examines `self._parser_name` and returns a parser instance for the supported format names. It produces `TerminusJSONPlainParser()` when the name is `"json"` and `TerminusXMLPlainParser()` when the name is `"xml"`. For any other value, it raises `ValueError` with a message that includes the bad name and the allowed options.

**Interface · params / IO**

`(self)`

- params: `self`: `?` — owns the `_parser_name` configuration value
- reads: `self._parser_name`
- returns: `TerminusJSONPlainParser` when `self._parser_name == "json"`; `TerminusXMLPlainParser` when `self._parser_name == "xml"`; otherwise raises `ValueError` and does not return
- effects: instantiates a new `TerminusJSONPlainParser` or `TerminusXMLPlainParser` object; does not write any `self._` state; has no external side effects apart from a possible `ValueError`

**Execution flow**

1. Read `self._parser_name` and compare it to the supported string `"json"`.
2. If the value is `"json"`, return a new `TerminusJSONPlainParser()` instance.
3. Otherwise compare `self._parser_name` to the supported string `"xml"`.
4. If the value is `"xml"`, return a new `TerminusXMLPlainParser()` instance.
5. For any other value, raise `ValueError` with `self._parser_name` interpolated into `f"Unknown parser_name: {self._parser_name}. Use 'json' or 'xml'."`.

**Source**

```python
    def _get_parser(self):
        """Return the appropriate parser instance for this format."""
        if self._parser_name == "json":
            return TerminusJSONPlainParser()
        elif self._parser_name == "xml":
            return TerminusXMLPlainParser()
        else:
            raise ValueError(
                f"Unknown parser_name: {self._parser_name}. Use 'json' or 'xml'."
            )
```

**Non-obvious design decisions**

- The method accepts a closed set of parser names: only the two literal strings `"json"` and `"xml"` appear in the branches. Any other value follows the explicit failure path instead of falling back to a default parser.
- The error message names both the invalid `self._parser_name` value and the accepted options (`'json'` and `'xml'`). That makes the failure self-describing at the point where the exception is raised.

**Relations**

- **Callers**: unknown from this function body
- **Core callees**: TerminusJSONPlainParser; TerminusXMLPlainParser; ValueError
- **Config / state sources**: self._parser_name
- **Results to**: returns a parser object to the immediate caller; or raises `ValueError` instead of returning

</details>


<details id="fn-terminus2_get_prompt_template_path">
<summary><b>Terminus2._get_prompt_template_path</b> — terminus_2.py:387-396 · Prompt-template path selector by parser format</summary>

> **Stage context**: This helper is part of configuration setup because it turns the already-stored parser format in `self._parser_name` into a concrete template file path. Within this snippet, its role is narrow: choose one of two template filenames under the module's `templates` directory or fail fast for any other parser name.

**What this code does**

`Terminus2._get_prompt_template_path` returns a `pathlib.Path` to the prompt template file that matches `self._parser_name`. It reads `self._parser_name` and the module-global `__file__`, then builds a path under `Path(__file__).parent / "templates"`. It does not mutate instance state. For any parser name other than `"json"` or `"xml"`, it raises `ValueError` with the message shape `Unknown parser_name: <value>. Use 'json' or 'xml'.`.

**Interface · params / IO**

`(self) -> Path`

- params: `self`: `?` — Provides the configured parser name through `self._parser_name`
- reads: `self._parser_name`, `__file__`
- returns: A `Path` pointing to either `Path(__file__).parent / "templates" / "terminus-json-plain.txt"` or `Path(__file__).parent / "templates" / "terminus-xml-plain.txt"`

**Execution flow**

1. Check `self._parser_name` with an `if` branch for `"json"`.
2. If it is `"json"`, return `Path(__file__).parent / "templates" / "terminus-json-plain.txt"`.
3. Otherwise check `self._parser_name` with an `elif` branch for `"xml"`.
4. If it is `"xml"`, return `Path(__file__).parent / "templates" / "terminus-xml-plain.txt"`.
5. If neither branch matches, enter the `else` branch and raise `ValueError` that embeds the bad `self._parser_name` value and names the allowed options.

**Source**

```python
    def _get_prompt_template_path(self) -> Path:
        """Return the path to the prompt template for this format."""
        if self._parser_name == "json":
            return Path(__file__).parent / "templates" / "terminus-json-plain.txt"
        elif self._parser_name == "xml":
            return Path(__file__).parent / "templates" / "terminus-xml-plain.txt"
        else:
            raise ValueError(
                f"Unknown parser_name: {self._parser_name}. Use 'json' or 'xml'."
            )
```

**Non-obvious design decisions**

- The method anchors lookup to `Path(__file__).parent` instead of the process working directory. That keeps template resolution tied to the module's install location and avoids dependence on where the caller launched Python.
- It hard-codes the two supported parser names in both the branch guard and the error message. That makes the accepted values explicit at the decision point, but it also means adding a new parser requires updating this method.
- The failure path includes the actual `self._parser_name` value in `ValueError`. That gives immediate debugging context instead of a generic unsupported-format error.

**Relations**

- **Callers**: `Terminus2.__init__`
- **Core callees**: `Path` from `pathlib`
- **Config / state sources**: `self._parser_name`; module-global `__file__`
- **Results to**: The returned `Path` value; The caller that requested the template location
- **Related siblings**: `Terminus2._get_parser` also branches on `self._parser_name` and rejects unsupported values

</details>


<details id="fn-terminus2_get_timeout_template_path">
<summary><b>Terminus2._get_timeout_template_path</b> — terminus_2.py:398-400 · Module-relative timeout template path helper</summary>

> **Stage context**: Within Configuration Crystallization, this helper supplies one filesystem location needed during setup. In this function's own source, it only computes that location and returns it. It sits alongside other configuration helpers that turn fixed inputs into concrete resources.

**What this code does**

`Terminus2._get_timeout_template_path` returns a `Path` for the timeout template file. It takes only `self`, reads no `self._` attributes, and builds the result from the module's `__file__` directory plus the fixed `templates/timeout.txt` suffix. It has no side effects.

**Interface · params / IO**

`(self) -> Path`

- params: `self`: `?` — Bound `Terminus2` instance; unused by the method body
- returns: A `pathlib.Path` equal to `Path(__file__).parent / "templates" / "timeout.txt"`

**Execution flow**

1. Wrap the module-global `__file__` in `Path(__file__)` and take its `parent` directory.
2. Append the fixed path segments `"templates"` and `"timeout.txt"`, then return the resulting `Path`.

**Source**

```python
    def _get_timeout_template_path(self) -> Path:
        """Return the path to the timeout template for this format."""
        return Path(__file__).parent / "templates" / "timeout.txt"
```

**Non-obvious design decisions**

- It anchors the template location to module `__file__` instead of any `self` field. That makes the result depend on the code location shown in this function, not on instance configuration.
- It hard-codes the suffix `templates/timeout.txt` in the return expression. This keeps the helper focused on one specific resource and leaves no per-call variation.

**Relations**

- **Callers**: Configuration-stage code that needs the timeout template path
- **Core callees**: `Path` from `pathlib`; `Path.parent`; `Path.__truediv__` for path joining
- **Config / state sources**: Module-global `__file__`; String literal `"templates"`; String literal `"timeout.txt"`
- **Results to**: The returned `Path` object to the immediate caller; Code that opens or reads the timeout template file

</details>
