# Extension-backed tool runtimes and namespaces  `stage-14.3.3`

This stage is shared support for the model’s “extra hands.” On each turn, spec_plan builds the tool menu and the router that runs the chosen tool. hosted_spec adds provider-side abilities like web search or image creation. Dynamic-tool files adapt tools supplied during the conversation, while extension_tools lets installed extensions behave like built-in tools and report progress.

Several helper tools make the menu easier to use: tool_search lets the model find hidden tools by text, view_image loads an image file for inspection, get_context_remaining reports remaining conversation space, and small spec files describe plan updates, new contexts, and worker-agent jobs.

Code mode is the long-running script area. Its runtime prepares a safe JavaScript world, callbacks let scripts talk back to Rust, and execute/wait tools start, monitor, or stop script cells.

The extension registry is the sign-up sheet. Web search, image generation, goals, memories, and skills plug into it. Memories safely list, read, search, and write local notes. Skills gather packages from the host, executor, orchestrator, or remote service, then expose safe list and read tools.

## Files in this stage

### Tool planning and core adapters
These files build the per-turn tool plan and provide the core adapters and specs for dynamic, extension-backed, hosted, and helper tools exposed through the runtime.

### `core/src/tools/spec_plan.rs`

`orchestration` · `per-turn tool setup`

A model can only call tools that are both advertised to it and registered on the backend. This file keeps those two worlds in sync. It looks at the current turn settings, model abilities, feature flags, authentication, environment access, and installed tool sources, then builds two things: a list of tool descriptions the model may see, and a registry of tool runtimes that can actually execute calls.

The main flow starts with `build_tool_router`. It gathers all possible sources: shell execution, file patching, image viewing, planning, user-input requests, MCP server tools and resources, extension tools, dynamic tools, web search, image generation, and collaboration tools for sub-agents. Each tool is added with an exposure level, which means whether the model sees it directly, only through search, only through code mode, or not at all.

It also has special rules. In code mode, many normal tools are wrapped as nested tools behind the code-mode executor. Namespace tools are merged so related tools appear under one named group. Multi-agent version 2 tools can be moved into a configured namespace. Duplicate names are skipped so one tool name cannot point to two different implementations. Without this file, the model might see tools it cannot run, miss tools it should have, or be offered unsafe or unsupported tools for the current session.

#### Function details

##### `PlannedTools::add`  (lines 108–113)

```
fn add(&mut self, handler: T)
```

**Purpose**: Adds a normal tool runtime to the growing plan. A runtime is the executable side of a tool: the code that will run if the model calls that tool.

**Data flow**: It receives a concrete tool handler, wraps it in shared ownership so it can be stored with other tool types, and appends it to the planned runtime list. The plan is changed; nothing is returned.

**Call relations**: The tool-source builders use this when they decide a built-in, MCP, dynamic, or extension-backed tool should be part of the turn. Later, the registry builder reads this list to create the executable tool registry.

*Call graph*: called by 7 (add_collaboration_tools, add_core_utility_tools, add_dynamic_tools, add_mcp_resource_tools, add_mcp_runtime_tools, add_shell_tools, append_extension_tool_executors); 1 external calls (new).


##### `PlannedTools::add_arc`  (lines 115–117)

```
fn add_arc(&mut self, handler: PlannedRuntime)
```

**Purpose**: Adds a tool runtime that has already been wrapped for shared ownership. This is used when another helper has already prepared or decorated the handler.

**Data flow**: It takes an already shared tool runtime and appends it directly to the planned runtime list. The plan grows by one runtime.

**Call relations**: Collaboration planning uses this for multi-agent tools that may have namespace or exposure wrappers. Tool search also uses it when it reuses or creates a cached search handler.

*Call graph*: called by 2 (add_collaboration_tools, append_tool_search_executor).


##### `PlannedTools::add_with_exposure`  (lines 119–125)

```
fn add_with_exposure(&mut self, handler: T, exposure: ToolExposure)
```

**Purpose**: Adds a tool while explicitly setting how visible it should be to the model. This separates “the backend can run it” from “the model should see it directly.”

**Data flow**: It receives a handler and an exposure setting, wraps the handler with that exposure, then stores it in the planned runtime list. The output is an updated plan.

**Call relations**: Higher-level planners call this when a tool needs special visibility, such as deferred search-only tools, model-only tools, or hidden dispatch helpers. It relies on the registry exposure wrapper before the final registry is built.

*Call graph*: calls 1 internal fn (override_tool_exposure); called by 4 (add_dispatch_only, add_collaboration_tools, add_core_utility_tools, add_mcp_runtime_tools); 1 external calls (new).


##### `PlannedTools::add_dispatch_only`  (lines 127–132)

```
fn add_dispatch_only(&mut self, handler: T)
```

**Purpose**: Adds a tool that can be called by the backend router but should not be advertised directly to the model. This is useful for backwards compatibility or internal dispatch.

**Data flow**: It receives a handler, marks it as hidden through `add_with_exposure`, and leaves it available in the runtime list but not in the visible tool list.

**Call relations**: Shell planning uses this to keep the legacy shell command implementation registered when the newer unified exec tool is the one shown to the model.

*Call graph*: calls 1 internal fn (add_with_exposure); called by 1 (add_shell_tools).


##### `PlannedTools::add_hosted_spec`  (lines 134–136)

```
fn add_hosted_spec(&mut self, spec: ToolSpec)
```

**Purpose**: Adds a provider-hosted tool description that the model provider runs itself, rather than a local runtime this process executes.

**Data flow**: It takes a tool specification and appends it to the hosted-spec list. No executable runtime is added because the provider owns execution.

**Call relations**: The tool-source collector uses this for hosted web search or image generation specs. The final builder later mixes these descriptions into the model-visible list.

*Call graph*: called by 1 (add_tool_sources).


##### `PlannedTools::runtimes`  (lines 138–140)

```
fn runtimes(&self) -> &[PlannedRuntime]
```

**Purpose**: Gives read-only access to the tool runtimes already planned. Helpers use this to inspect what has been added so far.

**Data flow**: It reads the internal runtime list and returns it as a slice, without changing the plan.

**Call relations**: Search, extension, and code-mode helpers use this snapshot to avoid name clashes, find deferred tools, or wrap existing tools for code mode.

*Call graph*: called by 3 (append_extension_tool_executors, append_tool_search_executor, prepend_code_mode_executors).


##### `build_tool_router`  (lines 157–165)

```
fn build_tool_router(
    turn_context: &TurnContext,
    params: ToolRouterParams<'_>,
    tool_search_handler_cache: &ToolSearchHandlerCache,
) -> ToolRouter
```

**Purpose**: Builds the final `ToolRouter`, the object that both advertises tools to the model and routes tool calls to the right executor. This is the public entry point of this file.

**Data flow**: It receives the turn context, externally supplied tool parameters, and a cache for the search tool. It asks for visible specs and a registry, then combines them into a router.

**Call relations**: The broader turn setup calls this when preparing a model request. It delegates the real planning work to `build_tool_specs_and_registry` and then hands the result to `ToolRouter::from_parts`.

*Call graph*: calls 2 internal fn (from_parts, build_tool_specs_and_registry); called by 1 (from_turn_context).


##### `build_tool_specs_and_registry`  (lines 168–198)

```
fn build_tool_specs_and_registry(
    turn_context: &TurnContext,
    params: ToolRouterParams<'_>,
    tool_search_handler_cache: &ToolSearchHandlerCache,
) -> (Vec<ToolSpec>, ToolRegistry)
```

**Purpose**: Creates the complete tool plan for the turn, then turns that plan into model-facing descriptions and an executable registry.

**Data flow**: It unpacks supplied MCP, extension, dynamic, and discoverable tools; builds a planning context from the current turn; gathers all tool sources; adds search and code-mode tools when needed; and returns the final visible specs plus registry.

**Call relations**: This is called by `build_tool_router`. It orchestrates the main phases: source collection, optional search insertion, optional code-mode insertion, and final registry/spec construction.

*Call graph*: calls 5 internal fn (add_tool_sources, append_tool_search_executor, build_model_visible_specs_and_registry, prepend_code_mode_executors, wait_agent_timeout_options); called by 1 (build_tool_router); 3 external calls (default, build, new).


##### `build_model_visible_specs_and_registry`  (lines 201–239)

```
fn build_model_visible_specs_and_registry(
    turn_context: &TurnContext,
    planned_tools: PlannedTools,
) -> (Vec<ToolSpec>, ToolRegistry)
```

**Purpose**: Converts the planned tools into the two final products: what the model sees and what the backend can run.

**Data flow**: It walks through planned runtimes, skips duplicate tool names, checks each tool’s exposure, optionally adjusts specs for code mode, adds hosted specs, merges namespace groups, filters unsupported namespace specs, and builds a `ToolRegistry` from all runtimes.

**Call relations**: This is the final phase after all tools have been collected. It uses helper rules for code-mode hiding and namespace merging before returning to `build_tool_specs_and_registry`.

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

**Purpose**: Adjusts an individual tool description before it is sent to the model. Its main job is to mark eligible tools so code mode can call them as nested tools.

**Data flow**: It receives the turn context, tool exposure, tool name, and original spec. If the turn is in code mode and the tool is allowed to be nested, it returns an augmented spec; otherwise it returns the original spec unchanged.

**Call relations**: The final spec builder calls this for each directly visible runtime. It consults code-mode exclusion rules so configured namespaces are not accidentally exposed through code mode.

*Call graph*: calls 2 internal fn (is_excluded_from_code_mode, name); called by 1 (build_model_visible_specs_and_registry); 3 external calls (is_code_mode_nested_tool, augment_tool_spec_for_code_mode, matches!).


##### `hosted_model_tool_specs`  (lines 260–295)

```
fn hosted_model_tool_specs(context: &CoreToolPlanContext<'_>) -> Vec<ToolSpec>
```

**Purpose**: Chooses provider-hosted tools, such as hosted web search or hosted image generation, that should be included in the model request. Hosted means the model provider runs the tool, not this local process.

**Data flow**: It reads model capabilities, provider capabilities, feature flags, web-search configuration, image-generation availability, and extension availability. It returns a list of hosted tool specs to advertise, or an empty list when hosted tools are not appropriate.

**Call relations**: The source collector calls this after adding local runtimes. It avoids adding hosted web or image tools when a standalone extension version should be used instead.

*Call graph*: calls 5 internal fn (create_image_generation_tool, create_web_search_tool, image_generation_tool_enabled, standalone_image_generation_available, standalone_web_search_enabled); called by 1 (add_tool_sources); 1 external calls (new).


##### `search_tool_enabled`  (lines 297–299)

```
fn search_tool_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Answers whether this model supports the tool-search feature. Tool search lets the model discover deferred tools instead of seeing every possible tool up front.

**Data flow**: It reads the model information in the turn context and returns a boolean yes-or-no result.

**Call relations**: Several planners use this gate before adding deferred collaboration tools, code-mode guidance for deferred tools, extension name reservations, or the search executor itself.

*Call graph*: called by 5 (built_tools, add_collaboration_tools, append_extension_tool_executors, append_tool_search_executor, build_code_mode_executors).


##### `tool_suggest_enabled`  (lines 301–306)

```
fn tool_suggest_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Answers whether plugin suggestion and installation tools should be available. It requires several feature flags to be on together.

**Data flow**: It reads the active feature set and returns true only when tool suggestion, apps, and plugins are all enabled.

**Call relations**: Core utility planning uses this before exposing tools that list installable plugins and request plugin installation. Other callers can use it to report what tools would be built.

*Call graph*: called by 2 (built_tools, add_core_utility_tools).


##### `namespace_tools_enabled`  (lines 308–310)

```
fn namespace_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether the provider supports namespace-style tools, where related tools are grouped under names like `web.run`. This matters because not every model API accepts that shape.

**Data flow**: It reads the provider capability from the turn context and returns a boolean.

**Call relations**: Tool search, standalone web search, standalone image generation, and multi-agent namespacing all depend on this check before creating namespace-based tool specs.

*Call graph*: called by 5 (add_collaboration_tools, append_extension_tool_executors, append_tool_search_executor, standalone_image_generation_model_visible, standalone_web_search_enabled).


##### `multi_agent_v2_enabled`  (lines 312–314)

```
fn multi_agent_v2_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether the session is using the version 2 multi-agent tool set. Version 2 has different tool names, timeout settings, and optional namespacing.

**Data flow**: It reads the multi-agent version in the turn context and returns true only for version 2.

**Call relations**: Collaboration planning uses this to choose between old and new sub-agent tools. Timeout planning uses it to choose between configured v2 timeout values and legacy defaults.

*Call graph*: called by 2 (add_collaboration_tools, wait_agent_timeout_options).


##### `collab_tools_enabled`  (lines 316–325)

```
fn collab_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Decides whether sub-agent collaboration tools are allowed in this turn. For version 1, it also prevents spawning agents too deeply, like stopping a chain of assistants from nesting forever.

**Data flow**: It reads the multi-agent version, session source, and configured depth limit. It returns false when collaboration is disabled or when a version 1 spawn would exceed the depth limit; version 2 is allowed directly.

**Call relations**: Collaboration tool planning calls this before adding any agent tools. Agent-job planning also depends on it, because CSV-based agent jobs are built on top of collaboration support.

*Call graph*: called by 2 (add_collaboration_tools, agent_jobs_tools_enabled); 2 external calls (exceeds_thread_spawn_depth_limit, next_thread_spawn_depth).


##### `agent_jobs_tools_enabled`  (lines 327–329)

```
fn agent_jobs_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Decides whether CSV-based agent job tools should be available. These tools let a turn spawn many sub-agent tasks from tabular input.

**Data flow**: It reads the `SpawnCsv` feature flag and the general collaboration permission. It returns true only when both are allowed.

**Call relations**: The collaboration planner uses this before adding the CSV spawning tool. The worker-tool check builds on it to decide whether a sub-agent can report a job result.

*Call graph*: calls 1 internal fn (collab_tools_enabled); called by 2 (add_collaboration_tools, agent_jobs_worker_tools_enabled).


##### `agent_jobs_worker_tools_enabled`  (lines 331–338)

```
fn agent_jobs_worker_tools_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Decides whether the current session is an agent-job worker that should be able to report a result. It looks for sub-agent sessions labeled as agent jobs.

**Data flow**: It checks that agent-job tools are enabled, then examines the session source label. It returns true only for sub-agents whose label starts with the agent-job prefix.

**Call relations**: The collaboration planner uses this to add the result-reporting tool only inside worker sub-agents, not in normal parent sessions.

*Call graph*: calls 1 internal fn (agent_jobs_tools_enabled); called by 1 (add_collaboration_tools); 1 external calls (matches!).


##### `image_generation_tool_enabled`  (lines 340–346)

```
fn image_generation_tool_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether hosted image generation should be offered as a feature. It requires both runtime support and the image-generation feature flag.

**Data flow**: It first asks whether the runtime conditions are met, then checks the feature set. It returns a boolean.

**Call relations**: Hosted tool planning uses this before adding the provider-hosted image generation spec. Standalone image generation has a separate visibility path.

*Call graph*: calls 1 internal fn (image_generation_runtime_enabled); called by 1 (hosted_model_tool_specs).


##### `image_generation_runtime_enabled`  (lines 348–358)

```
fn image_generation_runtime_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether the current session is technically able to use image generation. This includes authentication, provider support, and model support for image input.

**Data flow**: It reads the auth manager, provider capabilities, and model input modalities. It returns true only when the user is on the right backend, the provider supports image generation, and the model can work with images.

**Call relations**: Both hosted image generation and standalone image generation use this as their base safety check before exposing image-generation tools.

*Call graph*: called by 2 (image_generation_tool_enabled, standalone_image_generation_model_visible).


##### `standalone_image_generation_model_visible`  (lines 360–370)

```
fn standalone_image_generation_model_visible(turn_context: &TurnContext) -> bool
```

**Purpose**: Decides whether the standalone image-generation extension should be visible to the model. This is separate from hosted image generation.

**Data flow**: It first requires image-generation runtime support and namespace-tool support. It then allows visibility for Responses Lite models or when the image-generation extension feature flag is enabled.

**Call relations**: Extension planning uses this to decide whether to include the standalone image tool. Hosted planning uses the related availability check to avoid advertising both hosted and standalone versions unnecessarily.

*Call graph*: calls 2 internal fn (image_generation_runtime_enabled, namespace_tools_enabled); called by 2 (append_extension_tool_executors, standalone_image_generation_available).


##### `standalone_image_generation_available`  (lines 372–380)

```
fn standalone_image_generation_available(
    turn_context: &TurnContext,
    extension_tools: &[Arc<dyn ToolExecutor<ExtensionToolCall>>],
) -> bool
```

**Purpose**: Checks whether the standalone image-generation tool is both allowed and actually present among extension executors.

**Data flow**: It verifies model visibility rules, then scans extension executors for the configured `image_gen.imagegen` tool name. It returns true only when both conditions are met.

**Call relations**: Hosted tool planning calls this so it can skip hosted image generation when the standalone extension is ready and visible.

*Call graph*: calls 1 internal fn (standalone_image_generation_model_visible); called by 1 (hosted_model_tool_specs).


##### `wait_agent_timeout_options`  (lines 382–396)

```
fn wait_agent_timeout_options(turn_context: &TurnContext) -> WaitAgentTimeoutOptions
```

**Purpose**: Chooses timeout limits for waiting on sub-agents. Timeouts protect the system from waiting forever.

**Data flow**: It reads the turn context. For multi-agent v2, it returns configured default, minimum, and maximum timeouts; otherwise it returns legacy constants.

**Call relations**: The main planning setup computes this once and stores it in the planning context. Collaboration tools then use it when constructing wait-agent handlers.

*Call graph*: calls 1 internal fn (multi_agent_v2_enabled); called by 1 (build_tool_specs_and_registry).


##### `agent_type_description`  (lines 398–409)

```
fn agent_type_description(
    turn_context: &TurnContext,
    default_agent_type_description: &str,
) -> String
```

**Purpose**: Builds the text that explains what kinds of sub-agents can be spawned. If custom roles do not produce any text, it falls back to a default description.

**Data flow**: It reads configured agent roles and a prebuilt default description. It returns the custom description when available, otherwise the default string.

**Call relations**: Collaboration planning uses this when creating spawn-agent tools, so the model gets accurate guidance about available agent types.

*Call graph*: called by 1 (add_collaboration_tools); 1 external calls (build).


##### `is_hidden_by_code_mode_only`  (lines 411–421)

```
fn is_hidden_by_code_mode_only(
    turn_context: &TurnContext,
    tool_name: &ToolName,
    exposure: ToolExposure,
) -> bool
```

**Purpose**: Decides whether a tool should be hidden from the normal visible list because code mode is the only public tool surface. In that mode, nested tools are reached through code mode instead of shown separately.

**Data flow**: It reads the turn’s tool mode, the tool exposure, and the tool name translated into its code-mode form. It returns true when the tool should not be directly advertised.

**Call relations**: The final model-visible spec builder calls this while walking planned runtimes. It prevents duplicate or confusing exposure when code mode is meant to be the only direct entry point.

*Call graph*: called by 1 (build_model_visible_specs_and_registry); 2 external calls (is_code_mode_nested_tool, code_mode_name_for_tool_name).


##### `is_excluded_from_code_mode`  (lines 423–431)

```
fn is_excluded_from_code_mode(turn_context: &TurnContext, tool_name: &ToolName) -> bool
```

**Purpose**: Checks whether a tool’s namespace has been configured as excluded from code mode. This gives configuration a way to keep whole groups of tools out of code-mode nesting.

**Data flow**: It looks at the tool’s namespace, if any, and compares it with the configured excluded namespace set. It returns true for excluded namespaces and false otherwise.

**Call relations**: Code-mode executor construction and per-tool spec adjustment both call this before adding or augmenting tools for code mode.

*Call graph*: called by 2 (build_code_mode_executors, spec_for_model_request).


##### `build_code_mode_executors`  (lines 433–493)

```
fn build_code_mode_executors(
    turn_context: &TurnContext,
    executors: &[Arc<dyn CoreToolRuntime>],
) -> Vec<Arc<dyn CoreToolRuntime>>
```

**Purpose**: Builds the special executors that power code mode. Code mode is a wrapper tool that can call other tools from inside a code-oriented interface.

**Data flow**: It receives the turn context and the already planned runtimes. If the turn is not in code mode, it returns no executors. Otherwise it filters out hidden, direct-model-only, and excluded tools; collects nested tool specs; builds the code-mode tool definition; sorts the enabled nested tools; and returns the code execute and wait handlers.

**Call relations**: The code-mode prepender calls this after normal tool collection. Its output is inserted at the front of the runtime list so code mode becomes available alongside or instead of normal tools.

*Call graph*: calls 3 internal fn (code_mode_namespace_descriptions, is_excluded_from_code_mode, search_tool_enabled); called by 1 (prepend_code_mode_executors); 5 external calls (new, collect_code_mode_exec_prompt_tool_definitions, matches!, once, vec!).


##### `merge_into_namespaces`  (lines 495–539)

```
fn merge_into_namespaces(specs: Vec<ToolSpec>) -> Vec<ToolSpec>
```

**Purpose**: Combines separate namespace tool specs with the same namespace name into one group. This keeps the model request tidy and avoids repeated namespace blocks.

**Data flow**: It receives a list of tool specs. It merges namespace specs by name, preserves or fills descriptions, sorts tools inside each namespace by function name, and returns the cleaned-up list.

**Call relations**: The final visible-spec builder calls this before sending specs onward. It is especially important because tools can come from many sources but still belong to the same namespace.

*Call graph*: called by 1 (build_model_visible_specs_and_registry); 5 external calls (new, with_capacity, default_namespace_description, Namespace, unreachable!).


##### `code_mode_namespace_descriptions`  (lines 541–561)

```
fn code_mode_namespace_descriptions(
    specs: &[ToolSpec],
) -> BTreeMap<String, codex_code_mode::ToolNamespaceDescription>
```

**Purpose**: Extracts namespace descriptions from tool specs so code mode can present grouped tools clearly. Namespaces are like folders for related tools.

**Data flow**: It scans the provided specs, keeps only namespace specs, records each namespace name and description, and fills in a description when a later spec has one. It returns a map keyed by namespace name.

**Call relations**: The code-mode builder uses this map when sorting and describing nested tools inside the code-mode prompt.

*Call graph*: called by 1 (build_code_mode_executors); 1 external calls (new).


##### `add_tool_sources`  (lines 564–575)

```
fn add_tool_sources(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Collects every category of tool that might be available for the turn. It is the central checklist for tool sources.

**Data flow**: It receives the planning context and mutable planned-tools container. It calls helpers for shell, MCP resources, core utilities, collaboration, MCP runtimes, extensions, dynamic tools, and hosted provider specs, adding each allowed tool to the plan.

**Call relations**: The main planner calls this before adding search or code-mode wrappers. Each helper handles one source family so this function stays as the top-level assembly line.

*Call graph*: calls 9 internal fn (add_hosted_spec, add_collaboration_tools, add_core_utility_tools, add_dynamic_tools, add_extension_tools, add_mcp_resource_tools, add_mcp_runtime_tools, add_shell_tools, hosted_model_tool_specs); called by 1 (build_tool_specs_and_registry).


##### `standalone_web_search_enabled`  (lines 577–584)

```
fn standalone_web_search_enabled(turn_context: &TurnContext) -> bool
```

**Purpose**: Checks whether the standalone extension-style web search tool may be used. This is different from provider-hosted web search.

**Data flow**: It reads namespace-tool support, model type, and the standalone web-search feature flag. It returns true when namespace tools are supported and either Responses Lite is in use or the feature is enabled.

**Call relations**: Hosted search planning uses this to avoid adding hosted search when standalone search is available. Extension planning uses it to decide whether to keep or skip the `web.run` extension.

*Call graph*: calls 1 internal fn (namespace_tools_enabled); called by 2 (append_extension_tool_executors, hosted_model_tool_specs).


##### `add_shell_tools`  (lines 586–624)

```
fn add_shell_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds command-execution tools when the session has an execution environment. These are the tools that let the model run shell commands or write to a running process.

**Data flow**: It reads environment availability, permission settings, feature flags, shell backend choice, model preferences, and whether multiple environments are present. Depending on the configured shell type, it adds unified exec, stdin writing, legacy shell dispatch, or the standard shell command tool.

**Call relations**: The source collector calls this early. It may add a hidden legacy shell runtime so old-style calls can still be routed while the model sees the newer unified exec tool.

*Call graph*: calls 5 internal fn (new, new, add, add_dispatch_only, unified_exec_should_include_shell_parameter); called by 1 (add_tool_sources); 3 external calls (shell_command_backend_for_features, shell_type_for_model_and_features, matches!).


##### `unified_exec_should_include_shell_parameter`  (lines 626–635)

```
fn unified_exec_should_include_shell_parameter(turn_context: &TurnContext) -> bool
```

**Purpose**: Decides whether the unified exec tool should expose a shell parameter. This is needed except in a specific local zsh-fork setup unless remote environments are present.

**Data flow**: It reads the unified shell mode and the turn’s environments. It returns false only for the special local zsh-fork mode with no remote environment; otherwise it returns true.

**Call relations**: Shell planning uses this while constructing unified exec options, so the tool schema matches what the backend can safely and meaningfully accept.

*Call graph*: called by 1 (add_shell_tools); 1 external calls (matches!).


##### `add_mcp_resource_tools`  (lines 637–643)

```
fn add_mcp_resource_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds tools for browsing and reading MCP resources when MCP tools are present. MCP is a protocol that lets external servers provide tools and resources.

**Data flow**: It checks whether MCP tool information exists in the planning context. If so, it adds list-resources, list-resource-templates, and read-resource handlers to the plan.

**Call relations**: The source collector calls this before adding individual MCP runtime tools. These resource helpers give the model a way to inspect MCP-provided data.

*Call graph*: calls 1 internal fn (add); called by 1 (add_tool_sources).


##### `add_core_utility_tools`  (lines 645–710)

```
fn add_core_utility_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds built-in utility tools such as planning, permission requests, token-budget helpers, sleep, plugin installation requests, patch application, test sync, and image viewing.

**Data flow**: It reads feature flags, model abilities, environment availability, and configuration. It always adds the planning tool, then conditionally adds each utility only when the current turn supports it.

**Call relations**: The source collector calls this as the main built-in utility phase. Several of these tools are direct-model-only or environment-dependent, so this function sets the right exposure and options before final registry construction.

*Call graph*: calls 7 internal fn (new, new, new, new, add, add_with_exposure, tool_suggest_enabled); called by 1 (add_tool_sources); 4 external calls (can_request_original_image_detail, collect_request_plugin_install_entries, request_user_input_available_modes, matches!).


##### `add_collaboration_tools`  (lines 712–798)

```
fn add_collaboration_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds tools for working with sub-agents and agent jobs. These tools let the model spawn, message, wait for, interrupt, list, or close other agent sessions depending on the enabled multi-agent version.

**Data flow**: It reads collaboration eligibility, multi-agent version, namespace support, configured agent roles, available models, timeout options, and feature flags. It adds either v2 multi-agent tools, v1 multi-agent tools, CSV job spawning, and, for worker agents, result reporting.

**Call relations**: The source collector calls this after core tools. It uses many small gatekeeping helpers so agent tools appear only in sessions where they are supported and safe.

*Call graph*: calls 12 internal fn (override_tool_exposure, add, add_arc, add_with_exposure, agent_jobs_tools_enabled, agent_jobs_worker_tools_enabled, agent_type_description, collab_tools_enabled, multi_agent_v2_enabled, multi_agent_v2_handler (+2 more)); called by 1 (add_tool_sources); 4 external calls (new, new, new, new).


##### `add_mcp_runtime_tools`  (lines 800–824)

```
fn add_mcp_runtime_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds executable handlers for MCP tools supplied by external MCP servers. It also supports deferred MCP tools, which are discoverable through search rather than shown directly.

**Data flow**: It iterates over immediate and deferred MCP tool descriptions. For each one, it tries to build an `McpHandler`; successful handlers are added with normal or deferred exposure, while failures are logged and skipped.

**Call relations**: The source collector calls this after collaboration tools. Later, the search-tool builder can expose deferred MCP tools through tool search.

*Call graph*: calls 3 internal fn (new, add, add_with_exposure); called by 1 (add_tool_sources); 1 external calls (warn!).


##### `add_dynamic_tools`  (lines 826–856)

```
fn add_dynamic_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds tools that are defined dynamically at runtime rather than compiled into the program. These can be plain functions or functions inside namespaces.

**Data flow**: It walks through dynamic tool specs. For each function, it tries to create a dynamic handler; for each namespace, it creates handlers for its functions. Valid handlers are added, and conversion failures are logged.

**Call relations**: The source collector calls this after extensions. The final namespace merger may later group dynamic namespace specs with other tools in the same namespace.

*Call graph*: calls 3 internal fn (new, new_in_namespace, add); called by 1 (add_tool_sources); 1 external calls (error!).


##### `add_extension_tools`  (lines 858–866)

```
fn add_extension_tools(context: &CoreToolPlanContext<'_>, planned_tools: &mut PlannedTools)
```

**Purpose**: Adds tools provided by extensions. Extensions have already produced executors elsewhere; this function adapts them into the core runtime plan.

**Data flow**: It passes the turn context, extension executors, and planned-tools container to the lower-level appender. The plan may gain extension-backed runtimes.

**Call relations**: The source collector calls this as the extension phase. The actual filtering for duplicates, web search, and image generation happens in `append_extension_tool_executors`.

*Call graph*: calls 1 internal fn (append_extension_tool_executors); called by 1 (add_tool_sources).


##### `append_tool_search_executor`  (lines 869–890)

```
fn append_tool_search_executor(
    context: &CoreToolPlanContext<'_>,
    planned_tools: &mut PlannedTools,
)
```

**Purpose**: Adds the tool-search executor when there are deferred tools for the model to discover. This prevents the visible tool list from becoming too large while still making tools reachable.

**Data flow**: It checks that search and namespace tools are supported, then scans planned runtimes for deferred tools with search metadata. If any exist, it gets or builds a cached search handler and adds it to the plan.

**Call relations**: The main planner calls this after all normal tool sources have been added. It depends on deferred tools already being present, especially deferred collaboration or MCP tools.

*Call graph*: calls 4 internal fn (add_arc, runtimes, namespace_tools_enabled, search_tool_enabled); called by 1 (build_tool_specs_and_registry).


##### `prepend_code_mode_executors`  (lines 892–899)

```
fn prepend_code_mode_executors(
    context: &CoreToolPlanContext<'_>,
    planned_tools: &mut PlannedTools,
)
```

**Purpose**: Inserts code-mode executors at the front of the runtime list when code mode is active. Prepending makes code mode part of the planned runtime set before final specs are built.

**Data flow**: It reads current runtimes, builds any needed code-mode executors from them, and splices those executors into the beginning of the planned runtime list.

**Call relations**: The main planner calls this after search insertion. The final registry/spec builder then treats code-mode executors like other runtimes, while hiding or augmenting nested tools as needed.

*Call graph*: calls 2 internal fn (runtimes, build_code_mode_executors); called by 1 (build_tool_specs_and_registry).


##### `append_extension_tool_executors`  (lines 901–953)

```
fn append_extension_tool_executors(
    turn_context: &TurnContext,
    executors: &[Arc<dyn ToolExecutor<ExtensionToolCall>>],
    planned_tools: &mut PlannedTools,
)
```

**Purpose**: Filters and adds extension-provided tool executors while avoiding name collisions and unsupported standalone tools. It keeps the tool namespace clean.

**Data flow**: It builds a set of reserved tool names from already planned tools, plus names reserved for code mode or tool search when applicable. It then scans extension executors, skips disabled standalone web or image tools, skips duplicate names with a warning, and wraps accepted executors in an extension adapter.

**Call relations**: Extension planning calls this after built-in tools have been planned. This order lets built-in tools claim names first, so extensions cannot accidentally override core behavior.

*Call graph*: calls 9 internal fn (new, add, runtimes, namespace_tools_enabled, search_tool_enabled, standalone_image_generation_model_visible, standalone_web_search_enabled, namespaced, plain); called by 1 (add_extension_tools); 2 external calls (matches!, warn!).


##### `multi_agent_v2_handler`  (lines 955–966)

```
fn multi_agent_v2_handler(
    handler: impl CoreToolRuntime + 'static,
    namespace: Option<&str>,
) -> Arc<dyn CoreToolRuntime>
```

**Purpose**: Optionally wraps a multi-agent v2 handler so it appears under a configured namespace. This lets deployments rename or group the v2 agent tools.

**Data flow**: It receives a handler and an optional namespace. If a namespace is provided, it returns a wrapper that rewrites the tool name and spec; otherwise it returns the handler unchanged as a shared runtime.

**Call relations**: The collaboration planner uses this for every v2 multi-agent tool before applying the chosen exposure. The wrapper delegates actual execution back to the original handler.

*Call graph*: called by 1 (add_collaboration_tools); 1 external calls (new).


##### `MultiAgentV2NamespaceOverride::tool_name`  (lines 974–976)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the wrapped multi-agent tool’s name with the configured namespace applied. This changes how the tool is identified to the model and registry.

**Data flow**: It reads the configured namespace and the inner handler’s plain tool name, then produces a namespaced tool name using the same inner name.

**Call relations**: The registry and duplicate-name checks call this through the tool-executor interface. It makes the wrapper look like a namespaced tool while preserving the underlying behavior.

*Call graph*: calls 1 internal fn (namespaced).


##### `MultiAgentV2NamespaceOverride::spec`  (lines 978–987)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the wrapped multi-agent tool’s model-facing description with the configured namespace applied. If the inner tool is a plain function, it is placed inside a namespace group.

**Data flow**: It asks the inner handler for its spec. Function specs are wrapped into a namespace spec with the multi-agent description; non-function specs are returned as-is.

**Call relations**: The final visible-spec builder calls this through the runtime interface. Namespace merging may later combine this spec with other tools in the same namespace.

*Call graph*: 2 external calls (Namespace, vec!).


##### `MultiAgentV2NamespaceOverride::exposure`  (lines 989–991)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Reports the wrapped handler’s visibility setting. The wrapper does not change whether the tool is direct, hidden, or otherwise exposed.

**Data flow**: It asks the inner handler for its exposure and returns that value unchanged.

**Call relations**: The final spec builder uses this value when deciding whether the namespaced v2 tool should be shown to the model.


##### `MultiAgentV2NamespaceOverride::supports_parallel_tool_calls`  (lines 993–995)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Reports whether the wrapped handler supports being called in parallel with other tools. The namespace wrapper does not alter that execution property.

**Data flow**: It forwards the question to the inner handler and returns the same boolean answer.

**Call relations**: The tool registry can use this through the executor interface when deciding how tool calls may be scheduled.


##### `MultiAgentV2NamespaceOverride::search_info`  (lines 997–999)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Returns search metadata for the wrapped handler, if the inner handler has any. Search metadata helps the tool-search tool describe deferred tools.

**Data flow**: It asks the inner handler for optional search information and returns it unchanged.

**Call relations**: The search-executor builder can call this while scanning deferred runtimes. The namespace wrapper does not invent new search information.


##### `MultiAgentV2NamespaceOverride::handle`  (lines 1001–1003)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Runs the wrapped tool call by delegating to the original multi-agent handler. The wrapper only changes naming and specification, not execution.

**Data flow**: It receives a tool invocation and passes it straight to the inner handler. The returned future represents the eventual tool result.

**Call relations**: When the router dispatches a namespaced v2 multi-agent call, this method hands the work to the real handler that knows how to spawn, message, wait for, or list agents.


##### `MultiAgentV2NamespaceOverride::matches_kind`  (lines 1007–1009)

```
fn matches_kind(&self, payload: &crate::tools::context::ToolPayload) -> bool
```

**Purpose**: Checks whether an incoming tool payload belongs to the wrapped handler’s kind of tool call. The namespace wrapper delegates the decision.

**Data flow**: It receives a tool payload, asks the inner handler whether it matches, and returns that answer.

**Call relations**: The registry uses this as part of routing or payload matching. The wrapper keeps compatibility with the inner handler’s existing matching logic.


##### `MultiAgentV2NamespaceOverride::create_diff_consumer`  (lines 1011–1015)

```
fn create_diff_consumer(
        &self,
    ) -> Option<Box<dyn crate::tools::registry::ToolArgumentDiffConsumer>>
```

**Purpose**: Creates an optional helper for consuming streaming argument differences, if the wrapped handler supports that. This is useful for tools that process tool-call arguments as they arrive.

**Data flow**: It asks the inner handler for a diff consumer and returns the same optional object.

**Call relations**: The tool registry can call this through the core runtime interface. The namespace wrapper preserves the inner handler’s streaming behavior.


##### `compare_code_mode_tools`  (lines 1018–1030)

```
fn compare_code_mode_tools(
    left: &codex_code_mode::ToolDefinition,
    right: &codex_code_mode::ToolDefinition,
    namespace_descriptions: &BTreeMap<String, codex_code_mode::ToolNamespaceDescrip
```

**Purpose**: Defines a stable order for tools shown inside code mode. A predictable order makes generated prompts easier to read and test.

**Data flow**: It receives two code-mode tool definitions and the namespace-description map. It compares namespace names first, then underlying tool names, then displayed names, and returns their ordering.

**Call relations**: The code-mode builder uses this while sorting nested tool definitions before creating the code-mode tool spec.

*Call graph*: calls 1 internal fn (code_mode_namespace_name).


##### `code_mode_namespace_name`  (lines 1032–1041)

```
fn code_mode_namespace_name(
    tool: &codex_code_mode::ToolDefinition,
    namespace_descriptions: &'a BTreeMap<String, codex_code_mode::ToolNamespaceDescription>,
) -> Option<&'a str>
```

**Purpose**: Finds the display namespace name for a code-mode tool, if it belongs to a known namespace. This helps code-mode sorting group related tools.

**Data flow**: It reads the tool’s optional namespace and looks it up in the namespace-description map. It returns the namespace name when found, otherwise no value.

**Call relations**: The code-mode comparison helper calls this for each tool it sorts. It is a small lookup helper used only for ordering code-mode nested tools.

*Call graph*: called by 1 (compare_code_mode_tools).


### `core/src/tools/hosted_spec.rs`

`domain_logic` · `tool setup before hosted model requests`

Hosted models can be given “tools,” meaning extra capabilities outside ordinary text generation. This file is a small translator for two of those tools: image generation and web search. Without it, the system would not have a clear, consistent way to describe these abilities to the model.

For image generation, the file simply records the desired output format, such as a particular image file type, inside a tool specification.

For web search, it is more selective. It first looks at the configured search mode. If search is disabled or not set, it returns nothing, which means no web search tool should be offered. If search is cached, it allows search without live external web access. If search is live, it marks external web access as allowed. It then adds optional details from the web search configuration, such as filters, user location, and the amount of search context to request.

It also supports two web search “shapes”: text-only search, or text plus image results. In the second case it explicitly says that both text and image content may be returned. In everyday terms, this file is like filling out an order form for the model’s allowed equipment: only the tools that are permitted, and only with the settings the user asked for.

#### Function details

##### `create_image_generation_tool`  (lines 14–18)

```
fn create_image_generation_tool(output_format: &str) -> ToolSpec
```

**Purpose**: This function creates the description for an image generation tool. It is used when the system wants to let a hosted model produce images in a specific output format.

**Data flow**: It receives an output format as text. It copies that format into a new `ToolSpec::ImageGeneration` value. The result is a ready-to-use tool description; it does not change any outside state.

**Call relations**: When `hosted_model_tool_specs` is assembling the full set of tools for a hosted model, it calls this function for the image-generation case. This function returns the finished image tool description so that caller can include it with the model request.

*Call graph*: called by 1 (hosted_model_tool_specs).


##### `create_web_search_tool`  (lines 20–50)

```
fn create_web_search_tool(options: WebSearchToolOptions<'_>) -> Option<ToolSpec>
```

**Purpose**: This function creates the description for a web search tool, but only if web search is actually enabled. It also carries through the important limits and preferences, such as whether live web access is allowed and whether image results are allowed.

**Data flow**: It receives `WebSearchToolOptions`, which include the chosen search mode, optional detailed search settings, and whether the search tool should support text only or text plus images. It first turns the search mode into a simple yes/no choice for external web access; if search is disabled or missing, it stops and returns `None`. Otherwise, it gathers optional filters, location, context size, and content-type choices, then returns a `ToolSpec::WebSearch` containing those settings.

**Call relations**: When `hosted_model_tool_specs` is deciding what tools to offer a hosted model, it calls this function for web search. If the configuration says search should not be available, this function hands back nothing; if search is allowed, it hands back the complete web search tool description for inclusion in the hosted model setup.

*Call graph*: called by 1 (hosted_model_tool_specs).


### `core/src/tools/handlers/dynamic.rs`

`orchestration` · `request handling`

Dynamic tools are tools that are not built into Codex ahead of time. They are provided by the current thread, so Codex needs a safe adapter that can describe them to the model and relay calls to whoever owns the tool. This file is that adapter.

The main type, DynamicToolHandler, stores three things: the tool’s name, the tool description shown to the model, and whether the tool is available immediately or loaded later. It can create handlers for a standalone tool or for a tool inside a namespace, which is like putting related tools in a named folder.

When the model invokes a dynamic tool, the handler first checks that the call is a normal function-style tool call and parses the JSON arguments. It then calls request_dynamic_tool. That helper registers a one-time waiting slot for the response, sends a DynamicToolCallRequest event through the session, waits for a reply, and finally emits a matching response event for logging and timing. An everyday analogy is a receptionist: the handler writes down who is waiting, sends the request to the right room, waits for the answer, and records when the answer came back.

If the call is cancelled before a response arrives, the handler reports that clearly instead of pretending the tool succeeded.

#### Function details

##### `DynamicToolHandler::new`  (lines 40–42)

```
fn new(tool: &DynamicToolFunctionSpec) -> Option<Self>
```

**Purpose**: Creates a handler for a dynamic tool that is not inside a namespace. This is used when Codex is adding tools supplied by the current thread and needs to make one available to the model.

**Data flow**: It receives a dynamic tool description. It passes that description along with no namespace information into the shared builder, then returns either a ready DynamicToolHandler or nothing if the tool description cannot be converted into the internal tool format.

**Call relations**: During dynamic tool setup, add_dynamic_tools calls this for standalone tools. This function keeps that setup simple by handing the real construction work to DynamicToolHandler::from_parts.

*Call graph*: called by 1 (add_dynamic_tools); 1 external calls (from_parts).


##### `DynamicToolHandler::new_in_namespace`  (lines 44–49)

```
fn new_in_namespace(
        namespace: &DynamicToolNamespaceSpec,
        tool: &DynamicToolFunctionSpec,
    ) -> Option<Self>
```

**Purpose**: Creates a handler for a dynamic tool that belongs to a named namespace. A namespace groups tools under a shared name, like a folder label, so the model can understand where the tool comes from.

**Data flow**: It receives both the namespace description and the tool description. It forwards both to the shared builder, which creates the correct named tool identity and model-facing specification, then returns the finished handler if conversion succeeds.

**Call relations**: During dynamic tool setup, add_dynamic_tools calls this for tools that come packaged inside a namespace. It relies on DynamicToolHandler::from_parts so namespaced and non-namespaced tools are built consistently.

*Call graph*: called by 1 (add_dynamic_tools); 1 external calls (from_parts).


##### `DynamicToolHandler::from_parts`  (lines 51–81)

```
fn from_parts(
        tool: &DynamicToolFunctionSpec,
        namespace: Option<&DynamicToolNamespaceSpec>,
    ) -> Option<Self>
```

**Purpose**: Builds the actual DynamicToolHandler from a tool description and optional namespace. This is the central constructor that decides the tool’s name, its model-visible description, and whether it should be exposed immediately or deferred.

**Data flow**: It takes the raw dynamic tool definition, and possibly a namespace definition. It creates a ToolName, converts the dynamic tool into the Responses API tool format used elsewhere, wraps it either as a standalone function or inside a namespace, fills in a default namespace description if needed, and sets the exposure mode from the tool’s defer_loading flag. If conversion fails, it returns nothing.

**Call relations**: DynamicToolHandler::new and DynamicToolHandler::new_in_namespace both route through this function. The rest of the handler methods later return the name, specification, and exposure values that this function prepared.

*Call graph*: calls 1 internal fn (new); 5 external calls (default_namespace_description, dynamic_tool_to_responses_api_tool, Function, Namespace, vec!).


##### `DynamicToolHandler::tool_name`  (lines 85–87)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the stored name of this dynamic tool. Other parts of the tool system use this name to identify which tool the model is trying to call.

**Data flow**: It reads the handler’s stored ToolName and returns a copy of it. The handler itself is unchanged.

**Call relations**: This is part of the ToolExecutor interface, meaning the broader tool registry can ask any tool handler what name it represents. For dynamic tools, the value was created earlier by DynamicToolHandler::from_parts.

*Call graph*: 1 external calls (clone).


##### `DynamicToolHandler::spec`  (lines 89–91)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the model-facing tool specification. This is the description and shape of the tool that tells the model what the tool is called and what arguments it accepts.

**Data flow**: It reads the handler’s stored ToolSpec and returns a copy. Nothing else changes.

**Call relations**: The tool system calls this through the ToolExecutor interface when it needs to present available tools. DynamicToolHandler::search_info also calls it to build searchable metadata for this tool.

*Call graph*: called by 1 (search_info); 1 external calls (clone).


##### `DynamicToolHandler::exposure`  (lines 93–95)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Reports whether the dynamic tool should be shown directly or treated as deferred. Deferred means the tool exists but may be loaded or surfaced later instead of being immediately available.

**Data flow**: It reads the exposure value saved in the handler and returns it. The handler is not modified.

**Call relations**: This is another part of the ToolExecutor interface. The value comes from DynamicToolHandler::from_parts, which bases it on the dynamic tool’s defer_loading setting.


##### `DynamicToolHandler::search_info`  (lines 97–105)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Creates search metadata for this dynamic tool so it can be discovered or described as part of the current thread’s available tools. It labels the source as “Dynamic tools” and explains that they come from the current Codex thread.

**Data flow**: It asks the handler for its ToolSpec, combines that with a source name and description, and returns optional ToolSearchInfo. If the specification cannot produce search information, the result is empty.

**Call relations**: The wider tool system calls this when building searchable tool listings. It uses DynamicToolHandler::spec rather than reading the stored field directly, keeping it aligned with the standard ToolExecutor behavior.

*Call graph*: calls 2 internal fn (spec, from_tool_spec).


##### `DynamicToolHandler::handle`  (lines 107–109)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts execution of a dynamic tool call in the async tool system. It wraps the real work in a future, which is a promise that the result will be available later.

**Data flow**: It receives a ToolInvocation containing the session, turn, call id, and payload. It passes that invocation to DynamicToolHandler::handle_call and returns a pinned future so the executor can await it safely.

**Call relations**: The tool runtime calls this when the model invokes the dynamic tool. This function is the standard ToolExecutor entry point and immediately delegates to DynamicToolHandler::handle_call for the actual request-and-response flow.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `DynamicToolHandler::handle_call`  (lines 113–161)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs one dynamic tool invocation from the model’s point of view. It validates the call, parses the arguments, sends the request to the dynamic tool provider, and turns the provider’s answer into normal tool output.

**Data flow**: It receives a ToolInvocation. It extracts the session, turn context, call id, and payload. If the payload is not a function-style call, it returns an error message for the model. Otherwise it parses the argument string as JSON, calls request_dynamic_tool with the session details and tool name, waits for a DynamicToolResponse, converts returned content items into function-call output items, and returns boxed tool output with the success flag. If the response never arrives, it returns a clear cancellation error.

**Call relations**: DynamicToolHandler::handle calls this whenever the model invokes the tool. This function then hands the cross-thread request work to request_dynamic_tool and packages that result back into the common output format used by the rest of the tool system.

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

**Purpose**: Sends a dynamic tool call request through the active session and waits for the matching response. It also records a response event afterward, including timing and error information, so the conversation history has both sides of the tool call.

**Data flow**: It receives the session, turn context, call id, tool name, and parsed JSON arguments. It splits the tool name into namespace and tool parts, creates a one-time response channel, registers that channel in the active turn state under the call id, sends a DynamicToolCallRequest event, and waits for the response channel to receive a DynamicToolResponse. Then it sends a DynamicToolCallResponse event: either with returned content and success status, or with an error message if the waiting channel was cancelled. It returns the response if one arrived, or nothing if it did not.

**Call relations**: DynamicToolHandler::handle_call calls this after parsing the model’s arguments. The session’s event system carries the request to the outside dynamic tool provider, and some other part of the active turn later uses the registered pending call id to deliver the response back through the one-time channel.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (handle_call); 8 external calls (now, clone, new, send_event, channel, DynamicToolCallRequest, DynamicToolCallResponse, warn!).


### `tools/src/dynamic_tool.rs`

`domain_logic` · `tool loading`

Dynamic tools are tools whose details are not hard-coded ahead of time. Instead, another part of the system provides a description of the tool: its name, what it does, what input shape it expects, and whether it should be loaded later instead of right away. This file takes that outside-facing description and converts it into a `ToolDefinition`, which is the internal record used by the tools subsystem.

The main job here is careful translation. Most fields are copied across directly, such as the tool name and description. The input schema needs extra work: a schema is a machine-readable description of what inputs are allowed, like a form template that says which fields exist and what kind of values they accept. This file delegates that conversion to `parse_tool_input_schema`, so invalid schema data can be rejected cleanly. If that parsing fails, the error is returned to the caller instead of creating a broken tool definition.

One notable detail is that dynamic tools created here do not get an output schema; `output_schema` is always set to `None`. In other words, this conversion currently records what the tool accepts as input, but not a formal description of what it returns.

#### Function details

##### `parse_dynamic_tool`  (lines 5–15)

```
fn parse_dynamic_tool(
    tool: &DynamicToolFunctionSpec,
) -> Result<ToolDefinition, serde_json::Error>
```

**Purpose**: Converts a protocol-level dynamic tool description into the internal `ToolDefinition` used by the tools system. Someone would use this when a tool is discovered or supplied at runtime and needs to be made usable by the rest of the project.

**Data flow**: It receives a `DynamicToolFunctionSpec`, which contains the tool’s public details. It copies the name and description, parses the input schema into the internal expected format, leaves the output schema empty, and preserves the deferred-loading flag. If the input schema cannot be parsed, it returns a JSON parsing error instead of a tool definition.

**Call relations**: When dynamic tool information needs to become a real internal tool definition, this function is the conversion point. During that conversion it calls `parse_tool_input_schema` to do the specialized work of understanding the tool’s input schema, then wraps the parsed result together with the other copied fields.

*Call graph*: 1 external calls (parse_tool_input_schema).


### `tools/src/tool_search.rs`

`domain_logic` · `tool loading and search indexing`

This file is about making tools discoverable. A tool may be a single function, or it may be a namespace, which is a named group of related functions. To search those tools well, the system needs a plain text summary containing the words a user or model might look for. This file builds that summary from visible metadata: tool names, descriptions, parameter names, and parameter descriptions.

It also changes the tool definition before storing it as a search result. For function tools, it marks them for deferred loading, meaning the full details can be fetched only if needed, like keeping a catalog card instead of carrying the whole manual. It removes output schemas from these lightweight entries, which keeps search results smaller. For namespaces, it does the same for every function inside the namespace, and fills in a default namespace description if the original one is blank.

Not every tool type is suitable as a searchable, loadable tool entry here. Built-in search tools, image generation tools, web search tools, and freeform tools can contribute text for matching in some cases, but this file does not turn them into `ToolSearchInfo` outputs. The result is a compact search record: text to search against, the trimmed-down tool to return if matched, and optional information about where the tool came from.

#### Function details

##### `ToolSearchInfo::from_tool_spec`  (lines 22–28)

```
fn from_tool_spec(
        spec: ToolSpec,
        source_info: Option<ToolSearchSourceInfo>,
    ) -> Option<Self>
```

**Purpose**: This is the convenient entry point for turning a normal tool definition into a searchable tool record. It first creates the default search text from the tool's visible metadata, then asks the lower-level builder to package the tool for search.

**Data flow**: It receives a `ToolSpec`, which is the system's description of a tool, plus optional source information saying where that tool came from. It reads the tool's names, descriptions, and schema text to make one search string, then passes that string and the original tool into `ToolSearchInfo::from_spec`. The result is either a finished `ToolSearchInfo` or nothing if this kind of tool should not become a loadable search entry.

**Call relations**: Higher-level code such as `search_info` calls this when it has a tool definition and wants the usual search text generated automatically. It relies on `default_tool_search_text` to gather searchable words, then hands off to `ToolSearchInfo::from_spec` to do the actual packaging and filtering.

*Call graph*: calls 1 internal fn (default_tool_search_text); called by 3 (search_info, search_info, default_search_text_uses_model_visible_namespace_metadata_once); 1 external calls (from_spec).


##### `ToolSearchInfo::from_spec`  (lines 30–65)

```
fn from_spec(
        search_text: String,
        spec: ToolSpec,
        source_info: Option<ToolSearchSourceInfo>,
    ) -> Option<Self>
```

**Purpose**: This builds a searchable tool record when the caller already has the search text. It also trims and adjusts the tool definition so it is safe and lightweight to return from search.

**Data flow**: It receives search text, a tool definition, and optional source information. If the tool is a single function, it marks that function for deferred loading and removes its output schema. If the tool is a namespace, it fills in a default description when needed, then marks each function inside for deferred loading and removes each output schema. It returns a `ToolSearchInfo` containing the search text, the prepared tool output, and the source information. If the input is a tool type this file does not package for deferred loading, it returns nothing.

**Call relations**: `ToolSearchInfo::from_tool_spec` calls this after generating default text, while other code such as `multi_agent_tool_search_info` can call it directly when it wants to provide custom search text. Inside, it uses the project’s default namespace description helper when a namespace has no useful description, then wraps the prepared result as either a function or namespace loadable tool.

*Call graph*: called by 2 (search_info, multi_agent_tool_search_info); 3 external calls (default_namespace_description, Function, Namespace).


##### `default_tool_search_text`  (lines 68–98)

```
fn default_tool_search_text(spec: &ToolSpec) -> String
```

**Purpose**: This creates the default text used to match a search query against a tool. It collects the words that best describe the tool, such as names, descriptions, parameter names, and parameter descriptions.

**Data flow**: It receives a tool definition and starts with an empty list of text pieces. For a function, it asks `append_function_search_text` to add function-specific words. For a namespace, it adds the namespace name and description, then adds text for every function in the namespace. For special tool types, it adds the most relevant description or fixed phrase, such as "web search" or "image generation". Empty pieces are ignored, and the remaining pieces are joined into one space-separated string.

**Call relations**: `ToolSearchInfo::from_tool_spec` calls this when no custom search text was supplied. It coordinates the smaller helpers: `push_search_part` keeps the text clean, and `append_function_search_text` digs into function details.

*Call graph*: calls 2 internal fn (append_function_search_text, push_search_part); called by 1 (from_tool_spec); 1 external calls (new).


##### `append_function_search_text`  (lines 100–105)

```
fn append_function_search_text(tool: &ResponsesApiTool, parts: &mut Vec<String>)
```

**Purpose**: This adds the searchable words for one function-style tool. It includes both the exact function name and a more human-looking version where underscores become spaces, so a name like `get_weather` can match words like "get weather."

**Data flow**: It receives a function tool and a growing list of text pieces. It adds the function name, the underscore-separated name converted into normal words, and the function description. Then it looks through the function's parameter schema, which describes the inputs the function accepts, and adds searchable text from there too. It changes the provided list in place and does not return a separate value.

**Call relations**: `default_tool_search_text` calls this for standalone functions and for each function inside a namespace. This helper then delegates schema details to `append_schema_search_text`, while using `push_search_part` to avoid adding blank text.

*Call graph*: calls 2 internal fn (append_schema_search_text, push_search_part); called by 1 (default_tool_search_text).


##### `append_schema_search_text`  (lines 107–125)

```
fn append_schema_search_text(schema: &JsonSchema, parts: &mut Vec<String>)
```

**Purpose**: This pulls searchable words out of a JSON schema, which is a structured description of what input data a tool accepts. This helps searches match not only a tool's title, but also the names and descriptions of its input fields.

**Data flow**: It receives a schema and the shared list of text pieces. It adds the schema's description if present. If the schema has named properties, it adds each property name and then examines that property's schema too. If the schema describes array items, it examines the item schema. If the schema offers several allowed shapes through `any_of`, it examines each variant. The result is a fuller list of search words built by walking through nested input descriptions.

**Call relations**: `append_function_search_text` calls this when it reaches a function's parameters. The function is recursive, meaning it calls the same kind of logic on nested schemas so deeply nested input fields are still searchable. It uses `push_search_part` whenever it finds a possible text fragment.

*Call graph*: calls 1 internal fn (push_search_part); called by 1 (append_function_search_text).


##### `push_search_part`  (lines 127–132)

```
fn push_search_part(parts: &mut Vec<String>, part: String)
```

**Purpose**: This small helper adds one piece of text to the search-text list only if it contains real content. It prevents stray spaces and blank descriptions from polluting the final search string.

**Data flow**: It receives the growing list of search text pieces and one candidate string. It trims whitespace from the candidate, checks whether anything is left, and appends the cleaned text only when it is not empty. It updates the list in place and returns no value.

**Call relations**: `default_tool_search_text`, `append_function_search_text`, and `append_schema_search_text` all use this whenever they want to add a possible search phrase. It acts like a small quality gate so the rest of the file can collect text freely without worrying about blank values.

*Call graph*: called by 3 (append_function_search_text, append_schema_search_text, default_tool_search_text).


### `core/src/tools/handlers/extension_tools.rs`

`orchestration` · `tool invocation and turn event publication`

Extensions live outside the core system, but the core tool registry expects tools to follow its own shape. This file is the adapter between those two worlds. It is like a travel plug: the extension tool keeps its own interface, while the core sees something it knows how to call.

The main wrapper is `ExtensionToolAdapter`. Most of its methods simply ask the wrapped extension executor for its name, specification, visibility, and search metadata. The important step happens when a tool is actually run. The adapter turns a core `ToolInvocation` into an extension-facing `ToolCall`. That new call includes the turn id, call id, model name, tool payload, conversation history, and the available working environments.

While building the environment list, the file also applies any sandbox permissions granted for this turn. A sandbox is a safety boundary around file access. This matters because extensions need enough context to work, but they should not silently receive broader file access than the core intended.

The file also defines `CoreTurnItemEmitter`, which extensions use to announce started and completed turn items. Completed items are finalized by core before publication, so image outputs can be saved in the expected place and extension contributors can add their data. Tests verify the adapter, event emission, permission-scoped environment data, and image finalization behavior.

#### Function details

##### `ExtensionToolAdapter::new`  (lines 29–31)

```
fn new(executor: Arc<dyn codex_tools::ToolExecutor<ExtensionToolCall>>) -> Self
```

**Purpose**: Creates a core-facing wrapper around an extension-provided tool executor. This is used when extension tools are added to the core tool registry.

**Data flow**: It receives a shared pointer to an extension executor. It stores that executor inside `ExtensionToolAdapter`, so later core code can call it through the normal core tool interface. The result is the adapter object.

**Call relations**: It is used by tests that build sample extension tools, and by `append_extension_tool_executors` when real extension executors are attached to the core registry.

*Call graph*: called by 4 (exposes_generic_hook_payloads, image_generation_publication_is_finalized_by_core, passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call, append_extension_tool_executors).


##### `ExtensionToolAdapter::tool_name`  (lines 35–37)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the tool name that the wrapped extension executor declares. The core uses this name to identify which tool is being called.

**Data flow**: It reads no new data of its own. It asks the stored extension executor for its tool name and returns that value unchanged.

**Call relations**: No direct caller is shown in the graph, because this is part of the shared tool executor interface. In practice, the tool registry asks for this when cataloging or matching tools.


##### `ExtensionToolAdapter::spec`  (lines 39–41)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the public description of the extension tool, including its expected input shape. The model and the core use this specification to know how the tool can be called.

**Data flow**: It asks the wrapped extension executor for its specification and passes the answer back without changing it.

**Call relations**: No direct caller is shown in the graph, but this method is part of the tool executor contract used when the core exposes tools.


##### `ExtensionToolAdapter::exposure`  (lines 43–45)

```
fn exposure(&self) -> crate::tools::registry::ToolExposure
```

**Purpose**: Reports how the extension tool should be exposed to the rest of the system. This helps decide whether and how the tool is available for use.

**Data flow**: It reads the exposure setting from the wrapped extension executor and returns it unchanged.

**Call relations**: No direct caller is shown in the graph. It exists so the core registry can treat extension tools like any other registered tool.


##### `ExtensionToolAdapter::supports_parallel_tool_calls`  (lines 47–49)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Says whether this extension tool can safely run at the same time as other tool calls. This prevents unsafe parallel work when a tool is not designed for it.

**Data flow**: It asks the wrapped extension executor whether parallel calls are supported and returns that boolean answer.

**Call relations**: No direct caller is shown in the graph. It is part of the executor interface that the core runtime can consult before scheduling tool work.


##### `ExtensionToolAdapter::search_info`  (lines 51–53)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Returns optional search-related metadata for the extension tool. This lets tools that can be discovered or used through search describe that capability.

**Data flow**: It requests search information from the wrapped extension executor. If the executor has none, the result is empty; otherwise the metadata is returned unchanged.

**Call relations**: No direct caller is shown in the graph. It is a passthrough hook for core registry and discovery behavior.


##### `ExtensionToolAdapter::handle`  (lines 55–57)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Runs an extension tool from a core tool invocation. This is the main bridge from core execution into extension execution.

**Data flow**: It receives a `ToolInvocation` from the core. It first converts that invocation into an extension `ToolCall` with `to_extension_call`, then gives that call to the wrapped extension executor. The result is the extension tool's output or error.

**Call relations**: When the core asks the adapter to run a tool, this method calls `to_extension_call` to translate the request, then hands the translated call to the extension executor.

*Call graph*: calls 1 internal fn (to_extension_call); 1 external calls (pin).


##### `ExtensionToolAdapter::matches_kind`  (lines 61–63)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Checks whether this adapter should accept a given tool payload. Extension tools here are only matched to normal function-style tool calls.

**Data flow**: It receives a core `ToolPayload`. It checks whether the payload is the `Function` variant and returns true only in that case.

**Call relations**: This is part of the `CoreToolRuntime` interface. The graph shows it using a match check; registry code can use it to avoid sending unsupported payload kinds to extension tools.

*Call graph*: 1 external calls (matches!).


##### `extension_turn_item`  (lines 71–79)

```
fn extension_turn_item(item: ExtensionTurnItem) -> TurnItem
```

**Purpose**: Converts an extension turn item into the core protocol's turn item format. It also prevents extensions from directly claiming a saved image path.

**Data flow**: It receives an `ExtensionTurnItem`. Web search items are wrapped as core web search items. Image generation items are wrapped too, but their `saved_path` is cleared first so the core can decide where saved image artifacts belong.

**Call relations**: Both `CoreTurnItemEmitter::emit_started` and `CoreTurnItemEmitter::emit_completed` call this before publishing extension-created turn items through the core session.

*Call graph*: called by 2 (emit_completed, emit_started); 2 external calls (ImageGeneration, WebSearch).


##### `CoreTurnItemEmitter::emit_started`  (lines 82–91)

```
fn emit_started(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Publishes a 'this item has started' event from an extension tool into the core session. This lets users see progress such as a web search beginning.

**Data flow**: It receives an extension turn item. It tries to upgrade weak references to the live session and turn; if either has already gone away, it does nothing. Otherwise it converts the item to a core turn item and asks the session to emit the started event.

**Call relations**: Extension tools call this through the `TurnItemEmitter` they receive in their tool call. It uses `extension_turn_item` before handing the event to the session.

*Call graph*: calls 1 internal fn (extension_turn_item); 2 external calls (pin, upgrade).


##### `CoreTurnItemEmitter::emit_completed`  (lines 93–109)

```
fn emit_completed(&'a self, item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Publishes a 'this item has completed' event from an extension tool, after core has had a chance to finish and normalize the item. This is important for things like saving generated images and running extension contributors.

**Data flow**: It receives an extension turn item and upgrades weak session and turn references. If the session or turn is gone, it exits quietly. Otherwise it converts the item, finalizes it with core rules and extension contributor data, then emits the completed item through the session.

**Call relations**: Extension tools call this through their emitter. It calls `extension_turn_item` for conversion and `finalize_turn_item` before publication, using the turn's extension data through the `Run` contributor policy.

*Call graph*: calls 2 internal fn (finalize_turn_item, extension_turn_item); 3 external calls (pin, upgrade, Run).


##### `to_extension_call`  (lines 112–155)

```
async fn to_extension_call(invocation: &ToolInvocation) -> ExtensionToolCall
```

**Purpose**: Builds the extension-facing call object from the core's tool invocation. This is where the extension receives the context it needs without bypassing core safety rules.

**Data flow**: It reads the invocation's session history, turn information, environments, model name, call id, tool name, payload, and sandbox settings. For each usable environment, it applies turn-granted permissions, builds a filesystem sandbox context, and packages that into a `ToolEnvironment`. It returns a complete extension `ToolCall` with a `CoreTurnItemEmitter` attached.

**Call relations**: `ExtensionToolAdapter::handle` calls this before invoking the wrapped extension executor. It calls `apply_granted_turn_permissions` so extension environments reflect permissions granted during the current turn.

*Call graph*: calls 2 internal fn (apply_granted_turn_permissions, new); called by 1 (handle); 3 external calls (downgrade, new, with_capacity).


##### `tests::StubExtensionExecutor::tool_name`  (lines 190–192)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Provides a fixed tool name for a simple test extension executor. The name lets tests treat it like a real registered extension tool.

**Data flow**: It takes no input beyond the test executor. It returns the plain tool name `extension_echo`.

**Call relations**: This supports `tests::exposes_generic_hook_payloads`, where the adapter is checked against a basic extension tool.

*Call graph*: calls 1 internal fn (plain).


##### `tests::StubExtensionExecutor::spec`  (lines 194–211)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Defines the test tool's input contract: an object with a required string message. This lets the test verify that extension tool metadata can pass through the adapter.

**Data flow**: It builds a JSON schema, parses it into the tool schema format, and returns a function-style tool specification named `extension_echo`.

**Call relations**: It belongs to the stub executor used by `tests::exposes_generic_hook_payloads`.

*Call graph*: 3 external calls (parse_tool_input_schema, json!, Function).


##### `tests::StubExtensionExecutor::handle`  (lines 213–220)

```
fn handle(&self, _call: codex_tools::ToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Returns a simple successful JSON result for the stub extension tool. It lets tests focus on adapter behavior rather than tool logic.

**Data flow**: It ignores the incoming tool call. It asynchronously returns a boxed JSON output containing `{ "ok": true }`.

**Call relations**: This is the stub executor's run method. The adapter can call it through normal extension execution when the test invokes the tool.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, pin, json!).


##### `tests::CapturingExtensionExecutor::tool_name`  (lines 228–230)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Provides the fixed name for a test executor that records the call it receives. The name is used to make the test invocation match the executor.

**Data flow**: It receives no call-specific data. It returns the plain tool name `extension_echo`.

**Call relations**: This supports `tests::passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call`, which checks exactly what the adapter passes into the extension.

*Call graph*: calls 1 internal fn (plain).


##### `tests::CapturingExtensionExecutor::spec`  (lines 232–241)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Defines a loose function-style specification for the capturing test tool. The exact schema is unimportant because the test is about captured call context.

**Data flow**: It creates a function tool specification with default JSON schema settings and returns it.

**Call relations**: It is part of the capturing executor used by the adapter conversion test.

*Call graph*: 2 external calls (default, Function).


##### `tests::CapturingExtensionExecutor::handle`  (lines 243–245)

```
fn handle(&self, call: codex_tools::ToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the asynchronous work for the capturing test executor. It delegates to `handle_call`, where the call is actually inspected and recorded.

**Data flow**: It receives an extension `ToolCall`, wraps the future returned by `handle_call`, and returns that future to the caller.

**Call relations**: When the adapter runs this test executor, this method calls `tests::CapturingExtensionExecutor::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `tests::CapturingExtensionExecutor::handle_call`  (lines 249–268)

```
async fn handle_call(
            &self,
            call: codex_tools::ToolCall,
        ) -> Result<Box<dyn codex_tools::ToolOutput>, codex_tools::FunctionCallError>
```

**Purpose**: Records the extension call produced by the adapter and emits sample web search events. This proves that extension calls include the right fields and that the emitter routes events through core.

**Data flow**: It receives a tool call. It creates a web search turn item using the call id, emits started and completed events through the call's emitter, stores the whole call in a shared test slot, and returns `{ "ok": true }`.

**Call relations**: `tests::CapturingExtensionExecutor::handle` calls this. The larger test then reads the captured call and session events to verify adapter conversion and event emission.

*Call graph*: calls 1 internal fn (new); called by 1 (handle); 3 external calls (new, json!, WebSearch).


##### `tests::exposes_generic_hook_payloads`  (lines 272–305)

```
async fn exposes_generic_hook_payloads()
```

**Purpose**: Checks that extension tools produce the normal pre-tool and post-tool hook payloads. Hooks are callbacks that can inspect tool use before or after it happens.

**Data flow**: It builds a stub extension adapter, creates a fake session and turn, prepares a function payload, and asks the core runtime for pre-use and post-use payloads. It compares the results with the expected tool name, input JSON, call id, and output JSON.

**Call relations**: This test constructs the adapter with `ExtensionToolAdapter::new` and uses the stub executor methods to confirm extension tools behave like core tools for hook reporting.

*Call graph*: calls 5 internal fn (make_session_and_context, new, new, plain, new); 5 external calls (new, assert_eq!, json!, new, new).


##### `tests::passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call`  (lines 308–426)

```
async fn passes_turn_fields_and_scoped_turn_item_emitter_to_extension_call()
```

**Purpose**: Verifies that the adapter passes the right turn information, conversation history, sandbox context, payload, and event emitter to an extension tool. It also checks that the emitter does not keep the session or turn alive forever.

**Data flow**: It creates a session with an event receiver, records one history item, builds a tool invocation, and runs the adapter. Then it inspects the captured extension call and the emitted events to make sure all fields and web search events match expectations.

**Call relations**: This test uses `ExtensionToolAdapter::new` with `tests::CapturingExtensionExecutor`. That executor emits events and captures the translated call, allowing the test to validate `to_extension_call`, `emit_started`, and `emit_completed` together.

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

**Purpose**: Marks that a turn item contributor ran during a test. A contributor is extension code that can add information to a completed turn item before it is published.

**Data flow**: It receives thread-level extension data, turn-level extension data, and a mutable turn item. It ignores the thread data and item, inserts a marker into the turn data, and returns success.

**Call relations**: `tests::extension_completion_runs_turn_item_contributors` registers this contributor, then calls the core emitter's completion path to prove `finalize_turn_item` invokes it.

*Call graph*: calls 1 internal fn (insert); 1 external calls (pin).


##### `tests::extension_completion_runs_turn_item_contributors`  (lines 450–477)

```
async fn extension_completion_runs_turn_item_contributors()
```

**Purpose**: Checks that completed extension turn items go through core finalization and run registered turn item contributors. Without this, extension-provided metadata could be skipped.

**Data flow**: It creates a session and turn, registers a contributor that writes a marker, builds a `CoreTurnItemEmitter`, and emits a completed web search item. It then checks that the marker was written into the turn's extension data.

**Call relations**: This test calls the emitter's `emit_completed` path directly. That path calls `finalize_turn_item`, which should trigger the registered contributor.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 5 external calls (downgrade, new, assert!, WebSearch, emit_completed).


##### `tests::ImageGenerationExtensionExecutor::tool_name`  (lines 480–482)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Provides a namespaced test tool name for image generation. The namespace shows that extension tools can use grouped names rather than only plain names.

**Data flow**: It takes no call data and returns the namespaced tool name `image_gen/imagegen`.

**Call relations**: This supports `tests::image_generation_publication_is_finalized_by_core`, where a simulated image-generation extension is run through the adapter.

*Call graph*: calls 1 internal fn (namespaced).


##### `tests::ImageGenerationExtensionExecutor::spec`  (lines 484–493)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Defines a basic function-style specification for the test image generation extension. The schema is minimal because the test focuses on published image items.

**Data flow**: It creates a function tool specification named `imagegen` with a default JSON schema and returns it.

**Call relations**: It is part of the image generation test executor used by the image finalization test.

*Call graph*: 2 external calls (default, Function).


##### `tests::ImageGenerationExtensionExecutor::handle`  (lines 495–497)

```
fn handle(&self, call: codex_tools::ToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the asynchronous image generation test work. It delegates to `handle_call`, where started and completed image events are emitted.

**Data flow**: It receives an extension tool call, wraps the future from `handle_call`, and returns that future.

**Call relations**: When the adapter runs the image generation test executor, this method calls `tests::ImageGenerationExtensionExecutor::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `tests::ImageGenerationExtensionExecutor::handle_call`  (lines 501–531)

```
async fn handle_call(
            &self,
            call: codex_tools::ToolCall,
        ) -> Result<Box<dyn codex_tools::ToolOutput>, codex_tools::FunctionCallError>
```

**Purpose**: Simulates an extension that reports image generation progress and completion. It deliberately supplies a saved path on completion so the test can prove core replaces it with the official artifact path.

**Data flow**: It receives a tool call. It emits an in-progress image item, then emits a completed image item containing base64-like result data and an extension-claimed path. It returns `{ "ok": true }`.

**Call relations**: `tests::ImageGenerationExtensionExecutor::handle` calls this. The finalization test then checks that `CoreTurnItemEmitter::emit_completed` lets core save the image artifact and set the final path.

*Call graph*: calls 1 internal fn (new); called by 1 (handle); 5 external calls (new, new, test_path_buf, json!, ImageGeneration).


##### `tests::image_generation_publication_is_finalized_by_core`  (lines 535–603)

```
async fn image_generation_publication_is_finalized_by_core()
```

**Purpose**: Verifies that image generation items from extensions are finalized by core before users see them. In particular, core saves the generated artifact and sets the trusted saved path.

**Data flow**: It builds an image generation extension adapter, computes the expected artifact path, runs a tool invocation, and reads the emitted events. It checks the started item, completed item, legacy begin/end events, final saved path, and actual bytes written to disk.

**Call relations**: This test uses `ExtensionToolAdapter::new` with `tests::ImageGenerationExtensionExecutor`. The executor emits image turn items, and the test confirms the adapter and `CoreTurnItemEmitter::emit_completed` route them through core finalization.

*Call graph*: calls 5 internal fn (make_session_and_context_with_rx, image_generation_artifact_path, new, new, namespaced); 7 external calls (new, assert!, assert_eq!, panic!, new, new, handle).


### `core/src/tools/handlers/tool_search.rs`

`domain_logic` · `request handling and tool registry updates`

When many tools are available, sending every full tool definition up front can be wasteful and confusing. This file provides a “tool search” tool: the model can ask for tools related to a query, and the system returns only the matching tool definitions that can then be loaded. Think of it like a catalog desk in a large hardware store: instead of walking every aisle, you describe what you need and get pointed to the right items.

The main type, ToolSearchHandler, keeps three things together: the searchable information for each tool, the public specification for the search tool itself, and a BM25 search engine. BM25 is a common text-search scoring method that ranks documents by how well their words match a query. Each tool’s search text becomes one searchable document, and the document id points back to the original tool entry.

When the search tool is called, the handler checks that the request really is a tool-search request, rejects an empty query or a zero limit with a message the model can fix, and then searches the index. The results are converted into loadable tool specs. If several results belong to the same namespace, they are combined so the output is tidy and valid.

ToolSearchHandlerCache wraps the handler in a mutex, which is a lock that prevents two threads from changing the cached value at the same time. It reuses the existing handler when the tool list has not changed, and rebuilds it when it has.

#### Function details

##### `ToolSearchHandlerCache::get_or_build`  (lines 36–56)

```
fn get_or_build(&self, search_infos: Vec<ToolSearchInfo>) -> Arc<ToolSearchHandler>
```

**Purpose**: Returns a shared ToolSearchHandler for a given list of searchable tools. It avoids rebuilding the search index when the list is the same as the one already cached.

**Data flow**: It receives a list of ToolSearchInfo records. It first looks inside the cache; if the cached handler was built from the same list, it returns another shared pointer to that handler. If not, it builds a new ToolSearchHandler, checks the cache once more in case another thread already built the same thing, then stores and returns the new handler.

**Call relations**: This is the front door for code that needs a tool-search handler. It calls ToolSearchHandlerCache::cached to safely read or update the stored handler, and it calls ToolSearchHandler::new when the old handler is missing or out of date.

*Call graph*: calls 2 internal fn (new, cached); 2 external calls (clone, new).


##### `ToolSearchHandlerCache::cached`  (lines 58–63)

```
fn cached(&self) -> std::sync::MutexGuard<'_, Option<Arc<ToolSearchHandler>>>
```

**Purpose**: Safely opens the cache so code can read or replace the stored handler. It also recovers if another thread previously panicked while holding the lock.

**Data flow**: It reads the mutex-protected cache field and returns a guard, which is temporary access to the cached Option value. If the lock is poisoned, meaning a previous holder panicked, it still takes the contained value so the program can continue.

**Call relations**: ToolSearchHandlerCache::get_or_build uses this helper whenever it needs to inspect or update the cached handler. Keeping the lock behavior here makes the caching code simpler and consistent.

*Call graph*: called by 1 (get_or_build).


##### `ToolSearchHandler::new`  (lines 67–87)

```
fn new(search_infos: Vec<ToolSearchInfo>) -> Self
```

**Purpose**: Builds a fresh search handler from the current set of searchable tools. This prepares both the public search-tool description and the text index used to find matching tools quickly.

**Data flow**: It receives ToolSearchInfo records. From them it gathers source information for the search tool’s own spec, turns each tool’s search text into a numbered BM25 document, builds an English-language search engine, and stores all of that in a ToolSearchHandler.

**Call relations**: ToolSearchHandlerCache::get_or_build calls this when the cached handler cannot be reused. The test tests::mixed_search_results_coalesce_mcp_namespaces also builds a handler directly so it can check how search results are converted into output specs.

*Call graph*: calls 1 internal fn (create_tool_search_tool); called by 2 (get_or_build, mixed_search_results_coalesce_mcp_namespaces); 1 external calls (with_documents).


##### `ToolSearchHandler::tool_name`  (lines 91–93)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the name of this tool-search tool to the tool registry. The registry uses this name to route incoming tool calls to the right handler.

**Data flow**: It takes no outside input beyond the handler itself. It wraps the constant tool-search name in a ToolName value and returns it.

**Call relations**: This is part of the ToolExecutor interface, which lets ToolSearchHandler participate like any other executable tool. When the broader tool system asks what this executor is called, this function supplies the answer.

*Call graph*: calls 1 internal fn (plain).


##### `ToolSearchHandler::spec`  (lines 95–97)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the tool specification that describes how the model should call the search tool. This includes the shape of the arguments, such as query text and optional result limit.

**Data flow**: It reads the stored ToolSpec from the handler, clones it, and returns the copy. The handler keeps its own copy so callers cannot accidentally change it.

**Call relations**: This is part of the ToolExecutor interface. The tool registry or model-facing layer asks for this spec when it needs to advertise the search tool.

*Call graph*: 1 external calls (clone).


##### `ToolSearchHandler::supports_parallel_tool_calls`  (lines 99–101)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: States that this search tool can safely run at the same time as other tool calls. Searching the already-built index does not mutate shared state.

**Data flow**: It takes no additional input and always returns true.

**Call relations**: This is part of the ToolExecutor interface. The runtime can use this answer when deciding whether it is allowed to execute tool calls concurrently.


##### `ToolSearchHandler::handle`  (lines 103–105)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing an incoming invocation of the tool-search tool. It adapts the async work into the future type expected by the tool runtime.

**Data flow**: It receives a ToolInvocation, passes it into ToolSearchHandler::handle_call, boxes and pins the resulting future, and returns that future to the caller. Pinning means the future will stay in a stable memory location while it runs.

**Call relations**: The tool runtime calls this through the ToolExecutor interface when the model invokes the search tool. It immediately hands the real validation and search work to ToolSearchHandler::handle_call.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ToolSearchHandler::handle_call`  (lines 109–145)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates a tool-search request, runs the search, and packages the answer for the model. It also turns user-correctable mistakes, like an empty query, into clear messages.

**Data flow**: It receives a ToolInvocation and extracts the payload. If the payload is not a tool-search request, it returns a fatal error because the wrong handler was called. It trims the query, rejects an empty query, reads or defaults the result limit, rejects a limit of zero, returns an empty list if there are no tools, otherwise calls ToolSearchHandler::search and wraps the resulting tools in ToolSearchOutput.

**Call relations**: ToolSearchHandler::handle calls this for every actual search request. When validation succeeds, it calls ToolSearchHandler::search; when output is ready, it uses boxed_tool_output so the result fits the common tool-output interface.

*Call graph*: calls 2 internal fn (boxed_tool_output, search); called by 1 (handle); 4 external calls (new, format!, Fatal, RespondToModel).


##### `ToolSearchHandler::search`  (lines 151–164)

```
fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<LoadableToolSpec>, FunctionCallError>
```

**Purpose**: Searches the indexed tool descriptions and returns loadable tool definitions for the best matches. This is the core lookup step after the request has been validated.

**Data flow**: It receives a query string and a maximum number of results. It asks the BM25 search engine for matching documents, turns each document id back into the corresponding ToolSearchInfo entry, keeps the tool output entries, and passes them to ToolSearchHandler::search_output_tools. It returns the final list or an error if conversion fails.

**Call relations**: ToolSearchHandler::handle_call calls this after checking the query and limit. It delegates the final shaping of results to ToolSearchHandler::search_output_tools so matching and output formatting stay separate.

*Call graph*: calls 1 internal fn (search_output_tools); called by 1 (handle_call); 1 external calls (search).


##### `ToolSearchHandler::search_output_tools`  (lines 166–173)

```
fn search_output_tools(
        &self,
        results: impl IntoIterator<Item = &'a ToolSearchEntry>,
    ) -> Result<Vec<LoadableToolSpec>, FunctionCallError>
```

**Purpose**: Turns raw matched tool entries into the final list of loadable tool specs. It also combines related tools that belong together, such as multiple tools from the same namespace.

**Data flow**: It receives an iterable set of ToolSearchEntry references. It clones each entry’s output spec, passes those specs to coalesce_loadable_tool_specs, and returns the combined list.

**Call relations**: ToolSearchHandler::search calls this after ranking matches. The tests call it indirectly and directly to confirm that mixed results, especially namespaced MCP and dynamic tools, are returned in a clean combined form.

*Call graph*: called by 1 (search); 2 external calls (into_iter, coalesce_loadable_tool_specs).


##### `tests::cache_reuses_handler_for_identical_search_infos_and_rebuilds_for_changes`  (lines 192–212)

```
fn cache_reuses_handler_for_identical_search_infos_and_rebuilds_for_changes()
```

**Purpose**: Checks that the cache reuses a handler when the searchable tool list is unchanged and builds a new one when the list changes. This protects both performance and correctness.

**Data flow**: It creates a cache and one sample tool search entry. It asks the cache for a handler twice with the same data and confirms both shared pointers refer to the same object. Then it changes the search text, asks again, and confirms the returned handler is a different object.

**Call relations**: This test exercises ToolSearchHandlerCache::get_or_build through the realistic path of building search information from an MCP tool handler. It verifies the cache behavior that callers depend on when the available tools are refreshed.

*Call graph*: 3 external calls (assert!, default, vec!).


##### `tests::mixed_search_results_coalesce_mcp_namespaces`  (lines 215–319)

```
fn mixed_search_results_coalesce_mcp_namespaces()
```

**Purpose**: Checks that search results from different tool sources are converted into a clean combined output. In particular, it verifies that multiple MCP tools from the same namespace are grouped together.

**Data flow**: It builds sample dynamic-tool information and sample MCP tool information. It converts them into search infos, creates a ToolSearchHandler, manually chooses a mixed result order, and asks search_output_tools to produce loadable specs. It then compares the result with the exact expected grouped namespace output.

**Call relations**: This test calls ToolSearchHandler::new and then directly checks ToolSearchHandler::search_output_tools. It uses tests::tool_info to make realistic MCP tool inputs, and it proves that the final output remains valid even when search results mix tool families.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, tool_info, json!).


##### `tests::tool_info`  (lines 321–342)

```
fn tool_info(server_name: &str, tool_name: &str, description_prefix: &str) -> ToolInfo
```

**Purpose**: Builds a small fake MCP tool description for tests. It saves the tests from repeating the same setup details for each sample tool.

**Data flow**: It receives a server name, tool name, and description prefix. It fills in a ToolInfo value with a namespace name, callable name, description, empty JSON input schema, and default test-only metadata, then returns that ToolInfo.

**Call relations**: The test functions call this helper when they need realistic MCP tool data. Those ToolInfo values are then converted by McpHandler into search information used by the cache and coalescing tests.

*Call graph*: 6 external calls (new, new, format!, new, object, json!).


### `core/src/tools/handlers/tool_search_spec.rs`

`domain_logic` · `tool setup before model calls`

Some tool sets can be large, so the system may hold back many tools until the model asks for them. This file creates the small “search counter” the model can use to find those hidden tools later. In everyday terms, instead of handing someone every tool in a warehouse, it gives them a catalog search box.

The main function, `create_tool_search_tool`, receives a list of searchable tool sources, such as Google Drive or documentation tools, plus a default result limit. It then builds a `ToolSpec`, which is the structured description the model sees. That description says what the tool is for, where it can search, and what inputs it accepts. The inputs are described with a JSON schema, which is a machine-readable shape saying: there must be a `query` text field, and there may be a numeric `limit` field.

A notable detail is that source names are deduplicated. If the same source appears more than once, the function keeps one line for it and prefers a description when one is available. If no sources are enabled, the description says so plainly. The test checks this behavior so future changes do not accidentally make the model prompt noisy or misleading.

#### Function details

##### `create_tool_search_tool`  (lines 7–62)

```
fn create_tool_search_tool(
    searchable_sources: &[ToolSearchSourceInfo],
    default_limit: usize,
) -> ToolSpec
```

**Purpose**: Creates the official specification for the `tool_search` tool. This tells the model how to search for deferred tools, what arguments it can provide, and which tool sources are currently available.

**Data flow**: It takes a list of source names and optional descriptions, plus a default maximum number of results. It turns the inputs into a clean prompt description, removes duplicate source names while keeping useful descriptions, and builds a JSON-shaped parameter definition with a required `query` and optional `limit`. It returns a `ToolSpec::ToolSearch` value that the rest of the system can offer to the model.

**Call relations**: This function is called by `new` when the tool system is being assembled. At that moment, it packages the available search sources into a form the model can understand, using helper constructors for JSON schema fields along the way.

*Call graph*: calls 3 internal fn (number, object, string); called by 1 (new); 4 external calls (from, new, format!, vec!).


##### `tests::create_tool_search_tool_deduplicates_and_renders_enabled_sources`  (lines 72–112)

```
fn create_tool_search_tool_deduplicates_and_renders_enabled_sources()
```

**Purpose**: Checks that `create_tool_search_tool` produces the expected tool specification when there are repeated source names and mixed descriptions. It protects the wording and structure that the model depends on.

**Data flow**: The test feeds in two entries for Google Drive, one with a description and one without, plus a separate `docs` source. It compares the returned `ToolSpec` against the exact expected result, including the deduplicated source list, the default limit text, and the required `query` parameter. The output is a pass or fail from the test runner.

**Call relations**: This test exercises `create_tool_search_tool` directly. It uses an equality assertion to catch any change that would alter the generated tool description or parameter schema.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/view_image.rs`

`domain_logic` · `tool call handling`

This file is the bridge between a model asking “show me this image” and the system safely delivering that image back as model input. Without it, the model could receive text from tools but would not have a controlled way to inspect image files in the workspace.

The main piece is `ViewImageHandler`. When a tool call arrives, it first makes sure the current model can actually accept images. It then reads the tool arguments: the file path, an optional environment id, and an optional detail setting. The detail setting is deliberately strict: it accepts only `high` or `original`, so a misspelled value does not silently do the wrong thing.

Next, the handler finds the selected environment and builds an absolute path from that environment’s current directory. It asks the environment’s filesystem for metadata and file bytes, using the turn’s sandbox rules. The sandbox is like a guardrail: even though the tool is reading a file, it must still obey the session’s permission limits.

After reading the file, the handler decides whether to send the original image or a resized version. Some models may request original image detail; otherwise the default high-detail resized behavior is used. Finally, it emits a turn item so the UI/history can record that an image was viewed, and returns a `ViewImageOutput`, which knows how to hide large image data in logs while still sending the actual image to the model.

#### Function details

##### `ViewImageHandler::default`  (lines 37–44)

```
fn default() -> Self
```

**Purpose**: Creates a standard `view_image` handler with conservative options. By default, it does not advertise original-image detail support or include an environment id in the tool shape.

**Data flow**: No outside input is needed. It builds a `ViewImageHandler` containing default `ViewImageToolOptions`, then returns that ready-to-use handler.

**Call relations**: The tests call this when they need a normal handler without special setup. In production, more customized construction can use `ViewImageHandler::new` instead.

*Call graph*: called by 3 (handle_accepts_explicit_high_detail, handle_passes_sandbox_context_for_local_filesystem_reads, handle_rejects_unsupported_detail).


##### `ViewImageHandler::new`  (lines 48–50)

```
fn new(options: ViewImageToolOptions) -> Self
```

**Purpose**: Creates a `view_image` handler with caller-supplied options. This is used when the tool registry wants the handler to match the current runtime capabilities.

**Data flow**: It receives `ViewImageToolOptions`, stores them inside a new `ViewImageHandler`, and returns that handler.

**Call relations**: The core tool setup code calls this while adding utility tools. The options it receives later affect what `spec` advertises to the model.

*Call graph*: called by 1 (add_core_utility_tools).


##### `ViewImageHandler::tool_name`  (lines 71–73)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the tool name as `view_image`. The tool registry uses this name to match an incoming tool call to this handler.

**Data flow**: It takes the handler, creates a plain tool name from the string `view_image`, and returns that name.

**Call relations**: The tool execution framework calls this when identifying available tools. It relies on the shared tool-name constructor so the name has the expected internal form.

*Call graph*: calls 1 internal fn (plain).


##### `ViewImageHandler::spec`  (lines 75–77)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the public description of the `view_image` tool that is shown to the model. This tells the model what arguments it may send.

**Data flow**: It reads the handler’s stored options, passes them to the view-image tool specification builder, and returns the resulting tool specification.

**Call relations**: The tool registry calls this while presenting tools to the model. The work is handed to `create_view_image_tool`, which centralizes the exact schema and wording.

*Call graph*: calls 1 internal fn (create_view_image_tool).


##### `ViewImageHandler::supports_parallel_tool_calls`  (lines 79–81)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: States that multiple `view_image` calls can run at the same time. This is safe because each call reads its requested file and does not rely on shared mutable state in the handler.

**Data flow**: It reads no data and always returns `true`.

**Call relations**: The tool runner checks this before deciding whether it may execute several tool calls concurrently. This handler opts in to that faster path.


##### `ViewImageHandler::handle`  (lines 83–85)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling a `view_image` tool call in the asynchronous tool-execution system. It wraps the real work so the tool framework can await it later.

**Data flow**: It receives a `ToolInvocation`, calls `handle_call` with it, pins the resulting future so it can be stored safely by the async runtime, and returns that future.

**Call relations**: The tool framework calls `handle` when the model invokes `view_image`. `handle` immediately hands the actual validation, file reading, and output creation to `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ViewImageHandler::handle_call`  (lines 89–228)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the full `view_image` operation: validates the request, finds and reads the image file under sandbox rules, prepares the image data, records the event, and returns a model-ready image output.

**Data flow**: It receives a tool invocation containing the session, turn context, call id, and raw arguments. It checks that the model supports image input, parses the JSON arguments, validates the requested detail level, resolves the target environment, builds the file path, checks that the path is a file, reads the bytes through the sandboxed filesystem, converts or resizes those bytes into a data URL, emits started/completed image-view events, and returns a boxed `ViewImageOutput`. If any step is not allowed or fails, it returns a message meant for the model instead of an image.

**Call relations**: `handle` calls this for every `view_image` request. It collaborates with argument parsing, environment resolution, path conversion, image conversion, and original-detail capability checks. At the end it hands its result to `boxed_tool_output` so the generic tool system can treat the image output like any other tool output.

*Call graph*: calls 4 internal fn (boxed_tool_output, parse_arguments, resolve_tool_environment, from_abs_path); called by 1 (handle); 7 external calls (ImageView, data_url_from_bytes, load_for_prompt_bytes, can_request_original_image_detail, format!, matches!, RespondToModel).


##### `ViewImageOutput::log_preview`  (lines 239–241)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a safe short log message for an image result. It avoids putting the full image data into logs, which could be huge or sensitive.

**Data flow**: It reads the stored image data URL only to measure its length. It returns a string such as `<image data URL omitted: N bytes>` and does not expose the actual image contents.

**Call relations**: The tool logging system calls this when it wants a preview of the result. The test `tests::log_preview_omits_image_data` checks that the image data is hidden.

*Call graph*: 1 external calls (format!).


##### `ViewImageOutput::success_for_logging`  (lines 243–245)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this output as a successful tool result for logging purposes. A created `ViewImageOutput` means the image was prepared successfully.

**Data flow**: It reads no fields and always returns `true`.

**Call relations**: The generic tool output code can call this when recording whether a tool call succeeded. Errors are represented before a `ViewImageOutput` is created, so this output type reports success.


##### `ViewImageOutput::to_response_item`  (lines 247–262)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns the image output into the response format that can be sent back to the model. This is the step that packages the data URL as an input image.

**Data flow**: It receives the tool call id and ignores the original payload. It clones the stored image URL, pairs it with the chosen image detail, wraps that in a successful function-call output object, and returns a `ResponseInputItem` tied to the same call id.

**Call relations**: After `handle_call` returns a `ViewImageOutput`, the tool framework uses this method when building the next message to the model. It uses the protocol’s content-item structures so the model sees an actual image input, not just text.

*Call graph*: 2 external calls (ContentItems, vec!).


##### `ViewImageOutput::code_mode_result`  (lines 264–269)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> serde_json::Value
```

**Purpose**: Provides a JSON-shaped version of the image result for code-oriented tool output. It includes the image data URL and the detail level.

**Data flow**: It reads the stored image URL and image detail, places them into a JSON object with `image_url` and `detail`, and returns that object.

**Call relations**: Code-mode consumers call this when they need structured JSON instead of the normal model response item. The test `tests::code_mode_result_returns_image_url_object` confirms the shape of this JSON.

*Call graph*: 1 external calls (json!).


##### `tests::replace_primary_environment_cwd`  (lines 289–302)

```
fn replace_primary_environment_cwd(turn: &mut crate::TurnContext, cwd: AbsolutePathBuf)
```

**Purpose**: Test helper that changes the primary test environment’s current working directory. This lets tests point the handler at a temporary folder containing test files.

**Data flow**: It receives a mutable turn context and a new absolute path. It copies the current primary environment’s identity and filesystem, replaces only its current directory with the new path converted to a path URI, and writes that environment back into the turn.

**Call relations**: The image-handling tests use this before invoking the handler. It calls the turn-environment constructor and path conversion helper so the test setup resembles a real environment.

*Call graph*: calls 2 internal fn (new, from_abs_path).


##### `tests::log_preview_omits_image_data`  (lines 305–312)

```
fn log_preview_omits_image_data()
```

**Purpose**: Checks that image output logging does not leak the full image data URL. This protects logs from becoming noisy or exposing image contents.

**Data flow**: It creates a `ViewImageOutput` with a small fake data URL, calls `log_preview`, and compares the returned text with the expected redacted preview.

**Call relations**: This test directly exercises `ViewImageOutput::log_preview`. It documents the intended logging behavior for future changes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::code_mode_result_returns_image_url_object`  (lines 315–332)

```
fn code_mode_result_returns_image_url_object()
```

**Purpose**: Checks that code-mode output is a JSON object containing the image URL and detail value. This guards the structured output contract.

**Data flow**: It creates a `ViewImageOutput`, calls `code_mode_result` with a dummy function payload, and compares the JSON result to the expected object.

**Call relations**: This test directly exercises `ViewImageOutput::code_mode_result`. It helps ensure code-mode callers can keep relying on the same field names.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::handle_passes_sandbox_context_for_local_filesystem_reads`  (lines 335–367)

```
async fn handle_passes_sandbox_context_for_local_filesystem_reads()
```

**Purpose**: Checks that `view_image` reads files through the sandboxed filesystem rules instead of bypassing permissions. The expected failure proves the sandbox context is being passed along.

**Data flow**: It creates a session and turn, moves the environment to a temporary directory, writes a fake image file, sets a read-only permission profile, and invokes the default handler. It expects an error message about sandboxed filesystem runtime paths, showing that the read went through the sandbox layer.

**Call relations**: This test calls `ViewImageHandler::default` and then uses the normal `handle` path. It is focused on the filesystem-read part of `handle_call`, especially the handoff of sandbox information.

*Call graph*: calls 5 internal fn (make_session_and_context, default, new, read_only, plain); 9 external calls (new, new, assert!, replace_primary_environment_cwd, json!, panic!, write, tempdir, new).


##### `tests::handle_rejects_unsupported_detail`  (lines 370–395)

```
async fn handle_rejects_unsupported_detail()
```

**Purpose**: Checks that unsupported image detail values are rejected with a clear message. This prevents typos such as `low` from being treated as some accidental default.

**Data flow**: It creates a session and turn, invokes the default handler with JSON arguments containing `detail: "low"`, and expects a model-facing error explaining that only `high` and `original` are valid.

**Call relations**: This test enters through `ViewImageHandler::handle`, which then calls `handle_call`. It specifically verifies the argument-validation branch before any filesystem work matters.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 6 external calls (new, new, assert_eq!, json!, panic!, new).


##### `tests::handle_accepts_explicit_high_detail`  (lines 398–427)

```
async fn handle_accepts_explicit_high_detail()
```

**Purpose**: Checks that explicitly asking for `high` detail is accepted as valid input. The test expects a later image-processing error because the file contents are fake, which shows the detail value itself was not rejected.

**Data flow**: It creates a temporary environment with a fake `image.png`, disables permission restrictions, invokes the default handler with `detail: "high"`, and then checks that the failure message comes from image processing rather than detail validation.

**Call relations**: This test uses `tests::replace_primary_environment_cwd` for setup and then runs the regular `handle` path. It exercises the successful detail-parsing branch inside `handle_call` before the image conversion step fails on intentionally invalid bytes.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 9 external calls (new, new, assert!, replace_primary_environment_cwd, json!, panic!, write, tempdir, new).


### `core/src/tools/handlers/view_image_spec.rs`

`config` · `startup/tool registration`

This file is like the menu card for a tool that can open an image from the local filesystem. It does not load the image itself. Instead, it describes how another part of the system may call that tool: it must provide a local file path, and it may be allowed to ask for extra options depending on the current environment.

The main entry point builds a `ToolSpec`, which is a formal tool description used by the responses API. A schema is included for the input parameters. A schema is a structured description of what data is allowed, similar to a form that says which fields exist and which ones are required. The `path` field is always required. If the caller is allowed to request exact image resolution, the schema also includes a `detail` field with allowed values of `high` or `original`. If the system supports multiple environments, it can also include an `environment_id` field so the image can be read from the right place.

The file also defines the output schema. It says that a successful call returns an `image_url`, which is a data URL for the loaded image, and a `detail` value saying whether the image was returned at normal high detail or original resolution. Without this file, the model-facing tool interface would be ambiguous, and callers might send the wrong fields or misunderstand the result.

#### Function details

##### `create_view_image_tool`  (lines 15–50)

```
fn create_view_image_tool(options: ViewImageToolOptions) -> ToolSpec
```

**Purpose**: Builds the formal description of the `view_image` tool so it can be offered to a model or API client. It decides which optional input fields should appear based on the capabilities passed in through `ViewImageToolOptions`.

**Data flow**: It receives options saying whether original-resolution requests are allowed and whether an environment ID should be accepted. It starts with a required `path` field, conditionally adds `detail` and `environment_id`, attaches the expected output shape, and returns a complete `ToolSpec` describing the tool.

**Call relations**: A higher-level tool specification builder calls this when assembling the available tools. During that setup, this function asks `view_image_output_schema` for the promised result format, then packages both the input and output schemas into the final tool definition.

*Call graph*: calls 4 internal fn (view_image_output_schema, object, string, string_enum); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `view_image_output_schema`  (lines 52–69)

```
fn view_image_output_schema() -> Value
```

**Purpose**: Defines what the `view_image` tool returns after it loads an image. It gives callers a clear contract: they should expect an image data URL and a detail label.

**Data flow**: It takes no input. It creates a JSON object describing the output fields, marks both `image_url` and `detail` as required, disallows extra fields, and returns that JSON schema value.

**Call relations**: This helper is used by `create_view_image_tool` while building the full tool description. It keeps the output contract in one small place so the main tool-building function can include it whenever the tool is registered.

*Call graph*: called by 1 (create_view_image_tool); 1 external calls (json!).


### `core/src/tools/handlers/get_context_remaining.rs`

`domain_logic` · `tool invocation during a conversation turn`

Large language models can only read a limited amount of text at one time. That limit is called the context window. This file provides a small tool the model can call to ask, “How many tokens do I have left?” A token is a small chunk of text, often part of a word.

The main piece is `GetContextRemainingHandler`, which plugs into the tool system. When the tool is invoked, it first checks that the request is the expected kind of tool call. Then it asks the current turn for the model’s context-window size. If that size is not known, it returns an “unknown” answer rather than guessing. If it is known, it asks the session how many tokens are currently in use, subtracts that from the model’s maximum, and never lets the result go below zero.

The answer is wrapped in `GetContextRemainingOutput`. This output can be shown to the model as plain text, logged for humans, or returned as structured JSON in code-oriented mode. Think of it like a fuel gauge: it does not drive the car, but it tells the driver how much range remains before they must be careful.

#### Function details

##### `GetContextRemainingOutput::new`  (lines 24–26)

```
fn new(tokens_left: Option<i64>) -> Self
```

**Purpose**: Creates a small output object holding the number of tokens left, or no number if the system cannot know it. This keeps the answer in one simple package for later formatting.

**Data flow**: It receives an optional token count. It stores that value inside a new `GetContextRemainingOutput` object and returns the object unchanged except for wrapping it in this output type.

**Call relations**: The handler calls this after it has either calculated the remaining tokens or discovered that the model’s context size is unknown. The resulting object is then handed to the common tool-output wrapper so the rest of the system can return it in the usual way.

*Call graph*: called by 1 (handle).


##### `GetContextRemainingOutput::fragment`  (lines 28–35)

```
fn fragment(&self) -> String
```

**Purpose**: Turns the stored token information into human-readable text. If the number is known, it renders a message with that number; if not, it renders an “unknown” context-budget message.

**Data flow**: It reads `tokens_left` from the output object. When a number is present, it builds a token-budget context message from that number and renders it as text. When no number is present, it builds and renders an unknown-budget message. The result is a string.

**Call relations**: The logging path and the model-response path both call this so they show the same wording. Internally it relies on the context-rendering helpers that know how to phrase token-budget information.

*Call graph*: calls 2 internal fn (new, unknown); called by 2 (log_preview, to_response_item).


##### `GetContextRemainingOutput::log_preview`  (lines 39–41)

```
fn log_preview(&self) -> String
```

**Purpose**: Provides the short text that should appear in logs for this tool result. It uses the same text shown to the model so logs stay easy to compare with actual behavior.

**Data flow**: It receives the output object, asks `fragment` to turn it into text, and returns that text as the log preview. It does not change any state.

**Call relations**: The tool-output logging system calls this when it needs a quick summary of the result. It delegates the actual wording to `GetContextRemainingOutput::fragment`.

*Call graph*: calls 1 internal fn (fragment).


##### `GetContextRemainingOutput::success_for_logging`  (lines 43–45)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks this tool result as successful for logging purposes. Even an unknown token count is treated as a valid result, because the tool successfully answered with the best available information.

**Data flow**: It takes no meaningful input beyond the output object and always returns `true`. Nothing is changed.

**Call relations**: The tool logging machinery uses this to decide whether the result should be recorded as a success. This function does not call out to other code because the answer is unconditional.


##### `GetContextRemainingOutput::to_response_item`  (lines 47–50)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the token-budget answer into the standard response item format that can be sent back into the conversation. This is how the model receives the tool’s answer as text.

**Data flow**: It receives the tool call ID and the original tool payload, reads the output object, turns it into text with `fragment`, wraps that text as a successful function-tool output, and converts it into a `ResponseInputItem`. The returned item is ready for the conversation pipeline.

**Call relations**: The broader tool system calls this after the handler returns the output. It uses `FunctionToolOutput::from_text` to package the message, then hands off to that shared output type to produce the final response item.

*Call graph*: calls 2 internal fn (from_text, fragment).


##### `GetContextRemainingOutput::code_mode_result`  (lines 52–56)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Returns the same answer in a structured JSON form for code-oriented consumers. Instead of prose, it exposes a `tokens_left` field that software can read directly.

**Data flow**: It reads the stored optional token count and places it into a JSON object under the key `tokens_left`. If the count is unknown, the JSON value is null. It returns that JSON object and does not modify anything.

**Call relations**: The tool system calls this when it needs a machine-readable result rather than a plain text response. It uses JSON construction directly and does not depend on the text-rendering path.

*Call graph*: 1 external calls (json!).


##### `GetContextRemainingHandler::tool_name`  (lines 62–64)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Identifies this handler as the implementation for the `get_context_remaining` tool. The registry uses this name to match an incoming tool call to the right handler.

**Data flow**: It reads the tool-name constant, wraps it as a plain tool name, and returns that name. No outside state is changed.

**Call relations**: The tool registry calls this while registering or looking up tools. It uses the shared `ToolName::plain` helper so the name is represented in the standard format.

*Call graph*: calls 1 internal fn (plain).


##### `GetContextRemainingHandler::spec`  (lines 66–68)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of the tool, such as its name and expected shape, so the model and runtime know how it may be called.

**Data flow**: It calls the tool-specification builder and returns the resulting `ToolSpec`. It does not inspect the current session or invocation.

**Call relations**: The tool registry or setup code calls this when advertising available tools. The details come from `create_get_context_remaining_tool`, keeping the handler’s runtime behavior separate from the tool’s public definition.

*Call graph*: calls 1 internal fn (create_get_context_remaining_tool).


##### `GetContextRemainingHandler::handle`  (lines 70–92)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Runs the actual `get_context_remaining` tool call. It checks that the call is valid, calculates how many context tokens remain when possible, and returns that answer in the standard tool-output form.

**Data flow**: It receives a `ToolInvocation`, which includes the payload, current turn, and session. First it rejects unsupported payloads with an error message. Then it reads the model’s context-window size from the turn. If that size is missing, it returns an output with no token count. If the size is known, it asks the session for total token usage, treats negative usage as zero, subtracts usage from the window size safely, clamps the result at zero, and returns that number as boxed tool output.

**Call relations**: The tool runtime calls this when the model invokes `get_context_remaining`. It creates `GetContextRemainingOutput` objects for both known and unknown cases, wraps them with `boxed_tool_output`, and reports a model-facing error if some other kind of payload reaches this handler.

*Call graph*: calls 2 internal fn (boxed_tool_output, new); 3 external calls (pin, matches!, RespondToModel).


### `core/src/tools/handlers/agent_jobs_spec.rs`

`config` · `startup/tool registration`

This file is like the instruction card for two tools, not the place where the work itself is done. The first tool, `spawn_agents_on_csv`, lets a main agent point at a CSV file and give an instruction template. The system can then start one worker sub-agent for each row, filling placeholders like `{column_name}` with values from that row. The tool description also says which options are allowed, such as an ID column, an output CSV path, a concurrency limit, a per-worker timeout, and an optional JSON Schema. A JSON Schema is a machine-readable shape description for JSON data, used here to say what each worker result should look like.

The second tool, `report_agent_job_result`, is for the worker agents. It gives each worker a standard way to say, “Here is the result for my job item,” and optionally ask the larger job to stop after recording that result.

Nothing in this file reads CSVs, starts agents, or writes output files. Its job is to build `ToolSpec` values: structured descriptions containing tool names, human-readable explanations, required fields, and allowed parameter shapes. Without this file, the system would not have a clear contract for these agent-job tools, and callers could not reliably know how to invoke them.

#### Function details

##### `create_spawn_agents_on_csv_tool`  (lines 6–72)

```
fn create_spawn_agents_on_csv_tool() -> ToolSpec
```

**Purpose**: Builds the formal description for the `spawn_agents_on_csv` tool. This description tells callers how to request a CSV-driven batch job where each row becomes work for a separate sub-agent.

**Data flow**: It starts with no outside input. It creates a parameter schema describing the allowed fields: the CSV path, the instruction template, optional ID and output paths, worker limits, runtime limits, and an optional result-shape schema. It then wraps that schema with the tool name and explanation, and returns a `ToolSpec` that the wider system can register and expose.

**Call relations**: The broader tool specification setup calls this function when assembling the available tools. Inside, it relies on schema-building helpers to describe strings, numbers, and objects, then hands back one complete tool definition for the rest of the system to advertise and validate against.

*Call graph*: calls 3 internal fn (number, object, string); called by 1 (spec); 4 external calls (from, new, Function, vec!).


##### `create_report_agent_job_result_tool`  (lines 74–115)

```
fn create_report_agent_job_result_tool() -> ToolSpec
```

**Purpose**: Builds the formal description for the `report_agent_job_result` tool. This is the worker-only reporting channel used by sub-agents to submit the result for a single job item.

**Data flow**: It starts with no outside input. It creates a schema requiring a job ID, an item ID, and a result object, with an optional `stop` flag that can cancel remaining work. It packages these rules with the tool name and description, then returns a `ToolSpec` ready for registration.

**Call relations**: The broader tool specification setup calls this function alongside other tool-definition builders. This function does not record any result itself; it only describes the shape of a valid report so the actual job system can later receive and check worker submissions consistently.

*Call graph*: calls 3 internal fn (boolean, object, string); called by 1 (spec); 4 external calls (from, new, Function, vec!).


### `core/src/tools/handlers/new_context_window_spec.rs`

`config` · `tool registration`

This file is like a small label and instruction card for one tool. The rest of the system needs a precise description of every tool it can offer, so that an outside caller knows the tool’s name, what it does, and what input it expects. Here, the tool is called `new_context`, and its job is to ask the system to begin a new context window.

A “context window” is the chunk of conversation or working memory the model is currently using. Starting a new one is useful when the current working space is full or when a clean slate is needed.

The file builds a `ToolSpec`, which is a structured description of the tool. It says the tool is a function-style tool, gives it the name `new_context`, describes it as “Start a new context window,” and declares that it takes no input parameters. The empty JSON schema is important: it tells callers they should not send arguments with this tool. Without this file, the broader tool registry would not know how to present or describe the `new_context` tool.

#### Function details

##### `create_new_context_window_tool`  (lines 8–17)

```
fn create_new_context_window_tool() -> ToolSpec
```

**Purpose**: Creates the formal description of the `new_context` tool so it can be offered to callers. Someone would use this when assembling the list of available tools.

**Data flow**: It takes no input. It builds a tool description with a fixed name, a short human-readable explanation, and an empty parameter schema meaning “no arguments are expected.” It returns that finished tool specification without changing any outside state.

**Call relations**: When the broader `spec` code is collecting tool definitions, it calls this function to get the `new_context` tool’s description. Inside, this function uses helper constructors to build the empty JSON schema and wrap the result as a function-style tool specification.

*Call graph*: calls 1 internal fn (object); called by 1 (spec); 2 external calls (new, Function).


### `core/src/tools/handlers/plan_spec.rs`

`config` · `startup/tool registration`

This file is like the form template for updating a task plan. It does not update the plan itself. Instead, it describes the tool that can be used to send a plan update: an optional explanation plus a list of steps, where each step has text and a status.

The main reason this exists is to keep plan updates consistent. Without this specification, callers could send loosely shaped data, such as a step without a status or a status with an unexpected value. Here, the allowed statuses are limited to `pending`, `in_progress`, and `completed`, which makes the plan easier for the rest of the system to display and reason about.

The file builds a JSON schema, which is a machine-readable description of valid JSON data. First it defines what each plan item looks like. Then it defines the full tool input: an optional `explanation` and a required `plan` array. Finally, it wraps that schema in a `ToolSpec`, giving the tool its public name, `update_plan`, and a human-readable description. The note that only one step should be `in_progress` is part of the tool description rather than something enforced by this schema.

#### Function details

##### `create_update_plan_tool`  (lines 7–58)

```
fn create_update_plan_tool() -> ToolSpec
```

**Purpose**: Creates the formal definition of the `update_plan` tool so it can be registered and offered to callers. The definition says what fields the tool accepts and which values are valid.

**Data flow**: It starts with no outside input. It builds small schema pieces for a plan item, including a `step` string and a `status` string limited to known status words. It then builds the larger input schema with an optional explanation and a required list of plan items. The result is a `ToolSpec` object that the caller can register or publish as the `update_plan` tool.

**Call relations**: This function is called by `spec` when the system is assembling its available tools. Inside, it uses schema-building helpers such as string, enum, array, and object constructors to describe the accepted data, then hands back one complete function-style tool definition.

*Call graph*: calls 4 internal fn (array, object, string, string_enum); called by 1 (spec); 3 external calls (from, Function, vec!).


### Code-mode runtime integration
This group introduces the code-mode subsystem and then follows the core-facing specs and handlers that execute and wait on code cells.

### `code-mode/src/lib.rs`

`orchestration` · `cross-cutting`

This file is small, but it is important because it defines the library’s outside shape. In Rust, a `lib.rs` file is like the reception desk for a package: it decides which internal rooms exist and which names visitors are allowed to use directly.

Here, the file declares two internal modules: `runtime` and `service`. Those modules contain the actual implementation details. It then re-exports, meaning “makes available again from here,” the protocol definitions from `codex_code_mode_protocol` and several service-related types from the `service` module.

The practical effect is convenience and stability. Other code can import `CodeModeService`, `InProcessCodeModeSessionProvider`, `NoopCodeModeSessionDelegate`, and the protocol types from this library’s top level instead of needing to know where each item lives internally. Without this file, users of the library would have to reach into deeper module paths, and internal reorganizations would be more likely to break them.

There are no functions here. Its job is not to run behavior directly, but to present a clean public API: the set of names this crate wants the rest of the system to rely on.


### `code-mode/src/runtime/globals.rs`

`orchestration` · `runtime startup`

This file is like setting up a carefully stocked workbench before letting someone start a task. The runtime uses V8, the JavaScript engine, to run code. Before that code begins, this file decides what global names the code can see.

First, it removes some default JavaScript globals: `console`, `Atomics`, `SharedArrayBuffer`, and `WebAssembly`. This likely keeps the environment smaller, more controlled, and less able to do things the runtime does not want to support. Then it adds project-specific globals. Some are helper functions, such as `text`, `image`, `store`, `load`, `notify`, `setTimeout`, `clearTimeout`, `yield_control`, and `exit`. Each of these is backed by a Rust callback, meaning JavaScript can call the function but Rust does the real work.

It also exposes available tools in two forms. `tools` is an object whose properties are callable tool functions. `ALL_TOOLS` is an array of simple metadata objects, each with a name and description, so code can inspect what tools exist.

The important idea is control. Without this file, user JavaScript would either miss the helpers it needs to interact with the host system, or it might have access to built-ins the runtime intentionally removes.

#### Function details

##### `install_globals`  (lines 14–47)

```
fn install_globals(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String>
```

**Purpose**: Sets up the global JavaScript environment before user code runs. It removes selected built-in globals and installs the runtime’s supported helper functions and tool lists.

**Data flow**: It receives a V8 scope, which is the current access point into the JavaScript engine. From that scope it finds the current global object, deletes unwanted names from it, builds tool-related values and helper functions, then attaches all of them as global names. If any step fails, it returns an error message; otherwise it finishes successfully.

**Call relations**: This is called by `run_runtime` during runtime setup. It acts as the main coordinator in this file: it asks `delete_global` to remove blocked globals, asks `build_tools_object` and `build_all_tools_value` to prepare tool information, asks `helper_function` to wrap Rust callbacks as JavaScript functions, and uses `set_global` to publish everything into the JavaScript environment.

*Call graph*: calls 5 internal fn (build_all_tools_value, build_tools_object, delete_global, helper_function, set_global); called by 1 (run_runtime); 1 external calls (get_current_context).


##### `build_tools_object`  (lines 49–65)

```
fn build_tools_object(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Object>, String>
```

**Purpose**: Creates the global `tools` object that JavaScript code can use to call enabled tools by name. Each enabled tool becomes one property on that object.

**Data flow**: It reads the runtime state stored in the V8 scope to find the list of enabled tools. For each tool, it turns the tool’s global name into a JavaScript string, creates a callable JavaScript function for that tool, and places it on a new object. The result is that object, ready to be installed as `tools`.

**Call relations**: `install_globals` calls this while preparing the runtime environment. For each tool it delegates to `tool_function`, which creates the actual JavaScript function connected to the shared `tool_callback` Rust callback.

*Call graph*: calls 1 internal fn (tool_function); called by 1 (install_globals); 2 external calls (new, new).


##### `build_all_tools_value`  (lines 67–99)

```
fn build_all_tools_value(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Value>, String>
```

**Purpose**: Creates the global `ALL_TOOLS` value, which is a JavaScript array describing the enabled tools. This gives JavaScript code a simple way to see what tools exist and what they are for.

**Data flow**: It reads the enabled tools from the runtime state in the V8 scope. It creates a JavaScript array, then for each tool creates a small object containing `name` and `description`. Those objects are placed into the array. The finished array is returned as a JavaScript value, or an error is returned if allocation or assignment fails.

**Call relations**: `install_globals` calls this during setup and then publishes the returned value as the global `ALL_TOOLS`. Unlike `build_tools_object`, this does not create callable functions; it creates readable metadata for discovery.

*Call graph*: called by 1 (install_globals); 3 external calls (new, new, new).


##### `helper_function`  (lines 101–117)

```
fn helper_function(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    callback: F,
) -> Result<v8::Local<'s, v8::Function>, String>
```

**Purpose**: Turns a Rust callback into a JavaScript function with a given name. This is used for built-in helpers like `text`, `store`, `notify`, and `exit`.

**Data flow**: It receives the V8 scope, the helper’s name, and the Rust callback that should run when JavaScript calls it. It creates a JavaScript string for the name, builds a V8 function template around the callback, stores the name as callback data, and produces a JavaScript function. The output is that function, or an error message if creation fails.

**Call relations**: `install_globals` calls this repeatedly, once for each runtime helper. The functions it returns are then passed to `set_global`, which makes them visible to JavaScript code.

*Call graph*: called by 1 (install_globals); 2 external calls (builder, new).


##### `tool_function`  (lines 119–131)

```
fn tool_function(
    scope: &mut v8::PinScope<'s, '_>,
    tool_index: usize,
) -> Result<v8::Local<'s, v8::Function>, String>
```

**Purpose**: Creates one JavaScript function for one enabled tool. The function remembers which tool it represents by storing the tool’s index as callback data.

**Data flow**: It receives the V8 scope and a numeric tool index. It turns the index into a JavaScript string, builds a function template using the shared `tool_callback`, stores the index as data on that function, and returns the created JavaScript function. If V8 cannot allocate the needed values, it returns an error message.

**Call relations**: `build_tools_object` calls this once per enabled tool while building the global `tools` object. Later, when JavaScript calls one of those tool functions, the shared `tool_callback` can use the stored index to know which enabled tool was requested.

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

**Purpose**: Adds or replaces one named value on the JavaScript global object. It is the small safety-checked helper used to publish runtime functions and values.

**Data flow**: It receives the V8 scope, the global object, a name, and the JavaScript value to store. It turns the name into a JavaScript string and tries to assign the value on the global object. If the assignment succeeds, it returns success; if not, it returns a clear error message naming the global that failed.

**Call relations**: `install_globals` calls this for every global it wants to expose, including `tools`, `ALL_TOOLS`, and each helper function. It is the final step that makes previously built values available to user JavaScript.

*Call graph*: called by 1 (install_globals); 3 external calls (set, format!, new).


##### `delete_global`  (lines 148–160)

```
fn delete_global(
    scope: &mut v8::PinScope<'s, '_>,
    global: v8::Local<'s, v8::Object>,
    name: &str,
) -> Result<(), String>
```

**Purpose**: Removes one named value from the JavaScript global object. This is used to take away built-in features the runtime does not want user code to access.

**Data flow**: It receives the V8 scope, the global object, and the name to remove. It turns the name into a JavaScript string and asks V8 to delete that property from the global object. It returns success if deletion worked, or an error message naming the global that could not be removed.

**Call relations**: `install_globals` calls this at the start of setup to remove `console`, `Atomics`, `SharedArrayBuffer`, and `WebAssembly`. This happens before new project-specific globals are installed, so the environment is cleaned first and then stocked with approved helpers.

*Call graph*: called by 1 (install_globals); 3 external calls (delete, format!, new).


### `code-mode/src/runtime/callbacks.rs`

`io_transport` · `during JavaScript runtime execution`

Think of this file as the service counter between sandboxed JavaScript and the Rust application around it. JavaScript code cannot directly touch Rust data structures or external tools, so these callbacks provide a safe, narrow set of doors. When a script calls one of these host functions, the callback checks the arguments, converts JavaScript values into plain JSON where needed, and either updates the runtime state or sends a RuntimeEvent to the outside system.

The most important callback is the tool bridge. It creates a JavaScript Promise, records its resolver in pending_tool_calls, and sends a ToolCall event. Later, some other part of the runtime can finish that Promise when the tool result arrives. Output callbacks turn script-produced text or images into FunctionCallOutputContentItem values, which are the protocol objects used to report content back. Store and load give scripts a small key-value memory, but only for values that can be safely serialized. Timer callbacks delegate to the runtime timer system, while yield and exit let script code pause cooperatively or stop execution.

A common safety pattern runs through the file: if an argument is missing, has the wrong type, or cannot be converted, the callback throws a JavaScript TypeError instead of silently doing the wrong thing.

#### Function details

##### `tool_callback`  (lines 13–72)

```
fn tool_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Starts a tool call requested by JavaScript and gives the script back a Promise, which is JavaScript’s placeholder for a future result. This is how sandboxed code asks the outside Rust system to run an enabled tool without directly running it itself.

**Data flow**: It reads the hidden callback data to find which enabled tool this function represents, then reads the first JavaScript argument as optional JSON input. It creates a Promise resolver, stores that resolver in runtime state under a new tool-call id, sends a RuntimeEvent::ToolCall containing the id, tool name, kind, and input, and returns the Promise to JavaScript. If the tool index or input is invalid, it throws a JavaScript type error instead.

**Call relations**: V8 invokes this when JavaScript calls an exposed tool function. Inside the callback, it relies on v8_value_to_json to turn the script argument into Rust-friendly data and throw_type_error to report bad calls. It hands the real work off by sending a ToolCall event; the saved Promise resolver lets another part of the runtime complete the JavaScript Promise later.

*Call graph*: calls 2 internal fn (throw_type_error, v8_value_to_json); 7 external calls (data, get, length, set, format!, new, new).


##### `text_callback`  (lines 74–97)

```
fn text_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Lets JavaScript report a piece of text as output content. It is used when script code wants text to become part of the function-call result seen by the outside system.

**Data flow**: It takes the first JavaScript argument, or undefined if none was supplied, and converts it into output text. It then sends that text as a FunctionCallOutputContentItem::InputText event through the runtime event channel and returns undefined to JavaScript. If the value cannot be turned into text, it throws a type error.

**Call relations**: V8 calls this when JavaScript uses the exposed text output helper. The callback depends on serialize_output_text for the value-to-text rules and then passes the finished content item outward as a RuntimeEvent::ContentItem.

*Call graph*: calls 2 internal fn (serialize_output_text, throw_type_error); 5 external calls (get, length, set, ContentItem, undefined).


##### `image_callback`  (lines 99–130)

```
fn image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Lets JavaScript report an image as output content, with an optional detail setting. This provides a controlled way for script-created or script-referenced images to enter the host protocol.

**Data flow**: It reads the first argument as the image value and optionally reads the second argument as a detail string. It rejects the detail argument if it is neither a string nor null or undefined. Then it normalizes the image into the protocol’s image content format, sends it as a content event, and returns undefined.

**Call relations**: V8 invokes this when script code calls the image output helper. The callback uses normalize_output_image to do the real image validation and formatting, then hands the resulting content item to the runtime event stream.

*Call graph*: calls 2 internal fn (normalize_output_image, throw_type_error); 5 external calls (get, length, set, ContentItem, undefined).


##### `generated_image_callback`  (lines 132–162)

```
fn generated_image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Reports an image-generation result object as output, and also reports its optional human-readable output hint as text. It is a specialized version of image output for results that may include extra guidance for how the image should be presented.

**Data flow**: It reads the first JavaScript argument, checks it for an optional output_hint string, and normalizes the same value as an image. It sends the image content item first. If an output hint exists, it sends a second text content item containing that hint. It returns undefined, or throws a type error if the result object or hint is malformed.

**Call relations**: V8 calls this when JavaScript uses the generated-image helper. It first asks generated_image_output_hint to extract the optional hint, then uses normalize_output_image for the image itself, and finally emits one or two RuntimeEvent::ContentItem messages.

*Call graph*: calls 3 internal fn (generated_image_output_hint, normalize_output_image, throw_type_error); 5 external calls (get, length, set, ContentItem, undefined).


##### `generated_image_output_hint`  (lines 164–182)

```
fn generated_image_output_hint(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<String>, String>
```

**Purpose**: Pulls the optional output_hint field out of a generated image result object. It exists so generated_image_callback can keep the rules for this special field clear and separate.

**Data flow**: It receives a JavaScript value and tries to treat it as an object. From that object it reads output_hint. If the field is missing or undefined, it returns None. If the field is a string, it returns that string. If the value is not an object or the field has the wrong type, it returns an error message.

**Call relations**: This helper is called only by generated_image_callback. It does not send events itself; it just validates and extracts the hint so the caller can decide whether to emit an extra text content item.

*Call graph*: called by 1 (generated_image_callback); 2 external calls (try_from, new).


##### `store_callback`  (lines 184–215)

```
fn store_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Lets JavaScript save a named value in the runtime’s small storage area. It is useful for remembering data across steps, but only when the value can be safely represented as plain JSON.

**Data flow**: It converts the first argument to a string key and converts the second argument into JSON. If the value cannot be serialized as a plain stored value, it throws a type error. Otherwise it writes the value into stored_values for immediate reads and stored_value_writes so the host can later see what changed.

**Call relations**: V8 invokes this when script code calls the store helper. It uses v8_value_to_json to enforce the storage boundary, then updates RuntimeState directly instead of sending an event.

*Call graph*: calls 2 internal fn (throw_type_error, v8_value_to_json); 2 external calls (get, format!).


##### `load_callback`  (lines 217–242)

```
fn load_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Lets JavaScript read a value that was previously stored under a key. It returns undefined when nothing has been saved for that key, matching normal JavaScript expectations for a missing value.

**Data flow**: It converts the first argument to a string key, looks that key up in runtime state, and clones the stored JSON value if present. If no value exists, it returns JavaScript undefined. If a value exists, it converts the JSON back into a V8 JavaScript value and returns it. If conversion fails, it throws a type error.

**Call relations**: V8 calls this when JavaScript uses the load helper. It is the counterpart to store_callback: store_callback writes JSON into RuntimeState, and load_callback uses json_to_v8 to turn that JSON back into something JavaScript can use.

*Call graph*: calls 2 internal fn (json_to_v8, throw_type_error); 3 external calls (get, set, undefined).


##### `notify_callback`  (lines 244–272)

```
fn notify_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Lets JavaScript send a short notification message to the host while work is in progress. It rejects empty messages so notifications are meaningful rather than blank noise.

**Data flow**: It reads the first argument, converts it into text, checks that the text is not empty after trimming whitespace, and sends a RuntimeEvent::Notify with the current tool call id and message text. It returns undefined when successful and throws a type error for invalid or empty text.

**Call relations**: V8 invokes this when script code calls the notify helper. It uses serialize_output_text for consistent text conversion, then sends a Notify event so the surrounding runtime can surface the message outside the JavaScript sandbox.

*Call graph*: calls 2 internal fn (serialize_output_text, throw_type_error); 4 external calls (get, length, set, undefined).


##### `set_timeout_callback`  (lines 274–288)

```
fn set_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Implements the host-side version of JavaScript’s setTimeout-style timer. It lets script code ask the runtime to run something later instead of blocking immediately.

**Data flow**: It passes the JavaScript arguments to the timer subsystem. If scheduling succeeds, it returns the numeric timeout id to JavaScript. If the arguments are invalid or the timer cannot be scheduled, it throws a type error.

**Call relations**: V8 calls this when JavaScript requests a timeout. This callback does not implement timing itself; it delegates to timers::schedule_timeout and only translates the result into a JavaScript return value or error.

*Call graph*: calls 2 internal fn (schedule_timeout, throw_type_error); 2 external calls (set, new).


##### `clear_timeout_callback`  (lines 290–301)

```
fn clear_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Cancels a timeout that was previously scheduled from JavaScript. This prevents a delayed callback from running when the script no longer wants it.

**Data flow**: It gives the JavaScript arguments to the timer subsystem, which interprets the timeout id and tries to cancel it. On success it returns undefined. On failure it throws a type error with the timer subsystem’s error message.

**Call relations**: V8 invokes this when JavaScript calls the exposed clear-timeout helper. It pairs with set_timeout_callback: one schedules through timers::schedule_timeout, and this one cancels through timers::clear_timeout.

*Call graph*: calls 2 internal fn (clear_timeout, throw_type_error); 2 external calls (set, undefined).


##### `yield_control_callback`  (lines 303–311)

```
fn yield_control_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Lets JavaScript voluntarily give control back to the host runtime. This is a cooperative pause signal, useful when long-running script work should allow the surrounding system to catch up.

**Data flow**: It reads the runtime state from the V8 scope. If state is available, it sends a RuntimeEvent::YieldRequested through the event channel. It does not return a special value and does not inspect JavaScript arguments.

**Call relations**: V8 calls this when script code uses the yield helper. Unlike tool or output callbacks, it does not convert data; it simply sends a signal event that the runtime can notice and act on.


##### `exit_callback`  (lines 313–324)

```
fn exit_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
)
```

**Purpose**: Requests that the running JavaScript code stop. It marks the runtime as wanting to exit and then throws a special sentinel exception so execution can unwind quickly.

**Data flow**: It sets exit_requested to true in runtime state if the state is available. Then it creates a JavaScript string containing the exit sentinel and throws it as an exception. The result is not a normal return value; the thrown sentinel is the mechanism used to break out of execution.

**Call relations**: V8 invokes this when script code calls the exposed exit helper. The state flag records the intent to stop, while the thrown sentinel gives the runtime’s outer execution loop a recognizable signal rather than an ordinary script error.

*Call graph*: 2 external calls (throw_exception, new).


### `core/src/tools/code_mode/mod.rs`

`orchestration` · `active during code-mode tool calls and per-turn tool dispatch`

Code mode is like giving the assistant a workbench where it can run a script over time instead of doing everything in one quick tool call. This file provides the front door to that workbench. It creates the code-mode service, forwards requests such as execute, wait, terminate, and shutdown, and starts a per-turn worker when the current conversation turn allows code mode.

It also translates results from the code runtime into the format expected by the wider tool system. When a script yields, finishes, fails, or is stopped, this file adds a clear status header, records the wall-clock time, includes any returned text or images, marks success or failure, and trims very large output so it does not overwhelm the model. Image output is also cleaned up depending on whether the current model is allowed to request original image detail.

A second important job is nested tool calling. A running code cell may ask to call another tool. This file checks that the code-mode exec tool does not call itself, turns the nested request into the correct tool payload shape, sends it through the normal tool router, and returns the result back to the code runtime. Without this file, code mode would be isolated from the rest of the system and its results would not be safely shaped for the model.

#### Function details

##### `is_exec_tool_name`  (lines 50–52)

```
fn is_exec_tool_name(tool_name: &ToolName) -> bool
```

**Purpose**: Checks whether a tool name refers to the public, un-namespaced code-mode exec tool. This is used to prevent code mode from recursively invoking itself.

**Data flow**: It receives a tool name, looks at whether it has no namespace and whether its plain name matches the code-mode public tool name, then returns true or false.

**Call relations**: When a running code cell asks to call another tool, call_nested_tool uses this check first. If the requested tool is the exec tool itself, the nested call is rejected before it can create a loop.

*Call graph*: called by 1 (call_nested_tool).


##### `CodeModeService::new`  (lines 66–74)

```
fn new() -> Self
```

**Purpose**: Creates a new code-mode service wrapper for this application. It sets up the dispatch broker that lets code-mode cells hand nested tool calls back to the normal tool system.

**Data flow**: It starts with no inputs, creates a shared dispatch broker, gives that broker to the underlying code-mode service as a delegate, and returns a CodeModeService containing both pieces.

**Call relations**: This is the setup step for code mode. It calls the lower-level code-mode constructor with the delegate broker, so later code-mode execution can coordinate with the rest of the tool runtime.

*Call graph*: calls 2 internal fn (with_delegate, new); 1 external calls (new).


##### `CodeModeService::execute`  (lines 76–81)

```
async fn execute(
        &self,
        request: codex_code_mode::ExecuteRequest,
    ) -> Result<codex_code_mode::StartedCell, String>
```

**Purpose**: Starts running a code-mode cell from an execute request. It is the service-level entry point for beginning script work.

**Data flow**: It receives an execute request, first retrieves the underlying session, then forwards the request to that session. The result is either a started cell description or an error message.

**Call relations**: Callers use this when the public exec tool wants to start work. It relies on CodeModeService::session to ensure code mode is available before handing the request to the underlying code-mode session.

*Call graph*: calls 1 internal fn (session).


##### `CodeModeService::wait`  (lines 83–88)

```
async fn wait(
        &self,
        request: codex_code_mode::WaitRequest,
    ) -> Result<codex_code_mode::WaitOutcome, String>
```

**Purpose**: Waits for progress or completion from an already-running code-mode cell. This lets the model come back later for more output instead of blocking forever.

**Data flow**: It receives a wait request, retrieves the underlying session, forwards the request, and returns either a wait outcome or an error string.

**Call relations**: This is used by wait-style code-mode handling. Like execute and terminate, it goes through CodeModeService::session so unavailable code mode is reported cleanly.

*Call graph*: calls 1 internal fn (session).


##### `CodeModeService::terminate`  (lines 90–95)

```
async fn terminate(
        &self,
        cell_id: CellId,
    ) -> Result<codex_code_mode::WaitOutcome, String>
```

**Purpose**: Asks the code-mode runtime to stop a running cell. This gives the system a controlled way to cancel script work.

**Data flow**: It receives a cell ID, retrieves the underlying session, passes the termination request to it, and returns the final wait outcome or an error string.

**Call relations**: This is the stop path for code-mode cells. It uses CodeModeService::session before delegating to the underlying runtime session.

*Call graph*: calls 1 internal fn (session).


##### `CodeModeService::shutdown`  (lines 97–102)

```
async fn shutdown(&self) -> Result<(), String>
```

**Purpose**: Shuts down the underlying code-mode session if one exists. It is used when the service is being cleaned up.

**Data flow**: It checks whether a session is present. If so, it asks that session to shut down and returns its result; if not, it treats shutdown as already complete.

**Call relations**: This belongs to teardown. Unlike execute, wait, and terminate, it does not call CodeModeService::session because having no session is not an error during shutdown.


##### `CodeModeService::mark_cell_ready_for_dispatch`  (lines 104–106)

```
fn mark_cell_ready_for_dispatch(&self, cell_id: &codex_code_mode::CellId)
```

**Purpose**: Marks a code cell as ready to send nested tool calls through the dispatch broker. This is a signal that the cell can now participate in tool dispatch.

**Data flow**: It receives a cell ID and passes that ID to the broker, which records that dispatch may begin for that cell.

**Call relations**: This helps coordinate between the code runtime and the per-turn worker. The broker uses the mark later when routing nested tool calls from that cell.


##### `CodeModeService::finish_cell_dispatch`  (lines 108–110)

```
fn finish_cell_dispatch(&self, cell_id: &CellId)
```

**Purpose**: Closes dispatch for a code cell after its nested tool-call work is finished. This prevents later dispatch attempts for a cell that is done.

**Data flow**: It receives a cell ID and tells the dispatch broker to close that cell’s dispatch channel or state.

**Call relations**: This is the cleanup counterpart to mark_cell_ready_for_dispatch. It keeps the broker’s view of active cells accurate.


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

**Purpose**: Starts a worker for the current conversation turn when code mode is allowed. That worker is what lets running code cells call normal tools during the turn.

**Data flow**: It receives the session, turn context, tool router, and diff tracker. It checks the turn’s tool mode and whether code mode is available. If allowed, it builds an execution context and asks the dispatch broker to start a worker; otherwise it returns nothing.

**Call relations**: This is called during turn setup. It links the turn, session, router, and tracker together through the dispatch broker so nested code-mode tool calls can be processed during that turn.

*Call graph*: 2 external calls (clone, matches!).


##### `CodeModeService::session`  (lines 135–139)

```
fn session(&self) -> Result<&Arc<dyn CodeModeSession>, String>
```

**Purpose**: Returns the underlying code-mode session or a clear error if code mode is unavailable. It keeps availability checking in one place.

**Data flow**: It reads the optional session field. If a session exists, it returns a reference to it; if not, it returns the message “code mode is unavailable.”

**Call relations**: CodeModeService::execute, CodeModeService::wait, and CodeModeService::terminate all call this before talking to the runtime. That gives them the same failure behavior.

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

**Purpose**: Turns a raw runtime response from a code cell into normal function-tool output for the model. It adds status, timing, success information, cleaned image detail, and output truncation.

**Data flow**: It receives the execution context, a runtime response, an optional output-token limit, and the start time. It builds a human-readable status, converts runtime content into function-call output items, sanitizes image detail, adds script errors when needed, truncates oversized output, prepends a status-and-time header, and returns FunctionToolOutput.

**Call relations**: This is the main adapter after execute, wait, or terminate produces a runtime response. It calls format_script_status, sanitize_runtime_image_detail, truncate_code_mode_result, and prepend_script_status so the rest of the system receives clean, bounded, model-ready output.

*Call graph*: calls 6 internal fn (format_script_status, prepend_script_status, into_function_call_output_content_items, sanitize_runtime_image_detail, truncate_code_mode_result, from_content); 2 external calls (elapsed, format!).


##### `sanitize_runtime_image_detail`  (lines 188–190)

```
fn sanitize_runtime_image_detail(turn: &TurnContext, items: &mut [FunctionCallOutputContentItem])
```

**Purpose**: Adjusts image output from code mode so it follows what the current model is allowed to receive. This protects against giving original image detail when the model should not request it.

**Data flow**: It receives the current turn context and a mutable list of output items. It checks the model information to decide whether original image detail is allowed, then rewrites the image-detail fields in place as needed.

**Call relations**: handle_runtime_response calls this after converting runtime content into normal output items. It uses shared image-detail policy helpers so code-mode output follows the same rules as other tool output.

*Call graph*: called by 1 (handle_runtime_response); 2 external calls (can_request_original_image_detail, sanitize_original_image_detail).


##### `format_script_status`  (lines 192–206)

```
fn format_script_status(response: &RuntimeResponse) -> String
```

**Purpose**: Creates the short human-readable status line for a code cell result. It tells the model whether the script is still running, completed, failed, or was terminated.

**Data flow**: It receives a runtime response and inspects its variant. A yielded response becomes a message with the cell ID, a terminated response becomes “Script terminated,” and a final result becomes either “Script completed” or “Script failed.”

**Call relations**: handle_runtime_response calls this before shaping output. The returned text is later inserted at the top of the tool output by prepend_script_status.

*Call graph*: called by 1 (handle_runtime_response); 1 external calls (format!).


##### `prepend_script_status`  (lines 208–216)

```
fn prepend_script_status(
    content_items: &mut Vec<FunctionCallOutputContentItem>,
    status: &str,
    wall_time: Duration,
)
```

**Purpose**: Adds a header to the beginning of code-mode output. The header gives the script status, elapsed wall time, and a clear “Output” label.

**Data flow**: It receives the output item list, a status string, and elapsed time. It rounds the time to one decimal place, builds a text header, and inserts that header as the first output item.

**Call relations**: handle_runtime_response calls this at the end of output preparation. It makes code-mode results easier for the model and user to read before they see the raw script output.

*Call graph*: called by 1 (handle_runtime_response); 2 external calls (as_secs_f32, format!).


##### `truncate_code_mode_result`  (lines 218–234)

```
fn truncate_code_mode_result(
    items: Vec<FunctionCallOutputContentItem>,
    max_output_tokens: Option<usize>,
) -> Vec<FunctionCallOutputContentItem>
```

**Purpose**: Shortens code-mode output when it is too large for the model. This keeps long scripts from flooding the conversation with more text or data than the system can safely pass along.

**Data flow**: It receives output items and an optional token limit. It resolves the actual maximum, chooses a token-based truncation policy, then either uses a text-friendly truncation path when all items are plain text or a general function-output truncation path when mixed content is present. It returns the shortened item list.

**Call relations**: handle_runtime_response calls this before adding the final status header. The tests also check that text truncation produces a warning at the start, so users know output was shortened.

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

**Purpose**: Lets a running code-mode cell call another tool through the normal tool system. It also blocks the dangerous case where the exec tool tries to invoke itself.

**Data flow**: It receives execution context, a tool-call runtime, a nested tool invocation, and a cancellation token. It unpacks the invocation, rejects self-calls, builds the right tool payload from the supplied input, creates a normal ToolCall with a fresh call ID, sends it through the tool runtime with code-mode source information, and returns the result as JSON for code mode.

**Call relations**: This is the bridge from code-mode runtime back into the application’s tool router. It calls is_exec_tool_name for safety, build_nested_tool_payload for input shaping, and then hands the call to handle_tool_call_with_source so the ordinary tool machinery does the real work.

*Call graph*: calls 3 internal fn (build_nested_tool_payload, is_exec_tool_name, handle_tool_call_with_source); 2 external calls (format!, RespondToModel).


##### `build_nested_tool_payload`  (lines 278–287)

```
fn build_nested_tool_payload(
    tool_kind: CodeModeToolKind,
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<ToolPayload, String>
```

**Purpose**: Chooses how to package input for a nested tool call based on what kind of tool is being called. Function-style tools expect JSON arguments, while freeform tools expect a raw string.

**Data flow**: It receives a tool kind, tool name, and optional JSON input. If the kind is Function, it sends the input to build_function_tool_payload; if the kind is Freeform, it sends it to build_freeform_tool_payload. It returns either a ToolPayload or an error message.

**Call relations**: call_nested_tool uses this before dispatching a nested tool. The unit tests call it directly to confirm both function-style and freeform-style payloads are built correctly.

*Call graph*: calls 2 internal fn (build_freeform_tool_payload, build_function_tool_payload); called by 3 (call_nested_tool, build_nested_tool_payload_uses_freeform_kind, build_nested_tool_payload_uses_function_kind).


##### `build_function_tool_payload`  (lines 289–295)

```
fn build_function_tool_payload(
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<ToolPayload, String>
```

**Purpose**: Builds the payload for a normal function-style tool call. These tools receive their arguments as a JSON object encoded as text.

**Data flow**: It receives a tool name and optional JSON input. It serializes the input into an argument string using serialize_function_tool_arguments, then wraps that string in a function ToolPayload.

**Call relations**: build_nested_tool_payload calls this when the nested code-mode call targets a function-style tool. It delegates validation and JSON text conversion to serialize_function_tool_arguments.

*Call graph*: calls 1 internal fn (serialize_function_tool_arguments); called by 1 (build_nested_tool_payload).


##### `serialize_function_tool_arguments`  (lines 297–309)

```
fn serialize_function_tool_arguments(
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<String, String>
```

**Purpose**: Checks and serializes arguments for a function-style nested tool call. It enforces that arguments must be a JSON object, because that is the expected shape for function tools.

**Data flow**: It receives a tool name and optional JSON input. Missing input becomes an empty object string, object input is converted to compact JSON text, and any non-object input becomes a clear error naming the tool.

**Call relations**: build_function_tool_payload calls this as its validation step. If serialization fails or the input has the wrong shape, the error travels back through build_nested_tool_payload to call_nested_tool, which reports it to the model.

*Call graph*: called by 1 (build_function_tool_payload); 3 external calls (Object, format!, to_string).


##### `build_freeform_tool_payload`  (lines 311–319)

```
fn build_freeform_tool_payload(
    tool_name: &ToolName,
    input: Option<JsonValue>,
) -> Result<ToolPayload, String>
```

**Purpose**: Builds the payload for a freeform nested tool call. Freeform tools take a plain string rather than JSON-style named arguments.

**Data flow**: It receives a tool name and optional JSON input. If the input is a JSON string, it extracts that string and returns it as a custom ToolPayload; otherwise it returns an error saying the tool expects a string input.

**Call relations**: build_nested_tool_payload calls this when the nested tool kind is Freeform. Its validation errors flow back to call_nested_tool so bad nested tool requests can be explained to the model.

*Call graph*: called by 1 (build_nested_tool_payload); 1 external calls (format!).


##### `tests::build_nested_tool_payload_uses_function_kind`  (lines 332–346)

```
fn build_nested_tool_payload_uses_function_kind()
```

**Purpose**: Tests that function-style nested tool calls are packaged as function payloads with serialized JSON arguments. This guards the contract used when code mode calls ordinary function tools.

**Data flow**: It builds a sample function-kind payload with JSON input, checks that construction succeeds, then verifies the result contains the expected compact JSON argument string.

**Call relations**: This test calls build_nested_tool_payload directly. It protects the path that call_nested_tool uses for function-style nested calls.

*Call graph*: calls 2 internal fn (build_nested_tool_payload, plain); 3 external calls (assert_eq!, json!, panic!).


##### `tests::build_nested_tool_payload_uses_freeform_kind`  (lines 349–363)

```
fn build_nested_tool_payload_uses_freeform_kind()
```

**Purpose**: Tests that freeform nested tool calls preserve their string input. This guards the contract for tools that accept raw text instead of JSON arguments.

**Data flow**: It builds a sample freeform-kind payload with the string “hello,” checks that construction succeeds, then verifies the result is a custom payload containing that same string.

**Call relations**: This test calls build_nested_tool_payload directly. It protects the path that call_nested_tool uses for freeform nested calls.

*Call graph*: calls 2 internal fn (build_nested_tool_payload, plain); 3 external calls (assert_eq!, json!, panic!).


##### `tests::truncated_text_output_starts_with_warning`  (lines 366–382)

```
fn truncated_text_output_starts_with_warning()
```

**Purpose**: Tests that truncated text output clearly starts with a warning. This helps ensure users and the model are not misled into thinking shortened output is complete.

**Data flow**: It creates a long text output item, truncates it with a small token limit, and compares the result with the expected warning-plus-shortened-text format.

**Call relations**: This test exercises truncate_code_mode_result. It confirms the user-facing behavior that handle_runtime_response relies on when code-mode output is too large.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tools/code_mode/execute_spec.rs`

`domain_logic` · `tool setup`

Code Mode lets the model submit a block of source-like text as a tool call, rather than filling out a fixed form with named fields. This file creates the specification for that tool, which is like the instruction card handed to the model: it gives the tool’s name, explains what it can do, and defines the shape of input that is allowed.

The main detail here is a small grammar. A grammar is a set of rules for what text counts as valid input. This one accepts either plain source text, or source text that begins with a special comment line such as `// @exec:...`. That first line acts like a note on top of a document, giving extra execution instructions before the actual code begins.

The file also asks `codex_code_mode` to build the human-readable description of the tool. That description depends on which tools are enabled, what namespaces exist, whether the system is running in Code Mode only, and whether deferred tools are available.

Without this file, the execute tool would not be advertised in a clear, machine-checkable way. The model might not know how to call it, and the system would not have a single place defining the accepted free-form format.

#### Function details

##### `create_code_mode_tool`  (lines 7–37)

```
fn create_code_mode_tool(
    enabled_tools: &[CodeModeToolDefinition],
    namespace_descriptions: &BTreeMap<String, codex_code_mode::ToolNamespaceDescription>,
    code_mode_only: bool,
    deferred
```

**Purpose**: Builds the complete tool specification for the public Code Mode execute tool. Other parts of the system use this specification to tell the model what the tool is and what input format it must use.

**Data flow**: It receives the list of enabled Code Mode tools, namespace descriptions, and two feature flags. It uses that information to build a description string, combines it with the public tool name, and attaches a grammar that accepts either plain source text or source text with a leading `// @exec:` pragma line. It returns a `ToolSpec::Freeform`, meaning the tool accepts a free-form text body rather than a structured form.

**Call relations**: When the system is preparing the set of tools available to the model, it calls this function to create the Code Mode execute tool entry. Inside, it hands the contextual details to `build_exec_tool_description` so the description matches the current environment, then wraps everything in a `FreeformTool` so the wider tool system can advertise and validate it.

*Call graph*: 2 external calls (build_exec_tool_description, Freeform).


##### `tests::create_code_mode_tool_matches_expected_spec`  (lines 46–87)

```
fn create_code_mode_tool_matches_expected_spec()
```

**Purpose**: Checks that `create_code_mode_tool` produces exactly the expected tool specification for a simple example. This protects the tool name, description source, and grammar from accidental changes.

**Data flow**: It creates one fake enabled tool called `update_plan`, calls `create_code_mode_tool` with that list and empty namespace descriptions, then compares the result against a hand-written expected `ToolSpec::Freeform`. If any field differs, the test fails.

**Call relations**: This test runs during the project’s test suite. It directly exercises `create_code_mode_tool` and uses `assert_eq!` to confirm that the constructed tool specification still matches the contract that other parts of the system rely on.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tools/code_mode/execute_handler.rs`

`orchestration` · `request handling`

This file is the bridge between a model tool call and the code execution service. When the model asks to run code, the rest of the system needs a safe, predictable path from “here is some source text” to “the runtime started and returned a result, error, or yield.” Without this handler, code-mode tool calls would not know how to parse their input, which nested tools are available, how to start execution, or how to report the first runtime response back.

The main type is `CodeModeExecuteHandler`. It stores the tool’s public description, called a `ToolSpec`, plus the specs for tools that code running inside the runtime may be allowed to call. When a tool invocation arrives, `handle_call` checks that the payload is the expected custom raw source text. It then calls `execute`.

`execute` does the real handoff. First it parses the source text into execution settings, such as the code itself, output limits, and yield timing. Then it asks the code-mode service to start a cell, which is like opening a numbered notebook cell for one code run. It starts a trace so the system can later explain what happened, marks the cell ready to dispatch, waits for the initial runtime response, records that response, and finishes dispatch immediately if the runtime already ended. Finally, it delegates to `handle_runtime_response`, which converts the runtime response into the tool output returned to the model.

#### Function details

##### `CodeModeExecuteHandler::new`  (lines 22–27)

```
fn new(spec: ToolSpec, nested_tool_specs: Vec<ToolSpec>) -> Self
```

**Purpose**: Creates a new code-mode execute handler with the public tool description and the list of tools that code-mode execution may expose inside the runtime.

**Data flow**: It receives a `ToolSpec` and a list of nested `ToolSpec` values. It stores both inside a new `CodeModeExecuteHandler` and returns that handler for registration in the tool system.

**Call relations**: This is used when the tool runtime is being set up. Later, the stored spec is returned by `CodeModeExecuteHandler::spec`, and the nested specs are used by `CodeModeExecuteHandler::execute` to decide which tools are available to running code.


##### `CodeModeExecuteHandler::execute`  (lines 29–91)

```
async fn execute(
        &self,
        session: std::sync::Arc<crate::session::session::Session>,
        turn: std::sync::Arc<crate::session::turn_context::TurnContext>,
        call_id: String,
```

**Purpose**: Starts one code-mode execution and turns its first runtime response into model-visible tool output. This is the core path from raw source text to a recorded, dispatched code cell.

**Data flow**: It receives the current session, the current turn, the tool call ID, and the raw code text. It parses the text into executable code and settings, collects the tool definitions that should be available inside the runtime, asks the code-mode service to start a cell, starts trace recording, marks the cell ready, waits for the first runtime response, records that response, and then returns a `FunctionToolOutput`. If parsing or runtime startup fails, it turns the problem into an error that can be shown back to the model.

**Call relations**: `CodeModeExecuteHandler::handle_call` calls this after it has confirmed the tool invocation looks like a code execution request. Inside, it uses `parse_exec_source` to understand the requested execution, `collect_code_mode_tool_definitions` to prepare nested tools, and `handle_runtime_response` to translate the runtime’s answer into the format expected by the rest of the tool system.

*Call graph*: called by 1 (handle_call); 5 external calls (parse_exec_source, collect_code_mode_tool_definitions, matches!, now, handle_runtime_response).


##### `CodeModeExecuteHandler::tool_name`  (lines 95–97)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the public name of this tool so the registry can match incoming calls to this handler.

**Data flow**: It reads the fixed public tool name for code-mode execution, wraps it as a `ToolName`, and returns it. It does not change any stored state.

**Call relations**: The tool registry calls this when it needs to know which tool name this executor owns. It uses `ToolName::plain` to create the simple, non-namespaced name that incoming invocations are matched against.

*Call graph*: calls 1 internal fn (plain).


##### `CodeModeExecuteHandler::spec`  (lines 99–101)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the tool description that should be advertised to callers. The description tells the model how this tool is meant to be used.

**Data flow**: It reads the handler’s stored `ToolSpec`, clones it, and returns the copy. The original stays inside the handler for future calls.

**Call relations**: The tool system calls this when building or exposing the list of available tools. The value originally came from `CodeModeExecuteHandler::new`.

*Call graph*: 1 external calls (clone).


##### `CodeModeExecuteHandler::handle`  (lines 103–105)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts an incoming tool invocation into the asynchronous execution style expected by the tool framework.

**Data flow**: It receives a `ToolInvocation`, passes it to `CodeModeExecuteHandler::handle_call`, wraps the resulting future in a pinned box, and returns that future. In plain terms, it packages the work so the runtime can wait for it safely.

**Call relations**: The tool framework calls this through the `ToolExecutor` interface when a tool invocation arrives. It immediately hands the real decision-making to `CodeModeExecuteHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `CodeModeExecuteHandler::handle_call`  (lines 109–131)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Checks whether an invocation is a valid code-mode execute call, then either runs it or returns a clear error for the model.

**Data flow**: It receives a `ToolInvocation` and pulls out the session, turn, call ID, tool name, and payload. If the payload is custom raw input and the tool name is one of the accepted execute names, it sends the input to `CodeModeExecuteHandler::execute` and boxes the returned output. Otherwise, it returns an error saying the tool expects raw JavaScript source text.

**Call relations**: `CodeModeExecuteHandler::handle` calls this for every invocation routed to the handler. This function is the gatekeeper: it uses `is_exec_tool_name` to confirm the name, calls `CodeModeExecuteHandler::execute` for valid calls, and creates a model-facing error for invalid ones.

*Call graph*: calls 1 internal fn (execute); called by 1 (handle); 3 external calls (format!, is_exec_tool_name, RespondToModel).


##### `CodeModeExecuteHandler::matches_kind`  (lines 135–137)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Tells the core tool runtime that this handler is interested in custom tool payloads.

**Data flow**: It receives a payload reference, checks whether it is the custom payload shape, and returns `true` or `false`. It only inspects the payload type and does not modify anything.

**Call relations**: The core tool runtime can use this as an early filter before routing a call. A `true` result means the payload is shaped like something `CodeModeExecuteHandler::handle_call` may be able to process further.

*Call graph*: 1 external calls (matches!).


### `core/src/tools/code_mode/wait_spec.rs`

`io_transport` · `tool registration and tests`

This file is like the label and instruction card for a tool in a toolbox. The tool itself waits for more output from a running code execution cell, or can stop that cell. This file does not perform the waiting. Instead, it builds the formal tool specification that tells the surrounding API how the tool should be invoked.

The main function lists the tool’s input fields. A caller must provide a `cell_id`, which identifies the already-running execution cell. The caller may also provide `yield_time_ms`, which says how long to wait before returning more output, `max_tokens`, which limits how much output can be returned, and `terminate`, which asks the system to stop the running cell instead of waiting.

These fields are described using JSON Schema, a standard way to say “this input should be a string,” “this one should be a number,” and so on. The result is wrapped as a `ToolSpec`, which is the project’s common shape for tools exposed through the Responses API.

The test at the bottom protects this contract. If someone changes the tool name, wording, required fields, or allowed parameters by accident, the test will fail and make that change visible.

#### Function details

##### `create_wait_tool`  (lines 6–48)

```
fn create_wait_tool() -> ToolSpec
```

**Purpose**: Builds the official specification for the wait tool used in code mode. Other parts of the system use this specification to advertise the tool correctly and validate what inputs are allowed.

**Data flow**: It starts with no runtime input. It creates a map of parameter names to their expected shapes: `cell_id` as text, `yield_time_ms` and `max_tokens` as numbers, and `terminate` as true-or-false. It then combines those parameters with the tool name and description, and returns a complete `ToolSpec` that can be registered with the API.

**Call relations**: This function is called by `spec` when the larger tool list is being assembled. Inside, it relies on JSON Schema helper constructors such as `string`, `number`, `boolean`, and `object` to describe each accepted input, then wraps the finished definition as a function-style API tool.

*Call graph*: calls 4 internal fn (boolean, number, object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `tests::create_wait_tool_matches_expected_spec`  (lines 56–104)

```
fn create_wait_tool_matches_expected_spec()
```

**Purpose**: Checks that `create_wait_tool` still produces exactly the expected tool specification. This guards against accidental changes to the public contract of the wait tool.

**Data flow**: The test calls `create_wait_tool`, builds a second copy of the expected specification inline, and compares the two. If every field matches, nothing changes and the test passes. If anything differs, the assertion reports the mismatch.

**Call relations**: This test runs only during the test suite. It calls on the result of `create_wait_tool` indirectly through the comparison and uses `assert_eq!` to verify that the generated specification matches the fixed expected one.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/code_mode/wait_handler.rs`

`orchestration` · `code-mode request handling`

Code mode lets the system run code in cells, and a running cell may take time to finish. This file provides the tool handler for `wait`, which is how the model asks, “Has that cell produced more output yet?” or “Please stop that cell.” Without this file, code mode could start work but would not have this standard path for polling results, yielding partial output, or terminating a cell.

The main type is `CodeModeWaitHandler`. It registers itself as the handler for the `wait` tool and supplies the tool’s public shape, or specification, so callers know what arguments to send. Those arguments include the target `cell_id`, how long to wait before yielding control back, an optional output size limit, and a `terminate` flag.

When a `wait` call arrives, the handler first checks that it really is the plain `wait` tool and that its payload is JSON function arguments. It parses those arguments, builds an execution context from the current session and turn, then either asks the code-mode service to wait for the cell or to terminate it. If the cell has reached a final state, it also records trace information and tells the service that dispatch for that cell is finished. Finally, it converts the runtime response into the normal tool output format.

One important detail is that this tool deliberately opts out of pre- and post-tool hooks. The wait loop is internal runtime control, not a separate user-facing action, so outside hooks should not block it or rewrite its result.

#### Function details

##### `default_wait_yield_time_ms`  (lines 34–36)

```
fn default_wait_yield_time_ms() -> u64
```

**Purpose**: Provides the default amount of time the `wait` tool should pause before yielding control back. It is used when the caller does not include a custom `yield_time_ms` value.

**Data flow**: It takes no input. It reads the shared code-mode default wait time constant and returns that number as milliseconds.

**Call relations**: This function is tied to the JSON argument parsing for `ExecWaitArgs`. When a `wait` call omits `yield_time_ms`, deserialization uses this function so the rest of the handler always has a concrete wait duration to send to the runtime.


##### `parse_arguments`  (lines 38–45)

```
fn parse_arguments(arguments: &str) -> Result<T, FunctionCallError>
```

**Purpose**: Turns the raw JSON argument string from a tool call into a typed Rust value. If the JSON is invalid or does not match the expected shape, it produces an error that can be sent back to the model.

**Data flow**: It receives a text string containing JSON. It asks the JSON parser to convert that text into the requested data type. On success it returns the typed value; on failure it returns a `FunctionCallError` with a plain error message.

**Call relations**: `CodeModeWaitHandler::handle_call` uses this before doing any runtime work. This keeps bad tool calls from reaching the code-mode service and gives the model a clear explanation of what went wrong.

*Call graph*: called by 1 (handle_call); 1 external calls (from_str).


##### `CodeModeWaitHandler::tool_name`  (lines 48–50)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Identifies this handler as the owner of the plain `wait` tool name. The tool registry uses this to route matching tool calls here.

**Data flow**: It takes the handler itself as input. It wraps the shared `WAIT_TOOL_NAME` string as a plain tool name and returns it.

**Call relations**: The registry calls this when wiring tools together. Its returned name must match the check inside `CodeModeWaitHandler::handle_call`, so that registration and actual execution agree on which tool this handler serves.

*Call graph*: calls 1 internal fn (plain).


##### `CodeModeWaitHandler::spec`  (lines 52–54)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the public description of the `wait` tool, including what arguments it accepts. This lets the rest of the system expose the tool correctly to the model.

**Data flow**: It takes the handler itself as input. It calls the wait-tool specification builder and returns the resulting `ToolSpec`, which is the structured description of the tool.

**Call relations**: The tool registry calls this when it needs the tool definition. It delegates the detailed specification to `create_wait_tool`, keeping this file focused on execution behavior rather than schema construction.

*Call graph*: calls 1 internal fn (create_wait_tool).


##### `CodeModeWaitHandler::handle`  (lines 56–58)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling a `wait` tool invocation in the asynchronous tool-execution system. It wraps the real work in a future, which is a task that will complete later.

**Data flow**: It receives a `ToolInvocation`, which contains the session, turn, tool name, and payload. It passes that invocation to `CodeModeWaitHandler::handle_call` and returns a pinned asynchronous task that the executor can wait on.

**Call relations**: The tool runtime calls this when a `wait` invocation is dispatched to this handler. This function is a thin adapter: it hands off the actual logic to `CodeModeWaitHandler::handle_call` while matching the common `ToolExecutor` interface.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `CodeModeWaitHandler::handle_call`  (lines 62–132)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the actual `wait` tool work: validate the call, parse its arguments, wait for or terminate the requested code cell, record final-cell bookkeeping, and return the runtime result as tool output.

**Data flow**: It receives a full tool invocation. It pulls out the session, turn, tool name, and payload, then checks that the payload is JSON arguments for the plain `wait` tool. It parses those arguments into `ExecWaitArgs`, creates a code-cell ID, and records the start time. If `terminate` is true, it asks the code-mode service to stop the cell; otherwise it asks the service to wait for up to the requested yield time. If the response says a live cell has finished or terminated rather than merely yielded, it records that ending in the trace and marks the cell dispatch as finished. It then converts the runtime response into boxed tool output, applying any requested token limit. If anything fails, it returns an error message meant for the model.

**Call relations**: `CodeModeWaitHandler::handle` calls this as the real worker. It uses `parse_arguments` for safe input parsing, calls into the session’s `code_mode_service` to do the runtime wait or termination, updates trace and dispatch state when a cell closes, and finally hands the runtime result to `handle_runtime_response` so the output is shaped consistently with the rest of code mode.

*Call graph*: calls 2 internal fn (new, parse_arguments); called by 1 (handle); 5 external calls (format!, matches!, now, handle_runtime_response, RespondToModel).


##### `CodeModeWaitHandler::pre_tool_use_payload`  (lines 136–142)

```
fn pre_tool_use_payload(&self, _invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Prevents normal pre-tool hooks from running for code-mode `wait`. This matters because `wait` is internal runtime control, not a standalone action that should be blocked or rewritten.

**Data flow**: It receives the tool invocation but does not inspect it. It always returns `None`, meaning there is no pre-tool payload for hooks to act on.

**Call relations**: The core tool runtime asks for this before tool execution. By returning nothing, this handler keeps the code-mode wait loop flowing directly to `CodeModeWaitHandler::handle_call` instead of passing through hook behavior meant for ordinary model-facing tools.


##### `CodeModeWaitHandler::post_tool_use_payload`  (lines 144–152)

```
fn post_tool_use_payload(
        &self,
        _invocation: &ToolInvocation,
        _result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Prevents normal post-tool hooks from replacing or modifying the `wait` result. The returned result is part of code-mode control flow, so it must go back unchanged.

**Data flow**: It receives the invocation and the produced tool output, but it does not read or alter either one. It always returns `None`, meaning there is no post-tool payload to send through hook processing.

**Call relations**: The core tool runtime asks for this after tool execution. By returning nothing, it ensures the response created through `handle_runtime_response` remains the response that code mode sees, rather than being swapped for hook feedback intended for user-facing tool calls.


### Extension registry and standalone tool namespaces
These files define the shared extension registry and then wire in concrete standalone namespaces for web search, image generation, and goals.

### `ext/extension-api/src/registry.rs`

`orchestration` · `startup setup, then cross-cutting runtime lookups`

Extensions can add behavior at many points: when a thread starts or stops, when a turn begins, when tools run, when prompts are built, when token use is recorded, and more. This file gives all of those add-ons one organized home. Think of it like a theater stage manager’s clipboard: during setup, every helper writes down what job they can do; once the show starts, the clipboard is read-only so everyone sees a stable plan.

The file has two main parts. ExtensionRegistryBuilder is the temporary, mutable version used while extensions are being installed. It starts empty, or with a host-provided event sink, which is the place extensions can send events back to the host. Each registration method adds one contributor to the right list.

When setup is finished, build turns the builder into ExtensionRegistry. The registry is immutable, meaning its lists are no longer changed. Runtime code can then ask for the contributors it needs: tools, prompt context, lifecycle hooks, token tracking, and so on. One method, approval_review, does a little more than returning a list: it asks approval-review contributors in order and uses the first decision any contributor provides. Without this file, extension behavior would be scattered and hard to call consistently.

#### Function details

##### `ExtensionRegistryBuilder::default`  (lines 37–52)

```
fn default() -> Self
```

**Purpose**: Creates a fresh builder with no registered contributors and a do-nothing event sink. This gives hosts a safe starting point even when they have no extensions.

**Data flow**: No outside data comes in. It creates empty lists for every contribution type and stores a NoopExtensionEventSink, which ignores events. The result is a builder ready to receive registrations.

**Call relations**: ExtensionRegistryBuilder::new relies on this as the standard starting state. with_event_sink also uses it, then swaps in a real event sink while keeping all contributor lists empty.

*Call graph*: 2 external calls (new, new).


##### `ExtensionRegistryBuilder::new`  (lines 57–59)

```
fn new() -> Self
```

**Purpose**: Creates an empty extension registry builder. Hosts and tests use it when they want to start collecting extension contributions from scratch.

**Data flow**: It takes no input. It delegates to the default setup, producing a builder with empty contribution lists and a no-op event sink.

**Call relations**: This is the common entry point for setup code such as session creation and extension-related tests. Later, installer code adds contributors to the builder, and build turns it into the immutable registry.

*Call graph*: called by 22 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, prompt_extension_test_registry, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, plan_mode_uses_contributed_turn_item_for_last_agent_message, finalized_turn_item_defers_mailbox_for_contributed_visible_text, finalized_turn_item_keeps_mailbox_open_for_commentary_text, handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested (+12 more)); 1 external calls (default).


##### `ExtensionRegistryBuilder::with_event_sink`  (lines 62–67)

```
fn with_event_sink(event_sink: Arc<dyn ExtensionEventSink>) -> Self
```

**Purpose**: Creates an empty builder that uses a host-provided event sink. Use this when extensions need a real place to report events instead of silently dropping them.

**Data flow**: It receives a shared event sink. It starts from the default empty builder, replaces the default no-op sink with the provided one, and returns the customized builder.

**Call relations**: Setup code that cares about extension events calls this before installation begins. After that, installer code can fetch the sink with ExtensionRegistryBuilder::event_sink and pass it into extension constructors.

*Call graph*: called by 1 (orchestrator_catalog_snapshot_caches_failure); 1 external calls (default).


##### `ExtensionRegistryBuilder::event_sink`  (lines 70–72)

```
fn event_sink(&self) -> Arc<dyn ExtensionEventSink>
```

**Purpose**: Returns the event sink currently attached to the builder. Extension installers use it so newly created extensions can send events back to the host.

**Data flow**: It reads the builder’s stored shared event sink and returns another shared reference to the same sink. The builder keeps its own copy, and nothing is removed or changed.

**Call relations**: install_with_backend and install_with_providers call this while constructing extensions. It hands them the communication channel they need before they register their contributors.

*Call graph*: called by 2 (install_with_backend, install_with_providers); 1 external calls (clone).


##### `ExtensionRegistryBuilder::approval_review_contributor`  (lines 75–77)

```
fn approval_review_contributor(&mut self, contributor: Arc<dyn ApprovalReviewContributor>)
```

**Purpose**: Registers one contributor that can review an approval prompt and optionally return a decision. This lets extensions participate in yes/no-style approval flows.

**Data flow**: It receives a shared approval-review contributor and appends it to the builder’s approval-review list. The builder is changed by remembering that contributor for later.

**Call relations**: Although no specific caller is shown in the graph, this is the setup hook for approval review extensions. The stored contributors are later used by ExtensionRegistry::approval_review after build has frozen the registry.


##### `ExtensionRegistryBuilder::thread_lifecycle_contributor`  (lines 80–85)

```
fn thread_lifecycle_contributor(
        &mut self,
        contributor: Arc<dyn ThreadLifecycleContributor<C>>,
    )
```

**Purpose**: Registers one contributor that wants to be told about thread-level lifecycle events, such as resuming or stopping a thread. A thread here is a long-running conversation or work session.

**Data flow**: It receives a shared thread lifecycle contributor and adds it to the builder’s thread lifecycle list. Nothing is returned; the builder’s future registry now includes this contributor.

**Call relations**: Extension installation paths call this when an extension offers thread lifecycle behavior. Later, runtime code asks ExtensionRegistry::thread_lifecycle_contributors for the frozen list during thread resume and stop flows.

*Call graph*: called by 6 (install_with_backend, install, install, install, install_with_providers, install).


##### `ExtensionRegistryBuilder::turn_lifecycle_contributor`  (lines 88–90)

```
fn turn_lifecycle_contributor(&mut self, contributor: Arc<dyn TurnLifecycleContributor>)
```

**Purpose**: Registers one contributor that wants to be notified as a turn starts, stops, or errors. A turn is one round of interaction or work inside a thread.

**Data flow**: It receives a shared turn lifecycle contributor and appends it to the turn lifecycle list. The builder now carries that contributor forward into the final registry.

**Call relations**: install_with_backend uses this during extension setup. Runtime turn code later reads these contributors through ExtensionRegistry::turn_lifecycle_contributors when starting, stopping, or reporting errors for a turn.

*Call graph*: called by 1 (install_with_backend).


##### `ExtensionRegistryBuilder::config_contributor`  (lines 93–95)

```
fn config_contributor(&mut self, contributor: Arc<dyn ConfigContributor<C>>)
```

**Purpose**: Registers one contributor that can add or shape configuration. This lets extensions provide settings or adjust host setup in a typed, organized way.

**Data flow**: It receives a shared config contributor and stores it in the config contributor list. The builder is updated; no value is returned.

**Call relations**: Several install paths call this when extensions provide configuration behavior. The final registry exposes the collected contributors through ExtensionRegistry::config_contributors.

*Call graph*: called by 5 (install_with_backend, install, install, install_with_providers, install).


##### `ExtensionRegistryBuilder::token_usage_contributor`  (lines 98–100)

```
fn token_usage_contributor(&mut self, contributor: Arc<dyn TokenUsageContributor>)
```

**Purpose**: Registers one contributor interested in token usage reports. Tokens are the small text pieces counted when language models read or write text.

**Data flow**: It receives a shared token-usage contributor and appends it to the token usage list. The builder keeps it until build creates the read-only registry.

**Call relations**: install_with_backend registers these contributors during setup. Later, record_token_usage asks the registry for them through ExtensionRegistry::token_usage_contributors.

*Call graph*: called by 1 (install_with_backend).


##### `ExtensionRegistryBuilder::prompt_contributor`  (lines 103–105)

```
fn prompt_contributor(&mut self, contributor: Arc<dyn ContextContributor>)
```

**Purpose**: Registers one contributor that can add context to a prompt. In plain terms, it lets an extension add useful background before the model is asked to respond.

**Data flow**: It receives a shared context contributor and adds it to the context contributor list. The builder’s stored prompt-building helpers grow by one.

**Call relations**: Extension install flows call this when an extension can contribute prompt context. Later, contribute_prompt reads the final list through ExtensionRegistry::context_contributors.

*Call graph*: called by 3 (install, install, install_with_providers).


##### `ExtensionRegistryBuilder::mcp_server_contributor`  (lines 108–110)

```
fn mcp_server_contributor(&mut self, contributor: Arc<dyn McpServerContributor<C>>)
```

**Purpose**: Registers one contributor that can provide a runtime MCP server. MCP, or Model Context Protocol, is a way for tools and data sources to be exposed to the model through a standard interface.

**Data flow**: It receives a shared MCP server contributor and appends it to the MCP server list. The builder remembers it for the final registry.

**Call relations**: General extension installation and executor plugin installation call this when they add MCP-backed capabilities. The final registry later exposes these contributors through ExtensionRegistry::mcp_server_contributors.

*Call graph*: called by 2 (install, install_executor_plugins).


##### `ExtensionRegistryBuilder::turn_input_contributor`  (lines 113–115)

```
fn turn_input_contributor(&mut self, contributor: Arc<dyn TurnInputContributor>)
```

**Purpose**: Registers one contributor that can add or modify input for a turn. This lets extensions influence what information is fed into a round of work.

**Data flow**: It receives a shared turn-input contributor and stores it in the turn input list. The builder is updated and returns nothing.

**Call relations**: install_with_providers calls this during setup when a provider offers turn input behavior. Runtime code can later read the frozen list through ExtensionRegistry::turn_input_contributors.

*Call graph*: called by 1 (install_with_providers).


##### `ExtensionRegistryBuilder::tool_contributor`  (lines 118–120)

```
fn tool_contributor(&mut self, contributor: Arc<dyn ToolContributor>)
```

**Purpose**: Registers one contributor that provides native tools. A tool is a callable capability, such as reading data, running an action, or exposing a project-specific operation.

**Data flow**: It receives a shared tool contributor and appends it to the tool contributor list. That contributor will become available in the final registry.

**Call relations**: Multiple extension installation paths call this when extensions add tools. Later, the tools flow asks ExtensionRegistry::tool_contributors for the complete list.

*Call graph*: called by 5 (install_with_backend, install, install, install_with_providers, install).


##### `ExtensionRegistryBuilder::tool_lifecycle_contributor`  (lines 123–125)

```
fn tool_lifecycle_contributor(&mut self, contributor: Arc<dyn ToolLifecycleContributor>)
```

**Purpose**: Registers one contributor that wants to hear about tool lifecycle events, such as when a tool finishes. This is useful for logging, cleanup, or follow-up behavior around tool use.

**Data flow**: It receives a shared tool lifecycle contributor and adds it to the tool lifecycle list. The builder keeps it for the final registry.

**Call relations**: install_with_backend registers these contributors during setup. Later, notify_tool_finish gets the list from ExtensionRegistry::tool_lifecycle_contributors.

*Call graph*: called by 1 (install_with_backend).


##### `ExtensionRegistryBuilder::turn_item_contributor`  (lines 128–130)

```
fn turn_item_contributor(&mut self, contributor: Arc<dyn TurnItemContributor>)
```

**Purpose**: Registers one contributor that can add ordered items to a turn. Ordered means its output matters in sequence with other turn content.

**Data flow**: It receives a shared turn-item contributor and appends it to the turn item list. The builder now includes that contributor for the registry that will be built.

**Call relations**: No caller is shown in the graph, but this is the setup hook for extensions that add turn items. The final registry exposes these contributors through ExtensionRegistry::turn_item_contributors.


##### `ExtensionRegistryBuilder::build`  (lines 133–148)

```
fn build(self) -> ExtensionRegistry<C>
```

**Purpose**: Finishes setup and turns the mutable builder into a read-only registry. This is the moment extension registration closes.

**Data flow**: It consumes the builder, moving the event sink and every contributor list into a new ExtensionRegistry. After this, callers get an immutable registry instead of a builder they can keep changing.

**Call relations**: Setup code calls this after extension installers have added their pieces. Runtime code then uses the returned ExtensionRegistry to find contributors without worrying that the lists are changing underneath it.


##### `ExtensionRegistry::event_sink`  (lines 169–171)

```
fn event_sink(&self) -> Arc<dyn ExtensionEventSink>
```

**Purpose**: Returns the event sink stored in the finished registry. This lets runtime code or extensions share the same event-reporting channel after setup is complete.

**Data flow**: It reads the registry’s stored shared event sink and returns another shared reference to it. The registry keeps its own reference and does not change.

**Call relations**: This mirrors the builder’s event_sink method but works after build. It gives later code access to the host event channel without reopening registration.

*Call graph*: 1 external calls (clone).


##### `ExtensionRegistry::thread_lifecycle_contributors`  (lines 174–176)

```
fn thread_lifecycle_contributors(&self) -> &[Arc<dyn ThreadLifecycleContributor<C>>]
```

**Purpose**: Returns all registered thread lifecycle contributors. Runtime code uses this when it needs to notify extensions about thread-level events.

**Data flow**: It reads the registry’s thread lifecycle list and returns a borrowed view of it. Nothing is copied, removed, or changed.

**Call relations**: resume_thread and stop_thread call this when thread state changes. They receive the contributors that were registered earlier through the builder.

*Call graph*: called by 2 (resume_thread, stop_thread).


##### `ExtensionRegistry::turn_lifecycle_contributors`  (lines 179–181)

```
fn turn_lifecycle_contributors(&self) -> &[Arc<dyn TurnLifecycleContributor>]
```

**Purpose**: Returns all registered contributors interested in turn lifecycle events. This gives turn-running code one place to find every extension that needs turn notifications.

**Data flow**: It reads the turn lifecycle list and returns a borrowed view of the stored shared contributors. The registry remains unchanged.

**Call relations**: notify_turn_error, start_turn_with_mode, and stop_turn call this during turn execution. The method hands them the frozen list built during extension setup.

*Call graph*: called by 3 (notify_turn_error, start_turn_with_mode, stop_turn).


##### `ExtensionRegistry::config_contributors`  (lines 184–186)

```
fn config_contributors(&self) -> &[Arc<dyn ConfigContributor<C>>]
```

**Purpose**: Returns all registered configuration contributors. Code that builds or inspects configuration can use this list to include extension-provided settings.

**Data flow**: It reads the config contributor list and returns it as a borrowed slice. No contributor is run here; the method only exposes the list.

**Call relations**: The contributors in this list come from ExtensionRegistryBuilder::config_contributor. No specific caller is shown in the graph, but this is the read side of that registration path.


##### `ExtensionRegistry::token_usage_contributors`  (lines 189–191)

```
fn token_usage_contributors(&self) -> &[Arc<dyn TokenUsageContributor>]
```

**Purpose**: Returns all contributors that want token usage information. This supports extensions that track costs, quotas, analytics, or reporting around model usage.

**Data flow**: It reads the token usage contributor list and returns a borrowed view. It does not itself record usage; it only gives the caller the contributors to notify.

**Call relations**: record_token_usage calls this when token counts are available. The method supplies the contributors registered earlier through ExtensionRegistryBuilder::token_usage_contributor.

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

**Purpose**: Asks approval-review contributors whether any of them wants to decide an approval prompt. It returns the first decision provided, so contributors are tried in registration order.

**Data flow**: It receives session-level extension data, thread-level extension data, and the prompt text. It calls each approval-review contributor asynchronously, meaning it may wait for work to finish. If a contributor returns a ReviewDecision, that decision is returned immediately; if none do, the result is None.

**Call relations**: This is the runtime use of contributors registered by ExtensionRegistryBuilder::approval_review_contributor. Unlike most registry methods, it does not just return a list; it actively walks the list and stops at the first contributor that claims the review.


##### `ExtensionRegistry::context_contributors`  (lines 214–216)

```
fn context_contributors(&self) -> &[Arc<dyn ContextContributor>]
```

**Purpose**: Returns all contributors that can add context to prompts. Prompt-building code uses this so extensions can add useful background before a model request.

**Data flow**: It reads the context contributor list and returns a borrowed view of it. The contributors are not run inside this method.

**Call relations**: contribute_prompt calls this while assembling prompt content. The contributors were previously registered through ExtensionRegistryBuilder::prompt_contributor.

*Call graph*: called by 1 (contribute_prompt).


##### `ExtensionRegistry::mcp_server_contributors`  (lines 219–221)

```
fn mcp_server_contributors(&self) -> &[Arc<dyn McpServerContributor<C>>]
```

**Purpose**: Returns all contributors that can provide runtime MCP servers. These contributors expose tools or context through the Model Context Protocol.

**Data flow**: It reads the MCP server contributor list and returns a borrowed view. The registry remains unchanged and does not start any server itself.

**Call relations**: This is the read side of ExtensionRegistryBuilder::mcp_server_contributor. Runtime setup code can call it when it needs to discover MCP servers supplied by extensions.


##### `ExtensionRegistry::turn_input_contributors`  (lines 224–226)

```
fn turn_input_contributors(&self) -> &[Arc<dyn TurnInputContributor>]
```

**Purpose**: Returns all contributors that can affect input for a turn. This gives turn-preparation code access to extension-provided input additions.

**Data flow**: It reads the turn input contributor list and returns it by borrowed reference. It does not transform the input itself.

**Call relations**: The list is filled by ExtensionRegistryBuilder::turn_input_contributor, notably from provider-based installation. Later turn input assembly can ask this method for those contributors.


##### `ExtensionRegistry::tool_contributors`  (lines 229–231)

```
fn tool_contributors(&self) -> &[Arc<dyn ToolContributor>]
```

**Purpose**: Returns all contributors that provide native tools. Tool discovery code uses this list to know which extension tools are available.

**Data flow**: It reads the tool contributor list and returns a borrowed view of the shared contributors. No tools are executed here.

**Call relations**: The tools flow calls this when building or listing available tools. The list comes from registrations made through ExtensionRegistryBuilder::tool_contributor.

*Call graph*: called by 1 (tools).


##### `ExtensionRegistry::tool_lifecycle_contributors`  (lines 234–236)

```
fn tool_lifecycle_contributors(&self) -> &[Arc<dyn ToolLifecycleContributor>]
```

**Purpose**: Returns all contributors interested in tool lifecycle events. This lets the system notify extensions after important tool-use moments.

**Data flow**: It reads the tool lifecycle contributor list and returns a borrowed view. The registry does not call the contributors itself in this method.

**Call relations**: notify_tool_finish calls this when a tool has finished. It receives the contributors registered earlier through ExtensionRegistryBuilder::tool_lifecycle_contributor.

*Call graph*: called by 1 (notify_tool_finish).


##### `ExtensionRegistry::turn_item_contributors`  (lines 239–241)

```
fn turn_item_contributors(&self) -> &[Arc<dyn TurnItemContributor>]
```

**Purpose**: Returns all contributors that can add ordered items to a turn. This is used when turn content needs extension-provided pieces in a stable order.

**Data flow**: It reads the turn item contributor list and returns a borrowed view. Nothing is added or changed at this point.

**Call relations**: This exposes the contributors registered through ExtensionRegistryBuilder::turn_item_contributor. No specific caller is shown in the graph, but it is the runtime access point for those ordered turn-item extensions.


##### `empty_extension_registry`  (lines 245–247)

```
fn empty_extension_registry() -> Arc<ExtensionRegistry<C>>
```

**Purpose**: Creates a shared, empty registry for hosts that do not install any extensions. This gives the rest of the system a normal registry object instead of forcing it to handle a missing one.

**Data flow**: It takes no input. It creates a new empty builder, builds it into an empty registry, wraps it in a shared reference, and returns that shared registry.

**Call relations**: This is the convenience path for extension-free runs. It uses ExtensionRegistryBuilder::new and build so the empty case follows the same structure as the normal extension setup path.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


### `ext/web-search/src/lib.rs`

`orchestration` · `startup`

This file does not contain the web-search behavior itself. Instead, it tells Rust which internal source files make up the crate: the extension setup code, search history support, output formatting, schema definitions, and the tool implementation. Think of it like the table of contents at the front of a small manual: it does not explain every chapter, but it makes those chapters part of the book.

The most important line is the public re-export of `extension::install`. A re-export means outside code can call `install` directly from this crate, without needing to know that the function lives inside the internal `extension` module. That keeps the outside interface small and simple. Other parts of the system only need to know, “install the web-search extension,” not how the crate is organized behind the scenes.

Without this file, the crate would not know about its component modules, and callers would not have the clean public entry point they need to register or activate the web-search feature.


### `ext/web-search/src/extension.rs`

`orchestration` · `startup, thread start, config changes, and tool discovery`

This file is the bridge between Codex and its web search tool. Without it, the web search code might exist, but the main application would not know when to offer it, how to configure it, or how to create it with the right login and model provider.

The file keeps a small per-thread snapshot called WebSearchExtensionConfig. That snapshot says whether web search is available, which model provider should be used, and what search preferences apply. These preferences include things like approximate user location, how much search context to request, allowed domains, and whether live web access is allowed.

When a new conversation thread starts, the extension stores this snapshot in the thread's shared extension data. If the app configuration changes later, it refreshes the snapshot. When Codex asks what tools are available, the extension checks the stored snapshot. If web search is disabled, unavailable, or not using an OpenAI provider, it returns no tools. If it is available, it builds a WebSearchTool with the current session id, authentication manager, provider information, and search settings.

An everyday way to think about this file: it is the receptionist for web search. It checks whether web search is allowed, writes down the current instructions, and only then hands the user to the actual web search worker.

#### Function details

##### `WebSearchExtensionConfig::from`  (lines 38–47)

```
fn from(config: &Config) -> Self
```

**Purpose**: This builds the web search extension's private configuration snapshot from the main Codex configuration. It decides whether web search can be offered and gathers the provider and search settings that the tool will need later.

**Data flow**: It receives the full application Config. It reads the selected web search mode, checks whether the model provider is OpenAI, and calls search_settings to translate detailed web search preferences. It returns a WebSearchExtensionConfig containing an availability flag, provider information, and ready-to-use search settings.

**Call relations**: This is the common conversion step used whenever the extension needs fresh settings. WebSearchExtension::on_thread_start calls it when a conversation thread begins, and WebSearchExtension::on_config_changed calls it when the configuration changes. It hands off the detailed settings work to search_settings.

*Call graph*: calls 1 internal fn (search_settings); called by 2 (on_config_changed, on_thread_start).


##### `search_settings`  (lines 50–82)

```
fn search_settings(config: &Config, web_search_mode: WebSearchMode) -> SearchSettings
```

**Purpose**: This translates Codex's web search configuration into the SearchSettings format expected by the lower-level search API. It turns user-facing choices, like location and context size, into the exact fields the search provider understands.

**Data flow**: It receives the main Config and the chosen WebSearchMode. It looks for optional web search configuration such as approximate location, desired context size, and allowed domains. It copies those choices into a SearchSettings value, sets calls to be direct only, and marks external web access as true only for live search mode. The result is a complete SearchSettings object, with unspecified fields filled from defaults.

**Call relations**: This function is called only by WebSearchExtensionConfig::from. It is the detail translator in the flow: the higher-level config builder decides whether search is available, while this function prepares the exact search instructions that will later be passed into WebSearchTool.

*Call graph*: called by 1 (from); 2 external calls (default, vec!).


##### `WebSearchExtension::on_thread_start`  (lines 85–94)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: This prepares web search settings when a new conversation thread starts. It makes sure the thread has its own current web search configuration before any tools are requested.

**Data flow**: It receives ThreadStartInput, which includes the current Config and a thread-level storage area. It converts the Config into a WebSearchExtensionConfig and inserts that snapshot into the thread store. It returns an asynchronous future that completes after the snapshot is stored.

**Call relations**: The extension system calls this at thread startup because WebSearchExtension is registered as a thread lifecycle contributor. It relies on WebSearchExtensionConfig::from to build the snapshot that WebSearchExtension::tools will later read when deciding whether to offer the web search tool.

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

**Purpose**: This refreshes the stored web search settings when the application configuration changes. It prevents the web search tool from using stale choices after a user changes search mode, provider, location, or filters.

**Data flow**: It receives the session store, thread store, previous Config, and new Config. It ignores the session store and old configuration, converts the new Config into a fresh WebSearchExtensionConfig, and writes that into the thread store. The main output is the updated stored snapshot.

**Call relations**: The extension system calls this because WebSearchExtension is registered as a config contributor. Like thread startup, it uses WebSearchExtensionConfig::from. The refreshed data is later read by WebSearchExtension::tools when the app asks what tools are available.

*Call graph*: calls 2 internal fn (insert, from).


##### `WebSearchExtension::tools`  (lines 110–130)

```
fn tools(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>>
```

**Purpose**: This answers the question: should the web search tool be available right now, and if so, what tool object should Codex use? It is the gatekeeper that only exposes web search when the stored configuration says it is allowed.

**Data flow**: It receives session-level storage and thread-level storage. It looks in the thread store for WebSearchExtensionConfig. If no config is present, or if web search is marked unavailable, it returns an empty list. If web search is available, it creates a WebSearchTool using the session id, a model provider built from the stored provider and authentication manager, and the stored search settings. It returns that tool inside a list.

**Call relations**: The extension registry calls this when collecting available tools from contributors. It depends on the configuration snapshot written earlier by WebSearchExtension::on_thread_start or WebSearchExtension::on_config_changed. When enabled, it hands execution off to WebSearchTool, which is the object that actually performs web search calls.

*Call graph*: 2 external calls (new, vec!).


##### `install`  (lines 133–138)

```
fn install(registry: &mut ExtensionRegistryBuilder<Config>, auth_manager: Arc<AuthManager>)
```

**Purpose**: This registers the web search extension with the Codex extension registry. It is the setup step that tells the system this extension participates in thread startup, configuration changes, and tool discovery.

**Data flow**: It receives a mutable ExtensionRegistryBuilder and an AuthManager wrapped in Arc, which is a shared pointer that lets several parts of the program use the same login manager safely. It creates a WebSearchExtension holding that auth manager, then registers the same extension as a thread lifecycle contributor, config contributor, and tool contributor. It does not return a value; it changes the registry builder.

**Call relations**: This is called during extension setup, and in this file's test it is called by tests::installed_extension_contributes_web_run_when_enabled. The registrations made here are what allow the extension system to later call WebSearchExtension::on_thread_start, WebSearchExtension::on_config_changed, and WebSearchExtension::tools at the right times.

*Call graph*: calls 3 internal fn (config_contributor, thread_lifecycle_contributor, tool_contributor); called by 1 (installed_extension_contributes_web_run_when_enabled); 1 external calls (new).


##### `tests::installed_extension_contributes_web_run_when_enabled`  (lines 157–183)

```
fn installed_extension_contributes_web_run_when_enabled()
```

**Purpose**: This test proves that installing the extension makes the web search tool appear when the stored configuration says web search is available. It guards against accidentally registering the extension incorrectly or failing to expose the tool.

**Data flow**: It creates a fresh extension registry builder, installs the web search extension with a fake API-key login, and builds the registry. It creates session and thread stores, manually inserts a WebSearchExtensionConfig with availability set to true, then asks all registered tool contributors for their tools. It collects each tool's name and whether it supports parallel tool calls, then checks that the expected web run tool is present.

**Call relations**: This test calls install to exercise the same setup path used by the real application. After installation, it asks the registry's tool contributors to produce tools, which reaches WebSearchExtension::tools through the registry. The final assertion confirms that the installed extension contributes the expected namespaced web search tool.

*Call graph*: calls 5 internal fn (new, install, from_auth_for_testing, from_api_key, create_openai_provider); 3 external calls (default, new, assert_eq!).


### `ext/web-search/src/tool.rs`

`orchestration` · `request handling`

This file is the bridge between the model’s tool-call language and the actual hosted web search service. Without it, the model might ask to search, open a page, or find text on a page, but nothing would know how to interpret that request, send it to the search service, or show the user what happened.

The main piece is `WebSearchTool`, which implements the project’s `ToolExecutor` interface. That means it can advertise itself as the `web.run` tool, describe what inputs it accepts, and run when the model calls it. When a call arrives, the tool first reads the model’s JSON arguments and turns them into `SearchCommands`. It then gathers the current API provider and authentication details, builds an HTTP client, and sends a `SearchRequest` to the search service. The request includes the session id, model name, recent conversation input, the parsed commands, search settings, and a token limit.

The file also creates user-visible progress items. Before the network request, it emits a generic “web search started” item. After the search completes, it emits a more specific action, such as “search for these queries,” “open this URL,” or “find this text on this page.” A small set of helper functions exists mainly to make that progress display accurate and understandable.

#### Function details

##### `WebSearchTool::tool_name`  (lines 43–45)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the rest of the system the exact name of the tool: `web.run`. The name is how a model’s tool call is matched to this executor.

**Data flow**: It takes the tool object, reads no changing state from it, and combines the fixed namespace `web` with the fixed tool name `run`. The result is a `ToolName` value that other code can compare against incoming tool calls.

**Call relations**: When the extension framework asks what this executor is called, this method answers by using the shared `namespaced` helper. That lets later tool dispatch send `web.run` calls to this `WebSearchTool` instead of to some unrelated tool.

*Call graph*: calls 1 internal fn (namespaced).


##### `WebSearchTool::spec`  (lines 47–66)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This builds the public description of the web search tool, including its name, human-readable description, and the shape of the JSON input it accepts. The model uses this specification to know how to call the tool correctly.

**Data flow**: It starts with the command schema from `commands_schema`, parses it without removing field descriptions, and wraps it in a namespace called `web`. If the schema cannot be parsed, it stops with a panic because the built-in schema is expected to always be valid. The output is a `ToolSpec` that describes the `web.run` function.

**Call relations**: The extension framework calls this when it is collecting available tools. This method pulls in the schema, namespace description, and bundled tool description text, then hands back one complete advertised tool definition.

*Call graph*: calls 1 internal fn (commands_schema); 5 external calls (parse_tool_input_schema_without_compaction, default_namespace_description, panic!, Namespace, vec!).


##### `WebSearchTool::exposure`  (lines 68–70)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: This says the web search tool is directly available to the model. In plain terms, the model does not need to go through another wrapper tool to use it.

**Data flow**: It receives the tool object and returns the fixed value `ToolExposure::Direct`. It does not read or change any other data.

**Call relations**: During tool setup, the surrounding tool system asks how this tool should be exposed. This answer lets the system present `web.run` as a directly callable capability.


##### `WebSearchTool::supports_parallel_tool_calls`  (lines 72–74)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: This tells the system that more than one web search call may run at the same time. That matters when the model wants to search for several things without waiting for each one in sequence.

**Data flow**: It takes no input beyond the tool object and returns `true`. It does not modify the tool or any shared state.

**Call relations**: The tool runner checks this capability before deciding whether it can run multiple calls concurrently. This method gives permission for parallel execution.


##### `WebSearchTool::handle`  (lines 76–78)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: This is the entry point used when the model actually calls the web search tool. It wraps the real asynchronous work in the future type expected by the extension system.

**Data flow**: It receives a `ToolCall`, passes that call to `handle_call`, and pins the resulting asynchronous task so it can be polled safely by the runtime. The output is a future that will eventually produce either tool output or a tool-call error.

**Call relations**: The tool framework calls this after it has matched an incoming call to `web.run`. This method immediately hands the work to `WebSearchTool::handle_call`, which performs the parsing, API request, progress reporting, and result packaging.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `WebSearchTool::handle_call`  (lines 82–123)

```
async fn handle_call(&self, call: ToolCall) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: This performs one complete web search tool run. It turns the model’s request into a search service request, sends it, emits progress events, and returns the service’s output.

**Data flow**: It receives a `ToolCall` containing JSON arguments, model information, conversation history, a call id, and a token budget. It parses the arguments into search commands, decides what user-visible action best describes them, fetches API provider and authentication information, builds an HTTP search client, and creates a `SearchRequest`. It emits a started item, sends the request over the network, emits a completed item, and returns a boxed `SearchOutput`. If argument parsing should be shown to the model, or if provider, auth, or network work fails fatally, it returns a `FunctionCallError`.

**Call relations**: This is called by `WebSearchTool::handle`. It relies on `parse_commands` to understand the model’s JSON, `command_action` to summarize the action for progress reporting, `recent_input` to include relevant conversation context, `build_reqwest_client` and search client constructors to reach the hosted service, and `web_search_item` to create the turn items shown before and after the search.

*Call graph*: calls 8 internal fn (new, new, recent_input, new, command_action, parse_commands, web_search_item, build_reqwest_client); called by 1 (handle); 6 external calls (new, new, api_auth, api_provider, clone, try_from).


##### `parse_commands`  (lines 126–134)

```
fn parse_commands(call: &ToolCall) -> Result<SearchCommands, FunctionCallError>
```

**Purpose**: This reads the model’s tool arguments and turns them into structured search commands. It also treats empty arguments as a valid request with default commands.

**Data flow**: It receives a `ToolCall`, asks it for the raw function arguments, and checks whether the argument string is blank. Blank input becomes default `SearchCommands`; non-blank input is parsed as JSON. The result is either structured commands or an error that can be sent back to the model if the JSON is invalid.

**Call relations**: This helper is used by `WebSearchTool::handle_call` at the start of a tool run. Its job is to make sure the rest of the flow works with typed command data instead of raw text.

*Call graph*: called by 1 (handle_call); 3 external calls (default, function_arguments, from_str).


##### `command_action`  (lines 136–163)

```
fn command_action(commands: &SearchCommands) -> WebSearchAction
```

**Purpose**: This chooses the best short description of what the web command is doing, such as searching, opening a page, finding text, or something more general. That description is used for progress and history display.

**Data flow**: It receives structured `SearchCommands` and looks for the first meaningful action in priority order: text search, image search, opening a page, or finding text on a page. It extracts query text, a literal URL when one is present, or a find pattern. It returns a `WebSearchAction`, falling back to `Other` when no clear user-facing action can be shown.

**Call relations**: This is called by `WebSearchTool::handle_call` before the search request is sent. The returned action is later passed to `web_search_item` after the search completes, so the completed event can describe what actually happened.

*Call graph*: called by 1 (handle_call).


##### `query_action`  (lines 165–177)

```
fn query_action(queries: &[SearchQuery]) -> Option<WebSearchAction>
```

**Purpose**: This turns one or more search queries into a display-friendly search action. It keeps the single-query case simple and uses a list when there are multiple queries.

**Data flow**: It receives a slice of `SearchQuery` values. If the slice is empty, it returns nothing. If there is one query, it returns a `Search` action with that query in the single-query field. If there are several, it collects their text into a list and returns a multi-query `Search` action.

**Call relations**: This helper supports the action-summary work done by `command_action`. It keeps the query-specific formatting separate from the broader decision about whether the command is a search, open, find, or other action.

*Call graph*: 1 external calls (iter).


##### `literal_url`  (lines 179–181)

```
fn literal_url(ref_id: &str) -> Option<String>
```

**Purpose**: This checks whether a reference string is an actual URL. That distinction matters because some references point to prior search results, not directly to web addresses.

**Data flow**: It receives a string such as `https://example.com/docs` or `turn0search0`. It tries to parse the string as a URL. If parsing succeeds, it returns the original string as a URL; otherwise it returns nothing.

**Call relations**: This helper is used when building user-visible actions for open-page and find-in-page commands. It prevents internal result ids from being displayed as if they were real URLs.

*Call graph*: 1 external calls (parse).


##### `web_search_item`  (lines 183–189)

```
fn web_search_item(call_id: &str, action: WebSearchAction) -> ExtensionTurnItem
```

**Purpose**: This creates the turn-history item that represents a web search action. It is what lets the rest of the system show a clean “web search started/completed” record to the user.

**Data flow**: It receives a call id and a `WebSearchAction`. It turns the action into a readable detail string using `web_search_action_detail`, then packages the id, detail, and action into a `WebSearchItem` wrapped as an `ExtensionTurnItem`. The output is ready to emit into the conversation turn stream.

**Call relations**: This is called by `WebSearchTool::handle_call` both before and after the search request. The first call uses a generic action, and the second uses the more specific action chosen by `command_action`.

*Call graph*: called by 1 (handle_call); 2 external calls (web_search_action_detail, WebSearch).


##### `tests::command_action_reports_queries_and_navigation_detail`  (lines 200–240)

```
fn command_action_reports_queries_and_navigation_detail()
```

**Purpose**: This test checks that `command_action` reports search and navigation commands in the way the user interface expects. It protects against regressions where progress details become misleading or lose useful information.

**Data flow**: It defines several JSON command examples, parses each one into `SearchCommands`, runs `command_action`, and compares the result with the expected `WebSearchAction`. The cases cover multiple image queries, opening a literal URL, finding text at a literal URL, finding text through a search-result reference, and opening a non-URL reference.

**Call relations**: The test directly exercises `command_action`. It does not call the network-facing tool flow; instead, it focuses on the small but important translation from structured commands to user-visible action summaries.

*Call graph*: 3 external calls (assert_eq!, from_str, vec!).


### `ext/web-search/src/output.rs`

`io_transport` · `tool response handling`

When the web search extension finishes a search, it has a plain text answer. The rest of the system, however, does not pass around raw strings. It expects tool results to follow a shared shape, like putting a letter into the right envelope before sending it through the mail. This file defines that envelope for web search results.

The main type is `SearchOutput`. It stores one piece of text: the search output. By implementing `ToolOutput`, it tells the extension framework how this result should appear in logs, whether it counts as a successful tool result, whether it includes outside information, and how to convert it into a protocol message that can be fed back into the model.

A key detail is that `contains_external_context` returns true. That means this output is explicitly marked as information gathered from outside the current conversation or workspace. Another important detail is that `to_response_item` sends the search result as plain input text inside a function-call output message, preserving the original call ID so the response can be matched to the tool call that produced it.

The test at the bottom checks the most important contract: a search result becomes a plaintext function-call output with the expected call ID and text.

#### Function details

##### `SearchOutput::new`  (lines 12–14)

```
fn new(output: String) -> Self
```

**Purpose**: Creates a `SearchOutput` from the text produced by a web search. This is the simple starting point that packages raw search text into the type expected by the tool-output system.

**Data flow**: It receives a `String` containing the search result → stores that string inside a new `SearchOutput` value → returns the wrapped result so later code can log it or convert it into a response message.

**Call relations**: The web search call flow uses this after it has produced search text, and the test uses it to build a sample output. After creation, the value is typically passed through the `ToolOutput` methods, especially `to_response_item`, so the rest of Codex can receive the search result in the standard format.

*Call graph*: called by 2 (emits_plaintext_function_call_output, handle_call).


##### `SearchOutput::log_preview`  (lines 18–20)

```
fn log_preview(&self) -> String
```

**Purpose**: Returns a short, safe label for logs instead of printing the full search result. This helps logs show what kind of output was produced without dumping potentially long or sensitive external text.

**Data flow**: It reads no outside input beyond the `SearchOutput` value → ignores the stored search text → returns the fixed string `[standalone web search output]`.

**Call relations**: The extension framework can call this when it wants a brief logging preview of a tool result. It does not hand off to other code; it simply supplies a stable label for the larger logging flow.


##### `SearchOutput::success_for_logging`  (lines 22–24)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Tells the logging system that this web search output represents a successful result. It is a simple status signal used for reporting.

**Data flow**: It receives the current `SearchOutput` value → does not inspect the stored text → returns `true` to say the result should be logged as successful.

**Call relations**: The tool-output framework can ask this when recording what happened during a tool call. This method does not call other functions; it provides one small piece of status information to the broader logging machinery.


##### `SearchOutput::contains_external_context`  (lines 26–28)

```
fn contains_external_context(&self) -> bool
```

**Purpose**: Marks this output as containing information from outside the current local context. For web search, this matters because the text may come from the internet rather than from the conversation or project files.

**Data flow**: It receives the `SearchOutput` value → does not need to inspect the text because all web search results are external by nature → returns `true`.

**Call relations**: The extension framework can call this when deciding how to label, audit, or treat tool results. It acts as a clear flag to the rest of the system that this result includes outside context.


##### `SearchOutput::to_response_item`  (lines 30–39)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts the stored search text into the protocol message format used to return a tool result to the model. It keeps the original tool-call ID so the model can connect this output to the request that caused it.

**Data flow**: It receives the stored search output, a `call_id`, and a tool payload that is not needed here → copies the call ID and wraps the search text as an input-text content item → returns a `ResponseInputItem::FunctionCallOutput` containing that packaged text.

**Call relations**: After `SearchOutput::new` creates the output object, the tool framework calls this when it is time to feed the result back into the conversation. Inside, it uses `FunctionCallOutputPayload::from_content_items` to build the protocol payload from a list containing the plaintext search result.

*Call graph*: calls 1 internal fn (from_content_items); 1 external calls (vec!).


##### `tests::emits_plaintext_function_call_output`  (lines 54–73)

```
fn emits_plaintext_function_call_output()
```

**Purpose**: Checks that `SearchOutput` is converted into exactly the expected function-call output message. This protects the contract between the web search extension and the rest of the protocol.

**Data flow**: It creates a sample `SearchOutput` containing `search output` → asks it to become a response item for call ID `call-1` → compares the result with the exact expected protocol object, including the call ID and plaintext content.

**Call relations**: The test calls `SearchOutput::new` to build the example and then exercises `to_response_item` through the assertion. It serves as a safety check for the conversion behavior that production code relies on after a web search completes.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `ext/image-generation/src/lib.rs`

`orchestration` · `startup`

This is a small but important doorway file. In Rust projects, a `lib.rs` file usually defines what the library contains and what other parts of the program are allowed to use. Here, it says that the image-generation extension is made from three internal modules: `backend`, `extension`, and `tool`. Those modules likely contain the actual work: talking to an image service, registering the extension, and defining the tool users or agents can call.

The file then publicly re-exports `extension::install`. Re-exporting means it takes something defined deeper inside the crate and presents it at the crate’s front desk. That way, outside code can simply call the extension’s `install` function without knowing where it lives internally.

It also defines two shared names: the namespace `image_gen` and the tool name `imagegen`. These are like labels on a mailbox. Other parts of the extension can use the same labels when registering or looking up the image generation feature, which avoids mismatched strings scattered through the code. Without this file, the crate would not have a clear public entry point, and the extension’s pieces would be harder to connect consistently.


### `ext/image-generation/src/extension.rs`

`orchestration` · `thread startup, config changes, and tool discovery`

This file is the doorway between the image-generation code and the main Codex application. Without it, the image generator might exist as code, but Codex would not know when to offer it or how to build it for a conversation thread.

The file defines a small extension object, `ImageGenerationExtension`, which carries the current authentication manager. That matters because image generation is only exposed when the user is signed in through the Codex backend. It also defines `ImageGenerationExtensionConfig`, a small per-thread snapshot of the settings needed for image generation: whether it is allowed, which model provider to use, and where the user’s Codex home folder is.

When a new thread starts, the extension reads the main `Config` and stores this image-specific snapshot in the thread’s extension data. If the configuration changes later, it refreshes that snapshot. This is like keeping a small note card beside each conversation that says, “image generation is allowed here, using this provider, and saving relative to this home folder.”

When Codex asks what tools are available, this extension checks the note card and the login state. If image generation is not available, it returns no tools. If everything is allowed, it builds an `ImageGenerationTool` backed by a model provider and returns it to the core system.

#### Function details

##### `ImageGenerationExtensionConfig::from`  (lines 35–42)

```
fn from(config: &Config) -> Self
```

**Purpose**: This function turns the full Codex configuration into the smaller image-generation configuration needed for one thread. It decides whether image generation should be considered available and keeps the provider and home folder information needed later to build the tool.

**Data flow**: It receives a reference to the main `Config`. It reads the configured model provider, checks whether that provider is OpenAI, copies the provider information, and copies the Codex home path. It returns a new `ImageGenerationExtensionConfig` containing just those image-related details.

**Call relations**: This is used whenever the thread needs a fresh image-generation snapshot. The thread-start path calls it when a conversation begins, and the config-change path calls it again when settings are updated, so later tool creation sees current information.

*Call graph*: called by 2 (on_config_changed, on_thread_start).


##### `ImageGenerationExtension::on_thread_start`  (lines 47–56)

```
fn on_thread_start(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()>
```

**Purpose**: This function prepares image generation state when a new thread begins. It stores the thread’s initial image-generation settings so later parts of the system can quickly decide whether to offer the image tool.

**Data flow**: It receives startup input containing the current app configuration and the thread’s extension data store. It builds an `ImageGenerationExtensionConfig` from the configuration, then inserts that snapshot into the thread store. It does not return data to the caller beyond completing the asynchronous setup.

**Call relations**: The extension system calls this at the beginning of a thread because this file registered itself as a thread lifecycle contributor. It relies on `ImageGenerationExtensionConfig::from` to make the per-thread snapshot, which `ImageGenerationExtension::tools` later reads when Codex asks which tools are available.

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

**Purpose**: This function updates the stored image-generation settings after the thread’s configuration changes. It prevents the image tool from being offered using stale provider or availability information.

**Data flow**: It receives the old and new configurations plus extension data stores. It ignores the session-wide store and the previous configuration, reads the new configuration, creates a fresh `ImageGenerationExtensionConfig`, and replaces or inserts that value in the thread store. Its visible effect is the updated thread-local snapshot.

**Call relations**: The extension system calls this when configuration changes because this file registered the extension as a config contributor. It uses the same conversion helper as thread startup, so both first-time setup and later refreshes follow the same rule.

*Call graph*: calls 2 internal fn (insert, from).


##### `ImageGenerationExtension::tools`  (lines 74–94)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: This function answers the question, “Should this thread have an image-generation tool right now, and if so, what tool object should Codex use?” It is the gatekeeper that only exposes image generation when both configuration and authentication allow it.

**Data flow**: It receives session and thread extension data. It looks in the thread store for `ImageGenerationExtensionConfig`; if none is present, it returns an empty list. If image generation is marked unavailable, or the current login is not using the Codex backend, it also returns an empty list. Otherwise, it creates a model provider with the saved provider settings and authentication manager, wraps that in a `CodexImagesBackend`, builds an `ImageGenerationTool` with the backend, Codex home path, and thread identifier, and returns that tool in a list.

**Call relations**: The core tool system calls this after the extension has been installed as a tool contributor. It depends on the thread-start and config-change functions having stored the per-thread image-generation config. When the checks pass, it hands off actual image work to `ImageGenerationTool` and `CodexImagesBackend`; this function only decides whether and how to construct them.

*Call graph*: 2 external calls (new, vec!).


##### `install`  (lines 98–103)

```
fn install(registry: &mut ExtensionRegistryBuilder<Config>, auth_manager: Arc<AuthManager>)
```

**Purpose**: This function registers the image-generation extension with the Codex extension registry. It is the setup hook that makes the extension participate in thread startup, configuration changes, and tool discovery.

**Data flow**: It receives the shared extension registry builder and an authentication manager. It creates one shared `ImageGenerationExtension` containing that authentication manager, then registers the same extension object for three jobs: thread lifecycle events, configuration updates, and tool contribution. It changes the registry so the rest of the application will call this extension at the right times.

**Call relations**: Startup or extension setup code calls this to install image generation into Codex. After this function runs, the registry knows to call `ImageGenerationExtension::on_thread_start` when threads begin, `ImageGenerationExtension::on_config_changed` when settings change, and `ImageGenerationExtension::tools` when tools are requested.

*Call graph*: calls 3 internal fn (config_contributor, thread_lifecycle_contributor, tool_contributor); 1 external calls (new).


### `ext/image-generation/src/tool.rs`

`domain_logic` · `request handling`

This file is the bridge between a model saying “make or edit an image” and the image service actually doing it. Without it, the image-generation extension would not know how to advertise itself to the model, read the model’s arguments, collect reference images, call the backend image API, or package the result back into the conversation.

The main type is ImageGenerationTool. It stores the image backend, the Codex home folder, and the current conversation thread id. When the tool is called, it first parses the model’s JSON arguments: a prompt, optional file paths for reference images, or a request to reuse recent images from the conversation. If there are no references, it builds a plain “generate” request. If there are references, it builds an “edit” request. Reference images can come from disk, where they are read through the session’s file-system sandbox, or from earlier conversation items.

The tool then emits an “in progress” event, calls the backend, and emits either a failed or completed event. The generated image is kept as base64 text, wrapped as a data URL when returned, and accompanied by a hint about where the image artifact should be saved. A small output type, GeneratedImageOutput, controls how the result appears in logs, code mode, and follow-up model input.

#### Function details

##### `ImageGenerationTool::new`  (lines 60–70)

```
fn new(
        backend: CodexImagesBackend,
        codex_home: AbsolutePathBuf,
        thread_id: String,
    ) -> Self
```

**Purpose**: Creates a ready-to-use image-generation tool. It remembers which backend to call, where Codex stores files, and which conversation thread this tool belongs to.

**Data flow**: The caller provides a backend, a Codex home path, and a thread id. The function stores those three pieces inside a new ImageGenerationTool and returns it. It does not contact the image service or read any files.

**Call relations**: This is used during setup, when the extension is building the tool object that will later be exposed to the model. The stored values are later used by ImageGenerationTool::handle_call when an actual image request arrives.


##### `ImageGenerationTool::tool_name`  (lines 85–87)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the official namespaced name of this tool. A namespace is like a folder label that keeps tool names from colliding with other tools.

**Data flow**: It reads the fixed image-generation namespace and tool-name constants, combines them into a ToolName, and returns that value. Nothing else changes.

**Call relations**: The tool framework calls this when it needs to identify the tool. This function delegates the name formatting to the shared namespaced helper so the name matches the rest of the Responses API tool surface.

*Call graph*: calls 1 internal fn (namespaced).


##### `ImageGenerationTool::spec`  (lines 90–92)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes to the model what inputs this tool accepts and what the tool is for. This is the contract the model sees before it decides to call the tool.

**Data flow**: It takes no outside input beyond the tool itself. It calls imagegen_tool_spec to build the schema and description, then returns that ToolSpec.

**Call relations**: The tool framework calls this while advertising available tools. The detailed construction is handed off to imagegen_tool_spec so the public trait method stays small.

*Call graph*: calls 1 internal fn (imagegen_tool_spec).


##### `ImageGenerationTool::exposure`  (lines 95–97)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Says that this tool is directly available to the model. In plain terms, the model does not need to go through another wrapper tool to use it.

**Data flow**: It returns the fixed exposure value ToolExposure::Direct. It reads no call data and changes nothing.

**Call relations**: The tool framework uses this during tool registration or selection. It affects how the image-generation tool is surfaced to the model.


##### `ImageGenerationTool::handle`  (lines 100–102)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing one image-generation tool call. It wraps the real async work so it fits the common ToolExecutor interface.

**Data flow**: It receives a ToolCall from the framework, passes it to handle_call, boxes and pins the future so the framework can await it, and returns that future. Pinning here means keeping the async task safely in place while it runs.

**Call relations**: The tool framework calls this when the model invokes the image tool. It immediately hands the real work to ImageGenerationTool::handle_call.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ImageGenerationTool::handle_call`  (lines 106–168)

```
async fn handle_call(&self, call: ToolCall) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Runs a complete image request from start to finish. It parses the model’s request, chooses generation or editing, calls the image backend, reports progress, and returns the final image output.

**Data flow**: It receives a ToolCall containing JSON arguments, conversation history, environments, ids, and an event emitter. It parses the arguments, builds either a generate or edit request, emits an in-progress item, calls the backend, extracts the first returned base64 image, emits success or failure, computes an artifact path and output hint, and returns a GeneratedImageOutput. On errors, it returns a message meant for the model instead of pretending the call succeeded.

**Call relations**: ImageGenerationTool::handle calls this for every actual tool invocation. It relies on parse_args for input parsing, request_for_call_args for deciding what kind of image request to make, and the backend’s generate or edit operation for the real image work. At the end, it hands back GeneratedImageOutput, which later formats the result for logs, code mode, and model follow-up.

*Call graph*: calls 4 internal fn (edit, generate, parse_args, request_for_call_args); called by 1 (handle); 6 external calls (new, new, extension_image_generation_output_hint, image_generation_artifact_path, RespondToModel, ImageGeneration).


##### `request_for_call_args`  (lines 177–246)

```
async fn request_for_call_args(
    args: &ImagegenArgs,
    history: &[ResponseItem],
    environments: &[ToolEnvironment],
) -> Result<ImageRequest, FunctionCallError>
```

**Purpose**: Decides whether the tool call should create a fresh image or edit existing images. It also gathers and checks any reference images the model asked to use.

**Data flow**: It receives parsed arguments, conversation history, and available tool environments. If no reference images are requested, it builds a Generate request with the prompt. If file paths are provided, it reads and converts those files into image URLs. If the model asks for recent conversation images, it searches history for them. It rejects invalid combinations, such as asking for both file paths and recent images, or asking for too many images.

**Call relations**: ImageGenerationTool::handle_call calls this after parsing arguments. It calls image_url when references come from disk and recent_images when references come from the conversation. Its result tells handle_call whether to call the backend’s generate or edit method.

*Call graph*: calls 2 internal fn (image_url, recent_images); called by 1 (handle_call); 6 external calls (with_capacity, Edit, Generate, format!, RespondToModel, first).


##### `recent_images`  (lines 248–324)

```
fn recent_images(history: &[ResponseItem], count: usize) -> Vec<ImageUrl>
```

**Purpose**: Finds the most recent images in the conversation so they can be used as edit references. This lets the model say, in effect, “edit the last image” without needing a file path.

**Data flow**: It receives the conversation history and a requested count. It first records which function and custom tool call ids are real calls, so it can trust their matching outputs. Then it walks backward through history, collecting image URLs from messages, completed tool outputs, and prior image-generation results. It stops once it has enough images, reverses them back into normal chronological order, and returns them.

**Call relations**: request_for_call_args calls this when the user or model asks to include recent conversation images. recent_images uses output_image_urls to pull image entries out of tool-output payloads. The returned images become the input list for an image edit request.

*Call graph*: calls 1 internal fn (output_image_urls); called by 1 (request_for_call_args); 5 external calls (new, new, with_capacity, format!, iter).


##### `output_image_urls`  (lines 327–338)

```
fn output_image_urls(output: &FunctionCallOutputPayload) -> impl Iterator<Item = String> + '_
```

**Purpose**: Extracts image URLs from a tool output payload. It ignores text and encrypted content because only images can be used as visual references.

**Data flow**: It receives one function-call output payload. It looks through its content items from newest to oldest, keeps only input-image items, clones their image URLs, and yields those strings as an iterator.

**Call relations**: recent_images calls this while scanning conversation history. It is a focused helper that knows the shape of function-call output content, so recent_images does not need to repeat that filtering logic.

*Call graph*: calls 1 internal fn (content_items); called by 1 (recent_images).


##### `image_url`  (lines 340–367)

```
async fn image_url(
    path: &AbsolutePathBuf,
    environment: &ToolEnvironment,
) -> Result<ImageUrl, FunctionCallError>
```

**Purpose**: Reads an image file from the session’s file system and converts it into a data URL suitable for the image API. A data URL is text that contains both the image type and the encoded image bytes.

**Data flow**: It receives an absolute path and a tool environment. It turns the path into a path URI, reads the file through the environment’s sandboxed file system, loads and validates the image bytes, preserves the original image mode, converts the image into a data URL, and returns it inside an ImageUrl. If reading or processing fails, it returns a clear error for the model.

**Call relations**: request_for_call_args calls this for each referenced file path. This helper is where disk access and image decoding happen before the edit request is sent to the backend.

*Call graph*: calls 2 internal fn (as_path, from_abs_path); called by 1 (request_for_call_args); 1 external calls (load_for_prompt_bytes).


##### `parse_args`  (lines 370–373)

```
fn parse_args(call: &ToolCall) -> Result<ImagegenArgs, FunctionCallError>
```

**Purpose**: Turns the model’s raw JSON tool arguments into the strongly shaped ImagegenArgs structure. This catches malformed or unexpected input early.

**Data flow**: It receives a ToolCall, asks it for its function-argument string, and parses that string as JSON. If parsing succeeds, it returns ImagegenArgs. If the JSON is invalid or does not match the expected fields, it returns an error message that can be shown to the model.

**Call relations**: ImageGenerationTool::handle_call calls this at the very start of a request. The parsed result is then passed to request_for_call_args to build the real image API request.

*Call graph*: called by 1 (handle_call); 2 external calls (function_arguments, from_str).


##### `imagegen_tool_spec`  (lines 376–406)

```
fn imagegen_tool_spec() -> ToolSpec
```

**Purpose**: Builds the tool description and input schema that are shown to the model. The schema is the machine-readable rulebook for what arguments the tool accepts.

**Data flow**: It generates a JSON schema from ImagegenArgs, keeps the parts needed for tool parameters, and combines them with the namespace name, human description, tool name, and strictness setting. It returns a ToolSpec describing one image-generation function inside the image-generation namespace.

**Call relations**: ImageGenerationTool::spec calls this when the framework asks what the tool looks like. The function uses shared schema and namespace helpers so this tool is advertised in the same format as other Responses API tools.

*Call graph*: called by 1 (spec); 7 external calls (new, draft2019_09, default_namespace_description, to_value, Namespace, unreachable!, vec!).


##### `GeneratedImageOutput::log_preview`  (lines 415–417)

```
fn log_preview(&self) -> String
```

**Purpose**: Provides a safe, short log message for a generated image. It avoids putting the full image bytes into telemetry or logs.

**Data flow**: It ignores the stored base64 image and returns the fixed string "[generated image]". No state changes.

**Call relations**: The tool framework calls this when recording or displaying a preview of tool output. Other GeneratedImageOutput methods still provide the actual image where it is needed.


##### `GeneratedImageOutput::success_for_logging`  (lines 420–422)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Tells the logging system that this output represents a successful tool call. It is a simple yes/no signal for logs.

**Data flow**: It reads no external input and returns true. It does not inspect the image because this output type is only created after a successful backend result.

**Call relations**: The tool framework calls this while logging the completed tool call. Failure cases are handled earlier in ImageGenerationTool::handle_call and do not produce this output object.


##### `GeneratedImageOutput::code_mode_result`  (lines 425–437)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> Value
```

**Purpose**: Formats the generated image for code mode, especially for helpers such as generatedImage(). It returns a JSON object with the image as a data URL and, when available, a hint about saving or locating the artifact.

**Data flow**: It reads the stored base64 image and optional output hint. It builds a JSON object whose image_url field starts with data:image/png;base64, followed by the image data. If an output hint exists, it adds that too. The payload argument is not used.

**Call relations**: The tool framework calls this when code-mode tooling needs a structured result. It complements to_response_item, which formats the same image for conversation follow-up instead of code consumption.

*Call graph*: 4 external calls (from_iter, Object, String, format!).


##### `GeneratedImageOutput::to_response_item`  (lines 440–457)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Formats the generated image as a response item that can be fed back into the model. This lets the model see the image result and continue reasoning about it.

**Data flow**: It receives the original call id and reads the stored image and optional output hint. It creates a function-call output containing an input-image item with the base64 data URL and default image detail. If there is an output hint, it adds a text item after the image. It marks the output as successful and returns the response item.

**Call relations**: The tool framework calls this after ImageGenerationTool::handle_call returns GeneratedImageOutput. The returned item becomes part of the conversation history, where later requests can also find it through recent_images.

*Call graph*: 2 external calls (ContentItems, vec!).


### `ext/goal/src/lib.rs`

`orchestration` · `cross-cutting`

This file does not contain the goal feature’s behavior itself. Instead, it acts like the index page of a small library. The real work is split into nearby modules: accounting, analytics, API types, events, runtime support, tool definitions, steering logic, and more. By declaring those modules here, the Rust compiler knows they are part of this crate.

The second half of the file chooses what outsiders can import directly from the crate. For example, callers can use `GoalService` to work with goals, `GoalExtension` and `install_with_backend` to install the feature, tool-name constants such as `CREATE_GOAL_TOOL_NAME`, and request or update types such as `GoalSetRequest` and `GoalObjectiveUpdate`.

This matters because it keeps the rest of the codebase from depending on the extension’s private layout. Other code can say, in effect, “give me the goal service” without needing to know which internal file defines it. Like a shop counter, this file presents the approved products up front while the storage room stays organized behind the scenes. Without it, users of the crate would either be unable to reach the goal feature’s public pieces or would have to import them through brittle internal paths.


### `ext/goal/src/tool.rs`

`domain_logic` · `request handling`

This file is the front door for the goal feature when a model or extension calls a goal tool. A “goal” is a thread-level objective with a status, optional token budget, and recorded usage. Without this file, callers could not safely create, read, or finish goals through the tool system, and the rest of the product would miss important side effects like budget tracking, metrics, analytics, and update events.

The main piece is `GoalToolExecutor`. Each executor is made for one kind of tool: get, create, or update. When a tool call arrives, the executor chooses the right path. Getting a goal simply reads stored state and formats it for the protocol. Creating a goal checks the requested objective and budget, stores a new active goal only if there is not already an unfinished one, fills the thread preview if it was blank, starts accounting for the current turn, and emits metrics, analytics, and a goal-updated event. Updating is more guarded: the tool can only mark a goal complete or blocked. Before changing status, it records the progress made during the active turn so token and time usage are not lost.

A useful analogy is a checkout counter: the request comes in, the file checks that the item is allowed, updates the register, prints the receipt, and notifies the store systems that the sale happened.

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

**Purpose**: Creates a goal-tool executor configured for the “get goal” tool. Other setup code uses this when it wants a tool that can read the current thread goal.

**Data flow**: It receives the thread id, state database, accounting state, analytics, event emitter, and metrics objects. It stores those shared pieces together with the “Get” kind, and returns a ready-to-use executor.

**Call relations**: This is one of the constructor-style entry points for this file. Later, when the tool framework asks this executor for its name, spec, or behavior, the stored “Get” kind tells the shared methods to use the get-goal path.


##### `GoalToolExecutor::create`  (lines 95–112)

```
fn create(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: G
```

**Purpose**: Creates a goal-tool executor configured for the “create goal” tool. Setup code uses it when it wants a tool that can start a new goal for a thread.

**Data flow**: It takes the same shared services as the other constructors, records the thread it belongs to, marks the executor kind as “Create”, and returns the executor.

**Call relations**: This prepares the object that the tool framework will later call. The common `handle` method uses this kind value to send incoming calls to `GoalToolExecutor::handle_create`.


##### `GoalToolExecutor::update`  (lines 114–131)

```
fn update(
        thread_id: ThreadId,
        state_db: Arc<codex_state::StateRuntime>,
        accounting_state: Arc<GoalAccountingState>,
        analytics: GoalAnalytics,
        event_emitter: G
```

**Purpose**: Creates a goal-tool executor configured for the “update goal” tool. It is used when the system needs a tool that can mark an existing goal complete or blocked.

**Data flow**: It receives the thread id and shared service objects, stores them, marks the executor kind as “Update”, and returns the executor.

**Call relations**: This is setup for the update route. When the tool framework later invokes the executor, `GoalToolExecutor::handle` sees the “Update” kind and calls `GoalToolExecutor::handle_update`.


##### `GoalToolExecutor::tool_name`  (lines 135–141)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Tells the tool framework the public name of this particular goal tool. The name is how a caller knows whether it is calling get, create, or update.

**Data flow**: It reads the executor’s stored kind, chooses the matching tool-name constant, wraps it as a plain tool name, and returns it.

**Call relations**: The tool framework calls this while registering or identifying tools. It does not perform the tool action itself; it only labels the executor so calls can be routed correctly.

*Call graph*: calls 1 internal fn (plain).


##### `GoalToolExecutor::spec`  (lines 143–149)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of the tool, including what arguments it accepts. This lets callers know how to shape their request.

**Data flow**: It checks whether this executor is for get, create, or update, then calls the matching spec-building function and returns the resulting tool specification.

**Call relations**: The tool framework asks for this during tool setup or advertisement. The function delegates to the spec module, which owns the exact schemas for the three goal tools.

*Call graph*: calls 3 internal fn (create_create_goal_tool, create_get_goal_tool, create_update_goal_tool).


##### `GoalToolExecutor::handle`  (lines 151–159)

```
fn handle(&self, invocation: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: Receives an actual tool call and sends it to the correct goal operation. It is the shared dispatcher for get, create, and update.

**Data flow**: It takes a `ToolCall`, wraps asynchronous work in a future, checks the executor kind, and calls the matching private handler. The output is either a boxed tool result or an error the tool framework can report.

**Call relations**: The tool framework calls this when a user or model invokes the tool. From here, the flow branches to `GoalToolExecutor::handle_get`, `GoalToolExecutor::handle_create`, or `GoalToolExecutor::handle_update`.

*Call graph*: calls 3 internal fn (handle_create, handle_get, handle_update); 1 external calls (pin).


##### `GoalToolExecutor::handle_get`  (lines 163–178)

```
async fn handle_get(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Reads the current goal for the thread and returns it as a tool response. This is the simplest goal action: it does not change stored state.

**Data flow**: It receives the tool call, extracts its argument text to catch malformed calls, reads the thread’s goal from the state database, converts any stored goal into the public protocol shape, and packages it as JSON. If the database read fails, it returns a message meant for the model.

**Call relations**: `GoalToolExecutor::handle` calls this for get-goal invocations. It hands the final formatting to `goal_response`, so all goal tools return the same response shape.

*Call graph*: calls 1 internal fn (goal_response); called by 1 (handle); 1 external calls (function_arguments).


##### `GoalToolExecutor::handle_create`  (lines 180–219)

```
async fn handle_create(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Creates a new active goal for the thread, after checking that the request is valid and that there is not already an unfinished goal. It also starts the supporting bookkeeping that makes the goal visible and measurable.

**Data flow**: It reads JSON arguments from the tool call, turns them into a `CreateGoalRequest`, trims and validates the objective, checks that any token budget is positive, then inserts an active goal into the state database. After a successful insert, it may set the thread preview, marks the current turn as working on that goal, records metrics and analytics, emits a goal-updated event, and returns the new goal as JSON.

**Call relations**: `GoalToolExecutor::handle` calls this for create-goal invocations. It uses helper functions such as `parse_arguments`, `validate_goal_budget`, `fill_empty_thread_preview_if_possible`, `protocol_goal_from_state`, `emit_goal_updated_from_tool_call`, and `goal_response` to keep validation, conversion, notification, and formatting separate.

*Call graph*: calls 9 internal fn (created, record_created, emit_goal_updated_from_tool_call, fill_empty_thread_preview_if_possible, goal_response, parse_arguments, protocol_goal_from_state, validate_goal_budget, validate_thread_goal_objective); called by 1 (handle); 2 external calls (function_arguments, Turn).


##### `GoalToolExecutor::handle_update`  (lines 221–291)

```
async fn handle_update(
        &self,
        invocation: ToolCall,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Marks the current goal complete or blocked, while making sure progress from the active turn is counted first. It deliberately refuses other status changes because those are controlled by the user or the system, not this tool.

**Data flow**: It parses the requested status from JSON. If the status is not complete or blocked, it returns a clear error. Otherwise it accounts for current turn progress, reads the previous status for metrics, updates the stored goal status, records terminal-status metrics and analytics, converts the stored goal to the public shape, clears the current turn’s active goal, emits an update event, and returns the result. If the new status is complete, the response may include guidance for reporting final budget usage.

**Call relations**: `GoalToolExecutor::handle` calls this for update-goal invocations. It relies on `account_active_goal_progress` before the database status update so time and token usage are captured before the goal leaves its active state.

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

**Purpose**: Sends a user-visible event saying that a goal changed because of a tool call. This keeps the rest of the system informed after create or update operations.

**Data flow**: It receives the original tool call, an optional turn id, and the updated public goal. It takes the call id from the invocation and passes all of that to the event emitter.

**Call relations**: `GoalToolExecutor::handle_create` and `GoalToolExecutor::handle_update` call this after they have changed the goal. It is the small bridge from the tool logic to the event system.

*Call graph*: calls 1 internal fn (thread_goal_updated); called by 2 (handle_create, handle_update).


##### `GoalToolExecutor::account_active_goal_progress`  (lines 303–368)

```
async fn account_active_goal_progress(
        &self,
        mode: codex_state::GoalAccountingMode,
        event_id: &str,
        budget_limited_goal_disposition: BudgetLimitedGoalDisposition,
```

**Purpose**: Records time and token progress for the currently active goal before a status change. This prevents usage from being lost when a goal is completed, blocked, or otherwise affected by accounting.

**Data flow**: It first checks whether there is a current turn; if not, it returns no goal. It then takes an accounting permit, which is like a lock that prevents overlapping progress updates, and reads a snapshot of time and token changes for that turn. It writes those deltas to the state database, updates metrics and analytics if the stored goal changed, tells the accounting state what was recorded, emits an event, and returns the updated public goal when there is one.

**Call relations**: `GoalToolExecutor::handle_update` calls this before marking a goal complete or blocked. Inside, it uses `current_goal_status_for_metrics` and `protocol_goal_from_state`, then notifies analytics, metrics, accounting state, and the event emitter so all observers see the same progress update.

*Call graph*: calls 6 internal fn (status_changed, usage_accounted, thread_goal_updated, record_terminal_if_status_changed, current_goal_status_for_metrics, protocol_goal_from_state); called by 1 (handle_update); 1 external calls (Turn).


##### `GoalToolExecutor::current_goal_status_for_metrics`  (lines 370–389)

```
async fn current_goal_status_for_metrics(
        &self,
        expected_goal_id: Option<&str>,
    ) -> Result<Option<codex_state::ThreadGoalStatus>, FunctionCallError>
```

**Purpose**: Looks up the current stored goal status so metrics can tell whether a later operation actually changed it. This avoids counting the same terminal transition twice.

**Data flow**: It reads the current thread goal from the state database. If an expected goal id was supplied, it only returns the status when the stored goal matches that id; otherwise it returns the status of whatever goal exists. Database read errors become tool-call errors.

**Call relations**: `GoalToolExecutor::account_active_goal_progress` uses this before accounting usage, and `GoalToolExecutor::handle_update` uses it before updating status. The returned old status is then compared with the new stored goal for metric recording.

*Call graph*: called by 2 (account_active_goal_progress, handle_update).


##### `parse_arguments`  (lines 392–398)

```
fn parse_arguments(arguments: &str) -> Result<T, FunctionCallError>
```

**Purpose**: Turns the raw JSON argument string from a tool call into a typed Rust request object. It gives the caller a clean value instead of making each handler parse JSON by hand.

**Data flow**: It receives a string containing JSON. It asks the JSON library to deserialize that string into the requested type, returning the typed value on success or a model-facing error message on failure.

**Call relations**: `GoalToolExecutor::handle_create` uses this to read create-goal arguments, and `GoalToolExecutor::handle_update` uses it to read update-goal arguments. It centralizes argument parsing for the tool handlers.

*Call graph*: called by 2 (handle_create, handle_update); 1 external calls (from_str).


##### `validate_goal_budget`  (lines 400–407)

```
fn validate_goal_budget(value: Option<i64>) -> Result<(), String>
```

**Purpose**: Checks that an optional goal token budget is sensible. If a budget is provided, it must be greater than zero.

**Data flow**: It receives either no budget or a number. No budget passes. A positive number passes. Zero or a negative number returns an error message explaining that goal budgets must be positive.

**Call relations**: `GoalToolExecutor::handle_create` calls this before inserting a goal, and another goal-setting path named `set_thread_goal` also uses it. This keeps the same budget rule in more than one entry point.

*Call graph*: called by 2 (set_thread_goal, handle_create).


##### `goal_response`  (lines 409–416)

```
fn goal_response(
    goal: Option<ThreadGoal>,
    completion_budget_report: CompletionBudgetReport,
) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Builds the JSON tool output returned by all goal tool actions. This gives get, create, and update a consistent response format.

**Data flow**: It receives an optional public goal and a choice about whether to include a completion budget report. It builds a `GoalToolResponse`, converts it to a JSON value, wraps it as a tool output, and returns it. If serialization unexpectedly fails, it returns a fatal error.

**Call relations**: `GoalToolExecutor::handle_get`, `GoalToolExecutor::handle_create`, and `GoalToolExecutor::handle_update` all call this at the end of their work. It delegates response-field calculation to `GoalToolResponse::new`.

*Call graph*: calls 2 internal fn (new, new); called by 3 (handle_create, handle_get, handle_update); 2 external calls (new, to_value).


##### `GoalToolResponse::new`  (lines 419–436)

```
fn new(goal: Option<ThreadGoal>, report_mode: CompletionBudgetReport) -> Self
```

**Purpose**: Assembles the structured response body for a goal tool call. It adds helpful derived fields, such as how many budgeted tokens remain.

**Data flow**: It receives an optional goal and a report mode. If the goal has a token budget, it subtracts used tokens from the budget and never lets the remaining count go below zero. If report mode asks for it and the goal is complete, it may add a short instruction telling the caller to report final usage from the structured fields.

**Call relations**: `goal_response` calls this just before converting the response to JSON. It is the place where raw goal data becomes the friendlier response shape returned to tool callers.

*Call graph*: called by 1 (goal_response).


##### `fill_empty_thread_preview_if_possible`  (lines 439–452)

```
async fn fill_empty_thread_preview_if_possible(
    state_db: &codex_state::StateRuntime,
    thread_id: ThreadId,
    goal: &codex_state::ThreadGoal,
)
```

**Purpose**: Uses a new goal’s objective as the thread preview, but only if the preview is currently empty. This gives a thread a useful label without overwriting an existing one.

**Data flow**: It receives the state database, thread id, and stored goal. It asks the database to set the thread preview to the goal objective if no preview exists. If that best-effort update fails, it logs a warning and does not stop the goal creation flow.

**Call relations**: `GoalToolExecutor::handle_create` calls this after inserting a goal, and another path named `set_thread_goal` also uses it. It is intentionally non-blocking for the main goal operation: preview failure should not mean goal failure.

*Call graph*: called by 2 (set_thread_goal, handle_create); 2 external calls (set_thread_preview_if_empty, warn!).


##### `protocol_goal_from_state`  (lines 454–465)

```
fn protocol_goal_from_state(goal: codex_state::ThreadGoal) -> ThreadGoal
```

**Purpose**: Converts the database version of a goal into the public protocol version sent through tool responses and events. This keeps storage details separate from what outside callers see.

**Data flow**: It receives a `codex_state::ThreadGoal` from storage. It copies over the public fields, converts the status through `protocol_status_from_state`, turns timestamps into Unix seconds, and returns a `codex_protocol::protocol::ThreadGoal`.

**Call relations**: Many goal flows use this whenever stored data must leave the state layer, including tool creation, progress accounting, external goal setting, idle accounting, continuation checks, and active-goal stopping. In this file, the handlers use it before emitting events or returning JSON.

*Call graph*: calls 1 internal fn (protocol_status_from_state); called by 9 (set_thread_goal, account_active_goal_progress, account_idle_goal_progress, apply_external_goal_set, continue_if_idle, stop_active_goal_for_turn, account_active_goal_progress, handle_create, handle_update).


##### `protocol_status_from_state`  (lines 467–476)

```
fn protocol_status_from_state(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus
```

**Purpose**: Translates a stored goal status into the matching public protocol status. It is a small compatibility bridge between the database layer and the API layer.

**Data flow**: It receives one stored status value, matches it to the equivalent protocol status value, and returns that protocol value.

**Call relations**: `protocol_goal_from_state` calls this while converting a whole goal. Keeping the status mapping in one place makes the full goal conversion simpler and safer.

*Call graph*: called by 1 (protocol_goal_from_state).


##### `state_status_from_protocol`  (lines 478–489)

```
fn state_status_from_protocol(
    status: ThreadGoalStatus,
) -> codex_state::ThreadGoalStatus
```

**Purpose**: Translates a public protocol goal status into the matching database status. This is needed when a tool request asks to change stored state.

**Data flow**: It receives a protocol status from the incoming request, maps it to the equivalent `codex_state` status, and returns the stored form.

**Call relations**: `GoalToolExecutor::handle_update` calls this after it has already checked that the requested status is allowed. The converted value is then passed to the state database update call.

*Call graph*: called by 1 (handle_update).


##### `completion_budget_report`  (lines 491–500)

```
fn completion_budget_report(goal: &ThreadGoal) -> Option<String>
```

**Purpose**: Decides whether a completed-goal response should include a reminder to report final usage. The reminder tells the caller to use the structured goal fields instead of inventing numbers.

**Data flow**: It receives a public goal. If there is no token budget and no recorded time, it returns nothing. Otherwise it returns a fixed instruction string explaining how to summarize token use and elapsed time from the response fields.

**Call relations**: `GoalToolResponse::new` uses this when a goal has just been completed and the response mode asks for a completion report. It only affects the extra guidance text; it does not change the stored goal.


### Memories namespace and workspace support
This group covers the memories extension from crate entry through local backend operations, tool wrappers, and the related workspace preparation used by memory writing flows.

### `ext/memories/src/lib.rs`

`config` · `startup and cross-cutting`

This file is like the label and control panel for the memories feature. The feature itself is split across several internal modules: storage backends, extension setup, local behavior, metrics, prompts, schema definitions, and tool implementations. This file gathers those pieces under one Rust library module so the rest of the project can treat “memories” as one extension rather than many loose files.

Its one public export is `install`, which comes from the extension module. That is likely the function other parts of the system call when they want to add the memories extension to the larger application.

The file also defines shared constants that keep the feature predictable. For example, listing memories is capped at 2,000 results, searching is capped at 200 results, and reading memory content has a token limit. A token is a small chunk of text used by language models, so these limits help stop memory operations from becoming too large, slow, or expensive. It also defines the public tool namespace and tool names, such as `memories.list`, `memories.read`, and `memories.search` in practical terms.

Without this file, the memories extension would lack a clear entry point and shared vocabulary. Different modules might invent different limits or names, making the feature harder to connect and easier to break.


### `ext/memories/src/local/ad_hoc_note.rs`

`domain_logic` · `request handling`

This file is the local-file version of “add an ad hoc memory note.” An ad hoc note is a small standalone note, saved as a `.md` file, rather than a structured memory item. Without this code, callers could not reliably add these notes to disk, and unsafe or messy filenames could create confusing files or point outside the intended layout.

The flow is simple. First, the requested filename is checked against a strict pattern: it must look like `YYYY-MM-DDTHH-MM-SS-<slug>.md`. The timestamp makes notes sort naturally by time, and the slug is the human-readable part. The slug is limited to lowercase letters, digits, and hyphens, which keeps filenames predictable across systems.

Next, the note text is checked so blank notes are rejected. Then the file makes sure the storage path exists: the backend root, then `extensions/ad_hoc/notes` under it. Each directory is checked carefully. If something already exists there, it must really be a directory, and it must not be a symbolic link, which is a filesystem shortcut that could redirect writes somewhere unexpected.

Finally, the note is written using “create new” mode. That is like putting a note into an empty mailbox only if nobody has used that exact slot before: if the file already exists, the operation fails instead of overwriting it.

#### Function details

##### `add_ad_hoc_note`  (lines 17–40)

```
async fn add_ad_hoc_note(
    backend: &LocalMemoriesBackend,
    request: AddAdHocMemoryNoteRequest,
) -> Result<AddAdHocMemoryNoteResponse, MemoriesBackendError>
```

**Purpose**: Adds a new ad hoc memory note to the local filesystem. It is the main entry point in this file: it checks that the request is safe and meaningful, creates the note folder if needed, and writes the note without overwriting an existing file.

**Data flow**: It receives a local backend, which contains the root storage folder, and a request containing a filename and note text. It first validates the filename, rejects note text that is only whitespace, asks for the notes directory to be prepared, then writes the note bytes to a newly created file. It returns an empty success response if the write worked, or a clear memory backend error if validation fails, the file already exists, or the filesystem reports a problem.

**Call relations**: This is called when the local memories backend is asked to add an ad hoc note. It relies on `validate_filename` before touching disk, then on `ensure_notes_dir` to prepare the folder, and finally uses the standard file-opening machinery to create the note safely.

*Call graph*: calls 2 internal fn (ensure_notes_dir, validate_filename); called by 1 (add_ad_hoc_note); 1 external calls (new).


##### `ensure_notes_dir`  (lines 42–52)

```
async fn ensure_notes_dir(
    backend: &LocalMemoriesBackend,
) -> Result<std::path::PathBuf, MemoriesBackendError>
```

**Purpose**: Makes sure the folder for ad hoc notes exists under the backend’s root directory. It builds the expected path one piece at a time so every level is checked before the note file is created.

**Data flow**: It receives the local backend and reads its root path. Starting from that root, it ensures the root exists, then appends `extensions`, `ad_hoc`, and `notes`, checking or creating each directory along the way. It returns the final notes folder path, or an error if any path component is unsafe or not a directory.

**Call relations**: `add_ad_hoc_note` calls this after the request itself has passed validation. This function delegates each actual filesystem check or creation step to `ensure_directory`, so the same safety rules are applied at every level of the folder tree.

*Call graph*: calls 1 internal fn (ensure_directory); called by 1 (add_ad_hoc_note).


##### `ensure_directory`  (lines 54–82)

```
async fn ensure_directory(path: &Path) -> Result<(), MemoriesBackendError>
```

**Purpose**: Ensures that one specific path exists and is a real directory, not a file or symbolic link. This prevents note storage from being redirected or blocked by an unexpected filesystem item.

**Data flow**: It receives a path. It asks the backend for metadata, meaning information about what exists at that path. If something exists, it rejects symbolic links and accepts only directories. If nothing exists, it creates the directory, then checks again that the created item really exists, is not a symbolic link, and is a directory. It returns success when the path is safe to use, or an error explaining what went wrong.

**Call relations**: `ensure_notes_dir` calls this for the backend root and for each folder below it. It uses `LocalMemoriesBackend::metadata_or_none` to inspect paths, `reject_symlink` to block redirecting filesystem shortcuts, and `tokio::fs::create_dir` to create missing directories without blocking the async runtime.

*Call graph*: calls 3 internal fn (invalid_path, metadata_or_none, reject_symlink); called by 1 (ensure_notes_dir); 2 external calls (display, create_dir).


##### `validate_filename`  (lines 84–126)

```
fn validate_filename(filename: &str) -> Result<(), MemoriesBackendError>
```

**Purpose**: Checks that a requested note filename follows the project’s safe, predictable naming rules. This keeps ad hoc notes organized and prevents odd filenames from sneaking into the storage folder.

**Data flow**: It receives the filename text. It checks the total byte length, confirms the `.md` ending, separates the timestamp-and-slug stem from the extension, verifies the timestamp-shaped prefix, then checks that the slug is present, short enough, and made only of lowercase ASCII letters, digits, or hyphens. It returns success if all rules pass, or a filename error with a human-readable reason if any rule fails.

**Call relations**: `add_ad_hoc_note` calls this before it creates directories or writes a file. For the timestamp portion, it hands the detailed shape check to `has_valid_timestamp_prefix`, keeping the filename rules split into smaller pieces.

*Call graph*: calls 2 internal fn (invalid_filename, has_valid_timestamp_prefix); called by 1 (add_ad_hoc_note).


##### `has_valid_timestamp_prefix`  (lines 128–143)

```
fn has_valid_timestamp_prefix(stem: &str) -> bool
```

**Purpose**: Checks whether the start of a filename stem looks like the required timestamp format. It verifies the positions of separators such as `-` and `T`, and confirms that the date and time fields are made of digits.

**Data flow**: It receives the filename stem, meaning the filename without `.md`. It looks at the raw bytes and checks that the expected separator characters are in the right places, and that each number group is all digits. It returns `true` if the prefix has the required shape, or `false` otherwise. It does not check whether the date is a real calendar date; it only checks the format.

**Call relations**: `validate_filename` calls this when deciding whether a filename follows `YYYY-MM-DDTHH-MM-SS-<slug>.md`. This function calls `are_digits` for each numeric slice so the digit test is shared and easy to read.

*Call graph*: calls 1 internal fn (are_digits); called by 1 (validate_filename).


##### `are_digits`  (lines 145–147)

```
fn are_digits(bytes: &[u8]) -> bool
```

**Purpose**: Checks whether every byte in a small slice is an ASCII digit from `0` to `9`. It is a tiny helper used to make the timestamp-format check clearer.

**Data flow**: It receives a slice of bytes. It tests each byte to see whether it is an ASCII digit. It returns `true` only if all bytes pass that test; otherwise it returns `false`.

**Call relations**: `has_valid_timestamp_prefix` calls this repeatedly for the year, month, day, hour, minute, and second parts of the filename prefix. It does not call other project code; it is just the small reusable digit check inside the filename validation flow.

*Call graph*: called by 1 (has_valid_timestamp_prefix).


### `ext/memories/src/local/list.rs`

`domain_logic` · `request handling`

This file answers the question: “What memories are under this local path?” A memory here is represented by a file or directory on disk. Without this code, the local memories backend could not browse its stored content safely or return long directory listings in smaller pages.

The main function first limits how many results can be returned, so a huge folder cannot produce an oversized response. It then converts the requested path into a path inside the backend’s allowed root folder. This matters because callers should not be able to escape into unrelated parts of the computer’s filesystem.

If the caller supplied a cursor, the function treats it as the starting position in the result list. A cursor is like a bookmark in a long list: “continue from item 50.” Bad cursors are rejected with a clear error.

Next, the function checks what exists at the target path. If it is a file, it returns that one file. If it is a directory, it reads the directory in sorted order, skips hidden paths, skips symbolic links (filesystem shortcuts that could point somewhere unexpected), and includes only normal files and directories. Finally, it slices the list according to the cursor and maximum size, and returns a next cursor if more results remain.

#### Function details

##### `list`  (lines 14–83)

```
async fn list(
    backend: &LocalMemoriesBackend,
    request: ListMemoriesRequest,
) -> Result<ListMemoriesResponse, MemoriesBackendError>
```

**Purpose**: Lists local memory entries at a requested path, while keeping the result safe, predictable, and page-sized. It is used when a caller wants to browse memory files or folders without reading their contents.

**Data flow**: It receives a local backend, which knows the root folder on disk, and a list request containing an optional path, maximum result count, and optional cursor. It resolves the path into the backend’s allowed area, checks that it exists, rejects unsafe symbolic links, and then builds entries from either the single file or the visible children of a directory. It returns a response containing the requested page of entries, the original path, and a next cursor when there are more entries to fetch; if the path is missing or the cursor is invalid, it returns an error instead.

**Call relations**: This function is the worker behind the local backend’s list operation. During a list request, it asks path helpers to resolve and display paths, read directory contents in a stable order, filter hidden paths, and reject symbolic links. It also relies on backend helpers to read filesystem metadata and uses the shared error type to report problems such as missing paths or unusable cursors.

*Call graph*: calls 7 internal fn (invalid_cursor, metadata_or_none, resolve_scoped_path, display_relative_path, is_hidden_path, read_sorted_dir_paths, reject_symlink); called by 1 (list); 2 external calls (new, vec!).


### `ext/memories/src/local/read.rs`

`domain_logic` · `request handling`

This file is the local backend’s read operation for memories: small text files stored on disk. Its job is like a careful librarian fetching a page range from a notebook. Before reading, it checks that the caller asked for a real starting line and did not request zero lines. It then turns the caller’s memory path into a safe path inside the backend’s allowed area, checks whether the file exists, rejects symbolic links, and refuses to read directories. These checks matter because reading arbitrary paths or following links could expose files that are not meant to be part of the memory store.

Once the file is confirmed safe, the file is loaded as text. The code finds the byte position where the requested starting line begins, then finds where the requested maximum number of lines ends, if a limit was provided. It then applies a token limit. A token is a rough unit of text used by language models, so this prevents returning more text than the rest of the system can comfortably use. The response includes the requested path, the starting line number, the text slice, and a flag saying whether anything was left out because of line or token limits.

#### Function details

##### `read`  (lines 12–51)

```
async fn read(
    backend: &LocalMemoriesBackend,
    request: ReadMemoryRequest,
) -> Result<ReadMemoryResponse, MemoriesBackendError>
```

**Purpose**: Reads part of a local memory file and returns it in a safe, size-limited response. It is used when someone asks the local memories backend to show the contents of a memory starting at a particular line.

**Data flow**: It receives the local backend and a read request containing a path, a starting line, optional line limit, and optional token limit. It validates the request, resolves the path into the backend’s allowed storage area, checks the file’s metadata, rejects unsafe or unsuitable targets, reads the file text, cuts out the requested line range, truncates it to the token budget, and returns a response with the text and a flag showing whether it was shortened. If anything is invalid or unsafe, it returns a clear backend error instead.

**Call relations**: This is the main read path for this file. As part of that flow, it asks the backend to resolve and inspect the path, uses the symlink check to prevent unsafe file access, calls the two line-position helpers to find the slice of text, reads the file from disk, and finally hands the selected text to the truncation utility before building the response.

*Call graph*: calls 5 internal fn (metadata_or_none, resolve_scoped_path, reject_symlink, line_end_byte_offset, line_start_byte_offset); called by 1 (read); 3 external calls (truncate_text, Tokens, read_to_string).


##### `line_start_byte_offset`  (lines 53–72)

```
fn line_start_byte_offset(
    content: &str,
    line_offset: usize,
) -> Result<usize, MemoriesBackendError>
```

**Purpose**: Finds where a requested line starts inside a text string. This lets the reader return content beginning at line 1, line 20, or any other valid line without guessing by characters.

**Data flow**: It receives the full file content and a one-based line number. If the line is 1, it returns byte position 0. Otherwise, it walks through the text until it has counted enough newline characters to reach the requested line, then returns the byte position just after that newline. If the requested line is beyond the end of the file, it returns an error.

**Call relations**: The main read function calls this after loading the file text. Its result becomes the starting point passed into the end-position calculation, so the rest of the read operation knows exactly where the requested slice begins.

*Call graph*: called by 1 (read).


##### `line_end_byte_offset`  (lines 74–90)

```
fn line_end_byte_offset(content: &str, start_byte: usize, max_lines: Option<usize>) -> usize
```

**Purpose**: Finds where the returned text should stop, based on an optional maximum number of lines. If no line limit is given, it allows reading to the end of the file.

**Data flow**: It receives the full file content, the byte position where reading should start, and an optional line count. With no line count, it returns the file length. With a line count, it scans forward from the start position, counts newline characters, and returns the byte position after the last allowed line. If the file ends first, it returns the file length.

**Call relations**: The main read function calls this after finding the starting byte. Its result defines the end of the raw text slice, which is then passed through token truncation before being returned to the caller.

*Call graph*: called by 1 (read).


### `ext/memories/src/local/search.rs`

`domain_logic` · `request handling`

This file is the local search engine for “memories,” meaning saved text files under a controlled root folder. Without it, the backend could store and read memories, but it could not answer questions like “find every memory mentioning these words.”

The top-level search flow first cleans and checks the user’s query terms. It rejects empty searches and invalid “all terms must appear within N lines” requests. It then resolves the requested path safely inside the backend’s root folder, checks that the path exists, and refuses symbolic links (shortcuts that could point outside the allowed area). This matters because search walks the filesystem, so it must not accidentally wander into hidden or unsafe places.

After that, a SearchMatcher prepares the queries according to the request: it may ignore letter case, and it may “normalize” text by keeping only letters and numbers. The search then visits either a single file or all normal, non-hidden files under a directory. Each readable text file is split into lines and checked against the chosen match mode: any query on a line, all queries on the same line, or all queries within a small line window.

For each hit, the code builds a MemorySearchMatch containing the relative path, line number, matching query terms, and optional context lines before and after. Finally it sorts results, applies cursor-based paging, and returns only the requested slice.

#### Function details

##### `search`  (lines 17–89)

```
async fn search(
    backend: &LocalMemoriesBackend,
    request: SearchMemoriesRequest,
) -> Result<SearchMemoriesResponse, MemoriesBackendError>
```

**Purpose**: This is the main entry point for a local memory search request. It checks that the request is valid, searches the requested file or folder, sorts the results, and returns one page of matches.

**Data flow**: It receives a LocalMemoriesBackend and a SearchMemoriesRequest containing queries, path, matching rules, paging cursor, and options such as case sensitivity. It trims and validates the queries, resolves the path inside the allowed memory root, checks the starting file or directory, builds a SearchMatcher, gathers all matches, sorts them by path and line number, then returns a SearchMemoriesResponse with the selected page of results and a next cursor if more results remain. It can return an error instead if the query, cursor, match window, path, or filesystem access is invalid.

**Call relations**: This function is called when the backend needs to perform a search. It relies on path helpers to keep the search scoped and safe, creates SearchMatcher::new to prepare the query comparison rules, and then hands the actual filesystem walk to search_entries. After search_entries fills the match list, this function takes back control to sort and paginate the final response.

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

**Purpose**: This function searches either one file or every searchable file under a directory. It is the part that walks through folders while avoiding hidden paths, missing entries, and symbolic links.

**Data flow**: It receives the root folder, the current starting path, that path’s metadata, the matcher, the requested number of context lines, and a shared list where matches should be added. If the starting path is a file, it sends that file to search_file. If it is a directory, it visits directory contents in sorted order, skips hidden paths and symlinks, pushes subdirectories onto a pending stack, and sends ordinary files to search_file. The output is not a separate return value; instead, it adds found matches into the provided matches list or returns an error if reading a directory fails.

**Call relations**: search calls this after the request has been validated and the matcher is ready. search_entries does not decide what counts as a textual match; it delegates that to search_file for each file it finds. It uses filesystem helper functions from the local path module to read directories consistently and avoid unsafe or unwanted paths.

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

**Purpose**: This function looks inside one text file and finds the lines or line ranges that satisfy the requested search mode. It turns raw file content into individual search hits.

**Data flow**: It receives a file path, the root path, a SearchMatcher, the number of context lines to include, and the shared match list. It reads the file as text; if the file is not valid text, it quietly skips it. It splits readable content into lines, records which queries match each line, and then applies the selected rule: any query on a line, all queries on one line, or all queries within a limited group of nearby lines. For each accepted hit, it calls build_search_match and appends the result to the matches list.

**Call relations**: search_entries calls this for every file that should be searched. search_file uses SearchMatcher::matched_query_flags to test each line, SearchMatcher::matched_queries to name the queries that matched, and build_search_match to package each hit into the response shape expected by the rest of the backend.

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

**Purpose**: This function creates the final search-result object for one hit. It adds practical details such as the relative file path, line numbers, matching text, surrounding context, and which queries were found.

**Data flow**: It receives the memory root, the matched file path, all lines from that file, the start and end line indexes of the match, the requested number of context lines, and the matched query strings. It expands the displayed text range backward and forward by the requested context amount without going outside the file, joins those lines into one text block, converts the file path into a display-friendly relative path, and returns a MemorySearchMatch.

**Call relations**: search_file calls this whenever it has decided that a line or line window is a real match. This helper keeps result formatting in one place, so search_file can focus on deciding what matches while this function focuses on what a match should look like to callers.

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

**Purpose**: This creates a matcher object that knows how to compare search queries against file lines. It prepares the queries once up front so every line can be checked consistently and efficiently.

**Data flow**: It receives the original query strings, the selected match mode, and flags for case-sensitive and normalized searching. It builds a SearchComparison from those flags, prepares every query using the same comparison rules, rejects the search if preparation leaves any query empty, and returns a SearchMatcher containing both the original queries and their prepared forms.

**Call relations**: search calls this after validating the request and before walking files. It calls SearchComparison::new to capture the comparison settings, then uses SearchComparison::prepare on each query. Later, search_file uses the returned SearchMatcher to check lines and report matched query names.

*Call graph*: calls 1 internal fn (new); called by 1 (search).


##### `SearchMatcher::matched_query_flags`  (lines 284–290)

```
fn matched_query_flags(&self, line: &str) -> Vec<bool>
```

**Purpose**: This checks one line of text and reports which prepared queries appear in it. The result is a list of yes/no values, one for each query.

**Data flow**: It receives a line from a file. It prepares that line using the same case and normalization rules used for the queries, then tests whether each prepared query is contained in the prepared line. It returns a vector of booleans, where true means the corresponding query matched that line.

**Call relations**: search_file uses this for every line in a readable file before applying the match mode. It depends on SearchComparison::prepare so that lines and queries are compared in the same form, such as both lowercased when case-insensitive search is requested.

*Call graph*: calls 1 internal fn (prepare).


##### `SearchMatcher::matched_queries`  (lines 292–298)

```
fn matched_queries(&self, matched_query_flags: &[bool]) -> Vec<String>
```

**Purpose**: This converts a list of yes/no match flags back into the original query strings that matched. It is used so search results can say which requested terms were found.

**Data flow**: It receives a boolean list aligned with the matcher’s original query list. It pairs each original query with its flag, keeps the queries whose flag is true, clones those strings, and returns them as a list of matched query names.

**Call relations**: search_file calls this when it is ready to build a MemorySearchMatch. The earlier line-checking step works with compact boolean flags; this function turns those internal flags into human-readable query strings for the response.

*Call graph*: called by 1 (search_file).


##### `SearchComparison::new`  (lines 308–313)

```
fn new(case_sensitive: bool, normalized: bool) -> Self
```

**Purpose**: This records the text-comparison options for a search. It answers two basic questions: should uppercase and lowercase be treated as different, and should punctuation or spaces be ignored?

**Data flow**: It receives two booleans: case_sensitive and normalized. It stores them in a SearchComparison value and returns that value. Nothing else is changed.

**Call relations**: SearchMatcher::new calls this while setting up a search. The resulting SearchComparison is then reused for both query preparation and line preparation, keeping the comparison fair and consistent.

*Call graph*: called by 1 (new).


##### `SearchComparison::prepare`  (lines 315–335)

```
fn prepare(self, value: &'a str) -> Cow<'a, str>
```

**Purpose**: This turns a piece of text into the form used for searching. Depending on the options, it may leave the text alone, lowercase it, remove non-letter-and-number characters, or do both.

**Data flow**: It receives a string slice, such as a query or a file line. If the search is case-sensitive and not normalized, it returns a borrowed view of the original text without allocating a new string. Otherwise it lowercases the text when needed, and if normalization is enabled it filters the text down to only alphanumeric characters. It returns either the original borrowed text or a newly owned prepared string.

**Call relations**: SearchMatcher::new uses this to prepare queries, and SearchMatcher::matched_query_flags uses it to prepare each file line. This shared preparation step is what makes options like case-insensitive or punctuation-ignoring search behave the same way on both sides of the comparison.

*Call graph*: called by 1 (matched_query_flags); 2 external calls (Borrowed, Owned).


### `ext/memories/src/tools/mod.rs`

`orchestration` · `startup and tool request handling`

The memory extension offers several actions, such as adding a note, listing memories, reading one, and searching. This file ties those separate tool modules together so the rest of the system can see them as one set of callable tools. Without it, the memory backend might still know how to store and fetch data, but the outside tool framework would not have a clean way to discover or call those abilities.

Think of this file like the reception desk in a small library. It does not write the books or search every shelf itself. Instead, it points visitors to the right service, makes sure each service has a proper sign, and explains errors in a way visitors can understand.

It builds tool executors around a shared memory backend, optionally attaches a metrics client for reporting usage, and returns them as a list. It also creates namespaced tool names, meaning tool names are grouped under the memory extension’s namespace so they do not collide with tools from other extensions. For tools exposed through the Responses API, it builds the advertised input and output schemas, which are machine-readable descriptions of what arguments a tool accepts and what it returns.

The file also contains shared helpers for parsing JSON arguments, limiting requested result counts to safe bounds, and converting backend errors into either model-visible messages or fatal system errors.

#### Function details

##### `memory_tools`  (lines 28–53)

```
fn memory_tools(
    backend: B,
    metrics_client: Option<MetricsClient>,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Builds the full set of memory tools that the extension offers. It packages the shared memory backend and optional metrics reporter into each individual tool so they can all be called through the common tool interface.

**Data flow**: It receives a memory backend and an optional metrics client. It clones the backend and metrics client where needed, creates one executor each for adding an ad hoc note, listing, reading, and searching, wraps them in shared pointers so they can be passed around safely, and returns them as a list.

**Call relations**: This is called by the higher-level tool setup paths named `tools` and `memory_tool` when the extension is preparing its available tools. Inside, it constructs the list with `vec!`, then hands back the ready-to-use executors for the rest of the tool system to register or expose.

*Call graph*: called by 2 (tools, memory_tool); 1 external calls (vec!).


##### `memory_tool_name`  (lines 55–57)

```
fn memory_tool_name(name: &str) -> ToolName
```

**Purpose**: Creates the official name for a memory tool inside the memory namespace. This keeps memory tool names separate from similarly named tools elsewhere in the system.

**Data flow**: It receives a short tool name, combines it with the memory tools namespace, and returns a `ToolName` that includes both pieces. The result is a fully qualified name the tool framework can recognize unambiguously.

**Call relations**: It delegates the actual name construction to `namespaced`. Other memory tool code can use this helper when it needs to refer to a tool by its public, namespaced name.

*Call graph*: calls 1 internal fn (namespaced).


##### `memory_function_tool`  (lines 59–78)

```
fn memory_function_tool(
    name: &str,
    description: &str,
) -> ToolSpec
```

**Purpose**: Builds the public specification for a memory function tool. A tool specification is the description the API uses to know the tool’s name, what it does, what input shape it expects, and what output shape it returns.

**Data flow**: It receives a tool name and human-readable description, plus type information for the expected input and output. It generates JSON schemas for those types, parses the input schema into the format the Responses API expects, creates a function-tool description, wraps it inside the memory namespace, and returns the finished `ToolSpec`.

**Call relations**: It calls the schema parser, the default namespace description helper, and the namespace constructor to assemble a tool advertisement. This is the bridge between the memory extension’s Rust types and the API-facing description that callers can inspect before invoking a tool.

*Call graph*: 4 external calls (parse_tool_input_schema, default_namespace_description, Namespace, vec!).


##### `parse_args`  (lines 80–89)

```
fn parse_args(call: &ToolCall) -> Result<T, FunctionCallError>
```

**Purpose**: Turns a tool call’s raw argument text into a strongly typed Rust value. It also treats an empty argument string as an empty JSON object, which lets no-argument tools be called cleanly.

**Data flow**: It receives a `ToolCall` and asks it for the function argument string. If the string is blank, it uses an empty JSON object; otherwise it parses the string as JSON. Then it converts that JSON value into the requested Rust type. If parsing or conversion fails, it returns an error meant to be shown back to the model.

**Call relations**: This helper sits in the request path for memory tools that need to read their arguments. It uses the tool call’s `function_arguments` method, JSON parsing, and JSON-to-type conversion, then hands either a usable typed input or a model-readable error back to the caller.

*Call graph*: 5 external calls (Object, function_arguments, new, from_str, from_value).


##### `clamp_max_results`  (lines 91–93)

```
fn clamp_max_results(requested: Option<usize>, default: usize, max: usize) -> usize
```

**Purpose**: Chooses a safe number of results to return when a caller asks for a limit. It prevents missing, too-small, or too-large requests from producing awkward or expensive behavior.

**Data flow**: It receives an optional requested count, a default count, and a maximum count. If no count was requested, it uses the default. Then it clamps the final number so it is at least 1 and no more than the maximum, and returns that safe value.

**Call relations**: This is a small shared helper for tools such as listing or searching, where callers may ask for a certain number of results. It keeps those tools from each having to repeat the same boundary-checking logic.


##### `backend_error_to_function_call`  (lines 95–113)

```
fn backend_error_to_function_call(err: MemoriesBackendError) -> FunctionCallError
```

**Purpose**: Converts errors from the memory storage layer into errors the tool framework understands. It separates mistakes the model can fix, such as a bad path or empty query, from serious system problems, such as input/output failures.

**Data flow**: It receives a `MemoriesBackendError`. For validation-style problems and missing-data cases, it turns the error text into `RespondToModel`, meaning the model can see the message and potentially correct the call. For an I/O error, it turns the message into `Fatal`, meaning something went wrong at the system level and normal correction by the model is not expected.

**Call relations**: Memory tools can use this after calling the backend. It calls `to_string` to make the backend error readable, then wraps it as either `RespondToModel` or `Fatal` so the broader function-call machinery knows how to react.

*Call graph*: 3 external calls (to_string, Fatal, RespondToModel).


### `ext/memories/src/tools/ad_hoc_note.rs`

`orchestration` · `request handling`

This file is a small bridge between the outside tool-call world and the memories storage system. Its job is to expose an “add ad-hoc note” tool: a controlled way for Codex to write a Markdown note into the user’s memory notes after the user has clearly requested it.

The file first defines the shape of the tool’s input. The caller must provide a filename in a strict timestamp-plus-slug format, such as a dated note name ending in `.md`, and a non-empty Markdown note. The strict filename rule matters because it keeps memory notes predictable and avoids surprising file names.

The main type, `AddAdHocNoteTool`, holds two things: a backend, which is the part that actually stores the note, and an optional metrics client, which reports whether the tool call succeeded. Think of this file like a front desk: it confirms the request is written on the right form, passes it to the storage team, logs whether the job was completed, and then gives the caller a clean receipt.

If parsing the arguments fails or the backend reports an error, the code turns that into a tool-call error. If everything works, it wraps the backend response as JSON so the extension API can return it to the caller.

#### Function details

##### `AddAdHocNoteTool::tool_name`  (lines 48–50)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the extension system the public name of this tool. The name is used so incoming tool calls can be matched to the code that knows how to run them.

**Data flow**: It reads the fixed ad-hoc-note tool name from the module → passes it through the shared memory-tool naming helper → returns the final `ToolName` used by the extension API.

**Call relations**: When the extension framework asks this tool to identify itself, this method answers by calling the shared `memory_tool_name` helper. That keeps this tool’s name consistent with the other memory tools.

*Call graph*: 1 external calls (memory_tool_name).


##### `AddAdHocNoteTool::spec`  (lines 52–57)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This describes the tool to the caller: what it is called, what input it expects, and what kind of response it returns. The description also states the important policy: use it only after the user explicitly asks Codex to remember, forget, or update something.

**Data flow**: It uses the input type `AddAdHocNoteArgs`, the response type `AddAdHocMemoryNoteResponse`, the fixed tool name, and a human-readable description → builds a `ToolSpec` → returns that specification to the extension system.

**Call relations**: The extension framework uses this method when it needs to advertise or register the available tools. This method relies on the shared memory-tool specification builder so the ad-hoc note tool is presented in the same format as the other memory tools.


##### `AddAdHocNoteTool::handle`  (lines 59–61)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: This is the standard entry point the extension API calls when someone invokes the tool. It starts the real work asynchronously, meaning the backend write can happen without blocking the whole system.

**Data flow**: It receives a raw `ToolCall` from the extension system → wraps the internal `handle_call` work in a pinned future, which is a promise of work that will complete later → returns that future to the caller.

**Call relations**: The extension framework calls this method for an incoming ad-hoc-note request. This method immediately hands the work to `AddAdHocNoteTool::handle_call`, which does the parsing, backend call, metrics recording, and response formatting.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `AddAdHocNoteTool::handle_call`  (lines 68–90)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: This does the actual work of creating the ad-hoc memory note. It validates the incoming arguments, asks the backend to store the note, records success or failure, and returns either a JSON response or a tool-call error.

**Data flow**: It receives the raw tool call → parses it into a filename and Markdown note → clones the backend handle so it can make the async storage request → sends an `AddAdHocMemoryNoteRequest` to the backend → records a metric saying whether the backend call succeeded → converts any backend error into a function-call error → wraps a successful backend response as JSON output.

**Call relations**: It is called by `AddAdHocNoteTool::handle` after the extension API invokes the tool. Inside, it depends on `parse_args` to turn untrusted tool input into typed data, on the memories backend to actually add the note, on `record_tool_call` to report the outcome, and on JSON output wrapping so the result can travel back through the tool API.

*Call graph*: calls 2 internal fn (record_tool_call, new); called by 1 (handle); 4 external calls (clone, new, json!, parse_args).


### `ext/memories/src/tools/list.rs`

`orchestration` · `request handling`

This file is the front desk for one specific memory-store action: listing what is inside a folder-like path. Without it, outside callers could not ask the memories extension “what is here?” in the standard tool-call format.

The main type is `ListTool`, which holds two things: a memories backend, where the real stored data lives, and an optional metrics client, used to record whether the call succeeded. The tool first describes itself to the wider extension system: its name is the memory list tool name, and its input shape is `ListArgs`. Those arguments allow a caller to provide a path, a pagination cursor, and a maximum number of results. Pagination means the backend can return a chunk of a long listing and give the caller a cursor to continue later, like reading a long directory one page at a time.

When a call arrives, the tool parses the incoming arguments, chooses a safe result limit by clamping it between defaults and maximums, and asks the backend to list that path. It then records metrics such as the requested scope, whether the backend succeeded, and whether the response was shortened. Backend errors are translated into tool-call errors. Successful responses are wrapped as JSON so the caller receives a normal machine-readable answer.

#### Function details

##### `ListTool::tool_name`  (lines 46–48)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the extension system the public name of this tool. The name is built in the standard memory-tool format so callers can find and invoke it consistently.

**Data flow**: It reads the fixed list-tool name for memories, passes it through the shared memory-tool naming helper, and returns the finished tool name. It does not change any stored data.

**Call relations**: The tool framework calls this when it needs to identify which tool this executor represents. It hands off to the shared `memory_tool_name` helper so this tool follows the same naming pattern as the other memory tools.

*Call graph*: 1 external calls (memory_tool_name).


##### `ListTool::spec`  (lines 50–55)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This describes what the list tool does and what kind of input and output it expects. The wider system uses this specification to expose the tool safely and clearly to callers.

**Data flow**: It combines the list-tool name, the expected argument structure, the response structure, and a short human-readable description. The result is a tool specification object; no backend data is read or changed.

**Call relations**: The extension system asks for this specification when registering or advertising available tools. This function uses the shared memory-tool specification builder so the list tool is presented in the same format as the other memory tools.


##### `ListTool::handle`  (lines 57–59)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: This is the standard entry point used when someone actually invokes the list tool. It starts the asynchronous work needed to process the request.

**Data flow**: It receives a raw tool call, wraps the real handling work in a pinned future, and returns that future to the tool framework. The actual parsing, backend call, metrics, and response building happen later inside `ListTool::handle_call`.

**Call relations**: The tool framework calls this during request handling. It immediately delegates to `ListTool::handle_call`, because that function contains the step-by-step logic for serving the list request.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ListTool::handle_call`  (lines 66–94)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: This performs the real list operation from start to finish. It turns the incoming tool call into a backend list request, records whether it worked, and returns either a JSON response or a clean tool error.

**Data flow**: It starts with a raw tool call and reads its arguments into `ListArgs`. From those arguments it builds a scope label for metrics, clamps the requested result count to an allowed range, and sends a `ListMemoriesRequest` to the backend with the path, cursor, and limit. After the backend replies, it records metrics about success and truncation. If the backend returned an error, that error is converted into a function-call error; if it succeeded, the response is converted into JSON and boxed as tool output.

**Call relations**: This is called by `ListTool::handle` whenever the list tool is invoked. It coordinates several helpers: argument parsing for safe input, path-to-scope conversion for metrics, result-limit clamping for protection, the backend `list` call for the actual data, and JSON output creation for the final answer.

*Call graph*: calls 4 internal fn (record_tool_call, scope_from_optional_path, truncated_tag, new); called by 1 (handle); 5 external calls (clone, new, json!, clamp_max_results, parse_args).


### `ext/memories/src/tools/read.rs`

`orchestration` · `request handling`

This file is the front door for reading stored Codex memories through the extension tool system. A memory is addressed by a relative path, and the caller can optionally ask to start at a certain line and limit how many lines come back. Without this file, the backend might still know how to read memory files, but outside callers would not have a clean tool-shaped way to request them.

The main type is `ReadTool<B>`. It holds two things: a backend, which is the part that actually knows where and how memories are stored, and an optional metrics client, which is used to report basic facts about the call. Think of it like a library desk: this file receives the request slip, checks that it is filled out correctly, asks the archive for the document, notes whether the request succeeded, and hands the answer back in a standard envelope.

The tool declares its public name and its input/output shape so callers know how to use it. When a call arrives, it parses the JSON arguments into `ReadArgs`, fills in defaults such as starting at line 1, applies a maximum token limit to avoid overly large responses, and calls the backend. It records metrics using a scope derived from the path and a tag saying whether the response was truncated. Backend errors are converted into tool-call errors, while successful reads are wrapped as JSON output.

#### Function details

##### `ReadTool::tool_name`  (lines 45–47)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This returns the public name used to identify the read-memory tool. Callers and the tool system use this name to route a request to this file.

**Data flow**: It reads the fixed read-tool name from the crate, passes it through the shared memory-tool naming helper, and returns the finished `ToolName`. No stored data is changed.

**Call relations**: When the tool registry or executor needs to know what this tool is called, it asks this method. The method delegates the naming format to `memory_tool_name` so all memory tools are named consistently.

*Call graph*: 1 external calls (memory_tool_name).


##### `ReadTool::spec`  (lines 49–54)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This describes what the read tool expects as input and what it returns. It is the tool’s instruction card for callers.

**Data flow**: It uses the `ReadArgs` input shape, the `ReadMemoryResponse` output shape, the read-tool name, and a plain-language description to build a `ToolSpec`. It returns that specification without changing anything else.

**Call relations**: The tool system calls this when it needs to advertise or validate the tool. It relies on the shared `memory_function_tool` helper so this read tool is described in the same format as the other memory tools.


##### `ReadTool::handle`  (lines 56–58)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: This is the required entry point for executing the read tool. It adapts the tool system’s call style into the asynchronous work done by `handle_call`.

**Data flow**: It receives a `ToolCall`, starts `handle_call` with that call, boxes and pins the future so the tool framework can hold onto it safely, and returns that future. The actual reading happens later when the future runs.

**Call relations**: The tool executor calls this when someone invokes the read tool. This method immediately hands the real work to `ReadTool::handle_call`, while packaging it in the form expected by the surrounding extension API.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ReadTool::handle_call`  (lines 65–91)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: This performs one complete read-memory request. It checks the caller’s arguments, asks the backend to read the memory file, records metrics, and returns either JSON data or a tool-friendly error.

**Data flow**: It starts with a raw `ToolCall`. It parses the call into a path plus optional line controls, clones the backend so it can be used during the asynchronous request, derives a metrics scope from the path, and sends a `ReadMemoryRequest` to the backend. The request includes the path, a default line offset of 1 if none was supplied, any requested line limit, and the built-in maximum token limit. After the backend replies, it records whether the call succeeded and whether the response was truncated. On failure, it converts the backend error into a function-call error. On success, it wraps the response as JSON tool output.

**Call relations**: This is called by `ReadTool::handle` whenever the read tool is invoked. It coordinates several helpers: `parse_args` turns the incoming call into typed arguments, `scope_from_path` and `truncated_tag` prepare metrics labels, `record_tool_call` reports the outcome, the backend does the actual read, and `backend_error_to_function_call` translates storage-layer failures into errors the tool system understands.

*Call graph*: calls 4 internal fn (record_tool_call, scope_from_path, truncated_tag, new); called by 1 (handle); 4 external calls (clone, new, json!, parse_args).


### `ext/memories/src/tools/search.rs`

`orchestration` · `request handling`

This file is the front door for searching Codex memory files through the extension tool system. A caller supplies one or more search strings, plus optional settings such as where to search, whether matching should care about letter case, how many surrounding lines to include, and how many results to return. Without this file, the memory backend might still know how to search, but outside callers would not have a clean tool-shaped way to ask for that search and receive a structured answer.

The main pieces are `SearchArgs` and `SearchTool`. `SearchArgs` describes the input the tool accepts. It is strict: unknown fields are rejected, and some values must be in sensible ranges, such as at least one query and at least one requested result when `max_results` is provided. This helps catch bad tool calls early.

`SearchTool` connects the extension API to the memory backend. When a call arrives, it parses the JSON arguments, chooses defaults for missing options, asks the backend to search, records whether the call succeeded, and wraps the backend response as JSON. A useful safety detail is that `max_results` is clamped, meaning callers cannot ask for an unlimited or overly large result set. Think of this file like a reception desk: it checks the request form, fills in default blanks, sends the request to the right office, logs the visit, and hands the answer back in a standard envelope.

#### Function details

##### `SearchTool::tool_name`  (lines 54–56)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This returns the public name of the search tool as the extension system should see it. It makes sure the raw search tool name is wrapped in the memory-tool naming style used by this extension.

**Data flow**: It takes the `SearchTool` instance, reads no search data from it, and uses the shared memory tool naming helper to build a `ToolName`. The result is the name that callers and the tool registry use to identify this tool.

**Call relations**: The extension API calls this when it needs to know what tool this executor represents. This function hands the base search name to `memory_tool_name`, so the search tool is registered under the same naming convention as the other memory tools.

*Call graph*: 1 external calls (memory_tool_name).


##### `SearchTool::spec`  (lines 58–63)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This describes the search tool to the outside world: what arguments it accepts and what kind of response it returns. Tool specifications are like instruction cards that let callers know how to use the tool correctly.

**Data flow**: It starts with the `SearchArgs` input shape and the `SearchMemoriesResponse` output shape, then builds a `ToolSpec` with a human-readable description of what the search does. The result is metadata, not an actual search.

**Call relations**: The extension system asks for this specification when advertising or validating available tools. This function does not call the backend; it prepares the contract that later tool calls must follow.


##### `SearchTool::handle`  (lines 65–67)

```
fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_>
```

**Purpose**: This is the synchronous-looking entry point required by the tool executor interface, but it starts the real asynchronous work. It accepts a tool call and returns a future, which is a promise that the answer will be available later.

**Data flow**: It receives a `ToolCall`, passes it into `handle_call`, and pins the resulting future so the extension runtime can safely wait for it. Nothing is searched immediately by this wrapper itself; it packages the work for asynchronous execution.

**Call relations**: The extension runtime calls this when someone invokes the search tool. `handle` immediately hands the request to `SearchTool::handle_call`, which performs parsing, backend search, metrics recording, and response formatting.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `SearchTool::handle_call`  (lines 74–92)

```
async fn handle_call(
        &self,
        call: ToolCall,
    ) -> Result<Box<dyn codex_extension_api::ToolOutput>, codex_extension_api::FunctionCallError>
```

**Purpose**: This performs one complete search-tool request from start to finish. It reads the caller’s arguments, asks the memory backend to search, records a success or failure metric, and returns either JSON results or a tool-call error.

**Data flow**: It receives a raw `ToolCall`. First it clones the backend so the asynchronous search can use it, then parses the call into `SearchArgs`. It derives a metrics scope from the optional path, converts the arguments into a backend search request, and awaits the backend response. Before returning, it records a metric that includes whether the call succeeded and whether the response was truncated. On success it wraps the search response in `JsonToolOutput`; on backend failure it converts the backend error into the extension API’s function-call error format.

**Call relations**: `SearchTool::handle` calls this whenever the tool is invoked. During the flow, it relies on helpers such as `parse_args` to understand the incoming JSON, `scope_from_optional_path` to label metrics, `record_tool_call` and `truncated_tag` to report what happened, and `JsonToolOutput::new` to send the backend’s answer back in the expected format.

*Call graph*: calls 4 internal fn (record_tool_call, scope_from_optional_path, truncated_tag, new); called by 1 (handle); 4 external calls (clone, new, json!, parse_args).


##### `SearchArgs::into_request`  (lines 96–111)

```
fn into_request(self) -> SearchMemoriesRequest
```

**Purpose**: This turns user-facing search arguments into the exact request object the memory backend expects. It also fills in defaults so callers can omit common options without causing ambiguity.

**Data flow**: It consumes a `SearchArgs` value. Required queries are carried over directly. Optional fields are either carried over or replaced with defaults: match mode defaults to `Any`, context lines to `0`, case sensitivity to `true`, normalized searching to `false`, and result count to a safe default capped by the allowed maximum. The output is a `SearchMemoriesRequest` ready for the backend.

**Call relations**: This conversion sits between argument parsing and the backend search. After `SearchTool::handle_call` has parsed a tool call, this function shapes those arguments into the backend’s language. It uses `clamp_max_results` so the backend receives a reasonable result limit rather than whatever number the caller supplied.

*Call graph*: 1 external calls (clamp_max_results).


### `memories/write/src/workspace.rs`

`orchestration` · `memory workspace setup, diff generation, and baseline reset`

This file is the cleanup and change-tracking layer for the memory-writing workflow. The project keeps a memory directory under Git so it can tell what files were added, edited, or deleted since the last known baseline. Think of it like taking a photo of a desk before work begins, then later comparing the desk to that photo.

The file does three main jobs. First, it makes sure the memory folder exists and has usable Git metadata for baseline comparison. Second, before every comparison, it deletes the generated `phase2_workspace_diff.md` file. That matters because this file is only a report for the next phase, not actual memory content; if it stayed in the folder, it could show up as a fake change in the next diff. Third, it can reset the baseline after the current memory state has been accepted, so future diffs start from the new state.

The diff report is written in a bounded, Git-style format. “Bounded” means it will not grow past a configured byte limit. If the diff is too large, the code cuts it safely at a valid text boundary and adds a clear truncation note. This protects prompts or downstream readers from being flooded with an oversized file.

#### Function details

##### `prepare_memory_workspace`  (lines 13–20)

```
async fn prepare_memory_workspace(root: &Path) -> anyhow::Result<()>
```

**Purpose**: This function gets the memory folder ready before work begins. It creates the folder if needed, removes any old generated diff report, and makes sure there is a usable Git baseline for later comparison.

**Data flow**: It receives the path to the memory root folder. It creates that folder on disk, deletes the generated workspace diff file if it exists, then asks the Git utility layer to initialize or repair the baseline metadata. It returns success if the workspace is ready, or an error with context if setup fails.

**Call relations**: The main run flow calls this before producing or comparing memory changes. It relies on `remove_workspace_diff` so the generated report is not mistaken for memory input, then hands off to the external Git baseline helper to make the folder diffable.

*Call graph*: calls 1 internal fn (remove_workspace_diff); called by 1 (run); 2 external calls (ensure_git_baseline_repository, create_dir_all).


##### `memory_workspace_diff`  (lines 26–29)

```
async fn memory_workspace_diff(root: &Path) -> anyhow::Result<GitBaselineDiff>
```

**Purpose**: This function asks, “What changed in the memory workspace since the last baseline?” It first removes the generated diff report so that report does not count as a real change.

**Data flow**: It receives the memory root path. It deletes `phase2_workspace_diff.md` if present, then asks the Git utility layer for the difference between the current folder and the latest initialized baseline. It returns a `GitBaselineDiff`, which contains change statuses and the text diff.

**Call relations**: The main run flow calls this when it needs the current memory changes. It uses `remove_workspace_diff` as a guard step, then delegates the actual Git comparison to `diff_since_latest_init`.

*Call graph*: calls 1 internal fn (remove_workspace_diff); called by 1 (run); 1 external calls (diff_since_latest_init).


##### `write_workspace_diff`  (lines 32–37)

```
async fn write_workspace_diff(root: &Path, diff: &GitBaselineDiff) -> anyhow::Result<()>
```

**Purpose**: This function writes the human-readable diff report file, `phase2_workspace_diff.md`. That file tells the next phase what changed in the memory workspace.

**Data flow**: It receives the memory root path and a prepared Git baseline diff. It builds the report text using `render_workspace_diff_file`, joins the root path with the configured report filename, and writes the rendered text to disk. It returns success or an error that names the file it could not write.

**Call relations**: The main run flow calls this after it has collected the diff. This function bridges the in-memory diff data to a disk file by formatting it first, then using asynchronous file writing to save it.

*Call graph*: calls 1 internal fn (render_workspace_diff_file); called by 1 (run); 2 external calls (join, write).


##### `reset_memory_workspace_baseline`  (lines 43–46)

```
async fn reset_memory_workspace_baseline(root: &Path) -> anyhow::Result<()>
```

**Purpose**: This function marks the current memory folder as the new “clean starting point.” It is used after changes have been accepted so future comparisons only show newer changes.

**Data flow**: It receives the memory root path. It removes the generated diff report first, then tells the Git utility layer to reset the repository baseline to the folder’s current contents. It returns success or an error if cleanup or reset fails.

**Call relations**: The higher-level `handle` flow calls this when it is time to accept the current memory state. It calls `remove_workspace_diff` first because the report file is only a prompt artifact and should not be preserved as part of the new memory baseline.

*Call graph*: calls 1 internal fn (remove_workspace_diff); called by 1 (handle); 1 external calls (reset_git_repository).


##### `remove_workspace_diff`  (lines 53–61)

```
async fn remove_workspace_diff(root: &Path) -> anyhow::Result<()>
```

**Purpose**: This function deletes the generated `phase2_workspace_diff.md` file if it exists. It deliberately leaves real memory files and the `.git` baseline data alone.

**Data flow**: It receives the memory root path, builds the full path to the generated diff report, and tries to remove that file. If the file is already missing, that is treated as fine. If another file-system error happens, it returns an error with the file path included for easier diagnosis.

**Call relations**: This is the shared cleanup step used before preparing, diffing, and resetting the workspace. The other functions call it to make sure the generated report never becomes input to Git diffing or part of a saved baseline.

*Call graph*: called by 3 (memory_workspace_diff, prepare_memory_workspace, reset_memory_workspace_baseline); 2 external calls (join, remove_file).


##### `render_workspace_diff_file`  (lines 63–82)

```
fn render_workspace_diff_file(diff: &GitBaselineDiff) -> String
```

**Purpose**: This function turns a structured Git diff into the Markdown text saved in `phase2_workspace_diff.md`. It gives readers a short status list first, then the detailed diff when changes exist.

**Data flow**: It receives a `GitBaselineDiff`, which includes changed paths, their statuses, and a unified diff. It starts with a fixed heading and instructions, adds either `none` or a list of changed files, then appends the detailed diff through `append_bounded_diff`. It returns the complete report as a string.

**Call relations**: `write_workspace_diff` calls this just before writing the report to disk. It calls `append_bounded_diff` so the detailed diff is included without exceeding the configured size limit.

*Call graph*: calls 2 internal fn (has_changes, append_bounded_diff); called by 1 (write_workspace_diff); 2 external calls (from, format!).


##### `append_bounded_diff`  (lines 84–102)

```
fn append_bounded_diff(rendered: &mut String, diff: &str)
```

**Purpose**: This function appends diff text to the report while enforcing a maximum size. If the diff is too large, it includes only the beginning and adds a clear message saying it was truncated.

**Data flow**: It receives a mutable report string and the raw diff text. If the diff fits within the configured byte limit, it appends it and makes sure it ends with a newline. If it is too long, it finds a safe cut point, appends only that slice, adds any needed newline, and writes a truncation notice.

**Call relations**: `render_workspace_diff_file` calls this when adding the detailed diff section. When truncation is needed, it asks `previous_char_boundary` for a safe place to cut so the resulting text remains valid.

*Call graph*: calls 1 internal fn (previous_char_boundary); called by 1 (render_workspace_diff_file); 1 external calls (format!).


##### `previous_char_boundary`  (lines 104–113)

```
fn previous_char_boundary(value: &str, max_bytes: usize) -> usize
```

**Purpose**: This function finds a safe byte position for cutting a text string. It prevents the code from slicing through the middle of a multi-byte character, which would make invalid text.

**Data flow**: It receives a string and a maximum byte position. If the maximum is already past the end, it returns the string length. Otherwise, it walks backward from the requested byte limit until it reaches a valid character boundary, then returns that index.

**Call relations**: `append_bounded_diff` uses this only when a diff must be shortened. It supplies the safe cut point that lets the report stay readable and valid even after truncation.

*Call graph*: called by 1 (append_bounded_diff).


### Skills subsystem and extension tools
These files present the core and extension-side skills machinery, from shared APIs and invocation helpers through providers, source routing, extension wiring, and the exposed skills tools.

### `core-skills/src/lib.rs`

`orchestration` · `cross-cutting`

This file does not contain the skill-loading logic itself. Instead, it acts like the table of contents and public reception desk for the core-skills crate, which is the Rust package for working with “skills” in this project. A skill appears to be a packaged capability with metadata, loading rules, rendering text, and invocation behavior.

The first part lists the modules that make up the library, such as configuration rules, loading, management, remote skill support, rendering, and the skill data model. Some modules are public, meaning other crates can refer to them directly. Others are kept private to this crate, which helps protect internal details from becoming accidental public promises.

The second part re-exports selected types and functions. A re-export is like putting commonly used tools on the front counter so callers do not need to know which back room they came from. For example, outside code can import SkillsManager, SkillMetadata, or build_available_skills from this crate root instead of digging through module paths.

Without this file, the library would not have a clear public shape. Other parts of the system would need to know more about the internal folder layout, and changing that layout later would be much harder.


### `core-skills/src/invocation_utils.rs`

`domain_logic` · `command inspection`

A skill in this project appears to have a main document, usually SKILLS.md, and may also have a scripts folder beside it. This file builds quick lookup tables for those paths, then uses them to inspect a shell command and decide whether the command is implicitly invoking a skill. Without this, the system could miss that a user is using a skill just because they ran `python path/to/scripts/tool.py` or opened the skill’s documentation instead of calling the skill by name.

The flow is simple. First, `build_implicit_skill_path_indexes` takes the loaded skills and makes two maps: one from each skill’s scripts directory to that skill, and one from each skill document path to that skill. Paths are canonicalized when possible, meaning they are turned into their real filesystem form, so small differences like `.` or symbolic links are less likely to confuse the lookup.

Later, `detect_implicit_skill_invocation_for_command` receives a command string and the working directory where it will run. It splits the command into tokens, like a shell would. It first checks whether the command runs a known script with a runner such as Python, Bash, Node, or Ruby. If that does not match, it checks whether the command reads a known skill document. If either check succeeds, it returns the matching skill metadata.

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

**Purpose**: This prepares fast lookup tables so later code can recognize skill use from file paths. It records both the path to each skill’s main document and the path to the scripts folder beside that document.

**Data flow**: It receives a list of skill metadata records. For each skill, it normalizes the path to the skill document if the file exists, stores that path as a key, then looks for the neighboring `scripts` directory path and stores that too. It returns two maps: scripts directory → skill, and skill document path → skill.

**Call relations**: This is setup work for later detection. It relies on `canonicalize_if_exists` so the paths stored in the indexes match the normalized paths used when commands are checked.

*Call graph*: calls 1 internal fn (canonicalize_if_exists); 1 external calls (new).


##### `detect_implicit_skill_invocation_for_command`  (lines 31–44)

```
fn detect_implicit_skill_invocation_for_command(
    outcome: &SkillLoadOutcome,
    command: &str,
    workdir: &AbsolutePathBuf,
) -> Option<SkillMetadata>
```

**Purpose**: This is the main checker for a single shell command. It decides whether the command appears to use a skill indirectly, either by running a skill script or reading a skill document.

**Data flow**: It receives the loaded-skill outcome, a command string, and the current working directory. It normalizes the working directory, splits the command into shell-like tokens, then tries script detection first and document-read detection second. It returns the matching skill metadata if one is found, or nothing if the command does not point at a known skill.

**Call relations**: Other code can call this when it is about to interpret or audit a command. It delegates the smaller jobs to `tokenize_command`, `detect_skill_script_run`, and `detect_skill_doc_read`, using `canonicalize_if_exists` to keep path comparison consistent.

*Call graph*: calls 4 internal fn (canonicalize_if_exists, detect_skill_doc_read, detect_skill_script_run, tokenize_command).


##### `tokenize_command`  (lines 46–49)

```
fn tokenize_command(command: &str) -> Vec<String>
```

**Purpose**: This breaks a command string into pieces in a way that respects common shell quoting. For example, it tries to keep a quoted path with spaces as one token.

**Data flow**: It receives the raw command text. It first tries shell-style splitting; if that fails, it falls back to a simpler split on whitespace. It returns a list of string tokens.

**Call relations**: It is called by `detect_implicit_skill_invocation_for_command` before any deeper inspection happens. The later script and document checks depend on this token list instead of trying to parse the raw command text themselves.

*Call graph*: called by 1 (detect_implicit_skill_invocation_for_command); 1 external calls (split).


##### `script_run_token`  (lines 51–81)

```
fn script_run_token(tokens: &[String]) -> Option<&str>
```

**Purpose**: This looks at command tokens and asks: does this look like a script being run by a known interpreter, such as Python, Bash, Node, or Ruby? If so, it returns the token that names the script file.

**Data flow**: It receives already-split command tokens. It checks the first token as the runner command, strips it down to its base name, accepts known runners, skips flags like `-m` or separators like `--`, then looks for the first real script argument. If that argument has a recognized script extension, it returns it; otherwise it returns nothing.

**Call relations**: It is used by `detect_skill_script_run` as the first filter. It calls `command_basename` so commands like `/usr/bin/python3` or `python.exe` can still be recognized as Python.

*Call graph*: calls 1 internal fn (command_basename); called by 1 (detect_skill_script_run).


##### `detect_skill_script_run`  (lines 83–99)

```
fn detect_skill_script_run(
    outcome: &SkillLoadOutcome,
    tokens: &[String],
    workdir: &AbsolutePathBuf,
) -> Option<SkillMetadata>
```

**Purpose**: This checks whether a command is running a script that lives inside a known skill’s scripts directory. It is how the system notices skill use through commands like `python ./some-skill/scripts/helper.py`.

**Data flow**: It receives the loaded skill indexes, command tokens, and the working directory. It asks `script_run_token` for the script path, resolves that path relative to the working directory, normalizes it if possible, then walks upward through its parent directories. If any ancestor directory matches a known scripts directory, it returns that skill.

**Call relations**: It is the first detection path used by `detect_implicit_skill_invocation_for_command`. It uses `canonicalize_if_exists` for reliable path comparison, and it depends on the scripts-directory map built earlier by `build_implicit_skill_path_indexes`.

*Call graph*: calls 3 internal fn (canonicalize_if_exists, script_run_token, join); called by 1 (detect_implicit_skill_invocation_for_command); 1 external calls (new).


##### `detect_skill_doc_read`  (lines 101–116)

```
fn detect_skill_doc_read(
    outcome: &SkillLoadOutcome,
    tokens: &[String],
    workdir: &AbsolutePathBuf,
) -> Option<SkillMetadata>
```

**Purpose**: This checks whether a command reads a known skill document. It catches cases where a user or process opens the skill’s instructions directly rather than invoking the skill by name.

**Data flow**: It receives the loaded skill indexes, command tokens, and the working directory. It parses the tokens into higher-level command actions, looks for read operations, resolves each read path relative to the working directory, normalizes it if possible, and compares it with the known skill document paths. If it finds a match, it returns that skill.

**Call relations**: It is called by `detect_implicit_skill_invocation_for_command` after script-run detection fails. It uses the command parser to understand read-like commands and the document-path map built by `build_implicit_skill_path_indexes`.

*Call graph*: calls 3 internal fn (canonicalize_if_exists, parse_command_impl, join); called by 1 (detect_implicit_skill_invocation_for_command).


##### `command_basename`  (lines 118–124)

```
fn command_basename(command: &str) -> String
```

**Purpose**: This extracts just the command name from a longer command path. For example, it turns `/usr/bin/python3` into `python3`.

**Data flow**: It receives a command string. It treats it as a filesystem path, tries to take the final name component, and returns that as text. If it cannot extract a clean name, it returns the original string.

**Call relations**: It is called by `script_run_token` so runner detection works whether the user wrote `python3`, `/usr/bin/python3`, or another path-like form.

*Call graph*: called by 1 (script_run_token); 1 external calls (new).


##### `canonicalize_if_exists`  (lines 126–128)

```
fn canonicalize_if_exists(path: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: This normalizes a path when the filesystem can confirm it exists, but safely leaves it unchanged when it cannot. It helps different spellings of the same real path compare equal.

**Data flow**: It receives an absolute path. It asks the filesystem for the path’s canonical form, which is the cleaned-up real location. If that succeeds, it returns the canonical path; if it fails, it returns the original path unchanged.

**Call relations**: This helper is used both when building the skill path indexes and when checking commands later. That symmetry matters: both sides of a comparison are cleaned up the same way, making matches more reliable.

*Call graph*: calls 1 internal fn (canonicalize); called by 4 (build_implicit_skill_path_indexes, detect_implicit_skill_invocation_for_command, detect_skill_doc_read, detect_skill_script_run).


### `core-skills/src/remote.rs`

`io_transport` · `on demand during remote skill listing or download`

This file exists so the rest of the system can treat remote skills as simple things to list and download, instead of knowing the details of web requests, authentication, zip files, and safe file paths. A “remote skill” here is a packaged skill stored on a server. The code asks the server for available skills, or asks it to export one skill as a zip archive, then unpacks that archive locally.

Before it talks to the server, it checks that the user is signed in with ChatGPT/Codex backend authentication. API-key authentication is deliberately rejected for this feature. That matters because remote skill scopes appear to rely on the backend account context.

For listing, the file builds a `/hazelnuts` request with plain query values such as the product surface and scope, sends it with a 30-second timeout, checks that the server succeeded, and converts the JSON reply into simple `RemoteSkillSummary` records.

For downloading, it calls `/hazelnuts/{skill_id}/export`, verifies the response looks like a zip file, creates a local `skills/<skill_id>` directory, and extracts files there. The extraction code is careful: it strips expected top-level zip folder names and refuses unsafe paths such as absolute paths or `..` parent-directory jumps. This is like checking every package label before putting it on a shelf, so a bad package cannot write files outside the intended shelf.

#### Function details

##### `as_query_scope`  (lines 33–40)

```
fn as_query_scope(scope: RemoteSkillScope) -> Option<&'static str>
```

**Purpose**: Turns the program’s internal remote-skill scope choice into the exact text the server expects in the web request. For example, the internal `Personal` choice becomes the query value `personal`.

**Data flow**: It receives a `RemoteSkillScope` value, matches it against the known scope options, and returns the matching query-string text wrapped in `Some`. Nothing outside the function is changed.

**Call relations**: When `list_remote_skills` is preparing its server request, it calls this helper so the request uses the server’s vocabulary rather than Rust enum names.

*Call graph*: called by 1 (list_remote_skills).


##### `as_query_product_surface`  (lines 42–49)

```
fn as_query_product_surface(product_surface: RemoteSkillProductSurface) -> &'static str
```

**Purpose**: Turns the internal product-surface choice into the text the remote service expects. A product surface means which product area the skill is for, such as ChatGPT, Codex, API, or Atlas.

**Data flow**: It receives a `RemoteSkillProductSurface` value, chooses the corresponding lowercase string, and returns that string. It does not read or change any other state.

**Call relations**: When `list_remote_skills` builds the `/hazelnuts` request, it calls this function to add the correct `product_surface` query parameter.

*Call graph*: called by 1 (list_remote_skills).


##### `ensure_codex_backend_auth`  (lines 51–61)

```
fn ensure_codex_backend_auth(auth: Option<&CodexAuth>) -> Result<&CodexAuth>
```

**Purpose**: Checks that the caller has provided the right kind of sign-in information for remote skills. It rejects missing authentication and API-key authentication because this feature requires ChatGPT/Codex backend authentication.

**Data flow**: It receives an optional reference to `CodexAuth`. If there is no authentication, or if the authentication is not for the Codex backend, it returns an error. If the authentication is acceptable, it returns the same authentication reference so the caller can use it in a request.

**Call relations**: Both `list_remote_skills` and `export_remote_skill` call this first, before any network request is sent. This keeps the authentication rule in one place and prevents later code from accidentally calling the remote service with unsupported credentials.

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

**Purpose**: Asks the remote service for a list of available skills and returns a clean summary list to the caller. This is the read-only “show me what skills exist” operation.

**Data flow**: It receives a base server URL, optional authentication, a skill scope, a product surface, and an optional enabled/disabled filter. It trims the base URL, verifies authentication, converts the scope and product surface into query text, builds an HTTP GET request to `/hazelnuts`, attaches authentication headers, and waits for the response. If the server reports an error, it returns an error with the status and body. If the response succeeds, it parses the JSON field named `hazelnuts` into skill records and returns a vector of `RemoteSkillSummary` values containing each skill’s id, name, and description.

**Call relations**: This is the main listing entry point in the file. It relies on `ensure_codex_backend_auth` for the access check, `as_query_product_surface` and `as_query_scope` for request parameters, the shared HTTP client builder for network setup, and JSON parsing to turn the server reply into simple Rust data.

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

**Purpose**: Downloads one remote skill as a zip archive and installs it into the local Codex skills directory. This is the “bring this remote skill onto my machine” operation.

**Data flow**: It receives the server URL, the local Codex home folder, optional authentication, and the skill id. It verifies authentication, builds a GET request to `/hazelnuts/{skill_id}/export`, sends it, and reads the response bytes. If the response failed, it reports the server status and response text. If the bytes do not look like a zip file, it rejects them. Otherwise it creates `codex_home/skills/<skill_id>`, then runs zip extraction in a blocking worker task so the async runtime is not tied up by file work. On success it returns the downloaded skill id and the local path where files were written.

**Call relations**: This is the main download entry point in the file. It calls `ensure_codex_backend_auth` before networking, `is_zip_payload` before trusting the download, and then hands the archive bytes to `extract_zip_to_dir`, which does the careful unpacking.

*Call graph*: calls 3 internal fn (ensure_codex_backend_auth, is_zip_payload, build_reqwest_client); 8 external calls (join, from_utf8_lossy, bail!, auth_provider_from_auth, format!, create_dir_all, spawn_blocking, vec!).


##### `safe_join`  (lines 193–204)

```
fn safe_join(base: &Path, name: &str) -> Result<PathBuf>
```

**Purpose**: Safely combines an output directory with a file name from the zip archive. Its job is to stop a malicious archive from writing outside the intended skill folder.

**Data flow**: It receives a trusted base directory and an archive file name. It breaks the file name into path pieces and only allows normal pieces such as folder or file names. If it sees anything suspicious, such as an absolute path or parent-directory component, it returns an error. If the name is safe, it returns the base directory joined with that path.

**Call relations**: `extract_zip_to_dir` calls this for every file it wants to write. This makes path safety part of the extraction process rather than trusting names that came from the downloaded zip.

*Call graph*: called by 1 (extract_zip_to_dir); 3 external calls (join, new, bail!).


##### `is_zip_payload`  (lines 206–210)

```
fn is_zip_payload(bytes: &[u8]) -> bool
```

**Purpose**: Performs a quick check that downloaded bytes look like a zip archive. It helps catch obvious wrong responses before the code tries to unpack them.

**Data flow**: It receives raw bytes from the server and checks whether they start with one of the standard zip signatures. It returns `true` if the bytes match one of those signatures and `false` otherwise.

**Call relations**: `export_remote_skill` calls this immediately after reading a successful download response. Only payloads that pass this check are sent on to the zip extraction step.

*Call graph*: called by 1 (export_remote_skill).


##### `extract_zip_to_dir`  (lines 212–240)

```
fn extract_zip_to_dir(
    bytes: Vec<u8>,
    output_dir: &Path,
    prefix_candidates: &[String],
) -> Result<()>
```

**Purpose**: Unpacks a zip archive into a chosen output folder while keeping only useful file entries and writing them safely. This turns the downloaded skill package into real files on disk.

**Data flow**: It receives the zip bytes, the output directory, and possible top-level folder names to strip away. It opens the zip archive, walks through every entry, skips directories, normalizes each file name, and ignores entries that normalize to nothing. For each remaining file, it uses `safe_join` to choose a safe destination path, creates any needed parent folders, creates the output file, and copies the archive contents into it. It returns success when all accepted files are written, or an error if opening, reading, creating, or writing fails.

**Call relations**: `export_remote_skill` hands downloaded zip bytes to this function inside a blocking task. Inside the extraction loop, this function calls `normalize_zip_name` to clean up archive names and `safe_join` to prevent unsafe writes.

*Call graph*: calls 3 internal fn (normalize_zip_name, safe_join, new); 4 external calls (create, create_dir_all, copy, new).


##### `normalize_zip_name`  (lines 242–259)

```
fn normalize_zip_name(name: &str, prefix_candidates: &[String]) -> Option<String>
```

**Purpose**: Cleans up a file name from the zip archive so it lands neatly inside the skill folder. In particular, it removes a leading `./` and can strip an expected top-level folder such as the skill id.

**Data flow**: It receives a raw archive name and a list of possible folder prefixes. It trims leading `./`, then checks whether the name starts with any non-empty prefix followed by `/`; if so, it removes that prefix. If nothing remains, it returns `None`, meaning there is no file path to write. Otherwise it returns the cleaned path text.

**Call relations**: `extract_zip_to_dir` calls this for each file entry before deciding where to write it. The cleaned name is then passed to `safe_join`, which performs the stricter safety check before disk output.

*Call graph*: called by 1 (extract_zip_to_dir); 1 external calls (format!).


### `ext/skills/src/lib.rs`

`orchestration` · `cross-cutting`

This file works like the table of contents and public reception desk for the skills extension. The extension appears to deal with “skills”: reusable capabilities supplied by different providers, such as a host, executor, or orchestrator. Most of the real work lives in the neighboring modules, such as configuration, provider definitions, source selection, rendering, state, and tools.

The important job here is visibility. Some modules are made public, meaning outside code can refer to them by name, while others stay private inside the library. Then this file re-exports selected types and functions, such as `install`, `SkillsExtensionConfig`, and the main skill provider traits and structs. A re-export is like putting commonly needed items on the front counter so callers do not have to walk through the whole warehouse to find them.

Without this file, the Rust compiler would not know which source files belong to this library, and other parts of the project would have a harder time using the skills extension. It does not run business logic itself; it organizes access to the pieces that do.


### `ext/skills/src/provider.rs`

`data_model` · `cross-cutting skill discovery and resource access`

This file is the front door for the skill provider layer. A “skill” here is a packaged ability or resource the system can discover and use. Skills may come from different places, such as the host environment, bundled built-in packages, an orchestrator, or MCP resources, which are external resources accessed through the Model Context Protocol. This file gives all those sources the same shape so the rest of the program can ask simple questions: “What skills are available?”, “Read this skill resource,” and “Search inside this skill package.”

The key idea is authority boundaries. In plain terms, if a skill came from one source, the program must go back to that same source to read or search it. It should not turn that skill into a loose local file path and bypass the provider. This is like checking out a library book through the same library system that cataloged it, rather than copying down a shelf location and sneaking around the rules.

The file also re-exports three concrete provider types: executor, host, and orchestrator providers. Those live in separate files, while this file defines the shared contract they follow. The request structs carry the information each operation needs, such as the current turn, selected roots, package IDs, resource IDs, and optional access to host-loaded skills or MCP resources.


### `ext/skills/src/provider/executor.rs`

`domain_logic` · `skill listing and skill read requests`

An execution environment is a separate place where files can live, such as a sandbox or remote workspace. This file provides a bridge between that environment and the skill catalog. Without it, skills stored in executor-owned folders would not appear in the catalog, and users could not read their skill definitions through the normal skill-provider interface.

The main type is `ExecutorSkillProvider`. It keeps a shared reference to an `EnvironmentManager`, which is the object that knows how to find environments by ID. When asked to list skills, the provider walks through the selected executor roots from the query. For each root, it checks that the referenced environment exists, checks that the path is an absolute path, then asks the core skill loader to scan that folder. It also filters the results for a specific product when a product restriction is set, so skills meant for another product can be disabled or excluded as appropriate.

Each discovered skill is converted into a `SkillCatalogEntry`, which is the catalog’s standard “card” for a skill: name, description, display path, dependencies, resource ID, and visibility flags. When asked to read a skill, the provider validates that the request really points to an executor skill, finds the right environment, and reads the skill file text from that environment’s filesystem. Search is intentionally empty here, so this provider contributes list-and-read behavior but no separate search results.

#### Function details

##### `ExecutorSkillProvider::new_with_restriction_product`  (lines 38–46)

```
fn new_with_restriction_product(
        environment_manager: Arc<EnvironmentManager>,
        restriction_product: Option<Product>,
    ) -> Self
```

**Purpose**: Creates an executor-backed skill provider. The caller gives it access to the environment manager and may also give it a product restriction, which limits or marks skills based on which product they belong to.

**Data flow**: It receives a shared `EnvironmentManager` and an optional `Product`. It stores both values inside a new `ExecutorSkillProvider`. The result is a provider object ready to list and read executor skills.

**Call relations**: This is the setup step used by higher-level construction and tests, including `new`, `refresh_test_state`, and `selected_root_id_distinguishes_identical_executor_paths`. After this object is created, its `list`, `read`, and `search` methods can be called through the `SkillProvider` interface.

*Call graph*: called by 3 (refresh_test_state, new, selected_root_id_distinguishes_identical_executor_paths).


##### `ExecutorSkillProvider::list`  (lines 50–109)

```
fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Builds a catalog of skills found under the executor roots selected by the caller. It also records warnings instead of failing the whole listing when one root is missing, invalid, or contains broken skill data.

**Data flow**: It receives a `SkillListQuery` containing selected executor roots. For each root, it reads the environment ID and path, looks up the environment, verifies the path is absolute, loads skills from that environment’s filesystem, filters the load result for the configured product, and turns each skill into a catalog entry. It returns a `SkillCatalog` containing entries plus any warnings gathered along the way.

**Call relations**: This is the main discovery path for executor skills. It calls `executor_absolute_path` before touching the filesystem, calls `load_skills_from_roots` to scan for skill metadata, passes that result through `filter_skill_load_outcome_for_product`, and uses `catalog_entry_from_skill` to convert each loaded skill into the catalog format used by the rest of the skills system.

*Call graph*: calls 4 internal fn (load_skills_from_roots, new, catalog_entry_from_skill, executor_absolute_path); 5 external calls (clone, pin, filter_skill_load_outcome_for_product, default, format!).


##### `ExecutorSkillProvider::read`  (lines 111–151)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Reads the text of one executor skill resource from its environment filesystem. It protects the provider from being asked to read the wrong kind of resource by checking the authority, package, environment binding, and environment availability first.

**Data flow**: It receives a `SkillReadRequest`. It checks that the request is for an executor skill, confirms the package and resource match, extracts the environment ID and file path from the resource ID, finds the environment, converts the path into a filesystem URI, and reads the file as text. It returns a `SkillReadResult` containing the original resource ID and the file contents, or a clear provider error if any step fails.

**Call relations**: This is used when some caller already has a catalog entry and wants the actual skill file contents. It relies on the resource IDs created by `catalog_entry_from_skill`, because those IDs carry the environment ID and absolute path needed to read the file later.

*Call graph*: calls 2 internal fn (new, from_abs_path); 2 external calls (pin, format!).


##### `ExecutorSkillProvider::search`  (lines 153–155)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Returns no search results for executor skills. This provider supports listing and reading, but it does not implement a separate search feature.

**Data flow**: It receives a search request but does not inspect it. It creates and returns an empty `SkillSearchResult`, leaving all data unchanged.

**Call relations**: This method completes the `SkillProvider` interface. When the broader skills system asks every provider to search, this provider simply contributes an empty result instead of scanning executor files again.

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

**Purpose**: Converts raw loaded skill metadata into the catalog entry format used by the rest of the system. This is where executor skill files become user-facing catalog items with names, descriptions, display paths, dependencies, and visibility flags.

**Data flow**: It receives a loaded `SkillMetadata`, whether that skill is enabled, the authority describing where it came from, the selected root ID, and the environment ID. It builds a stable display path like a `skill://...` address, creates a package ID and environment-bound resource ID, copies descriptive fields and dependencies, then marks the entry disabled or hidden from prompts when the skill metadata says so. It returns the completed `SkillCatalogEntry`.

**Call relations**: This helper is called by `ExecutorSkillProvider::list` for every skill successfully loaded from an executor root. The entry it creates is later important to `ExecutorSkillProvider::read`, because its resource ID preserves enough information to find the same file again inside the correct environment.

*Call graph*: calls 2 internal fn (new, environment); called by 1 (list); 3 external calls (allows_implicit_invocation, new, format!).


##### `executor_absolute_path`  (lines 196–205)

```
fn executor_absolute_path(path: &str) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Checks that an executor root path is absolute and converts it into the project’s trusted absolute-path type. This prevents the loader from receiving vague relative paths like `../skills`, which could mean different things depending on where the process is running.

**Data flow**: It receives a path string. It turns the string into a filesystem path, rejects it if it is not absolute, and then asks `AbsolutePathBuf` to validate and wrap it. It returns either the validated absolute path or an input error explaining that the executor path must be absolute.

**Call relations**: This helper is called by `ExecutorSkillProvider::list` before loading skills from a selected root. If it returns an error, listing records a warning for that root and moves on to the next one instead of trying to scan an unsafe or unclear path.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 1 (list); 2 external calls (from, new).


### `ext/skills/src/provider/host.rs`

`domain_logic` · `request handling`

The main program, called the host here, is responsible for finding and loading skills from all the places it knows about: plugin folders, extra runtime folders, and the normal environment. This file does not try to load those skills again. Instead, it provides a thin bridge called `HostSkillProvider` that says, “Use the skills the host already found.”

When someone asks for a list of skills, the provider checks that loaded host skills were included in the request. If they were not, it returns a clear error, because this provider cannot work without that host-owned data. If they were included, it turns the host’s loaded skill result into a `SkillCatalog`, which is the extension system’s standard list of available skills. Any loading errors become warnings in that catalog, so users can still see the good skills while being told what failed.

When someone asks to read a skill, the provider looks for a loaded skill whose `SKILLS.md` path matches the requested resource. It accepts both normal platform paths and slash-based paths, which matters on Windows where paths often use backslashes. It then asks the host-loaded skill object to read the text. Search is intentionally empty for this provider; it only exposes the already-known host skills.

#### Function details

##### `HostSkillProvider::new`  (lines 31–33)

```
fn new() -> Self
```

**Purpose**: Creates a new host skill provider. Someone uses this when wiring the skills extension into the larger system and wants a provider that exposes the host’s already-loaded skills.

**Data flow**: Nothing is passed in. The function creates an empty `HostSkillProvider` value, because this provider does not keep its own cache or settings. The result is a ready-to-use provider object.

**Call relations**: The install flow calls this when setting up available skill providers. After that, the provider’s `list`, `read`, and `search` methods are called through the shared `SkillProvider` interface.

*Call graph*: called by 1 (install).


##### `HostSkillProvider::list`  (lines 37–47)

```
fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Builds a catalog of host-loaded skills for callers that want to know what skills are available. It fails early if the request did not include the host’s loaded skill data.

**Data flow**: It receives a `SkillListQuery`, which may contain a reference to already-loaded host skills. If that reference is missing, it returns an error explaining that host skills are required. If present, it takes the host’s load outcome and turns it into a `SkillCatalog`, including both skill entries and warnings about skills that failed to load.

**Call relations**: This is called when the skill system asks this provider for its available skills. Inside the asynchronous task, it calls `catalog_from_outcome` to do the actual translation from host load results into extension catalog entries.

*Call graph*: calls 2 internal fn (new, catalog_from_outcome); 1 external calls (pin).


##### `HostSkillProvider::read`  (lines 49–82)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Reads the text for one specific host-loaded skill resource. This is used after a caller has found a skill in the catalog and wants the actual contents behind it.

**Data flow**: It receives a `SkillReadRequest` containing the requested resource id and, ideally, the host’s loaded skills. First it checks that the loaded host skills are present. Then it searches those loaded skills for a matching `SKILLS.md` path, accepting both backslash and forward-slash path forms. If it finds the skill, it asks the host-loaded skill object to read the skill text. It returns the requested resource id plus the text, or an error if the host data is missing, the skill was not loaded, or the read failed.

**Call relations**: This method is called when the provider is asked to open a specific host skill. It does not read from a catalog entry directly; instead, it finds the matching loaded skill metadata and hands off the actual text reading to the host-loaded skills object.

*Call graph*: calls 1 internal fn (new); 2 external calls (pin, format!).


##### `HostSkillProvider::search`  (lines 84–86)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Returns an empty search result for host skills. This provider supports listing and reading host-loaded skills, but it does not implement separate search behavior.

**Data flow**: It receives a search request but does not inspect it. It immediately returns the default empty `SkillSearchResult`, meaning no search hits and no extra work.

**Call relations**: This is called when the shared provider interface asks this provider to search. Unlike `list` and `read`, it does not hand off to helper functions or host data, because search is intentionally a no-op here.

*Call graph*: 2 external calls (pin, default).


##### `catalog_from_outcome`  (lines 89–110)

```
fn catalog_from_outcome(outcome: &SkillLoadOutcome) -> SkillCatalog
```

**Purpose**: Turns the host’s skill-loading result into the extension system’s catalog format. This lets the rest of the extension code treat host-loaded skills the same way it treats skills from other sources.

**Data flow**: It receives a `SkillLoadOutcome`, which contains successfully loaded skills plus loading errors. It starts a new `SkillCatalog`, converts each loading error into a human-readable warning, then walks through each loaded skill together with whether it is enabled. For every skill, it creates a catalog entry and adds it to the catalog. The finished catalog comes out.

**Call relations**: `HostSkillProvider::list` calls this after confirming that host-loaded skills are available. For each individual skill, this helper calls `catalog_entry_from_skill` so the per-skill conversion stays in one focused place.

*Call graph*: calls 2 internal fn (skills_with_enabled, catalog_entry_from_skill); called by 1 (list); 1 external calls (new).


##### `catalog_entry_from_skill`  (lines 112–134)

```
fn catalog_entry_from_skill(skill: &SkillMetadata, enabled: bool) -> SkillCatalogEntry
```

**Purpose**: Builds one catalog entry from one host skill’s metadata. It records the skill’s name, description, path, dependencies, whether it is enabled, and whether it should be shown to the prompt.

**Data flow**: It receives a `SkillMetadata` object and a boolean saying whether that skill is enabled. It extracts the skill’s `SKILLS.md` path, creates both a stored resource id and a display-friendly path, and fills a new `SkillCatalogEntry` with the skill’s title, descriptions, source authority, resource id, and dependencies. If the skill is disabled, it marks the entry disabled. If the skill does not allow implicit invocation, it hides the entry from prompt use. The completed catalog entry is returned.

**Call relations**: `catalog_from_outcome` calls this once for each loaded host skill. The resulting entry is then pushed into the catalog that `HostSkillProvider::list` returns to callers.

*Call graph*: calls 3 internal fn (new, new, new); called by 1 (catalog_from_outcome); 2 external calls (allows_implicit_invocation, new).


### `ext/skills/src/provider/orchestrator.rs`

`domain_logic` · `skill discovery and skill read requests`

The orchestrator can expose skills as session resources. This file is the adapter that knows how to find those resources, check that they look safe and well-formed, and present them through the common SkillProvider interface used by the rest of the skills extension. Without it, orchestrator-owned skills would either be invisible or would have to leak MCP details into callers that should not need to know about the transport.

The main type, OrchestratorSkillProvider, is deliberately small. When asked to list skills, it first checks whether a session MCP resource client exists and whether the expected Codex Apps MCP server is available. It then pages through resources, like reading a catalog one page at a time, but with guardrails: a timeout, a maximum number of pages, a maximum number of skills, duplicate-cursor detection, and warnings when discovery is incomplete.

Only resources with the special skill MIME type are considered. Each candidate is converted into a SkillCatalogEntry only if its URI, name, description, and metadata pass validation. When asked to read a skill, the provider verifies that the request is really for the orchestrator, that the requested resource belongs under the package URI, then reads matching text contents with a timeout and size limit. Search is currently a no-op and returns no results.

#### Function details

##### `OrchestratorSkillProvider::new`  (lines 44–46)

```
fn new() -> Self
```

**Purpose**: Creates a new orchestrator skill provider. It exists so setup code can add this provider to the larger skills system without knowing any internal details.

**Data flow**: There is no input beyond the request to create it. The function returns an empty OrchestratorSkillProvider value, because this provider keeps no stored state of its own.

**Call relations**: The thread extension setup calls this when it wires available skill providers together. After that, the provider is used through the shared SkillProvider interface.

*Call graph*: called by 1 (thread_extensions).


##### `OrchestratorSkillProvider::list`  (lines 50–150)

```
fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>
```

**Purpose**: Finds orchestrator-published skills and returns them as a catalog the rest of the application can understand. It protects the caller from missing servers, slow resource discovery, malformed resources, and runaway pagination.

**Data flow**: It receives a SkillListQuery, mainly looking for a session MCP resource client. If there is no client or the expected MCP server is absent, it returns an empty catalog. Otherwise it asks the server for resource pages, filters for resources marked as orchestrator skills, converts valid ones into catalog entries, records warnings for partial or malformed discovery, and returns the completed catalog or an error if discovery fails before any page is read.

**Call relations**: Callers use this through the SkillProvider trait when building the available skills list. Inside the flow it creates a default catalog, uses timed MCP resource listing calls, and hands each matching resource to catalog_entry_from_resource so the validation and conversion rules stay in one place.

*Call graph*: calls 2 internal fn (new, catalog_entry_from_resource); 6 external calls (pin, new, default, format!, now, timeout_at).


##### `OrchestratorSkillProvider::read`  (lines 152–216)

```
fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>
```

**Purpose**: Reads the actual text for one orchestrator skill resource. It makes sure the request is allowed and points to a resource inside the claimed skill package before fetching any contents.

**Data flow**: It receives a SkillReadRequest containing the expected authority, package URI, resource URI, and optional MCP resource client. It rejects the request if the authority is not the orchestrator, if the resource URI does not belong under the package URI, or if no client is available. Then it reads the resource with a timeout, selects the text content whose URI exactly matches the requested resource, checks the size limit, and returns that text with the resource id.

**Call relations**: The skills system calls this through the SkillProvider trait when it needs to load a specific orchestrator skill. Before talking to MCP, it calls resource_belongs_to_package as a safety check; after that it performs the timed resource read and converts any transport failure into a SkillProviderError.

*Call graph*: calls 3 internal fn (new, new, resource_belongs_to_package); 3 external calls (pin, format!, timeout).


##### `OrchestratorSkillProvider::search`  (lines 218–220)

```
fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>
```

**Purpose**: Provides the required search method for the SkillProvider interface, but orchestrator skill search is not implemented here. It simply reports no search results.

**Data flow**: It receives a SkillSearchRequest but does not inspect it. It returns a default, empty SkillSearchResult and changes nothing.

**Call relations**: The broader skills system may call this because every provider has a search method. This provider does not delegate to any helper or MCP call for search; it immediately completes with an empty result.

*Call graph*: 2 external calls (pin, default).


##### `catalog_entry_from_resource`  (lines 223–249)

```
fn catalog_entry_from_resource(resource: &Resource) -> Option<SkillCatalogEntry>
```

**Purpose**: Turns one raw MCP resource into one safe skill catalog entry, if the resource contains all required information in the expected shape. It is the main gatekeeper for whether a discovered resource becomes a visible skill.

**Data flow**: It receives a Resource from the MCP listing. It validates the package URI, reads metadata such as skill_name, plugin_name, and source, normalizes the display name and description, builds the main SKILL.md resource URI, and returns a SkillCatalogEntry. If any required field is missing or unsafe, it returns nothing so the resource can be skipped.

**Call relations**: OrchestratorSkillProvider::list calls this for each resource with the orchestrator skill MIME type. This function gathers help from validated_skill_uri, normalized_label, normalized_description, and main_prompt_uri, then uses the catalog types to produce the entry that list adds to the catalog.

*Call graph*: calls 7 internal fn (new, new, new, main_prompt_uri, normalized_description, normalized_label, validated_skill_uri); called by 1 (list); 2 external calls (new, format!).


##### `validated_skill_uri`  (lines 251–253)

```
fn validated_skill_uri(uri: &str, max_chars: usize) -> Option<&str>
```

**Purpose**: Checks that a skill package URI is valid, then returns the original text if it passes. It is a small wrapper used when the caller wants to keep the URI string rather than the parsed URL object.

**Data flow**: It receives a URI string and a maximum character count. It asks validated_skill_url to parse and validate the URI; if that succeeds, it returns the original string slice, otherwise it returns nothing.

**Call relations**: catalog_entry_from_resource calls this before trusting a resource URI as a skill package id. The deeper URL rules live in validated_skill_url, so both listing and read-time checks use the same idea of a valid skill URL.

*Call graph*: calls 1 internal fn (validated_skill_url); called by 1 (catalog_entry_from_resource).


##### `validated_skill_url`  (lines 255–279)

```
fn validated_skill_url(uri: &str, max_chars: usize) -> Option<Url>
```

**Purpose**: Applies the strict rules for what counts as a safe skill URL. This prevents malformed, overly long, or surprising URLs from entering the skill catalog or being read.

**Data flow**: It receives a URI string and a character limit. It rejects strings that are too long or contain control characters, whitespace, or angle brackets, then parses the URI as a URL. It accepts only skill:// URLs with a host, non-empty path segments, no username, password, port, query, or fragment, and no parser-normalized changes to the text. On success it returns the parsed Url.

**Call relations**: validated_skill_uri uses this while building catalog entries, and resource_belongs_to_package uses it while checking read requests. Because both paths rely on this helper, discovery and reading follow the same URL safety rules.

*Call graph*: called by 2 (resource_belongs_to_package, validated_skill_uri); 1 external calls (parse).


##### `resource_belongs_to_package`  (lines 281–302)

```
fn resource_belongs_to_package(package: &str, resource: &str) -> bool
```

**Purpose**: Checks whether a requested skill resource is actually inside the package it claims to come from. This stops a read request from using one package id while fetching an unrelated resource.

**Data flow**: It receives a package URI and a resource URI as text. It validates both as skill URLs, compares their scheme and host, breaks their paths into segments, and confirms the resource path starts with the package path but is longer. It returns true only when the resource is a child of the package.

**Call relations**: OrchestratorSkillProvider::read calls this before reading from MCP. The helper relies on validated_skill_url so invalid package or resource strings fail safely instead of being treated as paths to read.

*Call graph*: calls 1 internal fn (validated_skill_url); called by 1 (read).


##### `normalized_label`  (lines 304–308)

```
fn normalized_label(value: &str, max_chars: usize) -> Option<String>
```

**Purpose**: Cleans and validates a short human-facing label, such as a skill name or plugin name. It keeps catalog names readable and avoids characters that could be unsafe in display contexts.

**Data flow**: It receives a text value and a maximum character count. It first turns the text into a single normalized line, then rejects empty labels or labels containing ampersand or angle brackets. If the label is acceptable, it returns the cleaned string.

**Call relations**: catalog_entry_from_resource calls this when extracting skill_name and, for non-user skills, plugin_name. It builds on normalized_single_line so all label cleanup follows the same whitespace and length rules.

*Call graph*: calls 1 internal fn (normalized_single_line); called by 1 (catalog_entry_from_resource).


##### `normalized_description`  (lines 310–317)

```
fn normalized_description(value: &str) -> Option<String>
```

**Purpose**: Cleans a skill description so it is a single safe line of text. Unlike labels, descriptions may contain special characters, so this function escapes them rather than rejecting them.

**Data flow**: It receives the raw description text. It normalizes whitespace and length through normalized_single_line, then replaces ampersand, less-than, and greater-than characters with safe text forms. It returns the cleaned description or nothing if the text is too long or contains control characters.

**Call relations**: catalog_entry_from_resource calls this while building the catalog entry description. It shares basic line cleanup with normalized_label through normalized_single_line, but then performs description-specific escaping.

*Call graph*: calls 1 internal fn (normalized_single_line); called by 1 (catalog_entry_from_resource).


##### `normalized_single_line`  (lines 319–323)

```
fn normalized_single_line(value: &str, max_chars: usize) -> Option<String>
```

**Purpose**: Turns messy text into one compact line and checks its basic safety. It is the shared cleanup step for names and descriptions.

**Data flow**: It receives text and a maximum character count. It splits the text on whitespace, joins the pieces with single spaces, rejects the result if it is too long or contains control characters, and returns the cleaned string if valid.

**Call relations**: normalized_label and normalized_description both call this first. That makes labels and descriptions behave consistently for whitespace, length, and control-character checks before each caller applies its own extra rules.

*Call graph*: called by 2 (normalized_description, normalized_label).


##### `main_prompt_uri`  (lines 325–327)

```
fn main_prompt_uri(package_uri: &str) -> String
```

**Purpose**: Builds the URI for the main skill prompt file inside a skill package. In this system, that main file is expected to be named SKILL.md.

**Data flow**: It receives a package URI as text. It removes any trailing slash and appends /SKILL.md, returning the resulting resource URI string.

**Call relations**: catalog_entry_from_resource calls this after validating the package URI. The returned URI becomes the SkillResourceId stored in the catalog entry, so later read operations know which resource represents the skill’s main prompt.

*Call graph*: called by 1 (catalog_entry_from_resource); 1 external calls (format!).


### `ext/skills/src/sources.rs`

`orchestration` · `request handling`

A “skill” is a capability the system can discover, read about, or search for. This file acts like a front desk for skill providers. Instead of the rest of the program needing to know every possible source, it can talk to one collection called `SkillProviders`.

Each `SkillProviderSource` wraps one real provider with two pieces of context: what kind of source it is, and a human-readable label used in warnings. The source kind matters because a request for an executor skill should not accidentally be sent to a host skill provider.

`SkillProviders` is the collection of these sources. It offers builder-style methods for adding host, executor, orchestrator, or custom providers. When listing skills for a turn, it asks only the providers that make sense for the query, then merges their catalogs. If one provider fails during normal listing, the system does not throw everything away; it adds a warning and keeps the skills from the providers that did answer. That makes the system more resilient.

Reading or searching is stricter. Those requests target a specific source kind, so this file tries matching providers until one succeeds. If none are configured, it returns a clear “provider is not configured” error. If providers exist but fail, it returns the last provider error.

#### Function details

##### `SkillProviderSource::new`  (lines 23–33)

```
fn new(
        kind: SkillSourceKind,
        label: impl Into<String>,
        provider: Arc<dyn SkillProvider>,
    ) -> Self
```

**Purpose**: Creates a single named skill source from a source kind, a label, and the actual provider object. This is the basic constructor used by the more specific host, executor, and orchestrator helpers.

**Data flow**: It receives a source kind, a label that can be turned into text, and a shared provider reference. It stores those three values together in a new `SkillProviderSource`, converting the label into a `String` on the way. The result is a ready-to-use wrapper around one provider.

**Call relations**: The convenience constructors for host, executor, and orchestrator sources all rely on this function. It is the common doorway for making any `SkillProviderSource`.

*Call graph*: 1 external calls (into).


##### `SkillProviderSource::host`  (lines 35–37)

```
fn host(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Creates a skill source marked as coming from the host. The host is the surrounding environment that can provide skills directly.

**Data flow**: It receives a label and a shared provider reference. It fills in the source kind as `Host`, then passes everything to `SkillProviderSource::new`. The output is a host-labeled skill source.

**Call relations**: This is used by `SkillProviders::with_host_provider` when callers want to add a host provider without spelling out the source kind themselves.

*Call graph*: called by 1 (with_host_provider); 1 external calls (new).


##### `SkillProviderSource::executor`  (lines 39–41)

```
fn executor(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Creates a skill source marked as coming from an executor. An executor is a place that can run or expose a particular set of skills.

**Data flow**: It receives a label and a shared provider reference. It sets the source kind to `Executor`, then delegates construction to `SkillProviderSource::new`. The result is an executor-labeled source.

**Call relations**: This is used by `SkillProviders::with_executor_provider`, which gives callers a short path for registering executor skills.

*Call graph*: called by 1 (with_executor_provider); 1 external calls (new).


##### `SkillProviderSource::orchestrator`  (lines 43–45)

```
fn orchestrator(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Creates a skill source marked as coming from the orchestrator. The orchestrator is the coordinating layer that can expose its own skills.

**Data flow**: It receives a label and a shared provider reference. It sets the source kind to `Orchestrator`, then uses `SkillProviderSource::new` to build the source. The result is an orchestrator-labeled source.

**Call relations**: This is used by `SkillProviders::with_orchestrator_provider` when the system registers orchestrator-provided skills.

*Call graph*: called by 1 (with_orchestrator_provider); 1 external calls (new).


##### `SkillProviderSource::should_list`  (lines 47–54)

```
fn should_list(&self, query: &SkillListQuery) -> bool
```

**Purpose**: Decides whether this source should be included when building a skill list for the current turn. This prevents the system from asking irrelevant providers for skills.

**Data flow**: It reads the source kind stored in `self` and the listing options in the query. Host sources are included only when host skills are requested, executor sources only when executor roots are present, orchestrator sources only when orchestrator skills are requested, and custom sources are always included. It returns true or false.

**Call relations**: This decision is used during `SkillProviders::list_for_turn`, which passes it into the shared listing helper so only matching sources are asked for catalogs.


##### `SkillProviderSource::owns_kind`  (lines 56–58)

```
fn owns_kind(&self, kind: &SkillSourceKind) -> bool
```

**Purpose**: Checks whether this source matches a requested source kind. It is used to route read and search requests to the right kind of provider.

**Data flow**: It compares the source kind stored in `self` with the requested kind. The output is a yes-or-no answer.

**Call relations**: The `read` and `search` methods use this check before asking a provider to answer a request, so a request is only sent to providers of the correct kind.


##### `SkillProviderSource::fmt`  (lines 62–68)

```
fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Controls how a `SkillProviderSource` appears in debug output. It shows the kind and label while leaving out the provider object itself.

**Data flow**: It receives a debug formatter and writes a structured debug view containing the source kind and label. It does not expose or print the underlying provider. The result tells Rust whether formatting succeeded.

**Call relations**: This is called automatically when debugging or logging code asks to format a `SkillProviderSource` with debug formatting.

*Call graph*: 1 external calls (debug_struct).


##### `SkillProviders::new`  (lines 77–79)

```
fn new() -> Self
```

**Purpose**: Creates an empty collection of skill providers. Callers use it as the starting point before adding host, executor, orchestrator, or custom providers.

**Data flow**: It takes no input beyond the type itself. It returns the default `SkillProviders`, which contains no sources yet.

**Call relations**: Startup and setup code call this when building the skill system. Tests and installation paths also use it as the clean starting point for assembling providers.

*Call graph*: called by 6 (thread_extensions, install, orchestrator_catalog_snapshot_caches_failure, prompt_hidden_skill_can_still_be_invoked, root_qualified_locator_selects_only_the_matching_executor_skill, selected_executor_catalog_is_context_and_selected_entrypoint_is_turn_input); 1 external calls (default).


##### `SkillProviders::with_provider`  (lines 81–84)

```
fn with_provider(mut self, source: SkillProviderSource) -> Self
```

**Purpose**: Adds an already-built skill source to the provider collection. This is the flexible path for callers that want to supply a source with a specific kind or label.

**Data flow**: It takes the current `SkillProviders` value and one `SkillProviderSource`. It appends that source to the internal list and returns the updated collection, allowing calls to be chained.

**Call relations**: This sits alongside the more specific `with_host_provider`, `with_executor_provider`, and `with_orchestrator_provider` helpers. It is useful when the caller has already constructed the source.


##### `SkillProviders::with_host_provider`  (lines 86–90)

```
fn with_host_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Adds a host skill provider using the standard label `host`. This is a convenient shortcut for registering host-provided skills.

**Data flow**: It receives the current provider collection and a shared provider reference. It wraps that provider as a host source, appends it to the list, and returns the updated collection.

**Call relations**: It calls `SkillProviderSource::host` to make the source, then stores it. Later listing, reading, or searching can route host-related requests to this provider.

*Call graph*: calls 1 internal fn (host).


##### `SkillProviders::with_executor_provider`  (lines 92–96)

```
fn with_executor_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Adds an executor skill provider using the standard label `executor`. This is the shortcut for registering skills that come from an executor.

**Data flow**: It receives the current provider collection and a shared provider reference. It wraps the provider as an executor source, appends it, and returns the updated collection.

**Call relations**: It calls `SkillProviderSource::executor` to create the source. Later, executor-related list, read, and search work can find this provider by its source kind.

*Call graph*: calls 1 internal fn (executor).


##### `SkillProviders::with_orchestrator_provider`  (lines 98–102)

```
fn with_orchestrator_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self
```

**Purpose**: Adds an orchestrator skill provider using the standard label `orchestrator`. This lets the coordinating layer expose its own skills through the same provider system.

**Data flow**: It receives the current provider collection and a shared provider reference. It wraps that provider as an orchestrator source, appends it, and returns the updated collection.

**Call relations**: It calls `SkillProviderSource::orchestrator` to build the source. Other code can later check for this provider or ask it for orchestrator skills.

*Call graph*: calls 1 internal fn (orchestrator).


##### `SkillProviders::has_orchestrator_provider`  (lines 104–108)

```
fn has_orchestrator_provider(&self) -> bool
```

**Purpose**: Answers whether an orchestrator skill provider has been registered. This lets other parts of the system know whether orchestrator-specific tools or catalogs are available.

**Data flow**: It looks through the stored sources and checks whether any source has the `Orchestrator` kind. It returns true if it finds one, otherwise false.

**Call relations**: The tools layer calls this when deciding how to expose skill-related behavior. It is a quick capability check rather than a full listing operation.

*Call graph*: called by 1 (tools).


##### `SkillProviders::list_for_turn`  (lines 110–113)

```
async fn list_for_turn(&self, query: SkillListQuery) -> SkillCatalog
```

**Purpose**: Builds the skill catalog that should be visible for a particular turn. A turn is one cycle of interaction, so this method chooses only the skills relevant to that moment.

**Data flow**: It receives a listing query that says which kinds of skills should be considered. It asks `list_matching` to visit only sources whose `should_list` check passes. The output is a combined `SkillCatalog` containing available skills plus any warnings from unavailable providers.

**Call relations**: The skill-listing flow calls this when it needs the normal per-turn catalog. This method delegates the common collection work to `list_matching`.

*Call graph*: calls 1 internal fn (list_matching); called by 1 (list_skills).


##### `SkillProviders::list_orchestrator_for_turn`  (lines 115–136)

```
async fn list_orchestrator_for_turn(
        &self,
        query: SkillListQuery,
    ) -> SkillProviderResult<SkillCatalog>
```

**Purpose**: Builds a catalog using only orchestrator skill providers, and treats provider failure as an actual error. This is stricter than normal listing because the caller specifically asked for orchestrator skills.

**Data flow**: It starts with an empty catalog and loops over sources marked as orchestrator providers. For each one, it asks the provider to list skills using the query. Successful catalogs are merged in; a failure is turned into a labeled `SkillProviderError` and returned immediately. On success, it returns the combined catalog.

**Call relations**: Skill-listing and catalog code call this when they specifically need orchestrator skills. Unlike `list_for_turn`, it does not hide failures as warnings, because the requested source is the main point of the operation.

*Call graph*: called by 2 (list_skills, catalog); 2 external calls (default, clone).


##### `SkillProviders::list_matching`  (lines 138–154)

```
async fn list_matching(
        &self,
        query: &SkillListQuery,
        should_list: impl Fn(&SkillProviderSource) -> bool,
    ) -> SkillCatalog
```

**Purpose**: Performs the shared work of asking selected providers for their skill catalogs and merging the answers. It is the common listing engine behind per-turn listing.

**Data flow**: It receives a query and a yes-or-no selection function. It starts with an empty catalog, filters the stored sources with the selection function, and asks each selected provider for a catalog. Each provider result is passed to `extend_catalog`, which either merges the catalog or records a warning. The final combined catalog is returned.

**Call relations**: `SkillProviders::list_for_turn` calls this after supplying the rule for which sources belong in the current turn. This helper then calls `extend_catalog` so provider failures are handled consistently.

*Call graph*: calls 1 internal fn (extend_catalog); called by 1 (list_for_turn); 2 external calls (default, clone).


##### `SkillProviders::read`  (lines 156–179)

```
async fn read(
        &self,
        request: SkillReadRequest,
    ) -> Result<SkillReadResult, SkillProviderError>
```

**Purpose**: Reads details for one requested skill from the provider kind named in the request. It routes the request to matching providers and returns the first successful answer.

**Data flow**: It receives a read request that includes an authority, meaning the source kind that should own the skill. It filters providers to that kind, sends each a cloned request, and returns as soon as one succeeds. If matching providers fail, it returns the last error. If no matching provider exists, it returns a clear error saying that provider kind is not configured.

**Call relations**: The `read_skill` flow calls this when someone wants the full information for a skill. This method uses `SkillProviderSource::owns_kind` to avoid asking the wrong kind of provider.

*Call graph*: calls 1 internal fn (new); called by 1 (read_skill); 2 external calls (clone, format!).


##### `SkillProviders::search`  (lines 181–204)

```
async fn search(
        &self,
        request: SkillSearchRequest,
    ) -> Result<SkillSearchResult, SkillProviderError>
```

**Purpose**: Searches for skills within the provider kind named in the request. It routes the search to matching providers and returns the first successful search result.

**Data flow**: It receives a search request that names the authority, including the source kind. It tries providers whose kind matches, cloning the request for each attempt. A successful provider result is returned immediately. If all matching providers fail, it returns the last error; if none are configured, it returns an error explaining that the provider kind is missing.

**Call relations**: This follows the same routing pattern as `read`, but for search requests. It uses `SkillProviderSource::owns_kind` so the search is sent only to providers that could own the requested skills.

*Call graph*: calls 1 internal fn (new); 2 external calls (clone, format!).


##### `extend_catalog`  (lines 207–218)

```
fn extend_catalog(
    catalog: &mut SkillCatalog,
    result: Result<SkillCatalog, SkillProviderError>,
    label: &str,
)
```

**Purpose**: Adds one provider’s listing result into a combined catalog. If that provider failed, it records a warning instead of stopping the whole listing process.

**Data flow**: It receives the combined catalog being built, one provider result, and the provider’s label. If the result contains a catalog, it merges that catalog into the combined one. If the result contains an error, it appends a readable warning such as that the provider’s skills are unavailable. It changes the catalog in place and returns nothing.

**Call relations**: `SkillProviders::list_matching` calls this after each provider listing attempt. This function is what lets normal skill listing be tolerant: one broken source can add a warning while other sources still contribute skills.

*Call graph*: calls 1 internal fn (extend); called by 1 (list_matching); 1 external calls (format!).


### `ext/skills/src/tools/mod.rs`

`orchestration` · `startup and tool request handling`

This file makes the “skills” feature available as tools the model can call. A skill is extra capability or guidance that can be discovered and read during a conversation. Without this file, the project would not have a clean way to register those skill tools, share their context, or safely translate model tool calls into Rust data and back into JSON responses.

The main setup function creates a shared SkillToolContext. That context is like a small backpack carried by each skill tool: it contains the available skill providers, optional MCP resources (MCP is a protocol for connecting to outside resources), and per-thread skill state. The list and read tools both use this backpack when answering requests.

The file also defines which authority is allowed for these tools. Right now, only the orchestrator authority is accepted. In plain terms, the skill information must come from the project’s coordinating skill source, not from an arbitrary source.

The remaining helpers keep the tool boundary tidy. They create namespaced tool names so skill tools do not collide with other tools, build tool specifications with input and output schemas, parse JSON arguments from a tool call, reject unsafe or oversized handles, and wrap successful results as JSON marked for external context. Together, these pieces form the safe adapter between model-facing tool calls and the internal skill catalog.

#### Function details

##### `skill_tools`  (lines 36–52)

```
fn skill_tools(
    providers: SkillProviders,
    mcp_resources: Option<Arc<McpResourceClient>>,
    thread_state: Arc<SkillsThreadState>,
) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: Builds the actual skill tools that can be offered to the model. It packages shared dependencies once, then gives that shared context to the list and read tools.

**Data flow**: It receives skill providers, optional MCP resource access, and thread-specific skill state. It puts these into a SkillToolContext, clones that context where needed, and returns a list containing the list-skill tool and the read-skill tool as generic tool executors.

**Call relations**: The broader tool setup calls on this function when it needs the skill tool set. This function then hands shared context to the list and read tool implementations so they can answer later tool calls consistently.

*Call graph*: called by 1 (tools); 1 external calls (vec!).


##### `SkillToolContext::catalog`  (lines 62–81)

```
async fn catalog(&self, turn_id: &str, authority: SkillToolAuthority) -> SkillCatalog
```

**Purpose**: Fetches the skill catalog that a tool should use for a specific conversation turn and authority. Today it supports the orchestrator authority, meaning the coordinating skill source.

**Data flow**: It takes a turn ID and a SkillToolAuthority. For the orchestrator case, it asks the providers for orchestrator skills for that turn, includes MCP resource access if available, and asks the thread state to return an orchestrator catalog snapshot. The output is a SkillCatalog ready for the caller to inspect.

**Call relations**: The list and read tool request handlers call this when they need to see what skills are available. It delegates the actual gathering to the providers and thread state, so the tool handlers do not need to know how catalogs are assembled.

*Call graph*: calls 1 internal fn (list_orchestrator_for_turn); called by 2 (handle, handle); 1 external calls (new).


##### `SkillToolAuthority::from_authority`  (lines 91–98)

```
fn from_authority(authority: &SkillAuthority) -> Option<Self>
```

**Purpose**: Converts a general SkillAuthority into the narrower authority type accepted by these tools. It filters out anything that is not the supported orchestrator authority.

**Data flow**: It receives a SkillAuthority. It compares it with the expected orchestrator authority for the Codex apps MCP server. If it matches, it returns Some(Orchestrator); otherwise it returns None.

**Call relations**: The listed-skill conversion code calls this when preparing skill information for tool output. This keeps unsupported authorities from being exposed through this tool layer.

*Call graph*: calls 1 internal fn (new); called by 1 (listed_skill).


##### `SkillToolAuthority::into_authority`  (lines 100–106)

```
fn into_authority(self) -> SkillAuthority
```

**Purpose**: Turns this tool-specific authority back into the general SkillAuthority type used by the catalog. It is the reverse of narrowing the authority.

**Data flow**: It receives a SkillToolAuthority value. For Orchestrator, it creates and returns the matching general SkillAuthority for the Codex apps MCP server.

**Call relations**: When code needs to pass a tool authority back into catalog-level APIs, this helper supplies the general authority shape those APIs expect.

*Call graph*: calls 1 internal fn (new).


##### `skill_tool_name`  (lines 109–111)

```
fn skill_tool_name(name: &str) -> ToolName
```

**Purpose**: Creates a full tool name inside the skills namespace. This prevents simple names like “list” or “read” from clashing with tools from other parts of the system.

**Data flow**: It receives a short tool name as text. It combines that name with the fixed namespace "skills" and returns a ToolName representing the namespaced tool.

**Call relations**: Skill tool definitions use this naming pattern so the rest of the tool system can identify them as belonging to the skills group.

*Call graph*: calls 1 internal fn (namespaced).


##### `skill_function_tool`  (lines 113–129)

```
fn skill_function_tool(name: &str, description: &str) -> ToolSpec
```

**Purpose**: Builds the published specification for a skill function tool. A tool specification tells the model what the tool is called, what it does, what input shape it accepts, and what output shape it returns.

**Data flow**: It receives a tool name and description, plus Rust types that describe the input and output JSON schemas. It generates and parses the input schema, creates the output schema, wraps the function inside the skills namespace, and returns a ToolSpec.

**Call relations**: This helper is used when a skill tool needs to describe itself to the Responses API tool system. It hands off schema parsing to the extension API and namespace description creation to the shared tool utilities.

*Call graph*: 4 external calls (parse_tool_input_schema, default_namespace_description, Namespace, vec!).


##### `parse_args`  (lines 131–140)

```
fn parse_args(call: &ToolCall) -> Result<T, FunctionCallError>
```

**Purpose**: Turns the raw JSON argument text from a tool call into a strongly typed Rust value. It also reports argument mistakes in a way the model can see and correct.

**Data flow**: It reads the function arguments from a ToolCall. If the argument string is empty, it treats it as an empty JSON object. Otherwise it parses the string as JSON, then converts that JSON into the requested Rust type. On bad JSON or wrong fields, it returns a RespondToModel error with the parse message.

**Call relations**: Tool request handlers use this at the start of handling a call. It stands between the model’s raw text input and the internal code, so later code can work with normal typed data instead of untrusted strings.

*Call graph*: 5 external calls (Object, function_arguments, new, from_str, from_value).


##### `validate_handle`  (lines 142–150)

```
fn validate_handle(name: &str, value: &str, max_bytes: usize) -> Result<(), FunctionCallError>
```

**Purpose**: Checks that a handle-like string is safe to use. A handle here is an identifier supplied through a tool call, and this check rejects empty, too-large, or control-character-containing values.

**Data flow**: It receives the handle’s field name, the handle text, and the maximum allowed byte length. It asks is_bounded_handle whether the value is acceptable. If yes, it returns success; if not, it returns an error message for the model explaining the rule.

**Call relations**: Tool handlers use this before trusting identifiers from tool input. It delegates the yes/no check to is_bounded_handle, then turns a failed check into a model-facing error.

*Call graph*: calls 1 internal fn (is_bounded_handle); 2 external calls (format!, RespondToModel).


##### `is_bounded_handle`  (lines 152–154)

```
fn is_bounded_handle(value: &str, max_bytes: usize) -> bool
```

**Purpose**: Performs the simple yes/no test for whether a handle is non-empty, not too long, and free of control characters. Control characters are invisible or special characters that can cause confusing output or unsafe behavior.

**Data flow**: It receives a string and a byte limit. It checks three facts: the string is not empty, its byte length is within the limit, and none of its characters are control characters. It returns true only if all three checks pass.

**Call relations**: validate_handle calls this helper to keep the validation rule separate from the error-message wording.

*Call graph*: called by 1 (validate_handle).


##### `external_json_output`  (lines 156–161)

```
fn external_json_output(value: &T) -> Result<Box<dyn ToolOutput>, FunctionCallError>
```

**Purpose**: Converts a Rust result value into the standard JSON output object used by external-context tools. This gives callers a uniform tool response format.

**Data flow**: It receives any serializable value. It converts that value into serde_json’s generic JSON form, wraps it in JsonToolOutput, marks it as external context, and returns it boxed as a ToolOutput. If serialization fails, it returns a fatal tool error because the program could not produce a valid response.

**Call relations**: Skill tool handlers use this at the end of successful work to send structured JSON back through the extension API. It hands off JSON conversion to serde_json and output wrapping to JsonToolOutput.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, to_value).


### `ext/skills/src/tools/list.rs`

`domain_logic` · `request handling`

This file is the “show me what is available” part of the skills system. A skill is an add-on capability, and the catalog is the project’s list of known skills. When an outside caller invokes the list tool, this code checks which authority, meaning which trusted owner group, the caller asked about. It then reads the skill catalog for the current turn and returns the enabled skills that belong to that authority.

The response is deliberately cautious. It does not expose full internal objects. Instead, each skill is turned into a small public summary with its authority, package handle, name, description, and main resource handle. These handles are opaque labels: the caller should pass them to another tool, such as `skills.read`, rather than trying to interpret them. Like giving someone a claim ticket instead of the contents of the storage room.

The file also protects the tool output from becoming too large or awkward. It drops skills whose important handles are longer than the allowed size, and it limits catalog warnings to a few short messages. The final answer is formatted as external JSON, so the caller receives a structured response rather than free-form text.

#### Function details

##### `ListTool::tool_name`  (lines 55–57)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool, using the shared skills-tool naming convention. This is how the surrounding tool system knows this executor represents the list operation.

**Data flow**: It starts with the fixed local name `list`, passes that name through the common skill tool name builder, and returns the resulting `ToolName`. It does not read the catalog or change any state.

**Call relations**: The tool framework calls this when registering or identifying the tool. It hands the plain `list` label to `skill_tool_name`, which adds whatever shared prefix or formatting the skills tool family uses.

*Call graph*: 1 external calls (skill_tool_name).


##### `ListTool::spec`  (lines 59–64)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes the tool’s input and output shape for callers. It tells the outside system that this tool accepts a requested authority and returns a list of skills with warnings.

**Data flow**: It uses the `ListArgs` type as the expected input schema and `ListResponse` as the output schema, then combines them with a human-readable description. The result is a `ToolSpec`, which is metadata rather than an actual catalog lookup.

**Call relations**: The surrounding extension API asks for this specification when exposing the tool to callers. The specification explains how to call `skills.list` before `ListTool::handle` is ever run.


##### `ListTool::handle`  (lines 66–83)

```
fn handle(&self, call: ToolCall) -> ToolExecutorFuture<'_>
```

**Purpose**: Runs the actual list request. It reads the caller’s arguments, fetches the skill catalog for this turn, filters it down to enabled skills owned by the requested authority, and returns JSON.

**Data flow**: It receives a `ToolCall`, parses its arguments into `ListArgs`, converts the requested authority into the internal authority form, and asks the context for the catalog tied to the call’s turn ID. From the catalog entries, it keeps only enabled entries with the matching authority, converts each safe entry with `listed_skill`, shortens the warning list with `bounded_warnings`, and sends the finished `ListResponse` out as JSON.

**Call relations**: This is the function the tool framework calls when someone invokes the list tool. During the request it calls `parse_args` to understand the input, uses the context’s catalog lookup to get available skills, calls `bounded_warnings` to keep warning output small, and finishes by passing the response to `external_json_output`.

*Call graph*: calls 2 internal fn (catalog, bounded_warnings); 3 external calls (pin, external_json_output, parse_args).


##### `listed_skill`  (lines 86–101)

```
fn listed_skill(entry: SkillCatalogEntry) -> Option<ListedSkill>
```

**Purpose**: Turns one internal catalog entry into the smaller public skill record returned by the list tool. It also refuses entries whose authority cannot be represented for the tool or whose handles are too large.

**Data flow**: It receives a `SkillCatalogEntry`. First it converts the entry’s internal authority into the tool-facing authority form. Then it checks that the package handle and main resource handle fit within the maximum allowed byte size. If either check fails, it returns nothing; otherwise it returns a `ListedSkill` containing the safe public fields.

**Call relations**: This is used inside `ListTool::handle` while building the response list. It relies on `from_authority` to translate the owner information and on `is_bounded_handle` to enforce the output size rule before the skill is shown to the caller.

*Call graph*: calls 1 internal fn (from_authority); 1 external calls (is_bounded_handle).


##### `bounded_warnings`  (lines 103–112)

```
fn bounded_warnings(warnings: Vec<String>) -> Vec<String>
```

**Purpose**: Keeps catalog warnings from overwhelming the response. It returns only the first few warnings and trims each one to a safe byte length without breaking text encoding.

**Data flow**: It receives a list of warning strings. It takes at most four, truncates each to the maximum warning size using UTF-8-safe truncation, and returns the shortened list. It does not change the original catalog; it builds a new warning list for the response.

**Call relations**: This is called by `ListTool::handle` after the catalog has been loaded. Its job is to make sure the warning section of the final JSON response stays compact and safe for external callers.

*Call graph*: called by 1 (handle).


### `ext/skills/src/tools/read.rs`

`domain_logic` · `request handling`

This file is the read path for skill resources. A skill package can expose resources, such as instructions, examples, or other text-like content. The model cannot just fetch any arbitrary resource by name. It must ask through this tool, using the authority, package, and resource identifiers it was previously given.

The flow is like checking out a book from a controlled library. First, the tool reads the request arguments and makes sure the package and resource handles are not too large or malformed. Then it asks the current skill catalog what packages are enabled for this conversation turn. If the requested package is not enabled under the requested authority, the tool refuses the request with a message the model can understand.

If the package is allowed, the tool builds a `SkillReadRequest` and sends it to the skill provider through the shared thread state. A provider is the part of the system that knows how to fetch the real resource contents. If the provider fails, the tool logs a warning with useful debugging details but only returns a simple failure message to the model. Finally, it checks an important safety condition: the provider must return the same resource that was requested. If it returns something else, that is treated as a fatal internal error. Successful reads are returned as JSON containing the resource id and its contents.

#### Function details

##### `ReadTool::tool_name`  (lines 47–49)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: This tells the tool system the public name of this tool. It turns the short name `read` into the full skill tool name used when the model calls it.

**Data flow**: It starts with the fixed local tool name `read`. It passes that name into the shared skill naming helper, which applies the project’s standard naming format. It returns the finished `ToolName` value to the tool framework.

**Call relations**: The tool framework calls this when it needs to identify or register the tool. This function delegates the naming rule to `skill_tool_name`, so this file does not duplicate the convention used by other skill tools.

*Call graph*: 1 external calls (skill_tool_name).


##### `ReadTool::spec`  (lines 51–56)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: This describes the tool to the model: what arguments it accepts and what shape its answer has. The description also tells the model to use exact identifiers from `skills.list`, because resource names are opaque routing tokens rather than user-friendly paths.

**Data flow**: It uses the `ReadArgs` input shape and `ReadResponse` output shape, along with a plain-language description of the tool. From that, it produces a `ToolSpec`, which is the formal description the tool framework can expose to the model.

**Call relations**: The tool framework asks for this specification when making tools available. This function relies on the shared `skill_function_tool` helper so the read tool is described in the same structured way as the other skill tools.


##### `ReadTool::handle`  (lines 58–111)

```
fn handle(&self, call: ToolCall) -> ToolExecutorFuture<'_>
```

**Purpose**: This is the main work of the file: it answers one `skills.read` call. It validates the request, confirms the package is enabled, asks the right provider for the resource, checks that the provider returned the exact requested resource, and formats the result for the model.

**Data flow**: It receives a `ToolCall`, which contains the model’s arguments plus identifiers for the current turn and call. It parses those arguments into `ReadArgs`, converts the requested authority into the internal form, and checks that the package and resource handles fit the allowed size. It reads the current catalog for this turn and refuses the call if the package is not enabled for that authority. If allowed, it creates a resource id and sends a `SkillReadRequest` through the shared thread state to the configured providers. A successful provider response is checked against the original resource id, then converted into JSON with the resource name and contents. Failures become either a model-facing error message or, if the provider returned the wrong resource, a fatal internal error.

**Call relations**: The tool framework calls this whenever the model invokes the read tool. Inside the async task, it hands argument parsing to `parse_args`, handle checks to `validate_handle`, catalog lookup to the tool context, resource id creation to `SkillResourceId::new`, provider access to `thread_state.read_skill`, and final formatting to `external_json_output`. If something goes wrong in a way the model can act on, it returns a `RespondToModel` error; if the provider violates the contract by returning a different resource, it uses a fatal error path.

*Call graph*: calls 2 internal fn (new, catalog); 7 external calls (pin, new, external_json_output, parse_args, validate_handle, Fatal, RespondToModel).


### `ext/skills/src/extension.rs`

`orchestration` · `startup, thread start, config changes, and per-turn input preparation`

A “skill” here is a packaged instruction or capability that can be made available to the assistant. This file is the adapter between the general extension framework and the skills subsystem. Without it, the rest of the application might know how to store and read skills, but those skills would not appear at the right time in a conversation.

The file defines `SkillsExtension`, which keeps three important things: the available skill providers, a way to send warning events back to the host, and a function for extracting skills settings from the host application’s configuration. When a thread starts, it creates per-thread skills state, including which filesystem or capability roots are selected and whether orchestrator skills are allowed. When configuration changes, it updates that state.

During a turn, it builds a catalog of available skills, notices explicit skill mentions in the user’s message, reads the selected skills’ main prompt text, trims that text if it is too large, and inserts the resulting instruction fragments into the model input. It also saves turn-level state so later parts of the system know which skills were available, selected, warned about, or injected.

The file also registers optional skill tools, especially for orchestrator-provided skills, and emits warning events when something cannot be loaded or must be truncated. The `install` functions are the doorway that attaches this extension to the registry.

#### Function details

##### `SkillsExtension::on_thread_start`  (lines 57–74)

```
fn on_thread_start(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This function prepares skills state when a new conversation thread begins. It records the current skills configuration, selected capability roots, and whether orchestrator skills should be enabled for this thread.

**Data flow**: It receives thread-start information, including the host config, thread storage, selected roots if already present, and active environments. It turns the host config into `SkillsExtensionConfig`, checks whether the local environment is present, then stores a new `SkillsThreadState` in the thread store. After this, later skill steps can read a consistent per-thread state.

**Call relations**: The extension framework calls this at thread startup because `install_with_providers` registers the extension as a thread lifecycle contributor. It creates the state that later methods, such as turn input contribution and tool contribution, expect to find.

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

**Purpose**: This function updates the skills settings when the host application’s configuration changes. It keeps the already-running thread in sync with new options such as whether bundled skills are enabled or instructions should be included.

**Data flow**: It receives the old and new host config plus shared stores. It extracts the next skills config from the new host config. If skills thread state already exists, it updates that state; if not, it creates and inserts a fresh `SkillsThreadState` with default selected roots and orchestrator skills enabled.

**Call relations**: The extension framework calls this after `install_with_providers` registers the extension as a config contributor. It supports the rest of the skills flow by ensuring later catalog building uses current settings rather than stale startup settings.

*Call graph*: calls 2 internal fn (insert, new); 1 external calls (new).


##### `SkillsExtension::tools`  (lines 148–167)

```
fn tools(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>>
```

**Purpose**: This function decides whether skill-related tools should be offered for the current thread. These tools let the model interact with orchestrator skills when that kind of provider is available and allowed.

**Data flow**: It reads `SkillsThreadState` from the thread store and checks the configured providers. If there is no thread state, no orchestrator provider, or orchestrator skills are disabled, it returns an empty tool list. Otherwise it builds skill tool executors using the providers, optional MCP resource client, and thread state, then returns them to the extension framework.

**Call relations**: The extension framework calls this because the extension was registered as a tool contributor. It hands off to `skill_tools` to create the actual tool executors, while this function acts as the gatekeeper that decides whether those tools should exist for this thread.

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

**Purpose**: This function prepares skill-related context for one user turn. It finds available skills, detects which ones the user explicitly asked for, loads their instruction text, warns about problems, and returns fragments that should be added to the model input.

**Data flow**: It starts with the turn input, session store, thread store, and turn store. It reads thread settings and any host-loaded skills, builds a skill-list query, and asks `list_skills` for a catalog. It sends warning events for catalog warnings, scans the user message for explicit skill mentions, optionally adds an available-skills fragment, then reads each selected skill’s main prompt through `read_main_prompt`. Loaded prompt text is shortened if needed, wrapped as `SkillInstructions`, and returned as contextual fragments. It also writes `SkillsTurnState` into the turn store, including the catalog, selected entries, warnings, and whether main prompts were injected.

**Call relations**: The extension framework calls this during turn input preparation because `install_with_providers` registers the extension as a turn input contributor. Inside the turn flow, it calls `list_skills` to gather candidates, `read_main_prompt` to fetch selected skill instructions, and `emit_warning` whenever the user or host should be told about a loading or truncation issue.

*Call graph*: calls 9 internal fn (insert, level_id, emit_warning, list_skills, read_main_prompt, available_skills_fragment, truncate_main_prompt_contents, truncate_utf8_to_bytes, collect_explicit_skill_mentions); 5 external calls (new, pin, new, default, format!).


##### `SkillsExtension::list_skills`  (lines 295–317)

```
async fn list_skills(
        &self,
        mut query: SkillListQuery,
        thread_state: &SkillsThreadState,
    ) -> SkillCatalog
```

**Purpose**: This helper builds the skill catalog for a turn. It combines the normal providers with orchestrator skills when those are enabled, while using a cached snapshot path for orchestrator results.

**Data flow**: It receives a `SkillListQuery` and thread state. It first saves whether orchestrator skills were requested, then runs the regular provider listing with orchestrator skills turned off. If orchestrator skills should be included, it asks the thread state for an orchestrator catalog snapshot, using the orchestrator provider listing as the source, and merges that into the main catalog. It returns the finished `SkillCatalog`.

**Call relations**: The turn contribution flow calls this before deciding what to show or inject. It delegates ordinary listing to `list_for_turn`, orchestrator listing to `list_orchestrator_for_turn`, and snapshot coordination to `orchestrator_catalog_snapshot` so repeated turn work can stay consistent.

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

**Purpose**: This helper loads the main instruction text for one selected skill. That text is what gets injected into the model when the user asks for the skill.

**Data flow**: It receives a catalog entry, optional host-loaded skill data, session storage, and thread state. It builds a `SkillReadRequest` from the entry’s source, package id, main prompt resource, host data, and optional MCP resource client. It asks the thread state to read the skill through the configured providers, then returns either the read result or a plain error message.

**Call relations**: The per-turn `contribute` function calls this for each selected skill. This keeps the main flow focused on preparing fragments while this helper handles the exact read request needed to fetch skill content.

*Call graph*: calls 1 internal fn (read_skill); called by 1 (contribute).


##### `SkillsExtension::emit_warning`  (lines 341–346)

```
fn emit_warning(&self, turn_id: &str, message: String)
```

**Purpose**: This function sends a warning event back to the host application. It is used when skill discovery or loading succeeds only partially, for example when a prompt is too large and must be cut down.

**Data flow**: It receives a turn id and warning message. It wraps the message in a protocol warning event, attaches the turn id as the event id, and sends it through the extension event sink. The output is not a returned value; the visible effect is that the host can receive and display or record the warning.

**Call relations**: The turn contribution flow calls this whenever catalog warnings, skill-load failures, or truncation notices occur. It is the small bridge between internal skills problems and user-visible host events.

*Call graph*: called by 1 (contribute); 1 external calls (Warning).


##### `install`  (lines 349–360)

```
fn install(
    registry: &mut ExtensionRegistryBuilder<C>,
    config_from_host: impl Fn(&C) -> SkillsExtensionConfig + Send + Sync + 'static,
)
```

**Purpose**: This is the standard setup function for adding the skills extension to an extension registry. It uses the default skill providers, including the host skill provider.

**Data flow**: It receives the registry to modify and a function that can extract skills config from the host config. It creates the default `SkillProviders`, adds a host provider, and passes everything to `install_with_providers`. It does not return a value; it changes the registry by registering the extension.

**Call relations**: Application startup code can call this when it wants the normal skills setup. It delegates the actual registration work to `install_with_providers`, which is also useful for custom provider setups.

*Call graph*: calls 3 internal fn (install_with_providers, new, new); 1 external calls (new).


##### `install_with_providers`  (lines 362–379)

```
fn install_with_providers(
    registry: &mut ExtensionRegistryBuilder<C>,
    providers: SkillProviders,
    config_from_host: impl Fn(&C) -> SkillsExtensionConfig + Send + Sync + 'static,
)
```

**Purpose**: This function registers a `SkillsExtension` with the extension system using a caller-supplied set of skill providers. It is the central wiring point that makes all the other methods active.

**Data flow**: It receives the registry, skill providers, and config-extraction function. It creates one shared `SkillsExtension`, captures the registry’s event sink, and registers that same extension as a thread lifecycle contributor, config contributor, prompt contributor, turn input contributor, and tool contributor. After this, the framework knows to call the extension at the right moments.

**Call relations**: `install` calls this with the default providers, while tests or specialized setups can call it directly with custom providers. By registering each contributor role, it connects startup state creation, config updates, prompt context, turn input injection, and tool exposure into one coordinated skills feature.

*Call graph*: calls 6 internal fn (config_contributor, event_sink, prompt_contributor, thread_lifecycle_contributor, tool_contributor, turn_input_contributor); called by 1 (install); 1 external calls (new).
