# Interactive and persisted login flows  `stage-5.1`

This stage is the system’s sign-in and sign-out machinery. It is used during setup, onboarding, and later whenever the user checks status or changes accounts. The command-line entry point runs login, logout, and status commands, while the app server’s account processor answers account requests from the interface, such as auth state, limits, token use, and warning emails.

There are two main ways to sign in. The browser flow starts a tiny local web server, waits for the browser to return a temporary code, trades it for tokens, then saves them. The device-code flow shows a short code in the terminal, asks the user to enter it in a browser, and waits for approval; the terminal onboarding screen presents this same flow and ignores stale replies from old attempts. MCP server logins use a similar browser OAuth flow.

Behind the scenes, the login modules expose the right building blocks and shared error types. Storage code decides whether credentials go in an auth file, the operating-system keyring, encrypted local storage, or memory. Logout tries to revoke remote tokens, then removes local secrets.

## Files in this stage

### CLI and account entrypoints
These files expose login, logout, and auth-status flows to users through the CLI and app-server account APIs.

### `cli/src/login.rs`

`orchestration` · `login/logout command handling`

This file is the command-line front door for signing in and out of Codex. Its job is to make several ways of proving identity feel like one simple experience: browser-based ChatGPT login, device-code login for headless machines, API key login, access-token login, status checks, and logout. Without it, the lower-level login library could still save tokens, but the CLI would not know how to read configuration, enforce allowed login methods, print useful instructions, clean up old credentials first, or exit with the right success or failure code.

The flow usually starts by loading configuration and command-line overrides. Then the chosen login command checks whether that login style is allowed. For ChatGPT-style login, it first removes any existing credentials so old and new identities do not get mixed. Browser login starts a tiny local web server and tells the user which URL to open. Device-code login prints a code-based flow that works without a browser. API key and access-token login read or receive a secret and store it directly.

The file also installs a narrow file logger for login commands only. Think of it like putting a small black box recorder next to the login process: normal user messages still go to the terminal, but support can later inspect `codex-login.log` if sign-in fails. The status command reports what kind of credential is stored, carefully masking API keys so secrets are not printed.

#### Function details

##### `init_login_file_logging`  (lines 51–110)

```
fn init_login_file_logging(config: &Config) -> Option<WorkerGuard>
```

**Purpose**: Sets up a small login-only log file so failures during direct `codex login` can be diagnosed later. It deliberately avoids the larger interactive logging system used by the TUI, because this command is a short one-shot action.

**Data flow**: It receives the loaded configuration, uses it to find the log directory, creates that directory if needed, opens `codex-login.log`, and attaches a tracing layer that writes login-related messages there. If any step fails, it prints a warning and returns nothing; if it succeeds, it returns a guard object that keeps background log writing alive while the command runs.

**Call relations**: The main login flows call this immediately after loading configuration and before doing real login work. It relies on configuration helpers to find the log folder and on tracing setup helpers to write logs without slowing the command down.

*Call graph*: calls 1 internal fn (log_dir); called by 5 (run_login_with_access_token, run_login_with_api_key, run_login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser); 7 external calls (try_from_default_env, new, eprintln!, create_dir_all, non_blocking, layer, registry).


##### `print_login_server_start`  (lines 112–116)

```
fn print_login_server_start(actual_port: u16, auth_url: &str)
```

**Purpose**: Prints the browser-login instructions a user needs after the local login server starts. It tells them the local address, the authentication URL, and what to do on a remote or headless machine.

**Data flow**: It receives the actual local port and the authentication URL, formats them into a clear message, and writes that message to standard error for the user to see. It does not return a value or change saved state.

**Call relations**: Browser-based login calls this after the login server is running. The fallback flow also calls it when device-code login is unavailable and the command switches to browser login instead.

*Call graph*: called by 2 (login_with_chatgpt, run_login_with_device_code_fallback_to_browser); 1 external calls (eprintln!).


##### `clear_existing_auth_before_login`  (lines 118–132)

```
async fn clear_existing_auth_before_login(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    auth_keyring_backend_kind: AuthKeyringBackendKind,
)
```

**Purpose**: Removes any existing saved login before starting a new ChatGPT-style login. This avoids leaving stale credentials behind or mixing one account's data with another.

**Data flow**: It receives the Codex home directory and the configured credential storage choices, then asks the login library to log out and revoke old credentials if possible. If cleanup fails, it records a warning but does not stop the new login attempt.

**Call relations**: ChatGPT browser login and device-code login call this before beginning authentication. The test with the same name also calls it to verify that existing saved credentials really disappear.

*Call graph*: called by 4 (login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser, clears_existing_auth_before_login); 2 external calls (logout_with_revoke, warn!).


##### `login_with_chatgpt`  (lines 134–159)

```
async fn login_with_chatgpt(
    codex_home: PathBuf,
    forced_chatgpt_workspace_id: Option<Vec<String>>,
    cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
    auth_keyring_backend_kind
```

**Purpose**: Runs the browser-based ChatGPT login flow. It clears old credentials, starts a local callback server, prints instructions, and waits until authentication finishes.

**Data flow**: It receives the Codex home path, optional forced workspace information, and credential storage settings. It builds server options, starts the login server, shows the user where to authenticate, then waits for the server to finish and returns success or an I/O error.

**Call relations**: The top-level `run_login_with_chatgpt` command calls this after configuration and policy checks. Inside, it calls the cleanup helper first, then hands the actual OAuth-style browser work to the login server from the login library.

*Call graph*: calls 3 internal fn (clear_existing_auth_before_login, print_login_server_start, new); called by 1 (run_login_with_chatgpt); 1 external calls (run_login_server).


##### `run_login_with_chatgpt`  (lines 161–190)

```
async fn run_login_with_chatgpt(cli_config_overrides: CliConfigOverrides) -> !
```

**Purpose**: Acts as the command-level wrapper for `codex login` using ChatGPT in a browser. It loads settings, enforces any configured login restrictions, runs the login, prints the result, and exits the process.

**Data flow**: It receives command-line configuration overrides, turns them into a full configuration, starts login file logging, and checks whether ChatGPT login is disabled by policy. If allowed, it passes the needed paths and storage settings into `login_with_chatgpt`; success exits with code 0, and failure prints an error and exits with code 1.

**Call relations**: The CLI main command router calls this for the browser ChatGPT login path. It coordinates smaller helpers: configuration loading, logging setup, the browser login flow, and final process exit.

*Call graph*: calls 3 internal fn (init_login_file_logging, load_config_or_exit, login_with_chatgpt); called by 1 (cli_main); 4 external calls (eprintln!, matches!, exit, info!).


##### `run_login_with_api_key`  (lines 192–220)

```
async fn run_login_with_api_key(
    cli_config_overrides: CliConfigOverrides,
    api_key: String,
) -> !
```

**Purpose**: Runs login by saving an API key. This is the direct secret-based path for users or scripts that already have a key and do not need a browser.

**Data flow**: It receives command-line overrides and an API key string. It loads configuration, starts login file logging, checks whether API-key login is forbidden, then asks the login library to store the key using the configured storage method. It prints success or an error and exits with the matching status code.

**Call relations**: The CLI main command router calls this when the user chooses API-key login. It delegates actual credential saving to the login library, while this wrapper handles policy checks and user-facing messages.

*Call graph*: calls 2 internal fn (init_login_file_logging, load_config_or_exit); called by 1 (cli_main); 5 external calls (login_with_api_key, eprintln!, matches!, exit, info!).


##### `run_login_with_access_token`  (lines 222–254)

```
async fn run_login_with_access_token(
    cli_config_overrides: CliConfigOverrides,
    access_token: String,
) -> !
```

**Purpose**: Runs login by saving an access token. This supports a token-based identity path separate from API-key login.

**Data flow**: It receives command-line overrides and an access token string. It loads configuration, starts login file logging, checks whether access-token login is disabled by the forced login method, and passes the token plus workspace and base-URL settings to the login library. It exits successfully if storage works, or prints an error and exits unsuccessfully.

**Call relations**: The CLI main command router calls this when an access token is provided. It does not store the token itself; it prepares the right context and hands the sensitive work to `login_with_access_token` in the login library.

*Call graph*: calls 2 internal fn (init_login_file_logging, load_config_or_exit); called by 1 (cli_main); 5 external calls (login_with_access_token, eprintln!, matches!, exit, info!).


##### `read_api_key_from_stdin`  (lines 256–262)

```
fn read_api_key_from_stdin() -> String
```

**Purpose**: Reads an API key from standard input for scripted login. This keeps secrets out of command-line arguments, where they can be exposed in shell history or process listings.

**Data flow**: It supplies API-key-specific messages to the shared secret-reading helper. The helper either returns the trimmed key text or exits with a clear error if input is missing or invalid.

**Call relations**: The CLI main command router calls this when the user selects the `--with-api-key` style input. It relies entirely on `read_stdin_secret` for the actual reading and validation.

*Call graph*: calls 1 internal fn (read_stdin_secret); called by 1 (cli_main).


##### `read_access_token_from_stdin`  (lines 264–270)

```
fn read_access_token_from_stdin() -> String
```

**Purpose**: Reads an access token from standard input for scripted login. Like API-key reading, this avoids putting the secret directly in the command line.

**Data flow**: It provides access-token-specific prompts and error messages to the shared secret-reading helper. The result is the trimmed token string, unless the helper exits because input was interactive, unreadable, or empty.

**Call relations**: The CLI main command router calls this when access-token login expects the token on standard input. It shares the same safety checks as API-key reading through `read_stdin_secret`.

*Call graph*: calls 1 internal fn (read_stdin_secret); called by 1 (cli_main).


##### `read_stdin_secret`  (lines 272–295)

```
fn read_stdin_secret(terminal_message: &str, reading_message: &str, empty_message: &str) -> String
```

**Purpose**: Safely reads a secret from piped standard input and refuses to prompt interactively. This prevents the program from hanging while waiting for a user to type a secret in the wrong mode.

**Data flow**: It receives three user-facing messages: one for accidental terminal use, one while reading, and one for empty input. It checks whether standard input is a terminal; if so, it explains how to pipe the secret and exits. Otherwise it reads all input, trims whitespace, rejects an empty result, and returns the secret string.

**Call relations**: Both API-key and access-token stdin readers call this. It is the shared gatekeeper that turns piped text into a usable secret before the top-level login command stores it.

*Call graph*: called by 2 (read_access_token_from_stdin, read_api_key_from_stdin); 4 external calls (new, eprintln!, stdin, exit).


##### `run_login_with_device_code`  (lines 298–337)

```
async fn run_login_with_device_code(
    cli_config_overrides: CliConfigOverrides,
    issuer_base_url: Option<String>,
    client_id: Option<String>,
) -> !
```

**Purpose**: Runs the OAuth device-code login flow, which is useful when the machine running Codex cannot open a browser. The user authenticates elsewhere using a code.

**Data flow**: It receives command-line overrides plus optional issuer and client ID values. It loads configuration, starts login file logging, checks whether ChatGPT-style login is disabled, clears existing credentials, builds login options, applies optional issuer/client settings, and runs device-code authentication. It prints success or an error and exits.

**Call relations**: The CLI main command router calls this for explicit device-code login. It prepares the environment, then hands the authentication exchange to `run_device_code_login` in the login library.

*Call graph*: calls 4 internal fn (clear_existing_auth_before_login, init_login_file_logging, load_config_or_exit, new); called by 1 (cli_main); 5 external calls (run_device_code_login, eprintln!, matches!, exit, info!).


##### `run_login_with_device_code_fallback_to_browser`  (lines 343–408)

```
async fn run_login_with_device_code_fallback_to_browser(
    cli_config_overrides: CliConfigOverrides,
    issuer_base_url: Option<String>,
    client_id: Option<String>,
) -> !
```

**Purpose**: Tries device-code login first, but falls back to browser login if the server says device-code login is not available. This keeps login working across environments where the feature may be disabled.

**Data flow**: It receives command-line overrides plus optional issuer and client ID values. It loads configuration, starts login logging, checks policy, clears old credentials, builds login options, and sets browser opening to false for the device-code attempt. If device-code login succeeds, it exits successfully. If the error means device-code is unsupported, it starts the local browser login server instead; other errors are reported as failures.

**Call relations**: This is a command-level login flow that coordinates both available ChatGPT-style paths. It first calls the device-code login library function, and only if that specific path is unavailable does it call the browser login server and print browser instructions.

*Call graph*: calls 5 internal fn (clear_existing_auth_before_login, init_login_file_logging, load_config_or_exit, print_login_server_start, new); 6 external calls (run_device_code_login, run_login_server, eprintln!, matches!, exit, info!).


##### `run_login_status`  (lines 410–458)

```
async fn run_login_status(cli_config_overrides: CliConfigOverrides) -> !
```

**Purpose**: Reports whether the user is currently logged in and what kind of credential is stored. It helps users and scripts check whether authentication is ready before doing other work.

**Data flow**: It receives command-line overrides, loads configuration, then asks the authentication storage layer to load saved credentials. If credentials exist, it inspects their authentication mode and prints a human-readable status; API keys are masked before printing. No credentials or errors lead to explanatory messages and non-success exits where appropriate.

**Call relations**: The CLI main command router calls this for the login status command. It depends on `CodexAuth::from_auth_storage` to read saved login data and uses `safe_format_key` when it must display part of an API key.

*Call graph*: calls 2 internal fn (load_config_or_exit, from_auth_storage); called by 1 (cli_main); 2 external calls (eprintln!, exit).


##### `run_logout`  (lines 460–483)

```
async fn run_logout(cli_config_overrides: CliConfigOverrides) -> !
```

**Purpose**: Logs the user out by removing saved credentials and revoking them when supported. It gives a clear result whether the user was logged in or not.

**Data flow**: It receives command-line overrides, loads configuration, then calls the login library's logout-and-revoke operation with the configured storage settings. A true result prints successful logout, a false result prints that there was no login to remove, and an error exits with failure.

**Call relations**: The CLI main command router calls this for the logout command. It uses the shared configuration loader first, then delegates the actual credential removal to the login library.

*Call graph*: calls 1 internal fn (load_config_or_exit); called by 1 (cli_main); 3 external calls (logout_with_revoke, eprintln!, exit).


##### `load_config_or_exit`  (lines 485–501)

```
async fn load_config_or_exit(cli_config_overrides: CliConfigOverrides) -> Config
```

**Purpose**: Loads Codex configuration for these commands, including command-line `-c` overrides, and stops the process with a clear message if configuration cannot be read. This gives all login commands one consistent setup path.

**Data flow**: It receives raw CLI override data, parses those overrides, then asks the configuration system to load the full configuration with those values applied. On success it returns the configuration object; on parse or load failure it prints the problem and exits with code 1.

**Call relations**: All top-level login, logout, and status flows call this before doing their real work. It is the shared doorway from command-line inputs into usable runtime settings.

*Call graph*: calls 1 internal fn (parse_overrides); called by 7 (run_login_status, run_login_with_access_token, run_login_with_api_key, run_login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser, run_logout); 3 external calls (load_with_cli_overrides, eprintln!, exit).


##### `safe_format_key`  (lines 503–510)

```
fn safe_format_key(key: &str) -> String
```

**Purpose**: Formats an API key for display without revealing the full secret. It lets the status command confirm which kind of credential is present while reducing the chance of leaking sensitive data.

**Data flow**: It receives a key string. If the key is short, it returns only `***`; otherwise it keeps the first eight and last five characters and replaces the middle with `***`.

**Call relations**: The login status flow uses this when reporting API-key login. The unit tests check both long and short key behavior so the masking rule stays stable.

*Call graph*: 1 external calls (format!).


##### `tests::clears_existing_auth_before_login`  (lines 525–549)

```
async fn clears_existing_auth_before_login()
```

**Purpose**: Tests that the cleanup helper really removes an existing saved login before a new login starts. This protects the safety behavior that prevents stale credentials from lingering.

**Data flow**: It creates a temporary Codex home, saves a fake API key there, calls `clear_existing_auth_before_login`, then reloads the auth file and expects to find no saved credentials. The temporary directory keeps the test isolated from any real user data.

**Call relations**: This test exercises the same cleanup function used by browser and device-code login flows. It also uses the login library's save and load helpers to verify the before-and-after state.

*Call graph*: calls 2 internal fn (clear_existing_auth_before_login, default); 4 external calls (assert_eq!, load_auth_dot_json, login_with_api_key, tempdir).


##### `tests::formats_long_key`  (lines 552–555)

```
fn formats_long_key()
```

**Purpose**: Tests that long API keys are masked while still showing a small prefix and suffix. This ensures status output remains useful without exposing the whole secret.

**Data flow**: It gives `safe_format_key` a sample long key and checks that the returned string keeps the expected beginning and ending with stars in the middle.

**Call relations**: This test supports the status-reporting path, where `safe_format_key` is used before printing an API key to the terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::short_key_returns_stars`  (lines 558–561)

```
fn short_key_returns_stars()
```

**Purpose**: Tests that short API keys are completely hidden. Short secrets do not have enough safe visible characters, so the function should print only stars.

**Data flow**: It passes a short sample key into `safe_format_key` and checks that the result is exactly `***`.

**Call relations**: This test covers the conservative branch of the masking helper used by login status output.

*Call graph*: 1 external calls (assert_eq!).


### `app-server/src/request_processors/account_processor.rs`

`orchestration` · `request handling`

This file exists so the rest of the server has one clear place for account work. Without it, login and logout would be scattered across the server, and important follow-up steps could be missed, such as refreshing plugin caches or telling the client that the account changed.

The main type is AccountRequestProcessor. Think of it like a receptionist for account requests. A client asks to log in, log out, check auth status, or fetch usage information. The processor validates the request, calls the authentication system, sends a JSON-RPC response back to the client, and sometimes sends extra notifications afterward.

It supports several login styles: API key login, browser-based ChatGPT login, device-code login, and externally supplied ChatGPT tokens. It also keeps track of one active login attempt at a time. Starting a new login cancels the old one, and dropping the ActiveLogin value automatically stops the browser server or device-code wait.

After account changes, it reloads authentication, updates cloud configuration, refreshes plugin and skill caches, and notifies the client. This is important because available plugins, model access, and workspace settings can depend on who is logged in. The file also includes guarded backend calls for rate limits, token usage, and add-credits nudges, making sure the user is properly authenticated before asking the Codex backend for account data.

#### Function details

##### `ActiveLogin::login_id`  (lines 24–30)

```
fn login_id(&self) -> Uuid
```

**Purpose**: Returns the unique ID for the current login attempt. This lets the server tell whether a cancel or completion message belongs to the login attempt that is still active.

**Data flow**: It reads an ActiveLogin value, whether browser-based or device-code-based, takes the stored UUID from it, and returns that UUID without changing anything.

**Call relations**: Other account-login code uses this when checking whether the active login is still the same one. That matters because a user can start a new login while an older login task is still finishing in the background.


##### `ActiveLogin::cancel`  (lines 32–39)

```
fn cancel(&self)
```

**Purpose**: Stops an in-progress login attempt. For browser login it shuts down the temporary login server; for device-code login it signals the waiting task to stop.

**Data flow**: It receives the stored ActiveLogin state, looks at which kind of login it is, and sends the matching stop signal. It does not return a value; its effect is to ask the ongoing login work to end.

**Call relations**: ActiveLogin::drop calls this automatically. That means account code can cancel a login simply by removing the stored ActiveLogin value.

*Call graph*: called by 1 (drop).


##### `ActiveLogin::drop`  (lines 54–56)

```
fn drop(&mut self)
```

**Purpose**: Automatically cancels a login attempt when the ActiveLogin object is discarded. This prevents abandoned browser servers or device-code polling tasks from continuing in the background.

**Data flow**: When Rust is about to destroy the ActiveLogin value, this function calls ActiveLogin::cancel. Nothing is returned; the important result is the cleanup side effect.

**Call relations**: The account processor often removes an active login from its shared slot. When that removed value is dropped, this function runs and delegates to ActiveLogin::cancel.

*Call graph*: calls 1 internal fn (cancel).


##### `AccountRequestProcessor::new`  (lines 70–85)

```
fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        config: Arc<Config>,
        config_manager: ConfigMan
```

**Purpose**: Builds a new account request processor with all the services it needs. It stores authentication, thread, outgoing-message, config, and config-manager references, plus an empty slot for any active login.

**Data flow**: It takes shared service objects as input, wraps an empty active-login slot in a mutex, and returns an AccountRequestProcessor ready to answer account requests.

**Call relations**: Server setup code creates this processor so initialized client requests can later call its account methods. The constructed processor becomes the central account-request handler.

*Call graph*: called by 1 (new); 2 external calls (new, new).


##### `AccountRequestProcessor::login_account`  (lines 87–93)

```
async fn login_account(
        &self,
        request_id: ConnectionRequestId,
        params: LoginAccountParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for account login. It accepts the client’s login request and forwards it to the newer login implementation.

**Data flow**: It receives a request ID and login parameters, calls AccountRequestProcessor::login_v2, and converts the successful result into the response shape expected by the request dispatcher.

**Call relations**: handle_initialized_client_request calls this when the client asks to start login. This function hands the real work to AccountRequestProcessor::login_v2.

*Call graph*: calls 1 internal fn (login_v2); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::logout_account`  (lines 95–100)

```
async fn logout_account(
        &self,
        request_id: ConnectionRequestId,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for account logout. It starts the logout process and adapts the result for the client-response format.

**Data flow**: It receives a request ID, calls AccountRequestProcessor::logout_v2, and returns no direct payload on success because logout_v2 sends the response itself.

**Call relations**: handle_initialized_client_request calls this for logout requests. It delegates to AccountRequestProcessor::logout_v2, which performs logout and sends notifications.

*Call graph*: calls 1 internal fn (logout_v2); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::cancel_login_account`  (lines 102–109)

```
async fn cancel_login_account(
        &self,
        params: CancelLoginAccountParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for canceling an active login attempt. It lets the client stop a browser or device-code login that was previously started.

**Data flow**: It receives cancel parameters containing a login ID, calls AccountRequestProcessor::cancel_login_response, and wraps the status response for the client.

**Call relations**: handle_initialized_client_request calls this when the client asks to cancel login. The actual ID parsing and cancellation decision happen in AccountRequestProcessor::cancel_login_response.

*Call graph*: calls 1 internal fn (cancel_login_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_account`  (lines 111–118)

```
async fn get_account(
        &self,
        params: GetAccountParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for reading the current account information. It returns account details when available and says whether OpenAI/Codex authentication is required.

**Data flow**: It receives account-query parameters, calls AccountRequestProcessor::get_account_response, and wraps the resulting account response for transport back to the client.

**Call relations**: handle_initialized_client_request calls this for account queries. It delegates to AccountRequestProcessor::get_account_response for the actual lookup.

*Call graph*: calls 1 internal fn (get_account_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_auth_status`  (lines 120–127)

```
async fn get_auth_status(
        &self,
        params: GetAuthStatusParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for checking authentication status. It can optionally refresh the token and optionally include a token in the response.

**Data flow**: It receives auth-status parameters, calls AccountRequestProcessor::get_auth_status_response, and wraps the result for the client.

**Call relations**: handle_initialized_client_request calls this when the client wants to know whether it is logged in. The detailed decision-making happens in AccountRequestProcessor::get_auth_status_response.

*Call graph*: calls 1 internal fn (get_auth_status_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_account_rate_limits`  (lines 129–135)

```
async fn get_account_rate_limits(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for fetching the user’s Codex rate limits. Rate limits are backend-enforced usage caps.

**Data flow**: It takes no request parameters, calls AccountRequestProcessor::get_account_rate_limits_response, and wraps the returned rate-limit data for the client.

**Call relations**: handle_initialized_client_request calls this for rate-limit requests. The backend call and authentication checks are done by AccountRequestProcessor::get_account_rate_limits_response.

*Call graph*: calls 1 internal fn (get_account_rate_limits_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_account_token_usage`  (lines 137–143)

```
async fn get_account_token_usage(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for fetching account token-usage statistics. Tokens are the chunks of text counted by the model service for usage tracking.

**Data flow**: It takes no request parameters, calls AccountRequestProcessor::get_account_token_usage_response, and wraps the usage summary for the client.

**Call relations**: handle_initialized_client_request calls this when the client wants token usage. The backend fetch and response conversion happen in AccountRequestProcessor::get_account_token_usage_response.

*Call graph*: calls 1 internal fn (get_account_token_usage_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::send_add_credits_nudge_email`  (lines 145–152)

```
async fn send_add_credits_nudge_email(
        &self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Public request entry for asking the backend to email a workspace owner about adding credits or raising a usage limit.

**Data flow**: It receives the requested nudge type, calls AccountRequestProcessor::send_add_credits_nudge_email_response, and wraps the status for the client.

**Call relations**: handle_initialized_client_request calls this for add-credits nudge requests. The auth checks and backend call are handled by AccountRequestProcessor::send_add_credits_nudge_email_response.

*Call graph*: calls 1 internal fn (send_add_credits_nudge_email_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::cancel_active_login`  (lines 154–159)

```
async fn cancel_active_login(&self)
```

**Purpose**: Cancels whatever login attempt is currently active, without needing a login ID. This is useful during broader shutdown or cleanup flows.

**Data flow**: It locks the shared active-login slot, removes any stored ActiveLogin, and lets that removed value be dropped. Dropping it triggers cancellation.

**Call relations**: A higher-level cancel_active_login flow calls this when the server needs to stop login work. It relies on ActiveLogin’s drop behavior to perform the actual shutdown.

*Call graph*: called by 1 (cancel_active_login).


##### `AccountRequestProcessor::clear_external_auth`  (lines 161–166)

```
fn clear_external_auth(&self)
```

**Purpose**: Clears externally supplied ChatGPT authentication and updates plugins to use the new auth mode. This is needed when runtime references are being cleared.

**Data flow**: It tells the auth manager to remove external auth, then reads the current API auth mode and gives that mode to the plugins manager.

**Call relations**: clear_runtime_references calls this during cleanup. It connects auth cleanup with plugin state so plugins do not keep assuming the old account is active.

*Call graph*: called by 1 (clear_runtime_references).


##### `AccountRequestProcessor::current_account_updated_notification`  (lines 168–174)

```
fn current_account_updated_notification(&self) -> AccountUpdatedNotification
```

**Purpose**: Builds the notification payload that tells the client what account mode and plan are currently active.

**Data flow**: It reads cached authentication, extracts the auth mode and plan type if present, and returns an AccountUpdatedNotification.

**Call relations**: AccountRequestProcessor::send_login_success_notifications calls this after successful login. The notification it builds is then sent to the client.

*Call graph*: called by 1 (send_login_success_notifications).


##### `AccountRequestProcessor::maybe_refresh_plugin_caches_for_current_config`  (lines 176–214)

```
async fn maybe_refresh_plugin_caches_for_current_config(
        config_manager: &ConfigManager,
        thread_manager: &Arc<ThreadManager>,
        auth: Option<CodexAuth>,
    )
```

**Purpose**: Refreshes plugin-related caches after account state changes. This matters because available or recommended plugins can depend on the current account and configuration.

**Data flow**: It receives a config manager, thread manager, and optional auth. It updates plugin auth mode, clears recommended-plugin cache, reloads the latest config, and, if config load succeeds, may start a remote plugin-cache refresh with a callback for later changes.

**Call relations**: Login and logout completion paths call this after auth changes. If remote plugin information later changes, it points to AccountRequestProcessor::spawn_effective_plugins_changed_task so broader caches and running threads can be refreshed.

*Call graph*: calls 1 internal fn (load_latest_config); 4 external calls (clone, new, clone, warn!).


##### `AccountRequestProcessor::spawn_effective_plugins_changed_task`  (lines 216–228)

```
fn spawn_effective_plugins_changed_task(
        thread_manager: Arc<ThreadManager>,
        config_manager: ConfigManager,
    )
```

**Purpose**: Starts a background task to react when the effective plugin set changes. It clears plugin and skill caches and, if there are active threads, queues a best-effort refresh.

**Data flow**: It receives the thread manager and config manager, spawns an asynchronous task, clears cached plugin and skill data, checks whether any threads exist, and queues a refresh only if there is something active to refresh.

**Call relations**: AccountRequestProcessor::maybe_refresh_plugin_caches_for_current_config installs this as a callback. It runs later when plugin cache refresh discovers changes that should be reflected across threads.

*Call graph*: calls 1 internal fn (queue_best_effort_refresh); 1 external calls (spawn).


##### `AccountRequestProcessor::login_v2`  (lines 230–264)

```
async fn login_v2(
        &self,
        request_id: ConnectionRequestId,
        params: LoginAccountParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Chooses the correct login path based on the client’s login method. It is the switchboard for API key, browser ChatGPT, device-code ChatGPT, and externally supplied token login.

**Data flow**: It receives a request ID and login parameters, matches the parameter variant, and calls the matching login function. It returns success after that function has taken responsibility for sending the response.

**Call relations**: AccountRequestProcessor::login_account calls this. It dispatches to AccountRequestProcessor::login_api_key_v2, AccountRequestProcessor::login_chatgpt_v2, AccountRequestProcessor::login_chatgpt_device_code_v2, or AccountRequestProcessor::login_chatgpt_auth_tokens.

*Call graph*: calls 4 internal fn (login_api_key_v2, login_chatgpt_auth_tokens, login_chatgpt_device_code_v2, login_chatgpt_v2); called by 1 (login_account).


##### `AccountRequestProcessor::external_auth_active_error`  (lines 266–270)

```
fn external_auth_active_error(&self) -> JSONRPCErrorError
```

**Purpose**: Creates a clear client error for attempts to use normal login while external ChatGPT auth is active. This prevents mixing two incompatible ways of controlling the account.

**Data flow**: It reads no changing state and returns a JSON-RPC invalid-request error with guidance about what action is allowed.

**Call relations**: AccountRequestProcessor::login_api_key_common and AccountRequestProcessor::login_chatgpt_common call this when they detect external auth is active.

*Call graph*: called by 2 (login_api_key_common, login_chatgpt_common).


##### `AccountRequestProcessor::login_api_key_common`  (lines 272–309)

```
async fn login_api_key_common(
        &self,
        params: &LoginApiKeyParams,
    ) -> std::result::Result<(), JSONRPCErrorError>
```

**Purpose**: Performs the shared work for API key login. It checks whether API key login is allowed, cancels any competing login, saves the key, and reloads authentication.

**Data flow**: It receives API key parameters, checks external-auth and forced-login settings, removes any active login attempt, writes the API key through the auth storage helper, reloads auth on success, and returns either success or a JSON-RPC error.

**Call relations**: AccountRequestProcessor::login_api_key_v2 calls this before sending the client response. It uses AccountRequestProcessor::external_auth_active_error for one validation failure.

*Call graph*: calls 1 internal fn (external_auth_active_error); called by 1 (login_api_key_v2); 2 external calls (format!, matches!).


##### `AccountRequestProcessor::login_api_key_v2`  (lines 311–323)

```
async fn login_api_key_v2(&self, request_id: ConnectionRequestId, params: LoginApiKeyParams)
```

**Purpose**: Runs API key login for a client request and sends the result back. On success, it also triggers account-change notifications.

**Data flow**: It receives a request ID and API key parameters, calls AccountRequestProcessor::login_api_key_common, converts success into an API-key login response, sends that result to the client, and sends login-success notifications if login worked.

**Call relations**: AccountRequestProcessor::login_v2 calls this for API key login. It hands post-login work to AccountRequestProcessor::send_login_success_notifications.

*Call graph*: calls 2 internal fn (login_api_key_common, send_login_success_notifications); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_common`  (lines 326–365)

```
async fn login_chatgpt_common(
        &self,
        codex_streamlined_login: bool,
    ) -> std::result::Result<LoginServerOptions, JSONRPCErrorError>
```

**Purpose**: Builds and validates the options needed for a ChatGPT login. It centralizes rules shared by browser login and device-code login.

**Data flow**: It reads configuration and auth state, rejects external auth or forced API-key-only mode, then creates LoginServerOptions using the configured Codex home, client ID, workspace restriction, credential storage, and keyring backend. In debug builds, it can override the login issuer from an environment variable.

**Call relations**: AccountRequestProcessor::login_chatgpt_response and AccountRequestProcessor::login_chatgpt_device_code_response call this before starting their login flows. It calls AccountRequestProcessor::external_auth_active_error for the external-auth conflict.

*Call graph*: calls 1 internal fn (external_auth_active_error); called by 2 (login_chatgpt_device_code_response, login_chatgpt_response); 3 external calls (new, matches!, var).


##### `AccountRequestProcessor::login_chatgpt_device_code_start_error`  (lines 367–374)

```
fn login_chatgpt_device_code_start_error(err: IoError) -> JSONRPCErrorError
```

**Purpose**: Converts a device-code startup I/O error into the right client-facing JSON-RPC error. Missing device-code support is reported as a bad request; other failures are internal errors.

**Data flow**: It receives an I/O error, checks whether it is a 'not found' kind of error, and returns either an invalid-request error or an internal-error message.

**Call relations**: This is used as the error converter when requesting a ChatGPT device code. It keeps the device-code response path from exposing raw low-level errors directly.

*Call graph*: 3 external calls (kind, to_string, format!).


##### `AccountRequestProcessor::login_chatgpt_v2`  (lines 376–383)

```
async fn login_chatgpt_v2(
        &self,
        request_id: ConnectionRequestId,
        codex_streamlined_login: bool,
    )
```

**Purpose**: Starts browser-based ChatGPT login for a client request and sends the initial response. The response contains the login ID and authorization URL if startup succeeds.

**Data flow**: It receives a request ID and streamlined-login flag, calls AccountRequestProcessor::login_chatgpt_response, then sends that result to the client.

**Call relations**: AccountRequestProcessor::login_v2 calls this for browser ChatGPT login. The long-running browser login itself is started by AccountRequestProcessor::login_chatgpt_response.

*Call graph*: calls 1 internal fn (login_chatgpt_response); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_response`  (lines 385–450)

```
async fn login_chatgpt_response(
        &self,
        codex_streamlined_login: bool,
    ) -> Result<LoginAccountResponse, JSONRPCErrorError>
```

**Purpose**: Starts the browser-based ChatGPT login server and records it as the active login. It returns quickly with a URL while a background task waits for completion.

**Data flow**: It validates login options, starts a local login server, creates a new login ID, replaces any previous active login, and spawns a background task. That task waits up to ten minutes for login completion, sends success or failure notifications, and clears the active-login slot if it still belongs to this login.

**Call relations**: AccountRequestProcessor::login_chatgpt_v2 calls this. Its background task later calls AccountRequestProcessor::send_chatgpt_login_completion_notifications to report the final outcome.

*Call graph*: calls 1 internal fn (login_chatgpt_common); called by 1 (login_chatgpt_v2); 7 external calls (clone, send_chatgpt_login_completion_notifications, new_v4, clone, format!, spawn, timeout).


##### `AccountRequestProcessor::login_chatgpt_device_code_v2`  (lines 452–455)

```
async fn login_chatgpt_device_code_v2(&self, request_id: ConnectionRequestId)
```

**Purpose**: Starts device-code ChatGPT login for a client request and sends the initial response. Device-code login is the flow where the user enters a short code on another web page.

**Data flow**: It receives the request ID, calls AccountRequestProcessor::login_chatgpt_device_code_response, and sends the resulting verification URL, user code, and login ID or an error to the client.

**Call relations**: AccountRequestProcessor::login_v2 calls this for device-code login. The setup and background completion wait happen in AccountRequestProcessor::login_chatgpt_device_code_response.

*Call graph*: calls 1 internal fn (login_chatgpt_device_code_response); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_device_code_response`  (lines 457–523)

```
async fn login_chatgpt_device_code_response(
        &self,
    ) -> Result<LoginAccountResponse, JSONRPCErrorError>
```

**Purpose**: Requests a ChatGPT device code, stores the login as active, and starts a background task to finish the login. It lets users authenticate on another device or browser.

**Data flow**: It validates common ChatGPT login options, requests a device code, creates a login ID and cancellation token, replaces any prior active login, and returns the verification URL and user code. In the background, it waits either for cancellation or for device-code completion, sends completion notifications, and clears the active login if it still matches.

**Call relations**: AccountRequestProcessor::login_chatgpt_device_code_v2 calls this. The spawned task uses AccountRequestProcessor::send_chatgpt_login_completion_notifications after the user completes or abandons the flow.

*Call graph*: calls 1 internal fn (login_chatgpt_common); called by 1 (login_chatgpt_device_code_v2); 7 external calls (clone, new, send_chatgpt_login_completion_notifications, new_v4, clone, select!, spawn).


##### `AccountRequestProcessor::cancel_login_chatgpt_common`  (lines 525–538)

```
async fn cancel_login_chatgpt_common(
        &self,
        login_id: Uuid,
    ) -> std::result::Result<(), CancelLoginError>
```

**Purpose**: Cancels an active ChatGPT login only if the provided login ID matches. This prevents an old cancel request from accidentally stopping a newer login.

**Data flow**: It receives a UUID, locks the active-login slot, compares the stored login ID with the requested one, removes and drops the active login on a match, and returns either success or NotFound.

**Call relations**: AccountRequestProcessor::cancel_login_response calls this after parsing the client’s login ID. Dropping the removed ActiveLogin performs the actual cancellation.

*Call graph*: called by 1 (cancel_login_response).


##### `AccountRequestProcessor::cancel_login_response`  (lines 540–552)

```
async fn cancel_login_response(
        &self,
        params: CancelLoginAccountParams,
    ) -> Result<CancelLoginAccountResponse, JSONRPCErrorError>
```

**Purpose**: Builds the client response for a cancel-login request. It validates the login ID text and reports whether a matching login was canceled.

**Data flow**: It receives cancel parameters, parses the login ID string into a UUID, calls AccountRequestProcessor::cancel_login_chatgpt_common, and returns a response status of Canceled or NotFound.

**Call relations**: AccountRequestProcessor::cancel_login_account calls this for client requests. It turns lower-level cancellation results into the protocol response.

*Call graph*: calls 1 internal fn (cancel_login_chatgpt_common); called by 1 (cancel_login_account); 1 external calls (parse_str).


##### `AccountRequestProcessor::login_chatgpt_auth_tokens`  (lines 554–571)

```
async fn login_chatgpt_auth_tokens(
        &self,
        request_id: ConnectionRequestId,
        access_token: String,
        chatgpt_account_id: String,
        chatgpt_plan_type: Option<String>,
```

**Purpose**: Logs in using ChatGPT tokens supplied by an external authority and sends the result to the client. This is for environments where the app does not run the normal browser/device login itself.

**Data flow**: It receives a request ID, access token, account ID, and optional plan type, calls AccountRequestProcessor::login_chatgpt_auth_tokens_response, sends the result, and sends login-success notifications if it worked.

**Call relations**: AccountRequestProcessor::login_v2 calls this for the chatgptAuthTokens login variant. It delegates storage and validation to AccountRequestProcessor::login_chatgpt_auth_tokens_response.

*Call graph*: calls 2 internal fn (login_chatgpt_auth_tokens_response, send_login_success_notifications); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_auth_tokens_response`  (lines 573–621)

```
async fn login_chatgpt_auth_tokens_response(
        &self,
        access_token: String,
        chatgpt_account_id: String,
        chatgpt_plan_type: Option<String>,
    ) -> Result<LoginAccountRes
```

**Purpose**: Stores externally supplied ChatGPT auth tokens after checking that this kind of auth is allowed. It also updates configuration pieces that depend on cloud account state.

**Data flow**: It checks forced-login settings, cancels any active managed login, verifies workspace restrictions if configured, writes the external token data, reloads auth, replaces the cloud config bundle loader, syncs the default residency requirement, and returns a ChatGPT-auth-tokens response.

**Call relations**: AccountRequestProcessor::login_chatgpt_auth_tokens calls this before sending the client response. On success, the caller sends the usual login-success notifications.

*Call graph*: calls 2 internal fn (replace_cloud_config_bundle_loader, sync_default_client_residency_requirement); called by 1 (login_chatgpt_auth_tokens); 2 external calls (format!, matches!).


##### `AccountRequestProcessor::send_login_success_notifications`  (lines 623–647)

```
async fn send_login_success_notifications(&self, login_id: Option<Uuid>)
```

**Purpose**: Sends the standard follow-up notifications after an immediate login success. It refreshes plugin-related caches and tells the client both that login completed and that account state changed.

**Data flow**: It receives an optional login ID, refreshes plugin caches for the current config and auth, creates an AccountLoginCompletedNotification with success=true, sends it, then builds and sends an AccountUpdatedNotification.

**Call relations**: AccountRequestProcessor::login_api_key_v2 and AccountRequestProcessor::login_chatgpt_auth_tokens call this after successful login. It uses AccountRequestProcessor::current_account_updated_notification for the account update payload.

*Call graph*: calls 1 internal fn (current_account_updated_notification); called by 2 (login_api_key_v2, login_chatgpt_auth_tokens); 3 external calls (maybe_refresh_plugin_caches_for_current_config, AccountLoginCompleted, AccountUpdated).


##### `AccountRequestProcessor::send_chatgpt_login_completion_notifications`  (lines 649–691)

```
async fn send_chatgpt_login_completion_notifications(
        outgoing: &OutgoingMessageSender,
        config_manager: ConfigManager,
        thread_manager: Arc<ThreadManager>,
        chatgpt_base_
```

**Purpose**: Sends the final notifications for browser or device-code ChatGPT login. On success, it reloads auth, updates cloud config, refreshes plugin caches, and tells the client the account changed.

**Data flow**: It receives the outgoing sender, config manager, thread manager, base URL, login ID, success flag, and optional error message. It always sends login-completed. If successful, it reloads auth, updates cloud configuration, syncs residency requirements, refreshes plugin caches, builds account state from the new auth, and sends account-updated.

**Call relations**: The background tasks started by AccountRequestProcessor::login_chatgpt_response and AccountRequestProcessor::login_chatgpt_device_code_response call this when their login flow finishes.

*Call graph*: calls 3 internal fn (replace_cloud_config_bundle_loader, sync_default_client_residency_requirement, send_server_notification); 4 external calls (maybe_refresh_plugin_caches_for_current_config, AccountLoginCompleted, AccountUpdated, to_string).


##### `AccountRequestProcessor::logout_common`  (lines 693–722)

```
async fn logout_common(&self) -> std::result::Result<Option<AuthMode>, JSONRPCErrorError>
```

**Purpose**: Performs the shared logout work. It cancels any active login, revokes stored auth where possible, refreshes plugin caches, and reports the remaining auth mode if any.

**Data flow**: It removes any active login attempt, asks the auth manager to logout and revoke credentials, refreshes plugin caches using the new auth state, then returns the current auth mode or an error.

**Call relations**: AccountRequestProcessor::logout_v2 calls this before sending the logout response. It also calls AccountRequestProcessor::maybe_refresh_plugin_caches_for_current_config so plugin state follows the account state.

*Call graph*: called by 1 (logout_v2); 2 external calls (maybe_refresh_plugin_caches_for_current_config, format!).


##### `AccountRequestProcessor::logout_v2`  (lines 724–745)

```
async fn logout_v2(&self, request_id: ConnectionRequestId) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Runs logout for a client request, sends the logout response, and notifies the client if account state changed.

**Data flow**: It receives a request ID, calls AccountRequestProcessor::logout_common, prepares an AccountUpdatedNotification if logout succeeded, sends the logout result to the client, then sends the account-updated notification when appropriate.

**Call relations**: AccountRequestProcessor::logout_account calls this. It delegates the actual logout to AccountRequestProcessor::logout_common and handles client communication afterward.

*Call graph*: calls 1 internal fn (logout_common); called by 1 (logout_account); 1 external calls (AccountUpdated).


##### `AccountRequestProcessor::refresh_token_if_requested`  (lines 747–760)

```
async fn refresh_token_if_requested(&self, do_refresh: bool) -> RefreshTokenRequestOutcome
```

**Purpose**: Refreshes the current token only when the caller asked for it and it is safe to do so. It distinguishes temporary refresh trouble from permanent credential failure.

**Data flow**: It receives a boolean request flag, skips refresh for external ChatGPT auth, attempts refresh only if requested, and returns one of three outcomes: not needed/succeeded, failed temporarily, or failed permanently.

**Call relations**: AccountRequestProcessor::get_auth_status_response and AccountRequestProcessor::get_account_response call this before reading account state. It logs temporary failures but lets those reads continue.

*Call graph*: called by 2 (get_account_response, get_auth_status_response); 1 external calls (warn!).


##### `AccountRequestProcessor::get_auth_status_response`  (lines 762–830)

```
async fn get_auth_status_response(
        &self,
        params: GetAuthStatusParams,
    ) -> Result<GetAuthStatusResponse, JSONRPCErrorError>
```

**Purpose**: Builds a response describing whether authentication is present and required. It can optionally include a usable token, but avoids returning tokens in cases where the response format cannot safely represent the credentials.

**Data flow**: It reads request flags for token inclusion and token refresh, optionally refreshes auth, checks whether the configured model provider requires OpenAI/Codex auth, reads auth state, decides which auth method and token to report, and returns a GetAuthStatusResponse.

**Call relations**: AccountRequestProcessor::get_auth_status calls this for client auth-status requests. It uses AccountRequestProcessor::refresh_token_if_requested before deciding what to report.

*Call graph*: calls 1 internal fn (refresh_token_if_requested); called by 1 (get_auth_status); 2 external calls (matches!, warn!).


##### `AccountRequestProcessor::get_account_response`  (lines 832–854)

```
async fn get_account_response(
        &self,
        params: GetAccountParams,
    ) -> Result<GetAccountResponse, JSONRPCErrorError>
```

**Purpose**: Builds the account-info response for the current model provider. It tells the client what account, if any, is available and whether OpenAI/Codex auth is needed.

**Data flow**: It reads whether the caller requested token refresh, optionally refreshes auth, creates a model provider using the current config and auth manager, asks that provider for account state, converts the account into the client response type, and returns it.

**Call relations**: AccountRequestProcessor::get_account calls this for client account requests. It uses AccountRequestProcessor::refresh_token_if_requested before asking the provider for account state.

*Call graph*: calls 1 internal fn (refresh_token_if_requested); called by 1 (get_account).


##### `AccountRequestProcessor::get_account_rate_limits_response`  (lines 856–917)

```
async fn get_account_rate_limits_response(
        &self,
    ) -> Result<GetAccountRateLimitsResponse, JSONRPCErrorError>
```

**Purpose**: Fetches Codex account rate limits from the backend. It requires a ChatGPT/Codex backend auth because API-key-style auth is not enough for this backend endpoint.

**Data flow**: It reads current auth, rejects missing or non-Codex-backend auth, builds a backend client, fetches rate-limit snapshots and reset-credit information, chooses a primary rate-limit snapshot, also builds a map by limit ID, and returns the response.

**Call relations**: AccountRequestProcessor::get_account_rate_limits calls this for client requests. It talks directly to the backend through a client created from the current auth.

*Call graph*: called by 1 (get_account_rate_limits); 1 external calls (from_auth).


##### `AccountRequestProcessor::get_account_token_usage_response`  (lines 919–944)

```
async fn get_account_token_usage_response(
        &self,
    ) -> Result<GetAccountTokenUsageResponse, JSONRPCErrorError>
```

**Purpose**: Fetches token-usage statistics from the Codex backend. It protects the request with a short timeout so the server does not wait forever.

**Data flow**: It reads current auth, rejects missing or non-Codex-backend auth, builds a backend client, asks for the token-usage profile with a timeout, converts backend errors into client errors, then passes the profile to AccountRequestProcessor::account_token_usage_response.

**Call relations**: AccountRequestProcessor::get_account_token_usage calls this for client usage requests. It uses AccountRequestProcessor::account_token_usage_response to reshape backend data into protocol data.

*Call graph*: called by 1 (get_account_token_usage); 3 external calls (from_auth, account_token_usage_response, timeout).


##### `AccountRequestProcessor::account_token_usage_response`  (lines 946–966)

```
fn account_token_usage_response(profile: TokenUsageProfile) -> GetAccountTokenUsageResponse
```

**Purpose**: Converts backend token-usage profile data into the response shape used by the app server. It is a small translation step between backend field names and client-facing fields.

**Data flow**: It receives a TokenUsageProfile, takes summary statistics and optional daily buckets from it, maps each bucket into the account-response type, and returns a GetAccountTokenUsageResponse.

**Call relations**: AccountRequestProcessor::get_account_token_usage_response calls this after fetching backend data. The test tests::account_token_usage_response_maps_profile_stats_and_daily_buckets also calls it to verify the mapping.

*Call graph*: called by 1 (account_token_usage_response_maps_profile_stats_and_daily_buckets).


##### `AccountRequestProcessor::send_add_credits_nudge_email_response`  (lines 968–975)

```
async fn send_add_credits_nudge_email_response(
        &self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> Result<SendAddCreditsNudgeEmailResponse, JSONRPCErrorError>
```

**Purpose**: Wraps the add-credits nudge operation in the response object expected by the client protocol.

**Data flow**: It receives nudge-email parameters, calls AccountRequestProcessor::send_add_credits_nudge_email_inner, and places the returned status into SendAddCreditsNudgeEmailResponse.

**Call relations**: AccountRequestProcessor::send_add_credits_nudge_email calls this for client requests. The actual backend interaction is handled by AccountRequestProcessor::send_add_credits_nudge_email_inner.

*Call graph*: calls 1 internal fn (send_add_credits_nudge_email_inner); called by 1 (send_add_credits_nudge_email).


##### `AccountRequestProcessor::send_add_credits_nudge_email_inner`  (lines 977–1008)

```
async fn send_add_credits_nudge_email_inner(
        &self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> Result<AddCreditsNudgeEmailStatus, JSONRPCErrorError>
```

**Purpose**: Asks the backend to email the workspace owner about adding credits or changing usage limits. It reports a cooldown status when the backend says too many nudges were sent recently.

**Data flow**: It reads current auth, rejects missing or non-Codex-backend auth, builds a backend client, converts the requested credit type to the backend’s type, sends the email request, and returns Sent, CooldownActive, or an error.

**Call relations**: AccountRequestProcessor::send_add_credits_nudge_email_response calls this. It uses AccountRequestProcessor::backend_credit_type before calling the backend.

*Call graph*: called by 1 (send_add_credits_nudge_email_response); 3 external calls (from_auth, backend_credit_type, format!).


##### `AccountRequestProcessor::backend_credit_type`  (lines 1010–1015)

```
fn backend_credit_type(value: AddCreditsNudgeCreditType) -> BackendAddCreditsNudgeCreditType
```

**Purpose**: Translates the app server’s credit-nudge type into the backend client’s credit-nudge type. This keeps the external backend type from leaking into the client-facing protocol layer.

**Data flow**: It receives either Credits or UsageLimit from the app protocol and returns the matching backend enum value.

**Call relations**: AccountRequestProcessor::send_add_credits_nudge_email_inner uses this immediately before calling the backend nudge-email endpoint.


##### `tests::account_token_usage_response_maps_profile_stats_and_daily_buckets`  (lines 1026–1057)

```
fn account_token_usage_response_maps_profile_stats_and_daily_buckets()
```

**Purpose**: Checks that backend token-usage profile data is converted correctly into the client response type. It protects against accidental field mix-ups in the mapper.

**Data flow**: It builds a sample TokenUsageProfile with summary values and one daily bucket, calls AccountRequestProcessor::account_token_usage_response, and compares the result with the expected response.

**Call relations**: This test exercises AccountRequestProcessor::account_token_usage_response directly. It runs during the test lifecycle, not during normal request handling.

*Call graph*: calls 1 internal fn (account_token_usage_response); 2 external calls (assert_eq!, vec!).


### Login flow orchestration
These files define the login crate surface and implement the interactive browser and device-code ChatGPT login paths, including onboarding-time headless UX.

### `login/src/lib.rs`

`other` · `cross-cutting`

This file does not contain login logic itself. Instead, it acts like the reception desk for the login part of the system: it points callers to the right rooms and exposes the names they are allowed to use. The crate is split into smaller modules for different jobs, such as reading saved authentication data, collecting telemetry about the login environment, storing token details, running device-code login, supporting PKCE login, and running a local login server. Some of those modules are public, while others stay private implementation details.

The many `pub use` lines re-export important types and functions. That means other parts of the project can write imports from `login` directly, instead of needing to know which inner file defines `AuthManager`, `DeviceCode`, `LoginServer`, or `logout_with_revoke`. This keeps the rest of the codebase from depending on the crate’s internal layout. If the implementation moves between files later, callers can often keep using the same public names.

Without this file, the login crate would have no clear public surface. Other code would need to reach into internal modules directly, making the system harder to understand and easier to break during refactors.


### `login/src/device_code_auth.rs`

`orchestration` · `login/auth flow`

Device-code login is like picking up an order number at a counter: the CLI asks the server for a temporary code, shows that code to the user, and then keeps checking whether the user has finished the browser step. This file covers that whole flow.

First, it asks the Codex authentication server for a user-facing code and a hidden device authentication ID. The user-facing code is what the person types into the browser. The hidden ID is what the CLI uses to prove it is checking on the same login attempt. The file then prints clear instructions, including a warning not to share the code because these codes can be used in phishing attacks.

After that, it polls the server, meaning it asks again and again at a safe interval, until the browser sign-in is complete or 15 minutes pass. When the server returns an authorization code, this file exchanges it for real login tokens. It also checks whether the signed-in account belongs to an allowed workspace, if the configuration requires that. Finally, it saves the tokens so later Codex commands can run without asking the user to sign in again.

The important behavior to notice is that this file does not ask for passwords. It only coordinates a temporary code, browser approval, token exchange, and secure storage.

#### Function details

##### `deserialize_interval`  (lines 46–52)

```
fn deserialize_interval(deserializer: D) -> Result<u64, D::Error>
```

**Purpose**: This function reads the server's polling interval, which tells the CLI how many seconds to wait between status checks. It exists because the server sends that value as text, while the program needs it as a number.

**Data flow**: It receives a serialized value from the server response. It reads it as a string, trims extra whitespace, converts it into an unsigned number, and returns that number. If the text is not a valid number, it returns a parsing error.

**Call relations**: This is used automatically while decoding the user-code response from the server. It supports the later polling step by making sure the wait interval is available in the right form.

*Call graph*: 1 external calls (deserialize).


##### `request_user_code`  (lines 62–96)

```
async fn request_user_code(
    client: &reqwest::Client,
    auth_base_url: &str,
    client_id: &str,
) -> std::io::Result<UserCodeResp>
```

**Purpose**: This function asks the authentication server to start a device-code login. It gets back the code the user must type in the browser, plus server-side details the CLI needs for later checks.

**Data flow**: It takes an HTTP client, the authentication API base URL, and the client ID. It builds a JSON request, sends it to the server's device-code endpoint, checks whether the response succeeded, and turns the response body into a structured result. If the endpoint is missing, it gives a helpful message saying device-code login is not enabled.

**Call relations**: This is called by request_device_code when the login flow begins. It hands back the raw server response that request_device_code turns into the public DeviceCode value used by the rest of the flow.

*Call graph*: called by 1 (request_device_code); 6 external calls (post, new, other, format!, from_str, to_string).


##### `poll_for_token`  (lines 99–146)

```
async fn poll_for_token(
    client: &reqwest::Client,
    auth_base_url: &str,
    device_auth_id: &str,
    user_code: &str,
    interval: u64,
) -> std::io::Result<CodeSuccessResp>
```

**Purpose**: This function waits for the user to finish signing in through the browser. It repeatedly asks the server whether the temporary device code has been approved yet.

**Data flow**: It takes an HTTP client, the authentication API base URL, the hidden device authentication ID, the visible user code, and the polling interval. It sends those values to the token endpoint in a loop. A successful response becomes an authorization-code response. A not-ready response causes it to sleep and try again, up to 15 minutes. Any unexpected failure becomes an error.

**Call relations**: This is called by complete_device_code_login after the prompt has already been shown to the user. When it finally receives the authorization code and PKCE values, it passes them back so the next step can exchange them for saved login tokens.

*Call graph*: called by 1 (complete_device_code_login); 7 external calls (from_secs, now, post, other, format!, to_string, sleep).


##### `print_device_code_prompt`  (lines 148–157)

```
fn print_device_code_prompt(verification_url: &str, code: &str)
```

**Purpose**: This function prints the human-facing login instructions in the terminal. It shows the browser link, the one-time code, the Codex version, and a security warning.

**Data flow**: It receives the verification URL and the user code. It combines them with fixed explanatory text and terminal color codes, then writes the formatted instructions to standard output. It does not return data or change login state.

**Call relations**: This is called by run_device_code_login after request_device_code has obtained the code. It is the bridge between the server-side login setup and the human action needed in the browser.

*Call graph*: called by 1 (run_device_code_login); 2 external calls (env!, println!).


##### `request_device_code`  (lines 159–171)

```
async fn request_device_code(opts: &ServerOptions) -> std::io::Result<DeviceCode>
```

**Purpose**: This function prepares the first usable device-code object for the login flow. It hides the details of building the HTTP client, choosing the right server URL, and reshaping the server response into the form the rest of the code needs.

**Data flow**: It receives server options such as the issuer URL and client ID. It builds an HTTP client that respects custom certificate settings, cleans up the base URL, calls request_user_code, and returns a DeviceCode containing the browser URL, visible user code, hidden device authentication ID, and polling interval.

**Call relations**: This is the first step called by run_device_code_login. It relies on request_user_code for the network request, then hands the resulting DeviceCode to the prompt and completion steps.

*Call graph*: calls 1 internal fn (request_user_code); called by 1 (run_device_code_login); 3 external calls (builder, build_reqwest_client_with_custom_ca, format!).


##### `complete_device_code_login`  (lines 173–223)

```
async fn complete_device_code_login(
    opts: ServerOptions,
    device_code: DeviceCode,
) -> std::io::Result<()>
```

**Purpose**: This function finishes the device-code login after the user has been given the code. It waits for browser approval, exchanges the approval for real tokens, checks workspace permissions, and saves the credentials.

**Data flow**: It receives server options and a DeviceCode. It builds an HTTP client, polls the server until it receives an authorization code, wraps the returned PKCE values used to prove the exchange is legitimate, and calls the normal token-exchange function. It then checks whether the account is allowed for the configured workspace and persists the ID, access, and refresh tokens. On failure, it returns an appropriate I/O error.

**Call relations**: This is called by run_device_code_login after the code has been printed. It calls poll_for_token to wait for approval, then hands the authorization code to exchange_code_for_tokens, verifies the workspace with ensure_workspace_allowed, and finally gives the tokens to persist_tokens_async so future commands can use them.

*Call graph*: calls 4 internal fn (poll_for_token, ensure_workspace_allowed, exchange_code_for_tokens, persist_tokens_async); called by 1 (run_device_code_login); 4 external calls (builder, new, build_reqwest_client_with_custom_ca, format!).


##### `run_device_code_login`  (lines 225–229)

```
async fn run_device_code_login(opts: ServerOptions) -> std::io::Result<()>
```

**Purpose**: This function runs the complete device-code sign-in sequence from start to finish. It is the simple top-level entry for this login method.

**Data flow**: It receives server options. It first requests a device code, then prints the browser instructions for the user, then completes the login by polling, exchanging, checking, and saving tokens. It returns success when credentials are stored, or an error if any step fails.

**Call relations**: This function ties the file together. It calls request_device_code for setup, print_device_code_prompt for the user-facing step, and complete_device_code_login for the waiting, token exchange, permission check, and persistence work.

*Call graph*: calls 3 internal fn (complete_device_code_login, print_device_code_prompt, request_device_code).


### `login/src/server.rs`

`orchestration` · `interactive login`

Interactive browser login needs a safe place for the identity provider to send the user back after sign-in. This file creates that place: a tiny web server on localhost, meaning it listens only on the user’s own computer. It builds the sign-in URL, optionally opens the browser, waits for the callback, checks that the callback is genuine, exchanges the temporary authorization code for real credentials, and stores those credentials locally.

A useful analogy is a hotel front desk: the browser brings back a claim ticket, and this server checks the ticket, asks the trusted backend for the actual room key, then stores the key where Codex can use it later.

The file also pays close attention to safety. Login URLs and errors can contain secrets, so it separates user-facing error messages from structured logs. Logs keep enough shape to debug problems, such as which endpoint failed, but sensitive values like tokens, codes, and passwords are redacted.

It includes fallback behavior for busy ports, a cancellation path for old login attempts, workspace restrictions, branded success and error pages, and tests for the error parsing and redaction rules. Without this file, browser-based login would have nowhere reliable to return to, credentials would not be saved, and failures would be harder to diagnose safely.

#### Function details

##### `ServerOptions::new`  (lines 78–97)

```
fn new(
        codex_home: PathBuf,
        client_id: String,
        forced_chatgpt_workspace_id: Option<Vec<String>>,
        cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
        aut
```

**Purpose**: Creates the default settings for starting the local login server. Callers provide the Codex home folder, OAuth client ID, workspace restrictions, and credential storage choices, while this fills in standard defaults like issuer, port, and browser opening.

**Data flow**: It receives user- and environment-specific settings, adds the default OpenAI auth issuer and default callback port, and returns a complete ServerOptions value ready to pass into the login server.

**Call relations**: Higher-level login flows call this when they are preparing browser or device-code login. The resulting options are later consumed by run_login_server and request-processing code.

*Call graph*: called by 8 (login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser, file_reads_reject_named_pipes, device_code_login_integration_handles_error_payload, device_code_login_integration_persists_without_api_key_on_exchange_failure, server_opts, falls_back_to_registered_fallback_port_when_default_port_is_in_use).


##### `LoginServer::block_until_done`  (lines 110–114)

```
async fn block_until_done(self) -> io::Result<()>
```

**Purpose**: Waits until the login server finishes, either because sign-in succeeded, failed, or was cancelled. This gives the caller a single result for the whole interactive login attempt.

**Data flow**: It takes ownership of the running LoginServer, waits for its background task to finish, converts a task panic into an input/output error, and returns the final success or failure result.

**Call relations**: After run_login_server starts the server, callers can use this method to pause until the callback flow is complete.


##### `LoginServer::cancel`  (lines 117–119)

```
fn cancel(&self)
```

**Purpose**: Asks the running login server to stop waiting for a browser callback. This is used when the login attempt should be abandoned.

**Data flow**: It reads the server’s shutdown handle and sends a shutdown signal through it. Nothing is returned, but the background login loop is notified.

**Call relations**: This method delegates to ShutdownHandle::shutdown. The server loop created by run_login_server listens for that signal and exits with a cancellation-style error.

*Call graph*: calls 1 internal fn (shutdown).


##### `LoginServer::cancel_handle`  (lines 122–124)

```
fn cancel_handle(&self) -> ShutdownHandle
```

**Purpose**: Provides a cloneable shutdown handle so other parts of the program can cancel the login server later. This avoids needing to hold the full LoginServer object just to stop it.

**Data flow**: It reads the stored shutdown handle, clones it, and returns the clone. The original server continues running.

**Call relations**: Code that starts the server can hand this smaller handle to another task or user-interface path, which can later call ShutdownHandle::shutdown.

*Call graph*: 1 external calls (clone).


##### `ShutdownHandle::shutdown`  (lines 135–137)

```
fn shutdown(&self)
```

**Purpose**: Sends the actual stop signal to the login server loop. It is a small wrapper around a notification object, which is like ringing a bell that the waiting task hears.

**Data flow**: It uses the shared notification inside the handle and wakes one waiting listener. It does not return a value.

**Call relations**: LoginServer::cancel calls this. The async loop inside run_login_server waits for this notification and exits if it arrives before login completes.

*Call graph*: called by 1 (cancel).


##### `run_login_server`  (lines 141–251)

```
fn run_login_server(opts: ServerOptions) -> io::Result<LoginServer>
```

**Purpose**: Starts the full local browser-login flow. It creates security codes, binds a localhost web server, builds the authorization URL, optionally opens the browser, and launches the background loop that processes callbacks.

**Data flow**: It receives ServerOptions, generates a PKCE code pair and random state value, binds a local port, creates the browser URL, starts a blocking request receiver thread, and starts an async task that handles incoming requests. It returns a LoginServer containing the URL, actual port, server task, and cancellation handle.

**Call relations**: This is the main entry for browser login setup. It calls helpers such as generate_pkce, bind_server, build_authorize_url, and process_request, then packages the running pieces into LoginServer for the caller.

*Call graph*: calls 3 internal fn (generate_pkce, bind_server, build_authorize_url); 8 external calls (new, new, format!, spawn, select!, spawn, new, open).


##### `process_request`  (lines 264–439)

```
async fn process_request(
    url_raw: &str,
    opts: &ServerOptions,
    redirect_uri: &str,
    pkce: &PkceCodes,
    actual_port: u16,
    state: &str,
) -> HandledRequest
```

**Purpose**: Decides what to do with each HTTP request that reaches the local login server. It handles the callback, success page, cancellation request, and unknown paths.

**Data flow**: It receives the raw request URL plus login settings, redirect URI, PKCE codes, port, and expected state. It parses the URL, checks the path and query values, validates the state, exchanges the login code for tokens, checks workspace limits, saves credentials, and returns a response instruction for the server loop.

**Call relations**: The request loop inside run_login_server calls this for every incoming browser request. On the main callback path it hands work to exchange_code_for_tokens, ensure_workspace_allowed, obtain_api_key, persist_tokens_async, compose_success_url, and error-page helpers.

*Call graph*: calls 7 internal fn (compose_success_url, ensure_workspace_allowed, exchange_code_for_tokens, login_error_response, oauth_callback_error_message, obtain_api_key, persist_tokens_async); 15 external calls (from_bytes, new, new, from_string, eprintln!, error!, format!, include_str!, info!, RedirectWithHeader (+5 more)).


##### `send_response_with_disconnect`  (lines 450–483)

```
fn send_response_with_disconnect(
    req: Request,
    mut headers: Vec<Header>,
    body: Vec<u8>,
) -> io::Result<()>
```

**Purpose**: Sends a final HTTP response while forcing the browser connection to close. This avoids a stuck keep-alive connection that could make later login attempts hang.

**Data flow**: It takes the original tiny_http request, response headers, and body bytes. It writes a raw HTTP 200 response, removes any existing Connection header, adds Connection: close and Content-Length, writes the body, flushes the stream, and returns whether writing succeeded.

**Call relations**: The server loop in run_login_server uses this for terminal responses, such as success or cancellation. It bypasses tiny_http’s normal response path because that library filters out the Connection header.

*Call graph*: 5 external calls (from_bytes, into_writer, format!, StatusCode, write!).


##### `build_authorize_url`  (lines 485–521)

```
fn build_authorize_url(
    issuer: &str,
    client_id: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
    state: &str,
    forced_chatgpt_workspace_ids: Option<&[String]>,
) -> String
```

**Purpose**: Builds the browser URL where the user starts OAuth sign-in. OAuth is the standard web sign-in flow where a trusted identity provider grants Codex limited access.

**Data flow**: It receives issuer, client ID, redirect URI, PKCE data, state value, and optional workspace IDs. It assembles the required query parameters, URL-encodes each value, optionally adds allowed workspace IDs, and returns the full authorization URL string.

**Call relations**: run_login_server calls this after it knows which localhost port is active. The returned URL is shown to the caller and may be opened in the browser.

*Call graph*: called by 1 (run_login_server); 2 external calls (format!, vec!).


##### `generate_state`  (lines 523–527)

```
fn generate_state() -> String
```

**Purpose**: Creates a random state string used to protect the login callback from being mixed up with another request. The state works like a unique ticket number that must come back unchanged.

**Data flow**: It creates 32 random bytes, encodes them in URL-safe base64 text, and returns that string.

**Call relations**: run_login_server uses this unless a forced state is supplied, such as in tests.

*Call graph*: 1 external calls (rng).


##### `send_cancel_request`  (lines 529–544)

```
fn send_cancel_request(port: u16) -> io::Result<()>
```

**Purpose**: Sends a local cancellation request to an already-running login server on a given port. This helps clear out an older login attempt that may be blocking the desired port.

**Data flow**: It receives a port, connects to 127.0.0.1 on that port with short timeouts, writes a simple GET /cancel HTTP request, reads a small response if available, and returns success or an input/output error.

**Call relations**: bind_server calls this when the preferred port is already in use, before retrying the bind.

*Call graph*: called by 1 (bind_server); 3 external calls (from_secs, connect_timeout, format!).


##### `bind_server`  (lines 546–604)

```
fn bind_server(port: u16) -> io::Result<Server>
```

**Purpose**: Tries to start the tiny localhost HTTP server on the requested port, with retry and fallback behavior. It also tries to cancel an old login server if the port appears busy.

**Data flow**: It receives a port, attempts to bind 127.0.0.1:port, retries briefly on address-in-use errors, sends a cancel request once, and if the default port is unavailable it tries the registered fallback port. It returns a tiny_http Server or an error explaining why binding failed.

**Call relations**: run_login_server calls this before building the redirect URL. It uses send_cancel_request to make room when an earlier login process may still be running.

*Call graph*: calls 1 internal fn (send_cancel_request); called by 1 (run_login_server); 8 external calls (from_millis, http, new, other, eprintln!, format!, sleep, warn!).


##### `TokenEndpointErrorDetail::fmt`  (lines 621–623)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Controls how token endpoint errors appear when converted to text. It shows the already-chosen display message.

**Data flow**: It receives a formatter and writes the TokenEndpointErrorDetail display_message into it. The original error code and internal fields are left unchanged.

**Call relations**: exchange_code_for_tokens uses TokenEndpointErrorDetail in formatted error messages after parse_token_endpoint_error extracts useful details.


##### `redact_sensitive_query_value`  (lines 642–651)

```
fn redact_sensitive_query_value(key: &str, value: &str) -> String
```

**Purpose**: Hides query-string values that are likely to contain secrets, such as tokens, API keys, or OAuth codes. Safe keys are left readable so logs remain useful.

**Data flow**: It receives a query key and value. If the key matches a known sensitive name, it returns "<redacted>"; otherwise it returns the original value.

**Call relations**: redact_sensitive_url_parts uses this while cleaning URLs before they are logged or returned in transport errors.


##### `redact_sensitive_url_parts`  (lines 657–687)

```
fn redact_sensitive_url_parts(url: &mut url::Url)
```

**Purpose**: Cleans a URL so it can be used in logs without leaking secrets. It keeps the general host and path shape, but removes embedded credentials, fragments, and sensitive query values.

**Data flow**: It receives a mutable URL, clears username and password fields, removes the fragment after #, rewrites query pairs with sensitive values replaced, and updates the URL in place.

**Call relations**: redact_sensitive_error_url and sanitize_url_for_logging call this. Tests also verify that it preserves useful URL shape while hiding secrets.

*Call graph*: called by 3 (redact_sensitive_error_url, sanitize_url_for_logging, redact_sensitive_url_parts_preserves_safe_url_shape); 7 external calls (new, query_pairs, set_fragment, set_password, set_query, set_username, new).


##### `redact_sensitive_error_url`  (lines 690–695)

```
fn redact_sensitive_error_url(mut err: reqwest::Error) -> reqwest::Error
```

**Purpose**: Removes secrets from any URL attached to a network error before that error is logged or returned. This prevents accidental credential leaks during failed token exchange.

**Data flow**: It receives a reqwest network error, checks whether the error carries a URL, redacts that URL in place if present, and returns the modified error.

**Call relations**: exchange_code_for_tokens calls this when sending the token request fails at the transport layer.

*Call graph*: calls 1 internal fn (redact_sensitive_url_parts); called by 1 (exchange_code_for_tokens); 1 external calls (url_mut).


##### `sanitize_url_for_logging`  (lines 701–709)

```
fn sanitize_url_for_logging(url: &str) -> String
```

**Purpose**: Turns a caller-supplied URL string into a safe version for logs. If the string is not a valid URL, it returns a simple placeholder instead of logging the raw text.

**Data flow**: It receives a string, tries to parse it as a URL, redacts sensitive URL parts if parsing succeeds, and returns either the cleaned URL or "<invalid-url>".

**Call relations**: exchange_code_for_tokens uses this when logging the issuer and token endpoint. A test verifies that credentials and token-like query values are hidden.

*Call graph*: calls 1 internal fn (redact_sensitive_url_parts); called by 1 (sanitize_url_for_logging_redacts_sensitive_issuer_parts); 1 external calls (parse).


##### `exchange_code_for_tokens`  (lines 716–787)

```
async fn exchange_code_for_tokens(
    issuer: &str,
    client_id: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
    code: &str,
) -> io::Result<ExchangedTokens>
```

**Purpose**: Trades the temporary OAuth authorization code for real login tokens. This is the point where the local callback proves to the issuer that the browser sign-in completed.

**Data flow**: It receives issuer, client ID, redirect URI, PKCE codes, and authorization code. It builds an HTTP client, posts form data to the token endpoint, redacts transport errors, parses backend error bodies when the status is not successful, and returns ID, access, and refresh tokens on success.

**Call relations**: process_request calls this during browser callback handling, and device-code login also reuses it. It relies on parse_token_endpoint_error and redact_sensitive_error_url for safe, useful failures.

*Call graph*: calls 2 internal fn (parse_token_endpoint_error, redact_sensitive_error_url); called by 2 (complete_device_code_login, process_request); 7 external calls (builder, other, build_reqwest_client_with_custom_ca, error!, format!, info!, warn!).


##### `persist_tokens_async`  (lines 790–832)

```
async fn persist_tokens_async(
    codex_home: &Path,
    api_key: Option<String>,
    id_token: String,
    access_token: String,
    refresh_token: String,
    auth_credentials_store_mode: AuthCrede
```

**Purpose**: Saves the obtained credentials into the configured local auth store without blocking the async runtime. This makes the successful login usable by later Codex commands.

**Data flow**: It receives the Codex home path, optional API key, token strings, and storage settings. In a blocking worker task, it parses ID-token claims, extracts an account ID if present, builds an AuthDotJson record, and writes it with save_auth. It returns success or an input/output error.

**Call relations**: process_request calls this after token exchange and workspace checks, and device-code login also uses it. It bridges async login code with existing synchronous credential-saving logic.

*Call graph*: called by 2 (complete_device_code_login, process_request); 2 external calls (to_path_buf, spawn_blocking).


##### `compose_success_url`  (lines 834–889)

```
fn compose_success_url(
    port: u16,
    issuer: &str,
    id_token: &str,
    access_token: &str,
    codex_streamlined_login: bool,
) -> String
```

**Purpose**: Builds the local /success URL that the browser is redirected to after credentials are saved. It includes information the success page or surrounding flow needs, such as organization, project, plan type, and setup status.

**Data flow**: It receives the local port, issuer, ID token, access token, and a streamlined-login flag. It extracts selected claims from the tokens, decides the platform URL, builds URL-encoded query parameters, optionally adds the streamlined flag, and returns the final localhost success URL.

**Call relations**: process_request calls this after persistence succeeds. Tests check that the streamlined flag is included only when requested.

*Call graph*: calls 1 internal fn (jwt_auth_claims); called by 3 (process_request, compose_success_url_includes_streamlined_success_when_requested, compose_success_url_omits_streamlined_success_by_default); 2 external calls (format!, vec!).


##### `jwt_auth_claims`  (lines 891–920)

```
fn jwt_auth_claims(jwt: &str) -> serde_json::Map<String, serde_json::Value>
```

**Purpose**: Extracts the OpenAI auth claim object from a JWT token. A JWT is a signed token made of dot-separated text parts; this function reads the middle payload part without verifying the signature.

**Data flow**: It receives a JWT string, splits it into header, payload, and signature, base64url-decodes the payload, parses it as JSON, and returns the nested OpenAI auth claims object. If anything is malformed or missing, it prints a short error and returns an empty map.

**Call relations**: compose_success_url uses this to build success-page parameters, and ensure_workspace_allowed uses it to find the ChatGPT account ID.

*Call graph*: called by 2 (compose_success_url, ensure_workspace_allowed); 2 external calls (eprintln!, new).


##### `ensure_workspace_allowed`  (lines 923–937)

```
fn ensure_workspace_allowed(
    expected: Option<&[String]>,
    id_token: &str,
) -> Result<(), String>
```

**Purpose**: Checks whether an ID token belongs to one of the allowed ChatGPT workspaces, if a restriction was configured. This prevents signing in with the wrong workspace account.

**Data flow**: It receives optional expected workspace IDs and an ID token. If no restriction exists, it succeeds. Otherwise it extracts the account ID from token claims and passes that ID to ensure_workspace_account_allowed, returning either success or a clear error string.

**Call relations**: process_request and device-code login call this after receiving tokens. It uses jwt_auth_claims for token reading and ensure_workspace_account_allowed for the final comparison.

*Call graph*: calls 2 internal fn (ensure_workspace_account_allowed, jwt_auth_claims); called by 2 (complete_device_code_login, process_request).


##### `ensure_workspace_account_allowed`  (lines 942–958)

```
fn ensure_workspace_account_allowed(
    expected: Option<&[String]>,
    actual: &str,
) -> Result<(), String>
```

**Purpose**: Checks a known ChatGPT account ID against an optional list of allowed workspace IDs. This is useful when the account ID is already known and no ID token needs to be parsed.

**Data flow**: It receives optional expected workspace IDs and the actual account ID. If there is no restriction or the actual ID is in the list, it returns success; otherwise it returns an error message naming the allowed workspace IDs.

**Call relations**: ensure_workspace_allowed calls this after extracting an account ID from an ID token. Personal access token login also calls it directly when another endpoint has already supplied the account ID.

*Call graph*: called by 2 (ensure_personal_access_token_workspace_allowed, ensure_workspace_allowed); 1 external calls (format!).


##### `login_error_response`  (lines 961–977)

```
fn login_error_response(
    message: &str,
    kind: io::ErrorKind,
    error_code: Option<&str>,
    error_description: Option<&str>,
) -> HandledRequest
```

**Purpose**: Builds a final browser response for a failed login attempt. It returns both an HTML error page for the browser and an error result for the login caller.

**Data flow**: It receives a message, input/output error kind, optional error code, and optional description. It creates an HTML content-type header, renders the branded error page, and wraps both the body and a matching error result in a terminal response instruction.

**Call relations**: process_request calls this whenever callback validation, token exchange, workspace checks, persistence, or redirect construction fails.

*Call graph*: calls 1 internal fn (render_login_error_page); called by 1 (process_request); 3 external calls (from_bytes, new, new).


##### `is_missing_codex_entitlement_error`  (lines 980–987)

```
fn is_missing_codex_entitlement_error(error_code: &str, error_description: Option<&str>) -> bool
```

**Purpose**: Recognizes a specific OAuth failure meaning the user’s workspace does not have Codex access enabled. This lets the UI show a more helpful message than a generic sign-in failure.

**Data flow**: It receives an OAuth error code and optional description. It returns true only when the code is access_denied and the description mentions missing_codex_entitlement, ignoring text case.

**Call relations**: oauth_callback_error_message uses it to choose terminal text, and render_login_error_page uses it to choose specialized browser-page copy.

*Call graph*: called by 2 (oauth_callback_error_message, render_login_error_page).


##### `oauth_callback_error_message`  (lines 990–1002)

```
fn oauth_callback_error_message(error_code: &str, error_description: Option<&str>) -> String
```

**Purpose**: Turns OAuth callback error fields into a clear user-facing message. It gives special guidance for missing Codex entitlement and otherwise uses the description or code.

**Data flow**: It receives an error code and optional description. It returns a polished message: entitlement guidance, a description-based sign-in failure, or a code-based sign-in failure.

**Call relations**: process_request calls this when the callback contains an OAuth error instead of an authorization code.

*Call graph*: calls 1 internal fn (is_missing_codex_entitlement_error); called by 1 (process_request); 1 external calls (format!).


##### `parse_token_endpoint_error`  (lines 1009–1071)

```
fn parse_token_endpoint_error(body: &str) -> TokenEndpointErrorDetail
```

**Purpose**: Extracts useful details from a failed token endpoint response. It supports common JSON formats while preserving plain-text backend messages for the user-facing error path.

**Data flow**: It receives the response body as text, trims it, tries to parse JSON fields such as error, error_description, nested code, and nested message, and returns a TokenEndpointErrorDetail. If the body is empty it reports unknown error; if it is non-JSON it keeps the text as the display message.

**Call relations**: exchange_code_for_tokens calls this when the token endpoint returns a non-success status. Several tests exercise its different parsing paths.

*Call graph*: called by 5 (exchange_code_for_tokens, parse_token_endpoint_error_falls_back_to_error_code, parse_token_endpoint_error_prefers_error_description, parse_token_endpoint_error_preserves_plain_text_for_display, parse_token_endpoint_error_reads_nested_error_message_and_code).


##### `render_login_error_page`  (lines 1074–1109)

```
fn render_login_error_page(
    message: &str,
    error_code: Option<&str>,
    error_description: Option<&str>,
) -> Vec<u8>
```

**Purpose**: Renders the branded HTML page shown in the browser when login cannot finish. It chooses specialized wording for missing Codex access and escapes all dynamic text before insertion.

**Data flow**: It receives a message, optional error code, and optional description. It chooses a title, display message, description, and help text, runs each dynamic value through html_escape, renders the stored HTML template, and returns the page bytes.

**Call relations**: login_error_response calls this to prepare terminal failure pages. Tests verify both escaping behavior and the special entitlement message.

*Call graph*: calls 2 internal fn (html_escape, is_missing_codex_entitlement_error); called by 3 (login_error_response, render_login_error_page_escapes_dynamic_fields, render_login_error_page_uses_entitlement_copy).


##### `html_escape`  (lines 1112–1125)

```
fn html_escape(input: &str) -> String
```

**Purpose**: Makes arbitrary text safe to insert into HTML. It replaces characters that could otherwise be treated as markup or script.

**Data flow**: It receives a string, walks through each character, replaces &, <, >, double quote, and single quote with HTML-safe entity text, and returns the escaped string.

**Call relations**: render_login_error_page calls this for every dynamic field before rendering the error template.

*Call graph*: called by 1 (render_login_error_page); 1 external calls (with_capacity).


##### `obtain_api_key`  (lines 1128–1162)

```
async fn obtain_api_key(
    issuer: &str,
    client_id: &str,
    id_token: &str,
) -> io::Result<String>
```

**Purpose**: Exchanges an authenticated ID token for an API-key-style access token. This gives Codex an API credential when the backend supports that extra exchange.

**Data flow**: It receives issuer, client ID, and ID token. It posts a token-exchange request to the OAuth token endpoint, checks for a successful status, parses the JSON access_token field, and returns that token or an error.

**Call relations**: process_request calls this after the main OAuth token exchange. Its failure is intentionally tolerated there by converting the result to an optional value.

*Call graph*: called by 1 (process_request); 4 external calls (builder, other, build_reqwest_client_with_custom_ca, format!).


##### `tests::parse_token_endpoint_error_prefers_error_description`  (lines 1179–1192)

```
fn parse_token_endpoint_error_prefers_error_description()
```

**Purpose**: Checks that token endpoint parsing chooses error_description as the main display message when it is available. This protects the most helpful backend message path.

**Data flow**: It feeds JSON containing error and error_description into parse_token_endpoint_error, then compares the result with the expected code, message, and display text.

**Call relations**: This test exercises parse_token_endpoint_error directly and guards behavior used by exchange_code_for_tokens.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::parse_token_endpoint_error_reads_nested_error_message_and_code`  (lines 1195–1208)

```
fn parse_token_endpoint_error_reads_nested_error_message_and_code()
```

**Purpose**: Checks that nested error objects are understood. Some backends report failures as an object with code and message instead of flat fields.

**Data flow**: It passes a JSON body with error.code and error.message into parse_token_endpoint_error, then asserts that both fields are extracted and the message becomes the display text.

**Call relations**: This test protects the parsing path used by exchange_code_for_tokens for structured backend errors.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::parse_token_endpoint_error_falls_back_to_error_code`  (lines 1211–1222)

```
fn parse_token_endpoint_error_falls_back_to_error_code()
```

**Purpose**: Checks that a plain error code is still shown when no description or message is provided. This avoids returning an empty or vague failure.

**Data flow**: It passes JSON with only an error string into parse_token_endpoint_error and verifies that the code is used as the display message.

**Call relations**: This test covers a fallback branch of parse_token_endpoint_error used by token exchange failures.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::parse_token_endpoint_error_preserves_plain_text_for_display`  (lines 1225–1236)

```
fn parse_token_endpoint_error_preserves_plain_text_for_display()
```

**Purpose**: Checks that non-JSON token endpoint responses are preserved for the user-facing error. This helps users and admins see backend details even when the backend does not return JSON.

**Data flow**: It gives parse_token_endpoint_error a plain text body and asserts that the display message contains that exact text while structured code fields remain empty.

**Call relations**: This test guards the careful split between user-visible detail and safer structured logging in exchange_code_for_tokens.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::redact_sensitive_query_value_only_scrubs_known_keys`  (lines 1239–1248)

```
fn redact_sensitive_query_value_only_scrubs_known_keys()
```

**Purpose**: Checks that only known secret-like query keys are redacted. This keeps logs safe without destroying harmless debugging information.

**Data flow**: It compares the redaction result for a sensitive key such as code and a safe key such as redirect_uri against the expected strings.

**Call relations**: This test protects redact_sensitive_query_value, which is used by URL redaction before logging.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::redact_sensitive_url_parts_preserves_safe_url_shape`  (lines 1251–1263)

```
fn redact_sensitive_url_parts_preserves_safe_url_shape()
```

**Purpose**: Checks that URL redaction removes credentials, fragments, and secret query values while keeping host, path, and safe parameters readable.

**Data flow**: It parses a URL containing username, password, a code, a safe redirect_uri, and a fragment, redacts it, and asserts that only the sensitive pieces changed.

**Call relations**: This test exercises redact_sensitive_url_parts, which supports safe logging of URLs and network errors.

*Call graph*: calls 1 internal fn (redact_sensitive_url_parts); 2 external calls (assert_eq!, parse).


##### `tests::sanitize_url_for_logging_redacts_sensitive_issuer_parts`  (lines 1266–1274)

```
fn sanitize_url_for_logging_redacts_sensitive_issuer_parts()
```

**Purpose**: Checks that caller-supplied issuer URLs are cleaned before logging. This matters because non-default deployments might include credentials or query parameters.

**Data flow**: It passes a URL with embedded user credentials and a token query parameter into sanitize_url_for_logging, then asserts that the result removes credentials and redacts the token.

**Call relations**: This test covers sanitize_url_for_logging, which exchange_code_for_tokens uses in structured logs.

*Call graph*: calls 1 internal fn (sanitize_url_for_logging); 1 external calls (assert_eq!).


##### `tests::compose_success_url_omits_streamlined_success_by_default`  (lines 1277–1292)

```
fn compose_success_url_omits_streamlined_success_by_default()
```

**Purpose**: Checks that the success URL does not include the streamlined-login flag unless requested. This preserves the legacy success behavior by default.

**Data flow**: It builds a success URL with the streamlined flag set to false, parses the URL, and asserts that the codex_streamlined_login query parameter is absent.

**Call relations**: This test protects compose_success_url behavior used after successful browser login.

*Call graph*: calls 1 internal fn (compose_success_url); 2 external calls (assert_eq!, parse).


##### `tests::compose_success_url_includes_streamlined_success_when_requested`  (lines 1295–1311)

```
fn compose_success_url_includes_streamlined_success_when_requested()
```

**Purpose**: Checks that the success URL includes the streamlined-login flag when requested. This enables the newer success-page behavior only for callers that ask for it.

**Data flow**: It builds a success URL with the streamlined flag set to true, parses the URL, and asserts that codex_streamlined_login=true appears in the query.

**Call relations**: This test covers the alternate path in compose_success_url used by process_request after successful login.

*Call graph*: calls 1 internal fn (compose_success_url); 2 external calls (assert_eq!, parse).


##### `tests::render_login_error_page_escapes_dynamic_fields`  (lines 1314–1326)

```
fn render_login_error_page_escapes_dynamic_fields()
```

**Purpose**: Checks that the rendered error page escapes potentially unsafe characters. This prevents error text from becoming unintended HTML.

**Data flow**: It renders an error page with characters such as angle brackets, ampersands, and quotes, converts the bytes to text, and asserts that escaped forms appear.

**Call relations**: This test protects render_login_error_page and indirectly html_escape, which are used for browser-visible login failures.

*Call graph*: calls 1 internal fn (render_login_error_page); 2 external calls (from_utf8, assert!).


##### `tests::render_login_error_page_uses_entitlement_copy`  (lines 1329–1346)

```
fn render_login_error_page_uses_entitlement_copy()
```

**Purpose**: Checks that missing Codex access gets special, helpful wording instead of exposing the raw entitlement error. This improves the user experience for a common access problem.

**Data flow**: It confirms the entitlement detector matches the sample error, renders the error page, and asserts that administrator guidance appears while the raw missing_codex_entitlement text does not.

**Call relations**: This test covers render_login_error_page and is_missing_codex_entitlement_error, both used when OAuth returns an access_denied callback.

*Call graph*: calls 1 internal fn (render_login_error_page); 2 external calls (from_utf8, assert!).


### `tui/src/onboarding/auth/headless_chatgpt_login.rs`

`orchestration` · `onboarding sign-in flow`

This file supports a sign-in path where the terminal cannot open a normal browser login window itself, so it gives the user a web link and a short one-time code. In everyday terms, it is like a ticket machine: first it asks the server for a ticket, then it prints the ticket instructions on screen, and if the user walks away and starts over, it throws away the old ticket instead of mixing it up with the new one.

The main flow starts by creating a fresh request ID and putting the sign-in screen into a “waiting for device code” state. It then sends an asynchronous request to the app server. “Asynchronous” means the terminal can keep running while the server reply is still on the way. When the reply comes back, the file checks whether the same login attempt is still active. This matters because the user may have cancelled or restarted sign-in while waiting. If the attempt is still current, it stores the login link and code and asks the terminal UI to redraw. If the attempt is stale, it cancels that server-side login attempt.

The rendering code draws either a “requesting code” message or the ready-to-use link and code. It also highlights the URL and warns that device codes should not be shared, because they can be used for phishing.

#### Function details

##### `start_headless_chatgpt_login`  (lines 23–83)

```
fn start_headless_chatgpt_login(widget: &mut AuthModeWidget)
```

**Purpose**: Starts the ChatGPT device-code login process. It puts the UI into a waiting state, asks the app server for a browser login code, and updates the screen when the result arrives.

**Data flow**: It takes the current authentication widget, creates a fresh local request ID, and writes a pending device-code state into the shared sign-in state. It then sends a login request to the app server in a background task. If the server returns a login ID, verification URL, and user code, it tries to store them in the still-active sign-in state; if the server returns an error or an unexpected response, it records an error message and moves the UI back to mode selection. If the reply belongs to an attempt that is no longer active, it does not update the UI and instead cancels the server-side login attempt when needed.

**Call relations**: This is called when the broader sign-in code chooses to start a device-code login. It relies on the helper that builds a pending state at the beginning and the helper that builds a ready state after the server reply. Before changing shared state, it hands the request ID to the active-attempt helpers so a late server response cannot overwrite a newer login attempt. If the server created a login but the UI has moved on, it hands that login ID to the cancellation routine.

*Call graph*: calls 4 internal fn (pending, ready, set_device_code_error_for_active_attempt, set_device_code_state_for_active_attempt); called by 1 (start_device_code_login); 6 external calls (new_v4, format!, cancel_login_attempt, onboarding_request_id, spawn, ChatGptDeviceCode).


##### `render_device_code_login`  (lines 85–153)

```
fn render_device_code_login(
    widget: &AuthModeWidget,
    area: Rect,
    buf: &mut Buffer,
    state: &ContinueWithDeviceCodeState,
)
```

**Purpose**: Draws the device-code login screen in the terminal. It shows either a waiting message or the browser link and one-time code the user must enter.

**Data flow**: It reads the authentication widget for animation settings and the cancel key label, and it reads the device-code state for the verification URL and user code. If the code is ready, it builds lines explaining how to open the link, enter the code, and keep the code private; if not, it builds a short “requesting code” message. It writes those lines into the terminal buffer and, when a URL is present, marks that URL as a hyperlink-like area for the terminal UI.

**Call relations**: This is used by the authentication widget’s rendering path whenever the current sign-in state is the device-code screen. It calls the shimmer text helper only when animations are allowed, asks for another frame so the animation can continue, and delegates URL marking to the shared hyperlink helper after the text is drawn.

*Call graph*: calls 2 internal fn (shimmer_text, is_showing_copyable_auth); called by 1 (render_ref); 5 external calls (from, new, from_millis, mark_url_hyperlink, vec!).


##### `device_code_attempt_matches`  (lines 155–160)

```
fn device_code_attempt_matches(state: &SignInState, request_id: &str) -> bool
```

**Purpose**: Checks whether a sign-in state represents the same device-code attempt as a given request ID. It is the small guard that prevents old login replies from changing the current screen.

**Data flow**: It receives the current sign-in state and a request ID string. It compares the ID only if the state is a ChatGPT device-code state. It returns true when the IDs match, and false when the state is a different kind of screen or a different device-code attempt.

**Call relations**: The two state-update helpers call this before they write anything. That makes it the shared safety check used both for successful server replies and for error replies.

*Call graph*: called by 2 (set_device_code_error_for_active_attempt, set_device_code_state_for_active_attempt); 1 external calls (matches!).


##### `set_device_code_state_for_active_attempt`  (lines 162–177)

```
fn set_device_code_state_for_active_attempt(
    sign_in_state: &std::sync::Arc<std::sync::RwLock<SignInState>>,
    request_frame: &crate::tui::FrameRequester,
    request_id: &str,
    next_state: C
```

**Purpose**: Stores a new device-code sign-in state only if the login attempt is still the active one. This protects the UI from being updated by an old background task.

**Data flow**: It receives the shared sign-in state, a frame requester, the expected request ID, and the next device-code state to store. It locks the shared state for writing, checks whether the current attempt matches the request ID, and returns false without changing anything if it does not. If it matches, it replaces the state, releases the lock, asks the UI to redraw, and returns true.

**Call relations**: The background login task in start_headless_chatgpt_login uses this after a successful device-code response. It first delegates the ID check to device_code_attempt_matches, then notifies the terminal renderer by scheduling a new frame.

*Call graph*: calls 2 internal fn (device_code_attempt_matches, schedule_frame); called by 1 (start_headless_chatgpt_login); 1 external calls (ChatGptDeviceCode).


##### `set_device_code_error_for_active_attempt`  (lines 179–196)

```
fn set_device_code_error_for_active_attempt(
    sign_in_state: &std::sync::Arc<std::sync::RwLock<SignInState>>,
    request_frame: &crate::tui::FrameRequester,
    error: &std::sync::Arc<std::sync::R
```

**Purpose**: Shows an error for the current device-code login attempt, but only if that attempt is still active. It moves the user back to the sign-in choice screen when the current attempt fails.

**Data flow**: It receives the shared sign-in state, the frame requester, the shared error message slot, the expected request ID, and the error text. It locks the sign-in state, checks that the request ID still matches, and does nothing if the user has already moved on. If it matches, it changes the state back to PickMode, writes the error message into the shared error field, asks the UI to redraw, and returns true.

**Call relations**: The background login task calls this when the app server returns an error or an unexpected response. Like the success path, it depends on device_code_attempt_matches so stale failures do not disturb a newer sign-in attempt.

*Call graph*: calls 2 internal fn (device_code_attempt_matches, schedule_frame); called by 1 (start_headless_chatgpt_login).


##### `tests::pending_device_code_state`  (lines 205–209)

```
fn pending_device_code_state(request_id: &str) -> Arc<RwLock<SignInState>>
```

**Purpose**: Builds a small test-only shared sign-in state that is already waiting on a device-code attempt. It keeps the tests short and focused.

**Data flow**: It takes a request ID string and wraps a pending ChatGPT device-code state inside an Arc and RwLock. The Arc lets multiple pieces of code share ownership, and the RwLock is a lock that allows safe reading or writing from different parts of the test. It returns that ready-to-use shared state.

**Call relations**: The state-update tests call this helper to set up their starting point. It mirrors the production pending state created when a real login attempt begins.

*Call graph*: calls 1 internal fn (pending); 3 external calls (new, new, ChatGptDeviceCode).


##### `tests::device_code_attempt_matches_only_for_matching_request_id`  (lines 212–223)

```
fn device_code_attempt_matches_only_for_matching_request_id()
```

**Purpose**: Checks that the request-ID matcher is strict. It proves the helper returns true only for the exact active device-code attempt.

**Data flow**: It creates a device-code sign-in state with one request ID, then asks the matcher about the same ID, a different ID, and a completely different sign-in state. The expected results are true, false, and false.

**Call relations**: This test directly exercises device_code_attempt_matches, the guard used by both production update helpers. It exists because the rest of the file depends on this guard to avoid stale background updates.

*Call graph*: calls 1 internal fn (pending); 2 external calls (assert_eq!, ChatGptDeviceCode).


##### `tests::set_device_code_state_for_active_attempt_updates_only_when_active`  (lines 226–268)

```
fn set_device_code_state_for_active_attempt_updates_only_when_active()
```

**Purpose**: Checks that a successful device-code reply updates the state only for the matching active request. It also confirms that non-matching attempts are left untouched.

**Data flow**: It creates a dummy frame requester and a pending shared state for one request ID. It calls the success update helper with a ready state and confirms the login ID was stored. Then it creates a second pending state with a different request ID, calls the same helper using the old ID, and confirms nothing was changed.

**Call relations**: This test covers set_device_code_state_for_active_attempt, which is used by start_headless_chatgpt_login after a successful server response. The test setup uses tests::pending_device_code_state so it can focus on the before-and-after behavior.

*Call graph*: calls 1 internal fn (test_dummy); 3 external calls (assert!, assert_eq!, pending_device_code_state).


##### `tests::set_device_code_error_for_active_attempt_updates_only_when_active`  (lines 271–312)

```
fn set_device_code_error_for_active_attempt_updates_only_when_active()
```

**Purpose**: Checks that an error from the device-code login flow is shown only for the matching active request. It makes sure old errors do not knock the user out of a newer login attempt.

**Data flow**: It creates a dummy frame requester, an empty shared error slot, and a pending state for one request ID. It calls the error update helper and confirms the screen returns to PickMode and the error text is saved. Then it repeats the call against a state with a different request ID and confirms the sign-in state and error slot stay unchanged.

**Call relations**: This test covers set_device_code_error_for_active_attempt, which start_headless_chatgpt_login uses when the server returns an error or an unexpected answer. It uses the pending-state test helper to create realistic starting states.

*Call graph*: calls 1 internal fn (test_dummy); 5 external calls (new, new, assert!, assert_eq!, pending_device_code_state).


### Authentication persistence and logout
These files define the auth subsystem boundary, error surface, persisted credential formats, backend selection, specialized API-key storage, and token revocation behavior.

### `login/src/auth/error.rs`

`data_model` · `auth error reporting`

This file does not define new behavior. Instead, it re-exports two existing error types from `codex_protocol`, which is the shared protocol layer used by the project. A “re-export” means this file takes something defined elsewhere and makes it available through this crate too, like putting a commonly used tool on a more convenient shelf.

The two exposed names describe failures that can happen when the system tries to refresh an authentication token. A refresh token is a credential used to get a new access token without making the user log in again. If that process fails, `RefreshTokenFailedError` represents the overall error, while `RefreshTokenFailedReason` describes why it failed.

This matters because login-related code can depend on `login::auth::error` as its local place for these error types. Without this file, callers would need to know that the real definitions live in `codex_protocol::auth`, which leaks an internal project structure detail and makes future refactoring harder.


### `login/src/auth/mod.rs`

`orchestration` · `cross-cutting`

This file does not contain the login logic itself. Instead, it acts like a table of contents and a reception desk for the authentication area of the project. The authentication system appears to support several ways to prove identity, such as access tokens, personal access tokens, Bedrock API keys, external bearer tokens, and agent identity. Those details live in separate files so each method can stay focused.

The important job here is deciding what is internal and what is public. Lines like `mod access_token` make a sub-file part of this module, but keep it private to the authentication code unless it is re-exported. Lines like `pub mod default_client` expose a whole submodule to outside code. The `pub use ...` lines are shortcuts: they let other parts of the project import important authentication types and functions from `auth` directly, without needing to know which smaller file they came from.

Without this file, the authentication folder would be a pile of separate parts with no single entry point. Other code would either fail to find the login tools it needs or would have to know too much about the folder’s internal layout.


### `core/src/config/auth_keyring.rs`

`config` · `startup and config load`

Authentication data can be sensitive, so the app needs a clear rule for where to keep it. This file provides that rule. The key idea is the SecretAuthStorage feature flag: when it is enabled, the app uses a secrets backend, such as an operating-system keyring or secret store; when it is disabled, it uses the direct backend instead.

There are two paths because the app sometimes needs this answer at different moments. Once a full Config exists, Config::auth_keyring_backend_kind can simply ask the already-built feature system whether SecretAuthStorage is enabled. But very early during startup, the app may need to read authentication before the full configuration is ready. For that case, resolve_bootstrap_auth_keyring_backend_kind builds just enough feature information from the partially loaded TOML configuration and any managed feature requirements to make the same decision safely.

The small private helper auth_keyring_backend_kind_from_secret_auth_storage is the shared translation step. It is like a switch on a wall: if the feature is on, choose Secrets; if it is off, choose Direct. Keeping that switch in one place makes both startup and normal configuration agree.

#### Function details

##### `Config::auth_keyring_backend_kind`  (lines 11–15)

```
fn auth_keyring_backend_kind(&self) -> AuthKeyringBackendKind
```

**Purpose**: This method answers the question, “Which authentication storage backend should this fully loaded configuration use?” It is used after the main Config object already exists.

**Data flow**: It reads the Config object's feature state and checks whether the SecretAuthStorage feature is enabled. It passes that yes-or-no answer to the shared helper. The result is an AuthKeyringBackendKind value: either Secrets when secret storage is enabled, or Direct when it is not.

**Call relations**: In the normal configuration path, callers ask Config for the auth keyring backend kind. This method does not make the choice by itself; it hands the feature flag value to auth_keyring_backend_kind_from_secret_auth_storage so the same rule is shared with the early startup path.

*Call graph*: calls 1 internal fn (auth_keyring_backend_kind_from_secret_auth_storage).


##### `resolve_bootstrap_auth_keyring_backend_kind`  (lines 22–45)

```
fn resolve_bootstrap_auth_keyring_backend_kind(
    bootstrap_config: &ConfigTomlLoadResult,
) -> std::io::Result<AuthKeyringBackendKind>
```

**Purpose**: This function decides the auth storage backend before the full Config has been built. It exists because startup may need to read authentication very early, before all managed cloud or feature requirements are fully loaded.

**Data flow**: It receives a partially loaded bootstrap configuration. From that, it reads feature settings in the TOML file, combines them with default feature sources and default overrides, then applies managed feature requirements from the configuration layer stack. If that setup succeeds, it checks whether SecretAuthStorage is enabled and converts that into Secrets or Direct. If applying the managed requirements fails, it returns an I/O error instead of a backend choice.

**Call relations**: During early startup, code that needs authentication can call this function before a full Config exists. It builds a temporary feature view using from_sources and from_configured, then hands the final enabled-or-disabled answer to auth_keyring_backend_kind_from_secret_auth_storage, matching the same decision used later by Config::auth_keyring_backend_kind.

*Call graph*: calls 3 internal fn (auth_keyring_backend_kind_from_secret_auth_storage, from_configured, from_sources); 2 external calls (default, default).


##### `auth_keyring_backend_kind_from_secret_auth_storage`  (lines 47–55)

```
fn auth_keyring_backend_kind_from_secret_auth_storage(
    secret_auth_storage_enabled: bool,
) -> AuthKeyringBackendKind
```

**Purpose**: This private helper turns one simple boolean into the concrete backend choice for authentication storage. It keeps the rule in one place so startup and normal configuration cannot accidentally disagree.

**Data flow**: It takes one input: whether SecretAuthStorage is enabled. If the input is true, it returns AuthKeyringBackendKind::Secrets. If the input is false, it returns AuthKeyringBackendKind::Direct. It does not read or change anything else.

**Call relations**: Both Config::auth_keyring_backend_kind and resolve_bootstrap_auth_keyring_backend_kind call this helper after they have figured out whether the feature is enabled. The helper is the final shared decision point that turns feature state into the backend the rest of the auth system will use.

*Call graph*: called by 2 (auth_keyring_backend_kind, resolve_bootstrap_auth_keyring_backend_kind).


### `keyring-store/src/lib.rs`

`io_transport` · `cross-cutting`

Many applications need to keep tokens or passwords somewhere safer than a plain text file. This file wraps the system keyring, which is the password vault provided by the operating system, behind a small `KeyringStore` trait. The rest of the project can ask to load, save, or delete a credential by service name and account name without caring whether the real macOS, Windows, or Linux keyring is underneath.

`DefaultKeyringStore` is the real implementation. It creates a keyring entry, then asks the `keyring` library to get, set, or remove the password. A missing password is not treated as a crash-level error: loading returns `None`, and deleting returns `false`. Other keyring failures are wrapped in `CredentialStoreError`, so callers see one project-level error type instead of raw library details.

The file also includes `tests::MockKeyringStore`, an in-memory stand-in used by tests. It keeps fake credentials in a shared map protected by a mutex, which is a lock that stops two tasks changing the same map at the same time. This lets tests check saved values, force errors, and delete entries predictably.

#### Function details

##### `CredentialStoreError::new`  (lines 14–16)

```
fn new(error: KeyringError) -> Self
```

**Purpose**: Wraps an error from the underlying keyring library in the project’s own credential-store error type. This gives callers a consistent error shape even though the real failure came from an outside library.

**Data flow**: It receives a `KeyringError` from the keyring library. It places that error inside `CredentialStoreError::Other`. The result is returned to the caller as the project-level error value.

**Call relations**: The real store calls this when creating, reading, saving, or deleting a keyring entry fails. The mock store also calls it when its fake credential is configured to return an error, so tests see the same kind of error as production code.

*Call graph*: called by 5 (delete, load, save, delete, load); 1 external calls (Other).


##### `CredentialStoreError::message`  (lines 18–22)

```
fn message(&self) -> String
```

**Purpose**: Turns the stored credential error into a plain string message. This is useful when code wants text to show, log, or compare instead of the structured error value.

**Data flow**: It reads the error currently held inside `CredentialStoreError`. It asks that inner error for its text form. It returns that text as a new `String`.

**Call relations**: This is a convenience method for any caller that has a `CredentialStoreError` and needs human-readable text. It does not call into the keyring itself or change any stored credential.


##### `CredentialStoreError::into_error`  (lines 24–28)

```
fn into_error(self) -> KeyringError
```

**Purpose**: Extracts the original keyring-library error from the wrapper. This is useful when a caller needs the exact lower-level error rather than the project’s general wrapper.

**Data flow**: It takes ownership of a `CredentialStoreError`. It opens the wrapper and moves out the contained `KeyringError`. The wrapper is consumed, and the raw keyring error is returned.

**Call relations**: This sits at the boundary between project code and the outside keyring library. Code that needs to inspect or pass along the original keyring failure can use it after an operation has returned `CredentialStoreError`.


##### `CredentialStoreError::fmt`  (lines 32–36)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how `CredentialStoreError` appears when formatted as text, such as in logs or error messages. It delegates to the wrapped keyring error so the original explanation is preserved.

**Data flow**: It receives the error and a formatter, which is Rust’s object for writing formatted text. It writes the inner keyring error’s message into that formatter. The result tells Rust whether formatting succeeded.

**Call relations**: Rust calls this automatically through the `Display` implementation whenever the error is printed with normal user-facing formatting. It supports the broader error behavior of this file without touching the keyring.

*Call graph*: 1 external calls (write!).


##### `DefaultKeyringStore::load`  (lines 52–69)

```
fn load(&self, service: &str, account: &str) -> Result<Option<String>, CredentialStoreError>
```

**Purpose**: Looks up a saved secret in the real operating-system keyring. It distinguishes between “there is no saved secret” and “something went wrong while asking the keyring.”

**Data flow**: It receives a service name and account name, which together identify the credential. It creates a keyring entry for that pair and asks for the password. It returns `Ok(Some(password))` when found, `Ok(None)` when the entry does not exist, or `Err(CredentialStoreError)` for other failures.

**Call relations**: This is the production implementation of the `KeyringStore` load operation. Callers use it when they need an existing token or password; it hands low-level keyring failures to `CredentialStoreError::new` and records trace logs around the attempt.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, trace!).


##### `DefaultKeyringStore::save`  (lines 71–87)

```
fn save(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialStoreError>
```

**Purpose**: Stores or updates a secret in the real operating-system keyring. It lets the rest of the project save credentials without knowing the platform-specific details.

**Data flow**: It receives a service name, account name, and secret value. It creates the matching keyring entry and asks the keyring library to store the password. It returns success when the value is saved, or a `CredentialStoreError` if entry creation or saving fails.

**Call relations**: This is the production implementation of the `KeyringStore` save operation. Code that obtains a new credential calls this to persist it; any lower-level keyring error is wrapped with `CredentialStoreError::new`, and trace logs mark start, success, or failure.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, trace!).


##### `DefaultKeyringStore::delete`  (lines 89–106)

```
fn delete(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError>
```

**Purpose**: Removes a saved secret from the real operating-system keyring. It reports whether anything was actually removed.

**Data flow**: It receives a service name and account name. It creates the matching keyring entry and asks the keyring library to delete the credential. It returns `Ok(true)` if deletion happened, `Ok(false)` if there was no entry, or `Err(CredentialStoreError)` for other failures.

**Call relations**: This is the production implementation of the `KeyringStore` delete operation. Callers use it during sign-out, credential reset, or cleanup; it wraps real keyring errors through `CredentialStoreError::new` and logs the outcome at trace level.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, trace!).


##### `tests::MockKeyringStore::credential`  (lines 126–135)

```
fn credential(&self, account: &str) -> Arc<MockCredential>
```

**Purpose**: Gets the fake credential object for an account, creating it if it does not already exist. Tests use this as the doorway to the mock store’s per-account credential state.

**Data flow**: It receives an account name. It locks the shared in-memory map, looks for that account, and inserts a new default mock credential if needed. It returns a shared reference-counted pointer to the mock credential.

**Call relations**: The mock store’s `save` method calls this before writing a fake password, and `set_error` calls it before forcing an error. It keeps all mock credentials in one shared map so cloned mock stores see the same test data.

*Call graph*: called by 2 (save, set_error).


##### `tests::MockKeyringStore::saved_value`  (lines 137–146)

```
fn saved_value(&self, account: &str) -> Option<String>
```

**Purpose**: Lets a test inspect what password is currently saved for an account in the mock store. This is a test helper for checking that save logic wrote the expected value.

**Data flow**: It receives an account name. It locks the map long enough to find the fake credential, then asks that credential for its password. It returns `Some(value)` if a password can be read, or `None` if the account is missing or reading fails.

**Call relations**: Tests call this after exercising code that should save credentials. It reads from the same mock credential objects used by the mock `load`, `save`, and `delete` methods, but it does not change them.


##### `tests::MockKeyringStore::set_error`  (lines 148–151)

```
fn set_error(&self, account: &str, error: KeyringError)
```

**Purpose**: Configures a fake credential to return a specific keyring error. Tests use this to check how higher-level code behaves when the credential store fails.

**Data flow**: It receives an account name and a keyring error. It gets or creates the account’s fake credential, then stores the error setting inside that mock credential. Afterward, operations on that credential can produce the configured failure.

**Call relations**: This helper calls `tests::MockKeyringStore::credential` to find the right fake credential. It is used by tests before calling load, save, or delete paths that need to experience an error without depending on a real broken system keyring.

*Call graph*: calls 1 internal fn (credential).


##### `tests::MockKeyringStore::contains`  (lines 153–159)

```
fn contains(&self, account: &str) -> bool
```

**Purpose**: Checks whether the mock store currently has a credential object for an account. Tests can use it to verify that an account entry was created or removed.

**Data flow**: It receives an account name. It locks the shared map and checks whether that account key exists. It returns `true` if the account is present and `false` otherwise.

**Call relations**: This is a test inspection helper. It observes the same in-memory map changed by the mock `credential`, `save`, and `delete` methods, but it does not call the real keyring or alter stored data.


##### `tests::MockKeyringStore::load`  (lines 163–185)

```
fn load(
            &self,
            _service: &str,
            account: &str,
        ) -> Result<Option<String>, CredentialStoreError>
```

**Purpose**: Imitates loading a secret from the keyring for tests. It follows the same outward behavior as the real store: found values become `Some`, missing entries become `None`, and other failures become `CredentialStoreError`.

**Data flow**: It receives a service name, which the mock ignores, and an account name. It looks up the account in the in-memory map. If no fake credential exists it returns `Ok(None)`; otherwise it asks the fake credential for its password and converts the result into success, absence, or error.

**Call relations**: This is the mock implementation of the `KeyringStore` load operation. Test code can pass `MockKeyringStore` anywhere a `KeyringStore` is expected, and this method mirrors `DefaultKeyringStore::load` closely enough for higher-level behavior to be tested.

*Call graph*: calls 1 internal fn (new).


##### `tests::MockKeyringStore::save`  (lines 187–197)

```
fn save(
            &self,
            _service: &str,
            account: &str,
            value: &str,
        ) -> Result<(), CredentialStoreError>
```

**Purpose**: Imitates saving a secret to the keyring for tests. It writes into the mock credential map instead of the operating system’s password vault.

**Data flow**: It receives a service name, which the mock ignores, an account name, and a value. It gets or creates the fake credential for that account and asks it to store the password. It returns success or wraps any mock keyring error as `CredentialStoreError`.

**Call relations**: This is the mock implementation of the `KeyringStore` save operation. It calls `tests::MockKeyringStore::credential` to get the account’s fake storage, allowing tests to later inspect the result with `saved_value` or load it through the trait.

*Call graph*: calls 1 internal fn (credential).


##### `tests::MockKeyringStore::delete`  (lines 199–224)

```
fn delete(&self, _service: &str, account: &str) -> Result<bool, CredentialStoreError>
```

**Purpose**: Imitates deleting a secret from the keyring for tests. It reports whether a credential was present and removes the account from the mock’s in-memory map after a successful delete-like operation.

**Data flow**: It receives a service name, which the mock ignores, and an account name. It looks up the fake credential; if none exists, it returns `Ok(false)`. If one exists, it asks the fake credential to delete its password, converts no-entry into `false` and other errors into `CredentialStoreError`, then removes the account from the map and returns whether deletion occurred.

**Call relations**: This is the mock implementation of the `KeyringStore` delete operation. It mirrors the production delete behavior closely, including the difference between missing credentials and real errors, so tests can exercise cleanup paths without touching the real keyring.

*Call graph*: calls 1 internal fn (new).


### `login/src/auth/storage.rs`

`io_transport` · `auth load/save/logout`

Logging in produces sensitive information such as API keys, OAuth tokens, personal access tokens, and agent identity data. This file gives the rest of the login system one simple shape for saving, loading, and deleting that information, while hiding the details of the storage place. Without it, each login and logout path would need to know how to read files, talk to keyrings, clean up old fallback files, and recover when safer storage is unavailable.

The central data shape is AuthDotJson, which matches the auth.json file under CODEX_HOME. It can hold several kinds of credentials, plus metadata such as the last refresh time and auth mode. The AuthStorageBackend trait is the common contract: load, save, and delete.

There are several backends. FileAuthStorage writes readable JSON to disk, with restrictive file permissions on Unix. DirectKeyringAuthStorage stores the same JSON string in the system keyring, using a short hashed key derived from CODEX_HOME so different Codex homes do not collide. SecretsKeyringAuthStorage stores auth through the project’s encrypted secrets system and also deletes older direct-keyring entries during cleanup. AutoAuthStorage tries keyring storage first and falls back to the file if needed, like trying a safe before using a locked drawer. EphemeralAuthStorage keeps credentials only in a process-wide memory map, useful when nothing should persist after the process exits.

#### Function details

##### `AgentIdentityAuthRecord::from_agent_identity_jwt`  (lines 75–80)

```
fn from_agent_identity_jwt(jwt: &str) -> std::io::Result<Self>
```

**Purpose**: This turns an agent identity JWT into the smaller auth record Codex stores. A JWT is a signed token containing claims, or facts, about an identity.

**Data flow**: It receives the JWT text, asks the agent identity library to decode and check it, then converts the decoded claims into an AgentIdentityAuthRecord. If decoding fails, it returns an input/output style error instead of a record.

**Call relations**: When verified_agent_identity_record needs stored agent identity details, it calls this function first. This function hands the hard part, token decoding, to decode_agent_identity_jwt, then returns a storage-friendly record.

*Call graph*: called by 1 (verified_agent_identity_record); 1 external calls (decode_agent_identity_jwt).


##### `AgentIdentityAuthRecord::from`  (lines 84–94)

```
fn from(claims: AgentIdentityJwtClaims) -> Self
```

**Purpose**: This copies decoded agent identity claims into the storage record format. It exists so the decoded token type can be converted cleanly into the type saved by the auth system.

**Data flow**: It receives AgentIdentityJwtClaims with runtime, key, account, user, email, plan, and FedRAMP information. It moves those values into a new AgentIdentityAuthRecord and converts the plan type to the account plan type used by this auth layer.

**Call relations**: It is the conversion step used after a JWT has already been decoded. AgentIdentityAuthRecord::from_agent_identity_jwt relies on this conversion so decoding and record-building stay separate.


##### `get_auth_file`  (lines 97–99)

```
fn get_auth_file(codex_home: &Path) -> PathBuf
```

**Purpose**: This builds the path to the auth.json file inside a Codex home directory. It gives every file-based operation one shared definition of where credentials are stored on disk.

**Data flow**: It receives the CODEX_HOME path and appends auth.json to it. The output is the full file path used for reading, writing, or deleting disk auth data.

**Call relations**: FileAuthStorage uses this whenever it loads or saves. Delete helpers and logout-related paths also depend on it so they all point at the same auth file.

*Call graph*: called by 5 (logout_removes_auth_file, write_auth_file, load, save, delete_file_if_exists); 1 external calls (join).


##### `delete_file_if_exists`  (lines 101–108)

```
fn delete_file_if_exists(codex_home: &Path) -> std::io::Result<bool>
```

**Purpose**: This removes auth.json if it is present, and treats an already-missing file as a normal result. That makes logout and keyring migration safe to run more than once.

**Data flow**: It receives CODEX_HOME, turns it into an auth.json path, and tries to remove that file. It returns true if a file was removed, false if there was no file, or an error for other failures such as permissions problems.

**Call relations**: Storage backends call this during delete operations and after saving to keyring-based storage. It uses get_auth_file so it deletes the same file that FileAuthStorage would read or write.

*Call graph*: calls 1 internal fn (get_auth_file); called by 5 (delete, save, delete, delete, save); 1 external calls (remove_file).


##### `FileAuthStorage::new`  (lines 122–124)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: This creates a file-based auth storage object for one Codex home directory. Use it when credentials should be stored in CODEX_HOME/auth.json.

**Data flow**: It receives a CODEX_HOME path and keeps it inside a FileAuthStorage value. Nothing is read or written yet; it only prepares the storage object for later load, save, or delete calls.

**Call relations**: Login, logout, tests, AutoAuthStorage, and the storage factory create this when file storage is requested or needed as a fallback.

*Call graph*: called by 15 (login_with_access_token_writes_only_personal_access_token, login_with_access_token_writes_only_token, login_with_api_key_overwrites_existing_auth_json, bedrock_only_auth_storage_creates_primary_auth, login_with_api_key_clears_bedrock_api_key, login_with_bedrock_api_key_replaces_openai_auth, logout_removes_bedrock_auth, new, create_auth_storage_with_store, file_storage_delete_removes_auth_file (+5 more)).


##### `FileAuthStorage::try_read_auth_json`  (lines 128–135)

```
fn try_read_auth_json(&self, auth_file: &Path) -> std::io::Result<AuthDotJson>
```

**Purpose**: This reads and parses an auth.json file into the in-memory auth structure. It is the low-level file reader for file-based login state.

**Data flow**: It receives a path, opens the file, reads all text, and parses the JSON into AuthDotJson. On success it returns the parsed credentials; bad JSON, missing files, or read errors become errors.

**Call relations**: FileAuthStorage::load calls this after it has found the expected auth.json path. Keeping this separate lets load decide which errors mean 'not logged in' and which should be reported.

*Call graph*: called by 1 (load); 3 external calls (open, new, from_str).


##### `FileAuthStorage::load`  (lines 139–147)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: This loads credentials from CODEX_HOME/auth.json. If the file is missing, it reports that no saved auth exists instead of failing.

**Data flow**: It builds the auth.json path, asks try_read_auth_json to read and parse it, and returns either Some(auth) or None. Other read or parse errors are passed back to the caller.

**Call relations**: This is the file backend’s implementation of the shared load operation. AutoAuthStorage uses it when keyring storage is empty or unavailable.

*Call graph*: calls 2 internal fn (try_read_auth_json, get_auth_file).


##### `FileAuthStorage::save`  (lines 149–166)

```
fn save(&self, auth_dot_json: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: This writes the current auth information to CODEX_HOME/auth.json. It creates the directory if needed and writes pretty JSON so the file is readable.

**Data flow**: It receives an AuthDotJson value, builds the destination path, creates parent folders, serializes the auth data as formatted JSON, opens the file for replacement, writes the bytes, and flushes them to disk.

**Call relations**: This is the file backend’s save operation. AutoAuthStorage calls it as a fallback when keyring saving fails, and direct file mode uses it as the primary save path.

*Call graph*: calls 1 internal fn (get_auth_file); 3 external calls (new, to_string_pretty, create_dir_all).


##### `FileAuthStorage::delete`  (lines 168–170)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: This deletes the disk auth file for file-based storage. It is used during logout or cleanup.

**Data flow**: It uses the stored CODEX_HOME path and delegates to delete_file_if_exists. The result says whether a file was actually removed.

**Call relations**: This is the file backend’s delete operation. It keeps file deletion behavior consistent with the cleanup done by keyring-based backends.

*Call graph*: calls 1 internal fn (delete_file_if_exists).


##### `compute_store_key`  (lines 181–192)

```
fn compute_store_key(codex_home: &Path) -> std::io::Result<String>
```

**Purpose**: This creates a short, stable key name for storing credentials outside the auth.json file. The key is based on CODEX_HOME so separate Codex homes get separate stored credentials.

**Data flow**: It receives a path, tries to turn it into a canonical absolute path, hashes that path with SHA-256, keeps a short prefix of the hash, and returns a string like cli|abc123. The original path is not stored directly.

**Call relations**: Keyring and in-memory storage call this before load, save, or delete. It is the shared naming rule that prevents different workspaces from overwriting each other’s credentials.

*Call graph*: called by 4 (delete, load, save, with_store); 3 external calls (canonicalize, new, format!).


##### `DirectKeyringAuthStorage::new`  (lines 201–206)

```
fn new(codex_home: PathBuf, keyring_store: Arc<dyn KeyringStore>) -> Self
```

**Purpose**: This creates a storage object that talks directly to a keyring. A keyring is the operating system or platform-backed secure place for secrets.

**Data flow**: It receives CODEX_HOME and a keyring store object, then keeps both for later use. It does not contact the keyring during construction.

**Call relations**: The keyring storage factory uses this for direct keyring mode. SecretsKeyringAuthStorage also creates one so it can delete older direct-keyring entries during cleanup.

*Call graph*: called by 5 (new, create_keyring_auth_storage, direct_keyring_auth_storage_delete_removes_keyring_and_file, direct_keyring_auth_storage_saves_legacy_keyring_entry, secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry).


##### `DirectKeyringAuthStorage::load_from_keyring`  (lines 208–221)

```
fn load_from_keyring(&self, key: &str) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: This reads serialized auth data from the keyring and turns it back into AuthDotJson. It is the direct keyring backend’s low-level read step.

**Data flow**: It receives a key string, asks the keyring store for the value under the Codex Auth service, and parses the returned JSON if one exists. It returns Some(auth), None, or a clear error message if loading or parsing fails.

**Call relations**: DirectKeyringAuthStorage::load computes the right key and then calls this function. This function hands storage access to the keyring store and handles JSON decoding locally.

*Call graph*: called by 1 (load); 3 external calls (other, format!, from_str).


##### `DirectKeyringAuthStorage::save_to_keyring`  (lines 223–235)

```
fn save_to_keyring(&self, key: &str, value: &str) -> std::io::Result<()>
```

**Purpose**: This writes a serialized auth string into the keyring. It also logs a warning if the secure write fails.

**Data flow**: It receives a key and a JSON string, asks the keyring store to save that value under the Codex Auth service, and returns success or an input/output error. On failure it includes the keyring’s message in the error.

**Call relations**: DirectKeyringAuthStorage::save serializes AuthDotJson first, then calls this function. This separates JSON creation from the actual keyring write.

*Call graph*: called by 1 (save); 3 external calls (other, format!, warn!).


##### `DirectKeyringAuthStorage::load`  (lines 239–242)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: This loads auth data from direct keyring storage for this CODEX_HOME. It is the standard load entry for the direct keyring backend.

**Data flow**: It computes the storage key from CODEX_HOME, then asks load_from_keyring to read and parse the stored JSON. The output is optional auth data or an error.

**Call relations**: AutoAuthStorage and keyring mode call this through the AuthStorageBackend trait. It first uses compute_store_key so the keyring lookup is scoped to the right Codex home.

*Call graph*: calls 2 internal fn (load_from_keyring, compute_store_key).


##### `DirectKeyringAuthStorage::save`  (lines 244–253)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: This saves auth data into the direct keyring and removes the old auth.json fallback file if possible. That helps move credentials away from plain disk storage.

**Data flow**: It computes the key, serializes AuthDotJson to compact JSON, writes it to the keyring, then tries to delete CODEX_HOME/auth.json. If deleting the fallback file fails, it warns but still treats the keyring save as successful.

**Call relations**: AutoAuthStorage and keyring mode call this through the shared storage interface. It delegates the actual write to save_to_keyring and cleanup to delete_file_if_exists.

*Call graph*: calls 3 internal fn (save_to_keyring, compute_store_key, delete_file_if_exists); 2 external calls (to_string, warn!).


##### `DirectKeyringAuthStorage::delete`  (lines 255–265)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: This removes auth data from both the direct keyring and the old auth.json file. It is used for logout and cleanup.

**Data flow**: It computes the key, asks the keyring store to delete that entry, then deletes the auth.json file if present. It returns true if either place actually contained data that was removed.

**Call relations**: SecretsKeyringAuthStorage::delete calls this to remove legacy direct-keyring data. Direct keyring mode and auto keyring cleanup also use it as the backend delete behavior.

*Call graph*: calls 2 internal fn (compute_store_key, delete_file_if_exists); called by 1 (delete).


##### `SecretsKeyringAuthStorage::fmt`  (lines 276–280)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This defines how the secrets-based storage object appears in debug logs. It intentionally avoids printing sensitive internal details.

**Data flow**: It receives a formatter and writes a debug structure containing CODEX_HOME while leaving the rest non-exhaustive. It returns the formatting result.

**Call relations**: Rust’s debug printing calls this automatically when this storage type is formatted. It supports diagnostics without exposing the secrets manager contents.

*Call graph*: 1 external calls (debug_struct).


##### `SecretsKeyringAuthStorage::new`  (lines 284–298)

```
fn new(codex_home: PathBuf, keyring_store: Arc<dyn KeyringStore>) -> Self
```

**Purpose**: This creates the encrypted-secrets auth storage backend. It also creates a direct keyring helper so old direct-keyring credentials can be cleaned up later.

**Data flow**: It receives CODEX_HOME and a keyring store, builds a DirectKeyringAuthStorage, builds a SecretsManager configured for the Codex auth namespace, and returns a SecretsKeyringAuthStorage containing those pieces.

**Call relations**: The keyring storage factory calls this when the configured keyring backend is Secrets. Tests also construct it directly to verify save, load, and legacy cleanup behavior.

*Call graph*: calls 2 internal fn (new, new_with_keyring_store_and_namespace); called by 5 (create_keyring_auth_storage, secrets_keyring_auth_storage_delete_removes_keyring_and_file, secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry, secrets_keyring_auth_storage_load_returns_deserialized_auth, secrets_keyring_auth_storage_save_persists_and_removes_fallback_file); 2 external calls (clone, clone).


##### `SecretsKeyringAuthStorage::load`  (lines 302–318)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: This loads auth data from the encrypted local secrets system. It is the read path for the newer secrets-backed keyring mode.

**Data flow**: It asks the secrets manager for the global CODEX_AUTH secret. If a value exists, it parses the JSON into AuthDotJson; if not, it returns None. Storage or parse failures become readable input/output errors.

**Call relations**: AutoAuthStorage or explicit keyring mode call this through the shared storage interface. It relies on the secrets manager for encrypted storage and handles only auth-specific JSON parsing.

*Call graph*: calls 1 internal fn (get); 1 external calls (from_str).


##### `SecretsKeyringAuthStorage::save`  (lines 320–334)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: This saves auth data into encrypted local secrets and removes any old auth.json fallback file. It keeps credentials out of plain JSON on disk when secure storage is available.

**Data flow**: It serializes AuthDotJson into JSON, stores it as the global CODEX_AUTH secret, and then tries to remove CODEX_HOME/auth.json. If secret storage fails, it logs and returns an error; if only fallback cleanup fails, it logs a warning and continues.

**Call relations**: AutoAuthStorage and keyring mode call this through the backend trait. It hands secure persistence to the secrets manager and file cleanup to delete_file_if_exists.

*Call graph*: calls 2 internal fn (delete_file_if_exists, set); 2 external calls (to_string, warn!).


##### `SecretsKeyringAuthStorage::delete`  (lines 336–348)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: This removes auth data from encrypted secrets, the auth.json fallback file, and older direct-keyring storage. It is a broad cleanup path for logout.

**Data flow**: It deletes the global CODEX_AUTH secret, deletes CODEX_HOME/auth.json if present, then asks the direct keyring helper to delete any legacy entry. It returns true if any of those locations had data to remove.

**Call relations**: AutoAuthStorage can call this when secrets keyring storage is selected. It coordinates the secrets manager, file cleanup helper, and DirectKeyringAuthStorage::delete so logout does not leave old credentials behind.

*Call graph*: calls 3 internal fn (delete, delete_file_if_exists, delete).


##### `AutoAuthStorage::new`  (lines 358–371)

```
fn new(
        codex_home: PathBuf,
        keyring_store: Arc<dyn KeyringStore>,
        keyring_backend_kind: AuthKeyringBackendKind,
    ) -> Self
```

**Purpose**: This creates a storage backend that prefers secure keyring-style storage but keeps file storage available as a fallback. It is used for the automatic storage mode.

**Data flow**: It receives CODEX_HOME, a keyring store, and the chosen keyring backend kind. It builds one keyring-backed storage object and one file-backed storage object, then returns an AutoAuthStorage containing both.

**Call relations**: create_auth_storage_with_store calls this when configuration asks for Auto mode. AutoAuthStorage later chooses between the two backends at load and save time.

*Call graph*: calls 2 internal fn (new, create_keyring_auth_storage); called by 7 (create_auth_storage_with_store, auto_auth_storage_delete_removes_keyring_and_file, auto_auth_storage_load_falls_back_when_keyring_errors, auto_auth_storage_load_prefers_keyring_value, auto_auth_storage_load_uses_file_when_keyring_empty, auto_auth_storage_save_falls_back_when_keyring_errors, auto_auth_storage_save_prefers_keyring); 2 external calls (new, clone).


##### `AutoAuthStorage::load`  (lines 375–384)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: This loads auth by trying keyring storage first and falling back to auth.json if needed. It makes secure storage the first choice without locking users out when the keyring is unavailable.

**Data flow**: It asks the keyring backend for auth data. If keyring returns data, that data is returned; if keyring is empty, it reads from file storage; if keyring errors, it logs a warning and then tries file storage.

**Call relations**: Callers use this through the AuthStorageBackend trait in Auto mode. It coordinates keyring_storage and file_storage like a primary route and backup route.

*Call graph*: 1 external calls (warn!).


##### `AutoAuthStorage::save`  (lines 386–394)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: This saves auth to keyring storage when possible, but falls back to auth.json if keyring saving fails. That gives users a working login even on systems where keyring access is broken.

**Data flow**: It receives AuthDotJson and asks the keyring backend to save it. If that succeeds, it returns success; if it fails, it logs a warning and writes the same auth data through FileAuthStorage.

**Call relations**: Callers use this through the shared backend interface in Auto mode. It delegates the actual storage work to either the keyring backend or the file backend depending on success.

*Call graph*: 1 external calls (warn!).


##### `AutoAuthStorage::delete`  (lines 396–399)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: This deletes credentials using the keyring backend’s delete behavior. The selected keyring backend is expected to also remove disk fallback files.

**Data flow**: It receives no extra input beyond the storage object itself and forwards the delete request to keyring_storage. The result says whether anything was removed.

**Call relations**: Logout paths call this through the AuthStorageBackend trait in Auto mode. The function trusts the keyring backend to perform full cleanup, including auth.json where appropriate.


##### `EphemeralAuthStorage::new`  (lines 412–414)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: This creates an in-memory auth storage object for one CODEX_HOME. It is used when credentials should not be written to disk or keyring.

**Data flow**: It receives CODEX_HOME and stores that path in an EphemeralAuthStorage value. No global memory entry is created until save is called.

**Call relations**: create_auth_storage_with_store calls this when configuration selects Ephemeral mode. Later operations use the stored CODEX_HOME to find the right memory entry.

*Call graph*: called by 1 (create_auth_storage_with_store).


##### `EphemeralAuthStorage::with_store`  (lines 416–425)

```
fn with_store(&self, action: F) -> std::io::Result<T>
```

**Purpose**: This is a small helper that safely opens the shared in-memory auth map and runs one action on it. A mutex, meaning a lock that lets only one task touch the map at a time, prevents races.

**Data flow**: It computes the store key for CODEX_HOME, locks the global memory map, and gives both the map and key to a caller-provided action. It returns whatever that action returns, or an error if the key cannot be made or the lock fails.

**Call relations**: EphemeralAuthStorage::load, save, and delete all use this helper. It centralizes key creation and locking so each operation can focus on its simple map change.

*Call graph*: calls 1 internal fn (compute_store_key); called by 3 (delete, load, save).


##### `EphemeralAuthStorage::load`  (lines 429–431)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: This reads auth data from the process-wide memory store. It returns nothing if this Codex home has not saved auth during the current process.

**Data flow**: It opens the memory store through with_store, looks up the computed key, clones the saved AuthDotJson if present, and returns it as an optional value.

**Call relations**: Callers use this through the AuthStorageBackend trait in Ephemeral mode. It relies on with_store for safe access to the shared map.

*Call graph*: calls 1 internal fn (with_store).


##### `EphemeralAuthStorage::save`  (lines 433–438)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: This saves auth data only in memory. The data disappears when the process ends, which is useful for temporary or test-like sessions.

**Data flow**: It opens the memory store through with_store, clones the supplied AuthDotJson, and inserts it under the key for this CODEX_HOME. It returns success after the map is updated.

**Call relations**: Callers use this through the shared backend interface in Ephemeral mode. It delegates locking and key creation to with_store.

*Call graph*: calls 1 internal fn (with_store).


##### `EphemeralAuthStorage::delete`  (lines 440–442)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: This removes auth data from the in-memory store for this CODEX_HOME. It is the ephemeral-mode cleanup operation.

**Data flow**: It opens the memory store through with_store, removes the entry for the computed key, and returns true if an entry was present.

**Call relations**: Logout or cleanup code calls this through the AuthStorageBackend trait in Ephemeral mode. It uses with_store so removal is safe even if other code is accessing the shared map.

*Call graph*: calls 1 internal fn (with_store).


##### `create_auth_storage`  (lines 445–452)

```
fn create_auth_storage(
    codex_home: PathBuf,
    mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Arc<dyn AuthStorageBackend>
```

**Purpose**: This is the main factory for auth storage. Given the user’s configured storage mode, it returns an object that knows how to load, save, and delete credentials.

**Data flow**: It receives CODEX_HOME, the desired credential storage mode, and the desired keyring backend kind. It creates the default keyring store and passes everything to create_auth_storage_with_store, returning the chosen backend behind a shared pointer.

**Call relations**: Higher-level auth code such as load_auth, save_auth, logout, and testing helpers call this instead of constructing backends themselves. It hides the storage-choice details from the rest of the login system.

*Call graph*: calls 1 internal fn (create_auth_storage_with_store); called by 6 (create_dummy_chatgpt_auth_for_testing, from_auth_dot_json, load_auth, load_auth_dot_json, logout, save_auth); 1 external calls (new).


##### `create_auth_storage_with_store`  (lines 454–472)

```
fn create_auth_storage_with_store(
    codex_home: PathBuf,
    mode: AuthCredentialsStoreMode,
    keyring_store: Arc<dyn KeyringStore>,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Arc<dyn
```

**Purpose**: This chooses the concrete storage backend when a keyring store has already been provided. It is useful for normal setup and for tests that inject a fake keyring.

**Data flow**: It receives CODEX_HOME, storage mode, a keyring store, and keyring backend kind. It matches the mode and returns file storage, keyring storage, auto storage, or ephemeral storage wrapped as the common AuthStorageBackend interface.

**Call relations**: create_auth_storage calls this after creating the default keyring store. It calls create_keyring_auth_storage for keyring-based modes and directly constructs the file, auto, or ephemeral backends as needed.

*Call graph*: calls 4 internal fn (new, new, new, create_keyring_auth_storage); called by 1 (create_auth_storage); 1 external calls (new).


##### `create_keyring_auth_storage`  (lines 474–487)

```
fn create_keyring_auth_storage(
    codex_home: PathBuf,
    keyring_store: Arc<dyn KeyringStore>,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Arc<dyn AuthStorageBackend>
```

**Purpose**: This chooses which keyring-style backend to use: direct keyring storage or the encrypted secrets system. It keeps that choice in one place.

**Data flow**: It receives CODEX_HOME, a keyring store, and the configured backend kind. It returns either DirectKeyringAuthStorage or SecretsKeyringAuthStorage behind the shared backend interface.

**Call relations**: AutoAuthStorage::new and create_auth_storage_with_store call this whenever keyring storage is part of the chosen mode. It is the branch point between the older direct keyring path and the secrets-backed path.

*Call graph*: calls 2 internal fn (new, new); called by 2 (new, create_auth_storage_with_store); 1 external calls (new).


### `login/src/auth/bedrock_api_key.rs`

`domain_logic` · `login setup`

This file is for the moment when a user chooses to authenticate with an Amazon Bedrock API key. In plain terms, it takes the key and AWS region the user provided and turns them into the one saved login record Codex should remember.

The main data shape here is `BedrockApiKeyAuth`, which stores two pieces of information: the API key itself and the Amazon region it belongs to. The file then creates an `AuthDotJson` value, which represents the contents of Codex’s `auth.json` file. It deliberately fills in only the Bedrock-related fields and clears the other login choices, such as OpenAI tokens or personal access tokens. This matters because authentication needs to be unambiguous: Codex should know which door key to use, rather than finding several different keys in the same drawer.

The actual writing is handed off to the shared `save_auth` helper. That helper decides how to persist the credentials based on the chosen storage mode and keyring backend. A keyring is the operating system’s secure password store, like a locked cabinet for secrets. Without this file, Codex would not have a focused path for saving Bedrock API key credentials in the same format as the rest of its authentication system.

#### Function details

##### `login_with_bedrock_api_key`  (lines 20–45)

```
fn login_with_bedrock_api_key(
    codex_home: &Path,
    api_key: &str,
    region: &str,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
```

**Purpose**: This function saves a Bedrock API key login for Codex. Someone uses it after collecting an API key and region from the user, so future Codex runs know to authenticate through Amazon Bedrock.

**Data flow**: It receives the Codex home folder, the API key, the AWS region, and choices about where secrets should be stored. It builds a fresh authentication record whose mode is `BedrockApiKey`, copies in the key and region, and leaves the other authentication methods empty. It then asks the shared saving code to write that record, returning success or a file/system error if saving fails.

**Call relations**: This function is the Bedrock-specific front door for login saving. After it prepares the authentication record, it calls `save_auth`, which performs the common persistence work used by the authentication system.

*Call graph*: calls 1 internal fn (save_auth).


### `login/src/auth/revoke.rs`

`domain_logic` · `logout`

When someone logs out of managed ChatGPT authentication, the app should not only forget the token on this machine; it should also ask the OAuth server to invalidate that token. This file does that cleanup step. Think of it like returning a hotel key card at checkout: the app removes its local copy either way, but it also tries to tell the front desk that the card should stop working.

The file first decides whether there is anything worth revoking. It only revokes tokens for ChatGPT-style login, not API-key login. If both a refresh token and an access token exist, it chooses the refresh token first, because that is the longer-lived credential and the more important one to invalidate. If no refresh token is available, it falls back to the access token.

It then chooses the revoke URL. Normally it uses the built-in revoke endpoint, but environment variables can override it. This is useful for testing or custom deployments. If only the refresh-token URL is overridden, the file can derive the matching revoke URL from it.

Finally, it sends a JSON HTTP POST request with a short timeout. On success, it returns cleanly. On failure, it tries to extract a readable error message from the server response and wraps it as a standard I/O error.

#### Function details

##### `RevokeTokenKind::as_str`  (lines 31–36)

```
fn as_str(self) -> &'static str
```

**Purpose**: This turns the token kind into the exact text the OAuth server expects in the request. It says whether the app is revoking an access token or a refresh token.

**Data flow**: It receives a token kind, either access or refresh. It converts that choice into the string "access_token" or "refresh_token". It returns that string without changing anything else.

**Call relations**: When revoke_oauth_token builds the HTTP request and later formats an error message, it asks this helper for the server-facing name of the token kind.

*Call graph*: called by 1 (revoke_oauth_token).


##### `RevokeTokenKind::client_id`  (lines 38–43)

```
fn client_id(self) -> Option<String>
```

**Purpose**: This decides whether the revoke request should include the OAuth client ID. Refresh-token revocation includes it; access-token revocation does not.

**Data flow**: It receives a token kind. For a refresh token, it fetches the configured OAuth client ID and returns it. For an access token, it returns nothing. It does not send the request itself.

**Call relations**: revoke_oauth_token calls this while building the JSON request body. If the token is a refresh token, this function hands it the client ID by calling oauth_client_id.

*Call graph*: calls 1 internal fn (oauth_client_id); called by 1 (revoke_oauth_token).


##### `revoke_auth_tokens`  (lines 54–64)

```
async fn revoke_auth_tokens(
    auth_dot_json: Option<&AuthDotJson>,
) -> Result<(), std::io::Error>
```

**Purpose**: This is the main logout helper in this file. It looks at the stored authentication data, chooses a token to revoke if possible, and sends the revoke request.

**Data flow**: It receives optional saved auth data. If there is no suitable ChatGPT OAuth token, it immediately returns success. If there is one, it creates an HTTP client, chooses the revoke endpoint, and passes the token details to revoke_oauth_token. The result is either success or an I/O-style error describing what went wrong.

**Call relations**: Logout code calls this during logout-with-revoke flows. It coordinates the smaller helpers: revocable_token chooses the credential, revoke_token_endpoint chooses where to send the request, create_client builds the HTTP client, and revoke_oauth_token performs the network call.

*Call graph*: calls 3 internal fn (create_client, revoke_oauth_token, revoke_token_endpoint); called by 2 (logout_with_revoke, logout_with_revoke).


##### `revocable_token`  (lines 66–75)

```
fn revocable_token(auth_dot_json: &AuthDotJson) -> Option<(&str, RevokeTokenKind)>
```

**Purpose**: This chooses the best token to revoke from the saved auth data. It prefers the refresh token, because that can usually create new access tokens and is therefore more sensitive.

**Data flow**: It receives saved auth data. It first asks managed_chatgpt_tokens whether the data belongs to managed ChatGPT login. If not, it returns nothing. If tokens are present, it returns the refresh token if it is non-empty; otherwise it returns the access token if that is non-empty. If neither exists, it returns nothing.

**Call relations**: revoke_auth_tokens uses this as its first filter before doing any network work. This function relies on managed_chatgpt_tokens to avoid revoking tokens for the wrong authentication mode.

*Call graph*: calls 1 internal fn (managed_chatgpt_tokens).


##### `managed_chatgpt_tokens`  (lines 77–83)

```
fn managed_chatgpt_tokens(auth_dot_json: &AuthDotJson) -> Option<&TokenData>
```

**Purpose**: This checks whether the saved authentication data represents managed ChatGPT login and, if so, exposes its OAuth tokens. It prevents API-key based login from being treated like OAuth login.

**Data flow**: It receives saved auth data. It asks resolved_auth_mode what login mode the data represents. If the mode is ChatGPT, it returns the stored token data if present. Otherwise it returns nothing.

**Call relations**: revocable_token calls this before choosing a token. This keeps the token-revocation path limited to the kind of login that actually uses OAuth tokens.

*Call graph*: calls 1 internal fn (resolved_auth_mode); called by 1 (revocable_token).


##### `resolved_auth_mode`  (lines 85–93)

```
fn resolved_auth_mode(auth_dot_json: &AuthDotJson) -> ApiAuthMode
```

**Purpose**: This works out the effective authentication mode from saved auth data, including older or incomplete data. It gives the rest of the file a clear answer: ChatGPT login or API-key login.

**Data flow**: It receives saved auth data. If an auth mode is explicitly stored, it returns that. If no mode is stored but an OpenAI API key exists, it treats the data as API-key login. Otherwise it defaults to ChatGPT login.

**Call relations**: managed_chatgpt_tokens calls this before exposing token data. That lets revocation follow the same interpretation rules as the rest of authentication storage.

*Call graph*: called by 1 (managed_chatgpt_tokens).


##### `revoke_oauth_token`  (lines 95–130)

```
async fn revoke_oauth_token(
    client: &CodexHttpClient,
    endpoint: &str,
    token: &str,
    kind: RevokeTokenKind,
    timeout: Duration,
) -> Result<(), std::io::Error>
```

**Purpose**: This sends the actual OAuth revoke request to the server. It packages the token into JSON, posts it to the endpoint, enforces a timeout, and turns server failures into readable errors.

**Data flow**: It receives an HTTP client, endpoint URL, token string, token kind, and timeout. It builds a JSON body containing the token, a token-type hint, and sometimes a client ID. It sends a POST request. If the server returns a successful status, it returns success. If the request fails or the server returns an error status, it returns a standard I/O error, using the response body when possible to make the message clearer.

**Call relations**: revoke_auth_tokens calls this after deciding what to revoke and where to send the request. The timeout test also calls it directly to prove slow revoke servers do not hang logout forever. Inside, it uses RevokeTokenKind::as_str and RevokeTokenKind::client_id to build the correct OAuth request.

*Call graph*: calls 4 internal fn (post, as_str, client_id, try_parse_error_message); called by 2 (revoke_auth_tokens, revoke_request_times_out); 2 external calls (other, format!).


##### `revoke_token_endpoint`  (lines 132–144)

```
fn revoke_token_endpoint() -> String
```

**Purpose**: This chooses the URL used for token revocation. It supports explicit overrides and also derives a revoke URL from a refresh-token override when possible.

**Data flow**: It reads environment variables from the process. If a revoke URL override is set, it returns that. Otherwise, if a refresh-token URL override is set and can be converted into a revoke URL, it returns the derived URL. If neither applies, it returns the built-in revoke URL.

**Call relations**: revoke_auth_tokens calls this right before sending the network request. It calls derive_revoke_token_endpoint when only the refresh-token endpoint has been customized.

*Call graph*: calls 1 internal fn (derive_revoke_token_endpoint); called by 1 (revoke_auth_tokens); 1 external calls (var).


##### `derive_revoke_token_endpoint`  (lines 146–151)

```
fn derive_revoke_token_endpoint(refresh_endpoint: &str) -> Option<String>
```

**Purpose**: This converts a refresh-token endpoint URL into the matching revoke endpoint URL. It is mainly useful when tests or deployments override the OAuth server location.

**Data flow**: It receives a refresh-token URL as text. It parses it as a URL, changes the path to "/oauth/revoke", removes any query string, and returns the new URL as text. If the input is not a valid URL, it returns nothing.

**Call relations**: revoke_token_endpoint calls this when there is a refresh-token override but no direct revoke override. The unit test tests::derives_revoke_url_from_refresh_token_override checks this conversion.

*Call graph*: called by 1 (revoke_token_endpoint); 1 external calls (parse).


##### `tests::derives_revoke_url_from_refresh_token_override`  (lines 164–169)

```
fn derives_revoke_url_from_refresh_token_override()
```

**Purpose**: This test confirms that a refresh-token override URL is converted into the expected revoke URL. It protects the endpoint-derivation rule from accidental changes.

**Data flow**: It supplies a sample refresh-token URL containing a path and query string. It expects the helper to keep the same host and port, replace the path with "/oauth/revoke", and drop the query string.

**Call relations**: This test exercises derive_revoke_token_endpoint directly. It does not perform network I/O; it only checks the URL transformation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::revoke_request_times_out`  (lines 172–199)

```
async fn revoke_request_times_out()
```

**Purpose**: This test confirms that a revoke request does not wait forever when the server is too slow. That matters because logout should not hang indefinitely on a stalled network call.

**Data flow**: It starts a local mock HTTP server that accepts the revoke request but delays its response. It calls revoke_oauth_token with a very short timeout. It expects an error and checks that the original HTTP error is still recognizable as a timeout.

**Call relations**: This test calls revoke_oauth_token directly with controlled inputs. The mock server stands in for the OAuth server, letting the test prove the timeout behavior without depending on the real service.

*Call graph*: calls 3 internal fn (new, new, revoke_oauth_token); 10 external calls (from_millis, from_secs, given, start, new, assert!, format!, skip_if_no_network!, method, path).


### MCP OAuth login and storage
These files implement interactive OAuth login for MCP HTTP servers and the credential persistence and refresh machinery that supports it.

### `rmcp-client/src/perform_oauth_login.rs`

`orchestration` · `OAuth login / authentication setup`

OAuth is the common “sign in in your browser, then come back to the app” process. This file is the bridge between that browser step and the command-line client. Without it, a user could open an authorization page, but the client would not know when approval finished, could not trade the approval code for tokens, and would not save those tokens for future MCP connections.

The flow works like a temporary front desk. First it chooses where to receive the OAuth callback: usually a local address like `127.0.0.1` on an available port, or a configured callback URL. It adds a short callback ID derived from the MCP server URL, so callbacks for different servers are less likely to collide. Then it starts a small HTTP server that waits for one matching request.

Next it asks the MCP server or OAuth provider for an authorization URL. It can either open that URL in the user’s browser or return it to the caller so another interface can show it. When the browser redirects back with a code, the file checks the path, reads the code and state value, reports provider errors clearly, exchanges the code for credentials, computes token expiry, and saves the result using the configured storage method. The guard object makes sure the waiting callback server is unblocked when the flow ends.

#### Function details

##### `CallbackServerGuard::drop`  (lines 45–47)

```
fn drop(&mut self)
```

**Purpose**: Stops the tiny callback web server from waiting forever when the login flow is done or abandoned. This is cleanup code that runs automatically when the guard object is destroyed.

**Data flow**: It reads the stored server reference → tells the server to unblock any waiting receive call → returns nothing, but changes the server state so its waiting loop can end.

**Call relations**: An `OauthLoginFlow` owns this guard while the callback server is active. When `OauthLoginFlow::finish` drops the guard, this method wakes the server so the background callback listener does not hang around.


##### `OAuthProviderError::new`  (lines 57–62)

```
fn new(error: Option<String>, error_description: Option<String>) -> Self
```

**Purpose**: Builds a clear error value from the error fields sent back by an OAuth provider. It keeps both the short machine-style error and the longer human-readable explanation when either is present.

**Data flow**: It receives optional `error` and `error_description` strings → stores them together in an `OAuthProviderError` → returns that error object.

**Call relations**: `parse_oauth_callback` calls this when the callback URL contains OAuth error fields instead of a success code. The resulting error later travels through the callback channel and is shown to the user.

*Call graph*: called by 1 (parse_oauth_callback).


##### `OAuthProviderError::fmt`  (lines 66–75)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Turns an OAuth provider error into a sentence a person can read. It chooses the most helpful wording depending on which error fields are available.

**Data flow**: It reads the stored short error and description → writes a formatted message into Rust’s display formatter → returns whether formatting succeeded.

**Call relations**: This is used whenever the error is printed or converted into a higher-level failure. In the login flow, `OauthLoginFlow::finish` can wrap this error so the final message explains what the provider rejected.

*Call graph*: 1 external calls (write!).


##### `perform_oauth_login`  (lines 81–109)

```
async fn perform_oauth_login(
    server_name: &str,
    server_url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    http_headers: Option<HashMap
```

**Purpose**: Starts the normal interactive OAuth login and prints the browser URL for the user. This is the public helper for a visible, user-driven sign-in.

**Data flow**: It receives the server details, storage choices, headers, scopes, optional client/resource settings, and callback settings → passes them through with browser URL output enabled → returns success or an error after the login finishes.

**Call relations**: This is a thin entry point for callers that want the usual behavior. It delegates the actual work to `perform_oauth_login_with_browser_output`.

*Call graph*: calls 1 internal fn (perform_oauth_login_with_browser_output).


##### `perform_oauth_login_silent`  (lines 112–140)

```
async fn perform_oauth_login_silent(
    server_name: &str,
    server_url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    http_headers: Option<
```

**Purpose**: Starts the same OAuth login flow but does not print the browser URL unless opening the browser fails. This is useful when another part of the program wants less console output.

**Data flow**: It receives the same login settings as the normal function → passes them through with browser URL output disabled → returns success or the failure from the shared login flow.

**Call relations**: Like `perform_oauth_login`, this is a public wrapper. It calls `perform_oauth_login_with_browser_output` with a different output flag.

*Call graph*: calls 1 internal fn (perform_oauth_login_with_browser_output).


##### `perform_oauth_login_with_browser_output`  (lines 143–178)

```
async fn perform_oauth_login_with_browser_output(
    server_name: &str,
    server_url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    http_hea
```

**Purpose**: Runs the shared browser-login path used by both noisy and quiet modes. It prepares header settings, builds an OAuth flow, launches the browser, waits for completion, and saves tokens.

**Data flow**: It receives all login configuration plus a flag saying whether to print the browser URL → packages the headers, creates an `OauthLoginFlow`, and finishes it → returns the final login result.

**Call relations**: `perform_oauth_login` and `perform_oauth_login_silent` both call this to avoid duplicating the flow. It hands setup to `OauthLoginFlow::new` and completion to `OauthLoginFlow::finish`.

*Call graph*: calls 1 internal fn (new); called by 2 (perform_oauth_login, perform_oauth_login_silent).


##### `perform_oauth_login_return_url`  (lines 181–219)

```
async fn perform_oauth_login_return_url(
    server_name: &str,
    server_url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    http_headers: Opt
```

**Purpose**: Starts an OAuth login but returns the authorization URL instead of opening a browser. This lets another user interface, such as a GUI or remote client, decide how to show the URL and when to wait for completion.

**Data flow**: It receives server, storage, header, scope, callback, and timeout settings → creates an `OauthLoginFlow` with browser launching disabled → extracts the authorization URL, starts the login completion task in the background, and returns an `OauthLoginHandle`.

**Call relations**: This is the public path for non-browser-launching callers. It creates the flow with `OauthLoginFlow::new`, starts it with `OauthLoginFlow::spawn`, and wraps the URL plus completion receiver in `OauthLoginHandle::new`.

*Call graph*: calls 2 internal fn (new, new).


##### `spawn_callback_server`  (lines 221–264)

```
fn spawn_callback_server(
    server: Arc<Server>,
    tx: oneshot::Sender<CallbackResult>,
    expected_callback_path: String,
)
```

**Purpose**: Runs the temporary local HTTP server that waits for the OAuth provider to redirect the browser back to the client. It accepts the first valid success or provider-error callback and ignores wrong paths after replying with an error.

**Data flow**: It receives a shared server, a one-time sender channel, and the exact callback path to accept → waits for incoming HTTP requests, parses each request URL, sends either a success code/state or provider error through the channel, and replies to the browser → stops after a final success or provider error.

**Call relations**: `OauthLoginFlow::new` starts this listener after choosing the redirect path. The listener uses `parse_oauth_callback` to decide whether each request is the callback the flow is waiting for.

*Call graph*: called by 1 (new); 1 external calls (spawn_blocking).


##### `parse_oauth_callback`  (lines 285–324)

```
fn parse_oauth_callback(path: &str, expected_callback_path: &str) -> CallbackOutcome
```

**Purpose**: Reads the path and query string from an OAuth callback and decides whether it is a valid success, a provider-reported error, or an unrelated request. This protects the flow from accepting the wrong browser redirect.

**Data flow**: It receives a request path like `/callback?code=...&state=...` and the expected path → checks the route, decodes query values, looks for `code` and `state` or OAuth error fields → returns a success result, an error result, or `Invalid`.

**Call relations**: The callback server calls this for every incoming request. The tests call it with default, custom, matching, and wrong paths to prove it accepts only the intended callback shape.

*Call graph*: calls 1 internal fn (new); called by 6 (parse_oauth_callback_accepts_callback_id_path, parse_oauth_callback_accepts_custom_path, parse_oauth_callback_accepts_default_path, parse_oauth_callback_rejects_missing_callback_id_path, parse_oauth_callback_rejects_wrong_path, parse_oauth_callback_returns_provider_error); 3 external calls (Error, Success, decode).


##### `OauthLoginHandle::new`  (lines 332–337)

```
fn new(authorization_url: String, completion: oneshot::Receiver<Result<()>>) -> Self
```

**Purpose**: Packages an authorization URL together with a way to wait for the background login to finish. It is used when the caller wants to display the URL themselves.

**Data flow**: It receives the authorization URL string and a one-time receiver for the completion result → stores both in an `OauthLoginHandle` → returns the handle.

**Call relations**: `perform_oauth_login_return_url` calls this after creating and spawning an `OauthLoginFlow`. Callers then use the handle to read the URL or wait for the outcome.

*Call graph*: called by 1 (perform_oauth_login_return_url).


##### `OauthLoginHandle::authorization_url`  (lines 339–341)

```
fn authorization_url(&self) -> &str
```

**Purpose**: Returns the browser URL that the user must open to approve access. It lets callers show or copy the URL without taking ownership of the whole handle.

**Data flow**: It reads the stored authorization URL → returns it as borrowed text → changes nothing.

**Call relations**: This is used by code that received an `OauthLoginHandle` from `perform_oauth_login_return_url` and needs to display the URL before waiting for completion.


##### `OauthLoginHandle::into_parts`  (lines 343–345)

```
fn into_parts(self) -> (String, oneshot::Receiver<Result<()>>)
```

**Purpose**: Splits the handle into its two raw pieces: the authorization URL and the completion receiver. This is useful for callers that want full control over how they store or await those pieces.

**Data flow**: It consumes the handle → moves out the URL and the one-time receiver → returns them as a pair.

**Call relations**: This supports advanced callers of `perform_oauth_login_return_url`. Instead of using the convenience `wait` method, they can integrate the receiver into their own async flow.


##### `OauthLoginHandle::wait`  (lines 347–351)

```
async fn wait(self) -> Result<()>
```

**Purpose**: Waits until the background OAuth login finishes and reports whether it succeeded. It also turns a cancelled background task into a clear error message.

**Data flow**: It consumes the handle → awaits the stored completion receiver → returns the login result, or an error if the task disappeared before sending one.

**Call relations**: Callers that receive an `OauthLoginHandle` can call this after the user opens the URL. The result ultimately comes from `OauthLoginFlow::spawn`, which runs `OauthLoginFlow::finish`.


##### `resolve_callback_port`  (lines 367–378)

```
fn resolve_callback_port(callback_port: Option<u16>) -> Result<Option<u16>>
```

**Purpose**: Checks the configured callback port before the local server is started. It rejects port `0` when the user explicitly configured it, because configured ports must be real usable port numbers.

**Data flow**: It receives an optional port → returns the same port if it is valid, returns `None` if no port was configured, or returns an error for explicit `0`.

**Call relations**: `OauthLoginFlow::new` calls this while building the bind address for the callback server. This keeps bad configuration from producing confusing network behavior later.

*Call graph*: called by 1 (new); 1 external calls (bail!).


##### `local_redirect_uri`  (lines 380–395)

```
fn local_redirect_uri(server: &Server) -> Result<String>
```

**Purpose**: Builds the local callback URL from the actual address chosen by the temporary HTTP server. This matters when the program asks the operating system for any free port.

**Data flow**: It reads the server’s listening address → formats an IPv4 or IPv6 URL ending in `/callback` → returns that URL, or an error if the address cannot be determined.

**Call relations**: `resolve_redirect_uri` calls this when no custom callback URL is configured. The result becomes the redirect URI registered with the OAuth authorization request.

*Call graph*: called by 1 (resolve_redirect_uri); 3 external calls (server_addr, anyhow!, format!).


##### `resolve_redirect_uri`  (lines 397–404)

```
fn resolve_redirect_uri(server: &Server, callback_url: Option<&str>) -> Result<String>
```

**Purpose**: Chooses the callback URL that the OAuth provider should redirect back to. It uses a configured callback URL when present, otherwise it uses the temporary local server address.

**Data flow**: It receives the callback server and an optional configured URL → validates the configured URL if present, or asks `local_redirect_uri` to build one → returns the redirect URI text.

**Call relations**: `OauthLoginFlow::new` calls this after starting the callback server. The chosen URI is later given to `start_authorization` and used to derive the expected callback path.

*Call graph*: calls 1 internal fn (local_redirect_uri); called by 1 (new); 1 external calls (parse).


##### `callback_id_from_server_url`  (lines 406–416)

```
fn callback_id_from_server_url(server_url: &str) -> Result<String>
```

**Purpose**: Creates a short, URL-safe ID tied to the MCP server URL. This ID is added to the callback path so different server logins are less likely to accept each other’s redirects.

**Data flow**: It receives the MCP server URL → parses it, requires a host, removes any fragment, hashes the remaining URL with SHA-256, and encodes the first bytes in URL-safe base64 → returns a 12-character callback ID.

**Call relations**: `OauthLoginFlow::new` uses this ID before starting authorization. The test `callback_id_is_bound_to_server_url` checks that meaningful URL changes produce different IDs while fragments do not.

*Call graph*: called by 2 (new, callback_id_is_bound_to_server_url); 2 external calls (digest, parse).


##### `append_callback_id_to_redirect_uri`  (lines 418–429)

```
fn append_callback_id_to_redirect_uri(redirect_uri: &str, callback_id: &str) -> Result<String>
```

**Purpose**: Adds the callback ID as an extra path segment on the redirect URI. This keeps the callback URL unique while preserving any existing query string.

**Data flow**: It receives a redirect URI and callback ID → parses the URI, appends the ID after the current path, and rebuilds the URI → returns the updated URI.

**Call relations**: `OauthLoginFlow::new` calls this after creating the callback ID. Dedicated tests check both ordinary paths and paths that already have query parameters.

*Call graph*: called by 3 (new, callback_id_is_appended_before_redirect_uri_query, callback_id_is_appended_to_redirect_uri_path); 2 external calls (parse, format!).


##### `callback_path_from_redirect_uri`  (lines 431–435)

```
fn callback_path_from_redirect_uri(redirect_uri: &str) -> Result<String>
```

**Purpose**: Extracts only the path part of the redirect URI, such as `/callback/abc123`. The local callback server uses this to know which incoming browser request is the real OAuth callback.

**Data flow**: It receives a full redirect URI → parses it → returns just the path string.

**Call relations**: `OauthLoginFlow::new` calls this after the callback ID has been added. The test `callback_path_comes_from_redirect_uri` verifies the path extraction.

*Call graph*: called by 2 (new, callback_path_comes_from_redirect_uri); 1 external calls (parse).


##### `callback_bind_host`  (lines 437–450)

```
fn callback_bind_host(callback_url: Option<&str>) -> &'static str
```

**Purpose**: Decides which network address the temporary callback server should listen on. It stays local for localhost-style callback URLs, but listens on all interfaces when the configured callback host is not local.

**Data flow**: It receives an optional callback URL → parses the host if possible → returns `127.0.0.1` for local or missing hosts, or `0.0.0.0` for non-local hosts.

**Call relations**: `OauthLoginFlow::new` calls this before binding the callback server. This choice affects whether only the same machine or other machines can reach the callback listener.

*Call graph*: called by 1 (new); 1 external calls (parse).


##### `OauthLoginFlow::new`  (lines 454–526)

```
async fn new(
        server_name: &str,
        server_url: &str,
        store_mode: OAuthCredentialsStoreMode,
        keyring_backend_kind: AuthKeyringBackendKind,
        headers: OauthHeaders,
```

**Purpose**: Builds everything needed for one OAuth login attempt. It starts the callback listener, prepares the redirect URI, creates the HTTP client, begins authorization, and stores all state needed to finish later.

**Data flow**: It receives server details, storage choices, headers, scopes, optional OAuth settings, browser behavior, callback settings, and timeout → chooses a bind address, starts the local server, builds a unique redirect URI, spawns the callback listener, prepares default HTTP headers, starts OAuth authorization, optionally adds a resource parameter, and records a timeout → returns an `OauthLoginFlow` ready to finish or spawn.

**Call relations**: Both `perform_oauth_login_with_browser_output` and `perform_oauth_login_return_url` call this as the setup phase. It coordinates helper functions such as `callback_bind_host`, `resolve_callback_port`, `resolve_redirect_uri`, `callback_id_from_server_url`, `append_callback_id_to_redirect_uri`, `callback_path_from_redirect_uri`, `spawn_callback_server`, `start_authorization`, and `append_query_param`.

*Call graph*: calls 11 internal fn (append_callback_id_to_redirect_uri, append_query_param, callback_bind_host, callback_id_from_server_url, callback_path_from_redirect_uri, resolve_callback_port, resolve_redirect_uri, spawn_callback_server, start_authorization, apply_default_headers (+1 more)); called by 2 (perform_oauth_login_return_url, perform_oauth_login_with_browser_output); 7 external calls (clone, new, new, from_secs, http, format!, channel).


##### `OauthLoginFlow::authorization_url`  (lines 528–530)

```
fn authorization_url(&self) -> String
```

**Purpose**: Returns a copy of the authorization URL for the current login flow. This is used when the flow should be started without automatically opening the browser.

**Data flow**: It reads the stored authorization URL → clones it into a new string → returns that string.

**Call relations**: `perform_oauth_login_return_url` calls this before spawning the flow, so it can hand the URL back to the caller inside an `OauthLoginHandle`.


##### `OauthLoginFlow::finish`  (lines 532–599)

```
async fn finish(mut self, emit_browser_url: bool) -> Result<()>
```

**Purpose**: Completes the login from the user’s point of view. It optionally opens the browser, waits for the callback, exchanges the returned code for tokens, and saves those tokens.

**Data flow**: It consumes the flow state → may print and open the authorization URL, waits for the callback channel with a timeout, checks for provider errors, sends the code and state to the OAuth library, retrieves credentials, computes expiry, builds a stored-token record, saves it, then drops the callback-server guard → returns success or a detailed error.

**Call relations**: `perform_oauth_login_with_browser_output` calls this directly for normal interactive login. `OauthLoginFlow::spawn` also calls it in a background task for URL-returning login flows.

*Call graph*: calls 1 internal fn (compute_expires_at_millis); called by 1 (spawn); 9 external calls (get_credentials, handle_callback, anyhow!, save_oauth_tokens, eprintln!, println!, new, timeout, open).


##### `OauthLoginFlow::spawn`  (lines 601–618)

```
fn spawn(self) -> oneshot::Receiver<Result<()>>
```

**Purpose**: Runs `finish` in the background and gives the caller a receiver for the eventual result. This lets the caller show the authorization URL first and wait later.

**Data flow**: It consumes the flow → creates a one-time result channel, starts an async task that calls `finish`, logs any failure, and sends the result through the channel → returns the receiver side of that channel.

**Call relations**: `perform_oauth_login_return_url` calls this after collecting the authorization URL. The returned receiver is stored in `OauthLoginHandle` and later awaited by `OauthLoginHandle::wait` or by custom caller code.

*Call graph*: calls 1 internal fn (finish); 3 external calls (eprintln!, channel, spawn).


##### `start_authorization`  (lines 621–650)

```
async fn start_authorization(
    server_url: &str,
    http_client: reqwest::Client,
    scopes: &[&str],
    redirect_uri: &str,
    oauth_client_id: Option<&str>,
) -> Result<OAuthState>
```

**Purpose**: Starts the OAuth authorization conversation and returns the state object needed to finish it later. It supports both automatic client registration/discovery and a caller-supplied OAuth client ID.

**Data flow**: It receives the MCP server URL, HTTP client, requested scopes, redirect URI, and optional client ID → if no usable client ID is given, it creates an `OAuthState` and starts authorization with the app name `Codex`; if a client ID is supplied, it discovers provider metadata, configures that client, builds an authorization URL, and wraps it in an authorization session → returns the OAuth state.

**Call relations**: `OauthLoginFlow::new` calls this during setup. The test `start_authorization_uses_configured_client_id` confirms that a provided client ID appears in the generated authorization URL.

*Call graph*: called by 2 (new, start_authorization_uses_configured_client_id); 5 external calls (new, for_scope_upgrade, new, Session, new).


##### `append_query_param`  (lines 652–667)

```
fn append_query_param(url: &str, key: &str, value: Option<&str>) -> String
```

**Purpose**: Adds an optional query parameter to a URL, mainly used to add an OAuth `resource` value. It leaves the URL unchanged when the value is missing or blank.

**Data flow**: It receives a URL, parameter name, and optional value → trims and checks the value, then either uses URL parsing to append the pair safely or falls back to manual encoded appending if the URL cannot be parsed → returns the resulting URL string.

**Call relations**: `OauthLoginFlow::new` uses this to add the optional OAuth resource to the authorization URL. Tests cover normal URLs, blank values, and unparseable URL text.

*Call graph*: called by 4 (new, append_query_param_adds_resource_to_absolute_url, append_query_param_handles_unparseable_url, append_query_param_ignores_empty_values); 3 external calls (parse, format!, encode).


##### `tests::spawn_oauth_metadata_server`  (lines 688–723)

```
async fn spawn_oauth_metadata_server() -> String
```

**Purpose**: Starts a small fake OAuth metadata server for tests. It provides predictable authorization and token endpoint information without contacting a real provider.

**Data flow**: It binds a local test port → builds JSON metadata that points back to that port → starts an Axum web server in the background → returns the base URL for the fake server.

**Call relations**: The test `tests::start_authorization_uses_configured_client_id` calls this before exercising `start_authorization` with a configured client ID.

*Call graph*: 7 external calls (new, bind, get, serve, format!, json!, spawn).


##### `tests::start_authorization_uses_configured_client_id`  (lines 726–749)

```
async fn start_authorization_uses_configured_client_id()
```

**Purpose**: Checks that `start_authorization` respects an explicitly configured OAuth client ID. This protects deployments where the provider expects a known client identifier.

**Data flow**: It starts the fake metadata server → calls `start_authorization` with a specific client ID → reads the generated authorization URL and parses its query string → asserts that the `client_id` parameter matches.

**Call relations**: This test uses `tests::spawn_oauth_metadata_server` as its fake provider and directly verifies the behavior of `start_authorization`.

*Call graph*: calls 2 internal fn (new, start_authorization); 4 external calls (parse, assert_eq!, format!, spawn_oauth_metadata_server).


##### `tests::parse_oauth_callback_accepts_default_path`  (lines 752–755)

```
fn parse_oauth_callback_accepts_default_path()
```

**Purpose**: Checks that the callback parser accepts the standard `/callback` route when it includes a code and state. This is the default local redirect path.

**Data flow**: It passes a default callback URL path into `parse_oauth_callback` → receives a parsed outcome → asserts that the outcome is success.

**Call relations**: This test directly exercises `parse_oauth_callback`, the same parser used by the callback server.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_accepts_custom_path`  (lines 758–761)

```
fn parse_oauth_callback_accepts_custom_path()
```

**Purpose**: Checks that a configured callback path can be accepted. This matters when a user or environment cannot use the default `/callback` path.

**Data flow**: It passes a custom path with `code` and `state` plus the matching expected path → receives the parser outcome → asserts success.

**Call relations**: This test covers the custom-path branch of `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_accepts_callback_id_path`  (lines 764–768)

```
fn parse_oauth_callback_accepts_callback_id_path()
```

**Purpose**: Checks that callback paths containing the generated callback ID are accepted when they match exactly. This supports the file’s collision-avoidance callback design.

**Data flow**: It passes `/callback/abc123` with success query values and expects `/callback/abc123` → receives the parser outcome → asserts success.

**Call relations**: This test verifies the path shape produced by `append_callback_id_to_redirect_uri` and later checked by `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_rejects_missing_callback_id_path`  (lines 771–774)

```
fn parse_oauth_callback_rejects_missing_callback_id_path()
```

**Purpose**: Checks that a callback without the expected callback ID is rejected. This prevents a less-specific path from being accepted by accident.

**Data flow**: It passes `/callback` while the expected path is `/callback/abc123` → receives the parser outcome → asserts that it is invalid.

**Call relations**: This test guards the exact-path check inside `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_rejects_wrong_path`  (lines 777–780)

```
fn parse_oauth_callback_rejects_wrong_path()
```

**Purpose**: Checks that the parser rejects a callback sent to the wrong route. This keeps unrelated browser requests from completing the OAuth flow.

**Data flow**: It passes a callback-looking URL with an expected path that does not match → receives the parser outcome → asserts invalid.

**Call relations**: This test directly confirms the route check used by `spawn_callback_server` through `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_returns_provider_error`  (lines 783–796)

```
fn parse_oauth_callback_returns_provider_error()
```

**Purpose**: Checks that OAuth provider errors in the callback are preserved and decoded. This makes provider rejections visible instead of looking like mysterious invalid callbacks.

**Data flow**: It passes a callback path containing `error` and URL-encoded `error_description` → receives the parser outcome → asserts that it equals the expected `OAuthProviderError`.

**Call relations**: This test exercises `parse_oauth_callback` and indirectly the construction of `OAuthProviderError::new`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert_eq!).


##### `tests::callback_path_comes_from_redirect_uri`  (lines 799–803)

```
fn callback_path_comes_from_redirect_uri()
```

**Purpose**: Checks that the code can extract the path from a full redirect URI. The callback listener only compares paths, not the whole URL.

**Data flow**: It gives `callback_path_from_redirect_uri` a full HTTPS callback URL → receives the path → asserts that the path is `/oauth/callback`.

**Call relations**: This test verifies the helper used by `OauthLoginFlow::new` before it starts accepting callbacks.

*Call graph*: calls 1 internal fn (callback_path_from_redirect_uri); 1 external calls (assert_eq!).


##### `tests::callback_id_is_bound_to_server_url`  (lines 806–829)

```
fn callback_id_is_bound_to_server_url()
```

**Purpose**: Checks that callback IDs are stable for the same meaningful server URL and different for important URL changes. This prevents callback routing from being too broad.

**Data flow**: It computes IDs for several similar and different server URLs → compares them → asserts that fragments are ignored, path/query/origin changes matter, and the ID is URL-safe and 12 characters long.

**Call relations**: This test directly verifies `callback_id_from_server_url`, which `OauthLoginFlow::new` uses to make redirect paths unique.

*Call graph*: calls 1 internal fn (callback_id_from_server_url); 3 external calls (assert!, assert_eq!, assert_ne!).


##### `tests::callback_id_is_appended_to_redirect_uri_path`  (lines 832–838)

```
fn callback_id_is_appended_to_redirect_uri_path()
```

**Purpose**: Checks that a callback ID is appended to a normal redirect path. This confirms the final callback URL has the expected extra path segment.

**Data flow**: It calls `append_callback_id_to_redirect_uri` with a localhost callback URL and ID → receives the updated URI → asserts it ends with `/callback/abc123`.

**Call relations**: This test covers the main path-editing behavior used by `OauthLoginFlow::new`.

*Call graph*: calls 1 internal fn (append_callback_id_to_redirect_uri); 1 external calls (assert_eq!).


##### `tests::callback_id_is_appended_before_redirect_uri_query`  (lines 841–852)

```
fn callback_id_is_appended_before_redirect_uri_query()
```

**Purpose**: Checks that the callback ID is added to the path without losing or moving existing query parameters. This matters for callback services that need their own query values.

**Data flow**: It calls `append_callback_id_to_redirect_uri` with a redirect URI that already has `?provider=github` → receives the updated URI → asserts the ID appears before the query string.

**Call relations**: This test protects a subtle URL-building case in `append_callback_id_to_redirect_uri`.

*Call graph*: calls 1 internal fn (append_callback_id_to_redirect_uri); 1 external calls (assert_eq!).


##### `tests::append_query_param_adds_resource_to_absolute_url`  (lines 855–866)

```
fn append_query_param_adds_resource_to_absolute_url()
```

**Purpose**: Checks that `append_query_param` safely adds a resource parameter to a normal authorization URL. This supports OAuth providers that require a resource audience.

**Data flow**: It passes an authorization URL that already has a query string and a resource value → receives the updated URL → asserts that the new value is URL-encoded and appended with `&`.

**Call relations**: This test directly verifies the helper used by `OauthLoginFlow::new` when `oauth_resource` is configured.

*Call graph*: calls 1 internal fn (append_query_param); 1 external calls (assert_eq!).


##### `tests::append_query_param_ignores_empty_values`  (lines 869–877)

```
fn append_query_param_ignores_empty_values()
```

**Purpose**: Checks that blank optional values do not change the authorization URL. This avoids adding meaningless query parameters.

**Data flow**: It passes a URL and a resource value containing only spaces → receives the returned URL → asserts it is unchanged.

**Call relations**: This test covers the empty-value branch of `append_query_param`.

*Call graph*: calls 1 internal fn (append_query_param); 1 external calls (assert_eq!).


##### `tests::append_query_param_handles_unparseable_url`  (lines 880–884)

```
fn append_query_param_handles_unparseable_url()
```

**Purpose**: Checks that `append_query_param` still produces a useful result when the URL parser cannot parse the input. This is a defensive fallback.

**Data flow**: It passes text that is not a valid URL and a resource value → receives manually appended query text → asserts the value was encoded and added with `?`.

**Call relations**: This test verifies the fallback branch of `append_query_param`, separate from the normal parsed-URL path.

*Call graph*: calls 1 internal fn (append_query_param); 1 external calls (assert_eq!).


### `rmcp-client/src/oauth.rs`

`io_transport` · `startup, OAuth authorization, token refresh, credential persistence, logout cleanup`

MCP servers may require OAuth, which is a login flow that gives the client temporary access tokens and often longer-lived refresh tokens. This file is the place where those tokens are kept safe and kept usable. Without it, users would have to re-authorize repeatedly, expired tokens might be reused, and secrets could be left in the wrong storage location.

The file supports three storage choices: automatic, file-only, and keyring-only. A keyring is the operating system's password vault, such as macOS Keychain or Windows Credential Manager. In automatic mode, the code tries the keyring first and uses `CODEX_HOME/.credentials.json` as a backup. It also supports a newer encrypted secrets backend, where names must fit a stricter format, so the file hashes server information into safe secret names.

The main public flow is simple: load stored tokens for a server, decide whether they are usable, save newer tokens after an OAuth manager changes them, refresh tokens shortly before they expire, and delete tokens when authorization is gone. The `OAuthPersistor` is the bridge between the live authorization manager and storage. It watches the current credentials, writes them only when they change, and removes them when they disappear. Expiry timestamps are stored as absolute times, then converted back into “expires in” durations when tokens are loaded.

#### Function details

##### `WrappedOAuthTokenResponse::eq`  (lines 78–83)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Compares two wrapped OAuth token responses so the code can tell whether stored credentials have really changed. It does this by turning each response into JSON text and comparing that text.

**Data flow**: It receives two wrapped token responses, serializes each one to JSON if possible, and returns true only when both serialized forms are identical. If either response cannot be serialized, it treats them as not equal.

**Call relations**: This comparison is used when `OAuthPersistor::persist_if_needed` checks whether the live authorization manager has produced different credentials that need to be written to storage.

*Call graph*: 1 external calls (to_string).


##### `load_oauth_tokens`  (lines 93–113)

```
fn load_oauth_tokens(
    server_name: &str,
    url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Loads saved OAuth tokens for one MCP server according to the configured storage mode. It is the main read entry point for this file.

**Data flow**: It receives a server name, server URL, storage mode, and keyring backend choice. It then chooses keyring, file, or keyring-with-file-fallback loading and returns either stored tokens, no tokens, or an error.

**Call relations**: It is called by `oauth_token_status`, which needs to know whether credentials already exist before deciding whether the user must authorize again.

*Call graph*: calls 3 internal fn (load_oauth_tokens_from_file, load_oauth_tokens_from_keyring, load_oauth_tokens_from_keyring_with_fallback_to_file); called by 1 (oauth_token_status).


##### `oauth_token_status`  (lines 115–128)

```
fn oauth_token_status(
    server_name: &str,
    url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Result<StoredOAuthTokenStatus>
```

**Purpose**: Answers the practical question: are OAuth credentials missing, usable, or present but not good enough to use? This lets the rest of the client decide whether to proceed or start authorization.

**Data flow**: It loads tokens for the given server. If none are found it reports `Missing`; if found and usable it reports `Usable`; otherwise it reports `AuthorizationRequired`.

**Call relations**: It is called by `determine_streamable_http_auth_status` during authentication setup. It relies on `load_oauth_tokens` for storage access and `oauth_tokens_are_usable` for the validity check.

*Call graph*: calls 2 internal fn (load_oauth_tokens, oauth_tokens_are_usable); called by 1 (determine_streamable_http_auth_status).


##### `oauth_tokens_are_usable`  (lines 130–143)

```
fn oauth_tokens_are_usable(tokens: &StoredOAuthTokens) -> bool
```

**Purpose**: Checks whether stored OAuth tokens contain enough information to be used safely. It accepts expired or nearly expired access tokens only if there is a non-empty refresh token available.

**Data flow**: It reads the client ID, access token, refresh token, and expiry time from the stored token record. It returns true when the credentials are not blank and either the access token is still fresh or the refresh token can renew it.

**Call relations**: It is called by `oauth_token_status` after tokens have been loaded. It uses `token_needs_refresh` so the same near-expiry rule is shared with refresh behavior.

*Call graph*: calls 1 internal fn (token_needs_refresh); called by 1 (oauth_token_status).


##### `refresh_expires_in_from_timestamp`  (lines 145–165)

```
fn refresh_expires_in_from_timestamp(tokens: &mut StoredOAuthTokens)
```

**Purpose**: Restores the token response's relative expiry value from the absolute expiry timestamp saved on disk. This matters because OAuth libraries often expect “expires in 300 seconds,” while storage keeps “expires at this exact time.”

**Data flow**: It receives mutable stored tokens. If they have an `expires_at` timestamp in the future, it calculates the remaining seconds and writes that into the token response; if the timestamp is already expired, it writes a zero duration.

**Call relations**: It is called after loading tokens from direct keyring, encrypted secrets storage, or the fallback file, so loaded credentials behave correctly when handed back to the OAuth transport layer.

*Call graph*: calls 1 internal fn (expires_in_from_timestamp); called by 3 (load_oauth_tokens_from_direct_keyring, load_oauth_tokens_from_file, load_oauth_tokens_from_secrets_keyring); 1 external calls (from_secs).


##### `load_oauth_tokens_from_keyring_with_fallback_to_file`  (lines 167–182)

```
fn load_oauth_tokens_from_keyring_with_fallback_to_file(
    keyring_store: &K,
    keyring_backend_kind: AuthKeyringBackendKind,
    server_name: &str,
    url: &str,
) -> Result<Option<StoredOAuthTo
```

**Purpose**: Tries to load tokens from secure keyring storage first, then falls back to the local credentials file if the keyring is empty or fails. This is the automatic storage behavior.

**Data flow**: It receives a keyring store, backend kind, server name, and URL. It first asks the keyring loader; if tokens are found it returns them, if none are found it checks the file, and if keyring access errors it logs a warning and tries the file.

**Call relations**: It is chosen by `load_oauth_tokens` when storage mode is automatic. It delegates the secure read to `load_oauth_tokens_from_keyring` and the backup read to `load_oauth_tokens_from_file`.

*Call graph*: calls 2 internal fn (load_oauth_tokens_from_file, load_oauth_tokens_from_keyring); called by 1 (load_oauth_tokens); 1 external calls (warn!).


##### `load_oauth_tokens_from_keyring`  (lines 184–198)

```
fn load_oauth_tokens_from_keyring(
    keyring_store: &K,
    keyring_backend_kind: AuthKeyringBackendKind,
    server_name: &str,
    url: &str,
) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Loads tokens from whichever keyring style is configured. It hides the difference between direct keyring entries and the encrypted secrets backend.

**Data flow**: It receives the keyring backend choice and routes the request. For `Direct`, it reads one keyring entry; for `Secrets`, it reads from the secrets manager namespace.

**Call relations**: It is called by the main loader and by the automatic fallback loader. It hands off to `load_oauth_tokens_from_direct_keyring` or `load_oauth_tokens_from_secrets_keyring`.

*Call graph*: calls 2 internal fn (load_oauth_tokens_from_direct_keyring, load_oauth_tokens_from_secrets_keyring); called by 2 (load_oauth_tokens, load_oauth_tokens_from_keyring_with_fallback_to_file).


##### `load_oauth_tokens_from_direct_keyring`  (lines 200–216)

```
fn load_oauth_tokens_from_direct_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Reads OAuth tokens stored directly in the operating system keyring under a deterministic key. This is the simpler keyring storage path.

**Data flow**: It builds the storage key from server name and URL, asks the keyring for the saved JSON string, parses it into `StoredOAuthTokens`, refreshes the in-memory expiry duration, and returns it. If there is no entry, it returns no tokens.

**Call relations**: It is selected by `load_oauth_tokens_from_keyring` for the direct backend. It uses `compute_store_key` to find the keyring entry and `refresh_expires_in_from_timestamp` to prepare loaded tokens for use.

*Call graph*: calls 2 internal fn (compute_store_key, refresh_expires_in_from_timestamp); called by 1 (load_oauth_tokens_from_keyring); 3 external calls (load, new, from_str).


##### `load_oauth_tokens_from_secrets_keyring`  (lines 218–243)

```
fn load_oauth_tokens_from_secrets_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Reads OAuth tokens from the encrypted local secrets system backed by the keyring. This backend stores secrets in a named MCP OAuth namespace instead of as a direct keyring value.

**Data flow**: It finds `CODEX_HOME`, creates a secrets manager for the MCP OAuth namespace, computes the allowed secret name, reads the serialized token string, parses it, refreshes expiry information, and returns the token record if present.

**Call relations**: It is selected by `load_oauth_tokens_from_keyring` for the secrets backend. It uses `compute_secret_name` for the secrets-system key and `refresh_expires_in_from_timestamp` before returning loaded data.

*Call graph*: calls 3 internal fn (compute_secret_name, refresh_expires_in_from_timestamp, new_with_keyring_store_and_namespace); called by 1 (load_oauth_tokens_from_keyring); 4 external calls (new, clone, find_codex_home, from_str).


##### `save_oauth_tokens`  (lines 245–267)

```
fn save_oauth_tokens(
    server_name: &str,
    tokens: &StoredOAuthTokens,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Result<()>
```

**Purpose**: Saves OAuth tokens using the configured storage mode. This is the main write entry point for the file.

**Data flow**: It receives the server name, token record, storage mode, and keyring backend choice. It writes to file, keyring, or keyring-with-file-fallback depending on configuration, returning success or an error.

**Call relations**: It is called by `OAuthPersistor::persist_if_needed` after the live authorization manager has new or changed credentials that should be remembered.

*Call graph*: calls 3 internal fn (save_oauth_tokens_to_file, save_oauth_tokens_with_keyring, save_oauth_tokens_with_keyring_with_fallback_to_file); called by 1 (persist_if_needed).


##### `save_oauth_tokens_with_keyring`  (lines 269–283)

```
fn save_oauth_tokens_with_keyring(
    keyring_store: &K,
    keyring_backend_kind: AuthKeyringBackendKind,
    server_name: &str,
    tokens: &StoredOAuthTokens,
) -> Result<()>
```

**Purpose**: Writes tokens to the chosen keyring-based backend. It keeps the direct keyring and encrypted secrets paths behind one small routing function.

**Data flow**: It receives a keyring store, backend kind, server name, and token record. It dispatches either to direct keyring saving or secrets-backend saving and returns that result.

**Call relations**: It is called by `save_oauth_tokens` in keyring-only mode and by the automatic save path before falling back to file storage.

*Call graph*: calls 2 internal fn (save_oauth_tokens_to_direct_keyring, save_oauth_tokens_to_secrets_keyring); called by 2 (save_oauth_tokens, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `save_oauth_tokens_to_direct_keyring`  (lines 285–309)

```
fn save_oauth_tokens_to_direct_keyring(
    keyring_store: &K,
    server_name: &str,
    tokens: &StoredOAuthTokens,
) -> Result<()>
```

**Purpose**: Stores OAuth tokens directly in the operating system keyring. If that succeeds, it removes any older fallback-file copy so secrets are not duplicated unnecessarily.

**Data flow**: It serializes the token record to JSON, computes the keyring key, and writes the JSON to the keyring service. On success it tries to delete the matching fallback-file entry; on failure it logs and returns an error.

**Call relations**: It is called by `save_oauth_tokens_with_keyring` for the direct backend. It uses `compute_store_key` for the key and `delete_oauth_tokens_from_file` for cleanup after a successful secure save.

*Call graph*: calls 2 internal fn (compute_store_key, delete_oauth_tokens_from_file); called by 1 (save_oauth_tokens_with_keyring); 5 external calls (save, new, format!, to_string, warn!).


##### `save_oauth_tokens_to_secrets_keyring`  (lines 311–334)

```
fn save_oauth_tokens_to_secrets_keyring(
    keyring_store: &K,
    server_name: &str,
    tokens: &StoredOAuthTokens,
) -> Result<()>
```

**Purpose**: Stores OAuth tokens in the encrypted secrets backend. Like the direct keyring path, it cleans up any fallback-file copy after a successful secure write.

**Data flow**: It serializes the tokens, finds `CODEX_HOME`, creates a secrets manager in the MCP OAuth namespace, computes the secret name, writes the JSON secret, then removes the fallback-file entry for the same server.

**Call relations**: It is called by `save_oauth_tokens_with_keyring` for the secrets backend. It combines `compute_secret_name` for encrypted storage with `compute_store_key` for fallback-file cleanup.

*Call graph*: calls 4 internal fn (compute_secret_name, compute_store_key, delete_oauth_tokens_from_file, new_with_keyring_store_and_namespace); called by 1 (save_oauth_tokens_with_keyring); 5 external calls (new, clone, find_codex_home, to_string, warn!).


##### `save_oauth_tokens_with_keyring_with_fallback_to_file`  (lines 336–351)

```
fn save_oauth_tokens_with_keyring_with_fallback_to_file(
    keyring_store: &K,
    keyring_backend_kind: AuthKeyringBackendKind,
    server_name: &str,
    tokens: &StoredOAuthTokens,
) -> Result<()>
```

**Purpose**: Implements automatic saving: use secure keyring storage if possible, otherwise write to the local credentials file. This prevents login from breaking on systems where keyring support is unavailable.

**Data flow**: It first tries `save_oauth_tokens_with_keyring`. If that succeeds, it returns success. If it fails, it logs the problem and writes the tokens to the fallback file, preserving the original keyring error as context if file writing also fails.

**Call relations**: It is called by `save_oauth_tokens` in automatic mode. It delegates to keyring saving first and to `save_oauth_tokens_to_file` only as a backup.

*Call graph*: calls 2 internal fn (save_oauth_tokens_to_file, save_oauth_tokens_with_keyring); called by 1 (save_oauth_tokens); 1 external calls (warn!).


##### `delete_oauth_tokens`  (lines 353–367)

```
fn delete_oauth_tokens(
    server_name: &str,
    url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Result<bool>
```

**Purpose**: Deletes stored OAuth tokens for one MCP server. This is the main delete entry point.

**Data flow**: It receives server identity and storage configuration, creates the default keyring store, and asks the combined keyring-and-file delete helper to remove any matching credentials. It returns whether anything was removed.

**Call relations**: It is called by `OAuthPersistor::persist_if_needed` when the authorization manager no longer has credentials, such as after logout or deauthorization.

*Call graph*: calls 1 internal fn (delete_oauth_tokens_from_keyring_and_file); called by 1 (persist_if_needed).


##### `delete_oauth_tokens_from_keyring_and_file`  (lines 369–395)

```
fn delete_oauth_tokens_from_keyring_and_file(
    keyring_store: &K,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    server_name: &str,
    url: &str,
```

**Purpose**: Removes matching credentials from secure storage and from the fallback file. This avoids stale tokens surviving in a second location.

**Data flow**: It computes the fallback-file key, attempts keyring deletion, handles keyring errors according to storage mode, then deletes the matching file entry. It returns true if either location removed something.

**Call relations**: It is called by `delete_oauth_tokens`. It delegates secure deletion to `delete_oauth_tokens_from_keyring` and file cleanup to `delete_oauth_tokens_from_file`.

*Call graph*: calls 3 internal fn (compute_store_key, delete_oauth_tokens_from_file, delete_oauth_tokens_from_keyring); called by 1 (delete_oauth_tokens); 1 external calls (warn!).


##### `delete_oauth_tokens_from_keyring`  (lines 397–415)

```
fn delete_oauth_tokens_from_keyring(
    keyring_store: &K,
    keyring_backend_kind: AuthKeyringBackendKind,
    server_name: &str,
    url: &str,
) -> Result<bool>
```

**Purpose**: Deletes tokens from the configured keyring-style backend. For the secrets backend, it also tries to remove an older direct keyring entry for cleanup.

**Data flow**: It receives the backend choice. In direct mode it deletes the direct keyring entry; in secrets mode it deletes both the direct keyring entry and the encrypted secret, then reports whether either was removed.

**Call relations**: It is called by `delete_oauth_tokens_from_keyring_and_file`. It hands off to `delete_oauth_tokens_from_direct_keyring` and, for secrets mode, `delete_oauth_tokens_from_secrets_keyring`.

*Call graph*: calls 2 internal fn (delete_oauth_tokens_from_direct_keyring, delete_oauth_tokens_from_secrets_keyring); called by 1 (delete_oauth_tokens_from_keyring_and_file).


##### `delete_oauth_tokens_from_direct_keyring`  (lines 417–426)

```
fn delete_oauth_tokens_from_direct_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<bool>
```

**Purpose**: Deletes the direct keyring entry for a server's OAuth tokens. It is the low-level delete operation for direct keyring storage.

**Data flow**: It computes the same key used when saving, asks the keyring store to delete that entry, and returns whether an entry was removed or an error occurred.

**Call relations**: It is called by `delete_oauth_tokens_from_keyring` in direct mode and as part of secrets-mode cleanup.

*Call graph*: calls 1 internal fn (compute_store_key); called by 1 (delete_oauth_tokens_from_keyring); 1 external calls (delete).


##### `delete_oauth_tokens_from_secrets_keyring`  (lines 428–445)

```
fn delete_oauth_tokens_from_secrets_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<bool>
```

**Purpose**: Deletes the encrypted secrets-backend entry for a server's OAuth tokens.

**Data flow**: It finds `CODEX_HOME`, creates the MCP OAuth secrets manager, computes the secret name, deletes that secret, and returns whether it existed.

**Call relations**: It is called by `delete_oauth_tokens_from_keyring` when the configured backend is the encrypted secrets backend.

*Call graph*: calls 2 internal fn (compute_secret_name, new_with_keyring_store_and_namespace); called by 1 (delete_oauth_tokens_from_keyring); 3 external calls (new, clone, find_codex_home).


##### `OAuthPersistor::new`  (lines 462–480)

```
fn new(
        server_name: String,
        url: String,
        authorization_manager: Arc<Mutex<AuthorizationManager>>,
        store_mode: OAuthCredentialsStoreMode,
        keyring_backend_kind:
```

**Purpose**: Creates an `OAuthPersistor`, the object that keeps live OAuth credentials and stored credentials in sync. It packages the server identity, storage settings, authorization manager, and last known stored credentials together.

**Data flow**: It receives server details, a shared authorization manager, storage configuration, and optional initial credentials. It wraps them in shared state so cloned persistors refer to the same inner record.

**Call relations**: It is called by `create_oauth_transport_and_runtime` when setting up an OAuth-capable MCP transport.

*Call graph*: called by 1 (create_oauth_transport_and_runtime); 2 external calls (new, new).


##### `OAuthPersistor::persist_if_needed`  (lines 488–544)

```
async fn persist_if_needed(&self) -> Result<()>
```

**Purpose**: Writes current OAuth credentials to storage only when they have changed, or deletes stored credentials when the live manager has none. This avoids unnecessary writes and keeps storage aligned with reality.

**Data flow**: It asks the authorization manager for the current client ID and token response. If credentials exist, it computes or preserves the expiry timestamp, compares against the last stored value, and saves when different. If no credentials exist, it clears the remembered value and deletes saved tokens.

**Call relations**: It is called after token refresh by `OAuthPersistor::refresh_if_needed` and can be used whenever the OAuth manager may have changed credentials. It calls `save_oauth_tokens`, `delete_oauth_tokens`, and `compute_expires_at_millis` as needed.

*Call graph*: calls 3 internal fn (compute_expires_at_millis, delete_oauth_tokens, save_oauth_tokens); called by 1 (refresh_if_needed); 1 external calls (warn!).


##### `OAuthPersistor::refresh_if_needed`  (lines 550–572)

```
async fn refresh_if_needed(&self) -> Result<()>
```

**Purpose**: Refreshes OAuth tokens shortly before they expire, then saves the refreshed credentials. This helps avoid making a request with a token that is already dead or about to die.

**Data flow**: It reads the last known expiry timestamp. If the token is still safely valid, it does nothing. If it needs refresh, it asks the authorization manager to refresh the token and then calls `persist_if_needed` to store the result.

**Call relations**: It uses `token_needs_refresh` for the timing decision and calls `persist_if_needed` after the authorization manager refreshes credentials.

*Call graph*: calls 2 internal fn (persist_if_needed, token_needs_refresh).


##### `load_oauth_tokens_from_file`  (lines 594–635)

```
fn load_oauth_tokens_from_file(server_name: &str, url: &str) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Loads OAuth tokens from the fallback `.credentials.json` file. This keeps the client usable when secure keyring storage is not available.

**Data flow**: It reads the fallback file into a map, computes the key for the requested server, searches for a matching entry, rebuilds an OAuth token response from the saved fields, restores expiry information, and returns the stored token record.

**Call relations**: It is called directly by `load_oauth_tokens` in file mode and by `load_oauth_tokens_from_keyring_with_fallback_to_file` when keyring loading cannot provide tokens.

*Call graph*: calls 3 internal fn (compute_store_key, read_fallback_file, refresh_expires_in_from_timestamp); called by 2 (load_oauth_tokens, load_oauth_tokens_from_keyring_with_fallback_to_file); 4 external calls (new, new, new, default).


##### `save_oauth_tokens_to_file`  (lines 637–664)

```
fn save_oauth_tokens_to_file(tokens: &StoredOAuthTokens) -> Result<()>
```

**Purpose**: Writes OAuth tokens into the fallback `.credentials.json` file. It stores the practical fields needed to recreate the token response later.

**Data flow**: It computes the server's storage key, reads the existing file or starts an empty map, extracts access token, refresh token, scopes, client ID, and expiry, inserts the entry, and writes the file back.

**Call relations**: It is called by `save_oauth_tokens` in file mode and by `save_oauth_tokens_with_keyring_with_fallback_to_file` when secure saving fails.

*Call graph*: calls 3 internal fn (compute_store_key, read_fallback_file, write_fallback_file); called by 2 (save_oauth_tokens, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `delete_oauth_tokens_from_file`  (lines 666–679)

```
fn delete_oauth_tokens_from_file(key: &str) -> Result<bool>
```

**Purpose**: Removes one server's OAuth tokens from the fallback credentials file. If the file becomes empty, later writing removes it entirely.

**Data flow**: It reads the fallback file, removes the entry for the given key if present, writes the changed map back when something was removed, and returns whether it removed an entry.

**Call relations**: It is called during explicit deletion and also after successful keyring saves, so the fallback file does not keep stale copies of tokens.

*Call graph*: calls 2 internal fn (read_fallback_file, write_fallback_file); called by 3 (delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_direct_keyring, save_oauth_tokens_to_secrets_keyring).


##### `compute_expires_at_millis`  (lines 681–693)

```
fn compute_expires_at_millis(response: &OAuthTokenResponse) -> Option<u64>
```

**Purpose**: Turns an OAuth response's relative expiry duration into an absolute timestamp in milliseconds. Absolute timestamps are easier to store and compare later.

**Data flow**: It reads `expires_in` from the token response, adds it to the current system time, converts the result to milliseconds since the Unix epoch, and returns that number, capped at the largest `u64` if needed.

**Call relations**: It is called by `OAuthPersistor::persist_if_needed` when saving new token responses and by `tests::sample_tokens` to build realistic test data. The function list also shows it being used by `finish` elsewhere.

*Call graph*: called by 2 (persist_if_needed, finish); 3 external calls (expires_in, now, from).


##### `expires_in_from_timestamp`  (lines 695–706)

```
fn expires_in_from_timestamp(expires_at: u64) -> Option<u64>
```

**Purpose**: Calculates how many seconds remain until a stored absolute expiry timestamp. It is the reverse of storing `expires_at`.

**Data flow**: It compares the given expiry timestamp with the current time. If the timestamp is in the past or exactly now, it returns no remaining time; otherwise it returns the remaining whole seconds.

**Call relations**: It is called by `refresh_expires_in_from_timestamp`, which uses the result to rebuild the OAuth response's relative expiry field after loading tokens.

*Call graph*: called by 1 (refresh_expires_in_from_timestamp); 1 external calls (now).


##### `token_needs_refresh`  (lines 708–719)

```
fn token_needs_refresh(expires_at: Option<u64>) -> bool
```

**Purpose**: Decides whether a token should be refreshed now. It treats a token as needing refresh if it expires within a 30-second safety window.

**Data flow**: It receives an optional expiry timestamp. If there is no timestamp, it returns false. Otherwise it compares the current time plus the safety window with the expiry time and returns true when refresh is due.

**Call relations**: It is called by `OAuthPersistor::refresh_if_needed` before refreshing and by `oauth_tokens_are_usable` when deciding whether a refresh token is required.

*Call graph*: called by 2 (refresh_if_needed, oauth_tokens_are_usable); 1 external calls (now).


##### `compute_store_key`  (lines 721–732)

```
fn compute_store_key(server_name: &str, server_url: &str) -> Result<String>
```

**Purpose**: Creates the stable key used to identify one server's OAuth credentials in direct keyring storage and the fallback file. The key combines the readable server name with a short hash of the server URL payload.

**Data flow**: It builds a small JSON object describing the MCP HTTP server, hashes that object with `sha_256_prefix`, and returns a string like `server-name|hashprefix`.

**Call relations**: It is used across load, save, delete, and secret-name creation so every storage path refers to the same server in the same way.

*Call graph*: calls 1 internal fn (sha_256_prefix); called by 8 (compute_secret_name, delete_oauth_tokens_from_direct_keyring, delete_oauth_tokens_from_keyring_and_file, load_oauth_tokens_from_direct_keyring, load_oauth_tokens_from_file, save_oauth_tokens_to_direct_keyring, save_oauth_tokens_to_file, save_oauth_tokens_to_secrets_keyring); 4 external calls (new, Object, String, format!).


##### `compute_secret_name`  (lines 740–747)

```
fn compute_secret_name(server_name: &str, server_url: &str) -> Result<SecretName>
```

**Purpose**: Creates a valid encrypted-secrets name for one server's OAuth tokens. The secrets system only allows uppercase letters, numbers, and underscores, so the normal storage key must be re-hashed.

**Data flow**: It first computes the regular storage key, hashes it with SHA-256, formats the digest as uppercase hex, prefixes it with `MCP_OAUTH`, and returns it as a checked `SecretName`.

**Call relations**: It is called by the secrets-backend load, save, and delete functions whenever they need the exact secret entry name.

*Call graph*: calls 2 internal fn (compute_store_key, new); called by 3 (delete_oauth_tokens_from_secrets_keyring, load_oauth_tokens_from_secrets_keyring, save_oauth_tokens_to_secrets_keyring); 2 external calls (new, format!).


##### `fallback_file_path`  (lines 749–751)

```
fn fallback_file_path() -> Result<PathBuf>
```

**Purpose**: Finds the path to the fallback credentials file. The file always lives under `CODEX_HOME` as `.credentials.json`.

**Data flow**: It asks the home-directory helper for `CODEX_HOME`, appends the fallback filename, and returns the resulting path.

**Call relations**: It is called by `read_fallback_file` and `write_fallback_file`, which are the only helpers that touch the fallback file path directly.

*Call graph*: called by 2 (read_fallback_file, write_fallback_file); 1 external calls (find_codex_home).


##### `read_fallback_file`  (lines 753–773)

```
fn read_fallback_file() -> Result<Option<FallbackFile>>
```

**Purpose**: Reads and parses the fallback credentials file if it exists. It treats a missing file as normal, not as an error.

**Data flow**: It builds the fallback path, tries to read the file as text, returns `None` if the file is absent, parses JSON into the fallback token map if present, and adds clear context to read or parse errors.

**Call relations**: It is called by file load, file save, and file delete helpers so they all share the same file-reading behavior.

*Call graph*: calls 1 internal fn (fallback_file_path); called by 3 (delete_oauth_tokens_from_file, load_oauth_tokens_from_file, save_oauth_tokens_to_file); 2 external calls (format!, read_to_string).


##### `write_fallback_file`  (lines 775–800)

```
fn write_fallback_file(store: &FallbackFile) -> Result<()>
```

**Purpose**: Writes the fallback credentials map to disk, or removes the file when there are no entries left. On Unix systems it restricts file permissions so only the owner can read or write it.

**Data flow**: It computes the fallback path. If the map is empty, it deletes the file if present. Otherwise it creates the parent directory, serializes the map to JSON, writes it, and sets permissions to `0600` on Unix.

**Call relations**: It is called after saving or deleting fallback-file entries. It is the only function that actually writes the `.credentials.json` contents.

*Call graph*: calls 1 internal fn (fallback_file_path); called by 2 (delete_oauth_tokens_from_file, save_oauth_tokens_to_file); 7 external calls (is_empty, from_mode, create_dir_all, remove_file, set_permissions, write, to_string).


##### `sha_256_prefix`  (lines 802–811)

```
fn sha_256_prefix(value: &Value) -> Result<String>
```

**Purpose**: Creates a short, repeatable SHA-256 hash prefix for a JSON value. This gives storage keys a compact identity without putting all server details directly in the key.

**Data flow**: It serializes the JSON value, hashes the text with SHA-256, formats the digest as lowercase hex, takes the first 16 characters, and returns that string.

**Call relations**: It is called by `compute_store_key`, which uses the hash prefix as part of the credential key.

*Call graph*: called by 1 (compute_store_key); 3 external calls (new, format!, to_string).


##### `tests::TempCodexHome::new`  (lines 835–849)

```
fn new() -> Self
```

**Purpose**: Creates a temporary `CODEX_HOME` directory for tests. This keeps tests from reading or writing a real user's credential files.

**Data flow**: It takes a global lock, creates a temporary directory, sets the `CODEX_HOME` environment variable to that directory, and returns an object that keeps both alive.

**Call relations**: Most tests create this helper before exercising file or secrets behavior, so storage operations happen in an isolated test directory.

*Call graph*: 3 external calls (new, set_var, tempdir).


##### `tests::TempCodexHome::path`  (lines 851–853)

```
fn path(&self) -> &std::path::Path
```

**Purpose**: Returns the path of the temporary `CODEX_HOME` used by a test.

**Data flow**: It reads the path from the temporary directory object and returns it as a filesystem path reference.

**Call relations**: Secrets-backend tests use this path to inspect the test secrets manager and confirm files were written in the expected place.

*Call graph*: 1 external calls (path).


##### `tests::TempCodexHome::drop`  (lines 857–861)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the test environment variable when a temporary Codex home goes out of scope.

**Data flow**: It removes the `CODEX_HOME` environment variable. The temporary directory object then cleans up the directory itself.

**Call relations**: It runs automatically at the end of tests that created `TempCodexHome`, preventing one test's environment from leaking into another.

*Call graph*: 1 external calls (remove_var).


##### `tests::load_oauth_tokens_reads_from_keyring_when_available`  (lines 865–883)

```
fn load_oauth_tokens_reads_from_keyring_when_available() -> Result<()>
```

**Purpose**: Checks that direct keyring loading returns tokens when they are present. This proves the preferred secure read path works.

**Data flow**: It creates test tokens, serializes them into the mock keyring under the computed key, calls the keyring loader, and compares the loaded tokens with the expected tokens while allowing small expiry differences.

**Call relations**: It exercises `load_oauth_tokens_from_keyring` with the direct backend and uses the test comparison helper to verify the result.

*Call graph*: 7 external calls (default, new, assert_tokens_match_without_expiry, sample_tokens, to_string, compute_store_key, load_oauth_tokens_from_keyring).


##### `tests::load_oauth_tokens_falls_back_when_missing_in_keyring`  (lines 886–903)

```
fn load_oauth_tokens_falls_back_when_missing_in_keyring() -> Result<()>
```

**Purpose**: Checks that automatic loading uses the fallback file when the keyring has no matching entry.

**Data flow**: It saves sample tokens to the fallback file, leaves the mock keyring empty, calls the fallback-aware loader, and verifies the file tokens are returned.

**Call relations**: It exercises `load_oauth_tokens_from_keyring_with_fallback_to_file`, confirming the path from keyring miss to file load.

*Call graph*: 6 external calls (default, new, assert_tokens_match_without_expiry, sample_tokens, load_oauth_tokens_from_keyring_with_fallback_to_file, save_oauth_tokens_to_file).


##### `tests::load_oauth_tokens_falls_back_when_keyring_errors`  (lines 906–925)

```
fn load_oauth_tokens_falls_back_when_keyring_errors() -> Result<()>
```

**Purpose**: Checks that automatic loading still works when keyring access fails. This protects users on systems with broken or unavailable keyring services.

**Data flow**: It configures the mock keyring to error for the server key, saves tokens in the fallback file, calls the fallback-aware loader, and verifies the fallback tokens are loaded.

**Call relations**: It exercises the error branch of `load_oauth_tokens_from_keyring_with_fallback_to_file`.

*Call graph*: 8 external calls (Invalid, default, new, assert_tokens_match_without_expiry, sample_tokens, compute_store_key, load_oauth_tokens_from_keyring_with_fallback_to_file, save_oauth_tokens_to_file).


##### `tests::save_oauth_tokens_prefers_keyring_when_available`  (lines 928–948)

```
fn save_oauth_tokens_prefers_keyring_when_available() -> Result<()>
```

**Purpose**: Checks that automatic saving chooses the keyring when it works and removes the older fallback file copy.

**Data flow**: It first writes sample tokens to the fallback file, then saves through the automatic keyring path. It confirms the fallback file disappears and the mock keyring contains the serialized tokens.

**Call relations**: It exercises `save_oauth_tokens_with_keyring_with_fallback_to_file` and the cleanup behavior in direct keyring saving.

*Call graph*: 9 external calls (assert!, assert_eq!, default, new, sample_tokens, compute_store_key, fallback_file_path, save_oauth_tokens_to_file, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `tests::save_oauth_tokens_writes_fallback_when_keyring_fails`  (lines 951–979)

```
fn save_oauth_tokens_writes_fallback_when_keyring_fails() -> Result<()>
```

**Purpose**: Checks that automatic saving falls back to the credentials file if keyring saving fails.

**Data flow**: It configures the mock keyring to fail on save, calls the automatic save helper, then verifies that the fallback file exists with the expected token fields and that the keyring did not save the value.

**Call relations**: It exercises the fallback branch of `save_oauth_tokens_with_keyring_with_fallback_to_file`.

*Call graph*: 10 external calls (Invalid, assert!, assert_eq!, default, new, sample_tokens, compute_store_key, fallback_file_path, read_fallback_file, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `tests::save_oauth_tokens_with_secrets_backend_writes_encrypted_storage`  (lines 982–1014)

```
fn save_oauth_tokens_with_secrets_backend_writes_encrypted_storage() -> Result<()>
```

**Purpose**: Checks that the secrets backend writes tokens to the MCP OAuth encrypted namespace and removes the fallback file.

**Data flow**: It prepares sample tokens, an existing direct keyring value, and a fallback file, then saves using the secrets backend. It reads the secret back through a secrets manager and checks the expected secret file exists while the fallback file is gone.

**Call relations**: It exercises `save_oauth_tokens_with_keyring_with_fallback_to_file` with the secrets backend and verifies storage through `compute_secret_name`.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); 11 external calls (new, assert!, assert_eq!, default, new, sample_tokens, to_string, compute_secret_name, compute_store_key, save_oauth_tokens_to_file (+1 more)).


##### `tests::load_oauth_tokens_with_secrets_backend_reads_encrypted_storage`  (lines 1017–1039)

```
fn load_oauth_tokens_with_secrets_backend_reads_encrypted_storage() -> Result<()>
```

**Purpose**: Checks that tokens saved through the secrets backend can be loaded back from encrypted storage.

**Data flow**: It saves sample tokens using the secrets backend, loads them with the secrets keyring loader, and compares the loaded tokens with the original sample.

**Call relations**: It exercises `save_oauth_tokens_with_keyring` followed by `load_oauth_tokens_from_keyring` for the secrets backend.

*Call graph*: 6 external calls (default, new, assert_tokens_match_without_expiry, sample_tokens, load_oauth_tokens_from_keyring, save_oauth_tokens_with_keyring).


##### `tests::load_oauth_tokens_with_secrets_backend_ignores_direct_entry`  (lines 1042–1059)

```
fn load_oauth_tokens_with_secrets_backend_ignores_direct_entry() -> Result<()>
```

**Purpose**: Checks that secrets-backend loading does not accidentally read direct keyring entries. This prevents mixing two storage formats.

**Data flow**: It writes sample tokens only to the direct mock keyring entry, then attempts to load using the secrets backend and expects no tokens.

**Call relations**: It exercises `load_oauth_tokens_from_keyring` with the secrets backend and confirms it routes only to encrypted secrets storage.

*Call graph*: 7 external calls (assert!, default, new, sample_tokens, to_string, compute_store_key, load_oauth_tokens_from_keyring).


##### `tests::save_oauth_tokens_with_secrets_backend_falls_back_to_file_when_keyring_fails`  (lines 1062–1083)

```
fn save_oauth_tokens_with_secrets_backend_falls_back_to_file_when_keyring_fails() -> Result<()>
```

**Purpose**: Checks that secrets-backend saving falls back to the credentials file when the underlying keyring operation fails.

**Data flow**: It configures the mock keyring to fail for the account used by the secrets system, saves sample tokens through the automatic path, then reads the fallback file and checks the expected key exists.

**Call relations**: It exercises the automatic fallback behavior when `save_oauth_tokens_to_secrets_keyring` cannot complete.

*Call graph*: 9 external calls (Invalid, assert!, compute_keyring_account, default, new, sample_tokens, compute_store_key, read_fallback_file, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `tests::delete_oauth_tokens_with_secrets_backend_removes_secrets_and_file`  (lines 1086–1122)

```
fn delete_oauth_tokens_with_secrets_backend_removes_secrets_and_file() -> Result<()>
```

**Purpose**: Checks that deleting with the secrets backend removes encrypted secrets, direct keyring leftovers, and fallback-file copies.

**Data flow**: It sets up tokens in encrypted storage, direct keyring storage, and the fallback file, calls the combined delete helper, then verifies all three locations are clean.

**Call relations**: It exercises `delete_oauth_tokens_from_keyring_and_file` with the secrets backend, including both direct and secrets deletion paths.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); 11 external calls (new, assert!, default, new, sample_tokens, to_string, compute_secret_name, compute_store_key, delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_file (+1 more)).


##### `tests::delete_oauth_tokens_removes_all_storage`  (lines 1125–1145)

```
fn delete_oauth_tokens_removes_all_storage() -> Result<()>
```

**Purpose**: Checks that deleting in direct mode removes both keyring and fallback-file credentials.

**Data flow**: It stores sample tokens in the mock keyring and fallback file, calls the combined delete helper, then verifies the keyring entry and fallback file are gone.

**Call relations**: It exercises `delete_oauth_tokens_from_keyring_and_file` with the direct backend.

*Call graph*: 8 external calls (assert!, default, new, sample_tokens, to_string, compute_store_key, delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_file).


##### `tests::delete_oauth_tokens_file_mode_removes_keyring_only_entry`  (lines 1148–1168)

```
fn delete_oauth_tokens_file_mode_removes_keyring_only_entry() -> Result<()>
```

**Purpose**: Checks that deletion can remove a keyring-only entry and reports success. The test name mentions file mode, but the call uses automatic mode.

**Data flow**: It writes a direct mock keyring entry, calls the combined delete helper, and verifies the entry is removed and no fallback file exists.

**Call relations**: It exercises direct-keyring deletion through `delete_oauth_tokens_from_keyring_and_file`.

*Call graph*: 7 external calls (assert!, default, new, sample_tokens, to_string, compute_store_key, delete_oauth_tokens_from_keyring_and_file).


##### `tests::delete_oauth_tokens_propagates_keyring_errors`  (lines 1171–1189)

```
fn delete_oauth_tokens_propagates_keyring_errors() -> Result<()>
```

**Purpose**: Checks that keyring deletion errors are not silently ignored in automatic mode. This protects against falsely reporting that credentials were removed.

**Data flow**: It configures the mock keyring to error on delete, writes fallback tokens, calls the combined delete helper, expects an error, and confirms the fallback file remains.

**Call relations**: It exercises the error-handling branch of `delete_oauth_tokens_from_keyring_and_file`.

*Call graph*: 8 external calls (Invalid, assert!, default, new, sample_tokens, compute_store_key, delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_file).


##### `tests::refresh_expires_in_from_timestamp_restores_future_durations`  (lines 1192–1209)

```
fn refresh_expires_in_from_timestamp_restores_future_durations()
```

**Purpose**: Checks that a future absolute expiry timestamp is converted back into a reasonable `expires_in` duration.

**Data flow**: It creates sample tokens, clears their relative expiry field, runs the refresh helper, and compares the restored seconds with the expected remaining time.

**Call relations**: It directly exercises `refresh_expires_in_from_timestamp` and `expires_in_from_timestamp`.

*Call graph*: 4 external calls (assert!, sample_tokens, expires_in_from_timestamp, refresh_expires_in_from_timestamp).


##### `tests::refresh_expires_in_from_timestamp_marks_expired_tokens`  (lines 1212–1226)

```
fn refresh_expires_in_from_timestamp_marks_expired_tokens()
```

**Purpose**: Checks that already-expired stored tokens are marked with a zero remaining duration.

**Data flow**: It changes sample tokens to have an expired timestamp, gives them a nonzero relative expiry, runs the refresh helper, and verifies the relative expiry becomes zero.

**Call relations**: It directly exercises the expired-token branch of `refresh_expires_in_from_timestamp`.

*Call graph*: 5 external calls (from_secs, now, assert_eq!, sample_tokens, refresh_expires_in_from_timestamp).


##### `tests::oauth_tokens_are_usable_when_expiry_is_unknown`  (lines 1229–1235)

```
fn oauth_tokens_are_usable_when_expiry_is_unknown()
```

**Purpose**: Checks that tokens with no known expiry can still be considered usable if the access token is present.

**Data flow**: It creates sample tokens, removes the expiry and refresh token, and asserts the usability check passes.

**Call relations**: It validates the behavior used by `oauth_token_status` through `oauth_tokens_are_usable`.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_usable_when_unexpired_without_refresh_token`  (lines 1238–1243)

```
fn oauth_tokens_are_usable_when_unexpired_without_refresh_token()
```

**Purpose**: Checks that an unexpired access token does not require a refresh token to be usable.

**Data flow**: It creates sample tokens, removes the refresh token while leaving the access token unexpired, and asserts the tokens are usable.

**Call relations**: It validates one normal success case for `oauth_tokens_are_usable`.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_usable_when_expired_but_refreshable`  (lines 1246–1251)

```
fn oauth_tokens_are_usable_when_expired_but_refreshable()
```

**Purpose**: Checks that expired tokens are still acceptable when a refresh token is available.

**Data flow**: It creates sample tokens, sets their expiry to the past, keeps the refresh token, and asserts the usability check passes.

**Call relations**: It validates the refreshable-expired path in `oauth_tokens_are_usable`.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_expired_and_unrefreshable`  (lines 1254–1260)

```
fn oauth_tokens_are_not_usable_when_expired_and_unrefreshable()
```

**Purpose**: Checks that expired tokens without a refresh token require new authorization.

**Data flow**: It creates sample tokens, sets them as expired, removes the refresh token, and asserts the usability check fails.

**Call relations**: It validates a failure path in `oauth_tokens_are_usable`.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_near_expiry_and_unrefreshable`  (lines 1263–1273)

```
fn oauth_tokens_are_not_usable_when_near_expiry_and_unrefreshable()
```

**Purpose**: Checks that tokens about to expire are treated like expired tokens if they cannot be refreshed.

**Data flow**: It creates sample tokens, sets expiry just inside the refresh safety window, removes the refresh token, and asserts the usability check fails.

**Call relations**: It validates how `oauth_tokens_are_usable` relies on `token_needs_refresh`.

*Call graph*: 3 external calls (now, assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_client_id_is_blank`  (lines 1276–1281)

```
fn oauth_tokens_are_not_usable_when_client_id_is_blank()
```

**Purpose**: Checks that credentials with a blank client ID are rejected.

**Data flow**: It creates sample tokens, replaces the client ID with whitespace, and asserts the usability check fails.

**Call relations**: It validates one input-quality guard in `oauth_tokens_are_usable`.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_access_token_is_blank`  (lines 1284–1292)

```
fn oauth_tokens_are_not_usable_when_access_token_is_blank()
```

**Purpose**: Checks that credentials with a blank access token are rejected when the access token is needed.

**Data flow**: It creates sample tokens, replaces the access token with whitespace, and asserts the usability check fails.

**Call relations**: It validates another input-quality guard in `oauth_tokens_are_usable`.

*Call graph*: 3 external calls (new, assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_required_refresh_token_is_blank`  (lines 1295–1304)

```
fn oauth_tokens_are_not_usable_when_required_refresh_token_is_blank()
```

**Purpose**: Checks that an expired token with an empty refresh token is rejected. A refresh token must contain real secret text to renew credentials.

**Data flow**: It creates sample tokens, marks them expired, sets the refresh token to whitespace, and asserts the usability check fails.

**Call relations**: It validates the refresh-token quality check in `oauth_tokens_are_usable`.

*Call graph*: 3 external calls (new, assert!, sample_tokens).


##### `tests::assert_tokens_match_without_expiry`  (lines 1306–1318)

```
fn assert_tokens_match_without_expiry(
        actual: &StoredOAuthTokens,
        expected: &StoredOAuthTokens,
    )
```

**Purpose**: Compares two stored token records in tests while avoiding fragile checks on exact relative expiry timing.

**Data flow**: It receives actual and expected stored tokens, compares server name, URL, client ID, absolute expiry, and then delegates token-response comparison to another helper.

**Call relations**: Several load tests use it after retrieving tokens from storage, because small time differences can make direct expiry-duration comparison unreliable.

*Call graph*: 2 external calls (assert_eq!, assert_token_response_match_without_expiry).


##### `tests::assert_token_response_match_without_expiry`  (lines 1320–1345)

```
fn assert_token_response_match_without_expiry(
        actual: &WrappedOAuthTokenResponse,
        expected: &WrappedOAuthTokenResponse,
    )
```

**Purpose**: Compares the meaningful OAuth token response fields in tests without requiring exact expiry-duration equality.

**Data flow**: It receives two wrapped token responses and compares access token, token type, refresh token, scopes, extra fields, and whether an expiry field exists.

**Call relations**: It is called by `tests::assert_tokens_match_without_expiry` as the detailed response-level comparison helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sample_tokens`  (lines 1347–1369)

```
fn sample_tokens() -> StoredOAuthTokens
```

**Purpose**: Builds a realistic sample `StoredOAuthTokens` value for tests. This keeps test setup short and consistent.

**Data flow**: It creates an OAuth response with an access token, refresh token, scopes, and one-hour expiry, computes the absolute expiry timestamp, and returns a complete stored-token record for a test server.

**Call relations**: Most tests call this helper before saving, loading, deleting, or checking token usability.

*Call graph*: 7 external calls (new, from_secs, new, new, default, compute_expires_at_millis, vec!).
