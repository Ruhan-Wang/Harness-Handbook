# App-server integration suites — auth, config, discovery, and core RPC surfaces  `stage-23.1.4.1`

This stage checks the app server from the outside, the way a real editor or tool would use it. It is mostly shared support for startup and everyday server work, not the plugin system or conversation loop. These tests call RPCs, meaning request-and-reply commands sent to the server, and verify the public promises clients depend on.

The auth and account tests cover login state, API keys, ChatGPT tokens, device-code login, logout, token refresh, workspace limits, and Bedrock account reporting. The rate-limit tests check reading usage limits, asking owners for more credits, and spending reset credits, including bad logins and backend failures. Strict config and config RPC tests protect configuration: the server must reject unknown settings when asked, read settings with their sources, and write changes safely. Initialize tests check the first handshake between client and server.

The discovery tests make sure clients can list models, collaboration modes, permission profiles, experimental features, and provider capabilities in stable shapes. The filesystem, process, and Windows sandbox tests check safe local file access, running and stopping commands, and sandbox setup. Remote-control tests verify pairing, revoking, policy rules, and fake network behavior.

## Files in this stage

### Authentication and account flows
These suites cover end-to-end authentication entry points, account session management, and account-linked rate-limit operations exposed by the app server.

### `app-server/tests/suite/auth.rs`

`test` · `test run`

Authentication is one of the first things a client needs to understand: is the user logged in, by which method, and is it safe to show or use a token? This test file starts a real test app server, gives it temporary configuration files, sends it JSON-RPC requests (structured messages used to call server methods), and checks the replies.

The tests use a fresh temporary Codex home folder each time, so they do not depend on a developer’s real credentials. Small helper functions write different config.toml files: a normal config, a custom provider config, or a config that forces a particular login method. Another helper logs in with an API key through the same request path a real client would use.

Several tests ask for auth status under different conditions: no credentials, an API key, a personal access token from the environment, or stored ChatGPT credentials. Some tests use a fake HTTP server as a stand-in for the real auth service, like using a stage prop instead of calling the real bank. This lets the tests safely simulate success, expired tokens, and refresh failures. The important rule being checked is that the server must not leak tokens when it should not, and must recover when credentials become valid again.

#### Function details

##### `create_config_toml_custom_provider`  (lines 32–63)

```
fn create_config_toml_custom_provider(
    codex_home: &Path,
    requires_openai_auth: bool,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a test configuration file that points the app at a fake model provider. It can mark that provider as requiring OpenAI authentication or not, so tests can check how auth status changes when auth is optional.

**Data flow**: It receives the temporary Codex home path and a true-or-false flag. It builds the path to config.toml, creates text for the file, optionally includes the requires_openai_auth setting, and writes the file to disk. It returns success or a file-writing error.

**Call relations**: The custom-provider auth-status test calls this before starting the test server. After the file is written, the server reads it during startup and the test can verify that credentials are ignored when the selected provider does not require OpenAI auth.

*Call graph*: called by 1 (get_auth_status_with_api_key_when_auth_not_required); 3 external calls (join, format!, write).


##### `create_config_toml`  (lines 65–78)

```
fn create_config_toml(codex_home: &Path) -> std::io::Result<()>
```

**Purpose**: This helper writes the standard minimal configuration used by most auth tests. It gives the test server enough settings to start without depending on any real user config.

**Data flow**: It receives the temporary Codex home path, adds config.toml to that path, and writes a fixed TOML configuration string there. The result is either success or an input/output error from the file system.

**Call relations**: Most tests call this as their first setup step. Once the config file exists, the TestAppServer can be started and the test can focus on authentication behavior rather than unrelated setup details.

*Call graph*: called by 8 (get_auth_status_no_auth, get_auth_status_omits_token_after_permanent_refresh_failure, get_auth_status_omits_token_after_proactive_refresh_failure, get_auth_status_returns_token_after_proactive_refresh_recovery, get_auth_status_with_api_key, get_auth_status_with_api_key_no_include_token, get_auth_status_with_api_key_refresh_requested, get_auth_status_with_personal_access_token_omits_token); 2 external calls (join, write).


##### `create_config_toml_forced_login`  (lines 80–94)

```
fn create_config_toml_forced_login(codex_home: &Path, forced_method: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a configuration that forces the server to allow only a chosen login method. It is used to test that disabled login paths are actually rejected.

**Data flow**: It receives the temporary Codex home path and the forced login method name, inserts that method name into a config.toml string, and writes the file. It returns success or a file-writing error.

**Call relations**: The API-key-rejection test calls this with chatgpt before starting the server. That setup makes the later API-key login request fail in the expected way.

*Call graph*: called by 1 (login_api_key_rejected_when_forced_chatgpt); 3 external calls (join, format!, write).


##### `login_with_api_key_via_request`  (lines 96–107)

```
async fn login_with_api_key_via_request(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: This helper logs the test server in with an API key using the same request-and-response route a real client would use. It keeps repeated test setup short and verifies that the login itself succeeded before later checks run.

**Data flow**: It receives a mutable test server connection and an API key string. It sends an API-key login request, waits up to the shared timeout for the matching JSON-RPC response, converts the response into a LoginAccountResponse, and checks that the server accepted it as an API-key login. It returns success or any error from sending, waiting, converting, or the assertion path.

**Call relations**: Several auth-status tests call this after starting and initializing the server. It hands those tests a server that should now have API-key credentials stored, so they can ask getAuthStatus and inspect what is reported.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_login_account_api_key_request); called by 4 (get_auth_status_with_api_key, get_auth_status_with_api_key_no_include_token, get_auth_status_with_api_key_refresh_requested, get_auth_status_with_api_key_when_auth_not_required); 4 external calls (Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_no_auth`  (lines 110–134)

```
async fn get_auth_status_no_auth() -> Result<()>
```

**Purpose**: This test proves that a fresh server with no API key reports no authentication. It protects against accidentally treating environment credentials or missing files as a logged-in state.

**Data flow**: It creates a temporary home, writes the normal config, starts the server with OPENAI_API_KEY explicitly removed, initializes the server, and sends a get-auth-status request asking to include a token. It reads the response and checks that both the auth method and token are absent.

**Call relations**: The async test runner calls this test. Inside the test, the config helper prepares the environment, TestAppServer starts the subprocess-like test server, and the response conversion helper turns the raw JSON-RPC response into the auth-status data being asserted.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_with_api_key`  (lines 137–162)

```
async fn get_auth_status_with_api_key() -> Result<()>
```

**Purpose**: This test checks the normal API-key path: after logging in with an API key, the server should report API-key authentication and return the key when the caller explicitly asks for it.

**Data flow**: It creates a temporary home, writes normal config, starts and initializes the server, logs in with sk-test-key through the helper, then sends a get-auth-status request with include_token set to true. It converts the reply and checks that the method is ApiKey and the token matches the key used for login.

**Call relations**: The test runner invokes this case. It relies on create_config_toml for setup and login_with_api_key_via_request to put the server into the authenticated state before exercising the auth-status request.

*Call graph*: calls 3 internal fn (new, create_config_toml, login_with_api_key_via_request); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_with_personal_access_token_omits_token`  (lines 165–220)

```
async fn get_auth_status_with_personal_access_token_omits_token() -> Result<()>
```

**Purpose**: This test ensures that a personal access token is recognized but not echoed back to the client, even when token inclusion is requested. That matters because personal access tokens are sensitive and should not be casually exposed.

**Data flow**: It writes normal config, starts a fake HTTP auth API, and teaches that fake server to answer a whoami request only when the expected bearer token is sent. It then starts the app server with CODEX_ACCESS_TOKEN and the fake auth API base URL in the environment, requests auth status with include_token set to true, and checks that the method is PersonalAccessToken but auth_token is still absent.

**Call relations**: The test runner starts this scenario. The mock server stands in for the external auth service, while TestAppServer exercises the real app-server code path that validates the token and builds the get-auth-status response.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 12 external calls (given, start, new, new, Integer, to_response, assert_eq!, json!, timeout, header (+2 more)).


##### `get_auth_status_with_api_key_when_auth_not_required`  (lines 223–253)

```
async fn get_auth_status_with_api_key_when_auth_not_required() -> Result<()>
```

**Purpose**: This test checks that API-key credentials are hidden when the selected model provider does not require OpenAI authentication. In that situation, the server should tell the client auth is not required instead of presenting the API key as active auth.

**Data flow**: It writes a custom-provider config with requires_openai_auth set to false, starts and initializes the server, logs in with an API key, and then asks for auth status including the token. The response is checked to have no auth method, no token, and requires_openai_auth equal to false.

**Call relations**: The test uses create_config_toml_custom_provider to shape the server’s startup config, then uses the shared API-key login helper. The final auth-status request confirms that provider requirements override the presence of stored credentials.

*Call graph*: calls 3 internal fn (new, create_config_toml_custom_provider, login_with_api_key_via_request); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_with_api_key_no_include_token`  (lines 256–281)

```
async fn get_auth_status_with_api_key_no_include_token() -> Result<()>
```

**Purpose**: This test verifies that the server withholds the API key unless the request explicitly asks for the token. It guards against leaking credentials by default.

**Data flow**: It creates normal test config, starts and initializes the server, logs in with an API key, then sends get-auth-status parameters where include_token is omitted rather than set to true. It converts the response and checks that the auth method is ApiKey but the token field is empty.

**Call relations**: The test runner calls this case as part of the auth suite. It reuses the common config writer and API-key login helper, then focuses on the difference made by omitting the include_token field in the wire request.

*Call graph*: calls 3 internal fn (new, create_config_toml, login_with_api_key_via_request); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `get_auth_status_with_api_key_refresh_requested`  (lines 284–315)

```
async fn get_auth_status_with_api_key_refresh_requested() -> Result<()>
```

**Purpose**: This test checks that asking for a token refresh does not break API-key authentication. API keys do not need OAuth-style refreshing, so the server should simply return the existing API-key status.

**Data flow**: It writes normal config, starts and initializes the server, logs in with sk-test-key, and sends get-auth-status with both include_token and refresh_token set to true. The response is expected to report ApiKey, return the same key, and say OpenAI auth is required.

**Call relations**: This test follows the same setup path as the other API-key tests, using create_config_toml and login_with_api_key_via_request. The difference is that it exercises the refresh_token option and confirms the server treats it harmlessly for API keys.

*Call graph*: calls 3 internal fn (new, create_config_toml, login_with_api_key_via_request); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `get_auth_status_omits_token_after_permanent_refresh_failure`  (lines 318–396)

```
async fn get_auth_status_omits_token_after_permanent_refresh_failure() -> Result<()>
```

**Purpose**: This test checks the safe behavior after a ChatGPT token refresh fails permanently. The server should still know the account was a ChatGPT login, but it must not return a stale or unsafe access token.

**Data flow**: It writes normal config and a stored ChatGPT credential file with stale access and refresh tokens. A fake token endpoint is set up to return a 401 error saying the refresh token was reused, which represents a permanent refresh failure. The server is started with refresh requests redirected to that fake endpoint, then auth status is requested twice with refresh enabled; both responses must show Chatgpt auth with no token.

**Call relations**: The test runner invokes this scenario. The stored fixture creates the initial login state, the mock server supplies the failing external refresh response, and the app server’s auth-status path is checked to avoid returning the stale token and to keep that behavior stable on the second request.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 13 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, format!, json! (+3 more)).


##### `get_auth_status_omits_token_after_proactive_refresh_failure`  (lines 399–463)

```
async fn get_auth_status_omits_token_after_proactive_refresh_failure() -> Result<()>
```

**Purpose**: This test checks what happens when the server proactively refreshes an old ChatGPT token and that refresh fails. Even though the caller did not request a refresh, the server should not expose the stale token once refresh has failed.

**Data flow**: It writes normal config and stored ChatGPT credentials whose last refresh time is nine days old. It starts a fake token endpoint that returns a permanent 401 refresh-token error, starts the app server pointed at that endpoint, and sends get-auth-status with include_token true but refresh_token false. The expected response is Chatgpt auth with no token.

**Call relations**: This test is called by the async test harness. It uses the config helper, stored auth fixture, and mock server to create the conditions for a background-style proactive refresh, then verifies the app server’s auth-status response remains safe.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 15 external calls (days, given, start, new, new, now, Integer, to_response, write_chatgpt_auth, assert_eq! (+5 more)).


##### `get_auth_status_returns_token_after_proactive_refresh_recovery`  (lines 466–563)

```
async fn get_auth_status_returns_token_after_proactive_refresh_recovery() -> Result<()>
```

**Purpose**: This test proves that the server can recover after a failed proactive refresh when valid credentials appear again on disk. It prevents a one-time refresh failure from permanently hiding a later good token.

**Data flow**: It first creates normal config and stale ChatGPT credentials, then points the server at a fake token endpoint that returns permanent refresh failures. A get-auth-status request with refresh enabled returns Chatgpt auth with no token, as expected. The test then overwrites the stored credentials with a fresh access token and recent refresh time, sends another auth-status request without forcing refresh, and checks that the recovered access token is returned.

**Call relations**: The test runner executes this longer recovery story. It combines create_config_toml, the ChatGPT auth fixture writer, the fake token endpoint, and TestAppServer requests to show both failure behavior and later recovery through the same server process.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 15 external calls (days, given, start, new, new, now, Integer, to_response, write_chatgpt_auth, assert_eq! (+5 more)).


##### `login_api_key_rejected_when_forced_chatgpt`  (lines 566–588)

```
async fn login_api_key_rejected_when_forced_chatgpt() -> Result<()>
```

**Purpose**: This test verifies that configuration can disable API-key login when ChatGPT login is required. It checks that the server returns a clear error message instead of silently accepting the wrong login method.

**Data flow**: It creates a temporary home, writes config.toml with forced_login_method set to chatgpt, starts and initializes the server, and sends an API-key login request. Instead of reading a normal response, it waits for the matching JSON-RPC error and checks that the message tells the user to use ChatGPT login instead.

**Call relations**: The test runner calls this as an enforcement case. The forced-login config helper creates the rule, TestAppServer sends the forbidden login request, and the test confirms the server reports the intended error.

*Call graph*: calls 2 internal fn (new, create_config_toml_forced_login); 4 external calls (new, Integer, assert_eq!, timeout).


### `app-server/tests/suite/v2/account.rs`

`test` · `test run`

This test file is a safety net for the app server’s account system. The account system decides who the user is, how they are signed in, whether OpenAI authentication is required, and what the server should tell the client when that state changes. Without these tests, a change could silently break login, leave stale credentials on disk, fail to notify the client, or accept tokens for the wrong workspace.

The tests build small temporary Codex home folders, write a minimal config file, start a real test app server, and then talk to it through its JSON-RPC protocol. JSON-RPC is a simple request-and-response message format; here it is used like a conversation between a client and the app server. Some tests also start a fake HTTP server with WireMock. That fake server pretends to be OpenAI or an OAuth login service, so the tests can force success, failure, or expired-token cases without reaching the real internet.

The file covers both stored credentials, such as an API key in auth.json, and external ChatGPT tokens supplied by a host app. It also checks notification behavior: after login or logout, the server must tell the client that the account changed. Several tests focus on failure paths, because those are where users would otherwise see confusing login loops or hidden broken state.

#### Function details

##### `create_config_toml`  (lines 81–142)

```
fn create_config_toml(codex_home: &Path, params: CreateConfigTomlParams) -> std::io::Result<()>
```

**Purpose**: Creates a small config.toml file inside a temporary Codex home folder for a test. Tests use it to choose login rules, required authentication, model provider settings, and optional workspace restrictions.

**Data flow**: It receives a folder path and a set of optional settings. It turns those settings into TOML text, filling in sensible defaults when a setting is missing, then writes that text to config.toml in the folder. The output is the file on disk, or an I/O error if writing fails.

**Call relations**: Most tests call this first, before starting TestAppServer. It sets the stage for each scenario, such as forcing ChatGPT login, requiring OpenAI auth, pointing model requests at a fake server, or configuring Amazon Bedrock.

*Call graph*: called by 27 (account_read_refresh_token_is_noop_in_external_mode, external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized, get_account_no_auth, get_account_omits_chatgpt_after_permanent_refresh_failure, get_account_when_auth_not_required, get_account_with_api_key, get_account_with_aws_provider (+15 more)); 4 external calls (join, new, format!, write).


##### `mock_device_code_usercode`  (lines 144–154)

```
async fn mock_device_code_usercode(server: &MockServer, interval_seconds: u64)
```

**Purpose**: Sets up the fake login server to successfully start a ChatGPT device-code login. Device-code login is the flow where the app shows a short code and the user enters it in a browser.

**Data flow**: It receives a fake HTTP server and a polling interval. It registers a POST response for the user-code endpoint that returns a device auth id, a visible user code, and the interval. It changes the fake server’s future behavior; it does not return a value.

**Call relations**: The device-code success, failure-after-start, and cancellation tests call this before asking the app server to begin device-code login. It provides the first step of the simulated OAuth conversation.

*Call graph*: called by 3 (login_account_chatgpt_device_code_can_be_cancelled, login_account_chatgpt_device_code_failure_notifies_without_account_update, login_account_chatgpt_device_code_succeeds_and_notifies); 5 external calls (given, new, json!, method, path).


##### `mock_device_code_usercode_failure`  (lines 156–162)

```
async fn mock_device_code_usercode_failure(server: &MockServer, status: u16)
```

**Purpose**: Sets up the fake login server to reject the first device-code login request. Tests use it to confirm the app server reports that device-code login is unavailable or failed to start.

**Data flow**: It receives a fake HTTP server and an HTTP status code. It registers a POST response for the user-code endpoint that returns only that failure status. The fake server is changed so the next matching request fails.

**Call relations**: The disabled-device-code test calls this before starting login. When the app server tries to request a code, the fake failure makes the server return a JSON-RPC error instead of starting a login attempt.

*Call graph*: called by 1 (login_account_chatgpt_device_code_returns_error_when_disabled); 4 external calls (given, new, method, path).


##### `mock_device_code_token_success`  (lines 164–174)

```
async fn mock_device_code_token_success(server: &MockServer)
```

**Purpose**: Sets up the fake login server to say that the user completed device-code login. It returns the temporary OAuth values needed for the app server to exchange for real tokens.

**Data flow**: It receives a fake HTTP server. It registers a successful POST response for the device-token endpoint containing an authorization code, code challenge, and verifier. The fake server later sends that JSON when polled.

**Call relations**: The successful device-code login test uses this after setting up the user-code response. It provides the middle step between showing the user code and receiving final auth tokens.

*Call graph*: called by 1 (login_account_chatgpt_device_code_succeeds_and_notifies); 5 external calls (given, new, json!, method, path).


##### `mock_device_code_token_failure`  (lines 176–182)

```
async fn mock_device_code_token_failure(server: &MockServer, status: u16)
```

**Purpose**: Sets up the fake login server so polling for device-code completion fails. Tests use it for failed and cancelled login flows.

**Data flow**: It receives a fake HTTP server and an HTTP status code. It registers a POST response for the device-token endpoint that returns that status. The result is a fake server prepared to make polling fail.

**Call relations**: The failure and cancellation device-code tests call this after the user-code mock. In the failure test the app server reports login completion with success false; in the cancellation test it helps ensure no account is written.

*Call graph*: called by 2 (login_account_chatgpt_device_code_can_be_cancelled, login_account_chatgpt_device_code_failure_notifies_without_account_update); 4 external calls (given, new, method, path).


##### `mock_device_code_oauth_token`  (lines 184–194)

```
async fn mock_device_code_oauth_token(server: &MockServer, id_token: &str)
```

**Purpose**: Sets up the fake OAuth token endpoint to return final ChatGPT tokens after device-code login succeeds.

**Data flow**: It receives a fake HTTP server and an id token string. It registers a successful POST response for /oauth/token with that id token plus access and refresh tokens. The fake server then completes the simulated login exchange.

**Call relations**: The successful device-code login test calls this as the last server-side mock. After the app server polls successfully, it uses this endpoint to finish login and then emits account notifications.

*Call graph*: called by 1 (login_account_chatgpt_device_code_succeeds_and_notifies); 5 external calls (given, new, json!, method, path).


##### `logout_account_removes_auth_and_notifies`  (lines 197–254)

```
async fn logout_account_removes_auth_and_notifies() -> Result<()>
```

**Purpose**: Checks that logging out removes stored credentials and tells the client the account is gone.

**Data flow**: The test creates a temporary home, writes config, stores an API key, starts the test server, and sends a logout request. It expects a successful logout response, an account-updated notification with no auth mode or plan, deletion of auth.json, and a later get-account response with no account.

**Call relations**: The Rust test runner calls this as an async test. It uses create_config_toml, login_with_api_key, TestAppServer, and response parsing helpers to exercise the server’s logout path end to end.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, default); 9 external calls (new, Integer, default, to_response, assert!, assert_eq!, bail!, login_with_api_key, timeout).


##### `set_auth_token_updates_account_and_notifies`  (lines 257–331)

```
async fn set_auth_token_updates_account_and_notifies() -> Result<()>
```

**Purpose**: Checks that externally supplied ChatGPT auth tokens become the current account and trigger an account update notification.

**Data flow**: The test prepares a config that requires OpenAI auth, creates a fake model server, writes a models cache, builds a signed-looking id token with email, plan, and workspace, then sends a ChatGPT-token login request. It expects a successful response, a notification showing ChatGPT token auth and Pro plan, and get-account data containing the same email and plan.

**Call relations**: The test runner invokes it. It relies on create_config_toml and encode_id_token to set up the scenario, then uses the app server protocol to verify the external-token login path.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 11 external calls (default, start, new, Integer, encode_id_token, to_response, write_models_cache, assert_eq!, bail!, format! (+1 more)).


##### `account_read_refresh_token_is_noop_in_external_mode`  (lines 334–409)

```
async fn account_read_refresh_token_is_noop_in_external_mode() -> Result<()>
```

**Purpose**: Checks that asking get-account to refresh tokens does not trigger a token-refresh request when the account came from external tokens.

**Data flow**: The test logs in with externally supplied ChatGPT tokens, then calls get-account with refresh_token set to true. It expects the normal account response and then waits briefly to confirm the server does not ask the client for refreshed tokens.

**Call relations**: The test runner calls it. It uses create_config_toml and the token-login request path, then watches the server stream to make sure no account/chatgptAuthTokens/refresh request appears.

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

**Purpose**: Replies to the app server when it asks the client to refresh external ChatGPT tokens. It is a helper for the test where a 401 response causes token refresh and retry.

**Data flow**: It reads the next server request from the TestAppServer stream, verifies that it is a ChatGPT-token refresh request caused by an unauthorized response, builds a refresh response with the supplied token, workspace, and plan, and sends that response back. It returns success or an error if the expected request is not seen.

**Call relations**: external_auth_refreshes_on_unauthorized calls this while a turn is in progress. The helper plays the role of the client side of the protocol, handing fresh tokens back to the server so the model request can be retried.

*Call graph*: calls 2 internal fn (read_stream_until_request_message, send_response); called by 1 (external_auth_refreshes_on_unauthorized); 4 external calls (assert_eq!, bail!, to_value, timeout).


##### `external_auth_refreshes_on_unauthorized`  (lines 438–556)

```
async fn external_auth_refreshes_on_unauthorized() -> Result<()>
```

**Purpose**: Checks that external ChatGPT auth is refreshed when a model request gets an unauthorized response, and that the server retries with the new token.

**Data flow**: The test sets up a fake model server that first returns HTTP 401 and then returns a successful streamed response. It logs in with an initial token, starts a thread and turn, answers the server’s refresh request with a new token, then verifies two model requests were made: first with the old bearer token and then with the refreshed one.

**Call relations**: The test runner invokes it. It uses create_config_toml for setup, response-sequence helpers for the fake model API, and respond_to_refresh_request to simulate the client providing replacement tokens.

*Call graph*: calls 6 internal fn (new, new_with_env, create_config_toml, respond_to_refresh_request, mount_response_sequence, sse); 13 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert_eq!, format! (+3 more)).


##### `external_auth_refresh_error_fails_turn`  (lines 560–673)

```
async fn external_auth_refresh_error_fails_turn() -> Result<()>
```

**Purpose**: Checks that if the client refuses or fails to refresh external ChatGPT tokens, the active conversation turn fails instead of continuing with bad credentials.

**Data flow**: The test makes the fake model API return unauthorized, starts a turn, waits for the server’s refresh request, and sends back a JSON-RPC error saying refresh failed. It then reads the turn-completed notification and expects the turn status to be Failed with an error attached.

**Call relations**: The test runner calls it. It drives the same unauthorized-refresh path as the success test, but uses send_error to make sure the server’s failure handling is visible to the client.

*Call graph*: calls 4 internal fn (new, new_with_env, create_config_toml, mount_response_sequence); 16 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq! (+6 more)).


##### `external_auth_refresh_mismatched_workspace_fails_turn`  (lines 677–797)

```
async fn external_auth_refresh_mismatched_workspace_fails_turn() -> Result<()>
```

**Purpose**: Checks that refreshed external tokens are rejected if they belong to a workspace that is not allowed by configuration.

**Data flow**: The test configures one allowed workspace, logs in with a token for that workspace, then makes the model API return unauthorized. When the server asks for refreshed tokens, the test supplies a token and workspace id for a different workspace. The turn is expected to finish as Failed.

**Call relations**: The test runner invokes it. It combines create_config_toml’s forced workspace setting with the refresh request flow to verify that workspace restrictions still apply after token refresh.

*Call graph*: calls 4 internal fn (new, new_with_env, create_config_toml, mount_response_sequence); 17 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq! (+7 more)).


##### `external_auth_refresh_invalid_access_token_fails_turn`  (lines 801–914)

```
async fn external_auth_refresh_invalid_access_token_fails_turn() -> Result<()>
```

**Purpose**: Checks that refreshed external auth fails safely when the new access token is malformed.

**Data flow**: The test logs in with a valid initial token, starts a turn against a fake server that returns unauthorized, then replies to the refresh request with the string not-a-jwt as the new access token. The server responds to the turn and sends a completion notification showing the turn failed.

**Call relations**: The test runner calls it. It follows the unauthorized-refresh path but uses deliberately invalid token data, proving that the server validates what the client sends back.

*Call graph*: calls 4 internal fn (new, new_with_env, create_config_toml, mount_response_sequence); 17 external calls (default, start, new, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq! (+7 more)).


##### `login_account_api_key_succeeds_and_notifies`  (lines 917–962)

```
async fn login_account_api_key_succeeds_and_notifies() -> Result<()>
```

**Purpose**: Checks that API-key login succeeds, writes credentials, and sends the expected login and account notifications.

**Data flow**: The test creates config, starts the server, sends an API-key login request, and expects an ApiKey login response. It then reads a login-completed notification marked successful, an account-updated notification showing API-key auth, and confirms auth.json exists on disk.

**Call relations**: The test runner invokes it. It uses create_config_toml and TestAppServer to exercise the normal API-key login path from client request through saved file and notifications.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (new, Integer, default, to_response, assert!, assert_eq!, bail!, assert_eq!, timeout).


##### `login_account_api_key_rejected_when_forced_chatgpt`  (lines 965–992)

```
async fn login_account_api_key_rejected_when_forced_chatgpt() -> Result<()>
```

**Purpose**: Checks that API-key login is blocked when configuration requires ChatGPT login.

**Data flow**: The test writes config with forced_login_method set to chatgpt, starts the server, sends an API-key login request, and reads a JSON-RPC error. The expected error message tells the user to use ChatGPT login instead.

**Call relations**: The test runner calls it. It depends on create_config_toml to create the forced-login condition, then verifies the account request layer enforces that policy.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (default, new, Integer, assert_eq!, timeout).


##### `login_account_chatgpt_rejected_when_forced_api`  (lines 995–1020)

```
async fn login_account_chatgpt_rejected_when_forced_api() -> Result<()>
```

**Purpose**: Checks the opposite policy: ChatGPT login is blocked when configuration requires API-key login.

**Data flow**: The test writes config with forced_login_method set to api, starts the server, sends a ChatGPT login request, and expects a JSON-RPC error message telling the user to use API-key login.

**Call relations**: The test runner invokes it. It uses create_config_toml to set the forced method and then confirms the ChatGPT login entry point refuses to start.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (default, new, Integer, assert_eq!, timeout).


##### `login_account_chatgpt_device_code_returns_error_when_disabled`  (lines 1023–1076)

```
async fn login_account_chatgpt_device_code_returns_error_when_disabled() -> Result<()>
```

**Purpose**: Checks that device-code login fails cleanly when the login service does not support starting that flow.

**Data flow**: The test configures a fake issuer, makes the user-code endpoint return 404, starts the app server with that issuer, and sends a device-code login request. It expects a JSON-RPC error mentioning that device-code login is not enabled, no login-completed notification, and no auth.json file.

**Call relations**: The test runner calls it. It uses mock_device_code_usercode_failure to make the first network call fail and verifies the app server does not pretend a login was started.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, mock_device_code_usercode_failure); 9 external calls (default, from_millis, start, new, Integer, write_models_cache, assert!, format!, timeout).


##### `login_account_chatgpt_device_code_succeeds_and_notifies`  (lines 1079–1160)

```
async fn login_account_chatgpt_device_code_succeeds_and_notifies() -> Result<()>
```

**Purpose**: Checks the full successful ChatGPT device-code login flow.

**Data flow**: The test prepares fake user-code, device-token, and OAuth-token responses. It sends a device-code login request, expects a response containing a login id, verification URL, and user code, then waits for login-completed success and account-updated notifications. It also confirms auth.json was created.

**Call relations**: The test runner invokes it. It uses all three device-code mock helpers to simulate the external login service, then observes the app server’s protocol messages and saved credentials.

*Call graph*: calls 6 internal fn (new, new_with_env, create_config_toml, mock_device_code_oauth_token, mock_device_code_token_success, mock_device_code_usercode); 12 external calls (default, start, new, Integer, encode_id_token, to_response, write_models_cache, assert!, assert_eq!, bail! (+2 more)).


##### `login_account_chatgpt_device_code_failure_notifies_without_account_update`  (lines 1163–1235)

```
async fn login_account_chatgpt_device_code_failure_notifies_without_account_update() -> Result<()>
```

**Purpose**: Checks that a device-code login that starts but later fails reports failure without changing the account.

**Data flow**: The test lets the user-code step succeed but makes the polling step fail with HTTP 500. It expects the initial login response, then a login-completed notification with success false and an error message. It also checks that no account-updated notification appears and no auth.json is created.

**Call relations**: The test runner calls it. It uses mock_device_code_usercode and mock_device_code_token_failure to model a login that begins normally but cannot complete.

*Call graph*: calls 4 internal fn (new_with_env, create_config_toml, mock_device_code_token_failure, mock_device_code_usercode); 12 external calls (default, from_millis, start, new, Integer, to_response, write_models_cache, assert!, assert_eq!, bail! (+2 more)).


##### `login_account_chatgpt_device_code_can_be_cancelled`  (lines 1238–1319)

```
async fn login_account_chatgpt_device_code_can_be_cancelled() -> Result<()>
```

**Purpose**: Checks that an in-progress device-code login can be cancelled and does not create an account.

**Data flow**: The test starts device-code login with a polling interval, captures the returned login id, sends a cancel-login request for that id, and expects a Canceled response. It then expects a login-completed failure notification, no account-updated notification, and no auth.json file.

**Call relations**: The test runner invokes it. It uses the device-code mocks to create a pending login, then exercises the cancel-login request path.

*Call graph*: calls 4 internal fn (new_with_env, create_config_toml, mock_device_code_token_failure, mock_device_code_usercode); 12 external calls (default, from_millis, start, new, Integer, to_response, write_models_cache, assert!, assert_eq!, bail! (+2 more)).


##### `login_account_chatgpt_start_can_be_cancelled`  (lines 1324–1385)

```
async fn login_account_chatgpt_start_can_be_cancelled() -> Result<()>
```

**Purpose**: Checks that the browser-based ChatGPT login flow can be cancelled after it starts.

**Data flow**: The test starts ChatGPT login, verifies the returned auth URL points back to localhost, sends a cancel request for the login id, and reads a login-completed notification showing failure with an error. It waits briefly to confirm no account update is sent.

**Call relations**: The test runner calls it, serialized with other login-server tests because this flow binds a fixed local port. It uses create_config_toml and the app server’s login and cancel requests.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (from_millis, new, Integer, default, to_response, assert!, bail!, assert_eq!, timeout).


##### `login_account_chatgpt_uses_debug_oauth_overrides`  (lines 1390–1437)

```
async fn login_account_chatgpt_uses_debug_oauth_overrides() -> Result<()>
```

**Purpose**: Checks that debug environment variables can change the OAuth issuer and client id used for ChatGPT login.

**Data flow**: The test starts the server with environment variables for a custom issuer and client id, starts ChatGPT login, parses the returned auth URL, and checks that the URL origin and client_id query parameter match the overrides. It then cancels the login.

**Call relations**: The test runner invokes it in the serialized login-port group. It verifies that environment-based debug settings flow into the generated OAuth URL.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 8 external calls (new, parse, Integer, default, to_response, assert_eq!, bail!, timeout).


##### `set_auth_token_cancels_active_chatgpt_login`  (lines 1442–1506)

```
async fn set_auth_token_cancels_active_chatgpt_login() -> Result<()>
```

**Purpose**: Checks that supplying external ChatGPT tokens cancels any already-running browser-based ChatGPT login attempt.

**Data flow**: The test starts a ChatGPT login and saves its login id. It then sends an external-token login request with a valid encoded token and expects success plus an account update. Finally, it tries to cancel the old login id and expects NotFound, proving the old login was already removed.

**Call relations**: The test runner calls it in the serialized login-port group. It connects the browser-login path and external-token path to make sure they do not both remain active.

*Call graph*: calls 3 internal fn (new, new, create_config_toml); 8 external calls (new, Integer, default, encode_id_token, to_response, assert_eq!, bail!, timeout).


##### `login_account_chatgpt_includes_forced_workspace_query_param`  (lines 1511–1540)

```
async fn login_account_chatgpt_includes_forced_workspace_query_param() -> Result<()>
```

**Purpose**: Checks that a single forced ChatGPT workspace is included in the login URL.

**Data flow**: The test writes config with one forced workspace id, starts ChatGPT login, and inspects the returned auth URL. It expects the URL to contain an allowed_workspace_id parameter with that workspace id.

**Call relations**: The test runner invokes it in the serialized login-port group. It uses create_config_toml’s forced workspace setting and verifies that login URL construction passes that restriction to the identity service.

*Call graph*: calls 2 internal fn (new, create_config_toml); 7 external calls (default, new, Integer, to_response, assert!, bail!, timeout).


##### `login_account_chatgpt_includes_forced_workspace_allowlist_query_param`  (lines 1545–1584)

```
async fn login_account_chatgpt_includes_forced_workspace_allowlist_query_param() -> Result<()>
```

**Purpose**: Checks that multiple allowed ChatGPT workspace ids are included in the login URL as an allowlist.

**Data flow**: The test writes config with two forced workspace ids, starts ChatGPT login, parses the returned URL, and collects allowed_workspace_id query values. It expects one value containing both workspace ids joined by a comma.

**Call relations**: The test runner calls it in the serialized login-port group. It verifies the multi-workspace form of the same login URL restriction tested by the single-workspace case.

*Call graph*: calls 2 internal fn (new, create_config_toml); 9 external calls (default, new, parse, Integer, to_response, assert_eq!, bail!, timeout, vec!).


##### `get_account_no_auth`  (lines 1587–1616)

```
async fn get_account_no_auth() -> Result<()>
```

**Purpose**: Checks the get-account response when no user credentials exist but OpenAI authentication is required.

**Data flow**: The test creates config with requires_openai_auth true, starts the server without an API key, sends get-account, and expects account to be None while requires_openai_auth is true.

**Call relations**: The test runner invokes it. It uses create_config_toml and the get-account request to confirm the server reports both absence of credentials and the need for authentication.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_with_api_key`  (lines 1619–1660)

```
async fn get_account_with_api_key() -> Result<()>
```

**Purpose**: Checks that get-account reports an API-key account after API-key login.

**Data flow**: The test creates config requiring auth, logs in with an API key through the app server, then sends get-account. It expects account to be ApiKey and requires_openai_auth to remain true.

**Call relations**: The test runner calls it. It first exercises the login request path and then checks that account lookup reflects the newly saved API-key state.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_when_auth_not_required`  (lines 1663–1694)

```
async fn get_account_when_auth_not_required() -> Result<()>
```

**Purpose**: Checks that get-account says authentication is not required when the selected provider does not require OpenAI auth.

**Data flow**: The test writes config with requires_openai_auth false, starts the server, sends get-account, and expects no account plus requires_openai_auth false.

**Call relations**: The test runner invokes it. It uses create_config_toml to set provider behavior and verifies the server reports that users can proceed without logging in.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_with_aws_provider`  (lines 1697–1737)

```
async fn get_account_with_aws_provider() -> Result<()>
```

**Purpose**: Checks that an Amazon Bedrock provider using normal AWS-managed credentials is reported as an Amazon Bedrock account.

**Data flow**: The test writes config for an amazon-bedrock provider with an AWS profile and region, starts the server, and sends get-account. It expects an AmazonBedrock account whose credential source is AwsManaged, and authentication is not required.

**Call relations**: The test runner calls it. It uses create_config_toml’s custom provider configuration to test account reporting for a non-OpenAI provider.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (default, new, Integer, to_response, assert_eq!, timeout).


##### `get_account_with_managed_bedrock_provider`  (lines 1740–1782)

```
async fn get_account_with_managed_bedrock_provider() -> Result<()>
```

**Purpose**: Checks that Amazon Bedrock credentials stored by Codex are reported as Codex-managed Bedrock credentials.

**Data flow**: The test writes an Amazon Bedrock provider config, stores a managed Bedrock API key in the temporary home, starts the server, and sends get-account. It expects an AmazonBedrock account with credential source CodexManaged.

**Call relations**: The test runner invokes it. It combines create_config_toml with login_with_bedrock_api_key to verify the server distinguishes AWS-managed credentials from credentials saved by Codex.

*Call graph*: calls 3 internal fn (new, create_config_toml, default); 7 external calls (default, new, Integer, to_response, assert_eq!, login_with_bedrock_api_key, timeout).


##### `get_account_with_chatgpt`  (lines 1785–1827)

```
async fn get_account_with_chatgpt() -> Result<()>
```

**Purpose**: Checks that get-account reports a stored ChatGPT account with email and plan.

**Data flow**: The test writes config requiring auth, writes a ChatGPT auth fixture with email and Pro plan into auth storage, starts the server without an API key, and sends get-account. It expects a ChatGPT account containing the fixture’s email and Pro plan.

**Call relations**: The test runner calls it. It uses write_chatgpt_auth to pre-load credentials, then verifies the server can read and translate them into the public account response.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 7 external calls (default, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout).


##### `get_account_omits_chatgpt_after_permanent_refresh_failure`  (lines 1830–1911)

```
async fn get_account_omits_chatgpt_after_permanent_refresh_failure() -> Result<()>
```

**Purpose**: Checks that a ChatGPT account is hidden after a permanent refresh-token failure, instead of showing stale credentials as valid.

**Data flow**: The test writes old ChatGPT auth with a refresh token, points token refresh at a fake server that returns a permanent refresh-token error, and asks for auth status with refresh enabled. After that refresh failure, it sends get-account and expects account to be None while auth is still required.

**Call relations**: The test runner invokes it. It uses create_config_toml, write_chatgpt_auth, and a fake /oauth/token endpoint to verify the server clears or ignores unusable ChatGPT auth state.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 16 external calls (days, default, given, start, new, new, now, Integer, to_response, write_chatgpt_auth (+6 more)).


##### `get_account_with_chatgpt_missing_plan_claim_returns_unknown`  (lines 1914–1954)

```
async fn get_account_with_chatgpt_missing_plan_claim_returns_unknown() -> Result<()>
```

**Purpose**: Checks that a ChatGPT account without a plan claim is still reported, but its plan is marked Unknown.

**Data flow**: The test writes ChatGPT auth containing an email but no plan type, starts the server, and sends get-account. It expects a ChatGPT account with that email and AccountPlanType::Unknown.

**Call relations**: The test runner calls it. It uses write_chatgpt_auth to create incomplete-but-usable credentials and confirms the account response stays honest instead of guessing a plan.

*Call graph*: calls 3 internal fn (new, new_with_env, create_config_toml); 7 external calls (default, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout).


### `app-server/tests/suite/v2/rate_limits.rs`

`test` · `test run`

These are integration-style tests: they start a real test version of the app server, send it JSON-RPC requests, and check the replies. JSON-RPC is a simple request-and-response format where each request has an id and either gets a result or an error back.

The file focuses on two user-facing actions. First, a client can ask for account rate limits: how much of a usage window is used, when it resets, whether spend controls apply, and whether reset credits are available. Second, a client can ask the server to notify a workspace owner that more credits or a higher usage limit may be needed.

The tests deliberately create temporary Codex home folders so they do not touch a real user's files. Some tests write fake ChatGPT authentication into that folder. Others point the app server at a fake HTTP server, like a pretend cashier at a practice checkout, so the test can prove exactly what request the app server sends and exactly how it reacts to each reply.

The most important behavior here is the distinction between having no Codex account login, having only an API key login, and having ChatGPT account authentication. These server features require ChatGPT account authentication because they call account-specific backend endpoints.

#### Function details

##### `get_account_rate_limits_requires_auth`  (lines 39–62)

```
async fn get_account_rate_limits_requires_auth() -> Result<()>
```

**Purpose**: This test proves that the server refuses to return rate-limit information when there is no Codex account authentication at all. It protects against accidentally exposing account data to an unauthenticated client.

**Data flow**: It starts the test server in a fresh temporary home directory with no OpenAI API key available. It sends a request to get account rate limits, waits for the matching JSON-RPC error response, and checks that the error id, code, and message say authentication is required.

**Call relations**: This is a standalone test case. It uses the test server setup helper to start the server, then relies on the server's request and stream-reading helpers to send the rate-limit request and receive the expected error.

*Call graph*: calls 1 internal fn (new_with_env); 4 external calls (new, Integer, assert_eq!, timeout).


##### `get_account_rate_limits_requires_chatgpt_auth`  (lines 65–89)

```
async fn get_account_rate_limits_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: This test proves that an API key login is not enough to read account rate limits. The feature needs ChatGPT account authentication, not just any valid-looking account credential.

**Data flow**: It starts a fresh test server, logs in with a fake API key through the helper function, then asks for rate limits. The expected output is a JSON-RPC error saying ChatGPT authentication is required.

**Call relations**: This test calls `login_with_api_key` to put the server into the specific state it wants: authenticated by API key only. After that, it follows the same request-and-read pattern as the unauthenticated rate-limit test.

*Call graph*: calls 2 internal fn (new, login_with_api_key); 4 external calls (new, Integer, assert_eq!, timeout).


##### `get_account_rate_limits_returns_snapshot`  (lines 92–268)

```
async fn get_account_rate_limits_returns_snapshot() -> Result<()>
```

**Purpose**: This test checks the successful rate-limit lookup path. It proves that the app server can call the ChatGPT backend, translate the backend's usage data, and return the client-facing shape expected by the protocol.

**Data flow**: It writes fake ChatGPT credentials into a temporary Codex home, starts a fake backend server, and writes a config value telling the app server to use that fake backend. The fake backend returns a detailed usage response. The test then asks the app server for rate limits and compares the parsed response with the exact expected snapshot, including windows, reset times, spend controls, extra limits, plan type, and reset credits.

**Call relations**: This test uses `write_chatgpt_base_url` to redirect backend traffic into the mock server. The mock server stands in for the real ChatGPT service, while the app server does the real protocol translation before the test reads the JSON-RPC response.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, parse_from_rfc3339, json! (+4 more)).


##### `send_add_credits_nudge_email_requires_auth`  (lines 271–298)

```
async fn send_add_credits_nudge_email_requires_auth() -> Result<()>
```

**Purpose**: This test proves that an unauthenticated client cannot ask the server to notify a workspace owner about adding credits. Without this check, anyone connected to the server could trigger account-related email actions.

**Data flow**: It starts the server in a clean temporary home with no API key, sends an add-credits nudge request, and waits for a JSON-RPC error. It then verifies that the error says Codex account authentication is required to notify the workspace owner.

**Call relations**: This standalone test exercises the server's authorization gate before any backend call should happen. It uses the test server request helper and then reads the matching error from the response stream.

*Call graph*: calls 1 internal fn (new_with_env); 4 external calls (new, Integer, assert_eq!, timeout).


##### `send_add_credits_nudge_email_requires_chatgpt_auth`  (lines 301–329)

```
async fn send_add_credits_nudge_email_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: This test proves that logging in with an API key is still not enough to send the workspace-owner notification. The server must have ChatGPT account credentials because the action belongs to a ChatGPT account workspace.

**Data flow**: It starts the server, logs in with a fake API key, sends a nudge email request for a usage-limit increase, and reads the JSON-RPC error response. The result must say ChatGPT authentication is required.

**Call relations**: This test uses `login_with_api_key` to create an API-key-only login state, then sends the nudge request. It confirms the server stops the request before trying to contact the backend.

*Call graph*: calls 2 internal fn (new, login_with_api_key); 4 external calls (new, Integer, assert_eq!, timeout).


##### `send_add_credits_nudge_email_posts_expected_body`  (lines 333–378)

```
async fn send_add_credits_nudge_email_posts_expected_body() -> Result<()>
```

**Purpose**: This test checks the successful email-nudge path. It proves that the app server sends the right HTTP request to the backend and reports success to the JSON-RPC client.

**Data flow**: It writes fake ChatGPT credentials, points the app server at a fake backend, and configures that backend to expect a POST request with the correct authorization headers, account id header, path, and JSON body. Then it sends a usage-limit nudge request through the app server and checks that the returned status is `Sent`.

**Call relations**: This test uses `write_chatgpt_base_url` to make the app server talk to the mock backend instead of the real service. The mock backend verifies the outgoing request, and the app server translates the successful backend response into the protocol response read by the test.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 14 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, json!, timeout (+4 more)).


##### `send_add_credits_nudge_email_maps_cooldown`  (lines 382–422)

```
async fn send_add_credits_nudge_email_maps_cooldown() -> Result<()>
```

**Purpose**: This test checks how the server handles a backend cooldown response. A cooldown means the email cannot be sent again yet, and the client should get a clear status rather than a generic failure.

**Data flow**: It writes fake ChatGPT credentials, redirects backend calls to a mock server, and makes that mock server return HTTP 429, which commonly means too many requests. The test sends a credits nudge request and checks that the app server returns `CooldownActive`.

**Call relations**: This test uses `write_chatgpt_base_url` and a mock backend to force one specific backend condition. It confirms the app server maps that condition into a normal client response instead of treating it as an unexpected crash.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 11 external calls (given, start, new, new, Integer, to_response, write_chatgpt_auth, assert_eq!, timeout, method (+1 more)).


##### `send_add_credits_nudge_email_surfaces_backend_failure`  (lines 426–475)

```
async fn send_add_credits_nudge_email_surfaces_backend_failure() -> Result<()>
```

**Purpose**: This test checks that real backend failures are reported as server errors. It makes sure the client is told the notification failed, while not receiving extra internal error data.

**Data flow**: It writes fake ChatGPT credentials, points the app server at a mock backend, and makes that backend return HTTP 500 with the body `boom`. The test sends a credits nudge request, waits for a JSON-RPC error, and verifies the error code, message text, request id, and absence of extra data.

**Call relations**: This test uses `write_chatgpt_base_url` to route the app server's outgoing request to the mock backend. The mock backend simulates a broken upstream service, and the test checks how the app server turns that into a client-facing JSON-RPC error.

*Call graph*: calls 3 internal fn (new, new_with_env, write_chatgpt_base_url); 11 external calls (given, start, new, new, Integer, write_chatgpt_auth, assert!, assert_eq!, timeout, method (+1 more)).


##### `login_with_api_key`  (lines 477–488)

```
async fn login_with_api_key(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: This helper logs the test server in with an API key and checks that the login succeeded in the expected way. The tests use it when they need the server to be authenticated, but not authenticated with ChatGPT account credentials.

**Data flow**: It receives a mutable test server and an API key string. It sends an API-key login request, waits for the matching JSON-RPC response, converts that response into a login result, and checks that the result is the API-key login variant. It returns success only if all those steps pass.

**Call relations**: This helper is called by the tests that need an API-key-only state: the rate-limit ChatGPT-auth requirement test and the nudge-email ChatGPT-auth requirement test. It prepares the server state so those tests can prove the stricter ChatGPT credential check still happens.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_login_account_api_key_request); called by 2 (get_account_rate_limits_requires_chatgpt_auth, send_add_credits_nudge_email_requires_chatgpt_auth); 4 external calls (Integer, to_response, assert_eq!, timeout).


##### `write_chatgpt_base_url`  (lines 490–493)

```
fn write_chatgpt_base_url(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a small config file telling the app server which ChatGPT backend base URL to use. In these tests, that URL points to a fake backend server instead of the real service.

**Data flow**: It receives the temporary Codex home path and a base URL string. It creates or overwrites `config.toml` inside that home directory with one setting, `chatgpt_base_url`, and returns whether the file write succeeded.

**Call relations**: The tests that need backend interaction call this helper before starting the app server. That setup step makes later rate-limit and nudge-email requests go to the mock server, where the tests can control and inspect the backend behavior.

*Call graph*: called by 4 (get_account_rate_limits_returns_snapshot, send_add_credits_nudge_email_maps_cooldown, send_add_credits_nudge_email_posts_expected_body, send_add_credits_nudge_email_surfaces_backend_failure); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/rate_limit_reset_credits.rs`

`test` · `test run`

This is a test file, not production server code. Its job is to prove that the app server treats rate limit reset credits safely and predictably. A reset credit is like a one-use coupon that asks the backend service to clear some rate-limit windows for an account. Because that affects a real account, the tests make sure the server only allows it when the user is signed in with ChatGPT account credentials, not just an API key.

The tests start a temporary app server with a temporary home directory, so they do not touch a developer’s real configuration. When ChatGPT login is needed, the file writes fake ChatGPT credentials into that temporary directory. It also starts a mock HTTP server, which pretends to be the real backend. That mock server lets the tests control exactly what the backend returns: success, no credit, already redeemed, an error, or a slow response.

The app server speaks JSON-RPC, a request-and-response message format where every request has an id. The helper functions in this file send requests, wait for the matching response or error, and convert it into Rust test data. The most important behavior checked here is that failures are reported clearly, empty idempotency keys are rejected, backend outcomes are mapped correctly, and a timed-out reset request does not leave the account-authentication queue stuck.

#### Function details

##### `consume_rate_limit_reset_credit_requires_chatgpt_auth`  (lines 39–66)

```
async fn consume_rate_limit_reset_credit_requires_chatgpt_auth() -> Result<()>
```

**Purpose**: This test proves that reset credits cannot be consumed unless the account is authenticated through ChatGPT. It also checks that an API key login is not enough for this feature.

**Data flow**: It starts a fresh server with no saved credentials, sends a reset-credit request, and reads the error that comes back. Then it logs in with an API key, sends another reset-credit request, and checks that this also fails with the more specific message that ChatGPT authentication is required.

**Call relations**: The test uses initialized_app_server to start the server, send_consume_reset_credit to make the feature request, read_error_response to receive the JSON-RPC error, and login_with_api_key to prove that API-key authentication still does not unlock this ChatGPT-account-only action.

*Call graph*: calls 4 internal fn (initialized_app_server, login_with_api_key, read_error_response, send_consume_reset_credit); 2 external calls (new, assert_eq!).


##### `consume_account_rate_limit_reset_credit_maps_backend_outcomes`  (lines 69–121)

```
async fn consume_account_rate_limit_reset_credit_maps_backend_outcomes() -> Result<()>
```

**Purpose**: This test checks that the app server correctly translates backend result codes into the public response values clients expect. It covers reset success and the common non-reset cases.

**Data flow**: It creates fake ChatGPT credentials and a mock backend server. For several idempotency keys, it teaches the mock backend to return a specific code, then sends matching reset-credit requests through the app server and compares each response with the expected outcome.

**Call relations**: The test relies on chatgpt_test_context to prepare authentication and the fake backend, initialized_app_server to launch the app server, and consume_reset_credit to send a request and read the successful response. The mock backend stands in for the real service so the test can verify the server’s mapping logic in isolation.

*Call graph*: calls 2 internal fn (chatgpt_test_context, initialized_app_server); 8 external calls (given, new, assert_eq!, json!, body_json, header, method, path).


##### `consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key`  (lines 124–140)

```
async fn consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key() -> Result<()>
```

**Purpose**: This test makes sure the server rejects an empty idempotency key. An idempotency key is a unique request label that helps prevent the same credit from being spent twice by accident.

**Data flow**: It starts a ChatGPT-authenticated test server, sends a reset-credit request whose idempotency key is an empty string, then reads the error response and checks the exact error code and message.

**Call relations**: The test uses chatgpt_test_context because the request should get past authentication, initialized_app_server to run the server, and read_error_response to inspect the validation failure returned by the server.

*Call graph*: calls 3 internal fn (chatgpt_test_context, initialized_app_server, read_error_response); 2 external calls (new, assert_eq!).


##### `consume_account_rate_limit_reset_credit_surfaces_backend_failure`  (lines 143–165)

```
async fn consume_account_rate_limit_reset_credit_surfaces_backend_failure() -> Result<()>
```

**Purpose**: This test confirms that when the backend service fails, the app server reports a clear internal error instead of pretending the reset succeeded. It protects callers from receiving misleading success responses.

**Data flow**: It prepares ChatGPT credentials and a mock backend that always answers the consume request with HTTP 500 and the text “boom.” Then it sends a reset-credit request, reads the server’s error response, and checks that the error says the reset consume operation failed.

**Call relations**: The test uses chatgpt_test_context to build the fake authenticated environment, configures the mock backend directly, starts the app server with initialized_app_server, sends the request through send_consume_reset_credit, and receives the failure through read_error_response.

*Call graph*: calls 4 internal fn (chatgpt_test_context, initialized_app_server, read_error_response, send_consume_reset_credit); 6 external calls (given, new, assert!, assert_eq!, method, path).


##### `consume_timeout_releases_account_auth_queue`  (lines 168–214)

```
async fn consume_timeout_releases_account_auth_queue() -> Result<()>
```

**Purpose**: This test checks a subtle failure case: if consuming a reset credit times out, the server must not leave account authentication work blocked behind it. In everyday terms, a stuck reset request should not keep the checkout line closed for everyone else.

**Data flow**: It creates fake ChatGPT credentials and a mock backend that waits longer than the configured reset timeout. It starts the app server with a very short reset timeout, sends a reset-credit request, then sends an account request. It verifies that the reset request reports a timeout and that the later account request still gets a normal validation error instead of hanging.

**Call relations**: This test uses chatgpt_test_context for setup, TestAppServer::new_with_env to override the timeout setting, send_consume_reset_credit to start the slow operation, and read_error_response to confirm the later account request is still processed. The mock backend delay is what triggers the timeout path.

*Call graph*: calls 4 internal fn (new_with_env, chatgpt_test_context, read_error_response, send_consume_reset_credit); 9 external calls (given, new, Integer, assert_eq!, json!, from_secs, timeout, method, path).


##### `chatgpt_test_context`  (lines 216–228)

```
async fn chatgpt_test_context() -> Result<(TempDir, MockServer)>
```

**Purpose**: This helper builds a temporary test environment that looks like a ChatGPT-authenticated user talking to a controllable backend. Tests use it when they need to exercise authenticated reset-credit behavior without real network services.

**Data flow**: It creates a temporary home directory, writes fake ChatGPT credentials with a token, account id, and plan type, starts a mock HTTP server, writes that mock server’s URL into the temporary config file, and returns both the directory and the mock server.

**Call relations**: Several tests call this before starting the app server. It hands them a prepared filesystem and mock backend so they can focus on the behavior being tested rather than repeating setup code.

*Call graph*: calls 2 internal fn (new, write_chatgpt_base_url); called by 4 (consume_account_rate_limit_reset_credit_maps_backend_outcomes, consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key, consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_timeout_releases_account_auth_queue); 3 external calls (start, new, write_chatgpt_auth).


##### `initialized_app_server`  (lines 230–234)

```
async fn initialized_app_server(codex_home: &Path) -> Result<TestAppServer>
```

**Purpose**: This helper starts the test app server and waits until it has completed its initial handshake. It gives tests a ready-to-use server connection.

**Data flow**: It receives the path to a temporary Codex home directory, starts TestAppServer with the real OPENAI_API_KEY disabled, waits up to the default read timeout for initialization to finish, and returns the initialized server object.

**Call relations**: Most tests call this after preparing any needed config or credentials. It hides the repeated startup steps so each test can immediately send JSON-RPC requests.

*Call graph*: calls 1 internal fn (new_with_env); called by 4 (consume_account_rate_limit_reset_credit_maps_backend_outcomes, consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key, consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_rate_limit_reset_credit_requires_chatgpt_auth); 1 external calls (timeout).


##### `consume_reset_credit`  (lines 236–242)

```
async fn consume_reset_credit(
    mcp: &mut TestAppServer,
    idempotency_key: &str,
) -> Result<ConsumeAccountRateLimitResetCreditResponse>
```

**Purpose**: This helper sends a reset-credit consume request and waits for a successful response. It is used when a test expects the operation to succeed rather than return an error.

**Data flow**: It receives a mutable test server connection and an idempotency key. It sends the consume request, gets back the request id, waits for the matching response, converts that response into the expected response type, and returns it.

**Call relations**: It is a small wrapper around send_consume_reset_credit and read_response. The backend-outcome mapping test uses it to keep each case short and focused on the expected result.

*Call graph*: calls 2 internal fn (read_response, send_consume_reset_credit).


##### `send_consume_reset_credit`  (lines 244–251)

```
async fn send_consume_reset_credit(mcp: &mut TestAppServer, idempotency_key: &str) -> Result<i64>
```

**Purpose**: This helper sends the actual JSON-RPC request to consume a rate limit reset credit. It is useful when a test wants to decide later whether to read a success response or an error response.

**Data flow**: It takes the test server connection and a string idempotency key, packages that key into the request parameters, sends the request to the app server, and returns the numeric request id assigned to that message.

**Call relations**: Tests call this before reading either success or failure. consume_reset_credit builds on it for success cases, while error-focused tests pair it with read_error_response.

*Call graph*: calls 1 internal fn (send_consume_account_rate_limit_reset_credit_request); called by 4 (consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_rate_limit_reset_credit_requires_chatgpt_auth, consume_reset_credit, consume_timeout_releases_account_auth_queue).


##### `read_response`  (lines 253–263)

```
async fn read_response(mcp: &mut TestAppServer, request_id: i64) -> Result<T>
```

**Purpose**: This helper waits for a successful JSON-RPC response with a specific request id and converts it into the caller’s requested Rust type. It keeps tests from repeating the same timeout and conversion code.

**Data flow**: It receives the test server connection and the request id to watch for. It waits until the stream produces a matching response message, applies a timeout so the test cannot hang forever, converts the generic JSON-RPC response into a typed value, and returns that value.

**Call relations**: consume_reset_credit uses this helper after sending a reset-credit request. login_with_api_key also depends on it indirectly through a typed response check.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); called by 1 (consume_reset_credit); 3 external calls (Integer, to_response, timeout).


##### `read_error_response`  (lines 265–272)

```
async fn read_error_response(mcp: &mut TestAppServer, request_id: i64) -> Result<JSONRPCError>
```

**Purpose**: This helper waits for an error response with a specific request id. It is used by tests that expect the server to reject a request or report a failure.

**Data flow**: It receives the test server connection and request id, waits for the matching JSON-RPC error message with a timeout, and returns the error object so the test can inspect its code and message.

**Call relations**: All the negative-path tests use this helper after sending a request that should fail. It keeps the tests focused on what error was returned rather than how messages are read from the stream.

*Call graph*: calls 1 internal fn (read_stream_until_error_message); called by 4 (consume_account_rate_limit_reset_credit_rejects_empty_idempotency_key, consume_account_rate_limit_reset_credit_surfaces_backend_failure, consume_rate_limit_reset_credit_requires_chatgpt_auth, consume_timeout_releases_account_auth_queue); 2 external calls (Integer, timeout).


##### `login_with_api_key`  (lines 274–281)

```
async fn login_with_api_key(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: This helper logs the test server in with an API key and checks that the server accepted it as API-key authentication. It is used to prove that API-key login still does not satisfy ChatGPT-only requirements.

**Data flow**: It receives a test server connection and an API key string, sends an API-key login request, reads the successful login response, and asserts that the response says the account is authenticated by API key.

**Call relations**: The authentication test calls this between two reset-credit attempts. That lets the test compare no authentication with API-key authentication and verify that both are rejected for this ChatGPT-specific feature.

*Call graph*: calls 1 internal fn (send_login_account_api_key_request); called by 1 (consume_rate_limit_reset_credit_requires_chatgpt_auth); 1 external calls (assert_eq!).


##### `write_chatgpt_base_url`  (lines 283–288)

```
fn write_chatgpt_base_url(codex_home: &Path, base_url: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a tiny config file that points the app server at the mock ChatGPT backend instead of the real one. It lets tests control backend replies safely.

**Data flow**: It receives the temporary Codex home path and a base URL string, creates the path to config.toml, writes a line setting chatgpt_base_url to that URL, and returns whether the file write succeeded.

**Call relations**: chatgpt_test_context calls this after starting the mock server. The app server then reads this config during startup and sends reset-credit backend calls to the mock server used by the tests.

*Call graph*: called by 1 (chatgpt_test_context); 3 external calls (join, format!, write).


### Initialization and configuration surfaces
These tests validate startup-time initialization behavior, strict config parsing, runtime config RPCs, and feature/config-derived capability exposure.

### `app-server/tests/suite/strict_config.rs`

`test` · `test run`

This is a safety test for configuration loading. A configuration file is like a checklist the app server reads before it starts. If strict checking is turned on, the server should reject anything it does not understand, rather than ignoring it and possibly surprising the user later.

The test creates a temporary fake `CODEX_HOME` directory, writes a `config.toml` file containing one invalid setting, `foo = "bar"`, and then launches the real `codex-app-server` binary. It sets environment variables so the server reads from that temporary directory instead of the developer’s real home/config area. It also points the managed configuration path at another file inside the same temporary directory, keeping the test isolated.

The server is started with `--strict-config` and `--listen off`. Turning listening off means the test is only checking startup configuration behavior, not networking. The expected result is failure: the process should exit unsuccessfully. The test then reads the server’s error output and checks that it clearly mentions the unknown configuration field. Without this test, the server could accidentally become lenient and silently accept misspelled or invalid config fields.

#### Function details

##### `strict_config_rejects_unknown_config_fields_for_standalone_app_server`  (lines 7–33)

```
fn strict_config_rejects_unknown_config_fields_for_standalone_app_server() -> Result<()>
```

**Purpose**: This test proves that strict config mode rejects unknown fields in the standalone app server’s user configuration. It is used to catch regressions where invalid settings might be ignored instead of reported.

**Data flow**: It starts by making a temporary directory and writing a `config.toml` file with an unsupported field named `foo`. It then runs the `codex-app-server` program with environment variables pointing at that temporary config location and command-line options enabling strict config while disabling listening. The output process status is checked to make sure startup failed, and the error text is converted to readable text so the test can confirm it contains the expected message about `foo`.

**Call relations**: During the test run, the Rust test harness calls this function. The function then calls out to the built `codex-app-server` binary as a separate process, so it checks the same behavior a real user would hit at startup. It relies on temporary file creation, writing a config file, locating the binary, running the command, and reading standard error to verify that the server reports the strict-config problem.

*Call graph*: 6 external calls (from_utf8, new, assert!, new, cargo_bin, write).


### `app-server/tests/suite/v2/initialize.rs`

`test` · `test run`

When a client first connects to the app server, it sends an initialize request. That request is like signing a guest book: it tells the server the client's name, version, and optional abilities. These tests check that the server uses that information safely and consistently.

The file starts a temporary app server for each test, points it at a fake model server, and writes a small config.toml into a temporary Codex home directory. It then sends initialize messages and checks the replies. The main behavior under test is the "originator", the name that becomes part of the user agent sent to backend services. Normal clients such as VS Code can set this name, but internal probe clients such as the app server daemon or Codex backend must not accidentally replace the default Codex identity. An environment variable can deliberately override it.

The tests also cover two important edge cases. First, a client name containing invalid HTTP header characters is rejected, because that name may later travel inside HTTP headers. Second, clients can opt out of certain notification messages, and the server should filter those out. The final test confirms that the initialized client name is carried into the external notification payload after a turn completes.

#### Function details

##### `initialize_uses_client_info_name_as_originator`  (lines 30–63)

```
async fn initialize_uses_client_info_name_as_originator() -> Result<()>
```

**Purpose**: Checks that a normal client name from the initialize request becomes the start of the server's user agent. It also verifies that the server reports the correct Codex home directory and current operating system information.

**Data flow**: The test creates a fake model server, a temporary Codex home, and a config file pointing to that fake server. It starts a test app server, sends initialize with clientInfo.name set to codex_vscode, then reads the response. The response is decoded and compared with the expected user agent prefix, home path, platform family, and platform operating system.

**Call relations**: This test uses create_config_toml to prepare the server's config before TestAppServer starts. It calls the test server's initialize helper, then uses the shared response decoding helper to inspect the initialize reply. If the server sends anything other than a response, the test fails immediately.

*Call graph*: calls 3 internal fn (new, create_config_toml, try_from); 7 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, timeout).


##### `initialize_probe_does_not_override_originator`  (lines 66–90)

```
async fn initialize_probe_does_not_override_originator() -> Result<()>
```

**Purpose**: Checks that the app server daemon's own probe-style client name does not replace the normal Codex originator. This prevents an internal health check or helper connection from changing how real backend requests identify themselves.

**Data flow**: The test builds a temporary config and starts a test app server. It sends initialize with clientInfo.name set to codex_app_server_daemon. It then decodes the initialize response and checks that the user agent still starts with codex_cli_rs rather than the daemon name.

**Call relations**: Like the other initialize tests, it relies on create_config_toml for setup and the TestAppServer initialize helper for the request. It is a narrow guard around the special-case originator rule for the daemon client name.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, timeout).


##### `initialize_codex_backend_does_not_override_originator`  (lines 93–117)

```
async fn initialize_codex_backend_does_not_override_originator() -> Result<()>
```

**Purpose**: Checks that a client identifying itself as codex-backend also does not replace the default Codex originator. This protects against internal backend connections changing the user agent identity used by the app server.

**Data flow**: The test creates a fake model server, writes a temporary config, and starts the app server. It sends initialize with clientInfo.name set to codex-backend. The returned initialize response is decoded, and the user agent is expected to begin with codex_cli_rs.

**Call relations**: This follows the same setup path as the other originator tests through create_config_toml and TestAppServer. It covers a second internal client name that should be ignored for originator purposes.

*Call graph*: calls 2 internal fn (new, create_config_toml); 6 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, timeout).


##### `initialize_respects_originator_override_env_var`  (lines 120–160)

```
async fn initialize_respects_originator_override_env_var() -> Result<()>
```

**Purpose**: Checks that an explicit environment variable can override the originator even when the client name says something else. This is useful for controlled internal testing or deployment settings where the caller wants to force a specific identity.

**Data flow**: The test creates a temporary Codex home and records its canonical absolute path. It writes config, starts the app server with CODEX_INTERNAL_ORIGINATOR_OVERRIDE set, and sends initialize as codex_vscode. The initialize response is decoded, and the user agent is checked for the environment-provided prefix while the reported home and platform values are also checked.

**Call relations**: This test uses create_config_toml for normal config setup but starts the server with new_with_env so the override variable is present. It then follows the same initialize-response path as the normal client-name test, proving the environment value takes priority.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, try_from); 7 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!, timeout).


##### `initialize_rejects_invalid_client_name`  (lines 163–195)

```
async fn initialize_rejects_invalid_client_name() -> Result<()>
```

**Purpose**: Checks that the server rejects a client name that cannot safely be used as an HTTP header value. In plain terms, it prevents unsafe characters in a name from leaking into later network requests.

**Data flow**: The test starts a temporary app server with the originator override explicitly absent. It sends initialize with a client name containing a carriage return character. Instead of a normal response, it expects a JSON-RPC error with code -32600, a clear validation message, and no extra error data.

**Call relations**: This test again uses create_config_toml for setup and new_with_env to control the environment. It exercises the initialize validation path and confirms that invalid input is stopped before it can become part of the user agent.

*Call graph*: calls 2 internal fn (new_with_env, create_config_toml); 6 external calls (new, new, bail!, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout).


##### `initialize_opt_out_notification_methods_filters_notifications`  (lines 198–259)

```
async fn initialize_opt_out_notification_methods_filters_notifications() -> Result<()>
```

**Purpose**: Checks that a client can ask not to receive specific notification methods during initialization. Here, it opts out of thread/started and verifies that the server does not send that notification.

**Data flow**: The test starts the server, initializes with capabilities that include opt_out_notification_methods containing thread/started, then sends a thread start request. While waiting for the matching thread start response, it watches the message stream and fails if a thread/started notification appears. It then waits briefly for that notification and expects the wait to time out.

**Call relations**: This test connects initialization settings to later request handling. It first uses the initialize-with-capabilities helper, then starts a thread and reads messages from the server stream, proving that the opt-out choice made at startup affects notifications produced afterward.

*Call graph*: calls 2 internal fn (new, create_config_toml); 11 external calls (new, new, bail!, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, from_millis, timeout (+1 more)).


##### `turn_start_notify_payload_includes_initialize_client_name`  (lines 262–336)

```
async fn turn_start_notify_payload_includes_initialize_client_name() -> Result<()>
```

**Purpose**: Checks that the client name supplied during initialize is included in the external notification payload after a turn completes. This makes notification consumers able to tell which client started the work.

**Data flow**: The test prepares a fake model response, creates a temporary notify output file, and writes config that runs a small notification-capture program. It initializes the app server with client name xcode, starts a thread, starts a turn with the user text Hello, waits for turn/completed, then waits for the capture file to appear. Finally it reads the JSON payload from disk and checks that its client field is xcode.

**Call relations**: This is the most end-to-end test in the file. It uses create_config_toml_with_extra to add notification settings, uses the app server helpers to initialize, start a thread, and start a turn, and relies on the fake model server to finish the turn so the notification path is triggered.

*Call graph*: calls 2 internal fn (new, create_config_toml_with_extra); 15 external calls (default, from_secs, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert_eq!, cargo_bin, format! (+5 more)).


##### `create_config_toml`  (lines 339–345)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes the standard test config.toml for most tests in this file. It keeps repeated setup short by filling in the common settings and leaving out any extra config.

**Data flow**: It receives a Codex home folder, the fake server URL, and an approval policy string. It forwards those values to create_config_toml_with_extra with an empty extra section. The result is the file-writing result from the lower-level helper.

**Call relations**: The initialize tests call this before starting TestAppServer so the server knows which mock provider to use. It is a small wrapper around create_config_toml_with_extra for tests that do not need notification or other added settings.

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

**Purpose**: Writes a complete config.toml into the temporary Codex home used by a test. It can also insert extra TOML text, such as notification settings, when a test needs more than the default config.

**Data flow**: It receives the Codex home path, mock server URL, approval policy, and an extra config snippet. It builds the path to config.toml, formats a configuration string with a mock model provider, read-only sandbox mode, disabled shell snapshots, and the supplied extra text, then writes that string to disk. It returns success or the file-writing error.

**Call relations**: create_config_toml calls this for ordinary tests, and the notification test calls it directly so it can add a notify command. The app server later reads the file during startup, so this helper shapes the environment each test runs in.

*Call graph*: called by 2 (create_config_toml, turn_start_notify_payload_includes_initialize_client_name); 3 external calls (join, format!, write).


##### `toml_basic_string`  (lines 380–382)

```
fn toml_basic_string(value: &str) -> String
```

**Purpose**: Turns a Rust string into a simple quoted TOML string for use inside generated test config. It escapes backslashes and double quotes so paths can be written safely.

**Data flow**: It takes a text value, replaces backslashes with escaped backslashes and quotation marks with escaped quotation marks, then wraps the result in double quotes. The returned string can be embedded in TOML config text.

**Call relations**: The notification test uses this before calling create_config_toml_with_extra, because executable paths and file paths may contain characters that would otherwise break the TOML syntax.

*Call graph*: 1 external calls (format!).


### `app-server/tests/suite/v2/config_rpc.rs`

`test` · `test run`

This is a test file, not production code. It starts a real test app server with temporary configuration files, sends it JSON-RPC requests, and checks that the replies match what a client would need. JSON-RPC is a simple request-and-response protocol where each message has an id, so the test can ask for a config read or write and wait for the matching answer.

The tests cover the main ways configuration can appear. A user can have a `config.toml` file, a project can have its own `.codex/config.toml`, and an organization or system can provide managed settings that override some user settings. The tests check both the final effective configuration and the “origin” metadata that says which layer supplied each value. This matters because a settings UI must know whether a value came from the user, the project, or a managed policy.

The file also tests writing: changing one value, changing several values at once, rejecting stale writes, and preserving safety when invalid legacy profile edits are attempted. The small helper functions write test config files and verify expected layer ordering, like checking that a stack of papers is in the right top-to-bottom order.

#### Function details

##### `write_config`  (lines 44–49)

```
fn write_config(codex_home: &TempDir, contents: &str) -> Result<()>
```

**Purpose**: Writes a test `config.toml` file into a temporary Codex home directory. Tests use it to set up the exact starting configuration they want before launching the app server.

**Data flow**: It receives a temporary directory and a text string containing TOML configuration. It writes that string to `config.toml` inside the directory. It returns success if the file was written, or an error if the disk write failed.

**Call relations**: Most tests call this first to create their starting config. After that, they start `TestAppServer`, send read or write requests, and compare the server’s answer against the file contents created here.

*Call graph*: called by 17 (config_batch_write_applies_multiple_edits, config_batch_write_rejects_legacy_profile_tables, config_batch_write_updates_multiple_desktop_settings, config_read_accepts_forced_chatgpt_workspace_id_list, config_read_accepts_legacy_forced_chatgpt_workspace_id, config_read_after_pipelined_write_sees_written_value, config_read_ignores_bool_web_search_tool_config, config_read_includes_apps, config_read_includes_desktop_settings, config_read_includes_nested_web_search_tool_config (+7 more)); 2 external calls (path, write).


##### `config_requirements_read_includes_allow_remote_control`  (lines 52–76)

```
async fn config_requirements_read_includes_allow_remote_control() -> Result<()>
```

**Purpose**: Checks that the server can read managed requirements and includes the `allow_remote_control` setting. This protects clients that need to know whether remote control is permitted by policy.

**Data flow**: The test creates a temporary home, writes `requirements.toml` with `allow_remote_control = false`, starts the test server, and sends a requirements-read request. It converts the JSON-RPC response into a typed response and checks that the returned requirement is `false`.

**Call relations**: This test talks directly to `TestAppServer`: it initializes the server, sends the requirements request, waits for the matching response id, and then uses `to_response` to decode the reply before asserting the expected value.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


##### `config_read_returns_effective_and_layers`  (lines 79–123)

```
async fn config_read_returns_effective_and_layers() -> Result<()>
```

**Purpose**: Checks that a config read returns both the final effective settings and the list of configuration layers when requested. This matters because clients need the chosen value and also need to explain where that value came from.

**Data flow**: The test writes a user config with a model and sandbox mode, starts the server, and sends a config-read request with `include_layers` set to true. It reads the response, checks that the effective model is the user value, checks the origin for `model`, and verifies the layer order.

**Call relations**: It uses `write_config` to prepare the file, then relies on `assert_layers_user_then_optional_system` to confirm that the returned layer stack has the expected user layer followed by a system layer, with an optional managed layer in front.

*Call graph*: calls 4 internal fn (new, assert_layers_user_then_optional_system, write_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_tools`  (lines 126–196)

```
async fn config_read_includes_tools() -> Result<()>
```

**Purpose**: Checks that tool configuration, especially web search settings, is included in the config-read response. This protects client code that shows or edits tool-specific settings.

**Data flow**: The test writes a config containing `[tools.web_search]` settings, starts the server, and asks for config plus layers. It checks that web search context size and allowed domains were parsed into the response, and that each setting’s origin points back to the user config file.

**Call relations**: It follows the same read path as other config-read tests. It sets up with `write_config`, decodes the response with `to_response`, and calls `assert_layers_user_then_optional_system` to verify the returned layer ordering.

*Call graph*: calls 4 internal fn (new, assert_layers_user_then_optional_system, write_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_accepts_legacy_forced_chatgpt_workspace_id`  (lines 199–234)

```
async fn config_read_accepts_legacy_forced_chatgpt_workspace_id() -> Result<()>
```

**Purpose**: Checks backward compatibility for the older single-string form of `forced_chatgpt_workspace_id`. This keeps existing user config files from breaking after the setting evolves.

**Data flow**: The test writes a config where `forced_chatgpt_workspace_id` is one string, starts the server, and reads the config. It checks that the response represents the value as a single workspace id.

**Call relations**: It uses `write_config` to create the legacy-style file, then sends a normal config-read request through `TestAppServer` and decodes the JSON-RPC response into `ConfigReadResponse`.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, format!, timeout).


##### `config_read_accepts_forced_chatgpt_workspace_id_list`  (lines 237–276)

```
async fn config_read_accepts_forced_chatgpt_workspace_id_list() -> Result<()>
```

**Purpose**: Checks that the newer list form of `forced_chatgpt_workspace_id` is accepted. This allows configuration to name more than one workspace id.

**Data flow**: The test writes two workspace ids as an array in `config.toml`, starts the server, and reads the config. It checks that the response contains both ids in the expected multiple-id form.

**Call relations**: This test mirrors the legacy single-id test, but with an array. It uses the same server request and response conversion path to verify that both supported input shapes are understood.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, format!, timeout).


##### `config_read_includes_nested_web_search_tool_config`  (lines 279–324)

```
async fn config_read_includes_nested_web_search_tool_config() -> Result<()>
```

**Purpose**: Checks that nested web search settings, including a location object, are parsed and returned correctly. This matters for clients that configure search behavior in detail.

**Data flow**: The test writes web search settings with context size, allowed domains, and location fields such as country, city, and timezone. It reads the server config response and checks that those nested values appear in the typed web search tool configuration.

**Call relations**: It prepares the config with `write_config`, starts `TestAppServer`, sends a config-read request, and validates the decoded response. It does not inspect layers because this test focuses on nested parsing.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_ignores_bool_web_search_tool_config`  (lines 327–356)

```
async fn config_read_ignores_bool_web_search_tool_config() -> Result<()>
```

**Purpose**: Checks that an old or unsupported boolean form of `tools.web_search` does not get treated as a detailed web search configuration. This prevents a simple true/false value from being misread as structured settings.

**Data flow**: The test writes `[tools] web_search = true`, starts the server, and reads the config. It checks that the returned structured web search config is `None` rather than a partly invented configuration.

**Call relations**: It uses the standard test-server read flow. The key behavior being checked is inside the server’s config parser; this test only supplies the odd input shape and verifies the safe output.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_apps`  (lines 359–472)

```
async fn config_read_includes_apps() -> Result<()>
```

**Purpose**: Checks that per-app configuration and default app configuration are returned correctly. This protects settings used to enable apps, choose approval behavior, and control potentially destructive tools.

**Data flow**: The test writes an `[apps._default]` section and an `[apps.app1]` section, starts the server, and reads config with layers. It checks the returned app settings, including defaults and app-specific overrides, and verifies the origin metadata for each written field.

**Call relations**: It uses `write_config` for setup, reads through `TestAppServer`, and calls `assert_layers_user_then_optional_system` to confirm the layer list. The test links app-specific values back to the user config source.

*Call graph*: calls 4 internal fn (new, assert_layers_user_then_optional_system, write_config, try_from); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_desktop_settings`  (lines 475–518)

```
async fn config_read_includes_desktop_settings() -> Result<()>
```

**Purpose**: Checks that desktop-specific settings are preserved and returned as flexible JSON values. This lets the desktop client store UI preferences without every field needing a custom Rust type.

**Data flow**: The test writes a `[desktop]` section with theme, avatar id, and nested workspace settings. It reads the config response and checks that those values appear in the `desktop` map exactly as JSON values.

**Call relations**: It uses the normal config-read request path through `TestAppServer`. Unlike many other tests, it focuses on free-form desktop data rather than strongly typed server settings.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `config_read_includes_project_layers_for_cwd`  (lines 521–564)

```
async fn config_read_includes_project_layers_for_cwd() -> Result<()>
```

**Purpose**: Checks that when a current working directory is supplied, trusted project configuration is included in the read result. This matters because a project may need settings different from the user’s global defaults.

**Data flow**: The test writes a user config, creates a temporary workspace with `.codex/config.toml`, marks that workspace as trusted, and asks the server to read config for that workspace path. It checks that the project value appears and that its origin points to the project’s `.codex` folder.

**Call relations**: It combines `write_config` with `set_project_trust_level`, then sends a config-read request whose `cwd` names the workspace. The server’s response should include project-layer information because the project is trusted.

*Call graph*: calls 4 internal fn (new, write_config, set_project_trust_level, try_from); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `config_read_includes_system_layer_and_overrides`  (lines 567–690)

```
async fn config_read_includes_system_layer_and_overrides() -> Result<()>
```

**Purpose**: Checks how managed configuration, user configuration, and system defaults combine. It verifies that managed settings can override user settings while user settings still apply where managed config is silent.

**Data flow**: The test writes a user config, writes a separate managed config file, points the server to that managed file through an environment variable, and reads config with layers. It checks which values came from managed config, which came from user config, and that combined nested sandbox settings behave correctly.

**Call relations**: It starts the server with `new_with_env` so the managed config path is visible. After reading, it calls `assert_layers_managed_user_then_optional_system` to confirm the layer stack is managed, then user, then system, allowing for an optional managed-device layer before them.

*Call graph*: calls 4 internal fn (new_with_env, assert_layers_managed_user_then_optional_system, write_config, try_from); 9 external calls (new, Integer, test_path_buf_with_windows, to_response, assert!, assert_eq!, format!, write, timeout).


##### `config_value_write_replaces_value`  (lines 693–756)

```
async fn config_value_write_replaces_value() -> Result<()>
```

**Purpose**: Checks that a single config value can be replaced through the RPC API. This protects the basic settings-editor action of changing one field, such as the selected model.

**Data flow**: The test writes an old model value, reads the current config to get the field’s version, sends a value-write request replacing `model` with a new string, and checks that the write succeeded. It then reads again and confirms the new model value is now effective.

**Call relations**: It uses `write_config` for setup, then performs a read-write-read story through `TestAppServer`. The first read supplies an expected version, the write changes the file, and the final read proves the server sees the update.

*Call graph*: calls 3 internal fn (new, write_config, resolve_path_against_base); 7 external calls (new, Integer, to_response, assert!, assert_eq!, json!, timeout).


##### `config_value_write_updates_desktop_settings`  (lines 759–800)

```
async fn config_value_write_updates_desktop_settings() -> Result<()>
```

**Purpose**: Checks that a single desktop setting can be written through the config value write API. This allows the desktop client to save UI preferences with the same config-writing path.

**Data flow**: The test starts with an empty config file, sends a write request for `desktop.appearanceTheme`, and checks the write succeeded. It then reads config and confirms the desktop map contains `appearanceTheme: "dark"`.

**Call relations**: It uses `write_config` to create an empty file, sends a value-write request through `TestAppServer`, then sends a config-read request to verify the persisted setting.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, json!, timeout).


##### `config_read_after_pipelined_write_sees_written_value`  (lines 803–849)

```
async fn config_read_after_pipelined_write_sees_written_value() -> Result<()>
```

**Purpose**: Checks that if a client sends a write request and then immediately sends a read request, the read sees the write. This protects clients that pipeline requests instead of waiting between every step.

**Data flow**: The test writes an old model value, starts the server, sends a write request for a new model, and immediately sends a read request. It waits for the write response, confirms success, then waits for the read response and checks that the model is the new value.

**Call relations**: Both requests go through the same `TestAppServer` stream. The test verifies the server orders config operations safely, so the later read is not answered from stale state.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, json!, timeout).


##### `config_value_write_rejects_version_conflict`  (lines 852–888)

```
async fn config_value_write_rejects_version_conflict() -> Result<()>
```

**Purpose**: Checks that the server rejects a write when the caller supplies an outdated expected version. This prevents one client from accidentally overwriting another client’s newer change.

**Data flow**: The test writes an initial model, starts the server, and sends a write request with an intentionally stale version string. Instead of a success response, it waits for a JSON-RPC error and checks that the error code is `configVersionConflict`.

**Call relations**: It exercises the error path of the value-write RPC. The test does not verify file contents afterward; its job is to confirm the server refuses the write before applying it.

*Call graph*: calls 2 internal fn (new, write_config); 5 external calls (new, Integer, assert_eq!, json!, timeout).


##### `config_batch_write_applies_multiple_edits`  (lines 891–954)

```
async fn config_batch_write_applies_multiple_edits() -> Result<()>
```

**Purpose**: Checks that several config edits can be applied together in one batch request. This is useful for settings screens that need to change related fields as one operation.

**Data flow**: The test starts with an empty config, sends a batch write that sets `sandbox_mode` and the nested `sandbox_workspace_write` object, and checks the write response. It then reads config and confirms both edits are present together.

**Call relations**: It uses `write_config` for setup and `test_tmp_path_buf` for a sample writable path. The batch write is sent through `TestAppServer`, and the later read proves the batch was applied as intended.

*Call graph*: calls 3 internal fn (new, write_config, resolve_path_against_base); 8 external calls (new, Integer, test_tmp_path_buf, to_response, assert!, assert_eq!, timeout, vec!).


##### `config_batch_write_rejects_legacy_profile_tables`  (lines 957–1016)

```
async fn config_batch_write_rejects_legacy_profile_tables() -> Result<()>
```

**Purpose**: Checks that batch writing into legacy `profiles` tables is rejected and does not partially write other edits. This protects old config structures from being modified through a newer write path that does not support them safely.

**Data flow**: The test writes a config containing a legacy profile table, then sends a batch with one edit targeting that profile and another unrelated edit. It expects a validation error, then reads the raw TOML file and confirms the old profile value is unchanged and the unrelated edit was not added.

**Call relations**: It uses `write_config` to create the legacy starting point, sends the batch request through `TestAppServer`, and then checks the file directly with TOML parsing because the important guarantee is that no partial disk change happened.

*Call graph*: calls 2 internal fn (new, write_config); 8 external calls (new, Integer, assert!, assert_eq!, read_to_string, timeout, from_str, vec!).


##### `config_batch_write_updates_multiple_desktop_settings`  (lines 1019–1080)

```
async fn config_batch_write_updates_multiple_desktop_settings() -> Result<()>
```

**Purpose**: Checks that a batch write can update several desktop settings at once. This supports saving multiple UI preferences together.

**Data flow**: The test starts with an empty config and sends a batch request that writes `desktop.selected-avatar-id` and a nested `desktop.workspace` object. It checks the batch succeeded, reads config again, and confirms both desktop values are present.

**Call relations**: It follows the standard setup, batch-write, read-back pattern through `TestAppServer`. This is the desktop-focused counterpart to the general multiple-edit batch write test.

*Call graph*: calls 2 internal fn (new, write_config); 6 external calls (new, Integer, to_response, assert_eq!, timeout, vec!).


##### `assert_layers_user_then_optional_system`  (lines 1082–1106)

```
fn assert_layers_user_then_optional_system(
    layers: &[codex_app_server_protocol::ConfigLayer],
    user_file: AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Verifies that returned configuration layers are in the expected order when a user config is present. It allows for one optional managed-device layer at the front, then requires the user layer and a system layer.

**Data flow**: It receives the layer list returned by the server and the expected user config file path. It skips over an optional first managed-device layer, checks the total layer count, confirms the next layer is the user file, and confirms the final layer is a system layer. It returns success if all checks pass.

**Call relations**: Several read tests call this after asking for `include_layers`. It keeps repeated layer-order assertions in one place so those tests can focus on the specific config fields they are checking.

*Call graph*: called by 3 (config_read_includes_apps, config_read_includes_tools, config_read_returns_effective_and_layers); 3 external calls (assert!, assert_eq!, matches!).


##### `assert_layers_managed_user_then_optional_system`  (lines 1108–1137)

```
fn assert_layers_managed_user_then_optional_system(
    layers: &[codex_app_server_protocol::ConfigLayer],
    managed_file: AbsolutePathBuf,
    user_file: AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Verifies the expected layer order when a managed config file is also present. It confirms that managed policy appears before user settings, followed by the system layer.

**Data flow**: It receives the server’s layer list plus the expected managed and user file paths. It allows an optional managed-device layer first, then checks for a managed file layer, a user file layer, and a system layer in that order. It returns success if the stack matches.

**Call relations**: The managed-config override test calls this after reading config with layers. It captures the expected layering rule for that scenario so the test can separately check which individual values were overridden.

*Call graph*: called by 1 (config_read_includes_system_layer_and_overrides); 3 external calls (assert!, assert_eq!, matches!).


### `app-server/tests/suite/v2/experimental_feature_list.rs`

`test` · `test run`

This is a test file, not production code. It acts like a careful customer using the app server and checks that experimental feature controls behave correctly. Experimental features are optional or in-progress capabilities, often controlled by feature flags, which are simple on/off switches.

The tests start a temporary app server with its own throwaway home directory, send JSON-RPC requests to it, and inspect the replies. JSON-RPC is a request-and-response message format where each request has an id, so the test can wait for the matching answer. Some tests also create fake config files, fake project folders, or a fake ChatGPT backend server so they can check how the app behaves under realistic conditions without touching a real account or network service.

The first group checks listing: the server should return every known feature, its stage such as beta or stable, its display text when relevant, and whether it is currently enabled. It also checks special cases: workspace policy can disable apps and plugins, thread-specific project config can enable a feature, and an unknown thread id should be rejected with a clear error.

The second group checks setting feature enablement. It verifies that saved enablement shows up in config reads, does not override explicit user config, only changes named features, treats an empty update as a no-op, allows remote control, and ignores feature names that are not safe or valid to set through this endpoint.

#### Function details

##### `experimental_feature_list_returns_feature_metadata_with_stage`  (lines 43–102)

```
async fn experimental_feature_list_returns_feature_metadata_with_stage() -> Result<()>
```

**Purpose**: This test checks that asking the server for the experimental feature list returns the same feature information that the product has registered internally. It verifies not just feature names, but also stage, display text, announcement text, enabled state, and default enabled state.

**Data flow**: It starts with a fresh temporary Codex home folder and builds a matching config object so the test knows what the expected enabled values should be. It starts the test app server, sends a feature-list request, reads the response, builds the expected list from the central FEATURES registry, and compares the two. The output is a pass if the server response exactly matches the expected feature metadata.

**Call relations**: The async test runner calls this test. Inside the test, the temporary server is initialized, a feature-list request is sent through TestAppServer, and the shared read_response helper turns the server's JSON-RPC reply into an ExperimentalFeatureListResponse that can be compared.

*Call graph*: calls 2 internal fn (new, with_managed_config_path_for_tests); 5 external calls (new, default, assert_eq!, default, timeout).


##### `experimental_feature_list_marks_apps_and_plugins_disabled_by_workspace_policy`  (lines 105–160)

```
async fn experimental_feature_list_marks_apps_and_plugins_disabled_by_workspace_policy() -> Result<()>
```

**Purpose**: This test checks that organization or workspace policy can force certain features off even when they are normally enabled by default. In this case, it verifies that apps and plugins appear disabled when the mocked account settings say plugins are not allowed.

**Data flow**: It creates a temporary home folder, writes a config pointing to a fake backend server, and writes fake ChatGPT authentication data. The fake backend is set up to return account settings with plugins disabled. After the app server starts, the test requests the feature list and looks up the apps and plugins entries. The expected result is that both are reported as not enabled, while their default-enabled values remain true.

**Call relations**: The async test runner calls this test. The test relies on a wiremock server to stand in for the real ChatGPT backend, then uses TestAppServer to initialize the app and request the feature list. It uses read_response to decode the server reply before checking the policy effect.

*Call graph*: calls 2 internal fn (new, new_without_managed_config); 13 external calls (given, start, new, new, default, write_chatgpt_auth, assert!, format!, write, timeout (+3 more)).


##### `experimental_feature_list_resolves_thread_project_config`  (lines 163–227)

```
async fn experimental_feature_list_resolves_thread_project_config() -> Result<()>
```

**Purpose**: This test checks that feature listing can take a running thread's project folder into account. It proves that project-local config, such as a .codex/config.toml file, can affect whether a feature is shown as enabled for that thread.

**Data flow**: It creates a fake model provider server, a temporary Codex home, and a separate temporary workspace. It writes global config that trusts the workspace and project config that enables the memories feature. Then it starts the app server, starts a thread using that workspace as its current folder, requests the feature list for that thread id, and checks that memories is enabled in the response.

**Call relations**: The async test runner calls this test. The test first asks TestAppServer to start a thread, reads the ThreadStartResponse with read_response, then sends a feature-list request that includes the returned thread id. This ties the feature-list endpoint to the thread's resolved project configuration.

*Call graph*: calls 1 internal fn (new_without_managed_config); 8 external calls (default, new, create_mock_responses_server_repeating_assistant, assert!, format!, create_dir_all, write, timeout).


##### `experimental_feature_list_rejects_unknown_thread_id`  (lines 230–258)

```
async fn experimental_feature_list_rejects_unknown_thread_id() -> Result<()>
```

**Purpose**: This test checks that the feature-list endpoint does not silently accept a thread id that the server has never seen. A clear error matters because otherwise clients could believe they were reading project-specific settings when they were not.

**Data flow**: It starts a fresh test app server and sends a feature-list request containing a made-up UUID-like thread id. Instead of reading a normal response, it waits for a JSON-RPC error message for that request id. The expected output is an error with code -32600 and a message saying the thread was not found.

**Call relations**: The async test runner calls this test. It uses TestAppServer to send the bad request, then reads the error stream directly rather than using read_response because this scenario is expected to fail.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, assert!, assert_eq!, timeout).


##### `experimental_feature_enablement_set_applies_to_global_and_thread_config_reads`  (lines 261–295)

```
async fn experimental_feature_enablement_set_applies_to_global_and_thread_config_reads() -> Result<()>
```

**Purpose**: This test checks that setting a feature through the server is visible when clients later read configuration. It also checks that the setting is visible both with no project folder and with a project folder supplied.

**Data flow**: It creates a temporary Codex home and a project directory, starts the test server, and sends an enablement update that turns on auth_elicitation. The server returns the enablement it accepted. The test then reads config twice, once globally and once for the project folder, and checks that both config responses contain features.auth_elicitation set to true.

**Call relations**: The async test runner calls this test. It uses set_experimental_feature_enablement to send the update request and read_config to ask the server what configuration it now sees. Those helpers both rely on read_response to decode JSON-RPC replies.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 5 external calls (from, new, assert_eq!, create_dir_all, timeout).


##### `experimental_feature_enablement_set_does_not_override_user_config`  (lines 298–330)

```
async fn experimental_feature_enablement_set_does_not_override_user_config() -> Result<()>
```

**Purpose**: This test checks that server-side feature enablement does not trump a user's explicit config file choice. If a user has written that memories is false, this endpoint may record a requested enablement, but the final config read should still respect the user's file.

**Data flow**: It creates a temporary home folder and writes config.toml with memories set to false. Then it starts the app server and sends an enablement update asking to turn memories on. The update response echoes that request, but a later config read still shows memories as false. The important before-and-after is that the user's own config remains the winning value.

**Call relations**: The async test runner calls this test. It uses set_experimental_feature_enablement for the change request and read_config for the final check, with read_response underneath both helpers to turn server messages into typed Rust values.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 5 external calls (from, new, assert_eq!, write, timeout).


##### `experimental_feature_enablement_set_only_updates_named_features`  (lines 333–405)

```
async fn experimental_feature_enablement_set_only_updates_named_features() -> Result<()>
```

**Purpose**: This test checks that a later enablement update only changes the features named in that update and leaves previously saved feature choices alone. This prevents a partial update from accidentally wiping unrelated settings.

**Data flow**: It starts a fresh server, first turns mentions_v2 on, and then sends a second update for auth_elicitation, memories, remote_plugin, and tool_suggest. The second response contains only the features from the second update. A later config read shows both the earlier mentions_v2 value and all the newer values, proving the update was merged rather than replacing the whole feature map.

**Call relations**: The async test runner calls this test. It repeatedly uses set_experimental_feature_enablement to send updates to the server, then calls read_config to inspect the combined result. Both helpers pass their request ids to read_response to wait for and decode the matching server response.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 4 external calls (from, new, assert_eq!, timeout).


##### `experimental_feature_enablement_set_allows_remote_control`  (lines 408–423)

```
async fn experimental_feature_enablement_set_allows_remote_control() -> Result<()>
```

**Purpose**: This test checks that the remote_control feature can be explicitly set through the enablement endpoint. It is a focused guard against accidentally blocking that particular feature name.

**Data flow**: It starts a temporary test server, builds a one-item map setting remote_control to false, and sends it to the server. The server response is expected to contain the same accepted map. Nothing else is inspected because the point is whether this feature name is allowed through the endpoint.

**Call relations**: The async test runner calls this test. The test delegates the request-and-response details to set_experimental_feature_enablement, which sends the JSON-RPC request and uses read_response to decode the reply.

*Call graph*: calls 2 internal fn (new, set_experimental_feature_enablement); 4 external calls (from, new, assert_eq!, timeout).


##### `experimental_feature_enablement_set_empty_map_is_no_op`  (lines 426–456)

```
async fn experimental_feature_enablement_set_empty_map_is_no_op() -> Result<()>
```

**Purpose**: This test checks that sending an empty feature-enablements map does nothing. That matters because clients may send an empty update, and the server should not treat it as a request to clear existing saved choices.

**Data flow**: It starts a test server, first turns mentions_v2 on, then sends an empty enablement map. The response to the empty update is an empty map. A later config read still shows mentions_v2 set to true, proving no existing setting was removed.

**Call relations**: The async test runner calls this test. It uses set_experimental_feature_enablement for both the initial real update and the empty update, then uses read_config to verify the saved configuration remains intact. read_response is the shared decoding step behind those helpers.

*Call graph*: calls 3 internal fn (new, read_config, set_experimental_feature_enablement); 5 external calls (from, new, new, assert_eq!, timeout).


##### `experimental_feature_enablement_set_ignores_invalid_features`  (lines 459–486)

```
async fn experimental_feature_enablement_set_ignores_invalid_features() -> Result<()>
```

**Purpose**: This test checks that the enablement endpoint filters out feature names that should not be changed through it. It accepts a valid feature from the request but ignores disallowed or unknown names.

**Data flow**: It starts a fresh server and sends a map containing several feature names, including apps, connectors, plugins, an unknown feature, and auth_elicitation. The server's response contains only auth_elicitation set to true. The before-and-after story is that the noisy input is reduced to the safe, accepted update.

**Call relations**: The async test runner calls this test. It uses set_experimental_feature_enablement to send the mixed valid-and-invalid request and to decode the server's accepted enablement response via read_response.

*Call graph*: calls 2 internal fn (new, set_experimental_feature_enablement); 4 external calls (from, new, assert_eq!, timeout).


##### `set_experimental_feature_enablement`  (lines 488–498)

```
async fn set_experimental_feature_enablement(
    mcp: &mut TestAppServer,
    enablement: BTreeMap<String, bool>,
) -> Result<ExperimentalFeatureEnablementSetResponse>
```

**Purpose**: This helper sends a request to change experimental feature on/off values and returns the server's typed response. It keeps the repeated request boilerplate out of the individual tests.

**Data flow**: It receives a mutable TestAppServer connection and a map from feature name to true or false. It wraps that map in ExperimentalFeatureEnablementSetParams, sends it to the server, gets back a request id, and passes that id to read_response. The returned value is an ExperimentalFeatureEnablementSetResponse showing what the server accepted.

**Call relations**: The feature-enablements tests call this helper whenever they need to update feature settings. This helper hands off the low-level waiting and decoding work to read_response so each test can focus on the expected behavior rather than message plumbing.

*Call graph*: calls 2 internal fn (send_experimental_feature_enablement_set_request, read_response); called by 6 (experimental_feature_enablement_set_allows_remote_control, experimental_feature_enablement_set_applies_to_global_and_thread_config_reads, experimental_feature_enablement_set_does_not_override_user_config, experimental_feature_enablement_set_empty_map_is_no_op, experimental_feature_enablement_set_ignores_invalid_features, experimental_feature_enablement_set_only_updates_named_features).


##### `read_config`  (lines 500–508)

```
async fn read_config(mcp: &mut TestAppServer, cwd: Option<String>) -> Result<ConfigReadResponse>
```

**Purpose**: This helper asks the test app server to read its current configuration, optionally as if it were running from a specific project folder. It gives tests a simple way to check what configuration the server would actually use.

**Data flow**: It receives a mutable TestAppServer connection and an optional current working directory string. It sends a ConfigReadParams request with include_layers set to false, gets a request id, and passes that id to read_response. The result is a ConfigReadResponse containing the effective config the tests can inspect.

**Call relations**: Tests that need to verify saved feature settings call read_config after making changes. It sends the config-read request through TestAppServer and relies on read_response to wait for the matching JSON-RPC response.

*Call graph*: calls 2 internal fn (send_config_read_request, read_response); called by 4 (experimental_feature_enablement_set_applies_to_global_and_thread_config_reads, experimental_feature_enablement_set_does_not_override_user_config, experimental_feature_enablement_set_empty_map_is_no_op, experimental_feature_enablement_set_only_updates_named_features).


##### `read_response`  (lines 510–517)

```
async fn read_response(mcp: &mut TestAppServer, request_id: i64) -> Result<T>
```

**Purpose**: This helper waits for the app server to produce the response for a particular request id and converts it into the specific response type the caller expects. It also applies a timeout so a broken test does not hang forever.

**Data flow**: It receives a mutable TestAppServer connection and a numeric request id. It waits up to the default timeout for a JSON-RPC response with that id, then converts the generic JSON-RPC response into the requested Rust type. The output is the typed response, or an error if the wait times out, the server reports a problem, or decoding fails.

**Call relations**: The other helpers call read_response after sending requests, and some tests use the same pattern to read direct responses. It is the common bridge between raw server messages and the strongly typed values that assertions compare.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); called by 2 (read_config, set_experimental_feature_enablement); 3 external calls (Integer, to_response, timeout).


### `app-server/tests/suite/v2/model_provider_capabilities_read.rs`

`test` · `test run`

The app server can work with different model providers, and not every provider supports the same features. For example, one provider may allow image generation or web search, while another may not. This test file makes sure the server tells clients the truth about those capabilities through the `model_provider_capabilities_read` request.

Each test starts a temporary, isolated server home directory, like giving the server a fresh empty desk to work from. The first test leaves the configuration alone, so the server uses its default provider. The second test writes a small `config.toml` file that selects `amazon-bedrock` as the provider before starting the server.

After startup, each test sends a request asking, “What can the current model provider do?” It waits for the matching JSON-RPC response. JSON-RPC is a simple message format where a client sends a request with an ID and later receives a response with the same ID. The test then converts the raw response into the expected response type and compares it with the hard-coded truth for that provider.

The timeouts are important: if the server hangs or never replies, the test fails instead of waiting forever.

#### Function details

##### `read_default_provider_capabilities`  (lines 17–39)

```
async fn read_default_provider_capabilities() -> Result<()>
```

**Purpose**: This test proves that, with no custom configuration, the server reports the default model provider as supporting namespace tools, image generation, and web search. Someone would use this test to catch accidental changes to the default provider capability response.

**Data flow**: It starts with a brand-new temporary server home directory and no config file. The test launches and initializes a test app server, sends an empty capabilities-read request, waits for the response with the matching request ID, converts that response into a typed result, and checks that all three capability flags are `true`. Nothing lasting is written outside the temporary directory.

**Call relations**: During the test flow, it relies on the test server helper to create and initialize a server, then uses the helper request method to ask for provider capabilities. It waits through Tokio's timeout wrapper so a missing response becomes a test failure. Finally, it hands the raw JSON-RPC response to the response-conversion helper before comparing the received value with the expected one.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `read_amazon_bedrock_provider_capabilities`  (lines 42–69)

```
async fn read_amazon_bedrock_provider_capabilities() -> Result<()>
```

**Purpose**: This test proves that when the server is configured to use Amazon Bedrock, it reports the more limited feature set for that provider. In particular, it confirms that namespace tools are available but image generation and web search are not.

**Data flow**: It begins by creating a temporary server home directory, then writes a `config.toml` file selecting `amazon-bedrock` as the model provider. After launching and initializing the server with that configuration, it sends the same capabilities-read request, waits for the response with the matching request ID, converts the raw response into the expected response type, and checks that only `namespace_tools` is `true` while the other two flags are `false`.

**Call relations**: This test follows the same request-and-response path as the default-provider test, but first changes the server's starting configuration by writing a config file. The test server reads that file during startup, the capabilities request asks the running server what the selected provider supports, and the response-conversion and equality check confirm that the server's answer matches Amazon Bedrock's expected limits.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


### Discovery and listing APIs
These suites exercise read-only discovery endpoints that enumerate built-in and configured server-visible resources and presets.

### `app-server/tests/suite/v2/collaboration_mode_list.rs`

`test` · `test run`

This is an automated test for one app-server endpoint: the request that asks, “What collaboration modes are available?” A collaboration mode is a preset that describes how the assistant should behave, including things like the mode name, model, and reasoning effort. The test starts a real app-server through the project’s MCP test harness. MCP here is the communication layer used by the test to talk to the server, much like a remote control sending commands to a device.

The test creates a temporary home directory so it does not touch a developer’s real files. It then starts and initializes the server, sends a request to list collaboration modes, waits for the matching JSON-RPC response, and converts that response into the expected typed response object. JSON-RPC is a simple message format where each request has an ID and the response carries the same ID back.

Finally, the test builds the expected answer from the core project’s built-in collaboration mode presets and compares it to what the server returned. This matters because if someone changes the endpoint response by accident, removes a default mode, changes the order, or forgets to include a field, this test will fail before the change reaches users.

#### Function details

##### `list_collaboration_modes_returns_presets`  (lines 29–59)

```
async fn list_collaboration_modes_returns_presets() -> Result<()>
```

**Purpose**: This test proves that the server returns the default collaboration mode presets through the list endpoint. It is used to catch accidental changes to the API response, including missing fields, changed values, or a different order.

**Data flow**: It starts with a fresh temporary directory and uses it to launch a test app server. It initializes that server, sends a default “list collaboration modes” request, and waits for the response with the matching request ID. It then turns the raw JSON-RPC message into a collaboration-mode list, builds the expected list from the built-in presets, and checks that the two lists are exactly equal. The output is success if they match, or a test failure if they do not.

**Call relations**: During the test run, this function is the whole scenario. It creates the test server, asks the core code for the built-in collaboration mode presets, sends the list request through the server harness, waits with a timeout so the test cannot hang forever, and uses the assertion at the end to report whether the server’s answer still matches the expected contract.

*Call graph*: calls 2 internal fn (new, builtin_collaboration_mode_presets); 5 external calls (new, Integer, default, assert_eq!, timeout).


### `app-server/tests/suite/v2/model_list.rs`

`test` · `test run`

This is a test file. Its job is to prove that the app server gives clients the right model list in the right shape. A “model” here is an AI option shown to the user, with details like its display name, reasoning choices, service tiers, whether it is hidden, and whether it is the default.

The tests start a temporary app server with a temporary home folder, like giving the server a clean desk for each test. Some tests write a cached model catalog to disk, then ask the server for models and compare the answer with what the built-in presets say should be visible. One test asks for hidden models too, to make sure the server can include models that are normally not shown in the picker.

Another test sets up a fake remote OpenAI/ChatGPT server. It proves that when ChatGPT authentication is present, the server treats the remote `/models` response as the source of truth instead of only using the local cache. The file also tests pagination: asking for one model at a time should eventually return every expected model and then stop. Finally, it checks that an invalid cursor is rejected with the expected JSON-RPC error. JSON-RPC is the request-and-response format used by this app server protocol.

#### Function details

##### `model_from_preset`  (lines 33–76)

```
fn model_from_preset(preset: &ModelPreset) -> Model
```

**Purpose**: This helper converts an internal model preset into the public `Model` shape that the app server returns to clients. It lets the tests compare server output against expected values without hand-writing every model field each time.

**Data flow**: It takes one `ModelPreset`, which is the internal description of a model. It copies and reshapes its fields into a `Model`, including upgrade information, reasoning-effort choices, input types, service tiers, visibility, and default status. The result is a client-facing model object ready to compare with the server response.

**Call relations**: Other helpers and tests use this as the translation step between the project’s built-in model catalog and the protocol response format. In this file it is especially used when building expected model lists, including expected items created from a fake remote catalog.


##### `expected_visible_models`  (lines 78–93)

```
fn expected_visible_models() -> Vec<Model>
```

**Purpose**: This helper builds the list of models that should normally be visible to a non-ChatGPT-authenticated user. It mirrors the same filtering and default-choice rules the app server is expected to use.

**Data flow**: It starts with all test model presets, filters them for the non-ChatGPT authentication case, marks which visible model should be the default, removes presets that should not appear in the picker, and converts the remaining presets into public `Model` objects. The output is the expected visible model list used by tests.

**Call relations**: The main listing and pagination tests call this helper before comparing results. It relies on the shared model-preset utilities, so the tests are checking the app server against the same catalog rules that define which models should be available.

*Call graph*: calls 3 internal fn (all_model_presets, filter_by_auth, mark_default_by_picker_visibility); called by 2 (list_models_pagination_works, list_models_returns_all_models_with_large_limit).


##### `list_models_returns_all_models_with_large_limit`  (lines 96–127)

```
async fn list_models_returns_all_models_with_large_limit() -> Result<()>
```

**Purpose**: This test proves that asking for models with a large enough limit returns the full visible list in one response. It also checks that there is no next page when everything fits.

**Data flow**: The test creates a temporary home folder, writes a cached model catalog there, starts and initializes a test app server, and sends a `model/list` request with a limit of 100. It reads the matching JSON-RPC response, turns it into a `ModelListResponse`, and compares the returned models and cursor with the expected visible list.

**Call relations**: This is a direct end-to-end check of the app server’s model-list route. It uses `expected_visible_models` as the reference answer, then verifies that the server returns that answer over the normal test protocol.

*Call graph*: calls 2 internal fn (new, expected_visible_models); 6 external calls (new, Integer, write_models_cache, assert!, assert_eq!, timeout).


##### `list_models_includes_hidden_models`  (lines 130–159)

```
async fn list_models_includes_hidden_models() -> Result<()>
```

**Purpose**: This test checks the optional behavior that includes hidden models in the response. Hidden models are models that exist in the catalog but are normally not shown in the picker.

**Data flow**: The test creates a temporary server setup with a cached model catalog, initializes the server, and sends a `model/list` request with `include_hidden` set to true. It reads the response and checks that at least one returned item is marked hidden, and that there is no next page for the large limit used.

**Call relations**: This test exercises the same app-server request path as the normal listing test, but changes one input flag. It proves the server does not always drop hidden models and can expose them when the client explicitly asks.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, write_models_cache, assert!, timeout).


##### `list_models_uses_chatgpt_remote_catalog_as_source_of_truth`  (lines 162–270)

```
async fn list_models_uses_chatgpt_remote_catalog_as_source_of_truth() -> Result<()>
```

**Purpose**: This test proves that, in ChatGPT-authenticated mode, the server uses the remote model catalog as the authority. That matters because ChatGPT users may receive model availability from the service rather than only from local cached presets.

**Data flow**: The test starts a fake HTTP server and prepares one remote-only model response. It writes app configuration pointing the app server at that fake server, writes ChatGPT-style authentication into the temporary home folder, starts the test app server without an API key environment override, and sends a `model/list` request. It then builds the expected response from the remote model, compares it with what the app server returned, checks there is no next page, and confirms the fake `/models` endpoint was called exactly once.

**Call relations**: This test brings together the app server, authentication setup, configuration, and mocked network catalog. It hands the fake remote model through the same conversion helper used elsewhere, then verifies the server’s response matches the remote catalog rather than some unrelated local default.

*Call graph*: calls 4 internal fn (new, new_with_env, mount_models_once, mark_default_by_picker_visibility); 12 external calls (start, new, Integer, write_chatgpt_auth, assert!, assert_eq!, format!, json!, from_value, write (+2 more)).


##### `list_models_pagination_works`  (lines 273–319)

```
async fn list_models_pagination_works() -> Result<()>
```

**Purpose**: This test checks that model-list pagination works correctly when the client asks for one model per page. Pagination is the practice of splitting a long list into smaller chunks using a cursor that points to the next chunk.

**Data flow**: The test starts a temporary app server with a cached model list and computes the full expected visible list. It repeatedly sends `model/list` requests with limit 1 and the latest cursor, collects each returned model, and follows `next_cursor` until the server says there are no more pages. At the end, the collected models must equal the full expected list; if the cursor never ends, the test fails.

**Call relations**: This test uses `expected_visible_models` as the complete answer, then walks through the server’s page-by-page behavior. It checks both the server’s ability to return a single item at a time and its ability to produce and finish cursors correctly.

*Call graph*: calls 2 internal fn (new, expected_visible_models); 7 external calls (new, new, Integer, write_models_cache, assert_eq!, panic!, timeout).


##### `list_models_rejects_invalid_cursor`  (lines 322–347)

```
async fn list_models_rejects_invalid_cursor() -> Result<()>
```

**Purpose**: This test makes sure the server rejects a malformed pagination cursor instead of guessing or silently returning the wrong page. That protects clients from confusing or inconsistent pagination results.

**Data flow**: The test starts a temporary app server with a cached model catalog, initializes it, and sends a `model/list` request with the cursor value `invalid`. Instead of reading a normal response, it reads an error response and checks that the error belongs to the same request, uses the JSON-RPC invalid-request code, and says exactly which cursor was invalid.

**Call relations**: This test exercises the error path for the same model-list request used by the other tests. It confirms that bad client input is turned into a clear JSON-RPC error rather than a normal model-list response.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, Integer, write_models_cache, assert_eq!, timeout).


### `app-server/tests/suite/v2/permission_profile_list.rs`

`test` · `test run`

Permission profiles are named sets of rules that decide what the app is allowed to do, such as whether it can read files or write inside a workspace. This test file makes sure the server gives clients an accurate list of those profiles.

Each test creates temporary folders so it can build a fake Codex home directory and, when needed, a fake project workspace. It writes small `config.toml` files into those folders, starts a test app server, asks the server for the permission profile list, and compares the reply with the exact list expected.

The file checks three important situations. First, the server should always include the built-in profiles, then add profiles from the user’s main config. Second, if a request includes a current working directory for a trusted project, the server should also find profiles stored in that project’s `.codex/config.toml`, and it should split results into pages when a limit is provided. Third, project profiles should still be found even when no default permission profile was selected in the main config.

The helper `read_response` hides the repeated work of waiting for the matching JSON-RPC reply. JSON-RPC is a simple request-and-response message format; here it lets the test send a request with an ID and wait until the server answers that same ID.

#### Function details

##### `permission_profile_list_returns_builtin_and_configured_profiles`  (lines 23–85)

```
async fn permission_profile_list_returns_builtin_and_configured_profiles() -> Result<()>
```

**Purpose**: This test verifies that the permission profile list contains both the standard built-in profiles and profiles defined in the user's main configuration file. It also checks that custom descriptions are returned correctly.

**Data flow**: The test starts with a fresh temporary Codex home folder, writes a `config.toml` containing two custom permission profiles, then starts a test server using that folder. It sends a permission-profile-list request with no cursor, no limit, and no project directory. The server response is converted into a `PermissionProfileListResponse`, and the test compares it to the expected list: three built-in profiles followed by the two configured profiles, with no next page.

**Call relations**: During the test, the temporary server is created and initialized before the request is sent. After the request, this function relies on `read_response` to wait for and decode the matching server reply, then uses an equality assertion to prove the server returned the exact profile list expected.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, write, timeout).


##### `permission_profile_list_resolves_project_profiles_and_paginates`  (lines 88–163)

```
async fn permission_profile_list_resolves_project_profiles_and_paginates() -> Result<()>
```

**Purpose**: This test verifies two behaviors at once: project-specific permission profiles are discovered when the request points at a trusted workspace, and long results can be returned one page at a time. It makes sure the server can continue a list from a cursor, which is like a bookmark for the next page.

**Data flow**: The test creates a temporary Codex home folder and a separate temporary workspace. It writes a main config file with a default built-in profile, writes a project config file containing one project profile, and marks the workspace as trusted. It then starts the test server and sends a first list request with a limit of three, receiving only the three built-in profiles plus a next cursor. It sends a second request using that cursor and receives the remaining project profile, with no further cursor.

**Call relations**: This function sets up both user-level and project-level configuration before the server starts. It uses the test server to send two related list requests, and each time hands the request ID to `read_response` so the correct JSON-RPC response can be collected and decoded. The two assertions together confirm both the ordering of profiles and the pagination behavior.

*Call graph*: calls 2 internal fn (new, set_project_trust_level); 5 external calls (new, assert_eq!, create_dir_all, write, timeout).


##### `permission_profile_list_discovers_project_profiles_without_default_selection`  (lines 166–221)

```
async fn permission_profile_list_discovers_project_profiles_without_default_selection() -> Result<()>
```

**Purpose**: This test checks that project permission profiles are still found even if the user's main config does not choose a default permission profile. That matters because discovery of available profiles should not depend on a separate default setting.

**Data flow**: The test creates a temporary Codex home folder and a temporary workspace, writes only a project-level `.codex/config.toml` with one permission profile, and marks that workspace as trusted. It starts the test server and sends a permission-profile-list request with the workspace path as the current directory. The returned response is expected to contain the three built-in profiles plus the project profile, with no next page.

**Call relations**: This test prepares a trusted workspace, then asks the server for profiles in the context of that workspace. Like the other tests, it uses `read_response` to wait for the matching server reply, then compares the decoded response against the exact expected result.

*Call graph*: calls 2 internal fn (new, set_project_trust_level); 5 external calls (new, assert_eq!, create_dir_all, write, timeout).


##### `read_response`  (lines 223–233)

```
async fn read_response(
    mcp: &mut TestAppServer,
    request_id: i64,
) -> Result<T>
```

**Purpose**: This helper waits for the app server to send the response for a specific request and turns that raw JSON-RPC response into the strongly typed result the test wants. It keeps the tests shorter and avoids repeating the same waiting and decoding code.

**Data flow**: It receives a mutable test server connection and the numeric request ID that was returned when the request was sent. It waits, with a timeout, until the server stream contains a response message with that same ID. Then it converts the generic JSON-RPC response into the requested Rust type and returns it, or returns an error if waiting or decoding fails.

**Call relations**: The test functions send permission-profile-list requests and then call this helper with the returned request ID. Internally, it asks the test server to read from its message stream, wraps the ID as a JSON-RPC integer request ID, and passes the raw response to `to_response` so each test receives a clean typed response to assert against.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); 3 external calls (Integer, to_response, timeout).


### Execution and environment RPCs
These tests cover the core operational RPC surfaces for filesystem access, process execution, and Windows sandbox setup.

### `app-server/tests/suite/v2/fs.rs`

`test` · `test run`

These tests treat the app server like a client would: they start a temporary server, send JSON-RPC requests, and check the replies. JSON-RPC is a simple request-and-response message format where each request has a method name, parameters, and an id. The temporary directory acts like a small pretend project folder, so the tests can freely create and destroy files without touching the real machine.

The file covers the full filesystem surface exposed by the server. It checks basic actions such as creating folders, writing base64-encoded file contents, reading those contents back, copying files and folders, listing directory entries, and removing directory trees. It also checks edge cases that matter for safety and correctness: relative paths must be rejected, invalid base64 must fail cleanly, copying a directory into itself must be blocked, and special Unix-only file types such as symlinks and FIFOs get the intended treatment.

The last group of tests checks file watching. A watch is like asking the server to ring a bell when a file or directory changes. Because operating-system file notifications can be unreliable in sandboxed test environments, these tests accept missing notifications in some cases, but verify the notification shape when one arrives. Without this file, regressions in the server's filesystem contract could silently break clients that depend on these operations.

#### Function details

##### `initialized_mcp`  (lines 39–43)

```
async fn initialized_mcp(codex_home: &TempDir) -> Result<TestAppServer>
```

**Purpose**: Starts a fresh test app server and waits for it to finish its initialization handshake. Tests use it when they need a ready-to-use server before sending filesystem requests.

**Data flow**: It receives a temporary Codex home directory. It starts `TestAppServer` using that directory, waits up to the default timeout for initialization to complete, and returns the ready server object. If startup or initialization fails, the error is passed back to the test.

**Call relations**: Most tests call this helper at the beginning, so they do not repeat the same server startup steps. After it returns, each test sends specific filesystem requests through the returned `TestAppServer`.

*Call graph*: calls 1 internal fn (new); called by 15 (fs_copy_ignores_unknown_special_files_in_recursive_copy, fs_copy_preserves_symlinks_in_recursive_copy, fs_copy_rejects_copying_directory_into_descendant, fs_copy_rejects_directory_without_recursive, fs_copy_rejects_standalone_fifo_source, fs_get_metadata_reports_symlink, fs_get_metadata_returns_only_used_fields, fs_methods_cover_current_fs_utils_surface, fs_methods_reject_relative_paths, fs_watch_allows_missing_file_targets (+5 more)); 2 external calls (path, timeout).


##### `expect_error_message`  (lines 45–57)

```
async fn expect_error_message(
    mcp: &mut TestAppServer,
    request_id: i64,
    expected_message: &str,
) -> Result<()>
```

**Purpose**: Waits for a request to fail and checks that the server's error message is exactly the expected one. This keeps tests focused on the behavior they care about rather than the mechanics of reading error responses.

**Data flow**: It receives the test server, the id of a request already sent, and the expected text. It waits for an error response with that id, compares the server's message with the expected message, and returns success only if they match.

**Call relations**: Error-focused tests call this after sending a bad request, such as a relative path or unsupported filesystem operation. It reads the server stream directly and does not hand work off except to the test assertion.

*Call graph*: calls 1 internal fn (read_stream_until_error_message); called by 4 (fs_copy_rejects_standalone_fifo_source, fs_methods_reject_relative_paths, fs_methods_return_error_when_local_environment_is_disabled, fs_watch_rejects_relative_paths); 3 external calls (Integer, assert_eq!, timeout).


##### `absolute_path`  (lines 59–66)

```
fn absolute_path(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts a normal path into the project's `AbsolutePathBuf` type, after confirming the path really is absolute. The server protocol requires absolute paths, so this helper makes test inputs match that contract.

**Data flow**: It receives a `PathBuf`, checks that it is absolute, converts it into `AbsolutePathBuf`, and returns that converted value. If the path is not absolute or cannot be converted, the test stops immediately.

**Call relations**: Nearly every filesystem test uses this helper before sending paths to the server. It sits between temporary test paths and protocol request structs, making sure tests do not accidentally send invalid paths unless they are deliberately testing that error.

*Call graph*: calls 1 internal fn (try_from); called by 14 (fs_copy_ignores_unknown_special_files_in_recursive_copy, fs_copy_preserves_symlinks_in_recursive_copy, fs_copy_rejects_copying_directory_into_descendant, fs_copy_rejects_directory_without_recursive, fs_copy_rejects_standalone_fifo_source, fs_get_metadata_reports_symlink, fs_get_metadata_returns_only_used_fields, fs_methods_cover_current_fs_utils_surface, fs_methods_return_error_when_local_environment_is_disabled, fs_watch_allows_missing_file_targets (+4 more)); 1 external calls (assert!).


##### `fs_get_metadata_returns_only_used_fields`  (lines 69–120)

```
async fn fs_get_metadata_returns_only_used_fields() -> Result<()>
```

**Purpose**: Checks that `fs/getMetadata` returns only the fields clients are expected to use, and that those fields correctly describe a regular file. This protects the public response shape from accidental extra data.

**Data flow**: The test creates a temporary text file, starts the server, sends a metadata request for that file, and inspects the JSON response keys. It then converts the response into the typed metadata structure and verifies that the file flags and timestamp values make sense.

**Call relations**: It uses `initialized_mcp` for server setup and `absolute_path` to build the request. It relies on `to_response` to turn the JSON-RPC response into the typed protocol object before making detailed assertions.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 7 external calls (new, Integer, to_response, assert!, assert_eq!, write, timeout).


##### `fs_methods_return_error_when_local_environment_is_disabled`  (lines 123–142)

```
async fn fs_methods_return_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: Verifies that filesystem methods refuse to run when the local execution environment is disabled. This matters because the server should not pretend it can access local files when that capability is not configured.

**Data flow**: The test starts the server with an environment variable set so the local exec server is effectively unavailable. It sends a file-read request and expects the server to answer with the message `local filesystem is not configured`.

**Call relations**: Unlike most tests, it creates the server with a custom environment instead of using `initialized_mcp`. After sending the request, it delegates the error-response check to `expect_error_message`.

*Call graph*: calls 3 internal fn (new_with_env, absolute_path, expect_error_message); 2 external calls (new, timeout).


##### `fs_get_metadata_reports_symlink`  (lines 146–171)

```
async fn fs_get_metadata_reports_symlink() -> Result<()>
```

**Purpose**: On Unix systems, checks that metadata reports when a path is a symbolic link. A symbolic link is a filesystem shortcut that points to another file.

**Data flow**: The test creates a real file and then creates a symlink pointing to it. It asks the server for metadata about the symlink path and verifies that the response says it is a file and also a symlink, but not a directory.

**Call relations**: It follows the usual pattern: prepare files, call `initialized_mcp`, send a typed metadata request using `absolute_path`, then decode the response with `to_response`. This test only runs where Unix symlinks are available.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 7 external calls (new, Integer, to_response, assert_eq!, write, symlink, timeout).


##### `fs_methods_cover_current_fs_utils_surface`  (lines 174–322)

```
async fn fs_methods_cover_current_fs_utils_surface() -> Result<()>
```

**Purpose**: Exercises the main happy path for the filesystem API in one end-to-end flow. It confirms that the server can create folders, write files, read files, copy files and directories, list directories, and remove directory trees.

**Data flow**: The test builds paths inside a temporary directory, starts the server, creates a nested directory, writes two files using base64 data, reads one file back, copies a file, copies a whole directory tree, reads a directory listing, and finally removes the copied directory. At each step it checks either the server response or the actual files on disk.

**Call relations**: This is a broad integration test that uses `initialized_mcp` and `absolute_path` repeatedly. It sends several different filesystem requests through `TestAppServer`, then uses `to_response` when a reply has meaningful structured content.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `fs_write_file_accepts_base64_bytes`  (lines 325–364)

```
async fn fs_write_file_accepts_base64_bytes() -> Result<()>
```

**Purpose**: Checks that `fs/writeFile` can write raw binary bytes, not just text. The protocol carries file contents as base64, which is a text-safe way to represent arbitrary bytes.

**Data flow**: The test prepares a small byte array containing values that are not ordinary text, encodes it as base64, and sends it to the server as a write request. It checks the bytes written on disk, then reads the file through the server and verifies the returned base64 matches the original bytes.

**Call relations**: It uses the standard server setup helper and absolute-path helper. It sends both write and read requests, and uses `to_response` to inspect the read response as a typed `FsReadFileResponse`.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `fs_write_file_rejects_invalid_base64`  (lines 367–393)

```
async fn fs_write_file_rejects_invalid_base64() -> Result<()>
```

**Purpose**: Confirms that `fs/writeFile` rejects malformed base64 input with a clear error. This protects the server from writing nonsense when the client sends invalid encoded data.

**Data flow**: The test starts the server and sends a write request whose `dataBase64` field is deliberately invalid. It waits for an error response and checks that the message begins with the expected explanation.

**Call relations**: It follows the same request flow as successful write tests, but reads an error response instead of a success response. It uses `absolute_path` for the path and checks the error directly in the test.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 4 external calls (new, Integer, assert!, timeout).


##### `fs_methods_reject_relative_paths`  (lines 396–517)

```
async fn fs_methods_reject_relative_paths() -> Result<()>
```

**Purpose**: Checks that all filesystem methods reject relative paths such as `relative.txt`. Requiring absolute paths avoids ambiguity about which directory the server should treat as the starting point.

**Data flow**: The test creates one valid absolute file for copy-related cases, starts the server, and then sends raw JSON requests containing relative paths to read, write, create directory, get metadata, read directory, remove, and copy methods. For each request, it expects the same invalid-request message.

**Call relations**: This test intentionally bypasses the typed request helpers by using raw JSON, because the typed helpers would normally enforce absolute paths. It calls `expect_error_message` after each bad request to verify the server rejects it consistently.

*Call graph*: calls 2 internal fn (expect_error_message, initialized_mcp); 3 external calls (new, json!, write).


##### `fs_copy_rejects_directory_without_recursive`  (lines 520–544)

```
async fn fs_copy_rejects_directory_without_recursive() -> Result<()>
```

**Purpose**: Verifies that copying a directory fails unless the request explicitly asks for a recursive copy. Recursive means copying the directory and everything inside it.

**Data flow**: The test creates a source directory, starts the server, and sends a copy request with `recursive` set to false. It expects the server to reject the request with a message explaining that directories require `recursive: true`.

**Call relations**: It uses the common initialization and absolute-path helpers, then sends one copy request. Unlike the broad copy test, this one is focused on the guardrail that prevents accidental directory-tree copies.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 5 external calls (new, Integer, assert_eq!, create_dir_all, timeout).


##### `fs_copy_rejects_copying_directory_into_descendant`  (lines 547–571)

```
async fn fs_copy_rejects_copying_directory_into_descendant() -> Result<()>
```

**Purpose**: Checks that the server refuses to copy a directory into one of its own subdirectories. Without this guard, a copy could chase itself forever or create a confusing nested loop.

**Data flow**: The test creates a source directory with a nested child, starts the server, and asks to recursively copy the source into that child. It waits for the server error and checks that the message explains the self-or-descendant problem.

**Call relations**: It uses `initialized_mcp` and `absolute_path`, then sends a single bad copy request. This complements the successful recursive-copy test by checking a dangerous edge case.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 5 external calls (new, Integer, assert_eq!, create_dir_all, timeout).


##### `fs_copy_preserves_symlinks_in_recursive_copy`  (lines 575–603)

```
async fn fs_copy_preserves_symlinks_in_recursive_copy() -> Result<()>
```

**Purpose**: On Unix systems, verifies that recursive directory copying preserves symbolic links as links instead of turning them into ordinary copied folders or files.

**Data flow**: The test creates a directory and a symlink inside it, then asks the server to recursively copy the directory. After the copy finishes, it inspects the copied path directly on disk to confirm it is still a symlink and points to the same relative target.

**Call relations**: It uses the normal server and path helpers, then checks the filesystem outside the server after the copy request completes. This test only runs on Unix because it depends on Unix-style symlink behavior.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 8 external calls (new, Integer, assert!, assert_eq!, create_dir_all, symlink_metadata, symlink, timeout).


##### `fs_copy_ignores_unknown_special_files_in_recursive_copy`  (lines 607–644)

```
async fn fs_copy_ignores_unknown_special_files_in_recursive_copy() -> Result<()>
```

**Purpose**: On Unix systems, checks that recursive copy skips special filesystem entries it does not support, while still copying normal files. The special entry here is a FIFO, also called a named pipe, which is used for process communication rather than ordinary storage.

**Data flow**: The test creates a source directory containing a regular text file and a FIFO made with the `mkfifo` command. It asks the server to recursively copy the directory, then verifies the regular file was copied and the FIFO was not created in the destination.

**Call relations**: It uses `initialized_mcp` and `absolute_path` after preparing Unix-specific test data. If the `mkfifo` setup command fails, the test stops with a clear setup error instead of hiding the problem.

*Call graph*: calls 2 internal fn (absolute_path, initialized_mcp); 9 external calls (new, bail!, Integer, assert!, assert_eq!, new, create_dir_all, write, timeout).


##### `fs_copy_rejects_standalone_fifo_source`  (lines 648–676)

```
async fn fs_copy_rejects_standalone_fifo_source() -> Result<()>
```

**Purpose**: On Unix systems, verifies that copying a FIFO directly is rejected. This makes clear that `fs/copy` supports regular files, directories, and symlinks, not every possible filesystem object.

**Data flow**: The test creates a FIFO with `mkfifo`, starts the server, and sends a copy request using the FIFO as the source. It expects a specific error explaining the supported source types.

**Call relations**: It prepares Unix-only filesystem state, uses the common server and path helpers, then delegates the response check to `expect_error_message`. It is the direct-source counterpart to the recursive-copy test that skips special files.

*Call graph*: calls 3 internal fn (absolute_path, expect_error_message, initialized_mcp); 3 external calls (new, bail!, new).


##### `fs_watch_directory_reports_changed_child_paths_and_unwatch_stops_notifications`  (lines 679–745)

```
async fn fs_watch_directory_reports_changed_child_paths_and_unwatch_stops_notifications() -> Result<()>
```

**Purpose**: Tests watching a directory for changes and then stopping that watch. It checks that, when a notification arrives, it names the changed child file and that unwatching prevents later notifications.

**Data flow**: The test creates a fake `.git` directory and a `FETCH_HEAD` file, starts a watch on the directory, changes the file, and optionally reads a change notification. It then drains any extra notifications, sends an unwatch request, changes another file, and verifies no later `fs/changed` notification arrives within a short wait.

**Call relations**: It uses `initialized_mcp`, `absolute_path`, and `to_response` to set up and confirm the watch. It calls `maybe_fs_changed_notification` because file watching can be flaky in some test sandboxes, but it still strictly checks that unwatching quiets future events.

*Call graph*: calls 3 internal fn (absolute_path, initialized_mcp, maybe_fs_changed_notification); 9 external calls (from_millis, new, Integer, to_response, assert!, assert_eq!, create_dir_all, write, timeout).


##### `fs_watch_file_reports_atomic_replace_events`  (lines 748–785)

```
async fn fs_watch_file_reports_atomic_replace_events() -> Result<()>
```

**Purpose**: Checks that watching a single file can notice an atomic replacement, which is a common way tools update files safely. Atomic replacement means writing a temporary file and renaming it over the original.

**Data flow**: The test creates a fake Git `HEAD` file, starts a watch on that file, replaces it using `replace_file_atomically`, and then optionally reads an `fs/changed` notification. If a notification arrives, it must contain the watch id and the watched file path.

**Call relations**: It uses the standard setup helpers, then calls `replace_file_atomically` to simulate a realistic file update pattern. It calls `maybe_fs_changed_notification` so the test remains tolerant of environments where operating-system watch events do not arrive reliably.

*Call graph*: calls 4 internal fn (absolute_path, initialized_mcp, maybe_fs_changed_notification, replace_file_atomically); 7 external calls (new, Integer, to_response, assert_eq!, create_dir_all, write, timeout).


##### `fs_watch_allows_missing_file_targets`  (lines 788–824)

```
async fn fs_watch_allows_missing_file_targets() -> Result<()>
```

**Purpose**: Verifies that the server can watch a file path even before the file exists. This is useful for files that tools create later, such as Git metadata files.

**Data flow**: The test creates the parent directory but not the target file, starts a watch on the missing file path, and checks that the watch request succeeds. It then creates the file by atomic replacement and, if a change notification arrives, verifies it points to that file.

**Call relations**: It combines the watch setup flow with `replace_file_atomically` and `maybe_fs_changed_notification`. This confirms that the watch API is not limited to paths that already exist at watch time.

*Call graph*: calls 4 internal fn (absolute_path, initialized_mcp, maybe_fs_changed_notification, replace_file_atomically); 6 external calls (new, Integer, to_response, assert_eq!, create_dir_all, timeout).


##### `fs_watch_rejects_relative_paths`  (lines 827–845)

```
async fn fs_watch_rejects_relative_paths() -> Result<()>
```

**Purpose**: Checks that `fs/watch` follows the same absolute-path rule as the other filesystem methods. Watching a relative path would be ambiguous and could mean different things in different working directories.

**Data flow**: The test starts the server, sends a raw `fs/watch` request with a relative path, and expects the invalid absolute-path error message. No actual watch should be created.

**Call relations**: Like the relative-path test for other methods, it uses a raw JSON request to bypass typed helper validation. It then uses `expect_error_message` to confirm the server rejected the request.

*Call graph*: calls 2 internal fn (expect_error_message, initialized_mcp); 2 external calls (new, json!).


##### `fs_changed_notification`  (lines 847–852)

```
fn fs_changed_notification(notification: JSONRPCNotification) -> Result<FsChangedNotification>
```

**Purpose**: Turns a raw `fs/changed` JSON-RPC notification into the typed `FsChangedNotification` structure used by the tests. This lets tests compare watch notifications as normal Rust values instead of manually picking through JSON.

**Data flow**: It receives a notification, requires that it has `params`, and deserializes those parameters into `FsChangedNotification`. It returns the typed notification or an error if the message is missing data or has the wrong shape.

**Call relations**: It is called by `maybe_fs_changed_notification` after that helper receives a raw notification from the server stream. It is the small decoding step between transport-level JSON and watch-specific assertions.

*Call graph*: called by 1 (maybe_fs_changed_notification).


##### `maybe_fs_changed_notification`  (lines 854–866)

```
async fn maybe_fs_changed_notification(
    mcp: &mut TestAppServer,
) -> Result<Option<FsChangedNotification>>
```

**Purpose**: Waits briefly for an `fs/changed` notification and returns it if one arrives. It deliberately treats a timeout as `None` because filesystem watch events are not dependable in every test environment.

**Data flow**: It receives the test server, waits up to a short optional timeout for an `fs/changed` notification, and, if one arrives, decodes it with `fs_changed_notification`. It returns `Some(notification)` for a real event or `None` when no event arrives in time.

**Call relations**: The watch tests call this after making a file change. It reads from the server stream and hands successful messages to `fs_changed_notification` so the calling test can check the watch id and changed paths.

*Call graph*: calls 2 internal fn (read_stream_until_notification_message, fs_changed_notification); called by 3 (fs_watch_allows_missing_file_targets, fs_watch_directory_reports_changed_child_paths_and_unwatch_stops_notifications, fs_watch_file_reports_atomic_replace_events); 1 external calls (timeout).


##### `replace_file_atomically`  (lines 868–881)

```
fn replace_file_atomically(path: &PathBuf, contents: &str) -> Result<()>
```

**Purpose**: Replaces a file using the write-then-rename pattern that many real tools use. This helps tests check whether file watching notices realistic updates, not just simple overwrites.

**Data flow**: It receives a target path and new contents, writes the contents to a sibling temporary path with a `.lock` extension, and renames that temporary file over the target. On Windows it first removes the old target if present, because Windows rename behavior differs from Unix.

**Call relations**: The file-watch tests call this to trigger atomic replacement events. It changes the test filesystem directly; the server is expected to notice that change through its watch mechanism.

*Call graph*: called by 2 (fs_watch_allows_missing_file_targets, fs_watch_file_reports_atomic_replace_events); 4 external calls (with_extension, remove_file, rename, write).


### `app-server/tests/suite/v2/process_exec.rs`

`test` · `test run`

This test file acts like a safety checklist for the app server’s “run a local command” feature. That feature lets a client ask the server to spawn a process, such as a shell command, and later receive a notification when that process exits. Without these tests, the server could accidentally block while a process is still running, lose stdout or stderr output, ignore configured safety limits, or fail to kill long-running commands.

The tests create a temporary Codex home directory, start a test app server, and speak to it using the same protocol a real client would use. For commands, the file uses small cross-platform shell snippets: PowerShell on Windows and sh on Unix-like systems. One test uses a “probe and release” handshake, like asking a runner to raise their hand before crossing the finish line. The child process writes a probe file to prove it started, waits until the test creates a release file, then prints output and exits. This proves the spawn request returns before the process is done.

The file also verifies that process execution is rejected when the local environment is disabled, that long output is trimmed when an output byte cap is set, and that a kill request really terminates a sleeping process. Helper functions keep the repeated setup and message-reading steps readable.

#### Function details

##### `process_spawn_returns_before_exit_and_emits_exit_notification`  (lines 24–104)

```
async fn process_spawn_returns_before_exit_and_emits_exit_notification() -> Result<()>
```

**Purpose**: This test proves that asking the server to start a process returns immediately, rather than waiting for the process to finish. It also proves that the server later sends a clear “process exited” notification with the exit code and captured output.

**Data flow**: It creates a temporary home directory and a test server connection, then builds a command that writes a probe file, waits for a release file, prints to stdout and stderr, and exits. The test sends a spawn request with environment variables pointing to those files. It expects an empty successful spawn response first, then waits for the probe file, creates the release file, reads the later exit notification, and compares it with the expected process handle, exit code, stdout, stderr, and cap flags.

**Call relations**: This is one of the main end-to-end tests in the file. It relies on initialized_mcp to prepare a ready test server, process_spawn_params to build the common request shape, wait_for_file to avoid fragile timing guesses, and read_process_exited to turn the server’s notification into a typed result that can be checked.

*Call graph*: calls 4 internal fn (initialized_mcp, process_spawn_params, read_process_exited, wait_for_file); 7 external calls (from, new, Integer, assert_eq!, cfg!, write, vec!).


##### `process_spawn_returns_error_when_local_environment_is_disabled`  (lines 107–131)

```
async fn process_spawn_returns_error_when_local_environment_is_disabled() -> Result<()>
```

**Purpose**: This test checks the safety gate that prevents local process execution when the local environment is not configured. It makes sure the server gives a useful error instead of trying to run the command anyway.

**Data flow**: It creates a temporary home directory, starts a mock response server, writes configuration that disables the relevant local environment behavior, and starts the app server with the execution server URL environment variable set to “none”. It sends a process spawn request for a harmless command, then reads the error response and checks that the message says the local environment is not configured.

**Call relations**: Unlike the other tests, this one does its own setup instead of using initialized_mcp because it needs a deliberately disabled environment. It still uses process_spawn_params to create the request, then follows the normal request-response path through the test app server.

*Call graph*: calls 3 internal fn (new_with_env, create_config_toml, process_spawn_params); 7 external calls (new, new, Integer, create_mock_responses_server_sequence_unchecked, assert_eq!, timeout, vec!).


##### `process_spawn_reports_buffered_output_cap_reached`  (lines 134–180)

```
async fn process_spawn_reports_buffered_output_cap_reached() -> Result<()>
```

**Purpose**: This test verifies that the server enforces the configured limit on how many bytes of process output it stores. It also checks that the server tells the client when stdout or stderr was cut short.

**Data flow**: It starts a normal initialized test server, builds a command that writes five characters to stdout and five to stderr, and sends a spawn request with an output cap of three bytes. After the spawn response succeeds, it reads the exit notification. The expected result keeps only the first three characters of each stream and marks both cap flags as true.

**Call relations**: This test follows the same setup and notification-reading path as the successful spawn test: initialized_mcp prepares the server, process_spawn_params builds the request, and read_process_exited extracts the final process result. Its special role is to exercise the output limiting path.

*Call graph*: calls 3 internal fn (initialized_mcp, process_spawn_params, read_process_exited); 5 external calls (new, Integer, assert_eq!, cfg!, vec!).


##### `process_kill_terminates_running_process`  (lines 183–231)

```
async fn process_kill_terminates_running_process() -> Result<()>
```

**Purpose**: This test proves that a client can stop a process that is still running. It protects against a serious failure mode where long-lived child processes would be left behind after a kill request.

**Data flow**: It starts a test server, spawns a command that sleeps for a long time, and waits for the spawn request to succeed. Then it sends a kill request for the same process handle and expects that request to succeed too. Finally, it reads the process exit notification and checks that the handle matches, the exit code is non-zero, and no output was captured.

**Call relations**: This test uses initialized_mcp for setup, process_spawn_params to describe the sleeping command, and read_process_exited to observe the aftermath. It adds the kill request in the middle, so it checks the full story from spawn to forced shutdown to exit notification.

*Call graph*: calls 3 internal fn (initialized_mcp, process_spawn_params, read_process_exited); 7 external calls (new, Integer, assert!, assert_eq!, assert_ne!, cfg!, vec!).


##### `initialized_mcp`  (lines 233–239)

```
async fn initialized_mcp(codex_home: &Path) -> Result<(MockServer, TestAppServer)>
```

**Purpose**: This helper prepares a ready-to-use test app server connection. It hides the repeated setup needed before tests can send protocol messages.

**Data flow**: It receives a path to a temporary Codex home directory. It starts a mock server for external responses, writes a configuration file pointing at that mock server, creates a TestAppServer, initializes the protocol connection with a timeout, and returns both the mock server and the initialized app server.

**Call relations**: The main process-execution tests call this helper when they need a normal working server. It delegates configuration writing to create_config_toml and uses the test support server creation and initialization calls so each test can focus on process behavior instead of startup plumbing.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 3 (process_kill_terminates_running_process, process_spawn_reports_buffered_output_cap_reached, process_spawn_returns_before_exit_and_emits_exit_notification); 3 external calls (new, create_mock_responses_server_sequence_unchecked, timeout).


##### `process_spawn_params`  (lines 241–258)

```
fn process_spawn_params(
    process_handle: String,
    cwd: &Path,
    command: Vec<String>,
) -> Result<ProcessSpawnParams>
```

**Purpose**: This helper builds the standard request object used to ask the app server to spawn a process. It keeps the tests consistent by filling in the common defaults in one place.

**Data flow**: It receives a process handle, a working directory path, and a command represented as a list of strings. It converts the working directory into an absolute path type, sets terminal and streaming options to false, leaves optional limits and environment settings unset, and returns a ProcessSpawnParams value ready to customize or send.

**Call relations**: All four tests use this helper before sending a spawn request. Some tests then override particular fields, such as output_bytes_cap or env, while keeping the shared defaults from this function.

*Call graph*: calls 1 internal fn (try_from); called by 4 (process_kill_terminates_running_process, process_spawn_reports_buffered_output_cap_reached, process_spawn_returns_before_exit_and_emits_exit_notification, process_spawn_returns_error_when_local_environment_is_disabled).


##### `read_process_exited`  (lines 260–268)

```
async fn read_process_exited(mcp: &mut TestAppServer) -> Result<ProcessExitedNotification>
```

**Purpose**: This helper waits for the server’s “process/exited” notification and turns its JSON payload into a typed ProcessExitedNotification. It makes the tests read like they are checking a process result, not manually decoding protocol details.

**Data flow**: It takes a mutable test app server connection, waits until a notification named “process/exited” arrives, checks that the notification includes parameters, and deserializes those parameters into the expected notification structure. It returns that structure or an error if the message is missing or malformed.

**Call relations**: The tests that expect a process to finish call this after spawning or killing a process. It depends on the test app server’s stream-reading helper to find the right notification, then hands back a clean Rust value for assertions.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 3 (process_kill_terminates_running_process, process_spawn_reports_buffered_output_cap_reached, process_spawn_returns_before_exit_and_emits_exit_notification); 1 external calls (from_value).


##### `wait_for_file`  (lines 270–278)

```
async fn wait_for_file(path: &Path) -> Result<()>
```

**Purpose**: This helper waits until a particular file appears, but only up to the standard test timeout. It is used to synchronize with a child process without relying on unreliable sleep-based timing.

**Data flow**: It receives a file path and repeatedly checks whether that path exists, sleeping briefly between checks. If the file appears before the timeout, it succeeds. If not, it returns an error explaining that it timed out waiting for the probe file.

**Call relations**: The first spawn test uses this helper after sending the spawn request. The child process creates the probe file when it has really started, so wait_for_file lets the test safely know when to release the child process and continue to the exit-notification check.

*Call graph*: called by 1 (process_spawn_returns_before_exit_and_emits_exit_notification); 4 external calls (from_millis, exists, sleep, timeout).


### `app-server/tests/suite/v2/windows_sandbox_setup.rs`

`test` · `test run`

This is a test file for one small part of the app server’s external protocol: the `windowsSandbox/setupStart` request. In plain terms, it verifies that when a client asks the server to prepare a Windows sandbox, the server both accepts the request and later announces that setup has completed. It also checks that the server refuses a bad request where the working directory is given as a relative path, because a sandbox needs an unambiguous location to work from.

The first test builds a temporary fake environment. It starts a mock response server, writes a temporary configuration file that points the app server at that mock server, launches a test app server, and initializes it. Then it sends a Windows sandbox setup request in “unelevated” mode, meaning it should not require administrator-level privileges. The test waits for a normal response saying setup started, then waits for a notification saying setup completed, and confirms the notification reports the same mode.

The second test focuses on input validation. It sends a raw request with `cwd` set to `relative-root`, which is not an absolute path. The expected result is a JSON-RPC error. JSON-RPC is a simple request/response message format; here the test expects the standard “invalid request” error code. These tests matter because they protect both the happy path and an important safety check in the sandbox setup API.

#### Function details

##### `windows_sandbox_setup_start_emits_completion_notification`  (lines 21–64)

```
async fn windows_sandbox_setup_start_emits_completion_notification() -> Result<()>
```

**Purpose**: This test proves that a valid Windows sandbox setup request is accepted and followed by a completion notification. It is used to make sure clients can rely on the server to both start the setup and report when it is done.

**Data flow**: The test starts with no real user configuration, so it creates a temporary home directory and a mock server to stand in for external responses. It writes test configuration, starts a `TestAppServer`, and initializes it. Then it sends setup parameters saying to use unelevated mode and no current working directory. The server returns a response, which the test converts into a typed setup-start result and checks for `started: true`. After that, the test reads the message stream again until it finds the setup-completed notification, turns its JSON data into a typed notification, and checks that the mode is still unelevated. The visible output is a passing test if all of those steps happen as expected.

**Call relations**: During the test run, this function acts like a small client talking to the app server. It uses test-support helpers to create the mock response service, write configuration, launch the server, send the setup request, and decode the response. It then listens for the follow-up notification from the server, because the main behavior being tested is not just the immediate reply but the later completion message.

*Call graph*: calls 1 internal fn (new); 11 external calls (new, new, new, Integer, create_mock_responses_server_sequence_unchecked, to_response, write_mock_responses_config_toml, assert!, assert_eq!, from_value (+1 more)).


##### `windows_sandbox_setup_start_rejects_relative_cwd`  (lines 67–91)

```
async fn windows_sandbox_setup_start_rejects_relative_cwd() -> Result<()>
```

**Purpose**: This test checks that the server rejects a Windows sandbox setup request when `cwd`, the current working directory, is a relative path. That matters because sandbox setup should be given a clear, absolute filesystem location rather than a path whose meaning depends on hidden context.

**Data flow**: The test creates a temporary home directory, starts a test app server, and initializes it. It then sends a raw JSON request for `windowsSandbox/setupStart` with mode set to unelevated and `cwd` set to `relative-root`. Because that path is relative, the server should not accept the request. The test waits for an error message tied to the same request id, then checks that the error code is `-32600` and that the message says the request was invalid. The result is a passing test only if the server refuses the bad input in the expected JSON-RPC shape.

**Call relations**: This function uses the test app server as a real protocol endpoint but sends a raw request instead of the typed helper used in the happy-path test. That lets it deliberately send invalid data. It then reads the server’s error response and confirms the validation layer rejects the request before sandbox setup can proceed.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, assert!, assert_eq!, json!, timeout).


### Remote control integration
This suite focuses on the app server's remote-control enrollment, pairing, status, and managed-client workflows.

### `app-server/tests/suite/v2/remote_control.rs`

`test` · `test run`

Remote control lets another client, such as a phone or web session, connect to this app server through a backend service. These tests make sure that feature behaves safely. They check the default disabled state, enabling and disabling through JSON-RPC (a request-and-response message format), persisted user preferences, temporary "ephemeral" choices, pairing codes, and client management calls. A major theme is policy enforcement: if a managed requirements file says remote control is not allowed, every remote-control request must be rejected and startup must fail before opening a socket.

The file works like a small stage set. TestAppServer plays the real app server. Several local fake backends play the remote-control cloud service. They listen on a temporary TCP port, read simple HTTP requests, and return fixed JSON responses. This lets the tests prove not only what the app server returns to its client, but also what it sends over the network.

There are also helpers for reading responses, checking stored preferences in the state database, and temporarily changing environment variables. The fake backend tasks are aborted when their test helper is dropped, so each test cleans up its background server.

#### Function details

##### `EnvVarGuard::set`  (lines 69–75)

```
fn set(key: &'static str, value: &OsStr) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while remembering its old value. This prevents one test's environment change from leaking into later tests.

**Data flow**: It takes an environment variable name and a new value. It reads the current value, writes the new value into the process environment, and returns an EnvVarGuard containing the name and the saved old value.

**Call relations**: Tests call this before running code that reads environment variables, such as startup paths or configuration discovery. Later, Rust automatically calls EnvVarGuard::drop, which restores the environment.

*Call graph*: called by 26 (explicit_remote_control_startup_fails_when_disabled_by_requirements, remote_stdio_env_var_source_does_not_copy_local_env, stdio_server_propagates_explicit_local_env_var_source, stdio_server_propagates_whitelisted_env_vars, streamable_http_with_oauth_round_trip_impl, windows_elevated_enforces_deny_read_and_protects_setup_marker, windows_restricted_token_rejects_exact_and_glob_deny_read_policy, agent_identity_authapi_base_url_prefers_env_value, assert_agent_identity_plan_alias, auth_manager_rejects_env_personal_access_token_workspace_mismatch (+15 more)); 2 external calls (set_var, var_os).


##### `EnvVarGuard::drop`  (lines 79–86)

```
fn drop(&mut self)
```

**Purpose**: Restores the environment variable that EnvVarGuard::set temporarily changed. This is the cleanup step that keeps tests isolated.

**Data flow**: It reads the saved original value from the guard. If there was an old value, it writes it back; if there was none, it removes the variable entirely. It returns nothing but changes the process environment.

**Call relations**: This runs automatically when the guard goes out of scope. It completes the setup-and-cleanup pair started by EnvVarGuard::set.

*Call graph*: 2 external calls (remove_var, set_var).


##### `remote_control_preference`  (lines 89–98)

```
async fn remote_control_preference(
    state_db: &StateRuntime,
    websocket_url: &str,
) -> Result<Option<bool>>
```

**Purpose**: Looks up the stored remote-control on/off preference for the test account and client. Tests use it to prove whether an RPC changed the durable saved setting.

**Data flow**: It receives the state database and the backend websocket URL. It asks the database for the matching remote-control enrollment record, requires that the record exists, and returns the optional saved enabled value.

**Call relations**: Preference-focused tests call this after enable, disable, or ephemeral actions. It delegates the actual database lookup to the state runtime's remote-control enrollment query.

*Call graph*: 1 external calls (get_remote_control_enrollment).


##### `wait_for_response`  (lines 100–106)

```
async fn wait_for_response(mcp: &mut TestAppServer, request_id: i64) -> Result<JSONRPCResponse>
```

**Purpose**: Waits for a JSON-RPC success response with a specific request id, but only for a limited time. This keeps tests from hanging forever if the server never answers.

**Data flow**: It receives a mutable test server connection and a numeric request id. It waits until the test server reads a matching response message, wrapping that wait in a timeout, then returns the JSON-RPC response.

**Call relations**: Several tests use this after sending remote-control requests. It is a small shared shortcut around TestAppServer's response reader and Tokio's timeout tool.

*Call graph*: calls 1 internal fn (read_stream_until_response_message); called by 3 (disable_waits_for_in_flight_durable_enable, pairing_start_works_after_ephemeral_enable, rpc_updates_durable_preference_but_ephemeral_does_not); 2 external calls (Integer, timeout).


##### `assert_remote_control_disabled_by_requirements`  (lines 108–123)

```
async fn assert_remote_control_disabled_by_requirements(
    mcp: &mut TestAppServer,
    request_id: i64,
) -> Result<()>
```

**Purpose**: Checks that a remote-control request was rejected because managed requirements disabled the feature. It verifies both the error code and the human-readable error message.

**Data flow**: It receives a test server and request id. It waits for the matching JSON-RPC error response, extracts the error, and asserts that it is the expected invalid-request error with the managed-policy message.

**Call relations**: The policy rejection test calls this once for each remote-control RPC. It relies on the app server's error-message stream reader and the shared timeout.

*Call graph*: calls 1 internal fn (read_stream_until_error_message); called by 1 (managed_requirements_reject_all_remote_control_rpcs); 3 external calls (Integer, assert_eq!, timeout).


##### `managed_requirements_reject_all_remote_control_rpcs`  (lines 126–180)

```
async fn managed_requirements_reject_all_remote_control_rpcs() -> Result<()>
```

**Purpose**: Tests that when requirements.toml says remote control is not allowed, every remote-control JSON-RPC method is rejected. This protects managed installations from accidentally exposing a forbidden feature.

**Data flow**: It creates a temporary home directory, writes a requirements file that disables remote control, starts and initializes the test app server, observes a disabled status notification, sends every remote-control request type, and checks that each one receives the same policy error.

**Call relations**: This is a top-level async test. It uses TestAppServer for client-server messages and calls assert_remote_control_disabled_by_requirements for the repeated error checks.

*Call graph*: calls 2 internal fn (new, assert_remote_control_disabled_by_requirements); 5 external calls (new, assert_eq!, from_value, write, timeout).


##### `managed_requirements_allow_remote_control_true_does_not_enable_or_block_it`  (lines 183–202)

```
async fn managed_requirements_allow_remote_control_true_does_not_enable_or_block_it() -> Result<()>
```

**Purpose**: Tests that a requirements file explicitly allowing remote control does not turn it on by itself. It should merely avoid blocking the feature.

**Data flow**: It writes allow_remote_control = true, starts the app server, sends a status-read request, converts the JSON-RPC response into a typed status response, and asserts that the status is still Disabled.

**Call relations**: This top-level test uses TestAppServer for the RPC exchange and the shared response conversion helper to inspect the typed result.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert_eq!, write, timeout).


##### `explicit_remote_control_startup_fails_when_disabled_by_requirements`  (lines 206–249)

```
async fn explicit_remote_control_startup_fails_when_disabled_by_requirements() -> Result<()>
```

**Purpose**: Tests that startup fails if the process is explicitly told to start remote control while managed requirements forbid it. This checks the safety gate before the server opens its listening socket.

**Data flow**: It creates a disabled requirements file, prepares a Unix socket transport and startup options that request ephemeral remote control, sets CODEX_HOME temporarily, runs the real startup path, and asserts that it returns an InvalidInput error and leaves no socket file behind.

**Call relations**: This serial test calls EnvVarGuard::set to control CODEX_HOME and then calls the main app-server startup function. It verifies failure at startup rather than through TestAppServer RPCs.

*Call graph*: calls 3 internal fn (from_listen_url, set, with_managed_config_path_for_tests); 10 external calls (new, default, assert!, assert_eq!, run_main_with_transport_options, format!, current_exe, write, timeout, default).


##### `listen_off_honors_persisted_remote_control_enable`  (lines 252–276)

```
async fn listen_off_honors_persisted_remote_control_enable() -> Result<()>
```

**Purpose**: Tests that even when normal listening is turned off, a saved remote-control enabled preference can still cause the server to connect to remote control. This preserves the user's previous opt-in.

**Data flow**: It starts a fake remote-control listener, writes an enrollment record with remote_control_enabled set to true, starts the app server with --listen off, and waits for the fake listener to receive a connection.

**Call relations**: This test uses configured_remote_control_listener to create the fake backend and StateRuntime to seed the saved preference before starting TestAppServer with custom arguments.

*Call graph*: calls 3 internal fn (new_with_args, configured_remote_control_listener, init); 3 external calls (new, format!, timeout).


##### `listen_off_ignores_persisted_enable_when_disabled_by_requirements`  (lines 279–324)

```
async fn listen_off_ignores_persisted_enable_when_disabled_by_requirements() -> Result<()>
```

**Purpose**: Tests that managed policy wins over a saved enabled preference. A previous opt-in must not bypass a requirements file that disables remote control.

**Data flow**: It creates a fake backend, writes a requirements file forbidding remote control, stores an enabled enrollment record, starts the app server with --listen off, waits for it to exit unsuccessfully, verifies no backend connection arrives, and confirms the stored preference was not erased.

**Call relations**: This test combines configured_remote_control_listener, StateRuntime, and TestAppServer. It checks both external behavior, no connection, and durable state, preference remains stored.

*Call graph*: calls 3 internal fn (new_with_args, configured_remote_control_listener, init); 7 external calls (from_millis, new, assert!, assert_eq!, format!, write, timeout).


##### `listen_off_exits_without_persisted_remote_control_enable`  (lines 327–358)

```
async fn listen_off_exits_without_persisted_remote_control_enable() -> Result<()>
```

**Purpose**: Tests that --listen off exits when there is no saved remote-control enablement. Without a normal listener or an enabled remote-control connection, the server has nothing useful to run.

**Data flow**: It repeats the scenario for no saved preference and for a saved false preference. For each case it starts the app server with --listen off and asserts that the process exits unsuccessfully.

**Call relations**: This top-level test uses configured_remote_control_listener only to provide a possible backend URL for seeded state, then starts TestAppServer with custom arguments.

*Call graph*: calls 3 internal fn (new_with_args, configured_remote_control_listener, init); 4 external calls (new, assert!, format!, timeout).


##### `remote_control_disable_returns_disabled_status`  (lines 361–380)

```
async fn remote_control_disable_returns_disabled_status() -> Result<()>
```

**Purpose**: Tests that sending a disable request reports a Disabled status and includes basic server identity fields. This confirms the app server gives a complete answer even when turning the feature off.

**Data flow**: It prepares a fake remote-control configuration, starts and initializes the app server, sends a disable request, reads the matching JSON-RPC response, converts it to a typed disable response, and checks status, server name, environment id, and installation id.

**Call relations**: This test uses configured_remote_control_listener for backend configuration and TestAppServer for the JSON-RPC request-response cycle.

*Call graph*: calls 2 internal fn (new, configured_remote_control_listener); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `remote_control_status_read_returns_disabled_status`  (lines 383–401)

```
async fn remote_control_status_read_returns_disabled_status() -> Result<()>
```

**Purpose**: Tests the default status response before remote control is enabled. It confirms a fresh server says remote control is Disabled and still reports its server identity.

**Data flow**: It starts and initializes the app server, sends a status-read request, converts the response into a typed status object, and checks that status is Disabled with no environment id and non-empty identity fields.

**Call relations**: This is a straightforward TestAppServer RPC test. It does not need a fake backend because it only reads local status.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `remote_control_enable_returns_connecting_status`  (lines 404–434)

```
async fn remote_control_enable_returns_connecting_status() -> Result<()>
```

**Purpose**: Tests that enabling remote control waits for backend enrollment and then reports Connecting. This proves the server does not claim success before it has enrollment data.

**Data flow**: It starts a fake backend that deliberately pauses enrollment, starts the app server, sends enable, confirms the backend received the enroll HTTP request, verifies no response is sent while enrollment is blocked, releases the backend response, and checks the app server reports Connecting with the expected environment id.

**Call relations**: This test depends on BlockingRemoteControlBackend::start, wait_for_enroll_request, and complete_enrollment to control the timing of the backend response.

*Call graph*: calls 2 internal fn (new, start); 7 external calls (from_millis, new, Integer, to_response, assert!, assert_eq!, timeout).


##### `disable_waits_for_in_flight_durable_enable`  (lines 437–465)

```
async fn disable_waits_for_in_flight_durable_enable() -> Result<()>
```

**Purpose**: Tests that a disable request waits for an enable request already in progress. This prevents the saved preference from ending up in the wrong state because two requests overlapped.

**Data flow**: It starts a blocking fake backend and the app server, sends enable, waits until enrollment is in flight, sends disable, confirms disable does not answer yet, completes enrollment, then reads the disable response and checks the stored preference is false.

**Call relations**: This test uses BlockingRemoteControlBackend to freeze and release enrollment, wait_for_response to read the final answer, and remote_control_preference to inspect the database afterward.

*Call graph*: calls 4 internal fn (new, start, wait_for_response, init); 6 external calls (from_millis, new, Integer, to_response, assert_eq!, timeout).


##### `rpc_updates_durable_preference_but_ephemeral_does_not`  (lines 468–526)

```
async fn rpc_updates_durable_preference_but_ephemeral_does_not() -> Result<()>
```

**Purpose**: Tests the difference between durable remote-control choices and temporary, ephemeral choices. Normal enable and disable should update saved preference; ephemeral enable and disable should not.

**Data flow**: It starts a backend and state database, enables remote control and checks the stored preference becomes true, sends ephemeral disable and checks it stays true, sends durable disable and checks false, enables again and checks true, disables again and checks false, then sends ephemeral enable and checks it remains false.

**Call relations**: This test uses BlockingRemoteControlBackend for the first enrollment, wait_for_response for each RPC answer, and remote_control_preference after each step to verify durable state.

*Call graph*: calls 4 internal fn (new, start, wait_for_response, init); 3 external calls (new, assert_eq!, timeout).


##### `remote_control_status_read_returns_connecting_status_after_enable`  (lines 529–561)

```
async fn remote_control_status_read_returns_connecting_status_after_enable() -> Result<()>
```

**Purpose**: Tests that after a successful enable, reading status shows Connecting rather than Disabled. This confirms status reflects the active remote-control enrollment.

**Data flow**: It starts a blocking backend, enables remote control, waits for and completes enrollment, then sends a status-read request and checks that the typed response contains Connecting, the expected environment id, and identity fields.

**Call relations**: This test reuses BlockingRemoteControlBackend to control enrollment and TestAppServer to send the enable and status-read JSON-RPC messages.

*Call graph*: calls 2 internal fn (new, start); 6 external calls (new, Integer, to_response, assert!, assert_eq!, timeout).


##### `remote_control_pairing_start_returns_pairing_artifacts`  (lines 564–658)

```
async fn remote_control_pairing_start_returns_pairing_artifacts() -> Result<()>
```

**Purpose**: Tests that pairing produces the codes a user would need to link another device, and that pairing status can be checked by either code type. It also checks that an internal server id is not leaked in the public JSON-RPC result.

**Data flow**: It starts a pairing fake backend, enables remote control, waits for enrollment and a status notification with the environment id, sends a pairing-start request asking for a manual code, checks the returned pairing code, manual code, environment id, and expiry time, then sends two status requests and verifies both report claimed.

**Call relations**: This test uses PairingRemoteControlBackend to simulate the backend enrollment, pairing, and status endpoints. TestAppServer carries the client-facing JSON-RPC calls.

*Call graph*: calls 2 internal fn (new, start); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `pairing_start_works_after_ephemeral_enable`  (lines 661–696)

```
async fn pairing_start_works_after_ephemeral_enable() -> Result<()>
```

**Purpose**: Tests that pairing can start after a temporary remote-control enable. This proves pairing is tied to the current active connection, not only to a saved durable preference.

**Data flow**: It starts a pairing fake backend, starts the app server, sends an ephemeral enable and waits for the response, then sends pairing-start and checks that the returned pairing artifacts match the backend's fixed values.

**Call relations**: This test calls PairingRemoteControlBackend::start for the fake backend and wait_for_response for the ephemeral enable response before exercising pairing.

*Call graph*: calls 3 internal fn (new, start, wait_for_response); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `remote_control_client_management_works_while_disabled`  (lines 699–757)

```
async fn remote_control_client_management_works_while_disabled() -> Result<()>
```

**Purpose**: Tests that listing and revoking remote-control clients can work even when the server itself is not currently remote-control enabled. This lets users manage authorized devices without first opening a remote-control session.

**Data flow**: It starts a client-management fake backend, initializes the app server, sends a clients-list request with cursor, limit, and sort order, checks the returned client details and next cursor, sends a revoke request, checks the empty success response, then verifies the backend saw the expected GET and DELETE request lines.

**Call relations**: This test uses ClientManagementRemoteControlBackend::start to serve the list and revoke endpoints and wait_for_requests to inspect what the app server sent.

*Call graph*: calls 2 internal fn (new, start); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `ClientManagementRemoteControlBackend::start`  (lines 772–814)

```
async fn start(codex_home: &std::path::Path) -> Result<Self>
```

**Purpose**: Starts a fake backend server for client-listing and client-revoking tests. It returns fixed responses so the test can verify the app server translates backend data correctly.

**Data flow**: It receives a temporary Codex home path, creates a configured local listener, starts a background task, reads one list HTTP request and replies with one fake client plus a cursor, reads one revoke HTTP request and replies with 204 No Content, then sends both request lines back through a one-shot channel.

**Call relations**: remote_control_client_management_works_while_disabled calls this before sending client-management RPCs. Inside the spawned task it uses read_http_request, respond_with_json, and respond_with_status.

*Call graph*: calls 4 internal fn (configured_remote_control_listener, read_http_request, respond_with_json, respond_with_status); called by 1 (remote_control_client_management_works_while_disabled); 4 external calls (channel, json!, spawn, vec!).


##### `ClientManagementRemoteControlBackend::wait_for_requests`  (lines 816–821)

```
async fn wait_for_requests(&mut self) -> Result<Vec<String>>
```

**Purpose**: Waits for the fake client-management backend to finish receiving its expected requests. Tests use it to confirm the app server called the correct backend URLs.

**Data flow**: It takes the stored one-shot receiver, ensuring it can only be used once, waits for the background task to send its result, and returns the collected HTTP request lines.

**Call relations**: remote_control_client_management_works_while_disabled calls this after the list and revoke RPCs. It receives the request lines produced by the background task created in ClientManagementRemoteControlBackend::start.


##### `BlockingRemoteControlBackend::start`  (lines 825–872)

```
async fn start(codex_home: &std::path::Path) -> Result<Self>
```

**Purpose**: Starts a fake backend that accepts an enrollment request but does not answer until the test says so. This lets tests check waiting behavior and race conditions.

**Data flow**: It receives a Codex home path, configures the app server to use a local listener, records the websocket URL, creates one-shot channels, and spawns a task that reads the enrollment request, sends its request line to the test, waits for permission to continue, returns enrollment JSON, accepts the later websocket connection, and then stays alive.

**Call relations**: Enable and disable timing tests call this before starting TestAppServer. The spawned task uses read_enroll_request and respond_with_json, while the test controls it through wait_for_enroll_request and complete_enrollment.

*Call graph*: calls 3 internal fn (configured_remote_control_listener, read_enroll_request, respond_with_json); called by 4 (disable_waits_for_in_flight_durable_enable, remote_control_enable_returns_connecting_status, remote_control_status_read_returns_connecting_status_after_enable, rpc_updates_durable_preference_but_ephemeral_does_not); 4 external calls (format!, channel, json!, spawn).


##### `BlockingRemoteControlBackend::wait_for_enroll_request`  (lines 874–880)

```
async fn wait_for_enroll_request(&mut self) -> Result<String>
```

**Purpose**: Waits until the fake backend has received the app server's enrollment HTTP request. This proves the app server actually tried to enroll.

**Data flow**: It takes the stored receiver, ensuring only one wait is allowed, waits for the background task to send the request line, and returns that line as text.

**Call relations**: Tests call this after sending enable. It receives the request line sent by the background task created in BlockingRemoteControlBackend::start.


##### `BlockingRemoteControlBackend::complete_enrollment`  (lines 882–888)

```
fn complete_enrollment(&mut self) -> Result<()>
```

**Purpose**: Allows the blocking fake backend to finish enrollment. Tests use it as a switch to release an app server request that should be waiting.

**Data flow**: It takes the stored sender, ensuring enrollment can only be completed once, sends an empty signal to the background task, and reports an error if that task is no longer listening.

**Call relations**: Timing tests call this after verifying that an enable or disable response is waiting. The signal lets the task in BlockingRemoteControlBackend::start send the enrollment JSON response.


##### `BlockingRemoteControlBackend::websocket_url`  (lines 890–892)

```
fn websocket_url(&self) -> &str
```

**Purpose**: Returns the websocket URL associated with the fake backend. Tests use it to look up the matching saved enrollment record.

**Data flow**: It reads the websocket_url string stored in the backend helper and returns it as borrowed text. It does not change any state.

**Call relations**: Preference tests call this after starting the blocking backend, then pass the URL to remote_control_preference to query the state database.


##### `PairingRemoteControlBackend::start`  (lines 901–975)

```
async fn start(codex_home: &std::path::Path) -> Result<Self>
```

**Purpose**: Starts a fake backend for enrollment, pairing, and pairing-status checks. It gives deterministic pairing codes so tests can compare exact results.

**Data flow**: It receives a Codex home path, configures a local listener, creates a one-shot channel, and spawns a task. The task reads enrollment and replies with fixed enrollment JSON, then reads the pairing request and replies with fixed pairing code data, then reads two pairing-status requests, checks their bodies, replies that each is claimed, and stays alive.

**Call relations**: Pairing tests call this before starting TestAppServer. The task relies on read_http_request and respond_with_json, and it reports the first enrollment request through wait_for_enroll_request.

*Call graph*: calls 3 internal fn (configured_remote_control_listener, read_http_request, respond_with_json); called by 2 (pairing_start_works_after_ephemeral_enable, remote_control_pairing_start_returns_pairing_artifacts); 5 external calls (anyhow!, assert_eq!, channel, json!, spawn).


##### `PairingRemoteControlBackend::wait_for_enroll_request`  (lines 977–982)

```
async fn wait_for_enroll_request(&mut self) -> Result<String>
```

**Purpose**: Waits for the pairing fake backend to observe the enrollment request. This helps tests confirm the app server reached the backend before pairing is asserted.

**Data flow**: It takes the stored receiver, waits for the spawned backend task to send the enrollment request line or an error, and returns the request line.

**Call relations**: remote_control_pairing_start_returns_pairing_artifacts uses this after enabling remote control. The value comes from the task started by PairingRemoteControlBackend::start.


##### `PairingRemoteControlBackend::drop`  (lines 986–988)

```
fn drop(&mut self)
```

**Purpose**: Stops the pairing fake backend's background task when the helper is no longer needed. This prevents leftover test servers from running after a test ends.

**Data flow**: It reads the stored task handle and aborts that asynchronous task. It returns nothing and performs cleanup as a side effect.

**Call relations**: Rust calls this automatically when a PairingRemoteControlBackend value goes out of scope at the end of a test.

*Call graph*: 1 external calls (abort).


##### `BlockingRemoteControlBackend::drop`  (lines 992–994)

```
fn drop(&mut self)
```

**Purpose**: Stops the blocking fake backend's background task during cleanup. This is important because that task intentionally waits forever after accepting the websocket.

**Data flow**: It reads the stored task handle and aborts the task. It returns nothing and only affects the background server task.

**Call relations**: Rust calls this automatically when a BlockingRemoteControlBackend helper is dropped by tests that used it.

*Call graph*: 1 external calls (abort).


##### `ClientManagementRemoteControlBackend::drop`  (lines 998–1000)

```
fn drop(&mut self)
```

**Purpose**: Stops the client-management fake backend's background task when the test helper is dropped. This keeps the test run from leaving stray asynchronous work behind.

**Data flow**: It reads the stored task handle and aborts it. It returns nothing and performs cleanup.

**Call relations**: Rust invokes this automatically at the end of remote_control_client_management_works_while_disabled or on early failure.

*Call graph*: 1 external calls (abort).


##### `configured_remote_control_listener`  (lines 1009–1025)

```
async fn configured_remote_control_listener(codex_home: &std::path::Path) -> Result<TcpListener>
```

**Purpose**: Creates a local fake backend listener and writes the test configuration needed for the app server to use it. It also writes fake ChatGPT authentication so remote-control calls have an account to use.

**Data flow**: It receives the temporary Codex home path, binds a TCP listener on localhost using an available port, builds a backend base URL from that port, writes mock response configuration pointing to that URL, writes file-based auth credentials for account_id, and returns the listener.

**Call relations**: All fake backend start functions call this, and some tests call it directly. It prepares the common network and configuration setup before the app server starts.

*Call graph*: calls 1 internal fn (new); called by 7 (start, start, start, listen_off_exits_without_persisted_remote_control_enable, listen_off_honors_persisted_remote_control_enable, listen_off_ignores_persisted_enable_when_disabled_by_requirements, remote_control_disable_returns_disabled_status); 4 external calls (bind, write_chatgpt_auth, write_mock_responses_config_toml_with_chatgpt_base_url, format!).


##### `read_enroll_request`  (lines 1027–1030)

```
async fn read_enroll_request(listener: &TcpListener) -> Result<(String, BufReader<TcpStream>)>
```

**Purpose**: Reads one HTTP request from the fake backend listener and returns just the request line plus the stream reader. It is a small enrollment-specific wrapper.

**Data flow**: It receives a TCP listener, calls read_http_request, then extracts the request line and reader from the parsed request. The body is discarded because these enrollment tests only need the request line and stream.

**Call relations**: BlockingRemoteControlBackend::start calls this in its background task before sending an enrollment response.

*Call graph*: calls 1 internal fn (read_http_request); called by 1 (start).


##### `read_http_request`  (lines 1032–1063)

```
async fn read_http_request(listener: &TcpListener) -> Result<HttpRequest>
```

**Purpose**: Reads a simple HTTP request sent to a fake backend. It gives tests the request line, body, and still-open stream so they can inspect the request and reply.

**Data flow**: It accepts one TCP connection, wraps it in a buffered reader, reads the first request line, reads headers until the blank line, looks for Content-Length, reads that many body bytes if present, converts the body to text, and returns an HttpRequest object.

**Call relations**: The fake backend tasks use this whenever they need to receive an HTTP call from the app server. read_enroll_request is a small wrapper around it.

*Call graph*: called by 3 (start, start, read_enroll_request); 5 external calls (new, from_utf8, new, accept, vec!).


##### `respond_with_json`  (lines 1065–1078)

```
async fn respond_with_json(stream: TcpStream, body: serde_json::Value) -> Result<()>
```

**Purpose**: Writes a basic HTTP 200 OK response with a JSON body to a fake backend connection. Tests use it to imitate successful backend API responses.

**Data flow**: It receives a TCP stream and a JSON value, turns the JSON into text, writes HTTP headers including content type and content length, writes the body, and finishes with no returned data beyond success or error.

**Call relations**: All fake backend start tasks call this after reading requests. It is the shared way the local fake backend answers enrollment, pairing, status, and client-list requests.

*Call graph*: called by 3 (start, start, start); 3 external calls (write_all, to_string, format!).


##### `respond_with_status`  (lines 1080–1091)

```
async fn respond_with_status(mut stream: TcpStream, status: &str, body: &str) -> Result<()>
```

**Purpose**: Writes a basic HTTP response with a chosen status line and plain-text body. It is used when the fake backend needs something other than JSON, such as 204 No Content.

**Data flow**: It receives a TCP stream, an HTTP status string, and a body string. It writes headers with text/plain content type and the correct body length, followed by the body, then returns success or an I/O error.

**Call relations**: ClientManagementRemoteControlBackend::start calls this to answer the revoke request with a no-content success response.

*Call graph*: called by 1 (start); 2 external calls (write_all, format!).
