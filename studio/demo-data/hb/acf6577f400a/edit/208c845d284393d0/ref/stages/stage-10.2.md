# RPC request routing  `stage-10.2`

This stage is the system’s switchboard. It sits in the main work loop, after a message arrives from a client or another service, and decides where that message should go next. Most messages use JSON-RPC, a simple format for naming a method and its inputs.

The main app-server router in message_processor.rs enforces startup rules, keeps track of each connection, and sends each request to the right specialist. The request processor files are those specialists: threads and turns drive conversations, goals and deletion manage thread state, catalog, models, plugins, marketplace, feedback, search, git, remote control, environments, filesystem, sandbox setup, and external-agent import each handle their own feature area. Shared helpers clean up request data and turn failures into user-facing protocol errors.

Several files bridge requests into deeper runtime systems. dynamic_tools.rs feeds tool-call results back into live conversations. attestation.rs asks the client for proof tokens. fs_watch.rs turns file changes into notifications. In core, the tool router and registry choose and run tools safely.

Parallel routers do the same job in other servers: exec-server dispatches process, file, and HTTP methods; mcp-server handles MCP tool calls; rmcp-client handles elicitation prompts; and the network proxy routes HTTP traffic under policy rules.

## Files in this stage

### App server dispatch core
These files define the app server's top-level routing layer, shared processor utilities, and the broad request families that anchor most connection-scoped message handling.

### `app-server/src/message_processor.rs`

`orchestration` · `request handling and connection lifecycle`

This file is the app server’s main request orchestration hub. It defines `MessageProcessor`, which owns concrete processor instances for account, apps, catalog, command/process execution, config, environment, external agent config, feedback, filesystem, git, initialization, marketplace, MCP, plugins, remote control, search, thread goals, threads, turns, and Windows sandbox operations. `MessageProcessor::new` wires these together from shared runtime dependencies such as `AuthManager`, `ThreadManager`, `EnvironmentManager`, config/state stores, analytics, outgoing transport, and plugin startup behavior. It also installs an `ExternalAuthRefreshBridge` into the auth manager so login refreshes can be delegated back to the client over server-initiated RPC.

The file also defines `ConnectionSessionState`, a per-connection state object with a `ConnectionRpcGate` and a `OnceLock<InitializedConnectionSessionState>`. That state records whether initialize has run, whether experimental APIs are enabled, notification opt-outs, client identity/version, and whether request attestation is required. Non-`Initialize` requests are rejected until initialization succeeds; experimental requests are additionally blocked unless the session opted in.

Request handling follows a layered flow: raw `JSONRPCRequest` values are deserialized into `ClientRequest`, wrapped in a `RequestContext` with tracing metadata, then passed through `handle_client_request`. Initialized requests are tracked, optionally serialized by `RequestSerializationQueues` according to each request’s declared scope, and finally executed asynchronously through a large match that delegates to the appropriate feature processor. Responses and errors are normalized through `OutgoingMessageSender`. Connection teardown drains in-flight connection RPCs with a timeout, then notifies all processors that maintain per-connection resources such as FS watches, command/process sessions, and thread listeners.

#### Function details

##### `deserialize_client_request`  (lines 98–107)

```
fn deserialize_client_request(
    request: &JSONRPCRequest,
) -> Result<ClientRequest, JSONRPCErrorError>
```

**Purpose**: Converts an incoming untyped `JSONRPCRequest` into the protocol-level `ClientRequest` enum used by the rest of the server. It treats both JSON value conversion failures and typed deserialization failures as JSON-RPC invalid-request errors.

**Data flow**: It reads a borrowed `JSONRPCRequest`, serializes it to `serde_json::Value`, then deserializes that value into `ClientRequest`. On success it returns the typed request; on failure it returns `JSONRPCErrorError` built with `invalid_request(...)` containing the serde error text. It does not mutate shared state.

**Call relations**: It is used only from `MessageProcessor::process_request` after a raw JSON-RPC request arrives. That keeps JSON decoding isolated from the rest of the dispatch path so `handle_client_request` can operate on already-typed requests.

*Call graph*: called by 1 (process_request); 1 external calls (to_value).


##### `ExternalAuthRefreshBridge::map_reason`  (lines 115–119)

```
fn map_reason(reason: ExternalAuthRefreshReason) -> ChatgptAuthTokensRefreshReason
```

**Purpose**: Maps login-layer refresh reasons into the app-server protocol enum sent to the client. The current mapping is one-to-one for the `Unauthorized` case.

**Data flow**: It takes an `ExternalAuthRefreshReason` and returns the corresponding `ChatgptAuthTokensRefreshReason` by pattern matching. No external state is read or written.

**Call relations**: It is an internal helper used by the bridge’s async refresh implementation before constructing `ChatgptAuthTokensRefreshParams`.


##### `ExternalAuthRefreshBridge::auth_mode`  (lines 171–173)

```
fn auth_mode(&self) -> LoginAuthMode
```

**Purpose**: Declares that this external auth bridge operates in ChatGPT auth mode. This lets the login subsystem identify which external auth flow is attached.

**Data flow**: It reads no inputs beyond `&self` and returns the constant `LoginAuthMode::Chatgpt`. No state changes occur.

**Call relations**: It fulfills the `ExternalAuth` trait contract for the auth manager after `MessageProcessor::new` installs this bridge.


##### `ExternalAuthRefreshBridge::refresh`  (lines 175–180)

```
fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> codex_login::ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Adapts the bridge’s concrete async token refresh routine into the boxed future type required by the `ExternalAuth` trait. It exposes client-mediated token refresh to the login subsystem.

**Data flow**: It takes `&self` and an `ExternalAuthRefreshContext`, then returns a pinned future that resolves to `ExternalAuthTokens` or an I/O error. The future delegates to the inherent async refresh method and does not itself mutate state.

**Call relations**: This trait method is invoked by the auth/login stack once `MessageProcessor::new` has registered the bridge with `AuthManager`. It exists specifically to connect trait-based callers to the bridge’s request/response implementation.

*Call graph*: calls 1 internal fn (chatgpt); 7 external calls (pin, map_reason, ChatgptAuthTokensRefresh, other, format!, from_value, timeout).


##### `ConnectionSessionState::default`  (lines 226–228)

```
fn default() -> Self
```

**Purpose**: Provides the default uninitialized per-connection session state. It simply forwards to the explicit constructor.

**Data flow**: It takes no arguments and returns a fresh `ConnectionSessionState` with a new RPC gate and empty initialization slot. No shared state is touched.

**Call relations**: It supports generic construction paths that rely on `Default`; the actual setup logic lives in `ConnectionSessionState::new`.

*Call graph*: 1 external calls (new).


##### `ConnectionSessionState::new`  (lines 232–237)

```
fn new() -> Self
```

**Purpose**: Creates a new per-connection session container before the client has sent `Initialize`. The session starts with an active `ConnectionRpcGate` and no initialized metadata.

**Data flow**: It allocates a new `ConnectionRpcGate` inside an `Arc` and a fresh `OnceLock<InitializedConnectionSessionState>`, then returns the assembled struct. No external state is read.

**Call relations**: It is used by connection setup code outside this file to create session state for each new connection, and underlies the `Default` implementation.

*Call graph*: calls 1 internal fn (new); called by 3 (start_uninitialized, new, new); 2 external calls (new, new).


##### `ConnectionSessionState::initialized`  (lines 239–241)

```
fn initialized(&self) -> bool
```

**Purpose**: Reports whether the connection has completed initialization. This is the gate checked before almost all request handling.

**Data flow**: It reads the `OnceLock` and returns `true` if it contains initialized session data, otherwise `false`. It does not modify state.

**Call relations**: It is consulted during initialized-request dispatch to reject requests that arrive before `Initialize` succeeds.

*Call graph*: called by 1 (initialize); 1 external calls (get).


##### `ConnectionSessionState::experimental_api_enabled`  (lines 243–247)

```
fn experimental_api_enabled(&self) -> bool
```

**Purpose**: Returns whether this connection enabled experimental APIs during initialization. The flag is stored in the immutable initialized session payload.

**Data flow**: It reads the `OnceLock`, inspects the stored `InitializedConnectionSessionState` if present, and returns the `experimental_api_enabled` boolean; absent initialization yields `false`.

**Call relations**: It is used during request dispatch when a `ClientRequest` advertises an experimental requirement via `experimental_reason()`.

*Call graph*: 1 external calls (get).


##### `ConnectionSessionState::opted_out_notification_methods`  (lines 249–254)

```
fn opted_out_notification_methods(&self) -> HashSet<String>
```

**Purpose**: Returns the set of notification method names this client asked not to receive. The method clones the stored set so callers cannot mutate session internals.

**Data flow**: It reads the initialized session if present, clones `opted_out_notification_methods`, and returns it; otherwise it returns an empty `HashSet<String>`.

**Call relations**: This accessor supports other parts of the server that need connection-specific notification filtering based on initialize-time preferences.

*Call graph*: 1 external calls (get).


##### `ConnectionSessionState::app_server_client_name`  (lines 256–260)

```
fn app_server_client_name(&self) -> Option<&str>
```

**Purpose**: Exposes the client name recorded at initialization time. This is used for attribution and feature-specific behavior such as remote control and thread/turn metadata.

**Data flow**: It reads the initialized session and returns `Option<&str>` borrowed from the stored `String`; if uninitialized, it returns `None`.

**Call relations**: It is consumed by tracing helpers and by request dispatch code that passes client identity through to downstream processors.

*Call graph*: called by 2 (client_name, typed_request_span); 1 external calls (get).


##### `ConnectionSessionState::client_version`  (lines 262–266)

```
fn client_version(&self) -> Option<&str>
```

**Purpose**: Exposes the client version string captured during initialization. This lets downstream processors and tracing annotate requests with the caller version.

**Data flow**: It reads the initialized session and returns `Option<&str>` borrowed from the stored version string, or `None` if initialization has not happened.

**Call relations**: It is used by tracing and by request dispatch paths that forward client version into thread and turn operations.

*Call graph*: called by 2 (client_version, typed_request_span); 1 external calls (get).


##### `ConnectionSessionState::request_attestation`  (lines 268–272)

```
fn request_attestation(&self) -> bool
```

**Purpose**: Reports whether this connection requested attestation-aware behavior. The value is fixed once initialization succeeds.

**Data flow**: It reads the initialized session and returns the stored `request_attestation` flag, defaulting to `false` when uninitialized.

**Call relations**: It is consulted when the connection becomes initialized so `ThreadRequestProcessor` can be told the connection’s capabilities.

*Call graph*: 1 external calls (get).


##### `ConnectionSessionState::initialize`  (lines 274–276)

```
fn initialize(&self, session: InitializedConnectionSessionState) -> Result<(), ()>
```

**Purpose**: Stores the immutable initialized session payload exactly once. It prevents re-initialization by relying on `OnceLock` semantics.

**Data flow**: It takes an `InitializedConnectionSessionState` by value and attempts to set the internal `OnceLock`. It returns `Ok(())` on the first successful set and `Err(())` if initialization had already occurred.

**Call relations**: It is called from the initialize request processor during `Initialize` handling; later accessors and dispatch checks rely on the stored data.

*Call graph*: called by 1 (initialize); 1 external calls (set).


##### `MessageProcessor::new`  (lines 301–564)

```
fn new(args: MessageProcessorArgs) -> Self
```

**Purpose**: Builds the full request-processing graph for the app server from shared runtime dependencies. It wires auth refresh bridging, thread management, extension dependencies, plugin startup behavior, and all feature-specific request processors into one dispatcher object.

**Data flow**: It consumes `MessageProcessorArgs`, installs `ExternalAuthRefreshBridge` into `AuthManager`, creates `ThreadStateManager`, a process-scoped thread store, executor skill provider, `GoalService`, and an `Arc::new_cyclic` `ThreadManager` with extension/event-sink dependencies. It then constructs each concrete request processor with the relevant shared `Arc`s, caches, semaphores, shutdown tokens, and stores, optionally starts plugin startup tasks, and returns a `MessageProcessor` containing all processors plus default `RequestSerializationQueues`.

**Call relations**: It is the constructor used by server startup and test setup. Every later method in this file depends on the processor instances and shared runtime objects assembled here.

*Call graph*: calls 27 internal fn (new, new, new, new, new, new, new, new, new, new (+15 more)); called by 4 (start_uninitialized, build_test_processor, run_main_with_transport_options, run_main); 11 external calls (clone, new, new_cyclic, new, new, new, new, default, default, thread_store_from_config (+1 more)).


##### `MessageProcessor::clear_runtime_references`  (lines 566–570)

```
fn clear_runtime_references(&self)
```

**Purpose**: Drops or shuts down runtime-only references that should not survive teardown or reconfiguration. It specifically clears external auth hooks and stops background watchers/listing tasks.

**Data flow**: It reads `self` and invokes `clear_external_auth` on `account_processor`, `shutdown` on `apps_processor`, and `shutdown` on `skills_watcher`. It returns no value.

**Call relations**: This is a cleanup helper used during shutdown-style flows to sever long-lived callbacks and background activity created during construction.

*Call graph*: calls 2 internal fn (clear_external_auth, shutdown).


##### `MessageProcessor::process_request`  (lines 572–624)

```
async fn process_request(
        self: &Arc<Self>,
        connection_id: ConnectionId,
        request: JSONRPCRequest,
        transport: &AppServerTransport,
        session: Arc<ConnectionSession
```

**Purpose**: Handles a raw JSON-RPC request arriving over transport. It creates tracing/request context, deserializes the request into `ClientRequest`, delegates to shared request handling, and emits a JSON-RPC error reply if dispatch fails.

**Data flow**: It takes a connection id, `JSONRPCRequest`, transport reference, and session state. It logs the method, builds `ConnectionRequestId`, derives a tracing span and optional `W3cTraceContext`, wraps them in `RequestContext`, registers that context through `run_request_with_context`, deserializes via `deserialize_client_request`, then calls `handle_client_request` with `outbound_initialized` set to `None`. Any returned `JSONRPCErrorError` is sent through `OutgoingMessageSender::send_error`.

**Call relations**: This is the main entry for network-originated requests. It differs from `process_client_request` only in the initial deserialization step and in deferring outbound-ready bookkeeping for websocket callers.

*Call graph*: calls 4 internal fn (request_span, handle_client_request, deserialize_client_request, new); 3 external calls (clone, run_request_with_context, trace!).


##### `MessageProcessor::process_client_request`  (lines 630–672)

```
async fn process_client_request(
        self: &Arc<Self>,
        connection_id: ConnectionId,
        request: ClientRequest,
        session: Arc<ConnectionSessionState>,
        outbound_initializ
```

**Purpose**: Handles an already-typed `ClientRequest` from an in-process embedder. It preserves the same semantics as JSON-RPC handling while skipping JSON deserialization.

**Data flow**: It takes a connection id, typed request, session state, and an `AtomicBool` used to mark outbound readiness after initialize. It builds `ConnectionRequestId`, a typed tracing span, and `RequestContext`, then runs `handle_client_request` inside `run_request_with_context` with `Some(outbound_initialized)`. Errors are converted into outgoing JSON-RPC error messages.

**Call relations**: This is the typed counterpart to `process_request`. It is used by in-process clients that do not have the websocket transport loop responsible for post-initialize outbound bookkeeping.

*Call graph*: calls 3 internal fn (typed_request_span, handle_client_request, new); 4 external calls (clone, id, run_request_with_context, trace!).


##### `MessageProcessor::process_notification`  (lines 674–678)

```
async fn process_notification(&self, notification: JSONRPCNotification)
```

**Purpose**: Logs an unexpected JSON-RPC notification from the client. The server currently does not implement any notification-handling behavior here.

**Data flow**: It takes a `JSONRPCNotification`, emits an info log containing the notification, and returns `()`. No state is changed.

**Call relations**: It is the notification-side transport hook parallel to `process_request`, but intentionally does not dispatch to feature processors.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::process_client_notification`  (lines 681–685)

```
async fn process_client_notification(&self, notification: ClientNotification)
```

**Purpose**: Logs an unexpected typed notification from an in-process client. Like the JSON-RPC variant, it is intentionally passive.

**Data flow**: It takes a `ClientNotification`, logs it at info level, and returns `()`. No shared state is read beyond formatting for logging.

**Call relations**: It mirrors `process_notification` for typed embedders rather than wire-format notifications.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::run_request_with_context`  (lines 687–698)

```
async fn run_request_with_context(
        outgoing: Arc<OutgoingMessageSender>,
        request_context: RequestContext,
        request_fut: F,
    )
```

**Purpose**: Registers request-scoped tracing/output context before executing the actual request future. This ensures downstream code can associate outgoing messages with the active request and tracing span.

**Data flow**: It takes the shared `OutgoingMessageSender`, a `RequestContext`, and an arbitrary future producing `()`. It asynchronously registers the context with the outgoing sender, then instruments and awaits the future on the request span. It returns no value.

**Call relations**: Both `process_request` and `process_client_request` wrap their dispatch futures with this helper so all request paths get consistent context registration and tracing.

*Call graph*: calls 1 internal fn (span); 2 external calls (instrument, clone).


##### `MessageProcessor::thread_created_receiver`  (lines 700–702)

```
fn thread_created_receiver(&self) -> broadcast::Receiver<ThreadId>
```

**Purpose**: Exposes the broadcast channel used to observe newly created thread IDs. It is a thin forwarding accessor.

**Data flow**: It reads `self.thread_processor` and returns a `broadcast::Receiver<ThreadId>` subscribed to thread creation events. No mutation occurs.

**Call relations**: External orchestration code can call this to react to thread creation without reaching into `ThreadRequestProcessor` directly.

*Call graph*: calls 1 internal fn (thread_created_receiver).


##### `MessageProcessor::send_initialize_notifications_to_connection`  (lines 704–711)

```
async fn send_initialize_notifications_to_connection(
        &self,
        connection_id: ConnectionId,
    )
```

**Purpose**: Pushes initialize-time notifications to one specific connection. This is used when a connection needs its own initialization side effects delivered after setup.

**Data flow**: It takes a `ConnectionId`, forwards it to `initialize_processor.send_initialize_notifications_to_connection(...)`, awaits completion, and returns `()`. Output is emitted through the outgoing transport managed by the initialize processor.

**Call relations**: This method is part of the connection setup flow and complements request-side `Initialize` handling.

*Call graph*: calls 1 internal fn (send_initialize_notifications_to_connection).


##### `MessageProcessor::connection_initialized`  (lines 713–726)

```
async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        request_attestation: bool,
    )
```

**Purpose**: Notifies thread handling logic that a connection has completed initialization and advertises its capabilities. The only capability currently forwarded here is request attestation.

**Data flow**: It takes a connection id and a `request_attestation` flag, constructs `ConnectionCapabilities { request_attestation }`, and forwards that to `thread_processor.connection_initialized(...)`.

**Call relations**: This is an explicit lifecycle hook used outside the request dispatcher when connection initialization needs to be reflected into thread subsystem state.

*Call graph*: calls 1 internal fn (connection_initialized).


##### `MessageProcessor::send_initialize_notifications`  (lines 728–732)

```
async fn send_initialize_notifications(&self)
```

**Purpose**: Broadcasts initialize notifications through the initialize processor. It is the all-connections counterpart to the per-connection variant.

**Data flow**: It invokes `initialize_processor.send_initialize_notifications().await` and returns `()`. Any actual outgoing messages are produced by the initialize processor.

**Call relations**: This supports startup or global refresh flows that need initialize-related notifications emitted broadly.

*Call graph*: calls 1 internal fn (send_initialize_notifications).


##### `MessageProcessor::try_attach_thread_listener`  (lines 734–742)

```
async fn try_attach_thread_listener(
        &self,
        thread_id: ThreadId,
        connection_ids: Vec<ConnectionId>,
    )
```

**Purpose**: Attempts to attach one or more connections as listeners to a thread. It delegates the actual attachment logic to the thread processor.

**Data flow**: It takes a `ThreadId` and a vector of `ConnectionId`s, forwards them to `thread_processor.try_attach_thread_listener(...)`, awaits completion, and returns `()`. State changes occur inside the thread processor.

**Call relations**: This is a lifecycle/helper API for external orchestration code that needs to connect existing threads to connection listeners.

*Call graph*: calls 1 internal fn (try_attach_thread_listener).


##### `MessageProcessor::drain_background_tasks`  (lines 744–746)

```
async fn drain_background_tasks(&self)
```

**Purpose**: Waits for thread-related background tasks to finish. It is a shutdown/teardown helper.

**Data flow**: It calls `thread_processor.drain_background_tasks().await` and returns `()`. Any waiting and internal task bookkeeping happen in the thread processor.

**Call relations**: Used during shutdown sequencing to ensure thread subsystem background work has quiesced.

*Call graph*: calls 1 internal fn (drain_background_tasks).


##### `MessageProcessor::cancel_active_login`  (lines 748–750)

```
async fn cancel_active_login(&self)
```

**Purpose**: Cancels any currently active login flow managed by the account processor. This is a direct lifecycle control hook.

**Data flow**: It invokes `account_processor.cancel_active_login().await` and returns `()`. Cancellation side effects are internal to the account processor.

**Call relations**: This is used by higher-level shutdown or connection-management code that needs to abort in-flight authentication.

*Call graph*: calls 1 internal fn (cancel_active_login).


##### `MessageProcessor::clear_all_thread_listeners`  (lines 752–754)

```
async fn clear_all_thread_listeners(&self)
```

**Purpose**: Removes all registered thread listeners from the thread processor. It is intended for cleanup rather than normal request dispatch.

**Data flow**: It forwards to `thread_processor.clear_all_thread_listeners().await` and returns `()`. Listener state is mutated inside the thread processor.

**Call relations**: This supports teardown/reset flows where all connection-to-thread subscriptions must be dropped.

*Call graph*: calls 1 internal fn (clear_all_thread_listeners).


##### `MessageProcessor::shutdown_threads`  (lines 756–758)

```
async fn shutdown_threads(&self)
```

**Purpose**: Initiates shutdown of managed threads through the thread processor. It centralizes thread teardown behind the message processor facade.

**Data flow**: It calls `thread_processor.shutdown_threads().await` and returns `()`. Thread shutdown effects occur in the delegated subsystem.

**Call relations**: This is another lifecycle helper used during server shutdown or reset.

*Call graph*: calls 1 internal fn (shutdown_threads).


##### `MessageProcessor::connection_closed`  (lines 760–787)

```
async fn connection_closed(
        &self,
        connection_id: ConnectionId,
        session_state: &ConnectionSessionState,
    )
```

**Purpose**: Performs per-connection teardown across all subsystems that may hold connection-scoped resources. It first waits for in-flight connection RPCs to drain, with a warning if they exceed the configured timeout.

**Data flow**: It takes a connection id and session state, awaits `session_state.rpc_gate.shutdown()` under `CONNECTION_RPC_DRAIN_TIMEOUT`, logs a warning on timeout, then sequentially notifies `outgoing`, `fs_processor`, `command_exec_processor`, `process_exec_processor`, and `thread_processor` that the connection closed. These delegates release watches, process handles, listeners, and outbound bookkeeping tied to that connection.

**Call relations**: This is the main connection teardown hook invoked when a transport disconnects. It coordinates cleanup across all processors that can retain connection-local state.

*Call graph*: calls 4 internal fn (connection_closed, connection_closed, connection_closed, connection_closed); 2 external calls (timeout, warn!).


##### `MessageProcessor::subscribe_running_assistant_turn_count`  (lines 789–792)

```
fn subscribe_running_assistant_turn_count(&self) -> watch::Receiver<usize>
```

**Purpose**: Returns a watch receiver for the current count of running assistant turns. It exposes thread/turn activity as a live observable value.

**Data flow**: It forwards to `thread_processor.subscribe_running_assistant_turn_count()` and returns `watch::Receiver<usize>`. No mutation occurs in this wrapper.

**Call relations**: External monitoring or orchestration code can subscribe through this facade instead of depending directly on the thread processor.

*Call graph*: calls 1 internal fn (subscribe_running_assistant_turn_count).


##### `MessageProcessor::process_response`  (lines 795–799)

```
async fn process_response(&self, response: JSONRPCResponse)
```

**Purpose**: Handles a standalone JSON-RPC response received from the peer, typically for a server-initiated request. It logs the response and forwards the result payload to the outgoing sender’s pending-request machinery.

**Data flow**: It takes a `JSONRPCResponse`, logs it, destructures out `id` and `result`, and calls `outgoing.notify_client_response(id, result).await`. This resolves whatever pending request was waiting on that client response.

**Call relations**: This is the inbound counterpart to server-initiated requests such as auth refresh. It feeds peer responses back into `OutgoingMessageSender`’s request tracking.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::process_error`  (lines 802–805)

```
async fn process_error(&self, err: JSONRPCError)
```

**Purpose**: Handles a JSON-RPC error object received from the peer for a server-initiated request. It logs the error and forwards it to the outgoing sender’s pending-request machinery.

**Data flow**: It takes a `JSONRPCError`, logs it at error level, and calls `outgoing.notify_client_error(err.id, err.error).await`. This wakes the waiter associated with that request id with an error payload.

**Call relations**: Like `process_response`, this is part of the reverse-RPC path used when the server asks the client to perform work and must receive either success or failure.

*Call graph*: 1 external calls (error!).


##### `MessageProcessor::handle_client_request`  (lines 807–850)

```
async fn handle_client_request(
        self: &Arc<Self>,
        connection_request_id: ConnectionRequestId,
        codex_request: ClientRequest,
        session: Arc<ConnectionSessionState>,
```

**Purpose**: Implements the first stage of typed request handling: special-casing `Initialize`, updating connection capabilities after successful initialization, and forwarding all other requests into the initialized-only dispatch path.

**Data flow**: It takes a `ConnectionRequestId`, typed `ClientRequest`, session state, optional outbound-ready flag, and `RequestContext`. If the request is `ClientRequest::Initialize`, it calls `initialize_processor.initialize(...)`; when that returns `true`, it notifies `thread_processor.connection_initialized(...)` using `session.request_attestation()`. For all other variants it delegates to `dispatch_initialized_client_request`. It returns `Result<(), JSONRPCErrorError>`.

**Call relations**: Both `process_request` and `process_client_request` converge here after context setup. This function is the gate that separates one-time initialization from normal request dispatch.

*Call graph*: calls 3 internal fn (dispatch_initialized_client_request, initialize, connection_initialized); called by 2 (process_client_request, process_request).


##### `MessageProcessor::dispatch_initialized_client_request`  (lines 852–913)

```
async fn dispatch_initialized_client_request(
        self: &Arc<Self>,
        connection_request_id: ConnectionRequestId,
        codex_request: ClientRequest,
        session: Arc<ConnectionSession
```

**Purpose**: Validates that a request may run on an initialized connection, records initialize-time request tracking, and schedules the actual work either through a serialization queue or as an independent task. It is the bridge between request admission checks and asynchronous execution.

**Data flow**: It takes the connection/request id, typed request, session, and request context. It rejects uninitialized sessions with `invalid_request("Not initialized")`, rejects experimental requests when `session.experimental_api_enabled()` is false, and records the request via `initialize_processor.track_initialized_request(...)`. It then captures client name/version from the session, wraps the actual execution in a `QueuedInitializedRequest` guarded by the session’s `ConnectionRpcGate`, and either enqueues it into `request_serialization_queues` using `RequestSerializationQueueKey::from_scope(...)` or spawns it immediately with `tokio::spawn`. Errors from the inner execution are sent through `outgoing.send_error`.

**Call relations**: It is called only from `handle_client_request` for non-`Initialize` requests. Its main role is admission control plus serialization policy enforcement before `handle_initialized_client_request` performs the feature-specific match.

*Call graph*: calls 6 internal fn (invalid_request, span, track_initialized_request, new, from_scope, enqueue); called by 1 (handle_client_request); 6 external calls (clone, experimental_reason, serialization_scope, clone, experimental_required_message, spawn).


##### `MessageProcessor::handle_initialized_client_request`  (lines 915–1485)

```
async fn handle_initialized_client_request(
        self: Arc<Self>,
        connection_request_id: ConnectionRequestId,
        codex_request: ClientRequest,
        request_context: RequestContext,
```

**Purpose**: Performs the concrete dispatch for every initialized `ClientRequest` variant. It matches the request enum and delegates to the corresponding feature processor, normalizing each processor’s result into either an outgoing response, no response, or an outgoing JSON-RPC error.

**Data flow**: It takes ownership of `Arc<Self>`, the connection/request id, typed request, request context, and optional client name/version strings. It rebuilds a `ConnectionRequestId` from the request’s own id, matches over all `ClientRequest` variants, and calls the appropriate processor method with the exact combination of request id, params, connection id, request context, and client metadata required by that operation. The delegated calls return `Result<Option<ClientResponsePayload>, JSONRPCErrorError>` directly or are mapped into that shape with `.map(|response| Some(response.into()))` or `.map(|()| None)`. After the match, `Ok(Some(...))` is sent via `outgoing.send_response_as`, `Ok(None)` produces no reply body, and `Err(...)` is sent via `outgoing.send_error`; the wrapper itself then returns `Ok(())`.

**Call relations**: This is the terminal dispatch stage reached from `dispatch_initialized_client_request` after initialization and experimental checks pass. It fans out to all subsystem processors: config, remote control, environment, filesystem, thread/thread-goal/turn, catalog, marketplace, plugin, apps, MCP, Windows sandbox, account, git, search, command execution, process execution, and feedback.

*Call graph*: calls 120 internal fn (cancel_login_account, get_account, get_account_rate_limits, get_account_token_usage, get_auth_status, login_account, logout_account, send_add_credits_nudge_email, apps_list, collaboration_mode_list (+15 more)); 4 external calls (id, consume_account_rate_limit_reset_credit, thread_delete, panic!).


### `app-server/src/request_processors.rs`

`orchestration` · `request handling`

Most of this file is module wiring: it imports the large protocol and subsystem surface area needed by the request-processing layer, declares submodules for account, apps, catalog, thread, turn, MCP, plugins, and other request families, and re-exports their processor types so the higher-level dispatcher can assemble them. The concrete logic here is limited to a few cross-cutting helpers that normalize request inputs before they reach deeper domain code.

`resolve_request_cwd` validates an optional client-supplied working directory by normalizing it for the native platform and converting it into an `AbsolutePathBuf` relative to the current directory; invalid paths become JSON-RPC `invalid_request` errors. `resolve_turn_environment_selections` converts protocol `TurnEnvironmentParams` into core `TurnEnvironmentSelection` values, enforcing that each environment `cwd` uses absolute POSIX or Windows syntax and then delegating to `ThreadManager::validate_environment_selections` for semantic validation. `resolve_runtime_workspace_roots` deduplicates workspace roots while preserving first-seen order. Finally, `build_api_turns_from_rollout_items` reconstructs protocol `Turn` history from rollout items by feeding only persisted items into `ThreadHistoryBuilder`.

The design choice worth noting is that this file keeps validation and translation close to the request boundary: malformed path syntax and invalid environment selections are rejected before deeper thread/turn logic runs, while rollout-to-API history conversion intentionally ignores transient rollout items.

#### Function details

##### `resolve_request_cwd`  (lines 536–542)

```
fn resolve_request_cwd(cwd: Option<PathBuf>) -> Result<Option<AbsolutePathBuf>, JSONRPCErrorError>
```

**Purpose**: Validates and canonicalizes an optional request working directory into an absolute-path wrapper suitable for core APIs.

**Data flow**: Takes `Option<PathBuf>`; if `Some`, normalizes the path with `path_utils::normalize_for_native_workdir`, converts it via `AbsolutePathBuf::relative_to_current_dir`, maps conversion failures to `invalid_request("invalid cwd: ...")`, and returns `Result<Option<AbsolutePathBuf>, JSONRPCErrorError>`.

**Call relations**: Used by request handlers that accept an optional cwd and need a validated absolute path before invoking core logic.


##### `resolve_turn_environment_selections`  (lines 544–573)

```
fn resolve_turn_environment_selections(
    thread_manager: &ThreadManager,
    environments: Option<Vec<TurnEnvironmentParams>>,
) -> Result<Option<Vec<TurnEnvironmentSelection>>, JSONRPCErrorError>
```

**Purpose**: Transforms protocol turn-environment parameters into validated core environment selections. It enforces absolute path syntax and delegates semantic validation to `ThreadManager`.

**Data flow**: Accepts a `&ThreadManager` and optional `Vec<TurnEnvironmentParams>`; returns `Ok(None)` when absent, otherwise allocates a vector, for each environment extracts `environment_id`, infers path convention from `cwd`, converts it to a path URI, returns `invalid_request` if the path is not absolute POSIX/Windows syntax, builds `TurnEnvironmentSelection { environment_id, cwd }`, then calls `thread_manager.validate_environment_selections(&selections)` and maps any failure through `environment_selection_error`, finally returning `Ok(Some(selections))`.

**Call relations**: Called by turn-start style request handlers before they pass environment selections into core turn execution.

*Call graph*: calls 1 internal fn (validate_environment_selections); 1 external calls (with_capacity).


##### `resolve_runtime_workspace_roots`  (lines 575–583)

```
fn resolve_runtime_workspace_roots(workspace_roots: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf>
```

**Purpose**: Deduplicates runtime workspace roots while preserving their original order.

**Data flow**: Consumes a `Vec<AbsolutePathBuf>`, iterates in order, pushes each root into a new vector only if no equal root is already present, and returns the deduplicated vector.

**Call relations**: Used by request handlers that accept workspace-root lists and need stable, duplicate-free inputs for downstream processing.

*Call graph*: 1 external calls (new).


##### `build_api_turns_from_rollout_items`  (lines 609–617)

```
fn build_api_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn>
```

**Purpose**: Reconstructs protocol `Turn` history from rollout items, ignoring non-persisted items.

**Data flow**: Creates a `ThreadHistoryBuilder`, iterates over `items: &[RolloutItem]`, feeds only those for which `is_persisted_rollout_item(item)` is true into `builder.handle_rollout_item`, then returns `builder.finish()` as `Vec<Turn>`.

**Call relations**: Used by thread/history response code when converting stored rollout state into API-visible turn structures.

*Call graph*: calls 1 internal fn (new); 1 external calls (is_persisted_rollout_item).


### `app-server/src/request_processors/request_errors.rs`

`util` · `request handling`

This file contains a single helper, `environment_selection_error`, used by request-processing code that validates or resolves environment selections. Its behavior is intentionally asymmetric: if the underlying `CodexErr` is already `CodexErr::InvalidRequest(message)`, the helper forwards that message directly as an `invalid_request` JSON-RPC error so clients see the precise validation problem they caused.

For every other `CodexErr` variant, the helper constructs an internal error with additional context: `failed to validate environment selections: {err}`. That design prevents lower-level operational failures from being misreported as client mistakes while still preserving the original error text for debugging. Because the file imports `super::*`, it relies on the surrounding request-processor module for `CodexErr`, `JSONRPCErrorError`, and the `invalid_request` / `internal_error` constructors.

The file is deliberately tiny, but it centralizes a subtle policy choice: environment-selection failures are only client-visible when the core layer explicitly classified them that way.

#### Function details

##### `environment_selection_error`  (lines 3–8)

```
fn environment_selection_error(err: CodexErr) -> JSONRPCErrorError
```

**Purpose**: Converts a `CodexErr` from environment-selection validation into the JSON-RPC error shape expected by request handlers. It preserves explicit invalid-request semantics and contextualizes all other failures as internal errors.

**Data flow**: Consumes `err: CodexErr`, pattern-matches it, and returns `invalid_request(message)` when the variant is `CodexErr::InvalidRequest(message)`. For any other variant, it formats `failed to validate environment selections: {err}` and wraps that string with `internal_error`.

**Call relations**: Used as a shared error-policy helper by request-processing code that resolves environment selections; it does not delegate further beyond formatting and the standard error constructors.

*Call graph*: 1 external calls (format!).


### `app-server/src/request_processors/catalog_processor.rs`

`domain_logic` · `request handling`

This processor groups read-mostly catalog endpoints behind `CatalogRequestProcessor`, which holds outgoing transport, skills watcher, auth/thread/config managers, the base config, and a workspace-settings cache. Several small pure helpers convert core data into protocol shapes: `skills_to_info` maps skill metadata plus disabled-path state into API `SkillMetadata`, `hooks_to_info` maps hook list entries into `HookMetadata`, and `errors_to_info` converts skill load errors into protocol error records.

The request methods are thin adapters around internal response builders. `list_models` delegates to the shared `supported_models` helper and paginates by numeric cursor. `experimental_feature_list_response` optionally loads thread-specific config, combines feature-stage metadata from the global `FEATURES` registry with current config enablement, and suppresses Apps/Plugins enablement when workspace Codex plugins are disabled. `permission_profile_list_response` loads effective config layers for either a supplied cwd or the default stack, converts them to `ConfigToml`, prepends built-in permission profiles, appends configured profiles sorted by ID, and paginates.

The richer logic is in skills and hooks. `skills_list_response` resolves each requested cwd (defaulting to `config.cwd`), reloads config once, checks workspace plugin enablement, then concurrently processes up to five cwd entries at a time: resolving cwd-specific config layers, computing effective plugin skill roots, loading skills through the skills manager, and returning per-cwd entries with both skills and load errors while preserving original cwd order. `hooks_list_response` similarly loads config per cwd, conditionally includes plugin hook sources only when both the Plugins feature and workspace setting allow them, and runs `codex_hooks::list_hooks` to produce hooks, warnings, or per-cwd errors. Mutation endpoints update skill config via `ConfigEditsBuilder` or register runtime extra roots and broadcast `SkillsChanged`.

#### Function details

##### `skills_to_info`  (lines 18–62)

```
fn skills_to_info(
    skills: &[codex_core::skills::SkillMetadata],
    disabled_paths: &HashSet<AbsolutePathBuf>,
) -> Vec<codex_app_server_protocol::SkillMetadata>
```

**Purpose**: Converts core skill metadata into protocol skill metadata while marking each skill enabled or disabled based on its path.

**Data flow**: Takes a slice of `codex_core::skills::SkillMetadata` and a `HashSet<AbsolutePathBuf>` of disabled paths, maps each skill into `codex_app_server_protocol::SkillMetadata`, clones descriptive fields, converts optional interface and dependency structures field-by-field, sets `enabled` to the inverse of membership in `disabled_paths`, and returns the collected vector.

**Call relations**: Used by `skills_list_response` after the skills manager returns loaded skills and disabled-path information.

*Call graph*: 1 external calls (iter).


##### `hooks_to_info`  (lines 64–85)

```
fn hooks_to_info(hooks: &[codex_hooks::HookListEntry]) -> Vec<HookMetadata>
```

**Purpose**: Converts hook list entries from the hooks subsystem into protocol `HookMetadata` values.

**Data flow**: Takes a slice of `codex_hooks::HookListEntry`, clones/copies each field into a `HookMetadata` struct including source, trust status, display order, and management flags, and returns the resulting vector.

**Call relations**: Used by `hooks_list_response` when building each cwd’s hook list entry.

*Call graph*: called by 1 (hooks_list_response); 1 external calls (iter).


##### `errors_to_info`  (lines 87–97)

```
fn errors_to_info(
    errors: &[codex_core::skills::SkillError],
) -> Vec<codex_app_server_protocol::SkillErrorInfo>
```

**Purpose**: Converts skill-loading errors into protocol-facing error records.

**Data flow**: Takes a slice of `codex_core::skills::SkillError`, maps each to `SkillErrorInfo { path: err.path.to_path_buf(), message: err.message.clone() }`, and returns the vector.

**Call relations**: Used by `skills_list_response` to expose per-cwd skill load failures.

*Call graph*: 1 external calls (iter).


##### `CatalogRequestProcessor::new`  (lines 100–118)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        skills_watcher: Arc<SkillsWatcher>,
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        config: Ar
```

**Purpose**: Constructs the catalog request processor from its shared subsystem dependencies.

**Data flow**: Stores the provided outgoing sender, skills watcher, auth/thread/config managers, base config, and workspace-settings cache into `Self` and returns it.

**Call relations**: Called during request-processor assembly at startup.

*Call graph*: called by 1 (new).


##### `CatalogRequestProcessor::skills_list`  (lines 120–127)

```
async fn skills_list(
        &self,
        params: SkillsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing skills.

**Data flow**: Takes `SkillsListParams`, awaits `skills_list_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for `skills/list`.

*Call graph*: calls 1 internal fn (skills_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::hooks_list`  (lines 129–136)

```
async fn hooks_list(
        &self,
        params: HooksListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing hooks.

**Data flow**: Takes `HooksListParams`, awaits `hooks_list_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for `hooks/list`.

*Call graph*: calls 1 internal fn (hooks_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::skills_config_write`  (lines 138–145)

```
async fn skills_config_write(
        &self,
        params: SkillsConfigWriteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for mutating skill enablement configuration.

**Data flow**: Takes `SkillsConfigWriteParams`, awaits `skills_config_write_response_inner`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for `skills/config/write`.

*Call graph*: calls 1 internal fn (skills_config_write_response_inner); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::skills_extra_roots_set`  (lines 147–154)

```
async fn skills_extra_roots_set(
        &self,
        params: SkillsExtraRootsSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for updating runtime extra skill roots.

**Data flow**: Takes `SkillsExtraRootsSetParams`, awaits `skills_extra_roots_set_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for runtime skill-root updates.

*Call graph*: calls 1 internal fn (skills_extra_roots_set_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::model_list`  (lines 156–163)

```
async fn model_list(
        &self,
        params: ModelListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing supported models.

**Data flow**: Takes `ModelListParams`, calls `Self::list_models(self.thread_manager.clone(), params)`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for `model/list`.

*Call graph*: called by 1 (handle_initialized_client_request); 1 external calls (list_models).


##### `CatalogRequestProcessor::experimental_feature_list`  (lines 165–172)

```
async fn experimental_feature_list(
        &self,
        params: ExperimentalFeatureListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing experimental feature flags and their current enablement.

**Data flow**: Takes `ExperimentalFeatureListParams`, awaits `experimental_feature_list_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for experimental feature listing.

*Call graph*: calls 1 internal fn (experimental_feature_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::permission_profile_list`  (lines 174–181)

```
async fn permission_profile_list(
        &self,
        params: PermissionProfileListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing built-in and configured permission profiles.

**Data flow**: Takes `PermissionProfileListParams`, awaits `permission_profile_list_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for permission profile listing.

*Call graph*: calls 1 internal fn (permission_profile_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::collaboration_mode_list`  (lines 183–190)

```
async fn collaboration_mode_list(
        &self,
        params: CollaborationModeListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for listing collaboration modes.

**Data flow**: Takes `CollaborationModeListParams`, calls `Self::list_collaboration_modes(self.thread_manager.clone(), params)`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for collaboration mode listing.

*Call graph*: called by 1 (handle_initialized_client_request); 1 external calls (list_collaboration_modes).


##### `CatalogRequestProcessor::mock_experimental_method`  (lines 192–199)

```
async fn mock_experimental_method(
        &self,
        params: MockExperimentalMethodParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public JSON-RPC adapter for a mock experimental endpoint that simply echoes input.

**Data flow**: Takes `MockExperimentalMethodParams`, awaits `mock_experimental_method_inner`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for the mock experimental method.

*Call graph*: calls 1 internal fn (mock_experimental_method_inner); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::resolve_cwd_config`  (lines 201–214)

```
async fn resolve_cwd_config(
        &self,
        cwd: &Path,
    ) -> Result<(AbsolutePathBuf, ConfigLayerStack), String>
```

**Purpose**: Resolves a cwd to an absolute path and loads the config layer stack that applies there.

**Data flow**: Takes `&Path`, converts it to `AbsolutePathBuf` relative to the current directory, maps path errors to strings, awaits `config_manager.load_config_layers_for_cwd(cwd_abs.clone())`, maps load errors to strings, and returns `(cwd_abs, ConfigLayerStack)`.

**Call relations**: Used by `permission_profile_list_response` and by each per-cwd branch inside `skills_list_response`.

*Call graph*: calls 2 internal fn (load_config_layers_for_cwd, relative_to_current_dir); called by 1 (permission_profile_list_response).


##### `CatalogRequestProcessor::load_latest_config`  (lines 216–224)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the latest effective config and maps failures into JSON-RPC internal errors.

**Data flow**: Takes an optional fallback cwd, awaits `config_manager.load_latest_config(fallback_cwd)`, and returns either the `Config` or `internal_error("failed to reload config: ...")`.

**Call relations**: Used by `experimental_feature_list_response` and `skills_list_response`.

*Call graph*: calls 1 internal fn (load_latest_config); called by 2 (experimental_feature_list_response, skills_list_response).


##### `CatalogRequestProcessor::workspace_codex_plugins_enabled`  (lines 226–246)

```
async fn workspace_codex_plugins_enabled(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> bool
```

**Purpose**: Checks whether workspace settings allow Codex plugins, defaulting to permissive behavior on lookup failure.

**Data flow**: Calls `workspace_settings::codex_plugins_enabled_for_workspace(config, auth, Some(&workspace_settings_cache))`, returns the boolean on success, and on error logs a warning and returns `true`.

**Call relations**: Used by experimental-feature, hooks, and skills listing to gate plugin-derived data.

*Call graph*: calls 1 internal fn (codex_plugins_enabled_for_workspace); called by 3 (experimental_feature_list_response, hooks_list_response, skills_list_response); 1 external calls (warn!).


##### `CatalogRequestProcessor::list_models`  (lines 248–293)

```
async fn list_models(
        thread_manager: Arc<ThreadManager>,
        params: ModelListParams,
    ) -> Result<ModelListResponse, JSONRPCErrorError>
```

**Purpose**: Fetches supported models and paginates them by numeric cursor and optional limit.

**Data flow**: Destructures `ModelListParams`, awaits `supported_models(thread_manager, include_hidden.unwrap_or(false))`, computes total, returns an empty page if total is zero, clamps `limit` to at least 1 and at most total, parses `cursor` as `usize` or returns `invalid_request`, errors if `start > total`, slices the model vector into `data`, computes `next_cursor`, and returns `ModelListResponse`.

**Call relations**: Called by the public `model_list` adapter.

*Call graph*: 2 external calls (new, format!).


##### `CatalogRequestProcessor::list_collaboration_modes`  (lines 295–307)

```
async fn list_collaboration_modes(
        thread_manager: Arc<ThreadManager>,
        params: CollaborationModeListParams,
    ) -> Result<CollaborationModeListResponse, JSONRPCErrorError>
```

**Purpose**: Returns all collaboration modes known to the thread manager as protocol values.

**Data flow**: Ignores the empty params struct, calls `thread_manager.list_collaboration_modes()`, converts each item with `Into::into`, collects them into `data`, and returns `CollaborationModeListResponse { data }`.

**Call relations**: Called by the public `collaboration_mode_list` adapter.


##### `CatalogRequestProcessor::experimental_feature_list_response`  (lines 309–415)

```
async fn experimental_feature_list_response(
        &self,
        params: ExperimentalFeatureListParams,
    ) -> Result<ExperimentalFeatureListResponse, JSONRPCErrorError>
```

**Purpose**: Builds the paginated list of experimental features, including stage metadata and current enablement under config and workspace-plugin constraints.

**Data flow**: Destructures params, loads either thread-specific latest config or global latest config, reads current auth, computes `workspace_codex_plugins_enabled`, maps each feature spec in `FEATURES` into an `ApiExperimentalFeature` by translating `Stage` into API stage/display metadata and computing `enabled` from `config.features.enabled(spec.id)` plus a special gate that disables `Feature::Apps` and `Feature::Plugins` when workspace plugins are disabled, then paginates the resulting vector by numeric cursor/limit and returns `ExperimentalFeatureListResponse`.

**Call relations**: Called by the public `experimental_feature_list` adapter.

*Call graph*: calls 4 internal fn (load_latest_config_for_thread, load_latest_config, workspace_codex_plugins_enabled, from_string); called by 1 (experimental_feature_list); 2 external calls (new, format!).


##### `CatalogRequestProcessor::permission_profile_list_response`  (lines 417–487)

```
async fn permission_profile_list_response(
        &self,
        params: PermissionProfileListParams,
    ) -> Result<PermissionProfileListResponse, JSONRPCErrorError>
```

**Purpose**: Builds the paginated list of built-in and configured permission profiles for either a supplied cwd or the default config stack.

**Data flow**: Destructures params, loads a `ConfigLayerStack` either by resolving the supplied cwd with `resolve_cwd_config` or via `config_manager.load_config_layers(None)`, converts the effective config into `ConfigToml`, seeds a vector with the three built-in profile IDs, extracts configured profiles from `effective_config.permissions.entries`, maps them into `PermissionProfileSummary`, sorts them by ID, appends them, parses and validates cursor/limit, slices the vector, computes `next_cursor`, and returns `PermissionProfileListResponse`.

**Call relations**: Called by the public `permission_profile_list` adapter.

*Call graph*: calls 2 internal fn (load_config_layers, resolve_cwd_config); called by 1 (permission_profile_list); 3 external calls (from, format!, vec!).


##### `CatalogRequestProcessor::mock_experimental_method_inner`  (lines 489–496)

```
async fn mock_experimental_method_inner(
        &self,
        params: MockExperimentalMethodParams,
    ) -> Result<MockExperimentalMethodResponse, JSONRPCErrorError>
```

**Purpose**: Implements the mock experimental endpoint by echoing the provided value.

**Data flow**: Consumes `MockExperimentalMethodParams { value }`, constructs `MockExperimentalMethodResponse { echoed: value }`, and returns it.

**Call relations**: Used only by the public `mock_experimental_method` adapter.

*Call graph*: called by 1 (mock_experimental_method).


##### `CatalogRequestProcessor::skills_list_response`  (lines 498–583)

```
async fn skills_list_response(
        &self,
        params: SkillsListParams,
    ) -> Result<SkillsListResponse, JSONRPCErrorError>
```

**Purpose**: Loads skills for one or more cwd roots, including plugin-provided skill roots when enabled, and returns per-cwd skill/error entries while preserving input order.

**Data flow**: Destructures `SkillsListParams`, defaults empty `cwds` to `self.config.cwd`, reloads latest config once, reads current auth and workspace plugin enablement, obtains skills/plugins managers and default filesystem, then creates a futures stream over enumerated cwd values. For each cwd it resolves cwd-specific config layers with `resolve_cwd_config`; on failure it returns a per-cwd entry containing one error. On success it computes effective plugin skill roots when workspace plugins are enabled, builds `SkillsLoadInput`, awaits `skills_manager.skills_for_cwd(&skills_input, force_reload, fs)`, converts errors via `errors_to_info` and skills via `skills_to_info`, and returns `(index, SkillsListEntry)`. The stream is processed with `buffer_unordered(SKILLS_LIST_CWD_CONCURRENCY)`, then results are sorted back by original index and returned as `SkillsListResponse { data }`.

**Call relations**: Called by the public `skills_list` adapter; it delegates conversion to the helper functions and concurrency control to `buffer_unordered`.

*Call graph*: calls 2 internal fn (load_latest_config, workspace_codex_plugins_enabled); called by 1 (skills_list); 2 external calls (iter, vec!).


##### `CatalogRequestProcessor::skills_extra_roots_set_response`  (lines 585–601)

```
async fn skills_extra_roots_set_response(
        &self,
        params: SkillsExtraRootsSetParams,
    ) -> Result<SkillsExtraRootsSetResponse, JSONRPCErrorError>
```

**Purpose**: Registers runtime extra skill roots, updates the skills manager, and notifies clients that skills changed.

**Data flow**: Consumes `SkillsExtraRootsSetParams { extra_roots }`, passes the roots to `skills_watcher.register_runtime_extra_roots` and `thread_manager.skills_manager().set_extra_roots`, sends `ServerNotification::SkillsChanged`, and returns `SkillsExtraRootsSetResponse {}`.

**Call relations**: Called by the public `skills_extra_roots_set` adapter.

*Call graph*: called by 1 (skills_extra_roots_set); 1 external calls (SkillsChanged).


##### `CatalogRequestProcessor::hooks_list_response`  (lines 604–674)

```
async fn hooks_list_response(
        &self,
        params: HooksListParams,
    ) -> Result<HooksListResponse, JSONRPCErrorError>
```

**Purpose**: Resolves hooks for each requested cwd, including plugin hook sources only when both feature flags and workspace settings allow them.

**Data flow**: Defaults empty `cwds` to `self.config.cwd`, reads current auth and `plugins_manager`, then for each cwd loads config with `config_manager.load_for_cwd(None, ConfigOverrides::default(), Some(cwd.clone()))`; on load failure it appends a `HooksListEntry` containing one error. On success it computes `workspace_codex_plugins_enabled`, derives `plugins_enabled` from both config feature flag and workspace setting, obtains plugin hook sources/warnings from `plugins_manager.plugins_for_config(...).await` when enabled or a default empty outcome otherwise, calls `codex_hooks::list_hooks` with feature/trust/config/plugin inputs, converts hooks via `hooks_to_info`, and appends a `HooksListEntry` with hooks, warnings, and no errors. Finally it returns `HooksListResponse { data }`.

**Call relations**: Called by the public `hooks_list` adapter.

*Call graph*: calls 3 internal fn (load_for_cwd, workspace_codex_plugins_enabled, hooks_to_info); called by 1 (hooks_list); 6 external calls (default, new, list_hooks, default, default, vec!).


##### `CatalogRequestProcessor::skills_config_write_response_inner`  (lines 676–712)

```
async fn skills_config_write_response_inner(
        &self,
        params: SkillsConfigWriteParams,
    ) -> Result<SkillsConfigWriteResponse, JSONRPCErrorError>
```

**Purpose**: Applies a skill enable/disable config edit by path or by name, then clears plugin and skills caches so the change takes effect.

**Data flow**: Destructures `SkillsConfigWriteParams { path, name, enabled }`, validates that exactly one of `path` or non-empty `name` is provided, builds the corresponding `ConfigEdit`, wraps it in a one-element vector, runs `ConfigEditsBuilder::new(&self.config.codex_home).with_edits(edits).apply().await`, and on success clears plugin and skills caches and returns `SkillsConfigWriteResponse { effective_enabled: enabled }`; invalid selector combinations become `invalid_params`, and apply failures become `internal_error`.

**Call relations**: Called by the public `skills_config_write` adapter.

*Call graph*: calls 1 internal fn (new); called by 1 (skills_config_write); 1 external calls (vec!).


### `app-server/src/request_processors/environment_processor.rs`

`domain_logic` · `request handling`

This file defines `EnvironmentRequestProcessor`, which only stores an `Arc<EnvironmentManager>` and exposes one request method. The processor exists so environment-related RPC handling stays consistent with the rest of the request processor architecture even though the underlying behavior is simple.

`environment_add` takes `EnvironmentAddParams`, extracts `environment_id` and `exec_server_url`, and calls `EnvironmentManager::upsert_environment`. Any manager error is converted into a JSON-RPC invalid-request error using the manager’s string form, which indicates these failures are treated as client-supplied bad input rather than internal server faults. On success it returns `Some(EnvironmentAddResponse {}.into())`, meaning this RPC responds synchronously with a concrete payload.

There is no extra validation, caching, or asynchronous background work in this file; all environment semantics live in `EnvironmentManager`. The processor’s role is strictly to expose that mutation through the initialized-client request path.

#### Function details

##### `EnvironmentRequestProcessor::new`  (lines 9–13)

```
fn new(environment_manager: Arc<EnvironmentManager>) -> Self
```

**Purpose**: Constructs the environment request processor with a shared environment manager reference.

**Data flow**: Takes `Arc<EnvironmentManager>`, stores it in the struct, and returns `EnvironmentRequestProcessor`.

**Call relations**: Called during request-processor initialization so environment RPCs can later delegate to the shared manager.

*Call graph*: called by 1 (new).


##### `EnvironmentRequestProcessor::environment_add`  (lines 15–23)

```
async fn environment_add(
        &self,
        params: EnvironmentAddParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Registers or updates an environment entry identified by `environment_id` with its execution server URL.

**Data flow**: Consumes `EnvironmentAddParams`, passes `params.environment_id` and `params.exec_server_url` to `self.environment_manager.upsert_environment`, maps any error to `invalid_request(err.to_string())`, and on success returns `Ok(Some(EnvironmentAddResponse {}.into()))`.

**Call relations**: Invoked by `handle_initialized_client_request` for environment-add RPCs. It is a thin request-layer wrapper over `EnvironmentManager::upsert_environment`.

*Call graph*: called by 1 (handle_initialized_client_request).


### `app-server/src/request_processors/external_agent_config_processor.rs`

`orchestration` · `request handling`

This file defines `ExternalAgentConfigRequestProcessor`, the orchestration layer for external-agent migration. Construction wires together an `ExternalAgentConfigService` for config/plugin detection and import, an `ExternalAgentSessionImporter` for session migration, a `ConfigRequestProcessor` for runtime cache refreshes, optional `StateDbHandle` for history persistence, and the outgoing notification channel.

`detect` asks the migration service to scan home/cwd locations and converts each core migration item into protocol form, including nested details for plugins, sessions, MCP servers, hooks, subagents, and commands. `import` is the central workflow: it generates a UUID import id, determines whether imported item types require runtime refresh, validates requested session imports up front to deduplicate canonical source paths and record missing/invalid selections, then performs the non-session import synchronously through `import_external_agent_config`. It immediately sends the RPC response containing the import id, streams progress notifications for validation and completed synchronous items, and either finishes with a completion notification or spawns background work.

Background work handles pending session imports and deferred plugin imports concurrently with `tokio::join!`. Each plugin import result is folded into a `CoreImportItemResult`; session imports are delegated to `ExternalAgentSessionImporter`. When background work finishes, plugin-related runtime caches are cleared if needed and a final completion notification is emitted. If a state DB is available, completion notifications are also recorded as normalized success/failure records.

The remainder of the file is conversion glue: protocol/core item-type mapping, aggregation of per-item results into per-type completion payloads, decoding persisted history records back into protocol responses, and a small predicate deciding which migration item types require runtime refresh. A notable design choice is that session imports are excluded from the synchronous `migration_service.import` call and handled separately because they require validation, thread persistence, and bounded background concurrency.

#### Function details

##### `ExternalAgentConfigRequestProcessor::new`  (lines 74–100)

```
fn new(args: ExternalAgentConfigRequestProcessorArgs) -> Self
```

**Purpose**: Builds the migration request processor and its session importer from the supplied server, config, thread, and filesystem dependencies.

**Data flow**: Consumes `ExternalAgentConfigRequestProcessorArgs`, destructures all fields, constructs `ExternalAgentSessionImporter::new(...)` using `codex_home`, `thread_manager`, `thread_store`, `config_manager`, and `arg0_paths`, constructs `ExternalAgentConfigService::new(codex_home)`, and returns `ExternalAgentConfigRequestProcessor` holding those components plus the outgoing sender, config processor, thread manager, and optional state DB.

**Call relations**: Called during server setup. It wires together the lower-level migration service and session importer that later power detect/import requests.

*Call graph*: calls 2 internal fn (new, new); called by 1 (new); 1 external calls (clone).


##### `ExternalAgentConfigRequestProcessor::detect`  (lines 102–194)

```
async fn detect(
        &self,
        params: ExternalAgentConfigDetectParams,
    ) -> Result<ExternalAgentConfigDetectResponse, JSONRPCErrorError>
```

**Purpose**: Scans for importable external-agent artifacts and returns them in protocol form.

**Data flow**: Consumes `ExternalAgentConfigDetectParams`, passes `include_home` and `cwds` into `self.migration_service.detect(...)`, maps service errors to `internal_error`, then converts each returned core migration item and nested details into `ExternalAgentConfigMigrationItem` and related protocol structs before returning `ExternalAgentConfigDetectResponse { items }`.

**Call relations**: Invoked by `handle_initialized_client_request` for detection RPCs. It delegates filesystem/discovery logic to `ExternalAgentConfigService` and performs only protocol translation locally.

*Call graph*: calls 1 internal fn (detect); called by 1 (handle_initialized_client_request).


##### `ExternalAgentConfigRequestProcessor::import`  (lines 196–334)

```
async fn import(
        &self,
        request_id: ConnectionRequestId,
        params: ExternalAgentConfigImportParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts an external-agent import, sends an immediate import id response, streams progress notifications, and optionally continues plugin/session imports in the background before sending a completion notification.

**Data flow**: Consumes a `ConnectionRequestId` and `ExternalAgentConfigImportParams`. It generates `import_id`, computes booleans for runtime refresh, presence of migration items, and plugin imports, validates pending session imports, and awaits `import_external_agent_config`. If imported item types affect runtime sources, it calls `self.config_processor.handle_config_mutation().await`. It then sends `ExternalAgentConfigImportResponse { import_id }` on the outgoing channel. If there are no items, it returns immediately. Otherwise it emits progress notifications for session validation and each synchronous item result, accumulating them in `completed_item_results`. If there are no pending plugin/session imports, it sends a completed notification immediately. If background work remains, it clones needed state and spawns a task that imports sessions and plugins concurrently, emits progress per result, clears plugin/skills caches when plugin imports occurred, appends background results to the accumulated list, and finally calls `send_completed_import_notification`.

**Call relations**: Called by `handle_initialized_client_request` for import RPCs. It orchestrates the whole migration flow, delegating synchronous non-session import to `import_external_agent_config`, session prevalidation to `validate_pending_session_imports`, plugin result folding to `apply_plugin_outcome_to_item_result`, and notification emission to the helper functions.

*Call graph*: calls 8 internal fn (record_import_error, handle_config_mutation, import_external_agent_config, validate_pending_session_imports, apply_plugin_outcome_to_item_result, migration_items_need_runtime_refresh, send_completed_import_notification, send_import_progress); called by 1 (handle_initialized_client_request); 7 external calls (clone, new, new_v4, new, clone, join!, spawn).


##### `ExternalAgentConfigRequestProcessor::read_import_histories`  (lines 336–353)

```
async fn read_import_histories(
        &self,
    ) -> Result<ExternalAgentConfigImportHistoriesReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads previously recorded import completion histories from the state database and converts them into protocol responses.

**Data flow**: Reads `self.state_db`, returning an internal error if absent; awaits `external_agent_config_import_history_records()`, maps DB errors to `internal_error`, converts each record with `protocol_import_history`, collects the results, and returns `ExternalAgentConfigImportHistoriesReadResponse { data }`.

**Call relations**: Invoked by `handle_initialized_client_request` for history-read RPCs. It depends on the optional state DB and the local record-to-protocol conversion helpers.

*Call graph*: called by 1 (handle_initialized_client_request).


##### `ExternalAgentConfigRequestProcessor::validate_pending_session_imports`  (lines 355–419)

```
fn validate_pending_session_imports(
        &self,
        params: &ExternalAgentConfigImportParams,
    ) -> (Vec<CoreSessionMigration>, Option<CoreImportItemResult>)
```

**Purpose**: Extracts requested session migrations, verifies each selected session still resolves to a detected source path, deduplicates them by canonical path, and records validation failures.

**Data flow**: Reads `ExternalAgentConfigImportParams`, filters `migration_items` down to session items, flattens nested session details into `Vec<CoreSessionMigration>`, and returns early with no result if empty. Otherwise it creates a `CoreImportItemResult` for validation, iterates sessions, asks `self.migration_service.external_agent_session_source_path(&session.path)` for a canonical source path, records `session_missing` or `session_source_path` errors when lookup fails, and uses a `HashSet` to keep only the first occurrence of each canonical path. Returns the deduplicated sessions plus the validation result object.

**Call relations**: Called at the start of `import` before any background session import begins. It ensures the later session importer only sees valid, unique source sessions and that validation failures are surfaced as progress events.

*Call graph*: calls 2 internal fn (external_agent_session_source_path, record_import_error); called by 1 (import); 4 external calls (new, new, new, format!).


##### `ExternalAgentConfigRequestProcessor::import_external_agent_config`  (lines 421–520)

```
async fn import_external_agent_config(
        &self,
        params: ExternalAgentConfigImportParams,
    ) -> Result<CoreImportOutcome, JSONRPCErrorError>
```

**Purpose**: Runs the core migration service for all requested migration items except sessions, translating protocol items into the service’s internal migration model.

**Data flow**: Consumes `ExternalAgentConfigImportParams`, filters out `Sessions` items, maps each remaining protocol migration item and nested details into `CoreMigrationItem` and related core detail structs, awaits `self.migration_service.import(...)`, and maps any service error into `internal_error(err.to_string())`.

**Call relations**: Used by `import` as the synchronous import phase. Session items are intentionally excluded because they are handled separately by `ExternalAgentSessionImporter`.

*Call graph*: calls 1 internal fn (import); called by 1 (import).


##### `ExternalAgentConfigRequestProcessor::complete_pending_plugin_import`  (lines 522–533)

```
async fn complete_pending_plugin_import(
        &self,
        pending_plugin_import: PendingPluginImport,
    ) -> Result<PluginImportOutcome, JSONRPCErrorError>
```

**Purpose**: Completes a deferred plugin import for one pending plugin migration item.

**Data flow**: Consumes `PendingPluginImport`, passes its optional cwd and details into `self.migration_service.import_plugins(...)`, awaits the result, and maps service errors into `internal_error`.

**Call relations**: Called from the background task spawned by `import` for each pending plugin import discovered during the synchronous migration phase.

*Call graph*: calls 1 internal fn (import_plugins).


##### `send_import_progress`  (lines 536–549)

```
async fn send_import_progress(
    outgoing: &OutgoingMessageSender,
    import_id: &str,
    item_result: &CoreImportItemResult,
)
```

**Purpose**: Emits a server notification containing progress for a single import item result.

**Data flow**: Takes `&OutgoingMessageSender`, `&str import_id`, and `&CoreImportItemResult`, converts the item result into one `ProtocolImportTypeResult` with `protocol_import_type_result`, wraps it in `ExternalAgentConfigImportProgressNotification`, and sends it as `ServerNotification::ExternalAgentConfigImportProgress`.

**Call relations**: Used by `import` for validation and synchronous item results, and again inside the spawned background task for session and plugin progress updates.

*Call graph*: calls 1 internal fn (send_server_notification); called by 1 (import); 2 external calls (ExternalAgentConfigImportProgress, vec!).


##### `send_completed_import_notification`  (lines 551–572)

```
async fn send_completed_import_notification(
    outgoing: &OutgoingMessageSender,
    state_db: Option<&StateDbHandle>,
    import_id: String,
    item_results: &[CoreImportItemResult],
)
```

**Purpose**: Builds the final completion notification, optionally records it in the state database, and sends it to the client.

**Data flow**: Takes the outgoing sender, optional state DB reference, owned `import_id`, and slice of `CoreImportItemResult`; builds a protocol notification with `completed_notification`, optionally awaits `record_completed_import_notification` and logs a warning on failure, then sends `ServerNotification::ExternalAgentConfigImportCompleted(notification)`.

**Call relations**: Called by `import` both for fully synchronous imports and after background work completes. It centralizes final aggregation, persistence, and notification emission.

*Call graph*: calls 3 internal fn (send_server_notification, completed_notification, record_completed_import_notification); called by 1 (import); 2 external calls (ExternalAgentConfigImportCompleted, warn!).


##### `record_completed_import_notification`  (lines 574–613)

```
async fn record_completed_import_notification(
    state_db: &StateDbHandle,
    notification: &ExternalAgentConfigImportCompletedNotification,
) -> anyhow::Result<()>
```

**Purpose**: Persists a completed import notification into the state database as normalized success and failure records.

**Data flow**: Consumes `&StateDbHandle` and `&ExternalAgentConfigImportCompletedNotification`, iterates all `item_type_results`, converts successes and failures into `ExternalAgentConfigImportSuccessRecord` and `ExternalAgentConfigImportFailureRecord` by serializing/deserializing item types through serde JSON, then awaits `state_db.record_external_agent_config_import_completed(import_id, &successes, &failures)` and returns an `anyhow::Result<()>`.

**Call relations**: Used only by `send_completed_import_notification` when state persistence is available.

*Call graph*: called by 1 (send_completed_import_notification); 1 external calls (record_external_agent_config_import_completed).


##### `protocol_import_history`  (lines 615–635)

```
fn protocol_import_history(
    record: codex_state::ExternalAgentConfigImportHistoryRecord,
) -> Result<ExternalAgentConfigImportHistory, JSONRPCErrorError>
```

**Purpose**: Converts one persisted import history record from the state layer into the protocol response shape.

**Data flow**: Consumes `codex_state::ExternalAgentConfigImportHistoryRecord`, maps `successes` with `protocol_import_success_record`, maps `failures` with `protocol_import_failure_record`, and returns `ExternalAgentConfigImportHistory` containing the import id, completion timestamp, and converted vectors.

**Call relations**: Used by `read_import_histories` while translating database records into API responses.


##### `protocol_import_success_record`  (lines 637–646)

```
fn protocol_import_success_record(
    record: ExternalAgentConfigImportSuccessRecord,
) -> Result<ProtocolImportSuccess, JSONRPCErrorError>
```

**Purpose**: Converts a persisted success record into the protocol success type, decoding the stored item-type string.

**Data flow**: Consumes `ExternalAgentConfigImportSuccessRecord`, converts `record.item_type` with `protocol_import_record_item_type`, copies cwd/source/target, and returns `ProtocolImportSuccess`.

**Call relations**: Called by `protocol_import_history` for each persisted success entry.

*Call graph*: calls 1 internal fn (protocol_import_record_item_type).


##### `protocol_import_failure_record`  (lines 648–659)

```
fn protocol_import_failure_record(
    record: ExternalAgentConfigImportFailureRecord,
) -> Result<ProtocolImportFailure, JSONRPCErrorError>
```

**Purpose**: Converts a persisted failure record into the protocol failure type, decoding the stored item-type string.

**Data flow**: Consumes `ExternalAgentConfigImportFailureRecord`, converts `record.item_type` with `protocol_import_record_item_type`, copies error metadata and location fields, and returns `ProtocolImportFailure`.

**Call relations**: Called by `protocol_import_history` for each persisted failure entry.

*Call graph*: calls 1 internal fn (protocol_import_record_item_type).


##### `protocol_import_record_item_type`  (lines 661–669)

```
fn protocol_import_record_item_type(
    item_type: String,
) -> Result<ExternalAgentConfigMigrationItemType, JSONRPCErrorError>
```

**Purpose**: Decodes a stored item-type string back into the protocol migration item type enum.

**Data flow**: Consumes a `String`, wraps it as `serde_json::Value::String`, attempts `serde_json::from_value` into `ExternalAgentConfigMigrationItemType`, and maps decode failures into `internal_error("failed to decode import item type ...")`.

**Call relations**: Used by both persisted-record conversion helpers so history reads can reconstruct typed item categories.

*Call graph*: called by 2 (protocol_import_failure_record, protocol_import_success_record); 2 external calls (String, from_value).


##### `completed_notification`  (lines 671–718)

```
fn completed_notification(
    import_id: String,
    item_results: &[CoreImportItemResult],
) -> ExternalAgentConfigImportCompletedNotification
```

**Purpose**: Aggregates many per-item import results into a final completion notification grouped by migration item type and sorted in a stable display order.

**Data flow**: Consumes an owned `import_id` and slice of `CoreImportItemResult`. For each item result it converts raw errors and successes into protocol forms, finds or creates the matching `ProtocolImportTypeResult` bucket by protocol item type, extends that bucket, then sorts the buckets by a hard-coded item-type order before returning `ExternalAgentConfigImportCompletedNotification`.

**Call relations**: Called by `send_completed_import_notification` to build the final payload sent to clients and optionally persisted.

*Call graph*: calls 1 internal fn (protocol_migration_item_type); called by 1 (send_completed_import_notification); 1 external calls (new).


##### `protocol_import_type_result`  (lines 720–734)

```
fn protocol_import_type_result(item_result: &CoreImportItemResult) -> ProtocolImportTypeResult
```

**Purpose**: Converts one core item result into a protocol item-type result containing all successes and failures for that item.

**Data flow**: Takes `&CoreImportItemResult`, maps its `item_type` with `protocol_migration_item_type`, converts `successes` with `protocol_import_success`, converts `raw_errors` with `protocol_import_raw_error`, and returns `ProtocolImportTypeResult`.

**Call relations**: Used by `send_import_progress` for incremental progress notifications.

*Call graph*: calls 1 internal fn (protocol_migration_item_type).


##### `protocol_import_success`  (lines 736–745)

```
fn protocol_import_success(
    success: &crate::config::external_agent_config::ExternalAgentConfigImportSuccess,
) -> ProtocolImportSuccess
```

**Purpose**: Converts an in-memory core import success into the protocol success structure.

**Data flow**: Consumes a borrowed core success record, maps its item type with `protocol_migration_item_type`, clones cwd/source/target, and returns `ProtocolImportSuccess`.

**Call relations**: Used by both `completed_notification` and `protocol_import_type_result` when building protocol payloads.

*Call graph*: calls 1 internal fn (protocol_migration_item_type).


##### `protocol_import_raw_error`  (lines 747–756)

```
fn protocol_import_raw_error(raw_error: &CoreImportRawError) -> ProtocolImportFailure
```

**Purpose**: Converts an in-memory raw import error into the protocol failure structure.

**Data flow**: Consumes `&CoreImportRawError`, maps item type with `protocol_migration_item_type`, clones error metadata and source fields, and returns `ProtocolImportFailure`.

**Call relations**: Used by both `completed_notification` and `protocol_import_type_result` when exposing failures to clients.

*Call graph*: calls 1 internal fn (protocol_migration_item_type).


##### `protocol_migration_item_type`  (lines 758–774)

```
fn protocol_migration_item_type(
    item_type: CoreMigrationItemType,
) -> ExternalAgentConfigMigrationItemType
```

**Purpose**: Maps the core migration item type enum into the protocol migration item type enum.

**Data flow**: Consumes `CoreMigrationItemType`, matches each variant (`Config`, `Skills`, `AgentsMd`, `Plugins`, `McpServerConfig`, `Subagents`, `Hooks`, `Commands`, `Sessions`), and returns the corresponding `ExternalAgentConfigMigrationItemType`.

**Call relations**: Shared by all protocol conversion helpers that need to expose item categories.

*Call graph*: called by 4 (completed_notification, protocol_import_raw_error, protocol_import_success, protocol_import_type_result).


##### `apply_plugin_outcome_to_item_result`  (lines 776–786)

```
fn apply_plugin_outcome_to_item_result(
    item_result: &mut CoreImportItemResult,
    plugin_outcome: PluginImportOutcome,
)
```

**Purpose**: Folds a plugin import outcome into a mutable item result by recording successes and raw errors.

**Data flow**: Takes `&mut CoreImportItemResult` and `PluginImportOutcome`; for each succeeded plugin id it records a success using the id as both source and target, and for each raw error it records that error into the item result.

**Call relations**: Called from the background plugin-import loop inside `import` after `complete_pending_plugin_import` succeeds.

*Call graph*: called by 1 (import); 2 external calls (record_error, record_success).


##### `migration_items_need_runtime_refresh`  (lines 788–800)

```
fn migration_items_need_runtime_refresh(items: &[ExternalAgentConfigMigrationItem]) -> bool
```

**Purpose**: Determines whether any requested migration item type affects runtime-loaded sources and therefore requires cache refresh after import.

**Data flow**: Consumes a slice of `ExternalAgentConfigMigrationItem`, iterates it, and returns `true` if any item type is one of `Config`, `Skills`, `McpServerConfig`, `Hooks`, `Commands`, or `Plugins`; otherwise returns `false`.

**Call relations**: Used at the start of `import` to decide whether to call `config_processor.handle_config_mutation()` after the synchronous import phase.

*Call graph*: called by 1 (import); 1 external calls (iter).


### `app-server/src/request_processors/mcp_processor.rs`

`orchestration` · `request handling / background MCP tasks`

This processor is the request-facing layer for MCP integration. It holds shared auth, thread, outgoing-message, and config-reload services, and most public methods are wrappers that either return a typed response immediately or kick off background work and return no direct payload. A small constant, `MCP_TOOL_THREAD_ID_META_KEY`, standardizes how thread identity is injected into MCP tool-call metadata.

Several helpers normalize common prerequisites. `load_latest_config` reloads current config with consistent internal-error mapping, while `load_thread` parses a string `thread_id` into `ThreadId` and resolves the live `CodexThread`, returning `invalid_request` for malformed or missing threads. `mcp_server_refresh_response` simply queues a strict MCP refresh through `crate::mcp_refresh`.

The OAuth login path is more involved: it reloads config, computes effective servers using current auth, verifies that the named server exists and uses `StreamableHttp`, optionally discovers scopes, resolves final scopes, and starts an OAuth login flow with callback-port/url and credential-store settings from config. It returns the authorization URL immediately, then spawns a task that waits for completion and emits `ServerNotification::McpServerOauthLoginCompleted`.

Status listing and resource reads support both thread-scoped and threadless execution. They derive runtime MCP config either from a thread's runtime config or from the global MCP manager, build an `McpRuntimeContext` using the environment manager and config cwd as stdio fallback, then spawn tasks that compute snapshots or read resources and send results via `OutgoingMessageSender::send_result`. Status listing also implements cursor/limit pagination over merged server names from server info, auth statuses, resources, and templates, rejecting malformed cursors and out-of-range starts. Tool calls always require a thread; before dispatching to `thread.call_mcp_tool`, the processor injects the thread ID into the optional JSON metadata object when that metadata is absent or already an object.

#### Function details

##### `McpRequestProcessor::new`  (lines 14–26)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        config_manager: ConfigManager,
    ) -> Self
```

**Purpose**: Constructs the MCP request processor from shared auth, thread, outgoing-message, and config-reload services.

**Data flow**: Takes `Arc<AuthManager>`, `Arc<ThreadManager>`, `Arc<OutgoingMessageSender>`, and `ConfigManager`; stores them in the struct; returns the processor.

**Call relations**: Created during processor setup so MCP-related RPCs can share the same auth, thread, and outbound messaging infrastructure.

*Call graph*: called by 1 (new).


##### `McpRequestProcessor::mcp_server_oauth_login`  (lines 28–35)

```
async fn mcp_server_oauth_login(
        &self,
        params: McpServerOauthLoginParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the MCP OAuth-login RPC and wraps the typed login-start response into a generic client payload.

**Data flow**: Consumes `McpServerOauthLoginParams`, awaits `self.mcp_server_oauth_login_response(params)`, converts the resulting `McpServerOauthLoginResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates the actual login setup and notification spawning to `mcp_server_oauth_login_response`.

*Call graph*: calls 1 internal fn (mcp_server_oauth_login_response); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_refresh`  (lines 37–44)

```
async fn mcp_server_refresh(
        &self,
        params: Option<()>,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the MCP refresh RPC and returns an empty success payload once a strict refresh has been queued.

**Data flow**: Accepts an unused `Option<()>`, awaits `self.mcp_server_refresh_response(params)`, converts `McpServerRefreshResponse` into `ClientResponsePayload`, and wraps it in `Some(...)`.

**Call relations**: Reached from initialized request dispatch and delegates the refresh queueing to `mcp_server_refresh_response`.

*Call graph*: calls 1 internal fn (mcp_server_refresh_response); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_status_list`  (lines 46–54)

```
async fn mcp_server_status_list(
        &self,
        request_id: &ConnectionRequestId,
        params: ListMcpServerStatusParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Starts asynchronous MCP server status collection and indicates that the eventual result will be sent separately.

**Data flow**: Accepts a borrowed `ConnectionRequestId` and `ListMcpServerStatusParams`, awaits `self.list_mcp_server_status(request_id, params)`, discards the unit success value, and returns `Ok(None)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates to `list_mcp_server_status`, which spawns the actual status task and later sends the result through the outgoing channel.

*Call graph*: calls 1 internal fn (list_mcp_server_status); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_resource_read`  (lines 56–64)

```
async fn mcp_resource_read(
        &self,
        request_id: &ConnectionRequestId,
        params: McpResourceReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Starts an asynchronous MCP resource read and returns no immediate payload because the result is sent later.

**Data flow**: Accepts a borrowed `ConnectionRequestId` and `McpResourceReadParams`, awaits `self.read_mcp_resource(request_id, params)`, discards the unit success value, and returns `Ok(None)`.

**Call relations**: Invoked by initialized request dispatch; it delegates to `read_mcp_resource`, which chooses thread-scoped or threadless execution and sends the eventual result asynchronously.

*Call graph*: calls 1 internal fn (read_mcp_resource); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_tool_call`  (lines 66–74)

```
async fn mcp_server_tool_call(
        &self,
        request_id: &ConnectionRequestId,
        params: McpServerToolCallParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Starts an asynchronous MCP tool invocation on a thread and returns no immediate payload.

**Data flow**: Accepts a borrowed `ConnectionRequestId` and `McpServerToolCallParams`, awaits `self.call_mcp_server_tool(request_id, params)`, discards the unit success value, and returns `Ok(None)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates to `call_mcp_server_tool`, which spawns the actual thread-bound tool call and later sends the result.

*Call graph*: calls 1 internal fn (call_mcp_server_tool); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_refresh_response`  (lines 76–84)

```
async fn mcp_server_refresh_response(
        &self,
        _params: Option<()>,
    ) -> Result<McpServerRefreshResponse, JSONRPCErrorError>
```

**Purpose**: Queues a strict refresh of MCP server state and returns an empty typed response on success.

**Data flow**: Ignores its optional unit params, awaits `crate::mcp_refresh::queue_strict_refresh(&self.thread_manager, &self.config_manager)`, maps any failure to `internal_error`, and returns `McpServerRefreshResponse {}`.

**Call relations**: This helper is only called by `mcp_server_refresh` to keep the public RPC wrapper small.

*Call graph*: calls 1 internal fn (queue_strict_refresh); called by 1 (mcp_server_refresh).


##### `McpRequestProcessor::load_latest_config`  (lines 86–94)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the latest effective config with consistent JSON-RPC internal-error mapping.

**Data flow**: Accepts an optional fallback `PathBuf`, awaits `self.config_manager.load_latest_config(fallback_cwd)`, returns the `Config` on success, or maps errors to `internal_error(format!(...))`.

**Call relations**: Used by OAuth login, status listing, and threadless resource reads whenever MCP behavior must reflect current configuration.

*Call graph*: calls 1 internal fn (load_latest_config); called by 3 (list_mcp_server_status, mcp_server_oauth_login_response, read_mcp_resource).


##### `McpRequestProcessor::load_thread`  (lines 96–110)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Parses a thread ID string and resolves the corresponding live `CodexThread`.

**Data flow**: Takes `&str thread_id`, parses it with `ThreadId::from_string`, returning `invalid_request` on parse failure; then awaits `thread_manager.get_thread(thread_id)` and returns `(ThreadId, Arc<CodexThread>)` or `invalid_request("thread not found: ...")` if lookup fails.

**Call relations**: This helper is shared by status listing, resource reads, and tool calls whenever a request is scoped to an existing thread.

*Call graph*: calls 1 internal fn (from_string); called by 3 (call_mcp_server_tool, list_mcp_server_status, read_mcp_resource).


##### `McpRequestProcessor::mcp_server_oauth_login_response`  (lines 112–197)

```
async fn mcp_server_oauth_login_response(
        &self,
        params: McpServerOauthLoginParams,
    ) -> Result<McpServerOauthLoginResponse, JSONRPCErrorError>
```

**Purpose**: Validates the target MCP server, resolves OAuth scopes and transport details, starts the login flow, and schedules a completion notification.

**Data flow**: Consumes `McpServerOauthLoginParams { name, scopes, timeout_secs }`, reloads config, reads current auth, computes effective servers from the MCP manager, selects the named configured server, verifies it uses `McpServerTransportConfig::StreamableHttp`, optionally discovers scopes, resolves final scopes, and awaits `perform_oauth_login_return_url(...)` using config-driven credential-store and callback settings. It returns `McpServerOauthLoginResponse { authorization_url }` immediately, and spawns a task that waits on the returned handle and sends `ServerNotification::McpServerOauthLoginCompleted` with success/error fields through `outgoing`.

**Call relations**: Only called by `mcp_server_oauth_login`. It orchestrates several lower-level MCP and OAuth helpers, then hands off completion reporting to a detached task.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (mcp_server_oauth_login); 4 external calls (clone, McpServerOauthLoginCompleted, format!, spawn).


##### `McpRequestProcessor::list_mcp_server_status`  (lines 199–249)

```
async fn list_mcp_server_status(
        &self,
        request_id: &ConnectionRequestId,
        params: ListMcpServerStatusParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Builds the runtime MCP configuration for either a specific thread or the global context, then spawns a task to compute and send paginated server status.

**Data flow**: Accepts a borrowed `ConnectionRequestId` and `ListMcpServerStatusParams`. It clones the request ID and outgoing sender, optionally resolves a thread via `load_thread`, reloads config either globally or with `load_latest_config_for_thread`, derives runtime MCP config from the thread or MCP manager, reads current auth and environment manager, constructs `McpRuntimeContext::new(environment_manager, config.cwd.to_path_buf())`, spawns `list_mcp_server_status_task(...)`, and returns `Ok(())` immediately.

**Call relations**: This is called by `mcp_server_status_list` because status collection may be expensive and should complete asynchronously via `send_result` rather than inline.

*Call graph*: calls 4 internal fn (load_latest_config_for_thread, load_latest_config, load_thread, new); called by 1 (mcp_server_status_list); 4 external calls (clone, list_mcp_server_status_task, clone, spawn).


##### `McpRequestProcessor::list_mcp_server_status_task`  (lines 251–268)

```
async fn list_mcp_server_status_task(
        outgoing: Arc<OutgoingMessageSender>,
        request_id: ConnectionRequestId,
        params: ListMcpServerStatusParams,
        mcp_config: codex_mcp::M
```

**Purpose**: Runs the status snapshot computation and sends the resulting success or error back to the original request ID.

**Data flow**: Takes owned `outgoing`, `ConnectionRequestId`, params, `codex_mcp::McpConfig`, optional auth, and `McpRuntimeContext`; awaits `Self::list_mcp_server_status_response(...)`; then sends that `Result<ListMcpServerStatusResponse, JSONRPCErrorError>` through `outgoing.send_result(request_id, result)`.

**Call relations**: Spawned by `list_mcp_server_status` so the request handler can return immediately while the actual snapshot work proceeds in the background.

*Call graph*: 1 external calls (list_mcp_server_status_response).


##### `McpRequestProcessor::list_mcp_server_status_response`  (lines 270–351)

```
async fn list_mcp_server_status_response(
        request_id: String,
        params: ListMcpServerStatusParams,
        mcp_config: codex_mcp::McpConfig,
        auth: Option<CodexAuth>,
        runt
```

**Purpose**: Collects an MCP status snapshot, merges server names across multiple snapshot maps, applies cursor/limit pagination, and builds the protocol response page.

**Data flow**: Consumes a stringified request ID, `ListMcpServerStatusParams`, runtime `McpConfig`, optional auth, and `McpRuntimeContext`. It maps protocol detail to `McpSnapshotDetail`, awaits `collect_mcp_server_status_snapshot_with_detail(...)`, merges and deduplicates server names from `server_infos`, `auth_statuses`, `resources`, and `resource_templates`, parses and validates the optional cursor, computes page bounds from `limit`, slices the names, and maps each name into `McpServerStatus` with defaulted tools/resources/templates/auth status. It returns `ListMcpServerStatusResponse { data, next_cursor }` or `invalid_request` for malformed/out-of-range cursors.

**Call relations**: Called only by `list_mcp_server_status_task`; it contains the pure response-building logic separated from task spawning and result sending.

*Call graph*: 1 external calls (format!).


##### `McpRequestProcessor::read_mcp_resource`  (lines 353–404)

```
async fn read_mcp_resource(
        &self,
        request_id: &ConnectionRequestId,
        params: McpResourceReadParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Chooses thread-scoped or threadless MCP resource reading, spawns the appropriate async work, and arranges for the result to be sent later.

**Data flow**: Consumes a borrowed `ConnectionRequestId` and `McpResourceReadParams { thread_id, server, uri }`. If `thread_id` is present, it resolves the thread with `load_thread`, clones the request ID, and spawns a task that awaits `thread.read_mcp_resource(&server, &uri)` and forwards the result to `send_mcp_resource_read_response`. Otherwise it reloads config, derives global runtime MCP config and auth, builds `McpRuntimeContext`, spawns a task that awaits `read_mcp_resource_without_thread(...)`, serializes the result to `serde_json::Value`, and forwards it to `send_mcp_resource_read_response`. It returns `Ok(())` immediately.

**Call relations**: This helper is called by `mcp_resource_read` because resource reads may involve remote MCP work and should complete asynchronously through the outgoing result channel.

*Call graph*: calls 3 internal fn (load_latest_config, load_thread, new); called by 1 (mcp_resource_read); 4 external calls (clone, send_mcp_resource_read_response, clone, spawn).


##### `McpRequestProcessor::send_mcp_resource_read_response`  (lines 406–421)

```
async fn send_mcp_resource_read_response(
        outgoing: Arc<OutgoingMessageSender>,
        request_id: ConnectionRequestId,
        result: anyhow::Result<serde_json::Value>,
    )
```

**Purpose**: Normalizes a generic JSON-valued MCP resource-read result into the typed protocol response and sends it back to the client.

**Data flow**: Takes owned `outgoing`, `ConnectionRequestId`, and `anyhow::Result<serde_json::Value>`. It maps any upstream error to `internal_error(format!("{error:#}"))`, attempts to deserialize the JSON value into `McpResourceReadResponse`, maps deserialization failures to `internal_error`, and sends the final `Result<McpResourceReadResponse, JSONRPCErrorError>` via `outgoing.send_result`.

**Call relations**: Used by both branches of `read_mcp_resource` so thread-based and threadless reads share one response-normalization and sending path.


##### `McpRequestProcessor::call_mcp_server_tool`  (lines 423–443)

```
async fn call_mcp_server_tool(
        &self,
        request_id: &ConnectionRequestId,
        params: McpServerToolCallParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Resolves the target thread, injects thread metadata into the tool-call meta object, and spawns the actual MCP tool invocation.

**Data flow**: Consumes a borrowed `ConnectionRequestId` and `McpServerToolCallParams`. It clones `thread_id`, resolves the thread with `load_thread`, augments `params.meta` via `with_mcp_tool_call_thread_id_meta`, clones the request ID, and spawns a task that awaits `thread.call_mcp_tool(&params.server, &params.tool, params.arguments, meta)`, maps the success value into `McpServerToolCallResponse`, maps errors to `internal_error`, and sends the result through `outgoing.send_result`.

**Call relations**: Called by `mcp_server_tool_call`; unlike status/resource reads, tool calls always require a thread and therefore always go through `load_thread` first.

*Call graph*: calls 2 internal fn (load_thread, with_mcp_tool_call_thread_id_meta); called by 1 (mcp_server_tool_call); 3 external calls (clone, clone, spawn).


##### `with_mcp_tool_call_thread_id_meta`  (lines 446–468)

```
fn with_mcp_tool_call_thread_id_meta(
    meta: Option<serde_json::Value>,
    thread_id: &str,
) -> Option<serde_json::Value>
```

**Purpose**: Ensures MCP tool-call metadata contains the originating thread ID when the metadata is absent or already a JSON object.

**Data flow**: Accepts `Option<serde_json::Value>` and `&str thread_id`. If `meta` is `Some(Object(map))`, it inserts `"threadId" -> String(thread_id)` and returns the updated object. If `meta` is `None`, it creates a new object containing only that key/value. For any other JSON type, it returns the original value unchanged.

**Call relations**: This helper is called by `call_mcp_server_tool` so downstream MCP tools can reliably inspect thread identity without the caller having to provide it explicitly.

*Call graph*: called by 1 (call_mcp_server_tool); 3 external calls (new, Object, String).


### `app-server/src/request_processors/turn_processor.rs`

`orchestration` · `request handling for turn/thread mutation APIs and realtime/review flows`

This file defines `TurnRequestProcessor`, the main driver for thread-scoped interactive requests. The struct is dependency-heavy by design: it holds auth, thread and watch managers, outgoing messaging, analytics, config/config-manager state, pending unload tracking, thread-state management, a semaphore for thread-list state, and a skills watcher. Most public methods are thin wrappers that call an internal async method and convert the typed response into `ClientResponsePayload`.

The core request paths are `turn_start_inner`, `turn_steer_inner`, `thread_settings_update_inner`, `thread_inject_items_response_inner`, realtime conversation methods, review-start methods, and `turn_interrupt_inner`. `turn_start_inner` resolves the thread id, blocks direct input to multi-agent-v2 spawned subagents, enforces a total text-character limit across `V2UserInput`, records client app info, resolves cwd/environment overrides, builds validated thread-settings overrides, submits `Op::UserInput`, optionally kicks off memory startup work when there was actual input, records the request-to-turn mapping, and returns an in-progress `Turn` shell. `build_thread_settings_overrides` is the most intricate helper: it rejects `permissions` combined with `sandboxPolicy`, optionally loads config to resolve named permission profiles, rejects startup-warning fallbacks for explicit settings updates, previews overrides against the thread for validation, and returns a core `ThreadSettingsOverrides`.

Other notable logic includes `review_request_from_target`, which trims and validates review targets before constructing a `ReviewRequest` plus user-facing hint; detached review startup, which forks a new thread from flushed parent history and emits a `ThreadStarted` notification with turns stripped; realtime conversation setup, which first ensures a conversation listener is attached and that the thread has the `RealtimeConversation` feature enabled; and interrupt handling, which records pending interrupt requests in thread state so the eventual `TurnAborted` event can complete the JSON-RPC response. The file also contains compatibility logic for Xcode 26.4 MCP elicitation auto-denial and a helper to normalize collaboration-mode presets by filling in missing developer instructions from built-in presets.

#### Function details

##### `map_additional_context`  (lines 27–48)

```
fn map_additional_context(
    additional_context: Option<HashMap<String, AdditionalContextEntry>>,
) -> BTreeMap<String, CoreAdditionalContextEntry>
```

**Purpose**: Converts API additional-context entries into the core protocol representation. It preserves keys and values while translating the enum for trust/application origin.

**Data flow**: Accepts `Option<HashMap<String, AdditionalContextEntry>>`, defaults missing input to an empty map, converts each entry into `CoreAdditionalContextEntry` with mapped `kind`, and returns a `BTreeMap<String, CoreAdditionalContextEntry>`.

**Call relations**: Used by `turn_start_inner` and `turn_steer_inner` before submitting user input to core so request-side context matches core's expected types.

*Call graph*: called by 2 (turn_start_inner, turn_steer_inner).


##### `TurnRequestProcessor::new`  (lines 68–96)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        analytics_events_client: AnalyticsEventsClient,
```

**Purpose**: Constructs a fully wired `TurnRequestProcessor` from its service dependencies. It stores all collaborators needed for thread mutation and listener orchestration.

**Data flow**: Takes arcs/managers/clients/semaphore as arguments and returns `Self` with those fields assigned directly.

**Call relations**: Called during app-server initialization when request processors are assembled.

*Call graph*: called by 1 (new).


##### `TurnRequestProcessor::turn_start`  (lines 98–113)

```
async fn turn_start(
        &self,
        request_id: ConnectionRequestId,
        params: TurnStartParams,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<
```

**Purpose**: Public JSON-RPC entrypoint for starting a turn. It delegates to the internal implementation and wraps the typed response as `ClientResponsePayload`.

**Data flow**: Receives request id, `TurnStartParams`, and optional client name/version; awaits `turn_start_inner`; converts the `TurnStartResponse` into `ClientResponsePayload`; and returns it inside `Some`.

**Call relations**: Invoked by initialized-request dispatch for the `turn/start` method. All substantive work happens in `turn_start_inner`.

*Call graph*: calls 1 internal fn (turn_start_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_inject_items`  (lines 115–122)

```
async fn thread_inject_items(
        &self,
        params: ThreadInjectItemsParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for injecting response items into an existing thread. It wraps the internal typed response for JSON-RPC dispatch.

**Data flow**: Accepts `ThreadInjectItemsParams`, awaits `thread_inject_items_response_inner`, converts the response into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by request dispatch for the thread item-injection API.

*Call graph*: calls 1 internal fn (thread_inject_items_response_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_settings_update`  (lines 124–132)

```
async fn thread_settings_update(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadSettingsUpdateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for queued thread settings updates. It delegates validation and submission to the internal method.

**Data flow**: Accepts a request id reference and `ThreadSettingsUpdateParams`, awaits `thread_settings_update_inner`, converts the typed response into `ClientResponsePayload`, and returns it.

**Call relations**: Invoked by initialized-request dispatch for `thread/settings/update`.

*Call graph*: calls 1 internal fn (thread_settings_update_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::turn_steer`  (lines 134–142)

```
async fn turn_steer(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnSteerParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for steering input into an active turn. It wraps the internal response for JSON-RPC transport.

**Data flow**: Accepts request id reference and `TurnSteerParams`, awaits `turn_steer_inner`, converts the response into `ClientResponsePayload`, and returns it.

**Call relations**: Called by request dispatch for `turn/steer`; the internal method performs validation and core submission.

*Call graph*: calls 1 internal fn (turn_steer_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::turn_interrupt`  (lines 144–152)

```
async fn turn_interrupt(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnInterruptParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for interrupting startup or an active turn. It preserves the internal method's ability to return either an immediate response or `None` pending a later event.

**Data flow**: Accepts request id reference and `TurnInterruptParams`, awaits `turn_interrupt_inner`, and maps any typed response into `ClientResponsePayload`.

**Call relations**: Invoked by request dispatch for `turn/interrupt`.

*Call graph*: calls 1 internal fn (turn_interrupt_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_start`  (lines 154–162)

```
async fn thread_realtime_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for starting a realtime conversation session on a thread. It delegates to the internal implementation and wraps the optional response.

**Data flow**: Accepts request id reference and `ThreadRealtimeStartParams`, awaits `thread_realtime_start_inner`, and maps any typed response into `ClientResponsePayload`.

**Call relations**: Called by request dispatch for realtime conversation startup.

*Call graph*: calls 1 internal fn (thread_realtime_start_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_append_audio`  (lines 164–172)

```
async fn thread_realtime_append_audio(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendAudioParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCE
```

**Purpose**: Public entrypoint for appending audio frames to a realtime conversation. It is a thin wrapper over the internal method.

**Data flow**: Accepts request id reference and `ThreadRealtimeAppendAudioParams`, awaits `thread_realtime_append_audio_inner`, and maps the optional typed response into `ClientResponsePayload`.

**Call relations**: Invoked by request dispatch for realtime audio append.

*Call graph*: calls 1 internal fn (thread_realtime_append_audio_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_append_text`  (lines 174–182)

```
async fn thread_realtime_append_text(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendTextParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErr
```

**Purpose**: Public entrypoint for appending text input to a realtime conversation. It delegates all validation and submission to the internal method.

**Data flow**: Accepts request id reference and `ThreadRealtimeAppendTextParams`, awaits `thread_realtime_append_text_inner`, and maps the optional response into `ClientResponsePayload`.

**Call relations**: Called by request dispatch for realtime text append.

*Call graph*: calls 1 internal fn (thread_realtime_append_text_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_append_speech`  (lines 184–192)

```
async fn thread_realtime_append_speech(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendSpeechParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRP
```

**Purpose**: Public entrypoint for appending synthesized speech text to a realtime conversation. It wraps the internal implementation.

**Data flow**: Accepts request id reference and `ThreadRealtimeAppendSpeechParams`, awaits `thread_realtime_append_speech_inner`, and maps the optional response into `ClientResponsePayload`.

**Call relations**: Invoked by request dispatch for realtime speech append.

*Call graph*: calls 1 internal fn (thread_realtime_append_speech_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_stop`  (lines 194–202)

```
async fn thread_realtime_stop(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStopParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for stopping a realtime conversation. It preserves the internal method's optional-response behavior.

**Data flow**: Accepts request id reference and `ThreadRealtimeStopParams`, awaits `thread_realtime_stop_inner`, and maps the optional typed response into `ClientResponsePayload`.

**Call relations**: Called by request dispatch for realtime conversation shutdown.

*Call graph*: calls 1 internal fn (thread_realtime_stop_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_list_voices`  (lines 204–213)

```
async fn thread_realtime_list_voices(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Returns the built-in list of supported realtime voices without touching thread state. This is a pure capability query.

**Data flow**: Constructs `ThreadRealtimeListVoicesResponse { voices: RealtimeVoicesList::builtin() }`, converts it into `ClientResponsePayload`, and returns it inside `Some`.

**Call relations**: Invoked directly by request dispatch for the voice-listing API; unlike other realtime methods it does not delegate to an inner helper.

*Call graph*: calls 1 internal fn (builtin); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::review_start`  (lines 215–223)

```
async fn review_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ReviewStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public entrypoint for starting a review, either inline on the current thread or detached into a forked review thread. It suppresses a direct JSON-RPC payload because the response is emitted asynchronously.

**Data flow**: Accepts request id reference and `ReviewStartParams`, awaits `review_start_inner`, and maps success to `None`.

**Call relations**: Called by request dispatch for review startup; `review_start_inner` decides inline vs detached behavior.

*Call graph*: calls 1 internal fn (review_start_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::track_error_response`  (lines 225–237)

```
fn track_error_response(
        &self,
        request_id: &ConnectionRequestId,
        error: &JSONRPCErrorError,
        error_type: Option<AnalyticsJsonRpcError>,
    )
```

**Purpose**: Records a JSON-RPC error response with analytics metadata tied to the originating connection and request id. It centralizes error telemetry emission.

**Data flow**: Reads `request_id.connection_id` and `request_id.request_id`, clones the `JSONRPCErrorError`, and forwards them plus optional `AnalyticsJsonRpcError` classification to `analytics_events_client.track_error_response`.

**Call relations**: Called from validation and submission paths such as `ensure_direct_input_allowed`, `turn_start_inner`, and `turn_steer_inner` whenever the processor wants analytics for a rejected request.

*Call graph*: calls 1 internal fn (track_error_response); called by 3 (ensure_direct_input_allowed, turn_start_inner, turn_steer_inner); 1 external calls (clone).


##### `TurnRequestProcessor::load_thread`  (lines 239–254)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Resolves a string thread id from the API into a parsed `ThreadId` and a live `CodexThread` handle. It converts parse and lookup failures into JSON-RPC invalid-request errors.

**Data flow**: Accepts `&str`, parses it with `ThreadId::from_string`, fetches the thread from `thread_manager.get_thread`, and returns `(ThreadId, Arc<CodexThread>)` or a `JSONRPCErrorError` describing invalid id or missing thread.

**Call relations**: Shared prerequisite for most thread-scoped operations including turn start/steer/interrupt, settings update, item injection, review start, and realtime preparation.

*Call graph*: calls 1 internal fn (from_string); called by 7 (prepare_realtime_conversation_thread, review_start_inner, thread_inject_items_response_inner, thread_settings_update_inner, turn_interrupt_inner, turn_start_inner, turn_steer_inner).


##### `TurnRequestProcessor::ensure_direct_input_allowed`  (lines 256–273)

```
async fn ensure_direct_input_allowed(
        &self,
        request_id: &ConnectionRequestId,
        thread: &CodexThread,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Rejects direct app-server input for multi-agent v2 sub-agent threads spawned via `ThreadSpawn`. This enforces a protocol invariant about where input may originate.

**Data flow**: Reads `thread.multi_agent_version()` and `thread.config_snapshot().await.session_source`; if the thread is multi-agent v2 and the source is `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { .. })`, it builds an invalid-request error with the fixed compatibility message, records analytics via `track_error_response`, and returns `Err`; otherwise returns `Ok(())`.

**Call relations**: Called early by `turn_start_inner` and `turn_steer_inner` before any input submission occurs.

*Call graph*: calls 2 internal fn (track_error_response, multi_agent_version); called by 2 (turn_start_inner, turn_steer_inner); 1 external calls (matches!).


##### `TurnRequestProcessor::normalize_collaboration_mode`  (lines 275–290)

```
fn normalize_collaboration_mode(
        &self,
        mut collaboration_mode: CollaborationMode,
    ) -> CollaborationMode
```

**Purpose**: Fills in missing developer instructions on a collaboration mode from built-in presets. It preserves caller-supplied instructions and only backfills when absent and non-empty in the preset.

**Data flow**: Takes a mutable `CollaborationMode`, checks whether `settings.developer_instructions` is `None`, searches `builtin_collaboration_mode_presets()` for a preset matching `mode`, extracts non-empty preset instructions if available, writes them into the mode, and returns the possibly modified value.

**Call relations**: Used by `build_thread_settings_overrides` so collaboration-mode overrides sent to core are normalized before preview/validation.


##### `TurnRequestProcessor::review_request_from_target`  (lines 292–341)

```
fn review_request_from_target(
        target: ApiReviewTarget,
    ) -> Result<(ReviewRequest, String), JSONRPCErrorError>
```

**Purpose**: Validates and normalizes an API review target, converts it into the core review target type, and computes the user-facing hint text. It trims whitespace and rejects empty branch/sha/instructions fields.

**Data flow**: Consumes `ApiReviewTarget`, trims and validates variant-specific strings, rebuilds a cleaned API target, maps it to `CoreReviewTarget`, computes a hint with `codex_core::review_prompts::user_facing_hint`, constructs `ReviewRequest { target, user_facing_hint: Some(hint.clone()) }`, and returns `(review_request, hint)`.

**Call relations**: Called by `review_start_inner` before deciding whether to launch an inline or detached review.

*Call graph*: 1 external calls (user_facing_hint).


##### `TurnRequestProcessor::request_trace_context`  (lines 343–348)

```
async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<codex_protocol::protocol::W3cTraceContext>
```

**Purpose**: Fetches any W3C trace context associated with the current request from the outgoing-message layer. This lets core operations inherit request tracing.

**Data flow**: Accepts a request id reference, awaits `self.outgoing.request_trace_context(request_id)`, and returns `Option<W3cTraceContext>`.

**Call relations**: Used by `submit_core_op`, `turn_start_inner`, and detached review creation whenever a core operation should be submitted with request trace metadata.

*Call graph*: called by 3 (start_detached_review, submit_core_op, turn_start_inner).


##### `TurnRequestProcessor::submit_core_op`  (lines 350–359)

```
async fn submit_core_op(
        &self,
        request_id: &ConnectionRequestId,
        thread: &CodexThread,
        op: Op,
    ) -> CodexResult<String>
```

**Purpose**: Submits a core `Op` to a thread with the current request's trace context attached. It is the common bridge from request handlers into core thread execution.

**Data flow**: Accepts request id reference, `&CodexThread`, and `Op`; awaits `request_trace_context`; then calls `thread.submit_with_trace(op, trace_context)` and returns the resulting `CodexResult<String>`.

**Call relations**: Shared by settings updates, review starts, realtime operations, interrupts, and other mutation paths to avoid duplicating trace-context plumbing.

*Call graph*: calls 2 internal fn (request_trace_context, submit_with_trace); called by 9 (start_detached_review, start_inline_review, thread_realtime_append_audio_inner, thread_realtime_append_speech_inner, thread_realtime_append_text_inner, thread_realtime_start_inner, thread_realtime_stop_inner, thread_settings_update_inner, turn_interrupt_inner).


##### `TurnRequestProcessor::input_too_large_error`  (lines 361–371)

```
fn input_too_large_error(actual_chars: usize) -> JSONRPCErrorError
```

**Purpose**: Constructs a structured invalid-params error for oversized user input. The error includes machine-readable metadata for UI handling.

**Data flow**: Accepts the actual character count, creates an invalid-params error mentioning `MAX_USER_INPUT_TEXT_CHARS`, sets `error.data` to JSON containing `input_error_code`, `max_chars`, and `actual_chars`, and returns the error.

**Call relations**: Used only by `validate_v2_input_limit` to standardize oversized-input failures.

*Call graph*: 2 external calls (format!, json!).


##### `TurnRequestProcessor::validate_v2_input_limit`  (lines 373–379)

```
fn validate_v2_input_limit(items: &[V2UserInput]) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Enforces the maximum total text length across all `V2UserInput` items in a request. It sums per-item character counts rather than counting items.

**Data flow**: Accepts a slice of `V2UserInput`, sums `V2UserInput::text_char_count()` across the slice, returns `Err(input_too_large_error(actual_chars))` if the total exceeds `MAX_USER_INPUT_TEXT_CHARS`, otherwise returns `Ok(())`.

**Call relations**: Called by both `turn_start_inner` and `turn_steer_inner` before submitting input to core.

*Call graph*: 2 external calls (input_too_large_error, iter).


##### `TurnRequestProcessor::turn_start_inner`  (lines 381–499)

```
async fn turn_start_inner(
        &self,
        request_id: ConnectionRequestId,
        params: TurnStartParams,
        app_server_client_name: Option<String>,
        app_server_client_version: O
```

**Purpose**: Implements the full `turn/start` flow: validate thread and input, resolve environment/settings overrides, submit user input to core, optionally trigger memory startup work, and return an in-progress turn shell. It is the main turn-creation path.

**Data flow**: Consumes request id, `TurnStartParams`, and optional client name/version. It loads the thread, enforces direct-input restrictions, validates input size, stores app-server client info on the thread, resolves environment selections and cwd, maps `V2UserInput` into core input items, maps additional context, builds thread settings overrides, submits `Op::UserInput` with trace context and optional client user message id, optionally starts memories startup when input was non-empty, records the request-to-turn mapping in `outgoing`, and returns `TurnStartResponse` containing a synthetic in-progress `Turn` with no loaded items.

**Call relations**: Called by the public `turn_start` wrapper. It delegates to `load_thread`, `ensure_direct_input_allowed`, `map_additional_context`, `build_environment_override`, `build_thread_settings_overrides`, and `request_trace_context`, and emits analytics on validation failures via `track_error_response`.

*Call graph*: calls 7 internal fn (build_environment_override, build_thread_settings_overrides, ensure_direct_input_allowed, load_thread, request_trace_context, track_error_response, map_additional_context); called by 1 (turn_start); 6 external calls (clone, set_app_server_client_info, validate_v2_input_limit, Input, start_memories_startup_task, vec!).


##### `TurnRequestProcessor::build_environment_override`  (lines 501–532)

```
async fn build_environment_override(
        &self,
        thread: &CodexThread,
        cwd: Option<AbsolutePathBuf>,
        environment_selections: Option<Vec<TurnEnvironmentSelection>>,
    ) ->
```

**Purpose**: Builds `TurnEnvironmentSelections` from optional cwd and explicit environment selections, preserving legacy fallback cwd behavior. It handles all combinations of absent/present cwd and environment lists.

**Data flow**: Accepts a thread handle, optional absolute cwd, and optional vector of `TurnEnvironmentSelection`. If both are absent it returns `None`; if only cwd is present it asks `thread_manager.default_environment_selections(&cwd)` and returns `TurnEnvironmentSelections::new(cwd, defaults)`; if explicit selections are present it chooses a fallback cwd from the provided cwd, from the local environment selection's cwd, or from `thread.config_snapshot().await.cwd()`, then returns `TurnEnvironmentSelections::new(fallback_cwd, selections)`.

**Call relations**: Used by `turn_start_inner` and `thread_settings_update_inner` before building thread settings overrides.

*Call graph*: calls 2 internal fn (config_snapshot, new); called by 2 (thread_settings_update_inner, turn_start_inner).


##### `TurnRequestProcessor::build_thread_settings_overrides`  (lines 534–686)

```
async fn build_thread_settings_overrides(
        &self,
        thread: &CodexThread,
        params: ThreadSettingsBuildParams,
    ) -> Result<codex_protocol::protocol::ThreadSettingsOverrides, JSO
```

**Purpose**: Validates and constructs core `ThreadSettingsOverrides` from API request fields, including permission-profile resolution through config loading when `permissions` is specified. It also previews overrides against the thread to reject invalid combinations before submission.

**Data flow**: Consumes a thread handle and `ThreadSettingsBuildParams`. It rejects simultaneous `sandbox_policy` and `permissions`, normalizes collaboration mode, optionally snapshots thread config when permission resolution is needed, computes whether any overrides are present, resolves runtime workspace roots and approval enums, converts sandbox policy, and if `permissions` is set loads config for the effective cwd/workspace roots using `config_manager.load_for_cwd`. From that config it extracts `permission_profile`, `active_permission_profile`, and `profile_workspace_roots`, rejecting startup-warning fallback cases. If any override exists, it calls `thread.preview_thread_settings_overrides(...)` to validate the assembled override set. Finally it returns a populated core `ThreadSettingsOverrides`.

**Call relations**: Called by `turn_start_inner` and `thread_settings_update_inner`. It is the central validation/translation layer for request-side thread settings changes.

*Call graph*: calls 3 internal fn (load_for_cwd, config_snapshot, preview_thread_settings_overrides); called by 2 (thread_settings_update_inner, turn_start_inner); 2 external calls (default, format!).


##### `TurnRequestProcessor::thread_settings_update_inner`  (lines 688–730)

```
async fn thread_settings_update_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadSettingsUpdateParams,
    ) -> Result<ThreadSettingsUpdateResponse, JSONRPCErrorEr
```

**Purpose**: Implements `thread/settings/update` by resolving cwd/environment overrides, validating requested settings, and submitting a `ThreadSettings` op only when something actually changed. It returns an empty acknowledgment payload.

**Data flow**: Loads the thread from `params.thread_id`, resolves optional cwd, builds environment overrides with no explicit environment selections, builds validated thread settings overrides from the request fields, compares them to `ThreadSettingsOverrides::default()`, conditionally submits `Op::ThreadSettings { thread_settings }` via `submit_core_op`, and returns `ThreadSettingsUpdateResponse {}`.

**Call relations**: Called by the public `thread_settings_update` wrapper. It relies on `load_thread`, `build_environment_override`, `build_thread_settings_overrides`, and `submit_core_op`.

*Call graph*: calls 4 internal fn (build_environment_override, build_thread_settings_overrides, load_thread, submit_core_op); called by 1 (thread_settings_update); 1 external calls (default).


##### `TurnRequestProcessor::thread_inject_items_response_inner`  (lines 732–757)

```
async fn thread_inject_items_response_inner(
        &self,
        params: ThreadInjectItemsParams,
    ) -> Result<ThreadInjectItemsResponse, JSONRPCErrorError>
```

**Purpose**: Validates arbitrary JSON response items from the API and injects them into an existing thread. It translates malformed items and core invalid-request errors into JSON-RPC invalid-request responses.

**Data flow**: Loads the target thread, deserializes each `params.items` JSON value into `ResponseItem` while annotating the failing index on error, calls `thread.inject_response_items(items).await`, maps `CodexErr::InvalidRequest` to `invalid_request` and other errors to `internal_error`, and returns `ThreadInjectItemsResponse {}`.

**Call relations**: Called by the public `thread_inject_items` wrapper for the item-injection API.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_inject_items).


##### `TurnRequestProcessor::set_app_server_client_info`  (lines 759–776)

```
async fn set_app_server_client_info(
        thread: &CodexThread,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorEr
```

**Purpose**: Stores app-server client identity/version on the thread and applies a compatibility hack for Xcode 26.4 MCP elicitation behavior. It converts core failures into internal JSON-RPC errors.

**Data flow**: Accepts a thread handle and optional client name/version, computes `mcp_elicitations_auto_deny` via `xcode_26_4_mcp_elicitations_auto_deny`, calls `thread.set_app_server_client_info(...)`, and returns `Ok(())` or an internal error.

**Call relations**: Called by `turn_start_inner` before submitting user input so downstream core behavior can depend on client identity.

*Call graph*: calls 2 internal fn (xcode_26_4_mcp_elicitations_auto_deny, set_app_server_client_info).


##### `TurnRequestProcessor::turn_steer_inner`  (lines 778–885)

```
async fn turn_steer_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnSteerParams,
    ) -> Result<TurnSteerResponse, JSONRPCErrorError>
```

**Purpose**: Implements steering additional input into an active turn, with validation for expected turn id, input size, and steerability. It maps detailed core steer errors into user-facing invalid-request messages and analytics categories.

**Data flow**: Loads the thread, enforces direct-input restrictions, rejects empty `expected_turn_id`, records the request-to-turn mapping, validates input size, maps `V2UserInput` and additional context, calls `thread.steer_input(...)`, and on success returns `TurnSteerResponse { turn_id }`. On `SteerInputError`, it builds an invalid-request error message, optionally serializes a `TurnError` into `error.data` for non-steerable turns, records analytics, and returns the error.

**Call relations**: Called by the public `turn_steer` wrapper. It shares helpers with turn start (`load_thread`, `ensure_direct_input_allowed`, `map_additional_context`, `validate_v2_input_limit`) but has its own steer-specific error mapping.

*Call graph*: calls 4 internal fn (ensure_direct_input_allowed, load_thread, track_error_response, map_additional_context); called by 1 (turn_steer); 2 external calls (validate_v2_input_limit, Input).


##### `TurnRequestProcessor::prepare_realtime_conversation_thread`  (lines 887–916)

```
async fn prepare_realtime_conversation_thread(
        &self,
        request_id: &ConnectionRequestId,
        thread_id: &str,
    ) -> Result<Option<(ThreadId, Arc<CodexThread>)>, JSONRPCErrorError
```

**Purpose**: Loads a thread, ensures the requesting connection is attached to its listener, and verifies the thread supports realtime conversation. It returns `None` when the connection closed before attachment completed.

**Data flow**: Accepts request id reference and thread id string, loads the thread, calls `ensure_conversation_listener(thread_id, connection_id, false)`, returns `Ok(None)` on `ConnectionClosed`, propagates listener errors, checks `thread.enabled(Feature::RealtimeConversation)`, and returns `Some((ThreadId, Arc<CodexThread>))` on success.

**Call relations**: Shared prerequisite for all realtime conversation methods so they all enforce listener attachment and feature gating consistently.

*Call graph*: calls 2 internal fn (ensure_conversation_listener, load_thread); called by 5 (thread_realtime_append_audio_inner, thread_realtime_append_speech_inner, thread_realtime_append_text_inner, thread_realtime_start_inner, thread_realtime_stop_inner); 1 external calls (format!).


##### `TurnRequestProcessor::thread_realtime_start_inner`  (lines 918–956)

```
async fn thread_realtime_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStartParams,
    ) -> Result<Option<ThreadRealtimeStartResponse>, JSONRPCEr
```

**Purpose**: Starts a realtime conversation session on a thread by translating API parameters into `ConversationStartParams` and submitting the corresponding core op. It returns no payload when the connection closed during listener attachment.

**Data flow**: Calls `prepare_realtime_conversation_thread`; if it returns `None`, returns `Ok(None)`. Otherwise it builds `ConversationStartParams` from request fields including architecture, transport, prompt, voice, and startup-context flags, submits `Op::RealtimeConversationStart(...)` via `submit_core_op`, and returns `Some(ThreadRealtimeStartResponse::default())`.

**Call relations**: Called by the public `thread_realtime_start` wrapper after request dispatch.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_start); 2 external calls (default, RealtimeConversationStart).


##### `TurnRequestProcessor::thread_realtime_append_audio_inner`  (lines 958–983)

```
async fn thread_realtime_append_audio_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendAudioParams,
    ) -> Result<Option<ThreadRealtimeAppendAudioR
```

**Purpose**: Appends an audio frame to an active realtime conversation. It shares the same listener/feature preparation path as other realtime methods.

**Data flow**: Prepares the realtime thread with `prepare_realtime_conversation_thread`, returns `Ok(None)` if the connection closed, otherwise submits `Op::RealtimeConversationAudio(ConversationAudioParams { frame: params.audio.into() })` and returns `Some(ThreadRealtimeAppendAudioResponse::default())`.

**Call relations**: Called by the public `thread_realtime_append_audio` wrapper.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_append_audio); 2 external calls (default, RealtimeConversationAudio).


##### `TurnRequestProcessor::thread_realtime_append_text_inner`  (lines 985–1011)

```
async fn thread_realtime_append_text_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendTextParams,
    ) -> Result<Option<ThreadRealtimeAppendTextResp
```

**Purpose**: Appends text input with a role to an active realtime conversation. It is the text analogue of the audio append path.

**Data flow**: Prepares the realtime thread, returns `Ok(None)` on closed connection, otherwise submits `Op::RealtimeConversationText(ConversationTextParams { text, role })` and returns `Some(ThreadRealtimeAppendTextResponse::default())`.

**Call relations**: Called by the public `thread_realtime_append_text` wrapper.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_append_text); 2 external calls (default, RealtimeConversationText).


##### `TurnRequestProcessor::thread_realtime_append_speech_inner`  (lines 1013–1036)

```
async fn thread_realtime_append_speech_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendSpeechParams,
    ) -> Result<Option<ThreadRealtimeAppendSpee
```

**Purpose**: Appends speech text to an active realtime conversation. It wraps the text in `ConversationSpeechParams` and submits the corresponding core op.

**Data flow**: Prepares the realtime thread, returns `Ok(None)` if attachment failed due to closed connection, otherwise submits `Op::RealtimeConversationSpeech(ConversationSpeechParams { text: params.text })` and returns `Some(ThreadRealtimeAppendSpeechResponse::default())`.

**Call relations**: Called by the public `thread_realtime_append_speech` wrapper.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_append_speech); 2 external calls (default, RealtimeConversationSpeech).


##### `TurnRequestProcessor::thread_realtime_stop_inner`  (lines 1038–1055)

```
async fn thread_realtime_stop_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStopParams,
    ) -> Result<Option<ThreadRealtimeStopResponse>, JSONRPCError
```

**Purpose**: Stops an active realtime conversation on a thread. It uses the same preparation path as realtime start/append methods.

**Data flow**: Prepares the realtime thread, returns `Ok(None)` if the connection closed, otherwise submits `Op::RealtimeConversationClose` and returns `Some(ThreadRealtimeStopResponse::default())`.

**Call relations**: Called by the public `thread_realtime_stop` wrapper.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_stop); 1 external calls (default).


##### `TurnRequestProcessor::build_review_turn`  (lines 1057–1082)

```
fn build_review_turn(turn_id: String, display_text: &str) -> Turn
```

**Purpose**: Constructs the synthetic in-progress `Turn` returned to clients when a review starts. If there is display text, it is represented as a synthesized user message item.

**Data flow**: Accepts a `turn_id` and display text. If the text is empty it uses an empty `items` vector; otherwise it creates one `ThreadItem::UserMessage` containing a single `V2UserInput::Text` with empty `text_elements`. It returns a `Turn` with `NotLoaded` items view, `InProgress` status, and no timestamps/error.

**Call relations**: Used by both inline and detached review startup flows before emitting the review-started response.

*Call graph*: 2 external calls (new, vec!).


##### `TurnRequestProcessor::emit_review_started`  (lines 1084–1097)

```
async fn emit_review_started(
        &self,
        request_id: &ConnectionRequestId,
        turn: Turn,
        review_thread_id: String,
    )
```

**Purpose**: Sends the asynchronous `ReviewStartResponse` back to the requesting client. This is separate from the JSON-RPC method return path because review startup responds via outgoing messaging.

**Data flow**: Accepts request id reference, a `Turn`, and the review thread id string; builds `ReviewStartResponse { turn, review_thread_id }`; and sends it through `self.outgoing.send_response(request_id.clone(), response).await`.

**Call relations**: Called by both `start_inline_review` and `start_detached_review` after the review turn has been created.

*Call graph*: called by 2 (start_detached_review, start_inline_review); 1 external calls (clone).


##### `TurnRequestProcessor::start_inline_review`  (lines 1099–1119)

```
async fn start_inline_review(
        &self,
        request_id: &ConnectionRequestId,
        parent_thread: Arc<CodexThread>,
        review_request: ReviewRequest,
        display_text: &str,
```

**Purpose**: Starts a review turn inside the existing parent thread and immediately emits the review-started response. No new thread is created.

**Data flow**: Accepts request id, parent thread handle, `ReviewRequest`, display text, and parent thread id string; submits `Op::Review { review_request }` via `submit_core_op` to get a turn id; builds a synthetic review turn with `build_review_turn`; emits the response with `emit_review_started`; and returns `Ok(())`.

**Call relations**: Chosen by `review_start_inner` when delivery is inline.

*Call graph*: calls 2 internal fn (emit_review_started, submit_core_op); called by 1 (review_start_inner); 1 external calls (build_review_turn).


##### `TurnRequestProcessor::start_detached_review`  (lines 1121–1230)

```
async fn start_detached_review(
        &self,
        request_id: &ConnectionRequestId,
        parent_thread_id: ThreadId,
        parent_thread: Arc<CodexThread>,
        review_request: ReviewRequ
```

**Purpose**: Creates a new review thread forked from the parent thread's flushed history, announces that thread to subscribers, starts the review turn there, and emits the review-started response. This is the detached-review orchestration path.

**Data flow**: Ensures the parent rollout is materialized and flushed, loads parent history, clones config and swaps in `review_model` if configured, calls `thread_manager.fork_thread_from_history(...)` to create a new thread, attempts to attach the requesting connection as a listener, reads the new thread summary and upserts it into `thread_watch_manager`, emits a `ServerNotification::ThreadStarted(thread_started_notification(thread))` if summary loading succeeded, submits `Op::Review { review_request }` on the new thread, builds the synthetic review turn, and sends `ReviewStartResponse` with the new thread id.

**Call relations**: Chosen by `review_start_inner` when delivery is detached. It delegates listener attachment to `ensure_conversation_listener`, summary shaping to `thread_started_notification`, and review response emission to `emit_review_started`.

*Call graph*: calls 6 internal fn (emit_review_started, ensure_conversation_listener, request_trace_context, submit_core_op, loaded_status_for_thread, upsert_thread_silently); called by 1 (review_start_inner); 4 external calls (build_review_turn, ThreadStarted, Resumed, warn!).


##### `TurnRequestProcessor::review_start_inner`  (lines 1232–1268)

```
async fn review_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ReviewStartParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Implements review startup by loading the parent thread, validating the target, and dispatching to inline or detached review creation based on delivery mode. It is the decision point for review orchestration.

**Data flow**: Destructures `ReviewStartParams`, loads the parent thread, converts the API target into `(ReviewRequest, display_text)` with `review_request_from_target`, maps `delivery.unwrap_or(ApiReviewDelivery::Inline)` to core delivery, then awaits either `start_inline_review` or `start_detached_review` and returns `Ok(())`.

**Call relations**: Called by the public `review_start` wrapper.

*Call graph*: calls 3 internal fn (load_thread, start_detached_review, start_inline_review); called by 1 (review_start); 1 external calls (review_request_from_target).


##### `TurnRequestProcessor::turn_interrupt_inner`  (lines 1270–1333)

```
async fn turn_interrupt_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnInterruptParams,
    ) -> Result<Option<TurnInterruptResponse>, JSONRPCErrorError>
```

**Purpose**: Implements interruption of either startup or an active turn, coordinating request bookkeeping with thread state so non-startup interrupts can be answered when `TurnAborted` arrives. It validates that the requested turn matches the active turn when applicable.

**Data flow**: Consumes `TurnInterruptParams`, treats empty `turn_id` as a startup interrupt, loads the thread, and for non-startup interrupts locks thread state to verify there is an active matching turn (or reject if the turn already ended / no active turn), pushes the request id into `pending_interrupts`, and records the request-to-turn mapping. It then submits `Op::Interrupt` via `submit_core_op`. On success it returns `Some(TurnInterruptResponse {})` only for startup interrupts and `None` otherwise. On submission failure it removes the pending interrupt entry for non-startup cases and returns an internal error mentioning whether startup or turn interruption failed.

**Call relations**: Called by the public `turn_interrupt` wrapper. It interacts closely with `thread_state_manager` so later event processing can complete deferred interrupt responses.

*Call graph*: calls 3 internal fn (load_thread, submit_core_op, thread_state); called by 1 (turn_interrupt); 3 external calls (clone, format!, matches!).


##### `TurnRequestProcessor::listener_task_context`  (lines 1335–1347)

```
fn listener_task_context(&self) -> ListenerTaskContext
```

**Purpose**: Packages the processor's listener-related dependencies into a `ListenerTaskContext`. This avoids repeatedly spelling out the same clones when attaching listeners.

**Data flow**: Clones or copies the thread manager, thread state manager, outgoing sender, pending unload set, watch manager, semaphore, fallback model provider, codex home path, and skills watcher into a new `ListenerTaskContext` value.

**Call relations**: Used only by `ensure_conversation_listener` as the context object passed into thread lifecycle code.

*Call graph*: called by 1 (ensure_conversation_listener); 3 external calls (clone, clone, clone).


##### `TurnRequestProcessor::ensure_conversation_listener`  (lines 1349–1362)

```
async fn ensure_conversation_listener(
        &self,
        conversation_id: ThreadId,
        connection_id: ConnectionId,
        raw_events_enabled: bool,
    ) -> Result<EnsureConversationListen
```

**Purpose**: Delegates listener attachment for a thread/connection pair to the shared thread lifecycle module using this processor's dependency bundle. It is the local adapter around cross-module listener orchestration.

**Data flow**: Accepts conversation id, connection id, and raw-events flag; builds a `ListenerTaskContext` with `listener_task_context()`; calls `super::thread_lifecycle::ensure_conversation_listener(...)`; and returns the resulting `EnsureConversationListenerResult` or JSON-RPC error.

**Call relations**: Called by realtime preparation and detached review startup whenever a connection must be subscribed to a thread listener.

*Call graph*: calls 2 internal fn (ensure_conversation_listener, listener_task_context); called by 2 (prepare_realtime_conversation_thread, start_detached_review).


##### `xcode_26_4_mcp_elicitations_auto_deny`  (lines 1365–1374)

```
fn xcode_26_4_mcp_elicitations_auto_deny(
    client_name: Option<&str>,
    client_version: Option<&str>,
) -> bool
```

**Purpose**: Implements a temporary compatibility rule that auto-denies MCP elicitation requests for Xcode 26.4 clients. It is a hard-coded client/version check.

**Data flow**: Accepts optional client name and version strings, returns `true` only when `client_name == Some("Xcode")` and `client_version` starts with `26.4`; otherwise returns `false`.

**Call relations**: Used by `set_app_server_client_info` to derive the compatibility flag stored on the thread.

*Call graph*: called by 1 (set_app_server_client_info).


### `app-server/src/request_processors/windows_sandbox_processor.rs`

`orchestration` · `request handling for Windows sandbox readiness checks and setup initiation`

This file defines `WindowsSandboxRequestProcessor`, a small request processor dedicated to Windows sandbox lifecycle APIs. The processor stores the outgoing sender, current config, and a `ConfigManager`. `windows_sandbox_readiness` is a pure query that reports whether sandboxing is not configured, ready, or requires an update. On non-Windows platforms it always reports `NotConfigured`; on Windows it derives the current `WindowsSandboxLevel` from config and combines that with `sandbox_setup_is_complete(config.codex_home)` to compute readiness.

The more involved path is `windows_sandbox_setup_start_inner`. Before sending any acknowledgment, it resolves the command cwd from request params or `config.cwd`, loads config for that cwd, and validates the requested API mode against managed requirements using `resolve_allowed_windows_sandbox_setup_mode`. Only after those checks succeed does it send `WindowsSandboxSetupStartResponse { started: true }`. It then spawns a background task that builds a `WindowsSandboxSetupRequest` from the resolved mode, effective permission profile, effective workspace roots, cwd, current environment variables, and `codex_home`, runs `codex_core::windows_sandbox::run_windows_sandbox_setup`, and sends a connection-scoped `WindowsSandboxSetupCompleted` notification containing the mode, success flag, and optional error string. The tests cover requirement rejection and the readiness-state matrix for disabled, restricted-token, and elevated modes with fresh or stale setup state.

#### Function details

##### `WindowsSandboxRequestProcessor::new`  (lines 11–21)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        config: Arc<Config>,
        config_manager: ConfigManager,
    ) -> Self
```

**Purpose**: Constructs the Windows sandbox request processor from its dependencies. It stores the outgoing sender, current config, and config manager for later request handling.

**Data flow**: Accepts `Arc<OutgoingMessageSender>`, `Arc<Config>`, and `ConfigManager`, and returns `Self` with those fields assigned.

**Call relations**: Called during app-server initialization when request processors are assembled.

*Call graph*: called by 1 (new).


##### `WindowsSandboxRequestProcessor::windows_sandbox_readiness`  (lines 23–27)

```
async fn windows_sandbox_readiness(
        &self,
    ) -> Result<WindowsSandboxReadinessResponse, JSONRPCErrorError>
```

**Purpose**: Returns the current Windows sandbox readiness status as a typed response. It is a read-only query over current config and setup state.

**Data flow**: Reads `self.config`, passes it to `determine_windows_sandbox_readiness`, and returns the resulting `WindowsSandboxReadinessResponse`.

**Call relations**: Invoked by initialized-request dispatch for the readiness API.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness); called by 1 (handle_initialized_client_request).


##### `WindowsSandboxRequestProcessor::windows_sandbox_setup_start`  (lines 29–37)

```
async fn windows_sandbox_setup_start(
        &self,
        request_id: &ConnectionRequestId,
        params: WindowsSandboxSetupStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErr
```

**Purpose**: Public JSON-RPC entrypoint for starting Windows sandbox setup. It delegates to the internal implementation and suppresses a direct payload because the method acknowledges via outgoing response plus later notification.

**Data flow**: Accepts request id reference and `WindowsSandboxSetupStartParams`, awaits `windows_sandbox_setup_start_inner`, and maps success to `None`.

**Call relations**: Called by initialized-request dispatch for sandbox setup.

*Call graph*: calls 1 internal fn (windows_sandbox_setup_start_inner); called by 1 (handle_initialized_client_request).


##### `WindowsSandboxRequestProcessor::windows_sandbox_setup_start_inner`  (lines 39–104)

```
async fn windows_sandbox_setup_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: WindowsSandboxSetupStartParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates a requested Windows sandbox setup mode, acknowledges setup start, and launches the actual setup work in a background task that reports completion to the requesting connection. It ensures callers never receive `started: true` for a mode that cannot be persisted under current requirements.

**Data flow**: Resolves `command_cwd` from `params.cwd` or `self.config.cwd`, loads config for that cwd via `config_manager.load_for_cwd`, validates `params.mode` with `resolve_allowed_windows_sandbox_setup_mode`, sends `WindowsSandboxSetupStartResponse { started: true }` through `outgoing`, clones the sender and connection id, then spawns a task that builds `WindowsSandboxSetupRequest` from setup mode, effective permission profile, effective workspace roots, cwd, `std::env::vars()`, and `codex_home`; awaits `run_windows_sandbox_setup`; converts the result into `WindowsSandboxSetupCompletedNotification`; and sends that notification only to the originating connection.

**Call relations**: Called by the public `windows_sandbox_setup_start` wrapper. It delegates mode validation to `resolve_allowed_windows_sandbox_setup_mode` and completion execution to core sandbox setup code.

*Call graph*: calls 3 internal fn (load_for_cwd, resolve_allowed_windows_sandbox_setup_mode, run_windows_sandbox_setup); called by 1 (windows_sandbox_setup_start); 6 external calls (clone, default, WindowsSandboxSetupCompleted, clone, vars, spawn).


##### `resolve_allowed_windows_sandbox_setup_mode`  (lines 108–127)

```
fn resolve_allowed_windows_sandbox_setup_mode(
    requirements: &codex_config::ConfigRequirements,
    requested_mode: WindowsSandboxSetupMode,
) -> Result<CoreWindowsSandboxSetupMode, JSONRPCErrorEr
```

**Purpose**: Maps an API setup mode to the core setup mode while enforcing managed configuration constraints. It rejects modes disallowed by `ConfigRequirements`.

**Data flow**: Accepts `&ConfigRequirements` and `WindowsSandboxSetupMode`, maps the requested mode to both `CoreWindowsSandboxSetupMode` and `WindowsSandboxModeToml`, calls `requirements.windows_sandbox_mode.can_set(&Some(config_mode))`, converts any failure into `invalid_request`, and returns the core mode on success.

**Call relations**: Used by `windows_sandbox_setup_start_inner` before acknowledging setup, and directly exercised by the rejection test.

*Call graph*: called by 2 (windows_sandbox_setup_start_inner, resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode).


##### `determine_windows_sandbox_readiness`  (lines 129–140)

```
fn determine_windows_sandbox_readiness(config: &Config) -> WindowsSandboxReadinessResponse
```

**Purpose**: Computes readiness from the current runtime platform and config. Non-Windows hosts are always treated as not configured.

**Data flow**: Accepts `&Config`, checks `cfg!(windows)`, returns `NotConfigured` immediately on non-Windows, otherwise derives `WindowsSandboxLevel::from_config(config)` and `sandbox_setup_is_complete(config.codex_home.as_path())`, then delegates to `determine_windows_sandbox_readiness_from_state`.

**Call relations**: Called by `windows_sandbox_readiness` as the top-level readiness computation.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); called by 1 (windows_sandbox_readiness); 2 external calls (cfg!, from_config).


##### `determine_windows_sandbox_readiness_from_state`  (lines 142–159)

```
fn determine_windows_sandbox_readiness_from_state(
    windows_sandbox_level: WindowsSandboxLevel,
    sandbox_setup_is_complete: bool,
) -> WindowsSandboxReadinessResponse
```

**Purpose**: Maps a sandbox level plus setup-complete flag into the API readiness enum. It encodes the readiness matrix independent of platform/config lookup.

**Data flow**: Accepts `WindowsSandboxLevel` and `bool sandbox_setup_is_complete`, matches on the level, returns `NotConfigured` for `Disabled`, `Ready` for `RestrictedToken`, and `Ready` or `UpdateRequired` for `Elevated` depending on the setup-complete flag, wrapped in `WindowsSandboxReadinessResponse`.

**Call relations**: Used by `determine_windows_sandbox_readiness` and directly by tests to validate the readiness-state matrix.

*Call graph*: called by 5 (determine_windows_sandbox_readiness, determine_windows_sandbox_readiness_reports_not_configured_when_disabled, determine_windows_sandbox_readiness_reports_ready_for_complete_elevated_mode, determine_windows_sandbox_readiness_reports_ready_for_unelevated_mode, determine_windows_sandbox_readiness_reports_update_required_when_elevated_setup_is_stale).


##### `tests::resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode`  (lines 171–191)

```
fn resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode()
```

**Purpose**: Verifies managed requirements reject a requested setup mode that is not allowed. The test also checks the JSON-RPC error code and message prefix.

**Data flow**: Builds `ConfigRequirements` whose `windows_sandbox_mode` allows only elevated mode, calls `resolve_allowed_windows_sandbox_setup_mode` with `Unelevated`, expects an error, and asserts the error code is `INVALID_REQUEST_ERROR_CODE` and the message mentions invalid setup mode.

**Call relations**: Test-harness coverage for requirement enforcement in mode resolution.

*Call graph*: calls 3 internal fn (resolve_allowed_windows_sandbox_setup_mode, new, allow_only); 3 external calls (default, assert!, assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_not_configured_when_disabled`  (lines 194–201)

```
fn determine_windows_sandbox_readiness_reports_not_configured_when_disabled()
```

**Purpose**: Checks that disabled sandbox configuration reports `NotConfigured`. This is the baseline readiness state.

**Data flow**: Calls `determine_windows_sandbox_readiness_from_state(WindowsSandboxLevel::Disabled, false)` and asserts the returned status equals `WindowsSandboxReadiness::NotConfigured`.

**Call relations**: One of several small matrix tests for readiness-state mapping.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_ready_for_unelevated_mode`  (lines 204–211)

```
fn determine_windows_sandbox_readiness_reports_ready_for_unelevated_mode()
```

**Purpose**: Verifies restricted-token (unelevated) sandbox mode is considered ready without any separate setup-complete marker. This distinguishes it from elevated mode.

**Data flow**: Calls `determine_windows_sandbox_readiness_from_state(WindowsSandboxLevel::RestrictedToken, false)` and asserts the status is `Ready`.

**Call relations**: Matrix test for the restricted-token readiness branch.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_ready_for_complete_elevated_mode`  (lines 214–221)

```
fn determine_windows_sandbox_readiness_reports_ready_for_complete_elevated_mode()
```

**Purpose**: Checks that elevated sandbox mode reports `Ready` when setup is complete. This is the healthy elevated-state branch.

**Data flow**: Calls `determine_windows_sandbox_readiness_from_state(WindowsSandboxLevel::Elevated, true)` and asserts the status is `Ready`.

**Call relations**: Matrix test for elevated mode with fresh setup.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_update_required_when_elevated_setup_is_stale`  (lines 224–231)

```
fn determine_windows_sandbox_readiness_reports_update_required_when_elevated_setup_is_stale()
```

**Purpose**: Checks that elevated sandbox mode reports `UpdateRequired` when setup is incomplete or stale. This is the degraded elevated-state branch.

**Data flow**: Calls `determine_windows_sandbox_readiness_from_state(WindowsSandboxLevel::Elevated, false)` and asserts the status is `UpdateRequired`.

**Call relations**: Matrix test for elevated mode with stale setup.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


### Thread and conversation routing
This group follows the app server's thread-centric request paths from thread lifecycle operations through goals, deletion, dynamic tool responses, and model-facing tool dispatch.

### `app-server/src/request_processors/thread_processor.rs`

`orchestration` · `request handling, startup, shutdown, and background thread lifecycle`

This is the central thread request-processing module. It defines `ThreadRequestProcessor`, which aggregates authentication, thread runtime management, outgoing transport, config loading, thread storage, state/log DBs, listener/watch managers, goal processing, and background task tracking. Most public methods are thin RPC adapters that call an inner method and either return a payload or send responses/notifications directly.

The file’s core responsibilities are: creating threads (`thread_start_task`), resuming threads from running state, rollout history, or explicit history (`thread_resume_inner` plus `resume_running_thread`), forking threads (`thread_fork_inner`), and exposing persisted/live thread views (`thread_list_response_inner`, `thread_search_response_inner`, `thread_read_response_inner`, `thread_turns_list_response_inner`). It carefully merges persisted `StoredThread` metadata with live `CodexThread` state, especially around active turns, loaded status, session IDs, and ephemeral-thread restrictions. Resume logic is particularly nuanced: it rejects stale paths for running threads, logs ignored override mismatches, can shut down idle cached threads to honor new overrides, and routes running-thread resumes through the listener command channel so response ordering matches live events.

The module also contains many helper policies: dynamic tool validation against Responses API naming/schema constraints; project-trust escalation when requested permissions imply write access; pagination for thread lists, turns, and background terminals; conversion helpers from store/state models to API structs; and a large family of error mappers that preserve invalid-request and unsupported-operation semantics. Overall, this file is the app-server’s main orchestration layer for thread lifecycle and thread-facing RPC behavior.

#### Function details

##### `collect_resume_override_mismatches`  (lines 21–140)

```
fn collect_resume_override_mismatches(
    request: &ThreadResumeParams,
    config_snapshot: &ThreadConfigSnapshot,
) -> Vec<String>
```

**Purpose**: Builds human-readable descriptions of resume request overrides that do not match a running thread’s active configuration. It is used to decide whether overrides can be ignored or whether an idle cached thread should be shut down and cold-resumed instead.

**Data flow**: Reads fields from `request: &ThreadResumeParams` and `config_snapshot: &ThreadConfigSnapshot`, compares requested model/provider/service tier/cwd/workspace roots/approval settings/sandbox/permissions/personality/config/base/developer instructions against active values, and accumulates mismatch strings in a `Vec<String>`. Returns the vector, empty when there are no mismatches.

**Call relations**: Called only by `ThreadRequestProcessor::resume_running_thread` before deciding whether a loaded thread can satisfy a resume request as-is.

*Call graph*: calls 2 internal fn (cwd, sandbox_policy); called by 1 (resume_running_thread); 4 external calls (new, format!, matches!, from).


##### `merge_persisted_resume_metadata`  (lines 142–160)

```
fn merge_persisted_resume_metadata(
    request_overrides: &mut Option<HashMap<String, serde_json::Value>>,
    typesafe_overrides: &mut ConfigOverrides,
    persisted_metadata: &ThreadMetadata,
)
```

**Purpose**: Injects persisted thread metadata into resume overrides when the client did not explicitly override model selection. This preserves the original model/provider/reasoning-effort choices across resume.

**Data flow**: Mutably borrows `request_overrides` and `typesafe_overrides`, checks `has_model_resume_override(...)`, and returns early if any model override is already present. Otherwise it copies `persisted_metadata.model` and `persisted_metadata.model_provider` into `typesafe_overrides`, and inserts `model_reasoning_effort` into the JSON override map when persisted metadata includes one.

**Call relations**: Used by `ThreadRequestProcessor::load_and_apply_persisted_resume_metadata` during cold resume setup.

*Call graph*: calls 1 internal fn (has_model_resume_override); called by 1 (load_and_apply_persisted_resume_metadata); 1 external calls (String).


##### `normalize_thread_list_cwd_filters`  (lines 162–184)

```
fn normalize_thread_list_cwd_filters(
    cwd: Option<ThreadListCwdFilter>,
) -> Result<Option<Vec<PathBuf>>, JSONRPCErrorError>
```

**Purpose**: Normalizes `thread/list` cwd filters into absolute path buffers relative to the current directory. It accepts either a single cwd or many and rejects invalid paths as invalid params.

**Data flow**: Consumes `cwd: Option<ThreadListCwdFilter>`. `None` returns `Ok(None)`. Otherwise it expands `One` or `Many` into a vector, converts each string with `AbsolutePathBuf::relative_to_current_dir(...).map(AbsolutePathBuf::into_path_buf)`, maps failures to `invalid_params`, and returns `Ok(Some(normalized_cwds))`.

**Call relations**: Called by `ThreadRequestProcessor::thread_list_response_inner` before querying the thread store.

*Call graph*: calls 1 internal fn (relative_to_current_dir); called by 1 (thread_list_response_inner); 2 external calls (with_capacity, vec!).


##### `has_model_resume_override`  (lines 186–195)

```
fn has_model_resume_override(
    request_overrides: Option<&HashMap<String, serde_json::Value>>,
    typesafe_overrides: &ConfigOverrides,
) -> bool
```

**Purpose**: Detects whether a resume request already specifies any model-selection override. This prevents persisted metadata from silently overwriting explicit client choices.

**Data flow**: Reads `typesafe_overrides.model`, `typesafe_overrides.model_provider`, and optional JSON `request_overrides`, returning `true` if any of those specify `model` or `model_reasoning_effort`; otherwise `false`.

**Call relations**: Used only by `merge_persisted_resume_metadata` as its guard condition.

*Call graph*: called by 1 (merge_persisted_resume_metadata).


##### `validate_dynamic_tools`  (lines 197–342)

```
fn validate_dynamic_tools(tools: &[DynamicToolSpec]) -> Result<(), String>
```

**Purpose**: Validates dynamic tool definitions supplied at thread start against naming, namespace, duplication, defer-loading, and schema constraints. It enforces compatibility with the Responses API naming model and reserves several namespaces.

**Data flow**: Consumes `tools: &[DynamicToolSpec]`, iterates top-level functions and namespaces, and applies nested helper checks: identifier characters must be ASCII alphanumeric/underscore/hyphen, lengths must stay within fixed maxima, names must not be empty or whitespace-padded, `mcp`/`mcp__*` and reserved namespaces are forbidden, duplicates are rejected, deferred tools require a namespace, namespace descriptions have a max length, namespaces must contain at least one tool, and each function schema must parse via `codex_tools::parse_tool_input_schema`. Returns `Ok(())` or a descriptive `Err(String)`.

**Call relations**: Called by `ThreadRequestProcessor::thread_start_task` before creating a new thread with dynamic tools.

*Call graph*: called by 1 (thread_start_task); 2 external calls (new, format!).


##### `ThreadRequestProcessor::new`  (lines 377–412)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        arg0_paths: Arg0DispatchPaths,
        config: Arc<Con
```

**Purpose**: Constructs the main thread request processor with all runtime, storage, config, and notification dependencies. It also initializes a fresh `TaskTracker` for background thread-start tasks.

**Data flow**: Takes all processor dependencies by value, stores them in the struct, and sets `background_tasks: TaskTracker::new()`. Returns the assembled `ThreadRequestProcessor`.

**Call relations**: Called during server initialization; every thread-related RPC entrypoint in this file depends on the shared state captured here.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `ThreadRequestProcessor::thread_start`  (lines 414–431)

```
async fn thread_start(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadStartParams,
        app_server_client_name: Option<String>,
        app_server_client_version: Opt
```

**Purpose**: Public RPC wrapper for starting a new thread. It delegates to the async orchestration method and converts unit success into `Ok(None)`.

**Data flow**: Consumes request metadata and `ThreadStartParams`, awaits `thread_start_inner(...)`, and maps `Ok(())` to `Ok(None)` while propagating `JSONRPCErrorError`.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/start`; all substantive work happens in `thread_start_inner` and the spawned `thread_start_task`.

*Call graph*: calls 1 internal fn (thread_start_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_unsubscribe`  (lines 433–441)

```
async fn thread_unsubscribe(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadUnsubscribeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for unsubscribing a connection from a thread’s listener stream. It returns a typed unsubscribe status payload.

**Data flow**: Takes `request_id` and `ThreadUnsubscribeParams`, passes `params` and `request_id.connection_id` to `thread_unsubscribe_response_inner`, and wraps the resulting `ThreadUnsubscribeResponse` into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/unsubscribe`; the inner method performs the actual bookkeeping.

*Call graph*: calls 1 internal fn (thread_unsubscribe_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_resume`  (lines 443–458)

```
async fn thread_resume(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadResumeParams,
        app_server_client_name: Option<String>,
        app_server_client_version: O
```

**Purpose**: Public RPC wrapper for resuming a thread from running state, rollout history, or explicit history. It delegates to the complex resume orchestrator and returns `Ok(None)` because responses are sent directly.

**Data flow**: Consumes `request_id`, `ThreadResumeParams`, and optional client name/version, awaits `thread_resume_inner(...)`, and maps unit success to `None`.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/resume`; the heavy logic is in `thread_resume_inner` and its helpers.

*Call graph*: calls 1 internal fn (thread_resume_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_fork`  (lines 460–475)

```
async fn thread_fork(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadForkParams,
        app_server_client_name: Option<String>,
        app_server_client_version: Optio
```

**Purpose**: Public RPC wrapper for forking a thread from persisted history. It delegates to the inner implementation and returns `Ok(None)` on success.

**Data flow**: Consumes `request_id`, `ThreadForkParams`, and optional client name/version, awaits `thread_fork_inner(...)`, and maps unit success to `None`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/fork`; the inner method performs history loading, config derivation, thread creation, and response emission.

*Call graph*: calls 1 internal fn (thread_fork_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_archive`  (lines 477–498)

```
async fn thread_archive(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadArchiveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Archives a thread subtree and emits `ThreadArchived` notifications for each archived thread after sending the response. It wraps the archive inner method’s tuple result into the request-processor convention.

**Data flow**: Awaits `thread_archive_inner(params)`. On success it sends the `ThreadArchiveResponse` via `outgoing.send_response(request_id.clone(), response)` and then iterates `archived_thread_ids`, sending `ServerNotification::ThreadArchived(ThreadArchivedNotification { thread_id })` for each. On failure it returns the error.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/archive`; it delegates archive semantics to `thread_archive_inner`.

*Call graph*: calls 1 internal fn (thread_archive_inner); called by 1 (handle_initialized_client_request); 2 external calls (ThreadArchived, clone).


##### `ThreadRequestProcessor::thread_increment_elicitation`  (lines 500–507)

```
async fn thread_increment_elicitation(
        &self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for incrementing a thread’s out-of-band elicitation counter. It returns the typed response payload directly.

**Data flow**: Consumes `ThreadIncrementElicitationParams`, awaits `thread_increment_elicitation_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher; the inner method performs thread lookup and counter mutation.

*Call graph*: calls 1 internal fn (thread_increment_elicitation_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_decrement_elicitation`  (lines 509–516)

```
async fn thread_decrement_elicitation(
        &self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for decrementing a thread’s out-of-band elicitation counter. It returns the typed response payload directly.

**Data flow**: Consumes `ThreadDecrementElicitationParams`, awaits `thread_decrement_elicitation_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher; the inner method performs thread lookup and counter mutation.

*Call graph*: calls 1 internal fn (thread_decrement_elicitation_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_set_name`  (lines 518–539)

```
async fn thread_set_name(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadSetNameParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Sets a persisted thread name and emits a `ThreadNameUpdated` notification when appropriate. It sends the response itself and returns `Ok(None)` on success.

**Data flow**: Awaits `thread_set_name_response_inner(params)`. On success it sends the `ThreadSetNameResponse` via `outgoing.send_response(request_id.clone(), response)` and, if a notification was returned, sends `ServerNotification::ThreadNameUpdated(notification)`. Errors are propagated.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/setName`; the inner method performs validation and metadata update.

*Call graph*: calls 1 internal fn (thread_set_name_response_inner); called by 1 (handle_initialized_client_request); 2 external calls (ThreadNameUpdated, clone).


##### `ThreadRequestProcessor::thread_metadata_update`  (lines 541–548)

```
async fn thread_metadata_update(
        &self,
        params: ThreadMetadataUpdateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for updating persisted thread metadata such as git info. It returns the updated thread view as a payload.

**Data flow**: Consumes `ThreadMetadataUpdateParams`, awaits `thread_metadata_update_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/metadata/update`.

*Call graph*: calls 1 internal fn (thread_metadata_update_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_memory_mode_set`  (lines 550–557)

```
async fn thread_memory_mode_set(
        &self,
        params: ThreadMemoryModeSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for changing a thread’s memory mode in persisted metadata. It returns the typed response payload.

**Data flow**: Consumes `ThreadMemoryModeSetParams`, awaits `thread_memory_mode_set_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/memoryMode/set`.

*Call graph*: calls 1 internal fn (thread_memory_mode_set_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::memory_reset`  (lines 559–565)

```
async fn memory_reset(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for clearing global memory state and memory directories. It returns the typed response payload.

**Data flow**: Awaits `memory_reset_response_inner()`, explicitly types the response as `MemoryResetResponse`, and wraps it into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for the memory reset RPC.

*Call graph*: calls 1 internal fn (memory_reset_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_unarchive`  (lines 567–584)

```
async fn thread_unarchive(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadUnarchiveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Unarchives a thread and emits a `ThreadUnarchived` notification after sending the response. It wraps the inner tuple result into the request-processor convention.

**Data flow**: Awaits `thread_unarchive_inner(params)`. On success it sends the `ThreadUnarchiveResponse` via `outgoing.send_response(request_id.clone(), response)` and then sends `ServerNotification::ThreadUnarchived(notification)`. Errors are propagated.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/unarchive`; the inner methods perform store mutation and thread-view reconstruction.

*Call graph*: calls 1 internal fn (thread_unarchive_inner); called by 1 (handle_initialized_client_request); 2 external calls (ThreadUnarchived, clone).


##### `ThreadRequestProcessor::thread_compact_start`  (lines 586–594)

```
async fn thread_compact_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadCompactStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for starting thread compaction in the core thread runtime. It returns the typed response payload.

**Data flow**: Takes `request_id` by reference and `ThreadCompactStartParams`, awaits `thread_compact_start_inner(request_id, params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/compact/start`.

*Call graph*: calls 1 internal fn (thread_compact_start_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_background_terminals_clean`  (lines 596–604)

```
async fn thread_background_terminals_clean(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadBackgroundTerminalsCleanParams,
    ) -> Result<Option<ClientResponsePayload>
```

**Purpose**: Public RPC wrapper for requesting cleanup of background terminals associated with a thread. It returns the typed response payload.

**Data flow**: Consumes `request_id` by reference and `ThreadBackgroundTerminalsCleanParams`, awaits `thread_background_terminals_clean_inner`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for background-terminal cleanup.

*Call graph*: calls 1 internal fn (thread_background_terminals_clean_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_background_terminals_list`  (lines 606–613)

```
async fn thread_background_terminals_list(
        &self,
        params: ThreadBackgroundTerminalsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for listing background terminals for a thread. It returns the paginated response payload.

**Data flow**: Consumes `ThreadBackgroundTerminalsListParams`, awaits `thread_background_terminals_list_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for background-terminal listing.

*Call graph*: calls 1 internal fn (thread_background_terminals_list_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_background_terminals_terminate`  (lines 615–622)

```
async fn thread_background_terminals_terminate(
        &self,
        params: ThreadBackgroundTerminalsTerminateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for terminating a specific background terminal process in a thread. It returns the typed response payload.

**Data flow**: Consumes `ThreadBackgroundTerminalsTerminateParams`, awaits `thread_background_terminals_terminate_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for background-terminal termination.

*Call graph*: calls 1 internal fn (thread_background_terminals_terminate_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_rollback`  (lines 624–632)

```
async fn thread_rollback(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for starting a rollback operation on a loaded thread. It returns `Ok(None)` because completion is event-driven.

**Data flow**: Consumes `request_id` by reference and `ThreadRollbackParams`, awaits `thread_rollback_inner(request_id, params)`, and maps unit success to `None`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/rollback`.

*Call graph*: calls 1 internal fn (thread_rollback_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_list`  (lines 634–641)

```
async fn thread_list(
        &self,
        params: ThreadListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for listing persisted threads with filtering and pagination. It returns the typed response payload.

**Data flow**: Consumes `ThreadListParams`, awaits `thread_list_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/list`.

*Call graph*: calls 1 internal fn (thread_list_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_search`  (lines 643–650)

```
async fn thread_search(
        &self,
        params: ThreadSearchParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for full-text thread search over persisted threads. It returns the typed response payload.

**Data flow**: Consumes `ThreadSearchParams`, awaits `thread_search_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/search`.

*Call graph*: calls 1 internal fn (thread_search_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_loaded_list`  (lines 652–659)

```
async fn thread_loaded_list(
        &self,
        params: ThreadLoadedListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for listing currently loaded thread IDs. It returns the typed response payload.

**Data flow**: Consumes `ThreadLoadedListParams`, awaits `thread_loaded_list_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/loaded/list`.

*Call graph*: calls 1 internal fn (thread_loaded_list_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_read`  (lines 661–668)

```
async fn thread_read(
        &self,
        params: ThreadReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for reading a thread view with optional turns. It returns the typed response payload.

**Data flow**: Consumes `ThreadReadParams`, awaits `thread_read_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/read`.

*Call graph*: calls 1 internal fn (thread_read_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_turns_list`  (lines 670–677)

```
async fn thread_turns_list(
        &self,
        params: ThreadTurnsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for paginated turn listing on a thread. It returns the typed response payload.

**Data flow**: Consumes `ThreadTurnsListParams`, awaits `thread_turns_list_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/turns/list`.

*Call graph*: calls 1 internal fn (thread_turns_list_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_turns_items_list`  (lines 679–686)

```
async fn thread_turns_items_list(
        &self,
        _params: ThreadTurnsItemsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Rejects the not-yet-supported `thread/turns/items/list` RPC with a method-not-found error. It is an explicit placeholder rather than an unimplemented panic.

**Data flow**: Ignores `_params` and immediately returns `Err(method_not_found("thread/turns/items/list is not supported yet"))`.

**Call relations**: Called by the initialized-client request dispatcher when that RPC is requested; it does not delegate further.

*Call graph*: calls 1 internal fn (method_not_found); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_shell_command`  (lines 688–696)

```
async fn thread_shell_command(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadShellCommandParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for the app-server’s local-host shell escape hatch on a thread. It returns the typed response payload.

**Data flow**: Consumes `request_id` by reference and `ThreadShellCommandParams`, awaits `thread_shell_command_inner`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/shellCommand`.

*Call graph*: calls 1 internal fn (thread_shell_command_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_approve_guardian_denied_action`  (lines 698–706)

```
async fn thread_approve_guardian_denied_action(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadApproveGuardianDeniedActionParams,
    ) -> Result<Option<ClientResponseP
```

**Purpose**: Public RPC wrapper for approving a previously denied Guardian action on a thread. It returns the typed response payload.

**Data flow**: Consumes `request_id` by reference and `ThreadApproveGuardianDeniedActionParams`, awaits `thread_approve_guardian_denied_action_inner`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for the Guardian approval RPC.

*Call graph*: calls 1 internal fn (thread_approve_guardian_denied_action_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::conversation_summary`  (lines 708–715)

```
async fn conversation_summary(
        &self,
        params: GetConversationSummaryParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for loading a lightweight conversation summary by thread ID or rollout path. It returns the typed response payload.

**Data flow**: Consumes `GetConversationSummaryParams`, awaits `get_thread_summary_response_inner(params)`, and wraps the response into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for conversation-summary requests.

*Call graph*: calls 1 internal fn (get_thread_summary_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::load_thread`  (lines 717–732)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Loads a currently running thread by string ID and returns both the parsed `ThreadId` and `Arc<CodexThread>`. It standardizes invalid-ID and not-found errors for operations that require a loaded thread.

**Data flow**: Parses `thread_id: &str` with `ThreadId::from_string`, mapping parse failures to `invalid_request("invalid thread id: ...")`. It then awaits `thread_manager.get_thread(thread_id)` and maps failure to `invalid_request("thread not found: ...")`. On success it returns `(thread_id, thread)`.

**Call relations**: Shared by many loaded-thread-only operations such as rollback, compaction, shell command, background terminal operations, and elicitation counter updates.

*Call graph*: calls 1 internal fn (from_string); called by 9 (thread_approve_guardian_denied_action_inner, thread_background_terminals_clean_inner, thread_background_terminals_list_inner, thread_background_terminals_terminate_inner, thread_compact_start_inner, thread_decrement_elicitation_inner, thread_increment_elicitation_inner, thread_rollback_start, thread_shell_command_inner).


##### `ThreadRequestProcessor::acquire_thread_list_state_permit`  (lines 733–742)

```
async fn acquire_thread_list_state_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, JSONRPCErrorError>
```

**Purpose**: Acquires the semaphore that serializes thread-list-affecting mutations and some resume/archive operations. It converts semaphore closure into an internal JSON-RPC error.

**Data flow**: Awaits `self.thread_list_state_permit.acquire()`. On success it returns `SemaphorePermit<'_>`; on failure it returns `internal_error(format!("failed to acquire thread list state permit: {err}"))`.

**Call relations**: Used by archive, unarchive, metadata update, set-name, delete, and resume paths that must serialize against thread-list state changes.

*Call graph*: called by 5 (thread_archive_inner, thread_metadata_update_response_inner, thread_resume_inner, thread_set_name_response_inner, thread_unarchive_inner).


##### `ThreadRequestProcessor::set_app_server_client_info`  (lines 744–761)

```
async fn set_app_server_client_info(
        thread: &CodexThread,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorEr
```

**Purpose**: Stores app-server client identity on a thread and applies a compatibility hack for Xcode 26.4 MCP elicitation behavior. It wraps core failures as internal errors.

**Data flow**: Computes `mcp_elicitations_auto_deny` via `xcode_26_4_mcp_elicitations_auto_deny(app_server_client_name.as_deref(), app_server_client_version.as_deref())`, then awaits `thread.set_app_server_client_info(app_server_client_name, app_server_client_version, mcp_elicitations_auto_deny)`. Returns `Ok(())` or `internal_error(...)` on failure.

**Call relations**: Called during thread start, resume, fork, and running-thread rejoin so the core thread runtime knows which client is attached.

*Call graph*: calls 2 internal fn (xcode_26_4_mcp_elicitations_auto_deny, set_app_server_client_info).


##### `ThreadRequestProcessor::finalize_thread_teardown`  (lines 763–774)

```
async fn finalize_thread_teardown(&self, thread_id: ThreadId)
```

**Purpose**: Performs app-server-side cleanup after a thread is removed or found missing. It clears pending unload state, cancels pending requests, removes thread state, and removes watch-manager tracking.

**Data flow**: Takes `thread_id`, removes it from `pending_thread_unloads`, calls `outgoing.cancel_requests_for_thread(thread_id, None).await`, `thread_state_manager.remove_thread_state(thread_id).await`, and `thread_watch_manager.remove_thread(&thread_id.to_string()).await`.

**Call relations**: Used by connection-close reconciliation, unsubscribe of already-missing threads, explicit removal paths, and running-thread resume when an idle cached thread is shut down.

*Call graph*: calls 2 internal fn (remove_thread_state, remove_thread); called by 4 (connection_closed, prepare_thread_for_removal, resume_running_thread, thread_unsubscribe_response_inner); 1 external calls (to_string).


##### `ThreadRequestProcessor::thread_unsubscribe_response_inner`  (lines 776–802)

```
async fn thread_unsubscribe_response_inner(
        &self,
        params: ThreadUnsubscribeParams,
        connection_id: ConnectionId,
    ) -> Result<ThreadUnsubscribeResponse, JSONRPCErrorError>
```

**Purpose**: Implements unsubscribe semantics for a single connection and thread. It also reconciles stale app-server bookkeeping when the thread is already gone.

**Data flow**: Parses `params.thread_id` into `ThreadId`. If `thread_manager.get_thread(thread_id).await` fails, it calls `finalize_thread_teardown(thread_id).await` and returns `ThreadUnsubscribeResponse { status: NotLoaded }`. Otherwise it awaits `thread_state_manager.unsubscribe_connection_from_thread(thread_id, connection_id)`, maps the boolean to `Unsubscribed` or `NotSubscribed`, and returns that status.

**Call relations**: Called only by `thread_unsubscribe`; it uses `finalize_thread_teardown` for stale-state cleanup.

*Call graph*: calls 3 internal fn (finalize_thread_teardown, unsubscribe_connection_from_thread, from_string); called by 1 (thread_unsubscribe).


##### `ThreadRequestProcessor::prepare_thread_for_archive`  (lines 804–806)

```
async fn prepare_thread_for_archive(&self, thread_id: ThreadId)
```

**Purpose**: Specializes generic thread removal for archive operations. It exists mainly to pass the operation label through to shared teardown logic.

**Data flow**: Takes `thread_id` and awaits `prepare_thread_for_removal(thread_id, "archive")`.

**Call relations**: Called by `thread_archive_response` before archiving each thread in the subtree.

*Call graph*: calls 1 internal fn (prepare_thread_for_removal); called by 1 (thread_archive_response).


##### `ThreadRequestProcessor::prepare_thread_for_removal`  (lines 808–825)

```
async fn prepare_thread_for_removal(&self, thread_id: ThreadId, operation: &str)
```

**Purpose**: Removes a loaded thread from the runtime, waits for shutdown best-effort, logs failures, and then performs app-server teardown cleanup. It is shared by archive and delete flows.

**Data flow**: Calls `thread_manager.remove_thread(&thread_id).await`. If a conversation was removed, it logs and awaits `wait_for_thread_shutdown(&conversation)`, logging `error!` on submit failure and `warn!` on timeout while still proceeding. It then calls `finalize_thread_teardown(thread_id).await`.

**Call relations**: Used by `prepare_thread_for_archive` and by delete-specific cleanup in `thread_delete.rs`.

*Call graph*: calls 1 internal fn (finalize_thread_teardown); called by 1 (prepare_thread_for_archive); 3 external calls (error!, info!, warn!).


##### `ThreadRequestProcessor::listener_task_context`  (lines 827–839)

```
fn listener_task_context(&self) -> ListenerTaskContext
```

**Purpose**: Packages the subset of processor dependencies needed by thread listener lifecycle helpers. It avoids repeatedly spelling out the same clones at call sites.

**Data flow**: Clones or copies `thread_manager`, `thread_state_manager`, `outgoing`, `pending_thread_unloads`, `thread_watch_manager`, `thread_list_state_permit`, `config.model_provider_id`, `config.codex_home`, and `skills_watcher` into a new `ListenerTaskContext`.

**Call relations**: Used by the processor’s wrappers around `thread_lifecycle::ensure_conversation_listener` and `ensure_listener_task_running`.

*Call graph*: called by 2 (ensure_conversation_listener, ensure_listener_task_running); 3 external calls (clone, clone, clone).


##### `ThreadRequestProcessor::ensure_conversation_listener`  (lines 841–854)

```
async fn ensure_conversation_listener(
        &self,
        conversation_id: ThreadId,
        connection_id: ConnectionId,
        raw_events_enabled: bool,
    ) -> Result<EnsureConversationListen
```

**Purpose**: Processor-local wrapper around the shared listener-attach helper. It supplies the current processor’s listener context.

**Data flow**: Builds a `ListenerTaskContext` with `listener_task_context()` and passes it, along with `conversation_id`, `connection_id`, and `raw_events_enabled`, to `super::thread_lifecycle::ensure_conversation_listener(...).await`.

**Call relations**: Called by thread start/resume/fork and listener-attach helper paths; it delegates all logic to the lifecycle module.

*Call graph*: calls 2 internal fn (ensure_conversation_listener, listener_task_context); called by 3 (thread_fork_inner, thread_resume_inner, try_attach_thread_listener).


##### `ThreadRequestProcessor::ensure_listener_task_running`  (lines 856–869)

```
async fn ensure_listener_task_running(
        &self,
        conversation_id: ThreadId,
        conversation: Arc<CodexThread>,
        thread_state: Arc<Mutex<ThreadState>>,
    ) -> Result<(), JSON
```

**Purpose**: Processor-local wrapper around the shared listener-task startup helper. It supplies the current processor’s listener context.

**Data flow**: Builds a `ListenerTaskContext` with `listener_task_context()` and passes it, plus `conversation_id`, `conversation`, and `thread_state`, to `super::thread_lifecycle::ensure_listener_task_running(...).await`.

**Call relations**: Used by `resume_running_thread` when rejoining a loaded thread and needing to guarantee the listener task exists.

*Call graph*: calls 2 internal fn (ensure_listener_task_running, listener_task_context); called by 1 (resume_running_thread).


##### `ThreadRequestProcessor::thread_start_inner`  (lines 871–967)

```
async fn thread_start_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadStartParams,
        app_server_client_name: Option<String>,
        app_server_client_versio
```

**Purpose**: Validates thread-start parameters, resolves environment selections and config overrides, and spawns the actual thread-start work onto the background task tracker. It keeps the request path non-blocking while preserving tracing context.

**Data flow**: Destructures `ThreadStartParams`, rejects simultaneous `sandbox` and `permissions`, resolves environment selections, converts runtime workspace roots, builds `ConfigOverrides`, sets `ephemeral`, constructs a `ListenerTaskContext`, captures request trace/span, clones `config_manager` and `outgoing`, and builds an async `thread_start_task` closure that calls `Self::thread_start_task(...)` and sends any resulting error via `outgoing.send_error(error_request_id, error).await`. It then spawns that task into `self.background_tasks` instrumented with the request span and returns `Ok(())`.

**Call relations**: Called only by the public `thread_start` wrapper. It delegates actual thread creation to the static async `thread_start_task` helper.

*Call graph*: calls 3 internal fn (request_trace, span, build_thread_config_overrides); called by 1 (thread_start); 7 external calls (clone, thread_start_task, spawn, clone, clone, clone, clone).


##### `ThreadRequestProcessor::drain_background_tasks`  (lines 969–977)

```
async fn drain_background_tasks(&self)
```

**Purpose**: Stops accepting new background tasks and waits briefly for existing ones to finish. It logs but does not fail if shutdown takes too long.

**Data flow**: Calls `self.background_tasks.close()`, then awaits `tokio::time::timeout(Duration::from_secs(10), self.background_tasks.wait())`. If the timeout expires, it logs a warning.

**Call relations**: Used during server shutdown/teardown to flush outstanding background thread-start tasks.

*Call graph*: called by 1 (drain_background_tasks); 5 external calls (from_secs, close, wait, timeout, warn!).


##### `ThreadRequestProcessor::clear_all_thread_listeners`  (lines 979–981)

```
async fn clear_all_thread_listeners(&self)
```

**Purpose**: Clears all registered thread listeners from `ThreadStateManager`. It is a bulk teardown helper.

**Data flow**: Awaits `self.thread_state_manager.clear_all_listeners()` and returns unit.

**Call relations**: Used during broader shutdown/cleanup flows outside this file.

*Call graph*: calls 1 internal fn (clear_all_listeners); called by 1 (clear_all_thread_listeners).


##### `ThreadRequestProcessor::shutdown_threads`  (lines 983–994)

```
async fn shutdown_threads(&self)
```

**Purpose**: Requests bounded shutdown of all loaded threads and logs any threads that failed submission or timed out. It is the processor’s bulk runtime shutdown helper.

**Data flow**: Awaits `thread_manager.shutdown_all_threads_bounded(Duration::from_secs(10))`, then iterates `report.submit_failed` and `report.timed_out`, logging warnings for each thread ID.

**Call relations**: Used during server shutdown after listener cleanup/background task draining.

*Call graph*: called by 1 (shutdown_threads); 2 external calls (from_secs, warn!).


##### `ThreadRequestProcessor::request_trace_context`  (lines 996–1001)

```
async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<codex_protocol::protocol::W3cTraceContext>
```

**Purpose**: Fetches any stored W3C trace context associated with a client request ID. This lets downstream core operations inherit request tracing.

**Data flow**: Awaits `self.outgoing.request_trace_context(request_id)` and returns the optional `W3cTraceContext`.

**Call relations**: Used by `submit_core_op`, `thread_resume_inner`, and `thread_fork_inner` when invoking core thread operations.

*Call graph*: called by 3 (submit_core_op, thread_fork_inner, thread_resume_inner).


##### `ThreadRequestProcessor::submit_core_op`  (lines 1003–1012)

```
async fn submit_core_op(
        &self,
        request_id: &ConnectionRequestId,
        thread: &CodexThread,
        op: Op,
    ) -> CodexResult<String>
```

**Purpose**: Submits a core `Op` to a loaded thread with the current request’s trace context attached. It centralizes the trace lookup and submission call.

**Data flow**: Awaits `self.request_trace_context(request_id)`, then calls `thread.submit_with_trace(op, trace_context).await` and returns the resulting `CodexResult<String>`.

**Call relations**: Shared by rollback, compaction, shell command, Guardian approval, and background-terminal cleanup operations.

*Call graph*: calls 2 internal fn (request_trace_context, submit_with_trace); called by 5 (thread_approve_guardian_denied_action_inner, thread_background_terminals_clean_inner, thread_compact_start_inner, thread_rollback_start, thread_shell_command_inner).


##### `ThreadRequestProcessor::thread_start_task`  (lines 1015–1275)

```
async fn thread_start_task(
        listener_task_context: ListenerTaskContext,
        config_manager: ConfigManager,
        request_id: ConnectionRequestId,
        app_server_client_name: Option<S
```

**Purpose**: Performs the full asynchronous thread creation flow: config loading, trust adjustment, dynamic tool validation, thread startup, listener auto-attach, watch-manager registration, and response/notification emission. It is the heavy worker spawned by `thread_start_inner`.

**Data flow**: Loads config with overrides via `config_manager.load_with_overrides`, possibly persists or injects trusted-project state and reloads config with CLI overrides, derives default environments, validates dynamic tools, initializes extension data for selected capability roots, and calls `thread_manager.start_thread_with_options(...)`. It records telemetry phases, sets app-server client info, reads instruction sources and config snapshot, builds an API `Thread` with `build_thread_from_snapshot`, best-effort auto-attaches a listener via `ensure_conversation_listener`, upserts the thread into `thread_watch_manager`, resolves status, computes sandbox and active permission profile, builds `ThreadStartResponse`, sends it, then sends `ServerNotification::ThreadStarted` and records total startup telemetry.

**Call relations**: Spawned by `thread_start_inner` rather than called inline. It orchestrates config helpers, dynamic-tool validation, listener lifecycle helpers, thread-manager startup, and outgoing transport.

*Call graph*: calls 10 internal fn (current_cli_overrides, load_with_cli_overrides, load_with_overrides, ensure_conversation_listener, build_thread_from_snapshot, permission_profile_trusts_project, requested_permissions_trust_project, validate_dynamic_tools, set_project_trust_level, new); 12 external calls (set_app_server_client_info, ThreadStarted, String, Table, clone, initialize_executor_plugin_thread_data, clone, once, now, new (+2 more)).


##### `ThreadRequestProcessor::build_thread_config_overrides`  (lines 1278–1312)

```
fn build_thread_config_overrides(
        &self,
        model: Option<String>,
        model_provider: Option<String>,
        service_tier: Option<Option<String>>,
        cwd: Option<String>,
```

**Purpose**: Converts thread-start/resume/fork request fields into the internal `ConfigOverrides` structure expected by config loading. It also injects executable paths from `arg0_paths`.

**Data flow**: Takes optional model/provider/service tier/cwd/workspace roots/approval settings/sandbox/permissions/instructions/personality values and returns a `ConfigOverrides` populated with those fields, converted core enum forms, cloned sandbox wrapper paths, and `..Default::default()` for the rest.

**Call relations**: Used by `thread_start_inner`, `thread_resume_inner`, and `thread_fork_inner` before loading config.

*Call graph*: called by 3 (thread_fork_inner, thread_resume_inner, thread_start_inner); 1 external calls (default).


##### `ThreadRequestProcessor::thread_archive_inner`  (lines 1314–1320)

```
async fn thread_archive_inner(
        &self,
        params: ThreadArchiveParams,
    ) -> Result<(ThreadArchiveResponse, Vec<String>), JSONRPCErrorError>
```

**Purpose**: Serializes archive work against thread-list state and delegates to the archive implementation. It returns both the response and the list of archived thread IDs for notification emission.

**Data flow**: Acquires the thread-list state permit with `acquire_thread_list_state_permit().await?`, then awaits `thread_archive_response(params)` and returns its tuple.

**Call relations**: Called only by the public `thread_archive` wrapper.

*Call graph*: calls 2 internal fn (acquire_thread_list_state_permit, thread_archive_response); called by 1 (thread_archive).


##### `ThreadRequestProcessor::thread_archive_response`  (lines 1322–1412)

```
async fn thread_archive_response(
        &self,
        params: ThreadArchiveParams,
    ) -> Result<(ThreadArchiveResponse, Vec<String>), JSONRPCErrorError>
```

**Purpose**: Archives a thread and any spawned descendants that are not already archived. It tears down loaded runtime state before archiving and tolerates some descendant read/archive failures with warnings.

**Data flow**: Parses `params.thread_id`, loads descendant IDs from `state_db_spawn_subtree_thread_ids`, probes the root and descendants in `thread_store.read_thread(...)` to collect only unarchived IDs, then archives the root first and descendants in reverse order. Before each archive it calls `prepare_thread_for_archive`. Root archive failures abort via `thread_store_archive_error`; descendant failures are logged and skipped. Returns `(ThreadArchiveResponse {}, archived_thread_ids_as_strings)`.

**Call relations**: Called by `thread_archive_inner`; it depends on state-db descendant lookup, shared removal prep, and archive-specific error mapping.

*Call graph*: calls 4 internal fn (prepare_thread_for_archive, state_db_spawn_subtree_thread_ids, thread_store_archive_error, from_string); called by 1 (thread_archive_inner); 2 external calls (new, warn!).


##### `ThreadRequestProcessor::state_db_spawn_subtree_thread_ids`  (lines 1414–1437)

```
async fn state_db_spawn_subtree_thread_ids(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<ThreadId>, JSONRPCErrorError>
```

**Purpose**: Returns a root thread ID plus any spawned descendants known to the app-server state DB, deduplicated. If no state DB is configured, it returns just the root.

**Data flow**: Starts `thread_ids` with `vec![thread_id]`. If `self.state_db` is absent, returns that vector. Otherwise it calls `list_thread_spawn_descendants(thread_id).await`, maps failures to `internal_error`, deduplicates descendants with a `HashSet`, appends unseen IDs, and returns the vector.

**Call relations**: Used by archive and delete flows to discover persisted spawned descendants beyond what the live runtime may currently know.

*Call graph*: called by 1 (thread_archive_response); 2 external calls (from, vec!).


##### `ThreadRequestProcessor::thread_increment_elicitation_inner`  (lines 1439–1456)

```
async fn thread_increment_elicitation_inner(
        &self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<ThreadIncrementElicitationResponse, JSONRPCErrorError>
```

**Purpose**: Increments the out-of-band elicitation counter on a loaded thread and reports the new count plus whether the thread is paused. It treats backend failures as internal errors.

**Data flow**: Loads the thread with `load_thread(&params.thread_id).await?`, awaits `thread.increment_out_of_band_elicitation_count()`, maps failures to `internal_error`, and returns `ThreadIncrementElicitationResponse { count, paused: count > 0 }`.

**Call relations**: Called only by the public `thread_increment_elicitation` wrapper.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_increment_elicitation).


##### `ThreadRequestProcessor::thread_decrement_elicitation_inner`  (lines 1458–1476)

```
async fn thread_decrement_elicitation_inner(
        &self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<ThreadDecrementElicitationResponse, JSONRPCErrorError>
```

**Purpose**: Decrements the out-of-band elicitation counter on a loaded thread and reports the new count plus paused state. It preserves invalid-request errors from the core layer.

**Data flow**: Loads the thread with `load_thread`, awaits `thread.decrement_out_of_band_elicitation_count()`, maps `CodexErr::InvalidRequest` to `invalid_request` and other failures to `internal_error`, then returns `ThreadDecrementElicitationResponse { count, paused: count > 0 }`.

**Call relations**: Called only by the public `thread_decrement_elicitation` wrapper.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_decrement_elicitation).


##### `ThreadRequestProcessor::thread_set_name_response_inner`  (lines 1478–1510)

```
async fn thread_set_name_response_inner(
        &self,
        params: ThreadSetNameParams,
    ) -> Result<(ThreadSetNameResponse, Option<ThreadNameUpdatedNotification>), JSONRPCErrorError>
```

**Purpose**: Validates and persists a thread name update, returning both the response and an optional notification payload. Empty or whitespace-only names are rejected.

**Data flow**: Destructures `ThreadSetNameParams`, parses `thread_id`, normalizes `name` with `codex_core::util::normalize_thread_name`, rejects `None` as invalid request, acquires the thread-list permit, and calls `thread_manager.update_thread_metadata(...)` with `StoreThreadMetadataPatch { name: Some(Some(name.clone())), ..Default::default() }`. It maps failures with `core_thread_write_error` and returns `(ThreadSetNameResponse {}, Some(ThreadNameUpdatedNotification { ... }))`.

**Call relations**: Called by the public `thread_set_name` wrapper, which sends the response and notification.

*Call graph*: calls 3 internal fn (acquire_thread_list_state_permit, normalize_thread_name, from_string); called by 1 (thread_set_name); 1 external calls (default).


##### `ThreadRequestProcessor::thread_memory_mode_set_response_inner`  (lines 1512–1533)

```
async fn thread_memory_mode_set_response_inner(
        &self,
        params: ThreadMemoryModeSetParams,
    ) -> Result<ThreadMemoryModeSetResponse, JSONRPCErrorError>
```

**Purpose**: Persists a thread memory-mode change through thread metadata update. It is a straightforward metadata write path.

**Data flow**: Parses `thread_id`, calls `thread_manager.update_thread_metadata(...)` with `StoreThreadMetadataPatch { memory_mode: Some(mode.to_core()), ..Default::default() }`, maps failures with `core_thread_write_error`, and returns `ThreadMemoryModeSetResponse {}`.

**Call relations**: Called only by the public `thread_memory_mode_set` wrapper.

*Call graph*: calls 1 internal fn (from_string); called by 1 (thread_memory_mode_set); 1 external calls (default).


##### `ThreadRequestProcessor::memory_reset_response_inner`  (lines 1535–1559)

```
async fn memory_reset_response_inner(&self) -> Result<MemoryResetResponse, JSONRPCErrorError>
```

**Purpose**: Clears all persisted memory rows and deletes memory-root directory contents under `codex_home`. It requires a configured SQLite state DB.

**Data flow**: Clones `self.state_db` or returns `internal_error("sqlite state db unavailable for memory reset")`. It then awaits `state_db.memories().clear_memory_data()`, maps failures to `internal_error`, calls `clear_memory_roots_contents(&self.config.codex_home).await`, maps filesystem failures similarly, and returns `MemoryResetResponse {}`.

**Call relations**: Called only by the public `memory_reset` wrapper.

*Call graph*: called by 1 (memory_reset).


##### `ThreadRequestProcessor::thread_metadata_update_response_inner`  (lines 1561–1624)

```
async fn thread_metadata_update_response_inner(
        &self,
        params: ThreadMetadataUpdateParams,
    ) -> Result<ThreadMetadataUpdateResponse, JSONRPCErrorError>
```

**Purpose**: Updates persisted git metadata for a thread and returns a refreshed API thread view with current loaded status and attached name. It validates that at least one git field is being changed.

**Data flow**: Parses `thread_id`, extracts `git_info`, rejects missing or all-`None` updates, normalizes each field with `normalize_thread_metadata_git_field`, builds `StoreThreadMetadataPatch`, acquires the thread-list permit, and calls `thread_manager.update_thread_metadata(... include_archived: true)`. It converts the returned `StoredThread` with `thread_from_stored_thread`, patches in a live session ID if the thread is loaded, calls `attach_thread_name`, resolves loaded status from `thread_watch_manager`, and returns `ThreadMetadataUpdateResponse { thread }`.

**Call relations**: Called only by the public `thread_metadata_update` wrapper.

*Call graph*: calls 5 internal fn (acquire_thread_list_state_permit, attach_thread_name, thread_from_stored_thread, loaded_status_for_thread, from_string); called by 1 (thread_metadata_update); 2 external calls (default, normalize_thread_metadata_git_field).


##### `ThreadRequestProcessor::normalize_thread_metadata_git_field`  (lines 1626–1641)

```
fn normalize_thread_metadata_git_field(
        value: Option<Option<String>>,
        name: &str,
    ) -> Result<Option<Option<String>>, JSONRPCErrorError>
```

**Purpose**: Normalizes optional git metadata update fields, trimming strings and rejecting empty explicit values. It preserves the distinction between omitted, cleared, and set fields.

**Data flow**: Matches `value: Option<Option<String>>`: `Some(Some(value))` trims and rejects empty strings with `invalid_request(format!("{name} must not be empty"))`, returning `Some(Some(trimmed))`; `Some(None)` returns `Some(None)` to mean explicit clear; `None` returns `None` to mean unchanged.

**Call relations**: Used by `thread_metadata_update_response_inner` for `gitInfo.sha`, `gitInfo.branch`, and `gitInfo.originUrl`.

*Call graph*: 1 external calls (format!).


##### `ThreadRequestProcessor::thread_unarchive_inner`  (lines 1643–1650)

```
async fn thread_unarchive_inner(
        &self,
        params: ThreadUnarchiveParams,
    ) -> Result<(ThreadUnarchiveResponse, ThreadUnarchivedNotification), JSONRPCErrorError>
```

**Purpose**: Serializes unarchive work against thread-list state and delegates to the unarchive implementation. It returns both the response and notification payload.

**Data flow**: Acquires the thread-list permit, awaits `thread_unarchive_response(params)`, wraps the returned thread ID string into `ThreadUnarchivedNotification`, and returns the tuple.

**Call relations**: Called only by the public `thread_unarchive` wrapper.

*Call graph*: calls 2 internal fn (acquire_thread_list_state_permit, thread_unarchive_response); called by 1 (thread_unarchive).


##### `ThreadRequestProcessor::thread_unarchive_response`  (lines 1652–1677)

```
async fn thread_unarchive_response(
        &self,
        params: ThreadUnarchiveParams,
    ) -> Result<(ThreadUnarchiveResponse, String), JSONRPCErrorError>
```

**Purpose**: Unarchives a persisted thread and reconstructs its API thread view with current loaded status and attached name. It does not load the thread into runtime memory.

**Data flow**: Parses `params.thread_id`, calls `thread_store.unarchive_thread(StoreArchiveThreadParams { thread_id })`, maps failures with `thread_store_archive_error`, converts the returned `StoredThread` with `thread_from_stored_thread`, resolves loaded status from `thread_watch_manager`, calls `attach_thread_name`, and returns `(ThreadUnarchiveResponse { thread }, thread.id.clone())`.

**Call relations**: Called by `thread_unarchive_inner`; the public wrapper sends the response and notification.

*Call graph*: calls 4 internal fn (attach_thread_name, thread_from_stored_thread, loaded_status_for_thread, from_string); called by 1 (thread_unarchive_inner).


##### `ThreadRequestProcessor::thread_rollback_inner`  (lines 1679–1685)

```
async fn thread_rollback_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Thin wrapper around rollback startup. It exists to keep the public wrapper small and consistent with other inner methods.

**Data flow**: Passes `request_id` and `params` to `thread_rollback_start(request_id, params).await` and returns its `Result<(), JSONRPCErrorError>`.

**Call relations**: Called only by the public `thread_rollback` wrapper.

*Call graph*: calls 1 internal fn (thread_rollback_start); called by 1 (thread_rollback).


##### `ThreadRequestProcessor::thread_rollback_start`  (lines 1687–1737)

```
async fn thread_rollback_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts a rollback operation on a loaded thread while preventing concurrent rollbacks on the same thread. It records the pending request in thread state until the core emits completion events.

**Data flow**: Destructures `ThreadRollbackParams`, rejects `num_turns == 0`, loads the thread with `load_thread`, clones the request ID, locks thread state via `thread_state_manager.thread_state(thread_id)`, and either detects an existing `pending_rollbacks` or stores the current request there. If a rollback is already in progress it returns `invalid_request`. Otherwise it submits `Op::ThreadRollback { num_turns }` via `submit_core_op`; on submission failure it clears `pending_rollbacks` and returns `internal_error("failed to start rollback: ...")`.

**Call relations**: Called by `thread_rollback_inner`; later rollback completion is handled elsewhere via thread events.

*Call graph*: calls 3 internal fn (load_thread, submit_core_op, thread_state); called by 1 (thread_rollback_inner); 2 external calls (clone, format!).


##### `ThreadRequestProcessor::thread_compact_start_inner`  (lines 1739–1751)

```
async fn thread_compact_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadCompactStartParams,
    ) -> Result<ThreadCompactStartResponse, JSONRPCErrorError>
```

**Purpose**: Starts compaction on a loaded thread by submitting the core `Op::Compact`. It is a fire-and-forget initiation RPC.

**Data flow**: Loads the thread with `load_thread`, submits `Op::Compact` via `submit_core_op`, maps failures to `internal_error("failed to start compaction: ...")`, and returns `ThreadCompactStartResponse {}`.

**Call relations**: Called only by the public `thread_compact_start` wrapper.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_compact_start).


##### `ThreadRequestProcessor::thread_background_terminals_clean_inner`  (lines 1753–1767)

```
async fn thread_background_terminals_clean_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadBackgroundTerminalsCleanParams,
    ) -> Result<ThreadBackgroundTermina
```

**Purpose**: Requests cleanup of background terminals for a loaded thread by submitting the corresponding core operation. It is a fire-and-forget initiation RPC.

**Data flow**: Loads the thread with `load_thread`, submits `Op::CleanBackgroundTerminals` via `submit_core_op`, maps failures to `internal_error("failed to clean background terminals: ...")`, and returns `ThreadBackgroundTerminalsCleanResponse {}`.

**Call relations**: Called only by the public `thread_background_terminals_clean` wrapper.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_background_terminals_clean).


##### `ThreadRequestProcessor::thread_background_terminals_list_inner`  (lines 1769–1798)

```
async fn thread_background_terminals_list_inner(
        &self,
        params: ThreadBackgroundTerminalsListParams,
    ) -> Result<ThreadBackgroundTerminalsListResponse, JSONRPCErrorError>
```

**Purpose**: Lists background terminals for a loaded thread and paginates them by process ID cursor. It converts runtime terminal records into API `ThreadBackgroundTerminal` values.

**Data flow**: Destructures params, loads the thread with `load_thread`, awaits `thread.list_background_terminals()`, maps each terminal into `ThreadBackgroundTerminal` with `os_pid`, `cpu_percent`, and `rss_kb` set to `None`, then calls `paginate_background_terminals(&terminals, cursor, limit)?` and returns `ThreadBackgroundTerminalsListResponse { data, next_cursor }`.

**Call relations**: Called only by the public `thread_background_terminals_list` wrapper.

*Call graph*: calls 2 internal fn (load_thread, paginate_background_terminals); called by 1 (thread_background_terminals_list).


##### `ThreadRequestProcessor::thread_background_terminals_terminate_inner`  (lines 1800–1815)

```
async fn thread_background_terminals_terminate_inner(
        &self,
        params: ThreadBackgroundTerminalsTerminateParams,
    ) -> Result<ThreadBackgroundTerminalsTerminateResponse, JSONRPCErrorE
```

**Purpose**: Terminates a specific background terminal process in a loaded thread. It validates the process ID string before delegating to the runtime.

**Data flow**: Parses `process_id` from string to `i32`, mapping parse failures to `invalid_request`, loads the thread with `load_thread`, awaits `thread.terminate_background_terminal(process_id)`, and returns `ThreadBackgroundTerminalsTerminateResponse { terminated }`.

**Call relations**: Called only by the public `thread_background_terminals_terminate` wrapper.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_background_terminals_terminate).


##### `ThreadRequestProcessor::thread_shell_command_inner`  (lines 1817–1847)

```
async fn thread_shell_command_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadShellCommandParams,
    ) -> Result<ThreadShellCommandResponse, JSONRPCErrorError>
```

**Purpose**: Starts a local-host shell command on a loaded thread through the core runtime. It is explicitly separate from normal tool execution and requires a configured local environment.

**Data flow**: Trims `params.command`, rejects empty commands, checks `thread_manager.environment_manager().try_local_environment().is_none()` and returns `internal_error("local environment is not configured")` if absent, loads the thread with `load_thread`, submits `Op::RunUserShellCommand { command }` via `submit_core_op`, maps failures to `internal_error`, and returns `ThreadShellCommandResponse {}`.

**Call relations**: Called only by the public `thread_shell_command` wrapper.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_shell_command).


##### `ThreadRequestProcessor::thread_approve_guardian_denied_action_inner`  (lines 1849–1867)

```
async fn thread_approve_guardian_denied_action_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadApproveGuardianDeniedActionParams,
    ) -> Result<ThreadApproveGua
```

**Purpose**: Approves a Guardian-denied action by deserializing the event payload and submitting the corresponding core operation to a loaded thread.

**Data flow**: Destructures params, parses `event` from `serde_json::Value` with `serde_json::from_value`, mapping failures to `invalid_request`, loads the thread with `load_thread`, submits `Op::ApproveGuardianDeniedAction { event }` via `submit_core_op`, maps failures to `internal_error`, and returns `ThreadApproveGuardianDeniedActionResponse {}`.

**Call relations**: Called only by the public `thread_approve_guardian_denied_action` wrapper.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_approve_guardian_denied_action); 1 external calls (from_value).


##### `ThreadRequestProcessor::thread_list_response_inner`  (lines 1869–1955)

```
async fn thread_list_response_inner(
        &self,
        params: ThreadListParams,
    ) -> Result<ThreadListResponse, JSONRPCErrorError>
```

**Purpose**: Lists persisted threads with pagination, sorting, and multiple filters, then overlays current loaded statuses. It also computes a backwards cursor for reverse pagination.

**Data flow**: Destructures `ThreadListParams`, normalizes cwd filters, parses optional `parent_thread_id`, clamps page size, maps API sort key/direction to store enums, and calls `list_threads_common(...)`. It computes `backwards_cursor` from the first stored thread, converts each `StoredThread` with `thread_from_stored_thread`, collects IDs, fetches loaded statuses via `thread_watch_manager.loaded_statuses_for_threads`, overlays any loaded status onto each thread, and returns `ThreadListResponse { data, next_cursor, backwards_cursor }`.

**Call relations**: Called only by the public `thread_list` wrapper; it delegates store pagination/filtering to `list_threads_common`.

*Call graph*: calls 4 internal fn (list_threads_common, normalize_thread_list_cwd_filters, thread_from_stored_thread, loaded_statuses_for_threads); called by 1 (thread_list); 1 external calls (with_capacity).


##### `ThreadRequestProcessor::thread_search_response_inner`  (lines 1957–2080)

```
async fn thread_search_response_inner(
        &self,
        params: ThreadSearchParams,
    ) -> Result<ThreadSearchResponse, JSONRPCErrorError>
```

**Purpose**: Performs paginated full-text search over persisted threads, applying source-kind filtering on top of store results and overlaying current loaded statuses. It loops across store pages until enough filtered results are collected or pagination ends.

**Data flow**: Validates and trims `search_term`, clamps page size, maps sort settings, computes source filters, then repeatedly calls `thread_store.search_threads(...)` with the remaining page size. It filters each page’s results by `source_kind_filter`, accumulates up to the requested count, tracks `next_cursor`, and breaks on repeated cursors to avoid infinite loops. It computes `backwards_cursor`, converts each result’s `StoredThread` with `thread_from_stored_thread`, fetches loaded statuses, overlays them, pairs each thread with its snippet, and returns `ThreadSearchResponse { data, next_cursor, backwards_cursor }`.

**Call relations**: Called only by the public `thread_search` wrapper.

*Call graph*: calls 2 internal fn (thread_from_stored_thread, loaded_statuses_for_threads); called by 1 (thread_search); 1 external calls (with_capacity).


##### `ThreadRequestProcessor::thread_loaded_list_response_inner`  (lines 2082–2127)

```
async fn thread_loaded_list_response_inner(
        &self,
        params: ThreadLoadedListParams,
    ) -> Result<ThreadLoadedListResponse, JSONRPCErrorError>
```

**Purpose**: Lists currently loaded thread IDs in sorted lexical order with simple cursor pagination. The cursor is itself validated as a thread ID string.

**Data flow**: Collects `thread_manager.list_thread_ids().await` into `Vec<String>`, sorts it, computes the start index from optional `cursor` by parsing it with `ThreadId::from_string` and binary-searching the sorted list, applies `limit` or total length, slices the page, computes `next_cursor` from the last item when more remain, and returns `ThreadLoadedListResponse { data: page, next_cursor }`.

**Call relations**: Called only by the public `thread_loaded_list` wrapper.

*Call graph*: calls 1 internal fn (from_string); called by 1 (thread_loaded_list); 1 external calls (format!).


##### `ThreadRequestProcessor::thread_read_response_inner`  (lines 2129–2146)

```
async fn thread_read_response_inner(
        &self,
        params: ThreadReadParams,
    ) -> Result<ThreadReadResponse, JSONRPCErrorError>
```

**Purpose**: Parses the requested thread ID, builds a thread view with optional turns, and wraps it in the protocol response. It delegates all view-construction complexity to `read_thread_view`.

**Data flow**: Destructures `ThreadReadParams`, parses `thread_id`, awaits `read_thread_view(thread_uuid, include_turns)`, maps `ThreadReadViewError` with `thread_read_view_error`, and returns `ThreadReadResponse { thread }`.

**Call relations**: Called only by the public `thread_read` wrapper.

*Call graph*: calls 2 internal fn (read_thread_view, from_string); called by 1 (thread_read).


##### `ThreadRequestProcessor::read_thread_view`  (lines 2149–2220)

```
async fn read_thread_view(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Thread, ThreadReadViewError>
```

**Purpose**: Builds the API thread view for `thread/read` by combining persisted metadata/history with optional live runtime state. It handles loaded vs unloaded threads and include-turns semantics, then normalizes status and stale in-progress turns.

**Data flow**: Looks up an optional loaded thread. If `include_turns` is true, it prefers a loaded-thread path that combines persisted metadata with live history, otherwise falls back to persisted history-only or errors if neither exists. If `include_turns` is false, it prefers persisted metadata-only, then falls back to a live snapshot for not-yet-materialized loaded threads. After obtaining a `Thread`, it computes `has_live_in_progress_turn` from the loaded thread’s `agent_status`, fetches loaded status from `thread_watch_manager`, calls `set_thread_status_and_interrupt_stale_turns`, and returns the thread.

**Call relations**: Called by `thread_read_response_inner`; it delegates to `load_persisted_thread_for_read` and `load_live_thread_view` depending on availability.

*Call graph*: calls 3 internal fn (load_live_thread_view, load_persisted_thread_for_read, loaded_status_for_thread); called by 1 (thread_read_response_inner); 3 external calls (InvalidRequest, format!, matches!).


##### `ThreadRequestProcessor::load_persisted_thread_for_read`  (lines 2222–2260)

```
async fn load_persisted_thread_for_read(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Option<Thread>, ThreadReadViewError>
```

**Purpose**: Loads a thread view from the thread store for `thread/read`, optionally including history. It treats missing rollout/materialization as `Ok(None)` rather than an immediate error.

**Data flow**: Calls `thread_store.read_thread(StoreReadThreadParams { include_archived: true, include_history: include_turns, ... })`. On success it converts the `StoredThread` with `thread_from_stored_thread` and, when `include_turns`, reconstructs turns from `history.items`. Specific `InvalidRequest` and `ThreadNotFound` cases that mean no rollout/materialization return `Ok(None)`; other invalid requests become `ThreadReadViewError::InvalidRequest`, and all other failures become `ThreadReadViewError::Internal`.

**Call relations**: Used by `read_thread_view` as the persisted-data branch for both metadata-only and include-turns reads.

*Call graph*: calls 1 internal fn (thread_from_stored_thread); called by 1 (read_thread_view); 3 external calls (Internal, InvalidRequest, format!).


##### `ThreadRequestProcessor::load_live_thread_view`  (lines 2263–2291)

```
async fn load_live_thread_view(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
        loaded_thread: &CodexThread,
        persisted_thread: Option<Thread>,
    ) -> Result<
```

**Purpose**: Builds a `thread/read` view from a loaded thread, optionally merging in persisted metadata. It rejects include-turns for ephemeral threads because they have no materialized rollout history.

**Data flow**: Reads `config_snapshot = loaded_thread.config_snapshot().await`, rejects `include_turns && config_snapshot.ephemeral`, builds a fallback thread with `build_thread_from_loaded_snapshot`, merges persisted fields like `path`, `session_id`, and `ephemeral` when `persisted_thread` is provided, then calls `apply_thread_read_store_fields(thread_id, &mut thread, include_turns, loaded_thread).await?` and returns the thread.

**Call relations**: Called by `read_thread_view` when a loaded thread must supply the response, either with or without persisted metadata.

*Call graph*: calls 3 internal fn (apply_thread_read_store_fields, build_thread_from_loaded_snapshot, config_snapshot); called by 1 (read_thread_view); 1 external calls (InvalidRequest).


##### `ThreadRequestProcessor::apply_thread_read_store_fields`  (lines 2293–2311)

```
async fn apply_thread_read_store_fields(
        &self,
        thread_id: ThreadId,
        thread: &mut Thread,
        include_turns: bool,
        loaded_thread: &CodexThread,
    ) -> Result<(),
```

**Purpose**: Adds store-derived fields to a live thread-read view, specifically the persisted thread name and optional reconstructed turns from loaded history. It keeps this augmentation separate from the base snapshot construction.

**Data flow**: Calls `attach_thread_name(thread_id, thread).await`. If `include_turns` is true, it awaits `loaded_thread.load_history(true)`, maps failures with `thread_read_history_load_error`, reconstructs turns with `build_api_turns_from_rollout_items`, and assigns them to `thread.turns`.

**Call relations**: Used only by `load_live_thread_view`.

*Call graph*: calls 2 internal fn (attach_thread_name, load_history); called by 1 (load_live_thread_view).


##### `ThreadRequestProcessor::thread_turns_list_response_inner`  (lines 2313–2365)

```
async fn thread_turns_list_response_inner(
        &self,
        params: ThreadTurnsListParams,
    ) -> Result<ThreadTurnsListResponse, JSONRPCErrorError>
```

**Purpose**: Builds a paginated turn list for a thread from persisted rollout history plus any live active turn snapshot. It supports sort direction and item-view shaping.

**Data flow**: Parses `thread_id`, loads rollout items with `load_thread_turns_list_history(thread_uuid).await`, checks whether a loaded thread exists and whether it is running, optionally reads `active_turn_snapshot()` from thread state, fetches loaded status from `thread_watch_manager`, and calls `build_thread_turns_page_response(&items, loaded_status, has_live_running_thread, active_turn, ThreadTurnsPageOptions { ... })`.

**Call relations**: Called only by the public `thread_turns_list` wrapper; it delegates history loading and page construction to helpers.

*Call graph*: calls 5 internal fn (load_thread_turns_list_history, build_thread_turns_page_response, thread_state, loaded_status_for_thread, from_string); called by 1 (thread_turns_list); 1 external calls (matches!).


##### `ThreadRequestProcessor::load_thread_turns_list_history`  (lines 2367–2422)

```
async fn load_thread_turns_list_history(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<RolloutItem>, ThreadReadViewError>
```

**Purpose**: Loads rollout history for `thread/turns/list`, preferring persisted store history and falling back to live loaded-thread history when the thread is not yet materialized in the store. It rejects ephemeral threads.

**Data flow**: First calls `thread_store.read_thread(... include_history: true)`. On success it extracts `stored_thread.history.items`; specific no-rollout/not-found cases fall through to a live-thread fallback; other invalid/unsupported/internal failures become `ThreadReadViewError`. In the fallback path it loads the thread from `thread_manager`, rejects `config_snapshot.ephemeral`, then awaits `thread.load_history(true)` and returns `history.items`, mapping failures with `thread_turns_list_history_load_error`.

**Call relations**: Used only by `thread_turns_list_response_inner`.

*Call graph*: called by 1 (thread_turns_list_response_inner); 3 external calls (Internal, InvalidRequest, format!).


##### `ThreadRequestProcessor::thread_created_receiver`  (lines 2424–2426)

```
fn thread_created_receiver(&self) -> broadcast::Receiver<ThreadId>
```

**Purpose**: Exposes the thread-manager broadcast receiver for newly created thread IDs. It is a pass-through subscription helper.

**Data flow**: Calls `self.thread_manager.subscribe_thread_created()` and returns the resulting `broadcast::Receiver<ThreadId>`.

**Call relations**: Used by higher-level orchestration code that wants to observe thread creation events.

*Call graph*: called by 1 (thread_created_receiver).


##### `ThreadRequestProcessor::connection_initialized`  (lines 2428–2436)

```
async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        capabilities: ConnectionCapabilities,
    )
```

**Purpose**: Notifies `ThreadStateManager` that a connection has completed initialization and advertises its capabilities. This enables later listener attachment and request replay behavior.

**Data flow**: Passes `connection_id` and `capabilities` to `self.thread_state_manager.connection_initialized(connection_id, capabilities).await`.

**Call relations**: Called from connection lifecycle handling outside this file and from request handling when initialization completes.

*Call graph*: calls 1 internal fn (connection_initialized); called by 2 (connection_initialized, handle_client_request).


##### `ThreadRequestProcessor::connection_closed`  (lines 2438–2451)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Removes a connection from all thread subscriptions and reconciles stale app-server state for threads that are already gone. It is the processor’s connection-teardown hook.

**Data flow**: Awaits `thread_state_manager.remove_connection(connection_id)` to get affected `thread_ids`, then for each ID checks `thread_manager.get_thread(thread_id).await`. If the thread is missing, it calls `finalize_thread_teardown(thread_id).await`.

**Call relations**: Called by connection lifecycle handling when a client disconnects.

*Call graph*: calls 2 internal fn (finalize_thread_teardown, remove_connection); called by 1 (connection_closed).


##### `ThreadRequestProcessor::subscribe_running_assistant_turn_count`  (lines 2453–2455)

```
fn subscribe_running_assistant_turn_count(&self) -> watch::Receiver<usize>
```

**Purpose**: Exposes a watch receiver for the number of running assistant turns. It is a pass-through subscription helper.

**Data flow**: Calls `self.thread_watch_manager.subscribe_running_turn_count()` and returns the `watch::Receiver<usize>`.

**Call relations**: Used by higher-level monitoring/orchestration code outside this file.

*Call graph*: calls 1 internal fn (subscribe_running_turn_count); called by 1 (subscribe_running_assistant_turn_count).


##### `ThreadRequestProcessor::try_attach_thread_listener`  (lines 2458–2493)

```
async fn try_attach_thread_listener(
        &self,
        thread_id: ThreadId,
        connection_ids: Vec<ConnectionId>,
    )
```

**Purpose**: Best-effort attaches listeners for a set of initialized connections to a loaded thread, inheriting raw-event opt-in from the parent thread when applicable. It also ensures the watch manager has an up-to-date loaded-thread entry.

**Data flow**: Initializes `raw_events_enabled = false`, then if the thread is loaded reads its config snapshot, builds a `Thread` snapshot with `build_thread_from_snapshot`, upserts it into `thread_watch_manager`, and if the thread has `parent_thread_id` reads the parent thread state to inherit `experimental_raw_events`. It then iterates `connection_ids`, calling `ensure_conversation_listener(thread_id, connection_id, raw_events_enabled).await` and logging each result with `log_listener_attach_result`.

**Call relations**: Used by external orchestration code when connections should be attached to an already loaded thread.

*Call graph*: calls 4 internal fn (ensure_conversation_listener, build_thread_from_snapshot, thread_state, upsert_thread); called by 1 (try_attach_thread_listener).


##### `ThreadRequestProcessor::thread_resume_inner`  (lines 2495–2805)

```
async fn thread_resume_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadResumeParams,
        app_server_client_name: Option<String>,
        app_server_client_vers
```

**Purpose**: Implements the full resume flow for threads, including running-thread rejoin, cold resume from rollout or explicit history, config derivation, listener attachment, response construction, token-usage replay, and goal snapshot emission. It is one of the most complex request paths in the app-server.

**Data flow**: First rejects resumes for threads already in `pending_thread_unloads`, and rejects simultaneous `sandbox` and `permissions`. It computes whether resume payloads should be redacted, acquires the thread-list permit, and calls `resume_running_thread(...)`. If that returns `Handled`, it exits after the listener task sends the response; if it returns a stored-thread probe or `None`, it proceeds with cold resume. It chooses history from explicit `params.history`, the stored-thread probe, or `resume_thread_from_rollout`, builds config overrides, merges persisted resume metadata, loads config with `config_manager.load_for_cwd`, and calls `thread_manager.resume_thread_with_history(...)`. On success it sets app-server client info, auto-attaches a listener, reconstructs the API thread via `load_thread_from_resume_source_or_send_internal`, updates watch-manager state and status, optionally builds/redacts `initial_turns_page`, sends `ThreadResumeResponse`, optionally replays token usage, and finally calls `thread_goal_processor.emit_resume_goal_snapshot_and_continue(...)`.

**Call relations**: Called only by the public `thread_resume` wrapper. It orchestrates `resume_running_thread`, history-loading helpers, config helpers, listener lifecycle, thread reconstruction, token-usage replay, and goal snapshot sequencing.

*Call graph*: calls 16 internal fn (load_for_cwd, emit_resume_goal_snapshot_and_continue, acquire_thread_list_state_permit, build_thread_config_overrides, ensure_conversation_listener, load_and_apply_persisted_resume_metadata, load_thread_from_resume_source_or_send_internal, request_trace_context, resume_running_thread, resume_thread_from_history (+6 more)); called by 1 (thread_resume); 2 external calls (set_app_server_client_info, format!).


##### `ThreadRequestProcessor::load_and_apply_persisted_resume_metadata`  (lines 2807–2824)

```
async fn load_and_apply_persisted_resume_metadata(
        &self,
        thread_history: &InitialHistory,
        request_overrides: &mut Option<HashMap<String, serde_json::Value>>,
        typesafe_
```

**Purpose**: Loads persisted thread metadata from state DB for resumed histories and merges it into resume overrides when appropriate. It is a best-effort enhancement rather than a required step.

**Data flow**: Checks whether `thread_history` is `InitialHistory::Resumed`; if not, returns `None`. It clones `self.state_db`, fetches `get_thread(resumed_history.conversation_id).await`, ignores errors/missing rows, and when metadata exists calls `merge_persisted_resume_metadata(request_overrides, typesafe_overrides, &persisted_metadata)`. Returns `Some(persisted_metadata)` or `None`.

**Call relations**: Called by `thread_resume_inner` before loading config for a cold resume.

*Call graph*: calls 1 internal fn (merge_persisted_resume_metadata); called by 1 (thread_resume_inner).


##### `ThreadRequestProcessor::resume_running_thread`  (lines 2827–3011)

```
async fn resume_running_thread(
        &self,
        request_id: &ConnectionRequestId,
        params: &ThreadResumeParams,
        app_server_client_name: Option<String>,
        app_server_client_
```

**Purpose**: Attempts to satisfy a resume request from an already loaded thread instead of creating a new runtime thread. It validates path/override compatibility, may shut down idle cached threads to honor overrides, and otherwise enqueues an ordered resume response onto the thread listener task.

**Data flow**: Determines whether a matching loaded thread exists, optionally reading persisted source data with `read_stored_thread_for_resume`. If explicit history is supplied while the thread is already running, it returns an invalid request. For a running thread, it validates requested path against the active rollout path, computes override mismatches with `collect_resume_override_mismatches`, and if mismatches exist may shut down and remove an idle unsubscribed cached thread via `wait_for_thread_shutdown` and `finalize_thread_teardown`, returning `NotRunning(None)` so cold resume can proceed. Otherwise it ensures the listener task is running, sets app-server client info, builds a summary thread from stored metadata, gathers instruction sources and listener command sender, computes pending goal snapshot state via `thread_goal_processor.pending_resume_goal_state`, packages a `PendingThreadResumeRequest`, sends it as `ThreadListenerCommand::SendThreadResumeResponse`, and returns `Handled`. If no loaded thread can satisfy the request, it returns `NotRunning(Some(Box<StoredThread>))` or `NotRunning(None)`.

**Call relations**: Called only by `thread_resume_inner` as the fast path before cold resume. It depends on listener-task machinery in `thread_lifecycle.rs` to actually compose and send the running-thread resume response.

*Call graph*: calls 10 internal fn (pending_resume_goal_state, ensure_listener_task_running, finalize_thread_teardown, read_stored_thread_for_resume, stored_thread_to_api_thread, collect_resume_override_mismatches, subscribed_connection_ids, thread_state, loaded_status_for_thread, from_string); called by 1 (thread_resume_inner); 10 external calls (new, set_app_server_client_info, clone, NotRunning, SendThreadResumeResponse, format!, matches!, paths_match_after_normalization, warn!, warn!).


##### `ThreadRequestProcessor::resume_thread_from_history`  (lines 3014–3028)

```
async fn resume_thread_from_history(
        &self,
        history: &[ResponseItem],
    ) -> Result<InitialHistory, JSONRPCErrorError>
```

**Purpose**: Converts explicit response-item history supplied by the client into `InitialHistory::Forked`. It rejects empty history arrays.

**Data flow**: Checks `history.is_empty()` and returns `invalid_request("history must not be empty")` if so. Otherwise it clones each `ResponseItem`, wraps them as `RolloutItem::ResponseItem`, collects them into a vector, and returns `InitialHistory::Forked(...)`.

**Call relations**: Used by `thread_resume_inner` when the resume request includes explicit history instead of a thread ID/path lookup.

*Call graph*: called by 1 (thread_resume_inner); 3 external calls (is_empty, iter, Forked).


##### `ThreadRequestProcessor::resume_thread_from_rollout`  (lines 3031–3043)

```
async fn resume_thread_from_rollout(
        &self,
        thread_id: &str,
        path: Option<&PathBuf>,
    ) -> Result<(InitialHistory, StoredThread), JSONRPCErrorError>
```

**Purpose**: Loads a stored thread and converts its persisted history into `InitialHistory` for cold resume. It returns both the history and the original `StoredThread` for later response reconstruction.

**Data flow**: Calls `read_stored_thread_for_resume(thread_id, path, true).await?`, then `stored_thread_to_initial_history(&stored_thread).await?`, and returns `(history, stored_thread)`.

**Call relations**: Used by `thread_resume_inner` when no explicit history is supplied and no running-thread probe already provided a stored thread.

*Call graph*: calls 2 internal fn (read_stored_thread_for_resume, stored_thread_to_initial_history); called by 1 (thread_resume_inner).


##### `ThreadRequestProcessor::read_stored_thread_for_resume`  (lines 3045–3083)

```
async fn read_stored_thread_for_resume(
        &self,
        thread_id: &str,
        path: Option<&PathBuf>,
        include_history: bool,
    ) -> Result<StoredThread, JSONRPCErrorError>
```

**Purpose**: Loads a persisted thread by rollout path or thread ID for resume/fork operations, optionally including history. It rejects archived threads with a user-facing unarchive instruction.

**Data flow**: If `path` is provided, it calls `thread_store.read_thread_by_rollout_path(...)`; otherwise it parses `thread_id` and calls `thread_store.read_thread(...)`. It maps store failures with `thread_store_resume_read_error`. If the returned `StoredThread` has `archived_at.is_some()`, it returns `invalid_request("session ... is archived. Run `codex unarchive ...` to unarchive it first.")`; otherwise it returns the stored thread.

**Call relations**: Used by `resume_running_thread`, `resume_thread_from_rollout`, and `thread_fork_inner`.

*Call graph*: calls 1 internal fn (from_string); called by 3 (resume_running_thread, resume_thread_from_rollout, thread_fork_inner); 1 external calls (format!).


##### `ThreadRequestProcessor::stored_thread_to_initial_history`  (lines 3086–3105)

```
async fn stored_thread_to_initial_history(
        &self,
        stored_thread: &StoredThread,
    ) -> Result<InitialHistory, JSONRPCErrorError>
```

**Purpose**: Extracts persisted history from a `StoredThread` and wraps it as `InitialHistory::Resumed`. It errors if the caller forgot to request history from the store.

**Data flow**: Reads `stored_thread.history`, returning `internal_error("thread ... did not include persisted history")` if absent. Otherwise it clones `history.items`, copies `thread_id` and `rollout_path`, and returns `InitialHistory::Resumed(ResumedHistory { ... })`.

**Call relations**: Used by `resume_thread_from_rollout` and by `thread_resume_inner` when a running-thread probe already loaded a stored thread with history.

*Call graph*: called by 2 (resume_thread_from_rollout, thread_resume_inner); 1 external calls (Resumed).


##### `ThreadRequestProcessor::stored_thread_to_api_thread`  (lines 3107–3123)

```
fn stored_thread_to_api_thread(
        &self,
        stored_thread: StoredThread,
        fallback_provider: &str,
        include_turns: bool,
    ) -> Thread
```

**Purpose**: Converts a `StoredThread` into an API `Thread`, optionally reconstructing turns from persisted history. It is a convenience wrapper around `thread_from_stored_thread` plus turn population.

**Data flow**: Calls `thread_from_stored_thread(stored_thread, fallback_provider, &self.config.cwd)` to get `(thread, history)`. If `include_turns` and `history` is present, it calls `populate_thread_turns_from_history(&mut thread, &history.items, None)`. Returns the resulting `Thread`.

**Call relations**: Used by `resume_running_thread` for summary construction and by `thread_fork_inner` for persistent fork responses.

*Call graph*: calls 1 internal fn (thread_from_stored_thread); called by 2 (resume_running_thread, thread_fork_inner).


##### `ThreadRequestProcessor::read_stored_thread_for_new_fork`  (lines 3125–3138)

```
async fn read_stored_thread_for_new_fork(
        &self,
        thread_id: ThreadId,
        include_history: bool,
    ) -> Result<StoredThread, JSONRPCErrorError>
```

**Purpose**: Loads a newly created forked thread from the store, optionally including history. It is a thin helper around `thread_store.read_thread` with resume-style error mapping.

**Data flow**: Calls `thread_store.read_thread(StoreReadThreadParams { thread_id, include_archived: true, include_history })`, maps failures with `thread_store_resume_read_error`, and returns the `StoredThread`.

**Call relations**: Used only by `thread_fork_inner` when a persistent fork has already materialized its own rollout.

*Call graph*: called by 1 (thread_fork_inner).


##### `ThreadRequestProcessor::load_thread_from_resume_source_or_send_internal`  (lines 3140–3237)

```
async fn load_thread_from_resume_source_or_send_internal(
        &self,
        thread_id: ThreadId,
        thread: &CodexThread,
        thread_history: &InitialHistory,
        rollout_path: &Path
```

**Purpose**: Builds the API `Thread` returned by cold resume, using persisted source metadata when available and falling back to live snapshot construction for forked histories. It also optionally reconstructs turns and attaches the persisted thread name.

**Data flow**: Reads `config_snapshot` and `session_id` from the resumed `CodexThread`. For `InitialHistory::Resumed`, it tries to reload a metadata-only `StoredThread` either by rollout path or thread ID and converts it with `thread_from_stored_thread`; for `InitialHistory::Forked`, it builds a fresh thread with `build_thread_from_snapshot` and sets `preview` from `preview_from_rollout_items`; `New` and `Cleared` are treated as internal errors. It then overwrites `thread.id`, `thread.session_id`, and `thread.path`, optionally populates turns from `thread_history.get_rollout_items()`, calls `attach_thread_name`, and returns the thread or an internal-error string.

**Call relations**: Called by `thread_resume_inner` after `resume_thread_with_history` succeeds, to construct the response thread view.

*Call graph*: calls 7 internal fn (attach_thread_name, build_thread_from_snapshot, preview_from_rollout_items, thread_from_stored_thread, config_snapshot, session_configured, get_rollout_items); called by 1 (thread_resume_inner); 4 external calls (into, to_path_buf, format!, to_string).


##### `ThreadRequestProcessor::attach_thread_name`  (lines 3239–3254)

```
async fn attach_thread_name(&self, thread_id: ThreadId, thread: &mut Thread)
```

**Purpose**: Loads a persisted thread title from the store and applies it to an API thread when it is non-empty and distinct from the preview. This avoids duplicating preview text as the explicit name.

**Data flow**: Calls `thread_store.read_thread(... include_archived: true, include_history: false).await`; if successful and `stored_thread.name` trims to a non-empty string different from `stored_thread.preview.trim()`, it calls `set_thread_name_from_title(thread, title.to_string())`.

**Call relations**: Used by read/resume/unarchive/metadata-update paths whenever an API thread view should include the persisted title.

*Call graph*: calls 1 internal fn (set_thread_name_from_title); called by 4 (apply_thread_read_store_fields, load_thread_from_resume_source_or_send_internal, thread_metadata_update_response_inner, thread_unarchive_response).


##### `ThreadRequestProcessor::thread_fork_inner`  (lines 3256–3519)

```
async fn thread_fork_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadForkParams,
        app_server_client_name: Option<String>,
        app_server_client_version:
```

**Purpose**: Forks a new thread from persisted history, deriving config overrides, preserving source-thread naming when possible, auto-attaching a listener, and returning either a persisted or ephemeral fork view. It mirrors many resume behaviors but always creates a new thread.

**Data flow**: Destructures `ThreadForkParams`, rejects simultaneous `sandbox` and `permissions`, loads the source thread with `read_stored_thread_for_resume(... include_history: true)`, extracts source name and history items, injects Windows sandbox CLI overrides when needed, builds config overrides, loads config with `config_manager.load_for_cwd`, and calls `thread_manager.fork_thread_from_history(...)`. It sets app-server client info, optionally persists the inherited source name on the new thread, reads instruction sources, auto-attaches a listener, then builds the response thread either from a newly materialized stored fork (`read_stored_thread_for_new_fork` + `stored_thread_to_api_thread`) or from a live snapshot for ephemeral forks. It sets inherited name, session ID, and thread source, upserts the thread into `thread_watch_manager`, resolves status, computes sandbox and active permission profile, sends `ThreadForkResponse`, optionally replays token usage, and finally sends `ServerNotification::ThreadStarted`.

**Call relations**: Called only by the public `thread_fork` wrapper. It orchestrates stored-thread loading, config derivation, core fork creation, listener attachment, response construction, and notification emission.

*Call graph*: calls 12 internal fn (load_for_cwd, build_thread_config_overrides, ensure_conversation_listener, read_stored_thread_for_new_fork, read_stored_thread_for_resume, request_trace_context, stored_thread_to_api_thread, build_thread_from_snapshot, preview_from_rollout_items, set_thread_name_from_title (+2 more)); called by 1 (thread_fork); 7 external calls (default, set_app_server_client_info, ThreadStarted, cfg!, from_config, Resumed, json!).


##### `ThreadRequestProcessor::get_thread_summary_response_inner`  (lines 3521–3561)

```
async fn get_thread_summary_response_inner(
        &self,
        params: GetConversationSummaryParams,
    ) -> Result<GetConversationSummaryResponse, JSONRPCErrorError>
```

**Purpose**: Loads a lightweight conversation summary either by thread ID or by rollout path. Rollout-path queries are only supported when the thread store is the local implementation.

**Data flow**: Matches `GetConversationSummaryParams`. For `ThreadId`, it calls `thread_store.read_thread(... include_history: false)` and maps errors with `conversation_summary_thread_id_read_error`. For `RolloutPath`, it downcasts `self.thread_store` to `LocalThreadStore`, returning `invalid_request` if that fails, then calls `read_thread_by_rollout_path(...)` and maps errors with `conversation_summary_rollout_path_read_error`. It converts the resulting `StoredThread` with `summary_from_stored_thread` and returns `GetConversationSummaryResponse { summary }`.

**Call relations**: Called only by the public `conversation_summary` wrapper.

*Call graph*: calls 1 internal fn (summary_from_stored_thread); called by 1 (conversation_summary).


##### `ThreadRequestProcessor::list_threads_common`  (lines 3563–3673)

```
async fn list_threads_common(
        &self,
        requested_page_size: usize,
        cursor: Option<String>,
        sort_key: StoreThreadSortKey,
        sort_direction: SortDirection,
        fi
```

**Purpose**: Implements the shared pagination/filtering loop for `thread/list`, including repeated store fetches when post-store filtering drops items. It also prevents infinite loops on repeated cursors.

**Data flow**: Consumes page size, cursor, sort settings, and `ThreadListFilters`. It derives default model-provider filtering, computes source filters, then loops while more items are needed: calling `thread_store.list_threads(...)`, filtering each page by source-kind and normalized cwd matching, appending up to the remaining count, updating `next_cursor`, and breaking if the next cursor repeats the previous cursor. Returns `(items, next_cursor)`.

**Call relations**: Used only by `thread_list_response_inner` as the common store-pagination engine.

*Call graph*: called by 1 (thread_list_response_inner); 3 external calls (new, with_capacity, vec!).


##### `xcode_26_4_mcp_elicitations_auto_deny`  (lines 3676–3685)

```
fn xcode_26_4_mcp_elicitations_auto_deny(
    client_name: Option<&str>,
    client_version: Option<&str>,
) -> bool
```

**Purpose**: Implements a compatibility hack for Xcode 26.4 clients that predate visible MCP elicitation requests. It identifies that client line by exact name and version prefix.

**Data flow**: Returns `true` only when `client_name == Some("Xcode")` and `client_version` starts with `"26.4"`; otherwise returns `false`.

**Call relations**: Used only by `set_app_server_client_info` to decide the compatibility flag passed into the core thread runtime.

*Call graph*: called by 1 (set_app_server_client_info).


##### `thread_backwards_cursor_for_sort_key`  (lines 3690–3706)

```
fn thread_backwards_cursor_for_sort_key(
    thread: &StoredThread,
    sort_key: StoreThreadSortKey,
    sort_direction: SortDirection,
) -> Option<String>
```

**Purpose**: Computes a reverse-pagination cursor for thread list/search results by offsetting the anchor timestamp by one millisecond. This ensures opposite-direction queries include the page anchor.

**Data flow**: Selects `created_at` or `updated_at` from `StoredThread` based on `sort_key`, adds or subtracts one millisecond depending on `sort_direction`, converts the adjusted timestamp to RFC3339 millis, and returns it as `Some(String)` or `None` if the timestamp arithmetic overflows.

**Call relations**: Used by `thread_list_response_inner` and `thread_search_response_inner` to populate `backwards_cursor`.

*Call graph*: 1 external calls (milliseconds).


##### `paginate_thread_turns`  (lines 3721–3798)

```
fn paginate_thread_turns(
    turns: Vec<Turn>,
    cursor: Option<&str>,
    limit: Option<u32>,
    sort_direction: SortDirection,
) -> Result<ThreadTurnsPage, JSONRPCErrorError>
```

**Purpose**: Paginates a vector of reconstructed turns using a JSON cursor that names an anchor turn and whether to include it. It supports ascending and descending order and returns both forward and backward cursors.

**Data flow**: If `turns` is empty, returns an empty `ThreadTurnsPage`. Otherwise it parses the optional cursor with `parse_thread_turns_cursor`, clamps page size, finds the anchor index, errors if the anchor turn no longer exists, enumerates turns, reverses for descending order, filters relative to the anchor depending on `include_anchor`, truncates to page size, computes `backwards_cursor` from the first turn and `next_cursor` from the last turn when more remain using `serialize_thread_turns_cursor`, and returns `ThreadTurnsPage { turns, next_cursor, backwards_cursor }`.

**Call relations**: Used by `build_thread_turns_page_response` after turn reconstruction and item-view shaping.

*Call graph*: called by 1 (build_thread_turns_page_response); 1 external calls (new).


##### `serialize_thread_turns_cursor`  (lines 3800–3809)

```
fn serialize_thread_turns_cursor(
    turn_id: &str,
    include_anchor: bool,
) -> Result<String, JSONRPCErrorError>
```

**Purpose**: Serializes a turn-pagination cursor as JSON. Internal serialization failures are surfaced as internal JSON-RPC errors.

**Data flow**: Builds `ThreadTurnsCursor { turn_id: turn_id.to_string(), include_anchor }`, serializes it with `serde_json::to_string`, and maps serialization failure to `internal_error("failed to serialize cursor: ...")`.

**Call relations**: Used by `paginate_thread_turns` to produce `next_cursor` and `backwards_cursor`.

*Call graph*: 1 external calls (to_string).


##### `parse_thread_turns_cursor`  (lines 3811–3813)

```
fn parse_thread_turns_cursor(cursor: &str) -> Result<ThreadTurnsCursor, JSONRPCErrorError>
```

**Purpose**: Parses a JSON turn-pagination cursor and rewrites parse failures into invalid-request errors. It treats the entire cursor string as opaque client input.

**Data flow**: Calls `serde_json::from_str(cursor)` to deserialize `ThreadTurnsCursor`; on failure it returns `invalid_request(format!("invalid cursor: {cursor}"))`.

**Call relations**: Used by `paginate_thread_turns` when a client supplies a cursor.

*Call graph*: 1 external calls (from_str).


##### `build_thread_turns_page_response`  (lines 3822–3842)

```
fn build_thread_turns_page_response(
    items: &[RolloutItem],
    loaded_status: ThreadStatus,
    has_live_running_thread: bool,
    active_turn: Option<Turn>,
    options: ThreadTurnsPageOptions<'
```

**Purpose**: Builds the full `thread/turns/list` response from rollout items, loaded status, optional active turn, and pagination/view options. It centralizes turn reconstruction, item-view shaping, and pagination.

**Data flow**: Calls `reconstruct_thread_turns_for_turns_list(items, loaded_status, has_live_running_thread, active_turn)` to get turns, mutates them with `apply_thread_turns_items_view(&mut turns, options.items_view)`, paginates with `paginate_thread_turns(...)`, and returns `ThreadTurnsListResponse { data, next_cursor, backwards_cursor }`.

**Call relations**: Used by `thread_turns_list_response_inner` and by `build_thread_resume_initial_turns_page`.

*Call graph*: calls 3 internal fn (apply_thread_turns_items_view, paginate_thread_turns, reconstruct_thread_turns_for_turns_list); called by 2 (thread_turns_list_response_inner, build_thread_resume_initial_turns_page).


##### `build_thread_resume_initial_turns_page`  (lines 3844–3864)

```
fn build_thread_resume_initial_turns_page(
    items: &[RolloutItem],
    loaded_status: ThreadStatus,
    has_live_running_thread: bool,
    active_turn: Option<Turn>,
    params: &ThreadResumeInitia
```

**Purpose**: Builds the optional initial turns page embedded in a resume response using the same reconstruction and pagination logic as `thread/turns/list`. It converts the result into the protocol `TurnsPage` type.

**Data flow**: Calls `build_thread_turns_page_response(...)` with `cursor: None` and options derived from `ThreadResumeInitialTurnsPageParams`, then converts the resulting `ThreadTurnsListResponse` into `codex_app_server_protocol::TurnsPage` with `Into::into`.

**Call relations**: Used by cold resume in `thread_resume_inner` and running-thread resume in `handle_pending_thread_resume_request`.

*Call graph*: calls 1 internal fn (build_thread_turns_page_response); called by 2 (handle_pending_thread_resume_request, thread_resume_inner).


##### `apply_thread_turns_items_view`  (lines 3866–3902)

```
fn apply_thread_turns_items_view(turns: &mut [Turn], items_view: TurnItemsView)
```

**Purpose**: Shapes each turn’s `items` field according to the requested `TurnItemsView`. It can clear items entirely, keep only summary endpoints, or leave the full item list intact.

**Data flow**: Mutably iterates `turns`. For `NotLoaded`, it clears `turn.items` and sets `items_view`. For `Summary`, it finds the first `UserMessage` and last `AgentMessage`, keeps one or both without duplication, and sets `items_view = Summary`. For `Full`, it leaves items unchanged and sets `items_view = Full`.

**Call relations**: Called by `build_thread_turns_page_response` after turn reconstruction and before pagination.

*Call graph*: called by 1 (build_thread_turns_page_response); 2 external calls (new, vec!).


##### `reconstruct_thread_turns_for_turns_list`  (lines 3904–3920)

```
fn reconstruct_thread_turns_for_turns_list(
    items: &[RolloutItem],
    loaded_status: ThreadStatus,
    has_live_running_thread: bool,
    active_turn: Option<Turn>,
) -> Vec<Turn>
```

**Purpose**: Reconstructs turns from rollout items, normalizes stale in-progress statuses, and merges in an optional live active turn snapshot. It is the canonical turn-building path for paginated turn listing.

**Data flow**: Computes `has_live_in_progress_turn` from `has_live_running_thread` or `active_turn.status`, builds turns with `build_api_turns_from_rollout_items(items)`, calls `normalize_thread_turns_status(&mut turns, loaded_status, has_live_in_progress_turn)`, optionally merges `active_turn` with `merge_turn_history_with_active_turn`, and returns the resulting vector.

**Call relations**: Used only by `build_thread_turns_page_response`.

*Call graph*: calls 1 internal fn (normalize_thread_turns_status); called by 1 (build_thread_turns_page_response).


##### `normalize_thread_turns_status`  (lines 3922–3936)

```
fn normalize_thread_turns_status(
    turns: &mut [Turn],
    loaded_status: ThreadStatus,
    has_live_in_progress_turn: bool,
)
```

**Purpose**: Rewrites historical `InProgress` turns to `Interrupted` when the thread is not currently active. It keeps turn lists consistent with the resolved thread status.

**Data flow**: Computes `status = resolve_thread_status(loaded_status, has_live_in_progress_turn)`. If the status is active, it returns without changes; otherwise it iterates `turns` and changes any `TurnStatus::InProgress` to `TurnStatus::Interrupted`.

**Call relations**: Called by `reconstruct_thread_turns_for_turns_list`.

*Call graph*: called by 1 (reconstruct_thread_turns_for_turns_list); 1 external calls (matches!).


##### `thread_read_view_error`  (lines 3944–3952)

```
fn thread_read_view_error(err: ThreadReadViewError) -> JSONRPCErrorError
```

**Purpose**: Converts internal `ThreadReadViewError` values into JSON-RPC errors. It preserves invalid-request and unsupported-operation semantics while mapping internal failures to internal errors.

**Data flow**: Matches `ThreadReadViewError`: `InvalidRequest(message)` becomes `invalid_request(message)`, `Unsupported(operation)` delegates to `unsupported_thread_store_operation(operation)`, and `Internal(message)` becomes `internal_error(message)`.

**Call relations**: Used by `thread_read_response_inner` and indirectly by turn/history-loading helpers that return `ThreadReadViewError`.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation).


##### `unsupported_thread_store_operation`  (lines 3954–3956)

```
fn unsupported_thread_store_operation(operation: &'static str) -> JSONRPCErrorError
```

**Purpose**: Maps an unsupported thread-store operation into a method-not-found JSON-RPC error. This is how storage capability gaps are surfaced to clients.

**Data flow**: Formats `"{operation} is not supported yet"` and passes it to `method_not_found`, returning the resulting `JSONRPCErrorError`.

**Call relations**: Shared by many error mappers in this file and by delete/archive helpers in sibling modules.

*Call graph*: calls 1 internal fn (method_not_found); called by 7 (thread_store_delete_error, conversation_summary_rollout_path_read_error, conversation_summary_thread_id_read_error, thread_read_view_error, thread_store_archive_error, thread_store_list_error, thread_store_resume_read_error); 1 external calls (format!).


##### `thread_store_list_error`  (lines 3958–3966)

```
fn thread_store_list_error(err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps thread-store list/search failures into JSON-RPC errors with list-specific wording. It preserves invalid-request and unsupported-operation semantics.

**Data flow**: Matches `ThreadStoreError`: `InvalidRequest { message }` becomes `invalid_request(message)`, `Unsupported { operation }` delegates to `unsupported_thread_store_operation`, and all other variants become `internal_error(format!("failed to list threads: {err}"))`.

**Call relations**: Used by list/search pagination paths when store queries fail.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); 1 external calls (format!).


##### `thread_store_resume_read_error`  (lines 3968–3979)

```
fn thread_store_resume_read_error(err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps thread-store read failures during resume/fork into JSON-RPC errors with resume-specific wording. Missing threads become a no-rollout invalid request.

**Data flow**: Matches `ThreadStoreError`: invalid requests pass through, unsupported operations delegate, `ThreadNotFound { thread_id }` becomes `invalid_request("no rollout found for thread id ...")`, and all other variants become `internal_error(format!("failed to read thread: {err}"))`.

**Call relations**: Used by `read_stored_thread_for_resume` and `read_stored_thread_for_new_fork`.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); 1 external calls (format!).


##### `thread_turns_list_history_load_error`  (lines 3981–4001)

```
fn thread_turns_list_history_load_error(
    thread_id: ThreadId,
    err: ThreadStoreError,
) -> ThreadReadViewError
```

**Purpose**: Converts history-loading failures for `thread/turns/list` into `ThreadReadViewError`, with special messaging for not-yet-materialized threads. It distinguishes unsupported operations from generic internal failures.

**Data flow**: Matches `ThreadStoreError`: rollout-path resolution failures become `InvalidRequest("thread ... is not materialized yet; thread/turns/list is unavailable before first user message")`; other invalid requests pass through; unsupported operations become `Unsupported(operation)`; everything else becomes `Internal(format!("failed to load thread history for thread ...: {err}"))`.

**Call relations**: Used by `load_thread_turns_list_history` when falling back to live history or handling store failures.

*Call graph*: 4 external calls (Internal, InvalidRequest, Unsupported, format!).


##### `thread_read_history_load_error`  (lines 4003–4028)

```
fn thread_read_history_load_error(
    thread_id: ThreadId,
    err: ThreadStoreError,
) -> ThreadReadViewError
```

**Purpose**: Converts history-loading failures for `thread/read includeTurns` into `ThreadReadViewError`, with special messaging for not-yet-materialized threads. It mirrors the turns-list helper but with includeTurns wording.

**Data flow**: Matches `ThreadStoreError`: rollout-path resolution failures and matching `ThreadNotFound` become `InvalidRequest("thread ... is not materialized yet; includeTurns is unavailable before first user message")`; other invalid requests pass through; unsupported operations become `Unsupported(operation)`; everything else becomes `Internal(format!("failed to load thread history for thread ...: {err}"))`.

**Call relations**: Used by `apply_thread_read_store_fields` when loading live history for `thread/read`.

*Call graph*: 4 external calls (Internal, InvalidRequest, Unsupported, format!).


##### `conversation_summary_thread_id_read_error`  (lines 4030–4050)

```
fn conversation_summary_thread_id_read_error(
    conversation_id: ThreadId,
    err: ThreadStoreError,
) -> JSONRPCErrorError
```

**Purpose**: Maps thread-store failures for conversation-summary-by-ID into JSON-RPC errors, translating missing rollout into a conversation-specific not-found message. It preserves unsupported-operation semantics.

**Data flow**: Builds the expected no-rollout message for `conversation_id`, then matches `ThreadStoreError`: matching invalid-request/no-rollout and matching `ThreadNotFound` delegate to `conversation_summary_not_found_error`; unsupported operations delegate to `unsupported_thread_store_operation`; other invalid requests pass through; everything else becomes `internal_error(format!("failed to load conversation summary for ...: {err}"))`.

**Call relations**: Used by `get_thread_summary_response_inner` for `ThreadId` queries.

*Call graph*: calls 2 internal fn (conversation_summary_not_found_error, unsupported_thread_store_operation); 1 external calls (format!).


##### `conversation_summary_not_found_error`  (lines 4052–4056)

```
fn conversation_summary_not_found_error(conversation_id: ThreadId) -> JSONRPCErrorError
```

**Purpose**: Builds the standardized invalid-request error for a missing conversation summary. It uses conversation-specific wording rather than generic thread wording.

**Data flow**: Formats `"no rollout found for conversation id {conversation_id}"` and wraps it with `invalid_request`.

**Call relations**: Used only by `conversation_summary_thread_id_read_error`.

*Call graph*: called by 1 (conversation_summary_thread_id_read_error); 1 external calls (format!).


##### `conversation_summary_rollout_path_read_error`  (lines 4058–4073)

```
fn conversation_summary_rollout_path_read_error(
    path: &Path,
    err: ThreadStoreError,
) -> JSONRPCErrorError
```

**Purpose**: Maps thread-store failures for conversation-summary-by-rollout-path into JSON-RPC errors. It preserves invalid-request and unsupported-operation semantics while contextualizing internal failures with the path.

**Data flow**: Matches `ThreadStoreError`: invalid requests pass through, unsupported operations delegate to `unsupported_thread_store_operation`, and all other variants become `internal_error(format!("failed to load conversation summary from {}: {}", path.display(), err))`.

**Call relations**: Used by `get_thread_summary_response_inner` for rollout-path queries.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); 1 external calls (format!).


##### `core_thread_write_error`  (lines 4075–4084)

```
fn core_thread_write_error(operation: &str, err: CodexErr) -> JSONRPCErrorError
```

**Purpose**: Maps core-layer thread mutation failures into JSON-RPC errors with operation-specific wording. It preserves thread-not-found, invalid-request, and unsupported-operation semantics.

**Data flow**: Matches `CodexErr`: `ThreadNotFound(thread_id)` becomes `invalid_request("thread not found: ...")`; `InvalidRequest(message)` becomes `invalid_request(message)`; `UnsupportedOperation(message)` becomes `method_not_found(message)`; all other variants become `internal_error(format!("failed to {operation}: {err}"))`.

**Call relations**: Used by metadata/name/archive/delete-related write paths across this file and sibling modules.

*Call graph*: calls 1 internal fn (method_not_found); called by 1 (thread_delete_response); 1 external calls (format!).


##### `thread_store_archive_error`  (lines 4086–4094)

```
fn thread_store_archive_error(operation: &str, err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps archive/unarchive thread-store failures into JSON-RPC errors with archive-specific wording. It preserves invalid-request and unsupported-operation semantics.

**Data flow**: Matches `ThreadStoreError`: invalid requests pass through, unsupported operations delegate to `unsupported_thread_store_operation`, and all other variants become `internal_error(format!("failed to {operation} session: {err}"))`.

**Call relations**: Used by `thread_archive_response` and `thread_unarchive_response`.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); called by 1 (thread_archive_response); 1 external calls (format!).


##### `set_thread_name_from_title`  (lines 4096–4101)

```
fn set_thread_name_from_title(thread: &mut Thread, title: String)
```

**Purpose**: Applies a title as `thread.name` only when it is non-empty and not identical to the preview. This avoids redundant naming in API responses.

**Data flow**: Checks `title.trim().is_empty()` and whether `thread.preview.trim() == title.trim()`. If either is true it returns without changes; otherwise it sets `thread.name = Some(title)`.

**Call relations**: Used by `attach_thread_name` and by `thread_fork_inner` when inheriting a source thread’s name.

*Call graph*: called by 2 (attach_thread_name, thread_fork_inner).


##### `thread_from_stored_thread`  (lines 4103–4155)

```
fn thread_from_stored_thread(
    thread: StoredThread,
    fallback_provider: &str,
    fallback_cwd: &AbsolutePathBuf,
) -> (Thread, Option<codex_thread_store::StoredThreadHistory>)
```

**Purpose**: Converts a persisted `StoredThread` into the API `Thread` plus optional stored history. It normalizes cwd paths, fills fallback model provider values, and maps git/source metadata into API forms.

**Data flow**: Consumes `StoredThread`, extracts `rollout_path`, converts optional git info into `ApiGitInfo`, normalizes `cwd` with `path_utils::normalize_for_native_workdir` and `AbsolutePathBuf::relative_to_current_dir`, falling back to `fallback_cwd` on failure, enriches source metadata with `with_thread_spawn_agent_metadata`, preserves `history`, stringifies IDs, and constructs `Thread` with `status: NotLoaded`, `ephemeral: false`, empty `turns`, and either the stored or fallback model provider. Returns `(thread, history)`.

**Call relations**: Used throughout the file wherever persisted thread rows must become API thread views, including list/search/read/resume/unarchive/metadata-update paths.

*Call graph*: calls 1 internal fn (relative_to_current_dir); called by 7 (load_persisted_thread_for_read, load_thread_from_resume_source_or_send_internal, stored_thread_to_api_thread, thread_list_response_inner, thread_metadata_update_response_inner, thread_search_response_inner, thread_unarchive_response); 2 external calls (new, normalize_for_native_workdir).


##### `summary_from_stored_thread`  (lines 4157–4198)

```
fn summary_from_stored_thread(
    thread: StoredThread,
    fallback_provider: &str,
) -> ConversationSummary
```

**Purpose**: Converts a `StoredThread` into the lightweight `ConversationSummary` API type. It preserves millisecond timestamp precision so pagination cursors round-trip correctly.

**Data flow**: Consumes `StoredThread`, defaults missing rollout path to empty, enriches source metadata, converts optional git info into `ConversationGitInfo`, chooses the stored or fallback model provider, formats `created_at` and `updated_at` as RFC3339 millis, and returns `ConversationSummary`.

**Call relations**: Used by `get_thread_summary_response_inner`.

*Call graph*: called by 1 (get_thread_summary_response_inner).


##### `summary_from_state_db_metadata`  (lines 4202–4246)

```
fn summary_from_state_db_metadata(
    conversation_id: ThreadId,
    path: PathBuf,
    first_user_message: Option<String>,
    preview: Option<String>,
    timestamp: String,
    updated_at: String,
```

**Purpose**: Test-only helper that converts state-db thread metadata fields into `ConversationSummary`. It reconstructs source and git info from serialized test inputs.

**Data flow**: Consumes many scalar fields, chooses `preview.or(first_user_message).unwrap_or_default()`, parses `source` from JSON or plain string into a session source, enriches it with agent metadata, conditionally builds `ConversationGitInfo`, and returns `ConversationSummary`.

**Call relations**: Used only by the test-only `summary_from_thread_metadata` helper.

*Call graph*: called by 1 (summary_from_thread_metadata); 1 external calls (from_str).


##### `summary_from_thread_metadata`  (lines 4249–4272)

```
fn summary_from_thread_metadata(metadata: &ThreadMetadata) -> ConversationSummary
```

**Purpose**: Test-only adapter from `ThreadMetadata` to `ConversationSummary`. It delegates field-by-field conversion to `summary_from_state_db_metadata`.

**Data flow**: Reads fields from `metadata`, formats timestamps as RFC3339 seconds, and passes them to `summary_from_state_db_metadata`, returning the resulting summary.

**Call relations**: Used only in tests.

*Call graph*: calls 1 internal fn (summary_from_state_db_metadata).


##### `preview_from_rollout_items`  (lines 4274–4289)

```
fn preview_from_rollout_items(items: &[RolloutItem]) -> String
```

**Purpose**: Extracts the first user-message preview string from rollout items, stripping the `USER_MESSAGE_BEGIN` marker when present. It is used for fork/resume responses built from history rather than persisted metadata.

**Data flow**: Iterates `items`, finds the first `RolloutItem::ResponseItem` that parses as a user message via `codex_core::parse_turn_item`, takes its message text, strips any leading `USER_MESSAGE_BEGIN` marker and surrounding whitespace, and returns the resulting string or `String::new()` if none is found.

**Call relations**: Used by `load_thread_from_resume_source_or_send_internal` and `thread_fork_inner` when constructing preview text from copied history.

*Call graph*: called by 2 (load_thread_from_resume_source_or_send_internal, thread_fork_inner); 1 external calls (iter).


##### `requested_permissions_trust_project`  (lines 4291–4315)

```
fn requested_permissions_trust_project(overrides: &ConfigOverrides, cwd: &Path) -> bool
```

**Purpose**: Determines whether requested config overrides imply trusting the project directory. It checks sandbox mode, built-in permission profile names, and explicit permission profiles.

**Data flow**: Reads `overrides.sandbox_mode`, `overrides.default_permissions`, and optional `overrides.permission_profile`. It returns `true` for workspace-write or danger-full-access sandbox modes, for built-in workspace/full-access permission profile names, or when `permission_profile_trusts_project(profile, cwd)` is true; otherwise `false`.

**Call relations**: Used by `thread_start_task` when deciding whether to persist or inject trusted-project state before reloading config.

*Call graph*: called by 1 (thread_start_task); 1 external calls (matches!).


##### `permission_profile_trusts_project`  (lines 4317–4328)

```
fn permission_profile_trusts_project(
    profile: &codex_protocol::models::PermissionProfile,
    cwd: &Path,
) -> bool
```

**Purpose**: Determines whether a resolved permission profile effectively trusts the project path. Managed profiles are inspected via their filesystem sandbox policy.

**Data flow**: Matches `profile`: `Disabled` and `External` return `true`; `Managed` calls `profile.file_system_sandbox_policy().can_write_path_with_cwd(cwd, cwd)` and returns that boolean.

**Call relations**: Used by `thread_start_task` and `requested_permissions_trust_project`.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 1 (thread_start_task).


##### `build_thread_from_snapshot`  (lines 4330–4359)

```
fn build_thread_from_snapshot(
    thread_id: ThreadId,
    session_id: String,
    config_snapshot: &ThreadConfigSnapshot,
    path: Option<PathBuf>,
) -> Thread
```

**Purpose**: Builds a fresh API `Thread` from a live config snapshot and optional rollout path. It is used for newly started threads and other live-snapshot fallback views.

**Data flow**: Takes `thread_id`, `session_id`, `config_snapshot`, and optional `path`, gets `now = OffsetDateTime::now_utc().unix_timestamp()`, and constructs `Thread` with IDs/stringified parent ID, empty preview, `ephemeral` from the snapshot, model provider/cwd/source/thread_source from the snapshot, current package version from `env!("CARGO_PKG_VERSION")`, `status: NotLoaded`, `git_info: None`, `name: None`, and empty `turns`.

**Call relations**: Used by thread start, fork, resume fallback, listener attach, and `build_thread_from_loaded_snapshot`.

*Call graph*: calls 1 internal fn (cwd); called by 5 (load_thread_from_resume_source_or_send_internal, thread_fork_inner, thread_start_task, try_attach_thread_listener, build_thread_from_loaded_snapshot); 5 external calls (new, new, env!, to_string, now_utc).


##### `paginate_background_terminals`  (lines 4361–4387)

```
fn paginate_background_terminals(
    terminals: &[ThreadBackgroundTerminal],
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<ThreadBackgroundTerminal>, Option<String>), JSONRPCEr
```

**Purpose**: Paginates background terminal records by numeric process ID cursor. It treats the cursor as the last seen process ID and returns the next cursor from the last item in the page.

**Data flow**: If `cursor` is present, parses it as `i32` and finds the first terminal whose parsed `process_id` is greater than the cursor; parse failures become `invalid_request`. It computes `effective_limit`, slices `terminals[start..end]`, sets `next_cursor` to the last page item’s `process_id` when more remain, and returns `(page_vec, next_cursor)`.

**Call relations**: Used only by `thread_background_terminals_list_inner`.

*Call graph*: called by 1 (thread_background_terminals_list_inner); 2 external calls (iter, len).


##### `build_thread_from_loaded_snapshot`  (lines 4389–4400)

```
fn build_thread_from_loaded_snapshot(
    thread_id: ThreadId,
    config_snapshot: &ThreadConfigSnapshot,
    loaded_thread: &CodexThread,
) -> Thread
```

**Purpose**: Convenience wrapper that builds an API `Thread` from a loaded thread’s current config snapshot, session ID, and rollout path. It avoids repeating those field extractions at call sites.

**Data flow**: Calls `build_thread_from_snapshot(thread_id, loaded_thread.session_configured().session_id.to_string(), config_snapshot, loaded_thread.rollout_path())` and returns the resulting `Thread`.

**Call relations**: Used by `load_live_thread_view` when constructing a fallback live thread view.

*Call graph*: calls 3 internal fn (build_thread_from_snapshot, rollout_path, session_configured); called by 1 (load_live_thread_view).


### `app-server/src/request_processors/thread_goal_processor.rs`

`domain_logic` · `request handling and resume sequencing`

This file defines `ThreadGoalRequestProcessor`, which bundles the dependencies needed for goal operations: `ThreadManager`, `OutgoingMessageSender`, `Config`, `ThreadStateManager`, optional shared `StateDbHandle`, and `GoalService`. The public RPC entrypoints are thin wrappers around inner methods that either send their own response (`thread_goal_set`, `thread_goal_clear`) or return a payload (`thread_goal_get`). All three first enforce `Feature::Goals`; disabled goals are always an invalid request.

The core challenge in this file is locating a usable state DB for a thread. `state_db_for_materialized_thread` accepts loaded persistent threads with their own state DB, falls back to the processor’s shared state DB for loaded threads without one, and for unloaded threads verifies materialization by calling `codex_rollout::find_thread_path_by_id_str`. Ephemeral threads are explicitly rejected because goals require persisted rollout/state. Before mutating goals, `reconcile_thread_goal_rollout` ensures the rollout is synchronized by locating the rollout path and calling `reconcile_rollout`.

Notification ordering is another key design point. When a thread listener command channel exists, goal snapshot/update/clear events are enqueued as `ThreadListenerCommand`s so they are emitted in the same ordered stream as resume responses and other thread events. If the channel is absent or closed, the processor falls back to direct server notifications through `outgoing`. The file also includes conversion helpers from `codex_state::ThreadGoal` and `GoalServiceError` into API types and JSON-RPC errors.

#### Function details

##### `ThreadGoalRequestProcessor::new`  (lines 19–35)

```
fn new(
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        config: Arc<Config>,
        thread_state_manager: ThreadStateManager,
        state_db: Optio
```

**Purpose**: Constructs the goal processor with all dependencies needed for goal reads, writes, rollout reconciliation, and notification emission. The processor is cloneable because all heavy dependencies are shared handles.

**Data flow**: Takes `Arc<ThreadManager>`, `Arc<OutgoingMessageSender>`, `Arc<Config>`, `ThreadStateManager`, optional `StateDbHandle`, and `Arc<GoalService>`, stores them directly in the struct, and returns `Self`.

**Call relations**: Called during request-processor assembly; all later goal RPCs and resume hooks use the shared dependencies captured here.

*Call graph*: called by 1 (new).


##### `ThreadGoalRequestProcessor::thread_goal_set`  (lines 37–45)

```
async fn thread_goal_set(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for setting or updating a thread goal. It delegates to the inner implementation and converts its unit success into the request-processor convention of `Ok(None)`.

**Data flow**: Consumes `request_id` and `ThreadGoalSetParams`, awaits `thread_goal_set_inner(request_id, params)`, and maps `Ok(())` to `Ok(None)` while propagating any `JSONRPCErrorError`.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/goal/set`; all substantive work happens in `thread_goal_set_inner`.

*Call graph*: calls 1 internal fn (thread_goal_set_inner); called by 1 (handle_initialized_client_request).


##### `ThreadGoalRequestProcessor::thread_goal_get`  (lines 47–54)

```
async fn thread_goal_get(
        &self,
        params: ThreadGoalGetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for reading the current goal for a thread. It converts the typed response into `ClientResponsePayload` when present.

**Data flow**: Takes `ThreadGoalGetParams`, awaits `thread_goal_get_inner(params)`, and maps the resulting `ThreadGoalGetResponse` into `Some(response.into())`.

**Call relations**: Called by the initialized-client request dispatcher for `thread/goal/get`; it is a thin adapter over `thread_goal_get_inner`.

*Call graph*: calls 1 internal fn (thread_goal_get_inner); called by 1 (handle_initialized_client_request).


##### `ThreadGoalRequestProcessor::thread_goal_clear`  (lines 56–64)

```
async fn thread_goal_clear(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalClearParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public RPC wrapper for clearing a thread goal. Like `thread_goal_set`, it sends its own response in the inner method and returns `Ok(None)` on success.

**Data flow**: Consumes `request_id` and `ThreadGoalClearParams`, awaits `thread_goal_clear_inner(request_id, params)`, and maps unit success to `None` while propagating errors.

**Call relations**: Invoked by the initialized-client request dispatcher for `thread/goal/clear`; the actual clear logic lives in `thread_goal_clear_inner`.

*Call graph*: calls 1 internal fn (thread_goal_clear_inner); called by 1 (handle_initialized_client_request).


##### `ThreadGoalRequestProcessor::emit_resume_goal_snapshot_and_continue`  (lines 66–78)

```
async fn emit_resume_goal_snapshot_and_continue(
        &self,
        thread_id: ThreadId,
        thread: &CodexThread,
    )
```

**Purpose**: Emits a goal snapshot after a cold resume response and only then allows idle-thread lifecycle hooks to run. This preserves app-server-controlled ordering between resume output and extension reactions.

**Data flow**: Reads `self.config.features.enabled(Feature::Goals)`; if false, returns immediately. Otherwise it awaits `emit_thread_goal_snapshot(thread_id)` and then `thread.emit_thread_idle_lifecycle_if_idle().await`.

**Call relations**: Called from `thread_resume_inner` after a resumed thread response has been sent. It delegates snapshot emission to `emit_thread_goal_snapshot` and then resumes extension-visible idle lifecycle processing.

*Call graph*: calls 2 internal fn (emit_thread_goal_snapshot, emit_thread_idle_lifecycle_if_idle); called by 1 (thread_resume_inner).


##### `ThreadGoalRequestProcessor::pending_resume_goal_state`  (lines 80–95)

```
async fn pending_resume_goal_state(
        &self,
        thread: &CodexThread,
    ) -> (bool, Option<StateDbHandle>)
```

**Purpose**: Computes whether a running-thread resume should include goal snapshot emission and which state DB should be used. It prefers a thread-local state DB when available.

**Data flow**: Reads the goals feature flag from `self.config`. If goals are enabled, it checks `thread.state_db()` and falls back to `self.state_db.clone()` when the thread lacks its own DB; otherwise it returns `None` for the DB. Returns a tuple `(emit_thread_goal_update, thread_goal_state_db)`.

**Call relations**: Used by `resume_running_thread` to package goal-snapshot state into a pending listener command for running-thread resume handling.

*Call graph*: calls 1 internal fn (state_db); called by 1 (resume_running_thread).


##### `ThreadGoalRequestProcessor::thread_goal_set_inner`  (lines 97–148)

```
async fn thread_goal_set_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalSetParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates feature availability and thread materialization, updates the goal through `GoalService`, sends the RPC response, emits an ordered goal-updated notification, and applies any runtime side effects. It is the main write path for thread goals.

**Data flow**: Checks `Feature::Goals`, parses `params.thread_id` with `parse_thread_id_for_request`, resolves a `StateDbHandle` via `state_db_for_materialized_thread`, and calls `reconcile_thread_goal_rollout`. It then reads the thread’s `listener_command_tx` from `thread_state_manager`, converts optional status/objective/token budget into `GoalSetRequest` fields (`Keep` vs `Set`), and awaits `goal_service.set_thread_goal(&state_db, request)`, mapping failures with `goal_service_error`. The returned goal is converted to API `ThreadGoal`, sent back in `ThreadGoalSetResponse` through `outgoing.send_response`, then passed to `emit_thread_goal_updated_ordered`; finally `outcome.apply_runtime_effects(&self.goal_service).await` is invoked and `Ok(())` returned.

**Call relations**: Called only by `thread_goal_set`. It depends on parsing/state-db helpers, rollout reconciliation, and ordered notification emission so that listeners and direct notifications stay consistent.

*Call graph*: calls 6 internal fn (from, emit_thread_goal_updated_ordered, reconcile_thread_goal_rollout, state_db_for_materialized_thread, parse_thread_id_for_request, thread_state); called by 1 (thread_goal_set); 2 external calls (clone, Set).


##### `ThreadGoalRequestProcessor::thread_goal_get_inner`  (lines 150–167)

```
async fn thread_goal_get_inner(
        &self,
        params: ThreadGoalGetParams,
    ) -> Result<ThreadGoalGetResponse, JSONRPCErrorError>
```

**Purpose**: Reads the current goal for a materialized thread from persistent state. It rejects disabled goals and unsupported ephemeral threads before querying `GoalService`.

**Data flow**: Checks the goals feature flag, parses `params.thread_id`, resolves the state DB with `state_db_for_materialized_thread`, then awaits `goal_service.get_thread_goal(&state_db, thread_id)`. It maps `GoalServiceError` with `goal_service_error`, converts any returned state goal with `ThreadGoal::from`, and returns `ThreadGoalGetResponse { goal }`.

**Call relations**: Called by `thread_goal_get`; it is the read-only counterpart to the set/clear inner methods and shares the same thread-ID and state-DB resolution path.

*Call graph*: calls 2 internal fn (state_db_for_materialized_thread, parse_thread_id_for_request); called by 1 (thread_goal_get).


##### `ThreadGoalRequestProcessor::thread_goal_clear_inner`  (lines 169–202)

```
async fn thread_goal_clear_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalClearParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Clears a thread goal, sends the clear response, and emits an ordered cleared notification only when something was actually removed. It mirrors the set path but with a boolean clear result.

**Data flow**: Checks `Feature::Goals`, parses the thread ID, resolves the state DB, and calls `reconcile_thread_goal_rollout`. It captures `listener_command_tx` from thread state, awaits `goal_service.clear_thread_goal(&state_db, thread_id)`, maps errors with `goal_service_error`, sends `ThreadGoalClearResponse { cleared }` through `outgoing`, and if `cleared` is true calls `emit_thread_goal_cleared_ordered(thread_id, listener_command_tx).await` before returning `Ok(())`.

**Call relations**: Called only by `thread_goal_clear`. It shares most of its setup path with `thread_goal_set_inner` and uses the ordered-clear helper for notification sequencing.

*Call graph*: calls 5 internal fn (emit_thread_goal_cleared_ordered, reconcile_thread_goal_rollout, state_db_for_materialized_thread, parse_thread_id_for_request, thread_state); called by 1 (thread_goal_clear).


##### `ThreadGoalRequestProcessor::state_db_for_materialized_thread`  (lines 204–233)

```
async fn state_db_for_materialized_thread(
        &self,
        thread_id: ThreadId,
    ) -> Result<StateDbHandle, JSONRPCErrorError>
```

**Purpose**: Finds the correct `StateDbHandle` for a thread that supports goals, rejecting ephemeral or nonexistent threads. It handles both loaded and unloaded threads and verifies materialization for unloaded ones.

**Data flow**: Given `thread_id`, it first tries `thread_manager.get_thread(thread_id).await`. For a loaded thread, if `rollout_path().is_none()` it returns `invalid_request("ephemeral thread does not support goals: ...")`; if `thread.state_db()` exists it returns that handle. If the thread is not loaded, it calls `codex_rollout::find_thread_path_by_id_str(&self.config.codex_home, &thread_id.to_string(), self.state_db.as_deref()).await`, mapping lookup failures to `internal_error` and absence to `invalid_request("thread not found: ...")`. After those checks, it returns `self.state_db.clone()` or an internal error if no shared SQLite state DB is available.

**Call relations**: Used by `thread_goal_set_inner`, `thread_goal_get_inner`, `thread_goal_clear_inner`, and `emit_thread_goal_snapshot` whenever goal state must be read or written.

*Call graph*: called by 4 (emit_thread_goal_snapshot, thread_goal_clear_inner, thread_goal_get_inner, thread_goal_set_inner); 3 external calls (find_thread_path_by_id_str, format!, to_string).


##### `ThreadGoalRequestProcessor::reconcile_thread_goal_rollout`  (lines 235–269)

```
async fn reconcile_thread_goal_rollout(
        &self,
        thread_id: ThreadId,
        state_db: &StateDbHandle,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Ensures the rollout on disk is reconciled before goal mutations proceed. This keeps goal operations aligned with the latest materialized thread state.

**Data flow**: Looks up an optional running thread with `thread_manager.get_thread(thread_id).await.ok()`. If loaded, it requires `thread.rollout_path()` and rejects ephemeral threads; if unloaded, it resolves the rollout path with `codex_rollout::find_thread_path_by_id_str`, mapping failures similarly to `state_db_for_materialized_thread`. It then calls `reconcile_rollout(Some(state_db), rollout_path.as_path(), self.config.model_provider_id.as_str(), None, &[], None, None).await` and returns `Ok(())`.

**Call relations**: Called before goal writes in `thread_goal_set_inner` and `thread_goal_clear_inner` so persisted rollout/state are synchronized before mutation.

*Call graph*: called by 2 (thread_goal_clear_inner, thread_goal_set_inner); 2 external calls (find_thread_path_by_id_str, to_string).


##### `ThreadGoalRequestProcessor::emit_thread_goal_snapshot`  (lines 271–299)

```
async fn emit_thread_goal_snapshot(&self, thread_id: ThreadId)
```

**Purpose**: Emits the current goal state for a thread, preferring ordered delivery through the thread listener command channel and falling back to direct notification if necessary. It is used during resume sequencing.

**Data flow**: Resolves `state_db` with `state_db_for_materialized_thread(thread_id).await`; on failure it logs a warning with `err.message` and returns. It then reads `listener_command_tx` from `thread_state_manager.thread_state(thread_id)`. If a sender exists, it constructs `ThreadListenerCommand::EmitThreadGoalSnapshot { state_db: state_db.clone() }` and returns early when `send` succeeds; otherwise it warns about a closed channel. If no usable sender exists, it calls `send_thread_goal_snapshot_notification(&self.outgoing, thread_id, &state_db).await`.

**Call relations**: Called by `emit_resume_goal_snapshot_and_continue`. It coordinates with the listener-task machinery in `thread_lifecycle.rs` to preserve ordering when possible.

*Call graph*: calls 2 internal fn (state_db_for_materialized_thread, thread_state); called by 1 (emit_resume_goal_snapshot_and_continue); 1 external calls (warn!).


##### `ThreadGoalRequestProcessor::emit_thread_goal_updated_ordered`  (lines 301–328)

```
async fn emit_thread_goal_updated_ordered(
        &self,
        thread_id: ThreadId,
        goal: ThreadGoal,
        listener_command_tx: Option<tokio::sync::mpsc::UnboundedSender<ThreadListenerCo
```

**Purpose**: Emits a goal-updated event in listener order when possible, otherwise directly to all clients. It preserves the goal payload and thread ID in either path.

**Data flow**: Takes `thread_id`, API `goal`, and optional `listener_command_tx`. If a sender exists, it builds `ThreadListenerCommand::EmitThreadGoalUpdated { turn_id: None, goal: goal.clone() }` and returns early if `send` succeeds; otherwise it logs a warning. Fallback sends `ServerNotification::ThreadGoalUpdated(ThreadGoalUpdatedNotification { thread_id: thread_id.to_string(), turn_id: None, goal })` through `outgoing`.

**Call relations**: Called by `thread_goal_set_inner` after the response is sent. It mirrors the listener-command handling implemented in `handle_thread_listener_command`.

*Call graph*: called by 1 (thread_goal_set_inner); 4 external calls (ThreadGoalUpdated, clone, to_string, warn!).


##### `ThreadGoalRequestProcessor::emit_thread_goal_cleared_ordered`  (lines 330–351)

```
async fn emit_thread_goal_cleared_ordered(
        &self,
        thread_id: ThreadId,
        listener_command_tx: Option<tokio::sync::mpsc::UnboundedSender<ThreadListenerCommand>>,
    )
```

**Purpose**: Emits a goal-cleared event in listener order when possible, otherwise directly through the outgoing notification channel. It is the clear-path counterpart to `emit_thread_goal_updated_ordered`.

**Data flow**: Accepts `thread_id` and optional `listener_command_tx`. If a sender exists, it sends `ThreadListenerCommand::EmitThreadGoalCleared` and returns on success; if sending fails it logs a warning. Fallback sends `ServerNotification::ThreadGoalCleared(ThreadGoalClearedNotification { thread_id: thread_id.to_string() })` through `outgoing`.

**Call relations**: Called by `thread_goal_clear_inner` only when `GoalService` reports that a goal was actually cleared.

*Call graph*: called by 1 (thread_goal_clear_inner); 3 external calls (ThreadGoalCleared, to_string, warn!).


##### `api_thread_goal_from_state`  (lines 354–365)

```
fn api_thread_goal_from_state(goal: codex_state::ThreadGoal) -> ThreadGoal
```

**Purpose**: Converts a persisted `codex_state::ThreadGoal` into the API-facing `ThreadGoal` struct. It preserves timestamps as Unix seconds and maps the status enum through a dedicated helper.

**Data flow**: Consumes `goal: codex_state::ThreadGoal`, copies scalar/string fields, converts `goal.thread_id` to string, maps `goal.status` with `api_thread_goal_status_from_state`, converts `created_at` and `updated_at` to timestamps, and returns the assembled API `ThreadGoal`.

**Call relations**: Used by resume/lifecycle code when reading goal snapshots directly from state DB, keeping API conversion logic centralized in this file.

*Call graph*: calls 1 internal fn (api_thread_goal_status_from_state).


##### `api_thread_goal_status_from_state`  (lines 367–376)

```
fn api_thread_goal_status_from_state(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus
```

**Purpose**: Maps each persisted goal-status variant to its protocol/API counterpart. The mapping is one-to-one and exhaustive.

**Data flow**: Matches `codex_state::ThreadGoalStatus` and returns the corresponding `ThreadGoalStatus` variant: `Active`, `Paused`, `Blocked`, `UsageLimited`, `BudgetLimited`, or `Complete`.

**Call relations**: Called only by `api_thread_goal_from_state` as the enum-conversion step.

*Call graph*: called by 1 (api_thread_goal_from_state).


##### `goal_service_error`  (lines 378–383)

```
fn goal_service_error(err: GoalServiceError) -> JSONRPCErrorError
```

**Purpose**: Converts `GoalServiceError` into JSON-RPC errors without adding extra context. It preserves the service’s own classification between invalid requests and internal failures.

**Data flow**: Matches `GoalServiceError`: `InvalidRequest(message)` becomes `invalid_request(message)`, and `Internal(message)` becomes `internal_error(message)`.

**Call relations**: Used by all goal-service calls in this file so set/get/clear share the same error policy.


##### `parse_thread_id_for_request`  (lines 385–388)

```
fn parse_thread_id_for_request(thread_id: &str) -> Result<ThreadId, JSONRPCErrorError>
```

**Purpose**: Parses a thread ID string for goal RPCs and rewrites parse failures into invalid-request JSON-RPC errors. It keeps thread-ID validation messages consistent across goal operations.

**Data flow**: Calls `ThreadId::from_string(thread_id)` and maps any parse error to `invalid_request(format!("invalid thread id: {err}"))`. Returns the parsed `ThreadId` on success.

**Call relations**: Shared by `thread_goal_set_inner`, `thread_goal_get_inner`, and `thread_goal_clear_inner` as their first validation step.

*Call graph*: calls 1 internal fn (from_string); called by 3 (thread_goal_clear_inner, thread_goal_get_inner, thread_goal_set_inner).


### `app-server/src/request_processors/thread_delete.rs`

`domain_logic` · `request handling`

This file extends `ThreadRequestProcessor` with deletion logic for a thread and any spawned descendants. The public `thread_delete` method acquires the shared thread-list state permit before doing any destructive work, then calls `thread_delete_response` while collecting deleted thread IDs into a mutable vector. On success it sends the JSON-RPC response first and only then emits `ThreadDeleted` notifications for each removed thread.

`thread_delete_response` performs the real work. It parses the incoming thread ID, gathers descendant IDs from the app-server state DB, then merges in any additional live subtree IDs reported by `thread_manager.list_agent_subtree_thread_ids`, deduplicating with a `HashSet`. Before deletion it calls `validate_root_thread_delete`, which blocks deletion of loaded ephemeral threads and otherwise accepts roots that exist in the thread store, have descendants, or still exist only in state DB. Every thread slated for deletion is first passed through `prepare_thread_for_delete`, which removes loaded runtime state and flushes `log_db` if present.

Deletion order is descendants-first, root-last: descendants are taken from `thread_ids.iter().skip(1).rev()`, then the root is appended. Store deletion tolerates `ThreadNotFound` by logging a warning, but any other `ThreadStoreError` is mapped through `thread_store_delete_error`. After store cleanup, `state_db.delete_threads_strict` removes app-server metadata for the whole subtree. The final notification list is built from the actual delete order, converted to strings.

#### Function details

##### `ThreadRequestProcessor::thread_delete`  (lines 8–30)

```
async fn thread_delete(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadDeleteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Coordinates the full delete request lifecycle: serialization against thread-list mutations, response emission, and follow-up notifications. It returns `Ok(None)` because the JSON-RPC response is sent directly through `outgoing` on success.

**Data flow**: Takes `request_id` and `ThreadDeleteParams`, creates `deleted_thread_ids: Vec<String>`, acquires the thread-list state permit, and awaits `thread_delete_response(params, &mut deleted_thread_ids)`. On success it sends the `ThreadDeleteResponse` via `self.outgoing.send_response(request_id.clone(), response).await`, then calls `send_thread_deleted_notifications(deleted_thread_ids).await`; on failure it returns the `JSONRPCErrorError` unchanged.

**Call relations**: Invoked by the main initialized-client request dispatcher for `thread/delete`. It delegates all deletion semantics to `thread_delete_response` and only handles outer orchestration and notification timing.

*Call graph*: calls 2 internal fn (send_thread_deleted_notifications, thread_delete_response); 2 external calls (new, clone).


##### `ThreadRequestProcessor::thread_delete_response`  (lines 32–104)

```
async fn thread_delete_response(
        &self,
        params: ThreadDeleteParams,
        deleted_thread_ids: &mut Vec<String>,
    ) -> Result<ThreadDeleteResponse, JSONRPCErrorError>
```

**Purpose**: Computes the deletion set for a thread subtree, tears down any loaded runtime state, deletes persisted records in safe order, and records which thread IDs were removed. It is the core implementation behind `thread/delete`.

**Data flow**: Parses `params.thread_id` into `ThreadId`, loads descendant IDs from `state_db_spawn_subtree_thread_ids`, deduplicates them with a `HashSet`, and augments them with live subtree IDs from `thread_manager.list_agent_subtree_thread_ids`. It validates the root via `validate_root_thread_delete(thread_id, thread_ids.len() > 1)`, calls `prepare_thread_for_delete` for each candidate ID, builds `delete_order` as descendants reversed plus root, and iterates that order calling `thread_store.delete_thread(...)`. `ThreadNotFound` is logged and ignored; other store errors are converted by `thread_store_delete_error`. If `state_db` exists, it calls `delete_threads_strict(thread_ids.as_slice())` and maps failures to `internal_error`. Finally it extends `deleted_thread_ids` with stringified IDs from `delete_order` and returns `ThreadDeleteResponse {}`.

**Call relations**: Called only by `thread_delete`. It depends on `state_db_spawn_subtree_thread_ids` from the main thread processor, `validate_root_thread_delete` for admissibility checks, `prepare_thread_for_delete` for runtime teardown, and `thread_store_delete_error` / `core_thread_write_error` for error translation.

*Call graph*: calls 5 internal fn (prepare_thread_for_delete, validate_root_thread_delete, thread_store_delete_error, core_thread_write_error, from_string); called by 1 (thread_delete); 1 external calls (warn!).


##### `ThreadRequestProcessor::send_thread_deleted_notifications`  (lines 106–114)

```
async fn send_thread_deleted_notifications(&self, deleted_thread_ids: Vec<String>)
```

**Purpose**: Emits one `ServerNotification::ThreadDeleted` per deleted thread ID after the delete response has already been sent. Notification order follows the collected deletion order.

**Data flow**: Consumes `deleted_thread_ids: Vec<String>`, iterates it, wraps each string in `ThreadDeletedNotification { thread_id }`, then sends `ServerNotification::ThreadDeleted(...)` through `self.outgoing` asynchronously.

**Call relations**: Called only by `thread_delete` after `thread_delete_response` succeeds, separating side-effect notifications from the core deletion transaction.

*Call graph*: called by 1 (thread_delete); 1 external calls (ThreadDeleted).


##### `ThreadRequestProcessor::validate_root_thread_delete`  (lines 116–167)

```
async fn validate_root_thread_delete(
        &self,
        thread_id: ThreadId,
        has_descendants: bool,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Determines whether the requested root thread may be deleted, with special handling for loaded ephemeral threads, missing roots that still have descendants, and state-db-only remnants. It prevents accidental deletion requests against unsupported or nonexistent roots.

**Data flow**: Reads `thread_id` and `has_descendants`. If `thread_manager.get_thread(thread_id).await` succeeds, it checks `thread.config_snapshot().await.ephemeral`: non-ephemeral loaded threads are allowed, but ephemeral ones return `invalid_request("thread is not persisted and cannot be deleted: ...")`. If the thread is not loaded, it tries `thread_store.read_thread(... include_archived: true, include_history: false)`: success allows deletion; `ThreadNotFound` allows deletion when descendants exist, otherwise it consults `state_db.get_thread(thread_id)` if available and allows deletion only when app-server state still exists. Any store miss without descendants/state-db presence becomes `thread_store_delete_error(ThreadStoreError::ThreadNotFound { thread_id })`; state-db read failures become `internal_error`.

**Call relations**: Used by `thread_delete_response` before any destructive work. It delegates final store-error shaping to `thread_store_delete_error` so delete-specific not-found messaging stays consistent.

*Call graph*: calls 1 internal fn (thread_store_delete_error); called by 1 (thread_delete_response); 1 external calls (format!).


##### `ThreadRequestProcessor::prepare_thread_for_delete`  (lines 169–174)

```
async fn prepare_thread_for_delete(&self, thread_id: ThreadId)
```

**Purpose**: Performs runtime cleanup for a thread before persisted deletion. It reuses the generic removal path and flushes logs so on-disk state is settled before records disappear.

**Data flow**: Takes `thread_id`, awaits `self.prepare_thread_for_removal(thread_id, "delete")`, then if `self.log_db` is present calls `log_db.flush().await`. It returns no value.

**Call relations**: Called by `thread_delete_response` for every thread in the subtree before store deletion begins, ensuring loaded threads and buffered logs are cleaned up first.

*Call graph*: called by 1 (thread_delete_response).


##### `thread_store_delete_error`  (lines 177–188)

```
fn thread_store_delete_error(err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps `ThreadStoreError` values from delete operations into JSON-RPC errors with delete-specific wording. It preserves invalid-request and unsupported-operation semantics while contextualizing unexpected failures.

**Data flow**: Matches `err: ThreadStoreError`: `ThreadNotFound { thread_id }` becomes `invalid_request("thread not found: ...")`; `InvalidRequest { message }` becomes `invalid_request(message)`; `Unsupported { operation }` delegates to `unsupported_thread_store_operation(operation)`; all other variants become `internal_error(format!("failed to delete thread: {err}"))`.

**Call relations**: Used by both `thread_delete_response` and `validate_root_thread_delete` whenever thread-store failures need to be surfaced through the delete API.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); called by 2 (thread_delete_response, validate_root_thread_delete); 1 external calls (format!).


### `app-server/src/dynamic_tools.rs`

`domain_logic` · `dynamic tool response handling`

This file handles the asynchronous completion path for dynamic tool requests that were sent to the client. The main entrypoint, `on_call_response`, waits on a `oneshot::Receiver<ClientRequestResult>` representing the client’s reply. It distinguishes four outcomes: a successful client result containing JSON, a client-side error that specifically indicates a turn transition (which is silently ignored), any other client error, and channel closure. Non-turn-transition failures are logged and converted into a fallback unsuccessful response.

Successful JSON payloads are decoded into the app-server protocol `DynamicToolCallResponse`; decode failures are also logged and replaced with a fallback response containing a single `InputText` content item and `success: false`. The function then converts the protocol response into the core protocol shape by mapping each `DynamicToolCallOutputContentItem` into the corresponding core type and wrapping it in `CoreDynamicToolResponse`.

Finally, it submits `Op::DynamicToolResponse { id, response }` to the `CodexThread`. Submission failure is logged but not retried. One notable detail is that `fallback_response` returns both the synthetic response and an optional message string, but `on_call_response` currently ignores that second value after destructuring; the tuple shape leaves room for future richer error propagation.

#### Function details

##### `on_call_response`  (lines 14–53)

```
async fn on_call_response(
    call_id: String,
    receiver: oneshot::Receiver<ClientRequestResult>,
    conversation: Arc<CodexThread>,
)
```

**Purpose**: Waits for a client-side dynamic tool call result, converts it into the core protocol response shape, and submits it back to the conversation thread. It suppresses responses for turn-transition errors but logs and falls back for all other failures.

**Data flow**: Inputs are a `call_id`, a `oneshot::Receiver<ClientRequestResult>`, and an `Arc<CodexThread>`. It awaits the receiver, pattern-matches the nested result, uses `decode_response` for successful JSON payloads, returns early on `is_turn_transition_server_request_error`, or uses `fallback_response` on other errors. It clones the decoded `DynamicToolCallResponse`, maps `content_items` into core content items, builds `CoreDynamicToolResponse`, and asynchronously submits `Op::DynamicToolResponse { id: call_id.clone(), response }` to the conversation. It writes only logs on failure.

**Call relations**: Called by `apply_bespoke_event_handling` when a dynamic tool request has been sent to the client and the server later receives or times out waiting for the client’s reply. It delegates JSON decoding to `decode_response` and fallback construction to `fallback_response`.

*Call graph*: calls 3 internal fn (decode_response, fallback_response, is_turn_transition_server_request_error); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `decode_response`  (lines 55–63)

```
fn decode_response(value: serde_json::Value) -> (DynamicToolCallResponse, Option<String>)
```

**Purpose**: Attempts to deserialize a raw JSON client payload into `DynamicToolCallResponse`, falling back to a synthetic failure response if decoding fails. It centralizes the protocol boundary for dynamic tool replies.

**Data flow**: Consumes a `serde_json::Value`, runs `serde_json::from_value::<DynamicToolCallResponse>`, and returns `(response, None)` on success. On error it logs the deserialization failure and returns the tuple from `fallback_response("dynamic tool response was invalid")`.

**Call relations**: Used only by `on_call_response` on the successful client-result branch before conversion into the core protocol type.

*Call graph*: calls 1 internal fn (fallback_response); called by 1 (on_call_response); 1 external calls (error!).


##### `fallback_response`  (lines 65–75)

```
fn fallback_response(message: &str) -> (DynamicToolCallResponse, Option<String>)
```

**Purpose**: Builds a minimal unsuccessful dynamic tool response containing a single text message. It is used whenever the client request fails or returns invalid JSON.

**Data flow**: Takes a message `&str`, constructs `DynamicToolCallResponse { content_items: vec![DynamicToolCallOutputContentItem::InputText { text }], success: false }`, and returns it paired with `Some(message.to_string())`.

**Call relations**: Called by both `on_call_response` and `decode_response` to produce a consistent failure payload for downstream submission.

*Call graph*: called by 2 (decode_response, on_call_response); 1 external calls (vec!).


### `app-server/src/server_request_error.rs`

`domain_logic` · `request-response error handling`

This module is intentionally tiny but semantically important: it codifies that a `codex_app_server_protocol::JSONRPCErrorError` should be treated as a benign "request resolved because the turn changed" condition when its optional `data` payload contains a JSON field `reason` with the exact string value `"turnTransition"`. The constant `TURN_TRANSITION_PENDING_REQUEST_ERROR_REASON` is the single source of truth for that marker, avoiding duplicated string literals across request-response handlers.

The detector function walks the nested optional/JSON structure defensively: it reads `error.data`, looks up `reason`, converts it to a string with `serde_json::Value::as_str`, and compares the result to the constant. Missing `data`, missing `reason`, or non-string values all naturally evaluate to `false` rather than panicking. That makes it safe to use on arbitrary server errors returned by clients.

The tests demonstrate the intended protocol contract with concrete `JSONRPCErrorError` values: one matching the turn-transition reason and one unrelated error. The design choice here is that only the structured `data.reason` field matters; the numeric code and human-readable message are ignored, so callers can reliably distinguish this control-flow case from real failures.

#### Function details

##### `is_turn_transition_server_request_error`  (lines 5–12)

```
fn is_turn_transition_server_request_error(error: &JSONRPCErrorError) -> bool
```

**Purpose**: Checks whether a `JSONRPCErrorError` carries the app-server’s structured `reason: "turnTransition"` marker. It is the canonical predicate used to downgrade that specific error into expected control flow.

**Data flow**: Takes `&JSONRPCErrorError`; reads its `data: Option<serde_json::Value>` field, then traverses `data["reason"]` and converts it to `Option<&str>`. It returns `true` only when that extracted string exactly matches `TURN_TRANSITION_PENDING_REQUEST_ERROR_REASON`; it does not mutate any state or emit output.

**Call relations**: It is invoked by several client-response handlers when a JSON-RPC call fails, so those paths can distinguish a stale request caused by a turn change from a genuine error. It delegates only to standard `Option` chaining and `serde_json::Value::as_str`, keeping the interpretation logic local and reusable.

*Call graph*: called by 6 (mcp_server_elicitation_response_from_client_result, on_command_execution_request_approval_response, on_file_change_request_approval_response, on_request_user_input_response, request_permissions_response_from_client_result, on_call_response).


##### `tests::turn_transition_error_is_detected`  (lines 22–30)

```
fn turn_transition_error_is_detected()
```

**Purpose**: Verifies that the detector returns `true` for an error whose `data.reason` is exactly `"turnTransition"`. The test anchors the protocol contract with a concrete sample payload.

**Data flow**: Constructs a `JSONRPCErrorError` with code `-1`, a descriptive message, and `data: Some(json!({ "reason": "turnTransition" }))`; passes a reference to the detector; asserts that the returned boolean is `true`. It writes no persistent state.

**Call relations**: This test directly exercises the module’s main predicate in the positive case. It does not participate in runtime flow; it exists to prevent regressions in the exact JSON shape the production handlers rely on.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::unrelated_error_is_not_detected`  (lines 33–41)

```
fn unrelated_error_is_not_detected()
```

**Purpose**: Verifies that the detector rejects errors whose structured reason is anything other than the turn-transition marker. It confirms the predicate is specific rather than broadly matching all request failures.

**Data flow**: Builds a `JSONRPCErrorError` with `data: Some(json!({ "reason": "other" }))`, calls the detector, and asserts the result is `false`. No shared state is read or modified beyond the local test values.

**Call relations**: This is the negative counterpart to the positive test and documents the intended strictness of the comparison. It ensures callers only suppress the one protocol-defined transition case.

*Call graph*: 2 external calls (assert_eq!, json!).


### `app-server/src/models.rs`

`domain_logic` · `request handling`

This file is intentionally small and data-centric. Its public entrypoint, `supported_models`, asks `ThreadManager` for model presets using `RefreshStrategy::OnlineIfUncached`, so callers get fresh data when the cache is cold without forcing a refresh every time. It then applies one policy decision locally: hidden presets are excluded unless the caller explicitly requests them via `include_hidden`.

The rest of the file is pure shape conversion. `model_from_preset` consumes a `codex_protocol::openai_models::ModelPreset` and constructs the protocol-facing `codex_app_server_protocol::Model`, copying identifiers, display strings, modality/personality/service-tier support, default flags, and optional upgrade metadata. Upgrade information is duplicated into both the legacy `upgrade` field and the richer `upgrade_info` structure. Hiddenness is inverted from `show_in_picker`, and reasoning effort presets are delegated to a helper that converts each preset into a `ReasoningEffortOption` with the same effort enum and description.

There is no caching or mutation here; the file’s main invariant is faithful field-by-field translation from core model metadata into API payloads, preserving ordering from the underlying preset list.

#### Function details

##### `supported_models`  (lines 12–23)

```
async fn supported_models(
    thread_manager: Arc<ThreadManager>,
    include_hidden: bool,
) -> Vec<Model>
```

**Purpose**: Fetches the current model preset list from `ThreadManager`, filters hidden entries according to the caller’s flag, and converts each remaining preset into an API `Model`.

**Data flow**: Takes `Arc<ThreadManager>` and `include_hidden`; awaits `thread_manager.list_models(RefreshStrategy::OnlineIfUncached)`, filters out presets where `show_in_picker` is false unless `include_hidden` is true, maps each preset through `model_from_preset`, and returns the collected `Vec<Model>`.

**Call relations**: This function is consumed by higher-level request processors when serving model-list API requests; it is the public bridge from core model discovery into app-server protocol data.


##### `model_from_preset`  (lines 25–59)

```
fn model_from_preset(preset: ModelPreset) -> Model
```

**Purpose**: Performs the full field mapping from a core `ModelPreset` into the app-server protocol `Model`. It preserves optional upgrade metadata and nested service-tier information.

**Data flow**: Consumes a `ModelPreset`, copies scalar/string fields into a new `Model`, derives `upgrade` and `upgrade_info` from `preset.upgrade`, converts `availability_nux`, flips `show_in_picker` into `hidden`, transforms reasoning efforts via `reasoning_efforts_from_preset`, maps each core service tier into `ModelServiceTier`, and returns the assembled `Model`.

**Call relations**: Used only by `supported_models` as the per-item conversion step.

*Call graph*: calls 1 internal fn (reasoning_efforts_from_preset).


##### `reasoning_efforts_from_preset`  (lines 61–71)

```
fn reasoning_efforts_from_preset(
    efforts: Vec<ReasoningEffortPreset>,
) -> Vec<ReasoningEffortOption>
```

**Purpose**: Converts core reasoning-effort presets into protocol-facing reasoning-effort options. It is a narrow helper for nested list translation.

**Data flow**: Consumes a `Vec<ReasoningEffortPreset>`, maps each item to `ReasoningEffortOption { reasoning_effort: preset.effort, description: preset.description }`, and returns the resulting vector.

**Call relations**: Called from `model_from_preset` when populating `supported_reasoning_efforts`.

*Call graph*: called by 1 (model_from_preset).


### `core/src/tools/router.rs`

`orchestration` · `per-turn setup and tool request handling`

This file centers on `ToolRouter`, a thin orchestration layer over `ToolRegistry` that packages tool discovery and invocation into a turn-scoped object. The router stores two pieces of state: the registry used for actual dispatch, and a cloned list of `ToolSpec` values that are safe to expose back to the model. Construction happens either through `from_turn_context`, which delegates all assembly logic to `build_tool_router`, or `from_parts`, which is used when tests or higher-level builders already have a prepared registry and spec list.

The file also defines the concrete `ToolCall` payload passed through dispatch: a `ToolName`, a `call_id`, and a `ToolPayload` enum describing whether the invocation came from a function call, tool search, or custom tool. `build_tool_call` is the normalization point from protocol-layer `ResponseItem` values into this internal representation. It preserves namespaces for `FunctionCall`, only accepts `ToolSearchCall` when `execution == "client"` and a `call_id` is present, parses search arguments via `serde_json` into `SearchToolCallParams`, and silently ignores unsupported response items by returning `Ok(None)`.

Dispatch methods are intentionally small: they wrap session, turn, cancellation token, diff tracker, source, and payload into a `ToolInvocation`, then hand off to `ToolRegistry::dispatch_any_with_terminal_outcome`. Optional terminal-outcome tracking is threaded through as an `Option<Arc<AtomicBool>>`, allowing callers to distinguish ordinary execution from flows that must stop after a terminal tool result. Small query helpers expose registry capabilities such as parallel-call support, runtime-cancellation behavior, and argument diff consumers, defaulting to `false` when a tool is unknown. Finally, `extension_tool_executors` walks session extension contributors and collects all contributed `ToolExecutor<ExtensionToolCall>` instances into a flat vector for router construction.

#### Function details

##### `ToolRouter::from_turn_context`  (lines 49–55)

```
fn from_turn_context(
        turn_context: &TurnContext,
        params: ToolRouterParams<'_>,
        tool_search_handler_cache: &ToolSearchHandlerCache,
    ) -> Self
```

**Purpose**: Builds a turn-scoped router from the current `TurnContext`, tool source parameters, and the shared tool-search handler cache. It is the normal constructor used when the system needs a fully assembled registry and model-visible tool list for a live turn.

**Data flow**: It reads the provided `TurnContext`, `ToolRouterParams`, and `ToolSearchHandlerCache`, passes them unchanged into `build_tool_router`, and returns the resulting `ToolRouter`. This function does not mutate local router state itself; all assembly decisions are delegated to the builder.

**Call relations**: Higher-level turn and test flows invoke this when they need a router derived from current session/turn conditions and available tool sources. Its only downstream work is calling `build_tool_router`, which performs the actual registry/spec composition.

*Call graph*: calls 1 internal fn (build_tool_router); called by 11 (fatal_tool_error_stops_turn_and_reports_error, test_tool_runtime, built_tools, handle_output_item_done_returns_contributed_last_agent_message, extension_tool_executors_are_model_visible_and_dispatchable, mcp_parallel_support_uses_handler_data, parallel_support_does_not_match_namespaced_local_tool_names, specs_filter_deferred_dynamic_tools, tools_without_handlers_do_not_support_parallel, probe_with (+1 more)).


##### `ToolRouter::from_parts`  (lines 57–62)

```
fn from_parts(registry: ToolRegistry, model_visible_specs: Vec<ToolSpec>) -> Self
```

**Purpose**: Constructs a router directly from an already prepared `ToolRegistry` and visible `ToolSpec` list. It exists as the minimal constructor for builder code and tests that want to bypass turn-based assembly.

**Data flow**: It takes ownership of `registry` and `model_visible_specs` and stores them into a new `ToolRouter` struct, returning that struct by value. No transformation occurs beyond field assignment.

**Call relations**: This is used by builder and test paths once registry construction has already happened elsewhere. It does not delegate further; it is the terminal step that materializes the router object.

*Call graph*: called by 3 (cancellation_after_handler_finishes_preserves_completed_lifecycle, cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle, build_tool_router).


##### `ToolRouter::model_visible_specs`  (lines 64–66)

```
fn model_visible_specs(&self) -> Vec<ToolSpec>
```

**Purpose**: Returns the set of tool specifications that should be shown to the model for this router. The method protects internal ownership by cloning the stored vector.

**Data flow**: It reads `self.model_visible_specs`, clones the `Vec<ToolSpec>`, and returns the clone. It does not modify router state.

**Call relations**: Prompt-building and adapter code call this when they need to serialize or inspect the tools exposed to the model. It is a leaf accessor with no downstream calls.

*Call graph*: called by 2 (build_prompt, from_router).


##### `ToolRouter::registered_tool_names_for_test`  (lines 69–71)

```
fn registered_tool_names_for_test(&self) -> Vec<ToolName>
```

**Purpose**: Exposes the registry's currently registered tool names for test assertions. It is compiled only in test builds.

**Data flow**: It reads `self.registry`, invokes `tool_names_for_test`, and returns the resulting `Vec<ToolName>`. No state is changed.

**Call relations**: Test helpers call this to verify router composition. Its only delegated work is to the registry's test-only name enumeration.

*Call graph*: calls 1 internal fn (tool_names_for_test); called by 1 (from_router).


##### `ToolRouter::tool_exposure_for_test`  (lines 74–79)

```
fn tool_exposure_for_test(
        &self,
        name: &ToolName,
    ) -> Option<crate::tools::registry::ToolExposure>
```

**Purpose**: Looks up how a named tool is exposed inside the registry so tests can assert visibility and registration behavior. It is also test-only.

**Data flow**: It takes a borrowed `ToolName`, queries `self.registry.tool_exposure(name)`, and returns the resulting optional exposure metadata. It performs no mutation.

**Call relations**: Used by tests that need more detail than just the registered names. It delegates directly to the registry lookup.

*Call graph*: calls 1 internal fn (tool_exposure).


##### `ToolRouter::create_diff_consumer`  (lines 81–86)

```
fn create_diff_consumer(
        &self,
        tool_name: &ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Creates a tool-specific argument diff consumer when the registry knows how to track incremental argument changes for that tool. This supports tooling that wants to observe or accumulate argument diffs across model output.

**Data flow**: It reads the requested `tool_name`, asks `self.registry.create_diff_consumer(tool_name)`, and returns an optional boxed `ToolArgumentDiffConsumer`. The router itself stores nothing new.

**Call relations**: Callers use this before or during tool-call assembly when they need per-tool diff handling. The method is a direct pass-through to registry-provided consumer creation.

*Call graph*: calls 1 internal fn (create_diff_consumer).


##### `ToolRouter::tool_supports_parallel`  (lines 88–92)

```
fn tool_supports_parallel(&self, call: &ToolCall) -> bool
```

**Purpose**: Reports whether the named tool may be executed in parallel with other tool calls. Unknown tools are treated conservatively as non-parallel.

**Data flow**: It reads `call.tool_name`, queries `self.registry.supports_parallel_tool_calls(&call.tool_name)`, unwraps the optional result with `false` as the default, and returns that boolean. No state is written.

**Call relations**: Scheduling or execution-planning code calls this to decide whether a parsed `ToolCall` can participate in parallel execution. It delegates capability lookup to the registry and applies the router's fallback policy.

*Call graph*: calls 1 internal fn (supports_parallel_tool_calls).


##### `ToolRouter::tool_waits_for_runtime_cancellation`  (lines 94–98)

```
fn tool_waits_for_runtime_cancellation(&self, call: &ToolCall) -> bool
```

**Purpose**: Reports whether a tool should remain active until its runtime cleanup acknowledges cancellation rather than being treated as immediately stoppable. Unknown tools default to not waiting.

**Data flow**: It reads `call.tool_name`, invokes `self.registry.waits_for_runtime_cancellation(&call.tool_name)`, converts `None` to `false`, and returns the resulting boolean. It does not mutate router state.

**Call relations**: Cancellation-handling paths consult this to decide how to model tool shutdown and lifecycle events. The method simply forwards the capability query to the registry and normalizes missing data.

*Call graph*: calls 1 internal fn (waits_for_runtime_cancellation).


##### `ToolRouter::build_tool_call`  (lines 101–148)

```
fn build_tool_call(item: ResponseItem) -> Result<Option<ToolCall>, FunctionCallError>
```

**Purpose**: Normalizes a protocol `ResponseItem` into the router's internal `ToolCall` representation when that item actually represents an executable tool invocation. It also rejects malformed client-side tool-search arguments with a `FunctionCallError` and ignores unsupported response items by returning `None`.

**Data flow**: It pattern-matches on the incoming `ResponseItem`. For `FunctionCall`, it builds a namespaced `ToolName` with `ToolName::new(namespace, name)` and wraps raw `arguments` in `ToolPayload::Function`. For `ToolSearchCall`, it only proceeds when `call_id` is present and `execution == "client"`; it deserializes `arguments` into `SearchToolCallParams` via `serde_json::from_value`, maps parse failures into `FunctionCallError::RespondToModel`, and emits a plain `tool_search` call with `ToolPayload::ToolSearch`. For `CustomToolCall`, it creates a plain `ToolName` from `name` and stores `input` in `ToolPayload::Custom`. All other variants, and non-client or missing-id tool-search calls, produce `Ok(None)`.

**Call relations**: Model-output handling paths invoke this immediately after receiving a `ResponseItem` to determine whether there is a tool call to execute. It delegates only to `ToolName` constructors and JSON deserialization, serving as the protocol-to-router conversion boundary before dispatch.

*Call graph*: calls 2 internal fn (new, plain); called by 5 (fatal_tool_error_stops_turn_and_reports_error, shell_tool_cancellation_waits_for_runtime_cleanup, handle_output_item_done, build_tool_call_uses_namespace_for_registry_name, extension_tool_executors_are_model_visible_and_dispatchable); 1 external calls (from_value).


##### `ToolRouter::dispatch_tool_call_with_code_mode_result`  (lines 152–171)

```
async fn dispatch_tool_call_with_code_mode_result(
        &self,
        session: Arc<Session>,
        turn: Arc<TurnContext>,
        cancellation_token: CancellationToken,
        tracker: SharedT
```

**Purpose**: Dispatches a prepared `ToolCall` through the registry in the ordinary execution path where no terminal-outcome flag needs to be tracked. It is the public async entry point for standard tool execution.

**Data flow**: It takes shared `Session` and `TurnContext`, a `CancellationToken`, a `SharedTurnDiffTracker`, the `ToolCall`, and the `ToolCallSource`, then forwards all of them to `dispatch_tool_call_with_code_mode_result_inner` with `terminal_outcome_reached` set to `None`. It returns the `AnyToolResult` or `FunctionCallError` produced by the inner dispatch.

**Call relations**: Regular tool execution code calls this when it has already parsed a tool call and wants the registry to run it. Its only downstream step is invoking the shared inner dispatcher without terminal-outcome tracking.

*Call graph*: calls 1 internal fn (dispatch_tool_call_with_code_mode_result_inner).


##### `ToolRouter::dispatch_tool_call_with_terminal_outcome`  (lines 175–195)

```
async fn dispatch_tool_call_with_terminal_outcome(
        &self,
        session: Arc<Session>,
        turn: Arc<TurnContext>,
        cancellation_token: CancellationToken,
        tracker: SharedT
```

**Purpose**: Dispatches a prepared `ToolCall` while also threading through a shared `AtomicBool` that records whether a terminal tool outcome has been reached. This variant is used in flows where one tool result can end further processing.

**Data flow**: It accepts the same execution context as the standard dispatcher plus an `Arc<AtomicBool>` named `terminal_outcome_reached`, wraps that flag in `Some(...)`, and forwards everything to `dispatch_tool_call_with_code_mode_result_inner`. It returns the inner dispatch result unchanged.

**Call relations**: Callers in terminal-outcome-aware execution paths use this instead of the simpler dispatcher so the registry can coordinate stop conditions. It shares all actual dispatch logic with the inner helper.

*Call graph*: calls 1 internal fn (dispatch_tool_call_with_code_mode_result_inner).


##### `ToolRouter::dispatch_tool_call_with_code_mode_result_inner`  (lines 198–228)

```
async fn dispatch_tool_call_with_code_mode_result_inner(
        &self,
        session: Arc<Session>,
        turn: Arc<TurnContext>,
        cancellation_token: CancellationToken,
        tracker: S
```

**Purpose**: Performs the actual router-side dispatch setup by converting a `ToolCall` plus execution context into a `ToolInvocation` and handing it to the registry. This is the single implementation behind both public dispatch variants.

**Data flow**: It destructures the incoming `ToolCall` into `tool_name`, `call_id`, and `payload`; combines those with `session`, `turn`, `cancellation_token`, `tracker`, and `source` into a `ToolInvocation`; then awaits `self.registry.dispatch_any_with_terminal_outcome(invocation, terminal_outcome_reached)`. The returned `AnyToolResult` or `FunctionCallError` comes directly from the registry dispatch, and the router itself retains no per-call mutable state.

**Call relations**: Both public dispatch methods funnel into this helper so there is one place where invocation objects are assembled. Its sole delegated operation is the registry dispatch call, which performs tool-specific execution and terminal-outcome handling.

*Call graph*: calls 1 internal fn (dispatch_any_with_terminal_outcome); called by 2 (dispatch_tool_call_with_code_mode_result, dispatch_tool_call_with_terminal_outcome).


##### `extension_tool_executors`  (lines 231–246)

```
fn extension_tool_executors(
    session: &Session,
) -> Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>
```

**Purpose**: Collects all extension-contributed tool executors available in the current session into a flat vector. This gives router-building code a concrete list of executable extension tools to register.

**Data flow**: It reads `session.services.extensions.tool_contributors()`, iterates each contributor, calls `contributor.tools(&session.services.session_extension_data, &session.services.thread_extension_data)`, flattens the resulting per-contributor collections, and collects them into `Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>`. It does not mutate the session.

**Call relations**: Router-construction code calls this before assembling the registry so extension tools can be included alongside built-in, MCP, and dynamic tools. The function delegates tool enumeration to each contributor using both session-scoped and thread-scoped extension data.

*Call graph*: called by 1 (built_tools).


### `core/src/tools/registry.rs`

`orchestration` · `tool dispatch and request handling`

This file is the core dispatcher for locally executed tools. It introduces `CoreToolRuntime`, a trait layered on top of `ToolExecutor<ToolInvocation>`, adding default behavior for payload-kind matching, cancellation semantics, telemetry tags, hook-facing payload generation, hook-driven input rewriting, and optional streamed argument-diff consumers. The defaults are intentionally conservative: only function and tool-search payloads are accepted, cancellation does not wait for runtime cleanup unless overridden, and hook payloads are derived from function arguments serialized as JSON.

`ToolRegistry` stores `Arc<dyn CoreToolRuntime>` instances keyed by `ToolName`, rejects duplicate registrations, and exposes lookup helpers used by higher-level orchestration. Its main path is `dispatch_any_with_terminal_outcome`, which increments active-turn tool-call accounting, builds telemetry tags from sandbox/network policy plus tool-specific tags, validates tool existence and payload compatibility, emits lifecycle start notifications, runs pre-tool-use hooks that may block or rewrite input, executes the tool under telemetry timing, emits memory-read metrics, runs post-tool-use hooks, records additional contexts, and emits exactly one finish notification unless another terminal outcome already claimed it via an `AtomicBool`.

The file also defines `AnyToolResult` as an erased result wrapper, `PostToolUseFeedbackOutput` as a decorator that swaps only the model-visible response while preserving logging/code-mode behavior, and `ExposureOverride`, a thin wrapper that changes `ToolExposure` without altering the underlying implementation. A notable invariant is that post-tool-use blocking rejects the returned result but does not retroactively mark the handler as unexecuted; lifecycle reporting distinguishes blocked-before-execution, failed-before-handler, and failed-after-handler cases.

#### Function details

##### `CoreToolRuntime::matches_kind`  (lines 48–53)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Provides the default payload compatibility check for a tool runtime. By default it accepts only `ToolPayload::Function` and `ToolPayload::ToolSearch` invocations.

**Data flow**: Reads the incoming `&ToolPayload` and pattern-matches its variant. It returns `true` for function/search payloads and `false` for custom or other unsupported payload kinds; it does not mutate any state.

**Call relations**: Used during registry dispatch before execution to reject invocations whose payload shape does not match the runtime contract. Implementers can override it when a tool supports a narrower or broader payload set.

*Call graph*: 1 external calls (matches!).


##### `CoreToolRuntime::waits_for_runtime_cancellation`  (lines 57–59)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Declares whether cancellation should wait for the tool runtime to finish its own cleanup before the host reports an aborted result. The default says no.

**Data flow**: Consumes no inputs beyond `&self` and returns the constant `false`. It reads no external state and writes none.

**Call relations**: Queried through `ToolRegistry::waits_for_runtime_cancellation` by higher-level cancellation orchestration to decide whether to return immediately or wait for runtime teardown.


##### `CoreToolRuntime::telemetry_tags`  (lines 61–66)

```
fn telemetry_tags(
        &'a self,
        _invocation: &'a ToolInvocation,
    ) -> BoxFuture<'a, ToolTelemetryTags>
```

**Purpose**: Supplies optional asynchronous telemetry tags to attach to tool-result logging. The default implementation contributes no extra tags.

**Data flow**: Receives `&self` and `&ToolInvocation`, ignores them, and returns a boxed future resolving to an empty `Vec<(&'static str, String)>`. It does not mutate state.

**Call relations**: Called by `ToolRegistry::dispatch_any_with_terminal_outcome` before execution so tool-specific metadata can be merged with sandbox/policy tags and split into normal telemetry tags versus trace-only fields.

*Call graph*: 2 external calls (pin, new).


##### `CoreToolRuntime::post_tool_use_payload`  (lines 68–100)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the hook-facing payload sent to post-tool-use hooks for function-style tools. It derives a stable hook tool name, tool-use id, input, and response body from the invocation and output.

**Data flow**: Reads `&ToolInvocation` and `&dyn ToolOutput`. If the invocation payload is not `ToolPayload::Function`, it returns `None`. Otherwise it computes `tool_name` via `function_hook_tool_name`, gets `tool_use_id` from `result.post_tool_use_id`, prefers `result.post_tool_use_input` over parsed function arguments, and prefers `result.post_tool_use_response`; if absent, it converts the body from `result.to_response_item(...)` when that response is a `ResponseInputItem::FunctionCallOutput`. It returns `Some(PostToolUsePayload)` only when a response value can be produced.

**Call relations**: Invoked from `handle_any_tool` after the tool handler completes successfully, so the registry can later run post-tool-use hooks. Tool implementations override this when they need a more stable or specialized hook contract than the default function-call output mapping.

*Call graph*: calls 4 internal fn (function_hook_tool_name, post_tool_use_id, post_tool_use_input, post_tool_use_response); called by 1 (handle_any_tool).


##### `CoreToolRuntime::pre_tool_use_payload`  (lines 102–111)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the hook-facing payload sent to pre-tool-use hooks for function-style tools. It exposes a stable hook tool name and parsed tool input.

**Data flow**: Reads `&ToolInvocation`; if the payload is not `ToolPayload::Function`, it returns `None`. For function payloads it computes the hook name with `function_hook_tool_name`, parses the raw argument string with `function_hook_tool_input`, and returns `Some(PreToolUsePayload)`.

**Call relations**: Called by `ToolRegistry::dispatch_any_with_terminal_outcome` before execution. If it returns `Some`, the registry runs pre-tool-use hooks that may block the call or rewrite the input.

*Call graph*: calls 2 internal fn (function_hook_tool_input, function_hook_tool_name).


##### `CoreToolRuntime::with_updated_hook_input`  (lines 117–138)

```
fn with_updated_hook_input(
        &self,
        invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies a hook-provided rewritten input back onto a `ToolInvocation`. The default implementation supports only function payloads by serializing the updated JSON back into the invocation's argument string.

**Data flow**: Consumes a `ToolInvocation` and a rewritten `serde_json::Value`. It verifies the invocation payload is `ToolPayload::Function`; otherwise it returns `FunctionCallError::RespondToModel`. It serializes `updated_input` with `serde_json::to_string`, replacing the invocation payload with `ToolPayload::Function { arguments }`, and returns the updated invocation. Serialization failures are converted into `RespondToModel` errors naming the flattened tool.

**Call relations**: Used only when pre-tool-use hooks return `updated_input`. `ToolRegistry::dispatch_any_with_terminal_outcome` calls it after hook approval to continue execution with rewritten arguments.

*Call graph*: 2 external calls (to_string, RespondToModel).


##### `CoreToolRuntime::create_diff_consumer`  (lines 141–143)

```
fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Optionally creates a consumer for streamed argument diffs emitted while a tool call is still being assembled. The default implementation opts out.

**Data flow**: Takes `&self` and returns `None`. It reads and writes no state.

**Call relations**: Exposed through `ToolRegistry::create_diff_consumer` for callers that want incremental protocol events derived from partial tool input.


##### `ToolArgumentDiffConsumer::finish`  (lines 154–156)

```
fn finish(&mut self) -> Result<Option<EventMsg>, FunctionCallError>
```

**Purpose**: Provides a default finalization step for diff consumers once no more argument chunks will arrive. The default does nothing and succeeds.

**Data flow**: Consumes `&mut self`, performs no transformation, and returns `Ok(None)`. It does not emit an event or mutate external state.

**Call relations**: Called by whichever streaming orchestration owns a concrete diff consumer after the last diff has been processed, allowing implementations to flush buffered state if needed.


##### `AnyToolResult::into_response`  (lines 167–175)

```
fn into_response(self) -> ResponseInputItem
```

**Purpose**: Converts an erased tool result into the protocol item returned to the model. It delegates formatting to the underlying `ToolOutput` using the stored call id and payload.

**Data flow**: Consumes `self`, extracts `call_id`, `payload`, and boxed `result`, and calls `result.to_response_item(&call_id, &payload)`. It returns the resulting `ResponseInputItem` and discards the optional post-hook payload.

**Call relations**: Used by higher-level response assembly after registry dispatch has completed and any hook-driven result rewriting has already been applied.


##### `AnyToolResult::code_mode_result`  (lines 177–182)

```
fn code_mode_result(self) -> serde_json::Value
```

**Purpose**: Converts an erased tool result into the JSON form used by code mode. It preserves the original payload context for the conversion.

**Data flow**: Consumes `self`, extracts `payload` and boxed `result`, and returns `result.code_mode_result(&payload)`. No state is mutated.

**Call relations**: Used by code-mode execution paths that need a machine-readable JSON result instead of a `ResponseInputItem`.


##### `PostToolUseFeedbackOutput::log_preview`  (lines 191–193)

```
fn log_preview(&self) -> String
```

**Purpose**: Preserves the original tool's log preview even when the model-visible response has been replaced by post-hook feedback. This keeps operational logs tied to the actual handler output.

**Data flow**: Reads `self.original` and returns `original.log_preview()`. It does not inspect or modify `model_visible`.

**Call relations**: Called wherever generic `ToolOutput` logging occurs after a post-tool-use hook has wrapped the result.


##### `PostToolUseFeedbackOutput::success_for_logging`  (lines 195–197)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Preserves the original tool's success flag for logging and lifecycle interpretation. Hook feedback changes what the model sees, not whether the handler itself succeeded.

**Data flow**: Reads `self.original` and returns `original.success_for_logging()`. It writes no state.

**Call relations**: Used by telemetry and lifecycle consumers after a result has been wrapped with post-hook feedback.


##### `PostToolUseFeedbackOutput::to_response_item`  (lines 199–201)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Overrides the model-visible response item with a synthetic `FunctionToolOutput` generated from post-tool-use feedback. This is the one method where the wrapper intentionally diverges from the original output.

**Data flow**: Reads `self.model_visible` plus the provided `call_id` and `payload`, and returns `model_visible.to_response_item(call_id, payload)`. It ignores `self.original` for this conversion.

**Call relations**: Reached when the final response is serialized after `dispatch_any_with_terminal_outcome` has replaced a successful result with feedback text from a post-tool-use hook.

*Call graph*: calls 1 internal fn (to_response_item).


##### `PostToolUseFeedbackOutput::code_mode_result`  (lines 203–205)

```
fn code_mode_result(&self, payload: &ToolPayload) -> Value
```

**Purpose**: Keeps code-mode output identical to the original tool result even when the model-facing conversational response has been replaced. This avoids contaminating machine-oriented consumers with hook feedback text.

**Data flow**: Reads `self.original` and the provided `&ToolPayload`, then returns `original.code_mode_result(payload)`. It does not mutate state.

**Call relations**: Used by code-mode callers after a post-tool-use hook has wrapped the result; unlike `to_response_item`, it intentionally delegates to the original output.


##### `override_tool_exposure`  (lines 237–246)

```
fn override_tool_exposure(
    handler: Arc<dyn CoreToolRuntime>,
    exposure: ToolExposure,
) -> Arc<dyn CoreToolRuntime>
```

**Purpose**: Wraps a tool runtime with a different `ToolExposure` value without changing its implementation. If the requested exposure already matches, it returns the original `Arc` unchanged.

**Data flow**: Consumes an `Arc<dyn CoreToolRuntime>` and a target `ToolExposure`. It compares `handler.exposure()` to the requested value; on mismatch it allocates an `ExposureOverride { handler, exposure }` inside a new `Arc`, otherwise it returns the original handler.

**Call relations**: Called by registry-building code when the same runtime should be published with a different visibility policy. The wrapper then participates transparently in all later dispatch paths.

*Call graph*: called by 2 (add_with_exposure, add_collaboration_tools); 1 external calls (new).


##### `ExposureOverride::tool_name`  (lines 254–256)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Delegates tool-name lookup to the wrapped runtime. Exposure changes do not alter identity.

**Data flow**: Reads `self.handler` and returns `handler.tool_name()`. No state is changed.

**Call relations**: Used anywhere the wrapped tool is treated as a `ToolExecutor`, including registry insertion and dispatch.


##### `ExposureOverride::spec`  (lines 258–260)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Delegates tool specification generation to the wrapped runtime. The wrapper does not rewrite the spec itself.

**Data flow**: Reads `self.handler` and returns `handler.spec()`. It performs no mutation.

**Call relations**: Participates in model-visible tool-spec construction while preserving the underlying tool's declared schema.


##### `ExposureOverride::exposure`  (lines 262–264)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Returns the overridden exposure value instead of the wrapped runtime's original one. This is the wrapper's primary behavioral change.

**Data flow**: Reads `self.exposure` and returns it by value. No other state is touched.

**Call relations**: Queried by callers deciding whether a tool is visible, hidden, or otherwise exposed under the current configuration.


##### `ExposureOverride::supports_parallel_tool_calls`  (lines 266–268)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Delegates parallel-call support to the wrapped runtime, but forcibly disables it when the overridden exposure is `ToolExposure::Hidden`. Hidden tools are treated as not parallel-callable.

**Data flow**: Reads `self.exposure` and `self.handler.supports_parallel_tool_calls()`. It returns `false` if exposure is hidden; otherwise it returns the wrapped runtime's answer.

**Call relations**: Used through registry queries and dispatch planning to ensure hidden tools are not scheduled as parallel-call candidates.


##### `ExposureOverride::search_info`  (lines 270–272)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Delegates tool-search metadata to the wrapped runtime unchanged. Exposure does not alter search-info contents here.

**Data flow**: Reads `self.handler` and returns `handler.search_info()`. No state is modified.

**Call relations**: Used when building searchable tool inventories from wrapped runtimes.


##### `ExposureOverride::handle`  (lines 274–276)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Forwards execution to the wrapped runtime. The wrapper does not intercept or transform the invocation itself.

**Data flow**: Consumes a `ToolInvocation`, passes it to `self.handler.handle(invocation)`, and returns the wrapped future. It writes no state.

**Call relations**: Reached during actual tool execution after the registry has selected the wrapped runtime.


##### `ExposureOverride::matches_kind`  (lines 280–282)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Delegates payload-kind compatibility checks to the wrapped runtime. Exposure does not affect payload shape validation.

**Data flow**: Reads `self.handler` and the provided `&ToolPayload`, returning `handler.matches_kind(payload)`. No mutation occurs.

**Call relations**: Called during dispatch validation when the selected tool has been exposure-wrapped.


##### `ExposureOverride::waits_for_runtime_cancellation`  (lines 284–286)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Delegates cancellation-wait semantics to the wrapped runtime. The wrapper does not alter teardown behavior.

**Data flow**: Reads `self.handler` and returns `handler.waits_for_runtime_cancellation()`. No state is changed.

**Call relations**: Queried by cancellation orchestration through the registry when the tool has an exposure override.


##### `ExposureOverride::pre_tool_use_payload`  (lines 288–290)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Delegates pre-hook payload construction to the wrapped runtime. Exposure does not change hook contracts.

**Data flow**: Reads `self.handler` and `&ToolInvocation`, returning `handler.pre_tool_use_payload(invocation)`. It writes no state.

**Call relations**: Used during dispatch before pre-tool-use hooks run for an exposure-wrapped tool.


##### `ExposureOverride::post_tool_use_payload`  (lines 292–298)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Delegates post-hook payload construction to the wrapped runtime. The wrapper preserves the underlying tool's hook-facing output contract.

**Data flow**: Reads `self.handler`, `&ToolInvocation`, and `&dyn ToolOutput`, returning `handler.post_tool_use_payload(invocation, result)`. No mutation occurs.

**Call relations**: Called from `handle_any_tool` after execution when the selected runtime is wrapped for exposure.


##### `ExposureOverride::with_updated_hook_input`  (lines 300–307)

```
fn with_updated_hook_input(
        &self,
        invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Delegates hook-driven input rewriting to the wrapped runtime. Exposure does not affect how rewritten input is reconstituted.

**Data flow**: Consumes a `ToolInvocation` and `Value`, forwards them to `handler.with_updated_hook_input(...)`, and returns the resulting `Result<ToolInvocation, FunctionCallError>`.

**Call relations**: Used by dispatch after pre-tool-use hooks request an input rewrite for an exposure-wrapped tool.


##### `ExposureOverride::telemetry_tags`  (lines 309–314)

```
fn telemetry_tags(
        &'a self,
        invocation: &'a ToolInvocation,
    ) -> BoxFuture<'a, ToolTelemetryTags>
```

**Purpose**: Delegates asynchronous telemetry-tag generation to the wrapped runtime. The wrapper adds no tags of its own.

**Data flow**: Reads `self.handler` and `&ToolInvocation`, returning the future from `handler.telemetry_tags(invocation)`. No state is mutated.

**Call relations**: Called during dispatch before execution to enrich telemetry for wrapped tools.


##### `ExposureOverride::create_diff_consumer`  (lines 316–318)

```
fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Delegates streamed argument-diff consumer creation to the wrapped runtime. Exposure does not alter incremental input handling.

**Data flow**: Reads `self.handler` and returns `handler.create_diff_consumer()`. It writes no state.

**Call relations**: Used through `ToolRegistry::create_diff_consumer` when a wrapped tool supports partial-input event generation.


##### `ToolRegistry::new`  (lines 326–328)

```
fn new(tools: HashMap<ToolName, Arc<dyn CoreToolRuntime>>) -> Self
```

**Purpose**: Constructs a registry from an already prepared map of tool names to runtimes. It is the minimal internal initializer.

**Data flow**: Consumes a `HashMap<ToolName, Arc<dyn CoreToolRuntime>>` and stores it in `Self { tools }`. It performs no validation beyond what callers already did.

**Call relations**: Used by factory helpers such as `from_tools` and test-only constructors to centralize struct creation.

*Call graph*: called by 2 (dispatch_notifies_tool_lifecycle_contributors, handler_looks_up_namespaced_aliases_explicitly).


##### `ToolRegistry::from_tools`  (lines 330–341)

```
fn from_tools(tools: impl IntoIterator<Item = Arc<dyn CoreToolRuntime>>) -> Self
```

**Purpose**: Builds a registry from an iterator of tool runtimes, keyed by each runtime's `tool_name()`. It detects duplicate names and reports them via `error_or_panic` while keeping the first inserted mapping.

**Data flow**: Consumes an iterator of `Arc<dyn CoreToolRuntime>`, iterates through each tool, reads its `tool_name`, checks `tools_by_name.contains_key`, and either logs/panics on duplicates or inserts the tool into a `HashMap`. It returns `Self::new(tools_by_name)`.

**Call relations**: Used by startup/assembly code to create the runtime registry from a list of handlers. Duplicate detection happens here before any dispatch occurs.

*Call graph*: calls 1 internal fn (error_or_panic); called by 3 (cancellation_after_handler_finishes_preserves_completed_lifecycle, cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle, build_model_visible_specs_and_registry); 3 external calls (new, new, format!).


##### `ToolRegistry::empty_for_test`  (lines 344–346)

```
fn empty_for_test() -> Self
```

**Purpose**: Creates an empty registry for tests that need to exercise unsupported-tool behavior or inject handlers later. It is compiled only in test builds.

**Data flow**: Constructs an empty `HashMap` and passes it to `Self::new`, returning the resulting registry. No external state is touched.

**Call relations**: Used by tests that need a registry with no registered tools.

*Call graph*: called by 1 (dispatch_lifecycle_trace_records_unsupported_tool_failures); 2 external calls (new, new).


##### `ToolRegistry::with_handler_for_test`  (lines 349–355)

```
fn with_handler_for_test(handler: Arc<T>) -> Self
```

**Purpose**: Creates a single-tool registry for tests from one concrete handler. It erases the handler behind `Arc<dyn CoreToolRuntime>` and keys it by its declared name.

**Data flow**: Consumes `Arc<T>` where `T: CoreToolRuntime + 'static`, reads `handler.tool_name()`, builds a one-entry `HashMap`, and returns `Self::new(...)`.

**Call relations**: Used by tests that want a minimal registry around one fake or fixture tool.

*Call graph*: called by 3 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_incompatible_payload_failures, missing_code_mode_wait_traces_only_the_wait_tool_call); 2 external calls (from, new).


##### `ToolRegistry::tool`  (lines 357–359)

```
fn tool(&self, name: &ToolName) -> Option<Arc<dyn CoreToolRuntime>>
```

**Purpose**: Looks up a registered tool runtime by name and clones the stored `Arc`. It is the internal accessor used by most public registry queries.

**Data flow**: Reads `self.tools` with the provided `&ToolName`, clones the `Arc` if present, and returns `Option<Arc<dyn CoreToolRuntime>>`. It does not mutate the registry.

**Call relations**: Called by diff-consumer creation, capability queries, and the main dispatch path to resolve a tool name into an executable runtime.

*Call graph*: called by 4 (create_diff_consumer, dispatch_any_with_terminal_outcome, supports_parallel_tool_calls, waits_for_runtime_cancellation).


##### `ToolRegistry::tool_names_for_test`  (lines 362–366)

```
fn tool_names_for_test(&self) -> Vec<ToolName>
```

**Purpose**: Returns the registry's tool names in sorted order for deterministic test assertions. It is test-only introspection.

**Data flow**: Reads `self.tools.keys()`, clones them into a `Vec<ToolName>`, sorts the vector, and returns it. No state is modified.

**Call relations**: Used only by tests that verify registration contents.

*Call graph*: called by 1 (registered_tool_names_for_test).


##### `ToolRegistry::tool_exposure`  (lines 369–371)

```
fn tool_exposure(&self, name: &ToolName) -> Option<ToolExposure>
```

**Purpose**: Returns the exposure level of a named tool for tests. It is a thin read-only helper.

**Data flow**: Reads `self.tools.get(name)` and maps the found runtime to `tool.exposure()`, returning `Option<ToolExposure>`. It writes no state.

**Call relations**: Used by tests that verify exposure overrides or registry assembly.

*Call graph*: called by 1 (tool_exposure_for_test).


##### `ToolRegistry::create_diff_consumer`  (lines 373–378)

```
fn create_diff_consumer(
        &self,
        name: &ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Creates a streamed argument-diff consumer for a named tool if that tool exists and supports one. It combines lookup and delegation.

**Data flow**: Reads the registry via `self.tool(name)?`; if found, it calls `create_diff_consumer()` on the runtime and returns the resulting `Option<Box<dyn ToolArgumentDiffConsumer>>`. Missing tools yield `None`.

**Call relations**: Called by higher-level streaming code that wants incremental events while a tool call's arguments are still arriving.

*Call graph*: calls 1 internal fn (tool); called by 1 (create_diff_consumer).


##### `ToolRegistry::supports_parallel_tool_calls`  (lines 380–383)

```
fn supports_parallel_tool_calls(&self, name: &ToolName) -> Option<bool>
```

**Purpose**: Reports whether a named tool supports parallel invocation. It returns `None` when the tool is not registered.

**Data flow**: Looks up the tool with `self.tool(name)?`, reads `tool.supports_parallel_tool_calls()`, and wraps the boolean in `Some`. It mutates no state.

**Call relations**: Used by scheduling/orchestration code to decide whether multiple calls to the tool may run concurrently.

*Call graph*: calls 1 internal fn (tool); called by 1 (tool_supports_parallel).


##### `ToolRegistry::waits_for_runtime_cancellation`  (lines 385–388)

```
fn waits_for_runtime_cancellation(&self, name: &ToolName) -> Option<bool>
```

**Purpose**: Reports whether a named tool wants cancellation to wait for runtime cleanup. It returns `None` for unknown tools.

**Data flow**: Looks up the tool with `self.tool(name)?`, reads `tool.waits_for_runtime_cancellation()`, and returns `Some(bool)`. No state is changed.

**Call relations**: Used by cancellation orchestration to tailor abort behavior per tool runtime.

*Call graph*: calls 1 internal fn (tool); called by 1 (tool_waits_for_runtime_cancellation).


##### `ToolRegistry::dispatch_any`  (lines 391–397)

```
async fn dispatch_any(
        &self,
        invocation: ToolInvocation,
    ) -> Result<AnyToolResult, FunctionCallError>
```

**Purpose**: Convenience wrapper that dispatches a tool invocation without terminal-outcome coordination. It is the simple entry point for callers that do not need shared cancellation/terminal-state claiming.

**Data flow**: Consumes a `ToolInvocation`, passes it to `dispatch_any_with_terminal_outcome(invocation, None).await`, and returns the resulting `Result<AnyToolResult, FunctionCallError>` unchanged.

**Call relations**: Called by simpler execution paths; the full logic lives in `dispatch_any_with_terminal_outcome`.

*Call graph*: calls 1 internal fn (dispatch_any_with_terminal_outcome).


##### `ToolRegistry::dispatch_any_with_terminal_outcome`  (lines 403–668)

```
async fn dispatch_any_with_terminal_outcome(
        &self,
        mut invocation: ToolInvocation,
        terminal_outcome_reached: Option<Arc<AtomicBool>>,
    ) -> Result<AnyToolResult, FunctionCa
```

**Purpose**: Executes the full tool-dispatch pipeline: lookup, validation, telemetry setup, lifecycle notifications, pre-hook enforcement and input rewriting, handler execution, metrics, post-hook enforcement/feedback, additional-context recording, and final lifecycle completion. It is the registry's main orchestration function.

**Data flow**: Consumes a mutable `ToolInvocation` and an optional `Arc<AtomicBool>` used to claim terminal outcome emission. It derives flattened tool names and base telemetry tags from the turn's sandbox/network policy, increments active-turn `tool_calls` under async locks, starts a `ToolDispatchTrace`, resolves the tool from the registry, and on missing-tool or incompatible-payload errors logs telemetry, records trace failure, and returns a `FunctionCallError`. For valid tools it awaits `telemetry_tags`, merges them into normal tags and trace-only fields, emits `notify_tool_start`, optionally runs pre-tool-use hooks using `pre_tool_use_payload`, and may return early on hook block or hook-rewrite failure after emitting a finish outcome if unclaimed. It then executes the handler inside `otel.log_tool_result_with_tags`, storing the produced `AnyToolResult` in a mutex-backed response cell, emits `emit_metric_for_tool_read`, extracts any post-tool-use payload from the stored result, runs post-tool-use hooks if available, records additional contexts, computes lifecycle outcome based on whether the handler ran and whether the result logged success, and calls `notify_tool_finish_if_unclaimed`. Finally, on success it takes the stored result, optionally converts post-hook block into `RespondToModel`, optionally wraps the result in `PostToolUseFeedbackOutput` when feedback text is present, records trace completion, and returns the final `AnyToolResult`; on execution error it records trace failure and returns the error.

**Call relations**: Invoked by `dispatch_any` and by code-mode dispatch paths. It delegates to hook runtime helpers, telemetry/logging facilities, lifecycle notifiers, `handle_any_tool` for actual execution, and `notify_tool_finish_if_unclaimed` to avoid duplicate terminal notifications when another path has already claimed completion.

*Call graph*: calls 13 internal fn (record_additional_contexts, run_post_tool_use_hooks, run_pre_tool_use_hooks, emit_metric_for_tool_read, permission_profile_policy_tag, permission_profile_sandbox_tag, from_text, flat_tool_name, notify_tool_start, tool (+3 more)); called by 2 (dispatch_any, dispatch_tool_call_with_code_mode_result_inner); 9 external calls (new, new, with_capacity, clone, format!, matches!, new, Fatal, RespondToModel).


##### `notify_tool_finish_if_unclaimed`  (lines 671–682)

```
async fn notify_tool_finish_if_unclaimed(
    invocation: &ToolInvocation,
    terminal_outcome_reached: Option<&AtomicBool>,
    outcome: ToolCallOutcome,
) -> bool
```

**Purpose**: Emits a tool-finish lifecycle notification only if no other path has already claimed the terminal outcome. This prevents duplicate finish events in races involving cancellation or alternate completion paths.

**Data flow**: Reads `terminal_outcome_reached: Option<&AtomicBool>` and the desired `ToolCallOutcome`. If the atomic exists and `swap(true, Ordering::AcqRel)` reports it was already set, it returns `false` without notifying. Otherwise it awaits `notify_tool_finish(invocation, outcome)` and returns `true`.

**Call relations**: Called from `dispatch_any_with_terminal_outcome` on every terminal path after block/failure/completion has been determined. The optional atomic is supplied by higher-level orchestration that coordinates multiple competing terminal outcomes.

*Call graph*: calls 1 internal fn (notify_tool_finish); called by 1 (dispatch_any_with_terminal_outcome).


##### `handle_any_tool`  (lines 684–709)

```
async fn handle_any_tool(
    tool: &dyn CoreToolRuntime,
    invocation: ToolInvocation,
) -> Result<AnyToolResult, FunctionCallError>
```

**Purpose**: Runs the selected tool runtime and packages its output into `AnyToolResult`, including memory-pollution side effects and post-tool-use hook payload derivation. It is the narrow execution helper beneath the larger dispatch pipeline.

**Data flow**: Consumes `&dyn CoreToolRuntime` and a `ToolInvocation`. It clones `call_id` and `payload`, awaits `tool.handle(invocation.clone())` to get a boxed `ToolOutput`, checks `output.contains_external_context()` against `invocation.turn.config.memories.disable_on_external_context`, and if both are true calls `state_db::mark_thread_memory_mode_polluted(...)` using session services and thread id. It then computes `post_tool_use_payload` via `CoreToolRuntime::post_tool_use_payload(tool, &invocation, output.as_ref())` and returns `AnyToolResult { call_id, payload, result: output, post_tool_use_payload }`.

**Call relations**: Called only from `ToolRegistry::dispatch_any_with_terminal_outcome` inside telemetry timing/logging. It isolates the actual handler invocation from the surrounding hook and lifecycle orchestration.

*Call graph*: calls 2 internal fn (post_tool_use_payload, mark_thread_memory_mode_polluted); 2 external calls (clone, handle).


##### `function_hook_tool_name`  (lines 711–722)

```
fn function_hook_tool_name(invocation: &ToolInvocation) -> HookToolName
```

**Purpose**: Maps a `ToolInvocation` to the canonical hook-facing tool name model. It special-cases `spawn_agent` in the default or multi-agent namespace so hooks can match it under a stable synthetic name.

**Data flow**: Reads `invocation.tool_name`. If the name is `spawn_agent` and the namespace is absent or equals `MULTI_AGENT_V1_NAMESPACE`, it returns `HookToolName::spawn_agent()`. Otherwise it flattens the tool name with `flat_tool_name` and wraps it with `HookToolName::new(...)`.

**Call relations**: Used by both pre- and post-tool-use payload builders so hook matching sees a stable canonical name plus aliases where appropriate.

*Call graph*: calls 3 internal fn (flat_tool_name, new, spawn_agent); called by 2 (post_tool_use_payload, pre_tool_use_payload); 1 external calls (matches!).


##### `function_hook_tool_input`  (lines 724–730)

```
fn function_hook_tool_input(arguments: &str) -> Value
```

**Purpose**: Converts raw function-call argument text into the JSON value exposed to hooks. Empty input becomes `{}`, valid JSON is parsed structurally, and invalid JSON is preserved as a string.

**Data flow**: Consumes `&str arguments`. If `trim().is_empty()`, it returns `Value::Object(serde_json::Map::new())`. Otherwise it attempts `serde_json::from_str(arguments)` and returns the parsed `Value` on success or `Value::String(arguments.to_string())` on parse failure.

**Call relations**: Called by `CoreToolRuntime::pre_tool_use_payload`, and indirectly influences the default post-hook input when the output does not provide a specialized `post_tool_use_input`.

*Call graph*: called by 1 (pre_tool_use_payload); 3 external calls (Object, new, from_str).


##### `unsupported_tool_call_message`  (lines 732–737)

```
fn unsupported_tool_call_message(payload: &ToolPayload, tool_name: &ToolName) -> String
```

**Purpose**: Formats the user/model-facing error message for invocations whose tool name is not registered. It distinguishes custom payloads from ordinary calls.

**Data flow**: Reads `&ToolPayload` and `&ToolName`, pattern-matches the payload, and returns either `unsupported custom tool call: {tool_name}` for `ToolPayload::Custom` or `unsupported call: {tool_name}` otherwise. It mutates no state.

**Call relations**: Used by `ToolRegistry::dispatch_any_with_terminal_outcome` on lookup failure before telemetry logging and trace failure recording.

*Call graph*: called by 1 (dispatch_any_with_terminal_outcome); 1 external calls (format!).


### `tui/src/app/app_server_event_targets.rs`

`domain_logic` · `request handling`

This module is a pure classification layer between `codex_app_server_protocol` enums and the TUI’s thread-aware event queues. `server_request_thread_id` inspects each `ServerRequest` variant that carries `params.thread_id`, parses it into a `codex_protocol::ThreadId`, and returns `None` for request types that are intentionally threadless or app-scoped. `ServerNotificationThreadTarget` then gives notification routing more nuance than a bare `Option<ThreadId>`: `Thread(ThreadId)` for valid thread-bound notifications, `InvalidThreadId(String)` when a thread-looking string fails validation, `AppScoped` for notifications like `McpServerStatusUpdated` without a thread but still not globally broadcast in the UI, and `Global` for notifications with no thread affinity.

`server_notification_thread_target` is an exhaustive match over `ServerNotification`. Most variants expose a `thread_id` string directly; `Warning` uses an optional thread ID, and `McpServerStatusUpdated` is special-cased so `None` becomes `AppScoped` instead of `Global`. After extracting an optional string, the function validates it with `ThreadId::from_string`, preserving malformed IDs as `InvalidThreadId` rather than silently dropping them. The test module covers the subtle cases: warnings with and without thread IDs, guardian warnings, MCP startup notifications with and without thread IDs, and thread settings updates. Those tests document the intended routing contract consumed by the main app event handler.

#### Function details

##### `server_request_thread_id`  (lines 7–32)

```
fn server_request_thread_id(request: &ServerRequest) -> Option<ThreadId>
```

**Purpose**: Extracts and validates the thread identifier from thread-bound `ServerRequest` variants. Requests that are app-scoped, legacy, or otherwise not associated with a thread return `None`.

**Data flow**: Takes `&ServerRequest`, pattern-matches variants such as command approval, file-change approval, user-input, MCP elicitation, permissions approval, and dynamic tool call, reads `params.thread_id`, and attempts `ThreadId::from_string`. Successful parses become `Some(ThreadId)`; parse failures and threadless variants yield `None` without mutating any state.

**Call relations**: It is invoked by `App::handle_server_request_event` before the request is enqueued. That caller uses the returned `ThreadId` to decide whether to route the request to the primary thread queue, a side-thread queue, or ignore it as threadless.

*Call graph*: calls 1 internal fn (from_string); called by 1 (handle_server_request_event).


##### `server_notification_thread_target`  (lines 42–186)

```
fn server_notification_thread_target(
    notification: &ServerNotification,
) -> ServerNotificationThreadTarget
```

**Purpose**: Classifies each `ServerNotification` into a concrete routing target for the TUI. It distinguishes valid thread-bound notifications from malformed thread IDs, app-scoped MCP startup notices, and truly global notifications.

**Data flow**: Accepts `&ServerNotification`, matches the variant to extract an optional thread-id string or to short-circuit to `AppScoped`/`Global`, then validates any extracted string with `ThreadId::from_string`. A valid parse returns `ServerNotificationThreadTarget::Thread`, a failed parse returns `InvalidThreadId` carrying the original string, `McpServerStatusUpdated` without a thread returns `AppScoped`, and variants with no thread field return `Global`.

**Call relations**: Production code calls this from `App::handle_server_notification_event` to choose between per-thread buffering and direct global handling. The unit tests in this file call it with representative notifications to lock down the routing semantics for optional-thread warnings and MCP startup updates.

*Call graph*: calls 1 internal fn (from_string); called by 7 (guardian_warning_notifications_route_to_threads, mcp_startup_notifications_route_to_threads, mcp_startup_notifications_without_threads_are_app_scoped, thread_settings_updated_notifications_route_to_threads, warning_notifications_route_to_threads_when_thread_id_is_present, warning_notifications_without_threads_are_global, handle_server_notification_event); 2 external calls (InvalidThreadId, Thread).


##### `tests::test_thread_settings`  (lines 208–232)

```
fn test_thread_settings() -> ThreadSettings
```

**Purpose**: Builds a realistic `ThreadSettings` fixture for notification-routing tests. The fixture includes cwd, approval/sandbox settings, model metadata, and collaboration settings so tests can instantiate `ThreadSettingsUpdatedNotification` without unrelated boilerplate.

**Data flow**: Constructs and returns a `ThreadSettings` value using a test absolute path, fixed approval and sandbox policies, model/provider strings, optional reasoning effort, and a nested `CollaborationMode`/`Settings` structure. It reads no mutable state and writes nothing beyond the returned struct.

**Call relations**: This helper is used by `tests::thread_settings_updated_notifications_route_to_threads` to populate the notification payload while keeping the test focused on routing behavior.

*Call graph*: 1 external calls (test_path_buf).


##### `tests::warning_notifications_without_threads_are_global`  (lines 235–244)

```
fn warning_notifications_without_threads_are_global()
```

**Purpose**: Verifies that a `Warning` notification lacking `thread_id` is treated as globally scoped. This protects the distinction between optional-thread warnings and thread-bound notifications.

**Data flow**: Creates `ServerNotification::Warning` with `thread_id: None`, passes it to `server_notification_thread_target`, and asserts the result equals `ServerNotificationThreadTarget::Global`.

**Call relations**: This test directly exercises the `Warning` branch of `server_notification_thread_target`, covering the path where `notification.thread_id.as_deref()` yields `None`.

*Call graph*: calls 1 internal fn (server_notification_thread_target); 2 external calls (Warning, assert_eq!).


##### `tests::warning_notifications_route_to_threads_when_thread_id_is_present`  (lines 247–257)

```
fn warning_notifications_route_to_threads_when_thread_id_is_present()
```

**Purpose**: Checks that warnings become thread-targeted when they carry a valid thread ID string. It confirms optional-thread warnings are not always global.

**Data flow**: Generates a fresh `ThreadId`, embeds its string form in a `WarningNotification`, calls `server_notification_thread_target`, and asserts the classifier returns `Thread(thread_id)`.

**Call relations**: This test complements the previous warning test by covering the alternate branch in the same notification variant where a thread ID is present and valid.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 2 external calls (Warning, assert_eq!).


##### `tests::guardian_warning_notifications_route_to_threads`  (lines 260–270)

```
fn guardian_warning_notifications_route_to_threads()
```

**Purpose**: Ensures `GuardianWarning` notifications always route to the referenced thread. Unlike plain warnings, this variant carries a mandatory thread ID.

**Data flow**: Creates a new `ThreadId`, wraps it in `ServerNotification::GuardianWarning`, classifies the notification, and asserts the result is `ServerNotificationThreadTarget::Thread(thread_id)`.

**Call relations**: It exercises the dedicated `GuardianWarning` arm in `server_notification_thread_target`, documenting that guardian warnings are never global or app-scoped.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 2 external calls (GuardianWarning, assert_eq!).


##### `tests::mcp_startup_notifications_route_to_threads`  (lines 273–286)

```
fn mcp_startup_notifications_route_to_threads()
```

**Purpose**: Confirms that `McpServerStatusUpdated` notifications with a thread ID are routed to that thread. This covers the thread-bound half of the MCP startup special case.

**Data flow**: Builds an `McpServerStatusUpdatedNotification` with `thread_id: Some(...)`, server name, failed startup state, and error text; passes it to `server_notification_thread_target`; and asserts the result is `Thread(thread_id)`.

**Call relations**: This test targets the nested match inside the `McpServerStatusUpdated` branch, specifically the path where `thread_id.as_deref()` is `Some` and parsing succeeds.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 2 external calls (McpServerStatusUpdated, assert_eq!).


##### `tests::mcp_startup_notifications_without_threads_are_app_scoped`  (lines 289–301)

```
fn mcp_startup_notifications_without_threads_are_app_scoped()
```

**Purpose**: Verifies the non-threaded MCP startup case is classified as `AppScoped` rather than `Global`. That distinction is important because the main app currently ignores these notices instead of rendering them as generic global notifications.

**Data flow**: Constructs `ServerNotification::McpServerStatusUpdated` with `thread_id: None`, classifies it, and asserts the result equals `ServerNotificationThreadTarget::AppScoped`.

**Call relations**: It covers the early-return branch in `server_notification_thread_target` that treats threadless MCP startup updates specially.

*Call graph*: calls 1 internal fn (server_notification_thread_target); 2 external calls (McpServerStatusUpdated, assert_eq!).


##### `tests::thread_settings_updated_notifications_route_to_threads`  (lines 304–315)

```
fn thread_settings_updated_notifications_route_to_threads()
```

**Purpose**: Checks that `ThreadSettingsUpdated` notifications are recognized as thread-bound. The test ensures the classifier reads the embedded `thread_id` field correctly even with a richer payload.

**Data flow**: Creates a fresh `ThreadId`, builds a `ThreadSettingsUpdatedNotification` using `test_thread_settings()`, passes it to `server_notification_thread_target`, and asserts the result is `Thread(thread_id)`.

**Call relations**: This test exercises one of the many straightforward thread-id extraction arms in `server_notification_thread_target`, using a realistic settings payload to guard against future protocol-shape changes.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 3 external calls (ThreadSettingsUpdated, assert_eq!, test_thread_settings).


### App server feature adapters
These files cover the app server's narrower feature-specific RPC adapters for filesystem, plugins, marketplace, search, feedback, git, remote control, and attestation-related operations.

### `app-server/src/attestation.rs`

`domain_logic` · `request handling`

This file implements an `AttestationProvider` backed by app-server request/response messaging. `app_server_attestation_provider` constructs an `Arc<dyn AttestationProvider>` whose concrete state is `AppServerAttestationProvider`, holding a `Weak<OutgoingMessageSender>` so the provider does not keep the transport alive, plus a `ThreadStateManager` used to locate a connection that can satisfy attestation requests for a given thread.

The main path is `AppServerAttestationProvider::header_for_request`. It upgrades the weak sender, clones thread state, and returns a boxed future. That future asks `ThreadStateManager::first_attestation_capable_connection_for_thread` for a single eligible connection, sends `ServerRequestPayload::AttestationGenerate(AttestationGenerateParams {})` only to that connection, and waits up to `ATTESTATION_GENERATE_TIMEOUT` (100 ms). The nested match over `timeout(timeout_duration, rx).await` distinguishes successful replies, explicit JSON-RPC request failures, canceled receivers, and timeouts; on timeout it proactively cancels the outstanding request via `OutgoingMessageSender::cancel_request`.

Responses are expected to deserialize as `AttestationGenerateResponse { token }`. Success and all failure cases are normalized through `app_server_attestation_header_value`, which serializes `AppServerAttestationEnvelope { v: 1, s: status_code, t: optional_token }`. Status codes are stable numeric values from `AppServerAttestationStatus::code`. The final string is converted to `axum::http::HeaderValue`; invalid header bytes or serialization failures degrade to `None` rather than erroring. Tests pin the exact JSON emitted for opaque tokens and each failure status.

#### Function details

##### `app_server_attestation_provider`  (lines 21–29)

```
fn app_server_attestation_provider(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
) -> Arc<dyn AttestationProvider>
```

**Purpose**: Builds the concrete app-server-backed attestation provider and erases it behind `Arc<dyn AttestationProvider>`. It intentionally stores the outgoing sender as a weak reference so attestation support disappears cleanly when messaging infrastructure is gone.

**Data flow**: Takes an `Arc<OutgoingMessageSender>` and a `ThreadStateManager` → downgrades the sender to `Weak`, stores both in `AppServerAttestationProvider` → returns the provider wrapped in `Arc<dyn AttestationProvider>`.

**Call relations**: Used during server wiring when a component needs an `AttestationProvider`. It does not perform attestation itself; it prepares the state later consumed by `AppServerAttestationProvider::header_for_request`.

*Call graph*: 2 external calls (downgrade, new).


##### `AppServerAttestationProvider::fmt`  (lines 37–41)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a minimal `Debug` implementation that identifies the provider type without exposing internal sender or thread-state details. This keeps logs/debug output stable and non-noisy.

**Data flow**: Reads `self` only for type identity → writes a `debug_struct("AppServerAttestationProvider")` into the formatter → returns the formatter result.

**Call relations**: Invoked implicitly by Rust formatting/debugging paths. It is ancillary and does not participate in attestation generation flow.

*Call graph*: 1 external calls (debug_struct).


##### `AppServerAttestationProvider::header_for_request`  (lines 45–60)

```
fn header_for_request(&self, context: AttestationContext) -> GenerateAttestationFuture<'_>
```

**Purpose**: Starts asynchronous attestation generation for a request context and converts the resulting JSON envelope into an HTTP `HeaderValue`. If the outgoing transport has already been dropped, it immediately resolves to no header.

**Data flow**: Consumes an `AttestationContext` and reads `self.outgoing` plus `self.thread_state_manager` → upgrades the weak sender, clones thread state, and asynchronously requests an attestation string for `context.thread_id` with the fixed timeout → converts the returned string bytes into `HeaderValue`, yielding `Option<HeaderValue>` inside the boxed future.

**Call relations**: This is the `AttestationProvider` trait entry used by core request code when it wants a header for an outbound request. On the happy path it delegates all transport work to `request_attestation_header_value_with_timeout`; on transport teardown it short-circuits before any request is sent.

*Call graph*: calls 1 internal fn (request_attestation_header_value_with_timeout); 3 external calls (pin, upgrade, clone).


##### `request_attestation_header_value_with_timeout`  (lines 63–128)

```
async fn request_attestation_header_value_with_timeout(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
    thread_id: codex_protocol::ThreadId,
    timeout_dur
```

**Purpose**: Sends the app-server attestation generation request to one attestation-capable connection, waits for a bounded reply, and maps every outcome into the serialized attestation envelope string. It preserves failure information as status codes instead of dropping the header entirely whenever possible.

**Data flow**: Takes `Arc<OutgoingMessageSender>`, `ThreadStateManager`, a `ThreadId`, and a timeout `Duration` → asks thread state for the first attestation-capable connection; if none, returns `None` → sends `ServerRequestPayload::AttestationGenerate` to that connection and awaits the oneshot receiver under `tokio::time::timeout` → on request error/cancel/timeout logs a warning and returns `app_server_attestation_header_value` with the corresponding status and no token; on timeout also cancels the pending request → on success deserializes the JSON value into `AttestationGenerateResponse` and returns an envelope with status `Ok` and the token, or `MalformedResponse` if deserialization fails.

**Call relations**: Called only from `AppServerAttestationProvider::header_for_request` as the transport-facing implementation. It delegates envelope construction to `app_server_attestation_header_value` so all success/failure branches share one serialization format.

*Call graph*: calls 2 internal fn (app_server_attestation_header_value, first_attestation_capable_connection_for_thread); called by 1 (header_for_request); 3 external calls (AttestationGenerate, timeout, warn!).


##### `AppServerAttestationStatus::code`  (lines 140–148)

```
fn code(self) -> u8
```

**Purpose**: Maps each internal attestation outcome enum variant to the compact numeric status code embedded in the header envelope. The mapping is fixed and explicit.

**Data flow**: Takes `self` by value → matches enum variant → returns a `u8` code from 0 through 4.

**Call relations**: Used only by `app_server_attestation_header_value` during serialization, centralizing the wire-level status mapping in one place.

*Call graph*: called by 1 (app_server_attestation_header_value).


##### `app_server_attestation_header_value`  (lines 159–170)

```
fn app_server_attestation_header_value(
    status: AppServerAttestationStatus,
    token: Option<&str>,
) -> Option<String>
```

**Purpose**: Serializes the app-server attestation envelope into the exact JSON string sent as the HTTP header payload. It omits the token field when no token is available.

**Data flow**: Takes an `AppServerAttestationStatus` and optional token `&str` → builds `AppServerAttestationEnvelope { v: 1, s: status.code(), t: token }` → serializes with `serde_json::to_string` → returns `Some(String)` on success or logs a warning and returns `None` on serialization failure.

**Call relations**: This is the common formatter used by `request_attestation_header_value_with_timeout` for both successful client-generated tokens and app-server-generated failure envelopes.

*Call graph*: calls 1 internal fn (code); called by 1 (request_attestation_header_value_with_timeout); 1 external calls (to_string).


##### `tests::app_server_attestation_header_value_wraps_opaque_client_payloads`  (lines 179–187)

```
fn app_server_attestation_header_value_wraps_opaque_client_payloads()
```

**Purpose**: Verifies that a successful attestation token is embedded unchanged as the `t` field in the versioned JSON envelope. The test treats the token as opaque payload.

**Data flow**: Calls `app_server_attestation_header_value` with `Ok` and a sample token → compares the returned `Option<String>` to the exact expected JSON string.

**Call relations**: This test exercises the success serialization branch of `app_server_attestation_header_value`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::app_server_attestation_header_value_reports_app_server_failures`  (lines 190–219)

```
fn app_server_attestation_header_value_reports_app_server_failures()
```

**Purpose**: Verifies the exact JSON emitted for each non-success app-server status and confirms that failure envelopes omit the token field. It locks down the numeric status-code mapping on the wire.

**Data flow**: Calls `app_server_attestation_header_value` repeatedly with `Timeout`, `RequestFailed`, `RequestCanceled`, and `MalformedResponse`, each with no token → asserts exact string equality for each serialized envelope.

**Call relations**: This test covers the failure-status branches encoded by `AppServerAttestationStatus::code` and serialized by `app_server_attestation_header_value`.

*Call graph*: 1 external calls (assert_eq!).


### `app-server/src/fs_watch.rs`

`orchestration` · `request handling`

This file defines `FsWatchManager`, the server-side coordinator for filesystem watches requested by clients. The manager holds three shared resources: an `Arc<OutgoingMessageSender>` for emitting protocol notifications, an `Arc<FileWatcher>` core watcher implementation, and an `Arc<AsyncMutex<FsWatchState>>` containing the active watch table. That table is a `HashMap<WatchKey, WatchEntry>`, keyed by the pair `(ConnectionId, watch_id)`, which makes watch IDs unique only within a single client connection rather than globally.

`watch` creates a new subscriber from the shared `FileWatcher`, registers exactly one non-recursive `WatchPath` for the requested absolute path, stores the resulting `FileWatcherSubscriber` and `WatchRegistration` in state to keep the watch alive, and spawns a Tokio task to forward events. That task wraps the raw receiver in `DebouncedWatchReceiver` with a fixed 200 ms debounce window, joins relative event paths back onto the original watched root, sorts the resulting absolute paths for deterministic output, and sends `ServerNotification::FsChanged` only when the changed-path list is non-empty. Duplicate `(connection, watch_id)` registrations are rejected with `invalid_request`.

`unwatch` removes only the caller's own entry and uses a oneshot handshake to wait until the spawned forwarding task has actually stopped, preventing notifications from racing after the unwatch response. `connection_closed` bulk-removes all entries for one connection; dropping the stored termination sender/subscriber/registration tears those watches down. The tests focus on these ownership and scoping invariants rather than real filesystem delivery.

#### Function details

##### `FsWatchManager::new`  (lines 54–63)

```
fn new(outgoing: Arc<OutgoingMessageSender>) -> Self
```

**Purpose**: Constructs a watch manager with a real `FileWatcher` when possible and transparently falls back to a no-op watcher if the watcher backend cannot be initialized. This keeps the server usable even on platforms or environments where filesystem watching setup fails.

**Data flow**: It takes an `Arc<OutgoingMessageSender>` and attempts `FileWatcher::new()`. On success it wraps the watcher in `Arc`; on failure it logs a warning and substitutes `FileWatcher::noop()`. It then passes both shared dependencies into `FsWatchManager::new_with_file_watcher` and returns the resulting manager.

**Call relations**: This is the normal constructor used by higher-level server setup. Its only internal job is dependency selection: choose the watcher backend, emit `warn!` on fallback, and delegate actual struct assembly to `FsWatchManager::new_with_file_watcher`.

*Call graph*: calls 2 internal fn (new, noop); called by 1 (new); 3 external calls (new, new_with_file_watcher, warn!).


##### `FsWatchManager::new_with_file_watcher`  (lines 65–74)

```
fn new_with_file_watcher(
        outgoing: Arc<OutgoingMessageSender>,
        file_watcher: Arc<FileWatcher>,
    ) -> Self
```

**Purpose**: Builds an `FsWatchManager` from already-prepared dependencies, primarily to support tests and explicit injection of a custom watcher implementation. It centralizes the struct layout and initial empty state.

**Data flow**: It receives an `Arc<OutgoingMessageSender>` and an `Arc<FileWatcher>`, creates a fresh `FsWatchState` via `Default`, wraps that state in `Arc<AsyncMutex<_>>`, and returns an `FsWatchManager` containing all three shared fields.

**Call relations**: This helper is called by `FsWatchManager::new` after backend selection and by `tests::manager_with_noop_watcher` to create a deterministic manager around `FileWatcher::noop()`.

*Call graph*: called by 1 (manager_with_noop_watcher); 3 external calls (new, new, default).


##### `FsWatchManager::watch`  (lines 76–144)

```
async fn watch(
        &self,
        connection_id: ConnectionId,
        params: FsWatchParams,
    ) -> Result<FsWatchResponse, JSONRPCErrorError>
```

**Purpose**: Registers a new watch for one connection/watch-id pair, starts a background forwarding task, and returns the watched path in an `FsWatchResponse`. It enforces that a connection cannot reuse the same `watch_id` for multiple active watches.

**Data flow**: Inputs are `connection_id` and `FsWatchParams { watch_id, path }`. The method derives a `WatchKey`, clones the outgoing sender, creates a subscriber/receiver pair from `file_watcher`, registers one non-recursive `WatchPath` for `params.path`, and creates a termination oneshot channel. Under the async mutex it inserts a `WatchEntry` containing the termination sender plus the subscriber and registration handles; if the key already exists it returns `Err(invalid_request("watchId already exists: ..."))`. After insertion it spawns a Tokio task that wraps the receiver in `DebouncedWatchReceiver`, waits on either termination or the next debounced event, converts event-relative paths into absolute paths by joining them to the original watch root, sorts them, and sends `ServerNotification::FsChanged(FsChangedNotification { watch_id, changed_paths })` to the specific connection when the list is non-empty. The method itself returns `Ok(FsWatchResponse { path: params.path })`.

**Call relations**: This is invoked by the server's filesystem-watch request path. It is the central coordinator in this file: it allocates watcher resources, records ownership in `state`, and delegates asynchronous delivery to the spawned task so request handling can return immediately after successful registration.

*Call graph*: calls 2 internal fn (invalid_request, new); called by 1 (watch); 7 external calls (FsChanged, format!, channel, pin!, select!, spawn, vec!).


##### `FsWatchManager::unwatch`  (lines 146–164)

```
async fn unwatch(
        &self,
        connection_id: ConnectionId,
        params: FsUnwatchParams,
    ) -> Result<FsUnwatchResponse, JSONRPCErrorError>
```

**Purpose**: Stops a previously registered watch owned by the requesting connection and waits until its forwarding task has ceased before replying. If the watch ID does not belong to that connection, it behaves as a no-op success.

**Data flow**: It takes `connection_id` and `FsUnwatchParams { watch_id }`, rebuilds the corresponding `WatchKey`, and removes any matching `WatchEntry` from `state.entries`. When an entry exists, it creates a `(done_tx, done_rx)` oneshot pair, sends `done_tx` through the stored `terminate_tx`, and awaits `done_rx`; because the spawned watch task drops the received sender when it exits, this await ensures no later notifications are emitted after unwatch completion. It always returns `Ok(FsUnwatchResponse {})`.

**Call relations**: This is called by the server's unwatch request path. It complements `FsWatchManager::watch`: instead of touching the watcher backend directly, it removes the ownership record and signals the background task to stop, using the oneshot handshake specifically to serialize shutdown relative to the response.

*Call graph*: called by 1 (unwatch); 1 external calls (channel).


##### `FsWatchManager::connection_closed`  (lines 166–172)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Bulk-cleans all watches associated with a disconnected client connection. Its job is ownership-based teardown rather than protocol response generation.

**Data flow**: It accepts a `ConnectionId`, locks `state`, and removes every `entries` item whose `WatchKey.connection_id` matches by using `extract_if(...).count()`. The return value is `()`, and cleanup happens through dropping the removed `WatchEntry` values and their contained watcher resources.

**Call relations**: This is invoked by connection-lifecycle code when a client disconnects. Unlike `unwatch`, it does not wait for per-watch task acknowledgements because there is no client response ordering to preserve; it simply prunes all state for that connection.

*Call graph*: called by 1 (connection_closed).


##### `tests::absolute_path`  (lines 184–191)

```
fn absolute_path(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts a `PathBuf` into `AbsolutePathBuf` for test inputs while asserting that the path is already absolute. It gives tests a concise way to satisfy the protocol type's invariant.

**Data flow**: It takes a `PathBuf`, asserts `path.is_absolute()`, then calls `AbsolutePathBuf::try_from(path)` and unwraps with `expect`. It returns the validated `AbsolutePathBuf`.

**Call relations**: This helper is used by the watch-related tests to prepare `FsWatchParams.path` values from temporary-directory paths before invoking `FsWatchManager::watch`.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (assert!).


##### `tests::manager_with_noop_watcher`  (lines 193–203)

```
fn manager_with_noop_watcher() -> FsWatchManager
```

**Purpose**: Creates a test `FsWatchManager` wired to a no-op watcher and a buffered outgoing channel so tests can exercise registration logic without depending on OS filesystem notifications. It isolates state-management behavior from watcher backend behavior.

**Data flow**: It creates a Tokio mpsc channel with capacity 1, constructs an `OutgoingMessageSender` from the sender plus `AnalyticsEventsClient::disabled()`, wraps it in `Arc`, pairs it with `Arc::new(FileWatcher::noop())`, and passes both into `FsWatchManager::new_with_file_watcher`. It returns the resulting manager.

**Call relations**: This helper is called by all tests in the module as the common fixture constructor, ensuring they all run against the same inert watcher setup.

*Call graph*: calls 4 internal fn (disabled, new_with_file_watcher, new, noop); 2 external calls (new, channel).


##### `tests::watch_uses_client_id_and_tracks_the_owner_scoped_entry`  (lines 206–235)

```
async fn watch_uses_client_id_and_tracks_the_owner_scoped_entry()
```

**Purpose**: Verifies that a successful watch stores state under a key combining the caller's `ConnectionId` and the supplied `watch_id`, and that the response echoes the watched path. It checks the core ownership model of the manager.

**Data flow**: The test creates a temporary file, converts its path with `absolute_path`, builds a manager via `manager_with_noop_watcher`, calls `watch` for `ConnectionId(1)`, then inspects `manager.state.lock().await.entries.keys()` and compares the collected set against the expected single `WatchKey`. It also asserts `response.path == path`.

**Call relations**: This test drives `FsWatchManager::watch` directly and then reads internal state to confirm the insertion behavior that later `unwatch` and `connection_closed` rely on.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert_eq!, write).


##### `tests::unwatch_is_scoped_to_the_connection_that_created_the_watch`  (lines 238–280)

```
async fn unwatch_is_scoped_to_the_connection_that_created_the_watch()
```

**Purpose**: Checks that unwatch requests only affect watches owned by the same connection and that a foreign connection cannot remove another client's watch. It also confirms that the rightful owner can remove it successfully.

**Data flow**: The test creates a watched file and manager, registers one watch under `ConnectionId(1)`, builds the expected `WatchKey`, calls `unwatch` first with `ConnectionId(2)` and asserts the entry still exists, then calls `unwatch` with `ConnectionId(1)` and asserts the entry has been removed.

**Call relations**: It exercises the interaction between `FsWatchManager::watch` and `FsWatchManager::unwatch`, specifically validating the `WatchKey { connection_id, watch_id }` scoping rule encoded in both methods.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert!, write).


##### `tests::watch_rejects_duplicate_id_for_the_same_connection`  (lines 283–315)

```
async fn watch_rejects_duplicate_id_for_the_same_connection()
```

**Purpose**: Ensures that a connection cannot register two active watches with the same `watch_id`, even if the paths differ. This protects the per-connection identifier namespace from ambiguity.

**Data flow**: The test creates two files, registers the first under `ConnectionId(1)` with `watch_id = "watch-head"`, then attempts a second `watch` on a different path but with the same connection and watch ID. It captures the error, asserts the message equals `"watchId already exists: watch-head"`, and confirms the manager still contains exactly one entry.

**Call relations**: This test targets the duplicate-key branch in `FsWatchManager::watch`, proving that the occupied-entry check returns `invalid_request` instead of overwriting existing state.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert_eq!, write).


##### `tests::connection_closed_removes_only_that_connections_watches`  (lines 318–376)

```
async fn connection_closed_removes_only_that_connections_watches()
```

**Purpose**: Verifies that connection teardown removes all watches for one connection while leaving other connections' watches intact. It checks bulk cleanup semantics rather than single-watch removal.

**Data flow**: The test creates three files, registers two watches for `ConnectionId(1)` and one for `ConnectionId(2)`, invokes `connection_closed(ConnectionId(1))`, then inspects the remaining `entries` keys and asserts that only the `ConnectionId(2)` watch remains. It also asserts the first watch response still echoed the original absolute path.

**Call relations**: This test drives `FsWatchManager::watch` repeatedly and then `FsWatchManager::connection_closed`, validating that the latter filters by `connection_id` only and does not disturb unrelated watches.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert_eq!, write).


### `app-server/src/request_processors/fs_processor.rs`

`io_transport` · `request handling and connection teardown`

This file defines `FsRequestProcessor`, a small adapter around two dependencies: an `EnvironmentManager` used to obtain the local `ExecutorFileSystem`, and an `FsWatchManager` used for long-lived directory/file watches tied to a client connection. Every mutating or reading RPC first resolves the local filesystem through `file_system()`, which fails with `internal_error("local filesystem is not configured")` if no local environment exists.

The request methods are intentionally direct. Paths from protocol params are converted from absolute filesystem paths into `PathUri` values with `PathUri::from_abs_path`, then passed to the executor filesystem with `sandbox` set to `None`. `read_file` base64-encodes raw bytes into `FsReadFileResponse.data_base64`; `write_file` performs the inverse decode and rejects malformed base64 as `invalid_request`. Directory creation and removal supply default options when the client omits them: `recursive` defaults to `true`, and removal also defaults `force` to `true`. Metadata and directory listing responses are projected into protocol-specific structs rather than exposing executor-native types.

Watch operations do one extra check: they call `file_system()` only to ensure local filesystem support exists, then delegate watch registration/removal to `FsWatchManager`. Connection teardown is also forwarded so all watches for that connection can be cleaned up. The standalone `map_fs_error` function centralizes error classification, treating `io::ErrorKind::InvalidInput` as a client mistake and all other I/O failures as internal server errors.

#### Function details

##### `FsRequestProcessor::new`  (lines 43–51)

```
fn new(
        environment_manager: Arc<EnvironmentManager>,
        fs_watch_manager: FsWatchManager,
    ) -> Self
```

**Purpose**: Builds the filesystem request processor from the environment and watch-management services it needs.

**Data flow**: Takes an `Arc<EnvironmentManager>` and an `FsWatchManager`, stores them in the struct, and returns the new `FsRequestProcessor`.

**Call relations**: Created during processor wiring so later filesystem RPCs and connection-close events can share the same managers.

*Call graph*: called by 1 (new).


##### `FsRequestProcessor::file_system`  (lines 53–58)

```
fn file_system(&self) -> Result<Arc<dyn ExecutorFileSystem>, JSONRPCErrorError>
```

**Purpose**: Resolves the local executor filesystem from the current environment configuration and rejects requests when no local environment exists.

**Data flow**: Reads `self.environment_manager.try_local_environment()`, maps the environment to `environment.get_filesystem()`, and returns `Arc<dyn ExecutorFileSystem>` on success or `internal_error("local filesystem is not configured")` on absence.

**Call relations**: All concrete filesystem RPCs call this first, and `watch`/`unwatch` use it as a capability check before delegating to the watch manager.

*Call graph*: called by 9 (copy, create_directory, get_metadata, read_directory, read_file, remove, unwatch, watch, write_file).


##### `FsRequestProcessor::connection_closed`  (lines 60–62)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Releases any active filesystem watches associated with a disconnected client connection.

**Data flow**: Accepts a `ConnectionId`, forwards it to `self.fs_watch_manager.connection_closed(connection_id).await`, and returns no value.

**Call relations**: It is invoked by the server's connection-close handling path, not by a client RPC, so watch state is cleaned up even if the client never explicitly unwatches.

*Call graph*: calls 1 internal fn (connection_closed); called by 1 (connection_closed).


##### `FsRequestProcessor::read_file`  (lines 64–77)

```
async fn read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Reads a file from the local filesystem and returns its contents as base64 text.

**Data flow**: Consumes `FsReadFileParams.path`, converts it to `PathUri`, reads bytes via `ExecutorFileSystem::read_file(..., None)`, maps any `io::Error` through `map_fs_error`, base64-encodes the bytes with `STANDARD.encode`, and returns `FsReadFileResponse { data_base64 }`.

**Call relations**: Called from `handle_initialized_client_request` for the `fs/readFile` RPC; it depends on `file_system()` to ensure local filesystem access is available.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::write_file`  (lines 79–94)

```
async fn write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Decodes base64 file contents from the client and writes them to the local filesystem.

**Data flow**: Reads `FsWriteFileParams.data_base64` and `path`, decodes the base64 payload into bytes or returns `invalid_request` if decoding fails, converts the path to `PathUri`, writes the bytes with `ExecutorFileSystem::write_file(..., None)`, maps filesystem errors with `map_fs_error`, and returns an empty `FsWriteFileResponse`.

**Call relations**: Dispatched from `handle_initialized_client_request`; it uses `file_system()` and performs its own protocol-level validation before touching disk.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::create_directory`  (lines 96–112)

```
async fn create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Creates a directory on the local filesystem, defaulting to recursive creation when the client does not specify otherwise.

**Data flow**: Consumes `FsCreateDirectoryParams.path` and optional `recursive`, converts the path to `PathUri`, builds `CreateDirectoryOptions { recursive: params.recursive.unwrap_or(true) }`, invokes `create_directory(..., None)`, maps errors with `map_fs_error`, and returns `FsCreateDirectoryResponse {}`.

**Call relations**: Reached from initialized request dispatch for directory-creation RPCs and relies on `file_system()` for local environment access.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::get_metadata`  (lines 114–131)

```
async fn get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Fetches basic file metadata and projects it into the protocol response shape.

**Data flow**: Reads `FsGetMetadataParams.path`, converts it to `PathUri`, calls `get_metadata(..., None)`, maps errors with `map_fs_error`, then copies `is_directory`, `is_file`, `is_symlink`, `created_at_ms`, and `modified_at_ms` into `FsGetMetadataResponse`.

**Call relations**: Called by the initialized request dispatcher for metadata queries; it is a straightforward adapter over the executor filesystem.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::read_directory`  (lines 133–153)

```
async fn read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Lists directory entries and converts executor-native entry records into protocol `FsReadDirectoryEntry` values.

**Data flow**: Consumes `FsReadDirectoryParams.path`, converts it to `PathUri`, calls `read_directory(..., None)`, maps errors with `map_fs_error`, transforms each returned entry into `FsReadDirectoryEntry { file_name, is_directory, is_file }`, collects them into a vector, and returns `FsReadDirectoryResponse { entries }`.

**Call relations**: Invoked from initialized request handling for directory listing RPCs and depends on `file_system()` for access to the local filesystem.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::remove`  (lines 155–172)

```
async fn remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Deletes a file or directory tree from the local filesystem with permissive defaults for recursive and forced removal.

**Data flow**: Reads `FsRemoveParams.path`, optional `recursive`, and optional `force`; converts the path to `PathUri`; builds `RemoveOptions { recursive: unwrap_or(true), force: unwrap_or(true) }`; calls `remove(..., None)`; maps errors with `map_fs_error`; and returns `FsRemoveResponse {}`.

**Call relations**: Dispatched from `handle_initialized_client_request` for remove RPCs; it uses `file_system()` and central error mapping.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::copy`  (lines 174–192)

```
async fn copy(
        &self,
        params: FsCopyParams,
    ) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Copies a file or directory from one absolute path to another using the executor filesystem.

**Data flow**: Consumes `FsCopyParams.source_path`, `destination_path`, and `recursive`; converts both paths to `PathUri`; builds `CopyOptions { recursive: params.recursive }`; invokes `copy(..., None)`; maps errors with `map_fs_error`; and returns `FsCopyResponse {}`.

**Call relations**: Called by initialized request dispatch for copy RPCs and uses `file_system()` to obtain the local filesystem implementation.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::watch`  (lines 194–201)

```
async fn watch(
        &self,
        connection_id: ConnectionId,
        params: FsWatchParams,
    ) -> Result<FsWatchResponse, JSONRPCErrorError>
```

**Purpose**: Registers a filesystem watch for a specific connection after confirming that local filesystem support exists.

**Data flow**: Accepts a `ConnectionId` and `FsWatchParams`, calls `self.file_system()?` purely as a capability check, then awaits `self.fs_watch_manager.watch(connection_id, params)` and returns its `FsWatchResponse` or propagated JSON-RPC error.

**Call relations**: Reached from `handle_initialized_client_request` for watch RPCs; after the local-environment check it delegates the long-lived watch bookkeeping to `FsWatchManager`.

*Call graph*: calls 2 internal fn (watch, file_system); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::unwatch`  (lines 203–210)

```
async fn unwatch(
        &self,
        connection_id: ConnectionId,
        params: FsUnwatchParams,
    ) -> Result<FsUnwatchResponse, JSONRPCErrorError>
```

**Purpose**: Removes a previously registered filesystem watch for a specific connection.

**Data flow**: Accepts a `ConnectionId` and `FsUnwatchParams`, verifies local filesystem availability via `self.file_system()?`, then awaits `self.fs_watch_manager.unwatch(connection_id, params)` and returns its `FsUnwatchResponse`.

**Call relations**: Called from initialized request dispatch for unwatch RPCs; like `watch`, it uses `file_system()` as a guard and delegates actual watch-state mutation to `FsWatchManager`.

*Call graph*: calls 2 internal fn (unwatch, file_system); called by 1 (handle_initialized_client_request).


##### `map_fs_error`  (lines 213–219)

```
fn map_fs_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Normalizes raw `io::Error` values into JSON-RPC errors with client-vs-server classification.

**Data flow**: Takes an `io::Error`, inspects `err.kind()`, converts `InvalidInput` into `invalid_request(err.to_string())`, and converts every other kind into `internal_error(err.to_string())`.

**Call relations**: All direct filesystem RPC methods use this helper after executor filesystem calls so they present consistent JSON-RPC error semantics.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (kind, to_string).


### `app-server/src/request_processors/feedback_processor.rs`

`domain_logic` · `request handling`

This processor is the server-side bridge between `FeedbackUploadParams` and the lower-level `CodexFeedback` uploader. Its state is a bundle of shared services: `AuthManager` for cached identity tags, `ThreadManager` for live thread lookup and subtree enumeration, `Config` for feature flags and filesystem roots, plus optional `LogDbLayer` and `StateDbHandle` for flushing and querying persisted logs. The main path first rejects requests when `config.feedback_enabled` is false, then parses the optional `thread_id` string into a `ThreadId`, returning `invalid_request` on malformed IDs.

When log inclusion is requested, it flushes the log DB, snapshots the feedback state for the selected conversation, and tries to gather a bounded set of related thread IDs. It prefers `thread_manager.list_agent_subtree_thread_ids`, but falls back to persisted descendant lookup in the state DB for both open and closed spawn-edge statuses. To keep uploads bounded, it preserves the root thread and truncates descendants to the most recent ones using UUIDv7 lexicographic ordering, capped by `MAX_FEEDBACK_TREE_THREADS`. It then optionally queries SQLite-backed feedback logs for those threads.

Attachment assembly deduplicates paths with a `HashSet`, adding rollout files resolved from live threads or archived state DB records, guardian trunk rollout files under an auto-generated filename, the Windows sandbox log when present, caller-supplied extra files, and an async doctor report attachment whose tags are merged only if the caller did not already provide the same keys. The actual upload runs inside `spawn_blocking`, passing `FeedbackUploadOptions` with tags, attachments, session source, and optional log overrides. Errors from thread parsing, join failures, DB lookups, and upload failures are converted into JSON-RPC errors; missing optional artifacts are tolerated with warnings rather than failing the request.

#### Function details

##### `FeedbackRequestProcessor::new`  (lines 18–34)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        config: Arc<Config>,
        feedback: CodexFeedback,
        log_db: Option<LogDbLayer>,
        st
```

**Purpose**: Constructs a `FeedbackRequestProcessor` by storing the shared auth, thread, config, feedback, and optional database handles it will use during uploads.

**Data flow**: Takes `Arc<AuthManager>`, `Arc<ThreadManager>`, `Arc<Config>`, a `CodexFeedback`, and optional `LogDbLayer`/`StateDbHandle` values; places them unchanged into the struct fields; returns the initialized processor.

**Call relations**: It is invoked by the higher-level request-processor wiring during server setup so later feedback RPCs can reuse the same shared services.

*Call graph*: called by 1 (new).


##### `FeedbackRequestProcessor::feedback_upload`  (lines 36–43)

```
async fn feedback_upload(
        &self,
        params: FeedbackUploadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Exposes the feedback upload RPC entrypoint and wraps the typed response into the generic client payload form expected by the dispatcher.

**Data flow**: Accepts `FeedbackUploadParams`, awaits `self.upload_feedback_response(params)`, converts the resulting `FeedbackUploadResponse` into `ClientResponsePayload`, and returns it as `Some(...)` or propagates the JSON-RPC error.

**Call relations**: This is called from `handle_initialized_client_request` when the client sends the feedback upload method; it delegates all substantive work to `upload_feedback_response`.

*Call graph*: calls 1 internal fn (upload_feedback_response); called by 1 (handle_initialized_client_request).


##### `FeedbackRequestProcessor::upload_feedback_response`  (lines 45–271)

```
async fn upload_feedback_response(
        &self,
        params: FeedbackUploadParams,
    ) -> Result<FeedbackUploadResponse, JSONRPCErrorError>
```

**Purpose**: Validates feedback settings and thread identity, gathers optional logs and attachments from live threads, persisted state, diagnostics, and platform-specific sources, then performs the blocking feedback upload.

**Data flow**: Consumes `FeedbackUploadParams` fields such as classification, reason, optional thread ID, log flags, extra files, and tags. It reads `config.feedback_enabled`, cached auth IDs, a feedback snapshot from `self.feedback`, optional `log_db` and `state_db`, thread subtree information from `thread_manager`, rollout paths via `resolve_rollout_path`, guardian rollout paths from live conversations, doctor-report attachments, and the session source. It transforms these into bounded thread lists, optional SQLite log overrides, deduplicated `FeedbackAttachmentPath` values, merged upload tags, and finally a `FeedbackUploadOptions` passed to `snapshot.upload_feedback` inside `spawn_blocking`. On success it returns `FeedbackUploadResponse { thread_id }`; on validation, join, or upload failure it returns a JSON-RPC error, while non-fatal lookup failures are logged as warnings.

**Call relations**: It is only reached through `feedback_upload`. Along the way it calls `doctor_feedback_report`, `resolve_rollout_path`, `auto_review_rollout_filename`, and `windows_sandbox_log_attachment` to enrich the upload, and it relies on thread/state services when `include_logs` is true.

*Call graph*: calls 6 internal fn (doctor_feedback_report, resolve_rollout_path, auto_review_rollout_filename, windows_sandbox_log_attachment, snapshot, from_string); called by 1 (feedback_upload); 8 external calls (new, new, with_capacity, format!, spawn_blocking, info!, vec!, warn!).


##### `FeedbackRequestProcessor::resolve_rollout_path`  (lines 273–292)

```
async fn resolve_rollout_path(
        &self,
        conversation_id: ThreadId,
        state_db_ctx: Option<&StateDbHandle>,
    ) -> Option<PathBuf>
```

**Purpose**: Finds the rollout log path for a thread, preferring the live in-memory thread object and falling back to the persisted state database.

**Data flow**: Takes a `ThreadId` and optional `&StateDbHandle`. It first reads `thread_manager.get_thread(conversation_id)` and, if successful, returns `conversation.rollout_path()`. If that fails or yields no path, it uses `state_db_ctx.find_rollout_path_by_id(conversation_id, None)` and returns the resulting `Option<PathBuf>`, logging a warning and returning `None` on DB errors.

**Call relations**: This helper is called from `upload_feedback_response` for each selected feedback thread so attachment collection can include rollout files even for archived or otherwise unavailable live threads.

*Call graph*: called by 1 (upload_feedback_response).


##### `auto_review_rollout_filename`  (lines 295–297)

```
fn auto_review_rollout_filename(thread_id: ThreadId) -> String
```

**Purpose**: Builds the attachment filename used when a guardian trunk rollout is attached as an auto-review artifact.

**Data flow**: Accepts a `ThreadId`, formats it into the string `auto-review-rollout-{thread_id}.jsonl`, and returns that `String`.

**Call relations**: It is used by `upload_feedback_response` only when a conversation exposes a guardian trunk rollout path that should be attached under a stable, descriptive filename.

*Call graph*: called by 1 (upload_feedback_response); 1 external calls (format!).


##### `windows_sandbox_log_attachment`  (lines 311–313)

```
fn windows_sandbox_log_attachment(_codex_home: &Path) -> Option<FeedbackAttachmentPath>
```

**Purpose**: On Windows, returns the current sandbox log file as a feedback attachment with a fixed attachment filename; on non-Windows builds it always yields `None`.

**Data flow**: The Windows variant reads `codex_home`, computes the current sandbox log path via `current_log_file_path_for_codex_home`, checks `is_file()`, and if present returns `Some(FeedbackAttachmentPath { path, attachment_filename_override: Some(WINDOWS_SANDBOX_LOG_ATTACHMENT_FILENAME.to_string()) })`. The non-Windows variant ignores its argument and returns `None`.

**Call relations**: The upload path calls this while assembling attachments when logs are requested, and the Windows-only unit test exercises it against a temporary sandbox directory.

*Call graph*: called by 2 (upload_feedback_response, windows_sandbox_log_attachment_uses_current_log); 1 external calls (current_log_file_path_for_codex_home).


##### `tests::windows_sandbox_log_attachment_uses_current_log`  (lines 321–339)

```
fn windows_sandbox_log_attachment_uses_current_log()
```

**Purpose**: Verifies that the Windows helper points at the current sandbox log file and applies the expected attachment filename override.

**Data flow**: Creates a temporary Codex home, derives the sandbox directory and current log path, creates the directory, writes a test log file, calls `windows_sandbox_log_attachment`, maps the result to `(path, attachment_filename_override)`, and asserts equality with the expected tuple.

**Call relations**: This test directly targets `windows_sandbox_log_attachment` under Windows test builds to lock in the helper's path-selection behavior.

*Call graph*: calls 1 internal fn (windows_sandbox_log_attachment); 6 external calls (assert_eq!, current_log_file_path_for_codex_home, sandbox_dir, create_dir_all, write, tempdir).


### `app-server/src/request_processors/git_processor.rs`

`domain_logic` · `request handling`

This file is intentionally minimal: `GitRequestProcessor` is a zero-state processor whose only job is to adapt a protocol request into the existing async `git_diff_to_remote` helper and package the result into protocol response types. The public RPC-facing method accepts `GitDiffToRemoteParams`, extracts the `cwd`, and delegates to a private helper that performs the actual lookup.

The private `git_diff_to_origin` method awaits `git_diff_to_remote(&cwd)`, which returns an optional value rather than a rich error. When a diff is available, it maps the helper's output into `GitDiffToRemoteResponse { sha, diff }`. When the helper returns `None`, the processor treats that as a client-visible invalid request and includes the `cwd` in the error message, making failures concrete for callers rather than silently returning an empty payload.

Because the processor has no internal state, construction is trivial and cloning is effectively free. The design choice here is to keep Git-specific behavior out of the dispatcher while also avoiding any extra orchestration or caching in the processor itself.

#### Function details

##### `GitRequestProcessor::new`  (lines 7–9)

```
fn new() -> Self
```

**Purpose**: Constructs the stateless Git request processor.

**Data flow**: Takes no arguments and returns `GitRequestProcessor` as `Self`.

**Call relations**: It is instantiated during request-processor setup so the dispatcher can route Git RPCs to it.

*Call graph*: called by 1 (new).


##### `GitRequestProcessor::git_diff_to_remote`  (lines 11–18)

```
async fn git_diff_to_remote(
        &self,
        params: GitDiffToRemoteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the JSON-RPC entrypoint for computing a diff against the repository's remote branch.

**Data flow**: Consumes `GitDiffToRemoteParams`, extracts `params.cwd`, awaits `self.git_diff_to_origin(...)`, converts the typed response into `ClientResponsePayload`, and wraps it in `Some(...)`.

**Call relations**: This method is called by `handle_initialized_client_request` for the Git diff RPC and delegates all substantive work to `git_diff_to_origin`.

*Call graph*: calls 1 internal fn (git_diff_to_origin); called by 1 (handle_initialized_client_request).


##### `GitRequestProcessor::git_diff_to_origin`  (lines 20–35)

```
async fn git_diff_to_origin(
        &self,
        cwd: PathBuf,
    ) -> Result<GitDiffToRemoteResponse, JSONRPCErrorError>
```

**Purpose**: Runs the underlying diff computation for a given working directory and converts the optional result into either a concrete response or an `invalid_request` error.

**Data flow**: Accepts a `PathBuf` `cwd`, awaits `git_diff_to_remote(&cwd)`, maps a present result into `GitDiffToRemoteResponse { sha, diff }`, and if the helper returns `None` constructs `invalid_request(format!(...cwd...))`.

**Call relations**: It is only invoked by `git_diff_to_remote`, acting as the internal adapter between the lower-level Git helper's optional return and the JSON-RPC error model.

*Call graph*: called by 1 (git_diff_to_remote).


### `app-server/src/request_processors/marketplace_processor.rs`

`domain_logic` · `request handling`

This processor is a compact adapter around marketplace lifecycle operations. It stores the current `Config` for access to `codex_home`, a `ConfigManager` for reloading configuration snapshots, and a `ThreadManager` so it can reach the shared plugins manager during upgrades. The three public RPC methods are thin wrappers that call private typed-response helpers and then convert those responses into `ClientResponsePayload`.

`marketplace_add_inner` and `marketplace_remove_inner` are direct async bridges to core marketplace functions. Both pass `config.codex_home` as the root of marketplace state, translate protocol params into the corresponding core request structs, and map domain-specific error enums into JSON-RPC `invalid_request` versus `internal_error` depending on whether the failure is attributable to caller input or server-side execution.

`marketplace_upgrade_response_inner` is slightly richer. It first reloads the latest config so upgrades use current plugin configuration rather than the processor's startup snapshot. It then extracts the plugins manager from `thread_manager`, computes `plugins_input` from the reloaded config, and runs `upgrade_configured_marketplaces_for_config` inside `tokio::task::spawn_blocking`, since the upgrade path is synchronous and potentially expensive. The returned outcome is projected into `MarketplaceUpgradeResponse`, preserving selected marketplaces, upgraded roots, and per-marketplace error messages. Join failures become internal errors, while plugin-manager validation failures are surfaced as invalid requests. The separate `load_latest_config` helper centralizes config reload error mapping.

#### Function details

##### `MarketplaceRequestProcessor::new`  (lines 11–21)

```
fn new(
        config: Arc<Config>,
        config_manager: ConfigManager,
        thread_manager: Arc<ThreadManager>,
    ) -> Self
```

**Purpose**: Constructs the marketplace processor with access to config, config reloads, and the shared thread/plugin infrastructure.

**Data flow**: Takes `Arc<Config>`, `ConfigManager`, and `Arc<ThreadManager>`, stores them in the struct, and returns the new processor.

**Call relations**: Instantiated during request-processor setup so marketplace RPCs can later use the same config and plugin-management services.

*Call graph*: called by 1 (new).


##### `MarketplaceRequestProcessor::marketplace_add`  (lines 23–30)

```
async fn marketplace_add(
        &self,
        params: MarketplaceAddParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the marketplace-add RPC and wraps the typed add result into the generic client response payload.

**Data flow**: Consumes `MarketplaceAddParams`, awaits `self.marketplace_add_inner(params)`, converts the resulting `MarketplaceAddResponse` into `ClientResponsePayload`, and returns it as `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates all actual add logic to `marketplace_add_inner`.

*Call graph*: calls 1 internal fn (marketplace_add_inner); called by 1 (handle_initialized_client_request).


##### `MarketplaceRequestProcessor::marketplace_remove`  (lines 32–39)

```
async fn marketplace_remove(
        &self,
        params: MarketplaceRemoveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the marketplace-remove RPC and converts the typed removal result into the dispatcher's payload form.

**Data flow**: Consumes `MarketplaceRemoveParams`, awaits `self.marketplace_remove_inner(params)`, converts the `MarketplaceRemoveResponse` into `ClientResponsePayload`, and wraps it in `Some(...)`.

**Call relations**: Reached from initialized request dispatch and delegates the concrete removal work to `marketplace_remove_inner`.

*Call graph*: calls 1 internal fn (marketplace_remove_inner); called by 1 (handle_initialized_client_request).


##### `MarketplaceRequestProcessor::marketplace_upgrade`  (lines 41–48)

```
async fn marketplace_upgrade(
        &self,
        params: MarketplaceUpgradeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the marketplace-upgrade RPC and returns the upgrade summary as a generic client payload.

**Data flow**: Consumes `MarketplaceUpgradeParams`, awaits `self.marketplace_upgrade_response_inner(params)`, converts the resulting `MarketplaceUpgradeResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates the substantive upgrade flow to `marketplace_upgrade_response_inner`.

*Call graph*: calls 1 internal fn (marketplace_upgrade_response_inner); called by 1 (handle_initialized_client_request).


##### `MarketplaceRequestProcessor::marketplace_remove_inner`  (lines 50–69)

```
async fn marketplace_remove_inner(
        &self,
        params: MarketplaceRemoveParams,
    ) -> Result<MarketplaceRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Removes a marketplace rooted under the current Codex home and translates core removal outcomes into protocol response fields.

**Data flow**: Reads `self.config.codex_home`, builds `CoreMarketplaceRemoveRequest { marketplace_name }` from `MarketplaceRemoveParams`, awaits `remove_marketplace(...)`, maps a successful outcome into `MarketplaceRemoveResponse { marketplace_name, installed_root: removed_installed_root }`, and converts `MarketplaceRemoveError::InvalidRequest` to `invalid_request` and `MarketplaceRemoveError::Internal` to `internal_error`.

**Call relations**: This helper is only called by `marketplace_remove`, acting as the typed bridge to the core marketplace removal API.

*Call graph*: called by 1 (marketplace_remove).


##### `MarketplaceRequestProcessor::marketplace_upgrade_response_inner`  (lines 71–102)

```
async fn marketplace_upgrade_response_inner(
        &self,
        params: MarketplaceUpgradeParams,
    ) -> Result<MarketplaceUpgradeResponse, JSONRPCErrorError>
```

**Purpose**: Reloads config and upgrades configured marketplaces through the plugins manager, returning both successful upgrades and per-marketplace failures.

**Data flow**: Consumes `MarketplaceUpgradeParams`, reloads `Config` via `load_latest_config(None)`, reads the plugins manager from `thread_manager`, extracts `marketplace_name` and `plugins_input`, runs `plugins_manager.upgrade_configured_marketplaces_for_config(&plugins_input, marketplace_name.as_deref())` inside `spawn_blocking`, maps join failures to `internal_error`, maps plugin-manager validation failures to `invalid_request`, and returns `MarketplaceUpgradeResponse` containing selected marketplaces, upgraded roots, and converted `MarketplaceUpgradeErrorInfo` entries.

**Call relations**: It is invoked by `marketplace_upgrade` because upgrades need fresh config and a blocking plugin-manager call that should not run on the async executor.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (marketplace_upgrade); 1 external calls (spawn_blocking).


##### `MarketplaceRequestProcessor::marketplace_add_inner`  (lines 104–126)

```
async fn marketplace_add_inner(
        &self,
        params: MarketplaceAddParams,
    ) -> Result<MarketplaceAddResponse, JSONRPCErrorError>
```

**Purpose**: Adds a marketplace under Codex home from the requested source/ref/sparse-path configuration and returns installation details.

**Data flow**: Reads `self.config.codex_home`, builds `MarketplaceAddRequest { source, ref_name, sparse_paths: unwrap_or_default() }` from `MarketplaceAddParams`, awaits `add_marketplace_to_codex_home(...)`, maps success into `MarketplaceAddResponse { marketplace_name, installed_root, already_added }`, and converts `MarketplaceAddError` variants into either `invalid_request` or `internal_error`.

**Call relations**: This helper is only called by `marketplace_add`, encapsulating the direct bridge to the core add-marketplace API.

*Call graph*: called by 1 (marketplace_add).


##### `MarketplaceRequestProcessor::load_latest_config`  (lines 128–136)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the latest effective configuration and converts reload failures into JSON-RPC internal errors.

**Data flow**: Accepts an optional fallback `PathBuf`, awaits `self.config_manager.load_latest_config(fallback_cwd)`, returns the resulting `Config`, or maps any error to `internal_error(format!("failed to reload config: {err}"))`.

**Call relations**: Used by `marketplace_upgrade_response_inner` so upgrades operate on current plugin configuration rather than stale startup state.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (marketplace_upgrade_response_inner).


### `app-server/src/request_processors/plugins.rs`

`domain_logic` · `request handling / plugin cache refresh / post-install follow-up`

This is the largest request processor in the set and acts as the feature layer for local marketplaces, remote plugin catalogs, remote installed-plugin state, and plugin sharing. `PluginRequestProcessor` combines auth, thread and MCP infrastructure, outbound notifications, analytics, config reloads, and a workspace settings cache. Around it sits a substantial helper layer that converts between core plugin models and protocol structs, maps remote sharing enums in both directions, computes visible marketplaces, and normalizes remote/catalog/install errors into JSON-RPC responses.

The list/read/install flows all begin by reloading config and checking feature gates. `plugin_list_response` and `plugin_installed_response` both short-circuit to empty responses when plugins are disabled globally or by workspace settings. They then coordinate local marketplace enumeration, optional remote marketplace fetches, background cache refresh tasks, and conflict filtering between local OpenAI-curated plugins and remote global curated plugins. Local marketplace enumeration is pushed into `spawn_blocking` because it uses synchronous plugin-manager APIs; remote catalog fetches are async and degrade gracefully to warnings unless the caller explicitly requested those marketplace kinds.

Read paths support both local and remote plugins. Local reads use `plugins_manager.read_plugin_for_config`, hydrate optional share context from local path mappings and remote share metadata, filter skills by session-source product restrictions, and enrich plugin apps from connector metadata. Remote reads validate remote plugin IDs, fetch remote detail, derive app categories from the remote app manifest, and convert the result into protocol `PluginDetail`.

Install and uninstall paths split between local and remote plugins. Local installs update config through the plugins manager, trigger cache invalidation and MCP refresh, optionally start silent OAuth logins for plugin-declared MCP servers, and compute `apps_needing_auth` by comparing plugin app declarations against accessible connectors. Remote installs first fetch remote detail and bundle download URLs, validate and materialize the bundle locally, notify the backend of installation, refresh remote-installed caches, emit analytics, then perform the same MCP/app follow-up. Sharing RPCs (`save`, `updateTargets`, `list`, `checkout`, `delete`) are guarded by both plugin and plugin-sharing feature flags, validate remote IDs and share-target rules, call the remote plugin service, and clear plugin-related caches after mutations so subsequent list/read calls observe fresh state.

#### Function details

##### `plugin_skills_to_info`  (lines 36–60)

```
fn plugin_skills_to_info(
    skills: &[codex_core::skills::SkillMetadata],
    disabled_skill_paths: &HashSet<AbsolutePathBuf>,
) -> Vec<SkillSummary>
```

**Purpose**: Converts core `SkillMetadata` records into protocol `SkillSummary` values while marking each skill enabled or disabled based on its `skills.md` path.

**Data flow**: Takes a slice of `codex_core::skills::SkillMetadata` and a `HashSet<AbsolutePathBuf>` of disabled skill paths; clones descriptive fields and optional interface data into protocol structs; sets `path` to `Some(skill.path_to_skills_md.clone())`; computes `enabled` as the inverse of membership in `disabled_skill_paths`; returns a `Vec<SkillSummary>`.

**Call relations**: Used by `PluginRequestProcessor::plugin_read_response` when building local plugin detail responses.

*Call graph*: called by 1 (plugin_read_response); 1 external calls (iter).


##### `local_plugin_interface_to_info`  (lines 62–82)

```
fn local_plugin_interface_to_info(interface: PluginManifestInterface) -> PluginInterface
```

**Purpose**: Maps a local plugin manifest interface into the protocol-facing `PluginInterface` shape.

**Data flow**: Consumes `PluginManifestInterface`, copies all descriptive, branding, capability, and prompt fields into `PluginInterface`, and explicitly sets remote-only URL fields like `composer_icon_url`, `logo_url`, and `screenshot_urls` to `None`/empty vectors.

**Call relations**: Called from local plugin summary/detail conversion paths to normalize manifest interface data for API responses.

*Call graph*: 1 external calls (new).


##### `marketplace_plugin_source_to_info`  (lines 84–99)

```
fn marketplace_plugin_source_to_info(source: MarketplacePluginSource) -> PluginSource
```

**Purpose**: Converts a marketplace plugin source from the core enum into the protocol `PluginSource` enum.

**Data flow**: Matches `MarketplacePluginSource`; for `Local { path }` returns `PluginSource::Local { path }`, and for `Git { url, path, ref_name, sha }` returns the corresponding `PluginSource::Git` variant.

**Call relations**: Used by both `convert_configured_marketplace_plugin_to_plugin_summary` and `PluginRequestProcessor::plugin_read_response` when exposing local plugin provenance.

*Call graph*: called by 2 (plugin_read_response, convert_configured_marketplace_plugin_to_plugin_summary).


##### `load_shared_plugin_ids_by_local_path`  (lines 101–112)

```
fn load_shared_plugin_ids_by_local_path(
    config: &Config,
) -> Result<std::collections::BTreeMap<AbsolutePathBuf, String>, JSONRPCErrorError>
```

**Purpose**: Loads the persisted mapping from local plugin paths to remote shared-plugin IDs from the Codex home directory.

**Data flow**: Accepts `&Config`, reads `config.codex_home`, calls `codex_core_plugins::remote::load_plugin_share_remote_ids_by_local_path`, and returns the resulting `BTreeMap<AbsolutePathBuf, String>` or maps failures to `internal_error` with context.

**Call relations**: Shared by plugin list, installed-plugin listing, and local plugin read paths whenever local plugins may need share-context enrichment.

*Call graph*: called by 3 (load_local_installed_and_suggested_plugins, plugin_list_response, plugin_read_response); 1 external calls (load_plugin_share_remote_ids_by_local_path).


##### `share_context_for_source`  (lines 114–133)

```
fn share_context_for_source(
    source: &MarketplacePluginSource,
    shared_plugin_ids_by_local_path: &std::collections::BTreeMap<AbsolutePathBuf, String>,
) -> Option<PluginShareContext>
```

**Purpose**: Builds a minimal local share context for a plugin source when that source is a local path known to correspond to a remote shared plugin.

**Data flow**: Takes a `&MarketplacePluginSource` and the local-path-to-remote-ID map. For `Local { path }`, it looks up the path and, if found, returns `PluginShareContext` populated with `remote_plugin_id` and all other remote-derived fields as `None`. For `Git` sources it returns `None`.

**Call relations**: Used by local plugin summary/detail conversion so local plugins can expose share linkage even before remote share metadata is hydrated.

*Call graph*: called by 2 (plugin_read_response, convert_configured_marketplace_plugin_to_plugin_summary).


##### `convert_configured_marketplace_plugin_to_plugin_summary`  (lines 135–155)

```
fn convert_configured_marketplace_plugin_to_plugin_summary(
    plugin: codex_core_plugins::ConfiguredMarketplacePlugin,
    shared_plugin_ids_by_local_path: &std::collections::BTreeMap<AbsolutePathBu
```

**Purpose**: Transforms a configured marketplace plugin from the core plugins manager into the protocol `PluginSummary` representation.

**Data flow**: Consumes `codex_core_plugins::ConfiguredMarketplacePlugin` plus the local share-ID map; derives `share_context` via `share_context_for_source`, converts the source via `marketplace_plugin_source_to_info`, maps policy enums with `.into()`, converts the optional interface with `local_plugin_interface_to_info`, and returns a fully populated `PluginSummary` with `availability` fixed to `PluginAvailability::Available` and `remote_plugin_id` set to `None`.

**Call relations**: Used by marketplace-listing helpers in both plugin list and installed-plugin responses.

*Call graph*: calls 2 internal fn (marketplace_plugin_source_to_info, share_context_for_source).


##### `remote_installed_plugin_visible_marketplaces`  (lines 157–170)

```
fn remote_installed_plugin_visible_marketplaces(config: &Config) -> Vec<&'static str>
```

**Purpose**: Computes which remote marketplace names should be shown in installed-plugin views based on enabled feature flags.

**Data flow**: Reads `config.features`; conditionally pushes remote global and created-by-me marketplace constants when `Feature::RemotePlugin` is enabled, always includes the workspace marketplace, and conditionally includes shared-with-me marketplace variants when `Feature::PluginSharing` is enabled; returns the assembled `Vec<&'static str>`.

**Call relations**: Called by `PluginRequestProcessor::plugin_installed_response` to decide which remote installed-plugin caches or fetches are relevant.

*Call graph*: called by 1 (plugin_installed_response); 1 external calls (new).


##### `filter_openai_curated_installed_conflicts`  (lines 172–207)

```
fn filter_openai_curated_installed_conflicts(
    marketplaces: &mut Vec<PluginMarketplaceEntry>,
    prefer_remote_curated_conflicts: bool,
)
```

**Purpose**: Removes duplicate installed plugin entries when the same plugin name appears in both local OpenAI-curated marketplaces and the remote global marketplace.

**Data flow**: Mutably borrows a `Vec<PluginMarketplaceEntry>` and a `prefer_remote_curated_conflicts` flag. It computes installed plugin-name sets from local curated marketplaces and the remote global marketplace, intersects them to find conflicts, then retains or removes installed conflicting plugins from either local curated marketplaces or the remote global marketplace depending on the preference flag. Finally it drops any marketplaces left empty.

**Call relations**: Applied by `PluginRequestProcessor::plugin_installed_response` after local and remote installed-plugin data have been merged.

*Call graph*: called by 1 (plugin_installed_response); 1 external calls (is_openai_curated_marketplace_name).


##### `installed_plugin_names`  (lines 209–215)

```
fn installed_plugin_names(plugins: &[PluginSummary]) -> HashSet<String>
```

**Purpose**: Extracts the names of installed plugins from a marketplace plugin list.

**Data flow**: Takes a slice of `PluginSummary`, filters to `plugin.installed`, clones each `plugin.name`, and collects them into a `HashSet<String>`.

**Call relations**: Used internally by `filter_openai_curated_installed_conflicts` to compare installed plugin sets across marketplaces.

*Call graph*: 1 external calls (iter).


##### `remote_plugin_share_discoverability`  (lines 217–231)

```
fn remote_plugin_share_discoverability(
    discoverability: PluginShareDiscoverability,
) -> codex_core_plugins::remote::RemotePluginShareDiscoverability
```

**Purpose**: Maps protocol share discoverability values into the remote-plugin service enum.

**Data flow**: Matches `PluginShareDiscoverability` and returns the corresponding `codex_core_plugins::remote::RemotePluginShareDiscoverability` variant.

**Call relations**: Used when creating new remote plugin shares so client-specified discoverability can be sent to the remote service.


##### `remote_plugin_share_update_discoverability`  (lines 233–244)

```
fn remote_plugin_share_update_discoverability(
    discoverability: PluginShareUpdateDiscoverability,
) -> codex_core_plugins::remote::RemotePluginShareUpdateDiscoverability
```

**Purpose**: Maps the restricted update-time discoverability enum into the remote service's update enum.

**Data flow**: Matches `PluginShareUpdateDiscoverability` and returns the corresponding `RemotePluginShareUpdateDiscoverability` variant.

**Call relations**: Called by `PluginRequestProcessor::plugin_share_update_targets_response` when updating an existing share's visibility.

*Call graph*: called by 1 (plugin_share_update_targets_response).


##### `validate_client_plugin_share_targets`  (lines 246–258)

```
fn validate_client_plugin_share_targets(
    targets: &[PluginShareTarget],
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Rejects share-target lists that include workspace principals, which this API intentionally disallows.

**Data flow**: Takes a slice of `PluginShareTarget`, scans for any target whose `principal_type` is `PluginSharePrincipalType::Workspace`, returns `invalid_request(...)` if found, otherwise returns `Ok(())`.

**Call relations**: Used by both share-save and share-update-targets flows before calling the remote sharing service.

*Call graph*: calls 1 internal fn (invalid_request); called by 2 (plugin_share_save_response, plugin_share_update_targets_response); 1 external calls (iter).


##### `remote_plugin_share_target_role`  (lines 260–271)

```
fn remote_plugin_share_target_role(
    role: PluginShareTargetRole,
) -> codex_core_plugins::remote::RemotePluginShareTargetRole
```

**Purpose**: Converts a protocol share-target role into the remote service role enum.

**Data flow**: Matches `PluginShareTargetRole::{Reader,Editor}` and returns the corresponding remote role variant.

**Call relations**: Used by `remote_plugin_share_targets` while translating client share-target lists for remote API calls.


##### `plugin_share_principal_role_from_remote`  (lines 273–287)

```
fn plugin_share_principal_role_from_remote(
    role: codex_core_plugins::remote::RemotePluginSharePrincipalRole,
) -> PluginSharePrincipalRole
```

**Purpose**: Converts a remote share-principal role into the protocol role enum, including owner status.

**Data flow**: Matches remote `Reader`, `Editor`, or `Owner` and returns the corresponding `PluginSharePrincipalRole`.

**Call relations**: Called by `plugin_share_principal_from_remote` when converting remote share-principal records for API responses.

*Call graph*: called by 1 (plugin_share_principal_from_remote).


##### `remote_plugin_share_targets`  (lines 289–312)

```
fn remote_plugin_share_targets(
    targets: Vec<PluginShareTarget>,
) -> Vec<codex_core_plugins::remote::RemotePluginShareTarget>
```

**Purpose**: Converts client-supplied share targets into the remote service request format.

**Data flow**: Consumes a `Vec<PluginShareTarget>`, maps each target's principal type, principal ID, and role into `codex_core_plugins::remote::RemotePluginShareTarget`, and returns the converted vector.

**Call relations**: Used by `PluginRequestProcessor::plugin_share_update_targets_response` and indirectly by share-save access-policy construction.

*Call graph*: called by 1 (plugin_share_update_targets_response).


##### `plugin_share_principal_from_remote`  (lines 314–333)

```
fn plugin_share_principal_from_remote(
    principal: codex_core_plugins::remote::RemotePluginSharePrincipal,
) -> PluginSharePrincipal
```

**Purpose**: Converts a remote share-principal record into the protocol `PluginSharePrincipal` shape.

**Data flow**: Consumes `RemotePluginSharePrincipal`, maps its principal type and role via `plugin_share_principal_role_from_remote`, preserves `principal_id` and `name`, and returns `PluginSharePrincipal`.

**Call relations**: Used when returning updated share principals and when hydrating remote share context into API responses.

*Call graph*: calls 1 internal fn (plugin_share_principal_role_from_remote).


##### `PluginRequestProcessor::new`  (lines 336–352)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        analytics_events_client: AnalyticsEventsClient,
```

**Purpose**: Constructs the plugin request processor with all shared services needed for plugin, marketplace, sharing, MCP, and analytics operations.

**Data flow**: Takes auth, thread, outgoing, analytics, config-manager, and workspace-settings-cache dependencies; stores them in the struct; returns the processor.

**Call relations**: Created during server setup so all plugin-related RPCs can share the same managers and caches.

*Call graph*: called by 1 (new).


##### `PluginRequestProcessor::plugin_list`  (lines 354–361)

```
async fn plugin_list(
        &self,
        params: PluginListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-list RPC and wraps the typed list response into a generic client payload.

**Data flow**: Consumes `PluginListParams`, awaits `self.plugin_list_response(params)`, converts the resulting `PluginListResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates the substantial listing logic to `plugin_list_response`.

*Call graph*: calls 1 internal fn (plugin_list_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_installed`  (lines 363–370)

```
async fn plugin_installed(
        &self,
        params: PluginInstalledParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the installed-plugins RPC and wraps the typed response into the generic payload form.

**Data flow**: Consumes `PluginInstalledParams`, awaits `self.plugin_installed_response(params)`, converts the `PluginInstalledResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Reached from initialized request dispatch and delegates to `plugin_installed_response`.

*Call graph*: calls 1 internal fn (plugin_installed_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_read`  (lines 372–379)

```
async fn plugin_read(
        &self,
        params: PluginReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-read RPC and returns either local or remote plugin detail as a generic payload.

**Data flow**: Consumes `PluginReadParams`, awaits `self.plugin_read_response(params)`, converts the resulting `PluginReadResponse` into `ClientResponsePayload`, and wraps it in `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates source selection and detail assembly to `plugin_read_response`.

*Call graph*: calls 1 internal fn (plugin_read_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_skill_read`  (lines 381–388)

```
async fn plugin_skill_read(
        &self,
        params: PluginSkillReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the remote plugin skill-read RPC and wraps the typed response into a generic payload.

**Data flow**: Consumes `PluginSkillReadParams`, awaits `self.plugin_skill_read_response(params)`, converts the `PluginSkillReadResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Invoked by initialized request dispatch and delegates validation and remote fetch work to `plugin_skill_read_response`.

*Call graph*: calls 1 internal fn (plugin_skill_read_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_save`  (lines 390–397)

```
async fn plugin_share_save(
        &self,
        params: PluginShareSaveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-share-save RPC and wraps the typed share-save result into a generic payload.

**Data flow**: Consumes `PluginShareSaveParams`, awaits `self.plugin_share_save_response(params)`, converts the `PluginShareSaveResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates all share creation/update validation and remote API work to `plugin_share_save_response`.

*Call graph*: calls 1 internal fn (plugin_share_save_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_update_targets`  (lines 399–406)

```
async fn plugin_share_update_targets(
        &self,
        params: PluginShareUpdateTargetsParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-share-update-targets RPC and wraps the typed response into a generic payload.

**Data flow**: Consumes `PluginShareUpdateTargetsParams`, awaits `self.plugin_share_update_targets_response(params)`, converts the result into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Reached from initialized request dispatch and delegates to `plugin_share_update_targets_response`.

*Call graph*: calls 1 internal fn (plugin_share_update_targets_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_list`  (lines 408–415)

```
async fn plugin_share_list(
        &self,
        params: PluginShareListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-share-list RPC and wraps the typed list of shares into a generic payload.

**Data flow**: Consumes `PluginShareListParams`, awaits `self.plugin_share_list_response(params)`, converts the `PluginShareListResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates to `plugin_share_list_response`.

*Call graph*: calls 1 internal fn (plugin_share_list_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_checkout`  (lines 417–424)

```
async fn plugin_share_checkout(
        &self,
        params: PluginShareCheckoutParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-share-checkout RPC and wraps the checkout result into a generic payload.

**Data flow**: Consumes `PluginShareCheckoutParams`, awaits `self.plugin_share_checkout_response(params)`, converts the `PluginShareCheckoutResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Invoked by initialized request dispatch and delegates to `plugin_share_checkout_response`.

*Call graph*: calls 1 internal fn (plugin_share_checkout_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_delete`  (lines 426–433)

```
async fn plugin_share_delete(
        &self,
        params: PluginShareDeleteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-share-delete RPC and wraps the deletion result into a generic payload.

**Data flow**: Consumes `PluginShareDeleteParams`, awaits `self.plugin_share_delete_response(params)`, converts the `PluginShareDeleteResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates to `plugin_share_delete_response`.

*Call graph*: calls 1 internal fn (plugin_share_delete_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_install`  (lines 435–442)

```
async fn plugin_install(
        &self,
        params: PluginInstallParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-install RPC and wraps the install result into a generic payload.

**Data flow**: Consumes `PluginInstallParams`, awaits `self.plugin_install_response(params)`, converts the `PluginInstallResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Reached from initialized request dispatch and delegates local-vs-remote install branching to `plugin_install_response`.

*Call graph*: calls 1 internal fn (plugin_install_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_uninstall`  (lines 444–451)

```
async fn plugin_uninstall(
        &self,
        params: PluginUninstallParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the plugin-uninstall RPC and wraps the uninstall result into a generic payload.

**Data flow**: Consumes `PluginUninstallParams`, awaits `self.plugin_uninstall_response(params)`, converts the `PluginUninstallResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates local-vs-remote uninstall handling to `plugin_uninstall_response`.

*Call graph*: calls 1 internal fn (plugin_uninstall_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::effective_plugins_changed_callback`  (lines 453–462)

```
fn effective_plugins_changed_callback(&self) -> Arc<dyn Fn() + Send + Sync>
```

**Purpose**: Builds a reusable callback that schedules plugin/skill cache invalidation and MCP refresh whenever effective plugin state changes.

**Data flow**: Clones `thread_manager` and `config_manager`, captures them in an `Arc<dyn Fn() + Send + Sync>`, and returns a closure that calls `Self::spawn_effective_plugins_changed_task(...)`.

**Call relations**: Passed into background plugin-manager operations such as remote installed-plugin sync and plugin-list background tasks so those subsystems can trigger refresh work without holding a processor reference.

*Call graph*: called by 5 (load_remote_installed_plugins, plugin_installed_response, plugin_list_response, remote_plugin_install_response, remote_plugin_uninstall_response); 3 external calls (clone, new, clone).


##### `PluginRequestProcessor::on_effective_plugins_changed`  (lines 464–469)

```
fn on_effective_plugins_changed(&self)
```

**Purpose**: Immediately schedules the standard cache-clear and MCP-refresh task for a known plugin-state mutation.

**Data flow**: Clones `thread_manager` and `config_manager` from `self` and forwards them to `spawn_effective_plugins_changed_task`.

**Call relations**: Called after successful local installs/uninstalls and some remote uninstall cache clears to keep runtime plugin and MCP state in sync.

*Call graph*: called by 3 (plugin_install_response, plugin_uninstall_response, remote_plugin_uninstall_response); 3 external calls (clone, spawn_effective_plugins_changed_task, clone).


##### `PluginRequestProcessor::spawn_effective_plugins_changed_task`  (lines 471–483)

```
fn spawn_effective_plugins_changed_task(
        thread_manager: Arc<ThreadManager>,
        config_manager: ConfigManager,
    )
```

**Purpose**: Runs the actual asynchronous follow-up for plugin-state changes: clear plugin and skill caches, then refresh MCP state if any threads exist.

**Data flow**: Takes owned `Arc<ThreadManager>` and `ConfigManager`, spawns a task that clears `plugins_manager` and `skills_manager` caches, checks `thread_manager.list_thread_ids().await`, and if non-empty awaits `crate::mcp_refresh::queue_best_effort_refresh(&thread_manager, &config_manager)`.

**Call relations**: Used by both the callback-producing helper and direct mutation paths so all plugin-state changes share one refresh strategy.

*Call graph*: calls 1 internal fn (queue_best_effort_refresh); 1 external calls (spawn).


##### `PluginRequestProcessor::clear_plugin_related_caches`  (lines 485–488)

```
fn clear_plugin_related_caches(&self)
```

**Purpose**: Clears only the plugin and skill caches without scheduling any MCP refresh.

**Data flow**: Reads `self.thread_manager`, calls `plugins_manager().clear_cache()` and `skills_manager().clear_cache()`, and returns no value.

**Call relations**: Used after share mutations and as a fallback after some uninstall paths when a full config reload or broader refresh is not performed.

*Call graph*: called by 5 (plugin_share_checkout_response, plugin_share_delete_response, plugin_share_save_response, plugin_share_update_targets_response, plugin_uninstall_response).


##### `PluginRequestProcessor::load_latest_config`  (lines 490–498)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the latest effective config with uniform internal-error mapping.

**Data flow**: Accepts an optional fallback `PathBuf`, awaits `self.config_manager.load_latest_config(fallback_cwd)`, returns the `Config`, or maps failures to `internal_error(format!(...))`.

**Call relations**: This helper is used throughout nearly every plugin RPC so operations reflect current config rather than the processor's startup snapshot.

*Call graph*: calls 1 internal fn (load_latest_config); called by 9 (load_plugin_share_config_and_auth, plugin_install_response, plugin_installed_response, plugin_list_response, plugin_read_response, plugin_skill_read_response, plugin_uninstall_response, remote_plugin_install_response, remote_plugin_uninstall_response).


##### `PluginRequestProcessor::workspace_codex_plugins_enabled`  (lines 500–520)

```
async fn workspace_codex_plugins_enabled(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> bool
```

**Purpose**: Checks the workspace-level setting that can disable Codex plugins even when the global feature flag is enabled, defaulting to permissive behavior on lookup failure.

**Data flow**: Takes `&Config` and optional `&CodexAuth`, awaits `workspace_settings::codex_plugins_enabled_for_workspace(config, auth, Some(&self.workspace_settings_cache))`, returns the boolean on success, and on error logs a warning and returns `true`.

**Call relations**: Called by plugin list, installed, and install flows before doing plugin work that should be blocked by workspace policy.

*Call graph*: calls 1 internal fn (codex_plugins_enabled_for_workspace); called by 3 (plugin_install_response, plugin_installed_response, plugin_list_response); 1 external calls (warn!).


##### `PluginRequestProcessor::plugin_list_response`  (lines 522–773)

```
async fn plugin_list_response(
        &self,
        params: PluginListParams,
    ) -> Result<PluginListResponse, JSONRPCErrorError>
```

**Purpose**: Builds the full plugin marketplace listing, combining local marketplaces, optional vertical/remote catalogs, background refresh scheduling, and featured-plugin metadata.

**Data flow**: Consumes `PluginListParams { cwds, marketplace_kinds }`, reloads config, checks plugin and workspace feature gates, reads auth and sets plugin-manager auth mode, computes which marketplace kinds to include, optionally loads local share-ID mappings, runs local marketplace enumeration in `spawn_blocking`, optionally fetches curated vertical or remote marketplaces from remote services, starts plugin-list background tasks when relevant, optionally fetches featured plugin IDs, and returns `PluginListResponse { marketplaces, marketplace_load_errors, featured_plugin_ids }`. It maps explicit remote/catalog failures to JSON-RPC errors but otherwise degrades to warnings and partial local results.

**Call relations**: This is the core implementation behind `plugin_list`. It orchestrates local plugin-manager calls, remote catalog fetches, cache-refresh triggers, and protocol conversion helpers.

*Call graph*: calls 10 internal fn (internal_error, effective_plugins_changed_callback, load_latest_config, workspace_codex_plugins_enabled, load_shared_plugin_ids_by_local_path, remote_marketplace_to_info, remote_plugin_catalog_error_to_jsonrpc, fetch_openai_curated_remote_collection_marketplace, fetch_remote_marketplaces, has_cached_global_remote_plugin_catalog); called by 1 (plugin_list); 5 external calls (marketplace_error, new, format!, spawn_blocking, warn!).


##### `PluginRequestProcessor::plugin_installed_response`  (lines 775–844)

```
async fn plugin_installed_response(
        &self,
        params: PluginInstalledParams,
    ) -> Result<PluginInstalledResponse, JSONRPCErrorError>
```

**Purpose**: Builds the installed-plugins view by merging local installed/suggested plugins with remote installed-plugin marketplaces and removing curated duplicates.

**Data flow**: Consumes `PluginInstalledParams`, reloads config, checks plugin and workspace gates, reads auth and sets plugin-manager auth mode, computes visible remote installed marketplaces, starts remote installed-plugin bundle sync, awaits `load_local_installed_and_suggested_plugins(...)`, extends the result with `load_remote_installed_plugins(...)`, applies `filter_openai_curated_installed_conflicts`, and returns `PluginInstalledResponse { marketplaces, marketplace_load_errors }`.

**Call relations**: Called by `plugin_installed`; it coordinates the two subordinate loaders and post-merge conflict filtering.

*Call graph*: calls 7 internal fn (effective_plugins_changed_callback, load_latest_config, load_local_installed_and_suggested_plugins, load_remote_installed_plugins, workspace_codex_plugins_enabled, filter_openai_curated_installed_conflicts, remote_installed_plugin_visible_marketplaces); called by 1 (plugin_installed).


##### `PluginRequestProcessor::load_local_installed_and_suggested_plugins`  (lines 846–927)

```
async fn load_local_installed_and_suggested_plugins(
        &self,
        plugins_manager: Arc<codex_core_plugins::PluginsManager>,
        config: &Config,
        plugins_input: &codex_core_plugin
```

**Purpose**: Enumerates local marketplaces and filters each marketplace down to plugins that are either installed or explicitly requested as install suggestions.

**Data flow**: Takes a plugins manager, config, plugins-input snapshot, root directories, and a set of suggested plugin names. It loads local share-ID mappings, runs `plugins_manager.list_marketplaces_for_config(...)` in `spawn_blocking`, filters each marketplace's plugins to installed-or-suggested entries, converts them to `PluginSummary` values, converts marketplace load errors, and returns `(Vec<PluginMarketplaceEntry>, Vec<MarketplaceLoadErrorInfo>)` or a mapped JSON-RPC error.

**Call relations**: Used only by `plugin_installed_response` as the local half of the installed-plugin view.

*Call graph*: calls 2 internal fn (internal_error, load_shared_plugin_ids_by_local_path); called by 1 (plugin_installed_response); 4 external calls (marketplace_error, clone, format!, spawn_blocking).


##### `PluginRequestProcessor::load_remote_installed_plugins`  (lines 929–968)

```
async fn load_remote_installed_plugins(
        &self,
        plugins_manager: Arc<codex_core_plugins::PluginsManager>,
        plugins_input: &codex_core_plugins::PluginsConfigInput,
        visible
```

**Purpose**: Loads remote installed-plugin marketplaces from cache when possible or builds and caches them on demand, suppressing auth-mode-related failures.

**Data flow**: Takes a plugins manager, plugins-input snapshot, visible marketplace names, and optional auth. It first tries `build_remote_installed_plugin_marketplaces_from_cache`; if absent, it awaits `build_and_cache_remote_installed_plugin_marketplaces(...)` with an effective-plugins-changed callback. Successful remote marketplaces are converted with `remote_marketplace_to_info`; auth-required and unsupported-auth failures return an empty vector; other failures log a warning and also return an empty vector.

**Call relations**: Called by `plugin_installed_response` after local installed plugins are loaded.

*Call graph*: calls 1 internal fn (effective_plugins_changed_callback); called by 1 (plugin_installed_response); 2 external calls (new, warn!).


##### `PluginRequestProcessor::plugin_read_response`  (lines 970–1154)

```
async fn plugin_read_response(
        &self,
        params: PluginReadParams,
    ) -> Result<PluginReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads detailed plugin metadata from either a local marketplace path or a remote marketplace name, enriches it with apps and share context, and returns a unified `PluginDetail`.

**Data flow**: Consumes `PluginReadParams`, validates that exactly one of `marketplace_path` or `remote_marketplace_name` is present, reloads config (using the marketplace parent as fallback cwd for local reads), reads auth and sets plugin-manager auth mode, then branches. Local reads call `plugins_manager.read_plugin_for_config`, load local share-ID mappings, optionally hydrate share context from the remote service, load app summaries, filter skills by session-source product restriction, convert hooks and MCP server names, and build `PluginDetail`. Remote reads validate the remote plugin ID, fetch remote detail, derive app categories from the remote app manifest, load app summaries, and convert the remote detail with `remote_plugin_detail_to_info`. It returns `PluginReadResponse { plugin }` or JSON-RPC errors for invalid source selection, disabled features, invalid IDs, or underlying marketplace/catalog failures.

**Call relations**: This is the implementation behind `plugin_read`, coordinating local plugin-manager access, remote catalog access, connector metadata, and share-context hydration.

*Call graph*: calls 12 internal fn (invalid_request, load_latest_config, load_plugin_app_summaries, load_shared_plugin_ids_by_local_path, marketplace_plugin_source_to_info, plugin_skills_to_info, remote_plugin_detail_to_info, remote_plugin_share_context_to_info, share_context_for_source, fetch_remote_plugin_detail (+2 more)); called by 1 (plugin_read); 3 external calls (new, format!, warn!).


##### `PluginRequestProcessor::plugin_skill_read_response`  (lines 1156–1198)

```
async fn plugin_skill_read_response(
        &self,
        params: PluginSkillReadParams,
    ) -> Result<PluginSkillReadResponse, JSONRPCErrorError>
```

**Purpose**: Fetches the contents of a specific remote plugin skill after validating feature flags, plugin ID, and skill name.

**Data flow**: Consumes `PluginSkillReadParams`, reloads config, checks `Feature::Plugins`, validates the remote plugin ID and non-empty `skill_name`, reads auth, builds `RemotePluginServiceConfig`, awaits `fetch_remote_plugin_skill_detail(...)`, maps remote catalog errors through `remote_plugin_catalog_error_to_jsonrpc`, and returns `PluginSkillReadResponse { contents }`.

**Call relations**: Called by `plugin_skill_read`; it is a focused remote-catalog read path separate from full plugin detail reads.

*Call graph*: calls 4 internal fn (invalid_request, load_latest_config, fetch_remote_plugin_skill_detail, validate_remote_plugin_id); called by 1 (plugin_skill_read); 1 external calls (format!).


##### `PluginRequestProcessor::plugin_share_save_response`  (lines 1200–1256)

```
async fn plugin_share_save_response(
        &self,
        params: PluginShareSaveParams,
    ) -> Result<PluginShareSaveResponse, JSONRPCErrorError>
```

**Purpose**: Creates a new remote plugin share or updates an existing local-to-remote share mapping, enforcing API constraints on discoverability and share targets.

**Data flow**: Consumes `PluginShareSaveParams`, loads config and auth via `load_plugin_share_config_and_auth`, checks `Feature::PluginSharing`, validates optional `remote_plugin_id`, rejects unsupported combinations such as updating discoverability/targets during an existing-share save, rejects `LISTED` discoverability, validates share targets, builds `RemotePluginServiceConfig` and `RemotePluginShareAccessPolicy`, awaits `save_remote_plugin_share(...)`, clears plugin-related caches, and returns `PluginShareSaveResponse { remote_plugin_id, share_url }`.

**Call relations**: This helper is called by `plugin_share_save` and centralizes both request validation and the remote share-save API call.

*Call graph*: calls 5 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, validate_client_plugin_share_targets, is_valid_remote_plugin_id); called by 1 (plugin_share_save); 1 external calls (save_remote_plugin_share).


##### `PluginRequestProcessor::plugin_share_update_targets_response`  (lines 1258–1299)

```
async fn plugin_share_update_targets_response(
        &self,
        params: PluginShareUpdateTargetsParams,
    ) -> Result<PluginShareUpdateTargetsResponse, JSONRPCErrorError>
```

**Purpose**: Updates the principals and discoverability of an existing remote plugin share.

**Data flow**: Consumes `PluginShareUpdateTargetsParams`, loads config/auth, checks plugin-sharing enablement, validates the remote plugin ID and share targets, builds `RemotePluginServiceConfig`, awaits `update_remote_plugin_share_targets(...)` with converted targets and discoverability, clears plugin-related caches, converts returned principals and discoverability into protocol types, and returns `PluginShareUpdateTargetsResponse`.

**Call relations**: Called by `plugin_share_update_targets`; it is the mutation path for changing access control on an existing share.

*Call graph*: calls 8 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, remote_plugin_share_discoverability_to_info, remote_plugin_share_targets, remote_plugin_share_update_discoverability, validate_client_plugin_share_targets, is_valid_remote_plugin_id); called by 1 (plugin_share_update_targets); 1 external calls (update_remote_plugin_share_targets).


##### `PluginRequestProcessor::plugin_share_list_response`  (lines 1301–1330)

```
async fn plugin_share_list_response(
        &self,
        _params: PluginShareListParams,
    ) -> Result<PluginShareListResponse, JSONRPCErrorError>
```

**Purpose**: Lists remote plugin shares visible to the current user and maps them into protocol list items with optional local checkout paths.

**Data flow**: Loads config/auth via `load_plugin_share_config_and_auth`, builds `RemotePluginServiceConfig`, awaits `list_remote_plugin_shares(...)`, maps each `RemoteCatalogPluginShareSummary` into `PluginShareListItem { plugin, local_plugin_path }` using `remote_plugin_summary_to_info`, and returns `PluginShareListResponse { data }`.

**Call relations**: Used by `plugin_share_list` as the read-only listing path for plugin sharing.

*Call graph*: calls 1 internal fn (load_plugin_share_config_and_auth); called by 1 (plugin_share_list); 1 external calls (list_remote_plugin_shares).


##### `PluginRequestProcessor::plugin_share_checkout_response`  (lines 1332–1366)

```
async fn plugin_share_checkout_response(
        &self,
        params: PluginShareCheckoutParams,
    ) -> Result<PluginShareCheckoutResponse, JSONRPCErrorError>
```

**Purpose**: Checks out a shared remote plugin into the local Codex home and returns the resulting local plugin and marketplace paths.

**Data flow**: Consumes `PluginShareCheckoutParams`, loads config/auth, checks plugin-sharing enablement, validates the remote plugin ID, builds `RemotePluginServiceConfig`, awaits `checkout_remote_plugin_share(...)`, clears plugin-related caches, and returns `PluginShareCheckoutResponse` populated from the checkout result.

**Call relations**: Called by `plugin_share_checkout`; it mutates local plugin state and therefore clears caches afterward.

*Call graph*: calls 4 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, is_valid_remote_plugin_id); called by 1 (plugin_share_checkout); 1 external calls (checkout_remote_plugin_share).


##### `PluginRequestProcessor::plugin_share_delete_response`  (lines 1368–1391)

```
async fn plugin_share_delete_response(
        &self,
        params: PluginShareDeleteParams,
    ) -> Result<PluginShareDeleteResponse, JSONRPCErrorError>
```

**Purpose**: Deletes a remote plugin share and clears local plugin caches so share state is not served stale.

**Data flow**: Consumes `PluginShareDeleteParams`, loads config/auth, validates the remote plugin ID, builds `RemotePluginServiceConfig`, awaits `delete_remote_plugin_share(...)`, clears plugin-related caches, and returns `PluginShareDeleteResponse {}`.

**Call relations**: Used by `plugin_share_delete` as the destructive share-management path.

*Call graph*: calls 4 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, is_valid_remote_plugin_id); called by 1 (plugin_share_delete); 1 external calls (delete_remote_plugin_share).


##### `PluginRequestProcessor::load_plugin_share_config_and_auth`  (lines 1393–1402)

```
async fn load_plugin_share_config_and_auth(
        &self,
    ) -> Result<(Config, Option<CodexAuth>), JSONRPCErrorError>
```

**Purpose**: Loads current config and auth for share-related RPCs and enforces that the broader plugins feature is enabled before any sharing operation proceeds.

**Data flow**: Reloads config via `load_latest_config(None)`, checks `config.features.enabled(Feature::Plugins)`, returns `invalid_request("plugin sharing is not enabled")` if false, otherwise awaits `self.auth_manager.auth()` and returns `(config, auth)`.

**Call relations**: Shared by all plugin-sharing RPC implementations so they start from the same config/auth preconditions.

*Call graph*: calls 2 internal fn (invalid_request, load_latest_config); called by 5 (plugin_share_checkout_response, plugin_share_delete_response, plugin_share_list_response, plugin_share_save_response, plugin_share_update_targets_response).


##### `PluginRequestProcessor::plugin_install_response`  (lines 1404–1487)

```
async fn plugin_install_response(
        &self,
        params: PluginInstallParams,
    ) -> Result<PluginInstallResponse, JSONRPCErrorError>
```

**Purpose**: Installs either a local marketplace plugin or a remote plugin, then performs post-install cache refresh, MCP OAuth startup, and app-auth analysis.

**Data flow**: Consumes `PluginInstallParams`, validates that exactly one of `marketplace_path` or `remote_marketplace_name` is present, and branches. For remote installs it delegates to `remote_plugin_install_response`. For local installs it reloads config using the marketplace parent as fallback cwd, reads auth, checks workspace plugin enablement, calls `plugins_manager.install_plugin`, attempts to reload config again, triggers `on_effective_plugins_changed`, loads plugin MCP servers and starts silent OAuth logins if needed, loads plugin app declarations, computes `apps_needing_auth` via `plugin_apps_needing_auth_for_install`, and returns `PluginInstallResponse { auth_policy, apps_needing_auth }`.

**Call relations**: This is the main implementation behind `plugin_install`, coordinating local-vs-remote branching and all post-install follow-up.

*Call graph*: calls 7 internal fn (invalid_request, load_latest_config, on_effective_plugins_changed, plugin_apps_needing_auth_for_install, remote_plugin_install_response, start_plugin_mcp_oauth_logins, workspace_codex_plugins_enabled); called by 1 (plugin_install); 2 external calls (app_connector_ids_from_declarations, warn!).


##### `PluginRequestProcessor::remote_plugin_install_response`  (lines 1489–1647)

```
async fn remote_plugin_install_response(
        &self,
        remote_marketplace_name: String,
        remote_plugin_id: String,
    ) -> Result<PluginInstallResponse, JSONRPCErrorError>
```

**Purpose**: Installs a remote plugin by fetching remote detail and bundle URLs, validating and materializing the bundle locally, notifying the backend, refreshing caches, emitting analytics, and computing post-install auth requirements.

**Data flow**: Accepts a remote marketplace name and remote plugin ID, reloads config, checks plugin feature enablement, validates the remote ID, reads auth, fetches remote detail with download URLs, rejects disabled or unavailable plugins, marks remote plugin cache mutation in flight, validates the bundle metadata, downloads and installs the bundle into `config.codex_home`, calls the remote service to record installation, schedules remote installed-plugin cache refresh, builds telemetry metadata and tracks plugin installation analytics, loads plugin MCP servers and starts silent OAuth logins if needed, computes `apps_needing_auth` either from backend-provided app IDs or by loading local app declarations and calling `plugin_apps_needing_auth_for_install`, and returns `PluginInstallResponse { auth_policy, apps_needing_auth }`.

**Call relations**: Reached only from `plugin_install_response` when the request targets a remote marketplace. It orchestrates both local filesystem materialization and backend state mutation.

*Call graph*: calls 13 internal fn (track_plugin_installed, invalid_request, effective_plugins_changed_callback, load_latest_config, plugin_apps_needing_auth_for_install, start_plugin_mcp_oauth_logins, connectors_for_plugin_apps, list_cached_all_connectors, fetch_remote_plugin_detail_with_download_urls, install_remote_plugin (+3 more)); called by 1 (plugin_install_response); 4 external calls (new, mark_remote_plugin_cache_mutation_in_flight, app_connector_ids_from_declarations, format!).


##### `PluginRequestProcessor::plugin_apps_needing_auth_for_install`  (lines 1649–1712)

```
async fn plugin_apps_needing_auth_for_install(
        &self,
        config: &Config,
        is_chatgpt_auth: bool,
        plugin_id: &str,
        plugin_apps: &[codex_plugin::AppConnectorId],
```

**Purpose**: Determines which app connectors declared by an installed plugin still require user authentication in the current environment.

**Data flow**: Takes `&Config`, a `bool is_chatgpt_auth`, a plugin ID string for logging, and a slice of plugin app connector IDs. It short-circuits to an empty vector when there are no plugin apps or app auth is disabled by feature flags. Otherwise it concurrently fetches all connector metadata and accessible connectors from MCP tools, falls back to cached connector data on errors, warns when Codex apps are not ready, and calls `plugin_apps_needing_auth(...)` to compute the final `Vec<AppSummary>`.

**Call relations**: Used after both local and remote installs so the install response can tell the client which plugin apps still need auth setup.

*Call graph*: calls 4 internal fn (plugin_apps_needing_auth, connectors_for_plugin_apps, list_cached_all_connectors, list_cached_accessible_connectors_from_mcp_tools); called by 2 (plugin_install_response, remote_plugin_install_response); 4 external calls (new, is_empty, join!, warn!).


##### `PluginRequestProcessor::start_plugin_mcp_oauth_logins`  (lines 1714–1796)

```
async fn start_plugin_mcp_oauth_logins(
        &self,
        config: &Config,
        plugin_mcp_servers: HashMap<String, McpServerConfig>,
    )
```

**Purpose**: Starts silent OAuth login attempts for plugin-declared MCP servers that advertise OAuth support, with a retry path that drops scopes when the first attempt indicates that is appropriate.

**Data flow**: Takes `&Config` and a `HashMap<String, McpServerConfig>`. For each server it awaits `oauth_login_support(&server.transport)`, skips unsupported servers, warns on unknown support, resolves scopes from explicit/discovered/server scopes, captures credential-store and callback settings from config, and spawns a task that calls `perform_oauth_login_silent(...)`. If the first attempt fails and `should_retry_without_scopes(...)` says to retry, it performs a second login with an empty scope list. The task then sends `ServerNotification::McpServerOauthLoginCompleted` with success/error through `outgoing`.

**Call relations**: Called after successful local and remote plugin installs whenever the installed plugin declares MCP servers that may require OAuth.

*Call graph*: called by 2 (plugin_install_response, remote_plugin_install_response); 8 external calls (clone, McpServerOauthLoginCompleted, auth_keyring_backend_kind, oauth_login_support, should_retry_without_scopes, perform_oauth_login_silent, spawn, warn!).


##### `PluginRequestProcessor::plugin_uninstall_response`  (lines 1798–1827)

```
async fn plugin_uninstall_response(
        &self,
        params: PluginUninstallParams,
    ) -> Result<PluginUninstallResponse, JSONRPCErrorError>
```

**Purpose**: Uninstalls either a local plugin or a remote plugin, validating the identifier and refreshing caches afterward.

**Data flow**: Consumes `PluginUninstallParams { plugin_id }`, validates that the ID is either a parseable local `PluginId` or a valid remote plugin ID, delegates remote IDs to `remote_plugin_uninstall_response`, otherwise calls `plugins_manager.uninstall_plugin(plugin_id)`, maps errors with `plugin_uninstall_error`, attempts to reload config and either triggers `on_effective_plugins_changed` or logs a warning and clears plugin-related caches, then returns `PluginUninstallResponse {}`.

**Call relations**: This is the implementation behind `plugin_uninstall`, branching between local and remote uninstall semantics.

*Call graph*: calls 7 internal fn (invalid_request, clear_plugin_related_caches, load_latest_config, on_effective_plugins_changed, remote_plugin_uninstall_response, is_valid_remote_plugin_id, parse); called by 1 (plugin_uninstall); 1 external calls (warn!).


##### `PluginRequestProcessor::plugin_install_error`  (lines 1829–1851)

```
fn plugin_install_error(err: CorePluginInstallError) -> JSONRPCErrorError
```

**Purpose**: Converts `CorePluginInstallError` into the appropriate JSON-RPC error category and message.

**Data flow**: Takes a `CorePluginInstallError`, first checks `err.is_invalid_request()` and returns `invalid_request(err.to_string())` when true; otherwise matches marketplace/config/remote/join/store variants and maps them to either `marketplace_error(...)` or contextual `internal_error(...)` messages.

**Call relations**: Used by local plugin install paths to present consistent JSON-RPC failures to clients.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 4 external calls (is_invalid_request, to_string, marketplace_error, format!).


##### `PluginRequestProcessor::plugin_uninstall_error`  (lines 1853–1875)

```
fn plugin_uninstall_error(err: CorePluginUninstallError) -> JSONRPCErrorError
```

**Purpose**: Converts `CorePluginUninstallError` into JSON-RPC errors, preserving invalid-request classification where appropriate.

**Data flow**: Takes a `CorePluginUninstallError`, returns `invalid_request(err.to_string())` when `is_invalid_request()` is true, otherwise maps config/remote/join/store variants to contextual `internal_error(...)` messages and treats `InvalidPluginId` as unreachable because callers validate IDs first.

**Call relations**: Used by local plugin uninstall paths after `plugins_manager.uninstall_plugin` fails.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 4 external calls (is_invalid_request, to_string, format!, unreachable!).


##### `PluginRequestProcessor::marketplace_error`  (lines 1877–1887)

```
fn marketplace_error(err: MarketplaceError, action: &str) -> JSONRPCErrorError
```

**Purpose**: Maps `MarketplaceError` values into either client-visible invalid requests or internal server errors with action-specific context.

**Data flow**: Consumes a `MarketplaceError` and an action string. It maps not-found/invalid/disabled marketplace and plugin conditions to `invalid_request(err.to_string())`, and maps `MarketplaceError::Io` to `internal_error(format!("failed to {action}: {err}"))`.

**Call relations**: Shared by multiple local marketplace/plugin operations such as list, read, and install to keep error classification consistent.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (to_string, format!).


##### `PluginRequestProcessor::remote_plugin_uninstall_response`  (lines 1889–1930)

```
async fn remote_plugin_uninstall_response(
        &self,
        plugin_id: String,
    ) -> Result<PluginUninstallResponse, JSONRPCErrorError>
```

**Purpose**: Uninstalls a remote plugin through the remote service, clears or refreshes remote-installed caches when appropriate, and returns an empty success response.

**Data flow**: Accepts a remote plugin ID string, reloads config, checks plugin feature enablement, validates the remote ID, reads auth, builds `RemotePluginServiceConfig`, awaits `uninstall_remote_plugin(...)`, and if the result is success or only a cache-removal error it clears the remote installed-plugin cache, may trigger `on_effective_plugins_changed`, and starts a post-mutation remote-installed cache refresh. It then maps any remaining remote catalog error through `remote_plugin_catalog_error_to_jsonrpc` and returns `PluginUninstallResponse {}` on success.

**Call relations**: Called only by `plugin_uninstall_response` when the provided plugin ID is recognized as a remote plugin ID.

*Call graph*: calls 6 internal fn (invalid_request, effective_plugins_changed_callback, load_latest_config, on_effective_plugins_changed, uninstall_remote_plugin, validate_remote_plugin_id); called by 1 (plugin_uninstall_response); 1 external calls (matches!).


##### `load_plugin_app_summaries`  (lines 1933–1976)

```
async fn load_plugin_app_summaries(
    config: &Config,
    plugin_apps: &[codex_plugin::AppConnectorId],
    app_category_by_id: &HashMap<String, String>,
) -> Vec<AppSummary>
```

**Purpose**: Loads connector metadata for a plugin's declared app connectors and converts matching connectors into protocol `AppSummary` values.

**Data flow**: Takes `&Config`, a slice of plugin app connector IDs, and an app-category override map. It returns early with an empty vector when there are no plugin apps. Otherwise it awaits `connectors::list_all_connectors_with_options`, falls back to cached connectors on error with a warning, filters connectors to those referenced by the plugin, derives each app's category from the override map or connector metadata, and returns the resulting `Vec<AppSummary>`.

**Call relations**: Used by `plugin_read_response` for both local and remote plugin detail responses.

*Call graph*: calls 3 internal fn (connectors_for_plugin_apps, list_all_connectors_with_options, list_cached_all_connectors); called by 1 (plugin_read_response); 3 external calls (new, is_empty, warn!).


##### `plugin_app_category_by_id_from_value`  (lines 1978–1983)

```
fn plugin_app_category_by_id_from_value(value: &serde_json::Value) -> HashMap<String, String>
```

**Purpose**: Extracts app connector categories from a plugin app-manifest JSON value.

**Data flow**: Consumes a `serde_json::Value`, parses app declarations with `codex_core_plugins::loader::plugin_app_declarations_from_value`, filters to declarations with a category, and collects a `HashMap<String, String>` keyed by connector ID.

**Call relations**: Used by remote plugin read and remote install flows when remote app manifests provide category metadata.

*Call graph*: calls 1 internal fn (plugin_app_declarations_from_value).


##### `plugin_apps_needing_auth`  (lines 1985–2022)

```
fn plugin_apps_needing_auth(
    all_connectors: &[AppInfo],
    accessible_connectors: &[AppInfo],
    plugin_apps: &[codex_plugin::AppConnectorId],
    codex_apps_ready: bool,
) -> Vec<AppSummary>
```

**Purpose**: Computes which plugin-declared app connectors are known but not currently accessible, provided the Codex apps MCP is ready.

**Data flow**: Takes slices of all connectors, accessible connectors, plugin app IDs, and a `codex_apps_ready` flag. If readiness is false it returns an empty vector. Otherwise it builds `HashSet`s of accessible IDs and plugin app IDs, filters `all_connectors` to those referenced by the plugin but absent from the accessible set, clones them, and maps them into `AppSummary` values.

**Call relations**: Called by `plugin_apps_needing_auth_for_install` after connector metadata and accessibility have been gathered.

*Call graph*: called by 1 (plugin_apps_needing_auth_for_install); 3 external calls (new, iter, iter).


##### `remote_marketplace_to_info`  (lines 2024–2037)

```
fn remote_marketplace_to_info(marketplace: RemoteMarketplace) -> PluginMarketplaceEntry
```

**Purpose**: Converts a remote marketplace catalog entry into the protocol `PluginMarketplaceEntry` shape.

**Data flow**: Consumes `RemoteMarketplace`, sets `path` to `None`, wraps the display name in `MarketplaceInterface`, converts each remote plugin summary with `remote_plugin_summary_to_info`, and returns `PluginMarketplaceEntry`.

**Call relations**: Used by plugin list and remote installed-plugin loading when remote marketplace data is fetched from the backend.

*Call graph*: called by 1 (plugin_list_response).


##### `remote_plugin_summary_to_info`  (lines 2039–2057)

```
fn remote_plugin_summary_to_info(summary: RemoteCatalogPluginSummary) -> PluginSummary
```

**Purpose**: Converts a remote catalog plugin summary into the protocol `PluginSummary` representation.

**Data flow**: Consumes `RemoteCatalogPluginSummary`, copies IDs, name, install/auth/availability flags, interface, and keywords, maps optional share context with `remote_plugin_share_context_to_info`, sets `source` to `PluginSource::Remote`, and returns `PluginSummary`.

**Call relations**: Used by `remote_marketplace_to_info` and `remote_plugin_detail_to_info` to normalize remote plugin summaries.

*Call graph*: called by 1 (remote_plugin_detail_to_info).


##### `remote_plugin_share_context_to_info`  (lines 2059–2078)

```
fn remote_plugin_share_context_to_info(
    context: RemoteCatalogPluginShareContext,
) -> PluginShareContext
```

**Purpose**: Converts remote share-context metadata into the protocol `PluginShareContext` shape.

**Data flow**: Consumes `RemoteCatalogPluginShareContext`, copies remote IDs, version, share URL, creator metadata, and optional principals, maps discoverability with `remote_plugin_share_discoverability_to_info`, converts principals with `plugin_share_principal_from_remote`, and returns `PluginShareContext`.

**Call relations**: Used when hydrating local plugin share context from the remote service and when converting remote plugin summaries/details.

*Call graph*: calls 1 internal fn (remote_plugin_share_discoverability_to_info); called by 1 (plugin_read_response).


##### `remote_plugin_share_discoverability_to_info`  (lines 2080–2094)

```
fn remote_plugin_share_discoverability_to_info(
    discoverability: codex_core_plugins::remote::RemotePluginShareDiscoverability,
) -> PluginShareDiscoverability
```

**Purpose**: Maps remote share discoverability values into the protocol enum.

**Data flow**: Matches remote `Listed`, `Unlisted`, or `Private` and returns the corresponding `PluginShareDiscoverability` variant.

**Call relations**: Used by share-context conversion and share-update responses.

*Call graph*: called by 2 (plugin_share_update_targets_response, remote_plugin_share_context_to_info).


##### `remote_plugin_detail_to_info`  (lines 2096–2146)

```
fn remote_plugin_detail_to_info(
    detail: RemoteCatalogPluginDetail,
    apps: Vec<AppSummary>,
) -> PluginDetail
```

**Purpose**: Converts a full remote plugin detail record plus precomputed app summaries into the protocol `PluginDetail` shape.

**Data flow**: Consumes `RemoteCatalogPluginDetail` and `Vec<AppSummary>`, converts app templates into `AppTemplateSummary` values with mapped unavailable reasons, converts the embedded summary with `remote_plugin_summary_to_info`, maps remote skills into protocol `SkillSummary` values, preserves description/share URL/MCP server names, and returns `PluginDetail` with `marketplace_path` set to `None` and hooks empty.

**Call relations**: Used by `plugin_read_response` for remote plugin reads after app summaries have been loaded.

*Call graph*: calls 1 internal fn (remote_plugin_summary_to_info); called by 1 (plugin_read_response); 1 external calls (new).


##### `remote_plugin_catalog_error_to_jsonrpc`  (lines 2148–2179)

```
fn remote_plugin_catalog_error_to_jsonrpc(
    err: RemotePluginCatalogError,
    context: &str,
) -> JSONRPCErrorError
```

**Purpose**: Classifies remote plugin catalog/service errors into invalid-request versus internal-error JSON-RPC responses.

**Data flow**: Takes a `RemotePluginCatalogError` and context string, formats a contextual message, then matches the error variant: auth-required, unsupported-auth, 404 statuses, invalid paths, unavailable checkout, oversized archives, and unknown marketplaces become `invalid_request`; token/request/status/decode/base-url/archive/cache and other unexpected failures become `internal_error`.

**Call relations**: Used across remote plugin list/read/install/share/uninstall flows so all remote-service failures are surfaced consistently.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); called by 1 (plugin_list_response); 1 external calls (format!).


##### `remote_plugin_bundle_install_error_to_jsonrpc`  (lines 2181–2185)

```
fn remote_plugin_bundle_install_error_to_jsonrpc(
    err: codex_core_plugins::remote_bundle::RemotePluginBundleInstallError,
) -> JSONRPCErrorError
```

**Purpose**: Wraps remote plugin bundle validation/download/install failures as internal JSON-RPC errors.

**Data flow**: Consumes `RemotePluginBundleInstallError`, formats `install remote plugin bundle: {err}`, and returns `internal_error(...)`.

**Call relations**: Used by `remote_plugin_install_response` for bundle validation and materialization failures.

*Call graph*: calls 1 internal fn (internal_error); 1 external calls (format!).


### `app-server/src/request_processors/remote_control_processor.rs`

`domain_logic` · `request handling`

This file defines `RemoteControlRequestProcessor`, a thin async adapter around an optional `RemoteControlHandle`. The processor exists because remote control may be compiled/configured out for a given app-server instance; every public operation first goes through `handle()`, which rejects missing handles as an internal error and separately enforces `ensure_remote_control_allowed()` as an invalid request. That split is important: absence of the subsystem is treated as server incapability, while policy-based denial is surfaced as a client-visible request problem.

The request methods mirror the protocol surface: enable/disable, status read, pairing start/status, and client list/revoke. `enable` and `disable` each branch on the `ephemeral` flag, using distinct handle methods for ephemeral state versus persisted state. Successful backend status objects are converted into protocol response structs via `From` implementations or explicit field copying. `pairing_status` adds a local invariant check before any backend call: exactly one of `pairing_code` or `manual_pairing_code` must be present.

The rest of the file is dedicated to error normalization. Different operations classify `io::ErrorKind` differently: update operations treat `NotFound` and `PermissionDenied` as invalid requests, pairing start/status only treats `InvalidInput` that way, and client-management operations also downgrade `WouldBlock`. `RemoteControlEnableError` is unpacked into either availability or requirements failures, both mapped to invalid-request semantics rather than internal faults.

#### Function details

##### `RemoteControlRequestProcessor::new`  (lines 26–30)

```
fn new(remote_control_handle: Option<RemoteControlHandle>) -> Self
```

**Purpose**: Constructs a processor around an optional `RemoteControlHandle`. The stored `Option` preserves whether this app-server instance can service remote-control requests at all.

**Data flow**: Takes `remote_control_handle: Option<RemoteControlHandle>` and stores it unchanged in the struct field. Returns a new `RemoteControlRequestProcessor` cloneable by value.

**Call relations**: Called during processor wiring and directly by tests that simulate an unavailable subsystem by passing `None`; all later request methods depend on this stored handle through `RemoteControlRequestProcessor::handle`.

*Call graph*: called by 3 (new, pairing_start_returns_internal_error_when_remote_control_is_unavailable, pairing_status_returns_internal_error_when_remote_control_is_unavailable).


##### `RemoteControlRequestProcessor::enable`  (lines 32–47)

```
async fn enable(
        &self,
        ephemeral: bool,
        app_server_client_name: Option<&str>,
    ) -> Result<RemoteControlEnableResponse, JSONRPCErrorError>
```

**Purpose**: Turns remote control on and returns the resulting status as `RemoteControlEnableResponse`. It distinguishes ephemeral enablement from persisted enablement with separate backend calls.

**Data flow**: Reads `ephemeral` and optional `app_server_client_name`, obtains a validated `&RemoteControlHandle` via `handle()`, then either calls synchronous `enable_ephemeral()` or async `enable(app_server_client_name)`. It maps backend errors through `map_enable_error` or `map_update_error`, converts the returned status with `RemoteControlEnableResponse::from`, and returns that response.

**Call relations**: Invoked from the initialized-client request dispatcher for the remote-control enable RPC. It always gates execution through `handle()` first, then delegates to the transport handle and response `From` conversion.

*Call graph*: calls 2 internal fn (from, handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::disable`  (lines 49–64)

```
async fn disable(
        &self,
        ephemeral: bool,
        app_server_client_name: Option<&str>,
    ) -> Result<RemoteControlDisableResponse, JSONRPCErrorError>
```

**Purpose**: Turns remote control off and returns the resulting status as `RemoteControlDisableResponse`. Like enable, it uses different backend paths for ephemeral versus persisted state.

**Data flow**: Consumes `ephemeral` and optional `app_server_client_name`, validates access with `handle()`, then calls either `disable_ephemeral().await` or persisted `disable(app_server_client_name).await`. Persisted-path I/O failures are normalized with `map_update_error`; the resulting status is converted with `RemoteControlDisableResponse::from` and returned.

**Call relations**: Reached from the main request dispatcher for the disable RPC. It mirrors `enable`’s control flow and relies on `handle()` to reject unavailable or disallowed remote control before touching backend state.

*Call graph*: calls 2 internal fn (from, handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::status_read`  (lines 66–74)

```
fn status_read(&self) -> Result<RemoteControlStatusReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads the current remote-control status snapshot without mutating backend state. It exposes only the protocol fields needed by clients.

**Data flow**: Obtains the validated handle via `handle()`, calls `status()` on it, then copies `status`, `server_name`, `installation_id`, and `environment_id` into a `RemoteControlStatusReadResponse`. Returns that response or the error from `handle()`.

**Call relations**: Called by the initialized-client request handler for the status-read RPC. It is a pure read path that depends only on `handle()` and the transport handle’s cached/current status accessor.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::pairing_start`  (lines 76–85)

```
async fn pairing_start(
        &self,
        params: RemoteControlPairingStartParams,
        app_server_client_name: Option<&str>,
    ) -> Result<RemoteControlPairingStartResponse, JSONRPCErrorErr
```

**Purpose**: Starts a remote-control pairing flow using protocol-supplied pairing parameters. It forwards the request to the backend and maps pairing-specific I/O failures into JSON-RPC errors.

**Data flow**: Takes `RemoteControlPairingStartParams` and optional `app_server_client_name`, validates subsystem access with `handle()`, then awaits `start_pairing(params, app_server_client_name)`. Successful backend output is returned directly as `RemoteControlPairingStartResponse`; `io::Error` failures are transformed by `map_pairing_start_error`.

**Call relations**: Dispatched from the initialized-client request path for pairing start. It delegates almost entirely to the handle after the common availability/policy check.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::pairing_status`  (lines 87–97)

```
async fn pairing_status(
        &self,
        params: RemoteControlPairingStatusParams,
    ) -> Result<RemoteControlPairingStatusResponse, JSONRPCErrorError>
```

**Purpose**: Queries the status of an in-progress pairing operation, enforcing that the caller identifies the pairing by exactly one code field. It prevents ambiguous or underspecified requests before backend access.

**Data flow**: Accepts `RemoteControlPairingStatusParams`, first passes a shared reference to `validate_pairing_status_params`, then obtains the validated handle with `handle()`, and awaits `pairing_status(params)`. Returns the backend `RemoteControlPairingStatusResponse` on success or a mapped JSON-RPC error via `map_pairing_start_error`.

**Call relations**: Called by the initialized-client request dispatcher for pairing-status. It is the only public method in this file with local semantic validation before `handle()`, because the protocol allows two mutually exclusive identifier fields.

*Call graph*: calls 2 internal fn (handle, validate_pairing_status_params); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::clients_list`  (lines 99–107)

```
async fn clients_list(
        &self,
        params: RemoteControlClientsListParams,
    ) -> Result<RemoteControlClientsListResponse, JSONRPCErrorError>
```

**Purpose**: Lists paired/known remote-control clients according to the supplied filter/paging parameters. It translates client-management backend failures into request or internal errors.

**Data flow**: Consumes `RemoteControlClientsListParams`, validates access with `handle()`, awaits `list_clients(params)`, and returns the resulting `RemoteControlClientsListResponse`. Any `io::Error` is classified by `map_client_management_error`.

**Call relations**: Reached from the initialized-client request dispatcher for the clients-list RPC. It is a direct adapter from protocol params to handle method with shared access/error gating.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::clients_revoke`  (lines 109–117)

```
async fn clients_revoke(
        &self,
        params: RemoteControlClientsRevokeParams,
    ) -> Result<RemoteControlClientsRevokeResponse, JSONRPCErrorError>
```

**Purpose**: Revokes a previously paired remote-control client identified by the request parameters. It uses the same client-management error policy as listing.

**Data flow**: Takes `RemoteControlClientsRevokeParams`, obtains a validated handle through `handle()`, awaits `revoke_client(params)`, and returns the backend `RemoteControlClientsRevokeResponse`. Backend `io::Error` values are converted by `map_client_management_error`.

**Call relations**: Invoked by the initialized-client request dispatcher for the revoke RPC. It shares the same backend/error path as `clients_list`, differing only in the delegated handle method and response type.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::handle`  (lines 119–128)

```
fn handle(&self) -> Result<&RemoteControlHandle, JSONRPCErrorError>
```

**Purpose**: Centralizes access checks for all remote-control operations. It distinguishes missing subsystem support from policy-based denial and returns a borrowed handle only when both checks pass.

**Data flow**: Reads `self.remote_control_handle`; if it is `None`, constructs an internal-error `JSONRPCErrorError` with a fixed message. If present, calls `ensure_remote_control_allowed()` on the handle and maps any denial to `invalid_request(err.to_string())`; otherwise returns `&RemoteControlHandle`.

**Call relations**: Used by every public request method in this processor as the first gate before backend work. It does not delegate further itself, but its result controls whether enable/disable/status/pairing/client operations can proceed.

*Call graph*: called by 7 (clients_list, clients_revoke, disable, enable, pairing_start, pairing_status, status_read).


##### `map_enable_error`  (lines 131–136)

```
fn map_enable_error(err: RemoteControlEnableError) -> JSONRPCErrorError
```

**Purpose**: Converts `RemoteControlEnableError` into the JSON-RPC error shape expected by request handlers. It preserves the distinction between transport unavailability and requirements-based refusal.

**Data flow**: Matches on `RemoteControlEnableError`: `Unavailable(err)` is forwarded to `map_unavailable`, while `DisabledByRequirements(err)` becomes `invalid_request(err.to_string())`. Returns the constructed `JSONRPCErrorError`.

**Call relations**: Used only by `RemoteControlRequestProcessor::enable` on the ephemeral enable path, where the backend returns a richer enum instead of plain `io::Error`.

*Call graph*: calls 2 internal fn (invalid_request, map_unavailable); 1 external calls (to_string).


##### `map_unavailable`  (lines 138–140)

```
fn map_unavailable(err: RemoteControlUnavailable) -> JSONRPCErrorError
```

**Purpose**: Maps `RemoteControlUnavailable` into an invalid-request JSON-RPC error. The backend’s textual explanation is preserved verbatim.

**Data flow**: Takes `RemoteControlUnavailable`, calls `to_string()` on it, wraps that message with `invalid_request`, and returns the resulting `JSONRPCErrorError`.

**Call relations**: Only reached through `map_enable_error` when enablement fails because remote control is unavailable rather than disabled by requirements.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (map_enable_error); 1 external calls (to_string).


##### `map_update_error`  (lines 142–151)

```
fn map_update_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Classifies generic remote-control enable/disable update failures by `io::ErrorKind`. User-actionable filesystem/state problems become invalid requests; everything else is treated as server failure.

**Data flow**: Reads `err.kind()`. If it matches `NotFound` or `PermissionDenied`, returns `invalid_request(err.to_string())`; otherwise returns `internal_error(err.to_string())`.

**Call relations**: Used by persisted enable and disable flows, where backend operations return `io::Error` rather than a domain enum.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (to_string, matches!).


##### `map_pairing_start_error`  (lines 153–159)

```
fn map_pairing_start_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Maps pairing-related `io::Error` values into JSON-RPC errors with a narrow invalid-request case. Only malformed input is exposed as client error.

**Data flow**: Checks whether `err.kind() == io::ErrorKind::InvalidInput`; if so, returns `invalid_request(err.to_string())`, otherwise `internal_error(err.to_string())`.

**Call relations**: Applied by both `pairing_start` and `pairing_status`, giving those two RPCs a shared error policy.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (kind, to_string).


##### `validate_pairing_status_params`  (lines 161–173)

```
fn validate_pairing_status_params(
    params: &RemoteControlPairingStatusParams,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Enforces the protocol invariant for `remoteControl/pairing/status`: callers must provide exactly one pairing identifier. It rejects both ambiguity and omission with explicit messages.

**Data flow**: Reads `params.pairing_code` and `params.manual_pairing_code` by reference and pattern-matches the `(Option, Option)` pair. Returns `Ok(())` when exactly one is `Some`; otherwise returns `invalid_request(...)` with a fixed explanatory message.

**Call relations**: Called only by `RemoteControlRequestProcessor::pairing_status` before any backend lookup, so malformed requests fail deterministically without touching transport state.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (pairing_status).


##### `map_client_management_error`  (lines 175–183)

```
fn map_client_management_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Normalizes client-list/revoke backend failures into JSON-RPC errors. It treats several operational states as client-visible invalid requests rather than internal faults.

**Data flow**: Matches `err.kind()`: `InvalidInput`, `NotFound`, `PermissionDenied`, and `WouldBlock` become `invalid_request(err.to_string())`; all other kinds become `internal_error(err.to_string())`.

**Call relations**: Shared by `clients_list` and `clients_revoke`, giving both client-management RPCs the same error semantics.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (kind, to_string).


### `app-server/src/request_processors/search.rs`

`domain_logic` · `request handling`

This file defines `SearchRequestProcessor`, which owns three pieces of shared state behind `Arc`: the `OutgoingMessageSender` used by session-based searches to emit updates, a `Mutex<HashMap<String, Arc<AtomicBool>>>` for one-shot search cancellation flags, and a `Mutex<HashMap<String, FuzzyFileSearchSession>>` for active incremental sessions.

The one-shot `fuzzy_file_search` method destructures `FuzzyFileSearchParams` into `query`, `roots`, and an optional `cancellation_token`. If a token is present, it locks `pending_fuzzy_searches`, marks any existing flag for that token as cancelled, installs a fresh `Arc<AtomicBool>`, and passes that flag into `run_fuzzy_file_search`. Empty queries are short-circuited to an empty result vector instead of invoking the backend. After the search completes, the method removes the token entry only if the map still points at the same flag via `Arc::ptr_eq`, avoiding races where a newer request reused the same token.

Session APIs are simpler. `fuzzy_file_search_session_start_response` rejects empty `session_id`, starts a backend session with `start_fuzzy_file_search_session`, and stores it by ID. `fuzzy_file_search_session_update_response` looks up the session under lock, calls `update_query(query)` if found, and otherwise returns an invalid request naming the missing session. `fuzzy_file_search_session_stop` simply removes the session entry and returns success whether or not it existed.

#### Function details

##### `SearchRequestProcessor::new`  (lines 31–37)

```
fn new(outgoing: Arc<OutgoingMessageSender>) -> Self
```

**Purpose**: Constructs a search processor with empty cancellation and session registries. It shares all mutable state through `Arc` so cloned processors observe the same searches and sessions.

**Data flow**: Takes `outgoing: Arc<OutgoingMessageSender>`, stores it, and initializes `pending_fuzzy_searches` and `fuzzy_search_sessions` as `Arc<Mutex<HashMap<...>>>` wrapping empty `HashMap`s. Returns the populated `SearchRequestProcessor`.

**Call relations**: Called during server setup when request processors are assembled; all later search/session methods operate on the shared maps created here.

*Call graph*: called by 1 (new); 3 external calls (new, new, new).


##### `SearchRequestProcessor::fuzzy_file_search`  (lines 39–79)

```
async fn fuzzy_file_search(
        &self,
        params: FuzzyFileSearchParams,
    ) -> Result<FuzzyFileSearchResponse, JSONRPCErrorError>
```

**Purpose**: Runs a one-shot fuzzy file search with optional cooperative cancellation keyed by a client-provided token. Reusing a token cancels the previous in-flight search before starting the new one.

**Data flow**: Destructures `FuzzyFileSearchParams` into `query`, `roots`, and `cancellation_token`. If a token exists, it locks `pending_fuzzy_searches`, sets any existing flag for that token to `true`, inserts a fresh `Arc<AtomicBool>` flag, and uses that flag for the search; otherwise it creates an untracked false flag. It returns `vec![]` for an empty query or awaits `run_fuzzy_file_search(query, roots, cancel_flag.clone())`. Afterward, if a token was used, it re-locks the map and removes the entry only when `Arc::ptr_eq` shows the stored flag is still this request’s flag. Finally it returns `FuzzyFileSearchResponse { files: results }`.

**Call relations**: Invoked by the initialized-client request dispatcher for the one-shot fuzzy search RPC. It delegates actual searching to `run_fuzzy_file_search` and manages cancellation bookkeeping around that call.

*Call graph*: calls 1 internal fn (run_fuzzy_file_search); called by 1 (handle_initialized_client_request); 4 external calls (new, ptr_eq, new, vec!).


##### `SearchRequestProcessor::fuzzy_file_search_session_start_response`  (lines 81–100)

```
async fn fuzzy_file_search_session_start_response(
        &self,
        params: FuzzyFileSearchSessionStartParams,
    ) -> Result<FuzzyFileSearchSessionStartResponse, JSONRPCErrorError>
```

**Purpose**: Starts a long-lived fuzzy search session that can stream updates through the outgoing channel. It validates the session identifier before creating backend session state.

**Data flow**: Consumes `FuzzyFileSearchSessionStartParams { session_id, roots }`. If `session_id` is empty, returns `invalid_request("sessionId must not be empty")`; otherwise calls `start_fuzzy_file_search_session(session_id.clone(), roots, self.outgoing.clone())`, maps startup failures to `internal_error`, inserts the resulting `FuzzyFileSearchSession` into `fuzzy_search_sessions`, and returns an empty `FuzzyFileSearchSessionStartResponse`.

**Call relations**: Called by the initialized-client request dispatcher for session start. It delegates session creation to the fuzzy-search subsystem and records the resulting session for later update/stop requests.

*Call graph*: calls 2 internal fn (invalid_request, start_fuzzy_file_search_session); called by 1 (handle_initialized_client_request).


##### `SearchRequestProcessor::fuzzy_file_search_session_update_response`  (lines 102–123)

```
async fn fuzzy_file_search_session_update_response(
        &self,
        params: FuzzyFileSearchSessionUpdateParams,
    ) -> Result<FuzzyFileSearchSessionUpdateResponse, JSONRPCErrorError>
```

**Purpose**: Updates the query for an existing fuzzy search session. Missing sessions are reported as invalid requests with the requested ID in the message.

**Data flow**: Destructures `FuzzyFileSearchSessionUpdateParams` into `session_id` and `query`, locks `fuzzy_search_sessions`, and checks for an entry with that ID. If found, it calls `session.update_query(query)` and records `found = true`; otherwise `found = false`. When not found, it returns `invalid_request(format!("fuzzy file search session not found: {session_id}"))`; on success it returns an empty `FuzzyFileSearchSessionUpdateResponse`.

**Call relations**: Reached from the initialized-client request dispatcher for session update. It depends on prior successful `fuzzy_file_search_session_start_response` having inserted the session.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (handle_initialized_client_request); 1 external calls (format!).


##### `SearchRequestProcessor::fuzzy_file_search_session_stop`  (lines 125–133)

```
async fn fuzzy_file_search_session_stop(
        &self,
        params: FuzzyFileSearchSessionStopParams,
    ) -> Result<FuzzyFileSearchSessionStopResponse, JSONRPCErrorError>
```

**Purpose**: Stops tracking a fuzzy search session by removing it from the session map. The operation is idempotent from the API perspective.

**Data flow**: Consumes `FuzzyFileSearchSessionStopParams { session_id }`, locks `fuzzy_search_sessions`, removes any entry for that ID, ignores whether one existed, and returns an empty `FuzzyFileSearchSessionStopResponse`.

**Call relations**: Called by the initialized-client request dispatcher for session stop. It is the terminal cleanup path for sessions created by `fuzzy_file_search_session_start_response`.

*Call graph*: called by 1 (handle_initialized_client_request).


### Exec server RPC handling
This group captures the exec server's JSON-RPC transport, method registration, and per-feature handlers that translate incoming methods into local process and filesystem operations.

### `exec-server/src/server/handler.rs`

`orchestration` · `per-connection request handling and shutdown`

This file is the main orchestration layer for one server connection. `ExecServerHandler` bundles the shared `SessionRegistry`, outbound `RpcNotificationSender`, an optional attached `SessionHandle` protected by a standard mutex, a Tokio mutex-protected set of active HTTP body stream ids, cancellation/tracking primitives for background tasks, a `FileSystemHandler`, and two atomic booleans that enforce the `initialize` then `initialized` handshake.

The initialization flow is strict. `initialize` may succeed only once per connection; it atomically flips `initialize_requested`, attaches or resumes a session through `SessionRegistry`, resets the flag if attach fails, logs the attachment, and stores the resulting `SessionHandle`. `initialized` then verifies that initialization happened and that the session is still attached before setting `initialized = true`. All operational methods call `require_initialized_for`, which rejects use before `initialize`, before `initialized`, or after the session has been resumed elsewhere.

Exec and filesystem methods are mostly guarded delegations to the attached session’s process handler or the embedded `FileSystemHandler`. `exec_read` performs an extra post-read attachment check so a resumed-away session causes long-poll reads to fail after the read returns. `http_request` is more involved: it optionally reserves a unique stream id when `stream_response` is requested, runs the request through `ReqwestHttpRequestRunner`, serializes and sends the immediate response manually via `RpcNotificationSender::response`, and if a body stream remains, launches a tracked background task that streams body chunks until completion or shutdown, then releases the reserved id. Shutdown cancels those background tasks, waits for them, shuts down filesystem state, and detaches any attached session.

The design emphasizes connection-scoped correctness: one initialize, one attached session at a time, no duplicate HTTP stream ids, and deterministic cleanup of background work and file handles.

#### Function details

##### `ExecServerHandler::new`  (lines 74–90)

```
fn new(
        session_registry: Arc<SessionRegistry>,
        notifications: RpcNotificationSender,
        runtime_paths: ExecServerRuntimePaths,
    ) -> Self
```

**Purpose**: Constructs a per-connection handler with fresh session, filesystem, and background-task state.

**Data flow**: Takes an `Arc<SessionRegistry>`, `RpcNotificationSender`, and `ExecServerRuntimePaths`; stores the registry and notifications, initializes `session` to `None`, creates an empty `HashSet` inside a Tokio `Mutex` for active body streams, creates a fresh `CancellationToken` and `TaskTracker`, constructs `FileSystemHandler::new(runtime_paths)`, and initializes both atomic handshake flags to `false`.

**Call relations**: Called during connection setup before routing any RPC methods. All later request handlers operate on the state assembled here.

*Call graph*: calls 1 internal fn (new); called by 5 (active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, run_connection); 6 external calls (new, new, new, new, new, new).


##### `ExecServerHandler::shutdown`  (lines 92–100)

```
async fn shutdown(&self)
```

**Purpose**: Performs orderly connection teardown by cancelling background work, closing filesystem handles, and detaching any attached session.

**Data flow**: Cancels `background_task_shutdown`, closes the `background_tasks` tracker, awaits `background_tasks.wait()`, awaits `self.file_system.shutdown()`, then calls `self.session()` and, if a session exists, awaits `session.detach()`.

**Call relations**: Invoked when the connection is closing. It coordinates cleanup across the background HTTP streaming path, filesystem handler, and session attachment established earlier in the connection lifecycle.

*Call graph*: calls 2 internal fn (shutdown, session); 3 external calls (cancel, close, wait).


##### `ExecServerHandler::is_session_attached`  (lines 102–105)

```
fn is_session_attached(&self) -> bool
```

**Purpose**: Reports whether there is no session yet or the currently stored session handle is still attached to this connection.

**Data flow**: Calls `self.session()` and returns `true` if it is `None` or if the contained `SessionHandle` reports `is_session_attached()`, otherwise `false`.

**Call relations**: Used by higher-level connection management to observe whether this handler still owns its session after resume/reattach events.

*Call graph*: calls 1 internal fn (session).


##### `ExecServerHandler::initialize`  (lines 107–139)

```
async fn initialize(
        &self,
        params: InitializeParams,
    ) -> Result<InitializeResponse, JSONRPCErrorError>
```

**Purpose**: Attaches or resumes a session for this connection and records that the initialize request has been issued exactly once.

**Data flow**: Consumes `InitializeParams`, atomically swaps `initialize_requested` from `false` to `true` and rejects repeated calls with `invalid_request`. It then awaits `self.session_registry.attach(params.resume_session_id.clone(), self.notifications.clone())`. On attach failure it resets `initialize_requested` back to `false` and returns the error. On success it logs the session id and connection id, stores `Some(session)` into the standard mutex-protected `session` field, and returns `InitializeResponse { session_id }`.

**Call relations**: Called by the RPC `initialize` method and must precede all operational methods. It is the only path that populates the handler’s `session` field.

*Call graph*: calls 1 internal fn (invalid_request); 5 external calls (store, swap, lock, clone, debug!).


##### `ExecServerHandler::initialized`  (lines 141–149)

```
fn initialized(&self) -> Result<(), String>
```

**Purpose**: Marks the connection as fully initialized after the client sends the follow-up notification.

**Data flow**: Checks `initialize_requested`; if false, returns a string error indicating `initialized` arrived too early. It then calls `require_session_attached()` and maps any JSON-RPC error to its message string. On success it stores `true` into `initialized` and returns `Ok(())`.

**Call relations**: Called by the `initialized` notification handler after `initialize`. Its success is required before `require_initialized_for` will allow exec, filesystem, or HTTP methods.

*Call graph*: calls 1 internal fn (require_session_attached); 2 external calls (load, store).


##### `ExecServerHandler::exec`  (lines 151–154)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, JSONRPCErrorError>
```

**Purpose**: Starts a process execution request on the attached session after enforcing initialization sequencing.

**Data flow**: Consumes `ExecParams`, obtains a `SessionHandle` via `require_initialized_for("exec")`, then awaits `session.process().exec(params)` and returns the resulting `ExecResponse` or JSON-RPC error.

**Call relations**: Called by the RPC exec method. It is a guarded delegation into the session’s process subsystem.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::environment_info`  (lines 156–159)

```
fn environment_info(&self) -> Result<EnvironmentInfo, JSONRPCErrorError>
```

**Purpose**: Returns local environment information once the connection has completed initialization.

**Data flow**: Calls `require_initialized_for("environment info")` only for validation, discards the returned session handle, and returns `EnvironmentInfo::local()`.

**Call relations**: Used by the environment-info RPC method. Unlike exec/filesystem methods, it does not delegate into the session beyond using it as an initialization gate.

*Call graph*: calls 1 internal fn (require_initialized_for); 1 external calls (local).


##### `ExecServerHandler::exec_read`  (lines 161–169)

```
async fn exec_read(
        &self,
        params: ReadParams,
    ) -> Result<ReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads process output from the attached session and then re-checks session attachment to detect resume-away races.

**Data flow**: Consumes `ReadParams`, gets the session via `require_initialized_for("exec")`, awaits `session.process().exec_read(params)`, then calls `require_session_attached()` again before returning the `ReadResponse`. If the session was resumed by another connection during the read, the second check returns an error instead of stale success.

**Call relations**: Called by the RPC read method and by higher-level long-polling flows. Its extra post-read check is a deliberate control-flow difference from the other exec methods.

*Call graph*: calls 2 internal fn (require_initialized_for, require_session_attached); called by 1 (read_process_until_closed).


##### `ExecServerHandler::exec_write`  (lines 171–177)

```
async fn exec_write(
        &self,
        params: WriteParams,
    ) -> Result<WriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes input to the attached process after enforcing initialization/session validity.

**Data flow**: Consumes `WriteParams`, obtains the session with `require_initialized_for("exec")`, awaits `session.process().exec_write(params)`, and returns the resulting `WriteResponse` or error.

**Call relations**: Called by the RPC write method as a guarded delegation into the session process handler.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::signal`  (lines 179–185)

```
async fn signal(
        &self,
        params: SignalParams,
    ) -> Result<SignalResponse, JSONRPCErrorError>
```

**Purpose**: Sends a signal to the attached process after initialization checks.

**Data flow**: Consumes `SignalParams`, gets the session via `require_initialized_for("exec")`, awaits `session.process().signal(params)`, and returns `SignalResponse` or error.

**Call relations**: Called by the RPC signal method and delegates to the session’s process control path.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::terminate`  (lines 187–193)

```
async fn terminate(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, JSONRPCErrorError>
```

**Purpose**: Terminates the attached process after initialization checks.

**Data flow**: Consumes `TerminateParams`, gets the session via `require_initialized_for("exec")`, awaits `session.process().terminate(params)`, and returns `TerminateResponse` or error.

**Call relations**: Called by the RPC terminate method and delegates to the session’s process control path.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::http_request`  (lines 195–234)

```
async fn http_request(
        self: &Arc<Self>,
        request_id: RequestId,
        params: HttpRequestParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Runs an outbound HTTP request on behalf of the client, sends the immediate response manually, and optionally starts background streaming of the response body.

**Data flow**: Takes `self: &Arc<Self>`, a `RequestId`, and `HttpRequestParams`. It first validates initialization for the `http` method family. If `params.stream_response` is true, it reserves `params.request_id` in `active_body_stream_ids`. It constructs `ReqwestHttpRequestRunner::new(params.timeout_ms)?`, awaits `.run(params)`, and if that fails after reserving a stream id, releases the id before returning the error. On success it receives `(response, pending_stream)`, serializes `response` with `serde_json::to_value`, releasing any pending stream id and returning `internal_error` if serialization fails. It then sends the response manually with `self.notifications.response(request_id, result).await`; if that send fails, it also releases any pending stream id. Finally, if a `PendingReqwestHttpBodyStream` remains, it starts background streaming with `start_http_body_stream` and returns `Ok(())`.

**Call relations**: Called by the RPC route for HTTP requests, specifically through the router path that gives handlers the request id. It coordinates `reserve_http_body_stream`, `RpcNotificationSender::response`, and `start_http_body_stream` to split immediate response delivery from later body streaming.

*Call graph*: calls 7 internal fn (new, response, internal_error, release_http_body_stream, require_initialized_for, reserve_http_body_stream, start_http_body_stream); 1 external calls (to_value).


##### `ExecServerHandler::fs_read_file`  (lines 236–242)

```
async fn fs_read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a whole-file read request to the embedded filesystem handler after initialization checks.

**Data flow**: Consumes `FsReadFileParams`, validates with `require_initialized_for("filesystem")`, then awaits `self.file_system.read_file(params)` and returns its result.

**Call relations**: Called by the filesystem RPC route for `fs/readFile`. It is a guarded pass-through to `FileSystemHandler`.

*Call graph*: calls 2 internal fn (read_file, require_initialized_for).


##### `ExecServerHandler::fs_open`  (lines 244–250)

```
async fn fs_open(
        &self,
        params: FsOpenParams,
    ) -> Result<FsOpenResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a file-open-for-block-reading request to the filesystem handler after initialization checks.

**Data flow**: Consumes `FsOpenParams`, validates initialization for `filesystem`, awaits `self.file_system.open(params)`, and returns `FsOpenResponse` or error.

**Call relations**: Called by the `fs/open` RPC route and forwards into the stateful file-read subsystem.

*Call graph*: calls 2 internal fn (open, require_initialized_for).


##### `ExecServerHandler::fs_read_block`  (lines 252–258)

```
async fn fs_read_block(
        &self,
        params: FsReadBlockParams,
    ) -> Result<FsReadBlockResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a block-read request on an open file handle after initialization checks.

**Data flow**: Consumes `FsReadBlockParams`, validates initialization for `filesystem`, awaits `self.file_system.read_block(params)`, and returns `FsReadBlockResponse` or error.

**Call relations**: Called by the `fs/readBlock` RPC route as part of the open/read/close file-read flow.

*Call graph*: calls 2 internal fn (read_block, require_initialized_for).


##### `ExecServerHandler::fs_close`  (lines 260–266)

```
async fn fs_close(
        &self,
        params: FsCloseParams,
    ) -> Result<FsCloseResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a file-read handle close request after initialization checks.

**Data flow**: Consumes `FsCloseParams`, validates initialization for `filesystem`, awaits `self.file_system.close(params)`, and returns `FsCloseResponse` or error.

**Call relations**: Called by the `fs/close` RPC route to end a stateful file-read session.

*Call graph*: calls 2 internal fn (close, require_initialized_for).


##### `ExecServerHandler::fs_write_file`  (lines 268–274)

```
async fn fs_write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a whole-file write request to the filesystem handler after initialization checks.

**Data flow**: Consumes `FsWriteFileParams`, validates initialization for `filesystem`, awaits `self.file_system.write_file(params)`, and returns `FsWriteFileResponse` or error.

**Call relations**: Called by the `fs/writeFile` RPC route.

*Call graph*: calls 2 internal fn (write_file, require_initialized_for).


##### `ExecServerHandler::fs_create_directory`  (lines 276–282)

```
async fn fs_create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a directory creation request after initialization checks.

**Data flow**: Consumes `FsCreateDirectoryParams`, validates initialization for `filesystem`, awaits `self.file_system.create_directory(params)`, and returns `FsCreateDirectoryResponse` or error.

**Call relations**: Called by the `fs/createDirectory` RPC route.

*Call graph*: calls 2 internal fn (create_directory, require_initialized_for).


##### `ExecServerHandler::fs_get_metadata`  (lines 284–290)

```
async fn fs_get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a metadata lookup request after initialization checks.

**Data flow**: Consumes `FsGetMetadataParams`, validates initialization for `filesystem`, awaits `self.file_system.get_metadata(params)`, and returns `FsGetMetadataResponse` or error.

**Call relations**: Called by the `fs/getMetadata` RPC route.

*Call graph*: calls 2 internal fn (get_metadata, require_initialized_for).


##### `ExecServerHandler::fs_canonicalize`  (lines 292–298)

```
async fn fs_canonicalize(
        &self,
        params: FsCanonicalizeParams,
    ) -> Result<FsCanonicalizeResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a path canonicalization request after initialization checks.

**Data flow**: Consumes `FsCanonicalizeParams`, validates initialization for `filesystem`, awaits `self.file_system.canonicalize(params)`, and returns `FsCanonicalizeResponse` or error.

**Call relations**: Called by the `fs/canonicalize` RPC route.

*Call graph*: calls 2 internal fn (canonicalize, require_initialized_for).


##### `ExecServerHandler::fs_read_directory`  (lines 300–306)

```
async fn fs_read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a directory listing request after initialization checks.

**Data flow**: Consumes `FsReadDirectoryParams`, validates initialization for `filesystem`, awaits `self.file_system.read_directory(params)`, and returns `FsReadDirectoryResponse` or error.

**Call relations**: Called by the `fs/readDirectory` RPC route.

*Call graph*: calls 2 internal fn (read_directory, require_initialized_for).


##### `ExecServerHandler::fs_remove`  (lines 308–314)

```
async fn fs_remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a remove request after initialization checks.

**Data flow**: Consumes `FsRemoveParams`, validates initialization for `filesystem`, awaits `self.file_system.remove(params)`, and returns `FsRemoveResponse` or error.

**Call relations**: Called by the `fs/remove` RPC route.

*Call graph*: calls 2 internal fn (remove, require_initialized_for).


##### `ExecServerHandler::fs_copy`  (lines 316–322)

```
async fn fs_copy(
        &self,
        params: FsCopyParams,
    ) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Delegates a copy request after initialization checks.

**Data flow**: Consumes `FsCopyParams`, validates initialization for `filesystem`, awaits `self.file_system.copy(params)`, and returns `FsCopyResponse` or error.

**Call relations**: Called by the `fs/copy` RPC route.

*Call graph*: calls 2 internal fn (copy, require_initialized_for).


##### `ExecServerHandler::require_initialized_for`  (lines 324–340)

```
fn require_initialized_for(
        &self,
        method_family: &str,
    ) -> Result<SessionHandle, JSONRPCErrorError>
```

**Purpose**: Enforces the connection handshake and session-attachment invariants before allowing a method family to run.

**Data flow**: Reads `initialize_requested`; if false, returns `invalid_request` stating the client must call `initialize` first. It then calls `require_session_attached()` to obtain a `SessionHandle`. Next it reads `initialized`; if false, returns `invalid_request` stating the client must send `initialized` before using the named method family. On success it returns the session handle.

**Call relations**: This is the common guard used by nearly every operational method in the handler. It centralizes sequencing and resumed-session rejection logic.

*Call graph*: calls 2 internal fn (invalid_request, require_session_attached); called by 18 (environment_info, exec, exec_read, exec_write, fs_canonicalize, fs_close, fs_copy, fs_create_directory, fs_get_metadata, fs_open (+8 more)); 2 external calls (load, format!).


##### `ExecServerHandler::require_session_attached`  (lines 342–355)

```
fn require_session_attached(&self) -> Result<SessionHandle, JSONRPCErrorError>
```

**Purpose**: Returns the current session handle only if one exists and it is still attached to this connection.

**Data flow**: Calls `self.session()`; if there is no session, returns `invalid_request("client must call initialize before using methods")`. If a session exists and `session.is_session_attached()` is true, it returns that handle; otherwise it returns `invalid_request("session has been resumed by another connection")`.

**Call relations**: Used by `initialized`, `exec_read`, and `require_initialized_for` to distinguish missing initialization from a session that has been taken over by another connection.

*Call graph*: calls 2 internal fn (invalid_request, session); called by 3 (exec_read, initialized, require_initialized_for).


##### `ExecServerHandler::session`  (lines 357–362)

```
fn session(&self) -> Option<SessionHandle>
```

**Purpose**: Reads and clones the currently stored optional session handle from the standard mutex.

**Data flow**: Locks `self.session`, recovering from poisoning with `PoisonError::into_inner`, clones the `Option<SessionHandle>`, and returns it.

**Call relations**: Private accessor used by shutdown and the session-validation helpers so they can inspect the current attachment state without holding the mutex across async work.

*Call graph*: called by 3 (is_session_attached, require_session_attached, shutdown); 1 external calls (lock).


##### `ExecServerHandler::start_http_body_stream`  (lines 364–384)

```
async fn start_http_body_stream(
        self: &Arc<Self>,
        pending_stream: PendingReqwestHttpBodyStream,
    )
```

**Purpose**: Launches a tracked background task that streams an HTTP response body to the client and always releases the reserved stream id when finished.

**Data flow**: Takes `self: &Arc<Self>` and a `PendingReqwestHttpBodyStream`. It clones the request id and, if `background_task_shutdown` is already cancelled, immediately releases the stream id and returns. Otherwise it clones `self`, `notifications`, and the shutdown token, then spawns a tracked task that `tokio::select!`s between shutdown cancellation and `ReqwestHttpRequestRunner::stream_body(pending_stream, notifications)`. After either branch completes, it awaits `handler.release_http_body_stream(&finished_request_id)`.

**Call relations**: Called only from `http_request` after the immediate response has been sent and a body stream remains. It ties together background task tracking, cancellation, and stream-id cleanup.

*Call graph*: calls 1 internal fn (release_http_body_stream); called by 1 (http_request); 6 external calls (clone, clone, is_cancelled, spawn, clone, select!).


##### `ExecServerHandler::release_http_body_stream`  (lines 386–389)

```
async fn release_http_body_stream(&self, request_id: &str)
```

**Purpose**: Removes a request id from the set of active streamed HTTP body responses.

**Data flow**: Locks `active_body_stream_ids` and removes `request_id` from the `HashSet`, returning no value.

**Call relations**: Used on all completion and error paths for streamed HTTP responses, both directly from `http_request` and from the background task started by `start_http_body_stream`.

*Call graph*: called by 2 (http_request, start_http_body_stream).


##### `ExecServerHandler::reserve_http_body_stream`  (lines 391–400)

```
async fn reserve_http_body_stream(&self, request_id: &str) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Claims a request id for a streamed HTTP response and rejects duplicates on the same connection.

**Data flow**: Locks `active_body_stream_ids`, checks whether `request_id` is already present, returns `invalid_params` with a formatted message if so, otherwise inserts `request_id.to_string()` into the set and returns `Ok(())`.

**Call relations**: Called by `http_request` before starting a streamed response. It prevents overlapping body streams from reusing the same logical request id.

*Call graph*: calls 1 internal fn (invalid_params); called by 1 (http_request); 1 external calls (format!).


### `exec-server/src/rpc.rs`

`io_transport` · `connection setup, request/response exchange, and disconnect handling`

This file is the transport-facing core of the project’s JSON-RPC layer. On the server side, `RpcRouter<S>` stores request and notification handlers keyed by method name. Its registration methods wrap typed async handlers into erased closures that decode `serde_json::Value` params, invoke the handler with shared `Arc<S>` state, and convert either successful results or typed `JSONRPCErrorError` failures into `RpcServerOutboundMessage`. `request_with_id` is the special case for handlers that reply manually and therefore may produce no automatic response message.

`RpcNotificationSender` is the outbound half used by handlers to push notifications or explicit responses onto an `mpsc::Sender<RpcServerOutboundMessage>`. It serializes params/results to JSON values and converts channel closure into internal JSON-RPC errors.

On the client side, `RpcClient` wraps a `JsonRpcConnection`. It owns the write channel, a `pending` map from `RequestId` to oneshot senders, a disconnect watch receiver, and spawned transport/reader tasks. `RpcClient::new` launches a reader task that consumes ordered connection events, routes responses/errors back to the matching pending request, forwards notifications as `RpcClientEvent`s, emits a terminal `Disconnected` event, drains all still-pending calls with `RpcCallError::Closed`, and terminates the underlying transport. `call` carefully inserts the pending request while holding the mutex and checking the disconnect watch atomically, preventing a race where a request could be registered after disconnect draining and hang forever. Helper functions encode outbound server messages, construct standard JSON-RPC error objects, and decode params with a deliberate empty-object-to-null fallback so methods expecting unit/null params still accept `{}`.

#### Function details

##### `RpcNotificationSender::new`  (lines 71–73)

```
fn new(outgoing_tx: mpsc::Sender<RpcServerOutboundMessage>) -> Self
```

**Purpose**: Builds a lightweight sender wrapper for outbound server-side JSON-RPC messages.

**Data flow**: Takes an `mpsc::Sender<RpcServerOutboundMessage>`, stores it in `outgoing_tx`, and returns a clonable `RpcNotificationSender` with no additional state.

**Call relations**: Created during connection setup and passed into server handlers that need to emit notifications or manual responses. It is the common outbound path used after routing has already selected a handler.

*Call graph*: called by 6 (default, active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, run_connection).


##### `RpcNotificationSender::response`  (lines 75–84)

```
async fn response(
        &self,
        request_id: RequestId,
        result: Value,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Queues a JSON-RPC success response message for a specific request id.

**Data flow**: Accepts a `RequestId` and already-serialized `serde_json::Value` result, wraps them in `RpcServerOutboundMessage::Response`, and awaits sending on `outgoing_tx`. If the channel is closed, it converts that transport failure into an internal JSON-RPC error.

**Call relations**: Used by handlers that need to reply outside the router’s automatic response path, notably long-running/manual-response flows. It delegates actual delivery to the outbound channel consumed by the connection writer.

*Call graph*: called by 1 (http_request); 1 external calls (send).


##### `RpcNotificationSender::notify`  (lines 86–101)

```
async fn notify(
        &self,
        method: &str,
        params: &P,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Serializes typed notification params and queues a JSON-RPC notification to the remote peer.

**Data flow**: Takes a method name and serializable params, converts params with `serde_json::to_value`, constructs a `JSONRPCNotification` with `Some(params)`, wraps it in `RpcServerOutboundMessage::Notification`, and sends it on `outgoing_tx`. Serialization errors and closed-channel errors are both mapped to internal JSON-RPC errors.

**Call relations**: Called by server-side streaming or event code when it needs to push unsolicited messages to the client. It sits downstream of business logic and upstream of the connection writer.

*Call graph*: called by 1 (send_body_delta); 3 external calls (send, Notification, to_value).


##### `RpcRouter::default`  (lines 110–115)

```
fn default() -> Self
```

**Purpose**: Creates an empty router with no registered request or notification handlers.

**Data flow**: Allocates fresh empty `HashMap`s for `request_routes` and `notification_routes` and returns the initialized `RpcRouter`.

**Call relations**: Used as the base constructor for router setup. Higher-level router-building code starts here and then registers methods through `request`, `request_with_id`, and `notification`.

*Call graph*: 1 external calls (new).


##### `RpcRouter::new`  (lines 122–124)

```
fn new() -> Self
```

**Purpose**: Convenience constructor for an empty typed router.

**Data flow**: Returns `Self::default()`, producing a router with empty route maps and no side effects.

**Call relations**: Called by router assembly code before individual methods are registered. It is just the public-facing entry to the default initialization path.

*Call graph*: called by 1 (build_router); 1 external calls (default).


##### `RpcRouter::request`  (lines 126–160)

```
fn request(&mut self, method: &'static str, handler: F)
```

**Purpose**: Registers a typed request handler that automatically decodes params and emits either a JSON-RPC response or error.

**Data flow**: Takes a method name and a handler `Fn(Arc<S>, P) -> Fut`. It stores a boxed closure in `request_routes` that extracts `request.id` and `request.params`, decodes params into `P`, invokes the handler future on success, awaits it, serializes the returned `R` into `Value`, and produces `Some(RpcServerOutboundMessage::Response)` or `Some(...::Error)` depending on decode, handler, or serialization outcome.

**Call relations**: Used during router construction for ordinary request/response methods. Later, connection-processing code looks up the route with `request_route` and executes the stored closure to obtain the outbound message.

*Call graph*: 1 external calls (new).


##### `RpcRouter::request_with_id`  (lines 162–188)

```
fn request_with_id(&mut self, method: &'static str, handler: F)
```

**Purpose**: Registers a typed request handler that receives the request id and may choose to send its own response later, returning no automatic success message.

**Data flow**: Accepts a method name and handler `Fn(Arc<S>, RequestId, P) -> Fut`, stores a boxed closure that decodes params, invokes the handler with the cloned request id, awaits it, and returns `None` on success or `Some(RpcServerOutboundMessage::Error)` on decode/handler failure.

**Call relations**: Used for methods whose response is emitted manually through `RpcNotificationSender::response`, such as asynchronous or streaming workflows. The router still handles invalid params and explicit handler errors centrally.

*Call graph*: 1 external calls (new).


##### `RpcRouter::notification`  (lines 190–210)

```
fn notification(&mut self, method: &'static str, handler: F)
```

**Purpose**: Registers a typed notification handler that decodes params and returns only success/failure, with no response message.

**Data flow**: Takes a method name and handler `Fn(Arc<S>, P) -> Fut`, stores a boxed closure that decodes notification params into `P`, invokes the handler future, awaits it, and returns `Result<(), String>` where decode failures are stringified.

**Call relations**: Used during router setup for fire-and-forget methods. Later dispatch code retrieves these closures with `notification_route` and runs them when a notification arrives.

*Call graph*: 1 external calls (new).


##### `RpcRouter::request_route`  (lines 212–214)

```
fn request_route(&self, method: &str) -> Option<&RequestRoute<S>>
```

**Purpose**: Looks up the registered request route closure for a method name.

**Data flow**: Reads `self.request_routes` and returns an `Option<&RequestRoute<S>>` borrowed from the map, without mutation.

**Call relations**: Called by connection dispatch code when an incoming JSON-RPC request arrives. It is the method-selection step before invoking the stored boxed handler.


##### `RpcRouter::notification_route`  (lines 216–218)

```
fn notification_route(&self, method: &str) -> Option<&NotificationRoute<S>>
```

**Purpose**: Looks up the registered notification route closure for a method name.

**Data flow**: Reads `self.notification_routes` and returns an optional borrowed route reference from the map.

**Call relations**: Used by notification dispatch logic to decide whether and how to process an incoming notification.


##### `RpcClient::new`  (lines 235–293)

```
fn new(connection: JsonRpcConnection) -> (Self, mpsc::Receiver<RpcClientEvent>)
```

**Purpose**: Wraps a `JsonRpcConnection` into a higher-level RPC client, spawns the reader task, and returns both the client and an event stream for notifications/disconnects.

**Data flow**: Consumes a `JsonRpcConnection`, extracting its write sender, incoming event receiver, disconnect watch receiver, transport task handles, and transport object. It creates a shared `pending` map protected by `tokio::sync::Mutex`, an `mpsc` channel for `RpcClientEvent`s, and spawns a reader task. That task loops over `incoming_rx.recv()`, forwarding messages to `handle_server_message`, stopping on malformed input or disconnect, then sends a terminal `RpcClientEvent::Disconnected`, calls `drain_pending` to fail all unresolved requests, and terminates the transport. The constructor returns a populated `RpcClient` plus the event receiver.

**Call relations**: Called when a transport connection has already been established and needs RPC semantics layered on top. Its spawned reader task is central to all later `call` and notification flows.

*Call graph*: calls 2 internal fn (drain_pending, handle_server_message); called by 2 (connect, rpc_client_matches_out_of_order_responses_by_request_id); 7 external calls (clone, new, new, new, new, channel, spawn).


##### `RpcClient::notify`  (lines 295–313)

```
async fn notify(
        &self,
        method: &str,
        params: &P,
    ) -> Result<(), serde_json::Error>
```

**Purpose**: Sends a client-originated JSON-RPC notification over the connection.

**Data flow**: Serializes the provided params to `serde_json::Value`, constructs `JSONRPCMessage::Notification(JSONRPCNotification { method, params: Some(...) })`, and sends it on `write_tx`. If the channel is closed, it synthesizes a `serde_json::Error` backed by a broken-pipe I/O error.

**Call relations**: Used by client-side code for fire-and-forget RPC methods. It bypasses the pending-request machinery because no response is expected.

*Call graph*: 3 external calls (send, Notification, to_value).


##### `RpcClient::is_disconnected`  (lines 315–317)

```
fn is_disconnected(&self) -> bool
```

**Purpose**: Reports whether the underlying transport has already been marked disconnected.

**Data flow**: Borrows the current boolean from `disconnected_rx` and returns its copied value.

**Call relations**: Called by higher-level code that wants a cheap transport-health check without issuing a request. It reflects state maintained by the underlying connection layer.

*Call graph*: 1 external calls (borrow).


##### `RpcClient::call`  (lines 319–372)

```
async fn call(&self, method: &str, params: &P) -> Result<T, RpcCallError>
```

**Purpose**: Performs a typed JSON-RPC request/response round trip with request-id matching, disconnect safety, and typed result deserialization.

**Data flow**: Generates a fresh integer `RequestId` using `next_request_id.fetch_add`, creates a oneshot channel, and locks `pending` to atomically check `disconnected_rx` and insert the sender. It serializes params to `Value`; on serialization failure it removes the pending entry and returns `RpcCallError::Json`. It then sends a `JSONRPCMessage::Request` on `write_tx`; if sending fails it removes the pending entry and returns `Closed`. Finally it awaits the oneshot receiver, which is fulfilled by the reader task via `handle_server_message`, unwraps either a `Value` or `RpcCallError`, and deserializes the value into `T` with `serde_json::from_value`, mapping decode failures to `RpcCallError::Json`.

**Call relations**: This is the main synchronous-looking client API used after `RpcClient::new`. It relies on the reader task to preserve ordering between received responses and disconnect handling, and on `drain_pending` to fail truly unresolved calls.

*Call graph*: 9 external calls (fetch_add, send, Request, Integer, Json, borrow, channel, from_value, to_value).


##### `RpcClient::pending_request_count`  (lines 375–377)

```
async fn pending_request_count(&self) -> usize
```

**Purpose**: Test-only helper that reports how many requests are currently waiting for responses.

**Data flow**: Locks the `pending` map and returns its `len()`.

**Call relations**: Used only in tests to assert that response handling cleaned up all pending entries.


##### `RpcClient::drop`  (lines 381–387)

```
fn drop(&mut self)
```

**Purpose**: Aborts all transport-related tasks and terminates the underlying transport when the client is dropped.

**Data flow**: Calls `self.transport.terminate()`, iterates over `transport_tasks` aborting each join handle, and aborts `reader_task`. It performs cleanup side effects only and returns nothing.

**Call relations**: Runs automatically at client teardown. It is the final cleanup path for resources created in `RpcClient::new`.

*Call graph*: calls 1 internal fn (terminate); 1 external calls (abort).


##### `encode_server_message`  (lines 390–410)

```
fn encode_server_message(
    message: RpcServerOutboundMessage,
) -> Result<JSONRPCMessage, serde_json::Error>
```

**Purpose**: Converts an internal outbound server message enum into the wire-level `JSONRPCMessage` representation.

**Data flow**: Matches on `RpcServerOutboundMessage`: `Response` becomes `JSONRPCMessage::Response(JSONRPCResponse { ... })`, `Error` becomes `JSONRPCMessage::Error(JSONRPCError { ... })`, and `Notification` passes through as `JSONRPCMessage::Notification`. It returns the encoded message or a serialization error type for API symmetry, though the conversion itself is structural.

**Call relations**: Used by connection-writing code after server handlers or router closures have produced an internal outbound message.

*Call graph*: called by 1 (run_connection); 3 external calls (Error, Notification, Response).


##### `invalid_request`  (lines 412–418)

```
fn invalid_request(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC invalid-request error object with code `-32600`.

**Data flow**: Takes a message string and returns `JSONRPCErrorError { code: -32600, data: None, message }`.

**Call relations**: Called throughout request validation paths when the shape or sequencing of a request is wrong.

*Call graph*: called by 12 (map_fs_error, sandbox_cwd, spawn_command, exec_read, start_process, map_fs_error, validate_file_read_handle_id, initialize, require_initialized_for, require_session_attached (+2 more)).


##### `method_not_found`  (lines 420–426)

```
fn method_not_found(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC method-not-found error object with code `-32601`.

**Data flow**: Wraps the provided message into `JSONRPCErrorError` with code `-32601` and no extra data.

**Call relations**: Used by dispatch code when no route exists for an incoming method.

*Call graph*: called by 1 (run_connection).


##### `invalid_params`  (lines 428–434)

```
fn invalid_params(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC invalid-params error object with code `-32602`.

**Data flow**: Returns `JSONRPCErrorError { code: -32602, data: None, message }` from the supplied message string.

**Call relations**: Used by parameter decoding and validation code, including the decode helpers in this file.

*Call graph*: called by 3 (run, start_process_rejects_non_native_cwd_before_launch, reserve_http_body_stream).


##### `not_found`  (lines 436–442)

```
fn not_found(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds an application-specific not-found error object with code `-32004`.

**Data flow**: Packages the message into `JSONRPCErrorError` with code `-32004` and no data.

**Call relations**: Used by filesystem and similar handlers to preserve not-found semantics across JSON-RPC boundaries.

*Call graph*: called by 2 (map_fs_error, map_fs_error).


##### `internal_error`  (lines 444–450)

```
fn internal_error(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC internal-error object with code `-32603`.

**Data flow**: Returns a `JSONRPCErrorError` containing the provided message, code `-32603`, and `data: None`.

**Call relations**: Used as the generic fallback when serialization, transport, or unexpected internal failures occur.

*Call graph*: called by 9 (run, map_fs_error, unexpected_response, io_error, json_error, run_command, start_process, map_fs_error, http_request).


##### `decode_request_params`  (lines 452–457)

```
fn decode_request_params(params: Option<Value>) -> Result<P, JSONRPCErrorError>
```

**Purpose**: Decodes request params into a typed value and maps JSON decode failures into JSON-RPC invalid-params errors.

**Data flow**: Accepts `Option<Value>`, delegates to `decode_params::<P>`, and on error wraps the serde error string with `invalid_params`.

**Call relations**: Used inside `RpcRouter::request` and `RpcRouter::request_with_id` so route closures can reject malformed request payloads uniformly.

*Call graph*: calls 1 internal fn (decode_params).


##### `decode_notification_params`  (lines 459–464)

```
fn decode_notification_params(params: Option<Value>) -> Result<P, String>
```

**Purpose**: Decodes notification params into a typed value and returns plain string errors suitable for notification handlers.

**Data flow**: Delegates to `decode_params::<P>` and converts any serde error into `String` via `to_string()`.

**Call relations**: Used by `RpcRouter::notification`, where there is no JSON-RPC response object to carry a structured error.

*Call graph*: calls 1 internal fn (decode_params).


##### `decode_params`  (lines 466–481)

```
fn decode_params(params: Option<Value>) -> Result<P, serde_json::Error>
```

**Purpose**: Performs the actual serde-based parameter decoding, with a compatibility fallback that treats an empty object like `null`.

**Data flow**: Takes `Option<Value>`, substitutes `Value::Null` when absent, and first tries `serde_json::from_value(params.clone())`. If that fails and the original value is an empty object, it retries decoding from `Value::Null`; otherwise it returns the original serde error.

**Call relations**: Shared by both request and notification decoding helpers. The empty-object fallback is a subtle compatibility rule that affects all routed methods.

*Call graph*: called by 2 (decode_notification_params, decode_request_params); 2 external calls (matches!, from_value).


##### `handle_server_message`  (lines 483–513)

```
async fn handle_server_message(
    pending: &Mutex<HashMap<RequestId, PendingRequest>>,
    event_tx: &mpsc::Sender<RpcClientEvent>,
    message: JSONRPCMessage,
) -> Result<(), String>
```

**Purpose**: Processes one incoming server-side JSON-RPC message for the client, resolving pending calls or forwarding notifications.

**Data flow**: Matches on `JSONRPCMessage`: for `Response`, it removes the matching pending sender from the mutex-protected map and sends `Ok(result)`; for `Error`, it removes the sender and sends `Err(RpcCallError::Server(error))`; for `Notification`, it forwards `RpcClientEvent::Notification` on `event_tx`; for unexpected `Request`, it returns an error string describing the invalid server behavior.

**Call relations**: Called only by the reader task spawned in `RpcClient::new`. Its return value controls whether the reader loop continues or terminates the connection.

*Call graph*: called by 1 (new); 4 external calls (send, Server, Notification, format!).


##### `drain_pending`  (lines 515–526)

```
async fn drain_pending(pending: &Mutex<HashMap<RequestId, PendingRequest>>)
```

**Purpose**: Fails every still-pending client request with `RpcCallError::Closed` after connection shutdown.

**Data flow**: Locks the `pending` map, drains all entries into a temporary vector of oneshot senders, releases the lock, then iterates that vector sending `Err(RpcCallError::Closed)` to each waiter.

**Call relations**: Invoked by the reader task at disconnect time so callers blocked in `RpcClient::call` do not wait forever.

*Call graph*: called by 1 (new).


##### `tests::read_jsonrpc_line`  (lines 543–564)

```
async fn read_jsonrpc_line(lines: &mut tokio::io::Lines<BufReader<R>>) -> JSONRPCMessage
```

**Purpose**: Test helper that reads one newline-delimited JSON-RPC message from an async buffered reader with a timeout and strict panic-on-failure behavior.

**Data flow**: Takes mutable access to `tokio::io::Lines<BufReader<R>>`, awaits `next_line()` under a one-second timeout, panics on timeout/read EOF/read error, parses the resulting line as `JSONRPCMessage` with `serde_json::from_str`, and returns the parsed message.

**Call relations**: Used by the integration-style RPC client test to emulate a server reading requests from the client transport.

*Call graph*: 4 external calls (from_secs, next_line, panic!, timeout).


##### `tests::write_jsonrpc_line`  (lines 566–577)

```
async fn write_jsonrpc_line(writer: &mut W, message: JSONRPCMessage)
```

**Purpose**: Test helper that serializes a JSON-RPC message and writes it as a newline-delimited frame to an async writer.

**Data flow**: Accepts a mutable writer and a `JSONRPCMessage`, serializes it with `serde_json::to_string`, appends `\n`, writes all bytes with `write_all`, and panics if serialization or writing fails.

**Call relations**: Used by the test server task to send crafted responses back to the client under test.

*Call graph*: 4 external calls (write_all, format!, panic!, to_string).


##### `tests::rpc_client_matches_out_of_order_responses_by_request_id`  (lines 580–643)

```
async fn rpc_client_matches_out_of_order_responses_by_request_id()
```

**Purpose**: Verifies that concurrent client calls are matched by request id rather than arrival order, even when responses are returned out of order.

**Data flow**: Creates paired in-memory duplex streams, wraps one side in `JsonRpcConnection` and `RpcClient`, and spawns a fake server task that reads two request messages, identifies which is `slow` and which is `fast`, then deliberately writes the `fast` response first and the `slow` response second. The test concurrently awaits both `client.call` futures, unwraps their results, asserts each received the correct payload, checks that the pending map is empty, and awaits the server task.

**Call relations**: Exercises the full `RpcClient::new` + reader task + `RpcClient::call` path, specifically validating the pending-request map and `handle_server_message` matching logic.

*Call graph*: calls 2 internal fn (from_stdio, new); 10 external calls (new, Response, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, panic!, json!, duplex, join!, spawn).


### `exec-server/src/server/file_system_handler.rs`

`domain_logic` · `filesystem request handling and connection shutdown`

This file is the filesystem RPC adapter used by the server connection handler. `FileSystemHandler` owns two concrete subsystems: a `LocalFileSystem` configured with `ExecServerRuntimePaths`, and a `FileReadHandleManager` used for stateful open/read-block/close streaming reads. The constructor wires those together, while `shutdown` closes all outstanding read handles during connection teardown.

The methods split into two groups. `open`, `read_block`, and `close` manage explicit file-read handles: `open` validates the caller-supplied handle id length, opens the file for reading through `LocalFileSystem`, registers it with `FileReadHandleManager`, and returns the effective handle id; `read_block` reads a byte range and returns both the chunk and EOF flag; `close` validates then silently closes the handle. The remaining methods are stateless whole-operation wrappers around `LocalFileSystem`: `read_file` and `write_file` convert file contents to/from base64 for JSON-RPC transport, `create_directory` and `remove` fill in default `recursive`/`force` values when omitted, `get_metadata` and `read_directory` map local structs into protocol response types, and `copy` forwards recursive copy options.

Two private helpers encode important policy. `validate_file_read_handle_id` caps handle ids at 32 bytes to bound resource-key size and rejects longer ids as invalid requests. `map_fs_error` preserves `NotFound` as JSON-RPC not-found, treats invalid input and permission errors as invalid requests, and collapses everything else to internal errors. The included test confirms that non-platform-sandbox policies still work without a configured sandbox helper because `LocalFileSystem` can service them directly.

#### Function details

##### `FileSystemHandler::new`  (lines 51–56)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Constructs the server-side filesystem handler with a local filesystem backend and an empty file-read handle registry.

**Data flow**: Takes `ExecServerRuntimePaths`, passes them to `LocalFileSystem::with_runtime_paths`, creates a default `FileReadHandleManager`, stores both in `FileSystemHandler`, and returns it.

**Call relations**: Called during server handler initialization so filesystem RPC methods have concrete backends to delegate to.

*Call graph*: calls 1 internal fn (with_runtime_paths); called by 2 (no_platform_sandbox_policies_do_not_require_configured_sandbox_helper, new); 1 external calls (default).


##### `FileSystemHandler::shutdown`  (lines 58–60)

```
async fn shutdown(&self)
```

**Purpose**: Closes all outstanding open file-read handles owned by this connection-scoped handler.

**Data flow**: Reads `self.file_reads` and awaits `close_all()`, producing no return value.

**Call relations**: Invoked during connection shutdown by the higher-level server handler to release per-connection file-read state.

*Call graph*: calls 1 internal fn (close_all); called by 1 (shutdown).


##### `FileSystemHandler::open`  (lines 62–78)

```
async fn open(
        &self,
        params: FsOpenParams,
    ) -> Result<FsOpenResponse, JSONRPCErrorError>
```

**Purpose**: Opens a file for block-based reading and registers it under a validated handle id.

**Data flow**: Consumes `FsOpenParams`, validates `params.handle_id`, awaits `self.file_system.open_file_for_read(&params.path, params.sandbox.as_ref())`, maps any `io::Error` through `map_fs_error`, then awaits `self.file_reads.open(params.handle_id, file)` and returns `FsOpenResponse { handle_id }`.

**Call relations**: Called by the RPC method handler for `fs/open`. It bridges stateless filesystem access into the stateful `FileReadHandleManager` flow used by `read_block` and `close`.

*Call graph*: calls 3 internal fn (open, open_file_for_read, validate_file_read_handle_id); called by 1 (fs_open).


##### `FileSystemHandler::read_block`  (lines 80–94)

```
async fn read_block(
        &self,
        params: FsReadBlockParams,
    ) -> Result<FsReadBlockResponse, JSONRPCErrorError>
```

**Purpose**: Reads a byte block from an already-open file handle and reports whether EOF was reached.

**Data flow**: Consumes `FsReadBlockParams`, validates `params.handle_id`, awaits `self.file_reads.read_block(&params.handle_id, params.offset, params.len)`, maps errors with `map_fs_error`, and returns `FsReadBlockResponse { chunk: block.bytes.into(), eof: block.eof }`.

**Call relations**: Called by the RPC method handler for `fs/readBlock` after a prior successful `open`. It depends on the handle registry populated by `FileSystemHandler::open`.

*Call graph*: calls 2 internal fn (read_block, validate_file_read_handle_id); called by 1 (fs_read_block).


##### `FileSystemHandler::close`  (lines 96–103)

```
async fn close(
        &self,
        params: FsCloseParams,
    ) -> Result<FsCloseResponse, JSONRPCErrorError>
```

**Purpose**: Closes a previously opened file-read handle after validating its identifier.

**Data flow**: Consumes `FsCloseParams`, validates `params.handle_id`, awaits `self.file_reads.close(&params.handle_id)`, and returns an empty `FsCloseResponse`.

**Call relations**: Called by the RPC method handler for `fs/close` to end the stateful file-read lifecycle started by `open`.

*Call graph*: calls 2 internal fn (close, validate_file_read_handle_id); called by 1 (fs_close).


##### `FileSystemHandler::read_file`  (lines 105–117)

```
async fn read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Reads an entire file and returns its contents encoded as base64 for JSON-RPC transport.

**Data flow**: Consumes `FsReadFileParams`, awaits `self.file_system.read_file(&params.path, params.sandbox.as_ref())`, maps errors with `map_fs_error`, base64-encodes the resulting bytes with `STANDARD.encode`, and returns `FsReadFileResponse { data_base64 }`.

**Call relations**: Called by the RPC method handler for whole-file reads. It is the stateless counterpart to the open/read-block/close path.

*Call graph*: calls 1 internal fn (read_file); called by 1 (fs_read_file).


##### `FileSystemHandler::write_file`  (lines 119–133)

```
async fn write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Decodes base64 file contents from the request and writes them to the target path.

**Data flow**: Consumes `FsWriteFileParams`, decodes `params.data_base64` with `STANDARD.decode`, mapping invalid base64 to `invalid_request` with a method-specific message, then awaits `self.file_system.write_file(&params.path, bytes, params.sandbox.as_ref())`, maps filesystem errors, and returns an empty `FsWriteFileResponse`.

**Call relations**: Called by the RPC method handler for `fs/writeFile`. It is the inverse of `read_file` and performs the transport-to-bytes conversion locally.

*Call graph*: calls 1 internal fn (write_file); called by 1 (fs_write_file).


##### `FileSystemHandler::create_directory`  (lines 135–149)

```
async fn create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Creates a directory, defaulting `recursive` to `true` when the request omits it.

**Data flow**: Consumes `FsCreateDirectoryParams`, computes `recursive = params.recursive.unwrap_or(true)`, awaits `self.file_system.create_directory(&params.path, CreateDirectoryOptions { recursive }, params.sandbox.as_ref())`, maps errors, and returns `FsCreateDirectoryResponse {}`.

**Call relations**: Called by the RPC method handler for directory creation. It adds protocol defaulting before delegating to the filesystem backend.

*Call graph*: calls 1 internal fn (create_directory); called by 1 (fs_create_directory).


##### `FileSystemHandler::get_metadata`  (lines 151–168)

```
async fn get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Fetches filesystem metadata and maps it into the protocol response shape.

**Data flow**: Consumes `FsGetMetadataParams`, awaits `self.file_system.get_metadata(&params.path, params.sandbox.as_ref())`, maps errors, and constructs `FsGetMetadataResponse` by copying the metadata fields `is_directory`, `is_file`, `is_symlink`, `size`, `created_at_ms`, and `modified_at_ms`.

**Call relations**: Called by the RPC method handler for metadata queries. It is a straightforward adapter from local metadata to protocol metadata.

*Call graph*: calls 1 internal fn (get_metadata); called by 1 (fs_get_metadata).


##### `FileSystemHandler::canonicalize`  (lines 170–180)

```
async fn canonicalize(
        &self,
        params: FsCanonicalizeParams,
    ) -> Result<FsCanonicalizeResponse, JSONRPCErrorError>
```

**Purpose**: Canonicalizes a path through the local filesystem backend and returns the resolved `PathUri`.

**Data flow**: Consumes `FsCanonicalizeParams`, awaits `self.file_system.canonicalize(&params.path, params.sandbox.as_ref())`, maps errors, and returns `FsCanonicalizeResponse { path }`.

**Call relations**: Called by the RPC method handler for path canonicalization requests.

*Call graph*: calls 1 internal fn (canonicalize); called by 1 (fs_canonicalize).


##### `FileSystemHandler::read_directory`  (lines 182–199)

```
async fn read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Lists directory entries and converts each local entry into the protocol entry struct.

**Data flow**: Consumes `FsReadDirectoryParams`, awaits `self.file_system.read_directory(&params.path, params.sandbox.as_ref())`, maps errors, transforms each returned entry into `FsReadDirectoryEntry { file_name, is_directory, is_file }`, collects them, and returns `FsReadDirectoryResponse { entries }`.

**Call relations**: Called by the RPC method handler for directory listing. It performs collection-level mapping from local to protocol types.

*Call graph*: calls 1 internal fn (read_directory); called by 1 (fs_read_directory).


##### `FileSystemHandler::remove`  (lines 201–216)

```
async fn remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Removes a file or directory, defaulting omitted `recursive` and `force` flags to `true`.

**Data flow**: Consumes `FsRemoveParams`, computes `recursive = params.recursive.unwrap_or(true)` and `force = params.force.unwrap_or(true)`, awaits `self.file_system.remove(&params.path, RemoveOptions { recursive, force }, params.sandbox.as_ref())`, maps errors, and returns `FsRemoveResponse {}`.

**Call relations**: Called by the RPC method handler for delete operations. It adds protocol defaulting before backend delegation.

*Call graph*: calls 1 internal fn (remove); called by 1 (fs_remove).


##### `FileSystemHandler::copy`  (lines 218–234)

```
async fn copy(
        &self,
        params: FsCopyParams,
    ) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Copies a file or directory using the local filesystem backend and the request’s recursive flag.

**Data flow**: Consumes `FsCopyParams`, awaits `self.file_system.copy(&params.source_path, &params.destination_path, CopyOptions { recursive: params.recursive }, params.sandbox.as_ref())`, maps errors, and returns `FsCopyResponse {}`.

**Call relations**: Called by the RPC method handler for copy operations.

*Call graph*: calls 1 internal fn (copy); called by 1 (fs_copy).


##### `validate_file_read_handle_id`  (lines 237–244)

```
fn validate_file_read_handle_id(handle_id: &str) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Rejects oversized file-read handle identifiers before they are used as keys in the handle manager.

**Data flow**: Checks `handle_id.len()` against `MAX_FILE_READ_HANDLE_ID_BYTES` (32). If the id is too long, it returns `invalid_request` with a formatted message; otherwise it returns `Ok(())`.

**Call relations**: Used by `open`, `read_block`, and `close` to enforce a shared precondition on the stateful file-read API.

*Call graph*: calls 1 internal fn (invalid_request); called by 3 (close, open, read_block); 1 external calls (format!).


##### `map_fs_error`  (lines 246–254)

```
fn map_fs_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts local `io::Error` values into the JSON-RPC error codes used by filesystem methods.

**Data flow**: Matches `err.kind()`: `NotFound` becomes `not_found(err.to_string())`; `InvalidInput` and `PermissionDenied` become `invalid_request(err.to_string())`; all other kinds become `internal_error(err.to_string())`.

**Call relations**: Applied by nearly every handler method after delegating to `LocalFileSystem` or `FileReadHandleManager`, making it the central error-policy boundary for filesystem RPCs.

*Call graph*: calls 3 internal fn (internal_error, invalid_request, not_found); 2 external calls (kind, to_string).


##### `tests::no_platform_sandbox_policies_do_not_require_configured_sandbox_helper`  (lines 269–331)

```
async fn no_platform_sandbox_policies_do_not_require_configured_sandbox_helper()
```

**Purpose**: Verifies that filesystem operations under non-platform-sandbox policies succeed without configuring a sandbox helper executable.

**Data flow**: Creates a temporary directory and runtime paths using the current executable with no Linux sandbox alias, constructs `FileSystemHandler`, derives sandbox contexts for `DangerFullAccess` and `ExternalSandbox`, writes a file via `write_file`, canonicalizes it via `canonicalize`, reads it back via `read_file`, and asserts both the canonical path and base64 contents match expectations for each policy.

**Call relations**: Exercises the handler’s delegation to `LocalFileSystem`, specifically confirming that policies not requiring platform sandboxing do not depend on helper configuration.

*Call graph*: calls 3 internal fn (new, new, from_path); 3 external calls (assert_eq!, current_exe, tempdir).


### `exec-server/src/server/registry.rs`

`orchestration` · `connection setup and request dispatch`

This file builds the server-side dispatch table used by the connection processor. `build_router` starts from an empty `RpcRouter<ExecServerHandler>` and incrementally registers both notifications and requests, pairing each protocol method constant with a closure that receives an `Arc<ExecServerHandler>` plus deserialized parameters of the correct concrete type.

The registration is exhaustive across the exec-server surface shown here. It wires the initialization handshake (`INITIALIZE_METHOD`, `INITIALIZED_METHOD`), environment inspection, HTTP requests, process execution (`EXEC_METHOD`, `EXEC_READ_METHOD`, `EXEC_WRITE_METHOD`, `EXEC_SIGNAL_METHOD`, `EXEC_TERMINATE_METHOD`), and a broad set of filesystem operations including open/read/close, whole-file reads and writes, metadata, canonicalization, directory listing, removal, copy, and directory creation. Most routes use `router.request`, while `HTTP_REQUEST_METHOD` uses `request_with_id` so the handler can see the JSON-RPC request id directly.

The important design choice is that this file contains no business logic of its own: each closure is a thin typed adapter that forwards to the corresponding `ExecServerHandler` method, preserving async behavior and letting the router own parameter decoding and response shaping. Because the processor consults this router for every inbound message, this file effectively defines the protocol surface area the server currently implements.

#### Function details

##### `build_router`  (lines 44–163)

```
fn build_router() -> RpcRouter<ExecServerHandler>
```

**Purpose**: Constructs and returns the complete `RpcRouter<ExecServerHandler>` used to dispatch JSON-RPC methods to typed handler calls. It binds every supported method string to the exact `ExecServerHandler` operation that implements it.

**Data flow**: Creates a mutable `RpcRouter`, registers one notification route for `INITIALIZED_METHOD`, multiple request routes for initialize, HTTP, environment info, exec/process operations, and filesystem operations, then returns the populated router. Each registration captures no external mutable state beyond forwarding the provided `Arc<ExecServerHandler>` and deserialized params into the corresponding handler method.

**Call relations**: Called by the connection processor at the start of `run_connection` to obtain request and notification dispatch closures. The processor later queries this router for each inbound method name to decide whether to invoke a handler, return method-not-found, or close on unexpected notifications.

*Call graph*: calls 1 internal fn (new); called by 1 (run_connection).


### `exec-server/src/server/process_handler.rs`

`domain_logic` · `request handling and session attachment/detachment`

This file defines `ProcessHandler`, a small wrapper struct containing a single `LocalProcess`. Its job is not to add business logic, but to present the exact async methods the server/session code expects while hiding the concrete process implementation behind a stable interface. Construction requires an initial `RpcNotificationSender`, which is passed directly into `LocalProcess::new` so process lifecycle and output events can be emitted to the active connection.

Every public method is a direct delegation. `shutdown` forwards to the underlying process subsystem to stop background work and clean up running processes. `set_notification_sender` swaps the optional notification sink, which is important during session detach and resume: a detached session can disable notifications without destroying process state, and a resumed session can install a new sender. The request methods (`exec`, `exec_read`, `exec_write`, `signal`, `terminate`) all accept the corresponding protocol parameter structs and return protocol response structs or `JSONRPCErrorError`, preserving the JSON-RPC-facing contract while keeping transport code independent of `LocalProcess` internals.

Because `ProcessHandler` derives `Clone`, higher-level session objects can share the same underlying process manager across connection transitions. The design choice here is explicit layering: session management talks to `ProcessHandler`, not directly to `LocalProcess`, which keeps attachment logic and process execution logic decoupled.

#### Function details

##### `ProcessHandler::new`  (lines 22–26)

```
fn new(notifications: RpcNotificationSender) -> Self
```

**Purpose**: Constructs a new process façade backed by a fresh `LocalProcess` configured with an outbound notification sender. It is the creation point for per-session process state.

**Data flow**: Takes a `RpcNotificationSender`, passes it into `LocalProcess::new`, stores the resulting `LocalProcess` in the `process` field, and returns `ProcessHandler`.

**Call relations**: This constructor is used when a new session is attached for the first time. The session registry calls it while creating a `SessionEntry`, so each session gets its own process manager.

*Call graph*: calls 1 internal fn (new); called by 1 (attach).


##### `ProcessHandler::shutdown`  (lines 28–30)

```
async fn shutdown(&self)
```

**Purpose**: Stops the underlying process subsystem and waits for its shutdown to complete. It is used when a session is being permanently torn down.

**Data flow**: Reads `self.process` and awaits `LocalProcess::shutdown()`. It returns no value and performs cleanup through the underlying process manager.

**Call relations**: Higher-level session cleanup paths invoke this when a detached session expires or a connection processor is shutting down. It delegates all actual termination and resource cleanup to `LocalProcess`.

*Call graph*: calls 1 internal fn (shutdown).


##### `ProcessHandler::set_notification_sender`  (lines 32–34)

```
fn set_notification_sender(&self, notifications: Option<RpcNotificationSender>)
```

**Purpose**: Replaces or clears the notification sink used by the process subsystem. This lets session management detach a connection without discarding process state.

**Data flow**: Accepts an `Option<RpcNotificationSender>` and forwards it to `self.process.set_notification_sender`. It mutates the underlying process manager's notification destination and returns nothing.

**Call relations**: Session attachment code installs a new sender on resume, and session detachment clears the sender so no stale connection receives notifications. The method exists specifically to support session mobility.

*Call graph*: calls 1 internal fn (set_notification_sender).


##### `ProcessHandler::exec`  (lines 36–38)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, JSONRPCErrorError>
```

**Purpose**: Starts a process according to `ExecParams` and returns the protocol-level execution response. It is the session-facing entry point for process creation.

**Data flow**: Consumes `ExecParams`, forwards them to `self.process.exec(params).await`, and returns either `ExecResponse` or `JSONRPCErrorError` unchanged.

**Call relations**: Called by the server handler when routing an exec request for the active session. It is a pure delegation layer over `LocalProcess::exec`.

*Call graph*: calls 1 internal fn (exec).


##### `ProcessHandler::exec_read`  (lines 40–45)

```
async fn exec_read(
        &self,
        params: ReadParams,
    ) -> Result<ReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads buffered process output and status according to `ReadParams`. It exposes the process stream polling API at the session layer.

**Data flow**: Consumes `ReadParams`, awaits `self.process.exec_read(params)`, and returns the resulting `ReadResponse` or JSON-RPC error.

**Call relations**: Used by handler code servicing `exec/read` requests, including long-poll scenarios that may outlive a connection. It delegates all sequencing and buffering semantics to `LocalProcess`.

*Call graph*: calls 1 internal fn (exec_read).


##### `ProcessHandler::exec_write`  (lines 47–52)

```
async fn exec_write(
        &self,
        params: WriteParams,
    ) -> Result<WriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes input bytes to a running process according to `WriteParams`. It is the session-facing stdin write operation.

**Data flow**: Consumes `WriteParams`, forwards them to `self.process.exec_write(params).await`, and returns `WriteResponse` or `JSONRPCErrorError`.

**Call relations**: Invoked by the server handler for `exec/write` requests. It simply bridges protocol types to the underlying process implementation.

*Call graph*: calls 1 internal fn (exec_write).


##### `ProcessHandler::signal`  (lines 54–59)

```
async fn signal(
        &self,
        params: SignalParams,
    ) -> Result<SignalResponse, JSONRPCErrorError>
```

**Purpose**: Sends an operating-system signal or equivalent control action to a process. It exposes process signaling through protocol types.

**Data flow**: Consumes `SignalParams`, awaits `self.process.signal_process(params)`, and returns `SignalResponse` or an error.

**Call relations**: Called from the handler when the router dispatches an exec signal request. It exists mainly to keep the session layer independent of `LocalProcess` method names.

*Call graph*: calls 1 internal fn (signal_process).


##### `ProcessHandler::terminate`  (lines 61–66)

```
async fn terminate(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, JSONRPCErrorError>
```

**Purpose**: Requests process termination and reports whether the process is still running. It is the protocol-facing wrapper for graceful/forced stop behavior implemented below.

**Data flow**: Consumes `TerminateParams`, forwards them to `self.process.terminate_process(params).await`, and returns `TerminateResponse` or `JSONRPCErrorError`.

**Call relations**: Used by the handler for `exec/terminate` requests. Like the other methods, it is a direct delegation point that preserves the protocol contract.

*Call graph*: calls 1 internal fn (terminate_process).


### MCP request and client routing
These files implement MCP-side dispatch and tool execution along with the rmcp client adapters that receive notifications and serialize elicitation flows back to the UI.

### `mcp-server/src/message_processor.rs`

`orchestration` · `request handling`

This file defines `MessageProcessor`, the central stateful dispatcher for all inbound MCP traffic. The struct keeps an `Arc<OutgoingMessageSender>` for replies and notifications, an `initialized` guard to enforce one-time initialization, the resolved `Arg0DispatchPaths`, a shared `ThreadManager` used to create and retrieve Codex sessions, and a mutex-protected `HashMap<RequestId, ThreadId>` that tracks which MCP request currently maps to which Codex thread for cancellation.

Construction (`new`) assembles the Codex-side dependencies: shared auth manager, home-based user instructions provider, empty extension registry, thread store, and `ThreadManager` configured with `SessionSource::Mcp`. Request processing is a large protocol dispatch over `ClientRequest`, with real implementations for initialize, ping, tools/list, tools/call, and explicit method-not-found responses for unsupported task APIs and custom methods. Most resource/prompt/logging/completion endpoints are currently stubs that only log parameters.

The two important tool paths are `codex` and `codex-reply`. The first parses `CodexToolCallParam`, resolves it into an initial prompt plus `Config`, then spawns `run_codex_tool_session`. The second parses `CodexToolCallReplyParam`, resolves a `ThreadId`, fetches the existing `CodexThread`, and spawns `run_codex_tool_session_reply`; missing or malformed arguments become `CallToolResult::error`, while unknown sessions produce a thread-id-tagged error result. Notification handling includes cancellation: it looks up the request-to-thread mapping, fetches the thread, submits `Op::Interrupt` via `Submission`, and removes the mapping afterward. Initialization also preserves a non-spec `serverInfo.user_agent` field by manually patching the serialized response object.

#### Function details

##### `MessageProcessor::new`  (lines 52–89)

```
async fn new(
        outgoing: OutgoingMessageSender,
        arg0_paths: Arg0DispatchPaths,
        config: Arc<Config>,
        environment_manager: Arc<EnvironmentManager>,
        state_db: Optio
```

**Purpose**: Builds a fully wired message processor with outbound transport, Codex thread management, and request-to-thread tracking. It performs the async setup needed before any MCP messages can be handled.

**Data flow**: Inputs are an `OutgoingMessageSender`, arg0 paths, shared `Config`, shared `EnvironmentManager`, optional state DB handle, and installation id. It wraps the sender in `Arc`, creates an `AuthManager` from config, creates a `CodexHomeUserInstructionsProvider`, constructs a `ThreadManager` with MCP session source, thread store, and optional state DB, and initializes `initialized` to `false` plus an empty `HashMap<RequestId, ThreadId>` inside a Tokio `Mutex`. It returns a populated `MessageProcessor`.

**Call relations**: It is called from `run_main` before the processor task enters its receive loop. The resulting processor instance is then used by `process_request`, `process_response`, `process_notification`, and `process_error` for all subsequent inbound traffic.

*Call graph*: calls 3 internal fn (new, new, shared_from_config); 5 external calls (new, new, new, thread_store_from_config, empty_extension_registry).


##### `MessageProcessor::process_request`  (lines 91–165)

```
async fn process_request(&mut self, request: JsonRpcRequest<ClientRequest>)
```

**Purpose**: Dispatches each incoming client request to the specific handler for that MCP method. It is the main request-routing switch for the server.

**Data flow**: It takes a `JsonRpcRequest<ClientRequest>`, extracts the request id and typed request payload, pattern-matches on the `ClientRequest` variant, and either awaits async handlers or invokes synchronous logging stubs. For unsupported task methods and custom methods, it sends method-not-found errors through `outgoing`; it returns no value and mutates processor state only indirectly through the delegated handlers.

**Call relations**: It is called from the processor loop in `run_main` whenever stdin delivers a JSON-RPC request. Depending on the variant, it delegates to initialization, ping, tool listing/calling, cancellation-related setup, or unsupported-method handling.

*Call graph*: calls 14 internal fn (handle_call_tool, handle_complete, handle_get_prompt, handle_initialize, handle_list_prompts, handle_list_resource_templates, handle_list_resources, handle_list_tools, handle_ping, handle_read_resource (+4 more)); 3 external calls (new, format!, json!).


##### `MessageProcessor::process_response`  (lines 167–171)

```
async fn process_response(&mut self, response: JsonRpcResponse<serde_json::Value>)
```

**Purpose**: Routes a client JSON-RPC response back to the callback waiting on that request id. This is how server-originated requests, such as elicitation prompts, receive their results.

**Data flow**: It accepts a `JsonRpcResponse<Value>`, logs it, destructures out `id` and `result`, and forwards both to `OutgoingMessageSender::notify_client_response`. It returns no value and updates callback state indirectly by allowing the sender to remove the matching oneshot entry.

**Call relations**: It is invoked by the main processor loop when the client sends a JSON-RPC response rather than a request or notification. Its downstream effect is to wake the task that previously called `OutgoingMessageSender::send_request`.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::process_notification`  (lines 173–194)

```
async fn process_notification(
        &mut self,
        notification: JsonRpcNotification<ClientNotification>,
    )
```

**Purpose**: Dispatches inbound client notifications to the corresponding notification handlers. It covers cancellation, progress, roots changes, and initialization acknowledgement.

**Data flow**: It takes a `JsonRpcNotification<ClientNotification>`, matches on the typed notification variant, and either awaits `handle_cancelled_notification` or calls the synchronous logging handlers. Custom notifications are ignored with a warning. It returns no value.

**Call relations**: It is called from the processor loop for notification traffic. The most consequential branch is cancellation, which delegates to `handle_cancelled_notification`; the others currently only log receipt.

*Call graph*: calls 4 internal fn (handle_cancelled_notification, handle_initialized_notification, handle_progress_notification, handle_roots_list_changed); 1 external calls (warn!).


##### `MessageProcessor::process_error`  (lines 196–198)

```
fn process_error(&mut self, err: JsonRpcError)
```

**Purpose**: Logs inbound JSON-RPC error messages from the client side. It does not attempt recovery or routing.

**Data flow**: It takes a `JsonRpcError`, emits a tracing error log containing the full structure, and returns unit. No internal state is changed.

**Call relations**: It is called by the processor loop when stdin yields a JSON-RPC error frame. Unlike responses, it does not notify any callback or alter request tracking.

*Call graph*: 1 external calls (error!).


##### `MessageProcessor::handle_initialize`  (lines 200–277)

```
async fn handle_initialize(
        &mut self,
        id: RequestId,
        params: rmcp::model::InitializeRequestParams,
    )
```

**Purpose**: Performs the MCP initialize handshake, enforcing single initialization and returning server capabilities plus server metadata. It also captures client identity into the shared user-agent suffix.

**Data flow**: Inputs are the request id and typed initialize params. It first checks `self.initialized`; if already true, it sends `invalid_request`. Otherwise it extracts client name/version, stores a formatted suffix into the global `USER_AGENT_SUFFIX` mutex when possible, builds `Implementation` for `codex-mcp-server`, serializes it to JSON so it can inject a non-standard `user_agent` field, builds `ServerCapabilities` with tools and tool-list-changed enabled, constructs `InitializeResult`, serializes that result, overwrites its `serverInfo` field with the patched object, sets `self.initialized = true`, and sends the response. Serialization failures become `internal_error` responses.

**Call relations**: It is reached only from `process_request` on `InitializeRequest`. It prepares the protocol state required before normal MCP interaction and is the only handler that mutates the `initialized` flag.

*Call graph*: called by 1 (process_request); 10 external calls (internal_error, invalid_request, new, new, builder, env!, format!, json!, to_value, info!).


##### `MessageProcessor::handle_ping`  (lines 279–282)

```
async fn handle_ping(&self, id: RequestId)
```

**Purpose**: Replies to MCP ping requests with an empty JSON object. It serves as a lightweight liveness endpoint.

**Data flow**: It takes the request id, logs `ping`, and sends `json!({})` as the response through `outgoing`. It returns no value and does not mutate processor state.

**Call relations**: It is called from `process_request` when the client sends `PingRequest`. It has no downstream delegation beyond the response send.

*Call graph*: called by 1 (process_request); 2 external calls (json!, info!).


##### `MessageProcessor::handle_list_resources`  (lines 284–286)

```
fn handle_list_resources(&self, params: Option<rmcp::model::PaginatedRequestParams>)
```

**Purpose**: Logs receipt of a resources/list request. No resource catalog is currently returned from this handler.

**Data flow**: It accepts optional pagination params, logs them, and returns unit. It neither sends a response nor changes state in this implementation.

**Call relations**: It is invoked by `process_request` for `ListResourcesRequest`. At present it is a stub placeholder rather than a complete MCP implementation.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_list_resource_templates`  (lines 288–290)

```
fn handle_list_resource_templates(&self, params: Option<rmcp::model::PaginatedRequestParams>)
```

**Purpose**: Logs receipt of a resources/templates/list request. The server does not currently enumerate templates here.

**Data flow**: It takes optional pagination params, writes an info log, and returns unit with no state changes or outbound messages.

**Call relations**: It is called from `process_request` for `ListResourceTemplatesRequest`. Like the other resource handlers, it is currently only observational.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_read_resource`  (lines 292–294)

```
fn handle_read_resource(&self, params: rmcp::model::ReadResourceRequestParams)
```

**Purpose**: Logs a resources/read request without serving content. It is a stub for future resource support.

**Data flow**: It receives typed read-resource params, logs them, and returns unit. No response payload is produced here.

**Call relations**: It is dispatched from `process_request` on `ReadResourceRequest`. There is no further delegation.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_subscribe`  (lines 296–298)

```
fn handle_subscribe(&self, params: rmcp::model::SubscribeRequestParams)
```

**Purpose**: Logs a resources/subscribe request. Subscription state is not implemented in this file.

**Data flow**: It takes subscribe params, emits an info log, and returns unit without mutating any subscription registry.

**Call relations**: It is called by `process_request` for `SubscribeRequest`. It currently acts as a no-op placeholder.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_unsubscribe`  (lines 300–302)

```
fn handle_unsubscribe(&self, params: rmcp::model::UnsubscribeRequestParams)
```

**Purpose**: Logs a resources/unsubscribe request. There is no active subscription bookkeeping here.

**Data flow**: It accepts unsubscribe params, logs them, and returns unit. No state is read or written beyond logging.

**Call relations**: It is reached from `process_request` on `UnsubscribeRequest`. It mirrors the subscribe stub behavior.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_list_prompts`  (lines 304–306)

```
fn handle_list_prompts(&self, params: Option<rmcp::model::PaginatedRequestParams>)
```

**Purpose**: Logs a prompts/list request. Prompt enumeration is not implemented in this server layer.

**Data flow**: It takes optional pagination params, logs them, and returns unit with no response generation.

**Call relations**: It is called from `process_request` for `ListPromptsRequest`. It is currently a stub endpoint.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_get_prompt`  (lines 308–310)

```
fn handle_get_prompt(&self, params: rmcp::model::GetPromptRequestParams)
```

**Purpose**: Logs a prompts/get request. Prompt retrieval is not implemented here.

**Data flow**: It receives typed get-prompt params, logs them, and returns unit. No prompt content is returned.

**Call relations**: It is dispatched from `process_request` on `GetPromptRequest`. There is no downstream work.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_list_tools`  (lines 312–328)

```
async fn handle_list_tools(
        &self,
        id: RequestId,
        params: Option<rmcp::model::PaginatedRequestParams>,
    )
```

**Purpose**: Returns the MCP tool catalog exposed by this server: the primary `codex` tool and the `codex-reply` continuation tool. It is the authoritative tool-list response for clients.

**Data flow**: Inputs are the request id and optional pagination params, though pagination is ignored. It logs at trace level, constructs `rmcp::model::ListToolsResult` with `meta: None`, a two-element `tools` vector from `create_tool_for_codex_tool_call_param()` and `create_tool_for_codex_tool_call_reply_param()`, and `next_cursor: None`, then sends that result through `outgoing`.

**Call relations**: It is called from `process_request` for `ListToolsRequest`. The helper constructors it uses encapsulate the schema definitions for the two supported tool names.

*Call graph*: called by 1 (process_request); 2 external calls (trace!, vec!).


##### `MessageProcessor::handle_call_tool`  (lines 330–349)

```
async fn handle_call_tool(&self, id: RequestId, params: CallToolRequestParams)
```

**Purpose**: Dispatches a `tools/call` request by tool name to either a new Codex session or a reply into an existing session. Unknown tool names are converted into `CallToolResult::error` responses.

**Data flow**: It takes the request id and `CallToolRequestParams`, logs the full params, extracts `name` and `arguments`, and matches on `name.as_ref()`. For `codex` it awaits `handle_tool_call_codex`; for `codex-reply` it awaits `handle_tool_call_codex_session_reply`; otherwise it builds an error `CallToolResult` containing text `Unknown tool '<name>'` and sends it as the response.

**Call relations**: It is invoked by `process_request` for `CallToolRequest`. It is the branch point between starting a fresh session and continuing an existing one.

*Call graph*: calls 2 internal fn (handle_tool_call_codex, handle_tool_call_codex_session_reply); called by 1 (process_request); 3 external calls (error, info!, vec!).


##### `MessageProcessor::handle_tool_call_codex`  (lines 351–405)

```
async fn handle_tool_call_codex(
        &self,
        id: RequestId,
        arguments: Option<rmcp::model::JsonObject>,
    )
```

**Purpose**: Parses the `codex` tool arguments, resolves them into an initial prompt plus concrete config, and launches the long-running Codex session task. It validates both presence and schema of the arguments before spawning work.

**Data flow**: Inputs are the MCP request id and optional JSON object arguments. It wraps the object as `serde_json::Value`, deserializes to `CodexToolCallParam`, calls `into_config(self.arg0_paths.clone()).await` to obtain `(initial_prompt, Config)`, and on any parse/config error sends a `CallToolResult::error` response immediately. On success it clones `outgoing`, `thread_manager`, and the request-to-thread map, then spawns an async task that calls `crate::codex_tool_runner::run_codex_tool_session(id, initial_prompt, config, outgoing, thread_manager, running_requests_id_to_codex_uuid)`. It returns unit.

**Call relations**: It is called only from `handle_call_tool` when the tool name is `codex`. The spawned task delegates the actual session lifecycle and event streaming to `codex_tool_runner`, keeping the message-processing loop non-blocking.

*Call graph*: calls 1 internal fn (run_codex_tool_session); called by 1 (handle_call_tool); 4 external calls (clone, error, spawn, vec!).


##### `MessageProcessor::handle_tool_call_codex_session_reply`  (lines 407–488)

```
async fn handle_tool_call_codex_session_reply(
        &self,
        request_id: RequestId,
        arguments: Option<rmcp::model::JsonObject>,
    )
```

**Purpose**: Parses a `codex-reply` tool call, resolves the target thread, and launches a reply task against an existing Codex session. It turns missing sessions and malformed thread ids into explicit tool-call error results.

**Data flow**: Inputs are the MCP request id and optional JSON object arguments. It logs the arguments, deserializes them into `CodexToolCallReplyParam`, extracts a `ThreadId` via `get_thread_id()`, and on parse failures sends `CallToolResult::error`. It clones `outgoing` and the request map, asks `self.thread_manager.get_thread(thread_id).await` for the existing `CodexThread`, and if absent sends `create_call_tool_result_with_thread_id(thread_id, 'Session not found...', Some(true))`. If found, it clones the prompt string and spawns `crate::codex_tool_runner::run_codex_tool_session_reply(thread_id, codex, outgoing, request_id, prompt, running_requests_id_to_codex_uuid)`. It returns unit.

**Call relations**: It is reached from `handle_call_tool` when the tool name is `codex-reply`. Its downstream work depends on `ThreadManager::get_thread`; only after a successful lookup does it delegate to the reply runner task.

*Call graph*: calls 2 internal fn (create_call_tool_result_with_thread_id, run_codex_tool_session_reply); called by 1 (handle_call_tool); 7 external calls (format!, error, spawn, error!, info!, warn!, vec!).


##### `MessageProcessor::handle_set_level`  (lines 490–492)

```
fn handle_set_level(&self, params: rmcp::model::SetLevelRequestParams)
```

**Purpose**: Logs a logging/setLevel request without changing tracing configuration. It is currently informational only.

**Data flow**: It takes typed set-level params, emits an info log, and returns unit. No logging backend state is mutated here.

**Call relations**: It is called from `process_request` for `SetLevelRequest`. There is no further delegation.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_complete`  (lines 494–496)

```
fn handle_complete(&self, params: rmcp::model::CompleteRequestParams)
```

**Purpose**: Logs a completion/complete request. Completion generation is not implemented in this layer.

**Data flow**: It accepts typed completion params, logs them, and returns unit without producing a completion response.

**Call relations**: It is dispatched from `process_request` on `CompleteRequest`. It currently serves as a stub endpoint.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_unsupported_request`  (lines 498–509)

```
async fn handle_unsupported_request(&self, id: RequestId, method: &str)
```

**Purpose**: Sends a standardized method-not-found error for MCP task methods the server does not implement. It centralizes the error shape used for those endpoints.

**Data flow**: Inputs are the request id and unsupported method string. It constructs `ErrorData::new(ErrorCode::METHOD_NOT_FOUND, format!(...), Some(json!({"method": method})))` and sends it through `outgoing`, returning unit.

**Call relations**: It is called from `process_request` for the four task-related request variants (`tasks/get_info`, `tasks/list`, `tasks/get_result`, `tasks/cancel`). It avoids duplicating identical error construction in each match arm.

*Call graph*: called by 1 (process_request); 3 external calls (new, format!, json!).


##### `MessageProcessor::handle_cancelled_notification`  (lines 515–560)

```
async fn handle_cancelled_notification(&self, params: rmcp::model::CancelledNotificationParam)
```

**Purpose**: Maps an MCP cancellation notification back to the corresponding Codex thread and submits an interrupt operation. It also removes the request-to-thread mapping once cancellation has been issued.

**Data flow**: It takes `CancelledNotificationParam`, extracts `request_id`, and derives a stable string form for logging and submission id. It locks `running_requests_id_to_codex_uuid` to look up the associated `ThreadId`; if absent it warns and returns. It then fetches the `CodexThread` from `thread_manager`; if missing it warns and returns. With the thread handle, it submits `Submission { id: request_id_string, op: Op::Interrupt, client_user_message_id: None, trace: None }`; on submission failure it logs and returns. Finally it re-locks the map and removes the request id entry.

**Call relations**: It is invoked by `process_notification` when the client sends `notifications/cancelled`. It depends on the request-to-thread map having been populated by the session runner and on `ThreadManager` still retaining the target thread.

*Call graph*: called by 1 (process_notification); 3 external calls (error!, info!, warn!).


##### `MessageProcessor::handle_progress_notification`  (lines 562–564)

```
fn handle_progress_notification(&self, params: rmcp::model::ProgressNotificationParam)
```

**Purpose**: Logs an inbound progress notification from the client. No progress state is tracked server-side here.

**Data flow**: It receives `ProgressNotificationParam`, logs it, and returns unit. There are no side effects beyond tracing.

**Call relations**: It is called from `process_notification` for `ProgressNotification`. It does not delegate further.

*Call graph*: called by 1 (process_notification); 1 external calls (info!).


##### `MessageProcessor::handle_roots_list_changed`  (lines 566–568)

```
fn handle_roots_list_changed(&self)
```

**Purpose**: Logs that the client’s roots list changed. The server does not currently react to the change.

**Data flow**: It takes no parameters, emits an info log, and returns unit. No root cache or configuration is updated.

**Call relations**: It is reached from `process_notification` on `RootsListChangedNotification`. It is presently observational only.

*Call graph*: called by 1 (process_notification); 1 external calls (info!).


##### `MessageProcessor::handle_initialized_notification`  (lines 570–572)

```
fn handle_initialized_notification(&self)
```

**Purpose**: Logs the client’s post-initialize acknowledgement notification. It does not alter state beyond the earlier initialize response.

**Data flow**: It takes no parameters, writes an info log, and returns unit. No fields are mutated.

**Call relations**: It is called from `process_notification` for `InitializedNotification`. It complements `handle_initialize` but performs no additional handshake logic.

*Call graph*: called by 1 (process_notification); 1 external calls (info!).


### `mcp-server/src/codex_tool_runner.rs`

`orchestration` · `MCP tool-call handling and Codex session event loop`

This file is the runtime bridge between MCP tool invocations and `codex_core` threads. `create_call_tool_result_with_thread_id` standardizes final responses by putting the textual result in both normal MCP `content` and `structured_content`, alongside the `threadId`, because some clients ignore plain content when structured content is present. `run_codex_tool_session` starts a new thread through `ThreadManager::start_thread`, immediately sends the resulting `SessionConfigured` event as a notification tagged with the originating MCP request id and thread id, records the request-to-thread mapping in a shared `Mutex<HashMap<RequestId, ThreadId>>`, submits the initial prompt as a `Submission` containing a single `UserInput::Text`, and then hands control to the shared event loop. `run_codex_tool_session_reply` performs the analogous setup for an existing `CodexThread`, submitting an `Op::UserInput` instead of creating a new thread. The core logic lives in `run_codex_tool_session_inner`, which repeatedly awaits `thread.next_event()`, forwards every event as a notification, and then selectively reacts to specific event kinds. Exec and patch approval requests are delegated to `handle_exec_approval_request` and `handle_patch_approval_request`; `TurnComplete` produces a success response using the last agent message; `Error` and runtime failures produce error responses; many metadata or streaming events are intentionally ignored after notification forwarding. The request-to-thread map is cleaned up on successful completion and on submission failures, though not on every runtime-error branch, reflecting the current lifecycle assumptions. A small test verifies the structured response shape.

#### Function details

##### `create_call_tool_result_with_thread_id`  (lines 36–51)

```
fn create_call_tool_result_with_thread_id(
    thread_id: ThreadId,
    text: String,
    is_error: Option<bool>,
) -> CallToolResult
```

**Purpose**: Builds a successful MCP `CallToolResult` payload that always includes the Codex `threadId` in structured content and mirrors the text in both structured and plain content fields.

**Data flow**: Accepts `thread_id`, result `text`, and optional `is_error` flag → creates `Content::text` from the text, builds `structured_content` JSON with `threadId` and `content`, initializes `CallToolResult::success(content)`, sets `is_error` and `structured_content`, and returns the result.

**Call relations**: Used by both session runners and the inner event loop whenever they need to send a final MCP response, whether for success or error; also covered by the unit test and reply-tool handling elsewhere.

*Call graph*: called by 5 (run_codex_tool_session, run_codex_tool_session_inner, run_codex_tool_session_reply, call_tool_result_includes_thread_id_in_structured_content, handle_tool_call_codex_session_reply); 3 external calls (json!, success, vec!).


##### `run_codex_tool_session`  (lines 57–141)

```
async fn run_codex_tool_session(
    id: RequestId,
    initial_prompt: String,
    config: CodexConfig,
    outgoing: Arc<OutgoingMessageSender>,
    thread_manager: Arc<ThreadManager>,
    running_r
```

**Purpose**: Starts a brand-new Codex thread for an MCP `codex` tool call, submits the initial prompt, and then enters the shared event-processing loop.

**Data flow**: Accepts MCP request id, initial prompt, `CodexConfig`, outgoing sender, thread manager, and shared request→thread map → calls `thread_manager.start_thread(config.clone()).await` → on failure sends an immediate `CallToolResult::error` response and returns → on success sends a synthetic `SessionConfigured` notification, inserts the request/thread mapping, builds a `Submission` with one text user input and default metadata, submits it with `thread.submit_with_id(...)`, and on success delegates to `run_codex_tool_session_inner`; on submission failure it sends an error result and removes the mapping.

**Call relations**: Invoked by `handle_tool_call_codex` when a new MCP session starts; it delegates long-running event handling to `run_codex_tool_session_inner` after performing thread creation and initial submission.

*Call graph*: calls 2 internal fn (create_call_tool_result_with_thread_id, run_codex_tool_session_inner); called by 1 (handle_tool_call_codex); 9 external calls (clone, default, clone, to_string, format!, error, SessionConfigured, error!, vec!).


##### `run_codex_tool_session_reply`  (lines 143–192)

```
async fn run_codex_tool_session_reply(
    thread_id: ThreadId,
    thread: Arc<CodexThread>,
    outgoing: Arc<OutgoingMessageSender>,
    request_id: RequestId,
    prompt: String,
    running_reque
```

**Purpose**: Submits a follow-up prompt to an existing Codex thread for the MCP `codex-reply` tool and then reuses the shared event loop.

**Data flow**: Accepts existing `thread_id`, `Arc<CodexThread>`, outgoing sender, MCP request id, prompt text, and shared request→thread map → inserts the request/thread mapping → submits `Op::UserInput` with one plain-text item and default metadata → on submission failure logs an error, sends a structured error result, removes the mapping, and returns → otherwise calls `run_codex_tool_session_inner`.

**Call relations**: Called by `handle_tool_call_codex_session_reply`; it parallels `run_codex_tool_session` but skips thread creation and `SessionConfigured` emission.

*Call graph*: calls 2 internal fn (create_call_tool_result_with_thread_id, run_codex_tool_session_inner); called by 1 (handle_tool_call_codex_session_reply); 5 external calls (default, clone, format!, error!, vec!).


##### `run_codex_tool_session_inner`  (lines 194–411)

```
async fn run_codex_tool_session_inner(
    thread_id: ThreadId,
    thread: Arc<CodexThread>,
    outgoing: Arc<OutgoingMessageSender>,
    request_id: RequestId,
    running_requests_id_to_codex_uuid
```

**Purpose**: Streams Codex thread events to the MCP client until the turn completes, errors out, or pauses for approval handling, while translating selected events into final tool responses or approval workflows.

**Data flow**: Accepts `thread_id`, thread handle, outgoing sender, request id, and shared request→thread map → computes `request_id_str` → loops on `thread.next_event().await` → for each event sends it as a notification with request/thread metadata, then matches `event.msg`: delegates exec approvals to `handle_exec_approval_request`, patch approvals to `handle_patch_approval_request`, ignores plan deltas/warnings/metadata after notification, converts `EventMsg::Error` into an error `CallToolResult`, converts `TurnComplete` into a success result using `last_agent_message` or empty string, removes the request mapping on successful completion, and logs/ignores many other event variants; if `next_event()` itself errors, sends a runtime-error result.

**Call relations**: This is the shared core loop called by both `run_codex_tool_session` and `run_codex_tool_session_reply`; it is where event forwarding, approval branching, and final response emission converge.

*Call graph*: calls 3 internal fn (create_call_tool_result_with_thread_id, handle_exec_approval_request, handle_patch_approval_request); called by 2 (run_codex_tool_session, run_codex_tool_session_reply); 4 external calls (clone, to_string, format!, error!).


##### `tests::call_tool_result_includes_thread_id_in_structured_content`  (lines 419–433)

```
fn call_tool_result_includes_thread_id_in_structured_content()
```

**Purpose**: Verifies that final MCP tool results include the expected `threadId` and mirrored `content` in `structured_content`.

**Data flow**: Creates a fresh `ThreadId`, calls `create_call_tool_result_with_thread_id(thread_id, "done", None)`, and asserts the resulting `structured_content` equals the expected JSON object.

**Call relations**: Unit test covering the response-shaping helper used by both new-session and reply-session runners.

*Call graph*: calls 2 internal fn (create_call_tool_result_with_thread_id, new); 1 external calls (assert_eq!).


### `rmcp-client/src/elicitation_client_service.rs`

`domain_logic` · `request handling`

This module defines `ElicitationClientService`, a `Service<RoleClient>` implementation that intercepts `ServerRequest::CreateElicitationRequest` while delegating all other requests and notifications to `LoggingClientHandler`. The constructor stores the caller-provided `SendElicitation` callback behind an `Arc`, then gives a cloned closure to the logging handler so both the wrapper and delegated handler can invoke the same elicitation mechanism. The wrapper also carries an `ElicitationPauseState`; `create_elicitation` enters that pause guard before awaiting the callback, ensuring the surrounding client can suppress conflicting activity while the user-facing elicitation is outstanding.

A subtle but important behavior is metadata restoration. rmcp moves JSON-RPC `_meta` into `RequestContext.meta` before service dispatch, but elicitation payloads themselves may need that metadata. `restore_context_meta` merges context metadata back into the `Elicitation` request's own meta map, explicitly removing the `progressToken` entry first so transport-level progress bookkeeping is not echoed back into elicitation semantics. On the response side, rmcp's typed `CreateElicitationResult` cannot represent result-level `_meta`, so `elicitation_response_result` serializes a local `CreateElicitationResultWithMeta` struct into `serde_json::Value` and wraps it in `CustomResult`. The included tests verify both metadata restoration and `_meta` serialization behavior.

#### Function details

##### `ElicitationClientService::new`  (lines 34–48)

```
fn new(
        client_info: ClientInfo,
        send_elicitation: SendElicitation,
        pause_state: ElicitationPauseState,
    ) -> Self
```

**Purpose**: Constructs the elicitation-aware client service and wires the same elicitation callback into both this wrapper and the delegated logging handler.

**Data flow**: It takes `ClientInfo`, a `SendElicitation` callback, and an `ElicitationPauseState`; wraps the callback in `Arc`; creates a `LoggingClientHandler` using `clone_send_elicitation(Arc::clone(...))`; stores the original `Arc` plus the pause state; and returns `ElicitationClientService`.

**Call relations**: It is called by higher-level client initialization code. The resulting service later handles requests itself for elicitation-specific cases and delegates everything else to the embedded `LoggingClientHandler`.

*Call graph*: calls 2 internal fn (clone_send_elicitation, new); called by 1 (initialize); 2 external calls (clone, new).


##### `ElicitationClientService::create_elicitation`  (lines 50–61)

```
async fn create_elicitation(
        &self,
        request: Elicitation,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitationResponse, rmcp::ErrorData>
```

**Purpose**: Prepares and forwards a create-elicitation request to the external callback while preserving relevant metadata and pausing client activity.

**Data flow**: It takes an `Elicitation` request and `RequestContext<RoleClient>`, extracts `id` and `meta` from the context, merges context metadata back into the request via `restore_context_meta`, enters the pause state guard with `self.pause_state.enter()`, invokes the stored `send_elicitation` callback with the request id and updated request, awaits the result, and maps callback failures into `rmcp::ErrorData::internal_error`.

**Call relations**: It is called only from `ElicitationClientService::handle_request` when the incoming server request is `CreateElicitationRequest`.

*Call graph*: calls 2 internal fn (restore_context_meta, enter); called by 1 (handle_request).


##### `clone_send_elicitation`  (lines 64–66)

```
fn clone_send_elicitation(send_elicitation: Arc<SendElicitation>) -> SendElicitation
```

**Purpose**: Builds a boxed callback that forwards to a shared `Arc<SendElicitation>`.

**Data flow**: It takes `Arc<SendElicitation>` and returns a new boxed closure that captures the `Arc` and invokes it with `(request_id, request)`.

**Call relations**: It is used by `ElicitationClientService::new` so the delegated `LoggingClientHandler` receives its own callable `SendElicitation` wrapper without taking ownership away from the outer service.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `ElicitationClientService::handle_request`  (lines 69–90)

```
async fn handle_request(
        &self,
        request: ServerRequest,
        context: RequestContext<RoleClient>,
    ) -> Result<ClientResult, rmcp::ErrorData>
```

**Purpose**: Intercepts elicitation requests for custom processing and forwards all other server requests to the logging handler.

**Data flow**: It matches on `ServerRequest`. For `CreateElicitationRequest`, it awaits `self.create_elicitation(request.params, context)`, converts the resulting `ElicitationResponse` into a `CustomResult` via `elicitation_response_result`, and returns `ClientResult::CustomResult`. For any other request variant, it forwards the request and context to `<LoggingClientHandler as Service<RoleClient>>::handle_request` and returns that result.

**Call relations**: rmcp invokes this as the main request-dispatch entrypoint for the client service. It delegates non-elicitation traffic to the embedded logging handler and uses `create_elicitation` plus `elicitation_response_result` only for the elicitation path.

*Call graph*: calls 2 internal fn (create_elicitation, elicitation_response_result); 2 external calls (handle_request, CustomResult).


##### `ElicitationClientService::handle_notification`  (lines 92–103)

```
async fn handle_notification(
        &self,
        notification: ServerNotification,
        context: NotificationContext<RoleClient>,
    ) -> Result<(), rmcp::ErrorData>
```

**Purpose**: Passes all server notifications through to the logging handler unchanged.

**Data flow**: It takes a `ServerNotification` and `NotificationContext<RoleClient>`, forwards both to the delegated logging handler's `handle_notification`, awaits the result, and returns it.

**Call relations**: rmcp calls this for notifications; unlike request handling, there is no special elicitation branch here, so the wrapper acts purely as a delegating adapter.

*Call graph*: 1 external calls (handle_notification).


##### `ElicitationClientService::get_info`  (lines 105–107)

```
fn get_info(&self) -> ClientInfo
```

**Purpose**: Returns the client identity and capability information advertised by the delegated logging handler.

**Data flow**: It reads `self.handler`, calls the delegated service's `get_info`, and returns the resulting `ClientInfo`.

**Call relations**: rmcp invokes it during client initialization; the wrapper does not alter the advertised info and simply reuses the logging handler's implementation.

*Call graph*: 1 external calls (get_info).


##### `restore_context_meta`  (lines 110–122)

```
fn restore_context_meta(mut request: Elicitation, mut context_meta: Meta) -> Elicitation
```

**Purpose**: Merges JSON-RPC context metadata back into an elicitation request while stripping the transport-level progress token.

**Data flow**: It takes a mutable `Elicitation` and mutable `Meta`, removes the `progressToken` key from `context_meta`, returns the original request unchanged if the remaining map is empty, otherwise obtains or creates the request's own meta map via `meta_mut().get_or_insert_with(Meta::new)`, extends it with the remaining context entries, and returns the updated request.

**Call relations**: It is used by `ElicitationClientService::create_elicitation` before invoking the external callback, and it is directly exercised by the unit test `tests::restore_context_meta_adds_elicitation_meta_and_removes_progress_token`.

*Call graph*: called by 2 (create_elicitation, restore_context_meta_adds_elicitation_meta_and_removes_progress_token); 3 external calls (meta_mut, is_empty, remove).


##### `elicitation_response_result`  (lines 134–151)

```
fn elicitation_response_result(
    response: ElicitationResponse,
) -> Result<CustomResult, rmcp::ErrorData>
```

**Purpose**: Serializes an `ElicitationResponse` into rmcp `CustomResult`, preserving result-level `_meta` that rmcp's typed result model cannot express.

**Data flow**: It destructures `ElicitationResponse` into `action`, `content`, and `meta`, builds a `CreateElicitationResultWithMeta` value, serializes it with `serde_json::to_value`, wraps the resulting JSON in `CustomResult`, and maps serialization failures to `rmcp::ErrorData::internal_error`.

**Call relations**: It is called from `ElicitationClientService::handle_request` on successful elicitation completion, and its serialization behavior is verified by `tests::elicitation_response_result_serializes_response_meta`.

*Call graph*: called by 2 (handle_request, elicitation_response_result_serializes_response_meta); 1 external calls (to_value).


##### `tests::restore_context_meta_adds_elicitation_meta_and_removes_progress_token`  (lines 166–181)

```
fn restore_context_meta_adds_elicitation_meta_and_removes_progress_token()
```

**Purpose**: Verifies that context metadata is merged into the elicitation request and that `progressToken` is intentionally removed.

**Data flow**: It builds a request with `tests::form_request`, constructs a `Meta` object with both `progressToken` and `persist`, passes them to `restore_context_meta`, and asserts that the returned request contains only the `persist` metadata.

**Call relations**: This unit test directly exercises `restore_context_meta` to lock in the metadata-restoration invariant used by `create_elicitation`.

*Call graph*: calls 1 internal fn (restore_context_meta); 4 external calls (assert_eq!, json!, form_request, meta).


##### `tests::elicitation_response_result_serializes_response_meta`  (lines 184–202)

```
fn elicitation_response_result_serializes_response_meta()
```

**Purpose**: Verifies that elicitation responses serialize into a client result containing `_meta` at the top level.

**Data flow**: It constructs an `ElicitationResponse` with `Accept`, JSON content, and JSON meta, converts it through `elicitation_response_result`, wraps it in `ClientResult::CustomResult`, serializes that result to JSON, and asserts the output contains `action`, `content`, and `_meta` fields.

**Call relations**: This test covers the custom serialization path used by `handle_request` for create-elicitation responses.

*Call graph*: calls 1 internal fn (elicitation_response_result); 3 external calls (assert_eq!, json!, CustomResult).


##### `tests::form_request`  (lines 204–213)

```
fn form_request(meta: Option<Meta>) -> CreateElicitationRequestParams
```

**Purpose**: Creates a representative form-style elicitation request for tests.

**Data flow**: It takes optional `Meta`, constructs `CreateElicitationRequestParams::FormElicitationParams` with a fixed message and an `ElicitationSchema` requiring a boolean `confirmed` property, and returns the request params.

**Call relations**: It is a test helper used by `tests::restore_context_meta_adds_elicitation_meta_and_removes_progress_token` to build stable input requests.

*Call graph*: 3 external calls (new, builder, Boolean).


##### `tests::meta`  (lines 215–220)

```
fn meta(value: Value) -> Meta
```

**Purpose**: Converts a JSON object value into rmcp `Meta` for tests and rejects non-object inputs.

**Data flow**: It takes a `serde_json::Value`, pattern-matches it as `Value::Object(map)`, returns `Meta(map)` on success, and panics if the value is not an object.

**Call relations**: It is a test helper used by the metadata-related tests to build `Meta` values from inline `json!` literals.

*Call graph*: 2 external calls (panic!, Meta).


### `rmcp-client/src/logging_client_handler.rs`

`io_transport` · `request handling`

This file defines `LoggingClientHandler`, a small `ClientHandler` implementation used by the MCP client runtime. Its state is intentionally minimal: a cloned `ClientInfo` returned to the server during initialization, and an `Arc<SendElicitation>` closure used when the server issues a `create_elicitation` request. Construction wraps the supplied callback in `Arc` so cloned handlers share the same async request path.

The trait implementation is split between one real request path and several notification sinks. `create_elicitation` takes the rmcp request payload plus `RequestContext<RoleClient>`, extracts `context.id`, invokes the stored async closure, converts the crate-local `ElicitationResponse` into rmcp's `CreateElicitationResult`, and normalizes callback failures into `rmcp::ErrorData::internal_error`. All other callbacks are side-effect-only logging hooks: cancellation, progress, resource updates, and list-change notifications are emitted at `info!` level with concrete fields from the notification payloads. `on_logging_message` is the only branchy handler; it destructures `LoggingMessageNotificationParam`, preserves the optional logger name as `Option<&str>`, and maps rmcp `LoggingLevel` values onto tracing severities (`error!`, `warn!`, `info!`, `debug!`).

A subtle design point is that this handler does not mutate client state or acknowledge notifications beyond logging; it exists to surface server activity to operators while delegating interactive elicitation to higher-level UI code.

#### Function details

##### `LoggingClientHandler::new`  (lines 29–34)

```
fn new(client_info: ClientInfo, send_elicitation: SendElicitation) -> Self
```

**Purpose**: Builds a handler instance from static client identity and an async elicitation callback. It prepares the callback for cheap cloning by storing it behind `Arc`.

**Data flow**: Takes a `ClientInfo` and a `SendElicitation` closure → wraps the closure with `Arc::new` and stores both fields in `LoggingClientHandler` → returns the initialized handler value.

**Call relations**: This constructor is used by higher-level client setup code when creating the rmcp-facing client service. The resulting handler is later consumed through the `ClientHandler` trait methods, especially `create_elicitation`.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `LoggingClientHandler::create_elicitation`  (lines 38–47)

```
async fn create_elicitation(
        &self,
        request: CreateElicitationRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<CreateElicitationResult, rmcp::ErrorData>
```

**Purpose**: Forwards an MCP elicitation request from the server to the crate's UI callback and translates the result into rmcp's response type. Failures are surfaced as rmcp internal errors rather than panics or opaque callback errors.

**Data flow**: Reads `request` and `context.id`, plus the stored `send_elicitation` closure → awaits `(self.send_elicitation)(context.id, request)` → converts a successful `ElicitationResponse` into `CreateElicitationResult` via `Into::into`, or converts the error string into `rmcp::ErrorData::internal_error` → returns `Result<CreateElicitationResult, rmcp::ErrorData>`.

**Call relations**: rmcp invokes this when the server sends a `create_elicitation` request. It is the only method in this file that delegates into application logic instead of just logging.


##### `LoggingClientHandler::on_cancelled`  (lines 49–58)

```
async fn on_cancelled(
        &self,
        params: CancelledNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Logs that the server cancelled a previously issued request, including the request id and optional reason. It does not attempt recovery or local cancellation propagation.

**Data flow**: Consumes `CancelledNotificationParam` and ignores the notification context → formats `params.request_id` and `params.reason` into an `info!` message → returns unit without mutating state.

**Call relations**: rmcp calls this on incoming cancellation notifications. Its only downstream effect is tracing output for observability.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_progress`  (lines 60–69)

```
async fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Logs progress notifications emitted by the server for long-running work. The log includes token, current progress, optional total, and optional message.

**Data flow**: Consumes `ProgressNotificationParam` and ignores the notification context → reads `progress_token`, `progress`, `total`, and `message` fields and emits them via `info!` → returns unit.

**Call relations**: Invoked by rmcp when the server publishes progress updates. It serves as a passive telemetry sink and does not feed progress back into client control flow.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_resource_updated`  (lines 71–77)

```
async fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Logs that a specific MCP resource URI changed on the server side. It records only the URI, not any fetched content.

**Data flow**: Consumes `ResourceUpdatedNotificationParam`, reads `params.uri`, ignores the context, and writes a single `info!` log line → returns unit.

**Call relations**: Called by rmcp for resource update notifications. It complements higher-level polling or refresh logic elsewhere by making the event visible in logs.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_resource_list_changed`  (lines 79–81)

```
async fn on_resource_list_changed(&self, _context: NotificationContext<RoleClient>)
```

**Purpose**: Logs that the server's resource listing changed. It does not trigger an automatic reload.

**Data flow**: Takes only the notification context, ignores it, emits a fixed `info!` message, and returns unit.

**Call relations**: rmcp invokes this on the corresponding list-change notification. The method is intentionally side-effect free beyond logging.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_tool_list_changed`  (lines 83–85)

```
async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>)
```

**Purpose**: Logs that the server's advertised tool list changed. This is purely informational in this handler.

**Data flow**: Receives the notification context, ignores it, emits a fixed `info!` message, and returns unit.

**Call relations**: Called by rmcp when tool inventory changes. Any actual re-fetching of tools happens elsewhere, not here.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_prompt_list_changed`  (lines 87–89)

```
async fn on_prompt_list_changed(&self, _context: NotificationContext<RoleClient>)
```

**Purpose**: Logs that the server's prompt list changed. It provides visibility into server-side prompt catalog updates.

**Data flow**: Receives and ignores the notification context → emits a fixed `info!` line → returns unit.

**Call relations**: Invoked by rmcp for prompt-list change notifications. Like the other list-change handlers, it is observational only.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::get_info`  (lines 91–93)

```
fn get_info(&self) -> ClientInfo
```

**Purpose**: Returns the client identity that should be reported to the server. The clone avoids exposing internal ownership of the stored `ClientInfo`.

**Data flow**: Reads `self.client_info` → clones it → returns the cloned `ClientInfo`.

**Call relations**: rmcp calls this during handshake or whenever it needs client metadata. It is the trait hook that exposes the constructor-provided identity.

*Call graph*: 1 external calls (clone).


##### `LoggingClientHandler::on_logging_message`  (lines 95–135)

```
async fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Maps server-originated MCP log messages onto local tracing levels and records the logger name and payload. It preserves the server's severity distinctions rather than flattening everything to one level.

**Data flow**: Destructures `LoggingMessageNotificationParam` into `level`, `logger`, and `data`; converts `logger` to `Option<&str>` with `as_deref` → matches on `LoggingLevel` and emits the formatted message through `error!`, `warn!`, `info!`, or `debug!` → returns unit.

**Call relations**: rmcp invokes this for `logging/message` notifications. It is the main notification path in this file with internal branching, routing each server log level to the corresponding local tracing macro.

*Call graph*: 4 external calls (debug!, error!, info!, warn!).


### HTTP proxy request handling
This standalone transport router handles incoming HTTP and CONNECT traffic, applies proxy policy, and forwards or blocks requests accordingly.

### `network-proxy/src/http_proxy.rs`

`io_transport` · `request handling`

This file wires the HTTP listener and contains nearly all request-time control flow for the proxy. `run_http_proxy` and its listener variants create a Rama `HttpServer::http1()` service specifically to avoid pre-read HTTP version sniffing that can stall some local clients before proxy semantics are applied. The service stack routes CONNECT requests through an upgrade layer: `http_connect_accept` validates authority, checks proxy enabled state, evaluates host policy, records blocked requests and audit events on denial, and decides whether CONNECT requires MITM based on `NetworkMode::Limited` or host-specific MITM hooks. If MITM is required but unavailable, it blocks with a detailed forbidden response; otherwise it stores `ProxyTarget`, `NetworkMode`, and optional MITM state in request extensions for the upgraded phase.

`http_connect_proxy` then either hands the upgraded stream to `mitm::mitm_tunnel` or forwards bytes directly via `forward_connect_tunnel`, optionally routing through an upstream proxy. The forwarding path builds a TLS tunnel connector around `TargetCheckedTcpConnector`, logs dial and forwarding timings, and streams bytes bidirectionally.

For non-CONNECT requests, `http_plain_proxy` enforces method policy, supports a tightly scoped `x-unix-socket` escape hatch with platform and allowlist checks, validates absolute-form `Host` header consistency, checks enabled state and host policy, strips hop-by-hop request headers only after extracting metadata, and forwards through `UpstreamClient` either directly or via environment proxy settings. Helper functions centralize blocked JSON/text responses, proxy-disabled telemetry, client address extraction, and hop-by-hop header removal. Tests cover limited-mode CONNECT blocking, MITM-required behavior, unix-socket handling, host-header mismatch rejection, and header stripping.

#### Function details

##### `run_http_proxy`  (lines 86–103)

```
async fn run_http_proxy(
    state: Arc<NetworkProxyState>,
    addr: SocketAddr,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<()>
```

**Purpose**: Binds the HTTP proxy listener on a socket address and starts serving requests through the shared HTTP proxy service stack.

**Data flow**: It takes shared `NetworkProxyState`, a `SocketAddr`, and an optional policy decider. It builds and binds a Rama `TcpListener`, wraps bind errors so they can carry `anyhow::Context`, then passes the listener into `run_http_proxy_with_listener` and returns its result.

**Call relations**: Top-level runtime orchestration calls this when it wants the proxy to own its own listener socket. It delegates all actual service construction and serving to `run_http_proxy_with_listener`.

*Call graph*: calls 1 internal fn (run_http_proxy_with_listener); called by 1 (run); 1 external calls (build).


##### `run_http_proxy_with_std_listener`  (lines 105–113)

```
async fn run_http_proxy_with_std_listener(
    state: Arc<NetworkProxyState>,
    listener: StdTcpListener,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<()>
```

**Purpose**: Starts the HTTP proxy using an already-created standard library TCP listener.

**Data flow**: It takes shared state, a `std::net::TcpListener`, and an optional policy decider. It converts the std listener into a Rama `TcpListener`, adds context on conversion failure, then delegates to `run_http_proxy_with_listener`.

**Call relations**: Used by runtime code and tests that need to pre-bind the socket themselves before handing it to the proxy.

*Call graph*: calls 1 internal fn (run_http_proxy_with_listener); called by 2 (http_proxy_listener_accepts_plain_http1_connect_requests, run); 1 external calls (try_from).


##### `run_http_proxy_with_listener`  (lines 115–154)

```
async fn run_http_proxy_with_listener(
    state: Arc<NetworkProxyState>,
    listener: TcpListener,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<()>
```

**Purpose**: Builds the HTTP proxy service pipeline and serves it on an existing Rama listener.

**Data flow**: It takes shared state, a Rama `TcpListener`, and an optional policy decider. It ensures the Rustls crypto provider is installed, reads the listener’s local address for logging, constructs an HTTP/1-only server with an upgrade layer that routes CONNECT requests through `http_connect_accept` and `http_connect_proxy`, wraps plain requests with hop-by-hop response header removal and `http_plain_proxy`, logs the listening address, then serves the service with the shared state inserted as an input extension.

**Call relations**: Both listener-entry functions delegate here. It is the central wiring point that connects request parsing, CONNECT upgrade handling, and plain proxying.

*Call graph*: called by 2 (run_http_proxy, run_http_proxy_with_std_listener); 9 external calls (new, http1, hop_by_hop, local_addr, serve, new, ensure_rustls_crypto_provider, info!, service_fn).


##### `http_connect_accept`  (lines 156–329)

```
async fn http_connect_accept(
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    mut req: Request,
) -> Result<(Response, Request), Response>
```

**Purpose**: Performs the policy and state checks for an incoming CONNECT request before the connection is upgraded into a tunnel or MITM session.

**Data flow**: It takes an optional policy decider and a mutable `Request`. It extracts `Arc<NetworkProxyState>` from request extensions, parses CONNECT authority from `RequestContext`, normalizes the host, derives client address, checks whether the proxy is enabled, builds a `NetworkPolicyRequest`, evaluates host policy, records blocked requests and returns detailed forbidden responses on denial, reads current `NetworkMode`, loads optional MITM state and whether the host has MITM hooks, computes `connect_needs_mitm`, blocks with telemetry if MITM is required but unavailable, and on success inserts `ProxyTarget`, `ConnectMitmEnabled`, `NetworkMode`, and optional MITM state into request extensions before returning `(200 OK empty response, request)`.

**Call relations**: The CONNECT upgrade layer invokes this first for every CONNECT request. Depending on state and policy it either short-circuits with an HTTP response or prepares the upgraded request so `http_connect_proxy` can choose MITM versus direct tunneling.

*Call graph*: calls 9 internal fn (blocked_text_with_details, client_addr, emit_http_block_decision_audit_event, proxy_disabled_response, text_response, new, evaluate_host_policy, normalize_host, new); called by 4 (http_connect_accept_allows_allowlisted_host_in_full_mode, http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state, http_connect_accept_blocks_in_limited_mode, http_connect_accept_denies_denylisted_host); 9 external calls (try_from, extensions, extensions_mut, builder, error!, empty, info!, ProxyTarget, warn!).


##### `http_connect_proxy`  (lines 331–405)

```
async fn http_connect_proxy(upgraded: Upgraded) -> Result<(), Infallible>
```

**Purpose**: Handles the upgraded CONNECT stream after acceptance, choosing MITM interception or direct tunnel forwarding.

**Data flow**: It takes `Upgraded`. It reads `NetworkMode` and `ProxyTarget` from extensions, checks whether `ConnectMitmEnabled(true)` and `Arc<mitm::MitmState>` are both present, and if so logs and awaits `mitm::mitm_tunnel(upgraded)`. Otherwise it extracts `Arc<NetworkProxyState>`, reads `allow_upstream_proxy`, optionally obtains an upstream proxy address via `proxy_for_connect`, logs the selected route, and calls `forward_connect_tunnel`; any tunnel errors are logged and the function returns `Ok(())` regardless.

**Call relations**: This is the second half of CONNECT handling, invoked only after `http_connect_accept` has returned success. It delegates either to the MITM subsystem or to raw tunnel forwarding.

*Call graph*: calls 4 internal fn (forward_connect_tunnel, mitm_tunnel, normalize_host, proxy_for_connect); 4 external calls (extensions, error!, info!, warn!).


##### `forward_connect_tunnel`  (lines 407–477)

```
async fn forward_connect_tunnel(
    upgraded: Upgraded,
    proxy: Option<ProxyAddress>,
    app_state: Arc<NetworkProxyState>,
) -> Result<(), BoxError>
```

**Purpose**: Establishes an outbound TLS tunnel for a CONNECT request and forwards bytes between the upgraded client stream and the target connection.

**Data flow**: It takes `upgraded: Upgraded`, an optional `ProxyAddress`, and shared app state. It extracts the `ProxyTarget` authority from extensions, clones the upgraded extensions and inserts the upstream proxy address when present, builds a `TcpRequest` marked with `Protocol::HTTPS`, wraps `TargetCheckedTcpConnector` in `HttpProxyConnector::optional`, builds TLS connector data with automatic HTTP ALPN, layers it into a tunnel connector, logs dial start time, awaits `connector.connect(req)`, logs success or failure timing, then constructs `ProxyRequest { source: upgraded, target }` and serves it through `StreamForwardService::default()`, again logging completion or failure timing and wrapping errors with context.

**Call relations**: Only `http_connect_proxy` calls this when MITM is not being used. It composes target-policy enforcement, optional upstream proxying, TLS tunneling, and byte forwarding into one path.

*Call graph*: calls 1 internal fn (new); called by 1 (http_connect_proxy); 10 external calls (optional, now, from_boxed, default, new_with_extensions, new, tunnel, extensions, info!, warn!).


##### `http_plain_proxy`  (lines 479–803)

```
async fn http_plain_proxy(
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    mut req: Request,
) -> Result<Response, Infallible>
```

**Purpose**: Processes non-CONNECT HTTP proxy requests, enforcing method and host policy, optionally proxying to unix sockets, and forwarding allowed requests upstream.

**Data flow**: It takes an optional policy decider and a mutable `Request`. It extracts app state and client address, checks method policy via `app_state.method_allowed`, then branches on the presence of `x-unix-socket`. In the unix-socket branch it validates UTF-8, checks proxy enabled state, method policy, platform support, and allowlist membership, emits allow/block audit events, and either proxies via `proxy_via_unix_socket` or returns blocked/error responses. In the normal HTTP branch it parses `RequestContext`, normalizes host and port, validates absolute-form `Host` header consistency, checks enabled state, builds and evaluates a `NetworkPolicyRequest`, records blocked requests on denial, enforces method policy with detailed blocked responses in limited mode, logs allowed requests, chooses `UpstreamClient::from_env_proxy` or `UpstreamClient::direct` based on `allow_upstream_proxy`, strips hop-by-hop request headers, forwards the request, and maps upstream failures to `502 Bad Gateway`.

**Call relations**: This function is the main plain-HTTP request handler installed by `run_http_proxy_with_listener`. It delegates to many helpers for policy evaluation, unix-socket forwarding, blocked-response formatting, and header cleanup.

*Call graph*: calls 16 internal fn (client_addr, emit_http_allow_decision_audit_event, emit_http_block_decision_audit_event, json_blocked, proxy_disabled_response, proxy_via_unix_socket, remove_hop_by_hop_request_headers, text_response, validate_absolute_form_host_header, new (+6 more)); called by 4 (http_plain_proxy_attempts_allowed_unix_socket_proxy, http_plain_proxy_blocks_unix_socket_when_method_not_allowed, http_plain_proxy_rejects_absolute_uri_host_header_mismatch, http_plain_proxy_rejects_unix_socket_when_not_allowlisted); 8 external calls (try_from, extensions, headers, headers_mut, method, error!, info!, warn!).


##### `proxy_via_unix_socket`  (lines 805–831)

```
async fn proxy_via_unix_socket(req: Request, socket_path: &str) -> Result<Response>
```

**Purpose**: Forwards an HTTP request to a local unix-domain socket upstream on supported platforms.

**Data flow**: On macOS it takes `req: Request` and `socket_path: &str`, builds `UpstreamClient::unix_socket(socket_path)`, splits the request into parts and body, rewrites the URI to contain only path-and-query, removes the `x-unix-socket` header, strips hop-by-hop headers, reconstructs the request, and serves it through the unix-socket client. On non-macOS it ignores the inputs and returns an error indicating unix sockets are unsupported.

**Call relations**: Only the unix-socket branch of `http_plain_proxy` calls this after allowlist and platform checks succeed.

*Call graph*: calls 2 internal fn (remove_hop_by_hop_request_headers, unix_socket); called by 1 (http_plain_proxy); 3 external calls (anyhow!, from_parts, into_parts).


##### `client_addr`  (lines 833–838)

```
fn client_addr(input: &T) -> Option<String>
```

**Purpose**: Extracts the peer socket address string from request or upgraded-stream extensions when available.

**Data flow**: It takes any `ExtensionsRef`, looks up `SocketInfo` in its extensions, converts `peer_addr()` to `String`, and returns `Option<String>`.

**Call relations**: Both CONNECT and plain HTTP handlers use this helper for logging, telemetry, and blocked-request records.

*Call graph*: called by 2 (http_connect_accept, http_plain_proxy); 1 external calls (extensions).


##### `validate_absolute_form_host_header`  (lines 840–872)

```
fn validate_absolute_form_host_header(
    req: &Request,
    request_ctx: &RequestContext,
) -> Result<(), &'static str>
```

**Purpose**: Rejects absolute-form proxy requests whose `Host` header does not match the request target authority.

**Data flow**: It takes `req: &Request` and `request_ctx: &RequestContext`. If the URI has no scheme, it returns `Ok(())`. Otherwise it tries to parse a typed `Host` header, returns an error string for invalid header syntax, allows missing `Host`, compares host names, compares explicit ports when present, and requires the target authority to use its default port when the `Host` header omits a port.

**Call relations**: The normal HTTP branch of `http_plain_proxy` calls this before policy evaluation to prevent mismatched-target smuggling in absolute-form requests.

*Call graph*: called by 1 (http_plain_proxy); 3 external calls (authority_has_default_port, headers, uri).


##### `remove_hop_by_hop_request_headers`  (lines 873–906)

```
fn remove_hop_by_hop_request_headers(headers: &mut HeaderMap)
```

**Purpose**: Strips hop-by-hop request headers, including headers named by the `Connection` header, before forwarding upstream.

**Data flow**: It takes `headers: &mut HeaderMap`. While a `Connection` header exists, it clones and removes it, parses comma-separated token names, converts valid tokens into `HeaderName`s, and removes those headers. It then removes a fixed list of standard hop-by-hop headers and finally removes the short `te` header by constructing its name from raw bytes.

**Call relations**: Called before forwarding normal HTTP requests and unix-socket requests, and directly by a test that verifies forwarding headers like `X-Forwarded-For` are preserved.

*Call graph*: called by 3 (http_plain_proxy, proxy_via_unix_socket, remove_hop_by_hop_request_headers_keeps_forwarding_headers); 3 external calls (get, remove, from_bytes).


##### `json_blocked`  (lines 908–937)

```
fn json_blocked(host: &str, reason: &str, details: Option<&PolicyDecisionDetails<'_>>) -> Response
```

**Purpose**: Builds a structured JSON `403 Forbidden` response for blocked plain HTTP requests, optionally including policy metadata.

**Data flow**: It takes `host`, `reason`, and optional `PolicyDecisionDetails`. It derives optional message, decision, source, protocol, and port fields from the details, constructs a `BlockedResponse` struct, serializes it with `json_response`, sets the status to `FORBIDDEN`, inserts an `x-proxy-error` header derived from `blocked_header_value(reason)`, and returns the response.

**Call relations**: The plain HTTP handler uses this for allowlist/denylist and method-policy blocks where a JSON body is appropriate.

*Call graph*: calls 2 internal fn (blocked_header_value, json_response); called by 1 (http_plain_proxy); 1 external calls (from_static).


##### `blocked_text_with_details`  (lines 939–941)

```
fn blocked_text_with_details(reason: &str, details: &PolicyDecisionDetails<'_>) -> Response
```

**Purpose**: Produces a text blocked response that includes policy details.

**Data flow**: It takes a `reason` and `PolicyDecisionDetails`, delegates directly to `blocked_text_response_with_policy`, and returns the resulting `Response`.

**Call relations**: CONNECT acceptance uses this helper for forbidden responses because CONNECT clients expect a simpler text response rather than the JSON shape used for plain HTTP.

*Call graph*: calls 1 internal fn (blocked_text_response_with_policy); called by 1 (http_connect_accept).


##### `proxy_disabled_response`  (lines 943–994)

```
async fn proxy_disabled_response(
    app_state: &NetworkProxyState,
    host: String,
    port: u16,
    client: Option<String>,
    method: Option<String>,
    protocol: NetworkProtocol,
    audit_e
```

**Purpose**: Records telemetry for a request blocked because the proxy is disabled and returns a detailed service-unavailable response.

**Data flow**: It takes app state, blocked host and port, optional client and method strings, a `NetworkProtocol`, and an optional audit endpoint override. It emits a block audit event with reason `REASON_PROXY_DISABLED`, records a `BlockedRequest` with decision/source strings set to deny/proxy_state, constructs `PolicyDecisionDetails`, and returns a `503 Service Unavailable` text response containing `blocked_message_with_policy`.

**Call relations**: Both CONNECT and plain HTTP handlers call this when the proxy is disabled, so the disabled-state behavior stays consistent across protocols.

*Call graph*: calls 6 internal fn (emit_http_block_decision_audit_event, text_response, as_policy_protocol, blocked_message_with_policy, new, record_blocked); called by 2 (http_connect_accept, http_plain_proxy).


##### `internal_error`  (lines 996–999)

```
fn internal_error(context: &str, err: impl std::fmt::Display) -> Response
```

**Purpose**: Logs an internal error context and returns a generic `500 error` text response.

**Data flow**: It takes a context string and any displayable error, logs them with `error!`, calls `text_response(StatusCode::INTERNAL_SERVER_ERROR, "error")`, and returns that response.

**Call relations**: Request handlers use this helper when async state reads fail and they need a uniform internal-error response.

*Call graph*: calls 1 internal fn (text_response); 1 external calls (error!).


##### `text_response`  (lines 1001–1007)

```
fn text_response(status: StatusCode, body: &str) -> Response
```

**Purpose**: Builds a plain-text HTTP response with the given status and body.

**Data flow**: It takes a `StatusCode` and body string slice, uses `Response::builder()` to set status and `content-type: text/plain`, builds a `Body` from an owned `String`, and falls back to `Response::new` if builder construction fails.

**Call relations**: Many branches in this file use it for simple bad-request, internal-error, unsupported, and upstream-failure responses.

*Call graph*: called by 4 (http_connect_accept, http_plain_proxy, internal_error, proxy_disabled_response); 2 external calls (builder, from).


##### `emit_http_block_decision_audit_event`  (lines 1009–1014)

```
fn emit_http_block_decision_audit_event(
    app_state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Thin wrapper that emits a block audit event for HTTP-layer decisions.

**Data flow**: It takes app state and `BlockDecisionAuditEventArgs`, forwards them to `emit_block_decision_audit_event`, and returns nothing.

**Call relations**: CONNECT, plain HTTP, and proxy-disabled paths call this wrapper so the HTTP module does not depend directly on the lower-level audit emitter everywhere.

*Call graph*: calls 1 internal fn (emit_block_decision_audit_event); called by 3 (http_connect_accept, http_plain_proxy, proxy_disabled_response).


##### `emit_http_allow_decision_audit_event`  (lines 1016–1021)

```
fn emit_http_allow_decision_audit_event(
    app_state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Thin wrapper that emits an allow audit event for HTTP-layer decisions.

**Data flow**: It takes app state and `BlockDecisionAuditEventArgs`, forwards them to `emit_allow_decision_audit_event`, and returns nothing.

**Call relations**: Currently used by the unix-socket allow path in `http_plain_proxy`.

*Call graph*: calls 1 internal fn (emit_allow_decision_audit_event); called by 1 (http_plain_proxy).


##### `tests::http_connect_accept_blocks_in_limited_mode`  (lines 1060–1085)

```
async fn http_connect_accept_blocks_in_limited_mode()
```

**Purpose**: Verifies that CONNECT is blocked in limited mode when MITM is required but unavailable.

**Data flow**: The test builds proxy state with `example.com` allowlisted, switches network mode to `Limited`, constructs a CONNECT request for `example.com:443`, inserts state into extensions, calls `http_connect_accept`, expects an error response, and asserts `403 Forbidden` plus `x-proxy-error: blocked-by-mitm-required`.

**Call relations**: This covers the `connect_needs_mitm && mitm_state.is_none()` branch driven by limited mode.

*Call graph*: calls 3 internal fn (default, http_connect_accept, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_connect_accept_allows_allowlisted_host_in_full_mode`  (lines 1088–1111)

```
async fn http_connect_accept_allows_allowlisted_host_in_full_mode()
```

**Purpose**: Verifies that an allowlisted CONNECT target is accepted in full mode when no MITM requirement applies.

**Data flow**: It builds state with `allow_local_binding: true` and `example.com` allowlisted, constructs a CONNECT request, inserts state, calls `http_connect_accept`, and asserts the returned response status is `200 OK`.

**Call relations**: This exercises the successful CONNECT acceptance path.

*Call graph*: calls 3 internal fn (default, http_connect_accept, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state`  (lines 1114–1147)

```
async fn http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state()
```

**Purpose**: Checks that a host with configured MITM hooks still requires MITM even in full mode, and is blocked if MITM state is absent.

**Data flow**: It builds state with `mitm = true`, a hook for `api.github.com`, and that host allowlisted, constructs a CONNECT request for the host, inserts state, calls `http_connect_accept`, and asserts a forbidden MITM-required response.

**Call relations**: This covers the `host_has_mitm_hooks` half of the CONNECT MITM requirement logic.

*Call graph*: calls 2 internal fn (http_connect_accept, network_proxy_state_for_policy); 6 external calls (new, default, assert_eq!, builder, empty, vec!).


##### `tests::http_proxy_listener_accepts_plain_http1_connect_requests`  (lines 1150–1209)

```
async fn http_proxy_listener_accepts_plain_http1_connect_requests()
```

**Purpose**: Integration-tests that the HTTP proxy listener accepts a raw HTTP/1.1 CONNECT request and responds `200 OK`.

**Data flow**: The test binds a target listener and a proxy listener, starts `run_http_proxy_with_std_listener` in a task, opens a TCP client connection to the proxy, writes a textual CONNECT request, reads the response with a timeout, and asserts it starts with `HTTP/1.1 200 OK`.

**Call relations**: This validates the listener wiring and the explicit HTTP/1-only server choice in `run_http_proxy_with_listener`.

*Call graph*: calls 3 internal fn (default, run_http_proxy_with_std_listener, network_proxy_state_for_policy); 11 external calls (new, from_secs, bind, from_utf8_lossy, bind, assert!, format!, connect, spawn, timeout (+1 more)).


##### `tests::http_plain_proxy_blocks_unix_socket_when_method_not_allowed`  (lines 1212–1238)

```
async fn http_plain_proxy_blocks_unix_socket_when_method_not_allowed()
```

**Purpose**: Verifies that unix-socket proxy requests are blocked by limited-mode method policy before any allowlist or forwarding occurs.

**Data flow**: It builds default state, switches mode to `Limited`, constructs a `POST` request with `x-unix-socket`, inserts state, calls `http_plain_proxy`, and asserts a forbidden response with `x-proxy-error: blocked-by-method-policy`.

**Call relations**: This covers the unix-socket branch’s early method-policy enforcement.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 4 external calls (new, assert_eq!, builder, empty).


##### `tests::http_plain_proxy_rejects_unix_socket_when_not_allowlisted`  (lines 1241–1267)

```
async fn http_plain_proxy_rejects_unix_socket_when_not_allowlisted()
```

**Purpose**: Checks that a unix-socket request without allowlist permission is rejected, or reported unsupported on non-macOS platforms.

**Data flow**: It builds default state, constructs a `GET` request with `x-unix-socket`, inserts state, calls `http_plain_proxy`, and asserts either `403 blocked-by-allowlist` on macOS or `501 Not Implemented` elsewhere.

**Call relations**: This covers both the platform-support gate and the allowlist-denial branch.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, cfg!, builder, empty).


##### `tests::http_plain_proxy_attempts_allowed_unix_socket_proxy`  (lines 1271–1290)

```
async fn http_plain_proxy_attempts_allowed_unix_socket_proxy()
```

**Purpose**: Verifies that an allowlisted unix-socket request reaches the forwarding attempt path.

**Data flow**: On macOS, it builds state with `/tmp/test.sock` allowlisted, constructs a `GET` request with that header, inserts state, calls `http_plain_proxy`, and asserts the result is `502 Bad Gateway` because the socket path is not actually serving.

**Call relations**: This confirms the allow path proceeds into `proxy_via_unix_socket` rather than being blocked earlier.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_connect_accept_denies_denylisted_host`  (lines 1293–1318)

```
async fn http_connect_accept_denies_denylisted_host()
```

**Purpose**: Verifies that denylist policy overrides a broader allowlist during CONNECT evaluation.

**Data flow**: It builds state with `**.openai.com` allowed and `api.openai.com` denied, constructs a CONNECT request for `api.openai.com:443`, inserts state, calls `http_connect_accept`, and asserts a forbidden response with `x-proxy-error: blocked-by-denylist`.

**Call relations**: This covers host-policy denial handling in the CONNECT path.

*Call graph*: calls 3 internal fn (default, http_connect_accept, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_plain_proxy_rejects_absolute_uri_host_header_mismatch`  (lines 1321–1335)

```
async fn http_plain_proxy_rejects_absolute_uri_host_header_mismatch()
```

**Purpose**: Checks that absolute-form requests with a mismatched `Host` header are rejected as bad requests.

**Data flow**: It builds default state, constructs a GET request whose absolute URI targets `raw.githubusercontent.com` but whose `Host` header is `api.github.com`, inserts state, calls `http_plain_proxy`, and asserts `400 Bad Request`.

**Call relations**: This directly exercises `validate_absolute_form_host_header` through the plain HTTP handler.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 4 external calls (new, assert_eq!, builder, empty).


##### `tests::validate_absolute_form_host_header_allows_matching_default_port`  (lines 1338–1350)

```
fn validate_absolute_form_host_header_allows_matching_default_port()
```

**Purpose**: Verifies that an absolute-form request with a matching host and implicit default port passes validation.

**Data flow**: It builds a request for `http://example.com/` with `Host: example.com`, constructs a `RequestContext`, calls `validate_absolute_form_host_header`, and asserts `Ok(())`.

**Call relations**: This is a focused unit test for the host-header validator’s default-port allowance.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


##### `tests::validate_absolute_form_host_header_rejects_mismatched_host`  (lines 1353–1365)

```
fn validate_absolute_form_host_header_rejects_mismatched_host()
```

**Purpose**: Verifies that a mismatched host name in the `Host` header is rejected.

**Data flow**: It builds a request targeting `http://raw.githubusercontent.com/` with `Host: api.github.com`, validates it, and asserts the specific mismatch error string.

**Call relations**: This covers the host-name comparison branch in the validator.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


##### `tests::validate_absolute_form_host_header_rejects_missing_non_default_port`  (lines 1368–1380)

```
fn validate_absolute_form_host_header_rejects_missing_non_default_port()
```

**Purpose**: Verifies that omitting a non-default port from the `Host` header causes validation failure.

**Data flow**: It builds a request targeting `http://example.com:8080/` with `Host: example.com`, validates it, and asserts the mismatch error string.

**Call relations**: This covers the validator’s explicit-port consistency rule.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


##### `tests::remove_hop_by_hop_request_headers_keeps_forwarding_headers`  (lines 1383–1413)

```
fn remove_hop_by_hop_request_headers_keeps_forwarding_headers()
```

**Purpose**: Checks that hop-by-hop headers are removed while end-to-end forwarding headers remain intact.

**Data flow**: It constructs a `HeaderMap` containing `Connection`, a named hop header, `Proxy-Authorization`, `X-Forwarded-For`, and `Host`, calls `remove_hop_by_hop_request_headers`, and asserts the hop-by-hop headers are gone while `X-Forwarded-For` and `Host` remain.

**Call relations**: This test validates the forwarding hygiene helper used before upstream requests are sent.

*Call graph*: calls 1 internal fn (remove_hop_by_hop_request_headers); 3 external calls (new, from_static, assert_eq!).
