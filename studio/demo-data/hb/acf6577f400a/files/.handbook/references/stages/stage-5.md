# Authentication, identity, and account readiness  `stage-5`

This stage is the system’s “who are you and what can you use?” checkpoint. It runs during startup, onboarding, account changes, and before network features need permission. First, the interactive and persisted login flows get the user signed in, refresh or store saved tokens, report status, and cleanly log out. They support browser login, device-code login, MCP login, and several safe storage places for secrets.

Next, provider and backend auth adaptation turns that identity into the right kind of badge for each service. Some requests use ChatGPT tokens, some use provider API keys, some use OAuth, and Amazon Bedrock may need AWS request signing, which proves a request came from a valid AWS identity.

The shared files tie this together. The auth manager loads, saves, refreshes, and rejects bad credentials. Token helpers identify personal tokens or agent identity tokens, validate personal access tokens, and decode ChatGPT ID tokens into plain account facts like email and plan. The installation ID gives this local Codex install a stable name. On Windows, sandbox user setup prepares special accounts so isolated work can run safely.

## Sub-stages

- [Interactive and persisted login flows](stage-5.1.md) `stage-5.1` — 15 files
- [Provider and backend auth adaptation](stage-5.2.md) `stage-5.2` — 19 files

## Files in this stage

### Authentication state core
These files define the main auth state machine and the token representations it loads, classifies, parses, and enriches during startup.

### `login/src/auth/manager.rs`

`orchestration` · `startup, request handling, token refresh, logout`

Authentication is the front door of the system: without it, Codex cannot know whether to use an API key, a ChatGPT login, a personal access token, an agent identity token, a Bedrock key, or credentials supplied by another app. This file acts like a reception desk that keeps one current answer to “how are we logged in?” and gives that answer to the rest of the program.

It reads credentials from several places in a strict order. Environment variables can override stored credentials. Temporary, externally supplied ChatGPT tokens are checked before long-lived storage. Persistent storage may be a file or keyring, depending on configuration. The file also enforces rules such as “only ChatGPT login is allowed” or “only this workspace may be used.”

For ChatGPT logins, access tokens can expire. This file knows when to refresh them, how to call the OAuth token endpoint, how to store the new tokens, and how to avoid two tasks refreshing at once by using a semaphore, which is a small gate that lets only one refresh through at a time.

The `AuthManager` keeps a cached snapshot so every part of the program sees a consistent login state. If a request gets a 401 Unauthorized response, `UnauthorizedRecovery` walks through a small recovery plan: reload saved auth, refresh tokens, or ask an external provider for new credentials.

#### Function details

##### `CodexAuth::eq`  (lines 67–73)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Compares two authentication choices to decide whether they should be treated as the same login. For most modes it compares only the kind of auth, but for personal access tokens and Bedrock API keys it compares the actual stored value wrapper.

**Data flow**: It receives two `CodexAuth` values. It checks their variants and either compares their concrete token/key records or compares their API-facing auth modes. It returns true when the two auth values are considered equivalent.

**Call relations**: This comparison is used when cached auth is updated or compared. It relies on `api_auth_mode` for the broad mode comparison.

*Call graph*: calls 1 internal fn (api_auth_mode); 1 external calls (api_auth_mode).


##### `ExternalAuthTokens::access_token_only`  (lines 136–141)

```
fn access_token_only(access_token: impl Into<String>) -> Self
```

**Purpose**: Builds an external credential package that contains only an access token. This is useful when the outside provider is supplying something like an API key and no ChatGPT account details are needed.

**Data flow**: It takes any value that can become a string. It stores that string as the access token and leaves ChatGPT metadata empty. It returns a new `ExternalAuthTokens` value.

**Call relations**: External auth implementations and tests use this when they provide bare bearer credentials. If this is later used where ChatGPT metadata is required, conversion to ChatGPT auth will fail clearly.

*Call graph*: called by 5 (external_auth_tokens_without_chatgpt_metadata_cannot_seed_chatgpt_auth, refresh, resolve, refresh, resolve); 1 external calls (into).


##### `ExternalAuthTokens::chatgpt`  (lines 143–155)

```
fn chatgpt(
        access_token: impl Into<String>,
        chatgpt_account_id: impl Into<String>,
        chatgpt_plan_type: Option<String>,
    ) -> Self
```

**Purpose**: Builds an external credential package for ChatGPT-style auth, including the access token and the account/workspace information Codex needs.

**Data flow**: It receives an access token, a ChatGPT account id, and an optional plan name. It converts them into owned strings and stores the account details as metadata. It returns a complete `ExternalAuthTokens` value.

**Call relations**: External providers use this when refreshing ChatGPT tokens. `AuthDotJson::from_external_access_token` also uses it before turning the data into the normal stored auth shape.

*Call graph*: called by 2 (refresh, from_external_access_token); 1 external calls (into).


##### `ExternalAuthTokens::chatgpt_metadata`  (lines 157–159)

```
fn chatgpt_metadata(&self) -> Option<&ExternalAuthChatgptMetadata>
```

**Purpose**: Returns the ChatGPT account details attached to externally supplied tokens, if they exist.

**Data flow**: It reads the optional metadata field from an `ExternalAuthTokens` value. It returns a borrowed reference when metadata is present, or nothing when the token is access-token-only.

**Call relations**: `AuthDotJson::from_external_tokens` calls this before it can seed an external ChatGPT auth record.

*Call graph*: called by 1 (from_external_tokens).


##### `ExternalAuth::resolve`  (lines 183–185)

```
fn resolve(&self) -> ExternalAuthFuture<'_, Option<ExternalAuthTokens>>
```

**Purpose**: Provides a default implementation for external auth providers that do not have immediately available credentials. By default it says, “nothing is ready synchronously.”

**Data flow**: It takes the provider instance and returns an asynchronous result. The default future completes successfully with `None`, meaning no credential was resolved.

**Call relations**: `AuthManager::resolve_external_api_key_auth` calls this for external API-key-style providers. Implementations can override it to supply cached or immediate auth.

*Call graph*: 1 external calls (pin).


##### `RefreshTokenError::failed_reason`  (lines 197–202)

```
fn failed_reason(&self) -> Option<RefreshTokenFailedReason>
```

**Purpose**: Extracts the known reason for a refresh failure when the failure is permanent. Temporary errors, such as network problems, do not have a final reason.

**Data flow**: It reads a `RefreshTokenError`. If it wraps a permanent backend error, it returns that reason. If it wraps an I/O-style transient error, it returns nothing.

**Call relations**: Callers can use this to report or branch on why token refresh failed without unpacking the error enum themselves.


##### `Error::from`  (lines 206–211)

```
fn from(err: RefreshTokenError) -> Self
```

**Purpose**: Converts a token refresh error into a standard I/O error so it can pass through APIs that use `std::io::Result`.

**Data flow**: It receives a `RefreshTokenError`. Permanent failures are wrapped as a new generic I/O error, while transient I/O failures are returned as-is. The output is a `std::io::Error`.

**Call relations**: This bridges the custom refresh-error type with storage and higher-level code that already uses I/O errors.

*Call graph*: 1 external calls (other).


##### `CodexAuth::from_auth_dot_json`  (lines 215–280)

```
async fn from_auth_dot_json(
        codex_home: &Path,
        auth_dot_json: AuthDotJson,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<&str>,
```

**Purpose**: Turns the raw stored auth record into the richer `CodexAuth` value used by the program. It validates that the required credential exists for the selected auth mode.

**Data flow**: It receives the Codex home directory, an `AuthDotJson` payload, storage settings, optional ChatGPT base URL, and keyring choice. It inspects the resolved auth mode, verifies or loads the right credential type, and returns a matching `CodexAuth` variant or an error if required data is missing.

**Call relations**: `load_auth` uses this after reading credentials from storage. Tests also use it to check refresh failure behavior against a stored auth snapshot.

*Call graph*: calls 2 internal fn (create_client, create_auth_storage); called by 2 (refresh_failure_is_scoped_to_the_matching_auth_snapshot, load_auth); 13 external calls (new, new, to_path_buf, BedrockApiKey, Chatgpt, ChatgptAuthTokens, from_agent_identity_jwt, from_api_key, from_personal_access_token, other (+3 more)).


##### `CodexAuth::from_auth_storage`  (lines 282–297)

```
async fn from_auth_storage(
        codex_home: &Path,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<&str>,
        keyring_backend_kind: AuthKeyringB
```

**Purpose**: Loads the current stored login and converts it into a `CodexAuth`, without allowing the Codex API key environment variable to override it.

**Data flow**: It receives storage location and configuration. It calls the shared auth-loading path with environment override disabled. It returns either no auth, a loaded auth value, or an error.

**Call relations**: Status and CLI-related code use this when they want to inspect saved auth rather than the full runtime precedence rules.

*Call graph*: calls 1 internal fn (load_auth); called by 5 (run_login_status, load_cli_auth_mode, prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens, missing_auth_json_returns_none, chatgpt_auth_tokens_for_tests).


##### `CodexAuth::from_agent_identity_jwt`  (lines 299–309)

```
async fn from_agent_identity_jwt(
        jwt: &str,
        chatgpt_base_url: Option<&str>,
    ) -> std::io::Result<Self>
```

**Purpose**: Creates an agent-identity login from a JWT, which is a signed token containing identity claims. It verifies the token before accepting it.

**Data flow**: It receives the JWT text and an optional ChatGPT backend URL. It normalizes the URL, verifies the JWT against fetched signing keys, converts the claims to a record, loads agent identity auth, and returns it as `CodexAuth`.

**Call relations**: Remote auth loading and the generic auth loader use this when a credential is classified as an agent identity token.

*Call graph*: calls 2 internal fn (load, verified_agent_identity_record); called by 3 (load_exec_server_remote_auth_provider, assert_agent_identity_plan_alias, load_auth); 1 external calls (AgentIdentity).


##### `CodexAuth::from_personal_access_token`  (lines 311–315)

```
async fn from_personal_access_token(access_token: &str) -> std::io::Result<Self>
```

**Purpose**: Creates a login from a personal access token after loading and validating its account information.

**Data flow**: It receives the token string. It asks `PersonalAccessTokenAuth` to load it and returns a `CodexAuth::PersonalAccessToken` on success.

**Call relations**: This is the simple constructor used when code already knows the token is a personal access token.

*Call graph*: calls 1 internal fn (load); 1 external calls (PersonalAccessToken).


##### `CodexAuth::auth_mode`  (lines 317–325)

```
fn auth_mode(&self) -> AuthMode
```

**Purpose**: Reports the broad auth category used by this login, such as API key, ChatGPT, agent identity, or personal access token.

**Data flow**: It reads the current `CodexAuth` variant and maps it to the public `AuthMode`. It returns that mode without changing anything.

**Call relations**: Other helper methods use it to answer yes/no questions, and UI or request-building code can use it to describe the current login.

*Call graph*: called by 3 (auth_mode_name, is_api_key_auth, is_personal_access_token_auth).


##### `CodexAuth::api_auth_mode`  (lines 327–336)

```
fn api_auth_mode(&self) -> ApiAuthMode
```

**Purpose**: Reports the more precise API auth mode, including the distinction between stored ChatGPT auth and externally supplied ChatGPT tokens.

**Data flow**: It reads the `CodexAuth` variant and returns the matching protocol-level mode. Nothing is modified.

**Call relations**: Equality checks, backend selection, and request-building code use this when the exact wire-facing auth type matters.

*Call graph*: called by 4 (build_remote_plugin_detail, eq, is_chatgpt_auth, uses_codex_backend).


##### `CodexAuth::is_api_key_auth`  (lines 338–340)

```
fn is_api_key_auth(&self) -> bool
```

**Purpose**: Answers whether this login is an API key login.

**Data flow**: It reads the auth mode and compares it to the API key mode. It returns a boolean.

**Call relations**: Remote-auth support checks and token-refresh logic use this to skip refresh work that does not apply to API keys.

*Call graph*: calls 1 internal fn (auth_mode); called by 1 (is_supported_exec_server_remote_auth).


##### `CodexAuth::is_personal_access_token_auth`  (lines 342–344)

```
fn is_personal_access_token_auth(&self) -> bool
```

**Purpose**: Answers whether this login uses a personal access token.

**Data flow**: It reads the broad auth mode and compares it to the personal-access-token mode. It returns true or false.

**Call relations**: Recovery logic uses this to explain that personal access tokens are not refreshed through the ChatGPT OAuth flow.

*Call graph*: calls 1 internal fn (auth_mode).


##### `CodexAuth::is_chatgpt_auth`  (lines 346–348)

```
fn is_chatgpt_auth(&self) -> bool
```

**Purpose**: Answers whether this auth value belongs to a ChatGPT account style of login.

**Data flow**: It reads the precise API auth mode and asks whether that mode has a ChatGPT account. It returns a boolean.

**Call relations**: Remote-auth compatibility checks use this to decide whether ChatGPT-backed auth is acceptable.

*Call graph*: calls 1 internal fn (api_auth_mode); called by 1 (is_supported_exec_server_remote_auth).


##### `CodexAuth::uses_codex_backend`  (lines 350–352)

```
fn uses_codex_backend(&self) -> bool
```

**Purpose**: Answers whether this credential is meant for the Codex backend rather than a direct provider API.

**Data flow**: It reads the precise API auth mode and asks that mode whether it uses the Codex backend. It returns a boolean.

**Call relations**: Cloud configuration eligibility code uses this to decide whether backend-based features can be enabled.

*Call graph*: calls 1 internal fn (api_auth_mode); called by 1 (cloud_config_eligible_auth).


##### `CodexAuth::is_external_chatgpt_tokens`  (lines 354–356)

```
fn is_external_chatgpt_tokens(&self) -> bool
```

**Purpose**: Answers whether the current auth came from externally managed ChatGPT tokens.

**Data flow**: It checks whether the enum variant is `ChatgptAuthTokens`. It returns true only for that temporary external-token mode.

**Call relations**: Unauthorized recovery uses this to choose the external refresh path instead of the normal stored refresh-token path.

*Call graph*: 1 external calls (matches!).


##### `CodexAuth::supports_unauthorized_recovery`  (lines 358–360)

```
fn supports_unauthorized_recovery(&self) -> bool
```

**Purpose**: Answers whether a 401 Unauthorized response can trigger an automatic recovery attempt for this auth value.

**Data flow**: It checks whether the auth is managed ChatGPT auth or external ChatGPT tokens. It returns false for API keys, personal tokens, agent identity, and Bedrock keys.

**Call relations**: `UnauthorizedRecovery` calls this before offering reload or refresh steps.

*Call graph*: 1 external calls (matches!).


##### `CodexAuth::api_key`  (lines 363–372)

```
fn api_key(&self) -> Option<&str>
```

**Purpose**: Returns the API key string when this auth value is actually API-key-based.

**Data flow**: It inspects the enum variant. For `ApiKey`, it returns a borrowed string slice. For all other modes, it returns nothing.

**Call relations**: Refresh-aware equality uses this to compare two API-key auth snapshots safely.


##### `CodexAuth::get_token_data`  (lines 375–385)

```
fn get_token_data(&self) -> Result<TokenData, std::io::Error>
```

**Purpose**: Returns the full ChatGPT token bundle when token-backed ChatGPT auth is available.

**Data flow**: It reads the current in-memory auth JSON snapshot. If it contains token data and a refresh timestamp, it returns the tokens. Otherwise it returns an error saying token data is unavailable.

**Call relations**: `get_token` and login-restriction code use this when they need ChatGPT token details.

*Call graph*: calls 1 internal fn (get_current_auth_json); called by 1 (get_token); 1 external calls (other).


##### `CodexAuth::get_token`  (lines 388–403)

```
fn get_token(&self) -> Result<String, std::io::Error>
```

**Purpose**: Returns the bearer token or API key string that request code can use for authentication, when that kind of token is exposed.

**Data flow**: It receives a `CodexAuth`. For API keys it returns the key. For ChatGPT auth it returns the access token from token data. For personal access tokens it returns the token. For agent identity and Bedrock key auth, it returns an error because those modes do not expose a Codex bearer token here.

**Call relations**: Auth-provider construction calls this when it needs a raw token string for outgoing requests.

*Call graph*: calls 1 internal fn (get_token_data); called by 1 (auth_provider_from_auth); 1 external calls (other).


##### `CodexAuth::get_account_id`  (lines 406–412)

```
fn get_account_id(&self) -> Option<String>
```

**Purpose**: Returns the account or workspace identifier associated with Codex backend auth, when one is available.

**Data flow**: It reads account information from agent identity auth, personal access token auth, or ChatGPT token data. It returns an owned string if found.

**Call relations**: Identity, workspace checks, and unauthorized recovery use this to keep account-sensitive operations tied to the expected account.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 5 (connector_directory_cache_context, auth_identity, global, ensure_unlisted_workspace_target, auth_provider_from_auth).


##### `CodexAuth::is_fedramp_account`  (lines 415–423)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: Answers whether the current account is marked as a FedRAMP account. FedRAMP is a U.S. government security compliance program.

**Data flow**: It checks the FedRAMP flag from agent identity auth, personal access token auth, or ChatGPT ID token claims. If no claim exists, it returns false.

**Call relations**: Request auth-provider setup uses this to adjust behavior for FedRAMP accounts.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 1 (auth_provider_from_auth).


##### `CodexAuth::get_account_email`  (lines 426–432)

```
fn get_account_email(&self) -> Option<String>
```

**Purpose**: Returns the email address associated with the current account when the credential exposes one.

**Data flow**: It reads the email from agent identity auth, personal access token auth, or ChatGPT token claims. It returns an owned string if available.

**Call relations**: Callers can use this for display or identity context without knowing which auth mode is active.

*Call graph*: calls 1 internal fn (get_current_token_data).


##### `CodexAuth::get_chatgpt_user_id`  (lines 435–443)

```
fn get_chatgpt_user_id(&self) -> Option<String>
```

**Purpose**: Returns the ChatGPT user id attached to the current login when available.

**Data flow**: It reads the user id from agent identity auth, personal access token auth, or ChatGPT token data. It returns the id as a string or nothing.

**Call relations**: Identity and connector cache code use this to associate data with the correct ChatGPT user.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 3 (connector_directory_cache_context, auth_identity, global).


##### `CodexAuth::account_plan_type`  (lines 448–462)

```
fn account_plan_type(&self) -> Option<AccountPlanType>
```

**Purpose**: Returns the user's plan type, such as Free, Plus, Pro, Team, or an unknown value. This helps product code decide what features or UI should apply.

**Data flow**: It reads the plan from agent identity auth, personal access token auth, or ChatGPT ID token claims. If ChatGPT tokens lack a plan, it returns Unknown. If no account plan can be read, it returns nothing.

**Call relations**: Workspace checks and cloud-config eligibility use this to understand the account category.

*Call graph*: calls 1 internal fn (get_current_token_data); called by 2 (cloud_config_eligible_auth, is_workspace_account).


##### `CodexAuth::is_workspace_account`  (lines 464–467)

```
fn is_workspace_account(&self) -> bool
```

**Purpose**: Answers whether the current account plan represents a workspace-style account.

**Data flow**: It gets the account plan type and asks that plan whether it is a workspace account. It returns false when no plan is known.

**Call relations**: Connector and global identity context code use this to label or route workspace accounts.

*Call graph*: calls 1 internal fn (account_plan_type); called by 2 (connector_directory_cache_context, global).


##### `CodexAuth::get_current_auth_json`  (lines 470–481)

```
fn get_current_auth_json(&self) -> Option<AuthDotJson>
```

**Purpose**: Returns the current in-memory raw auth record for ChatGPT-token-based auth.

**Data flow**: It checks whether the auth value is managed ChatGPT auth or external ChatGPT tokens. If so, it locks the shared auth record and clones it. Other auth modes return nothing.

**Call relations**: Token-data helpers and logout-with-revoke use this to inspect the stored ChatGPT token payload.

*Call graph*: called by 2 (get_current_token_data, get_token_data).


##### `CodexAuth::get_current_token_data`  (lines 484–486)

```
fn get_current_token_data(&self) -> Option<TokenData>
```

**Purpose**: Returns the current ChatGPT token data, if this auth value has any.

**Data flow**: It first gets the current auth JSON snapshot. It then extracts the `tokens` field. It returns token data or nothing.

**Call relations**: Account id, email, user id, plan, and FedRAMP helpers all use this shared extraction path.

*Call graph*: calls 1 internal fn (get_current_auth_json); called by 5 (account_plan_type, get_account_email, get_account_id, get_chatgpt_user_id, is_fedramp_account).


##### `CodexAuth::create_dummy_chatgpt_auth_for_testing`  (lines 489–517)

```
fn create_dummy_chatgpt_auth_for_testing() -> Self
```

**Purpose**: Creates a fake ChatGPT login for tests. It lets tests run code paths that require ChatGPT auth without using real credentials.

**Data flow**: It builds an in-memory auth record with placeholder token values, creates a client and ephemeral storage, assigns a unique dummy storage name, and returns `CodexAuth::Chatgpt`.

**Call relations**: Many tests use this as a safe stand-in for a real logged-in user.

*Call graph*: calls 3 internal fn (default, create_client, create_auth_storage); called by 139 (capture_file_writes_exact_serialized_request, capture_file_writes_final_batches_as_separate_lines, remote_control_auth_manager, remote_control_auth_manager_with_home, remote_control_auth_manager, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items, effective_mcp_servers_preserve_runtime_servers, expands_cached_remote_plugins_by_loaded_apps (+15 more)); 7 external calls (new, default, new, from, Chatgpt, now, format!).


##### `CodexAuth::from_api_key`  (lines 519–523)

```
fn from_api_key(api_key: &str) -> Self
```

**Purpose**: Creates an API-key auth value from a raw key string.

**Data flow**: It receives a string slice, copies it into an owned string, wraps it in `ApiKeyAuth`, and returns `CodexAuth::ApiKey`.

**Call relations**: Environment-variable loading, test setup, and external API-key resolution all use this small constructor.

*Call graph*: called by 65 (refresh_test_state, load_cli_auth_mode, exec_server_remote_auth_accepts_api_key_auth, returns_api_curated_fallback_plugins_for_direct_provider_auth, interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent, new_with_config, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_releases_slot_after_resume_failure (+15 more)); 1 external calls (ApiKey).


##### `ChatgptAuth::current_auth_json`  (lines 527–530)

```
fn current_auth_json(&self) -> Option<AuthDotJson>
```

**Purpose**: Returns a cloned copy of the current raw ChatGPT auth record held by a `ChatgptAuth` value.

**Data flow**: It locks the shared auth JSON slot, clones the optional payload, and returns it.

**Call relations**: `ChatgptAuth::current_token_data` and proactive-refresh checks use this to inspect the current token state.

*Call graph*: called by 1 (current_token_data).


##### `ChatgptAuth::current_token_data`  (lines 532–534)

```
fn current_token_data(&self) -> Option<TokenData>
```

**Purpose**: Returns the token bundle from a `ChatgptAuth` value, if present.

**Data flow**: It gets the current auth JSON and extracts its `tokens` field. It returns token data or nothing.

**Call relations**: The token refresh path uses this to find the refresh token before contacting the OAuth service.

*Call graph*: calls 1 internal fn (current_auth_json).


##### `ChatgptAuth::storage`  (lines 536–538)

```
fn storage(&self) -> &Arc<dyn AuthStorageBackend>
```

**Purpose**: Gives access to the storage backend where this ChatGPT auth should be saved.

**Data flow**: It borrows the stored `Arc` pointing to the auth storage backend and returns it.

**Call relations**: The refresh-and-persist path uses this so refreshed tokens are written back to the same place they came from.

*Call graph*: called by 1 (refresh_and_persist_chatgpt_token).


##### `ChatgptAuth::client`  (lines 540–542)

```
fn client(&self) -> &CodexHttpClient
```

**Purpose**: Gives access to the HTTP client used for ChatGPT token refresh requests.

**Data flow**: It borrows the stored Codex HTTP client and returns it.

**Call relations**: The ChatGPT refresh path passes this client into the network request helper.

*Call graph*: called by 1 (refresh_and_persist_chatgpt_token).


##### `read_openai_api_key_from_env`  (lines 549–554)

```
fn read_openai_api_key_from_env() -> Option<String>
```

**Purpose**: Reads the legacy `OPENAI_API_KEY` environment variable if it contains a non-empty value.

**Data flow**: It looks up the environment variable, trims whitespace, filters out empty strings, and returns the key if present.

**Call relations**: This helper is available for code that still needs the OpenAI API key variable rather than the Codex-specific one.

*Call graph*: 1 external calls (var).


##### `read_codex_api_key_from_env`  (lines 556–558)

```
fn read_codex_api_key_from_env() -> Option<String>
```

**Purpose**: Reads the `CODEX_API_KEY` environment variable when it is set to a non-empty value.

**Data flow**: It delegates to the shared non-empty environment reader. The result is an optional string.

**Call relations**: `load_auth` uses this first when environment API-key overrides are enabled.

*Call graph*: calls 1 internal fn (read_non_empty_env_var); called by 1 (load_auth).


##### `read_codex_access_token_from_env`  (lines 560–562)

```
fn read_codex_access_token_from_env() -> Option<String>
```

**Purpose**: Reads the `CODEX_ACCESS_TOKEN` environment variable when it is set to a non-empty value.

**Data flow**: It delegates to the shared non-empty environment reader. The result is an optional token string.

**Call relations**: `load_auth` uses this after checking temporary storage and before falling back to persistent storage.

*Call graph*: calls 1 internal fn (read_non_empty_env_var); called by 1 (load_auth).


##### `read_non_empty_env_var`  (lines 564–569)

```
fn read_non_empty_env_var(key: &str) -> Option<String>
```

**Purpose**: Provides the shared rule for reading environment variables: trim whitespace and ignore empty values.

**Data flow**: It receives an environment variable name, reads it, trims the value, and returns `None` if the variable is missing or empty.

**Call relations**: The Codex API key and Codex access token readers both use this helper.

*Call graph*: called by 2 (read_codex_access_token_from_env, read_codex_api_key_from_env); 1 external calls (var).


##### `verified_agent_identity_record`  (lines 571–581)

```
async fn verified_agent_identity_record(
    jwt: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<AgentIdentityAuthRecord>
```

**Purpose**: Validates an agent identity JWT and converts its claims into the stored record format. This prevents accepting a token before its signature and contents are checked.

**Data flow**: It first parses the JWT enough to confirm it has the expected shape, fetches the public signing keys from the ChatGPT backend, decodes and verifies the JWT, and converts the verified claims into an `AgentIdentityAuthRecord`.

**Call relations**: Agent-identity login creation and access-token login both call this before accepting an agent identity token.

*Call graph*: calls 2 internal fn (build_reqwest_client, from_agent_identity_jwt); called by 2 (from_agent_identity_jwt, login_with_access_token); 2 external calls (decode_agent_identity_jwt, fetch_agent_identity_jwks).


##### `logout`  (lines 585–596)

```
fn logout(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool>
```

**Purpose**: Deletes the stored auth record from the selected credential store.

**Data flow**: It creates the configured auth storage backend for the given Codex home directory and asks it to delete the auth data. It returns whether anything was removed.

**Call relations**: `logout_all_stores` calls this for one or more stores so logout can clear both temporary and persistent credentials.

*Call graph*: calls 1 internal fn (create_auth_storage); called by 1 (logout_all_stores); 1 external calls (to_path_buf).


##### `logout_with_revoke`  (lines 598–622)

```
async fn logout_with_revoke(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool>
```

**Purpose**: Logs out and also tries to revoke ChatGPT OAuth tokens with the auth service. Revoking is best-effort: local logout still proceeds even if revocation fails.

**Data flow**: It tries to load the raw stored auth, passes it to the token revocation helper, logs warnings for failures, then clears all relevant local stores. It returns whether local credentials were removed.

**Call relations**: This top-level helper is used when callers want a stronger logout than simply deleting local files.

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

**Purpose**: Saves an API key login into auth storage.

**Data flow**: It builds an `AuthDotJson` payload containing only the API key and its mode. It then writes that payload using `save_auth`.

**Call relations**: Login flows call this after the user provides an API key.

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

**Purpose**: Saves a Codex access token login, after deciding whether the token is a personal access token or an agent identity JWT.

**Data flow**: It classifies the token. For a personal access token, it loads the token details and checks workspace restrictions. For an agent identity JWT, it verifies the JWT. It then writes the correct auth payload to storage.

**Call relations**: Login commands use this for token-based login. It shares verification logic with runtime loading so invalid tokens are rejected early.

*Call graph*: calls 5 internal fn (classify_codex_access_token, ensure_personal_access_token_workspace_allowed, save_auth, verified_agent_identity_record, load).


##### `ensure_personal_access_token_workspace_allowed`  (lines 698–704)

```
fn ensure_personal_access_token_workspace_allowed(
    expected_workspace_ids: Option<&[String]>,
    auth: &PersonalAccessTokenAuth,
) -> std::io::Result<()>
```

**Purpose**: Checks that a personal access token belongs to an allowed workspace when workspace restrictions are configured.

**Data flow**: It receives optional expected workspace ids and a loaded personal access token auth object. It compares the token's account id against the allowed list and converts any violation into a permission-denied I/O error.

**Call relations**: Both login and auth loading call this so restricted configurations cannot use the wrong personal access token.

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

**Purpose**: Stores externally supplied ChatGPT tokens in the temporary in-memory auth store.

**Data flow**: It receives an access token, account id, and optional plan. It converts them into an external-token auth payload and saves it using ephemeral storage.

**Call relations**: External host applications can use this to seed Codex with ChatGPT auth without writing long-lived credentials.

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

**Purpose**: Writes an auth payload to the configured credential backend.

**Data flow**: It receives the Codex home path, raw auth payload, storage mode, and keyring backend choice. It creates the correct storage backend and saves the payload there.

**Call relations**: All login paths and external refresh code use this single write path.

*Call graph*: calls 1 internal fn (create_auth_storage); called by 5 (login_with_bedrock_api_key, refresh_external_auth, login_with_access_token, login_with_api_key, login_with_chatgpt_auth_tokens); 1 external calls (to_path_buf).


##### `load_auth_dot_json`  (lines 746–757)

```
fn load_auth_dot_json(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads the raw stored auth payload without applying environment-variable overrides or converting it into `CodexAuth`.

**Data flow**: It creates the configured storage backend and asks it to load the saved auth record. It returns the raw payload if one exists.

**Call relations**: Logout with token revocation uses this because it needs the exact stored token data.

*Call graph*: calls 1 internal fn (create_auth_storage); called by 1 (logout_with_revoke); 1 external calls (to_path_buf).


##### `enforce_login_restrictions`  (lines 769–865)

```
async fn enforce_login_restrictions(config: &AuthConfig) -> std::io::Result<()>
```

**Purpose**: Checks whether the current login obeys configured restrictions, such as requiring API-key login or limiting ChatGPT login to certain workspaces.

**Data flow**: It loads the current auth using normal runtime rules. It compares the auth mode against any forced login method, then checks workspace/account ids when configured. If a rule is broken, it logs out all stores and returns an error message explaining why.

**Call relations**: Startup or configuration-change code can call this to make sure stale credentials do not violate policy.

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

**Purpose**: Clears credentials and returns an error containing a human-readable reason for the forced logout.

**Data flow**: It tries to remove all relevant auth stores. It combines the caller's message with any deletion error. It always returns an I/O error carrying the final message.

**Call relations**: `enforce_login_restrictions` uses this whenever a configured login rule is violated.

*Call graph*: calls 1 internal fn (logout_all_stores); called by 1 (enforce_login_restrictions); 2 external calls (other, format!).


##### `logout_all_stores`  (lines 887–910)

```
fn logout_all_stores(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> std::io::Result<bool>
```

**Purpose**: Clears both temporary and configured persistent auth stores when needed, so logout really removes active auth.

**Data flow**: It checks the configured storage mode. If the mode is already ephemeral, it deletes only the ephemeral store. Otherwise it deletes the ephemeral store first and then the configured store, returning whether either one was removed.

**Call relations**: Manager logout, top-level logout with revocation, and forced logout all use this helper.

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

**Purpose**: Applies the full runtime precedence rules for finding the current login. This is the main loading pipeline for credentials.

**Data flow**: It may first accept `CODEX_API_KEY` from the environment. It then checks temporary external auth storage, then `CODEX_ACCESS_TOKEN`, then persistent storage unless the caller requested ephemeral-only auth. It converts raw records to `CodexAuth` and enforces workspace restrictions for personal access tokens.

**Call relations**: Auth manager startup, reloads, restriction checks, and direct storage loading all funnel through this function.

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

**Purpose**: Updates saved ChatGPT token data after a successful refresh.

**Data flow**: It loads the current auth payload from storage, inserts or updates token fields that were returned by the server, parses a new ID token if present, updates the last-refresh timestamp, saves the record, and returns the updated payload.

**Call relations**: The ChatGPT token refresh flow calls this after receiving new tokens from the OAuth service.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); called by 1 (refresh_and_persist_chatgpt_token); 2 external calls (now, other).


##### `request_chatgpt_token_refresh`  (lines 1020–1061)

```
async fn request_chatgpt_token_refresh(
    refresh_token: String,
    client: &CodexHttpClient,
) -> Result<RefreshResponse, RefreshTokenError>
```

**Purpose**: Calls the ChatGPT OAuth token endpoint to exchange a refresh token for fresh tokens.

**Data flow**: It builds a refresh request with the OAuth client id and refresh token, sends it with the shared HTTP client, and parses a successful response. On failure it classifies permanent refresh-token problems separately from temporary network or server problems.

**Call relations**: `AuthManager::refresh_and_persist_chatgpt_token` calls this before saving refreshed tokens.

*Call graph*: calls 5 internal fn (post, classify_refresh_token_failure, oauth_client_id, refresh_token_endpoint, try_parse_error_message); called by 1 (refresh_and_persist_chatgpt_token); 5 external calls (other, format!, Permanent, Transient, error!).


##### `classify_refresh_token_failure`  (lines 1063–1090)

```
fn classify_refresh_token_failure(body: &str) -> RefreshTokenFailedError
```

**Purpose**: Turns an error response body from the OAuth service into a user-facing permanent refresh failure reason.

**Data flow**: It extracts a backend error code from the response body, maps known codes to expired, reused, or revoked refresh-token reasons, logs unknown responses, and returns a structured `RefreshTokenFailedError` with a helpful message.

**Call relations**: The token refresh HTTP helper uses this when the auth service rejects a refresh request.

*Call graph*: calls 2 internal fn (extract_refresh_token_error_code, new); called by 1 (request_chatgpt_token_refresh); 1 external calls (warn!).


##### `extract_refresh_token_error_code`  (lines 1092–1116)

```
fn extract_refresh_token_error_code(body: &str) -> Option<String>
```

**Purpose**: Pulls a refresh-token error code out of a JSON error response.

**Data flow**: It receives the raw response body, ignores empty or non-JSON bodies, then looks for a code in common places such as `error.code`, `error`, or top-level `code`. It returns the code string if found.

**Call relations**: `classify_refresh_token_failure` uses this to understand backend error responses without depending on one exact JSON shape.

*Call graph*: called by 1 (classify_refresh_token_failure).


##### `oauth_client_id`  (lines 1135–1140)

```
fn oauth_client_id() -> String
```

**Purpose**: Returns the OAuth client id used for ChatGPT token refresh, allowing tests or special environments to override it.

**Data flow**: It checks an override environment variable. If it is present and non-empty, that value is returned. Otherwise it returns the built-in client id.

**Call relations**: The token refresh request builder calls this before contacting the OAuth endpoint.

*Call graph*: called by 2 (request_chatgpt_token_refresh, client_id); 1 external calls (var).


##### `refresh_token_endpoint`  (lines 1142–1145)

```
fn refresh_token_endpoint() -> String
```

**Purpose**: Returns the OAuth refresh-token endpoint URL, with an environment override for testing or alternate deployments.

**Data flow**: It reads the override environment variable. If absent, it returns the default OpenAI auth URL.

**Call relations**: The token refresh HTTP helper uses this as the destination for refresh requests.

*Call graph*: called by 1 (request_chatgpt_token_refresh); 1 external calls (var).


##### `AuthDotJson::from_external_tokens`  (lines 1148–1179)

```
fn from_external_tokens(external: &ExternalAuthTokens) -> std::io::Result<Self>
```

**Purpose**: Converts externally supplied ChatGPT tokens into the same raw auth format used by Codex storage.

**Data flow**: It requires ChatGPT metadata, parses the access token claims, fills in account id and plan information, builds `TokenData`, marks the auth mode as external ChatGPT tokens, and stamps the current time.

**Call relations**: External auth refresh uses this before saving temporary auth. It rejects access-token-only external credentials when ChatGPT metadata is required.

*Call graph*: calls 2 internal fn (chatgpt_metadata, parse_chatgpt_jwt_claims); 4 external calls (Unknown, new, now, other).


##### `AuthDotJson::from_external_access_token`  (lines 1181–1192)

```
fn from_external_access_token(
        access_token: &str,
        chatgpt_account_id: &str,
        chatgpt_plan_type: Option<&str>,
    ) -> std::io::Result<Self>
```

**Purpose**: Convenience helper that builds external ChatGPT token metadata from plain arguments and converts it to `AuthDotJson`.

**Data flow**: It receives an access token, account id, and optional plan. It creates `ExternalAuthTokens::chatgpt` and delegates to `from_external_tokens`.

**Call relations**: `login_with_chatgpt_auth_tokens` uses this to seed ephemeral ChatGPT auth.

*Call graph*: calls 1 internal fn (chatgpt); 1 external calls (from_external_tokens).


##### `AuthDotJson::resolved_mode`  (lines 1194–1208)

```
fn resolved_mode(&self) -> ApiAuthMode
```

**Purpose**: Determines the effective auth mode of a raw auth record, even when older records do not explicitly store a mode.

**Data flow**: It first returns the explicit mode if present. Otherwise it infers personal access token, Bedrock API key, API key, or finally ChatGPT based on which credential fields are populated.

**Call relations**: Auth loading and storage-mode selection use this to support backward-compatible auth files.

*Call graph*: called by 1 (storage_mode).


##### `AuthDotJson::storage_mode`  (lines 1210–1219)

```
fn storage_mode(
        &self,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
    ) -> AuthCredentialsStoreMode
```

**Purpose**: Chooses which storage mode should be used for this auth record.

**Data flow**: It checks the resolved mode. External ChatGPT token records are forced to ephemeral storage; all other records use the caller's configured storage mode.

**Call relations**: `CodexAuth::from_auth_dot_json` uses this when creating storage for ChatGPT auth.

*Call graph*: calls 1 internal fn (resolved_mode).


##### `CachedAuth::fmt`  (lines 1238–1252)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats cached auth state for debug logs without printing secrets.

**Data flow**: It reads the cached auth mode and permanent refresh-failure reason, then writes only those safe fields into the debug output.

**Call relations**: `AuthManager` debug formatting includes this, giving useful diagnostics while avoiding token leakage.

*Call graph*: 1 external calls (debug_struct).


##### `UnauthorizedRecoveryStepResult::auth_state_changed`  (lines 1308–1310)

```
fn auth_state_changed(&self) -> Option<bool>
```

**Purpose**: Reports whether a recovery step changed the cached auth state.

**Data flow**: It returns the stored optional boolean. `Some(true)` means auth changed, `Some(false)` means it was checked but unchanged, and `None` means no meaningful step ran.

**Call relations**: Unauthorized handling code can use this after calling `UnauthorizedRecovery::next` to decide whether retry context changed.


##### `UnauthorizedRecovery::new`  (lines 1314–1336)

```
fn new(manager: Arc<AuthManager>) -> Self
```

**Purpose**: Creates a recovery state machine for handling a 401 Unauthorized response.

**Data flow**: It reads the manager's cached auth, remembers the expected account id, chooses managed or external recovery mode, and sets the first step accordingly.

**Call relations**: `AuthManager::unauthorized_recovery` constructs this whenever request code wants a controlled retry plan.

*Call graph*: called by 1 (unauthorized_recovery).


##### `UnauthorizedRecovery::has_next`  (lines 1338–1357)

```
fn has_next(&self) -> bool
```

**Purpose**: Answers whether another recovery step is available.

**Data flow**: It checks whether external API-key auth is still retryable, whether the current auth supports recovery, whether external auth is configured when required, and whether the state machine is already done. It returns a boolean.

**Call relations**: Unauthorized handlers call this before attempting another recovery step, and `next` uses it as its own guard.

*Call graph*: called by 3 (recover_remote_control_auth, handle_unauthorized, next); 1 external calls (matches!).


##### `UnauthorizedRecovery::unavailable_reason`  (lines 1359–1395)

```
fn unavailable_reason(&self) -> &'static str
```

**Purpose**: Explains in a compact machine-readable string why recovery is or is not available.

**Data flow**: It inspects the current auth, external auth configuration, and current step. It returns labels such as `ready`, `not_chatgpt_auth`, `no_external_auth`, or `recovery_exhausted`.

**Call relations**: Callers can log or report this when a 401 cannot be automatically recovered.

*Call graph*: 1 external calls (matches!).


##### `UnauthorizedRecovery::mode_name`  (lines 1397–1402)

```
fn mode_name(&self) -> &'static str
```

**Purpose**: Returns a short name for the recovery mode: managed or external.

**Data flow**: It reads the stored recovery mode enum and returns a static string.

**Call relations**: Remote-control recovery logging uses this to describe which path is being attempted.

*Call graph*: called by 1 (recover_remote_control_auth).


##### `UnauthorizedRecovery::step_name`  (lines 1404–1411)

```
fn step_name(&self) -> &'static str
```

**Purpose**: Returns a short name for the current recovery step.

**Data flow**: It reads the current step enum and returns strings such as `reload`, `refresh_token`, `external_refresh`, or `done`.

**Call relations**: Remote-control recovery logging uses this to show progress through the recovery plan.

*Call graph*: called by 1 (recover_remote_control_auth).


##### `UnauthorizedRecovery::next`  (lines 1413–1470)

```
async fn next(&mut self) -> Result<UnauthorizedRecoveryStepResult, RefreshTokenError>
```

**Purpose**: Runs the next available unauthorized-recovery step.

**Data flow**: It first checks that a step is available. It may reload auth if the account still matches, refresh a managed ChatGPT token, or ask an external auth provider for new credentials. It advances the state machine and returns whether auth changed, or returns a refresh error.

**Call relations**: Unauthorized request handlers call this between retries after a 401 response.

*Call graph*: calls 2 internal fn (has_next, new); called by 2 (recover_remote_control_auth, handle_unauthorized); 1 external calls (Permanent).


##### `AuthManager::fmt`  (lines 1518–1535)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the auth manager for debug logs without exposing secret token values.

**Data flow**: It writes configuration fields, cached auth summary, workspace restriction state, base URL, and whether external auth exists. It omits sensitive credential contents.

**Call relations**: Debug logging can use this to inspect manager setup safely.

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

**Purpose**: Creates an auth manager and loads the initial auth state using the provided settings.

**Data flow**: It receives storage and URL configuration, then delegates to the constructor that also supports workspace restrictions with no restriction set. It returns a manager with cached auth if loading succeeds.

**Call relations**: Tests and setup code use this when no forced workspace list is needed.

*Call graph*: called by 12 (auth_manager_with_api_key, auth_manager_with_plan_and_identity, get_bundle_recovers_after_unauthorized_reload, get_bundle_recovers_after_unauthorized_reload_updates_cache_identity, get_bundle_surfaces_auth_recovery_message, get_bundle_unauthorized_without_recovery_uses_generic_message, load_auth_manager, personal_access_token_does_not_offer_unauthorized_recovery, bedrock_only_auth_storage_creates_primary_auth, login_with_bedrock_api_key_replaces_openai_auth (+2 more)); 1 external calls (new_with_workspace_restriction).


##### `AuthManager::new_with_workspace_restriction`  (lines 1561–1596)

```
async fn new_with_workspace_restriction(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        forced_chatgpt_work
```

**Purpose**: Creates an auth manager while applying an optional list of allowed ChatGPT workspace ids.

**Data flow**: It attempts to load auth using the full loading pipeline and the workspace restriction. Loading errors are swallowed into an unauthenticated cache. It also creates a watch channel for auth-change notifications and initializes locks and external-auth state.

**Call relations**: The public constructors and config-based constructor use this as the real setup path.

*Call graph*: calls 1 internal fn (load_auth); called by 2 (auth_manager_rejects_env_personal_access_token_workspace_mismatch, auth_manager_rejects_stored_personal_access_token_workspace_mismatch); 3 external calls (new, new, channel).


##### `AuthManager::from_auth_for_testing`  (lines 1599–1618)

```
fn from_auth_for_testing(auth: CodexAuth) -> Arc<Self>
```

**Purpose**: Builds an `AuthManager` around a supplied auth value for tests.

**Data flow**: It wraps the provided auth in cached state, fills in dummy paths and default storage settings, creates a watch channel, and returns the manager in an `Arc` shared pointer.

**Call relations**: Many tests use this to bypass storage and start with exactly the auth state they need.

*Call graph*: calls 1 internal fn (default); called by 42 (refresh_test_state, model_client_with_counting_attestation, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, auth_manager_from_auth (+15 more)); 5 external calls (new, from, new, new, channel).


##### `AuthManager::from_auth_for_testing_with_home`  (lines 1621–1639)

```
fn from_auth_for_testing_with_home(auth: CodexAuth, codex_home: PathBuf) -> Arc<Self>
```

**Purpose**: Builds a test auth manager with both a supplied auth value and a specific Codex home path.

**Data flow**: It stores the given auth in cache, uses the provided home path, applies default storage settings, and returns the manager in an `Arc`.

**Call relations**: Tests that need real storage paths use this instead of the simpler testing constructor.

*Call graph*: calls 1 internal fn (default); called by 1 (auth_manager_from_auth_with_home); 4 external calls (new, new, new, channel).


##### `AuthManager::external_bearer_only`  (lines 1641–1660)

```
fn external_bearer_only(config: ModelProviderAuthInfo) -> Arc<Self>
```

**Purpose**: Creates an auth manager for a custom provider whose bearer token is supplied externally, without normal Codex login state.

**Data flow**: It creates an unauthenticated cached manager and installs a `BearerTokenRefresher` as the external auth provider. It returns the manager in an `Arc`.

**Call relations**: Provider-auth setup and tests use this for model providers whose auth comes from an external command.

*Call graph*: calls 2 internal fn (default, new); called by 5 (external_bearer_only_auth_manager_disables_auto_refresh_when_interval_is_zero, external_bearer_only_auth_manager_returns_none_when_command_fails, external_bearer_only_auth_manager_uses_cached_provider_token, unauthorized_recovery_uses_external_refresh_for_bearer_manager, auth_manager_for_provider); 5 external calls (new, from, new, new, channel).


##### `AuthManager::auth_cached`  (lines 1663–1665)

```
fn auth_cached(&self) -> Option<CodexAuth>
```

**Purpose**: Returns the currently cached auth snapshot without trying to reload or refresh it.

**Data flow**: It reads the manager's cache lock, clones the optional auth value, and returns it. If the lock cannot be read, it returns nothing.

**Call relations**: Many manager methods use this when they need a consistent point-in-time auth value.

*Call graph*: called by 9 (auth, auth_mode, get_api_auth_mode, is_external_chatgpt_auth_active, logout_with_revoke, refresh_external_auth, refresh_token, refresh_token_from_authority_impl, reload_if_account_id_matches).


##### `AuthManager::auth_change_receiver`  (lines 1668–1670)

```
fn auth_change_receiver(&self) -> watch::Receiver<u64>
```

**Purpose**: Subscribes to notifications that the auth snapshot changed in a way that can affect request recovery.

**Data flow**: It creates a receiver from the internal watch channel and returns it to the caller.

**Call relations**: Code that must react to login changes can hold this receiver and watch the revision number advance.

*Call graph*: 1 external calls (subscribe).


##### `AuthManager::refresh_failure_for_auth`  (lines 1672–1680)

```
fn refresh_failure_for_auth(&self, auth: &CodexAuth) -> Option<RefreshTokenFailedError>
```

**Purpose**: Returns a cached permanent refresh failure if it applies to the supplied auth snapshot.

**Data flow**: It reads cached state, checks whether the stored failure belongs to the same refresh-relevant auth value, and returns a cloned error if so.

**Call relations**: The refresh implementation uses this to fail fast after a refresh token is known to be expired, reused, or revoked.

*Call graph*: called by 1 (refresh_token_from_authority_impl).


##### `AuthManager::auth`  (lines 1685–1698)

```
async fn auth(&self) -> Option<CodexAuth>
```

**Purpose**: Returns the current usable auth, refreshing managed ChatGPT auth proactively when it is near expiry.

**Data flow**: It first gives external API-key providers a chance to resolve a token. Otherwise it reads cached auth. If the cached managed ChatGPT token should be refreshed, it attempts refresh and logs errors without hiding the existing auth. It returns the latest cached auth.

**Call relations**: Request and rate-limit code call this when they need the active credential.

*Call graph*: calls 3 internal fn (auth_cached, refresh_token, resolve_external_api_key_auth); called by 2 (send_track_events, rate_limits_check); 2 external calls (should_refresh_proactively, error!).


##### `AuthManager::reload`  (lines 1702–1706)

```
async fn reload(&self) -> bool
```

**Purpose**: Reloads auth from storage and updates the manager's cache.

**Data flow**: It loads auth using the configured storage and environment rules, then passes the result to `set_cached_auth`. It returns whether the high-level auth value changed.

**Call relations**: Logout and refresh flows call this so the rest of the program immediately sees updated auth.

*Call graph*: calls 2 internal fn (load_auth_from_storage, set_cached_auth); called by 4 (logout, logout_with_revoke, refresh_and_persist_chatgpt_token, refresh_external_auth); 1 external calls (info!).


##### `AuthManager::reload_if_account_id_matches`  (lines 1708–1741)

```
async fn reload_if_account_id_matches(
        &self,
        expected_account_id: Option<&str>,
    ) -> ReloadOutcome
```

**Purpose**: Reloads auth only if the stored credentials still belong to the expected account. This avoids switching accounts silently during token recovery.

**Data flow**: It requires an expected account id. It loads fresh auth, extracts its account id, compares it to the expected id, and either updates the cache or skips with a mismatch outcome. It reports whether reload changed auth.

**Call relations**: Token refresh and unauthorized recovery use this guard before trusting auth changes from storage.

*Call graph*: calls 3 internal fn (auth_cached, load_auth_from_storage, set_cached_auth); called by 1 (refresh_token); 2 external calls (auths_equal_for_refresh, info!).


##### `AuthManager::auths_equal_for_refresh`  (lines 1743–1764)

```
fn auths_equal_for_refresh(a: Option<&CodexAuth>, b: Option<&CodexAuth>) -> bool
```

**Purpose**: Compares two auth snapshots using the fields that matter for token refresh and failure caching.

**Data flow**: It receives two optional auth references. It treats matching absence as equal, compares API keys by key, ChatGPT auth by raw auth JSON, agent identity by record, personal tokens and Bedrock keys by their concrete equality, and different modes as unequal.

**Call relations**: Reload, change notification, and refresh-failure caching use this stricter comparison.


##### `AuthManager::auths_equal`  (lines 1766–1772)

```
fn auths_equal(a: Option<&CodexAuth>, b: Option<&CodexAuth>) -> bool
```

**Purpose**: Compares two optional auth snapshots using normal auth equality.

**Data flow**: It checks whether both are absent, both present and equal, or different. It returns a boolean.

**Call relations**: `set_cached_auth` uses this to decide whether the visible auth value changed.

*Call graph*: called by 1 (set_cached_auth).


##### `AuthManager::record_permanent_refresh_failure_if_unchanged`  (lines 1776–1791)

```
fn record_permanent_refresh_failure_if_unchanged(
        &self,
        attempted_auth: &CodexAuth,
        error: &RefreshTokenFailedError,
    )
```

**Purpose**: Caches a permanent refresh failure only if the auth that failed is still the current auth.

**Data flow**: It takes the attempted auth and error, locks cached state for writing, checks that the current auth still matches the attempted snapshot for refresh purposes, and stores the failure if it does.

**Call relations**: The refresh implementation calls this after permanent failures so later attempts against the same bad token can fail without another network request.

*Call graph*: called by 1 (refresh_token_from_authority_impl); 3 external calls (auths_equal_for_refresh, clone, clone).


##### `AuthManager::load_auth_from_storage`  (lines 1793–1806)

```
async fn load_auth_from_storage(&self) -> Option<CodexAuth>
```

**Purpose**: Loads auth using this manager's saved configuration.

**Data flow**: It reads the current forced workspace setting, then calls the shared `load_auth` function with the manager's home path, environment setting, storage mode, base URL, and keyring backend. It returns the loaded auth or nothing.

**Call relations**: Reload operations use this instead of repeating the manager's configuration wiring.

*Call graph*: calls 2 internal fn (forced_chatgpt_workspace_id, load_auth); called by 2 (reload, reload_if_account_id_matches).


##### `AuthManager::set_cached_auth`  (lines 1808–1826)

```
fn set_cached_auth(&self, new_auth: Option<CodexAuth>) -> bool
```

**Purpose**: Updates the manager's cached auth and notifies watchers when the refresh-relevant auth state changes.

**Data flow**: It locks cached state, compares old and new auth, clears cached permanent refresh failures if the refresh-relevant auth changed, stores the new auth, and increments the watch-channel revision when needed. It returns whether normal auth equality changed.

**Call relations**: Reload and guarded reload both use this as the single cache update point.

*Call graph*: calls 1 internal fn (auths_equal); called by 2 (reload, reload_if_account_id_matches); 3 external calls (auths_equal_for_refresh, send_modify, info!).


##### `AuthManager::set_external_auth`  (lines 1828–1832)

```
fn set_external_auth(&self, external_auth: Arc<dyn ExternalAuth>)
```

**Purpose**: Installs an external auth provider into the manager.

**Data flow**: It locks the external-auth slot for writing and stores the supplied shared provider.

**Call relations**: Host applications use this to plug in auth that Codex should ask when credentials are externally managed.


##### `AuthManager::clear_external_auth`  (lines 1834–1838)

```
fn clear_external_auth(&self)
```

**Purpose**: Removes any external auth provider from the manager.

**Data flow**: It locks the external-auth slot and sets it to empty.

**Call relations**: Callers use this when external auth is no longer available or should no longer be trusted.


##### `AuthManager::set_forced_chatgpt_workspace_id`  (lines 1840–1846)

```
fn set_forced_chatgpt_workspace_id(&self, workspace_id: Option<Vec<String>>)
```

**Purpose**: Updates the list of allowed ChatGPT workspace ids used by future loads and external refreshes.

**Data flow**: It locks the workspace restriction field. If the new value differs from the old one, it replaces it.

**Call relations**: Configuration updates can call this before reloading auth or refreshing external auth.


##### `AuthManager::forced_chatgpt_workspace_id`  (lines 1848–1853)

```
fn forced_chatgpt_workspace_id(&self) -> Option<Vec<String>>
```

**Purpose**: Returns the current workspace restriction list.

**Data flow**: It reads the workspace restriction lock and clones the optional vector of ids. If the lock cannot be read, it returns nothing.

**Call relations**: Storage loading and external auth refresh use this to enforce workspace restrictions.

*Call graph*: called by 2 (load_auth_from_storage, refresh_external_auth).


##### `AuthManager::has_external_auth`  (lines 1855–1857)

```
fn has_external_auth(&self) -> bool
```

**Purpose**: Answers whether an external auth provider is currently configured.

**Data flow**: It reads the external auth slot and returns true if a provider is present.

**Call relations**: Debug formatting and recovery availability checks use this to describe or validate external-auth behavior.

*Call graph*: calls 1 internal fn (external_auth); called by 1 (fmt).


##### `AuthManager::is_external_chatgpt_auth_active`  (lines 1859–1863)

```
fn is_external_chatgpt_auth_active(&self) -> bool
```

**Purpose**: Answers whether the cached auth currently comes from external ChatGPT tokens.

**Data flow**: It reads cached auth and asks the auth value whether it is the external ChatGPT token variant. It returns false if there is no cached auth.

**Call relations**: Callers can use this to tell whether externally managed ChatGPT auth is active.

*Call graph*: calls 1 internal fn (auth_cached).


##### `AuthManager::codex_api_key_env_enabled`  (lines 1865–1867)

```
fn codex_api_key_env_enabled(&self) -> bool
```

**Purpose**: Reports whether this manager allows `CODEX_API_KEY` to override stored auth.

**Data flow**: It returns the stored boolean configuration value.

**Call relations**: Other code can inspect this to understand the manager's auth precedence behavior.


##### `AuthManager::shared`  (lines 1870–1887)

```
async fn shared(
        codex_home: PathBuf,
        enable_codex_api_key_env: bool,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
        chatgpt_base_url: Option<String>,
        k
```

**Purpose**: Convenience constructor that creates an auth manager and wraps it in `Arc` so it can be shared across tasks.

**Data flow**: It receives the same settings as `new`, awaits manager creation, wraps the result in an atomically reference-counted pointer, and returns it.

**Call relations**: Startup and remote-control setup code use this when many components need the same auth manager.

*Call graph*: called by 13 (list_remote_control_clients_recovers_auth_after_unauthorized, list_remote_control_clients_retries_unauthorized_only_once, remote_control_handle_discards_pairing_response_after_auth_change, remote_control_handle_recovers_auth_before_refreshing_pairing, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_start_allows_missing_auth_when_enabled, remote_control_waits_for_account_id_before_enrolling, connect_remote_control_websocket_recovers_after_unauthorized_enrollment, connect_remote_control_websocket_recovers_after_unauthorized_refresh, connect_remote_control_websocket_requires_chatgpt_auth (+3 more)); 2 external calls (new, new).


##### `AuthManager::shared_from_config`  (lines 1890–1905)

```
async fn shared_from_config(
        config: &impl AuthManagerConfig,
        enable_codex_api_key_env: bool,
    ) -> Arc<Self>
```

**Purpose**: Creates a shared auth manager from a resolved configuration object.

**Data flow**: It asks the config object for the Codex home path, storage mode, keyring backend, workspace restriction, and ChatGPT base URL. It builds the manager with those values and returns it in an `Arc`.

**Call relations**: Main runtime setup code uses this to connect the auth manager to the broader application configuration without making this crate depend on the full config type.

*Call graph*: called by 15 (start_uninitialized, build_test_processor, run_main_with_transport_options, chatgpt_get_request_with_timeout, apps_enabled, connector_auth, build_report, load_exec_server_remote_auth, run_debug_models_command, cached_directory_connectors_for_tool_suggest_with_auth (+5 more)); 7 external calls (new, new_with_workspace_restriction, auth_keyring_backend_kind, chatgpt_base_url, cli_auth_credentials_store_mode, codex_home, forced_chatgpt_workspace_id).


##### `AuthManager::unauthorized_recovery`  (lines 1907–1909)

```
fn unauthorized_recovery(self: &Arc<Self>) -> UnauthorizedRecovery
```

**Purpose**: Starts a new unauthorized-recovery state machine tied to this manager.

**Data flow**: It clones the manager's `Arc` pointer and passes it to `UnauthorizedRecovery::new`. It returns the recovery object.

**Call relations**: Request code calls this after a 401 response to get a safe sequence of retry steps.

*Call graph*: calls 1 internal fn (new); 1 external calls (clone).


##### `AuthManager::external_auth`  (lines 1911–1916)

```
fn external_auth(&self) -> Option<Arc<dyn ExternalAuth>>
```

**Purpose**: Returns the currently configured external auth provider, if any.

**Data flow**: It reads the external-auth lock and clones the shared provider pointer. It returns nothing if no provider is installed or the lock cannot be read.

**Call relations**: External auth mode checks, external refresh, and external API-key resolution all use this accessor.

*Call graph*: called by 4 (external_auth_mode, has_external_auth, refresh_external_auth, resolve_external_api_key_auth).


##### `AuthManager::external_auth_mode`  (lines 1918–1922)

```
fn external_auth_mode(&self) -> Option<AuthMode>
```

**Purpose**: Returns the auth mode supplied by the external auth provider, if one is configured.

**Data flow**: It gets the external auth provider and calls its `auth_mode` method. It returns the provider's mode or nothing.

**Call relations**: `has_external_api_key_auth` uses this to identify external API-key providers.

*Call graph*: calls 1 internal fn (external_auth); called by 1 (has_external_api_key_auth).


##### `AuthManager::has_external_api_key_auth`  (lines 1924–1926)

```
fn has_external_api_key_auth(&self) -> bool
```

**Purpose**: Answers whether the configured external auth provider supplies API-key-style auth.

**Data flow**: It reads the external auth mode and compares it with API key mode. It returns a boolean.

**Call relations**: Auth lookup and mode-reporting methods use this so external API-key auth takes precedence.

*Call graph*: calls 1 internal fn (external_auth_mode); called by 3 (auth_mode, get_api_auth_mode, resolve_external_api_key_auth).


##### `AuthManager::resolve_external_api_key_auth`  (lines 1928–1943)

```
async fn resolve_external_api_key_auth(&self) -> Option<CodexAuth>
```

**Purpose**: Asks an external API-key provider for an immediately available credential.

**Data flow**: It first checks that the external provider is API-key-style. It calls the provider's `resolve` future. If a token is returned, it wraps the token as `CodexAuth::ApiKey`; errors are logged and treated as no auth.

**Call relations**: `AuthManager::auth` calls this before using cached stored auth.

*Call graph*: calls 3 internal fn (external_auth, has_external_api_key_auth, from_api_key); called by 1 (auth); 1 external calls (error!).


##### `AuthManager::refresh_token`  (lines 1950–1984)

```
async fn refresh_token(&self) -> Result<(), RefreshTokenError>
```

**Purpose**: Refreshes managed ChatGPT auth safely, first checking whether another process already updated storage.

**Data flow**: It acquires the refresh semaphore so only one refresh runs at a time. It skips API key and personal access token auth. It remembers the expected account id, reloads only if the account matches, and either skips refresh because auth changed or calls the authority-refresh implementation.

**Call relations**: `AuthManager::auth` calls this for proactive refresh before returning auth.

*Call graph*: calls 4 internal fn (auth_cached, refresh_token_from_authority_impl, reload_if_account_id_matches, new); called by 1 (auth); 3 external calls (acquire, Permanent, info!).


##### `AuthManager::refresh_token_from_authority`  (lines 1990–1998)

```
async fn refresh_token_from_authority(&self) -> Result<(), RefreshTokenError>
```

**Purpose**: Forces a refresh attempt against the token authority for the current auth.

**Data flow**: It acquires the refresh semaphore and then delegates to the internal refresh implementation. It returns success or a structured refresh error.

**Call relations**: Unauthorized recovery uses this after reload has not fixed a 401.

*Call graph*: calls 1 internal fn (refresh_token_from_authority_impl); 1 external calls (acquire).


##### `AuthManager::refresh_token_from_authority_impl`  (lines 2000–2035)

```
async fn refresh_token_from_authority_impl(&self) -> Result<(), RefreshTokenError>
```

**Purpose**: Performs the actual authority-specific refresh work for the currently cached auth.

**Data flow**: It reads cached auth, checks for a cached permanent failure, and then either refreshes external ChatGPT auth, refreshes managed ChatGPT OAuth tokens, or does nothing for non-refreshable auth modes. Permanent failures are recorded if they still apply to the same auth snapshot.

**Call relations**: Both guarded proactive refresh and explicit unauthorized recovery call this after taking the refresh lock.

*Call graph*: calls 5 internal fn (auth_cached, record_permanent_refresh_failure_if_unchanged, refresh_and_persist_chatgpt_token, refresh_external_auth, refresh_failure_for_auth); called by 2 (refresh_token, refresh_token_from_authority); 2 external calls (Permanent, info!).


##### `AuthManager::logout`  (lines 2041–2050)

```
async fn logout(&self) -> std::io::Result<bool>
```

**Purpose**: Logs out locally and updates the in-memory cache so callers immediately see no saved auth.

**Data flow**: It clears all relevant auth stores, then reloads the manager regardless of whether a file was found. It returns whether anything was removed.

**Call relations**: User-facing logout paths on the manager use this when token revocation is not requested.

*Call graph*: calls 2 internal fn (reload, logout_all_stores).


##### `AuthManager::logout_with_revoke`  (lines 2052–2067)

```
async fn logout_with_revoke(&self) -> std::io::Result<bool>
```

**Purpose**: Logs out locally and tries to revoke current ChatGPT tokens first.

**Data flow**: It reads the cached ChatGPT auth JSON if available, asks the revocation helper to revoke those tokens, logs any revocation warning, clears all stores, reloads the cache, and returns whether local credentials were removed.

**Call relations**: User-facing logout paths use this when they want best-effort server-side token revocation.

*Call graph*: calls 4 internal fn (auth_cached, reload, logout_all_stores, revoke_auth_tokens); 1 external calls (warn!).


##### `AuthManager::get_api_auth_mode`  (lines 2069–2074)

```
fn get_api_auth_mode(&self) -> Option<ApiAuthMode>
```

**Purpose**: Returns the precise API auth mode currently active, accounting for external API-key providers.

**Data flow**: It first checks whether external API-key auth is configured. If so, it returns API key mode. Otherwise it reads cached auth and returns its API auth mode.

**Call relations**: `current_auth_uses_codex_backend` uses this, and callers can use it to understand request authentication style.

*Call graph*: calls 2 internal fn (auth_cached, has_external_api_key_auth); called by 1 (current_auth_uses_codex_backend).


##### `AuthManager::auth_mode`  (lines 2076–2081)

```
fn auth_mode(&self) -> Option<AuthMode>
```

**Purpose**: Returns the broad auth mode currently active, accounting for external API-key providers.

**Data flow**: It first gives external API-key auth precedence. Otherwise it reads cached auth and returns its broad mode.

**Call relations**: UI and policy code can use this to describe how the user is logged in.

*Call graph*: calls 2 internal fn (auth_cached, has_external_api_key_auth).


##### `AuthManager::current_auth_uses_codex_backend`  (lines 2083–2086)

```
fn current_auth_uses_codex_backend(&self) -> bool
```

**Purpose**: Answers whether the current auth mode uses the Codex backend.

**Data flow**: It gets the precise API auth mode and asks that mode whether it uses the Codex backend. It returns false when there is no auth.

**Call relations**: Callers use this to decide whether Codex-backend-only behavior is available.

*Call graph*: calls 1 internal fn (get_api_auth_mode).


##### `AuthManager::should_refresh_proactively`  (lines 2088–2110)

```
fn should_refresh_proactively(auth: &CodexAuth) -> bool
```

**Purpose**: Decides whether managed ChatGPT auth should be refreshed before a request fails.

**Data flow**: It only applies to managed ChatGPT auth. If the access token has a readable expiry time, it requests refresh when the token expires within a small window. If no expiry can be read, it falls back to refreshing after a fixed number of days since the last refresh.

**Call relations**: `AuthManager::auth` calls this before returning cached auth.

*Call graph*: calls 1 internal fn (parse_jwt_expiration); 3 external calls (now, days, minutes).


##### `AuthManager::refresh_external_auth`  (lines 2112–2164)

```
async fn refresh_external_auth(
        &self,
        reason: ExternalAuthRefreshReason,
    ) -> Result<(), RefreshTokenError>
```

**Purpose**: Asks an external auth provider for fresh credentials and stores them when they are ChatGPT tokens.

**Data flow**: It gets the external provider, builds a context with the refresh reason and previous account id, calls the provider's refresh method, and handles the result. API-key external auth needs no local save. ChatGPT external auth must include metadata, must satisfy workspace restrictions, is saved to ephemeral storage, and then the manager reloads.

**Call relations**: Unauthorized recovery and refresh implementation call this for externally managed auth.

*Call graph*: calls 6 internal fn (default, auth_cached, external_auth, forced_chatgpt_workspace_id, reload, save_auth); called by 1 (refresh_token_from_authority_impl); 4 external calls (other, format!, Transient, from_external_tokens).


##### `AuthManager::refresh_and_persist_chatgpt_token`  (lines 2168–2185)

```
async fn refresh_and_persist_chatgpt_token(
        &self,
        auth: &ChatgptAuth,
        refresh_token: String,
    ) -> Result<(), RefreshTokenError>
```

**Purpose**: Refreshes managed ChatGPT OAuth tokens, saves the new tokens, and reloads the manager cache.

**Data flow**: It receives the current ChatGPT auth and refresh token. It requests new tokens from the OAuth endpoint, writes returned token fields to the auth storage backend, then reloads cached auth so future callers see the new access token.

**Call relations**: The refresh implementation calls this for normal stored ChatGPT logins.

*Call graph*: calls 5 internal fn (reload, client, storage, persist_tokens, request_chatgpt_token_refresh); called by 1 (refresh_token_from_authority_impl).


### `login/src/auth/access_token.rs`

`domain_logic` · `authentication setup and login`

This file solves a small but important authentication problem: the system may receive two different kinds of access token, and later login code needs to treat them differently. A personal access token is recognized because it starts with the fixed text `at-`. Anything else is treated as an agent identity JWT, where JWT means “JSON Web Token,” a compact signed identity token commonly used to prove who or what is making a request.

The file defines one shared prefix, `at-`, and a small enum called `CodexAccessToken` that acts like a label attached to the original token text. It does not rewrite, validate, or decode the token. It simply says, “this looks like a personal token” or “this should be handled as an agent identity token.”

An everyday analogy is sorting mail by envelope color before sending it to different desks. The mail itself is not opened here; it is only routed based on an obvious outside marker. Without this file, the rest of the login flow would have to guess which authentication path to use, or duplicate this prefix rule in multiple places.

#### Function details

##### `classify_codex_access_token`  (lines 8–14)

```
fn classify_codex_access_token(access_token: &str) -> CodexAccessToken<'_>
```

**Purpose**: This function looks at a Codex access token string and labels it as either a personal access token or an agent identity JWT. Other login code uses that label to choose the right authentication path.

**Data flow**: It receives the token text as input. It checks whether the text begins with `at-`; if it does, it returns the same text wrapped as a `PersonalAccessToken`, and if not, it returns the same text wrapped as an `AgentIdentityJwt`. Nothing is changed or stored; the output is just the original token with a clearer meaning attached.

**Call relations**: When authentication is loaded or a user logs in with an access token, `load_auth` and `login_with_access_token` call this function first to sort the token into the right category. This function then hands back the labeled token so those callers can continue with the correct login behavior.

*Call graph*: called by 2 (load_auth, login_with_access_token); 2 external calls (AgentIdentityJwt, PersonalAccessToken).


### `login/src/auth/personal_access_token.rs`

`domain_logic` · `login/auth load`

A personal access token is like a spare key: by itself it proves something, but the app still needs to know whose key it is and what account it opens. This file does that lookup. Given a token, it contacts the auth API’s “who am I?” endpoint, sends the token as a bearer token, and expects back metadata such as the user’s email, ChatGPT user ID, account ID, plan type, and whether the account is FedRAMP-related. FedRAMP is a U.S. government security compliance program, so that flag can affect which services are allowed.

The main public type is `PersonalAccessTokenAuth`. It stores the raw token plus the metadata returned by the server. The token is deliberately hidden in debug output so logs do not accidentally leak a secret. The `load` method chooses which auth API base URL to use: normally production, but an environment variable can override it for testing or special deployments. Then it delegates the actual network request to `hydrate_personal_access_token`.

Once loaded, the rest of the system can ask this object for the account ID, user ID, email, plan type, token, or FedRAMP status without repeating the HTTP lookup.

#### Function details

##### `PersonalAccessTokenAuth::fmt`  (lines 30–35)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This defines how a `PersonalAccessTokenAuth` value appears in debug logs. It shows the account metadata but replaces the actual access token with `"<redacted>"` so a secret is not printed.

**Data flow**: It receives the auth object and a formatter used for building debug text. It writes a structured debug view where the token field is hidden and the metadata field is shown. The output is formatted text for logs or debugging, with no change to the auth object itself.

**Call relations**: This is used automatically when Rust debug formatting is requested for `PersonalAccessTokenAuth`. Inside, it uses the formatter’s `debug_struct` helper to build the safe debug display.

*Call graph*: 1 external calls (debug_struct).


##### `PersonalAccessTokenAuth::load`  (lines 39–46)

```
async fn load(access_token: &str) -> std::io::Result<Self>
```

**Purpose**: This is the main entry point for creating a complete personal-access-token login record from a raw token. It chooses the auth API server, creates an HTTP client, and asks the server for the token’s account metadata.

**Data flow**: It takes an access token string. It reads the `CODEX_AUTHAPI_BASE_URL` environment variable; if that variable is missing or empty, it falls back to the production auth API URL. It trims extra slashes from the URL, creates a client, then returns either a filled `PersonalAccessTokenAuth` object or an I/O error explaining what failed.

**Call relations**: Higher-level login paths call this when they need to authenticate with a personal access token: `from_personal_access_token`, `load_auth`, and `login_with_access_token`. After setup, it hands the actual server lookup to `hydrate_personal_access_token`.

*Call graph*: calls 2 internal fn (create_client, hydrate_personal_access_token); called by 3 (from_personal_access_token, load_auth, login_with_access_token); 1 external calls (var).


##### `PersonalAccessTokenAuth::access_token`  (lines 48–50)

```
fn access_token(&self) -> &str
```

**Purpose**: This returns the stored raw access token. Code uses it when it needs to make later authenticated requests on behalf of the same login.

**Data flow**: It receives an already-loaded `PersonalAccessTokenAuth` object and returns a borrowed view of its token string. It does not copy the token and does not change anything.

**Call relations**: This is a simple reader used after `PersonalAccessTokenAuth::load` has built the auth object. No specific caller is shown in the provided call graph, but it exists so other code does not need direct access to the private token field.


##### `PersonalAccessTokenAuth::account_id`  (lines 52–54)

```
fn account_id(&self) -> &str
```

**Purpose**: This returns the ChatGPT account ID associated with the token. That account ID is important for checking whether the token is allowed to use a particular workspace or account-scoped resource.

**Data flow**: It receives the loaded auth object, reads the `chatgpt_account_id` value from its metadata, and returns it as a borrowed string. The object is left unchanged.

**Call relations**: `ensure_personal_access_token_workspace_allowed` calls this when it needs to compare the token’s account with an allowed workspace or account. The value ultimately comes from the auth API metadata fetched during loading.

*Call graph*: called by 1 (ensure_personal_access_token_workspace_allowed).


##### `PersonalAccessTokenAuth::chatgpt_user_id`  (lines 56–58)

```
fn chatgpt_user_id(&self) -> &str
```

**Purpose**: This returns the ChatGPT user ID tied to the personal access token. It gives other parts of the system a stable user identifier, separate from the user’s email address.

**Data flow**: It receives the loaded auth object, reads the `chatgpt_user_id` field from the stored metadata, and returns that string by reference. Nothing is modified.

**Call relations**: This is an accessor for metadata that was fetched by `hydrate_personal_access_token`. No specific caller is shown in the provided call graph, but it is available to any login or account code that needs the user ID.


##### `PersonalAccessTokenAuth::email`  (lines 60–62)

```
fn email(&self) -> &str
```

**Purpose**: This returns the email address reported by the auth API for the token. It is useful for showing the logged-in identity to a person or for account-related checks.

**Data flow**: It receives the loaded auth object, reads the `email` field from the metadata, and returns it as a borrowed string. It performs no network request and makes no changes.

**Call relations**: This is a read-only view of the metadata collected during token hydration. No specific caller is shown in the provided call graph, but it is meant for code that needs to display or inspect the authenticated identity.


##### `PersonalAccessTokenAuth::plan_type`  (lines 64–66)

```
fn plan_type(&self) -> AccountPlanType
```

**Purpose**: This converts the raw plan type string from the auth API into the project’s account plan type value. That lets the rest of the code work with a known category instead of a loose text string.

**Data flow**: It receives the loaded auth object, reads the `chatgpt_plan_type` string from its metadata, converts that raw string into an internal plan type, then converts it into the account-facing plan type returned by the function. The stored metadata is not changed.

**Call relations**: This accessor sits between the external auth API format and the rest of the application. It calls `from_raw_value` to interpret the server’s string before handing back a cleaner plan type value.

*Call graph*: 1 external calls (from_raw_value).


##### `PersonalAccessTokenAuth::is_fedramp_account`  (lines 68–70)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: This tells callers whether the token belongs to a FedRAMP account. That can matter because government-compliance accounts may have different rules or routing requirements.

**Data flow**: It receives the loaded auth object, reads the boolean `chatgpt_account_is_fedramp` flag from the metadata, and returns `true` or `false`. It does not change anything.

**Call relations**: This is a direct reader for information fetched during `hydrate_personal_access_token`. No specific caller is shown in the provided call graph, but it is available wherever account policy decisions need that FedRAMP flag.


##### `hydrate_personal_access_token`  (lines 73–108)

```
async fn hydrate_personal_access_token(
    client: &CodexHttpClient,
    authapi_base_url: &str,
    access_token: &str,
) -> std::io::Result<PersonalAccessTokenAuth>
```

**Purpose**: This performs the actual server check for a personal access token. It asks the auth API who the token belongs to and builds a `PersonalAccessTokenAuth` object from the answer.

**Data flow**: It receives an HTTP client, a base URL for the auth API, and the raw access token. It builds the `whoami` endpoint URL, sends a GET request with the token in the bearer-auth header, checks that the HTTP status means success, then decodes the JSON response into token metadata. On success it returns a new auth object containing both the original token and the metadata; on failure it returns an I/O error with a human-readable reason.

**Call relations**: `PersonalAccessTokenAuth::load` calls this after choosing the API URL and creating the client. This function is the point where local login state is connected to the remote auth service, using the client’s `get` request builder and wrapping request or decoding failures as standard I/O errors.

*Call graph*: calls 1 internal fn (get); called by 1 (load); 2 external calls (other, format!).


### `login/src/token_data.rs`

`data_model` · `auth load, token refresh checks, auth save`

This file is the translator between the raw login data stored in auth.json and the rest of the program. The important input is a JWT, which is a compact token string made of three dot-separated parts. Think of it like a sealed boarding pass: the program does not create the flight details, but it can read the printed passenger and account information from the middle section.

The main saved object is TokenData. It stores the access token, refresh token, optional account ID, and an id_token. The id_token is saved on disk as the original JWT string, but inside the program it becomes an IdTokenInfo struct with easier-to-use fields. That conversion is done automatically during JSON loading and saving.

The file also knows how to read two kinds of JWT information. One path reads the standard exp claim, which says when the token expires. Another path reads ChatGPT-specific claims, such as the subscription plan, user ID, workspace account ID, and whether the workspace must use the FedRAMP edge. FedRAMP here means a stricter government-compliance environment.

If this file were missing, the rest of the login system would have to repeatedly decode token strings by hand, and it would be much easier to lose important account details or save the token back incorrectly.

#### Function details

##### `IdTokenInfo::get_chatgpt_plan_type`  (lines 45–50)

```
fn get_chatgpt_plan_type(&self) -> Option<String>
```

**Purpose**: This returns the user's ChatGPT plan as a friendly display string, such as a readable plan name. It is useful when the program wants to show or log the plan in a human-facing way.

**Data flow**: It reads the plan value already stored in IdTokenInfo. If there is no plan, it returns nothing. If the plan is a known plan, it converts it to its display name; if it is an unknown backend value, it keeps that original text.

**Call relations**: This is a convenience method on the parsed token information. Other parts of the program can call it after parse_chatgpt_jwt_claims or JSON loading has filled in IdTokenInfo, so they do not need to understand the internal PlanType shape.


##### `IdTokenInfo::get_chatgpt_plan_type_raw`  (lines 52–57)

```
fn get_chatgpt_plan_type_raw(&self) -> Option<String>
```

**Purpose**: This returns the plan value in its raw backend form. It is useful when code needs the exact plan label rather than a nicer display name.

**Data flow**: It reads the optional plan from IdTokenInfo. If the plan is absent, it returns nothing. If the plan is known, it returns the plan's raw stored value; if it is unknown, it returns the unknown string unchanged.

**Call relations**: This sits alongside the friendlier get_chatgpt_plan_type method. Callers use it when exact token-derived values matter, while the parsed IdTokenInfo still remains the single place where plan data is stored.


##### `IdTokenInfo::is_workspace_account`  (lines 59–64)

```
fn is_workspace_account(&self) -> bool
```

**Purpose**: This answers whether the token belongs to a workspace-style ChatGPT account, such as a business or enterprise account. That matters because workspace accounts can need different routing or account behavior than personal plans.

**Data flow**: It looks at the parsed plan type inside IdTokenInfo. If the plan is known and that plan is marked as a workspace account, it returns true; otherwise it returns false.

**Call relations**: This is a small decision helper used after token parsing. It relies on the PlanType rules supplied by the shared protocol code, so callers do not have to duplicate the list of which plans count as workspace accounts.

*Call graph*: 1 external calls (matches!).


##### `IdTokenInfo::is_fedramp_account`  (lines 66–68)

```
fn is_fedramp_account(&self) -> bool
```

**Purpose**: This answers whether the selected ChatGPT workspace must use the FedRAMP edge, a stricter compliance route. It gives the rest of the system a simple yes-or-no flag.

**Data flow**: It reads the chatgpt_account_is_fedramp boolean already parsed from the token and returns that same value. It does not change anything.

**Call relations**: This is a convenience wrapper around a stored field. Code that needs to choose special behavior for FedRAMP accounts can ask IdTokenInfo directly instead of reaching into the field.


##### `decode_jwt_payload`  (lines 117–128)

```
fn decode_jwt_payload(jwt: &str) -> Result<T, IdTokenInfoError>
```

**Purpose**: This is the shared low-level reader for JWT payloads. It checks that the token has the expected three-part shape, decodes the middle section, and turns the JSON inside into whatever claim type the caller asked for.

**Data flow**: It takes a JWT string. It splits it on dots, rejects it if the header, payload, or signature section is missing or empty, base64-decodes the payload section, then parses the resulting JSON into a caller-chosen Rust data shape. It returns either the parsed claims or a clear token parsing error.

**Call relations**: parse_jwt_expiration and parse_chatgpt_jwt_claims both call this helper so the risky decoding work is kept in one place. After decoding, it hands the parsed JSON claims back to those higher-level functions, which decide what the claims mean.

*Call graph*: called by 2 (parse_chatgpt_jwt_claims, parse_jwt_expiration); 1 external calls (from_slice).


##### `parse_jwt_expiration`  (lines 130–135)

```
fn parse_jwt_expiration(jwt: &str) -> Result<Option<DateTime<Utc>>, IdTokenInfoError>
```

**Purpose**: This reads the expiration time from a JWT, if the token contains one. It is used when the login system wants to know whether a token should be refreshed before it stops working.

**Data flow**: It takes a JWT string and asks decode_jwt_payload to read the standard exp claim. If exp is present and can be represented as a UTC timestamp, it returns that date and time. If exp is missing or invalid as a timestamp, it returns no expiration value; if the token cannot be decoded, it returns an error.

**Call relations**: This is called by should_refresh_proactively when the system is deciding whether to refresh credentials early. It depends on decode_jwt_payload for the common JWT reading step, then narrows the result down to just the expiration time.

*Call graph*: calls 1 internal fn (decode_jwt_payload); called by 1 (should_refresh_proactively).


##### `parse_chatgpt_jwt_claims`  (lines 137–161)

```
fn parse_chatgpt_jwt_claims(jwt: &str) -> Result<IdTokenInfo, IdTokenInfoError>
```

**Purpose**: This turns a raw ChatGPT ID token into the easier-to-use IdTokenInfo structure. It extracts the account and profile details that the rest of the login system needs.

**Data flow**: It takes a JWT string and decodes its payload into ChatGPT-related claims. It chooses an email from the top-level email field or, if that is absent, from the profile section. If an auth section is present, it copies out the plan type, user ID, account ID, FedRAMP flag, and the original token string. If the auth section is missing, it still returns IdTokenInfo with the email and raw token, but leaves the ChatGPT-specific account fields empty or false.

**Call relations**: Many login paths call this when tokens enter or leave the system, including auth file loading, writing ChatGPT auth data, accepting external tokens, persisting tokens, test token helpers, and deserialize_id_token. It uses decode_jwt_payload for the mechanical JWT reading, then packages the meaningful ChatGPT fields for everyone else.

*Call graph*: calls 1 internal fn (decode_jwt_payload); called by 9 (remote_control_auth_dot_json, remote_control_auth_dot_json, write_chatgpt_auth, from_external_tokens, persist_tokens, id_token_with_prefix, deserialize_id_token, chatgpt_auth_tokens_for_tests, write_chatgpt_auth).


##### `deserialize_id_token`  (lines 163–169)

```
fn deserialize_id_token(deserializer: D) -> Result<IdTokenInfo, D::Error>
```

**Purpose**: This teaches JSON loading how to read the id_token field. On disk the field is just a raw JWT string, but in memory the program wants the parsed IdTokenInfo form.

**Data flow**: It receives a JSON deserializer, reads the id_token value as a string, then sends that string to parse_chatgpt_jwt_claims. If parsing succeeds, it returns IdTokenInfo; if parsing fails, it reports the problem as a JSON deserialization error.

**Call relations**: This function is wired into the TokenData struct through serde, the Rust library used for JSON conversion. It runs automatically when TokenData is loaded from auth.json, and it hands the raw token string to parse_chatgpt_jwt_claims so the rest of the program receives already-parsed token details.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); 1 external calls (deserialize).


##### `serialize_id_token`  (lines 171–176)

```
fn serialize_id_token(id_token: &IdTokenInfo, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: This teaches JSON saving how to write the id_token field back out. Even though the program stores parsed token details in memory, the file should keep the original JWT string.

**Data flow**: It receives an IdTokenInfo and a JSON serializer. It takes the raw_jwt string from IdTokenInfo and writes that string as the serialized value. It does not write the expanded email, plan, or account fields separately.

**Call relations**: This function is wired into TokenData through serde and runs automatically when auth data is saved. It is the mirror image of deserialize_id_token: loading expands the JWT into useful fields, while saving collapses it back to the original token string.

*Call graph*: 1 external calls (serialize_str).


### Installation identity
This file establishes the stable per-installation identifier used to recognize the local Codex instance across runs.

### `core/src/installation_id.rs`

`domain_logic` · `startup`

This file solves a simple but important problem: the program sometimes needs to know “this is the same local installation as before” without asking the user. It does that by keeping a small file named installation_id inside the Codex home directory. The value in that file is a UUID, which is a long random identifier designed to be unique.

The main function, resolve_installation_id, first makes sure the home directory exists. Then it opens or creates the installation_id file. Because file work can block the async runtime, it runs the slow disk operations on a blocking worker thread. Think of this like sending a clerk to the filing cabinet so the main desk can keep helping people.

Once the file is open, the function locks it so two parts of the program do not create or rewrite the ID at the same time. On Unix systems it also makes sure the file permissions are 0644, meaning the owner can edit it and others can read it. If the file already contains a valid UUID, that value is reused and normalized to the standard lowercase format. If the file is empty or invalid, the function creates a new UUID, overwrites the file with it, flushes it, and syncs it to disk so it is safely persisted.

The tests check the three important promises: a new ID is created and saved, an existing valid ID is reused, and bad file contents are replaced.

#### Function details

##### `resolve_installation_id`  (lines 19–64)

```
async fn resolve_installation_id(codex_home: &AbsolutePathBuf) -> Result<String>
```

**Purpose**: Finds or creates the stable ID for this Codex installation. Callers use it when they need a persistent identifier that survives across runs.

**Data flow**: It receives the Codex home directory path. It joins that path with the installation_id filename, creates the directory if needed, then opens or creates the file. It reads the file: if it contains a valid UUID, it returns that UUID in standard form. If the file is missing, empty, or invalid, it creates a new UUID, writes it into the file, forces the write to disk, and returns the new value.

**Call relations**: This function is the central behavior in the file. It uses path joining to choose where the ID lives, async directory creation to prepare the folder, and a blocking task for the actual file locking, reading, and writing. The three test functions call it in different starting conditions to prove it creates, reuses, or repairs the stored ID correctly.

*Call graph*: calls 1 internal fn (join); called by 3 (resolve_installation_id_generates_and_persists_uuid, resolve_installation_id_reuses_existing_uuid, resolve_installation_id_rewrites_invalid_file_contents); 2 external calls (create_dir_all, spawn_blocking).


##### `tests::resolve_installation_id_generates_and_persists_uuid`  (lines 79–103)

```
async fn resolve_installation_id_generates_and_persists_uuid()
```

**Purpose**: Checks the first-run case, where no installation ID file exists yet. It proves the function creates a valid UUID and saves exactly that value to disk.

**Data flow**: It starts with a temporary empty Codex home directory. It calls resolve_installation_id, then reads the installation_id file that should now exist. It checks that the returned string matches the saved file contents and that the string is a valid UUID. On Unix, it also checks that the file permission is 0644.

**Call relations**: This test calls resolve_installation_id as a real caller would during startup on a fresh installation. It then uses assertions and filesystem metadata to confirm the function fulfilled its persistence and permission promises.

*Call graph*: calls 1 internal fn (resolve_installation_id); 4 external calls (new, assert!, assert_eq!, metadata).


##### `tests::resolve_installation_id_reuses_existing_uuid`  (lines 106–126)

```
async fn resolve_installation_id_reuses_existing_uuid()
```

**Purpose**: Checks the repeat-run case, where an installation ID already exists. It proves the function does not replace a valid existing ID.

**Data flow**: It creates a temporary Codex home directory, writes an existing UUID into the installation_id file, and then calls resolve_installation_id. The function reads that file and returns the same UUID, normalized into the usual lowercase UUID text form. The test compares the result with the parsed original UUID.

**Call relations**: This test sets up the file the way a previous run would have left it. By calling resolve_installation_id afterward, it verifies that the main function preserves continuity instead of generating a new identity every time.

*Call graph*: calls 1 internal fn (resolve_installation_id); 4 external calls (new, new_v4, assert_eq!, write).


##### `tests::resolve_installation_id_rewrites_invalid_file_contents`  (lines 129–148)

```
async fn resolve_installation_id_rewrites_invalid_file_contents()
```

**Purpose**: Checks the repair case, where the installation ID file exists but contains unusable text. It proves the function replaces bad contents with a new valid UUID.

**Data flow**: It creates a temporary Codex home directory and writes the text not-a-uuid into the installation_id file. It calls resolve_installation_id, which sees the invalid value, generates a new UUID, and rewrites the file. The test checks that the returned value is a valid UUID and that the file now contains exactly that value.

**Call relations**: This test calls resolve_installation_id after deliberately corrupting the saved ID. It confirms the function is resilient: bad local state does not make startup fail as long as a new valid ID can be written.

*Call graph*: calls 1 internal fn (resolve_installation_id); 4 external calls (new, assert!, assert_eq!, write).


### Windows sandbox accounts
This file manages the Windows-specific local users, groups, credentials, and markers needed for sandbox account readiness.

### `windows-sandbox-rs/src/bin/setup_main/win/sandbox_users.rs`

`domain_logic` · `setup`

A sandbox needs accounts with carefully limited rights, rather than running everything as the real user. This file is the setup helper for those accounts on Windows. It creates a local Windows group named CodexSandboxUsers, creates two local users for different sandbox modes, puts those users into the group, and saves their passwords in a protected secrets file. Think of it like making two guest badges, putting them in the right security group, and locking the badge PINs in a safe.

The file talks directly to Windows account and security APIs. It converts friendly names, like "Users" or "SYSTEM", into SIDs, which are Windows security identifiers: the stable ID numbers Windows uses internally for users and groups. It also builds security settings for the setup marker file so that sandbox users cannot fake or replace it while setup is still running.

The main flow is: make sure the sandbox group exists, generate random passwords, create or update the two sandbox users, add them to the group, encrypt the passwords with Windows DPAPI, and write them to JSON. Separately, setup first creates an empty protected marker file, then only after all setup steps succeed writes valid marker contents. That prevents a half-finished setup from looking ready.

#### Function details

##### `ensure_sandbox_users_group`  (lines 62–64)

```
fn ensure_sandbox_users_group(log: &mut dyn Write) -> Result<()>
```

**Purpose**: Makes sure the dedicated local Windows group for sandbox accounts exists. The group is used as a single label for accounts that belong to the sandbox.

**Data flow**: It receives a log writer. It passes the fixed group name and comment to the lower-level group creation helper, then returns success or the error from that helper.

**Call relations**: During user provisioning, provision_sandbox_users calls this first so the group is available before any sandbox account is added to it. It delegates the actual Windows group creation work to ensure_local_group.

*Call graph*: calls 1 internal fn (ensure_local_group); called by 1 (provision_sandbox_users).


##### `resolve_sandbox_users_group_sid`  (lines 66–68)

```
fn resolve_sandbox_users_group_sid() -> Result<Vec<u8>>
```

**Purpose**: Finds the Windows security identifier, or SID, for the sandbox users group. Other setup steps need this ID when setting access rules, because Windows permissions are based on SIDs rather than display names.

**Data flow**: It takes no input. It looks up the fixed CodexSandboxUsers group name and returns the SID as raw bytes, or an error if Windows cannot resolve it.

**Call relations**: Provision-only, read-ACL-only, and full setup flows call this when they need to apply or inspect permissions for the sandbox group. It hands the lookup work to resolve_sid.

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

**Purpose**: Creates or refreshes the two sandbox Windows accounts and stores their new protected passwords. This is the main account-provisioning routine for the sandbox setup.

**Data flow**: It receives the Codex home folder, the two desired usernames, and a log writer. It ensures the sandbox group exists, generates a password for each user, creates or updates each account, adds each account to the sandbox group, then writes the encrypted password records under the Codex home directory. It returns success only after all those steps complete.

**Call relations**: provision_and_hide_sandbox_users calls this as part of preparing the sandbox accounts. Inside, it calls ensure_sandbox_users_group, random_password, ensure_sandbox_user for each account, and write_secrets after the accounts are ready.

*Call graph*: calls 4 internal fn (ensure_sandbox_user, ensure_sandbox_users_group, random_password, write_secrets); called by 1 (provision_and_hide_sandbox_users); 2 external calls (format!, log_line).


##### `ensure_sandbox_user`  (lines 95–99)

```
fn ensure_sandbox_user(username: &str, password: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Makes one named Windows account usable as a sandbox user. It both creates or updates the account and adds it to the sandbox users group.

**Data flow**: It receives a username, password, and log writer. It first ensures the Windows local user exists with that password, then asks Windows to add that user to the CodexSandboxUsers group. It returns success if both requested operations complete without a fatal error.

**Call relations**: provision_sandbox_users calls this once for the offline account and once for the online account. It is a small bridge between ensure_local_user and ensure_local_group_member.

*Call graph*: calls 2 internal fn (ensure_local_group_member, ensure_local_user); called by 1 (provision_sandbox_users).


##### `ensure_local_user`  (lines 101–163)

```
fn ensure_local_user(name: &str, password: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Creates a regular local Windows user account, or updates its password if the account already exists. It also tries to make sure the account belongs to the normal Windows Users group.

**Data flow**: It receives an account name, a password, and a log writer. It converts the text into Windows wide strings, calls Windows to add the user, and if that fails because the user may already exist, calls Windows again to set the password. Then it resolves the localized name of the built-in Users group and tries to add the account there. It returns success unless creating or updating the account itself fails.

**Call relations**: ensure_sandbox_user calls this before adding the account to the sandbox-specific group. It relies on lookup_account_name_for_sid to find the local name of the built-in Users group, because that group can be named differently on non-English Windows systems.

*Call graph*: calls 2 internal fn (lookup_account_name_for_sid, new); called by 1 (ensure_sandbox_user); 10 external calls (new, new, to_wide, format!, null, null_mut, log_line, NetLocalGroupAddMembers, NetUserAdd, NetUserSetInfo).


##### `ensure_local_group`  (lines 165–195)

```
fn ensure_local_group(name: &str, comment: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Creates a local Windows group if it does not already exist. Existing-group results are treated as okay, because setup should be safe to run more than once.

**Data flow**: It receives a group name, a comment, and a log writer. It converts the strings into Windows format and calls the Windows group creation API. If Windows says the group already exists, it still returns success; for other failures it writes a log message and returns a setup-specific error.

**Call relations**: ensure_sandbox_users_group calls this to create the CodexSandboxUsers group. This keeps the public sandbox-group function simple while this function deals with the Windows API result codes.

*Call graph*: calls 1 internal fn (new); called by 1 (ensure_sandbox_users_group); 7 external calls (new, new, to_wide, format!, null, log_line, NetLocalGroupAdd).


##### `ensure_local_group_member`  (lines 197–215)

```
fn ensure_local_group_member(group_name: &str, member_name: &str) -> Result<()>
```

**Purpose**: Adds a user or other account name to a local Windows group. If Windows reports that the member is already present, this function deliberately ignores that kind of problem so repeated setup runs do not fail.

**Data flow**: It receives the group name and member name. It converts both names into Windows format and asks Windows to add the member to the group. It does not return the Windows add-member error; it always returns success after making the attempt.

**Call relations**: ensure_sandbox_user uses this after the account exists, so the account gains membership in CodexSandboxUsers. ensure_local_user also performs a similar Windows call directly for the built-in Users group.

*Call graph*: called by 1 (ensure_sandbox_user); 4 external calls (new, to_wide, null, NetLocalGroupAddMembers).


##### `resolve_sid`  (lines 217–253)

```
fn resolve_sid(name: &str) -> Result<Vec<u8>>
```

**Purpose**: Turns a Windows account or group name into its SID, the internal security ID Windows uses in permissions. It also recognizes a few built-in names directly, such as Administrators and SYSTEM.

**Data flow**: It receives a name. If the name is one of the known built-in accounts or groups, it converts the built-in SID string into bytes. Otherwise, it asks Windows to look up the account name, growing its buffers if Windows says more space is needed. It returns the SID bytes or an error explaining the failed lookup.

**Call relations**: This is the shared SID lookup tool for setup. It is called by setup flows that set permissions, by resolve_sandbox_users_group_sid for the sandbox group, and by prepare_setup_marker when building the protected marker file permissions. It calls well_known_sid_str and sid_bytes_from_string for built-in names.

*Call graph*: calls 2 internal fn (sid_bytes_from_string, well_known_sid_str); called by 6 (lock_sandbox_dir, run_provision_only, run_read_acl_only, run_setup_full, prepare_setup_marker, resolve_sandbox_users_group_sid); 8 external calls (new, new, anyhow!, to_wide, null, vec!, GetLastError, LookupAccountNameW).


##### `well_known_sid_str`  (lines 255–264)

```
fn well_known_sid_str(name: &str) -> Option<&'static str>
```

**Purpose**: Maps a small set of common Windows security names to their fixed SID strings. This avoids depending on localized display names for built-in groups and accounts.

**Data flow**: It receives a friendly name such as "Administrators" or "SYSTEM". If the name is one of the known entries, it returns the matching SID string; otherwise it returns nothing.

**Call relations**: resolve_sid calls this before asking Windows to look up a name. It acts like a shortcut table for built-in identities whose SID values are the same across Windows installations.

*Call graph*: called by 1 (resolve_sid).


##### `sid_bytes_from_string`  (lines 266–291)

```
fn sid_bytes_from_string(sid_str: &str) -> Result<Vec<u8>>
```

**Purpose**: Converts a SID written as text, such as "S-1-5-18", into the raw byte form that Windows security APIs use. This is needed when code starts from a known SID string.

**Data flow**: It receives a SID string. It asks Windows to parse that string into a SID pointer, checks the SID length, copies the bytes into a Rust vector, frees the Windows-allocated memory, and returns the byte vector. If any Windows call fails, it returns an error.

**Call relations**: resolve_sid uses this when well_known_sid_str finds a built-in SID. This function is the safe wrapper around the Windows conversion and memory-freeing steps.

*Call graph*: called by 1 (resolve_sid); 9 external calls (new, anyhow!, to_wide, null_mut, vec!, LocalFree, ConvertStringSidToSidW, CopySid, GetLengthSid).


##### `lookup_account_name_for_sid`  (lines 293–351)

```
fn lookup_account_name_for_sid(sid_str: &str) -> Result<String>
```

**Purpose**: Finds the local account or group name that Windows uses for a given SID string. This matters because built-in group names can be translated on different Windows languages.

**Data flow**: It receives a SID string. It converts the string into a Windows SID, first calls Windows to learn how large the name and domain buffers must be, then calls again to fill those buffers. It returns the account name as a normal Rust string and frees the Windows SID memory.

**Call relations**: ensure_local_user calls this to find the actual local name of the built-in Users group before adding the new account to it. That lets setup work even when the visible group name is not literally "Users".

*Call graph*: called by 1 (ensure_local_user); 11 external calls (new, from_utf16_lossy, anyhow!, to_wide, null, null_mut, vec!, GetLastError, LocalFree, ConvertStringSidToSidW (+1 more)).


##### `sid_bytes_to_psid`  (lines 353–364)

```
fn sid_bytes_to_psid(sid: &[u8]) -> Result<*mut c_void>
```

**Purpose**: Converts stored SID bytes back into a Windows SID pointer. Some Windows APIs require this pointer form rather than a Rust byte vector.

**Data flow**: It receives SID bytes. It first turns them into a SID text string, then asks Windows to convert that text into a SID pointer. It returns the pointer for the caller to use, or an error if conversion fails.

**Call relations**: The read-ACL-only and full setup flows call this when they need to pass a SID into Windows permission APIs. It relies on the shared string_from_sid_bytes helper from the sandbox library.

*Call graph*: called by 2 (run_read_acl_only, run_setup_full); 6 external calls (new, anyhow!, string_from_sid_bytes, to_wide, null_mut, ConvertStringSidToSidW).


##### `random_password`  (lines 366–378)

```
fn random_password() -> String
```

**Purpose**: Generates a fresh random password for a sandbox user account. The password uses letters, numbers, and common symbols.

**Data flow**: It takes no input. It fills 24 random bytes using a small random-number generator seeded from the operating system, maps each byte into an allowed password character, and returns the resulting string.

**Call relations**: provision_sandbox_users calls this once for the offline account and once for the online account before creating or updating those users.

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

**Purpose**: Writes the sandbox usernames and encrypted passwords to a JSON file under the sandbox secrets directory. The passwords are protected with Windows DPAPI, which encrypts data using Windows user or machine protection.

**Data flow**: It receives the Codex home path, both usernames, and both plain passwords. It creates the secrets directory, encrypts each password, base64-encodes the encrypted bytes so they fit cleanly in JSON text, serializes the records, and writes sandbox_users.json. It returns a setup-specific error if directory creation, encryption, serialization, or writing fails.

**Call relations**: provision_sandbox_users calls this only after both accounts have been created or updated. It uses helper functions from the sandbox library to find the secrets directory and protect the password bytes.

*Call graph*: called by 1 (provision_sandbox_users); 5 external calls (dpapi_protect, sandbox_secrets_dir, to_vec_pretty, create_dir_all, write).


##### `prepare_setup_marker`  (lines 468–549)

```
fn prepare_setup_marker(codex_home: &Path, real_user: &str) -> Result<()>
```

**Purpose**: Creates an empty setup marker file with strict permissions before setup begins. The empty file intentionally does not count as a valid completed setup marker, but it prevents sandbox users from creating or replacing the marker themselves.

**Data flow**: It receives the Codex home path and the real user name. It removes any old marker file, resolves the real user's SID, builds a Windows security rule that gives full access only to SYSTEM, Administrators, and the real user, and creates a new empty marker file with those permissions. It returns an error if removal, SID lookup, security descriptor creation, or file creation fails.

**Call relations**: run_setup calls this near the start of setup. Later, if every setup step succeeds, commit_setup_marker writes valid JSON into the same protected file without changing its access rules.

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

**Purpose**: Writes the final setup marker JSON after setup has succeeded. This marker records enough information for later code to know the sandbox setup is complete and which accounts and proxy settings were used.

**Data flow**: It receives the Codex home path, the offline and online usernames, proxy ports, and whether local binding is allowed. It builds a marker object with the setup version, current UTC timestamp, account names, network settings, and empty read/write root lists, serializes it as pretty JSON, and writes it to setup_marker.json. It returns an error if serialization or writing fails.

**Call relations**: run_setup calls this at the end of a successful setup. It completes the two-step marker process that prepare_setup_marker started, turning the protected empty placeholder into a valid readiness signal.

*Call graph*: called by 1 (run_setup); 5 external calls (new, now, sandbox_dir, to_vec_pretty, write).

## 📊 State Registers Touched

- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-windows-sandbox-readiness` — Prepared Windows sandbox accounts, helper readiness, setup status, and client-visible sandbox availability separate from the policy rules themselves.
- `reg-attestation-state` — Client or host attestation provider state and generated proof metadata used to attach optional attestation headers to upstream requests.
