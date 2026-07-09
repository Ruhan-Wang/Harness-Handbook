# Backend clients, remote catalogs, and startup refreshes  `stage-7`

This stage runs during startup and early background setup. Its job is to make the app ready to talk to outside services and local model tools before users depend on them. The cloud-config files load cloud-delivered settings: lib exposes the small public API, backend fetches bundles from the service, service chooses cache or network, and bundle_loader wires in login and starts refreshes. The model files ask Codex, OpenAI-compatible providers, Amazon Bedrock, Ollama, and LM Studio what models are available, then models-manager combines bundled, cached, live, and login-based choices into one usable menu. The OSS, Ollama, and LM Studio helpers check local model servers and prepare them when requested. Connector and plugin code fetches ChatGPT connector directories, workspace plugin settings, local plugin connectors, and the built-in plugin catalog, using caches and fallbacks so startup stays reliable. The MCP client starts or connects to tool servers and manages sessions and tokens. Smaller backend clients fetch ChatGPT tasks, rate-limit reset data, memory-write safety checks, and update notices, so the app can avoid wasted quota and show useful maintenance information.

## Files in this stage

### Cloud config loading
These files define the public cloud-config surface, the backend fetch adapter, the bundle lifecycle service, and the integrated loader used at startup.

### `cloud-config/src/lib.rs`

`config` · `config load and refresh`

This file is like the reception desk for the cloud configuration part of Codex. The crate as a whole is responsible for getting configuration data from the cloud, storing a local copy, refreshing it, recording metrics, and checking that the data is valid. This top-level file does not do those jobs directly. Instead, it declares the internal modules that contain that work: backend communication, bundle loading, caching, metrics, service behavior, and validation.

The important design choice here is separation. This crate owns the delivery side of cloud configuration: transport, caching, and refresh timing. The actual understanding and combining of configuration values stays in another crate, `codex-config`. In plain terms, this crate fetches and keeps the package fresh; another part of the system opens the package and decides what it means.

Only two items are made public: `cloud_config_bundle_loader` and `cloud_config_bundle_loader_for_storage`. Those are the main entry points other code is expected to use when it wants cloud configuration bundles. Everything else remains private, which helps keep the rest of the codebase from depending on internal details that may change.


### `cloud-config/src/backend.rs`

`io_transport` · `cloud config load`

This file exists so the cloud config loader does not need to know the details of talking to the backend. Think of it like a delivery desk: the rest of the app asks for “the current cloud config bundle,” and this file deals with finding the right courier, making the request, and unpacking the parcel into the format the app expects.

The main piece is `BackendBundleClient`, which stores the backend base URL. When asked for a bundle, it first builds a backend client using the user’s `CodexAuth` authentication information. If that client cannot be built, the error is marked as retryable because it may be a temporary setup or network-related problem.

It then calls the backend to fetch the config bundle. If the backend says the user is unauthorized, this file returns a special unauthorized error with the HTTP status code and message. Other request failures are marked retryable, along with any status code that came back.

When a response succeeds, `bundle_from_response` converts the backend response into a `CloudConfigBundle`. It deliberately does not validate or interpret the TOML text. TOML is a configuration file format; here the text is simply carried forward. Validation, caching, and parsing are left to higher layers.

#### Function details

##### `RetryableFailureKind::status_code`  (lines 19–24)

```
fn status_code(self) -> Option<u16>
```

**Purpose**: This function extracts the HTTP status code, if there is one, from a retryable failure. It lets retry logic make decisions based on whether the backend returned a specific web status, such as a server error.

**Data flow**: It takes a `RetryableFailureKind`. If the failure happened while building the backend client, there is no HTTP response, so it returns nothing. If the failure happened during a request, it returns the stored status code, which may also be absent if the request failed before a response arrived.

**Call relations**: This is used by `retry_after_request_failure`, which is part of the retry decision flow. After this file has labeled a backend problem as retryable, that later logic asks for the status code so it can decide how and when to try again.

*Call graph*: called by 1 (retry_after_request_failure).


##### `BackendBundleClient::new`  (lines 52–54)

```
fn new(base_url: String) -> Self
```

**Purpose**: This creates a `BackendBundleClient` for a particular backend address. Someone uses it when they want a reusable object that knows where to fetch cloud config bundles from.

**Data flow**: It receives a base URL as text. It stores that URL inside a new `BackendBundleClient`. The result is a client object ready to be given authentication details later when an actual request is made.

**Call relations**: This is called by `cloud_config_bundle_loader` during setup of the cloud config loading path. The loader creates this backend-facing client once, then later calls on it to fetch bundles.

*Call graph*: called by 1 (cloud_config_bundle_loader).


##### `BackendBundleClient::get_bundle`  (lines 58–87)

```
async fn get_bundle(&self, auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: This asks the backend service for one cloud config bundle using the current user’s authentication. It also translates backend and network failures into clear categories that the rest of the cloud config system can understand.

**Data flow**: It receives authentication information. First it tries to create a backend client from the stored base URL and that authentication. If that fails, it logs a warning and returns a retryable initialization error. If client creation succeeds, it sends a request for the config bundle. A successful response is passed to `bundle_from_response` and returned as an internal `CloudConfigBundle`. An unauthorized response becomes an unauthorized error with a status code and message. Other request failures become retryable request errors, optionally carrying the HTTP status code.

**Call relations**: This is the main action behind the `BundleClient` interface. Higher-level cloud config code calls it when it needs the latest backend-selected bundle. Inside, it hands authentication to the external `from_auth` constructor to build the backend client, then hands a successful backend response to `bundle_from_response` so the raw reply becomes the internal bundle type.

*Call graph*: calls 1 internal fn (bundle_from_response); 1 external calls (from_auth).


##### `bundle_from_response`  (lines 90–118)

```
fn bundle_from_response(response: ConfigBundleResponse) -> CloudConfigBundle
```

**Purpose**: This converts the backend’s bundle response into the internal cloud config bundle used by the rest of the project. It keeps the delivered fragments as-is and only reshapes them into local types.

**Data flow**: It receives a `ConfigBundleResponse` from the backend. It looks for delivered config TOML fragments and requirement TOML fragments under the enterprise-managed sections. If those sections are missing, it treats them as empty lists. Each delivered fragment is converted into the matching internal fragment type, and the function returns a `CloudConfigBundle` containing both converted lists.

**Call relations**: This is called after `BackendBundleClient::get_bundle` receives a successful backend response. It does the unpacking step, while `get_bundle` stays responsible for networking and error classification.

*Call graph*: called by 1 (get_bundle).


##### `config_fragment_from_delivered`  (lines 120–126)

```
fn config_fragment_from_delivered(fragment: DeliveredTomlFragment) -> CloudConfigFragment
```

**Purpose**: This turns one backend-delivered TOML fragment into the internal type used for cloud configuration fragments. It preserves the fragment’s identity, display name, and text contents.

**Data flow**: It receives a delivered fragment with an id, name, and contents. It copies those three pieces into a `CloudConfigFragment`. The output is the same information, but in the type expected by the cloud config layer.

**Call relations**: This is used as part of the conversion work inside `bundle_from_response`. For each config fragment from the backend, this helper performs the small shape change needed before the bundle is returned upward.


##### `requirements_fragment_from_delivered`  (lines 128–136)

```
fn requirements_fragment_from_delivered(
    fragment: DeliveredTomlFragment,
) -> CloudRequirementsFragment
```

**Purpose**: This turns one backend-delivered TOML fragment into the internal type used for cloud requirements fragments. It preserves the fragment’s identity, display name, and text contents.

**Data flow**: It receives a delivered fragment with an id, name, and contents. It copies those fields into a `CloudRequirementsFragment`. The output contains the same raw TOML text and metadata, now in the requirements-specific internal type.

**Call relations**: This is used during `bundle_from_response` when converting the backend’s requirements section. It is the requirements-side twin of the config fragment converter.


### `cloud-config/src/service.rs`

`orchestration` · `startup and background refresh`

A cloud config bundle is a set of workspace-managed policy settings that can change how the app should behave. This file is the coordinator for that bundle’s lifecycle. At startup, it checks whether the current signed-in user is allowed to use cloud-managed config. If not, it returns no bundle and the app continues normally. If the user is eligible, it tries to use a local cached copy, but only if the cache matches the same user/account and passes validation. This is like checking whether a sealed envelope is addressed to the current person and has not been tampered with before opening it.

If the cache is missing or invalid, the service asks the backend for a fresh bundle. It retries temporary failures, waits between retries using backoff, and has special handling for unauthorized responses: it may try to refresh the user’s authentication and then retry the request. Once a remote bundle arrives, it validates it, saves it to cache, records metrics, and returns it unless it is empty.

A key behavior is that startup takes a snapshot: once the app has loaded its runtime config, later background refreshes only warm the cache for next time. They do not silently change the already-running configuration.

#### Function details

##### `auth_identity`  (lines 43–45)

```
fn auth_identity(auth: &CodexAuth) -> (Option<String>, Option<String>)
```

**Purpose**: This helper pulls out the two identity values used to decide whether a cached bundle belongs to the current signed-in user. It keeps user ID and account ID lookup in one place so cache reads and writes use the same identity information.

**Data flow**: It receives an authentication object. It reads the ChatGPT user ID and account ID from it. It returns those two values as optional strings, because either piece may be missing.

**Call relations**: During startup, the service calls this before looking in the cache so it can reject bundles saved for another identity. After a remote fetch succeeds, it is called again so the newly fetched bundle is saved under the same identity keys.

*Call graph*: calls 2 internal fn (get_account_id, get_chatgpt_user_id); called by 2 (load_startup_bundle, validate_and_cache_remote_bundle).


##### `cloud_config_eligible_auth`  (lines 47–54)

```
fn cloud_config_eligible_auth(auth: &CodexAuth) -> bool
```

**Purpose**: This helper answers one question: should this signed-in user even try to load workspace-managed cloud config? It prevents unnecessary backend calls for users or accounts that cannot use this feature.

**Data flow**: It receives an authentication object. It checks whether the auth is using the Codex backend and whether the account plan is a business-like, enterprise, or education plan. It returns true only when those conditions mean cloud config should apply.

**Call relations**: Startup uses this before cache or backend work begins. The background refresher uses it too, so it stops quietly when the current authentication is missing or no longer belongs to an eligible plan.

*Call graph*: calls 2 internal fn (account_plan_type, uses_codex_backend); called by 2 (load_startup_bundle, refresh_cache_once); 1 external calls (matches!).


##### `optional_bundle`  (lines 56–62)

```
fn optional_bundle(bundle: CloudConfigBundle) -> Option<CloudConfigBundle>
```

**Purpose**: This helper turns an empty bundle into no bundle. That lets the rest of the app treat “the backend had nothing to apply” as a clean, successful absence rather than as a real config object.

**Data flow**: It receives a cloud config bundle. It checks whether the bundle has any meaningful contents. It returns the bundle wrapped as present when it has content, or returns nothing when it is empty.

**Call relations**: Cache loading and remote fetching both pass their successfully validated bundle through this helper before handing it back. That keeps cached and freshly fetched empty responses behaving the same way.

*Call graph*: calls 1 internal fn (is_empty); called by 2 (load_valid_cached_bundle, validate_and_cache_remote_bundle).


##### `CloudConfigBundleService::clone`  (lines 83–91)

```
fn clone(&self) -> Self
```

**Purpose**: This creates another lightweight handle to the same service. It is useful when the same bundle-loading service needs to be shared between startup code and a background task.

**Data flow**: It reads the service’s shared authentication manager, shared backend client, cache object, home path, and timeout. It creates a new service value that points to the same shared pieces and copies the simple settings.

**Call relations**: This supports the larger flow by allowing the orchestrating service to be passed around safely. The cloned service still talks to the same auth manager and backend client, so cache loading and refresh behavior stay consistent.

*Call graph*: 3 external calls (clone, clone, clone).


##### `CloudConfigBundleService::new`  (lines 98–112)

```
fn new(
        auth_manager: Arc<AuthManager>,
        client: Arc<C>,
        codex_home: PathBuf,
        timeout: Duration,
    ) -> Self
```

**Purpose**: This builds a cloud config bundle service with all the parts it needs: authentication, a backend client, a cache location, and a timeout. It is the setup step before any bundle can be loaded or refreshed.

**Data flow**: It receives an authentication manager, a backend client, a path to the Codex home directory, and a timeout duration. It normalizes the home path, creates a cache tied to that location, and stores all of these pieces in a new service object.

**Call relations**: Higher-level loader code and tests create the service through this function. After construction, callers can ask it to load the startup bundle or run the background cache refresh loop.

*Call graph*: calls 2 internal fn (new, resolve_path_against_base); called by 19 (cloud_config_bundle_loader, get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_empty_response_is_success_and_cached, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_rejects_invalid_remote_bundle_before_cache_write, get_bundle_retries_until_success (+9 more)); 1 external calls (clone).


##### `CloudConfigBundleService::load_startup_bundle_with_timeout`  (lines 114–169)

```
async fn load_startup_bundle_with_timeout(
        &self,
    ) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>
```

**Purpose**: This is the safe startup entry for loading a bundle. It makes sure startup does not wait forever, records timing and success or failure metrics, and returns either a usable bundle, no bundle, or a clear load error.

**Data flow**: It starts a timer, notes the current time, and runs the real startup load inside a timeout. If time runs out, it logs and returns a timeout error. If loading finishes, it records whether a bundle was found and returns that result.

**Call relations**: This wraps the lower-level startup loader with guardrails. It calls the inner loading flow, then reports the final outcome for observability so operators can see whether startup bundle loading is succeeding, failing, or timing out.

*Call graph*: calls 2 internal fn (emit_load_metric, load_startup_bundle); 4 external calls (now, start_global_timer, timeout, info!).


##### `CloudConfigBundleService::load_startup_bundle`  (lines 171–194)

```
async fn load_startup_bundle(
        &self,
    ) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>
```

**Purpose**: This performs the actual startup decision tree for cloud config. It checks sign-in state and eligibility, prefers a valid cache entry, and only contacts the backend when the cache cannot be used.

**Data flow**: It asks the authentication manager for the current auth. If there is no auth or the account is not eligible, it returns no bundle. Otherwise it extracts identity values, checks the cache, and if that misses, fetches from the backend with retries.

**Call relations**: It is called by the timeout-protected startup wrapper. It delegates cache work to the cache-loading helper and remote work to the retrying fetch helper, forming the main startup path.

*Call graph*: calls 4 internal fn (fetch_remote_bundle_and_update_cache_with_retries, load_valid_cached_bundle, auth_identity, cloud_config_eligible_auth); called by 1 (load_startup_bundle_with_timeout).


##### `CloudConfigBundleService::load_valid_cached_bundle`  (lines 196–225)

```
async fn load_valid_cached_bundle(
        &self,
        chatgpt_user_id: Option<&str>,
        account_id: Option<&str>,
    ) -> CachedBundleLookup
```

**Purpose**: This tries to load a safe cached bundle for the current user. It rejects cache entries that are missing, belong to a different identity, or fail validation.

**Data flow**: It receives the current user and account identity values. It asks the cache to load a matching signed payload. If one is found, it validates the bundle against the local Codex home rules. A valid bundle becomes a cache hit; invalid or missing cache data becomes a miss.

**Call relations**: Startup calls this before making a remote request. If it returns a hit, startup can finish quickly without network access. If it returns a miss, startup moves on to backend fetching.

*Call graph*: calls 4 internal fn (load, log_load_status, optional_bundle, validate_bundle); called by 1 (load_startup_bundle); 3 external calls (Hit, info!, warn!).


##### `CloudConfigBundleService::fetch_remote_bundle_and_update_cache_with_retries`  (lines 227–298)

```
async fn fetch_remote_bundle_and_update_cache_with_retries(
        &self,
        mut auth: CodexAuth,
        trigger: &'static str,
    ) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadE
```

**Purpose**: This is the remote-fetch loop. It asks the backend for a bundle, retries temporary failures, tries authentication recovery when needed, and saves a valid result into the cache.

**Data flow**: It receives the current authentication and a label describing why the fetch is happening, such as startup or refresh. It repeatedly calls the backend until a request succeeds, a retry limit is reached, or an unrecoverable authentication problem happens. On success, it validates and caches the bundle; on final failure, it returns a load error.

**Call relations**: Both startup and background refresh use this same remote-fetch path. It hands successful responses to the validation-and-cache helper, temporary request failures to the retry helper, and unauthorized responses to the authentication recovery helper.

*Call graph*: calls 5 internal fn (emit_fetch_final_metric, handle_unauthorized, retry_after_request_failure, validate_and_cache_remote_bundle, new); called by 2 (load_startup_bundle, refresh_cache_once); 1 external calls (error!).


##### `CloudConfigBundleService::validate_and_cache_remote_bundle`  (lines 300–341)

```
async fn validate_and_cache_remote_bundle(
        &self,
        auth: &CodexAuth,
        trigger: &'static str,
        attempt: usize,
        bundle: CloudConfigBundle,
    ) -> Result<Option<Clo
```

**Purpose**: This turns a successful backend response into something the app can trust. It validates the bundle, saves it to the local cache if possible, records metrics, and returns the bundle unless it is empty.

**Data flow**: It receives the auth used for the request, the trigger label, the attempt number, and the fetched bundle. It records a successful request attempt, validates the bundle, saves a copy under the current identity, and returns either the bundle or no bundle if it has no contents. If validation fails, it returns an error instead.

**Call relations**: The remote-fetch loop calls this after the backend returns a bundle. This function is the handoff point between network success and usable local configuration: it decides whether the fetched data is trustworthy and cacheable.

*Call graph*: calls 6 internal fn (save, emit_fetch_attempt_metric, emit_fetch_final_metric, auth_identity, optional_bundle, validate_bundle); called by 1 (fetch_remote_bundle_and_update_cache_with_retries); 2 external calls (clone, warn!).


##### `CloudConfigBundleService::retry_after_request_failure`  (lines 343–363)

```
async fn retry_after_request_failure(
        &self,
        trigger: &'static str,
        attempt: usize,
        status: RetryableFailureKind,
    ) -> bool
```

**Purpose**: This handles temporary backend failures, such as retryable server or network-style errors. It records the failed attempt and decides whether to wait and try again.

**Data flow**: It receives the trigger label, the current attempt number, and the kind of retryable failure. It records the status, checks whether more attempts are allowed, and if so sleeps for a backoff delay. It returns true when the caller should retry, or false when the retry limit has been reached.

**Call relations**: The remote-fetch loop calls this whenever the backend reports a retryable failure. Its answer controls whether the loop continues or falls through to the final request-failed error.

*Call graph*: calls 3 internal fn (status_code, emit_fetch_attempt_metric, backoff); called by 1 (fetch_remote_bundle_and_update_cache_with_retries); 2 external calls (sleep, warn!).


##### `CloudConfigBundleService::handle_unauthorized`  (lines 365–455)

```
async fn handle_unauthorized(
        &self,
        auth: &mut CodexAuth,
        auth_recovery: &mut UnauthorizedRecovery,
        trigger: &'static str,
        attempt: usize,
        status_code:
```

**Purpose**: This handles the case where the backend says the current authentication is not accepted. It may refresh the user’s session and retry, or it may turn the problem into a clear authentication error.

**Data flow**: It receives the current auth by mutable reference, the auth-recovery state, the trigger label, attempt number, status code, and backend message. It records the unauthorized attempt. If recovery is available, it tries the next recovery step, updates the auth on success, waits and moves to the next attempt on temporary recovery failure, or returns an auth error on permanent failure. If no recovery is available, it returns an auth error.

**Call relations**: The remote-fetch loop calls this after an unauthorized backend response. The result tells the loop whether to retry immediately with refreshed auth, retry as the next counted attempt, or stop with an error.

*Call graph*: calls 6 internal fn (emit_fetch_attempt_metric, emit_fetch_final_metric, new, backoff, has_next, next); called by 1 (fetch_remote_bundle_and_update_cache_with_retries); 3 external calls (sleep, error!, warn!).


##### `CloudConfigBundleService::refresh_cache_in_background`  (lines 457–471)

```
async fn refresh_cache_in_background(&self)
```

**Purpose**: This runs a background loop that periodically refreshes the cached bundle. Its goal is to make future app starts faster and more up to date, without changing the current running config snapshot.

**Data flow**: It sleeps for the configured refresh interval, then runs one refresh attempt inside the service timeout. If the refresh succeeds or fails normally, it keeps going as long as refresh is still applicable. If there is no auth or the account is no longer eligible, it stops. If a refresh times out, it logs the problem and keeps the existing cache.

**Call relations**: This is the long-running background side of the service. Each cycle calls the one-shot refresh function, which reuses the same remote fetch and cache update path as startup.

*Call graph*: calls 2 internal fn (emit_load_metric, refresh_cache_once); 3 external calls (sleep, timeout, error!).


##### `CloudConfigBundleService::refresh_cache_once`  (lines 473–496)

```
async fn refresh_cache_once(&self) -> bool
```

**Purpose**: This performs one background cache refresh attempt. It checks whether refreshing still makes sense, fetches a fresh bundle if it does, and records the result.

**Data flow**: It asks for the current authentication. If there is no auth or the account is not eligible, it returns false to tell the background loop to stop. Otherwise it fetches a remote bundle with retries, saves it through that fetch path, emits a success or error metric, and returns true so the loop can continue later.

**Call relations**: The background loop calls this after each sleep interval. It reuses the main remote-fetch helper, so refreshes follow the same validation, retry, authentication recovery, and cache-writing rules as startup fetches.

*Call graph*: calls 3 internal fn (emit_load_metric, fetch_remote_bundle_and_update_cache_with_retries, cloud_config_eligible_auth); called by 1 (refresh_cache_in_background); 1 external calls (error!).


### `cloud-config/src/bundle_loader.rs`

`orchestration` · `startup and background refresh`

A cloud configuration bundle is a package of settings fetched from the service, then used by the rest of the program. This file is the bridge between “we need cloud config” and the lower-level pieces that know how to log in, call the backend, cache results, and retry in the background.

The main flow creates a CloudConfigBundleService with an authentication manager, a backend client, the local Codex home folder, and a timeout. It immediately starts one task to load the startup bundle, so callers can wait for that first result. It also starts another task that refreshes the cached bundle in the background. Think of this like opening a shop with yesterday’s price list ready, while someone quietly checks for today’s updated list.

One important detail is that the background refresher is stored in a single global slot protected by a mutex, which is a lock that stops two pieces of code from changing the slot at the same time. If a new loader is created, the old refresh task is aborted before the new one is saved. This prevents multiple refresh loops from piling up and doing duplicate work.

#### Function details

##### `refresher_task_slot`  (lines 16–19)

```
fn refresher_task_slot() -> &'static Mutex<Option<JoinHandle<()>>>
```

**Purpose**: This function provides access to the one shared place where the current background refresh task is remembered. It exists so the program can replace an old refresher when a new cloud config loader is created.

**Data flow**: It takes no input. The first time it is used, it creates a global slot containing no task yet, wrapped in a mutex lock. After that, it returns the same shared locked slot every time, so callers can inspect or replace the saved background task.

**Call relations**: cloud_config_bundle_loader calls this when it has just started a new background refresh task. The slot lets that function swap out any older refresher and abort it, keeping only one active background refresh loop.

*Call graph*: called by 1 (cloud_config_bundle_loader); 1 external calls (new).


##### `cloud_config_bundle_loader`  (lines 21–53)

```
fn cloud_config_bundle_loader(
    auth_manager: Arc<AuthManager>,
    chatgpt_base_url: String,
    codex_home: PathBuf,
) -> CloudConfigBundleLoader
```

**Purpose**: This function builds a CloudConfigBundleLoader from an existing authentication manager, backend URL, and Codex home folder. It starts the initial bundle load and starts a separate background cache refresher.

**Data flow**: It receives the authentication manager, the ChatGPT base URL, and the local Codex home path. It uses them to create a cloud config service, starts an asynchronous startup-load task, and starts another asynchronous task for background refresh. It saves the refresh task in the shared slot, aborting any older one, then returns a loader that waits for the startup task and turns task failures into a clear CloudConfigBundleLoadError.

**Call relations**: cloud_config_bundle_loader_for_storage calls this after it has created the authentication manager. Inside this function, the service is handed to spawned asynchronous tasks: one produces the bundle result the loader will return, and the other keeps refreshing the cache in the background. It also calls refresher_task_slot to coordinate that background refresher globally.

*Call graph*: calls 4 internal fn (new, refresher_task_slot, new, new); called by 1 (cloud_config_bundle_loader_for_storage); 2 external calls (new, spawn).


##### `cloud_config_bundle_loader_for_storage`  (lines 55–71)

```
async fn cloud_config_bundle_loader_for_storage(
    codex_home: PathBuf,
    enable_codex_api_key_env: bool,
    credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyrin
```

**Purpose**: This convenience function creates the authentication manager first, then builds the cloud config bundle loader. It is useful when the caller has storage and login settings rather than a ready-made AuthManager.

**Data flow**: It receives the Codex home path, whether environment API keys are allowed, the credentials storage mode, the keyring backend kind, and the ChatGPT base URL. It uses those settings to create a shared AuthManager asynchronously. Then it passes that authentication manager, the URL, and the home path into cloud_config_bundle_loader and returns the resulting loader.

**Call relations**: This is the higher-level entry into this file’s setup flow. It calls AuthManager::shared to prepare authentication, then hands off to cloud_config_bundle_loader, which does the actual service construction and task spawning.

*Call graph*: calls 2 internal fn (cloud_config_bundle_loader, shared); 1 external calls (clone).


### Model catalog clients
These files cover remote and static model catalog sources plus the manager that turns them into usable model presets and metadata.

### `codex-api/src/endpoint/models.rs`

`io_transport` · `request handling`

This file is the small bridge between the application and the remote “models” API endpoint. The rest of the system needs to know which AI models exist, what features they support, and sometimes whether a cached model list is still current. Without this file, callers would have to build the URL, attach authentication, send the HTTP request, parse the JSON, and read cache headers themselves.

The main type is `ModelsClient`. It wraps an `EndpointSession`, which is the shared request-making machinery for an API provider. Think of `EndpointSession` as the prepared envelope: it knows the base address, default headers, authentication, retry behavior, and optional telemetry. `ModelsClient` only fills in the part specific to model listing.

When `list_models` runs, it sends a GET request to the `models` path. Before the request goes out, it appends `client_version=...` to the URL. That lets the server tailor the model list to what this client version understands. After the response comes back, it reads the `ETag` header, if present. An ETag is like a fingerprint for a response, useful for caching. Then it decodes the response body from JSON into `ModelsResponse` and returns the list of models plus the optional ETag.

The test-only code creates a fake transport and fake authentication provider so the tests can check URL building, JSON parsing, and ETag extraction without making real network calls.

#### Function details

##### `ModelsClient::new`  (lines 19–23)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a `ModelsClient` ready to talk to a specific provider using a given HTTP transport and authentication provider. Someone uses this when they want a reusable object for fetching model lists.

**Data flow**: It receives a transport for sending requests, a provider description with the API base URL and settings, and shared authentication. It puts those into a new `EndpointSession`, then stores that session inside the client. The result is a configured `ModelsClient`.

**Call relations**: This is the setup step before model requests can happen. The tests call it to build clients around fake transports, and other model-listing flows call it before using `list_models`.

*Call graph*: calls 1 internal fn (new); called by 5 (appends_client_version_query, list_models_includes_etag, parses_models_response, models_client_hits_models_endpoint, list_models).


##### `ModelsClient::with_telemetry`  (lines 25–29)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client that records optional request telemetry. Telemetry here means extra observation data about requests, such as timing or tracing, without changing the API call itself.

**Data flow**: It takes an existing client and an optional telemetry object. It passes that telemetry object into the underlying session and returns a new `ModelsClient` containing the updated session. The original session setup is otherwise preserved.

**Call relations**: This function is used after construction when a caller wants model requests to participate in the project’s request-observation system. It delegates the actual telemetry attachment to the session.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `ModelsClient::path`  (lines 31–33)

```
fn path() -> &'static str
```

**Purpose**: Provides the fixed endpoint path for listing models. It keeps the string `models` in one place so request code does not repeat it.

**Data flow**: It takes no input. It simply returns the static path string used to build the final request URL.

**Call relations**: `list_models` calls this when asking the session to execute the request. It is the small piece that says which API endpoint this client targets.


##### `ModelsClient::append_client_version_query`  (lines 35–38)

```
fn append_client_version_query(req: &mut codex_client::Request, client_version: &str)
```

**Purpose**: Adds the client version to a request URL as a query parameter. This matters because the server may need to know the client’s version before deciding which models or features to return.

**Data flow**: It receives a mutable request and a client version string. It checks whether the URL already has query parameters, chooses `?` or `&` accordingly, and rewrites the URL with `client_version=...` appended. The changed request is the output.

**Call relations**: `list_models` supplies this function as the final tweak before sending the request. It does not send anything itself; it just prepares the URL for the session’s request executor.

*Call graph*: 1 external calls (format!).


##### `ModelsClient::list_models`  (lines 40–73)

```
async fn list_models(
        &self,
        client_version: &str,
        extra_headers: HeaderMap,
    ) -> Result<(Vec<ModelInfo>, Option<String>), ApiError>
```

**Purpose**: Fetches the list of available models from the API and returns them in a structured form. It also returns an optional ETag, which callers can use as a cache fingerprint.

**Data flow**: It receives the caller’s client version and any extra HTTP headers. It asks the session to send a GET request to the `models` endpoint, while adding the client version to the URL. When the response arrives, it reads the ETag header if one exists, decodes the JSON body into a model list, and returns the models together with the ETag. If the JSON cannot be decoded, it returns an API error that includes the bad body text for debugging.

**Call relations**: This is the main public action in the file. Callers use it after creating a `ModelsClient`. Internally it relies on `path` for the endpoint name, `append_client_version_query` for URL adjustment, and the shared session for the actual HTTP work.

*Call graph*: calls 1 internal fn (execute_with); 1 external calls (path).


##### `tests::CapturingTransport::default`  (lines 101–107)

```
fn default() -> Self
```

**Purpose**: Builds a default fake HTTP transport for tests. It starts with no recorded request, an empty model response, and no ETag.

**Data flow**: It takes no input. It creates shared storage for the last request, creates an empty `ModelsResponse`, leaves the ETag unset, and returns a `CapturingTransport` containing those pieces.

**Call relations**: This is test support code. Tests can use it when they need a simple fake network layer without writing all the fields by hand.

*Call graph*: 3 external calls (new, new, new).


##### `tests::CapturingTransport::execute`  (lines 111–123)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Pretends to send an HTTP request during tests, while saving the request so the test can inspect it later. It returns a controlled successful response instead of touching the network.

**Data flow**: It receives a request. It stores that request in shared test storage, converts the configured fake `ModelsResponse` into JSON bytes, optionally adds an ETag header, and returns an HTTP 200 response with that body. This changes the stored `last_request` value.

**Call relations**: The real client calls this through the `HttpTransport` interface when `list_models` runs in tests. It lets tests verify what URL the client built and what it does with a known response.

*Call graph*: 2 external calls (new, to_vec).


##### `tests::CapturingTransport::stream`  (lines 125–127)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Rejects streaming requests in tests because the models endpoint should not use streaming. If this function is reached, the test setup has detected the wrong kind of request.

**Data flow**: It receives a request but ignores it. It immediately returns a transport build error saying that streaming should not run.

**Call relations**: This completes the fake transport interface required by the client library. The model-listing path should call `execute`, not `stream`, so this function acts like a guardrail in tests.

*Call graph*: 1 external calls (Build).


##### `tests::DummyAuth::add_auth_headers`  (lines 134–134)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Provides a no-op authentication provider for tests. It satisfies the client’s need for an auth object without adding real credentials.

**Data flow**: It receives mutable HTTP headers but does not change them. The headers come out exactly as they went in.

**Call relations**: Tests pass `DummyAuth` into `ModelsClient::new` so the normal request setup can run without depending on real authentication.


##### `tests::provider`  (lines 137–152)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Creates a test `Provider` configuration with a chosen base URL and short retry/time-out settings. This gives tests a realistic provider object without using production configuration.

**Data flow**: It receives a base URL string. It builds a `Provider` named `test`, copies in the base URL, uses empty headers, disables some retry behavior, and sets very short timing values. The result is a provider ready for a test client.

**Call relations**: The test cases call this before constructing `ModelsClient`. It supplies the provider settings that the underlying session uses to build request URLs.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::appends_client_version_query`  (lines 155–189)

```
async fn appends_client_version_query()
```

**Purpose**: Checks that `list_models` adds the `client_version` query parameter to the models URL. This protects the behavior that tells the server which client version is asking.

**Data flow**: It builds an empty fake models response, a capturing transport, and a client pointed at a test base URL. It calls `list_models` with version `0.99.0`, then reads the saved request from the fake transport and compares its URL to the expected URL. The test succeeds if the model list is empty and the URL includes the client version correctly.

**Call relations**: This test drives the public `list_models` method through a fake transport. In doing so, it indirectly exercises `ModelsClient::new`, `provider`, and the URL-editing helper used inside `list_models`.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, new, new, assert_eq!, provider).


##### `tests::parses_models_response`  (lines 192–243)

```
async fn parses_models_response()
```

**Purpose**: Checks that a JSON models response is decoded into usable model information. It makes sure important fields such as the model slug, API support flag, and priority survive the round trip.

**Data flow**: It builds a fake response containing one detailed model entry, wraps it in a capturing transport, and creates a client. It calls `list_models`, receives the parsed model list, and asserts that one model came back with the expected values.

**Call relations**: This test uses the same public path a real caller would use: construct the client, call `list_models`, and inspect the result. The fake transport supplies known JSON so the test focuses on response decoding.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, new, assert_eq!, provider, vec!).


##### `tests::list_models_includes_etag`  (lines 246–268)

```
async fn list_models_includes_etag()
```

**Purpose**: Checks that `list_models` returns the ETag header when the server provides one. This matters for caching, because callers may use that value to know whether a model list has changed.

**Data flow**: It builds an empty fake models response with an ETag value, creates a client, and calls `list_models`. It then checks that the returned model list is empty and that the ETag output matches the fake header.

**Call relations**: This test drives `list_models` through the capturing transport, just like a real request but without the network. It specifically verifies the header-reading part of the bigger model-listing flow.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, new, new, assert_eq!, provider).


### `model-provider/src/models_endpoint.rs`

`io_transport` · `model refresh / request handling`

This file is the bridge between the models manager and a provider’s `/models` web endpoint. In plain terms, it is the part that says: “Given this provider and whatever login information we have, fetch the current list of models, but do not hang forever, and leave useful breadcrumbs if something goes wrong.”

The main type, `OpenAiModelsEndpoint`, stores two things: information about the provider, such as its base URL and authentication style, and an optional authentication manager that can supply saved login credentials. When asked for models, it gathers the current auth, turns the provider settings into the API client format, resolves the right auth header or token, builds an HTTP client, and calls `/models`. The request is capped at five seconds so a slow or unreachable provider cannot stall the refresh process.

The file also defines `ModelsRequestTelemetry`, which is like a receipt printer for each API attempt. It records whether an auth header was attached, which environment variables were present, the status code, request IDs, and auth-related error details. That information is sent both to tracing logs and feedback tags. Without this file, the system would not have a provider-owned way to refresh model lists, and auth problems during model discovery would be much harder to diagnose.

#### Function details

##### `OpenAiModelsEndpoint::new`  (lines 42–50)

```
fn new(
        provider_info: ModelProviderInfo,
        auth_manager: Option<Arc<AuthManager>>,
    ) -> Self
```

**Purpose**: Creates a new endpoint object for one model provider. It packages the provider’s settings together with optional login support so later calls can fetch models from the right place.

**Data flow**: It receives provider information and possibly an authentication manager. It stores both values inside a new `OpenAiModelsEndpoint` and returns that object. Nothing is sent over the network at this point.

**Call relations**: The models manager uses this when it needs an endpoint client for a provider. The tests also use it to build small example endpoints and check how command-based authentication is reported.

*Call graph*: called by 3 (command_auth_provider_reports_command_auth_without_cached_auth, provider_without_command_auth_reports_no_command_auth, models_manager).


##### `OpenAiModelsEndpoint::auth`  (lines 52–57)

```
async fn auth(&self) -> Option<CodexAuth>
```

**Purpose**: Gets the current Codex authentication, if an authentication manager exists. This lets later code decide whether to use Codex-backed auth or provider-specific auth.

**Data flow**: It looks at the endpoint’s optional auth manager. If one is present, it asks it asynchronously for the current auth; if not, it returns nothing. The output is either authentication data or `None`.

**Call relations**: Model listing calls this before building the API request. The backend-checking path also calls it to answer whether this endpoint is using the Codex backend.

*Call graph*: called by 2 (list_models, uses_codex_backend).


##### `OpenAiModelsEndpoint::auth_env`  (lines 96–102)

```
fn auth_env(&self) -> AuthEnvTelemetry
```

**Purpose**: Collects a safe summary of authentication-related environment variables. This is used for telemetry, so developers can tell which auth sources were available without logging secrets.

**Data flow**: It reads whether the auth manager allows the `CODEX_API_KEY` environment variable, then combines that with the provider information. It returns an `AuthEnvTelemetry` summary, such as whether expected key variables are present.

**Call relations**: The model-listing flow calls this while building request telemetry. It delegates the actual environment inspection to `collect_auth_env_telemetry`.

*Call graph*: called by 1 (list_models); 1 external calls (collect_auth_env_telemetry).


##### `OpenAiModelsEndpoint::has_command_auth`  (lines 106–108)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Answers whether this provider is configured to obtain auth by running a command, such as a token-printing helper. This matters because command auth can exist even when no cached login is available.

**Data flow**: It reads the provider configuration and asks whether command authentication is present. It returns a simple true or false and does not change anything.

**Call relations**: This is part of the `ModelsEndpointClient` interface used by the models manager. The tests call it to confirm providers with and without command auth are reported correctly.

*Call graph*: calls 1 internal fn (has_command_auth).


##### `OpenAiModelsEndpoint::uses_codex_backend`  (lines 110–112)

```
fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool>
```

**Purpose**: Checks whether the endpoint’s current authentication points at the Codex backend. This helps the caller understand which service path is being used.

**Data flow**: It asks for the current auth. If auth exists, it checks the auth object’s backend setting; if there is no auth, it returns false. Through the trait interface, the asynchronous work is boxed into a future, which is a promise of a value that will be available later.

**Call relations**: The models manager calls this through the `ModelsEndpointClient` interface. Internally it relies on `OpenAiModelsEndpoint::auth` to get the current login state.

*Call graph*: calls 1 internal fn (auth); 1 external calls (pin).


##### `OpenAiModelsEndpoint::list_models`  (lines 114–119)

```
fn list_models(
        &'a self,
        client_version: &'a str,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>>
```

**Purpose**: Fetches the provider’s current model list from the OpenAI-compatible `/models` endpoint. It also attaches the right authentication, enforces a short timeout, and records telemetry for the request.

**Data flow**: It starts with the endpoint’s provider settings and the caller’s client version. It gets current auth, converts provider settings into API-client settings, resolves the auth credentials, builds an HTTP transport, prepares telemetry, and calls the remote `/models` endpoint. The result is either a list of `ModelInfo` records plus an optional extra string, or a Codex error such as a timeout or mapped API error.

**Call relations**: The models manager calls this through the `ModelsEndpointClient` trait when it needs to refresh available models. During the flow it calls `auth`, `auth_env`, HTTP client construction, provider conversion, auth resolution, and the lower-level `ModelsClient`; the trait-facing method boxes this asynchronous operation so callers can use it uniformly.

*Call graph*: calls 6 internal fn (new, new, build_reqwest_client, to_api_provider, auth, auth_env); 7 external calls (new, pin, new, auth_header_telemetry, start_global_timer, resolve_provider_auth, timeout).


##### `ModelsRequestTelemetry::on_request`  (lines 131–211)

```
fn on_request(
        &self,
        attempt: u64,
        status: Option<http::StatusCode>,
        error: Option<&TransportError>,
        duration: Duration,
    )
```

**Purpose**: Records what happened during one `/models` API attempt. It captures success or failure, timing, status code, auth context, and selected response debug details without exposing secret values.

**Data flow**: It receives the attempt number, optional HTTP status, optional transport error, and request duration. It turns those into a success flag, a readable error message, response debug fields such as request ID, and auth environment fields. It then writes tracing events and emits feedback tags; it does not return a value.

**Call relations**: The API client calls this callback when a `/models` request attempt finishes. It hands the collected facts to tracing and feedback systems through logging events and `emit_feedback_request_tags_with_auth_env`.

*Call graph*: 2 external calls (emit_feedback_request_tags_with_auth_env, event!).


##### `tests::provider_info_with_command_auth`  (lines 221–236)

```
fn provider_info_with_command_auth() -> ModelProviderInfo
```

**Purpose**: Builds a test provider configuration that uses command-based authentication. It gives the tests a realistic provider setup without needing a real external service.

**Data flow**: It starts from a standard OpenAI provider configuration, adds a fake command named `print-token`, sets timing values and a working directory, and returns the completed `ModelProviderInfo`.

**Call relations**: The command-auth test calls this helper before constructing an `OpenAiModelsEndpoint`. It uses provider creation and current-directory lookup to make the test configuration valid.

*Call graph*: calls 1 internal fn (create_openai_provider); 3 external calls (new, new, current_dir).


##### `tests::command_auth_provider_reports_command_auth_without_cached_auth`  (lines 239–246)

```
fn command_auth_provider_reports_command_auth_without_cached_auth()
```

**Purpose**: Checks that a provider configured with command auth reports that fact even when there is no auth manager. This protects the case where authentication will come from running a command, not from cached login data.

**Data flow**: It creates command-auth provider info, builds an endpoint with no auth manager, calls `has_command_auth`, and asserts that the answer is true.

**Call relations**: This test uses `tests::provider_info_with_command_auth` and `OpenAiModelsEndpoint::new`, then exercises the trait method that the models manager depends on.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, provider_info_with_command_auth).


##### `tests::provider_without_command_auth_reports_no_command_auth`  (lines 249–256)

```
fn provider_without_command_auth_reports_no_command_auth()
```

**Purpose**: Checks that a normal OpenAI provider without command auth does not falsely report command auth. This prevents the models manager from assuming a token command exists when it does not.

**Data flow**: It creates a default OpenAI provider, builds an endpoint with no auth manager, calls `has_command_auth`, and asserts that the answer is false.

**Call relations**: This test uses `ModelProviderInfo::create_openai_provider` and `OpenAiModelsEndpoint::new`, then verifies the same command-auth reporting path used by the models manager.

*Call graph*: calls 2 internal fn (create_openai_provider, new); 1 external calls (assert!).


### `model-provider/src/amazon_bedrock/catalog.rs`

`config` · `provider catalog setup`

The system already has bundled information about OpenAI model names, limits, and settings. Amazon Bedrock offers some of those same GPT models, but under different provider-specific IDs and with different context-window limits. This file acts like a small translation table: it starts from the known OpenAI model entry, swaps in the Bedrock model ID, adjusts the priority and context size, and removes service-tier choices that Bedrock does not support.

The main public piece is `static_model_catalog`, which returns a `ModelsResponse`, meaning a structured list of available models. It currently includes GPT-5.5 and GPT-5.4 for Bedrock. Each entry is created by `gpt_5_bedrock_model`, which copies the base model data from the bundled catalog and then changes the parts that differ for Bedrock.

One important detail is service tiers. Some providers may let callers request faster or special tiers. Bedrock GPT models here only have the implicit default tier, so `with_default_only_service_tier` clears all explicit tier lists and leaves no named default. Think of it like a restaurant menu where the “size options” section is removed because there is only one standard serving.

The tests protect the contract: the exposed slugs must be Bedrock IDs, the context window must match Bedrock’s limit, and no non-default service tier can be selected.

#### Function details

##### `static_model_catalog`  (lines 11–26)

```
fn static_model_catalog() -> ModelsResponse
```

**Purpose**: Builds the fixed Amazon Bedrock model catalog used by this provider. It lists the Bedrock-backed GPT models the system should advertise and then strips out unsupported service-tier options.

**Data flow**: It starts with two known OpenAI-facing model names and their matching Amazon Bedrock model IDs. It creates model records for GPT-5.5 and GPT-5.4, puts them into a model-list response, passes that response through the service-tier cleanup step, and returns the finished catalog.

**Call relations**: This is the top-level catalog builder in the file. The tests call it to check that the catalog has the right Bedrock IDs, context-window values, and service-tier behavior. During construction it hands the finished list to `with_default_only_service_tier` so the returned catalog matches Bedrock’s current capabilities.

*Call graph*: calls 1 internal fn (with_default_only_service_tier); called by 3 (catalog_uses_mantle_model_ids_as_slugs, gpt_5_bedrock_models_only_allow_default_service_tier, gpt_5_bedrock_models_use_bedrock_context_window); 1 external calls (vec!).


##### `with_default_only_service_tier`  (lines 28–36)

```
fn with_default_only_service_tier(mut catalog: ModelsResponse) -> ModelsResponse
```

**Purpose**: Removes all explicit service-tier choices from every model in a catalog. This is needed because Amazon Bedrock currently only supports the ordinary default behavior for these GPT models, not named tiers like a faster or priority lane.

**Data flow**: It receives a model catalog, walks through each model inside it, clears the lists of extra speed tiers and service tiers, removes the named default tier, and returns the same catalog with those tier settings erased.

**Call relations**: `static_model_catalog` calls this after assembling the Bedrock model list. Its job is the final cleanup pass before the catalog is returned to callers, making sure later request logic cannot select a service tier that Bedrock does not understand.

*Call graph*: called by 1 (static_model_catalog).


##### `gpt_5_bedrock_model`  (lines 38–45)

```
fn gpt_5_bedrock_model(openai_slug: &str, bedrock_slug: &str, priority: i32) -> ModelInfo
```

**Purpose**: Creates one Bedrock-specific GPT model entry from an existing bundled OpenAI model entry. It keeps the shared model metadata but replaces the public model ID with the Bedrock ID and applies Bedrock-specific limits.

**Data flow**: It takes an OpenAI-style model slug, the matching Bedrock slug, and a priority number. It loads the bundled OpenAI model record, changes its slug to the Bedrock model ID, sets its ordering priority, sets both context-window fields to the Bedrock limit, and returns the adjusted model record.

**Call relations**: `static_model_catalog` uses this helper for each model it wants to include. This helper relies on `bundled_openai_model` to fetch the base model information before it makes the Bedrock-specific edits.

*Call graph*: calls 1 internal fn (bundled_openai_model).


##### `bundled_openai_model`  (lines 47–54)

```
fn bundled_openai_model(slug: &str) -> ModelInfo
```

**Purpose**: Looks up one model by slug in the project’s bundled model data. It is used as the source template before creating a Bedrock-specific model entry.

**Data flow**: It receives a model slug, loads the bundled models response from the embedded model data, searches through the models for a matching slug, and returns that model. If the bundled data cannot be parsed or the requested model is missing, it stops with a clear panic message, because this file assumes those bundled definitions are part of the application’s built-in data.

**Call relations**: `gpt_5_bedrock_model` calls this whenever it needs the standard model information for GPT-5.5 or GPT-5.4. It hands back the base record that the Bedrock helper then rewrites for Amazon Bedrock.

*Call graph*: called by 1 (gpt_5_bedrock_model); 1 external calls (bundled_models_response).


##### `tests::catalog_uses_mantle_model_ids_as_slugs`  (lines 64–70)

```
fn catalog_uses_mantle_model_ids_as_slugs()
```

**Purpose**: Checks that the Bedrock catalog exposes Amazon Bedrock model IDs as the model slugs. This matters because callers of the Bedrock provider must send Bedrock’s own identifiers, not the OpenAI-style names.

**Data flow**: It builds the static catalog, checks that there are exactly two models, and compares each model’s slug against the expected Bedrock model ID constants. The output is only the test result: pass if the IDs match, fail if they do not.

**Call relations**: This test calls `static_model_catalog` as a real caller would and verifies one of its most important translation jobs: replacing OpenAI-facing names with Bedrock-facing names.

*Call graph*: calls 1 internal fn (static_model_catalog); 1 external calls (assert_eq!).


##### `tests::gpt_5_bedrock_models_use_bedrock_context_window`  (lines 73–100)

```
fn gpt_5_bedrock_models_use_bedrock_context_window()
```

**Purpose**: Checks that both Bedrock GPT models use the Bedrock-specific context-window size. A context window is the amount of text the model can consider at once, so using the wrong value could make the system send requests that are too large or be overly restrictive.

**Data flow**: It builds the catalog, finds the GPT-5.5 and GPT-5.4 entries by their Bedrock IDs, and compares each model’s context-window fields with the expected Bedrock limit. The test passes only if both models have the right normal and maximum context sizes.

**Call relations**: This test exercises the catalog produced by `static_model_catalog`, indirectly checking the edits made by `gpt_5_bedrock_model` when it overwrites the context-window values.

*Call graph*: calls 1 internal fn (static_model_catalog); 1 external calls (assert_eq!).


##### `tests::gpt_5_bedrock_models_only_allow_default_service_tier`  (lines 103–120)

```
fn gpt_5_bedrock_models_only_allow_default_service_tier()
```

**Purpose**: Checks that Bedrock GPT models do not advertise or accept named service tiers. This prevents the rest of the system from thinking it can request a special tier that Bedrock does not support here.

**Data flow**: It builds the catalog, then inspects every model. For each one, it confirms that tier lists are empty, there is no named default tier, and asking for either a priority tier or the normal default request value produces no explicit tier selection.

**Call relations**: This test calls `static_model_catalog` and verifies the effect of `with_default_only_service_tier`. It protects the assumption that Bedrock catalog entries should behave as default-only models.

*Call graph*: calls 1 internal fn (static_model_catalog); 1 external calls (assert_eq!).


### `models-manager/src/manager.rs`

`orchestration` · `startup, model picker loading, session setup, and cache refresh`

This file is the model catalog coordinator. A model catalog is the app’s menu of available AI models, plus details like which one should be shown by default and which login types may use it. Without this file, the app would not have one reliable place to answer questions like “what models can this user pick?”, “what is the default model?”, or “should we refresh the list from the provider?”

It defines a shared `ModelsManager` interface with two implementations. `OpenAiModelsManager` can talk to a remote OpenAI-compatible endpoint, use a disk cache, and fall back to bundled model information. `StaticModelsManager` simply uses a catalog already supplied in memory, which is useful when another part of the system is the source of truth.

The main flow is: choose a refresh strategy, load models from cache or network if allowed, merge or replace the in-memory list, then turn raw model records into picker-ready presets. The file also filters models based on authentication, because some models are only valid for certain account types. Think of it like a restaurant menu manager: it keeps a printed backup menu, checks for a fresh online menu when appropriate, remembers the latest copy, and only shows each diner the items they are allowed to order. It also uses an ETag, a server-provided version label, to avoid unnecessary refresh work when the catalog has not changed.

#### Function details

##### `RefreshStrategy::as_str`  (lines 61–67)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns a refresh strategy into a short readable label such as `online` or `offline`. This is used when the strategy needs to be printed or recorded in logs.

**Data flow**: It receives one refresh strategy value. It matches that value to its fixed text name. It returns that text without changing anything else.

**Call relations**: When `RefreshStrategy::fmt` needs to display the strategy, it asks this helper for the exact text to write.

*Call graph*: called by 1 (fmt).


##### `RefreshStrategy::fmt`  (lines 71–73)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a refresh strategy appears when converted to text. This makes logs and trace messages show a human-readable strategy name.

**Data flow**: It receives a strategy and a text formatter. It gets the strategy’s label from `RefreshStrategy::as_str`, writes that label into the formatter, and returns whether writing succeeded.

**Call relations**: This is used automatically by Rust formatting whenever code prints a refresh strategy, including the tracing spans created by model-listing operations.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `ModelsManager::list_models`  (lines 83–97)

```
fn list_models(
        &self,
        refresh_strategy: RefreshStrategy,
    ) -> ModelsManagerFuture<'_, Vec<ModelPreset>>
```

**Purpose**: Returns the list of models that should be shown to the user. It first gets the active raw catalog, then converts it into filtered, sorted, picker-ready presets.

**Data flow**: It receives a refresh strategy. It asks the manager for a raw catalog using that strategy, takes the catalog’s model records, sorts and filters them through `build_available_models`, and returns model presets ready for display.

**Call relations**: This is the common high-level path for model selection. `ModelsManager::get_default_model` calls it when no explicit model was provided, because the default must be chosen from the same list the user would see.

*Call graph*: calls 1 internal fn (build_available_models); called by 1 (get_default_model); 2 external calls (pin, info_span!).


##### `ModelsManager::build_available_models`  (lines 117–129)

```
fn build_available_models(&self, mut remote_models: Vec<ModelInfo>) -> Vec<ModelPreset>
```

**Purpose**: Converts raw model records into the final presets used by the model picker. It applies ordering, authentication rules, and default-model marking.

**Data flow**: It receives raw remote model records. It sorts them by priority, converts each one into a preset, checks whether the current authentication can use Codex-backend models, filters the presets accordingly, marks the visible default, and returns the cleaned list.

**Call relations**: `ModelsManager::list_models` uses this after loading a catalog. `ModelsManager::try_list_models` also uses it when building a list from whatever is already in memory.

*Call graph*: calls 2 internal fn (filter_by_auth, mark_default_by_picker_visibility); called by 2 (list_models, try_list_models).


##### `ModelsManager::try_list_models`  (lines 139–142)

```
fn try_list_models(&self) -> Result<Vec<ModelPreset>, TryLockError>
```

**Purpose**: Attempts to list models immediately without waiting for the internal model list lock. This is useful in places where blocking would be harmful.

**Data flow**: It tries to read the current in-memory remote models. If that read succeeds, it passes them to `build_available_models` and returns the presets. If the model list is busy, it returns a lock error instead of waiting.

**Call relations**: This is the non-blocking sibling of `list_models`. It relies on the manager’s `try_get_remote_models` method and then uses the same preset-building logic as the normal path.

*Call graph*: calls 1 internal fn (build_available_models).


##### `ModelsManager::get_default_model`  (lines 149–167)

```
fn get_default_model(
        &'a self,
        model: &'a Option<String>,
        refresh_strategy: RefreshStrategy,
    ) -> ModelsManagerFuture<'a, String>
```

**Purpose**: Chooses the model identifier the app should use for a session. If the caller already supplied a model, it respects that choice; otherwise it picks a default from the available models.

**Data flow**: It receives an optional model name and a refresh strategy. If the model name exists, it returns that string unchanged. If not, it lists available models and passes them to `default_model_from_available`, returning the selected model name or an empty string if none exist.

**Call relations**: This function sits on top of `list_models`. It is used when setup code needs one final model string to put into a session or request.

*Call graph*: calls 2 internal fn (list_models, default_model_from_available); 2 external calls (pin, info_span!).


##### `ModelsManager::get_model_info`  (lines 171–183)

```
fn get_model_info(
        &'a self,
        model: &'a str,
        config: &'a ModelsManagerConfig,
    ) -> ModelsManagerFuture<'a, ModelInfo>
```

**Purpose**: Looks up detailed metadata for one model name, including any remote overrides and local configuration changes. This gives the rest of the app a complete `ModelInfo` record even for custom or fallback model names.

**Data flow**: It receives a model name and model-manager configuration. It reads the current remote models, asks `construct_model_info_from_candidates` to find or build the best metadata record, applies configuration overrides through that helper, and returns the finished model information.

**Call relations**: Callers use this when they need more than the model name. It delegates the matching and fallback rules to `construct_model_info_from_candidates` so the lookup behavior is shared and testable.

*Call graph*: calls 1 internal fn (construct_model_info_from_candidates); 2 external calls (pin, info_span!).


##### `OpenAiModelsManager::new`  (lines 215–230)

```
fn new(
        codex_home: PathBuf,
        endpoint_client: Arc<dyn ModelsEndpointClient>,
        auth_manager: Option<Arc<AuthManager>>,
    ) -> Self
```

**Purpose**: Creates a model manager that can use a remote OpenAI-compatible model endpoint, a disk cache, and bundled fallback models. This is the main constructor for live provider-backed model discovery.

**Data flow**: It receives the Codex home folder, an endpoint client, and an optional authentication manager. It builds the path to `models_cache.json`, creates a cache manager with the default time-to-live, loads bundled model data as the starting in-memory catalog if possible, and returns a ready `OpenAiModelsManager`.

**Call relations**: Higher-level setup code calls this when building the project’s shared model manager. Later methods on the returned manager refresh from cache or network as needed.

*Call graph*: calls 2 internal fn (new, load_remote_models_from_file); called by 2 (models_manager, openai_manager_for_tests_with_auth); 2 external calls (join, new).


##### `StaticModelsManager::new`  (lines 235–240)

```
fn new(auth_manager: Option<Arc<AuthManager>>, model_catalog: ModelsResponse) -> Self
```

**Purpose**: Creates a model manager from a catalog that is already known and trusted. This avoids network and cache behavior when a fixed in-process model list should be used.

**Data flow**: It receives an optional authentication manager and a model catalog. It stores the catalog’s models and the authentication manager, then returns a `StaticModelsManager`.

**Call relations**: Several setup and test paths use this when they want predictable model data. Its later methods read directly from this stored catalog.

*Call graph*: called by 5 (guardian_request_model_for_auto_review, models_manager, models_manager, static_manager_for_tests, static_manager_reads_latest_auth_mode).


##### `OpenAiModelsManager::get_remote_models`  (lines 254–256)

```
fn get_remote_models(&self) -> ModelsManagerFuture<'_, Vec<ModelInfo>>
```

**Purpose**: Returns the current in-memory remote model list for the OpenAI-backed manager. It waits safely if another task is currently updating that list.

**Data flow**: It reads the manager’s protected model list, clones the models, and returns the clone. The stored list itself is not changed.

**Call relations**: `OpenAiModelsManager::raw_model_catalog` calls this after refresh work so it can return the latest active catalog.

*Call graph*: called by 1 (raw_model_catalog); 1 external calls (pin).


##### `OpenAiModelsManager::try_get_remote_models`  (lines 258–260)

```
fn try_get_remote_models(&self) -> Result<Vec<ModelInfo>, TryLockError>
```

**Purpose**: Tries to return the current in-memory remote models without waiting. It is for situations where the caller would rather get an immediate error than pause.

**Data flow**: It attempts an instant read of the protected model list. If the read lock is available, it clones and returns the models. If not, it returns a lock error.

**Call relations**: The default `ModelsManager::try_list_models` method uses this kind of operation before converting models into picker presets.


##### `OpenAiModelsManager::auth_manager`  (lines 262–264)

```
fn auth_manager(&self) -> Option<&AuthManager>
```

**Purpose**: Gives access to the authentication manager used by the OpenAI-backed manager. The model filtering code uses this to decide which models the current user is allowed to see.

**Data flow**: It reads the optional stored authentication manager reference. It returns that reference if present, or no value if this manager was created without authentication support.

**Call relations**: The shared preset-building code calls this through the `ModelsManager` interface when applying authentication-based filtering.


##### `OpenAiModelsManager::list_collaboration_modes`  (lines 266–268)

```
fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

**Purpose**: Returns the built-in collaboration mode presets. These are separate from model presets but are offered through the same manager interface.

**Data flow**: It takes no input besides the manager itself. It asks `builtin_collaboration_mode_presets` for the static preset list and returns it.

**Call relations**: Any caller using a `ModelsManager` can ask for collaboration modes; the OpenAI-backed manager answers with the shared built-in list.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets).


##### `OpenAiModelsManager::raw_model_catalog`  (lines 276–283)

```
async fn raw_model_catalog(&self, refresh_strategy: RefreshStrategy) -> ModelsResponse
```

**Purpose**: Returns the active raw model catalog, refreshing it first according to the requested strategy. If refresh fails, it logs the problem and still returns the current in-memory catalog.

**Data flow**: It receives a refresh strategy. It asks `refresh_available_models` to update from cache or network if appropriate. Whether that succeeds or fails, it reads the current remote models and wraps them in a `ModelsResponse`.

**Call relations**: This is the OpenAI-backed implementation behind `ModelsManager::list_models`. It hands refresh decisions to `refresh_available_models` and model reading to `get_remote_models`.

*Call graph*: calls 2 internal fn (get_remote_models, refresh_available_models); 2 external calls (pin, error!).


##### `OpenAiModelsManager::refresh_if_new_etag`  (lines 285–296)

```
async fn refresh_if_new_etag(&self, etag: String)
```

**Purpose**: Refreshes the model list only when a provided ETag shows that the remote catalog may have changed. An ETag is a version label from the server.

**Data flow**: It receives a new ETag string. It compares it with the manager’s stored ETag. If they match and a current ETag exists, it renews the cache lifetime and stops. If they differ, it forces an online refresh and logs any failure.

**Call relations**: This is used when another part of the system has learned the server’s catalog version. It calls `get_etag` for comparison and `refresh_available_models` when the version has changed.

*Call graph*: calls 3 internal fn (renew_cache_ttl, get_etag, refresh_available_models); 2 external calls (pin, error!).


##### `OpenAiModelsManager::refresh_available_models`  (lines 299–330)

```
async fn refresh_available_models(&self, refresh_strategy: RefreshStrategy) -> CoreResult<()>
```

**Purpose**: Decides whether and how to refresh the available model list. It applies the caller’s strategy: cache only, network only, or cache first with network fallback.

**Data flow**: It receives a refresh strategy. It first checks `should_refresh_models`; if refreshing is not appropriate, it may still load cache for offline-style strategies and then returns. If refreshing is appropriate, it either loads cache, fetches from the endpoint, or tries cache before fetching, depending on the strategy.

**Call relations**: `OpenAiModelsManager::raw_model_catalog` calls this before returning a catalog, and `refresh_if_new_etag` calls it when a server version change is detected. It delegates cache reads to `try_load_cache` and network fetches to `fetch_and_update_models`.

*Call graph*: calls 3 internal fn (fetch_and_update_models, should_refresh_models, try_load_cache); called by 2 (raw_model_catalog, refresh_if_new_etag); 2 external calls (info!, matches!).


##### `OpenAiModelsManager::fetch_and_update_models`  (lines 332–341)

```
async fn fetch_and_update_models(&self) -> CoreResult<()>
```

**Purpose**: Fetches the latest model catalog from the remote endpoint and stores it in memory and cache. This is the actual online refresh step.

**Data flow**: It gets the current client version, sends that to the endpoint client’s model-listing call, and receives models plus an optional ETag. It applies the models to the in-memory list, stores the ETag, asks the cache manager to persist the data, and returns success or the endpoint error.

**Call relations**: `refresh_available_models` calls this when the chosen strategy requires a network fetch or when cache lookup fails.

*Call graph*: calls 2 internal fn (persist_cache, apply_remote_models); called by 1 (refresh_available_models); 2 external calls (list_models, client_version_to_whole).


##### `OpenAiModelsManager::should_refresh_models`  (lines 343–345)

```
async fn should_refresh_models(&self) -> bool
```

**Purpose**: Checks whether this manager is in a state where remote model refreshes make sense. It looks at provider authentication capabilities.

**Data flow**: It asks the endpoint client whether current authentication uses the Codex backend or supports command-scoped authentication. If either is true, it returns true; otherwise it returns false.

**Call relations**: `refresh_available_models` uses this as an early gate before trying cache or network refresh behavior.

*Call graph*: called by 1 (refresh_available_models); 2 external calls (has_command_auth, uses_codex_backend).


##### `OpenAiModelsManager::get_etag`  (lines 347–349)

```
async fn get_etag(&self) -> Option<String>
```

**Purpose**: Returns the currently stored ETag, if one is known. The ETag is used to tell whether cached model data matches the server’s latest version.

**Data flow**: It reads the protected ETag field, clones the optional string, and returns it. It does not change the stored ETag.

**Call relations**: `refresh_if_new_etag` calls this before deciding whether it can simply renew the cache or must refresh from the network.

*Call graph*: called by 1 (refresh_if_new_etag).


##### `OpenAiModelsManager::apply_remote_models`  (lines 352–381)

```
async fn apply_remote_models(&self, models: Vec<ModelInfo>)
```

**Purpose**: Updates the in-memory model list with models received from cache or the remote endpoint. It decides whether remote data fully replaces bundled data or should be merged into it.

**Data flow**: It receives a list of model records. If the list has visible models and the user is using a ChatGPT account, it treats the remote list as the full source of truth and stores it directly. Otherwise, it loads bundled models, replaces matching entries by slug, adds new ones, and stores the merged result.

**Call relations**: `fetch_and_update_models` calls this after a network response. `try_load_cache` calls it after reading a usable cache entry.

*Call graph*: calls 1 internal fn (load_remote_models_from_file); called by 2 (fetch_and_update_models, try_load_cache).


##### `OpenAiModelsManager::try_load_cache`  (lines 384–407)

```
async fn try_load_cache(&self) -> bool
```

**Purpose**: Attempts to refresh the in-memory model list from the disk cache. It only accepts cache data that is fresh for the current client version.

**Data flow**: It gets the current client version and asks the cache manager for a fresh matching entry. If no usable entry exists, it returns false. If one exists, it stores the cached ETag, applies the cached models through `apply_remote_models`, logs what happened, and returns true.

**Call relations**: `refresh_available_models` calls this for offline and cache-first strategies. It is the fast local path before the manager falls back to network fetching.

*Call graph*: calls 2 internal fn (load_fresh, apply_remote_models); called by 1 (refresh_available_models); 3 external calls (start_global_timer, client_version_to_whole, info!).


##### `StaticModelsManager::raw_model_catalog`  (lines 411–420)

```
fn raw_model_catalog(
        &self,
        _refresh_strategy: RefreshStrategy,
    ) -> ModelsManagerFuture<'_, ModelsResponse>
```

**Purpose**: Returns the fixed raw model catalog held by the static manager. It ignores refresh strategy because static catalogs do not refresh from cache or network.

**Data flow**: It receives a refresh strategy but does not use it. It clones the stored models through `get_remote_models`, wraps them in a `ModelsResponse`, and returns them.

**Call relations**: This is the static implementation behind the shared `ModelsManager` interface. It calls `StaticModelsManager::get_remote_models` to produce the catalog.

*Call graph*: calls 1 internal fn (get_remote_models); 1 external calls (pin).


##### `StaticModelsManager::get_remote_models`  (lines 422–424)

```
fn get_remote_models(&self) -> ModelsManagerFuture<'_, Vec<ModelInfo>>
```

**Purpose**: Returns the static manager’s stored model list. Since the list is fixed, this is just a clone of the in-memory catalog.

**Data flow**: It reads the stored model vector, clones it, and returns the clone. Nothing is refreshed or changed.

**Call relations**: `StaticModelsManager::raw_model_catalog` calls this when building its `ModelsResponse`.

*Call graph*: called by 1 (raw_model_catalog); 1 external calls (pin).


##### `StaticModelsManager::try_get_remote_models`  (lines 426–428)

```
fn try_get_remote_models(&self) -> Result<Vec<ModelInfo>, TryLockError>
```

**Purpose**: Returns the static model list immediately. Unlike the OpenAI-backed manager, there is no lock to wait for.

**Data flow**: It clones the stored model list and returns it as a successful result. It does not produce a lock error in normal use because the data is not protected by an async write lock.

**Call relations**: The default `ModelsManager::try_list_models` path can use this to build picker presets without waiting.


##### `StaticModelsManager::auth_manager`  (lines 430–432)

```
fn auth_manager(&self) -> Option<&AuthManager>
```

**Purpose**: Gives access to the authentication manager stored in the static manager. This lets shared filtering logic still respect the current user’s auth mode.

**Data flow**: It reads the optional authentication manager reference and returns it if available. It does not change the manager.

**Call relations**: The shared `build_available_models` method calls this through the `ModelsManager` interface before applying authentication-based model filtering.


##### `StaticModelsManager::list_collaboration_modes`  (lines 434–436)

```
fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

**Purpose**: Returns the built-in collaboration mode presets for the static manager. These presets are not affected by the static model catalog.

**Data flow**: It asks `builtin_collaboration_mode_presets` for the fixed collaboration-mode list and returns it.

**Call relations**: This mirrors the OpenAI-backed manager’s behavior so callers can ask any `ModelsManager` for collaboration modes in the same way.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets).


##### `StaticModelsManager::refresh_if_new_etag`  (lines 438–440)

```
fn refresh_if_new_etag(&self, _etag: String) -> ModelsManagerFuture<'_, ()>
```

**Purpose**: Does nothing for ETag refresh requests because a static model catalog is not refreshed from a server. It exists so the static manager satisfies the same interface as other managers.

**Data flow**: It receives an ETag string but ignores it. It returns an already-complete asynchronous operation and changes no data.

**Call relations**: Callers can invoke `refresh_if_new_etag` on any `ModelsManager` without special-casing static managers; for this implementation, the call is intentionally a no-op.

*Call graph*: 1 external calls (pin).


##### `load_remote_models_from_file`  (lines 443–445)

```
fn load_remote_models_from_file() -> Result<Vec<ModelInfo>, std::io::Error>
```

**Purpose**: Loads the bundled model catalog that ships with the application. This provides a safe fallback menu even before remote data or cache data is available.

**Data flow**: It asks the crate for the bundled `ModelsResponse`, extracts its model list, and returns that list or an I/O error if loading fails.

**Call relations**: `OpenAiModelsManager::new` uses this to seed the initial model list. `OpenAiModelsManager::apply_remote_models` uses it when remote models should be merged with bundled defaults.

*Call graph*: called by 2 (apply_remote_models, new); 1 external calls (bundled_models_response).


##### `default_model_from_available`  (lines 447–454)

```
fn default_model_from_available(available: Vec<ModelPreset>) -> String
```

**Purpose**: Chooses the default model name from a list of available presets. It prefers the preset explicitly marked as default, then falls back to the first preset.

**Data flow**: It receives model presets. It searches for one marked default. If none is found, it uses the first preset. It returns that preset’s model string, or an empty string if the list is empty.

**Call relations**: `ModelsManager::get_default_model` calls this after listing available models when the caller did not provide a model explicitly.

*Call graph*: called by 1 (get_default_model).


##### `find_model_by_longest_prefix`  (lines 456–472)

```
fn find_model_by_longest_prefix(model: &str, candidates: &[ModelInfo]) -> Option<ModelInfo>
```

**Purpose**: Finds the candidate model whose slug is the longest prefix of a requested model name. This supports names like versioned or extended model identifiers that begin with a known base slug.

**Data flow**: It receives a requested model string and candidate model records. It checks each candidate whose slug appears at the start of the requested model, keeps the longest matching slug, and returns a clone of that best candidate if one exists.

**Call relations**: `construct_model_info_from_candidates` uses this as the normal metadata lookup. `find_model_by_namespaced_suffix` also uses it after stripping a simple namespace.

*Call graph*: called by 2 (construct_model_info_from_candidates, find_model_by_namespaced_suffix).


##### `find_model_by_namespaced_suffix`  (lines 474–491)

```
fn find_model_by_namespaced_suffix(model: &str, candidates: &[ModelInfo]) -> Option<ModelInfo>
```

**Purpose**: Retries model lookup for simple namespaced model names such as `provider/model-name`. This allows one leading provider-like prefix without accepting arbitrary complex aliases.

**Data flow**: It receives a requested model string and candidate models. It splits the string at the first slash, rejects it if there are extra slashes or an invalid namespace, then searches for the suffix with `find_model_by_longest_prefix`. It returns the matched metadata or no value.

**Call relations**: `construct_model_info_from_candidates` uses this only after the normal longest-prefix lookup fails.

*Call graph*: calls 1 internal fn (find_model_by_longest_prefix).


##### `construct_model_info_from_candidates`  (lines 493–512)

```
fn construct_model_info_from_candidates(
    model: &str,
    candidates: &[ModelInfo],
    config: &ModelsManagerConfig,
) -> ModelInfo
```

**Purpose**: Builds the best `ModelInfo` record for a requested model name. It uses remote metadata when possible, falls back to built-in slug-based metadata when needed, and then applies local configuration overrides.

**Data flow**: It receives a model name, candidate model records, and configuration. It first looks for a longest-prefix match, then tries a simple namespaced suffix match. If it finds remote metadata, it copies that metadata but sets the slug to the exact requested model and marks that fallback metadata was not used. If no candidate matches, it creates fallback metadata from the slug. Finally, it applies configuration overrides and returns the completed record.

**Call relations**: `ModelsManager::get_model_info` calls this for normal metadata lookup. Tests also call it directly to verify offline and fallback behavior.

*Call graph*: calls 3 internal fn (find_model_by_longest_prefix, model_info_from_slug, with_config_overrides); called by 2 (get_model_info, construct_model_info_offline_for_tests).


### Local OSS provider readiness
These files provide shared OSS helpers and the concrete LM Studio and Ollama startup integrations built on top of local client checks.

### `utils/oss/src/lib.rs`

`util` · `startup or provider setup`

This file exists so the terminal UI and command execution code do not each need their own separate knowledge of LM Studio and Ollama. These are OSS providers, meaning local or open-source model backends that can run outside the hosted service. The file acts like a front desk: given a provider name, it either points to the right default model or asks the provider-specific code to make sure everything is ready.

There are two main jobs. First, `get_default_model_for_oss_provider` translates a known provider ID into that provider’s built-in default model name. If the provider is not one this code recognizes, it returns nothing instead of guessing.

Second, `ensure_oss_provider_ready` performs setup checks before the app tries to use a local model provider. For LM Studio, it asks the LM Studio-specific crate to prepare or verify readiness. For Ollama, it first checks that the configured provider supports the needed “responses” behavior, then asks Ollama-specific code to prepare or verify readiness. Any provider-specific failure is turned into a standard input/output error so callers can report one kind of setup problem. Unknown providers are deliberately skipped, which keeps this helper from blocking providers it does not understand.

The tests cover the default-model lookup behavior for LM Studio, Ollama, and an unknown provider.

#### Function details

##### `get_default_model_for_oss_provider`  (lines 8–14)

```
fn get_default_model_for_oss_provider(provider_id: &str) -> Option<&'static str>
```

**Purpose**: This function answers the simple question: “If the user picked this OSS provider, what model should we use by default?” It knows about LM Studio and Ollama, and it refuses to invent an answer for unknown providers.

**Data flow**: It takes a provider ID as text. It compares that text with the known IDs for LM Studio and Ollama. If it matches one, it returns that provider’s default model name; if it does not match, it returns `None`, meaning there is no known default.

**Call relations**: The test functions call this directly to prove the lookup table behaves as expected. In the larger system, other code can use it before creating a model request, so the app can choose a sensible default without duplicating provider-specific constants.

*Call graph*: called by 3 (test_get_default_model_for_provider_lmstudio, test_get_default_model_for_provider_ollama, test_get_default_model_for_provider_unknown).


##### `ensure_oss_provider_ready`  (lines 17–38)

```
async fn ensure_oss_provider_ready(
    provider_id: &str,
    config: &Config,
) -> Result<(), std::io::Error>
```

**Purpose**: This asynchronous function checks that a chosen local OSS provider is actually usable before the app relies on it. That may mean confirming a service is reachable, a model is available, or a provider supports the needed API behavior.

**Data flow**: It receives a provider ID and the app configuration. For LM Studio, it passes the configuration to LM Studio’s readiness routine. For Ollama, it first checks whether the configured model provider supports responses, then runs Ollama’s readiness routine. If one of those provider checks fails, the error is wrapped as a standard I/O error; if the provider is unknown, it does nothing and returns success.

**Call relations**: This function is the shared gateway before using LM Studio or Ollama. It hands the real provider-specific work to external readiness functions, because those crates know the details of their own services. Callers can treat the result uniformly: success means continue, and failure means show an OSS setup problem.

*Call graph*: 3 external calls (ensure_oss_ready, ensure_oss_ready, ensure_responses_supported).


##### `tests::test_get_default_model_for_provider_lmstudio`  (lines 45–48)

```
fn test_get_default_model_for_provider_lmstudio()
```

**Purpose**: This test verifies that the LM Studio provider ID maps to LM Studio’s default OSS model. It protects against accidentally changing or breaking that lookup.

**Data flow**: It gives the LM Studio provider ID to `get_default_model_for_oss_provider`. It then compares the returned value with the LM Studio default model constant and passes only if they match.

**Call relations**: This test calls the shared lookup function in the same way production code would. Its job is to catch mistakes in the LM Studio branch of the provider match.

*Call graph*: calls 1 internal fn (get_default_model_for_oss_provider); 1 external calls (assert_eq!).


##### `tests::test_get_default_model_for_provider_ollama`  (lines 51–54)

```
fn test_get_default_model_for_provider_ollama()
```

**Purpose**: This test verifies that the Ollama provider ID maps to Ollama’s default OSS model. It makes sure the shared helper keeps returning the expected default for Ollama.

**Data flow**: It gives the Ollama provider ID to `get_default_model_for_oss_provider`. It then checks that the result is exactly the Ollama default model constant.

**Call relations**: This test exercises the Ollama branch of the lookup function. If someone edits the mapping incorrectly, this test should fail and point to the problem.

*Call graph*: calls 1 internal fn (get_default_model_for_oss_provider); 1 external calls (assert_eq!).


##### `tests::test_get_default_model_for_provider_unknown`  (lines 57–60)

```
fn test_get_default_model_for_provider_unknown()
```

**Purpose**: This test verifies that an unrecognized provider does not get a fake default model. That matters because guessing could make the app try to use the wrong model or hide a configuration problem.

**Data flow**: It passes the text `unknown-provider` into `get_default_model_for_oss_provider`. It expects the result to be `None`, meaning the helper does not know a default for that provider.

**Call relations**: This test covers the fallback path of the lookup function. Together with the LM Studio and Ollama tests, it confirms both known and unknown provider behavior.

*Call graph*: calls 1 internal fn (get_default_model_for_oss_provider); 1 external calls (assert_eq!).


### `ollama/src/client.rs`

`io_transport` · `startup and model preparation`

Ollama is a local program that can download and run language models. This file is the project’s “phone line” to that local Ollama server. Without it, the rest of the system could not tell whether Ollama is available, discover which models are already installed, or download a model before trying to use it.

The main type is `OllamaClient`. It wraps a reusable web client, remembers the server’s root address, and records whether that address is using Ollama’s native API or an OpenAI-compatible API shape. Think of it like a remote control that first checks which kind of TV it is pointed at, then chooses the right buttons.

Client creation is deliberately cautious. It reads the configured provider, turns its base URL into a host root, builds a `reqwest` HTTP client, and immediately probes a health endpoint. If no server responds, it returns a friendly message telling the user to run `ollama serve`.

After setup, the client can fetch model names from `/api/tags`, fetch the version from `/api/version`, and start a model pull through `/api/pull`. Pulling is streamed line by line because Ollama sends progress updates over time. Each JSON line is converted into `PullEvent` values, which can then be shown by a progress reporter. The tests use a mock web server so these behaviors can be checked without a real Ollama install.

#### Function details

##### `OllamaClient::try_from_oss_provider`  (lines 35–50)

```
async fn try_from_oss_provider(config: &Config) -> io::Result<Self>
```

**Purpose**: Creates an `OllamaClient` for the built-in open-source Ollama provider described in the user configuration. It exists so higher-level setup code can ask, in one step, “is the configured local Ollama provider usable?”

**Data flow**: It receives the project `Config`, looks up the built-in Ollama provider entry, and fails with a clear not-found error if that entry is missing. If the provider is present, it passes that provider definition onward to the lower-level client builder and returns either a ready client or the connection/setup error from that builder.

**Call relations**: When `ensure_oss_ready` needs to prepare the open-source Ollama path, it calls this function. This function does the configuration lookup, then hands the actual network setup to `try_from_provider` so the probing rules stay in one place.

*Call graph*: called by 1 (ensure_oss_ready); 1 external calls (try_from_provider).


##### `OllamaClient::try_from_provider_with_base_url`  (lines 53–56)

```
async fn try_from_provider_with_base_url(base_url: &str) -> io::Result<Self>
```

**Purpose**: Builds a test-only Ollama provider from a raw base URL and then creates a client from it. It lets tests point the client at a mock server instead of a real Ollama process.

**Data flow**: It takes a base URL string, wraps it into a provider definition using the same shape as the open-source provider, and sends that provider to the normal client-building path. The output is either a working `OllamaClient` or the same error the real builder would return.

**Call relations**: Several tests call this helper when they need to check probing, version fetching, or missing-server behavior. It delegates to `create_oss_provider_with_base_url` to make test provider data, then to `try_from_provider` to exercise the real setup logic.

*Call graph*: called by 4 (test_fetch_version, test_probe_server_happy_path_openai_compat_and_native, test_try_from_oss_provider_err_when_server_missing, test_try_from_oss_provider_ok_when_server_running); 2 external calls (try_from_provider, create_oss_provider_with_base_url).


##### `OllamaClient::try_from_provider`  (lines 59–78)

```
async fn try_from_provider(provider: &ModelProviderInfo) -> io::Result<Self>
```

**Purpose**: Creates an `OllamaClient` from a provider definition and verifies that the server is reachable before returning it. This prevents later code from assuming Ollama is available when it is not.

**Data flow**: It reads the provider’s base URL, decides whether that URL looks OpenAI-compatible, converts it to the server root address, and builds an HTTP client with a short connection timeout. It then probes the server; if the probe succeeds, it returns the completed client, and if it fails, it returns a helpful input/output error.

**Call relations**: This is the shared construction path used by higher-level readiness checks such as `ensure_responses_supported` and by wrappers that first choose a provider. It relies on URL helpers to normalize the address, then calls `probe_server` to make sure the address actually answers.

*Call graph*: calls 2 internal fn (base_url_to_host_root, is_openai_compatible_base_url); called by 1 (ensure_responses_supported); 2 external calls (builder, from_secs).


##### `OllamaClient::probe_server`  (lines 81–101)

```
async fn probe_server(&self) -> io::Result<()>
```

**Purpose**: Checks whether the configured Ollama server is alive by making a small HTTP request to the right health-like endpoint. It turns connection failures into a user-friendly instruction to start Ollama.

**Data flow**: It reads the client’s stored host root and API style flag. From those, it chooses either `/v1/models` for OpenAI-compatible URLs or `/api/tags` for native Ollama, sends a GET request, and returns success only for a successful HTTP status. Failed connections or bad statuses become an `io::Error` with the standard Ollama connection message.

**Call relations**: Client creation calls this before handing the client to the rest of the program. It uses the underlying HTTP client directly and logs warning details for developers while returning a simpler message for users.

*Call graph*: 4 external calls (get, other, format!, warn!).


##### `OllamaClient::fetch_models`  (lines 104–127)

```
async fn fetch_models(&self) -> io::Result<Vec<String>>
```

**Purpose**: Asks the local Ollama server which model names it knows about. This is used when the program needs to decide whether a model is already installed or should be pulled.

**Data flow**: It builds the `/api/tags` URL, sends a GET request, and treats a non-success HTTP response as an empty model list. For a successful response, it reads the JSON body, looks for a `models` array, extracts each model’s `name` field, and returns those names as strings.

**Call relations**: This function is a direct query on the Ollama server. Tests call it through a client pointed at a mock server to prove that the JSON response is turned into the expected list of names.

*Call graph*: 3 external calls (new, get, format!).


##### `OllamaClient::fetch_version`  (lines 130–153)

```
async fn fetch_version(&self) -> io::Result<Option<Version>>
```

**Purpose**: Reads the Ollama server’s version number, if the server provides one. The version can be used by other parts of the system to decide whether certain Ollama features are supported.

**Data flow**: It sends a GET request to `/api/version`. If the response is not successful, or if the JSON body has no usable `version` string, it returns `None`. If a version string exists, it removes a leading `v` if present, parses it as a semantic version such as `0.14.1`, and returns that parsed version; parse failures are logged and also become `None`.

**Call relations**: This function is called after a client has already been created and probed. Its test uses `try_from_provider_with_base_url` to first build a client against a mock server, then checks that the version JSON is parsed correctly.

*Call graph*: 4 external calls (parse, get, format!, warn!).


##### `OllamaClient::pull_model_stream`  (lines 157–211)

```
async fn pull_model_stream(
        &self,
        model: &str,
    ) -> io::Result<BoxStream<'static, PullEvent>>
```

**Purpose**: Starts downloading a model from Ollama and returns a live stream of progress events. This lets the user interface show progress as the download unfolds instead of waiting silently.

**Data flow**: It receives a model name, posts JSON to `/api/pull` asking Ollama to stream updates, and fails immediately if the HTTP response status is not successful. For a successful response, it reads incoming byte chunks, gathers them into complete lines, parses each line as JSON, converts known fields into `PullEvent` values, and yields those events. If Ollama sends an error event, it yields an error and stops; if Ollama sends a `success` status, it yields success and stops.

**Call relations**: `pull_with_reporter` calls this to get the raw event stream. Internally it uses `LineBuffer` to avoid breaking when JSON lines arrive split across network chunks, and `pull_events_from_value` to translate Ollama’s JSON messages into the project’s progress event type.

*Call graph*: called by 1 (pull_with_reporter); 8 external calls (pin, new, stream!, post, other, format!, default, json!).


##### `OllamaClient::pull_with_reporter`  (lines 214–245)

```
async fn pull_with_reporter(
        &self,
        model: &str,
        reporter: &mut dyn PullProgressReporter,
    ) -> io::Result<()>
```

**Purpose**: Downloads a model while feeding every progress update to a reporter, such as a terminal progress display. It is the convenient high-level pull operation for code that wants user-visible feedback.

**Data flow**: It takes a model name and a mutable progress reporter. First it sends the reporter a starting status message, then it opens the pull stream. For each event from the stream, it passes the event to the reporter. A success event returns `Ok(())`; an error event becomes a failed result; if the stream ends without success, it returns an unexpected-end error.

**Call relations**: This function sits above `pull_model_stream`. It does not parse Ollama network data itself; instead, it consumes the stream of `PullEvent` values and decides when the overall pull should count as success or failure.

*Call graph*: calls 1 internal fn (pull_model_stream); 4 external calls (other, format!, Status, on_event).


##### `OllamaClient::from_host_root`  (lines 249–259)

```
fn from_host_root(host_root: impl Into<String>) -> Self
```

**Purpose**: Creates a test-only client directly from a server root URL without probing or reading provider configuration. It makes tests shorter when they only need to exercise a specific request.

**Data flow**: It receives something that can become a string, builds a normal HTTP client with the same timeout style as production code, stores the given host root, and marks the client as using the native Ollama API. It returns the constructed `OllamaClient` immediately.

**Call relations**: Tests use this helper when they already control a mock server and do not need the full provider setup path. It supports tests for model listing, native probing, and streamed pull parsing.

*Call graph*: called by 3 (test_fetch_models_happy_path, test_probe_server_happy_path_openai_compat_and_native, test_pull_model_stream_parses_large_json_lines); 3 external calls (into, builder, from_secs).


##### `tests::test_fetch_models_happy_path`  (lines 270–298)

```
async fn test_fetch_models_happy_path()
```

**Purpose**: Checks that `fetch_models` can read a normal Ollama `/api/tags` response and return the model names inside it. This protects the basic “what models are installed?” behavior.

**Data flow**: The test starts a mock HTTP server, teaches it to answer `/api/tags` with JSON containing two model names, creates a client pointing at that mock server, and calls `fetch_models`. It then checks that both expected names appear in the returned list.

**Call relations**: This test calls `from_host_root` because it only needs a simple client aimed at the mock server. It exercises the `fetch_models` parsing path without requiring a real networked Ollama instance.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert!, json!, var, info!, given, start, new, method, path).


##### `tests::test_fetch_version`  (lines 301–334)

```
async fn test_fetch_version()
```

**Purpose**: Checks that the client can fetch and parse an Ollama version string. It makes sure a response like `0.14.1` becomes a structured version value rather than just raw text.

**Data flow**: The test starts a mock server, sets up the probe endpoint and the `/api/version` endpoint, then creates the client through the provider-based test helper. It calls `fetch_version` and compares the result to the expected semantic version object.

**Call relations**: This test uses `try_from_provider_with_base_url` so the normal startup probe is included. After setup succeeds, it focuses on the `fetch_version` request and parsing behavior.

*Call graph*: calls 1 internal fn (try_from_provider_with_base_url); 9 external calls (assert_eq!, json!, var, info!, given, start, new, method, path).


##### `tests::test_pull_model_stream_parses_large_json_lines`  (lines 337–378)

```
async fn test_pull_model_stream_parses_large_json_lines()
```

**Purpose**: Checks that streamed model-pull updates still work when a JSON line is very large. This guards against bugs where network chunks split a long line and the parser loses part of it.

**Data flow**: The test prepares a mock `/api/pull` response containing two newline-separated JSON messages, one with a large padding field. It creates a client, starts `pull_model_stream`, collects all emitted events, and checks that the expected status messages were produced.

**Call relations**: This test calls `from_host_root` and then exercises `pull_model_stream` directly. It indirectly checks that the line buffering and JSON-to-event conversion cooperate correctly for large streamed messages.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert_matches!, format!, var, info!, given, start, new, method, path).


##### `tests::test_probe_server_happy_path_openai_compat_and_native`  (lines 381–415)

```
async fn test_probe_server_happy_path_openai_compat_and_native()
```

**Purpose**: Checks that server probing works for both Ollama’s native API and its OpenAI-compatible API shape. This matters because users may configure either kind of base URL.

**Data flow**: The test starts a mock server and first makes `/api/tags` return success, then builds a native-style client and probes it. Next it makes `/v1/models` return success, builds a provider-based client with a `/v1` URL, and probes that OpenAI-compatible path too.

**Call relations**: The native half uses `from_host_root`; the OpenAI-compatible half uses `try_from_provider_with_base_url`, which detects the URL style. Both paths end up exercising `probe_server` with different endpoint choices.

*Call graph*: calls 2 internal fn (from_host_root, try_from_provider_with_base_url); 8 external calls (format!, var, info!, given, start, new, method, path).


##### `tests::test_try_from_oss_provider_ok_when_server_running`  (lines 418–439)

```
async fn test_try_from_oss_provider_ok_when_server_running()
```

**Purpose**: Checks that provider-based client creation succeeds when the mock Ollama server responds to the expected OpenAI-compatible probe endpoint. This protects the happy path for startup readiness.

**Data flow**: The test starts a mock server, configures `/v1/models` to return success, then calls `try_from_provider_with_base_url` with a `/v1` base URL. If the probe succeeds, the helper returns a client and the test passes.

**Call relations**: This test drives the same setup path used by production provider construction, but with a mock server. It verifies that the construction path accepts a reachable OpenAI-compatible Ollama endpoint.

*Call graph*: calls 1 internal fn (try_from_provider_with_base_url); 8 external calls (format!, var, info!, given, start, new, method, path).


##### `tests::test_try_from_oss_provider_err_when_server_missing`  (lines 442–457)

```
async fn test_try_from_oss_provider_err_when_server_missing()
```

**Purpose**: Checks that provider-based client creation gives the intended friendly error when the server does not answer the probe. This helps ensure users see useful guidance instead of a confusing low-level connection message.

**Data flow**: The test starts a mock server but does not configure the expected probe response, then calls `try_from_provider_with_base_url`. It expects an error and compares the error text with the standard “No running Ollama server detected” message.

**Call relations**: This test uses the provider-based test helper to reach the normal probing path. It confirms that failed probing is converted into the shared Ollama connection error.

*Call graph*: calls 1 internal fn (try_from_provider_with_base_url); 5 external calls (assert_eq!, format!, var, info!, start).


### `ollama/src/lib.rs`

`orchestration` · `startup / local model setup`

This file exists so Codex can safely use a local Ollama server when the user chooses the open-source model path. Ollama is a local service that can run language models on the user’s machine. Before Codex relies on it, two practical questions need answers: is the server reachable, and is the needed model available locally?

The file first exposes useful pieces from its submodules, such as `OllamaClient` and progress reporters. That makes this library act like a tidy reception desk: other code can import the main tools from here without knowing which smaller file they live in.

Its main setup function, `ensure_oss_ready`, chooses the model name, connects to the local Ollama provider, asks Ollama what models are already installed, and downloads the model if it is missing. If listing models fails, it only logs a warning, because later code may still produce a clearer error.

The second concern is compatibility. Codex needs Ollama’s Responses API, which is a newer way for the server to answer requests. `ensure_responses_supported` asks the server for its version and rejects versions older than 0.13.4. A special development version, 0.0.0, is treated as acceptable.

#### Function details

##### `ensure_oss_ready`  (lines 23–50)

```
async fn ensure_oss_ready(config: &Config) -> std::io::Result<()>
```

**Purpose**: Prepares the local Ollama environment when the user asks Codex to use the open-source model option. It checks that Ollama can be reached and makes sure the requested model is present, downloading it if needed.

**Data flow**: It receives the Codex configuration and reads the configured model name, falling back to the default `gpt-oss:20b` when no model was named. It uses that configuration to create an Ollama client, asks the server which models are installed, and, if the target model is missing, starts a command-line progress reporter and pulls the model. It returns success when setup is complete, returns an I/O error if connecting or pulling fails, and only logs a warning if the model list cannot be fetched.

**Call relations**: This is called during open-source Ollama startup work. It hands the configuration to `try_from_oss_provider` to build the client, creates a progress reporter with `new` when a download is needed, and uses `warn!` to record a non-fatal failure to query installed models.

*Call graph*: calls 2 internal fn (try_from_oss_provider, new); 1 external calls (warn!).


##### `min_responses_version`  (lines 52–54)

```
fn min_responses_version() -> Version
```

**Purpose**: Defines the minimum Ollama version Codex considers new enough for the Responses API. Keeping this cutoff in one function avoids scattering the number through the file.

**Data flow**: It takes no input. It constructs and returns the semantic version number 0.13.4, where semantic versioning means the common major.minor.patch format used to compare software releases.

**Call relations**: The version-checking helpers call this whenever they need the cutoff. `supports_responses` uses it for comparison, and `ensure_responses_supported` uses it again when building the human-readable error message.

*Call graph*: called by 2 (ensure_responses_supported, supports_responses); 1 external calls (new).


##### `supports_responses`  (lines 56–58)

```
fn supports_responses(version: &Version) -> bool
```

**Purpose**: Answers the simple question: does this Ollama version support the Responses API Codex needs? It also allows version 0.0.0, which represents a development build rather than a normal release.

**Data flow**: It receives a version number. It compares that version with the hard-coded development version 0.0.0 and with the minimum supported version from `min_responses_version`. It returns `true` if the version is allowed and `false` if it is too old.

**Call relations**: `ensure_responses_supported` calls this after it has fetched the server version. This function delegates the cutoff value to `min_responses_version` and uses the external version constructor to recognize the special development version.

*Call graph*: calls 1 internal fn (min_responses_version); called by 1 (ensure_responses_supported); 1 external calls (new).


##### `ensure_responses_supported`  (lines 63–77)

```
async fn ensure_responses_supported(provider: &ModelProviderInfo) -> std::io::Result<()>
```

**Purpose**: Checks whether a configured Ollama provider is running a server version that Codex can work with. If the server is too old, it stops early with a clear error instead of letting later requests fail mysteriously.

**Data flow**: It receives provider information, uses it to create an Ollama client, and asks the server for its version. If the version endpoint is missing or cannot provide a usable version, it treats that as acceptable. If a version is present, it passes it to `supports_responses`; supported versions return success, while older versions produce an I/O error that names both the running version and the required minimum.

**Call relations**: This runs before Codex depends on Ollama’s Responses API. It builds the client through `try_from_provider`, asks `supports_responses` for the yes/no decision, calls `min_responses_version` to explain failures, and uses formatting plus `std::io::Error::other` to turn an old version into a clear startup error.

*Call graph*: calls 3 internal fn (try_from_provider, min_responses_version, supports_responses); 2 external calls (other, format!).


##### `tests::supports_responses_for_dev_zero`  (lines 84–86)

```
fn supports_responses_for_dev_zero()
```

**Purpose**: Verifies that the special development version 0.0.0 is accepted. This protects the intentional exception from being removed by accident.

**Data flow**: It creates the version number 0.0.0, checks it with the response-support logic, and asserts that the answer is true. It changes nothing outside the test run.

**Call relations**: This test exercises the same helper used by `ensure_responses_supported`. It uses `assert!` to fail the test if the development-version rule stops working.

*Call graph*: 1 external calls (assert!).


##### `tests::does_not_support_responses_before_cutoff`  (lines 89–91)

```
fn does_not_support_responses_before_cutoff()
```

**Purpose**: Verifies that an Ollama version just below the minimum is rejected. This makes sure the cutoff is not accidentally loosened.

**Data flow**: It creates version 0.13.3, runs it through the support check, and asserts that the result is false. The output is only a pass or fail signal for the test suite.

**Call relations**: This test protects the boundary used by `ensure_responses_supported`. It relies on `assert!` to report a failure if the helper starts accepting versions older than the stated minimum.

*Call graph*: 1 external calls (assert!).


##### `tests::supports_responses_at_or_after_cutoff`  (lines 94–97)

```
fn supports_responses_at_or_after_cutoff()
```

**Purpose**: Verifies that the minimum supported Ollama version and newer versions are accepted. This confirms both the exact boundary and the normal forward-compatible case.

**Data flow**: It creates version 0.13.4 and version 0.14.0, checks each one, and asserts that both are supported. It does not produce runtime data for the application; it only validates expected behavior during testing.

**Call relations**: This test covers the success path that `ensure_responses_supported` depends on. It uses `assert!` to catch any change that would wrongly reject the cutoff version or a later release.

*Call graph*: 1 external calls (assert!).


### `lmstudio/src/lib.rs`

`orchestration` · `startup when local OSS mode is selected`

This file helps the rest of the program use LM Studio, which is a local app/server for running language models on the user's own machine. When someone asks for open-source local mode with `--oss`, the program needs to make sure there is a reachable LM Studio server and that the requested model is available. Without this step, the main program might try to talk to a missing server or ask for a model that has not been downloaded yet.

The file exposes `LMStudioClient`, the client object used to talk to LM Studio, and defines a default model name to use when the user did not choose one explicitly. Its main job is `ensure_oss_ready`. That function looks at the program configuration, picks either the configured model or the default one, creates a client connected to LM Studio, asks LM Studio which models are already present, and downloads the desired model if it is missing.

One important detail is that loading the model is started in the background. This is like asking a kitchen to preheat the oven while you keep setting the table. The setup function returns once the basic checks and possible download are done, while model loading continues separately. If querying or loading fails, the code logs a warning rather than stopping immediately in every case, because later parts of the program may report a clearer error.

#### Function details

##### `ensure_oss_ready`  (lines 13–46)

```
async fn ensure_oss_ready(config: &Config) -> std::io::Result<()>
```

**Purpose**: Prepares LM Studio for local open-source model use. It chooses the model, checks that LM Studio can be reached, downloads the model if needed, and starts loading it in the background.

**Data flow**: It receives the program `Config`, reads the selected model from it, and falls back to `DEFAULT_OSS_MODEL` if none was provided. It uses that configuration to create an `LMStudioClient`, asks the client for the list of local models, downloads the chosen model if it is not listed, then starts a background task to load the model. It returns success if the required preparation steps complete, or an input/output error if creating the client or downloading the model fails; warnings are logged for non-fatal query or background load failures.

**Call relations**: This function is called during the setup path for `--oss` mode before the main model conversation work begins. Inside it, `LMStudioClient::try_from_provider` builds the connection to the local LM Studio server, and `tokio::spawn` starts the model-loading work without making the caller wait. When LM Studio model listing or background loading fails, it hands that information to the logging system through `tracing::warn!` so the user or developer can see what happened.

*Call graph*: calls 1 internal fn (try_from_provider); 2 external calls (spawn, warn!).


### Connector and MCP discovery
These files fetch connector directories, establish MCP client access, and assemble ChatGPT-visible connector lists and workspace gating settings.

### `connectors/src/lib.rs`

`domain_logic` · `request handling and cross-cutting cache reuse`

Connectors are external apps or services that can appear inside ChatGPT. This file is the main doorway for reading the connector directory. Without it, the system would repeatedly fetch raw directory pages, show duplicate or hidden apps, and miss useful cleanup such as readable names and install links.

The file works like a small catalog clerk. First it checks whether a matching connector list is already saved in memory. If not, some paths can also read an older saved copy from disk. When a fresh list is needed, it asks a caller-provided fetch function for the public directory pages, following page tokens until there are no more pages. If the user belongs to a workspace account, it also asks for workspace-only connectors, but treats that extra request as optional: a failure there gives an empty workspace list instead of failing everything.

After fetching, it removes hidden apps, merges duplicate records by app id, fills in missing details from richer copies, converts raw server records into `AppInfo` records, normalizes blank names and descriptions, builds install URLs, marks accessibility as not yet checked, sorts the result, and writes it to memory and disk caches. The in-memory cache is protected by a mutex, which is a lock that stops two tasks from changing the same saved value at once.

#### Function details

##### `ConnectorDirectoryCacheKey::new`  (lines 39–51)

```
fn new(
        chatgpt_base_url: String,
        account_id: Option<String>,
        chatgpt_user_id: Option<String>,
        is_workspace_account: bool,
    ) -> Self
```

**Purpose**: Builds the identity used to decide whether a cached connector list belongs to the current user and account. It combines the ChatGPT server address, account details, user id, and whether the account is a workspace account.

**Data flow**: It receives four pieces of identity information. It stores them unchanged inside a new `ConnectorDirectoryCacheKey`. The result is a compact key that cache lookups can compare against later.

**Call relations**: Higher-level setup code such as `connector_directory_cache_context`, test helper `cache_key`, and `cached_directory_connectors_for_tool_suggest_with_auth` call this when they need a cache context that is specific to one user/account situation.

*Call graph*: called by 3 (connector_directory_cache_context, cache_key, cached_directory_connectors_for_tool_suggest_with_auth).


##### `cached_directory_connectors`  (lines 89–108)

```
fn cached_directory_connectors(
    cache_context: &ConnectorDirectoryCacheContext,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Returns a previously saved connector list if one is available, without contacting the server. It first tries the fast memory cache, then falls back to the disk cache.

**Data flow**: It receives a cache context, which includes the cache key and disk location. It checks memory for a matching list; if found, it returns a cloned list. If memory misses, it asks the disk cache to load a saved list. On a disk hit, it also copies that list into memory with no freshness time added, then returns it. If both miss, it returns nothing.

**Call relations**: This is used by the disk-cache test path `cached_directory_connectors_reads_directory_disk_cache`. Internally it relies on `cached_directory_connectors_in_memory` for the quick check, `load_cached_directory_connectors_from_disk` for the saved-file check, and `write_cached_directory_connectors_in_memory` to warm memory after a disk hit.

*Call graph*: calls 3 internal fn (cached_directory_connectors_in_memory, load_cached_directory_connectors_from_disk, write_cached_directory_connectors_in_memory); called by 1 (cached_directory_connectors_reads_directory_disk_cache).


##### `cached_directory_connectors_in_memory`  (lines 110–120)

```
fn cached_directory_connectors_in_memory(
    cache_key: &ConnectorDirectoryCacheKey,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Looks for any connector list in the process-wide memory cache that matches the requested cache key. It does not check whether the saved value is expired.

**Data flow**: It receives a cache key. It locks the shared cache, compares the stored key with the requested one, and if they match, clones and returns the connector list. If the cache is empty or belongs to another user/account, it returns nothing.

**Call relations**: `cached_directory_connectors` calls this as its first and fastest lookup step before trying disk storage.

*Call graph*: called by 1 (cached_directory_connectors).


##### `unexpired_directory_connectors_in_memory`  (lines 122–133)

```
fn unexpired_directory_connectors_in_memory(
    cache_key: &ConnectorDirectoryCacheKey,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Looks for a connector list in memory that both belongs to the requested key and has not passed its expiry time. This is the freshness check used before deciding to fetch from the server.

**Data flow**: It receives a cache key, locks the shared memory cache, and reads the saved key, expiry time, and connector list. If the key matches and the current time is still before the expiry, it returns a cloned list. Otherwise it returns nothing.

**Call relations**: `list_all_connectors_with_options` calls this at the start when forced refetching is not requested. It uses the current time to decide whether cached data is still fresh enough.

*Call graph*: called by 1 (list_all_connectors_with_options); 1 external calls (now).


##### `list_all_connectors_with_options`  (lines 135–178)

```
async fn list_all_connectors_with_options(
    cache_context: ConnectorDirectoryCacheContext,
    is_workspace_account: bool,
    force_refetch: bool,
    mut fetch_page: F,
) -> anyhow::Result<Vec<Ap
```

**Purpose**: Fetches, cleans, combines, sorts, and caches the full connector list. This is the main function a caller uses when it wants a ready-to-display list of connectors.

**Data flow**: It receives a cache context, a flag saying whether workspace connectors should be included, a flag that can force a server refresh, and a fetch function that knows how to request one server path. If a fresh memory cache entry exists and refresh is not forced, it returns that. Otherwise it fetches directory pages, optionally fetches workspace connectors, merges duplicates, converts raw directory apps into app records, fills in install URLs, trims names and descriptions, marks them not yet accessibility-checked, sorts them by name and id, saves the result to cache, and returns the list.

**Call relations**: Tests call this to verify shared caching, merging, disk refresh behavior, and normalization. During its run it hands page retrieval to `list_directory_connectors` and `list_workspace_connectors`, combines results through `merge_directory_apps`, formats details through `connector_install_url`, `normalize_connector_name`, and `normalize_connector_value`, checks memory freshness through `unexpired_directory_connectors_in_memory`, and finally stores the result with `write_cached_directory_connectors`.

*Call graph*: calls 8 internal fn (connector_install_url, list_directory_connectors, list_workspace_connectors, merge_directory_apps, normalize_connector_name, normalize_connector_value, unexpired_directory_connectors_in_memory, write_cached_directory_connectors); called by 4 (cached_directory_connectors_reads_directory_disk_cache, list_all_connectors_merges_and_normalizes_directory_apps, list_all_connectors_refreshes_when_only_directory_disk_cache_exists, list_all_connectors_uses_shared_directory_cache).


##### `write_cached_directory_connectors`  (lines 180–190)

```
fn write_cached_directory_connectors(
    cache_context: &ConnectorDirectoryCacheContext,
    connectors: &[AppInfo],
)
```

**Purpose**: Saves a finished connector list in both memory and disk caches. This makes later connector lookups faster and available across process restarts through the disk copy.

**Data flow**: It receives the cache context and the finished list of app records. It writes a copy into the in-memory cache with the standard one-hour time-to-live, then asks the disk cache module to write the same list to a file.

**Call relations**: `list_all_connectors_with_options` calls this after it has fetched and cleaned a fresh connector list. It delegates to `write_cached_directory_connectors_in_memory` for the fast cache and `write_cached_directory_connectors_to_disk` for persistent storage.

*Call graph*: calls 2 internal fn (write_cached_directory_connectors_to_disk, write_cached_directory_connectors_in_memory); called by 1 (list_all_connectors_with_options).


##### `write_cached_directory_connectors_in_memory`  (lines 192–205)

```
fn write_cached_directory_connectors_in_memory(
    cache_key: ConnectorDirectoryCacheKey,
    connectors: &[AppInfo],
    ttl: Duration,
)
```

**Purpose**: Replaces the process-wide memory cache with a connector list for one cache key. It also records when that saved list should expire.

**Data flow**: It receives a cache key, a slice of connector records, and a time-to-live duration. It locks the shared cache, copies the connector records into an owned vector, sets the expiry to now plus the given duration, and stores the new cache entry.

**Call relations**: `write_cached_directory_connectors` uses this after a fresh server fetch. `cached_directory_connectors` also uses it after loading from disk, so later reads can be served from memory.

*Call graph*: called by 2 (cached_directory_connectors, write_cached_directory_connectors); 2 external calls (now, to_vec).


##### `list_directory_connectors`  (lines 207–238)

```
async fn list_directory_connectors(fetch_page: &mut F) -> anyhow::Result<Vec<DirectoryApp>>
```

**Purpose**: Fetches every page of the public connector directory. It follows server-provided page tokens until the directory is fully read.

**Data flow**: It receives a mutable fetch function. It starts with the first directory path, calls the fetch function, keeps non-hidden apps from the response, reads and trims the next-page token, URL-encodes that token for the next request, and repeats until no token remains. It returns all collected directory apps.

**Call relations**: `list_all_connectors_with_options` calls this when it needs fresh public directory data. The test `list_directory_connectors_omits_tier_for_all_pages` calls it directly to check the exact paths it asks for across multiple pages.

*Call graph*: called by 2 (list_all_connectors_with_options, list_directory_connectors_omits_tier_for_all_pages); 3 external calls (new, format!, encode).


##### `list_workspace_connectors`  (lines 240–255)

```
async fn list_workspace_connectors(fetch_page: &mut F) -> anyhow::Result<Vec<DirectoryApp>>
```

**Purpose**: Fetches connectors that are available through a workspace account. It deliberately treats failure as non-fatal so the ordinary connector list can still be shown.

**Data flow**: It receives the same kind of fetch function used for directory pages. It requests the workspace connector path, filters out hidden apps if the request succeeds, and returns those apps. If the request fails, it returns an empty list instead of an error.

**Call relations**: `list_all_connectors_with_options` calls this only when the account is marked as a workspace account, then adds the returned apps to the public directory apps before merging.

*Call graph*: called by 1 (list_all_connectors_with_options); 1 external calls (new).


##### `merge_directory_apps`  (lines 257–267)

```
fn merge_directory_apps(apps: Vec<DirectoryApp>) -> Vec<DirectoryApp>
```

**Purpose**: Combines duplicate directory entries that share the same app id. This matters because the same connector can appear in both public and workspace responses, sometimes with different fields filled in.

**Data flow**: It receives a list of raw directory apps. It builds a map keyed by app id. The first app for an id is stored; later apps with the same id are folded into the existing one using `merge_directory_app`. It returns one app per id.

**Call relations**: `list_all_connectors_with_options` calls this after fetching public and possible workspace apps. It delegates the detailed field-by-field combining rules to `merge_directory_app`.

*Call graph*: calls 1 internal fn (merge_directory_app); called by 1 (list_all_connectors_with_options); 1 external calls (new).


##### `merge_directory_app`  (lines 269–407)

```
fn merge_directory_app(existing: &mut DirectoryApp, incoming: DirectoryApp)
```

**Purpose**: Fills missing or weak details in one directory app using another app record with the same id. It tries to keep useful existing data while adding better incoming data.

**Data flow**: It receives an existing app record by mutable reference and an incoming app record. It uses a non-empty incoming name only if the existing name is blank, replaces the description when the incoming description is present and not just spaces, fills missing logo and distribution fields, merges missing branding and metadata subfields, and fills labels only if none exist. It changes the existing record in place and returns no separate value.

**Call relations**: `merge_directory_apps` calls this whenever it finds a duplicate app id. It is the detailed rulebook behind the broader deduplication step.

*Call graph*: called by 1 (merge_directory_apps).


##### `is_hidden_directory_app`  (lines 409–411)

```
fn is_hidden_directory_app(app: &DirectoryApp) -> bool
```

**Purpose**: Checks whether a raw directory app is marked as hidden by the server. Hidden apps should not appear in the user-facing connector list.

**Data flow**: It receives a directory app and looks at its visibility text. If that text is exactly `HIDDEN`, it returns true; otherwise it returns false.

**Call relations**: This check is part of the filtering step used while building lists from directory responses, so hidden records are dropped before merging and display preparation.

*Call graph*: 1 external calls (matches!).


##### `directory_app_to_app_info`  (lines 413–429)

```
fn directory_app_to_app_info(app: DirectoryApp) -> AppInfo
```

**Purpose**: Converts the raw server shape for a directory app into the app shape used by the rest of the application. It also sets safe default values for fields the directory response does not provide directly.

**Data flow**: It receives a `DirectoryApp`. It moves over identity, name, description, logo, branding, metadata, labels, and distribution information. It sets install URL to none for later filling, marks accessibility as false, marks the app enabled, and starts plugin display names as an empty list. It returns an `AppInfo`.

**Call relations**: `list_all_connectors_with_options` uses this conversion while preparing fetched apps. The refresh-related test also calls it to build an expected app record before comparing results.

*Call graph*: called by 1 (list_all_connectors_refreshes_when_only_directory_disk_cache_exists); 1 external calls (new).


##### `connector_install_url`  (lines 431–434)

```
fn connector_install_url(name: &str, connector_id: &str) -> String
```

**Purpose**: Builds the ChatGPT web URL where a user can install or view a connector. It includes a readable name slug and the connector id.

**Data flow**: It receives a connector name and connector id. It turns the name into a URL-friendly slug through `connector_name_slug`, then formats `https://chatgpt.com/apps/{slug}/{connector_id}` and returns that string.

**Call relations**: `list_all_connectors_with_options` calls this when a connector does not already have an install URL. A test also calls it when constructing expected connector data.

*Call graph*: calls 1 internal fn (connector_name_slug); called by 2 (list_all_connectors_with_options, list_all_connectors_refreshes_when_only_directory_disk_cache_exists); 1 external calls (format!).


##### `connector_name_slug`  (lines 436–451)

```
fn connector_name_slug(name: &str) -> String
```

**Purpose**: Turns a connector name into the readable part of an install URL. For example, spaces and punctuation become dashes, and letters become lowercase.

**Data flow**: It receives a name string. It walks through each character, keeps ASCII letters and numbers as lowercase, replaces everything else with `-`, trims dashes from the ends, and returns `app` if nothing usable remains.

**Call relations**: `connector_install_url` calls this before formatting the final ChatGPT app URL.

*Call graph*: called by 1 (connector_install_url); 1 external calls (with_capacity).


##### `normalize_connector_name`  (lines 453–460)

```
fn normalize_connector_name(name: &str, connector_id: &str) -> String
```

**Purpose**: Cleans up a connector name so the display list does not show leading/trailing spaces or a blank name. If the name is blank, it falls back to the connector id.

**Data flow**: It receives a name and connector id. It trims whitespace from the name. If anything remains, it returns the trimmed name; otherwise it returns the id as the display name.

**Call relations**: `list_all_connectors_with_options` applies this to every connector after converting from raw directory data.

*Call graph*: called by 1 (list_all_connectors_with_options).


##### `normalize_connector_value`  (lines 462–467)

```
fn normalize_connector_value(value: Option<&str>) -> Option<String>
```

**Purpose**: Cleans optional text fields such as descriptions. Empty or whitespace-only text becomes absent instead of being shown as a blank value.

**Data flow**: It receives an optional string reference. If a value exists, it trims whitespace. If the trimmed value is non-empty, it returns it as a new string; otherwise it returns nothing.

**Call relations**: `list_all_connectors_with_options` uses this when preparing each connector description for the final list.

*Call graph*: called by 1 (list_all_connectors_with_options).


##### `tests::cache_key`  (lines 482–489)

```
fn cache_key(id: &str) -> ConnectorDirectoryCacheKey
```

**Purpose**: Creates a realistic test cache key from a short id. This lets tests make separate fake users or accounts without repeating setup code.

**Data flow**: It receives an id string. It builds a fixed fake ChatGPT base URL, account id, user id, and workspace flag, then calls `ConnectorDirectoryCacheKey::new`. It returns the resulting key.

**Call relations**: The test helper `tests::cache_context` calls this while building full cache contexts for the cache-related tests.

*Call graph*: calls 1 internal fn (new); 1 external calls (format!).


##### `tests::cache_context`  (lines 491–493)

```
fn cache_context(codex_home: &TempDir, id: &str) -> ConnectorDirectoryCacheContext
```

**Purpose**: Creates a test cache context rooted in a temporary directory. This gives each test its own disk cache location.

**Data flow**: It receives a temporary directory and a short id. It takes the directory path, builds a matching cache key through `tests::cache_key`, and returns a `ConnectorDirectoryCacheContext`.

**Call relations**: The connector cache tests call this before using `list_all_connectors_with_options` or `cached_directory_connectors`, so each test can isolate its cache files.

*Call graph*: calls 1 internal fn (new); 2 external calls (path, cache_key).


##### `tests::clear_directory_memory_cache`  (lines 495–500)

```
fn clear_directory_memory_cache()
```

**Purpose**: Empties the shared in-memory connector cache during tests. This lets tests simulate a fresh process or force code to look at disk.

**Data flow**: It takes no input. It locks the global memory cache and replaces the stored entry with nothing. It returns no value but changes shared test state.

**Call relations**: Disk-cache tests call this before checking behavior that should not depend on a previous in-memory result.


##### `tests::app`  (lines 502–515)

```
fn app(id: &str, name: &str) -> DirectoryApp
```

**Purpose**: Builds a simple fake directory app for tests. It fills only the id and name, leaving optional fields absent.

**Data flow**: It receives an id and name. It creates a `DirectoryApp` with those values and sets description, metadata, branding, labels, logos, distribution channel, and visibility to none. It returns the fake app.

**Call relations**: Several tests use this helper to create compact input data for fetching, merging, and expected-result checks.


##### `tests::list_all_connectors_uses_shared_directory_cache`  (lines 522–560)

```
async fn list_all_connectors_uses_shared_directory_cache() -> anyhow::Result<()>
```

**Purpose**: Checks that a second connector listing call can reuse the in-memory cache instead of calling the fetch function again. This protects the intended fast path.

**Data flow**: It creates a temporary cache context and a counter. The first call to `list_all_connectors_with_options` returns one fake app and increments the counter. The second call supplies a fetch function that would fail if used. The test verifies only one fetch happened and both returned lists match.

**Call relations**: This test drives `list_all_connectors_with_options` twice and uses `tests::cache_context` for setup. It confirms the relationship between listing and the shared memory cache.

*Call graph*: calls 1 internal fn (list_all_connectors_with_options); 6 external calls (clone, new, new, new, assert_eq!, cache_context).


##### `tests::list_all_connectors_merges_and_normalizes_directory_apps`  (lines 567–638)

```
async fn list_all_connectors_merges_and_normalizes_directory_apps() -> anyhow::Result<()>
```

**Purpose**: Checks that directory and workspace entries are combined correctly, hidden apps are dropped, and final connector fields are cleaned up.

**Data flow**: It creates fake public and workspace responses, including duplicate app ids, a blank workspace name, a richer description and branding, and one hidden app. It calls `list_all_connectors_with_options` with workspace fetching enabled. It then checks the call count, final app count, normalized names, merged description, install URL, branding field, and sorted result.

**Call relations**: This test exercises the main listing flow plus its helper steps: fetching public and workspace connectors, merging duplicates, filtering hidden apps, normalizing values, and creating install URLs.

*Call graph*: calls 1 internal fn (list_all_connectors_with_options); 6 external calls (clone, new, new, new, assert_eq!, cache_context).


##### `tests::cached_directory_connectors_reads_directory_disk_cache`  (lines 645–677)

```
async fn cached_directory_connectors_reads_directory_disk_cache() -> anyhow::Result<()>
```

**Purpose**: Checks that a connector list written by a fresh fetch can later be read from disk after memory has been cleared. This verifies persistence beyond the in-memory cache.

**Data flow**: It fetches one fake connector through `list_all_connectors_with_options`, clears the memory cache, then calls `cached_directory_connectors`. It verifies the fetch counter did not increase and the disk-loaded list equals the original list.

**Call relations**: This test first uses `list_all_connectors_with_options` to populate caches, then uses `tests::clear_directory_memory_cache` and `cached_directory_connectors` to prove the disk fallback works.

*Call graph*: calls 2 internal fn (cached_directory_connectors, list_all_connectors_with_options); 7 external calls (clone, new, new, new, assert_eq!, cache_context, clear_directory_memory_cache).


##### `tests::list_all_connectors_refreshes_when_only_directory_disk_cache_exists`  (lines 684–744)

```
async fn list_all_connectors_refreshes_when_only_directory_disk_cache_exists() -> anyhow::Result<()>
```

**Purpose**: Checks that the main listing function does not treat a disk-only cache as a fresh in-memory cache. It should refresh from the server when memory has been cleared.

**Data flow**: It first fetches and caches an `alpha` connector, clears memory, and confirms `cached_directory_connectors` can still read `alpha` from disk. Then it calls `list_all_connectors_with_options` again with a fetch function returning `beta`. It verifies a second fetch occurred and the final result is the refreshed `beta` connector.

**Call relations**: This test combines `list_all_connectors_with_options`, `cached_directory_connectors`, `directory_app_to_app_info`, and `connector_install_url` to compare both cached and refreshed results.

*Call graph*: calls 3 internal fn (connector_install_url, directory_app_to_app_info, list_all_connectors_with_options); 8 external calls (clone, new, new, new, assert_eq!, app, cache_context, clear_directory_memory_cache).


##### `tests::cached_directory_connectors_drops_stale_disk_schema`  (lines 747–766)

```
async fn cached_directory_connectors_drops_stale_disk_schema() -> anyhow::Result<()>
```

**Purpose**: Checks that an old or incompatible disk cache file is rejected and removed. This keeps stale saved data from confusing newer code.

**Data flow**: It clears memory, creates a temporary cache file with an old schema version, then calls `cached_directory_connectors`. It expects no cached connectors and verifies the stale file no longer exists.

**Call relations**: This test uses `tests::cache_context` and `tests::clear_directory_memory_cache`, then exercises the disk-loading path reached through `cached_directory_connectors`.

*Call graph*: 9 external calls (new, assert!, assert_eq!, cache_context, clear_directory_memory_cache, json!, to_vec_pretty, create_dir_all, write).


##### `tests::list_directory_connectors_omits_tier_for_all_pages`  (lines 769–814)

```
async fn list_directory_connectors_omits_tier_for_all_pages() -> anyhow::Result<()>
```

**Purpose**: Checks the exact request paths used when reading multiple directory pages. In particular, it ensures the directory calls include external logos and do not add an unwanted tier parameter.

**Data flow**: It records every path passed to the fake fetch function. The first response includes one app and a next-page token containing a space. The second response returns another app and no token. The test checks both app ids were collected and the second path used a URL-encoded token.

**Call relations**: This test calls `list_directory_connectors` directly, isolating the pagination path-building behavior from the larger connector listing flow.

*Call graph*: calls 1 internal fn (list_directory_connectors); 5 external calls (clone, new, new, new, assert_eq!).


### `rmcp-client/src/rmcp_client.rs`

`orchestration` · `startup, request handling, session recovery, shutdown`

MCP, or Model Context Protocol, lets this program ask an outside server for tools and resources. This file is the central bridge between the rest of the project and those MCP servers. Without it, callers would have to know many low-level details: whether the server is in-process, launched over standard input/output, or reached over HTTP; how the initial handshake works; when OAuth access tokens need refreshing; and how to recover when a remote HTTP session expires.

The main type, `RmcpClient`, acts like a travel adapter. The rest of the code can ask for “list tools,” “read this resource,” or “call this tool,” while this file converts that into the right MCP SDK calls over the chosen transport. It also keeps track of the client state: not initialized yet, ready, or closed.

A notable detail is elicitation. Elicitation is when the MCP server asks the user interface for extra input while another operation is waiting. Timeouts should not punish the server while the user is answering. The pause-state helpers in this file make request timeouts count only active waiting time, not user-response time.

For HTTP servers, this file also handles OAuth token loading, refreshing, saving, and fallback behavior. If a streamable HTTP session disappears with a session-expired 404 error, the client rebuilds the transport and repeats the initialization handshake before retrying the operation.

#### Function details

##### `ElicitationPauseState::new`  (lines 147–153)

```
fn new() -> Self
```

**Purpose**: Creates the shared pause tracker used to tell request timeouts when the client is waiting on user input. It starts in the unpaused state.

**Data flow**: It receives no outside data. It creates a counter set to zero and a watch channel, which is a small notification pipe that broadcasts whether the client is paused. It returns an `ElicitationPauseState` that can be cloned and shared.

**Call relations**: Each client constructor creates one of these when building an `RmcpClient`. The test also creates one directly to prove timeout pausing works.

*Call graph*: called by 4 (new_in_process_client, new_stdio_client, new_streamable_http_client, active_time_timeout_pauses_while_elicitation_is_pending); 3 external calls (new, new, channel).


##### `ElicitationPauseState::enter`  (lines 155–162)

```
fn enter(&self) -> ElicitationPauseGuard
```

**Purpose**: Marks the start of a period where normal operation timeouts should pause because the UI is being asked for input. It returns a guard object that automatically unpauses later.

**Data flow**: It reads and increases the active pause counter. If this is the first active pause, it broadcasts `true` to say timeouts should pause. It returns an `ElicitationPauseGuard` tied to the same state.

**Call relations**: The elicitation flow calls this when creating an elicitation request. The returned guard keeps the pause active until that elicitation work is finished and the guard is dropped.

*Call graph*: called by 1 (create_elicitation); 1 external calls (send_replace).


##### `ElicitationPauseState::subscribe`  (lines 164–166)

```
fn subscribe(&self) -> watch::Receiver<bool>
```

**Purpose**: Creates a listener that can watch whether elicitation is currently pausing timeout countdowns.

**Data flow**: It reads the shared watch channel inside the pause state and returns a receiver connected to future pause/unpause changes.

**Call relations**: `run_service_operation_once` uses this listener before running a timed operation, so `active_time_timeout` can stop counting time while an elicitation is pending.

*Call graph*: called by 1 (run_service_operation_once); 1 external calls (subscribe).


##### `ElicitationPauseGuard::drop`  (lines 174–178)

```
fn drop(&mut self)
```

**Purpose**: Automatically ends one active elicitation pause when the guard goes out of scope. This prevents callers from having to remember a separate cleanup call.

**Data flow**: It decreases the active pause counter. If that was the last active pause, it broadcasts `false` so waiting operations know timeout counting can resume.

**Call relations**: This is the cleanup half of `ElicitationPauseState::enter`. Any code that receives the guard gets automatic unpause behavior when the guard is dropped.


##### `active_time_timeout`  (lines 181–225)

```
async fn active_time_timeout(
    duration: Duration,
    mut pause_state: watch::Receiver<bool>,
    operation: Fut,
) -> std::result::Result<T, ()>
```

**Purpose**: Runs an asynchronous operation with a timeout that counts only active time. If the client is paused for elicitation, the timeout clock stops until the pause ends.

**Data flow**: It takes a maximum duration, a pause listener, and the operation to run. It watches both the operation and the pause state. It returns the operation result if it finishes in active time, or an error marker if the active-time budget runs out.

**Call relations**: `run_service_operation_once` uses this for MCP calls with timeouts. The test calls it directly to check that elicitation pause time does not count against the timeout.

*Call graph*: called by 2 (run_service_operation_once, active_time_timeout_pauses_while_elicitation_is_pending); 4 external calls (now, borrow_and_update, pin!, select!).


##### `remaining_operation_timeout`  (lines 235–252)

```
fn remaining_operation_timeout(
    label: &str,
    timeout: Option<Duration>,
    deadline: Option<Instant>,
) -> std::result::Result<Option<Duration>, ClientOperationError>
```

**Purpose**: Calculates how much timeout budget is left before a retry attempt starts. It turns an already-expired deadline into a clear timeout error.

**Data flow**: It receives a human-readable operation label, the original timeout, and an optional deadline. If there is no deadline, it returns no timeout. If the deadline has passed, it returns a timeout error. Otherwise, it returns the remaining duration.

**Call relations**: `run_service_operation_with_transient_retries` uses this before each retry so the total retry sequence respects the caller’s original timeout.

*Call graph*: called by 1 (run_service_operation_with_transient_retries); 1 external calls (now).


##### `ElicitationResponse::from`  (lines 266–272)

```
fn from(value: CreateElicitationResult) -> Self
```

**Purpose**: Converts the MCP SDK’s elicitation result type into this crate’s simpler `ElicitationResponse` type.

**Data flow**: It takes a `CreateElicitationResult`, copies over the user action and optional content, sets metadata to none, and returns an `ElicitationResponse`.

**Call relations**: This conversion lets code at this crate boundary work with its own response type while still accepting results from the MCP SDK.


##### `CreateElicitationResult::from`  (lines 276–282)

```
fn from(value: ElicitationResponse) -> Self
```

**Purpose**: Converts this crate’s `ElicitationResponse` back into the MCP SDK’s expected elicitation result type.

**Data flow**: It takes an `ElicitationResponse`, copies over the action and content, drops metadata by setting it to none, and returns a `CreateElicitationResult`.

**Call relations**: This is the reverse bridge of `ElicitationResponse::from`, used when responses need to be handed back to the MCP SDK.


##### `RmcpClient::new_in_process_client`  (lines 314–332)

```
async fn new_in_process_client(
        factory: Arc<dyn InProcessTransportFactory>,
    ) -> io::Result<Self>
```

**Purpose**: Builds an MCP client connected to a server running inside the same process. This is useful when no external process or network connection is needed.

**Data flow**: It receives an in-process transport factory. It stores that factory as the recipe for future reconnection, opens the first transport, creates the initial connecting state, and returns a new `RmcpClient`.

**Call relations**: This constructor prepares the client but does not complete the MCP handshake. Later, `initialize` consumes the pending transport and turns it into a ready service.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, create_pending_transport, new).


##### `RmcpClient::new_stdio_client`  (lines 334–366)

```
async fn new_stdio_client(
        program: OsString,
        args: Vec<OsString>,
        env: Option<HashMap<OsString, OsString>>,
        env_vars: &[McpServerEnvVar],
        cwd: Option<PathBuf>,
```

**Purpose**: Builds an MCP client that talks to a server launched as a child process over standard input and output. Standard input/output here means the ordinary text streams processes use to talk to each other.

**Data flow**: It receives the program, arguments, environment settings, working directory, and launcher. It builds a launch command, starts the server transport, saves a process handle when one exists, and returns a client in the connecting state.

**Call relations**: Higher-level client-building code uses this for local MCP servers. The saved process handle lets `shutdown` later terminate the server process owned by this client.

*Call graph*: calls 2 internal fn (new, new); called by 4 (make_rmcp_client, drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation, rmcp_client_can_list_and_read_resources); 4 external calls (new, create_pending_transport, new, to_vec).


##### `RmcpClient::new_streamable_http_client`  (lines 369–402)

```
async fn new_streamable_http_client(
        server_name: &str,
        url: &str,
        bearer_token: Option<String>,
        http_headers: Option<HashMap<String, String>>,
        env_http_headers
```

**Purpose**: Builds an MCP client that reaches a remote server over streamable HTTP. It can use bearer-token authentication, custom headers, OAuth token storage, or a shared authentication provider.

**Data flow**: It receives the server name, URL, authentication/header settings, token-storage settings, HTTP client, and optional auth provider. It stores all of that as a transport recipe, creates the first HTTP transport, and returns a client in the connecting state.

**Call relations**: Remote-client setup code calls this before `initialize`. If the HTTP session later expires, the saved recipe lets `reinitialize_after_session_expiry` create a fresh transport.

*Call graph*: calls 1 internal fn (new); called by 4 (make_rmcp_client, oauth_startup_child, create_client_with_http_client, create_remote_client); 3 external calls (new, create_pending_transport, new).


##### `RmcpClient::initialize`  (lines 406–469)

```
async fn initialize(
        &self,
        params: InitializeRequestParams,
        timeout: Option<Duration>,
        send_elicitation: SendElicitation,
    ) -> Result<InitializeResult>
```

**Purpose**: Performs the MCP initialization handshake and moves the client from “connecting” to “ready.” This is the point where the client and server agree they can talk.

**Data flow**: It receives initialization parameters, an optional timeout, and a function for sending elicitation requests to the UI. It builds the client-side service, takes the pending transport, connects with handshake retries, records the initialization context for future recovery, stores the ready service, persists OAuth tokens if needed, and returns the server’s initialization result.

**Call relations**: The general initialization flow calls this after constructing a client. Most public request methods depend on it because `service` will refuse work until the client is ready.

*Call graph*: calls 1 internal fn (new); called by 1 (initialize_client); 5 external calls (clone, anyhow!, matches!, clone, warn!).


##### `RmcpClient::list_tools`  (lines 471–485)

```
async fn list_tools(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListToolsResult>
```

**Purpose**: Asks the MCP server which tools it offers. Tools are callable actions the server makes available to the client.

**Data flow**: It receives optional pagination information and an optional timeout. It refreshes OAuth if needed, runs the `tools/list` operation through the common service-operation path, persists OAuth changes afterward, and returns the server’s tool list.

**Call relations**: It uses `run_service_operation`, so it benefits from timeout handling, selected retry behavior, and session-expiry recovery.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::list_tools_with_connector_ids`  (lines 487–522)

```
async fn list_tools_with_connector_ids(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListToolsWithConnectorIdResult>
```

**Purpose**: Asks for tools and then enriches each tool with connector information found in the tool metadata. A connector is the outside integration or source that a tool belongs to.

**Data flow**: It receives optional pagination information and an optional timeout. It refreshes OAuth, lists tools, reads connector id/name/description fields from each tool’s metadata, persists OAuth changes, and returns the tools wrapped with those connector details.

**Call relations**: Like `list_tools`, it goes through `run_service_operation`. It then uses `meta_string` to safely extract readable metadata values.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::meta_string`  (lines 524–530)

```
fn meta_string(meta: Option<&rmcp::model::Meta>, key: &str) -> Option<String>
```

**Purpose**: Pulls a non-empty string field out of an optional metadata map. It trims whitespace and ignores missing, non-string, or blank values.

**Data flow**: It receives optional metadata and a key name. It looks up that key, checks that the value is a string, trims it, and returns a `String` only if something meaningful remains.

**Call relations**: `list_tools_with_connector_ids` uses this small helper to read connector-related fields without repeating the same validation logic.


##### `RmcpClient::list_resources`  (lines 532–546)

```
async fn list_resources(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListResourcesResult>
```

**Purpose**: Asks the MCP server which resources it offers. Resources are pieces of data the server can expose for reading.

**Data flow**: It receives optional pagination information and an optional timeout. It refreshes OAuth, runs the `resources/list` request, persists OAuth token changes, and returns the list of resources.

**Call relations**: This follows the same common request path as tool listing, so errors, timeouts, and session recovery behave consistently.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::list_resource_templates`  (lines 548–562)

```
async fn list_resource_templates(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListResourceTemplatesResult>
```

**Purpose**: Asks the MCP server for resource templates, which describe patterns for resources that can be read later.

**Data flow**: It receives optional pagination information and an optional timeout. It refreshes OAuth, sends the `resources/templates/list` operation, persists OAuth changes, and returns the templates.

**Call relations**: It delegates the actual server call to `run_service_operation`, matching the client’s standard request behavior.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::read_resource`  (lines 564–578)

```
async fn read_resource(
        &self,
        params: ReadResourceRequestParams,
        timeout: Option<Duration>,
    ) -> Result<ReadResourceResult>
```

**Purpose**: Reads a specific resource from the MCP server.

**Data flow**: It receives resource-read parameters and an optional timeout. It refreshes OAuth, sends the read request through the common operation runner, persists OAuth changes, and returns the resource contents.

**Call relations**: Callers use this after discovering resources with `list_resources` or templates with `list_resource_templates`. The common runner provides timeout and recovery behavior.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::call_tool`  (lines 580–636)

```
async fn call_tool(
        &self,
        name: String,
        arguments: Option<serde_json::Value>,
        meta: Option<serde_json::Value>,
        timeout: Option<Duration>,
    ) -> Result<CallT
```

**Purpose**: Calls a named MCP tool with JSON arguments and optional request metadata. It validates the shape of the JSON before sending so the server receives what the MCP protocol expects.

**Data flow**: It receives a tool name, optional arguments, optional metadata, and an optional timeout. It checks that arguments and metadata are JSON objects when present, builds MCP call parameters, sends the request, checks that the response is really a tool-call result, persists OAuth changes, and returns the result.

**Call relations**: Tests and higher-level code use this to execute tools. Internally it still goes through `run_service_operation`, but it sends a lower-level request so it can attach `_meta` options.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation); called by 1 (call_echo_tool); 3 external calls (new, anyhow!, Meta).


##### `RmcpClient::send_custom_notification`  (lines 638–666)

```
async fn send_custom_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<()>
```

**Purpose**: Sends a custom MCP notification to the server. A notification is a one-way message where no response is expected.

**Data flow**: It receives a method name and optional JSON parameters. It refreshes OAuth, wraps the data as a custom notification, sends it through the running service, persists OAuth changes, and returns success or an error.

**Call relations**: This gives callers an escape hatch for protocol extensions while still using the same OAuth and service-operation machinery as built-in calls.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::send_custom_request`  (lines 668–689)

```
async fn send_custom_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<ServerResult>
```

**Purpose**: Sends a custom MCP request to the server and waits for the server’s response.

**Data flow**: It receives a method name and optional JSON parameters. It refreshes OAuth, wraps the data as a custom request, sends it through the running service, persists OAuth changes, and returns the server result.

**Call relations**: Like custom notifications, this supports extensions. Unlike notifications, it expects a reply from the server.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::service`  (lines 691–698)

```
async fn service(&self) -> Result<Arc<RunningService<RoleClient, ElicitationClientService>>>
```

**Purpose**: Gets the currently running MCP service if the client is ready. It gives request code a safe way to refuse work before initialization or after shutdown.

**Data flow**: It reads the client state under a mutex, which is a lock that prevents two tasks from changing the state at the same time. If ready, it returns a shared pointer to the service. If connecting or closed, it returns a clear error.

**Call relations**: `run_service_operation` calls this before every normal operation, so all request methods share the same readiness checks.

*Call graph*: called by 1 (run_service_operation); 2 external calls (clone, anyhow!).


##### `RmcpClient::oauth_persistor`  (lines 700–709)

```
async fn oauth_persistor(&self) -> Option<OAuthPersistor>
```

**Purpose**: Finds the OAuth helper attached to the ready client, if one exists. The helper knows how to refresh and save OAuth tokens.

**Data flow**: It reads the client state. If the client is ready and has an OAuth persistor, it returns a clone of it; otherwise it returns nothing.

**Call relations**: `refresh_oauth_if_needed` and `persist_oauth_tokens` use this so request methods do not need to know whether the current transport uses OAuth.

*Call graph*: called by 2 (persist_oauth_tokens, refresh_oauth_if_needed).


##### `RmcpClient::shutdown`  (lines 712–725)

```
async fn shutdown(&self)
```

**Purpose**: Closes the MCP client and stops any child stdio server process owned by it.

**Data flow**: It replaces the current state with `Closed`. If a child process handle exists, it asks that process to terminate and logs a warning if termination fails. Dropping the previous state lets underlying service resources be cleaned up.

**Call relations**: This is the teardown path for clients. It also protects later operations because `service` and initialization checks will see the closed state.

*Call graph*: 2 external calls (replace, warn!).


##### `RmcpClient::persist_oauth_tokens`  (lines 729–735)

```
async fn persist_oauth_tokens(&self)
```

**Purpose**: Saves OAuth tokens after an operation, if the operation caused them to change. This prevents refreshed tokens from being lost.

**Data flow**: It asks `oauth_persistor` for the current OAuth helper. If one exists, it calls its save-if-needed method and logs a warning if saving fails.

**Call relations**: All public request methods call this after successful operation flow. That keeps token storage up to date without duplicating OAuth code in every method.

*Call graph*: calls 1 internal fn (oauth_persistor); called by 8 (call_tool, list_resource_templates, list_resources, list_tools, list_tools_with_connector_ids, read_resource, send_custom_notification, send_custom_request); 1 external calls (warn!).


##### `RmcpClient::refresh_oauth_if_needed`  (lines 737–743)

```
async fn refresh_oauth_if_needed(&self)
```

**Purpose**: Refreshes OAuth tokens before an operation when they are stale or near expiry. OAuth is an authorization system where short-lived access tokens can be renewed using stored credentials.

**Data flow**: It asks `oauth_persistor` for the current OAuth helper. If one exists, it tries to refresh tokens and logs a warning if refresh fails.

**Call relations**: All public request methods call this before talking to the server. The operation may still proceed, but the client makes a best effort to avoid using expired credentials.

*Call graph*: calls 1 internal fn (oauth_persistor); called by 8 (call_tool, list_resource_templates, list_resources, list_tools, list_tools_with_connector_ids, read_resource, send_custom_notification, send_custom_request); 1 external calls (warn!).


##### `RmcpClient::create_pending_transport`  (lines 745–852)

```
async fn create_pending_transport(
        transport_recipe: &TransportRecipe,
    ) -> Result<PendingTransport>
```

**Purpose**: Creates the not-yet-initialized communication channel described by a saved transport recipe. A transport is the path bytes travel on, such as in-process pipes, stdio, or HTTP.

**Data flow**: It receives a transport recipe. For in-process and stdio recipes, it opens or launches the transport. For HTTP recipes, it builds default headers, loads stored OAuth tokens when appropriate, chooses between OAuth-aware HTTP transport or plain bearer/header transport, and returns a `PendingTransport`.

**Call relations**: The client constructors call this for the first connection. Session recovery also calls it later to rebuild the same kind of connection after an HTTP session expires.

*Call graph*: calls 3 internal fn (new, create_oauth_transport_and_runtime, build_default_headers); 5 external calls (clone, with_client, with_uri, load_oauth_tokens, warn!).


##### `RmcpClient::connect_pending_transport`  (lines 854–912)

```
async fn connect_pending_transport(
        pending_transport: PendingTransport,
        client_service: ElicitationClientService,
        timeout: Option<Duration>,
    ) -> Result<(
        Arc<Runn
```

**Purpose**: Turns a pending transport into a running MCP service by performing the SDK’s client-serving handshake. It also carries through any OAuth persistor attached to that transport.

**Data flow**: It receives a pending transport, the local client service, and an optional timeout. It starts the MCP SDK service over the right transport, waits for the handshake, converts handshake failures into clearer errors, persists OAuth tokens after failed initialization when needed, and returns the running service plus optional OAuth helper.

**Call relations**: Initialization and recovery use this lower-level connection step. In this file, the higher-level path calls a retrying wrapper around it for initialization attempts.

*Call graph*: 5 external calls (new, anyhow!, serve_client, timeout, warn!).


##### `RmcpClient::run_service_operation`  (lines 914–950)

```
async fn run_service_operation(
        &self,
        label: &str,
        timeout: Option<Duration>,
        operation: F,
    ) -> Result<T>
```

**Purpose**: Runs one MCP operation against the ready service using the client’s shared safety rules. Those rules include readiness checks, transient retries, and recovery from expired HTTP sessions.

**Data flow**: It receives a label, optional timeout, and operation closure. It gets the ready service, runs the operation with transient retry logic, and if it sees the special session-expired 404 error, it reinitializes the client and tries the operation again on the recovered service.

**Call relations**: All public request methods use this instead of calling the service directly. It is the common funnel that keeps behavior consistent.

*Call graph*: calls 2 internal fn (reinitialize_after_session_expiry, service); called by 8 (call_tool, list_resource_templates, list_resources, list_tools, list_tools_with_connector_ids, read_resource, send_custom_notification, send_custom_request); 4 external calls (clone, is_session_expired_404, run_service_operation_with_transient_retries, clone).


##### `RmcpClient::run_service_operation_with_transient_retries`  (lines 952–1006)

```
async fn run_service_operation_with_transient_retries(
        service: Arc<RunningService<RoleClient, ElicitationClientService>>,
        label: &str,
        timeout: Option<Duration>,
        pause
```

**Purpose**: Retries selected temporary failures while respecting the caller’s total timeout. At present, it applies this retry behavior to a specific streamable HTTP `tools/list` startup problem.

**Data flow**: It receives the service, operation label, optional timeout, pause state, and operation closure. It computes a retry deadline, runs attempts one by one, waits between retryable failures, stops when the operation succeeds, and returns a timeout or final error if it cannot complete in time.

**Call relations**: `run_service_operation` calls this before deciding whether session recovery is needed. It calls `remaining_operation_timeout`, `run_service_operation_once`, and retry-sleep helpers to keep attempts within one overall time budget.

*Call graph*: calls 2 internal fn (remaining_operation_timeout, sleep_with_retry_deadline); 8 external calls (clone, from_millis, is_retryable_tools_list_error, run_service_operation_once, clone, once, unreachable!, warn!).


##### `RmcpClient::run_service_operation_once`  (lines 1008–1031)

```
async fn run_service_operation_once(
        service: Arc<RunningService<RoleClient, ElicitationClientService>>,
        label: &str,
        timeout: Option<Duration>,
        pause_state: Elicitatio
```

**Purpose**: Runs a single attempt of an MCP operation, optionally with an elicitation-aware timeout.

**Data flow**: It receives the service, label, optional timeout, pause state, and operation closure. If a timeout exists, it subscribes to pause changes and runs the operation through `active_time_timeout`; otherwise it awaits the operation directly. It returns either the operation result or a structured operation error.

**Call relations**: The retry loop calls this for each attempt. It is the point where normal service calls connect to the elicitation pause mechanism.

*Call graph*: calls 2 internal fn (subscribe, active_time_timeout).


##### `RmcpClient::is_retryable_tools_list_error`  (lines 1033–1047)

```
fn is_retryable_tools_list_error(label: &str, error: &ClientOperationError) -> bool
```

**Purpose**: Checks whether an error from `tools/list` is the specific kind of streamable HTTP send failure worth retrying.

**Data flow**: It receives the operation label and error. It first rejects anything that is not `tools/list`, then checks whether the error came from the HTTP transport adapter and matches the retryable HTTP-error rules.

**Call relations**: `run_service_operation_with_transient_retries` uses this to decide whether to wait and try again or return the error immediately.


##### `RmcpClient::is_session_expired_404`  (lines 1049–1067)

```
fn is_session_expired_404(error: &ClientOperationError) -> bool
```

**Purpose**: Detects the special HTTP 404 error that means a streamable HTTP MCP session has expired. This tells the client that rebuilding the session may fix the problem.

**Data flow**: It receives a client-operation error. It checks that it is a transport send error from the streamable HTTP adapter and specifically matches `SessionExpired404`. It returns true only for that case.

**Call relations**: `run_service_operation` uses this after a failed operation. When it returns true, the client runs session recovery and retries the original operation.


##### `RmcpClient::reinitialize_after_session_expiry`  (lines 1069–1128)

```
async fn reinitialize_after_session_expiry(
        &self,
        failed_service: &Arc<RunningService<RoleClient, ElicitationClientService>>,
    ) -> Result<()>
```

**Purpose**: Rebuilds the MCP connection after a streamable HTTP session expires. It prevents multiple tasks from doing the same recovery work at once.

**Data flow**: It receives the service that failed. It takes a recovery semaphore, which is a one-at-a-time permit, then checks whether another task already replaced the service. If not, it reloads the saved initialization context, creates a fresh transport from the recipe, reconnects and reinitializes, stores the new ready service, persists OAuth tokens if needed, and returns success.

**Call relations**: `run_service_operation` calls this only after detecting a session-expired 404. The pointer check against the failed service lets later callers skip recovery if an earlier caller already fixed the client.

*Call graph*: called by 1 (run_service_operation); 6 external calls (ptr_eq, create_pending_transport, acquire, anyhow!, matches!, warn!).


##### `create_oauth_transport_and_runtime`  (lines 1131–1190)

```
async fn create_oauth_transport_and_runtime(
    server_name: &str,
    url: &str,
    initial_tokens: StoredOAuthTokens,
    credentials_store: OAuthCredentialsStoreMode,
    keyring_backend_kind: Au
```

**Purpose**: Builds an HTTP MCP transport that can use stored OAuth credentials, and creates the helper that will refresh and persist those credentials later.

**Data flow**: It receives server identity, URL, stored tokens, token-storage settings, default headers, and the shared HTTP client. It builds an OAuth metadata client, loads the stored credentials into OAuth state, creates an authenticated HTTP client, wraps it in the MCP HTTP transport, creates an `OAuthPersistor`, and returns both.

**Call relations**: `RmcpClient::create_pending_transport` calls this when stored OAuth tokens are available and no explicit bearer token or auth provider overrides them.

*Call graph*: calls 3 internal fn (new, new, apply_default_headers); called by 1 (create_pending_transport); 7 external calls (new, new, with_client, with_uri, anyhow!, builder, maybe_build_rustls_client_config_with_custom_ca).


##### `tests::active_time_timeout_pauses_while_elicitation_is_pending`  (lines 1202–1218)

```
async fn active_time_timeout_pauses_while_elicitation_is_pending()
```

**Purpose**: Checks that timeout counting pauses while elicitation is active. This protects the user-facing behavior where waiting for human input should not consume the operation’s timeout budget.

**Data flow**: It creates a pause state, enters a pause, spawns a task that ends the pause after a short delay, then runs an operation whose wall-clock time is longer than the timeout. Because much of that time is paused, it expects the operation to finish successfully.

**Call relations**: The test directly exercises `ElicitationPauseState::new`, `ElicitationPauseState::enter`, and `active_time_timeout`, proving the timeout helper behaves as intended.

*Call graph*: calls 2 internal fn (new, active_time_timeout); 4 external calls (from_millis, assert_eq!, sleep, spawn).


### `chatgpt/src/workspace_settings.rs`

`domain_logic` · `request handling / feature gating`

Some ChatGPT accounts belong to workspaces, and a workspace can turn certain beta features on or off. This file checks one specific setting: whether Codex plugins are enabled. Without this check, the app might show or use plugin features for a workspace that has disabled them, or it might waste time calling the settings API again and again.

The main public function, codex_plugins_enabled_for_workspace, first looks for reasons it does not need to ask the server. If there is no login, if the login is not a ChatGPT login, if the account is not a workspace account, or if there is no usable account ID, it returns true. In other words, plugin use is allowed by default unless a workspace setting says otherwise.

For real workspace accounts, it builds a cache key from the ChatGPT server URL and the account ID. The cache is protected by an RwLock, which is a lock that lets many readers look at the cached value at once but gives only one writer permission to update it. Cached answers expire after 15 minutes, like a temporary note on a whiteboard. If there is no valid cached answer, the file calls the ChatGPT settings endpoint, reads the enable_plugins beta setting, stores the answer, and returns it. Account IDs are safely encoded before being placed into a URL path.

#### Function details

##### `WorkspaceSettingsCache::get_codex_plugins_enabled`  (lines 41–68)

```
fn get_codex_plugins_enabled(&self, key: &WorkspaceSettingsCacheKey) -> Option<bool>
```

**Purpose**: This looks in the local cache for the saved answer to “are Codex plugins enabled?” for a particular workspace. It only returns an answer if the cached entry is for the same ChatGPT server and account, and it has not expired.

**Data flow**: It receives a workspace cache key made from the ChatGPT base URL and account ID. It reads the cached entry under a read lock, compares the key and expiry time with the current time, and returns the saved true or false value if it is still valid. If the entry is missing, expired, or belongs to a different workspace, it takes a write lock, clears stale or wrong data, and returns nothing.

**Call relations**: codex_plugins_enabled_for_workspace calls this before making a network request. If this function returns a value, the larger check can finish immediately; if it returns nothing, the caller knows it must ask the ChatGPT settings API.

*Call graph*: 1 external calls (now).


##### `WorkspaceSettingsCache::set_codex_plugins_enabled`  (lines 70–80)

```
fn set_codex_plugins_enabled(&self, key: WorkspaceSettingsCacheKey, enabled: bool)
```

**Purpose**: This stores the latest plugin-enabled answer for a workspace in the local cache. It gives the answer a 15-minute lifetime so future checks can be fast but not permanently stale.

**Data flow**: It receives a cache key and a boolean answer. It takes a write lock, replaces any previous cached entry with the new one, records an expiry time 15 minutes in the future, and saves whether Codex plugins are enabled.

**Call relations**: codex_plugins_enabled_for_workspace calls this after it successfully receives workspace settings from ChatGPT. This means later checks for the same account and server can use the cache instead of making another HTTP request.

*Call graph*: 1 external calls (now).


##### `codex_plugins_enabled_for_workspace`  (lines 83–132)

```
async fn codex_plugins_enabled_for_workspace(
    config: &Config,
    auth: Option<&CodexAuth>,
    cache: Option<&WorkspaceSettingsCache>,
) -> anyhow::Result<bool>
```

**Purpose**: This is the main check for whether Codex plugins should be available for the current workspace. It combines authentication details, workspace identity, optional caching, and a ChatGPT settings API call into one clear yes-or-no answer.

**Data flow**: It receives the app configuration, optional authentication information, and an optional cache. It first returns true for cases where workspace settings do not apply, such as no auth, non-ChatGPT auth, non-workspace accounts, or missing account IDs. For a workspace account, it builds a cache key, tries to reuse a cached answer, safely encodes the account ID for a URL, fetches the account settings from ChatGPT, reads the enable_plugins beta setting, defaults to true if that setting is absent, saves the result in the cache if one was provided, and returns the final boolean answer or an error if the network request fails.

**Call relations**: This function is called by workspace_codex_plugins_enabled when the rest of the system needs to know whether plugin features are allowed. It uses encode_path_segment to safely build the settings URL, calls chatgpt_get_request_with_timeout to fetch settings from ChatGPT, and uses WorkspaceSettingsCache::get_codex_plugins_enabled and WorkspaceSettingsCache::set_codex_plugins_enabled to avoid unnecessary repeated requests.

*Call graph*: calls 2 internal fn (chatgpt_get_request_with_timeout, encode_path_segment); called by 3 (workspace_codex_plugins_enabled, workspace_codex_plugins_enabled, workspace_codex_plugins_enabled); 1 external calls (format!).


##### `encode_path_segment`  (lines 134–144)

```
fn encode_path_segment(value: &str) -> String
```

**Purpose**: This makes a string safe to place inside one part of a URL path. It prevents special characters in an account ID from being mistaken for URL syntax.

**Data flow**: It receives a plain string and checks each byte. Letters, numbers, and a few safe characters are copied as-is. Every other byte is converted into a percent-encoded form such as %2F, and the fully encoded string is returned.

**Call relations**: codex_plugins_enabled_for_workspace calls this before building the /accounts/{id}/settings path. This keeps the account ID as data inside the URL rather than letting unusual characters change the meaning of the path.

*Call graph*: called by 1 (codex_plugins_enabled_for_workspace); 3 external calls (new, format!, matches!).


### `chatgpt/src/connectors.rs`

`orchestration` · `request handling`

Connectors are apps or services, such as external tools, that ChatGPT can show to a user and possibly connect to. This file is the bridge between several sources of connector information: the remote ChatGPT connector directory, cached directory results on disk, plugin-provided connector IDs, and connectors discovered from MCP tools. MCP means “Model Context Protocol,” a way for tools to describe capabilities that the app can use.

The file first asks a basic question: are apps enabled for this user and this configuration? If not, it returns an empty list instead of doing network or cache work. When apps are enabled, it verifies that the user has the right kind of ChatGPT/Codex backend authentication. Then it either reads connector directory data from a cache or asks the ChatGPT API for a fresh directory response, using a timeout so the app does not wait forever.

After the raw connector lists are collected, the file combines them. Think of it like reconciling a store catalog with the items already available on a customer’s account. It merges the full directory with the accessible connectors, marks what is accessible, adds plugin-requested connectors when appropriate, and removes disallowed connectors based on the current client origin. The tests focus on edge cases where accessible connectors are missing from the full list, and where plugin connector requests must be narrowed or filtered.

#### Function details

##### `apps_enabled`  (lines 29–36)

```
async fn apps_enabled(config: &Config) -> bool
```

**Purpose**: Checks whether app connectors should be available for the current configuration and signed-in user. This prevents the rest of the connector logic from running when the feature is disabled or unsupported for the user’s authentication.

**Data flow**: It receives the app configuration, uses it to find the shared authentication manager, reads the current authentication state, and asks the feature settings whether apps are enabled for that kind of signed-in user. It returns a simple yes-or-no value.

**Call relations**: The main listing functions call this first. If it says no, functions such as list_connectors, list_all_connectors_with_options, and list_cached_all_connectors stop early and return no connectors instead of fetching or merging anything.

*Call graph*: calls 1 internal fn (shared_from_config); called by 3 (list_all_connectors_with_options, list_cached_all_connectors, list_connectors).


##### `connector_auth`  (lines 38–50)

```
async fn connector_auth(config: &Config) -> anyhow::Result<CodexAuth>
```

**Purpose**: Gets the user authentication needed to use ChatGPT connectors and confirms it is the right kind. It protects connector requests from being made without valid ChatGPT/Codex backend authentication.

**Data flow**: It receives the configuration, uses it to obtain the shared authentication manager, and reads the current auth record. If no auth exists, or if the auth is not for the Codex backend, it returns an error. Otherwise it returns the valid authentication object.

**Call relations**: The directory-loading paths call this after apps_enabled succeeds. list_all_connectors_with_options needs it before making remote or cached directory requests, and list_cached_all_connectors needs it before reading the matching cache entry.

*Call graph*: calls 1 internal fn (shared_from_config); called by 2 (list_all_connectors_with_options, list_cached_all_connectors); 1 external calls (ensure!).


##### `list_connectors`  (lines 52–68)

```
async fn list_connectors(config: &Config) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Builds the user-facing connector list by combining the full connector directory with connectors that are currently accessible through MCP tools. This is the high-level “give me the connectors for this user” function.

**Data flow**: It receives the configuration. If apps are disabled, it returns an empty list. Otherwise it starts two async jobs at the same time: one loads all known connectors, and one finds accessible connectors from MCP tools. It merges those results, marks enabled state according to app settings, and returns the final list.

**Call relations**: This is a top-level connector listing path. It calls apps_enabled for the gate check, asks list_all_connectors and list_accessible_connectors_from_mcp_tools for the two source lists, passes them into merge_connectors_with_accessible, and finally applies with_app_enabled_state.

*Call graph*: calls 3 internal fn (apps_enabled, merge_connectors_with_accessible, with_app_enabled_state); 2 external calls (new, join!).


##### `list_all_connectors`  (lines 70–72)

```
async fn list_all_connectors(config: &Config) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Provides the normal way to load the full connector directory without forcing a refresh and without adding plugin-only connector IDs. It is a convenience wrapper for the more configurable function.

**Data flow**: It receives the configuration, supplies default options, and forwards the request to list_all_connectors_with_options. The returned connector list or error comes straight back to the caller.

**Call relations**: list_connectors uses this when it needs the standard full connector directory. The real work is handed off to list_all_connectors_with_options.

*Call graph*: calls 1 internal fn (list_all_connectors_with_options).


##### `list_cached_all_connectors`  (lines 74–86)

```
async fn list_cached_all_connectors(
    config: &Config,
    plugin_apps: &[AppConnectorId],
) -> Option<Vec<AppInfo>>
```

**Purpose**: Tries to return the connector directory from the local cache instead of making a network request. This is useful when another part of the app wants connector information quickly or without blocking on the remote service.

**Data flow**: It receives the configuration and a list of plugin connector IDs. If apps are disabled, it returns an empty list wrapped as a successful cache result. If authentication is missing or the cache has no matching data, it returns None. If cache data exists, it merges in plugin connectors, filters disallowed ones, and returns the resulting list.

**Call relations**: Callers such as plugin_apps_needing_auth_for_install, remote_plugin_install_response, and load_plugin_app_summaries use this fast path. It relies on apps_enabled, connector_auth, connector_directory_cache_context, cached_directory_connectors, and merge_and_filter_plugin_connectors.

*Call graph*: calls 4 internal fn (apps_enabled, connector_auth, connector_directory_cache_context, merge_and_filter_plugin_connectors); called by 3 (plugin_apps_needing_auth_for_install, remote_plugin_install_response, load_plugin_app_summaries); 2 external calls (new, cached_directory_connectors).


##### `list_all_connectors_with_options`  (lines 88–113)

```
async fn list_all_connectors_with_options(
    config: &Config,
    force_refetch: bool,
    plugin_apps: &[AppConnectorId],
) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Loads the full connector directory with caller-controlled options, such as whether to force a fresh fetch and which plugin connector IDs to include. This is the main directory-loading function in the file.

**Data flow**: It receives the configuration, a force-refresh flag, and plugin connector IDs. It exits with an empty list if apps are disabled. Otherwise it gets valid connector authentication, builds a cache context, and calls the connector library to load directory data, possibly using a ChatGPT API GET request with a 60-second timeout. It then merges in plugin connectors, filters disallowed connectors, and returns the final list.

**Call relations**: list_all_connectors calls this with default options, while other flows such as apps_list_response and load_plugin_app_summaries call it directly when they need specific behavior. It delegates authentication, cache-key creation, network fetching, and plugin filtering to helper functions and external connector code.

*Call graph*: calls 4 internal fn (apps_enabled, connector_auth, connector_directory_cache_context, merge_and_filter_plugin_connectors); called by 3 (apps_list_response, load_plugin_app_summaries, list_all_connectors); 2 external calls (new, list_all_connectors_with_options).


##### `connector_directory_cache_context`  (lines 115–128)

```
fn connector_directory_cache_context(
    config: &Config,
    auth: &CodexAuth,
) -> ConnectorDirectoryCacheContext
```

**Purpose**: Builds the information needed to read or write the connector directory cache for this exact user and environment. This keeps cached connector data from one account, server, or workspace type from being reused for another.

**Data flow**: It receives the configuration and authenticated user information. It combines the local Codex home folder, ChatGPT base URL, account ID, ChatGPT user ID, and workspace-account flag into a cache context object. That object is returned to the cache and directory-loading code.

**Call relations**: Both cached and fresh directory loading call this before using connector directory storage. list_cached_all_connectors passes the result to cached_directory_connectors, and list_all_connectors_with_options passes it to the connector library’s directory loader.

*Call graph*: calls 5 internal fn (new, new, get_account_id, get_chatgpt_user_id, is_workspace_account); called by 2 (list_all_connectors_with_options, list_cached_all_connectors).


##### `merge_and_filter_plugin_connectors`  (lines 130–141)

```
fn merge_and_filter_plugin_connectors(
    connectors: Vec<AppInfo>,
    plugin_apps: &[AppConnectorId],
) -> Vec<AppInfo>
```

**Purpose**: Adds plugin-requested connectors to an existing connector list, then removes connectors that this client is not allowed to expose. It is the shared cleanup step after loading connector directory data.

**Data flow**: It receives a connector list and plugin connector IDs. It turns the plugin IDs into the form expected by the connector merge helper, adds any plugin connectors, and then filters the combined list using the current originator, meaning the identity of this client or environment. It returns the allowed merged list.

**Call relations**: list_all_connectors_with_options and list_cached_all_connectors both use this after obtaining directory data. It hands the actual merge and filtering work to codex_connectors helpers.

*Call graph*: calls 3 internal fn (filter_disallowed_connectors, merge_plugin_connectors, originator); called by 2 (list_all_connectors_with_options, list_cached_all_connectors); 1 external calls (iter).


##### `connectors_for_plugin_apps`  (lines 143–163)

```
fn connectors_for_plugin_apps(
    connectors: Vec<AppInfo>,
    plugin_apps: &[AppConnectorId],
) -> Vec<AppInfo>
```

**Purpose**: Returns connector records only for the plugin app IDs requested by the caller. It is useful when plugin install or summary flows need connector details for a specific set of plugin apps, not the whole directory.

**Data flow**: It receives a connector list and requested plugin connector IDs. It merges plugin IDs into the connector list, filters out disallowed connectors, stores the remaining connectors by ID, then walks the requested plugin IDs in order and pulls out matching connectors. The result contains only allowed connectors that were requested, with duplicates avoided after the first match is removed.

**Call relations**: Plugin-related flows such as plugin_apps_needing_auth_for_install, remote_plugin_install_response, and load_plugin_app_summaries call this when they need a narrowed connector list. The tests also call it to confirm that only requested and allowed plugin apps are returned.

*Call graph*: calls 3 internal fn (filter_disallowed_connectors, merge_plugin_connectors, originator); called by 5 (plugin_apps_needing_auth_for_install, remote_plugin_install_response, load_plugin_app_summaries, connectors_for_plugin_apps_filters_disallowed_plugin_apps, connectors_for_plugin_apps_returns_only_requested_plugin_apps); 1 external calls (iter).


##### `merge_connectors_with_accessible`  (lines 165–184)

```
fn merge_connectors_with_accessible(
    connectors: Vec<AppInfo>,
    accessible_connectors: Vec<AppInfo>,
    all_connectors_loaded: bool,
) -> Vec<AppInfo>
```

**Purpose**: Combines the full connector directory with the subset of connectors that are accessible to the user, marking which connectors are accessible. It also avoids showing stale accessible connectors when the full directory has already loaded and does not contain them.

**Data flow**: It receives all known connectors, accessible connectors, and a flag saying whether the full connector list is complete. If the full list is complete, it first drops accessible connectors whose IDs are not present in that full list. If the full list is still loading, it keeps them. It then merges the two lists, filters disallowed connectors, and returns the cleaned result.

**Call relations**: list_connectors uses this after fetching the full directory and MCP-accessible connectors. merge_loaded_apps also calls it in another loading flow. The tests exercise the important difference between “all connectors loaded” and “still loading.”

*Call graph*: calls 3 internal fn (filter_disallowed_connectors, merge_connectors, originator); called by 4 (merge_loaded_apps, list_connectors, excludes_accessible_connectors_not_in_all_when_all_loaded, keeps_accessible_connectors_not_in_all_while_all_loading).


##### `tests::app`  (lines 193–209)

```
fn app(id: &str) -> AppInfo
```

**Purpose**: Creates a simple test connector with predictable default fields. This keeps the tests focused on merge behavior instead of repeatedly building large AppInfo values by hand.

**Data flow**: It receives an ID string and copies it into the connector’s ID and name. Other optional display and metadata fields are left empty, accessibility starts as false, and enabled state starts as true. It returns the constructed AppInfo test value.

**Call relations**: The test cases call this to create input connectors for merge_connectors_with_accessible and connectors_for_plugin_apps. It is only active in the test build.

*Call graph*: 1 external calls (new).


##### `tests::merged_app`  (lines 211–227)

```
fn merged_app(id: &str, is_accessible: bool) -> AppInfo
```

**Purpose**: Creates the expected connector shape after merge logic has added install information and accessibility state. It lets tests compare against a realistic merged result.

**Data flow**: It receives a connector ID and a desired accessibility flag. It builds an AppInfo with that ID and name, adds the expected install URL, sets is_accessible to the supplied value, and returns the completed expected value.

**Call relations**: The tests use this for expected outputs when checking merge_connectors_with_accessible and connectors_for_plugin_apps. It relies on connector_install_url to match the production merge behavior.

*Call graph*: calls 1 internal fn (connector_install_url); 1 external calls (new).


##### `tests::excludes_accessible_connectors_not_in_all_when_all_loaded`  (lines 230–237)

```
fn excludes_accessible_connectors_not_in_all_when_all_loaded()
```

**Purpose**: Verifies that once the full connector directory is loaded, accessible connectors not found in that directory are excluded. This prevents old or unexpected accessible entries from appearing in the final list.

**Data flow**: It creates a full list containing only alpha and an accessible list containing alpha and beta. It calls merge_connectors_with_accessible with all_connectors_loaded set to true. It checks that the output contains only alpha, marked accessible.

**Call relations**: This test directly exercises merge_connectors_with_accessible. It documents the intended behavior for the completed-directory case.

*Call graph*: calls 1 internal fn (merge_connectors_with_accessible); 2 external calls (assert_eq!, vec!).


##### `tests::keeps_accessible_connectors_not_in_all_while_all_loading`  (lines 240–253)

```
fn keeps_accessible_connectors_not_in_all_while_all_loading()
```

**Purpose**: Verifies that accessible connectors are kept while the full connector directory may still be incomplete. This avoids hiding usable connectors just because the full catalog has not finished loading yet.

**Data flow**: It creates a full list containing alpha and an accessible list containing alpha and beta. It calls merge_connectors_with_accessible with all_connectors_loaded set to false. It checks that both alpha and beta are returned as accessible.

**Call relations**: This test directly exercises merge_connectors_with_accessible. Together with the previous test, it explains why the all_connectors_loaded flag changes filtering behavior.

*Call graph*: calls 1 internal fn (merge_connectors_with_accessible); 2 external calls (assert_eq!, vec!).


##### `tests::connectors_for_plugin_apps_returns_only_requested_plugin_apps`  (lines 256–269)

```
fn connectors_for_plugin_apps_returns_only_requested_plugin_apps()
```

**Purpose**: Verifies that plugin connector selection returns only the requested plugin apps, in request order, while also including connector details when they exist. It also shows that repeated plugin IDs do not produce repeated output after the first match is consumed.

**Data flow**: It starts with connectors alpha and beta, then requests gmail, alpha, and gmail again. It calls connectors_for_plugin_apps and checks that the result contains a generated gmail connector and the existing alpha connector, but not beta and not a second gmail.

**Call relations**: This test directly exercises connectors_for_plugin_apps. It protects the plugin install and summary flows from receiving unrelated connector entries.

*Call graph*: calls 1 internal fn (connectors_for_plugin_apps); 3 external calls (assert_eq!, new, vec!).


##### `tests::connectors_for_plugin_apps_filters_disallowed_plugin_apps`  (lines 272–280)

```
fn connectors_for_plugin_apps_filters_disallowed_plugin_apps()
```

**Purpose**: Verifies that plugin-requested connectors are still filtered by the disallowed-connector rules. This prevents a plugin request from bypassing client safety or availability restrictions.

**Data flow**: It passes an empty connector list and one known disallowed plugin connector ID into connectors_for_plugin_apps. It checks that the result is an empty list.

**Call relations**: This test directly exercises connectors_for_plugin_apps and, through it, the filtering step used in plugin-related connector flows.

*Call graph*: calls 1 internal fn (connectors_for_plugin_apps); 3 external calls (new, assert_eq!, new).


### Startup content refreshes
These files synchronize curated plugin content and expose a focused backend task fetch used during startup-adjacent remote preparation flows.

### `core-plugins/src/startup_sync.rs`

`orchestration` · `startup`

Codex needs a local snapshot of the curated plugin marketplace so it can show and install trusted plugins without fetching every detail on demand. This file is the startup synchronizer for that snapshot. Think of it like a small delivery service: it first tries the preferred delivery truck, then a backup courier, then an emergency package if the normal routes fail.

The main flow starts with a lock file so two Codex processes do not update the same folder at the same time. It then tries to sync the OpenAI plugins repository with Git. If Git fails, it asks the GitHub API for the latest commit and downloads a zip archive. If that also fails and there is no local snapshot yet, it downloads a separate backup export archive. Existing local snapshots are protected: the backup archive is only used to bootstrap a missing copy, not to overwrite a newer one.

Every successful download is unpacked or checked out into a temporary folder first. The code verifies that the marketplace manifest exists, then swaps the temporary folder into place. If replacing an old folder fails, it tries to roll back to the previous copy. It also records the synced version in a small SHA file and emits metrics so operators can see which transport worked or failed.

#### Function details

##### `curated_plugins_repo_path`  (lines 58–60)

```
fn curated_plugins_repo_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the folder path where Codex stores the local copy of the curated plugins repository. Other parts of the plugin system use this to find the downloaded marketplace files.

**Data flow**: It receives the Codex home directory, appends the fixed curated-plugins subfolder, and returns the full path. It does not read or write the disk.

**Call relations**: Marketplace loading code and this sync file call it whenever they need the canonical local repository location, so every caller agrees on the same folder.

*Call graph*: called by 34 (does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps, does_not_reload_marketplace_per_plugin, ignores_missing_marketplace_plugin, includes_openai_curated_when_remote_enabled, normalizes_description, omits_installed_curated_plugins, omits_not_available_curated_plugins, returns_api_curated_fallback_plugins_for_direct_provider_auth (+15 more)); 1 external calls (join).


##### `curated_plugins_api_marketplace_path`  (lines 62–64)

```
fn curated_plugins_api_marketplace_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the API marketplace JSON file inside the local curated plugins copy. This is the file other code reads when it wants the plugin catalog data.

**Data flow**: It receives the Codex home directory, first gets the curated repository folder, then appends the known manifest path inside that folder. It returns that path only.

**Call relations**: It is used by marketplace root discovery, which needs to know where the curated API marketplace file lives.

*Call graph*: calls 1 internal fn (curated_plugins_repo_path); called by 1 (marketplace_roots).


##### `read_curated_plugins_sha`  (lines 66–68)

```
fn read_curated_plugins_sha(codex_home: &Path) -> Option<String>
```

**Purpose**: Reads the recorded version of the local curated plugins snapshot, if one exists. The version is usually a Git commit SHA, which is a unique identifier for a repository state.

**Data flow**: It receives the Codex home directory, builds the SHA-file path, reads and trims that file, and returns either the non-empty version string or nothing.

**Call relations**: Plugin installation code calls this when it needs to know which curated snapshot an installed plugin came from.

*Call graph*: calls 2 internal fn (curated_plugins_sha_path, read_sha_file); called by 1 (install_resolved_plugin).


##### `curated_plugins_sha_path`  (lines 70–72)

```
fn curated_plugins_sha_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the small file that stores the synced curated plugins version. Keeping this in one helper prevents different code from writing version records in different places.

**Data flow**: It receives the Codex home directory, appends the fixed SHA-file location, and returns the resulting path.

**Call relations**: The public SHA reader and the backup-archive sync path both use this helper to locate the version marker consistently.

*Call graph*: called by 2 (read_curated_plugins_sha, sync_openai_plugins_repo_via_backup_archive); 1 external calls (join).


##### `sync_openai_plugins_repo`  (lines 74–81)

```
fn sync_openai_plugins_repo(codex_home: &Path) -> Result<String, String>
```

**Purpose**: Starts the normal curated plugin sync using the production Git command and production URLs. This is the simple public entry point for refreshing the local plugin catalog.

**Data flow**: It receives the Codex home directory and passes it, along with default transport settings, into the more configurable sync function. It returns the synced version string or an error message.

**Call relations**: It delegates the real work to sync_openai_plugins_repo_with_transport_overrides, which exists so tests or special callers can swap in different transport endpoints.

*Call graph*: calls 1 internal fn (sync_openai_plugins_repo_with_transport_overrides).


##### `sync_openai_plugins_repo_with_transport_overrides`  (lines 83–146)

```
fn sync_openai_plugins_repo_with_transport_overrides(
    codex_home: &Path,
    git_binary: &str,
    api_base_url: &str,
    backup_archive_api_url: &str,
) -> Result<String, String>
```

**Purpose**: Runs the full sync plan with fallback choices: Git first, GitHub HTTP second, and an export archive last if no local snapshot exists. It also records success and failure metrics.

**Data flow**: It receives the Codex home directory plus the Git binary and URLs to use. It takes a file lock, tries each transport in order, emits metrics for each result, and returns the version that was installed or a combined error explaining what failed.

**Call relations**: sync_openai_plugins_repo calls this as the main coordinator. It calls the Git, HTTP, and backup sync functions, uses the local snapshot check to decide whether the emergency fallback is safe, and sends metrics through the emit helpers.

*Call graph*: calls 7 internal fn (emit_curated_plugins_startup_sync_final_metric, emit_curated_plugins_startup_sync_metric, has_local_curated_plugins_snapshot, lock_curated_plugins_startup_sync, sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); called by 1 (sync_openai_plugins_repo); 2 external calls (format!, warn!).


##### `lock_curated_plugins_startup_sync`  (lines 148–162)

```
fn lock_curated_plugins_startup_sync(codex_home: &Path) -> Result<File, String>
```

**Purpose**: Prevents two Codex processes from changing the curated plugins folder at the same time. The lock is like a bathroom key: only the holder may enter and rearrange things.

**Data flow**: It receives the Codex home directory, creates the temporary metadata folder if needed, opens the lock file, locks it, and returns the open file that keeps the lock alive. On failure it returns a clear error string.

**Call relations**: The top-level sync coordinator calls this before any network or disk replacement work begins, so all later sync steps run under the same protection.

*Call graph*: called by 1 (sync_openai_plugins_repo_with_transport_overrides); 3 external calls (options, join, create_dir_all).


##### `sync_openai_plugins_repo_via_git`  (lines 164–206)

```
fn sync_openai_plugins_repo_via_git(codex_home: &Path, git_binary: &str) -> Result<String, String>
```

**Purpose**: Refreshes the curated plugins snapshot by using Git, the preferred and most exact transport. It avoids doing work when the local checkout is already at the remote version.

**Data flow**: It finds the local repository and SHA file, asks the remote Git repository for HEAD, compares that to the local version, and returns early if they match. Otherwise it stages a fresh checkout in a temporary folder, fetches the target commit, resets the checkout, verifies the fetched SHA and manifest, swaps it into place, writes the SHA file, and returns the remote SHA.

**Call relations**: The main coordinator tries this first. It relies on Git command helpers for remote lookup, fetch, reset, and SHA checks, and then uses the shared activation and SHA-writing helpers used by other transports.

*Call graph*: calls 12 internal fn (activate_curated_repo, curated_plugins_repo_path, ensure_marketplace_manifest_exists, fetch_curated_plugins_commit, fetch_curated_plugins_commit_from_source, git_head_sha, git_ls_remote_head_sha, prepare_curated_repo_parent_and_temp_dir, read_local_git_or_sha_file, reset_curated_plugins_checkout (+2 more)); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 2 external calls (join, format!).


##### `fetch_curated_plugins_commit`  (lines 208–220)

```
fn fetch_curated_plugins_commit(
    repo_path: &Path,
    remote_sha: &str,
    git_binary: &str,
) -> Result<(), String>
```

**Purpose**: Fetches a specific commit from the official OpenAI plugins Git repository into a local repository. It is a small wrapper that fills in the official source URL.

**Data flow**: It receives a local repository path, a remote SHA, and the Git binary. It passes those to the generic fetch helper and returns success or an error.

**Call relations**: The Git sync path calls this when it needs to bring the desired official commit into either the staged repository or an existing local copy.

*Call graph*: calls 1 internal fn (fetch_curated_plugins_commit_from); called by 1 (sync_openai_plugins_repo_via_git).


##### `fetch_curated_plugins_commit_from_source`  (lines 222–235)

```
fn fetch_curated_plugins_commit_from_source(
    repo_path: &Path,
    source_repo_path: &Path,
    remote_sha: &str,
    git_binary: &str,
) -> Result<(), String>
```

**Purpose**: Copies a previously fetched curated plugins commit from one local repository into another. This lets the sync reuse an existing checkout as a source instead of downloading twice.

**Data flow**: It receives the destination repository, the source repository path, the revision name to fetch, and the Git binary. It asks the generic fetch helper to fetch from the local source path and returns the result.

**Call relations**: The Git sync path uses this when an old local repository already exists: first it fetches from GitHub into the old repo, then copies the fetched ref into the staged repo.

*Call graph*: calls 1 internal fn (fetch_curated_plugins_commit_from); called by 1 (sync_openai_plugins_repo_via_git).


##### `fetch_curated_plugins_commit_from`  (lines 237–257)

```
fn fetch_curated_plugins_commit_from(
    repo_path: &Path,
    source: &Path,
    source_revision: &str,
    git_binary: &str,
    context: &str,
) -> Result<(), String>
```

**Purpose**: Runs the actual Git fetch command for a chosen source and revision. It stores the fetched commit under a fixed temporary reference inside the destination repository.

**Data flow**: It receives a repository path, source path, source revision, Git binary, and human-readable context. It builds a Git refspec, runs Git with a timeout, checks the exit status, and returns success or an error string.

**Call relations**: Both fetch wrapper functions call this. It depends on run_git_command_with_timeout to avoid hanging forever and ensure_git_success to turn Git failures into readable errors.

*Call graph*: calls 2 internal fn (ensure_git_success, run_git_command_with_timeout); called by 2 (fetch_curated_plugins_commit, fetch_curated_plugins_commit_from_source); 2 external calls (new, format!).


##### `reset_curated_plugins_checkout`  (lines 259–272)

```
fn reset_curated_plugins_checkout(repo_path: &Path, git_binary: &str) -> Result<(), String>
```

**Purpose**: Makes a staged Git checkout exactly match the fetched curated plugins commit. It also removes extra files so stale content cannot linger.

**Data flow**: It receives a repository path and Git binary, runs a hard reset to the fixed fetched ref, then runs Git clean to delete untracked files. It returns success or the first error.

**Call relations**: The Git sync path calls this after fetching. It uses run_git_in_repo for both Git commands.

*Call graph*: calls 1 internal fn (run_git_in_repo); called by 1 (sync_openai_plugins_repo_via_git).


##### `run_git_in_repo`  (lines 274–290)

```
fn run_git_in_repo(
    repo_path: &Path,
    git_binary: &str,
    args: &[&str],
    context: &str,
) -> Result<(), String>
```

**Purpose**: Runs a Git command inside a particular repository and checks that it succeeded. It centralizes the timeout and error handling for routine Git commands.

**Data flow**: It receives a repository path, Git binary, argument list, and context string. It builds the command, runs it with a timeout, checks the output status, and returns success or an error.

**Call relations**: The Git sync and reset steps call this for commands such as init, reset, and clean. It hands off process execution to run_git_command_with_timeout and status checking to ensure_git_success.

*Call graph*: calls 2 internal fn (ensure_git_success, run_git_command_with_timeout); called by 2 (reset_curated_plugins_checkout, sync_openai_plugins_repo_via_git); 1 external calls (new).


##### `sync_openai_plugins_repo_via_http`  (lines 292–316)

```
fn sync_openai_plugins_repo_via_http(
    codex_home: &Path,
    api_base_url: &str,
) -> Result<String, String>
```

**Purpose**: Refreshes the curated plugins snapshot through the GitHub HTTP API when Git is unavailable or fails. It downloads a zip archive of the target commit instead of using Git commands.

**Data flow**: It builds the local paths, creates a small async runtime, asks GitHub for the latest remote SHA, compares it to the recorded local SHA, and returns early if already current. Otherwise it downloads the zipball, extracts it into a temporary folder, verifies the manifest, activates the folder, writes the SHA file, and returns the remote SHA.

**Call relations**: The main coordinator calls this after Git sync fails. It shares staging, manifest checking, activation, and SHA writing with the Git path, but uses HTTP fetch helpers and zip extraction instead of Git checkout helpers.

*Call graph*: calls 9 internal fn (activate_curated_repo, curated_plugins_repo_path, ensure_marketplace_manifest_exists, extract_zipball_to_dir, fetch_curated_repo_remote_sha, fetch_curated_repo_zipball, prepare_curated_repo_parent_and_temp_dir, read_sha_file, write_curated_plugins_sha); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 2 external calls (join, new_current_thread).


##### `sync_openai_plugins_repo_via_backup_archive`  (lines 318–339)

```
fn sync_openai_plugins_repo_via_backup_archive(
    codex_home: &Path,
    backup_archive_api_url: &str,
) -> Result<String, String>
```

**Purpose**: Bootstraps a missing curated plugins snapshot from a backup export archive. This is an emergency path used only when normal GitHub sync cannot create the first local copy.

**Data flow**: It builds paths, creates an async runtime, downloads backup archive metadata and then the archive itself, extracts it into a temporary folder, checks for the manifest, reads a version from the archive’s Git metadata if present, activates the folder, writes that version, and returns it.

**Call relations**: The main coordinator calls this only after Git and GitHub HTTP fail and only when no local snapshot already exists. It uses the public fetch helpers, zip extraction, backup Git metadata readers, and the same activation process as the other sync paths.

*Call graph*: calls 9 internal fn (activate_curated_repo, curated_plugins_repo_path, curated_plugins_sha_path, ensure_marketplace_manifest_exists, extract_zipball_to_dir, fetch_curated_repo_backup_archive_zip, prepare_curated_repo_parent_and_temp_dir, read_extracted_backup_archive_git_sha, write_curated_plugins_sha); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 1 external calls (new_current_thread).


##### `has_local_curated_plugins_snapshot`  (lines 341–346)

```
fn has_local_curated_plugins_snapshot(codex_home: &Path) -> bool
```

**Purpose**: Checks whether there is already a usable local curated plugins snapshot. This protects existing users from having a backup archive overwrite a real repository refresh.

**Data flow**: It receives the Codex home directory and checks for both the marketplace manifest file and the SHA marker file. It returns true only when both are present.

**Call relations**: The sync coordinator calls this after Git and HTTP fail to decide whether the backup archive should be skipped.

*Call graph*: calls 1 internal fn (curated_plugins_repo_path); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 1 external calls (join).


##### `prepare_curated_repo_parent_and_temp_dir`  (lines 348–373)

```
fn prepare_curated_repo_parent_and_temp_dir(repo_path: &Path) -> Result<TempDir, String>
```

**Purpose**: Creates a safe temporary staging folder next to the final curated plugins folder. Staging first means Codex does not expose a half-downloaded marketplace.

**Data flow**: It receives the final repository path, finds and creates its parent folder, removes old abandoned staging folders, then creates a new temporary directory with a known prefix. It returns that temporary directory handle.

**Call relations**: All three sync transports call this before downloading or checking out content. It delegates cleanup of old temporary folders to remove_stale_curated_repo_temp_dirs.

*Call graph*: calls 1 internal fn (remove_stale_curated_repo_temp_dirs); called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 4 external calls (parent, format!, create_dir_all, new).


##### `remove_stale_curated_repo_temp_dirs`  (lines 375–458)

```
fn remove_stale_curated_repo_temp_dirs(parent: &Path, max_age: Duration)
```

**Purpose**: Cleans up old temporary plugin clone folders left behind by earlier interrupted syncs. This prevents the temporary area from filling with abandoned copies.

**Data flow**: It receives a parent folder and a maximum age. It lists entries, keeps only directories with the staging prefix, checks their last modification time, and removes those older than the limit while warning instead of failing on cleanup problems.

**Call relations**: prepare_curated_repo_parent_and_temp_dir calls this before creating a new staging folder, so every sync attempt gets a chance to tidy up old leftovers.

*Call graph*: called by 1 (prepare_curated_repo_parent_and_temp_dir); 3 external calls (read_dir, remove_dir_all, warn!).


##### `emit_curated_plugins_startup_sync_metric`  (lines 460–466)

```
fn emit_curated_plugins_startup_sync_metric(transport: &'static str, status: &'static str)
```

**Purpose**: Records an attempt-level metric for one sync transport, such as Git success or HTTP failure. Metrics help operators understand which download route is working.

**Data flow**: It receives a transport name and status, then passes the startup-sync metric name plus those tags to the shared counter emitter.

**Call relations**: The main coordinator calls this after each transport attempt. It delegates the actual metrics write to emit_curated_plugins_startup_sync_counter.

*Call graph*: calls 1 internal fn (emit_curated_plugins_startup_sync_counter); called by 1 (sync_openai_plugins_repo_with_transport_overrides).


##### `emit_curated_plugins_startup_sync_final_metric`  (lines 468–474)

```
fn emit_curated_plugins_startup_sync_final_metric(transport: &'static str, status: &'static str)
```

**Purpose**: Records the final outcome of the whole startup sync, tagged with the transport that ultimately decided the result. This is separate from per-attempt metrics.

**Data flow**: It receives the winning or final transport name and status, then sends them with the final metric name to the shared counter emitter.

**Call relations**: The main coordinator calls this when a sync path succeeds or when the last allowed path fails. It uses the same low-level counter helper as the attempt metric.

*Call graph*: calls 1 internal fn (emit_curated_plugins_startup_sync_counter); called by 1 (sync_openai_plugins_repo_with_transport_overrides).


##### `emit_curated_plugins_startup_sync_counter`  (lines 476–486)

```
fn emit_curated_plugins_startup_sync_counter(
    metric_name: &str,
    transport: &'static str,
    status: &'static str,
)
```

**Purpose**: Sends one counter increment to the telemetry system if telemetry is available. A counter is a simple number that goes up, used for measuring events.

**Data flow**: It receives a metric name, transport tag, and status tag. It looks for the global metrics object, and if present increments the counter by one with those tags; if telemetry is absent, it quietly does nothing.

**Call relations**: Both metric wrapper functions call this, keeping the telemetry details out of the main sync flow.

*Call graph*: called by 2 (emit_curated_plugins_startup_sync_final_metric, emit_curated_plugins_startup_sync_metric); 1 external calls (global).


##### `ensure_marketplace_manifest_exists`  (lines 488–496)

```
fn ensure_marketplace_manifest_exists(repo_path: &Path) -> Result<(), String>
```

**Purpose**: Verifies that a downloaded or checked-out snapshot actually contains the marketplace manifest Codex needs. Without this file, the sync result would be unusable.

**Data flow**: It receives a repository path and checks for the known manifest file inside it. It returns success if the file exists, otherwise an error naming the missing path.

**Call relations**: Every sync transport calls this before activation, so bad archives or wrong repository contents are rejected before replacing the live snapshot.

*Call graph*: called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 2 external calls (join, format!).


##### `activate_curated_repo`  (lines 498–552)

```
fn activate_curated_repo(repo_path: &Path, staged_repo_dir: TempDir) -> Result<(), String>
```

**Purpose**: Moves a fully prepared staged repository into the live curated plugins location. If an old copy exists, it tries to preserve it until the new copy is safely in place.

**Data flow**: It receives the final repository path and the temporary staged directory. If an old repo exists, it moves it to a temporary backup, moves the staged repo into place, and rolls back if that activation move fails. If there is no old repo, it simply renames the staged folder into place.

**Call relations**: All sync transports call this only after content has been fetched and verified. It is the handoff point from safe staging to live local marketplace data.

*Call graph*: called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 6 external calls (exists, parent, path, format!, rename, new).


##### `write_curated_plugins_sha`  (lines 554–569)

```
fn write_curated_plugins_sha(sha_path: &Path, remote_sha: &str) -> Result<(), String>
```

**Purpose**: Writes the version marker for the currently active curated plugins snapshot. This lets later syncs quickly tell whether the local copy is already current.

**Data flow**: It receives the SHA-file path and version string, creates the parent folder if needed, writes the version plus a newline, and returns success or an error.

**Call relations**: Each sync transport calls this after activating a new snapshot, so the recorded version matches the files now on disk.

*Call graph*: called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 4 external calls (parent, format!, create_dir_all, write).


##### `read_local_git_or_sha_file`  (lines 571–583)

```
fn read_local_git_or_sha_file(
    repo_path: &Path,
    sha_path: &Path,
    git_binary: &str,
) -> Option<String>
```

**Purpose**: Finds the current local curated plugins version, preferring the Git checkout’s actual HEAD when available. It falls back to the SHA marker file for non-Git snapshots.

**Data flow**: It receives the repository path, SHA-file path, and Git binary. If the repository has a .git folder and Git can read HEAD, it returns that SHA; otherwise it reads the SHA file and returns its contents if valid.

**Call relations**: The Git sync path calls this before deciding whether it needs to refresh. It uses git_head_sha for real Git checkouts and read_sha_file for archived snapshots.

*Call graph*: calls 2 internal fn (git_head_sha, read_sha_file); called by 1 (sync_openai_plugins_repo_via_git); 1 external calls (join).


##### `git_ls_remote_head_sha`  (lines 585–610)

```
fn git_ls_remote_head_sha(git_binary: &str) -> Result<String, String>
```

**Purpose**: Asks the official Git repository which commit HEAD currently points to. This tells the sync code what version it should install.

**Data flow**: It receives the Git binary name, runs git ls-remote against the official repository with a timeout, checks success, parses the first output line, and returns the SHA. Malformed or empty output becomes an error.

**Call relations**: The Git sync path calls this at the start. It relies on run_git_command_with_timeout for process control and ensure_git_success for failure reporting.

*Call graph*: calls 2 internal fn (ensure_git_success, run_git_command_with_timeout); called by 1 (sync_openai_plugins_repo_via_git); 3 external calls (from_utf8_lossy, new, format!).


##### `git_head_sha`  (lines 612–636)

```
fn git_head_sha(repo_path: &Path, git_binary: &str) -> Result<String, String>
```

**Purpose**: Reads the current commit SHA from a local Git repository. This is how the code confirms what version a checkout actually contains.

**Data flow**: It receives a repository path and Git binary, runs git rev-parse HEAD, checks that Git succeeded, trims the output, and returns the SHA if it is non-empty.

**Call relations**: The Git sync path uses this to verify the staged checkout, and read_local_git_or_sha_file uses it to detect the local version of an existing Git checkout.

*Call graph*: calls 1 internal fn (ensure_git_success); called by 2 (read_local_git_or_sha_file, sync_openai_plugins_repo_via_git); 3 external calls (from_utf8_lossy, new, format!).


##### `run_git_command_with_timeout`  (lines 638–690)

```
fn run_git_command_with_timeout(
    command: &mut Command,
    context: &str,
    timeout: Duration,
) -> Result<Output, String>
```

**Purpose**: Runs a Git-related child process but kills it if it takes too long. This prevents startup from hanging forever on a stuck Git command.

**Data flow**: It receives a prepared command, context label, and timeout. It starts the process with no stdin and captured output, polls until it exits or time runs out, then returns the captured output or an error that includes timeout or polling details.

**Call relations**: Git fetch, Git ls-remote, and the generic in-repo Git runner call this. Other helpers then inspect the returned output to decide whether the command succeeded.

*Call graph*: called by 3 (fetch_curated_plugins_commit_from, git_ls_remote_head_sha, run_git_in_repo); 8 external calls (from_millis, null, piped, from_utf8_lossy, stdin, format!, sleep, now).


##### `ensure_git_success`  (lines 692–705)

```
fn ensure_git_success(output: &Output, context: &str) -> Result<(), String>
```

**Purpose**: Turns a Git command’s exit status into either success or a readable error. It includes Git’s error text when available.

**Data flow**: It receives captured process output and a context label. If the status is successful it returns success; otherwise it reads stderr and builds an error message with the status and optional stderr text.

**Call relations**: All Git command helpers call this after running Git, so Git failures are reported consistently throughout the sync flow.

*Call graph*: called by 4 (fetch_curated_plugins_commit_from, git_head_sha, git_ls_remote_head_sha, run_git_in_repo); 2 external calls (from_utf8_lossy, format!).


##### `fetch_curated_repo_remote_sha`  (lines 707–735)

```
async fn fetch_curated_repo_remote_sha(api_base_url: &str) -> Result<String, String>
```

**Purpose**: Uses the GitHub API to discover the latest commit SHA for the curated plugins repository. This is the HTTP replacement for asking Git directly.

**Data flow**: It receives the GitHub API base URL, fetches repository metadata, parses the default branch, fetches that branch’s Git reference, parses the object SHA, and returns it if present.

**Call relations**: The HTTP sync path calls this before downloading a zipball. It uses fetch_github_text for authenticated-style GitHub requests and JSON parsing to extract the needed fields.

*Call graph*: calls 2 internal fn (fetch_github_text, build_reqwest_client); called by 1 (sync_openai_plugins_repo_via_http); 2 external calls (format!, from_str).


##### `fetch_curated_repo_zipball`  (lines 737–746)

```
async fn fetch_curated_repo_zipball(
    api_base_url: &str,
    remote_sha: &str,
) -> Result<Vec<u8>, String>
```

**Purpose**: Downloads a zip archive of the curated plugins repository at a specific commit. This provides repository contents without requiring Git.

**Data flow**: It receives the GitHub API base URL and remote SHA, builds the zipball URL, creates an HTTP client, downloads bytes from GitHub, and returns the archive bytes.

**Call relations**: The HTTP sync path calls this after it knows the remote SHA. The returned bytes are handed to extract_zipball_to_dir.

*Call graph*: calls 2 internal fn (fetch_github_bytes, build_reqwest_client); called by 1 (sync_openai_plugins_repo_via_http); 1 external calls (format!).


##### `fetch_curated_repo_backup_archive_zip`  (lines 748–776)

```
async fn fetch_curated_repo_backup_archive_zip(
    backup_archive_api_url: &str,
) -> Result<Vec<u8>, String>
```

**Purpose**: Downloads the emergency backup export archive for curated plugins. It first asks a metadata endpoint where the archive can be downloaded.

**Data flow**: It receives the backup archive API URL, fetches a JSON metadata response, parses the download_url field, validates that it is not empty, downloads the archive bytes from that URL, and returns them.

**Call relations**: The backup-archive sync path calls this when both normal Git and GitHub HTTP sync have failed and no local snapshot exists.

*Call graph*: calls 3 internal fn (fetch_public_bytes, fetch_public_text, build_reqwest_client); called by 1 (sync_openai_plugins_repo_via_backup_archive); 2 external calls (format!, from_str).


##### `read_extracted_backup_archive_git_sha`  (lines 778–805)

```
fn read_extracted_backup_archive_git_sha(repo_path: &Path) -> Result<Option<String>, String>
```

**Purpose**: Tries to read a version SHA from Git metadata inside an extracted backup archive. Some backup archives include a .git folder, and this recovers its HEAD version.

**Data flow**: It receives the extracted repository path. If there is no .git directory, it returns no version. If there is one, it reads HEAD; for a reference-style HEAD it validates the reference and resolves it, otherwise it returns the direct SHA text.

**Call relations**: The backup-archive sync path calls this after extraction. It uses validate_backup_archive_git_ref and read_git_ref_sha to safely resolve reference-based HEAD files.

*Call graph*: calls 2 internal fn (read_git_ref_sha, validate_backup_archive_git_ref); called by 1 (sync_openai_plugins_repo_via_backup_archive); 3 external calls (join, format!, read_to_string).


##### `validate_backup_archive_git_ref`  (lines 807–833)

```
fn validate_backup_archive_git_ref(reference: &str) -> Result<&str, String>
```

**Purpose**: Checks that a Git reference name from a backup archive is safe to use as a path under the archive’s .git directory. This prevents path tricks such as absolute paths or parent-directory escapes.

**Data flow**: It receives a reference string, requires it to start with refs/, rejects absolute paths and unusual path components, and returns the original reference if safe.

**Call relations**: read_extracted_backup_archive_git_sha calls this before reading a referenced Git ref file from an extracted backup archive.

*Call graph*: called by 1 (read_extracted_backup_archive_git_sha); 2 external calls (new, format!).


##### `read_git_ref_sha`  (lines 835–866)

```
fn read_git_ref_sha(git_dir: &Path, reference: &str) -> Result<String, String>
```

**Purpose**: Resolves a Git reference inside an extracted .git directory to its SHA. It supports both loose ref files and Git’s packed-refs file.

**Data flow**: It receives the .git directory path and a validated reference name. It first tries to read the ref file directly; if missing, it scans packed-refs for a matching line. It returns the SHA or an error if the ref cannot be resolved.

**Call relations**: read_extracted_backup_archive_git_sha calls this when HEAD points to a named ref instead of containing a SHA directly.

*Call graph*: called by 1 (read_extracted_backup_archive_git_sha); 3 external calls (join, format!, read_to_string).


##### `fetch_github_text`  (lines 868–881)

```
async fn fetch_github_text(client: &Client, url: &str, context: &str) -> Result<String, String>
```

**Purpose**: Fetches text from a GitHub API URL and reports HTTP failures with the response body. It is used for JSON API calls.

**Data flow**: It receives an HTTP client, URL, and context label. It builds a GitHub request with the right headers, sends it, reads the response text, and returns the body only if the status is successful.

**Call relations**: fetch_curated_repo_remote_sha uses this for GitHub repository and ref metadata requests. It relies on github_request to apply GitHub-specific headers and timeout.

*Call graph*: calls 1 internal fn (github_request); called by 1 (fetch_curated_repo_remote_sha); 1 external calls (format!).


##### `fetch_github_bytes`  (lines 883–900)

```
async fn fetch_github_bytes(client: &Client, url: &str, context: &str) -> Result<Vec<u8>, String>
```

**Purpose**: Fetches binary data from a GitHub API URL and reports HTTP failures clearly. It is used for zip archive downloads.

**Data flow**: It receives an HTTP client, URL, and context label. It sends a GitHub request, reads the response bytes, returns them on success, or turns the body into text for a helpful error on failure.

**Call relations**: fetch_curated_repo_zipball uses this to download the repository zipball. It shares request setup with fetch_github_text through github_request.

*Call graph*: calls 1 internal fn (github_request); called by 1 (fetch_curated_repo_zipball); 2 external calls (from_utf8_lossy, format!).


##### `fetch_public_text`  (lines 902–917)

```
async fn fetch_public_text(client: &Client, url: &str, context: &str) -> Result<String, String>
```

**Purpose**: Fetches plain text from a non-GitHub public URL, using the backup archive timeout. It is used for the backup archive metadata endpoint.

**Data flow**: It receives an HTTP client, URL, and context label. It sends a GET request, reads the text body, and returns it only when the HTTP status is successful.

**Call relations**: fetch_curated_repo_backup_archive_zip calls this first to discover the actual backup archive download URL.

*Call graph*: called by 1 (fetch_curated_repo_backup_archive_zip); 2 external calls (get, format!).


##### `fetch_public_bytes`  (lines 919–938)

```
async fn fetch_public_bytes(client: &Client, url: &str, context: &str) -> Result<Vec<u8>, String>
```

**Purpose**: Fetches binary data from a non-GitHub public URL, using the backup archive timeout. It is used to download the backup archive itself.

**Data flow**: It receives an HTTP client, URL, and context label. It sends a GET request, reads bytes from the response, returns them on success, or includes the response body in an error on failure.

**Call relations**: fetch_curated_repo_backup_archive_zip calls this after parsing the backup metadata download URL.

*Call graph*: called by 1 (fetch_curated_repo_backup_archive_zip); 3 external calls (from_utf8_lossy, get, format!).


##### `github_request`  (lines 940–946)

```
fn github_request(client: &Client, url: &str) -> reqwest::RequestBuilder
```

**Purpose**: Builds a GitHub API GET request with the expected timeout and headers. The headers tell GitHub which API format and version the code expects.

**Data flow**: It receives an HTTP client and URL, starts a GET request, adds a timeout plus GitHub accept and API-version headers, and returns the request builder ready to send.

**Call relations**: fetch_github_text and fetch_github_bytes both call this so every GitHub API request is configured the same way.

*Call graph*: called by 2 (fetch_github_bytes, fetch_github_text); 1 external calls (get).


##### `read_sha_file`  (lines 948–953)

```
fn read_sha_file(sha_path: &Path) -> Option<String>
```

**Purpose**: Reads a version marker file and returns its non-empty trimmed contents. Empty or missing files are treated as no version.

**Data flow**: It receives a path, tries to read it as text, trims whitespace, filters out an empty result, and returns either the version string or nothing.

**Call relations**: The public SHA reader, the Git local-version reader, and the HTTP sync path use this whenever they need the saved curated plugins version.

*Call graph*: called by 3 (read_curated_plugins_sha, read_local_git_or_sha_file, sync_openai_plugins_repo_via_http); 1 external calls (read_to_string).


##### `extract_zipball_to_dir`  (lines 955–1028)

```
fn extract_zipball_to_dir(bytes: &[u8], destination: &Path) -> Result<(), String>
```

**Purpose**: Unpacks a downloaded curated plugins zip archive into a destination folder safely. It strips the archive’s top-level wrapper directory and refuses entries that would escape the destination.

**Data flow**: It receives zip bytes and a destination path, creates the destination, opens the zip archive, walks each entry, validates its enclosed path, drops the first path component, creates directories or files, copies file contents, and applies stored permissions where supported.

**Call relations**: The HTTP and backup-archive sync paths call this after downloading archive bytes. It calls apply_zip_permissions for each extracted file.

*Call graph*: calls 2 internal fn (apply_zip_permissions, new); called by 2 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_http); 7 external calls (join, new, new, format!, create, create_dir_all, copy).


##### `apply_zip_permissions`  (lines 1046–1051)

```
fn apply_zip_permissions(
    _entry: &zip::read::ZipFile<'_>,
    _output_path: &Path,
) -> Result<(), String>
```

**Purpose**: Applies file permission bits from a zip entry after extraction when the operating system supports Unix-style permissions. On non-Unix systems, this is effectively a no-op.

**Data flow**: It receives the zip entry and output file path. On Unix, it reads the entry’s saved mode and sets that mode on the output file if present; otherwise it returns success without changes.

**Call relations**: extract_zipball_to_dir calls this after writing each extracted file, preserving executable bits and similar permissions from the archive where possible.

*Call graph*: called by 1 (extract_zipball_to_dir); 3 external calls (unix_mode, from_mode, set_permissions).


### `chatgpt/src/get_task.rs`

`io_transport` · `during apply-command task retrieval`

This file is a small bridge between the local command and the remote ChatGPT task service. When the user wants to apply a task, the program needs to ask the service, “What is the current task, and does it contain a pull-request-style diff?” Without this file, the apply command would have to build the web address itself and pick through the returned data by hand.

The response types describe only the fields this command cares about. A task may have a current assistant turn, and that turn may contain several output items. Most item types are ignored. The important one is a `pr` item, which contains an `output_diff`, and inside that is the actual diff text. The `serde` annotations tell Rust how to turn the service’s JSON response into these Rust structs. JSON is a common text format for web APIs; `serde` is the library doing the unpacking.

The main action is `get_task`. It builds a path like `/wham/tasks/<task id>` and asks the shared ChatGPT client to make a GET request. A GET request is the usual web operation for retrieving information. The result is a `GetTaskResponse`, ready for the caller to inspect.

#### Function details

##### `get_task`  (lines 37–40)

```
async fn get_task(config: &Config, task_id: String) -> anyhow::Result<GetTaskResponse>
```

**Purpose**: Fetches a single task from the ChatGPT service using its task ID. It returns the response in a structured form so the caller can look for the assistant’s diff output.

**Data flow**: It receives the program configuration, which includes the information needed to contact the service, and a task ID string. It turns the task ID into the API path `/wham/tasks/<task id>`, sends that path through the shared ChatGPT GET-request helper, waits for the web response, and returns either the parsed `GetTaskResponse` or an error if the request or parsing fails.

**Call relations**: When `run_apply_command` needs the task contents, it calls `get_task`. `get_task` does the small bit of task-specific URL building, then hands the actual web request to `chatgpt_get_request`, which is the shared helper responsible for talking to the ChatGPT API.

*Call graph*: calls 1 internal fn (chatgpt_get_request); called by 1 (run_apply_command); 1 external calls (format!).


### Update and rate-limit checks
These files query backend rate-limit reset state, gate memory startup on available headroom, and coordinate CLI and TUI update discovery.

### `backend-client/src/client/rate_limit_resets.rs`

`io_transport` · `request handling`

Many services limit how often a user can make requests. This file is the part of the backend client that talks to the server about those limits and about special “reset credits” that can restore or extend usage. Without it, other parts of the program could not reliably show current rate-limit information or redeem a reset credit through the backend API.

The file adds several methods to the shared `Client` type. One method fetches the raw usage information from the server, then reshapes part of that response into the simpler structure the rest of the program expects. Another method sends a request to consume one reset credit, including a `redeem_request_id`, which is an identifier used to tie the redemption to a specific request.

The file also hides the details of backend URL differences. The same client can speak to two slightly different API layouts, named `CodexApi` and `ChatGptApi`. The helper methods choose the right path for each style. This is like having one mailing clerk who knows whether a form should go to “Room A” or “Room B,” so the rest of the office does not need to remember the address.

#### Function details

##### `Client::get_rate_limits_with_reset_credits`  (lines 19–25)

```
async fn get_rate_limits_with_reset_credits(&self) -> Result<RateLimitsWithResetCredits>
```

**Purpose**: Fetches the user’s current rate-limit state together with any reset credits, then returns it in the shape expected by callers. Someone would use this when they need to display or decide based on both normal usage limits and available reset credits.

**Data flow**: It starts with the client’s configured connection details and asks the backend for the full rate-limit status. From the response, it converts the raw rate-limit entries into snapshot-style records and keeps the reset-credit information as returned. The output is a combined `RateLimitsWithResetCredits` value; it does not change local client state.

**Call relations**: This is the higher-level read method. When called, it first relies on `Client::get_rate_limit_status` to do the actual server request, then passes the returned rate-limit data through `rate_limit_snapshots_from_payload` so the rest of the program receives a cleaner, familiar view.

*Call graph*: calls 1 internal fn (get_rate_limit_status); 1 external calls (rate_limit_snapshots_from_payload).


##### `Client::get_rate_limit_status`  (lines 27–32)

```
async fn get_rate_limit_status(&self) -> Result<RateLimitStatusWithResetCredits>
```

**Purpose**: Gets the raw rate-limit status response from the backend. It is kept as an internal helper because most callers want the friendlier combined result from `Client::get_rate_limits_with_reset_credits`.

**Data flow**: It builds the correct usage-status URL from the client’s base address and API style, creates an authenticated HTTP GET request, sends it, and reads the response body and content type. It then decodes the response as JSON into a `RateLimitStatusWithResetCredits` value, or returns an error if the request or decoding fails.

**Call relations**: `Client::get_rate_limits_with_reset_credits` calls this when it needs fresh usage data. Before sending the request, this function asks `Client::rate_limit_status_url` for the exact endpoint to contact.

*Call graph*: calls 1 internal fn (rate_limit_status_url); called by 1 (get_rate_limits_with_reset_credits).


##### `Client::consume_rate_limit_reset_credit`  (lines 34–47)

```
async fn consume_rate_limit_reset_credit(
        &self,
        redeem_request_id: &str,
    ) -> Result<ConsumeRateLimitResetCreditResponse>
```

**Purpose**: Spends one available rate-limit reset credit by asking the backend to redeem it for a specific request. This is used when the app has decided to apply a reset credit and needs the server to record that action.

**Data flow**: It receives a `redeem_request_id`, wraps it in a small JSON request body, and sends an authenticated HTTP POST request to the backend. The request is marked as JSON using the `Content-Type` header. The server’s response body is then decoded into a `ConsumeRateLimitResetCreditResponse`, or an error is returned if anything goes wrong.

**Call relations**: This is the main write method in the file. It first calls `Client::consume_rate_limit_reset_credit_url` to choose the right backend endpoint, and it uses `from_static` to set the fixed JSON content-type header before sending the request.

*Call graph*: calls 1 internal fn (consume_rate_limit_reset_credit_url); 1 external calls (from_static).


##### `Client::rate_limit_status_url`  (lines 49–54)

```
fn rate_limit_status_url(&self) -> String
```

**Purpose**: Builds the URL used to ask the backend for current usage and rate-limit status. It keeps API path differences in one small place so callers do not need to know them.

**Data flow**: It reads the client’s `base_url` and `path_style`. If the client is using the Codex-style API, it appends the Codex usage path; if it is using the ChatGPT-style API, it appends the alternate usage path. The result is a complete URL string.

**Call relations**: `Client::get_rate_limit_status` calls this just before making its GET request. This helper hands back the address that tells the request where to go.

*Call graph*: called by 1 (get_rate_limit_status); 1 external calls (format!).


##### `Client::consume_rate_limit_reset_credit_url`  (lines 56–68)

```
fn consume_rate_limit_reset_credit_url(&self) -> String
```

**Purpose**: Builds the URL used to redeem a rate-limit reset credit. It exists so the redemption request can work with either supported backend path layout.

**Data flow**: It reads the client’s `base_url` and `path_style`, then appends the correct reset-credit consumption path for that API style. The output is a complete URL string ready for an HTTP POST request.

**Call relations**: `Client::consume_rate_limit_reset_credit` calls this before sending the redemption request. This helper supplies the destination address, while the caller supplies the request body and sends it.

*Call graph*: called by 1 (consume_rate_limit_reset_credit); 1 external calls (format!).


### `memories/write/src/guard.rs`

`domain_logic` · `startup`

The memories writer likely does background work that talks to the Codex backend. This file protects that startup path by asking: “Do we have enough rate-limit room to safely begin?” A rate limit is a cap on how much a service lets you use it in a given time window. Without this guard, the memory feature could start even when the user is nearly out of quota, making other Codex work fail sooner.

The flow is intentionally cautious but forgiving. The public function tries to check the real backend limits. If the check cannot be completed, it allows startup rather than blocking the feature because of a temporary error. When a real check is possible, the file first gets the current login, confirms it is a Codex backend login, builds a backend client, fetches rate-limit snapshots, and picks the Codex-specific limit if it is present. It then compares the reported usage against the configured minimum remaining percentage.

The smaller helper functions turn the raw rate-limit snapshot into a simple yes or no. If the backend says a limit has already been reached, startup is denied. Otherwise, each available rate-limit window must be below the maximum allowed usage. Missing window data is treated as acceptable, like saying “no warning sign was posted, so do not stop the car.”

#### Function details

##### `rate_limits_ok`  (lines 9–13)

```
async fn rate_limits_ok(auth_manager: &AuthManager, config: &Config) -> bool
```

**Purpose**: This is the simple yes-or-no entry point used before starting the memories writer. It asks the deeper checker whether rate limits permit startup, and if that checker cannot give an answer, it chooses to allow startup.

**Data flow**: It receives the authentication manager and configuration. It passes both into the detailed rate-limit check, waits for the answer, and turns a missing answer into `true`. The output is a boolean: `true` means the memories startup may continue, and `false` means it should be skipped.

**Call relations**: The memories startup task calls this function when deciding whether to begin. This function delegates the real work to `rate_limits_check`, then smooths over uncertainty so a failed lookup does not automatically disable memories.

*Call graph*: calls 1 internal fn (rate_limits_check); called by 1 (start_memories_startup_task).


##### `rate_limits_check`  (lines 15–47)

```
async fn rate_limits_check(auth_manager: &AuthManager, config: &Config) -> Option<bool>
```

**Purpose**: This function performs the actual backend rate-limit lookup and decides whether the current quota is high enough for memories to start. It returns no answer when the check cannot be meaningfully done, such as when there is no suitable backend authentication or the backend call fails.

**Data flow**: It starts with the authentication manager and configuration. It reads the current login, checks whether that login uses the Codex backend, builds a backend client from the configured base URL and auth data, and asks the backend for rate-limit snapshots. From those snapshots it chooses the Codex-specific limit when possible, otherwise the first available limit. It then reads the configured minimum remaining percentage and passes the chosen snapshot to `snapshot_allows_startup`. The result is `Some(true)` if startup is allowed, `Some(false)` if quota is too low, or `None` if the check could not be completed. It also logs a message when startup is skipped because limits are too low.

**Call relations**: `rate_limits_ok` calls this as the detailed checker. Inside, it calls the auth system to get login information, uses the backend client constructor to create a service connection, calls `snapshot_allows_startup` to interpret the returned rate-limit data, and logs through `info!` when the guard blocks startup.

*Call graph*: calls 2 internal fn (auth, snapshot_allows_startup); called by 1 (rate_limits_ok); 2 external calls (from_auth, info!).


##### `snapshot_allows_startup`  (lines 49–57)

```
fn snapshot_allows_startup(snapshot: &RateLimitSnapshot, min_remaining_percent: i64) -> bool
```

**Purpose**: This function turns one backend rate-limit snapshot into a startup decision. It checks both whether a hard limit has already been reached and whether the current usage leaves enough configured room.

**Data flow**: It receives one rate-limit snapshot and a minimum remaining percentage from configuration. If the snapshot says a limit has already been reached, it immediately returns `false`. Otherwise it converts the minimum remaining percentage into the maximum allowed used percentage, clamps unusual configuration values into the normal 0 to 100 range, and checks both the primary and secondary rate-limit windows. It returns `true` only if both windows are acceptable.

**Call relations**: `rate_limits_check` calls this after choosing the relevant backend snapshot. This function relies on `window_allows_startup` for the repeated per-window comparison, so the snapshot-level decision stays focused on the overall rule.

*Call graph*: calls 1 internal fn (window_allows_startup); called by 1 (rate_limits_check).


##### `window_allows_startup`  (lines 59–64)

```
fn window_allows_startup(window: Option<&RateLimitWindow>, max_used_percent: f64) -> bool
```

**Purpose**: This helper checks one rate-limit window, such as one time period tracked by the backend. It answers whether that window's used percentage is still low enough to permit startup.

**Data flow**: It receives either a rate-limit window or no window at all, plus the maximum used percentage allowed. If a window is present, it compares the window's used percentage with the maximum. If no window is present, it returns `true`, treating missing data as not blocking startup.

**Call relations**: `snapshot_allows_startup` calls this for the snapshot's primary and secondary windows. It supplies the small, repeated comparison that lets the higher-level function combine both windows into one final decision.

*Call graph*: called by 1 (snapshot_allows_startup).


### `cli/src/doctor/updates.rs`

`domain_logic` · `doctor diagnostics`

This file is like a pre-flight checklist for Codex updates. When a user runs the Doctor diagnostics, it gathers clues about how Codex was installed, what update command would apply, what version information is cached locally, and what the latest available version appears to be online. Without this check, a user might run an update command that succeeds but updates the wrong installation, leaving the Codex command they use unchanged.

The main flow starts by finding the currently running executable and asking the install-context code how this copy of Codex seems to be installed: npm, Bun, Homebrew, a standalone installer, or something unknown. It then records the expected update command in plain text. If the current launch appears to be npm-managed, it performs an extra safety check: it compares the package root that launched Codex with the global npm package root. If those do not match, the check fails because `npm install -g` would update a different copy.

The file also reads a local `version.json` cache from the Codex home directory and tries a short network probe for the latest release. Network failures only produce a warning, not a full failure, because update freshness is helpful context but should not hide more serious installation problems.

#### Function details

##### `updates_check`  (lines 33–108)

```
fn updates_check(config: &Config) -> DoctorCheck
```

**Purpose**: Builds the Doctor report row for update health. It decides whether the current Codex installation has a sensible update path and whether the latest-version check can be read.

**Data flow**: It receives the user’s configuration, including the Codex home directory and whether startup update checks are enabled. It looks up the current executable, determines the install style, adds cached version details, checks npm update targeting when relevant, and probes for the latest version. It returns a `DoctorCheck` containing a status, summary, details, and sometimes a suggested fix.

**Call relations**: This is the top-level function in this file. The Doctor system calls it when assembling diagnostic results. During that flow it asks helper functions for the update command label, cached version details, latest online version, and version comparison, then packages everything into a Doctor check object.

*Call graph*: calls 4 internal fn (new, fetch_latest_version, is_newer, push_cached_version_details); 7 external calls (env!, format!, current_exe, doctor_install_context, doctor_managed_by_npm, npm_global_root_check, vec!).


##### `push_cached_version_details`  (lines 110–130)

```
fn push_cached_version_details(details: &mut Vec<String>, version_file: &Path)
```

**Purpose**: Adds human-readable facts about the local update-version cache to the Doctor details. This helps support and users see what Codex last believed about available versions.

**Data flow**: It receives a growing list of detail strings and the path to `version.json`. It tries to read the file, parse it as JSON, and extract the cached latest version, last check time, and dismissed version if present. It changes the detail list in place; it does not return a separate value.

**Call relations**: It is called by `updates_check` while that function is collecting evidence. Its job is narrow: read the local cache and translate whatever is found, including missing or unreadable files, into plain diagnostic lines.

*Call graph*: called by 1 (updates_check); 2 external calls (format!, read_to_string).


##### `update_action_label`  (lines 132–140)

```
fn update_action_label(context: &InstallContext) -> &'static str
```

**Purpose**: Turns an installation method into the update command or update route a user would expect. This makes the Doctor output understandable instead of showing internal install-method names.

**Data flow**: It receives an `InstallContext`, looks at its installation method, and returns a fixed text label such as an npm, Bun, or Homebrew update command. It does not modify anything.

**Call relations**: It supports `updates_check` at the start of the diagnostic flow. The label it provides becomes part of the details shown to the user, explaining what kind of update path Codex thinks applies.


##### `fetch_latest_version`  (lines 142–150)

```
fn fetch_latest_version(context: &InstallContext) -> Result<String, String>
```

**Purpose**: Chooses the right online source for the latest Codex version based on how Codex was installed. Homebrew installs use Homebrew metadata; other install styles use the GitHub release feed.

**Data flow**: It receives an `InstallContext`. If the method is Homebrew, it asks the Homebrew-specific fetch function for a cask version. Otherwise it asks the GitHub-specific fetch function for the latest release version. It returns either a version string or an error message.

**Call relations**: It is called by `updates_check` after local consistency checks are complete. It acts as a small router, handing the work to `fetch_homebrew_cask_version` or `fetch_latest_github_release_version` so the main Doctor check does not need to know the details of each online source.

*Call graph*: calls 2 internal fn (fetch_homebrew_cask_version, fetch_latest_github_release_version); called by 1 (updates_check).


##### `fetch_latest_github_release_version`  (lines 152–163)

```
fn fetch_latest_github_release_version() -> Result<String, String>
```

**Purpose**: Fetches the latest Codex release version from GitHub. It also strips the expected `rust-v` prefix from the release tag so the rest of the code can compare plain version numbers.

**Data flow**: It requests JSON from the GitHub latest-release URL and reads the `tag_name` field. If the tag starts with `rust-v`, it removes that prefix and returns the remaining version text. If the tag is in an unexpected shape, it returns an error message.

**Call relations**: It is used by `fetch_latest_version` for npm, Bun, standalone, and unknown install styles. It relies on the shared HTTP-and-JSON helper to get structured data from the network before doing its small bit of Codex-specific tag parsing.

*Call graph*: called by 1 (fetch_latest_version).


##### `fetch_homebrew_cask_version`  (lines 165–172)

```
fn fetch_homebrew_cask_version() -> Result<String, String>
```

**Purpose**: Fetches the latest Codex version as Homebrew reports it. This matters because Homebrew packages can have their own metadata source separate from GitHub releases.

**Data flow**: It requests JSON from the Homebrew cask API and reads the `version` field. If the request and parsing work, it returns that version string; otherwise it returns an error message.

**Call relations**: It is used by `fetch_latest_version` when the installation method is Homebrew. Like the GitHub fetch path, it uses the shared HTTP-and-JSON helper so the network behavior is kept in one place.

*Call graph*: called by 1 (fetch_latest_version).


##### `http_get_json`  (lines 174–180)

```
fn http_get_json(url: &str) -> Result<T, String>
```

**Purpose**: Downloads JSON from a URL and turns it into a Rust data structure chosen by the caller. It is the small common bridge between command-line network fetching and typed version metadata.

**Data flow**: It receives a URL and a target JSON shape. It runs `curl` with flags that fail on HTTP errors, stay quiet, follow redirects, and stop after five seconds. It then parses the response body as JSON and returns either the parsed value or a readable error string.

**Call relations**: The latest-version fetch functions use this helper when they need online metadata. It delegates the actual command execution to the shared `run_command` utility, then gives parsed data back to the version-specific caller.

*Call graph*: 1 external calls (run_command).


##### `is_newer`  (lines 182–187)

```
fn is_newer(latest: &str, current: &str) -> Option<bool>
```

**Purpose**: Compares two plain version strings and says whether the first is newer than the second. It avoids guessing when either version is not in the simple three-number form it understands.

**Data flow**: It receives a latest version string and a current version string. It asks `parse_version` to turn each into three numbers: major, minor, and patch. If both parse cleanly, it compares the number triples and returns `Some(true)` or `Some(false)`; otherwise it returns `None` to mean “not sure.”

**Call relations**: It is called by `updates_check` after the latest online version is fetched. Its answer is used only to add a detail line saying whether a newer version appears to be available.

*Call graph*: calls 1 internal fn (parse_version); called by 1 (updates_check).


##### `parse_version`  (lines 189–195)

```
fn parse_version(value: &str) -> Option<(u64, u64, u64)>
```

**Purpose**: Turns a simple version like `1.2.3` into numbers that can be compared safely. It deliberately does not accept more complex versions such as beta tags.

**Data flow**: It receives a text value, trims surrounding whitespace, splits it on dots, and tries to parse the first three pieces as whole numbers. If that works, it returns the three-number tuple; if any piece is missing or not numeric, it returns nothing.

**Call relations**: It is the helper behind `is_newer`. By keeping parsing strict, it lets the comparison function avoid making unreliable claims about unusual version strings.

*Call graph*: called by 1 (is_newer).


##### `tests::is_newer_compares_plain_semver`  (lines 211–215)

```
fn is_newer_compares_plain_semver()
```

**Purpose**: Checks that version comparison works for ordinary three-part versions and refuses a beta-style version. This protects the Doctor check from reporting misleading update status.

**Data flow**: It feeds known version pairs into `is_newer` and compares the results with the expected answers. The test passes if newer, older, and unparseable beta cases all behave as intended.

**Call relations**: This test exercises the comparison helper used by `updates_check`. It is run during automated testing, not during normal Doctor diagnostics.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::update_action_labels_install_contexts`  (lines 218–233)

```
fn update_action_labels_install_contexts()
```

**Purpose**: Checks that install methods are translated into the right user-facing update labels. This keeps Doctor output clear and stable.

**Data flow**: It builds sample install contexts for npm and an unknown/manual install, passes them to `update_action_label`, and verifies the returned text. It does not change any project state.

**Call relations**: This test covers the label helper used by `updates_check`. It runs in the test suite to catch accidental changes to the wording or mapping.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/updates.rs`

`orchestration` · `startup and background update refresh`

This file is the update-notification helper for the TUI, meaning the terminal-based interface. Its job is not to install updates. Instead, it answers a simpler question: “Is there a newer version the user should hear about?”

To avoid slowing down startup, it mostly relies on a small cache file saved on disk. When the app starts, it reads the last known latest version from that file. If the cache is missing or old, it starts a background task to refresh it from the internet, then lets the app continue. That means the current run may use yesterday’s information, and the next run will have fresh data. This is like checking a notice board from a saved photo while someone else quietly goes to take a new photo.

The file knows that update sources differ by installation method. Homebrew users are checked against Homebrew’s cask API, because Homebrew can lag behind GitHub releases. npm and bun users are checked against GitHub too, but the code also verifies that the npm package is actually ready before advertising that version. Standalone installs use the latest GitHub release.

It also respects user preference. If update checks are disabled, or if the program was built from source rather than a normal release, it stays silent. For popups, it additionally checks whether the user already dismissed this exact version.

#### Function details

##### `get_upgrade_version`  (lines 24–54)

```
fn get_upgrade_version(config: &Config) -> Option<String>
```

**Purpose**: This function decides whether the app currently knows about a newer version that should be shown somewhere in the interface. It also kicks off a background refresh when the saved update information is missing or stale, so the user interface does not have to wait for the network.

**Data flow**: It receives the user configuration and reads the current program version plus the cached update file path. If update checks are disabled, or this is a source-built version, it immediately returns nothing. Otherwise it reads the cached latest version, decides whether the cache is older than about 20 hours, and if needed starts an asynchronous background check. Finally, it compares the cached latest version with the current version and returns the newer version string only if an upgrade is actually available.

**Call relations**: The main TUI run path calls this when it wants to know whether to show update information. It asks the update-action code how this install should be upgraded, uses the cache helpers to find and read the saved version file, and hands refresh work to check_for_update in a spawned background task. get_upgrade_version_for_popup also calls it as the first step before applying popup-specific dismissal rules.

*Call graph*: calls 5 internal fn (get_update_action, is_source_build_version, check_for_update, read_version_info, version_filepath); called by 2 (run, get_upgrade_version_for_popup); 3 external calls (hours, now, spawn).


##### `check_for_update`  (lines 70–113)

```
async fn check_for_update(version_file: &Path, action: Option<UpdateAction>) -> anyhow::Result<()>
```

**Purpose**: This function refreshes the saved record of the latest available version. It contacts the right online source for the user’s installation method, then writes the result into the local cache file.

**Data flow**: It receives the path of the version cache file and an optional update action that describes how this install should be updated. Based on that action, it fetches either the Homebrew cask version, the latest GitHub release, or the GitHub release plus npm registry confirmation. It then rereads the old cache so it can preserve any version the user dismissed, builds a new VersionInfo record with the current time, creates the cache directory if needed, and writes the record as JSON to disk. The result is success or an error explaining what went wrong.

**Call relations**: get_upgrade_version starts this function in the background when the cached update information is stale or missing. Inside, it may call fetch_latest_github_release_version to get the newest GitHub release, uses the HTTP client to talk to Homebrew or npm services, and uses npm_registry::ensure_version_ready to avoid advertising an npm update before it is actually available.

*Call graph*: calls 4 internal fn (create_client, ensure_version_ready, fetch_latest_github_release_version, read_version_info); called by 1 (get_upgrade_version); 5 external calls (parent, now, format!, create_dir_all, write).


##### `fetch_latest_github_release_version`  (lines 115–126)

```
async fn fetch_latest_github_release_version() -> anyhow::Result<String>
```

**Purpose**: This function asks GitHub for the newest Codex release and turns GitHub’s release tag into a plain version number the rest of the update code can compare.

**Data flow**: It makes an HTTP request to GitHub’s “latest release” endpoint and reads the returned tag name, such as a release label. It then passes that tag to the version parsing helper, which extracts the usable version string. It returns that version string, or an error if the network request, response parsing, or tag conversion fails.

**Call relations**: check_for_update calls this whenever GitHub is the source of truth for the latest version, either directly for standalone installs or as part of the npm and bun update path. It delegates the tag-cleaning detail to extract_version_from_latest_tag so the rest of the update flow can work with a normal version string.

*Call graph*: calls 2 internal fn (create_client, extract_version_from_latest_tag); called by 1 (check_for_update).


##### `get_upgrade_version_for_popup`  (lines 130–144)

```
fn get_upgrade_version_for_popup(config: &Config) -> Option<String>
```

**Purpose**: This function decides whether the app should show a popup about a newer version. It is stricter than get_upgrade_version because it respects the user’s choice to dismiss the current latest version.

**Data flow**: It receives the user configuration. If update checks are disabled or this is a source-built version, it returns nothing. Otherwise it asks get_upgrade_version for the latest known upgrade version. Then it reads the cache file and checks whether the user previously dismissed that exact version. If so, it returns nothing; if not, it returns the version string to show in the popup.

**Call relations**: The update-prompt flow calls this when deciding whether to interrupt the user with a visible popup. It builds on get_upgrade_version for the basic update check and uses the cache helpers to honor any saved dismissal, so the popup logic does not need to know how update checks or cache files work.

*Call graph*: calls 4 internal fn (is_source_build_version, get_upgrade_version, read_version_info, version_filepath); called by 1 (run_update_prompt_if_needed).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-cloud-config-cache` — The cached and refreshed cloud-delivered configuration bundles that can alter settings, requirements, and available features.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-tls-crypto-provider` — The one process-wide cryptography provider chosen early so HTTPS and other TLS connections use the same security engine.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-update-check-state` — Cached update notices, downloaded-or-pending update metadata, and daemon restart/update status produced by update checks and consumed by UI or teardown restart logic.
- `reg-connector-directory-cache` — Cached ChatGPT/app connector directories, workspace connector settings, local connector metadata, and fallback lookup results used when exposing connectors to sessions and prompts.
- `reg-cloud-task-state` — Cloud task lists, task details, submission attempts, selected task environments, and polling/refresh status shared by cloud task commands and clients.
- `reg-local-model-runtime-state` — Live readiness, endpoint, health, and launch/connect status for local model backends such as Ollama, LM Studio, and OSS helpers, separate from the model catalog itself.
- `reg-memory-write-safety-state` — Cached or in-flight safety decisions for whether proposed long-term memory writes should be allowed before they update the memory store.
