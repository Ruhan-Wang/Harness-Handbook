# App-server integration suites — auth, config, discovery, and core RPC surfaces  `stage-23.1.4.1`

This stage is a cross-cutting integration-test layer for the app server’s core JSON-RPC surface: it sits around startup and steady-state request handling, validating the contracts clients depend on before plugin-specific or thread/turn-focused behavior comes into play. The auth suites anchor access control and identity: auth.rs covers legacy authentication startup and credential recovery paths, while v2/account.rs extends that to modern login, logout, account inspection, and refresh behavior during execution. The rate-limit suites verify account quota reads, add-credits nudges, and reset-credit consumption, including auth, validation, backend mapping, and timeout/error propagation.

Configuration and initialization are exercised by strict_config.rs, which checks process startup rejection for invalid config files, v2/initialize.rs for client identity and capability-sensitive notifications, and v2/config_rpc.rs plus experimental_feature_list.rs for layered config reads/writes, feature enablement, and persistence. Discovery-oriented tests cover provider capabilities, collaboration modes, model catalogs, and permission profiles, ensuring listing, filtering, ordering, and pagination match the public API. Finally, fs.rs, process_exec.rs, windows_sandbox_setup.rs, and remote_control.rs validate operational RPCs for filesystem access, local process management, Windows sandbox setup, and remote-control enrollment/pairing flows.

## Files in this stage

### Authentication and account flows
These suites cover end-to-end authentication entry points, account session management, and account-linked rate-limit operations exposed by the app server.

### `app-server/tests/suite/auth.rs`

`test` · `integration test execution`

This integration test file sets up temporary CODEX_HOME directories, writes minimal `config.toml` variants, launches `TestAppServer`, and asserts typed protocol responses decoded with `to_response`. Three local config writers generate the exact TOML needed for each scenario: a default config with `shell_snapshot = false`, a custom provider block that can toggle `requires_openai_auth`, and a forced-login variant that sets `forced_login_method`. The helper `login_with_api_key_via_request` encapsulates the login RPC and asserts the server returns `LoginAccountResponse::ApiKey {}` before later status checks.

The tests then probe concrete auth-state transitions. Some start with no credentials or with `OPENAI_API_KEY` removed and verify `GetAuthStatusResponse` reports no auth method/token. Others log in with an API key and verify token inclusion or omission depending on `include_token`. One test injects `CODEX_ACCESS_TOKEN` plus a mocked auth API `whoami` endpoint and confirms the server reports `AuthMode::PersonalAccessToken` but never echoes the token. The refresh-failure tests prewrite ChatGPT auth credentials using `write_chatgpt_auth`, override the refresh-token URL to a wiremock server returning `401 refresh_token_reused`, and verify that explicit or proactive refresh attempts suppress token exposure while preserving `AuthMode::Chatgpt`. The recovery test rewrites the auth file with fresh credentials after a failed refresh and confirms a later status read returns the recovered access token. The final test verifies that when config forces ChatGPT login, API-key login requests fail with the expected JSON-RPC error message.

#### Function details

##### `create_config_toml_custom_provider`  (lines 32–63)

```
fn create_config_toml_custom_provider(
    codex_home: &Path,
    requires_openai_auth: bool,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal `config.toml` that selects a mock provider and optionally marks it as requiring OpenAI auth.

**Data flow**: It takes CODEX_HOME and a boolean `requires_openai_auth`, computes `config.toml`, conditionally builds a `requires_openai_auth = true` line, interpolates that into a fixed TOML template with `model_provider = "mock_provider"` and `shell_snapshot = false`, and writes the file.

**Call relations**: Only the test for API-key auth when provider auth is not required uses this helper to shape provider-specific auth semantics.

*Call graph*: called by 1 (get_auth_status_with_api_key_when_auth_not_required); 3 external calls (join, format!, write).


##### `create_config_toml`  (lines 65–78)

```
fn create_config_toml(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: Writes the default minimal auth-test configuration file.

**Data flow**: It takes CODEX_HOME, joins `config.toml`, and writes a fixed TOML string containing `model`, `approval_policy`, `sandbox_mode`, and `[features] shell_snapshot = false`.

**Call relations**: Most auth tests call this as their baseline setup before launching `TestAppServer`.

*Call graph*: called by 8 (get_auth_status_no_auth, get_auth_status_omits_token_after_permanent_refresh_failure, get_auth_status_omits_token_after_proactive_refresh_failure, get_auth_status_returns_token_after_proactive_refresh_recovery, get_auth_status_with_api_key, get_auth_status_with_api_key_no_include_token, get_auth_status_with_api_key_refresh_requested, get_auth_status_with_personal_access_token_omits_token); 2 external calls (join, write).


##### `create_config_toml_forced_login`  (lines 80–94)

```
fn create_config_toml_forced_login(codex_home: &Path, forced_method: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config that forces a specific login method via `forced_login_method`.

**Data flow**: It takes CODEX_HOME and a forced-method string, interpolates that into a fixed TOML template, and writes the result to `config.toml`.

**Call relations**: The forced-ChatGPT rejection test uses this helper to make API-key login invalid.

*Call graph*: called by 1 (login_api_key_rejected_when_forced_chatgpt); 3 external calls (join, format!, write).


##### `login_with_api_key_via_request`  (lines 96–107)

```
async fn login_with_api_key_via_request(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: Performs an API-key login RPC against a running `TestAppServer` and asserts the response is the successful `ApiKey` login variant.

**Data flow**: It takes a mutable `TestAppServer` and API key string, sends `account/login/start` via `send_login_account_api_key_request`, waits under `DEFAULT_READ_TIMEOUT` for the matching response id, decodes the `JSONRPCResponse` into `LoginAccountResponse` with `to_response`, asserts equality with `LoginAccountResponse::ApiKey {}`, and returns `Ok(())`.

**Call relations**: Several auth-status tests call this helper as a setup step before querying `getAuthStatus`, avoiding repeated login boilerplate.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_login_account_api_key_request); called by 4 (get_auth_status_with_api_key, get_auth_status_with_api_key_no_include_token, get_auth_status_with_api_key_refresh_requested, get_auth_status_with_api_key_when_auth_not_required); 4 external calls (Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_no_auth`  (lines 110–134)

```
async fn get_auth_status_no_auth() -> Result<()>
```

**Purpose**: Verifies that with no configured credentials and `OPENAI_API_KEY` removed, `getAuthStatus` reports no auth method and no token.

**Data flow**: It creates a temp CODEX_HOME, writes the default config, starts `TestAppServer` with `OPENAI_API_KEY` removed from the child environment, initializes the server, sends `getAuthStatus` with `include_token: true` and `refresh_token: false`, waits for the response, decodes it to `GetAuthStatusResponse`, and asserts both `auth_method` and `auth_token` are `None`.

**Call relations**: This test exercises the baseline unauthenticated path using the generic config writer and the harness’s typed request/response helpers.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_with_api_key`  (lines 137–162)

```
async fn get_auth_status_with_api_key() -> Result<()>
```

**Purpose**: Verifies that after API-key login, `getAuthStatus` reports `AuthMode::ApiKey` and returns the stored key when token inclusion is requested.

**Data flow**: It creates temp config, starts and initializes the server, logs in via `login_with_api_key_via_request("sk-test-key")`, sends `getAuthStatus` with `include_token: true`, waits for the response, decodes it, and asserts `auth_method == Some(AuthMode::ApiKey)` and `auth_token == Some("sk-test-key")`.

**Call relations**: This test builds directly on the shared login helper and the default config path.

*Call graph*: calls 3 internal fn (new, create_config_toml, login_with_api_key_via_request); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_with_personal_access_token_omits_token`  (lines 165–220)

```
async fn get_auth_status_with_personal_access_token_omits_token() -> Result<()>
```

**Purpose**: Verifies that when the server authenticates via `CODEX_ACCESS_TOKEN` and a successful auth API `whoami` call, auth status reports `PersonalAccessToken` but never echoes the token.

**Data flow**: It creates temp config, starts a wiremock server that expects `GET /v1/user-auth-credential/whoami` with `Authorization: Bearer at-test-token` and returns account metadata, launches `TestAppServer` with `OPENAI_API_KEY` removed plus `CODEX_ACCESS_TOKEN` and `CODEX_AUTHAPI_BASE_URL` set, initializes, sends `getAuthStatus` with token inclusion requested, waits for the response, decodes it, asserts the full `GetAuthStatusResponse` including `auth_method: Some(PersonalAccessToken)`, `auth_token: None`, and `requires_openai_auth: Some(true)`, then verifies the mock server was hit.

**Call relations**: This test combines environment-based credential injection with an external HTTP dependency mocked by wiremock to validate the personal-access-token path.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 12 external calls (given, start, new, new, Integer, to_response, assert_eq!, json!, timeout, header (+2 more)).


##### `get_auth_status_with_api_key_when_auth_not_required`  (lines 223–253)

```
async fn get_auth_status_with_api_key_when_auth_not_required() -> Result<()>
```

**Purpose**: Verifies that even after API-key login, auth status reports no active auth method when the selected provider explicitly does not require OpenAI auth.

**Data flow**: It creates temp config using `create_config_toml_custom_provider(..., false)`, starts and initializes the server, logs in with an API key, sends `getAuthStatus`, waits for the response, decodes it, and asserts `auth_method` and `auth_token` are `None` while `requires_openai_auth == Some(false)`.

**Call relations**: This test depends on the custom-provider config helper to flip the provider requirement bit and then reuses the shared API-key login helper.

*Call graph*: calls 3 internal fn (new, create_config_toml_custom_provider, login_with_api_key_via_request); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_with_api_key_no_include_token`  (lines 256–281)

```
async fn get_auth_status_with_api_key_no_include_token() -> Result<()>
```

**Purpose**: Verifies that when `include_token` is omitted from the request, auth status still reports API-key auth mode but suppresses the token value.

**Data flow**: It creates temp config, starts and initializes the server, logs in with an API key, sends `getAuthStatus` using params where `include_token` is `None` and `refresh_token` is `Some(false)`, waits for the response, decodes it, and asserts `auth_method == Some(AuthMode::ApiKey)` and `auth_token.is_none()`.

**Call relations**: This test specifically checks wire-level omission semantics by constructing params through the typed struct rather than explicit JSON.

*Call graph*: calls 3 internal fn (new, create_config_toml, login_with_api_key_via_request); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `get_auth_status_with_api_key_refresh_requested`  (lines 284–315)

```
async fn get_auth_status_with_api_key_refresh_requested() -> Result<()>
```

**Purpose**: Verifies that requesting token refresh while authenticated with an API key leaves the API-key status unchanged and still returns the key when inclusion is requested.

**Data flow**: It creates temp config, starts and initializes the server, logs in with an API key, sends `getAuthStatus` with both `include_token` and `refresh_token` set to `true`, waits for the response, decodes it, and asserts the full expected `GetAuthStatusResponse` including `requires_openai_auth: Some(true)`.

**Call relations**: This test reuses the shared login helper and confirms that the refresh flag does not alter API-key behavior.

*Call graph*: calls 3 internal fn (new, create_config_toml, login_with_api_key_via_request); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_omits_token_after_permanent_refresh_failure`  (lines 318–396)

```
async fn get_auth_status_omits_token_after_permanent_refresh_failure() -> Result<()>
```

**Purpose**: Verifies that when ChatGPT credentials exist but an explicit refresh attempt fails permanently with `refresh_token_reused`, auth status reports ChatGPT mode while suppressing the access token, and subsequent reads remain suppressed without repeated state drift.

**Data flow**: It creates temp config, writes ChatGPT auth credentials to disk with stale access and refresh tokens, starts a wiremock refresh endpoint returning HTTP 401 with error code `refresh_token_reused`, launches `TestAppServer` with `OPENAI_API_KEY` removed and the refresh URL override set, initializes, sends `getAuthStatus` requesting both token inclusion and refresh, waits for and decodes the response, asserts ChatGPT mode with `auth_token: None`, then sends the same request again and asserts the second decoded status equals the first before verifying the mock server.

**Call relations**: This test combines on-disk auth fixtures, environment overrides, and a mocked refresh endpoint to validate permanent-refresh-failure handling across repeated status reads.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 13 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+3 more)).


##### `get_auth_status_omits_token_after_proactive_refresh_failure`  (lines 399–463)

```
async fn get_auth_status_omits_token_after_proactive_refresh_failure() -> Result<()>
```

**Purpose**: Verifies that when stored ChatGPT credentials are old enough to trigger proactive refresh and that refresh fails, `getAuthStatus` still reports ChatGPT mode but omits the token.

**Data flow**: It creates temp config, writes ChatGPT auth credentials whose `last_refresh` is nine days in the past, starts a wiremock refresh endpoint returning `refresh_token_reused`, launches the server with the refresh URL override, initializes, sends `getAuthStatus` with `include_token: true` and `refresh_token: false`, waits for and decodes the response, asserts ChatGPT mode with no token, and verifies the mock server expectations.

**Call relations**: Unlike the permanent explicit-refresh test, this one validates the server’s proactive refresh path triggered by stale credentials.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 15 external calls (days, given, start, new, new, now, Integer, to_response, write_chatgpt_auth, assert_eq! (+5 more)).


##### `get_auth_status_returns_token_after_proactive_refresh_recovery`  (lines 466–563)

```
async fn get_auth_status_returns_token_after_proactive_refresh_recovery() -> Result<()>
```

**Purpose**: Verifies that after a failed refresh suppresses token exposure, rewriting the auth file with fresh ChatGPT credentials allows a later status read to return the recovered access token.

**Data flow**: It creates temp config, writes stale ChatGPT auth with an old `last_refresh`, starts a wiremock refresh endpoint that fails with `refresh_token_reused`, launches and initializes the server, sends `getAuthStatus` with explicit refresh requested and asserts the first decoded status has `auth_token: None`, then overwrites the auth file with fresh credentials and current `last_refresh`, sends `getAuthStatus` again without refresh, decodes the response, and asserts ChatGPT mode with `auth_token: Some("recovered-access-token")`, finally verifying the mock server.

**Call relations**: This test extends the refresh-failure scenario by mutating on-disk credentials mid-test to confirm the server can recover from previously suppressed token state.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 15 external calls (days, given, start, new, new, now, Integer, to_response, write_chatgpt_auth, assert_eq! (+5 more)).


##### `login_api_key_rejected_when_forced_chatgpt`  (lines 566–588)

```
async fn login_api_key_rejected_when_forced_chatgpt() -> Result<()>
```

**Purpose**: Verifies that when config forces ChatGPT login, an API-key login request fails with the expected JSON-RPC error message.

**Data flow**: It creates temp config using `create_config_toml_forced_login(..., "chatgpt")`, starts and initializes the server, sends an API-key login request, waits under timeout for the matching error response, and asserts `err.error.message` equals `API key login is disabled. Use ChatGPT login instead.`

**Call relations**: This test uses the forced-login config helper to drive a negative login path and reads the result through the harness’s error-specific stream reader.

*Call graph*: calls 2 internal fn (new, create_config_toml_forced_login); 4 external calls (new, Integer, assert_eq!, timeout).


### `app-server/tests/suite/v2/account.rs`

`test` · `authentication, account inspection, and turn-time refresh in integration tests`

This file is the main behavioral specification for account state in the v2 protocol. It starts by defining `CreateConfigTomlParams`, a compact builder-like struct used to generate test configs with forced login methods, forced workspace ids or allowlists, `requires_openai_auth`, alternate base URLs, and custom provider sections. Several small wiremock helpers mount deterministic responses for device-code endpoints (`/api/accounts/deviceauth/usercode`, `/token`) and OAuth token exchange (`/oauth/token`).

The tests exercise both persistent auth storage and live protocol interactions. Some seed auth directly with helpers like `login_with_api_key`, `login_with_bedrock_api_key`, or `write_chatgpt_auth`; others drive login through JSON-RPC requests and then assert `account/login/completed` and `account/updated` notifications. The suite pays special attention to external ChatGPT auth-token mode: `getAccount(refresh_token=true)` must be a no-op there, while a 401 during turn execution must trigger a server request for `account/chatgptAuthTokens/refresh`, retry with the new bearer token, and fail cleanly if the client returns an error, the workspace id mismatches policy, or the replacement token is malformed.

Additional tests pin down forced-login policy errors, cancellation semantics for browser and device-code login flows, debug OAuth override environment variables, account reporting for API key, ChatGPT, and Amazon Bedrock providers, and the rule that permanently stale ChatGPT refresh state should cause `getAccount` to omit the account entirely. The file therefore documents both steady-state account representation and the asynchronous transitions that update it.

#### Function details

##### `create_config_toml`  (lines 81–142)

```
fn create_config_toml(codex_home: &Path, params: CreateConfigTomlParams) -> std::io::Result<()>
```

**Purpose**: Generates a test `config.toml` for account-related scenarios with optional forced login policy, workspace restrictions, auth requirements, and provider customization. It is the central fixture writer for this suite.

**Data flow**: Takes a codex-home path and `CreateConfigTomlParams` → derives `base_url`, optional `forced_login_method` line, either a single or array-valued `forced_chatgpt_workspace_id` line, optional `requires_openai_auth` line, selected `model_provider_id`, and either a default mock-provider section or caller-supplied provider config → formats the full TOML and writes it to `<codex_home>/config.toml`.

**Call relations**: Nearly every test calls this helper first so each scenario can tweak only the relevant config knobs while sharing a common baseline.

*Call graph*: called by 27 (account_read_refresh_token_is_noop_in_external_mode, external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized, get_account_no_auth, get_account_omits_chatgpt_after_permanent_refresh_failure, get_account_when_auth_not_required, get_account_with_api_key, get_account_with_aws_provider (+15 more)); 4 external calls (join, new, format!, write).


##### `mock_device_code_usercode`  (lines 144–154)

```
async fn mock_device_code_usercode(server: &MockServer, interval_seconds: u64)
```

**Purpose**: Mounts a successful device-code user-code endpoint on a `MockServer`. It simulates the first step of device-code login by returning a device auth id, user code, and polling interval.

**Data flow**: Accepts a wiremock `MockServer` and `interval_seconds` → registers a `POST /api/accounts/deviceauth/usercode` mock that returns HTTP 200 with JSON containing `device_auth_id`, `user_code`, and `interval` as a string → writes behavior into the mock server.

**Call relations**: Used by the successful, failure-after-start, and cancellation device-code tests to make the login flow begin normally.

*Call graph*: called by 3 (login_account_chatgpt_device_code_can_be_cancelled, login_account_chatgpt_device_code_failure_notifies_without_account_update, login_account_chatgpt_device_code_succeeds_and_notifies); 5 external calls (given, new, json!, method, path).


##### `mock_device_code_usercode_failure`  (lines 156–162)

```
async fn mock_device_code_usercode_failure(server: &MockServer, status: u16)
```

**Purpose**: Mounts a failing device-code user-code endpoint. It lets tests verify behavior when device-code login is unavailable before any login session is established.

**Data flow**: Takes a mock server and HTTP status code → registers `POST /api/accounts/deviceauth/usercode` to respond with that status and no success payload → mutates mock-server routing state.

**Call relations**: Called only by the test that expects device-code login startup to fail immediately and emit no completion notification.

*Call graph*: called by 1 (login_account_chatgpt_device_code_returns_error_when_disabled); 4 external calls (given, new, method, path).


##### `mock_device_code_token_success`  (lines 164–174)

```
async fn mock_device_code_token_success(server: &MockServer)
```

**Purpose**: Mounts a successful device-auth token polling endpoint. It simulates the server returning an authorization code and PKCE material after the user completes verification.

**Data flow**: Registers `POST /api/accounts/deviceauth/token` on the provided mock server to return HTTP 200 with JSON fields `authorization_code`, `code_challenge`, and `code_verifier`.

**Call relations**: Used by the successful device-code login test after `mock_device_code_usercode` has established the initial login session.

*Call graph*: called by 1 (login_account_chatgpt_device_code_succeeds_and_notifies); 5 external calls (given, new, json!, method, path).


##### `mock_device_code_token_failure`  (lines 176–182)

```
async fn mock_device_code_token_failure(server: &MockServer, status: u16)
```

**Purpose**: Mounts a failing device-auth token polling endpoint. It drives tests where login starts but later fails or is canceled before token exchange succeeds.

**Data flow**: Accepts a mock server and status code → registers `POST /api/accounts/deviceauth/token` to return that status → updates mock-server behavior.

**Call relations**: Shared by the device-code failure and cancellation tests to keep the polling phase from succeeding.

*Call graph*: called by 2 (login_account_chatgpt_device_code_can_be_cancelled, login_account_chatgpt_device_code_failure_notifies_without_account_update); 4 external calls (given, new, method, path).


##### `mock_device_code_oauth_token`  (lines 184–194)

```
async fn mock_device_code_oauth_token(server: &MockServer, id_token: &str)
```

**Purpose**: Mounts a successful OAuth token exchange endpoint that returns a caller-supplied ID token plus access and refresh tokens. This completes the device-code login flow in tests.

**Data flow**: Takes a mock server and `id_token` string → registers `POST /oauth/token` to return HTTP 200 with JSON containing that `id_token`, `access_token`, and `refresh_token` → writes mock behavior.

**Call relations**: Used only by the successful device-code login test after the device-auth polling endpoint has produced authorization-code material.

*Call graph*: called by 1 (login_account_chatgpt_device_code_succeeds_and_notifies); 5 external calls (given, new, json!, method, path).


##### `logout_account_removes_auth_and_notifies`  (lines 197–254)

```
async fn logout_account_removes_auth_and_notifies() -> Result<()>
```

**Purpose**: Verifies that logout deletes persisted auth, emits `account/updated` with no auth mode or plan, and causes subsequent `getAccount` to return `None`.

**Data flow**: Creates config, seeds API-key auth via `login_with_api_key`, asserts `auth.json` exists, starts the server with `OPENAI_API_KEY` unset, initializes it, sends logout, reads and deserializes the success response, waits for `account/updated`, pattern-matches it to `ServerNotification::AccountUpdated`, asserts `auth_mode` and `plan_type` are `None`, asserts `auth.json` no longer exists, then sends `getAccount(refresh_token=false)` and asserts the returned account is `None`.

**Call relations**: This top-level test covers the full logout path from persisted credentials through notification fanout and final account state.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, default); 9 external calls (new, Integer, default, to_response, assert!, assert_eq!, bail!, login_with_api_key, timeout).


##### `set_auth_token_updates_account_and_notifies`  (lines 257–331)

```
async fn set_auth_token_updates_account_and_notifies() -> Result<()>
```

**Purpose**: Checks that injecting ChatGPT auth tokens through the protocol updates account state immediately and emits the expected notifications. It also verifies `getAccount` reflects the embedded email and plan claims.

**Data flow**: Creates config requiring OpenAI auth and pointing at a mock base URL, writes models cache, encodes an ID token with email/plan/workspace claims, starts the server with `OPENAI_API_KEY` removed, initializes it, sends `chatgptAuthTokens/login`, reads a `LoginAccountResponse::ChatgptAuthTokens`, waits for `account/updated`, asserts `AuthMode::ChatgptAuthTokens` and `PlanType::Pro`, then calls `getAccount(refresh_token=false)` and asserts it returns `Account::Chatgpt { email, plan_type }` with `requires_openai_auth: true`.

**Call relations**: This is the baseline test for external-token mode and establishes the notification/account shape reused conceptually by later refresh tests.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 11 external calls (default, start, new, Integer, encode_id_token, to_response, write_models_cache, assert_eq!, bail!, format! (+1 more)).


##### `account_read_refresh_token_is_noop_in_external_mode`  (lines 334–409)

```
async fn account_read_refresh_token_is_noop_in_external_mode() -> Result<()>
```

**Purpose**: Proves that `getAccount(refresh_token=true)` does not trigger a token-refresh request when the server is in externally managed ChatGPT auth-token mode. The account read should simply return current embedded claims.

**Data flow**: Creates auth-required config and models cache, injects ChatGPT auth tokens through the login RPC, waits for `account/updated`, sends `getAccount(refresh_token=true)`, asserts the returned account still reflects the embedded email and plan, then waits briefly for any server request and asserts the timeout fires, meaning no `account/chatgptAuthTokens/refresh` request was emitted.

**Call relations**: This negative test complements the turn-time refresh tests by showing that refresh requests are conditional on runtime unauthorized responses, not on account reads in external mode.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 10 external calls (default, from_millis, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq!, timeout).


##### `respond_to_refresh_request`  (lines 411–434)

```
async fn respond_to_refresh_request(
    mcp: &mut TestAppServer,
    access_token: &str,
    chatgpt_account_id: &str,
    chatgpt_plan_type: Option<&str>,
) -> Result<()>
```

**Purpose**: Consumes the next server request, asserts it is a ChatGPT auth-token refresh prompted by unauthorized access, and replies with replacement tokens. It encapsulates the client side of the refresh handshake.

**Data flow**: Reads the next request message from `TestAppServer` under timeout, pattern-matches it as `ServerRequest::ChatgptAuthTokensRefresh`, asserts `params.reason == Unauthorized`, builds a `ChatgptAuthTokensRefreshResponse` from the supplied access token, account id, and optional plan type, serializes it to JSON, and sends it back using the captured `request_id`.

**Call relations**: Called only by `external_auth_refreshes_on_unauthorized`, where the test needs to satisfy the server's refresh request and then verify the retried upstream HTTP call.

*Call graph*: calls 2 internal fn (read_stream_until_request_message, send_response); called by 1 (external_auth_refreshes_on_unauthorized); 4 external calls (assert_eq!, bail!, to_value, timeout).


##### `external_auth_refreshes_on_unauthorized`  (lines 438–556)

```
async fn external_auth_refreshes_on_unauthorized() -> Result<()>
```

**Purpose**: Verifies the happy path for external ChatGPT token refresh during turn execution: a 401 from the model backend triggers a refresh request to the client, the server retries with the new bearer token, and the turn completes.

**Data flow**: Creates auth-required config and models cache against a wiremock server, mounts a response sequence of one 401 then one successful SSE stream, encodes initial and refreshed ID tokens with different emails/workspace ids, logs in with the initial token, starts a thread, starts a turn, answers the server's refresh request via `respond_to_refresh_request`, waits for the turn response and `turn/completed`, then inspects recorded upstream requests and asserts the first used `Bearer {initial_access_token}` and the second used `Bearer {refreshed_access_token}`.

**Call relations**: This is the central refresh integration test. It drives thread and turn creation to force an upstream model call, then delegates the refresh-response step to `respond_to_refresh_request`.

*Call graph*: calls 6 internal fn (new, new_with_env, create_config_toml, respond_to_refresh_request, mount_response_sequence, sse); 13 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert_eq!, format! (+3 more)).


##### `external_auth_refresh_error_fails_turn`  (lines 560–673)

```
async fn external_auth_refresh_error_fails_turn() -> Result<()>
```

**Purpose**: Checks that if the client answers the server's refresh request with a JSON-RPC error, the in-flight turn fails rather than retrying indefinitely or succeeding with stale credentials.

**Data flow**: Sets up auth-required config, a backend that returns 401, logs in with an initial ChatGPT token, starts a thread and turn, reads the server's `ChatgptAuthTokensRefresh` request, responds with `send_error` carrying code `-32000` and message `refresh failed`, then waits for the turn response and `turn/completed` notification and asserts the completed turn has `TurnStatus::Failed` and a non-empty error.

**Call relations**: This negative-path sibling of the successful refresh test manually handles the refresh request inline so it can inject a protocol error instead of a token response.

*Call graph*: calls 4 internal fn (new, new_with_env, create_config_toml, mount_response_sequence); 16 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq! (+6 more)).


##### `external_auth_refresh_mismatched_workspace_fails_turn`  (lines 677–797)

```
async fn external_auth_refresh_mismatched_workspace_fails_turn() -> Result<()>
```

**Purpose**: Ensures that refreshed external tokens are validated against configured workspace restrictions. If the replacement token belongs to a disallowed workspace, the turn fails.

**Data flow**: Creates config with `forced_workspace_id` set to the allowed workspace and a backend that returns 401, logs in with an initial token for the allowed workspace, starts a thread and turn, reads the refresh request, responds with a `ChatgptAuthTokensRefreshResponse` whose `chatgpt_account_id` is the disallowed workspace, then waits for turn completion and asserts failed status with an error.

**Call relations**: This test extends the refresh flow with policy enforcement, proving the server validates refreshed identity before retrying upstream work.

*Call graph*: calls 4 internal fn (new, new_with_env, create_config_toml, mount_response_sequence); 17 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq! (+7 more)).


##### `external_auth_refresh_invalid_access_token_fails_turn`  (lines 801–914)

```
async fn external_auth_refresh_invalid_access_token_fails_turn() -> Result<()>
```

**Purpose**: Verifies that a malformed refreshed access token is rejected and causes the turn to fail. The server must not retry upstream requests with an invalid JWT-like token.

**Data flow**: Creates auth-required config and a backend that returns 401, logs in with a valid initial token, starts a thread and turn, reads the refresh request, responds with `access_token: "not-a-jwt"` and the original workspace id, then waits for `turn/completed` and asserts failed status with an error.

**Call relations**: This is another refresh negative-path test, focused on token parsing/validation rather than workspace policy or client-side JSON-RPC failure.

*Call graph*: calls 4 internal fn (new, new_with_env, create_config_toml, mount_response_sequence); 17 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq! (+7 more)).


##### `login_account_api_key_succeeds_and_notifies`  (lines 917–962)

```
async fn login_account_api_key_succeeds_and_notifies() -> Result<()>
```

**Purpose**: Checks the API-key login RPC end to end, including completion and account-updated notifications plus persisted auth creation.

**Data flow**: Creates default config, starts and initializes the server, sends `loginAccount` with an API key, reads a `LoginAccountResponse::ApiKey`, waits for `account/login/completed` and asserts `login_id: None`, `success: true`, `error: None`, waits for `account/updated` and asserts `auth_mode == Some(ApiKey)` and `plan_type == None`, then asserts `auth.json` exists on disk.

**Call relations**: This is the baseline positive test for API-key login and notification sequencing.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (new, Integer, default, to_response, assert!, assert_eq!, bail!, assert_eq!, timeout).


##### `login_account_api_key_rejected_when_forced_chatgpt`  (lines 965–992)

```
async fn login_account_api_key_rejected_when_forced_chatgpt() -> Result<()>
```

**Purpose**: Verifies that config forcing ChatGPT login disables API-key login requests with a clear JSON-RPC error message.

**Data flow**: Writes config with `forced_login_method = "chatgpt"`, starts and initializes the server, sends an API-key login request, reads the matching JSON-RPC error response, and asserts the message is `API key login is disabled. Use ChatGPT login instead.`

**Call relations**: This negative test documents one branch of forced-login policy enforcement.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (default, new, Integer, assert_eq!, timeout).


##### `login_account_chatgpt_rejected_when_forced_api`  (lines 995–1020)

```
async fn login_account_chatgpt_rejected_when_forced_api() -> Result<()>
```

**Purpose**: Verifies the inverse forced-login policy: when API login is forced, ChatGPT login requests are rejected with a specific error.

**Data flow**: Writes config with `forced_login_method = "api"`, starts and initializes the server, sends a ChatGPT login request, reads the JSON-RPC error response, and asserts the message is `ChatGPT login is disabled. Use API key login instead.`

**Call relations**: This is the companion policy test to API-key rejection under forced ChatGPT mode.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (default, new, Integer, assert_eq!, timeout).


##### `login_account_chatgpt_device_code_returns_error_when_disabled`  (lines 1023–1076)

```
async fn login_account_chatgpt_device_code_returns_error_when_disabled() -> Result<()>
```

**Purpose**: Checks that device-code login startup fails cleanly when the issuer endpoint reports the feature as unavailable. No completion notification or auth file should be produced.

**Data flow**: Creates auth-required config and models cache against a mock server, mounts a failing user-code endpoint with status 404, starts the server with `OPENAI_API_KEY` unset and `CODEX_APP_SERVER_LOGIN_ISSUER` pointing at the mock issuer, sends the device-code login request, reads the JSON-RPC error and asserts its message mentions device-code login not being enabled, then waits briefly to confirm no `account/login/completed` notification arrives and asserts `auth.json` does not exist.

**Call relations**: This test covers failure before a login session is established, contrasting with later tests where login starts successfully and then fails or is canceled.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, mock_device_code_usercode_failure); 9 external calls (default, from_millis, start, new, Integer, write_models_cache, assert!, format!, timeout).


##### `login_account_chatgpt_device_code_succeeds_and_notifies`  (lines 1079–1160)

```
async fn login_account_chatgpt_device_code_succeeds_and_notifies() -> Result<()>
```

**Purpose**: Exercises the full successful device-code login flow, from user-code issuance through polling and OAuth token exchange to account update and persisted auth.

**Data flow**: Creates auth-required config and models cache, mounts successful user-code and token endpoints plus an OAuth token endpoint returning an ID token with email/plan/workspace claims, starts the server with login issuer override, sends the device-code login request, reads `LoginAccountResponse::ChatgptDeviceCode { login_id, verification_url, user_code }`, asserts the verification URL and user code, waits for `account/login/completed` and asserts success for that `login_id`, waits for `account/updated` and asserts `AuthMode::Chatgpt` and `PlanType::Pro`, then asserts `auth.json` exists.

**Call relations**: This is the positive-path counterpart to the disabled, failure, and cancellation device-code tests.

*Call graph*: calls 6 internal fn (new, new_with_env, create_config_toml, mock_device_code_oauth_token, mock_device_code_token_success, mock_device_code_usercode); 12 external calls (default, start, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq!, bail! (+2 more)).


##### `login_account_chatgpt_device_code_failure_notifies_without_account_update`  (lines 1163–1235)

```
async fn login_account_chatgpt_device_code_failure_notifies_without_account_update() -> Result<()>
```

**Purpose**: Verifies that a device-code login that starts successfully but later fails emits a failed completion notification and does not update account state or write auth.

**Data flow**: Creates auth-required config and models cache, mounts successful user-code issuance and failing token polling, starts the server with issuer override, sends the device-code login request and captures `login_id`, waits for `account/login/completed`, asserts `success == false` and that the error mentions device-auth failure status, then confirms no `account/updated` notification arrives within 500 ms and asserts `auth.json` is absent.

**Call relations**: This test documents the asynchronous failure path after login initiation but before credential persistence.

*Call graph*: calls 4 internal fn (new_with_env, create_config_toml, mock_device_code_token_failure, mock_device_code_usercode); 12 external calls (default, from_millis, start, new, Integer, to_response, write_models_cache, assert!, assert_eq!, bail! (+2 more)).


##### `login_account_chatgpt_device_code_can_be_cancelled`  (lines 1238–1319)

```
async fn login_account_chatgpt_device_code_can_be_cancelled() -> Result<()>
```

**Purpose**: Checks that an in-progress device-code login can be canceled through the protocol and that cancellation produces a failed completion notification without updating account state.

**Data flow**: Creates auth-required config and models cache, mounts user-code success and token polling failure with a nonzero interval, starts the server with issuer override, sends the device-code login request and captures `login_id`, sends `cancelLoginAccount`, reads `CancelLoginAccountResponse` and asserts `status == Canceled`, waits for `account/login/completed`, asserts `success == false` and a non-empty error, then confirms no `account/updated` notification arrives and no `auth.json` is written.

**Call relations**: This test combines the long-running device-code flow with explicit cancellation semantics, unlike the plain failure test where the server reaches failure on its own.

*Call graph*: calls 4 internal fn (new_with_env, create_config_toml, mock_device_code_token_failure, mock_device_code_usercode); 12 external calls (default, from_millis, start, new, Integer, to_response, write_models_cache, assert!, assert_eq!, bail! (+2 more)).


##### `login_account_chatgpt_start_can_be_cancelled`  (lines 1324–1385)

```
async fn login_account_chatgpt_start_can_be_cancelled() -> Result<()>
```

**Purpose**: Verifies that the browser-based ChatGPT login flow can be started and then canceled before completion. It also checks that the generated auth URL targets localhost redirect handling.

**Data flow**: Creates default config, starts and initializes the server, sends a ChatGPT login request, reads `LoginAccountResponse::Chatgpt { login_id, auth_url }`, asserts the URL contains an encoded localhost redirect URI, sends `cancelLoginAccount` for that `login_id`, reads the cancel response, waits for `account/login/completed`, and asserts the completion payload reports the same `login_id`, `success == false`, and a non-empty error; then confirms no `account/updated` notification arrives shortly afterward.

**Call relations**: Marked `serial(login_port)` because the login server binds a fixed port. It covers cancellation of the browser-login path rather than device-code login.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from_millis, new, Integer, default, to_response, assert!, bail!, assert_eq!, timeout).


##### `login_account_chatgpt_uses_debug_oauth_overrides`  (lines 1390–1437)

```
async fn login_account_chatgpt_uses_debug_oauth_overrides() -> Result<()>
```

**Purpose**: Checks that debug environment overrides for OAuth issuer and client id are reflected in the generated ChatGPT login URL.

**Data flow**: Creates default config, starts the server with `CLIENT_ID_OVERRIDE_ENV_VAR=staging-client` and `CODEX_APP_SERVER_LOGIN_ISSUER=https://auth.example.com`, initializes it, sends a ChatGPT login request, parses the returned `auth_url` as `Url`, asserts the origin is `https://auth.example.com` and the `client_id` query parameter is `staging-client`, then cancels the login and reads the cancel response.

**Call relations**: Also serialized on the login port; it focuses on URL construction rather than completing or canceling for account-state effects.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 8 external calls (new, parse, Integer, default, to_response, assert_eq!, bail!, timeout).


##### `set_auth_token_cancels_active_chatgpt_login`  (lines 1442–1506)

```
async fn set_auth_token_cancels_active_chatgpt_login() -> Result<()>
```

**Purpose**: Verifies that externally setting ChatGPT auth tokens supersedes and cancels an active browser-based ChatGPT login attempt. The old login id should no longer be cancelable.

**Data flow**: Creates default config, starts and initializes the server, begins a ChatGPT login and captures its `login_id`, encodes an external ID token, sends `chatgptAuthTokens/login`, reads a `LoginAccountResponse::ChatgptAuthTokens`, waits for `account/updated`, then sends `cancelLoginAccount` for the original `login_id` and asserts the response status is `NotFound`.

**Call relations**: This test links two login mechanisms together, proving external token injection tears down any in-flight interactive login state.

*Call graph*: calls 3 internal fn (new, new, create_config_toml); 8 external calls (new, Integer, default, encode_id_token, to_response, assert_eq!, bail!, timeout).


##### `login_account_chatgpt_includes_forced_workspace_query_param`  (lines 1511–1540)

```
async fn login_account_chatgpt_includes_forced_workspace_query_param() -> Result<()>
```

**Purpose**: Checks that when config forces a single ChatGPT workspace id, the generated browser-login URL includes that workspace restriction as a query parameter.

**Data flow**: Writes config with `forced_workspace_id`, starts and initializes the server, sends a ChatGPT login request, extracts `auth_url` from the response, and asserts the URL string contains `allowed_workspace_id=<forced id>`.

**Call relations**: This is a URL-construction policy test for single-workspace restriction.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (default, new, Integer, to_response, assert!, bail!, timeout).


##### `login_account_chatgpt_includes_forced_workspace_allowlist_query_param`  (lines 1545–1584)

```
async fn login_account_chatgpt_includes_forced_workspace_allowlist_query_param() -> Result<()>
```

**Purpose**: Checks that when config specifies multiple allowed workspace ids, the generated browser-login URL carries them in the expected query parameter form.

**Data flow**: Writes config with `forced_workspace_ids` containing two ids, starts and initializes the server, sends a ChatGPT login request, parses the returned `auth_url`, collects all `allowed_workspace_id` query values, and asserts they equal a single comma-joined string of the two configured ids.

**Call relations**: This is the multi-workspace counterpart to the single forced-workspace URL test.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, parse, Integer, to_response, assert_eq!, bail!, timeout, vec!).


##### `get_account_no_auth`  (lines 1587–1616)

```
async fn get_account_no_auth() -> Result<()>
```

**Purpose**: Verifies that `getAccount` reports no account when auth is required but no credentials are present. It also confirms the `requires_openai_auth` flag is surfaced.

**Data flow**: Creates config with `requires_openai_auth = true`, starts the server with `OPENAI_API_KEY` unset, initializes it, sends `getAccount(refresh_token=false)`, deserializes the response, and asserts `account == None` and `requires_openai_auth == true`.

**Call relations**: This is the baseline account-read test for an unauthenticated state.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_with_api_key`  (lines 1619–1660)

```
async fn get_account_with_api_key() -> Result<()>
```

**Purpose**: Checks that after API-key login, `getAccount` reports `Account::ApiKey` while preserving the provider's auth-required flag.

**Data flow**: Creates auth-required config, starts and initializes the server, performs API-key login and ignores the success payload beyond deserialization, sends `getAccount(refresh_token=false)`, and asserts the response equals `GetAccountResponse { account: Some(Account::ApiKey {}), requires_openai_auth: true }`.

**Call relations**: This test pairs with the API-key login test but focuses on steady-state account reporting rather than notifications.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_when_auth_not_required`  (lines 1663–1694)

```
async fn get_account_when_auth_not_required() -> Result<()>
```

**Purpose**: Verifies that `getAccount` reports no account and `requires_openai_auth: false` when the configured provider does not require OpenAI auth.

**Data flow**: Creates config with `requires_openai_auth = false`, starts and initializes the server, sends `getAccount(refresh_token=false)`, deserializes the response, and asserts it equals `GetAccountResponse { account: None, requires_openai_auth: false }`.

**Call relations**: This test distinguishes absence of credentials from absence of auth requirement.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_with_aws_provider`  (lines 1697–1737)

```
async fn get_account_with_aws_provider() -> Result<()>
```

**Purpose**: Checks account reporting for an Amazon Bedrock provider configured to use AWS-managed credentials. No OpenAI auth should be required.

**Data flow**: Writes config selecting `model_provider_id = "amazon-bedrock"` with an `[aws]` profile/region section, starts and initializes the server, sends `getAccount(refresh_token=false)`, and asserts the response reports `Account::AmazonBedrock { credential_source: AwsManaged }` with `requires_openai_auth: false`.

**Call relations**: This broadens account reporting beyond OpenAI/ChatGPT auth modes into provider-specific credential sources.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_with_managed_bedrock_provider`  (lines 1740–1782)

```
async fn get_account_with_managed_bedrock_provider() -> Result<()>
```

**Purpose**: Verifies that when Bedrock credentials are stored by Codex itself, `getAccount` reports `AmazonBedrock` with `CodexManaged` credential source.

**Data flow**: Creates config selecting `amazon-bedrock`, seeds managed Bedrock credentials via `login_with_bedrock_api_key`, starts and initializes the server, sends `getAccount(refresh_token=false)`, and asserts the response reports `Account::AmazonBedrock { credential_source: CodexManaged }` and `requires_openai_auth: false`.

**Call relations**: This is the managed-credentials counterpart to the AWS-managed Bedrock account test.

*Call graph*: calls 3 internal fn (new, create_config_toml, default); 7 external calls (default, new, Integer, to_response, assert_eq!, login_with_bedrock_api_key, timeout).


##### `get_account_with_chatgpt`  (lines 1785–1827)

```
async fn get_account_with_chatgpt() -> Result<()>
```

**Purpose**: Checks that persisted ChatGPT auth is surfaced as a ChatGPT account with email and plan type. It validates account decoding from stored auth rather than live login.

**Data flow**: Creates auth-required config, writes ChatGPT auth fixture with email `user@example.com` and plan `pro`, starts the server with `OPENAI_API_KEY` unset, initializes it, sends `getAccount(refresh_token=false)`, and asserts the response equals `Account::Chatgpt { email: ..., plan_type: Pro }` with `requires_openai_auth: true`.

**Call relations**: This test covers the steady-state read path for stored ChatGPT credentials.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 7 external calls (default, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout).


##### `get_account_omits_chatgpt_after_permanent_refresh_failure`  (lines 1830–1911)

```
async fn get_account_omits_chatgpt_after_permanent_refresh_failure() -> Result<()>
```

**Purpose**: Verifies that permanently stale ChatGPT credentials are suppressed from `getAccount` after a refresh attempt fails with a terminal token-reuse error. The server should not continue presenting the stale account as valid.

**Data flow**: Creates auth-required config, writes a stale ChatGPT auth fixture with refresh token and `last_refresh` nine days in the past, mounts `/oauth/token` on a mock server to return 401 with error code `refresh_token_reused`, starts the server with `OPENAI_API_KEY` unset and `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR` pointing at the mock endpoint, first sends `getAuthStatus(include_token=true, refresh_token=true)` to trigger refresh handling, then sends `getAccount(refresh_token=false)` and asserts the response is `GetAccountResponse { account: None, requires_openai_auth: true }`; finally verifies the mock server was hit.

**Call relations**: This test ties auth-status refresh behavior to later account visibility, documenting how terminal refresh failure removes ChatGPT account reporting.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 16 external calls (days, default, given, start, new, new, now, Integer, to_response, write_chatgpt_auth (+6 more)).


##### `get_account_with_chatgpt_missing_plan_claim_returns_unknown`  (lines 1914–1954)

```
async fn get_account_with_chatgpt_missing_plan_claim_returns_unknown() -> Result<()>
```

**Purpose**: Checks that if stored ChatGPT auth lacks a plan claim, `getAccount` maps it to `PlanType::Unknown` rather than failing or omitting the account.

**Data flow**: Creates auth-required config, writes ChatGPT auth fixture with email but no plan type, starts the server with `OPENAI_API_KEY` unset, initializes it, sends `getAccount(refresh_token=false)`, and asserts the response reports `Account::Chatgpt { email: "user@example.com", plan_type: Unknown }` with `requires_openai_auth: true`.

**Call relations**: This is a decoding edge-case test for incomplete ChatGPT token claims.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 7 external calls (default, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout).


### `app-server/tests/suite/v2/rate_limits.rs`

`test` · `request handling`

This module covers two related account-facing APIs. For `getAccountRateLimits`, it first distinguishes missing codex auth from API-key-only auth, then exercises the full success path by writing file-based ChatGPT auth and mocking `/api/codex/usage`. The mocked payload includes primary and secondary windows, a `rate_limit_reached_type`, spend-control data, one additional rate limit, and reset-credit availability. The test asserts the app server converts that backend shape into a `GetAccountRateLimitsResponse` containing a primary `RateLimitSnapshot`, a `rate_limits_by_limit_id` map keyed by `codex` and `codex_other`, `RateLimitWindow` durations converted to minutes, `SpendControlLimitSnapshot`, `AccountPlanType::Pro`, and `RateLimitResetCreditsSummary`.

The second half covers `sendAddCreditsNudgeEmail`. As with rate limits, there are separate auth tests for no codex auth and API-key-only auth. Positive behavior is validated by mocking a POST to `/api/codex/accounts/send_add_credits_nudge_email` and asserting the request body contains the expected `credit_type` string and the typed response status is `Sent`. A 429 backend response is mapped to `AddCreditsNudgeEmailStatus::CooldownActive` rather than an error, while a 500 response becomes JSON-RPC internal error `-32603` with no extra data and a message containing `failed to notify workspace owner`. Shared helpers perform API-key login and write the minimal `chatgpt_base_url` config.

#### Function details

##### `get_account_rate_limits_requires_auth`  (lines 39–62)

```
async fn get_account_rate_limits_requires_auth() -> Result<()>
```

**Purpose**: Ensures reading account rate limits requires codex account authentication.

**Data flow**: Creates temp codex home, starts `TestAppServer` with `OPENAI_API_KEY` removed, initializes it, sends `getAccountRateLimits`, reads the error response, and asserts the request id, invalid-request code, and exact missing-auth message.

**Call relations**: This top-level test covers the first auth gate for the rate-limits RPC before any backend call is possible.

*Call graph*: calls 1 internal fn (new_with_env); 4 external calls (new, Integer, assert_eq!, timeout).


##### `get_account_rate_limits_requires_chatgpt_auth`  (lines 65–89)

```
async fn get_account_rate_limits_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: Ensures API-key login alone is insufficient to read account rate limits.

**Data flow**: Creates temp codex home, initializes a default app server, logs in with an API key via `login_with_api_key`, sends `getAccountRateLimits`, reads the error response, and asserts invalid-request code and the chatgpt-auth-required message.

**Call relations**: Run directly by the test harness, this test covers the second auth gate after codex account login succeeds.

*Call graph*: calls 2 internal fn (new, login_with_api_key); 4 external calls (new, Integer, assert_eq!, timeout).


##### `get_account_rate_limits_returns_snapshot`  (lines 92–268)

```
async fn get_account_rate_limits_returns_snapshot() -> Result<()>
```

**Purpose**: Verifies the backend usage payload is mapped into the full typed rate-limit snapshot response.

**Data flow**: Writes ChatGPT auth with account id and plan type, starts a mock server, writes `chatgpt_base_url`, computes RFC3339 reset timestamps, mounts a GET `/api/codex/usage` response containing primary/secondary windows, spend control, additional rate limits, and reset credits, then starts the app server with `OPENAI_API_KEY` removed. After sending `getAccountRateLimits` and decoding `GetAccountRateLimitsResponse`, it compares the entire typed structure, including `RateLimitSnapshot`, `RateLimitWindow`, `SpendControlLimitSnapshot`, `RateLimitReachedType`, per-limit map entries, and `RateLimitResetCreditsSummary`.

**Call relations**: This is the main happy-path test for the rate-limits RPC. It depends on `write_chatgpt_base_url` and direct wiremock setup to validate detailed field mapping.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, parse_from_rfc3339, json! (+4 more)).


##### `send_add_credits_nudge_email_requires_auth`  (lines 271–298)

```
async fn send_add_credits_nudge_email_requires_auth() -> Result<()>
```

**Purpose**: Ensures sending the workspace-owner nudge email requires codex account authentication.

**Data flow**: Creates temp codex home, starts `TestAppServer` with `OPENAI_API_KEY` removed, initializes it, sends `SendAddCreditsNudgeEmailParams { credit_type: Credits }`, reads the error response, and asserts request id, invalid-request code, and the missing-auth message.

**Call relations**: This top-level test covers the first auth gate for the nudge-email RPC.

*Call graph*: calls 1 internal fn (new_with_env); 4 external calls (new, Integer, assert_eq!, timeout).


##### `send_add_credits_nudge_email_requires_chatgpt_auth`  (lines 301–329)

```
async fn send_add_credits_nudge_email_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: Ensures API-key login alone is insufficient to send the add-credits nudge email.

**Data flow**: Creates temp codex home, initializes the app server, logs in with an API key, sends `SendAddCreditsNudgeEmailParams { credit_type: UsageLimit }`, reads the error response, and asserts invalid-request code and the chatgpt-auth-required message.

**Call relations**: This test mirrors the rate-limits auth split for the nudge-email RPC and uses the shared login helper.

*Call graph*: calls 2 internal fn (new, login_with_api_key); 4 external calls (new, Integer, assert_eq!, timeout).


##### `send_add_credits_nudge_email_posts_expected_body`  (lines 333–378)

```
async fn send_add_credits_nudge_email_posts_expected_body() -> Result<()>
```

**Purpose**: Checks that the nudge-email RPC sends the expected backend POST body and maps a 200 response to `Sent`.

**Data flow**: Writes ChatGPT auth and `chatgpt_base_url`, mounts a POST `/api/codex/accounts/send_add_credits_nudge_email` mock requiring auth headers and body `{ "credit_type": "usage_limit" }`, starts the app server with `OPENAI_API_KEY` removed, sends the nudge-email request, decodes `SendAddCreditsNudgeEmailResponse`, and asserts `status == Sent`.

**Call relations**: This positive-path test is run directly and validates both request serialization and success mapping for the email RPC.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, json!, timeout (+4 more)).


##### `send_add_credits_nudge_email_maps_cooldown`  (lines 382–422)

```
async fn send_add_credits_nudge_email_maps_cooldown() -> Result<()>
```

**Purpose**: Verifies a backend 429 is treated as a cooldown status rather than a JSON-RPC error.

**Data flow**: Writes ChatGPT auth and base URL, mounts a POST nudge-email mock returning HTTP 429, starts the app server with `OPENAI_API_KEY` removed, sends the request, decodes `SendAddCreditsNudgeEmailResponse`, and asserts `status == CooldownActive`.

**Call relations**: This test covers a special backend-status mapping branch distinct from both success and generic failure.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 11 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, method (+1 more)).


##### `send_add_credits_nudge_email_surfaces_backend_failure`  (lines 426–475)

```
async fn send_add_credits_nudge_email_surfaces_backend_failure() -> Result<()>
```

**Purpose**: Ensures unexpected backend failure becomes an internal JSON-RPC error with no extra data.

**Data flow**: Writes ChatGPT auth and base URL, mounts a POST nudge-email mock returning 500 `boom`, starts the app server with `OPENAI_API_KEY` removed, sends the request, reads the error response, and asserts request id, internal-error code `-32603`, message containing `failed to notify workspace owner`, and `error.data == None`.

**Call relations**: Invoked directly by the test runner, this case covers generic backend failure propagation for the email RPC.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 11 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, timeout, method (+1 more)).


##### `login_with_api_key`  (lines 477–488)

```
async fn login_with_api_key(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: Logs into the app server with an API key and asserts the typed login response is `ApiKey`.

**Data flow**: Sends `send_login_account_api_key_request(api_key)`, waits for the corresponding response under `DEFAULT_READ_TIMEOUT`, converts it with `to_response`, asserts it equals `LoginAccountResponse::ApiKey {}`, and returns success.

**Call relations**: Used by the two chatgpt-auth-required tests to move the app server into API-key-authenticated-but-not-ChatGPT-authenticated state.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_login_account_api_key_request); called by 2 (get_account_rate_limits_requires_chatgpt_auth, send_add_credits_nudge_email_requires_chatgpt_auth); 4 external calls (Integer, to_response, assert_eq!, timeout).


##### `write_chatgpt_base_url`  (lines 490–493)

```
fn write_chatgpt_base_url(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config file pointing the app server at a mock ChatGPT backend.

**Data flow**: Builds `<codex_home>/config.toml` and writes a single line `chatgpt_base_url = "<base_url>"`.

**Call relations**: Positive and backend-interaction tests call this helper before initialization so requests go to the wiremock server.

*Call graph*: called by 4 (get_account_rate_limits_returns_snapshot, send_add_credits_nudge_email_maps_cooldown, send_add_credits_nudge_email_posts_expected_body, send_add_credits_nudge_email_surfaces_backend_failure); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/rate_limit_reset_credits.rs`

`test` · `request handling`

This module drives the reset-credit endpoint through `TestAppServer` with explicit auth setups. The negative auth test distinguishes two failure modes: no codex account auth at all, and API-key login without ChatGPT auth. The happy-path mapping test uses `chatgpt_test_context` to write file-based ChatGPT credentials and a `chatgpt_base_url`, then mounts multiple backend responses for `/api/codex/rate-limit-reset-credits/consume`. Each backend `code` (`reset`, `nothing_to_reset`, `no_credit`, `already_redeemed`) is expected to map to a specific `ConsumeAccountRateLimitResetCreditOutcome` in the typed response.

Validation coverage rejects an empty `idempotencyKey` with JSON-RPC invalid-request code `-32600`. Backend failure coverage returns HTTP 500 and expects an internal error `-32603` whose message contains `failed to consume rate limit reset`. The timeout test is especially important: it starts the app server with `OPENAI_API_KEY` cleared and a short request-timeout env var, mounts a delayed backend response, then issues a consume request followed immediately by `getAccount`. After the consume request times out with `rate limit reset consume timed out`, the queued account request must proceed and fail for its own reason (`email and plan type are required for chatgpt authentication`), proving the account-auth queue was released. Helpers wrap request sending, typed response decoding, error decoding, API-key login, and config writing.

#### Function details

##### `consume_rate_limit_reset_credit_requires_chatgpt_auth`  (lines 39–66)

```
async fn consume_rate_limit_reset_credit_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: Verifies reset-credit consumption requires both codex account auth and specifically ChatGPT auth.

**Data flow**: Creates temp codex home and initialized app server with `OPENAI_API_KEY` removed, sends a consume request with `idempotency_key = request-1`, reads the error, and asserts the codex-account-auth-required message. It then logs in with an API key, sends another consume request, reads the error again, and asserts the chatgpt-auth-required message.

**Call relations**: This top-level test uses `initialized_app_server`, `send_consume_reset_credit`, `read_error_response`, and `login_with_api_key` to cover two distinct auth gates in sequence.

*Call graph*: calls 4 internal fn (initialized_app_server, login_with_api_key, read_error_response, send_consume_reset_credit); 2 external calls (new, assert_eq!).


##### `consume_account_rate_limit_reset_credit_maps_backend_outcomes`  (lines 69–121)

```
async fn consume_account_rate_limit_reset_credit_maps_backend_outcomes() -> Result<()>
```

**Purpose**: Checks that backend outcome codes are translated into the correct typed protocol outcomes.

**Data flow**: Creates ChatGPT-authenticated temp context and mock server, mounts four POST mocks for `/api/codex/rate-limit-reset-credits/consume` keyed by different `redeem_request_id` values and backend `code` strings, initializes the app server, then loops over the cases calling `consume_reset_credit`. Each typed `ConsumeAccountRateLimitResetCreditResponse` is compared against the expected `ConsumeAccountRateLimitResetCreditOutcome`.

**Call relations**: Invoked by the test runner, this is the main happy-path mapping test. It depends on `chatgpt_test_context` for auth/config and on helper wrappers for request/response handling.

*Call graph*: calls 2 internal fn (chatgpt_test_context, initialized_app_server); 8 external calls (given, new, assert_eq!, json!, body_json, header, method, path).


##### `consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key`  (lines 124–140)

```
async fn consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key() -> Result<()>
```

**Purpose**: Ensures the RPC validates `idempotencyKey` locally and rejects an empty string.

**Data flow**: Creates ChatGPT-authenticated context and initialized app server, sends a consume request with `idempotency_key: ""`, reads the error response, and asserts invalid-request code `-32600` with message `idempotencyKey must not be empty`.

**Call relations**: This validation test is run directly and covers input checking before any backend POST is attempted.

*Call graph*: calls 3 internal fn (chatgpt_test_context, initialized_app_server, read_error_response); 2 external calls (new, assert_eq!).


##### `consume_account_rate_limit_reset_credit_surfaces_backend_failure`  (lines 143–165)

```
async fn consume_account_rate_limit_reset_credit_surfaces_backend_failure() -> Result<()>
```

**Purpose**: Verifies backend HTTP failure is surfaced as an internal JSON-RPC error.

**Data flow**: Creates ChatGPT-authenticated context, mounts a 500 `boom` response for the consume endpoint, initializes the app server, sends a consume request, reads the error response, and asserts internal-error code `-32603` plus a message containing `failed to consume rate limit reset`.

**Call relations**: This test is invoked directly to cover transport/backend failure mapping after auth and validation have succeeded.

*Call graph*: calls 4 internal fn (chatgpt_test_context, initialized_app_server, read_error_response, send_consume_reset_credit); 6 external calls (given, new, assert!, assert_eq!, method, path).


##### `consume_timeout_releases_account_auth_queue`  (lines 168–214)

```
async fn consume_timeout_releases_account_auth_queue() -> Result<()>
```

**Purpose**: Checks that a timed-out consume request does not permanently block later account-authenticated operations.

**Data flow**: Creates ChatGPT-authenticated context, mounts a delayed successful consume response, starts the app server with `OPENAI_API_KEY` unset and a short timeout env var, sends a consume request, then immediately sends `getAccount`. It waits for the consume request to fail with internal timeout `rate limit reset consume timed out`, then reads the queued account request’s own error and asserts it failed independently because required ChatGPT profile fields were missing.

**Call relations**: This top-level test exercises concurrency/serialization behavior around account-auth work. It uses `send_consume_reset_credit` and `read_error_response` to prove the queue is released after timeout.

*Call graph*: calls 4 internal fn (new_with_env, chatgpt_test_context, read_error_response, send_consume_reset_credit); 9 external calls (given, new, Integer, assert_eq!, json!, from_secs, timeout, method, path).


##### `chatgpt_test_context`  (lines 216–228)

```
async fn chatgpt_test_context() -> Result<(TempDir, MockServer)>
```

**Purpose**: Creates a temporary codex-home configured with file-based ChatGPT auth and a mock ChatGPT base URL.

**Data flow**: Creates a temp directory, writes ChatGPT auth with token `chatgpt-token`, account id `account-123`, and plan type `pro`, starts a `MockServer`, writes `chatgpt_base_url` pointing at that server, and returns both the temp dir and server.

**Call relations**: Most positive and backend-interaction tests call this helper to ensure the app server takes the ChatGPT-authenticated code path.

*Call graph*: calls 2 internal fn (new, write_chatgpt_base_url); called by 4 (consume_account_rate_limit_reset_credit_maps_backend_outcomes, consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key, consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_timeout_releases_account_auth_queue); 3 external calls (start, new, write_chatgpt_auth).


##### `initialized_app_server`  (lines 230–234)

```
async fn initialized_app_server(codex_home: &Path) -> Result<TestAppServer>
```

**Purpose**: Starts `TestAppServer` for these tests with `OPENAI_API_KEY` explicitly removed and waits for initialization.

**Data flow**: Constructs `TestAppServer::new_with_env` for the provided codex-home path with `OPENAI_API_KEY = None`, waits for `initialize()` under `DEFAULT_READ_TIMEOUT`, and returns the initialized server handle.

**Call relations**: Auth and backend tests call this helper so API-key ambient auth does not interfere with the intended credential path.

*Call graph*: calls 1 internal fn (new_with_env); called by 4 (consume_account_rate_limit_reset_credit_maps_backend_outcomes, consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key, consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_rate_limit_reset_credit_requires_chatgpt_auth); 1 external calls (timeout).


##### `consume_reset_credit`  (lines 236–242)

```
async fn consume_reset_credit(
    mcp: &mut TestAppServer,
    idempotency_key: &str,
) -> Result<ConsumeAccountRateLimitResetCreditResponse>
```

**Purpose**: Convenience wrapper that sends a consume request and decodes the typed success response.

**Data flow**: Accepts a mutable app-server handle and idempotency key, calls `send_consume_reset_credit` to obtain a request id, then calls `read_response` to deserialize `ConsumeAccountRateLimitResetCreditResponse`.

**Call relations**: The backend-outcome mapping test uses this helper to keep the loop concise and typed.

*Call graph*: calls 2 internal fn (read_response, send_consume_reset_credit).


##### `send_consume_reset_credit`  (lines 244–251)

```
async fn send_consume_reset_credit(mcp: &mut TestAppServer, idempotency_key: &str) -> Result<i64>
```

**Purpose**: Sends the raw consume-reset-credit JSON-RPC request and returns its numeric request id.

**Data flow**: Builds `ConsumeAccountRateLimitResetCreditParams` from the provided idempotency key string and forwards it to `send_consume_account_rate_limit_reset_credit_request`, returning the resulting request id.

**Call relations**: Called by both success and error-path helpers/tests whenever they need to issue the RPC without immediately decoding the response.

*Call graph*: calls 1 internal fn (send_consume_account_rate_limit_reset_credit_request); called by 4 (consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_rate_limit_reset_credit_requires_chatgpt_auth, consume_reset_credit, consume_timeout_releases_account_auth_queue).


##### `read_response`  (lines 253–263)

```
async fn read_response(mcp: &mut TestAppServer, request_id: i64) -> Result<T>
```

**Purpose**: Reads a successful JSON-RPC response for a request id and deserializes it into an arbitrary response type.

**Data flow**: Waits under `DEFAULT_READ_TIMEOUT` for `read_stream_until_response_message(RequestId::Integer(request_id))`, converts the `JSONRPCResponse` with `to_response`, and returns the typed value `T` where `T: DeserializeOwned`.

**Call relations**: Used by `consume_reset_credit` and `login_with_api_key` to share the common response-reading pattern.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); called by 1 (consume_reset_credit); 3 external calls (Integer, to_response, timeout).


##### `read_error_response`  (lines 265–272)

```
async fn read_error_response(mcp: &mut TestAppServer, request_id: i64) -> Result<JSONRPCError>
```

**Purpose**: Reads the error response corresponding to a request id under the standard timeout.

**Data flow**: Waits for `read_stream_until_error_message(RequestId::Integer(request_id))` under `DEFAULT_READ_TIMEOUT` and returns the resulting `JSONRPCError`.

**Call relations**: Negative tests call this helper after issuing requests expected to fail, including auth, validation, backend-failure, and timeout scenarios.

*Call graph*: calls 1 internal fn (read_stream_until_error_message); called by 4 (consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key, consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_rate_limit_reset_credit_requires_chatgpt_auth, consume_timeout_releases_account_auth_queue); 2 external calls (Integer, timeout).


##### `login_with_api_key`  (lines 274–281)

```
async fn login_with_api_key(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: Logs into the app server using an API key and asserts the login response is the API-key variant.

**Data flow**: Sends `send_login_account_api_key_request(api_key)`, reads the typed `LoginAccountResponse` via `read_response`, asserts it equals `LoginAccountResponse::ApiKey {}`, and returns success.

**Call relations**: Only the auth-gating test uses this helper to transition from no auth to API-key-only auth and verify the second, stricter ChatGPT requirement.

*Call graph*: calls 1 internal fn (send_login_account_api_key_request); called by 1 (consume_rate_limit_reset_credit_requires_chatgpt_auth); 1 external calls (assert_eq!).


##### `write_chatgpt_base_url`  (lines 283–288)

```
fn write_chatgpt_base_url(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal config file containing only `chatgpt_base_url`.

**Data flow**: Formats `chatgpt_base_url = "<base_url>"` and writes it to `<codex_home>/config.toml`.

**Call relations**: Called by `chatgpt_test_context` so backend-interaction tests point at the mock server.

*Call graph*: called by 1 (chatgpt_test_context); 3 external calls (join, format!, write).


### Initialization and configuration surfaces
These tests validate startup-time initialization behavior, strict config parsing, runtime config RPCs, and feature/config-derived capability exposure.

### `app-server/tests/suite/strict_config.rs`

`test` · `startup validation in subprocess integration test`

Unlike the other suites that talk to an already-running test harness, this file launches the real `codex-app-server` executable as a subprocess. It creates a temporary `CODEX_HOME`, writes a deliberately invalid `config.toml` containing only `foo = "bar"`, and invokes the binary with `--strict-config --listen off`. The test also points `CODEX_APP_SERVER_MANAGED_CONFIG_PATH` at a temp path so managed-config lookup is satisfied without needing a real file.

The assertion is intentionally black-box: it checks that the process exits unsuccessfully and that stderr contains the parser/validation message `unknown configuration field \`foo\``. That makes this file the regression test for strict schema enforcement at startup, independent of any in-process config builder behavior. Because it uses the compiled cargo binary and environment variables, it validates the exact CLI path users hit in production rather than only library-level parsing.

#### Function details

##### `strict_config_rejects_unknown_config_fields_for_standalone_app_server`  (lines 7–33)

```
fn strict_config_rejects_unknown_config_fields_for_standalone_app_server() -> Result<()>
```

**Purpose**: Launches the standalone app-server binary with an invalid config and asserts strict-config rejection. It proves unknown top-level TOML keys are fatal when `--strict-config` is enabled.

**Data flow**: Creates a temp codex-home directory, writes `config.toml` containing `foo = "bar"`, spawns `codex-app-server` via `Command::new(cargo_bin(...))` with `CODEX_HOME`, `CODEX_APP_SERVER_MANAGED_CONFIG_PATH`, and CLI args `--strict-config --listen off`, captures `output`, asserts the exit status is unsuccessful, decodes `stderr` as UTF-8, and asserts the stderr text contains `unknown configuration field `foo``.

**Call relations**: This is the file's only test and serves as a black-box startup regression check for the binary entrypoint rather than any helper or library API.

*Call graph*: 6 external calls (from_utf8, new, assert!, new, cargo_bin, write).


### `app-server/tests/suite/v2/initialize.rs`

`test` · `startup and initialization`

This file focuses on the app server's `initialize` behavior and a few downstream effects of initialization state. Several tests create a minimal mock-provider `config.toml`, start `TestAppServer`, and call either `initialize_with_client_info` or `initialize_with_capabilities`. They then inspect the returned `InitializeResponse` or initialization error to verify how the server derives its `user_agent` originator. The expected rules are explicit: a normal client such as `codex_vscode` becomes the originator prefix, but probe-like names such as `codex_app_server_daemon` and `codex-backend` do not override the default `codex_cli_rs`; an environment variable `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` supersedes both. The response also returns canonicalized `codex_home`, `platform_family`, and `platform_os`, which are asserted in the positive cases. Invalid `clientInfo.name` values containing illegal HTTP-header characters are rejected with JSON-RPC code `-32600` and a precise validation message.

The remaining tests show that initialization capabilities affect later traffic. `opt_out_notification_methods` can suppress notifications such as `thread/started` even while the corresponding request still succeeds. Finally, `turn_start_notify_payload_includes_initialize_client_name` configures a notify command that writes its payload to disk, initializes with client name `xcode`, runs a thread and turn, waits for the notify file to appear, and asserts the emitted JSON payload contains `"client": "xcode"`. Helper functions write the minimal config, optionally splice in extra TOML, and escape arbitrary strings as TOML basic strings.

#### Function details

##### `initialize_uses_client_info_name_as_originator`  (lines 30–63)

```
async fn initialize_uses_client_info_name_as_originator() -> Result<()>
```

**Purpose**: Verifies that a normal initialize client name becomes the originator prefix in the returned `user_agent` and that initialize also reports canonical home and platform information.

**Data flow**: It creates an empty mock responses server, a temp Codex home, computes the canonical expected `AbsolutePathBuf`, writes config via `create_config_toml`, starts `TestAppServer`, calls `initialize_with_client_info` with `ClientInfo { name: "codex_vscode", title: Some(...), version: "0.1.0" }`, pattern-matches the returned `JSONRPCMessage` as a response, deserializes `InitializeResponse`, and asserts `user_agent` starts with `codex_vscode/`, `codex_home` matches the canonical path, and platform family/OS match `std::env::consts`.

**Call relations**: This harness-invoked test uses `create_config_toml` for setup and `to_response` for decoding; it establishes the baseline originator-selection behavior that later tests compare against.

*Call graph*: calls 3 internal fn (new, create_config_toml, try_from); 7 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, timeout).


##### `initialize_probe_does_not_override_originator`  (lines 66–90)

```
async fn initialize_probe_does_not_override_originator() -> Result<()>
```

**Purpose**: Checks that the probe-like client name `codex_app_server_daemon` does not replace the default CLI originator in `user_agent`.

**Data flow**: It writes minimal config, starts the server, initializes with `ClientInfo` named `codex_app_server_daemon`, pattern-matches the initialize result as a response, deserializes `InitializeResponse`, and asserts `user_agent` starts with `codex_cli_rs/`.

**Call relations**: This test is a direct contrast with `initialize_uses_client_info_name_as_originator`, proving that some client names are intentionally ignored for originator purposes.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, timeout).


##### `initialize_codex_backend_does_not_override_originator`  (lines 93–117)

```
async fn initialize_codex_backend_does_not_override_originator() -> Result<()>
```

**Purpose**: Verifies that the special client name `codex-backend` also leaves the default CLI originator unchanged.

**Data flow**: It creates config and server state, initializes with `ClientInfo { name: "codex-backend", ... }`, requires a response message, deserializes `InitializeResponse`, and asserts the `user_agent` prefix is `codex_cli_rs/`.

**Call relations**: Like the daemon-name test, this function is a negative originator-override case and is invoked directly by the test harness.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, timeout).


##### `initialize_respects_originator_override_env_var`  (lines 120–160)

```
async fn initialize_respects_originator_override_env_var() -> Result<()>
```

**Purpose**: Checks that `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` takes precedence over the initialize client name when constructing `user_agent`.

**Data flow**: It creates a temp home and canonical expected path, writes config, starts `TestAppServer::new_with_env` with `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_originator_via_env_var`, initializes with client name `codex_vscode`, requires a response message, deserializes `InitializeResponse`, and asserts `user_agent` starts with `codex_originator_via_env_var/` while `codex_home` and platform fields still match expectations.

**Call relations**: This test extends the originator-selection matrix by adding environment override behavior on top of the baseline client-info path.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, try_from); 7 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, timeout).


##### `initialize_rejects_invalid_client_name`  (lines 163–195)

```
async fn initialize_rejects_invalid_client_name() -> Result<()>
```

**Purpose**: Ensures initialize rejects a `clientInfo.name` that is not a valid HTTP header value.

**Data flow**: It writes config, starts `TestAppServer::new_with_env` with the originator override explicitly unset, initializes with `ClientInfo { name: "bad\rname", ... }`, pattern-matches the returned `JSONRPCMessage` as an error, and asserts code `-32600`, the exact validation message naming the bad value, and `data == None`.

**Call relations**: This negative initialization test is invoked directly by the harness and validates input sanitization before any normal initialize response is produced.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 6 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout).


##### `initialize_opt_out_notification_methods_filters_notifications`  (lines 198–259)

```
async fn initialize_opt_out_notification_methods_filters_notifications() -> Result<()>
```

**Purpose**: Verifies that `opt_out_notification_methods` supplied during initialize suppresses matching notifications without breaking the underlying request flow.

**Data flow**: It writes config, starts the server, initializes with `InitializeCapabilities { experimental_api: true, request_attestation: false, opt_out_notification_methods: Some(vec!["thread/started"]) }` and a `codex_vscode` client, requires a response, then sends `thread/start`. It enters a loop reading messages until it finds the matching response for that request ID, failing immediately if a `thread/started` notification appears. After decoding `ThreadStartResponse`, it performs a short timeout waiting specifically for `thread/started` and asserts that timeout expires.

**Call relations**: This test is the main capability-driven downstream-behavior check in the file. It uses initialization state to alter later notification delivery and validates both the positive request response and the absence of the opted-out notification.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (new, new, bail!, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, from_millis, timeout (+1 more)).


##### `turn_start_notify_payload_includes_initialize_client_name`  (lines 262–336)

```
async fn turn_start_notify_payload_includes_initialize_client_name() -> Result<()>
```

**Purpose**: Checks that the client name supplied during initialize is propagated into the payload sent to configured notify commands during later turn execution.

**Data flow**: It creates a mock responses server with one final assistant message, a temp home, a `notify.json` output path, and resolves the `codex-app-server-test-notify-capture` helper binary path. It writes config via `create_config_toml_with_extra`, injecting a `notify = [binary, output_file]` setting with TOML-escaped strings, starts and initializes the server with client name `xcode`, starts a thread and a turn containing `V2UserInput::Text { text: "Hello" }`, waits for the turn response and `turn/completed`, waits for the notify file to appear, reads and parses its JSON contents, and asserts `payload["client"] == "xcode"`.

**Call relations**: This test combines initialization with later turn execution to prove initialize-time client identity is retained and surfaced to external notify hooks. It relies on `create_config_toml_with_extra` and `toml_basic_string` for setup.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_extra); 15 external calls (default, from_secs, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, cargo_bin, format! (+5 more)).


##### `create_config_toml`  (lines 339–345)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the standard minimal mock-provider config used by most initialization tests.

**Data flow**: It takes a Codex home path, server URI, and approval-policy string, and simply forwards those plus an empty extra-config string to `create_config_toml_with_extra`. It returns that helper's `std::io::Result<()>`.

**Call relations**: Most tests in this file call this wrapper when they need only the baseline config without any extra TOML sections.

*Call graph*: calls 1 internal fn (create_config_toml_with_extra); called by 6 (initialize_codex_backend_does_not_override_originator, initialize_opt_out_notification_methods_filters_notifications, initialize_probe_does_not_override_originator, initialize_rejects_invalid_client_name, initialize_respects_originator_override_env_var, initialize_uses_client_info_name_as_originator).


##### `create_config_toml_with_extra`  (lines 347–378)

```
fn create_config_toml_with_extra(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
    extra: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal `config.toml` for the mock provider while allowing arbitrary extra TOML to be inserted into the top-level config.

**Data flow**: It takes the Codex home path, server URI, approval-policy string, and extra TOML snippet, joins `config.toml`, formats a TOML document containing model settings, the supplied approval policy, the injected `extra` text, `[features] shell_snapshot = false`, and the mock provider endpoint/retry settings, then writes the file to disk.

**Call relations**: Both `create_config_toml` and the notify-payload test use this helper; it is the common config-writing primitive for the file.

*Call graph*: called by 2 (create_config_toml, turn_start_notify_payload_includes_initialize_client_name); 3 external calls (join, format!, write).


##### `toml_basic_string`  (lines 380–382)

```
fn toml_basic_string(value: &str) -> String
```

**Purpose**: Escapes a Rust string into a TOML basic string literal suitable for embedding paths or command arguments into generated config text.

**Data flow**: It takes an input `&str`, replaces backslashes with `\\` and double quotes with `\"`, wraps the result in surrounding quotes via `format!`, and returns the escaped `String`.

**Call relations**: Only `turn_start_notify_payload_includes_initialize_client_name` calls this helper when constructing the inline `notify = [...]` TOML array.

*Call graph*: 1 external calls (format!).


### `app-server/tests/suite/v2/config_rpc.rs`

`test` · `config load`

This file is an integration test suite for configuration-related JSON-RPC endpoints. It writes concrete TOML files into temporary CODEX_HOME directories, starts `TestAppServer`, initializes it, and then drives `config/read`, `config/requirements/read`, `config/value/write`, and `config/batch/write`. The tests assert not only effective `AppConfig` values but also origin tracking (`origins`) and optional layer listings (`layers`) using `ConfigLayerSource` variants such as `User`, `Project`, `LegacyManagedConfigTomlFromFile`, and `System`.

Read-path coverage includes scalar settings like `model`, nested tool config under `tools.web_search`, legacy and list forms of `forced_chatgpt_workspace_id`, app-specific approval settings under `[apps]`, arbitrary desktop settings preserved as JSON values, project-layer inclusion when a trusted cwd contains `.codex/config.toml`, and managed-config precedence over user config while still preserving user-only fields like `sandbox_mode` and `network_access`. Requirements reading specifically checks `allow_remote_control` from `requirements.toml`.

Write-path coverage includes replacing a single value, updating nested desktop keys, observing a pipelined read after a write, rejecting stale `expected_version` hashes with a structured error code, applying multiple edits atomically in a batch, and rejecting invalid edits that would touch legacy `profiles` tables. The helper assertions for layer ordering intentionally tolerate an optional MDM-managed layer at index 0, then verify the expected user/managed/system sequence.

#### Function details

##### `write_config`  (lines 44–49)

```
fn write_config(codex_home: &TempDir, contents: &str) -> Result<()>
```

**Purpose**: Writes raw TOML contents to `<codex_home>/config.toml` for test setup. It is the common fixture helper used by nearly every config RPC test.

**Data flow**: Accepts a `TempDir` and TOML string, joins `config.toml` onto the temp directory path, writes the provided contents with `std::fs::write`, and returns `Ok(())` or the underlying I/O error wrapped in `anyhow::Result`.

**Call relations**: Called by most tests in this file before starting `TestAppServer`. It provides the baseline user config that later read or write RPCs inspect and mutate.

*Call graph*: called by 17 (config_batch_write_applies_multiple_edits, config_batch_write_rejects_legacy_profile_tables, config_batch_write_updates_multiple_desktop_settings, config_read_accepts_forced_chatgpt_workspace_id_list, config_read_accepts_legacy_forced_chatgpt_workspace_id, config_read_after_pipelined_write_sees_written_value, config_read_ignores_bool_web_search_tool_config, config_read_includes_apps, config_read_includes_desktop_settings, config_read_includes_nested_web_search_tool_config (+7 more)); 2 external calls (path, write).


##### `config_requirements_read_includes_allow_remote_control`  (lines 52–76)

```
async fn config_requirements_read_includes_allow_remote_control() -> Result<()>
```

**Purpose**: Verifies `config/requirements/read` surfaces the managed requirements file and includes the `allow_remote_control` field. It checks the server maps `requirements.toml` into the RPC response shape.

**Data flow**: Creates a temp home, writes `requirements.toml` containing `allow_remote_control = false`, starts and initializes `TestAppServer`, sends the requirements-read request, waits for the matching response, deserializes it to `ConfigRequirementsReadResponse`, and asserts `requirements.allow_remote_control == Some(false)`.

**Call relations**: Invoked by the test harness as a focused requirements-read test. It uses the standard request/response pattern and does not depend on any of the config-layer helper assertions.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


##### `config_read_returns_effective_and_layers`  (lines 79–123)

```
async fn config_read_returns_effective_and_layers() -> Result<()>
```

**Purpose**: Checks that `config/read` returns effective config values, origin metadata, and layer ordering for a simple user config. It validates both the merged config and the provenance information.

**Data flow**: Writes a user `config.toml` with `model` and `sandbox_mode`, canonicalizes the path into an `AbsolutePathBuf`, starts the server, sends `ConfigReadParams { include_layers: true, cwd: None }`, deserializes `ConfigReadResponse`, asserts `config.model == Some("gpt-user")`, asserts the `model` origin is `ConfigLayerSource::User { file: user_file, profile: None }`, extracts `layers`, and passes them to `assert_layers_user_then_optional_system`.

**Call relations**: Called by the harness. It uses `write_config` for setup and delegates layer-order validation to `assert_layers_user_then_optional_system` after checking a concrete origin entry.

*Call graph*: calls 4 internal fn (new, assert_layers_user_then_optional_system, write_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_tools`  (lines 126–196)

```
async fn config_read_includes_tools() -> Result<()>
```

**Purpose**: Verifies nested tool configuration under `[tools.web_search]` is returned in typed form and that origins are tracked down to nested fields and array elements. It also checks layer ordering.

**Data flow**: Writes config containing `model` plus `[tools.web_search] context_size` and `allowed_domains`, computes the user config path, starts the server, sends `config/read` with layers enabled, deserializes `ConfigReadResponse`, extracts `config.tools`, and asserts it equals `ToolsV2 { web_search: Some(WebSearchToolConfig { context_size: Some(Low), allowed_domains: Some(["example.com"]), location: None }) }`. It then asserts origins for `tools.web_search.context_size` and `tools.web_search.allowed_domains.0` point to the user layer and validates layer ordering.

**Call relations**: Invoked by the test harness. It extends the basic config-read test by checking nested typed decoding and fine-grained origin paths, then reuses `assert_layers_user_then_optional_system`.

*Call graph*: calls 4 internal fn (new, assert_layers_user_then_optional_system, write_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_accepts_legacy_forced_chatgpt_workspace_id`  (lines 199–234)

```
async fn config_read_accepts_legacy_forced_chatgpt_workspace_id() -> Result<()>
```

**Purpose**: Checks that the legacy scalar form of `forced_chatgpt_workspace_id` is still accepted and normalized into the protocol enum. This preserves backward compatibility for older config files.

**Data flow**: Writes config with `forced_chatgpt_workspace_id = "<uuid>"`, starts and initializes the server, sends `config/read` without layers, deserializes `ConfigReadResponse`, and asserts `config.forced_chatgpt_workspace_id == Some(ForcedChatgptWorkspaceIds::Single(...))`.

**Call relations**: Run by the harness as a compatibility test. It uses `write_config` for setup and only inspects the effective config value, not origins or layers.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, format!, timeout).


##### `config_read_accepts_forced_chatgpt_workspace_id_list`  (lines 237–276)

```
async fn config_read_accepts_forced_chatgpt_workspace_id_list() -> Result<()>
```

**Purpose**: Verifies the list form of `forced_chatgpt_workspace_id` is accepted and returned as the multi-value enum variant. It complements the legacy scalar compatibility test.

**Data flow**: Writes config with `forced_chatgpt_workspace_id = ["uuid-a", "uuid-b"]`, starts the server, sends `config/read`, deserializes the response, and asserts the field equals `Some(ForcedChatgptWorkspaceIds::Multiple(vec![...]))`.

**Call relations**: Invoked by the test harness. It follows the same simple read path as the scalar compatibility test but checks the multi-value normalization branch.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, format!, timeout).


##### `config_read_includes_nested_web_search_tool_config`  (lines 279–324)

```
async fn config_read_includes_nested_web_search_tool_config() -> Result<()>
```

**Purpose**: Checks that a richer nested web-search tool config, including location fields, is decoded into the typed protocol structure. It ensures nested object values survive the config-read translation.

**Data flow**: Writes config with top-level `web_search = "live"` and `[tools.web_search]` containing `context_size`, `allowed_domains`, and an inline `location` table, starts the server, sends `config/read`, deserializes `ConfigReadResponse`, and asserts `config.tools.web_search` equals a `WebSearchToolConfig` with `High` context size, one allowed domain, and a `WebSearchLocation` containing country, city, and timezone.

**Call relations**: Called by the harness as a read-path decoding test. It uses `write_config` and validates only the effective typed config, not origins.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_ignores_bool_web_search_tool_config`  (lines 327–356)

```
async fn config_read_ignores_bool_web_search_tool_config() -> Result<()>
```

**Purpose**: Verifies that an old boolean-shaped `[tools] web_search = true` entry is ignored rather than misinterpreted as structured tool config. This protects the typed RPC surface from malformed legacy values.

**Data flow**: Writes config with `[tools] web_search = true`, starts the server, sends `config/read`, deserializes the response, and asserts `config.tools.expect(...).web_search == None`.

**Call relations**: Invoked by the test harness as a compatibility/robustness check. It confirms the server drops unsupported boolean tool config instead of producing partial typed data.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_apps`  (lines 359–472)

```
async fn config_read_includes_apps() -> Result<()>
```

**Purpose**: Checks that `[apps]` and `[apps._default]` TOML sections are returned as typed app configuration, with origins recorded for nested app fields and layer ordering preserved. It validates both defaults and per-app overrides.

**Data flow**: Writes config defining `_default.approvals_reviewer` and an `app1` entry with `enabled`, `approvals_reviewer`, `destructive_enabled`, and `default_tools_approval_mode`, computes the user config path, starts the server, sends `config/read` with layers enabled, deserializes `ConfigReadResponse`, and asserts `config.apps` equals an `AppsConfig` containing the expected `AppsDefaultConfig` and `AppConfig`. It then checks origins for several nested keys under `apps._default` and `apps.app1`, extracts `layers`, and validates ordering with `assert_layers_user_then_optional_system`.

**Call relations**: Run by the harness. It combines the effective-config assertions of the simpler read tests with the origin/layer checks used elsewhere in the file.

*Call graph*: calls 4 internal fn (new, assert_layers_user_then_optional_system, write_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_desktop_settings`  (lines 475–518)

```
async fn config_read_includes_desktop_settings() -> Result<()>
```

**Purpose**: Verifies arbitrary desktop settings are surfaced as JSON values under `config.desktop`, preserving mixed key styles and nested objects. It ensures the RPC does not discard UI-specific config sections.

**Data flow**: Writes config with `[desktop]` keys `appearanceTheme` and `selected-avatar-id` plus nested `[desktop.workspace]`, starts the server, sends `config/read`, deserializes the response, extracts `config.desktop`, and asserts the expected JSON values for the top-level keys and nested `workspace` object.

**Call relations**: Invoked by the test harness as a read-path test for untyped desktop settings. It uses `write_config` and inspects only the effective config payload.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_project_layers_for_cwd`  (lines 521–564)

```
async fn config_read_includes_project_layers_for_cwd() -> Result<()>
```

**Purpose**: Checks that when a trusted workspace cwd contains `.codex/config.toml`, `config/read` includes that project layer and attributes overridden values to `ConfigLayerSource::Project`. It validates cwd-sensitive config resolution.

**Data flow**: Writes a user config with `model`, creates a separate workspace temp dir with `.codex/config.toml` containing `model_reasoning_effort = "high"`, marks the workspace trusted via `set_project_trust_level`, converts the `.codex` path to `AbsolutePathBuf`, starts the server, sends `config/read` with `cwd` set to the workspace path and `include_layers: true`, deserializes the response, and asserts `config.model_reasoning_effort == Some(ReasoningEffort::High)` with origin `ConfigLayerSource::Project { dot_codex_folder: project_config }`.

**Call relations**: Called by the harness. It is the only test in this file that depends on trust state and cwd, using `set_project_trust_level` during setup to make the project layer eligible.

*Call graph*: calls 4 internal fn (new, write_config, set_project_trust_level, try_from); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `config_read_includes_system_layer_and_overrides`  (lines 567–690)

```
async fn config_read_includes_system_layer_and_overrides() -> Result<()>
```

**Purpose**: Verifies managed config loaded from a file overrides user config where appropriate, while user-only fields still win for keys absent from managed config. It also checks origins and layer ordering across managed, user, and system layers.

**Data flow**: Writes a user config with `model`, `approval_policy`, `sandbox_mode`, and `sandbox_workspace_write` settings using a test path helper for platform-specific roots; writes a separate managed config file overriding `model`, `approval_policy`, and `sandbox_workspace_write.writable_roots`; starts `TestAppServer::new_with_env` with `CODEX_APP_SERVER_MANAGED_CONFIG_PATH` pointing to that file; sends `config/read` with layers enabled; deserializes `ConfigReadResponse`; asserts effective values and origins for `model`, `approval_policy`, `sandbox_mode`, `sandbox_workspace_write.writable_roots.0`, and `sandbox_workspace_write.network_access`; then validates layer ordering with `assert_layers_managed_user_then_optional_system`.

**Call relations**: Invoked by the harness as the most comprehensive layer-precedence test. It uses `write_config` for the user layer, manual file writing for the managed layer, and delegates final layer-order checks to `assert_layers_managed_user_then_optional_system`.

*Call graph*: calls 4 internal fn (new_with_env, assert_layers_managed_user_then_optional_system, write_config, try_from); 9 external calls (new, Integer, test_path_buf_with_windows, to_response, assert!, assert_eq!, format!, write, timeout).


##### `config_value_write_replaces_value`  (lines 693–756)

```
async fn config_value_write_replaces_value() -> Result<()>
```

**Purpose**: Checks that `config/value/write` can replace a scalar key, returns the written file path, and respects optimistic concurrency when given the current version. It then verifies the new value is visible through a subsequent read.

**Data flow**: Writes `model = "gpt-old"`, starts the server, performs an initial `config/read` to capture the current origin version for `model`, sends `ConfigValueWriteParams` targeting `key_path = "model"` with `value = "gpt-new"`, `merge_strategy = Replace`, and `expected_version` from the read, deserializes `ConfigWriteResponse`, asserts `status == WriteStatus::Ok`, `file_path` resolves to `<codex_home>/config.toml`, and `overridden_metadata` is `None`, then performs another `config/read` and asserts `config.model == Some("gpt-new")`.

**Call relations**: Run by the harness as a write-path success test. It uses a read-before-write to obtain the version token and a read-after-write to confirm persistence through the server’s config reload path.

*Call graph*: calls 3 internal fn (new, write_config, resolve_path_against_base); 7 external calls (new, Integer, to_response, assert!, assert_eq!, json!, timeout).


##### `config_value_write_updates_desktop_settings`  (lines 759–800)

```
async fn config_value_write_updates_desktop_settings() -> Result<()>
```

**Purpose**: Verifies `config/value/write` can create or update nested desktop settings addressed by dotted key path. It ensures desktop JSON-like config is writable through the RPC.

**Data flow**: Starts from an empty config file, initializes the server, sends `ConfigValueWriteParams` with `key_path = "desktop.appearanceTheme"` and JSON value `"dark"`, deserializes `ConfigWriteResponse`, asserts success, then reads config back and asserts `config.desktop["appearanceTheme"] == "dark"`.

**Call relations**: Invoked by the harness. It is the desktop-settings write counterpart to the desktop read test and uses the same effective-config verification pattern after the write.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, json!, timeout).


##### `config_read_after_pipelined_write_sees_written_value`  (lines 803–849)

```
async fn config_read_after_pipelined_write_sees_written_value() -> Result<()>
```

**Purpose**: Checks that a read request sent immediately after a write request still observes the written value once both responses are processed. It validates request pipelining and internal config reload ordering.

**Data flow**: Writes `model = "gpt-old"`, starts the server, sends a `config/value/write` changing `model` to `gpt-new`, immediately sends a `config/read`, then reads the write response first and asserts success, reads the read response second, deserializes it to `ConfigReadResponse`, and asserts `config.model == Some("gpt-new")`.

**Call relations**: Called by the harness as a sequencing test. It intentionally overlaps requests to prove the server serializes write effects before fulfilling the subsequent read.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, json!, timeout).


##### `config_value_write_rejects_version_conflict`  (lines 852–888)

```
async fn config_value_write_rejects_version_conflict() -> Result<()>
```

**Purpose**: Verifies stale `expected_version` values are rejected with a structured config write error code. It tests optimistic concurrency failure handling.

**Data flow**: Writes `model = "gpt-old"`, starts the server, sends `ConfigValueWriteParams` with explicit `file_path`, `key_path = "model"`, new value `"gpt-new"`, and `expected_version = Some("sha256:stale")`, then reads the resulting `JSONRPCError`. It extracts `config_write_error_code` from `error.data` and asserts it equals `Some("configVersionConflict")`.

**Call relations**: Invoked by the harness as the negative counterpart to the successful value-write test. It stops at the error response and inspects structured error metadata rather than message text alone.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, assert_eq!, json!, timeout).


##### `config_batch_write_applies_multiple_edits`  (lines 891–954)

```
async fn config_batch_write_applies_multiple_edits() -> Result<()>
```

**Purpose**: Checks that `config/batch/write` applies multiple edits to one file atomically and returns the written file path. It verifies both top-level and nested sandbox settings after the batch.

**Data flow**: Starts from an empty config, creates a temporary writable-root path, sends `ConfigBatchWriteParams` with two `ConfigEdit`s: one replacing `sandbox_mode` with `workspace-write` and one replacing `sandbox_workspace_write` with an object containing `writable_roots` and `network_access: false`. After deserializing `ConfigWriteResponse` and asserting success plus expected file path, it performs `config/read` and asserts `config.sandbox_mode == Some(WorkspaceWrite)` and the nested sandbox config matches the batch values.

**Call relations**: Run by the harness as the main batch-write success test. It uses `test_tmp_path_buf` to generate a platform-safe path and then verifies the merged config through a follow-up read.

*Call graph*: calls 3 internal fn (new, write_config, resolve_path_against_base); 8 external calls (new, Integer, test_tmp_path_buf, to_response, assert!, assert_eq!, timeout, vec!).


##### `config_batch_write_rejects_legacy_profile_tables`  (lines 957–1016)

```
async fn config_batch_write_rejects_legacy_profile_tables() -> Result<()>
```

**Purpose**: Verifies batch writes that would touch legacy `profiles` tables are rejected as validation errors and do not partially modify the file. It checks both the RPC error code and on-disk rollback behavior.

**Data flow**: Writes a config containing `[profiles."team.prod"] model = "gpt-5.3-spark"`, starts the server, sends a batch write with one edit targeting `profiles."team.prod".model` and another creating `items.sample@catalog.enabled`, then reads the `JSONRPCError`. It extracts `config_write_error_code` and asserts `configValidationError`, asserts the message mentions ``profiles``, then rereads the TOML file from disk and asserts the original profile model remains unchanged and no `items` table was written.

**Call relations**: Invoked by the harness as a negative batch-write test. It combines RPC-level validation assertions with direct file inspection to prove the failed batch was not partially applied.

*Call graph*: calls 2 internal fn (new, write_config); 8 external calls (new, Integer, assert!, assert_eq!, read_to_string, timeout, from_str, vec!).


##### `config_batch_write_updates_multiple_desktop_settings`  (lines 1019–1080)

```
async fn config_batch_write_updates_multiple_desktop_settings() -> Result<()>
```

**Purpose**: Checks that batch writes can update multiple desktop settings in one request, including both scalar and nested object values. It is the desktop-specific counterpart to the sandbox batch-write test.

**Data flow**: Starts from an empty config, sends `ConfigBatchWriteParams` with edits for `desktop.selected-avatar-id = "codex"` and `desktop.workspace = { collapsed = true, width = 320 }`, deserializes `ConfigWriteResponse`, asserts success, then reads config back and asserts the desktop JSON contains both updated values.

**Call relations**: Called by the harness. It reuses the batch-write/read-back pattern but targets the untyped desktop settings subtree instead of typed sandbox config.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, timeout, vec!).


##### `assert_layers_user_then_optional_system`  (lines 1082–1106)

```
fn assert_layers_user_then_optional_system(
    layers: &[codex_app_server_protocol::ConfigLayer],
    user_file: AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Asserts that the returned config layers consist of an optional MDM-managed layer followed by the user layer and then a system layer. It encapsulates the expected ordering for simple user-config reads.

**Data flow**: Accepts a slice of `ConfigLayer` and the expected user config path, computes an offset of 1 if the first layer is `LegacyManagedConfigTomlFromMdm`, asserts the total length is `offset + 2`, asserts `layers[offset].name` is `ConfigLayerSource::User { file: user_file, profile: None }`, and asserts `layers[offset + 1].name` matches `ConfigLayerSource::System { .. }`.

**Call relations**: Used by the basic config-read, tools, and apps tests after they request layers. It centralizes the optional-MDM tolerance so those tests can focus on their specific config assertions.

*Call graph*: called by 3 (config_read_includes_apps, config_read_includes_tools, config_read_returns_effective_and_layers); 3 external calls (assert!, assert_eq!, matches!).


##### `assert_layers_managed_user_then_optional_system`  (lines 1108–1137)

```
fn assert_layers_managed_user_then_optional_system(
    layers: &[codex_app_server_protocol::ConfigLayer],
    managed_file: AbsolutePathBuf,
    user_file: AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Asserts that the returned config layers consist of an optional MDM-managed layer, then a managed-config file layer, then the user layer, then a system layer. It captures the expected ordering when a legacy managed config file is present.

**Data flow**: Accepts a slice of `ConfigLayer`, the expected managed file path, and the expected user file path, computes an offset if the first layer is `LegacyManagedConfigTomlFromMdm`, asserts the total length is `offset + 3`, asserts the next layers are `LegacyManagedConfigTomlFromFile { file: managed_file }` and `User { file: user_file, profile: None }`, and finally asserts the last layer matches `System { .. }`.

**Call relations**: Called only by `config_read_includes_system_layer_and_overrides`. It packages the layer-order invariant for the managed-config precedence scenario.

*Call graph*: called by 1 (config_read_includes_system_layer_and_overrides); 3 external calls (assert!, assert_eq!, matches!).


### `app-server/tests/suite/v2/experimental_feature_list.rs`

`test` · `request handling and config mutation`

This file tests two related RPC families: listing experimental features and mutating their enablement. The listing tests compare server output against the canonical `codex_features::FEATURES` registry, translating each internal `Stage` into the protocol-level `ExperimentalFeatureStage` and checking that display name, description, announcement, current enabled state, and `default_enabled` are surfaced correctly. One test uses ChatGPT auth plus a mocked `/backend-api/accounts/.../settings` endpoint to prove workspace policy can force `apps` and `plugins` disabled even when they are default-enabled. Another starts a thread rooted in a trusted workspace containing `.codex/config.toml` with `[features] memories = true`, then requests the feature list with that `thread_id` to verify thread-scoped project config resolution.

The second half validates `experimentalFeature/enablement/set`. These tests show that enablement updates are reflected in subsequent `config/read` responses for both global and cwd-specific reads, do not override explicit user config values, update only named features while preserving prior toggles, accept `remote_control`, treat an empty map as a no-op, and silently ignore invalid or non-remotely-controllable feature names. Small async helpers keep the protocol mechanics uniform: `set_experimental_feature_enablement` sends the mutation request and decodes the typed response, `read_config` does the same for `config/read`, and generic `read_response<T>` wraps timeout, request-ID matching, and `to_response` deserialization.

#### Function details

##### `experimental_feature_list_returns_feature_metadata_with_stage`  (lines 43–102)

```
async fn experimental_feature_list_returns_feature_metadata_with_stage() -> Result<()>
```

**Purpose**: Checks that `experimentalFeature/list` returns one entry per registered feature with the correct stage mapping and metadata fields.

**Data flow**: It builds a `ConfigBuilder` rooted at a temp home with a managed-config override path, starts `TestAppServer`, initializes it, sends `ExperimentalFeatureListParams::default()`, and decodes the response via `read_response::<ExperimentalFeatureListResponse>`. It then derives an expected `Vec<ExperimentalFeature>` by iterating `FEATURES`, mapping each internal `Stage` variant to protocol fields and reading current enablement from `config.features.enabled(spec.id)`, wraps that in `ExperimentalFeatureListResponse`, and asserts equality with the actual response.

**Call relations**: This test is a direct harness entrypoint. It does not use the file's config-read helper path; instead it computes the expected list from the feature registry and compares it against the server's list response.

*Call graph*: calls 2 internal fn (new, with_managed_config_path_for_tests); 5 external calls (new, default, assert_eq!, default, timeout).


##### `experimental_feature_list_marks_apps_and_plugins_disabled_by_workspace_policy`  (lines 105–160)

```
async fn experimental_feature_list_marks_apps_and_plugins_disabled_by_workspace_policy() -> Result<()>
```

**Purpose**: Verifies that workspace policy fetched from the ChatGPT backend can mark `apps` and `plugins` disabled in the feature list even when they are default-enabled.

**Data flow**: It writes a minimal config containing `chatgpt_base_url`, stores ChatGPT auth credentials with account identifiers, mounts a wiremock GET handler for `/backend-api/accounts/account-123/settings` returning `enable_plugins: false`, starts `TestAppServer::new_without_managed_config`, initializes it, requests the feature list, and extracts the `apps` and `plugins` entries from the returned `data`. It asserts both are disabled while their `default_enabled` flags remain true.

**Call relations**: Invoked by the test runner, it is the only test in this file that exercises remote workspace-policy lookup. After setup through wiremock and auth helpers, it uses `read_response` to decode the list and then performs targeted assertions on two named features.

*Call graph*: calls 2 internal fn (new, new_without_managed_config); 13 external calls (given, start, new, new, default, write_chatgpt_auth, assert!, format!, write, timeout (+3 more)).


##### `experimental_feature_list_resolves_thread_project_config`  (lines 163–227)

```
async fn experimental_feature_list_resolves_thread_project_config() -> Result<()>
```

**Purpose**: Shows that feature listing can be resolved in the context of a specific thread and therefore picks up project-local `.codex/config.toml` feature overrides.

**Data flow**: It creates a mock responses server, writes a user config that trusts a temporary workspace path and points at the mock provider, writes `.codex/config.toml` inside that workspace with `[features] memories = true`, starts the server without managed config, initializes it, and starts a thread with `cwd` set to the workspace. After decoding `ThreadStartResponse`, it sends `ExperimentalFeatureListParams` with `thread_id: Some(thread.id)`, decodes the list response, finds the `memories` feature, and asserts `enabled` is true.

**Call relations**: The test harness calls it directly. It first drives thread creation so the later feature-list request can be scoped by thread ID, then uses `read_response` for both the thread-start and feature-list responses.

*Call graph*: calls 1 internal fn (new_without_managed_config); 8 external calls (default, new, create_mock_responses_server_repeating_assistant, assert!, format!, create_dir_all, write, timeout).


##### `experimental_feature_list_rejects_unknown_thread_id`  (lines 230–258)

```
async fn experimental_feature_list_rejects_unknown_thread_id() -> Result<()>
```

**Purpose**: Confirms that requesting a thread-scoped feature list for a nonexistent thread ID yields an invalid-request error rather than silently falling back to global config.

**Data flow**: It starts and initializes a fresh `TestAppServer`, sends `ExperimentalFeatureListParams` with a hard-coded unknown UUID-like `thread_id`, waits for the error response for that request ID, destructures the `JSONRPCError`, and asserts code `-32600` plus an error message containing `thread not found: ...`.

**Call relations**: This negative test is entered by the harness and directly exercises the server's thread lookup path before any helper-based response decoding occurs.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `experimental_feature_enablement_set_applies_to_global_and_thread_config_reads`  (lines 261–295)

```
async fn experimental_feature_enablement_set_applies_to_global_and_thread_config_reads() -> Result<()>
```

**Purpose**: Verifies that remotely set experimental feature enablement is reflected in both global config reads and cwd-specific config reads.

**Data flow**: It creates a temp home and a project subdirectory, initializes `TestAppServer`, calls `set_experimental_feature_enablement` with a one-entry `BTreeMap` enabling `auth_elicitation`, and asserts the typed response echoes that map. It then loops over `cwd = None` and `Some(project path string)`, calls `read_config`, and checks `config.additional["features"]["auth_elicitation"] == true` in each returned `ConfigReadResponse`.

**Call relations**: This test orchestrates the two local helpers: it first mutates feature enablement through `set_experimental_feature_enablement`, then validates persistence through repeated `read_config` calls.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 5 external calls (from, new, assert_eq!, create_dir_all, timeout).


##### `experimental_feature_enablement_set_does_not_override_user_config`  (lines 298–330)

```
async fn experimental_feature_enablement_set_does_not_override_user_config() -> Result<()>
```

**Purpose**: Ensures runtime experimental enablement does not supersede an explicit user-configured feature value in `config.toml`.

**Data flow**: It writes a user config with `[features] memories = false`, initializes the server, calls `set_experimental_feature_enablement` requesting `memories = true`, asserts the response echoes that request, then calls `read_config(None)` and inspects `config.additional` to confirm the effective `memories` value remains `false`.

**Call relations**: The test runner invokes it directly. It uses the same helper pair as the previous test, but the key assertion is that config-read precedence favors explicit user config over remotely stored experimental enablement.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 5 external calls (from, new, assert_eq!, write, timeout).


##### `experimental_feature_enablement_set_only_updates_named_features`  (lines 333–405)

```
async fn experimental_feature_enablement_set_only_updates_named_features() -> Result<()>
```

**Purpose**: Checks that a later enablement-set call updates only the provided feature names and leaves previously stored feature toggles intact.

**Data flow**: After initialization, it first calls `set_experimental_feature_enablement` with `mentions_v2 = true`, then calls it again with a four-entry map for `auth_elicitation`, `memories`, `remote_plugin`, and `tool_suggest`. It asserts the second response contains only the second call's map, then reads config and verifies all five feature values are present with the expected booleans, including the earlier `mentions_v2` setting.

**Call relations**: This test chains two calls to `set_experimental_feature_enablement` before validating the merged persisted state through `read_config`, demonstrating incremental rather than wholesale replacement semantics.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 4 external calls (from, new, assert_eq!, timeout).


##### `experimental_feature_enablement_set_allows_remote_control`  (lines 408–423)

```
async fn experimental_feature_enablement_set_allows_remote_control() -> Result<()>
```

**Purpose**: Verifies that `remote_control` is among the features accepted by the remote enablement API.

**Data flow**: It initializes the server, constructs a `BTreeMap` with `remote_control` set to `false`, sends it through `set_experimental_feature_enablement`, and asserts the typed response exactly echoes the same map.

**Call relations**: This is a narrow positive test around the helper `set_experimental_feature_enablement`, confirming that this specific feature name is not filtered out as invalid.

*Call graph*: calls 2 internal fn (new, set_experimental_feature_enablement); 4 external calls (from, new, assert_eq!, timeout).


##### `experimental_feature_enablement_set_empty_map_is_no_op`  (lines 426–456)

```
async fn experimental_feature_enablement_set_empty_map_is_no_op() -> Result<()>
```

**Purpose**: Shows that sending an empty enablement map does not clear previously stored feature toggles.

**Data flow**: It initializes the server, first enables `mentions_v2` through `set_experimental_feature_enablement`, then calls the same helper with `BTreeMap::new()`. It asserts the response contains an empty map and then reads config to confirm `mentions_v2` is still `true` in `config.additional.features`.

**Call relations**: The test uses the mutation helper twice and then `read_config` to prove that an empty update request is treated as a no-op rather than a reset.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 5 external calls (from, new, new, assert_eq!, timeout).


##### `experimental_feature_enablement_set_ignores_invalid_features`  (lines 459–486)

```
async fn experimental_feature_enablement_set_ignores_invalid_features() -> Result<()>
```

**Purpose**: Confirms that the server filters out invalid or non-remotely-settable feature names and returns only the accepted subset.

**Data flow**: It initializes the server, sends a `BTreeMap` containing several names such as `apps`, `connectors`, `plugins`, `unknown_feature`, and one valid remotely settable feature `auth_elicitation = true`, then asserts the typed response contains only `auth_elicitation`.

**Call relations**: This negative/positive mix test is a direct consumer of `set_experimental_feature_enablement`; it validates the server-side filtering behavior solely through the returned response payload.

*Call graph*: calls 2 internal fn (new, set_experimental_feature_enablement); 4 external calls (from, new, assert_eq!, timeout).


##### `set_experimental_feature_enablement`  (lines 488–498)

```
async fn set_experimental_feature_enablement(
    mcp: &mut TestAppServer,
    enablement: BTreeMap<String, bool>,
) -> Result<ExperimentalFeatureEnablementSetResponse>
```

**Purpose**: Sends an `experimentalFeature/enablement/set` request and decodes the typed response.

**Data flow**: It takes a mutable `TestAppServer` reference and a `BTreeMap<String, bool>` enablement map, sends `ExperimentalFeatureEnablementSetParams { enablement }`, awaits the returned request ID, and passes that ID into `read_response` to deserialize an `ExperimentalFeatureEnablementSetResponse`. It returns that typed response or propagates transport/deserialization errors.

**Call relations**: All enablement-set tests call this helper instead of repeating request/timeout/deserialize boilerplate. It delegates the common response-reading mechanics to `read_response`.

*Call graph*: calls 2 internal fn (send_experimental_feature_enablement_set_request, read_response); called by 6 (experimental_feature_enablement_set_allows_remote_control, experimental_feature_enablement_set_applies_to_global_and_thread_config_reads, experimental_feature_enablement_set_does_not_override_user_config, experimental_feature_enablement_set_empty_map_is_no_op, experimental_feature_enablement_set_ignores_invalid_features, experimental_feature_enablement_set_only_updates_named_features).


##### `read_config`  (lines 500–508)

```
async fn read_config(mcp: &mut TestAppServer, cwd: Option<String>) -> Result<ConfigReadResponse>
```

**Purpose**: Issues a `config/read` request for an optional cwd and returns the typed config payload.

**Data flow**: It accepts a mutable `TestAppServer` and an optional cwd string, sends `ConfigReadParams { include_layers: false, cwd }`, obtains the request ID, and forwards it to `read_response` to deserialize a `ConfigReadResponse`.

**Call relations**: The config-validation tests call this helper after mutating feature enablement. It is a thin wrapper over `read_response` specialized to the `config/read` method.

*Call graph*: calls 2 internal fn (send_config_read_request, read_response); called by 4 (experimental_feature_enablement_set_applies_to_global_and_thread_config_reads, experimental_feature_enablement_set_does_not_override_user_config, experimental_feature_enablement_set_empty_map_is_no_op, experimental_feature_enablement_set_only_updates_named_features).


##### `read_response`  (lines 510–517)

```
async fn read_response(mcp: &mut TestAppServer, request_id: i64) -> Result<T>
```

**Purpose**: Provides the shared timeout, request-ID matching, and `to_response` deserialization path for typed JSON-RPC responses in this file.

**Data flow**: It takes a mutable `TestAppServer` and numeric request ID, waits up to `DEFAULT_TIMEOUT` for `read_stream_until_response_message(RequestId::Integer(request_id))`, then converts the resulting `JSONRPCResponse` into generic type `T: DeserializeOwned` using `to_response`. It returns the typed value or propagates timeout, stream, or deserialization errors.

**Call relations**: Both `set_experimental_feature_enablement` and `read_config` delegate to this helper, making it the common terminal step for most request/response interactions in the file.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); called by 2 (read_config, set_experimental_feature_enablement); 3 external calls (Integer, to_response, timeout).


### `app-server/tests/suite/v2/model_provider_capabilities_read.rs`

`test` · `request handling`

This file contains two focused integration tests around provider capability discovery. Each test creates an isolated `TempDir` as `codex_home`, starts `TestAppServer`, initializes it under a timeout, sends `ModelProviderCapabilitiesReadParams {}` through the JSON-RPC transport, and deserializes the resulting `JSONRPCResponse` into `ModelProviderCapabilitiesReadResponse` with `to_response`.

The default-path test relies on an empty home directory, so the server uses its normal provider selection and should report all three capabilities enabled: `namespace_tools`, `image_generation`, and `web_search`. The Bedrock-specific test writes a minimal `config.toml` containing `model_provider = "amazon-bedrock"` before startup; that changes only the expected capability matrix, leaving `namespace_tools` enabled while disabling `image_generation` and `web_search`. The tests are intentionally narrow: they do not inspect internal provider objects, only the externally visible protocol contract. The shared `DEFAULT_TIMEOUT` is longer than many other suites, reflecting that these tests wait for full server initialization before issuing a single request.

#### Function details

##### `read_default_provider_capabilities`  (lines 17–39)

```
async fn read_default_provider_capabilities() -> Result<()>
```

**Purpose**: Asserts the capability set returned for the server's default model provider configuration. It verifies that the default provider advertises all three tested capabilities as available.

**Data flow**: Creates a temporary home directory, starts `TestAppServer`, initializes it, sends an empty `ModelProviderCapabilitiesReadParams` request, waits for the matching `JSONRPCResponse`, and deserializes it into `ModelProviderCapabilitiesReadResponse`. It compares the received struct to an expected value with all booleans set to `true` and returns `Ok(())`.

**Call relations**: This top-level async test is run directly by the test harness. It exercises the endpoint without any config overrides, using `to_response` only after the transport layer has delivered the response for the generated integer request id.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `read_amazon_bedrock_provider_capabilities`  (lines 42–69)

```
async fn read_amazon_bedrock_provider_capabilities() -> Result<()>
```

**Purpose**: Checks that selecting `amazon-bedrock` in config changes the reported capability matrix. It confirms Bedrock disables image generation and web search while still supporting namespace tools.

**Data flow**: Creates a temp home, writes `config.toml` with `model_provider = "amazon-bedrock"`, starts and initializes the server, sends the same empty capabilities-read request, and deserializes the response into `ModelProviderCapabilitiesReadResponse`. It asserts the returned struct matches `{ namespace_tools: true, image_generation: false, web_search: false }`.

**Call relations**: This test follows the same request/response path as the default-provider case but inserts a configuration write before startup to force a different provider branch. Its role is to prove the endpoint reflects provider-specific behavior rather than returning a static capability set.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


### Discovery and listing APIs
These suites exercise read-only discovery endpoints that enumerate built-in and configured server-visible resources and presets.

### `app-server/tests/suite/v2/collaboration_mode_list.rs`

`test` · `request handling`

This file is a single end-to-end async test for the collaboration mode list endpoint. It creates an isolated CODEX_HOME with `tempfile::TempDir`, launches a `TestAppServer`, and performs the normal MCP initialization handshake before issuing `send_list_collaboration_modes_request` with `CollaborationModeListParams::default()`. All server interactions are wrapped in a generous 60-second `tokio::time::timeout`, reflecting CI startup and RPC latency expectations.

The response path is concrete: the test waits for a `JSONRPCResponse` matching the integer request id, deserializes it with `app_test_support::to_response::<CollaborationModeListResponse>`, and extracts the returned `data` vector. It then independently constructs the expected `Vec<CollaborationModeMask>` from `codex_core::test_support::builtin_collaboration_mode_presets()`, copying each preset’s `name`, `mode`, `model`, and `reasoning_effort` fields into the protocol type used by the RPC. The final `assert_eq!` checks both membership and ordering, so the endpoint is required to return the built-in presets in a stable sequence, not merely as an unordered set. The test therefore guards against accidental drift between core preset definitions and the app-server’s externally visible JSON-RPC surface.

#### Function details

##### `list_collaboration_modes_returns_presets`  (lines 29–59)

```
async fn list_collaboration_modes_returns_presets() -> Result<()>
```

**Purpose**: Starts a test app-server, calls the collaboration-mode list RPC, and asserts the returned items exactly match the built-in preset masks in order. It is the file’s sole contract test for the endpoint’s default output.

**Data flow**: Creates a temporary home directory and a `TestAppServer`, initializes the server, sends a default `CollaborationModeListParams` request, and reads the matching `JSONRPCResponse`. It deserializes that response into `CollaborationModeListResponse`, transforms `builtin_collaboration_mode_presets()` into a `Vec<CollaborationModeMask>` by copying preset fields, compares expected and actual vectors, and returns `Ok(())` on success.

**Call relations**: This async test is invoked by the Tokio test harness. Within its flow it delegates server startup to `TestAppServer::new`, waits on initialization and response reads via `timeout`, and uses the core preset helper as the expected-value source so the assertion is anchored to the canonical preset definitions.

*Call graph*: calls 2 internal fn (new, builtin_collaboration_mode_presets); 5 external calls (new, Integer, default, assert_eq!, timeout).


### `app-server/tests/suite/v2/model_list.rs`

`test` · `request handling`

This test file builds expected `codex_app_server_protocol::Model` values from `codex_protocol::openai_models::ModelPreset` fixtures and compares them to app-server responses. The helper `model_from_preset` performs a field-by-field conversion, including upgrade metadata, reasoning effort options, service tiers, picker visibility (`hidden` is the inverse of `show_in_picker`), and a deliberate `supports_personality: false` workaround because the cache fixture round-trip loses personality placeholders. `expected_visible_models` mirrors production selection logic by loading all test presets, filtering them through `ModelPreset::filter_by_auth` for non-ChatGPT mode, then applying `mark_default_by_picker_visibility` before keeping only picker-visible entries.

The tests all create isolated `TempDir` homes, seed either a models cache or a mock remote `/models` endpoint, start `TestAppServer`, and wrap initialization and stream reads in `tokio::time::timeout` to fail deterministically. Coverage includes a large-limit request returning the full visible list, `include_hidden: true` surfacing hidden entries, one-by-one pagination using returned cursors until exhaustion, and invalid cursor rejection as JSON-RPC invalid request `-32600`. The remote-catalog test is especially concrete: it writes `config.toml` pointing `openai_base_url` at a `wiremock::MockServer`, installs ChatGPT auth while explicitly unsetting `OPENAI_API_KEY`, mounts a single `/models` response, and asserts that the server treats that remote catalog as authoritative rather than the local cache.

#### Function details

##### `model_from_preset`  (lines 33–76)

```
fn model_from_preset(preset: &ModelPreset) -> Model
```

**Purpose**: Converts a `ModelPreset` fixture into the exact `Model` shape returned by the app-server protocol. It preserves most preset metadata while intentionally forcing `supports_personality` to `false` to match cache-backed test behavior.

**Data flow**: Reads a borrowed `ModelPreset` and clones its identifiers, display metadata, upgrade info, availability NUX, modalities, reasoning effort definitions, speed/service tiers, and default flags into a new `Model`. It transforms nested upgrade and service-tier structures into `ModelUpgradeInfo` and `ModelServiceTier`, inverts `show_in_picker` into `hidden`, and returns the assembled protocol value without mutating external state.

**Call relations**: This helper is used indirectly by expectation-building code in this file so the assertions compare against the same field layout the endpoint emits. It does not perform I/O; it exists to keep the tests aligned with protocol-level response semantics.


##### `expected_visible_models`  (lines 78–93)

```
fn expected_visible_models() -> Vec<Model>
```

**Purpose**: Builds the canonical expected visible model list for cache-backed tests. It reproduces the same auth filtering and default-marking steps the production model manager applies before exposing picker-visible models.

**Data flow**: Starts from `codex_core::test_support::all_model_presets()`, clones that preset collection, filters it with `ModelPreset::filter_by_auth(..., false)`, mutates the vector in place via `mark_default_by_picker_visibility`, then filters to `show_in_picker == true` and maps each preset through `model_from_preset`. It returns a `Vec<Model>` used as the expected response payload.

**Call relations**: It is invoked by the large-limit and pagination tests to derive expected results from shared fixtures instead of hardcoding model IDs. Its role in the call flow is to mirror production selection logic closely enough that endpoint regressions show up as assertion diffs rather than fixture drift.

*Call graph*: calls 3 internal fn (all_model_presets, filter_by_auth, mark_default_by_picker_visibility); called by 2 (list_models_pagination_works, list_models_returns_all_models_with_large_limit).


##### `list_models_returns_all_models_with_large_limit`  (lines 96–127)

```
async fn list_models_returns_all_models_with_large_limit() -> Result<()>
```

**Purpose**: Verifies that `model/list` returns the full visible catalog when the requested limit exceeds the number of available models. It also checks that pagination terminates immediately with no `next_cursor`.

**Data flow**: Creates a temporary Codex home, writes a cached models fixture into it, starts `TestAppServer`, initializes it, sends `ModelListParams { limit: Some(100), cursor: None, include_hidden: None }`, waits for the matching `JSONRPCResponse`, deserializes it into `ModelListResponse`, and compares `data` against `expected_visible_models()`. It asserts `next_cursor.is_none()` and returns `Ok(())`.

**Call relations**: This is a top-level async test invoked by the test runner after setup. It drives the normal request/response path through `TestAppServer`, then delegates expectation construction to `expected_visible_models` so the assertion focuses on endpoint behavior rather than fixture assembly.

*Call graph*: calls 2 internal fn (new, expected_visible_models); 6 external calls (new, Integer, write_models_cache, assert!, assert_eq!, timeout).


##### `list_models_includes_hidden_models`  (lines 130–159)

```
async fn list_models_includes_hidden_models() -> Result<()>
```

**Purpose**: Checks that setting `include_hidden: true` causes hidden models to appear in the returned page. It confirms that hidden entries are not silently filtered out when explicitly requested.

**Data flow**: Creates a temp home, seeds the models cache, starts and initializes the test server, sends a `model/list` request with `limit: Some(100)` and `include_hidden: Some(true)`, reads the response, and deserializes it into `ModelListResponse`. It asserts that at least one returned `Model` has `hidden == true` and that `next_cursor` is absent.

**Call relations**: As a standalone test, it exercises the same endpoint path as the basic listing test but changes only the request flag controlling visibility. It does not build a full expected vector; instead it validates the specific inclusion property that should differ under this condition.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, write_models_cache, assert!, timeout).


##### `list_models_uses_chatgpt_remote_catalog_as_source_of_truth`  (lines 162–270)

```
async fn list_models_uses_chatgpt_remote_catalog_as_source_of_truth() -> Result<()>
```

**Purpose**: Proves that in ChatGPT-authenticated mode the server prefers the remote `/models` catalog over local cache contents. It also validates the exact protocol mapping for a remote-only model definition.

**Data flow**: Starts a `MockServer`, constructs a `ModelInfo` from JSON, mounts a one-shot `ModelsResponse`, writes a `config.toml` pointing `openai_base_url` at the mock server, writes ChatGPT auth credentials, and starts `TestAppServer` with `OPENAI_API_KEY` removed. After initialization it sends `model/list`, reads and deserializes the response, converts the remote `ModelInfo` into a `ModelPreset`, marks defaults, maps it through `model_from_preset`, patches the expected reasoning-effort ordering/details, and asserts equality with the returned items plus `next_cursor == None`. It also checks the mock saw exactly one `/models` request.

**Call relations**: This test is invoked by the runner to cover the ChatGPT-specific branch where remote catalog fetches are enabled. It delegates HTTP fixture setup to `mount_models_once` and auth/config file creation helpers, then validates both endpoint output and the fact that the remote backend was actually consulted.

*Call graph*: calls 4 internal fn (new, new_with_env, mount_models_once, mark_default_by_picker_visibility); 12 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, from_value, write (+2 more)).


##### `list_models_pagination_works`  (lines 273–319)

```
async fn list_models_pagination_works() -> Result<()>
```

**Purpose**: Validates cursor-based pagination by requesting one model per page and concatenating pages until the server stops returning a cursor. It ensures ordering is stable and pagination terminates correctly.

**Data flow**: Creates a temp home, writes the models cache, starts and initializes the server, computes `expected_visible_models`, then loops up to that length sending `model/list` with `limit: Some(1)` and the current cursor. Each response is deserialized into `ModelListResponse`; the single returned item is appended to an accumulator and `cursor` is updated from `next_cursor`. If `next_cursor` becomes `None`, it asserts the accumulated items equal the expected list and returns success; otherwise, if the loop never terminates, it panics.

**Call relations**: This test uses `expected_visible_models` as the ground truth sequence and repeatedly drives the endpoint through successive cursor states. The explicit panic guards against a server bug that would keep emitting cursors forever or fail to terminate within the expected number of pages.

*Call graph*: calls 2 internal fn (new, expected_visible_models); 7 external calls (new, new, Integer, write_models_cache, assert_eq!, panic!, timeout).


##### `list_models_rejects_invalid_cursor`  (lines 322–347)

```
async fn list_models_rejects_invalid_cursor() -> Result<()>
```

**Purpose**: Checks that malformed pagination cursors are rejected as JSON-RPC invalid requests with a precise error message. It verifies both the protocol error code and the echoed request id.

**Data flow**: Creates a temp home, seeds the cache, starts and initializes the server, sends `model/list` with `cursor: Some("invalid".to_string())` and no limit, then waits for an error message instead of a normal response. It asserts the returned `JSONRPCError` has the original integer request id, code `-32600`, and message `invalid cursor: invalid`.

**Call relations**: This test covers the endpoint's validation branch rather than the happy path. It is invoked directly by the test runner and reads from the error stream helper to confirm the server maps cursor parsing failures into the expected JSON-RPC surface.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, write_models_cache, assert_eq!, timeout).


### `app-server/tests/suite/v2/permission_profile_list.rs`

`test` · `request handling`

This file exercises permission profile enumeration across home config and project config sources. The tests use `TempDir` homes and, where needed, separate workspace directories containing `.codex/config.toml`. They start `TestAppServer`, initialize it under a 30-second timeout, send `PermissionProfileListParams`, and deserialize responses with the local `read_response` helper.

The first test writes a home `config.toml` defining two custom profiles (`dev` and `audit`) plus `default_permissions = "dev"`. It asserts the endpoint returns the three built-in profile IDs first—`read-only`, `workspace`, and `danger-full-access`—followed by configured profiles with their descriptions. The second and third tests focus on project-scoped discovery: they create a trusted workspace via `set_project_trust_level`, place a `permissions.project` definition in `.codex/config.toml`, and pass `cwd` so the server resolves project-local config. One test also sets `default_permissions = ":workspace"` and requests `limit: Some(3)` to prove pagination returns the built-ins on page one and the project profile on page two with cursor `"3"`; the other confirms project profiles are still discovered even without any default selection in home config. The helper centralizes the common response-read pattern by waiting for the matching request id and deserializing the typed payload.

#### Function details

##### `permission_profile_list_returns_builtin_and_configured_profiles`  (lines 23–85)

```
async fn permission_profile_list_returns_builtin_and_configured_profiles() -> Result<()>
```

**Purpose**: Checks that the endpoint merges built-in permission profiles with user-configured home profiles and returns them in the expected order. It also verifies descriptions are preserved for configured profiles.

**Data flow**: Creates a temp home, writes a `config.toml` defining `permissions.dev` and `permissions.audit`, starts and initializes `TestAppServer`, sends `PermissionProfileListParams { cursor: None, limit: None, cwd: None }`, and reads a typed `PermissionProfileListResponse` via `read_response`. It asserts the response contains three built-ins followed by `audit` and `dev`, each with the expected optional description, and `next_cursor: None`.

**Call relations**: This top-level test covers the home-config-only branch of profile discovery. It relies on `read_response` to abstract the JSON-RPC transport details so the assertion can focus on the returned summaries.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, write, timeout).


##### `permission_profile_list_resolves_project_profiles_and_paginates`  (lines 88–163)

```
async fn permission_profile_list_resolves_project_profiles_and_paginates() -> Result<()>
```

**Purpose**: Verifies that trusted project-local permission profiles are discovered when `cwd` points at the workspace and that cursor pagination slices the combined result set correctly. It specifically checks the built-ins appear on the first page and the project profile on the second.

**Data flow**: Creates temp home and workspace directories, writes home config with `default_permissions = ":workspace"`, writes `.codex/config.toml` in the workspace defining `permissions.project`, marks the workspace trusted with `set_project_trust_level`, then starts and initializes the server. It sends a first list request with `limit: Some(3)` and `cwd` set to the workspace path, asserts the first response contains only the three built-ins and `next_cursor: Some("3")`, then sends a second request using that cursor and asserts it returns the single `project` profile with `next_cursor: None`.

**Call relations**: This test drives two sequential endpoint calls to cover both project resolution and pagination. It depends on trust setup before startup so the server is allowed to read project config, and uses `read_response` for both pages.

*Call graph*: calls 2 internal fn (new, set_project_trust_level); 5 external calls (new, assert_eq!, create_dir_all, write, timeout).


##### `permission_profile_list_discovers_project_profiles_without_default_selection`  (lines 166–221)

```
async fn permission_profile_list_discovers_project_profiles_without_default_selection() -> Result<()>
```

**Purpose**: Confirms that project-local profiles are listed even when the home config does not set `default_permissions`. It isolates discovery from default-selection behavior.

**Data flow**: Creates temp home and workspace directories, writes only the workspace `.codex/config.toml` with a `permissions.project` entry, marks the workspace trusted, starts and initializes the server, sends a list request with `cwd` set to the workspace and no cursor or limit, and reads the typed response. It asserts the result contains the three built-ins plus the `project` profile and no pagination cursor.

**Call relations**: This test covers the branch where project profiles should still be visible despite no home-level default permission selection. Like the other profile tests, it delegates response decoding to `read_response`.

*Call graph*: calls 2 internal fn (new, set_project_trust_level); 5 external calls (new, assert_eq!, create_dir_all, write, timeout).


##### `read_response`  (lines 223–233)

```
async fn read_response(
    mcp: &mut TestAppServer,
    request_id: i64,
) -> Result<T>
```

**Purpose**: Reads a typed JSON-RPC success response for a previously issued request id from the test server stream. It removes repeated timeout and deserialization boilerplate from the permission-profile tests.

**Data flow**: Accepts a mutable `TestAppServer` reference and integer request id, waits under `DEFAULT_TIMEOUT` for `read_stream_until_response_message(RequestId::Integer(request_id))`, obtains a `JSONRPCResponse`, and passes it to `to_response` for deserialization into generic `T: DeserializeOwned`. It returns the typed result or propagates transport/deserialization errors.

**Call relations**: All three tests call this helper immediately after sending a permission-profile request. It sits between the transport-level stream reader and the test assertions, standardizing how typed responses are obtained.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); 3 external calls (Integer, to_response, timeout).


### Execution and environment RPCs
These tests cover the core operational RPC surfaces for filesystem access, process execution, and Windows sandbox setup.

### `app-server/tests/suite/v2/fs.rs`

`test` · `request handling and filesystem watching`

This file is a comprehensive integration suite for `fs/*` methods. It defines a few reusable helpers: `initialized_mcp` starts and initializes `TestAppServer` with a platform-adjusted timeout, `expect_error_message` waits for a request-specific JSON-RPC error and compares its message, and `absolute_path` converts a `PathBuf` into `AbsolutePathBuf` while asserting the input is already absolute. The tests then exercise the full filesystem surface against temporary directories.

The CRUD-style tests verify that `fs/getMetadata` returns only the intended fields and correctly reports symlinks, that `fs/writeFile` accepts arbitrary bytes encoded as base64 and rejects malformed base64, and that create-directory, read-file, copy-file, recursive copy-directory, read-directory, and remove-directory all work together. Several negative tests lock in validation rules: all path-bearing methods reject relative paths during request deserialization, copying a directory requires `recursive: true`, copying a directory into its own descendant is forbidden, and standalone FIFO sources are unsupported. Unix-only tests further assert recursive copy preserves symlinks and silently skips unknown special files like named pipes.

The watch tests cover both directory and file targets. They register watches, mutate files directly or via atomic replace, optionally decode `fs/changed` notifications when the OS backend emits them, drain spurious notifications, and confirm `fs/unwatch` suppresses future events. The helper pair `fs_changed_notification` and `maybe_fs_changed_notification` encapsulate notification parsing and the intentionally non-fatal timeout behavior used because kernel file watching can be flaky in sandboxed CI.

#### Function details

##### `initialized_mcp`  (lines 39–43)

```
async fn initialized_mcp(codex_home: &TempDir) -> Result<TestAppServer>
```

**Purpose**: Starts a `TestAppServer`, performs initialization under the file's default timeout, and returns the ready-to-use server handle.

**Data flow**: It takes a `TempDir` reference, constructs `TestAppServer::new(codex_home.path())`, awaits initialization wrapped in `timeout(DEFAULT_READ_TIMEOUT, ...)`, and returns the initialized server or propagates startup/timeout errors.

**Call relations**: Most tests in this file call this helper first so they can focus on the specific filesystem RPC under test instead of repeating startup boilerplate.

*Call graph*: calls 1 internal fn (new); called by 15 (fs_copy_ignores_unknown_special_files_in_recursive_copy, fs_copy_preserves_symlinks_in_recursive_copy, fs_copy_rejects_copying_directory_into_descendant, fs_copy_rejects_directory_without_recursive, fs_copy_rejects_standalone_fifo_source, fs_get_metadata_reports_symlink, fs_get_metadata_returns_only_used_fields, fs_methods_cover_current_fs_utils_surface, fs_methods_reject_relative_paths, fs_watch_allows_missing_file_targets (+5 more)); 2 external calls (path, timeout).


##### `expect_error_message`  (lines 45–57)

```
async fn expect_error_message(
    mcp: &mut TestAppServer,
    request_id: i64,
    expected_message: &str,
) -> Result<()>
```

**Purpose**: Waits for a request's JSON-RPC error response and asserts its message matches an expected string exactly.

**Data flow**: It accepts a mutable `TestAppServer`, numeric request ID, and expected message, waits for `read_stream_until_error_message(RequestId::Integer(request_id))` under `DEFAULT_READ_TIMEOUT`, reads `error.error.message`, compares it with `assert_eq!`, and returns `Ok(())` on success.

**Call relations**: Negative tests for disabled local FS, relative-path rejection, standalone FIFO copy, and invalid watch paths delegate their terminal assertion to this helper.

*Call graph*: calls 1 internal fn (read_stream_until_error_message); called by 4 (fs_copy_rejects_standalone_fifo_source, fs_methods_reject_relative_paths, fs_methods_return_error_when_local_environment_is_disabled, fs_watch_rejects_relative_paths); 3 external calls (Integer, assert_eq!, timeout).


##### `absolute_path`  (lines 59–66)

```
fn absolute_path(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts an absolute `PathBuf` into the protocol's `AbsolutePathBuf`, failing fast if the path is not absolute.

**Data flow**: It takes a `PathBuf`, asserts `path.is_absolute()`, then calls `AbsolutePathBuf::try_from(path)` and returns the converted value. It panics if the input is relative or conversion unexpectedly fails.

**Call relations**: Nearly every positive-path filesystem test uses this helper when constructing typed request params, ensuring the requests exercise server logic rather than client-side relative-path serialization failures.

*Call graph*: calls 1 internal fn (try_from); called by 14 (fs_copy_ignores_unknown_special_files_in_recursive_copy, fs_copy_preserves_symlinks_in_recursive_copy, fs_copy_rejects_copying_directory_into_descendant, fs_copy_rejects_directory_without_recursive, fs_copy_rejects_standalone_fifo_source, fs_get_metadata_reports_symlink, fs_get_metadata_returns_only_used_fields, fs_methods_cover_current_fs_utils_surface, fs_methods_return_error_when_local_environment_is_disabled, fs_watch_allows_missing_file_targets (+4 more)); 1 external calls (assert!).


##### `fs_get_metadata_returns_only_used_fields`  (lines 69–120)

```
async fn fs_get_metadata_returns_only_used_fields() -> Result<()>
```

**Purpose**: Checks that `fs/getMetadata` returns the expected minimal field set and sensible values for a regular file.

**Data flow**: It writes `note.txt`, initializes the server, sends `FsGetMetadataParams { path }`, waits for the raw `JSONRPCResponse`, inspects `response.result` as an object to collect and sort its keys, and asserts only `createdAtMs`, `isDirectory`, `isFile`, `isSymlink`, and `modifiedAtMs` are present. It then deserializes `FsGetMetadataResponse`, compares the boolean fields and timestamps, and asserts `modified_at_ms > 0`.

**Call relations**: This test uses `initialized_mcp` and `absolute_path` for setup, then `to_response` for typed decoding after first inspecting the raw JSON shape.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 7 external calls (new, Integer, to_response, assert!, assert_eq!, write, timeout).


##### `fs_methods_return_error_when_local_environment_is_disabled`  (lines 123–142)

```
async fn fs_methods_return_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: Verifies that filesystem RPCs fail with a clear message when the local execution/filesystem environment is disabled via environment variable.

**Data flow**: It starts `TestAppServer::new_with_env` with `CODEX_EXEC_SERVER_URL_ENV_VAR` set to `none`, initializes, sends `fs/readFile` for an absolute path, and passes the resulting request ID to `expect_error_message` with `local filesystem is not configured`.

**Call relations**: This is a direct negative test entrypoint. Unlike most others it bypasses `initialized_mcp` because it needs custom environment setup before initialization.

*Call graph*: calls 3 internal fn (new_with_env, absolute_path, expect_error_message); 2 external calls (new, timeout).


##### `fs_get_metadata_reports_symlink`  (lines 146–171)

```
async fn fs_get_metadata_reports_symlink() -> Result<()>
```

**Purpose**: Ensures metadata for a symlink reports both the target file nature and the symlink flag.

**Data flow**: On Unix, it writes a regular file, creates a symlink to it, initializes the server, sends `fs/getMetadata` for the symlink path, deserializes `FsGetMetadataResponse`, and asserts `is_directory == false`, `is_file == true`, and `is_symlink == true`.

**Call relations**: The test harness invokes it on Unix platforms. It reuses `initialized_mcp`, `absolute_path`, and `to_response` to focus on symlink-specific metadata semantics.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 7 external calls (new, Integer, to_response, assert_eq!, write, symlink, timeout).


##### `fs_methods_cover_current_fs_utils_surface`  (lines 174–322)

```
async fn fs_methods_cover_current_fs_utils_surface() -> Result<()>
```

**Purpose**: Exercises the main happy-path filesystem RPC surface end to end: create directory, write file, read file, copy file, copy directory, read directory, and remove directory tree.

**Data flow**: It creates several source and destination paths, initializes the server, sends `fs/createDirectory` for a nested directory, writes two files via `FsWriteFileParams` with base64-encoded contents, reads one file back via `fs/readFile` and decodes `FsReadFileResponse`, copies that file to a new path, recursively copies the whole source directory tree, reads the source directory via `fs/readDirectory` and sorts the returned `FsReadDirectoryEntry` list, then removes the copied directory via `fs/remove`. Along the way it verifies on-disk file contents and final nonexistence of the removed directory.

**Call relations**: This broad integration test is driven directly by the harness and repeatedly uses `absolute_path`, `initialized_mcp`, and `to_response` across multiple request/response cycles.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `fs_write_file_accepts_base64_bytes`  (lines 325–364)

```
async fn fs_write_file_accepts_base64_bytes() -> Result<()>
```

**Purpose**: Confirms that `fs/writeFile` accepts arbitrary binary data encoded as base64 and that `fs/readFile` returns the same bytes re-encoded.

**Data flow**: It defines a four-byte array, initializes the server, sends `FsWriteFileParams` with `data_base64` set to `STANDARD.encode(bytes)`, waits for success, reads the file from disk to verify raw bytes, then sends `fs/readFile`, deserializes `FsReadFileResponse`, and asserts the returned base64 string matches the original encoding.

**Call relations**: This positive-path binary round-trip test uses `initialized_mcp`, `absolute_path`, and `to_response` to validate both write and read behavior.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `fs_write_file_rejects_invalid_base64`  (lines 367–393)

```
async fn fs_write_file_rejects_invalid_base64() -> Result<()>
```

**Purpose**: Checks that malformed base64 input is rejected with a descriptive `fs/writeFile` error message.

**Data flow**: It initializes the server, sends `FsWriteFileParams` with `data_base64` set to `%%%`, waits for the error response for that request ID, and asserts the message starts with `fs/writeFile requires valid base64 dataBase64:`.

**Call relations**: The test harness invokes it directly; it uses `initialized_mcp` and `absolute_path` for setup but performs its own prefix assertion instead of delegating to `expect_error_message` because the exact decoder suffix may vary.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 4 external calls (new, Integer, assert!, timeout).


##### `fs_methods_reject_relative_paths`  (lines 396–517)

```
async fn fs_methods_reject_relative_paths() -> Result<()>
```

**Purpose**: Verifies that all path-bearing filesystem methods reject relative paths during request deserialization.

**Data flow**: It writes one absolute file for mixed copy tests, initializes the server, then sends raw JSON-RPC requests for `fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/remove`, and two `fs/copy` variants where either source or destination is relative. For each returned request ID it calls `expect_error_message` with the shared deserialization error `Invalid request: AbsolutePathBuf deserialized without a base path`.

**Call relations**: This test centralizes relative-path validation across the whole FS API surface and repeatedly delegates the final error assertion to `expect_error_message`.

*Call graph*: calls 2 internal fn (expect_error_message, initialized_mcp); 3 external calls (new, json!, write).


##### `fs_copy_rejects_directory_without_recursive`  (lines 520–544)

```
async fn fs_copy_rejects_directory_without_recursive() -> Result<()>
```

**Purpose**: Ensures copying a directory with `recursive: false` is rejected explicitly.

**Data flow**: It creates a source directory, initializes the server, sends `FsCopyParams` with that directory as `source_path`, a destination path, and `recursive: false`, waits for the error response, and asserts the message equals `fs/copy requires recursive: true when sourcePath is a directory`.

**Call relations**: This negative copy test is invoked directly and uses `initialized_mcp` plus `absolute_path` before asserting the server-side validation message.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 5 external calls (new, Integer, assert_eq!, create_dir_all, timeout).


##### `fs_copy_rejects_copying_directory_into_descendant`  (lines 547–571)

```
async fn fs_copy_rejects_copying_directory_into_descendant() -> Result<()>
```

**Purpose**: Checks that recursive copy forbids copying a directory into itself or one of its descendants.

**Data flow**: It creates `source/nested`, initializes the server, sends `FsCopyParams` with `source_path` set to `source` and `destination_path` set to `source/nested/copy`, waits for the error response, and asserts the exact descendant-copy rejection message.

**Call relations**: The test harness invokes it directly; it is a targeted validation of one server-side safety check in the copy implementation.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 5 external calls (new, Integer, assert_eq!, create_dir_all, timeout).


##### `fs_copy_preserves_symlinks_in_recursive_copy`  (lines 575–603)

```
async fn fs_copy_preserves_symlinks_in_recursive_copy() -> Result<()>
```

**Purpose**: Verifies that recursive directory copy preserves symlink entries as symlinks rather than dereferencing them.

**Data flow**: On Unix, it creates a source directory tree with a relative symlink `nested-link -> nested`, initializes the server, sends a recursive `fs/copy` request, waits for success, then inspects the copied link with `symlink_metadata` and `read_link` to assert it is still a symlink pointing to `nested`.

**Call relations**: This Unix-only test uses `initialized_mcp` and `absolute_path` for setup and validates postconditions directly on the filesystem after the copy RPC succeeds.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 8 external calls (new, Integer, assert!, assert_eq!, create_dir_all, symlink_metadata, symlink, timeout).


##### `fs_copy_ignores_unknown_special_files_in_recursive_copy`  (lines 607–644)

```
async fn fs_copy_ignores_unknown_special_files_in_recursive_copy() -> Result<()>
```

**Purpose**: Checks that recursive copy skips unsupported special files encountered inside a directory tree while still copying normal files.

**Data flow**: On Unix, it creates a source directory containing `note.txt` and a FIFO created via `mkfifo`, initializes the server, sends a recursive `fs/copy` request, waits for success, then asserts the copied directory contains `note.txt` with the expected contents and does not contain the FIFO path.

**Call relations**: This test is entered by the harness and complements the standalone FIFO rejection case by showing special files are ignored rather than fatal when encountered during recursive traversal.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 9 external calls (new, bail!, Integer, assert!, assert_eq!, new, create_dir_all, write, timeout).


##### `fs_copy_rejects_standalone_fifo_source`  (lines 648–676)

```
async fn fs_copy_rejects_standalone_fifo_source() -> Result<()>
```

**Purpose**: Ensures a top-level copy request whose source is a FIFO is rejected as unsupported.

**Data flow**: On Unix, it creates a FIFO with `mkfifo`, initializes the server, sends `FsCopyParams` using that FIFO as `source_path`, and delegates to `expect_error_message` to assert the message `fs/copy only supports regular files, directories, and symlinks`.

**Call relations**: This negative Unix-only test uses `expect_error_message` as its terminal assertion and pairs with the recursive-copy special-file test to define both standalone and nested behavior.

*Call graph*: calls 3 internal fn (absolute_path, expect_error_message, initialized_mcp); 3 external calls (new, bail!, new).


##### `fs_watch_directory_reports_changed_child_paths_and_unwatch_stops_notifications`  (lines 679–745)

```
async fn fs_watch_directory_reports_changed_child_paths_and_unwatch_stops_notifications() -> Result<()>
```

**Purpose**: Tests directory watching, optional delivery of child-path change notifications, and the effect of `fs/unwatch` on subsequent events.

**Data flow**: It creates a `.git` directory with `FETCH_HEAD`, initializes the server, sends `fs/watch` for the directory and decodes `FsWatchResponse`, mutates `FETCH_HEAD`, then calls `maybe_fs_changed_notification` to optionally obtain a parsed `FsChangedNotification` and, if present, asserts the `watch_id` and changed child path. It drains any extra `fs/changed` notifications in a short loop, sends `fs/unwatch`, waits for success, mutates another file in the watched directory, and asserts no further `fs/changed` notification arrives within 1.5 seconds.

**Call relations**: This watch lifecycle test uses `maybe_fs_changed_notification` to tolerate environments where kernel events are unreliable, then validates unwatch behavior with a hard negative assertion.

*Call graph*: calls 3 internal fn (absolute_path, initialized_mcp, maybe_fs_changed_notification); 9 external calls (from_millis, new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout).


##### `fs_watch_file_reports_atomic_replace_events`  (lines 748–785)

```
async fn fs_watch_file_reports_atomic_replace_events() -> Result<()>
```

**Purpose**: Verifies that watching a file path reports changes when the file is atomically replaced via write-to-temp then rename.

**Data flow**: It creates `.git/HEAD`, initializes the server, sends `fs/watch` for the file and decodes `FsWatchResponse`, calls `replace_file_atomically` to swap in new contents, then uses `maybe_fs_changed_notification` and, if a notification arrives, asserts it equals `FsChangedNotification { watch_id, changed_paths: [head_path] }`.

**Call relations**: This test is invoked directly and depends on `replace_file_atomically` to generate the specific filesystem event pattern the watch backend must recognize.

*Call graph*: calls 4 internal fn (absolute_path, initialized_mcp, maybe_fs_changed_notification, replace_file_atomically); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `fs_watch_allows_missing_file_targets`  (lines 788–824)

```
async fn fs_watch_allows_missing_file_targets() -> Result<()>
```

**Purpose**: Checks that `fs/watch` can be registered on a file path that does not yet exist and still reports a later atomic creation/replacement.

**Data flow**: It creates the parent `.git` directory but not `FETCH_HEAD`, initializes the server, sends `fs/watch` for the missing file path and decodes `FsWatchResponse`, creates the file via `replace_file_atomically`, then optionally parses a `fs/changed` notification through `maybe_fs_changed_notification` and asserts the changed path is the watched file.

**Call relations**: This test complements the previous file-watch case by proving the watch registration path does not require the target file to exist up front.

*Call graph*: calls 4 internal fn (absolute_path, initialized_mcp, maybe_fs_changed_notification, replace_file_atomically); 6 external calls (new, Integer, to_response, assert_eq!, create_dir_all, timeout).


##### `fs_watch_rejects_relative_paths`  (lines 827–845)

```
async fn fs_watch_rejects_relative_paths() -> Result<()>
```

**Purpose**: Ensures `fs/watch` rejects a relative path with the same absolute-path deserialization error used by the other FS methods.

**Data flow**: It initializes the server, sends a raw `fs/watch` request whose `path` is `relative-path`, and passes the resulting request ID to `expect_error_message` with the shared invalid-request message.

**Call relations**: This is the watch-specific counterpart to `fs_methods_reject_relative_paths`, reusing `expect_error_message` for the final assertion.

*Call graph*: calls 2 internal fn (expect_error_message, initialized_mcp); 2 external calls (new, json!).


##### `fs_changed_notification`  (lines 847–852)

```
fn fs_changed_notification(notification: JSONRPCNotification) -> Result<FsChangedNotification>
```

**Purpose**: Parses a raw JSON-RPC notification into the typed `FsChangedNotification` payload.

**Data flow**: It takes a `JSONRPCNotification`, extracts `notification.params`, errors if params are missing using `Context`, then deserializes the params JSON into `FsChangedNotification` with `serde_json::from_value` and returns it.

**Call relations**: Only `maybe_fs_changed_notification` calls this helper, using it as the typed decoding step after a `fs/changed` notification is received.

*Call graph*: called by 1 (maybe_fs_changed_notification).


##### `maybe_fs_changed_notification`  (lines 854–866)

```
async fn maybe_fs_changed_notification(
    mcp: &mut TestAppServer,
) -> Result<Option<FsChangedNotification>>
```

**Purpose**: Attempts to read and parse a `fs/changed` notification within a short timeout, returning `None` instead of failing when no OS event arrives.

**Data flow**: It takes a mutable `TestAppServer`, wraps `read_stream_until_notification_message("fs/changed")` in `timeout(OPTIONAL_FS_CHANGE_TIMEOUT, ...)`, and matches the result: on success it passes the notification through `fs_changed_notification` and returns `Some(parsed)`, while on timeout it returns `Ok(None)`.

**Call relations**: The three watch tests call this helper to make notification assertions conditional on backend event delivery, while still validating notification shape whenever one is emitted.

*Call graph*: calls 2 internal fn (read_stream_until_notification_message, fs_changed_notification); called by 3 (fs_watch_allows_missing_file_targets, fs_watch_directory_reports_changed_child_paths_and_unwatch_stops_notifications, fs_watch_file_reports_atomic_replace_events); 1 external calls (timeout).


##### `replace_file_atomically`  (lines 868–881)

```
fn replace_file_atomically(path: &PathBuf, contents: &str) -> Result<()>
```

**Purpose**: Simulates an atomic file update by writing new contents to a sibling temp path and renaming it into place.

**Data flow**: It takes a target `PathBuf` and contents string, derives `temp_path` via `with_extension("lock")`, writes the contents there, conditionally removes the destination first on Windows if it exists, renames the temp file onto the target path, and returns `Ok(())` or any I/O error.

**Call relations**: The file-watch tests call this helper to generate rename-based updates that should still be observed by the watch implementation, including when the watched file did not previously exist.

*Call graph*: called by 2 (fs_watch_allows_missing_file_targets, fs_watch_file_reports_atomic_replace_events); 4 external calls (with_extension, remove_file, rename, write).


### `app-server/tests/suite/v2/process_exec.rs`

`test` · `request handling`

This compact test module drives `process/spawn` and `process/kill` through `TestAppServer` with a mock responses server and a local execution environment. The central helper `initialized_mcp` writes a config via `create_config_toml`, starts the app server, and waits for initialization. `process_spawn_params` constructs a baseline `ProcessSpawnParams` with an absolute working directory, no TTY, no streaming, and optional overrides supplied by each test.

The first spawn test uses a probe/release handshake instead of timing assumptions: the child process writes a probe file immediately, then blocks until the test creates a release file, proving the JSON-RPC response arrives before process exit. It then waits for a `process/exited` notification and asserts captured stdout/stderr and exit code. Another test sets `output_bytes_cap = 3` and confirms both stdout and stderr are truncated with the corresponding `*_cap_reached` flags set. The kill test starts a long-running sleep command, confirms spawn success, sends `process/kill`, and then asserts a nonzero exit code with empty buffered output. The disabled-environment test starts the server with `CODEX_EXEC_SERVER_URL_ENV_VAR=none` and a config that never provisions local execution, then verifies `process/spawn` returns the exact `local environment is not configured` error. Small helpers deserialize exit notifications and poll for file creation under a timeout.

#### Function details

##### `process_spawn_returns_before_exit_and_emits_exit_notification`  (lines 24–104)

```
async fn process_spawn_returns_before_exit_and_emits_exit_notification() -> Result<()>
```

**Purpose**: Verifies `process/spawn` responds immediately after launch, before the child exits, and later emits a complete `process/exited` notification.

**Data flow**: Creates temp codex home and initialized app server, builds OS-specific command arguments that write a probe file, wait for a release file, then emit stdout/stderr. It sends `ProcessSpawnParams` with environment variables pointing at the probe/release paths, asserts the immediate JSON-RPC response is `{}`, waits for the probe file to appear and contain `process`, writes the release file, then reads and asserts the resulting `ProcessExitedNotification` fields.

**Call relations**: This top-level test uses `initialized_mcp`, `process_spawn_params`, `wait_for_file`, and `read_process_exited` to prove the spawn RPC and exit-notification path are decoupled.

*Call graph*: calls 4 internal fn (initialized_mcp, process_spawn_params, read_process_exited, wait_for_file); 7 external calls (from, new, Integer, assert_eq!, cfg!, write, vec!).


##### `process_spawn_returns_error_when_local_environment_is_disabled`  (lines 107–131)

```
async fn process_spawn_returns_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: Ensures process spawning fails cleanly when the app server has no configured local execution environment.

**Data flow**: Creates temp codex home, starts an empty mock responses server, writes config with local execution disabled via `create_config_toml(..., "never")`, starts `TestAppServer` with `CODEX_EXEC_SERVER_URL_ENV_VAR=none`, initializes it, sends a spawn request for a trivial shell command, and reads the error response. It asserts the error message is exactly `local environment is not configured`.

**Call relations**: Invoked directly by the test runner, this case covers the early rejection branch before any child process is launched.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, process_spawn_params); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `process_spawn_reports_buffered_output_cap_reached`  (lines 134–180)

```
async fn process_spawn_reports_buffered_output_cap_reached() -> Result<()>
```

**Purpose**: Checks that buffered stdout and stderr are truncated to the configured byte cap and marked as capped in the exit notification.

**Data flow**: Starts an initialized app server, builds an OS-specific command that writes five bytes to stdout and stderr, sends `ProcessSpawnParams` with `output_bytes_cap: Some(Some(3))`, asserts the immediate response is `{}`, then reads `ProcessExitedNotification` and checks stdout=`abc`, stderr=`123`, and both cap flags are `true`.

**Call relations**: This test is run directly and focuses on output buffering behavior after a successful spawn. It reuses the common spawn helper and exit-notification reader.

*Call graph*: calls 3 internal fn (initialized_mcp, process_spawn_params, read_process_exited); 5 external calls (new, Integer, assert_eq!, cfg!, vec!).


##### `process_kill_terminates_running_process`  (lines 183–231)

```
async fn process_kill_terminates_running_process() -> Result<()>
```

**Purpose**: Verifies `process/kill` terminates a long-running spawned process and that the exit notification reflects abnormal termination.

**Data flow**: Starts an initialized app server, spawns an OS-specific sleep command under a known process handle, asserts the spawn response is `{}`, sends `ProcessKillParams` for that handle, asserts the kill response is `{}`, then reads `ProcessExitedNotification`. It checks the handle matches, exit code is nonzero, and buffered stdout/stderr are empty with cap flags unset.

**Call relations**: This top-level test exercises the interaction between the spawn and kill RPCs and the shared exit-notification channel.

*Call graph*: calls 3 internal fn (initialized_mcp, process_spawn_params, read_process_exited); 7 external calls (new, Integer, assert!, assert_eq!, assert_ne!, cfg!, vec!).


##### `initialized_mcp`  (lines 233–239)

```
async fn initialized_mcp(codex_home: &Path) -> Result<(MockServer, TestAppServer)>
```

**Purpose**: Creates a mock-backed app server configured for process-exec tests and waits for initialization.

**Data flow**: Starts an empty mock responses server, writes config for the provided codex-home path using `create_config_toml`, constructs `TestAppServer`, waits for `initialize()` under `DEFAULT_READ_TIMEOUT`, and returns both the mock server and initialized app server.

**Call relations**: The spawn, capped-output, and kill tests call this helper to avoid repeating setup for a working local execution environment.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 3 (process_kill_terminates_running_process, process_spawn_reports_buffered_output_cap_reached, process_spawn_returns_before_exit_and_emits_exit_notification); 3 external calls (new, create_mock_responses_server_sequence_unchecked, timeout).


##### `process_spawn_params`  (lines 241–258)

```
fn process_spawn_params(
    process_handle: String,
    cwd: &Path,
    command: Vec<String>,
) -> Result<ProcessSpawnParams>
```

**Purpose**: Builds the baseline `ProcessSpawnParams` used by the tests.

**Data flow**: Accepts a process handle string, working-directory path, and command vector, converts the cwd to `AbsolutePathBuf`, and returns a `ProcessSpawnParams` with `tty=false`, `stream_stdin=false`, `stream_stdout_stderr=false`, and all optional fields unset.

**Call relations**: All process-exec tests call this helper and then optionally override fields like `env`, `output_bytes_cap`, or `timeout_ms` in struct update syntax.

*Call graph*: calls 1 internal fn (try_from); called by 4 (process_kill_terminates_running_process, process_spawn_reports_buffered_output_cap_reached, process_spawn_returns_before_exit_and_emits_exit_notification, process_spawn_returns_error_when_local_environment_is_disabled).


##### `read_process_exited`  (lines 260–268)

```
async fn read_process_exited(mcp: &mut TestAppServer) -> Result<ProcessExitedNotification>
```

**Purpose**: Reads and deserializes the next `process/exited` notification from the app server stream.

**Data flow**: Waits for a notification with method `process/exited`, extracts its `params`, errors if params are missing, and deserializes them into `ProcessExitedNotification`.

**Call relations**: The spawn, capped-output, and kill tests use this helper after the initial RPC response to assert the asynchronous completion payload.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (process_kill_terminates_running_process, process_spawn_reports_buffered_output_cap_reached, process_spawn_returns_before_exit_and_emits_exit_notification); 1 external calls (from_value).


##### `wait_for_file`  (lines 270–278)

```
async fn wait_for_file(path: &Path) -> Result<()>
```

**Purpose**: Polls until a filesystem path exists, failing with context if the timeout expires.

**Data flow**: Runs a timeout-wrapped loop that checks `path.exists()` every 20 ms using `sleep`, then returns success or an `anyhow::Context`-annotated timeout error.

**Call relations**: Only the probe/release spawn test uses this helper to synchronize on child-process startup without relying on wall-clock timing.

*Call graph*: called by 1 (process_spawn_returns_before_exit_and_emits_exit_notification); 4 external calls (from_millis, exists, sleep, timeout).


### `app-server/tests/suite/v2/windows_sandbox_setup.rs`

`test` · `request handling`

This small integration test file drives `TestAppServer` through the `windowsSandbox/setupStart` JSON-RPC method. The success-path test creates a temporary Codex home, writes a mock-responses config, initializes the app server, sends `WindowsSandboxSetupStartParams` with `mode = Unelevated` and no cwd, and then verifies two separate protocol events: the immediate `WindowsSandboxSetupStartResponse` reports `started = true`, and a later `windowsSandbox/setupCompleted` notification deserializes to `WindowsSandboxSetupCompletedNotification` with the same mode. The second test skips model-server setup entirely and instead sends a raw JSON-RPC request whose `cwd` is a relative string. It then reads the resulting error message and asserts the server rejects the request with JSON-RPC invalid-request semantics (`-32600`) and an error message containing `Invalid request`. Together these tests pin both the asynchronous completion-notification contract and the requirement that any provided cwd be absolute before sandbox setup begins.

#### Function details

##### `windows_sandbox_setup_start_emits_completion_notification`  (lines 21–64)

```
async fn windows_sandbox_setup_start_emits_completion_notification() -> Result<()>
```

**Purpose**: Verifies the happy path for `windowsSandbox/setupStart`: the RPC responds immediately and later emits a completion notification carrying the requested mode. It checks both halves of the asynchronous protocol.

**Data flow**: Creates an empty mock-responses server, a temporary Codex home, and writes config with `write_mock_responses_config_toml`. It initializes `TestAppServer`, sends `WindowsSandboxSetupStartParams { mode: Unelevated, cwd: None }`, reads the `JSONRPCResponse`, converts it to `WindowsSandboxSetupStartResponse`, and asserts `started` is true. It then waits for `windowsSandbox/setupCompleted`, deserializes `WindowsSandboxSetupCompletedNotification`, and asserts `payload.mode == WindowsSandboxSetupMode::Unelevated`.

**Call relations**: This Tokio test is invoked by the harness and uses the standard app-server initialization path before exercising the sandbox setup RPC. It depends on the config writer only to satisfy startup requirements.

*Call graph*: calls 1 internal fn (new); 11 external calls (new, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert!, assert_eq!, from_value (+1 more)).


##### `windows_sandbox_setup_start_rejects_relative_cwd`  (lines 67–91)

```
async fn windows_sandbox_setup_start_rejects_relative_cwd() -> Result<()>
```

**Purpose**: Checks that `windowsSandbox/setupStart` rejects a relative cwd before any setup work begins. It validates request-shape enforcement at the JSON-RPC boundary.

**Data flow**: Creates a temporary Codex home, initializes `TestAppServer`, sends a raw request named `windowsSandbox/setupStart` with JSON params `{ mode: "unelevated", cwd: "relative-root" }`, then reads the error message for that request id. It asserts the error code is `-32600` and the message contains `Invalid request`.

**Call relations**: This test is run directly by the harness and intentionally bypasses typed request helpers to send malformed params. It exercises the server's raw request validation path.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, json!, timeout).


### Remote control integration
This suite focuses on the app server's remote-control enrollment, pairing, status, and managed-client workflows.

### `app-server/tests/suite/v2/remote_control.rs`

`test` · `startup and request handling`

This module tests remote-control behavior at both RPC and startup levels. It defines `EnvVarGuard` for temporary environment mutation, helper readers for JSON-RPC responses/errors, and several fake backend structs built on `TcpListener` rather than wiremock so tests can precisely control request ordering and delayed responses. `BlockingRemoteControlBackend` pauses enrollment until the test explicitly completes it, allowing assertions that enable/disable RPCs block correctly around in-flight durable state changes. `PairingRemoteControlBackend` simulates enrollment followed by pairing-start and pairing-status POSTs, while `ClientManagementRemoteControlBackend` serves list and revoke endpoints and records request lines.

The tests cover managed requirements in two ways: all remote-control RPCs must reject with a fixed invalid-request message when `requirements.toml` sets `allow_remote_control = false`, and explicit startup with `RemoteControlStartupMode::EnabledEphemeral` must fail before binding a socket. They also verify `--listen off` behavior with persisted enrollment preferences in `StateRuntime`, including honoring a stored enabled preference, ignoring it when requirements disable remote control, and exiting when no persisted enable exists. RPC-level tests assert disabled and connecting status payloads, durable-vs-ephemeral preference persistence in `RemoteControlEnrollmentRecord`, pairing artifact retrieval, and client list/revoke behavior even while remote control is disabled. Low-level helpers parse raw HTTP requests, extract bodies using `Content-Length`, and write JSON or status responses directly to `TcpStream`.

#### Function details

##### `EnvVarGuard::set`  (lines 69–75)

```
fn set(key: &'static str, value: &OsStr) -> Self
```

**Purpose**: Temporarily sets an environment variable and remembers its previous value for restoration on drop.

**Data flow**: Reads the current value with `std::env::var_os`, unsafely sets the new value with `set_var`, and returns `EnvVarGuard { key, original }`.

**Call relations**: This helper is used here by the explicit-startup test and elsewhere in the broader suite whenever tests need scoped environment overrides.

*Call graph*: called by 26 (explicit_remote_control_startup_fails_when_disabled_by_requirements, remote_stdio_env_var_source_does_not_copy_local_env, stdio_server_propagates_explicit_local_env_var_source, stdio_server_propagates_whitelisted_env_vars, streamable_http_with_oauth_round_trip_impl, windows_elevated_enforces_deny_read_and_protects_setup_marker, windows_restricted_token_rejects_exact_and_glob_deny_read_policy, agent_identity_authapi_base_url_prefers_env_value, assert_agent_identity_plan_alias, auth_manager_rejects_env_personal_access_token_workspace_mismatch (+15 more)); 2 external calls (set_var, var_os).


##### `EnvVarGuard::drop`  (lines 79–86)

```
fn drop(&mut self)
```

**Purpose**: Restores or removes the guarded environment variable when the guard goes out of scope.

**Data flow**: On drop, unsafely either resets the variable to the saved original `OsString` or removes it entirely if there was no original value.

**Call relations**: Called automatically by Rust drop semantics after tests using `EnvVarGuard::set` finish.

*Call graph*: 2 external calls (remove_var, set_var).


##### `remote_control_preference`  (lines 89–98)

```
async fn remote_control_preference(
    state_db: &StateRuntime,
    websocket_url: &str,
) -> Result<Option<bool>>
```

**Purpose**: Reads the persisted durable remote-control enabled preference for the default client from the state database.

**Data flow**: Calls `state_db.get_remote_control_enrollment(websocket_url, "account_id", Some(DEFAULT_CLIENT_NAME))`, requires that an enrollment record exists via `context`, and returns its `remote_control_enabled` field as `Option<bool>`.

**Call relations**: Preference-persistence tests call this helper after enable/disable RPCs to verify whether durable state was updated.

*Call graph*: 1 external calls (get_remote_control_enrollment).


##### `wait_for_response`  (lines 100–106)

```
async fn wait_for_response(mcp: &mut TestAppServer, request_id: i64) -> Result<JSONRPCResponse>
```

**Purpose**: Reads a successful JSON-RPC response for a request id under the standard timeout.

**Data flow**: Waits for `mcp.read_stream_until_response_message(RequestId::Integer(request_id))` under `DEFAULT_TIMEOUT` and returns the resulting `JSONRPCResponse`.

**Call relations**: Several remote-control tests use this helper when they only need the raw success response and not a typed error path.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); called by 3 (disable_waits_for_in_flight_durable_enable, pairing_start_works_after_ephemeral_enable, rpc_updates_durable_preference_but_ephemeral_does_not); 2 external calls (Integer, timeout).


##### `assert_remote_control_disabled_by_requirements`  (lines 108–123)

```
async fn assert_remote_control_disabled_by_requirements(
    mcp: &mut TestAppServer,
    request_id: i64,
) -> Result<()>
```

**Purpose**: Asserts that a request failed because managed requirements disabled remote control.

**Data flow**: Reads the error response for the given request id under `DEFAULT_TIMEOUT`, extracts the `error` object, and asserts code `-32600` and the fixed `REMOTE_CONTROL_DISABLED_BY_REQUIREMENTS_MESSAGE`.

**Call relations**: The managed-requirements RPC rejection test loops over multiple request ids and passes each one through this helper.

*Call graph*: calls 1 internal fn (read_stream_until_error_message); called by 1 (managed_requirements_reject_all_remote_control_rpcs); 3 external calls (Integer, assert_eq!, timeout).


##### `managed_requirements_reject_all_remote_control_rpcs`  (lines 126–180)

```
async fn managed_requirements_reject_all_remote_control_rpcs() -> Result<()>
```

**Purpose**: Verifies that when `requirements.toml` disables remote control, the app server emits a disabled status notification and rejects every remote-control RPC.

**Data flow**: Writes `requirements.toml` with `allow_remote_control = false`, starts and initializes the app server, reads the initial `remoteControl/status/changed` notification and deserializes it to `RemoteControlStatusChangedNotification`, asserting `Disabled` status and no environment id. It then sends enable, disable, status-read, pairing-start, pairing-status, clients-list, and clients-revoke requests, and for each request id calls `assert_remote_control_disabled_by_requirements`.

**Call relations**: This top-level test covers the broad managed-requirements gate across both notifications and all exposed remote-control RPCs.

*Call graph*: calls 2 internal fn (new, assert_remote_control_disabled_by_requirements); 5 external calls (new, assert_eq!, from_value, write, timeout).


##### `managed_requirements_allow_remote_control_true_does_not_enable_or_block_it`  (lines 183–202)

```
async fn managed_requirements_allow_remote_control_true_does_not_enable_or_block_it() -> Result<()>
```

**Purpose**: Checks that explicitly allowing remote control in requirements neither auto-enables it nor blocks normal status reads.

**Data flow**: Writes `requirements.toml` with `allow_remote_control = true`, starts and initializes the app server, sends `remote_control_status_read`, decodes `RemoteControlStatusReadResponse`, and asserts the status is `Disabled`.

**Call relations**: This test complements the hard-disable case by proving the requirements file only constrains availability, not default enabled state.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


##### `explicit_remote_control_startup_fails_when_disabled_by_requirements`  (lines 206–249)

```
async fn explicit_remote_control_startup_fails_when_disabled_by_requirements() -> Result<()>
```

**Purpose**: Ensures explicit remote-control startup mode fails during process startup when managed requirements forbid remote control.

**Data flow**: Creates temp codex home, writes disabling `requirements.toml`, computes managed-config and Unix socket paths, builds `AppServerTransport` from the socket URL, sets `CODEX_HOME` with `EnvVarGuard`, then calls `run_main_with_transport_options` under `STARTUP_TIMEOUT` with `RemoteControlStartupMode::EnabledEphemeral`. It expects an `std::io::Error` of kind `InvalidInput`, asserts the exact message, and confirms the socket path was never created.

**Call relations**: Unlike the RPC tests, this one exercises the startup path directly through `run_main_with_transport_options` to prove the process refuses to start remote control at all.

*Call graph*: calls 3 internal fn (from_listen_url, set, with_managed_config_path_for_tests); 10 external calls (new, default, assert!, assert_eq!, run_main_with_transport_options, format!, current_exe, write, timeout, default).


##### `listen_off_honors_persisted_remote_control_enable`  (lines 252–276)

```
async fn listen_off_honors_persisted_remote_control_enable() -> Result<()>
```

**Purpose**: Verifies `--listen off` still initiates a remote-control connection when durable state says remote control is enabled.

**Data flow**: Creates temp codex home and a configured fake remote-control listener, computes the expected websocket URL, initializes `StateRuntime`, inserts a `RemoteControlEnrollmentRecord` with `remote_control_enabled: Some(true)`, then starts `TestAppServer` with `--listen off`. It waits for the listener to accept a connection within `STARTUP_TIMEOUT`.

**Call relations**: This startup-behavior test links persisted enrollment state to remote-control auto-connect behavior even when the normal app-server listener is disabled.

*Call graph*: calls 3 internal fn (new_with_args, configured_remote_control_listener, init); 3 external calls (new, format!, timeout).


##### `listen_off_ignores_persisted_enable_when_disabled_by_requirements`  (lines 279–324)

```
async fn listen_off_ignores_persisted_enable_when_disabled_by_requirements() -> Result<()>
```

**Purpose**: Ensures managed requirements override a persisted enabled preference when starting with `--listen off`.

**Data flow**: Creates temp codex home and configured listener, writes disabling `requirements.toml`, inserts an enabled `RemoteControlEnrollmentRecord` into `StateRuntime`, starts `TestAppServer` with `--listen off`, waits for process exit and asserts failure, confirms the fake listener did not accept a connection within 100 ms, and finally re-reads the enrollment record to assert the persisted `remote_control_enabled` value remains `Some(true)`.

**Call relations**: This test combines startup gating and durable state, proving requirements prevent connection attempts without mutating the stored preference.

*Call graph*: calls 3 internal fn (new_with_args, configured_remote_control_listener, init); 7 external calls (from_millis, new, assert!, assert_eq!, format!, write, timeout).


##### `listen_off_exits_without_persisted_remote_control_enable`  (lines 327–358)

```
async fn listen_off_exits_without_persisted_remote_control_enable() -> Result<()>
```

**Purpose**: Checks that `--listen off` exits unsuccessfully when there is no persisted enabled preference.

**Data flow**: Loops over two cases: no enrollment record and an enrollment record with `remote_control_enabled: Some(false)`. For each, it creates temp codex home and configured listener, optionally inserts the disabled enrollment record, starts `TestAppServer` with `--listen off`, waits for exit under `STARTUP_TIMEOUT`, and asserts the process did not succeed.

**Call relations**: This startup test complements the persisted-enable case by covering the absence of any durable reason to connect remote control.

*Call graph*: calls 3 internal fn (new_with_args, configured_remote_control_listener, init); 4 external calls (new, assert!, format!, timeout).


##### `remote_control_disable_returns_disabled_status`  (lines 361–380)

```
async fn remote_control_disable_returns_disabled_status() -> Result<()>
```

**Purpose**: Verifies the disable RPC succeeds and returns a disabled status payload even when no active connection exists.

**Data flow**: Creates temp codex home and configured listener, starts and initializes the app server, sends `remote_control_disable`, decodes `RemoteControlDisableResponse`, and asserts status `Disabled`, nonempty `server_name` and `installation_id`, and `environment_id == None`.

**Call relations**: This is a basic RPC-level status test for the disabled state.

*Call graph*: calls 2 internal fn (new, configured_remote_control_listener); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `remote_control_status_read_returns_disabled_status`  (lines 383–401)

```
async fn remote_control_status_read_returns_disabled_status() -> Result<()>
```

**Purpose**: Verifies status-read returns the disabled status payload before remote control has been enabled.

**Data flow**: Creates temp codex home, starts and initializes the app server, sends `remote_control_status_read`, decodes `RemoteControlStatusReadResponse`, and asserts disabled status, nonempty server name and installation id, and no environment id.

**Call relations**: This test covers the read-only status path in the initial disabled state.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `remote_control_enable_returns_connecting_status`  (lines 404–434)

```
async fn remote_control_enable_returns_connecting_status() -> Result<()>
```

**Purpose**: Checks that enable waits for enrollment to complete and then returns a connecting status with environment metadata.

**Data flow**: Creates temp codex home, starts a `BlockingRemoteControlBackend`, starts and initializes the app server, sends `remote_control_enable`, waits for the backend to observe the enroll HTTP request line, confirms no JSON-RPC response arrives before enrollment completes, calls `backend.complete_enrollment()`, then reads and decodes `RemoteControlEnableResponse` and asserts status `Connecting`, nonempty server name/installation id, and `environment_id = Some("environment-id")`.

**Call relations**: This test uses the blocking backend to prove the enable RPC is coupled to backend enrollment completion rather than returning optimistically.

*Call graph*: calls 2 internal fn (new, start); 7 external calls (from_millis, new, Integer, to_response, assert!, assert_eq!, timeout).


##### `disable_waits_for_in_flight_durable_enable`  (lines 437–465)

```
async fn disable_waits_for_in_flight_durable_enable() -> Result<()>
```

**Purpose**: Verifies a disable RPC waits for an in-flight durable enable to finish and then persists the disabled preference.

**Data flow**: Creates temp codex home, starts a blocking backend, captures its websocket URL, initializes `StateRuntime`, starts and initializes the app server, sends enable and waits until the enroll request is in flight, then sends disable. It asserts disable does not respond within 100 ms, completes enrollment, reads and decodes `RemoteControlDisableResponse`, and finally checks `remote_control_preference` in the state DB is `Some(false)`.

**Call relations**: This test exercises serialization between durable enable and disable operations and ties the final RPC result to persisted state.

*Call graph*: calls 4 internal fn (new, start, wait_for_response, init); 6 external calls (from_millis, new, Integer, to_response, assert_eq!, timeout).


##### `rpc_updates_durable_preference_but_ephemeral_does_not`  (lines 468–526)

```
async fn rpc_updates_durable_preference_but_ephemeral_does_not() -> Result<()>
```

**Purpose**: Checks that durable enable/disable RPCs update persisted enrollment preference, while ephemeral enable/disable RPCs leave durable state unchanged.

**Data flow**: Creates temp codex home, starts a blocking backend, captures websocket URL, initializes `StateRuntime`, starts and initializes the app server, then performs a sequence of RPCs: durable enable, ephemeral disable, durable disable, durable enable, durable disable, ephemeral enable. After each relevant step it reads the response and asserts `remote_control_preference` is respectively `Some(true)`, still `Some(true)`, `Some(false)`, `Some(true)`, `Some(false)`, and still `Some(false)`.

**Call relations**: This top-level test is the main persistence-policy regression case, contrasting durable and ephemeral RPC semantics against the same enrollment record.

*Call graph*: calls 4 internal fn (new, start, wait_for_response, init); 3 external calls (new, assert_eq!, timeout).


##### `remote_control_status_read_returns_connecting_status_after_enable`  (lines 529–561)

```
async fn remote_control_status_read_returns_connecting_status_after_enable() -> Result<()>
```

**Purpose**: Verifies status-read reflects `Connecting` after a successful enable/enrollment sequence.

**Data flow**: Creates temp codex home, starts a blocking backend, starts and initializes the app server, sends enable, waits for and asserts the enroll request line, completes enrollment, consumes the enable response, then sends status-read, decodes `RemoteControlStatusReadResponse`, and asserts `Connecting` plus populated server/environment/installation fields.

**Call relations**: This test links the enable mutation path to the subsequent read-only status path.

*Call graph*: calls 2 internal fn (new, start); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `remote_control_pairing_start_returns_pairing_artifacts`  (lines 564–658)

```
async fn remote_control_pairing_start_returns_pairing_artifacts() -> Result<()>
```

**Purpose**: Verifies pairing-start and pairing-status RPCs return the expected pairing codes and claimed status after enrollment.

**Data flow**: Creates temp codex home, starts a `PairingRemoteControlBackend`, starts and initializes the app server, enables remote control and consumes the response, waits for the enroll request and for a `remoteControl/status/changed` notification carrying `environmentId = environment-id`, then sends pairing-start with `manual_code = true`, decodes `RemoteControlPairingStartResponse`, and asserts pairing code, manual pairing code, environment id, and expiry timestamp. It then sends pairing-status twice—once by pairing code and once by manual pairing code—decodes `RemoteControlPairingStatusResponse` each time, and asserts `claimed: true`.

**Call relations**: This test covers the pairing RPC family after a normal durable enable path and uses the custom backend to validate both request ordering and response shaping.

*Call graph*: calls 2 internal fn (new, start); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `pairing_start_works_after_ephemeral_enable`  (lines 661–696)

```
async fn pairing_start_works_after_ephemeral_enable() -> Result<()>
```

**Purpose**: Checks that pairing-start also works after ephemeral enable, not just durable enable.

**Data flow**: Creates temp codex home, starts a pairing backend, starts and initializes the app server, sends ephemeral enable and waits for its response, then sends pairing-start with `manual_code = true`, reads the response, waits for the backend enroll request, decodes `RemoteControlPairingStartResponse`, and asserts the same pairing artifacts as the durable case.

**Call relations**: This test complements the durable pairing case by proving pairing can bootstrap enrollment even when enable was ephemeral.

*Call graph*: calls 3 internal fn (new, start, wait_for_response); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `remote_control_client_management_works_while_disabled`  (lines 699–757)

```
async fn remote_control_client_management_works_while_disabled() -> Result<()>
```

**Purpose**: Verifies client listing and revocation RPCs work even when remote control itself is disabled.

**Data flow**: Creates temp codex home, starts a `ClientManagementRemoteControlBackend`, starts and initializes the app server, sends `remote_control_clients_list` with environment id, cursor, limit, and descending order, decodes `RemoteControlClientsListResponse`, and asserts the returned `RemoteControlClient` fields and `next_cursor`. It then sends `remote_control_clients_revoke`, decodes `RemoteControlClientsRevokeResponse`, and finally waits for the backend to return the exact list and revoke HTTP request lines.

**Call relations**: This test isolates the client-management RPCs from connection status and proves they remain usable while remote control is otherwise disabled.

*Call graph*: calls 2 internal fn (new, start); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `ClientManagementRemoteControlBackend::start`  (lines 772–814)

```
async fn start(codex_home: &std::path::Path) -> Result<Self>
```

**Purpose**: Starts a fake backend that serves one clients-list request and one clients-revoke request, then records both request lines.

**Data flow**: Creates a configured listener, allocates a oneshot channel, and spawns a task that reads the first HTTP request, responds with JSON containing one client item and a cursor, reads the second request, responds with `204 No Content`, and sends the two request lines back through the channel. It returns a backend struct holding the receiver and task handle.

**Call relations**: The client-management test constructs this backend before starting the app server so the app server’s HTTP calls have a deterministic peer.

*Call graph*: calls 4 internal fn (configured_remote_control_listener, read_http_request, respond_with_json, respond_with_status); called by 1 (remote_control_client_management_works_while_disabled); 4 external calls (channel, json!, spawn, vec!).


##### `ClientManagementRemoteControlBackend::wait_for_requests`  (lines 816–821)

```
async fn wait_for_requests(&mut self) -> Result<Vec<String>>
```

**Purpose**: Returns the recorded list and revoke request lines from the fake client-management backend.

**Data flow**: Takes the stored oneshot receiver, errors if called twice, awaits it, and returns the `Vec<String>` of request lines.

**Call relations**: The client-management test calls this after both RPCs complete to assert the exact backend URLs and methods used.


##### `BlockingRemoteControlBackend::start`  (lines 825–872)

```
async fn start(codex_home: &std::path::Path) -> Result<Self>
```

**Purpose**: Starts a fake enrollment backend that exposes the enroll request immediately but delays the enrollment response until the test explicitly releases it.

**Data flow**: Creates a configured listener and websocket URL, allocates oneshot channels for the enroll request line and enrollment completion gate, and spawns a task that reads the enroll request, sends its request line through the channel, waits for the completion signal, responds with JSON enrollment data (`server_id`, `environment_id`, token, expiry), accepts one websocket connection, and then waits forever. On read failure it sends the error through the request channel.

**Call relations**: Enable/disable/status persistence tests use this backend to control exactly when enrollment completes and when the app server can transition to connecting state.

*Call graph*: calls 3 internal fn (configured_remote_control_listener, read_enroll_request, respond_with_json); called by 4 (disable_waits_for_in_flight_durable_enable, remote_control_enable_returns_connecting_status, remote_control_status_read_returns_connecting_status_after_enable, rpc_updates_durable_preference_but_ephemeral_does_not); 4 external calls (format!, channel, json!, spawn).


##### `BlockingRemoteControlBackend::wait_for_enroll_request`  (lines 874–880)

```
async fn wait_for_enroll_request(&mut self) -> Result<String>
```

**Purpose**: Returns the captured enroll request line from the blocking backend.

**Data flow**: Takes the stored oneshot receiver, errors if awaited twice, awaits it, and returns the request line string or propagated error.

**Call relations**: Tests call this after sending enable to prove the app server issued the expected enroll HTTP request before any response was returned.


##### `BlockingRemoteControlBackend::complete_enrollment`  (lines 882–888)

```
fn complete_enrollment(&mut self) -> Result<()>
```

**Purpose**: Releases the blocking backend so it can send the enrollment response.

**Data flow**: Takes the stored oneshot sender, errors if called twice, sends `()` to unblock the backend task, and maps send failure into an `anyhow` error.

**Call relations**: Tests invoke this after asserting the enable or disable RPC is still pending, allowing the app server to finish enrollment and continue.


##### `BlockingRemoteControlBackend::websocket_url`  (lines 890–892)

```
fn websocket_url(&self) -> &str
```

**Purpose**: Returns the websocket URL advertised by the fake enrollment backend.

**Data flow**: Borrows and returns the stored `websocket_url` string slice.

**Call relations**: Preference-persistence tests use this URL as the key when reading the corresponding enrollment record from `StateRuntime`.


##### `PairingRemoteControlBackend::start`  (lines 901–975)

```
async fn start(codex_home: &std::path::Path) -> Result<Self>
```

**Purpose**: Starts a fake backend that handles enrollment, pairing-start, and two pairing-status checks in sequence.

**Data flow**: Creates a configured listener, allocates a oneshot channel for the enroll request line, and spawns a task that reads the enroll request, sends its request line, responds with enrollment JSON, then reads the next request(s) to find the pairing-start request, responds with pairing JSON including both pairing codes and server/environment ids, and finally processes two pairing-status POSTs, asserting their request line and JSON body match first `{ pairing_code }` then `{ manual_pairing_code }`, responding with `{ claimed: true }` each time. On failure before enrollment capture it sends the error through the channel.

**Call relations**: Pairing tests use this backend to simulate the full post-enrollment pairing workflow with strict request-order and body assertions.

*Call graph*: calls 3 internal fn (configured_remote_control_listener, read_http_request, respond_with_json); called by 2 (pairing_start_works_after_ephemeral_enable, remote_control_pairing_start_returns_pairing_artifacts); 5 external calls (anyhow!, assert_eq!, channel, json!, spawn).


##### `PairingRemoteControlBackend::wait_for_enroll_request`  (lines 977–982)

```
async fn wait_for_enroll_request(&mut self) -> Result<String>
```

**Purpose**: Returns the captured enroll request line from the pairing backend.

**Data flow**: Takes the stored oneshot receiver, errors if awaited twice, awaits it, and returns the request line or propagated error.

**Call relations**: Pairing tests call this to confirm enrollment happened before or during pairing operations.


##### `PairingRemoteControlBackend::drop`  (lines 986–988)

```
fn drop(&mut self)
```

**Purpose**: Aborts the background task serving the fake pairing backend when the backend struct is dropped.

**Data flow**: Calls `self.server_task.abort()` in `Drop`.

**Call relations**: Runs automatically at test teardown to stop the spawned backend task.

*Call graph*: 1 external calls (abort).


##### `BlockingRemoteControlBackend::drop`  (lines 992–994)

```
fn drop(&mut self)
```

**Purpose**: Aborts the background task serving the fake blocking enrollment backend on drop.

**Data flow**: Calls `self.server_task.abort()` in `Drop`.

**Call relations**: Automatically cleans up the spawned backend task after tests using the blocking backend finish.

*Call graph*: 1 external calls (abort).


##### `ClientManagementRemoteControlBackend::drop`  (lines 998–1000)

```
fn drop(&mut self)
```

**Purpose**: Aborts the background task serving the fake client-management backend on drop.

**Data flow**: Calls `self.server_task.abort()` in `Drop`.

**Call relations**: Automatically cleans up the spawned backend task after the client-management test completes.

*Call graph*: 1 external calls (abort).


##### `configured_remote_control_listener`  (lines 1009–1025)

```
async fn configured_remote_control_listener(codex_home: &std::path::Path) -> Result<TcpListener>
```

**Purpose**: Creates a local TCP listener and writes app-server config/auth pointing remote-control HTTP traffic at it.

**Data flow**: Binds `TcpListener` to `127.0.0.1:0`, formats `http://<addr>/backend-api/` as the remote-control base URL, writes mock responses config with that URL for both responses and ChatGPT base URLs, writes ChatGPT auth with account id `account_id`, and returns the listener.

**Call relations**: All fake backend constructors and several startup tests call this helper to ensure the app server directs remote-control HTTP requests to the local listener.

*Call graph*: calls 1 internal fn (new); called by 7 (start, start, start, listen_off_exits_without_persisted_remote_control_enable, listen_off_honors_persisted_remote_control_enable, listen_off_ignores_persisted_enable_when_disabled_by_requirements, remote_control_disable_returns_disabled_status); 4 external calls (bind, write_chatgpt_auth, write_mock_responses_config_toml_with_chatgpt_base_url, format!).


##### `read_enroll_request`  (lines 1027–1030)

```
async fn read_enroll_request(listener: &TcpListener) -> Result<(String, BufReader<TcpStream>)>
```

**Purpose**: Reads one HTTP request from the listener and returns just its request line plus the buffered stream reader.

**Data flow**: Calls `read_http_request(listener)`, then extracts and returns `(request.request_line, request.reader)`.

**Call relations**: The blocking backend uses this helper because it only needs the request line and open stream to delay the enrollment response.

*Call graph*: calls 1 internal fn (read_http_request); called by 1 (start).


##### `read_http_request`  (lines 1032–1063)

```
async fn read_http_request(listener: &TcpListener) -> Result<HttpRequest>
```

**Purpose**: Accepts one TCP connection and parses a minimal HTTP request line, headers, and optional body.

**Data flow**: Accepts a `TcpStream`, wraps it in `BufReader`, reads the request line, then reads headers until a blank line while tracking `Content-Length` case-insensitively. If a body is present, it reads exactly that many bytes, converts them from UTF-8, and returns `HttpRequest { request_line, body, reader }`.

**Call relations**: All fake backend tasks use this helper to inspect raw app-server HTTP requests without a full HTTP framework.

*Call graph*: called by 3 (start, start, read_enroll_request); 5 external calls (new, from_utf8, new, accept, vec!).


##### `respond_with_json`  (lines 1065–1078)

```
async fn respond_with_json(stream: TcpStream, body: serde_json::Value) -> Result<()>
```

**Purpose**: Writes a simple HTTP 200 JSON response to a TCP stream.

**Data flow**: Serializes the provided `serde_json::Value` to a string, formats an HTTP response with `content-type: application/json`, correct `content-length`, and `connection: close`, writes it to the stream, and returns success.

**Call relations**: The fake enrollment, pairing, and client-management backends use this helper for successful JSON responses.

*Call graph*: called by 3 (start, start, start); 3 external calls (write_all, to_string, format!).


##### `respond_with_status`  (lines 1080–1091)

```
async fn respond_with_status(mut stream: TcpStream, status: &str, body: &str) -> Result<()>
```

**Purpose**: Writes a simple HTTP response with an arbitrary status line and plain-text body.

**Data flow**: Formats an HTTP response using the supplied status string, `content-type: text/plain`, computed `content-length`, and `connection: close`, writes it to the stream, and returns success.

**Call relations**: The client-management backend uses this helper to return `204 No Content` for revoke.

*Call graph*: called by 1 (start); 2 external calls (write_all, format!).
