# RPC request routing  `stage-10.2`

This stage is the system’s set of switchboards during normal operation. Messages arrive as JSON-RPC requests, meaning named messages with parameters and replies, and these files send each one to the right worker. The app server’s message processor checks that a client is ready, then request_processors fans out to specialists for catalogs, environments, external-agent imports, MCP servers, conversation turns, threads and goals, thread deletion, Windows sandbox setup, files and file watching, feedback, Git diffs, marketplace changes, plugins, remote control, and search. Small helpers shape model lists, attestation headers, dynamic tool results, and clear error replies.

The core tool router and registry do the same job inside conversations: validate a requested tool, run safety checks, call the tool, and return a readable result. The TUI routing map decides which thread should receive each update. The exec server has its own RPC wiring, registry, connection handler, file-system handler, and process handler for remote execution work. The MCP server routes MCP messages and runs Codex tool calls, while RMCP client handlers pass logging and user-question requests onward. The HTTP proxy routes network requests through policy checks.

## Files in this stage

### App server dispatch core
These files define the app server's top-level routing layer, shared processor utilities, and the broad request families that anchor most connection-scoped message handling.

### `app-server/src/message_processor.rs`

`orchestration` · `startup, request handling, connection teardown`

This file is the central traffic controller for the app server. Clients send JSON-RPC messages, which are structured request and response messages over a connection. Without this file, the server would receive messages but would not know whether they are valid, whether the client has initialized, or which subsystem should answer them.

The main type, `MessageProcessor`, is built at startup with many smaller request processors: account login, configuration, file system access, threads, turns, plugins, search, command execution, and more. Think of it like a reception desk in a large building. The desk does not personally do every task, but it checks who is asking, writes down the request number, and sends the visitor to the right department.

Each connection also has a `ConnectionSessionState`. That records whether the client has sent its required initialize request, what client version it is, whether experimental features are allowed, and whether attestation is requested. Normal requests are rejected until initialization is complete.

The file also bridges token refreshes back to the client. If the login system needs fresh ChatGPT tokens, it sends a server request to the connected client and waits briefly for a response.

A few important safety features live here: request tracing, per-connection cleanup, timeouts while closing a connection, and serialization queues so requests that must not overlap are run in order.

#### Function details

##### `deserialize_client_request`  (lines 98–107)

```
fn deserialize_client_request(
    request: &JSONRPCRequest,
) -> Result<ClientRequest, JSONRPCErrorError>
```

**Purpose**: Turns a raw JSON-RPC request into the project’s typed `ClientRequest` form. This gives the rest of the server a safe, known shape to work with instead of loose JSON.

**Data flow**: It receives a raw request object. It first converts it to JSON data, then tries to parse that JSON as a known client request. If parsing works, it returns the typed request; if not, it returns an “invalid request” error that can be sent back to the client.

**Call relations**: When `MessageProcessor::process_request` receives a JSON-RPC message, it calls this function before any real work begins. A successful result is passed into the shared request handler; a failed result is turned into a client error response.

*Call graph*: called by 1 (process_request); 1 external calls (to_value).


##### `ExternalAuthRefreshBridge::map_reason`  (lines 115–119)

```
fn map_reason(reason: ExternalAuthRefreshReason) -> ChatgptAuthTokensRefreshReason
```

**Purpose**: Converts the login system’s reason for refreshing authentication into the protocol reason that can be sent to the client. Right now, it maps an unauthorized-token case into the matching client-facing reason.

**Data flow**: It receives an internal refresh reason. It matches that reason to the equivalent app-server protocol value and returns it.

**Call relations**: The auth refresh bridge uses this before it asks the client for new tokens, so both sides speak the same protocol language.


##### `ExternalAuthRefreshBridge::auth_mode`  (lines 171–173)

```
fn auth_mode(&self) -> LoginAuthMode
```

**Purpose**: Reports that this external authentication bridge is for ChatGPT authentication. The login system can use this to know what kind of tokens it should expect.

**Data flow**: It reads no outside data. It returns the fixed authentication mode value for ChatGPT.

**Call relations**: This is part of the `ExternalAuth` interface used by the login manager after `MessageProcessor::new` installs the bridge.


##### `ExternalAuthRefreshBridge::refresh`  (lines 175–180)

```
fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> codex_login::ExternalAuthFuture<'_, ExternalAuthTokens>
```

**Purpose**: Asks the connected client to provide fresh ChatGPT authentication tokens. This lets the server recover when tokens expire or are rejected, without doing the refresh itself.

**Data flow**: It receives a refresh context, including why refresh is needed and the previous account id. It sends a token-refresh request to the client, waits up to a fixed timeout, converts any response JSON into token data, and returns fresh external auth tokens. If the client does not answer, cancels, or returns an error, it returns an I/O error.

**Call relations**: The login manager calls this through the `ExternalAuth` interface when it needs refreshed credentials. It sends the request through `OutgoingMessageSender`, then hands the resulting tokens back to the login flow.

*Call graph*: calls 1 internal fn (chatgpt); 7 external calls (pin, map_reason, ChatgptAuthTokensRefresh, other, format!, from_value, timeout).


##### `ConnectionSessionState::default`  (lines 226–228)

```
fn default() -> Self
```

**Purpose**: Creates a fresh connection session state using the normal defaults. This supports standard Rust default construction while keeping all setup in one place.

**Data flow**: It receives no input. It calls the normal constructor and returns a new uninitialized session state.

**Call relations**: Code that needs a default session can use this instead of calling `ConnectionSessionState::new` directly.

*Call graph*: 1 external calls (new).


##### `ConnectionSessionState::new`  (lines 232–237)

```
fn new() -> Self
```

**Purpose**: Creates the per-connection record used to track initialization and request shutdown. Every client connection gets one of these so the server can remember what that client is allowed to do.

**Data flow**: It receives no input. It creates a new RPC gate, which is a guard used to stop or drain in-flight remote calls, and an empty one-time initialization slot. It returns the new session state.

**Call relations**: Startup and connection setup code call this when a new connection begins. Later request-handling code reads and updates this state.

*Call graph*: calls 1 internal fn (new); called by 3 (start_uninitialized, new, new); 2 external calls (new, new).


##### `ConnectionSessionState::initialized`  (lines 239–241)

```
fn initialized(&self) -> bool
```

**Purpose**: Answers whether this connection has completed the required initialize step. The server uses this to reject normal requests that arrive too early.

**Data flow**: It reads the session’s one-time initialization slot. It returns true if that slot has been filled, otherwise false.

**Call relations**: `MessageProcessor::dispatch_initialized_client_request` uses this gate before sending requests to feature processors.

*Call graph*: called by 1 (initialize); 1 external calls (get).


##### `ConnectionSessionState::experimental_api_enabled`  (lines 243–247)

```
fn experimental_api_enabled(&self) -> bool
```

**Purpose**: Answers whether this client opted into experimental API calls. Experimental calls are blocked unless this returns true.

**Data flow**: It reads the initialized session data, if present. It returns the stored experimental flag, or false if the connection was never initialized.

**Call relations**: The initialized request dispatcher checks this when a request says it needs an experimental API.

*Call graph*: 1 external calls (get).


##### `ConnectionSessionState::opted_out_notification_methods`  (lines 249–254)

```
fn opted_out_notification_methods(&self) -> HashSet<String>
```

**Purpose**: Returns the notification method names that this client does not want to receive. This helps the server avoid sending unwanted notification types.

**Data flow**: It reads the initialized session data. If present, it clones and returns the stored set of method names; if not, it returns an empty set.

**Call relations**: Other connection and outgoing-message code can use this session setting after initialization.

*Call graph*: 1 external calls (get).


##### `ConnectionSessionState::app_server_client_name`  (lines 256–260)

```
fn app_server_client_name(&self) -> Option<&str>
```

**Purpose**: Returns the client application name that was provided during initialization. This is useful for logging, tracing, and feature behavior that depends on the calling client.

**Data flow**: It reads the initialized session data. It returns the client name as text if initialization happened, or no value if it did not.

**Call relations**: Tracing and request dispatch use this value to label requests and to pass client identity to processors such as remote control or thread handling.

*Call graph*: called by 2 (client_name, typed_request_span); 1 external calls (get).


##### `ConnectionSessionState::client_version`  (lines 262–266)

```
fn client_version(&self) -> Option<&str>
```

**Purpose**: Returns the client version supplied during initialization. This helps the server understand which client build is talking to it.

**Data flow**: It reads the initialized session data. It returns the version text if present, or no value before initialization.

**Call relations**: Tracing and some request processors receive this value so thread and turn activity can be associated with the client version.

*Call graph*: called by 2 (client_version, typed_request_span); 1 external calls (get).


##### `ConnectionSessionState::request_attestation`  (lines 268–272)

```
fn request_attestation(&self) -> bool
```

**Purpose**: Answers whether this client requested attestation, which is a proof-like check about the running app environment. The server uses this when enabling connection capabilities.

**Data flow**: It reads the initialized session data. It returns the stored attestation flag, or false if the connection is not initialized.

**Call relations**: After initialization, `MessageProcessor::handle_client_request` and `MessageProcessor::connection_initialized` pass this capability to the thread processor.

*Call graph*: 1 external calls (get).


##### `ConnectionSessionState::initialize`  (lines 274–276)

```
fn initialize(&self, session: InitializedConnectionSessionState) -> Result<(), ()>
```

**Purpose**: Stores the finalized initialization information for a connection. It is intentionally one-time only, so a connection cannot silently change its identity or feature permissions later.

**Data flow**: It receives an initialized session record. It tries to place that record into the session’s one-time slot. It returns success if the slot was empty, or failure if initialization had already happened.

**Call relations**: The initialize request processor calls this during the client’s initialize request. Later session-checking methods read the stored values.

*Call graph*: called by 1 (initialize); 1 external calls (set).


##### `MessageProcessor::new`  (lines 301–564)

```
fn new(args: MessageProcessorArgs) -> Self
```

**Purpose**: Builds the main message processor and all of the specialized processors it delegates to. This is the server’s wiring step: it connects configuration, authentication, thread state, plugins, file watching, analytics, and outgoing messages.

**Data flow**: It receives a large bundle of shared services and startup settings. It installs the external auth refresh bridge, creates core thread and environment services, builds each request processor with the dependencies it needs, optionally starts plugin warmup work, and returns a fully ready `MessageProcessor`.

**Call relations**: Server startup paths call this before requests can be handled. The object it returns is then used by JSON-RPC transports and in-process clients to process requests, responses, notifications, and connection shutdown.

*Call graph*: calls 27 internal fn (new, new, new, new, new, new, new, new, new, new (+15 more)); called by 4 (start_uninitialized, build_test_processor, run_main_with_transport_options, run_main); 11 external calls (clone, new, new_cyclic, new, new, new, new, default, default, thread_store_from_config (+1 more)).


##### `MessageProcessor::clear_runtime_references`  (lines 566–570)

```
fn clear_runtime_references(&self)
```

**Purpose**: Breaks selected runtime links during cleanup. This helps long-lived components stop holding references to authentication and background watchers after the processor is no longer active.

**Data flow**: It reads the stored account, apps, and skills watcher processors. It clears external auth from the account processor and asks the apps and skills watchers to shut down.

**Call relations**: Shutdown or test cleanup code can call this when the processor should release background/runtime resources.

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

**Purpose**: Processes a raw JSON-RPC request received over a transport such as a websocket. It adds tracing, turns JSON into a typed request, and sends errors back if anything fails.

**Data flow**: It receives the connection id, raw request, transport information, and session state. It builds a connection-scoped request id and tracing context, deserializes the request, runs the shared request handler, and sends an error response if the request cannot be parsed or handled.

**Call relations**: This is the JSON transport entry point into the processor. It calls `deserialize_client_request`, then delegates valid requests to `MessageProcessor::handle_client_request` inside `MessageProcessor::run_request_with_context`.

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

**Purpose**: Processes an already-typed request from an in-process client. This skips JSON parsing but otherwise follows the same rules as network requests.

**Data flow**: It receives a connection id, typed request, session state, and a flag used to mark outgoing messages as ready after initialization. It builds request identity and tracing information, calls the shared handler, and sends an error response if handling fails.

**Call relations**: In-process embedders use this instead of `process_request`. It still delegates to `MessageProcessor::handle_client_request` so behavior stays consistent across client types.

*Call graph*: calls 3 internal fn (typed_request_span, handle_client_request, new); 4 external calls (clone, id, run_request_with_context, trace!).


##### `MessageProcessor::process_notification`  (lines 674–678)

```
async fn process_notification(&self, notification: JSONRPCNotification)
```

**Purpose**: Receives a raw JSON-RPC notification from a client and logs it. The server currently does not expect clients to send notifications here.

**Data flow**: It receives a notification object. It writes an informational log entry and makes no other state changes.

**Call relations**: Transport code can call this when a notification arrives. Since notifications are not part of the expected client protocol, it does not delegate further.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::process_client_notification`  (lines 681–685)

```
async fn process_client_notification(&self, notification: ClientNotification)
```

**Purpose**: Receives a typed notification from an in-process client and logs it. This mirrors the raw notification path for clients that do not use JSON.

**Data flow**: It receives a typed client notification. It records it in the logs and returns without changing server state.

**Call relations**: In-process client code can call this when it has a notification. Like `process_notification`, it does not hand the message to a feature processor.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::run_request_with_context`  (lines 687–698)

```
async fn run_request_with_context(
        outgoing: Arc<OutgoingMessageSender>,
        request_context: RequestContext,
        request_fut: F,
    )
```

**Purpose**: Runs a request while registering its context for outgoing messages and tracing. This makes logs and responses easier to connect back to the original request.

**Data flow**: It receives the outgoing message sender, a request context, and the future that performs the request work. It registers the context, runs the future inside the tracing span, and produces no direct response itself.

**Call relations**: `process_request` and `process_client_request` wrap their request handling with this helper before calling deeper request logic.

*Call graph*: calls 1 internal fn (span); 2 external calls (instrument, clone).


##### `MessageProcessor::thread_created_receiver`  (lines 700–702)

```
fn thread_created_receiver(&self) -> broadcast::Receiver<ThreadId>
```

**Purpose**: Provides a subscription channel that reports when new threads are created. Other parts of the server can listen for thread creation without owning the thread processor.

**Data flow**: It reads the thread processor and asks it for a receiver. It returns that receiver to the caller.

**Call relations**: Code that needs thread-created events calls this on the message processor, which forwards the request to the thread processor.

*Call graph*: calls 1 internal fn (thread_created_receiver).


##### `MessageProcessor::send_initialize_notifications_to_connection`  (lines 704–711)

```
async fn send_initialize_notifications_to_connection(
        &self,
        connection_id: ConnectionId,
    )
```

**Purpose**: Sends the startup notifications that belong to one specific connection. This is used after a client initializes so it receives the current server state.

**Data flow**: It receives a connection id. It asks the initialize processor to send initialization notifications only to that connection.

**Call relations**: Connection setup code calls this around the initialize flow. The work is delegated to the initialize processor.

*Call graph*: calls 1 internal fn (send_initialize_notifications_to_connection).


##### `MessageProcessor::connection_initialized`  (lines 713–726)

```
async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        request_attestation: bool,
    )
```

**Purpose**: Tells the thread processor that a connection has finished initialization and what capabilities it has. This lets thread-related notifications and behavior become active for that connection.

**Data flow**: It receives a connection id and whether attestation is requested. It builds a connection capabilities record and passes it to the thread processor.

**Call relations**: Connection lifecycle code can call this after initialization. The same capability update also happens from `handle_client_request` when an initialize request completes.

*Call graph*: calls 1 internal fn (connection_initialized).


##### `MessageProcessor::send_initialize_notifications`  (lines 728–732)

```
async fn send_initialize_notifications(&self)
```

**Purpose**: Sends initialization-related notifications broadly, not just to one connection. This is useful when global initial state needs to be pushed out.

**Data flow**: It reads the initialize processor and asks it to send its notifications. It returns after that asynchronous work completes.

**Call relations**: Startup or connection orchestration code calls this, and the initialize processor does the actual notification sending.

*Call graph*: calls 1 internal fn (send_initialize_notifications).


##### `MessageProcessor::try_attach_thread_listener`  (lines 734–742)

```
async fn try_attach_thread_listener(
        &self,
        thread_id: ThreadId,
        connection_ids: Vec<ConnectionId>,
    )
```

**Purpose**: Attempts to attach one or more connections as listeners to a thread. This is how clients can start receiving updates for a thread they care about.

**Data flow**: It receives a thread id and a list of connection ids. It passes both to the thread processor, which decides whether and how to attach the listeners.

**Call relations**: Connection orchestration uses this when restoring or setting up thread subscriptions. The message processor simply forwards the request to the thread processor.

*Call graph*: calls 1 internal fn (try_attach_thread_listener).


##### `MessageProcessor::drain_background_tasks`  (lines 744–746)

```
async fn drain_background_tasks(&self)
```

**Purpose**: Waits for thread-related background work to settle. This is useful during shutdown or tests so work does not keep running unexpectedly.

**Data flow**: It reads the thread processor and awaits its background-task drain operation. It returns when the thread processor reports completion.

**Call relations**: Shutdown and test flows call this through the message processor, which delegates to the thread processor.

*Call graph*: calls 1 internal fn (drain_background_tasks).


##### `MessageProcessor::cancel_active_login`  (lines 748–750)

```
async fn cancel_active_login(&self)
```

**Purpose**: Cancels any login flow that is currently in progress. This prevents an abandoned login attempt from continuing after the user or connection no longer needs it.

**Data flow**: It reads the account processor and asks it to cancel the active login operation. It returns once cancellation has been requested or completed.

**Call relations**: Connection or app shutdown code can call this. The actual login state lives in the account processor.

*Call graph*: calls 1 internal fn (cancel_active_login).


##### `MessageProcessor::clear_all_thread_listeners`  (lines 752–754)

```
async fn clear_all_thread_listeners(&self)
```

**Purpose**: Removes all registered thread listeners. This is a cleanup tool for stopping thread updates from being sent to stale connections.

**Data flow**: It reads the thread processor and asks it to clear every listener registration. It returns when that cleanup finishes.

**Call relations**: Lifecycle cleanup code calls this through the message processor, which delegates to the thread processor.

*Call graph*: calls 1 internal fn (clear_all_thread_listeners).


##### `MessageProcessor::shutdown_threads`  (lines 756–758)

```
async fn shutdown_threads(&self)
```

**Purpose**: Shuts down active thread work. This helps the server stop conversations and related background processing cleanly.

**Data flow**: It reads the thread processor and awaits its shutdown operation. It returns once the thread processor has completed its shutdown steps.

**Call relations**: Server teardown calls this on the message processor; the thread processor performs the actual shutdown.

*Call graph*: calls 1 internal fn (shutdown_threads).


##### `MessageProcessor::connection_closed`  (lines 760–787)

```
async fn connection_closed(
        &self,
        connection_id: ConnectionId,
        session_state: &ConnectionSessionState,
    )
```

**Purpose**: Cleans up everything tied to a connection after it closes. This stops pending RPCs, removes outgoing state, ends file watches and command/process sessions, and detaches thread listeners.

**Data flow**: It receives the closed connection id and its session state. It waits for the connection’s RPC gate to drain, but only up to a timeout; if that times out it logs a warning. Then it notifies the outgoing sender and several processors that the connection is gone.

**Call relations**: Transport code calls this when a client disconnects. The method fans the close event out to the subsystems that may have stored connection-specific resources.

*Call graph*: calls 4 internal fn (connection_closed, connection_closed, connection_closed, connection_closed); 2 external calls (timeout, warn!).


##### `MessageProcessor::subscribe_running_assistant_turn_count`  (lines 789–792)

```
fn subscribe_running_assistant_turn_count(&self) -> watch::Receiver<usize>
```

**Purpose**: Returns a live subscription to the number of assistant turns currently running. A caller can use this to update UI or shutdown logic when active work changes.

**Data flow**: It asks the thread processor for a watch receiver, which is a small channel that always holds the latest value. It returns that receiver.

**Call relations**: Other app-server code calls this through the message processor; the count itself is maintained by the thread processor.

*Call graph*: calls 1 internal fn (subscribe_running_assistant_turn_count).


##### `MessageProcessor::process_response`  (lines 795–799)

```
async fn process_response(&self, response: JSONRPCResponse)
```

**Purpose**: Processes a standalone response sent by the client. This is mainly for server-initiated requests where the server is waiting for the client’s answer.

**Data flow**: It receives a JSON-RPC response, logs it, extracts the id and result, and notifies the outgoing message sender so the waiting request can continue.

**Call relations**: Transport code calls this when the peer sends a response. It connects that response back to a pending request previously sent through `OutgoingMessageSender`, such as auth token refresh.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::process_error`  (lines 802–805)

```
async fn process_error(&self, err: JSONRPCError)
```

**Purpose**: Processes an error response sent by the client. This lets a server-initiated request fail in the right waiting task instead of being lost.

**Data flow**: It receives a JSON-RPC error object, logs it as an error, extracts its id and error details, and notifies the outgoing message sender.

**Call relations**: Transport code calls this when the peer answers a server request with an error. The outgoing message sender wakes the code waiting for that response.

*Call graph*: 1 external calls (error!).


##### `MessageProcessor::handle_client_request`  (lines 807–850)

```
async fn handle_client_request(
        self: &Arc<Self>,
        connection_request_id: ConnectionRequestId,
        codex_request: ClientRequest,
        session: Arc<ConnectionSessionState>,
```

**Purpose**: Applies the first major rule for client requests: initialize requests are handled specially, and all other requests go through the initialized-request path. This keeps connection setup separate from normal work.

**Data flow**: It receives a connection request id, typed request, session state, optional outbound-ready flag, and request context. If the request is initialize, it asks the initialize processor to initialize the session and then informs the thread processor if the connection became initialized. Otherwise, it passes the request to the initialized dispatcher.

**Call relations**: `process_request` and `process_client_request` both call this. It either delegates to the initialize processor or to `MessageProcessor::dispatch_initialized_client_request`.

*Call graph*: calls 3 internal fn (dispatch_initialized_client_request, initialize, connection_initialized); called by 2 (process_client_request, process_request).


##### `MessageProcessor::dispatch_initialized_client_request`  (lines 852–913)

```
async fn dispatch_initialized_client_request(
        self: &Arc<Self>,
        connection_request_id: ConnectionRequestId,
        codex_request: ClientRequest,
        session: Arc<ConnectionSession
```

**Purpose**: Checks that a normal request is allowed to run, then schedules it. This protects the server from requests before initialization and from experimental calls made without opt-in.

**Data flow**: It receives the connection request id, typed request, session state, and request context. It rejects the request if the session is not initialized or if the request needs experimental access that the session lacks. Otherwise, it records the request, wraps the work in a queued request object, and either enqueues it in a serialization queue or spawns it immediately.

**Call relations**: `handle_client_request` calls this for every non-initialize request. It eventually runs `MessageProcessor::handle_initialized_client_request`, either directly in a spawned task or through a queue when ordering is required.

*Call graph*: calls 6 internal fn (invalid_request, span, track_initialized_request, new, from_scope, enqueue); called by 1 (handle_client_request); 6 external calls (clone, experimental_reason, serialization_scope, clone, experimental_required_message, spawn).


##### `MessageProcessor::handle_initialized_client_request`  (lines 915–1485)

```
async fn handle_initialized_client_request(
        self: Arc<Self>,
        connection_request_id: ConnectionRequestId,
        codex_request: ClientRequest,
        request_context: RequestContext,
```

**Purpose**: This is the main request router for all fully initialized client requests. It matches each request type to the specialized processor that actually knows how to do the work.

**Data flow**: It receives the connection/request identity, typed request, request context, and optional client name/version. It builds the response request id, matches on the request variant, calls the right processor with the request parameters, then sends either a response payload, no response for fire-and-follow-up operations, or an error back to the client.

**Call relations**: `dispatch_initialized_client_request` schedules this after initialization checks pass. It hands work to processors for config, remote control, files, threads, turns, catalog, marketplace, plugins, apps, MCP, sandbox setup, accounts, git, search, command execution, process execution, and feedback upload.

*Call graph*: calls 120 internal fn (cancel_login_account, get_account, get_account_rate_limits, get_account_token_usage, get_auth_status, login_account, logout_account, send_add_credits_nudge_email, apps_list, collaboration_mode_list (+15 more)); 4 external calls (id, consume_account_rate_limit_reset_credit, thread_delete, panic!).


### `app-server/src/request_processors.rs`

`orchestration` · `request handling`

The app server receives many kinds of client requests: start a thread, list plugins, read files, log in, run commands, inspect Git state, and more. This file acts like the reception desk for that whole area. It does not do all of that work itself. Instead, it declares the smaller processor modules, makes their main processor types available to the rest of the app, and keeps shared conversion helpers close to the request layer.

A major job here is translating outside-facing protocol data into the shapes the core engine expects. For example, a client may send a working directory as a normal path. The server must normalize it and reject it if it is not safe or valid. A client may also choose execution environments for a turn; this file checks those choices and converts their paths into a consistent URI-style form before handing them to the thread manager.

Another helper turns saved rollout history into API-level conversation turns. It filters out history items that should not be shown as persisted conversation data, then feeds the rest into a history builder. Without this file, the request layer would lose its central wiring point, and common validation rules would likely be duplicated or applied inconsistently across processors.

#### Function details

##### `resolve_request_cwd`  (lines 536–542)

```
fn resolve_request_cwd(cwd: Option<PathBuf>) -> Result<Option<AbsolutePathBuf>, JSONRPCErrorError>
```

**Purpose**: This helper checks and normalizes an optional current working directory sent by a client. It makes sure the path can be treated as an absolute path the server understands, and turns bad input into a clear JSON-RPC request error.

**Data flow**: It receives either no path or a client-provided path. If there is no path, it returns no path. If there is a path, it first normalizes it for the machine’s native working-directory rules, then tries to resolve it relative to the current directory into an absolute path. On success, the output is the cleaned absolute path; on failure, the output is an error saying the cwd is invalid.

**Call relations**: This is a shared request-layer helper used when a processor needs to accept a client-supplied working directory before starting or reading something. It prepares the path before deeper code sees it, so lower layers can work with a trusted absolute path instead of re-checking raw client text.


##### `resolve_turn_environment_selections`  (lines 544–573)

```
fn resolve_turn_environment_selections(
    thread_manager: &ThreadManager,
    environments: Option<Vec<TurnEnvironmentParams>>,
) -> Result<Option<Vec<TurnEnvironmentSelection>>, JSONRPCErrorError>
```

**Purpose**: This helper translates a client’s requested turn environments into the core engine’s environment selection format. It also asks the thread manager to confirm that those selections are allowed and meaningful.

**Data flow**: It receives the thread manager and an optional list of environment choices from the client. If the list is missing, it returns no selections. If present, it walks each choice, extracts the environment id, converts the provided working directory into an absolute path URI, and rejects paths that do not look like valid POSIX or Windows absolute paths. After building the list, it asks the thread manager to validate it. The result is either a checked list of environment selections or a request error.

**Call relations**: Request processors use this before a turn is run in one or more environments. Inside, it builds the list efficiently, then hands the finished selections to `validate_environment_selections` so the thread manager can enforce the rules it owns. That keeps path parsing in the request layer and environment validity in the thread layer.

*Call graph*: calls 1 internal fn (validate_environment_selections); 1 external calls (with_capacity).


##### `resolve_runtime_workspace_roots`  (lines 575–583)

```
fn resolve_runtime_workspace_roots(workspace_roots: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf>
```

**Purpose**: This helper removes duplicate workspace root paths while keeping their original order. It is used so runtime setup sees each workspace folder only once.

**Data flow**: It receives a list of absolute workspace root paths. It creates a fresh output list, walks the input from left to right, and copies each path only if it has not already been added. The output is the same set of roots without repeats, preserving the first occurrence of each one.

**Call relations**: This sits between request/config input and the runtime workspace setup. Other request-processing code can pass potentially repeated roots through it before handing them to lower layers, avoiding redundant work or confusing duplicated workspace entries.

*Call graph*: 1 external calls (new).


##### `build_api_turns_from_rollout_items`  (lines 609–617)

```
fn build_api_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn>
```

**Purpose**: This helper rebuilds client-facing conversation turns from stored rollout history. A rollout item is a saved piece of thread history; this function keeps only the items that should count as persisted conversation history.

**Data flow**: It receives a slice of rollout history items. It creates a new `ThreadHistoryBuilder`, checks each item with `is_persisted_rollout_item`, and feeds only the persisted items into the builder. At the end, it asks the builder to finish and returns a list of API `Turn` objects suitable for sending back to a client.

**Call relations**: This is used when request processors need to present saved thread history through the app-server protocol. It relies on `is_persisted_rollout_item` to avoid exposing temporary or non-history events, then delegates the actual assembly of turns to `ThreadHistoryBuilder`.

*Call graph*: calls 1 internal fn (new); 1 external calls (is_persisted_rollout_item).


### `app-server/src/request_processors/request_errors.rs`

`io_transport` · `request handling`

When a request asks the server to use certain environment settings, those settings may need to be checked before the request can continue. This file contains a small translator for errors from that check. Its job is like a customer-service desk deciding whether a problem is the customer's form being filled out wrong, or something going wrong behind the counter.

The key distinction is between an invalid request and an internal error. If the lower-level code reports `CodexErr::InvalidRequest`, this file keeps that meaning and turns the message into a JSON-RPC “invalid request” error. JSON-RPC is the request-and-response format used by the server API. If the error is anything else, the file treats it as a server-side failure and wraps it in a more general internal error message: “failed to validate environment selections: ...”.

This matters because clients need honest feedback. If they sent bad input, they can fix it. If the server failed internally, the client should not be told that their request shape was the problem. Without this small mapping, the API could blur those cases and make failures harder to understand and debug.

#### Function details

##### `environment_selection_error`  (lines 3–8)

```
fn environment_selection_error(err: CodexErr) -> JSONRPCErrorError
```

**Purpose**: This function converts a `CodexErr` from environment selection validation into the JSON-RPC error type expected by the server response path. It preserves client-input errors as “invalid request” errors, and turns all other failures into internal server errors.

**Data flow**: It receives one error value. If that value says the request itself was invalid, it takes the included message and produces an invalid-request JSON-RPC error. For any other error, it builds a message explaining that environment selection validation failed, includes the original error text, and returns an internal JSON-RPC error.

**Call relations**: This helper sits at the boundary between validation code and API response code. When request-processing code needs to report a failed environment selection check, it can call this function to get the right client-facing JSON-RPC error. Inside, it only formats the unexpected-error message before handing it to the standard internal-error response builder.

*Call graph*: 1 external calls (format!).


### `app-server/src/request_processors/catalog_processor.rs`

`orchestration` · `request handling`

Think of this file as the app server’s catalog desk. A client asks for a list of things it can use, and this processor gathers the right information from configuration, authentication, workspace settings, plugin state, and thread state, then returns it in the app server protocol’s response format.

The main type, `CatalogRequestProcessor`, is built with shared services: an outgoing message sender, skill watcher, authentication manager, thread manager, configuration manager, and workspace settings cache. Its public methods are thin request handlers. They receive typed request parameters, call a more specific helper, and wrap the result as a client response.

The heavier work happens in the private helpers. For skills and hooks, the file reloads or resolves configuration for each requested working directory. A working directory is the folder the user is operating in. It checks whether workspace Codex plugins are allowed, because plugin-provided skills and hooks should not appear when the workspace has disabled them. It converts internal skill, hook, and error records into protocol records that the client understands.

The file also implements simple paged lists for models, experimental features, and permission profiles. Pagination means returning a slice of a longer list plus a cursor, like a bookmark for the next page. Without this file, clients would not have one reliable place to discover available capabilities or update skill visibility.

#### Function details

##### `skills_to_info`  (lines 18–62)

```
fn skills_to_info(
    skills: &[codex_core::skills::SkillMetadata],
    disabled_paths: &HashSet<AbsolutePathBuf>,
) -> Vec<codex_app_server_protocol::SkillMetadata>
```

**Purpose**: Turns internal skill records into the public skill records sent to clients. It also marks each skill as enabled or disabled by checking whether its file path appears in the disabled-path list.

**Data flow**: It receives a list of internal skill metadata and a set of disabled skill paths. For each skill, it copies user-facing fields such as name, descriptions, interface details, dependencies, path, and scope into protocol-friendly objects, then adds an `enabled` flag. It returns a new list ready to include in a response.

**Call relations**: This is a translation step used when building a skills list response. The skill loader produces detailed internal records, and this helper reshapes them into the simpler form the client expects.

*Call graph*: 1 external calls (iter).


##### `hooks_to_info`  (lines 64–85)

```
fn hooks_to_info(hooks: &[codex_hooks::HookListEntry]) -> Vec<HookMetadata>
```

**Purpose**: Turns internal hook entries into hook metadata that can be sent over the app server protocol. A hook is a command or action that can run when a named event happens.

**Data flow**: It receives hook entries from the hook system. For each one, it copies fields such as key, event name, handler type, command, timeout, source, plugin id, enabled state, and trust status into a protocol record. It returns the converted list.

**Call relations**: When `CatalogRequestProcessor::hooks_list_response` has finished asking the hook system for hooks, it calls this helper to prepare those hooks for the client response.

*Call graph*: called by 1 (hooks_list_response); 1 external calls (iter).


##### `errors_to_info`  (lines 87–97)

```
fn errors_to_info(
    errors: &[codex_core::skills::SkillError],
) -> Vec<codex_app_server_protocol::SkillErrorInfo>
```

**Purpose**: Turns internal skill loading errors into error records that clients can display. This keeps the client from needing to know the internal error type.

**Data flow**: It receives skill errors, each with a path and message. It copies each path and message into a protocol error object. It returns the list of displayable error records.

**Call relations**: This helper sits between skill loading and response creation. When skill discovery finds problems, this function packages those problems in the response format.

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

**Purpose**: Creates a `CatalogRequestProcessor` with all the shared services it needs. This is the setup step that gives later request handlers access to configuration, authentication, threads, skills, and outgoing notifications.

**Data flow**: It receives shared pointers to server services and stores them in a new processor struct. Nothing is loaded or sent yet; the result is a ready-to-use processor object.

**Call relations**: This constructor is called during server setup when request processors are assembled. Later, the initialized processor is used by the central client request handler.

*Call graph*: called by 1 (new).


##### `CatalogRequestProcessor::skills_list`  (lines 120–127)

```
async fn skills_list(
        &self,
        params: SkillsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles the public `skills/list` style request. It asks the detailed skills-list helper for the answer and wraps that answer as a generic client response.

**Data flow**: It receives skill list parameters, including requested folders and whether to force a reload. It passes them to `CatalogRequestProcessor::skills_list_response`, then converts the typed response into the common response payload shape. It returns either that payload or a JSON-RPC error.

**Call relations**: The central initialized-client request dispatcher calls this method when the client asks for skills. This method then hands the real work to `CatalogRequestProcessor::skills_list_response`.

*Call graph*: calls 1 internal fn (skills_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::hooks_list`  (lines 129–136)

```
async fn hooks_list(
        &self,
        params: HooksListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles the public hook-list request. It delegates the real lookup to the hook-list helper and wraps the result for the client.

**Data flow**: It receives hook list parameters, passes them to `CatalogRequestProcessor::hooks_list_response`, and converts the typed hook response into a generic client response payload. It returns the payload or an error.

**Call relations**: The main client request handler calls this when a client asks to list hooks. It acts as the doorway into `CatalogRequestProcessor::hooks_list_response`.

*Call graph*: calls 1 internal fn (hooks_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::skills_config_write`  (lines 138–145)

```
async fn skills_config_write(
        &self,
        params: SkillsConfigWriteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a request to change whether a skill is enabled. It validates and applies the change through the inner helper, then returns a client response.

**Data flow**: It receives parameters naming a skill by path or name plus the desired enabled state. It passes them to `CatalogRequestProcessor::skills_config_write_response_inner`, then wraps the typed result. The returned response tells the client the effective enabled value.

**Call relations**: The initialized-client request dispatcher calls this for skill configuration writes. This method keeps the public request shape separate from the lower-level config editing work.

*Call graph*: calls 1 internal fn (skills_config_write_response_inner); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::skills_extra_roots_set`  (lines 147–154)

```
async fn skills_extra_roots_set(
        &self,
        params: SkillsExtraRootsSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a request to set extra runtime folders where skills should be searched for. This lets the client add skill sources without editing permanent configuration.

**Data flow**: It receives a list of extra root paths and passes them to `CatalogRequestProcessor::skills_extra_roots_set_response`. The helper updates the watcher and skill manager, sends a change notification, and returns an empty success response wrapped for the client.

**Call relations**: The central request handler calls this when the client changes extra skill roots. It delegates to the response helper that performs the update and notifies listeners.

*Call graph*: calls 1 internal fn (skills_extra_roots_set_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::model_list`  (lines 156–163)

```
async fn model_list(
        &self,
        params: ModelListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a request to list available AI models. It supports paging so clients can ask for models in chunks instead of needing the whole list at once.

**Data flow**: It receives model list parameters such as limit, cursor, and whether to include hidden models. It calls the model-listing helper with the thread manager, then wraps the typed response as a client payload. It returns that payload or an error for invalid input such as a bad cursor.

**Call relations**: The initialized-client request handler calls this for model list requests. It hands off to `CatalogRequestProcessor::list_models`, which does the actual model collection and pagination.

*Call graph*: called by 1 (handle_initialized_client_request); 1 external calls (list_models).


##### `CatalogRequestProcessor::experimental_feature_list`  (lines 165–172)

```
async fn experimental_feature_list(
        &self,
        params: ExperimentalFeatureListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a request to list feature flags, including whether each feature is enabled. Feature flags are switches used to expose, hide, or retire product behavior.

**Data flow**: It receives feature list parameters, including optional thread context and paging information. It calls `CatalogRequestProcessor::experimental_feature_list_response`, then wraps the typed response for the client. The output is a page of feature records.

**Call relations**: The central initialized-client request dispatcher calls this method for experimental feature list requests. It delegates the detailed config and workspace checks to the response helper.

*Call graph*: calls 1 internal fn (experimental_feature_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::permission_profile_list`  (lines 174–181)

```
async fn permission_profile_list(
        &self,
        params: PermissionProfileListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a request to list permission profiles. A permission profile is a named bundle of rules about what the assistant may do.

**Data flow**: It receives optional folder and paging parameters, passes them to `CatalogRequestProcessor::permission_profile_list_response`, and wraps the typed result into a generic client response. Errors are returned if configuration cannot be read or the cursor is invalid.

**Call relations**: The initialized-client request handler calls this when the client asks for permission profiles. This method forwards the work to the helper that reads configuration layers and builds the page.

*Call graph*: calls 1 internal fn (permission_profile_list_response); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::collaboration_mode_list`  (lines 183–190)

```
async fn collaboration_mode_list(
        &self,
        params: CollaborationModeListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a request to list available collaboration modes. These modes describe different ways the user and assistant can work together in a thread.

**Data flow**: It receives an empty collaboration-mode parameter object, asks the thread manager for the available modes through the helper, and wraps the result. It returns the list in the client response format.

**Call relations**: The central client request handler calls this for collaboration-mode requests. It delegates to `CatalogRequestProcessor::list_collaboration_modes`, which asks the thread manager for the actual data.

*Call graph*: called by 1 (handle_initialized_client_request); 1 external calls (list_collaboration_modes).


##### `CatalogRequestProcessor::mock_experimental_method`  (lines 192–199)

```
async fn mock_experimental_method(
        &self,
        params: MockExperimentalMethodParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a test-like experimental request by echoing a value back to the caller. It is useful for checking that the request path and response wrapping work.

**Data flow**: It receives a value in the request parameters, passes it to `CatalogRequestProcessor::mock_experimental_method_inner`, and wraps the echo response. The output contains the same value under an `echoed` field.

**Call relations**: The initialized-client request dispatcher calls this for the mock experimental method. The public method simply connects that request to the inner echo helper.

*Call graph*: calls 1 internal fn (mock_experimental_method_inner); called by 1 (handle_initialized_client_request).


##### `CatalogRequestProcessor::resolve_cwd_config`  (lines 201–214)

```
async fn resolve_cwd_config(
        &self,
        cwd: &Path,
    ) -> Result<(AbsolutePathBuf, ConfigLayerStack), String>
```

**Purpose**: Converts a requested working directory into an absolute path and loads the configuration layers that apply there. Configuration layers are the stacked settings from places like defaults, user config, and workspace config.

**Data flow**: It receives a folder path, makes it absolute relative to the current process, then asks the configuration manager to load the config layers for that folder. It returns the absolute folder and its layer stack, or a plain error message string if something fails.

**Call relations**: This helper is used when a request depends on folder-specific configuration, including permission profile listing and skill listing. It relies on path conversion and the config manager’s `load_config_layers_for_cwd` operation.

*Call graph*: calls 2 internal fn (load_config_layers_for_cwd, relative_to_current_dir); called by 1 (permission_profile_list_response).


##### `CatalogRequestProcessor::load_latest_config`  (lines 216–224)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the newest effective configuration. This prevents catalog answers from being based on stale settings after the user has changed config files.

**Data flow**: It receives an optional fallback working directory, asks the configuration manager for the latest config, and converts any load failure into a JSON-RPC internal error. It returns a fresh `Config` object on success.

**Call relations**: Feature listing and skill listing call this before deciding what is enabled. It is a small adapter around the config manager that also standardizes the error message.

*Call graph*: calls 1 internal fn (load_latest_config); called by 2 (experimental_feature_list_response, skills_list_response).


##### `CatalogRequestProcessor::workspace_codex_plugins_enabled`  (lines 226–246)

```
async fn workspace_codex_plugins_enabled(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> bool
```

**Purpose**: Checks whether Codex plugins are allowed for the current workspace. If the check fails, it logs a warning and chooses to allow plugins rather than hide them because of a lookup problem.

**Data flow**: It receives the current config and optional authentication information. It asks the workspace settings system, using the local cache, whether plugins are enabled. It returns a boolean; on error it writes a warning and returns `true`.

**Call relations**: Skill listing, hook listing, and feature listing call this before exposing plugin-related capabilities. It is the gatekeeper that combines workspace policy with catalog results.

*Call graph*: calls 1 internal fn (codex_plugins_enabled_for_workspace); called by 3 (experimental_feature_list_response, hooks_list_response, skills_list_response); 1 external calls (warn!).


##### `CatalogRequestProcessor::list_models`  (lines 248–293)

```
async fn list_models(
        thread_manager: Arc<ThreadManager>,
        params: ModelListParams,
    ) -> Result<ModelListResponse, JSONRPCErrorError>
```

**Purpose**: Builds a paged list of supported AI models. Paging keeps the response manageable and gives the client a cursor for the next page.

**Data flow**: It receives a thread manager plus parameters for limit, cursor, and hidden-model visibility. It gets the full model list, checks and parses the cursor, slices out the requested page, and returns the page plus the next cursor if more models remain. Bad cursors become invalid-request errors.

**Call relations**: The public `CatalogRequestProcessor::model_list` method calls this when the client asks for models. This helper performs the list lookup and pagination before handing the typed response back.

*Call graph*: 2 external calls (new, format!).


##### `CatalogRequestProcessor::list_collaboration_modes`  (lines 295–307)

```
async fn list_collaboration_modes(
        thread_manager: Arc<ThreadManager>,
        params: CollaborationModeListParams,
    ) -> Result<CollaborationModeListResponse, JSONRPCErrorError>
```

**Purpose**: Collects the collaboration modes known to the thread manager and converts them into protocol records. It is a simple catalog lookup with no paging.

**Data flow**: It receives a thread manager and empty parameters. It asks the thread manager for collaboration modes, converts each one into the response type, and returns them in a response object.

**Call relations**: The public `CatalogRequestProcessor::collaboration_mode_list` method calls this. The thread manager owns the source list, and this helper packages it for the client.


##### `CatalogRequestProcessor::experimental_feature_list_response`  (lines 309–415)

```
async fn experimental_feature_list_response(
        &self,
        params: ExperimentalFeatureListParams,
    ) -> Result<ExperimentalFeatureListResponse, JSONRPCErrorError>
```

**Purpose**: Creates the actual response for listing feature flags. It tells the client each feature’s name, stage, display text when available, and whether it is currently enabled.

**Data flow**: It receives paging parameters and an optional thread id. If a thread id is provided, it loads configuration as that thread sees it; otherwise it reloads the latest general config. It checks workspace plugin policy, converts every feature specification into an API feature record, applies paging, and returns the selected page with an optional next cursor.

**Call relations**: The public `CatalogRequestProcessor::experimental_feature_list` method calls this. Inside, it may load thread-specific config, call `CatalogRequestProcessor::load_latest_config`, and call `CatalogRequestProcessor::workspace_codex_plugins_enabled` so plugin and app features are reported correctly.

*Call graph*: calls 4 internal fn (load_latest_config_for_thread, load_latest_config, workspace_codex_plugins_enabled, from_string); called by 1 (experimental_feature_list); 2 external calls (new, format!).


##### `CatalogRequestProcessor::permission_profile_list_response`  (lines 417–487)

```
async fn permission_profile_list_response(
        &self,
        params: PermissionProfileListParams,
    ) -> Result<PermissionProfileListResponse, JSONRPCErrorError>
```

**Purpose**: Creates the actual response for listing permission profiles. It includes built-in profiles and any custom profiles defined in configuration.

**Data flow**: It receives an optional working directory plus paging fields. If a folder is given, it resolves the folder and loads its config layers; otherwise it loads general config layers. It reads the effective config, starts with the built-in profiles, adds sorted custom profiles, slices the requested page, and returns it with a next cursor when needed.

**Call relations**: The public `CatalogRequestProcessor::permission_profile_list` method calls this. It uses `CatalogRequestProcessor::resolve_cwd_config` for folder-specific requests and the config manager for non-folder-specific requests.

*Call graph*: calls 2 internal fn (load_config_layers, resolve_cwd_config); called by 1 (permission_profile_list); 3 external calls (from, format!, vec!).


##### `CatalogRequestProcessor::mock_experimental_method_inner`  (lines 489–496)

```
async fn mock_experimental_method_inner(
        &self,
        params: MockExperimentalMethodParams,
    ) -> Result<MockExperimentalMethodResponse, JSONRPCErrorError>
```

**Purpose**: Returns the provided value unchanged in an echo response. This gives developers or clients a minimal experimental endpoint for checking request and response plumbing.

**Data flow**: It receives parameters containing a value. It places that value into a response object as `echoed` and returns it. It does not read configuration or change server state.

**Call relations**: The public `CatalogRequestProcessor::mock_experimental_method` method calls this. It is the whole business logic for that mock endpoint.

*Call graph*: called by 1 (mock_experimental_method).


##### `CatalogRequestProcessor::skills_list_response`  (lines 498–583)

```
async fn skills_list_response(
        &self,
        params: SkillsListParams,
    ) -> Result<SkillsListResponse, JSONRPCErrorError>
```

**Purpose**: Creates the actual response for listing skills for one or more working directories. A skill is a reusable capability described by metadata, often loaded from files or plugins.

**Data flow**: It receives requested folders and a force-reload flag. If no folders are provided, it uses the server’s current working directory. It reloads config, checks auth and workspace plugin policy, then processes the folders with limited concurrency so several folders can be checked at once without flooding the system. For each folder, it resolves config, computes plugin skill roots when allowed, loads skills, converts skills and errors into protocol records, preserves the original folder order, and returns all entries.

**Call relations**: The public `CatalogRequestProcessor::skills_list` method calls this. It uses `CatalogRequestProcessor::load_latest_config`, `CatalogRequestProcessor::workspace_codex_plugins_enabled`, the thread manager’s skill and plugin managers, and the conversion helpers for skill and error records.

*Call graph*: calls 2 internal fn (load_latest_config, workspace_codex_plugins_enabled); called by 1 (skills_list); 2 external calls (iter, vec!).


##### `CatalogRequestProcessor::skills_extra_roots_set_response`  (lines 585–601)

```
async fn skills_extra_roots_set_response(
        &self,
        params: SkillsExtraRootsSetParams,
    ) -> Result<SkillsExtraRootsSetResponse, JSONRPCErrorError>
```

**Purpose**: Applies a runtime list of extra folders where skills should be discovered. After changing the list, it notifies clients that the skill catalog has changed.

**Data flow**: It receives extra root paths. It registers them with the skill watcher, gives them to the skill manager, sends a `SkillsChanged` server notification through the outgoing message sender, and returns an empty success response.

**Call relations**: The public `CatalogRequestProcessor::skills_extra_roots_set` method calls this. This helper updates both the watching side and the loading side, then broadcasts the change so clients know to refresh.

*Call graph*: called by 1 (skills_extra_roots_set); 1 external calls (SkillsChanged).


##### `CatalogRequestProcessor::hooks_list_response`  (lines 604–674)

```
async fn hooks_list_response(
        &self,
        params: HooksListParams,
    ) -> Result<HooksListResponse, JSONRPCErrorError>
```

**Purpose**: Creates the actual response for listing hooks for one or more working directories. Hooks can come from configuration and, when allowed, from plugins.

**Data flow**: It receives requested folders, defaulting to the server’s current folder if none are supplied. For each folder, it loads config; if config loading fails, it records an error entry for that folder and moves on. Otherwise it checks whether workspace plugins and the plugin feature are enabled, gathers plugin hook sources and warnings when allowed, asks the hook system to list hooks using the effective settings, converts the hooks into protocol metadata, and returns one entry per folder.

**Call relations**: The public `CatalogRequestProcessor::hooks_list` method calls this. It uses config loading, `CatalogRequestProcessor::workspace_codex_plugins_enabled`, plugin lookup, the external hook lister, and `hooks_to_info` to assemble the client response.

*Call graph*: calls 3 internal fn (load_for_cwd, workspace_codex_plugins_enabled, hooks_to_info); called by 1 (hooks_list); 6 external calls (default, new, list_hooks, default, default, vec!).


##### `CatalogRequestProcessor::skills_config_write_response_inner`  (lines 676–712)

```
async fn skills_config_write_response_inner(
        &self,
        params: SkillsConfigWriteParams,
    ) -> Result<SkillsConfigWriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes a configuration change that enables or disables a skill, identified either by file path or by name. It clears related caches afterward so future catalog requests see the new setting.

**Data flow**: It receives a path, a name, and the desired enabled state. It requires exactly one usable identifier: either a path or a non-empty name. It builds a config edit, applies it under the Codex home directory, clears plugin and skill caches on success, and returns the effective enabled value. Invalid input becomes an invalid-parameters error; write failures become internal errors.

**Call relations**: The public `CatalogRequestProcessor::skills_config_write` method calls this. It uses the config edit builder to change saved settings, then tells the managers to forget cached data so later skill and plugin lookups reload fresh information.

*Call graph*: calls 1 internal fn (new); called by 1 (skills_config_write); 1 external calls (vec!).


### `app-server/src/request_processors/environment_processor.rs`

`orchestration` · `request handling`

When a client tells the server about an environment, the server needs to remember two key facts: the environment’s ID and the URL of the execution server that belongs to it. This file provides that request-facing wrapper. Think of it like a front desk clerk: it does not run the environment itself, but it receives the form from the client, checks it into the right office, and returns a simple confirmation.

The main type, EnvironmentRequestProcessor, holds a shared reference to an EnvironmentManager. The shared reference is stored in an Arc, which means several parts of the server can safely point to the same manager without copying it. When an “add environment” request arrives, the processor pulls the environment ID and execution server URL out of the request parameters and asks the EnvironmentManager to insert or update that record. “Upsert” means “update if it already exists, insert if it does not.”

If the manager reports a problem, this file turns that problem into a JSON-RPC invalid request error, which is the error format expected by clients using JSON-RPC, a common request-and-response protocol. If everything works, it returns an empty success response. Without this file, initialized client requests would not have a clean, consistent path for registering environments with the server.

#### Function details

##### `EnvironmentRequestProcessor::new`  (lines 9–13)

```
fn new(environment_manager: Arc<EnvironmentManager>) -> Self
```

**Purpose**: Creates an EnvironmentRequestProcessor and gives it access to the shared EnvironmentManager. This is used when the server is wiring together its request-processing pieces.

**Data flow**: It receives a shared EnvironmentManager reference as input. It stores that reference inside a new EnvironmentRequestProcessor. The result is a processor object that can later answer environment-related client requests.

**Call relations**: During setup, the broader request-processing construction code calls this function to make the environment processor. After that, other request-handling code can keep this processor and use it whenever an environment request arrives.

*Call graph*: called by 1 (new).


##### `EnvironmentRequestProcessor::environment_add`  (lines 15–23)

```
async fn environment_add(
        &self,
        params: EnvironmentAddParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Registers a client-provided environment, or updates it if it is already known. It returns a simple success response when the environment manager accepts the change.

**Data flow**: It receives request parameters containing an environment ID and an execution server URL. It passes those values to the EnvironmentManager, which records them. If that recording fails, the error is converted into a client-facing JSON-RPC invalid request error; if it succeeds, the function returns an environment-add success response.

**Call relations**: After the client has been initialized, the main request handler calls this function when it sees an environment-add request. This function then hands the real registry update to the EnvironmentManager and translates the outcome back into the response shape the client expects.

*Call graph*: called by 1 (handle_initialized_client_request).


### `app-server/src/request_processors/external_agent_config_processor.rs`

`orchestration` · `request handling`

This processor exists so a user can bring settings, plugins, sessions, hooks, commands, and similar items from another agent environment into Codex without doing the copying by hand. Think of it like a moving coordinator: first it surveys what can be moved, then it starts the move, reports each box as it arrives, and finally writes down what succeeded and what failed.

The main type, `ExternalAgentConfigRequestProcessor`, sits between the app-server protocol and the lower-level migration service. The protocol is the set of messages the client and server agree to send each other. The migration service does the actual discovery and copying. This file mostly translates between those two worlds: protocol-shaped request and response data on one side, core migration data on the other.

Imports can finish in two phases. Some work happens immediately, such as copying config files. Other work, especially plugin and session imports, may continue in the background. The client still gets an import ID right away, then receives progress notifications and a final completion notification later. If imported items affect the running app, the processor refreshes runtime configuration so Codex notices the new settings. If a state database is available, the final result is saved so the client can later read import history.

#### Function details

##### `ExternalAgentConfigRequestProcessor::new`  (lines 74–100)

```
fn new(args: ExternalAgentConfigRequestProcessorArgs) -> Self
```

**Purpose**: Builds a ready-to-use processor with all the pieces it needs: outgoing messages, migration services, session importing, thread access, configuration refreshing, and optional history storage.

**Data flow**: It receives a bundle of shared server services and paths. It creates an `ExternalAgentSessionImporter` for session migration and an `ExternalAgentConfigService` for detecting and importing configuration. It returns a processor that keeps references to those services for later requests.

**Call relations**: This is called when the app-server wires up its request processors. After this setup step, client request handling can call methods like `detect`, `import`, and `read_import_histories` on the created processor.

*Call graph*: calls 2 internal fn (new, new); called by 1 (new); 1 external calls (clone).


##### `ExternalAgentConfigRequestProcessor::detect`  (lines 102–194)

```
async fn detect(
        &self,
        params: ExternalAgentConfigDetectParams,
    ) -> Result<ExternalAgentConfigDetectResponse, JSONRPCErrorError>
```

**Purpose**: Looks for external-agent items that could be imported into Codex and returns a client-friendly list of them.

**Data flow**: It receives detection options from the client, such as whether to include the home directory and which working directories to inspect. It asks the migration service to scan those places. It converts the found core migration items into protocol response items and returns them, or turns scan failures into a JSON-RPC error.

**Call relations**: The initialized client request handler calls this when the client asks what can be imported. This function delegates the actual searching to the migration service, then translates the result into the app-server protocol.

*Call graph*: calls 1 internal fn (detect); called by 1 (handle_initialized_client_request).


##### `ExternalAgentConfigRequestProcessor::import`  (lines 196–334)

```
async fn import(
        &self,
        request_id: ConnectionRequestId,
        params: ExternalAgentConfigImportParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts an import chosen by the client, sends the client an import ID, reports progress, and eventually sends a final completion notification.

**Data flow**: It receives the request ID and the list of selected migration items. It creates a unique import ID, checks whether the running app will need refreshed settings, validates selected sessions, imports the non-session configuration, and sends an immediate response containing the import ID. It then sends progress messages for completed work. If plugin or session work remains, it launches background tasks and sends the final result after they finish; otherwise it sends the final notification right away.

**Call relations**: The initialized client request handler calls this for an import request. Inside the flow it uses validation, core config import, plugin completion, session import, progress notification helpers, final notification helpers, and runtime cache refreshes so the client can see both immediate and background progress.

*Call graph*: calls 8 internal fn (record_import_error, handle_config_mutation, import_external_agent_config, validate_pending_session_imports, apply_plugin_outcome_to_item_result, migration_items_need_runtime_refresh, send_completed_import_notification, send_import_progress); called by 1 (handle_initialized_client_request); 7 external calls (clone, new, new_v4, new, clone, join!, spawn).


##### `ExternalAgentConfigRequestProcessor::read_import_histories`  (lines 336–353)

```
async fn read_import_histories(
        &self,
    ) -> Result<ExternalAgentConfigImportHistoriesReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads previously completed external-agent import records so the client can show import history.

**Data flow**: It checks that a state database is available. It reads saved import history records from that database. It converts each stored record into protocol format and returns the list; if the database is missing or the read fails, it returns a client-visible internal error.

**Call relations**: The initialized client request handler calls this when the client asks for import histories. It relies on the history records that `send_completed_import_notification` may have stored after past imports.

*Call graph*: called by 1 (handle_initialized_client_request).


##### `ExternalAgentConfigRequestProcessor::validate_pending_session_imports`  (lines 355–419)

```
fn validate_pending_session_imports(
        &self,
        params: &ExternalAgentConfigImportParams,
    ) -> (Vec<CoreSessionMigration>, Option<CoreImportItemResult>)
```

**Purpose**: Checks selected session imports before doing the slower background session import work. It filters out missing or duplicate session sources and records validation errors for the client.

**Data flow**: It reads the selected migration items and extracts any session entries. For each session, it asks the migration service for the real source path. Missing or invalid sessions become recorded errors; duplicate canonical paths are skipped so the same session is not imported twice. It returns the remaining sessions to import plus a validation result describing any problems.

**Call relations**: The main `import` flow calls this before starting imports. Its validation result is sent as an early progress update, while the valid session list is handed to the background session importer.

*Call graph*: calls 2 internal fn (external_agent_session_source_path, record_import_error); called by 1 (import); 4 external calls (new, new, new, format!).


##### `ExternalAgentConfigRequestProcessor::import_external_agent_config`  (lines 421–520)

```
async fn import_external_agent_config(
        &self,
        params: ExternalAgentConfigImportParams,
    ) -> Result<CoreImportOutcome, JSONRPCErrorError>
```

**Purpose**: Runs the main configuration import for all selected items except sessions, which are handled separately.

**Data flow**: It receives the client’s import parameters. It removes session items, converts the remaining protocol-shaped items into the core migration service’s types, and asks that service to import them. It returns the core import outcome, including immediate item results and any plugin imports that still need background completion.

**Call relations**: The main `import` method calls this after session validation. This function hands the actual copying work to the migration service and gives `import` the results it needs for progress reporting and background plugin work.

*Call graph*: calls 1 internal fn (import); called by 1 (import).


##### `ExternalAgentConfigRequestProcessor::complete_pending_plugin_import`  (lines 522–533)

```
async fn complete_pending_plugin_import(
        &self,
        pending_plugin_import: PendingPluginImport,
    ) -> Result<PluginImportOutcome, JSONRPCErrorError>
```

**Purpose**: Finishes a plugin import that could not be completed in the initial import pass.

**Data flow**: It receives a pending plugin import with its working directory and details. It asks the migration service to import those plugins. It returns the plugin outcome, or converts any failure into a JSON-RPC internal error.

**Call relations**: The background part of `import` calls this for each pending plugin import. Its result is then folded into an item result by `apply_plugin_outcome_to_item_result` before progress is sent.

*Call graph*: calls 1 internal fn (import_plugins).


##### `send_import_progress`  (lines 536–549)

```
async fn send_import_progress(
    outgoing: &OutgoingMessageSender,
    import_id: &str,
    item_result: &CoreImportItemResult,
)
```

**Purpose**: Sends a progress notification for one imported item type to the client.

**Data flow**: It receives the outgoing message sender, the import ID, and one core item result. It converts that item result into protocol format and sends a server notification containing successes and failures for that item type. It does not return data to the caller beyond completing the send.

**Call relations**: The `import` method calls this after validation, after immediate imports, and after background session or plugin imports. It is the small helper that keeps the client informed during a longer import.

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

**Purpose**: Builds and sends the final import-completed notification, and saves it to history if a state database is available.

**Data flow**: It receives the outgoing sender, optional database handle, import ID, and all item results. It creates a completed notification from those results. If there is a database, it tries to record the notification; failures are logged but do not stop the client notification. It then sends the final completion notification to the client.

**Call relations**: The main `import` flow calls this either immediately, when no background work is needed, or after background session and plugin imports finish. It uses `completed_notification` to shape the client message and `record_completed_import_notification` to save history.

*Call graph*: calls 3 internal fn (send_server_notification, completed_notification, record_completed_import_notification); called by 1 (import); 2 external calls (ExternalAgentConfigImportCompleted, warn!).


##### `record_completed_import_notification`  (lines 574–613)

```
async fn record_completed_import_notification(
    state_db: &StateDbHandle,
    notification: &ExternalAgentConfigImportCompletedNotification,
) -> anyhow::Result<()>
```

**Purpose**: Stores a completed import’s successes and failures in the state database for later history views.

**Data flow**: It receives the database handle and the completed notification. It extracts each success and failure, converts their item types into the database’s stored form, and calls the database method that records the completed import. It returns success or an error if conversion or database writing fails.

**Call relations**: `send_completed_import_notification` calls this before notifying the client. This helper is only about persistence: it turns the outgoing notification into saved history records.

*Call graph*: called by 1 (send_completed_import_notification); 1 external calls (record_external_agent_config_import_completed).


##### `protocol_import_history`  (lines 615–635)

```
fn protocol_import_history(
    record: codex_state::ExternalAgentConfigImportHistoryRecord,
) -> Result<ExternalAgentConfigImportHistory, JSONRPCErrorError>
```

**Purpose**: Converts one stored import history record into the protocol format the client expects.

**Data flow**: It receives a database history record containing an import ID, completion time, successes, and failures. It converts each success and failure record into protocol records. It returns a complete protocol history entry or an error if an item type cannot be decoded.

**Call relations**: `read_import_histories` uses this while preparing the history response. It sits between database storage format and client message format.


##### `protocol_import_success_record`  (lines 637–646)

```
fn protocol_import_success_record(
    record: ExternalAgentConfigImportSuccessRecord,
) -> Result<ProtocolImportSuccess, JSONRPCErrorError>
```

**Purpose**: Converts one stored success record into a client-facing success record.

**Data flow**: It receives a stored success with an item type, working directory, source, and target. It decodes the stored item type into the protocol enum and copies over the remaining fields. It returns the protocol success record or an error if the item type is invalid.

**Call relations**: `protocol_import_history` calls this for each saved success. It relies on `protocol_import_record_item_type` for the item type conversion.

*Call graph*: calls 1 internal fn (protocol_import_record_item_type).


##### `protocol_import_failure_record`  (lines 648–659)

```
fn protocol_import_failure_record(
    record: ExternalAgentConfigImportFailureRecord,
) -> Result<ProtocolImportFailure, JSONRPCErrorError>
```

**Purpose**: Converts one stored failure record into a client-facing failure record.

**Data flow**: It receives a stored failure with its item type, error kind, failure stage, message, working directory, and source. It decodes the item type and copies the rest of the information into protocol format. It returns the protocol failure record or an error if the item type cannot be decoded.

**Call relations**: `protocol_import_history` calls this for each saved failure. It uses `protocol_import_record_item_type` so stored history can be safely turned back into protocol values.

*Call graph*: calls 1 internal fn (protocol_import_record_item_type).


##### `protocol_import_record_item_type`  (lines 661–669)

```
fn protocol_import_record_item_type(
    item_type: String,
) -> Result<ExternalAgentConfigMigrationItemType, JSONRPCErrorError>
```

**Purpose**: Decodes an item type string from saved history into the protocol’s item type value.

**Data flow**: It receives a string such as a stored item type name. It asks the JSON serializer/deserializer to interpret that string as an `ExternalAgentConfigMigrationItemType`. It returns the decoded item type or a clear internal error if the string is not recognized.

**Call relations**: The success and failure history converters call this whenever they need to turn database text back into protocol data. This keeps history reading from silently accepting unknown item types.

*Call graph*: called by 2 (protocol_import_failure_record, protocol_import_success_record); 2 external calls (String, from_value).


##### `completed_notification`  (lines 671–718)

```
fn completed_notification(
    import_id: String,
    item_results: &[CoreImportItemResult],
) -> ExternalAgentConfigImportCompletedNotification
```

**Purpose**: Creates the final client notification that summarizes all import successes and failures, grouped by item type.

**Data flow**: It receives the import ID and all core item results. For each result, it converts successes and raw errors into protocol records, merges results that share the same item type, and sorts item types into a stable order. It returns the completed notification ready to send.

**Call relations**: `send_completed_import_notification` calls this before saving or sending the final result. It uses the lower-level protocol conversion helpers so the notification has the same shape the client expects.

*Call graph*: calls 1 internal fn (protocol_migration_item_type); called by 1 (send_completed_import_notification); 1 external calls (new).


##### `protocol_import_type_result`  (lines 720–734)

```
fn protocol_import_type_result(item_result: &CoreImportItemResult) -> ProtocolImportTypeResult
```

**Purpose**: Converts one core item result into one protocol item-type result for progress updates.

**Data flow**: It receives a core result for one migration item type. It converts the item type, all successes, and all raw errors into protocol fields. It returns a protocol result that can be placed inside a progress notification.

**Call relations**: `send_import_progress` calls this while preparing progress messages. It shares conversion helpers with the final notification path so progress and completion messages stay consistent.

*Call graph*: calls 1 internal fn (protocol_migration_item_type).


##### `protocol_import_success`  (lines 736–745)

```
fn protocol_import_success(
    success: &crate::config::external_agent_config::ExternalAgentConfigImportSuccess,
) -> ProtocolImportSuccess
```

**Purpose**: Converts one core import success into the protocol success format sent to the client.

**Data flow**: It receives a core success record with item type, working directory, source, and target. It converts the item type and clones the descriptive fields. It returns the protocol success record.

**Call relations**: `completed_notification` and `protocol_import_type_result` use this when building final and progress messages. It relies on `protocol_migration_item_type` for the item type mapping.

*Call graph*: calls 1 internal fn (protocol_migration_item_type).


##### `protocol_import_raw_error`  (lines 747–756)

```
fn protocol_import_raw_error(raw_error: &CoreImportRawError) -> ProtocolImportFailure
```

**Purpose**: Converts one core import error into the protocol failure format sent to the client.

**Data flow**: It receives a raw core error with item type, error type, failure stage, message, working directory, and source. It converts the item type and copies the error details into protocol format. It returns the protocol failure record.

**Call relations**: `completed_notification` and `protocol_import_type_result` use this to include failures in progress and final notifications. It keeps error reporting shaped for the client rather than for internal code.

*Call graph*: calls 1 internal fn (protocol_migration_item_type).


##### `protocol_migration_item_type`  (lines 758–774)

```
fn protocol_migration_item_type(
    item_type: CoreMigrationItemType,
) -> ExternalAgentConfigMigrationItemType
```

**Purpose**: Maps a core migration item type to the matching protocol item type.

**Data flow**: It receives an internal enum value for an import category, such as config, plugins, hooks, commands, or sessions. It matches that value to the equivalent protocol enum. It returns the protocol item type.

**Call relations**: Several conversion helpers call this whenever internal migration results need to be sent over the app-server protocol. It is the central mapping that prevents each caller from duplicating the same match logic.

*Call graph*: called by 4 (completed_notification, protocol_import_raw_error, protocol_import_success, protocol_import_type_result).


##### `apply_plugin_outcome_to_item_result`  (lines 776–786)

```
fn apply_plugin_outcome_to_item_result(
    item_result: &mut CoreImportItemResult,
    plugin_outcome: PluginImportOutcome,
)
```

**Purpose**: Adds the results of a completed plugin import into the general import item result used for progress and completion reporting.

**Data flow**: It receives a mutable plugin item result and a plugin outcome. Each successful plugin ID is recorded as a success. Each raw plugin error is recorded as an error. The item result is changed in place and becomes ready for notification.

**Call relations**: The background plugin part of `import` calls this after `complete_pending_plugin_import` succeeds. It turns plugin-specific output into the common result format used by `send_import_progress` and the final completion notification.

*Call graph*: called by 1 (import); 2 external calls (record_error, record_success).


##### `migration_items_need_runtime_refresh`  (lines 788–800)

```
fn migration_items_need_runtime_refresh(items: &[ExternalAgentConfigMigrationItem]) -> bool
```

**Purpose**: Decides whether the selected import items can affect the running Codex environment and therefore require a configuration refresh.

**Data flow**: It receives the selected migration items. It checks whether any item is a runtime-sensitive type, such as config, skills, MCP server config, hooks, commands, or plugins. It returns true if the app should refresh its active configuration after import, otherwise false.

**Call relations**: The main `import` method calls this near the start. If it returns true, `import` later asks the config processor to refresh after the core import work so the running server notices the imported changes.

*Call graph*: called by 1 (import); 1 external calls (iter).


### `app-server/src/request_processors/mcp_processor.rs`

`orchestration` · `request handling`

This file is the bridge between the app’s JSON-RPC request layer and the MCP system. JSON-RPC is a simple request-and-response message format. A client may ask to log in to an MCP server, refresh the list of servers, list server status, read a resource, or call a tool. This processor checks the needed configuration, finds the right conversation thread when a request belongs to one, starts the MCP operation, and sends the answer back through the outgoing message sender.

A useful way to picture it is as a reception desk. The receptionist does not personally run every tool or fetch every resource. Instead, it checks the visitor’s request, looks up the right department, starts the job, and makes sure the result gets sent back to the visitor.

Some operations return immediately with a direct response, such as starting OAuth login and returning the authorization URL. Others can take longer, so the file starts a background task and returns control quickly; the background task later sends the final result. The file also takes care to reload the latest config before operating, because MCP server settings may change while the app is running. For tool calls, it adds the thread ID into the metadata so downstream MCP tools can know which conversation triggered the call.

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

**Purpose**: Creates a new MCP request processor with the shared services it needs. These services include authentication, thread lookup, outgoing replies, and configuration loading.

**Data flow**: It receives references to the authentication manager, thread manager, outgoing message sender, and config manager. It stores them inside a new processor object. The result is a ready-to-use processor that can respond to MCP-related client requests.

**Call relations**: A higher-level constructor calls this when the request-processing system is being built. After that, the created processor is used whenever initialized client requests need MCP work.

*Call graph*: called by 1 (new).


##### `McpRequestProcessor::mcp_server_oauth_login`  (lines 28–35)

```
async fn mcp_server_oauth_login(
        &self,
        params: McpServerOauthLoginParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Starts an OAuth login flow for an MCP server and returns the URL the user must visit. OAuth is a common login method where the user authorizes access in a browser.

**Data flow**: It receives login parameters such as the server name, requested permission scopes, and timeout. It asks the more detailed login function to do the work, then wraps the response into the standard client response format. The output is either a response containing an authorization URL or a JSON-RPC error.

**Call relations**: The initialized client request handler calls this when the client asks to log in to an MCP server. This function delegates the real work to McpRequestProcessor::mcp_server_oauth_login_response.

*Call graph*: calls 1 internal fn (mcp_server_oauth_login_response); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_refresh`  (lines 37–44)

```
async fn mcp_server_refresh(
        &self,
        params: Option<()>,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Refreshes the app’s view of configured MCP servers. This is useful when server configuration or availability may have changed.

**Data flow**: It receives an empty optional parameter, because this request does not need extra details. It asks the refresh response function to queue the refresh work, then wraps the successful response into the standard client response format. It returns either that response or a JSON-RPC error.

**Call relations**: The initialized client request handler calls this for MCP refresh requests. It hands the request to McpRequestProcessor::mcp_server_refresh_response, which queues the actual refresh.

*Call graph*: calls 1 internal fn (mcp_server_refresh_response); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_status_list`  (lines 46–54)

```
async fn mcp_server_status_list(
        &self,
        request_id: &ConnectionRequestId,
        params: ListMcpServerStatusParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Begins a request to list the status of MCP servers. The final status is sent later through the outgoing message channel instead of being returned directly here.

**Data flow**: It receives the connection request ID and status-list parameters such as detail level, cursor, limit, and optional thread ID. It starts the internal status-list flow, and if that setup succeeds it returns no immediate payload. Any later result is sent using the saved request ID.

**Call relations**: The initialized client request handler calls this when the client asks for MCP server status. It delegates setup and background execution to McpRequestProcessor::list_mcp_server_status.

*Call graph*: calls 1 internal fn (list_mcp_server_status); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_resource_read`  (lines 56–64)

```
async fn mcp_resource_read(
        &self,
        request_id: &ConnectionRequestId,
        params: McpResourceReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Begins a request to read a resource exposed by an MCP server. A resource is data the server makes available, identified here by a URI, which is a standard text address.

**Data flow**: It receives the connection request ID and resource-read parameters: optional thread ID, server name, and resource URI. It starts the read flow and returns no immediate payload if the read was successfully scheduled. The actual resource content or error is sent later using the request ID.

**Call relations**: The initialized client request handler calls this for resource-read requests. It delegates the setup and background read work to McpRequestProcessor::read_mcp_resource.

*Call graph*: calls 1 internal fn (read_mcp_resource); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_tool_call`  (lines 66–74)

```
async fn mcp_server_tool_call(
        &self,
        request_id: &ConnectionRequestId,
        params: McpServerToolCallParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Begins a request to call a tool on an MCP server within a specific conversation thread. A tool is an action the external MCP server can perform for the app.

**Data flow**: It receives the connection request ID and tool-call parameters, including the thread ID, server name, tool name, arguments, and optional metadata. It schedules the tool call and returns no immediate payload if scheduling succeeds. The tool result or error is sent later.

**Call relations**: The initialized client request handler calls this when a client asks to run an MCP tool. It passes the work to McpRequestProcessor::call_mcp_server_tool.

*Call graph*: calls 1 internal fn (call_mcp_server_tool); called by 1 (handle_initialized_client_request).


##### `McpRequestProcessor::mcp_server_refresh_response`  (lines 76–84)

```
async fn mcp_server_refresh_response(
        &self,
        _params: Option<()>,
    ) -> Result<McpServerRefreshResponse, JSONRPCErrorError>
```

**Purpose**: Queues a strict refresh of MCP servers and returns a small success response. A strict refresh means failures are treated as real errors instead of being quietly ignored.

**Data flow**: It receives no meaningful input besides access to the processor’s thread and config managers. It asks the MCP refresh system to refresh using the current thread and configuration state. If queuing succeeds, it returns an empty refresh response; if it fails, it returns an internal JSON-RPC error.

**Call relations**: McpRequestProcessor::mcp_server_refresh calls this after receiving the public request. This function hands the actual refresh scheduling to queue_strict_refresh.

*Call graph*: calls 1 internal fn (queue_strict_refresh); called by 1 (mcp_server_refresh).


##### `McpRequestProcessor::load_latest_config`  (lines 86–94)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Loads the newest configuration and converts any loading failure into a client-facing JSON-RPC error. This keeps callers from accidentally using stale MCP settings.

**Data flow**: It receives an optional fallback working directory. It asks the config manager to load the latest config using that fallback if needed. It returns the loaded config, or an internal error that explains the reload failure.

**Call relations**: OAuth login, server-status listing, and threadless resource reading call this before they inspect MCP settings. It is a small shared helper around the config manager’s load_latest_config operation.

*Call graph*: calls 1 internal fn (load_latest_config); called by 3 (list_mcp_server_status, mcp_server_oauth_login_response, read_mcp_resource).


##### `McpRequestProcessor::load_thread`  (lines 96–110)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Finds an existing conversation thread from a thread ID string. It also validates that the thread ID has the correct format before looking it up.

**Data flow**: It receives a thread ID as text. First it parses that text into the project’s ThreadId type; if parsing fails, it returns an invalid-request error. Then it asks the thread manager for the matching thread; if none is found, it returns an invalid-request error. On success, it returns both the parsed ID and the thread object.

**Call relations**: Tool calls, status listing for a specific thread, and resource reads inside a thread all call this. It uses ThreadId::from_string for validation before asking the thread manager for the thread.

*Call graph*: calls 1 internal fn (from_string); called by 3 (call_mcp_server_tool, list_mcp_server_status, read_mcp_resource).


##### `McpRequestProcessor::mcp_server_oauth_login_response`  (lines 112–197)

```
async fn mcp_server_oauth_login_response(
        &self,
        params: McpServerOauthLoginParams,
    ) -> Result<McpServerOauthLoginResponse, JSONRPCErrorError>
```

**Purpose**: Does the detailed work needed to start OAuth login for one configured MCP server. It checks the server exists, verifies that its transport supports OAuth, resolves permission scopes, starts the login, and arranges for a completion notification.

**Data flow**: It receives the server name, optional requested scopes, and optional timeout. It reloads config, reads current authentication, and asks the MCP manager for the effective server list. It finds the named server, checks that it uses streamable HTTP transport, discovers or resolves OAuth scopes, and starts the login flow. It returns an authorization URL immediately. Separately, a background task waits for the login to finish and sends a success or failure notification.

**Call relations**: McpRequestProcessor::mcp_server_oauth_login calls this for the public request. Inside, it uses McpRequestProcessor::load_latest_config, consults the MCP manager and auth manager, starts OAuth through the OAuth helper, then spawns a background notification task using the outgoing sender.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (mcp_server_oauth_login); 4 external calls (clone, McpServerOauthLoginCompleted, format!, spawn).


##### `McpRequestProcessor::list_mcp_server_status`  (lines 199–249)

```
async fn list_mcp_server_status(
        &self,
        request_id: &ConnectionRequestId,
        params: ListMcpServerStatusParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Prepares a server-status request and starts the background task that will collect and send the status. It supports both global MCP status and status as seen from a particular conversation thread.

**Data flow**: It receives the request ID and listing parameters. If the parameters include a thread ID, it loads that thread and reloads config using the thread’s config. Otherwise it loads the latest global config. It builds the runtime MCP configuration, collects current authentication and environment context, then starts a background task. The immediate result is success or a setup error; the actual list is sent later.

**Call relations**: McpRequestProcessor::mcp_server_status_list calls this when a client asks for status. This function may call McpRequestProcessor::load_thread, McpRequestProcessor::load_latest_config, or the config manager’s thread-specific config loader, then hands the long-running work to McpRequestProcessor::list_mcp_server_status_task in a spawned task.

*Call graph*: calls 4 internal fn (load_latest_config_for_thread, load_latest_config, load_thread, new); called by 1 (mcp_server_status_list); 4 external calls (clone, list_mcp_server_status_task, clone, spawn).


##### `McpRequestProcessor::list_mcp_server_status_task`  (lines 251–268)

```
async fn list_mcp_server_status_task(
        outgoing: Arc<OutgoingMessageSender>,
        request_id: ConnectionRequestId,
        params: ListMcpServerStatusParams,
        mcp_config: codex_mcp::M
```

**Purpose**: Runs the background half of a status-list request and sends the final answer back to the client. It exists so the initial request handler does not have to wait while MCP servers are inspected.

**Data flow**: It receives the outgoing sender, request ID, original parameters, prepared MCP config, authentication, and runtime context. It asks the response-building function to collect and shape the status data. Then it sends either the completed response or an error through the outgoing message sender.

**Call relations**: McpRequestProcessor::list_mcp_server_status starts this in the background. This task calls McpRequestProcessor::list_mcp_server_status_response to build the response, then uses the outgoing sender to deliver it for the original request ID.

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

**Purpose**: Builds the actual paged list of MCP server statuses. It combines server information, available tools, resources, resource templates, and authentication state into one response.

**Data flow**: It receives the original request ID as text, list parameters, MCP configuration, optional authentication, and runtime context. It chooses how much detail to collect, asks the MCP status collector for a snapshot, merges all server names that appear in any part of that snapshot, sorts them, and applies pagination using limit and cursor. It returns a response containing the selected page of server statuses and, if there is more data, a next cursor.

**Call relations**: McpRequestProcessor::list_mcp_server_status_task calls this while preparing the final reply. It relies on the MCP status snapshot collector, then shapes the raw snapshot into the client-facing ListMcpServerStatusResponse.

*Call graph*: 1 external calls (format!).


##### `McpRequestProcessor::read_mcp_resource`  (lines 353–404)

```
async fn read_mcp_resource(
        &self,
        request_id: &ConnectionRequestId,
        params: McpResourceReadParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts the process of reading a resource from an MCP server, either through a specific conversation thread or without a thread. The thread path uses that thread’s existing MCP runtime; the threadless path builds one from current config.

**Data flow**: It receives the request ID and parameters containing an optional thread ID, server name, and URI. If there is a thread ID, it loads the thread and starts a background task that asks the thread to read the resource. If there is no thread ID, it loads current config, builds MCP runtime config and context, and starts a background task that reads without a thread. In both cases, the eventual result is sent through the outgoing sender.

**Call relations**: McpRequestProcessor::mcp_resource_read calls this for client resource-read requests. It may use McpRequestProcessor::load_thread or McpRequestProcessor::load_latest_config, then spawns work and hands final response formatting to McpRequestProcessor::send_mcp_resource_read_response.

*Call graph*: calls 3 internal fn (load_latest_config, load_thread, new); called by 1 (mcp_resource_read); 4 external calls (clone, send_mcp_resource_read_response, clone, spawn).


##### `McpRequestProcessor::send_mcp_resource_read_response`  (lines 406–421)

```
async fn send_mcp_resource_read_response(
        outgoing: Arc<OutgoingMessageSender>,
        request_id: ConnectionRequestId,
        result: anyhow::Result<serde_json::Value>,
    )
```

**Purpose**: Converts the raw result of reading an MCP resource into the exact response type expected by the client, then sends it. This keeps both thread-based and threadless read paths using the same reply format.

**Data flow**: It receives the outgoing sender, the original request ID, and either a JSON value or an error. If there is an error, it turns it into an internal JSON-RPC error. If there is a JSON value, it tries to decode it as an McpResourceReadResponse; decoding failure also becomes an internal error. It then sends the final success or error result to the client.

**Call relations**: The background tasks started by McpRequestProcessor::read_mcp_resource call this after the resource read finishes. It is the final delivery step before the outgoing sender replies to the original request.


##### `McpRequestProcessor::call_mcp_server_tool`  (lines 423–443)

```
async fn call_mcp_server_tool(
        &self,
        request_id: &ConnectionRequestId,
        params: McpServerToolCallParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts a tool call against an MCP server inside a conversation thread. It makes sure the thread exists and adds the thread ID to the tool metadata before the call is made.

**Data flow**: It receives the request ID and tool-call parameters. It loads the thread named by the parameters, updates the metadata so it includes the thread ID when possible, and starts a background task. That task asks the thread to call the named server tool with the provided arguments, turns the result into a client response, and sends it back through the outgoing sender.

**Call relations**: McpRequestProcessor::mcp_server_tool_call calls this for client tool-call requests. It uses McpRequestProcessor::load_thread to find the conversation and with_mcp_tool_call_thread_id_meta to enrich metadata before handing the call to the thread.

*Call graph*: calls 2 internal fn (load_thread, with_mcp_tool_call_thread_id_meta); called by 1 (mcp_server_tool_call); 3 external calls (clone, clone, spawn).


##### `with_mcp_tool_call_thread_id_meta`  (lines 446–468)

```
fn with_mcp_tool_call_thread_id_meta(
    meta: Option<serde_json::Value>,
    thread_id: &str,
) -> Option<serde_json::Value>
```

**Purpose**: Adds the conversation thread ID to MCP tool-call metadata when the metadata is a JSON object or missing. This lets downstream tools know which thread caused the call.

**Data flow**: It receives optional JSON metadata and a thread ID string. If the metadata is an object, it inserts a threadId field into that object. If there is no metadata, it creates a new object containing threadId. If the metadata is some other JSON type, such as a string or array, it leaves it unchanged. The output is the updated optional metadata.

**Call relations**: McpRequestProcessor::call_mcp_server_tool calls this just before starting a tool call. The resulting metadata is passed along to the thread’s MCP tool-call operation.

*Call graph*: called by 1 (call_mcp_server_tool); 3 external calls (new, Object, String).


### `app-server/src/request_processors/turn_processor.rs`

`orchestration` · `request handling`

A “turn” is one round of work in a Codex thread: the user gives input, Codex acts, and events come back. This file sits between outside clients and the core thread engine, much like a front desk that checks a request, fills in missing forms, and sends it to the right workshop. Without it, clients could not reliably start or modify turns, update per-thread settings, stream realtime audio or text, or ask for code reviews.

The central type is `TurnRequestProcessor`. It holds shared services: authentication, thread lookup, outgoing messages, analytics, configuration, thread state, and listener setup. Public methods are thin request-facing wrappers. They call inner methods that do the real work: load the thread, validate the request, translate app-server protocol types into core protocol types, submit an `Op` to the core thread, and shape the response.

The file also protects important rules. It rejects oversized input, prevents direct input into certain multi-agent sub-agent threads, checks that an interrupt or steering request targets the active turn, and validates settings before accepting them. For realtime conversation, it first attaches a listener so the client can receive events, then submits start/audio/text/speech/stop operations. For reviews, it can either run the review inside the current thread or fork a detached review thread from the parent history.

#### Function details

##### `map_additional_context`  (lines 27–48)

```
fn map_additional_context(
    additional_context: Option<HashMap<String, AdditionalContextEntry>>,
) -> BTreeMap<String, CoreAdditionalContextEntry>
```

**Purpose**: Converts extra context sent by the app-server client into the matching format used by the core conversation engine. This lets callers attach named pieces of information while preserving whether each piece is trusted application data or untrusted external data.

**Data flow**: It receives an optional map of context entries. If nothing was provided, it treats that as an empty map. For each entry, it copies the text value and translates the context kind into the core protocol’s kind, then returns the converted map sorted by key.

**Call relations**: When a new turn starts or a running turn is steered, the inner turn methods use this helper before sending input to the core thread. It is one of the small translation steps between the app-server API and the core protocol.

*Call graph*: called by 2 (turn_start_inner, turn_steer_inner).


##### `TurnRequestProcessor::new`  (lines 68–96)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        analytics_events_client: AnalyticsEventsClient,
```

**Purpose**: Builds a `TurnRequestProcessor` with all the shared services it needs. Someone uses this when wiring the app server together so later request handlers can reuse the same processor.

**Data flow**: It receives references to managers, senders, configuration, state trackers, and watchers. It stores them in the processor without doing extra work. The result is a ready-to-use processor object.

**Call relations**: This is called during setup by the component that creates request processors. The returned object is later used by the initialized-client request handler to serve turn, settings, realtime, and review requests.

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

**Purpose**: Receives a client request to start a new turn in an existing thread. It is the public request-facing wrapper that returns the response in the generic client payload shape.

**Data flow**: It takes the request id, turn parameters, and optional client name/version. It passes them to the deeper start logic, then wraps the successful turn-start response as a client response payload. Errors pass back unchanged as JSON-RPC errors.

**Call relations**: The initialized-client request dispatcher calls this for `turn/start`. This wrapper delegates to `turn_start_inner`, which does validation, thread lookup, settings conversion, and submission to the core thread.

*Call graph*: calls 1 internal fn (turn_start_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_inject_items`  (lines 115–122)

```
async fn thread_inject_items(
        &self,
        params: ThreadInjectItemsParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives a request to insert already-formed response items into a thread. This is useful when another part of the system needs to add items directly to the thread’s recorded conversation.

**Data flow**: It takes the injection parameters, sends them to the inner injection method, and wraps the result as a generic client response payload. If parsing or insertion fails, it returns a client-facing error.

**Call relations**: The initialized-client request dispatcher calls this for injection requests. It hands the real work to `thread_inject_items_response_inner`.

*Call graph*: calls 1 internal fn (thread_inject_items_response_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_settings_update`  (lines 124–132)

```
async fn thread_settings_update(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadSettingsUpdateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives a client request to change settings for a thread, such as model, approvals, sandboxing, permissions, or personality. It is the request-facing wrapper around the settings update flow.

**Data flow**: It receives a request id and settings parameters. It calls the inner method that validates and submits the settings update, then wraps the empty success response for the client.

**Call relations**: The initialized-client request dispatcher calls this when a client sends `thread/settings/update`. It delegates to `thread_settings_update_inner`, which builds and submits the actual core settings operation.

*Call graph*: calls 1 internal fn (thread_settings_update_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::turn_steer`  (lines 134–142)

```
async fn turn_steer(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnSteerParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives extra user input meant to guide an already-running turn. Steering is like adding a note to someone while they are still working, rather than starting a new job.

**Data flow**: It takes the request id and steering parameters, calls the inner steering logic, and wraps the returned turn id for the client. Validation errors or core errors are returned as JSON-RPC errors.

**Call relations**: The initialized-client request dispatcher calls this for `turn/steer`. The wrapper relies on `turn_steer_inner` to check the active turn, convert input, and send the steering data to the thread.

*Call graph*: calls 1 internal fn (turn_steer_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::turn_interrupt`  (lines 144–152)

```
async fn turn_interrupt(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnInterruptParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives a request to stop startup work or interrupt an active turn. It is the public wrapper that adapts the inner interrupt result to the client response format.

**Data flow**: It accepts the request id and interrupt parameters, calls the inner interrupt method, and converts an optional interrupt response into the generic payload. Some interrupts respond immediately, while normal turn interrupts may wait for a later abort event.

**Call relations**: The initialized-client request dispatcher calls this for interrupt requests. It delegates to `turn_interrupt_inner`, which checks the target turn and submits the core interrupt operation.

*Call graph*: calls 1 internal fn (turn_interrupt_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_start`  (lines 154–162)

```
async fn thread_realtime_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives a request to begin a realtime conversation session for a thread. Realtime here means streaming-style interaction, such as voice or live text.

**Data flow**: It takes the request id and start parameters, calls the inner realtime-start logic, and wraps the optional response. If the client connection is already closed during listener setup, the response can be absent.

**Call relations**: The initialized-client request dispatcher calls this for realtime start requests. It delegates to `thread_realtime_start_inner`, which prepares the thread and submits the core start operation.

*Call graph*: calls 1 internal fn (thread_realtime_start_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_append_audio`  (lines 164–172)

```
async fn thread_realtime_append_audio(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendAudioParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCE
```

**Purpose**: Receives an audio chunk for an ongoing realtime conversation. It is the request-facing wrapper for sending that audio to the core thread.

**Data flow**: It accepts the request id and audio parameters, calls the inner append-audio method, and wraps the optional success response. Errors are returned if the thread is missing, unsupported, or the core operation fails.

**Call relations**: The initialized-client request dispatcher calls this while a realtime conversation is active. The actual preparation and core submission happen in `thread_realtime_append_audio_inner`.

*Call graph*: calls 1 internal fn (thread_realtime_append_audio_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_append_text`  (lines 174–182)

```
async fn thread_realtime_append_text(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendTextParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErr
```

**Purpose**: Receives a text message for an ongoing realtime conversation. This lets clients add live text input to the same realtime flow used for voice or other streaming interaction.

**Data flow**: It takes the request id and text parameters, calls the inner text-append method, and wraps the optional success response. The text and role are passed onward to the core operation.

**Call relations**: The initialized-client request dispatcher calls this for realtime text input. It delegates to `thread_realtime_append_text_inner`.

*Call graph*: calls 1 internal fn (thread_realtime_append_text_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_append_speech`  (lines 184–192)

```
async fn thread_realtime_append_speech(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendSpeechParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRP
```

**Purpose**: Receives text that should be treated as speech input in a realtime conversation. This is different from raw audio: the client provides the spoken content as text.

**Data flow**: It receives the request id and speech text parameters, calls the inner speech-append method, and wraps the optional response. On success, the core thread receives a speech operation.

**Call relations**: The initialized-client request dispatcher calls this for realtime speech input. It delegates to `thread_realtime_append_speech_inner`.

*Call graph*: calls 1 internal fn (thread_realtime_append_speech_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_stop`  (lines 194–202)

```
async fn thread_realtime_stop(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStopParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives a request to close an ongoing realtime conversation. It is the public wrapper around the core stop operation.

**Data flow**: It takes the request id and stop parameters, calls the inner stop method, and wraps the optional success response. If listener preparation shows the connection is closed, no response is sent.

**Call relations**: The initialized-client request dispatcher calls this for realtime stop requests. It delegates to `thread_realtime_stop_inner`.

*Call graph*: calls 1 internal fn (thread_realtime_stop_inner); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::thread_realtime_list_voices`  (lines 204–213)

```
async fn thread_realtime_list_voices(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Returns the built-in list of voices available for realtime conversation. This lets clients show voice choices without starting a session.

**Data flow**: It takes no parameters from the request body. It asks the realtime voice list for the built-in voices, places them in a response object, and returns that as a client payload.

**Call relations**: The initialized-client request dispatcher calls this when a client asks for realtime voices. Unlike most methods here, it does not need a thread or core operation; it simply returns local built-in data.

*Call graph*: calls 1 internal fn (builtin); called by 1 (handle_initialized_client_request).


##### `TurnRequestProcessor::review_start`  (lines 215–223)

```
async fn review_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ReviewStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Receives a request to start a code review. It is the request-facing wrapper that starts the review flow and normally sends the response separately.

**Data flow**: It accepts the request id and review parameters, calls the inner review-start logic, and maps success to no immediate generic payload. The review-start response is emitted through the outgoing message sender.

**Call relations**: The initialized-client request dispatcher calls this for review requests. It delegates to `review_start_inner`, which decides between inline and detached review.

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

**Purpose**: Records a failed JSON-RPC response for analytics. This helps the project understand which client requests fail and why, without changing the response itself.

**Data flow**: It receives the request id, the error object, and an optional analytics category. It extracts the connection id and request id, clones the error, and sends the information to the analytics client. Nothing is returned.

**Call relations**: Validation paths in turn start, turn steer, and direct-input checks call this before returning an error. It connects request-handling failures to the analytics system.

*Call graph*: calls 1 internal fn (track_error_response); called by 3 (ensure_direct_input_allowed, turn_start_inner, turn_steer_inner); 1 external calls (clone).


##### `TurnRequestProcessor::load_thread`  (lines 239–254)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Finds the core thread object for a thread id string supplied by a client. It also turns malformed or unknown ids into clear client-facing errors.

**Data flow**: It receives a thread id as text. First it parses the text into the internal thread id type; then it asks the thread manager for the corresponding thread. It returns both the parsed id and the thread object, or an invalid-request error.

**Call relations**: Most inner request handlers begin here, because they need a real thread before doing anything else. Realtime preparation, review start, item injection, settings updates, interrupts, turn start, and turn steer all depend on it.

*Call graph*: calls 1 internal fn (from_string); called by 7 (prepare_realtime_conversation_thread, review_start_inner, thread_inject_items_response_inner, thread_settings_update_inner, turn_interrupt_inner, turn_start_inner, turn_steer_inner).


##### `TurnRequestProcessor::ensure_direct_input_allowed`  (lines 256–273)

```
async fn ensure_direct_input_allowed(
        &self,
        request_id: &ConnectionRequestId,
        thread: &CodexThread,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Blocks direct client input to a restricted kind of multi-agent sub-agent thread. This protects the multi-agent flow from outside messages being inserted where only the parent agent should control the sub-agent.

**Data flow**: It reads the thread’s multi-agent version and session source. If the thread is a version-2 sub-agent spawned by another thread, it creates and tracks an invalid-request error. Otherwise it returns success without changing anything.

**Call relations**: Turn start and turn steer call this after loading the thread. When it rejects input, it also uses `track_error_response` so the blocked request is visible in analytics.

*Call graph*: calls 2 internal fn (track_error_response, multi_agent_version); called by 2 (turn_start_inner, turn_steer_inner); 1 external calls (matches!).


##### `TurnRequestProcessor::normalize_collaboration_mode`  (lines 275–290)

```
fn normalize_collaboration_mode(
        &self,
        mut collaboration_mode: CollaborationMode,
    ) -> CollaborationMode
```

**Purpose**: Fills in missing developer instructions for a collaboration mode using built-in presets. This lets clients choose a named mode without having to resend all of its default instructions.

**Data flow**: It receives a collaboration mode object. If the object has no developer instructions, it searches the built-in presets for the selected mode and copies non-empty default instructions into the settings. It returns the possibly enriched mode.

**Call relations**: This helper is used while building thread settings overrides. It is part of the settings translation path before the final settings are previewed or submitted.


##### `TurnRequestProcessor::review_request_from_target`  (lines 292–341)

```
fn review_request_from_target(
        target: ApiReviewTarget,
    ) -> Result<(ReviewRequest, String), JSONRPCErrorError>
```

**Purpose**: Turns a client’s review target into the core review request format. It also cleans up user-provided strings and rejects empty branch names, commit SHAs, or custom instructions.

**Data flow**: It receives a target such as uncommitted changes, a base branch, a commit, or custom instructions. It trims and validates text fields, converts the target to the core type, asks the review prompt code for a human-readable hint, and returns both the core review request and the display hint.

**Call relations**: The review-start flow calls this before choosing inline or detached delivery. The returned request is what later gets submitted to the core thread as a review operation.

*Call graph*: 1 external calls (user_facing_hint).


##### `TurnRequestProcessor::request_trace_context`  (lines 343–348)

```
async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<codex_protocol::protocol::W3cTraceContext>
```

**Purpose**: Looks up tracing information for the current request. A trace context is a set of identifiers that lets logs and downstream work be connected back to one client request.

**Data flow**: It receives a request id and asks the outgoing message sender for any stored trace context. It returns that context if one exists, or `None` if there is no trace information.

**Call relations**: Core submissions use this so the work they trigger can be traced. It is called directly by turn start and detached review creation, and indirectly through `submit_core_op`.

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

**Purpose**: Submits an operation to a core thread while attaching request trace information. It is the common doorway from app-server request handling into the core conversation engine.

**Data flow**: It receives the request id, a thread, and a core operation. It fetches trace context for the request, then asks the thread to submit the operation with that trace. It returns the core submission id or a core error.

**Call relations**: Settings updates, realtime start and append operations, realtime stop, reviews, and interrupts all use this helper. It keeps core submission behavior consistent across many request types.

*Call graph*: calls 2 internal fn (request_trace_context, submit_with_trace); called by 9 (start_detached_review, start_inline_review, thread_realtime_append_audio_inner, thread_realtime_append_speech_inner, thread_realtime_append_text_inner, thread_realtime_start_inner, thread_realtime_stop_inner, thread_settings_update_inner, turn_interrupt_inner).


##### `TurnRequestProcessor::input_too_large_error`  (lines 361–371)

```
fn input_too_large_error(actual_chars: usize) -> JSONRPCErrorError
```

**Purpose**: Builds the specific JSON-RPC error used when user input exceeds the allowed character limit. The extra error data helps clients show a useful message and recover gracefully.

**Data flow**: It receives the actual number of characters supplied. It creates an invalid-parameters error message and attaches structured data: the error code, the maximum allowed characters, and the actual count. It returns that error object.

**Call relations**: Input-size validation calls this when a request is too large. Turn start and turn steer then track and return the resulting error.

*Call graph*: 2 external calls (format!, json!).


##### `TurnRequestProcessor::validate_v2_input_limit`  (lines 373–379)

```
fn validate_v2_input_limit(items: &[V2UserInput]) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Checks that a list of version-2 user input items is not too large. This prevents a client from sending more text than the system is prepared to process.

**Data flow**: It receives the input items, counts the text characters across all of them, and compares the total with the maximum limit. If the total is too high, it returns the special too-large error; otherwise it returns success.

**Call relations**: Turn start and turn steer call this before converting and submitting user input. It uses `input_too_large_error` to create the client-facing failure.

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

**Purpose**: Performs the real work of starting a turn. It validates the request, translates client input and settings into core forms, submits the user input to the thread, and returns a new in-progress turn.

**Data flow**: It receives the request id, turn parameters, and client identity. It loads the thread, checks whether direct input is allowed, enforces the input size limit, stores client info, resolves environment and settings overrides, converts input items and extra context, and submits a user-input operation to the core thread. It records the resulting turn id and returns a turn object with in-progress status.

**Call relations**: `turn_start` calls this after the request dispatcher chooses the turn-start path. This method pulls together many helpers: thread loading, error tracking, context mapping, environment building, settings building, trace lookup, and memory-startup scheduling when real input was provided.

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

**Purpose**: Builds the environment selection override for a turn or settings update. This decides which working directory and environment choices the core thread should use for the request.

**Data flow**: It receives a thread, an optional current working directory, and optional environment selections. If neither is present, it returns no override. If only a directory is present, it asks the thread manager for default selections. If selections are present, it chooses a fallback directory from the request, local environment selection, or thread snapshot, then returns a complete environment selection object.

**Call relations**: Turn start and thread settings update call this before building thread settings. It feeds the environment part of the settings overrides sent to the core thread.

*Call graph*: calls 2 internal fn (config_snapshot, new); called by 2 (thread_settings_update_inner, turn_start_inner).


##### `TurnRequestProcessor::build_thread_settings_overrides`  (lines 534–686)

```
async fn build_thread_settings_overrides(
        &self,
        thread: &CodexThread,
        params: ThreadSettingsBuildParams,
    ) -> Result<codex_protocol::protocol::ThreadSettingsOverrides, JSO
```

**Purpose**: Converts optional client-supplied thread settings into validated core settings overrides. It protects against invalid combinations, such as sending both `permissions` and `sandboxPolicy`.

**Data flow**: It receives a thread and a bundle of possible settings changes. It normalizes collaboration mode, resolves workspace roots, converts approval and sandbox choices to core types, and, if permissions are named, loads configuration for the relevant directory to compute the permission profile. If anything was changed, it asks the thread to preview the overrides so invalid settings are rejected before submission. It returns the final core override object.

**Call relations**: Turn start and thread settings update both use this before sending settings to the core thread. It depends on configuration loading and thread preview checks so request handlers do not accept settings the thread cannot actually use.

*Call graph*: calls 3 internal fn (load_for_cwd, config_snapshot, preview_thread_settings_overrides); called by 2 (thread_settings_update_inner, turn_start_inner); 2 external calls (default, format!).


##### `TurnRequestProcessor::thread_settings_update_inner`  (lines 688–730)

```
async fn thread_settings_update_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadSettingsUpdateParams,
    ) -> Result<ThreadSettingsUpdateResponse, JSONRPCErrorEr
```

**Purpose**: Applies a client-requested settings update to an existing thread. It queues a core settings operation only when there is something to change.

**Data flow**: It loads the target thread, resolves an optional working directory, builds validated settings overrides, and compares them with the default empty override. If changes exist, it submits a `ThreadSettings` operation to the core thread. It returns an empty success response once the update has been accepted for processing.

**Call relations**: `thread_settings_update` calls this for client settings requests. It shares the same environment and settings-building helpers used by turn start, then submits through `submit_core_op`.

*Call graph*: calls 4 internal fn (build_environment_override, build_thread_settings_overrides, load_thread, submit_core_op); called by 1 (thread_settings_update); 1 external calls (default).


##### `TurnRequestProcessor::thread_inject_items_response_inner`  (lines 732–757)

```
async fn thread_inject_items_response_inner(
        &self,
        params: ThreadInjectItemsParams,
    ) -> Result<ThreadInjectItemsResponse, JSONRPCErrorError>
```

**Purpose**: Adds serialized response items directly into a thread after validating their shape. This is a controlled way to insert conversation items that are already represented as raw JSON values.

**Data flow**: It loads the thread, then walks through the supplied JSON items one by one and parses each into a `ResponseItem`. If any item is invalid, it reports which array position failed. If all parse correctly, it asks the thread to inject them and returns an empty success response.

**Call relations**: `thread_inject_items` calls this for injection requests. It talks directly to the thread’s item-injection API rather than submitting a normal turn operation.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_inject_items).


##### `TurnRequestProcessor::set_app_server_client_info`  (lines 759–776)

```
async fn set_app_server_client_info(
        thread: &CodexThread,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorEr
```

**Purpose**: Stores the app-server client name and version on the thread, along with a compatibility flag for one older Xcode client line. This lets core behavior adapt to client capabilities.

**Data flow**: It receives a thread and optional client name/version. It checks whether the client is Xcode 26.4 and should auto-deny MCP elicitation requests, then asks the thread to save the client information and flag. It returns success or an internal error.

**Call relations**: The turn-start flow calls this before submitting user input. It uses `xcode_26_4_mcp_elicitations_auto_deny` for the compatibility decision.

*Call graph*: calls 2 internal fn (xcode_26_4_mcp_elicitations_auto_deny, set_app_server_client_info).


##### `TurnRequestProcessor::turn_steer_inner`  (lines 778–885)

```
async fn turn_steer_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnSteerParams,
    ) -> Result<TurnSteerResponse, JSONRPCErrorError>
```

**Purpose**: Performs the real work of steering an active turn with additional input. It makes sure the caller names the expected active turn and turns core steering failures into clear client errors.

**Data flow**: It loads the thread, checks direct-input rules, verifies that `expectedTurnId` is not empty, records that turn id for the request, enforces the input size limit, converts input and extra context, and calls the thread’s steering API. It returns the turn id accepted by the core thread, or a detailed error for cases like no active turn, mismatched turn id, non-steerable review/compact turns, or empty input.

**Call relations**: `turn_steer` calls this. It uses the same thread loading, direct-input guard, input validation, context mapping, and analytics error tracking patterns as turn start.

*Call graph*: calls 4 internal fn (ensure_direct_input_allowed, load_thread, track_error_response, map_additional_context); called by 1 (turn_steer); 2 external calls (validate_v2_input_limit, Input).


##### `TurnRequestProcessor::prepare_realtime_conversation_thread`  (lines 887–916)

```
async fn prepare_realtime_conversation_thread(
        &self,
        request_id: &ConnectionRequestId,
        thread_id: &str,
    ) -> Result<Option<(ThreadId, Arc<CodexThread>)>, JSONRPCErrorError
```

**Purpose**: Prepares a thread for realtime conversation requests. It makes sure the client is listening for events and that the thread supports realtime conversation.

**Data flow**: It receives a request id and thread id string. It loads the thread, attaches or confirms a conversation listener for the request’s connection, and checks the thread feature flag for realtime conversation. It returns the thread when ready, `None` if the connection is already closed, or an error if the thread cannot support the request.

**Call relations**: Every realtime inner method calls this before submitting its core operation. It uses `ensure_conversation_listener` so realtime events have somewhere to go.

*Call graph*: calls 2 internal fn (ensure_conversation_listener, load_thread); called by 5 (thread_realtime_append_audio_inner, thread_realtime_append_speech_inner, thread_realtime_append_text_inner, thread_realtime_start_inner, thread_realtime_stop_inner); 1 external calls (format!).


##### `TurnRequestProcessor::thread_realtime_start_inner`  (lines 918–956)

```
async fn thread_realtime_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStartParams,
    ) -> Result<Option<ThreadRealtimeStartResponse>, JSONRPCEr
```

**Purpose**: Starts a realtime conversation in a prepared thread. It packages client options such as model, voice, transport, and output mode into the core start operation.

**Data flow**: It prepares the thread, returns no response if the client connection closed, converts the requested transport into the core transport type, fills defaults for optional booleans, and submits a `RealtimeConversationStart` operation. On success it returns the default start response.

**Call relations**: `thread_realtime_start` calls this. It relies on `prepare_realtime_conversation_thread` first, then submits through `submit_core_op`.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_start); 2 external calls (default, RealtimeConversationStart).


##### `TurnRequestProcessor::thread_realtime_append_audio_inner`  (lines 958–983)

```
async fn thread_realtime_append_audio_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendAudioParams,
    ) -> Result<Option<ThreadRealtimeAppendAudioR
```

**Purpose**: Sends one audio frame into an active realtime conversation. This is how streamed microphone data reaches the core conversation engine.

**Data flow**: It prepares the realtime thread, converts the provided audio frame into the core frame type, and submits a `RealtimeConversationAudio` operation. On success it returns the default append-audio response, or no response if the connection closed during preparation.

**Call relations**: `thread_realtime_append_audio` calls this. It follows the common realtime pattern: prepare listener and thread, then submit a core operation.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_append_audio); 2 external calls (default, RealtimeConversationAudio).


##### `TurnRequestProcessor::thread_realtime_append_text_inner`  (lines 985–1011)

```
async fn thread_realtime_append_text_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendTextParams,
    ) -> Result<Option<ThreadRealtimeAppendTextResp
```

**Purpose**: Sends live text into an active realtime conversation. The text includes a role so the core engine knows who the message represents.

**Data flow**: It prepares the realtime thread, puts the request’s text and role into core conversation text parameters, and submits a `RealtimeConversationText` operation. It returns the default success response when accepted.

**Call relations**: `thread_realtime_append_text` calls this. Like the other realtime append methods, it depends on `prepare_realtime_conversation_thread` and `submit_core_op`.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_append_text); 2 external calls (default, RealtimeConversationText).


##### `TurnRequestProcessor::thread_realtime_append_speech_inner`  (lines 1013–1036)

```
async fn thread_realtime_append_speech_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeAppendSpeechParams,
    ) -> Result<Option<ThreadRealtimeAppendSpee
```

**Purpose**: Sends speech-as-text into an active realtime conversation. This gives the core engine spoken content without requiring raw audio bytes.

**Data flow**: It prepares the realtime thread, wraps the provided text in speech parameters, and submits a `RealtimeConversationSpeech` operation. It returns the default success response if the operation is accepted.

**Call relations**: `thread_realtime_append_speech` calls this. It shares the same preparation and submission flow as realtime audio and text.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_append_speech); 2 external calls (default, RealtimeConversationSpeech).


##### `TurnRequestProcessor::thread_realtime_stop_inner`  (lines 1038–1055)

```
async fn thread_realtime_stop_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRealtimeStopParams,
    ) -> Result<Option<ThreadRealtimeStopResponse>, JSONRPCError
```

**Purpose**: Stops an active realtime conversation for a thread. It tells the core engine to close the realtime session.

**Data flow**: It prepares the realtime thread and then submits a `RealtimeConversationClose` operation. On success it returns the default stop response, unless preparation found that the connection had already closed.

**Call relations**: `thread_realtime_stop` calls this. It uses the common realtime preparation helper and the shared core-operation submission helper.

*Call graph*: calls 2 internal fn (prepare_realtime_conversation_thread, submit_core_op); called by 1 (thread_realtime_stop); 1 external calls (default).


##### `TurnRequestProcessor::build_review_turn`  (lines 1057–1082)

```
fn build_review_turn(turn_id: String, display_text: &str) -> Turn
```

**Purpose**: Creates the client-facing `Turn` object used when a review starts. It gives the UI an in-progress turn, optionally containing a synthesized user message that describes what is being reviewed.

**Data flow**: It receives a turn id and display text. If the display text is empty, it creates a turn with no items. Otherwise it creates a user-message item containing that text. It returns an in-progress turn with no error or timing information yet.

**Call relations**: Inline and detached review flows call this after submitting the core review operation. The resulting turn is sent to the client by `emit_review_started`.

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

**Purpose**: Sends the review-start response to the client. This response includes the in-progress review turn and the thread id where the review is running.

**Data flow**: It receives the request id, the constructed turn, and the review thread id string. It wraps them in a review-start response and sends that response through the outgoing message sender. It does not return a payload to the caller.

**Call relations**: Both inline and detached review starters call this after they have a core turn id. It is why `review_start` can complete without returning a normal immediate payload.

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

**Purpose**: Starts a review inside the existing parent thread. This keeps the review as another turn in the same conversation.

**Data flow**: It receives the request id, parent thread, core review request, display text, and parent thread id string. It submits a review operation to the parent thread, builds a client-facing review turn from the returned turn id, sends the review-start response, and returns success.

**Call relations**: `review_start_inner` calls this when the requested delivery is inline. It uses `submit_core_op`, `build_review_turn`, and `emit_review_started` in sequence.

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

**Purpose**: Starts a review in a newly forked thread instead of the parent thread. This lets the review run separately while still starting from the parent conversation’s history.

**Data flow**: It first makes sure the parent thread’s stored rollout is current, then loads the parent history. It clones the server config, optionally switches to the configured review model, and asks the thread manager to fork a new thread from the parent history. It attaches a listener, updates thread-watch state and sends a thread-started notification when possible, submits the review operation to the new thread, builds the review turn, and sends the review-start response with the new thread id.

**Call relations**: `review_start_inner` calls this when detached delivery is requested. It coordinates thread persistence, thread creation, listener attachment, watch-state notification, core review submission, and response emission.

*Call graph*: calls 6 internal fn (emit_review_started, ensure_conversation_listener, request_trace_context, submit_core_op, loaded_status_for_thread, upsert_thread_silently); called by 1 (review_start_inner); 4 external calls (build_review_turn, ThreadStarted, Resumed, warn!).


##### `TurnRequestProcessor::review_start_inner`  (lines 1232–1268)

```
async fn review_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ReviewStartParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Runs the main review-start decision flow. It validates the target, loads the parent thread, and chooses whether the review should be inline or detached.

**Data flow**: It receives the parent thread id, review target, and optional delivery choice. It loads the parent thread, converts the target into a core review request plus display text, defaults delivery to inline if missing, and calls either the inline or detached review starter. It returns success after the chosen starter sends the response.

**Call relations**: `review_start` calls this. It relies on `load_thread`, `review_request_from_target`, `start_inline_review`, and `start_detached_review`.

*Call graph*: calls 3 internal fn (load_thread, start_detached_review, start_inline_review); called by 1 (review_start); 1 external calls (review_request_from_target).


##### `TurnRequestProcessor::turn_interrupt_inner`  (lines 1270–1333)

```
async fn turn_interrupt_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: TurnInterruptParams,
    ) -> Result<Option<TurnInterruptResponse>, JSONRPCErrorError>
```

**Purpose**: Performs the real work of interrupting startup or an active turn. It carefully records normal turn interrupts so the server can answer when the core later reports that the turn was aborted.

**Data flow**: It receives the thread id and turn id. An empty turn id means startup interrupt. It loads the thread, and for normal turn interrupts it checks thread state to make sure the requested turn is active or plausibly running, records the pending interrupt request, and records the turn id for outgoing tracking. It submits an interrupt operation to the core thread. Startup interrupts return immediately; normal turn interrupts usually return later. If submission fails, it removes the pending interrupt record.

**Call relations**: `turn_interrupt` calls this. It combines thread lookup, thread-state inspection, outgoing request tracking, and `submit_core_op` to make interrupt responses line up with later turn-aborted events.

*Call graph*: calls 3 internal fn (load_thread, submit_core_op, thread_state); called by 1 (turn_interrupt); 3 external calls (clone, format!, matches!).


##### `TurnRequestProcessor::listener_task_context`  (lines 1335–1347)

```
fn listener_task_context(&self) -> ListenerTaskContext
```

**Purpose**: Builds the bundle of shared services needed by background listener tasks. A listener task watches a core thread and forwards its events to connected clients.

**Data flow**: It copies or clones references to the thread manager, thread state manager, outgoing sender, unload set, watch manager, semaphore, fallback model provider, Codex home path, and skills watcher. It returns them as a `ListenerTaskContext`.

**Call relations**: `ensure_conversation_listener` calls this before delegating to the thread lifecycle code. It keeps listener setup from needing direct access to every field on `TurnRequestProcessor`.

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

**Purpose**: Makes sure a client connection has a listener attached to a thread. Without this, the client might start realtime work or a detached review but never receive the resulting events.

**Data flow**: It receives a conversation id, connection id, and a flag for raw event forwarding. It builds a listener context and passes everything to the thread lifecycle helper. It returns whether a listener was attached, the connection was closed, or an error occurred.

**Call relations**: Realtime preparation calls this before realtime operations, and detached review startup calls it for the newly forked review thread. Internally it delegates to the shared thread-lifecycle listener function.

*Call graph*: calls 2 internal fn (ensure_conversation_listener, listener_task_context); called by 2 (prepare_realtime_conversation_thread, start_detached_review).


##### `xcode_26_4_mcp_elicitations_auto_deny`  (lines 1365–1374)

```
fn xcode_26_4_mcp_elicitations_auto_deny(
    client_name: Option<&str>,
    client_version: Option<&str>,
) -> bool
```

**Purpose**: Detects one older Xcode client line that should automatically deny MCP elicitation requests. This is a compatibility workaround for a client version that shipped before those requests were visible to users.

**Data flow**: It receives optional client name and version strings. It returns `true` only when the name is exactly `Xcode` and the version starts with `26.4`; otherwise it returns `false`.

**Call relations**: `set_app_server_client_info` calls this before saving client information on the thread. The result changes how the core thread treats MCP elicitation behavior for that client.

*Call graph*: called by 1 (set_app_server_client_info).


### `app-server/src/request_processors/windows_sandbox_processor.rs`

`orchestration` · `request handling`

Windows sandboxing is a safety feature: it limits what a command can do on a Windows machine, like putting the command inside a controlled room instead of letting it roam the whole house. This file is the request processor for that feature. It tells clients whether the sandbox is ready, and it accepts a request to prepare the machine for sandbox use.

The main type, WindowsSandboxRequestProcessor, keeps three things close at hand: a way to send messages back to the client, the current configuration, and a configuration loader that can re-check settings for a specific working folder. When a client asks for readiness, the file looks at the platform and the configured sandbox level, then reports one of three plain states: not configured, ready, or update required.

When a client asks to start sandbox setup, the file first reloads configuration for the requested folder and checks whether the requested setup mode is permitted by managed requirements. This matters because some environments may force or forbid certain sandbox modes. Only after that check succeeds does it immediately tell the client that setup has started. The actual setup may take longer, so it runs in a background task. When that task finishes, the processor sends a completion notification back to the same connection with success or an error message.

#### Function details

##### `WindowsSandboxRequestProcessor::new`  (lines 11–21)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        config: Arc<Config>,
        config_manager: ConfigManager,
    ) -> Self
```

**Purpose**: Creates a Windows sandbox request processor with the shared pieces it needs: outgoing client messaging, current configuration, and a configuration loader. This is used when the server is wiring together its request-processing components.

**Data flow**: It receives shared references to the outgoing message sender and configuration, plus a configuration manager. It stores those values inside a new processor object. The result is a ready-to-use processor that can answer sandbox requests later.

**Call relations**: A higher-level constructor calls this while assembling the server’s request processors. After that, request-handling code can use the returned processor for readiness checks and setup requests.

*Call graph*: called by 1 (new).


##### `WindowsSandboxRequestProcessor::windows_sandbox_readiness`  (lines 23–27)

```
async fn windows_sandbox_readiness(
        &self,
    ) -> Result<WindowsSandboxReadinessResponse, JSONRPCErrorError>
```

**Purpose**: Answers the client’s question: “Is Windows sandbox support ready to use?” It wraps the readiness check in the request processor’s async interface so it can be called as part of normal client request handling.

**Data flow**: It reads the processor’s current configuration, passes it to the readiness helper, and returns the resulting readiness response. It does not change files, settings, or server state.

**Call relations**: The initialized client request handler calls this when a client asks about sandbox readiness. This function delegates the actual decision to determine_windows_sandbox_readiness and sends the answer back through the normal request-response path.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness); called by 1 (handle_initialized_client_request).


##### `WindowsSandboxRequestProcessor::windows_sandbox_setup_start`  (lines 29–37)

```
async fn windows_sandbox_setup_start(
        &self,
        request_id: &ConnectionRequestId,
        params: WindowsSandboxSetupStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErr
```

**Purpose**: Starts the Windows sandbox setup flow for a client request. Its public-facing job is to trigger setup and return no normal response payload because the real status comes later as a notification.

**Data flow**: It receives the request id and setup parameters, passes both into the inner setup routine, and converts a successful empty result into an empty optional client response. If setup cannot even be started, it returns an error instead.

**Call relations**: The initialized client request handler calls this when a client asks to begin setup. It keeps the outer request API simple and hands the real work to windows_sandbox_setup_start_inner.

*Call graph*: calls 1 internal fn (windows_sandbox_setup_start_inner); called by 1 (handle_initialized_client_request).


##### `WindowsSandboxRequestProcessor::windows_sandbox_setup_start_inner`  (lines 39–104)

```
async fn windows_sandbox_setup_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: WindowsSandboxSetupStartParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Performs the careful start-up sequence for Windows sandbox setup. It validates that the requested mode is allowed, acknowledges the request, then launches the longer setup operation in the background.

**Data flow**: It starts with the client request id and setup parameters, including an optional working folder and requested setup mode. It chooses a working folder, reloads configuration for that folder, checks whether the requested sandbox mode is permitted, then sends an immediate “started” response. After that, it spawns a background task that builds a setup request using permissions, workspace roots, environment variables, and the Codex home folder. When setup finishes, it sends a completion notification with the chosen mode, whether it succeeded, and any error text.

**Call relations**: windows_sandbox_setup_start calls this as the real implementation. Inside, it asks the configuration manager to load settings for the relevant folder, uses resolve_allowed_windows_sandbox_setup_mode to enforce policy, calls the core Windows sandbox setup routine, and finally uses the outgoing message sender to notify the original connection when setup is done.

*Call graph*: calls 3 internal fn (load_for_cwd, resolve_allowed_windows_sandbox_setup_mode, run_windows_sandbox_setup); called by 1 (windows_sandbox_setup_start); 6 external calls (clone, default, WindowsSandboxSetupCompleted, clone, vars, spawn).


##### `resolve_allowed_windows_sandbox_setup_mode`  (lines 108–127)

```
fn resolve_allowed_windows_sandbox_setup_mode(
    requirements: &codex_config::ConfigRequirements,
    requested_mode: WindowsSandboxSetupMode,
) -> Result<CoreWindowsSandboxSetupMode, JSONRPCErrorEr
```

**Purpose**: Checks whether the setup mode requested by the client is allowed by the current configuration requirements. This prevents the server from starting a sandbox setup mode that policy says cannot be saved or used.

**Data flow**: It receives the managed configuration requirements and the requested API mode, either elevated or unelevated. It translates that request into the core setup mode and the configuration-file form of the same choice, asks the requirements whether that value is allowed, and returns either the core mode or an invalid-request error.

**Call relations**: windows_sandbox_setup_start_inner uses this before acknowledging setup, so clients do not get a false “started” response for a forbidden mode. A unit test also calls it directly to prove that disallowed modes are rejected with the right kind of error.

*Call graph*: called by 2 (windows_sandbox_setup_start_inner, resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode).


##### `determine_windows_sandbox_readiness`  (lines 129–140)

```
fn determine_windows_sandbox_readiness(config: &Config) -> WindowsSandboxReadinessResponse
```

**Purpose**: Decides the current Windows sandbox readiness from the real configuration and platform. It is the bridge between the server’s stored settings and the simpler readiness answer sent to clients.

**Data flow**: It receives the current configuration. If the program is not running on Windows, it returns “not configured.” On Windows, it reads the configured sandbox level, checks whether elevated sandbox setup has already been completed under the Codex home folder, and passes those facts to the state-based readiness helper.

**Call relations**: windows_sandbox_readiness calls this to answer a client request. This function keeps platform and configuration lookup in one place, then relies on determine_windows_sandbox_readiness_from_state for the final status rules.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); called by 1 (windows_sandbox_readiness); 2 external calls (cfg!, from_config).


##### `determine_windows_sandbox_readiness_from_state`  (lines 142–159)

```
fn determine_windows_sandbox_readiness_from_state(
    windows_sandbox_level: WindowsSandboxLevel,
    sandbox_setup_is_complete: bool,
) -> WindowsSandboxReadinessResponse
```

**Purpose**: Turns two simple facts into a client-facing readiness status: the configured sandbox level and whether setup is complete. This small rule table is easy to test because it does not need real files or a real Windows machine.

**Data flow**: It receives a sandbox level and a true-or-false setup-complete flag. Disabled becomes “not configured,” restricted-token mode becomes “ready,” and elevated mode becomes “ready” only when setup is complete; otherwise it becomes “update required.” It returns a readiness response containing that status.

**Call relations**: determine_windows_sandbox_readiness calls this after gathering real state. Several tests call it directly with hand-picked inputs to verify each important readiness outcome.

*Call graph*: called by 5 (determine_windows_sandbox_readiness, determine_windows_sandbox_readiness_reports_not_configured_when_disabled, determine_windows_sandbox_readiness_reports_ready_for_complete_elevated_mode, determine_windows_sandbox_readiness_reports_ready_for_unelevated_mode, determine_windows_sandbox_readiness_reports_update_required_when_elevated_setup_is_stale).


##### `tests::resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode`  (lines 171–191)

```
fn resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode()
```

**Purpose**: Checks that the mode validator refuses a setup mode that configuration requirements do not allow. This protects the policy-enforcement behavior from accidental changes.

**Data flow**: It builds requirements that allow only elevated sandbox mode, then asks to resolve unelevated mode. The expected result is an invalid-request error whose message says the sandbox setup mode is invalid.

**Call relations**: This test calls resolve_allowed_windows_sandbox_setup_mode directly. It stands as a focused safety check for the validation step used before setup is started.

*Call graph*: calls 3 internal fn (resolve_allowed_windows_sandbox_setup_mode, new, allow_only); 3 external calls (default, assert!, assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_not_configured_when_disabled`  (lines 194–201)

```
fn determine_windows_sandbox_readiness_reports_not_configured_when_disabled()
```

**Purpose**: Verifies that a disabled sandbox configuration is reported to clients as not configured. This confirms the simplest “feature is off” case.

**Data flow**: It passes the disabled sandbox level and a false setup-complete flag into the state-based readiness helper. It expects the returned status to be “not configured.”

**Call relations**: This test calls determine_windows_sandbox_readiness_from_state directly, checking one branch of the rule table used by the real readiness request path.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_ready_for_unelevated_mode`  (lines 204–211)

```
fn determine_windows_sandbox_readiness_reports_ready_for_unelevated_mode()
```

**Purpose**: Verifies that restricted-token, or unelevated, sandbox mode is considered ready without needing the separate elevated setup step.

**Data flow**: It passes the restricted-token sandbox level and a false setup-complete flag into the readiness helper. It expects the returned status to be “ready.”

**Call relations**: This test calls determine_windows_sandbox_readiness_from_state directly. It protects the rule that unelevated sandboxing does not depend on the setup-complete marker.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_ready_for_complete_elevated_mode`  (lines 214–221)

```
fn determine_windows_sandbox_readiness_reports_ready_for_complete_elevated_mode()
```

**Purpose**: Verifies that elevated sandbox mode is reported as ready after its setup has been completed. This confirms the happy path for the stronger sandbox mode.

**Data flow**: It passes the elevated sandbox level and a true setup-complete flag into the readiness helper. It expects the returned status to be “ready.”

**Call relations**: This test calls determine_windows_sandbox_readiness_from_state directly. It checks the same rule that the real readiness request uses after looking for completed setup on disk.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


##### `tests::determine_windows_sandbox_readiness_reports_update_required_when_elevated_setup_is_stale`  (lines 224–231)

```
fn determine_windows_sandbox_readiness_reports_update_required_when_elevated_setup_is_stale()
```

**Purpose**: Verifies that elevated sandbox mode reports “update required” when setup is missing or stale. This tells clients they need to run setup before relying on that mode.

**Data flow**: It passes the elevated sandbox level and a false setup-complete flag into the readiness helper. It expects the returned status to be “update required.”

**Call relations**: This test calls determine_windows_sandbox_readiness_from_state directly. It protects the warning path used when elevated sandbox configuration exists but the machine has not been prepared yet.

*Call graph*: calls 1 internal fn (determine_windows_sandbox_readiness_from_state); 1 external calls (assert_eq!).


### Thread and conversation routing
This group follows the app server's thread-centric request paths from thread lifecycle operations through goals, deletion, dynamic tool responses, and model-facing tool dispatch.

### `app-server/src/request_processors/thread_processor.rs`

`orchestration` · `request handling`

A “thread” here is a saved or running Codex conversation. This file is the central desk clerk for thread-related API calls: a client asks to start a thread, resume an old one, list past work, read turns, archive it, run a shell command, or update metadata, and this processor checks the request, talks to the thread manager and storage layer, then sends back the right JSON-RPC response. JSON-RPC is a simple request/response protocol used by the app server.

The file also bridges two worlds. On one side are client-facing app-server types, such as thread summaries and paged turn lists. On the other side are core Codex objects, stored rollout history, configuration snapshots, permission profiles, and live listener tasks. The processor converts between them, keeps live thread listeners attached to connections, and cleans up bookkeeping when threads unload or clients disconnect.

A useful analogy is an airport gate agent. The thread manager flies the plane, the thread store keeps the records, and this file checks tickets, reroutes passengers, announces updates, and makes sure no two people edit the passenger list at once. Without it, clients could not reliably create, rejoin, inspect, or clean up conversations, and live state could drift away from stored history.

#### Function details

##### `collect_resume_override_mismatches`  (lines 21–140)

```
fn collect_resume_override_mismatches(
    request: &ThreadResumeParams,
    config_snapshot: &ThreadConfigSnapshot,
) -> Vec<String>
```

**Purpose**: Checks whether a client trying to resume an already running thread asked for settings that differ from the thread’s current settings. It explains each mismatch so the server can warn or decide whether a cold restart is needed.

**Data flow**: It receives resume parameters and a live configuration snapshot, compares fields like model, provider, working directory, sandbox, permissions, and instructions, and returns a list of human-readable mismatch messages.

**Call relations**: When resume_running_thread finds that the target thread is already loaded, it calls this helper before deciding whether to simply rejoin the live thread or shut down an idle cached thread and resume fresh.

*Call graph*: calls 2 internal fn (cwd, sandbox_policy); called by 1 (resume_running_thread); 4 external calls (new, format!, matches!, from).


##### `merge_persisted_resume_metadata`  (lines 142–160)

```
fn merge_persisted_resume_metadata(
    request_overrides: &mut Option<HashMap<String, serde_json::Value>>,
    typesafe_overrides: &mut ConfigOverrides,
    persisted_metadata: &ThreadMetadata,
)
```

**Purpose**: Fills in model-related resume settings from saved thread metadata when the client did not explicitly override them. This helps resumed threads keep using the model they originally used.

**Data flow**: It receives mutable request overrides, typed config overrides, and saved metadata; if no model override is already present, it copies the saved model, provider, and reasoning effort into the override structures.

**Call relations**: load_and_apply_persisted_resume_metadata calls this during cold resume so the later configuration load starts from the saved thread’s model choices.

*Call graph*: calls 1 internal fn (has_model_resume_override); called by 1 (load_and_apply_persisted_resume_metadata); 1 external calls (String).


##### `normalize_thread_list_cwd_filters`  (lines 162–184)

```
fn normalize_thread_list_cwd_filters(
    cwd: Option<ThreadListCwdFilter>,
) -> Result<Option<Vec<PathBuf>>, JSONRPCErrorError>
```

**Purpose**: Turns a client’s working-directory filter for thread listing into normalized absolute paths. This makes path comparisons reliable even if the client used relative paths.

**Data flow**: It receives either no filter, one path, or many paths; it resolves each path against the current directory and returns either no filter or a list of normalized paths, or an invalid-parameters error.

**Call relations**: thread_list_response_inner uses this before asking storage for matching threads, so later filtering compares paths in a consistent form.

*Call graph*: calls 1 internal fn (relative_to_current_dir); called by 1 (thread_list_response_inner); 2 external calls (with_capacity, vec!).


##### `has_model_resume_override`  (lines 186–195)

```
fn has_model_resume_override(
    request_overrides: Option<&HashMap<String, serde_json::Value>>,
    typesafe_overrides: &ConfigOverrides,
) -> bool
```

**Purpose**: Answers whether the resume request already contains any model-related override. It prevents saved metadata from accidentally overwriting an explicit client choice.

**Data flow**: It reads typed overrides and raw JSON override keys, checks for model, provider, or reasoning effort settings, and returns true or false.

**Call relations**: merge_persisted_resume_metadata calls it as a guard before adding model information from persisted metadata.

*Call graph*: called by 1 (merge_persisted_resume_metadata).


##### `validate_dynamic_tools`  (lines 197–342)

```
fn validate_dynamic_tools(tools: &[DynamicToolSpec]) -> Result<(), String>
```

**Purpose**: Checks that client-provided dynamic tools have safe names, valid namespaces, no duplicates, and supported input schemas. This protects the model tool interface from malformed or reserved tool definitions.

**Data flow**: It receives a list of tool specifications, validates names, lengths, namespace descriptions, reserved words, duplicate names, deferred-loading rules, and schemas, then returns success or a clear error string.

**Call relations**: thread_start_task calls this just before creating a new thread, so bad tool definitions are rejected before they reach the core thread engine.

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

**Purpose**: Builds a ThreadRequestProcessor with all the services it needs. It is the constructor that gathers authentication, thread storage, configuration, outgoing messaging, live-state tracking, and watchers into one request-handling object.

**Data flow**: It receives shared service handles and stores them on the processor, also creating a task tracker for background work; it returns the ready processor.

**Call relations**: The server setup code calls this once when wiring request processors, and all later thread API methods use the stored services.

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

**Purpose**: Public handler for the client’s thread/start request. It starts the deeper start flow and returns no immediate payload because the background task sends the response itself.

**Data flow**: It receives a request id, start parameters, client identity, and tracing context, forwards them to thread_start_inner, and maps successful completion to no direct response payload.

**Call relations**: handle_initialized_client_request calls this when a client asks to start a thread; it delegates all real work to thread_start_inner.

*Call graph*: calls 1 internal fn (thread_start_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_unsubscribe`  (lines 433–441)

```
async fn thread_unsubscribe(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadUnsubscribeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for unsubscribing a connection from updates for a thread. It returns whether the connection was unsubscribed, was not subscribed, or the thread was not loaded.

**Data flow**: It receives request and unsubscribe parameters, calls the inner unsubscribe logic with the connection id, and wraps the response for the client.

**Call relations**: handle_initialized_client_request calls this for thread/unsubscribe; thread_unsubscribe_response_inner performs the state update.

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

**Purpose**: Public handler for resuming or rejoining a thread. It kicks off the resume flow and lets that flow send responses or errors through the outgoing channel.

**Data flow**: It receives the request id, resume parameters, and client identity, forwards them to thread_resume_inner, and returns no direct response payload on success.

**Call relations**: handle_initialized_client_request calls this for thread/resume; thread_resume_inner handles both already-running and cold-resume cases.

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

**Purpose**: Public handler for creating a new thread from an existing thread’s history. Forking lets a client branch from a previous conversation state.

**Data flow**: It receives fork parameters and client identity, delegates to thread_fork_inner, and returns no direct payload because the inner flow sends the response.

**Call relations**: handle_initialized_client_request calls this for thread/fork; thread_fork_inner performs storage reads, thread creation, listener attachment, and response sending.

*Call graph*: calls 1 internal fn (thread_fork_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_archive`  (lines 477–498)

```
async fn thread_archive(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadArchiveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for archiving a thread and any spawned descendants that should be archived with it. It also broadcasts archive notifications.

**Data flow**: It receives an archive request, calls the archive inner flow, sends the JSON-RPC response, then sends a server notification for each archived thread id.

**Call relations**: handle_initialized_client_request calls this for thread/archive; thread_archive_inner and thread_archive_response do the actual storage and teardown work.

*Call graph*: calls 1 internal fn (thread_archive_inner); called by 1 (handle_initialized_client_request); 2 external calls (ThreadArchived, clone).


##### `ThreadRequestProcessor::thread_increment_elicitation`  (lines 500–507)

```
async fn thread_increment_elicitation(
        &self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler that tells a thread an out-of-band elicitation is active. An elicitation is a side request for user input, and the count can pause other work.

**Data flow**: It receives the target thread id, delegates to the inner counter increment, and returns the new count plus whether the thread is paused.

**Call relations**: handle_initialized_client_request calls this; thread_increment_elicitation_inner loads the live thread and updates its counter.

*Call graph*: calls 1 internal fn (thread_increment_elicitation_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_decrement_elicitation`  (lines 509–516)

```
async fn thread_decrement_elicitation(
        &self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler that marks one out-of-band elicitation as finished. It lets the thread resume once the count reaches zero.

**Data flow**: It receives the target thread id, delegates to the inner decrement, and returns the new count plus whether any elicitation still pauses the thread.

**Call relations**: handle_initialized_client_request calls this; thread_decrement_elicitation_inner performs validation and updates the live thread.

*Call graph*: calls 1 internal fn (thread_decrement_elicitation_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_set_name`  (lines 518–539)

```
async fn thread_set_name(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadSetNameParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for renaming a thread. It updates stored metadata and notifies clients when the visible name changes.

**Data flow**: It receives a request id and name parameters, calls the inner update, sends the response, and optionally sends a ThreadNameUpdated notification.

**Call relations**: handle_initialized_client_request calls this; thread_set_name_response_inner validates and writes the new name.

*Call graph*: calls 1 internal fn (thread_set_name_response_inner); called by 1 (handle_initialized_client_request); 2 external calls (ThreadNameUpdated, clone).


##### `ThreadRequestProcessor::thread_metadata_update`  (lines 541–548)

```
async fn thread_metadata_update(
        &self,
        params: ThreadMetadataUpdateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for updating extra thread metadata, currently focused on Git information. Git is the version-control system data attached to a thread.

**Data flow**: It receives metadata update parameters, delegates to the inner update, and returns the updated thread view.

**Call relations**: handle_initialized_client_request calls this; thread_metadata_update_response_inner validates and writes the metadata patch.

*Call graph*: calls 1 internal fn (thread_metadata_update_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_memory_mode_set`  (lines 550–557)

```
async fn thread_memory_mode_set(
        &self,
        params: ThreadMemoryModeSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for changing a thread’s memory mode. This affects how the thread should use saved memory features.

**Data flow**: It receives a thread id and mode, delegates to the inner metadata update, and returns an empty success response.

**Call relations**: handle_initialized_client_request calls this; thread_memory_mode_set_response_inner writes the new mode to thread metadata.

*Call graph*: calls 1 internal fn (thread_memory_mode_set_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::memory_reset`  (lines 559–565)

```
async fn memory_reset(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for clearing stored memory data. This is a global reset, not just a single-thread operation.

**Data flow**: It calls the inner memory reset routine and converts the success result into a client response payload.

**Call relations**: handle_initialized_client_request calls this; memory_reset_response_inner clears both database rows and memory directories.

*Call graph*: calls 1 internal fn (memory_reset_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_unarchive`  (lines 567–584)

```
async fn thread_unarchive(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadUnarchiveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for making an archived thread visible again. It sends both a response and a notification that the thread was unarchived.

**Data flow**: It receives unarchive parameters, calls the inner flow, sends the response, then broadcasts a ThreadUnarchived notification.

**Call relations**: handle_initialized_client_request calls this; thread_unarchive_inner serializes the operation and delegates storage work.

*Call graph*: calls 1 internal fn (thread_unarchive_inner); called by 1 (handle_initialized_client_request); 2 external calls (ThreadUnarchived, clone).


##### `ThreadRequestProcessor::thread_compact_start`  (lines 586–594)

```
async fn thread_compact_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadCompactStartParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for starting compaction of a thread. Compaction asks the core to summarize or shrink history so the conversation is cheaper to continue.

**Data flow**: It receives a thread id and request id, delegates to the inner operation submission, and returns an empty success response.

**Call relations**: handle_initialized_client_request calls this; thread_compact_start_inner loads the live thread and submits the core Compact operation.

*Call graph*: calls 1 internal fn (thread_compact_start_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_background_terminals_clean`  (lines 596–604)

```
async fn thread_background_terminals_clean(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadBackgroundTerminalsCleanParams,
    ) -> Result<Option<ClientResponsePayload>
```

**Purpose**: Public handler for asking a thread to clean up finished background terminal processes. This keeps old process entries from cluttering the thread.

**Data flow**: It receives the target thread id, delegates to the inner core operation, and returns an empty success response.

**Call relations**: handle_initialized_client_request calls this; thread_background_terminals_clean_inner submits the cleanup operation to the live thread.

*Call graph*: calls 1 internal fn (thread_background_terminals_clean_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_background_terminals_list`  (lines 606–613)

```
async fn thread_background_terminals_list(
        &self,
        params: ThreadBackgroundTerminalsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for listing background terminals started by a thread. It supports paging so clients can fetch results in chunks.

**Data flow**: It receives list parameters, delegates to the inner listing code, and returns terminal entries plus an optional next cursor.

**Call relations**: handle_initialized_client_request calls this; thread_background_terminals_list_inner reads live terminal state and paginates it.

*Call graph*: calls 1 internal fn (thread_background_terminals_list_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_background_terminals_terminate`  (lines 615–622)

```
async fn thread_background_terminals_terminate(
        &self,
        params: ThreadBackgroundTerminalsTerminateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for stopping one background terminal process belonging to a thread.

**Data flow**: It receives a thread id and process id, delegates to the inner terminator, and returns whether a process was actually terminated.

**Call relations**: handle_initialized_client_request calls this; thread_background_terminals_terminate_inner parses the process id and calls the live thread.

*Call graph*: calls 1 internal fn (thread_background_terminals_terminate_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_rollback`  (lines 624–632)

```
async fn thread_rollback(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for rolling a thread back by a number of turns. Rollback removes recent conversation progress so the user can try again from an earlier point.

**Data flow**: It receives rollback parameters, delegates to thread_rollback_inner, and returns no direct payload because the operation completes through thread events.

**Call relations**: handle_initialized_client_request calls this; thread_rollback_start submits the rollback command and tracks the pending request.

*Call graph*: calls 1 internal fn (thread_rollback_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_list`  (lines 634–641)

```
async fn thread_list(
        &self,
        params: ThreadListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for listing stored threads. It supports filters, sorting, and paging.

**Data flow**: It receives list parameters, delegates to thread_list_response_inner, and returns a page of thread summaries.

**Call relations**: handle_initialized_client_request calls this; thread_list_response_inner normalizes filters and converts stored records into API threads.

*Call graph*: calls 1 internal fn (thread_list_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_search`  (lines 643–650)

```
async fn thread_search(
        &self,
        params: ThreadSearchParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for searching stored threads by text. It returns matching threads with snippets.

**Data flow**: It receives search parameters, delegates to the inner search flow, and returns paged search results.

**Call relations**: handle_initialized_client_request calls this; thread_search_response_inner performs the storage search and live-status decoration.

*Call graph*: calls 1 internal fn (thread_search_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_loaded_list`  (lines 652–659)

```
async fn thread_loaded_list(
        &self,
        params: ThreadLoadedListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for listing only threads that are currently loaded in memory. This is different from listing all saved threads.

**Data flow**: It receives cursor and limit parameters, delegates to the inner list, and returns loaded thread ids plus an optional cursor.

**Call relations**: handle_initialized_client_request calls this; thread_loaded_list_response_inner reads ids from the live thread manager.

*Call graph*: calls 1 internal fn (thread_loaded_list_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_read`  (lines 661–668)

```
async fn thread_read(
        &self,
        params: ThreadReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for reading one thread’s details, optionally including its turns.

**Data flow**: It receives a thread id and include-turns flag, delegates to read logic, and returns a full thread view.

**Call relations**: handle_initialized_client_request calls this; thread_read_response_inner parses the id and calls read_thread_view.

*Call graph*: calls 1 internal fn (thread_read_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_turns_list`  (lines 670–677)

```
async fn thread_turns_list(
        &self,
        params: ThreadTurnsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for listing a thread’s turns in pages. A turn is one user-and-assistant exchange or related unit of conversation.

**Data flow**: It receives paging and display options, delegates to the inner turn-list builder, and returns turns plus cursors.

**Call relations**: handle_initialized_client_request calls this; thread_turns_list_response_inner rebuilds turns from rollout history and live state.

*Call graph*: calls 1 internal fn (thread_turns_list_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_turns_items_list`  (lines 679–686)

```
async fn thread_turns_items_list(
        &self,
        _params: ThreadTurnsItemsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Placeholder handler for an API that is not implemented yet. It clearly reports that the method is unavailable.

**Data flow**: It ignores the request parameters and returns a method-not-found error.

**Call relations**: handle_initialized_client_request may route thread/turns/items/list here, but this function intentionally stops the request.

*Call graph*: calls 1 internal fn (method_not_found); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_shell_command`  (lines 688–696)

```
async fn thread_shell_command(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadShellCommandParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for running a user shell command inside a live thread’s local environment. A shell command is a command-line instruction.

**Data flow**: It receives a thread id and command, delegates to the inner validator and core operation submitter, and returns an empty success response.

**Call relations**: handle_initialized_client_request calls this; thread_shell_command_inner checks local environment support and submits the command.

*Call graph*: calls 1 internal fn (thread_shell_command_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::thread_approve_guardian_denied_action`  (lines 698–706)

```
async fn thread_approve_guardian_denied_action(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadApproveGuardianDeniedActionParams,
    ) -> Result<Option<ClientResponseP
```

**Purpose**: Public handler for approving an action that a Guardian policy previously denied. Guardian is a safety or permission layer.

**Data flow**: It receives a thread id and serialized denial event, delegates to the inner flow, and returns an empty success response.

**Call relations**: handle_initialized_client_request calls this; thread_approve_guardian_denied_action_inner parses the event and submits approval to the live thread.

*Call graph*: calls 1 internal fn (thread_approve_guardian_denied_action_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::conversation_summary`  (lines 708–715)

```
async fn conversation_summary(
        &self,
        params: GetConversationSummaryParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public handler for fetching a compact summary of a conversation. It is useful when a client needs metadata but not full turns.

**Data flow**: It receives either a thread id or rollout path request, delegates to the summary reader, and returns a summary object.

**Call relations**: handle_initialized_client_request calls this; get_thread_summary_response_inner reads from storage and converts the record.

*Call graph*: calls 1 internal fn (get_thread_summary_response_inner); called by 1 (handle_initialized_client_request).


##### `ThreadRequestProcessor::load_thread`  (lines 717–732)

```
async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CodexThread>), JSONRPCErrorError>
```

**Purpose**: Finds a live thread by its string id and reports friendly errors if the id is invalid or the thread is not loaded.

**Data flow**: It parses the string into a ThreadId, asks the thread manager for the live CodexThread, and returns both the parsed id and thread handle.

**Call relations**: Many live-only operations call this first, such as compaction, rollback, terminal operations, elicitations, shell commands, and Guardian approval.

*Call graph*: calls 1 internal fn (from_string); called by 9 (thread_approve_guardian_denied_action_inner, thread_background_terminals_clean_inner, thread_background_terminals_list_inner, thread_background_terminals_terminate_inner, thread_compact_start_inner, thread_decrement_elicitation_inner, thread_increment_elicitation_inner, thread_rollback_start, thread_shell_command_inner).


##### `ThreadRequestProcessor::acquire_thread_list_state_permit`  (lines 733–742)

```
async fn acquire_thread_list_state_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, JSONRPCErrorError>
```

**Purpose**: Acquires a permit that serializes operations affecting thread list state. A semaphore permit is like a ticket that limits how many tasks enter a sensitive area at once.

**Data flow**: It waits on the thread-list semaphore and returns a permit, or an internal error if the semaphore is closed.

**Call relations**: Archive, unarchive, resume, rename, and metadata update paths call this before changing state that thread/list clients observe.

*Call graph*: called by 5 (thread_archive_inner, thread_metadata_update_response_inner, thread_resume_inner, thread_set_name_response_inner, thread_unarchive_inner).


##### `ThreadRequestProcessor::set_app_server_client_info`  (lines 744–761)

```
async fn set_app_server_client_info(
        thread: &CodexThread,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorEr
```

**Purpose**: Stores the client name and version on a thread, including one compatibility flag for older Xcode clients. This lets the core adapt behavior to the connected app.

**Data flow**: It receives a live thread and optional client identity, computes whether MCP elicitations should be auto-denied, sends all of that to the thread, and returns success or an internal error.

**Call relations**: Start, resume, fork, and running-resume paths call this after they have a live thread.

*Call graph*: calls 2 internal fn (xcode_26_4_mcp_elicitations_auto_deny, set_app_server_client_info).


##### `ThreadRequestProcessor::finalize_thread_teardown`  (lines 763–774)

```
async fn finalize_thread_teardown(&self, thread_id: ThreadId)
```

**Purpose**: Cleans app-server bookkeeping after a thread is gone or no longer usable. It removes pending unload state, cancels outstanding requests, clears thread state, and removes watch entries.

**Data flow**: It receives a thread id, mutates several managers to forget or cancel state for that thread, and returns nothing.

**Call relations**: Unsubscribe, removal, connection cleanup, and resume replacement paths call this after the core thread has disappeared or been shut down.

*Call graph*: calls 2 internal fn (remove_thread_state, remove_thread); called by 4 (connection_closed, prepare_thread_for_removal, resume_running_thread, thread_unsubscribe_response_inner); 1 external calls (to_string).


##### `ThreadRequestProcessor::thread_unsubscribe_response_inner`  (lines 776–802)

```
async fn thread_unsubscribe_response_inner(
        &self,
        params: ThreadUnsubscribeParams,
        connection_id: ConnectionId,
    ) -> Result<ThreadUnsubscribeResponse, JSONRPCErrorError>
```

**Purpose**: Performs the actual unsubscribe operation for one connection and thread. It also cleans stale state if the thread is already unloaded.

**Data flow**: It parses the thread id, checks whether the live thread exists, possibly finalizes teardown, otherwise removes the connection from the thread’s subscriber set and returns a status.

**Call relations**: thread_unsubscribe calls this and wraps its status into the client response.

*Call graph*: calls 3 internal fn (finalize_thread_teardown, unsubscribe_connection_from_thread, from_string); called by 1 (thread_unsubscribe).


##### `ThreadRequestProcessor::prepare_thread_for_archive`  (lines 804–806)

```
async fn prepare_thread_for_archive(&self, thread_id: ThreadId)
```

**Purpose**: Prepares one thread to be archived by using the general removal preparation path. It names the operation as archive for logs.

**Data flow**: It receives a thread id and passes it to prepare_thread_for_removal with the archive label.

**Call relations**: thread_archive_response calls this before writing archive state to storage.

*Call graph*: calls 1 internal fn (prepare_thread_for_removal); called by 1 (thread_archive_response).


##### `ThreadRequestProcessor::prepare_thread_for_removal`  (lines 808–825)

```
async fn prepare_thread_for_removal(&self, thread_id: ThreadId, operation: &str)
```

**Purpose**: Stops a live thread before an operation removes or archives it. This avoids leaving a still-running conversation behind after storage changes.

**Data flow**: It removes the thread from the live manager, waits briefly for shutdown if it was active, logs failures or timeouts, then finalizes app-server teardown.

**Call relations**: prepare_thread_for_archive uses this, and archive flows rely on it before marking threads archived.

*Call graph*: calls 1 internal fn (finalize_thread_teardown); called by 1 (prepare_thread_for_archive); 3 external calls (error!, info!, warn!).


##### `ThreadRequestProcessor::listener_task_context`  (lines 827–839)

```
fn listener_task_context(&self) -> ListenerTaskContext
```

**Purpose**: Packages the shared handles needed by thread listener tasks. A listener task watches a live thread and forwards events to clients.

**Data flow**: It clones references to the thread manager, state manager, outgoing sender, watch manager, configuration details, and skills watcher into a small context object.

**Call relations**: ensure_conversation_listener and ensure_listener_task_running call this before delegating to the thread lifecycle module.

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

**Purpose**: Makes sure a connection is subscribed to live events for a thread. It starts or reuses the listener machinery as needed.

**Data flow**: It receives a thread id, connection id, and raw-event flag, builds a listener context, and delegates to the lifecycle helper, returning the attach result.

**Call relations**: Resume, fork, and try_attach_thread_listener use this when a client should begin receiving updates for a thread.

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

**Purpose**: Ensures the background listener task exists for an already loaded thread. This is needed before a running resume can ask the listener to send a resume response.

**Data flow**: It receives the thread id, live thread handle, and thread state, builds listener context, and delegates to the lifecycle helper.

**Call relations**: resume_running_thread calls this when rejoining a live thread.

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

**Purpose**: Validates a start request and launches the expensive start work in the background. This keeps the request handler responsive while the thread is created.

**Data flow**: It unpacks parameters, rejects incompatible sandbox and permission settings, builds config overrides and listener context, then spawns thread_start_task; errors from the task are sent through the outgoing channel.

**Call relations**: thread_start calls this; thread_start_task later creates the core thread and sends the actual response.

*Call graph*: calls 3 internal fn (request_trace, span, build_thread_config_overrides); called by 1 (thread_start); 7 external calls (clone, thread_start_task, spawn, clone, clone, clone, clone).


##### `ThreadRequestProcessor::drain_background_tasks`  (lines 969–977)

```
async fn drain_background_tasks(&self)
```

**Purpose**: Waits for this processor’s background tasks to finish during shutdown. It prevents tasks from being abandoned silently.

**Data flow**: It closes the task tracker, waits up to ten seconds, and logs a warning if tasks do not stop in time.

**Call relations**: Server shutdown code calls this through the processor wrapper when tearing down the app server.

*Call graph*: called by 1 (drain_background_tasks); 5 external calls (from_secs, close, wait, timeout, warn!).


##### `ThreadRequestProcessor::clear_all_thread_listeners`  (lines 979–981)

```
async fn clear_all_thread_listeners(&self)
```

**Purpose**: Drops all recorded listener subscriptions. This is used when the server needs a clean listener state, usually during shutdown or reset.

**Data flow**: It calls the thread state manager to clear all listeners and returns nothing.

**Call relations**: Higher-level teardown code calls this method on the processor.

*Call graph*: calls 1 internal fn (clear_all_listeners); called by 1 (clear_all_thread_listeners).


##### `ThreadRequestProcessor::shutdown_threads`  (lines 983–994)

```
async fn shutdown_threads(&self)
```

**Purpose**: Asks the core thread manager to shut down all live threads, with a timeout. It logs any threads that could not be shut down cleanly.

**Data flow**: It requests bounded shutdown, receives a report of failed or timed-out thread ids, and writes warnings for those cases.

**Call relations**: Higher-level server shutdown code calls this when stopping the app server.

*Call graph*: called by 1 (shutdown_threads); 2 external calls (from_secs, warn!).


##### `ThreadRequestProcessor::request_trace_context`  (lines 996–1001)

```
async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<codex_protocol::protocol::W3cTraceContext>
```

**Purpose**: Looks up distributed tracing information for a request. Tracing information helps connect logs and timing across async work.

**Data flow**: It receives a request id, asks the outgoing message sender for any saved trace context, and returns it if present.

**Call relations**: submit_core_op, resume, and fork use this when submitting work to the core so downstream activity keeps the same trace.

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

**Purpose**: Submits an operation to a live Codex thread while preserving request trace context. It is the common doorway for thread commands like compact or shell command.

**Data flow**: It receives a request id, live thread, and core operation, fetches trace context, submits the operation to the thread, and returns the core submission result.

**Call relations**: Rollback, compact, background-terminal cleanup, shell command, and Guardian approval handlers all use this helper.

*Call graph*: calls 2 internal fn (request_trace_context, submit_with_trace); called by 5 (thread_approve_guardian_denied_action_inner, thread_background_terminals_clean_inner, thread_compact_start_inner, thread_rollback_start, thread_shell_command_inner).


##### `ThreadRequestProcessor::thread_start_task`  (lines 1015–1275)

```
async fn thread_start_task(
        listener_task_context: ListenerTaskContext,
        config_manager: ConfigManager,
        request_id: ConnectionRequestId,
        app_server_client_name: Option<S
```

**Purpose**: Does the full work of creating a new thread and sending the start response. This includes loading configuration, validating tools, creating the core thread, attaching a listener, and notifying clients.

**Data flow**: It receives prepared context, request data, config overrides, tools, capability roots, environment choices, and trace context; it loads config, may persist project trust, validates tools, starts the thread, builds the API thread object, sends the response, and broadcasts ThreadStarted.

**Call relations**: thread_start_inner spawns this as a background task so thread startup can run asynchronously without blocking the dispatcher.

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

**Purpose**: Converts client-supplied thread settings into the core configuration override structure. This keeps request parsing separate from config loading.

**Data flow**: It receives optional model, provider, working directory, workspace roots, approval, sandbox, permissions, instructions, and personality settings, translates app-server enum values to core values, and returns ConfigOverrides.

**Call relations**: Start, resume, and fork paths call this before asking ConfigManager to load the effective configuration.

*Call graph*: called by 3 (thread_fork_inner, thread_resume_inner, thread_start_inner); 1 external calls (default).


##### `ThreadRequestProcessor::thread_archive_inner`  (lines 1314–1320)

```
async fn thread_archive_inner(
        &self,
        params: ThreadArchiveParams,
    ) -> Result<(ThreadArchiveResponse, Vec<String>), JSONRPCErrorError>
```

**Purpose**: Serializes and starts the archive operation. It obtains the thread-list state permit before changing stored archive state.

**Data flow**: It acquires the permit, then calls thread_archive_response and returns its response plus archived ids.

**Call relations**: thread_archive calls this before sending the client response and archive notifications.

*Call graph*: calls 2 internal fn (acquire_thread_list_state_permit, thread_archive_response); called by 1 (thread_archive).


##### `ThreadRequestProcessor::thread_archive_response`  (lines 1322–1412)

```
async fn thread_archive_response(
        &self,
        params: ThreadArchiveParams,
    ) -> Result<(ThreadArchiveResponse, Vec<String>), JSONRPCErrorError>
```

**Purpose**: Archives one thread and eligible spawned descendants. It shuts down live versions before changing the store.

**Data flow**: It parses the target id, finds descendants from state DB when available, checks which records are not already archived, prepares each for archive, writes archive markers, and returns the archived ids.

**Call relations**: thread_archive_inner calls this after acquiring the state permit; it uses prepare_thread_for_archive and state_db_spawn_subtree_thread_ids.

*Call graph*: calls 4 internal fn (prepare_thread_for_archive, state_db_spawn_subtree_thread_ids, thread_store_archive_error, from_string); called by 1 (thread_archive_inner); 2 external calls (new, warn!).


##### `ThreadRequestProcessor::state_db_spawn_subtree_thread_ids`  (lines 1414–1437)

```
async fn state_db_spawn_subtree_thread_ids(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<ThreadId>, JSONRPCErrorError>
```

**Purpose**: Builds the list of a thread plus spawned descendant thread ids using the state database when available. Spawned descendants are child threads created by agents.

**Data flow**: It starts with the given id, optionally asks the state DB for descendants, removes duplicates, and returns the resulting list.

**Call relations**: thread_archive_response calls this so archiving a parent can also archive its spawned subtree.

*Call graph*: called by 1 (thread_archive_response); 2 external calls (from, vec!).


##### `ThreadRequestProcessor::thread_increment_elicitation_inner`  (lines 1439–1456)

```
async fn thread_increment_elicitation_inner(
        &self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<ThreadIncrementElicitationResponse, JSONRPCErrorError>
```

**Purpose**: Increments the live thread’s count of active out-of-band elicitations. This count tells clients whether the thread is paused for side input.

**Data flow**: It loads the live thread, calls its increment method, and returns the new count and paused flag.

**Call relations**: thread_increment_elicitation delegates to this after request routing.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_increment_elicitation).


##### `ThreadRequestProcessor::thread_decrement_elicitation_inner`  (lines 1458–1476)

```
async fn thread_decrement_elicitation_inner(
        &self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<ThreadDecrementElicitationResponse, JSONRPCErrorError>
```

**Purpose**: Decrements the live thread’s out-of-band elicitation count, with friendly errors for invalid decrement requests.

**Data flow**: It loads the live thread, calls its decrement method, maps core errors into JSON-RPC errors, and returns the new count and paused flag.

**Call relations**: thread_decrement_elicitation delegates to this after request routing.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_decrement_elicitation).


##### `ThreadRequestProcessor::thread_set_name_response_inner`  (lines 1478–1510)

```
async fn thread_set_name_response_inner(
        &self,
        params: ThreadSetNameParams,
    ) -> Result<(ThreadSetNameResponse, Option<ThreadNameUpdatedNotification>), JSONRPCErrorError>
```

**Purpose**: Validates and stores a new thread name. It returns both the API response and the notification payload to send if the update succeeds.

**Data flow**: It parses the thread id, normalizes the name, rejects an empty name, acquires the state permit, writes a metadata patch through the thread manager, and returns success plus a name-updated notification.

**Call relations**: thread_set_name calls this, then sends the response and notification.

*Call graph*: calls 3 internal fn (acquire_thread_list_state_permit, normalize_thread_name, from_string); called by 1 (thread_set_name); 1 external calls (default).


##### `ThreadRequestProcessor::thread_memory_mode_set_response_inner`  (lines 1512–1533)

```
async fn thread_memory_mode_set_response_inner(
        &self,
        params: ThreadMemoryModeSetParams,
    ) -> Result<ThreadMemoryModeSetResponse, JSONRPCErrorError>
```

**Purpose**: Stores a thread’s new memory mode in metadata. The response is empty because the requested change is the whole result.

**Data flow**: It parses the thread id, converts the app-server mode to the core mode, writes a metadata patch, and returns success.

**Call relations**: thread_memory_mode_set calls this for the public request.

*Call graph*: calls 1 internal fn (from_string); called by 1 (thread_memory_mode_set); 1 external calls (default).


##### `ThreadRequestProcessor::memory_reset_response_inner`  (lines 1535–1559)

```
async fn memory_reset_response_inner(&self) -> Result<MemoryResetResponse, JSONRPCErrorError>
```

**Purpose**: Clears all saved memory data from both the state database and memory directories. This is a destructive reset used when the user wants memory wiped.

**Data flow**: It requires a state DB handle, clears memory rows, clears memory-root directory contents under the Codex home directory, and returns success or an internal error.

**Call relations**: memory_reset calls this when the client requests a global memory reset.

*Call graph*: called by 1 (memory_reset).


##### `ThreadRequestProcessor::thread_metadata_update_response_inner`  (lines 1561–1624)

```
async fn thread_metadata_update_response_inner(
        &self,
        params: ThreadMetadataUpdateParams,
    ) -> Result<ThreadMetadataUpdateResponse, JSONRPCErrorError>
```

**Purpose**: Updates thread metadata, currently Git fields, and returns a refreshed thread view. It lets clients attach repository state to saved conversations.

**Data flow**: It parses the thread id, validates that at least one Git field is present, normalizes each field, writes the metadata patch under the state permit, converts the stored result into an API thread, adds live session/status/name details, and returns it.

**Call relations**: thread_metadata_update calls this; it uses normalize_thread_metadata_git_field, thread_from_stored_thread, and attach_thread_name.

*Call graph*: calls 5 internal fn (acquire_thread_list_state_permit, attach_thread_name, thread_from_stored_thread, loaded_status_for_thread, from_string); called by 1 (thread_metadata_update); 2 external calls (default, normalize_thread_metadata_git_field).


##### `ThreadRequestProcessor::normalize_thread_metadata_git_field`  (lines 1626–1641)

```
fn normalize_thread_metadata_git_field(
        value: Option<Option<String>>,
        name: &str,
    ) -> Result<Option<Option<String>>, JSONRPCErrorError>
```

**Purpose**: Normalizes one optional Git metadata field. It trims strings and rejects fields that become empty.

**Data flow**: It receives a nested option that can mean unchanged, clear the field, or set a string; it trims set strings, errors on empty values, and returns the normalized patch value.

**Call relations**: thread_metadata_update_response_inner calls this for SHA, branch, and origin URL fields.

*Call graph*: 1 external calls (format!).


##### `ThreadRequestProcessor::thread_unarchive_inner`  (lines 1643–1650)

```
async fn thread_unarchive_inner(
        &self,
        params: ThreadUnarchiveParams,
    ) -> Result<(ThreadUnarchiveResponse, ThreadUnarchivedNotification), JSONRPCErrorError>
```

**Purpose**: Serializes the unarchive operation and builds the notification payload. It uses the thread-list permit because visible list state changes.

**Data flow**: It acquires the permit, calls thread_unarchive_response, and wraps the returned id into a ThreadUnarchived notification.

**Call relations**: thread_unarchive calls this before sending the response and notification.

*Call graph*: calls 2 internal fn (acquire_thread_list_state_permit, thread_unarchive_response); called by 1 (thread_unarchive).


##### `ThreadRequestProcessor::thread_unarchive_response`  (lines 1652–1677)

```
async fn thread_unarchive_response(
        &self,
        params: ThreadUnarchiveParams,
    ) -> Result<(ThreadUnarchiveResponse, String), JSONRPCErrorError>
```

**Purpose**: Marks a stored thread as unarchived and returns its refreshed API representation.

**Data flow**: It parses the thread id, asks the store to unarchive it, converts the stored record into an API thread, applies live status and saved name, and returns the response plus thread id string.

**Call relations**: thread_unarchive_inner calls this after acquiring the permit.

*Call graph*: calls 4 internal fn (attach_thread_name, thread_from_stored_thread, loaded_status_for_thread, from_string); called by 1 (thread_unarchive_inner).


##### `ThreadRequestProcessor::thread_rollback_inner`  (lines 1679–1685)

```
async fn thread_rollback_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Small wrapper that starts rollback. It exists to match the public handler shape.

**Data flow**: It receives request id and rollback parameters, forwards them to thread_rollback_start, and returns that result.

**Call relations**: thread_rollback calls this; thread_rollback_start contains the validation and core submission.

*Call graph*: calls 1 internal fn (thread_rollback_start); called by 1 (thread_rollback).


##### `ThreadRequestProcessor::thread_rollback_start`  (lines 1687–1737)

```
async fn thread_rollback_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts a rollback on a live thread and records that a rollback response is pending. It prevents two rollbacks from racing on the same thread.

**Data flow**: It validates numTurns, loads the live thread, checks and sets pending rollback state under a lock, submits the core rollback operation, and clears pending state if submission fails.

**Call relations**: thread_rollback_inner calls this; later thread events are expected to complete the pending rollback request.

*Call graph*: calls 3 internal fn (load_thread, submit_core_op, thread_state); called by 1 (thread_rollback_inner); 2 external calls (clone, format!).


##### `ThreadRequestProcessor::thread_compact_start_inner`  (lines 1739–1751)

```
async fn thread_compact_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadCompactStartParams,
    ) -> Result<ThreadCompactStartResponse, JSONRPCErrorError>
```

**Purpose**: Submits a compaction request to a live thread. It returns once the core accepts the operation.

**Data flow**: It parses and loads the thread, submits Op::Compact with trace context, and returns an empty response or an internal error.

**Call relations**: thread_compact_start calls this from the public request path.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_compact_start).


##### `ThreadRequestProcessor::thread_background_terminals_clean_inner`  (lines 1753–1767)

```
async fn thread_background_terminals_clean_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadBackgroundTerminalsCleanParams,
    ) -> Result<ThreadBackgroundTermina
```

**Purpose**: Asks a live thread to remove stale background terminal entries. This is a core operation rather than direct list mutation.

**Data flow**: It loads the thread, submits Op::CleanBackgroundTerminals, and returns an empty response on successful submission.

**Call relations**: thread_background_terminals_clean calls this.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_background_terminals_clean).


##### `ThreadRequestProcessor::thread_background_terminals_list_inner`  (lines 1769–1798)

```
async fn thread_background_terminals_list_inner(
        &self,
        params: ThreadBackgroundTerminalsListParams,
    ) -> Result<ThreadBackgroundTerminalsListResponse, JSONRPCErrorError>
```

**Purpose**: Reads the live thread’s background terminal list and pages it for the client.

**Data flow**: It loads the thread, maps core terminal records into app-server terminal objects, paginates them by cursor and limit, and returns data plus next cursor.

**Call relations**: thread_background_terminals_list calls this; paginate_background_terminals does the page slicing.

*Call graph*: calls 2 internal fn (load_thread, paginate_background_terminals); called by 1 (thread_background_terminals_list).


##### `ThreadRequestProcessor::thread_background_terminals_terminate_inner`  (lines 1800–1815)

```
async fn thread_background_terminals_terminate_inner(
        &self,
        params: ThreadBackgroundTerminalsTerminateParams,
    ) -> Result<ThreadBackgroundTerminalsTerminateResponse, JSONRPCErrorE
```

**Purpose**: Terminates one background terminal process by process id.

**Data flow**: It parses the process id as a number, loads the live thread, asks the thread to terminate that process, and returns whether it succeeded.

**Call relations**: thread_background_terminals_terminate calls this.

*Call graph*: calls 1 internal fn (load_thread); called by 1 (thread_background_terminals_terminate).


##### `ThreadRequestProcessor::thread_shell_command_inner`  (lines 1817–1847)

```
async fn thread_shell_command_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadShellCommandParams,
    ) -> Result<ThreadShellCommandResponse, JSONRPCErrorError>
```

**Purpose**: Validates and submits a user shell command to a live thread. It only works when a local environment is configured.

**Data flow**: It trims the command, rejects empty commands, checks for local environment support, loads the thread, submits Op::RunUserShellCommand, and returns success.

**Call relations**: thread_shell_command calls this; submit_core_op handles trace-aware submission.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_shell_command).


##### `ThreadRequestProcessor::thread_approve_guardian_denied_action_inner`  (lines 1849–1867)

```
async fn thread_approve_guardian_denied_action_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadApproveGuardianDeniedActionParams,
    ) -> Result<ThreadApproveGua
```

**Purpose**: Submits approval for a previously denied Guardian action to a live thread.

**Data flow**: It parses the event JSON into the expected core event type, loads the thread, submits Op::ApproveGuardianDeniedAction, and returns success.

**Call relations**: thread_approve_guardian_denied_action calls this.

*Call graph*: calls 2 internal fn (load_thread, submit_core_op); called by 1 (thread_approve_guardian_denied_action); 1 external calls (from_value).


##### `ThreadRequestProcessor::thread_list_response_inner`  (lines 1869–1955)

```
async fn thread_list_response_inner(
        &self,
        params: ThreadListParams,
    ) -> Result<ThreadListResponse, JSONRPCErrorError>
```

**Purpose**: Builds the response for thread/list, including filters, sorting, pagination, conversion to API threads, and live status decoration.

**Data flow**: It normalizes filter parameters, clamps page size, maps sort options, calls list_threads_common, computes a backwards cursor, converts stored threads, fetches live statuses, and returns the page.

**Call relations**: thread_list calls this; list_threads_common performs the repeated storage paging and filtering.

*Call graph*: calls 4 internal fn (list_threads_common, normalize_thread_list_cwd_filters, thread_from_stored_thread, loaded_statuses_for_threads); called by 1 (thread_list); 1 external calls (with_capacity).


##### `ThreadRequestProcessor::thread_search_response_inner`  (lines 1957–2080)

```
async fn thread_search_response_inner(
        &self,
        params: ThreadSearchParams,
    ) -> Result<ThreadSearchResponse, JSONRPCErrorError>
```

**Purpose**: Searches stored threads by text and returns matching threads with snippets. It also applies source filters that may need app-side interpretation.

**Data flow**: It validates a non-empty search term, clamps page size, repeatedly asks the store for search pages until enough matches survive filtering, converts each stored record, adds live statuses, and returns search results with cursors.

**Call relations**: thread_search calls this from the public request path.

*Call graph*: calls 2 internal fn (thread_from_stored_thread, loaded_statuses_for_threads); called by 1 (thread_search); 1 external calls (with_capacity).


##### `ThreadRequestProcessor::thread_loaded_list_response_inner`  (lines 2082–2127)

```
async fn thread_loaded_list_response_inner(
        &self,
        params: ThreadLoadedListParams,
    ) -> Result<ThreadLoadedListResponse, JSONRPCErrorError>
```

**Purpose**: Lists currently loaded thread ids in sorted pages. This is useful for clients or diagnostics that care about memory-resident threads.

**Data flow**: It gets live thread ids, sorts them, applies a cursor and limit, and returns the selected ids plus a next cursor when more remain.

**Call relations**: thread_loaded_list calls this.

*Call graph*: calls 1 internal fn (from_string); called by 1 (thread_loaded_list); 1 external calls (format!).


##### `ThreadRequestProcessor::thread_read_response_inner`  (lines 2129–2146)

```
async fn thread_read_response_inner(
        &self,
        params: ThreadReadParams,
    ) -> Result<ThreadReadResponse, JSONRPCErrorError>
```

**Purpose**: Parses a thread/read request and returns a detailed thread view.

**Data flow**: It parses the thread id, calls read_thread_view with the include-turns flag, maps read errors to JSON-RPC errors, and wraps the resulting thread.

**Call relations**: thread_read calls this; read_thread_view decides whether to use persisted data, live data, or both.

*Call graph*: calls 2 internal fn (read_thread_view, from_string); called by 1 (thread_read).


##### `ThreadRequestProcessor::read_thread_view`  (lines 2149–2220)

```
async fn read_thread_view(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Thread, ThreadReadViewError>
```

**Purpose**: Builds the best available API view for one thread from stored metadata, stored history, and live state. It handles cases where a thread is loaded but not yet fully materialized on disk.

**Data flow**: It checks whether the thread is loaded, chooses persisted or live reading based on includeTurns and availability, merges status and stale-turn information, and returns a Thread or a read-specific error.

**Call relations**: thread_read_response_inner calls this; it delegates to load_persisted_thread_for_read and load_live_thread_view.

*Call graph*: calls 3 internal fn (load_live_thread_view, load_persisted_thread_for_read, loaded_status_for_thread); called by 1 (thread_read_response_inner); 3 external calls (InvalidRequest, format!, matches!).


##### `ThreadRequestProcessor::load_persisted_thread_for_read`  (lines 2222–2260)

```
async fn load_persisted_thread_for_read(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Option<Thread>, ThreadReadViewError>
```

**Purpose**: Attempts to read a thread from persistent storage for thread/read. It treats missing rollout data as “not available” rather than always fatal.

**Data flow**: It asks the thread store for metadata and optionally history, converts the stored record to an API thread, optionally builds turns from history, and returns Some thread, None for missing materialization, or an error.

**Call relations**: read_thread_view calls this before falling back to live thread snapshots.

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

**Purpose**: Builds a thread/read view from a live thread and optional persisted metadata. It is used when live state is newer than storage or storage is not ready.

**Data flow**: It reads the live config snapshot, rejects includeTurns for ephemeral threads, builds a fallback thread from live data, merges persisted fields when present, then applies stored name/history fields.

**Call relations**: read_thread_view calls this when a thread is loaded and live data is needed.

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

**Purpose**: Adds store-backed details to a live thread/read view. This includes the saved name and, when requested, reconstructed turns.

**Data flow**: It attaches a saved thread name, optionally loads live history from the thread store path, converts rollout items into API turns, and mutates the Thread object.

**Call relations**: load_live_thread_view calls this after constructing the base live thread view.

*Call graph*: calls 2 internal fn (attach_thread_name, load_history); called by 1 (load_live_thread_view).


##### `ThreadRequestProcessor::thread_turns_list_response_inner`  (lines 2313–2365)

```
async fn thread_turns_list_response_inner(
        &self,
        params: ThreadTurnsListParams,
    ) -> Result<ThreadTurnsListResponse, JSONRPCErrorError>
```

**Purpose**: Builds a paged list of turns for one thread, merging stored history with the current live turn when needed.

**Data flow**: It parses the thread id, loads rollout history, checks live running status, optionally gets an active-turn snapshot from thread state, then builds a paged response according to cursor, limit, sort direction, and item view.

**Call relations**: thread_turns_list calls this; build_thread_turns_page_response reconstructs and paginates the turns.

*Call graph*: calls 5 internal fn (load_thread_turns_list_history, build_thread_turns_page_response, thread_state, loaded_status_for_thread, from_string); called by 1 (thread_turns_list); 1 external calls (matches!).


##### `ThreadRequestProcessor::load_thread_turns_list_history`  (lines 2367–2422)

```
async fn load_thread_turns_list_history(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<RolloutItem>, ThreadReadViewError>
```

**Purpose**: Loads the rollout items needed to reconstruct a thread’s turns. It falls back to a live thread history load when the stored rollout is not yet materialized.

**Data flow**: It first tries the thread store with history; if storage says the thread is missing or not materialized, it looks for a live thread, rejects ephemeral threads, and loads history from the live thread.

**Call relations**: thread_turns_list_response_inner calls this before building the page.

*Call graph*: called by 1 (thread_turns_list_response_inner); 3 external calls (Internal, InvalidRequest, format!).


##### `ThreadRequestProcessor::thread_created_receiver`  (lines 2424–2426)

```
fn thread_created_receiver(&self) -> broadcast::Receiver<ThreadId>
```

**Purpose**: Returns a subscription receiver for newly created thread ids. A receiver lets other parts of the server listen for thread creation events.

**Data flow**: It asks the thread manager for its thread-created broadcast receiver and returns it.

**Call relations**: A higher-level processor method exposes this to code that wants to react to new threads.

*Call graph*: called by 1 (thread_created_receiver).


##### `ThreadRequestProcessor::connection_initialized`  (lines 2428–2436)

```
async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        capabilities: ConnectionCapabilities,
    )
```

**Purpose**: Records that a client connection has finished initialization and what capabilities it supports.

**Data flow**: It receives a connection id and capability set, forwards them to the thread state manager, and returns nothing.

**Call relations**: Connection-handling code calls this after initialization and before thread listeners rely on capability information.

*Call graph*: calls 1 internal fn (connection_initialized); called by 2 (connection_initialized, handle_client_request).


##### `ThreadRequestProcessor::connection_closed`  (lines 2438–2451)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Cleans up thread subscriptions for a closed client connection. It also reconciles stale thread state for threads no longer loaded.

**Data flow**: It removes the connection from the thread state manager, receives affected thread ids, and for any id no longer live, finalizes thread teardown.

**Call relations**: Connection teardown code calls this when a client disconnects.

*Call graph*: calls 2 internal fn (finalize_thread_teardown, remove_connection); called by 1 (connection_closed).


##### `ThreadRequestProcessor::subscribe_running_assistant_turn_count`  (lines 2453–2455)

```
fn subscribe_running_assistant_turn_count(&self) -> watch::Receiver<usize>
```

**Purpose**: Returns a watch receiver for the number of running assistant turns. A watch receiver gives subscribers the latest value whenever it changes.

**Data flow**: It delegates to the thread watch manager and returns the receiver.

**Call relations**: Higher-level server code exposes this metric to interested components.

*Call graph*: calls 1 internal fn (subscribe_running_turn_count); called by 1 (subscribe_running_assistant_turn_count).


##### `ThreadRequestProcessor::try_attach_thread_listener`  (lines 2458–2493)

```
async fn try_attach_thread_listener(
        &self,
        thread_id: ThreadId,
        connection_ids: Vec<ConnectionId>,
    )
```

**Purpose**: Best-effort helper that subscribes initialized connections to a thread. It is used when a thread appears and clients should start receiving updates.

**Data flow**: It optionally reads live config, updates the watch manager with a loaded-thread view, inherits raw-event settings from a parent thread, then attempts listener attachment for each connection id.

**Call relations**: External orchestration calls this; it uses ensure_conversation_listener for each connection.

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

**Purpose**: Handles the complete resume flow for both already-running and cold-stored threads. It validates inputs, loads history, configures a new core thread if needed, attaches listeners, and sends the resume response.

**Data flow**: It checks pending unloads and invalid sandbox/permission combinations, may rejoin a running thread, otherwise reads history from request or storage, applies persisted metadata, loads config, resumes the core thread, builds the API thread and optional initial turns page, sends response and token-usage updates, and resumes goal processing.

**Call relations**: thread_resume calls this; it coordinates many helpers including resume_running_thread, resume_thread_from_rollout, build_thread_config_overrides, and load_thread_from_resume_source_or_send_internal.

*Call graph*: calls 16 internal fn (load_for_cwd, emit_resume_goal_snapshot_and_continue, acquire_thread_list_state_permit, build_thread_config_overrides, ensure_conversation_listener, load_and_apply_persisted_resume_metadata, load_thread_from_resume_source_or_send_internal, request_trace_context, resume_running_thread, resume_thread_from_history (+6 more)); called by 1 (thread_resume); 2 external calls (set_app_server_client_info, format!).


##### `ThreadRequestProcessor::load_and_apply_persisted_resume_metadata`  (lines 2807–2824)

```
async fn load_and_apply_persisted_resume_metadata(
        &self,
        thread_history: &InitialHistory,
        request_overrides: &mut Option<HashMap<String, serde_json::Value>>,
        typesafe_
```

**Purpose**: Loads saved metadata for a resumed thread and applies model-related defaults when appropriate.

**Data flow**: It checks that the initial history is a resumed history, reads the thread metadata from the state DB if available, merges it into request/config overrides, and returns the metadata if found.

**Call relations**: thread_resume_inner calls this before loading the effective configuration for a cold resume.

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

**Purpose**: Handles the special case where a resume request targets a thread that is already loaded. It either delegates the response to the running listener or reports that no running thread handled it.

**Data flow**: It identifies any live thread by id or rollout path, validates stale path and ignored override situations, may shut down an idle cached thread so cold resume can replace it, ensures the listener is running, builds summary and history payloads, and sends a command to the listener to answer the resume request.

**Call relations**: thread_resume_inner calls this before cold resume; it uses collect_resume_override_mismatches, ensure_listener_task_running, read_stored_thread_for_resume, and stored_thread_to_api_thread.

*Call graph*: calls 10 internal fn (pending_resume_goal_state, ensure_listener_task_running, finalize_thread_teardown, read_stored_thread_for_resume, stored_thread_to_api_thread, collect_resume_override_mismatches, subscribed_connection_ids, thread_state, loaded_status_for_thread, from_string); called by 1 (thread_resume_inner); 10 external calls (new, set_app_server_client_info, clone, NotRunning, SendThreadResumeResponse, format!, matches!, paths_match_after_normalization, warn!, warn!).


##### `ThreadRequestProcessor::resume_thread_from_history`  (lines 3014–3028)

```
async fn resume_thread_from_history(
        &self,
        history: &[ResponseItem],
    ) -> Result<InitialHistory, JSONRPCErrorError>
```

**Purpose**: Converts client-provided response history into initial history for a fork-like resume. It rejects empty history.

**Data flow**: It receives response items, checks that the slice is not empty, wraps each as a rollout item, and returns InitialHistory::Forked.

**Call relations**: thread_resume_inner calls this when the resume request includes inline history.

*Call graph*: called by 1 (thread_resume_inner); 3 external calls (is_empty, iter, Forked).


##### `ThreadRequestProcessor::resume_thread_from_rollout`  (lines 3031–3043)

```
async fn resume_thread_from_rollout(
        &self,
        thread_id: &str,
        path: Option<&PathBuf>,
    ) -> Result<(InitialHistory, StoredThread), JSONRPCErrorError>
```

**Purpose**: Loads a stored thread and converts its rollout history into initial history for resume.

**Data flow**: It reads the stored thread by id or path, converts it to InitialHistory::Resumed, and returns both the initial history and the stored source thread.

**Call relations**: thread_resume_inner calls this when no inline history or running-thread probe provides the source.

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

**Purpose**: Reads a stored thread by rollout path or thread id for resume or fork, while rejecting archived threads.

**Data flow**: It chooses path-based or id-based store lookup, requests optional history, maps storage errors into resume-friendly errors, checks archived_at, and returns the stored thread.

**Call relations**: resume_running_thread, resume_thread_from_rollout, and thread_fork_inner use this to obtain the source conversation.

*Call graph*: calls 1 internal fn (from_string); called by 3 (resume_running_thread, resume_thread_from_rollout, thread_fork_inner); 1 external calls (format!).


##### `ThreadRequestProcessor::stored_thread_to_initial_history`  (lines 3086–3105)

```
async fn stored_thread_to_initial_history(
        &self,
        stored_thread: &StoredThread,
    ) -> Result<InitialHistory, JSONRPCErrorError>
```

**Purpose**: Converts a stored thread with history into the core InitialHistory form used to resume a conversation.

**Data flow**: It reads the stored history items, errors if history was not included, and returns InitialHistory::Resumed with the original conversation id and rollout path.

**Call relations**: resume_thread_from_rollout and thread_resume_inner use this after reading stored thread history.

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

**Purpose**: Converts a stored thread record into the app-server Thread object, optionally filling its turns from stored history.

**Data flow**: It calls thread_from_stored_thread, and if include_turns is true and history is present, populates the thread’s turns from rollout items.

**Call relations**: resume_running_thread and thread_fork_inner use this when they need a client-facing thread summary from storage.

*Call graph*: calls 1 internal fn (thread_from_stored_thread); called by 2 (resume_running_thread, thread_fork_inner).


##### `ThreadRequestProcessor::read_stored_thread_for_new_fork`  (lines 3125–3138)

```
async fn read_stored_thread_for_new_fork(
        &self,
        thread_id: ThreadId,
        include_history: bool,
    ) -> Result<StoredThread, JSONRPCErrorError>
```

**Purpose**: Reads the newly created fork thread from storage. This is used when the fork has already materialized its own rollout file.

**Data flow**: It asks the thread store for the given id, includes archived records and optionally history, maps errors, and returns the stored thread.

**Call relations**: thread_fork_inner calls this after creating a persistent fork.

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

**Purpose**: Builds the Thread object returned by a cold resume response. It prefers stored metadata for resumed threads and builds a fresh snapshot for forked-history resumes.

**Data flow**: It receives the new live thread id, live core thread, initial history, rollout path, optional stored source, and include-turns flag; it builds or reloads metadata, fixes id/session/path, optionally populates turns, attaches the saved name, and returns the Thread or an internal-error string.

**Call relations**: thread_resume_inner calls this after the core has resumed the thread.

*Call graph*: calls 7 internal fn (attach_thread_name, build_thread_from_snapshot, preview_from_rollout_items, thread_from_stored_thread, config_snapshot, session_configured, get_rollout_items); called by 1 (thread_resume_inner); 4 external calls (into, to_path_buf, format!, to_string).


##### `ThreadRequestProcessor::attach_thread_name`  (lines 3239–3254)

```
async fn attach_thread_name(&self, thread_id: ThreadId, thread: &mut Thread)
```

**Purpose**: Adds a saved display name to a Thread object when storage has one. It avoids duplicating the preview as the name.

**Data flow**: It reads stored metadata without history, trims the saved title, and if the title is non-empty and different from preview, mutates the Thread name.

**Call relations**: Read, resume, metadata update, and unarchive flows call this before returning thread objects.

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

**Purpose**: Creates a new thread by copying another thread’s history. It supports changing configuration, making the fork ephemeral, and optionally excluding turns from the response.

**Data flow**: It validates settings, reads the source stored thread and history, prepares config overrides, loads config, asks the thread manager to fork, sets client info, optionally inherits the source name, attaches a listener, builds a response thread from storage or live snapshot, sends the response, sends restored token usage when needed, and broadcasts ThreadStarted.

**Call relations**: thread_fork calls this; it uses read_stored_thread_for_resume, build_thread_config_overrides, read_stored_thread_for_new_fork, stored_thread_to_api_thread, and ensure_conversation_listener.

*Call graph*: calls 12 internal fn (load_for_cwd, build_thread_config_overrides, ensure_conversation_listener, read_stored_thread_for_new_fork, read_stored_thread_for_resume, request_trace_context, stored_thread_to_api_thread, build_thread_from_snapshot, preview_from_rollout_items, set_thread_name_from_title (+2 more)); called by 1 (thread_fork); 7 external calls (default, set_app_server_client_info, ThreadStarted, cfg!, from_config, Resumed, json!).


##### `ThreadRequestProcessor::get_thread_summary_response_inner`  (lines 3521–3561)

```
async fn get_thread_summary_response_inner(
        &self,
        params: GetConversationSummaryParams,
    ) -> Result<GetConversationSummaryResponse, JSONRPCErrorError>
```

**Purpose**: Reads a compact conversation summary by thread id or rollout path.

**Data flow**: It chooses the appropriate store lookup, verifies rollout-path lookup is supported by the local store, maps read errors, converts the stored thread into a ConversationSummary, and returns it.

**Call relations**: conversation_summary calls this for client summary requests.

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

**Purpose**: Shared paging and filtering engine for thread/list. It repeatedly asks storage for pages until enough client-visible items pass filters.

**Data flow**: It receives page size, cursor, sort settings, and filters; it chooses default model-provider and source filters, loops through store pages, applies extra source and path filtering, protects against repeated cursors, and returns items plus next cursor.

**Call relations**: thread_list_response_inner calls this as its storage-facing workhorse.

*Call graph*: called by 1 (thread_list_response_inner); 3 external calls (new, with_capacity, vec!).


##### `xcode_26_4_mcp_elicitations_auto_deny`  (lines 3676–3685)

```
fn xcode_26_4_mcp_elicitations_auto_deny(
    client_name: Option<&str>,
    client_version: Option<&str>,
) -> bool
```

**Purpose**: Implements a temporary compatibility rule for Xcode 26.4 clients. Those clients shipped before MCP elicitation requests were visible, so the server auto-denies them.

**Data flow**: It receives optional client name and version and returns true only for client name Xcode with a version starting 26.4.

**Call relations**: set_app_server_client_info calls this before storing client info on a thread.

*Call graph*: called by 1 (set_app_server_client_info).


##### `thread_backwards_cursor_for_sort_key`  (lines 3690–3706)

```
fn thread_backwards_cursor_for_sort_key(
    thread: &StoredThread,
    sort_key: StoreThreadSortKey,
    sort_direction: SortDirection,
) -> Option<String>
```

**Purpose**: Creates a cursor for paging in the opposite direction through thread lists. It nudges the timestamp by one millisecond so the anchor item is included correctly.

**Data flow**: It receives a stored thread, sort key, and direction, chooses the relevant timestamp, adjusts it forward or backward, formats it as an RFC3339 timestamp string, and returns it.

**Call relations**: Thread list and search response builders use it when computing backwards cursors.

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

**Purpose**: Slices a full turn list into one page according to cursor, limit, and sort direction.

**Data flow**: It parses the optional cursor, validates the anchor turn exists, orders turns ascending or descending, removes turns before or after the anchor, truncates to page size, and returns the selected turns plus next and backwards cursors.

**Call relations**: build_thread_turns_page_response calls this after reconstructing and trimming each turn’s item view.

*Call graph*: called by 1 (build_thread_turns_page_response); 1 external calls (new).


##### `serialize_thread_turns_cursor`  (lines 3800–3809)

```
fn serialize_thread_turns_cursor(
    turn_id: &str,
    include_anchor: bool,
) -> Result<String, JSONRPCErrorError>
```

**Purpose**: Encodes a turn cursor as JSON text. The cursor stores the anchor turn id and whether the anchor should be included.

**Data flow**: It receives a turn id and include-anchor flag, serializes them into a JSON string, and returns that string or an internal serialization error.

**Call relations**: paginate_thread_turns uses this to produce next and backwards cursors.

*Call graph*: 1 external calls (to_string).


##### `parse_thread_turns_cursor`  (lines 3811–3813)

```
fn parse_thread_turns_cursor(cursor: &str) -> Result<ThreadTurnsCursor, JSONRPCErrorError>
```

**Purpose**: Decodes a turn-list cursor supplied by a client. It rejects malformed cursor strings.

**Data flow**: It receives cursor text, attempts to parse it as the expected JSON cursor object, and returns the object or an invalid-request error.

**Call relations**: paginate_thread_turns uses this before slicing a turn list.

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

**Purpose**: Builds the complete response for a paged turn-list request. It reconstructs turns, applies item detail level, and paginates.

**Data flow**: It receives rollout items, loaded status, live-running information, optional active turn, and page options; it reconstructs turns, adjusts item visibility, paginates, and returns data plus cursors.

**Call relations**: thread_turns_list_response_inner and build_thread_resume_initial_turns_page call this.

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

**Purpose**: Builds an optional initial page of turns to include directly in a resume response. This saves the client from making an immediate second request.

**Data flow**: It receives rollout items, status, live-turn information, and resume page parameters, calls the normal turn page builder with no cursor, and converts the result to the resume response type.

**Call relations**: thread_resume_inner and pending running-resume handling use this when the client asks for initialTurnsPage.

*Call graph*: calls 1 internal fn (build_thread_turns_page_response); called by 2 (handle_pending_thread_resume_request, thread_resume_inner).


##### `apply_thread_turns_items_view`  (lines 3866–3902)

```
fn apply_thread_turns_items_view(turns: &mut [Turn], items_view: TurnItemsView)
```

**Purpose**: Reduces or preserves each turn’s item list according to the requested detail level. This controls how much conversation content is sent over the network.

**Data flow**: It receives mutable turns and an items view; for NotLoaded it clears items, for Summary it keeps the first user message and final agent message, and for Full it leaves items intact while marking the view.

**Call relations**: build_thread_turns_page_response calls this before pagination.

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

**Purpose**: Turns raw rollout items into API turns for listing, with live status correction and optional active-turn merging.

**Data flow**: It builds turns from rollout items, normalizes in-progress statuses based on live thread status, merges an active turn snapshot if present, and returns the final turn list.

**Call relations**: build_thread_turns_page_response calls this as the first step in turn-list response creation.

*Call graph*: calls 1 internal fn (normalize_thread_turns_status); called by 1 (build_thread_turns_page_response).


##### `normalize_thread_turns_status`  (lines 3922–3936)

```
fn normalize_thread_turns_status(
    turns: &mut [Turn],
    loaded_status: ThreadStatus,
    has_live_in_progress_turn: bool,
)
```

**Purpose**: Marks stale in-progress turns as interrupted when the thread is not actually active. This prevents old saved history from looking like work is still running.

**Data flow**: It resolves the effective thread status from loaded status and live-running flag; if not active, it scans turns and changes any InProgress turn to Interrupted.

**Call relations**: reconstruct_thread_turns_for_turns_list calls this after building turns from rollout history.

*Call graph*: called by 1 (reconstruct_thread_turns_for_turns_list); 1 external calls (matches!).


##### `thread_read_view_error`  (lines 3944–3952)

```
fn thread_read_view_error(err: ThreadReadViewError) -> JSONRPCErrorError
```

**Purpose**: Converts internal read-view errors into JSON-RPC errors for clients.

**Data flow**: It receives a ThreadReadViewError, maps invalid requests, unsupported operations, and internal failures to the matching JSON-RPC error type, and returns it.

**Call relations**: thread_read_response_inner and thread_turns_list_response_inner use this when read helpers fail.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation).


##### `unsupported_thread_store_operation`  (lines 3954–3956)

```
fn unsupported_thread_store_operation(operation: &'static str) -> JSONRPCErrorError
```

**Purpose**: Creates a standard method-not-found error for thread store features that are not implemented. This gives clients a consistent message.

**Data flow**: It receives an operation name and returns a JSON-RPC method-not-found error saying the operation is not supported yet.

**Call relations**: Several storage error mappers call this when the current thread store cannot perform an operation.

*Call graph*: calls 1 internal fn (method_not_found); called by 7 (thread_store_delete_error, conversation_summary_rollout_path_read_error, conversation_summary_thread_id_read_error, thread_read_view_error, thread_store_archive_error, thread_store_list_error, thread_store_resume_read_error); 1 external calls (format!).


##### `thread_store_list_error`  (lines 3958–3966)

```
fn thread_store_list_error(err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps storage-layer errors from listing threads into client-facing JSON-RPC errors.

**Data flow**: It receives a ThreadStoreError and returns invalid-request for bad inputs, method-not-found for unsupported store operations, or internal-error for unexpected failures.

**Call relations**: list_threads_common and search/list paths use this style of mapping for storage failures.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); 1 external calls (format!).


##### `thread_store_resume_read_error`  (lines 3968–3979)

```
fn thread_store_resume_read_error(err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps storage read errors that happen during resume or fork into user-friendly errors.

**Data flow**: It receives a ThreadStoreError and turns invalid requests, unsupported operations, missing threads, and other failures into the correct JSON-RPC error.

**Call relations**: read_stored_thread_for_resume and read_stored_thread_for_new_fork use this when storage reads fail.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); 1 external calls (format!).


##### `thread_turns_list_history_load_error`  (lines 3981–4001)

```
fn thread_turns_list_history_load_error(
    thread_id: ThreadId,
    err: ThreadStoreError,
) -> ThreadReadViewError
```

**Purpose**: Converts history-load errors for thread/turns/list into read-view errors. It gives a clearer message when a thread is not materialized yet.

**Data flow**: It receives a thread id and store error, recognizes unresolved rollout paths, maps invalid and unsupported cases, and otherwise returns an internal read error.

**Call relations**: load_thread_turns_list_history uses this when live history loading fails.

*Call graph*: 4 external calls (Internal, InvalidRequest, Unsupported, format!).


##### `thread_read_history_load_error`  (lines 4003–4028)

```
fn thread_read_history_load_error(
    thread_id: ThreadId,
    err: ThreadStoreError,
) -> ThreadReadViewError
```

**Purpose**: Converts history-load errors for thread/read includeTurns into read-view errors. It explains when turns are unavailable before the first user message.

**Data flow**: It receives a thread id and store error, maps not-materialized or missing rollout cases to invalid requests, handles unsupported operations, and wraps unexpected failures as internal errors.

**Call relations**: apply_thread_read_store_fields uses this when it cannot load history for includeTurns.

*Call graph*: 4 external calls (Internal, InvalidRequest, Unsupported, format!).


##### `conversation_summary_thread_id_read_error`  (lines 4030–4050)

```
fn conversation_summary_thread_id_read_error(
    conversation_id: ThreadId,
    err: ThreadStoreError,
) -> JSONRPCErrorError
```

**Purpose**: Maps storage errors from reading a conversation summary by thread id into JSON-RPC errors.

**Data flow**: It receives the requested id and storage error, turns missing-rollout and not-found cases into a summary not-found message, handles unsupported operations, and wraps unexpected failures.

**Call relations**: get_thread_summary_response_inner uses this for thread-id summary lookups.

*Call graph*: calls 2 internal fn (conversation_summary_not_found_error, unsupported_thread_store_operation); 1 external calls (format!).


##### `conversation_summary_not_found_error`  (lines 4052–4056)

```
fn conversation_summary_not_found_error(conversation_id: ThreadId) -> JSONRPCErrorError
```

**Purpose**: Creates the standard error message for a missing conversation summary.

**Data flow**: It receives a conversation id and returns an invalid-request error saying no rollout was found for that id.

**Call relations**: conversation_summary_thread_id_read_error calls this for not-found cases.

*Call graph*: called by 1 (conversation_summary_thread_id_read_error); 1 external calls (format!).


##### `conversation_summary_rollout_path_read_error`  (lines 4058–4073)

```
fn conversation_summary_rollout_path_read_error(
    path: &Path,
    err: ThreadStoreError,
) -> JSONRPCErrorError
```

**Purpose**: Maps storage errors from reading a conversation summary by rollout path into JSON-RPC errors.

**Data flow**: It receives a path and storage error, maps invalid requests and unsupported operations directly, and wraps other failures with the path in an internal error.

**Call relations**: get_thread_summary_response_inner uses this for rollout-path summary lookups.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); 1 external calls (format!).


##### `core_thread_write_error`  (lines 4075–4084)

```
fn core_thread_write_error(operation: &str, err: CodexErr) -> JSONRPCErrorError
```

**Purpose**: Converts core thread write failures into JSON-RPC errors. Core write failures can happen while changing metadata such as names or memory mode.

**Data flow**: It receives an operation label and core error, maps thread-not-found and invalid-request cases to client errors, unsupported operations to method-not-found, and everything else to internal-error.

**Call relations**: Metadata-writing flows call this when ThreadManager update operations fail.

*Call graph*: calls 1 internal fn (method_not_found); called by 1 (thread_delete_response); 1 external calls (format!).


##### `thread_store_archive_error`  (lines 4086–4094)

```
fn thread_store_archive_error(operation: &str, err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: Maps storage errors during archive or unarchive into client-facing JSON-RPC errors.

**Data flow**: It receives an operation name and store error, maps invalid requests and unsupported operations directly, and wraps other failures as internal archive/unarchive errors.

**Call relations**: thread_archive_response and unarchive storage paths use this error mapping.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); called by 1 (thread_archive_response); 1 external calls (format!).


##### `set_thread_name_from_title`  (lines 4096–4101)

```
fn set_thread_name_from_title(thread: &mut Thread, title: String)
```

**Purpose**: Sets a thread display name only when it is meaningful. It avoids empty names and names that merely duplicate the preview.

**Data flow**: It receives a mutable Thread and title string, trims and compares the title, and sets thread.name only if it should be shown separately.

**Call relations**: attach_thread_name and thread_fork_inner use this when applying saved or inherited names.

*Call graph*: called by 2 (attach_thread_name, thread_fork_inner).


##### `thread_from_stored_thread`  (lines 4103–4155)

```
fn thread_from_stored_thread(
    thread: StoredThread,
    fallback_provider: &str,
    fallback_cwd: &AbsolutePathBuf,
) -> (Thread, Option<codex_thread_store::StoredThreadHistory>)
```

**Purpose**: Converts a stored thread database record into the app-server Thread shape. It also returns any stored history separately.

**Data flow**: It normalizes the working directory, converts Git and source metadata, fills timestamps, provider, path, preview, names, and other fields, sets status to NotLoaded, and returns the Thread plus optional history.

**Call relations**: List, search, read, resume, unarchive, metadata update, and fork helpers all use this as the main storage-to-API conversion.

*Call graph*: calls 1 internal fn (relative_to_current_dir); called by 7 (load_persisted_thread_for_read, load_thread_from_resume_source_or_send_internal, stored_thread_to_api_thread, thread_list_response_inner, thread_metadata_update_response_inner, thread_search_response_inner, thread_unarchive_response); 2 external calls (new, normalize_for_native_workdir).


##### `summary_from_stored_thread`  (lines 4157–4198)

```
fn summary_from_stored_thread(
    thread: StoredThread,
    fallback_provider: &str,
) -> ConversationSummary
```

**Purpose**: Converts a stored thread into a compact ConversationSummary. It keeps enough metadata for history pickers without loading turns.

**Data flow**: It reads path, preview, timestamps, provider, working directory, CLI version, source, and Git data from storage and fills fallback provider when needed.

**Call relations**: get_thread_summary_response_inner calls this after successfully reading storage.

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

**Purpose**: Test-only helper that builds a ConversationSummary from state database metadata fields. It mirrors older metadata-row shapes used in tests.

**Data flow**: It receives individual metadata values, derives preview, parses source, builds optional Git info, and returns a ConversationSummary.

**Call relations**: summary_from_thread_metadata calls this in test builds.

*Call graph*: called by 1 (summary_from_thread_metadata); 1 external calls (from_str).


##### `summary_from_thread_metadata`  (lines 4249–4272)

```
fn summary_from_thread_metadata(metadata: &ThreadMetadata) -> ConversationSummary
```

**Purpose**: Test-only helper that converts a ThreadMetadata object into a ConversationSummary.

**Data flow**: It extracts fields from ThreadMetadata, formats timestamps, and passes them to summary_from_state_db_metadata.

**Call relations**: Unit tests use this path to compare metadata-derived summaries.

*Call graph*: calls 1 internal fn (summary_from_state_db_metadata).


##### `preview_from_rollout_items`  (lines 4274–4289)

```
fn preview_from_rollout_items(items: &[RolloutItem]) -> String
```

**Purpose**: Finds a short preview string from the first user message in rollout history. The preview helps clients show a thread in a list.

**Data flow**: It scans rollout items, parses response items into turn items, finds the first user message, strips a known marker if present, and returns the cleaned text or an empty string.

**Call relations**: Resume and fork response builders use this when they need a preview from copied history.

*Call graph*: called by 2 (load_thread_from_resume_source_or_send_internal, thread_fork_inner); 1 external calls (iter).


##### `requested_permissions_trust_project`  (lines 4291–4315)

```
fn requested_permissions_trust_project(overrides: &ConfigOverrides, cwd: &Path) -> bool
```

**Purpose**: Determines whether the client explicitly requested permissions that imply trusting the project directory. Trust affects whether the server should persist project trust for the working directory.

**Data flow**: It checks sandbox mode, named permission profiles, and explicit permission profiles against the current working directory, returning true if any requested setting trusts project writes or full access.

**Call relations**: thread_start_task calls this while deciding whether to mark a requested working directory as trusted.

*Call graph*: called by 1 (thread_start_task); 1 external calls (matches!).


##### `permission_profile_trusts_project`  (lines 4317–4328)

```
fn permission_profile_trusts_project(
    profile: &codex_protocol::models::PermissionProfile,
    cwd: &Path,
) -> bool
```

**Purpose**: Checks whether an effective permission profile gives enough access to consider the project trusted. A permission profile is a bundle of file-system and approval rules.

**Data flow**: It receives a permission profile and working directory, returns true for disabled or external profiles, or checks whether a managed sandbox can write to the cwd.

**Call relations**: thread_start_task uses this alongside requested_permissions_trust_project during startup trust handling.

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

**Purpose**: Builds a client-facing Thread object from a live configuration snapshot. It is used before or without a stored thread record.

**Data flow**: It receives thread id, session id, config snapshot, and optional path, fills current timestamps, cwd, provider, source, thread source, ephemeral flag, and default empty preview/turns, then returns the Thread.

**Call relations**: Start, resume, fork, listener attachment, and build_thread_from_loaded_snapshot use this to represent live threads.

*Call graph*: calls 1 internal fn (cwd); called by 5 (load_thread_from_resume_source_or_send_internal, thread_fork_inner, thread_start_task, try_attach_thread_listener, build_thread_from_loaded_snapshot); 5 external calls (new, new, env!, to_string, now_utc).


##### `paginate_background_terminals`  (lines 4361–4387)

```
fn paginate_background_terminals(
    terminals: &[ThreadBackgroundTerminal],
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<ThreadBackgroundTerminal>, Option<String>), JSONRPCEr
```

**Purpose**: Slices a list of background terminal records into a cursor-based page.

**Data flow**: It receives terminal records, optional cursor, and optional limit; it finds the first terminal after the cursor process id, applies the limit, and returns the page plus next cursor.

**Call relations**: thread_background_terminals_list_inner calls this after collecting live terminal records.

*Call graph*: called by 1 (thread_background_terminals_list_inner); 2 external calls (iter, len).


##### `build_thread_from_loaded_snapshot`  (lines 4389–4400)

```
fn build_thread_from_loaded_snapshot(
    thread_id: ThreadId,
    config_snapshot: &ThreadConfigSnapshot,
    loaded_thread: &CodexThread,
) -> Thread
```

**Purpose**: Convenience helper that builds a Thread object from a live loaded thread and its config snapshot.

**Data flow**: It receives a thread id, config snapshot, and live thread, extracts the live session id and rollout path, and calls build_thread_from_snapshot.

**Call relations**: load_live_thread_view uses this as the fallback live representation for thread/read.

*Call graph*: calls 3 internal fn (build_thread_from_snapshot, rollout_path, session_configured); called by 1 (load_live_thread_view).


### `app-server/src/request_processors/thread_goal_processor.rs`

`orchestration` · `request handling and thread resume`

A “thread goal” is the task or objective attached to a conversation thread, along with status and usage limits. This file is the app server’s request-facing bridge for that feature. When a client asks to set, get, or clear a goal, this processor checks that the goals feature is enabled, checks that the thread id is valid, finds the right saved state database, and then calls the goal service that actually reads or changes the stored goal.

The file is careful about saved versus temporary threads. Goals only make sense for materialized threads, meaning threads that have a rollout file and persistent state. If a thread is ephemeral, the processor rejects the request rather than pretending it can save goal data.

It also keeps clients informed. After a goal is set or cleared, it sends the direct request response first, then sends an ordered notification through the thread listener when possible. If that listener is gone, it falls back to sending the notification directly. This is like handing a message to the person already organizing the queue, but posting it yourself if that person has left.

During thread resume, it can emit a fresh goal snapshot before allowing idle-thread lifecycle hooks to continue, so clients see goal state in a predictable order.

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

**Purpose**: Creates a processor with all the shared services it needs: thread lookup, outgoing messages, configuration, thread state, optional state database access, and the goal service.

**Data flow**: The caller provides shared references to the surrounding server pieces. The function stores them inside a new ThreadGoalRequestProcessor. The result is a ready-to-use object that can answer goal-related client requests.

**Call relations**: It is called during the larger server setup path named new, so the request-handling layer can later route goal requests to this processor.

*Call graph*: called by 1 (new).


##### `ThreadGoalRequestProcessor::thread_goal_set`  (lines 37–45)

```
async fn thread_goal_set(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request wrapper for setting or updating a thread goal. It adapts the internal success result into the standard client-response shape used by the request processor framework.

**Data flow**: It receives a client request id and goal-setting parameters. It passes both to thread_goal_set_inner. If the inner work succeeds, it returns no extra payload because the response is sent explicitly inside the inner function.

**Call relations**: handle_initialized_client_request calls this when an initialized client sends a goal-set request. This function immediately hands the real work to thread_goal_set_inner.

*Call graph*: calls 1 internal fn (thread_goal_set_inner); called by 1 (handle_initialized_client_request).


##### `ThreadGoalRequestProcessor::thread_goal_get`  (lines 47–54)

```
async fn thread_goal_get(
        &self,
        params: ThreadGoalGetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request wrapper for reading the current goal for a thread. It converts the internal response into the generic payload type expected by the client request system.

**Data flow**: It receives goal-get parameters, asks thread_goal_get_inner to fetch the goal, and wraps the returned response so it can be sent back through the normal request path.

**Call relations**: handle_initialized_client_request calls this for goal-get requests. It delegates the lookup and validation to thread_goal_get_inner.

*Call graph*: calls 1 internal fn (thread_goal_get_inner); called by 1 (handle_initialized_client_request).


##### `ThreadGoalRequestProcessor::thread_goal_clear`  (lines 56–64)

```
async fn thread_goal_clear(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalClearParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request wrapper for clearing a thread goal. It adapts the internal clear operation to the standard request processor return format.

**Data flow**: It receives a client request id and clear parameters. It calls thread_goal_clear_inner, which sends the actual clear response. On success this wrapper returns no extra payload.

**Call relations**: handle_initialized_client_request calls this for goal-clear requests. It passes control to thread_goal_clear_inner for the real validation, storage update, and notification work.

*Call graph*: calls 1 internal fn (thread_goal_clear_inner); called by 1 (handle_initialized_client_request).


##### `ThreadGoalRequestProcessor::emit_resume_goal_snapshot_and_continue`  (lines 66–78)

```
async fn emit_resume_goal_snapshot_and_continue(
        &self,
        thread_id: ThreadId,
        thread: &CodexThread,
    )
```

**Purpose**: Sends the client a snapshot of the thread goal during thread resume, then lets the thread continue its normal idle lifecycle. This preserves a predictable order: resume data first, extension reactions second.

**Data flow**: It receives a thread id and the running thread object. If the goals feature is off, it does nothing. If goals are enabled, it emits a goal snapshot, then asks the thread to emit its idle lifecycle event if it is idle.

**Call relations**: thread_resume_inner calls this during resume. It calls emit_thread_goal_snapshot first, then emit_thread_idle_lifecycle_if_idle so later extension work does not race ahead of the resume snapshot.

*Call graph*: calls 2 internal fn (emit_thread_goal_snapshot, emit_thread_idle_lifecycle_if_idle); called by 1 (thread_resume_inner).


##### `ThreadGoalRequestProcessor::pending_resume_goal_state`  (lines 80–95)

```
async fn pending_resume_goal_state(
        &self,
        thread: &CodexThread,
    ) -> (bool, Option<StateDbHandle>)
```

**Purpose**: Figures out whether resume should include goal-state work and which state database should be used for it.

**Data flow**: It receives a thread. It checks the feature flag. If goals are enabled, it prefers the thread’s own state database and otherwise falls back to the processor’s shared one. It returns a yes-or-no flag plus the database handle, if any.

**Call relations**: resume_running_thread calls this while preparing a resumed thread. It reads the thread’s state_db when available so later resume code can use the right storage source.

*Call graph*: calls 1 internal fn (state_db); called by 1 (resume_running_thread).


##### `ThreadGoalRequestProcessor::thread_goal_set_inner`  (lines 97–148)

```
async fn thread_goal_set_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalSetParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Does the real work for setting a thread goal: validate the request, make sure storage is up to date, save the new goal, reply to the client, notify listeners, and apply any runtime side effects.

**Data flow**: It starts with a request id and client parameters. It checks the feature flag, parses the thread id, finds the correct state database, reconciles the thread rollout into storage, gathers the listener channel, and asks the goal service to set the requested objective, status, and token budget. It sends a set response, emits a goal-updated notification, applies runtime effects, and returns success or a JSON-RPC error.

**Call relations**: thread_goal_set calls this. Inside, it uses parse_thread_id_for_request, state_db_for_materialized_thread, reconcile_thread_goal_rollout, thread_state, conversion helpers from the goal types, and emit_thread_goal_updated_ordered to complete the full set-request flow.

*Call graph*: calls 6 internal fn (from, emit_thread_goal_updated_ordered, reconcile_thread_goal_rollout, state_db_for_materialized_thread, parse_thread_id_for_request, thread_state); called by 1 (thread_goal_set); 2 external calls (clone, Set).


##### `ThreadGoalRequestProcessor::thread_goal_get_inner`  (lines 150–167)

```
async fn thread_goal_get_inner(
        &self,
        params: ThreadGoalGetParams,
    ) -> Result<ThreadGoalGetResponse, JSONRPCErrorError>
```

**Purpose**: Does the real work for reading a thread goal from persistent state.

**Data flow**: It receives client parameters. It checks that goals are enabled, parses the thread id, finds the state database for that saved thread, and asks the goal service for the stored goal. It converts any found goal into the API shape and returns it in a get response.

**Call relations**: thread_goal_get calls this. It relies on parse_thread_id_for_request and state_db_for_materialized_thread before asking the goal service for the stored data.

*Call graph*: calls 2 internal fn (state_db_for_materialized_thread, parse_thread_id_for_request); called by 1 (thread_goal_get).


##### `ThreadGoalRequestProcessor::thread_goal_clear_inner`  (lines 169–202)

```
async fn thread_goal_clear_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadGoalClearParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Does the real work for clearing a thread goal and telling clients if something was actually removed.

**Data flow**: It receives a request id and clear parameters. It checks the feature flag, parses the thread id, finds the state database, reconciles rollout data, gets the listener channel, and asks the goal service to clear the goal. It sends a clear response with a boolean result. If a goal was cleared, it emits a cleared notification.

**Call relations**: thread_goal_clear calls this. It uses parse_thread_id_for_request, state_db_for_materialized_thread, reconcile_thread_goal_rollout, thread_state, and emit_thread_goal_cleared_ordered as the pieces of the clear-request flow.

*Call graph*: calls 5 internal fn (emit_thread_goal_cleared_ordered, reconcile_thread_goal_rollout, state_db_for_materialized_thread, parse_thread_id_for_request, thread_state); called by 1 (thread_goal_clear).


##### `ThreadGoalRequestProcessor::state_db_for_materialized_thread`  (lines 204–233)

```
async fn state_db_for_materialized_thread(
        &self,
        thread_id: ThreadId,
    ) -> Result<StateDbHandle, JSONRPCErrorError>
```

**Purpose**: Finds the state database that can safely store or read goal data for a real saved thread. It rejects temporary threads because they do not have durable goal storage.

**Data flow**: It receives a thread id. If the thread is running, it checks that it has a rollout path and uses the thread’s own state database if present. If the thread is not running, it searches the Codex home directory for the saved thread. If all checks pass, it returns a state database handle; otherwise it returns a clear client or server error.

**Call relations**: emit_thread_goal_snapshot, thread_goal_clear_inner, thread_goal_get_inner, and thread_goal_set_inner all call this before touching goal state. It uses rollout lookup helpers such as find_thread_path_by_id_str when the thread is not already loaded.

*Call graph*: called by 4 (emit_thread_goal_snapshot, thread_goal_clear_inner, thread_goal_get_inner, thread_goal_set_inner); 3 external calls (find_thread_path_by_id_str, format!, to_string).


##### `ThreadGoalRequestProcessor::reconcile_thread_goal_rollout`  (lines 235–269)

```
async fn reconcile_thread_goal_rollout(
        &self,
        thread_id: ThreadId,
        state_db: &StateDbHandle,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Brings the saved rollout file for a thread into agreement with the state database before changing goal data. This helps avoid updating goals against stale or missing thread state.

**Data flow**: It receives a thread id and state database. It finds the thread’s rollout path from the running thread or by searching saved thread files. Then it calls the rollout reconciliation process with the database, rollout path, and current model provider information. It returns success after reconciliation has been requested.

**Call relations**: thread_goal_set_inner and thread_goal_clear_inner call this before mutating goal state. It uses find_thread_path_by_id_str when needed and hands the path to reconcile_rollout, which performs the storage synchronization.

*Call graph*: called by 2 (thread_goal_clear_inner, thread_goal_set_inner); 2 external calls (find_thread_path_by_id_str, to_string).


##### `ThreadGoalRequestProcessor::emit_thread_goal_snapshot`  (lines 271–299)

```
async fn emit_thread_goal_snapshot(&self, thread_id: ThreadId)
```

**Purpose**: Sends the current goal state for a thread to the client, usually while resuming a thread. It tries to preserve event ordering by sending through the thread listener first.

**Data flow**: It receives a thread id. It finds the state database; if that fails, it logs a warning and stops. It then looks up the thread listener channel. If the listener accepts a snapshot command, the function is done. If not, it logs a warning and sends the snapshot notification directly through the outgoing message sender.

**Call relations**: emit_resume_goal_snapshot_and_continue calls this during resume. It uses state_db_for_materialized_thread and thread_state, and falls back to send_thread_goal_snapshot_notification when the ordered listener path is unavailable.

*Call graph*: calls 2 internal fn (state_db_for_materialized_thread, thread_state); called by 1 (emit_resume_goal_snapshot_and_continue); 1 external calls (warn!).


##### `ThreadGoalRequestProcessor::emit_thread_goal_updated_ordered`  (lines 301–328)

```
async fn emit_thread_goal_updated_ordered(
        &self,
        thread_id: ThreadId,
        goal: ThreadGoal,
        listener_command_tx: Option<tokio::sync::mpsc::UnboundedSender<ThreadListenerCo
```

**Purpose**: Notifies clients that a thread goal was updated, while trying to keep the notification in the same order as other thread events.

**Data flow**: It receives a thread id, the updated goal, and an optional listener command channel. If the channel exists and accepts the update command, the listener will emit the notification later in order. If the channel is missing or closed, it sends the server notification directly with the thread id and goal.

**Call relations**: thread_goal_set_inner calls this after sending the direct set response. It uses the listener path when possible and otherwise sends a ThreadGoalUpdated notification itself.

*Call graph*: called by 1 (thread_goal_set_inner); 4 external calls (ThreadGoalUpdated, clone, to_string, warn!).


##### `ThreadGoalRequestProcessor::emit_thread_goal_cleared_ordered`  (lines 330–351)

```
async fn emit_thread_goal_cleared_ordered(
        &self,
        thread_id: ThreadId,
        listener_command_tx: Option<tokio::sync::mpsc::UnboundedSender<ThreadListenerCommand>>,
    )
```

**Purpose**: Notifies clients that a thread goal was cleared, again trying to keep the message ordered with other thread events.

**Data flow**: It receives a thread id and an optional listener command channel. If the listener channel accepts the clear command, the listener owns the later notification. If the channel is unavailable, it sends a ThreadGoalCleared server notification directly.

**Call relations**: thread_goal_clear_inner calls this only when the goal service says a goal was actually cleared. It prefers the thread listener and falls back to outgoing notification if needed.

*Call graph*: called by 1 (thread_goal_clear_inner); 3 external calls (ThreadGoalCleared, to_string, warn!).


##### `api_thread_goal_from_state`  (lines 354–365)

```
fn api_thread_goal_from_state(goal: codex_state::ThreadGoal) -> ThreadGoal
```

**Purpose**: Converts a stored thread-goal record into the API format sent to clients. This keeps database-oriented types from leaking directly into client messages.

**Data flow**: It receives a codex_state ThreadGoal. It copies the thread id, objective, budget, usage counts, and timestamps into the API ThreadGoal shape, and converts the status through api_thread_goal_status_from_state. It returns the client-facing goal object.

**Call relations**: Other parts of the request layer can use this helper when they need to present saved goal state through the API. It calls api_thread_goal_status_from_state for the status field.

*Call graph*: calls 1 internal fn (api_thread_goal_status_from_state).


##### `api_thread_goal_status_from_state`  (lines 367–376)

```
fn api_thread_goal_status_from_state(status: codex_state::ThreadGoalStatus) -> ThreadGoalStatus
```

**Purpose**: Translates each stored goal status into the matching API status value.

**Data flow**: It receives a status from the state layer, such as Active, Paused, Blocked, or Complete. It matches that value one-for-one to the API enum and returns the API version.

**Call relations**: api_thread_goal_from_state calls this while building the client-facing ThreadGoal object.

*Call graph*: called by 1 (api_thread_goal_from_state).


##### `goal_service_error`  (lines 378–383)

```
fn goal_service_error(err: GoalServiceError) -> JSONRPCErrorError
```

**Purpose**: Turns errors from the goal service into JSON-RPC errors, the error format used for client requests.

**Data flow**: It receives a GoalServiceError. If the service says the request was invalid, it becomes an invalid-request error for the client. If the service reports an internal failure, it becomes an internal server error. The returned value can be sent through the normal JSON-RPC error path.

**Call relations**: The inner request functions use this mapping when goal-service calls fail, so service-layer errors are reported to clients in the server’s standard request format.


##### `parse_thread_id_for_request`  (lines 385–388)

```
fn parse_thread_id_for_request(thread_id: &str) -> Result<ThreadId, JSONRPCErrorError>
```

**Purpose**: Checks that a thread id string from a client request is well formed and turns it into the internal ThreadId type.

**Data flow**: It receives the thread id as text. It asks ThreadId::from_string to parse it. On success it returns the parsed id; on failure it returns an invalid-request error that explains the id was not valid.

**Call relations**: thread_goal_set_inner, thread_goal_get_inner, and thread_goal_clear_inner call this before doing any storage work, so bad client input is rejected early.

*Call graph*: calls 1 internal fn (from_string); called by 3 (thread_goal_clear_inner, thread_goal_get_inner, thread_goal_set_inner).


### `app-server/src/request_processors/thread_delete.rs`

`domain_logic` · `request handling`

A “thread” here is a saved conversation or work unit. Deleting one is not as simple as removing a single row: a thread may have child threads, may still be live in memory, may have extra app-server state, and clients need to be notified afterward. This file is the careful deletion path for that job.

The main flow starts when a client asks to delete a thread. The processor first takes a permit for thread-list state, which is like putting a “do not rearrange this shelf while I am editing it” sign on shared data. It then builds the full set of threads to remove by combining persisted child-thread information from the state database with live child-thread information from the thread manager. That matters because some descendants may exist in memory even if they have not yet been fully written elsewhere.

Before deleting, it checks whether the requested root thread is allowed to be deleted. In particular, ephemeral threads, meaning temporary non-persisted threads, are rejected as direct delete targets. It then prepares each thread for removal, deletes children before the parent, removes matching app-server state, sends the response to the original request, and finally emits one `ThreadDeleted` notification per deleted thread. Errors from the storage layer are translated into client-friendly JSON-RPC errors.

#### Function details

##### `ThreadRequestProcessor::thread_delete`  (lines 8–30)

```
async fn thread_delete(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadDeleteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: This is the top-level handler for a client’s `thread/delete` request. It coordinates the delete operation, sends the direct response, and then broadcasts deletion notifications.

**Data flow**: It receives a request id and delete parameters from the client. It creates an empty list that will later hold the deleted thread ids, takes a permit to safely work with shared thread-list state, and asks `thread_delete_response` to do the actual deletion. If that succeeds, it sends the response tied to the original request id and then sends notifications for every deleted thread; if it fails, it returns the error without sending success messages.

**Call relations**: This function is the entry point into this file’s workflow. It calls `ThreadRequestProcessor::thread_delete_response` to perform the deletion and fill in the list of deleted ids, then calls `ThreadRequestProcessor::send_thread_deleted_notifications` so other clients can update their views.

*Call graph*: calls 2 internal fn (send_thread_deleted_notifications, thread_delete_response); 2 external calls (new, clone).


##### `ThreadRequestProcessor::thread_delete_response`  (lines 32–104)

```
async fn thread_delete_response(
        &self,
        params: ThreadDeleteParams,
        deleted_thread_ids: &mut Vec<String>,
    ) -> Result<ThreadDeleteResponse, JSONRPCErrorError>
```

**Purpose**: This function performs the real delete plan. It finds the target thread and its descendants, checks that deletion is allowed, prepares each thread, removes them from storage and app-server state, and builds the successful response.

**Data flow**: It receives the client parameters and a mutable list where it can record deleted thread ids. It turns the incoming thread id string into an internal `ThreadId`, gathers descendant thread ids from both the state database and the live thread manager, and removes duplicates. It validates the root thread, prepares every thread for deletion, deletes children before deleting the parent, cleans matching state database entries, appends the deleted ids as strings to the shared list, and returns an empty `ThreadDeleteResponse` on success. If parsing, validation, live-thread lookup, storage deletion, or state cleanup fails, it converts that problem into a JSON-RPC error.

**Call relations**: It is called by `ThreadRequestProcessor::thread_delete` after the outer request setup is complete. During its work it calls `ThreadRequestProcessor::validate_root_thread_delete` before making destructive changes, `ThreadRequestProcessor::prepare_thread_for_delete` before each removal, and `thread_store_delete_error` or `core_thread_write_error` when lower-level failures need to become client-facing errors.

*Call graph*: calls 5 internal fn (prepare_thread_for_delete, validate_root_thread_delete, thread_store_delete_error, core_thread_write_error, from_string); called by 1 (thread_delete); 1 external calls (warn!).


##### `ThreadRequestProcessor::send_thread_deleted_notifications`  (lines 106–114)

```
async fn send_thread_deleted_notifications(&self, deleted_thread_ids: Vec<String>)
```

**Purpose**: This function tells clients that specific threads were deleted. It sends one server notification for each deleted thread id.

**Data flow**: It receives a list of deleted thread id strings. For each id, it creates a `ThreadDeletedNotification` wrapped as a server notification and sends it through the outgoing connection channel. It does not return a value; its effect is that clients listening to server events are informed.

**Call relations**: It is called by `ThreadRequestProcessor::thread_delete` only after the delete response has been sent successfully. This ordering means the requester first gets confirmation, and then all interested clients can react to the thread-deleted events.

*Call graph*: called by 1 (thread_delete); 1 external calls (ThreadDeleted).


##### `ThreadRequestProcessor::validate_root_thread_delete`  (lines 116–167)

```
async fn validate_root_thread_delete(
        &self,
        thread_id: ThreadId,
        has_descendants: bool,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: This function decides whether the requested root thread is a valid delete target. It prevents deleting temporary live threads directly and checks that a missing root thread is still explainable by descendant or state records.

**Data flow**: It receives the root `ThreadId` and a flag saying whether descendants were found. First it checks the live thread manager: if the live thread exists and is persisted, deletion is allowed; if it is ephemeral, meaning temporary and not stored, deletion is rejected. If the live thread is not found, it checks persistent thread storage. If storage also says the thread is missing, it allows the operation only when descendants exist or when app-server state still contains the thread; otherwise it returns a “thread not found” style error. Other storage failures are converted into JSON-RPC errors.

**Call relations**: It is called by `ThreadRequestProcessor::thread_delete_response` before any deletion happens. When storage errors need to be reported consistently, it hands them to `thread_store_delete_error` so the client receives the same kind of error message as other delete failures.

*Call graph*: calls 1 internal fn (thread_store_delete_error); called by 1 (thread_delete_response); 1 external calls (format!).


##### `ThreadRequestProcessor::prepare_thread_for_delete`  (lines 169–174)

```
async fn prepare_thread_for_delete(&self, thread_id: ThreadId)
```

**Purpose**: This function does last-minute cleanup before a thread is physically deleted. It gives the rest of the system a chance to stop or detach work tied to that thread, then flushes logs if a log database is present.

**Data flow**: It receives a `ThreadId`. It asks the broader thread processor to prepare that thread for removal with the reason label `delete`, then, if logging storage exists, flushes it so pending log data is written out before the thread disappears. It returns nothing; its result is a safer deletion state.

**Call relations**: It is called by `ThreadRequestProcessor::thread_delete_response` once for every thread that will be removed. It sits between validation and actual storage deletion, like clearing people out of a room before locking the door.

*Call graph*: called by 1 (thread_delete_response).


##### `thread_store_delete_error`  (lines 177–188)

```
fn thread_store_delete_error(err: ThreadStoreError) -> JSONRPCErrorError
```

**Purpose**: This helper turns low-level thread storage errors into JSON-RPC errors that make sense to clients. It keeps delete-related error messages consistent and avoids exposing raw storage details unnecessarily.

**Data flow**: It receives a `ThreadStoreError`. If the thread was not found, it returns an invalid-request error saying so; if the request was invalid, it passes along the message; if the storage backend does not support the operation, it delegates to the shared unsupported-operation converter; otherwise it returns a general internal error saying deletion failed. The output is always a `JSONRPCErrorError` ready to send back through the request system.

**Call relations**: It is used by `ThreadRequestProcessor::thread_delete_response` when deletion from storage fails and by `ThreadRequestProcessor::validate_root_thread_delete` when validation discovers storage-related problems. It also calls `unsupported_thread_store_operation` for the special case where the backing store cannot perform the requested delete operation.

*Call graph*: calls 1 internal fn (unsupported_thread_store_operation); called by 2 (thread_delete_response, validate_root_thread_delete); 1 external calls (format!).


### `app-server/src/dynamic_tools.rs`

`orchestration` · `request handling`

Dynamic tools are tool calls whose result comes back through the app server, often from a client-side action. This file is the small bridge that waits for that client answer, checks whether it is usable, converts it into the core protocol’s shape, and submits it back to the running conversation.

The main path starts when the server has already asked the client for a dynamic tool result. A one-time channel, like a mailbox used for exactly one reply, eventually delivers either a JSON value or an error. If the reply is valid, the code turns it into a `DynamicToolCallResponse`, then into the matching core response type, and sends it to `CodexThread`, the conversation thread that accepts operations.

If something goes wrong, the file tries to fail safely. Some errors mean the conversation has moved to another turn; in that case it quietly stops, because sending an old tool result would be wrong. Other failures are logged and turned into a fallback response marked unsuccessful, with a short text message explaining the problem. This matters because the conversation engine should not hang forever waiting for a tool result that will never arrive or cannot be understood.

#### Function details

##### `on_call_response`  (lines 14–53)

```
async fn on_call_response(
    call_id: String,
    receiver: oneshot::Receiver<ClientRequestResult>,
    conversation: Arc<CodexThread>,
)
```

**Purpose**: Waits for the client’s answer to a dynamic tool call, turns it into the core conversation format, and sends it back to the active conversation. It also protects the conversation from bad or missing client replies by creating a clear failure response instead.

**Data flow**: It receives a tool call id, a one-use receiver that will produce the client result, and the conversation thread to report back to. It waits for the receiver, then either decodes the JSON reply, ignores a reply that belongs to an old turn, or builds a fallback failure message. After that it converts the app-server response items into core response items and submits a `DynamicToolResponse` operation to the conversation; if that final submit fails, it logs the problem.

**Call relations**: This is called when bespoke event handling has arranged for a dynamic tool response to come back later. During that callback flow, it asks `decode_response` to understand successful JSON replies, uses `fallback_response` when the client or channel fails, checks turn-transition errors so stale responses are not sent, and finally hands the completed response to the conversation thread.

*Call graph*: calls 3 internal fn (decode_response, fallback_response, is_turn_transition_server_request_error); called by 1 (apply_bespoke_event_handling); 1 external calls (error!).


##### `decode_response`  (lines 55–63)

```
fn decode_response(value: serde_json::Value) -> (DynamicToolCallResponse, Option<String>)
```

**Purpose**: Turns raw JSON from the client into the structured dynamic tool response the app server expects. If the JSON does not match the expected shape, it creates a safe failure response instead of letting the bad data travel further.

**Data flow**: It takes a `serde_json::Value`, which is untyped JSON data. It tries to read that data as a `DynamicToolCallResponse`; on success, it returns the parsed response with no error message. On failure, it logs the decoding problem and returns a fallback response saying the dynamic tool response was invalid.

**Call relations**: `on_call_response` uses this after the client successfully sends back a value. If decoding fails, this function delegates to `fallback_response`, so the rest of the flow can still submit a normal-looking but unsuccessful tool response to the conversation.

*Call graph*: calls 1 internal fn (fallback_response); called by 1 (on_call_response); 1 external calls (error!).


##### `fallback_response`  (lines 65–75)

```
fn fallback_response(message: &str) -> (DynamicToolCallResponse, Option<String>)
```

**Purpose**: Builds a standard unsuccessful dynamic tool response with a human-readable text message. It gives the rest of the system a consistent answer to send when the real tool response cannot be used.

**Data flow**: It receives a short message such as "dynamic tool request failed". It creates a `DynamicToolCallResponse` whose content contains that message as input text and whose success flag is false, and it also returns the same message separately as optional error text.

**Call relations**: `on_call_response` calls this when the client request fails or the reply channel closes. `decode_response` calls it when the client did reply, but the JSON was not a valid dynamic tool response. In both cases, this function supplies the replacement response that keeps the conversation from being left without an answer.

*Call graph*: called by 2 (decode_response, on_call_response); 1 external calls (vec!).


### `app-server/src/server_request_error.rs`

`domain_logic` · `request handling`

When the app server talks to a client, some requests can fail for ordinary reasons, but one failure has a special meaning: the current “turn” changed while the request was still pending. A turn is a stage in the interaction, like whose move it is in a board game. If the board moves on before a question is answered, the old question may no longer matter.

This file defines the exact marker string used for that case, `turnTransition`, and provides one small function that looks inside a JSON-RPC error. JSON-RPC is a common message format for asking another program to do something and getting either a result or an error back. The error may include extra JSON data. This helper checks whether that extra data contains a field named `reason` whose value is exactly `turnTransition`.

Without this file, several parts of the server would have to repeat the same fragile check by hand. That would make it easier for one place to misspell the reason, forget to handle missing data, or treat an unrelated error as this special “turn moved on” case. The tests show both sides: the special error is detected, and a different reason is not.

#### Function details

##### `is_turn_transition_server_request_error`  (lines 5–12)

```
fn is_turn_transition_server_request_error(error: &JSONRPCErrorError) -> bool
```

**Purpose**: This function tells callers whether a JSON-RPC error means a pending request was resolved because the turn state changed. Callers use it to separate this expected, state-related cancellation from other failures.

**Data flow**: It receives a `JSONRPCErrorError`, reads its optional `data` field, looks for a JSON field called `reason`, and checks whether that value is the text `turnTransition`. It returns `true` only for that exact match; if the data is missing, the field is missing, the value is not text, or the text is different, it returns `false`.

**Call relations**: Several request-response paths call this helper when client-side results come back, including approval responses, user input responses, MCP elicitation responses, permission responses, and general call responses. In those flows, this function acts like a label reader: it tells the caller whether the error should be understood as the request becoming stale because the interaction moved on.

*Call graph*: called by 6 (mcp_server_elicitation_response_from_client_result, on_command_execution_request_approval_response, on_file_change_request_approval_response, on_request_user_input_response, request_permissions_response_from_client_result, on_call_response).


##### `tests::turn_transition_error_is_detected`  (lines 22–30)

```
fn turn_transition_error_is_detected()
```

**Purpose**: This test proves that the helper recognizes the intended special error. It builds an error whose extra data says `reason: turnTransition` and checks that the result is `true`.

**Data flow**: The test creates a sample `JSONRPCErrorError` with a code, message, and JSON data containing the special reason. It passes that error into `is_turn_transition_server_request_error`, then compares the returned value with `true`.

**Call relations**: This test exercises the positive path for the helper. It uses JSON construction and an equality assertion to confirm that callers can rely on the helper to detect the turn-transition case.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::unrelated_error_is_not_detected`  (lines 33–41)

```
fn unrelated_error_is_not_detected()
```

**Purpose**: This test proves that the helper does not treat every server error as a turn-transition error. It checks that an error with a different reason is rejected.

**Data flow**: The test creates a sample `JSONRPCErrorError` whose JSON data contains `reason: other`. It sends that error into `is_turn_transition_server_request_error`, then verifies that the returned value is `false`.

**Call relations**: This test exercises the negative path for the helper. It protects the callers from a dangerous mix-up where an unrelated failure might accidentally be treated as a harmless stale-request case.

*Call graph*: 2 external calls (assert_eq!, json!).


### `app-server/src/models.rs`

`domain_logic` · `request handling`

This file is the translation desk between the core model catalog and the app-facing protocol. Inside the system, models are described as `ModelPreset` values, which include many details such as display names, upgrade messages, reasoning options, service tiers, and whether the model should appear in a picker. Clients of the app server do not receive those presets directly. Instead, they receive `Model` objects from the app server protocol, shaped for the user interface or another frontend.

The main public function, `supported_models`, asks the shared `ThreadManager` for the available models. It uses an online refresh only if the list has not already been cached, so it can avoid unnecessary network work while still getting fresh data when needed. It then removes hidden models unless requested otherwise, converts each remaining preset into the protocol format, and returns the finished list.

The helper functions do the careful field-by-field copying and reshaping. Upgrade information is expanded into a client-friendly structure. Service tiers are copied into app-server protocol objects. Reasoning effort presets are converted into reasoning effort options. Without this file, clients would either see the wrong model list, miss important model metadata, or need to understand the server's internal model catalog format.

#### Function details

##### `supported_models`  (lines 12–23)

```
async fn supported_models(
    thread_manager: Arc<ThreadManager>,
    include_hidden: bool,
) -> Vec<Model>
```

**Purpose**: This function returns the list of AI models that the app server should show or expose to a caller. It can either hide models that are not meant for normal selection, or include them for callers that need the full catalog.

**Data flow**: It receives a shared `ThreadManager`, which knows how to fetch the model catalog, and a `include_hidden` flag. It asks for the model list, filters each preset based on whether hidden models are allowed, converts each remaining preset into an app-server `Model`, and returns the resulting list.

**Call relations**: This is the public entry point in this file. When some app-server flow needs supported models, it calls this function; this function gets the raw presets from `ThreadManager`, then hands each preset to `model_from_preset` so the final answer is in the protocol shape expected by clients.


##### `model_from_preset`  (lines 25–59)

```
fn model_from_preset(preset: ModelPreset) -> Model
```

**Purpose**: This function converts one internal model preset into one client-facing model description. It exists so the rest of the app server does not have to know all the details of how preset fields map into protocol fields.

**Data flow**: It takes a `ModelPreset` as input. It copies basic information like IDs, names, descriptions, default status, input types, and service tiers; it reshapes upgrade details into `ModelUpgradeInfo`; it marks the model as hidden when it should not appear in the picker; and it converts reasoning effort presets into protocol options. The output is a complete `Model` ready to send to a client.

**Call relations**: `supported_models` calls this after it has chosen which presets to expose. During the conversion, this function calls `reasoning_efforts_from_preset` for the reasoning-effort part of the model, then combines that result with the rest of the copied model metadata.

*Call graph*: calls 1 internal fn (reasoning_efforts_from_preset).


##### `reasoning_efforts_from_preset`  (lines 61–71)

```
fn reasoning_efforts_from_preset(
    efforts: Vec<ReasoningEffortPreset>,
) -> Vec<ReasoningEffortOption>
```

**Purpose**: This helper converts the internal descriptions of supported reasoning effort levels into the app-server protocol format. Reasoning effort is the setting that describes how much thinking work a model is allowed or expected to do.

**Data flow**: It receives a list of `ReasoningEffortPreset` values. For each one, it keeps the effort value and its human-readable description, wraps them in a `ReasoningEffortOption`, and returns the full converted list.

**Call relations**: This function is used only by `model_from_preset`. It handles one small piece of the larger model conversion so `model_from_preset` can assemble the full client-facing `Model` without embedding every detail inline.

*Call graph*: called by 1 (model_from_preset).


### `core/src/tools/router.rs`

`orchestration` · `turn handling`

A language model can ask the application to run tools, such as local built-in tools, extension-provided tools, MCP tools, dynamic tools, or a special tool search. This file keeps that from becoming a free-for-all. It gives the rest of the system one place to ask: “What tools can the model use?” and “Please run this requested tool call.”

The main type, ToolRouter, wraps a ToolRegistry, which is the directory of available tools, plus a list of tool descriptions that are visible to the model. Think of it like a hotel concierge: the model sees a menu of services, and when it asks for one, the router checks the directory and forwards the request to the right staff member.

The file also defines ToolCall, a small common shape for different kinds of model tool requests. The model may produce several response item formats, so build_tool_call translates those formats into this one internal package: tool name, call ID, and payload. Later, dispatch functions add session information, turn information, cancellation controls, and change tracking, then hand the complete invocation to the registry.

An important detail is that not every tool-like response should run. For example, tool search calls only become local tool calls when they are marked for client execution. The router also lets callers ask whether a tool can run in parallel or waits for runtime cleanup during cancellation, which affects safe scheduling.

#### Function details

##### `ToolRouter::from_turn_context`  (lines 49–55)

```
fn from_turn_context(
        turn_context: &TurnContext,
        params: ToolRouterParams<'_>,
        tool_search_handler_cache: &ToolSearchHandlerCache,
    ) -> Self
```

**Purpose**: Builds a ready-to-use tool router for one conversation turn. It uses the current turn settings and available tool sources to decide which tools exist and which ones the model should be shown.

**Data flow**: It receives the current turn context, a bundle of tool-related inputs such as MCP tools, extension executors, and dynamic tools, plus a tool search cache. It passes those ingredients to the tool-router builder. The result is a ToolRouter containing a registry for dispatching tools and a model-visible list of tool specifications.

**Call relations**: This is the main construction path used by turn-processing code and tests that need a realistic router. It delegates the actual assembly work to build_tool_router, keeping this file focused on the router interface rather than the detailed planning rules.

*Call graph*: calls 1 internal fn (build_tool_router); called by 11 (fatal_tool_error_stops_turn_and_reports_error, test_tool_runtime, built_tools, handle_output_item_done_returns_contributed_last_agent_message, extension_tool_executors_are_model_visible_and_dispatchable, mcp_parallel_support_uses_handler_data, parallel_support_does_not_match_namespaced_local_tool_names, specs_filter_deferred_dynamic_tools, tools_without_handlers_do_not_support_parallel, probe_with (+1 more)).


##### `ToolRouter::from_parts`  (lines 57–62)

```
fn from_parts(registry: ToolRegistry, model_visible_specs: Vec<ToolSpec>) -> Self
```

**Purpose**: Creates a ToolRouter from an already-built registry and an already-chosen list of model-visible tool descriptions. It is useful when another part of the system has done the planning work already.

**Data flow**: It takes a ToolRegistry and a list of ToolSpec values. It stores both directly in a new ToolRouter. Nothing is looked up or changed.

**Call relations**: The builder code uses this as the final assembly step after deciding what tools to register and expose. Tests also use it to construct routers with precise behavior for cancellation and lifecycle scenarios.

*Call graph*: called by 3 (cancellation_after_handler_finishes_preserves_completed_lifecycle, cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle, build_tool_router).


##### `ToolRouter::model_visible_specs`  (lines 64–66)

```
fn model_visible_specs(&self) -> Vec<ToolSpec>
```

**Purpose**: Returns the tool descriptions that should be sent to the model. These descriptions are the model’s menu of available actions.

**Data flow**: It reads the router’s stored list of ToolSpec values and returns a cloned copy. The router keeps its own copy unchanged, while the caller receives a list it can pass along or transform.

**Call relations**: Prompt-building code calls this when preparing the model request. Other conversion code also uses it when building a view of the router, so the model only sees the tools that were intentionally exposed.

*Call graph*: called by 2 (build_prompt, from_router).


##### `ToolRouter::registered_tool_names_for_test`  (lines 69–71)

```
fn registered_tool_names_for_test(&self) -> Vec<ToolName>
```

**Purpose**: Provides the names of tools registered inside the router for tests. This lets tests check that tool setup produced the expected internal directory.

**Data flow**: It asks the registry for its test-only list of tool names and returns that list. It does not affect runtime behavior.

**Call relations**: This is only compiled for tests. Test helper code calls it to verify that router construction registered the right tools, while the real application does not use it.

*Call graph*: calls 1 internal fn (tool_names_for_test); called by 1 (from_router).


##### `ToolRouter::tool_exposure_for_test`  (lines 74–79)

```
fn tool_exposure_for_test(
        &self,
        name: &ToolName,
    ) -> Option<crate::tools::registry::ToolExposure>
```

**Purpose**: Reports how a particular tool is exposed, for tests. This helps verify whether a tool is visible to the model, hidden, or otherwise categorized by the registry.

**Data flow**: It receives a tool name, asks the registry for that tool’s exposure information, and returns the optional answer. If the tool is unknown, the result is empty.

**Call relations**: This is test-only inspection. It reaches into the registry through its public testing hook so tests can confirm exposure rules without duplicating router-building logic.

*Call graph*: calls 1 internal fn (tool_exposure).


##### `ToolRouter::create_diff_consumer`  (lines 81–86)

```
fn create_diff_consumer(
        &self,
        tool_name: &ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Creates a helper that can consume incremental argument changes for a tool call, when that tool supports it. This is useful when the model streams tool-call arguments piece by piece instead of all at once.

**Data flow**: It receives a tool name and asks the registry whether that tool can provide a ToolArgumentDiffConsumer. If available, it returns the consumer boxed behind a common interface; otherwise it returns nothing.

**Call relations**: Streaming or turn-handling code can call this while a tool call is still being formed. The router does not interpret the diffs itself; it forwards the request to the registry, where each tool’s support is known.

*Call graph*: calls 1 internal fn (create_diff_consumer).


##### `ToolRouter::tool_supports_parallel`  (lines 88–92)

```
fn tool_supports_parallel(&self, call: &ToolCall) -> bool
```

**Purpose**: Answers whether a tool call is safe to run at the same time as other tool calls. This matters because some tools can run side by side, while others need to run alone to avoid conflicts.

**Data flow**: It reads the tool name from the ToolCall and asks the registry for that tool’s parallel-execution setting. If the registry has no answer, it returns false as the safe default.

**Call relations**: Scheduling code can use this before launching tool work. The router acts as a simple question-and-answer layer over the registry’s knowledge of each tool.

*Call graph*: calls 1 internal fn (supports_parallel_tool_calls).


##### `ToolRouter::tool_waits_for_runtime_cancellation`  (lines 94–98)

```
fn tool_waits_for_runtime_cancellation(&self, call: &ToolCall) -> bool
```

**Purpose**: Answers whether a tool needs time to clean up after cancellation. This is important for tools such as runtime or shell-like operations that may need to stop a running process safely.

**Data flow**: It reads the tool name from the ToolCall and asks the registry whether that tool waits for runtime cancellation cleanup. If the registry has no information, it returns false.

**Call relations**: Cancellation-handling code can ask this before deciding how to report or wait on a stopped tool call. The router forwards the policy question to the registry, where tool-specific behavior is recorded.

*Call graph*: calls 1 internal fn (waits_for_runtime_cancellation).


##### `ToolRouter::build_tool_call`  (lines 101–148)

```
fn build_tool_call(item: ResponseItem) -> Result<Option<ToolCall>, FunctionCallError>
```

**Purpose**: Converts a model response item into the project’s standard ToolCall format, if that response item is actually a tool request. It filters out response items that should not become local tool executions.

**Data flow**: It receives one ResponseItem from the model. For a normal function call, it combines the optional namespace and name into a ToolName and stores the raw arguments as a function payload. For a client-side tool search call, it parses the JSON arguments into SearchToolCallParams and creates a tool_search call. For a custom tool call, it stores the custom input. If the item is not a runnable tool request, it returns no call. If tool-search arguments cannot be parsed, it returns an error meant to be reported back to the model.

**Call relations**: Turn-processing code calls this when model output arrives. The ToolCall it returns is later passed into dispatch methods. It uses ToolName constructors to preserve namespacing, and serde JSON parsing for the structured tool-search arguments.

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

**Purpose**: Runs a tool call and returns its result in the normal code-mode path. It packages the current session, turn, cancellation token, and tracking information around the tool request.

**Data flow**: It receives shared session and turn objects, a cancellation token, a tracker for turn changes, a ToolCall, and the source of the call. It forwards all of that to the shared inner dispatch function without a terminal-outcome flag. The output is either a tool result or an error from the call path.

**Call relations**: This is a convenience wrapper around the inner dispatcher. It is used when the caller does not need to coordinate with a separate flag saying that a final outcome has already been reached.

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

**Purpose**: Runs a tool call while also sharing a flag that says whether a terminal outcome has been reached. This helps coordinate tool execution with flows where some event may already have ended the turn or made later results irrelevant.

**Data flow**: It receives the same information needed to run a tool call, plus an atomic boolean flag. An atomic boolean is a true-or-false value that can be safely read or changed by multiple tasks at once. It forwards everything to the shared inner dispatch function with that flag included. It returns the tool result or an error.

**Call relations**: This wrapper is used by code paths that need terminal-outcome coordination. Like the simpler dispatch wrapper, it hands the real work to dispatch_tool_call_with_code_mode_result_inner so both paths behave consistently.

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

**Purpose**: Performs the common dispatch setup for all router tool execution paths. It turns a plain ToolCall into a full ToolInvocation with all the context a tool needs, then asks the registry to run it.

**Data flow**: It takes session data, turn data, cancellation controls, a change tracker, a ToolCall, the call source, and optionally a terminal-outcome flag. It unpacks the ToolCall into tool name, call ID, and payload. It builds a ToolInvocation containing both the request and the surrounding runtime context. Then it passes that invocation to the registry, which runs the matching tool and returns the result or an error.

**Call relations**: Both public dispatch wrappers call this function. It is the bridge between the router’s simple ToolCall shape and the registry’s actual execution machinery, ending by calling dispatch_any_with_terminal_outcome on the registry.

*Call graph*: calls 1 internal fn (dispatch_any_with_terminal_outcome); called by 2 (dispatch_tool_call_with_code_mode_result, dispatch_tool_call_with_terminal_outcome).


##### `extension_tool_executors`  (lines 231–246)

```
fn extension_tool_executors(
    session: &Session,
) -> Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>
```

**Purpose**: Collects tool executors supplied by installed extensions for the current session. This lets outside extension code contribute tools that can be made visible to the model and dispatched like built-in tools.

**Data flow**: It reads the session’s extension services, asks each tool contributor for its tools using both session-level and thread-level extension data, and flattens all contributed executors into one list. The output is a vector of shared tool executor objects.

**Call relations**: Tool-building code calls this while assembling the available tools. The resulting executors are later included in router construction, so extension tools can appear in the model’s tool list and be run through the same dispatch path as other tools.

*Call graph*: called by 1 (built_tools).


### `core/src/tools/registry.rs`

`orchestration` · `request handling / tool dispatch`

A tool call is how the model asks the host program to do something outside plain text, such as run a command, search, or call another service. This file makes sure those calls go through one consistent path instead of every tool inventing its own rules. Think of it like a front desk: it looks up the right specialist, checks the request form, lets security review it, records what happened, and returns the answer.

The main trait, CoreToolRuntime, defines what a locally run tool must provide: its normal execution behavior, plus optional extras such as telemetry labels, hook input, and support for streamed argument updates. ToolRegistry stores these tools by name and is responsible for dispatching an invocation to the right one.

The most important flow is dispatch_any_with_terminal_outcome. It records that a tool call started, finds the tool, rejects unknown or incompatible calls, runs pre-tool-use hooks that can block or rewrite the input, executes the tool with telemetry around it, then runs post-tool-use hooks that can add context, replace the model-visible answer, or block the result. It also reports lifecycle events so the rest of the system knows whether the call completed, failed, or was blocked.

Without this file, tool calls would be scattered and inconsistent. Safety hooks, logging, cancellation behavior, and model-facing responses could easily disagree between tools.

#### Function details

##### `CoreToolRuntime::matches_kind`  (lines 48–53)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Says whether this tool can accept the kind of request payload it was given. By default, core tools accept normal function calls and tool-search calls.

**Data flow**: It receives a tool payload, checks its variant, and returns true for supported payload kinds or false for anything else.

**Call relations**: During dispatch, the registry asks the selected tool this question before running it. If the answer is false, the registry stops the call and reports an incompatible payload instead of sending bad input to the tool.

*Call graph*: 1 external calls (matches!).


##### `CoreToolRuntime::waits_for_runtime_cancellation`  (lines 57–59)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Tells the host whether this tool wants time to clean up when cancellation happens. The default is no, meaning cancellation can return an aborted response without waiting for extra teardown.

**Data flow**: It takes no extra input beyond the tool itself and returns a boolean cancellation preference.

**Call relations**: Other parts of the tool system query this through the registry when deciding how to treat a cancelled tool call.


##### `CoreToolRuntime::telemetry_tags`  (lines 61–66)

```
fn telemetry_tags(
        &'a self,
        _invocation: &'a ToolInvocation,
    ) -> BoxFuture<'a, ToolTelemetryTags>
```

**Purpose**: Provides optional extra labels for telemetry, which is the system's structured record of what happened. The default returns no extra labels.

**Data flow**: It receives the tool invocation and returns an asynchronous result containing a list of key-value tags.

**Call relations**: The registry calls this just before execution so tool-specific information can be added to timing, success, and failure records.

*Call graph*: 2 external calls (pin, new).


##### `CoreToolRuntime::post_tool_use_payload`  (lines 68–100)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the information sent to post-tool-use hooks after a function tool finishes. These hooks can inspect the tool name, input, and response before the model sees the result.

**Data flow**: It reads the invocation and the produced tool output. For function-call payloads, it creates a hook-facing package containing the hook tool name, tool-use id, input JSON, and response JSON; for unsupported payload kinds it returns nothing.

**Call relations**: handle_any_tool calls this after the tool has produced output. The registry later uses the returned payload to run post-tool-use hooks.

*Call graph*: calls 4 internal fn (function_hook_tool_name, post_tool_use_id, post_tool_use_input, post_tool_use_response); called by 1 (handle_any_tool).


##### `CoreToolRuntime::pre_tool_use_payload`  (lines 102–111)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the information sent to pre-tool-use hooks before a function tool runs. These hooks can approve, block, or sometimes rewrite the input.

**Data flow**: It reads the invocation's function arguments, converts them into hook-friendly JSON, pairs them with a hook-facing tool name, and returns that package. Non-function payloads produce no hook payload.

**Call relations**: The registry calls this before executing a tool. If it returns a payload, the registry runs pre-tool-use hooks with that data.

*Call graph*: calls 2 internal fn (function_hook_tool_input, function_hook_tool_name).


##### `CoreToolRuntime::with_updated_hook_input`  (lines 117–138)

```
fn with_updated_hook_input(
        &self,
        invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Rebuilds a tool invocation after a pre-tool-use hook rewrites the input. The default behavior serializes the updated JSON back into function arguments.

**Data flow**: It receives an existing invocation and rewritten JSON input. If the invocation is a function call, it replaces the argument string and returns the updated invocation; otherwise, or if serialization fails, it returns an error to show the model.

**Call relations**: dispatch_any_with_terminal_outcome uses this when a pre-tool-use hook says to continue with changed input. Tools with special hook contracts can override it.

*Call graph*: 2 external calls (to_string, RespondToModel).


##### `CoreToolRuntime::create_diff_consumer`  (lines 141–143)

```
fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Optionally creates an object that can read streamed argument changes while the model is still forming a tool call. The default says this tool does not support that feature.

**Data flow**: It takes no outside data and returns either a diff consumer or nothing.

**Call relations**: The registry exposes this so higher-level streaming code can ask a tool whether it wants partial argument updates.


##### `ToolArgumentDiffConsumer::finish`  (lines 154–156)

```
fn finish(&mut self) -> Result<Option<EventMsg>, FunctionCallError>
```

**Purpose**: Lets a streamed argument consumer flush or finalize any partial input before the tool call completes. The default has nothing to finish.

**Data flow**: It receives the consumer's current internal state and returns either a final event, no event, or an error.

**Call relations**: Streaming tool-call code can call this after all argument diffs have been consumed. Implementations may override it when partial input needs a final protocol event.


##### `AnyToolResult::into_response`  (lines 167–175)

```
fn into_response(self) -> ResponseInputItem
```

**Purpose**: Turns a completed tool result into the protocol item that can be sent back to the model. This is the normal model-facing response path.

**Data flow**: It consumes the stored call id, original payload, and tool output, then asks the output to format itself as a response item.

**Call relations**: Code that receives AnyToolResult from the registry uses this when it wants the ordinary conversation response.


##### `AnyToolResult::code_mode_result`  (lines 177–182)

```
fn code_mode_result(self) -> serde_json::Value
```

**Purpose**: Turns a completed tool result into the JSON value used by code-mode flows. This is separate from the usual model response format.

**Data flow**: It consumes the stored payload and output, then asks the output for its code-mode representation.

**Call relations**: Callers that dispatch tools for code-mode handling use this instead of into_response when they need a raw JSON-style result.


##### `PostToolUseFeedbackOutput::log_preview`  (lines 191–193)

```
fn log_preview(&self) -> String
```

**Purpose**: Keeps logging based on the original tool output even if a post-tool hook changes what the model sees. This preserves an honest preview of what the tool actually produced.

**Data flow**: It reads the wrapped original output and returns that output's log preview text.

**Call relations**: This wrapper is created when a post-tool-use hook supplies feedback that should replace the model-visible answer.


##### `PostToolUseFeedbackOutput::success_for_logging`  (lines 195–197)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Keeps the logged success or failure status from the original tool output. Hook feedback should not rewrite whether the tool itself succeeded.

**Data flow**: It asks the original output for its logging success flag and returns that value unchanged.

**Call relations**: The registry may wrap an output with PostToolUseFeedbackOutput after hooks run; telemetry still uses this original success signal.


##### `PostToolUseFeedbackOutput::to_response_item`  (lines 199–201)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Shows the hook's feedback message to the model instead of the original tool output. This lets a post-tool hook steer what the model is allowed to see.

**Data flow**: It receives the call id and payload, then formats the stored feedback output as the response item.

**Call relations**: After a post-tool-use hook returns feedback, the registry wraps the original result so this method controls the model-visible response.

*Call graph*: calls 1 internal fn (to_response_item).


##### `PostToolUseFeedbackOutput::code_mode_result`  (lines 203–205)

```
fn code_mode_result(&self, payload: &ToolPayload) -> Value
```

**Purpose**: Keeps code-mode output based on the original tool result, not the hook feedback text. This separates machine-oriented results from model-facing feedback.

**Data flow**: It receives the payload and returns the original output's code-mode JSON value.

**Call relations**: When the wrapped result is used in a code-mode path, this method prevents hook feedback from replacing the underlying structured result.


##### `override_tool_exposure`  (lines 237–246)

```
fn override_tool_exposure(
    handler: Arc<dyn CoreToolRuntime>,
    exposure: ToolExposure,
) -> Arc<dyn CoreToolRuntime>
```

**Purpose**: Returns a version of a tool with a different visibility setting. Visibility controls whether and how a tool is exposed to the model.

**Data flow**: It receives a tool runtime and the desired exposure. If the tool already has that exposure, it returns the same tool; otherwise it wraps the tool in an ExposureOverride.

**Call relations**: Tool-building code calls this when adding tools with a specific exposure policy, such as collaboration tools or tools added through an exposure override.

*Call graph*: called by 2 (add_with_exposure, add_collaboration_tools); 1 external calls (new).


##### `ExposureOverride::tool_name`  (lines 254–256)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the wrapped tool's name unchanged. Changing exposure should not rename the tool.

**Data flow**: It asks the inner tool for its name and returns it.

**Call relations**: The registry and tool listing code can treat the wrapper like the original tool because this method delegates to the wrapped handler.


##### `ExposureOverride::spec`  (lines 258–260)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Reports the wrapped tool's specification unchanged. The specification describes the tool's inputs and meaning.

**Data flow**: It asks the inner tool for its spec and returns it.

**Call relations**: When model-visible tool specs are built, this wrapper preserves the original tool description while changing only exposure.


##### `ExposureOverride::exposure`  (lines 262–264)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Returns the overridden visibility setting instead of the wrapped tool's own setting.

**Data flow**: It reads the wrapper's stored exposure value and returns it.

**Call relations**: Tool registration and model-spec generation use this to apply caller-chosen exposure rules.


##### `ExposureOverride::supports_parallel_tool_calls`  (lines 266–268)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Says whether the wrapped tool can run in parallel, while preventing hidden tools from being treated as parallel-callable. Hidden tools are not exposed for normal model tool calling.

**Data flow**: It checks the override exposure. If hidden, it returns false; otherwise it returns the inner tool's parallel-support answer.

**Call relations**: The registry and model-facing tool machinery ask this when deciding whether simultaneous calls are allowed.


##### `ExposureOverride::search_info`  (lines 270–272)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Returns the wrapped tool's search metadata unchanged. Search metadata helps tool-search features describe or find tools.

**Data flow**: It asks the inner tool for search information and returns it.

**Call relations**: Tool-search code can still discover the wrapped tool's search details even though exposure has been overridden.


##### `ExposureOverride::handle`  (lines 274–276)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Runs the wrapped tool exactly as usual. The wrapper changes visibility, not execution.

**Data flow**: It receives a tool invocation and passes it to the inner tool's handle method, returning the same future result.

**Call relations**: When the registry dispatches to an exposure-overridden tool, actual work is handed straight to the original handler.


##### `ExposureOverride::matches_kind`  (lines 280–282)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Uses the wrapped tool's payload compatibility check. Exposure does not affect what payload kinds the tool can understand.

**Data flow**: It receives a payload, forwards it to the inner tool, and returns the inner answer.

**Call relations**: The registry's compatibility check works the same for wrapped and unwrapped tools.


##### `ExposureOverride::waits_for_runtime_cancellation`  (lines 284–286)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Uses the wrapped tool's cancellation cleanup preference. Exposure does not change cancellation behavior.

**Data flow**: It asks the inner tool whether cancellation should wait for runtime cleanup and returns that value.

**Call relations**: Cancellation policy queries through the registry still reflect the original tool's needs.


##### `ExposureOverride::pre_tool_use_payload`  (lines 288–290)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Uses the wrapped tool's pre-hook payload. Exposure does not change what hooks see before execution.

**Data flow**: It receives an invocation, forwards it to the inner tool's pre-hook payload method, and returns the result.

**Call relations**: During dispatch, pre-tool-use hooks receive the same input they would have received without the exposure wrapper.


##### `ExposureOverride::post_tool_use_payload`  (lines 292–298)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Uses the wrapped tool's post-hook payload. Exposure does not change what hooks see after execution.

**Data flow**: It receives the invocation and output, forwards both to the inner tool, and returns the inner post-hook payload if any.

**Call relations**: handle_any_tool can collect post-tool hook data from wrapped tools without special cases.


##### `ExposureOverride::with_updated_hook_input`  (lines 300–307)

```
fn with_updated_hook_input(
        &self,
        invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Lets the wrapped tool rebuild an invocation after a hook rewrites input. The wrapper does not know the tool's input contract, so it delegates.

**Data flow**: It receives the invocation and updated JSON input, passes both to the inner tool, and returns the updated invocation or error.

**Call relations**: When pre-tool hooks rewrite input, dispatch still uses the real tool's rewrite logic even through an exposure wrapper.


##### `ExposureOverride::telemetry_tags`  (lines 309–314)

```
fn telemetry_tags(
        &'a self,
        invocation: &'a ToolInvocation,
    ) -> BoxFuture<'a, ToolTelemetryTags>
```

**Purpose**: Uses the wrapped tool's telemetry labels. Changing exposure should not remove tool-specific logging context.

**Data flow**: It receives the invocation, asks the inner tool for asynchronous telemetry tags, and returns them.

**Call relations**: The registry's telemetry flow gets the same extra tags whether or not exposure was overridden.


##### `ExposureOverride::create_diff_consumer`  (lines 316–318)

```
fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Uses the wrapped tool's streamed-argument diff consumer, if it has one. Exposure does not change streaming behavior.

**Data flow**: It asks the inner tool to create a diff consumer and returns that optional object.

**Call relations**: Streaming argument code can request diff consumers through the registry without caring about the exposure wrapper.


##### `ToolRegistry::new`  (lines 326–328)

```
fn new(tools: HashMap<ToolName, Arc<dyn CoreToolRuntime>>) -> Self
```

**Purpose**: Creates a registry from an already prepared map of tool names to tool runtimes. It is the basic constructor used by other setup helpers.

**Data flow**: It receives a name-to-tool map, stores it inside a ToolRegistry, and returns the registry.

**Call relations**: from_tools and test helpers build maps and then call this to create the final registry.

*Call graph*: called by 2 (dispatch_notifies_tool_lifecycle_contributors, handler_looks_up_namespaced_aliases_explicitly).


##### `ToolRegistry::from_tools`  (lines 330–341)

```
fn from_tools(tools: impl IntoIterator<Item = Arc<dyn CoreToolRuntime>>) -> Self
```

**Purpose**: Builds a registry from a list of tools while checking for duplicate names. Duplicate names would make lookup ambiguous, like two people at a front desk answering to the same badge number.

**Data flow**: It receives an iterable collection of tool runtimes, reads each tool's name, inserts each into a map, and reports an error or panic if the name is already present. It returns a registry containing the unique tools.

**Call relations**: Tool setup code calls this when assembling the model-visible tool set and runtime registry.

*Call graph*: calls 1 internal fn (error_or_panic); called by 3 (cancellation_after_handler_finishes_preserves_completed_lifecycle, cancellation_waiting_for_runtime_cleanup_emits_only_aborted_lifecycle, build_model_visible_specs_and_registry); 3 external calls (new, new, format!).


##### `ToolRegistry::empty_for_test`  (lines 344–346)

```
fn empty_for_test() -> Self
```

**Purpose**: Creates an empty registry for tests. This lets tests exercise missing-tool behavior without registering real tools.

**Data flow**: It creates an empty map and returns a registry around it.

**Call relations**: Test code uses this when it needs a registry that cannot find any requested tool.

*Call graph*: called by 1 (dispatch_lifecycle_trace_records_unsupported_tool_failures); 2 external calls (new, new).


##### `ToolRegistry::with_handler_for_test`  (lines 349–355)

```
fn with_handler_for_test(handler: Arc<T>) -> Self
```

**Purpose**: Creates a test registry containing exactly one tool handler. This is a convenient shortcut for focused dispatch tests.

**Data flow**: It receives a handler, reads its tool name, stores it in a one-entry map, and returns a registry.

**Call relations**: Tests use this to verify dispatch, tracing, payload compatibility, and waiting behavior with a controlled fake or test handler.

*Call graph*: called by 3 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_incompatible_payload_failures, missing_code_mode_wait_traces_only_the_wait_tool_call); 2 external calls (from, new).


##### `ToolRegistry::tool`  (lines 357–359)

```
fn tool(&self, name: &ToolName) -> Option<Arc<dyn CoreToolRuntime>>
```

**Purpose**: Looks up a tool by name and returns a shared reference to it if registered. This is the registry's private lookup helper.

**Data flow**: It receives a tool name, searches the internal map, clones the shared Arc pointer if found, and returns either the tool or nothing.

**Call relations**: Dispatch and query methods call this before asking a tool about execution, parallel support, cancellation, or diff consumers.

*Call graph*: called by 4 (create_diff_consumer, dispatch_any_with_terminal_outcome, supports_parallel_tool_calls, waits_for_runtime_cancellation).


##### `ToolRegistry::tool_names_for_test`  (lines 362–366)

```
fn tool_names_for_test(&self) -> Vec<ToolName>
```

**Purpose**: Returns the registered tool names in sorted order for tests. Sorting makes test expectations stable.

**Data flow**: It reads all keys from the internal tool map, clones them into a list, sorts the list, and returns it.

**Call relations**: Test-only wrapper code calls this to check which tools were registered.

*Call graph*: called by 1 (registered_tool_names_for_test).


##### `ToolRegistry::tool_exposure`  (lines 369–371)

```
fn tool_exposure(&self, name: &ToolName) -> Option<ToolExposure>
```

**Purpose**: Returns a registered tool's exposure setting for tests. This helps tests confirm whether tools are visible, hidden, or otherwise exposed as expected.

**Data flow**: It receives a tool name, looks it up in the map, and returns its exposure if found.

**Call relations**: Test helper code calls this when verifying exposure decisions made during tool setup.

*Call graph*: called by 1 (tool_exposure_for_test).


##### `ToolRegistry::create_diff_consumer`  (lines 373–378)

```
fn create_diff_consumer(
        &self,
        name: &ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Asks a registered tool to create a streamed-argument diff consumer. If the tool is missing or does not support diffs, it returns nothing.

**Data flow**: It receives a tool name, looks up the tool, and asks that tool for an optional diff consumer.

**Call relations**: Higher-level streaming code calls into the registry here so it can route partial argument updates to the correct tool.

*Call graph*: calls 1 internal fn (tool); called by 1 (create_diff_consumer).


##### `ToolRegistry::supports_parallel_tool_calls`  (lines 380–383)

```
fn supports_parallel_tool_calls(&self, name: &ToolName) -> Option<bool>
```

**Purpose**: Reports whether a named tool supports being called in parallel with other tools. This helps the system avoid unsafe simultaneous work.

**Data flow**: It receives a tool name, looks up the tool, and returns the tool's parallel-support flag if found.

**Call relations**: Tool capability checks call this before allowing or advertising parallel tool calls.

*Call graph*: calls 1 internal fn (tool); called by 1 (tool_supports_parallel).


##### `ToolRegistry::waits_for_runtime_cancellation`  (lines 385–388)

```
fn waits_for_runtime_cancellation(&self, name: &ToolName) -> Option<bool>
```

**Purpose**: Reports whether a named tool wants cancellation to wait for its cleanup. This is important for tools that must close resources or finish teardown safely.

**Data flow**: It receives a tool name, looks up the tool, and returns the tool's cancellation-wait preference if found.

**Call relations**: Cancellation orchestration code calls this when deciding whether to wait for a tool runtime after cancellation.

*Call graph*: calls 1 internal fn (tool); called by 1 (tool_waits_for_runtime_cancellation).


##### `ToolRegistry::dispatch_any`  (lines 391–397)

```
async fn dispatch_any(
        &self,
        invocation: ToolInvocation,
    ) -> Result<AnyToolResult, FunctionCallError>
```

**Purpose**: Runs a tool invocation through the full registry dispatch path without an external terminal-outcome flag. It is the simpler public entry point for normal dispatch.

**Data flow**: It receives a tool invocation, passes it to dispatch_any_with_terminal_outcome with no shared completion marker, awaits the result, and returns either a tool result or an error.

**Call relations**: Callers that do not need special lifecycle coordination use this convenience method.

*Call graph*: calls 1 internal fn (dispatch_any_with_terminal_outcome).


##### `ToolRegistry::dispatch_any_with_terminal_outcome`  (lines 403–668)

```
async fn dispatch_any_with_terminal_outcome(
        &self,
        mut invocation: ToolInvocation,
        terminal_outcome_reached: Option<Arc<AtomicBool>>,
    ) -> Result<AnyToolResult, FunctionCa
```

**Purpose**: Runs the complete tool-call lifecycle: lookup, validation, pre-hooks, execution, telemetry, post-hooks, lifecycle notifications, and final result shaping. This is the heart of the file.

**Data flow**: It receives a tool invocation and optionally a shared flag saying whether some other path has already claimed the terminal outcome. It records active-turn state and telemetry tags, finds the tool, rejects unknown or incompatible calls, runs pre-tool-use hooks that may block or rewrite input, executes the tool while logging timing and success, runs post-tool-use hooks on successful output, records extra context, sends the final lifecycle notification if not already claimed, and returns either the completed AnyToolResult or a FunctionCallError.

**Call relations**: dispatch_any and code-mode dispatch call this when a tool must actually run. Inside the flow it calls helper functions such as handle_any_tool, notify_tool_finish_if_unclaimed, hook runners, telemetry helpers, and payload-format helpers.

*Call graph*: calls 13 internal fn (record_additional_contexts, run_post_tool_use_hooks, run_pre_tool_use_hooks, emit_metric_for_tool_read, permission_profile_policy_tag, permission_profile_sandbox_tag, from_text, flat_tool_name, notify_tool_start, tool (+3 more)); called by 2 (dispatch_any, dispatch_tool_call_with_code_mode_result_inner); 9 external calls (new, new, with_capacity, clone, format!, matches!, new, Fatal, RespondToModel).


##### `notify_tool_finish_if_unclaimed`  (lines 671–682)

```
async fn notify_tool_finish_if_unclaimed(
    invocation: &ToolInvocation,
    terminal_outcome_reached: Option<&AtomicBool>,
    outcome: ToolCallOutcome,
) -> bool
```

**Purpose**: Sends a tool-finished lifecycle event only if no other part of the system has already sent the terminal outcome. This prevents duplicate final notifications.

**Data flow**: It receives the invocation, an optional atomic boolean flag, and the outcome to report. If the flag exists and was already set, it returns false; otherwise it marks the flag, sends the finish notification, and returns true.

**Call relations**: dispatch_any_with_terminal_outcome uses this after blocked, failed, or completed tool paths so lifecycle listeners get exactly one final event.

*Call graph*: calls 1 internal fn (notify_tool_finish); called by 1 (dispatch_any_with_terminal_outcome).


##### `handle_any_tool`  (lines 684–709)

```
async fn handle_any_tool(
    tool: &dyn CoreToolRuntime,
    invocation: ToolInvocation,
) -> Result<AnyToolResult, FunctionCallError>
```

**Purpose**: Actually calls the selected tool handler and packages its output with the metadata needed later. It also marks memory state as polluted if the output brought in external context while that memory mode is disabled.

**Data flow**: It receives a tool runtime and invocation, copies the call id and payload, awaits the tool's handle method, optionally updates persistent thread memory state, builds post-tool-use hook payload from the output, and returns an AnyToolResult.

**Call relations**: dispatch_any_with_terminal_outcome calls this inside its telemetry wrapper. It is the bridge between orchestration and the individual tool's own execution.

*Call graph*: calls 2 internal fn (post_tool_use_payload, mark_thread_memory_mode_polluted); 2 external calls (clone, handle).


##### `function_hook_tool_name`  (lines 711–722)

```
fn function_hook_tool_name(invocation: &ToolInvocation) -> HookToolName
```

**Purpose**: Converts an internal tool name into the name format used by hooks. It preserves a special friendly name for spawn_agent while flattening most names into a single string.

**Data flow**: It reads the invocation's tool name and namespace. For the recognized spawn_agent case it returns the special hook name; otherwise it returns a new hook name based on the flattened tool name.

**Call relations**: CoreToolRuntime::pre_tool_use_payload and CoreToolRuntime::post_tool_use_payload call this so hooks see stable, expected tool names.

*Call graph*: calls 3 internal fn (flat_tool_name, new, spawn_agent); called by 2 (post_tool_use_payload, pre_tool_use_payload); 1 external calls (matches!).


##### `function_hook_tool_input`  (lines 724–730)

```
fn function_hook_tool_input(arguments: &str) -> Value
```

**Purpose**: Converts a function tool's raw argument string into the JSON value that hooks receive as tool_input. Empty input becomes an empty object, valid JSON stays structured, and invalid JSON becomes a plain string.

**Data flow**: It receives the argument text, trims and checks whether it is empty, then either returns an empty JSON object, parsed JSON, or a JSON string containing the original text.

**Call relations**: CoreToolRuntime::pre_tool_use_payload uses this when preparing pre-hook input. post_tool_use_payload may also use the same kind of hook-facing input through tool output helpers.

*Call graph*: called by 1 (pre_tool_use_payload); 3 external calls (Object, new, from_str).


##### `unsupported_tool_call_message`  (lines 732–737)

```
fn unsupported_tool_call_message(payload: &ToolPayload, tool_name: &ToolName) -> String
```

**Purpose**: Creates the error message shown when the registry cannot find a requested tool. It gives a slightly different message for custom tool calls.

**Data flow**: It receives the payload and tool name, checks whether the payload is a custom call, and returns a formatted message string.

**Call relations**: dispatch_any_with_terminal_outcome calls this when tool lookup fails, then records the failure and returns the message to the model.

*Call graph*: called by 1 (dispatch_any_with_terminal_outcome); 1 external calls (format!).


### `tui/src/app/app_server_event_targets.rs`

`util` · `request handling`

The app server sends many kinds of messages to the TUI. Some messages are about one specific conversation thread, some are about the whole app, and some are global notices. This file answers the practical question: “Where should this message go?” Think of it like sorting mail: a letter with an apartment number goes to one apartment, a building notice goes to the lobby, and a city-wide alert goes to everyone.

For incoming server requests, `server_request_thread_id` looks at request types that carry a thread ID and tries to turn that text ID into a real `ThreadId`. If the request is not tied to a thread, it returns nothing.

For notifications, `server_notification_thread_target` is more detailed. It checks each notification kind and decides whether it points to a thread, is app-scoped, is global, or contains a broken thread ID. The special `InvalidThreadId` result matters because it lets the caller distinguish “this was meant for a thread but the ID was malformed” from “this was never meant for a thread.”

The tests at the bottom cover important edge cases: warnings with and without thread IDs, guardian warnings, MCP server status messages, and thread settings updates.

#### Function details

##### `server_request_thread_id`  (lines 7–32)

```
fn server_request_thread_id(request: &ServerRequest) -> Option<ThreadId>
```

**Purpose**: This function extracts the conversation thread ID from a server request when that request is meant for a specific thread. Callers use it to route approval prompts and user-input requests to the right conversation.

**Data flow**: It receives a `ServerRequest`. For request types that include a `thread_id` string, it tries to parse that string into a `ThreadId`, which is the program’s safe internal form of a thread identifier. If parsing succeeds, it returns that ID; if parsing fails or the request is not thread-specific, it returns nothing.

**Call relations**: When `handle_server_request_event` receives a request from the app server, it calls this helper before deciding where the request belongs. This function delegates the actual text-to-ID conversion to `ThreadId::from_string`, then hands the caller either a usable thread ID or a clear “no thread target” result.

*Call graph*: calls 1 internal fn (from_string); called by 1 (handle_server_request_event).


##### `server_notification_thread_target`  (lines 42–186)

```
fn server_notification_thread_target(
    notification: &ServerNotification,
) -> ServerNotificationThreadTarget
```

**Purpose**: This function decides the target scope for a server notification: one thread, the whole app, all users/screens globally, or an invalid thread reference. It keeps notification routing consistent across many different notification types.

**Data flow**: It receives a `ServerNotification`. It first checks the notification kind and pulls out a thread ID string when that kind has one. If there is a thread ID, it tries to parse it into a `ThreadId`; a valid one becomes `Thread`, and a malformed one becomes `InvalidThreadId`. If there is no thread ID, most such notifications become `Global`, while MCP server status updates without a thread become `AppScoped` because they affect the app’s server setup rather than one conversation.

**Call relations**: During normal notification handling, `handle_server_notification_event` calls this function to decide where the update should be shown or applied. The test functions also call it with carefully chosen notifications to prove that warnings, guardian warnings, MCP status updates, and thread settings updates are routed as intended.

*Call graph*: calls 1 internal fn (from_string); called by 7 (guardian_warning_notifications_route_to_threads, mcp_startup_notifications_route_to_threads, mcp_startup_notifications_without_threads_are_app_scoped, thread_settings_updated_notifications_route_to_threads, warning_notifications_route_to_threads_when_thread_id_is_present, warning_notifications_without_threads_are_global, handle_server_notification_event); 2 external calls (InvalidThreadId, Thread).


##### `tests::test_thread_settings`  (lines 208–232)

```
fn test_thread_settings() -> ThreadSettings
```

**Purpose**: This test helper builds a realistic `ThreadSettings` value so tests can create a thread-settings notification without repeating a large block of setup data. It exists only to support the test case for thread settings updates.

**Data flow**: It creates a fake working directory, fills in model, approval, sandbox, collaboration, and reasoning settings, and returns the completed `ThreadSettings` object. It does not change outside state.

**Call relations**: The thread-settings routing test calls this helper when building a `ThreadSettingsUpdated` notification. It uses the test path helper to create a predictable absolute path for the fake thread settings.

*Call graph*: 1 external calls (test_path_buf).


##### `tests::warning_notifications_without_threads_are_global`  (lines 235–244)

```
fn warning_notifications_without_threads_are_global()
```

**Purpose**: This test checks that a warning notification with no thread ID is treated as a global notification. That matters because such warnings should not be attached to an arbitrary conversation.

**Data flow**: It creates a warning notification whose `thread_id` field is empty, sends it through `server_notification_thread_target`, and compares the result with the expected `Global` target.

**Call relations**: The Rust test runner invokes this test. The test exercises the same routing helper used by normal notification handling and confirms one important branch of its warning behavior.

*Call graph*: calls 1 internal fn (server_notification_thread_target); 2 external calls (Warning, assert_eq!).


##### `tests::warning_notifications_route_to_threads_when_thread_id_is_present`  (lines 247–257)

```
fn warning_notifications_route_to_threads_when_thread_id_is_present()
```

**Purpose**: This test checks that a warning notification is routed to a specific thread when it includes a valid thread ID. It protects against accidentally treating all warnings as global.

**Data flow**: It creates a new thread ID, puts that ID into a warning notification, passes the notification to `server_notification_thread_target`, and checks that the returned target is exactly that thread.

**Call relations**: The Rust test runner invokes this test. It builds a warning, calls the production routing helper, and verifies that the helper parses and preserves the thread identity.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 2 external calls (Warning, assert_eq!).


##### `tests::guardian_warning_notifications_route_to_threads`  (lines 260–270)

```
fn guardian_warning_notifications_route_to_threads()
```

**Purpose**: This test checks that guardian warning notifications always route to their stated thread. Guardian warnings are safety or review-related messages, so sending them to the right conversation is important.

**Data flow**: It creates a new thread ID, builds a guardian warning notification containing that ID, runs it through `server_notification_thread_target`, and expects a `Thread` target with the same ID.

**Call relations**: The Rust test runner invokes this test. It directly exercises the guardian-warning branch of the notification routing helper.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 2 external calls (GuardianWarning, assert_eq!).


##### `tests::mcp_startup_notifications_route_to_threads`  (lines 273–286)

```
fn mcp_startup_notifications_route_to_threads()
```

**Purpose**: This test checks that an MCP server status update with a thread ID is routed to that thread. MCP means Model Context Protocol, a way external tools or services can connect to the app.

**Data flow**: It creates a new thread ID, builds an MCP server status notification that includes the ID and a failed startup state, passes it to `server_notification_thread_target`, and checks that the result points to the same thread.

**Call relations**: The Rust test runner invokes this test. It confirms the thread-specific path for MCP server status updates, matching what normal notification handling relies on.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 2 external calls (McpServerStatusUpdated, assert_eq!).


##### `tests::mcp_startup_notifications_without_threads_are_app_scoped`  (lines 289–301)

```
fn mcp_startup_notifications_without_threads_are_app_scoped()
```

**Purpose**: This test checks the special case where an MCP server status update has no thread ID. Instead of being global, it should be app-scoped because it describes app-level tool-server state.

**Data flow**: It builds an MCP server status notification with no `thread_id`, sends it through `server_notification_thread_target`, and checks that the result is `AppScoped`.

**Call relations**: The Rust test runner invokes this test. It protects the special MCP routing rule inside the production helper, so callers can distinguish app-level server status from truly global notifications.

*Call graph*: calls 1 internal fn (server_notification_thread_target); 2 external calls (McpServerStatusUpdated, assert_eq!).


##### `tests::thread_settings_updated_notifications_route_to_threads`  (lines 304–315)

```
fn thread_settings_updated_notifications_route_to_threads()
```

**Purpose**: This test checks that thread settings update notifications are routed back to the thread whose settings changed. Without this, a settings change in one conversation could appear in the wrong place.

**Data flow**: It creates a new thread ID, builds realistic thread settings with `test_thread_settings`, wraps them in a `ThreadSettingsUpdated` notification, passes that notification to `server_notification_thread_target`, and expects the matching thread target.

**Call relations**: The Rust test runner invokes this test. It uses the shared test settings helper, then exercises the thread-settings branch of the notification routing helper.

*Call graph*: calls 2 internal fn (new, server_notification_thread_target); 3 external calls (ThreadSettingsUpdated, assert_eq!, test_thread_settings).


### App server feature adapters
These files cover the app server's narrower feature-specific RPC adapters for filesystem, plugins, marketplace, search, feedback, git, remote control, and attestation-related operations.

### `app-server/src/attestation.rs`

`domain_logic` · `request handling`

This file is the bridge between core server code that wants an attestation header and the app-server connection that can actually create one. The core code knows only about an `AttestationProvider`, which is a small interface for getting a header. This file supplies an implementation of that interface for the app server.

When a request needs attestation, the provider looks up a connection for the current thread that is able to generate attestation data. It then sends that connection an `AttestationGenerate` request and waits briefly for a reply. The timeout is only 100 milliseconds, so attestation cannot hold up the server for long. Think of it like asking a nearby clerk for a stamp: if the clerk answers quickly, the request gets the stamp; if not, the request gets a note saying what went wrong.

The header value is always a small JSON envelope. It includes a version number, a status code, and, when generation succeeds, the token returned by the client. Failures are not silent: timeout, request failure, cancellation, and malformed replies each get their own status code. That means downstream code can tell the difference between “valid token present” and “the app server could not get one.”

#### Function details

##### `app_server_attestation_provider`  (lines 21–29)

```
fn app_server_attestation_provider(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
) -> Arc<dyn AttestationProvider>
```

**Purpose**: Creates the app server's attestation provider, which core code can use when it needs an attestation header. It stores access to the outgoing-message channel and the thread state lookup needed to find a suitable client connection.

**Data flow**: It receives a shared outgoing message sender and a thread state manager. It keeps only a weak reference to the sender, so this provider does not keep the whole messaging system alive by itself. It returns a shared `AttestationProvider` object ready for use by the core server.

**Call relations**: This is the construction point for the provider. Later, when core code asks that provider for a header, the provider's `header_for_request` method does the actual work.

*Call graph*: 2 external calls (downgrade, new).


##### `AppServerAttestationProvider::fmt`  (lines 37–41)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a simple debug display for the provider. This is useful when logging or inspecting the provider without exposing internal fields.

**Data flow**: It receives a formatter, writes the struct name `AppServerAttestationProvider` into it, and returns whether formatting succeeded. It does not read or change the provider's stored connection data.

**Call relations**: This is called by Rust's debugging and logging machinery when the provider is printed with debug formatting. It does not participate in attestation generation itself.

*Call graph*: 1 external calls (debug_struct).


##### `AppServerAttestationProvider::header_for_request`  (lines 45–60)

```
fn header_for_request(&self, context: AttestationContext) -> GenerateAttestationFuture<'_>
```

**Purpose**: Starts the process of getting an attestation header for a particular request context. It returns future work, meaning the actual waiting happens asynchronously instead of blocking the server thread.

**Data flow**: It receives an attestation context containing the thread id. It first tries to turn its weak outgoing-message reference back into a usable shared sender. If that sender no longer exists, it returns a future that produces no header. Otherwise, it clones the thread state manager and starts an asynchronous request for a header value. If a JSON header string comes back, it converts it into an HTTP header value; if that conversion fails, it returns no header.

**Call relations**: Core attestation code calls this through the `AttestationProvider` interface. This method delegates the real client request and timeout behavior to `request_attestation_header_value_with_timeout`.

*Call graph*: calls 1 internal fn (request_attestation_header_value_with_timeout); 3 external calls (pin, upgrade, clone).


##### `request_attestation_header_value_with_timeout`  (lines 63–128)

```
async fn request_attestation_header_value_with_timeout(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
    thread_id: codex_protocol::ThreadId,
    timeout_dur
```

**Purpose**: Asks an attestation-capable client connection to generate a token, but gives up quickly if it cannot get a usable answer. It turns success and several failure cases into the standard app-server attestation header JSON.

**Data flow**: It receives the outgoing-message sender, the thread state manager, a thread id, and a timeout length. It asks the thread state manager for the first connection on that thread that can generate attestations. If there is no such connection, it returns no header. If there is one, it sends an `AttestationGenerate` request to that connection and waits for the reply. A successful reply is decoded into an `AttestationGenerateResponse`, and its token is wrapped into a header envelope. A request failure, cancellation, timeout, or malformed reply is logged and turned into a header envelope with an error status and no token.

**Call relations**: `AppServerAttestationProvider::header_for_request` calls this when core code needs a header. This function hands off final JSON creation to `app_server_attestation_header_value`, and it relies on the thread state manager to choose the right connection before sending the request.

*Call graph*: calls 2 internal fn (app_server_attestation_header_value, first_attestation_capable_connection_for_thread); called by 1 (header_for_request); 3 external calls (AttestationGenerate, timeout, warn!).


##### `AppServerAttestationStatus::code`  (lines 140–148)

```
fn code(self) -> u8
```

**Purpose**: Converts an attestation result status into the small numeric code stored in the header JSON. These compact codes let the receiver distinguish success from different app-server-side failures.

**Data flow**: It receives one status value, such as success, timeout, or malformed response. It returns the matching number: success is 0, and each failure type has its own nonzero code. It does not change any state.

**Call relations**: `app_server_attestation_header_value` calls this while building the JSON envelope. The codes produced here are what make the serialized header understandable to later readers.

*Call graph*: called by 1 (app_server_attestation_header_value).


##### `app_server_attestation_header_value`  (lines 159–170)

```
fn app_server_attestation_header_value(
    status: AppServerAttestationStatus,
    token: Option<&str>,
) -> Option<String>
```

**Purpose**: Builds the actual string that can be placed into an attestation header. It wraps the status and optional token in a small versioned JSON object.

**Data flow**: It receives a status and, optionally, a token string. It creates an envelope with version `1`, the numeric status code, and the token only when one is present. It serializes that envelope to JSON and returns the JSON string, or returns no value if serialization unexpectedly fails.

**Call relations**: `request_attestation_header_value_with_timeout` calls this for both successful and failed attestation attempts. It calls `AppServerAttestationStatus::code` to translate the status into the number stored in the header.

*Call graph*: calls 1 internal fn (code); called by 1 (request_attestation_header_value_with_timeout); 1 external calls (to_string).


##### `tests::app_server_attestation_header_value_wraps_opaque_client_payloads`  (lines 179–187)

```
fn app_server_attestation_header_value_wraps_opaque_client_payloads()
```

**Purpose**: Checks that a successful client token is preserved exactly inside the app-server header envelope. This protects against accidentally altering the token while wrapping it.

**Data flow**: It supplies the success status and a sample opaque token string to `app_server_attestation_header_value`. It compares the returned JSON string with the exact expected output, including the version, success code, and token field.

**Call relations**: This test exercises the header-building helper directly. It confirms the success path used by `request_attestation_header_value_with_timeout` after a valid client response.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::app_server_attestation_header_value_reports_app_server_failures`  (lines 190–219)

```
fn app_server_attestation_header_value_reports_app_server_failures()
```

**Purpose**: Checks that each app-server-side failure is represented by the correct JSON status code and does not include a token. This helps ensure callers can reliably tell why attestation was missing.

**Data flow**: It calls `app_server_attestation_header_value` several times with timeout, request failed, request canceled, and malformed response statuses. For each one, it compares the output to the exact JSON string expected for that failure code.

**Call relations**: This test covers the failure envelopes produced by `request_attestation_header_value_with_timeout`. It guards the meaning of the numeric status codes defined by `AppServerAttestationStatus::code`.

*Call graph*: 1 external calls (assert_eq!).


### `app-server/src/fs_watch.rs`

`io_transport` · `request handling and connection cleanup`

This file is the server’s “watch this file for me” desk. A client sends a watch request with a path and a watch ID. The manager registers that path with the lower-level file watcher, remembers which connection owns the watch, and starts a background task that listens for change events. When changes arrive, it waits briefly to group nearby events together. This delay is called debouncing: like waiting a moment before announcing every raindrop, so you can say “it started raining” once instead of shouting many times. The task then sends an FsChanged notification back only to the connection that requested the watch.

The manager stores watches in a map keyed by both connection ID and watch ID. That detail matters because two different clients may use the same watch ID without conflict, while the same client may not reuse one. Unwatching removes only the matching entry for that connection. When a connection closes, its watches are removed so stale state does not build up.

If the real file watcher cannot start, the manager falls back to a no-op watcher. That means the server can still run, but file-change notifications will not be produced by the core watcher.

#### Function details

##### `FsWatchManager::new`  (lines 54–63)

```
fn new(outgoing: Arc<OutgoingMessageSender>) -> Self
```

**Purpose**: Creates a filesystem watch manager for normal server use. It tries to start the real file watcher, but if that fails it logs a warning and uses a harmless no-op watcher so the server can keep running.

**Data flow**: It receives the shared outgoing-message sender. It attempts to build a FileWatcher; on success it keeps that watcher, and on failure it creates a no-op replacement. It then passes the outgoing sender and chosen watcher into the internal constructor and returns a ready FsWatchManager.

**Call relations**: This is the public setup path used when the server needs a watch manager. It delegates the actual struct setup to FsWatchManager::new_with_file_watcher, which is also useful in tests because tests can inject a fake or no-op watcher.

*Call graph*: calls 2 internal fn (new, noop); called by 1 (new); 3 external calls (new, new_with_file_watcher, warn!).


##### `FsWatchManager::new_with_file_watcher`  (lines 65–74)

```
fn new_with_file_watcher(
        outgoing: Arc<OutgoingMessageSender>,
        file_watcher: Arc<FileWatcher>,
    ) -> Self
```

**Purpose**: Builds a watch manager from an already chosen file watcher. This is the shared construction step used by normal startup and by tests that want predictable watcher behavior.

**Data flow**: It receives an outgoing-message sender and a file watcher. It stores both in shared references and creates an empty state map protected by an asynchronous mutex, which is a lock that can be safely waited on in async code. It returns the completed manager.

**Call relations**: FsWatchManager::new calls this after deciding whether to use a real or no-op watcher. The test helper manager_with_noop_watcher also calls it directly so tests do not depend on real operating-system file watching.

*Call graph*: called by 1 (manager_with_noop_watcher); 3 external calls (new, new, default).


##### `FsWatchManager::watch`  (lines 76–144)

```
async fn watch(
        &self,
        connection_id: ConnectionId,
        params: FsWatchParams,
    ) -> Result<FsWatchResponse, JSONRPCErrorError>
```

**Purpose**: Starts watching a requested path for one client connection. It records ownership of the watch, rejects duplicate watch IDs for the same connection, and starts a background listener that sends file-change notifications back to that client.

**Data flow**: It receives a connection ID and watch parameters containing a watch ID and path. It creates a key from the connection and watch ID, subscribes to file watcher events, registers the requested path, and stores a watch entry in the manager state. If that key already exists, it returns a JSON-RPC error saying the watch ID already exists. If registration succeeds, it spawns a task that receives debounced file events, converts changed relative paths into full paths under the watched root, sorts them, and sends an FsChanged notification to the same connection. The function returns a response echoing the watched path.

**Call relations**: This is called when the server receives a client watch request. It relies on the lower-level FileWatcher for raw filesystem events, wraps those events with DebouncedWatchReceiver to avoid noisy bursts, and hands finished notifications to OutgoingMessageSender so they reach the correct client connection.

*Call graph*: calls 2 internal fn (invalid_request, new); called by 1 (watch); 7 external calls (FsChanged, format!, channel, pin!, select!, spawn, vec!).


##### `FsWatchManager::unwatch`  (lines 146–164)

```
async fn unwatch(
        &self,
        connection_id: ConnectionId,
        params: FsUnwatchParams,
    ) -> Result<FsUnwatchResponse, JSONRPCErrorError>
```

**Purpose**: Stops a previously created watch for the requesting connection. It is intentionally scoped by connection, so a client cannot stop another client’s watch just by knowing its watch ID.

**Data flow**: It receives a connection ID and an unwatch request containing a watch ID. It builds the same ownership key used by watch, removes that entry from the state map if it exists, and asks the background task to terminate. If a task was found, it waits for confirmation that the task has stopped before returning, so no later notification can arrive after the unwatch response. It always returns an empty successful response.

**Call relations**: This runs when the server receives an unwatch request. It coordinates with the task started by FsWatchManager::watch through a one-time channel, which is a small pipe used to send a single shutdown signal and receive a single done signal.

*Call graph*: called by 1 (unwatch); 1 external calls (channel).


##### `FsWatchManager::connection_closed`  (lines 166–172)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Cleans up watches owned by a connection that has gone away. This prevents abandoned watch records from staying in memory after a client disconnects.

**Data flow**: It receives the closed connection’s ID. It locks the watch state and removes every entry whose key belongs to that connection. It does not return data; the state map is left containing only watches owned by other connections.

**Call relations**: This is called as part of connection cleanup. It complements unwatch: unwatch removes one named watch during normal use, while connection_closed removes all watches for a disconnected client at once.

*Call graph*: called by 1 (connection_closed).


##### `tests::absolute_path`  (lines 184–191)

```
fn absolute_path(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Creates an AbsolutePathBuf for tests and fails clearly if the test accidentally provides a relative path. This keeps test setup honest because watch requests require absolute paths.

**Data flow**: It receives a PathBuf. It checks that the path is absolute, converts it into the project’s absolute-path type, and returns that value. If the path is not absolute or cannot be converted, the test fails immediately.

**Call relations**: The filesystem-watch tests use this helper whenever they create watch parameters from temporary files. It keeps each test focused on watch behavior instead of repeating path-validation boilerplate.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (assert!).


##### `tests::manager_with_noop_watcher`  (lines 193–203)

```
fn manager_with_noop_watcher() -> FsWatchManager
```

**Purpose**: Builds a FsWatchManager for tests that does not depend on real filesystem watching. This makes tests stable and focused on bookkeeping, ownership, and request behavior.

**Data flow**: It creates a small outgoing-message channel, creates an OutgoingMessageSender with analytics disabled, creates a no-op FileWatcher, and passes both into FsWatchManager::new_with_file_watcher. It returns the test-ready manager.

**Call relations**: The test cases call this helper before exercising watch, unwatch, and connection cleanup. By using the internal constructor, it bypasses normal watcher startup and gives tests a controlled environment.

*Call graph*: calls 4 internal fn (disabled, new_with_file_watcher, new, noop); 2 external calls (new, channel).


##### `tests::watch_uses_client_id_and_tracks_the_owner_scoped_entry`  (lines 206–235)

```
async fn watch_uses_client_id_and_tracks_the_owner_scoped_entry()
```

**Purpose**: Verifies that starting a watch records both the connection ID and the watch ID. This proves that watch ownership is tracked per client, not just by a shared string name.

**Data flow**: The test creates a temporary file, builds a no-op-watch manager, converts the file path to an absolute path, and calls watch for connection 1 with a watch ID. It checks that the response contains the same path and that the internal state contains exactly one key combining connection 1 with that watch ID.

**Call relations**: This test exercises FsWatchManager::watch through the normal request-shaped inputs. It uses manager_with_noop_watcher and absolute_path to keep setup simple, then directly inspects the manager’s state to confirm the ownership key was stored correctly.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert_eq!, write).


##### `tests::unwatch_is_scoped_to_the_connection_that_created_the_watch`  (lines 238–280)

```
async fn unwatch_is_scoped_to_the_connection_that_created_the_watch()
```

**Purpose**: Verifies that only the connection that created a watch can remove it. This protects one client from accidentally or maliciously cancelling another client’s watch.

**Data flow**: The test creates a watch under connection 1. It then tries to unwatch the same watch ID from connection 2 and confirms the entry is still present. Finally it unwatches from connection 1 and confirms the entry is gone.

**Call relations**: This test follows the watch-then-unwatch flow. It calls FsWatchManager::watch to create state, then FsWatchManager::unwatch twice to show that the connection ID is part of the lookup and not just the watch ID.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert!, write).


##### `tests::watch_rejects_duplicate_id_for_the_same_connection`  (lines 283–315)

```
async fn watch_rejects_duplicate_id_for_the_same_connection()
```

**Purpose**: Verifies that one connection cannot create two watches with the same watch ID. This prevents ambiguous later unwatch requests and keeps each client’s watch names unique.

**Data flow**: The test creates two temporary files. It watches the first file using connection 1 and a chosen watch ID. It then tries to watch the second file using the same connection and same watch ID, expects an error, checks the error message, and confirms only one watch remains in state.

**Call relations**: This test targets the duplicate-check branch inside FsWatchManager::watch. It uses ordinary watch requests and confirms that the manager returns the invalid-request error instead of replacing or adding a second entry.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert_eq!, write).


##### `tests::connection_closed_removes_only_that_connections_watches`  (lines 318–376)

```
async fn connection_closed_removes_only_that_connections_watches()
```

**Purpose**: Verifies that disconnect cleanup removes all watches for the closed connection while leaving other clients’ watches alone. This matters when multiple clients are connected at the same time.

**Data flow**: The test creates three temporary files, then registers two watches for connection 1 and one watch for connection 2. It calls connection_closed for connection 1. Afterward, it checks that the state contains only the watch owned by connection 2, and also confirms the earlier watch response returned the expected path.

**Call relations**: This test exercises FsWatchManager::connection_closed after several calls to FsWatchManager::watch. It shows how connection cleanup differs from unwatch: instead of removing one named watch, it removes every watch owned by the closing connection.

*Call graph*: 6 external calls (new, new, absolute_path, manager_with_noop_watcher, assert_eq!, write).


### `app-server/src/request_processors/fs_processor.rs`

`orchestration` · `request handling and connection cleanup`

This file is the app server’s front desk for file-system work. A client may ask to read a file, write a file, list a folder, delete something, copy something, or watch for changes. This processor receives those structured requests, checks that a local file system is available, translates plain path strings into the project’s path format, calls the underlying file-system service, and returns protocol-friendly responses.

The main type, FsRequestProcessor, holds two tools. The first is an EnvironmentManager, which knows whether there is a local environment and can provide the actual file-system object. The second is an FsWatchManager, which keeps track of file watches for each client connection. Think of the processor like a hotel receptionist: it does not clean rooms or repair plumbing itself, but it checks the request, calls the right department, and gives the guest a clear answer.

File contents are sent as base64 text, which is a safe way to carry raw bytes inside JSON. When reading, bytes become base64. When writing, base64 is decoded back into bytes. Errors are also translated into JSON-RPC errors, so callers receive consistent messages: bad input becomes an invalid request, while unexpected file-system trouble becomes an internal error.

#### Function details

##### `FsRequestProcessor::new`  (lines 43–51)

```
fn new(
        environment_manager: Arc<EnvironmentManager>,
        fs_watch_manager: FsWatchManager,
    ) -> Self
```

**Purpose**: Creates a new file-system request processor with the two services it needs: access to the current environment and access to file-watch tracking.

**Data flow**: It receives a shared EnvironmentManager and an FsWatchManager. It stores both inside a new FsRequestProcessor. The result is a ready-to-use processor that later request handlers can call.

**Call relations**: It is called during setup by a higher-level new function. After construction, the rest of the server can use this processor whenever a client sends file-system requests.

*Call graph*: called by 1 (new).


##### `FsRequestProcessor::file_system`  (lines 53–58)

```
fn file_system(&self) -> Result<Arc<dyn ExecutorFileSystem>, JSONRPCErrorError>
```

**Purpose**: Finds the local file system that all file operations should use. If the server has no local file system configured, it turns that situation into a clear JSON-RPC internal error.

**Data flow**: It reads the stored EnvironmentManager, asks for the local environment, and then asks that environment for its file-system object. If any of that is unavailable, it returns an error instead of letting later code fail in a confusing way.

**Call relations**: Nearly every operation calls this first, including reading, writing, creating folders, listing folders, deleting, copying, watching, and unwatching. It is the shared gatekeeper that makes sure there is a real file system before work begins.

*Call graph*: called by 9 (copy, create_directory, get_metadata, read_directory, read_file, remove, unwatch, watch, write_file).


##### `FsRequestProcessor::connection_closed`  (lines 60–62)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Cleans up file watches when a client connection goes away. This prevents the server from continuing to track watches for a client that is no longer present.

**Data flow**: It receives the closed connection’s identifier and passes it to the FsWatchManager. The watch manager then removes or updates any watch state tied to that connection. This function returns nothing meaningful to the caller.

**Call relations**: It is called by the server’s connection-closed flow. It hands the cleanup work to FsWatchManager::connection_closed because that component owns the watch bookkeeping.

*Call graph*: calls 1 internal fn (connection_closed); called by 1 (connection_closed).


##### `FsRequestProcessor::read_file`  (lines 64–77)

```
async fn read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Reads a file from the local file system and returns its contents as base64 text, so the bytes can safely travel in a JSON response.

**Data flow**: It receives read-file parameters containing a path. It converts that path into a PathUri, gets the local file system, reads the file bytes, maps any file-system error into a JSON-RPC error, then encodes the bytes as base64 in an FsReadFileResponse.

**Call relations**: It is called when handle_initialized_client_request receives a client read-file request. It relies on file_system to find the file-system service and on PathUri::from_abs_path to turn the incoming path into the format expected by that service.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::write_file`  (lines 79–94)

```
async fn write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Writes client-provided data into a file. The client sends the data as base64 text, and this function decodes it back into raw bytes before writing.

**Data flow**: It receives write-file parameters with a path and dataBase64 text. It first decodes the base64; if that text is not valid base64, it returns an invalid-request error. Then it converts the path, gets the local file system, writes the bytes, maps any file-system error, and returns an empty success response.

**Call relations**: It is called by handle_initialized_client_request for write-file requests. It uses file_system for access to storage and PathUri::from_abs_path for path conversion before handing the actual write to the file-system layer.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::create_directory`  (lines 96–112)

```
async fn create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Creates a folder on the local file system. By default it creates parent folders too, which is the common behavior users expect from “make this directory path exist.”

**Data flow**: It receives directory-creation parameters with a path and an optional recursive flag. It converts the path, gets the file system, builds create-directory options using true as the default for recursive, performs the creation, maps errors, and returns an empty success response.

**Call relations**: It is called by handle_initialized_client_request when a client asks to create a directory. It prepares the request in protocol terms, then passes the real work to the ExecutorFileSystem returned by file_system.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::get_metadata`  (lines 114–131)

```
async fn get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Looks up basic facts about a path, such as whether it is a file, directory, or symbolic link, and when it was created or modified.

**Data flow**: It receives metadata parameters with a path. It converts the path, gets the local file system, asks for metadata, maps errors, and copies the relevant metadata fields into an FsGetMetadataResponse.

**Call relations**: It is called by handle_initialized_client_request for metadata requests. It uses file_system and PathUri::from_abs_path before delegating the actual lookup to the file-system service.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::read_directory`  (lines 133–153)

```
async fn read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Lists the direct contents of a folder and returns simple information about each entry, such as its name and whether it is a file or directory.

**Data flow**: It receives directory-read parameters with a path. It converts the path, gets the local file system, reads the directory entries, maps errors, then transforms each internal entry into the protocol’s FsReadDirectoryEntry shape before returning them.

**Call relations**: It is called by handle_initialized_client_request when a client asks to list a folder. It acts as the adapter between the file-system service’s directory entries and the response format expected by the client protocol.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::remove`  (lines 155–172)

```
async fn remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Deletes a file or directory from the local file system. By default it allows recursive deletion and ignores missing targets, matching a forgiving delete operation.

**Data flow**: It receives remove parameters with a path and optional recursive and force flags. It converts the path, gets the local file system, fills in default options where the client left them out, performs the removal, maps errors, and returns an empty success response.

**Call relations**: It is called by handle_initialized_client_request for remove requests. It prepares the deletion options and then hands the actual delete operation to the file-system service.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::copy`  (lines 174–192)

```
async fn copy(
        &self,
        params: FsCopyParams,
    ) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Copies a file or directory from one local path to another. The client can say whether directory copying should be recursive.

**Data flow**: It receives copy parameters with a source path, destination path, and recursive setting. It converts both paths, gets the local file system, builds copy options, asks the file system to copy, maps any errors, and returns an empty success response.

**Call relations**: It is called by handle_initialized_client_request when a client sends a copy request. It uses PathUri::from_abs_path for both paths and file_system for access to the actual copy implementation.

*Call graph*: calls 2 internal fn (file_system, from_abs_path); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::watch`  (lines 194–201)

```
async fn watch(
        &self,
        connection_id: ConnectionId,
        params: FsWatchParams,
    ) -> Result<FsWatchResponse, JSONRPCErrorError>
```

**Purpose**: Starts watching a path for changes on behalf of a specific client connection. This lets the server later notify that client when relevant file-system changes happen.

**Data flow**: It receives a connection identifier and watch parameters. It first checks that a local file system exists, then passes the connection and watch request to FsWatchManager. The response from the watch manager becomes the function’s response.

**Call relations**: It is called by handle_initialized_client_request for watch requests. After verifying file-system availability through file_system, it delegates the real watch registration to FsWatchManager::watch.

*Call graph*: calls 2 internal fn (watch, file_system); called by 1 (handle_initialized_client_request).


##### `FsRequestProcessor::unwatch`  (lines 203–210)

```
async fn unwatch(
        &self,
        connection_id: ConnectionId,
        params: FsUnwatchParams,
    ) -> Result<FsUnwatchResponse, JSONRPCErrorError>
```

**Purpose**: Stops a previously registered file watch for a specific client connection. This is how a client says it no longer needs change notifications for that watch.

**Data flow**: It receives a connection identifier and unwatch parameters. It checks that the local file system is configured, then passes the unwatch request to FsWatchManager. The watch manager’s response is returned to the caller.

**Call relations**: It is called by handle_initialized_client_request for unwatch requests. It uses file_system as a safety check, then hands the watch-state change to FsWatchManager::unwatch.

*Call graph*: calls 2 internal fn (unwatch, file_system); called by 1 (handle_initialized_client_request).


##### `map_fs_error`  (lines 213–219)

```
fn map_fs_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts ordinary file-system errors into the JSON-RPC error format used by the server’s client protocol.

**Data flow**: It receives an io::Error from a file-system operation. If the error kind is InvalidInput, it turns it into an invalid-request error, meaning the client likely asked for something malformed. Otherwise, it turns the message into an internal-error response. The output is always a JSONRPCErrorError.

**Call relations**: The file-operation methods use this conversion when an underlying read, write, copy, delete, metadata, or directory operation fails. It calls invalid_request for bad input and internal_error for other failures, keeping client-facing error behavior consistent.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (kind, to_string).


### `app-server/src/request_processors/feedback_processor.rs`

`orchestration` · `request handling`

When someone reports a problem or gives feedback, the server needs to package enough context for the receiving team to understand what happened. This file is the packaging desk for that process. It checks whether feedback is allowed by configuration, validates the optional conversation id, collects tags, and takes a snapshot of the current feedback state. If the user asked to include logs, it flushes recent log data, finds the main conversation and related child conversations, limits that set so uploads do not grow without bound, and looks for stored log records in the state database. It also gathers attachment files such as rollout logs, an auto-review rollout if one exists, a Windows sandbox log on Windows, and any extra files explicitly requested by the client. Before uploading, it may add a “doctor” diagnostic report, which is like a quick health check bundled with the feedback. The actual upload is run on a blocking worker thread so the async server is not stalled while file reading or network work happens. Without this file, feedback requests would either be ignored or would lack the logs and context that make them useful for debugging.

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

**Purpose**: Creates a feedback request processor with all the shared services it needs. It stores access to authentication, conversation threads, configuration, feedback collection, and optional databases.

**Data flow**: The caller gives it shared references to the auth manager, thread manager, config, feedback object, and optional log and state databases. The function places those pieces into a new FeedbackRequestProcessor. The result is a ready-to-use processor that can answer feedback upload requests later.

**Call relations**: This is called during setup when the larger request-processing system is being built. It does not do any uploading itself; it simply prepares the object that later receives calls from the client request handler.

*Call graph*: called by 1 (new).


##### `FeedbackRequestProcessor::feedback_upload`  (lines 36–43)

```
async fn feedback_upload(
        &self,
        params: FeedbackUploadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Acts as the public request-facing method for uploading feedback. It converts the internal feedback upload result into the generic response shape expected by the JSON-RPC request system, where JSON-RPC is the protocol used for client-server messages.

**Data flow**: It receives the feedback upload parameters from a client request. It passes them to the more detailed upload function, waits for that work to finish, and wraps the successful response as a client response payload. If the detailed upload fails, the same error is returned to the caller.

**Call relations**: The initialized client request handler calls this when a client asks to upload feedback. This method then hands the real work to FeedbackRequestProcessor::upload_feedback_response and only adapts the answer for the surrounding request system.

*Call graph*: calls 1 internal fn (upload_feedback_response); called by 1 (handle_initialized_client_request).


##### `FeedbackRequestProcessor::upload_feedback_response`  (lines 45–271)

```
async fn upload_feedback_response(
        &self,
        params: FeedbackUploadParams,
    ) -> Result<FeedbackUploadResponse, JSONRPCErrorError>
```

**Purpose**: Builds and sends the full feedback package. It checks the request, gathers logs and attachments when requested, adds useful tags and diagnostics, and performs the upload.

**Data flow**: It starts with the client’s feedback details: classification, reason, optional thread id, whether to include logs, extra log files, and tags. It rejects the request if feedback is disabled or the thread id is invalid. It reads cached authentication details for logging, captures a feedback snapshot, finds related thread ids, flushes and queries logs when needed, resolves rollout file paths, adds Windows sandbox and doctor-report attachments when available, and then uploads everything through the feedback snapshot. The output is either a response containing the uploaded feedback’s thread id or a JSON-RPC error describing what went wrong.

**Call relations**: FeedbackRequestProcessor::feedback_upload calls this as the main body of the request. During its work it calls helper pieces such as FeedbackRequestProcessor::resolve_rollout_path to find log files, auto_review_rollout_filename to name a special attachment, windows_sandbox_log_attachment to include Windows sandbox logs, and doctor_feedback_report to attach diagnostic information. It then hands the final bundle to the feedback snapshot’s upload operation.

*Call graph*: calls 6 internal fn (doctor_feedback_report, resolve_rollout_path, auto_review_rollout_filename, windows_sandbox_log_attachment, snapshot, from_string); called by 1 (feedback_upload); 8 external calls (new, new, with_capacity, format!, spawn_blocking, info!, vec!, warn!).


##### `FeedbackRequestProcessor::resolve_rollout_path`  (lines 273–292)

```
async fn resolve_rollout_path(
        &self,
        conversation_id: ThreadId,
        state_db_ctx: Option<&StateDbHandle>,
    ) -> Option<PathBuf>
```

**Purpose**: Finds the saved rollout log file for a conversation thread. A rollout log is the stored record of what happened in a conversation, useful for understanding feedback.

**Data flow**: It receives a thread id and, optionally, a state database handle. First it asks the live thread manager for the conversation and returns its rollout path if the conversation is currently known. If that fails and a state database is available, it looks up the rollout path in the database instead. The result is either a file path or nothing if no path can be found.

**Call relations**: The main upload function calls this while building log attachments for each thread included in the feedback package. This helper keeps the upload code from needing to know whether a conversation is live in memory or only recorded in storage.

*Call graph*: called by 1 (upload_feedback_response).


##### `auto_review_rollout_filename`  (lines 295–297)

```
fn auto_review_rollout_filename(thread_id: ThreadId) -> String
```

**Purpose**: Creates a clear attachment filename for an auto-review rollout file. The generated name includes the thread id so the file can be tied back to the conversation it belongs to.

**Data flow**: It receives a thread id. It formats that id into a filename shaped like an auto-review rollout JSON-lines file. It returns that filename as text.

**Call relations**: The upload function uses this when it attaches a guardian or auto-review rollout path. The helper gives that attachment a meaningful name instead of exposing only the original local file path.

*Call graph*: called by 1 (upload_feedback_response); 1 external calls (format!).


##### `windows_sandbox_log_attachment`  (lines 311–313)

```
fn windows_sandbox_log_attachment(_codex_home: &Path) -> Option<FeedbackAttachmentPath>
```

**Purpose**: Adds the current Windows sandbox log as a feedback attachment when the server is running on Windows and the log file exists. On non-Windows systems, it deliberately returns nothing.

**Data flow**: It receives the Codex home directory path. On Windows, it computes where the current sandbox log should be, checks whether that file exists, and if so returns an attachment description with a standard upload filename. On other operating systems, the input path is ignored and the result is always empty.

**Call relations**: The main upload function calls this while gathering optional log attachments. The Windows-only test also calls it to confirm that it chooses the current sandbox log file and labels it correctly.

*Call graph*: called by 2 (upload_feedback_response, windows_sandbox_log_attachment_uses_current_log); 1 external calls (current_log_file_path_for_codex_home).


##### `tests::windows_sandbox_log_attachment_uses_current_log`  (lines 321–339)

```
fn windows_sandbox_log_attachment_uses_current_log()
```

**Purpose**: Checks that the Windows sandbox log attachment helper points to the current sandbox log file and uses the expected uploaded filename. This protects feedback uploads from accidentally attaching the wrong sandbox log.

**Data flow**: The test creates a temporary Codex home directory, creates the sandbox log directory, writes a fake current sandbox log file, and then calls windows_sandbox_log_attachment. It compares the returned path and filename override with the values it expects. The test passes if the helper returns exactly that attachment.

**Call relations**: This test is compiled only for Windows test runs. It exercises windows_sandbox_log_attachment directly, standing in for the feedback upload flow that would normally call the helper during a real feedback request.

*Call graph*: calls 1 internal fn (windows_sandbox_log_attachment); 6 external calls (assert_eq!, current_log_file_path_for_codex_home, sandbox_dir, create_dir_all, write, tempdir).


### `app-server/src/request_processors/git_processor.rs`

`orchestration` · `request handling`

This file is a bridge between incoming app requests and the Git code that actually calculates a diff. In everyday terms, it is like a front desk clerk: the client asks for a comparison with the remote Git version, the clerk sends the folder path to the Git worker, then packages the answer in the format the client expects.

The main type is `GitRequestProcessor`, which has no stored data of its own. It exists so the larger request-handling system has a clear place to route Git-related requests. When a client asks for a diff to the remote repository, the processor reads the requested working directory path, asks the lower-level `git_diff_to_remote` helper to compute the current commit SHA and text diff, and wraps those values in a `GitDiffToRemoteResponse`.

If the Git helper cannot produce a result, this file turns that failure into a JSON-RPC error. JSON-RPC is the message format used for client-server requests here, and the error tells the caller that the request could not be completed for that folder. Without this file, the server might still have Git diff code, but there would be no clean request-facing adapter that turns client parameters into a client response.

#### Function details

##### `GitRequestProcessor::new`  (lines 7–9)

```
fn new() -> Self
```

**Purpose**: Creates a new `GitRequestProcessor`. Since the processor does not need to remember any settings or state, construction simply returns an empty processor value.

**Data flow**: Nothing goes in. The function creates a fresh processor object with no internal fields. The result is returned to whoever is setting up the request-processing machinery.

**Call relations**: This is used during setup when the broader processor collection is being built. After this processor exists, other parts of the server can call on it when a Git-related client request arrives.

*Call graph*: called by 1 (new).


##### `GitRequestProcessor::git_diff_to_remote`  (lines 11–18)

```
async fn git_diff_to_remote(
        &self,
        params: GitDiffToRemoteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Responds to a client request asking for the difference between the current working directory and the remote Git version. It is the public request-facing method for this Git operation.

**Data flow**: It receives request parameters, mainly the working directory path named `cwd`. It passes that path to the internal diff helper. If the helper succeeds, it converts the Git diff response into the general client response payload and wraps it as present; if the helper fails, the error is passed back unchanged.

**Call relations**: This method is called when the initialized client request handler routes a Git diff request here. It then delegates the real work to `GitRequestProcessor::git_diff_to_origin`, and finally hands the finished response back in the common client-response form expected by the request system.

*Call graph*: calls 1 internal fn (git_diff_to_origin); called by 1 (handle_initialized_client_request).


##### `GitRequestProcessor::git_diff_to_origin`  (lines 20–35)

```
async fn git_diff_to_origin(
        &self,
        cwd: PathBuf,
    ) -> Result<GitDiffToRemoteResponse, JSONRPCErrorError>
```

**Purpose**: Does the actual request-level Git diff lookup for a given folder and converts the low-level Git result into the response type used by this API. It also turns a missing diff result into a clear invalid-request error.

**Data flow**: It receives a folder path. It asks the Git helper to compare that folder against the remote/origin state. If Git returns a value, this function copies out the commit SHA and diff text into a `GitDiffToRemoteResponse`; if Git returns no value, it creates a JSON-RPC invalid-request error that includes the folder path for context.

**Call relations**: This is the private worker called by `GitRequestProcessor::git_diff_to_remote`. It sits between the request-facing method and the lower-level Git diff function, translating the raw Git answer into the API response or an API-friendly error.

*Call graph*: called by 1 (git_diff_to_remote).


### `app-server/src/request_processors/marketplace_processor.rs`

`orchestration` · `request handling`

A “marketplace” here is a source of plugins or extensions that the app can install from. This file defines `MarketplaceRequestProcessor`, a small request handler that knows the app configuration, can reload the latest configuration, and can reach the plugin manager through the thread manager. Without this file, the server might receive marketplace requests, but there would be no focused place to translate those requests into the right marketplace actions and return client-friendly responses.

The public methods are the entry points for three client commands: add, remove, and upgrade. Each public method calls a matching private “inner” method that does the real work, then wraps the result into a standard client response payload. The add and remove paths call lower-level marketplace functions using the configured Codex home folder, which is where the app stores its local data. They also translate lower-level errors into JSON-RPC errors, so the client gets a clear “bad request” or “internal problem” response.

The upgrade path is a little different. It first reloads the latest configuration, because upgrades should use the current marketplace settings rather than stale startup data. Then it asks the plugin manager to upgrade the configured marketplaces. That work is run with `spawn_blocking`, meaning it is moved off the async request loop so a slow filesystem or plugin operation does not freeze other requests.

#### Function details

##### `MarketplaceRequestProcessor::new`  (lines 11–21)

```
fn new(
        config: Arc<Config>,
        config_manager: ConfigManager,
        thread_manager: Arc<ThreadManager>,
    ) -> Self
```

**Purpose**: Creates a marketplace request processor with the shared configuration, configuration loader, and thread/plugin access it needs. This is used when the server is wiring together its request handling pieces.

**Data flow**: It receives the current `Config`, a `ConfigManager`, and a `ThreadManager`. It stores those three pieces inside a new `MarketplaceRequestProcessor`, so later marketplace requests can read paths, reload settings, and reach the plugin manager.

**Call relations**: It is called during construction of the larger request-processing setup. After this object is created, the initialized client request handler can call its marketplace methods when matching client commands arrive.

*Call graph*: called by 1 (new).


##### `MarketplaceRequestProcessor::marketplace_add`  (lines 23–30)

```
async fn marketplace_add(
        &self,
        params: MarketplaceAddParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a client request to add a marketplace. It is the client-facing wrapper around the actual add operation.

**Data flow**: It receives `MarketplaceAddParams` from the client. It passes those parameters to `marketplace_add_inner`, waits for the add operation to finish, and turns the successful response into a standard `ClientResponsePayload`; if something fails, the JSON-RPC error is returned instead.

**Call relations**: It is called by `handle_initialized_client_request` when an initialized client asks to add a marketplace. It delegates the real work to `marketplace_add_inner`, keeping this outer method focused on response wrapping.

*Call graph*: calls 1 internal fn (marketplace_add_inner); called by 1 (handle_initialized_client_request).


##### `MarketplaceRequestProcessor::marketplace_remove`  (lines 32–39)

```
async fn marketplace_remove(
        &self,
        params: MarketplaceRemoveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a client request to remove a marketplace. It provides the standard response shape expected by the JSON-RPC request flow.

**Data flow**: It receives `MarketplaceRemoveParams`, sends them to `marketplace_remove_inner`, and waits for the removal result. On success, it wraps the removal response as a `ClientResponsePayload`; on failure, it passes back the JSON-RPC error.

**Call relations**: It is called by `handle_initialized_client_request` when the client asks to remove a marketplace. It calls `marketplace_remove_inner` to do the actual removal and error translation.

*Call graph*: calls 1 internal fn (marketplace_remove_inner); called by 1 (handle_initialized_client_request).


##### `MarketplaceRequestProcessor::marketplace_upgrade`  (lines 41–48)

```
async fn marketplace_upgrade(
        &self,
        params: MarketplaceUpgradeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Handles a client request to upgrade one marketplace or the configured marketplaces. It is the public request method that produces the client-ready upgrade response.

**Data flow**: It receives `MarketplaceUpgradeParams`, passes them to `marketplace_upgrade_response_inner`, and waits for the upgrade summary. On success, it converts that summary into a standard client response payload; on failure, it returns the JSON-RPC error.

**Call relations**: It is called by `handle_initialized_client_request` when the client asks for a marketplace upgrade. It hands the request to `marketplace_upgrade_response_inner`, which reloads configuration and talks to the plugin manager.

*Call graph*: calls 1 internal fn (marketplace_upgrade_response_inner); called by 1 (handle_initialized_client_request).


##### `MarketplaceRequestProcessor::marketplace_remove_inner`  (lines 50–69)

```
async fn marketplace_remove_inner(
        &self,
        params: MarketplaceRemoveParams,
    ) -> Result<MarketplaceRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Does the real work for removing a marketplace from the app’s local Codex home folder. It also turns marketplace-specific errors into client-facing JSON-RPC errors.

**Data flow**: It takes the marketplace name from the client parameters and combines it with the configured Codex home path. It calls the lower-level removal operation, then reshapes the outcome into a response containing the removed marketplace name and the installed root that was removed. If the lower-level code reports a bad request, it becomes an invalid-request JSON-RPC error; if it reports an internal problem, it becomes an internal JSON-RPC error.

**Call relations**: It is called only by `marketplace_remove`. This keeps the public method simple while this inner method talks to the marketplace removal code and translates its result into the server’s response language.

*Call graph*: called by 1 (marketplace_remove).


##### `MarketplaceRequestProcessor::marketplace_upgrade_response_inner`  (lines 71–102)

```
async fn marketplace_upgrade_response_inner(
        &self,
        params: MarketplaceUpgradeParams,
    ) -> Result<MarketplaceUpgradeResponse, JSONRPCErrorError>
```

**Purpose**: Performs the upgrade operation and builds a detailed response showing what was selected, what was upgraded, and what errors happened. It uses the latest configuration so upgrades are based on current settings.

**Data flow**: It receives optional upgrade targeting information, such as a marketplace name. First it reloads the latest config through `load_latest_config`, then extracts the plugin configuration input. It gets the plugin manager from the thread manager and runs the upgrade work in `spawn_blocking`, which is used for work that may block the normal async request loop. The result is converted into a response with selected marketplaces, upgraded roots, and simplified error messages for the client.

**Call relations**: It is called by `marketplace_upgrade`. During its work it calls `load_latest_config` to avoid using stale settings, then hands the upgrade task to the plugin manager inside `spawn_blocking` so the server can keep serving other async work while the upgrade runs.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (marketplace_upgrade); 1 external calls (spawn_blocking).


##### `MarketplaceRequestProcessor::marketplace_add_inner`  (lines 104–126)

```
async fn marketplace_add_inner(
        &self,
        params: MarketplaceAddParams,
    ) -> Result<MarketplaceAddResponse, JSONRPCErrorError>
```

**Purpose**: Does the real work for adding a marketplace to the app’s local Codex home folder. It prepares the lower-level add request and converts the result into a response the client understands.

**Data flow**: It receives the marketplace source, optional reference name, and optional sparse paths from the client parameters. Missing sparse paths are treated as an empty list. It calls the lower-level add operation with the Codex home path and these request details, then returns the marketplace name, install location, and whether it had already been added. Add errors are translated into invalid-request or internal JSON-RPC errors.

**Call relations**: It is called only by `marketplace_add`. The outer method handles the standard client response wrapping, while this inner method talks to the marketplace add code and maps its success or failure into server response types.

*Call graph*: called by 1 (marketplace_add).


##### `MarketplaceRequestProcessor::load_latest_config`  (lines 128–136)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the current configuration and converts any reload failure into a JSON-RPC internal error. This gives marketplace upgrade code a fresh view of configured marketplaces.

**Data flow**: It receives an optional fallback current working directory, then asks the `ConfigManager` to load the latest config. If loading succeeds, it returns the fresh `Config`; if loading fails, it produces an internal JSON-RPC error with a message explaining that config reload failed.

**Call relations**: It is called by `marketplace_upgrade_response_inner` before upgrade work begins. It delegates the actual loading to the config manager’s `load_latest_config` method and standardizes the error format for this request processor.

*Call graph*: calls 1 internal fn (load_latest_config); called by 1 (marketplace_upgrade_response_inner).


### `app-server/src/request_processors/plugins.rs`

`orchestration` · `request handling`

Plugins add extra abilities to Codex, such as skills, app connectors, hooks, and MCP servers. This file is the bridge between a client request and the lower-level plugin systems that know how to read plugin files, talk to the remote marketplace, update local configuration, and refresh running sessions. Without it, the client could not reliably discover plugins, install them, share them, or see accurate plugin details.

The central type is `PluginRequestProcessor`. It holds shared services: authentication, thread/session state, outgoing notifications, analytics, configuration loading, and cached workspace settings. Public methods like `plugin_list` and `plugin_install` are thin wrappers that turn typed responses into client responses. The heavier private methods do the actual work: reload current configuration, check feature flags, confirm workspace plugin settings, call local or remote plugin services, translate internal data into protocol-friendly response objects, and convert errors into JSON-RPC errors that clients understand.

A large part of the file is translation. Local plugin objects, remote catalog objects, sharing principals, app metadata, and skill metadata are converted into the protocol shapes sent back to the client. The file also keeps caches in sync after changes. After installs, uninstalls, or share updates, it clears plugin and skill caches and may trigger a best-effort MCP refresh so active threads see the new plugin state.

#### Function details

##### `plugin_skills_to_info`  (lines 36–60)

```
fn plugin_skills_to_info(
    skills: &[codex_core::skills::SkillMetadata],
    disabled_skill_paths: &HashSet<AbsolutePathBuf>,
) -> Vec<SkillSummary>
```

**Purpose**: Turns internal plugin skill metadata into the simpler skill summaries sent to the client. It also marks each skill as enabled or disabled based on its path.

**Data flow**: It receives a list of internal skills and a set of disabled skill file paths. For each skill, it copies the readable fields, translates optional display information, attaches the skill path, and sets `enabled` to false if that path is in the disabled set. It returns a list of client-facing skill summaries.

**Call relations**: When `PluginRequestProcessor::plugin_read_response` builds full details for a local plugin, it calls this helper so the client sees the plugin’s skills in protocol format.

*Call graph*: called by 1 (plugin_read_response); 1 external calls (iter).


##### `local_plugin_interface_to_info`  (lines 62–82)

```
fn local_plugin_interface_to_info(interface: PluginManifestInterface) -> PluginInterface
```

**Purpose**: Converts a local plugin’s display metadata into the protocol type used by the app server. This includes names, descriptions, colors, logos, screenshots, and policy links.

**Data flow**: It receives a local manifest interface object. It copies its fields into a `PluginInterface`, while setting remote-only URL fields to empty values because local manifests carry local assets instead. It returns the converted interface.

**Call relations**: This helper is used while local plugin summaries and details are being prepared, so local manifest information can be sent to clients in the same shape as other plugin information.

*Call graph*: 1 external calls (new).


##### `marketplace_plugin_source_to_info`  (lines 84–99)

```
fn marketplace_plugin_source_to_info(source: MarketplacePluginSource) -> PluginSource
```

**Purpose**: Describes where a marketplace plugin comes from in client-facing terms. A plugin may come from a local path or from a Git repository.

**Data flow**: It receives an internal plugin source. If it is local, it returns a local source with the path. If it is Git-based, it returns the Git URL, path, reference name, and commit hash. Nothing else is changed.

**Call relations**: Local plugin summary builders call this when preparing list and read responses, so the client can show where a plugin was obtained.

*Call graph*: called by 2 (plugin_read_response, convert_configured_marketplace_plugin_to_plugin_summary).


##### `load_shared_plugin_ids_by_local_path`  (lines 101–112)

```
fn load_shared_plugin_ids_by_local_path(
    config: &Config,
) -> Result<std::collections::BTreeMap<AbsolutePathBuf, String>, JSONRPCErrorError>
```

**Purpose**: Loads the saved mapping between local plugin folders and their remote shared-plugin IDs. This lets the server recognize that a local plugin has already been shared.

**Data flow**: It reads the Codex home directory from the current config, asks the remote plugin helper to load the local-path-to-remote-ID mapping, and converts any failure into an internal JSON-RPC error. On success, it returns the mapping.

**Call relations**: Plugin listing, installed-plugin listing, and plugin reading call this before building responses that may include sharing context.

*Call graph*: called by 3 (load_local_installed_and_suggested_plugins, plugin_list_response, plugin_read_response); 1 external calls (load_plugin_share_remote_ids_by_local_path).


##### `share_context_for_source`  (lines 114–133)

```
fn share_context_for_source(
    source: &MarketplacePluginSource,
    shared_plugin_ids_by_local_path: &std::collections::BTreeMap<AbsolutePathBuf, String>,
) -> Option<PluginShareContext>
```

**Purpose**: Adds basic sharing information to a local plugin if its path is known to correspond to a remote share. Git-sourced plugins do not get this local share context here.

**Data flow**: It receives a plugin source and the saved path-to-remote-ID map. For a local path, it looks up the remote ID and builds a minimal share context if found. For a Git source, it returns nothing.

**Call relations**: Local plugin summaries and local plugin detail responses use this helper to show that a plugin has been shared, even before richer remote share details are fetched.

*Call graph*: called by 2 (plugin_read_response, convert_configured_marketplace_plugin_to_plugin_summary).


##### `convert_configured_marketplace_plugin_to_plugin_summary`  (lines 135–155)

```
fn convert_configured_marketplace_plugin_to_plugin_summary(
    plugin: codex_core_plugins::ConfiguredMarketplacePlugin,
    shared_plugin_ids_by_local_path: &std::collections::BTreeMap<AbsolutePathBu
```

**Purpose**: Turns an internal configured marketplace plugin into the summary object the client expects. It combines installation state, display metadata, policy, source, keywords, and sharing context.

**Data flow**: It receives one internal configured plugin plus the local share mapping. It computes any share context, converts the plugin source and interface, copies status fields, and returns a `PluginSummary` marked as available.

**Call relations**: Marketplace listing code calls this when translating local marketplace entries into app-server protocol responses.

*Call graph*: calls 2 internal fn (marketplace_plugin_source_to_info, share_context_for_source).


##### `remote_installed_plugin_visible_marketplaces`  (lines 157–170)

```
fn remote_installed_plugin_visible_marketplaces(config: &Config) -> Vec<&'static str>
```

**Purpose**: Decides which remote marketplace buckets should be shown when listing installed plugins. The answer depends on feature flags such as remote plugins and plugin sharing.

**Data flow**: It reads feature settings from the config. It builds a list of marketplace names: global and created-by-me when remote plugins are enabled, workspace always, and shared-with-me variants when sharing is enabled. It returns that list.

**Call relations**: Installed-plugin request handling uses this to decide which cached or fetched remote installed plugins are relevant to the current user and workspace.

*Call graph*: called by 1 (plugin_installed_response); 1 external calls (new).


##### `filter_openai_curated_installed_conflicts`  (lines 172–207)

```
fn filter_openai_curated_installed_conflicts(
    marketplaces: &mut Vec<PluginMarketplaceEntry>,
    prefer_remote_curated_conflicts: bool,
)
```

**Purpose**: Removes duplicate installed plugins when the same plugin appears in both the local OpenAI curated marketplace and the remote global marketplace. This avoids showing two installed copies of what is effectively the same plugin.

**Data flow**: It receives a mutable list of marketplace entries and a preference flag. It finds installed plugin names in local curated marketplaces and in the remote global marketplace, computes overlaps, then removes the losing side’s conflicting installed entries. Empty marketplaces are removed.

**Call relations**: After local and remote installed plugins are combined, `PluginRequestProcessor::plugin_installed_response` calls this to clean up duplicate display results.

*Call graph*: called by 1 (plugin_installed_response); 1 external calls (is_openai_curated_marketplace_name).


##### `installed_plugin_names`  (lines 209–215)

```
fn installed_plugin_names(plugins: &[PluginSummary]) -> HashSet<String>
```

**Purpose**: Collects the names of plugins that are marked installed. It is a small helper for conflict detection.

**Data flow**: It receives plugin summaries, keeps only those with `installed` set, copies their names, and returns those names as a set.

**Call relations**: The duplicate-filtering helper uses this while comparing local curated plugins against remote global plugins.

*Call graph*: 1 external calls (iter).


##### `remote_plugin_share_discoverability`  (lines 217–231)

```
fn remote_plugin_share_discoverability(
    discoverability: PluginShareDiscoverability,
) -> codex_core_plugins::remote::RemotePluginShareDiscoverability
```

**Purpose**: Converts the client’s sharing visibility choice into the remote service’s matching type. Visibility means whether a share is listed, unlisted, or private.

**Data flow**: It receives a protocol discoverability value and returns the equivalent remote-service value. No validation or network work happens here.

**Call relations**: Share-save logic uses this conversion before sending a create-share request to the remote plugin service.


##### `remote_plugin_share_update_discoverability`  (lines 233–244)

```
fn remote_plugin_share_update_discoverability(
    discoverability: PluginShareUpdateDiscoverability,
) -> codex_core_plugins::remote::RemotePluginShareUpdateDiscoverability
```

**Purpose**: Converts a client request for updating share visibility into the type used by the remote plugin service.

**Data flow**: It receives an update discoverability value, either unlisted or private, and returns the matching remote-service value.

**Call relations**: Share-target update handling calls this before asking the remote service to update who can access a shared plugin.

*Call graph*: called by 1 (plugin_share_update_targets_response).


##### `validate_client_plugin_share_targets`  (lines 246–258)

```
fn validate_client_plugin_share_targets(
    targets: &[PluginShareTarget],
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Rejects share target lists that include workspace principals. In this API, workspace link access must be represented by unlisted discoverability instead.

**Data flow**: It receives requested share targets, scans them, and returns an invalid-request error if any target is a workspace. Otherwise it returns success with no output value.

**Call relations**: Both share creation and share-target update paths call this before sending data to the remote service, so unsupported requests fail early with a clear message.

*Call graph*: calls 1 internal fn (invalid_request); called by 2 (plugin_share_save_response, plugin_share_update_targets_response); 1 external calls (iter).


##### `remote_plugin_share_target_role`  (lines 260–271)

```
fn remote_plugin_share_target_role(
    role: PluginShareTargetRole,
) -> codex_core_plugins::remote::RemotePluginShareTargetRole
```

**Purpose**: Converts a client-facing share target role into the remote service’s role type. Roles decide whether a target can read or edit.

**Data flow**: It receives a `Reader` or `Editor` role and returns the equivalent remote role. It does not change any other share-target data.

**Call relations**: The share-target conversion helper uses this while preparing share targets for remote API calls.


##### `plugin_share_principal_role_from_remote`  (lines 273–287)

```
fn plugin_share_principal_role_from_remote(
    role: codex_core_plugins::remote::RemotePluginSharePrincipalRole,
) -> PluginSharePrincipalRole
```

**Purpose**: Converts a role returned by the remote service into the protocol role sent to the client. It supports reader, editor, and owner.

**Data flow**: It receives a remote principal role and maps it directly to the matching client protocol role.

**Call relations**: Remote share principal conversion calls this when building the list of people or groups who have access to a shared plugin.

*Call graph*: called by 1 (plugin_share_principal_from_remote).


##### `remote_plugin_share_targets`  (lines 289–312)

```
fn remote_plugin_share_targets(
    targets: Vec<PluginShareTarget>,
) -> Vec<codex_core_plugins::remote::RemotePluginShareTarget>
```

**Purpose**: Converts a list of client share targets into the exact structures the remote plugin service expects.

**Data flow**: It receives client share targets. For each one, it maps the principal type, copies the principal ID, converts the role, and returns the list of remote share targets.

**Call relations**: Share creation and share-target update flows use this before calling the remote sharing APIs.

*Call graph*: called by 1 (plugin_share_update_targets_response).


##### `plugin_share_principal_from_remote`  (lines 314–333)

```
fn plugin_share_principal_from_remote(
    principal: codex_core_plugins::remote::RemotePluginSharePrincipal,
) -> PluginSharePrincipal
```

**Purpose**: Converts a remote share principal into the client-facing principal format. A principal is a person, group, or workspace that has access to a share.

**Data flow**: It receives one remote principal, maps its type and role, copies its ID and display name, and returns the protocol principal.

**Call relations**: Share context and share update responses use this so clients can display access lists returned by the remote service.

*Call graph*: calls 1 internal fn (plugin_share_principal_role_from_remote).


##### `PluginRequestProcessor::new`  (lines 336–352)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        analytics_events_client: AnalyticsEventsClient,
```

**Purpose**: Builds a new plugin request processor with all the shared services it needs. This is the object later used to answer plugin-related client requests.

**Data flow**: It receives authentication, thread state, outgoing message, analytics, configuration, and workspace-settings services. It stores them in the processor and returns the new processor.

**Call relations**: Server setup code creates this processor, and request dispatch later calls its public plugin methods.

*Call graph*: called by 1 (new).


##### `PluginRequestProcessor::plugin_list`  (lines 354–361)

```
async fn plugin_list(
        &self,
        params: PluginListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for listing available plugin marketplaces and plugins. It wraps the internal typed response into the general client response envelope.

**Data flow**: It receives list parameters, forwards them to `plugin_list_response`, converts the successful response into a client payload, and returns it. Errors pass through as JSON-RPC errors.

**Call relations**: The initialized client request dispatcher calls this when a client sends a plugin/list request.

*Call graph*: calls 1 internal fn (plugin_list_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_installed`  (lines 363–370)

```
async fn plugin_installed(
        &self,
        params: PluginInstalledParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for listing installed plugins. It returns only the installed and suggested plugin information the client needs.

**Data flow**: It receives installed-plugin parameters, calls `plugin_installed_response`, wraps the result as a client payload, and returns it.

**Call relations**: The request dispatcher calls this for plugin/installed requests, and this method delegates the real work to the internal response builder.

*Call graph*: calls 1 internal fn (plugin_installed_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_read`  (lines 372–379)

```
async fn plugin_read(
        &self,
        params: PluginReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for reading detailed information about one plugin. It supports local marketplace plugins and remote marketplace plugins.

**Data flow**: It receives read parameters, calls `plugin_read_response`, turns the detail response into a client payload, and returns it.

**Call relations**: The request dispatcher calls this for plugin/read requests; the private response method handles source validation and data loading.

*Call graph*: calls 1 internal fn (plugin_read_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_skill_read`  (lines 381–388)

```
async fn plugin_skill_read(
        &self,
        params: PluginSkillReadParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for reading the contents of a remote plugin skill. A skill is a plugin-provided capability or instruction set.

**Data flow**: It receives marketplace, plugin, and skill identifiers, delegates to `plugin_skill_read_response`, wraps the returned contents, and returns them.

**Call relations**: The request dispatcher calls this when the client asks for remote skill details.

*Call graph*: calls 1 internal fn (plugin_skill_read_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_save`  (lines 390–397)

```
async fn plugin_share_save(
        &self,
        params: PluginShareSaveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for creating or saving a remote share for a plugin. Sharing uploads or links a local plugin to a remote share ID.

**Data flow**: It receives share-save parameters, calls the internal share-save method, wraps the returned remote ID and share URL, and returns them.

**Call relations**: The client request dispatcher calls this for plugin/share/save, while the internal method performs validation and remote service calls.

*Call graph*: calls 1 internal fn (plugin_share_save_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_update_targets`  (lines 399–406)

```
async fn plugin_share_update_targets(
        &self,
        params: PluginShareUpdateTargetsParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for changing who can access a shared plugin. It lets clients update people or groups and the share visibility.

**Data flow**: It receives update parameters, delegates to the internal update method, wraps the updated access information, and returns it.

**Call relations**: The request dispatcher calls this for plugin/share/updateTargets requests.

*Call graph*: calls 1 internal fn (plugin_share_update_targets_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_list`  (lines 408–415)

```
async fn plugin_share_list(
        &self,
        params: PluginShareListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for listing the user’s plugin shares. It returns shared plugin summaries and any local path they correspond to.

**Data flow**: It receives list parameters, calls the internal list method, converts the result into a client payload, and returns it.

**Call relations**: The request dispatcher calls this for plugin/share/list requests.

*Call graph*: calls 1 internal fn (plugin_share_list_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_checkout`  (lines 417–424)

```
async fn plugin_share_checkout(
        &self,
        params: PluginShareCheckoutParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for checking out a shared remote plugin into the local plugin area. This is like downloading a shared project so it can be used locally.

**Data flow**: It receives a remote plugin ID, delegates to the checkout response method, wraps the local checkout details, and returns them.

**Call relations**: The request dispatcher calls this for plugin/share/checkout requests.

*Call graph*: calls 1 internal fn (plugin_share_checkout_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_share_delete`  (lines 426–433)

```
async fn plugin_share_delete(
        &self,
        params: PluginShareDeleteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for deleting a remote plugin share. It removes the share from the remote service and updates local caches.

**Data flow**: It receives the remote plugin ID, calls the internal delete method, wraps the empty success response, and returns it.

**Call relations**: The request dispatcher calls this for plugin/share/delete requests.

*Call graph*: calls 1 internal fn (plugin_share_delete_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_install`  (lines 435–442)

```
async fn plugin_install(
        &self,
        params: PluginInstallParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for installing a plugin. It supports installing from a local marketplace or from a remote marketplace.

**Data flow**: It receives install parameters, delegates to `plugin_install_response`, wraps the install result, and returns it.

**Call relations**: The request dispatcher calls this for plugin/install requests; the internal method chooses local or remote installation.

*Call graph*: calls 1 internal fn (plugin_install_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::plugin_uninstall`  (lines 444–451)

```
async fn plugin_uninstall(
        &self,
        params: PluginUninstallParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for uninstalling a plugin. It accepts either a local plugin ID or a remote plugin ID.

**Data flow**: It receives an uninstall request, calls `plugin_uninstall_response`, wraps the success result, and returns it.

**Call relations**: The request dispatcher calls this for plugin/uninstall requests.

*Call graph*: calls 1 internal fn (plugin_uninstall_response); called by 1 (handle_initialized_client_request).


##### `PluginRequestProcessor::effective_plugins_changed_callback`  (lines 453–462)

```
fn effective_plugins_changed_callback(&self) -> Arc<dyn Fn() + Send + Sync>
```

**Purpose**: Creates a callback that can be handed to background tasks so they can refresh the system when plugin availability changes.

**Data flow**: It captures the thread manager and config manager in a thread-safe closure. When called later, the closure starts the effective-plugin-change task. The function returns that closure.

**Call relations**: Listing, installed-plugin sync, and remote install or uninstall flows pass this callback to plugin manager background work so cache changes can trigger refreshes.

*Call graph*: called by 5 (load_remote_installed_plugins, plugin_installed_response, plugin_list_response, remote_plugin_install_response, remote_plugin_uninstall_response); 3 external calls (clone, new, clone).


##### `PluginRequestProcessor::on_effective_plugins_changed`  (lines 464–469)

```
fn on_effective_plugins_changed(&self)
```

**Purpose**: Immediately starts the standard refresh work after a plugin change. This is used after installs or uninstalls.

**Data flow**: It clones the needed shared services and calls the task-spawning helper. It does not wait for the refresh to finish.

**Call relations**: Local install, local uninstall, and remote uninstall paths call this once they know plugin state has changed.

*Call graph*: called by 3 (plugin_install_response, plugin_uninstall_response, remote_plugin_uninstall_response); 3 external calls (clone, spawn_effective_plugins_changed_task, clone).


##### `PluginRequestProcessor::spawn_effective_plugins_changed_task`  (lines 471–483)

```
fn spawn_effective_plugins_changed_task(
        thread_manager: Arc<ThreadManager>,
        config_manager: ConfigManager,
    )
```

**Purpose**: Runs the background cleanup and refresh after the effective plugin set changes. The effective set means the plugins that should actually be visible and usable.

**Data flow**: It receives the thread manager and config manager, spawns an asynchronous task, clears plugin and skill caches, checks whether any threads exist, and if so queues a best-effort MCP refresh. It returns immediately after spawning.

**Call relations**: Both direct change handling and callback-based background flows use this helper so all plugin changes refresh caches in the same way.

*Call graph*: calls 1 internal fn (queue_best_effort_refresh); 1 external calls (spawn).


##### `PluginRequestProcessor::clear_plugin_related_caches`  (lines 485–488)

```
fn clear_plugin_related_caches(&self)
```

**Purpose**: Clears cached plugin and skill data. This makes later reads reload fresh information after a share, checkout, delete, or uninstall.

**Data flow**: It reads the plugin and skill managers from the thread manager and tells both to clear their caches. It returns nothing.

**Call relations**: Share mutation flows and some uninstall fallback paths call this when plugin-related data may have changed but a full refresh is not necessarily run.

*Call graph*: called by 5 (plugin_share_checkout_response, plugin_share_delete_response, plugin_share_save_response, plugin_share_update_targets_response, plugin_uninstall_response).


##### `PluginRequestProcessor::load_latest_config`  (lines 490–498)

```
async fn load_latest_config(
        &self,
        fallback_cwd: Option<PathBuf>,
    ) -> Result<Config, JSONRPCErrorError>
```

**Purpose**: Reloads the current configuration and converts load failures into a JSON-RPC internal error. Many plugin operations need the freshest feature flags and paths.

**Data flow**: It receives an optional fallback current directory, asks the config manager to load the latest config, and returns the config or an internal error message.

**Call relations**: Most request handlers call this near the start, because plugin behavior depends on current config, feature flags, Codex home, and remote service URLs.

*Call graph*: calls 1 internal fn (load_latest_config); called by 9 (load_plugin_share_config_and_auth, plugin_install_response, plugin_installed_response, plugin_list_response, plugin_read_response, plugin_skill_read_response, plugin_uninstall_response, remote_plugin_install_response, remote_plugin_uninstall_response).


##### `PluginRequestProcessor::workspace_codex_plugins_enabled`  (lines 500–520)

```
async fn workspace_codex_plugins_enabled(
        &self,
        config: &Config,
        auth: Option<&CodexAuth>,
    ) -> bool
```

**Purpose**: Checks whether Codex plugins are allowed for the current workspace. If the workspace setting cannot be fetched, it logs a warning and allows plugins rather than blocking the user.

**Data flow**: It receives config and optional authentication, asks the workspace-settings helper for the plugin setting using the cache, and returns the setting. On lookup error, it returns true.

**Call relations**: Plugin listing, installed-plugin listing, and local install paths call this before showing or changing plugins for a workspace.

*Call graph*: calls 1 internal fn (codex_plugins_enabled_for_workspace); called by 3 (plugin_install_response, plugin_installed_response, plugin_list_response); 1 external calls (warn!).


##### `PluginRequestProcessor::plugin_list_response`  (lines 522–773)

```
async fn plugin_list_response(
        &self,
        params: PluginListParams,
    ) -> Result<PluginListResponse, JSONRPCErrorError>
```

**Purpose**: Builds the full response for plugin/list. It gathers local marketplace data, optional remote catalogs, background refresh hints, load errors, and featured plugin IDs.

**Data flow**: It receives list parameters, reloads config, checks feature and workspace permissions, determines which marketplace kinds to include, loads local marketplaces in a blocking task when needed, fetches remote marketplaces when allowed, starts background refresh tasks, and returns a `PluginListResponse`. Failures that should stop the request become JSON-RPC errors; some optional remote failures are logged and ignored.

**Call relations**: `PluginRequestProcessor::plugin_list` calls this. It coordinates helpers for config loading, share mapping, remote marketplace conversion, remote error conversion, and plugin-change callbacks.

*Call graph*: calls 10 internal fn (internal_error, effective_plugins_changed_callback, load_latest_config, workspace_codex_plugins_enabled, load_shared_plugin_ids_by_local_path, remote_marketplace_to_info, remote_plugin_catalog_error_to_jsonrpc, fetch_openai_curated_remote_collection_marketplace, fetch_remote_marketplaces, has_cached_global_remote_plugin_catalog); called by 1 (plugin_list); 5 external calls (marketplace_error, new, format!, spawn_blocking, warn!).


##### `PluginRequestProcessor::plugin_installed_response`  (lines 775–844)

```
async fn plugin_installed_response(
        &self,
        params: PluginInstalledParams,
    ) -> Result<PluginInstalledResponse, JSONRPCErrorError>
```

**Purpose**: Builds the response for plugin/installed. It combines locally installed or suggested plugins with remote installed plugins.

**Data flow**: It receives installed-plugin parameters, reloads config, checks feature and workspace permissions, starts remote installed-plugin sync, loads local installed and suggested plugins, loads remote installed plugins, removes duplicate curated conflicts, and returns marketplaces plus load errors.

**Call relations**: `PluginRequestProcessor::plugin_installed` calls this. It delegates local loading, remote loading, marketplace visibility, and duplicate filtering to focused helpers.

*Call graph*: calls 7 internal fn (effective_plugins_changed_callback, load_latest_config, load_local_installed_and_suggested_plugins, load_remote_installed_plugins, workspace_codex_plugins_enabled, filter_openai_curated_installed_conflicts, remote_installed_plugin_visible_marketplaces); called by 1 (plugin_installed).


##### `PluginRequestProcessor::load_local_installed_and_suggested_plugins`  (lines 846–927)

```
async fn load_local_installed_and_suggested_plugins(
        &self,
        plugins_manager: Arc<codex_core_plugins::PluginsManager>,
        config: &Config,
        plugins_input: &codex_core_plugin
```

**Purpose**: Loads local marketplace plugins that are either installed or explicitly suggested for install. This keeps the installed view focused instead of showing every available local plugin.

**Data flow**: It receives a plugin manager, config, plugin input, roots, and suggested names. It loads the share mapping, lists local marketplaces in a blocking task, filters each marketplace down to installed or suggested plugins, converts them to summaries, and returns marketplace entries plus load errors.

**Call relations**: `plugin_installed_response` calls this for the local half of the installed-plugin view.

*Call graph*: calls 2 internal fn (internal_error, load_shared_plugin_ids_by_local_path); called by 1 (plugin_installed_response); 4 external calls (marketplace_error, clone, format!, spawn_blocking).


##### `PluginRequestProcessor::load_remote_installed_plugins`  (lines 929–968)

```
async fn load_remote_installed_plugins(
        &self,
        plugins_manager: Arc<codex_core_plugins::PluginsManager>,
        plugins_input: &codex_core_plugins::PluginsConfigInput,
        visible
```

**Purpose**: Loads installed remote plugins, preferably from cache and otherwise from the remote service. If authentication or remote support is unavailable, it quietly returns no remote entries.

**Data flow**: It receives the plugin manager, plugin config input, visible marketplace names, and optional auth. It tries cached remote installed marketplaces first, otherwise builds and caches them remotely. Successful results are converted to client marketplace entries; recoverable remote errors produce an empty list.

**Call relations**: `plugin_installed_response` calls this after loading local installed plugins, then merges its output into the final installed response.

*Call graph*: calls 1 internal fn (effective_plugins_changed_callback); called by 1 (plugin_installed_response); 2 external calls (new, warn!).


##### `PluginRequestProcessor::plugin_read_response`  (lines 970–1154)

```
async fn plugin_read_response(
        &self,
        params: PluginReadParams,
    ) -> Result<PluginReadResponse, JSONRPCErrorError>
```

**Purpose**: Builds detailed information for one plugin, either from a local marketplace path or from a remote marketplace name. It returns descriptions, skills, hooks, apps, templates, MCP servers, and sharing data when available.

**Data flow**: It validates that exactly one source was provided, reloads config, gets auth, and then follows the local or remote path. For local plugins, it reads the plugin from the plugin manager, enriches share context if possible, filters skills by product restriction, loads app summaries, and builds a detail response. For remote plugins, it validates the remote ID, fetches remote detail, loads app summaries, and converts the remote detail.

**Call relations**: `PluginRequestProcessor::plugin_read` calls this. It uses many translation helpers because it is the main place where raw plugin data becomes a rich client-facing detail object.

*Call graph*: calls 12 internal fn (invalid_request, load_latest_config, load_plugin_app_summaries, load_shared_plugin_ids_by_local_path, marketplace_plugin_source_to_info, plugin_skills_to_info, remote_plugin_detail_to_info, remote_plugin_share_context_to_info, share_context_for_source, fetch_remote_plugin_detail (+2 more)); called by 1 (plugin_read); 3 external calls (new, format!, warn!).


##### `PluginRequestProcessor::plugin_skill_read_response`  (lines 1156–1198)

```
async fn plugin_skill_read_response(
        &self,
        params: PluginSkillReadParams,
    ) -> Result<PluginSkillReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads the full contents of a remote plugin skill. This is used when a client needs more than the summary shown in plugin details.

**Data flow**: It receives remote marketplace name, remote plugin ID, and skill name. It reloads config, checks plugins are enabled, validates the plugin ID and non-empty skill name, fetches the skill detail from the remote service, and returns the skill contents.

**Call relations**: `PluginRequestProcessor::plugin_skill_read` calls this for plugin skill read requests.

*Call graph*: calls 4 internal fn (invalid_request, load_latest_config, fetch_remote_plugin_skill_detail, validate_remote_plugin_id); called by 1 (plugin_skill_read); 1 external calls (format!).


##### `PluginRequestProcessor::plugin_share_save_response`  (lines 1200–1256)

```
async fn plugin_share_save_response(
        &self,
        params: PluginShareSaveParams,
    ) -> Result<PluginShareSaveResponse, JSONRPCErrorError>
```

**Purpose**: Creates a new remote share for a local plugin or saves an existing share. It validates what kind of share operation is allowed before contacting the remote service.

**Data flow**: It loads config and auth, checks sharing is enabled, validates the optional remote plugin ID, rejects unsupported combinations of fields, validates share targets, converts access policy fields, calls the remote save-share API, clears caches, and returns the remote plugin ID and share URL.

**Call relations**: `PluginRequestProcessor::plugin_share_save` calls this. It relies on share-target and discoverability conversion helpers before handing the request to the remote plugin service.

*Call graph*: calls 5 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, validate_client_plugin_share_targets, is_valid_remote_plugin_id); called by 1 (plugin_share_save); 1 external calls (save_remote_plugin_share).


##### `PluginRequestProcessor::plugin_share_update_targets_response`  (lines 1258–1299)

```
async fn plugin_share_update_targets_response(
        &self,
        params: PluginShareUpdateTargetsParams,
    ) -> Result<PluginShareUpdateTargetsResponse, JSONRPCErrorError>
```

**Purpose**: Updates the access list and visibility for an existing shared plugin. It returns the updated principals and discoverability.

**Data flow**: It loads config and auth, checks sharing is enabled, validates the remote plugin ID and targets, converts targets and visibility, calls the remote update API, clears caches, converts the returned principals, and returns the updated access state.

**Call relations**: `PluginRequestProcessor::plugin_share_update_targets` calls this when a client edits sharing permissions.

*Call graph*: calls 8 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, remote_plugin_share_discoverability_to_info, remote_plugin_share_targets, remote_plugin_share_update_discoverability, validate_client_plugin_share_targets, is_valid_remote_plugin_id); called by 1 (plugin_share_update_targets); 1 external calls (update_remote_plugin_share_targets).


##### `PluginRequestProcessor::plugin_share_list_response`  (lines 1301–1330)

```
async fn plugin_share_list_response(
        &self,
        _params: PluginShareListParams,
    ) -> Result<PluginShareListResponse, JSONRPCErrorError>
```

**Purpose**: Lists remote plugin shares known to the current user and matches them with local plugin paths when possible.

**Data flow**: It loads config and auth, calls the remote list-shares API using the Codex home path, converts each remote plugin summary, attaches the local path from the remote result, and returns the list.

**Call relations**: `PluginRequestProcessor::plugin_share_list` calls this for share-list requests.

*Call graph*: calls 1 internal fn (load_plugin_share_config_and_auth); called by 1 (plugin_share_list); 1 external calls (list_remote_plugin_shares).


##### `PluginRequestProcessor::plugin_share_checkout_response`  (lines 1332–1366)

```
async fn plugin_share_checkout_response(
        &self,
        params: PluginShareCheckoutParams,
    ) -> Result<PluginShareCheckoutResponse, JSONRPCErrorError>
```

**Purpose**: Checks out a shared remote plugin into the local filesystem. This makes the shared plugin available locally.

**Data flow**: It loads config and auth, checks sharing is enabled, validates the remote plugin ID, calls the remote checkout API, clears caches, and returns details such as plugin ID, name, local path, marketplace, and remote version.

**Call relations**: `PluginRequestProcessor::plugin_share_checkout` calls this when a client wants to use a shared plugin locally.

*Call graph*: calls 4 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, is_valid_remote_plugin_id); called by 1 (plugin_share_checkout); 1 external calls (checkout_remote_plugin_share).


##### `PluginRequestProcessor::plugin_share_delete_response`  (lines 1368–1391)

```
async fn plugin_share_delete_response(
        &self,
        params: PluginShareDeleteParams,
    ) -> Result<PluginShareDeleteResponse, JSONRPCErrorError>
```

**Purpose**: Deletes a remote plugin share and clears local plugin-related caches afterward.

**Data flow**: It loads config and auth, validates the remote plugin ID, calls the remote delete-share API using the Codex home path, clears caches, and returns an empty success response.

**Call relations**: `PluginRequestProcessor::plugin_share_delete` calls this for share deletion requests.

*Call graph*: calls 4 internal fn (invalid_request, clear_plugin_related_caches, load_plugin_share_config_and_auth, is_valid_remote_plugin_id); called by 1 (plugin_share_delete); 1 external calls (delete_remote_plugin_share).


##### `PluginRequestProcessor::load_plugin_share_config_and_auth`  (lines 1393–1402)

```
async fn load_plugin_share_config_and_auth(
        &self,
    ) -> Result<(Config, Option<CodexAuth>), JSONRPCErrorError>
```

**Purpose**: Loads the current config and current authentication for plugin-sharing operations. It also checks the broader plugins feature is enabled.

**Data flow**: It reloads config, returns an invalid-request error if plugins are disabled, fetches current auth, and returns both config and auth.

**Call relations**: All plugin share operations call this at the start so they share the same basic setup and feature check.

*Call graph*: calls 2 internal fn (invalid_request, load_latest_config); called by 5 (plugin_share_checkout_response, plugin_share_delete_response, plugin_share_list_response, plugin_share_save_response, plugin_share_update_targets_response).


##### `PluginRequestProcessor::plugin_install_response`  (lines 1404–1487)

```
async fn plugin_install_response(
        &self,
        params: PluginInstallParams,
    ) -> Result<PluginInstallResponse, JSONRPCErrorError>
```

**Purpose**: Installs a plugin from a local marketplace, or dispatches to remote install when a remote marketplace was requested. It also starts follow-up authentication checks for plugin MCP servers and apps.

**Data flow**: It validates that exactly one install source was provided. For remote installs, it delegates to `remote_plugin_install_response`. For local installs, it reloads config, checks workspace permission, calls the plugin manager to install, reloads config again if possible, triggers plugin refresh, starts silent MCP OAuth logins when needed, checks which plugin apps still need authorization, and returns install policy plus app-auth needs.

**Call relations**: `PluginRequestProcessor::plugin_install` calls this. It is the main coordinator for local plugin installation and the switchboard for remote installation.

*Call graph*: calls 7 internal fn (invalid_request, load_latest_config, on_effective_plugins_changed, plugin_apps_needing_auth_for_install, remote_plugin_install_response, start_plugin_mcp_oauth_logins, workspace_codex_plugins_enabled); called by 1 (plugin_install); 2 external calls (app_connector_ids_from_declarations, warn!).


##### `PluginRequestProcessor::remote_plugin_install_response`  (lines 1489–1647)

```
async fn remote_plugin_install_response(
        &self,
        remote_marketplace_name: String,
        remote_plugin_id: String,
    ) -> Result<PluginInstallResponse, JSONRPCErrorError>
```

**Purpose**: Installs a plugin from a remote marketplace. It downloads the bundle, installs it locally, records the install with the backend, refreshes caches, tracks analytics, and checks follow-up authentication needs.

**Data flow**: It reloads config, checks the plugins feature, validates the remote ID, fetches remote detail and download URLs, rejects disabled or unavailable plugins, validates the bundle, downloads and installs it under Codex home, calls the remote backend install API, refreshes remote-installed caches, tracks install analytics, starts MCP OAuth login attempts, determines app connectors needing auth, and returns the install response.

**Call relations**: Local install handling delegates here when the client specified a remote marketplace. This method coordinates remote catalog, remote bundle, analytics, MCP login, connector, and cache-refresh systems.

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

**Purpose**: Finds which app connectors declared by an installed plugin still need user authorization. An app connector is an integration with an external app or service.

**Data flow**: It receives config, auth mode, plugin ID, and the plugin’s app connector IDs. If app auth is not relevant, it returns an empty list. Otherwise it loads all known connectors and currently accessible connectors, falls back to caches on errors, and calls `plugin_apps_needing_auth` to compute the missing authorizations.

**Call relations**: Both local and remote install flows call this after installation so the client can prompt the user to connect any required apps.

*Call graph*: calls 4 internal fn (plugin_apps_needing_auth, connectors_for_plugin_apps, list_cached_all_connectors, list_cached_accessible_connectors_from_mcp_tools); called by 2 (plugin_install_response, remote_plugin_install_response); 4 external calls (new, is_empty, join!, warn!).


##### `PluginRequestProcessor::start_plugin_mcp_oauth_logins`  (lines 1714–1796)

```
async fn start_plugin_mcp_oauth_logins(
        &self,
        config: &Config,
        plugin_mcp_servers: HashMap<String, McpServerConfig>,
    )
```

**Purpose**: Starts silent OAuth login attempts for plugin-provided MCP servers that support OAuth. OAuth is a standard way to let a service grant access without sharing a password.

**Data flow**: It receives config and MCP server configs. For each server, it checks OAuth support, resolves scopes, captures credential and callback settings, and spawns a background task. The task tries silent login, may retry without scopes, then sends a server notification reporting success or failure.

**Call relations**: Local and remote install flows call this after installing a plugin that declares MCP servers, so required server logins can begin without blocking the install response.

*Call graph*: called by 2 (plugin_install_response, remote_plugin_install_response); 8 external calls (clone, McpServerOauthLoginCompleted, auth_keyring_backend_kind, oauth_login_support, should_retry_without_scopes, perform_oauth_login_silent, spawn, warn!).


##### `PluginRequestProcessor::plugin_uninstall_response`  (lines 1798–1827)

```
async fn plugin_uninstall_response(
        &self,
        params: PluginUninstallParams,
    ) -> Result<PluginUninstallResponse, JSONRPCErrorError>
```

**Purpose**: Uninstalls a local or remote plugin. It validates the ID, chooses the right uninstall path, and refreshes plugin state afterward.

**Data flow**: It receives a plugin ID string. If it looks like a remote plugin ID, it delegates to remote uninstall. Otherwise it parses it as a local plugin ID, asks the plugin manager to uninstall, tries to reload config, and either triggers a full plugin-change refresh or clears caches if config reload fails.

**Call relations**: `PluginRequestProcessor::plugin_uninstall` calls this for uninstall requests.

*Call graph*: calls 7 internal fn (invalid_request, clear_plugin_related_caches, load_latest_config, on_effective_plugins_changed, remote_plugin_uninstall_response, is_valid_remote_plugin_id, parse); called by 1 (plugin_uninstall); 1 external calls (warn!).


##### `PluginRequestProcessor::plugin_install_error`  (lines 1829–1851)

```
fn plugin_install_error(err: CorePluginInstallError) -> JSONRPCErrorError
```

**Purpose**: Converts lower-level local install errors into JSON-RPC errors the client understands. User-caused problems become invalid requests; system failures become internal errors.

**Data flow**: It receives a core install error. If the error marks itself as an invalid request, it returns that. Otherwise it matches the error kind, delegates marketplace errors to `marketplace_error`, and formats configuration, remote, join, or store failures as internal errors.

**Call relations**: The local install path uses this when the plugin manager fails to install a plugin.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 4 external calls (is_invalid_request, to_string, marketplace_error, format!).


##### `PluginRequestProcessor::plugin_uninstall_error`  (lines 1853–1875)

```
fn plugin_uninstall_error(err: CorePluginUninstallError) -> JSONRPCErrorError
```

**Purpose**: Converts lower-level uninstall errors into client-facing JSON-RPC errors. It separates bad user input from server-side failures.

**Data flow**: It receives a core uninstall error. Invalid-request errors are passed through as invalid requests; config, remote, join, and store failures become internal errors. The invalid-plugin-ID case is unreachable because IDs are checked earlier.

**Call relations**: The local uninstall path uses this when the plugin manager reports a failure.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 4 external calls (is_invalid_request, to_string, format!, unreachable!).


##### `PluginRequestProcessor::marketplace_error`  (lines 1877–1887)

```
fn marketplace_error(err: MarketplaceError, action: &str) -> JSONRPCErrorError
```

**Purpose**: Converts marketplace loading or lookup errors into JSON-RPC errors. Missing or invalid plugin data is usually a bad request; disk or I/O trouble is an internal problem.

**Data flow**: It receives a marketplace error and a human-readable action. It maps not-found, invalid file, unavailable plugin, disabled plugins, and invalid plugin cases to invalid-request errors. I/O failures become internal errors that include the action.

**Call relations**: Listing, reading, and installing helpers use this common converter so marketplace errors are reported consistently.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (to_string, format!).


##### `PluginRequestProcessor::remote_plugin_uninstall_response`  (lines 1889–1930)

```
async fn remote_plugin_uninstall_response(
        &self,
        plugin_id: String,
    ) -> Result<PluginUninstallResponse, JSONRPCErrorError>
```

**Purpose**: Uninstalls a remote plugin through the remote service and refreshes local remote-installed caches. It also handles some cache-removal failures specially so state can still refresh.

**Data flow**: It reloads config, checks plugins are enabled, validates the remote ID, gets auth, calls the remote uninstall API, and if the uninstall succeeded or only cache removal failed, clears and refreshes remote installed plugin caches and triggers plugin-change handling. It then converts any remaining remote error to JSON-RPC and returns success if none remains.

**Call relations**: `plugin_uninstall_response` delegates here when the requested plugin ID is a valid remote plugin ID.

*Call graph*: calls 6 internal fn (invalid_request, effective_plugins_changed_callback, load_latest_config, on_effective_plugins_changed, uninstall_remote_plugin, validate_remote_plugin_id); called by 1 (plugin_uninstall_response); 1 external calls (matches!).


##### `load_plugin_app_summaries`  (lines 1933–1976)

```
async fn load_plugin_app_summaries(
    config: &Config,
    plugin_apps: &[codex_plugin::AppConnectorId],
    app_category_by_id: &HashMap<String, String>,
) -> Vec<AppSummary>
```

**Purpose**: Loads human-readable summaries for the app connectors used by a plugin. These summaries let the client show app names, descriptions, categories, and install URLs.

**Data flow**: It receives config, plugin app connector IDs, and optional category overrides. If there are no apps, it returns an empty list. Otherwise it loads connector metadata, falls back to cached metadata if needed, filters to the plugin’s connectors, applies category overrides when present, and returns app summaries.

**Call relations**: Plugin detail reading calls this for both local and remote plugins so app information appears in plugin/read responses.

*Call graph*: calls 3 internal fn (connectors_for_plugin_apps, list_all_connectors_with_options, list_cached_all_connectors); called by 1 (plugin_read_response); 3 external calls (new, is_empty, warn!).


##### `plugin_app_category_by_id_from_value`  (lines 1978–1983)

```
fn plugin_app_category_by_id_from_value(value: &serde_json::Value) -> HashMap<String, String>
```

**Purpose**: Extracts app connector categories from a plugin app manifest represented as JSON. This helps remote plugin details preserve category labels from their manifest.

**Data flow**: It receives a JSON value, parses plugin app declarations from it, keeps only declarations with a category, and returns a map from connector ID to category.

**Call relations**: Remote plugin read and remote install logic use this when a remote plugin includes an app manifest.

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

**Purpose**: Computes which plugin app connectors are known but not currently accessible to the user. These are the apps the client may need to ask the user to authorize.

**Data flow**: It receives all connector metadata, accessible connector metadata, the plugin’s connector IDs, and a readiness flag. If Codex apps are not ready, it returns an empty list. Otherwise it compares plugin app IDs against accessible IDs and returns summaries for plugin apps that are missing from the accessible set.

**Call relations**: `PluginRequestProcessor::plugin_apps_needing_auth_for_install` calls this after loading connector lists.

*Call graph*: called by 1 (plugin_apps_needing_auth_for_install); 3 external calls (new, iter, iter).


##### `remote_marketplace_to_info`  (lines 2024–2037)

```
fn remote_marketplace_to_info(marketplace: RemoteMarketplace) -> PluginMarketplaceEntry
```

**Purpose**: Converts a remote marketplace into the same marketplace entry shape used by client responses. Remote marketplaces do not have a local filesystem path.

**Data flow**: It receives a remote marketplace, copies its name and display name, sets the path to none, converts each remote plugin summary, and returns a `PluginMarketplaceEntry`.

**Call relations**: Plugin list and remote installed-plugin loading use this when adding remote catalog results to client responses.

*Call graph*: called by 1 (plugin_list_response).


##### `remote_plugin_summary_to_info`  (lines 2039–2057)

```
fn remote_plugin_summary_to_info(summary: RemoteCatalogPluginSummary) -> PluginSummary
```

**Purpose**: Converts a remote catalog plugin summary into the protocol’s general plugin summary. It marks the source as remote and carries remote-specific fields such as remote plugin ID.

**Data flow**: It receives a remote summary, copies IDs, name, installed and enabled state, policies, availability, interface, keywords, and converted share context. It returns a `PluginSummary` with no local version.

**Call relations**: Remote marketplace and remote plugin detail conversion call this so remote plugins can be displayed beside local plugins.

*Call graph*: called by 1 (remote_plugin_detail_to_info).


##### `remote_plugin_share_context_to_info`  (lines 2059–2078)

```
fn remote_plugin_share_context_to_info(
    context: RemoteCatalogPluginShareContext,
) -> PluginShareContext
```

**Purpose**: Converts remote share context into the client-facing share context. This includes visibility, share URL, creator information, version, and access principals.

**Data flow**: It receives remote share context, maps discoverability, copies remote ID, version, URL, creator fields, and converts any principal list. It returns the protocol share context.

**Call relations**: Local plugin read enrichment and remote plugin summary conversion use this whenever remote sharing information is available.

*Call graph*: calls 1 internal fn (remote_plugin_share_discoverability_to_info); called by 1 (plugin_read_response).


##### `remote_plugin_share_discoverability_to_info`  (lines 2080–2094)

```
fn remote_plugin_share_discoverability_to_info(
    discoverability: codex_core_plugins::remote::RemotePluginShareDiscoverability,
) -> PluginShareDiscoverability
```

**Purpose**: Converts remote-service share visibility into the protocol visibility type. The values are listed, unlisted, and private.

**Data flow**: It receives one remote discoverability value and returns the matching client protocol value.

**Call relations**: Share update responses and share context conversion call this before sending visibility information to the client.

*Call graph*: called by 2 (plugin_share_update_targets_response, remote_plugin_share_context_to_info).


##### `remote_plugin_detail_to_info`  (lines 2096–2146)

```
fn remote_plugin_detail_to_info(
    detail: RemoteCatalogPluginDetail,
    apps: Vec<AppSummary>,
) -> PluginDetail
```

**Purpose**: Converts a full remote plugin detail response into the protocol’s plugin detail type. It includes summaries, description, skills, apps, templates, share URL, and MCP servers.

**Data flow**: It receives remote detail plus already-loaded app summaries. It converts app templates and unavailable reasons, converts the summary, maps remote skills into skill summaries without local paths, sets hooks empty because remote detail does not provide local hooks here, and returns `PluginDetail`.

**Call relations**: Remote plugin read handling calls this after fetching remote detail and app metadata.

*Call graph*: calls 1 internal fn (remote_plugin_summary_to_info); called by 1 (plugin_read_response); 1 external calls (new).


##### `remote_plugin_catalog_error_to_jsonrpc`  (lines 2148–2179)

```
fn remote_plugin_catalog_error_to_jsonrpc(
    err: RemotePluginCatalogError,
    context: &str,
) -> JSONRPCErrorError
```

**Purpose**: Turns remote marketplace and sharing errors into JSON-RPC errors. It decides which errors are caused by the request and which are server or network failures.

**Data flow**: It receives a remote catalog error and context text, builds a message, and maps authentication problems, unsupported auth, 404s, invalid plugin paths, unavailable checkouts, too-large archives, and unknown marketplaces to invalid requests. Token, request, decoding, archive, cache, and unexpected-response problems become internal errors.

**Call relations**: Remote list, read, skill read, share, install, and uninstall flows use this converter whenever the remote plugin service returns an error.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); called by 1 (plugin_list_response); 1 external calls (format!).


##### `remote_plugin_bundle_install_error_to_jsonrpc`  (lines 2181–2185)

```
fn remote_plugin_bundle_install_error_to_jsonrpc(
    err: codex_core_plugins::remote_bundle::RemotePluginBundleInstallError,
) -> JSONRPCErrorError
```

**Purpose**: Converts remote plugin bundle installation failures into JSON-RPC internal errors. Bundle installation failures are treated as server-side materialization problems.

**Data flow**: It receives a remote bundle install error, formats it with install context, and returns an internal error.

**Call relations**: Remote plugin install uses this when validating, downloading, or installing a remote plugin bundle fails.

*Call graph*: calls 1 internal fn (internal_error); 1 external calls (format!).


### `app-server/src/request_processors/remote_control_processor.rs`

`orchestration` · `request handling`

This file sits between the outside API and the remote-control machinery inside the app server. A client can ask to enable or disable remote control, read its status, start or check pairing, list paired clients, or revoke a client. This processor is the “front desk”: it checks that remote control exists and is allowed, forwards the request to the real remote-control handle, then packages the answer in the protocol’s response types.

A key job here is error translation. The lower layer often reports problems as Rust I/O errors, such as “not found” or “permission denied.” Those are useful to the program, but not ideal for an API caller. This file decides whether each problem should be reported as a bad request from the caller or as an internal server error. For example, invalid pairing input becomes an invalid request, while an unexpected filesystem-style failure becomes an internal error.

The file also protects one important pairing rule: when checking pairing status, the caller must provide exactly one kind of pairing code, not both and not neither. Without this processor, API routes would either duplicate this checking and error mapping everywhere, or leak low-level errors directly to clients.

#### Function details

##### `RemoteControlRequestProcessor::new`  (lines 26–30)

```
fn new(remote_control_handle: Option<RemoteControlHandle>) -> Self
```

**Purpose**: Creates a new processor and gives it the optional remote-control handle it will use later. This lets the app server run even in builds or situations where remote control is not available.

**Data flow**: It receives an optional RemoteControlHandle. It stores that value inside a RemoteControlRequestProcessor. The result is a ready-to-use processor whose later methods will either use the handle or return an error if the handle is missing.

**Call relations**: Startup or setup code calls this when building the request-processing layer. Tests also call it directly to check behavior when remote control is unavailable, especially for pairing-related requests.

*Call graph*: called by 3 (new, pairing_start_returns_internal_error_when_remote_control_is_unavailable, pairing_status_returns_internal_error_when_remote_control_is_unavailable).


##### `RemoteControlRequestProcessor::enable`  (lines 32–47)

```
async fn enable(
        &self,
        ephemeral: bool,
        app_server_client_name: Option<&str>,
    ) -> Result<RemoteControlEnableResponse, JSONRPCErrorError>
```

**Purpose**: Turns an API request to enable remote control into the correct lower-level enable action. It supports both normal enablement and temporary, or ephemeral, enablement.

**Data flow**: It receives a flag saying whether the enablement is ephemeral and an optional app-server client name. First it asks handle for a usable remote-control handle. If ephemeral is true, it enables the temporary mode; otherwise it enables normal remote control and may record the client name. It converts the resulting status into a RemoteControlEnableResponse, or converts failures into JSON-RPC errors.

**Call relations**: The initialized client request handler calls this when a remote-control enable request arrives. This method relies on handle to verify availability and permission, then hands off to the transport layer. It uses response conversion with from and maps enable/update failures before returning to the API layer.

*Call graph*: calls 2 internal fn (from, handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::disable`  (lines 49–64)

```
async fn disable(
        &self,
        ephemeral: bool,
        app_server_client_name: Option<&str>,
    ) -> Result<RemoteControlDisableResponse, JSONRPCErrorError>
```

**Purpose**: Turns an API request to disable remote control into the matching lower-level disable action. It handles both temporary and normal remote-control modes.

**Data flow**: It receives an ephemeral flag and an optional app-server client name. It first gets a valid handle. For ephemeral mode, it disables the temporary remote-control state. For normal mode, it asks the handle to disable remote control and may pass along the client name. It wraps the returned status into a RemoteControlDisableResponse, or reports a translated JSON-RPC error.

**Call relations**: The initialized client request handler calls this for remote-control disable requests. The method uses handle as the common gatekeeper, then delegates the actual state change to the remote-control transport handle.

*Call graph*: calls 2 internal fn (from, handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::status_read`  (lines 66–74)

```
fn status_read(&self) -> Result<RemoteControlStatusReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads the current remote-control status and formats it for the API caller. This is the safe, read-only way for clients to ask whether remote control is active and what identity information is associated with it.

**Data flow**: It takes no request body beyond the processor itself. It gets a valid handle, reads the current status, and copies fields such as status, server name, installation ID, and environment ID into a RemoteControlStatusReadResponse. If remote control is unavailable or disallowed, it returns a JSON-RPC error instead.

**Call relations**: The initialized client request handler calls this when a status-read request arrives. It depends on handle for availability checks, then reads directly from the remote-control handle without changing remote-control state.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::pairing_start`  (lines 76–85)

```
async fn pairing_start(
        &self,
        params: RemoteControlPairingStartParams,
        app_server_client_name: Option<&str>,
    ) -> Result<RemoteControlPairingStartResponse, JSONRPCErrorErr
```

**Purpose**: Starts the process of pairing a remote client with this app server. Pairing is the setup step that lets another client become trusted for remote control.

**Data flow**: It receives pairing-start parameters and an optional app-server client name. It gets a valid handle and passes the request to the lower-level start_pairing operation. The successful result is returned as the API response; I/O-style failures are converted into JSON-RPC errors.

**Call relations**: The initialized client request handler calls this when a client asks to begin pairing. This method performs only the routing and error mapping; the remote-control handle does the real pairing work.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::pairing_status`  (lines 87–97)

```
async fn pairing_status(
        &self,
        params: RemoteControlPairingStatusParams,
    ) -> Result<RemoteControlPairingStatusResponse, JSONRPCErrorError>
```

**Purpose**: Checks the progress or result of a remote-control pairing attempt. It also enforces that the caller identifies the pairing attempt in exactly one supported way.

**Data flow**: It receives pairing-status parameters. First it validates that the request contains either pairingCode or manualPairingCode, but not both. Then it gets a valid handle and asks the lower layer for the pairing status. It returns the status response or converts failures into JSON-RPC errors.

**Call relations**: The initialized client request handler calls this for pairing-status requests. This method is the only function in this file that calls validate_pairing_status_params before using handle, because malformed pairing lookup input should be rejected before any lower-level work happens.

*Call graph*: calls 2 internal fn (handle, validate_pairing_status_params); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::clients_list`  (lines 99–107)

```
async fn clients_list(
        &self,
        params: RemoteControlClientsListParams,
    ) -> Result<RemoteControlClientsListResponse, JSONRPCErrorError>
```

**Purpose**: Lists clients that are known to or paired with the remote-control system. This lets an API caller inspect who currently has remote-control access.

**Data flow**: It receives list parameters, gets a valid remote-control handle, and passes the parameters to the handle’s list_clients operation. The returned client list becomes the API response; client-management failures are translated into JSON-RPC errors.

**Call relations**: The initialized client request handler calls this when a client-list request arrives. The function uses handle for common checks, then delegates the actual listing to the remote-control transport layer.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::clients_revoke`  (lines 109–117)

```
async fn clients_revoke(
        &self,
        params: RemoteControlClientsRevokeParams,
    ) -> Result<RemoteControlClientsRevokeResponse, JSONRPCErrorError>
```

**Purpose**: Revokes a remote-control client so it can no longer use its previous access. This is the API path for removing trust from a paired client.

**Data flow**: It receives revoke parameters, gets a valid remote-control handle, and sends the revoke request to the handle. The lower layer returns a revoke response if successful. If the target is invalid, missing, blocked, or otherwise fails, the error is translated for the JSON-RPC caller.

**Call relations**: The initialized client request handler calls this for client-revoke requests. Like clients_list, it uses handle as the shared safety gate and map_client_management_error to present lower-level problems in API terms.

*Call graph*: calls 1 internal fn (handle); called by 1 (handle_initialized_client_request).


##### `RemoteControlRequestProcessor::handle`  (lines 119–128)

```
fn handle(&self) -> Result<&RemoteControlHandle, JSONRPCErrorError>
```

**Purpose**: Provides the shared safety check used before almost every remote-control operation. It makes sure the processor actually has a remote-control handle and that remote control is allowed in this app-server environment.

**Data flow**: It reads the optional handle stored in the processor. If there is no handle, it returns an internal JSON-RPC error saying remote control is unavailable. If there is a handle but remote control is not allowed, it returns an invalid-request error. If both checks pass, it returns a reference to the handle.

**Call relations**: All main request methods call this before touching the remote-control service: enable, disable, status_read, pairing_start, pairing_status, clients_list, and clients_revoke. It centralizes the availability and permission checks so each request path does not need to repeat them.

*Call graph*: called by 7 (clients_list, clients_revoke, disable, enable, pairing_start, pairing_status, status_read).


##### `map_enable_error`  (lines 131–136)

```
fn map_enable_error(err: RemoteControlEnableError) -> JSONRPCErrorError
```

**Purpose**: Converts errors from enabling ephemeral remote control into JSON-RPC errors that make sense to API clients. It separates “remote control is unavailable” from “requirements do not allow this.”

**Data flow**: It receives a RemoteControlEnableError. If the error says remote control is unavailable, it forwards that to map_unavailable. If the error says requirements disabled the feature, it turns the message into an invalid-request error. The output is always a JSON-RPC error object.

**Call relations**: The enable method uses this when the ephemeral enable path fails. It delegates the unavailable case to map_unavailable so that unavailable remote-control errors are translated consistently.

*Call graph*: calls 2 internal fn (invalid_request, map_unavailable); 1 external calls (to_string).


##### `map_unavailable`  (lines 138–140)

```
fn map_unavailable(err: RemoteControlUnavailable) -> JSONRPCErrorError
```

**Purpose**: Turns a remote-control-unavailable condition into a client-facing invalid-request error. This tells the caller that the requested remote-control action cannot be performed in the current setup.

**Data flow**: It receives a RemoteControlUnavailable value, turns its message into text, and wraps that text as a JSON-RPC invalid-request error. It does not change any server state.

**Call relations**: map_enable_error calls this for the unavailable branch of enable-related failures. It is a small helper used to keep that error conversion clear and consistent.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (map_enable_error); 1 external calls (to_string).


##### `map_update_error`  (lines 142–151)

```
fn map_update_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts lower-level update failures from enabling or disabling normal remote control into the right kind of JSON-RPC error. It treats expected access or missing-file problems differently from surprising server failures.

**Data flow**: It receives an io::Error, which is Rust’s general input/output error type. If the error kind is NotFound or PermissionDenied, it returns an invalid-request error because the caller’s requested operation cannot be completed in the current environment. For other error kinds, it returns an internal server error.

**Call relations**: The normal enable and disable paths use this after calling the remote-control handle. It is not called directly by the request router; it sits between the transport layer’s raw error and the API response.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (to_string, matches!).


##### `map_pairing_start_error`  (lines 153–159)

```
fn map_pairing_start_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts pairing-related I/O errors into JSON-RPC errors. It marks bad pairing input as the caller’s mistake and unexpected failures as server problems.

**Data flow**: It receives an io::Error. If the error kind is InvalidInput, it returns an invalid-request error with the original message. Otherwise, it returns an internal error with that message. The output is a JSON-RPC error ready to send back to the caller.

**Call relations**: pairing_start and pairing_status use this after the lower-level pairing operations fail. It keeps pairing error behavior consistent between starting a pairing attempt and checking its status.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (kind, to_string).


##### `validate_pairing_status_params`  (lines 161–173)

```
fn validate_pairing_status_params(
    params: &RemoteControlPairingStatusParams,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Checks that a pairing-status request names the pairing attempt in one clear way. The request must include either a normal pairing code or a manual pairing code, but not both.

**Data flow**: It reads the pairing_code and manual_pairing_code fields from the parameters. If exactly one is present, it returns success. If both are present, it returns an invalid-request error explaining that only one is allowed. If neither is present, it returns an invalid-request error explaining that one is required.

**Call relations**: pairing_status calls this before asking the remote-control handle for status. This prevents confusing or incomplete requests from reaching the lower pairing system.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (pairing_status).


##### `map_client_management_error`  (lines 175–183)

```
fn map_client_management_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts errors from listing or revoking remote-control clients into API-friendly JSON-RPC errors. It distinguishes normal request problems from unexpected server failures.

**Data flow**: It receives an io::Error. InvalidInput, NotFound, PermissionDenied, and WouldBlock become invalid-request errors, because they describe cases the caller can usually understand or correct. Any other kind becomes an internal error. The returned value is the JSON-RPC error sent back through the request layer.

**Call relations**: clients_list and clients_revoke use this after client-management operations fail. It keeps both client-listing and client-revoking endpoints consistent in how they explain failures.

*Call graph*: calls 2 internal fn (internal_error, invalid_request); 2 external calls (kind, to_string).


### `app-server/src/request_processors/search.rs`

`orchestration` · `request handling`

This file is the app server’s front desk for file search requests. A client can ask for a one-off fuzzy file search, or it can start a search session and keep changing the query as the user types. “Fuzzy” means the search can find likely matches even when the query is partial or not an exact file name.

The main type, `SearchRequestProcessor`, keeps three shared pieces of state. It has an outgoing message sender, used by live search sessions to send results back to the client. It has a map of pending one-off searches, keyed by cancellation token, so a newer request can cancel an older one with the same token. And it has a map of active search sessions, keyed by session id.

For one-off searches, the processor creates a cancellation flag, runs the fuzzy search, then carefully removes the flag only if it still belongs to that same request. That last check matters because another request may have reused the same token while the old search was still finishing.

For sessions, the processor validates the session id, starts a background search session, stores it, lets later requests update its query, and removes it when asked to stop. Without this file, the server might have the search engine itself, but it would not have the request-level bookkeeping needed to cancel, update, or stop searches safely.

#### Function details

##### `SearchRequestProcessor::new`  (lines 31–37)

```
fn new(outgoing: Arc<OutgoingMessageSender>) -> Self
```

**Purpose**: Creates a new search request processor with empty tracking tables for pending searches and active search sessions. It is used when the server is wiring together the parts that will respond to client requests.

**Data flow**: It receives an outgoing message sender that can later be used to send search updates back to the client. It wraps that sender and creates two empty shared maps: one for cancellable one-off searches and one for live search sessions. It returns a ready-to-use `SearchRequestProcessor`.

**Call relations**: This is called during higher-level setup, when the server builds its request processors. After construction, the returned processor is used by request handling code to respond to search requests.

*Call graph*: called by 1 (new); 3 external calls (new, new, new).


##### `SearchRequestProcessor::fuzzy_file_search`  (lines 39–79)

```
async fn fuzzy_file_search(
        &self,
        params: FuzzyFileSearchParams,
    ) -> Result<FuzzyFileSearchResponse, JSONRPCErrorError>
```

**Purpose**: Runs a one-time fuzzy file search and returns the matching files. If the request includes a cancellation token, it also makes sure an older search using the same token is told to stop.

**Data flow**: It receives a query string, a list of root folders to search, and an optional cancellation token. If there is a token, it looks for an older pending search with that same token and flips its cancellation flag, then stores a fresh flag for the new search. If the query is empty, it returns an empty file list. Otherwise it passes the query, roots, and cancellation flag to the fuzzy search engine. When the search finishes, it removes its own pending entry if it is still the current one for that token, then returns the found files in a response object.

**Call relations**: The initialized client request handler calls this when a client asks for a one-off fuzzy file search. This function does the request bookkeeping, then hands the actual searching to `run_fuzzy_file_search`. It returns the finished response directly to the request handling path.

*Call graph*: calls 1 internal fn (run_fuzzy_file_search); called by 1 (handle_initialized_client_request); 4 external calls (new, ptr_eq, new, vec!).


##### `SearchRequestProcessor::fuzzy_file_search_session_start_response`  (lines 81–100)

```
async fn fuzzy_file_search_session_start_response(
        &self,
        params: FuzzyFileSearchSessionStartParams,
    ) -> Result<FuzzyFileSearchSessionStartResponse, JSONRPCErrorError>
```

**Purpose**: Starts a live fuzzy file search session that can later receive query updates. This is useful for interactive search, such as updating results as a user types.

**Data flow**: It receives a session id and search roots. First it checks that the session id is not empty, because the id is the name used to find this session later. If the id is valid, it asks the fuzzy search system to start a session, giving it the roots and the outgoing message sender so results can be sent back to the client. It stores the new session in the active session map and returns an empty success response. If the id is empty or the session cannot be started, it returns a JSON-RPC error, meaning an error formatted for the client-server protocol.

**Call relations**: The initialized client request handler calls this when the client wants to begin an interactive search session. This function validates and records the session, while `start_fuzzy_file_search_session` creates the underlying search worker.

*Call graph*: calls 2 internal fn (invalid_request, start_fuzzy_file_search_session); called by 1 (handle_initialized_client_request).


##### `SearchRequestProcessor::fuzzy_file_search_session_update_response`  (lines 102–123)

```
async fn fuzzy_file_search_session_update_response(
        &self,
        params: FuzzyFileSearchSessionUpdateParams,
    ) -> Result<FuzzyFileSearchSessionUpdateResponse, JSONRPCErrorError>
```

**Purpose**: Changes the query for an existing fuzzy file search session. It lets the same session keep running while the user edits the search text.

**Data flow**: It receives a session id and a new query string. It looks up the session id in the active session map. If the session exists, it sends the new query into that session and returns an empty success response. If no session with that id exists, it returns an invalid-request error explaining that the session was not found.

**Call relations**: The initialized client request handler calls this when the client updates an interactive search query. This function finds the stored session and hands the new query to it; if the client refers to an unknown session, it stops the flow with a clear request error.

*Call graph*: calls 1 internal fn (invalid_request); called by 1 (handle_initialized_client_request); 1 external calls (format!).


##### `SearchRequestProcessor::fuzzy_file_search_session_stop`  (lines 125–133)

```
async fn fuzzy_file_search_session_stop(
        &self,
        params: FuzzyFileSearchSessionStopParams,
    ) -> Result<FuzzyFileSearchSessionStopResponse, JSONRPCErrorError>
```

**Purpose**: Stops tracking a fuzzy file search session by removing it from the active session map. This is how the server cleans up when the client is done with an interactive search.

**Data flow**: It receives a session id. It locks the active session map and removes the entry for that id if one exists. It then returns an empty success response, even if there was no matching session to remove.

**Call relations**: The initialized client request handler calls this when the client asks to stop a search session. Removing the stored session is the handoff point that lets the session be dropped and cleaned up by the rest of the search-session machinery.

*Call graph*: called by 1 (handle_initialized_client_request).


### Exec server RPC handling
This group captures the exec server's JSON-RPC transport, method registration, and per-feature handlers that translate incoming methods into local process and filesystem operations.

### `exec-server/src/server/handler.rs`

`orchestration` · `connection lifetime and request handling`

Think of this file as the front desk for the exec server. A client connects and sends JSON-RPC requests, which are structured messages asking the server to do things. This handler checks whether the client is allowed to ask yet, attaches the connection to a session, and then forwards each approved request to the worker that actually knows how to do it.

The most important rule here is the startup handshake. The client must call `initialize`, then send an `initialized` notification, before it can run commands, read files, make HTTP requests, or ask about the environment. Without these checks, a client could try to use a session that does not exist yet, or keep using a session after another connection has resumed it.

The handler also owns connection-wide cleanup. On shutdown it cancels background work, waits for streamed HTTP bodies to stop, shuts down file-system resources, and detaches from the session. For HTTP responses with streamed bodies, it keeps a set of active stream IDs so the same stream name cannot be reused while still running.

Most methods in this file are small gates: verify initialization, then delegate to the process session, file-system handler, or HTTP runner. That makes this file less like the engine itself and more like the switchboard that keeps requests in the right order.

#### Function details

##### `ExecServerHandler::new`  (lines 74–90)

```
fn new(
        session_registry: Arc<SessionRegistry>,
        notifications: RpcNotificationSender,
        runtime_paths: ExecServerRuntimePaths,
    ) -> Self
```

**Purpose**: Creates a fresh handler for one server connection. It prepares the session link, notification sender, file-system helper, HTTP stream tracking, background task controls, and initialization flags.

**Data flow**: It receives a shared session registry, a way to send notifications back to the client, and runtime path settings. From these it builds an empty handler: no session is attached yet, no HTTP body streams are active, background tasks can be cancelled later, and initialization is marked as not started.

**Call relations**: This is called when a connection is being set up, such as by `run_connection`, and also by tests that exercise session and notification behavior. The object it returns is then used by all later request methods in this file.

*Call graph*: calls 1 internal fn (new); called by 5 (active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, run_connection); 6 external calls (new, new, new, new, new, new).


##### `ExecServerHandler::shutdown`  (lines 92–100)

```
async fn shutdown(&self)
```

**Purpose**: Stops work owned by this handler and detaches from its session. This is the orderly cleanup path when the connection is closing.

**Data flow**: It starts with a live handler that may have background HTTP streaming tasks, open file-system resources, and an attached session. It cancels the background-task token, closes the task tracker so no more tasks are accepted, waits for existing tasks to finish, shuts down the file-system helper, and detaches the session if one exists.

**Call relations**: This method uses `session` to find the current session. It is the counterpart to request handling: after requests have run, shutdown makes sure long-running helpers are not left behind.

*Call graph*: calls 2 internal fn (shutdown, session); 3 external calls (cancel, close, wait).


##### `ExecServerHandler::is_session_attached`  (lines 102–105)

```
fn is_session_attached(&self) -> bool
```

**Purpose**: Answers whether this handler is still connected to its session, or has no session yet. It is useful for checking whether the connection can still be considered valid.

**Data flow**: It reads the handler's stored session. If there is no session, it treats the state as acceptable; if there is a session, it asks that session whether it is still attached to this connection.

**Call relations**: It relies on `session` for safe access to the stored session handle. Other parts of the server can use this as a quick health check for the connection's session ownership.

*Call graph*: calls 1 internal fn (session).


##### `ExecServerHandler::initialize`  (lines 107–139)

```
async fn initialize(
        &self,
        params: InitializeParams,
    ) -> Result<InitializeResponse, JSONRPCErrorError>
```

**Purpose**: Starts or resumes the session for this connection. It enforces that initialization happens only once per connection.

**Data flow**: It receives initialization parameters, including an optional session ID to resume. It first marks that initialization has been requested; if that was already true, it returns an error. It then asks the session registry to attach this connection to a new or existing session. On success, it stores the session handle and returns the session ID to the client. On failure, it clears the initialization-requested flag so the client is not stuck in a half-started state.

**Call relations**: This is the first major step before most other methods can be used. Later calls to `initialized` and `require_initialized_for` depend on the flags and session handle set here.

*Call graph*: calls 1 internal fn (invalid_request); 5 external calls (store, swap, lock, clone, debug!).


##### `ExecServerHandler::initialized`  (lines 141–149)

```
fn initialized(&self) -> Result<(), String>
```

**Purpose**: Records that the client has completed the second part of the startup handshake. This notification means the server may now accept normal work requests.

**Data flow**: It checks that `initialize` was already requested. Then it verifies that the stored session is still attached to this connection. If both checks pass, it marks the handler as fully initialized; otherwise it returns a plain error message.

**Call relations**: It calls `require_session_attached` to make sure another connection has not taken over the session. Methods such as `exec`, file-system calls, and `http_request` later rely on this flag through `require_initialized_for`.

*Call graph*: calls 1 internal fn (require_session_attached); 2 external calls (load, store).


##### `ExecServerHandler::exec`  (lines 151–154)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, JSONRPCErrorError>
```

**Purpose**: Starts a process command inside the attached session. This is the entry point for a client request that wants to run something.

**Data flow**: It receives execution parameters from the client. It first checks that the connection is fully initialized for execution work, then passes the parameters to the session's process runner. The result is an execution response or a JSON-RPC error.

**Call relations**: It uses `require_initialized_for` as the gatekeeper. After that, the actual command-running work is handed off to the process object owned by the session.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::environment_info`  (lines 156–159)

```
fn environment_info(&self) -> Result<EnvironmentInfo, JSONRPCErrorError>
```

**Purpose**: Returns information about the local environment after the connection is initialized. This lets the client learn basic facts about where commands will run.

**Data flow**: It receives no request body beyond the method call. It checks that initialization is complete, then builds and returns a local environment information object.

**Call relations**: It uses `require_initialized_for` to enforce the same startup rule as other method families. The environment details themselves come from `EnvironmentInfo::local`.

*Call graph*: calls 1 internal fn (require_initialized_for); 1 external calls (local).


##### `ExecServerHandler::exec_read`  (lines 161–169)

```
async fn exec_read(
        &self,
        params: ReadParams,
    ) -> Result<ReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads output from a running process in the session. It also rechecks session ownership after reading, because a long read may overlap with a session resume by another connection.

**Data flow**: It receives read parameters, verifies that execution methods are allowed, and asks the session's process runner for output. After the read completes, it confirms the session is still attached before returning the response.

**Call relations**: It is used by flows such as `read_process_until_closed`. It calls `require_initialized_for` before reading and `require_session_attached` afterward, so callers do not receive stale output from a session that has been taken over.

*Call graph*: calls 2 internal fn (require_initialized_for, require_session_attached); called by 1 (read_process_until_closed).


##### `ExecServerHandler::exec_write`  (lines 171–177)

```
async fn exec_write(
        &self,
        params: WriteParams,
    ) -> Result<WriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes input to a running process, such as sending text to a command's standard input. It only works after the session is fully initialized.

**Data flow**: It receives write parameters, checks that execution work is allowed, and forwards the write to the process runner in the attached session. The response reports the outcome or an error.

**Call relations**: Like other process methods, it uses `require_initialized_for` as the guard, then delegates the real process I/O work to the session.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::signal`  (lines 179–185)

```
async fn signal(
        &self,
        params: SignalParams,
    ) -> Result<SignalResponse, JSONRPCErrorError>
```

**Purpose**: Sends a signal to a running process, such as a request to interrupt or stop it. This gives the client controlled influence over processes it started.

**Data flow**: It receives signal parameters, verifies that execution methods are allowed, and passes the request to the session's process runner. The returned response says whether the signal request succeeded.

**Call relations**: It sits in the process-control path with `exec`, `exec_read`, `exec_write`, and `terminate`. It performs the standard initialization check before handing off to the session process layer.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::terminate`  (lines 187–193)

```
async fn terminate(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, JSONRPCErrorError>
```

**Purpose**: Asks the session to terminate a running process. This is the explicit stop operation for process execution.

**Data flow**: It receives termination parameters, checks that the connection is initialized for execution work, and forwards the stop request to the session's process runner. It returns the process layer's termination response.

**Call relations**: It relies on `require_initialized_for` for safety and delegates the actual termination behavior to the session process component.

*Call graph*: calls 1 internal fn (require_initialized_for).


##### `ExecServerHandler::http_request`  (lines 195–234)

```
async fn http_request(
        self: &Arc<Self>,
        request_id: RequestId,
        params: HttpRequestParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Runs an outgoing HTTP request for the client and sends the result back as a JSON-RPC response. If the response body is streamed, it also starts a background task to send later body chunks.

**Data flow**: It receives the original JSON-RPC request ID and HTTP request parameters. It checks that HTTP methods are allowed. If streaming is requested, it reserves the stream request ID so duplicates are rejected. It runs the HTTP request, converts the response header/status data into JSON, sends that response to the client, and, if there is a pending body stream, starts a background streaming task. If anything fails before streaming starts, it releases the reserved stream ID.

**Call relations**: This is the main HTTP path. It uses `require_initialized_for` first, `reserve_http_body_stream` and `release_http_body_stream` to keep stream IDs safe, sends the immediate response through the notification sender, and calls `start_http_body_stream` when a streamed body must continue after the initial reply.

*Call graph*: calls 7 internal fn (new, response, internal_error, release_http_body_stream, require_initialized_for, reserve_http_body_stream, start_http_body_stream); 1 external calls (to_value).


##### `ExecServerHandler::fs_read_file`  (lines 236–242)

```
async fn fs_read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Reads an entire file for the client after the connection is initialized. It is the simple file-read operation.

**Data flow**: It receives file-read parameters, checks that file-system methods are allowed, and forwards the request to the file-system handler. The file-system handler returns the file contents or an error.

**Call relations**: It is one of several thin file-system wrappers in this handler. Its main job is to enforce `require_initialized_for` before delegating to `FileSystemHandler`.

*Call graph*: calls 2 internal fn (read_file, require_initialized_for).


##### `ExecServerHandler::fs_open`  (lines 244–250)

```
async fn fs_open(
        &self,
        params: FsOpenParams,
    ) -> Result<FsOpenResponse, JSONRPCErrorError>
```

**Purpose**: Opens a file for block-by-block reading. This is useful when the client does not want, or cannot safely receive, the whole file at once.

**Data flow**: It receives open-file parameters, verifies that file-system methods are allowed, and asks the file-system handler to open the file. The result typically identifies the opened file resource for later reads and close calls.

**Call relations**: It works with `fs_read_block` and `fs_close` as part of the streamed or chunked file-reading flow. The handler only checks readiness and passes the work to the file-system component.

*Call graph*: calls 2 internal fn (open, require_initialized_for).


##### `ExecServerHandler::fs_read_block`  (lines 252–258)

```
async fn fs_read_block(
        &self,
        params: FsReadBlockParams,
    ) -> Result<FsReadBlockResponse, JSONRPCErrorError>
```

**Purpose**: Reads one block, or chunk, from a file that was opened earlier. This lets large files be read in manageable pieces.

**Data flow**: It receives block-read parameters, checks that file-system methods are allowed, and forwards the request to the file-system handler. The output is the requested chunk of data or an error.

**Call relations**: It normally follows `fs_open` and comes before `fs_close` in a chunked-read sequence. It uses `require_initialized_for` before calling the file-system handler's block reader.

*Call graph*: calls 2 internal fn (read_block, require_initialized_for).


##### `ExecServerHandler::fs_close`  (lines 260–266)

```
async fn fs_close(
        &self,
        params: FsCloseParams,
    ) -> Result<FsCloseResponse, JSONRPCErrorError>
```

**Purpose**: Closes a file resource that was opened for chunked reading. This frees the server-side file handle.

**Data flow**: It receives close parameters, verifies the connection may use file-system methods, and asks the file-system handler to close the referenced open file. It returns a close response or an error.

**Call relations**: It completes the flow started by `fs_open` and used by `fs_read_block`. The handler enforces initialization and then delegates cleanup to the file-system component.

*Call graph*: calls 2 internal fn (close, require_initialized_for).


##### `ExecServerHandler::fs_write_file`  (lines 268–274)

```
async fn fs_write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Writes data to a file for the client. This is the file-system operation for creating or replacing file contents according to the request parameters.

**Data flow**: It receives write-file parameters, checks that file-system access is allowed, and passes the data and path information to the file-system handler. The result reports success or a JSON-RPC error.

**Call relations**: It follows the same pattern as the other file-system methods: `require_initialized_for` acts as the gate, and `FileSystemHandler` performs the actual disk operation.

*Call graph*: calls 2 internal fn (write_file, require_initialized_for).


##### `ExecServerHandler::fs_create_directory`  (lines 276–282)

```
async fn fs_create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Creates a directory on behalf of the client. It is used when the client needs to prepare folders before writing or copying files.

**Data flow**: It receives directory-creation parameters, checks that file-system methods are allowed, and forwards the request to the file-system handler. The response says whether the directory was created or why it failed.

**Call relations**: It is part of the file-system request family. The handler does not create the directory itself; it validates the connection state and hands the request to `FileSystemHandler`.

*Call graph*: calls 2 internal fn (create_directory, require_initialized_for).


##### `ExecServerHandler::fs_get_metadata`  (lines 284–290)

```
async fn fs_get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Gets facts about a file or directory, such as whether it exists and what kind of item it is. This lets the client inspect the file system before acting.

**Data flow**: It receives metadata parameters, confirms file-system methods are allowed, and asks the file-system handler to look up the requested path. It returns the metadata response or an error.

**Call relations**: It uses the shared initialization guard and delegates the real path inspection to the file-system component.

*Call graph*: calls 2 internal fn (get_metadata, require_initialized_for).


##### `ExecServerHandler::fs_canonicalize`  (lines 292–298)

```
async fn fs_canonicalize(
        &self,
        params: FsCanonicalizeParams,
    ) -> Result<FsCanonicalizeResponse, JSONRPCErrorError>
```

**Purpose**: Turns a path into its canonical, or fully resolved, form. In plain terms, it asks the server what the path really points to after shortcuts like `..` or symbolic links are resolved.

**Data flow**: It receives canonicalization parameters, checks that file-system methods may be used, and sends the path to the file-system handler. The output is the resolved path or an error.

**Call relations**: It is another file-system wrapper guarded by `require_initialized_for`. The detailed path-resolution work belongs to `FileSystemHandler`.

*Call graph*: calls 2 internal fn (canonicalize, require_initialized_for).


##### `ExecServerHandler::fs_read_directory`  (lines 300–306)

```
async fn fs_read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Lists the contents of a directory. This lets the client browse files and subfolders on the server side.

**Data flow**: It receives directory-read parameters, checks that file-system access is allowed, and forwards the request to the file-system handler. The response contains directory entries or an error.

**Call relations**: It belongs to the file-system method family. The handler provides the safety check; the file-system handler performs the directory listing.

*Call graph*: calls 2 internal fn (read_directory, require_initialized_for).


##### `ExecServerHandler::fs_remove`  (lines 308–314)

```
async fn fs_remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Removes a file or directory as requested by the client. This is the delete operation for server-side file-system access.

**Data flow**: It receives removal parameters, verifies the connection is fully initialized for file-system work, and asks the file-system handler to remove the target. The result reports success or failure.

**Call relations**: It uses `require_initialized_for` before delegating to `FileSystemHandler`, matching the pattern used by the other file operations.

*Call graph*: calls 2 internal fn (remove, require_initialized_for).


##### `ExecServerHandler::fs_copy`  (lines 316–322)

```
async fn fs_copy(
        &self,
        params: FsCopyParams,
    ) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Copies a file or directory from one path to another. This lets the client duplicate file-system items through the server.

**Data flow**: It receives copy parameters, checks that file-system methods are allowed, and forwards the source and destination information to the file-system handler. The returned response describes the copy result.

**Call relations**: It is the copy member of the file-system wrapper group. Initialization is checked here, while the file-system component performs the actual copy.

*Call graph*: calls 2 internal fn (copy, require_initialized_for).


##### `ExecServerHandler::require_initialized_for`  (lines 324–340)

```
fn require_initialized_for(
        &self,
        method_family: &str,
    ) -> Result<SessionHandle, JSONRPCErrorError>
```

**Purpose**: Enforces the startup rules before a method family is allowed to run. It makes error messages clearer by naming the kind of method, such as `exec`, `http`, or `filesystem`.

**Data flow**: It receives a short method-family label. It checks whether `initialize` has been requested, then checks that a session is still attached, then checks whether the `initialized` notification has arrived. If all checks pass, it returns the current session handle; otherwise it returns a JSON-RPC invalid-request error.

**Call relations**: Nearly every public request method calls this first, including execution, HTTP, environment, and file-system methods. It calls `require_session_attached` in the middle of the check so later code can safely use the returned session.

*Call graph*: calls 2 internal fn (invalid_request, require_session_attached); called by 18 (environment_info, exec, exec_read, exec_write, fs_canonicalize, fs_close, fs_copy, fs_create_directory, fs_get_metadata, fs_open (+8 more)); 2 external calls (load, format!).


##### `ExecServerHandler::require_session_attached`  (lines 342–355)

```
fn require_session_attached(&self) -> Result<SessionHandle, JSONRPCErrorError>
```

**Purpose**: Confirms that this connection still owns an attached session. It prevents a stale connection from continuing to act after the same session has been resumed elsewhere.

**Data flow**: It reads the stored session. If there is none, it returns an error saying initialization is required. If there is a session and it is still attached, it returns the session handle. If another connection has taken over, it returns an error explaining that the session was resumed elsewhere.

**Call relations**: It is called by `initialized`, by `exec_read` after a read, and by `require_initialized_for`. It uses `session` to safely fetch the stored handle.

*Call graph*: calls 2 internal fn (invalid_request, session); called by 3 (exec_read, initialized, require_initialized_for).


##### `ExecServerHandler::session`  (lines 357–362)

```
fn session(&self) -> Option<SessionHandle>
```

**Purpose**: Safely reads the handler's stored session handle. It hides the locking detail from the rest of the file.

**Data flow**: It locks the small shared slot that may contain a session handle, clones the handle if one is present, and returns either that clone or `None`. The stored session itself is not removed or changed.

**Call relations**: It is used by `shutdown`, `is_session_attached`, and `require_session_attached` whenever they need to inspect the current session. The mutex is a lock that stops two threads from reading or changing that slot unsafely at the same time.

*Call graph*: called by 3 (is_session_attached, require_session_attached, shutdown); 1 external calls (lock).


##### `ExecServerHandler::start_http_body_stream`  (lines 364–384)

```
async fn start_http_body_stream(
        self: &Arc<Self>,
        pending_stream: PendingReqwestHttpBodyStream,
    )
```

**Purpose**: Starts sending a streamed HTTP response body in the background. This lets the initial HTTP response return quickly while body chunks continue to arrive later.

**Data flow**: It receives a pending HTTP body stream. If shutdown has already begun, it releases the stream ID and does not start anything. Otherwise it clones the needed handler, notification sender, and shutdown token, then spawns a background task. That task either stops when shutdown is requested or streams the body to the client, and finally releases the stream ID.

**Call relations**: It is called by `http_request` after the initial HTTP response has been sent successfully. It uses `release_http_body_stream` at the end so future streamed requests may reuse the request ID safely.

*Call graph*: calls 1 internal fn (release_http_body_stream); called by 1 (http_request); 6 external calls (clone, clone, is_cancelled, spawn, clone, select!).


##### `ExecServerHandler::release_http_body_stream`  (lines 386–389)

```
async fn release_http_body_stream(&self, request_id: &str)
```

**Purpose**: Marks an HTTP streamed-body request ID as no longer active. This is cleanup for both successful streams and failed setup.

**Data flow**: It receives a request ID, locks the set of active stream IDs, and removes that ID from the set. It does not return a value; the visible effect is that the ID is no longer reserved.

**Call relations**: It is called by `http_request` when an HTTP request fails or cannot be reported, and by `start_http_body_stream` when a background stream ends or is cancelled. It pairs with `reserve_http_body_stream`.

*Call graph*: called by 2 (http_request, start_http_body_stream).


##### `ExecServerHandler::reserve_http_body_stream`  (lines 391–400)

```
async fn reserve_http_body_stream(&self, request_id: &str) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Reserves a request ID for an HTTP streamed body so two active streams cannot use the same ID. This avoids mixing chunks from different responses.

**Data flow**: It receives a request ID, locks the active-stream set, and checks whether the ID is already present. If it is already active, it returns an invalid-parameters error. Otherwise it inserts the ID and returns success.

**Call relations**: It is called by `http_request` before running an HTTP request that asked for `streamResponse`. If the later request fails or the stream finishes, `release_http_body_stream` removes the reservation.

*Call graph*: calls 1 internal fn (invalid_params); called by 1 (http_request); 1 external calls (format!).


### `exec-server/src/rpc.rs`

`io_transport` · `connection setup, request handling, and shutdown`

JSON-RPC is a simple message style where each line of JSON says either “please do this,” “here is the answer,” “something went wrong,” or “just letting you know.” This file turns that raw message stream into safer building blocks for the rest of the server. Without it, every feature would need to hand-write the same bookkeeping: assigning request numbers, matching replies to the right waiting caller, decoding parameters, encoding results, and cleaning up when the connection closes.

There are three main parts. RpcClient is the outgoing caller. It sends requests to the remote side, remembers which request id belongs to which waiting task, and wakes the right task when a response arrives. It also forwards incoming notifications as client events. RpcRouter is the incoming dispatcher. Other code registers a method name with a handler, and the router later finds the right handler and converts JSON parameters into normal Rust values. RpcNotificationSender is a small helper used by server-side code to send responses or notifications back out.

The file also defines standard JSON-RPC-style error builders, such as “invalid params” and “method not found.” A key safety detail is connection shutdown: when the transport closes, all still-waiting calls are told the connection is closed instead of hanging forever.

#### Function details

##### `RpcNotificationSender::new`  (lines 71–73)

```
fn new(outgoing_tx: mpsc::Sender<RpcServerOutboundMessage>) -> Self
```

**Purpose**: Creates a sender object that server code can use to put responses and notifications onto the outgoing RPC message queue.

**Data flow**: It receives a channel sender for outbound messages, stores it inside a new RpcNotificationSender, and returns that wrapper. Nothing is sent yet; it just prepares a convenient handle for later use.

**Call relations**: It is called during connection and session setup, including run_connection and several tests. Later, code such as http_request and send_body_delta uses the returned sender to send actual RPC messages.

*Call graph*: called by 6 (default, active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, run_connection).


##### `RpcNotificationSender::response`  (lines 75–84)

```
async fn response(
        &self,
        request_id: RequestId,
        result: Value,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Sends a successful reply for a specific incoming request. It is used when the server has finished work and needs to answer the caller with a result.

**Data flow**: It takes a request id and a JSON result value, wraps them as an outbound response message, and tries to place that message on the outgoing queue. If the queue is closed, it returns a JSON-RPC internal error explaining that the connection closed.

**Call relations**: http_request calls this after it has a response ready. This function hands the formatted response to the outgoing channel, where the connection-writing code can later encode and transmit it.

*Call graph*: called by 1 (http_request); 1 external calls (send).


##### `RpcNotificationSender::notify`  (lines 86–101)

```
async fn notify(
        &self,
        method: &str,
        params: &P,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Sends a one-way notification from the server to the remote side. A notification is like a status update: no reply is expected.

**Data flow**: It takes a method name and typed parameters, converts the parameters into JSON, wraps them in a notification message, and sends that message to the outgoing queue. If parameter conversion or sending fails, it returns an internal JSON-RPC error.

**Call relations**: send_body_delta calls this when it needs to push progress or body data outward. This function prepares the notification and gives it to the same outbound queue used for responses.

*Call graph*: called by 1 (send_body_delta); 3 external calls (send, Notification, to_value).


##### `RpcRouter::default`  (lines 110–115)

```
fn default() -> Self
```

**Purpose**: Builds an empty RPC router with no request or notification methods registered yet.

**Data flow**: It creates two empty lookup tables: one for request handlers and one for notification handlers. The returned router is ready for routes to be added.

**Call relations**: RpcRouter::new delegates to this function. It is the basic starting point before build_router or similar setup code registers real methods.

*Call graph*: 1 external calls (new).


##### `RpcRouter::new`  (lines 122–124)

```
fn new() -> Self
```

**Purpose**: Creates a new empty router in the most obvious way for callers.

**Data flow**: It asks the default constructor for an empty router and returns it. No routes are registered at this point.

**Call relations**: build_router calls this when setting up the server’s method table. Afterward, registration methods add the actual request and notification handlers.

*Call graph*: called by 1 (build_router); 1 external calls (default).


##### `RpcRouter::request`  (lines 126–160)

```
fn request(&mut self, method: &'static str, handler: F)
```

**Purpose**: Registers a normal request method: a remote caller sends parameters, the handler runs, and the server sends back either a result or an error.

**Data flow**: It receives a method name and a typed handler. Later, when a matching JSON-RPC request arrives, the stored wrapper decodes the JSON parameters, calls the handler with shared server state, converts the handler’s result back into JSON, and produces an outbound response or error.

**Call relations**: No direct caller is shown in the provided graph, but this is the route-registration tool used during router setup. The route it stores is later found through RpcRouter::request_route and run by connection-handling code.

*Call graph*: 1 external calls (new).


##### `RpcRouter::request_with_id`  (lines 162–188)

```
fn request_with_id(&mut self, method: &'static str, handler: F)
```

**Purpose**: Registers a request method where the handler needs to know the request id and may send its own response later. This is useful for long-running or streaming-style work.

**Data flow**: It stores a wrapper for a method name. When a matching request arrives, the wrapper decodes the parameters and calls the handler with shared state, the request id, and the decoded parameters. If the handler succeeds, no automatic response is produced; if it fails, an error response is produced.

**Call relations**: No direct caller is shown in the provided graph, but it is meant for setup code that registers asynchronous request flows. The stored route is later retrieved through RpcRouter::request_route.

*Call graph*: 1 external calls (new).


##### `RpcRouter::notification`  (lines 190–210)

```
fn notification(&mut self, method: &'static str, handler: F)
```

**Purpose**: Registers a one-way notification method. The remote side can send this message to inform the server of something without expecting a reply.

**Data flow**: It receives a method name and handler, stores a wrapper, and later decodes incoming JSON parameters before calling the handler with shared state. It returns success or a plain error string to the caller of the route wrapper, but it does not create a JSON-RPC response.

**Call relations**: No direct caller is shown in the provided graph, but this is used during router setup for notification methods. Later, RpcRouter::notification_route retrieves the stored handler when a notification arrives.

*Call graph*: 1 external calls (new).


##### `RpcRouter::request_route`  (lines 212–214)

```
fn request_route(&self, method: &str) -> Option<&RequestRoute<S>>
```

**Purpose**: Looks up the registered handler for a request method name.

**Data flow**: It receives a method name as text, searches the router’s request table, and returns the matching route if one exists. It does not run the route itself.

**Call relations**: Connection-handling code uses this kind of lookup when a request arrives. If a route is found, that route can decode parameters and call the real handler; if not, the caller can report “method not found.”


##### `RpcRouter::notification_route`  (lines 216–218)

```
fn notification_route(&self, method: &str) -> Option<&NotificationRoute<S>>
```

**Purpose**: Looks up the registered handler for a notification method name.

**Data flow**: It receives a method name, checks the notification route table, and returns the matching handler wrapper if present. No message is sent and no handler is run inside this function.

**Call relations**: It fits the incoming-notification path: routing code asks for a handler by name, then runs it if present or treats the notification as unknown if absent.


##### `RpcClient::new`  (lines 235–293)

```
fn new(connection: JsonRpcConnection) -> (Self, mpsc::Receiver<RpcClientEvent>)
```

**Purpose**: Builds an RPC client around an already-open JSON-RPC connection. It also starts a background reader task that listens for replies, notifications, and disconnects.

**Data flow**: It takes a JsonRpcConnection, pulls out its incoming and outgoing channels, creates a table for pending calls, creates an event channel for notifications and disconnect notices, and spawns a reader task. The result is a ready-to-use RpcClient plus a receiver where callers can listen for client events.

**Call relations**: connect and the out-of-order-response test call this after creating a transport. The background task it starts calls handle_server_message for each incoming message, calls drain_pending when the connection ends, and terminates the transport on shutdown.

*Call graph*: calls 2 internal fn (drain_pending, handle_server_message); called by 2 (connect, rpc_client_matches_out_of_order_responses_by_request_id); 7 external calls (clone, new, new, new, new, channel, spawn).


##### `RpcClient::notify`  (lines 295–313)

```
async fn notify(
        &self,
        method: &str,
        params: &P,
    ) -> Result<(), serde_json::Error>
```

**Purpose**: Sends a one-way notification from this client to the remote server. It is for messages that do not need an answer.

**Data flow**: It takes a method name and typed parameters, converts the parameters to JSON, builds a JSON-RPC notification, and sends it on the write channel. If the channel is closed, it returns a JSON serialization-style error that represents a broken pipe.

**Call relations**: This is called by code that wants to inform the remote side without waiting. It hands the message to the connection writer through the client’s outgoing channel.

*Call graph*: 3 external calls (send, Notification, to_value).


##### `RpcClient::is_disconnected`  (lines 315–317)

```
fn is_disconnected(&self) -> bool
```

**Purpose**: Reports whether the underlying connection has already been marked as disconnected.

**Data flow**: It reads the latest boolean value from a watch channel, which is a shared value that changes over time, and returns that value. It does not change any state.

**Call relations**: Callers can use this as a quick health check before or after trying RPC work. RpcClient::call also checks the same disconnect signal internally so new calls do not wait forever after shutdown.

*Call graph*: 1 external calls (borrow).


##### `RpcClient::call`  (lines 319–372)

```
async fn call(&self, method: &str, params: &P) -> Result<T, RpcCallError>
```

**Purpose**: Sends a request to the remote side and waits for the matching response. It is the main “ask the server to do something and give me the answer” function.

**Data flow**: It creates a fresh request id, registers a one-time reply channel in the pending table, converts the parameters to JSON, sends the request, and then waits. When the reader task receives the response with the same id, this function gets the JSON result and converts it into the caller’s expected type. If sending, decoding, the server, or the connection fails, it returns a clear RpcCallError.

**Call relations**: Callers use this to make outbound JSON-RPC requests. The response path depends on RpcClient::new’s background reader, which calls handle_server_message to match incoming responses to the pending entry created here.

*Call graph*: 9 external calls (fetch_add, send, Request, Integer, Json, borrow, channel, from_value, to_value).


##### `RpcClient::pending_request_count`  (lines 375–377)

```
async fn pending_request_count(&self) -> usize
```

**Purpose**: Returns how many calls are currently waiting for responses. This exists only for tests.

**Data flow**: It locks the pending-request table, counts the entries, and returns the number. It does not remove or alter any pending calls.

**Call relations**: The out-of-order-response test calls this after both replies arrive to confirm that the client cleaned up its waiting-call table correctly.


##### `RpcClient::drop`  (lines 381–387)

```
fn drop(&mut self)
```

**Purpose**: Cleans up background transport work when the RpcClient is destroyed. This prevents leftover tasks from continuing after the client is no longer used.

**Data flow**: When Rust drops the client, this method tells the transport to terminate, aborts the transport tasks, and aborts the reader task. It does not return a value.

**Call relations**: Rust calls this automatically at the end of the client’s lifetime. It is the final cleanup partner to RpcClient::new, which created and stored those tasks.

*Call graph*: calls 1 internal fn (terminate); 1 external calls (abort).


##### `encode_server_message`  (lines 390–410)

```
fn encode_server_message(
    message: RpcServerOutboundMessage,
) -> Result<JSONRPCMessage, serde_json::Error>
```

**Purpose**: Converts the server’s internal outbound message type into the shared JSON-RPC message type that the connection layer knows how to send.

**Data flow**: It receives an outbound response, error, or notification. It wraps the same information in the protocol’s JSONRPCMessage enum and returns it.

**Call relations**: run_connection calls this before writing server-side outbound messages to the connection. It is the bridge between server-facing message choices and wire-facing JSON-RPC messages.

*Call graph*: called by 1 (run_connection); 3 external calls (Error, Notification, Response).


##### `invalid_request`  (lines 412–418)

```
fn invalid_request(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC error for a request that is not valid as a request at all.

**Data flow**: It receives a human-readable message and returns an error object with JSON-RPC code -32600 and no extra data.

**Call relations**: Many validation and setup paths call this when they need to reject malformed or inappropriate requests, including file-system mapping, command spawning, process reading, and initialization.

*Call graph*: called by 12 (map_fs_error, sandbox_cwd, spawn_command, exec_read, start_process, map_fs_error, validate_file_read_handle_id, initialize, require_initialized_for, require_session_attached (+2 more)).


##### `method_not_found`  (lines 420–426)

```
fn method_not_found(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC error for an unknown method name.

**Data flow**: It receives explanatory text and returns an error object with JSON-RPC code -32601.

**Call relations**: run_connection calls this when an incoming request names a method that the router does not know about.

*Call graph*: called by 1 (run_connection).


##### `invalid_params`  (lines 428–434)

```
fn invalid_params(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC error for parameters that are missing, badly shaped, or otherwise unacceptable.

**Data flow**: It receives a message explaining the parameter problem and returns an error object with JSON-RPC code -32602.

**Call relations**: Code such as run, start_process validation, and reserve_http_body_stream calls this when the method exists but the supplied inputs are wrong.

*Call graph*: called by 3 (run, start_process_rejects_non_native_cwd_before_launch, reserve_http_body_stream).


##### `not_found`  (lines 436–442)

```
fn not_found(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds an error for a requested resource that could not be found, such as a missing file or handle.

**Data flow**: It receives a message and returns an error object with code -32004, a project-specific server error code.

**Call relations**: File-system error mapping code calls this when an operation fails because the target does not exist.

*Call graph*: called by 2 (map_fs_error, map_fs_error).


##### `internal_error`  (lines 444–450)

```
fn internal_error(message: String) -> JSONRPCErrorError
```

**Purpose**: Builds a standard JSON-RPC error for unexpected server-side failures. It is the “something went wrong inside” error.

**Data flow**: It receives a message and returns an error object with JSON-RPC code -32603.

**Call relations**: Many parts of the server call this when converting lower-level failures into RPC errors, including command running, response checking, I/O errors, JSON errors, and outbound send failures in this file.

*Call graph*: called by 9 (run, map_fs_error, unexpected_response, io_error, json_error, run_command, start_process, map_fs_error, http_request).


##### `decode_request_params`  (lines 452–457)

```
fn decode_request_params(params: Option<Value>) -> Result<P, JSONRPCErrorError>
```

**Purpose**: Decodes the JSON parameters of an incoming request into the Rust type expected by that request’s handler.

**Data flow**: It receives optional JSON parameters, passes them to the shared decode_params helper, and turns any decoding failure into a JSON-RPC “invalid params” error.

**Call relations**: Routes registered by RpcRouter::request and RpcRouter::request_with_id use this before calling their handlers. It delegates the actual JSON conversion rules to decode_params.

*Call graph*: calls 1 internal fn (decode_params).


##### `decode_notification_params`  (lines 459–464)

```
fn decode_notification_params(params: Option<Value>) -> Result<P, String>
```

**Purpose**: Decodes the JSON parameters of an incoming notification into the Rust type expected by its handler.

**Data flow**: It receives optional JSON parameters, calls decode_params, and turns any decoding error into a plain string. Notifications do not produce normal JSON-RPC error responses, so a string is enough for the route caller.

**Call relations**: Routes registered by RpcRouter::notification use this before running notification handlers. It shares the same decoding behavior as request parameters through decode_params.

*Call graph*: calls 1 internal fn (decode_params).


##### `decode_params`  (lines 466–481)

```
fn decode_params(params: Option<Value>) -> Result<P, serde_json::Error>
```

**Purpose**: Performs the common JSON-to-Rust parameter conversion used by both requests and notifications.

**Data flow**: It treats missing parameters as JSON null, then tries to deserialize that JSON into the requested Rust type. If the caller sent an empty object and normal decoding failed, it also tries decoding null; this makes empty parameter objects work for handlers that expect no meaningful input.

**Call relations**: decode_request_params and decode_notification_params call this so both message kinds follow the same parameter rules.

*Call graph*: called by 2 (decode_notification_params, decode_request_params); 2 external calls (matches!, from_value).


##### `handle_server_message`  (lines 483–513)

```
async fn handle_server_message(
    pending: &Mutex<HashMap<RequestId, PendingRequest>>,
    event_tx: &mpsc::Sender<RpcClientEvent>,
    message: JSONRPCMessage,
) -> Result<(), String>
```

**Purpose**: Processes one incoming message seen by RpcClient’s background reader. It either completes a waiting call, forwards a notification, or rejects an unexpected incoming request.

**Data flow**: It receives the pending-call table, the event sender, and one JSON-RPC message. Responses and errors remove the matching pending entry and send the result to the waiting caller. Notifications are sent as client events. An incoming request from the remote server is treated as an error because this client side does not expect server-initiated requests.

**Call relations**: The reader task created by RpcClient::new calls this for each incoming message. Its output wakes RpcClient::call waiters or feeds the event receiver returned by RpcClient::new.

*Call graph*: called by 1 (new); 4 external calls (send, Server, Notification, format!).


##### `drain_pending`  (lines 515–526)

```
async fn drain_pending(pending: &Mutex<HashMap<RequestId, PendingRequest>>)
```

**Purpose**: Fails every call that is still waiting when the connection closes. This prevents callers from hanging forever.

**Data flow**: It locks the pending-call table, removes all waiting reply senders, then sends each one a “closed” error. The pending table ends empty.

**Call relations**: The reader task created by RpcClient::new calls this after it detects disconnection or stops reading. It completes the shutdown path for any RpcClient::call still awaiting a response.

*Call graph*: called by 1 (new).


##### `tests::read_jsonrpc_line`  (lines 543–564)

```
async fn read_jsonrpc_line(lines: &mut tokio::io::Lines<BufReader<R>>) -> JSONRPCMessage
```

**Purpose**: Test helper that reads one newline-terminated JSON-RPC message from a simulated connection.

**Data flow**: It waits up to one second for the next line, reports a test failure if reading times out or fails, parses the line as a JSONRPCMessage, and returns that message.

**Call relations**: The out-of-order-response test uses this helper to inspect the requests sent by RpcClient. It sits on the fake server side of the test connection.

*Call graph*: 4 external calls (from_secs, next_line, panic!, timeout).


##### `tests::write_jsonrpc_line`  (lines 566–577)

```
async fn write_jsonrpc_line(writer: &mut W, message: JSONRPCMessage)
```

**Purpose**: Test helper that writes one JSON-RPC message as a line of JSON to a simulated connection.

**Data flow**: It converts a JSONRPCMessage into text, appends a newline, and writes it to the provided async writer. If encoding or writing fails, the test fails immediately.

**Call relations**: The out-of-order-response test uses this helper to send fake server responses back to RpcClient.

*Call graph*: 4 external calls (write_all, format!, panic!, to_string).


##### `tests::rpc_client_matches_out_of_order_responses_by_request_id`  (lines 580–643)

```
async fn rpc_client_matches_out_of_order_responses_by_request_id()
```

**Purpose**: Checks that RpcClient matches responses by request id, not by arrival order. This is important because fast requests may answer before slow ones.

**Data flow**: The test creates an in-memory client/server connection, sends two client calls named “slow” and “fast,” has the fake server reply to the fast one first, and then verifies each caller receives its own correct result. It also confirms the pending-call table is empty afterward.

**Call relations**: This test uses RpcClient::new to create the client, tests::read_jsonrpc_line to read outgoing requests, tests::write_jsonrpc_line to send replies, and RpcClient::pending_request_count to confirm cleanup.

*Call graph*: calls 2 internal fn (from_stdio, new); 10 external calls (new, Response, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, panic!, json!, duplex, join!, spawn).


### `exec-server/src/server/file_system_handler.rs`

`io_transport` · `request handling and shutdown`

The exec server needs to let a client work with files, but it cannot just expose raw disk access. This file sits between the outside request format and the local file system. It checks small but important things, applies sandbox information when present, calls the lower-level file-system layer, and converts results or errors into JSON-RPC responses. JSON-RPC is a common request-and-response format where failures must be reported in a standard shape.

The main type, `FileSystemHandler`, owns two helpers. One talks to the real local file system. The other keeps track of open read handles, which are like claim tickets for reading large files in chunks instead of all at once. For simple reads and writes, the handler reads or writes the whole file. File contents are sent as Base64 text, which is a way to safely carry raw bytes inside JSON strings.

A key detail is error translation. A missing file becomes a “not found” response. Bad input or permission problems become “invalid request.” Unexpected disk problems become internal errors. Without this file, callers would either have no unified way to use the server’s file features, or they would receive low-level operating-system errors that do not fit the server protocol.

#### Function details

##### `FileSystemHandler::new`  (lines 51–56)

```
fn new(runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Creates a file-system request handler ready to serve client file operations. It connects the handler to the server’s runtime paths and starts with an empty set of open file-read handles.

**Data flow**: It receives runtime path information, such as where helper programs may live. It uses that to build a local file-system helper, creates a default read-handle manager, and returns a new `FileSystemHandler` containing both.

**Call relations**: This is called when the server or tests need a handler instance. The test in this file uses it directly, and the broader server setup also creates one before routing file-system RPC methods to it.

*Call graph*: calls 1 internal fn (with_runtime_paths); called by 2 (no_platform_sandbox_policies_do_not_require_configured_sandbox_helper, new); 1 external calls (default).


##### `FileSystemHandler::shutdown`  (lines 58–60)

```
async fn shutdown(&self)
```

**Purpose**: Closes every file that is still open for chunked reading. This prevents leftover file handles from staying alive when the server is stopping.

**Data flow**: It reads the handler’s current read-handle manager, asks it to close all tracked file reads, waits for that cleanup to finish, and returns nothing.

**Call relations**: The server shutdown flow calls this when the file-system handler is no longer needed. It hands cleanup to `close_all`, which does the actual closing of stored read handles.

*Call graph*: calls 1 internal fn (close_all); called by 1 (shutdown).


##### `FileSystemHandler::open`  (lines 62–78)

```
async fn open(
        &self,
        params: FsOpenParams,
    ) -> Result<FsOpenResponse, JSONRPCErrorError>
```

**Purpose**: Opens a file for later chunk-by-chunk reading. This is useful for large files because the client can request blocks instead of loading the whole file at once.

**Data flow**: It receives an open-file request containing a path, a client-chosen handle ID, and optional sandbox information. It first checks that the handle ID is not too long, then asks the local file system to open the path for reading, then stores that open file under the handle ID. It returns the handle ID if all of that succeeds, or a JSON-RPC error if anything fails.

**Call relations**: The `fs_open` RPC route calls this when a client starts a chunked read. It relies on `validate_file_read_handle_id` for input safety, `open_file_for_read` for disk access, and the read-handle manager’s `open` method to remember the open file.

*Call graph*: calls 3 internal fn (open, open_file_for_read, validate_file_read_handle_id); called by 1 (fs_open).


##### `FileSystemHandler::read_block`  (lines 80–94)

```
async fn read_block(
        &self,
        params: FsReadBlockParams,
    ) -> Result<FsReadBlockResponse, JSONRPCErrorError>
```

**Purpose**: Reads one block of bytes from a file that was previously opened with a handle. This lets clients page through a file in controlled pieces.

**Data flow**: It receives a handle ID, an offset, and a requested length. It checks the handle ID, asks the read-handle manager for that slice of the file, then returns the bytes and a flag saying whether the end of the file has been reached.

**Call relations**: The `fs_read_block` RPC route calls this after a client has opened a file. It does not touch the file system directly; it delegates to the read-handle manager, which knows which open file belongs to the handle.

*Call graph*: calls 2 internal fn (read_block, validate_file_read_handle_id); called by 1 (fs_read_block).


##### `FileSystemHandler::close`  (lines 96–103)

```
async fn close(
        &self,
        params: FsCloseParams,
    ) -> Result<FsCloseResponse, JSONRPCErrorError>
```

**Purpose**: Closes a previously opened chunked-read handle. This releases the server-side resource tied to that handle.

**Data flow**: It receives a handle ID, checks that the ID is within the allowed size, tells the read-handle manager to close and forget that handle, and returns an empty success response.

**Call relations**: The `fs_close` RPC route calls this when the client is finished reading by handle. It uses `validate_file_read_handle_id` before passing the handle to the read-handle manager’s `close` method.

*Call graph*: calls 2 internal fn (close, validate_file_read_handle_id); called by 1 (fs_close).


##### `FileSystemHandler::read_file`  (lines 105–117)

```
async fn read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, JSONRPCErrorError>
```

**Purpose**: Reads an entire file in one request and returns its contents as Base64 text. This is the simple path for files small enough to fetch all at once.

**Data flow**: It receives a path and optional sandbox information. It asks the local file system to read the file’s bytes, converts those bytes into Base64 so they can travel safely in JSON, and returns that encoded string.

**Call relations**: The `fs_read_file` RPC route calls this for whole-file reads. The actual disk read is done by the local file-system helper, and any disk error is converted into a JSON-RPC error by `map_fs_error`.

*Call graph*: calls 1 internal fn (read_file); called by 1 (fs_read_file).


##### `FileSystemHandler::write_file`  (lines 119–133)

```
async fn write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, JSONRPCErrorError>
```

**Purpose**: Writes a whole file from Base64-encoded content supplied by the client. It rejects the request early if the provided data is not valid Base64.

**Data flow**: It receives a path, Base64 text, and optional sandbox information. It decodes the Base64 into raw bytes, reports an invalid request if decoding fails, then asks the local file system to write those bytes to the requested path. On success, it returns an empty response.

**Call relations**: The `fs_write_file` RPC route calls this when a client wants to replace or create a file. It does the protocol-specific decoding itself, then hands the real writing to the local file-system helper.

*Call graph*: calls 1 internal fn (write_file); called by 1 (fs_write_file).


##### `FileSystemHandler::create_directory`  (lines 135–149)

```
async fn create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Creates a directory for the client. By default it creates parent directories too, like `mkdir -p` on the command line.

**Data flow**: It receives a path, an optional recursive setting, and optional sandbox information. If the request does not say otherwise, it treats recursive creation as enabled. It passes the path and option to the local file system and returns an empty success response.

**Call relations**: The `fs_create_directory` RPC route calls this for directory creation. The handler chooses the default behavior, while the local file-system helper performs the actual disk operation.

*Call graph*: calls 1 internal fn (create_directory); called by 1 (fs_create_directory).


##### `FileSystemHandler::get_metadata`  (lines 151–168)

```
async fn get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, JSONRPCErrorError>
```

**Purpose**: Returns basic facts about a path, such as whether it is a file, directory, or symbolic link, plus size and timestamps. A symbolic link is a path that points to another path.

**Data flow**: It receives a path and optional sandbox information. It asks the local file system for metadata, then copies the relevant fields into the protocol response: type flags, byte size, creation time, and modification time.

**Call relations**: The `fs_get_metadata` RPC route calls this when a client needs information before deciding what to do with a path. The handler translates the local metadata shape into the response shape expected by the protocol.

*Call graph*: calls 1 internal fn (get_metadata); called by 1 (fs_get_metadata).


##### `FileSystemHandler::canonicalize`  (lines 170–180)

```
async fn canonicalize(
        &self,
        params: FsCanonicalizeParams,
    ) -> Result<FsCanonicalizeResponse, JSONRPCErrorError>
```

**Purpose**: Turns a path into its canonical, or fully resolved, form. This usually means resolving relative pieces and links so the client can see the actual path the system uses.

**Data flow**: It receives a path and optional sandbox information. It asks the local file system to canonicalize the path, then returns the resolved path in the protocol response.

**Call relations**: The `fs_canonicalize` RPC route calls this for path resolution. The handler delegates the path rules to the local file-system helper and maps any failure into a JSON-RPC error.

*Call graph*: calls 1 internal fn (canonicalize); called by 1 (fs_canonicalize).


##### `FileSystemHandler::read_directory`  (lines 182–199)

```
async fn read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, JSONRPCErrorError>
```

**Purpose**: Lists the immediate contents of a directory. For each entry, it returns the name and whether it is a file or directory.

**Data flow**: It receives a directory path and optional sandbox information. It asks the local file system for directory entries, converts each entry into the protocol’s entry format, collects them into a list, and returns that list.

**Call relations**: The `fs_read_directory` RPC route calls this when a client wants to browse a folder. The local file-system helper reads the disk, while this function reshapes the results for the RPC response.

*Call graph*: calls 1 internal fn (read_directory); called by 1 (fs_read_directory).


##### `FileSystemHandler::remove`  (lines 201–216)

```
async fn remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, JSONRPCErrorError>
```

**Purpose**: Deletes a file or directory. By default it allows recursive deletion and force-style behavior, meaning it is tolerant in common cleanup cases unless the request says otherwise.

**Data flow**: It receives a path, optional recursive and force settings, and optional sandbox information. Missing options default to `true`. It passes those choices to the local file system, then returns an empty success response if deletion succeeds.

**Call relations**: The `fs_remove` RPC route calls this for deletion requests. The handler chooses defaults and builds the remove options; the lower-level file-system helper performs the actual removal.

*Call graph*: calls 1 internal fn (remove); called by 1 (fs_remove).


##### `FileSystemHandler::copy`  (lines 218–234)

```
async fn copy(
        &self,
        params: FsCopyParams,
    ) -> Result<FsCopyResponse, JSONRPCErrorError>
```

**Purpose**: Copies a file or directory from one path to another. It can optionally copy directories recursively depending on the request.

**Data flow**: It receives a source path, destination path, recursive option, and optional sandbox information. It packages the recursive setting into copy options, asks the local file system to perform the copy, and returns an empty success response.

**Call relations**: The `fs_copy` RPC route calls this when a client requests a copy. This function is the protocol-facing wrapper, while the local file-system helper does the disk work.

*Call graph*: calls 1 internal fn (copy); called by 1 (fs_copy).


##### `validate_file_read_handle_id`  (lines 237–244)

```
fn validate_file_read_handle_id(handle_id: &str) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Checks that a file-read handle ID is not too large. This protects the server from accepting unnecessarily large client-provided identifiers.

**Data flow**: It receives a handle ID string. If the string is longer than the allowed byte limit, it creates an invalid-request JSON-RPC error. Otherwise it returns success and changes nothing.

**Call relations**: The chunked-read operations `open`, `read_block`, and `close` call this before using a handle ID. It acts like a small gatekeeper before the request reaches the read-handle manager.

*Call graph*: calls 1 internal fn (invalid_request); called by 3 (close, open, read_block); 1 external calls (format!).


##### `map_fs_error`  (lines 246–254)

```
fn map_fs_error(err: io::Error) -> JSONRPCErrorError
```

**Purpose**: Converts ordinary file-system errors into the error categories used by the server’s JSON-RPC protocol. This keeps client-facing errors consistent and understandable.

**Data flow**: It receives an operating-system I/O error. It looks at the error kind: missing paths become “not found,” bad input or permission failures become “invalid request,” and everything else becomes an internal server error. It returns the protocol-formatted error.

**Call relations**: Most handler methods use this after calling the local file-system helper or read-handle manager. It is the shared translator between low-level disk failures and client-visible RPC failures.

*Call graph*: calls 3 internal fn (internal_error, invalid_request, not_found); 2 external calls (kind, to_string).


##### `tests::no_platform_sandbox_policies_do_not_require_configured_sandbox_helper`  (lines 269–331)

```
async fn no_platform_sandbox_policies_do_not_require_configured_sandbox_helper()
```

**Purpose**: Checks that certain sandbox policies still allow basic file operations even when no platform sandbox helper executable is configured. This protects a startup/use case where sandbox support is intentionally absent but not needed for those policies.

**Data flow**: It creates a temporary directory and a handler with no Linux sandbox helper configured. For two sandbox policies, it writes a file, canonicalizes its path, reads it back, and compares the results with what the normal file system reports. The test passes only if all operations work and the read content matches what was written.

**Call relations**: The test calls `FileSystemHandler::new` to build the handler, then exercises `write_file`, `canonicalize`, and `read_file` as a client would. It confirms those handler methods cooperate correctly with sandbox context setup in this no-helper scenario.

*Call graph*: calls 3 internal fn (new, new, from_path); 3 external calls (assert_eq!, current_exe, tempdir).


### `exec-server/src/server/registry.rs`

`orchestration` · `connection setup`

This file is like the front desk directory for the exec server. Clients send named RPC messages, where RPC means “remote procedure call” — a structured way to ask another process to do something. The router built here connects each public protocol method name, such as “run a command,” “read a file,” or “send an HTTP request,” to the matching method on `ExecServerHandler`, which contains the real work.

The file does not itself execute commands or touch files. Instead, it creates a `RpcRouter`, then registers every supported operation. Some entries are notifications, meaning the client says something without expecting a direct reply, such as `initialized`. Most entries are requests, meaning the client sends parameters and expects a result. Each registration also names the expected parameter type, so incoming JSON can be turned into the right Rust data before reaching the handler.

One special route, the HTTP request route, keeps the request ID and passes it along. That matters because HTTP-style work may need to connect later responses or streaming data back to the original request. Overall, this file is the server’s switchboard: it receives a method name and plugs it into the correct handler function.

#### Function details

##### `build_router`  (lines 44–163)

```
fn build_router() -> RpcRouter<ExecServerHandler>
```

**Purpose**: Builds and returns the RPC router used by the exec server. It registers every command the server understands and points each one at the matching `ExecServerHandler` method.

**Data flow**: It starts with no inputs and creates a fresh router. It then adds method-name-to-handler links for initialization, command execution, process input and output, signals, termination, environment info, HTTP requests, and file-system actions such as reading, writing, opening, closing, copying, and removing files. The result is a completed `RpcRouter<ExecServerHandler>` that can turn incoming client messages into calls on the shared server handler.

**Call relations**: `run_connection` calls this when setting up a client connection, so the connection knows how to dispatch incoming messages. Inside, this function calls `new` to create the empty router, then fills it with routes that hand work off to `ExecServerHandler` methods when matching RPC messages arrive.

*Call graph*: calls 1 internal fn (new); called by 1 (run_connection).


### `exec-server/src/server/process_handler.rs`

`orchestration` · `request handling and shutdown`

This file is a thin but important bridge between the RPC server and the lower-level process runner. RPC means “remote procedure call”: a client asks the server to perform named actions, such as starting a process or reading from it. The ProcessHandler turns those server requests into calls on LocalProcess, which does the real work of creating and controlling operating-system processes.

Think of it like a reception desk. The client does not walk into the machine room and touch the running process directly. Instead, it asks the receptionist for “start this command,” “give me output,” “send this input,” or “stop it.” ProcessHandler is that receptionist. It keeps a LocalProcess inside it, forwards each request to the matching LocalProcess method, and returns either a response object or a JSON-RPC error object if something goes wrong.

It also carries a notification sender. That is the path used to send updates back to the client, such as process events. The handler can be cloned, so different parts of the server can share access to the same process-control layer without rebuilding it. Without this file, the server would have to call LocalProcess directly from many places, making the boundary between network requests and process control messier and harder to change.

#### Function details

##### `ProcessHandler::new`  (lines 22–26)

```
fn new(notifications: RpcNotificationSender) -> Self
```

**Purpose**: Creates a new ProcessHandler with a notification channel already connected. This is used when the server attaches this process-control layer to the rest of the RPC system.

**Data flow**: It receives a RpcNotificationSender, which is the route for sending process updates back to clients. It passes that sender into LocalProcess::new, stores the resulting LocalProcess inside a new ProcessHandler, and returns that handler ready for use.

**Call relations**: During server attachment, attach calls this function to build the handler. This function immediately delegates the real setup to LocalProcess::new, so the handler starts life with its inner process runner prepared to send notifications.

*Call graph*: calls 1 internal fn (new); called by 1 (attach).


##### `ProcessHandler::shutdown`  (lines 28–30)

```
async fn shutdown(&self)
```

**Purpose**: Asks the underlying process runner to shut down cleanly. This is used when the server is stopping or no longer wants to keep process resources alive.

**Data flow**: It takes the existing ProcessHandler, reads its stored LocalProcess, and awaits that LocalProcess shutdown work. It returns nothing directly, but the important result is that the inner process layer gets a chance to clean up running work and resources.

**Call relations**: When shutdown is requested on the handler, it does not implement cleanup itself. It hands the request straight to LocalProcess::shutdown, keeping this file as the server-facing doorway rather than the place where process cleanup details live.

*Call graph*: calls 1 internal fn (shutdown).


##### `ProcessHandler::set_notification_sender`  (lines 32–34)

```
fn set_notification_sender(&self, notifications: Option<RpcNotificationSender>)
```

**Purpose**: Updates where process notifications should be sent, or turns them off. This matters when a client connection changes and the server needs process events to go to a new place.

**Data flow**: It receives either a new RpcNotificationSender or None. It passes that option to the stored LocalProcess, which updates its own notification route. The function does not return a value; the change is stored inside the process layer.

**Call relations**: This method is the handler-level way to retarget notifications. It forwards the request to LocalProcess::set_notification_sender so the lower-level process code remains responsible for actually remembering and using the sender.

*Call graph*: calls 1 internal fn (set_notification_sender).


##### `ProcessHandler::exec`  (lines 36–38)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, JSONRPCErrorError>
```

**Purpose**: Starts a new process using the command details supplied by the client. It returns the server’s response for that start request, or a JSON-RPC error if the request cannot be fulfilled.

**Data flow**: It receives ExecParams, which describe what should be run. It passes those parameters to the stored LocalProcess and awaits the result. The output is either an ExecResponse describing the started process or a JSONRPCErrorError describing the failure in a form the RPC client understands.

**Call relations**: When a higher server layer wants to perform an exec request, this method is the gateway. It forwards the work to LocalProcess::exec, which is where the actual process-starting behavior belongs.

*Call graph*: calls 1 internal fn (exec).


##### `ProcessHandler::exec_read`  (lines 40–45)

```
async fn exec_read(
        &self,
        params: ReadParams,
    ) -> Result<ReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads output from a process that was previously started. This lets the client collect data produced by the running command.

**Data flow**: It receives ReadParams, such as which process or stream should be read. It sends those parameters to LocalProcess::exec_read and waits. It returns either a ReadResponse containing the read data or a JSON-RPC error if the read cannot happen.

**Call relations**: This method fits into the flow after a process has been launched. The handler receives the read-style request and hands it to LocalProcess::exec_read, keeping the details of buffering and process output in the lower-level process component.

*Call graph*: calls 1 internal fn (exec_read).


##### `ProcessHandler::exec_write`  (lines 47–52)

```
async fn exec_write(
        &self,
        params: WriteParams,
    ) -> Result<WriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes input to a running process. This is how a client can feed text or bytes into a command that is waiting for input.

**Data flow**: It receives WriteParams containing the target process and the data to send. It forwards those details to LocalProcess::exec_write and awaits the result. It returns either a WriteResponse confirming the write or a JSON-RPC error if the input cannot be delivered.

**Call relations**: In the larger request flow, this method is used when the server is asked to send data into an existing process. It delegates the actual input delivery to LocalProcess::exec_write.

*Call graph*: calls 1 internal fn (exec_write).


##### `ProcessHandler::signal`  (lines 54–59)

```
async fn signal(
        &self,
        params: SignalParams,
    ) -> Result<SignalResponse, JSONRPCErrorError>
```

**Purpose**: Sends an operating-system signal to a running process, such as an interrupt request. Signals are a standard way to ask a process to stop, pause, or react without writing normal input to it.

**Data flow**: It receives SignalParams describing the target process and the signal to send. It passes those parameters to LocalProcess::signal_process and waits for completion. It returns either a SignalResponse or a JSON-RPC error if the signal could not be sent.

**Call relations**: When the server receives a request to signal a process, this method provides the server-facing entry point. It hands the action to LocalProcess::signal_process, where the operating-system-specific process control is handled.

*Call graph*: calls 1 internal fn (signal_process).


##### `ProcessHandler::terminate`  (lines 61–66)

```
async fn terminate(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, JSONRPCErrorError>
```

**Purpose**: Requests that a running process be terminated. This is the stronger, explicit stop path for a process the server is controlling.

**Data flow**: It receives TerminateParams identifying what should be stopped. It forwards those parameters to LocalProcess::terminate_process and awaits the result. It returns either a TerminateResponse confirming the outcome or a JSON-RPC error if termination fails.

**Call relations**: This method is used when the server needs to end a process through the normal request path. The handler does not kill the process itself; it passes the request to LocalProcess::terminate_process so the process layer can do the actual termination work.

*Call graph*: calls 1 internal fn (terminate_process).


### MCP request and client routing
These files implement MCP-side dispatch and tool execution along with the rmcp client adapters that receive notifications and serialize elicitation flows back to the UI.

### `mcp-server/src/message_processor.rs`

`orchestration` · `request handling`

An MCP server speaks JSON-RPC, a simple request-and-response message format. This file turns those protocol messages into Codex actions. Without it, the server could receive bytes from a client, but it would not know how to answer an initialize request, list available tools, start a Codex session, continue an existing session, or cancel running work.

The central type is MessageProcessor. Think of it like the front desk of a workshop. The client comes to the desk with a form. The processor checks what kind of form it is, sends simple answers itself when it can, and sends real Codex jobs to the right worker when needed.

At startup, MessageProcessor::new builds the pieces it needs: an outgoing message sender, authentication, user-instruction loading, and a ThreadManager, which is the object that creates and finds Codex conversation threads. During normal use, process_request routes client requests to specific handlers. Most resource and prompt methods are currently only logged. The important supported tools are "codex", which starts a new Codex session, and "codex-reply", which sends another prompt to an existing session.

Long-running Codex work is spawned into background tasks so the message processor can keep reading new messages. The file also tracks which client request belongs to which Codex thread, so a later cancellation notification can interrupt the right running session.

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

**Purpose**: Builds a MessageProcessor with all the services it needs to talk to Codex and send replies back to the client. This is used when the MCP server is being set up.

**Data flow**: It receives the outgoing-message channel, command-path information, configuration, environment service, optional state database, and installation id. It uses the configuration to create authentication, user-instruction loading, persistent thread storage, and a ThreadManager. It returns a MessageProcessor with no completed MCP initialization yet and an empty table for tracking running requests.

**Call relations**: This is the setup step before any client messages can be processed. It prepares the ThreadManager that later handlers use when starting a new Codex tool session or finding an existing one for a reply or cancellation.

*Call graph*: calls 3 internal fn (new, new, shared_from_config); 5 external calls (new, new, new, thread_store_from_config, empty_extension_registry).


##### `MessageProcessor::process_request`  (lines 91–165)

```
async fn process_request(&mut self, request: JsonRpcRequest<ClientRequest>)
```

**Purpose**: Receives one client request and sends it to the right handler. This is the main request router for the MCP server.

**Data flow**: It takes a JSON-RPC request, keeps its request id so replies can match the original message, and examines the request kind. Depending on the kind, it calls the matching handler, which may send a response, log the request, start Codex work, or return an error.

**Call relations**: This function is called whenever the server receives a client request. It is the parent path for initialize, ping, tool listing, tool calls, unsupported task methods, and several currently log-only resource or prompt methods.

*Call graph*: calls 14 internal fn (handle_call_tool, handle_complete, handle_get_prompt, handle_initialize, handle_list_prompts, handle_list_resource_templates, handle_list_resources, handle_list_tools, handle_ping, handle_read_resource (+4 more)); 3 external calls (new, format!, json!).


##### `MessageProcessor::process_response`  (lines 167–171)

```
async fn process_response(&mut self, response: JsonRpcResponse<serde_json::Value>)
```

**Purpose**: Receives a response coming back from the client and forwards it to the outgoing-message system. This lets other parts of the server learn that the client answered something.

**Data flow**: It takes a JSON-RPC response, logs it, separates the id and result, and passes those to the outgoing sender's client-response notification path. It does not create a new response of its own.

**Call relations**: This sits on the inbound message path for client responses. Instead of doing Codex work directly, it hands the response information to OutgoingMessageSender so any waiting code can continue.

*Call graph*: 1 external calls (info!).


##### `MessageProcessor::process_notification`  (lines 173–194)

```
async fn process_notification(
        &mut self,
        notification: JsonRpcNotification<ClientNotification>,
    )
```

**Purpose**: Receives a client notification, which is a message that does not expect a direct reply, and routes it to the matching notification handler.

**Data flow**: It takes the notification object, checks its type, and then either cancels a running Codex request, logs progress information, logs root-list changes, logs initialization completion, or ignores unknown custom notifications with a warning.

**Call relations**: This is the notification counterpart to process_request. Its most important child path is cancellation, where it calls handle_cancelled_notification to interrupt the correct Codex thread.

*Call graph*: calls 4 internal fn (handle_cancelled_notification, handle_initialized_notification, handle_progress_notification, handle_roots_list_changed); 1 external calls (warn!).


##### `MessageProcessor::process_error`  (lines 196–198)

```
fn process_error(&mut self, err: JsonRpcError)
```

**Purpose**: Records a JSON-RPC error received from the client. It is a simple logging hook for errors that arrive from the other side.

**Data flow**: It receives the error object and writes it to the logs. It does not send a reply or change server state.

**Call relations**: This is used by the inbound message loop when the client sends an error instead of a normal request, response, or notification.

*Call graph*: 1 external calls (error!).


##### `MessageProcessor::handle_initialize`  (lines 200–277)

```
async fn handle_initialize(
        &mut self,
        id: RequestId,
        params: rmcp::model::InitializeRequestParams,
    )
```

**Purpose**: Performs the MCP initialization handshake. It tells the client what this server is and what capabilities it supports.

**Data flow**: It receives the request id and initialization parameters from the client. If initialization already happened, it sends an invalid-request error. Otherwise it records the client name and version for the Codex user-agent string, builds server information and tool-related capabilities, adds Codex's existing user_agent field, marks the processor initialized, and sends the initialize result back to the matching request id.

**Call relations**: process_request calls this when the client sends InitializeRequest. It uses the outgoing sender to return either a successful InitializeResult or an error if serialization fails or initialization is repeated.

*Call graph*: called by 1 (process_request); 10 external calls (internal_error, invalid_request, new, new, builder, env!, format!, json!, to_value, info!).


##### `MessageProcessor::handle_ping`  (lines 279–282)

```
async fn handle_ping(&self, id: RequestId)
```

**Purpose**: Answers a ping request to prove the server is alive. It is a lightweight health check.

**Data flow**: It receives the request id, logs that a ping arrived, and sends back an empty JSON object as the result. No stored state changes.

**Call relations**: process_request calls this for PingRequest. It immediately replies through OutgoingMessageSender.

*Call graph*: called by 1 (process_request); 2 external calls (json!, info!).


##### `MessageProcessor::handle_list_resources`  (lines 284–286)

```
fn handle_list_resources(&self, params: Option<rmcp::model::PaginatedRequestParams>)
```

**Purpose**: Logs that the client asked for resources. In this file, resources are not actually returned.

**Data flow**: It receives optional pagination parameters, writes them to the log, and produces no response body or state change here.

**Call relations**: process_request calls this for ListResourcesRequest. Unlike the tool-list handler, this path does not currently send a list back from this function.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_list_resource_templates`  (lines 288–290)

```
fn handle_list_resource_templates(&self, params: Option<rmcp::model::PaginatedRequestParams>)
```

**Purpose**: Logs that the client asked for resource templates. This server does not provide a real template list from this handler.

**Data flow**: It receives optional pagination parameters and records them in the log. It does not modify state or return data here.

**Call relations**: process_request calls this for ListResourceTemplatesRequest. It is a placeholder-style handler compared with the fully implemented tool listing.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_read_resource`  (lines 292–294)

```
fn handle_read_resource(&self, params: rmcp::model::ReadResourceRequestParams)
```

**Purpose**: Logs that the client asked to read a resource. This handler does not fetch resource contents.

**Data flow**: It receives the resource-read parameters and writes them to the log. No outgoing response is sent from this function and no Codex session is touched.

**Call relations**: process_request calls this for ReadResourceRequest. It keeps the request visible in logs but does not hand work to Codex.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_subscribe`  (lines 296–298)

```
fn handle_subscribe(&self, params: rmcp::model::SubscribeRequestParams)
```

**Purpose**: Logs that the client asked to subscribe to a resource. It does not create an active subscription in this file.

**Data flow**: It receives subscription parameters and records them. It does not change the processor's stored fields or send a direct result.

**Call relations**: process_request calls this for SubscribeRequest. The call stops at logging rather than continuing into a subscription system.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_unsubscribe`  (lines 300–302)

```
fn handle_unsubscribe(&self, params: rmcp::model::UnsubscribeRequestParams)
```

**Purpose**: Logs that the client asked to unsubscribe from a resource. It does not remove any subscription state in this file.

**Data flow**: It receives unsubscribe parameters, logs them, and returns without producing data or changing stored state.

**Call relations**: process_request calls this for UnsubscribeRequest. It is part of the resource-related request surface that is currently only observed through logs here.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_list_prompts`  (lines 304–306)

```
fn handle_list_prompts(&self, params: Option<rmcp::model::PaginatedRequestParams>)
```

**Purpose**: Logs that the client asked for available prompts. This handler does not return prompt definitions.

**Data flow**: It receives optional pagination information, writes it to the log, and does not build a prompt list or change state.

**Call relations**: process_request calls this for ListPromptsRequest. It does not call further Codex logic.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_get_prompt`  (lines 308–310)

```
fn handle_get_prompt(&self, params: rmcp::model::GetPromptRequestParams)
```

**Purpose**: Logs that the client asked for one prompt. This handler does not return a prompt body.

**Data flow**: It receives prompt lookup parameters and records them. It does not send prompt content or alter any stored data.

**Call relations**: process_request calls this for GetPromptRequest. The request is noted in logs but not routed to a prompt store.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_list_tools`  (lines 312–328)

```
async fn handle_list_tools(
        &self,
        id: RequestId,
        params: Option<rmcp::model::PaginatedRequestParams>,
    )
```

**Purpose**: Returns the tools this MCP server offers to the client. These are the entry points the client can call to use Codex.

**Data flow**: It receives the request id and optional pagination parameters. It builds a tool-list result containing the "codex" tool for starting a session and the "codex-reply" tool for continuing one, then sends that result back using the request id.

**Call relations**: process_request calls this for ListToolsRequest. It relies on the codex tool configuration helpers to describe the two tools in the shape expected by MCP clients.

*Call graph*: called by 1 (process_request); 2 external calls (trace!, vec!).


##### `MessageProcessor::handle_call_tool`  (lines 330–349)

```
async fn handle_call_tool(&self, id: RequestId, params: CallToolRequestParams)
```

**Purpose**: Routes a tool call to the correct Codex tool implementation. It decides whether the client wants a new Codex session, a reply to an existing session, or an unknown tool error.

**Data flow**: It receives the request id and tool-call parameters, extracts the tool name and arguments, and checks the name. For "codex" it passes the arguments to the new-session handler; for "codex-reply" it passes them to the session-reply handler; for anything else it sends a tool error result.

**Call relations**: process_request calls this for CallToolRequest. This is the branch point that leads into the two main Codex execution paths in this file.

*Call graph*: calls 2 internal fn (handle_tool_call_codex, handle_tool_call_codex_session_reply); called by 1 (process_request); 3 external calls (error, info!, vec!).


##### `MessageProcessor::handle_tool_call_codex`  (lines 351–405)

```
async fn handle_tool_call_codex(
        &self,
        id: RequestId,
        arguments: Option<rmcp::model::JsonObject>,
    )
```

**Purpose**: Starts a new Codex session from a tool call. It validates the client's arguments, builds a Codex configuration, and launches the long-running work in the background.

**Data flow**: It receives the original request id and optional JSON arguments. It requires arguments with a prompt, parses them into CodexToolCallParam, converts that into an initial prompt and Config, and sends an error result if parsing or configuration loading fails. On success, it clones the shared outgoing sender, ThreadManager, and running-request map, then spawns a background task that runs the Codex session and streams results back.

**Call relations**: handle_call_tool calls this when the tool name is "codex". The function hands the actual session work to codex_tool_runner::run_codex_tool_session so the message processor is not blocked while Codex runs.

*Call graph*: calls 1 internal fn (run_codex_tool_session); called by 1 (handle_call_tool); 4 external calls (clone, error, spawn, vec!).


##### `MessageProcessor::handle_tool_call_codex_session_reply`  (lines 407–488)

```
async fn handle_tool_call_codex_session_reply(
        &self,
        request_id: RequestId,
        arguments: Option<rmcp::model::JsonObject>,
    )
```

**Purpose**: Sends a new user prompt into an already-running or previously created Codex thread. It is how the client continues a conversation instead of starting over.

**Data flow**: It receives a request id and optional JSON arguments. It parses the arguments into a reply request, validates and converts the thread id, looks up the matching Codex thread through the ThreadManager, and sends a clear error result if parsing fails or the session cannot be found. If the thread exists, it spawns a background task with the prompt so Codex can process the reply and stream the outcome.

**Call relations**: handle_call_tool calls this when the tool name is "codex-reply". It uses ThreadManager to find the existing session and then hands execution to codex_tool_runner::run_codex_tool_session_reply.

*Call graph*: calls 2 internal fn (create_call_tool_result_with_thread_id, run_codex_tool_session_reply); called by 1 (handle_call_tool); 7 external calls (format!, error, spawn, error!, info!, warn!, vec!).


##### `MessageProcessor::handle_set_level`  (lines 490–492)

```
fn handle_set_level(&self, params: rmcp::model::SetLevelRequestParams)
```

**Purpose**: Logs a client request to change the logging level. This function does not actually change logging settings in this file.

**Data flow**: It receives the requested logging-level parameters and writes them to the log. No response is built here and no local state changes.

**Call relations**: process_request calls this for SetLevelRequest. The call ends with logging rather than being forwarded to a logging configuration system.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_complete`  (lines 494–496)

```
fn handle_complete(&self, params: rmcp::model::CompleteRequestParams)
```

**Purpose**: Logs a client request for completion help. This handler does not calculate completions.

**Data flow**: It receives completion parameters and records them. It does not return suggestions or touch Codex state.

**Call relations**: process_request calls this for CompleteRequest. It is currently a log-only endpoint.

*Call graph*: called by 1 (process_request); 1 external calls (info!).


##### `MessageProcessor::handle_unsupported_request`  (lines 498–509)

```
async fn handle_unsupported_request(&self, id: RequestId, method: &str)
```

**Purpose**: Sends a standard "method not found" error for MCP task methods this server does not support. This gives the client a clear answer instead of silently ignoring the request.

**Data flow**: It receives the request id and method name, builds an error object that names the missing method, and sends that error back to the client using the same request id.

**Call relations**: process_request calls this for task-related requests such as task listing, task cancellation, and task result lookup. It centralizes the unsupported-method response.

*Call graph*: called by 1 (process_request); 3 external calls (new, format!, json!).


##### `MessageProcessor::handle_cancelled_notification`  (lines 515–560)

```
async fn handle_cancelled_notification(&self, params: rmcp::model::CancelledNotificationParam)
```

**Purpose**: Tries to stop a running Codex operation when the client says a request was cancelled. It maps the client's request id back to the Codex thread and sends Codex an interrupt.

**Data flow**: It receives cancellation parameters containing a request id. It looks up that request id in the shared running-request map to find the Codex thread id, then asks the ThreadManager for that thread. If found, it submits an Interrupt operation to Codex using the request id as the submission id, and finally removes the request id from the tracking map. If the request or thread cannot be found, it logs a warning and stops.

**Call relations**: process_notification calls this for CancelledNotification. It depends on the mapping populated by Codex tool-running code, and it talks back into the Codex thread through submit_with_id.

*Call graph*: called by 1 (process_notification); 3 external calls (error!, info!, warn!).


##### `MessageProcessor::handle_progress_notification`  (lines 562–564)

```
fn handle_progress_notification(&self, params: rmcp::model::ProgressNotificationParam)
```

**Purpose**: Logs progress notifications received from the client. It does not otherwise act on the progress information.

**Data flow**: It receives progress parameters and writes them to the log. No reply is expected for a notification, and no state changes here.

**Call relations**: process_notification calls this for ProgressNotification. It is an observation point rather than a driver of Codex work.

*Call graph*: called by 1 (process_notification); 1 external calls (info!).


##### `MessageProcessor::handle_roots_list_changed`  (lines 566–568)

```
fn handle_roots_list_changed(&self)
```

**Purpose**: Logs that the client's list of roots changed. Roots are client-provided workspace locations or boundaries.

**Data flow**: It receives no detailed data in this handler, writes a log message, and does not refresh any workspace state here.

**Call relations**: process_notification calls this for RootsListChangedNotification. The handler currently stops at logging.

*Call graph*: called by 1 (process_notification); 1 external calls (info!).


##### `MessageProcessor::handle_initialized_notification`  (lines 570–572)

```
fn handle_initialized_notification(&self)
```

**Purpose**: Logs that the client sent the post-initialization notification. This marks that the client has completed its side of the startup handshake.

**Data flow**: It receives no extra data, writes a log message, and does not change the initialized flag. The initialized flag is set earlier when the initialize request is answered.

**Call relations**: process_notification calls this for InitializedNotification. It complements handle_initialize, but it does not send any response because notifications do not expect one.

*Call graph*: called by 1 (process_notification); 1 external calls (info!).


### `mcp-server/src/codex_tool_runner.rs`

`orchestration` · `request handling`

This file is the bridge between an MCP client asking to use the Codex tool and the Codex engine doing the work. MCP, or Model Context Protocol, has a specific format for tool replies. Codex has its own longer-running conversation model with events such as “command needs approval,” “patch needs approval,” “error,” and “turn complete.” This file translates between those worlds.

Think of it like a dispatcher for a repair job. The client submits a request, the dispatcher opens a work ticket with Codex, then keeps relaying updates until the job is done or blocked waiting for approval.

For a new request, it starts a Codex thread, sends a “session configured” notification, records which MCP request belongs to which Codex thread, and submits the user’s prompt. For a reply to an existing session, it skips thread creation and submits the new prompt to the existing thread.

The central loop reads Codex events one by one. Every event is first sent to the client as a notification. Some events also need extra action: command approvals are passed to the execution approval code, patch approvals are passed to the patch approval code, errors become failed tool responses, and completed turns become successful tool responses. The file also carefully removes finished request-to-thread records so stale requests do not linger in memory.

#### Function details

##### `create_call_tool_result_with_thread_id`  (lines 36–51)

```
fn create_call_tool_result_with_thread_id(
    thread_id: ThreadId,
    text: String,
    is_error: Option<bool>,
) -> CallToolResult
```

**Purpose**: Builds the final MCP tool response while including the Codex thread ID. This matters because the client may need that thread ID to continue the same Codex conversation later.

**Data flow**: It receives a Codex thread ID, response text, and an optional error flag. It puts the text into the normal response body and also mirrors it into structured data alongside the thread ID. It returns a ready-to-send MCP tool result, marked as an error only when requested.

**Call relations**: The session runners use this whenever they need to answer the original tool call, whether the Codex run succeeded, failed to submit, hit a runtime error, or completed normally. The session-reply path outside this file also uses it so replies keep the same response shape, and the test checks that the thread ID is really present.

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

**Purpose**: Starts a brand-new Codex session for an MCP tool call and submits the user’s initial prompt. It is used when the client is beginning a new Codex conversation rather than replying to an old one.

**Data flow**: It receives the MCP request ID, the prompt text, Codex configuration, the outgoing-message sender, the Codex thread manager, and a shared map that tracks active requests. It asks the thread manager to create a new Codex thread. If that fails, it sends an error response. If it succeeds, it notifies the client that the session is configured, records the request-to-thread link, wraps the prompt as Codex user input, and submits it. If prompt submission fails, it sends an error response and removes the tracking entry. If submission succeeds, it hands the live thread to the inner event loop.

**Call relations**: The MCP tool-call handler calls this when a client invokes the Codex tool for a new session. After setup, it delegates the long-running event work to run_codex_tool_session_inner, which streams events and eventually sends the final MCP response.

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

**Purpose**: Continues an existing Codex session by sending a new user prompt to an already-running thread. This lets a client resume the same conversation instead of starting over.

**Data flow**: It receives the existing thread ID and thread object, the outgoing-message sender, the MCP request ID, the new prompt, and the shared active-request map. It records that this MCP request belongs to the existing Codex thread, submits the prompt as Codex user input, and reacts to failure by sending an error response and removing the tracking entry. On success, it passes control to the shared event loop.

**Call relations**: The session-reply tool-call handler calls this when the client includes a known Codex thread. Like the new-session path, it uses run_codex_tool_session_inner for the actual event streaming and final response.

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

**Purpose**: Watches a Codex thread until the current turn finishes, fails, or needs special approval. It is the main event pump that keeps the MCP client informed while Codex is working.

**Data flow**: It receives the thread ID, the live Codex thread, the outgoing sender, the MCP request ID, and the shared active-request map. It repeatedly asks Codex for the next event. Each event is sent to the client as a notification with request and thread metadata. Then the function decides whether extra work is needed: command approval requests go to the execution approval helper, patch approval requests go to the patch approval helper, errors become error tool responses, and completed turns become successful tool responses. When a turn completes, it removes the request from the active map. If reading from Codex itself fails, it sends a runtime-error response.

**Call relations**: Both the new-session and reply-session functions hand off to this after they submit user input. It calls the approval helpers only when Codex asks for permission, and it calls create_call_tool_result_with_thread_id whenever it must send the final tool-call response back to MCP.

*Call graph*: calls 3 internal fn (create_call_tool_result_with_thread_id, handle_exec_approval_request, handle_patch_approval_request); called by 2 (run_codex_tool_session, run_codex_tool_session_reply); 4 external calls (clone, to_string, format!, error!).


##### `tests::call_tool_result_includes_thread_id_in_structured_content`  (lines 419–433)

```
fn call_tool_result_includes_thread_id_in_structured_content()
```

**Purpose**: Checks that tool results include the Codex thread ID in the structured response data. This protects the resume-conversation behavior from breaking accidentally.

**Data flow**: It creates a fresh thread ID, builds a sample tool result with the text “done,” and compares the structured response against the expected JSON object. Nothing outside the test is changed.

**Call relations**: This test exercises create_call_tool_result_with_thread_id directly. It exists because several live request paths depend on that helper returning a response shape that clients can use to find the Codex thread again.

*Call graph*: calls 2 internal fn (create_call_tool_result_with_thread_id, new); 1 external calls (assert_eq!).


### `rmcp-client/src/elicitation_client_service.rs`

`io_transport` · `request handling`

In this project, an “elicitation” is when the server asks the client to collect some information, such as asking the user to confirm an action or fill in a small form. This file sits at that boundary. It receives server requests through RMCP, the Rust library used for Model Context Protocol communication, and decides what to do with them.

Most requests and notifications are passed through to a logging client handler, which records or responds to ordinary client events. But when the server sends a create-elicitation request, this service takes over. It restores useful request metadata, temporarily marks the client as being in an elicitation pause state, and calls the configured `send_elicitation` callback. That callback is the bridge to the rest of the application, where the request can be shown to a user or handled by UI code.

One important detail is metadata. RMCP lifts JSON-RPC `_meta` data into a separate request context before service code sees the typed request. This file puts that metadata back onto the elicitation request, except for the protocol’s progress token, which should not be treated as application metadata. It also serializes elicitation responses by hand because RMCP’s built-in typed result does not support result-level `_meta` for this case.

#### Function details

##### `ElicitationClientService::new`  (lines 34–48)

```
fn new(
        client_info: ClientInfo,
        send_elicitation: SendElicitation,
        pause_state: ElicitationPauseState,
    ) -> Self
```

**Purpose**: Builds a new elicitation-aware client service. It prepares both the normal logging handler and the special callback used when the server asks the client to collect information from the user.

**Data flow**: It receives client identity information, a `send_elicitation` callback, and a pause-state tracker. It wraps the callback in shared ownership so both this service and the logging handler can use it safely. It returns a ready-to-use `ElicitationClientService` containing those pieces.

**Call relations**: This is called during client initialization. It calls `clone_send_elicitation` so the logging handler can receive its own callable copy, then constructs the underlying logging handler and stores the original shared callback for elicitation requests.

*Call graph*: calls 2 internal fn (clone_send_elicitation, new); called by 1 (initialize); 2 external calls (clone, new).


##### `ElicitationClientService::create_elicitation`  (lines 50–61)

```
async fn create_elicitation(
        &self,
        request: Elicitation,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitationResponse, rmcp::ErrorData>
```

**Purpose**: Carries out one server request to create an elicitation. In plain terms, it takes the server’s question, restores any extra metadata, marks the client as paused for elicitation, and sends the question to application code.

**Data flow**: It receives an elicitation request and its request context, including the request id and metadata. It moves useful metadata back into the request, enters the pause state, then calls the stored `send_elicitation` callback with the request id and request. It returns the elicitation response, or converts callback failure into an RMCP internal error.

**Call relations**: This is used only by `ElicitationClientService::handle_request` when the incoming server request is specifically a create-elicitation request. Before handing off to the callback, it calls `restore_context_meta` and enters the pause state so the rest of the client knows an elicitation is in progress.

*Call graph*: calls 2 internal fn (restore_context_meta, enter); called by 1 (handle_request).


##### `clone_send_elicitation`  (lines 64–66)

```
fn clone_send_elicitation(send_elicitation: Arc<SendElicitation>) -> SendElicitation
```

**Purpose**: Creates another callable wrapper around the shared elicitation sender. This lets more than one part of the service call the same underlying callback without taking ownership away from each other.

**Data flow**: It receives a shared `Arc` pointer to the elicitation callback. It returns a boxed function that, when called with a request id and request, forwards those values to the shared callback.

**Call relations**: This helper is called while constructing `ElicitationClientService`. Its returned wrapper is passed into `LoggingClientHandler::new`, while the service keeps the same shared sender for direct elicitation handling.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `ElicitationClientService::handle_request`  (lines 69–90)

```
async fn handle_request(
        &self,
        request: ServerRequest,
        context: RequestContext<RoleClient>,
    ) -> Result<ClientResult, rmcp::ErrorData>
```

**Purpose**: Receives server requests and chooses the right path for each one. Elicitation requests are handled specially; all other requests are delegated to the normal logging handler.

**Data flow**: It receives a server request and request context. If the request asks to create an elicitation, it extracts the request parameters, waits for `create_elicitation` to produce a response, converts that response into a custom RMCP result, and returns it. For any other request, it forwards the original request and context to the logging handler and returns that result.

**Call relations**: This is the main request entry point required by the RMCP `Service` trait. It calls `create_elicitation` for elicitation traffic, then `elicitation_response_result` because the built-in RMCP result type cannot carry the needed `_meta` field. For non-elicitation traffic, it hands off to `LoggingClientHandler`.

*Call graph*: calls 2 internal fn (create_elicitation, elicitation_response_result); 2 external calls (handle_request, CustomResult).


##### `ElicitationClientService::handle_notification`  (lines 92–103)

```
async fn handle_notification(
        &self,
        notification: ServerNotification,
        context: NotificationContext<RoleClient>,
    ) -> Result<(), rmcp::ErrorData>
```

**Purpose**: Receives server notifications and passes them to the logging handler. Notifications are one-way messages, so this service does not need special elicitation behavior here.

**Data flow**: It receives a server notification and notification context. It forwards both unchanged to the logging handler and returns success or any RMCP error produced there.

**Call relations**: This is the notification entry point required by the RMCP `Service` trait. Unlike request handling, it does not branch on elicitation; it simply delegates to `LoggingClientHandler`.

*Call graph*: 1 external calls (handle_notification).


##### `ElicitationClientService::get_info`  (lines 105–107)

```
fn get_info(&self) -> ClientInfo
```

**Purpose**: Returns the client information advertised to the server, such as the client identity and capabilities held by the underlying handler.

**Data flow**: It reads the stored logging handler and asks it for the client info. It returns that `ClientInfo` value without changing service state.

**Call relations**: This is part of the RMCP `Service` trait. Instead of storing a separate copy of the information, it delegates to `LoggingClientHandler`, which was created with the client info during `ElicitationClientService::new`.

*Call graph*: 1 external calls (get_info).


##### `restore_context_meta`  (lines 110–122)

```
fn restore_context_meta(mut request: Elicitation, mut context_meta: Meta) -> Elicitation
```

**Purpose**: Puts application-level `_meta` data back onto an elicitation request after RMCP has moved it into the request context. It deliberately removes the protocol progress token so that internal progress tracking is not mistaken for user-facing metadata.

**Data flow**: It receives an elicitation request and a metadata map from the request context. It removes the `progressToken` entry, checks whether anything remains, and if so merges the remaining metadata into the request’s own metadata field. It returns the updated request.

**Call relations**: This is called by `ElicitationClientService::create_elicitation` before the request is sent to application code. A unit test also calls it to prove that normal metadata is preserved while the progress token is stripped out.

*Call graph*: called by 2 (create_elicitation, restore_context_meta_adds_elicitation_meta_and_removes_progress_token); 3 external calls (meta_mut, is_empty, remove).


##### `elicitation_response_result`  (lines 134–151)

```
fn elicitation_response_result(
    response: ElicitationResponse,
) -> Result<CustomResult, rmcp::ErrorData>
```

**Purpose**: Turns an application elicitation response into the custom result shape that RMCP can send back to the server. This is needed because RMCP’s typed elicitation result does not include result-level `_meta`.

**Data flow**: It receives an `ElicitationResponse` containing an action, optional content, and optional metadata. It builds a serializable result object using the exact JSON field names expected by the protocol, converts it to JSON, wraps it in `CustomResult`, and returns that. If serialization fails, it returns an RMCP internal error.

**Call relations**: This is called by `ElicitationClientService::handle_request` after application code answers an elicitation. A unit test also calls it to confirm that response metadata becomes a JSON `_meta` field in the final client result.

*Call graph*: called by 2 (handle_request, elicitation_response_result_serializes_response_meta); 1 external calls (to_value).


##### `tests::restore_context_meta_adds_elicitation_meta_and_removes_progress_token`  (lines 166–181)

```
fn restore_context_meta_adds_elicitation_meta_and_removes_progress_token()
```

**Purpose**: Checks that metadata restoration keeps useful application metadata but drops the protocol progress token. This protects the behavior that lets the UI receive custom metadata without leaking internal progress bookkeeping.

**Data flow**: It builds a sample form elicitation request with no metadata and a context metadata object containing both `progressToken` and `persist`. It calls `restore_context_meta`, then compares the result with the expected request that contains only the `persist` metadata.

**Call relations**: This test exercises `restore_context_meta` directly. It uses the test helpers `form_request` and `meta` to build readable sample data, then uses an equality assertion to lock in the intended behavior.

*Call graph*: calls 1 internal fn (restore_context_meta); 4 external calls (assert_eq!, json!, form_request, meta).


##### `tests::elicitation_response_result_serializes_response_meta`  (lines 184–202)

```
fn elicitation_response_result_serializes_response_meta()
```

**Purpose**: Checks that elicitation response metadata is serialized as `_meta` in the JSON sent back to the server. This prevents a regression where metadata would silently disappear from responses.

**Data flow**: It creates an `ElicitationResponse` with an accept action, content, and metadata. It passes that through `elicitation_response_result`, wraps it as a client result, serializes it to JSON, and compares the JSON with the exact expected shape.

**Call relations**: This test exercises `elicitation_response_result` directly. It mirrors the path used by `ElicitationClientService::handle_request` after an elicitation response is received from application code.

*Call graph*: calls 1 internal fn (elicitation_response_result); 3 external calls (assert_eq!, json!, CustomResult).


##### `tests::form_request`  (lines 204–213)

```
fn form_request(meta: Option<Meta>) -> CreateElicitationRequestParams
```

**Purpose**: Builds a small sample form elicitation request for the tests. It gives the tests a consistent request asking for a boolean `confirmed` value.

**Data flow**: It receives optional metadata. It creates a form request with the message `Confirm?`, attaches the provided metadata, builds a schema requiring a boolean `confirmed` field, and returns the finished request object.

**Call relations**: This helper is called by the metadata restoration test to create both the input request and the expected output request. It uses RMCP schema builders so the test data matches real elicitation request shapes.

*Call graph*: 3 external calls (new, builder, Boolean).


##### `tests::meta`  (lines 215–220)

```
fn meta(value: Value) -> Meta
```

**Purpose**: Converts a JSON object into RMCP’s `Meta` wrapper for test setup. It keeps test code short while ensuring metadata is always shaped like an object.

**Data flow**: It receives a JSON value. If the value is an object, it wraps the object map in `Meta` and returns it. If the value is not an object, it panics because metadata must be an object for these tests.

**Call relations**: This helper is used by the metadata restoration test to build context and expected request metadata. It supports the test flow rather than production request handling.

*Call graph*: 2 external calls (panic!, Meta).


### `rmcp-client/src/logging_client_handler.rs`

`io_transport` · `active during MCP connection event handling`

An MCP server can send more than direct replies. It can say “this request was cancelled,” “progress is now 50%,” “my tool list changed,” or “please ask the user this question.” This file is the client’s receptionist for those server messages. It implements the RMCP library’s ClientHandler trait, which means the RMCP runtime calls these methods when protocol events arrive.

Most of the handler’s job is to turn server notifications into local log entries. For example, progress and resource updates are written as informational logs, while server log messages are mapped to matching local log levels such as error, warning, info, or debug. This keeps server activity visible to people operating or debugging the client.

The one action that goes beyond logging is create_elicitation. “Elicitation” means the server is asking the client to collect extra information, often from a person. The handler forwards that request to a stored async sender function. That sender is wrapped in an Arc, a shared pointer that lets cloned handlers safely point to the same sender. Without this file, the MCP client could still connect, but many server-side events would disappear silently, and server requests for user input would have nowhere useful to go.

#### Function details

##### `LoggingClientHandler::new`  (lines 29–34)

```
fn new(client_info: ClientInfo, send_elicitation: SendElicitation) -> Self
```

**Purpose**: Builds a new handler with the client’s identity information and the function used to answer server elicitation requests. This is used when the MCP client is being set up.

**Data flow**: It receives a ClientInfo value and a SendElicitation function. It stores the client info directly, wraps the elicitation sender in Arc so shared copies can use it, and returns a ready-to-use LoggingClientHandler.

**Call relations**: During client construction, a higher-level new function calls this constructor. Inside, it uses Arc::new to prepare the elicitation sender for safe sharing across cloned handler instances.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `LoggingClientHandler::create_elicitation`  (lines 38–47)

```
async fn create_elicitation(
        &self,
        request: CreateElicitationRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<CreateElicitationResult, rmcp::ErrorData>
```

**Purpose**: Responds when the MCP server asks the client to gather extra information. It forwards the request to the configured elicitation sender and turns the answer into the response format expected by RMCP.

**Data flow**: It receives the server’s elicitation request and a request context containing the request id. It passes both to the stored async sender. If the sender succeeds, its result is converted into a CreateElicitationResult; if it fails, the error text is wrapped as an internal RMCP error and returned to the server.

**Call relations**: The RMCP runtime calls this method when an elicitation request arrives from the server. This method is the bridge from protocol traffic into the client’s own user-input path, then hands the final result or error back to RMCP.


##### `LoggingClientHandler::on_cancelled`  (lines 49–58)

```
async fn on_cancelled(
        &self,
        params: CancelledNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Records that the MCP server cancelled a request. This gives operators a clear note about which request stopped and why, if the server supplied a reason.

**Data flow**: It receives cancellation details from the server, including the request id and optional reason. It formats those details into an informational log message. It does not return data or change stored state.

**Call relations**: The RMCP runtime calls this method when a cancellation notification arrives. The method hands the event to the tracing info log so it becomes visible in the client’s normal logs.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_progress`  (lines 60–69)

```
async fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Records progress updates sent by the MCP server. This helps users and developers see that a long-running server task is still moving forward.

**Data flow**: It receives a progress notification with a token, current progress value, optional total, and optional message. It writes those fields into an informational log entry and otherwise leaves the handler unchanged.

**Call relations**: The RMCP runtime calls this method whenever the server sends progress. The method passes the update to the info logging system instead of triggering any further client behavior.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_resource_updated`  (lines 71–77)

```
async fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Records that a specific MCP resource changed on the server. A resource is an addressable item, such as a document or data source, identified here by a URI.

**Data flow**: It receives the updated resource’s URI from the server. It writes that URI into an informational log message. Nothing is returned and no local cache is updated here.

**Call relations**: The RMCP runtime calls this method when the server announces a resource update. This handler’s role is only to make that announcement visible through the info log.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_resource_list_changed`  (lines 79–81)

```
async fn on_resource_list_changed(&self, _context: NotificationContext<RoleClient>)
```

**Purpose**: Records that the server’s list of available resources has changed. This is a general notice, not an update for one specific resource.

**Data flow**: It receives the notification context but does not need any fields from it. It writes a simple informational log message saying the resource list changed.

**Call relations**: The RMCP runtime calls this after the server reports a resource-list change. The method forwards that fact to the info log and does not fetch the new list itself.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_tool_list_changed`  (lines 83–85)

```
async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>)
```

**Purpose**: Records that the server’s list of tools has changed. Tools are actions the server makes available for the client or model to call.

**Data flow**: It receives the notification context, ignores it, and writes an informational log message. It does not return anything or update any tool registry here.

**Call relations**: The RMCP runtime calls this method when the server announces that its tool list changed. This handler simply logs the event so another part of the system or an operator can notice it.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::on_prompt_list_changed`  (lines 87–89)

```
async fn on_prompt_list_changed(&self, _context: NotificationContext<RoleClient>)
```

**Purpose**: Records that the server’s list of prompts has changed. Prompts are reusable instruction templates or named prompt entries exposed by the server.

**Data flow**: It receives the notification context, does not read it, and writes an informational log message. The handler state stays the same.

**Call relations**: The RMCP runtime calls this method when the server sends a prompt-list change notification. The method’s only handoff is to the info logging system.

*Call graph*: 1 external calls (info!).


##### `LoggingClientHandler::get_info`  (lines 91–93)

```
fn get_info(&self) -> ClientInfo
```

**Purpose**: Provides the client identity information to the RMCP library. This lets the protocol layer tell the server what client is connecting.

**Data flow**: It reads the stored ClientInfo value, clones it, and returns the clone. Cloning means the caller gets its own copy while the handler keeps its original.

**Call relations**: The RMCP runtime calls this through the ClientHandler trait when it needs client metadata. The method uses clone so it can hand out the information without giving away ownership of the handler’s stored copy.

*Call graph*: 1 external calls (clone).


##### `LoggingClientHandler::on_logging_message`  (lines 95–135)

```
async fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    )
```

**Purpose**: Receives log messages sent by the MCP server and records them at the matching local severity. Serious server messages become local errors, warnings become warnings, ordinary notices become info logs, and debug messages stay debug logs.

**Data flow**: It receives a server log notification containing a level, optional logger name, and data payload. It chooses the matching local tracing macro based on the level and writes one log entry containing all three pieces of information. It returns no value and does not change state.

**Call relations**: The RMCP runtime calls this whenever the server sends a logging notification. This method translates the server’s logging level into the client’s tracing system by calling error, warn, info, or debug as appropriate.

*Call graph*: 4 external calls (debug!, error!, info!, warn!).


### HTTP proxy request handling
This standalone transport router handles incoming HTTP and CONNECT traffic, applies proxy policy, and forwards or blocks requests accordingly.

### `network-proxy/src/http_proxy.rs`

`io_transport` · `startup and request handling`

This file is the front door for HTTP and HTTPS traffic going through the network proxy. Without it, clients could not send normal HTTP proxy requests or HTTPS CONNECT tunnels through this service, and the project would lose the place where network rules are enforced before traffic leaves the machine.

The file starts a Rama-based HTTP/1 proxy server. For plain HTTP requests, it reads the target host, checks whether the proxy is enabled, checks host allow/deny rules, checks whether the HTTP method is allowed in the current network mode, removes headers that should not be forwarded, and then sends the request upstream. For HTTPS CONNECT requests, it first decides whether the tunnel may be opened. In limited mode, or when host-specific inspection hooks exist, it may require MITM, meaning the proxy temporarily acts like a controlled middle point so it can inspect the encrypted inner HTTP request. If MITM is required but not configured, the request is blocked instead of silently bypassing policy.

The file also has a guarded escape hatch for Unix socket requests using an `x-unix-socket` header. This is treated carefully because Unix sockets can talk to powerful local services. Responses are designed to be useful: blocked requests include policy details, are recorded in state, and emit audit events.

#### Function details

##### `run_http_proxy`  (lines 86–103)

```
async fn run_http_proxy(
    state: Arc<NetworkProxyState>,
    addr: SocketAddr,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<()>
```

**Purpose**: Starts the HTTP proxy by binding a new TCP listener to the requested address. This is the normal entry used when the proxy owns the socket from the beginning.

**Data flow**: It receives shared proxy state, a network address, and an optional policy decider. It creates a listener on that address, adds helpful error context if binding fails, then passes the listener and the same state onward. The result is either a running proxy server or an error explaining why startup failed.

**Call relations**: The higher-level `run` code calls this during startup. After creating the listener, it hands control to `run_http_proxy_with_listener`, which builds and serves the actual HTTP proxy service.

*Call graph*: calls 1 internal fn (run_http_proxy_with_listener); called by 1 (run); 1 external calls (build).


##### `run_http_proxy_with_std_listener`  (lines 105–113)

```
async fn run_http_proxy_with_std_listener(
    state: Arc<NetworkProxyState>,
    listener: StdTcpListener,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<()>
```

**Purpose**: Starts the HTTP proxy from an already-created standard Rust TCP listener. This is useful when another part of the program, or a test, has already opened the socket.

**Data flow**: It takes shared proxy state, an existing standard listener, and an optional policy decider. It converts the listener into Rama's async listener type, then continues as if the proxy had created the listener itself. It returns success once the server finishes or an error if conversion or serving fails.

**Call relations**: Both production startup code and the listener integration test call this. It delegates the real server setup to `run_http_proxy_with_listener` after adapting the listener type.

*Call graph*: calls 1 internal fn (run_http_proxy_with_listener); called by 2 (http_proxy_listener_accepts_plain_http1_connect_requests, run); 1 external calls (try_from).


##### `run_http_proxy_with_listener`  (lines 115–154)

```
async fn run_http_proxy_with_listener(
    state: Arc<NetworkProxyState>,
    listener: TcpListener,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<()>
```

**Purpose**: Builds the HTTP proxy service around an already-prepared listener and begins accepting connections. This is where plain HTTP requests and CONNECT tunnel requests are wired to their separate paths.

**Data flow**: It receives shared state, a listener, and an optional policy decider. It makes sure TLS cryptography support is initialized, reads the listener address for logging, builds an HTTP/1 service with a CONNECT upgrade path and a plain HTTP path, attaches the shared state to incoming requests, and serves forever until the listener stops.

**Call relations**: `run_http_proxy` and `run_http_proxy_with_std_listener` both call this after they have a listener. It connects CONNECT requests to `http_connect_accept` and `http_connect_proxy`, and all other HTTP proxy requests to `http_plain_proxy`.

*Call graph*: called by 2 (run_http_proxy, run_http_proxy_with_std_listener); 9 external calls (new, http1, hop_by_hop, local_addr, serve, new, ensure_rustls_crypto_provider, info!, service_fn).


##### `http_connect_accept`  (lines 156–329)

```
async fn http_connect_accept(
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    mut req: Request,
) -> Result<(Response, Request), Response>
```

**Purpose**: Decides whether an HTTPS CONNECT request is allowed before the proxy opens a tunnel. This is the policy checkpoint for encrypted traffic.

**Data flow**: It reads the request, shared proxy state, target host and port, and client address. It normalizes the host, checks whether the proxy is enabled, asks the policy system whether the host is allowed, decides whether MITM inspection is required, records and audits blocks, and stores tunnel metadata in the request if allowed. It returns either an OK response plus the request for upgrade, or a response that explains why the CONNECT was rejected.

**Call relations**: The CONNECT upgrade layer calls this before a tunnel is established. It uses helpers such as `client_addr`, `proxy_disabled_response`, `blocked_text_with_details`, and `emit_http_block_decision_audit_event`; if it succeeds, `http_connect_proxy` receives the upgraded connection with the stored target information.

*Call graph*: calls 9 internal fn (blocked_text_with_details, client_addr, emit_http_block_decision_audit_event, proxy_disabled_response, text_response, new, evaluate_host_policy, normalize_host, new); called by 4 (http_connect_accept_allows_allowlisted_host_in_full_mode, http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state, http_connect_accept_blocks_in_limited_mode, http_connect_accept_denies_denylisted_host); 9 external calls (try_from, extensions, extensions_mut, builder, error!, empty, info!, ProxyTarget, warn!).


##### `http_connect_proxy`  (lines 331–405)

```
async fn http_connect_proxy(upgraded: Upgraded) -> Result<(), Infallible>
```

**Purpose**: Runs the data path after a CONNECT request has been accepted and upgraded into a raw tunnel. It either sends the tunnel through MITM inspection or forwards bytes directly to the target.

**Data flow**: It reads metadata attached during CONNECT acceptance, including network mode, target host and port, MITM settings, shared state, and upstream proxy settings. If MITM is enabled and configured, it gives the tunnel to the MITM subsystem. Otherwise it chooses direct routing or an upstream proxy and forwards the tunnel. It logs errors but returns cleanly because the connection itself is already in progress.

**Call relations**: This function follows a successful `http_connect_accept`. It may hand the upgraded connection to `mitm::mitm_tunnel`, or it calls `forward_connect_tunnel` to create the outgoing connection and pipe bytes between client and target.

*Call graph*: calls 4 internal fn (forward_connect_tunnel, mitm_tunnel, normalize_host, proxy_for_connect); 4 external calls (extensions, error!, info!, warn!).


##### `forward_connect_tunnel`  (lines 407–477)

```
async fn forward_connect_tunnel(
    upgraded: Upgraded,
    proxy: Option<ProxyAddress>,
    app_state: Arc<NetworkProxyState>,
) -> Result<(), BoxError>
```

**Purpose**: Creates the outgoing side of an accepted CONNECT tunnel and copies traffic between the client and the remote server. This is the direct tunnel machinery.

**Data flow**: It takes the upgraded client connection, an optional upstream proxy address, and shared proxy state. It reads the target saved in request extensions, builds a TCP/TLS connection request, uses a connector that still checks target policy, dials the target, and then forwards bytes both ways. It returns success when forwarding ends normally or an error if dialing or forwarding fails.

**Call relations**: `http_connect_proxy` calls this when a CONNECT tunnel should not go through MITM. It uses Rama connector and stream-forwarding services to do the low-level network work.

*Call graph*: calls 1 internal fn (new); called by 1 (http_connect_proxy); 10 external calls (optional, now, from_boxed, default, new_with_extensions, new, tunnel, extensions, info!, warn!).


##### `http_plain_proxy`  (lines 479–803)

```
async fn http_plain_proxy(
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    mut req: Request,
) -> Result<Response, Infallible>
```

**Purpose**: Processes ordinary HTTP proxy requests, where the request itself is visible without opening a CONNECT tunnel. It is the main policy gate for non-CONNECT HTTP traffic.

**Data flow**: It receives an HTTP request with shared proxy state attached. It finds the client address, checks method rules, handles the special Unix socket route if requested, validates the target host, checks whether the proxy is enabled, evaluates host policy, blocks disallowed methods, chooses direct or environment-proxy upstream routing, removes hop-by-hop headers, and forwards the request. It returns either the upstream response or a local error/blocked response.

**Call relations**: The HTTP server calls this for non-CONNECT requests. It depends on helpers such as `client_addr`, `validate_absolute_form_host_header`, `json_blocked`, `proxy_disabled_response`, `proxy_via_unix_socket`, and `remove_hop_by_hop_request_headers` before handing allowed traffic to `UpstreamClient`.

*Call graph*: calls 16 internal fn (client_addr, emit_http_allow_decision_audit_event, emit_http_block_decision_audit_event, json_blocked, proxy_disabled_response, proxy_via_unix_socket, remove_hop_by_hop_request_headers, text_response, validate_absolute_form_host_header, new (+6 more)); called by 4 (http_plain_proxy_attempts_allowed_unix_socket_proxy, http_plain_proxy_blocks_unix_socket_when_method_not_allowed, http_plain_proxy_rejects_absolute_uri_host_header_mismatch, http_plain_proxy_rejects_unix_socket_when_not_allowlisted); 8 external calls (try_from, extensions, headers, headers_mut, method, error!, info!, warn!).


##### `proxy_via_unix_socket`  (lines 805–831)

```
async fn proxy_via_unix_socket(req: Request, socket_path: &str) -> Result<Response>
```

**Purpose**: Forwards an allowed HTTP request to a local Unix socket instead of a network host. This supports local daemon access through the proxy, but only after `http_plain_proxy` has already checked permissions.

**Data flow**: It receives the original request and a socket path. On macOS, it creates a Unix-socket upstream client, rewrites the request URI to just the path and query, removes the special socket header and hop-by-hop headers, then sends the request. On other platforms, it returns an error saying Unix sockets are not supported.

**Call relations**: `http_plain_proxy` calls this only after checking that the proxy is enabled, the method is allowed, the platform supports this feature, and the socket path is allowlisted.

*Call graph*: calls 2 internal fn (remove_hop_by_hop_request_headers, unix_socket); called by 1 (http_plain_proxy); 3 external calls (anyhow!, from_parts, into_parts).


##### `client_addr`  (lines 833–838)

```
fn client_addr(input: &T) -> Option<String>
```

**Purpose**: Extracts the connecting client's address from request or connection metadata. This address is used for logs, audit events, and blocked-request records.

**Data flow**: It receives any object that exposes request extensions. It looks for Rama socket information and, if present, turns the peer address into text. It returns that text or nothing if the socket information is missing.

**Call relations**: `http_connect_accept` and `http_plain_proxy` call this early in request handling so later allow/block decisions can include who made the request.

*Call graph*: called by 2 (http_connect_accept, http_plain_proxy); 1 external calls (extensions).


##### `validate_absolute_form_host_header`  (lines 840–872)

```
fn validate_absolute_form_host_header(
    req: &Request,
    request_ctx: &RequestContext,
) -> Result<(), &'static str>
```

**Purpose**: Rejects suspicious HTTP proxy requests where the full URL target and the `Host` header point to different places. This prevents ambiguity about which host the policy check should trust.

**Data flow**: It receives the request and Rama's parsed request context. If the URI is not an absolute URI, it accepts it. If there is a `Host` header, it compares its host and port against the request target, allowing omitted ports only when the target uses the default port. It returns success or a short error message.

**Call relations**: `http_plain_proxy` calls this after parsing the target and before policy checks. If it reports a mismatch, `http_plain_proxy` stops the request with a bad-request response instead of forwarding it.

*Call graph*: called by 1 (http_plain_proxy); 3 external calls (authority_has_default_port, headers, uri).


##### `remove_hop_by_hop_request_headers`  (lines 873–906)

```
fn remove_hop_by_hop_request_headers(headers: &mut HeaderMap)
```

**Purpose**: Removes HTTP headers that apply only to one connection hop and should not be forwarded to the next server. This keeps proxy behavior correct and avoids leaking proxy-only instructions upstream.

**Data flow**: It receives a mutable header map. It removes the `Connection` header, any extra headers named by `Connection`, and standard hop-by-hop headers such as keep-alive, proxy authorization, transfer encoding, upgrade, and TE. The same header map comes out cleaned in place.

**Call relations**: `http_plain_proxy` calls this before forwarding normal HTTP requests, and `proxy_via_unix_socket` calls it before sending to a local socket. A test checks that it removes connection-only headers while preserving forwarding headers.

*Call graph*: called by 3 (http_plain_proxy, proxy_via_unix_socket, remove_hop_by_hop_request_headers_keeps_forwarding_headers); 3 external calls (get, remove, from_bytes).


##### `json_blocked`  (lines 908–937)

```
fn json_blocked(host: &str, reason: &str, details: Option<&PolicyDecisionDetails<'_>>) -> Response
```

**Purpose**: Builds a JSON response for a blocked plain HTTP request. It gives clients a machine-readable explanation of why the proxy refused the request.

**Data flow**: It receives a host, a reason, and optional policy details. It creates a JSON body with status, host, reason, and, when available, decision/source/protocol/port/message fields. It sets the HTTP status to forbidden and adds an `x-proxy-error` header with a compact reason code.

**Call relations**: `http_plain_proxy` uses this whenever it blocks a visible HTTP request or Unix socket request and wants a structured response rather than plain text.

*Call graph*: calls 2 internal fn (blocked_header_value, json_response); called by 1 (http_plain_proxy); 1 external calls (from_static).


##### `blocked_text_with_details`  (lines 939–941)

```
fn blocked_text_with_details(reason: &str, details: &PolicyDecisionDetails<'_>) -> Response
```

**Purpose**: Builds a plain-text blocked response that includes policy details. It is used for CONNECT failures, where a simple text response is appropriate before the tunnel opens.

**Data flow**: It receives a block reason and policy decision details. It passes them to the shared response helper, which creates the final text response. The output is an HTTP response explaining the block.

**Call relations**: `http_connect_accept` calls this when a CONNECT request is denied by policy or because MITM is required but unavailable.

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

**Purpose**: Creates the standard response used when the entire proxy is switched off. It also records and audits the blocked request so operators can see what happened.

**Data flow**: It receives proxy state, target host and port, optional client and method, protocol, and an optional audit endpoint override. It emits a block audit event, records the blocked request in state, builds policy details, and returns a service-unavailable text response with an explanatory message.

**Call relations**: `http_connect_accept` and `http_plain_proxy` call this whenever they discover the proxy is disabled. It uses `emit_http_block_decision_audit_event`, `record_blocked`, and `text_response` to make the block visible and consistent.

*Call graph*: calls 6 internal fn (emit_http_block_decision_audit_event, text_response, as_policy_protocol, blocked_message_with_policy, new, record_blocked); called by 2 (http_connect_accept, http_plain_proxy).


##### `internal_error`  (lines 996–999)

```
fn internal_error(context: &str, err: impl std::fmt::Display) -> Response
```

**Purpose**: Turns an unexpected internal failure into a generic HTTP 500 response while logging the real problem. This avoids exposing implementation details to clients.

**Data flow**: It receives a short context message and an error value. It logs both, then creates a plain `error` response with internal-server-error status. The caller gets the response to send back to the client.

**Call relations**: Several request paths use this pattern through inline error mapping when reading state or configuration fails. It relies on `text_response` to build the actual HTTP response.

*Call graph*: calls 1 internal fn (text_response); 1 external calls (error!).


##### `text_response`  (lines 1001–1007)

```
fn text_response(status: StatusCode, body: &str) -> Response
```

**Purpose**: Builds a simple plain-text HTTP response with a chosen status code. It is the common helper for small error and status messages.

**Data flow**: It receives a status code and a body string. It creates a response with `content-type: text/plain` and the body text, falling back to a basic response if builder construction somehow fails. The output is ready to return to the client.

**Call relations**: `http_connect_accept`, `http_plain_proxy`, `internal_error`, and `proxy_disabled_response` use this whenever they need a straightforward non-JSON response.

*Call graph*: called by 4 (http_connect_accept, http_plain_proxy, internal_error, proxy_disabled_response); 2 external calls (builder, from).


##### `emit_http_block_decision_audit_event`  (lines 1009–1014)

```
fn emit_http_block_decision_audit_event(
    app_state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Sends a block audit event for an HTTP proxy decision. It is a small wrapper that keeps HTTP proxy code using one local function name.

**Data flow**: It receives proxy state and audit event details such as reason, protocol, target, method, and client. It forwards those details to the shared audit-event emitter. It does not return a value.

**Call relations**: `http_connect_accept`, `http_plain_proxy`, and `proxy_disabled_response` call this when they block traffic for policy, proxy-state, method, platform, or MITM reasons.

*Call graph*: calls 1 internal fn (emit_block_decision_audit_event); called by 3 (http_connect_accept, http_plain_proxy, proxy_disabled_response).


##### `emit_http_allow_decision_audit_event`  (lines 1016–1021)

```
fn emit_http_allow_decision_audit_event(
    app_state: &NetworkProxyState,
    args: BlockDecisionAuditEventArgs<'_>,
)
```

**Purpose**: Sends an allow audit event for an HTTP proxy decision. In this file it is mainly used when a Unix socket request is explicitly allowed.

**Data flow**: It receives proxy state and audit event details. It forwards them to the shared allow-event emitter. It does not change the response directly, but it leaves an audit trail.

**Call relations**: `http_plain_proxy` calls this after a Unix socket path passes the allowlist check and before the request is sent to the socket.

*Call graph*: calls 1 internal fn (emit_allow_decision_audit_event); called by 1 (http_plain_proxy).


##### `tests::http_connect_accept_blocks_in_limited_mode`  (lines 1060–1085)

```
async fn http_connect_accept_blocks_in_limited_mode()
```

**Purpose**: Checks that CONNECT is blocked in limited mode when MITM is needed but no MITM state is available. This protects the rule that encrypted traffic cannot bypass inner-request enforcement.

**Data flow**: The test builds a policy allowing `example.com`, switches the state to limited mode, creates a CONNECT request, and calls `http_connect_accept`. It expects a forbidden response with the MITM-required error header.

**Call relations**: This test calls `http_connect_accept` directly to verify the CONNECT acceptance gate without running a full server.

*Call graph*: calls 3 internal fn (default, http_connect_accept, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_connect_accept_allows_allowlisted_host_in_full_mode`  (lines 1088–1111)

```
async fn http_connect_accept_allows_allowlisted_host_in_full_mode()
```

**Purpose**: Checks that an allowlisted host can open a CONNECT tunnel in full network mode. This confirms that normal HTTPS tunneling works when policy allows it.

**Data flow**: The test creates state with `example.com` allowlisted, builds a CONNECT request for that host, and calls `http_connect_accept`. It expects an OK response rather than a block.

**Call relations**: This directly exercises `http_connect_accept` to make sure the positive path still works alongside the stricter blocking paths.

*Call graph*: calls 3 internal fn (default, http_connect_accept, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state`  (lines 1114–1147)

```
async fn http_connect_accept_blocks_hooked_host_in_full_mode_without_mitm_state()
```

**Purpose**: Checks that a host with MITM hooks is blocked if MITM support is not actually available. This prevents configured inspection hooks from being silently skipped.

**Data flow**: The test creates a policy with MITM enabled and a hook for `api.github.com`, but no loaded MITM state. It sends a CONNECT request to that host and expects a forbidden MITM-required response.

**Call relations**: This calls `http_connect_accept` to verify the path where host-specific hooks force MITM even in full network mode.

*Call graph*: calls 2 internal fn (http_connect_accept, network_proxy_state_for_policy); 6 external calls (new, default, assert_eq!, builder, empty, vec!).


##### `tests::http_proxy_listener_accepts_plain_http1_connect_requests`  (lines 1150–1209)

```
async fn http_proxy_listener_accepts_plain_http1_connect_requests()
```

**Purpose**: Checks that the running proxy listener accepts a basic HTTP/1 CONNECT request and replies with `200 OK`. This guards against startup or protocol handling regressions.

**Data flow**: The test starts a dummy target listener, starts the proxy on a local listener, opens a TCP connection to the proxy, writes a raw CONNECT request, and reads the response. It expects the response to begin with `HTTP/1.1 200 OK`.

**Call relations**: This integration-style test calls `run_http_proxy_with_std_listener`, which goes through the real listener setup and request routing before reaching the CONNECT path.

*Call graph*: calls 3 internal fn (default, run_http_proxy_with_std_listener, network_proxy_state_for_policy); 11 external calls (new, from_secs, bind, from_utf8_lossy, bind, assert!, format!, connect, spawn, timeout (+1 more)).


##### `tests::http_plain_proxy_blocks_unix_socket_when_method_not_allowed`  (lines 1212–1238)

```
async fn http_plain_proxy_blocks_unix_socket_when_method_not_allowed()
```

**Purpose**: Checks that Unix socket proxying still obeys HTTP method restrictions. This matters because local socket access should not become a way around limited-mode rules.

**Data flow**: The test creates limited-mode state, builds a POST request with an `x-unix-socket` header, and sends it to `http_plain_proxy`. It expects a forbidden response with the method-policy error header.

**Call relations**: This calls `http_plain_proxy` directly and focuses on the Unix socket branch before any upstream forwarding occurs.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 4 external calls (new, assert_eq!, builder, empty).


##### `tests::http_plain_proxy_rejects_unix_socket_when_not_allowlisted`  (lines 1241–1267)

```
async fn http_plain_proxy_rejects_unix_socket_when_not_allowlisted()
```

**Purpose**: Checks that a Unix socket request is not accepted unless the path is explicitly allowed. On platforms without support, it checks that the feature is reported as unavailable.

**Data flow**: The test builds a GET request with an `x-unix-socket` header but no allowlist entry and calls `http_plain_proxy`. On macOS it expects a forbidden allowlist block; elsewhere it expects not implemented.

**Call relations**: This exercises the Unix socket checks inside `http_plain_proxy`, including the platform-support branch.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, cfg!, builder, empty).


##### `tests::http_plain_proxy_attempts_allowed_unix_socket_proxy`  (lines 1271–1290)

```
async fn http_plain_proxy_attempts_allowed_unix_socket_proxy()
```

**Purpose**: Checks that an allowlisted Unix socket path reaches the proxying attempt on macOS. It confirms that the allowlist opens the route, even if the test socket itself is not serving.

**Data flow**: The test creates state allowing `/tmp/test.sock`, builds a GET request with that socket header, and calls `http_plain_proxy`. Because no real socket server is present, it expects a bad-gateway response after the attempted proxy.

**Call relations**: This macOS-only test follows `http_plain_proxy` into `proxy_via_unix_socket` after all permission checks pass.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_connect_accept_denies_denylisted_host`  (lines 1293–1318)

```
async fn http_connect_accept_denies_denylisted_host()
```

**Purpose**: Checks that a denylist entry overrides an allowlist pattern for CONNECT requests. This confirms the proxy blocks specifically forbidden HTTPS targets.

**Data flow**: The test allows a wildcard OpenAI domain pattern but denies `api.openai.com`, then builds a CONNECT request to that denied host. It calls `http_connect_accept` and expects a forbidden denylist response.

**Call relations**: This directly verifies the host-policy decision path inside `http_connect_accept`.

*Call graph*: calls 3 internal fn (default, http_connect_accept, network_proxy_state_for_policy); 5 external calls (new, assert_eq!, builder, empty, vec!).


##### `tests::http_plain_proxy_rejects_absolute_uri_host_header_mismatch`  (lines 1321–1335)

```
async fn http_plain_proxy_rejects_absolute_uri_host_header_mismatch()
```

**Purpose**: Checks that plain HTTP proxy requests are rejected when the absolute URL and `Host` header disagree. This protects policy checks from ambiguous or misleading host information.

**Data flow**: The test builds a GET request whose URI targets one host while the `Host` header names another. It calls `http_plain_proxy` and expects a bad-request response.

**Call relations**: This test reaches `validate_absolute_form_host_header` through the normal `http_plain_proxy` flow.

*Call graph*: calls 3 internal fn (default, http_plain_proxy, network_proxy_state_for_policy); 4 external calls (new, assert_eq!, builder, empty).


##### `tests::validate_absolute_form_host_header_allows_matching_default_port`  (lines 1338–1350)

```
fn validate_absolute_form_host_header_allows_matching_default_port()
```

**Purpose**: Checks that a request with a matching host and an omitted default port is accepted. This prevents the validation from being too strict for normal HTTP requests.

**Data flow**: The test builds an absolute `http://example.com/` request with `Host: example.com`, parses its request context, and calls `validate_absolute_form_host_header`. It expects success.

**Call relations**: This unit test focuses only on `validate_absolute_form_host_header`, independent of the full proxy path.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


##### `tests::validate_absolute_form_host_header_rejects_mismatched_host`  (lines 1353–1365)

```
fn validate_absolute_form_host_header_rejects_mismatched_host()
```

**Purpose**: Checks that host-name mismatches are rejected. This verifies the core safety behavior of the host-header validator.

**Data flow**: The test builds a request targeting `raw.githubusercontent.com` but with `Host: api.github.com`. It calls `validate_absolute_form_host_header` and expects the mismatch error.

**Call relations**: This unit test directly covers the host comparison logic used by `http_plain_proxy`.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


##### `tests::validate_absolute_form_host_header_rejects_missing_non_default_port`  (lines 1368–1380)

```
fn validate_absolute_form_host_header_rejects_missing_non_default_port()
```

**Purpose**: Checks that a missing `Host` port is rejected when the URI uses a non-default port. This avoids treating `example.com` and `example.com:8080` as the same destination.

**Data flow**: The test builds a request to `http://example.com:8080/` with `Host: example.com`, calls `validate_absolute_form_host_header`, and expects a mismatch error.

**Call relations**: This unit test covers the port-checking branch of `validate_absolute_form_host_header`.

*Call graph*: 3 external calls (assert_eq!, builder, empty).


##### `tests::remove_hop_by_hop_request_headers_keeps_forwarding_headers`  (lines 1383–1413)

```
fn remove_hop_by_hop_request_headers_keeps_forwarding_headers()
```

**Purpose**: Checks that connection-only headers are removed while legitimate forwarding headers remain. This protects the proxy from over-removing useful request metadata.

**Data flow**: The test creates a header map containing `Connection`, a header named by `Connection`, proxy authorization, `X-Forwarded-For`, and `Host`. It calls `remove_hop_by_hop_request_headers` and verifies the hop-by-hop headers are gone while `X-Forwarded-For` and `Host` remain.

**Call relations**: This unit test directly covers the header-cleaning helper used before forwarding plain HTTP and Unix socket requests.

*Call graph*: calls 1 internal fn (remove_hop_by_hop_request_headers); 3 external calls (new, from_static, assert_eq!).
