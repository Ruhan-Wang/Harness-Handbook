# Interactive and persisted login flows  `stage-5.1`

This stage is the system’s “getting signed in and staying signed in” layer. It sits around startup and onboarding, and also supports later account checks and logout. Its job is to help a person prove who they are, save that result safely, and clear it when they sign out.

The main entry point is cli/src/login.rs, which powers the direct login, logout, and status commands and leaves a small log file for troubleshooting. The login crate is the engine behind those commands. Its top-level files gather the pieces together, while server.rs runs the short-lived local web server used for browser login, and device_code_auth.rs handles the fallback flow where you copy a code into a browser on another device. auth/storage.rs decides where credentials are kept: a plain file, the operating system keyring, encrypted secret storage, or memory only. auth_keyring.rs picks the right secure storage early, and keyring-store/src/lib.rs is the adapter that talks to the keyring safely.

For account-aware apps, account_processor.rs answers requests like “am I logged in?” and tracks in-progress login attempts. headless_chatgpt_login.rs shows device-code login during text-based onboarding. revoke.rs asks the identity service to invalidate tokens during logout. Bedrock and MCP files provide the same save-and-refresh pattern for those login types too.

## Files in this stage

### CLI and account entrypoints
These files expose login, logout, and auth-status flows to users through the CLI and app-server account APIs.

### `cli/src/login.rs`

`entrypoint` · `login/logout command execution`

This file owns the non-TUI authentication commands and their user-visible behavior. It deliberately keeps logging setup local: `init_login_file_logging` resolves the log directory from `Config`, creates it, opens `codex-login.log` with append semantics (and mode `0o600` on Unix), wraps it in a non-blocking tracing writer, and installs a small subscriber filtered by `RUST_LOG` or a default `codex_cli/codex_core/codex_login=info` filter. Failures only print warnings to stderr and do not abort login.

Each login entrypoint first loads configuration with `load_config_or_exit`, then optionally initializes file logging and checks `forced_login_method` gates. Browser and device-code flows clear any existing auth via `clear_existing_auth_before_login`, which calls `logout_with_revoke` and only logs a warning on failure. Browser login uses `ServerOptions` plus `run_login_server`; device-code login uses `run_device_code_login`; the fallback variant first tries device code with `open_browser = false` and falls back to the local browser server only when the error kind is `NotFound`.

API-key and access-token flows write credentials directly through `codex_login` helpers and exit immediately with success or error messages. `read_api_key_from_stdin` and `read_access_token_from_stdin` share `read_stdin_secret`, which refuses interactive terminals, reads all stdin, trims whitespace, and exits on empty input. `run_login_status` inspects stored auth with `CodexAuth::from_auth_storage` and prints mode-specific messages, masking API keys with `safe_format_key`. `run_logout` revokes stored auth and reports whether anything was removed. Tests cover auth clearing and key masking.

#### Function details

##### `init_login_file_logging`  (lines 51–110)

```
fn init_login_file_logging(config: &Config) -> Option<WorkerGuard>
```

**Purpose**: Installs a minimal file-backed tracing subscriber for direct login commands and returns the guard that keeps the non-blocking writer alive. It warns to stderr instead of failing the command when logging setup cannot be completed.

**Data flow**: Reads the log directory from `codex_core::config::log_dir(config)`, creates it with `create_dir_all`, configures `OpenOptions` for append/create and Unix mode `0o600`, opens `codex-login.log`, wraps the file with `tracing_appender::non_blocking`, builds an `EnvFilter` from the environment or a default filter string, constructs a formatting layer with targets and no ANSI, and attempts `tracing_subscriber::registry().with(file_layer).try_init()`. It returns `Some(WorkerGuard)` on success or `None` after printing warnings on any failure path.

**Call relations**: Called at the start of all direct login flows (`run_login_with_chatgpt`, `run_login_with_api_key`, `run_login_with_access_token`, `run_login_with_device_code`, and the fallback variant) so those one-shot commands leave a durable log artifact.

*Call graph*: calls 1 internal fn (log_dir); called by 5 (run_login_with_access_token, run_login_with_api_key, run_login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser); 7 external calls (try_from_default_env, new, eprintln!, create_dir_all, non_blocking, layer, registry).


##### `print_login_server_start`  (lines 112–116)

```
fn print_login_server_start(actual_port: u16, auth_url: &str)
```

**Purpose**: Prints the browser-login startup message shown to users when a local login server is launched. The message includes the localhost port, auth URL, and a hint to use device auth on headless machines.

**Data flow**: Accepts the actual bound port and auth URL string and writes a multi-line message to stderr with `eprintln!`.

**Call relations**: Used by `login_with_chatgpt` and by the browser-fallback branch of `run_login_with_device_code_fallback_to_browser` immediately after a login server is started.

*Call graph*: called by 2 (login_with_chatgpt, run_login_with_device_code_fallback_to_browser); 1 external calls (eprintln!).


##### `clear_existing_auth_before_login`  (lines 118–132)

```
async fn clear_existing_auth_before_login(
    codex_home: &Path,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    auth_keyring_backend_kind: AuthKeyringBackendKind,
)
```

**Purpose**: Best-effort cleanup step that revokes any existing stored authentication before starting a new login flow. Cleanup failures are logged but do not block the new login attempt.

**Data flow**: Accepts the Codex home path, credential-store mode, and keyring backend kind; awaits `logout_with_revoke`; if it returns an error, emits a tracing warning and otherwise produces no output.

**Call relations**: Called before browser and device-code login flows, and directly exercised by a test. It isolates pre-login cleanup from the user-facing command wrappers.

*Call graph*: called by 4 (login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser, clears_existing_auth_before_login); 2 external calls (logout_with_revoke, warn!).


##### `login_with_chatgpt`  (lines 134–159)

```
async fn login_with_chatgpt(
    codex_home: PathBuf,
    forced_chatgpt_workspace_id: Option<Vec<String>>,
    cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
    auth_keyring_backend_kind
```

**Purpose**: Runs the underlying browser-based ChatGPT login flow without exiting the process itself. It clears existing auth, starts the local login server, prints connection instructions, and waits for completion.

**Data flow**: Consumes `codex_home`, optional forced workspace IDs, credential-store mode, and keyring backend kind; awaits `clear_existing_auth_before_login`; constructs `ServerOptions::new(...)`; starts the server with `run_login_server`; prints startup instructions with `print_login_server_start`; then awaits `server.block_until_done()` and returns its `std::io::Result<()>`.

**Call relations**: This helper is called by `run_login_with_chatgpt`, which wraps it with config loading, logging setup, forced-method checks, user messaging, and process exit.

*Call graph*: calls 3 internal fn (clear_existing_auth_before_login, print_login_server_start, new); called by 1 (run_login_with_chatgpt); 1 external calls (run_login_server).


##### `run_login_with_chatgpt`  (lines 161–190)

```
async fn run_login_with_chatgpt(cli_config_overrides: CliConfigOverrides) -> !
```

**Purpose**: CLI entrypoint for browser-based ChatGPT login. It loads config, initializes login logging, enforces forced-login-method policy, runs the login flow, prints the outcome, and exits.

**Data flow**: Consumes `CliConfigOverrides`, awaits `load_config_or_exit`, stores the optional logging guard from `init_login_file_logging`, emits a tracing info event, checks whether `config.forced_login_method` forbids ChatGPT login, clones `forced_chatgpt_workspace_id`, awaits `login_with_chatgpt(...)`, prints either `Successfully logged in` or `Error logging in: ...`, and terminates the process with exit code 0 or 1.

**Call relations**: Invoked by `cli_main` for the corresponding subcommand. It delegates the actual browser-login mechanics to `login_with_chatgpt`.

*Call graph*: calls 3 internal fn (init_login_file_logging, load_config_or_exit, login_with_chatgpt); called by 1 (cli_main); 4 external calls (eprintln!, matches!, exit, info!).


##### `run_login_with_api_key`  (lines 192–220)

```
async fn run_login_with_api_key(
    cli_config_overrides: CliConfigOverrides,
    api_key: String,
) -> !
```

**Purpose**: CLI entrypoint for API-key login. It validates policy, stores the provided key through `codex_login`, reports success or failure, and exits.

**Data flow**: Consumes CLI overrides and an API key string, awaits `load_config_or_exit`, initializes login logging, emits a tracing info event, checks whether `forced_login_method` forbids API-key login, calls `login_with_api_key(&config.codex_home, &api_key, ...)`, prints success or error to stderr, and exits with code 0 or 1.

**Call relations**: Called by `cli_main` after the API key has been obtained, often via `read_api_key_from_stdin`. It delegates credential persistence to the external `codex_login::login_with_api_key` helper.

*Call graph*: calls 2 internal fn (init_login_file_logging, load_config_or_exit); called by 1 (cli_main); 5 external calls (login_with_api_key, eprintln!, matches!, exit, info!).


##### `run_login_with_access_token`  (lines 222–254)

```
async fn run_login_with_access_token(
    cli_config_overrides: CliConfigOverrides,
    access_token: String,
) -> !
```

**Purpose**: CLI entrypoint for access-token login. It enforces policy, passes the token and related config to the async login helper, and exits with a user-visible result.

**Data flow**: Consumes CLI overrides and an access token string, awaits `load_config_or_exit`, initializes login logging, emits a tracing info event, checks whether `forced_login_method` forbids this path, awaits `login_with_access_token(&config.codex_home, &access_token, config.cli_auth_credentials_store_mode, config.forced_chatgpt_workspace_id.as_deref(), Some(&config.chatgpt_base_url), config.auth_keyring_backend_kind())`, prints success or an error message, and exits 0 or 1.

**Call relations**: Invoked by `cli_main`, typically after `read_access_token_from_stdin`. It wraps the lower-level async token login helper with config and process-exit behavior.

*Call graph*: calls 2 internal fn (init_login_file_logging, load_config_or_exit); called by 1 (cli_main); 5 external calls (login_with_access_token, eprintln!, matches!, exit, info!).


##### `read_api_key_from_stdin`  (lines 256–262)

```
fn read_api_key_from_stdin() -> String
```

**Purpose**: Reads an API key from non-interactive stdin with API-key-specific guidance and empty-input messaging. It exits the process on misuse or read failure.

**Data flow**: Calls `read_stdin_secret` with an API-key-specific terminal warning, reading message, and empty-input message, and returns the resulting trimmed secret string.

**Call relations**: Used by `cli_main` when the user selects `--with-api-key` and the key is expected on stdin.

*Call graph*: calls 1 internal fn (read_stdin_secret); called by 1 (cli_main).


##### `read_access_token_from_stdin`  (lines 264–270)

```
fn read_access_token_from_stdin() -> String
```

**Purpose**: Reads an access token from non-interactive stdin with access-token-specific guidance and empty-input messaging. It exits the process on misuse or read failure.

**Data flow**: Calls `read_stdin_secret` with access-token-specific messages and returns the resulting trimmed secret string.

**Call relations**: Used by `cli_main` when the user selects `--with-access-token` and the token is expected on stdin.

*Call graph*: calls 1 internal fn (read_stdin_secret); called by 1 (cli_main).


##### `read_stdin_secret`  (lines 272–295)

```
fn read_stdin_secret(terminal_message: &str, reading_message: &str, empty_message: &str) -> String
```

**Purpose**: Shared stdin reader for secret-bearing login flags. It rejects interactive terminals, reads all stdin, trims whitespace, and exits with explanatory messages on failure or empty input.

**Data flow**: Creates a handle to `std::io::stdin()`, checks `stdin.is_terminal()`, and if true prints the provided terminal-usage message and exits 1. Otherwise it prints the reading message, reads all input into a `String` with `read_to_string`, exits 1 on read error, trims the buffer into `secret`, exits 1 with the provided empty-input message if the trimmed string is empty, and otherwise returns the secret.

**Call relations**: This helper underlies both `read_api_key_from_stdin` and `read_access_token_from_stdin`, centralizing the non-interactive secret-input contract.

*Call graph*: called by 2 (read_access_token_from_stdin, read_api_key_from_stdin); 4 external calls (new, eprintln!, stdin, exit).


##### `run_login_with_device_code`  (lines 298–337)

```
async fn run_login_with_device_code(
    cli_config_overrides: CliConfigOverrides,
    issuer_base_url: Option<String>,
    client_id: Option<String>,
) -> !
```

**Purpose**: CLI entrypoint for OAuth device-code login. It clears existing auth, optionally overrides issuer/client ID, runs the device-code flow, and exits with a user-visible result.

**Data flow**: Consumes CLI overrides plus optional issuer base URL and client ID, awaits `load_config_or_exit`, initializes login logging, emits a tracing info event, checks forced-login-method policy, awaits `clear_existing_auth_before_login`, clones `forced_chatgpt_workspace_id`, constructs `ServerOptions::new(...)` using the provided or default client ID, optionally overrides `opts.issuer`, awaits `run_device_code_login(opts)`, prints success or `Error logging in with device code: ...`, and exits 0 or 1.

**Call relations**: Called by `cli_main` for explicit device-auth login. It shares setup patterns with browser login but delegates the actual auth exchange to `run_device_code_login`.

*Call graph*: calls 4 internal fn (clear_existing_auth_before_login, init_login_file_logging, load_config_or_exit, new); called by 1 (cli_main); 5 external calls (run_device_code_login, eprintln!, matches!, exit, info!).


##### `run_login_with_device_code_fallback_to_browser`  (lines 343–408)

```
async fn run_login_with_device_code_fallback_to_browser(
    cli_config_overrides: CliConfigOverrides,
    issuer_base_url: Option<String>,
    client_id: Option<String>,
) -> !
```

**Purpose**: Starts with headless-friendly device-code login and falls back to browser login only when device code is unsupported. It preserves one command path that works in both headless and browser-capable environments.

**Data flow**: Consumes CLI overrides plus optional issuer and client ID, awaits `load_config_or_exit`, initializes login logging, emits a tracing info event, checks forced-login-method policy, clears existing auth, builds `ServerOptions` with optional issuer override and `open_browser = false`, then awaits `run_device_code_login(opts.clone())`. On success it prints the standard success message and exits 0. On `std::io::ErrorKind::NotFound` it prints a fallback notice, starts a browser login server with `run_login_server(opts)`, prints startup instructions, awaits `server.block_until_done()`, and exits based on that result. Any other device-code error or server-start error prints an error and exits 1.

**Call relations**: This function is another login entrypoint used by the CLI when it wants a resilient default. It combines the device-code path with the browser-server path and uses `print_login_server_start` in the fallback branch.

*Call graph*: calls 5 internal fn (clear_existing_auth_before_login, init_login_file_logging, load_config_or_exit, print_login_server_start, new); 6 external calls (run_device_code_login, run_login_server, eprintln!, matches!, exit, info!).


##### `run_login_status`  (lines 410–458)

```
async fn run_login_status(cli_config_overrides: CliConfigOverrides) -> !
```

**Purpose**: CLI entrypoint that reports whether the user is logged in and by which auth mode. It prints a mode-specific message and exits with success only when credentials are present.

**Data flow**: Consumes CLI overrides, awaits `load_config_or_exit`, then awaits `CodexAuth::from_auth_storage(&config.codex_home, config.cli_auth_credentials_store_mode, Some(&config.chatgpt_base_url), config.auth_keyring_backend_kind())`. If auth exists, it matches on `auth.auth_mode()`: API keys are fetched with `auth.get_token()` and masked via `safe_format_key`, while other modes print fixed messages. It exits 0 for recognized stored auth, 1 for missing auth, token retrieval errors, or storage lookup errors.

**Call relations**: Invoked by `cli_main` for `codex login status`. It is read-only and does not initialize the login file logger because it does not run an interactive login flow.

*Call graph*: calls 2 internal fn (load_config_or_exit, from_auth_storage); called by 1 (cli_main); 2 external calls (eprintln!, exit).


##### `run_logout`  (lines 460–483)

```
async fn run_logout(cli_config_overrides: CliConfigOverrides) -> !
```

**Purpose**: CLI entrypoint that revokes and removes stored authentication. It reports whether logout actually removed credentials and exits accordingly.

**Data flow**: Consumes CLI overrides, awaits `load_config_or_exit`, awaits `logout_with_revoke(&config.codex_home, config.cli_auth_credentials_store_mode, config.auth_keyring_backend_kind())`, prints `Successfully logged out`, `Not logged in`, or `Error logging out: ...`, and exits with code 0 for the first two cases or 1 on error.

**Call relations**: Called by `cli_main` for the logout subcommand. It reuses the same revoke helper used by pre-login cleanup.

*Call graph*: calls 1 internal fn (load_config_or_exit); called by 1 (cli_main); 3 external calls (logout_with_revoke, eprintln!, exit).


##### `load_config_or_exit`  (lines 485–501)

```
async fn load_config_or_exit(cli_config_overrides: CliConfigOverrides) -> Config
```

**Purpose**: Loads CLI configuration for login commands and terminates the process on parse or load failure. It centralizes the common startup path for all login-related entrypoints.

**Data flow**: Consumes `CliConfigOverrides`, calls `parse_overrides`, prints `Error parsing -c overrides: ...` and exits 1 on failure, otherwise awaits `Config::load_with_cli_overrides(cli_overrides)`, returning the loaded `Config` on success or printing `Error loading configuration: ...` and exiting 1 on failure.

**Call relations**: Used by every login, logout, and status entrypoint so they all share identical configuration error handling.

*Call graph*: calls 1 internal fn (parse_overrides); called by 7 (run_login_status, run_login_with_access_token, run_login_with_api_key, run_login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser, run_logout); 3 external calls (load_with_cli_overrides, eprintln!, exit).


##### `safe_format_key`  (lines 503–510)

```
fn safe_format_key(key: &str) -> String
```

**Purpose**: Masks API keys for status output while leaving enough prefix and suffix to identify which key is in use. Very short keys are fully redacted.

**Data flow**: Accepts a key string, returns `***` when `key.len() <= 13`, otherwise slices the first 8 characters and last 5 characters and returns `<prefix>***<suffix>`.

**Call relations**: Used by `run_login_status` when reporting API-key authentication, and covered by unit tests for long and short keys.

*Call graph*: 1 external calls (format!).


##### `tests::clears_existing_auth_before_login`  (lines 525–549)

```
async fn clears_existing_auth_before_login()
```

**Purpose**: Verifies that pre-login cleanup removes previously stored file-based auth. It exercises the cleanup helper against real auth storage in a temporary Codex home.

**Data flow**: Creates a temporary directory, stores an API key with `login_with_api_key`, awaits `clear_existing_auth_before_login` using file storage and the default keyring backend, reloads auth with `load_auth_dot_json`, and asserts that the result is `None`.

**Call relations**: This test directly validates the behavior of `clear_existing_auth_before_login` rather than the higher-level login entrypoints.

*Call graph*: calls 2 internal fn (clear_existing_auth_before_login, default); 4 external calls (assert_eq!, load_auth_dot_json, login_with_api_key, tempdir).


##### `tests::formats_long_key`  (lines 552–555)

```
fn formats_long_key()
```

**Purpose**: Verifies the masking format for sufficiently long API keys. It checks that the prefix and suffix are preserved with `***` in the middle.

**Data flow**: Calls `safe_format_key` with a long sample key and asserts the exact masked string.

**Call relations**: This unit test protects the user-visible formatting used by `run_login_status`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::short_key_returns_stars`  (lines 558–561)

```
fn short_key_returns_stars()
```

**Purpose**: Verifies that short keys are fully redacted rather than partially exposed. This covers the conservative branch of key masking.

**Data flow**: Calls `safe_format_key` with a short sample key and asserts that the result is exactly `***`.

**Call relations**: This test complements `formats_long_key` by covering the short-key branch in `safe_format_key`.

*Call graph*: 1 external calls (assert_eq!).


### `app-server/src/request_processors/account_processor.rs`

`domain_logic` · `request handling and auth state changes`

This processor encapsulates all account/auth flows behind `AccountRequestProcessor`, which holds `AuthManager`, `ThreadManager`, `OutgoingMessageSender`, the current `Config`, a `ConfigManager`, and a mutex-protected `active_login` slot. `ActiveLogin` tracks either a browser-based login server (`ShutdownHandle`) or a device-code login (`CancellationToken`) plus a generated `Uuid`; its `Drop` implementation always cancels the underlying login attempt, so replacing or clearing the slot reliably aborts stale logins.

The public methods are thin JSON-RPC adapters that return `Option<ClientResponsePayload>` and delegate to internal response builders. Login handling branches by `LoginAccountParams`: API key login persists credentials locally unless external ChatGPT auth is active or config forces ChatGPT-only login; browser and device-code ChatGPT login validate config, start asynchronous login completion tasks, store the active attempt, and immediately return a login ID plus URL/code while completion notifications are emitted later; externally supplied ChatGPT auth tokens bypass the interactive flow but still reload auth and refresh cloud-config loader state. Successful login and logout paths refresh plugin caches based on the latest config and emit `AccountLoginCompleted` and/or `AccountUpdated` notifications.

Read-side methods expose auth status, account info, rate limits, and token usage. They carefully distinguish between Codex-backend auth and ChatGPT auth, optionally refresh tokens, and convert backend responses into protocol payloads. Notable edge cases include forced-login-method enforcement, workspace restrictions for external auth tokens, timeout-bounded token-usage fetches, and intentionally suppressing reusable token disclosure for auth modes that cannot be represented safely in the API response.

#### Function details

##### `ActiveLogin::login_id`  (lines 24–30)

```
fn login_id(&self) -> Uuid
```

**Purpose**: Returns the UUID associated with the current active login attempt regardless of login mode.

**Data flow**: Reads `self`, pattern-matches either `Browser` or `DeviceCode`, copies out the stored `Uuid`, and returns it.

**Call relations**: Used when deciding whether an `active_login` slot still refers to the same asynchronous login attempt before clearing it.


##### `ActiveLogin::cancel`  (lines 32–39)

```
fn cancel(&self)
```

**Purpose**: Cancels the underlying login attempt represented by this enum variant.

**Data flow**: Pattern-matches `self`; for `Browser` it calls `shutdown_handle.shutdown()`, and for `DeviceCode` it calls `cancel.cancel()`, mutating external login state but returning unit.

**Call relations**: Called by `Drop` and indirectly whenever an active login is replaced or explicitly canceled.

*Call graph*: called by 1 (drop).


##### `ActiveLogin::drop`  (lines 54–56)

```
fn drop(&mut self)
```

**Purpose**: Ensures any still-active login attempt is canceled when the `ActiveLogin` value is dropped.

**Data flow**: Receives `&mut self` during destruction and calls `self.cancel()`.

**Call relations**: This makes `guard.take()` plus `drop(active)` the standard cancellation mechanism throughout the processor.

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

**Purpose**: Constructs the account request processor and initializes its active-login slot as empty.

**Data flow**: Consumes auth/thread/outgoing/config/config-manager dependencies, wraps `None` in `Arc<Mutex<Option<ActiveLogin>>>`, stores all fields, and returns `Self`.

**Call relations**: Called by the top-level request-processor assembly code during app-server setup.

*Call graph*: called by 1 (new); 2 external calls (new, new).


##### `AccountRequestProcessor::login_account`  (lines 87–93)

```
async fn login_account(
        &self,
        request_id: ConnectionRequestId,
        params: LoginAccountParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for account login requests. It delegates to the internal multi-mode login implementation and suppresses an immediate payload because completion is handled by direct responses or notifications.

**Data flow**: Takes a `ConnectionRequestId` and `LoginAccountParams`, awaits `login_v2`, maps success to `None`, and returns `Result<Option<ClientResponsePayload>, JSONRPCErrorError>`.

**Call relations**: Invoked by the initialized request dispatcher for `account/login`.

*Call graph*: calls 1 internal fn (login_v2); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::logout_account`  (lines 95–100)

```
async fn logout_account(
        &self,
        request_id: ConnectionRequestId,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for logout requests.

**Data flow**: Takes a `ConnectionRequestId`, awaits `logout_v2`, maps success to `None`, and returns the JSON-RPC result wrapper.

**Call relations**: Invoked by the initialized request dispatcher for `account/logout`.

*Call graph*: calls 1 internal fn (logout_v2); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::cancel_login_account`  (lines 102–109)

```
async fn cancel_login_account(
        &self,
        params: CancelLoginAccountParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for canceling an in-progress interactive login attempt.

**Data flow**: Takes `CancelLoginAccountParams`, awaits `cancel_login_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for login-cancel requests.

*Call graph*: calls 1 internal fn (cancel_login_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_account`  (lines 111–118)

```
async fn get_account(
        &self,
        params: GetAccountParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for fetching account metadata from the active model provider.

**Data flow**: Takes `GetAccountParams`, awaits `get_account_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for `account/get`-style requests.

*Call graph*: calls 1 internal fn (get_account_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_auth_status`  (lines 120–127)

```
async fn get_auth_status(
        &self,
        params: GetAuthStatusParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for reporting whether auth is present and, optionally, exposing a reusable token.

**Data flow**: Takes `GetAuthStatusParams`, awaits `get_auth_status_response`, converts it into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for auth-status requests.

*Call graph*: calls 1 internal fn (get_auth_status_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_account_rate_limits`  (lines 129–135)

```
async fn get_account_rate_limits(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for fetching Codex backend rate-limit information.

**Data flow**: Awaits `get_account_rate_limits_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for rate-limit requests.

*Call graph*: calls 1 internal fn (get_account_rate_limits_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::get_account_token_usage`  (lines 137–143)

```
async fn get_account_token_usage(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for fetching token-usage statistics.

**Data flow**: Awaits `get_account_token_usage_response`, converts the typed response into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for token-usage requests.

*Call graph*: calls 1 internal fn (get_account_token_usage_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::send_add_credits_nudge_email`  (lines 145–152)

```
async fn send_add_credits_nudge_email(
        &self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: JSON-RPC adapter for requesting that the backend notify a workspace owner about adding credits.

**Data flow**: Takes `SendAddCreditsNudgeEmailParams`, awaits `send_add_credits_nudge_email_response`, converts it into `ClientResponsePayload`, wraps it in `Some`, and returns it.

**Call relations**: Invoked by the initialized request dispatcher for add-credits nudge requests.

*Call graph*: calls 1 internal fn (send_add_credits_nudge_email_response); called by 1 (handle_initialized_client_request).


##### `AccountRequestProcessor::cancel_active_login`  (lines 154–159)

```
async fn cancel_active_login(&self)
```

**Purpose**: Clears and cancels any currently active interactive login attempt.

**Data flow**: Locks `active_login`, takes the `Option<ActiveLogin>`, and drops it if present so `Drop` triggers cancellation.

**Call relations**: Used by broader runtime cleanup paths outside direct request handling.

*Call graph*: called by 1 (cancel_active_login).


##### `AccountRequestProcessor::clear_external_auth`  (lines 161–166)

```
fn clear_external_auth(&self)
```

**Purpose**: Removes externally managed auth state and synchronizes plugin auth mode with the new auth state.

**Data flow**: Calls `auth_manager.clear_external_auth()`, then reads the current API auth mode from `auth_manager` and passes it to `thread_manager.plugins_manager().set_auth_mode(...)`.

**Call relations**: Called during runtime cleanup/reset when externally injected auth should be discarded.

*Call graph*: called by 1 (clear_runtime_references).


##### `AccountRequestProcessor::current_account_updated_notification`  (lines 168–174)

```
fn current_account_updated_notification(&self) -> AccountUpdatedNotification
```

**Purpose**: Builds the current `AccountUpdatedNotification` payload from cached auth state.

**Data flow**: Reads `auth_manager.auth_cached()`, derives `auth_mode` via `CodexAuth::api_auth_mode` and `plan_type` via `CodexAuth::account_plan_type`, and returns the assembled notification struct.

**Call relations**: Used by `send_login_success_notifications` after successful non-interactive login flows.

*Call graph*: called by 1 (send_login_success_notifications).


##### `AccountRequestProcessor::maybe_refresh_plugin_caches_for_current_config`  (lines 176–214)

```
async fn maybe_refresh_plugin_caches_for_current_config(
        config_manager: &ConfigManager,
        thread_manager: &Arc<ThreadManager>,
        auth: Option<CodexAuth>,
    )
```

**Purpose**: Refreshes plugin-manager auth mode and remote plugin caches based on the latest config after account state changes. It also arranges a follow-up task to clear effective plugin/skill caches and refresh MCP state when needed.

**Data flow**: Takes a `ConfigManager`, `Arc<ThreadManager>`, and optional `CodexAuth`; updates plugin auth mode, clears recommended-plugin cache, loads the latest config, and on success calls `plugins_manager.maybe_start_remote_plugin_caches_refresh` with the config’s plugin input, current auth, and a callback that spawns `spawn_effective_plugins_changed_task`; on config reload failure it logs a warning and skips refresh.

**Call relations**: Called after successful login, logout, and successful ChatGPT login completion to keep plugin-derived state aligned with auth/config changes.

*Call graph*: calls 1 internal fn (load_latest_config); 4 external calls (clone, new, clone, warn!).


##### `AccountRequestProcessor::spawn_effective_plugins_changed_task`  (lines 216–228)

```
fn spawn_effective_plugins_changed_task(
        thread_manager: Arc<ThreadManager>,
        config_manager: ConfigManager,
    )
```

**Purpose**: Starts an asynchronous best-effort refresh after effective plugin state changes.

**Data flow**: Consumes `Arc<ThreadManager>` and `ConfigManager`, spawns a task that clears plugin and skills caches, returns early if there are no live threads, and otherwise awaits `crate::mcp_refresh::queue_best_effort_refresh`.

**Call relations**: Used as the callback installed by `maybe_refresh_plugin_caches_for_current_config` when remote plugin caches refresh.

*Call graph*: calls 1 internal fn (queue_best_effort_refresh); 1 external calls (spawn).


##### `AccountRequestProcessor::login_v2`  (lines 230–264)

```
async fn login_v2(
        &self,
        request_id: ConnectionRequestId,
        params: LoginAccountParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Dispatches a login request to the correct concrete login flow based on the `LoginAccountParams` variant.

**Data flow**: Matches on `params`; API key requests call `login_api_key_v2`, browser ChatGPT requests call `login_chatgpt_v2`, device-code requests call `login_chatgpt_device_code_v2`, and externally supplied auth tokens call `login_chatgpt_auth_tokens`; after the selected async side effect completes, it returns `Ok(())`.

**Call relations**: Called only by the public `login_account` adapter.

*Call graph*: calls 4 internal fn (login_api_key_v2, login_chatgpt_auth_tokens, login_chatgpt_device_code_v2, login_chatgpt_v2); called by 1 (login_account).


##### `AccountRequestProcessor::external_auth_active_error`  (lines 266–270)

```
fn external_auth_active_error(&self) -> JSONRPCErrorError
```

**Purpose**: Constructs the standard JSON-RPC error returned when a login flow is blocked by active external ChatGPT auth.

**Data flow**: Creates and returns an `invalid_request` error with a fixed explanatory message.

**Call relations**: Used by both API-key and interactive ChatGPT login validation paths.

*Call graph*: called by 2 (login_api_key_common, login_chatgpt_common).


##### `AccountRequestProcessor::login_api_key_common`  (lines 272–309)

```
async fn login_api_key_common(
        &self,
        params: &LoginApiKeyParams,
    ) -> std::result::Result<(), JSONRPCErrorError>
```

**Purpose**: Validates and persists an API key login, canceling any active interactive login first. It enforces config restrictions and reloads auth state on success.

**Data flow**: Reads current auth/config state; returns `external_auth_active_error` if external ChatGPT auth is active, returns `invalid_request` if config forces ChatGPT login, clears `active_login` by taking and dropping any existing attempt, calls `login_with_api_key` with Codex home and credential-store settings, reloads `auth_manager` on success, and otherwise returns an internal error describing the save failure.

**Call relations**: Used by `login_api_key_v2`, which wraps the result into a response and notifications.

*Call graph*: calls 1 internal fn (external_auth_active_error); called by 1 (login_api_key_v2); 2 external calls (format!, matches!).


##### `AccountRequestProcessor::login_api_key_v2`  (lines 311–323)

```
async fn login_api_key_v2(&self, request_id: ConnectionRequestId, params: LoginApiKeyParams)
```

**Purpose**: Executes API-key login, sends the direct JSON-RPC result to the requester, and emits account notifications on success.

**Data flow**: Calls `login_api_key_common`, maps success to `LoginAccountResponse::ApiKey {}`, records whether the result is `Ok`, sends the result through `outgoing.send_result(request_id, result)`, and if successful awaits `send_login_success_notifications(None)`.

**Call relations**: Selected by `login_v2` for `LoginAccountParams::ApiKey`.

*Call graph*: calls 2 internal fn (login_api_key_common, send_login_success_notifications); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_common`  (lines 326–365)

```
async fn login_chatgpt_common(
        &self,
        codex_streamlined_login: bool,
    ) -> std::result::Result<LoginServerOptions, JSONRPCErrorError>
```

**Purpose**: Builds validated `LoginServerOptions` for interactive ChatGPT login flows. It enforces auth/config restrictions and applies a debug-only issuer override.

**Data flow**: Reads config and auth state; rejects active external auth and API-only forced-login mode with `invalid_request`; constructs `LoginServerOptions` using Codex home, OAuth client ID, optional forced workspace ID, and credential-store settings, sets `open_browser` false and `codex_streamlined_login` from the argument, and in debug builds optionally overrides `issuer` from `CODEX_APP_SERVER_LOGIN_ISSUER` if non-empty.

**Call relations**: Shared by both browser-based and device-code ChatGPT login response builders.

*Call graph*: calls 1 internal fn (external_auth_active_error); called by 2 (login_chatgpt_device_code_response, login_chatgpt_response); 3 external calls (new, matches!, var).


##### `AccountRequestProcessor::login_chatgpt_device_code_start_error`  (lines 367–374)

```
fn login_chatgpt_device_code_start_error(err: IoError) -> JSONRPCErrorError
```

**Purpose**: Maps device-code startup I/O failures into user-facing JSON-RPC errors, distinguishing missing prerequisites from generic internal failures.

**Data flow**: Takes an `IoError`, checks `err.kind()`, returns `invalid_request(err.to_string())` for `NotFound`, otherwise returns `internal_error("failed to request device code: ...")`.

**Call relations**: Used when `request_device_code` fails during device-code login startup.

*Call graph*: 3 external calls (kind, to_string, format!).


##### `AccountRequestProcessor::login_chatgpt_v2`  (lines 376–383)

```
async fn login_chatgpt_v2(
        &self,
        request_id: ConnectionRequestId,
        codex_streamlined_login: bool,
    )
```

**Purpose**: Runs the browser-based ChatGPT login startup flow and sends its immediate JSON-RPC result.

**Data flow**: Awaits `login_chatgpt_response(codex_streamlined_login)` and forwards the resulting success or error through `outgoing.send_result(request_id, result)`.

**Call relations**: Selected by `login_v2` for interactive browser ChatGPT login.

*Call graph*: calls 1 internal fn (login_chatgpt_response); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_response`  (lines 385–450)

```
async fn login_chatgpt_response(
        &self,
        codex_streamlined_login: bool,
    ) -> Result<LoginAccountResponse, JSONRPCErrorError>
```

**Purpose**: Starts a browser-based ChatGPT login server, records it as the active login attempt, and spawns a background task that waits for completion or timeout and then emits completion notifications.

**Data flow**: Builds validated login options via `login_chatgpt_common`, starts `run_login_server`, generates a `login_id`, captures the server’s shutdown handle and auth URL, replaces any existing `active_login` with `ActiveLogin::Browser`, clones outgoing/config/thread/auth state, then spawns a task that waits up to `LOGIN_CHATGPT_TIMEOUT` for `server.block_until_done()`, converts success/failure/timeout into `(success, error_msg)`, calls `send_chatgpt_login_completion_notifications`, and clears `active_login` only if it still matches this `login_id`; the immediate return value is `LoginAccountResponse::Chatgpt { login_id, auth_url }`.

**Call relations**: Called by `login_chatgpt_v2`; its spawned task is the asynchronous completion half of the browser login flow.

*Call graph*: calls 1 internal fn (login_chatgpt_common); called by 1 (login_chatgpt_v2); 7 external calls (clone, send_chatgpt_login_completion_notifications, new_v4, clone, format!, spawn, timeout).


##### `AccountRequestProcessor::login_chatgpt_device_code_v2`  (lines 452–455)

```
async fn login_chatgpt_device_code_v2(&self, request_id: ConnectionRequestId)
```

**Purpose**: Runs the device-code ChatGPT login startup flow and sends its immediate JSON-RPC result.

**Data flow**: Awaits `login_chatgpt_device_code_response()` and forwards the result through `outgoing.send_result(request_id, result)`.

**Call relations**: Selected by `login_v2` for device-code ChatGPT login.

*Call graph*: calls 1 internal fn (login_chatgpt_device_code_response); called by 1 (login_v2).


##### `AccountRequestProcessor::login_chatgpt_device_code_response`  (lines 457–523)

```
async fn login_chatgpt_device_code_response(
        &self,
    ) -> Result<LoginAccountResponse, JSONRPCErrorError>
```

**Purpose**: Starts a device-code login attempt, stores it as the active login, and spawns a background task that waits for either cancellation or login completion before emitting notifications.

**Data flow**: Builds login options via `login_chatgpt_common(false)`, requests a device code, generates a `login_id`, creates a `CancellationToken`, replaces any existing `active_login` with `ActiveLogin::DeviceCode`, captures verification URL and user code for the immediate response, then spawns a task that `select!`s between `cancel.cancelled()` and `complete_device_code_login(opts, device_code)`, converts the outcome into `(success, error_msg)`, calls `send_chatgpt_login_completion_notifications`, and clears `active_login` if it still matches this login ID; returns `LoginAccountResponse::ChatgptDeviceCode { login_id, verification_url, user_code }`.

**Call relations**: Called by `login_chatgpt_device_code_v2`; mirrors the browser flow but with explicit cancellation token semantics.

*Call graph*: calls 1 internal fn (login_chatgpt_common); called by 1 (login_chatgpt_device_code_v2); 7 external calls (clone, new, send_chatgpt_login_completion_notifications, new_v4, clone, select!, spawn).


##### `AccountRequestProcessor::cancel_login_chatgpt_common`  (lines 525–538)

```
async fn cancel_login_chatgpt_common(
        &self,
        login_id: Uuid,
    ) -> std::result::Result<(), CancelLoginError>
```

**Purpose**: Cancels the active interactive login only if its login ID matches the caller’s requested ID.

**Data flow**: Locks `active_login`, compares the stored login ID to the supplied `Uuid`, and if equal takes and drops the active login to trigger cancellation, returning `Ok(())`; otherwise returns `Err(CancelLoginError::NotFound)`.

**Call relations**: Used by `cancel_login_response` after parsing the client-supplied login ID.

*Call graph*: called by 1 (cancel_login_response).


##### `AccountRequestProcessor::cancel_login_response`  (lines 540–552)

```
async fn cancel_login_response(
        &self,
        params: CancelLoginAccountParams,
    ) -> Result<CancelLoginAccountResponse, JSONRPCErrorError>
```

**Purpose**: Parses the requested login ID and returns a typed cancel-login status response.

**Data flow**: Reads `params.login_id`, parses it as `Uuid`, returning `invalid_request` on parse failure; then calls `cancel_login_chatgpt_common` and maps success to `CancelLoginAccountStatus::Canceled` and not-found to `CancelLoginAccountStatus::NotFound`, finally returning `CancelLoginAccountResponse { status }`.

**Call relations**: Called by the public `cancel_login_account` adapter.

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

**Purpose**: Processes externally supplied ChatGPT auth tokens, sends the direct JSON-RPC result, and emits account notifications on success.

**Data flow**: Calls `login_chatgpt_auth_tokens_response(access_token, chatgpt_account_id, chatgpt_plan_type)`, records whether it succeeded, sends the result through `outgoing.send_result`, and if successful calls `send_login_success_notifications(None)`.

**Call relations**: Selected by `login_v2` for `LoginAccountParams::ChatgptAuthTokens`.

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

**Purpose**: Validates and persists externally managed ChatGPT auth tokens, then reloads auth and cloud-config state.

**Data flow**: Rejects API-only forced-login mode, clears any active interactive login, validates `chatgpt_account_id` against `forced_chatgpt_workspace_id` if configured, calls `login_with_chatgpt_auth_tokens` to persist the external auth, reloads `auth_manager`, updates `config_manager`’s cloud-config bundle loader using the current auth manager and `chatgpt_base_url`, syncs default client residency requirement, and returns `LoginAccountResponse::ChatgptAuthTokens {}` or an internal/invalid-request error.

**Call relations**: Called by `login_chatgpt_auth_tokens`, which handles response sending and notifications.

*Call graph*: calls 2 internal fn (replace_cloud_config_bundle_loader, sync_default_client_residency_requirement); called by 1 (login_chatgpt_auth_tokens); 2 external calls (format!, matches!).


##### `AccountRequestProcessor::send_login_success_notifications`  (lines 623–647)

```
async fn send_login_success_notifications(&self, login_id: Option<Uuid>)
```

**Purpose**: Emits the standard post-login notifications and refreshes plugin caches for the current auth/config state.

**Data flow**: Calls `maybe_refresh_plugin_caches_for_current_config` with current cached auth, builds `AccountLoginCompletedNotification { login_id, success: true, error: None }`, sends it as `ServerNotification::AccountLoginCompleted`, then builds and sends `ServerNotification::AccountUpdated` using `current_account_updated_notification()`.

**Call relations**: Used after successful API-key and external-auth-token login flows.

*Call graph*: calls 1 internal fn (current_account_updated_notification); called by 2 (login_api_key_v2, login_chatgpt_auth_tokens); 3 external calls (maybe_refresh_plugin_caches_for_current_config, AccountLoginCompleted, AccountUpdated).


##### `AccountRequestProcessor::send_chatgpt_login_completion_notifications`  (lines 649–691)

```
async fn send_chatgpt_login_completion_notifications(
        outgoing: &OutgoingMessageSender,
        config_manager: ConfigManager,
        thread_manager: Arc<ThreadManager>,
        chatgpt_base_
```

**Purpose**: Handles the asynchronous completion side of interactive ChatGPT login by notifying clients and, on success, reloading auth/config/plugin state.

**Data flow**: Sends `AccountLoginCompleted` with the supplied `login_id`, `success`, and optional error message; if `success` is true, reloads auth through `thread_manager.auth_manager()`, updates the cloud-config bundle loader and residency requirement in `config_manager`, refreshes plugin caches via `maybe_refresh_plugin_caches_for_current_config`, builds an `AccountUpdatedNotification` from the refreshed auth, and sends it.

**Call relations**: Called from the background tasks spawned by both interactive ChatGPT login startup methods.

*Call graph*: calls 3 internal fn (replace_cloud_config_bundle_loader, sync_default_client_residency_requirement, send_server_notification); 4 external calls (maybe_refresh_plugin_caches_for_current_config, AccountLoginCompleted, AccountUpdated, to_string).


##### `AccountRequestProcessor::logout_common`  (lines 693–722)

```
async fn logout_common(&self) -> std::result::Result<Option<AuthMode>, JSONRPCErrorError>
```

**Purpose**: Performs the shared logout work: cancel active login, revoke/logout auth, refresh plugin caches, and report the resulting auth mode.

**Data flow**: Clears `active_login` by taking and dropping any current attempt, awaits `auth_manager.logout_with_revoke()`, maps failures to `internal_error`, refreshes plugin caches with current cached auth, then returns the post-logout `Option<AuthMode>` derived from `auth_manager.auth_cached()`.

**Call relations**: Used by `logout_v2`, which wraps the result into a response and notification.

*Call graph*: called by 1 (logout_v2); 2 external calls (maybe_refresh_plugin_caches_for_current_config, format!).


##### `AccountRequestProcessor::logout_v2`  (lines 724–745)

```
async fn logout_v2(&self, request_id: ConnectionRequestId) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Executes logout, sends the direct JSON-RPC response, and emits an `AccountUpdated` notification if logout succeeded.

**Data flow**: Awaits `logout_common`, derives an optional `AccountUpdatedNotification` from the successful result, sends `LogoutAccountResponse {}` or the error through `outgoing.send_result`, and if a notification payload was produced sends it as `ServerNotification::AccountUpdated`.

**Call relations**: Called by the public `logout_account` adapter.

*Call graph*: calls 1 internal fn (logout_common); called by 1 (logout_account); 1 external calls (AccountUpdated).


##### `AccountRequestProcessor::refresh_token_if_requested`  (lines 747–760)

```
async fn refresh_token_if_requested(&self, do_refresh: bool) -> RefreshTokenRequestOutcome
```

**Purpose**: Optionally refreshes the current auth token and classifies the outcome as success/not-attempted, transient failure, or permanent failure.

**Data flow**: If external ChatGPT auth is active, immediately returns `NotAttemptedOrSucceeded`; otherwise, when `do_refresh` is true it awaits `auth_manager.refresh_token()`, logs a warning and returns `FailedTransiently` if the error has no permanent failed reason, returns `FailedPermanently` if it does, and returns `NotAttemptedOrSucceeded` in all success or no-refresh cases.

**Call relations**: Used by both auth-status and account-info reads before they inspect current auth state.

*Call graph*: called by 2 (get_account_response, get_auth_status_response); 1 external calls (warn!).


##### `AccountRequestProcessor::get_auth_status_response`  (lines 762–830)

```
async fn get_auth_status_response(
        &self,
        params: GetAuthStatusParams,
    ) -> Result<GetAuthStatusResponse, JSONRPCErrorError>
```

**Purpose**: Builds the auth-status response, including whether OpenAI auth is required and, in limited cases, a reusable auth token.

**Data flow**: Reads `include_token` and `refresh_token` flags from params, calls `refresh_token_if_requested`, checks `config.model_provider.requires_openai_auth`, and if auth is not required returns a response with `requires_openai_auth: Some(false)` and no auth fields; otherwise it obtains auth from either `auth_cached()` or `auth().await`, suppresses token disclosure for agent identity/personal access token auth or permanent refresh failures, attempts `auth.get_token()` when disclosure is allowed, logs token-read failures, and returns `GetAuthStatusResponse` with `auth_method`, optional `auth_token`, and `requires_openai_auth: Some(true)`.

**Call relations**: Called by the public `get_auth_status` adapter.

*Call graph*: calls 1 internal fn (refresh_token_if_requested); called by 1 (get_auth_status); 2 external calls (matches!, warn!).


##### `AccountRequestProcessor::get_account_response`  (lines 832–854)

```
async fn get_account_response(
        &self,
        params: GetAccountParams,
    ) -> Result<GetAccountResponse, JSONRPCErrorError>
```

**Purpose**: Builds account metadata using the currently configured model provider and current auth state.

**Data flow**: Reads `refresh_token` from params, calls `refresh_token_if_requested`, constructs a provider via `create_model_provider(self.config.model_provider.clone(), Some(self.auth_manager.clone()))`, obtains `account_state`, maps provider construction/account-state errors to `invalid_request`, converts any returned account into protocol `Account`, and returns `GetAccountResponse { account, requires_openai_auth }`.

**Call relations**: Called by the public `get_account` adapter.

*Call graph*: calls 1 internal fn (refresh_token_if_requested); called by 1 (get_account).


##### `AccountRequestProcessor::get_account_rate_limits_response`  (lines 856–917)

```
async fn get_account_rate_limits_response(
        &self,
    ) -> Result<GetAccountRateLimitsResponse, JSONRPCErrorError>
```

**Purpose**: Fetches Codex backend rate-limit snapshots and reset-credit summary, then maps them into the protocol response shape.

**Data flow**: Awaits `auth_manager.auth()`, rejects missing auth or non-Codex-backend auth with `invalid_request`, constructs a `BackendClient` from `chatgpt_base_url` and auth, fetches `get_rate_limits_with_reset_credits()`, errors if no snapshots are returned, builds a `HashMap` keyed by `limit_id` defaulting missing IDs to `"codex"`, selects the `codex` snapshot if present or the first snapshot otherwise, converts snapshots and optional reset-credit summary into protocol types, and returns `GetAccountRateLimitsResponse`.

**Call relations**: Called by the public `get_account_rate_limits` adapter.

*Call graph*: called by 1 (get_account_rate_limits); 1 external calls (from_auth).


##### `AccountRequestProcessor::get_account_token_usage_response`  (lines 919–944)

```
async fn get_account_token_usage_response(
        &self,
    ) -> Result<GetAccountTokenUsageResponse, JSONRPCErrorError>
```

**Purpose**: Fetches token-usage statistics from the Codex backend under a timeout and maps them into the protocol response.

**Data flow**: Awaits current auth, rejects missing or non-Codex-backend auth, constructs a `BackendClient`, wraps `client.get_token_usage_profile()` in a 10-second timeout, maps timeout and backend failures to internal errors, then converts the returned `TokenUsageProfile` via `account_token_usage_response`.

**Call relations**: Called by the public `get_account_token_usage` adapter.

*Call graph*: called by 1 (get_account_token_usage); 3 external calls (from_auth, account_token_usage_response, timeout).


##### `AccountRequestProcessor::account_token_usage_response`  (lines 946–966)

```
fn account_token_usage_response(profile: TokenUsageProfile) -> GetAccountTokenUsageResponse
```

**Purpose**: Purely maps backend token-usage profile statistics into the app-server protocol response type.

**Data flow**: Consumes a `TokenUsageProfile`, reads `profile.stats`, copies summary counters into `AccountTokenUsageSummary`, maps optional daily buckets into `AccountTokenUsageDailyBucket` values, and returns `GetAccountTokenUsageResponse`.

**Call relations**: Used by `get_account_token_usage_response` and directly by the unit test in this file.

*Call graph*: called by 1 (account_token_usage_response_maps_profile_stats_and_daily_buckets).


##### `AccountRequestProcessor::send_add_credits_nudge_email_response`  (lines 968–975)

```
async fn send_add_credits_nudge_email_response(
        &self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> Result<SendAddCreditsNudgeEmailResponse, JSONRPCErrorError>
```

**Purpose**: Wraps the inner add-credits nudge operation in the typed protocol response object.

**Data flow**: Awaits `send_add_credits_nudge_email_inner(params)`, maps the returned status into `SendAddCreditsNudgeEmailResponse { status }`, and returns it.

**Call relations**: Called by the public `send_add_credits_nudge_email` adapter.

*Call graph*: calls 1 internal fn (send_add_credits_nudge_email_inner); called by 1 (send_add_credits_nudge_email).


##### `AccountRequestProcessor::send_add_credits_nudge_email_inner`  (lines 977–1008)

```
async fn send_add_credits_nudge_email_inner(
        &self,
        params: SendAddCreditsNudgeEmailParams,
    ) -> Result<AddCreditsNudgeEmailStatus, JSONRPCErrorError>
```

**Purpose**: Calls the backend to request an add-credits nudge email and maps backend outcomes into protocol statuses.

**Data flow**: Awaits current auth, rejects missing or non-Codex-backend auth, constructs a `BackendClient`, calls `send_add_credits_nudge_email` with the mapped backend credit type, returns `AddCreditsNudgeEmailStatus::Sent` on success, `CooldownActive` on HTTP 429, and otherwise an internal error describing the backend failure.

**Call relations**: Used only by `send_add_credits_nudge_email_response`.

*Call graph*: called by 1 (send_add_credits_nudge_email_response); 3 external calls (from_auth, backend_credit_type, format!).


##### `AccountRequestProcessor::backend_credit_type`  (lines 1010–1015)

```
fn backend_credit_type(value: AddCreditsNudgeCreditType) -> BackendAddCreditsNudgeCreditType
```

**Purpose**: Converts the protocol credit-type enum into the backend client’s corresponding enum.

**Data flow**: Matches `AddCreditsNudgeCreditType::Credits` or `UsageLimit` and returns the corresponding `BackendAddCreditsNudgeCreditType` variant.

**Call relations**: Used by `send_add_credits_nudge_email_inner` before calling the backend.


##### `tests::account_token_usage_response_maps_profile_stats_and_daily_buckets`  (lines 1026–1057)

```
fn account_token_usage_response_maps_profile_stats_and_daily_buckets()
```

**Purpose**: Verifies that backend token-usage profile fields are copied into the protocol response without loss or renaming mistakes.

**Data flow**: Constructs a `TokenUsageProfile` with summary stats and one daily bucket, calls `AccountRequestProcessor::account_token_usage_response`, and asserts exact equality with the expected `GetAccountTokenUsageResponse`.

**Call relations**: Unit test for the pure mapping helper.

*Call graph*: calls 1 internal fn (account_token_usage_response); 2 external calls (assert_eq!, vec!).


### Login flow orchestration
These files define the login crate surface and implement the interactive browser and device-code ChatGPT login paths, including onboarding-time headless UX.

### `login/src/lib.rs`

`orchestration` · `cross-cutting`

This is the crate root for the login library. It declares the major modules—`auth`, environment telemetry, token data, device-code authentication, PKCE support, and the local login server—and then re-exports the subset intended for external use. The result is a flattened API where consumers can import login functionality from the crate root instead of navigating internal module paths.

The file exposes several categories of functionality. From `auth`, it re-exports configuration types (`AuthConfig`, `AuthManagerConfig`, `AuthDotJson`, `AuthKeyringBackendKind`), runtime managers (`AuthManager`), credential representations (`CodexAuth`, `ExternalAuth`, token refresh context/reason types), environment variable constants, and operational functions such as login, logout, token loading, and persistence. From device-code auth it exports the `DeviceCode` type and the request/complete/run helpers. From the embedded server module it exports `LoginServer`, `ServerOptions`, `ShutdownHandle`, and `run_login_server`. It also aliases `codex_client::BuildCustomCaTransportError` as `BuildLoginHttpClientError`, making the login crate the integration point for HTTP transport setup errors.

The design choice here is API consolidation: internal modules like `pkce` remain private, while externally meaningful types and workflows are promoted to the crate root. This file contains no runtime logic, but it defines how the rest of the system discovers and depends on login capabilities.


### `login/src/device_code_auth.rs`

`domain_logic` · `interactive login`

This module encapsulates the non-localhost OAuth device authorization flow. `DeviceCode` stores the browser verification URL and user-facing code plus the internal `device_auth_id` and polling interval returned by the server. The server’s interval field is deserialized by `deserialize_interval`, which accepts string-encoded numbers and trims whitespace before parsing.

`request_user_code` posts `UserCodeReq { client_id }` as JSON to `{auth_base_url}/deviceauth/usercode`. It treats HTTP 404 specially, returning a `NotFound` error that explicitly tells the caller device-code login is not enabled on that server; other non-success statuses become generic request-failed errors. `poll_for_token` then repeatedly posts `TokenPollReq { device_auth_id, user_code }` to `/deviceauth/token` until success or a 15-minute timeout. HTTP 403 and 404 are interpreted as “not ready yet” and trigger a sleep for the server-provided interval, capped by remaining timeout; any other non-success status aborts immediately.

`request_device_code` builds a reqwest client with custom CA support, normalizes the issuer URL, requests the user code, and returns a `DeviceCode` whose verification URL points to `/codex/device`. `complete_device_code_login` polls for the authorization code, reconstructs `PkceCodes` from the server response, exchanges the code through the shared OAuth token-exchange logic in `server.rs`, enforces optional workspace restrictions, and persists tokens asynchronously. `run_device_code_login` is the user-facing orchestration entry that prints a colored terminal prompt before waiting for completion.

#### Function details

##### `deserialize_interval`  (lines 46–52)

```
fn deserialize_interval(deserializer: D) -> Result<u64, D::Error>
```

**Purpose**: Custom serde deserializer for the device-auth polling interval field when the server encodes it as a string.

**Data flow**: Receives a serde `Deserializer`, deserializes a `String`, trims it, parses it as `u64`, and returns either the parsed interval or a serde custom error.

**Call relations**: Used by `UserCodeResp` deserialization so `request_user_code` can accept the server’s interval format without post-processing.

*Call graph*: 1 external calls (deserialize).


##### `request_user_code`  (lines 62–96)

```
async fn request_user_code(
    client: &reqwest::Client,
    auth_base_url: &str,
    client_id: &str,
) -> std::io::Result<UserCodeResp>
```

**Purpose**: Requests a device authorization session and user code from the auth server.

**Data flow**: Takes a reqwest client, auth base URL, and client ID; formats the `/deviceauth/usercode` URL; serializes `UserCodeReq` to JSON; sends a POST with `Content-Type: application/json`; and on success reads the body text and deserializes `UserCodeResp`. A 404 becomes an `io::ErrorKind::NotFound` with a specific explanatory message; other non-success statuses become generic `io::Error::other` failures.

**Call relations**: Called by `request_device_code` as the first network step of the device-code flow. It isolates the initial session-creation protocol and its special 404 handling.

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

**Purpose**: Polls the device-auth token endpoint until the user completes authorization or the 15-minute window expires.

**Data flow**: Accepts a reqwest client, auth base URL, device auth ID, user code, and polling interval. It loops until timeout, serializing `TokenPollReq` each iteration and POSTing to `/deviceauth/token`. Success returns the JSON-decoded `CodeSuccessResp`. HTTP 403/404 trigger a sleep for `min(interval, remaining_time)` and retry; once elapsed time reaches 15 minutes, those statuses instead produce a timeout error. Any other non-success status returns an immediate error containing the status code.

**Call relations**: Invoked by `complete_device_code_login` after the user code has been displayed. It is the long-running wait loop of the device-code flow.

*Call graph*: called by 1 (complete_device_code_login); 7 external calls (from_secs, now, post, other, format!, to_string, sleep).


##### `print_device_code_prompt`  (lines 148–157)

```
fn print_device_code_prompt(verification_url: &str, code: &str)
```

**Purpose**: Prints the terminal instructions telling the user where to sign in and which one-time code to enter.

**Data flow**: Reads the crate version via `env!("CARGO_PKG_VERSION")`, interpolates ANSI color constants, the verification URL, and the user code into a formatted `println!`, and writes the prompt to stdout.

**Call relations**: Called by `run_device_code_login` after `request_device_code` succeeds, before polling begins, so the user can complete authorization in a browser.

*Call graph*: called by 1 (run_device_code_login); 2 external calls (env!, println!).


##### `request_device_code`  (lines 159–171)

```
async fn request_device_code(opts: &ServerOptions) -> std::io::Result<DeviceCode>
```

**Purpose**: High-level helper that creates the HTTP client, requests the device code, and returns the user-facing `DeviceCode` bundle.

**Data flow**: Accepts `&ServerOptions`, builds a reqwest client with `build_reqwest_client_with_custom_ca`, trims trailing slashes from `opts.issuer`, derives `{base}/api/accounts`, calls `request_user_code`, and maps the response into `DeviceCode { verification_url, user_code, device_auth_id, interval }`.

**Call relations**: This is the first half of `run_device_code_login`, wrapping client setup and endpoint construction around `request_user_code`.

*Call graph*: calls 1 internal fn (request_user_code); called by 1 (run_device_code_login); 3 external calls (builder, build_reqwest_client_with_custom_ca, format!).


##### `complete_device_code_login`  (lines 173–223)

```
async fn complete_device_code_login(
    opts: ServerOptions,
    device_code: DeviceCode,
) -> std::io::Result<()>
```

**Purpose**: Finishes device-code login by polling for authorization, exchanging the resulting code for tokens, validating workspace restrictions, and persisting credentials.

**Data flow**: Consumes `ServerOptions` and `DeviceCode`, builds a reqwest client, derives the API base URL, awaits `poll_for_token`, reconstructs `PkceCodes` from the returned verifier/challenge, computes the device callback redirect URI, exchanges the authorization code via `crate::server::exchange_code_for_tokens`, maps exchange failures into `io::Error`, checks workspace restrictions with `ensure_workspace_allowed`, and finally persists the tokens with `persist_tokens_async` using the configured auth storage mode and keyring backend.

**Call relations**: Called by `run_device_code_login` after the prompt is shown. It reuses shared token-exchange and persistence logic from `server.rs` so device-code login lands in the same local auth format as browser login.

*Call graph*: calls 4 internal fn (poll_for_token, ensure_workspace_allowed, exchange_code_for_tokens, persist_tokens_async); called by 1 (run_device_code_login); 4 external calls (builder, new, build_reqwest_client_with_custom_ca, format!).


##### `run_device_code_login`  (lines 225–229)

```
async fn run_device_code_login(opts: ServerOptions) -> std::io::Result<()>
```

**Purpose**: Top-level orchestration for the device-code login flow.

**Data flow**: Takes `ServerOptions`, requests a `DeviceCode` with `request_device_code`, prints the prompt with `print_device_code_prompt`, and then awaits `complete_device_code_login`, returning its final `io::Result<()>`.

**Call relations**: This is the public entry used by higher-level login commands when device-code auth is selected.

*Call graph*: calls 3 internal fn (complete_device_code_login, print_device_code_prompt, request_device_code).


### `login/src/server.rs`

`orchestration` · `interactive login / callback handling`

This module is the heart of interactive OAuth login. `ServerOptions` carries all runtime configuration: Codex home, OAuth client ID and issuer, callback port, browser-opening behavior, optional forced state, optional workspace restrictions, streamlined-login flag, and auth storage settings. `run_login_server` generates PKCE and state, binds a localhost `tiny_http::Server` with retry/cancel/fallback-port logic, builds the authorize URL, optionally opens the browser, and bridges blocking `server.recv()` calls into an async `tokio::mpsc` channel. The returned `LoginServer` exposes the auth URL, actual bound port, and cancellation controls.

`process_request` handles `/auth/callback`, `/success`, and `/cancel`. The callback path parses query parameters, logs only reviewed booleans and path/state validity, rejects state mismatches, converts OAuth callback errors into branded HTML error pages, exchanges the authorization code for tokens, optionally obtains an API-key-style token via token exchange, enforces workspace restrictions from JWT claims, persists credentials, and redirects to a localhost success page carrying selected claims-derived parameters. Success and terminal error responses use `HandledRequest::ResponseAndExit`, and `send_response_with_disconnect` manually writes HTTP with `Connection: close` to avoid tiny_http keep-alive hangs across repeated login attempts.

The file also contains careful redaction utilities for URLs and reqwest transport errors, preserving useful structured logs without leaking tokens, codes, fragments, or embedded credentials. Shared helpers parse token endpoint errors, decode JWT auth claims, validate workspace restrictions, render branded HTML error pages with escaping, and persist exchanged tokens into `AuthDotJson` via the configured storage backend. Tests focus on error parsing, URL redaction, success URL composition, and safe HTML rendering.

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

**Purpose**: Constructs a login-server configuration with default issuer, default callback port, browser opening enabled, and no forced state.

**Data flow**: Takes `codex_home`, `client_id`, optional forced workspace IDs, auth storage mode, and keyring backend kind; fills the remaining fields with `DEFAULT_ISSUER`, `DEFAULT_PORT`, `open_browser: true`, `force_state: None`, and `codex_streamlined_login: false`; and returns the populated `ServerOptions`.

**Call relations**: Used by higher-level login entrypoints and tests as the standard way to initialize browser-login configuration before passing it into `run_login_server` or device-code helpers.

*Call graph*: called by 8 (login_with_chatgpt, run_login_with_device_code, run_login_with_device_code_fallback_to_browser, file_reads_reject_named_pipes, device_code_login_integration_handles_error_payload, device_code_login_integration_persists_without_api_key_on_exchange_failure, server_opts, falls_back_to_registered_fallback_port_when_default_port_is_in_use).


##### `LoginServer::block_until_done`  (lines 110–114)

```
async fn block_until_done(self) -> io::Result<()>
```

**Purpose**: Waits for the spawned async callback loop to finish and converts task panics into `io::Error`.

**Data flow**: Consumes `self`, awaits `self.server_handle`, maps join errors into `io::Error::other("login server thread panicked: ...")`, and otherwise returns the inner `io::Result<()>` from the callback loop.

**Call relations**: Called by higher-level login orchestration after starting the server to wait for either successful completion, cancellation, or callback failure.


##### `LoginServer::cancel`  (lines 117–119)

```
fn cancel(&self)
```

**Purpose**: Requests shutdown of the running login server.

**Data flow**: Borrows `self` and calls `self.shutdown_handle.shutdown()`, producing no return value.

**Call relations**: This is the convenience cancellation API for callers holding a `LoginServer`; it delegates the actual notification to `ShutdownHandle::shutdown`.

*Call graph*: calls 1 internal fn (shutdown).


##### `LoginServer::cancel_handle`  (lines 122–124)

```
fn cancel_handle(&self) -> ShutdownHandle
```

**Purpose**: Returns a cloneable shutdown handle that can be used to cancel the login server from elsewhere.

**Data flow**: Clones `self.shutdown_handle` and returns the clone.

**Call relations**: Used when callers need cancellation capability without moving or borrowing the full `LoginServer`.

*Call graph*: 1 external calls (clone).


##### `ShutdownHandle::shutdown`  (lines 135–137)

```
fn shutdown(&self)
```

**Purpose**: Signals the async login loop to terminate.

**Data flow**: Calls `self.shutdown_notify.notify_one()` on the shared `tokio::sync::Notify` and returns `()`. No external state beyond the notification primitive is mutated.

**Call relations**: Invoked by `LoginServer::cancel`; the async loop in `run_login_server` listens for this notification in a `tokio::select!` and exits with a cancellation error.

*Call graph*: called by 1 (cancel).


##### `run_login_server`  (lines 141–251)

```
fn run_login_server(opts: ServerOptions) -> io::Result<LoginServer>
```

**Purpose**: Starts the localhost callback server, constructs the browser authorization URL, and spawns the async request-processing loop.

**Data flow**: Consumes `ServerOptions`, generates PKCE with `generate_pkce`, chooses state from `force_state` or `generate_state`, binds a `tiny_http::Server` via `bind_server`, extracts the actual port, builds `redirect_uri` and `auth_url` with `build_authorize_url`, optionally opens the browser, spawns a blocking thread that forwards `server.recv()` requests into a Tokio channel, creates a shutdown notifier, and spawns an async loop that selects between shutdown and incoming requests. Each request is passed to `process_request`; depending on the returned `HandledRequest`, the loop responds normally, responds and exits, or redirects. Before returning, it packages `auth_url`, `actual_port`, the join handle, and a `ShutdownHandle` into `LoginServer`.

**Call relations**: This is the main browser-login entrypoint. It orchestrates PKCE/state generation, server binding, browser launch, request bridging, and callback processing, delegating protocol details to helpers like `build_authorize_url`, `bind_server`, and `process_request`.

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

**Purpose**: Processes a single HTTP request received by the localhost login server and decides whether to continue serving or terminate the login flow.

**Data flow**: Accepts the raw request URL, server options, redirect URI, PKCE codes, actual port, and expected state. It parses the URL against `http://localhost`, returning a 400 response on parse failure. For `/auth/callback`, it collects query params into a `HashMap`, computes booleans for logging, validates state, handles OAuth callback errors via `oauth_callback_error_message` and `login_error_response`, extracts the authorization code, exchanges it with `exchange_code_for_tokens`, validates workspace restrictions with `ensure_workspace_allowed`, optionally obtains an API key with `obtain_api_key`, persists credentials with `persist_tokens_async`, and redirects to the success URL from `compose_success_url`. For `/success`, it serves either `success.html` or `success_legacy.html` and exits successfully. For `/cancel`, it returns a terminal cancellation response. Any other path yields a 404 response.

**Call relations**: Called from the async loop inside `run_login_server` for every incoming request. It is the central dispatcher that ties together token exchange, workspace validation, persistence, redirect generation, and branded error handling.

*Call graph*: calls 7 internal fn (compose_success_url, ensure_workspace_allowed, exchange_code_for_tokens, login_error_response, oauth_callback_error_message, obtain_api_key, persist_tokens_async); 15 external calls (from_bytes, new, new, from_string, eprintln!, error!, format!, include_str!, info!, RedirectWithHeader (+5 more)).


##### `send_response_with_disconnect`  (lines 450–483)

```
fn send_response_with_disconnect(
    req: Request,
    mut headers: Vec<Header>,
    body: Vec<u8>,
) -> io::Result<()>
```

**Purpose**: Writes a terminal HTTP response manually and forces `Connection: close` so tiny_http does not leave stale keep-alive connections hanging.

**Data flow**: Consumes a `tiny_http::Request`, mutable headers, and a body. It obtains the raw writer with `into_writer`, writes the status line for HTTP 200, removes any existing `Connection` header, appends `Connection: close`, computes and appends `Content-Length`, writes all headers and the body bytes, and flushes the writer.

**Call relations**: Used by the `run_login_server` async loop when `process_request` returns `HandledRequest::ResponseAndExit`, specifically for terminal success/error/cancel responses where the connection must be closed to avoid future login hangs.

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

**Purpose**: Constructs the OAuth authorize URL for browser login, including PKCE, state, scopes, originator, and optional workspace restrictions.

**Data flow**: Accepts issuer, client ID, redirect URI, PKCE codes, state, and optional allowed workspace IDs. It builds a vector of query key/value pairs including response type, client ID, redirect URI, fixed scopes, `code_challenge`, `code_challenge_method=S256`, organization inclusion, simplified-flow flag, state, and `originator().value`; if workspace IDs are provided, it adds `allowed_workspace_id` as a comma-joined string. It URL-encodes values, joins the query string, and returns `{issuer}/oauth/authorize?...`.

**Call relations**: Called by `run_login_server` after binding the callback server so the browser can be directed to the correct OAuth authorization endpoint.

*Call graph*: called by 1 (run_login_server); 2 external calls (format!, vec!).


##### `generate_state`  (lines 523–527)

```
fn generate_state() -> String
```

**Purpose**: Generates a random OAuth state token for CSRF protection.

**Data flow**: Fills a 32-byte array with random bytes using `rand::rng().fill_bytes`, base64url-encodes it without padding, and returns the resulting string.

**Call relations**: Used by `run_login_server` when the caller has not supplied `force_state`, ensuring callback requests can be validated in `process_request`.

*Call graph*: 1 external calls (rng).


##### `send_cancel_request`  (lines 529–544)

```
fn send_cancel_request(port: u16) -> io::Result<()>
```

**Purpose**: Attempts to contact an already-running login server on localhost and trigger its `/cancel` endpoint so a new server can bind the port.

**Data flow**: Formats `127.0.0.1:{port}` into a `SocketAddr`, connects with a 2-second timeout, sets read/write timeouts, writes a minimal `GET /cancel` HTTP request with `Connection: close`, reads a small response buffer opportunistically, and returns `Ok(())` unless connection/setup/write fails.

**Call relations**: Called by `bind_server` when the preferred port appears occupied, as a best-effort way to shut down a stale previous login server before retrying.

*Call graph*: called by 1 (bind_server); 3 external calls (from_secs, connect_timeout, format!).


##### `bind_server`  (lines 546–604)

```
fn bind_server(port: u16) -> io::Result<Server>
```

**Purpose**: Binds the localhost callback server, retrying on address-in-use, attempting to cancel stale servers, and falling back from the default port to the registered fallback port when necessary.

**Data flow**: Starts with `127.0.0.1:{port}` and tracks whether cancellation has been attempted, how many retries have occurred, and whether the fallback port is in use. In a loop it calls `Server::http(&bind_address)`. On success it returns the server. On address-in-use errors it optionally calls `send_cancel_request(port)` once for the preferred port, sleeps 200 ms, and retries up to 10 times. If the original requested port was `DEFAULT_PORT` and retries are exhausted, it logs a warning and switches to `FALLBACK_PORT`; otherwise it returns `io::ErrorKind::AddrInUse`. Non-address-in-use errors are returned as `io::Error::other`.

**Call relations**: Called by `run_login_server` before any browser interaction. It encapsulates the operational robustness around stale localhost servers and registered fallback-port behavior.

*Call graph*: calls 1 internal fn (send_cancel_request); called by 1 (run_login_server); 8 external calls (from_millis, http, new, other, eprintln!, format!, sleep, warn!).


##### `TokenEndpointErrorDetail::fmt`  (lines 621–623)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats token-endpoint error detail using only its display message.

**Data flow**: Reads `self.display_message` and writes it into the provided formatter, returning the formatting result.

**Call relations**: Used implicitly when `exchange_code_for_tokens` includes parsed token-endpoint detail in a returned error string.


##### `redact_sensitive_query_value`  (lines 642–651)

```
fn redact_sensitive_query_value(key: &str, value: &str) -> String
```

**Purpose**: Redacts query parameter values for a fixed set of auth-sensitive keys while leaving safe keys untouched.

**Data flow**: Checks whether `key` matches any entry in `SENSITIVE_URL_QUERY_KEYS` case-insensitively. If so it returns `"<redacted>"`; otherwise it returns `value.to_string()`.

**Call relations**: Used by `redact_sensitive_url_parts` to sanitize URLs before logging or attaching them to surfaced transport errors.


##### `redact_sensitive_url_parts`  (lines 657–687)

```
fn redact_sensitive_url_parts(url: &mut url::Url)
```

**Purpose**: Mutates a parsed URL to remove embedded credentials, fragments, and sensitive query values while preserving the overall URL shape.

**Data flow**: Clears username and password, removes the fragment, iterates current query pairs, replaces each value via `redact_sensitive_query_value`, and either clears the query entirely if no pairs remain or rebuilds a sanitized query string with `url::form_urlencoded::Serializer` and sets it back on the URL.

**Call relations**: Called by both `redact_sensitive_error_url` and `sanitize_url_for_logging`, and directly exercised by tests to verify safe redaction behavior.

*Call graph*: called by 3 (redact_sensitive_error_url, sanitize_url_for_logging, redact_sensitive_url_parts_preserves_safe_url_shape); 7 external calls (new, query_pairs, set_fragment, set_password, set_query, set_username, new).


##### `redact_sensitive_error_url`  (lines 690–695)

```
fn redact_sensitive_error_url(mut err: reqwest::Error) -> reqwest::Error
```

**Purpose**: Sanitizes any URL attached to a `reqwest::Error` before the error is logged or returned.

**Data flow**: Takes ownership of a `reqwest::Error`, checks `err.url_mut()`, and if present mutates that URL in place with `redact_sensitive_url_parts`; then returns the modified error.

**Call relations**: Used by `exchange_code_for_tokens` on transport failures so structured logs and returned errors do not leak codes, tokens, or credentials embedded in request URLs.

*Call graph*: calls 1 internal fn (redact_sensitive_url_parts); called by 1 (exchange_code_for_tokens); 1 external calls (url_mut).


##### `sanitize_url_for_logging`  (lines 701–709)

```
fn sanitize_url_for_logging(url: &str) -> String
```

**Purpose**: Converts an arbitrary URL string into a redacted form suitable for structured logging.

**Data flow**: Attempts to parse the input string as `url::Url`. On success it redacts sensitive parts with `redact_sensitive_url_parts` and returns the sanitized string; on parse failure it returns `"<invalid-url>"`.

**Call relations**: Used by `exchange_code_for_tokens` when logging issuer and token-endpoint values, especially for caller-supplied non-default issuers.

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

**Purpose**: Performs the OAuth authorization-code exchange and returns the ID, access, and refresh tokens while keeping logs redacted and user-facing errors informative.

**Data flow**: Accepts issuer, client ID, redirect URI, PKCE codes, and authorization code. It builds a reqwest client with custom CA support, formats the `/oauth/token` endpoint, logs sanitized issuer/token endpoint values, sends a form-encoded POST containing grant type, code, redirect URI, client ID, and `code_verifier`, and awaits the response. Transport errors are sanitized with `redact_sensitive_error_url`, logged with reviewed reqwest flags, and returned as `io::Error`. Non-success HTTP responses read the body text, parse structured detail with `parse_token_endpoint_error`, log only reviewed fields (`status`, parsed code/message), and return an `io::Error` containing the status and display message. Success responses are deserialized into a local `TokenResponse` and returned as `ExchangedTokens`.

**Call relations**: Called by both browser callback handling in `process_request` and device-code completion in `complete_device_code_login`, making it the shared token-exchange implementation for both login modes.

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

**Purpose**: Transforms exchanged OAuth tokens into `AuthDotJson` and saves them using the configured local auth storage backend without blocking the async runtime.

**Data flow**: Accepts `codex_home`, optional API key, raw ID/access/refresh token strings, auth storage mode, and keyring backend kind. It clones `codex_home` into an owned `PathBuf` and runs a blocking closure via `tokio::task::spawn_blocking`. Inside the closure it parses `id_token` into `TokenData.id_token` with `parse_chatgpt_jwt_claims`, extracts `chatgpt_account_id` from `jwt_auth_claims` into `TokenData.account_id` when present, builds `AuthDotJson` with `AuthMode::Chatgpt`, `last_refresh: Some(Utc::now())`, and the optional API key, then calls `save_auth`. Join failures are mapped into `io::Error`.

**Call relations**: Used by both `process_request` and `complete_device_code_login` after successful token exchange, centralizing the conversion from raw OAuth responses into the crate’s persisted auth format.

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

**Purpose**: Builds the localhost `/success` redirect URL and embeds selected claims-derived parameters used by the success page.

**Data flow**: Accepts callback port, issuer, ID token, access token, and streamlined-login flag. It extracts auth claims from both JWTs via `jwt_auth_claims`, reads organization/project IDs, onboarding and org-owner booleans, computes `needs_setup`, reads `chatgpt_plan_type` from the access token, chooses `platform_url` based on whether the issuer is the default issuer, assembles query parameters including the raw `id_token`, and conditionally adds `codex_streamlined_login=true`. It URL-encodes values and returns `http://localhost:{port}/success?...`.

**Call relations**: Called by `process_request` after successful persistence to redirect the browser to the local success page with enough context for the frontend page to render the right next-step messaging.

*Call graph*: calls 1 internal fn (jwt_auth_claims); called by 3 (process_request, compose_success_url_includes_streamlined_success_when_requested, compose_success_url_omits_streamlined_success_by_default); 2 external calls (format!, vec!).


##### `jwt_auth_claims`  (lines 891–920)

```
fn jwt_auth_claims(jwt: &str) -> serde_json::Map<String, serde_json::Value>
```

**Purpose**: Extracts the nested `https://api.openai.com/auth` object from a JWT payload as a JSON map.

**Data flow**: Splits the JWT on `.`, requiring three non-empty parts; on malformed input it prints an error and returns an empty map. It base64url-decodes the payload, parses it as JSON, looks for the nested `https://api.openai.com/auth` object, and returns a clone of that object if found. Decode/parse/missing-object failures print diagnostics and return an empty map.

**Call relations**: Used by `compose_success_url` and `ensure_workspace_allowed` to inspect claims without requiring full JWT verification machinery.

*Call graph*: called by 2 (compose_success_url, ensure_workspace_allowed); 2 external calls (eprintln!, new).


##### `ensure_workspace_allowed`  (lines 923–937)

```
fn ensure_workspace_allowed(
    expected: Option<&[String]>,
    id_token: &str,
) -> Result<(), String>
```

**Purpose**: Validates that an ID token belongs to one of the allowed ChatGPT workspace IDs when such a restriction is configured.

**Data flow**: Accepts optional expected workspace IDs and an ID token. If no restriction is configured, it returns `Ok(())`. Otherwise it extracts claims with `jwt_auth_claims`, reads `chatgpt_account_id`, and either returns an explanatory `Err(String)` if the claim is missing or delegates to `ensure_workspace_account_allowed` with the extracted account ID.

**Call relations**: Called after token exchange in both browser and device-code login flows to enforce workspace restrictions before credentials are persisted.

*Call graph*: calls 2 internal fn (ensure_workspace_account_allowed, jwt_auth_claims); called by 2 (complete_device_code_login, process_request).


##### `ensure_workspace_account_allowed`  (lines 942–958)

```
fn ensure_workspace_account_allowed(
    expected: Option<&[String]>,
    actual: &str,
) -> Result<(), String>
```

**Purpose**: Checks a known ChatGPT account/workspace ID against an optional allow-list.

**Data flow**: Accepts optional expected workspace IDs and an `actual` account ID. If no restriction is configured it returns `Ok(())`. Otherwise it returns `Ok(())` when any expected ID equals `actual`, or an `Err(String)` listing the allowed workspace IDs.

**Call relations**: Used by `ensure_workspace_allowed` and by PAT-related code elsewhere that already knows the account ID without needing to parse an ID token.

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

**Purpose**: Builds a terminal callback response that serves the branded HTML error page and causes the login loop to exit with an `io::Error`.

**Data flow**: Accepts a message, `io::ErrorKind`, optional error code, and optional error description. It creates a `Content-Type: text/html; charset=utf-8` header when possible, renders the page body with `render_login_error_page`, and returns `HandledRequest::ResponseAndExit { headers, body, result: Err(io::Error::new(kind, message.to_string())) }`.

**Call relations**: Used throughout `process_request` for state mismatch, OAuth callback errors, missing code, workspace restriction failures, persistence failures, redirect failures, and token-exchange failures.

*Call graph*: calls 1 internal fn (render_login_error_page); called by 1 (process_request); 3 external calls (from_bytes, new, new).


##### `is_missing_codex_entitlement_error`  (lines 980–987)

```
fn is_missing_codex_entitlement_error(error_code: &str, error_description: Option<&str>) -> bool
```

**Purpose**: Recognizes the specific OAuth callback error pattern that means the user lacks Codex entitlement in the workspace.

**Data flow**: Returns `true` only when `error_code == "access_denied"` and the optional `error_description`, lowercased, contains `"missing_codex_entitlement"`.

**Call relations**: Called by both `oauth_callback_error_message` and `render_login_error_page` so entitlement failures get specialized user-facing copy instead of generic sign-in failure text.

*Call graph*: called by 2 (oauth_callback_error_message, render_login_error_page).


##### `oauth_callback_error_message`  (lines 990–1002)

```
fn oauth_callback_error_message(error_code: &str, error_description: Option<&str>) -> String
```

**Purpose**: Converts OAuth callback error parameters into the user-facing message shown in terminal/browser error paths.

**Data flow**: Accepts `error_code` and optional `error_description`. If `is_missing_codex_entitlement_error` is true, it returns a fixed workspace-admin guidance message. Otherwise, if a non-empty description exists, it returns `"Sign-in failed: {description}"`; if not, it returns `"Sign-in failed: {error_code}"`.

**Call relations**: Used by `process_request` when the callback query contains an OAuth `error`, before building the branded error response.

*Call graph*: calls 1 internal fn (is_missing_codex_entitlement_error); called by 1 (process_request); 1 external calls (format!).


##### `parse_token_endpoint_error`  (lines 1009–1071)

```
fn parse_token_endpoint_error(body: &str) -> TokenEndpointErrorDetail
```

**Purpose**: Extracts safe structured detail from token-endpoint error bodies while preserving plain-text bodies for caller-visible display.

**Data flow**: Trims the body. Empty input returns `TokenEndpointErrorDetail` with `display_message: "unknown error"`. Otherwise it tries to parse JSON and extracts `error_code` from either a top-level string `error` or nested `error.code`. It prefers non-empty `error_description` as both `error_message` and `display_message`; failing that, it looks for nested `error.message`; failing that, it falls back to the parsed `error_code`; and if parsing yields nothing useful, it returns the raw trimmed body as `display_message` with no structured fields.

**Call relations**: Called by `exchange_code_for_tokens` on non-success HTTP responses so structured logs can use reviewed fields while returned errors still preserve backend detail.

*Call graph*: called by 5 (exchange_code_for_tokens, parse_token_endpoint_error_falls_back_to_error_code, parse_token_endpoint_error_prefers_error_description, parse_token_endpoint_error_preserves_plain_text_for_display, parse_token_endpoint_error_reads_nested_error_message_and_code).


##### `render_login_error_page`  (lines 1074–1109)

```
fn render_login_error_page(
    message: &str,
    error_code: Option<&str>,
    error_description: Option<&str>,
) -> Vec<u8>
```

**Purpose**: Renders the branded HTML error page shown in the browser when callback processing fails.

**Data flow**: Accepts a message, optional error code, and optional error description. It chooses either entitlement-specific copy or generic sign-in-failure copy based on `is_missing_codex_entitlement_error`, escapes all dynamic strings with `html_escape`, renders `LOGIN_ERROR_PAGE_TEMPLATE` with the resulting fields, and returns the HTML bytes.

**Call relations**: Used by `login_error_response` for all terminal callback failures, and directly exercised by tests that verify escaping and entitlement-specific wording.

*Call graph*: calls 2 internal fn (html_escape, is_missing_codex_entitlement_error); called by 3 (login_error_response, render_login_error_page_escapes_dynamic_fields, render_login_error_page_uses_entitlement_copy).


##### `html_escape`  (lines 1112–1125)

```
fn html_escape(input: &str) -> String
```

**Purpose**: Escapes special characters before inserting dynamic strings into HTML templates.

**Data flow**: Allocates a `String` with input-length capacity, iterates each character, replaces `&`, `<`, `>`, `"`, and `'` with their HTML entities, copies all other characters unchanged, and returns the escaped string.

**Call relations**: Called by `render_login_error_page` on every dynamic field to prevent HTML injection from backend-provided error text or callback parameters.

*Call graph*: called by 1 (render_login_error_page); 1 external calls (with_capacity).


##### `obtain_api_key`  (lines 1128–1162)

```
async fn obtain_api_key(
    issuer: &str,
    client_id: &str,
    id_token: &str,
) -> io::Result<String>
```

**Purpose**: Performs an OAuth token-exchange request that turns an authenticated ID token into an API-key-style access token.

**Data flow**: Accepts issuer, client ID, and ID token. It builds a reqwest client with custom CA support, posts form-encoded data to `{issuer}/oauth/token` with grant type `urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token=openai-api-key`, the ID token as `subject_token`, and the ID-token subject token type. Non-success statuses become `io::Error::other("api key exchange failed with status ...")`; success responses are deserialized into `ExchangeResp { access_token }` and the access token string is returned.

**Call relations**: Called by `process_request` after successful authorization-code exchange. Its result is optional there: failures are ignored and login still proceeds with persisted OAuth tokens.

*Call graph*: called by 1 (process_request); 4 external calls (builder, other, build_reqwest_client_with_custom_ca, format!).


##### `tests::parse_token_endpoint_error_prefers_error_description`  (lines 1179–1192)

```
fn parse_token_endpoint_error_prefers_error_description()
```

**Purpose**: Verifies that `parse_token_endpoint_error` prefers `error_description` over other fields for display.

**Data flow**: Passes a JSON body containing both `error` and `error_description`, calls the parser, and asserts the returned `TokenEndpointErrorDetail` contains the expected code, message, and display message.

**Call relations**: This test documents the highest-priority branch of token-endpoint error parsing used by `exchange_code_for_tokens`.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::parse_token_endpoint_error_reads_nested_error_message_and_code`  (lines 1195–1208)

```
fn parse_token_endpoint_error_reads_nested_error_message_and_code()
```

**Purpose**: Verifies parsing of nested `{error:{code,message}}` token-endpoint error payloads.

**Data flow**: Supplies a JSON body with nested error code/message, parses it, and asserts the resulting detail struct matches the nested values.

**Call relations**: This test covers the alternate structured-error shape supported by `parse_token_endpoint_error`.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::parse_token_endpoint_error_falls_back_to_error_code`  (lines 1211–1222)

```
fn parse_token_endpoint_error_falls_back_to_error_code()
```

**Purpose**: Checks that a bare top-level error code becomes the display message when no description or nested message exists.

**Data flow**: Parses `{"error":"temporarily_unavailable"}` and asserts the returned detail has that code as both `error_code` and `display_message`, with no `error_message`.

**Call relations**: This test covers the parser’s code-only fallback branch.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::parse_token_endpoint_error_preserves_plain_text_for_display`  (lines 1225–1236)

```
fn parse_token_endpoint_error_preserves_plain_text_for_display()
```

**Purpose**: Verifies that non-JSON token-endpoint bodies are preserved verbatim for caller-visible display.

**Data flow**: Passes the plain string `service unavailable` to `parse_token_endpoint_error` and asserts the returned detail uses that exact text as `display_message` with no structured fields.

**Call relations**: This test documents the parser’s final fallback behavior, which `exchange_code_for_tokens` relies on for user-facing errors.

*Call graph*: calls 1 internal fn (parse_token_endpoint_error); 1 external calls (assert_eq!).


##### `tests::redact_sensitive_query_value_only_scrubs_known_keys`  (lines 1239–1248)

```
fn redact_sensitive_query_value_only_scrubs_known_keys()
```

**Purpose**: Verifies that only known sensitive query keys are redacted.

**Data flow**: Calls `redact_sensitive_query_value` with a sensitive key (`code`) and a safe key (`redirect_uri`) and asserts the first becomes `<redacted>` while the second remains unchanged.

**Call relations**: This test locks down the key-based redaction policy used by URL sanitization helpers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::redact_sensitive_url_parts_preserves_safe_url_shape`  (lines 1251–1263)

```
fn redact_sensitive_url_parts_preserves_safe_url_shape()
```

**Purpose**: Checks that URL redaction removes credentials, fragments, and sensitive query values while preserving host/path and safe parameters.

**Data flow**: Parses a URL containing username/password, a sensitive `code` query parameter, a safe `redirect_uri`, and a fragment; mutates it with `redact_sensitive_url_parts`; and asserts the final URL string matches the expected redacted form.

**Call relations**: This test exercises the full URL-sanitization helper used by logging and transport-error redaction.

*Call graph*: calls 1 internal fn (redact_sensitive_url_parts); 2 external calls (assert_eq!, parse).


##### `tests::sanitize_url_for_logging_redacts_sensitive_issuer_parts`  (lines 1266–1274)

```
fn sanitize_url_for_logging_redacts_sensitive_issuer_parts()
```

**Purpose**: Verifies that free-form issuer URLs are sanitized before logging.

**Data flow**: Calls `sanitize_url_for_logging` on a URL containing embedded credentials and a sensitive `token` query parameter, then asserts the returned string has credentials removed and the token redacted.

**Call relations**: This test covers the string-based wrapper around `redact_sensitive_url_parts` used in structured logging.

*Call graph*: calls 1 internal fn (sanitize_url_for_logging); 1 external calls (assert_eq!).


##### `tests::compose_success_url_omits_streamlined_success_by_default`  (lines 1277–1292)

```
fn compose_success_url_omits_streamlined_success_by_default()
```

**Purpose**: Checks that the success redirect URL does not include the streamlined-login flag unless explicitly requested.

**Data flow**: Builds a success URL with `codex_streamlined_login` set to `false`, parses it as a URL, and asserts no `codex_streamlined_login` query parameter is present.

**Call relations**: This test documents the default behavior of `compose_success_url` for legacy success-page rendering.

*Call graph*: calls 1 internal fn (compose_success_url); 2 external calls (assert_eq!, parse).


##### `tests::compose_success_url_includes_streamlined_success_when_requested`  (lines 1295–1311)

```
fn compose_success_url_includes_streamlined_success_when_requested()
```

**Purpose**: Checks that the success redirect URL includes `codex_streamlined_login=true` when requested.

**Data flow**: Builds a success URL with the streamlined flag enabled, parses it, extracts the query parameter, and asserts it equals `true`.

**Call relations**: This test covers the conditional query-parameter branch in `compose_success_url`.

*Call graph*: calls 1 internal fn (compose_success_url); 2 external calls (assert_eq!, parse).


##### `tests::render_login_error_page_escapes_dynamic_fields`  (lines 1314–1326)

```
fn render_login_error_page_escapes_dynamic_fields()
```

**Purpose**: Verifies that dynamic error-page fields are HTML-escaped before rendering.

**Data flow**: Calls `render_login_error_page` with strings containing `<`, `&`, and quotes, converts the returned bytes to UTF-8, and asserts the body contains escaped versions of those values and the escaped title.

**Call relations**: This test validates the safety contract between `render_login_error_page` and `html_escape`.

*Call graph*: calls 1 internal fn (render_login_error_page); 2 external calls (from_utf8, assert!).


##### `tests::render_login_error_page_uses_entitlement_copy`  (lines 1329–1346)

```
fn render_login_error_page_uses_entitlement_copy()
```

**Purpose**: Verifies that entitlement failures render specialized copy and do not expose the raw entitlement marker string.

**Data flow**: Asserts `is_missing_codex_entitlement_error` for the chosen inputs, renders the error page, converts it to UTF-8, and asserts the body contains entitlement-specific guidance while omitting `missing_codex_entitlement`.

**Call relations**: This test covers the entitlement-specific branch shared by `oauth_callback_error_message` and `render_login_error_page`.

*Call graph*: calls 1 internal fn (render_login_error_page); 2 external calls (from_utf8, assert!).


### `tui/src/onboarding/auth/headless_chatgpt_login.rs`

`domain_logic` · `onboarding device-code login`

This submodule isolates the headless ChatGPT login flow used when the user cannot or does not want to open a browser directly from the current machine. It begins by generating a per-attempt `request_id`, storing `SignInState::ChatGptDeviceCode(ContinueWithDeviceCodeState::pending(...))`, and scheduling an immediate redraw so the UI can show a loading banner. It then spawns an async app-server request for `LoginAccountParams::ChatgptDeviceCode`. When the server returns `login_id`, `verification_url`, and `user_code`, the code updates the shared auth state only if the same request is still active; if the user has already cancelled or started another attempt, it proactively cancels the orphaned login on the server. Errors and unexpected responses similarly only reset the UI if the request ID still matches the active attempt.

The rendering path shows either a 'Preparing device code login' shimmer or the full two-step instructions with a cyan underlined verification URL and bold cyan user code, plus a phishing warning and cancel hint. Like browser-login rendering, it wraps the URL cells with OSC 8 hyperlink metadata so wrapped links remain clickable. The helper functions enforce an important invariant: async completions must never overwrite a newer auth state, so all updates are guarded by `device_code_attempt_matches` against the stored request ID.

#### Function details

##### `start_headless_chatgpt_login`  (lines 23–83)

```
fn start_headless_chatgpt_login(widget: &mut AuthModeWidget)
```

**Purpose**: Starts a device-code ChatGPT login attempt, immediately transitions the auth widget into a pending device-code state, and asynchronously requests the verification URL and user code from the app server. It also cleans up stale server-side attempts if the UI has moved on before the response arrives.

**Data flow**: Generates a UUID string `request_id`, writes `SignInState::ChatGptDeviceCode(ContinueWithDeviceCodeState::pending(request_id.clone()))` into `widget.sign_in_state`, and schedules a frame. It then clones the request handle and shared state arcs, spawns an async `LoginAccount` request with `LoginAccountParams::ChatgptDeviceCode`, and on success either updates the active state to `ContinueWithDeviceCodeState::ready(...)` and clears `error`, or cancels the returned `login_id` if the request is no longer active; on unexpected response or error it calls `set_device_code_error_for_active_attempt` with a formatted message.

**Call relations**: Called only from `AuthModeWidget::start_device_code_login`. It delegates active-attempt guarding to `set_device_code_state_for_active_attempt` and `set_device_code_error_for_active_attempt`, and uses `cancel_login_attempt` to avoid leaking abandoned server-side login sessions.

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

**Purpose**: Renders the device-code login screen, showing either a loading state or the full browser URL plus one-time code instructions. It also marks the rendered verification URL as an OSC 8 hyperlink.

**Data flow**: Reads `state.is_showing_copyable_auth()`, widget animation flags, and optional `verification_url`/`user_code` to choose banner text, optionally schedule another frame for shimmer animation, assemble instructional lines, render them into the buffer, and call `mark_url_hyperlink` when a URL is present. It mutates only the frame scheduler and render buffer.

**Call relations**: Called by `AuthModeWidget::render_ref` when the auth state is `ChatGptDeviceCode`. It depends on `ContinueWithDeviceCodeState::is_showing_copyable_auth` to distinguish pending from ready rendering.

*Call graph*: calls 2 internal fn (shimmer_text, is_showing_copyable_auth); called by 1 (render_ref); 5 external calls (from, new, from_millis, mark_url_hyperlink, vec!).


##### `device_code_attempt_matches`  (lines 155–160)

```
fn device_code_attempt_matches(state: &SignInState, request_id: &str) -> bool
```

**Purpose**: Checks whether a `SignInState` still represents the specific device-code request ID an async task is trying to update. It is the core stale-response guard.

**Data flow**: Reads the provided `SignInState` and returns `true` only if it is `SignInState::ChatGptDeviceCode(state)` with `state.request_id == request_id`. It writes no state.

**Call relations**: Used by both state-update helpers before they mutate shared auth state. It prevents late responses from an older attempt from clobbering a newer UI state.

*Call graph*: called by 2 (set_device_code_error_for_active_attempt, set_device_code_state_for_active_attempt); 1 external calls (matches!).


##### `set_device_code_state_for_active_attempt`  (lines 162–177)

```
fn set_device_code_state_for_active_attempt(
    sign_in_state: &std::sync::Arc<std::sync::RwLock<SignInState>>,
    request_frame: &crate::tui::FrameRequester,
    request_id: &str,
    next_state: C
```

**Purpose**: Replaces the current auth state with a new device-code state only if the targeted request is still the active one. It is the success-path updater for device-code login startup.

**Data flow**: Takes shared `sign_in_state`, `request_frame`, a `request_id`, and a `next_state`, acquires a write lock, checks `device_code_attempt_matches`, and if matched writes `SignInState::ChatGptDeviceCode(next_state)`, drops the lock, schedules a frame, and returns `true`; otherwise it leaves state unchanged and returns `false`.

**Call relations**: Called from `start_headless_chatgpt_login` after a successful app-server response. Its boolean result tells the caller whether the response was applied or whether the returned login should be cancelled as stale.

*Call graph*: calls 2 internal fn (device_code_attempt_matches, schedule_frame); called by 1 (start_headless_chatgpt_login); 1 external calls (ChatGptDeviceCode).


##### `set_device_code_error_for_active_attempt`  (lines 179–196)

```
fn set_device_code_error_for_active_attempt(
    sign_in_state: &std::sync::Arc<std::sync::RwLock<SignInState>>,
    request_frame: &crate::tui::FrameRequester,
    error: &std::sync::Arc<std::sync::R
```

**Purpose**: Resets auth back to mode selection and stores an error message, but only if the failing async response still belongs to the active device-code attempt. It is the guarded error-path updater.

**Data flow**: Locks `sign_in_state`, verifies the request ID with `device_code_attempt_matches`, and on match writes `SignInState::PickMode`, drops the lock, writes `Some(message)` into the shared `error`, schedules a frame, and returns `true`; otherwise it leaves both state and error untouched and returns `false`.

**Call relations**: Used by `start_headless_chatgpt_login` for unexpected responses and request failures. It mirrors the guarded-update pattern of `set_device_code_state_for_active_attempt` for error handling.

*Call graph*: calls 2 internal fn (device_code_attempt_matches, schedule_frame); called by 1 (start_headless_chatgpt_login).


##### `tests::pending_device_code_state`  (lines 205–209)

```
fn pending_device_code_state(request_id: &str) -> Arc<RwLock<SignInState>>
```

**Purpose**: Creates a shared `Arc<RwLock<SignInState>>` fixture containing a pending device-code attempt for the given request ID. It simplifies tests for the guarded update helpers.

**Data flow**: Wraps `SignInState::ChatGptDeviceCode(ContinueWithDeviceCodeState::pending(request_id.to_string()))` in `Arc<RwLock<_>>` and returns it. It mutates no external state.

**Call relations**: Used by the helper-update tests to provide a realistic shared state container matching production usage.

*Call graph*: calls 1 internal fn (pending); 3 external calls (new, new, ChatGptDeviceCode).


##### `tests::device_code_attempt_matches_only_for_matching_request_id`  (lines 212–223)

```
fn device_code_attempt_matches_only_for_matching_request_id()
```

**Purpose**: Verifies that request-ID matching succeeds only for the exact active device-code request and fails for other IDs or non-device-code states. It locks in the stale-response guard semantics.

**Data flow**: Builds a pending device-code `SignInState`, calls `device_code_attempt_matches` with matching and non-matching IDs plus a `PickMode` state, and asserts the expected booleans. It writes no shared state beyond local test setup.

**Call relations**: Directly exercises the low-level matcher used by both guarded update helpers.

*Call graph*: calls 1 internal fn (pending); 2 external calls (assert_eq!, ChatGptDeviceCode).


##### `tests::set_device_code_state_for_active_attempt_updates_only_when_active`  (lines 226–268)

```
fn set_device_code_state_for_active_attempt_updates_only_when_active()
```

**Purpose**: Checks that the success-path updater mutates shared state only when the request ID still matches the active attempt. It also verifies that the populated state carries the returned login ID.

**Data flow**: Creates a dummy frame requester and pending shared state, calls `set_device_code_state_for_active_attempt` once with a matching request ID and once with a mismatched one, then asserts the returned booleans and resulting `sign_in_state` contents. It mutates the shared state fixture under test.

**Call relations**: Exercises the guarded success updater used by `start_headless_chatgpt_login`.

*Call graph*: calls 1 internal fn (test_dummy); 3 external calls (assert!, assert_eq!, pending_device_code_state).


##### `tests::set_device_code_error_for_active_attempt_updates_only_when_active`  (lines 271–312)

```
fn set_device_code_error_for_active_attempt_updates_only_when_active()
```

**Purpose**: Checks that the error-path updater resets state and stores an error only for the active request ID. It ensures stale failures do not overwrite newer UI state.

**Data flow**: Creates dummy frame requester, shared error lock, and pending shared state, calls `set_device_code_error_for_active_attempt` with matching and mismatched request IDs, and asserts the returned booleans plus resulting state and error contents. It mutates the shared fixtures under test.

**Call relations**: Exercises the guarded error updater used by `start_headless_chatgpt_login` for failed startup responses.

*Call graph*: calls 1 internal fn (test_dummy); 5 external calls (new, new, assert!, assert_eq!, pending_device_code_state).


### Authentication persistence and logout
These files define the auth subsystem boundary, error surface, persisted credential formats, backend selection, specialized API-key storage, and token revocation behavior.

### `login/src/auth/error.rs`

`data_model` · `cross-cutting / auth error typing`

This file contains two public re-exports: `RefreshTokenFailedError` and `RefreshTokenFailedReason`, both sourced from `codex_protocol::auth`. Its role is to make those protocol-defined authentication failure types available under the login crate’s `auth::error` namespace, which simplifies imports for callers that conceptually depend on login/auth behavior rather than on the lower-level protocol crate directly.

There is no local type definition, transformation logic, or behavior here. The design choice is about API ergonomics and layering: the login subsystem adopts the protocol’s canonical error vocabulary instead of wrapping or duplicating it, which helps preserve consistency across transport, protocol, and application layers. At the same time, by re-exporting through this file, the crate can present a cohesive auth-facing module structure and retain flexibility to change internal dependencies later if needed. This file is therefore a thin facade that stabilizes where consumers look for auth refresh failure types without introducing another error abstraction.


### `login/src/auth/mod.rs`

`orchestration` · `cross-cutting`

This file is the root module for authentication logic in the login crate. It declares the internal submodules that implement distinct credential paths: access-token login, personal access tokens, Bedrock API key authentication, external bearer flows, token storage, refresh/revoke behavior, and the central manager that coordinates them. Two submodules, `default_client` and `error`, are made public directly, signaling that callers may need to construct the standard HTTP client and inspect refresh-specific error types without going through the manager API.

Its main job is composition rather than execution: it establishes the module graph and then selectively re-exports the public API that downstream crates consume. In particular, it exposes `BedrockApiKeyAuth` and `login_with_bedrock_api_key` from the Bedrock-specific implementation, the refresh failure types from `error`, and the manager module’s public surface wholesale via `pub use manager::*`. That design makes `manager` the effective façade for most auth operations while still surfacing a few specialized types explicitly.

A reader should note that this file intentionally hides several implementation modules (`storage`, `util`, `revoke`, `external_bearer`, etc.) behind the façade. The invariant enforced here is API curation: callers interact with stable exported types and functions, while credential-format details and persistence mechanics remain internal to the auth subsystem.


### `core/src/config/auth_keyring.rs`

`config` · `startup and config load`

This file is a small configuration decision module centered on one policy: map the effective state of the `Feature::SecretAuthStorage` feature to an `AuthKeyringBackendKind`. The mapping itself is intentionally simple and isolated in a private helper: when secret-backed auth storage is enabled, the backend is `AuthKeyringBackendKind::Secrets`; otherwise it falls back to `AuthKeyringBackendKind::Direct`.

The file exposes that policy through two entry points that differ only in how they obtain feature state. `Config::auth_keyring_backend_kind` is the steady-state path used once a full `Config` has already been built and its `features` field can answer whether `SecretAuthStorage` is enabled. `resolve_bootstrap_auth_keyring_backend_kind` exists for startup code that must decide how to read auth credentials before managed cloud requirements and the full configuration object are available. It reconstructs feature state from the partially loaded TOML (`config_toml.features` and `experimental_use_unified_exec_tool`), then merges those configured features with requirement-driven feature constraints from `config_layer_stack.requirements().feature_requirements` via `ManagedFeatures::from_configured`.

A notable design choice is that the bootstrap path returns `std::io::Result<AuthKeyringBackendKind>` while the full-config method is infallible: only the managed-feature resolution step can fail during bootstrap. This keeps the backend-selection rule itself deterministic and side-effect free while allowing early startup to surface configuration/requirements loading errors cleanly.

#### Function details

##### `Config::auth_keyring_backend_kind`  (lines 11–15)

```
fn auth_keyring_backend_kind(&self) -> AuthKeyringBackendKind
```

**Purpose**: Computes the auth keyring backend from an already constructed `Config` by checking whether `Feature::SecretAuthStorage` is enabled in the config's feature set. It is the normal runtime accessor once configuration assembly is complete.

**Data flow**: Takes `&self` and reads `self.features.enabled(Feature::SecretAuthStorage)` to obtain a boolean feature state. It passes that boolean into the private backend-selection helper and returns the resulting `AuthKeyringBackendKind` without mutating any state.

**Call relations**: This method is used on the full configuration path after `Config` exists. Rather than embedding the enum choice inline, it delegates the final boolean-to-backend mapping to `auth_keyring_backend_kind_from_secret_auth_storage` so the same policy is shared with the bootstrap resolver.

*Call graph*: calls 1 internal fn (auth_keyring_backend_kind_from_secret_auth_storage).


##### `resolve_bootstrap_auth_keyring_backend_kind`  (lines 22–45)

```
fn resolve_bootstrap_auth_keyring_backend_kind(
    bootstrap_config: &ConfigTomlLoadResult,
) -> std::io::Result<AuthKeyringBackendKind>
```

**Purpose**: Resolves the auth keyring backend during early startup from a `ConfigTomlLoadResult`, before a full `Config` and managed cloud-derived configuration have been fully materialized. It reconstructs effective feature state from bootstrap inputs and then applies the same backend-selection rule as the steady-state path.

**Data flow**: Accepts `&ConfigTomlLoadResult` and reads `bootstrap_config.config_toml` plus requirement data from `bootstrap_config.config_layer_stack.requirements().feature_requirements`. It builds a `Features` value from configured sources using the TOML `features` section and `experimental_use_unified_exec_tool`, combines that with cloned feature requirements through `ManagedFeatures::from_configured`, queries whether `Feature::SecretAuthStorage` is enabled, converts that boolean through the helper into an `AuthKeyringBackendKind`, and returns it as `Ok(...)`; if managed-feature construction fails, it propagates the `std::io::Error`.

**Call relations**: This function is invoked on startup paths that need auth backend selection before the full config pipeline has finished. It delegates feature parsing to `Features::from_sources`, requirement-aware feature resolution to `ManagedFeatures::from_configured`, and the final backend choice to `auth_keyring_backend_kind_from_secret_auth_storage` so bootstrap and normal config paths stay behaviorally identical.

*Call graph*: calls 3 internal fn (auth_keyring_backend_kind_from_secret_auth_storage, from_configured, from_sources); 2 external calls (default, default).


##### `auth_keyring_backend_kind_from_secret_auth_storage`  (lines 47–55)

```
fn auth_keyring_backend_kind_from_secret_auth_storage(
    secret_auth_storage_enabled: bool,
) -> AuthKeyringBackendKind
```

**Purpose**: Implements the core policy that translates the effective `SecretAuthStorage` feature flag into a concrete auth keyring backend enum. It centralizes the mapping so both bootstrap and full-config callers cannot drift.

**Data flow**: Takes a single `bool` argument, `secret_auth_storage_enabled`. If true, it returns `AuthKeyringBackendKind::Secrets`; otherwise it returns `AuthKeyringBackendKind::Direct`. It reads no external state and performs no writes.

**Call relations**: This helper sits at the bottom of the call flow and is reached from both `Config::auth_keyring_backend_kind` and `resolve_bootstrap_auth_keyring_backend_kind`. Those callers differ in how they derive the boolean feature state, but both rely on this function for the final backend decision.

*Call graph*: called by 2 (auth_keyring_backend_kind, resolve_bootstrap_auth_keyring_backend_kind).


### `keyring-store/src/lib.rs`

`io_transport` · `credential load/save/delete operations and tests`

This file wraps OS-backed credential storage behind the `KeyringStore` trait. The trait exposes three synchronous operations keyed by `(service, account)`: `load`, `save`, and `delete`. The concrete production implementation, `DefaultKeyringStore`, uses `keyring::Entry` for each operation and emits `tracing::trace!` messages before and after calls. It deliberately treats `keyring::Error::NoEntry` as a non-error condition: `load` returns `Ok(None)` and `delete` returns `Ok(false)`, while all other keyring failures are wrapped in `CredentialStoreError`.

`CredentialStoreError` is intentionally thin: it currently has a single `Other(KeyringError)` variant, but still provides helper methods to construct it, extract a displayable message, or recover the underlying `KeyringError`. It also implements `Display` and `std::error::Error` so callers can bubble it up naturally.

The nested `tests` module exports `MockKeyringStore`, a thread-safe in-memory test double built from `Arc<Mutex<HashMap<String, Arc<MockCredential>>>>`. It lazily creates per-account mock credentials, tolerates poisoned mutexes by recovering the inner state, and mirrors the production semantics for `NoEntry` versus hard errors. Its helpers let tests inspect saved values, inject keyring errors, and check whether an account entry exists. One subtle behavior in mock deletion is that successful or `NoEntry` deletion removes the account from the map afterward, matching the idea that the credential should no longer be present.

#### Function details

##### `CredentialStoreError::new`  (lines 14–16)

```
fn new(error: KeyringError) -> Self
```

**Purpose**: Wraps a raw `keyring::Error` in the crate-local credential-store error type.

**Data flow**: Takes a `KeyringError` by value → constructs `CredentialStoreError::Other(error)` → returns it.

**Call relations**: Used by both the real and mock keyring-store implementations whenever a non-`NoEntry` keyring failure must be surfaced.

*Call graph*: called by 5 (delete, load, save, delete, load); 1 external calls (Other).


##### `CredentialStoreError::message`  (lines 18–22)

```
fn message(&self) -> String
```

**Purpose**: Returns a human-readable error string for the wrapped keyring failure.

**Data flow**: Matches on `self` → calls `to_string()` on the inner `KeyringError` → returns the resulting `String`.

**Call relations**: Convenience accessor for callers that want a plain message without formatting the error trait object.


##### `CredentialStoreError::into_error`  (lines 24–28)

```
fn into_error(self) -> KeyringError
```

**Purpose**: Unwraps the local error wrapper back into the underlying `KeyringError`.

**Data flow**: Consumes `self` → matches the enum and returns the contained `KeyringError`.

**Call relations**: Useful when downstream code needs to recover the original keyring-specific error value.


##### `CredentialStoreError::fmt`  (lines 32–36)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the credential-store error by delegating to the wrapped keyring error.

**Data flow**: Reads `self` and the formatter → matches the enum and writes the inner error with `write!(f, "{error}")` → returns `fmt::Result`.

**Call relations**: Implements `Display` so `CredentialStoreError` integrates with standard Rust error reporting.

*Call graph*: 1 external calls (write!).


##### `DefaultKeyringStore::load`  (lines 52–69)

```
fn load(&self, service: &str, account: &str) -> Result<Option<String>, CredentialStoreError>
```

**Purpose**: Loads a password from the OS keyring for a given service/account pair.

**Data flow**: Logs a start trace, creates `Entry::new(service, account)`, then calls `get_password()` → returns `Ok(Some(password))` on success, `Ok(None)` for `NoEntry`, or `Err(CredentialStoreError::new(error))` for other failures, with trace logs for each branch.

**Call relations**: Production implementation of `KeyringStore::load`; callers use it when reading persisted credentials from the real system keyring.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, trace!).


##### `DefaultKeyringStore::save`  (lines 71–87)

```
fn save(&self, service: &str, account: &str, value: &str) -> Result<(), CredentialStoreError>
```

**Purpose**: Stores a password in the OS keyring for a given service/account pair.

**Data flow**: Logs a start trace including `value.len()`, creates `Entry::new(service, account)`, then calls `set_password(value)` → returns `Ok(())` on success or wraps any error in `CredentialStoreError`, logging the outcome.

**Call relations**: Production implementation of `KeyringStore::save`; used when persisting credentials.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, trace!).


##### `DefaultKeyringStore::delete`  (lines 89–106)

```
fn delete(&self, service: &str, account: &str) -> Result<bool, CredentialStoreError>
```

**Purpose**: Deletes a credential from the OS keyring and reports whether an entry actually existed.

**Data flow**: Logs a start trace, creates `Entry::new(service, account)`, then calls `delete_credential()` → returns `Ok(true)` on success, `Ok(false)` for `NoEntry`, or `Err(CredentialStoreError::new(error))` for other failures, with trace logs for each branch.

**Call relations**: Production implementation of `KeyringStore::delete`; callers use it to remove stored credentials without treating missing entries as errors.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, trace!).


##### `tests::MockKeyringStore::credential`  (lines 126–135)

```
fn credential(&self, account: &str) -> Arc<MockCredential>
```

**Purpose**: Returns the mock credential object for an account, creating it lazily if needed.

**Data flow**: Locks the internal `HashMap`, recovering from poison if necessary → inserts `Arc::new(MockCredential::default())` for the account if absent → clones and returns the `Arc<MockCredential>`.

**Call relations**: Internal helper used by mock save and error-injection paths to ensure an account has a backing mock credential.

*Call graph*: called by 2 (save, set_error).


##### `tests::MockKeyringStore::saved_value`  (lines 137–146)

```
fn saved_value(&self, account: &str) -> Option<String>
```

**Purpose**: Reads the currently stored mock password for an account, if any.

**Data flow**: Locks the credential map and clones the account's `Arc<MockCredential>` if present → calls `get_password().ok()` on that credential → returns `Option<String>`.

**Call relations**: Test helper for assertions about what the mock store currently contains.


##### `tests::MockKeyringStore::set_error`  (lines 148–151)

```
fn set_error(&self, account: &str, error: KeyringError)
```

**Purpose**: Configures a mock credential to return a specific keyring error on subsequent operations.

**Data flow**: Gets or creates the account credential via `credential(account)` → calls `credential.set_error(error)` → mutates the mock credential state in place.

**Call relations**: Used by tests to simulate keyring backend failures without touching the real OS keyring.

*Call graph*: calls 1 internal fn (credential).


##### `tests::MockKeyringStore::contains`  (lines 153–159)

```
fn contains(&self, account: &str) -> bool
```

**Purpose**: Reports whether the mock store currently has an entry object for an account.

**Data flow**: Locks the internal map, recovering from poison if needed → checks `guard.contains_key(account)` → returns the boolean result.

**Call relations**: Test helper for verifying account creation/removal behavior in the mock store.


##### `tests::MockKeyringStore::load`  (lines 163–185)

```
fn load(
            &self,
            _service: &str,
            account: &str,
        ) -> Result<Option<String>, CredentialStoreError>
```

**Purpose**: Implements mock credential loading with the same `Some`/`None`/error semantics as the real store.

**Data flow**: Ignores `service`, locks the map and clones the account credential if present → returns `Ok(None)` if absent; otherwise calls `get_password()` and maps success to `Ok(Some(password))`, `KeyringError::NoEntry` to `Ok(None)`, and other errors to `Err(CredentialStoreError::new(error))`.

**Call relations**: Mock implementation of `KeyringStore::load` used by tests that need deterministic credential behavior.

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

**Purpose**: Implements mock credential saving by writing into the per-account `MockCredential`.

**Data flow**: Ignores `service`, gets or creates the account credential via `credential(account)`, then calls `set_password(value)` and maps any error through `CredentialStoreError::new`.

**Call relations**: Mock implementation of `KeyringStore::save` for tests.

*Call graph*: calls 1 internal fn (credential).


##### `tests::MockKeyringStore::delete`  (lines 199–224)

```
fn delete(&self, _service: &str, account: &str) -> Result<bool, CredentialStoreError>
```

**Purpose**: Implements mock deletion and removes the account entry from the backing map after a successful or no-entry delete.

**Data flow**: Ignores `service`, clones the account credential from the map if present → returns `Ok(false)` if absent; otherwise calls `delete_credential()` and maps success to `true`, `NoEntry` to `false`, other errors to `CredentialStoreError`; after a non-error result, re-locks the map, removes the account key, and returns the boolean.

**Call relations**: Mock implementation of `KeyringStore::delete`, mirroring production semantics while also cleaning up the in-memory map.

*Call graph*: calls 1 internal fn (new).


### `login/src/auth/storage.rs`

`io_transport` · `auth load/save/delete`

This file is the storage abstraction for CLI authentication state. The main data model is `AuthDotJson`, the serialized shape of `$CODEX_HOME/auth.json`, containing optional `AuthMode`, API key, `TokenData`, refresh timestamp, agent identity JWT, personal access token, and Bedrock credentials. `AgentIdentityAuthRecord` is a normalized decoded view of agent-identity JWT claims, with a constructor that validates and decodes the JWT before converting from `AgentIdentityJwtClaims`.

Persistence is abstracted behind `AuthStorageBackend` with `load`, `save`, and `delete`. `FileAuthStorage` reads and writes pretty JSON to `auth.json`, creating parent directories and, on Unix, setting mode `0o600`. `DirectKeyringAuthStorage` stores serialized auth JSON under a stable per-`codex_home` key derived by `compute_store_key`, and removes any stale file fallback after successful save. `SecretsKeyringAuthStorage` uses `SecretsManager` with `LocalSecretsNamespace::CodexAuth` and a fixed `CODEX_AUTH` secret name to store encrypted auth, while also deleting both fallback files and legacy direct-keyring entries on delete. `AutoAuthStorage` prefers keyring-backed storage but falls back to file storage on empty keyring or keyring errors, logging warnings when it degrades. `EphemeralAuthStorage` keeps auth only in a global `Lazy<Mutex<HashMap<String, AuthDotJson>>>`, keyed by the same stable store key.

Factory functions choose the backend from `AuthCredentialsStoreMode` and `AuthKeyringBackendKind`. A notable invariant is cleanup of stale fallback files after successful keyring/secrets saves, so only one authoritative copy remains.

#### Function details

##### `AgentIdentityAuthRecord::from_agent_identity_jwt`  (lines 75–80)

```
fn from_agent_identity_jwt(jwt: &str) -> std::io::Result<Self>
```

**Purpose**: Decodes an agent-identity JWT and converts its claims into the persisted `AgentIdentityAuthRecord` shape.

**Data flow**: Takes a JWT string, calls `decode_agent_identity_jwt(jwt, None)`, maps decode failures into `std::io::Error`, and on success converts the returned `AgentIdentityJwtClaims` with `Into<Self>`. It returns `io::Result<AgentIdentityAuthRecord>` and writes no external state.

**Call relations**: Used by higher-level auth verification code when an auth record contains an agent identity token and a structured record is needed. It delegates cryptographic/claims parsing to the external decoder and keeps only storage-facing fields.

*Call graph*: called by 1 (verified_agent_identity_record); 1 external calls (decode_agent_identity_jwt).


##### `AgentIdentityAuthRecord::from`  (lines 84–94)

```
fn from(claims: AgentIdentityJwtClaims) -> Self
```

**Purpose**: Performs a field-by-field conversion from decoded JWT claims into the storage record used by the login subsystem.

**Data flow**: Consumes `AgentIdentityJwtClaims` and moves/copies its fields into a new `AgentIdentityAuthRecord`, converting `plan_type` into `AccountPlanType` via `.into()`. It returns the new record without side effects.

**Call relations**: This conversion is the final step used by `from_agent_identity_jwt`, separating JWT decoding from the storage-layer representation.


##### `get_auth_file`  (lines 97–99)

```
fn get_auth_file(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the canonical path of the plain auth file under a given Codex home directory.

**Data flow**: Accepts `&Path` for `codex_home` and returns `codex_home.join("auth.json")` as a `PathBuf`.

**Call relations**: This helper is reused across file-backed load/save/delete paths and tests so all code agrees on the exact fallback file location.

*Call graph*: called by 5 (logout_removes_auth_file, write_auth_file, load, save, delete_file_if_exists); 1 external calls (join).


##### `delete_file_if_exists`  (lines 101–108)

```
fn delete_file_if_exists(codex_home: &Path) -> std::io::Result<bool>
```

**Purpose**: Removes the fallback `auth.json` file while treating absence as a non-error.

**Data flow**: Builds the auth file path with `get_auth_file`, calls `std::fs::remove_file`, and returns `Ok(true)` on deletion, `Ok(false)` on `NotFound`, or propagates any other `io::Error`.

**Call relations**: Called by multiple backends during delete and after successful keyring/secrets saves to clean up stale disk copies without failing when no file exists.

*Call graph*: calls 1 internal fn (get_auth_file); called by 5 (delete, save, delete, delete, save); 1 external calls (remove_file).


##### `FileAuthStorage::new`  (lines 122–124)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Constructs the plain file-backed auth storage for a specific `codex_home` directory.

**Data flow**: Takes a `PathBuf` and stores it in `FileAuthStorage { codex_home }`, returning the new backend instance.

**Call relations**: Used directly in tests and by factory/orchestration code such as `create_auth_storage_with_store` and `AutoAuthStorage::new` whenever file persistence is needed.

*Call graph*: called by 15 (login_with_access_token_writes_only_personal_access_token, login_with_access_token_writes_only_token, login_with_api_key_overwrites_existing_auth_json, bedrock_only_auth_storage_creates_primary_auth, login_with_api_key_clears_bedrock_api_key, login_with_bedrock_api_key_replaces_openai_auth, logout_removes_bedrock_auth, new, create_auth_storage_with_store, file_storage_delete_removes_auth_file (+5 more)).


##### `FileAuthStorage::try_read_auth_json`  (lines 128–135)

```
fn try_read_auth_json(&self, auth_file: &Path) -> std::io::Result<AuthDotJson>
```

**Purpose**: Reads and deserializes a specific auth JSON file into `AuthDotJson`.

**Data flow**: Opens the provided `&Path`, reads the entire file into a `String`, deserializes it with `serde_json::from_str`, and returns the parsed `AuthDotJson` or the first I/O/JSON error encountered.

**Call relations**: This is the parsing primitive used by `FileAuthStorage::load`; tests also call it directly to verify exact on-disk persistence.

*Call graph*: called by 1 (load); 3 external calls (open, new, from_str).


##### `FileAuthStorage::load`  (lines 139–147)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads auth state from `auth.json` if present.

**Data flow**: Computes the auth file path with `get_auth_file`, calls `try_read_auth_json`, returns `Ok(Some(auth))` on success, `Ok(None)` if the file is missing, and propagates any other read/parse error.

**Call relations**: Implements `AuthStorageBackend::load` for file storage and serves as the fallback path for `AutoAuthStorage` when keyring-backed loading is unavailable or empty.

*Call graph*: calls 2 internal fn (try_read_auth_json, get_auth_file).


##### `FileAuthStorage::save`  (lines 149–166)

```
fn save(&self, auth_dot_json: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: Serializes `AuthDotJson` as pretty JSON and writes it atomically enough for normal CLI use to the fallback auth file.

**Data flow**: Computes the file path, creates parent directories if needed, serializes the auth record with `serde_json::to_string_pretty`, opens the file with truncate/write/create options, applies Unix mode `0o600` when available, writes all bytes, flushes, and returns `io::Result<()>`.

**Call relations**: Implements file-backed persistence directly and is also the fallback write path used by `AutoAuthStorage` when keyring save fails.

*Call graph*: calls 1 internal fn (get_auth_file); 3 external calls (new, to_string_pretty, create_dir_all).


##### `FileAuthStorage::delete`  (lines 168–170)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: Deletes the plain auth file for this storage backend.

**Data flow**: Delegates to `delete_file_if_exists(&self.codex_home)` and returns its boolean removal result.

**Call relations**: This is the `AuthStorageBackend` delete implementation for file mode and the baseline cleanup behavior mirrored by keyring-backed backends.

*Call graph*: calls 1 internal fn (delete_file_if_exists).


##### `compute_store_key`  (lines 181–192)

```
fn compute_store_key(codex_home: &Path) -> std::io::Result<String>
```

**Purpose**: Derives a stable, short key identifier from `codex_home` for keyring and ephemeral storage namespaces.

**Data flow**: Canonicalizes the path when possible, falls back to the original path on canonicalization failure, converts it to a lossy string, hashes it with SHA-256, hex-encodes the digest, truncates to 16 hex characters, and returns `format!("cli|{truncated}")`.

**Call relations**: This helper underpins `DirectKeyringAuthStorage` and `EphemeralAuthStorage`, ensuring different Codex homes do not collide while keeping key names compact and deterministic.

*Call graph*: called by 4 (delete, load, save, with_store); 3 external calls (canonicalize, new, format!).


##### `DirectKeyringAuthStorage::new`  (lines 201–206)

```
fn new(codex_home: PathBuf, keyring_store: Arc<dyn KeyringStore>) -> Self
```

**Purpose**: Constructs the legacy/direct keyring backend around a specific home directory and keyring implementation.

**Data flow**: Stores the provided `codex_home` and `Arc<dyn KeyringStore>` into a new `DirectKeyringAuthStorage` and returns it.

**Call relations**: Created by the keyring factory and by tests that exercise direct keyring behavior independently of the secrets-backed backend.

*Call graph*: called by 5 (new, create_keyring_auth_storage, direct_keyring_auth_storage_delete_removes_keyring_and_file, direct_keyring_auth_storage_saves_legacy_keyring_entry, secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry).


##### `DirectKeyringAuthStorage::load_from_keyring`  (lines 208–221)

```
fn load_from_keyring(&self, key: &str) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads and deserializes auth JSON from the direct keyring entry for a precomputed key.

**Data flow**: Calls `keyring_store.load(KEYRING_SERVICE, key)`. `Ok(Some(serialized))` is deserialized with `serde_json::from_str`; deserialization errors become `io::Error` with a descriptive message. `Ok(None)` returns `Ok(None)`. Keyring backend errors are converted into `io::Error` using `error.message()`.

**Call relations**: This is the direct keyring read primitive used by `DirectKeyringAuthStorage::load`, isolating keyring-specific error mapping from key computation.

*Call graph*: called by 1 (load); 3 external calls (other, format!, from_str).


##### `DirectKeyringAuthStorage::save_to_keyring`  (lines 223–235)

```
fn save_to_keyring(&self, key: &str, value: &str) -> std::io::Result<()>
```

**Purpose**: Writes serialized auth JSON into the direct keyring and emits a warning on failure.

**Data flow**: Calls `keyring_store.save(KEYRING_SERVICE, key, value)`. On success it returns `Ok(())`; on failure it formats a message from `error.message()`, logs it with `warn!`, and returns `io::Error::other(message)`.

**Call relations**: Used by `DirectKeyringAuthStorage::save` after serialization and key computation, keeping warning/logging behavior centralized for direct keyring writes.

*Call graph*: called by 1 (save); 3 external calls (other, format!, warn!).


##### `DirectKeyringAuthStorage::load`  (lines 239–242)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads auth from the direct keyring entry associated with this `codex_home`.

**Data flow**: Computes the stable key with `compute_store_key(&self.codex_home)` and passes it to `load_from_keyring`, returning the resulting `io::Result<Option<AuthDotJson>>`.

**Call relations**: Implements `AuthStorageBackend::load` for the direct keyring backend by composing key derivation with the lower-level keyring read helper.

*Call graph*: calls 2 internal fn (load_from_keyring, compute_store_key).


##### `DirectKeyringAuthStorage::save`  (lines 244–253)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: Serializes auth into the direct keyring and removes any stale fallback file after a successful write.

**Data flow**: Computes the store key, serializes `auth` with compact `serde_json::to_string`, writes it via `save_to_keyring`, then attempts `delete_file_if_exists(&self.codex_home)`. Failure to remove the fallback file is only logged with `warn!`; the function still returns `Ok(())` if the keyring write succeeded.

**Call relations**: This is the direct keyring backend’s main persistence path. It delegates serialization and write details to helpers and enforces the design choice that keyring storage supersedes disk fallback.

*Call graph*: calls 3 internal fn (save_to_keyring, compute_store_key, delete_file_if_exists); 2 external calls (to_string, warn!).


##### `DirectKeyringAuthStorage::delete`  (lines 255–265)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: Deletes both the direct keyring entry and any fallback auth file, reporting whether either existed.

**Data flow**: Computes the store key, calls `keyring_store.delete(KEYRING_SERVICE, &key)` and maps backend errors into `io::Error`, then calls `delete_file_if_exists`. It returns `Ok(keyring_removed || file_removed)`.

**Call relations**: Implements delete for direct keyring mode and is also invoked by `SecretsKeyringAuthStorage::delete` to remove legacy direct-keyring entries during migration cleanup.

*Call graph*: calls 2 internal fn (compute_store_key, delete_file_if_exists); called by 1 (delete).


##### `SecretsKeyringAuthStorage::fmt`  (lines 276–280)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a redacted-ish debug representation that exposes the home path but not internal secret-management details.

**Data flow**: Writes a `DebugStruct` named `SecretsKeyringAuthStorage`, includes `codex_home`, and finishes non-exhaustively.

**Call relations**: This custom formatter supports diagnostics for the secrets-backed backend without dumping the embedded `SecretsManager` or keyring internals.

*Call graph*: 1 external calls (debug_struct).


##### `SecretsKeyringAuthStorage::new`  (lines 284–298)

```
fn new(codex_home: PathBuf, keyring_store: Arc<dyn KeyringStore>) -> Self
```

**Purpose**: Constructs the encrypted auth backend and its companion direct-keyring backend for legacy cleanup.

**Data flow**: Clones `codex_home` and the shared `keyring_store`, creates a `DirectKeyringAuthStorage` for migration/deletion compatibility, creates a `SecretsManager` with `SecretsBackendKind::Local` and `LocalSecretsNamespace::CodexAuth`, and returns the assembled backend.

**Call relations**: Built by `create_keyring_auth_storage` when the configured backend kind is `Secrets`, and directly by tests that validate encrypted auth behavior.

*Call graph*: calls 2 internal fn (new, new_with_keyring_store_and_namespace); called by 5 (create_keyring_auth_storage, secrets_keyring_auth_storage_delete_removes_keyring_and_file, secrets_keyring_auth_storage_delete_removes_legacy_direct_keyring_entry, secrets_keyring_auth_storage_load_returns_deserialized_auth, secrets_keyring_auth_storage_save_persists_and_removes_fallback_file); 2 external calls (clone, clone).


##### `SecretsKeyringAuthStorage::load`  (lines 302–318)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads encrypted auth JSON from the secrets backend and deserializes it into `AuthDotJson`.

**Data flow**: Calls `secrets_manager.get(&SecretScope::Global, &CODEX_AUTH_SECRET_NAME)`, maps backend errors into `io::Error`, and if a serialized value exists deserializes it with `serde_json::from_str`. It returns `Ok(None)` when no secret exists.

**Call relations**: Implements `AuthStorageBackend::load` for the secrets-backed backend and is the preferred keyring path used by `AutoAuthStorage` when configured for secrets.

*Call graph*: calls 1 internal fn (get); 1 external calls (from_str).


##### `SecretsKeyringAuthStorage::save`  (lines 320–334)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: Stores serialized auth in encrypted local secrets storage and removes any stale fallback file afterward.

**Data flow**: Serializes `auth` with `serde_json::to_string`, writes it via `secrets_manager.set(&SecretScope::Global, &CODEX_AUTH_SECRET_NAME, &serialized)`, maps failures into warned `io::Error`s, then attempts to delete `auth.json`, logging but ignoring fallback-file deletion errors.

**Call relations**: This is the primary persistence path for the modern encrypted backend. Like direct keyring save, it enforces the invariant that successful secure storage should leave no stale plaintext fallback file.

*Call graph*: calls 2 internal fn (delete_file_if_exists, set); 2 external calls (to_string, warn!).


##### `SecretsKeyringAuthStorage::delete`  (lines 336–348)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: Deletes encrypted auth, any fallback file, and any legacy direct-keyring auth entry in one operation.

**Data flow**: Calls `secrets_manager.delete` for the global `CODEX_AUTH` secret, maps errors into `io::Error`, deletes the fallback file with `delete_file_if_exists`, then calls `self.direct_storage.delete()` to remove legacy direct-keyring state. It returns whether any of those removals succeeded.

**Call relations**: Implements delete for the secrets backend and doubles as migration cleanup, ensuring users switching backend implementations do not retain stale credentials in older storage locations.

*Call graph*: calls 3 internal fn (delete, delete_file_if_exists, delete).


##### `AutoAuthStorage::new`  (lines 358–371)

```
fn new(
        codex_home: PathBuf,
        keyring_store: Arc<dyn KeyringStore>,
        keyring_backend_kind: AuthKeyringBackendKind,
    ) -> Self
```

**Purpose**: Builds a composite backend that prefers keyring-backed storage but retains file storage as a fallback.

**Data flow**: Creates `keyring_storage` via `create_keyring_auth_storage` using the requested backend kind and wraps a `FileAuthStorage` for the same `codex_home` in an `Arc` as `file_storage`.

**Call relations**: Constructed by `create_auth_storage_with_store` for `AuthCredentialsStoreMode::Auto`, wiring together the two concrete backends used by its load/save fallback logic.

*Call graph*: calls 2 internal fn (new, create_keyring_auth_storage); called by 7 (create_auth_storage_with_store, auto_auth_storage_delete_removes_keyring_and_file, auto_auth_storage_load_falls_back_when_keyring_errors, auto_auth_storage_load_prefers_keyring_value, auto_auth_storage_load_uses_file_when_keyring_empty, auto_auth_storage_save_falls_back_when_keyring_errors, auto_auth_storage_save_prefers_keyring); 2 external calls (new, clone).


##### `AutoAuthStorage::load`  (lines 375–384)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Loads auth from keyring-backed storage when possible, otherwise falls back to the file backend.

**Data flow**: Calls `self.keyring_storage.load()`. If it returns `Ok(Some(auth))`, that value is returned. If it returns `Ok(None)`, the method loads from `file_storage`. If it returns `Err(err)`, it logs a warning and then loads from `file_storage`.

**Call relations**: This method is the read-side orchestration for auto mode, preferring secure storage but deliberately degrading to disk when the keyring is empty or broken.

*Call graph*: 1 external calls (warn!).


##### `AutoAuthStorage::save`  (lines 386–394)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: Attempts to save auth to keyring-backed storage first and falls back to the file backend if secure storage fails.

**Data flow**: Calls `self.keyring_storage.save(auth)`. On success it returns `Ok(())`. On error it logs a warning and delegates to `self.file_storage.save(auth)`, returning that result.

**Call relations**: This is the write-side orchestration for auto mode, preserving usability when keyring integration is unavailable while still preferring secure storage.

*Call graph*: 1 external calls (warn!).


##### `AutoAuthStorage::delete`  (lines 396–399)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: Deletes auth through the keyring-backed backend, which is responsible for also removing any fallback file.

**Data flow**: Simply returns `self.keyring_storage.delete()`.

**Call relations**: Unlike load/save, delete does not implement its own fallback branching because the underlying keyring backends already delete disk fallback state as part of their cleanup.


##### `EphemeralAuthStorage::new`  (lines 412–414)

```
fn new(codex_home: PathBuf) -> Self
```

**Purpose**: Constructs the in-memory-only auth backend for a specific `codex_home` namespace.

**Data flow**: Stores the provided `PathBuf` in `EphemeralAuthStorage { codex_home }` and returns it.

**Call relations**: Created by `create_auth_storage_with_store` when ephemeral mode is requested, typically for tests or sessions that must avoid persistence.

*Call graph*: called by 1 (create_auth_storage_with_store).


##### `EphemeralAuthStorage::with_store`  (lines 416–425)

```
fn with_store(&self, action: F) -> std::io::Result<T>
```

**Purpose**: Provides synchronized access to the global in-memory auth map using the stable per-home store key.

**Data flow**: Computes the key with `compute_store_key`, locks `EPHEMERAL_AUTH_STORE`, maps lock poisoning into `io::Error`, and invokes the supplied closure with `&mut HashMap<String, AuthDotJson>` and the computed key. It returns the closure’s `io::Result<T>`.

**Call relations**: This helper centralizes key derivation and mutex handling for `EphemeralAuthStorage::load`, `save`, and `delete`.

*Call graph*: calls 1 internal fn (compute_store_key); called by 3 (delete, load, save).


##### `EphemeralAuthStorage::load`  (lines 429–431)

```
fn load(&self) -> std::io::Result<Option<AuthDotJson>>
```

**Purpose**: Reads the current in-memory auth record for this `codex_home`, if any.

**Data flow**: Calls `with_store` with a closure that looks up the computed key in the `HashMap` and clones the stored `AuthDotJson`, returning `Option<AuthDotJson>`.

**Call relations**: Implements `AuthStorageBackend::load` for ephemeral mode using the shared helper for synchronization and keying.

*Call graph*: calls 1 internal fn (with_store).


##### `EphemeralAuthStorage::save`  (lines 433–438)

```
fn save(&self, auth: &AuthDotJson) -> std::io::Result<()>
```

**Purpose**: Stores a clone of the auth record in the global in-memory map for this `codex_home`.

**Data flow**: Calls `with_store` with a closure that inserts `auth.clone()` under the computed key and returns `Ok(())`.

**Call relations**: Implements ephemeral persistence without touching disk or keyring, relying on `with_store` for locking and namespacing.

*Call graph*: calls 1 internal fn (with_store).


##### `EphemeralAuthStorage::delete`  (lines 440–442)

```
fn delete(&self) -> std::io::Result<bool>
```

**Purpose**: Removes the in-memory auth record for this `codex_home` and reports whether one existed.

**Data flow**: Calls `with_store` with a closure that removes the computed key from the map and returns `Ok(store.remove(&key).is_some())`.

**Call relations**: Completes the ephemeral backend’s `AuthStorageBackend` implementation alongside `load` and `save`.

*Call graph*: calls 1 internal fn (with_store).


##### `create_auth_storage`  (lines 445–452)

```
fn create_auth_storage(
    codex_home: PathBuf,
    mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Arc<dyn AuthStorageBackend>
```

**Purpose**: Public factory that creates the configured auth storage backend using the default system keyring implementation.

**Data flow**: Accepts `codex_home`, `AuthCredentialsStoreMode`, and `AuthKeyringBackendKind`, constructs `Arc<dyn KeyringStore>` as `Arc::new(DefaultKeyringStore)`, and delegates to `create_auth_storage_with_store`.

**Call relations**: This is the main entry used by login/logout/auth-loading code elsewhere in the crate. It hides keyring-store construction and forwards backend selection to the internal factory.

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

**Purpose**: Internal factory that selects file, keyring, auto, or ephemeral storage using an injected keyring store implementation.

**Data flow**: Matches on `mode`: `File` returns `Arc<FileAuthStorage>`, `Keyring` delegates to `create_keyring_auth_storage`, `Auto` returns `Arc<AutoAuthStorage>`, and `Ephemeral` returns `Arc<EphemeralAuthStorage>`. It returns `Arc<dyn AuthStorageBackend>`.

**Call relations**: Called by `create_auth_storage` in production and directly by tests to inject `MockKeyringStore` and verify backend-selection behavior.

*Call graph*: calls 4 internal fn (new, new, new, create_keyring_auth_storage); called by 1 (create_auth_storage); 1 external calls (new).


##### `create_keyring_auth_storage`  (lines 474–487)

```
fn create_keyring_auth_storage(
    codex_home: PathBuf,
    keyring_store: Arc<dyn KeyringStore>,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> Arc<dyn AuthStorageBackend>
```

**Purpose**: Chooses between the legacy direct keyring backend and the encrypted secrets-backed backend.

**Data flow**: Matches on `AuthKeyringBackendKind`: `Direct` constructs `DirectKeyringAuthStorage`, `Secrets` constructs `SecretsKeyringAuthStorage`, and returns the chosen backend as `Arc<dyn AuthStorageBackend>`.

**Call relations**: Used by both `create_auth_storage_with_store` and `AutoAuthStorage::new` so all keyring-backed modes share the same backend-selection logic.

*Call graph*: calls 2 internal fn (new, new); called by 2 (new, create_auth_storage_with_store); 1 external calls (new).


### `login/src/auth/bedrock_api_key.rs`

`domain_logic` · `login command / credential switch`

This file is the Bedrock-specific counterpart to the other login helpers in the auth subsystem. Its core data type, `BedrockApiKeyAuth`, is the exact payload serialized into `auth.json` when the user authenticates with an Amazon Bedrock API key: a raw `api_key` string plus the AWS `region` string. The write helper constructs a full `AuthDotJson` snapshot rather than patching an existing file, which is important because it deliberately clears every other credential slot (`openai_api_key`, OAuth `tokens`, `agent_identity`, `personal_access_token`) and sets `auth_mode` to `AuthMode::BedrockApiKey`. That replacement behavior ensures Bedrock auth is mutually exclusive with OpenAI API-key and ChatGPT-backed auth in storage.

The function does not perform validation of the key or region itself; it only materializes the storage record and delegates persistence to the shared `save_auth` path. As a result, all backend selection details—file vs keyring vs ephemeral handling—remain centralized in the manager/storage layer. A subtle compatibility detail is that Bedrock auth is stored in the dedicated `bedrock_api_key` field, so downstream auth loading can infer and reconstruct `CodexAuth::BedrockApiKey` without consulting any external service.

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

**Purpose**: Builds an `AuthDotJson` containing only Bedrock credentials and persists it as the active auth state. It is the write-side entry for switching a Codex home directory into Bedrock API-key authentication.

**Data flow**: Inputs are the target `codex_home` path, borrowed `api_key` and `region` strings, and storage-selection parameters (`AuthCredentialsStoreMode`, `AuthKeyringBackendKind`). It converts the borrowed strings into owned `String`s inside a `BedrockApiKeyAuth`, embeds that in a freshly constructed `AuthDotJson` with all non-Bedrock fields set to `None`, then passes the whole snapshot to shared persistence. It returns the `std::io::Result<()>` from storage unchanged.

**Call relations**: This helper is invoked by Bedrock login flows and tests that need to seed Bedrock auth. After constructing the replacement auth snapshot, it delegates all actual writing and backend-specific behavior to `save_auth`, which is the common persistence path used by other login helpers as well.

*Call graph*: calls 1 internal fn (save_auth).


### `login/src/auth/revoke.rs`

`domain_logic` · `logout`

This file contains the best-effort remote cleanup path used during logout. Its central decision is whether the current `AuthDotJson` represents managed ChatGPT auth and, if so, whether a refresh token or only an access token is available. `revocable_token` prefers `TokenData.refresh_token` and falls back to `TokenData.access_token`; empty strings are treated as absent. The helper `managed_chatgpt_tokens` gates revocation to `ApiAuthMode::Chatgpt`, using `resolved_auth_mode` to preserve backward compatibility with older auth files that may omit `auth_mode` and instead imply API-key mode via `openai_api_key`.

The actual revoke request is serialized as `RevokeTokenRequest { token, token_type_hint, client_id }`. `RevokeTokenKind` encodes the OAuth nuance that refresh-token revocation includes the OAuth client ID while access-token revocation does not. `revoke_oauth_token` posts JSON to the resolved endpoint using `CodexHttpClient`, applies a fixed 10-second timeout, and converts transport failures into `std::io::Error` while preserving the underlying reqwest error as the source. Non-success responses read the body, extract a nested `error.message` via `try_parse_error_message`, and return a concrete message including token kind and HTTP status.

Endpoint selection is override-aware: an explicit revoke URL env var wins; otherwise a refresh-token override URL is transformed to `/oauth/revoke`; otherwise the built-in `REVOKE_TOKEN_URL` constant is used. Tests cover URL derivation and timeout behavior.

#### Function details

##### `RevokeTokenKind::as_str`  (lines 31–36)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps the internal token-kind enum to the OAuth `token_type_hint` string expected by the revoke endpoint.

**Data flow**: Reads `self` (`Access` or `Refresh`) and returns the corresponding static string literal: `"access_token"` or `"refresh_token"`. It does not mutate any state.

**Call relations**: This helper is used inside `revoke_oauth_token` both when building the JSON request body and when formatting user-visible error text, so the same token-kind label stays consistent across request and failure reporting.

*Call graph*: called by 1 (revoke_oauth_token).


##### `RevokeTokenKind::client_id`  (lines 38–43)

```
fn client_id(self) -> Option<String>
```

**Purpose**: Determines whether the revoke request should include an OAuth client ID for the selected token kind.

**Data flow**: Reads `self`; for `Refresh` it calls `oauth_client_id()` and wraps the resulting `String` in `Some`, while for `Access` it returns `None`. The output becomes the optional `client_id` field in `RevokeTokenRequest`.

**Call relations**: Called only by `revoke_oauth_token` while constructing the revoke payload, encoding the protocol distinction that refresh-token revocation needs client identification.

*Call graph*: calls 1 internal fn (oauth_client_id); called by 1 (revoke_oauth_token).


##### `revoke_auth_tokens`  (lines 54–64)

```
async fn revoke_auth_tokens(
    auth_dot_json: Option<&AuthDotJson>,
) -> Result<(), std::io::Error>
```

**Purpose**: Top-level logout helper that decides whether anything should be revoked and, if so, performs the revoke request with the default client, endpoint, and timeout.

**Data flow**: Takes `Option<&AuthDotJson>`. If the option is `None` or `revocable_token` finds no managed ChatGPT token, it returns `Ok(())` immediately. Otherwise it creates a `CodexHttpClient` via `create_client`, resolves the endpoint with `revoke_token_endpoint`, and awaits `revoke_oauth_token`, returning that `io::Result<()>` unchanged.

**Call relations**: This is invoked by logout flows that want remote token invalidation before local auth removal. It orchestrates the file-local helpers rather than doing protocol work itself: token selection, endpoint resolution, and HTTP revocation are delegated.

*Call graph*: calls 3 internal fn (create_client, revoke_oauth_token, revoke_token_endpoint); called by 2 (logout_with_revoke, logout_with_revoke).


##### `revocable_token`  (lines 66–75)

```
fn revocable_token(auth_dot_json: &AuthDotJson) -> Option<(&str, RevokeTokenKind)>
```

**Purpose**: Extracts the specific token string and token kind that should be sent to the revoke endpoint.

**Data flow**: Consumes `&AuthDotJson`, first asking `managed_chatgpt_tokens` for a `&TokenData`. If absent, it returns `None`. If present, it checks `refresh_token` first and returns `Some((&str, RevokeTokenKind::Refresh))` when non-empty; otherwise it checks `access_token` and returns `Some((&str, RevokeTokenKind::Access))`; if both are empty it returns `None`.

**Call relations**: Used by `revoke_auth_tokens` as the gatekeeper for whether revocation should happen at all. It delegates auth-mode filtering to `managed_chatgpt_tokens` and encapsulates the refresh-over-access preference.

*Call graph*: calls 1 internal fn (managed_chatgpt_tokens).


##### `managed_chatgpt_tokens`  (lines 77–83)

```
fn managed_chatgpt_tokens(auth_dot_json: &AuthDotJson) -> Option<&TokenData>
```

**Purpose**: Limits revocation to auth records that represent managed ChatGPT login and have token data attached.

**Data flow**: Reads `auth_dot_json.auth_mode`, `openai_api_key`, and `tokens` indirectly through `resolved_auth_mode`. If the resolved mode is `ApiAuthMode::Chatgpt`, it returns `auth_dot_json.tokens.as_ref()`; otherwise it returns `None`.

**Call relations**: Called by `revocable_token` to prevent revocation attempts for API-key or other non-ChatGPT auth records. It relies on `resolved_auth_mode` to interpret legacy auth files correctly.

*Call graph*: calls 1 internal fn (resolved_auth_mode); called by 1 (revocable_token).


##### `resolved_auth_mode`  (lines 85–93)

```
fn resolved_auth_mode(auth_dot_json: &AuthDotJson) -> ApiAuthMode
```

**Purpose**: Computes the effective auth mode from an `AuthDotJson`, including backward-compatible inference when `auth_mode` is missing.

**Data flow**: Reads `auth_dot_json.auth_mode` first and returns it if present. If absent, it checks whether `openai_api_key` is set; if so it returns `ApiAuthMode::ApiKey`. Otherwise it defaults to `ApiAuthMode::Chatgpt`.

**Call relations**: This helper is only used by `managed_chatgpt_tokens`, where it protects revocation logic from misclassifying older auth files that predate explicit mode storage.

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

**Purpose**: Builds and sends the revoke HTTP request, then converts transport and server failures into descriptive `io::Error` values.

**Data flow**: Accepts a `CodexHttpClient`, endpoint URL, token string, `RevokeTokenKind`, and timeout. It constructs `RevokeTokenRequest` using `kind.as_str()` and `kind.client_id()`, sends a JSON POST with `Content-Type: application/json` and the provided timeout, and maps send failures through `std::io::Error::other`. On success status it returns `Ok(())`. On non-success it reads the response body with `text().await.unwrap_or_default()`, parses a message via `try_parse_error_message`, and returns an `io::Error` containing the token hint, HTTP status, and parsed message.

**Call relations**: This is the protocol core called by `revoke_auth_tokens` in production and by `tests::revoke_request_times_out` to verify timeout propagation. It delegates only small formatting/parsing details to `RevokeTokenKind` and `try_parse_error_message`.

*Call graph*: calls 4 internal fn (post, as_str, client_id, try_parse_error_message); called by 2 (revoke_auth_tokens, revoke_request_times_out); 2 external calls (other, format!).


##### `revoke_token_endpoint`  (lines 132–144)

```
fn revoke_token_endpoint() -> String
```

**Purpose**: Resolves the revoke endpoint URL, honoring explicit and derived environment overrides before falling back to the built-in default.

**Data flow**: Reads process environment variables. If `REVOKE_TOKEN_URL_OVERRIDE_ENV_VAR` is set, it returns that string directly. Otherwise it checks `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR`; if present and `derive_revoke_token_endpoint` succeeds, it returns the derived revoke URL. If neither path applies, it returns `REVOKE_TOKEN_URL.to_string()`.

**Call relations**: Called by `revoke_auth_tokens` just before issuing the revoke request. It delegates URL transformation to `derive_revoke_token_endpoint` when only a refresh-token override is available.

*Call graph*: calls 1 internal fn (derive_revoke_token_endpoint); called by 1 (revoke_auth_tokens); 1 external calls (var).


##### `derive_revoke_token_endpoint`  (lines 146–151)

```
fn derive_revoke_token_endpoint(refresh_endpoint: &str) -> Option<String>
```

**Purpose**: Transforms a refresh-token endpoint URL into the corresponding revoke endpoint URL.

**Data flow**: Parses the input string as `url::Url`; parse failure returns `None`. On success it rewrites the path to `/oauth/revoke`, clears any query string, and returns the resulting URL string in `Some`.

**Call relations**: Used by `revoke_token_endpoint` as a convenience fallback so deployments that override only the refresh endpoint still get a matching revoke endpoint automatically.

*Call graph*: called by 1 (revoke_token_endpoint); 1 external calls (parse).


##### `tests::derives_revoke_url_from_refresh_token_override`  (lines 164–169)

```
fn derives_revoke_url_from_refresh_token_override()
```

**Purpose**: Verifies that a refresh-token override URL is converted into the expected revoke URL and that query parameters are removed.

**Data flow**: Supplies a concrete refresh endpoint string to `derive_revoke_token_endpoint` and asserts that the returned `Option<String>` equals the expected `/oauth/revoke` URL.

**Call relations**: This unit test exercises the endpoint-derivation helper directly, documenting the intended path rewrite behavior used by `revoke_token_endpoint`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::revoke_request_times_out`  (lines 172–199)

```
async fn revoke_request_times_out()
```

**Purpose**: Checks that a stalled revoke request respects the configured timeout and preserves the underlying reqwest timeout error.

**Data flow**: Starts a `wiremock::MockServer`, mounts a delayed `POST /oauth/revoke` response, constructs a `CodexHttpClient`, and calls `revoke_oauth_token` with a 20 ms timeout. It expects an error, extracts the inner `reqwest::Error` from the returned `io::Error`, and asserts `is_timeout()`.

**Call relations**: This test drives `revoke_oauth_token` through its transport-failure path rather than the higher-level logout wrapper, specifically validating the timeout mapping behavior relied on by logout callers.

*Call graph*: calls 3 internal fn (new, new, revoke_oauth_token); 10 external calls (from_millis, from_secs, given, start, new, assert!, format!, skip_if_no_network!, method, path).


### MCP OAuth login and storage
These files implement interactive OAuth login for MCP HTTP servers and the credential persistence and refresh machinery that supports it.

### `rmcp-client/src/perform_oauth_login.rs`

`orchestration` · `interactive auth flow`

This file drives the full OAuth authorization-code flow used to obtain MCP credentials. The public entry points differ only in presentation: `perform_oauth_login` launches the browser and prints the URL, `perform_oauth_login_silent` suppresses the initial URL print unless browser launch fails, and `perform_oauth_login_return_url` returns an `OauthLoginHandle` so callers can display the URL themselves and await completion later.

The core state machine lives in `OauthLoginFlow`. `new` binds a tiny HTTP callback server with `tiny_http`, choosing `127.0.0.1` or `0.0.0.0` based on the configured callback URL host, validating callback port and URL, and deriving a callback-specific path by hashing the target MCP server URL (`callback_id_from_server_url`) and appending that id to the redirect URI path. That callback id prevents unrelated local callbacks from matching. The flow then spawns a blocking request loop that parses callback requests, responds with either a success page or a 400 error, and forwards the parsed result through a oneshot channel.

For authorization bootstrap, `new` builds a reqwest client with merged default headers, then calls `start_authorization`. If no explicit client id is configured, it uses rmcp's `OAuthState::new(...).start_authorization(...)`; otherwise it manually discovers metadata with `AuthorizationManager`, configures `OAuthClientConfig`, and wraps the session in `OAuthState::Session`. Optional `resource` is appended to the authorization URL.

`finish` optionally opens the browser, waits for the callback with a timeout, validates the callback through `oauth_state.handle_callback`, extracts credentials, computes `expires_at`, wraps them as `StoredOAuthTokens`, and persists them via `save_oauth_tokens`. `CallbackServerGuard` ensures the tiny HTTP server is unblocked on drop so the background listener exits cleanly. The tests focus on callback parsing, callback-id derivation, redirect URI rewriting, query-parameter appending, and configured-client-id behavior.

#### Function details

##### `CallbackServerGuard::drop`  (lines 45–47)

```
fn drop(&mut self)
```

**Purpose**: Unblocks the tiny HTTP callback server when the flow is dropped so the blocking receive loop can exit. This is the cleanup hook that prevents the callback listener from hanging indefinitely.

**Data flow**: Reads the stored `Arc<Server>` and calls `server.unblock()` during drop → returns unit.

**Call relations**: Owned inside `OauthLoginFlow`; it is dropped explicitly at the end of `finish` and implicitly on early exits, coordinating shutdown of the background callback server spawned by `spawn_callback_server`.


##### `OAuthProviderError::new`  (lines 57–62)

```
fn new(error: Option<String>, error_description: Option<String>) -> Self
```

**Purpose**: Constructs a structured error representing `error` and `error_description` values returned by the OAuth provider in the callback query string.

**Data flow**: Takes optional `error` and `error_description` strings → stores them in `OAuthProviderError` → returns the new value.

**Call relations**: Used only by `parse_oauth_callback` when the callback contains provider-side error parameters instead of an authorization code.

*Call graph*: called by 1 (parse_oauth_callback).


##### `OAuthProviderError::fmt`  (lines 66–75)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats provider callback errors into human-readable messages, choosing the most specific wording available from the optional fields.

**Data flow**: Reads `self.error` and `self.error_description` as optional string slices → matches the four combinations and writes the corresponding message into the formatter → returns `std::fmt::Result`.

**Call relations**: Used whenever `OAuthProviderError` is displayed, notably when callback parsing yields an error and `finish` converts it into an `anyhow!` failure.

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

**Purpose**: Runs the standard interactive OAuth login flow, printing the authorization URL and attempting to open it in the browser. It blocks until the callback completes or the flow fails.

**Data flow**: Accepts server identity, storage settings, optional headers, scopes, OAuth overrides, and callback settings → forwards all arguments to `perform_oauth_login_with_browser_output` with `emit_browser_url = true` → returns `Result<()>` from the underlying flow.

**Call relations**: This is the user-facing convenience entry point for normal login. It delegates all real work to the shared helper.

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

**Purpose**: Runs the interactive OAuth login flow without proactively printing the authorization URL. It still launches the browser and only prints fallback instructions if browser launch fails.

**Data flow**: Takes the same inputs as `perform_oauth_login` → forwards them to `perform_oauth_login_with_browser_output` with `emit_browser_url = false` → returns `Result<()>`.

**Call relations**: Alternative public entry point for callers that want less console output. It shares the same flow construction and completion logic.

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

**Purpose**: Builds an `OauthLoginFlow` configured to launch the browser and then runs it to completion. It is the common implementation behind the two blocking login entry points.

**Data flow**: Packages `http_headers` and `env_http_headers` into `OauthHeaders`, constructs `OauthLoginFlow::new(...)` with `launch_browser = true` and no explicit timeout override, awaits flow creation, then calls `finish(emit_browser_url)` → returns `Result<()>`.

**Call relations**: Called by both `perform_oauth_login` and `perform_oauth_login_silent`. It delegates setup to `OauthLoginFlow::new` and execution to `OauthLoginFlow::finish`.

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

**Purpose**: Starts the OAuth flow without launching a browser and returns both the authorization URL and an async completion handle. This supports UIs that want to present the URL themselves.

**Data flow**: Builds `OauthHeaders`, constructs `OauthLoginFlow::new(...)` with `launch_browser = false` and optional timeout override, reads `flow.authorization_url()`, starts background completion with `flow.spawn()`, and wraps both pieces in `OauthLoginHandle::new` → returns `Result<OauthLoginHandle>`.

**Call relations**: Public non-blocking variant of the login flow. It uses the same setup path as the blocking helpers but hands off completion to a spawned task.

*Call graph*: calls 2 internal fn (new, new).


##### `spawn_callback_server`  (lines 221–264)

```
fn spawn_callback_server(
    server: Arc<Server>,
    tx: oneshot::Sender<CallbackResult>,
    expected_callback_path: String,
)
```

**Purpose**: Runs the local HTTP callback listener in a blocking task, parsing incoming requests until it receives a valid success or provider-error callback. It also sends a human-readable HTTP response back to the browser.

**Data flow**: Takes the bound `Server`, a oneshot sender, and the expected callback path → spawns a blocking loop over `server.recv()`; for each request it parses `request.url()` with `parse_oauth_callback`, responds with success text, provider error text, or generic invalid-callback text, and on success/error sends `CallbackResult` through the oneshot channel before breaking.

**Call relations**: Called from `OauthLoginFlow::new` after the callback path is determined. It delegates callback interpretation to `parse_oauth_callback` and feeds the result into `OauthLoginFlow::finish` via the receiver.

*Call graph*: called by 1 (new); 1 external calls (spawn_blocking).


##### `parse_oauth_callback`  (lines 285–324)

```
fn parse_oauth_callback(path: &str, expected_callback_path: &str) -> CallbackOutcome
```

**Purpose**: Parses the callback request path and query string into either a successful authorization code/state pair, a provider error, or an invalid callback. It enforces an exact path match before looking at query parameters.

**Data flow**: Takes the raw request path and expected callback path → splits on `?`, rejects missing query or mismatched route as `Invalid`, iterates query pairs, URL-decodes values, captures `code`, `state`, `error`, and `error_description`, then returns `Success` if both code and state are present, `Error(OAuthProviderError::new(...))` if provider error fields exist, otherwise `Invalid`.

**Call relations**: Used exclusively by `spawn_callback_server` and directly by unit tests. It is the parser that gates whether an incoming HTTP request completes the OAuth flow.

*Call graph*: calls 1 internal fn (new); called by 6 (parse_oauth_callback_accepts_callback_id_path, parse_oauth_callback_accepts_custom_path, parse_oauth_callback_accepts_default_path, parse_oauth_callback_rejects_missing_callback_id_path, parse_oauth_callback_rejects_wrong_path, parse_oauth_callback_returns_provider_error); 3 external calls (Error, Success, decode).


##### `OauthLoginHandle::new`  (lines 332–337)

```
fn new(authorization_url: String, completion: oneshot::Receiver<Result<()>>) -> Self
```

**Purpose**: Constructs the handle returned by the non-blocking login API. It bundles the authorization URL with the completion receiver.

**Data flow**: Takes an owned `authorization_url` string and a `oneshot::Receiver<Result<()>>` → stores them in `OauthLoginHandle` → returns the handle.

**Call relations**: Called by `perform_oauth_login_return_url` after creating and spawning an `OauthLoginFlow`.

*Call graph*: called by 1 (perform_oauth_login_return_url).


##### `OauthLoginHandle::authorization_url`  (lines 339–341)

```
fn authorization_url(&self) -> &str
```

**Purpose**: Returns the authorization URL string that the caller should present to the user. It borrows rather than consuming the handle.

**Data flow**: Reads `self.authorization_url` and returns `&str`.

**Call relations**: Used by callers of `perform_oauth_login_return_url` that want to inspect the URL without consuming the handle.


##### `OauthLoginHandle::into_parts`  (lines 343–345)

```
fn into_parts(self) -> (String, oneshot::Receiver<Result<()>>)
```

**Purpose**: Splits the handle into its raw authorization URL and completion receiver. This is useful for callers that want to manage the receiver directly.

**Data flow**: Consumes `self` → returns `(self.authorization_url, self.completion)`.

**Call relations**: Alternative consumption path for the non-blocking login API, parallel to `wait`.


##### `OauthLoginHandle::wait`  (lines 347–351)

```
async fn wait(self) -> Result<()>
```

**Purpose**: Awaits completion of the background OAuth login task and converts channel cancellation into a descriptive error. It is the ergonomic completion API for the returned handle.

**Data flow**: Consumes `self`, awaits `self.completion`, maps a dropped sender into `anyhow!("OAuth login task was cancelled: ...")`, and otherwise returns the inner `Result<()>`.

**Call relations**: Used by callers of `perform_oauth_login_return_url` after they have shown the authorization URL to the user.


##### `resolve_callback_port`  (lines 367–378)

```
fn resolve_callback_port(callback_port: Option<u16>) -> Result<Option<u16>>
```

**Purpose**: Validates the optional configured callback port. Port zero is explicitly rejected because the code uses `None` to mean 'bind an ephemeral port'.

**Data flow**: Takes `Option<u16>` → if `Some(0)`, returns a `bail!` error; if `Some(nonzero)`, returns it unchanged; if `None`, returns `Ok(None)`.

**Call relations**: Called during `OauthLoginFlow::new` before binding the callback server.

*Call graph*: called by 1 (new); 1 external calls (bail!).


##### `local_redirect_uri`  (lines 380–395)

```
fn local_redirect_uri(server: &Server) -> Result<String>
```

**Purpose**: Builds the default local redirect URI from the actual bound callback server address. It supports both IPv4 and IPv6 listener addresses.

**Data flow**: Reads `server.server_addr()` → for IPv4 formats `http://ip:port/callback`, for IPv6 formats `http://[ip]:port/callback`, and on unsupported non-Windows address kinds returns an error → returns `Result<String>`.

**Call relations**: Used by `resolve_redirect_uri` when no explicit callback URL is configured.

*Call graph*: called by 1 (resolve_redirect_uri); 3 external calls (server_addr, anyhow!, format!).


##### `resolve_redirect_uri`  (lines 397–404)

```
fn resolve_redirect_uri(server: &Server, callback_url: Option<&str>) -> Result<String>
```

**Purpose**: Chooses the redirect URI for the OAuth flow, either using the configured callback URL after validation or deriving one from the bound local server. It ensures configured URLs are syntactically valid.

**Data flow**: If `callback_url` is `None`, delegates to `local_redirect_uri(server)`; otherwise parses the provided URL with `reqwest::Url::parse` for validation and returns it as a string.

**Call relations**: Called by `OauthLoginFlow::new` before callback-id rewriting.

*Call graph*: calls 1 internal fn (local_redirect_uri); called by 1 (new); 1 external calls (parse).


##### `callback_id_from_server_url`  (lines 406–416)

```
fn callback_id_from_server_url(server_url: &str) -> Result<String>
```

**Purpose**: Derives a short, deterministic callback identifier from the target MCP server URL. The id is bound to host, path, query, and port, but ignores URL fragments.

**Data flow**: Parses `server_url`, requires that it contain a host, clears any fragment, hashes the normalized URL bytes with SHA-256, takes the first 9 digest bytes, and base64url-encodes them without padding → returns the callback id string.

**Call relations**: Called by `OauthLoginFlow::new` to namespace the callback path per server, and directly by tests that verify the binding properties.

*Call graph*: called by 2 (new, callback_id_is_bound_to_server_url); 2 external calls (digest, parse).


##### `append_callback_id_to_redirect_uri`  (lines 418–429)

```
fn append_callback_id_to_redirect_uri(redirect_uri: &str, callback_id: &str) -> Result<String>
```

**Purpose**: Appends the derived callback id as an extra path segment on the redirect URI while preserving any existing query string. This creates a callback path unique to the target server.

**Data flow**: Parses `redirect_uri`, reads its current path, appends `/{callback_id}` or `{callback_id}` depending on whether the path already ends with `/`, writes the new path back, and returns the full URI string.

**Call relations**: Used by `OauthLoginFlow::new` after computing the callback id. Tests verify both plain-path and query-preserving cases.

*Call graph*: called by 3 (new, callback_id_is_appended_before_redirect_uri_query, callback_id_is_appended_to_redirect_uri_path); 2 external calls (parse, format!).


##### `callback_path_from_redirect_uri`  (lines 431–435)

```
fn callback_path_from_redirect_uri(redirect_uri: &str) -> Result<String>
```

**Purpose**: Extracts just the path component from the redirect URI. The callback server uses this path to decide which incoming requests belong to the active OAuth flow.

**Data flow**: Parses `redirect_uri` and returns `parsed.path().to_string()`.

**Call relations**: Called by `OauthLoginFlow::new` after callback-id rewriting and by a unit test.

*Call graph*: called by 2 (new, callback_path_comes_from_redirect_uri); 1 external calls (parse).


##### `callback_bind_host`  (lines 437–450)

```
fn callback_bind_host(callback_url: Option<&str>) -> &'static str
```

**Purpose**: Chooses the host interface to bind the local callback server on. Localhost-like callback URLs bind only to loopback; non-local callback hosts bind to `0.0.0.0` so external redirects can reach the listener.

**Data flow**: If `callback_url` is absent or unparsable, returns `127.0.0.1`; otherwise parses the URL and returns `127.0.0.1` for `localhost`, `127.0.0.1`, `::1`, or missing host, and `0.0.0.0` for any other host.

**Call relations**: Used early in `OauthLoginFlow::new` to build the bind address before the server is started.

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

**Purpose**: Constructs the full OAuth login flow: callback server, redirect URI, callback parser task, HTTP client, authorization bootstrap, final authorization URL, and timeout policy. It is the main setup routine for all login entry points.

**Data flow**: Consumes server identity, storage settings, header sources, scopes, OAuth overrides, browser-launch flag, callback settings, and optional timeout → computes bind host and validated port, starts `tiny_http::Server`, wraps it in `CallbackServerGuard`, resolves and rewrites the redirect URI with a callback id, extracts the callback path, creates a oneshot channel and starts `spawn_callback_server`, builds default headers and a reqwest client, converts scopes to `&str`, calls `start_authorization`, appends optional `resource` to the authorization URL, computes a positive timeout duration, and returns an initialized `OauthLoginFlow` containing all runtime state.

**Call relations**: Called by all three public login entry points. It delegates callback-path mechanics to helper functions and authorization bootstrap to `start_authorization`.

*Call graph*: calls 11 internal fn (append_callback_id_to_redirect_uri, append_query_param, callback_bind_host, callback_id_from_server_url, callback_path_from_redirect_uri, resolve_callback_port, resolve_redirect_uri, spawn_callback_server, start_authorization, apply_default_headers (+1 more)); called by 2 (perform_oauth_login_return_url, perform_oauth_login_with_browser_output); 7 external calls (clone, new, new, from_secs, http, format!, channel).


##### `OauthLoginFlow::authorization_url`  (lines 528–530)

```
fn authorization_url(&self) -> String
```

**Purpose**: Returns a clone of the prepared authorization URL. The clone keeps the flow's internal state intact for later completion.

**Data flow**: Reads `self.auth_url`, clones it, and returns the cloned `String`.

**Call relations**: Used by `perform_oauth_login_return_url` before the flow is spawned.


##### `OauthLoginFlow::finish`  (lines 532–599)

```
async fn finish(mut self, emit_browser_url: bool) -> Result<()>
```

**Purpose**: Runs the active OAuth flow to completion: optionally opens the browser, waits for the callback, exchanges the callback through rmcp's OAuth state, extracts credentials, and persists them. It also guarantees callback-server cleanup before returning.

**Data flow**: Consumes `self` mutably and `emit_browser_url` → if `launch_browser` is true, optionally prints the URL and attempts `webbrowser::open`, printing fallback instructions on failure; then awaits the callback receiver under `tokio::time::timeout`, converts `CallbackResult::Error` into an `anyhow!` error or extracts `code` and `state`, calls `self.oauth_state.handle_callback`, then `get_credentials`, errors if credentials are absent, computes `expires_at`, builds `StoredOAuthTokens` with `WrappedOAuthTokenResponse`, and persists them via `save_oauth_tokens`; finally drops `self.guard` to unblock the callback server and returns the result.

**Call relations**: Called directly by the blocking login helper and indirectly by `spawn` in the non-blocking path. It is the terminal phase of the OAuth flow.

*Call graph*: calls 1 internal fn (compute_expires_at_millis); called by 1 (spawn); 9 external calls (get_credentials, handle_callback, anyhow!, save_oauth_tokens, eprintln!, println!, new, timeout, open).


##### `OauthLoginFlow::spawn`  (lines 601–618)

```
fn spawn(self) -> oneshot::Receiver<Result<()>>
```

**Purpose**: Runs `finish` in a background Tokio task and returns a oneshot receiver for the eventual result. It also logs failures to stderr for visibility when the caller does not await immediately.

**Data flow**: Clones `server_name` for logging, creates a oneshot channel, spawns an async task that awaits `self.finish(false)`, prints any error with context, sends the result through the channel, and returns the receiver.

**Call relations**: Used by `perform_oauth_login_return_url` to decouple URL presentation from flow completion.

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

**Purpose**: Bootstraps rmcp OAuth authorization state, either using automatic client registration/discovery behavior or an explicitly configured client id. It returns an `OAuthState` ready to produce an authorization URL and later handle the callback.

**Data flow**: Takes `server_url`, a reqwest client, scopes, redirect URI, and optional client id → if the client id is absent or blank, creates `OAuthState::new(server_url, Some(http_client))`, calls `start_authorization(scopes, redirect_uri, Some("Codex"))`, and returns it; otherwise creates `AuthorizationManager::new(server_url)`, attaches the client, discovers metadata, configures `OAuthClientConfig` with scopes, gets the authorization URL, and wraps the configured manager in `OAuthState::Session(AuthorizationSession::for_scope_upgrade(...))`.

**Call relations**: Called only by `OauthLoginFlow::new`. Tests verify the explicit-client-id branch by inspecting the generated authorization URL.

*Call graph*: called by 2 (new, start_authorization_uses_configured_client_id); 5 external calls (new, for_scope_upgrade, new, Session, new).


##### `append_query_param`  (lines 652–667)

```
fn append_query_param(url: &str, key: &str, value: Option<&str>) -> String
```

**Purpose**: Adds an optional query parameter to an authorization URL, preserving existing query parameters when possible and falling back to string concatenation for unparseable URLs. Empty or whitespace-only values are ignored.

**Data flow**: Takes `url`, `key`, and optional `value` → if value is absent or trims to empty, returns the original URL string; otherwise tries to parse the URL and append the pair through `query_pairs_mut`, or if parsing fails URL-encodes the value and concatenates `?key=value` or `&key=value` manually → returns the resulting string.

**Call relations**: Used by `OauthLoginFlow::new` to append the optional OAuth `resource` parameter. Several unit tests cover its parseable and fallback behaviors.

*Call graph*: called by 4 (new, append_query_param_adds_resource_to_absolute_url, append_query_param_handles_unparseable_url, append_query_param_ignores_empty_values); 3 external calls (parse, format!, encode).


##### `tests::spawn_oauth_metadata_server`  (lines 688–723)

```
async fn spawn_oauth_metadata_server() -> String
```

**Purpose**: Starts a lightweight local HTTP server that serves OAuth metadata documents for tests. It provides deterministic endpoints for authorization bootstrap tests.

**Data flow**: Binds a random local TCP port, builds an Axum router serving metadata JSON at both path-scoped and generic well-known endpoints, spawns the server task, and returns the base URL string.

**Call relations**: Used by `start_authorization_uses_configured_client_id` to exercise metadata discovery without external dependencies.

*Call graph*: 7 external calls (new, bind, get, serve, format!, json!, spawn).


##### `tests::start_authorization_uses_configured_client_id`  (lines 726–749)

```
async fn start_authorization_uses_configured_client_id()
```

**Purpose**: Verifies that when an explicit OAuth client id is supplied, the generated authorization URL includes that exact `client_id` query parameter. This confirms the manual `AuthorizationManager` branch is used.

**Data flow**: Starts the test metadata server, calls `start_authorization` with a configured client id, retrieves the authorization URL from the returned `OAuthState`, parses it, extracts the `client_id` query parameter, and asserts it matches the configured value.

**Call relations**: Exercises the explicit-client-id branch of `start_authorization`.

*Call graph*: calls 2 internal fn (new, start_authorization); 4 external calls (parse, assert_eq!, format!, spawn_oauth_metadata_server).


##### `tests::parse_oauth_callback_accepts_default_path`  (lines 752–755)

```
fn parse_oauth_callback_accepts_default_path()
```

**Purpose**: Checks that a callback on the default `/callback` path with `code` and `state` is accepted as success.

**Data flow**: Calls `parse_oauth_callback` with `/callback?code=abc&state=xyz` and expected path `/callback`, then asserts the result matches `CallbackOutcome::Success`.

**Call relations**: Covers the simplest success case for callback parsing.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_accepts_custom_path`  (lines 758–761)

```
fn parse_oauth_callback_accepts_custom_path()
```

**Purpose**: Verifies that callback parsing honors a configured non-default callback path. The parser should not be hardcoded to `/callback`.

**Data flow**: Calls `parse_oauth_callback` with `/oauth/callback?code=abc&state=xyz` and expected path `/oauth/callback`, then asserts success.

**Call relations**: Exercises path matching in `parse_oauth_callback` for custom callback routes.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_accepts_callback_id_path`  (lines 764–768)

```
fn parse_oauth_callback_accepts_callback_id_path()
```

**Purpose**: Checks that callback parsing accepts callback-id-suffixed paths generated by the flow. This validates the path namespacing mechanism.

**Data flow**: Calls `parse_oauth_callback` with `/callback/abc123?code=abc&state=xyz` and expected path `/callback/abc123`, then asserts success.

**Call relations**: Covers the callback-id path shape produced by `append_callback_id_to_redirect_uri`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_rejects_missing_callback_id_path`  (lines 771–774)

```
fn parse_oauth_callback_rejects_missing_callback_id_path()
```

**Purpose**: Ensures a callback lacking the expected callback-id suffix is rejected as invalid. This prevents cross-server callback confusion.

**Data flow**: Calls `parse_oauth_callback` with `/callback?code=abc&state=xyz` while expecting `/callback/abc123`, then asserts `CallbackOutcome::Invalid`.

**Call relations**: Exercises the exact-path guard in `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_rejects_wrong_path`  (lines 777–780)

```
fn parse_oauth_callback_rejects_wrong_path()
```

**Purpose**: Verifies that callbacks on the wrong route are rejected even if they contain plausible OAuth query parameters.

**Data flow**: Calls `parse_oauth_callback` with `/callback?code=abc&state=xyz` and expected path `/oauth/callback`, then asserts invalid.

**Call relations**: Another path-mismatch test for `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert!).


##### `tests::parse_oauth_callback_returns_provider_error`  (lines 783–796)

```
fn parse_oauth_callback_returns_provider_error()
```

**Purpose**: Checks that provider-side callback errors are parsed into `OAuthProviderError` rather than treated as generic invalid callbacks. It also verifies URL-decoding of `error_description`.

**Data flow**: Calls `parse_oauth_callback` with `error` and `error_description` query parameters, then asserts the result equals `CallbackOutcome::Error(OAuthProviderError::new(...))` with decoded text.

**Call relations**: Exercises the provider-error branch of `parse_oauth_callback`.

*Call graph*: calls 1 internal fn (parse_oauth_callback); 1 external calls (assert_eq!).


##### `tests::callback_path_comes_from_redirect_uri`  (lines 799–803)

```
fn callback_path_comes_from_redirect_uri()
```

**Purpose**: Verifies that path extraction from a redirect URI returns only the path component. Query and host information should not leak into callback matching.

**Data flow**: Calls `callback_path_from_redirect_uri` on a sample HTTPS URI and asserts the returned string is `/oauth/callback`.

**Call relations**: Direct unit test for the helper used during flow setup.

*Call graph*: calls 1 internal fn (callback_path_from_redirect_uri); 1 external calls (assert_eq!).


##### `tests::callback_id_is_bound_to_server_url`  (lines 806–829)

```
fn callback_id_is_bound_to_server_url()
```

**Purpose**: Checks the normalization and uniqueness properties of callback ids derived from server URLs. Fragments are ignored, while path, query, and origin changes alter the id.

**Data flow**: Computes callback ids for several related server URLs, compares equality/inequality across variants, and asserts the resulting id length and character set are URL-safe.

**Call relations**: Exercises `callback_id_from_server_url` and documents its identity semantics.

*Call graph*: calls 1 internal fn (callback_id_from_server_url); 3 external calls (assert!, assert_eq!, assert_ne!).


##### `tests::callback_id_is_appended_to_redirect_uri_path`  (lines 832–838)

```
fn callback_id_is_appended_to_redirect_uri_path()
```

**Purpose**: Verifies that callback ids are appended as an extra path segment on a plain redirect URI.

**Data flow**: Calls `append_callback_id_to_redirect_uri` on `http://127.0.0.1:1234/callback` with `abc123` and asserts the result ends with `/callback/abc123`.

**Call relations**: Direct test of redirect URI rewriting.

*Call graph*: calls 1 internal fn (append_callback_id_to_redirect_uri); 1 external calls (assert_eq!).


##### `tests::callback_id_is_appended_before_redirect_uri_query`  (lines 841–852)

```
fn callback_id_is_appended_before_redirect_uri_query()
```

**Purpose**: Ensures callback-id path rewriting preserves existing query parameters and inserts the id before the query string.

**Data flow**: Calls `append_callback_id_to_redirect_uri` on a URI with `?provider=github` and asserts the resulting URI has `/callback/abc123?provider=github`.

**Call relations**: Covers the query-preserving behavior of the redirect URI helper.

*Call graph*: calls 1 internal fn (append_callback_id_to_redirect_uri); 1 external calls (assert_eq!).


##### `tests::append_query_param_adds_resource_to_absolute_url`  (lines 855–866)

```
fn append_query_param_adds_resource_to_absolute_url()
```

**Purpose**: Checks that `append_query_param` appends a new query parameter to a parseable absolute URL and URL-encodes the value.

**Data flow**: Calls `append_query_param` with an HTTPS authorization URL and a `resource` value, then asserts the expected encoded URL string.

**Call relations**: Exercises the parsed-URL branch of `append_query_param`.

*Call graph*: calls 1 internal fn (append_query_param); 1 external calls (assert_eq!).


##### `tests::append_query_param_ignores_empty_values`  (lines 869–877)

```
fn append_query_param_ignores_empty_values()
```

**Purpose**: Verifies that whitespace-only optional parameter values are ignored rather than producing empty query parameters.

**Data flow**: Calls `append_query_param` with a whitespace `resource` value and asserts the original URL is returned unchanged.

**Call relations**: Covers the early-return branch for empty values.

*Call graph*: calls 1 internal fn (append_query_param); 1 external calls (assert_eq!).


##### `tests::append_query_param_handles_unparseable_url`  (lines 880–884)

```
fn append_query_param_handles_unparseable_url()
```

**Purpose**: Checks the fallback string-concatenation behavior when the base URL cannot be parsed. The helper should still append an encoded query parameter.

**Data flow**: Calls `append_query_param` with `not a url` and a resource value, then asserts the manually concatenated encoded result.

**Call relations**: Exercises the unparseable-URL fallback branch of `append_query_param`.

*Call graph*: calls 1 internal fn (append_query_param); 1 external calls (assert_eq!).


### `rmcp-client/src/oauth.rs`

`domain_logic` · `auth persistence and refresh`

This file is the persistence layer for MCP OAuth credentials. Its core data model is `StoredOAuthTokens`, which records `server_name`, `url`, `client_id`, a wrapped `OAuthTokenResponse`, and an optional absolute `expires_at` timestamp in milliseconds. `WrappedOAuthTokenResponse` exists solely to make equality comparisons stable by serializing both responses to JSON and comparing the serialized forms; this lets the code detect meaningful token changes even though the upstream type lacks `PartialEq`.

Storage is selectable through `OAuthCredentialsStoreMode` and `AuthKeyringBackendKind`. Public entry points (`load_oauth_tokens`, `save_oauth_tokens`, `delete_oauth_tokens`, `oauth_token_status`) dispatch to direct keyring storage, encrypted `SecretsManager` storage under the `McpOAuth` namespace, or `CODEX_HOME/.credentials.json`. In `Auto` mode, reads and writes prefer keyring/secrets but fall back to the file on failure, logging warnings and cleaning up stale fallback entries after successful secure writes. Keys are deterministic: `compute_store_key` hashes a JSON payload containing MCP server type/url/headers into a readable `server_name|hash` key, while `compute_secret_name` re-hashes that key into the restricted `SecretName` alphabet.

Expiry handling is subtle. Persisted tokens store `expires_at`; on load, `refresh_expires_in_from_timestamp` reconstructs `expires_in` for rmcp, and explicitly sets zero duration for known-expired tokens so startup refresh happens before first use. `oauth_tokens_are_usable` treats near-expiry tokens as requiring a nonblank refresh token. `OAuthPersistor` ties this storage layer to a live `AuthorizationManager`: it serializes access through a mutex, persists only when credentials changed, preserves prior `expires_at` when the token body is unchanged, deletes storage when credentials disappear, and proactively refreshes tokens when `token_needs_refresh` says the skew-adjusted expiry is near.

The test module is extensive and verifies fallback behavior, secrets backend semantics, deletion rules, expiry restoration, and token usability edge cases using a temporary `CODEX_HOME` and a mock keyring store.

#### Function details

##### `WrappedOAuthTokenResponse::eq`  (lines 78–83)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Implements equality for wrapped OAuth responses by comparing their JSON serialization. This avoids depending on field-by-field equality support from the upstream token type.

**Data flow**: Takes `&self` and `&other` → serializes both wrappers with `serde_json::to_string` → returns `true` if both serializations succeed and the strings match, otherwise `false`.

**Call relations**: Used indirectly by persistence logic when `OAuthPersistor::persist_if_needed` decides whether credentials changed enough to rewrite storage. It is also exercised by tests comparing stored token snapshots.

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

**Purpose**: Loads persisted OAuth credentials using the configured storage mode. It centralizes the policy for preferring secure storage versus file fallback.

**Data flow**: Consumes `server_name`, `url`, `store_mode`, and `keyring_backend_kind` → constructs `DefaultKeyringStore` and dispatches to keyring-only, file-only, or keyring-with-file-fallback loaders → returns `Result<Option<StoredOAuthTokens>>`.

**Call relations**: Called by `oauth_token_status` and by HTTP client setup in `RmcpClient::create_pending_transport`. It delegates to the lower-level storage-specific loaders based on configuration.

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

**Purpose**: Classifies persisted credentials as missing, immediately usable, or requiring reauthorization. It is the higher-level status API used by auth-status checks.

**Data flow**: Reads the same lookup inputs as `load_oauth_tokens` → loads tokens, then maps `None` to `Missing`, usable tokens to `Usable`, and present-but-unusable tokens to `AuthorizationRequired` via `oauth_tokens_are_usable` → returns `Result<StoredOAuthTokenStatus>`.

**Call relations**: Invoked by auth-status determination code outside this file. It depends on `load_oauth_tokens` for retrieval and `oauth_tokens_are_usable` for semantic classification.

*Call graph*: calls 2 internal fn (load_oauth_tokens, oauth_tokens_are_usable); called by 1 (determine_streamable_http_auth_status).


##### `oauth_tokens_are_usable`  (lines 130–143)

```
fn oauth_tokens_are_usable(tokens: &StoredOAuthTokens) -> bool
```

**Purpose**: Determines whether a stored token set can satisfy requests now or can be refreshed in time. It rejects blank client ids, blank access tokens, and expired/near-expiry tokens without a usable refresh token.

**Data flow**: Reads `StoredOAuthTokens.client_id`, `token_response`, and `expires_at` → if client id is blank returns `false`; if `token_needs_refresh(expires_at)` is true, checks for a present, nonblank refresh token; otherwise checks for a nonblank access token → returns `bool`.

**Call relations**: Used by `oauth_token_status` and covered by many tests for expiry and blank-field edge cases. Its refresh-skew logic aligns with `OAuthPersistor::refresh_if_needed`.

*Call graph*: calls 1 internal fn (token_needs_refresh); called by 1 (oauth_token_status).


##### `refresh_expires_in_from_timestamp`  (lines 145–165)

```
fn refresh_expires_in_from_timestamp(tokens: &mut StoredOAuthTokens)
```

**Purpose**: Reconstructs rmcp/oauth2's relative `expires_in` field from the persisted absolute `expires_at` timestamp. It also marks known-expired tokens with zero duration so refresh happens eagerly.

**Data flow**: Mutably reads `tokens.expires_at` → if absent, leaves the token unchanged; otherwise computes remaining seconds with `expires_in_from_timestamp` and writes `token_response.0.set_expires_in(Some(&duration))`, using `Duration::ZERO` when the timestamp is already expired → returns unit.

**Call relations**: Called immediately after deserializing tokens from direct keyring, secrets storage, or fallback file. It bridges this file's persisted timestamp format back into the runtime expectations of rmcp.

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

**Purpose**: Attempts secure keyring/secrets loading first and transparently falls back to the JSON file when the secure path is empty or errors. It preserves the original keyring error as context when fallback also fails.

**Data flow**: Takes a generic `KeyringStore`, backend kind, server identity, and URL → calls `load_oauth_tokens_from_keyring`; on `Ok(Some(_))` returns that, on `Ok(None)` loads from file, and on `Err` logs a warning then loads from file with added context → returns `Result<Option<StoredOAuthTokens>>`.

**Call relations**: Used by `load_oauth_tokens` in `Auto` mode. It is the read-side counterpart to the write-side fallback function.

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

**Purpose**: Dispatches secure credential loading to either the direct keyring backend or the encrypted secrets backend. It does not perform file fallback itself.

**Data flow**: Consumes a `KeyringStore`, backend kind, server name, and URL → matches `AuthKeyringBackendKind` and calls the corresponding backend-specific loader → returns `Result<Option<StoredOAuthTokens>>`.

**Call relations**: Called by both `load_oauth_tokens` and the fallback wrapper. It is the secure-storage branch point for reads.

*Call graph*: calls 2 internal fn (load_oauth_tokens_from_direct_keyring, load_oauth_tokens_from_secrets_keyring); called by 2 (load_oauth_tokens, load_oauth_tokens_from_keyring_with_fallback_to_file).


##### `load_oauth_tokens_from_direct_keyring`  (lines 200–216)

```
fn load_oauth_tokens_from_direct_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Loads serialized `StoredOAuthTokens` directly from the OS keyring under the deterministic MCP key. It restores runtime expiry metadata after deserialization.

**Data flow**: Computes the key with `compute_store_key(server_name, url)` → calls `keyring_store.load(KEYRING_SERVICE, &key)` → on `Some(serialized)` deserializes JSON into `StoredOAuthTokens`, mutates it with `refresh_expires_in_from_timestamp`, and returns `Some(tokens)`; on missing returns `None`; on keyring error wraps it into `anyhow::Error`.

**Call relations**: Selected by `load_oauth_tokens_from_keyring` for `Direct` backend. It is the simplest secure read path and is heavily exercised by tests.

*Call graph*: calls 2 internal fn (compute_store_key, refresh_expires_in_from_timestamp); called by 1 (load_oauth_tokens_from_keyring); 3 external calls (load, new, from_str).


##### `load_oauth_tokens_from_secrets_keyring`  (lines 218–243)

```
fn load_oauth_tokens_from_secrets_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Loads OAuth credentials from the encrypted local secrets store backed by `SecretsManager`. It uses the `McpOAuth` namespace and a restricted-format secret name derived from the MCP store key.

**Data flow**: Finds `CODEX_HOME`, constructs `SecretsManager::new_with_keyring_store_and_namespace(..., LocalSecretsNamespace::McpOAuth)`, computes `SecretName` with `compute_secret_name`, and calls `manager.get(Global, secret_name)` → on `Some(serialized)` deserializes, restores `expires_in`, and returns `Some(tokens)`; on missing returns `None`.

**Call relations**: Selected by `load_oauth_tokens_from_keyring` for `Secrets` backend. It intentionally ignores any direct-keyring entry unless deletion logic explicitly removes both stores.

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

**Purpose**: Persists OAuth credentials according to the configured storage mode. It is the public write entry point used by login completion and runtime persistence.

**Data flow**: Takes `server_name`, `tokens`, `store_mode`, and backend kind → constructs `DefaultKeyringStore` and dispatches to secure-only, file-only, or secure-with-file-fallback save paths → returns `Result<()>`.

**Call relations**: Called by `OAuthPersistor::persist_if_needed` and by the OAuth login flow after successful authorization. It delegates all backend-specific details to helper functions.

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

**Purpose**: Writes credentials to the configured secure backend without file fallback. It is the secure-storage dispatcher for saves.

**Data flow**: Consumes a `KeyringStore`, backend kind, server name, and token struct → matches backend kind and calls either direct-keyring or secrets-keyring save helper → returns `Result<()>`.

**Call relations**: Used by `save_oauth_tokens` in `Keyring` mode and by the fallback wrapper before deciding whether to write the JSON file.

*Call graph*: calls 2 internal fn (save_oauth_tokens_to_direct_keyring, save_oauth_tokens_to_secrets_keyring); called by 2 (save_oauth_tokens, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `save_oauth_tokens_to_direct_keyring`  (lines 285–309)

```
fn save_oauth_tokens_to_direct_keyring(
    keyring_store: &K,
    server_name: &str,
    tokens: &StoredOAuthTokens,
) -> Result<()>
```

**Purpose**: Serializes and stores credentials directly in the OS keyring, then removes any stale fallback-file copy. On keyring failure it emits a warning and returns a contextualized error.

**Data flow**: Serializes `tokens` to JSON, computes the key from `server_name` and `tokens.url`, and calls `keyring_store.save(KEYRING_SERVICE, &key, &serialized)` → on success attempts `delete_oauth_tokens_from_file(&key)` and ignores cleanup failure except for a warning; on save error builds a human-readable message and returns an `anyhow::Error`.

**Call relations**: Chosen by `save_oauth_tokens_with_keyring` for `Direct` backend. It is the secure write path mirrored by `load_oauth_tokens_from_direct_keyring`.

*Call graph*: calls 2 internal fn (compute_store_key, delete_oauth_tokens_from_file); called by 1 (save_oauth_tokens_with_keyring); 5 external calls (save, new, format!, to_string, warn!).


##### `save_oauth_tokens_to_secrets_keyring`  (lines 311–334)

```
fn save_oauth_tokens_to_secrets_keyring(
    keyring_store: &K,
    server_name: &str,
    tokens: &StoredOAuthTokens,
) -> Result<()>
```

**Purpose**: Stores credentials in encrypted local secrets storage and removes any fallback-file copy. It uses the same deterministic secret naming scheme as the secrets loader.

**Data flow**: Serializes `tokens`, finds `CODEX_HOME`, constructs a `SecretsManager` in `LocalSecretsNamespace::McpOAuth`, computes the secret name from `server_name` and `tokens.url`, and writes the serialized payload with `manager.set(Global, secret_name, serialized)` → then computes the file key and tries to delete the fallback file entry, warning on cleanup failure → returns `Result<()>`.

**Call relations**: Chosen by `save_oauth_tokens_with_keyring` for `Secrets` backend. It is the encrypted-storage counterpart to direct keyring save.

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

**Purpose**: Attempts secure persistence first and falls back to the JSON file if secure storage fails. It preserves the secure-storage failure message as context on fallback errors.

**Data flow**: Calls `save_oauth_tokens_with_keyring(...)` → on success returns `Ok(())`; on error logs a warning with the message and calls `save_oauth_tokens_to_file(tokens)` with added context mentioning the keyring failure → returns `Result<()>`.

**Call relations**: Used by `save_oauth_tokens` in `Auto` mode. It is the write-side analogue of `load_oauth_tokens_from_keyring_with_fallback_to_file`.

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

**Purpose**: Deletes persisted credentials from all relevant storage locations according to the configured mode and backend. It is the public deletion entry point.

**Data flow**: Takes server identity, URL, store mode, and backend kind → constructs `DefaultKeyringStore` and forwards to `delete_oauth_tokens_from_keyring_and_file` → returns `Result<bool>` indicating whether anything was removed.

**Call relations**: Called by `OAuthPersistor::persist_if_needed` when credentials disappear from the live authorization manager.

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

**Purpose**: Removes credentials from secure storage and the fallback file, with mode-sensitive error handling. In `Auto` and `Keyring` modes, keyring deletion errors abort the operation; in `File` mode they are tolerated.

**Data flow**: Computes the deterministic file key, attempts secure deletion via `delete_oauth_tokens_from_keyring`, logs and conditionally propagates keyring errors based on `store_mode`, then deletes the fallback-file entry with `delete_oauth_tokens_from_file(&key)` → returns whether either location removed data.

**Call relations**: Used by the public delete function and extensively tested for mixed-storage scenarios. It coordinates cleanup across all persistence backends.

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

**Purpose**: Deletes credentials from the configured secure backend. For the `Secrets` backend it also removes any legacy direct-keyring entry.

**Data flow**: Matches `AuthKeyringBackendKind` → for `Direct`, deletes only the direct keyring entry; for `Secrets`, deletes both direct-keyring and encrypted-secrets entries and ORs their removal flags → returns `Result<bool>`.

**Call relations**: Called by `delete_oauth_tokens_from_keyring_and_file`. The dual-delete behavior for `Secrets` prevents stale direct-keyring leftovers.

*Call graph*: calls 2 internal fn (delete_oauth_tokens_from_direct_keyring, delete_oauth_tokens_from_secrets_keyring); called by 1 (delete_oauth_tokens_from_keyring_and_file).


##### `delete_oauth_tokens_from_direct_keyring`  (lines 417–426)

```
fn delete_oauth_tokens_from_direct_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<bool>
```

**Purpose**: Deletes the direct keyring entry for a server/url pair. It is the low-level direct-backend removal primitive.

**Data flow**: Computes the key with `compute_store_key` → calls `keyring_store.delete(KEYRING_SERVICE, &key)` → maps backend errors into `anyhow::Error` and returns `Result<bool>`.

**Call relations**: Used by `delete_oauth_tokens_from_keyring` for both direct-only deletion and the direct-cleanup portion of secrets deletion.

*Call graph*: calls 1 internal fn (compute_store_key); called by 1 (delete_oauth_tokens_from_keyring); 1 external calls (delete).


##### `delete_oauth_tokens_from_secrets_keyring`  (lines 428–445)

```
fn delete_oauth_tokens_from_secrets_keyring(
    keyring_store: &K,
    server_name: &str,
    url: &str,
) -> Result<bool>
```

**Purpose**: Deletes the encrypted secrets-store entry for a server/url pair. It uses the same namespace and secret naming as the secrets save/load paths.

**Data flow**: Finds `CODEX_HOME`, constructs `SecretsManager` in `LocalSecretsNamespace::McpOAuth`, computes the `SecretName`, and calls `manager.delete(Global, secret_name)` → returns whether the secret existed and was removed.

**Call relations**: Used by `delete_oauth_tokens_from_keyring` when the backend kind is `Secrets`.

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

**Purpose**: Creates the runtime object that synchronizes live OAuth credentials from rmcp's authorization manager into persistent storage. It captures server identity, storage policy, and the last persisted snapshot.

**Data flow**: Takes owned `server_name`, `url`, an `Arc<Mutex<AuthorizationManager>>`, storage mode, backend kind, and optional initial credentials → stores them inside `OAuthPersistorInner` wrapped in `Arc`, with `last_credentials` initialized inside an async `Mutex` → returns `OAuthPersistor`.

**Call relations**: Constructed by `create_oauth_transport_and_runtime` during HTTP client setup. Its methods are later called around requests to refresh and persist tokens.

*Call graph*: called by 1 (create_oauth_transport_and_runtime); 2 external calls (new, new).


##### `OAuthPersistor::persist_if_needed`  (lines 488–544)

```
async fn persist_if_needed(&self) -> Result<()>
```

**Purpose**: Reads the current credentials from the live authorization manager and writes them to storage only if they changed, or deletes storage if credentials vanished. It also preserves the previous expiry timestamp when the token body is unchanged.

**Data flow**: Locks `authorization_manager`, awaits `get_credentials()`, yielding `(client_id, maybe_credentials)` → if credentials exist, wraps them, compares against `last_credentials`, computes or reuses `expires_at`, builds a new `StoredOAuthTokens`, and if different calls `save_oauth_tokens(...)` then updates `last_credentials`; if credentials are absent, clears `last_credentials` and attempts `delete_oauth_tokens(...)`, warning on deletion failure → returns `Result<()>`.

**Call relations**: Called after initialization, after refresh, and after request operations via `RmcpClient` helpers. It is the central bridge from in-memory OAuth state to durable storage.

*Call graph*: calls 3 internal fn (compute_expires_at_millis, delete_oauth_tokens, save_oauth_tokens); called by 1 (refresh_if_needed); 1 external calls (warn!).


##### `OAuthPersistor::refresh_if_needed`  (lines 550–572)

```
async fn refresh_if_needed(&self) -> Result<()>
```

**Purpose**: Refreshes OAuth credentials through the authorization manager when the persisted expiry is near, then persists the refreshed result. It avoids unnecessary refresh calls when the token is still comfortably valid.

**Data flow**: Reads `expires_at` from `last_credentials` under mutex → if `token_needs_refresh(expires_at)` is false, returns immediately; otherwise locks `authorization_manager`, awaits `refresh_token()`, adds server-specific context on failure, then calls `persist_if_needed()` → returns `Result<()>`.

**Call relations**: Invoked by `RmcpClient::refresh_oauth_if_needed` before HTTP operations. It delegates persistence back to `persist_if_needed` after a successful refresh.

*Call graph*: calls 2 internal fn (persist_if_needed, token_needs_refresh).


##### `load_oauth_tokens_from_file`  (lines 594–635)

```
fn load_oauth_tokens_from_file(server_name: &str, url: &str) -> Result<Option<StoredOAuthTokens>>
```

**Purpose**: Loads credentials from the JSON fallback file in `CODEX_HOME`. It reconstructs an `OAuthTokenResponse` from the file's flattened token fields.

**Data flow**: Reads the fallback store with `read_fallback_file()` → computes the target key with `compute_store_key(server_name, url)` → scans entries, recomputing each entry's key from `entry.server_name` and `entry.server_url` until one matches → builds `OAuthTokenResponse` from access token, optional refresh token, and scopes, wraps it in `StoredOAuthTokens`, restores `expires_in`, and returns `Some(stored)`; otherwise returns `None`.

**Call relations**: Used directly in `File` mode and as the fallback path for `Auto` mode. It is the compatibility path when keyring services are unavailable.

*Call graph*: calls 3 internal fn (compute_store_key, read_fallback_file, refresh_expires_in_from_timestamp); called by 2 (load_oauth_tokens, load_oauth_tokens_from_keyring_with_fallback_to_file); 4 external calls (new, new, new, default).


##### `save_oauth_tokens_to_file`  (lines 637–664)

```
fn save_oauth_tokens_to_file(tokens: &StoredOAuthTokens) -> Result<()>
```

**Purpose**: Writes credentials into the JSON fallback file, flattening the token response into a file-friendly schema. It computes `expires_at` if only relative expiry is present.

**Data flow**: Computes the deterministic key from `tokens.server_name` and `tokens.url`, loads the existing store or creates an empty map, extracts access token, optional refresh token, scopes, and `expires_at` from `tokens.token_response`, builds a `FallbackTokenEntry`, inserts it into the map, and writes the whole store with `write_fallback_file` → returns `Result<()>`.

**Call relations**: Called in explicit `File` mode and as the fallback target when secure writes fail in `Auto` mode.

*Call graph*: calls 3 internal fn (compute_store_key, read_fallback_file, write_fallback_file); called by 2 (save_oauth_tokens, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `delete_oauth_tokens_from_file`  (lines 666–679)

```
fn delete_oauth_tokens_from_file(key: &str) -> Result<bool>
```

**Purpose**: Removes one credential entry from the fallback JSON file and rewrites or deletes the file as needed. It is a no-op when the file does not exist.

**Data flow**: Reads the fallback store; if absent returns `false` → removes `key` from the map, and if removal occurred rewrites the store with `write_fallback_file` → returns whether an entry was removed.

**Call relations**: Used during explicit deletion and after successful secure writes to clean up stale fallback copies.

*Call graph*: calls 2 internal fn (read_fallback_file, write_fallback_file); called by 3 (delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_direct_keyring, save_oauth_tokens_to_secrets_keyring).


##### `compute_expires_at_millis`  (lines 681–693)

```
fn compute_expires_at_millis(response: &OAuthTokenResponse) -> Option<u64>
```

**Purpose**: Converts an OAuth response's relative `expires_in` duration into an absolute Unix timestamp in milliseconds. It saturates at `u64::MAX` if the computed value exceeds the storage type.

**Data flow**: Reads `response.expires_in()?`, gets current `SystemTime`, adds the duration, converts the resulting instant to milliseconds since epoch, and clamps to `u64::MAX` if necessary → returns `Option<u64>`.

**Call relations**: Used when persisting fresh credentials in `OAuthPersistor::persist_if_needed` and by tests constructing sample tokens.

*Call graph*: called by 2 (persist_if_needed, finish); 3 external calls (expires_in, now, from).


##### `expires_in_from_timestamp`  (lines 695–706)

```
fn expires_in_from_timestamp(expires_at: u64) -> Option<u64>
```

**Purpose**: Computes remaining whole seconds until an absolute expiry timestamp. Past or present timestamps are treated as expired and return `None`.

**Data flow**: Reads current time in milliseconds, compares it to `expires_at`, and if `expires_at > now_ms` returns `(expires_at - now_ms) / 1000`, else `None`.

**Call relations**: Used only by `refresh_expires_in_from_timestamp` to rebuild runtime expiry metadata from persisted absolute timestamps.

*Call graph*: called by 1 (refresh_expires_in_from_timestamp); 1 external calls (now).


##### `token_needs_refresh`  (lines 708–719)

```
fn token_needs_refresh(expires_at: Option<u64>) -> bool
```

**Purpose**: Determines whether a token should be refreshed now, using a 30-second skew window before actual expiry. Tokens with unknown expiry are treated as not needing refresh.

**Data flow**: Reads optional `expires_at` → if absent returns `false`; otherwise computes current time in milliseconds and checks whether `now + REFRESH_SKEW_MILLIS >= expires_at` → returns `bool`.

**Call relations**: Used by both `oauth_tokens_are_usable` and `OAuthPersistor::refresh_if_needed`, ensuring status checks and runtime refresh decisions share the same skew policy.

*Call graph*: called by 2 (refresh_if_needed, oauth_tokens_are_usable); 1 external calls (now).


##### `compute_store_key`  (lines 721–732)

```
fn compute_store_key(server_name: &str, server_url: &str) -> Result<String>
```

**Purpose**: Builds the deterministic storage key used for direct keyring entries and fallback-file entries. The key combines a readable server name with a short hash of MCP server identity data.

**Data flow**: Constructs a JSON object containing `type: "http"`, the server URL, and empty headers → hashes it via `sha_256_prefix` → formats the final key as `{server_name}|{truncated_hash}` → returns `Result<String>`.

**Call relations**: This key is the common identity primitive for direct keyring, fallback file, and secret-name derivation. Many load/save/delete helpers depend on it.

*Call graph*: calls 1 internal fn (sha_256_prefix); called by 8 (compute_secret_name, delete_oauth_tokens_from_direct_keyring, delete_oauth_tokens_from_keyring_and_file, load_oauth_tokens_from_direct_keyring, load_oauth_tokens_from_file, save_oauth_tokens_to_direct_keyring, save_oauth_tokens_to_file, save_oauth_tokens_to_secrets_keyring); 4 external calls (new, Object, String, format!).


##### `compute_secret_name`  (lines 740–747)

```
fn compute_secret_name(server_name: &str, server_url: &str) -> Result<SecretName>
```

**Purpose**: Transforms the readable store key into a `SecretName` compatible with the restricted alphabet required by the secrets backend. It preserves determinism by hashing the store key again.

**Data flow**: Calls `compute_store_key(server_name, server_url)`, hashes the resulting bytes with SHA-256, formats uppercase hex, prefixes it with `MCP_OAUTH_`, truncates to 32 hex chars, and constructs `SecretName` → returns `Result<SecretName>`.

**Call relations**: Used by the secrets load/save/delete helpers. It exists because the direct store key contains characters like `|` that `SecretName` forbids.

*Call graph*: calls 2 internal fn (compute_store_key, new); called by 3 (delete_oauth_tokens_from_secrets_keyring, load_oauth_tokens_from_secrets_keyring, save_oauth_tokens_to_secrets_keyring); 2 external calls (new, format!).


##### `fallback_file_path`  (lines 749–751)

```
fn fallback_file_path() -> Result<PathBuf>
```

**Purpose**: Computes the path to the JSON fallback credentials file under `CODEX_HOME`. It centralizes the filename and home-directory lookup.

**Data flow**: Calls `find_codex_home()` and appends `.credentials.json` → returns `Result<PathBuf>`.

**Call relations**: Used by both fallback-file read and write helpers.

*Call graph*: called by 2 (read_fallback_file, write_fallback_file); 1 external calls (find_codex_home).


##### `read_fallback_file`  (lines 753–773)

```
fn read_fallback_file() -> Result<Option<FallbackFile>>
```

**Purpose**: Reads and parses the fallback credentials JSON file if it exists. It distinguishes missing-file from malformed-file cases.

**Data flow**: Computes the path with `fallback_file_path()` → reads the file as string; returns `Ok(None)` on `NotFound`, contextualized error on other I/O failures → parses JSON into `FallbackFile` and returns `Ok(Some(store))`, or a contextualized parse error.

**Call relations**: Called by file load/save/delete helpers. It is the single parser for the fallback storage format.

*Call graph*: calls 1 internal fn (fallback_file_path); called by 3 (delete_oauth_tokens_from_file, load_oauth_tokens_from_file, save_oauth_tokens_to_file); 2 external calls (format!, read_to_string).


##### `write_fallback_file`  (lines 775–800)

```
fn write_fallback_file(store: &FallbackFile) -> Result<()>
```

**Purpose**: Writes the fallback credentials map to disk, deleting the file entirely when the store is empty. On Unix it tightens permissions to owner-read/write only.

**Data flow**: Computes the path, and if `store.is_empty()` removes the file if present and returns; otherwise creates parent directories, serializes the map to JSON, writes it to disk, and on Unix sets mode `0o600` → returns `Result<()>`.

**Call relations**: Used by `save_oauth_tokens_to_file` and `delete_oauth_tokens_from_file`. It encapsulates the file lifecycle and permission policy.

*Call graph*: calls 1 internal fn (fallback_file_path); called by 2 (delete_oauth_tokens_from_file, save_oauth_tokens_to_file); 7 external calls (is_empty, from_mode, create_dir_all, remove_file, set_permissions, write, to_string).


##### `sha_256_prefix`  (lines 802–811)

```
fn sha_256_prefix(value: &Value) -> Result<String>
```

**Purpose**: Produces the 16-hex-character lowercase prefix of a SHA-256 hash over a JSON value. It is used to keep storage keys short while still deterministic.

**Data flow**: Serializes the input `serde_json::Value` to a string, hashes the bytes with SHA-256, formats lowercase hex, slices the first 16 characters, and returns them as `String`.

**Call relations**: Used only by `compute_store_key` as the hashed identity component.

*Call graph*: called by 1 (compute_store_key); 3 external calls (new, format!, to_string).


##### `tests::TempCodexHome::new`  (lines 835–849)

```
fn new() -> Self
```

**Purpose**: Creates a temporary `CODEX_HOME` directory for tests and serializes access to the environment variable so tests do not race. It ensures each test gets an isolated filesystem namespace.

**Data flow**: Locks a global `Mutex<()>` from `OnceLock`, creates a temp directory, sets `CODEX_HOME` to that path, and stores both the guard and directory in `TempCodexHome` → returns the fixture.

**Call relations**: Used by nearly every test in this module before exercising file or secrets storage. The lock prevents concurrent mutation of the process environment.

*Call graph*: 3 external calls (new, set_var, tempdir).


##### `tests::TempCodexHome::path`  (lines 851–853)

```
fn path(&self) -> &std::path::Path
```

**Purpose**: Exposes the temporary `CODEX_HOME` path to tests that need to inspect files directly. It is a simple fixture accessor.

**Data flow**: Reads `self._dir` and returns its `Path` reference.

**Call relations**: Used by tests that inspect secrets files or compute keyring account names relative to the temporary home.

*Call graph*: 1 external calls (path).


##### `tests::TempCodexHome::drop`  (lines 857–861)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the `CODEX_HOME` environment variable when the fixture goes out of scope. This prevents leakage between tests.

**Data flow**: Removes the `CODEX_HOME` environment variable and returns unit during drop.

**Call relations**: Runs automatically after tests using `TempCodexHome`; paired with `new` to bracket environment mutation.

*Call graph*: 1 external calls (remove_var).


##### `tests::load_oauth_tokens_reads_from_keyring_when_available`  (lines 865–883)

```
fn load_oauth_tokens_reads_from_keyring_when_available() -> Result<()>
```

**Purpose**: Verifies that direct keyring loading returns stored credentials when the keyring contains a matching entry. It confirms deserialization and expiry restoration work on the secure path.

**Data flow**: Creates temp home and mock keyring, serializes sample tokens into the computed keyring key, calls the direct-keyring loader, and compares the loaded tokens to the expected sample with helper assertions.

**Call relations**: Exercises `load_oauth_tokens_from_keyring` with `Direct` backend and validates the preferred secure read path.

*Call graph*: 7 external calls (default, new, assert_tokens_match_without_expiry, sample_tokens, to_string, compute_store_key, load_oauth_tokens_from_keyring).


##### `tests::load_oauth_tokens_falls_back_when_missing_in_keyring`  (lines 886–903)

```
fn load_oauth_tokens_falls_back_when_missing_in_keyring() -> Result<()>
```

**Purpose**: Checks that `Auto`-style loading falls back to the JSON file when the keyring has no matching entry. It proves absence in secure storage is not treated as an error.

**Data flow**: Creates temp home and empty mock keyring, writes sample tokens to the fallback file, calls the keyring-with-fallback loader, and asserts the loaded tokens match the file contents.

**Call relations**: Exercises `load_oauth_tokens_from_keyring_with_fallback_to_file` on the missing-keyring branch.

*Call graph*: 6 external calls (default, new, assert_tokens_match_without_expiry, sample_tokens, load_oauth_tokens_from_keyring_with_fallback_to_file, save_oauth_tokens_to_file).


##### `tests::load_oauth_tokens_falls_back_when_keyring_errors`  (lines 906–925)

```
fn load_oauth_tokens_falls_back_when_keyring_errors() -> Result<()>
```

**Purpose**: Verifies that keyring read failures trigger a warning and fallback-file loading instead of aborting the read in fallback mode. It covers the error branch distinct from simple absence.

**Data flow**: Configures the mock keyring to error for the computed key, writes sample tokens to the fallback file, invokes the fallback loader, and asserts the file-backed tokens are returned.

**Call relations**: Exercises the `Err(error)` branch of `load_oauth_tokens_from_keyring_with_fallback_to_file`.

*Call graph*: 8 external calls (Invalid, default, new, assert_tokens_match_without_expiry, sample_tokens, compute_store_key, load_oauth_tokens_from_keyring_with_fallback_to_file, save_oauth_tokens_to_file).


##### `tests::save_oauth_tokens_prefers_keyring_when_available`  (lines 928–948)

```
fn save_oauth_tokens_prefers_keyring_when_available() -> Result<()>
```

**Purpose**: Ensures secure storage wins over the fallback file when keyring writes succeed. It also verifies stale fallback data is removed after a successful secure save.

**Data flow**: Seeds the fallback file with sample tokens, saves through the keyring-with-fallback writer, then asserts the fallback file no longer exists and the mock keyring contains the serialized token payload.

**Call relations**: Covers the success path of `save_oauth_tokens_with_keyring_with_fallback_to_file` and cleanup in `save_oauth_tokens_to_direct_keyring`.

*Call graph*: 9 external calls (assert!, assert_eq!, default, new, sample_tokens, compute_store_key, fallback_file_path, save_oauth_tokens_to_file, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `tests::save_oauth_tokens_writes_fallback_when_keyring_fails`  (lines 951–979)

```
fn save_oauth_tokens_writes_fallback_when_keyring_fails() -> Result<()>
```

**Purpose**: Checks that failed keyring writes in fallback mode produce a fallback-file entry instead of losing credentials. It also confirms nothing was written to the keyring.

**Data flow**: Configures the mock keyring to fail on save, invokes the keyring-with-fallback writer, then reads the fallback file and asserts the flattened entry fields match the sample tokens while the keyring remains empty.

**Call relations**: Exercises the error branch of `save_oauth_tokens_with_keyring_with_fallback_to_file`.

*Call graph*: 10 external calls (Invalid, assert!, assert_eq!, default, new, sample_tokens, compute_store_key, fallback_file_path, read_fallback_file, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `tests::save_oauth_tokens_with_secrets_backend_writes_encrypted_storage`  (lines 982–1014)

```
fn save_oauth_tokens_with_secrets_backend_writes_encrypted_storage() -> Result<()>
```

**Purpose**: Verifies that the `Secrets` backend writes credentials into encrypted local secrets storage and removes fallback-file data. It also confirms the direct keyring entry used by the secrets manager remains intact.

**Data flow**: Creates temp home and mock keyring, seeds direct keyring and fallback file, saves via the secrets backend, then reads the secret through `SecretsManager`, checks file presence under `secrets/mcp_oauth.age`, and asserts the fallback file is gone.

**Call relations**: Exercises `save_oauth_tokens_with_keyring_with_fallback_to_file` and `save_oauth_tokens_to_secrets_keyring` for the encrypted-storage path.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); 11 external calls (new, assert!, assert_eq!, default, new, sample_tokens, to_string, compute_secret_name, compute_store_key, save_oauth_tokens_to_file (+1 more)).


##### `tests::load_oauth_tokens_with_secrets_backend_reads_encrypted_storage`  (lines 1017–1039)

```
fn load_oauth_tokens_with_secrets_backend_reads_encrypted_storage() -> Result<()>
```

**Purpose**: Confirms that the `Secrets` backend reads from encrypted storage and reconstructs the token payload correctly. It validates the secure encrypted read path end-to-end.

**Data flow**: Saves sample tokens through the secrets backend, loads them back with the secrets loader, and compares the loaded tokens to the expected sample using helper assertions.

**Call relations**: Exercises `load_oauth_tokens_from_keyring` with `Secrets` backend after a matching encrypted save.

*Call graph*: 6 external calls (default, new, assert_tokens_match_without_expiry, sample_tokens, load_oauth_tokens_from_keyring, save_oauth_tokens_with_keyring).


##### `tests::load_oauth_tokens_with_secrets_backend_ignores_direct_entry`  (lines 1042–1059)

```
fn load_oauth_tokens_with_secrets_backend_ignores_direct_entry() -> Result<()>
```

**Purpose**: Ensures the `Secrets` backend does not accidentally read a direct-keyring entry when no encrypted secret exists. This preserves backend separation.

**Data flow**: Writes serialized tokens only to the direct keyring, then loads with `AuthKeyringBackendKind::Secrets` and asserts the result is `None`.

**Call relations**: Covers the backend-dispatch behavior in `load_oauth_tokens_from_keyring` and confirms secrets reads are not polluted by direct-keyring data.

*Call graph*: 7 external calls (assert!, default, new, sample_tokens, to_string, compute_store_key, load_oauth_tokens_from_keyring).


##### `tests::save_oauth_tokens_with_secrets_backend_falls_back_to_file_when_keyring_fails`  (lines 1062–1083)

```
fn save_oauth_tokens_with_secrets_backend_falls_back_to_file_when_keyring_fails() -> Result<()>
```

**Purpose**: Checks that secrets-backend writes still fall back to the JSON file when the underlying keyring support needed by `SecretsManager` fails. It validates fallback behavior for the encrypted backend too.

**Data flow**: Configures the mock keyring to fail for the secrets manager's keyring account, saves sample tokens through the keyring-with-fallback writer using `Secrets` backend, then reads the fallback file and asserts the computed key is present.

**Call relations**: Exercises the fallback wrapper around `save_oauth_tokens_to_secrets_keyring`.

*Call graph*: 9 external calls (Invalid, assert!, compute_keyring_account, default, new, sample_tokens, compute_store_key, read_fallback_file, save_oauth_tokens_with_keyring_with_fallback_to_file).


##### `tests::delete_oauth_tokens_with_secrets_backend_removes_secrets_and_file`  (lines 1086–1122)

```
fn delete_oauth_tokens_with_secrets_backend_removes_secrets_and_file() -> Result<()>
```

**Purpose**: Verifies that deletion with the `Secrets` backend removes encrypted storage, any direct-keyring entry, and the fallback file. It covers the multi-store cleanup semantics unique to this backend.

**Data flow**: Seeds encrypted storage, direct keyring, and fallback file with the same sample tokens, calls `delete_oauth_tokens_from_keyring_and_file`, then asserts the secret is gone, the keyring entry is gone, and the fallback file no longer exists.

**Call relations**: Exercises `delete_oauth_tokens_from_keyring_and_file` plus the dual-delete behavior in `delete_oauth_tokens_from_keyring` for `Secrets`.

*Call graph*: calls 1 internal fn (new_with_keyring_store_and_namespace); 11 external calls (new, assert!, default, new, sample_tokens, to_string, compute_secret_name, compute_store_key, delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_file (+1 more)).


##### `tests::delete_oauth_tokens_removes_all_storage`  (lines 1125–1145)

```
fn delete_oauth_tokens_removes_all_storage() -> Result<()>
```

**Purpose**: Checks that deletion in the direct backend removes both keyring and fallback-file copies when both exist. It validates the common cleanup path.

**Data flow**: Seeds direct keyring and fallback file, calls `delete_oauth_tokens_from_keyring_and_file`, and asserts the keyring no longer contains the entry and the fallback file is absent.

**Call relations**: Exercises the normal direct-backend deletion path.

*Call graph*: 8 external calls (assert!, default, new, sample_tokens, to_string, compute_store_key, delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_file).


##### `tests::delete_oauth_tokens_file_mode_removes_keyring_only_entry`  (lines 1148–1168)

```
fn delete_oauth_tokens_file_mode_removes_keyring_only_entry() -> Result<()>
```

**Purpose**: Confirms that deletion still removes a keyring-only entry when operating in the combined deletion helper. It ensures stale secure entries are not left behind.

**Data flow**: Seeds only the direct keyring, calls `delete_oauth_tokens_from_keyring_and_file`, and asserts the keyring entry is removed and no fallback file exists.

**Call relations**: Covers deletion behavior when only secure storage contains data.

*Call graph*: 7 external calls (assert!, default, new, sample_tokens, to_string, compute_store_key, delete_oauth_tokens_from_keyring_and_file).


##### `tests::delete_oauth_tokens_propagates_keyring_errors`  (lines 1171–1189)

```
fn delete_oauth_tokens_propagates_keyring_errors() -> Result<()>
```

**Purpose**: Verifies that keyring deletion failures are surfaced as errors in modes that require secure deletion, and that fallback-file data is left untouched in that case. This protects against partial silent cleanup.

**Data flow**: Configures the mock keyring to fail on delete, writes sample tokens to the fallback file, calls `delete_oauth_tokens_from_keyring_and_file`, and asserts the result is an error while the fallback file still exists.

**Call relations**: Exercises the error-propagation branch in `delete_oauth_tokens_from_keyring_and_file`.

*Call graph*: 8 external calls (Invalid, assert!, default, new, sample_tokens, compute_store_key, delete_oauth_tokens_from_keyring_and_file, save_oauth_tokens_to_file).


##### `tests::refresh_expires_in_from_timestamp_restores_future_durations`  (lines 1192–1209)

```
fn refresh_expires_in_from_timestamp_restores_future_durations()
```

**Purpose**: Checks that a future `expires_at` timestamp can reconstruct a plausible `expires_in` duration after deserialization. It allows small drift due to elapsed wall-clock time.

**Data flow**: Builds sample tokens, clears `expires_in`, calls `refresh_expires_in_from_timestamp`, then compares the restored duration in seconds to `expires_in_from_timestamp(expires_at)` with a tolerance of one second.

**Call relations**: Directly validates the timestamp-to-duration restoration logic used by all load paths.

*Call graph*: 4 external calls (assert!, sample_tokens, expires_in_from_timestamp, refresh_expires_in_from_timestamp).


##### `tests::refresh_expires_in_from_timestamp_marks_expired_tokens`  (lines 1212–1226)

```
fn refresh_expires_in_from_timestamp_marks_expired_tokens()
```

**Purpose**: Ensures expired timestamps are converted into an explicit zero-duration expiry rather than leaving expiry unknown. This supports eager refresh on startup.

**Data flow**: Creates sample tokens, forces `expires_at` into the past, sets a nonzero `expires_in`, calls `refresh_expires_in_from_timestamp`, and asserts the resulting `expires_in()` is `Duration::ZERO`.

**Call relations**: Covers the expired-token branch in `refresh_expires_in_from_timestamp`.

*Call graph*: 5 external calls (from_secs, now, assert_eq!, sample_tokens, refresh_expires_in_from_timestamp).


##### `tests::oauth_tokens_are_usable_when_expiry_is_unknown`  (lines 1229–1235)

```
fn oauth_tokens_are_usable_when_expiry_is_unknown()
```

**Purpose**: Verifies that tokens with no known expiry are considered usable as long as required fields are present. Unknown expiry does not force refresh-token availability.

**Data flow**: Creates sample tokens, clears `expires_at` and refresh token, calls `oauth_tokens_are_usable`, and asserts it returns true.

**Call relations**: Exercises the `expires_at == None` branch of the usability predicate.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_usable_when_unexpired_without_refresh_token`  (lines 1238–1243)

```
fn oauth_tokens_are_usable_when_unexpired_without_refresh_token()
```

**Purpose**: Checks that an unexpired access token remains usable even without a refresh token. Refresh capability is only required near or past expiry.

**Data flow**: Creates sample tokens, removes the refresh token, calls `oauth_tokens_are_usable`, and asserts true.

**Call relations**: Covers the non-refresh-needed branch of the usability check.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_usable_when_expired_but_refreshable`  (lines 1246–1251)

```
fn oauth_tokens_are_usable_when_expired_but_refreshable()
```

**Purpose**: Verifies that expired tokens are still considered usable if they carry a nonblank refresh token. This matches the runtime's ability to refresh before use.

**Data flow**: Creates sample tokens, sets `expires_at` to zero, calls `oauth_tokens_are_usable`, and asserts true.

**Call relations**: Exercises the refresh-required branch with a valid refresh token.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_expired_and_unrefreshable`  (lines 1254–1260)

```
fn oauth_tokens_are_not_usable_when_expired_and_unrefreshable()
```

**Purpose**: Checks that expired tokens without a refresh token are classified unusable. This is the canonical reauthorization-required case.

**Data flow**: Creates sample tokens, sets `expires_at` to zero, removes the refresh token, calls `oauth_tokens_are_usable`, and asserts false.

**Call relations**: Covers the refresh-required branch with no refresh capability.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_near_expiry_and_unrefreshable`  (lines 1263–1273)

```
fn oauth_tokens_are_not_usable_when_near_expiry_and_unrefreshable()
```

**Purpose**: Verifies that the refresh skew window is honored: tokens expiring within the skew are treated like expired tokens if they cannot refresh. This prevents starting requests with almost-dead access tokens.

**Data flow**: Creates sample tokens, sets `expires_at` to just before `now + REFRESH_SKEW_MILLIS`, removes the refresh token, calls `oauth_tokens_are_usable`, and asserts false.

**Call relations**: Exercises the skew-sensitive behavior shared with `token_needs_refresh`.

*Call graph*: 3 external calls (now, assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_client_id_is_blank`  (lines 1276–1281)

```
fn oauth_tokens_are_not_usable_when_client_id_is_blank()
```

**Purpose**: Ensures blank client ids invalidate stored credentials even if token fields are otherwise present. This protects refresh flows that require a valid client id.

**Data flow**: Creates sample tokens, replaces `client_id` with whitespace, calls `oauth_tokens_are_usable`, and asserts false.

**Call relations**: Covers the early blank-client-id guard in the usability predicate.

*Call graph*: 2 external calls (assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_access_token_is_blank`  (lines 1284–1292)

```
fn oauth_tokens_are_not_usable_when_access_token_is_blank()
```

**Purpose**: Checks that a blank access token makes an otherwise unexpired credential set unusable. This prevents treating malformed persisted data as valid.

**Data flow**: Creates sample tokens, replaces the access token with whitespace, calls `oauth_tokens_are_usable`, and asserts false.

**Call relations**: Exercises the non-refresh-needed branch's access-token validation.

*Call graph*: 3 external calls (new, assert!, sample_tokens).


##### `tests::oauth_tokens_are_not_usable_when_required_refresh_token_is_blank`  (lines 1295–1304)

```
fn oauth_tokens_are_not_usable_when_required_refresh_token_is_blank()
```

**Purpose**: Ensures that when refresh is required, a blank refresh token is treated the same as a missing one. Whitespace-only secrets do not count as usable credentials.

**Data flow**: Creates sample tokens, forces expiry, sets refresh token to whitespace, calls `oauth_tokens_are_usable`, and asserts false.

**Call relations**: Covers refresh-token content validation in the refresh-required branch.

*Call graph*: 3 external calls (new, assert!, sample_tokens).


##### `tests::assert_tokens_match_without_expiry`  (lines 1306–1318)

```
fn assert_tokens_match_without_expiry(
        actual: &StoredOAuthTokens,
        expected: &StoredOAuthTokens,
    )
```

**Purpose**: Compares two `StoredOAuthTokens` values while tolerating runtime drift in exact expiry duration representation. It focuses on persisted identity and token payload fields.

**Data flow**: Reads both token structs, asserts equality of `server_name`, `url`, `client_id`, and `expires_at`, then delegates token-response comparison to `assert_token_response_match_without_expiry`.

**Call relations**: Used by multiple tests that load tokens from storage and need a stable comparison helper.

*Call graph*: 2 external calls (assert_eq!, assert_token_response_match_without_expiry).


##### `tests::assert_token_response_match_without_expiry`  (lines 1320–1345)

```
fn assert_token_response_match_without_expiry(
        actual: &WrappedOAuthTokenResponse,
        expected: &WrappedOAuthTokenResponse,
    )
```

**Purpose**: Compares two wrapped OAuth responses field-by-field except for exact expiry duration values. It checks token secret, token type, refresh token, scopes, extra fields, and whether expiry is present.

**Data flow**: Reads both `WrappedOAuthTokenResponse.0` values and asserts equality across selected fields, comparing only `expires_in().is_some()` rather than exact duration.

**Call relations**: Called by `assert_tokens_match_without_expiry` to support storage round-trip tests.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::sample_tokens`  (lines 1347–1369)

```
fn sample_tokens() -> StoredOAuthTokens
```

**Purpose**: Builds a representative `StoredOAuthTokens` fixture with access token, refresh token, scopes, and one-hour expiry. It is the canonical test input for this module.

**Data flow**: Constructs an `OAuthTokenResponse`, sets refresh token, scopes, and `expires_in`, computes `expires_at` with `compute_expires_at_millis`, and packages everything into `StoredOAuthTokens` → returns the fixture.

**Call relations**: Used throughout the test module as the baseline credential set for load/save/delete and usability tests.

*Call graph*: 7 external calls (new, from_secs, new, new, default, compute_expires_at_millis, vec!).
