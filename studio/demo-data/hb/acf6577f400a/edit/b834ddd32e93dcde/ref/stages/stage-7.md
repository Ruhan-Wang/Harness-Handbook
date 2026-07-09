# Backend clients, remote catalogs, and startup refreshes  `stage-7`

This stage is the system’s “stock up before opening” step. After sign-in and basic settings are ready, it reaches out to outside services and local model servers to collect the facts the app needs before it can show rich choices or safely start extra features.

The cloud-config files fetch a packaged set of server-controlled settings, check that it is valid, cache it on disk, and keep it fresh in the background. The model files do the same kind of work for model catalogs: they call remote “/models” endpoints, adapt provider-specific catalogs such as Amazon Bedrock, and turn raw model lists into the ready-to-pick presets the UI uses. For open-source and local setups, the Ollama and LM Studio code checks whether the local server is reachable, whether required models exist, and starts downloads or loading when needed.

Connector and plugin discovery is another part of this stage. Connectors are fetched, cleaned up, merged from several sources, and filtered so the app knows what external tools are available. Startup plugin sync copies a curated plugin snapshot locally. A few smaller pieces round this out: workspace settings decide if plugins are allowed, rate-limit checks can block memory-writing work, and update checks refresh cached version information.

## Files in this stage

### Cloud config loading
These files define the public cloud-config surface, the backend fetch adapter, the bundle lifecycle service, and the integrated loader used at startup.

### `cloud-config/src/lib.rs`

`orchestration` · `startup and config refresh`

This crate root establishes the internal decomposition of cloud configuration into six modules: `backend`, `bundle_loader`, `cache`, `metrics`, `service`, and `validation`. The crate-level documentation is especially important here: it states that this crate is responsible for transport, caching, and refresh behavior for cloud-hosted Codex configuration, while parsing and composition are intentionally delegated to `codex-config`. That separation is a key invariant—this crate moves and maintains configuration bundles, but does not define the semantic interpretation of the config format itself. The only public exports are `cloud_config_bundle_loader` and `cloud_config_bundle_loader_for_storage`, both re-exported from `bundle_loader`, which strongly suggests that callers interact with the subsystem through loader constructors rather than directly manipulating backend, cache, or validation internals. The private modules imply a layered pipeline: retrieve bundles from a backend, validate them, cache them, emit metrics, and expose the result through a service/loader abstraction. This file therefore serves as the crate’s API contract and architectural summary rather than containing runtime logic.


### `cloud-config/src/backend.rs`

`io_transport` · `remote bundle fetches during startup and background refresh`

This file is the narrow transport adapter between `codex_backend_client` and the cloud-config service logic. It introduces `RetryableFailureKind`, which distinguishes client-construction failures from HTTP/request failures and preserves an optional HTTP status code for retry policy and metrics, and `BundleRequestError`, which separates retryable failures from explicit unauthorized responses carrying both status code and backend error text. The `BundleClient` trait intentionally returns the backend-selected bundle without validation or caching so higher layers can decide whether to trust, persist, or reject it.

`BackendBundleClient` stores only a `base_url` and, in `get_bundle`, constructs a `codex_backend_client::Client` from `CodexAuth`. Construction failures are logged and mapped to `Retryable(BackendClientInit)`. It then awaits `get_config_bundle`; unauthorized backend errors become `BundleRequestError::Unauthorized`, while all other request failures become `Retryable(Request { status_code })`. Successful responses are normalized by `bundle_from_response`.

The response conversion is deliberately defensive around the backend’s nested `Option<Option<Box<_>>>` layout. Both `config_toml` and `requirements_toml` are flattened through missing top-level sections, missing boxed payloads, and missing `enterprise_managed` vectors; absent data becomes an empty vector rather than an error. Fragment order is preserved by iterating the delivered vectors directly, and each `DeliveredTomlFragment` is copied field-for-field into either `CloudConfigFragment` or `CloudRequirementsFragment`.

#### Function details

##### `RetryableFailureKind::status_code`  (lines 19–24)

```
fn status_code(self) -> Option<u16>
```

**Purpose**: Extracts the HTTP status code, if any, from a retryable failure classification. Client initialization failures intentionally report no status code.

**Data flow**: Reads `self` and matches on the enum variant. `BackendClientInit` becomes `None`; `Request { status_code }` returns the embedded `Option<u16>` unchanged. It does not mutate any state.

**Call relations**: This helper is used when the service decides whether and how to retry a failed request, so retry logic and metrics can attach the backend status code when the failure came from an HTTP response rather than client setup.

*Call graph*: called by 1 (retry_after_request_failure).


##### `BackendBundleClient::new`  (lines 52–54)

```
fn new(base_url: String) -> Self
```

**Purpose**: Constructs a backend bundle client bound to a specific backend base URL.

**Data flow**: Consumes a `String` base URL and stores it in a new `BackendBundleClient`. It returns the initialized struct without side effects.

**Call relations**: The bundle-loader wiring creates this client before constructing `CloudConfigBundleService`, making it the concrete `BundleClient` implementation used for real backend fetches.

*Call graph*: called by 1 (cloud_config_bundle_loader).


##### `BackendBundleClient::get_bundle`  (lines 58–87)

```
async fn get_bundle(&self, auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError>
```

**Purpose**: Authenticates against the backend, requests the current config bundle, maps backend failures into service-level error categories, and converts a successful response into `CloudConfigBundle`.

**Data flow**: Takes `&self` and `&CodexAuth`. It clones `self.base_url`, passes it with auth into `BackendClient::from_auth`, logs construction errors, and maps them to `BundleRequestError::Retryable(BackendClientInit)`. On a live client, it awaits `get_config_bundle()`, logs request failures, inspects the backend error for `status()` and `is_unauthorized()`, and converts that into either `Unauthorized { status_code, message }` or `Retryable(Request { status_code })`. On success it feeds the `ConfigBundleResponse` into `bundle_from_response` and returns the resulting `CloudConfigBundle`.

**Call relations**: This is the trait method invoked by `CloudConfigBundleService` inside its retry loop. It delegates transport creation to `codex_backend_client::Client::from_auth` and payload normalization to `bundle_from_response`, while leaving validation, caching, and retry timing to the caller.

*Call graph*: calls 1 internal fn (bundle_from_response); 1 external calls (from_auth).


##### `bundle_from_response`  (lines 90–118)

```
fn bundle_from_response(response: ConfigBundleResponse) -> CloudConfigBundle
```

**Purpose**: Transforms the backend’s nested `ConfigBundleResponse` into the internal bundle model, treating all missing sections as empty collections.

**Data flow**: Consumes a `ConfigBundleResponse`. For `config_toml`, it repeatedly flattens optional layers, unwraps the boxed payload, extracts `enterprise_managed`, defaults missing vectors to empty, maps each `DeliveredTomlFragment` through `config_fragment_from_delivered`, and collects into a `Vec<CloudConfigFragment>`. It performs the same sequence for `requirements_toml` via `requirements_fragment_from_delivered`. It returns a `CloudConfigBundle` containing `CloudConfigTomlBundle` and `CloudRequirementsTomlBundle` with those vectors.

**Call relations**: Called only after a successful backend fetch. It is the final transport-to-domain conversion step before the service validates and caches the bundle.

*Call graph*: called by 1 (get_bundle).


##### `config_fragment_from_delivered`  (lines 120–126)

```
fn config_fragment_from_delivered(fragment: DeliveredTomlFragment) -> CloudConfigFragment
```

**Purpose**: Converts one delivered config TOML fragment from backend format into the internal config fragment type.

**Data flow**: Consumes a `DeliveredTomlFragment` and copies its `id`, `name`, and `contents` fields into a new `CloudConfigFragment`. It returns the new fragment and touches no external state.

**Call relations**: Used as the mapping function while building the `config_toml.enterprise_managed` vector during response conversion.


##### `requirements_fragment_from_delivered`  (lines 128–136)

```
fn requirements_fragment_from_delivered(
    fragment: DeliveredTomlFragment,
) -> CloudRequirementsFragment
```

**Purpose**: Converts one delivered requirements TOML fragment from backend format into the internal requirements fragment type.

**Data flow**: Consumes a `DeliveredTomlFragment` and copies `id`, `name`, and `contents` into a new `CloudRequirementsFragment`. It returns the converted fragment without side effects.

**Call relations**: Used as the mapping function while building the `requirements_toml.enterprise_managed` vector during response conversion.


### `cloud-config/src/service.rs`

`orchestration` · `startup load path and periodic background cache refresh`

This file contains the subsystem’s main control flow in `CloudConfigBundleService<C>`, parameterized over any `BundleClient`. The service owns an `AuthManager`, backend client, signed cache, resolved `codex_home`, and a timeout. Startup begins in `load_startup_bundle_with_timeout`, which wraps `load_startup_bundle` in a Tokio timeout, emits duration/load telemetry, and converts timeout or downstream failures into `CloudConfigBundleLoadError`.

The inner startup path first asks `AuthManager` for auth and immediately returns `None` for missing auth or ineligible accounts. Eligibility is intentionally narrow: auth must use the Codex backend and have a workspace-like plan (`business_like`, `Enterprise`, or `Edu`). For eligible auth, startup prefers cache: it derives `(chatgpt_user_id, account_id)`, loads the signed cache, validates the cached bundle with `validate_bundle`, and only uses it if both cache integrity and semantic validation succeed. Empty bundles are normalized to `None` via `optional_bundle`, but still count as successful cached/fetched results.

On cache miss, `fetch_remote_bundle_and_update_cache_with_retries` drives up to five attempts. Retryable failures use exponential backoff and preserve status codes for metrics. Unauthorized failures invoke `UnauthorizedRecovery`, potentially refreshing auth and retrying the same attempt with new credentials; transient recovery failures consume an attempt, while permanent failures surface auth-specific load errors. Successful remote bundles are validated before cache write, and cache write failures are logged but non-fatal. Separately, `refresh_cache_in_background` sleeps for a fixed interval and refreshes the on-disk cache for future startups without changing the already-loaded runtime snapshot.

#### Function details

##### `auth_identity`  (lines 43–45)

```
fn auth_identity(auth: &CodexAuth) -> (Option<String>, Option<String>)
```

**Purpose**: Extracts the cache-scoping identity tuple from the current authentication object.

**Data flow**: Borrows `&CodexAuth`, calls `get_chatgpt_user_id()` and `get_account_id()`, and returns the pair `(Option<String>, Option<String>)`.

**Call relations**: Used before cache lookup and cache save so both operations are scoped to the authenticated ChatGPT user and account.

*Call graph*: calls 2 internal fn (get_account_id, get_chatgpt_user_id); called by 2 (load_startup_bundle, validate_and_cache_remote_bundle).


##### `cloud_config_eligible_auth`  (lines 47–54)

```
fn cloud_config_eligible_auth(auth: &CodexAuth) -> bool
```

**Purpose**: Determines whether the current auth should participate in cloud-config loading at all.

**Data flow**: Borrows `&CodexAuth`, reads `account_plan_type()`, returns `false` if absent, then requires `uses_codex_backend()` and a workspace-like plan (`is_business_like()` or explicit `PlanType::Enterprise | PlanType::Edu`). It returns a boolean and mutates nothing.

**Call relations**: Called at the start of both startup loading and background refresh so non-ChatGPT auth or unsupported plans skip cache and backend work entirely.

*Call graph*: calls 2 internal fn (account_plan_type, uses_codex_backend); called by 2 (load_startup_bundle, refresh_cache_once); 1 external calls (matches!).


##### `optional_bundle`  (lines 56–62)

```
fn optional_bundle(bundle: CloudConfigBundle) -> Option<CloudConfigBundle>
```

**Purpose**: Normalizes an empty bundle into `None` while preserving non-empty bundles as `Some`.

**Data flow**: Consumes a `CloudConfigBundle`, checks `bundle.is_empty()`, and returns `None` if true or `Some(bundle)` otherwise.

**Call relations**: Used after successful cache reads and remote fetches so callers can treat an empty-but-valid backend response as a successful absence of managed policy.

*Call graph*: calls 1 internal fn (is_empty); called by 2 (load_valid_cached_bundle, validate_and_cache_remote_bundle).


##### `CloudConfigBundleService::clone`  (lines 83–91)

```
fn clone(&self) -> Self
```

**Purpose**: Creates another service handle sharing auth manager, client, cache path, and timeout.

**Data flow**: Borrows `self`, clones the internal `Arc<AuthManager>`, `Arc<C>`, `CloudConfigBundleCache`, and `AbsolutePathBuf`, copies the timeout, and returns a new `CloudConfigBundleService<C>`.

**Call relations**: Used by the bundle-loader wiring so one clone can serve the startup task while another runs the long-lived background refresh loop.

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

**Purpose**: Constructs the service with resolved home path and an on-disk cache rooted under that path.

**Data flow**: Consumes `Arc<AuthManager>`, `Arc<C>`, a `PathBuf` `codex_home`, and a timeout `Duration`. It resolves the path against `/` into an `AbsolutePathBuf`, creates `CloudConfigBundleCache::new(codex_home.clone())`, stores all fields, and returns the service.

**Call relations**: This is the main constructor used by production loader wiring and tests to instantiate the orchestration layer around a concrete or fake `BundleClient`.

*Call graph*: calls 2 internal fn (new, resolve_path_against_base); called by 19 (cloud_config_bundle_loader, get_bundle_allows_eligible_workspace_plans_and_writes_cache, get_bundle_does_not_use_cache_when_auth_identity_is_incomplete, get_bundle_empty_response_is_success_and_cached, get_bundle_ignores_cache_for_different_auth_identity, get_bundle_ignores_invalid_cache_and_refetches, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_rejects_invalid_remote_bundle_before_cache_write, get_bundle_retries_until_success (+9 more)); 1 external calls (clone).


##### `CloudConfigBundleService::load_startup_bundle_with_timeout`  (lines 114–169)

```
async fn load_startup_bundle_with_timeout(
        &self,
    ) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>
```

**Purpose**: Runs the startup load under a hard timeout, emits top-level metrics/logs, and converts timeout/joined errors into public load errors.

**Data flow**: Borrows `self`, starts a global duration timer and captures `Instant::now()`, then awaits `timeout(self.timeout, self.load_startup_bundle())`. A timeout logs an error, emits `emit_load_metric("startup", "error", None)`, and returns `CloudConfigBundleLoadError` with code `Timeout`. If the inner future returns an error, it emits the same error load metric and propagates the error. On success it logs elapsed time and fragment counts for `Some(bundle)` or a `(none)` message for `None`, emits `emit_load_metric("startup", "success", ...)`, and returns the optional bundle.

**Call relations**: This is the startup-facing entry used by the loader task. It delegates actual decision-making to `load_startup_bundle` and adds timeout enforcement plus final observability.

*Call graph*: calls 2 internal fn (emit_load_metric, load_startup_bundle); 4 external calls (now, start_global_timer, timeout, info!).


##### `CloudConfigBundleService::load_startup_bundle`  (lines 171–194)

```
async fn load_startup_bundle(
        &self,
    ) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>
```

**Purpose**: Implements the startup decision tree: get auth, check eligibility, prefer valid cache, otherwise fetch remotely.

**Data flow**: Borrows `self`, awaits `self.auth_manager.auth()`, returning `Ok(None)` if no auth exists. It then checks `cloud_config_eligible_auth`; ineligible auth also returns `Ok(None)`. For eligible auth it derives `(chatgpt_user_id, account_id)` via `auth_identity`, awaits `load_valid_cached_bundle(...)`, and returns immediately on `CachedBundleLookup::Hit(bundle)`. On `Miss`, it calls `fetch_remote_bundle_and_update_cache_with_retries(auth, "startup")` and returns that result.

**Call relations**: Called only by the timeout wrapper. It orchestrates the preference order of cache before backend and is the central startup path tested throughout `service_tests.rs`.

*Call graph*: calls 4 internal fn (fetch_remote_bundle_and_update_cache_with_retries, load_valid_cached_bundle, auth_identity, cloud_config_eligible_auth); called by 1 (load_startup_bundle_with_timeout).


##### `CloudConfigBundleService::load_valid_cached_bundle`  (lines 196–225)

```
async fn load_valid_cached_bundle(
        &self,
        chatgpt_user_id: Option<&str>,
        account_id: Option<&str>,
    ) -> CachedBundleLookup
```

**Purpose**: Attempts to load a signed cache entry and then semantically validates the cached bundle before allowing it to be used.

**Data flow**: Borrows `self` plus optional borrowed identity strings. It awaits `self.cache.load(...)`. On success, it runs `validate_bundle(&signed_payload.bundle, &self.codex_home)`. Validation failure logs a warning with cache path and error, logs synthetic `CacheInvalidBundle` status through `self.cache.log_load_status`, and returns `CachedBundleLookup::Miss`. Validation success logs that the cached bundle is being used and returns `CachedBundleLookup::Hit(optional_bundle(signed_payload.bundle))`. On cache load error, it logs the status and returns `Miss`.

**Call relations**: Invoked during startup before any remote fetch. It delegates integrity checks to the cache layer and semantic checks to `validate_bundle`, ensuring stale or malformed cached policy never reaches runtime.

*Call graph*: calls 4 internal fn (load, log_load_status, optional_bundle, validate_bundle); called by 1 (load_startup_bundle); 3 external calls (Hit, info!, warn!).


##### `CloudConfigBundleService::fetch_remote_bundle_and_update_cache_with_retries`  (lines 227–298)

```
async fn fetch_remote_bundle_and_update_cache_with_retries(
        &self,
        mut auth: CodexAuth,
        trigger: &'static str,
    ) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadE
```

**Purpose**: Fetches the bundle from the backend with bounded retries, unauthorized recovery, final metrics, and fail-closed error reporting.

**Data flow**: Consumes a mutable `CodexAuth` and a static `trigger` label. It initializes `attempt = 1`, `last_status_code = None`, and `auth_recovery = self.auth_manager.unauthorized_recovery()`. In a `while attempt <= CLOUD_CONFIG_BUNDLE_MAX_ATTEMPTS` loop, it awaits `self.client.get_bundle(&auth)`. Success delegates to `validate_and_cache_remote_bundle(&auth, trigger, attempt, bundle)` and returns its result. `BundleRequestError::Retryable(status)` stores `status.status_code()` and calls `retry_after_request_failure`; if that returns true, it increments `attempt` and continues. `Unauthorized { status_code, message }` stores the status code and delegates to `handle_unauthorized(...)`; depending on the returned `UnauthorizedRecoveryAction`, it either retries the same attempt with refreshed auth or increments the attempt and retries. If the loop exits without success, it emits `emit_fetch_final_metric(..., "request_retry_exhausted", CLOUD_CONFIG_BUNDLE_MAX_ATTEMPTS, last_status_code, None)`, logs an error, and returns `CloudConfigBundleLoadError` with code `RequestFailed`.

**Call relations**: This method is the remote-fetch engine used by both startup misses and background refreshes. It delegates per-attempt retry timing, auth recovery, and post-success validation/cache write to specialized helpers.

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

**Purpose**: Records a successful fetch attempt, validates the fetched bundle, writes it to cache if valid, and returns the normalized optional bundle.

**Data flow**: Borrows `self`, `&CodexAuth`, trigger label, attempt number, and consumes a fetched `CloudConfigBundle`. It first emits `emit_fetch_attempt_metric(trigger, attempt, "success", None)`. It then runs `validate_bundle(&bundle, &self.codex_home)`; on failure it emits `emit_fetch_final_metric(..., "invalid_bundle", attempt, None, None)` and returns the validation error. On success it derives identity via `auth_identity(auth)`, attempts `self.cache.save(chatgpt_user_id, account_id, bundle.clone()).await`, logging but ignoring cache write errors, emits `emit_fetch_final_metric(..., "success", "none", attempt, None, Some(&bundle))`, and returns `Ok(optional_bundle(bundle))`.

**Call relations**: Reached only after a backend request succeeds. It is the gate that prevents invalid remote policy from being cached or returned, and it finalizes fetch metrics for the success path.

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

**Purpose**: Handles one retryable non-auth request failure by emitting metrics, logging, and sleeping with backoff when another attempt is allowed.

**Data flow**: Borrows `self`, takes trigger label, attempt number, and `RetryableFailureKind`. It extracts `status_code`, emits `emit_fetch_attempt_metric(trigger, attempt, "error", status_code)`, and if `attempt < CLOUD_CONFIG_BUNDLE_MAX_ATTEMPTS`, logs a warning, awaits `sleep(backoff(attempt as u64))`, and returns `true`; otherwise it returns `false` immediately.

**Call relations**: Called from the main retry loop when `BundleClient::get_bundle` returns a retryable error. Its boolean result tells the caller whether to increment the attempt counter and continue or stop retrying.

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

**Purpose**: Processes unauthorized backend responses by attempting auth recovery when available and translating recovery outcomes into retry actions or auth load errors.

**Data flow**: Borrows `self`, mutably borrows the current `CodexAuth` and `UnauthorizedRecovery`, and takes trigger, attempt, optional status code, and backend message. It emits `emit_fetch_attempt_metric(trigger, attempt, "unauthorized", status_code)`. If `auth_recovery.has_next()`, it logs a warning and awaits `auth_recovery.next()`. On recovery success, it re-reads auth from `self.auth_manager.auth().await`; if missing, it emits a final metric with reason `auth_recovery_missing_auth` and returns an `Auth` load error with the generic recovery-failed message. If refreshed auth exists, it overwrites `*auth` and returns `Ok(RetrySameAttempt)`. On `RefreshTokenError::Permanent`, it logs, emits final metric reason `auth_recovery_unrecoverable`, and returns an `Auth` load error carrying the permanent failure message. On `RefreshTokenError::Transient`, it optionally sleeps with backoff if attempts remain and returns `Ok(RetryNextAttempt)`. If no recovery is available at all, it logs the backend message, emits final metric reason `auth_recovery_unavailable`, and returns an `Auth` load error with the generic recovery-failed message.

**Call relations**: Invoked only from the remote fetch loop on unauthorized responses. It encapsulates the nuanced distinction between retrying with refreshed credentials, consuming an attempt after transient recovery failure, and surfacing terminal auth errors.

*Call graph*: calls 6 internal fn (emit_fetch_attempt_metric, emit_fetch_final_metric, new, backoff, has_next, next); called by 1 (fetch_remote_bundle_and_update_cache_with_retries); 3 external calls (sleep, error!, warn!).


##### `CloudConfigBundleService::refresh_cache_in_background`  (lines 457–471)

```
async fn refresh_cache_in_background(&self)
```

**Purpose**: Runs the periodic background loop that refreshes the on-disk cache for future startups.

**Data flow**: Borrows `self` and enters an infinite loop. Each iteration sleeps for `CLOUD_CONFIG_BUNDLE_CACHE_REFRESH_INTERVAL`, then awaits `timeout(self.timeout, self.refresh_cache_once())`. `Ok(true)` means refresh completed and the loop continues; `Ok(false)` breaks the loop because auth is absent or ineligible; `Err(_)` logs a timeout error and emits `emit_load_metric("refresh", "error", None)` while keeping the existing cache and continuing future iterations.

**Call relations**: Spawned once by the bundle-loader wiring. It delegates each actual refresh attempt to `refresh_cache_once` and adds periodic scheduling plus timeout protection.

*Call graph*: calls 2 internal fn (emit_load_metric, refresh_cache_once); 3 external calls (sleep, timeout, error!).


##### `CloudConfigBundleService::refresh_cache_once`  (lines 473–496)

```
async fn refresh_cache_once(&self) -> bool
```

**Purpose**: Performs one refresh cycle: check auth/eligibility, fetch remotely with retries, update cache, and emit refresh load metrics.

**Data flow**: Borrows `self`, awaits `self.auth_manager.auth()`, and returns `false` if no auth exists. It then checks `cloud_config_eligible_auth`; ineligible auth also returns `false`. For eligible auth it awaits `fetch_remote_bundle_and_update_cache_with_retries(auth, "refresh")`. On success it emits `emit_load_metric("refresh", "success", bundle.as_ref())`; on error it logs the cache path and error and emits `emit_load_metric("refresh", "error", None)`. In either eligible case it returns `true` so the background loop continues.

**Call relations**: Called by the background loop after each interval. It reuses the same remote-fetch machinery as startup but never changes the already-loaded runtime bundle; it only refreshes the persisted cache.

*Call graph*: calls 3 internal fn (emit_load_metric, fetch_remote_bundle_and_update_cache_with_retries, cloud_config_eligible_auth); called by 1 (refresh_cache_in_background); 1 external calls (error!).


### `cloud-config/src/bundle_loader.rs`

`orchestration` · `startup wiring and long-lived background refresh setup`

This file is the top-level assembly point for cloud-config loading. Its private `refresher_task_slot` owns a process-global `OnceLock<Mutex<Option<JoinHandle<()>>>>`, ensuring there is at most one remembered background refresh task at a time. The mutex poisoning path is handled explicitly: if a previous panic poisoned the lock, the code logs a warning and continues with the inner value rather than failing closed.

`cloud_config_bundle_loader` constructs a `CloudConfigBundleService` using the provided `AuthManager`, a real `BackendBundleClient`, the caller’s `codex_home`, and the shared timeout constant. It immediately spawns two Tokio tasks: one one-shot startup load (`load_startup_bundle_with_timeout`) whose result will back the returned loader future, and one long-lived refresher loop (`refresh_cache_in_background`). The refresher task handle is stored in the global slot; if a previous handle exists, it is aborted so only the newest refresher remains active.

The returned `CloudConfigBundleLoader` wraps an async block that awaits the startup task and converts Tokio join failures into `CloudConfigBundleLoadError` with code `Internal`. The companion `cloud_config_bundle_loader_for_storage` is a convenience constructor that first obtains a shared `AuthManager` from storage-related settings, then delegates to the main loader builder.

#### Function details

##### `refresher_task_slot`  (lines 16–19)

```
fn refresher_task_slot() -> &'static Mutex<Option<JoinHandle<()>>>
```

**Purpose**: Provides access to the single global storage location for the background refresher task handle.

**Data flow**: Reads a function-local static `OnceLock<Mutex<Option<JoinHandle<()>>>>`. On first use it initializes the slot with `Mutex::new(None)` and returns a shared `'static` reference to that mutex.

**Call relations**: Used by `cloud_config_bundle_loader` when installing the newly spawned refresh loop so it can replace and abort any previously registered refresher task.

*Call graph*: called by 1 (cloud_config_bundle_loader); 1 external calls (new).


##### `cloud_config_bundle_loader`  (lines 21–53)

```
fn cloud_config_bundle_loader(
    auth_manager: Arc<AuthManager>,
    chatgpt_base_url: String,
    codex_home: PathBuf,
) -> CloudConfigBundleLoader
```

**Purpose**: Creates the cloud-config service, starts startup and refresh tasks, manages the singleton refresher handle, and returns a `CloudConfigBundleLoader` that resolves to the startup bundle result.

**Data flow**: Consumes an `Arc<AuthManager>`, backend base URL `String`, and `PathBuf` for `codex_home`. It constructs `CloudConfigBundleService::new(...)` with a new `BackendBundleClient`, clones the service for refresh use, spawns one task for `load_startup_bundle_with_timeout()` and another for `refresh_cache_in_background()`, then locks the global refresher slot and replaces any existing handle, aborting the old task if present. Finally it returns `CloudConfigBundleLoader::new(...)` wrapping an async block that awaits the startup task and maps join errors into `CloudConfigBundleLoadError` with code `Internal` and a descriptive message.

**Call relations**: This is the main factory used after authentication infrastructure is available. It delegates actual bundle retrieval and refresh behavior to `CloudConfigBundleService`, while owning task spawning and replacement of prior background refreshers.

*Call graph*: calls 4 internal fn (new, refresher_task_slot, new, new); called by 1 (cloud_config_bundle_loader_for_storage); 2 external calls (new, spawn).


##### `cloud_config_bundle_loader_for_storage`  (lines 55–71)

```
async fn cloud_config_bundle_loader_for_storage(
    codex_home: PathBuf,
    enable_codex_api_key_env: bool,
    credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyrin
```

**Purpose**: Builds an `AuthManager` from persisted credential settings and then constructs the standard cloud-config bundle loader.

**Data flow**: Consumes `codex_home`, `enable_codex_api_key_env`, `AuthCredentialsStoreMode`, `AuthKeyringBackendKind`, and backend base URL. It awaits `AuthManager::shared(...)`, passing a cloned base URL as the optional ChatGPT base URL, then forwards the resulting `Arc<AuthManager>` plus the original URL and home path into `cloud_config_bundle_loader`. It returns the resulting `CloudConfigBundleLoader`.

**Call relations**: This convenience entrypoint is used when the caller has storage configuration rather than a prebuilt auth manager. It delegates all runtime task setup to `cloud_config_bundle_loader`.

*Call graph*: calls 2 internal fn (cloud_config_bundle_loader, shared); 1 external calls (clone).


### Model catalog clients
These files cover remote and static model catalog sources plus the manager that turns them into usable model presets and metadata.

### `codex-api/src/endpoint/models.rs`

`domain_logic` · `request handling`

This file defines `ModelsClient<T>`, a thin endpoint-specific wrapper around `EndpointSession<T>` for fetching the provider’s model catalog. Construction captures a transport, `Provider`, and shared auth provider, then all request execution is delegated through the session so provider headers, auth, retries, and telemetry are applied consistently. The endpoint path is fixed to `models`.

The main behavior is `list_models`, which performs a GET request and mutates the outgoing request URL to append `client_version=...`. The helper deliberately checks whether the URL already contains a query string so it chooses `?` or `&` correctly instead of corrupting existing provider query parameters. After the request returns, the method extracts the `ETag` header if present and UTF-8-valid, then deserializes the body as `codex_protocol::openai_models::ModelsResponse`. Decode failures are surfaced as `ApiError::Stream` and include the original body rendered lossily, which is useful when the server returns malformed JSON or an unexpected schema.

The tests use a custom `CapturingTransport` to record the exact outgoing `Request`, synthesize JSON bodies from `ModelsResponse`, and optionally attach an `ETag`. They verify URL shaping, successful parsing of a realistic `ModelInfo` payload, and propagation of the response ETag.

#### Function details

##### `ModelsClient::new`  (lines 19–23)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Builds a models endpoint client by wrapping the supplied transport, provider, and auth provider in an `EndpointSession`.

**Data flow**: Consumes `transport: T`, `provider: Provider`, and `auth: SharedAuthProvider` → constructs `EndpointSession::new(...)` → returns `ModelsClient<T>` holding that session; no external state is mutated.

**Call relations**: Used by callers that need a typed client for the models endpoint, including the file’s tests. It is the setup step before `list_models` can issue requests through the shared session machinery.

*Call graph*: calls 1 internal fn (new); called by 5 (appends_client_version_query, list_models_includes_etag, parses_models_response, models_client_hits_models_endpoint, list_models).


##### `ModelsClient::with_telemetry`  (lines 25–29)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Attaches optional request telemetry to the underlying session and returns an updated client.

**Data flow**: Consumes `self` and `request: Option<Arc<dyn RequestTelemetry>>` → replaces `self.session` with `with_request_telemetry(request)` → returns a new `ModelsClient` value.

**Call relations**: This is an opt-in configuration step for callers that want telemetry emitted on subsequent requests. It delegates entirely to the session layer because telemetry is applied at request execution time there.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `ModelsClient::path`  (lines 31–33)

```
fn path() -> &'static str
```

**Purpose**: Provides the relative endpoint path segment for model listing requests.

**Data flow**: Takes no input and returns the static string `"models"`.

**Call relations**: Referenced by `ModelsClient::list_models` when building the request path passed into `EndpointSession::execute_with`.


##### `ModelsClient::append_client_version_query`  (lines 35–38)

```
fn append_client_version_query(req: &mut codex_client::Request, client_version: &str)
```

**Purpose**: Mutates an outgoing request URL to include the `client_version` query parameter without breaking existing query strings.

**Data flow**: Takes `req: &mut codex_client::Request` and `client_version: &str` → inspects `req.url` for `?` → formats and writes back a new URL with either `?client_version=...` or `&client_version=...` appended.

**Call relations**: Invoked from the request-customization closure inside `ModelsClient::list_models`. Its only job in the call flow is to shape the final URL just before the session sends the request.

*Call graph*: 1 external calls (format!).


##### `ModelsClient::list_models`  (lines 40–73)

```
async fn list_models(
        &self,
        client_version: &str,
        extra_headers: HeaderMap,
    ) -> Result<(Vec<ModelInfo>, Option<String>), ApiError>
```

**Purpose**: Fetches the provider’s model list, decodes the JSON body into `Vec<ModelInfo>`, and returns it together with any `ETag` header.

**Data flow**: Reads `&self`, `client_version: &str`, and `extra_headers: HeaderMap` → calls `session.execute_with` using `GET`, path `models`, no JSON body, and a closure that appends the client version query → reads `resp.headers[ETAG]` if present and valid → deserializes `resp.body` into `ModelsResponse` → returns `Ok((models, header_etag))` or an `ApiError` from transport/session failure or JSON decode failure.

**Call relations**: This is the file’s primary endpoint operation. It is called by higher-level API consumers and exercised by the tests; internally it delegates transport/auth/retry concerns to `EndpointSession::execute_with` and keeps only endpoint-specific URL mutation and response decoding locally.

*Call graph*: calls 1 internal fn (execute_with); 1 external calls (path).


##### `tests::CapturingTransport::default`  (lines 101–107)

```
fn default() -> Self
```

**Purpose**: Creates a test transport with no captured request, an empty `ModelsResponse`, and no ETag.

**Data flow**: Constructs fresh `Arc<Mutex<Option<Request>>>`, `Arc<ModelsResponse { models: Vec::new() }>`, and `etag: None` → returns `CapturingTransport`.

**Call relations**: Supports tests that need a simple baseline transport state before invoking `ModelsClient` methods.

*Call graph*: 3 external calls (new, new, new).


##### `tests::CapturingTransport::execute`  (lines 111–123)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Implements the test HTTP transport by recording the request and returning a synthetic successful JSON response.

**Data flow**: Takes `req: Request` → stores it in `last_request` under a mutex → serializes `self.body` to JSON bytes → builds response headers, optionally inserting `ETag` from `self.etag` → returns `Response { status: 200 OK, headers, body }`.

**Call relations**: Called by the session layer when tests invoke `list_models`. It lets the tests inspect the exact request URL and headers while controlling the response body and ETag seen by the client.

*Call graph*: 2 external calls (new, to_vec).


##### `tests::CapturingTransport::stream`  (lines 125–127)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Fails immediately if streaming is attempted in these tests.

**Data flow**: Ignores the incoming request and returns `Err(TransportError::Build("stream should not run"))`.

**Call relations**: Acts as a guardrail in the test transport implementation: the models endpoint should use ordinary request/response execution, never streaming.

*Call graph*: 1 external calls (Build).


##### `tests::DummyAuth::add_auth_headers`  (lines 134–134)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements a no-op auth provider for tests that do not care about authorization headers.

**Data flow**: Receives `&mut HeaderMap` and leaves it unchanged.

**Call relations**: Passed into `ModelsClient::new` by the tests so the session can satisfy its auth dependency without affecting request assertions.


##### `tests::provider`  (lines 137–152)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Builds a minimal `Provider` fixture suitable for deterministic endpoint tests.

**Data flow**: Takes `base_url: &str` → constructs a `Provider` with fixed name, empty headers, no query params, single-attempt retry config, and short timeouts → returns it.

**Call relations**: Used by all tests in this file to supply the base URL and retry behavior expected by `EndpointSession`.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::appends_client_version_query`  (lines 155–189)

```
async fn appends_client_version_query()
```

**Purpose**: Verifies that `list_models` appends `client_version` to the models URL and still returns the decoded empty model list.

**Data flow**: Builds a `CapturingTransport` with empty response, constructs `ModelsClient`, calls `list_models("0.99.0", HeaderMap::new())`, then reads `transport.last_request.url` and asserts the exact URL string.

**Call relations**: Exercises the main request path through `ModelsClient::new` and `ModelsClient::list_models`, specifically validating the URL mutation performed by `append_client_version_query`.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, new, new, assert_eq!, provider).


##### `tests::parses_models_response`  (lines 192–243)

```
async fn parses_models_response()
```

**Purpose**: Checks that a realistic JSON model payload is deserialized into typed `ModelInfo` values.

**Data flow**: Creates a `ModelsResponse` containing one parsed JSON model object, injects it into `CapturingTransport`, calls `list_models`, and asserts fields like `slug`, `supported_in_api`, and `priority` on the returned vector.

**Call relations**: Covers the response-decoding branch of `ModelsClient::list_models`, ensuring the endpoint-specific JSON schema is interpreted correctly.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, new, assert_eq!, provider, vec!).


##### `tests::list_models_includes_etag`  (lines 246–268)

```
async fn list_models_includes_etag()
```

**Purpose**: Confirms that `list_models` returns the response `ETag` header alongside the model list.

**Data flow**: Creates a transport with an empty models body and `etag: Some("\"abc\"")`, invokes `list_models`, and asserts both the empty model vector and the returned `Option<String>` value.

**Call relations**: Exercises the header extraction logic inside `ModelsClient::list_models`, specifically the optional `ETag` parsing path.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, new, new, assert_eq!, provider).


### `model-provider/src/models_endpoint.rs`

`io_transport` · `remote model catalog refresh`

This module wraps remote `/models` access behind `OpenAiModelsEndpoint`, which stores provider metadata and an optional auth manager. The endpoint can answer lightweight capability questions synchronously—such as whether the provider uses command-backed auth—and can asynchronously fetch the current auth snapshot from the manager. `uses_codex_backend` derives a boolean from that auth snapshot by checking `CodexAuth::uses_codex_backend`.

The main work happens in `list_models`. It starts an OTEL timer, loads current auth, derives `auth_mode`, converts `provider_info` into a `codex_api::Provider`, resolves request auth with `resolve_provider_auth`, and builds a `ReqwestTransport` using the default reqwest client. Before issuing the request, it computes auth-header telemetry and packages it together with environment telemetry from `auth_env()` into a `ModelsRequestTelemetry` object. That telemetry object is attached to a `ModelsClient`, and the actual `client.list_models(client_version, HeaderMap::new())` call is wrapped in a 5-second Tokio timeout. Timeout becomes `CodexErr::Timeout`; API-layer errors are normalized through `map_api_error`.

`ModelsRequestTelemetry::on_request` logs each attempt twice to different tracing targets, extracting transport error strings and response debug context such as request ID, Cloudflare ray, and auth error codes. It also emits feedback tags carrying endpoint, auth-header, auth-mode, and auth-environment metadata. Tests focus on the endpoint's command-auth detection behavior, especially when no cached auth is yet available.

#### Function details

##### `OpenAiModelsEndpoint::new`  (lines 42–50)

```
fn new(
        provider_info: ModelProviderInfo,
        auth_manager: Option<Arc<AuthManager>>,
    ) -> Self
```

**Purpose**: Constructs a remote models-endpoint client from provider metadata and an optional auth manager.

**Data flow**: It takes `provider_info` and `auth_manager`, stores them directly in a new `OpenAiModelsEndpoint`, and returns the struct.

**Call relations**: This constructor is used by the generic provider's `models_manager` path and by tests that inspect endpoint behavior in isolation.

*Call graph*: called by 3 (command_auth_provider_reports_command_auth_without_cached_auth, provider_without_command_auth_reports_no_command_auth, models_manager).


##### `OpenAiModelsEndpoint::auth`  (lines 52–57)

```
async fn auth(&self) -> Option<CodexAuth>
```

**Purpose**: Fetches the current auth snapshot from the endpoint's auth manager, if one exists.

**Data flow**: It reads `self.auth_manager`; when present it awaits `auth_manager.auth()` and returns the resulting `Option<CodexAuth>`, otherwise it returns `None` immediately.

**Call relations**: This helper is used by both `uses_codex_backend` and `list_models` so those methods operate on the latest auth state.

*Call graph*: called by 2 (list_models, uses_codex_backend).


##### `OpenAiModelsEndpoint::auth_env`  (lines 96–102)

```
fn auth_env(&self) -> AuthEnvTelemetry
```

**Purpose**: Collects auth-environment telemetry describing which auth-related environment variables and provider settings are active.

**Data flow**: It checks whether `self.auth_manager` exists and has `codex_api_key_env_enabled()`, then passes `&self.provider_info` and that boolean to `collect_auth_env_telemetry`, returning the resulting `AuthEnvTelemetry`.

**Call relations**: This helper is called during `list_models` to enrich request telemetry and feedback emission with auth-environment context.

*Call graph*: called by 1 (list_models); 1 external calls (collect_auth_env_telemetry).


##### `OpenAiModelsEndpoint::has_command_auth`  (lines 106–108)

```
fn has_command_auth(&self) -> bool
```

**Purpose**: Reports whether the provider configuration includes command-backed auth.

**Data flow**: It reads `self.provider_info` and returns the result of `self.provider_info.has_command_auth()`.

**Call relations**: This synchronous trait method is used by models-manager logic and tests to know whether auth may be supplied by an external command even before any token is cached.

*Call graph*: calls 1 internal fn (has_command_auth).


##### `OpenAiModelsEndpoint::uses_codex_backend`  (lines 110–112)

```
fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool>
```

**Purpose**: Determines whether the current auth implies requests are going through the Codex backend.

**Data flow**: It awaits `self.auth()`, inspects the optional `CodexAuth`, and returns `true` only when an auth value exists and `CodexAuth::uses_codex_backend` is true.

**Call relations**: This trait method is called by higher-level models-manager logic that may vary behavior based on backend type. It delegates only to `auth`.

*Call graph*: calls 1 internal fn (auth); 1 external calls (pin).


##### `OpenAiModelsEndpoint::list_models`  (lines 114–119)

```
fn list_models(
        &'a self,
        client_version: &'a str,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>>
```

**Purpose**: Fetches the provider's `/models` response over HTTP with auth resolution, timeout handling, and per-request telemetry attached.

**Data flow**: It takes `client_version`, starts a global timer, awaits `auth()`, derives `auth_mode`, converts `provider_info` to an API `Provider`, resolves `api_auth` with `resolve_provider_auth`, builds a `ReqwestTransport` from `build_reqwest_client()`, computes auth-header telemetry, constructs `ModelsRequestTelemetry` with auth mode/header/env data, creates a `ModelsClient` with telemetry attached, and awaits `client.list_models(client_version, HeaderMap::new())` under a 5-second `timeout`. It returns either `(Vec<ModelInfo>, Option<String>)` on success or mapped timeout/API errors.

**Call relations**: This is the endpoint's main operation, invoked through the `ModelsEndpointClient` trait by the remote models manager. It orchestrates provider conversion, auth resolution, transport setup, telemetry attachment, and the actual HTTP call.

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

**Purpose**: Records telemetry and feedback metadata for each `/models` request attempt, including auth attachment details and response debug context.

**Data flow**: It receives attempt count, optional HTTP status, optional `TransportError`, and request duration. It derives `success`, converts transport errors into telemetry-safe messages, extracts response debug context when available, logs two tracing events with endpoint/auth/env/debug fields, and emits `FeedbackRequestTags` plus `auth_env` through `emit_feedback_request_tags_with_auth_env`.

**Call relations**: This callback is invoked by `ModelsClient` during request execution because `list_models` attaches it as the request telemetry implementation.

*Call graph*: 2 external calls (emit_feedback_request_tags_with_auth_env, event!).


##### `tests::provider_info_with_command_auth`  (lines 221–236)

```
fn provider_info_with_command_auth() -> ModelProviderInfo
```

**Purpose**: Builds a `ModelProviderInfo` fixture representing a provider that uses command-backed auth.

**Data flow**: It constructs `ModelProviderAuthInfo` with command name, empty args, nonzero timeout, refresh interval, and current working directory, then embeds it into a mostly default OpenAI provider config with `requires_openai_auth: false`.

**Call relations**: This helper is used by the command-auth detection test to supply a provider configuration that should report command auth even without cached credentials.

*Call graph*: calls 1 internal fn (create_openai_provider); 3 external calls (new, new, current_dir).


##### `tests::command_auth_provider_reports_command_auth_without_cached_auth`  (lines 239–246)

```
fn command_auth_provider_reports_command_auth_without_cached_auth()
```

**Purpose**: Verifies that command-auth providers report command auth based on configuration alone.

**Data flow**: It creates an `OpenAiModelsEndpoint` from `provider_info_with_command_auth()` and no auth manager, then asserts `has_command_auth()` is true.

**Call relations**: This test covers the synchronous `has_command_auth` path and confirms it does not depend on `auth()` or cached tokens.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, provider_info_with_command_auth).


##### `tests::provider_without_command_auth_reports_no_command_auth`  (lines 249–256)

```
fn provider_without_command_auth_reports_no_command_auth()
```

**Purpose**: Checks that a normal provider without command auth reports false for command-auth capability.

**Data flow**: It constructs an endpoint from a standard OpenAI provider and no auth manager, then asserts `has_command_auth()` is false.

**Call relations**: This test validates the negative branch of `has_command_auth`.

*Call graph*: calls 2 internal fn (create_openai_provider, new); 1 external calls (assert!).


### `model-provider/src/amazon_bedrock/catalog.rs`

`domain_logic` · `provider setup and model catalog construction`

This file builds a fixed `ModelsResponse` for the Amazon Bedrock provider rather than querying a remote `/models` endpoint. It starts from bundled OpenAI model definitions loaded through `bundled_models_response()`, then clones the entries for the OpenAI slugs `gpt-5.5` and `gpt-5.4` and rewrites them into Bedrock-facing `ModelInfo` records. The rewrite is concrete: `slug` becomes the Bedrock model ID constants from `codex_model_provider_info`, `priority` is assigned so GPT-5.5 sorts ahead of GPT-5.4, and both `context_window` and `max_context_window` are forced to the Bedrock-specific value `272_000`.

A second normalization pass removes service-tier configuration from every model. The code explicitly clears `additional_speed_tiers` and `service_tiers` and sets `default_service_tier` to `None`, reflecting the invariant that Bedrock currently only supports the implicit default tier and should not advertise OpenAI-style priority/default tier choices. The helper that reads bundled metadata is intentionally strict: parse failure or missing expected slugs causes a panic, treating the bundled models JSON as a build/runtime invariant rather than recoverable input. Tests verify the rewritten slugs, the overridden context window, and the absence of service-tier behavior even when callers ask for a tier.

#### Function details

##### `static_model_catalog`  (lines 11–26)

```
fn static_model_catalog() -> ModelsResponse
```

**Purpose**: Constructs the complete static `ModelsResponse` for Amazon Bedrock with exactly the supported GPT-5.5 and GPT-5.4 entries. It applies the Bedrock-only service-tier normalization before returning the catalog.

**Data flow**: It creates a `ModelsResponse` containing two `ModelInfo` values produced from the OpenAI bundled catalog, one for `gpt-5.5` and one for `gpt-5.4`, with Bedrock slugs and explicit priorities. That response is then passed through `with_default_only_service_tier`, which mutates tier-related fields in-place and returns the final catalog.

**Call relations**: This is the top-level catalog builder used by Bedrock catalog tests and by the Bedrock provider when no configured catalog is supplied. Its main delegation is to the tier-normalization helper after assembling the vector of Bedrock model entries.

*Call graph*: calls 1 internal fn (with_default_only_service_tier); called by 3 (catalog_uses_mantle_model_ids_as_slugs, gpt_5_bedrock_models_only_allow_default_service_tier, gpt_5_bedrock_models_use_bedrock_context_window); 1 external calls (vec!).


##### `with_default_only_service_tier`  (lines 28–36)

```
fn with_default_only_service_tier(mut catalog: ModelsResponse) -> ModelsResponse
```

**Purpose**: Rewrites every model in a catalog so it advertises no selectable service tiers. This enforces Bedrock's current limitation to an implicit default tier.

**Data flow**: It takes ownership of a mutable `ModelsResponse`, iterates over `catalog.models`, clears each model's `additional_speed_tiers` and `service_tiers`, and sets `default_service_tier` to `None`. It returns the same catalog value after mutation.

**Call relations**: It is invoked by `static_model_catalog` and also reused elsewhere when a caller provides a custom catalog for Bedrock. It does not delegate further; its role is the final normalization pass before the catalog is exposed.

*Call graph*: called by 1 (static_model_catalog).


##### `gpt_5_bedrock_model`  (lines 38–45)

```
fn gpt_5_bedrock_model(openai_slug: &str, bedrock_slug: &str, priority: i32) -> ModelInfo
```

**Purpose**: Builds one Bedrock `ModelInfo` by copying the bundled OpenAI definition for a GPT model and patching the fields that differ on Bedrock. The result preserves most bundled metadata while swapping in Bedrock-specific identity and limits.

**Data flow**: It accepts an OpenAI slug, a Bedrock slug, and a numeric priority. It loads the source `ModelInfo` via `bundled_openai_model`, then mutates `slug`, `priority`, `context_window`, and `max_context_window`, and returns the modified model.

**Call relations**: This helper is used during `static_model_catalog` assembly for each supported Bedrock GPT variant. Its only delegation is to `bundled_openai_model`, which supplies the baseline metadata to patch.

*Call graph*: calls 1 internal fn (bundled_openai_model).


##### `bundled_openai_model`  (lines 47–54)

```
fn bundled_openai_model(slug: &str) -> ModelInfo
```

**Purpose**: Fetches a single bundled OpenAI model definition by slug from the packaged models JSON. It treats both parse failure and missing expected models as fatal invariants.

**Data flow**: It takes a slug string, calls `bundled_models_response()` to parse the bundled catalog, consumes the returned `models` vector, searches for a `ModelInfo` whose `slug` matches, and returns that model. If parsing fails or no matching slug exists, it panics with a descriptive message.

**Call relations**: It is only called by `gpt_5_bedrock_model` as the source of canonical OpenAI metadata. The strict panic behavior ensures Bedrock catalog generation fails loudly if the bundled catalog drifts.

*Call graph*: called by 1 (gpt_5_bedrock_model); 1 external calls (bundled_models_response).


##### `tests::catalog_uses_mantle_model_ids_as_slugs`  (lines 64–70)

```
fn catalog_uses_mantle_model_ids_as_slugs()
```

**Purpose**: Verifies that the static Bedrock catalog rewrites model slugs to the Bedrock/Mantle IDs rather than leaving the OpenAI slugs intact.

**Data flow**: It calls `static_model_catalog()`, inspects the returned `models` vector length and the `slug` fields of the first two entries, and asserts they match the Bedrock model ID constants.

**Call relations**: This test exercises the top-level catalog builder under the normal path and validates the slug-rewrite behavior performed by `gpt_5_bedrock_model` inside that flow.

*Call graph*: calls 1 internal fn (static_model_catalog); 1 external calls (assert_eq!).


##### `tests::gpt_5_bedrock_models_use_bedrock_context_window`  (lines 73–100)

```
fn gpt_5_bedrock_models_use_bedrock_context_window()
```

**Purpose**: Checks that both Bedrock GPT entries advertise the Bedrock-specific context window in both current and maximum fields.

**Data flow**: It builds the catalog with `static_model_catalog()`, searches the returned models by Bedrock slug, extracts each matching `ModelInfo`, and asserts that `context_window` and `max_context_window` are both `Some(272_000)`.

**Call relations**: This test covers the field overrides applied by `gpt_5_bedrock_model` during catalog construction, specifically the context-window patching.

*Call graph*: calls 1 internal fn (static_model_catalog); 1 external calls (assert_eq!).


##### `tests::gpt_5_bedrock_models_only_allow_default_service_tier`  (lines 103–120)

```
fn gpt_5_bedrock_models_only_allow_default_service_tier()
```

**Purpose**: Confirms that Bedrock models expose no explicit service-tier options and reject tier-specific request mapping.

**Data flow**: It obtains the catalog from `static_model_catalog()`, iterates through each `ModelInfo`, and asserts that `additional_speed_tiers` and `service_tiers` are empty, `default_service_tier` is `None`, and `service_tier_for_request(...)` returns `None` for both `priority` and the default-tier request token.

**Call relations**: This test validates the normalization performed by `with_default_only_service_tier`, ensuring the final catalog behavior matches Bedrock's tier constraints.

*Call graph*: calls 1 internal fn (static_model_catalog); 1 external calls (assert_eq!).


### `models-manager/src/manager.rs`

`orchestration` · `startup and request handling`

This file defines the subsystem's main traits, stateful managers, refresh policy, and model-selection helpers. `ModelsEndpointClient` abstracts provider-specific transport and auth capability checks, while `ModelsManager` defines the higher-level operations the rest of the system consumes: listing models, exposing collaboration modes, selecting a default model, and resolving `ModelInfo` for a slug. The trait supplies default implementations for common logic such as sorting remote models by `priority`, converting them into `ModelPreset`, filtering by auth via `ModelPreset::filter_by_auth`, and marking picker defaults.

`OpenAiModelsManager` owns mutable runtime state: `remote_models` and `etag` behind `tokio::sync::RwLock`, a `ModelsCacheManager`, an endpoint client, and optional `AuthManager`. Its constructor seeds `remote_models` from bundled `models.json`. Refresh flow is policy-driven through `RefreshStrategy`: `Offline` only tries cache, `OnlineIfUncached` prefers fresh cache then fetches, and `Online` always fetches. Before any fetch, `should_refresh_models` checks whether the current auth context can legitimately refresh models. Successful fetches update in-memory models, store the ETag, and persist cache with the normalized client version.

A subtle but important branch lives in `apply_remote_models`: for ChatGPT-account auth, a non-empty remote catalog containing at least one `ModelVisibility::List` model becomes authoritative and replaces bundled models entirely; otherwise remote models are merged into the bundled catalog by `slug`, preserving bundled entries and updating or appending remote ones. Cache loads reuse the same application logic and also restore the cached ETag.

The file also contains slug-resolution helpers. `construct_model_info_from_candidates` first tries longest-prefix matching against remote candidates, then a narrowly scoped single-segment namespace fallback like `provider/model-name`; if neither matches, it synthesizes fallback metadata via `model_info::model_info_from_slug` and finally applies config overrides. This keeps unknown or namespaced models usable even when not explicitly present in the active catalog.

#### Function details

##### `RefreshStrategy::as_str`  (lines 61–67)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps each `RefreshStrategy` enum variant to its stable lowercase string form. The strings are used for display and tracing metadata.

**Data flow**: It takes `self` by value, matches `Online`, `Offline`, and `OnlineIfUncached`, and returns the corresponding `&'static str`. It reads no external state and performs no writes.

**Call relations**: This is an internal helper for `RefreshStrategy` formatting. It is invoked by the `fmt::Display` implementation so logs and spans show a readable strategy name.

*Call graph*: called by 1 (fmt).


##### `RefreshStrategy::fmt`  (lines 71–73)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements `Display` for `RefreshStrategy` by writing the string returned from `as_str`. This gives the enum a consistent textual representation in logs and spans.

**Data flow**: It receives `&self` and a mutable formatter, calls `self.as_str()`, and writes that string into the formatter with `write_str`. It returns the standard `fmt::Result`.

**Call relations**: This method is used implicitly anywhere a `RefreshStrategy` is formatted, including tracing instrumentation in trait default methods. It delegates the actual variant-to-string mapping to `RefreshStrategy::as_str`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `ModelsManager::list_models`  (lines 83–97)

```
fn list_models(
        &self,
        refresh_strategy: RefreshStrategy,
    ) -> ModelsManagerFuture<'_, Vec<ModelPreset>>
```

**Purpose**: Produces the picker-visible model preset list for the current catalog snapshot, refreshing first according to the requested strategy. It is the main high-level listing API on the trait.

**Data flow**: It takes `&self` and a `RefreshStrategy`, asynchronously obtains a `ModelsResponse` from `raw_model_catalog`, extracts its `models` vector, passes that vector into `build_available_models`, and returns the resulting `Vec<ModelPreset>`. It also wraps the future in a tracing span carrying the refresh strategy.

**Call relations**: This default trait method is called by `get_default_model` and by external consumers of the manager trait. It delegates refresh behavior to the concrete implementation's `raw_model_catalog` and delegates preset shaping to `build_available_models`.

*Call graph*: calls 1 internal fn (build_available_models); called by 1 (get_default_model); 2 external calls (pin, info_span!).


##### `ModelsManager::build_available_models`  (lines 117–129)

```
fn build_available_models(&self, mut remote_models: Vec<ModelInfo>) -> Vec<ModelPreset>
```

**Purpose**: Transforms raw `ModelInfo` entries into sorted, auth-filtered, picker-ready `ModelPreset` values. It centralizes the common post-refresh shaping logic shared by both manager implementations.

**Data flow**: It accepts `mut remote_models: Vec<ModelInfo>`, sorts the vector by `priority`, converts each model into a `ModelPreset`, determines whether the current auth uses the Codex backend via `auth_manager`, filters presets with `ModelPreset::filter_by_auth`, marks defaults with `ModelPreset::mark_default_by_picker_visibility`, and returns the final `Vec<ModelPreset>`.

**Call relations**: This helper is used by both `list_models` and `try_list_models`. It depends on the trait's `auth_manager` hook to make auth-sensitive filtering decisions but otherwise contains all shared preset-building logic locally.

*Call graph*: calls 2 internal fn (filter_by_auth, mark_default_by_picker_visibility); called by 2 (list_models, try_list_models).


##### `ModelsManager::try_list_models`  (lines 139–142)

```
fn try_list_models(&self) -> Result<Vec<ModelPreset>, TryLockError>
```

**Purpose**: Builds the current model preset list without awaiting locks or triggering refresh. It is the non-blocking counterpart to `list_models`.

**Data flow**: It takes `&self`, calls `try_get_remote_models()` to obtain a cloned `Vec<ModelInfo>` or a `TryLockError`, feeds the models into `build_available_models`, and returns either the built `Vec<ModelPreset>` or the lock error.

**Call relations**: This default method is used when callers want a best-effort snapshot from current in-memory state. It delegates lock acquisition to the concrete manager's `try_get_remote_models` and reuses `build_available_models` for shaping.

*Call graph*: calls 1 internal fn (build_available_models).


##### `ModelsManager::get_default_model`  (lines 149–167)

```
fn get_default_model(
        &'a self,
        model: &'a Option<String>,
        refresh_strategy: RefreshStrategy,
    ) -> ModelsManagerFuture<'a, String>
```

**Purpose**: Chooses the model identifier to use for a request, honoring an explicit caller-provided model when present and otherwise selecting the current default from available presets. It encapsulates the fallback policy for model selection.

**Data flow**: It takes `model: &Option<String>` and a `RefreshStrategy`. If `model` is `Some`, it clones and returns that string immediately; otherwise it awaits `list_models(refresh_strategy)`, passes the resulting presets to `default_model_from_available`, and returns the chosen model slug. The future is instrumented with tracing fields indicating whether a model was provided and which refresh strategy was used.

**Call relations**: This default trait method is invoked by higher-level request setup code that needs a concrete model slug. It delegates dynamic listing to `list_models` and final selection policy to `default_model_from_available`.

*Call graph*: calls 2 internal fn (list_models, default_model_from_available); 2 external calls (pin, info_span!).


##### `ModelsManager::get_model_info`  (lines 171–183)

```
fn get_model_info(
        &'a self,
        model: &'a str,
        config: &'a ModelsManagerConfig,
    ) -> ModelsManagerFuture<'a, ModelInfo>
```

**Purpose**: Resolves full `ModelInfo` metadata for a requested model slug using the current remote catalog plus configuration overrides. It supports exact, prefix, and fallback metadata resolution through a shared helper.

**Data flow**: It takes `model: &str` and `config: &ModelsManagerConfig`, awaits `get_remote_models()` to clone the current candidate list, passes the slug, candidates, and config into `construct_model_info_from_candidates`, and returns the resulting `ModelInfo`. It wraps the future in a tracing span tagged with the model slug.

**Call relations**: This default method is called by consumers that need metadata rather than picker presets. It delegates candidate retrieval to the concrete manager and all matching/fallback logic to `construct_model_info_from_candidates`.

*Call graph*: calls 1 internal fn (construct_model_info_from_candidates); 2 external calls (pin, info_span!).


##### `OpenAiModelsManager::new`  (lines 215–230)

```
fn new(
        codex_home: PathBuf,
        endpoint_client: Arc<dyn ModelsEndpointClient>,
        auth_manager: Option<Arc<AuthManager>>,
    ) -> Self
```

**Purpose**: Constructs the refreshable manager with bundled models preloaded, cache storage configured, and optional auth attached. It establishes the initial in-memory state before any remote refresh occurs.

**Data flow**: It takes a `codex_home` path, an `Arc<dyn ModelsEndpointClient>`, and an optional `Arc<AuthManager>`. It joins `codex_home` with `MODEL_CACHE_FILE`, creates a `ModelsCacheManager` using the default TTL, loads bundled models via `load_remote_models_from_file().unwrap_or_default()`, wraps the models in an `RwLock`, initializes `etag` to `None`, and returns the populated `OpenAiModelsManager`.

**Call relations**: This constructor is used by production wiring and test helpers to create the remote-capable manager. It delegates bundled catalog loading to `load_remote_models_from_file` and cache setup to `ModelsCacheManager::new`.

*Call graph*: calls 2 internal fn (new, load_remote_models_from_file); called by 2 (models_manager, openai_manager_for_tests_with_auth); 2 external calls (join, new).


##### `StaticModelsManager::new`  (lines 235–240)

```
fn new(auth_manager: Option<Arc<AuthManager>>, model_catalog: ModelsResponse) -> Self
```

**Purpose**: Constructs a manager backed by a fixed in-process `ModelsResponse` catalog. It is intended for tests or contexts where no refresh or cache behavior is needed.

**Data flow**: It takes an optional `Arc<AuthManager>` and a `ModelsResponse`, extracts `model_catalog.models` into the struct's `remote_models` field, stores the auth manager, and returns the new `StaticModelsManager`.

**Call relations**: This constructor is used by tests and any code that wants an authoritative static catalog. It does not delegate further because it simply stores the provided data.

*Call graph*: called by 5 (guardian_request_model_for_auto_review, models_manager, models_manager, static_manager_for_tests, static_manager_reads_latest_auth_mode).


##### `OpenAiModelsManager::get_remote_models`  (lines 254–256)

```
fn get_remote_models(&self) -> ModelsManagerFuture<'_, Vec<ModelInfo>>
```

**Purpose**: Returns a cloned snapshot of the current in-memory remote model list from the async lock. It is the concrete implementation of the trait hook for the refreshable manager.

**Data flow**: It takes `&self`, acquires a read lock on `self.remote_models`, clones the inner `Vec<ModelInfo>`, and returns it inside a boxed future. It does not mutate state.

**Call relations**: This method is called by `OpenAiModelsManager::raw_model_catalog` and by the trait default methods that need current candidates. It is the async, blocking-safe path corresponding to `try_get_remote_models`.

*Call graph*: called by 1 (raw_model_catalog); 1 external calls (pin).


##### `OpenAiModelsManager::try_get_remote_models`  (lines 258–260)

```
fn try_get_remote_models(&self) -> Result<Vec<ModelInfo>, TryLockError>
```

**Purpose**: Attempts to read the current in-memory remote model list without waiting for the lock. It supports non-blocking snapshot access.

**Data flow**: It takes `&self`, calls `self.remote_models.try_read()?`, clones the contained `Vec<ModelInfo>`, and returns either that clone or a `TryLockError`.

**Call relations**: This is the concrete non-blocking hook used by the trait's `try_list_models`. It does not delegate to other crate helpers.


##### `OpenAiModelsManager::auth_manager`  (lines 262–264)

```
fn auth_manager(&self) -> Option<&AuthManager>
```

**Purpose**: Exposes the optional auth manager associated with the refreshable manager. This lets shared trait logic inspect current auth state.

**Data flow**: It takes `&self`, converts `Option<Arc<AuthManager>>` to `Option<&AuthManager>` with `as_deref`, and returns that borrowed option. It reads but does not modify manager state.

**Call relations**: This method is consumed indirectly by trait default methods such as `build_available_models`. It serves as the concrete implementation of the trait's auth hook.


##### `OpenAiModelsManager::list_collaboration_modes`  (lines 266–268)

```
fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

**Purpose**: Returns the built-in collaboration mode presets for the refreshable manager. It does not derive modes from remote state.

**Data flow**: It takes `&self`, calls `builtin_collaboration_mode_presets()`, and returns the resulting `Vec<CollaborationModeMask>`. No state is read beyond the method receiver.

**Call relations**: This is the concrete implementation of the trait's collaboration-mode listing hook. It delegates entirely to the preset module's static constructor.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets).


##### `OpenAiModelsManager::raw_model_catalog`  (lines 276–283)

```
async fn raw_model_catalog(&self, refresh_strategy: RefreshStrategy) -> ModelsResponse
```

**Purpose**: Refreshes the remote-capable manager according to policy and returns the active catalog snapshot as a `ModelsResponse`. Refresh failures are logged but do not prevent returning current in-memory models.

**Data flow**: It takes `&self` and a `RefreshStrategy`, awaits `refresh_available_models(refresh_strategy)`, logs any error, then awaits `get_remote_models()` and wraps the resulting vector in `ModelsResponse { models }`. It returns that response.

**Call relations**: This method backs the trait's `raw_model_catalog` implementation for the OpenAI manager and is reached through `ModelsManager::list_models`. It delegates refresh policy to `refresh_available_models` and snapshot retrieval to `get_remote_models`.

*Call graph*: calls 2 internal fn (get_remote_models, refresh_available_models); 2 external calls (pin, error!).


##### `OpenAiModelsManager::refresh_if_new_etag`  (lines 285–296)

```
async fn refresh_if_new_etag(&self, etag: String)
```

**Purpose**: Conditionally refreshes models based on whether an incoming ETag differs from the manager's current ETag. Matching ETags only renew cache freshness; differing or absent ETags trigger a full online refresh.

**Data flow**: It takes an `etag: String`, awaits `get_etag()`, compares the current value to the provided string, and if they match and a current ETag exists, calls `cache_manager.renew_cache_ttl()` and returns. Otherwise it awaits `refresh_available_models(RefreshStrategy::Online)`. Errors from TTL renewal or refresh are logged.

**Call relations**: This method is exposed through the trait for event-driven refreshes keyed by ETag changes. It delegates state lookup to `get_etag`, cache extension to `renew_cache_ttl`, and actual fetching logic to `refresh_available_models`.

*Call graph*: calls 3 internal fn (renew_cache_ttl, get_etag, refresh_available_models); 2 external calls (pin, error!).


##### `OpenAiModelsManager::refresh_available_models`  (lines 299–330)

```
async fn refresh_available_models(&self, refresh_strategy: RefreshStrategy) -> CoreResult<()>
```

**Purpose**: Implements the manager's refresh policy, deciding whether to skip refresh entirely, load from cache, or fetch from the endpoint. It is the central control-flow function for catalog freshness.

**Data flow**: It takes a `RefreshStrategy`, first awaits `should_refresh_models()`. If refresh is not allowed, it optionally calls `try_load_cache()` for `Offline` and `OnlineIfUncached` and returns `Ok(())`. If refresh is allowed, it matches the strategy: `Offline` only tries cache; `OnlineIfUncached` tries cache and returns early on hit, otherwise logs and fetches; `Online` always calls `fetch_and_update_models()`. It returns `CoreResult<()>`.

**Call relations**: This method is called by `raw_model_catalog` and `refresh_if_new_etag`. It delegates auth capability gating to `should_refresh_models`, cache reads to `try_load_cache`, and network refresh plus persistence to `fetch_and_update_models`.

*Call graph*: calls 3 internal fn (fetch_and_update_models, should_refresh_models, try_load_cache); called by 2 (raw_model_catalog, refresh_if_new_etag); 2 external calls (info!, matches!).


##### `OpenAiModelsManager::fetch_and_update_models`  (lines 332–341)

```
async fn fetch_and_update_models(&self) -> CoreResult<()>
```

**Purpose**: Fetches the latest remote model catalog from the endpoint, applies it to in-memory state, stores the returned ETag, and persists the cache entry. It is the concrete network-refresh step.

**Data flow**: It takes `&self`, computes `client_version` via `crate::client_version_to_whole()`, awaits `endpoint_client.list_models(&client_version)` to get `(models, etag)`, applies the fetched models with `apply_remote_models(models.clone())`, writes `etag.clone()` into the `etag` lock, calls `cache_manager.persist_cache(&models, etag, client_version).await`, and returns `Ok(())` or the endpoint error.

**Call relations**: This method is reached from `refresh_available_models` when a network fetch is required. It delegates provider transport to the endpoint client, merge/replacement semantics to `apply_remote_models`, and disk persistence to the cache manager.

*Call graph*: calls 2 internal fn (persist_cache, apply_remote_models); called by 1 (refresh_available_models); 2 external calls (list_models, client_version_to_whole).


##### `OpenAiModelsManager::should_refresh_models`  (lines 343–345)

```
async fn should_refresh_models(&self) -> bool
```

**Purpose**: Determines whether the current auth/provider context permits a remote model refresh. It prevents unnecessary or invalid network fetches when no suitable auth is active.

**Data flow**: It takes `&self`, awaits `endpoint_client.uses_codex_backend()` and reads `endpoint_client.has_command_auth()`, combines them with logical OR, and returns the resulting `bool`.

**Call relations**: This gating helper is called at the start of `refresh_available_models`. It delegates the actual auth/provider knowledge to the `ModelsEndpointClient` implementation.

*Call graph*: called by 1 (refresh_available_models); 2 external calls (has_command_auth, uses_codex_backend).


##### `OpenAiModelsManager::get_etag`  (lines 347–349)

```
async fn get_etag(&self) -> Option<String>
```

**Purpose**: Returns the manager's current cached ETag value from memory. It is a small async accessor around the `etag` lock.

**Data flow**: It takes `&self`, acquires a read lock on `self.etag`, clones the `Option<String>`, and returns it. No state is modified.

**Call relations**: This helper is used by `refresh_if_new_etag` before deciding whether to renew cache TTL or force an online refresh.

*Call graph*: called by 1 (refresh_if_new_etag).


##### `OpenAiModelsManager::apply_remote_models`  (lines 352–381)

```
async fn apply_remote_models(&self, models: Vec<ModelInfo>)
```

**Purpose**: Applies a fetched or cached remote model list to the manager's in-memory catalog, either replacing bundled models entirely or merging by slug depending on auth and visibility. It encodes the authoritative-catalog policy.

**Data flow**: It takes `models: Vec<ModelInfo>`, computes `should_use_remote_models_only` by checking that the list is non-empty, contains at least one `ModelVisibility::List` entry, and the current auth mode has a ChatGPT account. If true, it writes `models` directly into `self.remote_models` and returns. Otherwise it loads bundled models via `load_remote_models_from_file().unwrap_or_default()`, replaces existing entries with matching `slug`s or appends new ones, then writes the merged vector into `self.remote_models`.

**Call relations**: This method is called after both network fetches and cache loads. It delegates bundled baseline loading to `load_remote_models_from_file` and is the key branch that distinguishes ChatGPT-authoritative catalogs from merge-based catalogs.

*Call graph*: calls 1 internal fn (load_remote_models_from_file); called by 2 (fetch_and_update_models, try_load_cache).


##### `OpenAiModelsManager::try_load_cache`  (lines 384–407)

```
async fn try_load_cache(&self) -> bool
```

**Purpose**: Attempts to populate the manager from a fresh on-disk cache entry that matches the current client version. It returns whether a usable cache entry was applied.

**Data flow**: It takes `&self`, starts an OpenTelemetry timer, computes the normalized client version, logs cache evaluation, and awaits `cache_manager.load_fresh(&client_version)`. On `None`, it logs a cache miss and returns `false`. On `Some(cache)`, it clones `cache.models`, writes `cache.etag.clone()` into the `etag` lock, applies the models through `apply_remote_models(models.clone())`, logs the applied count and ETag, and returns `true`.

**Call relations**: This helper is used by `refresh_available_models` in offline and cache-first flows. It delegates freshness/version checks to the cache manager and reuses `apply_remote_models` so cached catalogs follow the same replacement-versus-merge rules as live fetches.

*Call graph*: calls 2 internal fn (load_fresh, apply_remote_models); called by 1 (refresh_available_models); 3 external calls (start_global_timer, client_version_to_whole, info!).


##### `StaticModelsManager::raw_model_catalog`  (lines 411–420)

```
fn raw_model_catalog(
        &self,
        _refresh_strategy: RefreshStrategy,
    ) -> ModelsManagerFuture<'_, ModelsResponse>
```

**Purpose**: Returns the static manager's fixed catalog without performing any refresh. The refresh strategy argument is intentionally ignored.

**Data flow**: It takes `&self` and `_refresh_strategy`, awaits `get_remote_models()` to clone the stored vector, wraps it in `ModelsResponse { models }`, and returns that response in a boxed future.

**Call relations**: This is the static implementation of the trait's raw-catalog hook and is reached through `ModelsManager::list_models`. It delegates only to `get_remote_models` because no cache or network logic exists.

*Call graph*: calls 1 internal fn (get_remote_models); 1 external calls (pin).


##### `StaticModelsManager::get_remote_models`  (lines 422–424)

```
fn get_remote_models(&self) -> ModelsManagerFuture<'_, Vec<ModelInfo>>
```

**Purpose**: Returns a clone of the static manager's stored model list. It is the async snapshot accessor for the static backend.

**Data flow**: It takes `&self`, clones `self.remote_models`, and returns the clone in a boxed future. No locks or mutations are involved.

**Call relations**: This method is used by `StaticModelsManager::raw_model_catalog` and by trait default methods that need current candidates. It is the static counterpart to the OpenAI manager's lock-based accessor.

*Call graph*: called by 1 (raw_model_catalog); 1 external calls (pin).


##### `StaticModelsManager::try_get_remote_models`  (lines 426–428)

```
fn try_get_remote_models(&self) -> Result<Vec<ModelInfo>, TryLockError>
```

**Purpose**: Returns the static manager's model list immediately without any possibility of lock contention. It satisfies the trait's non-blocking snapshot API.

**Data flow**: It takes `&self`, clones `self.remote_models`, and returns `Ok(clone)`. It never produces a `TryLockError` because no lock is used.

**Call relations**: This method backs the trait's `try_list_models` for the static backend. It does not delegate further.


##### `StaticModelsManager::auth_manager`  (lines 430–432)

```
fn auth_manager(&self) -> Option<&AuthManager>
```

**Purpose**: Exposes the optional auth manager attached to the static backend. Shared trait logic uses this to filter presets by auth mode.

**Data flow**: It takes `&self`, converts the stored `Option<Arc<AuthManager>>` to `Option<&AuthManager>` with `as_deref`, and returns it.

**Call relations**: This is the static implementation of the trait auth hook and is consumed indirectly by default trait methods such as `build_available_models`.


##### `StaticModelsManager::list_collaboration_modes`  (lines 434–436)

```
fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

**Purpose**: Returns the built-in collaboration mode presets for the static backend. Like the OpenAI backend, it does not derive modes from catalog contents.

**Data flow**: It takes `&self`, calls `builtin_collaboration_mode_presets()`, and returns the resulting vector.

**Call relations**: This is the static implementation of the trait's collaboration-mode listing hook. It delegates entirely to the preset module.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets).


##### `StaticModelsManager::refresh_if_new_etag`  (lines 438–440)

```
fn refresh_if_new_etag(&self, _etag: String) -> ModelsManagerFuture<'_, ()>
```

**Purpose**: Implements the trait's ETag refresh hook as a no-op for static catalogs. Static managers never fetch or cache remote data.

**Data flow**: It takes `_etag: String` and returns an immediately ready boxed future that does nothing. No state is read or written.

**Call relations**: This method exists only to satisfy the `ModelsManager` trait for the static backend. It intentionally delegates nowhere because ETags are irrelevant for static catalogs.

*Call graph*: 1 external calls (pin).


##### `load_remote_models_from_file`  (lines 443–445)

```
fn load_remote_models_from_file() -> Result<Vec<ModelInfo>, std::io::Error>
```

**Purpose**: Loads the bundled model catalog from the crate's embedded JSON and extracts its `models` vector. It is the shared source for initial and merge baseline data.

**Data flow**: It takes no arguments, calls `crate::bundled_models_response()?`, extracts `.models`, and returns `Result<Vec<ModelInfo>, std::io::Error>` via `Ok(...)` around the successful path. Parsing errors are converted through `?` into the function's result type.

**Call relations**: This helper is used by `OpenAiModelsManager::new` to seed initial state and by `apply_remote_models` when merge mode needs the bundled baseline. It delegates actual JSON loading to `bundled_models_response`.

*Call graph*: called by 2 (apply_remote_models, new); 1 external calls (bundled_models_response).


##### `default_model_from_available`  (lines 447–454)

```
fn default_model_from_available(available: Vec<ModelPreset>) -> String
```

**Purpose**: Chooses the default model slug from an already built preset list. It prefers an explicitly marked default and otherwise falls back to the first entry or an empty string.

**Data flow**: It takes `available: Vec<ModelPreset>`, searches for the first preset with `is_default`, falls back to `available.first()`, clones the chosen preset's `model` string, and returns it. If the list is empty, it returns `String::default()`.

**Call relations**: This helper is called by the trait default method `get_default_model` after model presets have already been listed and filtered. It contains only the final selection rule.

*Call graph*: called by 1 (get_default_model).


##### `find_model_by_longest_prefix`  (lines 456–472)

```
fn find_model_by_longest_prefix(model: &str, candidates: &[ModelInfo]) -> Option<ModelInfo>
```

**Purpose**: Finds the candidate `ModelInfo` whose `slug` is the longest prefix of a requested model string. This supports matching versioned or suffixed model identifiers to a base catalog entry.

**Data flow**: It takes `model: &str` and `candidates: &[ModelInfo]`, iterates through candidates, skips any whose `slug` is not a prefix of `model`, tracks the best match by greatest `slug.len()`, clones the winning `ModelInfo` if any, and returns `Option<ModelInfo>`.

**Call relations**: This helper is the primary lookup mechanism used by `construct_model_info_from_candidates` and is also reused by `find_model_by_namespaced_suffix` after namespace stripping.

*Call graph*: called by 2 (construct_model_info_from_candidates, find_model_by_namespaced_suffix).


##### `find_model_by_namespaced_suffix`  (lines 474–491)

```
fn find_model_by_namespaced_suffix(model: &str, candidates: &[ModelInfo]) -> Option<ModelInfo>
```

**Purpose**: Retries model lookup for a single-segment namespaced slug such as `provider/model-name` by stripping the namespace and matching the suffix. It deliberately rejects broader patterns to avoid accidental aliasing.

**Data flow**: It takes `model: &str` and `candidates: &[ModelInfo]`, splits once on `'/'`, returns `None` if there is no slash, if the suffix still contains `'/'`, if the namespace is empty, or if the namespace contains characters other than ASCII alphanumeric, underscore, or hyphen. For valid input it calls `find_model_by_longest_prefix(suffix, candidates)` and returns that result.

**Call relations**: This helper is used as a fallback path from `construct_model_info_from_candidates` when direct longest-prefix matching fails. It delegates the actual candidate search to `find_model_by_longest_prefix` after validating the namespace shape.

*Call graph*: calls 1 internal fn (find_model_by_longest_prefix).


##### `construct_model_info_from_candidates`  (lines 493–512)

```
fn construct_model_info_from_candidates(
    model: &str,
    candidates: &[ModelInfo],
    config: &ModelsManagerConfig,
) -> ModelInfo
```

**Purpose**: Builds the final `ModelInfo` for a requested slug by combining remote-catalog matching, fallback metadata synthesis, and config overrides. It is the core metadata-resolution routine shared by online and offline flows.

**Data flow**: It takes `model: &str`, `candidates: &[ModelInfo]`, and `config: &ModelsManagerConfig`. It first tries `find_model_by_longest_prefix(model, candidates)`, then `find_model_by_namespaced_suffix(model, candidates)` if needed. If a remote candidate is found, it constructs a new `ModelInfo` using that candidate's fields but replaces `slug` with the requested model string and sets `used_fallback_model_metadata` to `false`; otherwise it calls `model_info::model_info_from_slug(model)`. Finally it passes the chosen `ModelInfo` through `model_info::with_config_overrides` and returns the result.

**Call relations**: This helper is called by the trait default method `get_model_info` and by offline test helpers. It delegates matching to the two lookup helpers, fallback synthesis to `model_info_from_slug`, and final mutation to `with_config_overrides`.

*Call graph*: calls 3 internal fn (find_model_by_longest_prefix, model_info_from_slug, with_config_overrides); called by 2 (get_model_info, construct_model_info_offline_for_tests).


### Local OSS provider readiness
These files provide shared OSS helpers and the concrete LM Studio and Ollama startup integrations built on top of local client checks.

### `utils/oss/src/lib.rs`

`orchestration` · `startup`

This file is a thin integration layer between generic configuration and concrete OSS provider crates. `get_default_model_for_oss_provider` is a pure lookup that maps known provider IDs—currently LM Studio and Ollama—to the corresponding crate constants for their default OSS models, returning `None` for unknown IDs. `ensure_oss_provider_ready` performs provider-specific startup checks asynchronously using a shared `Config`: for LM Studio it runs `codex_lmstudio::ensure_oss_ready`; for Ollama it first verifies responses support against `config.model_provider`, then runs `codex_ollama::ensure_oss_ready`. Errors from the provider setup routines are normalized into `std::io::Error` with an `OSS setup failed: ...` message, while unknown providers are intentionally ignored rather than treated as failures. That design makes the helper safe to call in generic startup flows where OSS support may or may not be configured. The included tests cover only the pure default-model lookup, asserting correct constants for the two known provider IDs and `None` for an unrecognized string.

#### Function details

##### `get_default_model_for_oss_provider`  (lines 8–14)

```
fn get_default_model_for_oss_provider(provider_id: &str) -> Option<&'static str>
```

**Purpose**: Returns the built-in default model name for a recognized OSS provider ID.

**Data flow**: It takes a provider ID string slice, matches it against `LMSTUDIO_OSS_PROVIDER_ID` and `OLLAMA_OSS_PROVIDER_ID`, and returns `Some(&'static str)` with the corresponding provider crate’s default model constant or `None` for any other ID.

**Call relations**: This pure helper is exercised by the unit tests in this file and is intended for higher-level configuration/defaulting code that needs a provider-specific model name without invoking setup.

*Call graph*: called by 3 (test_get_default_model_for_provider_lmstudio, test_get_default_model_for_provider_ollama, test_get_default_model_for_provider_unknown).


##### `ensure_oss_provider_ready`  (lines 17–38)

```
async fn ensure_oss_provider_ready(
    provider_id: &str,
    config: &Config,
) -> Result<(), std::io::Error>
```

**Purpose**: Runs provider-specific readiness/setup checks so an OSS backend is usable before requests are sent to it.

**Data flow**: It takes a provider ID and shared `Config`. For LM Studio it awaits `codex_lmstudio::ensure_oss_ready(config)` and wraps any error as `std::io::Error::other`. For Ollama it first awaits `codex_ollama::ensure_responses_supported(&config.model_provider)`, then awaits `codex_ollama::ensure_oss_ready(config)` with the same wrapping. Unknown provider IDs perform no action and still return `Ok(())`.

**Call relations**: This function is meant to be called by startup or provider-selection flows before using an OSS backend. It delegates all concrete checks to provider crates and only orchestrates branching and error normalization.

*Call graph*: 3 external calls (ensure_oss_ready, ensure_oss_ready, ensure_responses_supported).


##### `tests::test_get_default_model_for_provider_lmstudio`  (lines 45–48)

```
fn test_get_default_model_for_provider_lmstudio()
```

**Purpose**: Asserts that LM Studio’s provider ID resolves to the LM Studio default model constant.

**Data flow**: It calls `get_default_model_for_oss_provider(LMSTUDIO_OSS_PROVIDER_ID)` and compares the result to `Some(codex_lmstudio::DEFAULT_OSS_MODEL)`.

**Call relations**: This unit test covers the LM Studio match arm of the default-model lookup.

*Call graph*: calls 1 internal fn (get_default_model_for_oss_provider); 1 external calls (assert_eq!).


##### `tests::test_get_default_model_for_provider_ollama`  (lines 51–54)

```
fn test_get_default_model_for_provider_ollama()
```

**Purpose**: Asserts that Ollama’s provider ID resolves to the Ollama default model constant.

**Data flow**: It calls `get_default_model_for_oss_provider(OLLAMA_OSS_PROVIDER_ID)` and compares the result to `Some(codex_ollama::DEFAULT_OSS_MODEL)`.

**Call relations**: This unit test covers the Ollama match arm of the default-model lookup.

*Call graph*: calls 1 internal fn (get_default_model_for_oss_provider); 1 external calls (assert_eq!).


##### `tests::test_get_default_model_for_provider_unknown`  (lines 57–60)

```
fn test_get_default_model_for_provider_unknown()
```

**Purpose**: Asserts that an unrecognized provider ID has no default model mapping.

**Data flow**: It calls `get_default_model_for_oss_provider("unknown-provider")` and asserts the result is `None`.

**Call relations**: This unit test covers the fallback branch of the default-model lookup.

*Call graph*: calls 1 internal fn (get_default_model_for_oss_provider); 1 external calls (assert_eq!).


### `ollama/src/client.rs`

`io_transport` · `startup checks and model download handling`

This file centers on `OllamaClient`, a thin async wrapper around `reqwest::Client` plus two pieces of derived URL state: `host_root`, which strips any trailing `/v1` OpenAI-compatible suffix, and `uses_openai_compat`, which decides which health endpoint to probe. Construction is intentionally defensive: `try_from_oss_provider` resolves the built-in OSS provider from `Config` so user overrides are honored, while `try_from_provider` requires a provider `base_url`, normalizes it, builds a client with a 5-second connect timeout, and immediately verifies reachability via `probe_server`. Probe failures are collapsed into a single user-facing `OLLAMA_CONNECTION_ERROR` message with install/run instructions.

The operational methods split into metadata queries and pull orchestration. `fetch_models` reads `/api/tags` and extracts `models[*].name` strings, returning an empty list on non-success HTTP status rather than failing hard. `fetch_version` reads `/api/version`, tolerates missing or unparsable versions, trims a leading `v`, and logs parse failures before returning `None`. `pull_model_stream` starts `/api/pull` with NDJSON streaming enabled, incrementally accumulates bytes in `LineBuffer`, parses complete UTF-8 JSON lines, converts each object through `pull_events_from_value`, and terminates early on embedded `error` or `status == "success"` fields because Ollama may return HTTP 200 even for pull failures. `pull_with_reporter` is the higher-level loop that feeds those events into a `PullProgressReporter`, translating `PullEvent::Error` into an `io::Error` and treating an exhausted stream without success as unexpected. The tests validate native vs `/v1` probing, version parsing, large-line buffering, and constructor behavior under reachable and unreachable mock endpoints.

#### Function details

##### `OllamaClient::try_from_oss_provider`  (lines 35–50)

```
async fn try_from_oss_provider(config: &Config) -> io::Result<Self>
```

**Purpose**: Builds an `OllamaClient` from the built-in OSS provider entry in `Config`, ensuring any configured provider override is used instead of a hardcoded URL. It fails early if that provider entry is absent.

**Data flow**: Reads `config.model_providers` and looks up `OLLAMA_OSS_PROVIDER_ID`; if missing, constructs an `io::ErrorKind::NotFound`. On success it passes the resolved `ModelProviderInfo` into `OllamaClient::try_from_provider` and returns the resulting verified client.

**Call relations**: This is the startup path used by `ensure_oss_ready` before any local-model checks or pulls occur. It delegates all URL normalization, HTTP client creation, and server probing to `OllamaClient::try_from_provider`.

*Call graph*: called by 1 (ensure_oss_ready); 1 external calls (try_from_provider).


##### `OllamaClient::try_from_provider_with_base_url`  (lines 53–56)

```
async fn try_from_provider_with_base_url(base_url: &str) -> io::Result<Self>
```

**Purpose**: Test-only convenience constructor that synthesizes an OSS provider definition from a raw base URL and then builds a verified client from it. It exists to keep tests focused on URL/probing behavior without assembling full config structures.

**Data flow**: Takes `base_url: &str`, creates a `ModelProviderInfo` via `create_oss_provider_with_base_url(..., WireApi::Responses)`, then forwards that provider into `OllamaClient::try_from_provider`. It returns the same `io::Result<OllamaClient>` produced by the real constructor path.

**Call relations**: It is invoked only by tests covering version fetches and probe success/failure cases. Its sole delegation is to provider creation and then the normal constructor, so tests exercise production initialization logic rather than a separate code path.

*Call graph*: called by 4 (test_fetch_version, test_probe_server_happy_path_openai_compat_and_native, test_try_from_oss_provider_err_when_server_missing, test_try_from_oss_provider_ok_when_server_running); 2 external calls (try_from_provider, create_oss_provider_with_base_url).


##### `OllamaClient::try_from_provider`  (lines 59–78)

```
async fn try_from_provider(provider: &ModelProviderInfo) -> io::Result<Self>
```

**Purpose**: Constructs a client from a provider definition, derives whether the URL is native Ollama or OpenAI-compatible, and verifies the server is reachable before returning. This is the canonical constructor for non-test code.

**Data flow**: Reads `provider.base_url` and expects it to be present for the OSS provider. It computes `uses_openai_compat` with `is_openai_compatible_base_url`, computes `host_root` with `base_url_to_host_root`, builds a `reqwest::Client` with a 5-second connect timeout (falling back to `reqwest::Client::new()` if builder creation fails), stores those fields in `Self`, then calls `probe_server`; on probe success it returns the initialized client, otherwise propagates the `io::Error`.

**Call relations**: This constructor is reached from `try_from_oss_provider` and from `ensure_responses_supported`, where successful probing is a prerequisite for later version checks. It delegates endpoint-shape decisions to the URL helpers and liveness verification to `probe_server`.

*Call graph*: calls 2 internal fn (base_url_to_host_root, is_openai_compatible_base_url); called by 1 (ensure_responses_supported); 2 external calls (builder, from_secs).


##### `OllamaClient::probe_server`  (lines 81–101)

```
async fn probe_server(&self) -> io::Result<()>
```

**Purpose**: Checks whether the configured Ollama server is reachable by hitting the appropriate lightweight endpoint for either native or OpenAI-compatible mode. It intentionally maps all failures to a single actionable connection message.

**Data flow**: Reads `self.uses_openai_compat` and `self.host_root` to build either `<host>/v1/models` or `<host>/api/tags`, then performs a GET with `self.client`. Transport errors are logged with `tracing::warn!` and converted to `io::Error::other(OLLAMA_CONNECTION_ERROR)`; non-success HTTP statuses are also logged and converted to the same error; only success status returns `Ok(())`.

**Call relations**: It is called during client construction so later operations can assume the server was reachable at initialization time. It does not delegate further within this crate; it is the terminal health-check step.

*Call graph*: 4 external calls (get, other, format!, warn!).


##### `OllamaClient::fetch_models`  (lines 104–127)

```
async fn fetch_models(&self) -> io::Result<Vec<String>>
```

**Purpose**: Queries the native Ollama tags endpoint and extracts the list of locally known model names. It is tolerant of server-side non-success responses by returning an empty vector instead of failing.

**Data flow**: Builds `<host>/api/tags` from `self.host_root`, performs a GET, and converts transport or JSON-decoding failures into `io::Error`. If the HTTP status is not successful it returns `Ok(Vec::new())`; otherwise it parses the body as `serde_json::Value`, reads `models` as an array, pulls each `name` string, clones them into `Vec<String>`, and returns that vector.

**Call relations**: This method is used by `ensure_oss_ready` to decide whether the requested OSS model must be downloaded. It is a leaf operation that only performs HTTP and JSON extraction.

*Call graph*: 3 external calls (new, get, format!).


##### `OllamaClient::fetch_version`  (lines 130–153)

```
async fn fetch_version(&self) -> io::Result<Option<Version>>
```

**Purpose**: Reads the Ollama server version from `/api/version` and converts it into `semver::Version` when possible. Missing endpoints, missing fields, and unparsable strings are treated as absence rather than hard failure.

**Data flow**: Builds `<host>/api/version`, performs a GET, and maps transport/JSON errors to `io::Error`. If the status is non-success it returns `Ok(None)`; otherwise it reads the `version` string field, trims whitespace, strips a leading `v`, and attempts `Version::parse`. Successful parsing yields `Ok(Some(version))`; parse failures are logged and downgraded to `Ok(None)`.

**Call relations**: It is called by `ensure_responses_supported` after a client has already been constructed and probed. The method deliberately avoids enforcing version semantics itself, leaving that policy decision to the caller.

*Call graph*: 4 external calls (parse, get, format!, warn!).


##### `OllamaClient::pull_model_stream`  (lines 157–211)

```
async fn pull_model_stream(
        &self,
        model: &str,
    ) -> io::Result<BoxStream<'static, PullEvent>>
```

**Purpose**: Starts a streaming model pull against Ollama and exposes the NDJSON response as a boxed async stream of `PullEvent` values. It incrementally decodes line-delimited JSON and stops as soon as success or embedded error is observed.

**Data flow**: Takes `model: &str`, POSTs to `<host>/api/pull` with JSON body `{ "model": model, "stream": true }`, and rejects non-success HTTP status with an `io::Error`. For a successful response it consumes `resp.bytes_stream()`, appends each chunk into a `LineBuffer`, repeatedly extracts complete newline-terminated records, decodes UTF-8 text, trims blank lines, parses each line as `serde_json::Value`, converts that object into zero or more `PullEvent`s via `pull_events_from_value`, and yields them from an `async_stream`. If the JSON object contains `error`, it yields `PullEvent::Error` and returns; if it contains `status == "success"`, it yields `PullEvent::Success` and returns; stream read errors simply terminate the stream.

**Call relations**: This is the low-level event source consumed by `pull_with_reporter`. It delegates byte framing to `LineBuffer` and semantic event extraction to `pull_events_from_value` so the streaming loop stays focused on transport and termination behavior.

*Call graph*: called by 1 (pull_with_reporter); 8 external calls (pin, new, stream!, post, other, format!, default, json!).


##### `OllamaClient::pull_with_reporter`  (lines 214–245)

```
async fn pull_with_reporter(
        &self,
        model: &str,
        reporter: &mut dyn PullProgressReporter,
    ) -> io::Result<()>
```

**Purpose**: Runs a full model pull while forwarding each pull event to a caller-provided progress reporter and converting terminal stream conditions into `io::Result<()>`. It is the ergonomic API used by higher layers that want progress output rather than raw events.

**Data flow**: Accepts `model: &str` and `reporter: &mut dyn PullProgressReporter`. It first emits a synthetic `PullEvent::Status("Pulling model ...")` to the reporter, then obtains the event stream from `pull_model_stream` and iterates it. Each event is passed to `reporter.on_event`; `PullEvent::Success` returns `Ok(())`, `PullEvent::Error(err)` becomes `Err(io::Error::other(format!("Pull failed: {err}")))`, and status/progress events continue looping. If the stream ends without success or error, it returns an `io::Error` indicating unexpected termination.

**Call relations**: This method is called by `ensure_oss_ready` when the desired model is not already present locally. It delegates transport and parsing to `pull_model_stream` and delegates rendering side effects to the injected `PullProgressReporter` implementation.

*Call graph*: calls 1 internal fn (pull_model_stream); 4 external calls (other, format!, Status, on_event).


##### `OllamaClient::from_host_root`  (lines 249–259)

```
fn from_host_root(host_root: impl Into<String>) -> Self
```

**Purpose**: Creates a test-only client directly from a raw host root without probing or URL-shape detection. It is used to target mock servers in unit tests.

**Data flow**: Consumes `host_root: impl Into<String>`, builds a `reqwest::Client` with the same 5-second connect timeout and fallback behavior as the main constructor, stores the converted host root string, and hardcodes `uses_openai_compat: false`. It returns the constructed `OllamaClient` immediately.

**Call relations**: Tests that only need native-endpoint behavior call this helper instead of going through provider resolution and probing. It avoids extra setup while still exercising the production request methods.

*Call graph*: called by 3 (test_fetch_models_happy_path, test_probe_server_happy_path_openai_compat_and_native, test_pull_model_stream_parses_large_json_lines); 3 external calls (into, builder, from_secs).


##### `tests::test_fetch_models_happy_path`  (lines 270–298)

```
async fn test_fetch_models_happy_path()
```

**Purpose**: Verifies that `fetch_models` parses model names out of a successful `/api/tags` response. It also respects the sandbox-network disable flag by skipping when networked mock-server tests are not allowed.

**Data flow**: Reads the sandbox-disable environment variable and returns early if set. Otherwise it starts a `wiremock::MockServer`, mounts a GET `/api/tags` response containing two model objects, constructs a client with `from_host_root(server.uri())`, calls `fetch_models`, and asserts that both expected names are present in the returned `Vec<String>`.

**Call relations**: This test drives the native tags-fetch path directly, without constructor probing. Its mock setup isolates JSON extraction behavior from unrelated connection logic.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert!, json!, var, info!, given, start, new, method, path).


##### `tests::test_fetch_version`  (lines 301–334)

```
async fn test_fetch_version()
```

**Purpose**: Checks that a reachable server exposing `/api/version` with a plain semantic version string is parsed into `Version`. It also ensures the constructor path succeeds by mocking the probe endpoint first.

**Data flow**: Optionally skips based on the sandbox-disable environment variable. It starts a mock server, mounts GET `/api/tags` for probe success and GET `/api/version` returning `{ "version": "0.14.1" }`, constructs a client through `try_from_provider_with_base_url`, calls `fetch_version`, and asserts the result is `Some(Version::new(0, 14, 1))`.

**Call relations**: The test exercises both constructor probing and version parsing together. It uses the test-only provider constructor so the production `try_from_provider` path is still covered.

*Call graph*: calls 1 internal fn (try_from_provider_with_base_url); 9 external calls (assert_eq!, json!, var, info!, given, start, new, method, path).


##### `tests::test_pull_model_stream_parses_large_json_lines`  (lines 337–378)

```
async fn test_pull_model_stream_parses_large_json_lines()
```

**Purpose**: Confirms that `pull_model_stream` can parse very large NDJSON records that arrive through the byte stream, not just small lines. This specifically validates the buffering logic around `LineBuffer`.

**Data flow**: After an optional sandbox skip, it starts a mock server and mounts POST `/api/pull` returning two newline-delimited JSON objects, the first padded with 128 KiB of text. It constructs a client with `from_host_root`, starts `pull_model_stream("test-model")`, collects the stream into `Vec<PullEvent>`, and asserts the resulting events are two `PullEvent::Status` values with the expected strings.

**Call relations**: This test targets the streaming parser path used by `pull_with_reporter`, but inspects raw events directly. It indirectly exercises `LineBuffer` and `pull_events_from_value` through the production stream loop.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert_matches!, format!, var, info!, given, start, new, method, path).


##### `tests::test_probe_server_happy_path_openai_compat_and_native`  (lines 381–415)

```
async fn test_probe_server_happy_path_openai_compat_and_native()
```

**Purpose**: Verifies that probing chooses `/api/tags` for native roots and `/v1/models` for OpenAI-compatible roots. It covers both endpoint-selection branches in `probe_server`.

**Data flow**: After checking the sandbox-disable variable, it starts one mock server. It first mounts GET `/api/tags`, creates a native client with `from_host_root`, and asserts `probe_server` succeeds. Then it mounts GET `/v1/models`, constructs a client from a `/v1` base URL via `try_from_provider_with_base_url`, and asserts probing succeeds again.

**Call relations**: The test explicitly drives both URL-shape modes that are derived in `try_from_provider` and consumed by `probe_server`. It validates that the constructor and direct probe agree on endpoint selection.

*Call graph*: calls 2 internal fn (from_host_root, try_from_provider_with_base_url); 8 external calls (format!, var, info!, given, start, new, method, path).


##### `tests::test_try_from_oss_provider_ok_when_server_running`  (lines 418–439)

```
async fn test_try_from_oss_provider_ok_when_server_running()
```

**Purpose**: Checks that the provider-based constructor succeeds when the expected OpenAI-compatible probe endpoint responds successfully. It validates the positive path for startup readiness checks.

**Data flow**: It optionally skips under sandbox restrictions, starts a mock server, mounts GET `/v1/models` with HTTP 200, then calls `try_from_provider_with_base_url` using a `/v1` URL and asserts the returned result is `Ok`.

**Call relations**: This test focuses on constructor success rather than later request methods. It covers the same path `ensure_oss_ready` relies on before attempting model discovery or pulls.

*Call graph*: calls 1 internal fn (try_from_provider_with_base_url); 8 external calls (format!, var, info!, given, start, new, method, path).


##### `tests::test_try_from_oss_provider_err_when_server_missing`  (lines 442–457)

```
async fn test_try_from_oss_provider_err_when_server_missing()
```

**Purpose**: Checks that constructor probing reports the standardized user-facing connection error when the server is unreachable or does not expose the expected endpoint. This ensures startup failures are actionable and stable.

**Data flow**: After an optional sandbox skip, it starts a mock server without mounting the required `/v1/models` route, calls `try_from_provider_with_base_url` with a `/v1` URL, extracts the resulting error, and asserts its string matches `OLLAMA_CONNECTION_ERROR` exactly.

**Call relations**: This test covers the negative branch of `probe_server` as reached through the normal constructor path. It verifies that low-level HTTP failure details are intentionally hidden behind the fixed guidance message.

*Call graph*: calls 1 internal fn (try_from_provider_with_base_url); 5 external calls (assert_eq!, format!, var, info!, start).


### `ollama/src/lib.rs`

`orchestration` · `startup and provider capability validation`

This module is the crate-level façade over the Ollama integration. It declares the internal submodules, re-exports `OllamaClient`, `PullEvent`, and the CLI/TUI progress reporter types, and defines `DEFAULT_OSS_MODEL` as the fallback model when `--oss` is selected without an explicit `-m`. The main orchestration function is `ensure_oss_ready`: it chooses the requested model from `Config` or falls back to the default, constructs and probes an `OllamaClient` through the config-aware OSS provider path, then asks Ollama for the locally available models. If the desired model is absent, it creates a `CliProgressReporter` and performs a pull; if model enumeration itself fails, it only logs a warning and allows higher layers to continue, making model-list lookup non-fatal.

The second policy layer is version gating for the Responses API. `min_responses_version` centralizes the cutoff (`0.13.4`), while `supports_responses` treats the special development version `0.0.0` as supported and otherwise compares against that minimum. `ensure_responses_supported` combines those helpers with `OllamaClient::try_from_provider` and `fetch_version`: if the version endpoint is missing or unparsable it returns success, but if a concrete version is present and below the cutoff it returns an `io::Error` explaining the minimum required Ollama version. The tests here are pure policy checks around the version predicate.

#### Function details

##### `ensure_oss_ready`  (lines 23–50)

```
async fn ensure_oss_ready(config: &Config) -> std::io::Result<()>
```

**Purpose**: Performs the startup sequence needed before using the built-in OSS provider: verify Ollama is reachable, check whether the target model is already local, and pull it if not. It is intentionally conservative about what counts as fatal.

**Data flow**: Reads `config.model` and falls back to `DEFAULT_OSS_MODEL` when absent. It constructs an `OllamaClient` via `try_from_oss_provider`; then it calls `fetch_models`. If model listing succeeds and the chosen model name is not found in the returned `Vec<String>`, it creates a `CliProgressReporter` and awaits `pull_with_reporter(model, &mut reporter)`. If `fetch_models` itself errors, it logs a warning and still returns `Ok(())`; constructor or pull failures propagate as `io::Error`.

**Call relations**: This is the top-level readiness path that invokes `OllamaClient::try_from_oss_provider` before any OSS-backed run proceeds. It delegates user-visible pull rendering to `CliProgressReporter::new` and the actual download loop to the client.

*Call graph*: calls 2 internal fn (try_from_oss_provider, new); 1 external calls (warn!).


##### `min_responses_version`  (lines 52–54)

```
fn min_responses_version() -> Version
```

**Purpose**: Defines the minimum Ollama semantic version that is considered new enough for the Responses API. Keeping it in one helper avoids duplicating the cutoff literal.

**Data flow**: It takes no inputs and returns `Version::new(0, 13, 4)`.

**Call relations**: This helper is used by both `supports_responses` for comparisons and `ensure_responses_supported` for constructing the error message shown when the server is too old.

*Call graph*: called by 2 (ensure_responses_supported, supports_responses); 1 external calls (new).


##### `supports_responses`  (lines 56–58)

```
fn supports_responses(version: &Version) -> bool
```

**Purpose**: Encodes the version policy for whether a specific Ollama version should be treated as Responses-capable. It includes a special-case allowance for the development sentinel version `0.0.0`.

**Data flow**: Consumes `version: &Version` and compares it against two conditions: exact equality with `Version::new(0, 0, 0)` or greater-than-or-equal to `min_responses_version()`. It returns a boolean and does not mutate any state.

**Call relations**: This predicate is called by `ensure_responses_supported` after version discovery. The tests in this file exercise its boundary conditions directly.

*Call graph*: calls 1 internal fn (min_responses_version); called by 1 (ensure_responses_supported); 1 external calls (new).


##### `ensure_responses_supported`  (lines 63–77)

```
async fn ensure_responses_supported(provider: &ModelProviderInfo) -> std::io::Result<()>
```

**Purpose**: Verifies that a reachable Ollama provider is new enough to support the Responses API, while tolerating missing or unreadable version information. It turns version policy into a concrete startup check.

**Data flow**: Takes `provider: &ModelProviderInfo`, constructs and probes an `OllamaClient` with `try_from_provider`, then calls `fetch_version`. If no version is available it returns `Ok(())`. If a version exists and `supports_responses(&version)` is true it returns `Ok(())`; otherwise it computes `min_responses_version()` and returns `std::io::Error::other` with a message stating the running and minimum required versions.

**Call relations**: This function is the orchestrating caller of both the client constructor and the version-policy helpers. It separates transport concerns (client/version fetch) from policy concerns (`supports_responses`).

*Call graph*: calls 3 internal fn (try_from_provider, min_responses_version, supports_responses); 2 external calls (other, format!).


##### `tests::supports_responses_for_dev_zero`  (lines 84–86)

```
fn supports_responses_for_dev_zero()
```

**Purpose**: Asserts that the special development version `0.0.0` is treated as Responses-capable. This preserves the intended escape hatch for dev builds or unreleased servers.

**Data flow**: Constructs `Version::new(0, 0, 0)`, passes it to `supports_responses`, and asserts the returned boolean is true.

**Call relations**: This test targets only the policy helper and does not involve any client or I/O code.

*Call graph*: 1 external calls (assert!).


##### `tests::does_not_support_responses_before_cutoff`  (lines 89–91)

```
fn does_not_support_responses_before_cutoff()
```

**Purpose**: Checks the lower boundary just before the minimum supported version. It ensures the cutoff is enforced strictly.

**Data flow**: Constructs `Version::new(0, 13, 3)`, evaluates `supports_responses`, and asserts the result is false.

**Call relations**: Like the other tests in this file, it isolates the pure version predicate from transport and configuration concerns.

*Call graph*: 1 external calls (assert!).


##### `tests::supports_responses_at_or_after_cutoff`  (lines 94–97)

```
fn supports_responses_at_or_after_cutoff()
```

**Purpose**: Verifies that the exact cutoff version and a later version are both accepted. This guards against off-by-one mistakes in the comparison logic.

**Data flow**: Constructs `Version::new(0, 13, 4)` and `Version::new(0, 14, 0)`, calls `supports_responses` for each, and asserts both results are true.

**Call relations**: This test complements the previous boundary test to fully pin down the intended comparison behavior.

*Call graph*: 1 external calls (assert!).


### `lmstudio/src/lib.rs`

`orchestration` · `startup / OSS mode preparation`

This small orchestration module re-exports `LMStudioClient`, defines `DEFAULT_OSS_MODEL`, and provides the single high-level async function `ensure_oss_ready`. The function chooses the model name from `config.model` when present or falls back to `openai/gpt-oss-20b`. It then constructs an `LMStudioClient` from the configured provider, which also verifies that the local LM Studio server is responding before any further work proceeds.

Once connectivity is established, `ensure_oss_ready` asks LM Studio for the current model list. If that query succeeds and the desired model ID is absent, it synchronously downloads the model through the `lms` CLI. If the query itself fails, the function intentionally does not fail the whole setup path; instead it logs a warning and allows higher layers to continue, on the assumption that later operations may surface a more actionable error. Finally, it spawns a detached Tokio task that calls `load_model` in the background. Any failure to load is downgraded to a warning, so the main setup path returns `Ok(())` once reachability and any required download have completed. The design choice here is explicit: server reachability is mandatory, model enumeration is best-effort, and model loading is opportunistic and asynchronous.

#### Function details

##### `ensure_oss_ready`  (lines 13–46)

```
async fn ensure_oss_ready(config: &Config) -> std::io::Result<()>
```

**Purpose**: Prepares the local LM Studio environment for OSS usage by selecting a model, verifying the server, downloading the model if absent, and starting a background load request.

**Data flow**: Reads `config.model` or falls back to `DEFAULT_OSS_MODEL`; awaits `LMStudioClient::try_from_provider(config)`; awaits `fetch_models` and, on success, checks whether any returned model string equals the chosen model, calling `download_model` if not. On fetch failure it logs a warning and continues. It then clones the client, copies the model string, spawns a Tokio task that awaits `load_model` and logs any failure, and finally returns `Ok(())`.

**Call relations**: This is the sole public orchestration function in the module and is invoked by higher-level OSS setup flows. It delegates all transport details to `LMStudioClient` methods while deciding which failures are fatal versus warning-only.

*Call graph*: calls 1 internal fn (try_from_provider); 2 external calls (spawn, warn!).


### Connector and MCP discovery
These files fetch connector directories, establish MCP client access, and assemble ChatGPT-visible connector lists and workspace gating settings.

### `connectors/src/lib.rs`

`domain_logic` · `connector directory fetch, normalization, and cache refresh`

This file is the core connector-directory module. It defines the account-scoped `ConnectorDirectoryCacheKey`, the in-memory cache entry `CachedConnectorDirectory`, wire-format structs `DirectoryListResponse` and `DirectoryApp`, and the async fetch pipeline `list_all_connectors_with_options`. Caching is layered: a single global `LazyLock<StdMutex<Option<CachedConnectorDirectory>>>` stores one in-memory entry with an `expires_at`, while `directory_cache` persists the same connector list to disk. Memory cache lookups can be either unconditional (`cached_directory_connectors_in_memory`) or TTL-checked (`unexpired_directory_connectors_in_memory`). Disk cache reads are only used by `cached_directory_connectors`, which repopulates memory with `Duration::ZERO` so callers can inspect stale persisted data without treating it as fresh for future fetches.

Fetching walks `/connectors/directory/list?external_logos=true` page by page, URL-encoding continuation tokens and filtering out apps whose `visibility` is `HIDDEN`. Workspace accounts optionally fetch `/connectors/directory/list_workspace?external_logos=true`; failures there are swallowed and treated as no extra apps. Results from both sources are merged by app ID, with `merge_directory_app` filling missing fields and preserving richer incoming metadata such as branding and app metadata subfields.

After merging, each `DirectoryApp` becomes an `AppInfo`, then is normalized: blank names fall back to connector ID, descriptions are trimmed and emptied to `None`, missing install URLs are synthesized from a slugified name, and `is_accessible` is forced false. The final list is sorted by `name` then `id`, written to memory and disk cache, and returned.

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

**Purpose**: Constructs the cache key that identifies connector directory results for a specific backend/account/user/workspace combination.

**Data flow**: Takes `chatgpt_base_url`, optional `account_id`, optional `chatgpt_user_id`, and `is_workspace_account`, stores them directly in a new `ConnectorDirectoryCacheKey`, and returns it.

**Call relations**: Higher-level auth and cache-context builders create this key before any cache lookup or fetch so both memory and disk caches are partitioned by the same identity inputs.

*Call graph*: called by 3 (connector_directory_cache_context, cache_key, cached_directory_connectors_for_tool_suggest_with_auth).


##### `cached_directory_connectors`  (lines 89–108)

```
fn cached_directory_connectors(
    cache_context: &ConnectorDirectoryCacheContext,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Returns cached connector directory results if available, preferring memory and falling back to disk.

**Data flow**: Reads `cache_context.cache_key`, first queries `cached_directory_connectors_in_memory`; if present, returns that cloned vector. Otherwise it calls `load_cached_directory_connectors_from_disk`, and on a disk `Hit` writes the connectors back into memory with zero TTL via `write_cached_directory_connectors_in_memory` before returning `Some(connectors)`. Missing or invalid disk cache yields `None`.

**Call relations**: It is the synchronous cache-only access path used by tests and likely by callers that want stale persisted data without network I/O. It bridges the disk cache module back into the in-memory cache so subsequent reads can reuse the loaded value.

*Call graph*: calls 3 internal fn (cached_directory_connectors_in_memory, load_cached_directory_connectors_from_disk, write_cached_directory_connectors_in_memory); called by 1 (cached_directory_connectors_reads_directory_disk_cache).


##### `cached_directory_connectors_in_memory`  (lines 110–120)

```
fn cached_directory_connectors_in_memory(
    cache_key: &ConnectorDirectoryCacheKey,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Reads the shared in-memory connector cache without checking expiration.

**Data flow**: Locks `CONNECTOR_DIRECTORY_CACHE`, recovers from poison by taking the inner guard, inspects the optional cached entry, compares its `key` to the provided `cache_key`, and returns a cloned `Vec<AppInfo>` only on key match.

**Call relations**: It is only called by `cached_directory_connectors`, which intentionally accepts stale memory entries when the caller asked for any cached data.

*Call graph*: called by 1 (cached_directory_connectors).


##### `unexpired_directory_connectors_in_memory`  (lines 122–133)

```
fn unexpired_directory_connectors_in_memory(
    cache_key: &ConnectorDirectoryCacheKey,
) -> Option<Vec<AppInfo>>
```

**Purpose**: Reads the shared in-memory connector cache only if the key matches and the TTL has not expired.

**Data flow**: Locks `CONNECTOR_DIRECTORY_CACHE`, extracts the cached entry if present, compares `cached.key` to the input key and `Instant::now()` to `cached.expires_at`, and returns a cloned connector vector only when both checks pass.

**Call relations**: It is the freshness gate used by `list_all_connectors_with_options` before deciding whether to perform network fetches.

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

**Purpose**: Fetches connector directory pages, optionally adds workspace connectors, merges duplicates, normalizes fields, caches the result, and returns the final connector list.

**Data flow**: Consumes a `ConnectorDirectoryCacheContext`, `is_workspace_account`, `force_refetch`, and a mutable async `fetch_page` closure. If refetch is not forced and `unexpired_directory_connectors_in_memory` returns data, it returns that immediately. Otherwise it awaits `list_directory_connectors`, optionally extends with `list_workspace_connectors`, merges duplicate `DirectoryApp`s by ID via `merge_directory_apps`, maps each to `AppInfo`, fills or preserves `install_url`, normalizes `name` and `description`, forces `is_accessible = false`, sorts by `name` then `id`, writes the list through `write_cached_directory_connectors`, and returns `Ok(connectors)`.

**Call relations**: This is the main orchestration path for connector retrieval and is exercised by multiple tests covering cache reuse, normalization, and refresh behavior. It delegates pagination, workspace fetch, merge policy, normalization helpers, and cache persistence to specialized functions.

*Call graph*: calls 8 internal fn (connector_install_url, list_directory_connectors, list_workspace_connectors, merge_directory_apps, normalize_connector_name, normalize_connector_value, unexpired_directory_connectors_in_memory, write_cached_directory_connectors); called by 4 (cached_directory_connectors_reads_directory_disk_cache, list_all_connectors_merges_and_normalizes_directory_apps, list_all_connectors_refreshes_when_only_directory_disk_cache_exists, list_all_connectors_uses_shared_directory_cache).


##### `write_cached_directory_connectors`  (lines 180–190)

```
fn write_cached_directory_connectors(
    cache_context: &ConnectorDirectoryCacheContext,
    connectors: &[AppInfo],
)
```

**Purpose**: Stores freshly fetched connectors in both the in-memory TTL cache and the disk cache.

**Data flow**: Accepts a cache context and connector slice, clones the cache key into `write_cached_directory_connectors_in_memory` with `CONNECTORS_CACHE_TTL`, then passes the same connectors to `directory_cache::write_cached_directory_connectors_to_disk`.

**Call relations**: It is called only after successful fetch-and-normalize completion in `list_all_connectors_with_options`, centralizing the dual-write behavior.

*Call graph*: calls 2 internal fn (write_cached_directory_connectors_to_disk, write_cached_directory_connectors_in_memory); called by 1 (list_all_connectors_with_options).


##### `write_cached_directory_connectors_in_memory`  (lines 192–205)

```
fn write_cached_directory_connectors_in_memory(
    cache_key: ConnectorDirectoryCacheKey,
    connectors: &[AppInfo],
    ttl: Duration,
)
```

**Purpose**: Replaces the single shared in-memory connector cache entry with a new value and expiration time.

**Data flow**: Takes ownership of a `ConnectorDirectoryCacheKey`, a connector slice, and a `ttl: Duration`; locks `CONNECTOR_DIRECTORY_CACHE`, computes `expires_at` as `Instant::now() + ttl`, clones the connectors into a `Vec<AppInfo>`, and stores `Some(CachedConnectorDirectory { ... })` into the global slot.

**Call relations**: It is used both by normal cache writes and by disk-cache reads that repopulate memory with zero TTL. Because the cache is a single `Option`, each write overwrites any previous key’s entry.

*Call graph*: called by 2 (cached_directory_connectors, write_cached_directory_connectors); 2 external calls (now, to_vec).


##### `list_directory_connectors`  (lines 207–238)

```
async fn list_directory_connectors(fetch_page: &mut F) -> anyhow::Result<Vec<DirectoryApp>>
```

**Purpose**: Fetches all pages from the main connector directory endpoint and filters out hidden apps.

**Data flow**: Takes a mutable async page-fetch closure, initializes `apps` and `next_token`, loops building either the base path or a tokenized path with `urlencoding::encode`, awaits `fetch_page(path)`, extends `apps` with non-hidden `response.apps`, trims and normalizes `response.next_token`, and stops when no non-empty token remains. It returns the accumulated `Vec<DirectoryApp>`.

**Call relations**: It is the primary network pagination helper used by `list_all_connectors_with_options` and directly tested to ensure request paths omit any tier parameter and correctly encode continuation tokens.

*Call graph*: called by 2 (list_all_connectors_with_options, list_directory_connectors_omits_tier_for_all_pages); 3 external calls (new, format!, encode).


##### `list_workspace_connectors`  (lines 240–255)

```
async fn list_workspace_connectors(fetch_page: &mut F) -> anyhow::Result<Vec<DirectoryApp>>
```

**Purpose**: Fetches the workspace-specific connector directory endpoint and treats failures as an empty result.

**Data flow**: Invokes the supplied async fetch closure with the fixed workspace path, and on success filters hidden apps from `response.apps`; on any error it returns `Ok(Vec::new())` instead of propagating the failure.

**Call relations**: It is called only when `list_all_connectors_with_options` is told the account is a workspace account. The swallowed-error behavior keeps workspace enrichment from breaking the base directory fetch.

*Call graph*: called by 1 (list_all_connectors_with_options); 1 external calls (new).


##### `merge_directory_apps`  (lines 257–267)

```
fn merge_directory_apps(apps: Vec<DirectoryApp>) -> Vec<DirectoryApp>
```

**Purpose**: Deduplicates `DirectoryApp` records by ID and merges overlapping metadata from repeated entries.

**Data flow**: Consumes `Vec<DirectoryApp>`, inserts each app into a `HashMap<String, DirectoryApp>` keyed by `id`, and when a duplicate ID appears calls `merge_directory_app` to fold the incoming record into the existing one. It returns the map’s values as a vector.

**Call relations**: It is used after combining main-directory and workspace-directory results so duplicate app IDs become one canonical record before conversion to `AppInfo`.

*Call graph*: calls 1 internal fn (merge_directory_app); called by 1 (list_all_connectors_with_options); 1 external calls (new).


##### `merge_directory_app`  (lines 269–407)

```
fn merge_directory_app(existing: &mut DirectoryApp, incoming: DirectoryApp)
```

**Purpose**: Merges one incoming `DirectoryApp` into an existing one, preferring non-empty or previously missing metadata field by field.

**Data flow**: Mutably reads and updates `existing: &mut DirectoryApp` using `incoming: DirectoryApp`. It replaces an empty existing name with a non-empty incoming one; overwrites description when the incoming description is present and non-blank; fills missing logo URLs and distribution channel; merges nested `branding` and `app_metadata` subfields only when the existing subfield is `None` and the incoming one is `Some`, except `is_discoverable_app` which is OR-like and becomes true if either side is true; and fills `labels` only when missing.

**Call relations**: It is the per-duplicate merge policy called from `merge_directory_apps`. The detailed field-by-field logic preserves richer metadata from either source without blanking already populated values.

*Call graph*: called by 1 (merge_directory_apps).


##### `is_hidden_directory_app`  (lines 409–411)

```
fn is_hidden_directory_app(app: &DirectoryApp) -> bool
```

**Purpose**: Identifies directory entries that should be excluded because their visibility is marked hidden.

**Data flow**: Reads a `&DirectoryApp`, checks whether `visibility.as_deref()` matches `Some("HIDDEN")`, and returns that boolean.

**Call relations**: It is used as the filter predicate in both main-directory and workspace-directory fetch helpers.

*Call graph*: 1 external calls (matches!).


##### `directory_app_to_app_info`  (lines 413–429)

```
fn directory_app_to_app_info(app: DirectoryApp) -> AppInfo
```

**Purpose**: Converts a raw directory record into the public `AppInfo` shape used elsewhere in the system.

**Data flow**: Consumes a `DirectoryApp`, moves over its metadata fields into a new `AppInfo`, sets `install_url` to `None`, `is_accessible` to `false`, `is_enabled` to `true`, and initializes `plugin_display_names` empty.

**Call relations**: It is used during the final transformation stage in `list_all_connectors_with_options` and by tests constructing expected values.

*Call graph*: called by 1 (list_all_connectors_refreshes_when_only_directory_disk_cache_exists); 1 external calls (new).


##### `connector_install_url`  (lines 431–434)

```
fn connector_install_url(name: &str, connector_id: &str) -> String
```

**Purpose**: Builds the canonical ChatGPT app install URL for a connector name and ID.

**Data flow**: Accepts `name` and `connector_id`, derives a slug with `connector_name_slug(name)`, formats `https://chatgpt.com/apps/{slug}/{connector_id}`, and returns the resulting `String`.

**Call relations**: It is used during connector normalization when install URLs are missing and by tests verifying expected URLs.

*Call graph*: calls 1 internal fn (connector_name_slug); called by 2 (list_all_connectors_with_options, list_all_connectors_refreshes_when_only_directory_disk_cache_exists); 1 external calls (format!).


##### `connector_name_slug`  (lines 436–451)

```
fn connector_name_slug(name: &str) -> String
```

**Purpose**: Normalizes a connector name into a lowercase URL slug with non-alphanumeric characters replaced by hyphens.

**Data flow**: Iterates over `name.chars()`, appending lowercase ASCII alphanumerics directly and `-` for all other characters, trims leading and trailing hyphens from the result, and returns either that slug or the fallback string `app` if the normalized form is empty.

**Call relations**: It is the slugging primitive behind install URL generation and metadata helpers re-exported from `metadata.rs`.

*Call graph*: called by 1 (connector_install_url); 1 external calls (with_capacity).


##### `normalize_connector_name`  (lines 453–460)

```
fn normalize_connector_name(name: &str, connector_id: &str) -> String
```

**Purpose**: Ensures connector names are non-empty and trimmed before presentation.

**Data flow**: Reads `name` and `connector_id`, trims whitespace from `name`, and returns the trimmed name if non-empty or the connector ID as a fallback otherwise.

**Call relations**: It is called during final connector normalization in `list_all_connectors_with_options`.

*Call graph*: called by 1 (list_all_connectors_with_options).


##### `normalize_connector_value`  (lines 462–467)

```
fn normalize_connector_value(value: Option<&str>) -> Option<String>
```

**Purpose**: Trims optional string metadata and converts blank values to `None`.

**Data flow**: Accepts `Option<&str>`, trims the inner string when present, filters out empty results, converts the remainder to `String`, and returns `Option<String>`.

**Call relations**: It is used by `list_all_connectors_with_options` to normalize connector descriptions before caching and returning them.

*Call graph*: called by 1 (list_all_connectors_with_options).


##### `tests::cache_key`  (lines 482–489)

```
fn cache_key(id: &str) -> ConnectorDirectoryCacheKey
```

**Purpose**: Builds a deterministic test cache key from a short identifier.

**Data flow**: Formats account and user IDs from the provided `id`, passes them with a fixed base URL and `is_workspace_account = true` into `ConnectorDirectoryCacheKey::new`, and returns the key.

**Call relations**: Test helpers use it to isolate cache entries by scenario.

*Call graph*: calls 1 internal fn (new); 1 external calls (format!).


##### `tests::cache_context`  (lines 491–493)

```
fn cache_context(codex_home: &TempDir, id: &str) -> ConnectorDirectoryCacheContext
```

**Purpose**: Creates a test cache context rooted in a temporary directory.

**Data flow**: Reads the `TempDir` path, converts it to `PathBuf`, builds a key with `cache_key(id)`, constructs `ConnectorDirectoryCacheContext::new`, and returns it.

**Call relations**: Most cache-related tests call this helper before invoking fetch or cache-read functions.

*Call graph*: calls 1 internal fn (new); 2 external calls (path, cache_key).


##### `tests::clear_directory_memory_cache`  (lines 495–500)

```
fn clear_directory_memory_cache()
```

**Purpose**: Resets the global in-memory connector cache between test phases.

**Data flow**: Locks `CONNECTOR_DIRECTORY_CACHE`, recovers from poison if needed, and writes `None` into the shared cache slot.

**Call relations**: Tests call it when they need to force disk-cache behavior or avoid cross-test contamination.


##### `tests::app`  (lines 502–515)

```
fn app(id: &str, name: &str) -> DirectoryApp
```

**Purpose**: Creates a minimal `DirectoryApp` fixture for tests.

**Data flow**: Takes `id` and `name`, clones them into a `DirectoryApp`, sets all optional metadata fields to `None`, and returns the struct.

**Call relations**: It is the base fixture used across fetch, merge, and normalization tests.


##### `tests::list_all_connectors_uses_shared_directory_cache`  (lines 522–560)

```
async fn list_all_connectors_uses_shared_directory_cache() -> anyhow::Result<()>
```

**Purpose**: Verifies that a second fetch with the same cache context reuses the in-memory cache instead of calling the fetch closure again.

**Data flow**: Creates a temp cache context and atomic call counter, performs one successful `list_all_connectors_with_options` call that increments the counter, then performs a second call whose closure would fail if invoked, and asserts the counter stayed at one and both results are equal.

**Call relations**: This test exercises the `unexpired_directory_connectors_in_memory` fast path inside `list_all_connectors_with_options`.

*Call graph*: calls 1 internal fn (list_all_connectors_with_options); 6 external calls (clone, new, new, new, assert_eq!, cache_context).


##### `tests::list_all_connectors_merges_and_normalizes_directory_apps`  (lines 567–638)

```
async fn list_all_connectors_merges_and_normalizes_directory_apps() -> anyhow::Result<()>
```

**Purpose**: Checks that main and workspace directory results are merged, hidden apps are dropped, and names/descriptions/install URLs are normalized.

**Data flow**: Supplies a fetch closure that returns one main-directory page and one workspace page with overlapping `alpha` metadata plus a hidden app, invokes `list_all_connectors_with_options` with workspace enabled and forced refetch, and asserts the merged connector list has normalized names, merged description and branding, generated install URL, and excludes the hidden app.

**Call relations**: It validates the combined behavior of pagination, workspace enrichment, duplicate merging, hidden filtering, and normalization.

*Call graph*: calls 1 internal fn (list_all_connectors_with_options); 6 external calls (clone, new, new, new, assert_eq!, cache_context).


##### `tests::cached_directory_connectors_reads_directory_disk_cache`  (lines 645–677)

```
async fn cached_directory_connectors_reads_directory_disk_cache() -> anyhow::Result<()>
```

**Purpose**: Verifies that after a successful fetch is written to disk, clearing memory still allows the cache-only reader to recover the connector list from disk.

**Data flow**: Fetches connectors once through `list_all_connectors_with_options`, clears the memory cache, calls `cached_directory_connectors`, and asserts the fetch closure ran only once and the disk-loaded result matches the original.

**Call relations**: This test covers the fallback path from `cached_directory_connectors` into `directory_cache::load_cached_directory_connectors_from_disk`.

*Call graph*: calls 2 internal fn (cached_directory_connectors, list_all_connectors_with_options); 7 external calls (clone, new, new, new, assert_eq!, cache_context, clear_directory_memory_cache).


##### `tests::list_all_connectors_refreshes_when_only_directory_disk_cache_exists`  (lines 684–744)

```
async fn list_all_connectors_refreshes_when_only_directory_disk_cache_exists() -> anyhow::Result<()>
```

**Purpose**: Ensures that disk cache can be read explicitly but does not satisfy the freshness check used by the normal fetch path.

**Data flow**: Performs an initial fetch to populate caches, clears memory, confirms `cached_directory_connectors` can still read the old disk value, then calls `list_all_connectors_with_options` again with a closure returning different data and asserts a second network fetch occurred and the refreshed result reflects the new connector.

**Call relations**: It validates the subtle design where disk-loaded cache entries are repopulated into memory with zero TTL, making them readable but immediately stale for future fetch orchestration.

*Call graph*: calls 3 internal fn (connector_install_url, directory_app_to_app_info, list_all_connectors_with_options); 8 external calls (clone, new, new, new, assert_eq!, app, cache_context, clear_directory_memory_cache).


##### `tests::cached_directory_connectors_drops_stale_disk_schema`  (lines 747–766)

```
async fn cached_directory_connectors_drops_stale_disk_schema() -> anyhow::Result<()>
```

**Purpose**: Checks that a disk cache file with an outdated schema version is rejected and deleted.

**Data flow**: Creates a temp cache file manually containing `schema_version: 0`, clears memory, calls `cached_directory_connectors`, and asserts the result is `None` and the cache file no longer exists.

**Call relations**: This test exercises the schema-version invalidation branch in the disk cache loader.

*Call graph*: 9 external calls (new, assert!, assert_eq!, cache_context, clear_directory_memory_cache, json!, to_vec_pretty, create_dir_all, write).


##### `tests::list_directory_connectors_omits_tier_for_all_pages`  (lines 769–814)

```
async fn list_directory_connectors_omits_tier_for_all_pages() -> anyhow::Result<()>
```

**Purpose**: Verifies the exact request paths used for paginated directory fetches, including token encoding and absence of any tier parameter.

**Data flow**: Captures each requested path in a shared vector, runs `list_directory_connectors` with a closure that returns two pages, and asserts both the collected app IDs and the exact requested paths match expectations.

**Call relations**: It directly tests the pagination helper rather than the full orchestration path, pinning the endpoint contract.

*Call graph*: calls 1 internal fn (list_directory_connectors); 5 external calls (clone, new, new, new, assert_eq!).


### `rmcp-client/src/rmcp_client.rs`

`orchestration` · `client lifetime and request handling`

This file implements `RmcpClient`, the crate's high-level MCP client over several transport types: in-process duplex streams, local/remote stdio servers, plain streamable HTTP, and streamable HTTP wrapped with OAuth. Startup is split into constructors that capture a `TransportRecipe` and eagerly create a `PendingTransport`, leaving the client in `ClientState::Connecting`. `initialize` then builds an `ElicitationClientService`, consumes the pending transport exactly once, performs the rmcp handshake with retry support, stores `InitializeContext` for later session recovery, transitions state to `Ready`, and opportunistically persists OAuth credentials if present.

The request surface (`list_tools`, `list_resources`, `read_resource`, `call_tool`, custom request/notification methods) follows a consistent pattern: refresh OAuth if needed, run the operation through `run_service_operation`, then persist OAuth tokens afterward. `call_tool` additionally validates that `arguments` and `_meta` are JSON objects before constructing `CallToolRequestParams` and sending a raw rmcp request with peer options.

A notable subsystem is elicitation-aware timeout accounting. `ElicitationPauseState` tracks nested active elicitation requests with an atomic counter and a watch channel; `active_time_timeout` pauses timeout countdown while elicitation is pending, so user interaction does not consume operation budget. Another important subsystem is HTTP session recovery: `run_service_operation` retries transient `tools/list` transport failures, detects session-expired 404s, serializes recovery with a semaphore, recreates the transport from the stored recipe, re-runs initialization using the saved `InitializeContext`, swaps in the new `RunningService`, and retries the original operation.

`create_pending_transport` contains the transport-specific wiring. For HTTP, it merges default headers, optionally loads stored OAuth tokens when no explicit auth is configured, and either builds an OAuth-capable `AuthClient` plus `OAuthPersistor` or falls back to bearer-token auth if OAuth metadata discovery is unsupported. `create_oauth_transport_and_runtime` performs the lower-level OAuth bootstrap, including optional custom CA TLS configuration and seeding rmcp's `OAuthState` with persisted credentials.

#### Function details

##### `ElicitationPauseState::new`  (lines 147–153)

```
fn new() -> Self
```

**Purpose**: Creates the shared pause-tracking state used to suspend active-time timeout accounting while user elicitation is in progress.

**Data flow**: Creates a `watch::channel(false)` and an `AtomicUsize` initialized to zero, stores them in `ElicitationPauseState`, and returns the new state.

**Call relations**: Constructed by all `RmcpClient` constructors and by the timeout unit test. Its receivers are later consumed by `active_time_timeout`.

*Call graph*: called by 4 (new_in_process_client, new_stdio_client, new_streamable_http_client, active_time_timeout_pauses_while_elicitation_is_pending); 3 external calls (new, new, channel).


##### `ElicitationPauseState::enter`  (lines 155–162)

```
fn enter(&self) -> ElicitationPauseGuard
```

**Purpose**: Marks the beginning of an elicitation pause and returns a guard that will clear the pause when dropped. Nested pauses are reference-counted.

**Data flow**: Atomically increments `active_count`; if the previous count was zero, sends `true` on the watch channel via `send_replace`; then returns `ElicitationPauseGuard { pause_state: self.clone() }`.

**Call relations**: Called by the elicitation client service when the server asks the UI a question. The returned guard's drop implementation closes the pause interval.

*Call graph*: called by 1 (create_elicitation); 1 external calls (send_replace).


##### `ElicitationPauseState::subscribe`  (lines 164–166)

```
fn subscribe(&self) -> watch::Receiver<bool>
```

**Purpose**: Creates a watch receiver that observes whether timeout accounting should currently be paused.

**Data flow**: Reads `self.paused` and returns `self.paused.subscribe()`.

**Call relations**: Used by `run_service_operation_once` to feed pause state into `active_time_timeout`.

*Call graph*: called by 1 (run_service_operation_once); 1 external calls (subscribe).


##### `ElicitationPauseGuard::drop`  (lines 174–178)

```
fn drop(&mut self)
```

**Purpose**: Ends one active elicitation pause and resumes timeout accounting when the last nested pause exits.

**Data flow**: Atomically decrements `pause_state.active_count`; if the previous count was one, sends `false` on the watch channel with `send_replace` → returns unit.

**Call relations**: Runs automatically when the guard returned by `ElicitationPauseState::enter` is dropped.


##### `active_time_timeout`  (lines 181–225)

```
async fn active_time_timeout(
    duration: Duration,
    mut pause_state: watch::Receiver<bool>,
    operation: Fut,
) -> std::result::Result<T, ()>
```

**Purpose**: Runs an async operation under a timeout that only counts active execution time, not time spent paused for elicitation. This prevents user-response delays from causing request timeouts.

**Data flow**: Takes a total `duration`, a `watch::Receiver<bool>` pause stream, and an operation future → pins the operation, tracks `remaining` time, and loops: if paused, waits only for operation completion or pause-state changes; if unpaused, races operation completion, `time::sleep(remaining)`, and pause-state changes, subtracting elapsed active time when a pause begins; returns `Ok(operation_result)` on completion or `Err(())` on timeout.

**Call relations**: Used by `run_service_operation_once` whenever a per-operation timeout is configured, and directly by the unit test that verifies pause behavior.

*Call graph*: called by 2 (run_service_operation_once, active_time_timeout_pauses_while_elicitation_is_pending); 4 external calls (now, borrow_and_update, pin!, select!).


##### `remaining_operation_timeout`  (lines 235–252)

```
fn remaining_operation_timeout(
    label: &str,
    timeout: Option<Duration>,
    deadline: Option<Instant>,
) -> std::result::Result<Option<Duration>, ClientOperationError>
```

**Purpose**: Computes the remaining time budget for a retried operation relative to an absolute deadline. It converts an exhausted deadline into a labeled timeout error.

**Data flow**: Takes an operation `label`, the original optional timeout, and an optional absolute `deadline` → if no deadline, returns `Ok(None)`; otherwise computes `deadline - now`, returning `Err(ClientOperationError::Timeout { ... })` when zero and `Ok(Some(remaining))` otherwise.

**Call relations**: Called by `run_service_operation_with_transient_retries` before each attempt so retries share one overall timeout budget.

*Call graph*: called by 1 (run_service_operation_with_transient_retries); 1 external calls (now).


##### `ElicitationResponse::from`  (lines 266–272)

```
fn from(value: CreateElicitationResult) -> Self
```

**Purpose**: Converts rmcp's `CreateElicitationResult` into the crate-local serializable `ElicitationResponse`. It intentionally drops rmcp metadata by setting `meta` to `None`.

**Data flow**: Reads `value.action` and `value.content` from `CreateElicitationResult` → constructs `ElicitationResponse { action, content, meta: None }` → returns it.

**Call relations**: Used when translating rmcp elicitation results into the crate's callback-facing type.


##### `CreateElicitationResult::from`  (lines 276–282)

```
fn from(value: ElicitationResponse) -> Self
```

**Purpose**: Converts the crate-local `ElicitationResponse` back into rmcp's `CreateElicitationResult`. Like the reverse conversion, it discards local `_meta` by setting rmcp `meta` to `None`.

**Data flow**: Reads `value.action` and `value.content` from `ElicitationResponse` → constructs `CreateElicitationResult { action, content, meta: None }` → returns it.

**Call relations**: Used by `LoggingClientHandler::create_elicitation` when returning UI responses back to rmcp.


##### `RmcpClient::new_in_process_client`  (lines 314–332)

```
async fn new_in_process_client(
        factory: Arc<dyn InProcessTransportFactory>,
    ) -> io::Result<Self>
```

**Purpose**: Constructs an `RmcpClient` backed by an in-process transport factory. It eagerly opens the transport and leaves the client ready for later initialization.

**Data flow**: Builds `TransportRecipe::InProcess { factory }`, awaits `Self::create_pending_transport(&transport_recipe)`, maps errors to `io::Error`, and returns `RmcpClient` with `ClientState::Connecting { transport: Some(...) }`, no stdio process handle, empty initialize context, a one-permit recovery semaphore, and fresh `ElicitationPauseState`.

**Call relations**: One of the three public constructors. It delegates transport creation to `create_pending_transport`.

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

**Purpose**: Constructs an `RmcpClient` that will talk to an MCP server launched over stdio. It also captures the launched process handle so shutdown can terminate the server.

**Data flow**: Builds a `StdioServerCommand` from program/args/env/env_vars/cwd, wraps it in `TransportRecipe::Stdio`, creates the pending transport, extracts `transport.process_handle()` when the transport is stdio, and returns a client initialized in `Connecting` state with that optional process handle.

**Call relations**: Used by higher-level client creation code for local or executor-backed stdio servers. It relies on `StdioServerCommand::new` and `create_pending_transport`.

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

**Purpose**: Constructs an `RmcpClient` for streamable HTTP MCP servers, optionally with bearer-token auth, OAuth persistence, and shared auth-provider support.

**Data flow**: Packages all HTTP settings into `TransportRecipe::StreamableHttp`, awaits `create_pending_transport`, and returns a client in `Connecting` state with no stdio process handle and fresh recovery/pause state.

**Call relations**: Used by remote-client setup paths. The heavy HTTP/OAuth branching happens later inside `create_pending_transport`.

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

**Purpose**: Performs the MCP initialization handshake and transitions the client from `Connecting` to `Ready`. It also stores enough context to recreate the session later if an HTTP session expires.

**Data flow**: Takes initialization params, optional timeout, and a `SendElicitation` callback → builds `ElicitationClientService::new(params.clone(), send_elicitation, pause_state.clone())`; locks `state` and extracts the one-time pending transport or errors if already initialized/closed; calls `connect_pending_transport_with_initialize_retries`, reads peer info from the resulting service, stores `InitializeContext { timeout, client_service }`, swaps `state` to `Ready { service, oauth }` unless already closed, and if an `OAuthPersistor` exists calls `persist_if_needed()` with warning-on-error → returns the cloned `InitializeResult`.

**Call relations**: Called by client setup code after construction. It delegates handshake/retry logic to the helper in `streamable_http_retry.rs` and seeds later session recovery.

*Call graph*: calls 1 internal fn (new); called by 1 (initialize_client); 5 external calls (clone, anyhow!, matches!, clone, warn!).


##### `RmcpClient::list_tools`  (lines 471–485)

```
async fn list_tools(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListToolsResult>
```

**Purpose**: Requests the server's tool list with optional pagination and timeout, wrapping the call with OAuth refresh/persist hooks.

**Data flow**: Refreshes OAuth if present, runs `service.list_tools(params.clone())` through `run_service_operation("tools/list", timeout, ...)`, persists OAuth tokens afterward, and returns `ListToolsResult`.

**Call relations**: Public request method built on the generic operation runner. Its label is significant because retry logic treats `tools/list` specially.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::list_tools_with_connector_ids`  (lines 487–522)

```
async fn list_tools_with_connector_ids(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListToolsWithConnectorIdResult>
```

**Purpose**: Fetches the tool list and enriches each tool with connector metadata extracted from `_meta`. It normalizes multiple possible metadata key spellings.

**Data flow**: Refreshes OAuth, runs the same `tools/list` request as `list_tools`, then maps each `Tool` into `ToolWithConnectorId` by reading `tool.meta` and extracting `connector_id`, `connector_name` or `connector_display_name`, and `connector_description` or `connectorDescription` via `meta_string`; persists OAuth and returns `ListToolsWithConnectorIdResult { next_cursor, tools }`.

**Call relations**: Built on the same service operation path as `list_tools`, but adds post-processing of tool metadata before returning.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::meta_string`  (lines 524–530)

```
fn meta_string(meta: Option<&rmcp::model::Meta>, key: &str) -> Option<String>
```

**Purpose**: Extracts a non-empty trimmed string value from an rmcp metadata map. It filters out missing, non-string, and whitespace-only values.

**Data flow**: Takes `Option<&rmcp::model::Meta>` and a key → looks up the key, converts the JSON value to `&str`, trims it, rejects empty strings, and returns `Option<String>`.

**Call relations**: Used internally by `list_tools_with_connector_ids` to normalize connector metadata fields.


##### `RmcpClient::list_resources`  (lines 532–546)

```
async fn list_resources(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListResourcesResult>
```

**Purpose**: Requests the server's resource list with optional pagination and timeout, surrounding the call with OAuth refresh and persistence.

**Data flow**: Calls `refresh_oauth_if_needed`, runs `service.list_resources(params.clone())` through `run_service_operation("resources/list", timeout, ...)`, then calls `persist_oauth_tokens` and returns `ListResourcesResult`.

**Call relations**: Public request method using the generic operation runner.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::list_resource_templates`  (lines 548–562)

```
async fn list_resource_templates(
        &self,
        params: Option<PaginatedRequestParams>,
        timeout: Option<Duration>,
    ) -> Result<ListResourceTemplatesResult>
```

**Purpose**: Requests the server's resource-template list with optional pagination and timeout, with the same OAuth lifecycle hooks as other operations.

**Data flow**: Refreshes OAuth, runs `service.list_resource_templates(params.clone())` through `run_service_operation("resources/templates/list", timeout, ...)`, persists OAuth, and returns `ListResourceTemplatesResult`.

**Call relations**: Another public request method layered on the generic runner.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::read_resource`  (lines 564–578)

```
async fn read_resource(
        &self,
        params: ReadResourceRequestParams,
        timeout: Option<Duration>,
    ) -> Result<ReadResourceResult>
```

**Purpose**: Reads a specific MCP resource from the server under optional timeout control. It wraps the request with OAuth refresh/persist behavior.

**Data flow**: Refreshes OAuth, runs `service.read_resource(params.clone())` through `run_service_operation("resources/read", timeout, ...)`, persists OAuth, and returns `ReadResourceResult`.

**Call relations**: Public resource-read API built on the shared operation machinery.

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

**Purpose**: Invokes an MCP tool, validating JSON argument/meta shapes and sending the request with explicit peer request options. It returns only a `CallToolResult`, rejecting unexpected server result variants.

**Data flow**: Refreshes OAuth; validates that `arguments`, if present, is a JSON object and that `meta`, if present, is a JSON object convertible to `rmcp::model::Meta`; builds `CallToolRequestParams::new(name)` and assigns arguments; runs a closure through `run_service_operation("tools/call", timeout, ...)` that constructs `PeerRequestOptions`, sends a raw `ClientRequest::CallToolRequest` via `service.peer().send_request_with_option(...)`, awaits the response, matches `ServerResult::CallToolResult(result)`, and errors on any other variant; persists OAuth and returns the tool result.

**Call relations**: Public tool-invocation API. It uses the generic operation runner but bypasses the simpler convenience methods so it can attach `_meta` and validate the exact response variant.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation); called by 1 (call_echo_tool); 3 external calls (new, anyhow!, Meta).


##### `RmcpClient::send_custom_notification`  (lines 638–666)

```
async fn send_custom_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<()>
```

**Purpose**: Sends an arbitrary custom MCP notification to the server. It does not wait for a response because notifications are fire-and-forget.

**Data flow**: Refreshes OAuth, runs a closure through `run_service_operation("notifications/custom", None, ...)` that builds `ClientNotification::CustomNotification(CustomNotification { method, params, extensions: Extensions::new() })` and sends it with `service.send_notification(...)`, then persists OAuth and returns `Ok(())`.

**Call relations**: Public escape hatch for custom notifications, built on the same service-operation wrapper as standard methods.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::send_custom_request`  (lines 668–689)

```
async fn send_custom_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<ServerResult>
```

**Purpose**: Sends an arbitrary custom MCP request and returns the raw `ServerResult`. It is the request/response counterpart to `send_custom_notification`.

**Data flow**: Refreshes OAuth, runs a closure through `run_service_operation("requests/custom", None, ...)` that constructs `ClientRequest::CustomRequest(CustomRequest::new(method, params))` and sends it with `service.send_request(...)`, then persists OAuth and returns the resulting `ServerResult`.

**Call relations**: Public escape hatch for custom requests using the generic operation runner.

*Call graph*: calls 3 internal fn (persist_oauth_tokens, refresh_oauth_if_needed, run_service_operation).


##### `RmcpClient::service`  (lines 691–698)

```
async fn service(&self) -> Result<Arc<RunningService<RoleClient, ElicitationClientService>>>
```

**Purpose**: Returns the active `RunningService` when the client is initialized, or a descriptive error if the client is still connecting or already shut down.

**Data flow**: Locks `self.state` and matches it → clones and returns the `Arc<RunningService<...>>` from `ClientState::Ready`, or returns `anyhow!` errors for `Connecting` and `Closed`.

**Call relations**: Used by `run_service_operation` as the first step before executing any request.

*Call graph*: called by 1 (run_service_operation); 2 external calls (clone, anyhow!).


##### `RmcpClient::oauth_persistor`  (lines 700–709)

```
async fn oauth_persistor(&self) -> Option<OAuthPersistor>
```

**Purpose**: Retrieves the optional OAuth persistence runtime associated with the current ready client state.

**Data flow**: Locks `self.state` and, if it is `ClientState::Ready { oauth: Some(runtime), .. }`, clones and returns the `OAuthPersistor`; otherwise returns `None`.

**Call relations**: Used by `persist_oauth_tokens` and `refresh_oauth_if_needed` to gate OAuth-specific behavior.

*Call graph*: called by 2 (persist_oauth_tokens, refresh_oauth_if_needed).


##### `RmcpClient::shutdown`  (lines 712–725)

```
async fn shutdown(&self)
```

**Purpose**: Transitions the client to `Closed` and terminates any owned stdio server process. It is the explicit teardown path for the client runtime.

**Data flow**: Locks `state` and replaces it with `ClientState::Closed`, capturing the previous state; if `stdio_process` exists, awaits `process.terminate()` and warns on failure; then drops the previous state to release the old service/transport.

**Call relations**: Called during client teardown. It complements the process-handle drop behavior by providing an explicit async shutdown path.

*Call graph*: 2 external calls (replace, warn!).


##### `RmcpClient::persist_oauth_tokens`  (lines 729–735)

```
async fn persist_oauth_tokens(&self)
```

**Purpose**: Persists OAuth credentials after an operation in case the request triggered a token refresh or other credential change. Failures are logged but do not fail the original operation.

**Data flow**: Awaits `oauth_persistor()`, and if present awaits `runtime.persist_if_needed()`, logging a warning on error → returns unit.

**Call relations**: Called after every public request method and after initialization/session recovery paths that may have changed credentials.

*Call graph*: calls 1 internal fn (oauth_persistor); called by 8 (call_tool, list_resource_templates, list_resources, list_tools, list_tools_with_connector_ids, read_resource, send_custom_notification, send_custom_request); 1 external calls (warn!).


##### `RmcpClient::refresh_oauth_if_needed`  (lines 737–743)

```
async fn refresh_oauth_if_needed(&self)
```

**Purpose**: Refreshes OAuth credentials before an operation when the stored expiry indicates refresh is needed. Errors are logged and suppressed so request paths can continue and surface their own auth failures if necessary.

**Data flow**: Awaits `oauth_persistor()`, and if present awaits `runtime.refresh_if_needed()`, logging a warning on error → returns unit.

**Call relations**: Called before every public request method that may hit an OAuth-protected HTTP transport.

*Call graph*: calls 1 internal fn (oauth_persistor); called by 8 (call_tool, list_resource_templates, list_resources, list_tools, list_tools_with_connector_ids, read_resource, send_custom_notification, send_custom_request); 1 external calls (warn!).


##### `RmcpClient::create_pending_transport`  (lines 745–852)

```
async fn create_pending_transport(
        transport_recipe: &TransportRecipe,
    ) -> Result<PendingTransport>
```

**Purpose**: Builds the transport object corresponding to the stored recipe, including stdio launch, in-process opening, plain HTTP setup, and OAuth-aware HTTP setup with persisted-token bootstrap.

**Data flow**: Matches `transport_recipe`: for `InProcess`, awaits `factory.open()` and wraps it; for `Stdio`, awaits `launcher.launch(command.clone())`; for `StreamableHttp`, builds merged default headers, conditionally loads stored OAuth tokens only when no explicit bearer token/auth provider/authorization header is present, and then either (a) creates an OAuth transport plus `OAuthPersistor` via `create_oauth_transport_and_runtime`, (b) falls back to plain bearer-token HTTP transport if OAuth metadata discovery reports `AuthError::NoAuthorizationSupport`, using the stored access token as `auth_header`, or (c) builds a plain `StreamableHttpClientTransport` with optional explicit bearer token and optional shared auth provider.

**Call relations**: Called by all constructors and by session recovery/retry code when a fresh transport is needed. It is the main transport-factory switch for the client.

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

**Purpose**: Consumes a pending transport, starts rmcp's client service over it, applies an optional handshake timeout, and returns the running service plus any OAuth persistor. On handshake failure it still tries to persist OAuth state.

**Data flow**: Matches `PendingTransport` to choose `service::serve_client(client_service, transport)` and optional `OAuthPersistor`; if `timeout` is set, wraps the handshake future in `time::timeout`, otherwise awaits directly; maps rmcp initialize failures into `HandshakeError`; on handshake error, if an OAuth runtime exists calls `persist_if_needed()` and warns on failure, then returns the error; on success wraps the service in `Arc` and returns `(service, oauth_persistor)`.

**Call relations**: Called by initialization and by the retry helper in `streamable_http_retry.rs`. It is the one-shot handshake executor for an already-created transport.

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

**Purpose**: Executes a service operation with transient retry handling and automatic session-expiry recovery for HTTP transports. It is the common wrapper behind all request methods.

**Data flow**: Obtains the current service via `self.service().await`, then calls `run_service_operation_with_transient_retries(...)`; if that succeeds, returns the result; if it fails with a session-expired 404 as detected by `is_session_expired_404`, calls `reinitialize_after_session_expiry(&service)`, fetches the replacement service, reruns the operation with retries, and returns that result; otherwise converts the operation error into `anyhow::Error`.

**Call relations**: Used by every public request/notification method. It delegates retry classification to helper methods and recovery to `reinitialize_after_session_expiry`.

*Call graph*: calls 2 internal fn (reinitialize_after_session_expiry, service); called by 8 (call_tool, list_resource_templates, list_resources, list_tools, list_tools_with_connector_ids, read_resource, send_custom_notification, send_custom_request); 4 external calls (clone, is_session_expired_404, run_service_operation_with_transient_retries, clone).


##### `RmcpClient::run_service_operation_with_transient_retries`  (lines 952–1006)

```
async fn run_service_operation_with_transient_retries(
        service: Arc<RunningService<RoleClient, ElicitationClientService>>,
        label: &str,
        timeout: Option<Duration>,
        pause
```

**Purpose**: Retries selected transient operation failures within a shared timeout budget, currently only for `tools/list` over streamable HTTP. It logs each retry attempt with delay and error details.

**Data flow**: Computes an absolute retry deadline from `timeout`, iterates over `STREAMABLE_HTTP_RETRY_DELAYS_MS` plus one final no-delay terminal attempt, computes per-attempt remaining timeout with `remaining_operation_timeout`, runs the operation once via `run_service_operation_once`, and on retryable `tools/list` errors sleeps with `sleep_with_retry_deadline`; returns the first success, the final non-retryable error, or a timeout error if the deadline expires during backoff.

**Call relations**: Called by `run_service_operation`. It delegates single-attempt execution to `run_service_operation_once` and retry classification to `is_retryable_tools_list_error`.

*Call graph*: calls 2 internal fn (remaining_operation_timeout, sleep_with_retry_deadline); 8 external calls (clone, from_millis, is_retryable_tools_list_error, run_service_operation_once, clone, once, unreachable!, warn!).


##### `RmcpClient::run_service_operation_once`  (lines 1008–1031)

```
async fn run_service_operation_once(
        service: Arc<RunningService<RoleClient, ElicitationClientService>>,
        label: &str,
        timeout: Option<Duration>,
        pause_state: Elicitatio
```

**Purpose**: Runs one service operation attempt, optionally under elicitation-aware timeout control. It converts rmcp service errors into the local `ClientOperationError` type.

**Data flow**: If `timeout` is `Some(duration)`, subscribes to pause state and awaits `active_time_timeout(duration, pause_state.subscribe(), operation(service))`, mapping timeout to `ClientOperationError::Timeout` and inner service errors to `ClientOperationError::Service`; if no timeout, simply awaits `operation(service)` and maps the error type.

**Call relations**: Called by the transient-retry loop for each attempt.

*Call graph*: calls 2 internal fn (subscribe, active_time_timeout).


##### `RmcpClient::is_retryable_tools_list_error`  (lines 1033–1047)

```
fn is_retryable_tools_list_error(label: &str, error: &ClientOperationError) -> bool
```

**Purpose**: Identifies the narrow class of operation failures that should trigger a retry for `tools/list`. It only considers transport-send failures carrying retryable streamable HTTP errors.

**Data flow**: Checks that `label == "tools/list"`, pattern-matches `ClientOperationError::Service(ServiceError::TransportSend(error))`, downcasts the dynamic transport error to `StreamableHttpError<StreamableHttpClientAdapterError>`, and delegates to `is_retryable_streamable_http_error` → returns `bool`.

**Call relations**: Used by `run_service_operation_with_transient_retries` to decide whether to back off and retry.


##### `RmcpClient::is_session_expired_404`  (lines 1049–1067)

```
fn is_session_expired_404(error: &ClientOperationError) -> bool
```

**Purpose**: Detects the specific transport error that means the HTTP session expired and the client should recreate the transport and reinitialize. It looks for the adapter's synthetic `SessionExpired404` marker.

**Data flow**: Pattern-matches `ClientOperationError::Service(ServiceError::TransportSend(error))`, downcasts to `StreamableHttpError<StreamableHttpClientAdapterError>`, and returns true only for `StreamableHttpError::Client(StreamableHttpClientAdapterError::SessionExpired404)`.

**Call relations**: Used by `run_service_operation` to trigger session recovery after a failed request.


##### `RmcpClient::reinitialize_after_session_expiry`  (lines 1069–1128)

```
async fn reinitialize_after_session_expiry(
        &self,
        failed_service: &Arc<RunningService<RoleClient, ElicitationClientService>>,
    ) -> Result<()>
```

**Purpose**: Serializes and performs session recovery after an HTTP session-expired error by recreating the transport, rerunning initialization, and swapping in the new service. It avoids duplicate recovery when another task already replaced the service.

**Data flow**: Acquires `session_recovery_lock`; checks current `state`, returning early if another recovery already replaced the failed service, or errors if not ready/closed; clones the stored `InitializeContext`, creates a fresh pending transport from `self.transport_recipe`, reconnects with `connect_pending_transport_with_initialize_retries`, swaps `state` to `Ready { service, oauth }` unless closed, and persists OAuth if present with warning-on-error → returns `Result<()>`.

**Call relations**: Called only by `run_service_operation` after `is_session_expired_404` matches. It reuses the same initialization parameters captured by `initialize`.

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

**Purpose**: Builds an OAuth-capable streamable HTTP transport seeded with previously stored credentials, along with the `OAuthPersistor` that will keep those credentials synchronized. It is the low-level OAuth bootstrap helper for HTTP client creation.

**Data flow**: Takes server identity, URL, initial stored tokens, storage settings, default headers, and shared HTTP client → builds a reqwest client builder with `apply_default_headers`, optionally installs a custom rustls TLS config, creates `OAuthState::new(url, Some(oauth_metadata_client))`, seeds it with `set_credentials(&initial_tokens.client_id, initial_tokens.token_response.0.clone())`, extracts the underlying authorization manager from `OAuthState::Authorized` or `Unauthorized`, constructs `AuthClient` over `StreamableHttpClientAdapter::new(http_client, default_headers, None)`, clones its `auth_manager`, builds `StreamableHttpClientTransport::with_client(...)`, constructs `OAuthPersistor::new(...)` with `Some(initial_tokens)`, and returns `(transport, runtime)`.

**Call relations**: Called by `RmcpClient::create_pending_transport` when stored OAuth tokens are available and no explicit auth configuration overrides them.

*Call graph*: calls 3 internal fn (new, new, apply_default_headers); called by 1 (create_pending_transport); 7 external calls (new, new, with_client, with_uri, anyhow!, builder, maybe_build_rustls_client_config_with_custom_ca).


##### `tests::active_time_timeout_pauses_while_elicitation_is_pending`  (lines 1202–1218)

```
async fn active_time_timeout_pauses_while_elicitation_is_pending()
```

**Purpose**: Verifies that `active_time_timeout` does not count time spent in an elicitation pause against the timeout budget. The operation takes longer than the nominal timeout but still succeeds because most of that time is paused.

**Data flow**: Creates `ElicitationPauseState`, enters a pause and spawns a task to drop it after 75 ms, then runs `active_time_timeout` with a 50 ms budget around an operation that sleeps 90 ms and returns `"done"`; asserts the result is `Ok("done")`.

**Call relations**: Direct unit test for the pause-aware timeout mechanism used by `run_service_operation_once`.

*Call graph*: calls 2 internal fn (new, active_time_timeout); 4 external calls (from_millis, assert_eq!, sleep, spawn).


### `chatgpt/src/workspace_settings.rs`

`domain_logic` · `workspace feature gating during app/plugin checks`

This file implements a focused feature gate around the workspace setting `enable_plugins`. `WorkspaceSettingsResponse` models the backend payload as a `beta_settings: HashMap<String, bool>`. `WorkspaceSettingsCache` stores at most one cached entry behind an `RwLock<Option<CachedWorkspaceSettings>>`, keyed by `chatgpt_base_url` and `account_id`, with a 15-minute TTL. The cache methods are careful about poisoned locks: both read and write paths recover with `into_inner()` rather than propagating poisoning.

`get_codex_plugins_enabled` first takes a read lock and returns the cached boolean only if the key matches and the entry has not expired. If that fast path misses, it upgrades to a write lock and clears stale or mismatched entries before returning `None`. `set_codex_plugins_enabled` writes a fresh entry with `expires_at = Instant::now() + TTL`.

The main async function, `codex_plugins_enabled_for_workspace`, is intentionally permissive. It returns `true` without any network call when auth is absent, not ChatGPT auth, not a workspace account, or lacks a non-empty account id. Only for workspace ChatGPT accounts does it consult the cache, percent-encode the account id with `encode_path_segment`, fetch `/accounts/{encoded_account_id}/settings` with a 10-second timeout, and read `beta_settings["enable_plugins"]`, defaulting missing settings to `true`. Successful fetches are cached when a cache instance is supplied.

#### Function details

##### `WorkspaceSettingsCache::get_codex_plugins_enabled`  (lines 41–68)

```
fn get_codex_plugins_enabled(&self, key: &WorkspaceSettingsCacheKey) -> Option<bool>
```

**Purpose**: Looks up a cached workspace plugin-enabled flag for a specific backend/account key and evicts stale or mismatched entries. It provides the cache read path with TTL enforcement.

**Data flow**: It takes `&self` and a `WorkspaceSettingsCacheKey`. It first acquires a read lock on `self.entry`, recovering from poisoning if necessary, gets `Instant::now()`, and returns `Some(cached.codex_plugins_enabled)` only when an entry exists, has not expired, and its key equals the requested key. On a miss, it acquires a write lock, recomputes `now`, clears the stored entry if it is expired or keyed for a different workspace, and returns `None`.

**Call relations**: Called by `codex_plugins_enabled_for_workspace` before making a network request. It is the fast path that can avoid backend I/O when a fresh matching cache entry exists.

*Call graph*: 1 external calls (now).


##### `WorkspaceSettingsCache::set_codex_plugins_enabled`  (lines 70–80)

```
fn set_codex_plugins_enabled(&self, key: WorkspaceSettingsCacheKey, enabled: bool)
```

**Purpose**: Stores a fresh cached workspace plugin-enabled flag with a fixed expiration time. It is the cache write path after a successful backend fetch.

**Data flow**: It takes ownership of a `WorkspaceSettingsCacheKey` and a boolean `enabled`, acquires a write lock on `self.entry` with poison recovery, and replaces the entry with `Some(CachedWorkspaceSettings { key, expires_at: Instant::now() + WORKSPACE_SETTINGS_CACHE_TTL, codex_plugins_enabled: enabled })`.

**Call relations**: Called by `codex_plugins_enabled_for_workspace` after it successfully reads the workspace settings endpoint and computes the effective plugin-enabled value.

*Call graph*: 1 external calls (now).


##### `codex_plugins_enabled_for_workspace`  (lines 83–132)

```
async fn codex_plugins_enabled_for_workspace(
    config: &Config,
    auth: Option<&CodexAuth>,
    cache: Option<&WorkspaceSettingsCache>,
) -> anyhow::Result<bool>
```

**Purpose**: Determines whether Codex plugins are enabled for the current workspace account, using a cache when available and falling back to the ChatGPT workspace settings endpoint. It defaults to enabled in all cases where the setting is not applicable or unavailable.

**Data flow**: It takes `&Config`, `Option<&CodexAuth>`, and an optional cache reference. It returns `Ok(true)` immediately if auth is absent, not ChatGPT auth, not a workspace account, or lacks a non-empty account id. Otherwise it builds a `WorkspaceSettingsCacheKey` from `config.chatgpt_base_url` and the account id, checks `cache.get_codex_plugins_enabled(&cache_key)` if a cache is provided, and returns the cached value on hit. On miss, it percent-encodes the account id with `encode_path_segment`, fetches `WorkspaceSettingsResponse` from `/accounts/{encoded_account_id}/settings` via `chatgpt_get_request_with_timeout` using `WORKSPACE_SETTINGS_TIMEOUT`, reads `beta_settings["enable_plugins"]` with a default of `true`, optionally stores that boolean in the cache, and returns it.

**Call relations**: Called by workspace plugin gating code elsewhere in the crate. It orchestrates the full decision flow, delegating URL-safe account-id encoding to `encode_path_segment`, transport to `chatgpt_get_request_with_timeout`, and cache operations to `WorkspaceSettingsCache` methods.

*Call graph*: calls 2 internal fn (chatgpt_get_request_with_timeout, encode_path_segment); called by 3 (workspace_codex_plugins_enabled, workspace_codex_plugins_enabled, workspace_codex_plugins_enabled); 1 external calls (format!).


##### `encode_path_segment`  (lines 134–144)

```
fn encode_path_segment(value: &str) -> String
```

**Purpose**: Percent-encodes a string for safe use as a single URL path segment. It preserves RFC 3986 unreserved characters and escapes everything else as uppercase hex bytes.

**Data flow**: It takes `&str`, creates an empty `String`, iterates over the input bytes, appends the byte as a character when it is ASCII alphanumeric or one of `- . _ ~`, otherwise appends `format!("%{byte:02X}")`. It returns the encoded string.

**Call relations**: Used only by `codex_plugins_enabled_for_workspace` when constructing the `/accounts/{id}/settings` path. It ensures account ids containing reserved characters do not break the request URL.

*Call graph*: called by 1 (codex_plugins_enabled_for_workspace); 3 external calls (new, format!, matches!).


### `chatgpt/src/connectors.rs`

`domain_logic` · `connector discovery and plugin/app listing`

This file is the connector orchestration layer for ChatGPT-backed app integrations. It first gates all connector work behind `apps_enabled`, which derives feature availability from config plus the current auth mode, and `connector_auth`, which requires a Codex-backend ChatGPT auth session. The public listing functions then build on those checks.

`list_connectors` is the broadest view: if apps are enabled, it concurrently fetches the full connector directory and the subset accessible through MCP tools, then merges them with `merge_connectors_with_accessible` and annotates enabled state via `with_app_enabled_state`. `list_all_connectors` is a simple wrapper over `list_all_connectors_with_options`. The cache-aware `list_cached_all_connectors` computes a `ConnectorDirectoryCacheContext` from `codex_home`, base URL, account id, ChatGPT user id, and workspace flag, then reads cached directory connectors and merges plugin apps into them. `list_all_connectors_with_options` performs the same context construction but delegates to `codex_connectors::list_all_connectors_with_options`, supplying a closure that fetches `DirectoryListResponse` pages from the ChatGPT backend with a 60-second timeout.

The merge helpers encode important policy. `merge_and_filter_plugin_connectors` injects plugin connector ids into the directory list and removes disallowed connectors based on the current originator. `connectors_for_plugin_apps` goes further by preserving plugin request order and deduplicating by removing from a map keyed by connector id. `merge_connectors_with_accessible` optionally drops accessible connectors that are not present in the full directory once all connectors are known, preventing transient accessible-only entries from surviving after the full load completes. Tests cover these subtle ordering and filtering rules.

#### Function details

##### `apps_enabled`  (lines 29–36)

```
async fn apps_enabled(config: &Config) -> bool
```

**Purpose**: Determines whether app/connector features should be considered enabled for the current configuration and auth mode. It folds auth-derived backend information into the feature flag check.

**Data flow**: It takes `&Config`, obtains a shared `AuthManager`, awaits the optional auth, computes whether that auth exists and uses the Codex backend, and passes that boolean into `config.features.apps_enabled_for_auth(...)`. It returns the resulting `bool`.

**Call relations**: Called at the start of `list_connectors`, `list_cached_all_connectors`, and `list_all_connectors_with_options` to short-circuit connector work when apps are disabled.

*Call graph*: calls 1 internal fn (shared_from_config); called by 3 (list_all_connectors_with_options, list_cached_all_connectors, list_connectors).


##### `connector_auth`  (lines 38–50)

```
async fn connector_auth(config: &Config) -> anyhow::Result<CodexAuth>
```

**Purpose**: Fetches the current auth session and enforces that it is suitable for ChatGPT connector operations. It centralizes the auth preconditions for connector directory access.

**Data flow**: It takes `&Config`, obtains `AuthManager::shared_from_config`, awaits `auth_manager.auth()`, errors if auth is missing, ensures `auth.uses_codex_backend()` is true, and returns the `CodexAuth` on success.

**Call relations**: Used by both `list_cached_all_connectors` and `list_all_connectors_with_options` after `apps_enabled` passes. Those callers rely on it before constructing cache keys or making backend requests.

*Call graph*: calls 1 internal fn (shared_from_config); called by 2 (list_all_connectors_with_options, list_cached_all_connectors); 1 external calls (ensure!).


##### `list_connectors`  (lines 52–68)

```
async fn list_connectors(config: &Config) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Returns the merged connector view used by the app layer, combining the full directory with currently accessible connectors and enabled-state annotations. It is the highest-level connector listing API in this file.

**Data flow**: It takes `&Config`, first awaits `apps_enabled`; if false, it returns an empty vector. Otherwise it concurrently runs `list_all_connectors(config)` and `list_accessible_connectors_from_mcp_tools(config)` with `tokio::join!`, propagates either error, merges the two successful lists with `merge_connectors_with_accessible(..., true)`, wraps the result with `with_app_enabled_state(..., config)`, and returns the final `Vec<AppInfo>`.

**Call relations**: This function orchestrates the main connector listing flow. It delegates directory retrieval to `list_all_connectors`, accessibility discovery to the re-exported MCP helper, and final reconciliation to `merge_connectors_with_accessible`.

*Call graph*: calls 3 internal fn (apps_enabled, merge_connectors_with_accessible, with_app_enabled_state); 2 external calls (new, join!).


##### `list_all_connectors`  (lines 70–72)

```
async fn list_all_connectors(config: &Config) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Fetches the full connector directory using default options. It is a convenience wrapper that disables forced refetch and supplies no plugin apps.

**Data flow**: It takes `&Config`, calls `list_all_connectors_with_options(config, false, &[])`, awaits the result, and returns the resulting `Vec<AppInfo>` or error.

**Call relations**: Called by `list_connectors` as the directory half of the merged listing flow. It exists to simplify callers that do not need plugin-app injection or cache-bypass control.

*Call graph*: calls 1 internal fn (list_all_connectors_with_options).


##### `list_cached_all_connectors`  (lines 74–86)

```
async fn list_cached_all_connectors(
    config: &Config,
    plugin_apps: &[AppConnectorId],
) -> Option<Vec<AppInfo>>
```

**Purpose**: Reads the cached connector directory for the current account and merges plugin connectors into it without performing network I/O. It returns `None` when auth or cache lookup is unavailable.

**Data flow**: It takes `&Config` and a slice of `AppConnectorId`. If `apps_enabled` is false, it returns `Some(Vec::new())`. Otherwise it obtains connector auth with `connector_auth(config).await.ok()?`, builds a cache context with `connector_directory_cache_context`, reads cached connectors via `codex_connectors::cached_directory_connectors(&cache_context)?`, merges and filters plugin connectors with `merge_and_filter_plugin_connectors`, and wraps the result in `Some`.

**Call relations**: Used by plugin-install and plugin-summary flows that prefer cached data. It depends on `apps_enabled`, `connector_auth`, and `connector_directory_cache_context` before delegating final list shaping to `merge_and_filter_plugin_connectors`.

*Call graph*: calls 4 internal fn (apps_enabled, connector_auth, connector_directory_cache_context, merge_and_filter_plugin_connectors); called by 3 (plugin_apps_needing_auth_for_install, remote_plugin_install_response, load_plugin_app_summaries); 2 external calls (new, cached_directory_connectors).


##### `list_all_connectors_with_options`  (lines 88–113)

```
async fn list_all_connectors_with_options(
    config: &Config,
    force_refetch: bool,
    plugin_apps: &[AppConnectorId],
) -> anyhow::Result<Vec<AppInfo>>
```

**Purpose**: Fetches the full connector directory with explicit cache/refetch and plugin-app options. It is the configurable network-backed connector listing path.

**Data flow**: It takes `&Config`, `force_refetch: bool`, and plugin app ids. If `apps_enabled` is false, it returns an empty vector. Otherwise it gets validated auth via `connector_auth`, builds a cache context, and calls `codex_connectors::list_all_connectors_with_options(cache_context, auth.is_workspace_account(), force_refetch, |path| async move { chatgpt_get_request_with_timeout::<DirectoryListResponse>(config, path, Some(DIRECTORY_CONNECTORS_TIMEOUT)).await })`. After awaiting the connector list, it merges and filters plugin connectors and returns the final `Vec<AppInfo>`.

**Call relations**: Called by `list_all_connectors`, `apps_list_response`, and plugin summary loaders. It orchestrates auth, cache-key construction, backend fetching, and plugin connector injection.

*Call graph*: calls 4 internal fn (apps_enabled, connector_auth, connector_directory_cache_context, merge_and_filter_plugin_connectors); called by 3 (apps_list_response, load_plugin_app_summaries, list_all_connectors); 2 external calls (new, list_all_connectors_with_options).


##### `connector_directory_cache_context`  (lines 115–128)

```
fn connector_directory_cache_context(
    config: &Config,
    auth: &CodexAuth,
) -> ConnectorDirectoryCacheContext
```

**Purpose**: Builds the cache context used to store and retrieve connector directory data for a specific backend/account combination. It ensures cache entries are partitioned by both server and user identity.

**Data flow**: It takes `&Config` and `&CodexAuth`, clones `config.codex_home` into a `PathBuf`, constructs a `ConnectorDirectoryCacheKey` from `config.chatgpt_base_url.clone()`, `auth.get_account_id()`, `auth.get_chatgpt_user_id()`, and `auth.is_workspace_account()`, then wraps both in `ConnectorDirectoryCacheContext::new(...)` and returns it.

**Call relations**: Used by both `list_cached_all_connectors` and `list_all_connectors_with_options`. Those callers rely on this helper so cache reads and writes use the same identity keying scheme.

*Call graph*: calls 5 internal fn (new, new, get_account_id, get_chatgpt_user_id, is_workspace_account); called by 2 (list_all_connectors_with_options, list_cached_all_connectors).


##### `merge_and_filter_plugin_connectors`  (lines 130–141)

```
fn merge_and_filter_plugin_connectors(
    connectors: Vec<AppInfo>,
    plugin_apps: &[AppConnectorId],
) -> Vec<AppInfo>
```

**Purpose**: Adds plugin-declared connectors to a connector list and removes connectors disallowed for the current originator. It is the common post-processing step for directory results.

**Data flow**: It takes a `Vec<AppInfo>` and plugin app ids, calls `merge_plugin_connectors` with the existing connectors plus an iterator of cloned plugin connector id strings, then passes the merged list through `filter_disallowed_connectors(..., originator().value.as_str())`. It returns the filtered `Vec<AppInfo>`.

**Call relations**: Called by both `list_cached_all_connectors` and `list_all_connectors_with_options` after obtaining directory connectors. It encapsulates the shared plugin-injection and policy-filtering logic.

*Call graph*: calls 3 internal fn (filter_disallowed_connectors, merge_plugin_connectors, originator); called by 2 (list_all_connectors_with_options, list_cached_all_connectors); 1 external calls (iter).


##### `connectors_for_plugin_apps`  (lines 143–163)

```
fn connectors_for_plugin_apps(
    connectors: Vec<AppInfo>,
    plugin_apps: &[AppConnectorId],
) -> Vec<AppInfo>
```

**Purpose**: Produces the subset of connectors corresponding to a requested plugin-app list, preserving plugin request order and excluding disallowed connectors. It is tailored for plugin-centric flows rather than full directory listing.

**Data flow**: It takes connectors and plugin app ids, first merges plugin connectors into the list, filters disallowed connectors using the current originator, then collects the remaining connectors into a `HashMap` keyed by connector id. It iterates `plugin_apps` in order, removes matching entries from the map by id, and collects the removed connectors into the output vector. Duplicate plugin ids therefore yield at most one connector because the first removal consumes the map entry.

**Call relations**: Used by plugin-install and plugin-summary code paths, and directly exercised by tests. It shares the same merge/filter primitives as `merge_and_filter_plugin_connectors` but adds ordering and deduplication semantics specific to plugin requests.

*Call graph*: calls 3 internal fn (filter_disallowed_connectors, merge_plugin_connectors, originator); called by 5 (plugin_apps_needing_auth_for_install, remote_plugin_install_response, load_plugin_app_summaries, connectors_for_plugin_apps_filters_disallowed_plugin_apps, connectors_for_plugin_apps_returns_only_requested_plugin_apps); 1 external calls (iter).


##### `merge_connectors_with_accessible`  (lines 165–184)

```
fn merge_connectors_with_accessible(
    connectors: Vec<AppInfo>,
    accessible_connectors: Vec<AppInfo>,
    all_connectors_loaded: bool,
) -> Vec<AppInfo>
```

**Purpose**: Combines the full connector directory with the set of accessible connectors, optionally dropping accessible-only entries once the full directory is known to be complete. It reconciles two partially overlapping connector sources into one filtered list.

**Data flow**: It takes `connectors`, `accessible_connectors`, and `all_connectors_loaded`. If `all_connectors_loaded` is true, it builds a `HashSet<&str>` of ids from `connectors` and filters `accessible_connectors` down to ids present in that set; otherwise it keeps the accessible list unchanged. It then calls `merge_connectors(connectors, accessible_connectors)` and filters the merged result with `filter_disallowed_connectors(..., originator().value.as_str())`, returning the final vector.

**Call relations**: Called by `list_connectors` and by tests, and also by higher-level merge code elsewhere. It is the key reconciliation step between directory data and MCP accessibility data.

*Call graph*: calls 3 internal fn (filter_disallowed_connectors, merge_connectors, originator); called by 4 (merge_loaded_apps, list_connectors, excludes_accessible_connectors_not_in_all_when_all_loaded, keeps_accessible_connectors_not_in_all_while_all_loading).


##### `tests::app`  (lines 193–209)

```
fn app(id: &str) -> AppInfo
```

**Purpose**: Constructs a minimal `AppInfo` test fixture with the given id and defaulted optional fields. It simplifies connector-list test setup.

**Data flow**: It takes an id string and returns an `AppInfo` whose `id` and `name` are that string, optional metadata fields are `None`, `is_accessible` is `false`, `is_enabled` is `true`, and `plugin_display_names` is empty.

**Call relations**: Used by all connector tests as the base fixture constructor for directory and accessible connector lists.

*Call graph*: 1 external calls (new).


##### `tests::merged_app`  (lines 211–227)

```
fn merged_app(id: &str, is_accessible: bool) -> AppInfo
```

**Purpose**: Constructs an `AppInfo` fixture representing the expected merged connector shape, including an install URL and configurable accessibility flag. It mirrors the post-merge output expected from connector helpers.

**Data flow**: It takes an id string and `is_accessible: bool`, builds an `AppInfo` similar to `tests::app`, but sets `install_url` using `connector_install_url(id, id)` and sets `is_accessible` to the provided value.

**Call relations**: Used by tests that assert exact merged connector outputs from `merge_connectors_with_accessible` and `connectors_for_plugin_apps`.

*Call graph*: calls 1 internal fn (connector_install_url); 1 external calls (new).


##### `tests::excludes_accessible_connectors_not_in_all_when_all_loaded`  (lines 230–237)

```
fn excludes_accessible_connectors_not_in_all_when_all_loaded()
```

**Purpose**: Verifies that accessible connectors absent from the full directory are dropped once the full directory is considered complete. It protects the `all_connectors_loaded = true` filtering rule.

**Data flow**: It builds one full connector (`alpha`) and two accessible connectors (`alpha`, `beta`), calls `merge_connectors_with_accessible(..., true)`, and asserts the result contains only merged `alpha` marked accessible.

**Call relations**: This test directly exercises `merge_connectors_with_accessible`’s branch that filters accessible-only ids when all connectors have loaded.

*Call graph*: calls 1 internal fn (merge_connectors_with_accessible); 2 external calls (assert_eq!, vec!).


##### `tests::keeps_accessible_connectors_not_in_all_while_all_loading`  (lines 240–253)

```
fn keeps_accessible_connectors_not_in_all_while_all_loading()
```

**Purpose**: Verifies that accessible connectors not yet present in the full directory are retained while the full directory is still loading. It protects the transitional merge behavior for incomplete directory loads.

**Data flow**: It builds the same `alpha`/`beta` fixture sets as the previous test, calls `merge_connectors_with_accessible(..., false)`, and asserts the result contains both merged `alpha` and merged `beta`, each marked accessible.

**Call relations**: This test covers the opposite branch of `merge_connectors_with_accessible`, ensuring accessible-only connectors survive when `all_connectors_loaded` is false.

*Call graph*: calls 1 internal fn (merge_connectors_with_accessible); 2 external calls (assert_eq!, vec!).


##### `tests::connectors_for_plugin_apps_returns_only_requested_plugin_apps`  (lines 256–269)

```
fn connectors_for_plugin_apps_returns_only_requested_plugin_apps()
```

**Purpose**: Checks that plugin-app connector selection returns only the requested plugin connectors, in plugin request order, with duplicates collapsed by first removal. It also verifies plugin connector synthesis for ids not already in the connector list.

**Data flow**: It builds connectors `alpha` and `beta`, requests plugin apps `[gmail, alpha, gmail]`, calls `connectors_for_plugin_apps`, and asserts the result is `[merged gmail inaccessible, alpha]`.

**Call relations**: This test directly exercises `connectors_for_plugin_apps`’s merge, filter, ordering, and deduplication behavior.

*Call graph*: calls 1 internal fn (connectors_for_plugin_apps); 3 external calls (assert_eq!, new, vec!).


##### `tests::connectors_for_plugin_apps_filters_disallowed_plugin_apps`  (lines 272–280)

```
fn connectors_for_plugin_apps_filters_disallowed_plugin_apps()
```

**Purpose**: Ensures that plugin connectors disallowed by originator-based filtering are removed entirely. It validates that policy filtering applies even to plugin-synthesized connectors.

**Data flow**: It calls `connectors_for_plugin_apps` with an empty connector list and a single disallowed plugin id, then asserts the returned vector is empty.

**Call relations**: This test covers the filtering stage inside `connectors_for_plugin_apps`, specifically for plugin-only inputs.

*Call graph*: calls 1 internal fn (connectors_for_plugin_apps); 3 external calls (new, assert_eq!, new).


### Startup content refreshes
These files synchronize curated plugin content and expose a focused backend task fetch used during startup-adjacent remote preparation flows.

### `core-plugins/src/startup_sync.rs`

`orchestration` · `startup`

This file implements the full startup-time acquisition and activation path for the curated plugins repository stored under `.tmp/plugins`, along with the companion SHA file `.tmp/plugins.sha`. Its top-level sync routine serializes concurrent sync attempts with a filesystem lock file, then tries three transports in order: direct git, GitHub API + zipball, and a public backup export archive. Each transport stages content into a temporary sibling directory, validates that `.agents/plugins/marketplace.json` exists, atomically swaps the staged tree into place, and writes the resolved version string to the SHA file.

The git path is optimized for incremental refresh: it first resolves the remote HEAD SHA, compares it against either the local git HEAD or the saved SHA file, and skips work if the repository already matches and still has a `.git` directory. When replacing an existing checkout, activation renames the old repo aside into a temporary backup and rolls back if the final rename fails. Temporary clone directories are cleaned up opportunistically when older than ten minutes to avoid buildup from interrupted runs.

The HTTP paths build a single-threaded Tokio runtime on demand, use a shared reqwest client builder, and parse small JSON summaries from GitHub or the backup archive metadata endpoint. Zip extraction strips the top-level archive directory, rejects path-escaping entries via `enclosed_name`, recreates directories/files, and restores Unix permissions when available. The backup archive path additionally tries to recover a git SHA from the extracted `.git` metadata, but falls back to a fixed `export-backup` marker if unavailable. Metrics are emitted for each attempted transport and for the final outcome, and warnings preserve detailed failure context across fallback transitions.

#### Function details

##### `curated_plugins_repo_path`  (lines 58–60)

```
fn curated_plugins_repo_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the canonical filesystem location of the curated plugins snapshot under the Codex home directory. This is the root directory used by all sync and lookup code.

**Data flow**: Takes `codex_home: &Path` and appends the constant relative segment `.tmp/plugins`, returning a `PathBuf`. It does not read or write filesystem state.

**Call relations**: Used broadly by sync logic and downstream readers that need the curated repository root; other path helpers and snapshot checks derive their locations from this path.

*Call graph*: called by 34 (does_not_expand_local_plugins_by_installed_apps, does_not_expand_local_sales_apps, does_not_read_local_plugins_for_loaded_apps, does_not_reload_marketplace_per_plugin, ignores_missing_marketplace_plugin, includes_openai_curated_when_remote_enabled, normalizes_description, omits_installed_curated_plugins, omits_not_available_curated_plugins, returns_api_curated_fallback_plugins_for_direct_provider_auth (+15 more)); 1 external calls (join).


##### `curated_plugins_api_marketplace_path`  (lines 62–64)

```
fn curated_plugins_api_marketplace_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the path to the curated API marketplace manifest JSON inside the synced repository tree. It points specifically at `.agents/plugins/api_marketplace.json`.

**Data flow**: Accepts `codex_home`, derives the repo root via `curated_plugins_repo_path`, appends the manifest-relative path, and returns the resulting `PathBuf`.

**Call relations**: Invoked by callers that need the API marketplace file location after startup sync has populated the curated repository.

*Call graph*: calls 1 internal fn (curated_plugins_repo_path); called by 1 (marketplace_roots).


##### `read_curated_plugins_sha`  (lines 66–68)

```
fn read_curated_plugins_sha(codex_home: &Path) -> Option<String>
```

**Purpose**: Reads the saved version marker for the curated plugins snapshot from disk. The value is the fetched git SHA or the backup archive fallback version string.

**Data flow**: Takes `codex_home`, derives the SHA file path with `curated_plugins_sha_path`, reads and trims the file through `read_sha_file`, and returns `Option<String>` with empty or missing content filtered out.

**Call relations**: Called by higher-level plugin installation logic when it needs to know which curated snapshot version is currently active.

*Call graph*: calls 2 internal fn (curated_plugins_sha_path, read_sha_file); called by 1 (install_resolved_plugin).


##### `curated_plugins_sha_path`  (lines 70–72)

```
fn curated_plugins_sha_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the file that stores the active curated plugins version string. This centralizes the `.tmp/plugins.sha` location.

**Data flow**: Accepts `codex_home`, appends the SHA filename constant, and returns a `PathBuf` without touching the filesystem.

**Call relations**: Used by SHA readers and by the backup-archive sync path when persisting the activated snapshot version.

*Call graph*: called by 2 (read_curated_plugins_sha, sync_openai_plugins_repo_via_backup_archive); 1 external calls (join).


##### `sync_openai_plugins_repo`  (lines 74–81)

```
fn sync_openai_plugins_repo(codex_home: &Path) -> Result<String, String>
```

**Purpose**: Starts a curated plugins sync using the production transport settings. It is the public entry into this file’s synchronization workflow.

**Data flow**: Receives `codex_home`, passes it together with the default git binary name and production API/archive URLs into `sync_openai_plugins_repo_with_transport_overrides`, and returns that `Result<String, String>` unchanged.

**Call relations**: Acts as the external wrapper around the more configurable internal sync routine.

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

**Purpose**: Coordinates the full fallback sequence for curated plugin synchronization and records transport metrics. It enforces single-process sync execution with a lock and preserves detailed error context across retries.

**Data flow**: Inputs are `codex_home`, a git executable name, a GitHub API base URL, and a backup archive metadata URL. It acquires the lock file, tries `sync_openai_plugins_repo_via_git`, then on failure emits metrics and warning logs before trying `sync_openai_plugins_repo_via_http`; if that also fails, it checks `has_local_curated_plugins_snapshot` to decide whether to stop or bootstrap via `sync_openai_plugins_repo_via_backup_archive`. It returns the resolved SHA/version on success or a composed error string on failure.

**Call relations**: Called only by `sync_openai_plugins_repo`. It is the central dispatcher that invokes each transport-specific implementation and the metric helpers according to success/failure branches.

*Call graph*: calls 7 internal fn (emit_curated_plugins_startup_sync_final_metric, emit_curated_plugins_startup_sync_metric, has_local_curated_plugins_snapshot, lock_curated_plugins_startup_sync, sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); called by 1 (sync_openai_plugins_repo); 2 external calls (format!, warn!).


##### `lock_curated_plugins_startup_sync`  (lines 148–162)

```
fn lock_curated_plugins_startup_sync(codex_home: &Path) -> Result<File, String>
```

**Purpose**: Creates and acquires the filesystem lock that prevents concurrent curated-plugin sync attempts from racing each other. The returned `File` keeps the lock alive for the caller’s scope.

**Data flow**: Given `codex_home`, it ensures the `.tmp` directory exists, opens or creates `.tmp/plugins.sync.lock` without truncating it, then calls `lock()` on the file handle. On success it returns the locked `File`; on any filesystem or locking error it returns a descriptive `String`.

**Call relations**: Used at the start of the top-level sync orchestration so all transport attempts run under one lock guard.

*Call graph*: called by 1 (sync_openai_plugins_repo_with_transport_overrides); 3 external calls (options, join, create_dir_all).


##### `sync_openai_plugins_repo_via_git`  (lines 164–206)

```
fn sync_openai_plugins_repo_via_git(codex_home: &Path, git_binary: &str) -> Result<String, String>
```

**Purpose**: Refreshes the curated plugins snapshot by fetching the exact remote HEAD commit with git and activating a staged checkout. It supports both bootstrapping from GitHub and reusing an existing local git repository as a fetch source.

**Data flow**: Inputs are `codex_home` and `git_binary`. It derives repo and SHA paths, resolves the remote HEAD via `git_ls_remote_head_sha`, reads the local version via `read_local_git_or_sha_file`, and short-circuits if the SHA already matches and `.git` exists. Otherwise it creates a temp staging directory, initializes it as a git repo, fetches the target commit either directly from GitHub or by copying from the existing repo after first fetching there, resets/cleans the staged checkout, verifies staged HEAD equals the expected remote SHA, validates the marketplace manifest, atomically activates the staged repo, writes the SHA file, and returns the remote SHA.

**Call relations**: This is the first transport attempted by the orchestration function. It delegates git subprocess work to `run_git_in_repo`, `fetch_curated_plugins_commit*`, `git_head_sha`, and uses staging/activation helpers to make the update atomic.

*Call graph*: calls 12 internal fn (activate_curated_repo, curated_plugins_repo_path, ensure_marketplace_manifest_exists, fetch_curated_plugins_commit, fetch_curated_plugins_commit_from_source, git_head_sha, git_ls_remote_head_sha, prepare_curated_repo_parent_and_temp_dir, read_local_git_or_sha_file, reset_curated_plugins_checkout (+2 more)); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 2 external calls (join, format!).


##### `fetch_curated_plugins_commit`  (lines 208–220)

```
fn fetch_curated_plugins_commit(
    repo_path: &Path,
    remote_sha: &str,
    git_binary: &str,
) -> Result<(), String>
```

**Purpose**: Fetches a specific curated plugins commit from the canonical GitHub repository into a local git repository. It is the direct-network fetch variant.

**Data flow**: Takes a destination `repo_path`, the target `remote_sha`, and `git_binary`; forwards them with the fixed GitHub git URL and a context string into `fetch_curated_plugins_commit_from`, returning its success or error.

**Call relations**: Used by the git sync path both for initial staging fetches and for refreshing an existing local repo before copying from it.

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

**Purpose**: Fetches a specific revision from another local repository into a destination repository. It is used to copy an already-fetched commit into the staged checkout without hitting the network again.

**Data flow**: Accepts destination `repo_path`, `source_repo_path`, `remote_sha`, and `git_binary`; passes them to `fetch_curated_plugins_commit_from` with a local-path source and a copy-specific context string.

**Call relations**: Called by the git sync path when an existing local git checkout is present and has already fetched the desired commit.

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

**Purpose**: Runs `git fetch` for one exact revision into the internal ref `refs/codex/curated-sync`. It standardizes the fetch command shape for both remote and local sources.

**Data flow**: Inputs are destination `repo_path`, a `source` path, `source_revision`, `git_binary`, and a human-readable `context`. It builds a force refspec `+<revision>:refs/codex/curated-sync`, spawns a timed git subprocess with `--depth 1 --no-tags`, then validates the exit status with `ensure_git_success`. It returns `()` on success or a formatted error string.

**Call relations**: Shared helper beneath both fetch wrappers; it is the low-level fetch primitive used during git-based synchronization.

*Call graph*: calls 2 internal fn (ensure_git_success, run_git_command_with_timeout); called by 2 (fetch_curated_plugins_commit, fetch_curated_plugins_commit_from_source); 2 external calls (new, format!).


##### `reset_curated_plugins_checkout`  (lines 259–272)

```
fn reset_curated_plugins_checkout(repo_path: &Path, git_binary: &str) -> Result<(), String>
```

**Purpose**: Makes a repository worktree exactly match the fetched curated-sync ref and removes untracked files. This ensures the staged checkout contains only the fetched snapshot.

**Data flow**: Takes `repo_path` and `git_binary`, runs `git reset --hard refs/codex/curated-sync`, then `git clean -fdx` via `run_git_in_repo`, and returns success only if both commands succeed.

**Call relations**: Invoked by the git sync path after fetching into the staged repository and before validating/activating it.

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

**Purpose**: Executes a git command in a specific repository with the standard timeout and lock-disabling environment. It wraps subprocess execution and status checking for simple repo-local commands.

**Data flow**: Inputs are `repo_path`, `git_binary`, an argument slice, and a `context` string. It constructs `git -C <repo_path> ...`, runs it through `run_git_command_with_timeout`, validates the result with `ensure_git_success`, and returns `()` or an error string.

**Call relations**: Used by checkout-reset and repository initialization steps inside the git sync flow.

*Call graph*: calls 2 internal fn (ensure_git_success, run_git_command_with_timeout); called by 2 (reset_curated_plugins_checkout, sync_openai_plugins_repo_via_git); 1 external calls (new).


##### `sync_openai_plugins_repo_via_http`  (lines 292–316)

```
fn sync_openai_plugins_repo_via_http(
    codex_home: &Path,
    api_base_url: &str,
) -> Result<String, String>
```

**Purpose**: Refreshes the curated plugins snapshot by querying GitHub’s API for the current HEAD SHA and downloading the corresponding zipball. It is the fallback when git transport fails.

**Data flow**: Given `codex_home` and `api_base_url`, it derives repo/SHA paths, creates a current-thread Tokio runtime, fetches the remote SHA with `fetch_curated_repo_remote_sha`, reads the local SHA file, and short-circuits if the SHA matches and the repo directory exists. Otherwise it creates a staging directory, downloads the zipball bytes with `fetch_curated_repo_zipball`, extracts them into staging, validates the marketplace manifest, activates the staged repo, writes the SHA file, and returns the remote SHA.

**Call relations**: Called by the orchestration function only after git sync fails. It delegates network I/O to async helpers and filesystem mutation to extraction/activation helpers.

*Call graph*: calls 9 internal fn (activate_curated_repo, curated_plugins_repo_path, ensure_marketplace_manifest_exists, extract_zipball_to_dir, fetch_curated_repo_remote_sha, fetch_curated_repo_zipball, prepare_curated_repo_parent_and_temp_dir, read_sha_file, write_curated_plugins_sha); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 2 external calls (join, new_current_thread).


##### `sync_openai_plugins_repo_via_backup_archive`  (lines 318–339)

```
fn sync_openai_plugins_repo_via_backup_archive(
    codex_home: &Path,
    backup_archive_api_url: &str,
) -> Result<String, String>
```

**Purpose**: Bootstraps the curated plugins snapshot from a public export archive when both git and GitHub HTTP fail. It is intentionally a last-resort path for missing local snapshots only.

**Data flow**: Inputs are `codex_home` and `backup_archive_api_url`. It derives repo and SHA paths, creates a Tokio runtime, prepares a staging directory, downloads archive bytes via `fetch_curated_repo_backup_archive_zip`, extracts them, validates the marketplace manifest, tries to recover a git SHA from the extracted `.git` metadata with `read_extracted_backup_archive_git_sha`, falls back to the constant `export-backup` marker if absent, activates the staged repo, writes that version string to the SHA file, and returns it.

**Call relations**: Invoked by the orchestration function only when earlier transports fail and `has_local_curated_plugins_snapshot` reports there is nothing local to preserve.

*Call graph*: calls 9 internal fn (activate_curated_repo, curated_plugins_repo_path, curated_plugins_sha_path, ensure_marketplace_manifest_exists, extract_zipball_to_dir, fetch_curated_repo_backup_archive_zip, prepare_curated_repo_parent_and_temp_dir, read_extracted_backup_archive_git_sha, write_curated_plugins_sha); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 1 external calls (new_current_thread).


##### `has_local_curated_plugins_snapshot`  (lines 341–346)

```
fn has_local_curated_plugins_snapshot(codex_home: &Path) -> bool
```

**Purpose**: Checks whether a usable curated snapshot already exists locally. The check requires both the marketplace manifest and the SHA file.

**Data flow**: Takes `codex_home`, derives the repo root, tests whether `.agents/plugins/marketplace.json` is a file and `.tmp/plugins.sha` is a file, and returns a boolean.

**Call relations**: Used by the top-level fallback logic to decide whether the lagging backup archive may be used or must be skipped to avoid overwriting an existing snapshot.

*Call graph*: calls 1 internal fn (curated_plugins_repo_path); called by 1 (sync_openai_plugins_repo_with_transport_overrides); 1 external calls (join).


##### `prepare_curated_repo_parent_and_temp_dir`  (lines 348–373)

```
fn prepare_curated_repo_parent_and_temp_dir(repo_path: &Path) -> Result<TempDir, String>
```

**Purpose**: Ensures the parent directory for the curated repo exists, cleans up stale temporary clone directories, and allocates a fresh staging directory. It centralizes tempdir setup for all transports.

**Data flow**: Accepts the target `repo_path`, derives its parent or errors if none exists, creates that parent directory, calls `remove_stale_curated_repo_temp_dirs` with the configured max age, then creates a `TempDir` in the parent with prefix `plugins-clone-`. It returns the `TempDir` or a descriptive error string.

**Call relations**: Called by git, HTTP, and backup-archive sync paths before they stage new repository contents.

*Call graph*: calls 1 internal fn (remove_stale_curated_repo_temp_dirs); called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 4 external calls (parent, format!, create_dir_all, new).


##### `remove_stale_curated_repo_temp_dirs`  (lines 375–458)

```
fn remove_stale_curated_repo_temp_dirs(parent: &Path, max_age: Duration)
```

**Purpose**: Best-effort cleanup for abandoned `plugins-clone-*` staging directories left by interrupted syncs. It avoids deleting recent tempdirs to reduce the chance of racing another active process.

**Data flow**: Inputs are a `parent` directory and `max_age`. It lists directory entries, filters to directories whose names start with `plugins-clone-`, reads metadata and modification times, computes age, and removes directories older than `max_age`. Failures at any step are logged with `warn!` and otherwise ignored.

**Call relations**: Called only during tempdir preparation as opportunistic maintenance before creating a new staging directory.

*Call graph*: called by 1 (prepare_curated_repo_parent_and_temp_dir); 3 external calls (read_dir, remove_dir_all, warn!).


##### `emit_curated_plugins_startup_sync_metric`  (lines 460–466)

```
fn emit_curated_plugins_startup_sync_metric(transport: &'static str, status: &'static str)
```

**Purpose**: Records an attempt/result metric for one transport step in the startup sync sequence. It wraps the generic counter emitter with the standard metric name.

**Data flow**: Takes static `transport` and `status` labels, forwards them with `CURATED_PLUGINS_STARTUP_SYNC_METRIC` to `emit_curated_plugins_startup_sync_counter`, and produces no return value.

**Call relations**: Used by the orchestration function after each transport attempt to record per-step success or failure.

*Call graph*: calls 1 internal fn (emit_curated_plugins_startup_sync_counter); called by 1 (sync_openai_plugins_repo_with_transport_overrides).


##### `emit_curated_plugins_startup_sync_final_metric`  (lines 468–474)

```
fn emit_curated_plugins_startup_sync_final_metric(transport: &'static str, status: &'static str)
```

**Purpose**: Records the final transport outcome metric for the startup sync sequence. It distinguishes the terminal result from intermediate attempts.

**Data flow**: Accepts static `transport` and `status` labels, forwards them with `CURATED_PLUGINS_STARTUP_SYNC_FINAL_METRIC` to the shared counter helper, and returns nothing.

**Call relations**: Called by the orchestration function when a transport becomes the final outcome, whether successful or terminally failed.

*Call graph*: calls 1 internal fn (emit_curated_plugins_startup_sync_counter); called by 1 (sync_openai_plugins_repo_with_transport_overrides).


##### `emit_curated_plugins_startup_sync_counter`  (lines 476–486)

```
fn emit_curated_plugins_startup_sync_counter(
    metric_name: &str,
    transport: &'static str,
    status: &'static str,
)
```

**Purpose**: Sends a tagged counter increment to the global telemetry backend if metrics are available. It is the common implementation behind both startup-sync metric variants.

**Data flow**: Inputs are `metric_name`, `transport`, and `status`. It reads `codex_otel::global()`, returns early if no metrics backend is installed, otherwise constructs tags `[('transport', transport), ('status', status)]` and increments the named counter by 1.

**Call relations**: Used only by the two metric-specific wrappers so the orchestration code can emit standardized telemetry without duplicating backend access.

*Call graph*: called by 2 (emit_curated_plugins_startup_sync_final_metric, emit_curated_plugins_startup_sync_metric); 1 external calls (global).


##### `ensure_marketplace_manifest_exists`  (lines 488–496)

```
fn ensure_marketplace_manifest_exists(repo_path: &Path) -> Result<(), String>
```

**Purpose**: Validates that an extracted or checked-out curated repository actually contains the expected marketplace manifest. This is the main structural sanity check before activation.

**Data flow**: Takes `repo_path`, checks whether `.agents/plugins/marketplace.json` exists as a file, returns `Ok(())` if present, otherwise returns an error string naming the missing path.

**Call relations**: Called by all three transport implementations after staging content and before swapping it into the live curated repo location.

*Call graph*: called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 2 external calls (join, format!).


##### `activate_curated_repo`  (lines 498–552)

```
fn activate_curated_repo(repo_path: &Path, staged_repo_dir: TempDir) -> Result<(), String>
```

**Purpose**: Atomically promotes a staged curated repository into the live location, with rollback support when replacing an existing repo. It minimizes the chance of leaving the live path half-updated.

**Data flow**: Inputs are the target `repo_path` and a `TempDir` containing staged contents. If the target exists, it creates a sibling temporary backup directory, renames the current repo into `backup/repo`, then renames the staged path into place; if that second rename fails, it attempts to restore the backup and reports either the activation failure alone or both activation and rollback failures, preserving the backup path if rollback also fails. If the target does not exist, it simply renames the staged path into place. It returns `()` on success.

**Call relations**: Used by git, HTTP, and backup-archive sync paths as the final filesystem mutation step before writing the SHA file.

*Call graph*: called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 6 external calls (exists, parent, path, format!, rename, new).


##### `write_curated_plugins_sha`  (lines 554–569)

```
fn write_curated_plugins_sha(sha_path: &Path, remote_sha: &str) -> Result<(), String>
```

**Purpose**: Persists the active curated snapshot version marker to disk. The file content is always written with a trailing newline.

**Data flow**: Takes `sha_path` and `remote_sha`, creates the parent directory if needed, writes `<remote_sha>\n` to the file, and returns success or a formatted filesystem error.

**Call relations**: Called after successful activation by each transport-specific sync path so later runs can compare local and remote versions.

*Call graph*: called by 3 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_git, sync_openai_plugins_repo_via_http); 4 external calls (parent, format!, create_dir_all, write).


##### `read_local_git_or_sha_file`  (lines 571–583)

```
fn read_local_git_or_sha_file(
    repo_path: &Path,
    sha_path: &Path,
    git_binary: &str,
) -> Option<String>
```

**Purpose**: Determines the best available local version marker by preferring the git HEAD of an existing repository and falling back to the saved SHA file. This lets git-based sync detect freshness even if the SHA file is stale or absent.

**Data flow**: Inputs are `repo_path`, `sha_path`, and `git_binary`. If `repo_path/.git` exists and `git_head_sha` succeeds, it returns that SHA; otherwise it reads and trims the SHA file via `read_sha_file`. The result is `Option<String>`.

**Call relations**: Used only by the git sync path before deciding whether a fetch is necessary.

*Call graph*: calls 2 internal fn (git_head_sha, read_sha_file); called by 1 (sync_openai_plugins_repo_via_git); 1 external calls (join).


##### `git_ls_remote_head_sha`  (lines 585–610)

```
fn git_ls_remote_head_sha(git_binary: &str) -> Result<String, String>
```

**Purpose**: Queries the canonical GitHub repository for the SHA currently pointed to by `HEAD`. It parses the first line of `git ls-remote` output.

**Data flow**: Takes `git_binary`, runs `git ls-remote https://github.com/openai/plugins.git HEAD` through `run_git_command_with_timeout`, validates success, decodes stdout as UTF-8 lossily, extracts the SHA before the tab on the first line, and returns it. Empty output, malformed output, or empty SHA become descriptive errors.

**Call relations**: Called by the git sync path as the first step to know which exact commit should be fetched and activated.

*Call graph*: calls 2 internal fn (ensure_git_success, run_git_command_with_timeout); called by 1 (sync_openai_plugins_repo_via_git); 3 external calls (from_utf8_lossy, new, format!).


##### `git_head_sha`  (lines 612–636)

```
fn git_head_sha(repo_path: &Path, git_binary: &str) -> Result<String, String>
```

**Purpose**: Reads the current commit SHA of a local git repository by running `git rev-parse HEAD`. It is used for local freshness checks and post-fetch verification.

**Data flow**: Inputs are `repo_path` and `git_binary`. It spawns `git -C <repo_path> rev-parse HEAD`, validates the exit status with `ensure_git_success`, trims stdout, and returns the SHA string or an error if the command fails or prints nothing.

**Call relations**: Used by `read_local_git_or_sha_file` to inspect an existing repo and by the git sync path to verify the staged checkout matches the expected remote SHA.

*Call graph*: calls 1 internal fn (ensure_git_success); called by 2 (read_local_git_or_sha_file, sync_openai_plugins_repo_via_git); 3 external calls (from_utf8_lossy, new, format!).


##### `run_git_command_with_timeout`  (lines 638–690)

```
fn run_git_command_with_timeout(
    command: &mut Command,
    context: &str,
    timeout: Duration,
) -> Result<Output, String>
```

**Purpose**: Executes a subprocess for a git command with captured output and a hard timeout. It polls the child process manually and kills it if it exceeds the configured duration.

**Data flow**: Inputs are a mutable `Command`, a `context` string, and a `timeout`. It configures stdin to null and stdout/stderr to pipes, spawns the child, repeatedly calls `try_wait()` with 100 ms sleeps, and if the timeout elapses it kills the child, collects output, and returns a timeout error that includes stderr when available. If the process exits in time, it returns the collected `Output`.

**Call relations**: This is the low-level subprocess primitive used by git fetches, `git ls-remote`, and generic repo-local git commands.

*Call graph*: called by 3 (fetch_curated_plugins_commit_from, git_ls_remote_head_sha, run_git_in_repo); 8 external calls (from_millis, null, piped, from_utf8_lossy, stdin, format!, sleep, now).


##### `ensure_git_success`  (lines 692–705)

```
fn ensure_git_success(output: &Output, context: &str) -> Result<(), String>
```

**Purpose**: Converts a completed git subprocess result into success or a readable error message. It standardizes stderr reporting across all git invocations.

**Data flow**: Takes an `Output` and a `context` string. If `output.status.success()` is true it returns `Ok(())`; otherwise it decodes and trims stderr and returns an error mentioning the exit status and stderr when present.

**Call relations**: Called after every git subprocess helper to keep command-specific logic focused on command construction rather than status formatting.

*Call graph*: called by 4 (fetch_curated_plugins_commit_from, git_head_sha, git_ls_remote_head_sha, run_git_in_repo); 2 external calls (from_utf8_lossy, format!).


##### `fetch_curated_repo_remote_sha`  (lines 707–735)

```
async fn fetch_curated_repo_remote_sha(api_base_url: &str) -> Result<String, String>
```

**Purpose**: Uses the GitHub REST API to discover the current HEAD commit SHA of the curated plugins repository. It first resolves the repository’s default branch, then resolves that branch’s git ref.

**Data flow**: Input is `api_base_url`. It trims any trailing slash, builds `/repos/openai/plugins`, creates a reqwest client via `build_reqwest_client`, fetches repository JSON with `fetch_github_text`, deserializes `GitHubRepositorySummary`, validates `default_branch`, then fetches `/git/ref/heads/<default_branch>`, deserializes `GitHubGitRefSummary`, validates `object.sha`, and returns the SHA string.

**Call relations**: Called by the HTTP sync path before downloading a zipball so that path can compare against the local SHA and request the exact archive for the current HEAD.

*Call graph*: calls 2 internal fn (fetch_github_text, build_reqwest_client); called by 1 (sync_openai_plugins_repo_via_http); 2 external calls (format!, from_str).


##### `fetch_curated_repo_zipball`  (lines 737–746)

```
async fn fetch_curated_repo_zipball(
    api_base_url: &str,
    remote_sha: &str,
) -> Result<Vec<u8>, String>
```

**Purpose**: Downloads the GitHub zipball archive for a specific curated plugins commit SHA. It is the archive-fetch half of the HTTP fallback path.

**Data flow**: Inputs are `api_base_url` and `remote_sha`. It normalizes the base URL, builds `/repos/openai/plugins/zipball/<sha>`, creates a reqwest client, fetches bytes with `fetch_github_bytes`, and returns the archive as `Vec<u8>`.

**Call relations**: Used by the HTTP sync path after `fetch_curated_repo_remote_sha` has identified the commit to stage.

*Call graph*: calls 2 internal fn (fetch_github_bytes, build_reqwest_client); called by 1 (sync_openai_plugins_repo_via_http); 1 external calls (format!).


##### `fetch_curated_repo_backup_archive_zip`  (lines 748–776)

```
async fn fetch_curated_repo_backup_archive_zip(
    backup_archive_api_url: &str,
) -> Result<Vec<u8>, String>
```

**Purpose**: Retrieves the backup export archive by first querying metadata for a download URL and then downloading the archive bytes from that public URL. It is separate from GitHub-specific request handling.

**Data flow**: Input is `backup_archive_api_url`. It creates a reqwest client, fetches metadata text with `fetch_public_text`, deserializes `CuratedPluginsBackupArchiveResponse`, validates that `download_url` is non-empty, then downloads the archive bytes with `fetch_public_bytes` and returns them.

**Call relations**: Called only by the backup-archive sync path when both primary transports have failed and bootstrap is allowed.

*Call graph*: calls 3 internal fn (fetch_public_bytes, fetch_public_text, build_reqwest_client); called by 1 (sync_openai_plugins_repo_via_backup_archive); 2 external calls (format!, from_str).


##### `read_extracted_backup_archive_git_sha`  (lines 778–805)

```
fn read_extracted_backup_archive_git_sha(repo_path: &Path) -> Result<Option<String>, String>
```

**Purpose**: Attempts to recover a git SHA from an extracted backup archive’s `.git` metadata. This lets the backup path preserve a meaningful version marker when the archive includes git internals.

**Data flow**: Takes `repo_path`, checks for `.git`, and returns `Ok(None)` if absent. If present, it reads `.git/HEAD`, trims it, errors if empty, and either returns the detached HEAD value directly or, for `ref: ...` content, validates the ref with `validate_backup_archive_git_ref`, resolves it with `read_git_ref_sha`, and returns `Some(sha)`.

**Call relations**: Used by the backup-archive sync path after extraction and before writing the SHA file.

*Call graph*: calls 2 internal fn (read_git_ref_sha, validate_backup_archive_git_ref); called by 1 (sync_openai_plugins_repo_via_backup_archive); 3 external calls (join, format!, read_to_string).


##### `validate_backup_archive_git_ref`  (lines 807–833)

```
fn validate_backup_archive_git_ref(reference: &str) -> Result<&str, String>
```

**Purpose**: Sanitizes a git ref string read from backup archive metadata before it is used as a filesystem-relative path. It prevents absolute paths and path traversal-like components.

**Data flow**: Input is `reference: &str`. It verifies the string starts with `refs/`, rejects absolute paths, iterates path components and allows only `Normal` components, then returns the original reference on success or an explanatory error string on failure.

**Call relations**: Called by `read_extracted_backup_archive_git_sha` before reading a referenced ref file from the extracted `.git` directory.

*Call graph*: called by 1 (read_extracted_backup_archive_git_sha); 2 external calls (new, format!).


##### `read_git_ref_sha`  (lines 835–866)

```
fn read_git_ref_sha(git_dir: &Path, reference: &str) -> Result<String, String>
```

**Purpose**: Resolves a git ref name to a SHA from an extracted `.git` directory, checking both loose refs and `packed-refs`. It supports the backup archive SHA recovery path.

**Data flow**: Inputs are `git_dir` and `reference`. It first tries to read `.git/<reference>` and returns the trimmed SHA if non-empty. If that fails, it reads `.git/packed-refs`, scans non-comment/non-peeled lines for a matching ref name, and returns the associated SHA. If neither source resolves the ref, it returns an error naming the git directory.

**Call relations**: Used only by `read_extracted_backup_archive_git_sha` when HEAD points at a symbolic ref.

*Call graph*: called by 1 (read_extracted_backup_archive_git_sha); 3 external calls (join, format!, read_to_string).


##### `fetch_github_text`  (lines 868–881)

```
async fn fetch_github_text(client: &Client, url: &str, context: &str) -> Result<String, String>
```

**Purpose**: Performs a GitHub API GET request and returns the response body as text with consistent error formatting. It includes GitHub-specific headers via `github_request`.

**Data flow**: Inputs are a reqwest `Client`, `url`, and `context`. It builds the request with `github_request`, sends it, captures the HTTP status, reads the body text (defaulting to empty on text-read failure), and returns the body on success or an error string containing status and body on non-success.

**Call relations**: Used by `fetch_curated_repo_remote_sha` for both repository-summary and git-ref API calls.

*Call graph*: calls 1 internal fn (github_request); called by 1 (fetch_curated_repo_remote_sha); 1 external calls (format!).


##### `fetch_github_bytes`  (lines 883–900)

```
async fn fetch_github_bytes(client: &Client, url: &str, context: &str) -> Result<Vec<u8>, String>
```

**Purpose**: Performs a GitHub API GET request and returns the raw response bytes. On HTTP failure it decodes the body lossily so error messages include server details.

**Data flow**: Inputs are a reqwest `Client`, `url`, and `context`. It builds the request with `github_request`, sends it, reads the body as bytes, and returns `Vec<u8>` on success; otherwise it converts the bytes to text lossily and returns an error string with status and body.

**Call relations**: Used by `fetch_curated_repo_zipball` to download the GitHub archive for the selected commit.

*Call graph*: calls 1 internal fn (github_request); called by 1 (fetch_curated_repo_zipball); 2 external calls (from_utf8_lossy, format!).


##### `fetch_public_text`  (lines 902–917)

```
async fn fetch_public_text(client: &Client, url: &str, context: &str) -> Result<String, String>
```

**Purpose**: Performs a plain HTTP GET for text content with the backup-archive timeout. It is used for non-GitHub endpoints that do not need GitHub headers.

**Data flow**: Inputs are a reqwest `Client`, `url`, and `context`. It issues `GET` with `CURATED_PLUGINS_BACKUP_ARCHIVE_TIMEOUT`, sends the request, reads the body text, and returns it on success or an error string containing status and body on failure.

**Call relations**: Called by `fetch_curated_repo_backup_archive_zip` to retrieve archive metadata from the public export endpoint.

*Call graph*: called by 1 (fetch_curated_repo_backup_archive_zip); 2 external calls (get, format!).


##### `fetch_public_bytes`  (lines 919–938)

```
async fn fetch_public_bytes(client: &Client, url: &str, context: &str) -> Result<Vec<u8>, String>
```

**Purpose**: Performs a plain HTTP GET for binary content with the backup-archive timeout. It mirrors `fetch_public_text` for archive downloads.

**Data flow**: Inputs are a reqwest `Client`, `url`, and `context`. It sends a timed GET request, reads the body as bytes, returns them on success, and on non-success converts the bytes to lossy text for inclusion in the error message.

**Call relations**: Used by `fetch_curated_repo_backup_archive_zip` to download the actual export archive from the metadata-provided URL.

*Call graph*: called by 1 (fetch_curated_repo_backup_archive_zip); 3 external calls (from_utf8_lossy, get, format!).


##### `github_request`  (lines 940–946)

```
fn github_request(client: &Client, url: &str) -> reqwest::RequestBuilder
```

**Purpose**: Constructs a GitHub API request builder with the standard timeout and required headers. It centralizes GitHub-specific request configuration.

**Data flow**: Takes a reqwest `Client` and `url`, returns a `RequestBuilder` for `GET <url>` with `CURATED_PLUGINS_HTTP_TIMEOUT`, `accept: application/vnd.github+json`, and `x-github-api-version: 2022-11-28` set.

**Call relations**: Used by both GitHub text and byte fetch helpers so all GitHub API calls share the same headers and timeout.

*Call graph*: called by 2 (fetch_github_bytes, fetch_github_text); 1 external calls (get).


##### `read_sha_file`  (lines 948–953)

```
fn read_sha_file(sha_path: &Path) -> Option<String>
```

**Purpose**: Reads a version marker file and normalizes it into an optional non-empty string. It trims trailing newlines and whitespace.

**Data flow**: Input is `sha_path`. It attempts to read the file as text, trims the contents, converts them to `String`, and returns `None` if the file is missing/unreadable or if the trimmed content is empty.

**Call relations**: Used by public SHA readers and by sync freshness checks when comparing local and remote curated snapshot versions.

*Call graph*: called by 3 (read_curated_plugins_sha, read_local_git_or_sha_file, sync_openai_plugins_repo_via_http); 1 external calls (read_to_string).


##### `extract_zipball_to_dir`  (lines 955–1028)

```
fn extract_zipball_to_dir(bytes: &[u8], destination: &Path) -> Result<(), String>
```

**Purpose**: Extracts a downloaded zip archive into a destination directory while stripping the archive’s top-level wrapper directory and preventing path escape. It recreates files/directories and restores Unix permissions when possible.

**Data flow**: Inputs are archive `bytes` and a `destination` path. It creates the destination directory, opens the bytes as a `ZipArchive`, iterates entries by index, obtains each entry’s `enclosed_name` to reject unsafe paths, drops the first path component so GitHub-style top-level directories are removed, skips empty outputs, creates directories as needed, writes file contents with `std::io::copy`, and calls `apply_zip_permissions` on extracted files. It returns `()` or a detailed extraction error.

**Call relations**: Called by both HTTP-based sync paths after downloading archive bytes and before manifest validation and activation.

*Call graph*: calls 2 internal fn (apply_zip_permissions, new); called by 2 (sync_openai_plugins_repo_via_backup_archive, sync_openai_plugins_repo_via_http); 7 external calls (join, new, new, format!, create, create_dir_all, copy).


##### `apply_zip_permissions`  (lines 1046–1051)

```
fn apply_zip_permissions(
    _entry: &zip::read::ZipFile<'_>,
    _output_path: &Path,
) -> Result<(), String>
```

**Purpose**: Applies Unix mode bits from a zip entry onto the extracted file on Unix platforms. On non-Unix builds, the alternate definition is a no-op.

**Data flow**: On Unix, it takes a zip entry and `output_path`, reads `entry.unix_mode()`, returns early if absent, otherwise converts the mode into filesystem permissions and sets them on the extracted file. It returns `Ok(())` on success or a formatted error if permission setting fails.

**Call relations**: Used only by `extract_zipball_to_dir` so extracted archives preserve executable bits and other Unix permissions when available.

*Call graph*: called by 1 (extract_zipball_to_dir); 3 external calls (unix_mode, from_mode, set_permissions).


### `chatgpt/src/get_task.rs`

`data_model` · `task fetch and diff extraction setup`

This file is a narrow data-model and fetch wrapper for the ChatGPT task endpoint. The structs are intentionally sparse: `GetTaskResponse` contains only `current_diff_task_turn`, `AssistantTurn` contains only `output_items`, and `OutputItem` is a tagged enum that recognizes the `pr` variant while collapsing all other item types into `Other` via `#[serde(other)]`. `PrOutputItem` and `OutputDiff` then expose just the nested `output_diff.diff` string needed to apply a patch.

That selective modeling is the key design choice here. Rather than mirror the entire task schema, the file keeps deserialization resilient to unrelated backend changes by ignoring fields the apply flow does not use. The single function, `get_task`, formats the REST path `/wham/tasks/{task_id}` and delegates the authenticated HTTP GET plus JSON decoding to `chatgpt_get_request`. The result is a typed payload that `apply_command.rs` can inspect without knowing anything about HTTP or auth. Because the enum only preserves PR outputs, downstream code can scan `output_items` and cleanly distinguish patch-bearing items from everything else.

#### Function details

##### `get_task`  (lines 37–40)

```
async fn get_task(config: &Config, task_id: String) -> anyhow::Result<GetTaskResponse>
```

**Purpose**: Fetches a task record from the ChatGPT backend and deserializes it into the minimal `GetTaskResponse` schema used by the apply flow. It hides the endpoint path construction from callers.

**Data flow**: It takes `&Config` and a `task_id: String`, formats the path as `/wham/tasks/{task_id}`, passes that path to `chatgpt_get_request(config, path).await`, and returns the resulting `GetTaskResponse` or transport/deserialization error.

**Call relations**: Called by `run_apply_command` before diff extraction begins. It delegates all HTTP/auth work to `chatgpt_get_request` and supplies the typed response consumed by `apply_diff_from_task`.

*Call graph*: calls 1 internal fn (chatgpt_get_request); called by 1 (run_apply_command); 1 external calls (format!).


### Update and rate-limit checks
These files query backend rate-limit reset state, gate memory startup on available headroom, and coordinate CLI and TUI update discovery.

### `backend-client/src/client/rate_limit_resets.rs`

`io_transport` · `request handling`

This submodule groups the backend endpoints related to rate-limit reset credits. It defines a small request payload type, `ConsumeRateLimitResetCreditRequest<'a>`, whose only field is the caller-supplied `redeem_request_id`. The implementation lives as additional inherent methods on `Client`, reusing the shared header construction, request execution, and JSON decoding helpers from the parent module.

`get_rate_limits_with_reset_credits` is the higher-level read API: it fetches the backend usage payload through `get_rate_limit_status`, then converts the embedded rate-limit status into protocol-layer snapshots using `Client::rate_limit_snapshots_from_payload` while preserving the backend’s `rate_limit_reset_credits` summary alongside them. `get_rate_limit_status` is the raw typed GET wrapper for the usage endpoint.

`consume_rate_limit_reset_credit` POSTs JSON to the consume endpoint with `content-type: application/json`, then decodes the typed response. The two private URL builders encapsulate the same path-style split used elsewhere in the client: Codex API routes live under `/api/codex/...`, while ChatGPT backend-api routes live under `/wham/...`. Tests for this submodule are kept in a separate file and imported with `#[path = ...]`.

#### Function details

##### `Client::get_rate_limits_with_reset_credits`  (lines 19–25)

```
async fn get_rate_limits_with_reset_credits(&self) -> Result<RateLimitsWithResetCredits>
```

**Purpose**: Fetches backend usage status and returns both mapped rate-limit snapshots and the available reset-credit summary. It is the combined read API for this feature area.

**Data flow**: Borrows `self`, awaits `get_rate_limit_status()`, transforms `payload.rate_limits` through `Self::rate_limit_snapshots_from_payload`, copies `payload.rate_limit_reset_credits`, and returns `RateLimitsWithResetCredits`.

**Call relations**: It is called by `Client::get_rate_limits_many` in the parent module and delegates the actual HTTP fetch to `Client::get_rate_limit_status`.

*Call graph*: calls 1 internal fn (get_rate_limit_status); 1 external calls (rate_limit_snapshots_from_payload).


##### `Client::get_rate_limit_status`  (lines 27–32)

```
async fn get_rate_limit_status(&self) -> Result<RateLimitStatusWithResetCredits>
```

**Purpose**: Fetches the raw backend usage payload that includes both rate-limit status and reset-credit availability. It is the typed GET wrapper for the usage endpoint.

**Data flow**: Builds the URL with `rate_limit_status_url()`, creates a GET request using `self.http` and `self.headers()`, executes it via `self.exec_request`, and decodes the body into `RateLimitStatusWithResetCredits` with `self.decode_json`.

**Call relations**: It is used internally by `Client::get_rate_limits_with_reset_credits`.

*Call graph*: calls 1 internal fn (rate_limit_status_url); called by 1 (get_rate_limits_with_reset_credits).


##### `Client::consume_rate_limit_reset_credit`  (lines 34–47)

```
async fn consume_rate_limit_reset_credit(
        &self,
        redeem_request_id: &str,
    ) -> Result<ConsumeRateLimitResetCreditResponse>
```

**Purpose**: Redeems one rate-limit reset credit identified by a caller-provided request id. It POSTs the expected JSON payload and returns the typed backend response.

**Data flow**: Builds the consume URL with `consume_rate_limit_reset_credit_url()`, creates a POST request with common headers and JSON content type, serializes `ConsumeRateLimitResetCreditRequest { redeem_request_id }`, executes via `self.exec_request`, and decodes into `ConsumeRateLimitResetCreditResponse`.

**Call relations**: It is the write-side companion to the read APIs in this submodule and relies on the parent module’s shared transport helpers.

*Call graph*: calls 1 internal fn (consume_rate_limit_reset_credit_url); 1 external calls (from_static).


##### `Client::rate_limit_status_url`  (lines 49–54)

```
fn rate_limit_status_url(&self) -> String
```

**Purpose**: Builds the usage-status endpoint URL for the current path style. It encapsulates the Codex-vs-WHAM route difference for usage reads.

**Data flow**: Reads `self.path_style` and `self.base_url`, formats either `{base}/api/codex/usage` or `{base}/wham/usage`, and returns the string.

**Call relations**: It is used by `Client::get_rate_limit_status` and validated in the submodule tests.

*Call graph*: called by 1 (get_rate_limit_status); 1 external calls (format!).


##### `Client::consume_rate_limit_reset_credit_url`  (lines 56–68)

```
fn consume_rate_limit_reset_credit_url(&self) -> String
```

**Purpose**: Builds the reset-credit consume endpoint URL for the current path style. It encapsulates the route difference for the redemption POST.

**Data flow**: Reads `self.path_style` and `self.base_url`, formats either `{base}/api/codex/rate-limit-reset-credits/consume` or `{base}/wham/rate-limit-reset-credits/consume`, and returns the string.

**Call relations**: It is used by `Client::consume_rate_limit_reset_credit` and validated in the submodule tests.

*Call graph*: called by 1 (consume_rate_limit_reset_credit); 1 external calls (format!).


### `memories/write/src/guard.rs`

`domain_logic` · `startup gating`

This module encapsulates the policy for skipping memories startup when Codex backend rate limits are too depleted. The public `rate_limits_ok` function is intentionally permissive: it calls an internal checker and falls back to `true` if the check returns `None`, meaning startup proceeds when auth is unavailable, the backend is not Codex-backed, client construction fails, or rate-limit fetches fail.

The internal flow first asks `AuthManager` for current auth and exits early if there is none. It then ignores non-Codex auth entirely by checking `uses_codex_backend()`. For Codex-backed auth, it constructs a `codex_backend_client::Client` from `config.chatgpt_base_url` and the auth object, logging warnings on construction or fetch failures. After retrieving snapshots, it prefers the one whose `limit_id` matches `crate::guard_limits::CODEX_LIMIT_ID` (`"codex"`), falling back to the first snapshot if no exact match exists.

The decision logic compares the configured `config.memories.min_rate_limit_remaining_percent` against the snapshot. Any non-`None` `rate_limit_reached_type` immediately blocks startup. Otherwise, the code converts the remaining-percent threshold into a maximum allowed used-percent and requires both primary and secondary windows, when present, to stay at or below that value. Missing windows are treated as unconstrained. If startup is denied, the module emits an informational log explaining that memories startup is being skipped due to low remaining rate limits.

#### Function details

##### `rate_limits_ok`  (lines 9–13)

```
async fn rate_limits_ok(auth_manager: &AuthManager, config: &Config) -> bool
```

**Purpose**: Provides the top-level yes/no startup gate for rate-limit checks, defaulting to allow on inconclusive results. It hides the tri-state internal checker behind a simple boolean API.

**Data flow**: Accepts `auth_manager: &AuthManager` and `config: &Config`, awaits `rate_limits_check(auth_manager, config)`, and converts `Option<bool>` into `bool` with `unwrap_or(true)`, so `None` becomes `true`.

**Call relations**: This function is called by `start_memories_startup_task` before running the memories startup pipeline. It delegates all substantive work to `rate_limits_check` and exists to enforce the permissive fallback policy at the boundary.

*Call graph*: calls 1 internal fn (rate_limits_check); called by 1 (start_memories_startup_task).


##### `rate_limits_check`  (lines 15–47)

```
async fn rate_limits_check(auth_manager: &AuthManager, config: &Config) -> Option<bool>
```

**Purpose**: Fetches the relevant backend rate-limit snapshot and evaluates whether the configured minimum remaining percentage permits startup. It returns `None` when the check cannot or should not apply.

**Data flow**: Reads auth from `auth_manager.auth().await`; if absent, returns `None`. If auth is not Codex-backed, returns `None`. Otherwise it builds a `BackendClient` from `config.chatgpt_base_url.clone()` and auth, fetches snapshots with `get_rate_limits_many`, selects the snapshot whose `limit_id` matches `CODEX_LIMIT_ID` or falls back to the first snapshot, reads `config.memories.min_rate_limit_remaining_percent`, computes `allowed` via `snapshot_allows_startup`, logs an info message when `allowed` is false, and returns `Some(allowed)`. Client-construction and fetch failures are downgraded to warnings and `None`.

**Call relations**: This helper is invoked only by `rate_limits_ok`. It delegates the threshold comparison itself to `snapshot_allows_startup`, while handling all external interactions—auth lookup, backend client creation, snapshot retrieval, and logging around non-fatal failures or a negative decision.

*Call graph*: calls 2 internal fn (auth, snapshot_allows_startup); called by 1 (rate_limits_ok); 2 external calls (from_auth, info!).


##### `snapshot_allows_startup`  (lines 49–57)

```
fn snapshot_allows_startup(snapshot: &RateLimitSnapshot, min_remaining_percent: i64) -> bool
```

**Purpose**: Evaluates a single `RateLimitSnapshot` against the configured minimum remaining percentage. It blocks startup immediately if the backend reports the limit as reached, otherwise checks both primary and secondary windows against the derived used-percent ceiling.

**Data flow**: Takes `snapshot: &RateLimitSnapshot` and `min_remaining_percent: i64`. If `snapshot.rate_limit_reached_type.is_some()`, returns `false`. Otherwise clamps `min_remaining_percent` into `0..=100`, computes `max_used_percent = 100.0 - clamped as f64`, and returns the conjunction of `window_allows_startup(snapshot.primary.as_ref(), max_used_percent)` and the same check for `snapshot.secondary.as_ref()`.

**Call relations**: This function is called from `rate_limits_check` after a snapshot has been selected. It delegates per-window comparison to `window_allows_startup` so the handling of optional windows is centralized and consistent.

*Call graph*: calls 1 internal fn (window_allows_startup); called by 1 (rate_limits_check).


##### `window_allows_startup`  (lines 59–64)

```
fn window_allows_startup(window: Option<&RateLimitWindow>, max_used_percent: f64) -> bool
```

**Purpose**: Applies the used-percent threshold to one optional rate-limit window. Missing windows are treated as acceptable rather than blocking startup.

**Data flow**: Accepts `window: Option<&RateLimitWindow>` and `max_used_percent: f64`. It returns `window.used_percent <= max_used_percent` when a window is present, or `true` when the window is `None`.

**Call relations**: This is the leaf predicate used by `snapshot_allows_startup` for both primary and secondary windows. It isolates the optional-window rule so the snapshot-level logic can simply combine two boolean checks.

*Call graph*: called by 1 (snapshot_allows_startup).


### `cli/src/doctor/updates.rs`

`domain_logic` · `doctor request handling`

This module builds the `updates.status` doctor row. `updates_check` starts from the current executable, derives an `InstallContext`, and records whether startup update checks are enabled plus the concrete update command or mechanism implied by the install method. It then inspects `codex_home/version.json` through `push_cached_version_details`, surfacing cached latest version, last-checked timestamp, dismissed version, parse failures, or missing cache.

For npm-managed launches, the check performs an additional consistency test with `npm_global_root_check`. A matching package root is recorded as detail; a mismatch is treated as `Fail` because `npm install -g` would update a different installation than the one currently running; missing package-root metadata or unavailable npm only degrade to `Warning`. This distinction makes PATH/prefix mismatches visible before users attempt an update.

The module also probes the latest available version using `curl` via `run_command`, parsing JSON from either GitHub releases or the Homebrew cask API depending on install method. Probe failures become warnings rather than hard failures. Version freshness is evaluated by `is_newer`, which only understands plain `major.minor.patch` triples; prerelease or malformed versions yield `None`, causing the check to report only that the current version is not known to be older. The file includes a small `VersionInfo` schema for the cache file and tests for semver comparison and update-action labeling.

#### Function details

##### `updates_check`  (lines 33–108)

```
fn updates_check(config: &Config) -> DoctorCheck
```

**Purpose**: Builds the update-health doctor row for the current installation. It checks local update configuration, npm-target consistency when relevant, cached version metadata, and latest-version availability.

**Data flow**: Reads the current executable path, derives `InstallContext`, initializes details with `config.check_for_update_on_startup` and `update_action_label`, computes the version-cache path under `config.codex_home`, and appends cache details via `push_cached_version_details`. It initializes status/summary/remediation, optionally runs npm-specific consistency logic using `doctor_managed_by_npm` and `npm_global_root_check` to update status and details, then calls `fetch_latest_version`; on success it appends the latest version and compares it to `env!("CARGO_PKG_VERSION")` with `is_newer`, and on failure it records a warning detail. Finally it returns a `DoctorCheck`, attaching remediation when one was set.

**Call relations**: This is the production entry used by the doctor subsystem. It orchestrates helper functions for cache parsing, install-method labeling, npm-root validation, remote version probing, and semver comparison.

*Call graph*: calls 4 internal fn (new, fetch_latest_version, is_newer, push_cached_version_details); 7 external calls (env!, format!, current_exe, doctor_install_context, doctor_managed_by_npm, npm_global_root_check, vec!).


##### `push_cached_version_details`  (lines 110–130)

```
fn push_cached_version_details(details: &mut Vec<String>, version_file: &Path)
```

**Purpose**: Reads the local `version.json` cache file and appends whatever version metadata can be recovered. It reports missing files and parse/read errors explicitly in the details list.

**Data flow**: Accepts a mutable details vector and a cache-file path, pushes the cache path itself, reads the file with `std::fs::read_to_string`, and on success attempts to deserialize `VersionInfo` from JSON. Parsed fields append `cached latest version`, optional `last checked at`, and optional `dismissed version`; parse failures append `version cache parse: ...`; missing files append `version cache: missing`; other I/O failures append `version cache read: ...`.

**Call relations**: Called only by `updates_check` so local cache state is always included before any network probe occurs.

*Call graph*: called by 1 (updates_check); 2 external calls (format!, read_to_string).


##### `update_action_label`  (lines 132–140)

```
fn update_action_label(context: &InstallContext) -> &'static str
```

**Purpose**: Maps an `InstallContext` to the concrete update command or mechanism users should expect. The labels are install-method specific and user-facing.

**Data flow**: Pattern-matches on `context.method` and returns a static string such as `npm install -g @openai/codex`, `brew upgrade --cask codex`, `standalone installer`, or `manual or unknown`.

**Call relations**: Used by `updates_check` to explain what update path corresponds to the running installation; also covered by a unit test.


##### `fetch_latest_version`  (lines 142–150)

```
fn fetch_latest_version(context: &InstallContext) -> Result<String, String>
```

**Purpose**: Chooses the appropriate remote latest-version source based on install method. Brew installs use the Homebrew cask API; all others use GitHub releases.

**Data flow**: Reads `context.method` and dispatches to `fetch_homebrew_cask_version` for `InstallMethod::Brew` or `fetch_latest_github_release_version` for npm, bun, standalone, and other installs, returning the resulting `Result<String, String>` unchanged.

**Call relations**: Called by `updates_check` after local consistency checks so the doctor row can compare the running version against an external latest-version source.

*Call graph*: calls 2 internal fn (fetch_homebrew_cask_version, fetch_latest_github_release_version); called by 1 (updates_check).


##### `fetch_latest_github_release_version`  (lines 152–163)

```
fn fetch_latest_github_release_version() -> Result<String, String>
```

**Purpose**: Fetches the latest GitHub release metadata and extracts the Codex version string from the release tag. It expects tags prefixed with `rust-v`.

**Data flow**: Defines a local `ReleaseInfo { tag_name }` schema, fetches and deserializes JSON from `GITHUB_LATEST_RELEASE_URL` via `http_get_json`, strips the `rust-v` prefix from `tag_name`, converts the remainder to `String`, and returns an error string if the prefix is absent.

**Call relations**: Selected by `fetch_latest_version` for non-brew installs. It relies on `http_get_json` for the actual HTTP transport and JSON decoding.

*Call graph*: called by 1 (fetch_latest_version).


##### `fetch_homebrew_cask_version`  (lines 165–172)

```
fn fetch_homebrew_cask_version() -> Result<String, String>
```

**Purpose**: Fetches the latest version string from the Homebrew cask API. Unlike the GitHub path, it reads the version field directly.

**Data flow**: Defines a local `HomebrewCaskInfo { version }` schema, calls `http_get_json` with `HOMEBREW_CASK_API_URL`, and maps the parsed struct to its `version` field.

**Call relations**: Selected by `fetch_latest_version` specifically for brew-managed installs so the doctor row reflects Homebrew's notion of the latest cask version.

*Call graph*: called by 1 (fetch_latest_version).


##### `http_get_json`  (lines 174–180)

```
fn http_get_json(url: &str) -> Result<T, String>
```

**Purpose**: Performs a bounded HTTP GET using `curl` and deserializes the response body as JSON. It is the module's generic remote-fetch helper.

**Data flow**: Accepts a URL string, invokes `run_command("curl", ["-fsSL", "--max-time", "5", url])` to obtain the response body, then attempts `serde_json::from_str::<T>(&body)`, returning either the parsed value or an error string.

**Call relations**: Used by both remote version fetchers so network behavior and timeout policy stay consistent across GitHub and Homebrew probes.

*Call graph*: 1 external calls (run_command).


##### `is_newer`  (lines 182–187)

```
fn is_newer(latest: &str, current: &str) -> Option<bool>
```

**Purpose**: Compares two plain semantic versions and reports whether the latest version is greater than the current one. It returns `None` when either side cannot be parsed as simple `x.y.z`.

**Data flow**: Calls `parse_version` on both `latest` and `current`; if both parse, compares the resulting `(u64, u64, u64)` tuples and returns `Some(latest > current)`, otherwise returns `None`.

**Call relations**: Called by `updates_check` after a successful latest-version probe to decide whether to report that a newer version is available.

*Call graph*: calls 1 internal fn (parse_version); called by 1 (updates_check).


##### `parse_version`  (lines 189–195)

```
fn parse_version(value: &str) -> Option<(u64, u64, u64)>
```

**Purpose**: Parses a trimmed version string as exactly three dot-separated unsigned integers. It intentionally ignores prerelease/build metadata and rejects anything outside plain semver triples.

**Data flow**: Splits the input string on `.`, parses the first three components as `u64`, and returns `Some((major, minor, patch))` on success or `None` if any component is missing or unparsable.

**Call relations**: This helper underpins `is_newer`; its strictness is why prerelease strings cause `is_newer` to return `None`.

*Call graph*: called by 1 (is_newer).


##### `tests::is_newer_compares_plain_semver`  (lines 211–215)

```
fn is_newer_compares_plain_semver()
```

**Purpose**: Verifies that plain semantic versions compare correctly and that prerelease syntax is treated as unparsable. It locks down the intended strictness of version parsing.

**Data flow**: Calls `is_newer` with newer, older, and prerelease examples and asserts the returned `Option<bool>` values.

**Call relations**: This test covers the interaction between `is_newer` and `parse_version`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::update_action_labels_install_contexts`  (lines 218–233)

```
fn update_action_labels_install_contexts()
```

**Purpose**: Verifies that install methods map to the expected user-facing update commands. It checks representative npm and fallback cases.

**Data flow**: Constructs `InstallContext` values with `InstallMethod::Npm` and `InstallMethod::Other`, passes them to `update_action_label`, and asserts the returned strings.

**Call relations**: This test protects the wording used by `updates_check` when describing how the current installation should be updated.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/updates.rs`

`orchestration` · `startup update check and popup gating`

This release-only module is the main update-checking orchestrator. `get_upgrade_version` is the public entry point used at startup: it first respects `Config.check_for_update_on_startup` and skips all work for source builds identified by `CODEX_CLI_VERSION == 0.0.0`. It then determines the current installation channel via `update_action::get_update_action`, computes the cache path with `version_filepath`, and tries to load cached `VersionInfo` from disk. If there is no cache entry or the cached `last_checked_at` is older than 20 hours, it spawns `check_for_update` in the background so startup is not blocked by network I/O; the current run continues using whatever cached data already exists.

`check_for_update` chooses the upstream source based on `Option<UpdateAction>`. Homebrew installs query the Homebrew cask API because brew can lag behind GitHub releases. npm and bun installs fetch the latest GitHub release version and then verify that the npm registry package is ready for that exact version via `npm_registry::ensure_version_ready`, preventing prompts for a release that has not propagated to npm yet. Standalone installs and unknown install methods use the latest GitHub release directly. The function preserves any previously dismissed version when rewriting the cache file.

`fetch_latest_github_release_version` performs the GitHub API call and strips the `rust-v` tag prefix. `get_upgrade_version_for_popup` layers popup-specific suppression on top of `get_upgrade_version`: after obtaining the latest newer version, it rereads the cache and suppresses the popup if `dismissed_version` matches that exact version string.

#### Function details

##### `get_upgrade_version`  (lines 24–54)

```
fn get_upgrade_version(config: &Config) -> Option<String>
```

**Purpose**: Returns the cached newer version to advertise, while opportunistically refreshing the cache in the background when it is stale.

**Data flow**: It reads `config.check_for_update_on_startup` and `CODEX_CLI_VERSION`; if updates are disabled or the build is a source build, it returns `None`. Otherwise it gets the current `UpdateAction`, computes the cache path with `version_filepath(config)`, and attempts `read_version_info`. If the cache is missing or older than 20 hours relative to `Utc::now()`, it spawns `check_for_update(&version_file, action)` on Tokio without awaiting it. Finally, from the previously read cache entry, it compares `info.latest_version` against `CODEX_CLI_VERSION` using `is_newer` and returns `Some(latest_version)` only when the cached version is strictly newer.

**Call relations**: This is called by `run` for banner-style update awareness and by `get_upgrade_version_for_popup` for modal prompting. It delegates actual network refresh to `check_for_update` and intentionally decouples that refresh from the current startup path.

*Call graph*: calls 5 internal fn (get_update_action, is_source_build_version, check_for_update, read_version_info, version_filepath); called by 2 (run, get_upgrade_version_for_popup); 3 external calls (hours, now, spawn).


##### `check_for_update`  (lines 70–113)

```
async fn check_for_update(version_file: &Path, action: Option<UpdateAction>) -> anyhow::Result<()>
```

**Purpose**: Fetches the latest applicable version from the correct upstream source for the current install method and writes refreshed cache metadata to disk.

**Data flow**: It takes a cache-file path and an optional `UpdateAction`. For `BrewUpgrade`, it fetches `HomebrewCaskInfo` from the Homebrew cask API and uses its `version`. For npm or bun, it fetches the latest GitHub release version, then fetches `NpmPackageInfo` from the npm registry and calls `npm_registry::ensure_version_ready` to ensure that version is actually available there. For standalone installs or `None`, it uses the latest GitHub release version directly. It then reads any previous cache entry to preserve `dismissed_version`, constructs a new `VersionInfo` with `latest_version`, `Utc::now()`, and the preserved dismissal, serializes it as one JSON line with a trailing newline, creates the parent directory if needed, and writes the file asynchronously.

**Call relations**: This function is only launched from `get_upgrade_version` when the cache is absent or stale. It delegates HTTP client creation to `create_client`, version extraction to `fetch_latest_github_release_version`, and npm propagation checks to `ensure_version_ready`.

*Call graph*: calls 4 internal fn (create_client, ensure_version_ready, fetch_latest_github_release_version, read_version_info); called by 1 (get_upgrade_version); 5 external calls (parent, now, format!, create_dir_all, write).


##### `fetch_latest_github_release_version`  (lines 115–126)

```
async fn fetch_latest_github_release_version() -> anyhow::Result<String>
```

**Purpose**: Queries the GitHub releases API for the latest release and converts its tag name into a plain version string.

**Data flow**: It creates an HTTP client, performs a GET to `LATEST_RELEASE_URL`, checks for HTTP success, deserializes the body into `ReleaseInfo { tag_name }`, and passes that tag to `extract_version_from_latest_tag`. It returns `anyhow::Result<String>`.

**Call relations**: This helper is used by `check_for_update` in all non-Homebrew paths, keeping GitHub-specific fetch and tag parsing logic separate from cache-writing and install-channel branching.

*Call graph*: calls 2 internal fn (create_client, extract_version_from_latest_tag); called by 1 (check_for_update).


##### `get_upgrade_version_for_popup`  (lines 130–144)

```
fn get_upgrade_version_for_popup(config: &Config) -> Option<String>
```

**Purpose**: Returns the newer version that should trigger the modal popup, suppressing it when the user already dismissed that exact version.

**Data flow**: It first applies the same early exits as `get_upgrade_version`: disabled startup checks or source builds return `None`. It computes the cache path, calls `get_upgrade_version(config)` to obtain the currently known newer version, then rereads the cache with `read_version_info`. If the cache exists and `dismissed_version.as_deref()` equals the candidate latest version, it returns `None`; otherwise it returns `Some(latest)`.

**Call relations**: This function is called by `run_update_prompt_if_needed` to decide whether to show the modal. It builds directly on `get_upgrade_version` and adds only the dismissal filter.

*Call graph*: calls 4 internal fn (is_source_build_version, get_upgrade_version, read_version_info, version_filepath); called by 1 (run_update_prompt_if_needed).

## 📊 State Registers Touched

- `reg-global-tls-provider` — The single cryptography and TLS backend chosen for all secure network connections in this process.
- `reg-codex-home-and-install-context` — The discovered home folder, install layout, bundled asset locations, and helper binary paths used across the app.
- `reg-effective-config` — The final merged settings from defaults, managed config, user files, project files, thread overrides, and command-line flags.
- `reg-feature-flags` — The set of optional features currently turned on or off for this run.
- `reg-model-provider-and-catalog` — The shared list of model providers, available models, and ready-to-pick model presets.
- `reg-plugin-catalog-and-snapshot` — The known plugins, hooks, marketplaces, and synced plugin snapshot available to the runtime.
- `reg-connector-and-app-catalog` — The merged list of external apps and connectors the system can use.
- `reg-auth-session` — The current signed-in account state and saved login details for this installation.
- `reg-access-tokens-and-refresh-state` — The bearer tokens, refresh tokens, and expiry information that get renewed and attached to requests.
- `reg-cloud-config-cache` — The fetched and cached server-controlled settings package that can refresh in the background.
- `reg-local-model-server-state` — The known reachability, model availability, and download/load status of local model servers like Ollama or LM Studio.
- `reg-rate-limit-status` — The current account usage and rate-limit status that can block or shape work.
- `reg-update-cache` — The cached information about available app updates and installed version status.
- `reg-network-client-stack` — The shared HTTP and transport client infrastructure used for requests, retries, cookies, streams, and relays.
- `reg-cache-stores` — The shared on-disk caches for downloaded config, model lists, plugin data, updates, and small UI choices.
- `reg-backend-client-pool` — The shared pool/factory of authenticated backend API clients and request adapters reused across startup refreshes, turns, tools, updates, and feedback uploads.
- `reg-startup-prewarm-state` — The session-level prewarm/readiness state that tracks background startup preparation work and whether shared resources have already been warmed for later turns.
- `reg-skills-watch-state` — The background watcher state for skill files and the invalidation signals that trigger refresh of cached skill data.
- `reg-auth-mode-and-account-readiness` — The resolved authentication mode and current account-readiness/eligibility state that gates features and request paths beyond raw token possession.
- `reg-workspace-trust-state` — The remembered trust/allowance state for the current workspace that influences onboarding, plugin enablement, and action policy across the session.
- `reg-provider-verification-and-reroute-state` — The current provider-verification, fallback, and reroute decisions/notifications that influence how model requests are directed and explained to clients.
- `reg-daemon-update-restart-state` — The daemon’s watched updater/replacement state that determines when a managed server process should refresh binaries and restart.
- `reg-response-cache-and-request-dedup` — Shared cached/in-flight remote fetch state used to reuse or coalesce background refresh results such as model, cloud-config, connector, and update lookups across startup and later requests.
