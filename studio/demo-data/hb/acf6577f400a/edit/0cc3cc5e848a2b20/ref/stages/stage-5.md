# Authentication, identity, and account readiness  `stage-5`

This stage sits after basic startup configuration and before most networked work begins: it turns saved credentials, environment-provided secrets, and machine identity into a concrete “who am I, and what am I allowed to use?” runtime state. Its two sub-stages do the heavy lifting. Interactive and persisted login flows acquire, store, revoke, and restore user or service credentials across CLI, TUI, and JSON-RPC entrypoints. Provider and backend auth adaptation then converts those credentials into transport-ready forms such as bearer headers, agent assertions, or AWS SigV4 signatures so downstream clients can call the right backend without duplicating auth rules.

The directly assigned files provide the core state model that ties those pieces together. login/src/auth/manager.rs is the central auth state machine: it loads auth from storage or environment, selects the active mode, refreshes tokens, and enforces mode restrictions. access_token.rs and personal_access_token.rs distinguish token kinds and enrich personal tokens with whoami account metadata. token_data.rs defines the persisted token payload and parsed JWT claims used by storage and refresh logic. core/src/installation_id.rs supplies a stable per-installation identity, while sandbox_users.rs manages the Windows sandbox’s local accounts and protected credentials for isolated execution.

## Sub-stages

- [Interactive and persisted login flows](stage-5.1.md) `stage-5.1` — 15 files
- [Provider and backend auth adaptation](stage-5.2.md) `stage-5.2` — 19 files

## Files in this stage

### Authentication state core
These files define the main auth state machine and the token representations it loads, classifies, parses, and enriches during startup.

### `login/src/auth/manager.rs`

`domain_logic` · `startup auth load, request handling, token refresh, logout, and auth recovery`

This is the central auth subsystem file. It defines the runtime auth enum `CodexAuth` with variants for API keys, managed ChatGPT OAuth, externally supplied ChatGPT tokens, agent identity JWTs, personal access tokens, and Bedrock API keys. It also defines the persistence-facing helpers around `AuthDotJson`, environment-variable readers, login/logout entry points, token-refresh request/response types, and the `ExternalAuth` abstraction used for externally managed credentials.

The file’s main orchestration type is `AuthManager`, which caches a single auth snapshot in `CachedAuth`, tracks refresh-failure state scoped to that exact snapshot, exposes a watch channel for auth changes, and serializes refresh attempts with a semaphore. Loading follows a strict precedence order in `load_auth`: optional `CODEX_API_KEY`, ephemeral external-token storage, `CODEX_ACCESS_TOKEN`, then persistent storage unless the configured mode is ephemeral-only. `CodexAuth::from_auth_dot_json` reconstructs the correct runtime variant, including backward-compatible mode inference from populated fields.

Refresh logic is split between proactive refresh in `auth()`, guarded reload-plus-refresh in `refresh_token()`, direct authority refresh in `refresh_token_from_authority_impl()`, and the `UnauthorizedRecovery` state machine used after 401s. Managed ChatGPT auth reloads only when account IDs match, then refreshes via OAuth and persists new tokens; external ChatGPT auth asks the configured `ExternalAuth` provider for new tokens and writes them to ephemeral storage; external bearer/API-key auth reruns the provider without touching disk. The file also enforces forced login method and workspace restrictions, revokes tokens on logout when requested, and carefully clears both ephemeral and persistent stores so stale credentials do not survive mode changes.

#### Function details

##### `CodexAuth::eq`  (lines 67–73)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Implements custom equality for `CodexAuth`, comparing some variants by payload and others only by auth mode. This keeps refresh and cache-change semantics intentionally coarse for most auth types.

**Data flow**: It receives two `CodexAuth` references. For `PersonalAccessToken` and `BedrockApiKey`, it compares the inner structs directly; for all other variants it compares `api_auth_mode()` values and returns that boolean.

**Call relations**: This equality feeds broader auth-change detection in the manager. More exact comparisons for refresh scoping are handled separately by `AuthManager::auths_equal_for_refresh`.

*Call graph*: calls 1 internal fn (api_auth_mode); 1 external calls (api_auth_mode).


##### `ExternalAuthTokens::access_token_only`  (lines 136–141)

```
fn access_token_only(access_token: impl Into<String>) -> Self
```

**Purpose**: Constructs an external-auth token bundle containing only a bearer token and no ChatGPT account metadata.

**Data flow**: It takes any value convertible into `String`, stores it as `access_token`, sets `chatgpt_metadata` to `None`, and returns the new `ExternalAuthTokens`.

**Call relations**: External bearer providers use this constructor when they supply API-key-style auth rather than ChatGPT account-backed tokens.

*Call graph*: called by 5 (external_auth_tokens_without_chatgpt_metadata_cannot_seed_chatgpt_auth, refresh, resolve, refresh, resolve); 1 external calls (into).


##### `ExternalAuthTokens::chatgpt`  (lines 143–155)

```
fn chatgpt(
        access_token: impl Into<String>,
        chatgpt_account_id: impl Into<String>,
        chatgpt_plan_type: Option<String>,
    ) -> Self
```

**Purpose**: Constructs an external-auth token bundle for ChatGPT-backed auth, including account and optional plan metadata.

**Data flow**: It accepts an access token, account id, and optional plan string, converts them into owned strings, wraps the account metadata in `ExternalAuthChatgptMetadata`, and returns `ExternalAuthTokens` with both token and metadata populated.

**Call relations**: This constructor is used when seeding or refreshing externally managed ChatGPT auth that must later be converted into `AuthDotJson`.

*Call graph*: called by 2 (refresh, from_external_access_token); 1 external calls (into).


##### `ExternalAuthTokens::chatgpt_metadata`  (lines 157–159)

```
fn chatgpt_metadata(&self) -> Option<&ExternalAuthChatgptMetadata>
```

**Purpose**: Exposes the optional ChatGPT metadata attached to an external token bundle.

**Data flow**: It reads `self.chatgpt_metadata` and returns it as `Option<&ExternalAuthChatgptMetadata>`.

**Call relations**: `AuthDotJson::from_external_tokens` uses this accessor to reject metadata-less tokens when constructing ChatGPT auth snapshots.

*Call graph*: called by 1 (from_external_tokens).


##### `ExternalAuth::resolve`  (lines 183–185)

```
fn resolve(&self) -> ExternalAuthFuture<'_, Option<ExternalAuthTokens>>
```

**Purpose**: Provides the trait’s default no-op resolution path for external auth providers that cannot synchronously supply cached credentials.

**Data flow**: It ignores `self` and returns a boxed async future that resolves to `Ok(None)`.

**Call relations**: Concrete external-auth implementations may override this; `AuthManager` calls it only when trying to resolve external API-key auth without forcing a refresh.

*Call graph*: 1 external calls (pin).


##### `RefreshTokenError::failed_reason`  (lines 197–202)

```
fn failed_reason(&self) -> Option<RefreshTokenFailedReason>
```

**Purpose**: Extracts the structured permanent failure reason when one exists.

**Data flow**: It matches on `self`, returning `Some(error.reason)` for `Permanent` and `None` for `Transient`.

**Call relations**: Callers use this to distinguish retryable transport failures from terminal refresh-token states such as expired or revoked.


##### `Error::from`  (lines 206–211)

```
fn from(err: RefreshTokenError) -> Self
```

**Purpose**: Converts `RefreshTokenError` into `std::io::Error`, preserving transient I/O errors and wrapping permanent refresh failures as generic I/O errors.

**Data flow**: It matches the incoming `RefreshTokenError`; `Permanent` becomes `std::io::Error::other(failed)`, while `Transient` yields the inner `std::io::Error` unchanged.

**Call relations**: This conversion lets refresh-related code interoperate with APIs that traffic only in `std::io::Result`.

*Call graph*: 1 external calls (other).


##### `CodexAuth::from_auth_dot_json`  (lines 215–280)

```
async fn from_auth_dot_json(
        codex_home: &Path,
        auth_dot_json: AuthDotJson,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<&str>,
```

**Purpose**: Reconstructs the correct runtime `CodexAuth` variant from a stored `AuthDotJson` payload and surrounding storage configuration.

**Data flow**: It takes the Codex home path, an owned `AuthDotJson`, storage mode preferences, optional ChatGPT base URL, and keyring backend kind. It resolves the effective mode via `auth_dot_json.resolved_mode()`, creates a shared HTTP client, then branches: API-key mode requires `openai_api_key`; agent identity requires `agent_identity` and verifies/loads it; personal access token requires `personal_access_token` and hydrates metadata; Bedrock requires `bedrock_api_key`; ChatGPT and ChatGPTAuthTokens build a `ChatgptAuthState` around the raw JSON and client, with managed ChatGPT additionally creating a storage backend using the payload’s effective storage mode. It returns the constructed `CodexAuth` or an `io::Error` if required fields are missing.

**Call relations**: This is the core deserialization bridge used by `load_auth` and tests. It delegates specialized validation/loading to agent-identity and personal-access-token helpers, while keeping storage-backed ChatGPT auth reconstruction local.

*Call graph*: calls 2 internal fn (create_client, create_auth_storage); called by 2 (refresh_failure_is_scoped_to_the_matching_auth_snapshot, load_auth); 13 external calls (new, new, to_path_buf, BedrockApiKey, Chatgpt, ChatgptAuthTokens, from_agent_identity_jwt, from_api_key, from_personal_access_token, other (+3 more)).


##### `CodexAuth::from_auth_storage`  (lines 282–297)

```
async fn from_auth_storage(
        codex_home: &Path,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<&str>,
        keyring_backend_kind: AuthKeyringB
```

**Purpose**: Loads auth from storage using the standard precedence rules and returns the reconstructed runtime auth, if any.

**Data flow**: It accepts the Codex home path, storage mode, optional ChatGPT base URL, and keyring backend kind, then calls `load_auth` with environment API-key override disabled and no forced workspace restriction. It returns the resulting `Option<CodexAuth>` inside `std::io::Result`.

**Call relations**: Status and CLI-mode readers use this convenience wrapper when they need the current stored auth without constructing a full `AuthManager`.

*Call graph*: calls 1 internal fn (load_auth); called by 5 (run_login_status, load_cli_auth_mode, prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens, missing_auth_json_returns_none, chatgpt_auth_tokens_for_tests).


##### `CodexAuth::from_agent_identity_jwt`  (lines 299–309)

```
async fn from_agent_identity_jwt(
        jwt: &str,
        chatgpt_base_url: Option<&str>,
    ) -> std::io::Result<Self>
```

**Purpose**: Validates an agent identity JWT against backend JWKS and converts it into runtime agent-identity auth.

**Data flow**: It takes a JWT string and optional ChatGPT base URL, normalizes the base URL against the default backend, calls `verified_agent_identity_record` to validate and decode the JWT, then asynchronously loads `AgentIdentityAuth` from the resulting record and wraps it in `CodexAuth::AgentIdentity`.

**Call relations**: This path is used both when loading stored auth and when interpreting access-token environment variables or login inputs that classify as agent identity JWTs.

*Call graph*: calls 2 internal fn (load, verified_agent_identity_record); called by 3 (load_exec_server_remote_auth_provider, assert_agent_identity_plan_alias, load_auth); 1 external calls (AgentIdentity).


##### `CodexAuth::from_personal_access_token`  (lines 311–315)

```
async fn from_personal_access_token(access_token: &str) -> std::io::Result<Self>
```

**Purpose**: Hydrates a personal access token into runtime auth by fetching its account metadata.

**Data flow**: It takes the raw access token string, awaits `PersonalAccessTokenAuth::load(access_token)`, and wraps the result in `CodexAuth::PersonalAccessToken`.

**Call relations**: This helper is used by storage loading and direct token login flows whenever a supplied token classifies as a PAT.

*Call graph*: calls 1 internal fn (load); 1 external calls (PersonalAccessToken).


##### `CodexAuth::auth_mode`  (lines 317–325)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Maps the runtime auth variant to the top-level protocol `AuthMode` exposed to the rest of the system.

**Data flow**: It matches on `self` and returns `ApiKey`, `Chatgpt`, `AgentIdentity`, `PersonalAccessToken`, or `BedrockApiKey`, collapsing both ChatGPT-backed variants into `AuthMode::Chatgpt`.

**Call relations**: Manager APIs and policy checks use this coarser mode when they only care about the broad auth family.

*Call graph*: called by 3 (auth_mode_name, is_api_key_auth, is_personal_access_token_auth).


##### `CodexAuth::api_auth_mode`  (lines 327–336)

```
fn api_auth_mode(&self) -> ApiAuthMode
```

**Purpose**: Maps the runtime auth variant to the more specific API auth mode, preserving the distinction between managed and external ChatGPT tokens.

**Data flow**: It matches on `self` and returns the corresponding `ApiAuthMode` variant, including `ChatgptAuthTokens` and `BedrockApiKey`.

**Call relations**: This finer-grained mode is used in equality, backend eligibility, and refresh logic where managed and external ChatGPT auth differ.

*Call graph*: called by 4 (build_remote_plugin_detail, eq, is_chatgpt_auth, uses_codex_backend).


##### `CodexAuth::is_api_key_auth`  (lines 338–340)

```
fn is_api_key_auth(&self) -> bool
```

**Purpose**: Reports whether the current auth is plain API-key auth.

**Data flow**: It calls `self.auth_mode()` and compares the result to `AuthMode::ApiKey`.

**Call relations**: Refresh and capability checks use this to short-circuit logic that only applies to token-backed auth.

*Call graph*: calls 1 internal fn (auth_mode); called by 1 (is_supported_exec_server_remote_auth).


##### `CodexAuth::is_personal_access_token_auth`  (lines 342–344)

```
fn is_personal_access_token_auth(&self) -> bool
```

**Purpose**: Reports whether the current auth is a personal access token.

**Data flow**: It calls `self.auth_mode()` and compares the result to `AuthMode::PersonalAccessToken`.

**Call relations**: Unauthorized-recovery and refresh code uses this to avoid offering unsupported refresh behavior for PAT auth.

*Call graph*: calls 1 internal fn (auth_mode).


##### `CodexAuth::is_chatgpt_auth`  (lines 346–348)

```
fn is_chatgpt_auth(&self) -> bool
```

**Purpose**: Reports whether the auth mode belongs to the ChatGPT-backed family.

**Data flow**: It calls `self.api_auth_mode()` and returns the result of `has_chatgpt_account()` on that mode.

**Call relations**: Capability checks use this helper when they need to know whether account-backed ChatGPT semantics apply.

*Call graph*: calls 1 internal fn (api_auth_mode); called by 1 (is_supported_exec_server_remote_auth).


##### `CodexAuth::uses_codex_backend`  (lines 350–352)

```
fn uses_codex_backend(&self) -> bool
```

**Purpose**: Reports whether the current auth mode targets the Codex backend rather than direct provider auth.

**Data flow**: It calls `self.api_auth_mode()` and returns `uses_codex_backend()` on that mode.

**Call relations**: Higher-level feature gating uses this to decide whether backend-dependent functionality is available.

*Call graph*: calls 1 internal fn (api_auth_mode); called by 1 (cloud_config_eligible_auth).


##### `CodexAuth::is_external_chatgpt_tokens`  (lines 354–356)

```
fn is_external_chatgpt_tokens(&self) -> bool
```

**Purpose**: Identifies the externally managed ChatGPT-token variant.

**Data flow**: It pattern-matches `self` against `Self::ChatgptAuthTokens(_)` and returns the boolean result.

**Call relations**: The manager uses this to choose external unauthorized-recovery behavior and persistence rules.

*Call graph*: 1 external calls (matches!).


##### `CodexAuth::supports_unauthorized_recovery`  (lines 358–360)

```
fn supports_unauthorized_recovery(&self) -> bool
```

**Purpose**: Indicates whether 401 recovery steps are meaningful for this auth snapshot.

**Data flow**: It returns true only for `Chatgpt` and `ChatgptAuthTokens` variants via pattern matching.

**Call relations**: `UnauthorizedRecovery` consults this before offering reload/refresh steps.

*Call graph*: 1 external calls (matches!).


##### `CodexAuth::api_key`  (lines 363–372)

```
fn api_key(&self) -> Option<&str>
```

**Purpose**: Returns the raw API key string only for plain API-key auth.

**Data flow**: It matches on `self`; for `ApiKey` it returns `Some(&str)` borrowed from the inner `ApiKeyAuth`, and for all other variants it returns `None`.

**Call relations**: Equality and downstream auth-provider construction use this accessor when they need the direct bearer string for API-key auth.


##### `CodexAuth::get_token_data`  (lines 375–385)

```
fn get_token_data(&self) -> Result<TokenData, std::io::Error>
```

**Purpose**: Extracts stored ChatGPT token data from token-backed auth snapshots and errors for other auth types or incomplete state.

**Data flow**: It calls `get_current_auth_json()`, matches for an `AuthDotJson` containing both `tokens: Some(...)` and `last_refresh: Some(_)`, and returns the `TokenData`; otherwise it returns `std::io::Error::other("Token data is not available.")`.

**Call relations**: `get_token` and other token-backed operations rely on this helper to enforce that only ChatGPT-style auth exposes OAuth token data.

*Call graph*: calls 1 internal fn (get_current_auth_json); called by 1 (get_token); 1 external calls (other).


##### `CodexAuth::get_token`  (lines 388–403)

```
fn get_token(&self) -> Result<String, std::io::Error>
```

**Purpose**: Returns the bearer token string appropriate for request authorization when the auth type exposes one.

**Data flow**: For `ApiKey`, it clones and returns the API key. For ChatGPT variants, it calls `get_token_data()` and returns the `access_token`. For `PersonalAccessToken`, it clones the PAT string from the inner auth. For `AgentIdentity` and `BedrockApiKey`, it returns descriptive `io::Error::other(...)` values because those modes do not expose a Codex bearer token.

**Call relations**: Auth-provider construction and request code use this as the generic bearer-token accessor across supported auth families.

*Call graph*: calls 1 internal fn (get_token_data); called by 1 (auth_provider_from_auth); 1 external calls (other).


##### `CodexAuth::get_account_id`  (lines 406–412)

```
fn get_account_id(&self) -> Option<String>
```

**Purpose**: Returns the account/workspace identifier when the auth type carries one.

**Data flow**: For `AgentIdentity` and `PersonalAccessToken`, it clones the account id from the hydrated auth object. For other variants, it falls back to `get_current_token_data()` and returns the optional `account_id` from token data.

**Call relations**: Workspace restriction enforcement, identity reporting, and guarded reload logic depend on this accessor.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 5 (connector_directory_cache_context, auth_identity, global, ensure_unlisted_workspace_target, auth_provider_from_auth).


##### `CodexAuth::is_fedramp_account`  (lines 415–423)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: Reports whether the current auth belongs to a FedRAMP account when that claim is available.

**Data flow**: For `AgentIdentity` and `PersonalAccessToken`, it delegates to the hydrated auth object. For token-backed ChatGPT auth, it checks whether current token data exists and whether `id_token.is_fedramp_account()` is true; otherwise it returns false.

**Call relations**: Downstream auth-provider and policy code uses this to tailor behavior for FedRAMP accounts.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 1 (auth_provider_from_auth).


##### `CodexAuth::get_account_email`  (lines 426–432)

```
fn get_account_email(&self) -> Option<String>
```

**Purpose**: Returns the account email address when present in the auth payload.

**Data flow**: For `AgentIdentity` and `PersonalAccessToken`, it clones the email from the hydrated auth object. Otherwise it reads `get_current_token_data()` and returns the optional `id_token.email`.

**Call relations**: Identity-reporting code uses this helper when displaying or caching account metadata.

*Call graph*: calls 1 internal fn (get_current_token_data).


##### `CodexAuth::get_chatgpt_user_id`  (lines 435–443)

```
fn get_chatgpt_user_id(&self) -> Option<String>
```

**Purpose**: Returns the ChatGPT user identifier when the auth type exposes one.

**Data flow**: For `AgentIdentity` and `PersonalAccessToken`, it clones the hydrated `chatgpt_user_id`. Otherwise it reads `get_current_token_data()` and returns the optional `id_token.chatgpt_user_id`.

**Call relations**: Connector and identity contexts use this accessor to associate runtime state with a ChatGPT user.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 3 (connector_directory_cache_context, auth_identity, global).


##### `CodexAuth::account_plan_type`  (lines 448–462)

```
fn account_plan_type(&self) -> Option<AccountPlanType>
```

**Purpose**: Derives the high-level account plan classification from the current auth snapshot.

**Data flow**: For `AgentIdentity` and `PersonalAccessToken`, it returns the hydrated auth’s plan type directly. Otherwise it reads current token data and maps `id_token.chatgpt_plan_type` through `AccountPlanType::from`, defaulting to `AccountPlanType::Unknown` when absent.

**Call relations**: Workspace-account checks and feature gating use this normalized plan classification.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 2 (cloud_config_eligible_auth, is_workspace_account).


##### `CodexAuth::is_workspace_account`  (lines 464–467)

```
fn is_workspace_account(&self) -> bool
```

**Purpose**: Reports whether the current account plan corresponds to a workspace-backed account.

**Data flow**: It calls `account_plan_type()` and returns whether the resulting plan exists and `is_workspace_account()` is true.

**Call relations**: Higher-level account-context code uses this helper to distinguish workspace accounts from personal plans.

*Call graph*: calls 1 internal fn (account_plan_type); called by 2 (connector_directory_cache_context, global).


##### `CodexAuth::get_current_auth_json`  (lines 470–481)

```
fn get_current_auth_json(&self) -> Option<AuthDotJson>
```

**Purpose**: Returns the currently cached raw `AuthDotJson` only for token-backed ChatGPT auth variants.

**Data flow**: It matches `self`; for `Chatgpt` and `ChatgptAuthTokens` it locks the inner `Mutex<Option<AuthDotJson>>`, clones the stored value, and returns it. For all other variants it returns `None`.

**Call relations**: Token extraction, equality-for-refresh, and logout-with-revoke use this to inspect the exact stored ChatGPT auth snapshot.

*Call graph*: called by 2 (get_current_token_data, get_token_data).


##### `CodexAuth::get_current_token_data`  (lines 484–486)

```
fn get_current_token_data(&self) -> Option<TokenData>
```

**Purpose**: Convenience accessor for the `TokenData` embedded in the current ChatGPT auth snapshot.

**Data flow**: It calls `get_current_auth_json()` and, if present, returns the `tokens` field from the cloned `AuthDotJson`.

**Call relations**: Account metadata accessors and plan/fedramp checks build on this helper.

*Call graph*: calls 1 internal fn (get_current_auth_json); called by 5 (account_plan_type, get_account_email, get_account_id, get_chatgpt_user_id, is_fedramp_account).


##### `CodexAuth::create_dummy_chatgpt_auth_for_testing`  (lines 489–517)

```
fn create_dummy_chatgpt_auth_for_testing() -> Self
```

**Purpose**: Creates a synthetic managed ChatGPT auth snapshot backed by ephemeral storage for tests.

**Data flow**: It constructs an `AuthDotJson` with `auth_mode: Chatgpt`, fixed token strings, a default `id_token`, `last_refresh: Some(Utc::now())`, and no other credential fields. It creates a default HTTP client, wraps the JSON in `ChatgptAuthState`, allocates a unique dummy storage path using `NEXT_DUMMY_AUTH_ID`, creates ephemeral auth storage there, and returns `CodexAuth::Chatgpt` containing both state and storage.

**Call relations**: Many tests use this helper to obtain a realistic ChatGPT auth object without hitting real storage or network refresh flows.

*Call graph*: calls 3 internal fn (default, create_client, create_auth_storage); called by 139 (capture_file_writes_exact_serialized_request, capture_file_writes_final_batches_as_separate_lines, remote_control_auth_manager, remote_control_auth_manager_with_home, remote_control_auth_manager, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items, effective_mcp_servers_preserve_runtime_servers, expands_cached_remote_plugins_by_loaded_apps (+15 more)); 7 external calls (new, default, new, from, Chatgpt, now, format!).


##### `CodexAuth::from_api_key`  (lines 519–523)

```
fn from_api_key(api_key: &str) -> Self
```

**Purpose**: Constructs runtime API-key auth from a raw key string.

**Data flow**: It clones the input `&str` into an owned `String` inside `ApiKeyAuth` and returns `CodexAuth::ApiKey`.

**Call relations**: Environment-variable loading, external bearer resolution, and tests use this as the simplest auth constructor.

*Call graph*: called by 65 (refresh_test_state, load_cli_auth_mode, exec_server_remote_auth_accepts_api_key_auth, returns_api_curated_fallback_plugins_for_direct_provider_auth, interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent, new_with_config, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_releases_slot_after_resume_failure (+15 more)); 1 external calls (ApiKey).


##### `ChatgptAuth::current_auth_json`  (lines 527–530)

```
fn current_auth_json(&self) -> Option<AuthDotJson>
```

**Purpose**: Returns the current raw ChatGPT auth snapshot stored inside a managed ChatGPT auth object.

**Data flow**: It locks `self.state.auth_dot_json`, clones the `Option<AuthDotJson>`, and returns it.

**Call relations**: Managed ChatGPT refresh logic uses this to inspect current tokens and timestamps.

*Call graph*: called by 1 (current_token_data).


##### `ChatgptAuth::current_token_data`  (lines 532–534)

```
fn current_token_data(&self) -> Option<TokenData>
```

**Purpose**: Returns the current `TokenData` from a managed ChatGPT auth object, if present.

**Data flow**: It calls `current_auth_json()` and extracts the `tokens` field from the returned `AuthDotJson`.

**Call relations**: `AuthManager::refresh_token_from_authority_impl` uses this to obtain the refresh token before contacting the OAuth authority.

*Call graph*: calls 1 internal fn (current_auth_json).


##### `ChatgptAuth::storage`  (lines 536–538)

```
fn storage(&self) -> &Arc<dyn AuthStorageBackend>
```

**Purpose**: Exposes the storage backend associated with managed ChatGPT auth.

**Data flow**: It returns a shared reference to the inner `Arc<dyn AuthStorageBackend>`.

**Call relations**: Token persistence code uses this backend to write refreshed OAuth tokens back to storage.

*Call graph*: called by 1 (refresh_and_persist_chatgpt_token).


##### `ChatgptAuth::client`  (lines 540–542)

```
fn client(&self) -> &CodexHttpClient
```

**Purpose**: Exposes the HTTP client associated with managed ChatGPT auth.

**Data flow**: It returns a shared reference to the inner `CodexHttpClient` stored in `ChatgptAuthState`.

**Call relations**: Refresh code passes this client into the OAuth token-refresh request helper.

*Call graph*: called by 1 (refresh_and_persist_chatgpt_token).


##### `read_openai_api_key_from_env`  (lines 549–554)

```
fn read_openai_api_key_from_env() -> Option<String>
```

**Purpose**: Reads and trims the legacy `OPENAI_API_KEY` environment variable, ignoring empty values.

**Data flow**: It reads `OPENAI_API_KEY_ENV_VAR` from the environment, trims whitespace, converts to `String`, filters out empty strings, and returns `Option<String>`.

**Call relations**: This helper exists alongside Codex-specific env readers, though the main auth-loading precedence in this file uses the Codex-specific variables.

*Call graph*: 1 external calls (var).


##### `read_codex_api_key_from_env`  (lines 556–558)

```
fn read_codex_api_key_from_env() -> Option<String>
```

**Purpose**: Reads the `CODEX_API_KEY` environment variable as a non-empty trimmed string.

**Data flow**: It delegates to `read_non_empty_env_var(CODEX_API_KEY_ENV_VAR)` and returns the resulting `Option<String>`.

**Call relations**: `load_auth` checks this first when environment API-key override is enabled, giving it highest precedence.

*Call graph*: calls 1 internal fn (read_non_empty_env_var); called by 1 (load_auth).


##### `read_codex_access_token_from_env`  (lines 560–562)

```
fn read_codex_access_token_from_env() -> Option<String>
```

**Purpose**: Reads the `CODEX_ACCESS_TOKEN` environment variable as a non-empty trimmed string.

**Data flow**: It delegates to `read_non_empty_env_var(CODEX_ACCESS_TOKEN_ENV_VAR)` and returns the resulting `Option<String>`.

**Call relations**: `load_auth` consults this after ephemeral storage and before persistent storage to support externally supplied access tokens.

*Call graph*: calls 1 internal fn (read_non_empty_env_var); called by 1 (load_auth).


##### `read_non_empty_env_var`  (lines 564–569)

```
fn read_non_empty_env_var(key: &str) -> Option<String>
```

**Purpose**: Shared helper for reading, trimming, and rejecting empty environment-variable values.

**Data flow**: It takes an env-var key, reads it with `env::var`, trims whitespace from the value, converts it to `String`, filters out empty strings, and returns `Option<String>`.

**Call relations**: Both Codex-specific env readers use this helper to enforce identical trimming and emptiness rules.

*Call graph*: called by 2 (read_codex_access_token_from_env, read_codex_api_key_from_env); 1 external calls (var).


##### `verified_agent_identity_record`  (lines 571–581)

```
async fn verified_agent_identity_record(
    jwt: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<AgentIdentityAuthRecord>
```

**Purpose**: Validates an agent identity JWT structurally and cryptographically, then converts its claims into a storage record.

**Data flow**: It first checks the JWT shape with `AgentIdentityAuthRecord::from_agent_identity_jwt(jwt)?`, then fetches JWKS using `fetch_agent_identity_jwks(&build_reqwest_client(), chatgpt_base_url)`, decodes and verifies the JWT with `decode_agent_identity_jwt`, and converts the verified claims into `AgentIdentityAuthRecord`.

**Call relations**: Agent-identity login and auth loading both delegate to this helper before constructing runtime auth.

*Call graph*: calls 2 internal fn (build_reqwest_client, from_agent_identity_jwt); called by 2 (from_agent_identity_jwt, login_with_access_token); 2 external calls (decode_agent_identity_jwt, fetch_agent_identity_jwks).


##### `logout`  (lines 585–596)

```
fn logout(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool>
```

**Purpose**: Deletes the auth payload from the selected storage backend and reports whether anything was removed.

**Data flow**: It takes the Codex home path plus storage-selection parameters, creates the corresponding auth storage backend with `create_auth_storage`, and returns `storage.delete()`.

**Call relations**: Higher-level logout helpers call this directly or via `logout_all_stores` to clear managed or ephemeral auth.

*Call graph*: calls 1 internal fn (create_auth_storage); called by 1 (logout_all_stores); 1 external calls (to_path_buf).


##### `logout_with_revoke`  (lines 598–622)

```
async fn logout_with_revoke(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool>
```

**Purpose**: Attempts token revocation before clearing all auth stores, tolerating revocation/load failures with warnings.

**Data flow**: It loads raw stored auth via `load_auth_dot_json`; if loading fails it logs a warning and proceeds with `None`. It then calls `revoke_auth_tokens(auth_dot_json.as_ref()).await`, logging but ignoring revocation errors, and finally calls `logout_all_stores` to remove credentials from storage.

**Call relations**: This is the write-side logout path for callers that want best-effort server-side token revocation in addition to local deletion.

*Call graph*: calls 3 internal fn (load_auth_dot_json, logout_all_stores, revoke_auth_tokens); 1 external calls (warn!).


##### `login_with_api_key`  (lines 625–646)

```
fn login_with_api_key(
    codex_home: &Path,
    api_key: &str,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()>
```

**Purpose**: Persists a storage snapshot containing only an OpenAI API key.

**Data flow**: It takes the Codex home path, raw API key, and storage-selection parameters, constructs an `AuthDotJson` with `auth_mode: Some(ApiKey)`, `openai_api_key` populated, and all other credential fields `None`, then passes it to `save_auth`.

**Call relations**: CLI/API-key login flows and tests use this helper; it mirrors the Bedrock login helper but targets the OpenAI API-key field.

*Call graph*: calls 1 internal fn (save_auth).


##### `login_with_access_token`  (lines 649–696)

```
async fn login_with_access_token(
    codex_home: &Path,
    access_token: &str,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    forced_chatgpt_workspace_id: Option<&[String]>,
    chat
```

**Purpose**: Persists auth derived from a supplied access token, supporting both personal access tokens and agent identity JWTs.

**Data flow**: It classifies the input token with `classify_codex_access_token`. For a PAT, it hydrates `PersonalAccessTokenAuth`, enforces optional workspace restrictions, and builds an `AuthDotJson` with `personal_access_token` set and `auth_mode: None` for rollback compatibility. For an agent identity JWT, it verifies the token against the backend and builds an `AuthDotJson` with `auth_mode: Some(AgentIdentity)` and `agent_identity` set. It then persists the snapshot via `save_auth`.

**Call relations**: This is the generic access-token login path used when the caller provides a token string whose exact auth family must be inferred.

*Call graph*: calls 5 internal fn (classify_codex_access_token, ensure_personal_access_token_workspace_allowed, save_auth, verified_agent_identity_record, load).


##### `ensure_personal_access_token_workspace_allowed`  (lines 698–704)

```
fn ensure_personal_access_token_workspace_allowed(
    expected_workspace_ids: Option<&[String]>,
    auth: &PersonalAccessTokenAuth,
) -> std::io::Result<()>
```

**Purpose**: Rejects a personal access token whose account/workspace id is not in the allowed set.

**Data flow**: It takes an optional slice of expected workspace ids and a hydrated `PersonalAccessTokenAuth`, calls `crate::server::ensure_workspace_account_allowed(expected_workspace_ids, auth.account_id())`, and maps any returned message into `std::io::ErrorKind::PermissionDenied`.

**Call relations**: PAT login and PAT loading both call this helper so workspace restrictions are enforced consistently regardless of credential source.

*Call graph*: calls 2 internal fn (account_id, ensure_workspace_account_allowed); called by 2 (load_auth, login_with_access_token).


##### `login_with_chatgpt_auth_tokens`  (lines 707–724)

```
fn login_with_chatgpt_auth_tokens(
    codex_home: &Path,
    access_token: &str,
    chatgpt_account_id: &str,
    chatgpt_plan_type: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Seeds ephemeral storage with externally managed ChatGPT access tokens and metadata.

**Data flow**: It takes the Codex home path, access token, ChatGPT account id, and optional plan type, constructs an `AuthDotJson` via `AuthDotJson::from_external_access_token`, and saves it using `AuthCredentialsStoreMode::Ephemeral` and the default keyring backend.

**Call relations**: External parent applications use this path to hand ChatGPT auth into Codex without writing managed persistent credentials.

*Call graph*: calls 2 internal fn (default, save_auth); 1 external calls (from_external_access_token).


##### `save_auth`  (lines 727–739)

```
fn save_auth(
    codex_home: &Path,
    auth: &AuthDotJson,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()>
```

**Purpose**: Persists an `AuthDotJson` snapshot using the selected storage backend.

**Data flow**: It takes the Codex home path, borrowed auth payload, storage mode, and keyring backend kind, creates the backend with `create_auth_storage`, and calls `storage.save(auth)`.

**Call relations**: All login helpers and external-auth refresh persistence funnel through this shared write helper.

*Call graph*: calls 1 internal fn (create_auth_storage); called by 5 (login_with_bedrock_api_key, refresh_external_auth, login_with_access_token, login_with_api_key, login_with_chatgpt_auth_tokens); 1 external calls (to_path_buf).


##### `load_auth_dot_json`  (lines 746–757)

```
fn load_auth_dot_json(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads the raw stored auth payload from the selected backend without applying environment overrides or runtime reconstruction.

**Data flow**: It creates the storage backend from the supplied path and storage parameters, then returns `storage.load()` as `std::io::Result<Option<AuthDotJson>>`.

**Call relations**: Maintenance code and tests use this when they need the exact serialized payload rather than a reconstructed `CodexAuth`.

*Call graph*: calls 1 internal fn (create_auth_storage); called by 1 (logout_with_revoke); 1 external calls (to_path_buf).


##### `enforce_login_restrictions`  (lines 769–865)

```
async fn enforce_login_restrictions(config: &AuthConfig) -> std::io::Result<()>
```

**Purpose**: Checks the currently loaded auth against forced login-method and workspace restrictions, logging the user out with an explanatory error when violated.

**Data flow**: It loads auth with environment API-key override enabled. If no auth exists, it returns `Ok(())`. If `forced_login_method` is set, it compares the required method against `auth.auth_mode()` and, on mismatch, calls `logout_with_message` with a specific explanation. If `forced_chatgpt_workspace_id` is set, it derives the current workspace/account id from the auth variant, handling token-load failures by logging out, and compares it against the allowed list; mismatches also trigger `logout_with_message`. Otherwise it returns `Ok(())`.

**Call relations**: Startup/config enforcement code calls this after configuration is resolved. It depends on `load_auth` for precedence-aware loading and on `logout_with_message` to both clear credentials and surface the reason.

*Call graph*: calls 2 internal fn (load_auth, logout_with_message); 1 external calls (format!).


##### `logout_with_message`  (lines 867–885)

```
fn logout_with_message(
    codex_home: &Path,
    message: String,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<()
```

**Purpose**: Clears auth from all relevant stores and returns an `io::Error` carrying the supplied logout reason.

**Data flow**: It takes the Codex home path, a human-readable message, and storage parameters, calls `logout_all_stores`, and then returns `Err(std::io::Error::other(...))`. If store removal failed, it appends the deletion failure text to the original message.

**Call relations**: Restriction enforcement uses this helper to force logout while preserving a user-facing explanation of why credentials were invalidated.

*Call graph*: calls 1 internal fn (logout_all_stores); called by 1 (enforce_login_restrictions); 2 external calls (other, format!).


##### `logout_all_stores`  (lines 887–910)

```
fn logout_all_stores(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool>
```

**Purpose**: Removes auth from both ephemeral and managed stores so no stale credentials remain active.

**Data flow**: If the configured storage mode is already `Ephemeral`, it deletes only the ephemeral store. Otherwise it first deletes the ephemeral store using default keyring settings, then deletes the configured managed store, and returns whether either deletion removed something.

**Call relations**: Both logout paths and forced-logout helpers use this to ensure external ephemeral auth does not survive alongside cleared persistent auth.

*Call graph*: calls 2 internal fn (default, logout); called by 4 (logout, logout_with_revoke, logout_with_message, logout_with_revoke).


##### `load_auth`  (lines 912–990)

```
async fn load_auth(
    codex_home: &Path,
    enable_codex_api_key_env: bool,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    forced_chatgpt_workspace_id: Option<&[String]>,
    chatgp
```

**Purpose**: Implements the full auth-loading precedence order across environment variables, ephemeral external auth, access-token env auth, and persistent storage.

**Data flow**: It takes the Codex home path, a flag controlling `CODEX_API_KEY` precedence, storage mode, optional forced workspace ids, optional ChatGPT base URL, and keyring backend kind. It first returns `CodexAuth::from_api_key` if env API-key override is enabled and `CODEX_API_KEY` is set. Next it loads the ephemeral store and, if present, reconstructs auth via `CodexAuth::from_auth_dot_json`, enforcing PAT workspace restrictions when needed. Then it checks `CODEX_ACCESS_TOKEN`, classifies it as PAT or agent identity, hydrates/validates accordingly, and enforces PAT workspace restrictions. If the configured mode is ephemeral-only and nothing has been found, it returns `Ok(None)`. Otherwise it loads the persistent store, reconstructs auth from `AuthDotJson`, enforces PAT workspace restrictions if applicable, and returns the result.

**Call relations**: This is the central read path used by `AuthManager` construction, reloads, restriction enforcement, and direct storage-loading helpers.

*Call graph*: calls 10 internal fn (default, classify_codex_access_token, from_agent_identity_jwt, from_api_key, from_auth_dot_json, ensure_personal_access_token_workspace_allowed, read_codex_access_token_from_env, read_codex_api_key_from_env, load, create_auth_storage); called by 4 (load_auth_from_storage, new_with_workspace_restriction, from_auth_storage, enforce_login_restrictions); 2 external calls (to_path_buf, PersonalAccessToken).


##### `persist_tokens`  (lines 993–1016)

```
fn persist_tokens(
    storage: &Arc<dyn AuthStorageBackend>,
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
) -> std::io::Result<AuthDotJson>
```

**Purpose**: Updates stored ChatGPT token fields and `last_refresh` in auth storage after a successful refresh.

**Data flow**: It loads the current `AuthDotJson` from the provided storage backend, errors if none exists, ensures a `TokenData` struct is present, optionally parses and replaces the `id_token` claims, overwrites provided `access_token` and `refresh_token` fields, sets `last_refresh` to `Utc::now()`, saves the updated payload back to storage, and returns the updated `AuthDotJson`.

**Call relations**: Managed ChatGPT refresh uses this helper after receiving new OAuth tokens from the authority.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); called by 1 (refresh_and_persist_chatgpt_token); 2 external calls (now, other).


##### `request_chatgpt_token_refresh`  (lines 1020–1061)

```
async fn request_chatgpt_token_refresh(
    refresh_token: String,
    client: &CodexHttpClient,
) -> Result<RefreshResponse, RefreshTokenError>
```

**Purpose**: Calls the OAuth refresh-token endpoint and classifies success, permanent refresh-token failures, and transient transport/decoding failures.

**Data flow**: It builds a `RefreshRequest` containing `oauth_client_id()`, grant type `refresh_token`, and the supplied refresh token, then posts JSON to `refresh_token_endpoint()` using the provided `CodexHttpClient`. On success it decodes and returns `RefreshResponse`. On non-success it reads the response body, logs the failure, classifies the body with `classify_refresh_token_failure`, and returns either `RefreshTokenError::Permanent` for unauthorized/known refresh-token failures or `RefreshTokenError::Transient` with a parsed message for other statuses. Transport and JSON-decoding errors are also mapped to transient errors.

**Call relations**: `AuthManager::refresh_and_persist_chatgpt_token` delegates the network portion of managed ChatGPT refresh to this helper.

*Call graph*: calls 5 internal fn (post, classify_refresh_token_failure, oauth_client_id, refresh_token_endpoint, try_parse_error_message); called by 1 (refresh_and_persist_chatgpt_token); 5 external calls (other, format!, Permanent, Transient, error!).


##### `classify_refresh_token_failure`  (lines 1063–1090)

```
fn classify_refresh_token_failure(body: &str) -> RefreshTokenFailedError
```

**Purpose**: Maps backend refresh-token error codes into structured `RefreshTokenFailedError` values with user-facing messages.

**Data flow**: It extracts an optional backend code from the response body via `extract_refresh_token_error_code`, lowercases it, maps known codes (`refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`) to specific `RefreshTokenFailedReason` variants, logs a warning for unknown codes, selects the corresponding canned message constant, and returns `RefreshTokenFailedError::new(reason, message)`.

**Call relations**: The OAuth refresh request helper uses this to decide whether a failed refresh should be treated as permanent and what message should be surfaced.

*Call graph*: calls 2 internal fn (extract_refresh_token_error_code, new); called by 1 (request_chatgpt_token_refresh); 1 external calls (warn!).


##### `extract_refresh_token_error_code`  (lines 1092–1116)

```
fn extract_refresh_token_error_code(body: &str) -> Option<String>
```

**Purpose**: Pulls a refresh-token error code out of a JSON response body in several supported shapes.

**Data flow**: It returns `None` for empty bodies or non-object JSON. For object bodies, it first inspects `error`: if that field is an object with a string `code`, it returns that; if `error` itself is a string, it returns it; otherwise it falls back to a top-level string `code` field.

**Call relations**: Only `classify_refresh_token_failure` calls this helper to normalize backend error payloads.

*Call graph*: called by 1 (classify_refresh_token_failure).


##### `oauth_client_id`  (lines 1135–1140)

```
fn oauth_client_id() -> String
```

**Purpose**: Returns the OAuth client id used for token refresh, honoring an environment override when present.

**Data flow**: It reads `CLIENT_ID_OVERRIDE_ENV_VAR`, trims only by emptiness check, and returns the override if non-empty; otherwise it returns the built-in `CLIENT_ID` constant as a `String`.

**Call relations**: The refresh-token request builder uses this helper so tests or alternate deployments can override the OAuth client id.

*Call graph*: called by 2 (request_chatgpt_token_refresh, client_id); 1 external calls (var).


##### `refresh_token_endpoint`  (lines 1142–1145)

```
fn refresh_token_endpoint() -> String
```

**Purpose**: Returns the OAuth refresh endpoint URL, honoring an environment override.

**Data flow**: It reads `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR` and returns that value if set; otherwise it returns the default `REFRESH_TOKEN_URL`.

**Call relations**: The refresh-token request helper uses this to determine where to send OAuth refresh requests.

*Call graph*: called by 1 (request_chatgpt_token_refresh); 1 external calls (var).


##### `AuthDotJson::from_external_tokens`  (lines 1148–1179)

```
fn from_external_tokens(external: &ExternalAuthTokens) -> std::io::Result<Self>
```

**Purpose**: Converts externally supplied ChatGPT tokens plus metadata into an ephemeral `AuthDotJson` snapshot.

**Data flow**: It requires `external.chatgpt_metadata()` to be present, otherwise returns an error. It parses JWT claims from `external.access_token`, overwrites `chatgpt_account_id` with the supplied metadata account id, derives `chatgpt_plan_type` from metadata or parsed claims or an explicit `Unknown`, constructs `TokenData` with an empty refresh token and matching account id, and returns an `AuthDotJson` with `auth_mode: Some(ChatgptAuthTokens)`, `tokens` populated, `last_refresh: Some(Utc::now())`, and all other credential fields `None`.

**Call relations**: External ChatGPT login and refresh flows use this helper before saving the resulting auth snapshot into ephemeral storage.

*Call graph*: calls 2 internal fn (chatgpt_metadata, parse_chatgpt_jwt_claims); 4 external calls (Unknown, new, now, other).


##### `AuthDotJson::from_external_access_token`  (lines 1181–1192)

```
fn from_external_access_token(
        access_token: &str,
        chatgpt_account_id: &str,
        chatgpt_plan_type: Option<&str>,
    ) -> std::io::Result<Self>
```

**Purpose**: Convenience wrapper for building external ChatGPT auth from raw token and metadata strings.

**Data flow**: It takes an access token, account id, and optional plan type, constructs `ExternalAuthTokens::chatgpt(...)`, and delegates to `AuthDotJson::from_external_tokens`.

**Call relations**: `login_with_chatgpt_auth_tokens` uses this helper to seed ephemeral auth from parent-provided ChatGPT credentials.

*Call graph*: calls 1 internal fn (chatgpt); 1 external calls (from_external_tokens).


##### `AuthDotJson::resolved_mode`  (lines 1194–1208)

```
fn resolved_mode(&self) -> ApiAuthMode
```

**Purpose**: Infers the effective auth mode from explicit `auth_mode` or populated credential fields for backward compatibility.

**Data flow**: It returns `self.auth_mode` when present. Otherwise it checks fields in order: `personal_access_token`, `bedrock_api_key`, `openai_api_key`; if none are set it defaults to `ApiAuthMode::Chatgpt`.

**Call relations**: Auth reconstruction and storage-mode selection rely on this inference so older or partially explicit auth payloads still load correctly.

*Call graph*: called by 1 (storage_mode).


##### `AuthDotJson::storage_mode`  (lines 1210–1219)

```
fn storage_mode(
        &self,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
    ) -> AuthCredentialsStoreMode
```

**Purpose**: Determines which storage mode should be used for a given auth payload when reconstructing managed auth.

**Data flow**: It compares `self.resolved_mode()` to `ApiAuthMode::ChatgptAuthTokens`; external ChatGPT tokens force `AuthCredentialsStoreMode::Ephemeral`, while all other modes return the caller-provided storage mode.

**Call relations**: `CodexAuth::from_auth_dot_json` uses this to ensure externally managed ChatGPT tokens are always treated as ephemeral even if the caller prefers persistent storage.

*Call graph*: calls 1 internal fn (resolved_mode).


##### `CachedAuth::fmt`  (lines 1238–1252)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats cached auth state for debugging without dumping full credential contents.

**Data flow**: It writes a debug struct containing the current cached auth mode and, if present, the reason of any scoped permanent refresh failure, then finishes the struct.

**Call relations**: `AuthManager` debug output includes this representation to summarize auth state safely.

*Call graph*: 1 external calls (debug_struct).


##### `UnauthorizedRecoveryStepResult::auth_state_changed`  (lines 1308–1310)

```
fn auth_state_changed(&self) -> Option<bool>
```

**Purpose**: Returns whether the last unauthorized-recovery step changed auth state, when that concept applies.

**Data flow**: It reads and returns the stored `Option<bool>` field.

**Call relations**: Recovery callers inspect this after each step to decide whether retries should proceed with updated credentials.


##### `UnauthorizedRecovery::new`  (lines 1314–1336)

```
fn new(manager: Arc<AuthManager>) -> Self
```

**Purpose**: Initializes the 401-recovery state machine based on the manager’s current auth and external-auth configuration.

**Data flow**: It clones the manager `Arc`, snapshots the current cached auth, derives `expected_account_id` from that auth, chooses `UnauthorizedRecoveryMode::External` when external API-key auth is configured or the cached auth is external ChatGPT tokens, otherwise `Managed`, and sets the initial step to `ExternalRefresh` or `Reload` accordingly.

**Call relations**: `AuthManager::unauthorized_recovery` constructs this object when request code wants a stepwise recovery strategy after unauthorized responses.

*Call graph*: called by 1 (unauthorized_recovery).


##### `UnauthorizedRecovery::has_next`  (lines 1338–1357)

```
fn has_next(&self) -> bool
```

**Purpose**: Reports whether another recovery step is currently available.

**Data flow**: It checks several conditions in order: external API-key auth can continue until `Done`; non-refreshable or non-ChatGPT auth returns false; external mode without configured external auth returns false; otherwise it returns whether the current step is not `Done`.

**Call relations**: Callers use this before invoking `next`, and `next` itself guards against exhaustion by consulting it.

*Call graph*: called by 3 (recover_remote_control_auth, handle_unauthorized, next); 1 external calls (matches!).


##### `UnauthorizedRecovery::unavailable_reason`  (lines 1359–1395)

```
fn unavailable_reason(&self) -> &'static str
```

**Purpose**: Explains why unauthorized recovery is unavailable or exhausted using a stable string code.

**Data flow**: It inspects external API-key status, current cached auth type, external-auth presence, and current step, returning one of `ready`, `not_refreshable_auth`, `not_chatgpt_auth`, `no_external_auth`, or `recovery_exhausted`.

**Call relations**: Higher-level retry/reporting code uses this to log or surface why no further 401 recovery can be attempted.

*Call graph*: 1 external calls (matches!).


##### `UnauthorizedRecovery::mode_name`  (lines 1397–1402)

```
fn mode_name(&self) -> &'static str
```

**Purpose**: Returns a human-readable label for the recovery mode.

**Data flow**: It matches `self.mode` and returns either `managed` or `external`.

**Call relations**: Recovery logging uses this to describe which strategy is active.

*Call graph*: called by 1 (recover_remote_control_auth).


##### `UnauthorizedRecovery::step_name`  (lines 1404–1411)

```
fn step_name(&self) -> &'static str
```

**Purpose**: Returns a human-readable label for the current recovery step.

**Data flow**: It matches `self.step` and returns `reload`, `refresh_token`, `external_refresh`, or `done`.

**Call relations**: Recovery logging and diagnostics use this to describe progress through the state machine.

*Call graph*: called by 1 (recover_remote_control_auth).


##### `UnauthorizedRecovery::next`  (lines 1413–1470)

```
async fn next(&mut self) -> Result<UnauthorizedRecoveryStepResult, RefreshTokenError>
```

**Purpose**: Executes the current unauthorized-recovery step, advances the state machine, and reports whether auth changed.

**Data flow**: It first errors with a permanent `RefreshTokenError` if `has_next()` is false. For `Reload`, it awaits `manager.reload_if_account_id_matches(...)`; changed and unchanged reloads both advance to `RefreshToken` and return `auth_state_changed: Some(true/false)`, while a skipped reload advances to `Done` and returns a permanent account-mismatch error. For `RefreshToken`, it awaits `manager.refresh_token_from_authority()`, advances to `Done`, and reports `Some(true)`. For `ExternalRefresh`, it awaits `manager.refresh_external_auth(Unauthorized)`, advances to `Done`, and reports `Some(true)`. `Done` yields `auth_state_changed: None`.

**Call relations**: Request retry loops call this one step per unauthorized retry. It delegates actual reload and refresh work back into `AuthManager` while owning the sequencing policy.

*Call graph*: calls 2 internal fn (has_next, new); called by 2 (recover_remote_control_auth, handle_unauthorized); 1 external calls (Permanent).


##### `AuthManager::fmt`  (lines 1518–1535)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the manager’s configuration and coarse auth state for debugging.

**Data flow**: It writes a debug struct containing the Codex home path, cached auth summary, environment-override flag, storage settings, forced workspace restriction, ChatGPT base URL, and whether external auth is configured, then finishes non-exhaustively.

**Call relations**: This supports diagnostics when the manager is embedded in larger runtime state dumps.

*Call graph*: calls 1 internal fn (has_external_auth); 1 external calls (debug_struct).


##### `AuthManager::new`  (lines 1543–1559)

```
async fn new(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<String>,
        keyr
```

**Purpose**: Constructs an auth manager using the provided storage and environment settings, without workspace restriction.

**Data flow**: It takes the Codex home path, env-override flag, storage mode, optional ChatGPT base URL, and keyring backend kind, then delegates to `new_with_workspace_restriction` with `None` for forced workspace ids.

**Call relations**: Most production and test code uses this as the standard manager constructor.

*Call graph*: called by 12 (auth_manager_with_api_key, auth_manager_with_plan_and_identity, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_surfaces_auth_recovery_message, get_bundle_unauthorized_without_recovery_uses_generic_message, load_auth_manager, personal_access_token_does_not_offer_unauthorized_recovery, bedrock_only_auth_storage_creates_primary_auth, login_with_bedrock_api_key_replaces_openai_auth (+2 more)); 1 external calls (new_with_workspace_restriction).


##### `AuthManager::new_with_workspace_restriction`  (lines 1561–1596)

```
async fn new_with_workspace_restriction(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        forced_chatgpt_work
```

**Purpose**: Constructs an auth manager, eagerly loading initial auth and optionally enforcing workspace restrictions during load.

**Data flow**: It calls `load_auth` with the supplied configuration and optional forced workspace ids, swallowing load errors into `None`. It creates a watch channel initialized to revision 0, stores the loaded auth in `CachedAuth` with no permanent refresh failure, initializes the refresh semaphore with one permit, and starts with no external auth configured.

**Call relations**: This is the real constructor behind `new` and `shared_from_config`; tests also call it directly when they need workspace-restricted loading.

*Call graph*: calls 1 internal fn (load_auth); called by 2 (auth_manager_rejects_env_personal_access_token_workspace_mismatch, auth_manager_rejects_stored_personal_access_token_workspace_mismatch); 3 external calls (new, new, channel).


##### `AuthManager::from_auth_for_testing`  (lines 1599–1618)

```
fn from_auth_for_testing(auth: CodexAuth) -> Arc<Self>
```

**Purpose**: Builds an `Arc<AuthManager>` preloaded with a specific auth snapshot for tests.

**Data flow**: It wraps the supplied `CodexAuth` in `CachedAuth`, creates a watch channel, fills the manager with placeholder home/storage settings, a one-permit semaphore, and no external auth, then returns it inside `Arc`.

**Call relations**: Tests use this to bypass storage loading and start from a known in-memory auth state.

*Call graph*: calls 1 internal fn (default); called by 42 (refresh_test_state, model_client_with_counting_attestation, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, auth_manager_from_auth (+15 more)); 5 external calls (new, from, new, new, channel).


##### `AuthManager::from_auth_for_testing_with_home`  (lines 1621–1639)

```
fn from_auth_for_testing_with_home(auth: CodexAuth, codex_home: PathBuf) -> Arc<Self>
```

**Purpose**: Builds a test manager preloaded with auth and a caller-specified Codex home path.

**Data flow**: It mirrors `from_auth_for_testing` but stores the provided `codex_home` instead of a placeholder path.

**Call relations**: Tests that need both a seeded auth snapshot and a meaningful home directory use this variant.

*Call graph*: calls 1 internal fn (default); called by 1 (auth_manager_from_auth_with_home); 4 external calls (new, new, new, channel).


##### `AuthManager::external_bearer_only`  (lines 1641–1660)

```
fn external_bearer_only(config: ModelProviderAuthInfo) -> Arc<Self>
```

**Purpose**: Constructs a manager configured solely with command-based external bearer auth and no cached managed auth.

**Data flow**: It creates a watch channel, initializes `CachedAuth` with `auth: None`, fills placeholder home/storage settings, and installs `BearerTokenRefresher::new(config)` into `external_auth` as an `Arc<dyn ExternalAuth>`.

**Call relations**: Provider-auth integrations and tests use this constructor when auth should come exclusively from an external bearer command.

*Call graph*: calls 2 internal fn (default, new); called by 5 (external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero, external_bearer_only_auth_manager_returns_none_when_command_fails, external_bearer_only_auth_manager_uses_cached_provider_token, unauthorized_recovery_uses_external_refresh_for_bearer_manager, auth_manager_for_provider); 5 external calls (new, from, new, new, channel).


##### `AuthManager::auth_cached`  (lines 1663–1665)

```
fn auth_cached(&self) -> Option<CodexAuth>
```

**Purpose**: Returns the current cached auth snapshot without attempting reload or refresh.

**Data flow**: It reads the `inner` `RwLock`, clones the optional `CodexAuth`, and returns it, or `None` if the lock is unavailable.

**Call relations**: Most manager internals use this as the cheap read path before deciding whether more expensive refresh logic is needed.

*Call graph*: called by 9 (auth, auth_mode, get_api_auth_mode, is_external_chatgpt_auth_active, logout_with_revoke, refresh_external_auth, refresh_token, refresh_token_from_authority_impl, reload_if_account_id_matches).


##### `AuthManager::auth_change_receiver`  (lines 1668–1670)

```
fn auth_change_receiver(&self) -> watch::Receiver<u64>
```

**Purpose**: Subscribes to revisions that increment when auth changes in a way relevant to request recovery.

**Data flow**: It calls `self.auth_change_tx.subscribe()` and returns the resulting `watch::Receiver<u64>`.

**Call relations**: Long-lived request/retry components use this receiver to notice auth changes that may invalidate in-flight assumptions.

*Call graph*: 1 external calls (subscribe).


##### `AuthManager::refresh_failure_for_auth`  (lines 1672–1680)

```
fn refresh_failure_for_auth(&self, auth: &CodexAuth) -> Option<RefreshTokenFailedError>
```

**Purpose**: Returns a cached permanent refresh failure only when it applies to the exact auth snapshot supplied.

**Data flow**: It reads `inner`, inspects `permanent_refresh_failure`, compares the supplied auth against the stored failure’s auth using `auths_equal_for_refresh`, and returns a cloned `RefreshTokenFailedError` when they match.

**Call relations**: Refresh logic uses this to fail fast on repeated attempts against credentials already known to be permanently unrefreshable.

*Call graph*: called by 1 (refresh_token_from_authority_impl).


##### `AuthManager::auth`  (lines 1685–1698)

```
async fn auth(&self) -> Option<CodexAuth>
```

**Purpose**: Returns the current auth snapshot, resolving external API-key auth and proactively refreshing managed ChatGPT auth when needed.

**Data flow**: It first awaits `resolve_external_api_key_auth()` and returns that if present. Otherwise it clones `auth_cached()`. If the cached auth exists and `should_refresh_proactively(&auth)` is true, it awaits `refresh_token()`; on refresh failure it logs an error and returns the pre-refresh auth snapshot. On success or when no proactive refresh is needed, it returns the latest `auth_cached()`.

**Call relations**: Request paths call this as the main read API. It layers proactive refresh behavior on top of the cached snapshot and external-auth resolution.

*Call graph*: calls 3 internal fn (auth_cached, refresh_token, resolve_external_api_key_auth); called by 2 (send_track_events, rate_limits_check); 2 external calls (should_refresh_proactively, error!).


##### `AuthManager::reload`  (lines 1702–1706)

```
async fn reload(&self) -> bool
```

**Purpose**: Forces a fresh load from storage/environment precedence and updates the cached auth snapshot.

**Data flow**: It logs that auth is reloading, awaits `load_auth_from_storage()`, passes the result to `set_cached_auth`, and returns the boolean indicating whether the auth value changed.

**Call relations**: Logout, token refresh, and explicit reload callers use this to synchronize in-memory auth with storage.

*Call graph*: calls 2 internal fn (load_auth_from_storage, set_cached_auth); called by 4 (logout, logout_with_revoke, refresh_and_persist_chatgpt_token, refresh_external_auth); 1 external calls (info!).


##### `AuthManager::reload_if_account_id_matches`  (lines 1708–1741)

```
async fn reload_if_account_id_matches(
        &self,
        expected_account_id: Option<&str>,
    ) -> ReloadOutcome
```

**Purpose**: Reloads auth only when the newly loaded account id matches the expected current account, preventing cross-account token substitution.

**Data flow**: If `expected_account_id` is `None`, it logs and returns `ReloadOutcome::Skipped`. Otherwise it loads fresh auth, extracts the new account id, and compares it to the expected one. On mismatch it logs and returns `Skipped`. On match it compares the new auth to the cached auth using `auths_equal_for_refresh`, updates the cache via `set_cached_auth`, and returns `ReloadedChanged` or `ReloadedNoChange` accordingly.

**Call relations**: Managed unauthorized recovery and guarded refresh both use this to safely observe on-disk changes made by another process without accidentally switching accounts.

*Call graph*: calls 3 internal fn (auth_cached, load_auth_from_storage, set_cached_auth); called by 1 (refresh_token); 2 external calls (auths_equal_for_refresh, info!).


##### `AuthManager::auths_equal_for_refresh`  (lines 1743–1764)

```
fn auths_equal_for_refresh(a: Option<&CodexAuth>, b: Option<&CodexAuth>) -> bool
```

**Purpose**: Performs auth equality tuned for refresh scoping, comparing the exact credential snapshot relevant to refresh semantics.

**Data flow**: It compares two optional auth references. API keys compare by key string; ChatGPT variants compare by full current `AuthDotJson`; agent identity compares by record; personal access token and Bedrock compare by full variant equality; differing modes or presence return false.

**Call relations**: This stricter comparison underpins guarded reload decisions and permanent refresh-failure scoping.


##### `AuthManager::auths_equal`  (lines 1766–1772)

```
fn auths_equal(a: Option<&CodexAuth>, b: Option<&CodexAuth>) -> bool
```

**Purpose**: Performs ordinary cached-auth equality using `CodexAuth`’s `PartialEq` implementation.

**Data flow**: It compares two optional auth references, returning true for both `None`, delegating to `a == b` for two `Some` values, and false otherwise.

**Call relations**: `set_cached_auth` uses this coarser equality to decide whether the visible auth value changed.

*Call graph*: called by 1 (set_cached_auth).


##### `AuthManager::record_permanent_refresh_failure_if_unchanged`  (lines 1776–1791)

```
fn record_permanent_refresh_failure_if_unchanged(
        &self,
        attempted_auth: &CodexAuth,
        error: &RefreshTokenFailedError,
    )
```

**Purpose**: Caches a permanent refresh failure only if the auth snapshot that failed is still the one currently cached.

**Data flow**: It acquires the `inner` write lock, compares `attempted_auth` against the current cached auth using `auths_equal_for_refresh`, and if they match stores an `AuthScopedRefreshFailure` containing clones of the auth and error.

**Call relations**: `refresh_token_from_authority_impl` calls this after permanent failures so later retries against unchanged credentials can fail immediately.

*Call graph*: called by 1 (refresh_token_from_authority_impl); 3 external calls (auths_equal_for_refresh, clone, clone).


##### `AuthManager::load_auth_from_storage`  (lines 1793–1806)

```
async fn load_auth_from_storage(&self) -> Option<CodexAuth>
```

**Purpose**: Reloads auth using the manager’s stored configuration and current forced workspace restriction.

**Data flow**: It reads `forced_chatgpt_workspace_id()`, then awaits `load_auth` with the manager’s home path, env-override flag, storage mode, workspace restriction, ChatGPT base URL, and keyring backend kind. Errors are swallowed into `None`.

**Call relations**: Both `reload` and guarded reload use this helper to centralize configuration-aware loading.

*Call graph*: calls 2 internal fn (forced_chatgpt_workspace_id, load_auth); called by 2 (reload, reload_if_account_id_matches).


##### `AuthManager::set_cached_auth`  (lines 1808–1826)

```
fn set_cached_auth(&self, new_auth: Option<CodexAuth>) -> bool
```

**Purpose**: Replaces the cached auth snapshot, clears scoped refresh failures when the refresh-relevant auth changed, and notifies watchers.

**Data flow**: It acquires the `inner` write lock, compares previous and new auth using both `auths_equal` and `auths_equal_for_refresh`, clears `permanent_refresh_failure` when the refresh-relevant auth changed, logs whether the visible auth changed, stores the new auth, and increments the watch revision via `send_modify` when the refresh-relevant auth changed. It returns whether the visible auth changed.

**Call relations**: Reload paths funnel through this method so cache updates, failure invalidation, and watcher notifications stay consistent.

*Call graph*: calls 1 internal fn (auths_equal); called by 2 (reload, reload_if_account_id_matches); 3 external calls (auths_equal_for_refresh, send_modify, info!).


##### `AuthManager::set_external_auth`  (lines 1828–1832)

```
fn set_external_auth(&self, external_auth: Arc<dyn ExternalAuth>)
```

**Purpose**: Installs or replaces the manager’s external auth provider.

**Data flow**: It acquires the `external_auth` write lock and stores `Some(external_auth)`.

**Call relations**: Integrations can call this at runtime to attach an external auth source used by resolution and refresh flows.


##### `AuthManager::clear_external_auth`  (lines 1834–1838)

```
fn clear_external_auth(&self)
```

**Purpose**: Removes any configured external auth provider from the manager.

**Data flow**: It acquires the `external_auth` write lock and sets the stored value to `None`.

**Call relations**: Callers use this when external auth should no longer participate in auth resolution or unauthorized recovery.


##### `AuthManager::set_forced_chatgpt_workspace_id`  (lines 1840–1846)

```
fn set_forced_chatgpt_workspace_id(&self, workspace_id: Option<Vec<String>>)
```

**Purpose**: Updates the manager’s workspace restriction set when it changes.

**Data flow**: It acquires the `forced_chatgpt_workspace_id` write lock and replaces the stored `Option<Vec<String>>` only if the new value differs from the current one.

**Call relations**: Configuration-sync code can call this so future reloads and external refreshes enforce updated workspace restrictions.


##### `AuthManager::forced_chatgpt_workspace_id`  (lines 1848–1853)

```
fn forced_chatgpt_workspace_id(&self) -> Option<Vec<String>>
```

**Purpose**: Returns the current forced workspace restriction configured on the manager.

**Data flow**: It reads the `forced_chatgpt_workspace_id` lock, clones the optional vector, and returns it.

**Call relations**: Storage reload and external-auth refresh use this to enforce workspace restrictions consistently.

*Call graph*: called by 2 (load_auth_from_storage, refresh_external_auth).


##### `AuthManager::has_external_auth`  (lines 1855–1857)

```
fn has_external_auth(&self) -> bool
```

**Purpose**: Reports whether any external auth provider is currently configured.

**Data flow**: It calls the private `external_auth()` accessor and returns whether it is `Some`.

**Call relations**: Debug formatting and unauthorized-recovery availability checks use this helper.

*Call graph*: calls 1 internal fn (external_auth); called by 1 (fmt).


##### `AuthManager::is_external_chatgpt_auth_active`  (lines 1859–1863)

```
fn is_external_chatgpt_auth_active(&self) -> bool
```

**Purpose**: Reports whether the currently cached auth snapshot is externally managed ChatGPT tokens.

**Data flow**: It reads `auth_cached()` and returns whether the cached auth exists and `CodexAuth::is_external_chatgpt_tokens` is true.

**Call relations**: Callers use this to distinguish active external ChatGPT auth from merely having an external provider configured.

*Call graph*: calls 1 internal fn (auth_cached).


##### `AuthManager::codex_api_key_env_enabled`  (lines 1865–1867)

```
fn codex_api_key_env_enabled(&self) -> bool
```

**Purpose**: Exposes whether `CODEX_API_KEY` environment override is enabled for this manager.

**Data flow**: It returns the stored `enable_codex_api_key_env` boolean.

**Call relations**: Configuration/reporting code can inspect this to understand the manager’s auth precedence behavior.


##### `AuthManager::shared`  (lines 1870–1887)

```
async fn shared(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<String>,
        k
```

**Purpose**: Convenience constructor that returns a newly created manager wrapped in `Arc`.

**Data flow**: It awaits `Self::new(...)`, wraps the resulting manager in `Arc`, and returns it.

**Call relations**: Many long-lived runtime components use this constructor because they share the manager across tasks.

*Call graph*: called by 13 (list_remote_control_clients_recovers_auth_after_unauthorized, list_remote_control_clients_retries_unauthorized_only_once, remote_control_handle_discards_pairing_response_after_auth_change, remote_control_handle_recovers_auth_before_refreshing_pairing, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_start_allows_missing_auth_when_enabled, remote_control_waits_for_account_id_before_enrolling, connect_remote_control_websocket_recovers_after_unauthorized_enrollment, connect_remote_control_websocket_recovers_after_unauthorized_refresh, connect_remote_control_websocket_requires_chatgpt_auth (+3 more)); 2 external calls (new, new).


##### `AuthManager::shared_from_config`  (lines 1890–1905)

```
async fn shared_from_config(
        config: &impl AuthManagerConfig,
        enable_codex_api_key_env: bool,
    ) -> Arc<Self>
```

**Purpose**: Constructs a shared manager from an abstract config provider implementing `AuthManagerConfig`.

**Data flow**: It reads codex home, storage mode, keyring backend, forced workspace ids, and ChatGPT base URL from the config trait, passes them into `new_with_workspace_restriction`, wraps the result in `Arc`, and returns it.

**Call relations**: Startup/orchestration code uses this to build the manager from already-resolved application configuration without coupling `codex-login` to a concrete config type.

*Call graph*: called by 15 (start_uninitialized, build_test_processor, run_main_with_transport_options, chatgpt_get_request_with_timeout, apps_enabled, connector_auth, build_report, load_exec_server_remote_auth, run_debug_models_command, cached_directory_connectors_for_tool_suggest_with_auth (+5 more)); 7 external calls (new, new_with_workspace_restriction, auth_keyring_backend_kind, chatgpt_base_url, cli_auth_credentials_store_mode, codex_home, forced_chatgpt_workspace_id).


##### `AuthManager::unauthorized_recovery`  (lines 1907–1909)

```
fn unauthorized_recovery(self: &Arc<Self>) -> UnauthorizedRecovery
```

**Purpose**: Creates a new unauthorized-recovery state machine bound to this manager.

**Data flow**: It clones the manager `Arc` and passes it to `UnauthorizedRecovery::new`, returning the resulting recovery object.

**Call relations**: Request retry code calls this when it receives a 401 and wants to attempt managed or external auth recovery.

*Call graph*: calls 1 internal fn (new); 1 external calls (clone).


##### `AuthManager::external_auth`  (lines 1911–1916)

```
fn external_auth(&self) -> Option<Arc<dyn ExternalAuth>>
```

**Purpose**: Returns a cloned handle to the configured external auth provider, if any.

**Data flow**: It reads the `external_auth` lock and clones the inner `Arc<dyn ExternalAuth>` when present.

**Call relations**: Several manager helpers use this private accessor to avoid duplicating lock-handling logic.

*Call graph*: called by 4 (external_auth_mode, has_external_auth, refresh_external_auth, resolve_external_api_key_auth).


##### `AuthManager::external_auth_mode`  (lines 1918–1922)

```
fn external_auth_mode(&self) -> Option<AuthMode>
```

**Purpose**: Returns the top-level auth mode supplied by the configured external provider, if any.

**Data flow**: It calls `external_auth()`, then maps the provider through `external_auth.auth_mode()`.

**Call relations**: `has_external_api_key_auth` uses this to detect whether external auth should be treated as API-key-style bearer auth.

*Call graph*: calls 1 internal fn (external_auth); called by 1 (has_external_api_key_auth).


##### `AuthManager::has_external_api_key_auth`  (lines 1924–1926)

```
fn has_external_api_key_auth(&self) -> bool
```

**Purpose**: Reports whether the configured external auth provider supplies API-key-style auth.

**Data flow**: It calls `external_auth_mode()` and compares the result to `Some(AuthMode::ApiKey)`.

**Call relations**: Auth resolution and unauthorized-recovery logic use this to choose the external bearer path.

*Call graph*: calls 1 internal fn (external_auth_mode); called by 3 (auth_mode, get_api_auth_mode, resolve_external_api_key_auth).


##### `AuthManager::resolve_external_api_key_auth`  (lines 1928–1943)

```
async fn resolve_external_api_key_auth(&self) -> Option<CodexAuth>
```

**Purpose**: Attempts to resolve current auth from an external API-key provider without touching stored managed auth.

**Data flow**: It returns `None` immediately unless `has_external_api_key_auth()` is true. Otherwise it clones the external provider, awaits `external_auth.resolve()`, and maps `Ok(Some(tokens))` to `Some(CodexAuth::from_api_key(&tokens.access_token))`; `Ok(None)` yields `None`, and errors are logged and also yield `None`.

**Call relations**: `auth()` calls this first so external bearer auth can override cached managed auth snapshots.

*Call graph*: calls 3 internal fn (external_auth, has_external_api_key_auth, from_api_key); called by 1 (auth); 1 external calls (error!).


##### `AuthManager::refresh_token`  (lines 1950–1984)

```
async fn refresh_token(&self) -> Result<(), RefreshTokenError>
```

**Purpose**: Performs guarded token refresh for the current auth, first reloading from storage when safe and only contacting the authority if the on-disk auth is unchanged.

**Data flow**: It acquires the one-permit `refresh_lock`, returning a permanent generic refresh error if the semaphore is closed. If the cached auth is API-key or PAT auth, it returns `Ok(())`. Otherwise it derives the expected account id from cached auth and awaits `reload_if_account_id_matches`. A changed reload skips authority refresh and returns `Ok(())`; an unchanged reload delegates to `refresh_token_from_authority_impl`; a skipped reload returns a permanent account-mismatch error.

**Call relations**: `auth()` uses this for proactive refresh, and managed unauthorized recovery uses the same guarded semantics indirectly.

*Call graph*: calls 4 internal fn (auth_cached, refresh_token_from_authority_impl, reload_if_account_id_matches, new); called by 1 (auth); 3 external calls (acquire, Permanent, info!).


##### `AuthManager::refresh_token_from_authority`  (lines 1990–1998)

```
async fn refresh_token_from_authority(&self) -> Result<(), RefreshTokenError>
```

**Purpose**: Refreshes the current auth directly from its issuing authority under the manager’s refresh lock.

**Data flow**: It acquires `refresh_lock`, mapping semaphore closure to a permanent generic refresh error, then awaits `refresh_token_from_authority_impl()`.

**Call relations**: Unauthorized recovery calls this after a guarded reload step when it wants to force an authority refresh.

*Call graph*: calls 1 internal fn (refresh_token_from_authority_impl); 1 external calls (acquire).


##### `AuthManager::refresh_token_from_authority_impl`  (lines 2000–2035)

```
async fn refresh_token_from_authority_impl(&self) -> Result<(), RefreshTokenError>
```

**Purpose**: Executes the actual refresh action appropriate for the current auth variant and records permanent failures scoped to the attempted snapshot.

**Data flow**: It logs that refresh is starting, clones `auth_cached()`, and returns `Ok(())` if no auth exists. If a scoped permanent failure already exists for this auth, it returns that immediately. It clones the attempted auth, then matches: `ChatgptAuthTokens` triggers `refresh_external_auth(Unauthorized)`; managed `Chatgpt` extracts current token data and calls `refresh_and_persist_chatgpt_token`; API-key, agent identity, PAT, and Bedrock all return `Ok(())`. If the result is a permanent failure, it records it via `record_permanent_refresh_failure_if_unchanged` before returning.

**Call relations**: Both guarded refresh and direct authority refresh funnel through this implementation so variant-specific refresh behavior and failure caching stay centralized.

*Call graph*: calls 5 internal fn (auth_cached, record_permanent_refresh_failure_if_unchanged, refresh_and_persist_chatgpt_token, refresh_external_auth, refresh_failure_for_auth); called by 2 (refresh_token, refresh_token_from_authority); 2 external calls (Permanent, info!).


##### `AuthManager::logout`  (lines 2041–2050)

```
async fn logout(&self) -> std::io::Result<bool>
```

**Purpose**: Deletes auth from all relevant stores and reloads the manager so callers immediately observe an unauthenticated state.

**Data flow**: It calls `logout_all_stores` with the manager’s home and storage settings, awaits `self.reload()` regardless of whether anything was removed, and returns the boolean deletion result.

**Call relations**: Runtime logout actions use this path when local credential removal is sufficient and token revocation is not required.

*Call graph*: calls 2 internal fn (reload, logout_all_stores).


##### `AuthManager::logout_with_revoke`  (lines 2052–2067)

```
async fn logout_with_revoke(&self) -> std::io::Result<bool>
```

**Purpose**: Best-effort revokes current token-backed auth, clears all stores, and reloads the manager.

**Data flow**: It derives the current raw `AuthDotJson` from `auth_cached().and_then(get_current_auth_json)`, attempts `revoke_auth_tokens` and logs any warning, deletes all stores via `logout_all_stores`, reloads the manager, and returns the deletion result.

**Call relations**: This is the manager-level counterpart to the free `logout_with_revoke` helper, using cached auth rather than reloading raw storage first.

*Call graph*: calls 4 internal fn (auth_cached, reload, logout_all_stores, revoke_auth_tokens); 1 external calls (warn!).


##### `AuthManager::get_api_auth_mode`  (lines 2069–2074)

```
fn get_api_auth_mode(&self) -> Option<ApiAuthMode>
```

**Purpose**: Returns the current specific API auth mode, treating external bearer auth as API-key mode.

**Data flow**: If `has_external_api_key_auth()` is true it returns `Some(ApiAuthMode::ApiKey)`; otherwise it maps `auth_cached()` through `CodexAuth::api_auth_mode`.

**Call relations**: Backend-eligibility checks use this helper when they need the specific auth mode currently in effect.

*Call graph*: calls 2 internal fn (auth_cached, has_external_api_key_auth); called by 1 (current_auth_uses_codex_backend).


##### `AuthManager::auth_mode`  (lines 2076–2081)

```
fn auth_mode(&self) -> Option<AuthMode>
```

**Purpose**: Returns the current top-level auth mode, treating external bearer auth as API-key mode.

**Data flow**: If `has_external_api_key_auth()` is true it returns `Some(AuthMode::ApiKey)`; otherwise it maps `auth_cached()` through `CodexAuth::auth_mode`.

**Call relations**: UI/status code uses this as the manager’s coarse auth-mode accessor.

*Call graph*: calls 2 internal fn (auth_cached, has_external_api_key_auth).


##### `AuthManager::current_auth_uses_codex_backend`  (lines 2083–2086)

```
fn current_auth_uses_codex_backend(&self) -> bool
```

**Purpose**: Reports whether the manager’s current auth mode targets the Codex backend.

**Data flow**: It calls `get_api_auth_mode()` and returns whether the resulting mode exists and `uses_codex_backend()` is true.

**Call relations**: Higher-level runtime code uses this to gate backend-specific features based on current auth.

*Call graph*: calls 1 internal fn (get_api_auth_mode).


##### `AuthManager::should_refresh_proactively`  (lines 2088–2110)

```
fn should_refresh_proactively(auth: &CodexAuth) -> bool
```

**Purpose**: Determines whether managed ChatGPT auth should be refreshed before use based on token expiry or stale refresh timestamp.

**Data flow**: It returns false for non-managed-ChatGPT auth. For managed ChatGPT, it reads the current `AuthDotJson`; if an access token exists and `parse_jwt_expiration` yields an expiry, it compares that expiry to `Utc::now() + 5 minutes`. Otherwise it falls back to `last_refresh` and returns true when that timestamp is older than 8 days. Missing auth JSON or timestamps yield false.

**Call relations**: `auth()` uses this helper to decide whether to trigger a proactive refresh before handing out cached auth.

*Call graph*: calls 1 internal fn (parse_jwt_expiration); 3 external calls (now, days, minutes).


##### `AuthManager::refresh_external_auth`  (lines 2112–2164)

```
async fn refresh_external_auth(
        &self,
        reason: ExternalAuthRefreshReason,
    ) -> Result<(), RefreshTokenError>
```

**Purpose**: Refreshes auth through the configured external provider, enforcing workspace restrictions and persisting external ChatGPT tokens when necessary.

**Data flow**: It clones the external provider or returns a transient error if none is configured. It snapshots forced workspace ids and previous account id, builds an `ExternalAuthRefreshContext` with the supplied reason, and awaits `external_auth.refresh(context)`. If the provider’s mode is `ApiKey`, it returns `Ok(())` because bearer auth is resolved on demand and not persisted. Otherwise it requires ChatGPT metadata, checks the returned account id against any forced workspace list, converts the refreshed tokens into `AuthDotJson::from_external_tokens`, saves that snapshot to the ephemeral store via `save_auth`, and reloads the manager.

**Call relations**: External unauthorized recovery and external ChatGPT token refresh both use this path. It bridges the provider-specific refresh result back into the manager’s cached and persisted auth state.

*Call graph*: calls 6 internal fn (default, auth_cached, external_auth, forced_chatgpt_workspace_id, reload, save_auth); called by 1 (refresh_token_from_authority_impl); 4 external calls (other, format!, Transient, from_external_tokens).


##### `AuthManager::refresh_and_persist_chatgpt_token`  (lines 2168–2185)

```
async fn refresh_and_persist_chatgpt_token(
        &self,
        auth: &ChatgptAuth,
        refresh_token: String,
    ) -> Result<(), RefreshTokenError>
```

**Purpose**: Refreshes managed ChatGPT OAuth tokens from the authority, writes them to storage, and reloads the manager cache.

**Data flow**: It takes a managed `ChatgptAuth` and a refresh-token string, awaits `request_chatgpt_token_refresh(refresh_token, auth.client())`, then passes the returned optional id/access/refresh tokens into `persist_tokens(auth.storage(), ...)`. After persistence succeeds, it awaits `self.reload()` and returns `Ok(())`.

**Call relations**: Managed ChatGPT refresh in `refresh_token_from_authority_impl` delegates to this helper for the network-plus-persistence sequence.

*Call graph*: calls 5 internal fn (reload, client, storage, persist_tokens, request_chatgpt_token_refresh); called by 1 (refresh_token_from_authority_impl).


### `login/src/auth/access_token.rs`

`domain_logic` · `auth load / login token dispatch`

This file is a tiny but important piece of authentication routing logic. It declares the constant `PERSONAL_ACCESS_TOKEN_PREFIX` as `"at-"`, the internal enum `CodexAccessToken<'a>` with variants `PersonalAccessToken(&'a str)` and `AgentIdentityJwt(&'a str)`, and a single classifier function. The classifier does not parse JWT structure, validate signatures, or inspect claims; it simply checks whether the raw token string starts with the personal-token prefix. Tokens with that prefix are treated as personal access tokens, and everything else is treated as an agent-identity JWT.

That design keeps the branching logic cheap and deterministic at the point where login and auth-loading code need to decide which downstream validation path to take. It also means malformed non-`at-` strings are intentionally routed into the JWT path, where later code is responsible for rejecting invalid JWT syntax or signatures. The enum borrows the original token string rather than allocating a new owned copy, so classification is zero-copy and purely structural.

#### Function details

##### `classify_codex_access_token`  (lines 8–14)

```
fn classify_codex_access_token(access_token: &str) -> CodexAccessToken<'_>
```

**Purpose**: Classifies a raw access token string as either a personal access token or an agent-identity JWT based on the `at-` prefix.

**Data flow**: Reads the input `&str`, checks `starts_with(PERSONAL_ACCESS_TOKEN_PREFIX)`, and returns either `CodexAccessToken::PersonalAccessToken(access_token)` or `CodexAccessToken::AgentIdentityJwt(access_token)`. It allocates nothing and mutates no state.

**Call relations**: Authentication-loading and login flows call this first to choose which validation and persistence path to follow for a supplied access token.

*Call graph*: called by 2 (load_auth, login_with_access_token); 2 external calls (AgentIdentityJwt, PersonalAccessToken).


### `login/src/auth/personal_access_token.rs`

`domain_logic` · `PAT login/load and account metadata hydration`

This file implements the runtime representation for personal access token (PAT) auth. The internal `PersonalAccessTokenMetadata` struct mirrors the JSON returned by the auth API’s `/v1/user-auth-credential/whoami` endpoint: email, ChatGPT user id, ChatGPT account id, raw plan type string, and a FedRAMP boolean. `PersonalAccessTokenAuth` stores both the original access token and the hydrated metadata, and its custom `Debug` implementation deliberately redacts the token while still printing metadata.

The main entry point is `PersonalAccessTokenAuth::load`, which chooses the auth API base URL from `CODEX_AUTHAPI_BASE_URL` when set and non-empty, otherwise falling back to the production constant. It then creates the shared default HTTP client and delegates to `hydrate_personal_access_token`. That helper constructs the full whoami endpoint, sends a GET request with `Authorization: Bearer <token>`, and converts transport failures, non-success statuses, and JSON decoding failures into descriptive `std::io::Error`s. Successful responses are deserialized directly into `PersonalAccessTokenMetadata`; because `email` is a required `String`, malformed responses such as `null` email are rejected during decoding.

Once hydrated, the type provides simple accessors for the raw token, account id, ChatGPT user id, email, normalized account plan type, and FedRAMP status. The plan accessor translates the raw backend plan string through `InternalPlanType::from_raw_value` before converting to the account-facing enum used elsewhere in the system.

#### Function details

##### `PersonalAccessTokenAuth::fmt`  (lines 30–35)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats PAT auth for debugging while redacting the sensitive token value.

**Data flow**: It writes a debug struct named `PersonalAccessTokenAuth`, inserts a literal `"<redacted>"` for `access_token`, includes the full `metadata`, and finishes the struct.

**Call relations**: This debug implementation is used whenever PAT auth appears in logs or test diagnostics, preventing accidental token disclosure.

*Call graph*: 1 external calls (debug_struct).


##### `PersonalAccessTokenAuth::load`  (lines 39–46)

```
async fn load(access_token: &str) -> std::io::Result<Self>
```

**Purpose**: Hydrates a raw personal access token into a fully populated auth object by querying the auth API.

**Data flow**: It reads `CODEX_AUTHAPI_BASE_URL_ENV_VAR`, trims whitespace and trailing slashes, ignores empty overrides, and falls back to `PROD_AUTHAPI_BASE_URL`. It then creates the shared default HTTP client with `create_client()` and awaits `hydrate_personal_access_token(&client, &authapi_base_url, access_token)`.

**Call relations**: PAT login and auth loading call this constructor whenever they need account metadata attached to a raw PAT string.

*Call graph*: calls 2 internal fn (create_client, hydrate_personal_access_token); called by 3 (from_personal_access_token, load_auth, login_with_access_token); 1 external calls (var).


##### `PersonalAccessTokenAuth::access_token`  (lines 48–50)

```
fn access_token(&self) -> &str
```

**Purpose**: Returns the raw personal access token string.

**Data flow**: It borrows `self.access_token` and returns it as `&str`.

**Call relations**: Generic auth-token accessors use this when PAT auth needs to supply a bearer token downstream.


##### `PersonalAccessTokenAuth::account_id`  (lines 52–54)

```
fn account_id(&self) -> &str
```

**Purpose**: Returns the ChatGPT account/workspace id associated with the PAT.

**Data flow**: It borrows `self.metadata.chatgpt_account_id` and returns it as `&str`.

**Call relations**: Workspace restriction enforcement uses this accessor to validate PATs against allowed account ids.

*Call graph*: called by 1 (ensure_personal_access_token_workspace_allowed).


##### `PersonalAccessTokenAuth::chatgpt_user_id`  (lines 56–58)

```
fn chatgpt_user_id(&self) -> &str
```

**Purpose**: Returns the ChatGPT user id associated with the PAT.

**Data flow**: It borrows `self.metadata.chatgpt_user_id` and returns it as `&str`.

**Call relations**: Higher-level identity code uses this to expose user identity from PAT auth.


##### `PersonalAccessTokenAuth::email`  (lines 60–62)

```
fn email(&self) -> &str
```

**Purpose**: Returns the account email address associated with the PAT.

**Data flow**: It borrows `self.metadata.email` and returns it as `&str`.

**Call relations**: Identity-reporting code uses this accessor when PAT auth is active.


##### `PersonalAccessTokenAuth::plan_type`  (lines 64–66)

```
fn plan_type(&self) -> AccountPlanType
```

**Purpose**: Converts the raw backend plan string into the public account plan enum.

**Data flow**: It reads `self.metadata.chatgpt_plan_type`, parses it with `InternalPlanType::from_raw_value`, converts that into `AccountPlanType`, and returns the result.

**Call relations**: Account-plan checks elsewhere in the auth manager rely on this normalized representation.

*Call graph*: 1 external calls (from_raw_value).


##### `PersonalAccessTokenAuth::is_fedramp_account`  (lines 68–70)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: Reports whether the PAT belongs to a FedRAMP account.

**Data flow**: It returns the boolean `self.metadata.chatgpt_account_is_fedramp`.

**Call relations**: Backend and policy code uses this to tailor behavior for FedRAMP accounts under PAT auth.


##### `hydrate_personal_access_token`  (lines 73–108)

```
async fn hydrate_personal_access_token(
    client: &CodexHttpClient,
    authapi_base_url: &str,
    access_token: &str,
) -> std::io::Result<PersonalAccessTokenAuth>
```

**Purpose**: Calls the auth API whoami endpoint with a bearer token and constructs `PersonalAccessTokenAuth` from the returned metadata.

**Data flow**: It takes a shared `CodexHttpClient`, an auth API base URL, and the raw access token. It formats the endpoint by appending `WHOAMI_PATH` to the trimmed base URL, sends a GET request with `.bearer_auth(access_token)`, maps transport errors into `io::Error::other(...)`, rejects non-success HTTP statuses with an error containing the status code, deserializes the JSON body into `PersonalAccessTokenMetadata`, maps decode failures into `io::Error::other(...)`, and on success returns `PersonalAccessTokenAuth { access_token: access_token.to_string(), metadata }`.

**Call relations**: `PersonalAccessTokenAuth::load` delegates all network I/O and response validation to this helper.

*Call graph*: calls 1 internal fn (get); called by 1 (load); 2 external calls (other, format!).


### `login/src/token_data.rs`

`domain_logic` · `auth load, token persistence, refresh checks`

This file centers on two serializable data structures: `TokenData`, which groups `id_token`, `access_token`, `refresh_token`, and optional `account_id`, and `IdTokenInfo`, which stores a flattened subset of useful claims extracted from the ID token plus the original `raw_jwt`. The `id_token` field on `TokenData` uses custom serde hooks so deserialization accepts a JWT string from disk and immediately parses it into `IdTokenInfo`, while serialization writes only `raw_jwt` back out. JWT parsing is intentionally lightweight: `decode_jwt_payload` only validates the three-part `header.payload.signature` shape, base64url-decodes the payload, and deserializes JSON claims; it does not verify signatures. `parse_chatgpt_jwt_claims` then merges top-level `email` with profile email fallback, reads namespaced OpenAI auth claims, falls back from `chatgpt_user_id` to legacy `user_id`, and defaults missing auth metadata to `None`/`false`. `parse_jwt_expiration` separately extracts the standard `exp` claim and converts it to `DateTime<Utc>`, returning `None` if absent or out of range. The helper methods on `IdTokenInfo` normalize `PlanType` into either display names or raw backend values and expose workspace/FedRAMP predicates. Error reporting is explicit via `IdTokenInfoError`, distinguishing malformed JWT structure from base64 and JSON failures.

#### Function details

##### `IdTokenInfo::get_chatgpt_plan_type`  (lines 45–50)

```
fn get_chatgpt_plan_type(&self) -> Option<String>
```

**Purpose**: Converts the optional parsed `chatgpt_plan_type` claim into a user-facing string. Known plans are rendered through the protocol type's display name, while unknown backend values are preserved verbatim.

**Data flow**: Reads `self.chatgpt_plan_type` → maps `PlanType::Known(plan)` to `plan.display_name().to_string()` and `PlanType::Unknown(s)` to a cloned string → returns `Option<String>` without mutating state.

**Call relations**: Used by callers that need a presentation-friendly plan label after `parse_chatgpt_jwt_claims` has populated `IdTokenInfo`; it is a leaf accessor and delegates only to `PlanType` formatting behavior.


##### `IdTokenInfo::get_chatgpt_plan_type_raw`  (lines 52–57)

```
fn get_chatgpt_plan_type_raw(&self) -> Option<String>
```

**Purpose**: Returns the backend/raw plan identifier string for the parsed ChatGPT plan claim. This preserves exact wire values for known plans and unknown plans alike.

**Data flow**: Reads `self.chatgpt_plan_type` → maps `PlanType::Known(plan)` to `plan.raw_value().to_string()` and `PlanType::Unknown(s)` to a cloned string → returns `Option<String>`.

**Call relations**: Called after token parsing when code or tests need the canonical raw plan slug rather than a display label; it is a pure accessor over parsed state.


##### `IdTokenInfo::is_workspace_account`  (lines 59–64)

```
fn is_workspace_account(&self) -> bool
```

**Purpose**: Determines whether the parsed plan corresponds to a workspace-style account rather than a personal subscription. It only returns true for known plans whose `is_workspace_account()` predicate is true.

**Data flow**: Reads `self.chatgpt_plan_type` → pattern-matches for `Some(PlanType::Known(plan))` and evaluates `plan.is_workspace_account()` → returns a boolean.

**Call relations**: Used by higher-level auth logic and tests to classify accounts after JWT parsing; it does not call local helpers, only the plan-type predicate embedded in the protocol enum.

*Call graph*: 1 external calls (matches!).


##### `IdTokenInfo::is_fedramp_account`  (lines 66–68)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: Exposes whether the selected workspace must route through the FedRAMP edge. It is a direct accessor over the parsed boolean claim.

**Data flow**: Reads `self.chatgpt_account_is_fedramp` and returns it unchanged.

**Call relations**: Consumed by callers that need routing or policy decisions based on account type after `IdTokenInfo` has been built.


##### `decode_jwt_payload`  (lines 117–128)

```
fn decode_jwt_payload(jwt: &str) -> Result<T, IdTokenInfoError>
```

**Purpose**: Performs generic JWT payload extraction for any deserializable claim type. It enforces only the basic three-segment JWT shape and then decodes/deserializes the payload segment.

**Data flow**: Accepts `jwt: &str` and generic target type `T` → splits on `.` and requires non-empty header, payload, and signature segments → base64url-no-pad decodes the payload bytes → deserializes JSON bytes into `T` with `serde_json::from_slice` → returns `Result<T, IdTokenInfoError>`.

**Call relations**: This is the shared parser used by both `parse_chatgpt_jwt_claims` and `parse_jwt_expiration`; those functions choose the concrete claim struct and then apply domain-specific extraction on top of the decoded payload.

*Call graph*: called by 2 (parse_chatgpt_jwt_claims, parse_jwt_expiration); 1 external calls (from_slice).


##### `parse_jwt_expiration`  (lines 130–135)

```
fn parse_jwt_expiration(jwt: &str) -> Result<Option<DateTime<Utc>>, IdTokenInfoError>
```

**Purpose**: Extracts the standard JWT expiration timestamp from a token and converts it into UTC wall-clock time. Missing or invalid-range timestamps become `None` rather than hard errors once payload decoding succeeds.

**Data flow**: Accepts `jwt: &str` → calls `decode_jwt_payload` into `StandardJwtClaims` → reads optional `exp: i64` → converts with `DateTime::<Utc>::from_timestamp(exp, 0)` → returns `Result<Option<DateTime<Utc>>, IdTokenInfoError>`.

**Call relations**: Invoked by proactive refresh logic (`should_refresh_proactively`) to decide whether an access token is near expiry; it delegates all JWT decoding/JSON parsing to `decode_jwt_payload`.

*Call graph*: calls 1 internal fn (decode_jwt_payload); called by 1 (should_refresh_proactively).


##### `parse_chatgpt_jwt_claims`  (lines 137–161)

```
fn parse_chatgpt_jwt_claims(jwt: &str) -> Result<IdTokenInfo, IdTokenInfoError>
```

**Purpose**: Parses an ID token into the flattened `IdTokenInfo` structure used throughout login code. It extracts email from either the top-level claim or the namespaced profile object and pulls ChatGPT-specific auth metadata from the OpenAI auth namespace.

**Data flow**: Accepts `jwt: &str` → calls `decode_jwt_payload` into `IdClaims` → computes `email` from `claims.email` or `claims.profile.email` → if `claims.auth` exists, builds `IdTokenInfo` with plan type, user id (`chatgpt_user_id` falling back to `user_id`), account id, FedRAMP flag, and `raw_jwt`; otherwise builds the same struct with auth-related fields defaulted to `None`/`false` → returns `Result<IdTokenInfo, IdTokenInfoError>`.

**Call relations**: This is the main claim parser used broadly across auth loading and persistence paths, including auth.json readers/writers, external token import, test helpers, and the serde hook `deserialize_id_token`; it relies on `decode_jwt_payload` for low-level decoding.

*Call graph*: calls 1 internal fn (decode_jwt_payload); called by 9 (remote_control_auth_dot_json, remote_control_auth_dot_json, write_chatgpt_auth, from_external_tokens, persist_tokens, id_token_with_prefix, deserialize_id_token, chatgpt_auth_tokens_for_tests, write_chatgpt_auth).


##### `deserialize_id_token`  (lines 163–169)

```
fn deserialize_id_token(deserializer: D) -> Result<IdTokenInfo, D::Error>
```

**Purpose**: Implements custom serde deserialization for `TokenData.id_token` so the on-disk JSON field remains a JWT string while the in-memory field becomes parsed `IdTokenInfo`.

**Data flow**: Receives a serde deserializer → deserializes a `String` from input → passes that string to `parse_chatgpt_jwt_claims` → converts any parser error into a serde custom error → returns `IdTokenInfo`.

**Call relations**: Triggered automatically by serde when `TokenData` is deserialized from auth.json or similar sources; it bridges generic string decoding to the domain parser.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); 1 external calls (deserialize).


##### `serialize_id_token`  (lines 171–176)

```
fn serialize_id_token(id_token: &IdTokenInfo, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Implements custom serde serialization for `TokenData.id_token` by writing only the original raw JWT string. This preserves round-tripping without re-encoding claims from the flattened struct.

**Data flow**: Accepts `&IdTokenInfo` and a serde serializer → reads `id_token.raw_jwt` → serializes it as a JSON string via `serialize_str` → returns the serializer result.

**Call relations**: Triggered automatically when `TokenData` is serialized for auth.json persistence; it complements `deserialize_id_token` so storage format stays compatible with raw-token expectations.

*Call graph*: 1 external calls (serialize_str).


### Installation identity
This file establishes the stable per-installation identifier used to recognize the local Codex instance across runs.

### `core/src/installation_id.rs`

`domain_logic` · `startup / identity resolution`

This file implements the installation ID persistence mechanism used to give one Codex home directory a durable UUID. `resolve_installation_id` first ensures the home directory exists asynchronously, then moves the file work into `tokio::task::spawn_blocking` because it uses synchronous `std::fs` APIs plus file locking. Inside that blocking section it opens or creates `<codex_home>/installation_id` for read/write, applies Unix mode `0o644` on creation, locks the file, and on Unix also repairs permissions if an existing file has drifted from `0644`.

The function reads the whole file as text, trims whitespace, and attempts `Uuid::parse_str`. Any valid UUID is normalized through `to_string()`, so uppercase or oddly formatted persisted values are reused but canonicalized in the returned string. Empty or invalid contents trigger regeneration: a fresh `Uuid::new_v4()` is written after truncating the file, seeking back to offset 0, flushing, and `sync_all()` to persist it durably. The tests cover the three important states: first-run generation and persistence, reuse of an existing valid UUID, and rewrite of invalid contents. On Unix, the generation test also asserts the file mode is exactly `0644`.

#### Function details

##### `resolve_installation_id`  (lines 19–64)

```
async fn resolve_installation_id(codex_home: &AbsolutePathBuf) -> Result<String>
```

**Purpose**: Resolves the installation UUID stored under the Codex home directory, creating or rewriting the file when necessary. It guarantees the returned string is a valid canonical UUID and that the backing file exists.

**Data flow**: Takes `codex_home: &AbsolutePathBuf`, joins it with `INSTALLATION_ID_FILENAME`, and asynchronously creates the directory tree. In a blocking task it opens the file read/write/create, locks it, optionally fixes Unix permissions to `0o644`, reads existing contents, trims them, and tries to parse a UUID. If parsing succeeds, it returns the normalized UUID string; otherwise it generates `Uuid::new_v4()`, truncates and rewrites the file, flushes and syncs it, and returns the new ID.

**Call relations**: This is the file’s production entrypoint and is exercised only by the local async tests here. Those tests invoke it under fresh, pre-populated-valid, and pre-populated-invalid filesystem conditions to verify generation, reuse, and rewrite behavior.

*Call graph*: calls 1 internal fn (join); called by 3 (resolve_installation_id_generates_and_persists_uuid, resolve_installation_id_reuses_existing_uuid, resolve_installation_id_rewrites_invalid_file_contents); 2 external calls (create_dir_all, spawn_blocking).


##### `tests::resolve_installation_id_generates_and_persists_uuid`  (lines 79–103)

```
async fn resolve_installation_id_generates_and_persists_uuid()
```

**Purpose**: Checks the first-run path where no installation ID file exists yet. It verifies both the returned value and the on-disk file contents, plus Unix permissions when applicable.

**Data flow**: Creates a temporary directory, derives an absolute Codex home path and the expected persisted file path, then awaits `resolve_installation_id`. It reads the file back as text and asserts it equals the returned ID, asserts the ID parses as a UUID, and on Unix reads metadata permissions and asserts mode `0o644`.

**Call relations**: Invokes `resolve_installation_id` as the empty-state test case. It validates the side effects that the production function is responsible for: file creation, persistence, and permission normalization.

*Call graph*: calls 1 internal fn (resolve_installation_id); 4 external calls (new, assert!, assert_eq!, metadata).


##### `tests::resolve_installation_id_reuses_existing_uuid`  (lines 106–126)

```
async fn resolve_installation_id_reuses_existing_uuid()
```

**Purpose**: Verifies that an already persisted valid UUID is reused instead of being replaced. It also confirms the returned string is canonicalized even if the file contains uppercase text.

**Data flow**: Creates a temp directory, writes an uppercase UUID string into the installation ID file, then awaits `resolve_installation_id`. It parses the original uppercase string with `Uuid::parse_str(...).to_string()` and asserts the resolved value matches that canonical lowercase/hyphenated form.

**Call relations**: Exercises the valid-existing-file branch of `resolve_installation_id`. The test sets up the file contents directly, then confirms the function reads and normalizes rather than regenerating.

*Call graph*: calls 1 internal fn (resolve_installation_id); 4 external calls (new, new_v4, assert_eq!, write).


##### `tests::resolve_installation_id_rewrites_invalid_file_contents`  (lines 129–148)

```
async fn resolve_installation_id_rewrites_invalid_file_contents()
```

**Purpose**: Ensures corrupt or non-UUID file contents are replaced with a newly generated valid UUID. It checks both the returned value and the rewritten file.

**Data flow**: Creates a temp directory, writes `"not-a-uuid"` into the installation ID file, then awaits `resolve_installation_id`. It asserts the returned string parses as a UUID and that reading the file afterward yields exactly that returned value.

**Call relations**: Covers the invalid-content recovery path in `resolve_installation_id`. It demonstrates that the function does not fail on bad persisted state; instead it repairs the file in place.

*Call graph*: calls 1 internal fn (resolve_installation_id); 4 external calls (new, assert!, assert_eq!, write).


### Windows sandbox accounts
This file manages the Windows-specific local users, groups, credentials, and markers needed for sandbox account readiness.

### `windows-sandbox-rs/src/bin/setup_main/win/sandbox_users.rs`

`domain_logic` · `user provisioning and setup finalization`

This module owns the Windows account bootstrap for sandbox execution. It defines the managed local group name `CodexSandboxUsers`, several well-known SID constants, and helpers for creating users/groups through NetAPI calls. `provision_sandbox_users` ensures the group exists, logs the target usernames, generates two random 24-character passwords with `SmallRng`, creates or updates the offline and online local accounts, adds them to the sandbox group, and persists DPAPI-protected credentials as pretty JSON in `sandbox_secrets_dir/codex-home/sandbox_users.json`.

The SID helpers are equally important. `resolve_sid` fast-paths common principals through hard-coded SID strings and otherwise loops on `LookupAccountNameW`, resizing buffers on `ERROR_INSUFFICIENT_BUFFER`. `sid_bytes_from_string`, `lookup_account_name_for_sid`, and `sid_bytes_to_psid` bridge between string SIDs, raw SID bytes, and Win32 PSID pointers used elsewhere in ACL code. Account creation is intentionally idempotent: `ensure_local_user` first tries `NetUserAdd`, then falls back to `NetUserSetInfo` level 1003 to rotate the password if the user already exists, and best-effort adds the account to the localized built-in Users group.

The module also manages setup readiness signaling. `prepare_setup_marker` deletes any old marker, resolves the real user SID, builds an SDDL DACL granting only SYSTEM, Administrators, and the real user full access, and creates an empty protected `setup_marker.json`. `commit_setup_marker` later overwrites that file with versioned JSON only after setup succeeds, preserving the restrictive ACL established earlier.

#### Function details

##### `ensure_sandbox_users_group`  (lines 62–64)

```
fn ensure_sandbox_users_group(log: &mut dyn Write) -> Result<()>
```

**Purpose**: Ensures the managed local sandbox users group exists with the expected comment.

**Data flow**: It takes a log sink and forwards the fixed group name and comment into `ensure_local_group`, returning that result.

**Call relations**: This is the first step inside `provision_sandbox_users`, establishing the group before users are added to it.

*Call graph*: calls 1 internal fn (ensure_local_group); called by 1 (provision_sandbox_users).


##### `resolve_sandbox_users_group_sid`  (lines 66–68)

```
fn resolve_sandbox_users_group_sid() -> Result<Vec<u8>>
```

**Purpose**: Resolves the sandbox users group name to raw SID bytes.

**Data flow**: It calls `resolve_sid` with the fixed `SANDBOX_USERS_GROUP` name and returns the resulting `Vec<u8>`.

**Call relations**: This helper is used by provisioning and ACL setup paths whenever the sandbox group SID is needed for firewall, directory locking, or ACL grants.

*Call graph*: calls 1 internal fn (resolve_sid); called by 3 (run_provision_only, run_read_acl_only, run_setup_full).


##### `provision_sandbox_users`  (lines 70–93)

```
fn provision_sandbox_users(
    codex_home: &Path,
    offline_username: &str,
    online_username: &str,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Creates or updates both sandbox accounts, ensures group membership, and writes encrypted credentials to disk.

**Data flow**: It takes `codex_home`, offline and online usernames, and a log sink. It ensures the sandbox group exists, logs the usernames, generates random passwords, ensures each user exists and belongs to the group, writes DPAPI-protected secrets under the sandbox secrets directory, and returns success.

**Call relations**: This is called by `provision_and_hide_sandbox_users` in the outer setup module. It delegates per-user work to `ensure_sandbox_user` and persistence to `write_secrets`.

*Call graph*: calls 4 internal fn (ensure_sandbox_user, ensure_sandbox_users_group, random_password, write_secrets); called by 1 (provision_and_hide_sandbox_users); 2 external calls (format!, log_line).


##### `ensure_sandbox_user`  (lines 95–99)

```
fn ensure_sandbox_user(username: &str, password: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Ensures a single sandbox user account exists and belongs to the managed sandbox group.

**Data flow**: It takes a username, plaintext password, and log sink, calls `ensure_local_user` to create or update the account, then calls `ensure_local_group_member` to add it to `CodexSandboxUsers`, returning `Ok(())` on success.

**Call relations**: This helper is invoked twice by `provision_sandbox_users`, once for the offline account and once for the online account.

*Call graph*: calls 2 internal fn (ensure_local_group_member, ensure_local_user); called by 1 (provision_sandbox_users).


##### `ensure_local_user`  (lines 101–163)

```
fn ensure_local_user(name: &str, password: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Creates a local Windows user or updates its password if it already exists, then best-effort adds it to the built-in Users group.

**Data flow**: It converts the username and password to UTF-16, builds a `USER_INFO_1`, and calls `NetUserAdd`. If creation fails, it constructs `USER_INFO_1003` and calls `NetUserSetInfo` to update the password; if that also fails it logs the code and returns `HelperUserCreateOrUpdateFailed`. Afterward it tries to resolve the localized account name for the well-known Users SID and, if successful, calls `NetLocalGroupAddMembers` to add the user to that group.

**Call relations**: This is the low-level account mutation primitive used by `ensure_sandbox_user`. It also depends on `lookup_account_name_for_sid` to avoid hard-coding a localized built-in group name.

*Call graph*: calls 2 internal fn (lookup_account_name_for_sid, new); called by 1 (ensure_sandbox_user); 10 external calls (new, new, to_wide, format!, null, null_mut, log_line, NetLocalGroupAddMembers, NetUserAdd, NetUserSetInfo).


##### `ensure_local_group`  (lines 165–195)

```
fn ensure_local_group(name: &str, comment: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Creates a local Windows group if needed and tolerates the standard already-exists statuses.

**Data flow**: It converts the group name and comment to UTF-16, builds `LOCALGROUP_INFO_1`, calls `NetLocalGroupAdd`, and returns success for `NERR_Success`, `ERROR_ALIAS_EXISTS`, or `NERR_GROUP_EXISTS`. Other statuses are logged and converted into `HelperUsersGroupCreateFailed`.

**Call relations**: This helper underpins `ensure_sandbox_users_group` and keeps group creation idempotent across repeated setup runs.

*Call graph*: calls 1 internal fn (new); called by 1 (ensure_sandbox_users_group); 7 external calls (new, new, to_wide, format!, null, log_line, NetLocalGroupAdd).


##### `ensure_local_group_member`  (lines 197–215)

```
fn ensure_local_group_member(group_name: &str, member_name: &str) -> Result<()>
```

**Purpose**: Adds a named account to a local group, ignoring duplicate-membership errors.

**Data flow**: It converts the group and member names to UTF-16, builds `LOCALGROUP_MEMBERS_INFO_3`, calls `NetLocalGroupAddMembers`, ignores the returned status, and always returns `Ok(())`.

**Call relations**: This is used by `ensure_sandbox_user` after account creation/update to enforce sandbox-group membership.

*Call graph*: called by 1 (ensure_sandbox_user); 4 external calls (new, to_wide, null, NetLocalGroupAddMembers).


##### `resolve_sid`  (lines 217–253)

```
fn resolve_sid(name: &str) -> Result<Vec<u8>>
```

**Purpose**: Resolves an account or group name into raw SID bytes, with fast paths for several well-known principals.

**Data flow**: It first checks `well_known_sid_str`; if a known SID string exists it converts that string via `sid_bytes_from_string`. Otherwise it UTF-16 encodes the name and repeatedly calls `LookupAccountNameW`, resizing SID and domain buffers on `ERROR_INSUFFICIENT_BUFFER`, truncating the SID buffer to the returned length on success, and returning the SID bytes.

**Call relations**: This is a foundational identity helper used throughout setup for real users, sandbox users, built-in principals, and the sandbox group.

*Call graph*: calls 2 internal fn (sid_bytes_from_string, well_known_sid_str); called by 6 (lock_sandbox_dir, run_provision_only, run_read_acl_only, run_setup_full, prepare_setup_marker, resolve_sandbox_users_group_sid); 8 external calls (new, new, anyhow!, to_wide, null, vec!, GetLastError, LookupAccountNameW).


##### `well_known_sid_str`  (lines 255–264)

```
fn well_known_sid_str(name: &str) -> Option<&'static str>
```

**Purpose**: Maps a small set of built-in principal names to fixed SID strings.

**Data flow**: It matches the input name against `Administrators`, `Users`, `Authenticated Users`, `Everyone`, and `SYSTEM`, returning `Some(&'static str)` for those names and `None` otherwise.

**Call relations**: This helper is used only by `resolve_sid` to avoid unnecessary account lookups for common principals.

*Call graph*: called by 1 (resolve_sid).


##### `sid_bytes_from_string`  (lines 266–291)

```
fn sid_bytes_from_string(sid_str: &str) -> Result<Vec<u8>>
```

**Purpose**: Converts a string SID into an owned byte vector containing the SID structure.

**Data flow**: It UTF-16 encodes the SID string, calls `ConvertStringSidToSidW` to obtain a PSID, queries its length with `GetLengthSid`, allocates an output buffer, copies the SID with `CopySid`, frees the original PSID with `LocalFree`, and returns the copied bytes.

**Call relations**: This conversion path is used by `resolve_sid` for well-known SID strings.

*Call graph*: called by 1 (resolve_sid); 9 external calls (new, anyhow!, to_wide, null_mut, vec!, LocalFree, ConvertStringSidToSidW, CopySid, GetLengthSid).


##### `lookup_account_name_for_sid`  (lines 293–351)

```
fn lookup_account_name_for_sid(sid_str: &str) -> Result<String>
```

**Purpose**: Resolves a string SID to the localized account name Windows uses for that principal.

**Data flow**: It converts the SID string to a PSID, performs a preflight `LookupAccountSidW` to obtain required buffer lengths, allocates UTF-16 name and domain buffers, performs the real lookup, frees the PSID, converts the name buffer to a Rust `String`, trims trailing NULs, and returns the account name.

**Call relations**: This helper is used by `ensure_local_user` to find the localized built-in Users group name before adding the sandbox account to it.

*Call graph*: called by 1 (ensure_local_user); 11 external calls (new, from_utf16_lossy, anyhow!, to_wide, null, null_mut, vec!, GetLastError, LocalFree, ConvertStringSidToSidW (+1 more)).


##### `sid_bytes_to_psid`  (lines 353–364)

```
fn sid_bytes_to_psid(sid: &[u8]) -> Result<*mut c_void>
```

**Purpose**: Converts raw SID bytes into a heap-allocated Win32 PSID pointer suitable for ACL APIs.

**Data flow**: It converts the SID bytes to a string SID with `string_from_sid_bytes`, UTF-16 encodes that string, calls `ConvertStringSidToSidW`, and returns the resulting `*mut c_void` PSID for the caller to free with `LocalFree`.

**Call relations**: This bridge is used by read-ACL and full-setup code when passing SIDs into ACL inspection and mutation functions.

*Call graph*: called by 2 (run_read_acl_only, run_setup_full); 6 external calls (new, anyhow!, string_from_sid_bytes, to_wide, null_mut, ConvertStringSidToSidW).


##### `random_password`  (lines 366–378)

```
fn random_password() -> String
```

**Purpose**: Generates a random 24-character password from an alphanumeric-and-symbol alphabet.

**Data flow**: It seeds `SmallRng` from entropy, fills a 24-byte buffer, maps each byte modulo the fixed `CHARS` alphabet length to a character, collects the characters into a `String`, and returns it.

**Call relations**: This helper is called twice by `provision_sandbox_users` to create fresh offline and online account passwords.

*Call graph*: called by 1 (provision_sandbox_users); 1 external calls (from_entropy).


##### `write_secrets`  (lines 405–462)

```
fn write_secrets(
    codex_home: &Path,
    offline_user: &str,
    offline_pwd: &str,
    online_user: &str,
    online_pwd: &str,
) -> Result<()>
```

**Purpose**: Persists the sandbox usernames and DPAPI-protected passwords into the sandbox secrets directory as versioned JSON.

**Data flow**: It derives `sandbox_secrets_dir(codex_home)`, creates it, DPAPI-protects each plaintext password, base64-encodes the encrypted blobs, builds a `SandboxUsersFile` containing `SETUP_VERSION` and both user records, serializes it with `serde_json::to_vec_pretty`, and writes it to `sandbox_users.json`. Directory creation, DPAPI, serialization, and write failures are mapped to specific setup error codes.

**Call relations**: This persistence step is called by `provision_sandbox_users` after both accounts have been ensured.

*Call graph*: called by 1 (provision_sandbox_users); 5 external calls (dpapi_protect, sandbox_secrets_dir, to_vec_pretty, create_dir_all, write).


##### `prepare_setup_marker`  (lines 468–549)

```
fn prepare_setup_marker(codex_home: &Path, real_user: &str) -> Result<()>
```

**Purpose**: Creates an empty protected setup marker file whose ACL allows only SYSTEM, Administrators, and the real user.

**Data flow**: It computes `sandbox_dir(codex_home)/setup_marker.json`, removes any existing file unless it is absent, resolves the real user SID and converts it to a string, builds an SDDL DACL string, converts that to a security descriptor, constructs `SECURITY_ATTRIBUTES`, creates the file with `CreateFileW(CREATE_NEW, GENERIC_WRITE, share=0)`, frees the security descriptor, closes the file handle, and returns success or `HelperSetupMarkerWriteFailed` on any step.

**Call relations**: This function is called by `run_setup` before executing provisioning/full setup modes so readiness checks fail while setup is still in progress and sandbox users cannot tamper with the marker.

*Call graph*: calls 2 internal fn (resolve_sid, new); called by 1 (run_setup); 11 external calls (new, sandbox_dir, to_wide, format!, remove_file, null_mut, CloseHandle, GetLastError, LocalFree, ConvertStringSecurityDescriptorToSecurityDescriptorW (+1 more)).


##### `commit_setup_marker`  (lines 551–585)

```
fn commit_setup_marker(
    codex_home: &Path,
    offline_user: &str,
    online_user: &str,
    proxy_ports: &[u16],
    allow_local_binding: bool,
) -> Result<()>
```

**Purpose**: Writes the final JSON contents into the already-protected setup marker file after setup succeeds.

**Data flow**: It builds a `SetupMarker` containing `SETUP_VERSION`, usernames, current UTC timestamp, proxy ports, local-binding flag, and empty read/write root arrays, serializes it with `to_vec_pretty`, and writes it to `sandbox_dir(codex_home)/setup_marker.json`, mapping serialization or write failures to `HelperSetupMarkerWriteFailed`.

**Call relations**: This is called by `run_setup` only after the selected setup mode completes successfully, preserving the ACL established by `prepare_setup_marker`.

*Call graph*: called by 1 (run_setup); 5 external calls (new, now, sandbox_dir, to_vec_pretty, write).

## 📊 State Registers Touched

- `reg-installation-context` — The discovered installation and host context, including CODEX_HOME, bundled assets, helper binary locations, host identity, and local machine/shell facts.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-auth-state` — The active authentication mode and credential state machine, including restored tokens, refresh state, and mode restrictions.
- `reg-token-store` — The persisted credential payloads and parsed token/account metadata used to restore, refresh, and revoke authentication.
- `reg-installation-identity` — The stable per-installation identity used to distinguish this machine or install across auth, backend, and telemetry flows.
- `reg-sandbox-user-accounts` — The managed Windows sandbox local accounts and protected credentials used by isolated execution.
- `reg-auth-transport-adapters` — The runtime-ready backend auth adaptation state that turns active credentials into concrete transport forms such as bearer headers, attestation/assertion material, or SigV4 signing context for downstream clients.
- `reg-account-snapshot` — The current authenticated account/whoami readiness snapshot, including resolved user identity and account capabilities shown to clients and used by startup gating.
