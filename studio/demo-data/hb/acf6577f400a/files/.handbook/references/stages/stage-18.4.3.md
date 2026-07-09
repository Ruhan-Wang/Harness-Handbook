# Extension and hook interface contracts  `stage-18.4.3`

This stage is shared behind-the-scenes support for people who add plugins, extensions, or hooks. It defines the stable “contracts” they can rely on, so outside code does not need to know the host’s private machinery. The extension API front doors gather and re-export the public pieces. Capability files describe powers the host may give an extension: starting a subagent, sending events, or adding extra items to the model’s current turn, with safe no-op versions when unsupported. Contributor files define the callback data for MCP server changes, thread and turn lifecycle moments, tool calls, and turn input. The main contributors file lists the plug-in points themselves. State gives extensions a safe typed storage box, and user instructions define how startup instruction text is reported. Goal events package goal changes in the standard event form. The memories backend defines a storage contract, while IDE context describes editor-provided file and selection data for the terminal UI. The hooks files define declared hook handlers, event modules, shared hook types, JSON wire formats, schema generation, and schema loading, making hook commands predictable and checkable.

## Files in this stage

### Extension API facade
These files define the top-level public surface of the extension API crate and its shared capability exports.

### `ext/extension-api/src/capabilities/agent.rs`

`data_model` · `cross-cutting; used when extensions are constructed and whenever they request a subagent`

This file is part of the extension API: the boundary between extension code and the main host program. Its job is to describe one capability the host can give to an extension: spawning a subagent, meaning starting another agent thread or worker that branches off from an existing conversation thread.

The key idea is dependency injection: instead of an extension directly creating subagents itself, the host hands it an object that knows how to do that. This is like giving a guest a front-desk phone rather than keys to every room. The guest can request help, but the building still controls how the work is done.

The file defines `AgentSpawnFuture`, which is the promised result of an asynchronous spawn request. A future is a value representing work that will finish later. It also defines the `AgentSpawner<R>` trait, where `R` is the request shape chosen by the extension. The trait says: given the thread being forked from and a request, return either a spawned subagent handle or an error.

Finally, the file includes a convenience implementation so a plain function or closure can act as an `AgentSpawner`. That means the host does not need to build a full custom struct just to provide this capability; it can pass a callable helper directly.

#### Function details

##### `F::spawn_subagent`  (lines 31–37)

```
fn spawn_subagent(
        &'a self,
        forked_from_thread_id: ThreadId,
        request: R,
    ) -> AgentSpawnFuture<'a, Self::Spawned, Self::Error>
```

**Purpose**: This lets an ordinary function or closure satisfy the `AgentSpawner` interface. Someone uses it when the host wants to provide subagent-spawning behavior without writing a separate named type.

**Data flow**: It receives the original thread ID and the extension's spawn request. It passes both values straight into the stored function or closure. The result is a future, meaning an asynchronous operation that will later produce either the spawned subagent value or an error.

**Call relations**: Extension-facing code calls this through the `AgentSpawner` trait when it needs a subagent. In this implementation, the trait method simply hands the work off to the injected function or closure, so the real spawning behavior remains supplied by the host.


### `ext/extension-api/src/capabilities/events.rs`

`data_model` · `cross-cutting`

Extensions sometimes need to report something back to the main program, such as progress, a warning, or the result of a callback. This file defines a small contract for that: an `ExtensionEventSink`, which is like a mailbox the host gives to an extension. The extension drops an `Event` into it, and the host decides what happens next, such as saving it, ordering it with other events, sending it over a connection, or logging it.

The important idea is separation of responsibility. Extensions create the event, including the right correlation id so the host can connect it to the request or callback that caused it. But extensions do not decide how events are delivered. That keeps extensions simpler and lets different hosts choose different delivery behavior.

The file also defines `NoopExtensionEventSink`, a safe fallback mailbox that silently throws events away. This is useful when event emission is not available. Instead of forcing every extension to check whether event support exists, the host can provide this no-op sink. It is like giving someone a suggestion box that is not connected to anything: putting a note inside does not break the program, but nothing is delivered either.

#### Function details

##### `NoopExtensionEventSink::emit`  (lines 18–18)

```
fn emit(&self, _event: Event)
```

**Purpose**: This is the do-nothing implementation of event sending. It lets code call `emit` safely even when the host has not provided a real event delivery path.

**Data flow**: An `Event` is passed in, but the function deliberately ignores it. Nothing is stored, sent, logged, or returned, and no outside state changes.

**Call relations**: This function is used when a `NoopExtensionEventSink` is standing in for a real `ExtensionEventSink`. In the larger flow, extension-facing code can still try to emit an event, but this implementation stops the story there and hands the event off to no one.


### `ext/extension-api/src/capabilities/response_items.rs`

`domain_logic` · `during an active model turn when an extension asks to add model-visible input`

Some extensions may want to steer what the model sees while a conversation turn is still active. For example, an extension might discover useful context and ask the host to feed it into the model immediately, rather than waiting for a later turn. This file describes that capability in a small, host-facing interface.

The main idea is the `ResponseItemInjector` trait. A trait is like a promise: any host that implements it agrees to provide a method for trying to inject response input items into the active model turn. The input items are `ResponseInputItem` values, which are pieces of model-visible conversation input from the shared protocol.

Because the injection may happen asynchronously, the method returns a future, which is a value representing work that will finish later. If injection succeeds, the future finishes with `Ok(())`. If the host cannot inject the items, it returns `Err(items)`, giving the unchanged items back to the caller so they are not silently lost.

The file also defines `NoopResponseItemInjector`, a fallback injector. “Noop” means “no operation”: it never injects anything. It immediately returns the original items as an error. This is useful for hosts that want to expose the API shape without claiming they can steer the current model turn.

#### Function details

##### `NoopResponseItemInjector::inject_response_items`  (lines 27–32)

```
fn inject_response_items(
        &'a self,
        items: Vec<ResponseInputItem>,
    ) -> ResponseItemInjectionFuture<'a>
```

**Purpose**: This is the fallback implementation used when same-turn model input injection is not available. It deliberately does not change or consume the supplied items; it gives them back to the caller.

**Data flow**: It receives a list of `ResponseInputItem` values from an extension. Instead of injecting them into the active model turn, it immediately packages those same items into an error result. The caller gets a future that is already ready, and when awaited it returns `Err(items)` with the original list intact.

**Call relations**: This method fulfills the `ResponseItemInjector` contract for hosts that do not support this capability. Internally it creates an immediately completed future and pins it into the boxed future shape required by the trait, so callers can treat it the same way as a real asynchronous injector.

*Call graph*: 2 external calls (pin, ready).


### `ext/extension-api/src/capabilities/mod.rs`

`other` · `cross-cutting`

This file does not contain business logic itself. Its job is organization. In a larger project, useful pieces are often split into separate files so each file stays focused. Here, the actual capability definitions live in three sibling modules: one for agent spawning, one for extension events, and one for response item injection.

Think of this file like the front desk of a building. The rooms are elsewhere, but visitors do not need to know every hallway. They can come to this one place and ask for the public items they need.

The `mod` lines tell Rust to include the three internal modules. The `pub use` lines then make selected types available to the outside world through `capabilities`. For example, outside code can refer to `AgentSpawner` or `ExtensionEventSink` without knowing that they are defined in `agent` or `events`.

This matters because it keeps the extension API easier to use and more stable. If the project later reorganizes the internal files, callers may not have to change as long as this public doorway keeps exporting the same names.


### `ext/extension-api/src/lib.rs`

`other` · `cross-cutting API import surface`

This file does not implement extension behavior itself. Instead, it acts like a reception desk for the extension system: callers do not need to know which back room contains capability types, contributor traits, registry builders, shared state, or user-instruction loading. They can come to this single crate root and import the public building blocks they need.

The file declares several internal modules, such as capabilities, contributors, registry, state, and user_instructions. Then it publicly re-exports selected names from those modules and from related crates like codex_tools and codex_protocol. These exported names describe the main ways an extension can participate in the system: adding tools, contributing prompt text, reacting to thread or turn lifecycle events, injecting response items, registering extension data, loading user instructions, and providing tool execution pieces.

Why this matters: without this file, users of the extension API would have to know the internal module layout and import many pieces from many places. That would make the API harder to learn and easier to break if files are reorganized. By keeping a stable public surface here, the project can change internal structure while giving extension authors a simpler, more dependable set of names to use.


### Contributor contracts
These files describe the contributor interfaces and the lifecycle payloads extensions receive while participating in runtime behavior.

### `ext/extension-api/src/contributors/mcp.rs`

`data_model` · `runtime configuration resolution`

This file is a contract between the host application and extensions for MCP server contributions. MCP means Model Context Protocol, a way for the app to connect to outside capabilities through named servers. Without these types, extensions would not have a clear, shared language for saying, “add this server,” “remove that server,” or “use the server from this selected plugin.”

The main context type, `McpServerContributionContext`, is like a sealed envelope handed to extension code while it is deciding what MCP servers to contribute. It contains the host configuration and, when the decision is happening for one running thread, the fixed starting data for that thread. The context only borrows this information, so extensions can read it during contribution but should not keep it afterward.

The second main type, `McpServerContribution`, describes the actual requested change. An extension can set a named server, register a server that came from a selected plugin, or remove a named server. The `SelectedPlugin` case also records plugin identity and ordering, which helps the runtime know where that server came from and how it should fit with other selected plugins.

#### Function details

##### `McpServerContributionContext::clone`  (lines 18–20)

```
fn clone(&self) -> Self
```

**Purpose**: Makes another copy of the context value. This is cheap because the context only contains references to existing data, not owned copies of the configuration itself.

**Data flow**: It starts with an existing context that points to host configuration and maybe thread-start data. It copies those references into a new context value. The underlying configuration and thread data are not changed or duplicated.

**Call relations**: This supports the context being passed around easily during MCP contribution resolution. Because the type is also copyable, cloning is just a convenient way to hand the same read-only view to another piece of code.


##### `McpServerContributionContext::global`  (lines 27–32)

```
fn global(config: &'a C) -> Self
```

**Purpose**: Creates a contribution context for work that is not tied to a specific running thread. Use this when MCP server choices only need the general host configuration.

**Data flow**: It receives a reference to the host configuration. It stores that reference and records that there is no thread-specific initial data. The result is a context that can be given to extension contribution code.

**Call relations**: It is called by `runtime_config_with_context` when the runtime is building MCP configuration in a global situation. Later contribution code can read the configuration through the context, but it will see no thread initialization data.

*Call graph*: called by 1 (runtime_config_with_context).


##### `McpServerContributionContext::for_thread`  (lines 35–40)

```
fn for_thread(config: &'a C, thread_init: &'a ExtensionDataInit) -> Self
```

**Purpose**: Creates a contribution context for one active thread runtime. Use this when extension decisions may depend on the thread's fixed starting inputs.

**Data flow**: It receives the host configuration and the thread's initial data. It stores references to both, wrapping the thread data as present. The result is a context that tells extension code both the general settings and the thread-specific starting state.

**Call relations**: It is called by `runtime_config_with_context` and `selected_plugin_contributions` when MCP configuration is being resolved for a particular thread. The resulting context is then passed along so contributors can inspect both host settings and thread inputs before producing server changes.

*Call graph*: called by 2 (runtime_config_with_context, selected_plugin_contributions).


##### `McpServerContributionContext::config`  (lines 43–45)

```
fn config(&self) -> &'a C
```

**Purpose**: Returns the host configuration visible to the contribution process. Extension code uses this to make choices based on the app's current settings.

**Data flow**: It takes the context as input and reads the stored configuration reference. It returns that same configuration reference without changing anything.

**Call relations**: It is called by `contribute` implementations while they decide what MCP server contributions to return. In the larger flow, the host builds a context first, then contribution code asks this function for the configuration it is allowed to see.

*Call graph*: called by 2 (contribute, contribute).


##### `McpServerContributionContext::thread_init`  (lines 48–50)

```
fn thread_init(&self) -> Option<&'a ExtensionDataInit>
```

**Purpose**: Returns the thread's frozen initial inputs, if this contribution is being resolved for a running thread. If the context is global, it returns nothing.

**Data flow**: It takes the context as input and checks whether thread-start data was stored inside it. It returns that optional reference exactly as-is. It does not create, change, or consume the thread data.

**Call relations**: It is called by `contribute` when an extension needs to know whether thread-specific inputs are available. This lets the same contribution code work in both global and thread-scoped situations: it can use the thread data when present and fall back when absent.

*Call graph*: called by 1 (contribute).


### `ext/extension-api/src/contributors/thread_lifecycle.rs`

`data_model` · `thread lifecycle`

This file is a set of simple input shapes for thread lifecycle events. A “thread” here means a running unit of work inside the host session, and a “runtime” is the environment where extension code for that thread runs. When the host reaches an important moment in that thread’s life, it needs to tell extensions what is happening and what data they may use.

The main idea is separation of scope. Each input includes access to a session store, which is data shared for the whole host session, and a thread store, which is data private to this thread runtime. This is like having one notebook for the whole meeting and another notebook just for one agenda item.

ThreadStartInput carries the richest context because a new thread needs more setup information: the host configuration, where the session came from, whether saved thread state is available, and which execution environments were chosen. The resume, idle, and stop inputs are smaller because they mainly need access to the session and thread stores.

Without these definitions, extension lifecycle hooks would not have a clear, typed contract for what information they can see at each stage. That would make extension behavior harder to write safely and harder for the host to call consistently.


### `ext/extension-api/src/contributors/tool_lifecycle.rs`

`data_model` · `tool execution`

This file is part of the extension API: the public surface that outside add-ons use to cooperate with the host application. Its job is to describe tool lifecycle events, meaning the moments when the host begins running a tool call and when that tool call ends.

A “tool call” is when the model asks the system to do something outside plain text, such as run a command, read data, or call a special capability. Extensions may want to notice these events for logging, metrics, policy checks, or custom bookkeeping. This file defines the small data packets they receive.

It separates three main ideas. First, `ToolCallSource` says where the tool request came from: either directly from the model, or from code mode while running a nested runtime cell. Second, `ToolCallOutcome` describes how the call ended: completed, blocked, failed, or aborted. This matters because not every tool call reaches the actual tool handler; some can be stopped by policy or cancellation first. Third, `ToolStartInput` and `ToolFinishInput` collect the context extensions need, such as session, thread, and turn stores, the turn id, the call id, the tool name, and the source.

The future type, `ToolLifecycleFuture`, lets lifecycle callbacks run asynchronously. In everyday terms, it lets an extension say, “I will finish my reaction later,” without freezing the rest of the system.


### `ext/extension-api/src/contributors/turn_input.rs`

`data_model` · `request handling`

This file is a small data-shape file: it does not run logic itself, but it defines the packages of information passed to turn-input contributors. A “turn” means one round of interaction, such as a user sending a message and the system preparing what the model should receive. Extensions may want to add extra model input based on that turn, but they need context to do that safely and consistently.

The file defines two structs, which are simple named bundles of data. `TurnInputEnvironment` describes one execution environment owned by the host. It includes a stable environment ID, the working directory for that environment, and whether it is the primary one for the turn. This is like giving an assistant a label for each workspace, where it is located, and which workspace is the main desk.

`TurnInputContext` describes the turn as a whole. It includes the stable turn ID, the user input submitted for that turn, and the list of resolved environments in priority order. Together, these types form the contract between the host and extensions: the host provides these facts before it records turn-local model input items, and extensions can use them without needing direct access to the host’s internal state.


### `ext/extension-api/src/contributors/turn_lifecycle.rs`

`data_model` · `turn lifecycle`

A “turn” is one round of work in the host system, such as a user request and the assistant’s response to it. This file does not run any behavior by itself. Instead, it defines the shapes of the information passed into extension hooks at important moments in that turn’s life.

Each struct is like a labeled envelope handed to an extension. `TurnStartInput` includes the host’s stable turn ID, the active collaboration mode, a snapshot of token usage at the start, and three data stores. These stores let extensions read or write state at different lifetimes: the whole session, the current thread, or just this one turn. `TurnStopInput` is simpler because a normal completion mainly needs access to those same stores. `TurnAbortInput` adds the reason the turn was stopped early. `TurnErrorInput` includes both the turn ID and the error information surfaced by the host.

This matters because extensions need a predictable contract. Without these input types, each lifecycle event could pass different or unclear data, making extensions harder to write safely and consistently.


### `ext/extension-api/src/contributors.rs`

`other` · `cross-cutting`

This file is part of the extension API. Its job is to describe how outside features can safely take part in the host’s work without reaching directly into the host’s private internals. In plain terms, it gives extensions a set of agreed-upon doors they may enter through.

The file defines several Rust traits, which are shared promises about behavior. For example, one trait lets an extension add extra prompt text, another lets it provide tools, another lets it react when a conversation thread starts or stops, and another lets it observe when a tool starts or finishes. The host can call these traits at the right moments, and each extension can choose which ones it wants to implement.

A central idea here is controlled access. Instead of handing extensions the whole running system, the host gives them small input objects and extension-owned data stores. That keeps boundaries clear: extensions can keep their own state, but they do not freely mutate core runtime objects.

Many lifecycle methods have default implementations that do nothing. This matters because an extension can implement only the callbacks it cares about. The asynchronous callbacks return a boxed future, meaning “work that may finish later,” so extensions can perform non-blocking setup, cleanup, or observation when needed.

#### Function details

##### `ThreadLifecycleContributor::on_thread_start`  (lines 80–85)

```
fn on_thread_start(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback gives an extension a chance to do setup after a thread-level data store has been created. A “thread” here means a longer-lived conversation runtime, not necessarily an operating-system thread.

**Data flow**: The host provides a thread-start input object, which contains the limited information the extension is allowed to see. The default version ignores both the extension object and the input, then returns an already boxed asynchronous task that completes with no result. Nothing is changed unless an extension overrides this method.

**Call relations**: The host is expected to call this after it has prepared thread-scoped extension storage. The default method only wraps an empty async block using pinning, which keeps the future safely in place while the async runtime polls it.

*Call graph*: 1 external calls (pin).


##### `ThreadLifecycleContributor::on_thread_resume`  (lines 88–93)

```
fn on_thread_resume(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback lets an extension restore or refresh its thread-related state when the host rebuilds a runtime from saved history. The default behavior is to do nothing.

**Data flow**: The host passes in resume information. The default implementation receives that input, deliberately ignores it, and returns a boxed asynchronous task that finishes immediately with no output. No store or runtime state is changed by the default.

**Call relations**: This fits into the thread lifecycle after the host has reconstructed a thread from persisted history. Its only internal handoff is to pin the empty async work so it matches the extension callback shape.

*Call graph*: 1 external calls (pin).


##### `ThreadLifecycleContributor::on_thread_idle`  (lines 100–105)

```
fn on_thread_idle(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback lets an extension react after the host has finished the thread work that was immediately pending. An extension might use an override to request follow-up input, while the host still decides what to do with that request.

**Data flow**: The host supplies idle-time input. The default implementation takes that input, does not inspect it, and returns a boxed asynchronous task that completes without producing anything. By default, no follow-up work is submitted.

**Call relations**: The host calls this when a thread reaches an idle point. The default implementation simply pins an empty async block, so extensions that do not care about idle moments do not need to provide their own code.

*Call graph*: 1 external calls (pin).


##### `ThreadLifecycleContributor::on_thread_stop`  (lines 108–113)

```
fn on_thread_stop(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback gives an extension a chance to clean up before the host drops the thread runtime and thread-scoped extension data. The default behavior is no cleanup.

**Data flow**: The host gives the extension stop-time input. The default implementation ignores the input and returns a boxed asynchronous task that finishes with no result. Nothing is flushed, saved, or modified unless an extension overrides it.

**Call relations**: This belongs at the end of the thread lifecycle, just before thread resources disappear. Internally, the default path only pins an empty async block to satisfy the expected future-returning API.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_start`  (lines 124–129)

```
fn on_turn_start(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback lets an extension prepare state for one turn before that turn begins running. A “turn” is one submitted interaction within a larger conversation thread.

**Data flow**: The host passes turn-start input after creating turn-scoped extension stores. The default implementation ignores the input and returns a boxed asynchronous task that immediately completes. No turn state is added by default.

**Call relations**: The host calls this before the task for a turn starts. The default method hands back a pinned no-op future, so extensions only need to override it when they need turn setup.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_stop`  (lines 132–137)

```
fn on_turn_stop(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback lets an extension observe or clean up after a turn completes, before the host drops that turn’s runtime and store. The default version does nothing.

**Data flow**: The host provides stop information for the finished turn. The default implementation receives it, ignores it, and returns a boxed asynchronous task with no output. No stored data changes unless an extension supplies its own behavior.

**Call relations**: This is called near the end of a turn’s life. Its default work is only to pin an empty async block, keeping the method compatible with asynchronous extension implementations.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_abort`  (lines 140–145)

```
fn on_turn_abort(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback lets an extension react when the host aborts a running turn. It is useful for extensions that need to cancel or clear turn-specific work, though the default does nothing.

**Data flow**: The host passes abort information. The default method ignores the extension object and input, then returns a boxed asynchronous task that completes without a value. It does not cancel anything itself.

**Call relations**: The host calls this after aborting a turn. The default implementation only creates a pinned no-op future, leaving real abort reactions to extensions that override it.

*Call graph*: 1 external calls (pin).


##### `TurnLifecycleContributor::on_turn_error`  (lines 148–153)

```
fn on_turn_error(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()>
```

**Purpose**: This callback lets an extension observe an error that happened during a turn. The default behavior is to ignore the error information.

**Data flow**: The host provides turn-error input. The default method accepts it, does not inspect it, and returns a boxed asynchronous task that finishes with no result. It records no diagnostics and changes no state by itself.

**Call relations**: The host calls this when it sees an error for a running turn. The only internal call is pinning the empty async work so the method has the same shape as real asynchronous handlers.

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

**Purpose**: This callback lets an extension respond after the host has committed a new thread configuration. The default implementation ignores the change.

**Data flow**: The host passes the session store, thread store, previous configuration, and new configuration. The default method takes those values by reference and does nothing with them. It returns immediately and does not modify any state.

**Call relations**: The host calls this after a configuration change is already committed, so extensions see before-and-after snapshots rather than controlling the change. Unlike many other callbacks in this file, the default method is synchronous and does not create a future.


##### `TokenUsageContributor::on_token_usage`  (lines 196–207)

```
fn on_token_usage(
        &'a self,
        _session_store: &'a ExtensionData,
        _thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
        _token_usage: &'a TokenUsageIn
```

**Purpose**: This callback lets an extension observe token usage reported by the model provider. Tokens are the chunks of text a language model counts for cost and context length.

**Data flow**: The host provides session, thread, and turn stores, plus the token-usage record. The default implementation bundles those references only to mark them as intentionally unused, then returns a boxed asynchronous task that completes with no result. It does not store or report anything by default.

**Call relations**: The host calls this after updating its cached token usage and before notifying the client about token counts. The default implementation pins a no-op async block, so extensions can ignore token accounting unless they opt in.

*Call graph*: 1 external calls (pin).


##### `ToolLifecycleContributor::on_tool_start`  (lines 227–229)

```
fn on_tool_start(&'a self, _input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a>
```

**Purpose**: This callback lets an extension observe that the host has accepted a tool call for execution. It is for observation or policy around the lifecycle, not for owning the tool itself.

**Data flow**: The host passes information about the tool start. The default implementation ignores that input and returns a ready-made future that is already complete. Nothing is inspected or changed.

**Call relations**: The host calls this once a tool call has been accepted. The default path creates an immediately ready no-op future and pins it, so the host can await it the same way it would await a real extension hook.

*Call graph*: 2 external calls (pin, ready).


##### `ToolLifecycleContributor::on_tool_finish`  (lines 232–234)

```
fn on_tool_finish(&'a self, _input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a>
```

**Purpose**: This callback lets an extension observe the end of a tool call, whether it succeeded, failed, was blocked, or was cancelled. The default behavior is to do nothing.

**Data flow**: The host provides information about the finished tool call. The default implementation ignores the input and returns a pinned future that is already complete. It produces no result and changes no state.

**Call relations**: The host calls this after a tool call reaches an outcome. The method hands back an immediately ready no-op future, so extensions that do not need tool-finish observation can rely on the default.

*Call graph*: 2 external calls (pin, ready).


### Extension runtime support types
These files provide stable supporting contracts for extension state, host-supplied instructions, and extension-driven event emission.

### `ext/extension-api/src/state.rs`

`data_model` · `cross-cutting extension state access`

Extensions often need a place to remember extra information about something the main program owns, such as a session, level, thread, or other scoped object. This file supplies that place. Think of it like a labeled drawer attached to each host object: each kind of value gets one drawer, and code asks for it by its Rust type rather than by a string name.

There are two main pieces. `ExtensionDataInit` is a pre-filled set of values prepared before the real extension data scope exists. It is useful when the host wants to seed the scope with known inputs. `ExtensionData` is the live storage attached to one host object. It records the host object's identity as `level_id`, and it keeps a map from each value's type to the stored value.

Stored values are wrapped in `Arc`, which is a shared ownership pointer, so callers can keep using a value even after retrieving it. The live map is protected by a `Mutex`, a lock that stops two tasks from changing the map at the same time. If a previous holder panicked while holding the lock, the code still recovers the stored map instead of giving up.

The important safety idea is that callers only get back the type they asked for. Internally the file stores values in an erased form, meaning the exact type is hidden, and then restores the type when reading it back.

#### Function details

##### `ExtensionDataInit::new`  (lines 23–25)

```
fn new() -> Self
```

**Purpose**: Creates an empty starter pack of extension data. A host uses this when it wants to prepare initial values before creating the live `ExtensionData` scope.

**Data flow**: Nothing goes in. The function makes a default, empty `ExtensionDataInit` with no stored attachments. The result is a blank initializer that other code can fill with typed values.

**Call relations**: This is called when code starts building extension state, such as during thread startup or plugin contribution selection. It delegates to the type's default constructor, so the larger flow gets a clean container without needing to know how the container is built.

*Call graph*: called by 2 (thread_start_task, selected_plugin_contributions); 1 external calls (default).


##### `ExtensionDataInit::insert`  (lines 28–35)

```
fn insert(&mut self, value: T) -> Option<Arc<T>>
```

**Purpose**: Adds one initial value to an `ExtensionDataInit`, keyed by the value's Rust type. If a value of the same type was already present, it returns the old one.

**Data flow**: A typed value goes in. The function wraps it in an `Arc`, which allows shared ownership, then stores it under that value's type identity. The initializer is changed, and the previous value of that same type comes out if there was one.

**Call relations**: This is used when seeding thread state before the live extension data exists. It uses `Arc::new` to prepare the stored value in the same shared form that the rest of this file expects.

*Call graph*: called by 1 (seed_thread_state); 1 external calls (new).


##### `ExtensionDataInit::get`  (lines 38–44)

```
fn get(&self) -> Option<Arc<T>>
```

**Purpose**: Reads a host-supplied initial value without creating or touching a live mutable extension scope. This is useful when setup code needs to inspect the seeded data directly.

**Data flow**: The caller asks for a particular type. The function looks in the initializer's map for that type, clones the shared `Arc` pointer if found, and converts the erased stored value back into the requested type. The output is either the shared typed value or nothing.

**Call relations**: This is a direct read path for initial data. It hands the erased stored value to `downcast_data`, which performs the final step of turning the hidden value back into the requested concrete type.

*Call graph*: calls 1 internal fn (downcast_data).


##### `ExtensionData::new`  (lines 56–58)

```
fn new(level_id: impl Into<String>) -> Self
```

**Purpose**: Creates an empty live extension data store for one host object. Callers use it when there is no pre-seeded data to carry in.

**Data flow**: A host identity, called `level_id`, goes in. The function creates a default empty `ExtensionDataInit`, then passes both the identity and the empty initializer into `ExtensionData::new_with_init`. The result is a live `ExtensionData` with an empty attachment map.

**Call relations**: This is the common entry point used throughout the project when sessions, threads, test contexts, or other host-owned scopes need extension storage. It keeps the simple case small by reusing `ExtensionData::new_with_init` for the actual construction.

*Call graph*: called by 38 (spawn_review_thread, new, handle_output_item_done_records_image_save_history_message, handle_output_item_done_skips_image_save_message_when_save_fails, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, tool_calls_reopen_mailbox_delivery_for_current_turn, make_turn_context, plan_mode_uses_contributed_turn_item_for_last_agent_message, finalized_turn_item_defers_mailbox_for_contributed_visible_text (+15 more)); 2 external calls (new_with_init, default).


##### `ExtensionData::new_with_init`  (lines 61–66)

```
fn new_with_init(level_id: impl Into<String>, init: ExtensionDataInit) -> Self
```

**Purpose**: Creates a live extension data store and fills it with initial host-supplied values. This is the bridge from setup-time data to runtime extension state.

**Data flow**: A host identity and an `ExtensionDataInit` go in. The identity is converted into a `String`, and the initializer's stored entries are moved into a mutex-protected map. The output is an `ExtensionData` ready for concurrent reads and writes.

**Call relations**: This function is called by `ExtensionData::new` and is the central constructor for live storage. It takes the prepared initializer and turns it into the locked map used by later `get`, `insert`, `remove`, and `get_or_init` calls.

*Call graph*: called by 1 (new); 2 external calls (into, new).


##### `ExtensionData::level_id`  (lines 69–71)

```
fn level_id(&self) -> &str
```

**Purpose**: Returns the host identity for the object this extension data is attached to. Extensions can use this to know which scope they are contributing to.

**Data flow**: The function reads the `level_id` string stored inside `ExtensionData`. It does not change anything. It returns a borrowed string slice pointing to that identity.

**Call relations**: This is called during extension contribution and token usage flows when extension code needs the host object's identity. It is a simple read-only accessor and does not touch the attachment map.

*Call graph*: called by 3 (contribute, on_token_usage, contribute).


##### `ExtensionData::get`  (lines 74–80)

```
fn get(&self) -> Option<Arc<T>>
```

**Purpose**: Looks up the attached value for a requested type. It lets extension code retrieve its saved state without knowing about other extensions' stored values.

**Data flow**: The caller asks for type `T`. The function locks the entries map, searches for the type identity for `T`, clones the shared pointer if found, and converts the erased value back to `Arc<T>`. The result is either that typed shared value or nothing.

**Call relations**: This is one of the main runtime read paths. It uses `ExtensionData::entries` to safely lock the map, then uses `downcast_data` to restore the hidden stored value to the requested type.

*Call graph*: calls 2 internal fn (entries, downcast_data).


##### `ExtensionData::get_or_init`  (lines 86–95)

```
fn get_or_init(&self, init: impl FnOnce() -> T) -> Arc<T>
```

**Purpose**: Gets an attached value if it already exists, or creates and stores it if it does not. This is useful for lazy setup, where an extension only pays to create state when it first needs it.

**Data flow**: The caller provides a small initializer function that can make a value of type `T`. The function locks the map, checks whether a value of that type already exists, and if not runs the initializer and stores the new value in an `Arc`. It returns the shared typed value either way.

**Call relations**: This function combines the read and create paths into one locked operation, so two callers do not accidentally create two separate values for the same type at the same time. It uses `ExtensionData::entries` for locking and `downcast_data` before returning the typed value.

*Call graph*: calls 2 internal fn (entries, downcast_data); 1 external calls (clone).


##### `ExtensionData::insert`  (lines 98–105)

```
fn insert(&self, value: T) -> Option<Arc<T>>
```

**Purpose**: Stores or replaces the attached value for a particular type in live extension data. It returns the previous value of that type if one was already stored.

**Data flow**: A typed value goes in. The function locks the entries map, wraps the new value in an `Arc`, and stores it under its type identity. The map is changed, and any old value for the same type is returned after being converted back to the requested type.

**Call relations**: This is used by extension contribution and configuration-change paths to place new state into the live scope. It relies on `ExtensionData::entries` to safely access the shared map and `Arc::new` to store the value in shareable form.

*Call graph*: calls 1 internal fn (entries); called by 8 (contribute, contribute, on_config_changed, on_config_changed, on_config_changed, contribute, on_config_changed, on_config_changed); 1 external calls (new).


##### `ExtensionData::remove`  (lines 108–113)

```
fn remove(&self) -> Option<Arc<T>>
```

**Purpose**: Deletes the attached value for a requested type and returns it if it existed. This gives callers a way to take state out of the extension data store.

**Data flow**: The caller asks to remove type `T`. The function locks the map and removes the entry keyed by that type identity. The map loses that attachment, and the removed shared value is returned if there was one.

**Call relations**: This is the cleanup or take-back path that pairs with insertion. It uses `ExtensionData::entries` to lock the map before changing it, but unlike reads it does not call `downcast_data` directly in the listed call graph.

*Call graph*: calls 1 internal fn (entries).


##### `ExtensionData::entries`  (lines 115–117)

```
fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<TypeId, ErasedData>>
```

**Purpose**: Safely opens the internal attachment map for reading or writing. It hides the locking detail from the public methods.

**Data flow**: The function reads the mutex inside `ExtensionData` and tries to lock it. If the lock is normal, it returns access to the map. If the lock was poisoned because another thread panicked while holding it, it still takes back the inner map and returns access.

**Call relations**: This private helper is used by `get`, `get_or_init`, `insert`, and `remove` whenever they need the map. It centralizes the lock behavior so all map operations recover from a poisoned mutex in the same way.

*Call graph*: called by 4 (get, get_or_init, insert, remove).


##### `downcast_data`  (lines 120–128)

```
fn downcast_data(value: ErasedData) -> Arc<T>
```

**Purpose**: Turns a stored, type-erased value back into the concrete type the caller asked for. It is the final step that makes the typed storage feel type-safe to callers.

**Data flow**: An `Arc` holding a hidden `Any` value goes in. The function attempts to convert it into `Arc<T>`, where `T` is the requested type. If the map was used correctly, the conversion succeeds and the typed shared value comes out; if not, the code marks that situation as unreachable because it would mean the internal type map was corrupted.

**Call relations**: This helper is called by read paths in `ExtensionDataInit::get`, `ExtensionData::get`, and `ExtensionData::get_or_init`. Those functions find the value by type identity first, then hand it here to restore the concrete type before giving it to the caller.

*Call graph*: called by 3 (get, get_or_init, get); 1 external calls (unreachable!).


### `ext/extension-api/src/user_instructions.rs`

`data_model` · `startup`

This file is like a small agreement between the host application and the runtime. The runtime may need extra user-provided instruction text before it starts working, but it should not need to know exactly where that text came from or how it was loaded. This file defines the pieces used for that handoff.

`UserInstructions` holds the actual instruction text that the model can see, plus the filesystem path it came from. That path must be absolute, meaning it starts from the root of the filesystem, so other parts of the app can clearly report the instruction source without guessing.

`LoadedUserInstructions` wraps the result of trying to load those instructions. Sometimes there are instructions, and sometimes there are none. It also carries warnings for recoverable problems, such as a source being missing or partly unreadable, so startup can continue while still telling the user what went wrong.

The file also defines `UserInstructionsProvider`, a trait, which is Rust’s way of saying “anything that implements this promises to provide this behavior.” In this case, the behavior is loading a snapshot of user instructions asynchronously, meaning the work may finish later rather than immediately. Without this file, different parts of the system would not have a shared, reliable way to ask for host-provided instructions at startup.


### `ext/goal/src/events.rs`

`io_transport` · `request handling`

When the goal for a conversation thread changes, other parts of the system need to hear about it. This file is the messenger for that job. It defines `GoalEventEmitter`, a lightweight object that holds an event sink, which is the place where outgoing extension events are sent.

The important idea is separation: the goal logic can decide that a goal changed, but it should not need to know the exact protocol wrapper used to publish that news. `GoalEventEmitter` hides that packaging step. Callers give it an event id, an optional turn id, and the updated `ThreadGoal`. The emitter builds a protocol `Event` whose message says, in effect, “this thread goal was updated,” then sends it through the shared sink.

The sink is stored in an `Arc`, which is a thread-safe shared pointer. In plain terms, it lets multiple parts of the program hold the same outgoing event channel without copying or owning it exclusively. Without this file, goal-related code would have to repeat the event-building details itself, making it easier to send inconsistent or malformed goal update messages.

#### Function details

##### `GoalEventEmitter::new`  (lines 15–17)

```
fn new(sink: Arc<dyn ExtensionEventSink>) -> Self
```

**Purpose**: Creates a `GoalEventEmitter` from an existing event sink. This gives goal-related code a simple object it can use later to publish goal update events.

**Data flow**: It receives a shared event sink as input. It stores that sink inside a new `GoalEventEmitter`. The result is an emitter object that can be cloned and used to send events through the same underlying sink.

**Call relations**: This is called by `new_with_host_capabilities` during setup, when the extension is being wired to the host system. It does not send anything itself; it prepares the messenger that later goal code will use.

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

**Purpose**: Publishes a “thread goal updated” event. Callers use it when they have a new or changed goal and need the rest of the extension system to be notified in the standard protocol format.

**Data flow**: It receives an event id, an optional turn id, and the updated `ThreadGoal`. It converts the event id into a string, takes the thread id from the goal, wraps all of this into a `ThreadGoalUpdatedEvent`, then wraps that into a general protocol `Event`. Finally, it sends the event to the stored sink. Nothing is returned; the visible effect is that an event is emitted.

**Call relations**: This is called when goal progress is updated by `account_active_goal_progress` or when a tool call produces a goal update through `emit_goal_updated_from_tool_call`. It hands the finished protocol event to the event sink, which is responsible for delivering it onward to the host or other listeners.

*Call graph*: called by 2 (account_active_goal_progress, emit_goal_updated_from_tool_call); 2 external calls (into, ThreadGoalUpdated).


### Adjacent extension-facing schemas
These files define other stable extension-consumed boundaries for memories storage and IDE context payloads.

### `ext/memories/src/backend.rs`

`data_model` · `request handling`

This file is like a service counter form set for the memories feature. It does not itself read files or search text. Instead, it says exactly what any memory storage backend must be able to do: add a quick note, list stored memory items, read a memory file, and search through memories. That common interface is the `MemoriesBackend` trait. A local filesystem backend can implement it now, and a future remote backend can implement the same promises without forcing callers to change.

The rest of the file defines the plain data that moves across this boundary. Request structs describe what the caller wants, such as which path to read, how many lines to return, or what search queries to use. Response structs describe what comes back, such as directory entries, file content, search matches, pagination cursors, and whether the result was cut short. These response types are serializable, meaning they can be turned into formats like JSON for tool or API output.

It also defines `MemoriesBackendError`, the shared list of things that can go wrong: bad filenames, unsafe paths, invalid cursors, missing files, empty searches, and input/output failures. Having one clear error language matters because callers can give useful feedback instead of guessing what failed.

#### Function details

##### `MemoriesBackendError::invalid_filename`  (lines 166–171)

```
fn invalid_filename(filename: impl Into<String>, reason: impl Into<String>) -> Self
```

**Purpose**: This is a small convenience function for creating a clear “invalid filename” error. Code that checks a proposed note filename uses it when the name is not allowed and needs to explain why.

**Data flow**: It receives a filename and a reason, accepting values that can be converted into strings. It turns both into owned text and packages them into the `InvalidFilename` error variant. The result is an error value that can be returned to the caller with both the bad filename and the human-readable reason included.

**Call relations**: Filename validation code calls this after deciding that a filename is unsafe or unacceptable. This function does not do the validation itself; it standardizes the error that validation returns, so the rest of the memories feature reports filename problems in one consistent shape.

*Call graph*: called by 1 (validate_filename); 1 external calls (into).


##### `MemoriesBackendError::invalid_path`  (lines 173–178)

```
fn invalid_path(path: impl Into<String>, reason: impl Into<String>) -> Self
```

**Purpose**: This creates a clear “invalid path” error when a memory path is not acceptable. It is used for path problems such as paths outside the allowed memory store, paths that are not directories when they should be, or unsafe symbolic links.

**Data flow**: It receives a path and a reason, converts both into strings, and builds the `InvalidPath` error variant. The output is an error value carrying the exact path that was rejected and the explanation for rejecting it.

**Call relations**: Path-related checks call this while resolving scoped paths, confirming directories, or rejecting symbolic links. In the larger flow, those checks protect the memory store boundary before any file listing, reading, or searching continues.

*Call graph*: called by 3 (resolve_scoped_path, ensure_directory, reject_symlink); 1 external calls (into).


##### `MemoriesBackendError::invalid_cursor`  (lines 180–185)

```
fn invalid_cursor(cursor: impl Into<String>, reason: impl Into<String>) -> Self
```

**Purpose**: This creates a clear error for a bad pagination cursor. A cursor is a marker used to continue a long list or search from where the previous response stopped.

**Data flow**: It takes the cursor text and a reason, converts them into strings, and returns the `InvalidCursor` error variant. The caller receives an error that says which cursor was rejected and why it could not be used.

**Call relations**: The list and search flows call this when a supplied cursor cannot be understood or trusted. That keeps paginated results safe and predictable: instead of continuing from a broken marker, the backend stops and reports the cursor problem directly.

*Call graph*: called by 2 (list, search); 1 external calls (into).


### `tui/src/ide_context.rs`

`data_model` · `request handling`

This file is the front door for TUI support for `/ide`, where the terminal app can use information from a connected code editor. In human terms, it lets the TUI ask, “What file is the user looking at, what tabs are open, and what text is selected?” Without this shared shape, the app and the editor could disagree about what the incoming data means, and `/ide` prompts would be unreliable.

The main type is `IdeContext`. It can contain one active file and a list of open tabs. The active file includes a simple file description, the current selection range, the selected text, and any extra selections. A range is made from two positions, and each position is just a line and character number. This is like a bookmark system: the editor sends bookmarks and labels, and the TUI turns them into useful context for the user’s request.

The file also re-exports helper functions from nearby modules. Those helpers do the practical work: fetching the IDE context, detecting whether a prompt asks for IDE context, extracting prompt details, and applying IDE context to user input. The data structures here are deliberately tolerant of extra fields from the editor, so the test confirms that real-world editor data can include more information than the TUI needs without breaking parsing.

#### Function details

##### `tests::deserializes_existing_ide_context_shape`  (lines 61–116)

```
fn deserializes_existing_ide_context_shape()
```

**Purpose**: This test checks that the TUI can read the existing IDE context format sent by an editor. It protects against accidental changes that would make real editor data stop loading correctly.

**Data flow**: It starts with a sample JSON object that looks like editor-provided context, including an active file, open tabs, and extra fields the TUI does not use. It feeds that JSON into Serde, Rust’s data-conversion library, to build an `IdeContext`. It then compares the parsed result with the exact simplified structure the TUI expects, proving that needed fields are kept and irrelevant extra fields are safely ignored.

**Call relations**: During the test run, this function builds sample data with `json!`, asks `from_value` to convert that data into the file’s `IdeContext` model, and then uses `assert_eq!` to verify the result. It is not part of the normal TUI flow; it acts as a safety check for the data contract used by the `/ide` feature.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


### Hook public contracts
These files establish the public hook subsystem surface, including execution abstractions, declarations, and event namespace organization.

### `hooks/src/declarations.rs`

`domain_logic` · `plugin load / hook discovery`

Plugins can bundle hook handlers: small pieces of behavior that run when certain events happen, such as before a tool is used or when a session starts. This file provides a lightweight catalog of those handlers. It does not execute hooks, check match rules, or inspect live runtime state. Instead, it reads the hook definitions that came from plugin bundles and produces one plain record per declared handler.

The main record is `PluginHookDeclaration`. It stores two things: a `key`, which is a stable text identifier for one specific handler, and an `event_name`, which says which kind of event that handler belongs to. The key is built from the plugin id, the hook file path inside the plugin, the event name, the matcher group number, and the handler number. In everyday terms, it is like a shelf label in a warehouse: it lets the system point to one exact hook even if many hooks live in the same plugin file.

The important behavior is that this file preserves the same key format used elsewhere. That matters because saved state, logs, or user-facing references may rely on these keys staying consistent. Without this file, the system would have no simple way to list plugin-provided hook handlers before actually using them.

#### Function details

##### `plugin_hook_declarations`  (lines 12–33)

```
fn plugin_hook_declarations(hook_sources: &[PluginHookSource]) -> Vec<PluginHookDeclaration>
```

**Purpose**: Builds a flat list of hook declarations from plugin hook sources. Someone would use this when they need to know which hook handlers a set of plugins provides, without running those handlers.

**Data flow**: It receives a list of `PluginHookSource` values, where each source describes one plugin hook file and the hooks declared inside it. For each source, it first builds a base key from the plugin id and the hook file's path inside the plugin. Then it walks through each event, each matcher group under that event, and each handler in the group. For every handler it creates a `PluginHookDeclaration` containing a stable key and the event name. The output is a vector, meaning an ordered list, of these declarations; the input hook sources are only read.

**Call relations**: This function calls `plugin_hook_key_source` to create the plugin-and-file part of each key, then passes that into the wider `hook_key` helper to make the final per-handler key. In this file it is exercised by the test `tests::lists_declared_plugin_handlers_with_persisted_hook_keys`, which checks that the produced keys match the expected persisted format.

*Call graph*: calls 1 internal fn (plugin_hook_key_source); called by 1 (lists_declared_plugin_handlers_with_persisted_hook_keys); 2 external calls (new, hook_key).


##### `plugin_hook_key_source`  (lines 35–37)

```
fn plugin_hook_key_source(plugin_id: &str, source_relative_path: &str) -> String
```

**Purpose**: Combines a plugin id and a hook file path into the shared starting text used for plugin hook keys. This keeps key construction consistent wherever plugin hook sources need to be named.

**Data flow**: It receives two pieces of text: the plugin id and the hook file path relative to that plugin. It joins them with a colon between them. The result is a single string such as `demo@test:hooks/hooks.json`, which can then be extended with event and handler details.

**Call relations**: It is called by `plugin_hook_declarations` when listing plugin hook declarations. It is also called by `append_plugin_hook_sources` elsewhere in the system, which means this small formatting rule is shared between hook discovery and other plugin hook setup work.

*Call graph*: called by 2 (plugin_hook_declarations, append_plugin_hook_sources); 1 external calls (format!).


##### `tests::lists_declared_plugin_handlers_with_persisted_hook_keys`  (lines 52–100)

```
fn lists_declared_plugin_handlers_with_persisted_hook_keys()
```

**Purpose**: Checks that plugin hook declarations are listed in the expected order and with the expected stable keys. This protects the key format from accidental changes.

**Data flow**: The test builds a fake plugin root path and a fake plugin hook source. That source declares two handlers for the `pre_tool_use` event and one handler for the `session_start` event. It sends this source into `plugin_hook_declarations`, then compares the returned list against the exact declarations it expects. If the keys or event names differ, the test fails.

**Call relations**: This test calls `plugin_hook_declarations` as a user of the file would. It also uses helper constructors such as plugin id parsing, default hook configuration values, test path creation, and an equality assertion to set up the example and verify the result.

*Call graph*: calls 2 internal fn (plugin_hook_declarations, parse); 4 external calls (default, assert_eq!, test_path_buf, vec!).


### `hooks/src/events/mod.rs`

`other` · `cross-cutting`

This file does not contain event behavior itself. Instead, it organizes the different kinds of events that the hooks system understands, such as a session starting, a user submitting a prompt, a tool being used, or the system stopping. Think of it like the index page at the front of a folder: it points to the real sections without rewriting their contents.

The line `pub(crate) mod common` makes shared event code available inside this crate only. In plain terms, that means other files in the same Rust package can use it, but outside packages cannot. The other `pub mod ...` lines expose specific event modules more broadly, so code outside this module can refer to them.

Without this file, Rust would not know to include these event files as part of the `events` module. Other code would either fail to compile or would have no clean place to find the definitions for hook events. Its main importance is structure: it gives the event system a clear, named layout.


### `hooks/src/types.rs`

`data_model` · `cross-cutting during hook registration, hook execution, and hook payload serialization`

A hook is a small piece of code that runs at a specific moment, like a notification bell that rings after the agent finishes a turn. This file gives the rest of the project a common vocabulary for that system. It defines a hook function as an asynchronous function, meaning it may do work that finishes later, such as calling another service or writing to disk. It defines the possible outcomes too: the hook can succeed, fail but let the main operation continue, or fail and ask the main operation to stop.

The file also defines the package of information sent to a hook. That package includes the session ID, the current working directory, an optional client name, the time the hook was triggered, and the specific event that happened. Right now the event type shown here is “after agent,” which includes details such as the thread ID, turn ID, user input messages, and the last assistant message.

One important detail is serialization, which means turning Rust data into a stable JSON shape. The custom timestamp serializer writes times in a predictable format like `2025-01-01T00:00:00Z`. The test at the bottom protects that public shape so outside tools depending on this hook data do not break unexpectedly.

#### Function details

##### `HookResult::should_abort_operation`  (lines 27–29)

```
fn should_abort_operation(&self) -> bool
```

**Purpose**: This answers the simple question: did this hook failure mean the main operation should stop? It is used to distinguish a serious hook failure from one that can be reported while continuing.

**Data flow**: It reads one `HookResult` value. If that value is the aborting failure variant, it returns `true`; for success or a non-aborting failure, it returns `false`. It does not change anything.

**Call relations**: After a hook has run and produced a result, surrounding hook-running code can call this method to decide whether to keep going or stop the larger operation. Internally it only checks which kind of result it was given.

*Call graph*: 1 external calls (matches!).


##### `Hook::default`  (lines 45–50)

```
fn default() -> Self
```

**Purpose**: This creates a safe fallback hook. The default hook is named `default` and always succeeds without doing any real work.

**Data flow**: It takes no input. It builds a new `Hook` with a default name and a shared function pointer wrapped in `Arc`, which is Rust’s thread-safe shared ownership container. The function ignores its payload and returns `HookResult::Success`.

**Call relations**: This is used when code needs a placeholder hook value. It creates the hook function using a shared wrapper so the hook can be cloned and used safely wherever hook definitions are passed around.

*Call graph*: 1 external calls (new).


##### `Hook::execute`  (lines 54–59)

```
async fn execute(&self, payload: &HookPayload) -> HookResponse
```

**Purpose**: This runs one hook with a given payload and wraps the outcome together with the hook’s name. That makes later reporting easier because the caller can tell which hook produced which result.

**Data flow**: It receives a `Hook` and a `HookPayload`. It calls the hook’s stored asynchronous function with that payload and waits for it to finish. It returns a `HookResponse` containing the hook name and the success or failure result.

**Call relations**: Hook-running code calls this when it is time to fire a registered hook. This method hands the payload to the hook function, waits for the hook’s answer, and packages that answer for the caller to inspect or log.


##### `serialize_triggered_at`  (lines 83–88)

```
fn serialize_triggered_at(value: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: This writes the hook trigger time into JSON in a stable, human-readable format. It avoids small formatting differences that could confuse tools reading hook events.

**Data flow**: It receives a UTC timestamp and a serializer, which is the helper responsible for writing data into the output format. It converts the timestamp to an RFC 3339 string with whole seconds, such as `2025-01-01T00:00:00Z`, then asks the serializer to write that string. The result is either successful serialized output or a serialization error.

**Call relations**: Serde, the Rust serialization library, calls this automatically when `HookPayload` is turned into JSON because the `triggered_at` field points to it. It relies on the time library to format the date and on the serializer to write the final string.

*Call graph*: 2 external calls (to_rfc3339_opts, serialize_str).


##### `tests::hook_payload_serializes_stable_wire_shape`  (lines 114–151)

```
fn hook_payload_serializes_stable_wire_shape()
```

**Purpose**: This test makes sure a hook payload turns into the exact JSON shape expected by outside consumers. It protects the hook interface from accidental breaking changes.

**Data flow**: It creates sample IDs, a sample `/tmp` working directory, a fixed timestamp, and an `AfterAgent` hook event. It serializes that payload into JSON, builds the JSON it expects by hand, and compares the two. If the actual JSON differs, the test fails.

**Call relations**: This test exercises the serialization rules defined in this file, including the custom timestamp formatting and the event tagging. It calls helper constructors for IDs and paths, uses JSON-building helpers to describe the expected output, and finishes by asserting that the real and expected values match.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, test_path_buf, json!, to_value, vec!).


### `hooks/src/lib.rs`

`other` · `cross-cutting`

Hooks are user- or plugin-defined actions that Codex can run at important moments, such as before a tool is used, after compaction, when a session starts, or when the agent stops. This file acts like the library’s reception desk: it does not contain most of the hook machinery itself, but it points callers to the right pieces and exposes the names they are meant to use.

At the top, it declares the internal modules that make up the hook system, such as event definitions, configuration rules, the execution engine, and the registry of configured hooks. It then re-exports the main public items from those modules. Re-exporting means other code can import these items from this one file’s crate path instead of reaching into each internal module directly.

The two event-name lists are important for configuration and validation. One list names every hook event that can appear in hook JSON or config files. The second list names only the events where a matcher field is meaningful. A matcher is a rule used to decide whether a hook applies to a particular tool, compaction trigger, or session-start source.

Finally, the file provides small helpers for building stable stored keys for hook state. Those keys need consistent event labels, because changing them would make saved hook state hard to find later.

#### Function details

##### `hook_event_key_label`  (lines 84–97)

```
fn hook_event_key_label(event_name: HookEventName) -> &'static str
```

**Purpose**: Converts a hook event name into the exact lowercase label used when saving hook state. This keeps stored keys stable and consistent, instead of letting each caller invent its own spelling.

**Data flow**: It receives a HookEventName value, such as PreToolUse or SessionStart. It matches that value to a fixed text label like "pre_tool_use" or "session_start". It returns that label as static text and does not change anything else.

**Call relations**: This helper is used when code needs the storage-friendly name for a hook event. In this file, hook_key relies on it so the full saved-state key always uses the same event label format.


##### `hook_key`  (lines 100–110)

```
fn hook_key(
    key_source: &str,
    event_name: HookEventName,
    group_index: usize,
    handler_index: usize,
) -> String
```

**Purpose**: Builds the full saved-state key for one discovered hook handler. The key combines where the hook came from, which event it belongs to, and its position in the hook configuration.

**Data flow**: It receives a source label, a hook event name, a group number, and a handler number. It asks hook_event_key_label to turn the event into its stored label, then formats all the pieces into one string shaped like source:event:group:handler. It returns that string and does not modify outside state.

**Call relations**: This function sits just above hook_event_key_label: callers use hook_key when they need the complete persisted key, and hook_key delegates the event-name part to hook_event_key_label. Its only external work is string formatting.

*Call graph*: 1 external calls (format!).


### Hook wire schemas
These files define the serialized hook command shapes and the loader that exposes their generated JSON Schemas to the engine.

### `hooks/src/schema.rs`

`data_model` · `schema generation, hook input/output validation, and tests`

Hooks are small outside commands that can be run at important moments, such as before a tool is used, after a tool finishes, when a session starts, or when a subagent stops. This file acts like the printed form for those conversations: it names every field, says which values are allowed, and marks which fields may be missing or null. Without it, hook inputs and outputs could drift apart, and a hook might send data the rest of the system does not understand.

Most of the file is made of Rust structs and enums that also know how to become JSON and JSON Schema. JSON Schema is a machine-readable description of JSON, like a checklist that says “this must be a string” or “this field can only be one of these words.” The file includes shared output fields, event-specific input and output types, allowed event names, permission decisions, and subagent context.

The second job of the file is schema generation. `write_schema_fixtures` creates a clean generated schema folder and writes one schema file per hook input or output. Helper functions force stable ordering in the generated JSON so tests and version control do not change just because map keys came out in a different order. The tests then compare generated schemas against checked-in fixtures and verify important contract details, such as required turn IDs and optional subagent fields.

#### Function details

##### `NullableString::from_path`  (lines 44–46)

```
fn from_path(path: Option<PathBuf>) -> Self
```

**Purpose**: Turns an optional file path into a `NullableString`, which serializes as either a path string or JSON null. This is useful for hook fields such as transcript paths, where the path may not always exist.

**Data flow**: It receives either a path or no path. If a path is present, it converts the path to the text a user would normally see; if not, it keeps the value empty. The result is a wrapper that later becomes a JSON string or null.

**Call relations**: Hook input builders call this when preparing command JSON for hooks. `SessionStartCommandInput::new` also uses it so session-start hook input always has the same nullable path format as the other hook inputs.

*Call graph*: called by 10 (post_command_input_json, pre_command_input_json, build_command_input, command_input_json, command_input_json, run, run, run, new, subagent_context_fields_serialize_flat_and_omit_when_absent).


##### `NullableString::from_string`  (lines 48–50)

```
fn from_string(value: Option<String>) -> Self
```

**Purpose**: Wraps an optional plain string so it can be sent as either a string or JSON null. It is used when the original value is already text rather than a file path.

**Data flow**: It receives either some text or nothing. It stores that value unchanged inside `NullableString`, which later controls how the value is written to JSON.

**Call relations**: Runtime hook code calls this when building inputs that contain optional text, such as an assistant message that may or may not be available.

*Call graph*: called by 1 (run).


##### `NullableString::schema_name`  (lines 54–56)

```
fn schema_name() -> String
```

**Purpose**: Gives the schema generator a clear name for the custom nullable string type. This makes generated schemas easier to read and refer to.

**Data flow**: It takes no runtime input. It returns the fixed name `NullableString` for use in generated schema definitions.

**Call relations**: This is part of the `JsonSchema` implementation for `NullableString`, so the schema generation library calls it when describing fields that use this type.


##### `NullableString::json_schema`  (lines 58–63)

```
fn json_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Describes `NullableString` to the JSON Schema generator as a value that may be either a string or null. This keeps generated hook schemas honest about fields that can be absent in meaning but still present as null.

**Data flow**: It receives a schema generator object, though it does not need to read anything from it. It builds and returns a schema object whose allowed JSON types are string and null.

**Call relations**: The schema generation library calls this while building schemas for hook inputs. It relies on the local `default_continue` only indirectly through shared defaults elsewhere, and here it creates the schema object directly.

*Call graph*: 3 external calls (default, Object, vec!).


##### `SubagentCommandInputFields::from`  (lines 73–81)

```
fn from(value: Option<&SubagentHookContext>) -> Self
```

**Purpose**: Extracts optional subagent identity fields from a subagent context. It lets hooks know when they are running inside a subagent, while keeping those fields absent for normal top-level hooks.

**Data flow**: It receives either a subagent context or no context. With a context, it copies the agent ID and type; without one, it returns default empty optional fields. The output is a small struct ready to be copied into hook input JSON.

**Call relations**: Hook input builders call this before creating inputs for tool, permission, compaction, and prompt hooks. The test `tests::subagent_context_fields_serialize_flat_and_omit_when_absent` also calls it to prove the fields appear only when a subagent is present.

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

**Purpose**: Builds the input object sent to a session-start hook. It fills in the fixed event name and converts caller-provided values into the exact form expected by the hook contract.

**Data flow**: It receives a session ID, optional transcript path, current working directory, model name, permission mode, and session-start source. It converts those values into strings where needed, wraps the transcript path as nullable, sets `hook_event_name` to `SessionStart`, and returns a complete `SessionStartCommandInput`.

**Call relations**: Runtime session-start hook code calls this when a session begins or resumes. It hands path conversion to `NullableString::from_path` so this input uses the same null-or-string behavior as other hook inputs.

*Call graph*: calls 1 internal fn (from_path); called by 1 (run); 1 external calls (into).


##### `write_schema_fixtures`  (lines 597–683)

```
fn write_schema_fixtures(schema_root: &Path) -> anyhow::Result<()>
```

**Purpose**: Generates all hook JSON Schema files into a fresh `generated` directory. This is used to refresh or verify the checked-in schema fixtures that document the hook contract.

**Data flow**: It receives a root schema directory. It creates an empty generated subdirectory, generates schema JSON for every hook input and output type, writes each one to its named file, and returns success or an error if any filesystem or serialization step fails.

**Call relations**: The schema fixture test calls this in a temporary directory. Inside the generation flow, it delegates cleanup to `ensure_empty_dir` and file writing to `write_schema`, so the top-level function reads like a checklist of all schema files that must exist.

*Call graph*: calls 2 internal fn (ensure_empty_dir, write_schema); called by 1 (generated_hook_schemas_match_fixtures); 1 external calls (join).


##### `write_schema`  (lines 685–688)

```
fn write_schema(path: &Path, json: Vec<u8>) -> anyhow::Result<()>
```

**Purpose**: Writes one generated schema file to disk. It is a small wrapper that gives schema generation one consistent place to perform the write.

**Data flow**: It receives a target file path and a byte array containing formatted JSON. It writes those bytes to the file and returns success, or passes back the filesystem error if writing fails.

**Call relations**: `write_schema_fixtures` calls this repeatedly, once for each hook input or output schema. It is the final handoff from in-memory schema data to files on disk.

*Call graph*: called by 1 (write_schema_fixtures); 1 external calls (write).


##### `ensure_empty_dir`  (lines 690–696)

```
fn ensure_empty_dir(dir: &Path) -> anyhow::Result<()>
```

**Purpose**: Makes sure a directory exists and has no old files in it. This prevents stale generated schemas from being mistaken for current ones.

**Data flow**: It receives a directory path. If the directory already exists, it deletes it and everything inside; then it recreates the directory. The result is an empty folder or an error if the filesystem operation fails.

**Call relations**: `write_schema_fixtures` calls this before writing any schema files. It acts like clearing a workbench before laying out fresh documents.

*Call graph*: called by 1 (write_schema_fixtures); 3 external calls (exists, create_dir_all, remove_dir_all).


##### `schema_json`  (lines 698–706)

```
fn schema_json() -> anyhow::Result<Vec<u8>>
```

**Purpose**: Turns a Rust type that has a JSON Schema description into pretty, stable JSON bytes. This is the bridge from typed hook structs to schema files that tools and humans can read.

**Data flow**: It starts with a type parameter rather than a normal value. It asks `schema_for_type` for that type’s schema, converts the schema to generic JSON, passes it through `canonicalize_json` to sort object keys, and returns nicely formatted JSON bytes.

**Call relations**: Schema generation and tests use this whenever they need the schema for a hook input or output type. It hands the raw schema-building step to `schema_for_type` and the stable-ordering step to `canonicalize_json`.

*Call graph*: calls 1 internal fn (canonicalize_json); 2 external calls (to_value, to_vec_pretty).


##### `schema_for_type`  (lines 708–718)

```
fn schema_for_type() -> RootSchema
```

**Purpose**: Creates the root JSON Schema for one Rust type using draft-07 rules. Draft-07 is a widely supported version of the JSON Schema standard.

**Data flow**: It receives a type that implements `JsonSchema`. It configures the schema generator, including a setting that avoids automatically adding null to optional fields, and returns the full root schema for that type.

**Call relations**: `schema_json` calls this as its first step. The returned schema is then converted to JSON and cleaned up for stable output.

*Call graph*: 1 external calls (draft07).


##### `canonicalize_json`  (lines 720–734)

```
fn canonicalize_json(value: &Value) -> Value
```

**Purpose**: Sorts every object’s keys inside a JSON value so the output is stable from run to run. This makes generated schema files easy to compare in tests and code reviews.

**Data flow**: It receives any JSON value. Arrays are processed item by item, objects are rebuilt with keys in sorted order, and simple values like strings or booleans are copied unchanged. It returns a new JSON value with the same meaning but predictable ordering.

**Call relations**: `schema_json` calls this before formatting generated schemas. It does not change the contract, only the layout, like alphabetizing sections in a manual.

*Call graph*: called by 1 (schema_json); 4 external calls (with_capacity, Array, Object, clone).


##### `session_start_hook_event_name_schema`  (lines 736–738)

```
fn session_start_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `SessionStart`. This prevents a session-start input or output from claiming to be a different event.

**Data flow**: It ignores the generator input and passes the fixed string `SessionStart` to `string_const_schema`. The output is a schema that allows only that one string.

**Call relations**: Schemars calls this because the session-start types mark their event-name field with it. It delegates the actual schema construction to `string_const_schema`.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `post_tool_use_hook_event_name_schema`  (lines 740–742)

```
fn post_tool_use_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `PostToolUse`. This ties post-tool-use schemas to the correct hook event.

**Data flow**: It receives the schema generator but does not need to read it. It returns the fixed-string schema produced by `string_const_schema`.

**Call relations**: Post-tool-use input and output schema generation uses this function for the event-name field. It keeps that field event-specific instead of accepting any string.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `pre_compact_hook_event_name_schema`  (lines 744–746)

```
fn pre_compact_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `PreCompact`. This protects the pre-compaction hook contract from being mixed with other hook events.

**Data flow**: It ignores the generator input, asks `string_const_schema` for a constant-string schema, and returns that schema.

**Call relations**: The pre-compact input schema uses this when describing its hook event name. The shared constant-string helper does the real construction.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `post_compact_hook_event_name_schema`  (lines 748–750)

```
fn post_compact_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `PostCompact`. This makes the generated schema precise for post-compaction hooks.

**Data flow**: It receives a schema generator value but does not use it. It returns a schema that only permits the string `PostCompact`.

**Call relations**: The post-compact input schema calls on this through its schema annotation. It hands the fixed value to `string_const_schema`.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `pre_tool_use_hook_event_name_schema`  (lines 752–754)

```
fn pre_tool_use_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `PreToolUse`. This is important because pre-tool hooks can affect permission or tool input decisions.

**Data flow**: It ignores the generator input and returns a constant-string schema for `PreToolUse`.

**Call relations**: Pre-tool-use input and output schema generation uses this for event-name fields. Like the other event-name helpers, it delegates to `string_const_schema`.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `permission_request_hook_event_name_schema`  (lines 756–758)

```
fn permission_request_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `PermissionRequest`. This keeps permission-request output from masquerading as another hook response.

**Data flow**: It receives but does not inspect the schema generator. It returns a schema object that accepts only the `PermissionRequest` string.

**Call relations**: Permission-request input and hook-specific output schemas use this function. It relies on `string_const_schema` for the shared constant-value logic.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `user_prompt_submit_hook_event_name_schema`  (lines 760–762)

```
fn user_prompt_submit_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `UserPromptSubmit`. This makes user-prompt hook schemas specific and self-checking.

**Data flow**: It takes the unused generator input, sends the fixed event name to `string_const_schema`, and returns the resulting schema.

**Call relations**: User-prompt-submit input and output schema generation uses this for the event-name field. Tests also check that these event-specific output rules remain correct.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `subagent_start_hook_event_name_schema`  (lines 764–766)

```
fn subagent_start_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `SubagentStart`. This identifies the schema as belonging to the start of a subagent run.

**Data flow**: It ignores its generator argument and returns the constant-string schema for `SubagentStart`.

**Call relations**: Subagent-start input and output schema generation uses this through field annotations. It shares construction with the other event-name helpers through `string_const_schema`.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `subagent_stop_hook_event_name_schema`  (lines 768–770)

```
fn subagent_stop_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `SubagentStop`. This identifies hook input for the end of a subagent run.

**Data flow**: It receives an unused generator and produces a schema that permits only the `SubagentStop` string.

**Call relations**: Subagent-stop input schema generation calls this through its annotation. The actual constant-string object comes from `string_const_schema`.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `stop_hook_event_name_schema`  (lines 772–774)

```
fn stop_hook_event_name_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates a schema rule saying the hook event name must be exactly `Stop`. This keeps the final stop hook’s input clearly separated from other hook types.

**Data flow**: It ignores the generator input and returns a constant-string schema for `Stop`.

**Call relations**: The stop input schema uses this for its event-name field. It delegates to `string_const_schema`, like all event-name schema helpers.

*Call graph*: calls 1 internal fn (string_const_schema).


##### `permission_mode_schema`  (lines 776–784)

```
fn permission_mode_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates the list of allowed permission-mode strings for hook inputs. This prevents hook schemas from accepting arbitrary permission mode names.

**Data flow**: It receives an unused schema generator. It passes the allowed permission mode words to `string_enum_schema`, which returns a schema allowing only those values.

**Call relations**: Hook input types use this annotation on their `permission_mode` field. It relies on `string_enum_schema` to build the reusable “one of these strings” schema.

*Call graph*: calls 1 internal fn (string_enum_schema).


##### `session_start_source_schema`  (lines 786–788)

```
fn session_start_source_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates the list of allowed reasons a session-start hook may be running, such as startup or resume. This makes the source field predictable for hook authors.

**Data flow**: It ignores the generator input and passes the allowed source strings to `string_enum_schema`. The output is a schema that only accepts those source values.

**Call relations**: The session-start input schema uses this for its `source` field. It shares the enum-building helper with permission modes and compaction triggers.

*Call graph*: calls 1 internal fn (string_enum_schema).


##### `compaction_trigger_schema`  (lines 790–792)

```
fn compaction_trigger_schema(_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Creates the list of allowed compaction trigger strings. Compaction means shortening or summarizing context, and this field says whether that happened manually or automatically.

**Data flow**: It receives an unused generator and passes `manual` and `auto` to `string_enum_schema`. The result is a schema that accepts only those two strings.

**Call relations**: Pre-compact and post-compact input schemas use this for their `trigger` field. It delegates the common string-enum work to `string_enum_schema`.

*Call graph*: calls 1 internal fn (string_enum_schema).


##### `string_const_schema`  (lines 794–801)

```
fn string_const_schema(value: &str) -> Schema
```

**Purpose**: Builds a JSON Schema object for a string field that may have only one exact value. It is the shared helper behind all event-name schema rules.

**Data flow**: It receives the one allowed string. It creates a schema object whose type is string and whose constant value is that string, then returns it.

**Call relations**: All hook-event-name schema helpers call this. That keeps every event-specific field built the same way instead of duplicating schema construction many times.

*Call graph*: called by 10 (permission_request_hook_event_name_schema, post_compact_hook_event_name_schema, post_tool_use_hook_event_name_schema, pre_compact_hook_event_name_schema, pre_tool_use_hook_event_name_schema, session_start_hook_event_name_schema, stop_hook_event_name_schema, subagent_start_hook_event_name_schema, subagent_stop_hook_event_name_schema, user_prompt_submit_hook_event_name_schema); 3 external calls (default, Object, String).


##### `string_enum_schema`  (lines 803–815)

```
fn string_enum_schema(values: &[&str]) -> Schema
```

**Purpose**: Builds a JSON Schema object for a string field that may be one of several fixed values. It is used when a field has a small menu of legal choices.

**Data flow**: It receives a slice of allowed string values. It turns each one into a JSON string value, stores them as the schema’s enum values, and returns a string schema object.

**Call relations**: `permission_mode_schema`, `session_start_source_schema`, and `compaction_trigger_schema` call this. It provides the common “choose from this list” behavior for those fields.

*Call graph*: called by 3 (compaction_trigger_schema, permission_mode_schema, session_start_source_schema); 2 external calls (default, Object).


##### `default_continue`  (lines 817–819)

```
fn default_continue() -> bool
```

**Purpose**: Provides the default value for the shared hook output field `continue`. If a hook output omits that field, the system treats it as true.

**Data flow**: It takes no input and always returns `true`. During deserialization, serde uses that value when the JSON does not include `continue`.

**Call relations**: The shared output type references this as its default function. That means every hook output gets the same default behavior unless it explicitly says otherwise.


##### `tests::expected_fixture`  (lines 869–933)

```
fn expected_fixture(name: &str) -> &'static str
```

**Purpose**: Returns the checked-in expected schema text for a fixture filename. It lets tests compare freshly generated schemas with the project’s committed schema files.

**Data flow**: It receives a fixture filename. For known names, it returns the matching embedded file contents; for an unexpected name, it stops the test with an error.

**Call relations**: `tests::generated_hook_schemas_match_fixtures` calls this while looping over every schema fixture. It is the test-side lookup table for expected output.

*Call graph*: 2 external calls (include_str!, panic!).


##### `tests::normalize_newlines`  (lines 935–937)

```
fn normalize_newlines(value: &str) -> String
```

**Purpose**: Makes text comparisons ignore Windows versus Unix line ending differences. This keeps schema tests focused on content, not the operating system that read the file.

**Data flow**: It receives a string and replaces carriage-return-plus-newline sequences with plain newline characters. It returns the normalized string.

**Call relations**: `tests::generated_hook_schemas_match_fixtures` uses this on both expected and actual schema text before comparing them.


##### `tests::assert_output_hook_event_name_const`  (lines 939–951)

```
fn assert_output_hook_event_name_const(definition: &str, expected: &str)
```

**Purpose**: Checks that a generated output schema says its hook-specific `hookEventName` field is one exact event name. This guards against accidentally making output schemas too loose.

**Data flow**: It receives the schema definition name and the expected event name. It generates and parses the schema for the chosen output type, looks up that definition’s `hookEventName` property, and asserts that it contains the expected `const` string rule.

**Call relations**: `tests::hook_specific_output_event_names_are_event_specific_in_output_schemas` calls this for each output type that has hook-specific output. It uses `schema_json` to inspect the generated contract rather than hand-written expectations.

*Call graph*: 2 external calls (assert_eq!, from_slice).


##### `tests::generated_hook_schemas_match_fixtures`  (lines 954–987)

```
fn generated_hook_schemas_match_fixtures()
```

**Purpose**: Verifies that regenerated hook schemas exactly match the checked-in fixture files. This catches accidental contract changes.

**Data flow**: It creates a temporary schema directory, calls `write_schema_fixtures` to generate all schema files there, then loops through every expected fixture. For each one, it reads the generated file, normalizes line endings on both sides, and asserts that the text matches.

**Call relations**: This is the main regression test for schema generation. It drives the same generation path used to refresh fixtures and relies on `expected_fixture` and `normalize_newlines` for comparison.

*Call graph*: calls 1 internal fn (write_schema_fixtures); 5 external calls (new, assert_eq!, expected_fixture, normalize_newlines, read_to_string).


##### `tests::hook_specific_output_event_names_are_event_specific_in_output_schemas`  (lines 990–1015)

```
fn hook_specific_output_event_names_are_event_specific_in_output_schemas()
```

**Purpose**: Checks that each hook-specific output schema names the correct hook event. This prevents broad output schemas where, for example, a post-tool-use response could claim to be a pre-tool-use response.

**Data flow**: It has no external input. It calls the event-name assertion helper with each relevant output type, schema definition name, and expected event string, and the test passes only if all generated schemas contain the right constants.

**Call relations**: This test is a coordinator for `tests::assert_output_hook_event_name_const`. It covers permission request, tool-use, session-start, subagent-start, and user-prompt-submit output schemas.


##### `tests::turn_scoped_hook_inputs_include_codex_turn_id_extension`  (lines 1018–1082)

```
fn turn_scoped_hook_inputs_include_codex_turn_id_extension()
```

**Purpose**: Verifies that hook inputs which happen during a turn include a required `turn_id` field. A turn is one round of user-and-assistant interaction, and this ID lets internal hooks connect work to that round.

**Data flow**: It generates schemas for all turn-scoped hook input types, parses each schema as JSON, and checks that `turn_id` is a string and appears in the required-fields list.

**Call relations**: This test directly inspects schemas produced by `schema_json`. It protects a Codex-specific extension that intentionally goes beyond Claude’s public hook documentation.

*Call graph*: 3 external calls (assert!, assert_eq!, from_slice).


##### `tests::subagent_context_fields_are_optional_for_hooks_that_run_inside_subagents`  (lines 1085–1107)

```
fn subagent_context_fields_are_optional_for_hooks_that_run_inside_subagents()
```

**Purpose**: Verifies that `agent_id` and `agent_type` are available in relevant hook schemas but are not required. This allows the same hook shape to work both inside and outside subagents.

**Data flow**: It generates schemas for hooks that may run inside subagents, parses each schema, checks that the subagent fields are strings, and confirms they are not listed as required fields.

**Call relations**: This test uses `schema_json` to inspect the generated input contracts. It supports the behavior implemented by `SubagentCommandInputFields::from`, where absent subagent context should simply omit those fields.

*Call graph*: 3 external calls (assert!, assert_eq!, from_slice).


##### `tests::subagent_context_fields_serialize_flat_and_omit_when_absent`  (lines 1110–1165)

```
fn subagent_context_fields_serialize_flat_and_omit_when_absent()
```

**Purpose**: Checks the actual JSON produced for hook inputs with and without subagent context. It proves the subagent fields appear as normal top-level fields when present and disappear when absent.

**Data flow**: It first builds subagent fields from a sample subagent context, creates a pre-tool-use input, serializes it to JSON, and compares it with the expected object. Then it creates a similar input with no subagent fields and asserts that `agent_id` and `agent_type` are missing.

**Call relations**: This test calls `SubagentCommandInputFields::from` and `NullableString::from_path` while building realistic input objects. It confirms the serialization behavior that runtime hook input builders depend on.

*Call graph*: calls 2 internal fn (from_path, from); 3 external calls (assert_eq!, json!, to_value).


### `hooks/src/engine/schema_loader.rs`

`data_model` · `first use during hook engine setup or validation; then reused cross-cutting`

Hooks are small pieces of outside code that run at certain moments, such as before a tool is used or when a session starts. For those hooks to work safely, the system needs clear rules for what each hook may receive as input and return as output. Those rules live as generated JSON Schema files, which are machine-readable descriptions of valid JSON data.

This file is like a binder full of official forms. Each field in `GeneratedHookSchemas` holds one form: the input or output schema for a particular hook command. The schemas are included directly in the compiled program with `include_str!`, so the program does not need to find separate schema files at runtime.

The main function, `generated_hook_schemas`, uses `OnceLock`, which is a one-time storage cell. The first time someone asks for the schemas, it parses all the embedded JSON strings into `serde_json::Value` objects. After that, it returns the same already-parsed copy every time. This avoids repeated parsing and ensures every caller sees the same schema set.

If any generated schema is not valid JSON, `parse_json_schema` stops the program with a clear panic message naming the broken schema. The test at the bottom checks that every loaded schema looks like a JSON object, catching missing or malformed generated schema files early.

#### Function details

##### `generated_hook_schemas`  (lines 29–113)

```
fn generated_hook_schemas() -> &'static GeneratedHookSchemas
```

**Purpose**: Provides the complete set of generated hook command schemas as one shared, read-only collection. Code uses it when it needs to validate or understand the expected input and output shape for hook commands.

**Data flow**: Nothing is passed in. On the first call, it reads the schema text embedded in the program, parses each JSON schema into a general JSON value, and stores the full collection in a one-time global cell. It returns a shared reference to that collection; later calls skip the parsing and return the same stored reference.

**Call relations**: This is the public doorway for this file. A higher-level `new` constructor calls it when building something that needs hook schemas, and the test `tests::loads_generated_hook_schemas` calls it to prove the schemas load correctly. Inside, it relies on one-time initialization so callers do not each rebuild the same schema set.

*Call graph*: called by 2 (new, loads_generated_hook_schemas); 1 external calls (new).


##### `parse_json_schema`  (lines 115–118)

```
fn parse_json_schema(name: &str, schema: &str) -> Value
```

**Purpose**: Turns one embedded schema file from raw text into a JSON value the program can inspect. It also gives a clear failure message if a generated schema is broken.

**Data flow**: It receives a human-readable schema name and the schema text. It asks `serde_json` to parse the text as JSON. If parsing succeeds, it returns the parsed JSON value; if parsing fails, it stops with an error message that includes the schema name and the parsing problem.

**Call relations**: This is the small checker used while building the full schema collection in `generated_hook_schemas`. It hands the actual JSON parsing work to `serde_json::from_str`, then either returns the parsed value or reports that the generated schema is invalid.

*Call graph*: 1 external calls (from_str).


##### `tests::loads_generated_hook_schemas`  (lines 126–149)

```
fn loads_generated_hook_schemas()
```

**Purpose**: Checks that every generated hook schema can be loaded and has the expected top-level JSON Schema shape. This helps catch broken generated schema files during testing instead of at runtime.

**Data flow**: The test asks `generated_hook_schemas` for the shared schema collection. It then looks at the `type` field of each schema and compares it with the string `object`. The result is no returned value; the test passes if all comparisons match and fails if any schema is missing, malformed, or not shaped as expected.

**Call relations**: This test exercises the same loading path used by production code. It calls `generated_hook_schemas`, which triggers parsing if needed, and then uses assertions to verify each loaded schema. In that way, it guards the schema loader against bad generated files.

*Call graph*: calls 1 internal fn (generated_hook_schemas); 1 external calls (assert_eq!).
