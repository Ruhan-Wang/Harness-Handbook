# Extension and hook interface contracts  `stage-18.4.3`

This stage is the public contract layer for extensions and hooks. It is mostly shared support behind the scenes: the rest of the system uses it to tell outside code, “here is what you may do, what data you will receive, and what shape your replies must have.” The goal is stability, so plugin authors can build against these rules without depending on internal details.

The extension API files are the main front door. `lib.rs` and `capabilities/mod.rs` gather the pieces into one public surface. The capability files define small powers the host may give an extension: start a sub-agent, send events outward, or inject extra response items into the current reply, with safe fallback versions when a host does not support them. `contributors.rs` defines the callback interfaces for extensions, while the contributor data files describe the exact event payloads for thread, turn, tool, and MCP configuration changes. `state.rs` gives extensions typed storage slots for saved values, and `user_instructions.rs` defines how startup instructions are loaded.

The hook files do the same job for hooks: declare handlers, name events, define payload and result types, and publish JSON schema documents so other processes can validate messages. A few neighboring files add stable contracts for goal events, memory backends, and TUI IDE context data.

## Files in this stage

### Extension API facade
These files define the top-level public surface of the extension API crate and its shared capability exports.

### `ext/extension-api/src/capabilities/agent.rs`

`util` · `extension setup and capability invocation`

This file is a small capability adapter around subagent creation. `AgentSpawnFuture<'a, T, E>` standardizes the async return type as a boxed, pinned, sendable future yielding `Result<T, E>`. The `AgentSpawner<R>` trait then describes the host-provided capability: given a `ThreadId` identifying the thread being forked from and an extension-defined request payload `R`, produce an async result containing either a spawned handle or an error.

The key implementation detail is the blanket `impl<R, S, E, F> AgentSpawner<R> for F` for any closure or function object `F` with signature `Fn(ThreadId, R) -> AgentSpawnFuture<'static, S, E> + Send + Sync`. That means hosts can satisfy the capability simply by passing a closure, rather than defining a dedicated struct type. The implementation forwards the trait call directly to the closure and relies on covariance of the boxed future type to return it as `AgentSpawnFuture<'a, S, E>`. This file contains no spawning logic itself; it is purely the type-level contract and ergonomic adapter that extension constructors can depend on.

#### Function details

##### `F::spawn_subagent`  (lines 31–37)

```
fn spawn_subagent(
        &'a self,
        forked_from_thread_id: ThreadId,
        request: R,
    ) -> AgentSpawnFuture<'a, Self::Spawned, Self::Error>
```

**Purpose**: Implements `AgentSpawner` for any compatible closure by forwarding the spawn request directly to that closure. It turns plain functions or closures into trait objects or generic capability providers.

**Data flow**: It takes `&self` as the closure, a `forked_from_thread_id: ThreadId`, and a request `R`, invokes `self(forked_from_thread_id, request)`, and returns the resulting boxed future yielding `Result<Self::Spawned, Self::Error>`.

**Call relations**: This method is called wherever code is generic over `AgentSpawner<R>`. Its only role in the call flow is adaptation: it delegates all real work to the injected closure supplied by the host.


### `ext/extension-api/src/capabilities/events.rs`

`util` · `cross-cutting`

This file contains a single capability trait and its inert fallback implementation. `ExtensionEventSink` is the contract extensions use when they want to emit protocol `Event` values back to the host in a fire-and-forget manner. The trait deliberately says nothing about persistence, ordering, fanout, retries, or transport; those concerns remain host-owned. Extensions are expected to construct protocol events with the correct correlation identifiers for the callback they are handling and then hand them off through `emit`.

`NoopExtensionEventSink` is a tiny default implementation for hosts that choose not to support extension event emission. It derives `Debug`, `Default`, `Clone`, and `Copy`, making it easy to embed in capability bundles without allocation or state management. Its `emit` method intentionally discards the provided `Event` immediately. That design lets extension code depend on an event sink uniformly, while hosts can opt out by wiring in this no-op sink instead of adding conditional logic throughout the extension stack.

#### Function details

##### `NoopExtensionEventSink::emit`  (lines 18–18)

```
fn emit(&self, _event: Event)
```

**Purpose**: Implements an inert event sink that silently drops every emitted event. It provides a capability-compatible placeholder when the host does not support extension event delivery.

**Data flow**: It takes `&self` and an `Event`, ignores the event value entirely, performs no side effects, and returns `()`.

**Call relations**: Used wherever code is parameterized over `ExtensionEventSink` but the host has chosen not to wire a real sink. It terminates the event flow instead of delegating further.


### `ext/extension-api/src/capabilities/response_items.rs`

`domain_logic` · `request handling`

This file is a small capability boundary between extensions and the host runtime. Its central type alias, `ResponseItemInjectionFuture<'a>`, standardizes the async contract for same-turn input steering: implementations resolve to `Ok(())` when the host accepted and injected the supplied `Vec<ResponseInputItem>`, or `Err(Vec<ResponseInputItem>)` when injection is unavailable and ownership of the untouched items is returned to the caller. That error shape is deliberate: it avoids dropping or partially consuming model-visible input when the host cannot honor same-turn injection.

The `ResponseItemInjector` trait is the host-provided capability object extensions depend on when they want to add `ResponseInputItem` values to the active model turn. The trait is `Send + Sync`, so hosts can share one injector across async tasks safely. The file’s concrete implementation, `NoopResponseItemInjector`, is the compatibility/default path for hosts that do not support this steering feature. Rather than silently succeeding or discarding data, it immediately returns a ready future containing `Err(items)`. That preserves a strong invariant: unsupported injection never mutates runtime state and never loses caller-supplied items. The implementation is intentionally allocation-light beyond boxing the future and has no internal state, which is why the struct derives `Debug`, `Default`, `Clone`, and `Copy`.

#### Function details

##### `NoopResponseItemInjector::inject_response_items`  (lines 27–32)

```
fn inject_response_items(
        &'a self,
        items: Vec<ResponseInputItem>,
    ) -> ResponseItemInjectionFuture<'a>
```

**Purpose**: Implements the unsupported-injection path by rejecting same-turn response-item injection and returning the original `ResponseInputItem` vector unchanged. It gives callers a uniform async interface even though the result is immediately known.

**Data flow**: It takes `&self` and ownership of `items: Vec<ResponseInputItem>`. It performs no inspection or mutation of the vector, wraps `std::future::ready(Err(items))` in `Box::pin`, and returns a `ResponseItemInjectionFuture<'a>` whose output is the unchanged items in the `Err` branch. It reads no external state and writes no host state.

**Call relations**: This method is invoked wherever a host installs `NoopResponseItemInjector` as its `ResponseItemInjector` implementation, specifically when extensions attempt same-turn steering on a host that does not expose that capability. It delegates only to `ready` and `pin` to satisfy the trait’s boxed-future signature while preserving the original payload for the caller.

*Call graph*: 2 external calls (pin, ready).


### `ext/extension-api/src/capabilities/mod.rs`

`orchestration` · `API import and type wiring`

This module is a façade over the extension capability subsystem. It declares three internal submodules—`agent`, `events`, and `response_items`—and then selectively re-exports the host/extension interaction types they define. Consumers of the extension API can therefore import capability contracts from `capabilities` without needing to know the internal file layout.

The re-export set reveals the capability categories this API exposes. From `agent`, it surfaces `AgentSpawner` and its associated `AgentSpawnFuture`, indicating an asynchronous hook for launching or provisioning agents. From `events`, it exposes `ExtensionEventSink` plus `NoopExtensionEventSink`, suggesting a pluggable event-reporting channel with a built-in inert implementation for callers that do not care about events. From `response_items`, it exports `ResponseItemInjector`, `ResponseItemInjectionFuture`, and `NoopResponseItemInjector`, which together define an asynchronous mechanism for injecting response items and a no-op fallback implementation.

There is no logic in this file; its significance is API shaping. By centralizing these `pub use` statements, the crate can preserve a stable public namespace even if the underlying modules evolve. This is a common design choice for library ergonomics and semver resilience: downstream code depends on the façade, not the internal module paths.


### `ext/extension-api/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the crate root for the extension API and is intentionally almost entirely declarative: it defines the module structure (`capabilities`, `contributors`, `registry`, `state`, and `user_instructions`) and then re-exports the pieces that extension authors are expected to use. The result is a single import surface for extension integration points. The exported items cover several distinct concerns: capability hooks such as agent spawning and response-item injection; contributor traits for prompt fragments, tool lifecycle, turn lifecycle, thread lifecycle, MCP server contributions, approval review, token usage, and configuration; registry construction via `ExtensionRegistry`, `ExtensionRegistryBuilder`, and `empty_extension_registry`; extension-scoped state via `ExtensionData` and `ExtensionDataInit`; and host-provided instruction loading via `UserInstructionsProvider` and related types. It also forwards core protocol and tooling types from sibling crates, including `ResponseItem`, conversation history, tool execution abstractions, tool schemas, and turn-item emission interfaces. A notable design choice is that this root file contains no behavior of its own: it centralizes API curation and shields downstream users from the internal module layout, making the crate act as a compatibility boundary for extension authors.


### Contributor contracts
These files describe the contributor interfaces and the lifecycle payloads extensions receive while participating in runtime behavior.

### `ext/extension-api/src/contributors/mcp.rs`

`data_model` · `config load`

This file packages the data model for MCP server contribution resolution. `McpServerContributionContext<'a, C>` is a lightweight borrowed view over host configuration and, optionally, the frozen `ExtensionDataInit` used to seed a running thread. The context intentionally stores references rather than owned values so contributors can inspect host state during resolution without retaining mutable runtime objects. Its `Clone` and `Copy` implementations make it cheap to pass through layered resolution code.

Two constructors encode the important scope distinction. `global` creates a context with only `config` and no thread inputs, while `for_thread` includes both `config` and `thread_init`. Accessors expose those fields explicitly, reinforcing that thread-scoped resolution may inspect host-seeded initial attachments but global resolution must not imply any local fallback.

The `McpServerContribution` enum is the actual overlay language contributors return. `Set` adds or replaces a named server with a boxed `McpServerConfig`. `SelectedPlugin` records a plugin-provided server chosen for a thread and carries provenance fields (`plugin_id`, `plugin_display_name`, `selection_order`) in addition to the server config. `Remove` deletes a named server. The enum’s shape mirrors the documented merge semantics from the trait definitions in `contributors.rs`: contributions are ordered, later entries can replace earlier ones by name, and plugin-selected servers must preserve package provenance.

#### Function details

##### `McpServerContributionContext::clone`  (lines 18–20)

```
fn clone(&self) -> Self
```

**Purpose**: Clones the borrowed MCP contribution context by copying its internal references. Because the struct is effectively a pair of references, cloning is a trivial by-value copy.

**Data flow**: It takes `&self` and returns `Self` by dereferencing `*self`. No allocation occurs, no referenced data is duplicated, and no state is mutated.

**Call relations**: This method supports callers that need to pass the same borrowed resolution context through multiple contribution paths. It does not delegate to other project code and exists mainly to make the context ergonomic in orchestration code.


##### `McpServerContributionContext::global`  (lines 27–32)

```
fn global(config: &'a C) -> Self
```

**Purpose**: Constructs an MCP resolution context for non-thread-scoped resolution. It explicitly records that no thread initialization data is available.

**Data flow**: It takes `config: &'a C`, stores that reference in the returned `McpServerContributionContext`, and sets `thread_init` to `None`. It writes no external state.

**Call relations**: It is used by runtime configuration assembly paths when resolving MCP overlays outside a running thread. Those callers use it to ensure contributors see host config but cannot inspect thread-seeded inputs.

*Call graph*: called by 1 (runtime_config_with_context).


##### `McpServerContributionContext::for_thread`  (lines 35–40)

```
fn for_thread(config: &'a C, thread_init: &'a ExtensionDataInit) -> Self
```

**Purpose**: Constructs an MCP resolution context for one active thread runtime. It exposes both host config and the frozen thread initialization attachments.

**Data flow**: It accepts `config: &'a C` and `thread_init: &'a ExtensionDataInit`, then returns a context containing the config reference and `Some(thread_init)`. It performs no mutation or copying of the underlying data.

**Call relations**: Thread-aware runtime configuration code and selected-plugin contribution flows call this constructor when contributors are allowed to inspect thread-scoped initial inputs. It packages those references for later access through the context accessors.

*Call graph*: called by 2 (runtime_config_with_context, selected_plugin_contributions).


##### `McpServerContributionContext::config`  (lines 43–45)

```
fn config(&self) -> &'a C
```

**Purpose**: Returns the host configuration reference visible during MCP resolution. It is the primary accessor contributors use to inspect effective config.

**Data flow**: It takes `&self` and returns the stored `&'a C` reference directly. No transformation, allocation, or mutation occurs.

**Call relations**: Contributor implementations call this accessor while deciding which MCP server overlays to emit. It serves as the read-only bridge from orchestration code into extension logic.

*Call graph*: called by 2 (contribute, contribute).


##### `McpServerContributionContext::thread_init`  (lines 48–50)

```
fn thread_init(&self) -> Option<&'a ExtensionDataInit>
```

**Purpose**: Returns the optional frozen thread initialization attachments for thread-scoped MCP resolution. It lets contributors inspect host-seeded inputs only when such inputs are actually in scope.

**Data flow**: It takes `&self` and returns the stored `Option<&'a ExtensionDataInit>` unchanged. It does not clone or mutate the initializer.

**Call relations**: Thread-scoped contributor implementations call this accessor when they need to derive server overlays from initial thread attachments. In global resolution flows it yields `None`, enforcing the scope distinction established by the constructors.

*Call graph*: called by 1 (contribute).


### `ext/extension-api/src/contributors/thread_lifecycle.rs`

`data_model` · `thread startup, resume, idle, and shutdown callbacks`

This file models the host-to-extension data contract for thread lifecycle events. It contains four input structs—`ThreadStartInput`, `ThreadResumeInput`, `ThreadIdleInput`, and `ThreadStopInput`—each borrowing host-owned state for the duration of a callback rather than cloning or owning it. The shared pattern across all structs is exposure of scoped `ExtensionData` stores: a session-wide store and a thread-local store, allowing contributors to read or mutate extension state at the appropriate lifetime boundary.

`ThreadStartInput` is the richest payload because thread startup is where the host establishes context. In addition to the stores, it includes a generic borrowed configuration object `&C`, the `SessionSource` that created the session, a boolean indicating whether persistent thread-scoped state is available, and the selected execution environments as a borrowed slice of `TurnEnvironmentSelection`. The generic parameter lets the host expose its own configuration type without coupling the extension API to a concrete config schema.

The remaining structs intentionally narrow the visible data to what is meaningful at each phase: resume, idle, and stop only carry the session and thread stores. This design keeps lifecycle callbacks explicit and phase-specific, preventing contributors from assuming startup-only facts are always available. The file is purely declarative but important because it fixes the shape and borrowing semantics of thread lifecycle integration points.


### `ext/extension-api/src/contributors/tool_lifecycle.rs`

`data_model` · `tool call dispatch and completion callbacks`

This file specifies the extension-facing model for tool lifecycle notifications. It starts with `ToolLifecycleFuture<'a>`, a boxed, pinned, `Send` future returning `()`, which standardizes the async shape expected from tool lifecycle callbacks without exposing a concrete future type. The rest of the file defines the data those callbacks receive.

`ToolCallSource` distinguishes whether a tool invocation came directly from the model or indirectly from code mode. The `CodeMode` variant carries both a `cell_id` and a `runtime_tool_call_id`, preserving the nested execution context needed for attribution or telemetry. `ToolCallOutcome` captures the host’s terminal observation of a tool call with four explicit cases: normal completion with a `success` flag from the tool output, policy blocking before handler execution, failure with a `handler_executed` marker to distinguish dispatch failures from handler failures, and abortion where cancellation may occur before a start callback ever happened.

The two input structs mirror the start/finish phases. `ToolStartInput` includes borrowed references to session-, thread-, and turn-scoped `ExtensionData`, plus `turn_id`, `call_id`, `tool_name`, and the `ToolCallSource`. `ToolFinishInput` repeats the same identifying context and adds `outcome`. Repeating the full context in both structs avoids forcing contributors to correlate finish events with retained start-state just to know what completed. The design is careful about lifecycle edge cases, especially cancellation races and nested code-mode provenance.


### `ext/extension-api/src/contributors/turn_input.rs`

`data_model` · `turn input preparation`

This file contains two simple but important data structures that describe the user submission and execution environments visible at the beginning of turn input processing. `TurnInputEnvironment` summarizes one resolved environment with three concrete fields: a stable host `environment_id` used for routing executor-scoped capabilities, the effective working directory `cwd` as a `PathBuf`, and an `is_primary` flag identifying the main environment for the turn. The struct derives `Debug` and `Clone`, making it easy for contributors to inspect or retain copies.

`TurnInputContext` packages the full pre-recording snapshot for a turn. It includes the stable `turn_id`, the submitted `user_input` as a `Vec<UserInput>`, and the resolved `environments` as a `Vec<TurnInputEnvironment>` in host priority order. The ordering guarantee matters because contributors can infer fallback or precedence behavior from the sequence rather than only from the `is_primary` marker.

The file is intentionally declarative and host-centric: these are facts supplied by the host before model input items are persisted or transformed. By separating this context into dedicated structs, the API gives contributors a stable schema for inspecting turn setup without exposing broader runtime internals. There is no behavior here, but the field choices encode important semantics around environment routing, working-directory resolution, and the exact user input payload entering a turn.


### `ext/extension-api/src/contributors/turn_lifecycle.rs`

`data_model` · `turn start, completion, abort, and error callbacks`

This file models the host-to-extension contract around turn execution lifecycle. It provides four borrowed input structs, each tailored to a specific phase so contributors receive only the context that is meaningful at that moment. Across all of them, the host exposes three scoped `ExtensionData` stores—session, thread, and turn—making extension state available at the same granularity as the runtime itself.

`TurnStartInput` is the most detailed because it captures the initial turn facts: the stable `turn_id`, the effective `CollaborationMode`, and a snapshot of cumulative `TokenUsage` at the moment the turn began. That token snapshot lets contributors compute deltas later without needing hidden host state. `TurnStopInput` is intentionally minimal, carrying only the scoped stores because a normal completion needs no extra metadata. `TurnAbortInput` adds a `TurnAbortReason`, allowing contributors to distinguish user cancellation, host interruption, or other abort paths. `TurnErrorInput` carries both the `turn_id` and a concrete `CodexErrorInfo`, representing an error surfaced by the host for that turn.

The design separates abort and error rather than collapsing them into one terminal event, which preserves an important semantic distinction: a turn can end abnormally because it was intentionally aborted or because the host observed an error condition. The file itself contains no executable logic, but it fixes the lifecycle event schema that extension implementations rely on.


### `ext/extension-api/src/contributors.rs`

`domain_logic` · `cross-cutting`

This file is the core API surface for extension integration. It introduces the shared async return type `ExtensionFuture<'a, T>` and then groups the extension system into narrowly scoped traits. Some traits are pure contribution points that must be implemented fully, such as `McpServerContributor`, `ContextContributor`, `TurnInputContributor`, `ToolContributor`, `ApprovalReviewContributor`, and `TurnItemContributor`. Others represent host-owned lifecycle gates—thread, turn, token usage, config, and tool execution—where the file provides default implementations so extensions can opt into only the callbacks they need.

The generic parameter `C` on several traits carries host-defined configuration snapshots without exposing core runtime internals. The callback inputs are intentionally typed wrappers re-exported from submodules, such as `ThreadStartInput`, `TurnStopInput`, or `ToolFinishInput`, so extensions receive stable, limited views of runtime state. The default async methods all follow the same pattern: capture arguments into an `async move` block or a ready future, then do nothing. That preserves trait object usability while making hooks optional.

A notable design choice is the separation between ownership and observation. For example, `ToolContributor` owns native tool implementations, while `ToolLifecycleContributor` observes accepted/completed tool calls without rewriting payloads. Similarly, `TurnInputContributor` adds model-visible fragments for one turn, while `TurnItemContributor` mutates parsed `TurnItem` values after parsing but before emission. The comments encode ordering and authority invariants: contributors run in registration order, MCP overlays replace earlier entries by name, approval review can claim prompts, and extensions should keep expensive dependencies on host-installed extension values rather than callback inputs.

#### Function details

##### `ThreadLifecycleContributor::on_thread_start`  (lines 80–85)

```
fn on_thread_start(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook for thread startup after the host has initialized thread-scoped extension storage. It exists so implementers can override startup seeding behavior only when needed.

**Data flow**: It receives `&self` and `ThreadStartInput<'a, C>`, binds both into an `async move` block to satisfy lifetimes, and returns a boxed future resolving to `()`. The default body ignores the values and performs no reads or writes to extension stores or host state.

**Call relations**: The host invokes this callback during thread startup for each registered `ThreadLifecycleContributor`. When an extension does not override it, control stops here and no further work is delegated beyond boxing the async block with `pin`.

*Call graph*: 1 external calls (pin).


##### `ThreadLifecycleContributor::on_thread_resume`  (lines 88–93)

```
fn on_thread_resume(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook for reconstructing extension-private thread state after the host resumes a runtime from persisted history. It lets extensions opt into rehydration logic without forcing every implementation to define it.

**Data flow**: It takes `&self` and `ThreadResumeInput<'a>`, captures them in an `async move` block, and returns `ExtensionFuture<'a, ()>`. The default implementation does not inspect the input, mutate stores, or emit side effects.

**Call relations**: This method is called by host resume flows for each registered thread lifecycle contributor. In the default path it delegates only to future boxing via `pin`, acting as a harmless placeholder in the lifecycle sequence.

*Call graph*: 1 external calls (pin).


##### `ThreadLifecycleContributor::on_thread_idle`  (lines 100–105)

```
fn on_thread_idle(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook that runs after the host drains immediately pending thread work. Extensions can override it to enqueue follow-up input or perform idle-time bookkeeping.

**Data flow**: It accepts `&self` and `ThreadIdleInput<'a>`, captures them into an async block, and returns a boxed future resolving to unit. The default implementation neither reads from the input nor writes any state.

**Call relations**: The host invokes this after a thread becomes idle and pending work has been drained. If not overridden, it simply completes immediately after `pin`, leaving all scheduling decisions to the host.

*Call graph*: 1 external calls (pin).


##### `ThreadLifecycleContributor::on_thread_stop`  (lines 108–113)

```
fn on_thread_stop(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook that runs before the host drops the thread runtime and thread-scoped store. It is the extension’s optional place to flush or clear thread-private state.

**Data flow**: It takes `&self` and `ThreadStopInput<'a>`, moves them into a boxed async block, and returns `ExtensionFuture<'a, ()>`. No state is read or modified in the default implementation.

**Call relations**: The host calls this during thread teardown for each registered contributor. In the default case it performs no cleanup logic and delegates only to `pin` to produce the required future.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_start`  (lines 124–129)

```
fn on_turn_start(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook for the moment after turn-scoped extension stores are created but before the turn task begins running. Extensions override it to seed or observe turn-local state.

**Data flow**: It receives `&self` and `TurnStartInput<'a>`, captures them in an async block, and returns a boxed future resolving to `()`. The default body ignores all inputs and leaves stores untouched.

**Call relations**: The host invokes this at turn startup for each registered turn lifecycle contributor. Without an override, the callback contributes nothing beyond satisfying the async trait-object contract through `pin`.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_stop`  (lines 132–137)

```
fn on_turn_stop(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook for completed-turn teardown before the host drops the turn runtime and turn store. It is intended for optional cleanup or final observation.

**Data flow**: It takes `&self` and `TurnStopInput<'a>`, wraps them in an `async move` block, and returns `ExtensionFuture<'a, ()>`. The default implementation performs no reads, writes, or side effects.

**Call relations**: This callback is part of the host’s normal turn completion flow. If an extension does not override it, the host still awaits the returned future, which immediately resolves after being boxed with `pin`.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_abort`  (lines 140–145)

```
fn on_turn_abort(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook for aborted turns. Extensions can override it to clear turn-local state or record abort-specific telemetry.

**Data flow**: It accepts `&self` and `TurnAbortInput<'a>`, captures them into a boxed async block, and returns unit on completion. The default body does not inspect the abort input or mutate any state.

**Call relations**: The host invokes this only when a running turn is aborted. In the default implementation there is no downstream delegation besides `pin`, so the abort lifecycle continues without extension-specific work.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_error`  (lines 148–153)

```
fn on_turn_error(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: Provides the default no-op hook for errors observed on a running turn. It gives extensions an optional observation point for failure handling.

**Data flow**: It takes `&self` and `TurnErrorInput<'a>`, captures them in an async block, and returns a boxed future resolving to `()`. The default implementation ignores the error input and writes nothing.

**Call relations**: The host calls this when it observes a turn error and iterates registered turn lifecycle contributors. If not overridden, the callback simply resolves immediately after `pin`.

*Call graph*: 1 external calls (pin).


##### `ConfigContributor::on_config_changed`  (lines 179–186)

```
fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        _thread_store: &ExtensionData,
        _previous_config: &C,
        _new_config: &C,
    )
```

**Purpose**: Provides the default synchronous no-op hook for committed thread-configuration changes. Extensions override it when they need to compare previous and new effective config snapshots and update extension-private state.

**Data flow**: It receives references to the session store, thread store, previous config, and new config. The default implementation ignores all four arguments, returns `()`, and performs no state changes.

**Call relations**: The host invokes this after committing a changed thread configuration for each registered config contributor. Because the default body is empty, there is no delegated work unless an implementation overrides it.


##### `TokenUsageContributor::on_token_usage`  (lines 196–207)

```
fn on_token_usage(
        &'a self,
        _session_store: &'a ExtensionData,
        _thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
        _token_usage: &'a TokenUsageIn
```

**Purpose**: Provides the default no-op async hook for token-usage checkpoints reported by the model provider. It exists so extensions can observe token accounting without requiring every contributor to implement the callback.

**Data flow**: It takes `&self`, references to session/thread/turn `ExtensionData`, and a `&TokenUsageInfo`. The default implementation groups those references into a tuple inside an `async move` block solely to mark them as used, then returns a boxed future resolving to `()`. It does not mutate stores or emit notifications.

**Call relations**: The host calls this after updating cached token usage and before sending client token-count notifications. In the default path it delegates only to `pin`, acting as a cheap placeholder in the token-reporting flow.

*Call graph*: 1 external calls (pin).


##### `ToolLifecycleContributor::on_tool_start`  (lines 227–229)

```
fn on_tool_start(&'a self, _input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a>
```

**Purpose**: Provides the default no-op hook for accepted tool calls just before or as execution begins. It lets extensions observe tool execution starts without owning the tool implementation.

**Data flow**: It receives `&self` and `ToolStartInput<'a>`, ignores the input, and returns `ToolLifecycleFuture<'a>` by boxing `std::future::ready(())`. No tool payloads are rewritten and no state is modified.

**Call relations**: The host invokes this once it has accepted a tool call for execution and is notifying registered tool lifecycle contributors. The implementation delegates only to `ready` and `pin` to produce an immediately completed future.

*Call graph*: 2 external calls (pin, ready).


##### `ToolLifecycleContributor::on_tool_finish`  (lines 232–234)

```
fn on_tool_finish(&'a self, _input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a>
```

**Purpose**: Provides the default no-op hook for tool completion outcomes, including success, block, failure, or cancellation. Extensions override it to observe results or update extension-private bookkeeping.

**Data flow**: It takes `&self` and `ToolFinishInput<'a>`, ignores the input, and returns a boxed ready future resolving to unit. It reads no external state and writes nothing.

**Call relations**: The host calls this after a tool call finishes in any terminal state. In the default implementation there is no downstream work beyond wrapping `ready(())` with `pin`.

*Call graph*: 2 external calls (pin, ready).


### Extension runtime support types
These files provide stable supporting contracts for extension state, host-supplied instructions, and extension-driven event emission.

### `ext/extension-api/src/state.rs`

`data_model` · `cross-cutting`

This file is the extension API’s generic state container layer. `ExtensionDataInit` is the pre-runtime initializer: a clonable `HashMap<TypeId, ErasedData>` used by hosts to seed typed attachments before an `ExtensionData` scope exists. Because values are stored as `Arc<dyn Any + Send + Sync>`, cloning the initializer freezes the key set while sharing underlying values, which is important for thread initialization snapshots.

`ExtensionData` is the mutable runtime store attached to a host-owned scope such as a session, thread, or turn. It carries a human-readable `level_id: String` plus a `Mutex<HashMap<TypeId, ErasedData>>`. All typed operations (`get`, `get_or_init`, `insert`, `remove`) key by `TypeId::of::<T>()` and convert erased values back to `Arc<T>` through the private `downcast_data` helper. `get_or_init` is the main lazy-initialization path: it locks the map, inserts `Arc::new(init())` only if absent, and returns a typed `Arc<T>`. The comments note an important invariant here: the initializer closure runs while the mutex is held, so expensive work should be deferred into the stored value itself.

Poisoned mutexes are intentionally tolerated. The private `entries()` helper uses `unwrap_or_else(PoisonError::into_inner)` so extension state remains accessible even after a panic while holding the lock. The `downcast_data` helper treats type mismatches as unreachable, reflecting the invariant that values are always stored and retrieved under the same `TypeId`.

#### Function details

##### `ExtensionDataInit::new`  (lines 23–25)

```
fn new() -> Self
```

**Purpose**: Creates an empty initializer for host-supplied typed attachments. It is the standard constructor for building a seed map before runtime state exists.

**Data flow**: It takes no arguments, calls `Self::default()`, and returns an `ExtensionDataInit` with an empty `entries` map. No external state is read or written.

**Call relations**: Host setup code calls this before inserting initial attachments for a thread or other scope. It delegates entirely to the derived `Default` implementation.

*Call graph*: called by 2 (thread_start_task, selected_plugin_contributions); 1 external calls (default).


##### `ExtensionDataInit::insert`  (lines 28–35)

```
fn insert(&mut self, value: T) -> Option<Arc<T>>
```

**Purpose**: Stores one host-supplied initial attachment keyed by its concrete type and returns any previous value of the same type. It is the typed write path for the initializer map.

**Data flow**: It takes `&mut self` and `value: T` where `T: Any + Send + Sync`, computes `TypeId::of::<T>()`, wraps the value in `Arc::new`, inserts it into `self.entries`, and if a previous erased value existed, converts it back to `Option<Arc<T>>` via `downcast_data`. It mutates the initializer map in place.

**Call relations**: Host seeding code invokes this while preparing initial thread attachments. It delegates to `HashMap::insert`, `Arc::new`, and `downcast_data` to maintain typed semantics over erased storage.

*Call graph*: called by 1 (seed_thread_state); 1 external calls (new).


##### `ExtensionDataInit::get`  (lines 38–44)

```
fn get(&self) -> Option<Arc<T>>
```

**Purpose**: Retrieves a host-supplied initial attachment by concrete type without creating a mutable runtime scope. It is the typed read path for the initializer map.

**Data flow**: It takes `&self`, looks up `TypeId::of::<T>()` in `self.entries`, clones the stored `Arc<dyn Any + Send + Sync>` if present, downcasts it with `downcast_data`, and returns `Option<Arc<T>>`. The map is not mutated.

**Call relations**: Code that needs to inspect frozen initial attachments calls this accessor, including thread-scoped MCP resolution. It delegates to `downcast_data` after cloning the erased `Arc`.

*Call graph*: calls 1 internal fn (downcast_data).


##### `ExtensionData::new`  (lines 56–58)

```
fn new(level_id: impl Into<String>) -> Self
```

**Purpose**: Creates an empty runtime attachment store for one host-owned scope identified by `level_id`. It is the common constructor for session, thread, and turn stores with no initial attachments.

**Data flow**: It takes `level_id: impl Into<String>`, creates a default empty `ExtensionDataInit`, forwards both into `Self::new_with_init`, and returns the resulting `ExtensionData`. It does not mutate external state.

**Call relations**: Many runtime and test paths call this when creating fresh extension stores. It delegates to `new_with_init` and the initializer’s default constructor.

*Call graph*: called by 38 (spawn_review_thread, new, handle_output_item_done_records_image_save_history_message, handle_output_item_done_skips_image_save_message_when_save_fails, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, tool_calls_reopen_mailbox_delivery_for_current_turn, make_turn_context, plan_mode_uses_contributed_turn_item_for_last_agent_message, finalized_turn_item_defers_mailbox_for_contributed_visible_text (+15 more)); 2 external calls (new_with_init, default).


##### `ExtensionData::new_with_init`  (lines 61–66)

```
fn new_with_init(level_id: impl Into<String>, init: ExtensionDataInit) -> Self
```

**Purpose**: Creates a runtime attachment store seeded with a previously prepared initializer. It bridges immutable host-seeded inputs into the mutable runtime map.

**Data flow**: It takes `level_id: impl Into<String>` and `init: ExtensionDataInit`, converts `level_id` into a `String`, moves `init.entries` into a new `Mutex<HashMap<...>>`, and returns `ExtensionData { level_id, entries }`. Ownership of the initializer’s map is transferred into the runtime store.

**Call relations**: This constructor is used when a scope should start with host-provided attachments already installed. `ExtensionData::new` delegates to it for the empty case.

*Call graph*: called by 1 (new); 2 external calls (into, new).


##### `ExtensionData::level_id`  (lines 69–71)

```
fn level_id(&self) -> &str
```

**Purpose**: Returns the host-defined identity string for the scope this attachment store belongs to. It gives contributors a stable label without exposing core runtime objects.

**Data flow**: It takes `&self` and returns `&str` referencing `self.level_id`. No allocation or mutation occurs.

**Call relations**: Contributor implementations and tests call this accessor when recording which session or thread a callback observed. It is a simple leaf accessor.

*Call graph*: called by 3 (contribute, on_token_usage, contribute).


##### `ExtensionData::get`  (lines 74–80)

```
fn get(&self) -> Option<Arc<T>>
```

**Purpose**: Retrieves the attached runtime value of a given concrete type, if present. It is the typed read path for the mutable store.

**Data flow**: It takes `&self`, acquires the mutex through `self.entries()`, looks up `TypeId::of::<T>()`, clones the stored erased `Arc` if found, downcasts it with `downcast_data`, and returns `Option<Arc<T>>`. The map contents are not modified.

**Call relations**: Extension logic calls this when it needs previously attached state. It delegates to the private `entries()` lock helper and then to `downcast_data` for typed recovery.

*Call graph*: calls 2 internal fn (entries, downcast_data).


##### `ExtensionData::get_or_init`  (lines 86–95)

```
fn get_or_init(&self, init: impl FnOnce() -> T) -> Arc<T>
```

**Purpose**: Returns the attached value of type `T`, lazily inserting one produced by a closure if absent. It is the main convenience API for per-scope extension state initialization.

**Data flow**: It takes `&self` and `init: impl FnOnce() -> T`, locks the map via `entries()`, looks up the `TypeId` entry, inserts `Arc::new(init())` only when missing, clones the resulting erased `Arc`, downcasts it with `downcast_data`, and returns `Arc<T>`. It may mutate the map by adding a new typed attachment.

**Call relations**: Extension code uses this when it wants one-time initialization tied to a scope. It delegates to `entries()` for locking, `HashMap::entry().or_insert_with(...)` for lazy insertion, `Arc::clone`, and `downcast_data` for typed output.

*Call graph*: calls 2 internal fn (entries, downcast_data); 1 external calls (clone).


##### `ExtensionData::insert`  (lines 98–105)

```
fn insert(&self, value: T) -> Option<Arc<T>>
```

**Purpose**: Stores a runtime attachment of type `T`, replacing any previous value of the same type and returning that previous value if present. It is the typed overwrite path for extension-owned state.

**Data flow**: It takes `&self` and `value: T`, locks the map with `entries()`, inserts `Arc::new(value)` under `TypeId::of::<T>()`, and maps any replaced erased value through `downcast_data` to `Option<Arc<T>>`. It mutates the runtime map.

**Call relations**: Contributor implementations call this when updating extension-private state in session, thread, or turn stores. It delegates to `entries()`, `Arc::new`, `HashMap::insert`, and `downcast_data`.

*Call graph*: calls 1 internal fn (entries); called by 8 (contribute, contribute, on_config_changed, on_config_changed, on_config_changed, contribute, on_config_changed, on_config_changed); 1 external calls (new).


##### `ExtensionData::remove`  (lines 108–113)

```
fn remove(&self) -> Option<Arc<T>>
```

**Purpose**: Removes and returns the attached runtime value of a given type, if one exists. It is the typed delete path for the store.

**Data flow**: It takes `&self`, locks the map via `entries()`, removes the entry for `TypeId::of::<T>()`, and downcasts any removed erased value to `Option<Arc<T>>`. It mutates the map by deleting the entry when present.

**Call relations**: Extension logic uses this during cleanup or state transitions when a typed attachment should no longer be retained. It delegates to `entries()` and `downcast_data`.

*Call graph*: calls 1 internal fn (entries).


##### `ExtensionData::entries`  (lines 115–117)

```
fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<TypeId, ErasedData>>
```

**Purpose**: Acquires the mutex guarding the runtime attachment map and returns the guard, recovering even from poisoned locks. It centralizes the store’s locking policy.

**Data flow**: It takes `&self`, calls `self.entries.lock()`, and on success returns the `MutexGuard<HashMap<TypeId, ErasedData>>`; on poison it recovers the inner guard with `PoisonError::into_inner`. It does not itself mutate the map, though callers may do so through the returned guard.

**Call relations**: All runtime typed accessors (`get`, `get_or_init`, `insert`, `remove`) call this helper before touching the map. Its poison-recovery behavior ensures those higher-level operations continue to function after a panic in another holder.

*Call graph*: called by 4 (get, get_or_init, insert, remove).


##### `downcast_data`  (lines 120–128)

```
fn downcast_data(value: ErasedData) -> Arc<T>
```

**Purpose**: Converts an erased `Arc<dyn Any + Send + Sync>` back into `Arc<T>` for the expected concrete type. It enforces the invariant that values are always retrieved under the same type they were stored with.

**Data flow**: It takes ownership of `value: ErasedData`, attempts `value.downcast::<T>()`, and returns the typed `Arc<T>` on success. If downcasting fails, it triggers `unreachable!` with a message indicating incompatible typed extension data. It reads no external state and writes no recoverable output on failure.

**Call relations**: Both initializer and runtime typed accessors delegate to this helper after looking up erased values. It is the final type-restoration step that makes the `TypeId`-indexed storage API safe under its internal invariants.

*Call graph*: called by 3 (get, get_or_init, get); 1 external calls (unreachable!).


### `ext/extension-api/src/user_instructions.rs`

`data_model` · `startup`

This file contributes the user-instructions portion of the extension API. `UserInstructions` is the concrete payload exposed to the runtime: model-visible instruction `text` paired with a `source` of type `AbsolutePathBuf`. The source is deliberately constrained to an absolute filesystem path because the current app-server `instructionSources` API reports sources in that form; the inline TODO documents that this is a temporary attribution mechanism rather than a general source abstraction. `LoadedUserInstructions` wraps the outcome of a load attempt and separates usable content from non-fatal problems: `instructions` is optional so providers can explicitly report “no applicable instructions,” while `warnings` carries recoverable startup issues that should still be surfaced. `LoadUserInstructionsFuture<'a>` standardizes the async return type as a boxed, pinned, `Send` future yielding `LoadedUserInstructions`, allowing trait objects and heterogeneous implementations. The `UserInstructionsProvider` trait is the behavioral contract: implementations are expected to produce the snapshot used when a new root runtime starts, and to prefer returning fallback instructions plus warnings over failing hard. The key invariant in this file is attribution fidelity: when instructions exist, their source path must be absolute so downstream reporting remains consistent.


### `ext/goal/src/events.rs`

`io_transport` · `whenever goal updates are emitted to the extension host`

This file is the event-transport adapter for the goal subsystem. `GoalEventEmitter` holds an `Arc<dyn ExtensionEventSink>`, allowing runtime and tool code to emit host-visible events without depending on the sink trait directly. The only event currently modeled here is `thread_goal_updated`, which packages a `ThreadGoal` plus optional turn attribution into the protocol’s `ThreadGoalUpdatedEvent` and then wraps that in the generic `Event` envelope with a caller-supplied event ID.

The design keeps event construction centralized so all goal-update emissions use the same message shape: the thread ID is taken from the `ThreadGoal`, the optional `turn_id` is passed through unchanged, and the full goal payload is included. This file contains no business logic about when updates should be emitted; it is purely the formatting and dispatch layer used by runtime accounting and tool-triggered goal mutations.

#### Function details

##### `GoalEventEmitter::new`  (lines 15–17)

```
fn new(sink: Arc<dyn ExtensionEventSink>) -> Self
```

**Purpose**: Constructs the goal event emitter around a shared extension event sink. It is the dependency-injection point for outbound goal events.

**Data flow**: Takes `Arc<dyn ExtensionEventSink>`, stores it in `GoalEventEmitter { sink }`, and returns the wrapper. No events are emitted here.

**Call relations**: Called during extension initialization so runtime and tool code can emit goal events through a focused helper.

*Call graph*: called by 1 (new_with_host_capabilities).


##### `GoalEventEmitter::thread_goal_updated`  (lines 19–33)

```
fn thread_goal_updated(
        &self,
        event_id: impl Into<String>,
        turn_id: Option<String>,
        goal: ThreadGoal,
    )
```

**Purpose**: Emits a `ThreadGoalUpdated` protocol event for a goal change, optionally attributed to a turn. It is the subsystem’s standard outbound notification for goal state changes.

**Data flow**: Accepts an event ID convertible to `String`, an `Option<String>` turn ID, and a `ThreadGoal`. It converts the event ID, constructs `EventMsg::ThreadGoalUpdated(ThreadGoalUpdatedEvent { thread_id: goal.thread_id, turn_id, goal })`, wraps it in `Event { id, msg }`, and sends it through `self.sink.emit(...)`.

**Call relations**: Called by runtime accounting and tool-call flows after goal state changes have been persisted. It does not decide whether an update is meaningful; it only serializes and dispatches the event.

*Call graph*: called by 2 (account_active_goal_progress, emit_goal_updated_from_tool_call); 2 external calls (into, ThreadGoalUpdated).


### Adjacent extension-facing schemas
These files define other stable extension-consumed boundaries for memories storage and IDE context payloads.

### `ext/memories/src/backend.rs`

`data_model` · `cross-cutting`

This module is the schema layer for memory operations. The `MemoriesBackend` trait declares four asynchronous capabilities—adding an ad-hoc note, listing entries, reading file content, and searching content—while requiring implementations to be `Clone + Send + Sync + 'static` so they can be safely shared through async extension infrastructure. The trait methods exchange strongly typed request and response structs rather than raw maps, which makes pagination, truncation, and path scoping explicit.

The request/response types encode the subsystem’s semantics: listing and searching both support `cursor` pagination and `max_results`; reading is line-oriented with a 1-indexed `line_offset`, optional `max_lines`, and token-based truncation; searching carries multiple queries, a `SearchMatchMode`, optional path scoping, context line count, and normalization/case-sensitivity flags. `MemoryEntry`, `MemoryEntryType`, and `MemorySearchMatch` define the serialized shapes returned to callers. Most response types derive `Serialize` and `JsonSchema`, and several use `#[schemars(deny_unknown_fields)]`, signaling that these payloads are intended for external tool schemas and should remain strict.

`MemoriesBackendError` centralizes validation and I/O failures. Its variants distinguish malformed filenames, paths, cursors, empty notes/queries, invalid line windows, missing files, wrong file kinds, and raw I/O errors. The helper constructors standardize creation of the three formatted validation errors so callers can attach the original offending string plus a concrete reason.

#### Function details

##### `MemoriesBackendError::invalid_filename`  (lines 166–171)

```
fn invalid_filename(filename: impl Into<String>, reason: impl Into<String>) -> Self
```

**Purpose**: Builds the `InvalidFilename` error variant with owned `filename` and `reason` strings. It gives filename validators a uniform way to report exactly which name failed and why.

**Data flow**: Accepts `filename` and `reason` as any `Into<String>` inputs, converts both into owned `String` values, and returns `MemoriesBackendError::InvalidFilename { filename, reason }`. It does not read or mutate external state.

**Call relations**: This helper is used by filename validation logic when ad-hoc note names violate length, suffix, timestamp, or slug rules. It exists so `validate_filename` can emit consistent structured errors without repeating variant construction.

*Call graph*: called by 1 (validate_filename); 1 external calls (into).


##### `MemoriesBackendError::invalid_path`  (lines 173–178)

```
fn invalid_path(path: impl Into<String>, reason: impl Into<String>) -> Self
```

**Purpose**: Constructs the `InvalidPath` variant for path validation failures such as traversal, symlink rejection, or non-directory components. It preserves both the user-visible path string and a backend-specific explanation.

**Data flow**: Takes `path` and `reason`, converts them into owned strings, and returns `MemoriesBackendError::InvalidPath { path, reason }`. No side effects occur.

**Call relations**: Path-resolution and filesystem-guard code call this when a requested path escapes the memory root, crosses a non-directory, points at a symlink, or violates directory expectations. It is the common error constructor behind `resolve_scoped_path`, `ensure_directory`, and `reject_symlink`.

*Call graph*: called by 3 (resolve_scoped_path, ensure_directory, reject_symlink); 1 external calls (into).


##### `MemoriesBackendError::invalid_cursor`  (lines 180–185)

```
fn invalid_cursor(cursor: impl Into<String>, reason: impl Into<String>) -> Self
```

**Purpose**: Creates the `InvalidCursor` variant used by paginated list and search operations. It standardizes reporting for malformed or out-of-range cursor values.

**Data flow**: Consumes `cursor` and `reason` via `Into<String>`, stores them as owned strings, and returns `MemoriesBackendError::InvalidCursor { cursor, reason }`. It does not touch any shared state.

**Call relations**: Pagination code invokes this when a cursor cannot be parsed as a non-negative integer or when the parsed index exceeds the available result count. It is the shared constructor used by both `list` and `search`.

*Call graph*: called by 2 (list, search); 1 external calls (into).


### `tui/src/ide_context.rs`

`data_model` · `request handling`

This file is primarily a data-model module for IDE context exchanged with the desktop/extension side. It declares `IdeContext`, which contains an optional `active_file` and a list of `open_tabs`, all deserialized with `serde` using camelCase field names. `ActiveFile` embeds a flattened `FileDescriptor` so fields like `label` and `path` deserialize directly alongside selection metadata; it also stores the primary `selection`, optional `active_selection_content`, and possibly multiple `selections`. `FileDescriptor` keeps only the label and path fields the TUI actually uses, intentionally ignoring extra JSON such as `fsPath`, `startLine`, `endLine`, or `processEnv`. `Range` and `Position` model zero-based line/character coordinates. The module publicly re-exports `fetch_ide_context` from `ipc` and prompt-related helpers from `prompt`, making this file the stable entry point for IDE-context consumers while hiding transport details and platform-specific pipe/socket code. Its single test confirms backward-compatible deserialization from the existing IDE payload shape, including ignored extra fields and flattened active-file descriptors. That test is important because the TUI depends on partial schema compatibility rather than strict mirroring of the extension’s full payload.

#### Function details

##### `tests::deserializes_existing_ide_context_shape`  (lines 61–116)

```
fn deserializes_existing_ide_context_shape()
```

**Purpose**: Verifies that the current `IdeContext` structs deserialize the existing IDE payload shape while ignoring unrelated extra fields.

**Data flow**: Builds a representative JSON value containing `activeFile`, `openTabs`, and extra fields like `fsPath` and `processEnv`; deserializes it with `serde_json::from_value` into `IdeContext`; and asserts the resulting nested structs contain only the expected retained fields.

**Call relations**: This test guards the schema boundary for both IPC fetching and prompt rendering. It ensures downstream code can rely on partial deserialization even if the IDE payload includes additional fields.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


### Hook public contracts
These files establish the public hook subsystem surface, including execution abstractions, declarations, and event namespace organization.

### `hooks/src/declarations.rs`

`domain_logic` · `plugin hook enumeration / metadata listing`

This file defines the lightweight declaration model used to enumerate bundled plugin hook handlers. `PluginHookDeclaration` stores only the durable hook `key` and its `HookEventName`, intentionally omitting runtime state such as enablement, trust, or command details. The main function, `plugin_hook_declarations`, walks a slice of `PluginHookSource` values and expands each source’s `HookEventsToml` into concrete handler declarations.

The key-generation scheme mirrors runtime discovery. For each plugin source, it first builds a `key_source` string by concatenating the plugin ID key and the source-relative path with `plugin_hook_key_source`, producing values like `demo@test:hooks/hooks.json`. It then iterates every event, matcher group index, and handler index from `into_matcher_groups()`, and for each concrete handler computes the final persisted key with `crate::hook_key(&key_source, event_name, group_index, handler_index)`. That means declaration keys remain aligned with the keys used later for persisted hook state and trust decisions.

The included test demonstrates that multiple handlers in one matcher group and handlers across different events all receive distinct, position-based keys in declaration order.

#### Function details

##### `plugin_hook_declarations`  (lines 12–33)

```
fn plugin_hook_declarations(hook_sources: &[PluginHookSource]) -> Vec<PluginHookDeclaration>
```

**Purpose**: Expands plugin hook source definitions into one declaration per concrete handler. It computes the same persisted hook keys used elsewhere for state lookup.

**Data flow**: It takes a slice of `PluginHookSource`, allocates an output `Vec<PluginHookDeclaration>`, and for each source derives a `key_source` from plugin ID and relative path. It clones the source’s hook events, iterates event names, matcher groups, and handler positions, and pushes a `PluginHookDeclaration { key, event_name }` for each handler. It returns the accumulated vector.

**Call relations**: This function is exercised by the file’s test and conceptually parallels runtime discovery. It delegates key-source formatting to `plugin_hook_key_source` and final key assembly to `crate::hook_key` so declaration keys stay consistent with discovery.

*Call graph*: calls 1 internal fn (plugin_hook_key_source); called by 1 (lists_declared_plugin_handlers_with_persisted_hook_keys); 2 external calls (new, hook_key).


##### `plugin_hook_key_source`  (lines 35–37)

```
fn plugin_hook_key_source(plugin_id: &str, source_relative_path: &str) -> String
```

**Purpose**: Builds the stable prefix used for plugin hook keys from a plugin identifier and source-relative path. The result becomes the left-hand portion of persisted hook keys.

**Data flow**: It accepts `plugin_id` and `source_relative_path` string slices, formats them as `"{plugin_id}:{source_relative_path}"`, and returns the resulting `String`.

**Call relations**: This helper is called both by `plugin_hook_declarations` and by discovery code when plugin hooks are turned into runtime handlers. Its role is to keep plugin key prefixes identical across declaration and execution paths.

*Call graph*: called by 2 (plugin_hook_declarations, append_plugin_hook_sources); 1 external calls (format!).


##### `tests::lists_declared_plugin_handlers_with_persisted_hook_keys`  (lines 52–100)

```
fn lists_declared_plugin_handlers_with_persisted_hook_keys()
```

**Purpose**: Verifies that plugin hook declarations enumerate every concrete handler and assign the expected persisted keys. It covers multiple events and multiple handlers within one matcher group.

**Data flow**: It constructs a synthetic `PluginHookSource` with `pre_tool_use` and `session_start` hooks, calls `plugin_hook_declarations`, and asserts that the returned vector exactly matches the expected `PluginHookDeclaration` list and key strings.

**Call relations**: This test directly drives `plugin_hook_declarations`. It depends on the production key-generation logic to prove compatibility with persisted hook-state keys.

*Call graph*: calls 2 internal fn (plugin_hook_declarations, parse); 4 external calls (default, assert_eq!, test_path_buf, vec!).


### `hooks/src/events/mod.rs`

`orchestration` · `cross-cutting / hook event definition and dispatch setup`

This module file declares the set of event-oriented submodules used by the hooks subsystem. `common` is kept `pub(crate)`, indicating it contains shared internal machinery or helper definitions intended only for use within the hooks crate. The remaining modules—`compact`, `permission_request`, `post_tool_use`, `pre_tool_use`, `session_start`, `stop`, and `user_prompt_submit`—are public, which makes them part of the crate’s outward-facing event model.

The structure communicates the event taxonomy directly: there are lifecycle events (`session_start`, `stop`), tool invocation boundary events (`pre_tool_use`, `post_tool_use`), user interaction events (`user_prompt_submit`), permission workflow events (`permission_request`), and a likely alternate or reduced representation in `compact`. This file itself contains no behavior, but it is important because it defines visibility boundaries and the canonical paths by which other code imports event definitions. The split between `pub(crate)` and `pub` is the key design detail: shared internals remain encapsulated while concrete event modules are exposed for serialization, dispatch, or hook consumer integration elsewhere in the system.


### `hooks/src/types.rs`

`data_model` · `hook dispatch and hook payload serialization`

This file provides the runtime types for invoking hooks rather than the schema-generation layer. `HookFn` is an `Arc`-wrapped async callback trait object taking `&HookPayload` and returning a boxed future of `HookResult`, which lets the rest of the system store heterogeneous hook implementations behind a uniform interface. `HookResult` distinguishes three outcomes: `Success`, `FailedContinue(error)` for non-fatal hook failures that should not stop later hooks or the main operation, and `FailedAbort(error)` for failures that should terminate the operation. `HookResponse` pairs the hook name with its result so callers can report which hook produced which outcome.

`Hook` itself is a small executable wrapper containing a display name and the callback. Its `Default` implementation creates a no-op hook named `default` that always resolves to `HookResult::Success`, which is useful as a placeholder. `execute` clones the hook name and awaits the stored callback.

The payload side is intentionally serializable and stable. `HookPayload` includes `session_id`, absolute `cwd`, optional `client`, a custom-formatted UTC timestamp, and a tagged `HookEvent`. Currently the only event variant is `AfterAgent`, which flattens `HookEventAfterAgent` fields (`thread_id`, `turn_id`, `input_messages`, `last_assistant_message`) under `hook_event` with `event_type: "after_agent"`. The custom `serialize_triggered_at` function forces RFC3339 seconds precision with a trailing `Z`, and the test locks down the exact JSON wire shape.

#### Function details

##### `HookResult::should_abort_operation`  (lines 27–29)

```
fn should_abort_operation(&self) -> bool
```

**Purpose**: Reports whether a hook result should stop the enclosing operation.

**Data flow**: Reads `self` → returns `true` only for `HookResult::FailedAbort(_)`, otherwise `false`.

**Call relations**: Used by higher-level hook orchestration code to decide whether to continue running subsequent hooks or abort immediately after a failure.

*Call graph*: 1 external calls (matches!).


##### `Hook::default`  (lines 45–50)

```
fn default() -> Self
```

**Purpose**: Creates a placeholder hook that succeeds without doing any work.

**Data flow**: Constructs a `Hook` with `name = "default"` and `func = Arc::new(|_| Box::pin(async { HookResult::Success }))` → returns that hook value.

**Call relations**: Serves as the `Default` implementation for `Hook`, allowing callers to initialize hook slots before real callbacks are installed.

*Call graph*: 1 external calls (new).


##### `Hook::execute`  (lines 54–59)

```
async fn execute(&self, payload: &HookPayload) -> HookResponse
```

**Purpose**: Runs the stored async hook callback and packages the result with the hook's name.

**Data flow**: Takes `&self` and `&HookPayload` → clones `self.name`, invokes `(self.func)(payload)`, awaits the future, and returns `HookResponse { hook_name, result }`.

**Call relations**: Called by hook execution orchestration whenever an installed hook should be run against a concrete payload.


##### `serialize_triggered_at`  (lines 83–88)

```
fn serialize_triggered_at(value: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes hook timestamps in a stable RFC3339 UTC format with second precision.

**Data flow**: Takes `&DateTime<Utc>` and a serde serializer → formats the timestamp with `to_rfc3339_opts(SecondsFormat::Secs, true)` → writes it as a string through `serializer.serialize_str`.

**Call relations**: Referenced by `HookPayload.triggered_at` via `#[serde(serialize_with = ...)]` so all payload JSON uses the same timestamp representation.

*Call graph*: 2 external calls (to_rfc3339_opts, serialize_str).


##### `tests::hook_payload_serializes_stable_wire_shape`  (lines 114–151)

```
fn hook_payload_serializes_stable_wire_shape()
```

**Purpose**: Locks down the exact JSON representation of `HookPayload` and the `AfterAgent` event variant.

**Data flow**: Builds a sample payload with generated `ThreadId`s, a test absolute path, a fixed UTC timestamp, and an `AfterAgent` event → serializes it with `serde_json::to_value` → compares against an explicit JSON object containing snake_case field names, omitted `client`, formatted timestamp, and flattened event fields.

**Call relations**: Regression test for serde attributes, custom timestamp formatting, and the tagged/flattened event encoding.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, test_path_buf, json!, to_value, vec!).


### `hooks/src/lib.rs`

`orchestration` · `cross-cutting API surface and config-state key generation`

This crate root wires together the hooks subsystem by declaring internal modules and selectively re-exporting the types and functions that callers use. Most of the file is API curation: it exposes hook declaration helpers, event request/outcome structs, registry entry points, schema fixture generation, legacy notify helpers, and the core hook types (`Hook`, `HookEvent`, `HookPayload`, `HookResponse`, `HookResult`).

Two constants define the canonical event names accepted in hooks JSON and config files. `HOOK_EVENT_NAMES` lists all ten supported event labels, while `HOOK_EVENT_NAMES_WITH_MATCHERS` narrows that set to the eight events whose matcher fields are meaningful during dispatch. The comments make an important design distinction: some events may appear in configuration with matcher fields, but Codex intentionally ignores those matchers because dispatch for those events is not keyed by tool name, compaction trigger, or start source.

The only executable logic here is the persisted-key naming scheme. `hook_event_key_label` maps each `HookEventName` enum variant to the snake_case label used in stored hook-state keys, and `hook_key` combines a caller-provided source identifier with that label plus group and handler indexes. This centralizes the stable key format so config-state persistence and discovery code can agree on exact identifiers.

#### Function details

##### `hook_event_key_label`  (lines 84–97)

```
fn hook_event_key_label(event_name: HookEventName) -> &'static str
```

**Purpose**: Maps each protocol hook event enum to the stable snake_case label used in persisted hook-state keys.

**Data flow**: Reads a `HookEventName` and returns one of ten static strings such as `pre_tool_use`, `session_start`, or `subagent_stop`. It performs no allocation and mutates no state.

**Call relations**: Used by `hook_key` to ensure persisted keys use a single canonical event-label mapping.


##### `hook_key`  (lines 100–110)

```
fn hook_key(
    key_source: &str,
    event_name: HookEventName,
    group_index: usize,
    handler_index: usize,
) -> String
```

**Purpose**: Builds the full persisted config-state key for one discovered hook handler.

**Data flow**: Accepts a `key_source` string, `HookEventName`, `group_index`, and `handler_index`, calls `hook_event_key_label(event_name)`, and formats them into `"{key_source}:{event_label}:{group_index}:{handler_index}"`. Returns the allocated `String`.

**Call relations**: Acts as the public helper for any code that needs to derive stable per-handler persistence keys from discovery metadata.

*Call graph*: 1 external calls (format!).


### Hook wire schemas
These files define the serialized hook command shapes and the loader that exposes their generated JSON Schemas to the engine.

### `hooks/src/schema.rs`

`data_model` · `build/test time for schema generation; runtime whenever hook payloads are serialized or parsed`

This file is the canonical schema layer for hook I/O. It declares the serialized input structs for each hook event (`PreToolUseCommandInput`, `PermissionRequestCommandInput`, `PostToolUseCommandInput`, compact/session/subagent/user/stop variants) and the deserializable output structs that hooks return (`*CommandOutputWire`, plus hook-specific nested output payloads). Most types derive `Serialize`, `Deserialize`, and `JsonSchema`, with `deny_unknown_fields` used on wire structs so unexpected fields are rejected. Several fields intentionally use custom schema functions rather than unconstrained strings: hook event names are emitted as string constants, permission mode/source/trigger fields are emitted as string enums, and `NullableString` overrides schemars so optional strings become `type: ["string", "null"]` instead of an `anyOf`-style option schema.

The file also encodes Codex-specific contract details that are easy to miss: many turn-scoped hook inputs include a required `turn_id`; hooks that may run inside subagents expose optional flat `agent_id`/`agent_type`; and some semantic constraints are documented but enforced elsewhere rather than in JSON Schema (for example, `reason` required when a stop decision blocks, or reserved PermissionRequest rewrite fields that currently fail closed during parsing). Schema fixture generation is deterministic: `schema_for_type` uses draft-07 with `option_add_null_type = false`, `canonicalize_json` recursively sorts object keys, and `write_schema_fixtures` rewrites a fresh `generated/` directory with one schema file per hook input/output pair. The test module verifies fixture parity and several intentional schema divergences from upstream Claude docs.

#### Function details

##### `NullableString::from_path`  (lines 44–46)

```
fn from_path(path: Option<PathBuf>) -> Self
```

**Purpose**: Builds the transparent nullable-string wrapper from an optional filesystem path by rendering the path for wire serialization.

**Data flow**: Takes `Option<PathBuf>` → maps `Some(path)` to `path.display().to_string()` and leaves `None` unchanged → returns `NullableString(Option<String>)` with no side effects.

**Call relations**: Used by hook input builders and runners whenever transcript paths or similar optional path fields must be flattened into JSON-friendly strings before serialization.

*Call graph*: called by 10 (post_command_input_json, pre_command_input_json, build_command_input, command_input_json, command_input_json, run, run, run, new, subagent_context_fields_serialize_flat_and_omit_when_absent).


##### `NullableString::from_string`  (lines 48–50)

```
fn from_string(value: Option<String>) -> Self
```

**Purpose**: Wraps an already prepared optional string in the `NullableString` newtype.

**Data flow**: Consumes `Option<String>` directly → stores it unchanged inside `NullableString` → returns the wrapper without touching external state.

**Call relations**: Invoked in runtime hook construction paths where the source value is already textual rather than path-based.

*Call graph*: called by 1 (run).


##### `NullableString::schema_name`  (lines 54–56)

```
fn schema_name() -> String
```

**Purpose**: Supplies the stable schemars type name for the custom nullable string schema.

**Data flow**: Reads no inputs or state → returns the literal schema name `"NullableString"`.

**Call relations**: Called by schemars during schema generation so references and definitions use a predictable custom type name.


##### `NullableString::json_schema`  (lines 58–63)

```
fn json_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Overrides schemars output so nullable strings are represented as a single schema object with `string|null` instance types.

**Data flow**: Ignores the generator argument → constructs a `Schema::Object(SchemaObject)` with `instance_type` set to both `String` and `Null` → returns that schema object.

**Call relations**: Used automatically by schemars whenever a field of type `NullableString` appears in one of the hook input/output schemas.

*Call graph*: 3 external calls (default, Object, vec!).


##### `SubagentCommandInputFields::from`  (lines 73–81)

```
fn from(value: Option<&SubagentHookContext>) -> Self
```

**Purpose**: Extracts optional flat subagent identity fields from an optional `SubagentHookContext`.

**Data flow**: Takes `Option<&SubagentHookContext>` → on `Some`, clones `agent_id` and `agent_type` into `Some(...)`; on `None`, returns `SubagentCommandInputFields::default()` with both fields absent → returns the helper struct.

**Call relations**: Called by hook input assembly code to splice subagent context into otherwise shared hook input payloads; tests also use it to verify omission behavior when no subagent is active.

*Call graph*: called by 7 (post_command_input_json, pre_command_input_json, build_command_input, command_input_json, command_input_json, run, subagent_context_fields_serialize_flat_and_omit_when_absent); 1 external calls (default).


##### `SessionStartCommandInput::new`  (lines 499–516)

```
fn new(
        session_id: impl Into<String>,
        transcript_path: Option<PathBuf>,
        cwd: impl Into<String>,
        model: impl Into<String>,
        permission_mode: impl Into<String>,
```

**Purpose**: Constructs a complete session-start hook input with the fixed event name and normalized nullable transcript path.

**Data flow**: Accepts session id, optional transcript path, cwd, model, permission mode, and source as `Into<String>`/`Option<PathBuf>` inputs → converts each into owned strings, sets `hook_event_name` to `"SessionStart"`, and wraps the transcript path via `NullableString::from_path` → returns a populated `SessionStartCommandInput`.

**Call relations**: Used by session-start runtime code so callers do not manually duplicate the event-name constant or nullable-path conversion.

*Call graph*: calls 1 internal fn (from_path); called by 1 (run); 1 external calls (into).


##### `write_schema_fixtures`  (lines 597–683)

```
fn write_schema_fixtures(schema_root: &Path) -> anyhow::Result<()>
```

**Purpose**: Regenerates the full set of checked-in JSON Schema fixture files for every supported hook command input and output type.

**Data flow**: Takes a schema root path → creates/clears `<root>/generated` via `ensure_empty_dir` → for each fixture constant, computes pretty canonical schema bytes with `schema_json::<T>()` and writes them with `write_schema` → returns `Ok(())` or propagates filesystem/serialization errors.

**Call relations**: This is the top-level schema generation driver, exercised by tests to ensure generated schemas match the repository fixtures.

*Call graph*: calls 2 internal fn (ensure_empty_dir, write_schema); called by 1 (generated_hook_schemas_match_fixtures); 1 external calls (join).


##### `write_schema`  (lines 685–688)

```
fn write_schema(path: &Path, json: Vec<u8>) -> anyhow::Result<()>
```

**Purpose**: Writes one generated schema blob to disk.

**Data flow**: Accepts a destination `&Path` and serialized JSON bytes → calls `std::fs::write` → returns `Ok(())` on success or the propagated I/O error wrapped in `anyhow::Result`.

**Call relations**: Only called from `write_schema_fixtures` as the final persistence step for each schema file.

*Call graph*: called by 1 (write_schema_fixtures); 1 external calls (write).


##### `ensure_empty_dir`  (lines 690–696)

```
fn ensure_empty_dir(dir: &Path) -> anyhow::Result<()>
```

**Purpose**: Recreates a directory from scratch so schema generation starts from a clean output tree.

**Data flow**: Takes a directory path → if it exists, removes it recursively; then creates it with all parents → returns `Ok(())` or propagates filesystem errors.

**Call relations**: Called once by `write_schema_fixtures` before any individual schema files are emitted.

*Call graph*: called by 1 (write_schema_fixtures); 3 external calls (exists, create_dir_all, remove_dir_all).


##### `schema_json`  (lines 698–706)

```
fn schema_json() -> anyhow::Result<Vec<u8>>
```

**Purpose**: Generates deterministic pretty-printed JSON bytes for a schemars type.

**Data flow**: Generic over `T: JsonSchema` → builds a `RootSchema` with `schema_for_type::<T>()`, converts it to `serde_json::Value`, recursively sorts object keys with `canonicalize_json`, then pretty-serializes to `Vec<u8>` → returns the bytes or serialization errors.

**Call relations**: Used by fixture generation and tests that inspect generated schemas as JSON values.

*Call graph*: calls 1 internal fn (canonicalize_json); 2 external calls (to_value, to_vec_pretty).


##### `schema_for_type`  (lines 708–718)

```
fn schema_for_type() -> RootSchema
```

**Purpose**: Creates the root draft-07 schema for a Rust type using project-specific schemars settings.

**Data flow**: Generic over `T: JsonSchema` → starts from `SchemaSettings::draft07()`, mutates settings so options do not automatically add null types, then generates `RootSchema` for `T` → returns that schema.

**Call relations**: Called by `schema_json` to centralize the schema-generation configuration shared by all hook types.

*Call graph*: 1 external calls (draft07).


##### `canonicalize_json`  (lines 720–734)

```
fn canonicalize_json(value: &Value) -> Value
```

**Purpose**: Recursively sorts JSON object keys so generated schema files are stable across runs.

**Data flow**: Takes a `&Value` → for arrays, canonicalizes each element in order; for objects, sorts entries by key and rebuilds a `Map`; for scalars, clones the value unchanged → returns a new canonicalized `Value`.

**Call relations**: Used only by `schema_json` after schemars output and before pretty-printing.

*Call graph*: called by 1 (schema_json); 4 external calls (with_capacity, Array, Object, clone).


##### `session_start_hook_event_name_schema`  (lines 736–738)

```
fn session_start_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field that must equal `SessionStart`.

**Data flow**: Ignores the generator argument → delegates to `string_const_schema("SessionStart")` → returns that schema.

**Call relations**: Referenced by `#[schemars(schema_with = ...)]` on session-start wire fields.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `post_tool_use_hook_event_name_schema`  (lines 740–742)

```
fn post_tool_use_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `PostToolUse`.

**Data flow**: Ignores the generator → returns `string_const_schema("PostToolUse")`.

**Call relations**: Used by post-tool-use input and hook-specific output schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `pre_compact_hook_event_name_schema`  (lines 744–746)

```
fn pre_compact_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `PreCompact`.

**Data flow**: Ignores the generator → returns `string_const_schema("PreCompact")`.

**Call relations**: Used by pre-compact input schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `post_compact_hook_event_name_schema`  (lines 748–750)

```
fn post_compact_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `PostCompact`.

**Data flow**: Ignores the generator → returns `string_const_schema("PostCompact")`.

**Call relations**: Used by post-compact input schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `pre_tool_use_hook_event_name_schema`  (lines 752–754)

```
fn pre_tool_use_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `PreToolUse`.

**Data flow**: Ignores the generator → returns `string_const_schema("PreToolUse")`.

**Call relations**: Used by pre-tool-use input and hook-specific output schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `permission_request_hook_event_name_schema`  (lines 756–758)

```
fn permission_request_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `PermissionRequest`.

**Data flow**: Ignores the generator → returns `string_const_schema("PermissionRequest")`.

**Call relations**: Used by permission-request input and hook-specific output schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `user_prompt_submit_hook_event_name_schema`  (lines 760–762)

```
fn user_prompt_submit_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `UserPromptSubmit`.

**Data flow**: Ignores the generator → returns `string_const_schema("UserPromptSubmit")`.

**Call relations**: Used by user-prompt-submit input and hook-specific output schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `subagent_start_hook_event_name_schema`  (lines 764–766)

```
fn subagent_start_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `SubagentStart`.

**Data flow**: Ignores the generator → returns `string_const_schema("SubagentStart")`.

**Call relations**: Used by subagent-start input and hook-specific output schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `subagent_stop_hook_event_name_schema`  (lines 768–770)

```
fn subagent_stop_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `SubagentStop`.

**Data flow**: Ignores the generator → returns `string_const_schema("SubagentStop")`.

**Call relations**: Used by subagent-stop input schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `stop_hook_event_name_schema`  (lines 772–774)

```
fn stop_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Produces the schema for a `hook_event_name` field fixed to `Stop`.

**Data flow**: Ignores the generator → returns `string_const_schema("Stop")`.

**Call relations**: Used by stop input schema annotations.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `permission_mode_schema`  (lines 776–784)

```
fn permission_mode_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Constrains permission mode fields to the supported wire enum values.

**Data flow**: Ignores the generator → passes the fixed string slice `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` to `string_enum_schema` → returns the resulting schema.

**Call relations**: Referenced by many hook input structs so their `permission_mode` field is schema-enforced rather than free-form.

*Call graph*: calls 1 internal fn (string_enum_schema).


##### `session_start_source_schema`  (lines 786–788)

```
fn session_start_source_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Constrains session-start `source` to the supported startup/resume lifecycle values.

**Data flow**: Ignores the generator → returns `string_enum_schema(&["startup", "resume", "clear", "compact"])`.

**Call relations**: Used only by `SessionStartCommandInput`.

*Call graph*: calls 1 internal fn (string_enum_schema).


##### `compaction_trigger_schema`  (lines 790–792)

```
fn compaction_trigger_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Constrains compact hook `trigger` fields to `manual` or `auto`.

**Data flow**: Ignores the generator → returns `string_enum_schema(&["manual", "auto"])`.

**Call relations**: Used by both pre-compact and post-compact input schemas.

*Call graph*: calls 1 internal fn (string_enum_schema).


##### `string_const_schema`  (lines 794–801)

```
fn string_const_schema(value: &str) -> Schema
```

**Purpose**: Builds a JSON Schema object for a string field with one exact allowed value.

**Data flow**: Takes a `&str` constant → creates a `SchemaObject` with `instance_type = String` and `const_value = Value::String(value)` → wraps it as `Schema::Object` and returns it.

**Call relations**: Shared helper behind all event-name schema functions.

*Call graph*: called by 10 (permission_request_hook_event_name_schema, post_compact_hook_event_name_schema, post_tool_use_hook_event_name_schema, pre_compact_hook_event_name_schema, pre_tool_use_hook_event_name_schema, session_start_hook_event_name_schema, stop_hook_event_name_schema, subagent_start_hook_event_name_schema, subagent_stop_hook_event_name_schema, user_prompt_submit_hook_event_name_schema); 3 external calls (default, Object, String).


##### `string_enum_schema`  (lines 803–815)

```
fn string_enum_schema(values: &[&str]) -> Schema
```

**Purpose**: Builds a JSON Schema object for a string field restricted to a finite set of values.

**Data flow**: Takes a slice of string literals → creates a `SchemaObject` with `instance_type = String` and `enum_values` populated from those literals → returns `Schema::Object`.

**Call relations**: Shared helper behind permission mode, session source, and compaction trigger schema functions.

*Call graph*: called by 3 (compaction_trigger_schema, permission_mode_schema, session_start_source_schema); 2 external calls (default, Object).


##### `default_continue`  (lines 817–819)

```
fn default_continue() -> bool
```

**Purpose**: Provides the serde default for hook outputs' `continue` flag.

**Data flow**: Reads no inputs or state → returns `true`.

**Call relations**: Referenced by `HookUniversalOutputWire` so omitted `continue` fields default to continuing execution.


##### `tests::expected_fixture`  (lines 869–933)

```
fn expected_fixture(name: &str) -> &'static str
```

**Purpose**: Maps a fixture filename constant to the corresponding checked-in schema file contents embedded at compile time.

**Data flow**: Takes a fixture name string → matches it against all known fixture constants and returns the `include_str!` contents for that generated schema file; panics on an unexpected name.

**Call relations**: Used by the fixture parity test to compare regenerated schemas against repository snapshots.

*Call graph*: 2 external calls (include_str!, panic!).


##### `tests::normalize_newlines`  (lines 935–937)

```
fn normalize_newlines(value: &str) -> String
```

**Purpose**: Normalizes CRLF to LF so fixture comparisons are platform-independent.

**Data flow**: Takes `&str` → replaces `"\r\n"` with `"\n"` → returns the normalized `String`.

**Call relations**: Applied to both expected and actual schema text in the fixture comparison test.


##### `tests::assert_output_hook_event_name_const`  (lines 939–951)

```
fn assert_output_hook_event_name_const(definition: &str, expected: &str)
```

**Purpose**: Asserts that a generated output schema definition pins `hookEventName` to the expected event-specific constant.

**Data flow**: Generic over `T: JsonSchema`; takes a definition name and expected string → generates schema JSON bytes with `schema_json::<T>()`, parses them to `Value`, and compares the nested `definitions[definition].properties.hookEventName` object against the expected `{const,type}` JSON.

**Call relations**: Called by the output-schema event-name test for each hook-specific output type.

*Call graph*: 2 external calls (assert_eq!, from_slice).


##### `tests::generated_hook_schemas_match_fixtures`  (lines 954–987)

```
fn generated_hook_schemas_match_fixtures()
```

**Purpose**: Verifies that regenerating all hook schemas produces exactly the checked-in fixture files.

**Data flow**: Creates a temporary schema root → runs `write_schema_fixtures` → iterates over every fixture constant, loads expected embedded text and actual generated file text, normalizes newlines, and asserts equality.

**Call relations**: This is the broad regression test guarding accidental schema drift.

*Call graph*: calls 1 internal fn (write_schema_fixtures); 5 external calls (new, assert_eq!, expected_fixture, normalize_newlines, read_to_string).


##### `tests::hook_specific_output_event_names_are_event_specific_in_output_schemas`  (lines 990–1015)

```
fn hook_specific_output_event_names_are_event_specific_in_output_schemas()
```

**Purpose**: Checks that each hook-specific output payload schema uses its own event-name constant rather than the broader enum.

**Data flow**: Calls `assert_output_hook_event_name_const` for permission-request, post-tool-use, pre-tool-use, session-start, subagent-start, and user-prompt-submit output schemas.

**Call relations**: Focused regression test for the custom `schema_with` annotations on nested output structs.


##### `tests::turn_scoped_hook_inputs_include_codex_turn_id_extension`  (lines 1018–1082)

```
fn turn_scoped_hook_inputs_include_codex_turn_id_extension()
```

**Purpose**: Confirms that all turn-scoped hook input schemas include a required string `turn_id` field.

**Data flow**: Generates and parses schema JSON for each relevant input type → inspects `properties.turn_id.type` and the `required` array → asserts that `turn_id` is present and required in every schema.

**Call relations**: Protects the intentional Codex extension that diverges from public Claude hook docs.

*Call graph*: 3 external calls (assert!, assert_eq!, from_slice).


##### `tests::subagent_context_fields_are_optional_for_hooks_that_run_inside_subagents`  (lines 1085–1107)

```
fn subagent_context_fields_are_optional_for_hooks_that_run_inside_subagents()
```

**Purpose**: Verifies that `agent_id` and `agent_type` appear as optional flat string fields on hook inputs that may execute inside subagents.

**Data flow**: Generates schemas for the affected input types → parses each to `Value` → asserts both properties have type `string` and are absent from the `required` list.

**Call relations**: Regression test for the optional subagent context contract encoded in several input structs.

*Call graph*: 3 external calls (assert!, assert_eq!, from_slice).


##### `tests::subagent_context_fields_serialize_flat_and_omit_when_absent`  (lines 1110–1165)

```
fn subagent_context_fields_serialize_flat_and_omit_when_absent()
```

**Purpose**: Checks the runtime JSON shape of subagent context fields when present and when absent.

**Data flow**: Builds `SubagentCommandInputFields` from a concrete `SubagentHookContext`, inserts those values into a `PreToolUseCommandInput`, serializes to JSON, and asserts flat `agent_id`/`agent_type` keys are present; then serializes a root-level input with both fields `None` and asserts those keys are omitted.

**Call relations**: Uses both `SubagentCommandInputFields::from` and `NullableString::from_path` to validate the intended serialization behavior of shared hook input construction.

*Call graph*: calls 2 internal fn (from_path, from); 3 external calls (assert_eq!, json!, to_value).


### `hooks/src/engine/schema_loader.rs`

`generated` · `startup or first schema access`

This file is a small schema registry around a `GeneratedHookSchemas` struct whose fields hold `serde_json::Value` documents for every generated hook schema pair: pre/post tool use, permission request, pre/post compact, session start, subagent start/stop, user prompt submit, and stop. The schemas are embedded at compile time with `include_str!` from `schema/generated/*.schema.json`, so runtime access does not depend on filesystem reads.

`generated_hook_schemas` uses a `OnceLock<GeneratedHookSchemas>` to parse the embedded JSON exactly once and then return a shared `'static` reference on subsequent calls. Each field is initialized by `parse_json_schema`, which deserializes the schema text and panics with a schema-specific message if any generated file is invalid. That panic is deliberate: malformed generated schemas are treated as a build/package defect, not a recoverable runtime condition.

The test module simply asserts that every loaded schema has top-level `"type": "object"`, which acts as a smoke test that all embedded files are present, parseable, and wired into the registry.

#### Function details

##### `generated_hook_schemas`  (lines 29–113)

```
fn generated_hook_schemas() -> &'static GeneratedHookSchemas
```

**Purpose**: Returns the singleton bundle of parsed generated hook schemas. On first use it parses every embedded schema file and stores the resulting `GeneratedHookSchemas` in a `OnceLock`.

**Data flow**: Reads the static `SCHEMAS` cell → if uninitialized, constructs `GeneratedHookSchemas` by calling `parse_json_schema` on each `include_str!` JSON schema payload → stores the struct in `OnceLock` → returns a shared reference to the cached bundle.

**Call relations**: Called by engine initialization code that needs schema access and by the unit test that validates the embedded registry.

*Call graph*: called by 2 (new, loads_generated_hook_schemas); 1 external calls (new).


##### `parse_json_schema`  (lines 115–118)

```
fn parse_json_schema(name: &str, schema: &str) -> Value
```

**Purpose**: Parses one embedded schema string into `serde_json::Value` and panics with context if parsing fails. It is the low-level loader used for every schema field.

**Data flow**: Takes a schema name and raw JSON string → calls `serde_json::from_str` → returns the parsed `Value` on success, or panics with `invalid generated hooks schema {name}: {err}` on failure.

**Call relations**: Used only during `generated_hook_schemas` initialization so each field gets a parsed JSON document.

*Call graph*: 1 external calls (from_str).


##### `tests::loads_generated_hook_schemas`  (lines 126–149)

```
fn loads_generated_hook_schemas()
```

**Purpose**: Smoke-tests that all embedded generated schemas load and look like object schemas. It verifies the registry wiring rather than schema semantics.

**Data flow**: Calls `generated_hook_schemas()` → indexes each schema field at `["type"]` → asserts each equals `"object"`.

**Call relations**: Exercises the lazy initialization path and confirms every embedded schema file is reachable through the registry.

*Call graph*: calls 1 internal fn (generated_hook_schemas); 1 external calls (assert_eq!).
