# Extension-backed tool runtimes and namespaces  `stage-14.3.3`

This stage sits in the per-turn tool setup and execution path, bridging the core runtime to extension-backed, deferred, and specialized namespaces that are not hardwired into the minimal core. Its center is spec_plan.rs, which decides which tools exist for the current turn and publishes both the dispatch registry and the model-visible specs; hosted_spec.rs fills in hosted-model tool descriptors such as web search and image generation.

Several adapters make non-core tools behave like native ones. dynamic.rs and tools/src/dynamic_tool.rs expose thread-scoped dynamic tools and round-trip their calls through session events. extension_tools.rs runs extension-provided executors, while tool_search.rs plus tool_search_spec.rs index deferred tools and expose synthetic discovery. view_image, get_context_remaining, and the small spec files define focused built-ins like image inspection, plan updates, new-context, and agent-jobs schemas.

Code-mode spans code-mode/src and core/src/tools/code_mode/*: it creates the restricted JS runtime, exposes callbacks, and maps exec/wait tool calls into code-cell lifecycle events. The extension crates then supply concrete namespaces: web search, image generation, goals, memories, and skills, each registering availability, schemas, execution, and output shaping. Together these parts let the planner assemble a turn-specific toolbox that the model can discover, call, and extend safely.

## Files in this stage

### Tool planning and core adapters
These files build the per-turn tool plan and provide the core adapters and specs for dynamic, extension-backed, hosted, and helper tools exposed through the runtime.

### `core/src/tools/spec_plan.rs`

`orchestration` · `startup / turn setup when building the tool router`

This file is the tool-planning hub for a turn. It defines `PlannedTools`, a mutable accumulator of runtime handlers and hosted-only specs, and `CoreToolPlanContext`, which packages the turn context plus MCP, extension, dynamic-tool, and tool-search inputs. `build_tool_router` and `build_tool_specs_and_registry` drive the overall flow: gather tool sources, append a deferred-tool search executor when needed, prepend code-mode wrapper tools, then build both the dispatch `ToolRegistry` and the model-visible `ToolSpec` list.

The planner contains many feature gates and exposure rules. Shell tools are selected based on environment availability, model shell type, and whether unified exec is enabled; in unified-exec mode the legacy shell tool remains registered but hidden for dispatch compatibility. Hosted web search and image generation are emitted only when provider capabilities, feature flags, and extension-tool availability warrant them. Collaboration tools vary by multi-agent version, namespace-tool support, thread-depth limits, and worker-session source. MCP tools, dynamic tools, and extension tools are adapted into core runtimes, with duplicate-name suppression and warnings for invalid or conflicting tools.

Several helpers shape the final model-visible surface. `spec_for_model_request` augments nested tools for code mode, `merge_into_namespaces` coalesces namespace specs and fills default descriptions, and `build_code_mode_executors` synthesizes the code-mode execute/wait tools from the currently enabled runtime specs. `MultiAgentV2NamespaceOverride` wraps handlers so V2 multi-agent tools can be exposed under a configurable namespace while delegating all runtime behavior to the underlying handler.

#### Function details

##### `PlannedTools::add`  (lines 108–113)

```
fn add(&mut self, handler: T)
```

**Purpose**: Adds a concrete core runtime handler to the planned runtime list by boxing it behind `Arc<dyn CoreToolRuntime>`. It is the standard insertion path for most built-in handlers.

**Data flow**: Takes an owned handler implementing `CoreToolRuntime + 'static`, wraps it in `Arc::new`, and pushes it into `self.runtimes`.

**Call relations**: Used throughout the planner when adding shell, utility, collaboration, MCP, dynamic, and extension-adapted tools.

*Call graph*: called by 7 (add_collaboration_tools, add_core_utility_tools, add_dynamic_tools, add_mcp_resource_tools, add_mcp_runtime_tools, add_shell_tools, append_extension_tool_executors); 1 external calls (new).


##### `PlannedTools::add_arc`  (lines 115–117)

```
fn add_arc(&mut self, handler: PlannedRuntime)
```

**Purpose**: Adds an already boxed runtime handler to the planned runtime list. This avoids re-wrapping handlers that were already constructed as trait objects.

**Data flow**: Takes a `PlannedRuntime` (`Arc<dyn CoreToolRuntime>`) and pushes it into `self.runtimes`.

**Call relations**: Used when adding prewrapped handlers such as tool-search executors and namespace-overridden multi-agent handlers.

*Call graph*: called by 2 (add_collaboration_tools, append_tool_search_executor).


##### `PlannedTools::add_with_exposure`  (lines 119–125)

```
fn add_with_exposure(&mut self, handler: T, exposure: ToolExposure)
```

**Purpose**: Adds a runtime handler while overriding its exposure level. This is how the planner marks tools as hidden, deferred, or direct-model-only without changing the handler implementation.

**Data flow**: Takes a concrete handler and a `ToolExposure`, wraps the handler in `Arc`, passes it through `override_tool_exposure`, and pushes the resulting runtime into `self.runtimes`.

**Call relations**: Called by helper methods and planning branches that need to register hidden legacy tools, deferred collaboration tools, or direct-model-only utilities.

*Call graph*: calls 1 internal fn (override_tool_exposure); called by 4 (add_dispatch_only, add_collaboration_tools, add_core_utility_tools, add_mcp_runtime_tools); 1 external calls (new).


##### `PlannedTools::add_dispatch_only`  (lines 127–132)

```
fn add_dispatch_only(&mut self, handler: T)
```

**Purpose**: Registers a handler for dispatch but hides it from the model-visible tool list. It is a convenience wrapper for `ToolExposure::Hidden`.

**Data flow**: Takes a concrete handler and forwards it to `add_with_exposure(handler, ToolExposure::Hidden)`.

**Call relations**: Used by `add_shell_tools` to keep the legacy shell tool available for dispatch while unified exec is model-visible.

*Call graph*: calls 1 internal fn (add_with_exposure); called by 1 (add_shell_tools).


##### `PlannedTools::add_hosted_spec`  (lines 134–136)

```
fn add_hosted_spec(&mut self, spec: ToolSpec)
```

**Purpose**: Adds a hosted-only `ToolSpec` that has no corresponding local runtime handler. This is used for provider-hosted tools such as hosted web search or image generation.

**Data flow**: Pushes the provided `ToolSpec` into `self.hosted_specs`.

**Call relations**: Called from `add_tool_sources` for each hosted model tool spec returned by `hosted_model_tool_specs`.

*Call graph*: called by 1 (add_tool_sources).


##### `PlannedTools::runtimes`  (lines 138–140)

```
fn runtimes(&self) -> &[PlannedRuntime]
```

**Purpose**: Returns the currently accumulated runtime handlers as a slice. This lets later planning phases inspect already-added tools without taking ownership.

**Data flow**: Returns `&self.runtimes`.

**Call relations**: Used by extension-tool planning, deferred-tool search planning, and code-mode executor synthesis.

*Call graph*: called by 3 (append_extension_tool_executors, append_tool_search_executor, prepend_code_mode_executors).


##### `build_tool_router`  (lines 157–165)

```
fn build_tool_router(
    turn_context: &TurnContext,
    params: ToolRouterParams<'_>,
    tool_search_handler_cache: &ToolSearchHandlerCache,
) -> ToolRouter
```

**Purpose**: Builds the final `ToolRouter` for a turn by producing both the registry and the model-visible specs, then combining them. It is the top-level entry point for tool planning.

**Data flow**: Takes `TurnContext`, `ToolRouterParams`, and a `ToolSearchHandlerCache`, calls `build_tool_specs_and_registry`, then passes the resulting registry and specs to `ToolRouter::from_parts` and returns the router.

**Call relations**: Called by higher-level turn setup (`from_turn_context`) to create the dispatch/router object used during tool invocation.

*Call graph*: calls 2 internal fn (from_parts, build_tool_specs_and_registry); called by 1 (from_turn_context).


##### `build_tool_specs_and_registry`  (lines 168–198)

```
fn build_tool_specs_and_registry(
    turn_context: &TurnContext,
    params: ToolRouterParams<'_>,
    tool_search_handler_cache: &ToolSearchHandlerCache,
) -> (Vec<ToolSpec>, ToolRegistry)
```

**Purpose**: Runs the full planning pipeline that gathers tool sources, adds search and code-mode wrappers, and produces both model-visible specs and the dispatch registry. It is the main orchestration function in this file.

**Data flow**: Destructures `ToolRouterParams`, builds a default agent-type description string, constructs `CoreToolPlanContext` including wait-timeout options from `wait_agent_timeout_options`, initializes `PlannedTools::default()`, calls `add_tool_sources`, `append_tool_search_executor`, and `prepend_code_mode_executors`, then calls `build_model_visible_specs_and_registry` and returns its `(Vec<ToolSpec>, ToolRegistry)` result.

**Call relations**: Invoked by `build_tool_router`; it delegates source collection to `add_tool_sources`, deferred search insertion to `append_tool_search_executor`, and code-mode wrapping to `prepend_code_mode_executors`.

*Call graph*: calls 5 internal fn (add_tool_sources, append_tool_search_executor, build_model_visible_specs_and_registry, prepend_code_mode_executors, wait_agent_timeout_options); called by 1 (build_tool_router); 3 external calls (default, build, new).


##### `build_model_visible_specs_and_registry`  (lines 201–239)

```
fn build_model_visible_specs_and_registry(
    turn_context: &TurnContext,
    planned_tools: PlannedTools,
) -> (Vec<ToolSpec>, ToolRegistry)
```

**Purpose**: Converts the accumulated planned runtimes and hosted specs into the final model-visible tool spec list and dispatch registry. It deduplicates tool names, applies exposure rules, merges namespaces, and filters namespace specs when unsupported.

**Data flow**: Consumes `PlannedTools`, iterates over `runtimes`, tracks seen tool names in a `HashSet`, skips duplicates, reads each runtime’s exposure and spec, filters out hidden-by-code-mode-only tools, transforms visible specs through `spec_for_model_request`, and appends hosted specs. It builds a `ToolRegistry` from all runtimes, merges namespace specs with `merge_into_namespaces`, filters namespace specs out when `namespace_tools_enabled(turn_context)` is false, and returns `(model_visible_specs, registry)`.

**Call relations**: Called at the end of `build_tool_specs_and_registry`; it depends on `spec_for_model_request`, `merge_into_namespaces`, and code-mode visibility helpers.

*Call graph*: calls 4 internal fn (from_tools, is_hidden_by_code_mode_only, merge_into_namespaces, spec_for_model_request); called by 1 (build_tool_specs_and_registry); 2 external calls (new, new).


##### `spec_for_model_request`  (lines 241–258)

```
fn spec_for_model_request(
    turn_context: &TurnContext,
    exposure: ToolExposure,
    tool_name: &ToolName,
    spec: ToolSpec,
) -> ToolSpec
```

**Purpose**: Adjusts a runtime’s `ToolSpec` before exposing it to the model, primarily by augmenting nested tools for code mode when appropriate. It leaves specs unchanged outside those conditions.

**Data flow**: Consumes `TurnContext`, a `ToolExposure`, a `ToolName`, and a `ToolSpec`. If the turn is in `CodeMode` or `CodeModeOnly`, the exposure is not `DirectModelOnly`, the tool is not excluded from code mode, and the spec name is recognized as a code-mode nested tool, it returns `codex_tools::augment_tool_spec_for_code_mode(spec)`; otherwise it returns the original spec.

**Call relations**: Used by `build_model_visible_specs_and_registry` for each directly exposed runtime spec.

*Call graph*: calls 2 internal fn (is_excluded_from_code_mode, name); called by 1 (build_model_visible_specs_and_registry); 3 external calls (is_code_mode_nested_tool, augment_tool_spec_for_code_mode, matches!).


##### `hosted_model_tool_specs`  (lines 260–295)

```
fn hosted_model_tool_specs(context: &CoreToolPlanContext<'_>) -> Vec<ToolSpec>
```

**Purpose**: Computes the hosted provider-side tool specs that should be exposed for the current turn, such as hosted web search and hosted image generation. It suppresses hosted tools when responses-lite or standalone extension tools make them unnecessary.

**Data flow**: Reads provider capabilities, model info, feature flags, extension executors, and web-search config from `CoreToolPlanContext`. It returns an empty vector immediately for responses-lite. Otherwise it determines whether standalone web search is available, derives an optional hosted web-search mode/config, calls `create_web_search_tool`, conditionally pushes the result, then conditionally pushes `create_image_generation_tool("png")` when image generation is enabled and no standalone extension tool is available. Returns the collected `Vec<ToolSpec>`.

**Call relations**: Called by `add_tool_sources`; it depends on `standalone_web_search_enabled`, `image_generation_tool_enabled`, and `standalone_image_generation_available`.

*Call graph*: calls 5 internal fn (create_image_generation_tool, create_web_search_tool, image_generation_tool_enabled, standalone_image_generation_available, standalone_web_search_enabled); called by 1 (add_tool_sources); 1 external calls (new).


##### `search_tool_enabled`  (lines 297–299)

```
fn search_tool_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Reports whether the current model supports the deferred-tool search tool. This is a simple capability gate.

**Data flow**: Reads `turn_context.model_info.supports_search_tool` and returns it.

**Call relations**: Used by collaboration-tool exposure logic, code-mode deferred guidance, extension-tool reservation, and deferred search-tool insertion.

*Call graph*: called by 5 (built_tools, add_collaboration_tools, append_extension_tool_executors, append_tool_search_executor, build_code_mode_executors).


##### `tool_suggest_enabled`  (lines 301–306)

```
fn tool_suggest_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether plugin/tool suggestion features should be enabled for the turn. It requires three feature flags to be on simultaneously.

**Data flow**: Reads the current feature set from `turn_context.features.get()` and returns true only when `ToolSuggest`, `Apps`, and `Plugins` are all enabled.

**Call relations**: Used by `add_core_utility_tools` to decide whether to expose plugin discovery and install-request tools.

*Call graph*: called by 2 (built_tools, add_core_utility_tools).


##### `namespace_tools_enabled`  (lines 308–310)

```
fn namespace_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Reports whether the provider supports namespace-style tool specs. This controls namespace merging and whether namespace-only tools are exposed.

**Data flow**: Reads `turn_context.provider.capabilities().namespace_tools` and returns it.

**Call relations**: Used across planning for namespace filtering, standalone web/image extension visibility, collaboration namespacing, and deferred search-tool insertion.

*Call graph*: called by 5 (add_collaboration_tools, append_extension_tool_executors, append_tool_search_executor, standalone_image_generation_model_visible, standalone_web_search_enabled).


##### `multi_agent_v2_enabled`  (lines 312–314)

```
fn multi_agent_v2_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether the turn is configured for multi-agent V2. This selects the collaboration-tool family and timeout source.

**Data flow**: Returns whether `turn_context.multi_agent_version == MultiAgentVersion::V2`.

**Call relations**: Used by collaboration-tool planning and wait-timeout selection.

*Call graph*: called by 2 (add_collaboration_tools, wait_agent_timeout_options).


##### `collab_tools_enabled`  (lines 316–325)

```
fn collab_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether collaboration/sub-agent tools should be available in the current turn. For V1 it enforces the thread spawn depth limit; for V2 it is always enabled; for disabled mode it is off.

**Data flow**: Matches on `turn_context.multi_agent_version`. Returns false for `Disabled`, true for `V2`, and for `V1` computes the next thread spawn depth from `turn_context.session_source`, compares it against `turn_context.config.agent_max_depth` using `exceeds_thread_spawn_depth_limit`, and returns the negated overflow result.

**Call relations**: Used by `add_collaboration_tools` and by `agent_jobs_tools_enabled`.

*Call graph*: called by 2 (add_collaboration_tools, agent_jobs_tools_enabled); 2 external calls (exceeds_thread_spawn_depth_limit, next_thread_spawn_depth).


##### `agent_jobs_tools_enabled`  (lines 327–329)

```
fn agent_jobs_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether CSV-based agent-job tools should be exposed. They require both the `SpawnCsv` feature and collaboration tools to be enabled.

**Data flow**: Reads the `SpawnCsv` feature flag and combines it with `collab_tools_enabled(turn_context)`.

**Call relations**: Used by `add_collaboration_tools` and `agent_jobs_worker_tools_enabled`.

*Call graph*: calls 1 internal fn (collab_tools_enabled); called by 2 (add_collaboration_tools, agent_jobs_worker_tools_enabled).


##### `agent_jobs_worker_tools_enabled`  (lines 331–338)

```
fn agent_jobs_worker_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether worker-only agent-job tools should be exposed in the current session. They are only available inside sub-agent sessions whose label starts with `agent_job:`.

**Data flow**: Calls `agent_jobs_tools_enabled(turn_context)` and additionally matches `turn_context.session_source` against `SessionSource::SubAgent(SubAgentSource::Other(label))` with `label.starts_with("agent_job:")`.

**Call relations**: Used by `add_collaboration_tools` to decide whether to add `ReportAgentJobResultHandler`.

*Call graph*: calls 1 internal fn (agent_jobs_tools_enabled); called by 1 (add_collaboration_tools); 1 external calls (matches!).


##### `image_generation_tool_enabled`  (lines 340–346)

```
fn image_generation_tool_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether hosted image generation should be considered at all for the turn. It requires runtime support plus the `ImageGeneration` feature flag.

**Data flow**: Calls `image_generation_runtime_enabled(turn_context)` and combines it with `turn_context.features.get().enabled(Feature::ImageGeneration)`.

**Call relations**: Used by `hosted_model_tool_specs`.

*Call graph*: calls 1 internal fn (image_generation_runtime_enabled); called by 1 (hosted_model_tool_specs).


##### `image_generation_runtime_enabled`  (lines 348–358)

```
fn image_generation_runtime_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether the runtime/provider/model combination can support image generation. It requires Codex-backed auth, provider capability, and image input modality support.

**Data flow**: Reads `turn_context.auth_manager`, provider capabilities, and `turn_context.model_info.input_modalities`, returning true only when auth uses the Codex backend, the provider supports image generation, and image input is supported.

**Call relations**: Used by both hosted and standalone image-generation visibility helpers.

*Call graph*: called by 2 (image_generation_tool_enabled, standalone_image_generation_model_visible).


##### `standalone_image_generation_model_visible`  (lines 360–370)

```
fn standalone_image_generation_model_visible(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether the standalone extension-based image generation tool should be visible to the model. It depends on runtime support, namespace-tool support, responses-lite behavior, and the `ImageGenExt` feature flag.

**Data flow**: Returns false immediately if `image_generation_runtime_enabled` or `namespace_tools_enabled` is false. If responses-lite is enabled, returns true. Otherwise returns whether `Feature::ImageGenExt` is enabled.

**Call relations**: Used by extension-tool planning and by `standalone_image_generation_available`.

*Call graph*: calls 2 internal fn (image_generation_runtime_enabled, namespace_tools_enabled); called by 2 (append_extension_tool_executors, standalone_image_generation_available).


##### `standalone_image_generation_available`  (lines 372–380)

```
fn standalone_image_generation_available(
    turn_context: &TurnContext,
    extension_tools: &[Arc<dyn ToolExecutor<ExtensionToolCall>>],
) -> bool
```

**Purpose**: Checks whether a standalone extension executor for image generation is both model-visible and actually present. This suppresses the hosted fallback when the extension tool can serve the role.

**Data flow**: Calls `standalone_image_generation_model_visible(turn_context)` and, if true, scans `extension_tools` for an executor whose tool name is `image_gen.imagegen`.

**Call relations**: Used by `hosted_model_tool_specs` to decide whether to emit hosted image generation.

*Call graph*: calls 1 internal fn (standalone_image_generation_model_visible); called by 1 (hosted_model_tool_specs).


##### `wait_agent_timeout_options`  (lines 382–396)

```
fn wait_agent_timeout_options(turn_context: &TurnContext) -> WaitAgentTimeoutOptions
```

**Purpose**: Selects the timeout bounds used by wait-agent tools. V2 uses configurable values from turn config; older modes use fixed defaults.

**Data flow**: If `multi_agent_v2_enabled(turn_context)` is true, returns `WaitAgentTimeoutOptions` populated from `turn_context.config.multi_agent_v2`; otherwise returns one populated from `DEFAULT_WAIT_TIMEOUT_MS`, `MIN_WAIT_TIMEOUT_MS`, and `MAX_WAIT_TIMEOUT_MS`.

**Call relations**: Called during `build_tool_specs_and_registry` to populate `CoreToolPlanContext`.

*Call graph*: calls 1 internal fn (multi_agent_v2_enabled); called by 1 (build_tool_specs_and_registry).


##### `agent_type_description`  (lines 398–409)

```
fn agent_type_description(
    turn_context: &TurnContext,
    default_agent_type_description: &str,
) -> String
```

**Purpose**: Builds the descriptive text for agent-type selection in spawn-agent tools, falling back to a default description when no configured roles produce output. This keeps spawn-agent specs informative even without custom roles.

**Data flow**: Calls `crate::agent::role::spawn_tool_spec::build(&turn_context.config.agent_roles)`. If the resulting string is empty, returns `default_agent_type_description.to_string()`, otherwise returns the generated description.

**Call relations**: Used by `add_collaboration_tools` when constructing both V1 and V2 spawn-agent handlers.

*Call graph*: called by 1 (add_collaboration_tools); 1 external calls (build).


##### `is_hidden_by_code_mode_only`  (lines 411–421)

```
fn is_hidden_by_code_mode_only(
    turn_context: &TurnContext,
    tool_name: &ToolName,
    exposure: ToolExposure,
) -> bool
```

**Purpose**: Determines whether a tool should be hidden from the model-visible spec list in `CodeModeOnly` because it is represented through the synthesized code-mode wrapper instead. This prevents duplicate nested-tool exposure.

**Data flow**: Checks whether `turn_context.tool_mode == ToolMode::CodeModeOnly`, exposure is not `DirectModelOnly`, and the tool’s code-mode name is recognized as a nested code-mode tool via `codex_tools::code_mode_name_for_tool_name` and `codex_code_mode::is_code_mode_nested_tool`.

**Call relations**: Used by `build_model_visible_specs_and_registry` when filtering directly exposed runtime specs.

*Call graph*: called by 1 (build_model_visible_specs_and_registry); 2 external calls (is_code_mode_nested_tool, code_mode_name_for_tool_name).


##### `is_excluded_from_code_mode`  (lines 423–431)

```
fn is_excluded_from_code_mode(turn_context: &TurnContext, tool_name: &ToolName) -> bool
```

**Purpose**: Checks whether a tool’s namespace is explicitly excluded from code mode by configuration. This lets deployments suppress entire namespaces from code-mode wrappers.

**Data flow**: Reads `tool_name.namespace` and returns true when it exists and is contained in `turn_context.config.code_mode.excluded_tool_namespaces`.

**Call relations**: Used by `spec_for_model_request` and `build_code_mode_executors`.

*Call graph*: called by 2 (build_code_mode_executors, spec_for_model_request).


##### `build_code_mode_executors`  (lines 433–493)

```
fn build_code_mode_executors(
    turn_context: &TurnContext,
    executors: &[Arc<dyn CoreToolRuntime>],
) -> Vec<Arc<dyn CoreToolRuntime>>
```

**Purpose**: Synthesizes the code-mode execute and wait handlers from the currently planned runtime specs. It collects nested tool specs, computes namespace descriptions, determines whether deferred-tool guidance should be shown, and sorts enabled tools for stable presentation.

**Data flow**: If the turn is not in `CodeMode` or `CodeModeOnly`, returns an empty vector. Otherwise it iterates over the provided executors, skipping `DirectModelOnly`, `Hidden`, and code-mode-excluded tools. It collects each executor’s spec into `code_mode_nested_tool_specs`; non-deferred specs also go into `exec_prompt_tool_specs`, while deferred specs may set `deferred_tools_available` if search-tool guidance is enabled and the spec yields code-mode exec prompt definitions. It computes namespace descriptions with `code_mode_namespace_descriptions`, collects and sorts enabled tool definitions with `collect_code_mode_exec_prompt_tool_definitions` and `compare_code_mode_tools`, then returns two boxed runtimes: `CodeModeExecuteHandler::new(create_code_mode_tool(...), code_mode_nested_tool_specs)` and `CodeModeWaitHandler`.

**Call relations**: Called by `prepend_code_mode_executors` after all ordinary runtimes have been planned.

*Call graph*: calls 3 internal fn (code_mode_namespace_descriptions, is_excluded_from_code_mode, search_tool_enabled); called by 1 (prepend_code_mode_executors); 5 external calls (new, collect_code_mode_exec_prompt_tool_definitions, matches!, once, vec!).


##### `merge_into_namespaces`  (lines 495–539)

```
fn merge_into_namespaces(specs: Vec<ToolSpec>) -> Vec<ToolSpec>
```

**Purpose**: Merges multiple namespace `ToolSpec`s with the same namespace name into a single namespace spec, sorts tools within each namespace, and fills in default namespace descriptions when missing. This normalizes the final model-visible tool surface.

**Data flow**: Consumes a vector of `ToolSpec`. It iterates through specs, tracking namespace names to indices in a `BTreeMap`. When encountering a duplicate namespace, it appends tools into the existing namespace and prefers a non-empty description if the existing one is blank. Non-namespace specs are pushed through unchanged. After merging, it iterates over merged namespace specs, sorts their `tools` by function name, and fills blank descriptions using `default_namespace_description`. Returns the merged vector.

**Call relations**: Used by `build_model_visible_specs_and_registry` before namespace filtering.

*Call graph*: called by 1 (build_model_visible_specs_and_registry); 5 external calls (new, with_capacity, default_namespace_description, Namespace, unreachable!).


##### `code_mode_namespace_descriptions`  (lines 541–561)

```
fn code_mode_namespace_descriptions(
    specs: &[ToolSpec],
) -> BTreeMap<String, codex_code_mode::ToolNamespaceDescription>
```

**Purpose**: Extracts namespace names and descriptions from a set of tool specs for use in code-mode tool ordering and prompt generation. It preserves the first non-empty description seen for each namespace.

**Data flow**: Iterates over `specs`, filters `ToolSpec::Namespace`, inserts or updates entries in a `BTreeMap<String, ToolNamespaceDescription>`, and returns the map.

**Call relations**: Called by `build_code_mode_executors`, and its output is later used by `compare_code_mode_tools`.

*Call graph*: called by 1 (build_code_mode_executors); 1 external calls (new).


##### `add_tool_sources`  (lines 564–575)

```
fn add_tool_sources(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Runs the source-collection phase of planning by adding all core, MCP, collaboration, extension, dynamic, and hosted tools into `PlannedTools`. It is the central fan-out point for tool-source assembly.

**Data flow**: Calls `add_shell_tools`, `add_mcp_resource_tools`, `add_core_utility_tools`, `add_collaboration_tools`, `add_mcp_runtime_tools`, `add_extension_tools`, and `add_dynamic_tools` in sequence, then iterates over `hosted_model_tool_specs(context)` and pushes each hosted spec with `add_hosted_spec`.

**Call relations**: Called by `build_tool_specs_and_registry` before deferred search and code-mode wrappers are added.

*Call graph*: calls 9 internal fn (add_hosted_spec, add_collaboration_tools, add_core_utility_tools, add_dynamic_tools, add_extension_tools, add_mcp_resource_tools, add_mcp_runtime_tools, add_shell_tools, hosted_model_tool_specs); called by 1 (build_tool_specs_and_registry).


##### `standalone_web_search_enabled`  (lines 577–584)

```
fn standalone_web_search_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether the standalone extension-based web search tool should be considered visible. It requires namespace-tool support and either responses-lite mode or the `StandaloneWebSearch` feature flag.

**Data flow**: Returns true when `namespace_tools_enabled(turn_context)` is true and either `turn_context.model_info.use_responses_lite` is true or `Feature::StandaloneWebSearch` is enabled.

**Call relations**: Used by hosted web-search suppression and extension-tool filtering.

*Call graph*: calls 1 internal fn (namespace_tools_enabled); called by 2 (append_extension_tool_executors, hosted_model_tool_specs).


##### `add_shell_tools`  (lines 586–624)

```
fn add_shell_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds the shell-related tool handlers appropriate for the current environment mode, model shell configuration, and feature flags. It chooses between unified exec, legacy shell command, or no shell tool at all.

**Data flow**: Reads environment mode, feature flags, login-shell permission, and whether multiple environments are active. If the environment mode has no environment, it returns early. It builds `ShellCommandHandlerOptions`, then matches `shell_type_for_model_and_features`. For `UnifiedExec`, it adds `ExecCommandHandler` configured with shell/environment-id options, adds `WriteStdinHandler`, and registers `ShellCommandHandler` as hidden dispatch-only. For disabled shell type it adds nothing. For default/local/shell-command modes it adds a visible `ShellCommandHandler`.

**Call relations**: Called by `add_tool_sources`; it is the planner branch that wires shell and unified-exec handlers into the runtime set.

*Call graph*: calls 5 internal fn (new, new, add, add_dispatch_only, unified_exec_should_include_shell_parameter); called by 1 (add_tool_sources); 3 external calls (shell_command_backend_for_features, shell_type_for_model_and_features, matches!).


##### `unified_exec_should_include_shell_parameter`  (lines 626–635)

```
fn unified_exec_should_include_shell_parameter(turn_context: &TurnContext) -> bool
```

**Purpose**: Determines whether the unified-exec tool spec should expose an explicit shell parameter. The parameter is omitted for local zsh-fork-only setups but retained when any remote environment is present.

**Data flow**: Returns true unless `turn_context.unified_exec_shell_mode` is `UnifiedExecShellMode::ZshFork(_)` and all turn environments are local; in that zsh-fork-local-only case it returns false.

**Call relations**: Used by `add_shell_tools` when constructing `ExecCommandHandlerOptions`.

*Call graph*: called by 1 (add_shell_tools); 1 external calls (matches!).


##### `add_mcp_resource_tools`  (lines 637–643)

```
fn add_mcp_resource_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds the generic MCP resource browsing tools when MCP tools are present for the turn. These are separate from runtime wrappers for individual MCP tools.

**Data flow**: Checks whether `context.mcp_tools.is_some()`. If so, adds `ListMcpResourcesHandler`, `ListMcpResourceTemplatesHandler`, and `ReadMcpResourceHandler` to `planned_tools`.

**Call relations**: Called by `add_tool_sources`.

*Call graph*: calls 1 internal fn (add); called by 1 (add_tool_sources).


##### `add_core_utility_tools`  (lines 645–710)

```
fn add_core_utility_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds the non-shell core utility tools controlled by feature flags and environment availability, including planning, permission requests, token-budget tools, sleep, plugin suggestion/install, apply-patch, test sync, and image viewing.

**Data flow**: Always adds `PlanHandler`. Conditionally adds `RequestUserInputHandler` as direct-model-only, `RequestPermissionsHandler`, `NewContextWindowHandler` and `GetContextRemainingHandler`, `SleepHandler`, plugin discovery/install handlers when `tool_suggest_enabled` and discoverable tools exist, `ApplyPatchHandler` when an environment exists and the model supports apply-patch, `TestSyncHandler` when explicitly listed in experimental supported tools, and `ViewImageHandler` when an environment exists. It computes environment-id inclusion and image-detail capability from turn context where needed.

**Call relations**: Called by `add_tool_sources`; it is the main source of miscellaneous built-in utility handlers.

*Call graph*: calls 7 internal fn (new, new, new, new, add, add_with_exposure, tool_suggest_enabled); called by 1 (add_tool_sources); 4 external calls (can_request_original_image_detail, collect_request_plugin_install_entries, request_user_input_available_modes, matches!).


##### `add_collaboration_tools`  (lines 712–798)

```
fn add_collaboration_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds multi-agent collaboration tools and CSV agent-job tools according to multi-agent version, namespace support, exposure rules, and worker-session context. It encapsulates the most complex feature-gated planning branch in the file.

**Data flow**: Checks `collab_tools_enabled(turn_context)`. For V2, it computes exposure, optional namespace override, and agent-type description, then adds namespace-overridden `SpawnAgentHandlerV2`, `SendMessageHandlerV2`, `FollowupTaskHandlerV2`, `WaitAgentHandlerV2`, `InterruptAgentHandler`, and `ListAgentsHandlerV2`, each wrapped with `override_tool_exposure`. For V1, it computes exposure based on search/namespace support and adds `SpawnAgentHandler`, `SendInputHandler`, `ResumeAgentHandler`, `WaitAgentHandler`, and `CloseAgentHandler`. Independently, if `agent_jobs_tools_enabled` it adds `SpawnAgentsOnCsvHandler`, and if `agent_jobs_worker_tools_enabled` it also adds `ReportAgentJobResultHandler`.

**Call relations**: Called by `add_tool_sources`; it delegates namespace wrapping to `multi_agent_v2_handler` and uses several feature helpers to choose the exact collaboration surface.

*Call graph*: calls 12 internal fn (override_tool_exposure, add, add_arc, add_with_exposure, agent_jobs_tools_enabled, agent_jobs_worker_tools_enabled, agent_type_description, collab_tools_enabled, multi_agent_v2_enabled, multi_agent_v2_handler (+2 more)); called by 1 (add_tool_sources); 4 external calls (new, new, new, new).


##### `add_mcp_runtime_tools`  (lines 800–824)

```
fn add_mcp_runtime_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds runtime handlers for concrete MCP tools, including deferred MCP tools, while skipping invalid tool specs with warnings. It adapts external MCP metadata into executable handlers.

**Data flow**: If `context.mcp_tools` is present, iterates over each `ToolInfo`, calls `McpHandler::new(tool.clone())`, and either adds the handler or logs a warning. It repeats the same for `context.deferred_mcp_tools`, but adds successful handlers with `ToolExposure::Deferred`.

**Call relations**: Called by `add_tool_sources` after generic MCP resource tools are added.

*Call graph*: calls 3 internal fn (new, add, add_with_exposure); called by 1 (add_tool_sources); 1 external calls (warn!).


##### `add_dynamic_tools`  (lines 826–856)

```
fn add_dynamic_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds handlers for dynamic tools supplied at runtime, supporting both top-level functions and namespaced function tools. Invalid dynamic tool specs are logged and skipped.

**Data flow**: Iterates over `context.dynamic_tools`. For `DynamicToolSpec::Function`, it calls `DynamicToolHandler::new(tool)` and adds the handler if present, otherwise logs an error. For `DynamicToolSpec::Namespace`, it iterates over namespace tools, calls `DynamicToolHandler::new_in_namespace(namespace, tool)` for each function tool, and adds or logs error accordingly.

**Call relations**: Called by `add_tool_sources` to incorporate runtime-provided dynamic tools into the plan.

*Call graph*: calls 3 internal fn (new, new_in_namespace, add); called by 1 (add_tool_sources); 1 external calls (error!).


##### `add_extension_tools`  (lines 858–866)

```
fn add_extension_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds extension-contributed tool executors into the planned runtime set. The actual adaptation and filtering logic lives in `append_extension_tool_executors`.

**Data flow**: Forwards `context.turn_context`, `context.extension_tool_executors`, and `planned_tools` to `append_extension_tool_executors`.

**Call relations**: Called by `add_tool_sources`.

*Call graph*: calls 1 internal fn (append_extension_tool_executors); called by 1 (add_tool_sources).


##### `append_tool_search_executor`  (lines 869–890)

```
fn append_tool_search_executor(
    context: &CoreToolPlanContext<'_>,
    planned_tools: &mut PlannedTools,
)
```

**Purpose**: Adds the deferred-tool search executor when search tools and namespace tools are supported and at least one deferred runtime exposes searchable metadata. This creates the synthetic tool that helps the model discover deferred tools.

**Data flow**: Checks `search_tool_enabled(turn_context)` and `namespace_tools_enabled(turn_context)`; returns early if either is false. Otherwise it scans `planned_tools.runtimes()` for handlers with `ToolExposure::Deferred`, collects their `search_info()` values, returns early if none exist, obtains or builds a cached handler from `context.tool_search_handler_cache`, and adds it via `add_arc`.

**Call relations**: Called by `build_tool_specs_and_registry` after ordinary tool sources are added but before code-mode wrappers are prepended.

*Call graph*: calls 4 internal fn (add_arc, runtimes, namespace_tools_enabled, search_tool_enabled); called by 1 (build_tool_specs_and_registry).


##### `prepend_code_mode_executors`  (lines 892–899)

```
fn prepend_code_mode_executors(
    context: &CoreToolPlanContext<'_>,
    planned_tools: &mut PlannedTools,
)
```

**Purpose**: Prepends the synthesized code-mode execute/wait handlers ahead of all other runtimes. This ensures code-mode wrapper tools are available and ordered first in the runtime list.

**Data flow**: Calls `build_code_mode_executors(turn_context, planned_tools.runtimes())` and splices the resulting vector into the front of `planned_tools.runtimes`.

**Call relations**: Called by `build_tool_specs_and_registry` after all ordinary runtimes and deferred search handlers have been planned.

*Call graph*: calls 2 internal fn (runtimes, build_code_mode_executors); called by 1 (build_tool_specs_and_registry).


##### `append_extension_tool_executors`  (lines 901–953)

```
fn append_extension_tool_executors(
    turn_context: &TurnContext,
    executors: &[Arc<dyn ToolExecutor<ExtensionToolCall>>],
    planned_tools: &mut PlannedTools,
)
```

**Purpose**: Adapts extension executors into core runtimes while enforcing visibility rules, duplicate-name suppression, and special handling for standalone web search and image generation. It is the main integration point for extension-contributed tools.

**Data flow**: Returns early if `executors` is empty. Otherwise it builds a `reserved_tool_names` set from existing planned runtime names, plus code-mode public/wait tool names when in code mode, plus the search tool name when deferred search will be added. It computes standalone web-search visibility and whether web search mode is enabled. Then it iterates over cloned extension executors, skipping `web.run` when standalone web search is disabled or web search mode is off, skipping `image_gen.imagegen` when standalone image generation is not model-visible, warning and skipping duplicates already in `reserved_tool_names`, and otherwise wrapping each executor in `ExtensionToolAdapter::new` and adding it.

**Call relations**: Called by `add_extension_tools`; it depends on current planned runtimes and several visibility helpers to avoid conflicts with core or hosted tools.

*Call graph*: calls 9 internal fn (new, add, runtimes, namespace_tools_enabled, search_tool_enabled, standalone_image_generation_model_visible, standalone_web_search_enabled, namespaced, plain); called by 1 (add_extension_tools); 2 external calls (matches!, warn!).


##### `multi_agent_v2_handler`  (lines 955–966)

```
fn multi_agent_v2_handler(
    handler: impl CoreToolRuntime + 'static,
    namespace: Option<&str>,
) -> Arc<dyn CoreToolRuntime>
```

**Purpose**: Wraps a V2 multi-agent handler in an optional namespace override. This lets the planner expose V2 collaboration tools either directly or under a configured namespace without changing handler internals.

**Data flow**: Takes a concrete `CoreToolRuntime` handler and an optional namespace string. If a namespace is provided, returns `Arc::new(MultiAgentV2NamespaceOverride { handler: Arc::new(handler), namespace: namespace.to_string() })`; otherwise returns `Arc::new(handler)`.

**Call relations**: Used by `add_collaboration_tools` when constructing the V2 collaboration tool set.

*Call graph*: called by 1 (add_collaboration_tools); 1 external calls (new).


##### `MultiAgentV2NamespaceOverride::tool_name`  (lines 974–976)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Rewrites the wrapped handler’s tool name into the configured namespace while preserving the original function name. This changes only the exposed name, not behavior.

**Data flow**: Reads `self.namespace` and `self.handler.tool_name().name`, constructs `ToolName::namespaced(self.namespace.clone(), ...)`, and returns it.

**Call relations**: Called by registry/spec-building code whenever the wrapped V2 handler’s tool name is needed.

*Call graph*: calls 1 internal fn (namespaced).


##### `MultiAgentV2NamespaceOverride::spec`  (lines 978–987)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Wraps a function-style tool spec from the underlying handler into a namespace spec with the fixed multi-agent V2 namespace description. Non-function specs are passed through unchanged.

**Data flow**: Calls `self.handler.spec()`. If it is `ToolSpec::Function(tool)`, returns `ToolSpec::Namespace(ResponsesApiNamespace { name: self.namespace.clone(), description: MULTI_AGENT_V2_NAMESPACE_DESCRIPTION.to_string(), tools: vec![ResponsesApiNamespaceTool::Function(tool)] })`; otherwise returns the original spec.

**Call relations**: Used during model-visible spec construction for namespace-overridden V2 handlers.

*Call graph*: 2 external calls (Namespace, vec!).


##### `MultiAgentV2NamespaceOverride::exposure`  (lines 989–991)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Delegates exposure reporting to the wrapped handler. Namespace overriding does not change whether the tool is direct, deferred, hidden, or direct-model-only.

**Data flow**: Returns `self.handler.exposure()`.

**Call relations**: Queried during planning and registry/spec construction just like any other runtime.


##### `MultiAgentV2NamespaceOverride::supports_parallel_tool_calls`  (lines 993–995)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Delegates parallel-call capability to the wrapped handler. The namespace wrapper is behaviorally transparent in this respect.

**Data flow**: Returns `self.handler.supports_parallel_tool_calls()`.

**Call relations**: Used wherever the runtime system inspects tool concurrency support.


##### `MultiAgentV2NamespaceOverride::search_info`  (lines 997–999)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Delegates deferred-search metadata to the wrapped handler. Namespace wrapping does not alter searchability metadata.

**Data flow**: Returns `self.handler.search_info()`.

**Call relations**: Allows namespace-overridden handlers to participate in deferred-tool search planning if applicable.


##### `MultiAgentV2NamespaceOverride::handle`  (lines 1001–1003)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Delegates actual tool invocation handling to the wrapped handler. The wrapper changes naming/spec exposure only.

**Data flow**: Takes a `ToolInvocation`, forwards it to `self.handler.handle(invocation)`, and returns the resulting future.

**Call relations**: Used at runtime when a namespaced V2 tool is invoked through the registry.


##### `MultiAgentV2NamespaceOverride::matches_kind`  (lines 1007–1009)

```
fn matches_kind(&self, payload: &crate::tools::context::ToolPayload) -> bool
```

**Purpose**: Delegates payload-kind matching to the wrapped handler. Namespace wrapping does not affect dispatch matching logic.

**Data flow**: Forwards the provided `ToolPayload` reference to `self.handler.matches_kind(payload)` and returns the boolean result.

**Call relations**: Used by dispatch/runtime matching through the `CoreToolRuntime` trait.


##### `MultiAgentV2NamespaceOverride::create_diff_consumer`  (lines 1011–1015)

```
fn create_diff_consumer(
        &self,
    ) -> Option<Box<dyn crate::tools::registry::ToolArgumentDiffConsumer>>
```

**Purpose**: Delegates diff-consumer creation to the wrapped handler. The wrapper does not alter argument-diff behavior.

**Data flow**: Returns `self.handler.create_diff_consumer()`.

**Call relations**: Used by tooling that inspects or consumes argument diffs for tool calls.


##### `compare_code_mode_tools`  (lines 1018–1030)

```
fn compare_code_mode_tools(
    left: &codex_code_mode::ToolDefinition,
    right: &codex_code_mode::ToolDefinition,
    namespace_descriptions: &BTreeMap<String, codex_code_mode::ToolNamespaceDescrip
```

**Purpose**: Defines the stable ordering for code-mode tool definitions. Tools are sorted first by namespace name, then by underlying tool name, then by display name.

**Data flow**: Reads two `ToolDefinition`s and the namespace-description map, derives optional namespace names via `code_mode_namespace_name`, compares those, then compares `left.tool_name.name` vs `right.tool_name.name`, then `left.name` vs `right.name`, and returns the resulting `Ordering`.

**Call relations**: Used by `build_code_mode_executors` when sorting enabled code-mode tool definitions.

*Call graph*: calls 1 internal fn (code_mode_namespace_name).


##### `code_mode_namespace_name`  (lines 1032–1041)

```
fn code_mode_namespace_name(
    tool: &codex_code_mode::ToolDefinition,
    namespace_descriptions: &'a BTreeMap<String, codex_code_mode::ToolNamespaceDescription>,
) -> Option<&'a str>
```

**Purpose**: Looks up the canonical namespace name for a code-mode tool definition using the namespace-description map. It returns `None` for non-namespaced tools or unknown namespaces.

**Data flow**: Reads `tool.tool_name.namespace`, looks it up in `namespace_descriptions`, maps the found description to `name.as_str()`, and returns `Option<&str>`.

**Call relations**: Called by `compare_code_mode_tools` as part of code-mode tool ordering.

*Call graph*: called by 1 (compare_code_mode_tools).


### `core/src/tools/hosted_spec.rs`

`domain_logic` · `tool spec construction during model/tool setup`

This file is a small adapter between configuration types in `codex_protocol` and runtime tool specifications in `codex_tools`. It defines `WebSearchToolOptions<'a>`, a compact input bundle containing an optional `WebSearchMode`, an optional borrowed `WebSearchConfig`, and the desired `WebSearchToolType`. The constant `WEB_SEARCH_TEXT_AND_IMAGE_CONTENT_TYPES` captures the only multi-modal content-type list this module emits: `"text"` and `"image"`.

`create_image_generation_tool` is straightforward: it wraps the caller-provided output format string into `ToolSpec::ImageGeneration`, cloning into an owned `String` because tool specs are owned values.

`create_web_search_tool` contains the real policy translation. It first maps `WebSearchMode` to `external_web_access`: `Cached` becomes `Some(false)`, `Live` becomes `Some(true)`, and both `Disabled` and missing mode short-circuit to `None` via `?`, meaning no web-search tool should be advertised at all. It then derives `search_content_types`: plain text search leaves the field unset, while `TextAndImage` materializes a `Vec<String>` from the constant array. Finally it constructs `ToolSpec::WebSearch`, copying optional nested config fields only when `web_search_config` exists. `filters` and `user_location` are cloned and converted with `Into`, while `search_context_size` is copied directly. The design intentionally distinguishes “tool absent” from “tool present with restrictive fields,” which matters to callers deciding whether hosted models may invoke search.

#### Function details

##### `create_image_generation_tool`  (lines 14–18)

```
fn create_image_generation_tool(output_format: &str) -> ToolSpec
```

**Purpose**: Creates the hosted image-generation tool spec with the exact output format requested by the caller. It is the one-step conversion from a borrowed format string to an owned `ToolSpec::ImageGeneration`.

**Data flow**: Reads `output_format: &str` → converts it to `String` with `to_string()` → returns `ToolSpec::ImageGeneration { output_format }`. It does not read or mutate any external state.

**Call relations**: This helper is used when hosted model tool specs are assembled and an image-generation capability should be included. It does not delegate further; its role in the flow is to produce the final enum variant directly for the caller.

*Call graph*: called by 1 (hosted_model_tool_specs).


##### `create_web_search_tool`  (lines 20–50)

```
fn create_web_search_tool(options: WebSearchToolOptions<'_>) -> Option<ToolSpec>
```

**Purpose**: Builds an optional hosted web-search tool spec from mode, config, and tool-type inputs. It suppresses the tool entirely when search is disabled or unspecified, and otherwise preserves configured filters, user location, context size, and content-type capabilities.

**Data flow**: Consumes `WebSearchToolOptions` by value, reading `web_search_mode`, optional borrowed `web_search_config`, and `web_search_tool_type` → maps mode to a required `external_web_access` boolean, returning early with `None` for disabled/absent modes → maps tool type to either no `search_content_types` or a `Vec<String>` containing `"text"` and `"image"` → clones and converts optional `filters` and `user_location` from `WebSearchConfig`, copies `search_context_size`, and returns `Some(ToolSpec::WebSearch { ... })`.

**Call relations**: The hosted model tool-spec builder invokes this when deciding whether to expose web search. Inside the function, control flow is dominated by the early-return mode check; after that it delegates only to standard cloning/conversion of nested config fields so the caller receives a fully formed `ToolSpec` or no tool at all.

*Call graph*: called by 1 (hosted_model_tool_specs).


### `core/src/tools/handlers/dynamic.rs`

`io_transport` · `request handling`

This file defines `DynamicToolHandler`, a runtime adapter for tools described by `codex_protocol::dynamic_tools`. Construction starts from a `DynamicToolFunctionSpec`, optionally paired with a `DynamicToolNamespaceSpec`, and produces both a canonical `ToolName` and a `ToolSpec`. Namespaced tools are exposed as `ToolSpec::Namespace(ResponsesApiNamespace)` containing a single `ResponsesApiNamespaceTool::Function`; non-namespaced tools become `ToolSpec::Function`. Namespace descriptions are normalized so blank descriptions fall back to `default_namespace_description`, and `tool.defer_loading` is translated into `ToolExposure::Deferred` versus `Direct`.

Execution only accepts `ToolPayload::Function`; any other payload becomes `FunctionCallError::RespondToModel`. The JSON argument string is parsed with the shared `parse_arguments` helper, then `request_dynamic_tool` performs the actual bridge to the outside world. That helper atomically locks `session.active_turn`, inserts a oneshot sender into the turn state's pending dynamic-tool map keyed by `call_id`, warns if an existing entry is overwritten, emits a `DynamicToolCallRequest` event, waits for the paired response, and always emits a matching `DynamicToolCallResponse` event recording completion time, duration, echoed arguments, and either returned content or a cancellation error. Returned `DynamicToolResponse.content_items` are converted into `FunctionCallOutputContentItem`s and wrapped as `FunctionToolOutput`, preserving the protocol `success` flag.

#### Function details

##### `DynamicToolHandler::new`  (lines 40–42)

```
fn new(tool: &DynamicToolFunctionSpec) -> Option<Self>
```

**Purpose**: Builds a handler for a top-level dynamic function tool with no namespace wrapper. It is the simple constructor used when the dynamic tool spec is already standalone.

**Data flow**: Reads a `&DynamicToolFunctionSpec` and forwards it with `None` namespace context into the shared constructor logic. Returns `Some(DynamicToolHandler)` when the tool can be converted into a responses API tool, otherwise `None` if conversion fails.

**Call relations**: It is invoked while dynamic tools are being added to the runtime from thread state. Rather than duplicating setup, it delegates all naming, spec creation, and exposure selection to `DynamicToolHandler::from_parts`.

*Call graph*: called by 1 (add_dynamic_tools); 1 external calls (from_parts).


##### `DynamicToolHandler::new_in_namespace`  (lines 44–49)

```
fn new_in_namespace(
        namespace: &DynamicToolNamespaceSpec,
        tool: &DynamicToolFunctionSpec,
    ) -> Option<Self>
```

**Purpose**: Builds a handler for a dynamic function that should be exposed inside a namespace. It preserves namespace metadata while still producing a single executable handler instance.

**Data flow**: Consumes references to a `DynamicToolNamespaceSpec` and `DynamicToolFunctionSpec`, passes both into the shared constructor path, and returns an optional handler. The namespace name and description become part of the resulting `ToolName` and `ToolSpec` if construction succeeds.

**Call relations**: It is called during dynamic-tool registration when the source protocol groups tools under a namespace. Like the plain constructor, it funnels all real work into `DynamicToolHandler::from_parts`.

*Call graph*: called by 1 (add_dynamic_tools); 1 external calls (from_parts).


##### `DynamicToolHandler::from_parts`  (lines 51–81)

```
fn from_parts(
        tool: &DynamicToolFunctionSpec,
        namespace: Option<&DynamicToolNamespaceSpec>,
    ) -> Option<Self>
```

**Purpose**: Performs the actual translation from protocol dynamic-tool metadata into the core runtime representation. It computes the canonical tool name, converts the function schema, wraps it in a namespace when needed, and derives exposure mode from `defer_loading`.

**Data flow**: Reads the function spec and optional namespace spec, constructs a `ToolName` from namespace/name components, converts the function via `dynamic_tool_to_responses_api_tool`, and then builds either `ToolSpec::Function` or `ToolSpec::Namespace`. For namespaced tools it also normalizes blank namespace descriptions using `default_namespace_description`; finally it returns a populated `DynamicToolHandler` with `ToolExposure::Deferred` or `Direct`.

**Call relations**: This is the common constructor behind both public constructors. It does not call into execution paths; its role is to prepare immutable metadata later surfaced by `tool_name`, `spec`, `search_info`, and `handle_call`.

*Call graph*: calls 1 internal fn (new); 5 external calls (default_namespace_description, dynamic_tool_to_responses_api_tool, Function, Namespace, vec!).


##### `DynamicToolHandler::tool_name`  (lines 85–87)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the handler's canonical `ToolName` for registry lookups and invocation routing.

**Data flow**: Reads `self.tool_name`, clones it, and returns the clone without mutating state.

**Call relations**: It is part of the `ToolExecutor` interface and is used by the registry and by downstream code that needs the exact dynamic tool identifier.

*Call graph*: 1 external calls (clone).


##### `DynamicToolHandler::spec`  (lines 89–91)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the immutable tool specification that should be advertised to the model and search system.

**Data flow**: Reads `self.spec`, clones it, and returns the clone.

**Call relations**: It is used directly by the runtime and indirectly by `DynamicToolHandler::search_info`, which needs a fresh `ToolSpec` to derive searchable metadata.

*Call graph*: called by 1 (search_info); 1 external calls (clone).


##### `DynamicToolHandler::exposure`  (lines 93–95)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Reports whether the dynamic tool should be exposed immediately or only through deferred loading.

**Data flow**: Reads the stored `ToolExposure` enum from `self.exposure` and returns it by value.

**Call relations**: This is consumed by the tool registry when deciding how the tool appears to the model; it does not delegate further.


##### `DynamicToolHandler::search_info`  (lines 97–105)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Builds search metadata so dynamic tools can participate in tool discovery with a labeled source. It tags them as coming from the current Codex thread.

**Data flow**: Calls `self.spec()` to obtain the current `ToolSpec`, then feeds that plus a `ToolSearchSourceInfo { name: "Dynamic tools", description: Some("Tools provided by the current Codex thread.") }` into `ToolSearchInfo::from_tool_spec`. Returns the resulting optional search record.

**Call relations**: This method is reached when the runtime indexes tools for search. It depends on `spec` for the structural description and delegates the actual indexing logic to `ToolSearchInfo::from_tool_spec`.

*Call graph*: calls 2 internal fn (spec, from_tool_spec).


##### `DynamicToolHandler::handle`  (lines 107–109)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async execution method into the boxed future shape required by the `ToolExecutor` trait.

**Data flow**: Takes ownership of a `ToolInvocation`, creates the future from `self.handle_call(invocation)`, pins it in a `Box`, and returns that executor future.

**Call relations**: The registry invokes this trait method when dispatching a tool call. It is only a thin wrapper around `DynamicToolHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `DynamicToolHandler::handle_call`  (lines 113–161)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Executes one dynamic tool invocation by validating payload shape, parsing JSON arguments, waiting for the external dynamic-tool response, and converting that response into a standard function-tool output.

**Data flow**: Destructures `ToolInvocation` to read `session`, `turn`, `call_id`, and `payload`. If `payload` is not `ToolPayload::Function`, it returns `FunctionCallError::RespondToModel`; otherwise it parses the argument string into `serde_json::Value` with `parse_arguments`, calls `request_dynamic_tool` with session/turn/call metadata and the cloned `ToolName`, then maps a missing response to a cancellation error. On success it converts `DynamicToolResponse { content_items, success }` into a `Vec<FunctionCallOutputContentItem>`, wraps it with `FunctionToolOutput::from_content`, boxes it, and returns it.

**Call relations**: It is called exclusively by `handle`. Its central delegation is to `request_dynamic_tool`, which performs the event-based request/response exchange; after that it only performs output adaptation.

*Call graph*: calls 4 internal fn (from_content, boxed_tool_output, request_dynamic_tool, parse_arguments); called by 1 (handle); 2 external calls (clone, RespondToModel).


##### `request_dynamic_tool`  (lines 170–238)

```
async fn request_dynamic_tool(
    session: &Session,
    turn_context: &TurnContext,
    call_id: String,
    tool_name: ToolName,
    arguments: Value,
) -> Option<DynamicToolResponse>
```

**Purpose**: Bridges a dynamic tool call through the session event stream and waits for the matching asynchronous response. It also emits a completion event whether the call succeeds or is cancelled.

**Data flow**: Accepts `&Session`, `&TurnContext`, `call_id`, `ToolName`, and parsed JSON `arguments`. It splits the tool name into `namespace` and `tool`, clones the turn id, creates a oneshot channel, then locks `session.active_turn` and the active turn's `turn_state` to register the sender under the `call_id`; if an entry already existed it logs a warning. It records start timestamps, emits `EventMsg::DynamicToolCallRequest` containing call id, turn id, namespace, tool, arguments, and `started_at_ms`, awaits the oneshot receiver, then emits `EventMsg::DynamicToolCallResponse` with completion timestamp, duration, echoed request fields, and either returned `content_items`/`success` or an error string with `success: false`. Finally it returns `Option<DynamicToolResponse>` from the receiver outcome.

**Call relations**: This helper is invoked by `DynamicToolHandler::handle_call` after argument parsing. It is the transport boundary between core execution and whatever component fulfills pending dynamic tool calls by resolving the registered oneshot sender.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (handle_call); 8 external calls (now, clone, new, send_event, channel, DynamicToolCallRequest, DynamicToolCallResponse, warn!).


### `tools/src/dynamic_tool.rs`

`domain_logic` · `tool definition ingestion`

This file contains a single translation function that bridges `codex_protocol::dynamic_tools::DynamicToolFunctionSpec` into the local `ToolDefinition` type used elsewhere in the tools subsystem. Its work is intentionally minimal and explicit: it clones the external tool’s `name` and `description`, preserves the `defer_loading` flag unchanged, and derives the internal `input_schema` by passing `tool.input_schema` into `parse_tool_input_schema`. That schema conversion is the only fallible step, so the function returns `Result<ToolDefinition, serde_json::Error>` and uses `?` to propagate any parsing failure directly to its caller without adding wrapping context.

A notable design choice is that `output_schema` is always set to `None` here, which means dynamic tool specs handled by this adapter currently contribute only input-shape information to the internal model. The function performs no validation beyond whatever `parse_tool_input_schema` enforces, and it does not mutate global state or cache results; it is a pure data-mapping step from borrowed input to an owned internal struct. The file also conditionally includes a dedicated test module from `dynamic_tool_tests.rs`, keeping the implementation itself compact while still supporting focused verification of this conversion behavior.

#### Function details

##### `parse_dynamic_tool`  (lines 5–15)

```
fn parse_dynamic_tool(
    tool: &DynamicToolFunctionSpec,
) -> Result<ToolDefinition, serde_json::Error>
```

**Purpose**: Builds a `ToolDefinition` from a borrowed `DynamicToolFunctionSpec`, translating protocol fields into the crate’s internal tool metadata shape. It also parses the external input schema into the internal schema representation and fails if that conversion is invalid JSON/schema data.

**Data flow**: Input is `&DynamicToolFunctionSpec`. The function reads `tool.name`, `tool.description`, `tool.input_schema`, and `tool.defer_loading`; clones the string fields into owned values; sends `&tool.input_schema` to `parse_tool_input_schema`; then assembles and returns a new `ToolDefinition` with `output_schema: None`. On schema parse failure it returns the propagated `serde_json::Error`; it writes no external state.

**Call relations**: This function is invoked when the system needs to ingest a dynamic tool definition from the protocol layer into the internal tools model. In that flow it delegates the only nontrivial transformation—the input schema conversion—to `parse_tool_input_schema`, relying on that helper for validation and normalization before completing the `ToolDefinition` construction.

*Call graph*: 1 external calls (parse_tool_input_schema).


### `tools/src/tool_search.rs`

`domain_logic` · `tool registration and discovery indexing`

This file contains the logic that turns a `ToolSpec` into `ToolSearchInfo`, the structure used to register deferred tools for later discovery. `ToolSearchEntry` pairs a generated `search_text` string with a `LoadableToolSpec`, and `ToolSearchInfo` optionally adds `ToolSearchSourceInfo` describing where the tool came from. `from_tool_spec` is the convenience entry point: it derives default search text from the spec and then delegates to `from_spec`. `from_spec` performs the important deferred-spec transformation. Function tools are rewritten with `defer_loading = Some(true)` and `output_schema = None`; namespace tools get the same treatment for every contained function, and if the namespace description is blank it is replaced with `default_namespace_description(&namespace.name)`. Tool kinds that are not meant to participate in deferred search (`ToolSearch`, `ImageGeneration`, `WebSearch`, `Freeform`) return `None`. Search text generation is recursive and concrete: function names are indexed both as-is and with underscores replaced by spaces, descriptions are included, and parameter schemas are traversed through descriptions, property names, nested properties, array items, and `any_of` variants. `push_search_part` trims and drops empty fragments so the final joined string is dense, stable, and free of duplicate whitespace.

#### Function details

##### `ToolSearchInfo::from_tool_spec`  (lines 22–28)

```
fn from_tool_spec(
        spec: ToolSpec,
        source_info: Option<ToolSearchSourceInfo>,
    ) -> Option<Self>
```

**Purpose**: Creates searchable metadata from a `ToolSpec` using automatically derived search text. It is the high-level entry point used by default executor search behavior.

**Data flow**: It takes ownership of a `ToolSpec` and optional `ToolSearchSourceInfo`, computes `search_text` by calling `default_tool_search_text(&spec)`, then passes that text, the original spec, and the source info into `Self::from_spec`. It returns the resulting `Option<ToolSearchInfo>`.

**Call relations**: This function is called by default `ToolExecutor::search_info` implementations and by tests that validate the generated search corpus.

*Call graph*: calls 1 internal fn (default_tool_search_text); called by 3 (search_info, search_info, default_search_text_uses_model_visible_namespace_metadata_once); 1 external calls (from_spec).


##### `ToolSearchInfo::from_spec`  (lines 30–65)

```
fn from_spec(
        search_text: String,
        spec: ToolSpec,
        source_info: Option<ToolSearchSourceInfo>,
    ) -> Option<Self>
```

**Purpose**: Builds a `ToolSearchInfo` from explicit search text plus a tool spec, rewriting eligible specs into deferred-loadable form. It rejects tool kinds that should not be indexed as deferred tools.

**Data flow**: It takes a `search_text` string, a `ToolSpec`, and optional source info. For `ToolSpec::Function`, it mutates the owned tool spec to set `defer_loading = Some(true)` and `output_schema = None`, then wraps it in `LoadableToolSpec::Function`; for `ToolSpec::Namespace`, it fills an empty description with `default_namespace_description(&namespace.name)`, iterates through each contained `ResponsesApiNamespaceTool::Function`, and sets each function's `defer_loading` and `output_schema` similarly before wrapping in `LoadableToolSpec::Namespace`. For `ToolSearch`, `ImageGeneration`, `WebSearch`, and `Freeform`, it returns `None`. Otherwise it returns `Some(ToolSearchInfo { entry: ToolSearchEntry { search_text, output }, source_info })`.

**Call relations**: This is the core transformation used by `from_tool_spec` and by callers that already have custom search text but still need the canonical deferred spec rewrite.

*Call graph*: called by 2 (search_info, multi_agent_tool_search_info); 3 external calls (default_namespace_description, Function, Namespace).


##### `default_tool_search_text`  (lines 68–98)

```
fn default_tool_search_text(spec: &ToolSpec) -> String
```

**Purpose**: Derives the default free-text search corpus for a tool spec by concatenating names, descriptions, and schema metadata. The exact fields included depend on the `ToolSpec` variant.

**Data flow**: It creates a mutable `Vec<String>` accumulator, matches on the borrowed `ToolSpec`, and appends relevant fragments: function tools delegate to `append_function_search_text`; namespaces add namespace name and description and then each contained function's search text; tool-search specs add only their description; image-generation and web-search specs add fixed phrases; freeform tools add name, description, and syntax. It joins the accumulated parts with spaces and returns the resulting `String`.

**Call relations**: This helper is called by `ToolSearchInfo::from_tool_spec` to generate search text automatically before deferred-spec conversion.

*Call graph*: calls 2 internal fn (append_function_search_text, push_search_part); called by 1 (from_tool_spec); 1 external calls (new).


##### `append_function_search_text`  (lines 100–105)

```
fn append_function_search_text(tool: &ResponsesApiTool, parts: &mut Vec<String>)
```

**Purpose**: Adds a function tool's searchable fragments to an existing parts vector. It indexes both machine-oriented and humanized forms of the function name plus description and parameter schema text.

**Data flow**: It borrows a `ResponsesApiTool` and a mutable `Vec<String>`, pushes `tool.name`, a version of the name with underscores replaced by spaces, and `tool.description`, then delegates to `append_schema_search_text(&tool.parameters, parts)` to recursively include schema metadata. It returns no value and mutates only the provided vector.

**Call relations**: This helper is used by `default_tool_search_text` for both standalone function specs and functions nested inside namespaces.

*Call graph*: calls 2 internal fn (append_schema_search_text, push_search_part); called by 1 (default_tool_search_text).


##### `append_schema_search_text`  (lines 107–125)

```
fn append_schema_search_text(schema: &JsonSchema, parts: &mut Vec<String>)
```

**Purpose**: Recursively extracts searchable text from a JSON schema tree. It includes schema descriptions, property names, nested property schemas, array item schemas, and `any_of` variants.

**Data flow**: It borrows a `JsonSchema` and mutable parts vector. If `schema.description` exists, it pushes that text; if `schema.properties` exists, it iterates each `(name, schema)` pair, pushes the property name, and recurses into the property's schema; if `schema.items` exists, it recurses into the item schema; if `schema.any_of` exists, it recurses into each variant. It mutates only the provided vector and returns no value.

**Call relations**: This recursive helper is called from `append_function_search_text` to ensure parameter schemas contribute meaningful search terms.

*Call graph*: calls 1 internal fn (push_search_part); called by 1 (append_function_search_text).


##### `push_search_part`  (lines 127–132)

```
fn push_search_part(parts: &mut Vec<String>, part: String)
```

**Purpose**: Adds a candidate search fragment to the accumulator only if it contains non-whitespace content. It centralizes trimming and empty-string suppression.

**Data flow**: It takes a mutable `Vec<String>` and an owned `String`, trims the string to `&str`, and if the trimmed text is non-empty pushes a newly allocated `String` copy into the vector. It returns no value.

**Call relations**: All search-text builders delegate here so whitespace normalization and empty-part filtering are applied consistently across names, descriptions, and schema fragments.

*Call graph*: called by 3 (append_function_search_text, append_schema_search_text, default_tool_search_text).


### `core/src/tools/handlers/extension_tools.rs`

`orchestration` · `request handling`

The production code centers on `ExtensionToolAdapter`, a thin wrapper around `Arc<dyn codex_tools::ToolExecutor<codex_tools::ToolCall>>`. Most trait methods simply forward metadata such as `tool_name`, `spec`, exposure, parallel-call support, and search info to the underlying extension executor. The important translation happens in `handle`, which converts a core `ToolInvocation` into an extension `ToolCall` via `to_extension_call` before delegating execution.

`to_extension_call` snapshots conversation history from `session.clone_history().await.into_raw_items()`, copies turn identifiers and model/truncation settings, and builds a `Vec<ToolEnvironment>` from the turn's environments. For each environment it resolves a native absolute cwd, skips non-native paths, computes additional sandbox permissions with `apply_granted_turn_permissions`, and derives a `file_system_sandbox_context` from the turn. It also installs a `CoreTurnItemEmitter` built from weak references to the session and turn so extensions can emit progress items without extending their lifetimes.

`CoreTurnItemEmitter` converts `ExtensionTurnItem` into protocol `TurnItem`s. `emit_started` publishes the item immediately if both weak refs still upgrade. `emit_completed` first runs `finalize_turn_item` with `TurnItemContributorPolicy::Run(turn.extension_data.as_ref())` and plan-mode awareness, then emits the completed item. `extension_turn_item` intentionally clears `saved_path` on image-generation items so core finalization owns artifact publication. The tests exercise hook payload generation, weak-reference scoping, history/environment transfer, contributor execution, and image artifact finalization.

#### Function details

##### `ExtensionToolAdapter::new`  (lines 29–31)

```
fn new(executor: Arc<dyn codex_tools::ToolExecutor<ExtensionToolCall>>) -> Self
```

**Purpose**: Wraps an extension executor trait object so it can be registered as a core runtime tool.

**Data flow**: Takes an `Arc<dyn codex_tools::ToolExecutor<ExtensionToolCall>>`, stores it as the tuple field of `ExtensionToolAdapter`, and returns the adapter.

**Call relations**: It is used both in production registration code and in tests that exercise the adapter behavior. After construction, all runtime calls flow through the adapter's `ToolExecutor<ToolInvocation>` implementation.

*Call graph*: called by 4 (exposes_generic_hook_payloads, image_generation_publication_is_finalized_by_core, passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call, append_extension_tool_executors).


##### `ExtensionToolAdapter::tool_name`  (lines 35–37)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Forwards the extension executor's canonical tool name into the core runtime.

**Data flow**: Reads the wrapped executor from `self.0`, calls its `tool_name`, and returns that `ToolName`.

**Call relations**: This is part of the metadata surface consumed by the registry; it does not transform the value.


##### `ExtensionToolAdapter::spec`  (lines 39–41)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Forwards the extension executor's advertised tool specification.

**Data flow**: Calls `self.0.spec()` and returns the resulting `ToolSpec`.

**Call relations**: The registry and model-facing tool listing use this method directly; the adapter adds no extra wrapping here.


##### `ExtensionToolAdapter::exposure`  (lines 43–45)

```
fn exposure(&self) -> crate::tools::registry::ToolExposure
```

**Purpose**: Reports the extension tool's exposure mode exactly as declared by the wrapped executor.

**Data flow**: Calls `self.0.exposure()` and returns the resulting core `ToolExposure`.

**Call relations**: This is a straight pass-through used during tool registration and advertisement.


##### `ExtensionToolAdapter::supports_parallel_tool_calls`  (lines 47–49)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Preserves the extension executor's declaration about whether concurrent calls are safe.

**Data flow**: Calls `self.0.supports_parallel_tool_calls()` and returns the boolean result.

**Call relations**: The scheduler consults this through the adapter when deciding whether multiple invocations may run at once.


##### `ExtensionToolAdapter::search_info`  (lines 51–53)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Exposes any extension-provided search metadata without modification.

**Data flow**: Calls `self.0.search_info()` and returns the optional `ToolSearchInfo`.

**Call relations**: This lets extension tools participate in tool search using their own metadata generation.


##### `ExtensionToolAdapter::handle`  (lines 55–57)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Converts a core invocation into an extension call object and then runs the wrapped extension executor.

**Data flow**: Accepts a `ToolInvocation`, asynchronously awaits `to_extension_call(&invocation)` to build a `codex_tools::ToolCall`, passes that into `self.0.handle(...)`, awaits the extension result, and returns the boxed future.

**Call relations**: This is the adapter's main execution entrypoint. It is invoked by the core registry and delegates first to `to_extension_call` for shape conversion, then to the extension executor for actual tool logic.

*Call graph*: calls 1 internal fn (to_extension_call); 1 external calls (pin).


##### `ExtensionToolAdapter::matches_kind`  (lines 61–63)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this adapter to function-style payloads only.

**Data flow**: Reads a `&ToolPayload` and returns `true` only when it matches `ToolPayload::Function { .. }`.

**Call relations**: This `CoreToolRuntime` hook is consulted before execution so non-function payloads are not routed to extension executors.

*Call graph*: 1 external calls (matches!).


##### `extension_turn_item`  (lines 71–79)

```
fn extension_turn_item(item: ExtensionTurnItem) -> TurnItem
```

**Purpose**: Maps extension-emitted turn items into protocol `TurnItem`s, with one core-specific normalization for image generation.

**Data flow**: Consumes an `ExtensionTurnItem`; `WebSearch` is wrapped directly as `TurnItem::WebSearch`, while `ImageGeneration` is converted after mutating `saved_path` to `None`. Returns the resulting `TurnItem`.

**Call relations**: Both `CoreTurnItemEmitter::emit_started` and `CoreTurnItemEmitter::emit_completed` call this helper before publishing items. Clearing `saved_path` ensures core finalization, not the extension, determines the public artifact path.

*Call graph*: called by 2 (emit_completed, emit_started); 2 external calls (ImageGeneration, WebSearch).


##### `CoreTurnItemEmitter::emit_started`  (lines 82–91)

```
fn emit_started(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Publishes an extension-generated start event into the session if the originating session and turn still exist.

**Data flow**: Takes an `ExtensionTurnItem`, upgrades `Weak<Session>` and `Weak<TurnContext>`; if either upgrade fails it returns early. Otherwise it converts the item with `extension_turn_item` and awaits `session.emit_turn_item_started(turn.as_ref(), &item)`.

**Call relations**: Extensions call this through the `TurnItemEmitter` trait embedded in their `ToolCall`. It is the lightweight start-side counterpart to `emit_completed` and intentionally does no finalization.

*Call graph*: calls 1 internal fn (extension_turn_item); 2 external calls (pin, upgrade).


##### `CoreTurnItemEmitter::emit_completed`  (lines 93–109)

```
fn emit_completed(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Publishes a completed extension turn item after running core-side finalization and contributor hooks.

**Data flow**: Accepts an `ExtensionTurnItem`, upgrades weak session/turn references and returns early if either is gone. It converts the item with `extension_turn_item`, then calls `finalize_turn_item(session, turn, TurnItemContributorPolicy::Run(turn.extension_data.as_ref()), &mut item, turn.collaboration_mode.mode == ModeKind::Plan)` to apply contributor mutations and plan-mode adjustments, and finally emits the finalized item with `session.emit_turn_item_completed`.

**Call relations**: Extensions invoke this when a turn item finishes. It delegates to `finalize_turn_item` specifically so core retains control over contributor execution and artifact publication before the completed event is sent.

*Call graph*: calls 2 internal fn (finalize_turn_item, extension_turn_item); 3 external calls (pin, upgrade, Run).


##### `to_extension_call`  (lines 112–155)

```
async fn to_extension_call(invocation: &ToolInvocation) -> ExtensionToolCall
```

**Purpose**: Builds the extension-facing `ToolCall` object from a core invocation, including history, environments, sandbox context, and a scoped turn-item emitter.

**Data flow**: Reads the `ToolInvocation` by reference. It clones conversation history from `invocation.session.clone_history().await.into_raw_items()` into `ConversationHistory`, allocates an environments vector sized to the turn's environment count, and for each turn environment tries to resolve an absolute native cwd; environments with non-native cwd are skipped. For each retained environment it awaits `apply_granted_turn_permissions(...)` to compute additional permissions, derives `file_system_sandbox_context` from the turn, and pushes a `ToolEnvironment` containing environment id, cwd, filesystem handle, and sandbox context. It then returns `ExtensionToolCall` populated with turn id, call id, tool name, model slug, truncation policy, cloned payload, the built history and environments, and an `Arc<CoreTurnItemEmitter>` holding downgraded session/turn refs.

**Call relations**: This helper is called only by `ExtensionToolAdapter::handle`. It is the key translation layer between core runtime state and the extension API's execution contract.

*Call graph*: calls 2 internal fn (apply_granted_turn_permissions, new); called by 1 (handle); 3 external calls (downgrade, new, with_capacity).


##### `tests::StubExtensionExecutor::tool_name`  (lines 190–192)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Provides a fixed plain tool name for the stub executor used in tests.

**Data flow**: Constructs and returns `ToolName::plain("extension_echo")`.

**Call relations**: Test adapter instances use this metadata when verifying hook payload generation and invocation routing.

*Call graph*: calls 1 internal fn (plain).


##### `tests::StubExtensionExecutor::spec`  (lines 194–211)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Defines a strict function schema for the stub extension tool used in tests.

**Data flow**: Builds a `ToolSpec::Function` containing a `ResponsesApiTool` named `extension_echo`, with a parsed JSON schema requiring a string `message` property and forbidding additional properties. Returns that spec.

**Call relations**: The test harness uses this to ensure the adapter exposes normal function-tool metadata from extension executors.

*Call graph*: 3 external calls (parse_tool_input_schema, json!, Function).


##### `tests::StubExtensionExecutor::handle`  (lines 213–220)

```
fn handle(&self, _call: codex_tools::ToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Implements a trivial successful extension tool that always returns `{ "ok": true }`.

**Data flow**: Ignores the incoming `codex_tools::ToolCall`, constructs `codex_tools::JsonToolOutput::new(json!({"ok": true}))`, boxes it as `dyn ToolOutput`, and returns it from a pinned async block.

**Call relations**: It is exercised by `tests::exposes_generic_hook_payloads` to verify adapter-level hook payload extraction independent of any complex extension behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, pin, json!).


##### `tests::CapturingExtensionExecutor::tool_name`  (lines 228–230)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the same plain tool name as the stub executor for capture-oriented tests.

**Data flow**: Constructs and returns `ToolName::plain("extension_echo")`.

**Call relations**: This metadata is used in the environment/history propagation test.

*Call graph*: calls 1 internal fn (plain).


##### `tests::CapturingExtensionExecutor::spec`  (lines 232–241)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Defines a permissive function spec for the capturing executor used in tests.

**Data flow**: Returns `ToolSpec::Function` with name `extension_echo`, description `Captures arguments.`, `strict: false`, and a default empty `JsonSchema`.

**Call relations**: The exact schema is not central to the test; it simply makes the executor look like a valid extension tool.

*Call graph*: 2 external calls (default, Function).


##### `tests::CapturingExtensionExecutor::handle`  (lines 243–245)

```
fn handle(&self, call: codex_tools::ToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Routes the test executor's async work into its helper method.

**Data flow**: Accepts a `codex_tools::ToolCall`, creates the future from `self.handle_call(call)`, pins it, and returns it.

**Call relations**: This mirrors the production adapter pattern and delegates all observable behavior to `tests::CapturingExtensionExecutor::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `tests::CapturingExtensionExecutor::handle_call`  (lines 249–268)

```
async fn handle_call(
            &self,
            call: codex_tools::ToolCall,
        ) -> Result<Box<dyn codex_tools::ToolOutput>, codex_tools::FunctionCallError>
```

**Purpose**: Emits a synthetic web-search turn item, records the received extension call for later assertions, and returns a simple JSON success output.

**Data flow**: Consumes a `codex_tools::ToolCall`, constructs an `ExtensionTurnItem::WebSearch` whose id matches `call.call_id`, emits started and completed events through `call.turn_item_emitter`, stores the full `call` into `captured_call: Arc<Mutex<Option<ToolCall>>>`, and returns boxed `JsonToolOutput { ok: true }`.

**Call relations**: It is invoked by the executor's `handle` method during `tests::passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call`. The emitted items exercise the adapter's `CoreTurnItemEmitter` path.

*Call graph*: calls 1 internal fn (new); called by 1 (handle); 3 external calls (new, json!, WebSearch).


##### `tests::exposes_generic_hook_payloads`  (lines 272–305)

```
async fn exposes_generic_hook_payloads()
```

**Purpose**: Verifies that an adapted extension function tool participates in generic pre/post tool-use hook payload generation.

**Data flow**: Constructs an `ExtensionToolAdapter` around `StubExtensionExecutor`, creates a session/turn and a `ToolInvocation` with JSON function arguments, creates a matching JSON output, then compares `CoreToolRuntime::pre_tool_use_payload` and `post_tool_use_payload` against expected `PreToolUsePayload` and `PostToolUsePayload` values.

**Call relations**: This test exercises adapter integration with the shared `CoreToolRuntime` hook machinery rather than extension execution details.

*Call graph*: calls 5 internal fn (make_session_and_context, new, new, plain, new); 5 external calls (new, assert_eq!, json!, new, new).


##### `tests::passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call`  (lines 308–426)

```
async fn passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call()
```

**Purpose**: Checks that the adapter forwards turn metadata, conversation history, environments, and a weakly scoped turn-item emitter into the extension call object, and that emitted items become session events.

**Data flow**: Builds a capturing executor and adapter, creates a session/turn with an event receiver, records a history item into the session, invokes the adapter with a function payload, then inspects the captured `ToolCall` and received events. It asserts turn id, call id, tool name, model, truncation policy, sandbox cwd values, conversation history contents, payload preservation, weak-reference drop behavior, and the exact started/completed web-search events emitted through the scoped emitter.

**Call relations**: This is the main end-to-end test for `to_extension_call`, `CoreTurnItemEmitter::emit_started`, and `emit_completed` working together under the adapter's `handle` path.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, new, new, plain); 13 external calls (clone, downgrade, new, new, assert!, assert_eq!, json!, panic!, from_ref, new (+3 more)).


##### `tests::RecordExtensionTurnItemContributor::contribute`  (lines 436–446)

```
fn contribute(
            &'a self,
            _thread_store: &'a ExtensionData,
            turn_store: &'a ExtensionData,
            _item: &'a mut TurnItem,
        ) -> codex_extension_api::Ext
```

**Purpose**: Implements a test turn-item contributor that records that it ran by inserting a marker into turn extension data.

**Data flow**: Receives thread store, turn store, and mutable `TurnItem`; ignores the thread store and item, inserts `ExtensionTurnItemContributorRan` into `turn_store`, and returns `Ok(())` from a boxed async future.

**Call relations**: It is registered in `tests::extension_completion_runs_turn_item_contributors` and is triggered indirectly by `CoreTurnItemEmitter::emit_completed` via `finalize_turn_item`.

*Call graph*: calls 1 internal fn (insert); 1 external calls (pin).


##### `tests::extension_completion_runs_turn_item_contributors`  (lines 450–477)

```
async fn extension_completion_runs_turn_item_contributors()
```

**Purpose**: Confirms that core finalization runs registered extension turn-item contributors before publishing a completed item.

**Data flow**: Creates a session/turn, installs an extension registry containing `RecordExtensionTurnItemContributor`, constructs a `CoreTurnItemEmitter` with weak refs, emits a completed `ExtensionTurnItem::WebSearch`, and then asserts that the turn's extension data contains the contributor marker type.

**Call relations**: This test specifically targets the contributor-execution branch inside `CoreTurnItemEmitter::emit_completed`.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 5 external calls (downgrade, new, assert!, WebSearch, emit_completed).


##### `tests::ImageGenerationExtensionExecutor::tool_name`  (lines 480–482)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns a namespaced image-generation tool name for image publication tests.

**Data flow**: Constructs and returns `ToolName::namespaced("image_gen", "imagegen")`.

**Call relations**: The adapter uses this metadata when routing the image-generation test invocation.

*Call graph*: calls 1 internal fn (namespaced).


##### `tests::ImageGenerationExtensionExecutor::spec`  (lines 484–493)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Defines a permissive function spec for the synthetic image-generation extension tool.

**Data flow**: Returns `ToolSpec::Function` with name `imagegen`, description `Generates an image.`, `strict: false`, and a default schema.

**Call relations**: This makes the test executor look like a normal extension tool while the test focuses on emitted item finalization.

*Call graph*: 2 external calls (default, Function).


##### `tests::ImageGenerationExtensionExecutor::handle`  (lines 495–497)

```
fn handle(&self, call: codex_tools::ToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Delegates the image-generation test executor's work to its async helper.

**Data flow**: Accepts a `ToolCall`, creates and pins the future from `self.handle_call(call)`, and returns it.

**Call relations**: It is invoked through the adapter during the image-publication test.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `tests::ImageGenerationExtensionExecutor::handle_call`  (lines 501–531)

```
async fn handle_call(
            &self,
            call: codex_tools::ToolCall,
        ) -> Result<Box<dyn codex_tools::ToolOutput>, codex_tools::FunctionCallError>
```

**Purpose**: Simulates an extension that emits image-generation start and completion items, including a claimed saved path that core should override.

**Data flow**: Consumes a `ToolCall`, emits `ExtensionTurnItem::ImageGeneration` with `status: in_progress`, then emits a completed image item containing revised prompt, base64 result `cG5n`, and `saved_path` pointing at `/tmp/extension-claimed.png`. It finally returns boxed JSON `{ "ok": true }`.

**Call relations**: This helper is called by the executor's `handle` method and is used by `tests::image_generation_publication_is_finalized_by_core` to verify that `extension_turn_item` and `finalize_turn_item` replace the extension-provided path with a core-managed artifact.

*Call graph*: calls 1 internal fn (new); called by 1 (handle); 5 external calls (new, new, test_path_buf, json!, ImageGeneration).


##### `tests::image_generation_publication_is_finalized_by_core`  (lines 535–603)

```
async fn image_generation_publication_is_finalized_by_core()
```

**Purpose**: Verifies that image-generation items emitted by extensions are finalized by core, including artifact persistence and replacement of the public `saved_path`.

**Data flow**: Creates an adapter around `ImageGenerationExtensionExecutor`, a session/turn with event receiver, computes the expected artifact path from thread and call id, invokes the tool, then reads the emitted started/completed image-generation events and legacy begin/end events. It asserts the started item has no saved path, the completed item points to the core-generated artifact path, and the file at that path contains decoded bytes `png`.

**Call relations**: This test exercises the full adapter execution path plus `CoreTurnItemEmitter::emit_completed` finalization behavior for image outputs.

*Call graph*: calls 5 internal fn (make_session_and_context_with_rx, image_generation_artifact_path, new, new, namespaced); 7 external calls (new, assert!, assert_eq!, panic!, new, new, handle).


### `core/src/tools/handlers/tool_search.rs`

`domain_logic` · `tool execution during request handling; cache rebuild when tool inventory changes`

This file turns a list of `ToolSearchInfo` records into an executable search tool. `ToolSearchHandler::new` extracts any source-info metadata to build the published search-tool spec, then indexes each entry’s `search_text` into a BM25 `SearchEngine<usize>` using document IDs that correspond to positions in `search_infos`. At runtime, `handle_call` accepts only `ToolPayload::ToolSearch`, trims and validates the query, applies a default limit when omitted, rejects empty queries and zero limits with model-facing errors, and short-circuits to an empty result set when there are no searchable tools.

Actual retrieval happens in `search`, which asks the BM25 engine for the top matches, maps document IDs back into `search_infos`, and passes the resulting `ToolSearchEntry` sequence into `search_output_tools`. That helper calls `coalesce_loadable_tool_specs`, which is important because multiple hits may belong to the same namespace and should be merged into a single `LoadableToolSpec::Namespace` in the output. The companion `ToolSearchHandlerCache` stores an `Arc<ToolSearchHandler>` behind a `Mutex<Option<_>>` and compares the full `search_infos` vector for reuse; it also tolerates poisoned mutexes by recovering the inner value. The embedded tests verify both cache identity semantics and mixed-result coalescing across MCP and dynamic namespace tools.

#### Function details

##### `ToolSearchHandlerCache::get_or_build`  (lines 36–56)

```
fn get_or_build(&self, search_infos: Vec<ToolSearchInfo>) -> Arc<ToolSearchHandler>
```

**Purpose**: Returns a cached search handler when the searchable tool inventory is unchanged, or builds and stores a new one otherwise. It avoids rebuilding the BM25 index on repeated registrations with identical inputs.

**Data flow**: It takes ownership of a `Vec<ToolSearchInfo>`, first locks the cache via `cached()` and compares any stored handler’s `search_infos` to the incoming vector; if equal, it returns an `Arc` clone of the cached handler. Otherwise it constructs a new `ToolSearchHandler`, re-locks the cache to handle races, rechecks whether an equivalent handler is now present, and either returns that existing one or stores and returns the newly built `Arc`.

**Call relations**: Callers use this method when they need a search handler for the current tool inventory. It delegates mutex access to `cached()` and handler construction to `ToolSearchHandler::new`.

*Call graph*: calls 2 internal fn (new, cached); 2 external calls (clone, new).


##### `ToolSearchHandlerCache::cached`  (lines 58–63)

```
fn cached(&self) -> std::sync::MutexGuard<'_, Option<Arc<ToolSearchHandler>>>
```

**Purpose**: Obtains the mutex guard protecting the optional cached handler, recovering gracefully from poisoning. This keeps cache callers from having to repeat poison-handling logic.

**Data flow**: It locks `self.cached`, returning the `MutexGuard` directly on success or `poisoned.into_inner()` if the mutex was poisoned. No other transformation occurs.

**Call relations**: This helper is used internally by `ToolSearchHandlerCache::get_or_build` for both the initial cache lookup and the later store/update step.

*Call graph*: called by 1 (get_or_build).


##### `ToolSearchHandler::new`  (lines 67–87)

```
fn new(search_infos: Vec<ToolSearchInfo>) -> Self
```

**Purpose**: Builds a search handler from a concrete set of searchable tool records by generating the public search spec and indexing search text into a BM25 engine. It is the constructor that ties metadata, schema, and retrieval together.

**Data flow**: It takes `search_infos: Vec<ToolSearchInfo>`, extracts any `source_info` values into a separate vector for `create_tool_search_tool`, converts each entry’s `search_text` into a `Document<usize>` whose ID is the entry index, builds a `SearchEngine<usize>` with English language settings, and returns `Self { search_infos, spec, search_engine }`.

**Call relations**: This constructor is called by `ToolSearchHandlerCache::get_or_build` in production and by the namespace-coalescing test directly. It delegates only the schema portion to `create_tool_search_tool`.

*Call graph*: calls 1 internal fn (create_tool_search_tool); called by 2 (get_or_build, mixed_search_results_coalesce_mcp_namespaces); 1 external calls (with_documents).


##### `ToolSearchHandler::tool_name`  (lines 91–93)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical registry name for the tool-search handler. This aligns the runtime executor with the shared constant used elsewhere in the tool-search subsystem.

**Data flow**: It reads `TOOL_SEARCH_TOOL_NAME`, converts it with `ToolName::plain`, and returns the resulting `ToolName`.

**Call relations**: The tool registry calls this trait method when registering or dispatching the search tool.

*Call graph*: calls 1 internal fn (plain).


##### `ToolSearchHandler::spec`  (lines 95–97)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the precomputed search-tool specification associated with this handler instance. The spec is built once at construction time from the available source metadata.

**Data flow**: It takes `&self`, clones `self.spec`, and returns the clone.

**Call relations**: The registry invokes this method when it needs the published schema for the search tool; the actual spec was prepared earlier by `ToolSearchHandler::new`.

*Call graph*: 1 external calls (clone).


##### `ToolSearchHandler::supports_parallel_tool_calls`  (lines 99–101)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that tool-search requests may run concurrently. Search is read-only over immutable indexed state, so parallel execution is safe.

**Data flow**: It takes `&self` and returns `true`.

**Call relations**: The runtime consults this trait method when deciding whether multiple search invocations can execute at the same time.


##### `ToolSearchHandler::handle`  (lines 103–105)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async search implementation into the boxed future required by the executor trait. It is a forwarding layer with no search logic of its own.

**Data flow**: It consumes a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes and pins the future, and returns it.

**Call relations**: The tool runtime invokes this trait method for execution; it immediately delegates to `ToolSearchHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ToolSearchHandler::handle_call`  (lines 109–145)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates a tool-search request, executes the search, and packages the matching tools into a `ToolSearchOutput`. It is the main runtime entry point for search queries.

**Data flow**: It takes a `ToolInvocation`, extracts `payload`, and accepts only `ToolPayload::ToolSearch { arguments }`; any other payload becomes a fatal error. It trims `arguments.query`, rejects empty queries, resolves `limit` from the request or `TOOL_SEARCH_DEFAULT_LIMIT`, rejects `limit == 0`, returns an empty `ToolSearchOutput` immediately if `self.search_infos` is empty, otherwise calls `self.search(query, limit)` and boxes the resulting tool list into `ToolSearchOutput`.

**Call relations**: This method is called only by `ToolSearchHandler::handle`. It delegates ranked retrieval to `search` and output boxing to `boxed_tool_output`.

*Call graph*: calls 2 internal fn (boxed_tool_output, search); called by 1 (handle); 4 external calls (new, format!, Fatal, RespondToModel).


##### `ToolSearchHandler::search`  (lines 151–164)

```
fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<LoadableToolSpec>, FunctionCallError>
```

**Purpose**: Runs the BM25 query against the indexed search text and maps ranked hits back to loadable tool specs. It bridges from search-engine results to tool-search output entries.

**Data flow**: It accepts a query string and a result limit, calls `self.search_engine.search(query, limit)`, converts each result to its document ID, looks up the corresponding `ToolSearchInfo` by index, maps those to `&ToolSearchEntry`, and passes the iterator into `self.search_output_tools`. It returns the resulting `Vec<LoadableToolSpec>` or any coalescing error.

**Call relations**: This helper is invoked by `handle_call` after request validation. It delegates final output shaping and namespace merging to `search_output_tools`.

*Call graph*: calls 1 internal fn (search_output_tools); called by 1 (handle_call); 1 external calls (search).


##### `ToolSearchHandler::search_output_tools`  (lines 166–173)

```
fn search_output_tools(
        &self,
        results: impl IntoIterator<Item = &'a ToolSearchEntry>,
    ) -> Result<Vec<LoadableToolSpec>, FunctionCallError>
```

**Purpose**: Coalesces a sequence of matched search entries into the final loadable tool-spec list returned to callers. Its main job is merging entries that belong to the same namespace.

**Data flow**: It takes any iterable of `&ToolSearchEntry`, clones each entry’s `output` field, feeds the sequence into `coalesce_loadable_tool_specs`, and wraps the result in `Ok(...)`.

**Call relations**: This helper is called by `search`, and it is also exercised directly by tests that want to validate coalescing behavior independently of BM25 ranking.

*Call graph*: called by 1 (search); 2 external calls (into_iter, coalesce_loadable_tool_specs).


##### `tests::cache_reuses_handler_for_identical_search_infos_and_rebuilds_for_changes`  (lines 192–212)

```
fn cache_reuses_handler_for_identical_search_infos_and_rebuilds_for_changes()
```

**Purpose**: Verifies that the handler cache returns the same `Arc` for identical search inventories and a different one when the indexed search text changes. This protects the cache’s equality-based reuse semantics.

**Data flow**: The test creates a default cache, builds one MCP-derived `ToolSearchInfo`, calls `get_or_build` twice with identical vectors and asserts pointer equality, then mutates the stored `search_text`, calls `get_or_build` again, and asserts pointer inequality with the original handler.

**Call relations**: It directly exercises `ToolSearchHandlerCache::get_or_build`, relying on MCP handler conversion helpers to produce realistic `ToolSearchInfo` input.

*Call graph*: 3 external calls (assert!, default, vec!).


##### `tests::mixed_search_results_coalesce_mcp_namespaces`  (lines 215–319)

```
fn mixed_search_results_coalesce_mcp_namespaces()
```

**Purpose**: Checks that mixed search hits from MCP tools and dynamic namespace tools are coalesced into the correct namespace-shaped output. It validates output shaping independently of ranking.

**Data flow**: The test constructs one dynamic namespace/tool spec and two MCP tool infos, converts them into `ToolSearchInfo` values, builds a `ToolSearchHandler`, manually selects a result ordering from `handler.search_infos`, calls `search_output_tools`, and compares the returned `Vec<LoadableToolSpec>` against an expected pair of namespace specs with merged MCP tools and a separate dynamic namespace.

**Call relations**: It directly invokes `ToolSearchHandler::new` and `search_output_tools` to validate namespace coalescing logic without depending on BM25 search ordering.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, tool_info, json!).


##### `tests::tool_info`  (lines 321–342)

```
fn tool_info(server_name: &str, tool_name: &str, description_prefix: &str) -> ToolInfo
```

**Purpose**: Creates a realistic `codex_mcp::ToolInfo` fixture for the tool-search tests. It standardizes MCP test input construction so cache and coalescing tests can focus on behavior.

**Data flow**: It takes `server_name`, `tool_name`, and `description_prefix`, then constructs and returns a `ToolInfo` with MCP namespace naming, a `rmcp::model::Tool` carrying an empty object schema, formatted description text, and default/empty values for optional connector and plugin metadata.

**Call relations**: This helper is used by both embedded tests to generate MCP tool metadata that can be converted into searchable entries.

*Call graph*: 6 external calls (new, new, format!, new, object, json!).


### `core/src/tools/handlers/tool_search_spec.rs`

`config` · `tool registration / startup`

This file is a small spec-construction helper for the deferred-tool discovery path. Its main job is to assemble a `codex_tools::ToolSpec::ToolSearch` value with a human-readable markdown description and a `JsonSchema::object` parameter schema containing `query` and `limit`. The schema always requires `query`, leaves `limit` optional, and sets `additionalProperties` to false.

The notable logic is in how source metadata is rendered into the description. The function walks the provided `&[ToolSearchSourceInfo]`, groups entries by `source.name` in a `BTreeMap<String, Option<String>>`, and deliberately preserves the first non-`None` description seen for a duplicated source name. That means duplicate sources collapse to one bullet, and a later `None` description cannot erase an earlier descriptive string. If no sources are enabled, the description explicitly says `None currently enabled.`; otherwise it emits one bullet per distinct source, sorted by `BTreeMap` key order. The final markdown also hard-codes guidance that MCP discovery must use `tool_search` rather than `list_mcp_resources` or `list_mcp_resource_templates`.

The test locks down both behaviors: deduplication of repeated source names and exact rendering of the resulting `ToolSpec`, including the default-limit text embedded in the `limit` field description.

#### Function details

##### `create_tool_search_tool`  (lines 7–62)

```
fn create_tool_search_tool(
    searchable_sources: &[ToolSearchSourceInfo],
    default_limit: usize,
) -> ToolSpec
```

**Purpose**: Constructs the full `ToolSpec::ToolSearch` definition for the deferred tool-search capability, including parameter schema and a markdown description listing searchable sources.

**Data flow**: It takes a slice of `ToolSearchSourceInfo` plus a `default_limit`. It first builds a `BTreeMap<String, JsonSchema>` for `query` and `limit`, then folds the source slice into a deduplicated `BTreeMap<String, Option<String>>` keyed by source name, preferring an existing non-empty description over later `None` values. That map is rendered into either `None currently enabled.` or newline-separated bullet lines, interpolated into the final description string, and returned inside `ToolSpec::ToolSearch { execution: "client", description, parameters }`.

**Call relations**: This helper is invoked by the surrounding tool-registration constructor (`new`) when the system exposes deferred tool discovery. Internally it delegates schema node creation to `JsonSchema::string`, `JsonSchema::number`, and `JsonSchema::object` so the caller receives a ready-to-register tool spec.

*Call graph*: calls 3 internal fn (number, object, string); called by 1 (new); 4 external calls (from, new, format!, vec!).


##### `tests::create_tool_search_tool_deduplicates_and_renders_enabled_sources`  (lines 72–112)

```
fn create_tool_search_tool_deduplicates_and_renders_enabled_sources()
```

**Purpose**: Verifies that duplicate source names collapse into one rendered bullet and that the generated tool spec matches the expected description and schema exactly.

**Data flow**: The test feeds `create_tool_search_tool` three `ToolSearchSourceInfo` values, including two entries for `Google Drive` with different description presence, and a default limit of 8. It compares the returned `ToolSpec::ToolSearch` against a fully spelled-out expected value, asserting the deduplicated source list, the preserved descriptive text, and the `JsonSchema::object` parameter structure.

**Call relations**: This is a unit test for `create_tool_search_tool`; it does not participate in runtime flow. Its single assertion acts as a regression guard for both the source-deduplication logic and the exact user-facing wording embedded in the generated spec.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/view_image.rs`

`domain_logic` · `request handling`

This file contains both the runtime handler for image viewing and the `ToolOutput` implementation that serializes image results back into the conversation. `ViewImageHandler` stores `ViewImageToolOptions`; its default configuration disables original-detail requests and omits `environment_id` from the schema. Through `ToolExecutor<ToolInvocation>`, it exposes `view_image`, generates its schema via `create_view_image_tool`, allows parallel calls, and forwards execution into `handle_call`.

`handle_call` begins with a modality gate: if the current model does not advertise `InputModality::Image`, it immediately returns the fixed unsupported-message error. It then requires a function payload, parses `ViewImageArgs`, and validates `detail` strictly: only `high`, `original`, or omission are accepted. Next it resolves the target environment, converts its cwd to a native absolute path, joins the requested relative `path`, constructs a filesystem sandbox from the turn context, and uses the environment filesystem to fetch metadata and file bytes via `PathUri`.

The handler rejects non-files, maps filesystem failures into path-specific model errors, and decides whether original resolution is allowed by combining the request with `can_request_original_image_detail(&turn.model_info)`. If the `ResizeAllImages` feature is enabled, it wraps the raw bytes directly as an octet-stream data URL and leaves resizing to history insertion; otherwise it decodes and optionally resizes with `load_for_prompt_bytes`, using `PromptImageMode::Original` or `ResizeToFit`. It emits `TurnItem::ImageView` started/completed events around the successful read and returns `ViewImageOutput { image_url, image_detail }`.

`ViewImageOutput` intentionally hides raw image data in logs, always reports success for logging, serializes to a `FunctionCallOutputPayload` containing an `InputImage` content item, and exposes a compact code-mode JSON object with `image_url` and `detail`. The tests cover log/code serialization, sandbox-context propagation, strict `detail` validation, and acceptance of explicit `high` detail.

#### Function details

##### `ViewImageHandler::default`  (lines 37–44)

```
fn default() -> Self
```

**Purpose**: Creates the default `view_image` handler configuration with conservative schema options.

**Data flow**: It takes no inputs and returns `ViewImageHandler { options }` where `can_request_original_image_detail` and `include_environment_id` are both `false`.

**Call relations**: Tests instantiate the handler through this default constructor, while production registration can use `ViewImageHandler::new` to expose additional schema fields.

*Call graph*: called by 3 (handle_accepts_explicit_high_detail, handle_passes_sandbox_context_for_local_filesystem_reads, handle_rejects_unsupported_detail).


##### `ViewImageHandler::new`  (lines 48–50)

```
fn new(options: ViewImageToolOptions) -> Self
```

**Purpose**: Builds a `view_image` handler with caller-specified schema options.

**Data flow**: It accepts a `ViewImageToolOptions` value and returns `Self { options }` without side effects.

**Call relations**: Core tool registration (`add_core_utility_tools`) uses this constructor when wiring the handler according to model capabilities and environment support.

*Call graph*: called by 1 (add_core_utility_tools).


##### `ViewImageHandler::tool_name`  (lines 71–73)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the external tool name for image viewing.

**Data flow**: It returns `ToolName::plain("view_image")` and reads no mutable state.

**Call relations**: The tool registry queries this during registration and dispatch.

*Call graph*: calls 1 internal fn (plain).


##### `ViewImageHandler::spec`  (lines 75–77)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Generates the model-facing `ToolSpec` for `view_image` based on the handler's options.

**Data flow**: It reads `self.options` and passes them to `create_view_image_tool`, returning the resulting `ToolSpec`.

**Call relations**: Called during tool exposure; the helper determines whether `detail` and `environment_id` appear in the schema.

*Call graph*: calls 1 internal fn (create_view_image_tool).


##### `ViewImageHandler::supports_parallel_tool_calls`  (lines 79–81)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that multiple image-view requests may run concurrently.

**Data flow**: It takes no inputs and returns `true`.

**Call relations**: The runtime uses this capability flag when scheduling tool calls.


##### `ViewImageHandler::handle`  (lines 83–85)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Boxes the async image-loading implementation into the trait-required future type.

**Data flow**: It consumes a `ToolInvocation`, calls `self.handle_call(invocation)`, pins the future, and returns it.

**Call relations**: This is the trait entrypoint invoked by the tool framework; all substantive work happens in `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ViewImageHandler::handle_call`  (lines 89–228)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates a `view_image` request, reads the target file from the selected environment under sandbox rules, converts it into a data URL, emits turn events, and returns a `ViewImageOutput`.

**Data flow**: It consumes a `ToolInvocation`. First it reads `turn.model_info.input_modalities` and rejects the call if `InputModality::Image` is absent. It then destructures the invocation, requires `ToolPayload::Function`, parses `ViewImageArgs`, and validates `detail` into `Option<ViewImageDetail>`, rejecting any unsupported string. It resolves the target environment, converts its cwd to a native absolute path, joins the requested path, builds a sandbox via `turn.file_system_sandbox_context`, obtains the environment filesystem, and converts the absolute path to `PathUri`. It fetches metadata and file bytes, rejecting missing paths, read failures, and non-file targets with explicit path-bearing errors.

Next it computes whether original detail is both requested and allowed by `can_request_original_image_detail`, selects `ImageDetail::Original` or `DEFAULT_IMAGE_DETAIL`, and chooses the image conversion path: raw `data_url_from_bytes("application/octet-stream", &file_bytes)` when `Feature::ResizeAllImages` is enabled, otherwise `load_for_prompt_bytes(..., PromptImageMode::Original|ResizeToFit)` followed by `.into_data_url()`. On success it emits `TurnItem::ImageView` started and completed events through the session and returns the boxed `ViewImageOutput`.

**Call relations**: Only `handle` calls this. It delegates argument parsing, environment resolution, filesystem access, image processing, feature gating, and event emission to shared subsystems; tests cover several early-return validation and sandbox branches.

*Call graph*: calls 4 internal fn (boxed_tool_output, parse_arguments, resolve_tool_environment, from_abs_path); called by 1 (handle); 7 external calls (ImageView, data_url_from_bytes, load_for_prompt_bytes, can_request_original_image_detail, format!, matches!, RespondToModel).


##### `ViewImageOutput::log_preview`  (lines 239–241)

```
fn log_preview(&self) -> String
```

**Purpose**: Produces a safe log string that reports only the data URL length, not the image contents.

**Data flow**: It reads `self.image_url.len()` and formats `"<image data URL omitted: {} bytes>"`. It returns that string and writes no state.

**Call relations**: The logging path calls this through the `ToolOutput` trait. The corresponding test verifies that image bytes are intentionally omitted from logs.

*Call graph*: 1 external calls (format!).


##### `ViewImageOutput::success_for_logging`  (lines 243–245)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks successful image-view outputs as successful for logging purposes.

**Data flow**: It takes no inputs beyond `&self` and returns `true`.

**Call relations**: The logging subsystem consults this trait method when recording tool outcomes.


##### `ViewImageOutput::to_response_item`  (lines 247–262)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Serializes the image result into a `ResponseInputItem::FunctionCallOutput` containing an `InputImage` content item.

**Data flow**: It takes the current output, a `call_id`, and ignores the payload. It builds `FunctionCallOutputBody::ContentItems(vec![FunctionCallOutputContentItem::InputImage { image_url: self.image_url.clone(), detail: Some(self.image_detail) }])`, wraps it in `FunctionCallOutputPayload { success: Some(true), body }`, and returns `ResponseInputItem::FunctionCallOutput { call_id: call_id.to_string(), output }`.

**Call relations**: The response-construction path invokes this through the `ToolOutput` trait so the model receives the image as structured multimodal output.

*Call graph*: 2 external calls (ContentItems, vec!).


##### `ViewImageOutput::code_mode_result`  (lines 264–269)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> serde_json::Value
```

**Purpose**: Returns a compact JSON object for code-mode consumers containing the generated data URL and detail hint.

**Data flow**: It ignores the payload and returns `json!({ "image_url": self.image_url, "detail": self.image_detail })`.

**Call relations**: Code-mode result handling calls this trait method instead of the richer response-item serializer. A unit test verifies the exact object shape.

*Call graph*: 1 external calls (json!).


##### `tests::replace_primary_environment_cwd`  (lines 289–302)

```
fn replace_primary_environment_cwd(turn: &mut crate::TurnContext, cwd: AbsolutePathBuf)
```

**Purpose**: Test helper that swaps the primary turn environment's cwd to a supplied absolute path.

**Data flow**: It takes a mutable `crate::TurnContext` and an `AbsolutePathBuf`, clones the current first `TurnEnvironment`, constructs a replacement `TurnEnvironment::new` with the same environment id, environment handle, and shell but a new `PathUri::from_abs_path(&cwd)`, and writes it back into `turn.environments.turn_environments[0]`.

**Call relations**: Image-handler tests call this helper to point the primary environment at a temporary directory containing test files.

*Call graph*: calls 2 internal fn (new, from_abs_path).


##### `tests::log_preview_omits_image_data`  (lines 305–312)

```
fn log_preview_omits_image_data()
```

**Purpose**: Verifies that `ViewImageOutput::log_preview` reports only byte length and not raw image data.

**Data flow**: It constructs a `ViewImageOutput` with a short data URL and default detail, calls `log_preview`, and asserts the returned string is `<image data URL omitted: 25 bytes>`.

**Call relations**: This is a focused unit test for the output type's logging behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::code_mode_result_returns_image_url_object`  (lines 315–332)

```
fn code_mode_result_returns_image_url_object()
```

**Purpose**: Checks the exact JSON object returned by `ViewImageOutput::code_mode_result`.

**Data flow**: It constructs a `ViewImageOutput`, calls `code_mode_result` with a dummy function payload, and asserts the result equals `{"image_url": ..., "detail": "high"}`.

**Call relations**: This test validates the code-mode serialization branch of the `ToolOutput` implementation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::handle_passes_sandbox_context_for_local_filesystem_reads`  (lines 335–367)

```
async fn handle_passes_sandbox_context_for_local_filesystem_reads()
```

**Purpose**: Ensures the handler performs filesystem reads through the turn's sandbox context rather than bypassing sandbox enforcement.

**Data flow**: It creates a test session and mutable turn, points the primary environment cwd at a temp directory, writes a fake image file, sets `turn.permission_profile` to `PermissionProfile::read_only()`, invokes `ViewImageHandler::default().handle(...)` with `path: "image.png"`, and asserts the result is a `FunctionCallError::RespondToModel` whose message mentions sandboxed filesystem operations requiring configured runtime paths.

**Call relations**: This integration-style test exercises the filesystem-access branch of `handle_call` under sandbox restrictions.

*Call graph*: calls 5 internal fn (make_session_and_context, default, new, read_only, plain); 9 external calls (new, new, assert!, replace_primary_environment_cwd, json!, panic!, write, tempdir, new).


##### `tests::handle_rejects_unsupported_detail`  (lines 370–395)

```
async fn handle_rejects_unsupported_detail()
```

**Purpose**: Verifies that `view_image.detail` rejects unsupported string values instead of silently coercing them.

**Data flow**: It creates a test session and turn, invokes `ViewImageHandler::default().handle(...)` with `detail: "low"`, captures the model-facing error, and asserts the message exactly matches the strict validation text.

**Call relations**: This test covers the explicit `detail` parsing branch in `handle_call` before any filesystem work occurs.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 6 external calls (new, new, assert_eq!, json!, panic!, new).


##### `tests::handle_accepts_explicit_high_detail`  (lines 398–427)

```
async fn handle_accepts_explicit_high_detail()
```

**Purpose**: Checks that `detail: "high"` is accepted as a valid explicit spelling of the default resized-image behavior.

**Data flow**: It creates a test session and mutable turn, points the environment cwd at a temp directory with a fake image file, disables permissions, invokes `ViewImageHandler::default().handle(...)` with `detail: "high"`, and expects image processing to proceed far enough to fail later with an `unable to process image` message rather than a detail-validation error.

**Call relations**: This test distinguishes accepted `high` from rejected unknown detail strings, covering the successful validation branch in `handle_call`.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 9 external calls (new, new, assert!, replace_primary_environment_cwd, json!, panic!, write, tempdir, new).


### `core/src/tools/handlers/view_image_spec.rs`

`config` · `tool registration / startup`

This file is responsible for constructing the `ToolSpec` for `view_image`. It introduces `ViewImageToolOptions`, a small copyable configuration struct that controls whether the schema exposes the `detail` parameter for requesting original resolution and whether it exposes `environment_id` for selecting a non-primary environment.

`create_view_image_tool` starts with a `BTreeMap` containing the required `path` property as a `JsonSchema::string`. If `can_request_original_image_detail` is enabled, it inserts a `detail` property using `JsonSchema::string_enum` with the only accepted values `"high"` and `"original"`, matching the runtime validator. If `include_environment_id` is enabled, it inserts a string property describing how to select an environment from `<environment_context>`. The function then wraps these properties in `JsonSchema::object`, requiring only `path` and forbidding additional properties, and returns `ToolSpec::Function(ResponsesApiTool { ... })` with `strict: false` and an explicit output schema.

That output schema is produced by `view_image_output_schema`, which returns a JSON object schema requiring exactly `image_url` and `detail`. The `detail` enum mirrors the runtime output values (`high` or `original`), making the tool contract concrete for downstream consumers and code-mode integrations.

#### Function details

##### `create_view_image_tool`  (lines 15–50)

```
fn create_view_image_tool(options: ViewImageToolOptions) -> ToolSpec
```

**Purpose**: Builds the full `ToolSpec::Function` definition for `view_image`, tailoring optional parameters to the supplied options.

**Data flow**: It takes `ViewImageToolOptions`, initializes a `BTreeMap` with the `path` string property, conditionally inserts `detail` as a string enum over `high` and `original`, conditionally inserts `environment_id` as a string property, then constructs `JsonSchema::object(properties, Some(vec!["path".to_string()]), Some(false.into()))`. It returns `ToolSpec::Function(ResponsesApiTool { name, description, strict: false, defer_loading: None, parameters, output_schema: Some(view_image_output_schema()) })`.

**Call relations**: The runtime handler's `spec()` method calls this during tool registration. It delegates output-schema construction to `view_image_output_schema` so the input and output contracts stay defined together.

*Call graph*: calls 4 internal fn (view_image_output_schema, object, string, string_enum); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `view_image_output_schema`  (lines 52–69)

```
fn view_image_output_schema() -> Value
```

**Purpose**: Defines the JSON schema for the structured result returned by `view_image`.

**Data flow**: It takes no inputs and returns a `serde_json::Value` describing an object with `image_url: string` and `detail: string` constrained to `high` or `original`, both required and with `additionalProperties: false`.

**Call relations**: Only `create_view_image_tool` calls this helper. It keeps the output contract centralized and synchronized with `ViewImageOutput::code_mode_result` and `to_response_item`.

*Call graph*: called by 1 (create_view_image_tool); 1 external calls (json!).


### `core/src/tools/handlers/get_context_remaining.rs`

`domain_logic` · `request handling`

This file contains both the runtime handler and its custom output type. `GetContextRemainingOutput` stores a single `Option<i64>` named `tokens_left`; `Some(n)` means the turn knows the model context window and can compute remaining budget, while `None` means the budget is unavailable. Its `fragment` method renders that state through `TokenBudgetRemainingContext`, using either `new(tokens_left)` or `unknown()`, so the textual representation stays consistent with the rest of the context system.

The `ToolOutput` implementation makes this output always log as successful, uses the rendered fragment for `log_preview`, converts it into a `FunctionToolOutput::from_text(..., Some(true))` when building a `ResponseInputItem`, and exposes a compact JSON object `{ "tokens_left": ... }` for code mode.

`GetContextRemainingHandler` is a stateless executor. It advertises a plain tool name from `GET_CONTEXT_REMAINING_TOOL_NAME` and a spec built by `create_get_context_remaining_tool`. At execution time it only accepts `ToolPayload::Function`; any other payload becomes `FunctionCallError::RespondToModel`. If `invocation.turn.model_context_window()` is absent, it returns an output with `tokens_left: None`. Otherwise it reads total token usage from `session.get_total_token_usage().await`, clamps negative usage to zero, subtracts it from the model window with `saturating_sub`, clamps the result to zero again, and returns that remaining-token count boxed as a tool output.

#### Function details

##### `GetContextRemainingOutput::new`  (lines 24–26)

```
fn new(tokens_left: Option<i64>) -> Self
```

**Purpose**: Constructs the output wrapper around an optional remaining-token count.

**Data flow**: Takes `Option<i64>` and stores it in the `tokens_left` field, returning a new `GetContextRemainingOutput`.

**Call relations**: It is used by `GetContextRemainingHandler::handle` for both the known-budget and unknown-budget branches.

*Call graph*: called by 1 (handle).


##### `GetContextRemainingOutput::fragment`  (lines 28–35)

```
fn fragment(&self) -> String
```

**Purpose**: Renders the remaining-context state into the textual fragment shown to the model and logs.

**Data flow**: Reads `self.tokens_left`; when it is `Some(tokens_left)`, it constructs `TokenBudgetRemainingContext::new(tokens_left)` and renders it, otherwise it constructs `TokenBudgetRemainingContext::unknown()` and renders that. Returns the resulting `String`.

**Call relations**: This is the shared formatting helper used by both `log_preview` and `to_response_item` so those surfaces stay identical.

*Call graph*: calls 2 internal fn (new, unknown); called by 2 (log_preview, to_response_item).


##### `GetContextRemainingOutput::log_preview`  (lines 39–41)

```
fn log_preview(&self) -> String
```

**Purpose**: Provides the log preview string for this tool output.

**Data flow**: Calls `self.fragment()` and returns the rendered text.

**Call relations**: It is part of the `ToolOutput` trait implementation and delegates all formatting to `fragment`.

*Call graph*: calls 1 internal fn (fragment).


##### `GetContextRemainingOutput::success_for_logging`  (lines 43–45)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this output as successful for logging purposes regardless of whether the token count is known.

**Data flow**: Returns the constant boolean `true` without reading or mutating additional state.

**Call relations**: This is consumed by generic logging paths; it has no internal delegation.


##### `GetContextRemainingOutput::to_response_item`  (lines 47–50)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the output into the standard function-tool response item injected back into the conversation.

**Data flow**: Reads `call_id` and `payload`, renders the text via `self.fragment()`, wraps it in `FunctionToolOutput::from_text(..., Some(true))`, and then delegates to that object's `to_response_item(call_id, payload)` to produce a `ResponseInputItem`.

**Call relations**: This method is called by generic tool-output handling when the result must be serialized into the model conversation.

*Call graph*: calls 2 internal fn (from_text, fragment).


##### `GetContextRemainingOutput::code_mode_result`  (lines 52–56)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Produces the structured JSON representation used by code-mode consumers.

**Data flow**: Ignores the payload and returns `json!({ "tokens_left": self.tokens_left })`.

**Call relations**: This is another `ToolOutput` trait hook, parallel to `to_response_item`, but aimed at structured downstream consumers.

*Call graph*: 1 external calls (json!).


##### `GetContextRemainingHandler::tool_name`  (lines 62–64)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Advertises the built-in tool under its fixed plain name.

**Data flow**: Constructs and returns `ToolName::plain(GET_CONTEXT_REMAINING_TOOL_NAME)`.

**Call relations**: The registry uses this metadata to expose and route the tool.

*Call graph*: calls 1 internal fn (plain).


##### `GetContextRemainingHandler::spec`  (lines 66–68)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the tool specification describing this built-in utility tool.

**Data flow**: Calls `create_get_context_remaining_tool()` and returns the resulting `ToolSpec`.

**Call relations**: This delegates schema construction to the companion spec file so runtime logic stays separate from wire-shape definition.

*Call graph*: calls 1 internal fn (create_get_context_remaining_tool).


##### `GetContextRemainingHandler::handle`  (lines 70–92)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Computes the remaining token budget for the current turn and returns it as a boxed tool output.

**Data flow**: Consumes a `ToolInvocation` inside a pinned async block. It first checks that `invocation.payload` matches `ToolPayload::Function`; otherwise it returns `FunctionCallError::RespondToModel`. It then queries `invocation.turn.model_context_window()`: if absent, it boxes `GetContextRemainingOutput::new(None)`; if present, it awaits `invocation.session.get_total_token_usage()`, clamps usage to nonnegative, computes `tokens_left = model_context_window.saturating_sub(active_context_tokens).max(0)`, wraps that in `GetContextRemainingOutput::new(Some(tokens_left))`, boxes it, and returns it.

**Call relations**: This is the sole execution path for the handler. It does not call other tool handlers, only the output constructor and session/turn accessors needed for the calculation.

*Call graph*: calls 2 internal fn (boxed_tool_output, new); 3 external calls (pin, matches!, RespondToModel).


### `core/src/tools/handlers/agent_jobs_spec.rs`

`config` · `tool registration and schema advertisement`

This file is pure tool-schema construction. It does not execute jobs; instead it builds `codex_tools::ToolSpec::Function` values that describe the accepted JSON parameters and human-readable semantics for two related tools. `create_spawn_agents_on_csv_tool` constructs an object schema with string fields for `csv_path`, `instruction`, `id_column`, and `output_csv_path`; numeric fields for `max_concurrency`, `max_workers`, and `max_runtime_seconds`; and an `output_schema` object whose description explains that it constrains each worker's reported result object. The resulting `ResponsesApiTool` marks only `csv_path` and `instruction` as required and disallows additional properties via `Some(false.into())`.

`create_report_agent_job_result_tool` similarly builds the worker callback schema. Its parameters require `job_id`, `item_id`, and `result`, with an optional boolean `stop` flag that requests cancellation of remaining items after recording the current result. Both specs set `strict: false`, leave `defer_loading` and `output_schema` unset, and embed detailed descriptions aimed at model behavior: the spawn tool blocks until completion and auto-exports CSV output, while the report tool is explicitly worker-only. The use of `BTreeMap` gives deterministic property ordering, which matters for stable tests and predictable serialized specs.

#### Function details

##### `create_spawn_agents_on_csv_tool`  (lines 6–72)

```
fn create_spawn_agents_on_csv_tool() -> ToolSpec
```

**Purpose**: Builds the full function-tool specification for launching one worker sub-agent per CSV row.

**Data flow**: It creates a `JsonSchema` object for `output_schema`, annotates it with a description, assembles a `BTreeMap<String, JsonSchema>` for all input properties, then wraps those properties in a `ResponsesApiTool` inside `ToolSpec::Function`. The return value is a complete immutable schema object; no external state is read or written.

**Call relations**: Called by `SpawnAgentsOnCsvHandler::spec` so the runtime can advertise its accepted arguments. It centralizes the schema text that tests compare exactly.

*Call graph*: calls 3 internal fn (number, object, string); called by 1 (spec); 4 external calls (from, new, Function, vec!).


##### `create_report_agent_job_result_tool`  (lines 74–115)

```
fn create_report_agent_job_result_tool() -> ToolSpec
```

**Purpose**: Builds the function-tool specification workers use to submit a result object for a specific job item.

**Data flow**: It creates a described object schema for `result`, defines `job_id`, `item_id`, `result`, and optional `stop` properties in a `BTreeMap`, and returns a `ToolSpec::Function` containing a `ResponsesApiTool` with those parameters and required-field metadata.

**Call relations**: Used by the corresponding report-result handler's `spec` path. Its descriptions encode an important call-flow rule: only worker agents should invoke this tool.

*Call graph*: calls 3 internal fn (boolean, object, string); called by 1 (spec); 4 external calls (from, new, Function, vec!).


### `core/src/tools/handlers/new_context_window_spec.rs`

`config` · `tool registration / schema publication`

This file is the spec companion to the `new_context` handler. It exports the shared constant `NEW_CONTEXT_WINDOW_TOOL_NAME` with value `"new_context"`, ensuring the handler and schema stay aligned on the externally visible tool identifier. The single function, `create_new_context_window_tool`, constructs a `ToolSpec::Function` wrapping a `ResponsesApiTool` with a short description and no output schema.

The parameter schema is deliberately an empty JSON object: `JsonSchema::object(BTreeMap::new(), None, Some(false.into()))` means there are no defined properties, no required fields, and additional properties are disallowed. `strict` is set to `false`, so the tool is not marked as strict at the Responses API layer even though the schema itself is minimal. `defer_loading` is left as `None`, indicating the tool is available immediately rather than lazily loaded. Because the tool's runtime behavior is just a session-side signal to start a new context window, there is no richer argument structure or typed output schema here. This file is purely declarative and is consumed by the handler's `spec` method.

#### Function details

##### `create_new_context_window_tool`  (lines 8–17)

```
fn create_new_context_window_tool() -> ToolSpec
```

**Purpose**: Constructs the `ToolSpec` describing the `new_context` function tool. It declares the tool name, human-readable description, and an empty-object parameter schema.

**Data flow**: Creates an empty `BTreeMap` for properties, passes it to `JsonSchema::object` with no required fields and `additionalProperties = false`, embeds that schema into a `ResponsesApiTool` with fixed metadata, wraps it in `ToolSpec::Function`, and returns it.

**Call relations**: Called by `NewContextWindowHandler::spec` when the runtime publishes or queries the tool definition.

*Call graph*: calls 1 internal fn (object); called by 1 (spec); 2 external calls (new, Function).


### `core/src/tools/handlers/plan_spec.rs`

`config` · `tool registration / schema publication`

This file is the declarative schema definition for the plan-update tool. `create_update_plan_tool` first builds `plan_item_properties`, a `BTreeMap` containing two fields: `step`, a descriptive string, and `status`, a string enum restricted to `pending`, `in_progress`, or `completed`. It then embeds that object schema inside the top-level `plan` array property, requiring both `step` and `status` on each item and disallowing additional properties on each plan item object.

At the top level, the schema exposes two properties: optional `explanation` text and required `plan`, which is the array of plan items. The final `ResponsesApiTool` is wrapped in `ToolSpec::Function` with name `update_plan`, `strict: false`, no deferred loading, and no output schema. The multiline description includes an important semantic rule not enforced structurally by the schema itself: at most one step can be `in_progress` at a time. That means consumers and downstream logic must treat this as a behavioral contract rather than a JSON-schema validation rule. Overall, this file is purely schema/configuration code used by `PlanHandler::spec` to advertise the tool to the model.

#### Function details

##### `create_update_plan_tool`  (lines 7–58)

```
fn create_update_plan_tool() -> ToolSpec
```

**Purpose**: Constructs the full `ToolSpec` for the `update_plan` function tool, including nested schemas for plan items and top-level arguments. It captures both field-level descriptions and the required `plan` property.

**Data flow**: Builds `plan_item_properties` as a `BTreeMap` of `JsonSchema` entries for `step` and `status`; wraps those in a `JsonSchema::object` requiring both keys and forbidding extra fields; places that object schema inside a `JsonSchema::array` for the `plan` property; builds a top-level properties map with optional `explanation` and required `plan`; then creates a `ResponsesApiTool` with fixed metadata and wraps it in `ToolSpec::Function` for return.

**Call relations**: Called by `PlanHandler::spec` whenever the runtime needs the advertised schema for the plan tool.

*Call graph*: calls 4 internal fn (array, object, string, string_enum); called by 1 (spec); 3 external calls (from, Function, vec!).


### Code-mode runtime integration
This group introduces the code-mode subsystem and then follows the core-facing specs and handlers that execute and wait on code cells.

### `code-mode/src/lib.rs`

`orchestration` · `service setup and code-mode session handling`

This crate root organizes the code-mode feature into `runtime` and `service` modules, then re-exports two different categories of API. First, it publicly re-exports everything from `codex_code_mode_protocol`, making the protocol’s request/response/message types available directly through this crate. Second, it selectively re-exports service-layer types from `service`: `CodeModeService`, `InProcessCodeModeSessionProvider`, and `NoopCodeModeSessionDelegate`. That combination suggests a layered design where protocol definitions are shared externally, while this crate adds executable behavior for hosting or brokering code-mode sessions. The naming indicates support for an in-process session provider and a no-op delegate implementation, likely useful for embedding, default wiring, or tests. The file itself contains no logic, but it is the integration point that turns lower-level protocol and service modules into a coherent public package. A reader should note that `runtime` is kept internal, implying that execution mechanics are intentionally hidden behind the exported service abstractions.


### `code-mode/src/runtime/globals.rs`

`orchestration` · `runtime startup before module evaluation`

This file is responsible for shaping the V8 global object before user code runs. `install_globals` starts from the current context’s global object, explicitly deletes `console`, `Atomics`, `SharedArrayBuffer`, and `WebAssembly`, then constructs and installs the runtime’s helper surface: `tools`, `ALL_TOOLS`, timeout helpers, output helpers, storage helpers, notification/yield helpers, and `exit`. Every installation step returns `Result<(), String>`, so startup fails fast with a concrete message if any V8 allocation or property mutation fails.

Two builders derive their contents from `RuntimeState.enabled_tools`. `build_tools_object` creates an object whose properties are each tool’s `global_name`, mapped to a V8 function generated by `tool_function`; the function carries the tool index as callback data so `tool_callback` can recover the selected tool later. `build_all_tools_value` creates an array of metadata objects with `name` and `description` fields for all enabled tools. `helper_function` is the generic constructor for named helper callbacks, attaching the helper name as callback data. `set_global` and `delete_global` centralize property mutation and produce formatted error messages that include the affected global name, which makes runtime initialization failures much easier to diagnose.

#### Function details

##### `install_globals`  (lines 14–47)

```
fn install_globals(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String>
```

**Purpose**: Configures the V8 global object for code-mode execution by removing unsupported globals and installing helper functions plus tool metadata.

**Data flow**: Obtains the current context’s global object from the scope. Calls `delete_global` for `console`, `Atomics`, `SharedArrayBuffer`, and `WebAssembly`; builds `tools` and `ALL_TOOLS`; creates helper functions for timeout, output, storage, notification, yielding, and exit callbacks; then writes each value onto the global object via `set_global`. Returns `Ok(())` only if every deletion, allocation, function creation, and property set succeeds.

**Call relations**: Called by `run_runtime` immediately after `RuntimeState` is placed into the scope and before any user module is evaluated. It orchestrates the helper constructors in this file and wires them to the callback functions defined in `callbacks.rs`.

*Call graph*: calls 5 internal fn (build_all_tools_value, build_tools_object, delete_global, helper_function, set_global); called by 1 (run_runtime); 1 external calls (get_current_context).


##### `build_tools_object`  (lines 49–65)

```
fn build_tools_object(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Object>, String>
```

**Purpose**: Constructs the `tools` object exposed to JavaScript, with one callable property per enabled tool.

**Data flow**: Creates a fresh V8 object, clones `RuntimeState.enabled_tools` from the scope slot if present, and iterates with indices. For each tool, allocates a V8 string from `tool.global_name`, creates a function via `tool_function(scope, tool_index)`, and sets that function on the object under the tool name. Returns the populated object or an allocation error string.

**Call relations**: Invoked by `install_globals` as part of startup. It delegates per-tool function creation to `tool_function`, which embeds the numeric index consumed later by `callbacks::tool_callback`.

*Call graph*: calls 1 internal fn (tool_function); called by 1 (install_globals); 2 external calls (new, new).


##### `build_all_tools_value`  (lines 67–99)

```
fn build_all_tools_value(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Value>, String>
```

**Purpose**: Builds the `ALL_TOOLS` array containing lightweight metadata for every enabled tool.

**Data flow**: Clones `RuntimeState.enabled_tools`, allocates a V8 array sized to the tool count, and allocates reusable `name` and `description` keys. For each tool it creates an object, allocates V8 strings for `tool.global_name` and `tool.description`, sets those fields on the object, and appends the object into the array by index. Returns the array as a `v8::Value` or a descriptive error if any set/index operation fails.

**Call relations**: Called only by `install_globals`. Unlike `build_tools_object`, it exposes metadata rather than executable callbacks, giving scripts a discoverable list of available tools.

*Call graph*: called by 1 (install_globals); 3 external calls (new, new, new).


##### `helper_function`  (lines 101–117)

```
fn helper_function(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    callback: F,
) -> Result<v8::Local<'s, v8::Function>, String>
```

**Purpose**: Creates a named V8 function from a Rust callback and attaches the helper name as callback data.

**Data flow**: Allocates a V8 string from the provided `name`, builds a `v8::FunctionTemplate` from the supplied callback with `.data(name.into())`, materializes it into a concrete function with `get_function`, and returns that function or an allocation/creation error string.

**Call relations**: Used repeatedly by `install_globals` for non-tool helpers such as `text`, `image`, `notify`, and timeout controls. It centralizes the common V8 function-template boilerplate so startup wiring stays uniform.

*Call graph*: called by 1 (install_globals); 2 external calls (builder, new).


##### `tool_function`  (lines 119–131)

```
fn tool_function(
    scope: &mut v8::PinScope<'s, '_>,
    tool_index: usize,
) -> Result<v8::Local<'s, v8::Function>, String>
```

**Purpose**: Creates a V8 function for a specific enabled tool, embedding the tool’s numeric index into callback data.

**Data flow**: Converts `tool_index` to a string, allocates it as a V8 string, builds a `v8::FunctionTemplate` using `tool_callback` with that string as `.data(...)`, then materializes and returns the function. Errors report failure to allocate callback data or create the function.

**Call relations**: Called by `build_tools_object` for each enabled tool. The embedded index is later parsed by `callbacks::tool_callback` to look up the corresponding `EnabledToolMetadata` entry in `RuntimeState`.

*Call graph*: called by 1 (build_tools_object); 2 external calls (builder, new).


##### `set_global`  (lines 133–146)

```
fn set_global(
    scope: &mut v8::PinScope<'s, '_>,
    global: v8::Local<'s, v8::Object>,
    name: &str,
    value: v8::Local<'s, v8::Value>,
) -> Result<(), String>
```

**Purpose**: Sets a named property on the V8 global object and converts V8 success/failure into a Rust `Result` with contextual error text.

**Data flow**: Allocates a V8 string key from `name`, calls `global.set(scope, key.into(), value)`, and returns `Ok(())` only when V8 reports `Some(true)`. Allocation or property-set failure becomes an `Err` mentioning the exact global name.

**Call relations**: Used exclusively by `install_globals` after helper values have been built. It provides consistent error reporting for every global property installation.

*Call graph*: called by 1 (install_globals); 3 external calls (set, format!, new).


##### `delete_global`  (lines 148–160)

```
fn delete_global(
    scope: &mut v8::PinScope<'s, '_>,
    global: v8::Local<'s, v8::Object>,
    name: &str,
) -> Result<(), String>
```

**Purpose**: Removes a named property from the V8 global object and reports failures with the property name included.

**Data flow**: Allocates a V8 string key from `name`, calls `global.delete(scope, key.into())`, and returns `Ok(())` only when V8 reports `Some(true)`. Allocation or deletion failure becomes an `Err` naming the global that could not be removed.

**Call relations**: Called by `install_globals` during environment hardening before helper installation. It is used specifically to strip built-ins that this runtime does not want exposed to user code.

*Call graph*: called by 1 (install_globals); 3 external calls (delete, format!, new).


### `code-mode/src/runtime/callbacks.rs`

`domain_logic` · `during JS execution and callback dispatch`

This file is the bridge between user JavaScript and the Rust runtime state stored in the V8 scope. Each exported callback has the V8 `FunctionCallback` shape and is installed as a global helper elsewhere. The callbacks fall into four groups: tool invocation (`tool_callback`), output emission (`text_callback`, `image_callback`, `generated_image_callback`, `notify_callback`), persistent state access (`store_callback`, `load_callback`), and runtime control (`set_timeout_callback`, `clear_timeout_callback`, `yield_control_callback`, `exit_callback`).

Most functions follow the same pattern: inspect `args`, coerce or serialize values using helpers from `value.rs`, fetch `RuntimeState` from `scope` slots, and either mutate state or send a `RuntimeEvent` over `state.event_tx`. Errors are surfaced back into JS with `throw_type_error`, so malformed arguments fail synchronously inside the script. `tool_callback` is the most stateful path: it decodes the tool index from callback metadata, serializes the optional input to JSON, allocates a `PromiseResolver`, stores it in `pending_tool_calls` under a generated `tool-{n}` id, emits a `RuntimeEvent::ToolCall`, and returns the JS promise. `exit_callback` is intentionally special: it marks `exit_requested` and throws the `EXIT_SENTINEL` string so module evaluation can treat this as a clean exit rather than a user-visible error.

#### Function details

##### `tool_callback`  (lines 13–72)

```
fn tool_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Implements each generated `tools.<name>(...)` function. It validates the embedded tool index, converts the first JS argument to optional JSON input, creates a promise resolver, records it in runtime state, emits a `RuntimeEvent::ToolCall`, and returns the promise to JavaScript.

**Data flow**: Reads callback metadata from `args.data()` and parses it as a `usize` tool index. Reads `args.get(0)` when present and converts it with `v8_value_to_json`, yielding `Option<JsonValue>`; malformed callback data or unserializable input triggers `throw_type_error` and early return. Allocates a `v8::PromiseResolver`, looks up the selected tool in `RuntimeState.enabled_tools`, generates an id like `tool-<next_tool_call_id>`, increments `next_tool_call_id` with saturation, inserts the resolver into `RuntimeState.pending_tool_calls`, sends `RuntimeEvent::ToolCall { id, name, kind, input }` on `event_tx`, and writes the created promise into `retval`.

**Call relations**: Installed indirectly through `globals::tool_function`, which binds the tool index into the callback data for each enabled tool. When user JS invokes a tool helper, this callback emits the event consumed by the service layer; later, `run_runtime` receives a matching `RuntimeCommand::ToolResponse` or `ToolError` and delegates to `module_loader::resolve_tool_response` to settle the stored promise.

*Call graph*: calls 2 internal fn (throw_type_error, v8_value_to_json); 7 external calls (data, get, length, set, format!, new, new).


##### `text_callback`  (lines 74–97)

```
fn text_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Converts its first argument into output text and emits it as a `FunctionCallOutputContentItem::InputText` runtime event.

**Data flow**: Uses `undefined` when no argument is supplied, otherwise reads `args.get(0)`. Passes the value to `serialize_output_text`; on conversion failure it throws a JS type error and returns. If `RuntimeState` is present in the scope, sends `RuntimeEvent::ContentItem(FunctionCallOutputContentItem::InputText { text })` through `event_tx`. Always sets the JS return value to `undefined`.

**Call relations**: Installed by `globals::install_globals` as the global `text` helper. It is invoked directly from user JS and delegates all coercion rules to `serialize_output_text` so output formatting stays consistent with `notify_callback`.

*Call graph*: calls 2 internal fn (serialize_output_text, throw_type_error); 5 external calls (get, length, set, ContentItem, undefined).


##### `image_callback`  (lines 99–130)

```
fn image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Accepts an image payload plus an optional detail override, normalizes it into a protocol image content item, and emits that item to the runtime event stream.

**Data flow**: Reads the first argument or substitutes `undefined`. If a second argument exists, accepts only a string, `null`, or `undefined`; any other type causes `throw_type_error`. Calls `normalize_output_image(scope, value, detail_override)` to validate and convert the payload into `FunctionCallOutputContentItem::InputImage`; if normalization already threw, it returns `Err(())` and this callback exits silently. On success, sends `RuntimeEvent::ContentItem(image_item)` if runtime state exists, then sets `retval` to `undefined`.

**Call relations**: Installed as the global `image` helper. It delegates all image-shape parsing and remote-URL rejection to `normalize_output_image`, then simply forwards the resulting content item into the event pipeline consumed by cell control.

*Call graph*: calls 2 internal fn (normalize_output_image, throw_type_error); 5 external calls (get, length, set, ContentItem, undefined).


##### `generated_image_callback`  (lines 132–162)

```
fn generated_image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Processes a generated-image result object, emitting both the normalized image content item and an optional textual `output_hint` as separate runtime events.

**Data flow**: Reads the first argument or `undefined`. Calls `generated_image_output_hint` to extract an optional `output_hint` string from the object; invalid shape or type throws a JS type error and returns. Reuses `normalize_output_image` with no detail override to produce the image content item. If runtime state exists, sends the image as `RuntimeEvent::ContentItem`, then, when `output_hint` is `Some`, sends a second `RuntimeEvent::ContentItem(FunctionCallOutputContentItem::InputText { text })`. Finally returns `undefined` to JS.

**Call relations**: Installed as the global `generatedImage` helper. It is the only callback in this file that composes two helper paths—`generated_image_output_hint` for metadata extraction and `normalize_output_image` for the actual image payload—before emitting one or two content events.

*Call graph*: calls 3 internal fn (generated_image_output_hint, normalize_output_image, throw_type_error); 5 external calls (get, length, set, ContentItem, undefined).


##### `generated_image_output_hint`  (lines 164–182)

```
fn generated_image_output_hint(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<String>, String>
```

**Purpose**: Extracts the optional `output_hint` property from a generated-image helper argument and enforces that it is either absent/undefined or a string.

**Data flow**: Attempts to cast the incoming V8 value to `v8::Object`; failure returns an explanatory `Err(String)`. Allocates the `output_hint` property key, reads the property, returns `Ok(None)` when it is `undefined`, returns `Err` when it is present but not a string, and otherwise returns `Ok(Some(output_hint_text))`.

**Call relations**: Called only by `generated_image_callback` before image normalization. It isolates the stricter object-shape validation for generated-image metadata so the callback can report a precise error before emitting any content.

*Call graph*: called by 1 (generated_image_callback); 2 external calls (try_from, new).


##### `store_callback`  (lines 184–215)

```
fn store_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Stores a JSON-serializable JS value under a string key in the runtime’s per-session key-value store and records the write for later commit.

**Data flow**: Converts `args.get(0)` to a string key using V8 string coercion; failure throws `store key must be a string`. Reads `args.get(1)` as the value and serializes it with `v8_value_to_json`. `Ok(None)` is treated as an unsupported non-plain/non-serializable value and triggers a formatted type error mentioning the key; `Err(error_text)` is forwarded as a type error. On success, mutably accesses `RuntimeState`, inserts the serialized value into both `stored_values` and `stored_value_writes`, and returns no explicit JS value.

**Call relations**: Installed as the global `store` helper. Its writes are later harvested by runtime completion and merged into the session-wide store by the service layer after `RuntimeEvent::Result`.

*Call graph*: calls 2 internal fn (throw_type_error, v8_value_to_json); 2 external calls (get, format!).


##### `load_callback`  (lines 217–242)

```
fn load_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Loads a previously stored JSON value by key and converts it back into a V8 value, returning `undefined` when the key is absent.

**Data flow**: Coerces `args.get(0)` to a string key or throws `load key must be a string`. Reads `RuntimeState.stored_values`, clones the matching `serde_json::Value` if present, and returns JS `undefined` immediately when absent. For a present value, calls `json_to_v8`; conversion failure throws `failed to load stored value`, otherwise the resulting V8 value is written into `retval`.

**Call relations**: Installed as the global `load` helper. It is the inverse of `store_callback`, relying on the same runtime slot state but only reading from the accumulated `stored_values` map.

*Call graph*: calls 2 internal fn (json_to_v8, throw_type_error); 3 external calls (get, set, undefined).


##### `notify_callback`  (lines 244–272)

```
fn notify_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Converts its argument to text, rejects blank notifications, and emits a `RuntimeEvent::Notify` tied to the current top-level tool call id.

**Data flow**: Reads the first argument or `undefined`, serializes it with `serialize_output_text`, and throws on conversion failure. Trims the resulting string and throws `notify expects non-empty text` if it is blank. If runtime state exists, sends `RuntimeEvent::Notify { call_id: state.tool_call_id.clone(), text }` on `event_tx`. Sets the JS return value to `undefined`.

**Call relations**: Installed as the global `notify` helper. The emitted event is consumed by `run_cell_control`, which spawns an async delegate notification task; unlike `text_callback`, this path does not append to cell output content.

*Call graph*: calls 2 internal fn (serialize_output_text, throw_type_error); 4 external calls (get, length, set, undefined).


##### `set_timeout_callback`  (lines 274–288)

```
fn set_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Implements the JS `setTimeout` helper by scheduling a Rust-side timeout and returning its numeric id.

**Data flow**: Passes the V8 scope and callback arguments to `timers::schedule_timeout`. On `Err(error_text)`, throws a JS type error and returns. On success, converts the returned `u64` timeout id to a V8 `Number` and writes it into `retval`.

**Call relations**: Installed as the global `setTimeout` helper. It is a thin wrapper around `timers::schedule_timeout`, which stores the callback and spawns the sleeping thread that later sends `RuntimeCommand::TimeoutFired`.

*Call graph*: calls 2 internal fn (schedule_timeout, throw_type_error); 2 external calls (set, new).


##### `clear_timeout_callback`  (lines 290–301)

```
fn clear_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Implements the JS `clearTimeout` helper by removing a pending timeout id from runtime state.

**Data flow**: Delegates argument parsing and removal to `timers::clear_timeout`. If that returns an error, throws it as a JS type error; otherwise writes `undefined` into `retval`.

**Call relations**: Installed as the global `clearTimeout` helper. It is the counterpart to `set_timeout_callback`, delegating all timeout-id interpretation to `timers::clear_timeout`.

*Call graph*: calls 2 internal fn (clear_timeout, throw_type_error); 2 external calls (set, undefined).


##### `yield_control_callback`  (lines 303–311)

```
fn yield_control_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Requests that the host yield the current cell response immediately without terminating execution.

**Data flow**: Ignores its JS arguments and return value. If `RuntimeState` is present, sends `RuntimeEvent::YieldRequested` on `event_tx`.

**Call relations**: Installed as the global `yield_control` helper. The service-side `run_cell_control` loop reacts to this event by cancelling any active yield timer and sending a yielded response to the current observer.


##### `exit_callback`  (lines 313–324)

```
fn exit_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Marks the runtime as intentionally exiting and throws a sentinel exception that higher layers recognize as a clean stop rather than an error.

**Data flow**: Mutably reads `RuntimeState` from the scope and sets `exit_requested = true` when available. Allocates a V8 string containing `EXIT_SENTINEL` and throws it as a JS exception via `scope.throw_exception`.

**Call relations**: Installed as the global `exit` helper. `module_loader::evaluate_main_module` and `module_loader::completion_state` both consult `is_exit_exception`, which checks `RuntimeState.exit_requested` plus the sentinel string to suppress user-visible errors for this path.

*Call graph*: 2 external calls (throw_exception, new).


### `core/src/tools/code_mode/mod.rs`

`orchestration` · `per-turn code-mode execution and nested tool dispatch`

This module ties together code-mode execution. `CodeModeService` wraps an optional `Arc<dyn CodeModeSession>` plus a shared `CodeModeDispatchBroker`. `new` creates a concrete `codex_code_mode::CodeModeService` with the broker as its delegate. The service methods `execute`, `wait`, `terminate`, and `shutdown` forward to the underlying session when available; `start_turn_worker` only enables nested dispatch for turns whose `tool_mode` is `ToolMode::CodeMode` or `ToolMode::CodeModeOnly`, returning a `CodeModeDispatchWorker` that lives for the turn.

The module also adapts runtime output into ordinary tool output. `handle_runtime_response` formats a status header, converts runtime content items into `FunctionCallOutputContentItem`s, sanitizes image detail according to the current model’s capabilities, truncates output using token-based policies, appends script errors for failed results, prepends wall-time/status text, and returns `FunctionToolOutput` with an explicit success flag. `truncate_code_mode_result` uses text-only truncation when every item is `InputText`, otherwise generic function-output truncation.

Nested tool invocation is handled by `call_nested_tool`. It rejects recursive calls to the public exec tool, converts the runtime’s `CodeModeNestedToolCall` into a core `ToolPayload` based on `CodeModeToolKind`, synthesizes a unique call id prefixed with the public tool name, and routes the call through `ToolCallRuntime::handle_tool_call_with_source` with `ToolCallSource::CodeMode { cell_id, runtime_tool_call_id }`. Helper functions serialize function-tool arguments from JSON objects, require strings for freeform tools, and surface model-facing validation errors when the runtime supplies the wrong shape. Inline tests lock the payload-conversion behavior and the warning-prefixed truncation format for text output.

#### Function details

##### `is_exec_tool_name`  (lines 50–52)

```
fn is_exec_tool_name(tool_name: &ToolName) -> bool
```

**Purpose**: Checks whether a tool name refers to the public un-namespaced code-mode exec tool.

**Data flow**: Reads `tool_name.namespace` and `tool_name.name`, returning true only when the namespace is `None` and the name equals `PUBLIC_TOOL_NAME`.

**Call relations**: Used to reject recursive nested exec calls and to validate incoming exec-tool invocations.

*Call graph*: called by 1 (call_nested_tool).


##### `CodeModeService::new`  (lines 66–74)

```
fn new() -> Self
```

**Purpose**: Constructs the core code-mode service wrapper and its delegate-backed runtime session.

**Data flow**: Creates a shared `CodeModeDispatchBroker`, passes a clone into `codex_code_mode::CodeModeService::with_delegate`, stores the resulting session in `Some(Arc<dyn CodeModeSession>)`, and returns `CodeModeService`.

**Call relations**: Used during session/service initialization to enable code-mode support.

*Call graph*: calls 2 internal fn (with_delegate, new); 1 external calls (new).


##### `CodeModeService::execute`  (lines 76–81)

```
async fn execute(
        &self,
        request: codex_code_mode::ExecuteRequest,
    ) -> Result<codex_code_mode::StartedCell, String>
```

**Purpose**: Starts a code-mode execution request through the underlying runtime session.

**Data flow**: Calls `self.session()?` to obtain the runtime session or an unavailable error, forwards the `ExecuteRequest`, awaits it, and returns `Result<StartedCell, String>`.

**Call relations**: Called by `CodeModeExecuteHandler::execute` when the public exec tool is invoked.

*Call graph*: calls 1 internal fn (session).


##### `CodeModeService::wait`  (lines 83–88)

```
async fn wait(
        &self,
        request: codex_code_mode::WaitRequest,
    ) -> Result<codex_code_mode::WaitOutcome, String>
```

**Purpose**: Waits for additional output or completion from an existing code-mode cell.

**Data flow**: Obtains the runtime session via `session()?`, forwards the `WaitRequest`, awaits it, and returns `Result<WaitOutcome, String>`.

**Call relations**: Used by the code-mode wait tool handler elsewhere in the module tree.

*Call graph*: calls 1 internal fn (session).


##### `CodeModeService::terminate`  (lines 90–95)

```
async fn terminate(
        &self,
        cell_id: CellId,
    ) -> Result<codex_code_mode::WaitOutcome, String>
```

**Purpose**: Terminates a running code-mode cell through the runtime session.

**Data flow**: Obtains the runtime session via `session()?`, forwards the target `CellId`, awaits termination, and returns `Result<WaitOutcome, String>`.

**Call relations**: Used by wait/termination flows that need to stop a running cell.

*Call graph*: calls 1 internal fn (session).


##### `CodeModeService::shutdown`  (lines 97–102)

```
async fn shutdown(&self) -> Result<(), String>
```

**Purpose**: Shuts down the underlying code-mode runtime session if one exists.

**Data flow**: Matches on `self.session`; if present it awaits `session.shutdown()`, otherwise it returns `Ok(())` immediately.

**Call relations**: Called during session teardown to stop code-mode infrastructure.


##### `CodeModeService::mark_cell_ready_for_dispatch`  (lines 104–106)

```
fn mark_cell_ready_for_dispatch(&self, cell_id: &codex_code_mode::CellId)
```

**Purpose**: Signals that a started cell may now receive nested tool calls and notifications.

**Data flow**: Forwards `cell_id` to `dispatch_broker.mark_cell_ready_for_dispatch` and returns unit.

**Call relations**: Called by the execute handler after the runtime cell has been started.


##### `CodeModeService::finish_cell_dispatch`  (lines 108–110)

```
fn finish_cell_dispatch(&self, cell_id: &CellId)
```

**Purpose**: Closes dispatch for a cell whose runtime lifecycle no longer needs nested communication.

**Data flow**: Forwards `cell_id` to `dispatch_broker.close_cell` and returns unit.

**Call relations**: Called when a cell’s first response is terminal or when later lifecycle code closes the cell.


##### `CodeModeService::start_turn_worker`  (lines 112–133)

```
fn start_turn_worker(
        &self,
        session: &Arc<Session>,
        turn: &Arc<TurnContext>,
        router: Arc<ToolRouter>,
        tracker: SharedTurnDiffTracker,
    ) -> Option<CodeModeD
```

**Purpose**: Starts per-turn nested-dispatch support only for turns running in code mode.

**Data flow**: Checks `turn.tool_mode` against `ToolMode::CodeMode | ToolMode::CodeModeOnly` and also requires `self.session.is_some()`. If either condition fails it returns `None`; otherwise it clones the session and turn into `ExecContext`, delegates to `dispatch_broker.start_turn_worker`, and returns `Some(CodeModeDispatchWorker)`.

**Call relations**: Called when a turn begins so nested tool dispatch is available only in code-mode turns.

*Call graph*: 2 external calls (clone, matches!).


##### `CodeModeService::session`  (lines 135–139)

```
fn session(&self) -> Result<&Arc<dyn CodeModeSession>, String>
```

**Purpose**: Returns the underlying runtime session or a user-facing unavailable error.

**Data flow**: Reads `self.session.as_ref()` and returns `Ok(&Arc<dyn CodeModeSession>)` when present, otherwise `Err("code mode is unavailable".to_string())`.

**Call relations**: Shared helper used by `execute`, `wait`, and `terminate`.

*Call graph*: called by 3 (execute, terminate, wait).


##### `handle_runtime_response`  (lines 142–186)

```
async fn handle_runtime_response(
    exec: &ExecContext,
    response: RuntimeResponse,
    max_output_tokens: Option<usize>,
    started_at: std::time::Instant,
) -> Result<FunctionToolOutput, Strin
```

**Purpose**: Converts a raw code-mode `RuntimeResponse` into standard `FunctionToolOutput` with status text, truncation, image-detail sanitization, and success/error signaling.

**Data flow**: Takes `ExecContext`, a `RuntimeResponse`, optional `max_output_tokens`, and `started_at`. It computes a status string with `format_script_status`, converts runtime content items via `into_function_call_output_content_items`, sanitizes image detail, optionally appends `Script error:` text for failed `Result` responses, truncates output with `truncate_code_mode_result`, prepends status and elapsed wall time, and returns `FunctionToolOutput::from_content(..., Some(success_or_running))`.

**Call relations**: Called by the execute and wait handlers after receiving runtime responses from the code-mode service.

*Call graph*: calls 6 internal fn (format_script_status, prepend_script_status, into_function_call_output_content_items, sanitize_runtime_image_detail, truncate_code_mode_result, from_content); 2 external calls (elapsed, format!).


##### `sanitize_runtime_image_detail`  (lines 188–190)

```
fn sanitize_runtime_image_detail(turn: &TurnContext, items: &mut [FunctionCallOutputContentItem])
```

**Purpose**: Downgrades or preserves image-detail fields in runtime output according to the current model’s capabilities.

**Data flow**: Reads `turn.model_info`, computes whether original image detail is allowed with `can_request_original_image_detail`, and mutates the provided `items` slice in place via `sanitize_original_image_detail`.

**Call relations**: Used inside `handle_runtime_response` before truncation and final output assembly.

*Call graph*: called by 1 (handle_runtime_response); 2 external calls (can_request_original_image_detail, sanitize_original_image_detail).


##### `format_script_status`  (lines 192–206)

```
fn format_script_status(response: &RuntimeResponse) -> String
```

**Purpose**: Produces the human-readable status line describing the runtime state of a code-mode response.

**Data flow**: Matches `RuntimeResponse`: yielded responses include the `cell_id` in `"Script running with cell ID ..."`, terminated responses become `"Script terminated"`, successful results become `"Script completed"`, and errored results become `"Script failed"`.

**Call relations**: Used by `handle_runtime_response` to build the header prepended to tool output.

*Call graph*: called by 1 (handle_runtime_response); 1 external calls (format!).


##### `prepend_script_status`  (lines 208–216)

```
fn prepend_script_status(
    content_items: &mut Vec<FunctionCallOutputContentItem>,
    status: &str,
    wall_time: Duration,
)
```

**Purpose**: Prepends a status/wall-time header to the front of function-call output content items.

**Data flow**: Computes wall time in tenths of a second from `Duration`, formats a header string containing status, wall time, and `Output:`, and inserts `FunctionCallOutputContentItem::InputText { text: header }` at index 0 of the mutable vector.

**Call relations**: Called by `handle_runtime_response` after truncation so the header is always present.

*Call graph*: called by 1 (handle_runtime_response); 2 external calls (as_secs_f32, format!).


##### `truncate_code_mode_result`  (lines 218–234)

```
fn truncate_code_mode_result(
    items: Vec<FunctionCallOutputContentItem>,
    max_output_tokens: Option<usize>,
) -> Vec<FunctionCallOutputContentItem>
```

**Purpose**: Applies token-based truncation to code-mode output, using a text-specialized path when all items are plain text.

**Data flow**: Resolves `max_output_tokens` through `resolve_max_tokens`, builds `TruncationPolicy::Tokens`, checks whether every item is `FunctionCallOutputContentItem::InputText`, and either calls `formatted_truncate_text_content_items_with_policy` or `truncate_function_output_items_with_policy`; returns the truncated item vector.

**Call relations**: Used by `handle_runtime_response` before the status header is prepended.

*Call graph*: calls 1 internal fn (resolve_max_tokens); called by 1 (handle_runtime_response); 3 external calls (formatted_truncate_text_content_items_with_policy, truncate_function_output_items_with_policy, Tokens).


##### `call_nested_tool`  (lines 236–276)

```
async fn call_nested_tool(
    _exec: ExecContext,
    tool_runtime: ToolCallRuntime,
    invocation: CodeModeNestedToolCall,
    cancellation_token: CancellationToken,
) -> Result<JsonValue, Function
```

**Purpose**: Routes a nested tool call originating from code-mode runtime execution into the core tool router with code-mode-specific source metadata.

**Data flow**: Destructures `CodeModeNestedToolCall` into cell id, runtime tool call id, tool name/kind, and optional input. It rejects recursive calls to the public exec tool, converts the input into a `ToolPayload` with `build_nested_tool_payload`, synthesizes a unique `call_id` prefixed by `PUBLIC_TOOL_NAME`, builds `ToolCall`, and awaits `tool_runtime.handle_tool_call_with_source(..., ToolCallSource::CodeMode { cell_id, runtime_tool_call_id }, cancellation_token)`. It returns the nested tool’s `code_mode_result()` JSON or a `FunctionCallError`.

**Call relations**: Called by `CoreTurnHost::invoke_tool` from the dispatch worker when the runtime requests a nested tool.

*Call graph*: calls 3 internal fn (build_nested_tool_payload, is_exec_tool_name, handle_tool_call_with_source); 2 external calls (format!, RespondToModel).


##### `build_nested_tool_payload`  (lines 278–287)

```
fn build_nested_tool_payload(
    tool_kind: CodeModeToolKind,
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<ToolPayload, String>
```

**Purpose**: Converts a code-mode nested tool call’s declared kind and JSON input into the corresponding core `ToolPayload`.

**Data flow**: Matches `tool_kind`: function tools delegate to `build_function_tool_payload`, freeform tools delegate to `build_freeform_tool_payload`, and returns the resulting `Result<ToolPayload, String>`.

**Call relations**: Used by `call_nested_tool` and directly by unit tests.

*Call graph*: calls 2 internal fn (build_freeform_tool_payload, build_function_tool_payload); called by 3 (call_nested_tool, build_nested_tool_payload_uses_freeform_kind, build_nested_tool_payload_uses_function_kind).


##### `build_function_tool_payload`  (lines 289–295)

```
fn build_function_tool_payload(
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<ToolPayload, String>
```

**Purpose**: Builds a function-style tool payload by serializing JSON object input into an arguments string.

**Data flow**: Calls `serialize_function_tool_arguments(tool_name, input)?` and wraps the resulting string in `ToolPayload::Function { arguments }`.

**Call relations**: Selected by `build_nested_tool_payload` for `CodeModeToolKind::Function`.

*Call graph*: calls 1 internal fn (serialize_function_tool_arguments); called by 1 (build_nested_tool_payload).


##### `serialize_function_tool_arguments`  (lines 297–309)

```
fn serialize_function_tool_arguments(
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<String, String>
```

**Purpose**: Validates and serializes nested function-tool input into the JSON string expected by core function tools.

**Data flow**: If `input` is `None`, returns `"{}"`. If it is `Some(JsonValue::Object(map))`, serializes that object with `serde_json::to_string`; serialization failures become formatted errors mentioning the tool name. Any non-object JSON value becomes an error stating that the tool expects a JSON object for arguments.

**Call relations**: Used only by `build_function_tool_payload`.

*Call graph*: called by 1 (build_function_tool_payload); 3 external calls (Object, format!, to_string).


##### `build_freeform_tool_payload`  (lines 311–319)

```
fn build_freeform_tool_payload(
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<ToolPayload, String>
```

**Purpose**: Builds a freeform/custom tool payload from a string input.

**Data flow**: If `input` is `Some(JsonValue::String(input))`, returns `ToolPayload::Custom { input }`; otherwise returns an error stating that the tool expects a string input.

**Call relations**: Selected by `build_nested_tool_payload` for `CodeModeToolKind::Freeform`.

*Call graph*: called by 1 (build_nested_tool_payload); 1 external calls (format!).


##### `tests::build_nested_tool_payload_uses_function_kind`  (lines 332–346)

```
fn build_nested_tool_payload_uses_function_kind()
```

**Purpose**: Verifies that function-kind nested tool payloads serialize object input into `ToolPayload::Function` arguments.

**Data flow**: Calls `build_nested_tool_payload(CodeModeToolKind::Function, ...)` with a JSON object, unwraps the result, pattern-matches the payload, and asserts the serialized arguments string equals `{"value":1}`.

**Call relations**: Unit test for function-kind payload conversion.

*Call graph*: calls 2 internal fn (build_nested_tool_payload, plain); 3 external calls (assert_eq!, json!, panic!).


##### `tests::build_nested_tool_payload_uses_freeform_kind`  (lines 349–363)

```
fn build_nested_tool_payload_uses_freeform_kind()
```

**Purpose**: Verifies that freeform-kind nested tool payloads preserve string input as `ToolPayload::Custom`.

**Data flow**: Calls `build_nested_tool_payload(CodeModeToolKind::Freeform, ...)` with a JSON string, unwraps the result, pattern-matches the payload, and asserts the custom input string is preserved.

**Call relations**: Unit test for freeform-kind payload conversion.

*Call graph*: calls 2 internal fn (build_nested_tool_payload, plain); 3 external calls (assert_eq!, json!, panic!).


##### `tests::truncated_text_output_starts_with_warning`  (lines 366–382)

```
fn truncated_text_output_starts_with_warning()
```

**Purpose**: Checks that text-only truncation emits the expected warning-prefixed output format.

**Data flow**: Builds a single long `FunctionCallOutputContentItem::InputText`, calls `truncate_code_mode_result(items, Some(5))`, and asserts the returned vector contains the expected warning text with original token count and truncation summary.

**Call relations**: Regression test for the text-specialized truncation path.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tools/code_mode/execute_spec.rs`

`config` · `tool registration/setup`

This file is a small spec-construction helper. `create_code_mode_tool` returns a `ToolSpec::Freeform` describing the public code-mode execution tool. The function embeds a fixed Lark grammar string named `CODE_MODE_FREEFORM_GRAMMAR` that accepts either plain source or source preceded by a `// @exec:` pragma line. It then fills a `FreeformTool` with the public tool name from `codex_code_mode::PUBLIC_TOOL_NAME`, a description generated by `codex_code_mode::build_exec_tool_description`, and a `FreeformToolFormat` declaring `type = "grammar"`, `syntax = "lark"`, and the grammar definition itself.

The generated description depends on the enabled nested tools, namespace descriptions, whether the environment is code-mode-only, and whether deferred tools are available, so this helper is the point where runtime capability information is turned into the model-visible tool contract. The inline test constructs a minimal enabled-tool list and asserts that the resulting `ToolSpec` exactly matches the expected `FreeformTool`, including the grammar text and description generation call. That test acts as a regression guard for the public schema exposed to models.

#### Function details

##### `create_code_mode_tool`  (lines 7–37)

```
fn create_code_mode_tool(
    enabled_tools: &[CodeModeToolDefinition],
    namespace_descriptions: &BTreeMap<String, codex_code_mode::ToolNamespaceDescription>,
    code_mode_only: bool,
    deferred
```

**Purpose**: Constructs the `ToolSpec::Freeform` for the public code-mode exec tool with its grammar-based input format.

**Data flow**: Takes enabled code-mode tool definitions, namespace descriptions, and two booleans controlling description wording. It builds the description with `build_exec_tool_description`, embeds the fixed grammar string into `FreeformToolFormat`, wraps everything in `FreeformTool`, and returns `ToolSpec::Freeform(...)`.

**Call relations**: Used during tool registration to expose the code-mode exec tool to the model.

*Call graph*: 2 external calls (build_exec_tool_description, Freeform).


##### `tests::create_code_mode_tool_matches_expected_spec`  (lines 46–87)

```
fn create_code_mode_tool_matches_expected_spec()
```

**Purpose**: Verifies that `create_code_mode_tool` produces the exact expected freeform tool spec for a representative input.

**Data flow**: Builds a one-entry `enabled_tools` vector, calls `create_code_mode_tool`, and compares the returned `ToolSpec` to an explicitly constructed expected `ToolSpec::Freeform` using `assert_eq!`.

**Call relations**: Unit test guarding the public tool schema and grammar emitted by this helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tools/code_mode/execute_handler.rs`

`domain_logic` · `tool execution during a code-mode turn`

This file wraps the code-mode runtime behind the core tool-execution interfaces. `CodeModeExecuteHandler` stores the public `ToolSpec` for the `exec` tool plus the nested tool specs that code mode is allowed to call. Its main work happens in `execute`: it parses the raw JavaScript/freeform source using `codex_code_mode::parse_exec_source`, builds an `ExecContext` from the current `Session` and `TurnContext`, derives the enabled nested-tool definitions with `codex_tools::collect_code_mode_tool_definitions`, and submits an `ExecuteRequest` to `session.services.code_mode_service`.

Once the runtime returns a `StartedCell`, the handler records timing and tracing metadata. It captures the `cell_id`, starts a code-cell trace through `rollout_thread_trace.start_code_cell_trace`, marks the cell ready for nested dispatch via `code_mode_service.mark_cell_ready_for_dispatch`, and awaits the cell’s initial runtime response. That raw response is recorded into the trace before any model-visible adaptation. If the first response is terminal (`Result` or `Terminated` rather than `Yielded`), the trace is also marked ended and the dispatch gate is closed immediately with `finish_cell_dispatch`; yielded cells remain open for later wait operations. Finally, the response is normalized through `handle_runtime_response` and wrapped as `FunctionToolOutput`.

The type implements both `ToolExecutor<ToolInvocation>` and `CoreToolRuntime`. `handle_call` enforces that only `ToolPayload::Custom { input }` with the un-namespaced exec tool name is accepted; everything else becomes a model-facing `FunctionCallError` explaining that raw JavaScript source text is required.

#### Function details

##### `CodeModeExecuteHandler::new`  (lines 22–27)

```
fn new(spec: ToolSpec, nested_tool_specs: Vec<ToolSpec>) -> Self
```

**Purpose**: Constructs a code-mode execute handler from the public tool spec and the nested tool specs available to code mode.

**Data flow**: Consumes `spec: ToolSpec` and `nested_tool_specs: Vec<ToolSpec>`, stores them in the struct, and returns `Self`.

**Call relations**: Used during tool registration to create the executor instance for the public `exec` tool.


##### `CodeModeExecuteHandler::execute`  (lines 29–91)

```
async fn execute(
        &self,
        session: std::sync::Arc<crate::session::session::Session>,
        turn: std::sync::Arc<crate::session::turn_context::TurnContext>,
        call_id: String,
```

**Purpose**: Runs the public code-mode exec tool: parse source, start a runtime cell, open nested dispatch, trace the cell, and adapt the first runtime response into tool output.

**Data flow**: Takes the current `Session`, `TurnContext`, `call_id`, and raw `code` string. It parses the source into code-mode args, builds `ExecContext`, derives enabled nested tools, records `started_at`, calls `code_mode_service.execute(ExecuteRequest { tool_call_id, enabled_tools, source, yield_time_ms, max_output_tokens })`, starts a rollout code-cell trace, marks the cell ready for dispatch, awaits `started_cell.initial_response()`, records that response in the trace, conditionally records terminal end and closes dispatch for non-yielded responses, then passes the response to `handle_runtime_response` and returns `Result<FunctionToolOutput, FunctionCallError>`.

**Call relations**: Called only from `handle_call` after payload validation succeeds.

*Call graph*: called by 1 (handle_call); 5 external calls (parse_exec_source, collect_code_mode_tool_definitions, matches!, now, handle_runtime_response).


##### `CodeModeExecuteHandler::tool_name`  (lines 95–97)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the public tool name handled by this executor.

**Data flow**: Constructs and returns `ToolName::plain(PUBLIC_TOOL_NAME)`.

**Call relations**: Used by the tool registry to index this executor under the code-mode exec tool.

*Call graph*: calls 1 internal fn (plain).


##### `CodeModeExecuteHandler::spec`  (lines 99–101)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the stored tool specification for the public exec tool.

**Data flow**: Clones `self.spec` and returns the clone.

**Call relations**: Used by registry code that needs to expose the tool schema/description.

*Call graph*: 1 external calls (clone).


##### `CodeModeExecuteHandler::handle`  (lines 103–105)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts `handle_call` to the boxed future type required by the `ToolExecutor` trait.

**Data flow**: Takes a `ToolInvocation`, boxes `self.handle_call(invocation)`, and returns the executor future.

**Call relations**: This is the trait entrypoint invoked by the tool router.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `CodeModeExecuteHandler::handle_call`  (lines 109–131)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates the invocation payload and dispatches valid exec calls to `execute`.

**Data flow**: Destructures `ToolInvocation` into session, turn, call id, tool name, and payload. If the payload is `ToolPayload::Custom { input }` and `is_exec_tool_name(&tool_name)` is true, it awaits `execute(session, turn, call_id, input)` and wraps the result with `boxed_tool_output`. Otherwise it returns `FunctionCallError::RespondToModel` with a message that the public tool expects raw JavaScript source text.

**Call relations**: Called by `handle`; it is the validation gate between generic tool routing and code-mode execution.

*Call graph*: calls 1 internal fn (execute); called by 1 (handle); 3 external calls (format!, is_exec_tool_name, RespondToModel).


##### `CodeModeExecuteHandler::matches_kind`  (lines 135–137)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this runtime handles custom/freeform tool payloads.

**Data flow**: Returns `true` when `payload` matches `ToolPayload::Custom { .. }`, otherwise `false`.

**Call relations**: Used by core tool-runtime selection to route custom payloads to this handler.

*Call graph*: 1 external calls (matches!).


### `core/src/tools/code_mode/wait_spec.rs`

`config` · `tool registration`

This file builds the `ToolSpec` advertised for the code-mode wait tool. `create_wait_tool` constructs a `BTreeMap<String, JsonSchema>` for four parameters: required `cell_id` as a string, optional `yield_time_ms` as a number, optional `max_tokens` as a number, and optional `terminate` as a boolean. The schema is wrapped in `JsonSchema::object` with `required = ["cell_id"]` and `additional_properties = false`, so callers may omit optional fields but may not send arbitrary extras.

The returned spec is `ToolSpec::Function(ResponsesApiTool { ... })`. Its `name` comes from `codex_code_mode::WAIT_TOOL_NAME`, and its description is assembled from a fixed introductory sentence plus the trimmed output of `codex_code_mode::build_wait_tool_description()`. `strict` is explicitly `false`, `output_schema` is `None`, and `defer_loading` is `None`, reflecting that this is a normal eagerly available function tool.

The test module asserts structural equality against a fully spelled-out expected `ToolSpec`. That test is important because it catches accidental changes to parameter ordering, descriptions, required fields, or the additional-properties setting, all of which affect model-visible behavior.

#### Function details

##### `create_wait_tool`  (lines 6–48)

```
fn create_wait_tool() -> ToolSpec
```

**Purpose**: Builds the complete function-tool specification for the code-mode wait operation. It defines the parameter schema, human-readable descriptions, and metadata exposed to the tool system.

**Data flow**: Takes no arguments → creates a `BTreeMap` of property schemas using `JsonSchema::string`, `number`, and `boolean` → formats a description string using `WAIT_TOOL_NAME`, `PUBLIC_TOOL_NAME`, and `build_wait_tool_description()` → wraps everything in `ToolSpec::Function(ResponsesApiTool { ... })` and returns it.

**Call relations**: This function is called by `CodeModeWaitHandler::spec` when the runtime needs the wait tool definition. It delegates primitive schema construction to `JsonSchema` helpers and keeps the handler implementation free of schema-building details.

*Call graph*: calls 4 internal fn (boolean, number, object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `tests::create_wait_tool_matches_expected_spec`  (lines 56–104)

```
fn create_wait_tool_matches_expected_spec()
```

**Purpose**: Verifies that `create_wait_tool` returns the exact expected `ToolSpec`, including descriptions, required fields, and parameter schema details. It serves as a snapshot-style regression test for the model-visible contract.

**Data flow**: Takes no arguments → calls `create_wait_tool()` → constructs an inline expected `ToolSpec::Function(ResponsesApiTool { ... })` → compares them with `assert_eq!`. It reads no shared state and writes no outputs beyond test assertions.

**Call relations**: This test exercises `create_wait_tool` directly. It does not delegate further beyond assertion machinery, and it protects callers such as `CodeModeWaitHandler::spec` from silent schema drift.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/code_mode/wait_handler.rs`

`orchestration` · `request handling`

This file defines `CodeModeWaitHandler`, the executor for the special code-mode control tool named by `WAIT_TOOL_NAME`. Its argument schema is represented by `ExecWaitArgs`, which requires `cell_id` and optionally accepts `yield_time_ms`, `max_tokens`, and `terminate`; serde defaults supply `DEFAULT_WAIT_YIELD_TIME_MS`, `None`, and `false` respectively.

The handler implements `ToolExecutor<ToolInvocation>` so it can advertise its tool name and schema and expose an async `handle` entry point. The real logic lives in `handle_call`. It first destructures the invocation and only accepts `ToolPayload::Function` whose tool name exactly matches the un-namespaced wait tool. It parses the JSON arguments with a generic `parse_arguments`, wrapping parse failures as `FunctionCallError::RespondToModel`.

After building an `ExecContext` from the session and turn, it records `started_at`, constructs a `codex_code_mode::CellId`, and chooses between `code_mode_service.terminate(cell_id)` and `code_mode_service.wait(WaitRequest { cell_id, yield_time_ms })` based on `args.terminate`. If the returned `WaitOutcome` is a live-cell response that is not `RuntimeResponse::Yielded`, the handler records the cell as ended in `rollout_thread_trace` and calls `finish_cell_dispatch` so reducer/runtime bookkeeping closes out the cell. Finally it delegates to `handle_runtime_response`, passing the optional `max_tokens` budget and elapsed-start anchor, then boxes the resulting tool output.

A subtle but important design choice is that pre/post tool-use hooks are explicitly disabled for this tool: `wait` is treated as internal runtime control flow, so hooks must not rewrite or block its payloads.

#### Function details

##### `default_wait_yield_time_ms`  (lines 34–36)

```
fn default_wait_yield_time_ms() -> u64
```

**Purpose**: Supplies the serde default for `ExecWaitArgs.yield_time_ms`. It centralizes the default wait interval so deserialization and runtime behavior stay aligned.

**Data flow**: Takes no arguments → returns `DEFAULT_WAIT_YIELD_TIME_MS` as `u64`. It reads a module-level constant and mutates no state.

**Call relations**: Serde invokes this function when `yield_time_ms` is omitted from incoming JSON for `ExecWaitArgs`. It is not part of the runtime call flow beyond argument deserialization.


##### `parse_arguments`  (lines 38–45)

```
fn parse_arguments(arguments: &str) -> Result<T, FunctionCallError>
```

**Purpose**: Deserializes a JSON argument string into a requested Rust type and rewrites parse failures into model-facing tool errors. It is the generic parser used by the wait handler before any service call is attempted.

**Data flow**: Takes `arguments: &str` and a target type `T: Deserialize` → calls `serde_json::from_str(arguments)` → returns `Ok(T)` on success or `Err(FunctionCallError::RespondToModel(...))` with the serde error embedded in the message.

**Call relations**: This helper is called from `CodeModeWaitHandler::handle_call` after the tool name/payload shape check passes. It delegates actual JSON parsing to `serde_json::from_str` so the handler can stay focused on wait/terminate control flow.

*Call graph*: called by 1 (handle_call); 1 external calls (from_str).


##### `CodeModeWaitHandler::tool_name`  (lines 48–50)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the canonical tool name for this executor. It binds the handler to the plain, non-namespaced code-mode wait tool identifier.

**Data flow**: Takes `&self` → constructs and returns `ToolName::plain(WAIT_TOOL_NAME)`. No external state is read.

**Call relations**: The tool registry calls this when registering or matching executors. It delegates name construction to `ToolName::plain` so the handler participates in standard tool dispatch.

*Call graph*: calls 1 internal fn (plain).


##### `CodeModeWaitHandler::spec`  (lines 52–54)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the JSON-schema-backed tool specification for the wait tool. This is what the model/runtime sees as the callable interface.

**Data flow**: Takes `&self` → calls `create_wait_tool()` → returns the resulting `ToolSpec`.

**Call relations**: The registry invokes this when exposing tool metadata. It delegates all schema construction to `wait_spec::create_wait_tool` so the runtime logic and schema definition remain separate.

*Call graph*: calls 1 internal fn (create_wait_tool).


##### `CodeModeWaitHandler::handle`  (lines 56–58)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async wait implementation to the boxed future type required by the `ToolExecutor` trait. It is the trait-facing entry point for execution.

**Data flow**: Takes `&self` and `invocation: ToolInvocation` → creates `self.handle_call(invocation)` future → boxes and pins it → returns `ToolExecutorFuture<'_>`.

**Call relations**: The tool dispatch layer calls this when the wait tool is selected. It immediately delegates all substantive work to `CodeModeWaitHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `CodeModeWaitHandler::handle_call`  (lines 62–132)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates a wait-tool invocation, performs either a wait or terminate operation against the code-mode service, closes tracing for completed cells, and converts the runtime outcome into a boxed tool output. It is the file's main control-flow function.

**Data flow**: Consumes `ToolInvocation`, extracting `session`, `turn`, `tool_name`, and `payload` → checks that payload is `ToolPayload::Function` and the tool name is the plain wait tool → parses JSON into `ExecWaitArgs` → builds `ExecContext { session, turn }`, records `Instant::now()`, and wraps `args.cell_id` in `codex_code_mode::CellId::new`. If `args.terminate` is true it awaits `code_mode_service.terminate(cell_id)`; otherwise it awaits `code_mode_service.wait(WaitRequest { cell_id, yield_time_ms })`. Service errors are mapped to `FunctionCallError::RespondToModel`. For non-yielding live-cell outcomes, it extracts the runtime `cell_id`, records the end event in `rollout_thread_trace.code_cell_trace_context(...).record_ended(response)`, and calls `finish_cell_dispatch(runtime_cell_id)`. Finally it awaits `handle_runtime_response(&exec, wait_response.into(), args.max_tokens, started_at)`, boxes the returned output with `boxed_tool_output`, and maps any formatting error to `RespondToModel`. If the payload/name check fails, it returns a model-facing JSON-arguments error immediately.

**Call relations**: This function is invoked only by `CodeModeWaitHandler::handle`. It delegates argument parsing to `parse_arguments`, runtime response shaping to `handle_runtime_response`, and uses session services for the actual wait/terminate operation plus trace/finalization side effects when a live cell completes.

*Call graph*: calls 2 internal fn (new, parse_arguments); called by 1 (handle); 5 external calls (format!, matches!, now, handle_runtime_response, RespondToModel).


##### `CodeModeWaitHandler::pre_tool_use_payload`  (lines 136–142)

```
fn pre_tool_use_payload(&self, _invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Suppresses pre-tool-use hook payload generation for the wait tool. This prevents hook logic from interfering with the internal code-mode wait loop.

**Data flow**: Takes `&self` and `_invocation: &ToolInvocation` → always returns `None`.

**Call relations**: The core tool runtime hook system calls this before execution. By returning `None`, the handler ensures no pre-use hook can block, rewrite, or annotate code-mode wait control traffic.


##### `CodeModeWaitHandler::post_tool_use_payload`  (lines 144–152)

```
fn post_tool_use_payload(
        &self,
        _invocation: &ToolInvocation,
        _result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Suppresses post-tool-use hook payload generation for the wait tool result. This preserves the raw wait result for code-mode control flow instead of replacing it with hook feedback.

**Data flow**: Takes `&self`, `_invocation: &ToolInvocation`, and `_result: &dyn ToolOutput` → always returns `None`.

**Call relations**: The runtime hook system calls this after execution. Returning `None` ensures the wait result continues directly into code-mode orchestration without post-hook substitution.


### Extension registry and standalone tool namespaces
These files define the shared extension registry and then wire in concrete standalone namespaces for web search, image generation, and goals.

### `ext/extension-api/src/registry.rs`

`orchestration` · `startup`

This file is the assembly point for the extension API. `ExtensionRegistryBuilder<C>` is the mutable registration surface hosts use while installing extensions. It stores one `Arc<dyn ExtensionEventSink>` plus ordered `Vec<Arc<dyn ...>>` collections for every contributor category: thread lifecycle, turn lifecycle, config, token usage, prompt/context, MCP servers, turn input, tools, tool lifecycle, turn-item post-processing, and approval review. `Default` initializes all vectors empty and installs `NoopExtensionEventSink`, giving hosts a safe baseline even when they register nothing.

The builder methods are intentionally thin: each registration method pushes one contributor into the corresponding vector, preserving registration order. `with_event_sink` swaps in a host-provided sink while inheriting otherwise empty defaults. `build` consumes the builder and transfers all accumulated state into `ExtensionRegistry<C>`, the immutable runtime view.

`ExtensionRegistry<C>` mainly exposes borrowed slices of each contributor list so orchestration code can iterate them without copying. The one nontrivial method is `approval_review`, which walks `approval_review_contributors` in registration order, awaits each contributor’s async decision, and short-circuits on the first `Some(ReviewDecision)`. If no contributor claims the prompt, it returns `None`. That ordering behavior is a key invariant tested elsewhere. Finally, `empty_extension_registry` wraps a freshly built empty registry in `Arc`, providing a shared default for hosts that do not install any extensions.

#### Function details

##### `ExtensionRegistryBuilder::default`  (lines 37–52)

```
fn default() -> Self
```

**Purpose**: Creates an empty builder with a no-op event sink and no registered contributors in any category. It establishes the baseline registration state for hosts and tests.

**Data flow**: It constructs a new `Arc<dyn ExtensionEventSink>` containing `NoopExtensionEventSink`, initializes each contributor field with `Vec::new()`, and returns the populated `ExtensionRegistryBuilder<C>`. No external state is read or modified.

**Call relations**: This is the common initialization path behind `ExtensionRegistryBuilder::new` and `with_event_sink`. It delegates only to `Arc::new` and `Vec::new` to allocate the sink and empty collections.

*Call graph*: 2 external calls (new, new).


##### `ExtensionRegistryBuilder::new`  (lines 57–59)

```
fn new() -> Self
```

**Purpose**: Returns a fresh empty registry builder using the default no-op event sink. It is the standard entry point for host registration code.

**Data flow**: It takes no arguments, calls `Self::default()`, and returns the resulting builder. No additional transformation occurs.

**Call relations**: Hosts, tests, and helper constructors call this when beginning extension installation. It delegates entirely to `default`, inheriting that method’s initialization behavior.

*Call graph*: called by 22 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, prompt_extension_test_registry, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, plan_mode_uses_contributed_turn_item_for_last_agent_message, finalized_turn_item_defers_mailbox_for_contributed_visible_text, finalized_turn_item_keeps_mailbox_open_for_commentary_text, handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested (+12 more)); 1 external calls (default).


##### `ExtensionRegistryBuilder::with_event_sink`  (lines 62–67)

```
fn with_event_sink(event_sink: Arc<dyn ExtensionEventSink>) -> Self
```

**Purpose**: Creates an empty builder that retains a host-provided event sink instead of the default no-op sink. This lets extensions emit events through host-defined plumbing during and after installation.

**Data flow**: It takes `event_sink: Arc<dyn ExtensionEventSink>`, constructs a builder using struct update syntax with `..Self::default()`, and returns it. The supplied sink is stored directly; all contributor vectors come from the default builder.

**Call relations**: Hosts call this when they need event emission wired into extension constructors or runtime behavior. It delegates to `default` for all non-sink fields while overriding the sink field.

*Call graph*: called by 1 (orchestrator_catalog_snapshot_caches_failure); 1 external calls (default).


##### `ExtensionRegistryBuilder::event_sink`  (lines 70–72)

```
fn event_sink(&self) -> Arc<dyn ExtensionEventSink>
```

**Purpose**: Returns a clone of the builder’s retained event sink so host installation code can pass it into extension constructors. It preserves shared ownership semantics via `Arc`.

**Data flow**: It takes `&self`, clones `self.event_sink` with `Arc::clone`, and returns the cloned `Arc<dyn ExtensionEventSink>`. It does not mutate the builder.

**Call relations**: Installation flows call this before registration is complete when constructing extensions that need to emit events. It delegates only to `Arc::clone`.

*Call graph*: called by 2 (install_with_backend, install_with_providers); 1 external calls (clone).


##### `ExtensionRegistryBuilder::approval_review_contributor`  (lines 75–77)

```
fn approval_review_contributor(&mut self, contributor: Arc<dyn ApprovalReviewContributor>)
```

**Purpose**: Registers one approval-review contributor at the end of the approval-review list. Registration order matters because runtime dispatch short-circuits on the first claim.

**Data flow**: It takes `&mut self` and `Arc<dyn ApprovalReviewContributor>`, pushes the contributor into `self.approval_review_contributors`, and returns `()`. It mutates only the builder’s internal vector.

**Call relations**: Host installation code invokes this while assembling the registry. The resulting order is later consumed by `ExtensionRegistry::approval_review`.


##### `ExtensionRegistryBuilder::thread_lifecycle_contributor`  (lines 80–85)

```
fn thread_lifecycle_contributor(
        &mut self,
        contributor: Arc<dyn ThreadLifecycleContributor<C>>,
    )
```

**Purpose**: Registers one thread lifecycle contributor in order. These contributors are later invoked during thread start, resume, idle, and stop orchestration.

**Data flow**: It accepts `&mut self` and `Arc<dyn ThreadLifecycleContributor<C>>`, appends the contributor to `self.thread_lifecycle_contributors`, and returns unit. Only the builder’s vector is mutated.

**Call relations**: Extension installation paths call this when a feature wants thread lifecycle hooks. Runtime thread orchestration later reads the accumulated slice from the built registry.

*Call graph*: called by 6 (install_with_backend, install, install, install, install_with_providers, install).


##### `ExtensionRegistryBuilder::turn_lifecycle_contributor`  (lines 88–90)

```
fn turn_lifecycle_contributor(&mut self, contributor: Arc<dyn TurnLifecycleContributor>)
```

**Purpose**: Registers one turn lifecycle contributor in order for later turn start/stop/abort/error notifications.

**Data flow**: It takes `&mut self` and `Arc<dyn TurnLifecycleContributor>`, pushes the contributor into `self.turn_lifecycle_contributors`, and returns `()`. No other state changes.

**Call relations**: Hosts call this during installation for features that observe turn lifecycle events. The built registry later exposes the ordered slice to turn orchestration code.

*Call graph*: called by 1 (install_with_backend).


##### `ExtensionRegistryBuilder::config_contributor`  (lines 93–95)

```
fn config_contributor(&mut self, contributor: Arc<dyn ConfigContributor<C>>)
```

**Purpose**: Registers one configuration-change contributor. These contributors are later notified after committed thread-config updates.

**Data flow**: It receives `&mut self` and `Arc<dyn ConfigContributor<C>>`, appends the contributor to `self.config_contributors`, and returns unit. It mutates only that vector.

**Call relations**: Installation code uses this to opt features into config-change callbacks. Runtime config update code later iterates the built registry’s config contributor slice.

*Call graph*: called by 5 (install_with_backend, install, install, install_with_providers, install).


##### `ExtensionRegistryBuilder::token_usage_contributor`  (lines 98–100)

```
fn token_usage_contributor(&mut self, contributor: Arc<dyn TokenUsageContributor>)
```

**Purpose**: Registers one token-usage contributor for later token accounting notifications.

**Data flow**: It takes `&mut self` and `Arc<dyn TokenUsageContributor>`, pushes the contributor into `self.token_usage_contributors`, and returns `()`. No external state is touched.

**Call relations**: Hosts call this while installing features that observe model token usage. Token-recording orchestration later consumes the ordered list from the registry.

*Call graph*: called by 1 (install_with_backend).


##### `ExtensionRegistryBuilder::prompt_contributor`  (lines 103–105)

```
fn prompt_contributor(&mut self, contributor: Arc<dyn ContextContributor>)
```

**Purpose**: Registers one prompt/context contributor in order. These contributors later add `PromptFragment` values during prompt assembly.

**Data flow**: It accepts `&mut self` and `Arc<dyn ContextContributor>`, appends the contributor to `self.context_contributors`, and returns unit. Only the builder’s vector changes.

**Call relations**: Prompt-related extension installation paths call this. Prompt assembly later iterates the registry’s context contributors in the same order they were registered.

*Call graph*: called by 3 (install, install, install_with_providers).


##### `ExtensionRegistryBuilder::mcp_server_contributor`  (lines 108–110)

```
fn mcp_server_contributor(&mut self, contributor: Arc<dyn McpServerContributor<C>>)
```

**Purpose**: Registers one runtime MCP server contributor in order. These contributors later overlay MCP server configuration.

**Data flow**: It takes `&mut self` and `Arc<dyn McpServerContributor<C>>`, pushes the contributor into `self.mcp_server_contributors`, and returns `()`. It mutates only that collection.

**Call relations**: Host/plugin installation code uses this to add MCP overlays. Runtime config resolution later reads the ordered contributor slice from the built registry.

*Call graph*: called by 2 (install, install_executor_plugins).


##### `ExtensionRegistryBuilder::turn_input_contributor`  (lines 113–115)

```
fn turn_input_contributor(&mut self, contributor: Arc<dyn TurnInputContributor>)
```

**Purpose**: Registers one turn-input contributor that can add model-visible contextual fragments for a submitted turn.

**Data flow**: It receives `&mut self` and `Arc<dyn TurnInputContributor>`, appends the contributor to `self.turn_input_contributors`, and returns unit. No other state is affected.

**Call relations**: Installation code calls this for features that contribute turn-local model input. Turn preparation logic later iterates the registry’s turn-input contributors.

*Call graph*: called by 1 (install_with_providers).


##### `ExtensionRegistryBuilder::tool_contributor`  (lines 118–120)

```
fn tool_contributor(&mut self, contributor: Arc<dyn ToolContributor>)
```

**Purpose**: Registers one native tool contributor in order. These contributors later expose `ToolExecutor<ToolCall>` implementations visible to the runtime.

**Data flow**: It takes `&mut self` and `Arc<dyn ToolContributor>`, pushes the contributor into `self.tool_contributors`, and returns `()`. It mutates only the builder’s tool list.

**Call relations**: Hosts call this while installing features that own tools. Tool discovery/orchestration later queries the built registry’s tool contributor slice.

*Call graph*: called by 5 (install_with_backend, install, install, install_with_providers, install).


##### `ExtensionRegistryBuilder::tool_lifecycle_contributor`  (lines 123–125)

```
fn tool_lifecycle_contributor(&mut self, contributor: Arc<dyn ToolLifecycleContributor>)
```

**Purpose**: Registers one tool lifecycle contributor for later start/finish notifications around tool execution.

**Data flow**: It accepts `&mut self` and `Arc<dyn ToolLifecycleContributor>`, appends the contributor to `self.tool_lifecycle_contributors`, and returns unit. Only that vector is modified.

**Call relations**: Installation code uses this for features that observe tool execution without owning tools. Tool execution orchestration later iterates the registry’s lifecycle contributor slice.

*Call graph*: called by 1 (install_with_backend).


##### `ExtensionRegistryBuilder::turn_item_contributor`  (lines 128–130)

```
fn turn_item_contributor(&mut self, contributor: Arc<dyn TurnItemContributor>)
```

**Purpose**: Registers one ordered turn-item contributor that can mutate parsed `TurnItem` values before emission.

**Data flow**: It takes `&mut self` and `Arc<dyn TurnItemContributor>`, pushes the contributor into `self.turn_item_contributors`, and returns `()`. It mutates only the corresponding vector.

**Call relations**: Hosts call this during installation for features that post-process turn items. Later turn-item pipelines consume the contributors in registration order.


##### `ExtensionRegistryBuilder::build`  (lines 133–148)

```
fn build(self) -> ExtensionRegistry<C>
```

**Purpose**: Consumes the mutable builder and produces the immutable runtime registry. It freezes contributor ordering and transfers ownership of all registered components.

**Data flow**: It takes ownership of `self`, moves each field into a new `ExtensionRegistry<C>`, and returns that registry. No cloning is performed; the builder is consumed.

**Call relations**: Host setup code calls this once registration is complete. The resulting registry is then passed into runtime orchestration, which uses its accessor methods and approval-review dispatcher.


##### `ExtensionRegistry::event_sink`  (lines 169–171)

```
fn event_sink(&self) -> Arc<dyn ExtensionEventSink>
```

**Purpose**: Returns a clone of the registry’s retained event sink for runtime use. It preserves shared ownership while keeping the registry immutable.

**Data flow**: It takes `&self`, clones `self.event_sink` with `Arc::clone`, and returns the cloned sink. No registry state is mutated.

**Call relations**: Runtime code calls this when it needs to emit extension-related events after installation has finished. It delegates only to `Arc::clone`.

*Call graph*: 1 external calls (clone).


##### `ExtensionRegistry::thread_lifecycle_contributors`  (lines 174–176)

```
fn thread_lifecycle_contributors(&self) -> &[Arc<dyn ThreadLifecycleContributor<C>>]
```

**Purpose**: Exposes the ordered slice of registered thread lifecycle contributors. It is a read-only view used by thread orchestration.

**Data flow**: It takes `&self` and returns `&[Arc<dyn ThreadLifecycleContributor<C>>]` referencing the internal vector. No copying or mutation occurs.

**Call relations**: Thread resume and stop flows call this accessor before iterating contributors. It is a simple bridge from registry storage to orchestration loops.

*Call graph*: called by 2 (resume_thread, stop_thread).


##### `ExtensionRegistry::turn_lifecycle_contributors`  (lines 179–181)

```
fn turn_lifecycle_contributors(&self) -> &[Arc<dyn TurnLifecycleContributor>]
```

**Purpose**: Exposes the ordered slice of registered turn lifecycle contributors for turn orchestration code.

**Data flow**: It takes `&self` and returns a slice reference to `self.turn_lifecycle_contributors`. No allocation or mutation occurs.

**Call relations**: Turn start, stop, and error notification paths call this accessor before invoking contributor hooks. It does not delegate further.

*Call graph*: called by 3 (notify_turn_error, start_turn_with_mode, stop_turn).


##### `ExtensionRegistry::config_contributors`  (lines 184–186)

```
fn config_contributors(&self) -> &[Arc<dyn ConfigContributor<C>>]
```

**Purpose**: Exposes the ordered slice of registered config contributors. Runtime config update code uses it to notify extensions after committed changes.

**Data flow**: It takes `&self` and returns `&[Arc<dyn ConfigContributor<C>>]` referencing the internal vector. No state changes occur.

**Call relations**: Configuration orchestration reads this slice when broadcasting config changes. It is a passive accessor.


##### `ExtensionRegistry::token_usage_contributors`  (lines 189–191)

```
fn token_usage_contributors(&self) -> &[Arc<dyn TokenUsageContributor>]
```

**Purpose**: Exposes the ordered slice of registered token-usage contributors for token accounting notifications.

**Data flow**: It takes `&self` and returns a slice reference to `self.token_usage_contributors`. No copying or mutation occurs.

**Call relations**: Token recording code calls this accessor before awaiting each contributor’s `on_token_usage` hook. It simply exposes stored registration order.

*Call graph*: called by 1 (record_token_usage).


##### `ExtensionRegistry::approval_review`  (lines 195–211)

```
async fn approval_review(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
        prompt: &str,
    ) -> Option<ReviewDecision>
```

**Purpose**: Runs approval-review contributors in registration order and returns the first claimed `ReviewDecision`. It implements the registry’s only built-in dispatch policy with short-circuit semantics.

**Data flow**: It takes `&self`, `&ExtensionData` for session and thread stores, and `prompt: &str`. It iterates `self.approval_review_contributors`, awaits each contributor’s `contribute(session_store, thread_store, prompt)`, and if the result is `Some(decision)` returns that decision immediately. If every contributor returns `None`, it returns `None` after the loop. It reads registry state and contributor outputs but does not mutate the registry itself.

**Call relations**: Runtime approval-review handling calls this when a rendered review prompt needs to be claimed by extensions. It delegates to each registered `ApprovalReviewContributor` until one accepts the prompt, then stops invoking later contributors.


##### `ExtensionRegistry::context_contributors`  (lines 214–216)

```
fn context_contributors(&self) -> &[Arc<dyn ContextContributor>]
```

**Purpose**: Exposes the ordered slice of registered prompt/context contributors. Prompt assembly uses it to collect `PromptFragment` values.

**Data flow**: It takes `&self` and returns a slice reference to `self.context_contributors`. No mutation or allocation occurs.

**Call relations**: Prompt contribution orchestration calls this accessor before iterating contributors. It is a passive read-only view.

*Call graph*: called by 1 (contribute_prompt).


##### `ExtensionRegistry::mcp_server_contributors`  (lines 219–221)

```
fn mcp_server_contributors(&self) -> &[Arc<dyn McpServerContributor<C>>]
```

**Purpose**: Exposes the ordered slice of registered MCP server contributors for runtime configuration resolution.

**Data flow**: It takes `&self` and returns `&[Arc<dyn McpServerContributor<C>>]` referencing the internal vector. No state changes occur.

**Call relations**: MCP runtime configuration assembly reads this slice when applying extension-owned overlays. It simply exposes stored contributors.


##### `ExtensionRegistry::turn_input_contributors`  (lines 224–226)

```
fn turn_input_contributors(&self) -> &[Arc<dyn TurnInputContributor>]
```

**Purpose**: Exposes the ordered slice of registered turn-input contributors. Turn preparation uses it to gather additional contextual user fragments.

**Data flow**: It takes `&self` and returns a slice reference to `self.turn_input_contributors`. No copying or mutation occurs.

**Call relations**: Turn input assembly code calls this accessor before awaiting each contributor. It is a straightforward registry read.


##### `ExtensionRegistry::tool_contributors`  (lines 229–231)

```
fn tool_contributors(&self) -> &[Arc<dyn ToolContributor>]
```

**Purpose**: Exposes the ordered slice of registered tool contributors. Tool discovery uses it to collect native tool executors.

**Data flow**: It takes `&self` and returns a slice reference to `self.tool_contributors`. No state is mutated.

**Call relations**: Tool enumeration code calls this accessor before asking each contributor for visible tools. It serves as the registry-to-runtime handoff point.

*Call graph*: called by 1 (tools).


##### `ExtensionRegistry::tool_lifecycle_contributors`  (lines 234–236)

```
fn tool_lifecycle_contributors(&self) -> &[Arc<dyn ToolLifecycleContributor>]
```

**Purpose**: Exposes the ordered slice of registered tool lifecycle contributors for execution notifications.

**Data flow**: It takes `&self` and returns a slice reference to `self.tool_lifecycle_contributors`. No allocation or mutation occurs.

**Call relations**: Tool finish notification code calls this accessor before invoking lifecycle hooks. It is a passive accessor preserving registration order.

*Call graph*: called by 1 (notify_tool_finish).


##### `ExtensionRegistry::turn_item_contributors`  (lines 239–241)

```
fn turn_item_contributors(&self) -> &[Arc<dyn TurnItemContributor>]
```

**Purpose**: Exposes the ordered slice of registered turn-item contributors. Turn-item post-processing pipelines use it to mutate parsed items in sequence.

**Data flow**: It takes `&self` and returns a slice reference to `self.turn_item_contributors`. No state changes occur.

**Call relations**: Turn-item contribution code calls this accessor before awaiting each contributor in order. It does not delegate further.


##### `empty_extension_registry`  (lines 245–247)

```
fn empty_extension_registry() -> Arc<ExtensionRegistry<C>>
```

**Purpose**: Constructs a shared empty registry for hosts that do not register any extension contributions. It provides a convenient zero-feature default wrapped in `Arc`.

**Data flow**: It takes no arguments, creates a new `ExtensionRegistryBuilder<C>`, builds it into an `ExtensionRegistry<C>`, wraps that registry in `Arc::new`, and returns `Arc<ExtensionRegistry<C>>`. No external state is read or modified.

**Call relations**: Callers use this when they need a registry object but have no extensions to install. It delegates to `ExtensionRegistryBuilder::new`, `build`, and `Arc::new` to produce the shared empty registry.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


### `ext/web-search/src/lib.rs`

`orchestration` · `startup / extension registration`

This file is the root module for the web-search extension crate. Its main job is structural: it declares five sibling modules—`extension`, `history`, `output`, `schema`, and `tool`—which together implement the extension’s behavior, data formats, result rendering, and tool wiring. The only public API exposed directly from the crate root is `extension::install`, re-exported as `install`, which signals that external callers are expected to bootstrap or register the extension through that single function rather than reaching into internal modules.

The design choice here is deliberate encapsulation. By keeping the module declarations private and selectively re-exporting only `install`, the crate root establishes a narrow, stable boundary while allowing the implementation details of search history tracking, output shaping, schema definitions, and tool logic to evolve internally. There is no executable logic in this file, no state, and no control flow beyond Rust’s module loading and name resolution. Its importance is architectural: it defines the extension as a cohesive subsystem with one obvious public entrypoint and a set of internal implementation modules organized by concern.


### `ext/web-search/src/extension.rs`

`orchestration` · `thread startup, config refresh, and tool discovery during request handling`

This file defines two small internal structs: `WebSearchExtension`, which carries an `Arc<AuthManager>` needed to build authenticated model providers, and `WebSearchExtensionConfig`, a cached per-thread snapshot containing three concrete decisions: whether web search is available, which `ModelProviderInfo` to use, and the exact `SearchSettings` to pass into the tool. The `From<&Config>` implementation is the key policy point: it enables the tool only when the configured provider is OpenAI and `web_search_mode` is not `Disabled`, then delegates detailed option translation to `search_settings`.

`search_settings` converts protocol/config-layer types into API-layer search types. It maps optional user location fields into `ApproximateLocation` with `LocationType::Approximate`, translates `WebSearchContextSize` into `SearchContextSize`, copies allowed-domain filters into `SearchFilters` while intentionally leaving `blocked_domains` as `None`, restricts callers to `AllowedCaller::Direct`, and derives `external_web_access` from `WebSearchMode` (`Live` true, `Cached`/`Disabled` false). Remaining fields come from `SearchSettings::default()`.

The extension participates in two lifecycle paths: on thread start it inserts a fresh `WebSearchExtensionConfig` into `thread_store`, and on config changes it overwrites that thread-local snapshot. Tool contribution then reads that cached config; if absent or marked unavailable, it contributes nothing. Otherwise it constructs a single `WebSearchTool` using the session ID from `session_store.level_id()`, a provider created by `create_model_provider(config.provider.clone(), Some(auth_manager.clone()))`, and cloned search settings. `install` wires the same extension instance into thread lifecycle, config, and tool contributor registries so all three hooks share the same auth manager and behavior. The included test verifies that when a thread store contains an enabled config, installation results in the expected namespaced web run tool with parallel tool-call support.

#### Function details

##### `WebSearchExtensionConfig::from`  (lines 38–47)

```
fn from(config: &Config) -> Self
```

**Purpose**: Builds the thread-local web-search configuration snapshot from the full application `Config`. It decides whether the extension should be exposed at all and packages the provider plus translated search settings into `WebSearchExtensionConfig`.

**Data flow**: Reads `config.web_search_mode.value()`, `config.model_provider`, and other web-search-related fields indirectly through `search_settings`. It computes `available` as true only when the provider reports OpenAI and the mode is not `WebSearchMode::Disabled`, clones the `ModelProviderInfo`, calls `search_settings(config, web_search_mode)`, and returns a new `WebSearchExtensionConfig` value without mutating external state.

**Call relations**: This conversion is the common policy path used by both lifecycle hooks: `WebSearchExtension::on_thread_start` uses it to seed thread-local extension state when a thread begins, and `WebSearchExtension::on_config_changed` uses it to refresh that state after configuration updates. It delegates all field-by-field search option translation to `search_settings` so availability logic stays separate from settings mapping.

*Call graph*: calls 1 internal fn (search_settings); called by 2 (on_config_changed, on_thread_start).


##### `search_settings`  (lines 50–82)

```
fn search_settings(config: &Config, web_search_mode: WebSearchMode) -> SearchSettings
```

**Purpose**: Translates web-search-related fields from `Config` and `WebSearchMode` into the `codex_api::SearchSettings` structure expected by the runtime tool/provider layer. It normalizes optional location, context size, domain filters, caller restrictions, and live-vs-cached web access.

**Data flow**: Consumes `&Config` plus the already-read `WebSearchMode`. It reads `config.web_search_config` and, if present, maps nested `user_location` into an `ApproximateLocation`, converts optional `WebSearchContextSize` variants into `SearchContextSize`, clones `allowed_domains` into `SearchFilters`, sets `allowed_callers` to `Some(vec![AllowedCaller::Direct])`, derives `external_web_access` from the mode, and fills all unspecified fields from `SearchSettings::default()`. It returns the assembled `SearchSettings` value.

**Call relations**: This helper is only invoked from `WebSearchExtensionConfig::from`, which uses it to keep config-to-settings translation centralized. It does not perform registration or storage itself; its sole role in the call flow is to provide the normalized settings object later consumed by `WebSearchExtension::tools` when constructing `WebSearchTool`.

*Call graph*: called by 1 (from); 2 external calls (default, vec!).


##### `WebSearchExtension::on_thread_start`  (lines 85–94)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: Initializes per-thread extension state when a new thread context starts. It asynchronously computes the current `WebSearchExtensionConfig` from the thread's `Config` and stores it in the thread-local extension data.

**Data flow**: Receives `ThreadStartInput<'a, Config>`, reads `input.config`, converts it with `WebSearchExtensionConfig::from`, and writes the resulting value into `input.thread_store` via `insert`. It returns an `ExtensionFuture<'a, ()>` created by boxing and pinning an async block.

**Call relations**: The extension framework invokes this hook at thread startup because `install` registers `WebSearchExtension` as a `ThreadLifecycleContributor`. Inside that startup path it delegates config interpretation to `WebSearchExtensionConfig::from`; later, `WebSearchExtension::tools` depends on the stored value being present in `thread_store`.

*Call graph*: calls 1 internal fn (from); 1 external calls (pin).


##### `WebSearchExtension::on_config_changed`  (lines 98–106)

```
fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    )
```

**Purpose**: Refreshes the thread-local web-search snapshot after configuration changes. It ignores the previous config and session store, recomputing the current extension state solely from the new config.

**Data flow**: Takes `_session_store`, `thread_store`, `_previous_config`, and `new_config`. It reads `new_config`, converts it through `WebSearchExtensionConfig::from`, and writes the new snapshot into `thread_store` with `insert`; it returns no value.

**Call relations**: The extension framework calls this hook whenever config changes because `install` registers the extension as a `ConfigContributor`. It mirrors `on_thread_start`'s initialization path, ensuring that subsequent calls to `WebSearchExtension::tools` see updated availability, provider, and search settings without rebuilding the extension object itself.

*Call graph*: calls 2 internal fn (insert, from).


##### `WebSearchExtension::tools`  (lines 110–130)

```
fn tools(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>>
```

**Purpose**: Contributes the concrete `WebSearchTool` instance for the current session/thread when web search is enabled. It performs the final gate check against cached thread-local config and otherwise returns no tools.

**Data flow**: Reads `thread_store.get::<WebSearchExtensionConfig>()`; if absent, returns an empty `Vec`. If present but `config.available` is false, also returns an empty `Vec`. Otherwise it reads `session_store.level_id()` for the session identifier, clones `config.provider` and `config.settings`, clones `self.auth_manager`, builds a provider with `create_model_provider(..., Some(...))`, constructs `WebSearchTool { session_id, provider, settings }`, wraps it in `Arc`, and returns a one-element vector of tool executors.

**Call relations**: This method is invoked by the extension registry during tool discovery because `install` registers the extension as a `ToolContributor`; the test exercises exactly that path by iterating over `tool_contributors()` and calling `tools`. It depends on `on_thread_start` or `on_config_changed` having populated `thread_store`, and it delegates actual search execution to the `WebSearchTool` it instantiates.

*Call graph*: 2 external calls (new, vec!).


##### `install`  (lines 133–138)

```
fn install(registry: &mut ExtensionRegistryBuilder<Config>, auth_manager: Arc<AuthManager>)
```

**Purpose**: Creates the shared `WebSearchExtension` instance and registers it with all relevant extension registries. This is the single integration point that turns the file's logic into active lifecycle and tool hooks.

**Data flow**: Accepts a mutable `ExtensionRegistryBuilder<Config>` and an `Arc<AuthManager>`. It constructs `Arc::new(WebSearchExtension { auth_manager })`, clones that `Arc` as needed, and writes registrations into `registry` via `thread_lifecycle_contributor`, `config_contributor`, and `tool_contributor`. It returns nothing.

**Call relations**: Callers use this function during extension setup; in this file the test invokes it to populate a builder before building the registry. Its role in the call flow is purely wiring: after registration, the framework later calls `WebSearchExtension::on_thread_start`, `WebSearchExtension::on_config_changed`, and `WebSearchExtension::tools` at the appropriate lifecycle moments.

*Call graph*: calls 3 internal fn (config_contributor, thread_lifecycle_contributor, tool_contributor); called by 1 (installed_extension_contributes_web_run_when_enabled); 1 external calls (new).


##### `tests::installed_extension_contributes_web_run_when_enabled`  (lines 157–183)

```
fn installed_extension_contributes_web_run_when_enabled()
```

**Purpose**: Verifies that installing the extension causes the registry to expose the expected web run tool when thread-local config marks web search as available. It checks both the tool name and that the tool advertises parallel-call support.

**Data flow**: Creates an `ExtensionRegistryBuilder<Config>`, constructs a testing `AuthManager` from a dummy API key, calls `install`, builds the registry, creates `session_store` and `thread_store`, inserts a handcrafted `WebSearchExtensionConfig` with `available: true`, an OpenAI `ModelProviderInfo`, and default settings, then iterates over registered tool contributors to collect `(tool_name, supports_parallel_tool_calls)` tuples. It asserts that the collected vector equals a single namespaced web run entry.

**Call relations**: This test is the direct caller of `install` in the provided graph. Rather than exercising startup/config hooks, it seeds `thread_store` manually to isolate the `ToolContributor` path and confirm that `WebSearchExtension::tools` contributes the correct tool shape once the extension has been registered.

*Call graph*: calls 5 internal fn (new, install, from_auth_for_testing, from_api_key, create_openai_provider); 3 external calls (default, new, assert_eq!).


### `ext/web-search/src/tool.rs`

`orchestration` · `request handling`

This file is the concrete bridge between the extension tool API and the Codex search service. Its central type, `WebSearchTool`, carries the per-session request identity (`session_id`), a `SharedModelProvider` used to fetch API provider/auth credentials asynchronously, and `SearchSettings` cloned into each outbound request. Through `ToolExecutor<ToolCall>`, it publishes a namespaced tool called `web.run`, declares a hosted-tool-compatible JSON schema by parsing `commands_schema()` without metadata compaction, marks the tool as directly exposed, and explicitly allows parallel calls.

The execution path starts in `handle`, which boxes the async `handle_call` future. `handle_call` parses JSON arguments into `SearchCommands`, computes a summarized `WebSearchAction` for telemetry/UI, resolves provider and auth from the shared provider, constructs a `SearchClient` over `ReqwestTransport` using the default reqwest client, and builds a `SearchRequest`. That request includes the current session id, selected model, recent conversation input from `recent_input(call.conversation_history.items())`, optional commands/settings, and a token cap derived from the truncation policy with overflow fallback to `u64::MAX`.

Before and after the remote `search` call, it emits `ExtensionTurnItem::WebSearch` items so the turn stream reflects tool start/completion. Error handling is intentionally split: malformed tool arguments become `RespondToModel`, while provider/auth/search failures become fatal. Helper functions encode subtle behavior: empty arguments mean default commands, action inference prefers `search_query` then `image_query`, `open` only reports a URL when `ref_id` is a literal URL, and `find` preserves the pattern even when the reference is an internal search result id.

#### Function details

##### `WebSearchTool::tool_name`  (lines 43–45)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the externally visible tool identifier for this executor as the namespaced tool `web.run`.

**Data flow**: It reads no mutable state beyond the compile-time namespace/name constants and transforms them into a `ToolName` via `ToolName::namespaced`. It returns that `ToolName` without side effects.

**Call relations**: This is invoked by the extension framework when registering or matching the executor to incoming tool calls. It delegates only to the namespacing constructor so the rest of the system sees this implementation under the `web` namespace and `run` function name.

*Call graph*: calls 1 internal fn (namespaced).


##### `WebSearchTool::spec`  (lines 47–66)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the tool definition advertised to the model, including the namespace wrapper, function description, and JSON parameter schema for search commands.

**Data flow**: It calls `commands_schema()` to obtain the Rust-side schema source, parses it with `parse_tool_input_schema_without_compaction` so field descriptions are preserved, and panics if that schema cannot be parsed because the definition is treated as a build-time invariant. It then assembles and returns `ToolSpec::Namespace` containing a `ResponsesApiNamespace` with one `ResponsesApiTool` named `run`, the markdown description from `WEB_RUN_DESCRIPTION`, `strict: false`, the parsed parameters, and no output schema or deferred loading metadata.

**Call relations**: The framework calls this during tool discovery/registration so hosted and local definitions stay aligned. Its main delegation is to schema-generation helpers and namespace-description helpers; after that it is pure assembly of the advertised tool contract.

*Call graph*: calls 1 internal fn (commands_schema); 5 external calls (parse_tool_input_schema_without_compaction, default_namespace_description, panic!, Namespace, vec!).


##### `WebSearchTool::exposure`  (lines 68–70)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Declares that this tool is directly exposed rather than hidden behind another abstraction or gated mode.

**Data flow**: It takes no inputs besides `self` and returns the constant enum value `ToolExposure::Direct`. It does not read or mutate internal state.

**Call relations**: This is consulted by the tool framework when deciding how the tool should be surfaced to the model. It is a leaf decision point with no further delegation.


##### `WebSearchTool::supports_parallel_tool_calls`  (lines 72–74)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Signals that multiple web-search invocations may safely run concurrently.

**Data flow**: It ignores instance fields and returns the constant boolean `true`. No state is changed.

**Call relations**: The runtime uses this capability flag when scheduling tool calls. Because `handle_call` builds per-request clients and requests from cloned state, this method enables concurrent dispatch without additional coordination logic here.


##### `WebSearchTool::handle`  (lines 76–78)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation into the boxed future type required by the `ToolExecutor` trait.

**Data flow**: It consumes the incoming `ToolCall`, passes it into `self.handle_call(call)`, and wraps the resulting future with `Box::pin`. It returns a `ToolExecutorFuture` and performs no immediate I/O itself.

**Call relations**: This is the trait entrypoint invoked by the extension runtime for each tool call. Its only job is to forward control into `WebSearchTool::handle_call`, where all parsing, network access, and event emission occur.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `WebSearchTool::handle_call`  (lines 82–123)

```
async fn handle_call(&self, call: ToolCall) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Executes one `web.run` request end-to-end: parse arguments, derive action metadata, build the search client/request, emit lifecycle events, call the backend, and wrap the response as tool output.

**Data flow**: It reads the `ToolCall` payload, first converting function arguments into `SearchCommands` with `parse_commands`, then summarizing those commands into a `WebSearchAction` via `command_action`. It asynchronously reads provider and auth credentials from `self.provider`, constructs a `SearchClient` using `ReqwestTransport::new(build_reqwest_client())`, and builds a `SearchRequest` from `self.session_id`, `call.model`, recent conversation items from `recent_input`, the parsed commands, cloned `self.settings`, and a token budget converted to `u64` with `u64::MAX` fallback on conversion failure. It writes progress to `call.turn_item_emitter` by emitting a started `web_search_item` with `WebSearchAction::Other`, performs `client.search(&request, HeaderMap::new()).await`, emits a completed `web_search_item` with the derived action, and returns `Box<dyn ToolOutput>` containing `SearchOutput::new(response.output)`. Provider/auth/search failures are mapped to `FunctionCallError::Fatal`; argument parsing failures propagate as returned errors from `parse_commands`.

**Call relations**: This is called only from `WebSearchTool::handle` after the runtime dispatches a tool invocation. It orchestrates the whole call chain: argument parsing, action inference, provider/auth lookup, HTTP client creation, backend search execution, and turn-item emission before returning the final output object to the extension framework.

*Call graph*: calls 8 internal fn (new, new, recent_input, new, command_action, parse_commands, web_search_item, build_reqwest_client); called by 1 (handle); 6 external calls (new, new, api_auth, api_provider, clone, try_from).


##### `parse_commands`  (lines 126–134)

```
fn parse_commands(call: &ToolCall) -> Result<SearchCommands, FunctionCallError>
```

**Purpose**: Converts the raw tool-call argument string into `SearchCommands`, treating missing or whitespace-only arguments as an empty/default command set.

**Data flow**: It reads the serialized argument string from `call.function_arguments()`. If the string is empty after trimming, it returns `SearchCommands::default()`; otherwise it deserializes JSON with `serde_json::from_str` into `SearchCommands`. Errors from argument extraction or JSON parsing are returned as `FunctionCallError`, with parse failures specifically wrapped as `RespondToModel` so the model can be told its arguments were invalid.

**Call relations**: This helper is invoked at the start of `WebSearchTool::handle_call` to normalize the incoming tool payload before any backend work begins. It does not call back into the tool logic; it is the gatekeeper that decides whether execution can proceed with parsed commands.

*Call graph*: called by 1 (handle_call); 3 external calls (default, function_arguments, from_str).


##### `command_action`  (lines 136–163)

```
fn command_action(commands: &SearchCommands) -> WebSearchAction
```

**Purpose**: Derives a concise `WebSearchAction` summary from `SearchCommands` for UI/telemetry turn items, preferring search intent over navigation intent.

**Data flow**: It inspects the `SearchCommands` fields in priority order. It first checks `search_query`, then `image_query`, converting either through `query_action`; if neither yields an action, it examines the first `open` operation and returns `OpenPage` only when `literal_url(&operation.ref_id)` succeeds; failing that, it examines the first `find` operation and returns `FindInPage` with an optional literal URL and cloned pattern. If none of those branches apply, it returns `WebSearchAction::Other`.

**Call relations**: This is called by `WebSearchTool::handle_call` before the backend request so the tool can emit a meaningful completion item afterward. It delegates to `query_action` for query lists and `literal_url` when deciding whether a reference id should be exposed as a real URL.

*Call graph*: called by 1 (handle_call).


##### `query_action`  (lines 165–177)

```
fn query_action(queries: &[SearchQuery]) -> Option<WebSearchAction>
```

**Purpose**: Maps one or more `SearchQuery` values into the `WebSearchAction::Search` shape expected by turn-item reporting.

**Data flow**: It pattern-matches on the slice of `SearchQuery`. An empty slice becomes `None`; a single query becomes `Some(WebSearchAction::Search { query: Some(query.q.clone()), queries: None })`; multiple queries become `Some(WebSearchAction::Search { query: None, queries: Some(vec_of_cloned_q_strings) })` by iterating and collecting each `q` field.

**Call relations**: This helper is used only from `command_action` when either `search_query` or `image_query` is present. Its role is to preserve the distinction between a single query string and a multi-query batch in the emitted action metadata.

*Call graph*: 1 external calls (iter).


##### `literal_url`  (lines 179–181)

```
fn literal_url(ref_id: &str) -> Option<String>
```

**Purpose**: Determines whether a command reference id is an actual URL string rather than an internal search-result reference token.

**Data flow**: It takes `ref_id: &str`, attempts `Url::parse(ref_id)`, and returns `Some(ref_id.to_string())` only if parsing succeeds; otherwise it returns `None`. It has no side effects.

**Call relations**: This helper is called from `command_action` when summarizing `open` and `find` operations. It prevents internal ids like `turn0search0` from being reported as navigated URLs while still allowing `find` actions to retain their pattern even when the URL is unknown.

*Call graph*: 1 external calls (parse).


##### `web_search_item`  (lines 183–189)

```
fn web_search_item(call_id: &str, action: WebSearchAction) -> ExtensionTurnItem
```

**Purpose**: Constructs the `ExtensionTurnItem::WebSearch` payload emitted at tool start and completion.

**Data flow**: It takes a `call_id` and a concrete `WebSearchAction`, computes a human-readable `query` string with `web_search_action_detail(&action)`, and packages those values into `WebSearchItem { id, query, action }`, then wraps it in `ExtensionTurnItem::WebSearch`. It returns the assembled turn item without mutating external state.

**Call relations**: This helper is used twice by `WebSearchTool::handle_call`: once before the backend request with a generic `Other` action and once after completion with the derived action. It centralizes the exact shape of emitted web-search turn items so both lifecycle events use the same formatting logic.

*Call graph*: called by 1 (handle_call); 2 external calls (web_search_action_detail, WebSearch).


##### `tests::command_action_reports_queries_and_navigation_detail`  (lines 200–240)

```
fn command_action_reports_queries_and_navigation_detail()
```

**Purpose**: Verifies that `command_action` produces the expected `WebSearchAction` for representative search, open, and find command payloads, including internal reference ids versus literal URLs.

**Data flow**: The test defines a table of JSON argument strings paired with expected `WebSearchAction` values, deserializes each string into `SearchCommands` with `serde_json::from_str`, invokes `command_action`, and asserts equality with `assert_eq!`. It writes no persistent state; its output is pass/fail test status.

**Call relations**: This test exercises the helper logic in isolation rather than the full networked tool path. It specifically documents the intended precedence and URL-detection behavior that `WebSearchTool::handle_call` relies on when emitting completion metadata.

*Call graph*: 3 external calls (assert_eq!, from_str, vec!).


### `ext/web-search/src/output.rs`

`io_transport` · `request handling`

This file is a small adapter between the web-search extension and the shared extension/protocol APIs. Its only data type, `SearchOutput`, stores a single `String` containing the rendered search result text that should be returned to the model. The implementation is intentionally minimal: there is no parsing, formatting, or branching logic beyond wrapping that text in the correct protocol enum variants.

`SearchOutput` implements `ToolOutput`, which lets the extension runtime treat search results uniformly with outputs from other tools. The trait methods encode important metadata choices: logging always reports a fixed preview string instead of the actual search text, logging always marks the operation as successful, and the output is explicitly flagged as containing external context so downstream consumers know the content originated outside the conversation. The main conversion path is `to_response_item`, which ignores the incoming `ToolPayload` and builds a `ResponseInputItem::FunctionCallOutput` using the supplied `call_id`. The actual search text is inserted as a single `FunctionCallOutputContentItem::InputText`, then wrapped with `FunctionCallOutputPayload::from_content_items`.

The test locks in the wire-format contract: a `SearchOutput` created from plain text must serialize to exactly one plaintext content item under the matching call ID. That makes this file the canonical definition of how web-search results re-enter the conversation loop.

#### Function details

##### `SearchOutput::new`  (lines 12–14)

```
fn new(output: String) -> Self
```

**Purpose**: Constructs a `SearchOutput` by storing the provided rendered search-result text unchanged.

**Data flow**: Takes one owned `String` argument, `output`, and moves it into the struct field `output`. Returns a new `SearchOutput` value; it does not read or mutate any external state.

**Call relations**: This is the creation point for the output wrapper. It is used by the extension's call-handling path when a search result has been produced, and by the unit test to build a concrete instance before asserting the protocol conversion behavior.

*Call graph*: called by 2 (emits_plaintext_function_call_output, handle_call).


##### `SearchOutput::log_preview`  (lines 18–20)

```
fn log_preview(&self) -> String
```

**Purpose**: Provides a fixed, non-sensitive preview string for logs instead of exposing the actual search result contents.

**Data flow**: Reads no fields from `self` and ignores the stored output text. Returns a newly allocated `String` containing the literal `[standalone web search output]`; it writes no state.

**Call relations**: This method participates in the `ToolOutput` logging contract. It is invoked by generic extension/runtime logging code when it needs a human-readable summary without dumping the full external search content.


##### `SearchOutput::success_for_logging`  (lines 22–24)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this output as a successful tool result for logging and status reporting purposes.

**Data flow**: Consumes only `&self` and reads no internal fields. Returns the constant boolean `true` and does not mutate any state.

**Call relations**: This is another `ToolOutput` metadata hook used by surrounding runtime code when deciding how to classify the tool invocation in logs or telemetry.


##### `SearchOutput::contains_external_context`  (lines 26–28)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: Declares that the output text comes from an external source and should be treated as external context.

**Data flow**: Takes `&self`, reads no fields, and returns the constant boolean `true`. It has no side effects.

**Call relations**: This method informs generic tool-processing code that the response carries externally sourced information, which can affect downstream handling, attribution, or safety policy.


##### `SearchOutput::to_response_item`  (lines 30–39)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Transforms the stored search text into the protocol-level `FunctionCallOutput` item that is fed back into the conversation.

**Data flow**: Reads `self.output` and clones it, takes `call_id: &str`, and accepts a `&ToolPayload` that is intentionally unused. It constructs `ResponseInputItem::FunctionCallOutput` with `call_id.to_string()` and a `FunctionCallOutputPayload` built from a one-element vector containing `FunctionCallOutputContentItem::InputText { text: cloned_output }`. The return value is the fully assembled response item; no persistent state is modified.

**Call relations**: This is the core adapter method required by `ToolOutput`. It is called by the extension/runtime when a tool result must be serialized into the shared response stream, and it delegates payload assembly to `FunctionCallOutputPayload::from_content_items` after creating the single-item vector.

*Call graph*: calls 1 internal fn (from_content_items); 1 external calls (vec!).


##### `tests::emits_plaintext_function_call_output`  (lines 54–73)

```
fn emits_plaintext_function_call_output()
```

**Purpose**: Verifies that `SearchOutput` emits exactly the expected plaintext function-call output structure.

**Data flow**: Creates a `SearchOutput` from the literal `search output`, passes a sample call ID and a dummy `ToolPayload::Function { arguments: "{}" }` into `to_response_item`, and compares the returned `ResponseInputItem` against a manually constructed expected value. It writes no non-test state; its observable effect is pass/fail test status.

**Call relations**: This test exercises the normal construction path by calling `SearchOutput::new`, then validates the protocol conversion contract through `assert_eq!`. It serves as a regression check for the exact enum variants and content-item layout produced by `to_response_item`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `ext/image-generation/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the minimal public surface for the image-generation extension. It declares three internal modules—`backend`, `extension`, and `tool`—which separate provider/backend integration, extension registration, and tool behavior. The only public re-export is `extension::install`, signaling that consumers are expected to integrate this extension through a single installer entrypoint rather than by constructing lower-level pieces directly. In addition, the file defines two crate-visible constants: `IMAGE_GEN_NAMESPACE` with value `"image_gen"` and `IMAGEGEN_TOOL_NAME` with value `"imagegen"`. These constants provide canonical identifiers for registration, routing, prompt/tool metadata, or metrics labels inside the crate, avoiding duplicated string literals and ensuring all internal components refer to the same namespace and tool name. The file itself contains no control flow, but it establishes an important invariant for the rest of the extension: all image-generation functionality should be grouped under the `image_gen` namespace and exposed through the `imagegen` tool identifier.


### `ext/image-generation/src/extension.rs`

`orchestration` · `thread startup, config changes, tool enumeration`

This file contains the extension-facing policy for whether image generation should appear in a thread. `ImageGenerationExtension` holds an `AuthManager`, while `ImageGenerationExtensionConfig` snapshots the thread-relevant configuration: whether the current model provider supports this standalone path, which provider to use, and the thread's `codex_home`. The `From<&Config>` implementation computes that snapshot, currently marking the feature available only when `config.model_provider.is_openai()` is true. On thread start and on config changes, the extension stores a fresh `ImageGenerationExtensionConfig` in thread-scoped `ExtensionData`, ensuring later tool enumeration sees current settings. The `ToolContributor` implementation then gates tool exposure on two conditions: the stored config must exist and say `available`, and the current auth must use the Codex backend. If either check fails, it returns no tools. Otherwise it constructs a single `ImageGenerationTool` using a `CodexImagesBackend` built from `create_model_provider`, passes through `codex_home`, and uses the thread store's level id as the thread identifier string. The `install` function registers the same extension instance for thread lifecycle, config updates, and tool contribution so all three hooks share one auth manager.

#### Function details

##### `ImageGenerationExtensionConfig::from`  (lines 35–42)

```
fn from(config: &Config) -> Self
```

**Purpose**: Derives the thread-scoped image-generation configuration snapshot from the full core `Config`. It decides whether the standalone image tool should even be considered available.

**Data flow**: It takes `&Config`, reads `model_provider` and `codex_home`, computes `available` from `config.model_provider.is_openai()`, clones the provider and home path, and returns a new `ImageGenerationExtensionConfig`.

**Call relations**: It is called by both `on_thread_start` and `on_config_changed` so thread-scoped extension data stays synchronized with the latest configuration.

*Call graph*: called by 2 (on_config_changed, on_thread_start).


##### `ImageGenerationExtension::on_thread_start`  (lines 47–56)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: Seeds thread-scoped image-generation configuration when a thread begins. It ensures later tool enumeration has the necessary config snapshot.

**Data flow**: It takes `ThreadStartInput<Config>`, converts `input.config` into `ImageGenerationExtensionConfig`, inserts that config into `input.thread_store`, and returns a boxed async future.

**Call relations**: The extension framework invokes it during thread startup because the extension implements `ThreadLifecycleContributor<Config>`. It delegates config derivation to `ImageGenerationExtensionConfig::from`.

*Call graph*: calls 1 internal fn (from); 1 external calls (pin).


##### `ImageGenerationExtension::on_config_changed`  (lines 61–69)

```
fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    )
```

**Purpose**: Refreshes the stored image-generation configuration after a thread's config changes. It keeps tool availability and provider selection current without restarting the thread.

**Data flow**: It ignores the session store and previous config, converts `new_config` into `ImageGenerationExtensionConfig`, and inserts the new snapshot into `thread_store`.

**Call relations**: The framework calls it on config updates because the extension implements `ConfigContributor<Config>`. It uses the same conversion logic as thread start.

*Call graph*: calls 2 internal fn (insert, from).


##### `ImageGenerationExtension::tools`  (lines 74–94)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Returns the standalone image-generation tool only when thread config and current auth both permit it. It is the policy gate between stored configuration and actual tool exposure.

**Data flow**: It reads `ImageGenerationExtensionConfig` from `thread_store`; if absent, unavailable, or the auth manager is not using the Codex backend, it returns an empty vector. Otherwise it creates a model provider from the stored provider plus cloned auth manager, wraps it in `CodexImagesBackend`, constructs `ImageGenerationTool` with backend, cloned `codex_home`, and `thread_store.level_id().to_string()`, and returns a one-element vector containing the tool in an `Arc`.

**Call relations**: The extension registry calls this whenever it enumerates tools for a thread. It depends on prior `on_thread_start`/`on_config_changed` calls having populated thread-scoped config.

*Call graph*: 2 external calls (new, vec!).


##### `install`  (lines 98–103)

```
fn install(registry: &mut ExtensionRegistryBuilder<Config>, auth_manager: Arc<AuthManager>)
```

**Purpose**: Registers the image-generation extension for thread lifecycle, config updates, and tool contribution. It is the public entry point used by host setup code.

**Data flow**: It takes a mutable `ExtensionRegistryBuilder<Config>` and shared `AuthManager`, constructs one `Arc<ImageGenerationExtension>`, clones it for thread lifecycle and config contributor registration, and registers the original for tool contribution.

**Call relations**: Hosts call this during extension installation. It wires one shared extension instance into all three contributor roles so they operate over the same auth manager.

*Call graph*: calls 3 internal fn (config_contributor, thread_lifecycle_contributor, tool_contributor); 1 external calls (new).


### `ext/image-generation/src/tool.rs`

`domain_logic` · `tool invocation / request handling`

This file contains the full runtime logic for the image-generation extension. `ImageGenerationTool` stores the backend executor plus `codex_home` and `thread_id`, which are later used to compute a persisted artifact path and a human-readable save hint. Through `ToolExecutor<ToolCall>`, it exposes a namespaced tool (`IMAGE_GEN_NAMESPACE` / `IMAGEGEN_TOOL_NAME`) with a JSON-schema-derived input contract based on `ImagegenArgs`. The arguments are strict at deserialization time (`deny_unknown_fields`) and allow either explicit `referenced_image_paths` or a bounded `num_last_images_to_include`, never both.

`handle_call()` is the orchestration center. It parses arguments, derives an `ImageRequest` via `request_for_call_args()`, emits an in-progress `ImageGenerationItem`, dispatches to `backend.generate()` or `backend.edit()`, extracts the first `b64_json` image from the API response, and emits either a failed or completed turn item. On success it computes the artifact path with `image_generation_artifact_path()` and optionally an `extension_image_generation_output_hint()`.

The request-building logic is concrete and defensive. Generation requests always use `gpt-image-2` with auto background/quality/size. Edit requests either load and normalize local files through the session `ToolEnvironment` and `load_for_prompt_bytes()`, or mine recent images from conversation history. `recent_images()` first records valid function/custom-tool call IDs, then scans history backward so orphan outputs are ignored and newest images are selected first; it reverses the final list so the edit API receives chronological order. `GeneratedImageOutput` deliberately suppresses raw bytes in logs, returns a compact JSON object for code mode, and emits protocol content items with `DEFAULT_IMAGE_DETAIL` for normal model follow-up.

#### Function details

##### `ImageGenerationTool::new`  (lines 60–70)

```
fn new(
        backend: CodexImagesBackend,
        codex_home: AbsolutePathBuf,
        thread_id: String,
    ) -> Self
```

**Purpose**: Constructs an image-generation tool instance bound to a specific backend, Codex home directory, and thread identifier.

**Data flow**: It takes a `CodexImagesBackend`, an `AbsolutePathBuf` for `codex_home`, and a `String` thread ID, then stores them unchanged in a new `ImageGenerationTool`. It returns the initialized struct with no side effects.

**Call relations**: This is the constructor used when the extension is wired into the runtime; later methods read these stored fields during execution, especially `handle_call()` when computing artifact paths.


##### `ImageGenerationTool::tool_name`  (lines 85–87)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the fully qualified tool name used by the extension framework.

**Data flow**: It reads the compile-time constants `IMAGE_GEN_NAMESPACE` and `IMAGEGEN_TOOL_NAME`, passes them to `ToolName::namespaced`, and returns the resulting `ToolName`.

**Call relations**: The extension framework calls this when registering or identifying the tool; it aligns the executor identity with the schema returned by `spec()`.

*Call graph*: calls 1 internal fn (namespaced).


##### `ImageGenerationTool::spec`  (lines 90–92)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the model-facing tool specification for image generation and editing.

**Data flow**: It invokes `imagegen_tool_spec()` and returns the resulting `ToolSpec` unchanged.

**Call relations**: The framework calls this during tool advertisement. It delegates all schema construction details to `imagegen_tool_spec()`.

*Call graph*: calls 1 internal fn (imagegen_tool_spec).


##### `ImageGenerationTool::exposure`  (lines 95–97)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Declares that the tool is directly exposed on the tool surface.

**Data flow**: It returns the constant enum value `ToolExposure::Direct` and reads no mutable state.

**Call relations**: This is consulted by the extension framework when deciding how the tool appears to callers; it does not delegate further.


##### `ImageGenerationTool::handle`  (lines 100–102)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async image-generation implementation to the boxed future type required by `ToolExecutor`.

**Data flow**: It takes ownership of a `ToolCall`, invokes `self.handle_call(call)`, boxes and pins the future, and returns that executor future.

**Call relations**: The extension runtime invokes this entrypoint for each tool call. It is a thin wrapper whose only job is to forward into `handle_call()`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ImageGenerationTool::handle_call`  (lines 106–168)

```
async fn handle_call(&self, call: ToolCall) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Executes one image-generation or image-edit request end to end, including validation, backend dispatch, progress events, error mapping, and final output construction.

**Data flow**: It reads the incoming `ToolCall`, parses JSON arguments with `parse_args()`, derives an `ImageRequest` using `request_for_call_args()` against conversation history and environments, and emits an `ExtensionTurnItem::ImageGeneration` with `in_progress` status. It then matches on `ImageRequest`: `Generate` calls `self.backend.generate(request).await`, while `Edit` calls `self.backend.edit(request).await`. The API response is transformed by taking the first element of `response.data` and extracting `b64_json`; backend failures or empty data become `FunctionCallError::RespondToModel` after emitting a failed completion item. On success it emits a completed `ImageGenerationItem` containing the revised prompt and base64 result, computes an artifact path from `codex_home`, `thread_id`, and `call.call_id`, derives an optional output hint, and returns `Box<GeneratedImageOutput>`.

**Call relations**: This is called only by `handle()`. It orchestrates the whole flow by delegating argument parsing to `parse_args()`, request selection to `request_for_call_args()`, backend work to `generate`/`edit`, and output formatting to `GeneratedImageOutput`.

*Call graph*: calls 4 internal fn (edit, generate, parse_args, request_for_call_args); called by 1 (handle); 6 external calls (new, new, extension_image_generation_output_hint, image_generation_artifact_path, RespondToModel, ImageGeneration).


##### `request_for_call_args`  (lines 177–246)

```
async fn request_for_call_args(
    args: &ImagegenArgs,
    history: &[ResponseItem],
    environments: &[ToolEnvironment],
) -> Result<ImageRequest, FunctionCallError>
```

**Purpose**: Converts validated tool arguments plus runtime context into either a generation request or an edit request, enforcing all selector rules and limits.

**Data flow**: It reads `ImagegenArgs`, conversation `history`, and available `ToolEnvironment`s. First it normalizes `referenced_image_paths` to a slice and rejects more than `MAX_EDIT_IMAGES`. It then matches on whether explicit paths are present and whether `num_last_images_to_include` is set. With neither selector, it returns `ImageRequest::Generate` using the prompt and fixed defaults. With explicit paths only, it requires at least one environment, reads each path through `image_url()`, and collects `Vec<ImageUrl>`. With history count only, it validates the count range, gathers images via `recent_images()`, and errors if fewer than requested are available. With both selectors, it returns a model-facing conflict error. Successful edit branches are wrapped into `ImageRequest::Edit` with the same fixed defaults.

**Call relations**: This helper is called by `handle_call()` after parsing arguments. It delegates file-backed image loading to `image_url()` and history mining to `recent_images()` depending on which selector mode the caller chose.

*Call graph*: calls 2 internal fn (image_url, recent_images); called by 1 (handle_call); 6 external calls (with_capacity, Edit, Generate, format!, RespondToModel, first).


##### `recent_images`  (lines 248–324)

```
fn recent_images(history: &[ResponseItem], count: usize) -> Vec<ImageUrl>
```

**Purpose**: Finds the most recent usable images in conversation history, while excluding orphaned tool outputs and preserving chronological order in the returned edit list.

**Data flow**: It takes a slice of `ResponseItem` and a desired `count`. In a first pass, it builds `HashSet`s of valid function-call IDs and custom-tool-call IDs from `ResponseItem::FunctionCall` and `ResponseItem::CustomToolCall`. In a second reverse pass over history, it extracts image URLs from user `Message` content, from `FunctionCallOutput` only when the `call_id` was previously seen, from `CustomToolCallOutput` only when its `call_id` was seen, and from non-empty `ImageGenerationCall.result` by wrapping the base64 payload in a PNG data URL. It accumulates until `count` images are found, then reverses the collected vector and returns `Vec<ImageUrl>`.

**Call relations**: This function is used by `request_for_call_args()` for the history-based edit mode. It delegates extraction of image items inside tool outputs to `output_image_urls()`.

*Call graph*: calls 1 internal fn (output_image_urls); called by 1 (request_for_call_args); 5 external calls (new, new, with_capacity, format!, iter).


##### `output_image_urls`  (lines 327–338)

```
fn output_image_urls(output: &FunctionCallOutputPayload) -> impl Iterator<Item = String> + '_
```

**Purpose**: Iterates over image URLs embedded in a function-call output payload, yielding them newest-first within that payload.

**Data flow**: It reads a `FunctionCallOutputPayload`, obtains its optional content items via `content_items()`, flattens them, reverses item order, filters for `FunctionCallOutputContentItem::InputImage`, clones each `image_url`, and returns an iterator of `String`s.

**Call relations**: This helper is called by `recent_images()` when scanning `FunctionCallOutput` and `CustomToolCallOutput` items so those outputs can contribute images in reverse-recency order.

*Call graph*: calls 1 internal fn (content_items); called by 1 (recent_images).


##### `image_url`  (lines 340–367)

```
async fn image_url(
    path: &AbsolutePathBuf,
    environment: &ToolEnvironment,
) -> Result<ImageUrl, FunctionCallError>
```

**Purpose**: Loads a referenced local image through the session file-system abstraction, normalizes it for prompting, and converts it into the API’s `ImageUrl` data-URL form.

**Data flow**: It takes an absolute path and a `ToolEnvironment`. The path is converted to a `PathUri`, and the environment’s sandbox context is cloned. It asynchronously reads raw bytes from `environment.file_system.read_file(...)`; read failures are mapped to `FunctionCallError::RespondToModel` with the original path in the message. The bytes are then passed to `load_for_prompt_bytes(path.as_path(), bytes, PromptImageMode::Original)`; processing failures are similarly mapped. On success, the normalized image is converted with `into_data_url()` and wrapped in `ImageUrl`.

**Call relations**: This helper is called by `request_for_call_args()` only in the explicit-path edit branch, one time per referenced image path.

*Call graph*: calls 2 internal fn (as_path, from_abs_path); called by 1 (request_for_call_args); 1 external calls (load_for_prompt_bytes).


##### `parse_args`  (lines 370–373)

```
fn parse_args(call: &ToolCall) -> Result<ImagegenArgs, FunctionCallError>
```

**Purpose**: Deserializes the model-supplied function arguments into the strict `ImagegenArgs` structure.

**Data flow**: It reads the raw JSON string from `call.function_arguments()?`, passes it to `serde_json::from_str`, and returns either `ImagegenArgs` or `FunctionCallError::RespondToModel` containing the serde error text.

**Call relations**: This is the first validation step inside `handle_call()`. Its output feeds directly into `request_for_call_args()`.

*Call graph*: called by 1 (handle_call); 2 external calls (function_arguments, from_str).


##### `imagegen_tool_spec`  (lines 376–406)

```
fn imagegen_tool_spec() -> ToolSpec
```

**Purpose**: Builds the namespace tool specification and JSON schema exposed to the model for image generation.

**Data flow**: It generates a root schema for `ImagegenArgs` using `schemars` draft 2019-09 settings with inline subschemas, serializes that schema to `serde_json::Value`, and asserts that the root is an object. It then extracts only `properties`, `required`, `type`, and `additionalProperties` into a fresh `Map`, parses that reduced object with `parse_tool_input_schema()`, and embeds it in `ToolSpec::Namespace(ResponsesApiNamespace { ... })`. The namespace uses `IMAGE_GEN_NAMESPACE`, `default_namespace_description(...)`, and a single nested `ResponsesApiTool` named `IMAGEGEN_TOOL_NAME` with `IMAGEGEN_DESCRIPTION` and `strict: false`.

**Call relations**: This function is called by `ImageGenerationTool::spec()` and is also directly exercised by tests to verify namespace naming and schema shape.

*Call graph*: called by 1 (spec); 7 external calls (new, draft2019_09, default_namespace_description, to_value, Namespace, unreachable!, vec!).


##### `GeneratedImageOutput::log_preview`  (lines 415–417)

```
fn log_preview(&self) -> String
```

**Purpose**: Provides a safe log preview string that avoids embedding generated image bytes in telemetry.

**Data flow**: It ignores the stored image data and returns the fixed string `"[generated image]"`.

**Call relations**: The logging layer calls this through the `ToolOutput` trait when summarizing tool results.


##### `GeneratedImageOutput::success_for_logging`  (lines 420–422)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks generated-image outputs as successful for logging and telemetry purposes.

**Data flow**: It returns `true` unconditionally and does not inspect any fields.

**Call relations**: This is another `ToolOutput` hook consumed by the surrounding execution/logging framework.


##### `GeneratedImageOutput::code_mode_result`  (lines 425–437)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> Value
```

**Purpose**: Formats the generated image for code mode as a compact JSON object consumable by helper APIs such as `generatedImage()`.

**Data flow**: It reads `self.result` and `self.output_hint`. It creates a JSON object map containing `image_url` as a PNG data URL built from the base64 result. If `output_hint` is `Some`, it inserts an `output_hint` string field. It returns the assembled `serde_json::Value::Object`.

**Call relations**: This method is invoked by code-mode consumers through the `ToolOutput` trait; tests verify both the mandatory image URL and optional hint field.

*Call graph*: 4 external calls (from_iter, Object, String, format!).


##### `GeneratedImageOutput::to_response_item`  (lines 440–457)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the generated image into the protocol response item sent back as function-call output for model follow-up.

**Data flow**: It takes a `call_id` and ignores the payload. It builds a `Vec<FunctionCallOutputContentItem>` starting with `InputImage` whose `image_url` is a PNG data URL from `self.result` and whose `detail` is `Some(DEFAULT_IMAGE_DETAIL)`. If `self.output_hint` exists, it appends an `InputText` item containing that hint. It wraps the content in `FunctionCallOutputPayload { body: ContentItems(content), success: Some(true) }` and returns `ResponseInputItem::FunctionCallOutput` with the provided call ID.

**Call relations**: This is the normal model-facing output path used after `handle_call()` returns a boxed `GeneratedImageOutput`. Tests cover both the hint-present and hint-omitted cases.

*Call graph*: 2 external calls (ContentItems, vec!).


### `ext/goal/src/lib.rs`

`orchestration` · `cross-cutting`

This file defines the module layout for the goal extension and exposes the subset of types intended for external use. Internally, the crate is split into focused modules for accounting, analytics, API definitions, event handling, extension wiring, metrics, runtime state, tool specification, steering logic, and tool implementation. The root then re-exports the operational API types (`GoalService`, `GoalServiceError`, `GoalSetRequest`, `GoalSetOutcome`, `GoalObjectiveUpdate`, `GoalTokenBudgetUpdate`), the extension entry types (`GoalExtension`, `GoalExtensionConfig`, `install_with_backend`), runtime-facing handles and snapshots (`GoalRuntimeHandle`, `PreviousGoalSnapshot`), and the canonical tool names (`CREATE_GOAL_TOOL_NAME`, `GET_GOAL_TOOL_NAME`, `UPDATE_GOAL_TOOL_NAME`) plus `CreateGoalRequest`. As with many crate roots in this codebase, there is no executable logic here; its job is to present a coherent boundary around a larger subsystem. The important design implication is that callers can depend on this file’s exports without knowing whether a capability lives in API, runtime, or tool modules, while the crate retains freedom to reorganize internals behind that facade.


### `ext/goal/src/tool.rs`

`domain_logic` · `tool execution / goal state mutation`

This file contains the operational core for `get_goal`, `create_goal`, and `update_goal`. `GoalToolExecutor` is parameterized by a `GoalToolKind` and carries all dependencies needed to service a call: thread identity, state runtime, in-memory accounting state, analytics, event emitter, and metrics. The `ToolExecutor` implementation maps each executor instance to a tool name and spec, then dispatches asynchronously to the matching handler. `handle_get` validates that no arguments were supplied and reads the current persisted goal. `handle_create` parses JSON into `CreateGoalRequest`, trims and validates the objective, validates that any budget is positive, inserts a new active goal only if no unfinished goal exists, opportunistically fills an empty thread preview from the objective, marks the current turn as goal-active in accounting state, records metrics/analytics, emits a `thread_goal_updated` event, and returns a structured JSON payload. `handle_update` accepts only `complete` or `blocked`, first flushes any unaccounted progress for the active turn, then updates persisted status, records terminal metrics and analytics, clears the current-turn goal marker, emits an event, and optionally includes a completion-budget reporting hint. Helpers convert between state and protocol goal/status types, serialize `GoalToolResponse`, and compute `remaining_tokens` with zero clamping. A notable design choice is that progress accounting is guarded by a permit and expected-goal-id checks to avoid double-accounting or stale-turn mutations.

#### Function details

##### `GoalToolExecutor::get`  (lines 76–93)

```
fn get(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: Goal
```

**Purpose**: Constructs a `GoalToolExecutor` configured for the read-only `get_goal` operation. It packages all shared dependencies with `GoalToolKind::Get`.

**Data flow**: It takes a `ThreadId`, shared `StateRuntime`, shared `GoalAccountingState`, `GoalAnalytics`, `GoalEventEmitter`, and `GoalMetrics`, stores them in a new struct with `kind` set to `Get`, and returns that executor.

**Call relations**: It is used by extension wiring when registering the get tool. The returned executor later participates in `tool_name`, `spec`, and `handle` dispatch.


##### `GoalToolExecutor::create`  (lines 95–112)

```
fn create(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: G
```

**Purpose**: Constructs a `GoalToolExecutor` configured for `create_goal`. It is the create-operation counterpart to `get` and `update`.

**Data flow**: It receives the same dependency set as the other constructors, stores them with `kind` set to `Create`, and returns the initialized executor.

**Call relations**: It is called during tool installation for the create tool. Its only behavior is to prepare later dispatch through the shared `ToolExecutor` implementation.


##### `GoalToolExecutor::update`  (lines 114–131)

```
fn update(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: G
```

**Purpose**: Constructs a `GoalToolExecutor` configured for `update_goal`. It binds the update operation to the current thread and shared services.

**Data flow**: It takes thread/state/accounting/analytics/event/metrics dependencies, stores them with `kind` set to `Update`, and returns the executor.

**Call relations**: It is created during extension setup for the update tool and later routes calls through `handle_update`.


##### `GoalToolExecutor::tool_name`  (lines 135–141)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the externally visible tool name corresponding to this executor's kind. It is the name advertised to the extension framework and model.

**Data flow**: It reads `self.kind`, selects one of the three exported tool-name constants, wraps it with `ToolName::plain`, and returns the resulting `ToolName`.

**Call relations**: The extension framework calls this when enumerating tools and when tests search by name. It is paired with `spec` and `handle` to present a coherent tool implementation.

*Call graph*: calls 1 internal fn (plain).


##### `GoalToolExecutor::spec`  (lines 143–149)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the schema/instruction spec matching this executor's kind. It keeps runtime dispatch aligned with the tool definitions in `spec.rs`.

**Data flow**: It reads `self.kind`, calls the corresponding `create_*_tool` factory, and returns the resulting `ToolSpec`.

**Call relations**: The framework invokes it when exposing tool metadata. It delegates all schema construction to the dedicated spec module so execution and specification stay separate.

*Call graph*: calls 3 internal fn (create_create_goal_tool, create_get_goal_tool, create_update_goal_tool).


##### `GoalToolExecutor::handle`  (lines 151–159)

```
fn handle(&self, invocation: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Asynchronously dispatches an incoming `ToolCall` to the concrete goal operation. It is the single entry point required by the `ToolExecutor` trait.

**Data flow**: It takes ownership of a `ToolCall`, boxes an async block, matches on `self.kind`, awaits `handle_get`, `handle_create`, or `handle_update`, and returns the framework future yielding either a boxed `ToolOutput` or `FunctionCallError`.

**Call relations**: The extension runtime invokes this for every goal tool call. It delegates all substantive work to the per-operation handlers based on the executor kind.

*Call graph*: calls 3 internal fn (handle_create, handle_get, handle_update); 1 external calls (pin).


##### `GoalToolExecutor::handle_get`  (lines 163–178)

```
async fn handle_get(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Executes `get_goal` by validating the empty argument object and reading the current persisted goal for the thread. It returns the goal in the standard structured response shape without completion-report text.

**Data flow**: It reads the invocation arguments via `function_arguments()` only to validate parseability, fetches the thread goal from `state_db.thread_goals()`, maps any stored goal through `protocol_goal_from_state`, converts storage errors into `RespondToModel`, and passes the optional protocol goal to `goal_response` with `CompletionBudgetReport::Omit`.

**Call relations**: It is reached only from `handle` when `kind` is `Get`. It delegates response serialization to `goal_response` and state/protocol conversion to `protocol_goal_from_state`.

*Call graph*: calls 1 internal fn (goal_response); called by 1 (handle); 1 external calls (function_arguments).


##### `GoalToolExecutor::handle_create`  (lines 180–219)

```
async fn handle_create(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Executes `create_goal`, enforcing objective and budget validation, creating a new active goal in persistent state, and initializing per-turn accounting and observability side effects. It also fills an empty thread preview from the objective when possible.

**Data flow**: It parses JSON arguments into `CreateGoalRequest`, trims `objective`, validates the objective text and optional positive `token_budget`, inserts a new active goal into `state_db`, converts insertion/storage failures into model-facing errors, rejects creation when an unfinished goal already exists, attempts `fill_empty_thread_preview_if_possible`, marks the current turn's active goal in `accounting_state`, records metrics and analytics, converts the stored goal to protocol form, emits a goal-updated event, and returns a boxed JSON tool output via `goal_response`.

**Call relations**: It is called from `handle` for `GoalToolKind::Create`. It delegates parsing to `parse_arguments`, validation to `validate_thread_goal_objective` and `validate_goal_budget`, persistence to `state_db.thread_goals().insert_thread_goal`, event emission to `emit_goal_updated_from_tool_call`, and response shaping to `goal_response`.

*Call graph*: calls 9 internal fn (created, record_created, emit_goal_updated_from_tool_call, fill_empty_thread_preview_if_possible, goal_response, parse_arguments, protocol_goal_from_state, validate_goal_budget, validate_thread_goal_objective); called by 1 (handle); 2 external calls (function_arguments, Turn).


##### `GoalToolExecutor::handle_update`  (lines 221–291)

```
async fn handle_update(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Executes `update_goal` for terminal transitions to `complete` or `blocked`, first flushing any unaccounted progress from the active turn and then updating persisted status. It rejects all non-terminal statuses because pause/resume and limit transitions are controlled elsewhere.

**Data flow**: It parses `UpdateGoalArgs`, checks that `status` is only `Complete` or `Blocked`, calls `account_active_goal_progress` with a mode chosen to preserve the intended terminal semantics, reads the previous goal status for metrics, updates the persisted goal status through `state_db.thread_goals().update_thread_goal`, maps storage failures or missing-goal cases to `RespondToModel`, records terminal metrics and analytics, converts the updated goal to protocol form, clears the current-turn goal marker in `accounting_state`, emits a goal-updated event, and returns `goal_response`, including a completion budget report only for `Complete`.

**Call relations**: It is reached from `handle` when `kind` is `Update`. It depends on `account_active_goal_progress` to avoid losing final usage, on `current_goal_status_for_metrics` and metrics/analytics methods for observability, on `state_status_from_protocol` for persistence, and on `emit_goal_updated_from_tool_call`/`goal_response` for outward effects.

*Call graph*: calls 9 internal fn (status_changed, record_terminal_if_status_changed, account_active_goal_progress, current_goal_status_for_metrics, emit_goal_updated_from_tool_call, goal_response, parse_arguments, protocol_goal_from_state, state_status_from_protocol); called by 1 (handle); 5 external calls (function_arguments, Turn, matches!, RespondToModel, unreachable!).


##### `GoalToolExecutor::emit_goal_updated_from_tool_call`  (lines 293–301)

```
fn emit_goal_updated_from_tool_call(
        &self,
        invocation: &ToolCall,
        turn_id: Option<String>,
        goal: ThreadGoal,
    )
```

**Purpose**: Emits a `thread_goal_updated` event tied to a specific tool call. It centralizes the event payload shape used by create and update handlers.

**Data flow**: It takes the original `ToolCall`, an optional `turn_id`, and a protocol `ThreadGoal`, then forwards `invocation.call_id.clone()`, the turn id, and the goal to `event_emitter.thread_goal_updated`.

**Call relations**: It is called after successful create and update operations. Those callers use it so tool-originated goal mutations produce consistent event IDs and payloads.

*Call graph*: calls 1 internal fn (thread_goal_updated); called by 2 (handle_create, handle_update).


##### `GoalToolExecutor::account_active_goal_progress`  (lines 303–368)

```
async fn account_active_goal_progress(
        &self,
        mode: codex_state::GoalAccountingMode,
        event_id: &str,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
```

**Purpose**: Flushes accumulated token/time progress for the current turn into persistent goal state, with concurrency protection and stale-goal checks. It is the mechanism that prevents final progress from being lost before a status change or other stop condition.

**Data flow**: It takes an accounting mode, event id, and budget-limited disposition; reads the current turn id from `accounting_state`; acquires a progress-accounting permit; reads a progress snapshot for that turn; fetches the previous persisted goal status filtered by the snapshot's expected goal id; calls `state_db.thread_goals().account_thread_goal_usage` with time/token deltas and expected goal id; on `Updated(goal)` records terminal metrics if status changed, emits analytics for usage and status change, marks the snapshot accounted in `accounting_state`, converts the goal to protocol form, emits a `thread_goal_updated` event using the supplied event id and turn id, and returns `Some(goal)`; on `Unchanged(_)` it returns `None`.

**Call relations**: It is invoked by `handle_update` before terminal status changes. Internally it coordinates `current_goal_status_for_metrics`, persistence-layer accounting, analytics, metrics, accounting-state bookkeeping, and event emission so callers can safely mutate status afterward.

*Call graph*: calls 6 internal fn (status_changed, usage_accounted, thread_goal_updated, record_terminal_if_status_changed, current_goal_status_for_metrics, protocol_goal_from_state); called by 1 (handle_update); 1 external calls (Turn).


##### `GoalToolExecutor::current_goal_status_for_metrics`  (lines 370–389)

```
async fn current_goal_status_for_metrics(
        &self,
        expected_goal_id: Option<&str>,
    ) -> Result<Option<codex_state::ThreadGoalStatus>, FunctionCallError>
```

**Purpose**: Reads the current persisted goal status, optionally only if it matches an expected goal id. It exists to avoid recording metrics against a stale or replaced goal.

**Data flow**: It takes an optional expected goal id, fetches the current thread goal from storage, maps storage errors to `RespondToModel`, and returns `Some(status)` only when a goal exists and either no expected id was supplied or the stored goal id matches it.

**Call relations**: It is used by `handle_update` and `account_active_goal_progress` before recording status-change metrics. Those callers rely on the expected-id filter to suppress misleading metrics when the active goal has changed.

*Call graph*: called by 2 (account_active_goal_progress, handle_update).


##### `parse_arguments`  (lines 392–398)

```
fn parse_arguments(arguments: &str) -> Result<T, FunctionCallError>
```

**Purpose**: Deserializes raw JSON tool arguments into a typed request struct and converts parse failures into model-facing function-call errors. It is the common argument parser for create and update.

**Data flow**: It takes an argument string, calls `serde_json::from_str` for generic `T: Deserialize`, returns the parsed value on success, and wraps any JSON error as `FunctionCallError::RespondToModel`.

**Call relations**: It is called by `handle_create` and `handle_update` immediately after extracting invocation arguments. Those handlers then perform semantic validation on the typed result.

*Call graph*: called by 2 (handle_create, handle_update); 1 external calls (from_str).


##### `validate_goal_budget`  (lines 400–407)

```
fn validate_goal_budget(value: Option<i64>) -> Result<(), String>
```

**Purpose**: Enforces that an optional goal token budget, when present, is strictly positive. It is a small semantic validator shared with non-tool goal-setting paths.

**Data flow**: It takes `Option<i64>`, checks whether a present value is `<= 0`, returns an error string in that case, and otherwise returns `Ok(())` without mutating state.

**Call relations**: It is used by `handle_create` and also by the service-side goal-setting path outside this file. Callers run it after parsing but before persistence.

*Call graph*: called by 2 (set_thread_goal, handle_create).


##### `goal_response`  (lines 409–416)

```
fn goal_response(
    goal: Option<ThreadGoal>,
    completion_budget_report: CompletionBudgetReport,
) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Builds the boxed JSON tool output returned by all goal tool handlers. It standardizes serialization of the optional goal, remaining tokens, and completion-report hint.

**Data flow**: It takes an optional protocol `ThreadGoal` and a `CompletionBudgetReport` mode, constructs a `GoalToolResponse` via `GoalToolResponse::new`, serializes it with `serde_json::to_value`, converts serialization failures into fatal errors, wraps the JSON value in `JsonToolOutput`, boxes it as `dyn ToolOutput`, and returns it.

**Call relations**: It is the final step in `handle_get`, `handle_create`, and `handle_update`. It delegates response-field computation to `GoalToolResponse::new` and output boxing to the extension API's JSON output type.

*Call graph*: calls 2 internal fn (new, new); called by 3 (handle_create, handle_get, handle_update); 2 external calls (new, to_value).


##### `GoalToolResponse::new`  (lines 419–436)

```
fn new(goal: Option<ThreadGoal>, report_mode: CompletionBudgetReport) -> Self
```

**Purpose**: Computes the structured response fields derived from an optional goal and the caller's reporting mode. It adds convenience fields not stored directly in the goal record.

**Data flow**: It takes `Option<ThreadGoal>` and a `CompletionBudgetReport`, computes `remaining_tokens` from `goal.token_budget - goal.tokens_used` clamped at zero when a budget exists, computes `completion_budget_report` only when report mode is `Include` and the goal status is `Complete`, and returns a populated `GoalToolResponse` containing the original goal.

**Call relations**: It is called only by `goal_response`. That caller relies on it to encapsulate all response-shaping logic in one place.

*Call graph*: called by 1 (goal_response).


##### `fill_empty_thread_preview_if_possible`  (lines 439–452)

```
async fn fill_empty_thread_preview_if_possible(
    state_db: &codex_state::StateRuntime,
    thread_id: ThreadId,
    goal: &codex_state::ThreadGoal,
)
```

**Purpose**: Attempts to populate an empty thread preview with the newly created goal objective, without failing the tool call if preview persistence fails. It is a best-effort UX enhancement.

**Data flow**: It takes a `StateRuntime`, `ThreadId`, and stored `codex_state::ThreadGoal`, calls `set_thread_preview_if_empty(thread_id, goal.objective.as_str())`, and on error logs a warning instead of returning an error.

**Call relations**: It is called after successful goal creation here and also from service-side goal setting. Its callers use it opportunistically so preview metadata follows the first goal objective when no preview already exists.

*Call graph*: called by 2 (set_thread_goal, handle_create); 2 external calls (set_thread_preview_if_empty, warn!).


##### `protocol_goal_from_state`  (lines 454–465)

```
fn protocol_goal_from_state(goal: codex_state::ThreadGoal) -> ThreadGoal
```

**Purpose**: Converts a persisted `codex_state::ThreadGoal` into the protocol-layer `ThreadGoal` returned to tools and events. It is the canonical state-to-protocol mapping for goals.

**Data flow**: It takes ownership of a stored goal, copies thread/objective/budget/usage fields, converts status through `protocol_status_from_state`, converts `created_at` and `updated_at` timestamps to Unix seconds, and returns the protocol struct.

**Call relations**: It is used broadly by tool handlers and runtime/service paths whenever a stored goal must be exposed externally. Those callers rely on it for consistent status and timestamp translation.

*Call graph*: calls 1 internal fn (protocol_status_from_state); called by 9 (set_thread_goal, account_active_goal_progress, account_idle_goal_progress, apply_external_goal_set, continue_if_idle, stop_active_goal_for_turn, account_active_goal_progress, handle_create, handle_update).


##### `protocol_status_from_state`  (lines 467–476)

```
fn protocol_status_from_state(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus
```

**Purpose**: Maps each persisted goal status enum variant to its protocol equivalent. It is a direct one-to-one translation helper.

**Data flow**: It takes a `codex_state::ThreadGoalStatus`, matches every variant, and returns the corresponding `codex_protocol::protocol::ThreadGoalStatus`.

**Call relations**: It is called only by `protocol_goal_from_state`. That wrapper uses it to keep status conversion isolated from field-copying logic.

*Call graph*: called by 1 (protocol_goal_from_state).


##### `state_status_from_protocol`  (lines 478–489)

```
fn state_status_from_protocol(
    status: ThreadGoalStatus,
) -> codex_state::ThreadGoalStatus
```

**Purpose**: Maps protocol goal statuses back into the persistence-layer enum. It is the inverse translation used when tool input drives a state update.

**Data flow**: It takes a protocol `ThreadGoalStatus`, matches every variant, and returns the corresponding `codex_state::ThreadGoalStatus`.

**Call relations**: It is used by `handle_update` before calling the persistence layer. That caller validates allowed statuses first, then uses this helper for the actual update payload.

*Call graph*: called by 1 (handle_update).


##### `completion_budget_report`  (lines 491–500)

```
fn completion_budget_report(goal: &ThreadGoal) -> Option<String>
```

**Purpose**: Generates the optional natural-language instruction telling the model to report final token/time usage after a completed goal. It is omitted when there is nothing meaningful to report.

**Data flow**: It reads a completed protocol `ThreadGoal`, returns `None` when both `token_budget` is absent and `time_used_seconds <= 0`, otherwise returns a fixed explanatory string describing which structured fields to summarize.

**Call relations**: It is used indirectly by `GoalToolResponse::new` when completion reporting is enabled. That caller filters to completed goals before invoking it.


### Memories namespace and workspace support
This group covers the memories extension from crate entry through local backend operations, tool wrappers, and the related workspace preparation used by memory writing flows.

### `ext/memories/src/lib.rs`

`config` · `cross-cutting`

This root file organizes the memories extension into backend, extension wiring, local storage/access, metrics, prompt generation, schema definitions, and tool implementations. Its only public export is `extension::install`, keeping the integration surface narrow while internal modules remain crate-private. The rest of the file defines the constants that shape memory-tool behavior across the crate. It sets default and maximum result counts for listing (`DEFAULT_LIST_MAX_RESULTS` and `MAX_LIST_RESULTS`, both 2,000) and searching (`DEFAULT_SEARCH_MAX_RESULTS` and `MAX_SEARCH_RESULTS`, both 200), a default token ceiling for reads (`DEFAULT_READ_MAX_TOKENS` at 20,000), and a separate summary token limit used for developer instructions (`MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT` at 2,500). It also establishes the namespace and tool names: `MEMORY_TOOLS_NAMESPACE` is `"memories"`, with individual tools `add_ad_hoc_note`, `list`, `read`, and `search`. These constants are the key behavioral contract from this file: they encode hard caps and canonical identifiers that downstream modules should honor consistently. A test module is conditionally included under `#[cfg(test)]`, indicating this root also anchors crate-local tests without exposing them publicly.


### `ext/memories/src/local/ad_hoc_note.rs`

`domain_logic` · `request handling`

This module implements note creation under `extensions/ad_hoc/notes` beneath the backend root. The top-level `add_ad_hoc_note` function first validates the requested filename and rejects notes whose trimmed content is empty. It then ensures the nested notes directory exists, opens the target file with `create_new(true)` so existing notes are never overwritten, maps `AlreadyExists` into the dedicated `AdHocNoteAlreadyExists` error, and writes the note bytes directly.

Directory creation is intentionally defensive. `ensure_notes_dir` walks from the backend root through each fixed path component, calling `ensure_directory` at every step. `ensure_directory` checks existing metadata with `symlink_metadata`, rejects symlinks, verifies that existing paths are directories, and if absent creates the directory asynchronously before re-reading metadata to confirm the final path now exists and is still a real directory. That post-create verification closes the gap between creation and later use.

Filename validation is strict and byte-oriented. Names must be at most 128 bytes, end in `.md`, and follow `YYYY-MM-DDTHH-MM-SS-<slug>.md`. The timestamp prefix is checked structurally rather than semantically: exact separator positions plus digit-only date/time fields. The slug must be 1–80 bytes and contain only lowercase ASCII letters, digits, or hyphens. Any violation is reported with a precise `InvalidFilename` reason.

#### Function details

##### `add_ad_hoc_note`  (lines 17–40)

```
async fn add_ad_hoc_note(
    backend: &LocalMemoriesBackend,
    request: AddAdHocMemoryNoteRequest,
) -> Result<AddAdHocMemoryNoteResponse, MemoriesBackendError>
```

**Purpose**: Validates an ad-hoc note request, ensures the destination directory tree exists, and writes a new markdown file exactly once. It is the concrete implementation behind the backend’s note-creation API.

**Data flow**: Consumes `backend` and `AddAdHocMemoryNoteRequest { filename, note }`. It calls `validate_filename(&request.filename)`, rejects whitespace-only notes with `EmptyAdHocNote`, awaits `ensure_notes_dir(backend)` to get the target directory, joins the filename onto that path, opens the file with `OpenOptions::new().write(true).create_new(true)`, maps `AlreadyExists` to `AdHocNoteAlreadyExists`, writes `request.note.as_bytes()` into the file, and returns an empty `AddAdHocMemoryNoteResponse`.

**Call relations**: Called by `LocalMemoriesBackend::add_ad_hoc_note` as the local backend’s write implementation. It delegates directory preparation to `ensure_notes_dir` and filename policy enforcement to `validate_filename` before performing the actual file creation.

*Call graph*: calls 2 internal fn (ensure_notes_dir, validate_filename); called by 1 (add_ad_hoc_note); 1 external calls (new).


##### `ensure_notes_dir`  (lines 42–52)

```
async fn ensure_notes_dir(
    backend: &LocalMemoriesBackend,
) -> Result<std::path::PathBuf, MemoriesBackendError>
```

**Purpose**: Creates or verifies the fixed `extensions/ad_hoc/notes` directory chain under the backend root. It guarantees the returned path is a real directory tree, not a file or symlink.

**Data flow**: Reads `backend.root`, first calls `ensure_directory(&backend.root)`, then clones the root into a mutable `PathBuf` and pushes each component from `AD_HOC_NOTES_DIR`, calling `ensure_directory(&path)` after each push. It returns the final notes directory path.

**Call relations**: Used only by `add_ad_hoc_note` before file creation. It delegates each step’s existence/type check to `ensure_directory` so every intermediate directory is validated.

*Call graph*: calls 1 internal fn (ensure_directory); called by 1 (add_ad_hoc_note).


##### `ensure_directory`  (lines 54–82)

```
async fn ensure_directory(path: &Path) -> Result<(), MemoriesBackendError>
```

**Purpose**: Ensures a given filesystem path exists as a directory and is not a symlink. It handles both pre-existing paths and paths that must be created.

**Data flow**: Accepts `&Path`, awaits `LocalMemoriesBackend::metadata_or_none(path)`, and branches: if metadata exists, it calls `reject_symlink`, returns success if `metadata.is_dir()`, otherwise returns `invalid_path(..., "must be a directory")`; if metadata is absent, it creates the directory with `tokio::fs::create_dir(path)`. After creation it re-reads metadata, errors with `NotFound` if still absent, rejects symlinks again, verifies `is_dir`, and returns `Ok(())`.

**Call relations**: Called repeatedly by `ensure_notes_dir` for the backend root and each fixed subdirectory component. It relies on shared metadata and symlink helpers so note creation obeys the same filesystem safety rules as read/list/search paths.

*Call graph*: calls 3 internal fn (invalid_path, metadata_or_none, reject_symlink); called by 1 (ensure_notes_dir); 2 external calls (display, create_dir).


##### `validate_filename`  (lines 84–126)

```
fn validate_filename(filename: &str) -> Result<(), MemoriesBackendError>
```

**Purpose**: Checks that an ad-hoc note filename matches the subsystem’s markdown timestamp-and-slug naming convention. It rejects malformed names with specific reasons.

**Data flow**: Reads `filename: &str` and performs sequential validation: maximum byte length, `.md` suffix, presence of a slug after the fixed timestamp prefix length, structural timestamp validation via `has_valid_timestamp_prefix`, slug length bounds, and slug character whitelist. On the first failure it returns `MemoriesBackendError::invalid_filename(filename, reason)`; otherwise it returns `Ok(())`.

**Call relations**: Called at the start of `add_ad_hoc_note` before any filesystem work occurs. It delegates timestamp-shape checking to `has_valid_timestamp_prefix` and uses the backend error helper to produce consistent validation failures.

*Call graph*: calls 2 internal fn (invalid_filename, has_valid_timestamp_prefix); called by 1 (add_ad_hoc_note).


##### `has_valid_timestamp_prefix`  (lines 128–143)

```
fn has_valid_timestamp_prefix(stem: &str) -> bool
```

**Purpose**: Verifies that a filename stem begins with the expected `YYYY-MM-DDTHH-MM-SS-` pattern. It checks separator placement and digit-only numeric fields, but not calendar validity.

**Data flow**: Takes `stem: &str`, converts it to bytes, checks minimum length, verifies literal separators at fixed indices, and calls `are_digits` on each numeric slice for year, month, day, hour, minute, and second. It returns `true` only if all structural checks pass.

**Call relations**: Used by `validate_filename` after stripping the `.md` suffix. It isolates the timestamp-prefix shape test so filename validation logic stays readable.

*Call graph*: calls 1 internal fn (are_digits); called by 1 (validate_filename).


##### `are_digits`  (lines 145–147)

```
fn are_digits(bytes: &[u8]) -> bool
```

**Purpose**: Tests whether every byte in a slice is an ASCII digit. It is the low-level helper used by timestamp validation.

**Data flow**: Reads a byte slice and returns the result of `bytes.iter().all(u8::is_ascii_digit)`. It has no side effects.

**Call relations**: Called only by `has_valid_timestamp_prefix` for each numeric segment of the timestamp prefix.

*Call graph*: called by 1 (has_valid_timestamp_prefix).


### `ext/memories/src/local/list.rs`

`domain_logic` · `request handling`

This module provides the local implementation of the backend’s `list` operation. It begins by clamping the caller’s `max_results` to the global `MAX_LIST_RESULTS`, resolving the optional requested path through `resolve_scoped_path`, and parsing the optional cursor as a zero-based start index. Invalid cursor strings become `InvalidCursor`, while a syntactically valid path that does not exist becomes `NotFound`.

Once the start path exists, the function rejects symlinks at the root of the listing target. If the target is a file, the response contains exactly one `MemoryEntry` describing that file relative to the backend root. If the target is a directory, it reads entries in sorted path order, skips hidden names and symlinks, and includes only regular files and directories. Other filesystem object types are silently ignored. Relative path strings are normalized through `display_relative_path`, so callers never see absolute host paths.

Pagination is applied after the full visible entry list is assembled. A cursor larger than the number of collected entries is rejected as out of range. Otherwise the function computes an end index with saturating arithmetic, drains the requested slice into the response, and sets `next_cursor` plus `truncated` when more entries remain. The returned `path` echoes the original request path rather than the resolved absolute path.

#### Function details

##### `list`  (lines 14–83)

```
async fn list(
    backend: &LocalMemoriesBackend,
    request: ListMemoriesRequest,
) -> Result<ListMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Lists a file or directory within the scoped memories root, filters out hidden and symlinked entries, and returns a paginated `ListMemoriesResponse`. It is the concrete local implementation of the backend’s listing API.

**Data flow**: Consumes `backend` and `ListMemoriesRequest { path, cursor, max_results }`. It clamps `max_results`, resolves `path` with `resolve_scoped_path`, parses `cursor` into `start_index` or returns `invalid_cursor`, fetches metadata with `metadata_or_none`, errors with `NotFound` if absent, and rejects symlinks using `display_relative_path` plus `reject_symlink`. If the target is a file, it builds a one-element `entries` vector; if it is a directory, it reads sorted child paths via `read_sorted_dir_paths`, skips hidden paths with `is_hidden_path`, skips missing entries and symlinks, maps directories/files to `MemoryEntryType`, and collects `MemoryEntry` values. It then validates `start_index`, computes `end_index`, `next_cursor`, and `truncated`, drains the selected range, and returns `ListMemoriesResponse { path: request.path, entries, next_cursor, truncated }`.

**Call relations**: Called by `LocalMemoriesBackend::list` after the trait method is invoked. It depends on shared path-resolution and metadata helpers from `local.rs` and `local/path.rs` to enforce confinement and visibility rules before assembling the paginated response.

*Call graph*: calls 7 internal fn (invalid_cursor, metadata_or_none, resolve_scoped_path, display_relative_path, is_hidden_path, read_sorted_dir_paths, reject_symlink); called by 1 (list); 2 external calls (new, vec!).


### `ext/memories/src/local/read.rs`

`domain_logic` · `request handling`

This module serves the backend `read` operation. It validates two caller-controlled bounds up front: `line_offset` must be a 1-indexed positive line number, and `max_lines`, when present, must also be positive. It then resolves the requested path under the backend root, verifies the path exists, rejects symlinks, and requires the target to be a regular file rather than a directory.

The file is loaded as UTF-8 text with `tokio::fs::read_to_string`. Content slicing is line-based but implemented in byte offsets derived from `char_indices`, which preserves UTF-8 correctness when locating newline boundaries. `line_start_byte_offset` finds the byte index of the requested starting line and returns `LineOffsetExceedsFileLength` if the file has too few lines. `line_end_byte_offset` computes the exclusive end byte after the requested number of lines, or the end of the file when `max_lines` is absent.

After extracting the requested line window, the function applies token truncation using `truncate_text` and `TruncationPolicy::Tokens`. A `max_tokens` value of zero is treated specially as “use `DEFAULT_READ_MAX_TOKENS`”. The response reports the original requested path and starting line number, returns the possibly truncated content slice, and marks `truncated` if either line-window clipping or token truncation shortened the original available content.

#### Function details

##### `read`  (lines 12–51)

```
async fn read(
    backend: &LocalMemoriesBackend,
    request: ReadMemoryRequest,
) -> Result<ReadMemoryResponse, MemoriesBackendError>
```

**Purpose**: Reads a scoped memory file starting at a 1-indexed line offset, optionally limits the number of lines, and token-truncates the returned text. It is the concrete local implementation of the backend read API.

**Data flow**: Consumes `backend` and `ReadMemoryRequest { path, line_offset, max_lines, max_tokens }`. It rejects `line_offset == 0` and `max_lines == Some(0)`, resolves the path with `resolve_scoped_path`, fetches metadata via `metadata_or_none`, errors with `NotFound` if absent, rejects symlinks with `reject_symlink`, and errors with `NotFile` if metadata is not a regular file. It reads the full file text with `read_to_string`, computes `start_byte` via `line_start_byte_offset`, computes `end_byte` via `line_end_byte_offset`, slices `content_from_offset`, substitutes `DEFAULT_READ_MAX_TOKENS` when `max_tokens == 0`, truncates with `truncate_text(..., TruncationPolicy::Tokens(max_tokens))`, computes whether truncation occurred, and returns `ReadMemoryResponse { path: request.path, start_line_number: request.line_offset, content, truncated }`.

**Call relations**: Called by `LocalMemoriesBackend::read` after the trait method is invoked. It delegates path safety to shared helpers and line-boundary calculations to `line_start_byte_offset` and `line_end_byte_offset` before applying external truncation utilities.

*Call graph*: calls 5 internal fn (metadata_or_none, resolve_scoped_path, reject_symlink, line_end_byte_offset, line_start_byte_offset); called by 1 (read); 3 external calls (truncate_text, Tokens, read_to_string).


##### `line_start_byte_offset`  (lines 53–72)

```
fn line_start_byte_offset(
    content: &str,
    line_offset: usize,
) -> Result<usize, MemoriesBackendError>
```

**Purpose**: Finds the byte offset where a requested 1-indexed line begins within a UTF-8 string. It converts line numbering into a safe slice boundary.

**Data flow**: Reads `content: &str` and `line_offset: usize`. If `line_offset == 1`, it returns `0`. Otherwise it iterates `content.char_indices()`, increments a line counter on each `'
'`, and returns the byte index immediately after the newline when the target line is reached. If the target line never appears, it returns `MemoriesBackendError::LineOffsetExceedsFileLength`.

**Call relations**: Used only by `read` after the file has been loaded. It isolates line-start calculation so the main read flow can slice content safely.

*Call graph*: called by 1 (read).


##### `line_end_byte_offset`  (lines 74–90)

```
fn line_end_byte_offset(content: &str, start_byte: usize, max_lines: Option<usize>) -> usize
```

**Purpose**: Computes the exclusive byte offset where the requested line window should end. It stops after a given number of lines or at end-of-file.

**Data flow**: Accepts `content`, `start_byte`, and `max_lines`. If `max_lines` is `None`, it returns `content.len()`. Otherwise it scans `content[start_byte..].char_indices()`, counts newline boundaries starting from one seen line, and returns the byte index just after the newline that ends the requested window; if fewer lines exist, it returns `content.len()`.

**Call relations**: Called by `read` after the starting byte has been determined. It complements `line_start_byte_offset` by defining the slice end for the response content.

*Call graph*: called by 1 (read).


### `ext/memories/src/local/search.rs`

`domain_logic` · `request handling`

This module performs content search across files under the scoped memories root. The top-level `search` function first trims every query string, rejects empty query sets or empty individual queries, rejects `AllWithinLines { line_count: 0 }`, clamps `max_results` to `MAX_SEARCH_RESULTS`, resolves and validates the starting path, and parses the optional cursor as a zero-based result index. It then constructs a `SearchMatcher`, recursively gathers all matches, sorts them by relative path and line number, and applies pagination.

Traversal is iterative rather than recursive: `search_entries` uses a `pending` directory stack, skips hidden paths and symlinks, and only descends into real directories or scans real files. `search_file` reads UTF-8 text, silently skips files with invalid text encoding, splits content into lines, precomputes per-line query-match flags, and then applies one of three matching strategies. `Any` emits a match for each line containing at least one query; `AllOnSameLine` requires every query on the same line; `AllWithinLines` searches forward windows up to `line_count` lines, records the first satisfying end line for each start, and then suppresses windows that strictly contain another satisfying window so results stay minimal.

`build_search_match` expands each hit with surrounding context lines and records both the actual match line and the first line included in the returned snippet. `SearchMatcher` and `SearchComparison` separate query preparation from matching: they optionally lowercase text and optionally normalize by removing non-alphanumeric characters, using `Cow` to avoid allocations when no transformation is needed.

#### Function details

##### `search`  (lines 17–89)

```
async fn search(
    backend: &LocalMemoriesBackend,
    request: SearchMemoriesRequest,
) -> Result<SearchMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Validates a search request, traverses the scoped memories tree, collects and sorts matches, and returns a paginated `SearchMemoriesResponse`. It is the local backend’s top-level search implementation.

**Data flow**: Consumes `backend` and `SearchMemoriesRequest`. It trims each query into a new `Vec<String>`, rejects empty queries or zero-width `AllWithinLines`, clamps `max_results`, resolves the optional path with `resolve_scoped_path`, parses `cursor` into `start_index` or returns `invalid_cursor`, fetches metadata with `metadata_or_none`, errors with `NotFound` if absent, rejects symlinks using `display_relative_path` plus `reject_symlink`, constructs a `SearchMatcher::new(queries.clone(), request.match_mode.clone(), request.case_sensitive, request.normalized)`, initializes an empty matches vector, awaits `search_entries(...)` to populate it, sorts matches by `path` then `match_line_number`, validates `start_index`, computes pagination fields, drains the selected range, and returns `SearchMemoriesResponse { queries, match_mode: request.match_mode, path: request.path, matches, next_cursor, truncated }`.

**Call relations**: Called by `LocalMemoriesBackend::search` when the backend trait’s search method is invoked. It delegates query preparation to `SearchMatcher::new`, filesystem traversal to `search_entries`, and relies on shared path helpers for confinement and symlink policy.

*Call graph*: calls 7 internal fn (invalid_cursor, metadata_or_none, resolve_scoped_path, display_relative_path, reject_symlink, new, search_entries); called by 1 (search); 2 external calls (new, matches!).


##### `search_entries`  (lines 91–128)

```
async fn search_entries(
    root: &Path,
    current: &Path,
    current_metadata: &std::fs::Metadata,
    matcher: &SearchMatcher,
    context_lines: usize,
    matches: &mut Vec<MemorySearchMatch>,
```

**Purpose**: Walks the starting file or directory tree and dispatches each visible regular file to the file-search routine. It performs the recursive traversal phase of search.

**Data flow**: Reads `root`, `current`, `current_metadata`, `matcher`, `context_lines`, and a mutable `matches` vector. If `current_metadata.is_file()`, it immediately awaits `search_file` on that file and returns. If it is not a directory, it returns without changes. Otherwise it initializes `pending` with `current.to_path_buf()`, repeatedly pops a directory, enumerates sorted child paths via `read_sorted_dir_paths`, skips hidden paths with `is_hidden_path`, fetches metadata with `metadata_or_none`, skips missing entries and symlinks, pushes directories back onto `pending`, and awaits `search_file` for regular files. It appends results into the provided `matches` vector.

**Call relations**: Called only by `search` after the starting path has been validated. It delegates actual content inspection to `search_file` while handling tree traversal and visibility filtering itself.

*Call graph*: calls 4 internal fn (metadata_or_none, is_hidden_path, read_sorted_dir_paths, search_file); called by 1 (search); 3 external calls (is_dir, is_file, vec!).


##### `search_file`  (lines 130–228)

```
async fn search_file(
    root: &Path,
    path: &Path,
    matcher: &SearchMatcher,
    context_lines: usize,
    matches: &mut Vec<MemorySearchMatch>,
) -> Result<(), MemoriesBackendError>
```

**Purpose**: Searches one text file line by line according to the configured match mode and appends any resulting `MemorySearchMatch` records. It contains the core matching algorithms.

**Data flow**: Accepts `root`, `path`, `matcher`, `context_lines`, and mutable `matches`. It reads the file with `tokio::fs::read_to_string`; invalid UTF-8 (`InvalidData`) causes an early `Ok(())`, while other I/O errors propagate. It splits content into `lines`, computes `line_matches` by calling `matcher.matched_query_flags` for each line, then branches on `matcher.match_mode`: for `Any`, it emits one match per line with any true flag; for `AllOnSameLine`, one match per line where all flags are true; for `AllWithinLines`, it scans forward windows from each promising start line, accumulates OR-ed query flags until all queries are matched or the line-count limit is reached, stores satisfying windows, then filters out windows that strictly contain another satisfying window. Each emitted result is built with `build_search_match(...)` and uses `matcher.matched_queries(...)` to record which original queries matched.

**Call relations**: Called by `search_entries` for each visible regular file. It depends on `SearchMatcher` methods for per-line matching and query-name recovery, and on `build_search_match` to package snippets and metadata into response objects.

*Call graph*: calls 2 internal fn (matched_queries, build_search_match); called by 1 (search_entries); 3 external calls (new, read_to_string, vec!).


##### `build_search_match`  (lines 230–251)

```
fn build_search_match(
    root: &Path,
    path: &Path,
    lines: &[&str],
    match_start_index: usize,
    match_end_index: usize,
    context_lines: usize,
    matched_queries: Vec<String>,
) ->
```

**Purpose**: Constructs a `MemorySearchMatch` from line indices, surrounding context, and matched query names. It converts internal zero-based indices into the response’s 1-indexed line numbers and snippet text.

**Data flow**: Reads `root`, `path`, `lines`, `match_start_index`, `match_end_index`, `context_lines`, and `matched_queries`. It computes `content_start_index` by saturating subtraction, computes `content_end_index` by adding context and clamping to `lines.len()`, joins the selected line slice with `"\n"`, formats the relative path with `display_relative_path`, and returns a populated `MemorySearchMatch`.

**Call relations**: Used by `search_file` whenever a line or window satisfies the chosen match mode. It isolates snippet assembly so the matching loops only decide which line ranges to emit.

*Call graph*: calls 1 internal fn (display_relative_path); called by 1 (search_file).


##### `SearchMatcher::new`  (lines 261–282)

```
fn new(
        queries: Vec<String>,
        match_mode: SearchMatchMode,
        case_sensitive: bool,
        normalized: bool,
    ) -> Result<Self, MemoriesBackendError>
```

**Purpose**: Builds a matcher that stores original queries, prepared comparison-ready queries, and the selected comparison/match settings. It validates that normalization does not collapse any query to empty.

**Data flow**: Consumes `queries`, `match_mode`, `case_sensitive`, and `normalized`. It creates a `SearchComparison` via `SearchComparison::new`, maps each query through `comparison.prepare(query)`, converts the resulting `Cow<str>` values into owned strings, rejects the request with `EmptyQuery` if any prepared query is empty, and returns `SearchMatcher { queries, prepared_queries, comparison, match_mode }`.

**Call relations**: Called by top-level `search` after basic request validation and before traversal begins. It delegates text-preparation policy creation to `SearchComparison::new` so later line matching can reuse the same normalization rules.

*Call graph*: calls 1 internal fn (new); called by 1 (search).


##### `SearchMatcher::matched_query_flags`  (lines 284–290)

```
fn matched_query_flags(&self, line: &str) -> Vec<bool>
```

**Purpose**: Determines, for one line of text, which prepared queries are present under the configured comparison rules. It produces the boolean match vector used by all search modes.

**Data flow**: Reads `self` and `line: &str`, prepares the line with `self.comparison.prepare(line)`, then iterates `self.prepared_queries`, checking `line.as_ref().contains(query)` for each one and collecting the booleans into a `Vec<bool>`. It returns that vector without mutating state.

**Call relations**: Called by `search_file` for every line in a file before mode-specific matching begins. It delegates normalization/case handling to `SearchComparison::prepare`.

*Call graph*: calls 1 internal fn (prepare).


##### `SearchMatcher::matched_queries`  (lines 292–298)

```
fn matched_queries(&self, matched_query_flags: &[bool]) -> Vec<String>
```

**Purpose**: Recovers the original query strings corresponding to a boolean match vector. It turns internal flags back into user-facing query names for the response.

**Data flow**: Reads `self.queries` and `matched_query_flags`, zips them together, clones each original query whose flag is `true`, collects those clones into a `Vec<String>`, and returns it.

**Call relations**: Used by `search_file` when constructing each `MemorySearchMatch`. It complements `matched_query_flags` by translating internal per-query booleans into response payload data.

*Call graph*: called by 1 (search_file).


##### `SearchComparison::new`  (lines 308–313)

```
fn new(case_sensitive: bool, normalized: bool) -> Self
```

**Purpose**: Creates the comparison policy controlling case sensitivity and normalization. It is a simple value constructor for search text preparation.

**Data flow**: Accepts `case_sensitive` and `normalized` booleans and returns `SearchComparison { case_sensitive, normalized }`. No external state is read or written.

**Call relations**: Called only by `SearchMatcher::new` while building a matcher. It provides the reusable policy object later consumed by `prepare`.

*Call graph*: called by 1 (new).


##### `SearchComparison::prepare`  (lines 315–335)

```
fn prepare(self, value: &'a str) -> Cow<'a, str>
```

**Purpose**: Transforms a string into its comparison form according to case-sensitivity and normalization settings, avoiding allocation when no transformation is needed. It is the canonical preprocessing step for both queries and candidate lines.

**Data flow**: Reads `self` and `value: &str`. If `case_sensitive` is true and `normalized` is false, it returns `Cow::Borrowed(value)` unchanged. Otherwise it lowercases into `Cow::Owned` when case-insensitive, or keeps a borrowed value when case-sensitive. If `normalized` is enabled, it filters the resulting characters to only `is_alphanumeric()` and returns an owned normalized string. The output is `Cow<'a, str>`.

**Call relations**: Called by `SearchMatcher::new` to preprocess queries and by `SearchMatcher::matched_query_flags` to preprocess each line. It centralizes the exact comparison semantics used throughout search.

*Call graph*: called by 1 (matched_query_flags); 2 external calls (Borrowed, Owned).


### `ext/memories/src/tools/mod.rs`

`orchestration` · `tool registration and shared request-processing support`

This module is the common infrastructure layer for all dedicated memory tools. It declares the four submodules (`ad_hoc_note`, `list`, `read`, `search`) and exposes `memory_tools`, which assembles one executor of each kind into a `Vec<Arc<dyn ToolExecutor<ToolCall>>>`. The function clones the backend and optional metrics client as needed so each tool instance owns what it needs while sharing the same underlying backend configuration.

The remaining helpers encode cross-tool policy. `memory_tool_name` applies the shared `MEMORY_TOOLS_NAMESPACE`. `memory_function_tool` constructs a `ToolSpec::Namespace` containing a single `ResponsesApiTool` function definition with generated input and output schemas; it parses the input schema through `parse_tool_input_schema` and treats schema-generation failures as programmer errors via panic. `parse_args` is the strict JSON entrypoint used by handlers: it extracts the raw function arguments string from `ToolCall`, treats an empty or whitespace-only string as `{}`, otherwise parses JSON text into `Value`, then deserializes into the requested type. Because tool arg structs use `deny_unknown_fields`, this preserves strict request validation. `clamp_max_results` centralizes bounded pagination semantics. Finally, `backend_error_to_function_call` classifies backend failures into model-facing `RespondToModel` errors for invalid input/domain conditions versus `Fatal` for I/O failures. That split is important: user-correctable mistakes become tool-call responses, while infrastructure problems abort execution more severely.

#### Function details

##### `memory_tools`  (lines 28–53)

```
fn memory_tools(
    backend: B,
    metrics_client: Option<MetricsClient>,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Constructs the full set of dedicated memory-tool executors backed by the same backend and optional metrics client.

**Data flow**: It takes a cloneable `MemoriesBackend` implementation and an optional `MetricsClient`, clones them as needed, instantiates `AddAdHocNoteTool`, `ListTool`, `ReadTool`, and `SearchTool`, wraps each in `Arc<dyn ToolExecutor<ToolCall>>`, and returns them in a vector.

**Call relations**: The extension’s tool-contribution path and the test helper `memory_tool` call this to obtain the available executors. It is the assembly point that wires shared backend/metrics dependencies into each concrete tool type.

*Call graph*: called by 2 (tools, memory_tool); 1 external calls (vec!).


##### `memory_tool_name`  (lines 55–57)

```
fn memory_tool_name(name: &str) -> ToolName
```

**Purpose**: Builds a namespaced `ToolName` for a short memory-tool identifier.

**Data flow**: It reads the global `MEMORY_TOOLS_NAMESPACE`, combines it with the provided short name via `ToolName::namespaced`, and returns the resulting `ToolName`.

**Call relations**: Concrete tool implementations use this in their `tool_name` methods, and tests use an analogous helper to compare expected names. It centralizes namespace policy for all tools.

*Call graph*: calls 1 internal fn (namespaced).


##### `memory_function_tool`  (lines 59–78)

```
fn memory_function_tool(
    name: &str,
    description: &str,
) -> ToolSpec
```

**Purpose**: Creates a namespaced Responses-API function tool specification from Rust input/output schema types and a human-readable description.

**Data flow**: It accepts a tool name and description, generates an input schema with `schema::input_schema_for::<I>()`, parses that schema into the API’s parameter representation with `parse_tool_input_schema`, generates an output schema with `schema::output_schema_for::<O>()`, and embeds the resulting `ResponsesApiTool` inside a `ToolSpec::Namespace` with the default namespace description and a single function entry.

**Call relations**: Each concrete tool’s `spec` method delegates here so all memory tools share the same namespace wrapper and schema-generation behavior. It sits between the schema utility module and the extension API’s tool-spec types.

*Call graph*: 4 external calls (parse_tool_input_schema, default_namespace_description, Namespace, vec!).


##### `parse_args`  (lines 80–89)

```
fn parse_args(call: &ToolCall) -> Result<T, FunctionCallError>
```

**Purpose**: Strictly decodes a tool call’s JSON argument payload into a typed Rust struct, treating empty argument strings as an empty object.

**Data flow**: It takes `&ToolCall`, extracts the raw argument string with `function_arguments()`, trims it to detect emptiness, substitutes `Value::Object({})` when empty, otherwise parses the JSON text with `serde_json::from_str`, and finally deserializes the resulting `Value` into `T` with `serde_json::from_value`. Parse or deserialize failures are converted into `FunctionCallError::RespondToModel` carrying the error text.

**Call relations**: Concrete tool handlers call this at the start of request processing to obtain typed args before invoking the backend. It isolates JSON parsing policy and ensures malformed model output becomes a recoverable model-facing error.

*Call graph*: 5 external calls (Object, function_arguments, new, from_str, from_value).


##### `clamp_max_results`  (lines 91–93)

```
fn clamp_max_results(requested: Option<usize>, default: usize, max: usize) -> usize
```

**Purpose**: Normalizes an optional requested page size into a bounded positive count using a default fallback and hard maximum.

**Data flow**: It takes `requested: Option<usize>`, a `default`, and a `max`; it substitutes the default when `requested` is `None`, then clamps the resulting value into the inclusive range `1..=max` and returns that `usize`.

**Call relations**: The list and other paginated tools use this helper before constructing backend requests so backends receive sane limits regardless of caller input.


##### `backend_error_to_function_call`  (lines 95–113)

```
fn backend_error_to_function_call(err: MemoriesBackendError) -> FunctionCallError
```

**Purpose**: Maps backend-specific error variants into the extension API’s error categories, distinguishing user-correctable request problems from fatal infrastructure failures.

**Data flow**: It consumes a `MemoriesBackendError`, pattern-matches on its variant, converts validation/path/query/not-found/window/domain errors into `FunctionCallError::RespondToModel(err.to_string())`, and converts `MemoriesBackendError::Io(_)` into `FunctionCallError::Fatal(err.to_string())`.

**Call relations**: Concrete tool handlers call this after awaiting backend operations and before returning to the tool runtime. It is the shared policy point that determines whether an error should be surfaced back to the model or treated as a hard execution failure.

*Call graph*: 3 external calls (to_string, Fatal, RespondToModel).


### `ext/memories/src/tools/ad_hoc_note.rs`

`domain_logic` · `tool request handling for ad-hoc note creation`

This file defines the ad-hoc note tool end to end: its argument schema, executor type, published tool metadata, and runtime call handling. `AddAdHocNoteArgs` is a private deserializable/JSON-schema struct with `deny_unknown_fields`, so callers must provide exactly `filename` and `note`. The filename field carries both length bounds and a regex requiring `YYYY-MM-DDTHH-MM-SS-<slug>.md`, where the slug is lowercase ASCII alphanumerics plus hyphens; this is the contract surfaced to models in the generated tool schema. The note itself must be non-empty.

`AddAdHocNoteTool<B>` stores a cloneable `MemoriesBackend` implementation and an optional `MetricsClient`. Through the `ToolExecutor<ToolCall>` impl, it exposes a namespaced tool name, a `ToolSpec` built with `memory_function_tool`, and a boxed future that delegates to the async `handle_call`. The actual handler clones the backend, parses arguments from the incoming `ToolCall` using the shared strict JSON parser, and submits an `AddAdHocMemoryNoteRequest` to the backend. Crucially, metrics are recorded before backend errors are mapped, so both success and failure outcomes are counted. The metric scope is fixed to `ad_hoc_notes`, and truncation is hard-coded to `not_applicable` because this operation returns only an empty-object response. Successful backend responses are serialized into `JsonToolOutput`; backend validation errors become model-facing `FunctionCallError`s via the shared converter.

#### Function details

##### `AddAdHocNoteTool::tool_name`  (lines 48–50)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the fully namespaced tool identifier for the ad-hoc note function.

**Data flow**: It reads no mutable state and transforms the constant `ADD_AD_HOC_NOTE_TOOL_NAME` into a `ToolName` via the shared namespacing helper.

**Call relations**: The tool registry and tests call this through the `ToolExecutor` trait when enumerating or selecting tools. It delegates naming policy to `memory_tool_name`.

*Call graph*: 1 external calls (memory_tool_name).


##### `AddAdHocNoteTool::spec`  (lines 52–57)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Publishes the Responses-API tool specification for creating an ad-hoc memory note, including generated input and output schemas.

**Data flow**: It combines the constant tool name, a human-readable description, and the `AddAdHocNoteArgs`/`AddAdHocMemoryNoteResponse` schema types into a `ToolSpec` returned by `memory_function_tool`.

**Call relations**: Registry construction and schema-focused tests reach this through the `ToolExecutor` trait. It delegates all schema generation and namespace wrapping to the shared tool-spec helper.


##### `AddAdHocNoteTool::handle`  (lines 59–61)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async handler into the boxed future type required by the `ToolExecutor` trait.

**Data flow**: It takes ownership of a `ToolCall`, invokes `self.handle_call(call)`, pins the resulting future in a `Box`, and returns that boxed future.

**Call relations**: The runtime tool-dispatch layer invokes this trait method for execution. Its only job is to forward into `handle_call` in the trait-compatible shape.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `AddAdHocNoteTool::handle_call`  (lines 68–90)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: Parses the incoming call, asks the backend to create the note file, records telemetry for the outcome, and returns the backend response as JSON tool output.

**Data flow**: It reads `self.backend` and `self.metrics_client`, clones the backend, parses `AddAdHocNoteArgs` from the `ToolCall`, builds `AddAdHocMemoryNoteRequest { filename, note }`, and awaits `backend.add_ad_hoc_note(...)`. It then records a metric using the operation name, fixed scope `ad_hoc_notes`, success derived from `response.is_ok()`, and truncation tag `not_applicable`; after that it maps backend errors into `FunctionCallError` and wraps the successful response in `JsonToolOutput` using `json!(response)`.

**Call relations**: This method is invoked only by `AddAdHocNoteTool::handle`. It depends on shared helpers for argument parsing, backend-error translation, tool naming/spec generation elsewhere in the type, and metric emission after backend completion.

*Call graph*: calls 2 internal fn (record_tool_call, new); called by 1 (handle); 4 external calls (clone, new, json!, parse_args).


### `ext/memories/src/tools/list.rs`

`domain_logic` · `tool request handling for directory listing`

This file contains the dedicated list tool for browsing the memories store. `ListArgs` defines the accepted function-call payload: optional `path`, optional pagination `cursor`, and optional `max_results` with a schema-level minimum of 1; `deny_unknown_fields` ensures legacy or misspelled fields are rejected instead of ignored. `ListTool<B>` carries a cloneable backend plus optional metrics client and exposes the standard `ToolExecutor<ToolCall>` surface: namespaced tool name, generated `ToolSpec`, and a boxed async handler.

The core logic lives in `handle_call`. It first clones the backend and parses the incoming JSON arguments with the shared parser. Before issuing the backend request, it derives a low-cardinality metric scope from the optional path, defaulting to `root` when no path filter is supplied. It then constructs `ListMemoriesRequest`, preserving the optional path and cursor while normalizing `max_results` through `clamp_max_results(DEFAULT_LIST_MAX_RESULTS, MAX_LIST_RESULTS)`. That means callers can omit the field, request too few, or request too many, and the backend still receives a bounded positive count. After awaiting `backend.list`, the function records telemetry regardless of success, including a truncation tag extracted from the successful response when available and `unknown` otherwise. Finally, backend domain errors are converted into model-facing or fatal function-call errors, and successful responses are serialized into `JsonToolOutput`. The ordering ensures metrics capture both successful pagination and validation failures.

#### Function details

##### `ListTool::tool_name`  (lines 46–48)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the namespaced identifier for the list tool.

**Data flow**: It transforms the constant `LIST_TOOL_NAME` into a `ToolName` using the shared namespacing helper and returns it without mutating state.

**Call relations**: Tool enumeration and dispatch use this trait method to identify the executor. It delegates namespace formatting to `memory_tool_name`.

*Call graph*: 1 external calls (memory_tool_name).


##### `ListTool::spec`  (lines 50–55)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the published tool specification for listing immediate files and directories under a memories path.

**Data flow**: It passes the list tool name, description string, `ListArgs` input type, and `ListMemoriesResponse` output type into `memory_function_tool` and returns the resulting `ToolSpec`.

**Call relations**: The registry and schema consumers reach this through the `ToolExecutor` trait. It relies on shared schema-generation machinery rather than constructing JSON manually.


##### `ListTool::handle`  (lines 57–59)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Wraps the async list implementation in the boxed future expected by the executor trait.

**Data flow**: It consumes a `ToolCall`, forwards it to `self.handle_call(call)`, pins the future, and returns the boxed future object.

**Call relations**: Runtime dispatch invokes this method; it exists solely to bridge the trait interface to the internal async handler.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListTool::handle_call`  (lines 66–94)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: Parses list arguments, normalizes pagination limits, invokes the backend listing operation, records scoped metrics, and returns the JSON-encoded listing response.

**Data flow**: It clones the backend, parses `ListArgs` from the `ToolCall`, computes a scope tag from `args.path.as_deref()` with default `root`, builds `ListMemoriesRequest { path, cursor, max_results }` where `max_results` is clamped between 1 and `MAX_LIST_RESULTS` with a default fallback, and awaits `backend.list(...)`. It records a metric using the operation name, derived scope, success flag from `response.is_ok()`, and a truncation tag derived from `response.as_ref().ok().map(|response| response.truncated)`. Then it maps backend errors into `FunctionCallError` and wraps the successful response in `JsonToolOutput`.

**Call relations**: Only `ListTool::handle` calls this method. It coordinates shared helpers for argument parsing, max-result normalization, scope/truncation tagging, backend-error translation, and telemetry emission around the backend call.

*Call graph*: calls 4 internal fn (record_tool_call, scope_from_optional_path, truncated_tag, new); called by 1 (handle); 5 external calls (clone, new, json!, clamp_max_results, parse_args).


### `ext/memories/src/tools/read.rs`

`io_transport` · `request handling`

This file defines the read-side tool adapter for memory files. `ReadArgs` is the request schema accepted from the tool layer: a required relative `path`, plus optional 1-indexed `line_offset` and `max_lines`, with `deny_unknown_fields` and schema constraints so invalid caller payloads are rejected before backend access. `ReadTool<B>` is generic over a `MemoriesBackend`, carrying both the backend instance and an optional `MetricsClient`.

As a `ToolExecutor<ToolCall>`, the type publishes a namespaced tool name and a `ToolSpec` built from the request/response types, so callers see the exact JSON contract for `ReadMemoryResponse`. Runtime execution is funneled through `handle`, which boxes and pins the async `handle_call` future.

`handle_call` performs the concrete work: it clones the backend for async use, parses `ReadArgs` from the incoming `ToolCall`, derives a metrics scope from the requested path, and invokes `backend.read` with a `ReadMemoryRequest`. The request always fills in `line_offset` with `1` when omitted and always enforces `DEFAULT_READ_MAX_TOKENS`, while leaving `max_lines` optional. After the backend returns, the function records success/failure and whether the response was truncated, then maps backend-specific errors through `backend_error_to_function_call`. Successful responses are serialized directly into `JsonToolOutput`. A subtle invariant here is that metrics are emitted for both success and failure paths before error conversion, preserving observability even when the tool call fails.

#### Function details

##### `ReadTool::tool_name`  (lines 45–47)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the externally visible tool name for the memory read operation. It wraps the read tool constant in the extension's shared memory-tool naming convention.

**Data flow**: Reads no call-specific input beyond `self`; transforms the static `READ_TOOL_NAME` through the shared naming helper into a `ToolName`; writes no state.

**Call relations**: Invoked by the extension/tool registry when enumerating available tools. It delegates naming policy to `memory_tool_name` so this tool stays consistent with the other memory tools.

*Call graph*: 1 external calls (memory_tool_name).


##### `ReadTool::spec`  (lines 49–54)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the JSON-schema-backed tool specification for reading memory files. The spec advertises the accepted `ReadArgs` shape and the `ReadMemoryResponse` payload shape along with a human-readable description.

**Data flow**: Consumes no runtime arguments besides `self`; combines `READ_TOOL_NAME`, the `ReadArgs` schema, the `ReadMemoryResponse` schema, and a fixed description string into a `ToolSpec`; writes no state.

**Call relations**: Used during tool registration and discovery so callers know how to invoke the tool. It relies on the shared `memory_function_tool` constructor to keep schema generation and formatting uniform across memory tools.


##### `ReadTool::handle`  (lines 56–58)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation into the `ToolExecutor` trait's boxed future interface. It is the synchronous entrypoint the extension framework calls for each tool invocation.

**Data flow**: Takes an incoming `ToolCall`, forwards it unchanged into `self.handle_call(call)`, and wraps the resulting future in `Box::pin`; returns a `ToolExecutorFuture` without mutating state.

**Call relations**: Called by the extension runtime whenever this tool is executed. Its only job is to dispatch into `handle_call`, which contains the actual read logic.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ReadTool::handle_call`  (lines 65–91)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: Parses the tool arguments, issues the backend read request, records metrics, and returns the backend response as JSON tool output. It is the concrete implementation of the read tool's behavior.

**Data flow**: Reads the incoming `ToolCall`, parses it into `ReadArgs`, extracts `path`, optional `line_offset`, and optional `max_lines`, derives a metrics scope from the path, and clones `self.backend`. It constructs a `ReadMemoryRequest` with `line_offset` defaulted to `1` and `max_tokens` fixed to `DEFAULT_READ_MAX_TOKENS`, awaits `backend.read`, records metrics using the success flag and optional `truncated` field from a successful response, maps backend errors into `FunctionCallError`, and on success serializes the `ReadMemoryResponse` into `JsonToolOutput`. It writes metrics externally but does not mutate internal tool state.

**Call relations**: Reached only from `ReadTool::handle` after the framework dispatches a tool call. It delegates argument decoding to `parse_args`, metrics tagging to `scope_from_path` and `truncated_tag`, metrics emission to `record_tool_call`, and final JSON wrapping to `JsonToolOutput::new`; backend failures are normalized through `backend_error_to_function_call` before returning to the caller.

*Call graph*: calls 4 internal fn (record_tool_call, scope_from_path, truncated_tag, new); called by 1 (handle); 4 external calls (clone, new, json!, parse_args).


### `ext/memories/src/tools/search.rs`

`io_transport` · `request handling`

This file provides the tool-layer adapter for searching memory files. `SearchArgs` is the deserializable, schema-exported argument type accepted from tool callers. It supports multiple query strings, optional `SearchMatchMode`, optional path scoping and pagination cursor, optional context line count, case-sensitivity and normalization flags, and an optional result limit. Schema annotations enforce non-empty query lists and positive bounds where required, while `deny_unknown_fields` prevents silent acceptance of misspelled parameters.

`SearchTool<B>` mirrors the read tool structure: it stores a generic `MemoriesBackend` plus optional metrics client and implements `ToolExecutor<ToolCall>`. The trait methods expose a namespaced tool name, a generated `ToolSpec` for `SearchArgs` → `SearchMemoriesResponse`, and a boxed async handler.

The main execution path is `handle_call`. It parses arguments, derives a metrics scope from the optional path (falling back to `"all"` when absent), converts `SearchArgs` into a backend-facing `SearchMemoriesRequest`, and awaits `backend.search`. Metrics are recorded regardless of success, including whether the backend marked the response as truncated. Successful responses are emitted as `JsonToolOutput`; backend errors are translated into function-call errors.

The important normalization logic lives in `SearchArgs::into_request`: omitted fields are replaced with explicit defaults (`Any` match mode, zero context lines, case-sensitive search enabled, normalization disabled), and `max_results` is bounded through `clamp_max_results` using both default and hard maximum constants. That keeps backend behavior predictable even when callers omit or overspecify limits.

#### Function details

##### `SearchTool::tool_name`  (lines 54–56)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registered tool name for memory search. It applies the shared memory-tool naming convention to the search tool constant.

**Data flow**: Reads no dynamic inputs beyond `self`; transforms `SEARCH_TOOL_NAME` into a `ToolName` via the shared helper; writes no state.

**Call relations**: Called by the tool framework during registration and discovery. It delegates the actual naming format to `memory_tool_name` so search aligns with the rest of the memories tool suite.

*Call graph*: 1 external calls (memory_tool_name).


##### `SearchTool::spec`  (lines 58–63)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Constructs the tool specification describing the search API. The spec binds the `SearchArgs` input schema to the `SearchMemoriesResponse` output schema and includes the user-facing description of supported search semantics.

**Data flow**: Uses `SEARCH_TOOL_NAME`, the `SearchArgs` schema, the `SearchMemoriesResponse` schema, and a fixed description string to produce a `ToolSpec`; it does not read or mutate runtime state.

**Call relations**: Used when the extension advertises available tools. It relies on `memory_function_tool` to generate a consistent function-style tool definition.


##### `SearchTool::handle`  (lines 65–67)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Bridges the trait-required synchronous method to the async search implementation. It packages the actual handler future into the boxed form expected by the extension API.

**Data flow**: Accepts a `ToolCall`, forwards it to `self.handle_call(call)`, pins the future, and returns it; no state is changed.

**Call relations**: Invoked by the extension runtime for each search tool call. It exists solely to dispatch into `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `SearchTool::handle_call`  (lines 74–92)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: Executes a memory search from a tool call: parse arguments, build the backend request, invoke the backend, emit metrics, and serialize the response. It is the operational core of the search tool.

**Data flow**: Consumes a `ToolCall`, parses it into `SearchArgs`, computes a metrics scope from `args.path`, clones `self.backend`, converts the args into a `SearchMemoriesRequest`, and awaits `backend.search`. It records metrics using the tool name, scope, success flag, and optional truncation marker from a successful response; then it maps backend errors into `FunctionCallError` and wraps a successful `SearchMemoriesResponse` in `JsonToolOutput`. It writes only external metrics.

**Call relations**: Reached from `SearchTool::handle` after framework dispatch. It depends on `parse_args` for validation, `SearchArgs::into_request` for defaulting/clamping, `scope_from_optional_path` and `truncated_tag` for metrics dimensions, `record_tool_call` for telemetry, and `backend_error_to_function_call` for error normalization.

*Call graph*: calls 4 internal fn (record_tool_call, scope_from_optional_path, truncated_tag, new); called by 1 (handle); 4 external calls (clone, new, json!, parse_args).


##### `SearchArgs::into_request`  (lines 96–111)

```
fn into_request(self) -> SearchMemoriesRequest
```

**Purpose**: Converts tool-layer search arguments into the backend's concrete request type, filling in omitted options with explicit defaults and enforcing result limits. This is where the user-facing flexible API becomes a backend-ready `SearchMemoriesRequest`.

**Data flow**: Consumes `self` by value, moving `queries`, `path`, and `cursor` directly into the output request. It replaces missing `match_mode` with `SearchMatchMode::Any`, missing `context_lines` with `0`, missing `case_sensitive` with `true`, missing `normalized` with `false`, and computes `max_results` by passing the optional caller value plus `DEFAULT_SEARCH_MAX_RESULTS` and `MAX_SEARCH_RESULTS` through `clamp_max_results`; returns the assembled `SearchMemoriesRequest` without mutating external state.

**Call relations**: Called from `SearchTool::handle_call` immediately before the backend search invocation. It centralizes parameter normalization so the handler and backend do not each need to duplicate defaulting logic.

*Call graph*: 1 external calls (clamp_max_results).


### `memories/write/src/workspace.rs`

`domain_logic` · `memory workspace setup, diff generation, and baseline reset`

This module is the workspace-facing side of memory consolidation. Its public async functions are thin orchestration wrappers around `codex_git_utils`: `prepare_memory_workspace` creates the root directory, deletes any stale `phase2_workspace_diff.md`, and ensures a usable baseline `.git/` repository exists; `memory_workspace_diff` removes that generated file before asking git utilities for the diff since the latest baseline init; `write_workspace_diff` renders a `GitBaselineDiff` into markdown and writes it under the fixed workspace-diff filename; and `reset_memory_workspace_baseline` removes the generated diff before resetting the repository baseline so prompt artifacts do not become part of the baseline history.

The central invariant is that `phase2_workspace_diff.md` is never treated as workspace input. That is enforced by `remove_workspace_diff`, which ignores `NotFound` but wraps other deletion failures with path context. Rendering is split into pure helpers: `render_workspace_diff_file` emits a heading, a status section listing each `GitBaselineChange` as `- <status> <path>`, and either `- none` when `has_changes()` is false or a fenced `diff` block containing the unified diff. `append_bounded_diff` truncates oversized diffs at `crate::workspace_diff::MAX_BYTES`, using `previous_char_boundary` to avoid slicing through UTF-8 code points and appending a truncation notice. The design keeps filesystem effects isolated in async wrappers while making formatting and truncation deterministic and testable.

#### Function details

##### `prepare_memory_workspace`  (lines 13–20)

```
async fn prepare_memory_workspace(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Initializes a memory workspace directory so later git-baseline diffing can run against a clean, usable baseline. It also proactively removes the generated diff artifact so that file never contaminates future diffs.

**Data flow**: It takes a workspace root `&Path`, creates the directory tree with `tokio::fs::create_dir_all`, calls `remove_workspace_diff` to delete `phase2_workspace_diff.md` if present, then invokes `ensure_git_baseline_repository` to create or repair the baseline repository. It returns `Ok(())` on success or an `anyhow` error enriched with the root path when directory creation fails.

**Call relations**: The main `run` flow calls this during setup before any diffing occurs. Internally it delegates cleanup to `remove_workspace_diff` and repository initialization/recovery to the git utility layer.

*Call graph*: calls 1 internal fn (remove_workspace_diff); called by 1 (run); 2 external calls (ensure_git_baseline_repository, create_dir_all).


##### `memory_workspace_diff`  (lines 26–29)

```
async fn memory_workspace_diff(root: &Path) -> anyhow::Result<GitBaselineDiff>
```

**Purpose**: Computes the current diff between the workspace contents and the latest git baseline, after first removing the generated diff file so it is not included in the result.

**Data flow**: Given a root path, it deletes `phase2_workspace_diff.md` via `remove_workspace_diff`, then awaits `diff_since_latest_init(root)` and returns the resulting `GitBaselineDiff`.

**Call relations**: This is called by `run` when the system needs the current workspace delta. Its only internal orchestration is to enforce the no-self-inclusion invariant before delegating actual diff computation to `codex_git_utils`.

*Call graph*: calls 1 internal fn (remove_workspace_diff); called by 1 (run); 1 external calls (diff_since_latest_init).


##### `write_workspace_diff`  (lines 32–37)

```
async fn write_workspace_diff(root: &Path, diff: &GitBaselineDiff) -> anyhow::Result<()>
```

**Purpose**: Persists a markdown prompt artifact summarizing the current workspace diff in a bounded, human-readable format.

**Data flow**: It takes the workspace root and a borrowed `GitBaselineDiff`, joins the root with `crate::workspace_diff::FILENAME`, renders the diff through `render_workspace_diff_file`, and writes the resulting string with `tokio::fs::write`. On failure it returns an `anyhow` error annotated with the destination path.

**Call relations**: The `run` orchestration invokes this after obtaining a diff. It delegates all formatting and truncation policy to `render_workspace_diff_file`.

*Call graph*: calls 1 internal fn (render_workspace_diff_file); called by 1 (run); 2 external calls (join, write).


##### `reset_memory_workspace_baseline`  (lines 43–46)

```
async fn reset_memory_workspace_baseline(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Promotes the current workspace contents to the new git baseline while ensuring the generated diff artifact is excluded from that reset.

**Data flow**: It accepts the workspace root, removes `phase2_workspace_diff.md` via `remove_workspace_diff`, then calls `reset_git_repository(root)` and returns that result.

**Call relations**: This function is used by a higher-level `handle` path when consolidation completes and the baseline should advance. It performs only the pre-reset cleanup before handing off to the git utility reset operation.

*Call graph*: calls 1 internal fn (remove_workspace_diff); called by 1 (handle); 1 external calls (reset_git_repository).


##### `remove_workspace_diff`  (lines 53–61)

```
async fn remove_workspace_diff(root: &Path) -> anyhow::Result<()>
```

**Purpose**: Deletes the generated `phase2_workspace_diff.md` file if it exists, treating absence as a normal condition. It is the shared guardrail that prevents the prompt artifact from feeding back into workspace state.

**Data flow**: It builds the artifact path by joining `root` with `crate::workspace_diff::FILENAME`, calls `tokio::fs::remove_file`, returns `Ok(())` for successful deletion or `NotFound`, and wraps any other I/O error with the file path for diagnostics.

**Call relations**: This helper is called before diffing, before baseline reset, and during workspace preparation. It centralizes the artifact-exclusion rule used by `prepare_memory_workspace`, `memory_workspace_diff`, and `reset_memory_workspace_baseline`.

*Call graph*: called by 3 (memory_workspace_diff, prepare_memory_workspace, reset_memory_workspace_baseline); 2 external calls (join, remove_file).


##### `render_workspace_diff_file`  (lines 63–82)

```
fn render_workspace_diff_file(diff: &GitBaselineDiff) -> String
```

**Purpose**: Formats a `GitBaselineDiff` into the markdown file consumed by later memory-consolidation phases. It emits both a concise status list and, when changes exist, a fenced unified diff section.

**Data flow**: It starts with a fixed markdown header and `## Status` section. If `diff.has_changes()` is false, it appends `- none` and returns immediately. Otherwise it iterates `diff.changes`, appending one line per change using each change status label and path, then opens a ```diff fence, appends the bounded unified diff via `append_bounded_diff`, closes the fence, and returns the assembled `String`.

**Call relations**: Only `write_workspace_diff` calls this. It delegates byte-limit enforcement and UTF-8-safe truncation to `append_bounded_diff`.

*Call graph*: calls 2 internal fn (has_changes, append_bounded_diff); called by 1 (write_workspace_diff); 2 external calls (from, format!).


##### `append_bounded_diff`  (lines 84–102)

```
fn append_bounded_diff(rendered: &mut String, diff: &str)
```

**Purpose**: Appends the unified diff text to an output buffer, truncating at the configured byte cap without breaking UTF-8 boundaries and adding an explicit truncation marker when needed.

**Data flow**: It takes a mutable rendered markdown `String` and the raw diff `&str`. If the diff length is within `crate::workspace_diff::MAX_BYTES`, it appends the whole diff and ensures a trailing newline. Otherwise it computes the last valid character boundary at or before the byte cap using `previous_char_boundary`, appends that prefix, normalizes a trailing newline, and then appends a `[workspace diff truncated at ... bytes]` notice.

**Call relations**: This helper is called only from `render_workspace_diff_file` to enforce prompt-size limits while preserving valid UTF-8 output.

*Call graph*: calls 1 internal fn (previous_char_boundary); called by 1 (render_workspace_diff_file); 1 external calls (format!).


##### `previous_char_boundary`  (lines 104–113)

```
fn previous_char_boundary(value: &str, max_bytes: usize) -> usize
```

**Purpose**: Finds the nearest valid UTF-8 character boundary at or before a requested byte index. It prevents truncation from slicing through a multibyte code point.

**Data flow**: It takes a string slice and a maximum byte count. If the limit is beyond the string length it returns the full length; otherwise it decrements from `max_bytes` until `value.is_char_boundary(index)` becomes true, then returns that index.

**Call relations**: This low-level helper is used only by `append_bounded_diff` during oversized diff truncation.

*Call graph*: called by 1 (append_bounded_diff).


### Skills subsystem and extension tools
These files present the core and extension-side skills machinery, from shared APIs and invocation helpers through providers, source routing, extension wiring, and the exposed skills tools.

### `core-skills/src/lib.rs`

`orchestration` · `cross-cutting`

This crate root organizes the skills feature into focused submodules and re-exports the pieces that other crates are expected to use. Public modules cover configuration rules, injection, loading, management, model types, remote support, rendering, and system integration; internal-only modules such as `invocation_utils`, `mention_counts`, and `skill_instructions` provide implementation details that are selectively surfaced through re-exports. The file itself contains no executable logic, but it defines the conceptual API of the subsystem.

The exported items outline the skills pipeline. `SkillsManager` and `SkillsLoadInput` are the main orchestration entry points for loading and maintaining available skills. `detect_implicit_skill_invocation_for_command` and the crate-private `build_implicit_skill_path_indexes` support command-to-skill matching. `build_skill_name_counts` exposes mention counting used to infer relevance from conversation text. The `model` exports—such as `HostLoadedSkills`, `SkillMetadata`, `SkillPolicy`, `SkillLoadOutcome`, `SkillError`, and `filter_skill_load_outcome_for_product`—define the data and filtering semantics around loaded skills. Rendering exports like `AvailableSkills`, `SkillMetadataBudget`, `SkillRenderReport`, `build_available_skills`, `default_skill_metadata_budget`, and `render_available_skills_body`, plus the instructional constants, turn loaded skill state into prompt-ready text. `SkillInstructions` rounds out the API as the packaged instruction representation. This root file therefore acts as the stable façade for the entire skills subsystem.


### `core-skills/src/invocation_utils.rs`

`domain_logic` · `request handling`

This file supports the implicit-invocation feature by turning loaded skills into lookup indexes and then inspecting shell commands for evidence that a skill is being used indirectly. `build_implicit_skill_path_indexes` consumes a `Vec<SkillMetadata>` and produces two `HashMap<AbsolutePathBuf, SkillMetadata>` indexes: one keyed by canonicalized `scripts/` directories and one keyed by canonicalized `SKILL.md` document paths. Canonicalization is best-effort; nonexistent paths remain unchanged so tests and partially materialized paths still participate.

`detect_implicit_skill_invocation_for_command` is the main entry. It canonicalizes the working directory, tokenizes the command with `shlex::split` and falls back to whitespace splitting if shell parsing fails, then tries two detectors in priority order. `detect_skill_script_run` looks for interpreter-style commands such as `python`, `bash`, `node`, `pwsh`, and similar. It skips flags and `--`, requires a recognized script extension, resolves the script path relative to the workdir, and walks ancestor directories upward until it finds a matching indexed `scripts/` directory. `detect_skill_doc_read` instead feeds the token list into the shared shell read-command parser and looks for `ParsedCommand::Read` entries whose resolved path matches an indexed skill doc.

The design intentionally reuses canonicalized absolute paths on both indexing and lookup sides, so relative and absolute command forms converge. Script execution detection runs before doc-read detection, making active script use the stronger implicit invocation signal when both could match.

#### Function details

##### `build_implicit_skill_path_indexes`  (lines 10–29)

```
fn build_implicit_skill_path_indexes(
    skills: Vec<SkillMetadata>,
) -> (
    HashMap<AbsolutePathBuf, SkillMetadata>,
    HashMap<AbsolutePathBuf, SkillMetadata>,
)
```

**Purpose**: Builds lookup tables that map each skill’s canonicalized `scripts/` directory and `SKILL.md` path back to that skill.

**Data flow**: Consumes a `Vec<SkillMetadata>`. For each skill it canonicalizes `path_to_skills_md` and inserts a cloned skill into `by_skill_doc_path`; if the skill doc has a parent directory, it joins `scripts`, canonicalizes that directory, and inserts the original skill into `by_scripts_dir`. It returns the two populated hash maps.

**Call relations**: Called when finalizing a loaded skill set so later command analysis can resolve paths back to skills quickly.

*Call graph*: calls 1 internal fn (canonicalize_if_exists); 1 external calls (new).


##### `detect_implicit_skill_invocation_for_command`  (lines 31–44)

```
fn detect_implicit_skill_invocation_for_command(
    outcome: &SkillLoadOutcome,
    command: &str,
    workdir: &AbsolutePathBuf,
) -> Option<SkillMetadata>
```

**Purpose**: Determines whether a shell command implicitly invokes a known skill by running one script under its `scripts/` tree or reading its `SKILL.md` file.

**Data flow**: Takes a `SkillLoadOutcome`, raw command string, and working directory. It canonicalizes the workdir, tokenizes the command, tries `detect_skill_script_run` first and returns that match if found; otherwise it tries `detect_skill_doc_read` and returns its result.

**Call relations**: This is the public detector used by higher-level execution tracking. It orchestrates tokenization and the two specialized detectors in priority order.

*Call graph*: calls 4 internal fn (canonicalize_if_exists, detect_skill_doc_read, detect_skill_script_run, tokenize_command).


##### `tokenize_command`  (lines 46–49)

```
fn tokenize_command(command: &str) -> Vec<String>
```

**Purpose**: Splits a shell command string into tokens with a shell-aware parser and a whitespace fallback.

**Data flow**: Reads the command string, attempts `shlex::split`, and if parsing fails, falls back to `split_whitespace().map(str::to_string).collect()`, returning `Vec<String>`.

**Call relations**: Used only by `detect_implicit_skill_invocation_for_command` to normalize command text before detection.

*Call graph*: called by 1 (detect_implicit_skill_invocation_for_command); 1 external calls (split).


##### `script_run_token`  (lines 51–81)

```
fn script_run_token(tokens: &[String]) -> Option<&str>
```

**Purpose**: Extracts the script path argument from interpreter-style commands when the runner and script extension are recognized.

**Data flow**: Consumes tokenized command arguments. It reads the first token, reduces it to a lowercase basename without `.exe`, checks it against a fixed runner allowlist, then scans subsequent tokens skipping flags and `--` until it finds the first positional token. If that token ends with one of the allowed script extensions, it returns `Some(&str)` for that token; otherwise `None`.

**Call relations**: Called by `detect_skill_script_run` as the gatekeeper for interpreter-based script execution detection.

*Call graph*: calls 1 internal fn (command_basename); called by 1 (detect_skill_script_run).


##### `detect_skill_script_run`  (lines 83–99)

```
fn detect_skill_script_run(
    outcome: &SkillLoadOutcome,
    tokens: &[String],
    workdir: &AbsolutePathBuf,
) -> Option<SkillMetadata>
```

**Purpose**: Matches a command against the indexed `scripts/` directories by resolving the executed script path and walking its ancestors.

**Data flow**: Takes the loaded outcome, token list, and canonicalized workdir. It obtains a candidate script token via `script_run_token`, joins it to the workdir, canonicalizes the resulting path, then iterates through that path’s ancestors. On the first ancestor present in `outcome.implicit_skills_by_scripts_dir`, it clones and returns the associated `SkillMetadata`; otherwise it returns `None`.

**Call relations**: Invoked first by `detect_implicit_skill_invocation_for_command` because script execution is treated as the strongest implicit invocation signal.

*Call graph*: calls 3 internal fn (canonicalize_if_exists, script_run_token, join); called by 1 (detect_implicit_skill_invocation_for_command); 1 external calls (new).


##### `detect_skill_doc_read`  (lines 101–116)

```
fn detect_skill_doc_read(
    outcome: &SkillLoadOutcome,
    tokens: &[String],
    workdir: &AbsolutePathBuf,
) -> Option<SkillMetadata>
```

**Purpose**: Matches shell commands that read a skill’s `SKILL.md` file using the shared parsed-command representation.

**Data flow**: Consumes the loaded outcome, token list, and canonicalized workdir. It passes tokens to `parse_command_impl`, iterates parsed commands, and for each `ParsedCommand::Read { path, .. }` joins the path to the workdir, canonicalizes it, and looks it up in `outcome.implicit_skills_by_doc_path`. It returns the first cloned matching skill or `None`.

**Call relations**: Called only if script-run detection fails, providing a secondary implicit invocation signal based on document reads.

*Call graph*: calls 3 internal fn (canonicalize_if_exists, parse_command_impl, join); called by 1 (detect_implicit_skill_invocation_for_command).


##### `command_basename`  (lines 118–124)

```
fn command_basename(command: &str) -> String
```

**Purpose**: Extracts the final path component of a command token for runner-name matching.

**Data flow**: Treats the input string as a `Path`, takes `file_name`, converts it to UTF-8 if possible, falls back to the original string otherwise, and returns an owned `String`.

**Call relations**: Used by `script_run_token` so commands like `/usr/bin/python3` and `python3.exe` match the runner allowlist.

*Call graph*: called by 1 (script_run_token); 1 external calls (new).


##### `canonicalize_if_exists`  (lines 126–128)

```
fn canonicalize_if_exists(path: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Best-effort canonicalization helper that preserves the original absolute path when filesystem canonicalization fails.

**Data flow**: Calls `path.canonicalize()` and returns the canonicalized path on success or a clone of the input `AbsolutePathBuf` on error.

**Call relations**: Shared by indexing and detection functions so both sides compare normalized paths without requiring every path to exist.

*Call graph*: calls 1 internal fn (canonicalize); called by 4 (build_implicit_skill_path_indexes, detect_implicit_skill_invocation_for_command, detect_skill_doc_read, detect_skill_script_run).


### `core-skills/src/remote.rs`

`io_transport` · `remote skill discovery and download`

This file is an I/O-focused remote client that talks to the `/hazelnuts` API surface using authenticated HTTP requests. Two enums, `RemoteSkillScope` and `RemoteSkillProductSurface`, model the query dimensions exposed by the API and are converted into query-string values by small mapping helpers. Authentication is intentionally strict: `ensure_codex_backend_auth` rejects missing auth and rejects API-key-style auth that does not use the Codex backend.

`list_remote_skills` builds a GET request with a 30-second timeout, optional `scope` and `enabled` query parameters, and auth headers derived from `CodexAuth`. It reads the full response body as text, fails fast on non-success status codes with the body included, deserializes the JSON payload from the oddly named `hazelnuts` field into internal structs, and maps those into `RemoteSkillSummary` values.

`export_remote_skill` downloads `/hazelnuts/{skill_id}/export` as bytes, verifies success, checks the ZIP magic bytes before extraction, creates `<codex_home>/skills/<skill_id>`, and offloads archive extraction to `spawn_blocking`. Extraction is defensive: `normalize_zip_name` strips a leading `./` and an optional top-level `{skill_id}/` prefix, `safe_join` rejects any path containing non-`Normal` components to prevent traversal, and `extract_zip_to_dir` skips directory entries while creating parent directories and copying file contents. The result reports the downloaded skill id and output path.

#### Function details

##### `as_query_scope`  (lines 33–40)

```
fn as_query_scope(scope: RemoteSkillScope) -> Option<&'static str>
```

**Purpose**: Maps a `RemoteSkillScope` enum value to the API's expected query-string representation.

**Data flow**: It takes a `RemoteSkillScope` and returns `Option<&'static str>`, matching each variant to a fixed kebab-case string. In the current implementation every variant maps to `Some(...)` and no state is read or written.

**Call relations**: This helper is used by `list_remote_skills` when assembling optional query parameters for the `/hazelnuts` request.

*Call graph*: called by 1 (list_remote_skills).


##### `as_query_product_surface`  (lines 42–49)

```
fn as_query_product_surface(product_surface: RemoteSkillProductSurface) -> &'static str
```

**Purpose**: Converts a `RemoteSkillProductSurface` enum into the exact product-surface string expected by the remote API.

**Data flow**: It matches the enum argument and returns a static string such as `chatgpt`, `codex`, `api`, or `atlas`. It has no side effects.

**Call relations**: This is called by `list_remote_skills` to populate the mandatory `product_surface` query parameter.

*Call graph*: called by 1 (list_remote_skills).


##### `ensure_codex_backend_auth`  (lines 51–61)

```
fn ensure_codex_backend_auth(auth: Option<&CodexAuth>) -> Result<&CodexAuth>
```

**Purpose**: Validates that remote-skill operations have ChatGPT/Codex-backend authentication available. It rejects both missing auth and unsupported API-key auth.

**Data flow**: It takes `Option<&CodexAuth>`, pattern-matches it, checks `uses_codex_backend()`, and returns `Result<&CodexAuth>`. On failure it constructs an `anyhow` error with a concrete explanatory message; on success it returns the borrowed auth unchanged.

**Call relations**: Both `list_remote_skills` and `export_remote_skill` call this first so they fail before issuing network requests when the auth mode cannot access remote skill scopes.

*Call graph*: called by 2 (export_remote_skill, list_remote_skills); 1 external calls (bail!).


##### `list_remote_skills`  (lines 89–139)

```
async fn list_remote_skills(
    chatgpt_base_url: String,
    auth: Option<&CodexAuth>,
    scope: RemoteSkillScope,
    product_surface: RemoteSkillProductSurface,
    enabled: Option<bool>,
) -> Re
```

**Purpose**: Fetches the remote skill catalog for a given scope, product surface, and optional enabled-state filter, then converts the API response into lightweight summaries.

**Data flow**: It accepts the base URL, optional auth, a `RemoteSkillScope`, a `RemoteSkillProductSurface`, and `Option<bool>` for enabled filtering. It trims trailing slashes from the base URL, validates auth, builds the `/hazelnuts` URL and query parameter vector, creates a reqwest client, attaches timeout and auth headers, sends the request, reads the response body as text, checks HTTP status, deserializes `RemoteSkillsResponse` from JSON, and maps each `RemoteSkill` into `RemoteSkillSummary`. It returns `Result<Vec<RemoteSkillSummary>>` and performs outbound HTTP I/O.

**Call relations**: This is the main read-side API client entrypoint. It delegates enum-to-query conversion and auth validation to local helpers, then performs the full request/parse pipeline itself.

*Call graph*: calls 4 internal fn (as_query_product_surface, as_query_scope, ensure_codex_backend_auth, build_reqwest_client); 5 external calls (bail!, auth_provider_from_auth, format!, from_str, vec!).


##### `export_remote_skill`  (lines 141–191)

```
async fn export_remote_skill(
    chatgpt_base_url: String,
    codex_home: PathBuf,
    auth: Option<&CodexAuth>,
    skill_id: &str,
) -> Result<RemoteSkillDownloadResult>
```

**Purpose**: Downloads a remote skill archive by id, validates that the payload is a ZIP, extracts it under the local Codex skills directory, and reports where it was written.

**Data flow**: It takes the base URL, `codex_home`, optional auth, and a `skill_id`. After auth validation it builds the `/hazelnuts/{skill_id}/export` URL, sends an authenticated GET with timeout, reads the body as bytes, checks status, verifies ZIP magic bytes with `is_zip_payload`, creates `<codex_home>/skills/<skill_id>`, clones the bytes and output path into a blocking task, and runs `extract_zip_to_dir` there with `prefix_candidates` containing the skill id. It returns `Result<RemoteSkillDownloadResult>` and writes files/directories on disk.

**Call relations**: This is the write-side remote client entrypoint. It relies on `ensure_codex_backend_auth` before networking, `is_zip_payload` before extraction, and `extract_zip_to_dir` plus its path-safety helpers to materialize the archive.

*Call graph*: calls 3 internal fn (ensure_codex_backend_auth, is_zip_payload, build_reqwest_client); 8 external calls (join, from_utf8_lossy, bail!, auth_provider_from_auth, format!, create_dir_all, spawn_blocking, vec!).


##### `safe_join`  (lines 193–204)

```
fn safe_join(base: &Path, name: &str) -> Result<PathBuf>
```

**Purpose**: Safely appends an archive entry name to an output directory while rejecting traversal or absolute-path components.

**Data flow**: It takes a base `&Path` and an entry `&str`, parses the name as a `Path`, iterates its components, and permits only `Component::Normal(_)`. If any other component appears, it returns an error; otherwise it returns `base.join(path)` as a `PathBuf`.

**Call relations**: This helper is called from `extract_zip_to_dir` for every normalized archive entry so extraction cannot escape the intended output directory.

*Call graph*: called by 1 (extract_zip_to_dir); 3 external calls (join, new, bail!).


##### `is_zip_payload`  (lines 206–210)

```
fn is_zip_payload(bytes: &[u8]) -> bool
```

**Purpose**: Performs a quick signature check to see whether a byte buffer looks like a ZIP archive.

**Data flow**: It reads the leading bytes of the provided slice and returns `true` if they match one of the standard ZIP signatures (`PK\x03\x04`, `PK\x05\x06`, or `PK\x07\x08`). It has no side effects.

**Call relations**: This is used by `export_remote_skill` as an early validation step before creating directories and attempting extraction.

*Call graph*: called by 1 (export_remote_skill).


##### `extract_zip_to_dir`  (lines 212–240)

```
fn extract_zip_to_dir(
    bytes: Vec<u8>,
    output_dir: &Path,
    prefix_candidates: &[String],
) -> Result<()>
```

**Purpose**: Extracts regular files from a ZIP archive into a target directory, optionally stripping a known top-level prefix and enforcing safe output paths.

**Data flow**: It takes owned ZIP bytes, an output directory path, and a slice of prefix-candidate strings. It opens a `zip::ZipArchive` over a cursor, iterates entries by index, skips directory entries, normalizes each entry name with `normalize_zip_name`, skips entries normalized to `None`, validates the destination path with `safe_join`, creates parent directories as needed, creates the output file, and copies the entry contents into it. It returns `Result<()>` and performs synchronous filesystem writes.

**Call relations**: This function is invoked inside the blocking extraction task spawned by `export_remote_skill`. It delegates path normalization and path safety to local helpers so the extraction loop stays focused on archive traversal and file creation.

*Call graph*: calls 3 internal fn (normalize_zip_name, safe_join, new); 4 external calls (create, create_dir_all, copy, new).


##### `normalize_zip_name`  (lines 242–259)

```
fn normalize_zip_name(name: &str, prefix_candidates: &[String]) -> Option<String>
```

**Purpose**: Normalizes a ZIP entry name by removing a leading `./` and stripping one matching top-level prefix directory when present.

**Data flow**: It takes the raw entry name and a list of prefix candidates. It trims leading `./`, then for each non-empty candidate checks for a `{prefix}/` prefix and strips the first match. If the resulting path is empty it returns `None`; otherwise it returns `Some(String)` with the normalized relative path.

**Call relations**: This helper is used by `extract_zip_to_dir` so exported archives can contain either bare files or a wrapping top-level directory named after the skill id without affecting the final on-disk layout.

*Call graph*: called by 1 (extract_zip_to_dir); 1 external calls (format!).


### `ext/skills/src/lib.rs`

`orchestration` · `cross-cutting`

This file defines the top-level structure of the skills extension. It makes `catalog` and `provider` public modules, while keeping `config`, `extension`, `fragments`, `render`, `selection`, `sources`, `state`, and `tools` mostly internal. The root then re-exports the pieces external callers need to wire the extension into a host: `SkillsExtensionConfig`, the standard `install` path and `install_with_providers` variant, concrete provider implementations (`ExecutorSkillProvider`, `HostSkillProvider`, `OrchestratorSkillProvider`), the `SkillProvider` trait itself, and source-aggregation types (`SkillProviderSource`, `SkillProviders`). This arrangement reveals the intended architecture: callers configure and install the extension, optionally supply or select provider implementations, and rely on internal modules to render prompts, choose skills, maintain state, and expose tools. The file contains no executable logic, but it is the compatibility boundary for the subsystem. A notable design choice is selective visibility: catalog and provider concepts are first-class API, while prompt fragments and selection mechanics remain implementation details that can evolve without changing downstream imports.


### `ext/skills/src/provider.rs`

`domain_logic` · `request handling`

This file is the abstraction layer between the skills extension and the concrete places skills can come from. It declares three provider submodules—`executor`, `host`, and `orchestrator`—and re-exports their provider types so callers can instantiate source-specific implementations through a common API. The core data models are request structs tailored to each operation. `SkillListQuery` carries turn-scoped and environment-scoped inputs for catalog assembly: a `turn_id`, executor capability roots, optional host-loaded skills, booleans controlling inclusion of host, bundled, and orchestrator skills, and optional MCP resource access. `SkillReadRequest` identifies a single resource by `SkillAuthority`, `SkillPackageId`, and `SkillResourceId`, plus optional host and MCP clients needed to resolve it in the correct source. `SkillSearchRequest` narrows search to a specific authority/package pair and a query string, and derives equality for deterministic comparisons. `SkillProviderFuture<'a, T>` standardizes async provider results as boxed, pinned, `Send` futures yielding `SkillProviderResult<T>`. The `SkillProvider` trait then defines the three operations: `list`, `read`, and `search`. The most important invariant is documented directly in the trait comments: authority boundaries must be preserved. A provider that lists a resource must also be the one that reads or searches it; implementations must not collapse source-specific identifiers into ambient local paths, which protects isolation and attribution across host, executor, and orchestrator-backed skill stores.


### `ext/skills/src/provider/executor.rs`

`domain_logic` · `skill discovery and skill read`

This provider bridges executor-owned filesystems into the shared skills catalog/read contract. `ExecutorSkillProvider` stores an `Arc<EnvironmentManager>` used to resolve environment ids into live environments and an optional `restriction_product` used to filter loaded skills by product.

Its `list` implementation walks every selected executor capability root from `SkillListQuery`. For each root, it constructs an executor `SkillAuthority`, verifies that the referenced environment still exists, validates that the configured path is absolute via `executor_absolute_path`, and then loads skills from that root using `load_skills_from_roots` with `SkillScope::User` and the environment's filesystem handle. The resulting load outcome is filtered through `filter_skill_load_outcome_for_product`, loader errors are converted into warning strings on the `SkillCatalog`, and each discovered skill becomes a `SkillCatalogEntry` through `catalog_entry_from_skill`. That helper synthesizes a stable `skill://{selected_root_id}/...` display/package path, binds the main prompt resource to the owning environment and absolute path, and preserves short description, dependencies, enabled state, and implicit-invocation visibility.

`read` is intentionally strict: it only accepts `SkillSourceKind::Executor`, requires the package id to equal the resource id string, requires an embedded environment binding on the `SkillResourceId`, and verifies that the referenced environment still exists. It then converts the absolute path into a `PathUri` and reads text through the environment filesystem. Search is currently a no-op returning an empty `SkillSearchResult`. The key invariant is that executor resources are only readable when the catalog entry carried the hidden environment/path binding created during listing.

#### Function details

##### `ExecutorSkillProvider::new_with_restriction_product`  (lines 38–46)

```
fn new_with_restriction_product(
        environment_manager: Arc<EnvironmentManager>,
        restriction_product: Option<Product>,
    ) -> Self
```

**Purpose**: Constructs an executor skill provider with a specific environment manager and optional product restriction. The restriction controls which loaded skills survive filtering during listing.

**Data flow**: Consumes an `Arc<EnvironmentManager>` and `Option<Product>`, stores them in `ExecutorSkillProvider { environment_manager, restriction_product }`, and returns the provider.

**Call relations**: Used by setup code and tests that need executor-backed skill discovery, sometimes with product-specific filtering enabled.

*Call graph*: called by 3 (refresh_test_state, new, selected_root_id_distinguishes_identical_executor_paths).


##### `ExecutorSkillProvider::list`  (lines 50–109)

```
fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Discovers skills under each selected executor capability root and converts them into catalog entries plus warnings. It is the provider's main catalog-building path.

**Data flow**: Consumes `SkillListQuery`, initializes `SkillCatalog::default()`, and iterates `query.executor_roots`. For each root it extracts the selected-root id, environment id, and path; constructs executor authority; looks up the environment in `self.environment_manager`; validates the path with `executor_absolute_path`; obtains the environment filesystem; loads skills from a single `SkillRoot`; filters the outcome by `self.restriction_product`; appends formatted loader errors to `catalog.warnings`; and pushes each discovered skill as a `SkillCatalogEntry` built by `catalog_entry_from_skill`. It returns `Ok(catalog)`.

**Call relations**: Called by higher-level provider orchestration when executor skills should be included in a turn's catalog. It delegates path validation to `executor_absolute_path`, skill loading to `load_skills_from_roots`, product filtering to `filter_skill_load_outcome_for_product`, and entry shaping to `catalog_entry_from_skill`.

*Call graph*: calls 4 internal fn (load_skills_from_roots, new, catalog_entry_from_skill, executor_absolute_path); 5 external calls (clone, pin, filter_skill_load_outcome_for_product, default, format!).


##### `ExecutorSkillProvider::read`  (lines 111–151)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Reads the text contents of an executor-owned skill resource from the correct environment filesystem. It validates authority, package/resource consistency, and embedded environment binding before touching the filesystem.

**Data flow**: Consumes `SkillReadRequest`, checks `request.authority.kind` is `SkillSourceKind::Executor`, checks `request.package.0 == request.resource.as_str()`, extracts `(environment_id, resource_path)` from `request.resource.environment_path()`, resolves the environment from `self.environment_manager`, converts the absolute path to `PathUri`, and awaits `environment.get_filesystem().read_file_text(...)`. On success it returns `SkillReadResult { resource: request.resource, contents }`; on any validation or I/O failure it returns `SkillProviderError` with a concrete message.

**Call relations**: Invoked when thread-state routing selects the executor provider for a skill read. It depends on the environment binding inserted by `catalog_entry_from_skill`; without that binding, reads are rejected.

*Call graph*: calls 2 internal fn (new, from_abs_path); 2 external calls (pin, format!).


##### `ExecutorSkillProvider::search`  (lines 153–155)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Implements the provider search interface as a stub that returns no matches. Executor-backed skill search is not supported here.

**Data flow**: Ignores the incoming `SkillSearchRequest` and returns `Ok(SkillSearchResult::default())`.

**Call relations**: Called only if higher-level code asks this provider to search. It intentionally delegates nothing and produces an empty result.

*Call graph*: 2 external calls (pin, default).


##### `catalog_entry_from_skill`  (lines 158–194)

```
fn catalog_entry_from_skill(
    skill: &SkillMetadata,
    enabled: bool,
    authority: SkillAuthority,
    selected_root_id: &str,
    environment_id: &str,
) -> SkillCatalogEntry
```

**Purpose**: Transforms loaded executor skill metadata into a catalog entry with a synthetic `skill://` package path and an environment-bound main prompt resource. It also carries through enabled and prompt-visibility flags.

**Data flow**: Reads `SkillMetadata`, `enabled`, `authority`, `selected_root_id`, and `environment_id`. It derives `skill_path` from `skill.path_to_skills_md`, normalizes backslashes to `/`, builds `display_path` as `skill://{selected_root_id}/...`, constructs a `SkillCatalogEntry::new(...)` with `SkillPackageId(display_path.clone())` and `SkillResourceId::environment(display_path.clone(), environment_id, skill.path_to_skills_md.clone())`, then chains short description, display path, and dependencies. If `enabled` is false it marks the entry disabled; if `skill.allows_implicit_invocation()` is false it hides the entry from prompt listings; returns the final entry.

**Call relations**: Called from `ExecutorSkillProvider::list` for each discovered skill. It encapsulates the provider-specific mapping from filesystem metadata to the shared catalog model.

*Call graph*: calls 2 internal fn (new, environment); called by 1 (list); 3 external calls (allows_implicit_invocation, new, format!).


##### `executor_absolute_path`  (lines 196–205)

```
fn executor_absolute_path(path: &str) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Validates that a configured executor root path is absolute and converts it into `AbsolutePathBuf`. It rejects relative paths before skill loading begins.

**Data flow**: Takes `path: &str`, converts it to `PathBuf`, checks `is_absolute()`, and either returns an `InvalidInput` `std::io::Error` or forwards the path into `AbsolutePathBuf::from_absolute_path_checked`; returns `std::io::Result<AbsolutePathBuf>`.

**Call relations**: Used by `ExecutorSkillProvider::list` before constructing `SkillRoot`s. It isolates path validation so listing can turn invalid roots into warnings instead of panics.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 1 (list); 2 external calls (from, new).


### `ext/skills/src/provider/host.rs`

`domain_logic` · `skill discovery and skill read`

This provider is the thin adapter between core host skill loading and the skills extension. `HostSkillProvider` is stateless and default-constructible because all dynamic data arrives through `SkillListQuery.host` and `SkillReadRequest.host`. The constant `HOST_AUTHORITY_ID` fixes the authority id used for all host-owned skills.

In `list`, the provider requires `query.host` to be present; otherwise it returns a `SkillProviderError` explaining that loaded host skills are required. When host data exists, it converts the underlying `SkillLoadOutcome` into a `SkillCatalog` via `catalog_from_outcome`. That helper preserves loader errors as warning strings and maps each loaded skill into a `SkillCatalogEntry` using `catalog_entry_from_skill`.

The entry conversion keeps the package id as the original `skills.md` path string, uses `SkillAuthority::new(SkillSourceKind::Host, HOST_AUTHORITY_ID)`, stores the same path as the main prompt `SkillResourceId`, and separately computes a normalized display path with forward slashes. It also carries over short description and dependencies, marks disabled skills, and hides skills that disallow implicit invocation.

`read` again requires host-loaded skills in the request. It locates the requested skill by comparing the requested resource id against both the raw path string and a slash-normalized version, which avoids Windows path separator mismatches. It then delegates file reading to `host_loaded_skills.read_skill_text`. Search is currently unsupported and returns an empty result. The key design choice is that this provider never reloads or caches skills; it trusts core to own loading and simply projects that state into extension-friendly types.

#### Function details

##### `HostSkillProvider::new`  (lines 31–33)

```
fn new() -> Self
```

**Purpose**: Constructs the stateless host skill provider. Because all runtime data is supplied per request, the constructor simply returns `Self`.

**Data flow**: Takes no inputs beyond type context and returns `HostSkillProvider` with no internal state.

**Call relations**: Used during extension installation to add host-backed skill support to the provider set.

*Call graph*: called by 1 (install).


##### `HostSkillProvider::list`  (lines 37–47)

```
fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Builds a catalog from the host's already-loaded skills for the current turn. It fails fast if the caller did not supply host-loaded skill state.

**Data flow**: Consumes `SkillListQuery`, checks `query.host`, and either returns `SkillProviderError::new("host skill provider requires loaded host skills")` or passes `host_loaded_skills.outcome()` into `catalog_from_outcome`, returning the resulting `SkillCatalog`.

**Call relations**: Called by provider orchestration when host skills should be included in the turn catalog. It delegates all catalog shaping to `catalog_from_outcome`.

*Call graph*: calls 2 internal fn (new, catalog_from_outcome); 1 external calls (pin).


##### `HostSkillProvider::read`  (lines 49–82)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Reads the contents of a host-owned skill resource from the already-loaded host skill set. It resolves the requested resource by matching against loaded skill paths, including slash-normalized variants.

**Data flow**: Consumes `SkillReadRequest`, checks `request.host`, scans `host_loaded_skills.outcome().skills` for a `SkillMetadata` whose `path_to_skills_md` string equals `request.resource.as_str()` either directly or after replacing backslashes with `/`, then awaits `host_loaded_skills.read_skill_text(skill)`. On success it returns `SkillReadResult { resource: request.resource, contents }`; on missing host state, missing skill, or read failure it returns `SkillProviderError` with a descriptive message.

**Call relations**: Invoked when read routing selects the host provider for a skill entry. It depends on the host-loaded skill snapshot supplied by higher-level extension code.

*Call graph*: calls 1 internal fn (new); 2 external calls (pin, format!).


##### `HostSkillProvider::search`  (lines 84–86)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Implements the provider search interface as an empty result. Host-backed skill search is not provided here.

**Data flow**: Ignores the incoming `SkillSearchRequest` and returns `Ok(SkillSearchResult::default())`.

**Call relations**: Only participates if higher-level code asks this provider to search; it intentionally performs no lookup.

*Call graph*: 2 external calls (pin, default).


##### `catalog_from_outcome`  (lines 89–110)

```
fn catalog_from_outcome(outcome: &SkillLoadOutcome) -> SkillCatalog
```

**Purpose**: Converts a core `SkillLoadOutcome` into the extension's `SkillCatalog`, preserving loader errors as warnings and loaded skills as catalog entries. It is the host provider's catalog translation helper.

**Data flow**: Reads `outcome.errors` to build `warnings` strings of the form `Failed to load skill at ...`, initializes `SkillCatalog { entries: Vec::new(), warnings }`, iterates `outcome.skills_with_enabled()`, converts each pair with `catalog_entry_from_skill`, and pushes the result into the catalog; returns the populated catalog.

**Call relations**: Called from `HostSkillProvider::list`. It delegates per-skill entry shaping to `catalog_entry_from_skill`.

*Call graph*: calls 2 internal fn (skills_with_enabled, catalog_entry_from_skill); called by 1 (list); 1 external calls (new).


##### `catalog_entry_from_skill`  (lines 112–134)

```
fn catalog_entry_from_skill(skill: &SkillMetadata, enabled: bool) -> SkillCatalogEntry
```

**Purpose**: Maps one loaded host skill into a `SkillCatalogEntry` with host authority and normalized display path. It preserves metadata and visibility flags from the core skill metadata.

**Data flow**: Reads `SkillMetadata` and `enabled`, derives `skill_path` from `path_to_skills_md`, computes `display_path` by replacing backslashes with `/`, constructs `SkillCatalogEntry::new(...)` with `SkillPackageId(skill_path.clone())`, host authority, and `SkillResourceId::new(skill_path)`, then chains short description, display path, and dependencies. It conditionally marks the entry disabled and/or hidden from prompt based on `enabled` and `skill.allows_implicit_invocation()`; returns the final entry.

**Call relations**: Called from `catalog_from_outcome` for each loaded host skill. It encapsulates the host-specific mapping into the shared catalog model.

*Call graph*: calls 3 internal fn (new, new, new); called by 1 (catalog_from_outcome); 2 external calls (allows_implicit_invocation, new).


### `ext/skills/src/provider/orchestrator.rs`

`domain_logic` · `skill discovery and skill read`

This provider exposes orchestrator-owned skills published over MCP. It is stateless, but its behavior is tightly constrained by constants: discovery and read timeouts, maximum resource pages and total skills, maximum lengths for names/descriptions/URIs, and a maximum read size for resource contents. Only resources with MIME type `mcp/skill` are considered.

`list` requires an MCP resource client and the presence of the `CODEX_APPS_MCP_SERVER_NAME` server; otherwise it returns an empty catalog. Discovery runs page-by-page under a single absolute deadline using `timeout_at`, tracking duplicate cursors, page count, total skill resources seen, malformed resources skipped, and whether truncation occurred. If the first page fails, the whole call errors; later failures degrade into warnings attached to the partial catalog. Each candidate resource is passed through `catalog_entry_from_resource`, which validates the package URI, extracts and normalizes metadata fields from `resource.meta`, qualifies non-user skills as `plugin_name:skill_name`, escapes descriptions, and synthesizes the main prompt URI by appending `/SKILL.md`.

`read` validates that the request authority exactly matches orchestrator ownership, checks that the requested resource URI belongs under the package URI, requires an MCP client, and performs a timed `read_resource` call. It then searches returned `ResourceContent` items for a text payload whose URI exactly matches the requested resource, rejects blobs or mismatched text entries, and enforces a byte-size limit before returning `SkillReadResult`.

The helper functions are where most invariants live: URI validation rejects whitespace, control characters, angle brackets, credentials, ports, queries, fragments, and malformed path segments; package/resource matching requires the resource path to extend the package path; label normalization collapses whitespace and rejects XML-sensitive characters; description normalization additionally escapes XML entities. Together these checks prevent malformed MCP metadata from leaking into prompts or routing logic.

#### Function details

##### `OrchestratorSkillProvider::new`  (lines 44–46)

```
fn new() -> Self
```

**Purpose**: Constructs the stateless orchestrator skill provider. All runtime transport state is supplied through list/read requests.

**Data flow**: Takes no inputs and returns `OrchestratorSkillProvider`.

**Call relations**: Used by extension setup code when orchestrator-backed skills should be available.

*Call graph*: called by 1 (thread_extensions).


##### `OrchestratorSkillProvider::list`  (lines 50–150)

```
fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Discovers orchestrator-owned skill resources over MCP, validates them, and returns a catalog plus warnings about truncation or malformed resources. It handles pagination, timeouts, and partial-failure behavior.

**Data flow**: Consumes `SkillListQuery`, checks `query.mcp_resources`, and verifies the MCP server exists. It initializes discovery state (`discovery_deadline`, empty `SkillCatalog`, `cursor`, `seen_cursors`, counters, and truncation flags), then loops up to `MAX_RESOURCE_PAGES`, calling `client.list_resources(..., cursor.clone())` under `tokio::time::timeout_at`. First-page failures return `Err(SkillProviderError)`; later failures append a warning and stop. For each page it filters resources by MIME type, enforces `MAX_ORCHESTRATOR_SKILLS`, converts valid resources with `catalog_entry_from_resource`, counts malformed ones, and advances pagination unless there is no next cursor or a duplicate cursor is detected. After the loop it appends truncation/skipped-resource warnings as needed and returns `Ok(catalog)`.

**Call relations**: Called by higher-level provider orchestration when orchestrator skills are enabled. It delegates per-resource validation and entry construction to `catalog_entry_from_resource` and uses `SkillProviderError::new` to normalize transport failures.

*Call graph*: calls 2 internal fn (new, catalog_entry_from_resource); 6 external calls (pin, new, default, format!, now, timeout_at).


##### `OrchestratorSkillProvider::read`  (lines 152–216)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Reads the main prompt text for an orchestrator-owned skill resource through MCP, with strict authority/package validation and timeout/size enforcement. It rejects malformed or mismatched resource responses.

**Data flow**: Consumes `SkillReadRequest`, checks that `request.authority` equals `SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME)`, verifies `resource_belongs_to_package(&request.package.0, request.resource.as_str())`, requires `request.mcp_resources`, and performs `client.read_resource(...)` under `tokio::time::timeout(ORCHESTRATOR_SKILL_READ_TIMEOUT, ...)`. It scans returned `result.contents` for `ResourceContent::Text` whose `uri` exactly matches the requested resource, extracts the text, rejects missing/mismatched contents and oversized payloads, and returns `SkillReadResult { resource: request.resource, contents }`; otherwise it returns `SkillProviderError` with a concrete message.

**Call relations**: Invoked when read routing selects the orchestrator provider. It relies on `resource_belongs_to_package` to ensure callers cannot read arbitrary MCP resources outside the advertised package.

*Call graph*: calls 3 internal fn (new, new, resource_belongs_to_package); 3 external calls (pin, format!, timeout).


##### `OrchestratorSkillProvider::search`  (lines 218–220)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Implements the provider search interface as an empty result. Orchestrator-backed skill search is not implemented here.

**Data flow**: Ignores the incoming `SkillSearchRequest` and returns `Ok(SkillSearchResult::default())`.

**Call relations**: Only participates if higher-level code asks this provider to search; it intentionally performs no MCP search operation.

*Call graph*: 2 external calls (pin, default).


##### `catalog_entry_from_resource`  (lines 223–249)

```
fn catalog_entry_from_resource(resource: &Resource) -> Option<SkillCatalogEntry>
```

**Purpose**: Validates an MCP resource's URI and metadata and, if valid, converts it into a `SkillCatalogEntry` for the orchestrator catalog. Invalid or malformed resources are dropped by returning `None`.

**Data flow**: Reads `resource.uri`, validates it with `validated_skill_uri`, extracts `resource.meta` as an object, reads `skill_name`, optional `source`, and possibly `plugin_name`, normalizes labels with `normalized_label`, qualifies non-user names as `plugin_name:skill_name` subject to `MAX_QUALIFIED_SKILL_NAME_CHARS`, normalizes/escapes the description with `normalized_description`, computes `main_prompt` via `main_prompt_uri`, and constructs a `SkillCatalogEntry::new(...)` with orchestrator authority and `SkillResourceId::new(main_prompt)`, then sets `.with_display_path(uri)`; returns `Some(entry)` or `None` on any validation failure.

**Call relations**: Called from `OrchestratorSkillProvider::list` for each candidate MCP resource. It encapsulates all metadata-shaping rules so listing can simply count malformed resources.

*Call graph*: calls 7 internal fn (new, new, new, main_prompt_uri, normalized_description, normalized_label, validated_skill_uri); called by 1 (list); 2 external calls (new, format!).


##### `validated_skill_uri`  (lines 251–253)

```
fn validated_skill_uri(uri: &str, max_chars: usize) -> Option<&str>
```

**Purpose**: Checks that a skill package URI is syntactically valid under the provider's rules and, if so, returns the original string slice. It is a convenience wrapper around full URL validation.

**Data flow**: Accepts `uri: &str` and `max_chars`, calls `validated_skill_url(uri, max_chars)`, and maps success to `Some(uri)` while preserving the original borrowed string.

**Call relations**: Used by `catalog_entry_from_resource` when it needs the validated original URI string rather than a parsed `Url` object.

*Call graph*: calls 1 internal fn (validated_skill_url); called by 1 (catalog_entry_from_resource).


##### `validated_skill_url`  (lines 255–279)

```
fn validated_skill_url(uri: &str, max_chars: usize) -> Option<Url>
```

**Purpose**: Parses and validates a skill URI against strict structural and character constraints. It rejects malformed, ambiguous, or potentially unsafe URIs before they enter catalog or read logic.

**Data flow**: Reads `uri` and `max_chars`, rejects strings that exceed the character limit or contain control characters, whitespace, `<`, or `>`, parses the URI with `Url::parse`, validates that the scheme is `skill`, the serialized URL matches the original string exactly, host is present and non-empty, username/password/port/query/fragment are absent, and path segments are present and non-empty, then returns `Some(Url)` or `None`.

**Call relations**: Called by both `validated_skill_uri` and `resource_belongs_to_package`, making it the shared gatekeeper for orchestrator URI validity.

*Call graph*: called by 2 (resource_belongs_to_package, validated_skill_uri); 1 external calls (parse).


##### `resource_belongs_to_package`  (lines 281–302)

```
fn resource_belongs_to_package(package: &str, resource: &str) -> bool
```

**Purpose**: Determines whether a resource URI is a descendant of a package URI under the same validated skill-URI namespace. This prevents reads from escaping the advertised package subtree.

**Data flow**: Accepts `package` and `resource` strings, validates both with `validated_skill_url` using package/resource-specific length limits, extracts and collects their path segments, and returns true only if scheme and host match, the resource has more path segments than the package, and the resource path starts with the package path segments.

**Call relations**: Used by `OrchestratorSkillProvider::read` before issuing an MCP read, enforcing package/resource consistency.

*Call graph*: calls 1 internal fn (validated_skill_url); called by 1 (read).


##### `normalized_label`  (lines 304–308)

```
fn normalized_label(value: &str, max_chars: usize) -> Option<String>
```

**Purpose**: Normalizes a single-line metadata label and rejects empty or XML-sensitive values. It is used for skill names and plugin names that will later appear in prompt-visible text.

**Data flow**: Accepts `value` and `max_chars`, normalizes whitespace and control characters through `normalized_single_line`, then rejects the result if it is empty or contains `&`, `<`, or `>`; returns `Option<String>`.

**Call relations**: Called by `catalog_entry_from_resource` when validating `skill_name` and `plugin_name` metadata.

*Call graph*: calls 1 internal fn (normalized_single_line); called by 1 (catalog_entry_from_resource).


##### `normalized_description`  (lines 310–317)

```
fn normalized_description(value: &str) -> Option<String>
```

**Purpose**: Normalizes a description to a single line and escapes XML-sensitive characters for safe prompt rendering. Unlike labels, descriptions may contain `&`, `<`, and `>` after escaping.

**Data flow**: Accepts `value`, normalizes it with `normalized_single_line` using `MAX_SKILL_DESCRIPTION_CHARS`, then replaces `&`, `<`, and `>` with `&amp;`, `&lt;`, and `&gt;`; returns `Option<String>`.

**Call relations**: Used by `catalog_entry_from_resource` to sanitize resource descriptions before storing them in catalog entries.

*Call graph*: calls 1 internal fn (normalized_single_line); called by 1 (catalog_entry_from_resource).


##### `normalized_single_line`  (lines 319–323)

```
fn normalized_single_line(value: &str, max_chars: usize) -> Option<String>
```

**Purpose**: Collapses arbitrary whitespace into single spaces and rejects control characters or overlong values. It is the shared primitive for label and description normalization.

**Data flow**: Splits `value` on whitespace, joins the pieces with single spaces, checks that the resulting character count is within `max_chars` and contains no control characters, and returns `Some(normalized_string)` or `None`.

**Call relations**: Called by both `normalized_label` and `normalized_description` to enforce common single-line normalization rules.

*Call graph*: called by 2 (normalized_description, normalized_label).


##### `main_prompt_uri`  (lines 325–327)

```
fn main_prompt_uri(package_uri: &str) -> String
```

**Purpose**: Derives the canonical main-prompt resource URI for a skill package by appending `SKILL.md`. It standardizes how package URIs map to readable prompt resources.

**Data flow**: Accepts `package_uri: &str`, trims any trailing slash, formats `"{package_uri}/SKILL.md"`, and returns the resulting `String`.

**Call relations**: Used by `catalog_entry_from_resource` when constructing the `SkillResourceId` for an orchestrator catalog entry.

*Call graph*: called by 1 (catalog_entry_from_resource); 1 external calls (format!).


### `ext/skills/src/sources.rs`

`orchestration` · `catalog load and skill IO dispatch`

This file is the dispatch layer between higher-level skills logic and concrete provider backends. `SkillProviderSource` wraps one `Arc<dyn SkillProvider>` together with a `SkillSourceKind` and human-readable label. It offers convenience constructors for host, executor, and orchestrator sources, plus predicates that decide whether a source should participate in a listing query (`should_list`) or whether it owns a requested authority kind (`owns_kind`).

`SkillProviders` is a small builder-style container around a `Vec<SkillProviderSource>`. It can be assembled incrementally with generic or specialized `with_*_provider` methods. For listing, `list_for_turn` delegates to `list_matching`, which iterates only sources allowed by the query and merges each returned `SkillCatalog` into one aggregate catalog. Listing failures are non-fatal here: `extend_catalog` appends a warning string like `"host skills unavailable: ..."` instead of aborting the whole operation. `list_orchestrator_for_turn` is stricter and returns an error immediately if any orchestrator provider fails, because orchestrator-only tool flows need a definitive result.

For `read` and `search`, the registry filters sources by `request.authority.kind`, tries them in order, and returns the first success. If all matching providers fail, it returns the last provider error; if no provider of that kind is configured at all, it synthesizes a `SkillProviderError` stating that the corresponding provider is not configured.

#### Function details

##### `SkillProviderSource::new`  (lines 23–33)

```
fn new(
        kind: SkillSourceKind,
        label: impl Into<String>,
        provider: Arc<dyn SkillProvider>,
    ) -> Self
```

**Purpose**: Constructs a provider source wrapper from an explicit source kind, label, and provider implementation.

**Data flow**: Accepts a `SkillSourceKind`, a label convertible into `String`, and an `Arc<dyn SkillProvider>`. It converts the label with `Into<String>` and returns a `SkillProviderSource` storing all three values.

**Call relations**: This is the base constructor used by the specialized `host`, `executor`, and `orchestrator` constructors. It is part of setup/build-time wiring rather than runtime dispatch.

*Call graph*: 1 external calls (into).


##### `SkillProviderSource::host`  (lines 35–37)

```
fn host(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Creates a `SkillProviderSource` tagged as a host-backed provider.

**Data flow**: Takes a label and provider, passes them with `SkillSourceKind::Host` into `SkillProviderSource::new`, and returns the resulting wrapper.

**Call relations**: It is called by `SkillProviders::with_host_provider` when assembling the provider registry. The specialization avoids repeating the host kind at call sites.

*Call graph*: called by 1 (with_host_provider); 1 external calls (new).


##### `SkillProviderSource::executor`  (lines 39–41)

```
fn executor(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Creates a `SkillProviderSource` tagged as an executor-backed provider.

**Data flow**: Takes a label and provider, forwards them with `SkillSourceKind::Executor` to `SkillProviderSource::new`, and returns the wrapper.

**Call relations**: It is called by `SkillProviders::with_executor_provider` during registry construction. This keeps executor source creation consistent with the other built-in kinds.

*Call graph*: called by 1 (with_executor_provider); 1 external calls (new).


##### `SkillProviderSource::orchestrator`  (lines 43–45)

```
fn orchestrator(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Creates a `SkillProviderSource` tagged as an orchestrator-backed provider.

**Data flow**: Takes a label and provider, forwards them with `SkillSourceKind::Orchestrator` to `SkillProviderSource::new`, and returns the wrapper.

**Call relations**: It is called by `SkillProviders::with_orchestrator_provider` when tool-facing orchestrator skill access is configured.

*Call graph*: called by 1 (with_orchestrator_provider); 1 external calls (new).


##### `SkillProviderSource::should_list`  (lines 47–54)

```
fn should_list(&self, query: &SkillListQuery) -> bool
```

**Purpose**: Determines whether this source should participate in a listing operation for the given turn query.

**Data flow**: Reads `self.kind` and the fields of `SkillListQuery`. It returns `query.include_host_skills` for host sources, checks that `executor_roots` is non-empty for executor sources, returns `query.include_orchestrator_skills` for orchestrator sources, and always returns `true` for custom sources.

**Call relations**: This predicate is consumed by `SkillProviders::list_for_turn` through `list_matching` to decide which providers are queried for a turn. It encodes the source-kind-specific inclusion policy.


##### `SkillProviderSource::owns_kind`  (lines 56–58)

```
fn owns_kind(&self, kind: &SkillSourceKind) -> bool
```

**Purpose**: Checks whether this source is responsible for a requested `SkillSourceKind`.

**Data flow**: Compares `self.kind` with the supplied `kind` reference and returns the equality result.

**Call relations**: It is used by `SkillProviders::read` and `SkillProviders::search` to filter the provider list down to only those sources that can satisfy a request for a given authority kind.


##### `SkillProviderSource::fmt`  (lines 62–68)

```
fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements a concise debug representation that exposes source kind and label without attempting to print the provider trait object.

**Data flow**: Writes a `DebugStruct` named `SkillProviderSource` into the provided formatter, including only the `kind` and `label` fields, and returns the formatter result.

**Call relations**: This method is used implicitly by Rust debug formatting. It supports diagnostics and tests while intentionally omitting the opaque provider implementation.

*Call graph*: 1 external calls (debug_struct).


##### `SkillProviders::new`  (lines 77–79)

```
fn new() -> Self
```

**Purpose**: Creates an empty provider registry.

**Data flow**: Calls `Default::default()` for `SkillProviders` and returns a value whose `sources` vector is empty.

**Call relations**: It is used by setup code and tests such as `thread_extensions` and `install` as the starting point for provider registration before chaining `with_*` methods.

*Call graph*: called by 6 (thread_extensions, install, orchestrator_catalog_snapshot_caches_failure, prompt_hidden_skill_can_still_be_invoked, root_qualified_locator_selects_only_the_matching_executor_skill, selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input); 1 external calls (default).


##### `SkillProviders::with_provider`  (lines 81–84)

```
fn with_provider(mut self, source: SkillProviderSource) -> Self
```

**Purpose**: Appends an already-constructed provider source to the registry in builder style.

**Data flow**: Takes ownership of `self` and a `SkillProviderSource`, pushes the source into `self.sources`, and returns the updated registry.

**Call relations**: This is the generic builder primitive underlying registry assembly. Callers use it when they already have a fully formed `SkillProviderSource`, including custom kinds.


##### `SkillProviders::with_host_provider`  (lines 86–90)

```
fn with_host_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Adds a host provider with the standard `host` label.

**Data flow**: Consumes `self` and an `Arc<dyn SkillProvider>`, constructs a host source via `SkillProviderSource::host("host", provider)`, pushes it into `sources`, and returns the updated registry.

**Call relations**: This convenience builder is used during extension wiring to register host-backed skill providers without manually constructing the source wrapper.

*Call graph*: calls 1 internal fn (host).


##### `SkillProviders::with_executor_provider`  (lines 92–96)

```
fn with_executor_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Adds an executor provider with the standard `executor` label.

**Data flow**: Consumes `self` and an `Arc<dyn SkillProvider>`, constructs an executor source via `SkillProviderSource::executor("executor", provider)`, pushes it into `sources`, and returns the updated registry.

**Call relations**: It is the executor-specific counterpart to `with_host_provider`, used when wiring environment-root-backed skill providers.

*Call graph*: calls 1 internal fn (executor).


##### `SkillProviders::with_orchestrator_provider`  (lines 98–102)

```
fn with_orchestrator_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Adds an orchestrator provider with the standard `orchestrator` label.

**Data flow**: Consumes `self` and an `Arc<dyn SkillProvider>`, constructs an orchestrator source via `SkillProviderSource::orchestrator("orchestrator", provider)`, pushes it into `sources`, and returns the updated registry.

**Call relations**: This builder is used when enabling orchestrator-owned skills and the tools that expose them.

*Call graph*: calls 1 internal fn (orchestrator).


##### `SkillProviders::has_orchestrator_provider`  (lines 104–108)

```
fn has_orchestrator_provider(&self) -> bool
```

**Purpose**: Reports whether any registered source is an orchestrator provider.

**Data flow**: Iterates `self.sources`, compares each source kind to `SkillSourceKind::Orchestrator`, and returns `true` on the first match or `false` otherwise.

**Call relations**: It is called by `tools` to decide whether orchestrator-specific skill tooling should be exposed.

*Call graph*: called by 1 (tools).


##### `SkillProviders::list_for_turn`  (lines 110–113)

```
async fn list_for_turn(&self, query: SkillListQuery) -> SkillCatalog
```

**Purpose**: Lists all skill sources relevant to a normal turn according to the supplied query flags and roots.

**Data flow**: Consumes a `SkillListQuery`, passes a closure based on `source.should_list(&query)` into `list_matching`, awaits the merged result, and returns a `SkillCatalog` containing entries and any accumulated warnings.

**Call relations**: This method is called by `list_skills` for general catalog assembly. It delegates the actual iteration and merge behavior to `list_matching` while supplying the standard inclusion policy.

*Call graph*: calls 1 internal fn (list_matching); called by 1 (list_skills).


##### `SkillProviders::list_orchestrator_for_turn`  (lines 115–136)

```
async fn list_orchestrator_for_turn(
        &self,
        query: SkillListQuery,
    ) -> SkillProviderResult<SkillCatalog>
```

**Purpose**: Lists only orchestrator-owned skills for a turn and fails fast if an orchestrator provider cannot be queried.

**Data flow**: Creates an empty `SkillCatalog`, iterates sources whose kind is `SkillSourceKind::Orchestrator`, clones the query for each provider call, awaits `provider.list`, maps any provider error into a labeled `SkillProviderError`, extends the aggregate catalog on success, and returns `Ok(catalog)` or the first mapped error.

**Call relations**: It is called by `list_skills` and by `SkillToolContext::catalog` when orchestrator-only tool operations need a snapshot. Unlike `list_matching`, it does not downgrade failures to warnings because callers need a definitive orchestrator catalog.

*Call graph*: called by 2 (list_skills, catalog); 2 external calls (default, clone).


##### `SkillProviders::list_matching`  (lines 138–154)

```
async fn list_matching(
        &self,
        query: &SkillListQuery,
        should_list: impl Fn(&SkillProviderSource) -> bool,
    ) -> SkillCatalog
```

**Purpose**: Implements the common loop for querying a filtered subset of providers and merging their catalogs with warning accumulation.

**Data flow**: Accepts a borrowed `SkillListQuery` and a predicate over `SkillProviderSource`. It initializes an empty `SkillCatalog`, iterates matching sources, clones the query for each async `provider.list` call, and passes each `Result<SkillCatalog, SkillProviderError>` plus the source label into `extend_catalog`; finally it returns the merged catalog.

**Call relations**: This internal helper is called by `list_for_turn`. It centralizes the provider iteration pattern so the public listing method only needs to define which sources should participate.

*Call graph*: calls 1 internal fn (extend_catalog); called by 1 (list_for_turn); 2 external calls (default, clone).


##### `SkillProviders::read`  (lines 156–179)

```
async fn read(
        &self,
        request: SkillReadRequest,
    ) -> Result<SkillReadResult, SkillProviderError>
```

**Purpose**: Routes a skill resource read request to providers of the matching authority kind and returns the first successful read.

**Data flow**: Consumes a `SkillReadRequest`, initializes `last_error` to `None`, filters `self.sources` by `source.owns_kind(&request.authority.kind)`, clones the request for each provider call, and awaits `provider.read`. On the first `Ok`, it returns the `SkillReadResult`; on `Err`, it records the error and continues. If no provider succeeds, it returns the last provider error if any, otherwise constructs a new `SkillProviderError` stating that the requested kind is not configured.

**Call relations**: It is called by `read_skill` in thread state. The method acts as ordered fallback across providers of the same kind, while preserving a clear configuration error when no matching provider exists at all.

*Call graph*: calls 1 internal fn (new); called by 1 (read_skill); 2 external calls (clone, format!).


##### `SkillProviders::search`  (lines 181–204)

```
async fn search(
        &self,
        request: SkillSearchRequest,
    ) -> Result<SkillSearchResult, SkillProviderError>
```

**Purpose**: Routes a skill search request to providers of the matching authority kind and returns the first successful search result.

**Data flow**: Consumes a `SkillSearchRequest`, filters sources by authority kind, clones the request for each provider invocation, and awaits `provider.search`. It returns the first successful `SkillSearchResult`, otherwise the last provider error seen, or a synthesized `SkillProviderError` if no provider of that kind is configured.

**Call relations**: This method follows the same fallback pattern as `read`, but for search operations. It is the search-side dispatch entry point for higher-level code that already knows the target authority kind.

*Call graph*: calls 1 internal fn (new); 2 external calls (clone, format!).


##### `extend_catalog`  (lines 207–218)

```
fn extend_catalog(
    catalog: &mut SkillCatalog,
    result: Result<SkillCatalog, SkillProviderError>,
    label: &str,
)
```

**Purpose**: Merges one provider listing result into the aggregate catalog, converting provider failures into warning strings instead of aborting the listing.

**Data flow**: Takes a mutable aggregate `SkillCatalog`, a `Result<SkillCatalog, SkillProviderError>`, and the source label. On success it extends the aggregate catalog with the source catalog; on error it pushes a formatted warning into `catalog.warnings` using the source label and provider error message.

**Call relations**: It is called by `SkillProviders::list_matching` for each queried source. This helper is what gives normal listing its best-effort behavior across multiple providers.

*Call graph*: calls 1 internal fn (extend); called by 1 (list_matching); 1 external calls (format!).


### `ext/skills/src/tools/mod.rs`

`orchestration` · `tool registration and tool request handling`

This module wires the skills tools into the extension API and centralizes the common mechanics they share. `skill_tools` builds a `SkillToolContext` from `SkillProviders`, optional `Arc<McpResourceClient>`, and `Arc<SkillsThreadState>`, then returns two boxed executors: `list::ListTool` and `read::ReadTool`. The context currently supports one authority, `SkillToolAuthority::Orchestrator`, and its `catalog` method resolves that authority into an orchestrator-only `SkillListQuery` with host and bundled skills disabled, empty executor roots, the current `turn_id`, and the optional MCP resource client. The resulting listing is cached through `SkillsThreadState::orchestrator_catalog_snapshot`.

The module also defines the translation boundary between internal and tool-facing authorities. `SkillToolAuthority::from_authority` accepts only the orchestrator authority whose label matches `CODEX_APPS_MCP_SERVER_NAME`; `into_authority` reconstructs that exact `SkillAuthority`. Tool naming and schema generation are standardized through `skill_tool_name` and `skill_function_tool`, which build a `ResponsesApiNamespace` tool spec using generated JSON Schemas from the sibling `schema` module.

Finally, the file contains generic request/response helpers. `parse_args` tolerates empty argument strings by treating them as `{}` before deserializing. `validate_handle` and `is_bounded_handle` enforce non-empty, control-character-free, byte-bounded opaque handles. `external_json_output` serializes any `Serialize` value into `JsonToolOutput` and marks it as external context, with serialization failures treated as fatal tool errors.

#### Function details

##### `skill_tools`  (lines 36–52)

```
fn skill_tools(
    providers: SkillProviders,
    mcp_resources: Option<Arc<McpResourceClient>>,
    thread_state: Arc<SkillsThreadState>,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Constructs the full set of skills tool executors and shares one context object between them.

**Data flow**: Consumes `SkillProviders`, an optional `Arc<McpResourceClient>`, and an `Arc<SkillsThreadState>`. It packages them into a `SkillToolContext`, clones that context for `list::ListTool`, moves the original into `read::ReadTool`, wraps both in `Arc<dyn ToolExecutor<ToolCall>>`, and returns them in a `Vec`.

**Call relations**: This function is called by `tools` when the extension exposes its tool surface. It is the top-level wiring point that binds provider access and thread state into the concrete list/read tool implementations.

*Call graph*: called by 1 (tools); 1 external calls (vec!).


##### `SkillToolContext::catalog`  (lines 62–81)

```
async fn catalog(&self, turn_id: &str, authority: SkillToolAuthority) -> SkillCatalog
```

**Purpose**: Loads the catalog visible to a tool call for the requested tool authority, currently limited to orchestrator-owned skills.

**Data flow**: Accepts a `turn_id` string and a `SkillToolAuthority`. For `Orchestrator`, it calls `thread_state.orchestrator_catalog_snapshot`, passing the optional MCP resource client and the future returned by `providers.list_orchestrator_for_turn` with a freshly built `SkillListQuery` containing the turn id, empty executor roots, `host: None`, `include_host_skills: false`, `include_bundled_skills: false`, `include_orchestrator_skills: true`, and the cloned MCP resource handle. It awaits and returns the resulting `SkillCatalog`.

**Call relations**: This method is called by both tool handlers (`ListTool::handle` and `ReadTool::handle`) whenever they need the current authority-scoped catalog. It bridges tool-facing authority selection to provider listing and thread-state caching.

*Call graph*: calls 1 internal fn (list_orchestrator_for_turn); called by 2 (handle, handle); 1 external calls (new).


##### `SkillToolAuthority::from_authority`  (lines 91–98)

```
fn from_authority(authority: &SkillAuthority) -> Option<Self>
```

**Purpose**: Maps an internal `SkillAuthority` to the corresponding tool-visible authority enum when that authority is supported by the tools API.

**Data flow**: Reads the supplied `SkillAuthority` and compares it to `SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME)`. It returns `Some(SkillToolAuthority::Orchestrator)` on an exact match and `None` otherwise.

**Call relations**: It is called by `listed_skill` in the list tool to suppress entries from unsupported authorities. This keeps the external tool API narrower than the internal catalog model.

*Call graph*: calls 1 internal fn (new); called by 1 (listed_skill).


##### `SkillToolAuthority::into_authority`  (lines 100–106)

```
fn into_authority(self) -> SkillAuthority
```

**Purpose**: Converts the tool-facing authority enum back into the exact internal `SkillAuthority` used for provider requests and catalog filtering.

**Data flow**: Consumes `self` and, for `Orchestrator`, constructs and returns `SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME)`.

**Call relations**: This conversion is used by tool handlers after parsing arguments so they can compare catalog entries and build provider requests using the internal authority type.

*Call graph*: calls 1 internal fn (new).


##### `skill_tool_name`  (lines 109–111)

```
fn skill_tool_name(name: &str) -> ToolName
```

**Purpose**: Builds a namespaced tool name under the shared `skills` namespace.

**Data flow**: Accepts a short tool name string and returns `ToolName::namespaced(SKILLS_NAMESPACE, name)`.

**Call relations**: It is called by both `ListTool::tool_name` and `ReadTool::tool_name` so all skills tools are registered consistently as `skills.<name>`.

*Call graph*: calls 1 internal fn (namespaced).


##### `skill_function_tool`  (lines 113–129)

```
fn skill_function_tool(name: &str, description: &str) -> ToolSpec
```

**Purpose**: Creates a `ToolSpec` for a schema-driven function tool in the `skills` namespace using generated input and output schemas.

**Data flow**: Accepts a tool name and description plus generic input/output schema types. It builds a `ResponsesApiTool` with the provided metadata, `strict: false`, no deferred loading, parses the generated input schema via `parse_tool_input_schema`, panicking if that generated schema cannot be parsed, attaches the generated output schema, wraps the function tool in a `ResponsesApiNamespace` with the default namespace description, and returns `ToolSpec::Namespace(...)`.

**Call relations**: This helper is used by both `ListTool::spec` and `ReadTool::spec`. It centralizes schema generation and namespace wrapping so individual tools only provide their type parameters and descriptive text.

*Call graph*: 4 external calls (parse_tool_input_schema, default_namespace_description, Namespace, vec!).


##### `parse_args`  (lines 131–140)

```
fn parse_args(call: &ToolCall) -> Result<T, FunctionCallError>
```

**Purpose**: Parses a tool call’s JSON argument payload into a typed request struct, treating empty input as an empty object.

**Data flow**: Accepts a `ToolCall`, retrieves the raw argument string with `function_arguments()`, and if the trimmed string is empty substitutes `Value::Object(serde_json::Map::new())`; otherwise it parses the string with `serde_json::from_str`, mapping parse failures to `FunctionCallError::RespondToModel`. It then deserializes the `Value` into `T` with `serde_json::from_value`, again mapping failures to `RespondToModel`, and returns `Result<T, FunctionCallError>`.

**Call relations**: This generic helper is called by both tool handlers before any business logic runs. It standardizes user-correctable argument errors as model-facing responses rather than fatal failures.

*Call graph*: 5 external calls (Object, function_arguments, new, from_str, from_value).


##### `validate_handle`  (lines 142–150)

```
fn validate_handle(name: &str, value: &str, max_bytes: usize) -> Result<(), FunctionCallError>
```

**Purpose**: Validates one opaque handle argument and returns a model-facing error message if it is empty, too long, or contains control characters.

**Data flow**: Takes a field name, a string value, and a byte limit. It calls `is_bounded_handle`; on success it returns `Ok(())`, and on failure it constructs `FunctionCallError::RespondToModel` with a formatted message naming the field and the maximum byte count.

**Call relations**: This helper is used by `ReadTool::handle` to validate `package` and `resource` arguments before catalog lookup or provider access. It separates reusable validation policy from tool-specific control flow.

*Call graph*: calls 1 internal fn (is_bounded_handle); 2 external calls (format!, RespondToModel).


##### `is_bounded_handle`  (lines 152–154)

```
fn is_bounded_handle(value: &str, max_bytes: usize) -> bool
```

**Purpose**: Checks the low-level validity rules for opaque handles used by the tools API.

**Data flow**: Accepts a string and maximum byte count, and returns `true` only if the string is non-empty, its byte length is at most `max_bytes`, and none of its characters satisfy `char::is_control`.

**Call relations**: It is called by `validate_handle` and also by list-tool code when deciding whether a catalog entry can be safely exposed as a tool-visible handle.

*Call graph*: called by 1 (validate_handle).


##### `external_json_output`  (lines 156–161)

```
fn external_json_output(value: &T) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Serializes a response value into a `JsonToolOutput` marked as external context for the extension API.

**Data flow**: Accepts any `Serialize` value, converts it to `serde_json::Value` with `serde_json::to_value`, maps serialization failure to `FunctionCallError::Fatal`, wraps the value in `JsonToolOutput::new(value).with_external_context()`, boxes it as `Box<dyn ToolOutput>`, and returns it.

**Call relations**: This helper is called by both tool handlers after they have built their typed response structs. It centralizes the final output encoding and the policy that serialization failures are fatal internal errors.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, to_value).


### `ext/skills/src/tools/list.rs`

`io_transport` · `tool request handling`

This file defines the list-side tool surface for the skills namespace. `ListTool` implements `ToolExecutor<ToolCall>` and advertises itself as `skills.list` with a schema-driven function spec. At execution time it parses JSON arguments into `ListArgs`, converts the requested `SkillToolAuthority` into a concrete `SkillAuthority`, and asks the shared `SkillToolContext` for the current catalog snapshot for the call’s `turn_id`.

The returned `SkillCatalog` is then transformed into a `ListResponse`. Only entries that are both `enabled` and owned by the requested authority are considered. Each candidate is passed through `listed_skill`, which rejects entries whose package id or main resource handle is empty, contains control characters, or exceeds `MAX_HANDLE_BYTES`; this prevents the tool from emitting malformed or unbounded opaque handles. Accepted entries are serialized as `ListedSkill` values containing authority, package id, human-readable name and description, and the main resource handle.

Warnings are also bounded before exposure: only the first four warning strings are kept, and each is truncated to 256 bytes with UTF-8-safe truncation. The final response is emitted through `external_json_output`, marking it as external-context JSON rather than free-form text.

#### Function details

##### `ListTool::tool_name`  (lines 55–57)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the fully namespaced tool name for the list operation.

**Data flow**: Reads the local `TOOL_NAME` constant (`"list"`), passes it to `skill_tool_name`, and returns the resulting `ToolName`.

**Call relations**: This method is invoked by the tool framework when registering or identifying the executor. It delegates namespace construction to the shared helper in `tools/mod.rs`.

*Call graph*: 1 external calls (skill_tool_name).


##### `ListTool::spec`  (lines 59–64)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes the `skills.list` tool as a schema-backed function tool with its input and output types.

**Data flow**: Uses `skill_function_tool::<ListArgs, ListResponse>` with the local tool name and a descriptive string, and returns the resulting `ToolSpec`.

**Call relations**: The tool framework calls this when exposing the tool schema. It relies on the shared schema/spec builder so list and read tools present a consistent namespace and schema shape.


##### `ListTool::handle`  (lines 66–83)

```
fn handle(&self, call: ToolCall) -> ToolExecutorFuture<'_>
```

**Purpose**: Executes a `skills.list` call by loading the authority-specific catalog, filtering entries, bounding warnings, and returning JSON output.

**Data flow**: Consumes a `ToolCall` inside an async future. It parses arguments with `parse_args`, converts `args.authority` into a concrete authority, awaits `self.context.catalog(&call.turn_id, args.authority)`, filters `catalog.entries` to enabled entries whose `entry.authority` equals the requested authority, transforms them with `listed_skill`, collects them into `ListResponse.skills`, truncates and limits `catalog.warnings` via `bounded_warnings`, and serializes the response through `external_json_output`.

**Call relations**: This is the runtime entrypoint for `skills.list`. It depends on `SkillToolContext::catalog` for catalog retrieval and on local helpers `listed_skill` and `bounded_warnings` to enforce output constraints before handing the result to the shared JSON-output helper.

*Call graph*: calls 2 internal fn (catalog, bounded_warnings); 3 external calls (pin, external_json_output, parse_args).


##### `listed_skill`  (lines 86–101)

```
fn listed_skill(entry: SkillCatalogEntry) -> Option<ListedSkill>
```

**Purpose**: Converts one catalog entry into the externally exposed `ListedSkill` shape if its authority and opaque handles are valid for tool output.

**Data flow**: Consumes a `SkillCatalogEntry`, maps `entry.authority` to `SkillToolAuthority` with `from_authority`, validates `entry.id.0` and `entry.main_prompt.as_str()` using `is_bounded_handle`, and returns `None` if either check fails. Otherwise it constructs and returns `Some(ListedSkill)` containing the authority, package id, name, description, and main resource string.

**Call relations**: It is called from `ListTool::handle` during response construction. The helper acts as the final gate that prevents unsupported authorities or malformed handles from leaking into tool-visible output.

*Call graph*: calls 1 internal fn (from_authority); 1 external calls (is_bounded_handle).


##### `bounded_warnings`  (lines 103–112)

```
fn bounded_warnings(warnings: Vec<String>) -> Vec<String>
```

**Purpose**: Limits the number and byte length of warning strings included in the list response.

**Data flow**: Consumes a `Vec<String>`, keeps only the first `MAX_WARNINGS` entries, truncates each warning to `MAX_WARNING_BYTES` using `truncate_utf8_to_bytes`, discards the truncation flag, and returns the resulting `Vec<String>`.

**Call relations**: This helper is called by `ListTool::handle` just before serialization. It ensures provider warnings remain informative without allowing unbounded warning payloads in tool responses.

*Call graph*: called by 1 (handle).


### `ext/skills/src/tools/read.rs`

`io_transport` · `tool request handling`

This file defines the read-side tool executor for the skills namespace. `ReadTool` exposes itself as `skills.read` with a schema describing three required inputs: `authority`, `package`, and `resource`. At runtime, the handler first parses arguments and converts the tool-facing authority into an internal `SkillAuthority`. It then validates the `package` and `resource` strings with the shared bounded-handle rules, rejecting empty, oversized, or control-character-containing values before any provider call is attempted.

The handler next loads the current authority-scoped catalog for the call’s `turn_id` and checks whether the requested package is presently available as an enabled entry owned by that authority. This prevents arbitrary reads against packages not surfaced by `skills.list`. If the package is available, it constructs a `SkillReadRequest` using the parsed package string wrapped as `SkillPackageId`, the requested resource wrapped as `SkillResourceId`, `host: None`, and the optional MCP resource client from context. The actual read is delegated through `SkillsThreadState::read_skill`, which may use orchestrator caching.

Provider failures are logged with `tracing::warn!` including turn id, call id, and resource, then converted into a model-facing generic error. As a final integrity check, the tool rejects any provider response whose `result.resource` differs from the requested resource id, treating that as a fatal internal contract violation before returning JSON output.

#### Function details

##### `ReadTool::tool_name`  (lines 47–49)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the fully namespaced tool name for the read operation.

**Data flow**: Reads the local `TOOL_NAME` constant (`"read"`), passes it to `skill_tool_name`, and returns the resulting `ToolName`.

**Call relations**: This method is used by the tool framework during registration and dispatch. It shares the common naming helper with the list tool.

*Call graph*: 1 external calls (skill_tool_name).


##### `ReadTool::spec`  (lines 51–56)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes the `skills.read` tool as a schema-backed function tool with typed request and response payloads.

**Data flow**: Calls `skill_function_tool::<ReadArgs, ReadResponse>` with the local tool name and descriptive text, and returns the resulting `ToolSpec`.

**Call relations**: The framework invokes this when exposing the tool schema. It relies on the shared spec builder so the read tool matches the namespace and schema conventions used by the list tool.


##### `ReadTool::handle`  (lines 58–111)

```
fn handle(&self, call: ToolCall) -> ToolExecutorFuture<'_>
```

**Purpose**: Executes a `skills.read` call by validating arguments, confirming package availability in the current catalog, reading the requested resource, and returning its contents as JSON.

**Data flow**: Consumes a `ToolCall` inside an async future. It parses `ReadArgs` with `parse_args`, converts `args.authority` into an internal authority, validates `args.package` and `args.resource` with `validate_handle`, and awaits `self.context.catalog(&call.turn_id, args.authority)`. It scans `catalog.entries` to ensure an enabled entry exists with matching authority and package id; if not, it returns `FunctionCallError::RespondToModel`. Otherwise it constructs `requested_resource = SkillResourceId::new(args.resource)` and a `SkillReadRequest` containing the authority, `SkillPackageId(args.package)`, cloned requested resource, `host: None`, and cloned MCP resources, then awaits `thread_state.read_skill(&providers, request)`. Provider errors are logged and mapped to a generic model-facing error. If the returned `result.resource` differs from `requested_resource`, it returns `FunctionCallError::Fatal`; otherwise it serializes `ReadResponse { resource, contents }` via `external_json_output`.

**Call relations**: This is the runtime entrypoint for `skills.read`. It depends on `SkillToolContext::catalog` to authorize the package against the current catalog, on shared parsing/validation helpers from `tools/mod.rs`, and on `SkillsThreadState::read_skill` to perform the actual provider-backed read with orchestrator-aware caching.

*Call graph*: calls 2 internal fn (new, catalog); 7 external calls (pin, new, external_json_output, parse_args, validate_handle, Fatal, RespondToModel).


### `ext/skills/src/extension.rs`

`orchestration` · `startup and turn handling`

This file is the orchestration layer for the skills extension. `SkillsExtension<C>` holds the configured `SkillProviders`, an `ExtensionEventSink` for warnings, and a host-config projection closure that extracts `SkillsExtensionConfig` from the host application's config type. It implements several extension traits so the same object participates in thread startup, config changes, prompt contribution, turn input processing, and tool registration.

At thread start, it snapshots selected capability roots from thread storage, determines whether orchestrator skills should be enabled by checking for the local environment, and inserts a fresh `SkillsThreadState`. On config changes, it updates the existing thread state if present or creates one if missing.

For always-visible prompt context, the `ContextContributor` path lists skills for the current thread, emits any provider warnings as protocol warning events, and renders an available-skills developer fragment when instructions are enabled. For turn input, the extension performs the heavier flow: list all relevant skills, emit warnings, detect explicit skill mentions in the user's input, optionally inject a filtered available-skills fragment, then read and inject each selected skill's main prompt. Prompt contents are truncated to configured byte limits, with truncation warnings emitted and stored. It also tracks which host skill prompts were injected so core host-skill machinery can avoid duplicate prompt insertion.

The helper methods keep responsibilities separated: `list_skills` merges ordinary provider results with an orchestrator snapshot path, `read_main_prompt` routes a single read through thread state/provider logic, and `emit_warning` converts plain strings into protocol `WarningEvent`s. The `install` functions construct the extension and register it with all relevant contributor hooks.

#### Function details

##### `SkillsExtension::on_thread_start`  (lines 57–74)

```
fn on_thread_start(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Initializes per-thread skills state when a new thread begins. It captures selected capability roots, computes whether orchestrator skills should be enabled, derives extension config from the host config, and stores a new `SkillsThreadState`.

**Data flow**: Reads `ThreadStartInput`: selected roots from `thread_store`, environment ids from `input.environments`, and host config from `input.config`. It clones the selected roots or defaults to an empty vector, computes `orchestrator_skills_enabled` by checking for absence of `LOCAL_ENVIRONMENT_ID`, constructs `SkillsThreadState::new(...)`, and inserts it into `thread_store`; returns an async future yielding `()`.

**Call relations**: Called by the extension framework at thread startup. It establishes the state later consumed by prompt contribution, tool exposure, and turn input processing.

*Call graph*: calls 1 internal fn (new); 1 external calls (pin).


##### `SkillsExtension::on_config_changed`  (lines 81–99)

```
fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &C,
        new_config: &C,
    )
```

**Purpose**: Applies updated host configuration to the thread-local skills state. If no thread state exists yet, it creates one with empty roots and orchestrator skills enabled by default.

**Data flow**: Reads `new_config`, transforms it through `config_from_host`, then checks `thread_store` for an existing `SkillsThreadState`. If present, it calls `state.set_config(next_config)`; otherwise it constructs `SkillsThreadState::new(next_config, Vec::new(), true)` and inserts it into `thread_store`.

**Call relations**: Invoked by the extension framework whenever host config changes. It keeps thread-local skills behavior synchronized with config without rebuilding the whole extension object.

*Call graph*: calls 2 internal fn (insert, new); 1 external calls (new).


##### `SkillsExtension::tools`  (lines 148–167)

```
fn tools(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Exposes skill-related tools only when orchestrator-backed skill tooling is available and enabled for the thread. It gates tool registration on both provider capability and thread state.

**Data flow**: Reads `thread_store` for `SkillsThreadState`; if absent returns an empty vector. It then checks `self.providers.has_orchestrator_provider()` and `thread_state.orchestrator_skills_enabled()`, and if both are true calls `skill_tools(self.providers.clone(), session_store.get::<McpResourceClient>(), thread_state)` to produce `Vec<Arc<dyn ToolExecutor<ToolCall>>>`.

**Call relations**: Called by the framework when collecting tools for the current thread/session. It delegates actual tool construction to `skill_tools` and suppresses tools entirely when orchestrator support is unavailable.

*Call graph*: calls 2 internal fn (has_orchestrator_provider, skill_tools); 2 external calls (new, clone).


##### `SkillsExtension::contribute`  (lines 174–291)

```
fn contribute(
        &'a self,
        input: TurnInputContext,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
        turn_store: &'a ExtensionData,
    ) -> Ext
```

**Purpose**: Builds turn-scoped contextual user fragments for skills: optional available-skills instructions plus injected main prompts for explicitly mentioned skills, while recording warnings and turn state. It is the main per-turn orchestration path for the extension.

**Data flow**: Reads `TurnInputContext`, `session_store`, `thread_store`, and `turn_store`. It fetches `SkillsThreadState`, current config, and optional `HostLoadedSkills`; builds a `SkillListQuery`; awaits `self.list_skills`; emits each catalog warning through `emit_warning`; computes `selected_entries` via `collect_explicit_skill_mentions`; optionally clones and filters the catalog to non-executor/non-orchestrator entries before rendering an available-skills fragment; then iterates selected entries, calling `read_main_prompt` for each. Successful reads are truncated with `truncate_main_prompt_contents`, converted into `SkillInstructions` using byte-limited `name` and `path` via `truncate_utf8_to_bytes`, and pushed into the fragment list; failures become warning strings and warning events. It accumulates `warnings`, tracks `main_prompts_injected`, builds `InjectedHostSkillPrompts` for host deduplication, inserts `SkillsTurnState` and possibly injected-host metadata into `turn_store`, and returns the assembled fragment vector.

**Call relations**: Invoked by the framework during turn input preparation. It depends on `list_skills` to gather catalog data, `read_main_prompt` to fetch selected skill contents, `available_skills_fragment` and `SkillInstructions` to build fragments, and `emit_warning` to surface provider/read/truncation issues as protocol events.

*Call graph*: calls 9 internal fn (insert, level_id, emit_warning, list_skills, read_main_prompt, available_skills_fragment, truncate_main_prompt_contents, truncate_utf8_to_bytes, collect_explicit_skill_mentions); 5 external calls (new, pin, new, default, format!).


##### `SkillsExtension::list_skills`  (lines 295–317)

```
async fn list_skills(
        &self,
        mut query: SkillListQuery,
        thread_state: &SkillsThreadState,
    ) -> SkillCatalog
```

**Purpose**: Lists skills for a turn, optionally merging ordinary provider results with an orchestrator snapshot. It isolates the special handling required for orchestrator skills from the rest of the extension flow.

**Data flow**: Takes a mutable `SkillListQuery` and `SkillsThreadState`. It snapshots `include_orchestrator_skills`, clones the original query for orchestrator use, extracts `mcp_resources`, disables orchestrator inclusion on the base query, awaits `self.providers.list_for_turn(query)` into a mutable `SkillCatalog`, and if orchestrator inclusion was requested, awaits `thread_state.orchestrator_catalog_snapshot(mcp_resources.as_deref(), self.providers.list_orchestrator_for_turn(orchestrator_query))` and merges the result with `catalog.extend(...)`; returns the final catalog.

**Call relations**: Called from both prompt-context contribution and turn-input contribution whenever a catalog is needed. It delegates ordinary listing to `SkillProviders` and orchestrator caching/snapshot behavior to `SkillsThreadState`.

*Call graph*: calls 3 internal fn (list_for_turn, list_orchestrator_for_turn, orchestrator_catalog_snapshot); called by 1 (contribute); 1 external calls (clone).


##### `SkillsExtension::read_main_prompt`  (lines 319–339)

```
async fn read_main_prompt(
        &self,
        entry: &SkillCatalogEntry,
        host_loaded_skills: Option<Arc<HostLoadedSkills>>,
        session_store: &ExtensionData,
        thread_state: &Sk
```

**Purpose**: Reads the main prompt resource for a selected catalog entry through thread-state routing and provider infrastructure. It converts provider errors into plain strings suitable for warning messages.

**Data flow**: Reads the selected `SkillCatalogEntry`, optional `HostLoadedSkills`, `session_store`, and `thread_state`; constructs a `SkillReadRequest` from the entry's authority, package id, and main prompt plus host/MCP context; awaits `thread_state.read_skill(&self.providers, request)`; on success returns `SkillReadResult`, on failure maps `SkillProviderError` to its `message` string.

**Call relations**: Used inside the turn-input contribution loop for each explicitly selected skill. It delegates actual authority-based read routing to `SkillsThreadState::read_skill`.

*Call graph*: calls 1 internal fn (read_skill); called by 1 (contribute).


##### `SkillsExtension::emit_warning`  (lines 341–346)

```
fn emit_warning(&self, turn_id: &str, message: String)
```

**Purpose**: Sends a warning event for the current turn through the extension event sink. It is the single place where skills warnings are converted into protocol events.

**Data flow**: Accepts a `turn_id` and warning `message`, constructs an `Event` with `id: turn_id.to_string()` and `msg: EventMsg::Warning(WarningEvent { message })`, and emits it through `self.event_sink`.

**Call relations**: Called from both contribution paths whenever provider warnings, read failures, or truncation notices need to be surfaced to the host/UI.

*Call graph*: called by 1 (contribute); 1 external calls (Warning).


##### `install`  (lines 349–360)

```
fn install(
    registry: &mut ExtensionRegistryBuilder<C>,
    config_from_host: impl Fn(&C) -> SkillsExtensionConfig + Send + Sync + 'static,
)
```

**Purpose**: Registers the skills extension with the default provider set. It creates a fresh `SkillProviders` containing a host provider and forwards to the more general installer.

**Data flow**: Takes a mutable `ExtensionRegistryBuilder<C>` and a config projection closure, constructs `SkillProviders::new().with_host_provider(Arc::new(HostSkillProvider::new()))`, and passes both to `install_with_providers`; it mutates the registry indirectly through that call.

**Call relations**: Used by consumers that want the standard skills extension setup. It delegates all actual registration work to `install_with_providers`.

*Call graph*: calls 3 internal fn (install_with_providers, new, new); 1 external calls (new).


##### `install_with_providers`  (lines 362–379)

```
fn install_with_providers(
    registry: &mut ExtensionRegistryBuilder<C>,
    providers: SkillProviders,
    config_from_host: impl Fn(&C) -> SkillsExtensionConfig + Send + Sync + 'static,
)
```

**Purpose**: Constructs a `SkillsExtension` with the supplied providers and registers it for all relevant extension hooks. This is the configurable installation entrypoint used when tests or alternate deployments need custom providers.

**Data flow**: Consumes the provided `SkillProviders` and config projection closure, obtains the registry's event sink, wraps everything in `Arc<SkillsExtension<_>>`, and registers clones of that extension as thread lifecycle, config, prompt, turn input, and tool contributors on the `ExtensionRegistryBuilder`.

**Call relations**: Called by `install` and by any caller needing custom provider composition. It is the final wiring step that makes the extension active in the host runtime.

*Call graph*: calls 6 internal fn (config_contributor, event_sink, prompt_contributor, thread_lifecycle_contributor, tool_contributor, turn_input_contributor); called by 1 (install); 1 external calls (new).
