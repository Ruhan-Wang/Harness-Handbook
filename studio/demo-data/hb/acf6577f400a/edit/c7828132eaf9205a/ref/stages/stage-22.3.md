# Configuration, metadata, schema, auth, and network glue utilities  `stage-22.3`

This stage is shared backstage support. It is not one single feature. Instead, it supplies the small but important adapters, checks, and translators that help startup, normal app work, and network calls behave consistently.

Several files shape configuration. They rename old config keys to new ones, apply command-line overrides like key=value, wrap settings with validation rules, and produce human-readable labels saying where a setting came from. Related CLI helpers turn user-friendly flags such as approval or sandbox modes into the internal forms the program uses.

Another group prepares metadata and schemas: connector labels and install links, plugin mention symbols, duplicate skill-name counts, plugin toggle extraction, JSON-to-TOML conversion, and compact JSON Schema descriptions for memory tools.

Authentication and request glue live here too. PKCE creates the secure verifier/challenge pair for OAuth login, auth utilities pull readable server error messages, API-key reading protects secret bytes in memory, and header helpers turn optional tracing metadata into real HTTP headers.

Finally, network and URL helpers normalize backend URLs and hosts, decide which ChatGPT hosts are trusted, classify private or loopback addresses, validate proxy policy and config, and compare versions or npm release metadata so update-related features can trust what they see.

## Files in this stage

### API and auth request glue
These helpers shape outbound request metadata, normalize service URLs, and support lightweight authentication flows reused by clients and proxies.

### `cloud-tasks/src/util.rs`

`util` · `cross-cutting`

This file collects operational helpers that sit between application logic and external libraries. `set_user_agent_suffix` mutates the shared `codex_login::default_client::USER_AGENT_SUFFIX` mutex so cloud-tasks requests identify themselves consistently. `append_error_log` appends timestamped lines to a local `error.log`, intentionally swallowing file-open and write failures so logging never crashes the app.

Backend URL handling is centralized in `normalize_base_url`, which strips trailing slashes and rewrites ChatGPT-style roots to include `/backend-api` when missing. `task_url` then derives a browser-facing task page URL from several possible backend URL shapes, handling `/backend-api`, `/api/codex`, and `/codex` suffixes explicitly before falling back to `/codex/tasks/{id}`.

Authentication setup is asynchronous. `load_auth_manager` loads the standard Codex config with no CLI overrides and constructs an `AuthManager` using config-derived home directory, credential-store mode, optional base URL override, and keyring backend. `build_chatgpt_headers` uses that manager to assemble a `reqwest::HeaderMap` containing a `User-Agent` and, when the resolved auth uses the Codex backend, authorization headers from `codex_model_provider`.

The remaining helpers format timestamps for UI display. `format_relative_time` clamps future times to zero elapsed seconds, emits compact `s/m/h ago` strings for recent timestamps, and falls back to local `%b %e %H:%M` formatting for older entries; `format_relative_time_now` simply supplies `Utc::now()` as the reference.

#### Function details

##### `set_user_agent_suffix`  (lines 9–13)

```
fn set_user_agent_suffix(suffix: &str)
```

**Purpose**: Sets the process-wide user-agent suffix used by the shared Codex login client. It quietly does nothing if the mutex cannot be locked.

**Data flow**: Takes `suffix: &str`, attempts to lock `codex_login::default_client::USER_AGENT_SUFFIX`, and if successful replaces the stored optional suffix with `Some(suffix.to_string())`. It returns no value.

**Call relations**: Called during backend initialization and ChatGPT header construction so outgoing requests identify the cloud-tasks client variant before HTTP calls are made.

*Call graph*: called by 2 (init_backend, build_chatgpt_headers).


##### `append_error_log`  (lines 15–25)

```
fn append_error_log(message: impl AsRef<str>)
```

**Purpose**: Appends a timestamped diagnostic line to `error.log` in the current working directory. It is intentionally best-effort and suppresses all I/O failures.

**Data flow**: Accepts any `message` implementing `AsRef<str>`, gets the current UTC timestamp as RFC3339, opens `error.log` in create+append mode, and if successful writes a line of the form `[timestamp] message`. It returns no value and ignores open/write errors.

**Call relations**: Used by startup and main-run paths to persist unexpected failures without interrupting control flow. It delegates timestamp generation to `Utc::now()` and file output to standard library I/O.

*Call graph*: called by 2 (init_backend, run_main); 3 external calls (now, new, writeln!).


##### `normalize_base_url`  (lines 30–42)

```
fn normalize_base_url(input: &str) -> String
```

**Purpose**: Canonicalizes a configured backend base URL into the form expected by the backend client. It removes trailing slashes and patches ChatGPT host roots to include `/backend-api` when absent.

**Data flow**: Takes `input: &str`, copies it into a mutable `String`, repeatedly pops trailing `/`, then checks for `https://chatgpt.com` or `https://chat.openai.com` prefixes and appends `/backend-api` if that segment is not already present. Returns the normalized string.

**Call relations**: Called wherever backend URLs need stable interpretation, including environment resolution, main startup logic, and browser task URL generation via `task_url`.

*Call graph*: called by 3 (resolve_environment_id, run_main, task_url); 1 external calls (format!).


##### `load_auth_manager`  (lines 44–57)

```
async fn load_auth_manager(chatgpt_base_url: Option<String>) -> Option<AuthManager>
```

**Purpose**: Loads Codex configuration and constructs an `AuthManager` suitable for ChatGPT-backed requests. It returns `None` if configuration loading fails.

**Data flow**: Accepts an optional `chatgpt_base_url`, asynchronously calls `Config::load_with_cli_overrides(Vec::new())`, and on success passes config-derived paths and auth settings into `AuthManager::new`, using the explicit base URL when provided or the config’s `chatgpt_base_url` otherwise. It returns `Some(AuthManager)` after awaiting construction, or `None` on config-load failure.

**Call relations**: Used by backend initialization and `build_chatgpt_headers` when authenticated request headers may be needed. It encapsulates the exact config-to-auth-manager wiring so callers do not duplicate it.

*Call graph*: calls 1 internal fn (new); called by 2 (init_backend, build_chatgpt_headers); 2 external calls (new, load_with_cli_overrides).


##### `build_chatgpt_headers`  (lines 61–79)

```
async fn build_chatgpt_headers() -> HeaderMap
```

**Purpose**: Builds the HTTP headers needed for ChatGPT-backed requests, always including `User-Agent` and conditionally including auth headers when Codex-backed auth is available. It standardizes request identity and authentication in one async helper.

**Data flow**: Sets the user-agent suffix to `codex_cloud_tasks_tui`, obtains the full user-agent string, inserts it into a new `HeaderMap` with a fallback static value if parsing fails, then awaits `load_auth_manager(None)`. If an auth manager exists, yields auth, and that auth reports `uses_codex_backend()`, it extends the header map with headers from `codex_model_provider::auth_provider_from_auth(&auth).to_auth_headers()`. It returns the populated `HeaderMap`.

**Call relations**: Called by environment-resolution and main-run code before making ChatGPT-backed HTTP requests. It depends on `set_user_agent_suffix` and `load_auth_manager` to prepare both identity and authorization.

*Call graph*: calls 3 internal fn (load_auth_manager, set_user_agent_suffix, get_codex_user_agent); called by 2 (resolve_environment_id, run_main); 4 external calls (new, from_static, from_str, auth_provider_from_auth).


##### `task_url`  (lines 82–94)

```
fn task_url(base_url: &str, task_id: &str) -> String
```

**Purpose**: Converts a backend base URL plus task ID into a browser-friendly task page URL. It understands several backend path conventions and rewrites them to the corresponding `/codex/tasks/{id}` route.

**Data flow**: Takes `base_url` and `task_id`, normalizes the base URL, then checks suffixes in order: `/backend-api`, `/api/codex`, and `/codex`. Depending on the match, it formats the appropriate browser URL; if none match, it appends `/codex/tasks/{task_id}` to the normalized base. Returns the resulting `String`.

**Call relations**: Used when formatting task listings and executing commands that need a human-facing task link. It delegates canonicalization to `normalize_base_url` before applying suffix-specific rewrites.

*Call graph*: calls 1 internal fn (normalize_base_url); called by 2 (format_task_list_lines, run_exec_command); 1 external calls (format!).


##### `format_relative_time`  (lines 96–114)

```
fn format_relative_time(reference: DateTime<Utc>, ts: DateTime<Utc>) -> String
```

**Purpose**: Formats a UTC timestamp relative to a supplied UTC reference time using compact recent-time strings and a local-time fallback for older entries. It also guards against future timestamps by treating them as zero elapsed time.

**Data flow**: Takes `reference` and `ts`, computes elapsed seconds as `(reference - ts).num_seconds()`, clamps negatives to zero, and returns `"{secs}s ago"`, `"{mins}m ago"`, or `"{hours}h ago"` for intervals under 60 seconds, 60 minutes, or 24 hours respectively. For older timestamps it converts `ts` to `Local` and formats it as `%b %e %H:%M`.

**Call relations**: Called by status/list formatting code and by `format_relative_time_now`, which supplies the current time automatically.

*Call graph*: called by 2 (format_task_status_lines, format_relative_time_now); 2 external calls (with_timezone, format!).


##### `format_relative_time_now`  (lines 116–118)

```
fn format_relative_time_now(ts: DateTime<Utc>) -> String
```

**Purpose**: Convenience wrapper that formats a timestamp relative to the current UTC time. It keeps callers from having to fetch `Utc::now()` themselves.

**Data flow**: Takes `ts: DateTime<Utc>`, obtains `Utc::now()`, forwards both values to `format_relative_time`, and returns the resulting string.

**Call relations**: Used by UI task-row rendering so each task item can show a relative update time with one call.

*Call graph*: calls 1 internal fn (format_relative_time); called by 1 (render_task_item); 1 external calls (now).


### `codex-api/src/requests/headers.rs`

`util` · `request assembly`

This file contains narrowly scoped header-construction utilities used by request-building code. `build_session_headers` creates a fresh `http::HeaderMap` and conditionally inserts `session-id` and `thread-id` when the caller supplies those identifiers. It consumes the optional `String`s rather than borrowing them, which fits the common pattern of assembling request options into a one-off header map.

`subagent_header` translates `codex_protocol::protocol::SessionSource` into the string expected by the backend's `x-openai-subagent`-style header. It only returns a value for `SessionSource::SubAgent`; all other session sources are ignored. The mapping is explicit and stable: `Review` becomes `review`, `Compact` becomes `compact`, `MemoryConsolidation` becomes `memory_consolidation`, `ThreadSpawn { .. }` becomes `collab_spawn`, and `Other(label)` preserves the caller-provided label.

The low-level `insert_header` helper is intentionally forgiving. It parses the header name into `http::HeaderName` and the value into `HeaderValue`, but if either parse fails it simply does nothing instead of returning an error. That design keeps higher-level request assembly simple and avoids failing an entire request because optional metadata contained an invalid header token.

#### Function details

##### `build_session_headers`  (lines 5–14)

```
fn build_session_headers(session_id: Option<String>, thread_id: Option<String>) -> HeaderMap
```

**Purpose**: Builds a header map containing optional session and thread identifiers. It only inserts headers for values that are present.

**Data flow**: Creates a new `HeaderMap`, consumes `session_id` and `thread_id`, and for each `Some(id)` calls `insert_header` with `session-id` or `thread-id`. It returns the populated map.

**Call relations**: Request-building code calls this from `stream_request` when assembling metadata headers for a Responses stream request. It delegates actual parsing/insertion safety to `insert_header`.

*Call graph*: calls 1 internal fn (insert_header); called by 1 (stream_request); 1 external calls (new).


##### `subagent_header`  (lines 16–31)

```
fn subagent_header(source: &Option<SessionSource>) -> Option<String>
```

**Purpose**: Maps a `SessionSource` into the backend's subagent label string when the source represents a subagent. Non-subagent sources produce no header value.

**Data flow**: Reads the borrowed `Option<SessionSource>`, pattern-matches `SessionSource::SubAgent(sub)`, and converts each `SubAgentSource` variant into a specific owned `String`. If the option is `None` or not a subagent, it returns `None`.

**Call relations**: This helper is consulted by `stream_request` to decide whether to emit a subagent-identifying header alongside session metadata.

*Call graph*: called by 1 (stream_request).


##### `insert_header`  (lines 33–40)

```
fn insert_header(headers: &mut HeaderMap, name: &str, value: &str)
```

**Purpose**: Safely inserts a header into a mutable `HeaderMap` only when both the name and value are syntactically valid. Invalid inputs are ignored rather than surfaced as errors.

**Data flow**: Takes mutable access to `headers` plus raw `name` and `value` strings, parses the name as `http::HeaderName` and the value as `HeaderValue`, and if both succeed inserts them into the map. It returns unit and mutates the provided map in place.

**Call relations**: This is the common insertion primitive used by `build_session_headers` and by higher-level request assembly in `stream_request`.

*Call graph*: called by 2 (stream_request, build_session_headers); 2 external calls (insert, from_str).


### `codex-client/src/chatgpt_hosts.rs`

`util` · `cross-cutting host validation during ChatGPT-specific request handling`

This small utility module centralizes host matching for ChatGPT-specific behavior. `is_allowed_chatgpt_host` accepts a raw host string and checks it against two static policies: exact matches for `chatgpt.com`, `chat.openai.com`, and `chatgpt-staging.com`, plus suffix matches for subdomains under `.chatgpt.com` and `.chatgpt-staging.com`. The split is intentional: `chat.openai.com` is allowed only as an exact host, so `foo.chat.openai.com` does not accidentally inherit first-party treatment.

The implementation avoids common suffix-trick bugs by using exact host equality for base domains and requiring a leading dot in suffix entries. That means `evilchatgpt.com` and `chatgpt.com.evil.example` are rejected even though they contain the trusted domain text. The module has no state and no transport code; it exists so higher-level components such as the Cloudflare cookie store can share one precise definition of which hosts are eligible for special handling. The accompanying test enumerates both accepted and rejected examples to document the intended boundary.

#### Function details

##### `is_allowed_chatgpt_host`  (lines 3–11)

```
fn is_allowed_chatgpt_host(host: &str) -> bool
```

**Purpose**: Returns whether a host string belongs to the approved ChatGPT host set or one of the explicitly allowed subdomain families.

**Data flow**: It takes `&str` host input, compares it against the `EXACT_HOSTS` slice, and if no exact match is found iterates `SUBDOMAIN_SUFFIXES` to see whether the host ends with one of those dotted suffixes. It returns a boolean and does not read or mutate external state.

**Call relations**: This predicate is called by `is_chatgpt_cookie_url` in the cookie-store module to decide whether ChatGPT-specific cookie behavior may apply to a URL.

*Call graph*: called by 1 (is_chatgpt_cookie_url).


##### `tests::recognizes_chatgpt_hosts_without_suffix_tricks`  (lines 18–38)

```
fn recognizes_chatgpt_hosts_without_suffix_tricks()
```

**Purpose**: Verifies that the host predicate accepts intended ChatGPT hosts and rejects lookalikes or over-broad subdomains.

**Data flow**: The test loops over known-good host strings and asserts `is_allowed_chatgpt_host` is true, then loops over deceptive or disallowed hosts and asserts it is false.

**Call relations**: This test documents and locks down the matching policy that downstream modules rely on for security-sensitive host gating.

*Call graph*: 1 external calls (assert!).


### `login/src/auth/util.rs`

`util` · `cross-cutting`

This utility file contains one production helper, `try_parse_error_message`, plus focused tests. The function is intentionally forgiving: it logs the raw response body at debug level, attempts to parse it as `serde_json::Value`, and then looks specifically for the nested shape `{ "error": { "message": ... } }`, which matches common OAuth/OpenAI error responses. If that nested string exists, it returns just the message text.

If parsing fails or the expected nested fields are absent, the function does not treat that as an error. Instead it falls back to returning `"Unknown error"` for an empty body or the original raw response text for any non-empty body. That design preserves backend detail for user-facing errors without forcing every caller to duplicate JSON probing logic. The helper is used by token-refresh and token-revocation code paths, where HTTP failures often include either structured JSON or plain-text diagnostics.

The tests document both branches: successful extraction from an OpenAI-style nested error object and fallback to the untouched raw text when the payload has a different JSON shape.

#### Function details

##### `try_parse_error_message`  (lines 3–16)

```
fn try_parse_error_message(text: &str) -> String
```

**Purpose**: Extracts a human-readable message from a server error body, preferring nested `error.message` JSON fields when present.

**Data flow**: Accepts a response body `&str`, logs it with `debug!`, parses it into `serde_json::Value` with `unwrap_or_default()`, and checks for `json["error"]["message"]` as a string. If found, it returns that string. If the input text is empty, it returns `"Unknown error"`; otherwise it returns the original text unchanged.

**Call relations**: Called by auth flows that need to surface backend error detail, notably token refresh and token revocation. It centralizes tolerant parsing so those callers can format better `io::Error` messages without embedding JSON traversal logic.

*Call graph*: called by 4 (request_chatgpt_token_refresh, revoke_oauth_token, try_parse_error_message_extracts_openai_error_message, try_parse_error_message_falls_back_to_raw_text); 1 external calls (debug!).


##### `tests::try_parse_error_message_extracts_openai_error_message`  (lines 23–37)

```
fn try_parse_error_message_extracts_openai_error_message()
```

**Purpose**: Verifies that the helper extracts the nested OpenAI-style error message instead of returning the whole JSON blob.

**Data flow**: Supplies a multiline JSON string containing `error.message`, calls `try_parse_error_message`, and asserts the returned string equals the nested message text.

**Call relations**: This test documents the preferred structured parsing behavior relied on by callers formatting user-visible auth errors.

*Call graph*: calls 1 internal fn (try_parse_error_message); 1 external calls (assert_eq!).


##### `tests::try_parse_error_message_falls_back_to_raw_text`  (lines 40–44)

```
fn try_parse_error_message_falls_back_to_raw_text()
```

**Purpose**: Verifies that unsupported JSON shapes are returned verbatim rather than producing an empty or generic message.

**Data flow**: Passes a JSON string with only a top-level `message` field to `try_parse_error_message` and asserts the exact original text is returned.

**Call relations**: This test covers the fallback branch, showing that the helper is intentionally conservative about which JSON structures it interprets.

*Call graph*: calls 1 internal fn (try_parse_error_message); 1 external calls (assert_eq!).


### `login/src/pkce.rs`

`util` · `interactive login startup`

This small utility module defines `PkceCodes`, the pair of strings needed for OAuth PKCE: `code_verifier` and `code_challenge`. The sole function, `generate_pkce`, creates 64 random bytes using the thread-local RNG, base64url-encodes them without padding to produce a verifier in the allowed PKCE length range, then computes the SHA-256 digest of that verifier string and base64url-encodes the digest without padding to produce the S256 challenge.

The implementation follows the standard PKCE convention exactly: the challenge is derived from the verifier string bytes, not directly from the original random bytes. Returning both values together in a dedicated struct keeps callers from accidentally mismatching them. In this crate, the generated pair is used by the localhost login server flow when constructing the authorize URL and later exchanging the authorization code for tokens.

#### Function details

##### `generate_pkce`  (lines 12–27)

```
fn generate_pkce() -> PkceCodes
```

**Purpose**: Creates a fresh PKCE verifier/challenge pair suitable for OAuth S256 authorization-code exchange.

**Data flow**: Allocates a 64-byte array, fills it with random bytes via `rand::rng().fill_bytes`, base64url-encodes those bytes without padding into `code_verifier`, computes `Sha256::digest(code_verifier.as_bytes())`, base64url-encodes that digest without padding into `code_challenge`, and returns `PkceCodes { code_verifier, code_challenge }`.

**Call relations**: Called by `run_login_server` before the browser auth URL is built, supplying the PKCE material later reused during token exchange.

*Call graph*: called by 1 (run_login_server); 2 external calls (digest, rng).


### `ollama/src/url.rs`

`util` · `client construction and URL normalization`

This utility module encapsulates the string-level URL rules used by `OllamaClient` construction. The first helper, `is_openai_compatible_base_url`, answers whether a provider `base_url` should be treated as an OpenAI-compatible root by trimming trailing slashes and checking for a final `/v1` path segment. The second helper, `base_url_to_host_root`, converts either form into the native Ollama host root expected by the rest of the client code: it trims trailing slashes, removes a terminal `/v1` if present, trims any slash left behind by that removal, and returns the normalized `String`.

These helpers deliberately avoid full URL parsing and instead rely on simple suffix manipulation because the only distinction the client needs is whether the configured base URL ends at `/v1`. That normalization is important because the client probes `/v1/models` when operating in compatibility mode but still uses native endpoints like `/api/tags`, `/api/version`, and `/api/pull` against the host root. The included test covers the common cases of a `/v1` URL, a plain host root, and a host root with a trailing slash, documenting the exact normalization behavior.

#### Function details

##### `is_openai_compatible_base_url`  (lines 2–4)

```
fn is_openai_compatible_base_url(base_url: &str) -> bool
```

**Purpose**: Determines whether a configured base URL points at an OpenAI-compatible Ollama API root. The check is purely suffix-based.

**Data flow**: Takes `base_url: &str`, trims trailing `/` characters, tests whether the result ends with `"/v1"`, and returns that boolean.

**Call relations**: It is called by `OllamaClient::try_from_provider` to decide which probe endpoint to use and whether the configured URL needs host-root normalization.

*Call graph*: called by 1 (try_from_provider).


##### `base_url_to_host_root`  (lines 8–18)

```
fn base_url_to_host_root(base_url: &str) -> String
```

**Purpose**: Normalizes a provider base URL into the native Ollama host root by removing trailing slashes and an optional terminal `/v1`. This gives the client a stable base for native API paths.

**Data flow**: Consumes `base_url: &str`, computes `trimmed = base_url.trim_end_matches('/')`, and if `trimmed` ends with `"/v1"` returns `trimmed.trim_end_matches("/v1").trim_end_matches('/').to_string()`. Otherwise it returns `trimmed.to_string()`.

**Call relations**: It is used by `OllamaClient::try_from_provider` alongside `is_openai_compatible_base_url`. The two helpers together derive the client's `host_root` and compatibility mode.

*Call graph*: called by 1 (try_from_provider).


##### `tests::test_base_url_to_host_root`  (lines 25–38)

```
fn test_base_url_to_host_root()
```

**Purpose**: Verifies that host-root normalization removes `/v1` and trailing slashes but leaves an already normalized root unchanged. This documents the exact string transformations expected by the client.

**Data flow**: Calls `base_url_to_host_root` with three representative inputs and asserts each returned string equals the expected normalized host root.

**Call relations**: This test directly exercises the normalization helper in isolation from the client constructor that consumes it.

*Call graph*: 1 external calls (assert_eq!).


### `responses-api-proxy/src/read_api_key.rs`

`util` · `startup secret ingestion`

This file is a security-focused helper for obtaining the upstream Authorization header. The public entrypoint `read_auth_header_from_stdin` is platform-specific: on Unix it delegates to a low-level `read(2)` wrapper, while on Windows it currently falls back to `std::io::stdin().read`. The central logic lives in `read_auth_header_with`, which is carefully written to avoid extra allocations and lingering secret copies.

It allocates a fixed 1024-byte stack buffer, writes the literal prefix `Bearer ` into the front, and then repeatedly fills the remaining token region using the supplied read function. It tracks total bytes read, whether a newline was seen, and whether EOF occurred. Reading stops on newline, EOF, or buffer exhaustion; filling the buffer without newline/EOF is treated as an error. After reading, trailing `\n` and `\r` are trimmed, empty input is rejected with a usage-oriented error, and the token bytes are validated to contain only ASCII alphanumerics, `-`, or `_`.

If validation passes, the prefix-plus-token slice is interpreted as UTF-8, copied once into a `String`, and the stack buffer is immediately zeroized. The string is then leaked to obtain `&'static mut str`, and `mlock_str` is called so the backing pages are pinned in memory on Unix. `mlock_str` computes page-aligned bounds carefully with overflow checks and silently returns on any unsupported or degenerate condition. The tests cover short reads, newline trimming, empty input, oversized keys, I/O propagation, and invalid byte handling.

#### Function details

##### `read_auth_header_from_stdin`  (lines 21–30)

```
fn read_auth_header_from_stdin() -> Result<&'static str>
```

**Purpose**: Platform-specific public entrypoint that reads stdin and returns a leaked static `Bearer ...` header string. It hides the low-level read strategy behind a single API.

**Data flow**: Takes no arguments. On Unix it calls `read_auth_header_with(read_from_unix_stdin)`; on Windows it passes a closure that reads from `std::io::stdin()` into the provided buffer. It returns `Result<&'static str>`.

**Call relations**: Called during proxy startup from `run_main`. It delegates all parsing, validation, zeroization, and memory locking to `read_auth_header_with`.

*Call graph*: calls 1 internal fn (read_auth_header_with); called by 1 (run_main).


##### `read_from_unix_stdin`  (lines 41–70)

```
fn read_from_unix_stdin(buffer: &mut [u8]) -> std::io::Result<usize>
```

**Purpose**: Performs a single low-level `read(2)` into a caller-provided buffer, retrying on EINTR. It avoids Rust stdio buffering so secret stdin bytes are not retained in hidden internal buffers.

**Data flow**: Takes `buffer: &mut [u8]`, calls `libc::read(STDIN_FILENO, ...)` in a loop, returns `Ok(0)` on EOF, retries if `last_os_error().kind()` is `Interrupted`, returns `Err(err)` for other negative results, and otherwise returns the positive byte count as `usize`.

**Call relations**: Used only on Unix by `read_auth_header_from_stdin` through `read_auth_header_with`. The caller handles looping across multiple reads, newline detection, and buffer limits.

*Call graph*: 1 external calls (last_os_error).


##### `read_auth_header_with`  (lines 72–162)

```
fn read_auth_header_with(mut read_fn: F) -> Result<&'static str>
```

**Purpose**: Implements the full secure read/validate/build pipeline for the Authorization header. It is the core routine that minimizes copies, trims line endings, validates allowed characters, zeroizes temporary storage, leaks the final string, and locks it in memory.

**Data flow**: Accepts a mutable read callback `F: FnMut(&mut [u8]) -> std::io::Result<usize>`. It allocates a fixed stack buffer, writes `AUTH_HEADER_PREFIX` into the front, then repeatedly reads into the remaining capacity while tracking `total_read`, `saw_newline`, and `saw_eof`. On read error it zeroizes the buffer and returns the error. If the token region fills without newline/EOF, it zeroizes and returns an oversize error. It trims trailing `\n`/`\r`, rejects empty input, validates the token bytes with `validate_auth_header_bytes`, converts the prefix-plus-token slice to UTF-8, copies it into a `String`, zeroizes the stack buffer, leaks the string to `&'static mut str`, calls `mlock_str` on it, and returns the leaked `&'static str`.

**Call relations**: This is the central implementation used by `read_auth_header_from_stdin` and all tests. It delegates character checks to `validate_auth_header_bytes` and post-allocation page locking to `mlock_str`.

*Call graph*: calls 2 internal fn (mlock_str, validate_auth_header_bytes); called by 9 (read_auth_header_from_stdin, errors_on_invalid_characters, errors_on_invalid_utf8, errors_when_buffer_filled, errors_when_no_input_provided, propagates_io_error, reads_key_and_trims_newlines, reads_key_with_no_newlines, reads_key_with_short_reads); 3 external calls (from, anyhow!, from_utf8).


##### `mlock_str`  (lines 204–204)

```
fn mlock_str(_value: &str)
```

**Purpose**: Best-effort locks the memory pages containing the leaked header string so the secret is less likely to be swapped out. It is a no-op on non-Unix platforms and silently gives up on invalid page-size or overflow cases.

**Data flow**: On Unix, takes `value: &str`, returns immediately if empty, queries page size with `sysconf(_SC_PAGESIZE)`, computes page-aligned start and end addresses covering the string bytes with checked arithmetic, derives the total size, and calls `mlock(start as *const c_void, size)`, ignoring the result. On non-Unix, it accepts the string and does nothing.

**Call relations**: Called only by `read_auth_header_with` after the final `String` has been leaked, so the locked memory corresponds to the long-lived static header bytes rather than the temporary stack buffer.

*Call graph*: called by 1 (read_auth_header_with).


##### `validate_auth_header_bytes`  (lines 208–219)

```
fn validate_auth_header_bytes(key_bytes: &[u8]) -> Result<()>
```

**Purpose**: Rejects any API key bytes outside a narrow ASCII allowlist. This prevents embedded control characters, NULs, and other unexpected bytes from entering the Authorization header.

**Data flow**: Takes `key_bytes: &[u8]`, checks that every byte is ASCII alphanumeric or one of `-` / `_`, returns `Ok(())` if all pass, and otherwise returns an `anyhow!` error with a fixed validation message.

**Call relations**: Used by `read_auth_header_with` before UTF-8 conversion and string allocation, so malformed or suspicious input is rejected while still in the temporary buffer.

*Call graph*: called by 1 (read_auth_header_with); 1 external calls (anyhow!).


##### `tests::reads_key_with_no_newlines`  (lines 228–242)

```
fn reads_key_with_no_newlines()
```

**Purpose**: Verifies that a single read containing only the key bytes produces the expected `Bearer` header without requiring a trailing newline. It covers the EOF-terminated happy path.

**Data flow**: Defines a closure that returns `sk-abc123` once and then EOF, passes it to `read_auth_header_with`, unwraps the result, and asserts the returned string equals `Bearer sk-abc123`.

**Call relations**: This test directly exercises `read_auth_header_with`’s basic read, prefixing, and EOF handling.

*Call graph*: calls 1 internal fn (read_auth_header_with); 1 external calls (assert_eq!).


##### `tests::reads_key_with_short_reads`  (lines 245–258)

```
fn reads_key_with_short_reads()
```

**Purpose**: Checks that the reader correctly assembles a key from multiple short reads and stops at newline. It simulates fragmented stdin delivery.

**Data flow**: Builds a `VecDeque` of byte chunks `sk-`, `abc`, and `123\n`, feeds them one by one through a closure passed to `read_auth_header_with`, unwraps the result, and asserts the final header string is `Bearer sk-abc123`.

**Call relations**: This test validates the loop in `read_auth_header_with`, especially accumulation across reads and newline detection in only the newly written region.

*Call graph*: calls 1 internal fn (read_auth_header_with); 3 external calls (from, assert_eq!, vec!).


##### `tests::reads_key_and_trims_newlines`  (lines 261–275)

```
fn reads_key_and_trims_newlines()
```

**Purpose**: Ensures trailing CRLF is removed from stdin input before constructing the Authorization header. It covers common shell/pipe line-ending behavior.

**Data flow**: Supplies a single chunk `sk-abc123\r\n` through `read_auth_header_with`, unwraps the result, and asserts the returned string omits the line endings.

**Call relations**: This test targets the trimming loop in `read_auth_header_with` after reading has completed.

*Call graph*: calls 1 internal fn (read_auth_header_with); 1 external calls (assert_eq!).


##### `tests::errors_when_no_input_provided`  (lines 278–282)

```
fn errors_when_no_input_provided()
```

**Purpose**: Confirms that empty stdin is rejected with a helpful message instead of producing `Bearer ` with no token. It protects against accidental startup without credentials.

**Data flow**: Passes a closure that immediately returns EOF to `read_auth_header_with`, captures the error, formats it with alternate debug display, and asserts the message contains `must be provided`.

**Call relations**: This test exercises the empty-input guard in `read_auth_header_with` after trimming.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


##### `tests::errors_when_buffer_filled`  (lines 285–296)

```
fn errors_when_buffer_filled()
```

**Purpose**: Verifies that an overlong key filling the entire token buffer without newline or EOF is rejected. This prevents silent truncation of credentials.

**Data flow**: Creates a vector of `a` bytes exactly filling the token capacity, copies it into the provided buffer in one read, calls `read_auth_header_with`, captures the error text, and asserts it contains the expected buffer-size message.

**Call relations**: This test targets the explicit overflow check in `read_auth_header_with` when `total_read == capacity` and no terminator was seen.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


##### `tests::propagates_io_error`  (lines 299–305)

```
fn propagates_io_error()
```

**Purpose**: Checks that underlying read errors are returned intact rather than being masked by generic parsing failures. It preserves diagnosability of stdin problems.

**Data flow**: Passes a closure that returns `io::Error::other("boom")` to `read_auth_header_with`, unwraps the error, downcasts it back to `io::Error`, and asserts both kind and message.

**Call relations**: This test covers the early error path in `read_auth_header_with` where the temporary buffer is zeroized and the original I/O error is propagated.

*Call graph*: calls 1 internal fn (read_auth_header_with); 1 external calls (assert_eq!).


##### `tests::errors_on_invalid_utf8`  (lines 308–323)

```
fn errors_on_invalid_utf8()
```

**Purpose**: Ensures non-ASCII/invalid bytes in the key are rejected by validation before a header string is produced. It demonstrates that malformed UTF-8 does not slip through.

**Data flow**: Feeds `sk-abc\xff` through `read_auth_header_with`, captures the resulting error text, and asserts it contains the fixed allowed-characters validation message.

**Call relations**: This test exercises `validate_auth_header_bytes` as called from `read_auth_header_with`, showing that invalid bytes are rejected before UTF-8 conversion.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


##### `tests::errors_on_invalid_characters`  (lines 326–341)

```
fn errors_on_invalid_characters()
```

**Purpose**: Checks that punctuation outside the allowlist, such as `!`, causes validation failure. It enforces the restricted token character set.

**Data flow**: Feeds `sk-abc!23` through `read_auth_header_with`, captures the formatted error, and asserts it contains the allowed-characters message.

**Call relations**: This test complements the invalid-UTF8 case by covering printable but disallowed characters rejected by `validate_auth_header_bytes`.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


### `rmcp-client/src/utils.rs`

`util` · `startup and transport setup`

This utility module supports both stdio-based MCP server launch and Streamable HTTP client setup. Its environment-building path distinguishes two execution models: local stdio servers inherit a curated baseline of host variables (`DEFAULT_ENV_VARS`) plus explicitly configured MCP variables, while remote stdio servers receive only an overlay of explicitly named local variables and literal overrides so the remote executor can supply its own `PATH`, `HOME`, and similar process context. The helper `local_stdio_env_var_names` enforces an important invariant: any `McpServerEnvVar` marked with source `remote` is invalid for local stdio launch and causes an error instead of being silently ignored. Environment values are read with `env::var_os`, preserving non-UTF-8 data such as Unix `PATH` bytes.

The HTTP side converts optional static header maps and environment-backed header definitions into a `HeaderMap`. Invalid header names or values are not fatal; they are skipped with `tracing::warn!`, allowing partially valid configuration to proceed. Environment-derived headers are only inserted when the named environment variable exists and its trimmed value is non-empty. `apply_default_headers` then conditionally clones the map into a `reqwest::ClientBuilder`, avoiding unnecessary builder mutation when no defaults exist.

The test module uses an RAII `EnvVarGuard` to serialize and restore process environment mutations, covering override precedence, explicit forwarding behavior, rejection of remote-only vars in local mode, extraction of remote var names, and preservation of non-UTF-8 environment values.

#### Function details

##### `create_env_for_mcp_server`  (lines 12–25)

```
fn create_env_for_mcp_server(
    extra_env: Option<HashMap<OsString, OsString>>,
    env_vars: &[McpServerEnvVar],
) -> Result<HashMap<OsString, OsString>>
```

**Purpose**: Builds the full environment map for launching a local stdio MCP server. It starts from the platform whitelist, adds configured MCP variable names after validating they are local-only, then overlays explicit per-server overrides.

**Data flow**: It takes optional `extra_env: Option<HashMap<OsString, OsString>>` and a slice of `McpServerEnvVar`. It reads the current process environment via `env::var_os` for each whitelisted/default variable and each configured variable name returned by `local_stdio_env_var_names`, preserving `OsString` values exactly, then chains any `extra_env` entries on top and collects everything into a `HashMap<OsString, OsString>`. It returns `Result<HashMap<OsString, OsString>>`, failing if any configured variable is marked as remote-source.

**Call relations**: This is the local-launch path used by client/server construction code when creating stdio MCP processes, and by tests that verify override precedence and validation. Before collecting variables it delegates to `local_stdio_env_var_names` specifically to reject remote-only configuration early rather than producing a misleading partial environment.

*Call graph*: calls 1 internal fn (local_stdio_env_var_names); called by 6 (new, launch_server, create_env_honors_overrides, create_env_includes_additional_whitelisted_variables, create_env_preserves_path_when_it_is_not_utf8, create_local_env_rejects_remote_source_variables).


##### `create_env_overlay_for_remote_mcp_server`  (lines 27–40)

```
fn create_env_overlay_for_remote_mcp_server(
    extra_env: Option<HashMap<OsString, OsString>>,
    env_vars: &[McpServerEnvVar],
) -> HashMap<OsString, OsString>
```

**Purpose**: Builds only the explicit environment overlay that should be sent to a remote executor for remote stdio MCP launch. It intentionally avoids copying the local process baseline such as `PATH` or `HOME`.

**Data flow**: It accepts optional `extra_env` and configured `env_vars`. It filters the `McpServerEnvVar` slice to entries whose source is not remote, reads those names from the current process with `env::var_os`, converts names to `OsString`, chains any literal overrides from `extra_env`, and collects the result into a `HashMap<OsString, OsString>`. It writes no external state and never errors.

**Call relations**: Launch code uses this on the remote stdio path so the executor-side runtime remains responsible for its own core environment. Tests invoke it to confirm that default inherited variables are excluded and that `source: remote` entries are not copied from the orchestrator process.

*Call graph*: called by 3 (launch_server, create_remote_env_overlay_does_not_copy_remote_source_variables, create_remote_env_overlay_only_forwards_explicit_variables); 1 external calls (iter).


##### `remote_mcp_env_var_names`  (lines 42–48)

```
fn remote_mcp_env_var_names(env_vars: &[McpServerEnvVar]) -> Vec<String>
```

**Purpose**: Extracts just the names of MCP environment variables whose source is explicitly `remote`. The result is suitable for telling a remote runtime which variables it must resolve on its own side.

**Data flow**: It reads a slice of `McpServerEnvVar`, filters to `is_remote_source()`, maps each to `name().to_string()`, and returns a `Vec<String>`. It does not inspect the process environment or mutate state.

**Call relations**: Remote launch orchestration uses this alongside the local overlay builder to split configuration into 'forward from orchestrator' versus 'resolve remotely'. The dedicated unit test exercises the mixed legacy/local/remote cases.

*Call graph*: called by 2 (launch_server, remote_mcp_env_var_names_returns_remote_source_names); 1 external calls (iter).


##### `local_stdio_env_var_names`  (lines 50–58)

```
fn local_stdio_env_var_names(env_vars: &[McpServerEnvVar]) -> Result<impl Iterator<Item = &str>>
```

**Purpose**: Validates that a local stdio launch configuration contains no remote-sourced environment variables, then exposes the configured variable names as an iterator. Its main job is policy enforcement, not collection.

**Data flow**: It takes a slice of `McpServerEnvVar`, scans it for the first entry where `is_remote_source()` is true, and if found returns an `anyhow!` error mentioning the offending variable name and the requirement for remote MCP stdio. Otherwise it returns an iterator over `McpServerEnvVar::name` values as `&str`.

**Call relations**: Only `create_env_for_mcp_server` calls this, using it as a gate before reading any configured variables from the local process environment. That keeps local launch semantics strict and makes misconfiguration visible immediately.

*Call graph*: called by 1 (create_env_for_mcp_server); 2 external calls (anyhow!, iter).


##### `build_default_headers`  (lines 60–116)

```
fn build_default_headers(
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: Option<HashMap<String, String>>,
) -> Result<HeaderMap>
```

**Purpose**: Constructs a reqwest `HeaderMap` from two optional configuration sources: literal header values and environment-backed header values. It tolerates malformed entries by logging warnings and skipping them.

**Data flow**: It accepts `http_headers: Option<HashMap<String, String>>` and `env_http_headers: Option<HashMap<String, String>>`. For static headers it parses each key with `HeaderName::from_bytes` and each value with `HeaderValue::from_str`; valid pairs are inserted into a mutable `HeaderMap`. For env-backed headers it reads each referenced environment variable with `env::var`, ignores missing vars and blank/whitespace-only values, parses the configured header name and the fetched value, and inserts valid pairs. It returns `Result<HeaderMap>`, though parse failures are downgraded to warnings rather than returned as errors.

**Call relations**: HTTP transport setup and OAuth/auth-status discovery call this before creating clients or pending transports. It serves as the normalization point so downstream code can work with a ready `HeaderMap` instead of repeating parsing and validation logic.

*Call graph*: called by 4 (determine_streamable_http_auth_status, discover_streamable_http_oauth, new, create_pending_transport); 5 external calls (new, from_bytes, from_str, var, warn!).


##### `apply_default_headers`  (lines 118–127)

```
fn apply_default_headers(
    builder: ClientBuilder,
    default_headers: &HeaderMap,
) -> ClientBuilder
```

**Purpose**: Applies a prepared default header set to a `reqwest::ClientBuilder` only when the set is non-empty. This avoids unnecessary cloning and builder modification for the common no-header case.

**Data flow**: It takes ownership of a `ClientBuilder` and borrows a `HeaderMap`. If `default_headers.is_empty()` it returns the builder unchanged; otherwise it clones the map and returns `builder.default_headers(...)`. It mutates only the builder value being returned.

**Call relations**: Client-construction paths call this after `build_default_headers` has produced a normalized header map. It is the final adapter from internal header representation into reqwest client configuration.

*Call graph*: called by 3 (discover_streamable_http_oauth_with_headers, new, create_oauth_transport_and_runtime); 3 external calls (default_headers, clone, is_empty).


##### `tests::EnvVarGuard::set`  (lines 162–171)

```
fn set(key: &str, value: impl AsRef<OsStr>) -> Self
```

**Purpose**: Temporarily sets a process environment variable for a test while remembering the previous value for restoration. It provides deterministic setup around globally shared environment state.

**Data flow**: It takes a key and a value implementing `AsRef<OsStr>`, reads the original value with `std::env::var_os`, then uses unsafe `std::env::set_var` to install the new value. It returns an `EnvVarGuard` containing the key string and optional original `OsString`.

**Call relations**: The environment-mutating tests construct this guard before invoking the utility functions under test. Restoration is deferred to `tests::EnvVarGuard::drop`, so callers only need to keep the guard alive for the test scope.

*Call graph*: 3 external calls (as_ref, set_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 175–185)

```
fn drop(&mut self)
```

**Purpose**: Restores or removes the guarded environment variable when the test scope ends. This ensures tests do not leak process-wide environment mutations into later cases.

**Data flow**: It reads `self.original`; if present it uses unsafe `std::env::set_var` to restore the previous value, otherwise it uses unsafe `std::env::remove_var` to delete the variable. It returns no value and writes only process environment state.

**Call relations**: This runs automatically when an `EnvVarGuard` created by `tests::EnvVarGuard::set` goes out of scope. The serial test annotations complement it by preventing concurrent tests from racing on the same environment keys.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::create_env_honors_overrides`  (lines 189–198)

```
async fn create_env_honors_overrides()
```

**Purpose**: Verifies that explicit `extra_env` entries override values inherited from the default environment whitelist. The test specifically checks replacement of `TZ`.

**Data flow**: It constructs an override map containing `TZ=custom`, calls `create_env_for_mcp_server` with no configured extra variable names, and reads the resulting map entry for `TZ`. It asserts that the returned `OsString` matches the override value.

**Call relations**: This test exercises the final chaining order inside `create_env_for_mcp_server`, proving that explicit launch-time overrides win over inherited process values.

*Call graph*: calls 1 internal fn (create_env_for_mcp_server); 3 external calls (from, from, assert_eq!).


##### `tests::create_env_includes_additional_whitelisted_variables`  (lines 202–210)

```
fn create_env_includes_additional_whitelisted_variables()
```

**Purpose**: Checks that configured MCP environment variable names beyond the built-in whitelist are copied from the current process into a local stdio environment. It covers the positive path for explicit extra forwarding.

**Data flow**: It uses `EnvVarGuard::set` to install `EXTRA_RMCP_ENV=from-env`, passes that variable name as a one-element `McpServerEnvVar` slice to `create_env_for_mcp_server`, and inspects the returned map. It asserts that the custom variable is present with the expected `OsString` value.

**Call relations**: The test validates the branch where `create_env_for_mcp_server` extends `DEFAULT_ENV_VARS` with names yielded by `local_stdio_env_var_names`.

*Call graph*: calls 2 internal fn (set, create_env_for_mcp_server); 2 external calls (from, assert_eq!).


##### `tests::create_remote_env_overlay_only_forwards_explicit_variables`  (lines 214–228)

```
fn create_remote_env_overlay_only_forwards_explicit_variables()
```

**Purpose**: Confirms that the remote overlay builder does not copy baseline default environment variables and forwards only explicitly named variables. This protects remote execution from inheriting orchestrator-local process context.

**Data flow**: It sets one default variable and one custom variable in the process environment, calls `create_env_overlay_for_remote_mcp_server` with only the custom variable configured, and compares the entire returned `HashMap`. The expected map contains only the custom variable/value pair.

**Call relations**: This test targets the remote-launch semantics of `create_env_overlay_for_remote_mcp_server`, demonstrating the contrast with the local environment builder.

*Call graph*: calls 2 internal fn (set, create_env_overlay_for_remote_mcp_server); 2 external calls (from, assert_eq!).


##### `tests::create_remote_env_overlay_does_not_copy_remote_source_variables`  (lines 232–257)

```
fn create_remote_env_overlay_does_not_copy_remote_source_variables()
```

**Purpose**: Verifies that variables marked with `source: remote` are excluded from the orchestrator-side overlay even if they exist locally. Only variables marked local are forwarded.

**Data flow**: It sets both a remote-only and a local variable in the process environment, constructs two `McpServerEnvVar::Config` entries with different `source` values, calls `create_env_overlay_for_remote_mcp_server`, and asserts that the resulting map contains only the local variable/value pair.

**Call relations**: This test covers the `!var.is_remote_source()` filter in the remote overlay builder and documents the intended split between local forwarding and remote-side resolution.

*Call graph*: calls 2 internal fn (set, create_env_overlay_for_remote_mcp_server); 2 external calls (from, assert_eq!).


##### `tests::remote_mcp_env_var_names_returns_remote_source_names`  (lines 260–274)

```
fn remote_mcp_env_var_names_returns_remote_source_names()
```

**Purpose**: Checks that only remote-sourced configuration entries are returned by the remote-name extractor. Legacy/plain and explicitly local entries are omitted.

**Data flow**: It builds a mixed slice containing a legacy string-converted entry, a local config entry, and a remote config entry, passes it to `remote_mcp_env_var_names`, and asserts that the returned vector is exactly `["REMOTE"]`.

**Call relations**: This test isolates the filtering logic used by remote launch orchestration when deciding which variable names the executor must source remotely.

*Call graph*: calls 1 internal fn (remote_mcp_env_var_names); 1 external calls (assert_eq!).


##### `tests::create_local_env_rejects_remote_source_variables`  (lines 277–291)

```
fn create_local_env_rejects_remote_source_variables()
```

**Purpose**: Ensures local stdio environment construction fails fast when configuration includes a remote-sourced variable. The test checks the user-facing error wording.

**Data flow**: It calls `create_env_for_mcp_server` with a single `McpServerEnvVar::Config` whose source is `remote`, captures the error via `expect_err`, converts it to string, and asserts that the message mentions the requirement for remote MCP stdio.

**Call relations**: This test exercises the error path produced by `local_stdio_env_var_names` and propagated by `create_env_for_mcp_server`.

*Call graph*: calls 1 internal fn (create_env_for_mcp_server); 1 external calls (assert!).


##### `tests::create_env_preserves_path_when_it_is_not_utf8`  (lines 296–307)

```
fn create_env_preserves_path_when_it_is_not_utf8()
```

**Purpose**: Verifies that environment collection preserves non-UTF-8 bytes in inherited variables on Unix. It specifically guards against accidental lossy conversion of `PATH`.

**Data flow**: It constructs a raw byte `OsStr` containing an invalid UTF-8 byte, sets `PATH` to that value with `EnvVarGuard::set`, calls `create_env_for_mcp_server`, and compares the returned `PATH` entry against the original `OsString`. No string conversion is performed in the assertion path.

**Call relations**: This Unix-only test validates the use of `env::var_os` inside `create_env_for_mcp_server`, documenting why the function works with `OsString` rather than `String`.

*Call graph*: calls 2 internal fn (set, create_env_for_mcp_server); 2 external calls (assert_eq!, from_bytes).


### Configuration normalization primitives
This group provides the shared building blocks for labeling, constraining, renaming, converting, and overriding configuration values across interfaces.

### `config/src/config_layer_source.rs`

`util` · `cross-cutting diagnostics and config source reporting`

This utility file contains a single formatting function that centralizes the display strings for every `codex_app_server_protocol::ConfigLayerSource` variant. The output is intentionally semantic rather than debug-oriented: MDM sources become `MDM (domain:key)`, system and user sources include the underlying file path, enterprise-managed layers include both the backend-provided name and id, project layers render the `.codex` directory plus the supplied config filename, and session flags / legacy managed-config variants use fixed labels.

The `config_toml_file` parameter matters only for the `Project` variant, where the source stores the `.codex` folder rather than the full config file path; the function appends the caller-provided filename to produce a complete display path. All path-bearing variants call `as_path().display()` so formatting stays platform-correct without allocating intermediate path strings.

Because this logic is centralized, downstream diagnostics such as layer listings and config parse errors can present consistent source names across local files, MDM, enterprise-managed cloud fragments, and legacy managed-config mechanisms.

#### Function details

##### `format_config_layer_source`  (lines 3–31)

```
fn format_config_layer_source(source: &ConfigLayerSource, config_toml_file: &str) -> String
```

**Purpose**: Maps each `ConfigLayerSource` variant to the exact human-readable string used to describe that configuration layer’s origin.

**Data flow**: Reads a borrowed `ConfigLayerSource` and `config_toml_file` string. It pattern-matches the source variant and returns a formatted `String`: MDM uses domain/key, system/user/legacy-file variants include displayed paths, enterprise-managed uses name and id, project combines the `.codex` folder path with `config_toml_file`, and session/legacy-MDM variants return fixed literals.

**Call relations**: Called by higher-level config diagnostics and reporting code whenever a layer source must be rendered consistently for users.

*Call graph*: 1 external calls (format!).


### `config/src/constraint.rs`

`util` · `cross-cutting`

This file implements the reusable constraint machinery that the requirements system builds on. `ConstraintError` is the common failure type, with variants for invalid candidate values, empty required fields, and execution-policy parse failures; invalid-value errors carry the field name, a formatted candidate, the allowed set description, and a `RequirementSource` so diagnostics can point back to the enforcing layer. A `From<ConstraintError> for std::io::Error` adapter lets callers surface these failures through standard I/O-style APIs.

The main type is `Constrained<T>`, which stores a current value, an `Arc`-wrapped validator closure, and an optional `Arc` normalizer closure. `new` validates the initial value before constructing the wrapper. `normalized` installs a normalizer and an allow-all validator, applying normalization immediately to the initial value. `allow_any`, `allow_only`, and `allow_any_from_default` are convenience constructors for common policies. Runtime interaction is intentionally split: `can_set` probes a candidate without mutating state, `set` optionally normalizes then validates before replacing the stored value, and `add_validator` composes an additional validator onto the existing one while first ensuring the current value still satisfies the combined rule. `Deref`, `Debug`, and `PartialEq` are implemented in terms of the stored value only, so the wrapper behaves like the underlying value for most read-only comparisons while still enforcing constraints on mutation.

#### Function details

##### `ConstraintError::empty_field`  (lines 30–34)

```
fn empty_field(field_name: impl Into<String>) -> Self
```

**Purpose**: Constructs the `EmptyField` error variant from any string-like field name input.

**Data flow**: Consumes `field_name: impl Into<String>`, converts it into a `String`, and returns `ConstraintError::EmptyField { field_name }`.

**Call relations**: Used by requirement-compilation code when a managed allowlist or required nested field is present but empty.

*Call graph*: called by 1 (try_from); 1 external calls (into).


##### `Error::from`  (lines 40–42)

```
fn from(err: ConstraintError) -> Self
```

**Purpose**: Converts a `ConstraintError` into an `std::io::Error` with `InvalidInput` kind.

**Data flow**: Consumes a `ConstraintError`, wraps it with `std::io::Error::new(std::io::ErrorKind::InvalidInput, err)`, and returns the I/O error.

**Call relations**: Lets callers that expose I/O-oriented APIs propagate constraint failures without inventing a separate error channel.

*Call graph*: 1 external calls (new).


##### `Constrained::new`  (lines 58–69)

```
fn new(
        initial_value: T,
        validator: impl Fn(&T) -> ConstraintResult<()> + Send + Sync + 'static,
    ) -> ConstraintResult<Self>
```

**Purpose**: Creates a constrained value with a validator and rejects invalid initial values immediately.

**Data flow**: Takes an initial value and a validator closure, wraps the closure in `Arc`, runs it against the initial value, and on success stores the value, validator, and `None` normalizer in a new `Constrained<T>`. On failure it returns the validator's `ConstraintError`.

**Call relations**: Used heavily by requirement compilation to turn allowlists and exact-match requirements into active runtime constraints.

*Call graph*: called by 13 (try_from, constrained_add_validator_composes_with_existing_validator, constrained_can_set_allows_probe_without_setting, constrained_new_rejects_invalid_initial_value, constrained_set_rejects_invalid_value_and_leaves_previous, derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults, derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback, test_requirements_web_search_mode_allowlist_does_not_warn_when_unset, web_search_mode_for_turn_falls_back_when_live_is_disallowed, from_constrained_resolved (+3 more)); 1 external calls (new).


##### `Constrained::normalized`  (lines 72–85)

```
fn normalized(
        initial_value: T,
        normalizer: impl Fn(T) -> T + Send + Sync + 'static,
    ) -> ConstraintResult<Self>
```

**Purpose**: Creates a constrained value that first normalizes inputs and then accepts any normalized result.

**Data flow**: Takes an initial value and a normalizer closure, wraps an allow-all validator and the normalizer in `Arc`, applies the normalizer to the initial value, validates the normalized result, and stores it with the normalizer attached.

**Call relations**: Used where callers want canonicalization on both initialization and later `set` operations without imposing additional validation rules.

*Call graph*: called by 2 (constrained_normalizer_applies_on_init_and_set, constrain_mcp_servers); 1 external calls (new).


##### `Constrained::allow_any`  (lines 87–93)

```
fn allow_any(initial_value: T) -> Self
```

**Purpose**: Constructs a constraint wrapper that accepts any value and performs no normalization.

**Data flow**: Stores the provided initial value, an allow-all validator closure, and `None` for the normalizer.

**Call relations**: Used as the default unconstrained state for many config fields when no managed requirement applies.

*Call graph*: called by 39 (list_all_tools_accepts_canonical_namespaced_tool_names, list_all_tools_adds_server_metadata_to_cached_tools, list_all_tools_applies_legacy_mcp_prefix_by_default, list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot, list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending, list_available_server_infos_uses_cache_while_client_is_pending, no_local_runtime_fails_local_stdio_but_keeps_local_http_server, shutdown_cancels_pending_tool_listing (+15 more)); 1 external calls (new).


##### `Constrained::allow_only`  (lines 95–116)

```
fn allow_only(only_value: T) -> Self
```

**Purpose**: Constructs a constraint wrapper that permits exactly one value and rejects all others with a generic invalid-value error.

**Data flow**: Clones the provided `only_value` into a captured `allowed_value`, stores the original as the current value, and installs a validator closure that compares candidates for equality and otherwise returns `ConstraintError::InvalidValue` with field name `<unknown>` and source `Unknown`.

**Call relations**: Used in places that need a fixed immutable setting rather than an allowlist.

*Call graph*: called by 8 (resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode, constrained_allow_only_rejects_different_values, replace_permission_profile_from_session_snapshot, permission_snapshot_setter_preserves_permission_constraints, build_guardian_review_session_config, start_review_conversation, get_config, on_session_configured_with_display_and_fork_parent_title); 2 external calls (new, clone).


##### `Constrained::allow_any_from_default`  (lines 119–124)

```
fn allow_any_from_default() -> Self
```

**Purpose**: Constructs an unconstrained wrapper using `T::default()` as the initial value.

**Data flow**: Calls `T::default()` and passes the result to `Constrained::allow_any`.

**Call relations**: Used by default config/requirements constructors for unconstrained fields whose type has a natural default.

*Call graph*: called by 2 (default, try_from); 2 external calls (allow_any, default).


##### `Constrained::get`  (lines 126–128)

```
fn get(&self) -> &T
```

**Purpose**: Returns a shared reference to the stored value.

**Data flow**: Reads `self.value` and returns `&T`.

**Call relations**: Used by callers that need borrowed access without copying or deref coercion.

*Call graph*: called by 7 (new_uninitialized, to_mcp_config_with_plugin_registrations, active_permission_profile, from_constrained_active_profile, from_constrained_legacy, permission_profile, profile_workspace_roots).


##### `Constrained::value`  (lines 130–135)

```
fn value(&self) -> T
```

**Purpose**: Returns the stored value by copy for `Copy` types.

**Data flow**: Reads and returns `self.value`.

**Call relations**: Used by callers and tests that want the current scalar value without borrowing.

*Call graph*: called by 6 (new, new_uninitialized_with_permission_profile, set_approval_policy, resolve_web_search_mode_for_turn, thread_config_snapshot, to_turn_context_item).


##### `Constrained::can_set`  (lines 137–139)

```
fn can_set(&self, candidate: &T) -> ConstraintResult<()>
```

**Purpose**: Checks whether a candidate value would satisfy the current constraint without mutating the stored value.

**Data flow**: Passes `candidate` to the stored validator closure and returns its `ConstraintResult<()>`.

**Call relations**: Used throughout config resolution to probe whether a derived or requested value is allowed before committing it.

*Call graph*: called by 2 (resolve_web_search_mode_for_turn, can_set_legacy_permission_profile).


##### `Constrained::add_validator`  (lines 144–160)

```
fn add_validator(
        &mut self,
        validator: impl Fn(&T) -> ConstraintResult<()> + Send + Sync + 'static,
    ) -> ConstraintResult<()>
```

**Purpose**: Adds an additional validation rule on top of the existing one and ensures the current value still satisfies the combined constraint before installing it.

**Data flow**: Clones the existing validator `Arc`, builds a new combined validator that runs the old validator then the new closure, validates `self.value` with the combined validator, and if successful replaces `self.validator` with it.

**Call relations**: Used when constraints need to be tightened incrementally after construction.

*Call graph*: 1 external calls (new).


##### `Constrained::set`  (lines 162–171)

```
fn set(&mut self, value: T) -> ConstraintResult<()>
```

**Purpose**: Attempts to replace the stored value, applying normalization first if configured and then validating the result.

**Data flow**: Consumes a new value `T`, runs it through `self.normalizer` if present, validates the normalized value with `self.validator`, and on success writes it into `self.value`; on failure it leaves the previous value unchanged and returns the error.

**Call relations**: This is the mutation point enforced by all compiled requirement constraints.

*Call graph*: called by 2 (set_legacy_permission_profile, set_permission_profile_snapshot).


##### `Constrained::deref`  (lines 177–179)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Provides shared-reference deref access to the stored value.

**Data flow**: Returns `&self.value`.

**Call relations**: Allows `Constrained<T>` to be used ergonomically in read-only contexts as if it were `&T`.


##### `Constrained::fmt`  (lines 183–187)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the wrapper for debugging by showing only the current value, not the validator or normalizer internals.

**Data flow**: Builds a debug struct named `Constrained` with a single `value` field and writes it to the formatter.

**Call relations**: Used in tests and diagnostics where the current constrained value matters but closure internals are opaque.

*Call graph*: 1 external calls (debug_struct).


##### `Constrained::eq`  (lines 191–193)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Defines equality for constrained values in terms of their stored values only.

**Data flow**: Compares `self.value == other.value` and returns the boolean result.

**Call relations**: Lets tests and callers compare constrained wrappers without considering validator identity.


##### `tests::invalid_value`  (lines 201–208)

```
fn invalid_value(candidate: impl Into<String>, allowed: impl Into<String>) -> ConstraintError
```

**Purpose**: Builds a standard `ConstraintError::InvalidValue` fixture with unknown field/source for test assertions.

**Data flow**: Converts the candidate and allowed inputs into strings and returns the assembled error value.

**Call relations**: Shared helper for the unit tests in this file.

*Call graph*: 1 external calls (into).


##### `tests::constrained_allow_any_accepts_any_value`  (lines 211–217)

```
fn constrained_allow_any_accepts_any_value()
```

**Purpose**: Verifies that `allow_any` permits mutation to arbitrary values.

**Data flow**: Creates `Constrained::allow_any(5)`, sets it to `-10`, and asserts the stored value changed.

**Call relations**: Covers the unconstrained mutation path.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (assert_eq!).


##### `tests::constrained_allow_any_default_uses_default_value`  (lines 220–223)

```
fn constrained_allow_any_default_uses_default_value()
```

**Purpose**: Checks that `allow_any_from_default` initializes from `T::default()`.

**Data flow**: Constructs `Constrained::<i32>::allow_any_from_default()` and asserts the stored value is `0`.

**Call relations**: Covers the default-based convenience constructor.

*Call graph*: 2 external calls (allow_any_from_default, assert_eq!).


##### `tests::constrained_allow_only_rejects_different_values`  (lines 226–237)

```
fn constrained_allow_only_rejects_different_values()
```

**Purpose**: Ensures `allow_only` accepts the fixed value and rejects any different value without changing stored state.

**Data flow**: Creates `allow_only(5)`, successfully sets `5`, attempts to set `6`, asserts the returned error, and confirms the stored value remains `5`.

**Call relations**: Covers the exact-match validator generated by `allow_only`.

*Call graph*: calls 1 internal fn (allow_only); 1 external calls (assert_eq!).


##### `tests::constrained_normalizer_applies_on_init_and_set`  (lines 240–249)

```
fn constrained_normalizer_applies_on_init_and_set() -> anyhow::Result<()>
```

**Purpose**: Verifies that `normalized` applies its normalizer both to the initial value and to later `set` inputs.

**Data flow**: Creates `Constrained::normalized(-1, |value| value.max(0))`, asserts the initial stored value is normalized to `0`, then sets `-5` and `10` and asserts the normalized results.

**Call relations**: Covers the normalizer path in both construction and mutation.

*Call graph*: calls 1 internal fn (normalized); 1 external calls (assert_eq!).


##### `tests::constrained_add_validator_composes_with_existing_validator`  (lines 252–279)

```
fn constrained_add_validator_composes_with_existing_validator() -> anyhow::Result<()>
```

**Purpose**: Checks that `add_validator` combines old and new validation rules and enforces both on future probes.

**Data flow**: Creates a constraint requiring nonnegative values, adds a second validator requiring values <= 10, then asserts `can_set` succeeds for `7` and fails for `11` and `-1`.

**Call relations**: Exercises validator composition and current-value revalidation.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::constrained_new_rejects_invalid_initial_value`  (lines 282–292)

```
fn constrained_new_rejects_invalid_initial_value()
```

**Purpose**: Ensures `new` fails immediately when the initial value violates the validator.

**Data flow**: Attempts to construct a positive-only constraint with initial value `0` and asserts the returned error.

**Call relations**: Covers eager validation during construction.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::constrained_set_rejects_invalid_value_and_leaves_previous`  (lines 295–310)

```
fn constrained_set_rejects_invalid_value_and_leaves_previous()
```

**Purpose**: Verifies that `set` rejects invalid values and preserves the previous stored value on failure.

**Data flow**: Creates a positive-only constraint with initial value `1`, attempts to set `-5`, asserts the error, and confirms the stored value is still `1`.

**Call relations**: Covers the failure path of `set`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::constrained_can_set_allows_probe_without_setting`  (lines 313–331)

```
fn constrained_can_set_allows_probe_without_setting()
```

**Purpose**: Checks that `can_set` validates candidates without mutating the stored value.

**Data flow**: Creates a positive-only constraint, probes `2` and `-1` with `can_set`, asserts the outcomes, and confirms the stored value remains `1`.

**Call relations**: Covers the non-mutating probe API.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `config/src/key_aliases.rs`

`util` · `config normalization`

This file defines a tiny aliasing layer over raw `toml::Value` trees. Its core data model is the private `ConfigKeyAlias` struct, which names a target table path plus a `legacy_key` and `canonical_key`. The current alias table contains one migration under `[memories]`, mapping `no_memories_if_mcp_or_web_search` to `disable_on_external_context`.

The normalization logic is path-sensitive: aliases are only applied when the current table path exactly matches the alias's `table_path`. `normalize_key_aliases` mutates a `TomlMap<String, TomlValue>` in place by removing the legacy entry and inserting its value under the canonical key only if the canonical key is absent. That means explicit canonical configuration wins over migrated legacy input.

`normalized_with_key_aliases` performs a full recursive copy of a TOML value. For tables, it descends into each child while extending the path with the child key, rebuilds a fresh `TomlMap`, then applies alias normalization to the rebuilt table at the current path. For arrays, it recursively normalizes each element using the same path, which matters for arrays of tables nested under aliased sections. Scalars are cloned unchanged. The design intentionally avoids mutating the original tree and ensures aliases are applied consistently after children have already been normalized.

#### Function details

##### `normalize_key_aliases`  (lines 17–30)

```
fn normalize_key_aliases(path: &[String], table: &mut TomlMap<String, TomlValue>)
```

**Purpose**: Applies any configured legacy-to-canonical key renames for one specific TOML table path. It performs a non-destructive migration in the sense that an existing canonical key is never replaced by a legacy value.

**Data flow**: Inputs are the current table path as `&[String]` and a mutable `TomlMap<String, TomlValue>`. It compares the path against each `ConfigKeyAlias.table_path`; on a match, it removes `alias.legacy_key` from the table and inserts that value at `alias.canonical_key` only if no canonical entry already exists. It returns `()` after mutating the provided map in place.

**Call relations**: This function is invoked after a table has been assembled from recursive traversal, including by `normalized_with_key_aliases`, and also by merge-time normalization elsewhere. It delegates only to map operations like `remove`/`entry` because its job is the final path-local rewrite step.

*Call graph*: called by 2 (normalized_with_key_aliases, merge_toml_values_at_path); 2 external calls (entry, remove).


##### `normalized_with_key_aliases`  (lines 32–52)

```
fn normalized_with_key_aliases(value: &TomlValue, path: &[String]) -> TomlValue
```

**Purpose**: Recursively rebuilds a TOML value tree while applying key alias normalization to every table node. It is the tree-wide entry point for alias-aware normalization.

**Data flow**: Inputs are an immutable `&TomlValue` and the current traversal path `&[String]`. For `TomlValue::Table`, it creates a new `TomlMap`, recursively normalizes each child using `path + key`, then calls `normalize_key_aliases` on the rebuilt table and returns `TomlValue::Table(normalized)`. For `TomlValue::Array`, it maps each element through the same function with the unchanged path and returns a new array. For all other variants, it returns `value.clone()`.

**Call relations**: This function is called by higher-level config merge/origin code when a whole TOML subtree needs alias normalization. Its main delegation is recursive self-calls for structural traversal and a final call to `normalize_key_aliases` at each table boundary.

*Call graph*: calls 1 internal fn (normalize_key_aliases); called by 2 (merge_toml_values_at_path, origins); 4 external calls (new, Array, Table, clone).


### `utils/json-to-toml/src/lib.rs`

`util` · `cross-cutting`

This file is a small recursive conversion utility between two generic value representations. The public function `json_to_toml` pattern-matches on `serde_json::Value` and constructs the nearest `toml::Value` equivalent. Primitive mappings are straightforward for booleans and strings. Numbers are handled carefully: the converter prefers `as_i64()` and emits `TomlValue::Integer` when possible, otherwise falls back to `as_f64()` and emits `TomlValue::Float`; if neither representation is available, it serializes the JSON number to text and stores it as a TOML string. Arrays are converted element-by-element by recursively calling `json_to_toml`, and objects are converted into `toml::value::Table` by preserving keys and recursively converting values. One notable design choice is the treatment of JSON `null`: because TOML has no null value, this utility maps it to an empty string rather than omitting the field or inventing a custom sentinel. The inline test module documents these semantics with focused examples for integers, floats, booleans, arrays, nulls, and nested objects, making the intended lossy/null behavior explicit.

#### Function details

##### `json_to_toml`  (lines 5–28)

```
fn json_to_toml(v: JsonValue) -> TomlValue
```

**Purpose**: Recursively converts a `serde_json::Value` into a `toml::Value` using a fixed mapping for each JSON variant.

**Data flow**: It consumes a `JsonValue`. `Null` becomes `TomlValue::String(String::new())`; booleans and strings map directly; numbers are inspected as `i64` first, then `f64`, else stringified; arrays are transformed by recursively mapping each element; objects are transformed by recursively mapping each value and collecting key-value pairs into a TOML table. It returns the fully converted `TomlValue` tree.

**Call relations**: This is the file’s main exported utility and the target of all tests below. Its recursive self-calls implement deep conversion for arrays and objects.

*Call graph*: 7 external calls (new, Array, Boolean, Float, Integer, String, Table).


##### `tests::json_number_to_toml`  (lines 37–40)

```
fn json_number_to_toml()
```

**Purpose**: Tests that an integer JSON number converts to `TomlValue::Integer`.

**Data flow**: It builds `json!(123)`, passes it to `json_to_toml`, and asserts the result equals `TomlValue::Integer(123)`.

**Call relations**: This unit test invokes the public converter on the integer-number branch to lock in numeric precedence for integral values.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_array_to_toml`  (lines 43–49)

```
fn json_array_to_toml()
```

**Purpose**: Tests recursive conversion of a mixed JSON array into a TOML array.

**Data flow**: It constructs `json!([true, 1])`, converts it, and asserts the result is a `TomlValue::Array` containing `Boolean(true)` and `Integer(1)`.

**Call relations**: This test exercises the array branch and, indirectly, recursive conversion of boolean and integer elements.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_bool_to_toml`  (lines 52–55)

```
fn json_bool_to_toml()
```

**Purpose**: Tests direct boolean conversion from JSON to TOML.

**Data flow**: It creates `json!(false)`, converts it with `json_to_toml`, and asserts the result is `TomlValue::Boolean(false)`.

**Call relations**: This is a focused unit test for the boolean match arm in the converter.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_float_to_toml`  (lines 58–61)

```
fn json_float_to_toml()
```

**Purpose**: Tests that a non-integer JSON number converts to `TomlValue::Float`.

**Data flow**: It builds `json!(1.25)`, converts it, and asserts the result equals `TomlValue::Float(1.25)`.

**Call relations**: This test covers the numeric fallback from integer parsing to floating-point parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_null_to_toml`  (lines 64–67)

```
fn json_null_to_toml()
```

**Purpose**: Tests the crate’s explicit null-mapping policy.

**Data flow**: It uses `serde_json::Value::Null`, converts it, and asserts the result is `TomlValue::String(String::new())`.

**Call relations**: This test documents the intentionally lossy handling of JSON null, which TOML cannot represent natively.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::json_object_nested`  (lines 70–82)

```
fn json_object_nested()
```

**Purpose**: Tests recursive conversion of nested JSON objects into nested TOML tables.

**Data flow**: It constructs `json!({ "outer": { "inner": 2 } })`, manually builds the expected nested `toml::value::Table`, converts the JSON value, and asserts equality.

**Call relations**: This test exercises the object branch and recursive descent through nested maps, confirming key preservation and nested table construction.

*Call graph*: 5 external calls (Integer, Table, assert_eq!, json!, new).


### `utils/cli/src/config_override.rs`

`config` · `CLI argument parsing and config load`

This module provides the reusable CLI-side machinery for ad hoc configuration overrides. `CliConfigOverrides` is a `clap::Parser` fragment whose `raw_overrides: Vec<String>` collects every `-c` / `--config key=value` occurrence without eagerly interpreting either side. `prepend_root_overrides` supports precedence handling by splicing root-level overrides to the front so later subcommand-specific flags win naturally. `parse_overrides` is the main parser: it iterates over each raw string, splits only on the first `=`, trims whitespace, rejects missing or empty keys, and then tries to parse the right-hand side as a TOML value using a sentinel assignment (`_x_ = ...`). If TOML parsing fails, it falls back to a literal string after trimming surrounding single or double quotes. Keys are canonicalized through `canonicalize_override_key`, which currently rewrites the legacy alias `use_legacy_landlock` to `features.use_legacy_landlock`. `apply_on_value` then walks the parsed `(path, value)` pairs and applies each one into a mutable `toml::Value`, creating intermediate `Table` nodes as needed and replacing any existing value at the destination leaf. The implementation treats dotted keys as nested table paths and will overwrite non-table intermediates by replacing them with fresh tables. Tests cover scalar, boolean, array, and inline-table parsing, alias canonicalization, and root-override prepending.

#### Function details

##### `CliConfigOverrides::prepend_root_overrides`  (lines 42–45)

```
fn prepend_root_overrides(&mut self, root_overrides: Self)
```

**Purpose**: Prepends one set of raw overrides ahead of another so the prepended values have lower precedence than later entries. This supports root-level flags being overridden by subcommand-specific flags parsed afterward.

**Data flow**: Takes `&mut self` and `root_overrides: Self`, then splices `root_overrides.raw_overrides` into `self.raw_overrides` at range `0..0`. It mutates `self.raw_overrides` in place and returns no value.

**Call relations**: Higher-level CLI assembly code calls this before final override parsing. It does not parse values itself; it only reorders the raw strings that `parse_overrides` will later consume.

*Call graph*: called by 1 (prepend_config_flags).


##### `CliConfigOverrides::parse_overrides`  (lines 49–84)

```
fn parse_overrides(&self) -> Result<Vec<(String, Value)>, String>
```

**Purpose**: Parses the collected raw `key=value` strings into canonicalized dotted keys and TOML values. It preserves literal strings when TOML parsing fails.

**Data flow**: Reads `self.raw_overrides`, iterates over each string, splits on the first `=`, trims key and value text, errors on missing `=` or empty keys, then tries `parse_toml_value(value_str)`. On success it uses the parsed `toml::Value`; on failure it trims surrounding quotes and wraps the raw text in `Value::String`. Each key is passed through `canonicalize_override_key`, and the function collects the resulting `Vec<(String, Value)>` or returns the first error string encountered.

**Call relations**: Many config-loading and command-execution paths call this as the main interpretation step for CLI overrides. `apply_on_value` builds on it, while this function itself delegates to `parse_toml_value` and `canonicalize_override_key`.

*Call graph*: called by 17 (run_main_with_transport_options, run_command_under_sandbox, load_config, load_exec_server_config, load_config_or_exit, run_add, run_get, run_list, run_login, run_logout (+7 more)).


##### `CliConfigOverrides::apply_on_value`  (lines 89–95)

```
fn apply_on_value(&self, target: &mut Value) -> Result<(), String>
```

**Purpose**: Applies all parsed CLI overrides onto a mutable TOML configuration tree, creating intermediate tables as needed. Later overrides in the parsed list replace earlier values at the same path.

**Data flow**: Takes `&self` and `target: &mut Value`, first calls `self.parse_overrides()?` to obtain `(path, value)` pairs, then iterates through them and passes each into `apply_single_override(target, &path, value)`. It mutates the supplied TOML value tree in place and returns `Ok(())` or a parse error string.

**Call relations**: Callers use this when they already have a mutable config tree and want CLI overrides merged in. It orchestrates parsing plus per-entry application by delegating to `parse_overrides` and `apply_single_override`.

*Call graph*: calls 2 internal fn (parse_overrides, apply_single_override).


##### `canonicalize_override_key`  (lines 98–104)

```
fn canonicalize_override_key(key: &str) -> String
```

**Purpose**: Rewrites legacy or aliased override keys into their canonical dotted-path form. At present it only special-cases `use_legacy_landlock`.

**Data flow**: Reads `key: &str`; if it equals `"use_legacy_landlock"` it returns `"features.use_legacy_landlock".to_string()`, otherwise it returns `key.to_string()`. It has no side effects.

**Call relations**: This helper is called from `CliConfigOverrides::parse_overrides` so all parsed overrides use the same canonical key space before application.


##### `apply_single_override`  (lines 108–148)

```
fn apply_single_override(root: &mut Value, path: &str, value: Value)
```

**Purpose**: Writes one parsed override into a TOML value tree, creating or replacing intermediate tables along the dotted path. It ensures the destination leaf receives the provided value even if existing structure is incompatible.

**Data flow**: Takes `root: &mut Value`, `path: &str`, and `value: Value`, splits the path on `.` into parts, and walks `current` through the tree. For non-final segments, if `current` is a `Value::Table` it uses `entry(...).or_insert_with(|| Value::Table(Table::new()))`; otherwise it replaces `current` with a fresh table and then descends. At the final segment, if `current` is a table it inserts the value under that key; otherwise it replaces `current` with a new one-entry table containing the final key and value.

**Call relations**: Only `CliConfigOverrides::apply_on_value` calls this helper. It is the mutation engine that turns parsed dotted paths into nested TOML table updates.

*Call graph*: called by 1 (apply_on_value); 2 external calls (new, Table).


##### `parse_toml_value`  (lines 150–157)

```
fn parse_toml_value(raw: &str) -> Result<Value, toml::de::Error>
```

**Purpose**: Parses a raw CLI value string as a TOML value by embedding it into a temporary one-key TOML document. This allows reuse of the TOML parser for scalars, arrays, and inline tables.

**Data flow**: Reads `raw: &str`, formats a wrapper string `_x_ = {raw}`, parses it as `toml::Table` with `toml::from_str`, then clones and returns the `_x_` entry. If parsing fails or the sentinel key is missing, it returns a `toml::de::Error`.

**Call relations**: This helper is called by `CliConfigOverrides::parse_overrides` and directly by several unit tests. It isolates the TOML parsing trick from the higher-level override logic.

*Call graph*: called by 4 (parses_array, parses_basic_scalar, parses_bool, parses_inline_table); 2 external calls (format!, from_str).


##### `tests::parses_basic_scalar`  (lines 164–167)

```
fn parses_basic_scalar()
```

**Purpose**: Verifies that a numeric literal is parsed as a TOML integer value. It covers the simplest successful TOML parse case.

**Data flow**: Calls `parse_toml_value("42")`, unwraps the result, reads `as_integer()`, and asserts it equals `Some(42)`. It has no side effects.

**Call relations**: This unit test is run by the harness and directly exercises `parse_toml_value`.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


##### `tests::parses_bool`  (lines 170–176)

```
fn parses_bool()
```

**Purpose**: Checks that boolean literals parse correctly as TOML booleans. It covers both `true` and `false` cases.

**Data flow**: Calls `parse_toml_value("true")` and `parse_toml_value("false")`, unwraps both, reads `as_bool()`, and asserts the expected `Some(true)` and `Some(false)` results. No external state is modified.

**Call relations**: The test harness invokes this to validate boolean parsing through `parse_toml_value`.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


##### `tests::fails_on_unquoted_string`  (lines 179–181)

```
fn fails_on_unquoted_string()
```

**Purpose**: Confirms that a bare unquoted string is not valid TOML in this parsing context. This justifies the higher-level fallback to treating such values as literal strings.

**Data flow**: Calls `parse_toml_value("hello")` and asserts the result is an error. It performs no mutation.

**Call relations**: This test is run by the harness and documents the failure mode that `parse_overrides` intentionally catches and converts into `Value::String`.

*Call graph*: 1 external calls (assert!).


##### `tests::parses_array`  (lines 184–188)

```
fn parses_array()
```

**Purpose**: Verifies that TOML array syntax is accepted and preserved as an array value. It covers a structured non-scalar parse case.

**Data flow**: Calls `parse_toml_value("[1, 2, 3]")`, unwraps the result, reads `as_array()`, and asserts the array length is 3. No external state is changed.

**Call relations**: The test harness invokes this to validate array parsing through the sentinel-document approach.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


##### `tests::canonicalizes_use_legacy_landlock_alias`  (lines 191–198)

```
fn canonicalizes_use_legacy_landlock_alias()
```

**Purpose**: Checks that the legacy override key `use_legacy_landlock` is rewritten to `features.use_legacy_landlock` during parsing. It also confirms the associated value is parsed as a boolean.

**Data flow**: Constructs `CliConfigOverrides` with one raw override string, calls `parse_overrides()`, then inspects the first tuple's key and value and asserts they equal the canonical dotted key and `Some(true)`. It mutates only test-local data.

**Call relations**: This unit test is run by the harness and exercises the interaction between `parse_overrides`, `canonicalize_override_key`, and `parse_toml_value`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::prepends_root_overrides`  (lines 201–216)

```
fn prepends_root_overrides()
```

**Purpose**: Verifies that root overrides are inserted before subcommand overrides in the raw override list. It documents the precedence-ordering behavior without involving parsing.

**Data flow**: Creates two `CliConfigOverrides` values, calls `prepend_root_overrides` on the subcommand one, and asserts the resulting `raw_overrides` vector has the root entry first and the subcommand entry second. No external state is touched.

**Call relations**: The test harness invokes this to validate the list-splicing behavior of `prepend_root_overrides`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parses_inline_table`  (lines 219–224)

```
fn parses_inline_table()
```

**Purpose**: Checks that TOML inline-table syntax parses into a table value with the expected entries. It covers another structured TOML case.

**Data flow**: Calls `parse_toml_value("{a = 1, b = 2}")`, unwraps the result, reads `as_table()`, and asserts the `a` and `b` entries are integers `1` and `2`. It has no side effects.

**Call relations**: This unit test is run by the harness and directly exercises `parse_toml_value` on inline-table input.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


### `utils/cli/src/approval_mode_cli_arg.rs`

`config` · `CLI argument parsing`

This file is a small CLI adapter around approval policy selection. `ApprovalModeCliArg` is a `clap::ValueEnum` with `rename_all = "kebab-case"`, so command-line values map cleanly to variants like `untrusted`, `on-failure`, `on-request`, and `never`. The enum's doc comments are user-facing help text that explains the semantics and notes that `OnFailure` is deprecated in favor of `on-request` or `never` depending on interactivity. The only behavior in the file is the `From<ApprovalModeCliArg> for AskForApproval` implementation, which translates the CLI-specific variants into the protocol-layer enum used elsewhere in the system. The mapping is mostly one-to-one, except `Untrusted` becomes `AskForApproval::UnlessTrusted`, reflecting the protocol's more explicit naming. This separation lets clap derive parsing and help output from a stable CLI type while the rest of the application consumes the shared protocol enum.

#### Function details

##### `AskForApproval::from`  (lines 30–37)

```
fn from(value: ApprovalModeCliArg) -> Self
```

**Purpose**: Converts a parsed CLI approval-mode value into the corresponding protocol-layer `AskForApproval` variant. It bridges clap-facing naming to the internal/shared representation.

**Data flow**: Takes `value: ApprovalModeCliArg`, matches on the enum variant, and returns `AskForApproval::UnlessTrusted`, `OnFailure`, `OnRequest`, or `Never`. It reads no external state and writes nothing.

**Call relations**: This conversion is invoked implicitly wherever code calls `.into()` or `AskForApproval::from(...)` on a parsed CLI value. It is a leaf mapping function with no further delegation.


### `utils/cli/src/sandbox_mode_cli_arg.rs`

`data_model` · `startup`

This file introduces `SandboxModeCliArg`, a small enum derived with `clap::ValueEnum` so Clap can parse `--sandbox` values directly from kebab-case command-line strings. The variants are intentionally data-free mirrors of `codex_protocol::config_types::SandboxMode`: `ReadOnly`, `WorkspaceWrite`, and `DangerFullAccess`. The module-level documentation explains the design constraint: advanced `workspace-write` tuning is not represented here and must instead come from config overrides or config files.

The only behavior is an implementation of `From<SandboxModeCliArg> for SandboxMode`, which performs a one-to-one variant mapping with an exhaustive `match`. There is no fallback or transformation logic beyond preserving the semantic mode choice across the CLI/protocol boundary. Because the enum derives `Clone`, `Copy`, and `Debug`, it is cheap to pass around and easy to inspect in parsed argument structs.

The test asserts each variant maps to the expected protocol enum value, effectively locking in the correspondence between the CLI surface and the protocol configuration type.

#### Function details

##### `SandboxMode::from`  (lines 21–27)

```
fn from(value: SandboxModeCliArg) -> Self
```

**Purpose**: Converts a parsed `SandboxModeCliArg` into the protocol-layer `SandboxMode`. The mapping is direct and exhaustive across all three supported modes.

**Data flow**: It takes `value: SandboxModeCliArg`, matches on the enum variant, and returns the corresponding `codex_protocol::config_types::SandboxMode` variant: `ReadOnly`, `WorkspaceWrite`, or `DangerFullAccess`. It does not read or mutate any external state.

**Call relations**: This conversion is used wherever parsed CLI options need to be translated into protocol/config values. Within this file, the unit test invokes it via `.into()` to verify the mapping.


##### `tests::maps_cli_args_to_protocol_modes`  (lines 36–46)

```
fn maps_cli_args_to_protocol_modes()
```

**Purpose**: Verifies that each CLI enum variant converts to the matching protocol enum variant. This guards against accidental drift between the command-line API and protocol configuration.

**Data flow**: The test applies `.into()` to `SandboxModeCliArg::ReadOnly`, `WorkspaceWrite`, and `DangerFullAccess`, and asserts equality with the corresponding `SandboxMode` values. No shared state is involved.

**Call relations**: It directly exercises the `From<SandboxModeCliArg> for SandboxMode` implementation for all variants.

*Call graph*: 1 external calls (assert_eq!).


### Metadata and schema shaping
These files define small reusable adapters for connector metadata, plugin and skill naming state, mention syntax, and generated JSON schemas.

### `connectors/src/metadata.rs`

`util` · `cross-cutting formatting and ordering of connector metadata`

This file is a compact utility layer over `AppInfo`. `connector_display_label` currently returns the connector’s `name` unchanged, making that field the canonical human-facing label. `connector_mention_slug` derives a mention-safe slug from that display label, and `connector_mention_slug_from_name` exposes the same slugging logic directly from a raw name by delegating to the crate-level `connector_name_slug`. `connector_install_url` similarly re-exports the crate-level URL builder so callers outside `lib.rs` can generate canonical ChatGPT app URLs without depending on private internals.

The one transformation that differs slightly is `sanitize_name`, which slugifies a name and then replaces hyphens with underscores; this is useful where identifier-like formatting is preferred over URL formatting.

The only non-wrapper function with substantive behavior is `sort_connectors_by_accessibility_and_name`. It sorts a mutable slice of `AppInfo` in-place with a stable ordering policy: accessible connectors come first (`right.is_accessible.cmp(&left.is_accessible)`), then names ascending, then IDs ascending as a deterministic tie-breaker. That ordering is reused by merge code so connector lists present installed/accessible apps before merely discoverable ones while still remaining predictable across runs.

#### Function details

##### `connector_display_label`  (lines 3–5)

```
fn connector_display_label(connector: &AppInfo) -> String
```

**Purpose**: Returns the human-facing label used to display a connector.

**Data flow**: Reads `connector: &AppInfo`, clones `connector.name`, and returns the cloned `String`.

**Call relations**: It is used as the first step in mention-slug generation and by UI/message-building code that needs a display label abstraction.

*Call graph*: called by 3 (connector_mention_slug, mention_items, connectors_popup_params).


##### `connector_mention_slug`  (lines 7–9)

```
fn connector_mention_slug(connector: &AppInfo) -> String
```

**Purpose**: Builds a normalized mention slug for a connector based on its display label.

**Data flow**: Accepts `&AppInfo`, obtains the display label via `connector_display_label`, passes that string reference into `connector_mention_slug_from_name`, and returns the resulting slug.

**Call relations**: Mention parsing and rendering flows call this helper so they all derive slugs from the same display-label policy.

*Call graph*: calls 2 internal fn (connector_display_label, connector_mention_slug_from_name); called by 5 (build_connector_slug_counts, collect_explicit_app_ids_from_skill_items, mention_items, submit_user_message_with_history_and_shell_escape_policy, find_app_mentions).


##### `connector_mention_slug_from_name`  (lines 11–13)

```
fn connector_mention_slug_from_name(name: &str) -> String
```

**Purpose**: Converts an arbitrary connector name into the canonical mention slug format.

**Data flow**: Takes `name: &str`, delegates to `crate::connector_name_slug(name)`, and returns the slug string.

**Call relations**: It is the name-based backend for `connector_mention_slug`.

*Call graph*: called by 1 (connector_mention_slug); 1 external calls (connector_name_slug).


##### `connector_install_url`  (lines 15–17)

```
fn connector_install_url(name: &str, connector_id: &str) -> String
```

**Purpose**: Exposes the canonical connector install URL builder from the crate root.

**Data flow**: Accepts `name` and `connector_id`, forwards them to `crate::connector_install_url`, and returns the resulting URL string.

**Call relations**: Merge code and tests call this wrapper when they need install URLs without reaching into the main module’s private helpers.

*Call graph*: called by 4 (merged_app, named_app, merge_connectors, plugin_connector_to_app_info); 1 external calls (connector_install_url).


##### `sanitize_name`  (lines 19–21)

```
fn sanitize_name(name: &str) -> String
```

**Purpose**: Produces an identifier-safe connector name by slugifying and replacing hyphens with underscores.

**Data flow**: Reads `name: &str`, slugifies it with `crate::connector_name_slug`, replaces all `-` characters with `_`, and returns the transformed `String`.

**Call relations**: It is a standalone formatting helper for callers that need underscore-separated names rather than URL slugs.

*Call graph*: 1 external calls (connector_name_slug).


##### `sort_connectors_by_accessibility_and_name`  (lines 23–31)

```
fn sort_connectors_by_accessibility_and_name(connectors: &mut [AppInfo])
```

**Purpose**: Sorts connectors so accessible ones appear first, then orders ties by name and ID.

**Data flow**: Mutably borrows a slice `&mut [AppInfo]`, sorts it in place with a comparator that compares `is_accessible` descending, `name` ascending, and `id` ascending, and returns no value.

**Call relations**: It is the shared ordering primitive used by connector merge functions after they finish assembling and normalizing connector lists.

*Call graph*: called by 2 (merge_connectors, merge_plugin_connectors); 1 external calls (sort_by).


### `core-plugins/src/toggles.rs`

`domain_logic` · `config write handling`

This file centers on one utility, `collect_plugin_enabled_candidates`, that scans an iterator of configuration edits expressed as `(key_path, JsonValue)` pairs and derives a `BTreeMap<String, bool>` keyed by plugin ID. The function recognizes three concrete edit shapes under the `plugins` namespace: a direct leaf write like `plugins.<plugin_id>.enabled = <bool>`, a whole-plugin object write like `plugins.<plugin_id> = { enabled: <bool>, ... }`, and a whole-plugins-table write like `plugins = { <plugin_id>: { enabled: <bool> }, ... }`. For each incoming edit, it splits the dotted key path into owned `String` segments, pattern-matches on the segment slice, and only records values when the JSON shape actually contains a boolean `enabled` field. Non-boolean values, unrelated paths, non-object `plugins` tables, and plugin objects lacking `enabled` are silently ignored.

A notable design choice is that results are accumulated in a `BTreeMap`, giving deterministic ordering and naturally implementing last-write-wins semantics: later edits for the same plugin overwrite earlier entries via `insert`. This matters because callers such as batch and single-write paths can feed mixed edit forms in sequence and rely on the final map to reflect the effective pending toggle state. The included tests document both mixed-shape extraction and overwrite behavior for repeated writes to the same plugin.

#### Function details

##### `collect_plugin_enabled_candidates`  (lines 4–43)

```
fn collect_plugin_enabled_candidates(
    edits: impl Iterator<Item = (&'a String, &'a JsonValue)>,
) -> BTreeMap<String, bool>
```

**Purpose**: Parses a stream of edited configuration paths and JSON values, extracting only plugin `enabled` booleans into a normalized map keyed by plugin ID. It supports direct field writes, whole-plugin object writes, and whole-`plugins` table writes.

**Data flow**: It takes an iterator of `(&String, &serde_json::Value)` edit entries and initializes an empty `BTreeMap<String, bool>`. For each edit, it reads the dotted key path, splits it into `Vec<String>` segments, then matches the segment pattern against supported `plugins` path forms; from the associated JSON value it reads either the boolean directly or an `enabled` field via `get(...).and_then(JsonValue::as_bool)`. Each discovered `(plugin_id, enabled)` pair is inserted into the map, overwriting any prior value for that plugin, and the completed map is returned.

**Call relations**: This function is invoked by both `batch_write_inner` and `write_value` when configuration mutations need to be inspected for plugin toggle changes, and by the two unit tests in this file. Internally it does not delegate to other project functions; its only external interaction is constructing the result map and using `serde_json::Value` accessors to interpret edit payloads.

*Call graph*: called by 4 (batch_write_inner, write_value, collect_plugin_enabled_candidates_tracks_direct_and_table_writes, collect_plugin_enabled_candidates_uses_last_write_for_same_plugin); 1 external calls (new).


##### `tests::collect_plugin_enabled_candidates_tracks_direct_and_table_writes`  (lines 53–80)

```
fn collect_plugin_enabled_candidates_tracks_direct_and_table_writes()
```

**Purpose**: Verifies that the collector recognizes all supported edit shapes in one pass: direct `enabled` writes, whole-plugin object writes, and whole-`plugins` table writes. It also confirms that entries without an `enabled` boolean are ignored.

**Data flow**: The test builds an inline iterator of three edit tuples using `json!`: one direct boolean leaf, one plugin object containing `enabled` plus an unrelated field, and one `plugins` object containing both a valid nested plugin and an invalid one without `enabled`. It passes that iterator to `collect_plugin_enabled_candidates` and compares the returned `BTreeMap` against an expected map containing exactly the three valid plugin toggle results.

**Call relations**: This test calls `collect_plugin_enabled_candidates` directly as a focused specification of accepted input forms. It does not participate in runtime flow; its role is to lock in the extraction behavior and filtering rules during test execution.

*Call graph*: calls 1 internal fn (collect_plugin_enabled_candidates); 2 external calls (assert_eq!, json!).


##### `tests::collect_plugin_enabled_candidates_uses_last_write_for_same_plugin`  (lines 83–99)

```
fn collect_plugin_enabled_candidates_uses_last_write_for_same_plugin()
```

**Purpose**: Checks that repeated edits for the same plugin resolve to the final observed value rather than preserving the first one. This documents the intended overwrite semantics of the accumulator map.

**Data flow**: The test constructs two edits for `sample@test`: first a direct `enabled = true` write, then a whole-plugin object with `enabled = false`. It feeds them in order to `collect_plugin_enabled_candidates` and asserts that the returned `BTreeMap` contains only `sample@test -> false`.

**Call relations**: This test exercises `collect_plugin_enabled_candidates` under a duplicate-plugin scenario to validate the last-write-wins behavior produced by repeated `BTreeMap::insert` calls. Like the other test, it is only executed in the test suite and serves as executable documentation for callers such as write paths.

*Call graph*: calls 1 internal fn (collect_plugin_enabled_candidates); 2 external calls (assert_eq!, json!).


### `core-skills/src/mention_counts.rs`

`util` · `skill catalog preparation`

This file is a tiny utility focused on one concrete transformation: scanning a slice of `SkillMetadata` and tallying how many enabled skills share the same `name`. It maintains two `HashMap<String, usize>` accumulators in parallel. The first preserves the original `skill.name` exactly, which is useful for exact display or exact-match collision checks. The second normalizes each name with `to_ascii_lowercase()`, giving a case-insensitive count for ASCII names without performing full Unicode case folding.

The function explicitly excludes any skill whose `path_to_skills_md` appears in the provided `HashSet<AbsolutePathBuf>` of disabled paths. That means the counts reflect the currently enabled catalog rather than the raw loaded set. Control flow is linear: initialize empty maps, iterate over `skills`, skip disabled entries with `continue`, then increment both counters using `entry(...).or_insert(0) += 1`. The return value is a tuple `(exact_counts, lower_counts)` so callers can choose the appropriate view without recomputing. A subtle design choice is that disabled filtering is path-based, not name-based, so duplicate names among disabled skills do not affect the visible counts at all.

#### Function details

##### `build_skill_name_counts`  (lines 8–24)

```
fn build_skill_name_counts(
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<AbsolutePathBuf>,
) -> (HashMap<String, usize>, HashMap<String, usize>)
```

**Purpose**: Builds two frequency tables for enabled skills: one keyed by the original `SkillMetadata.name` and one keyed by its ASCII-lowercased form. This lets downstream code detect exact duplicates and case-insensitive collisions separately.

**Data flow**: It takes a slice of `SkillMetadata` plus a `HashSet<AbsolutePathBuf>` of disabled `SKILLS.md` paths. For each skill whose `path_to_skills_md` is not in the disabled set, it clones the name into `exact_counts` and inserts the ASCII-lowercased name into `lower_counts`, incrementing each count. It returns both populated `HashMap<String, usize>` values as a tuple and does not mutate external state.

**Call relations**: This is a leaf-style helper: callers provide the already-loaded skills and disabled-path state, and the function performs the counting directly without delegating to other project-local logic.

*Call graph*: 1 external calls (new).


### `ext/memories/src/schema.rs`

`util` · `tool specification construction`

This file is a schema-shaping utility used when publishing memory tools to the Responses API. The public helpers `input_schema_for` and `output_schema_for` are thin wrappers around a shared generator, differing only in whether `Option<T>` fields should emit an explicit JSON `null` type. Inputs disable `option_add_null_type`, which keeps request schemas stricter and avoids advertising `null` as a valid argument value unless the type itself encodes it another way. Outputs enable it so optional response fields can be represented naturally.

The internal `schema_for` function builds a `schemars` generator from `SchemaSettings::draft2019_09()`, mutates the settings to inline subschemas and apply the requested nullability behavior, then generates a root schema for `T`. It serializes that schema to `serde_json::Value` and asserts two invariants: serialization must succeed, and the root schema must be a JSON object. It then constructs a new `Map` containing only a curated subset of top-level keys: `properties`, `required`, `type`, `additionalProperties`, `$defs`, and `definitions`. By stripping metadata and unrelated fields, the function produces a leaner schema payload tailored for tool registration while preserving the structural information needed for argument parsing and output validation.

#### Function details

##### `input_schema_for`  (lines 6–8)

```
fn input_schema_for() -> Value
```

**Purpose**: Builds the JSON Schema used for tool input parameters, without adding `null` to optional-field types.

**Data flow**: It is generic over `T: JsonSchema`, passes `false` into `schema_for`, and returns the resulting `serde_json::Value` unchanged.

**Call relations**: Tool-spec construction uses this for request argument schemas so model-facing parameter definitions stay strict. It is a convenience wrapper over `schema_for`.


##### `output_schema_for`  (lines 10–12)

```
fn output_schema_for() -> Value
```

**Purpose**: Builds the JSON Schema used for tool outputs, allowing optional fields to advertise `null` where appropriate.

**Data flow**: It is generic over `T: JsonSchema`, passes `true` into `schema_for`, and returns the resulting `serde_json::Value`.

**Call relations**: Tool-spec construction uses this for response schemas attached to function tools. Like `input_schema_for`, it simply selects one configuration of `schema_for`.


##### `schema_for`  (lines 14–42)

```
fn schema_for(option_add_null_type: bool) -> Value
```

**Purpose**: Generates a root schema for a Rust type, serializes it to JSON, and trims it down to the subset of top-level keys the tool layer wants to expose.

**Data flow**: It takes a boolean controlling `option_add_null_type`, creates draft-2019-09 schema settings, mutates them to inline subschemas and apply the nullability flag, generates a root schema for `T`, serializes that schema with `serde_json::to_value`, and pattern-matches the result into an object map. It then removes selected keys from the generated object and inserts them into a fresh `Map`, finally returning `Value::Object(tool_schema)`.

**Call relations**: Both `input_schema_for` and `output_schema_for` funnel through this implementation. It delegates schema generation to `schemars` and enforces internal invariants with panic/unreachable paths because malformed generated schemas are treated as programmer errors.

*Call graph*: 5 external calls (new, draft2019_09, Object, to_value, unreachable!).


### `utils/plugins/src/mention_syntax.rs`

`config` · `cross-cutting`

This file is a tiny but important shared syntax definition module. It exports two public `char` constants: `TOOL_MENTION_SIGIL`, set to `$`, and `PLUGIN_TEXT_MENTION_SIGIL`, set to `@`. The accompanying comments clarify the intended semantics: `$` is the default plaintext sigil for tools, while `@` is used for plugins in linked plaintext outside the TUI.

Although there is no executable logic, centralizing these values avoids subtle drift between crates that generate, parse, or display mentions. Any code that tokenizes user text, renders references, or maps plaintext mentions to plugin/tool entities can depend on these constants instead of hard-coding punctuation. The distinction between tool and plugin sigils also documents a design choice in the user-facing syntax: tools and plugins occupy different namespaces in plaintext and are visually differentiated by separate prefix characters. Because these are plain constants, the module is active wherever mention syntax is needed, with no state or side effects.


### Network policy and proxy configuration
This cluster covers the error model, host and domain normalization rules, and the higher-level proxy configuration that validates and applies them.

### `execpolicy/src/error.rs`

`data_model` · `cross-cutting error reporting`

This module centralizes error representation for the execpolicy crate. It introduces lightweight position types—`TextPosition`, `TextRange`, and `ErrorLocation`—that describe a path plus 1-based line/column spans. The main `Error` enum covers invalid decisions, patterns, examples, and rules; example/rule consistency failures with optional attached locations; and wrapped `starlark::Error` values. The exported `Result<T>` alias standardizes use of this error type across parsing and validation code.

The two methods on `Error` are about location propagation and extraction. `with_location` is intentionally selective: it only attaches a provided `ErrorLocation` to `ExampleDidNotMatch` and `ExampleDidMatch` when those variants currently have `location: None`; all other variants, or already-located example errors, are returned unchanged. That preserves original context instead of overwriting it. `location` performs the inverse lookup. For the example mismatch variants it clones and returns the stored location. For `Error::Starlark`, it derives an `ErrorLocation` from the Starlark span by resolving the span and converting begin/end coordinates from zero-based to one-based indexing. All other variants report no location. This design lets callers uniformly ask for source context even when the underlying error originated in different subsystems.

#### Function details

##### `Error::with_location`  (lines 54–76)

```
fn with_location(self, location: ErrorLocation) -> Self
```

**Purpose**: Attaches an `ErrorLocation` to example-mismatch errors that do not already have one. It leaves all other error variants untouched, preserving existing context.

**Data flow**: It consumes `self` and a provided `location: ErrorLocation`. Through pattern matching, it rewrites `Error::ExampleDidNotMatch` and `Error::ExampleDidMatch` only when their `location` field is `None`, returning a new enum value with `Some(location)`. If the variant already has a location or is any other `Error` variant, it returns the original error unchanged.

**Call relations**: This is a utility method for callers that enrich validation errors after construction. It does not call other crate functions; its role is to preserve or add source metadata at error propagation boundaries.


##### `Error::location`  (lines 78–100)

```
fn location(&self) -> Option<ErrorLocation>
```

**Purpose**: Extracts a normalized `ErrorLocation` from an error when one is available directly or can be derived from a wrapped Starlark span. It gives callers a uniform way to retrieve source coordinates.

**Data flow**: It borrows `self` and pattern-matches on the error variant. For `ExampleDidNotMatch` and `ExampleDidMatch`, it clones and returns the stored `Option<ErrorLocation>`. For `Error::Starlark(err)`, it queries `err.span()`, resolves the span if present, and constructs a new `ErrorLocation` with the filename and a `TextRange` whose line and column values are incremented by 1 from the resolved zero-based coordinates. All other variants return `None`.

**Call relations**: This method is used wherever higher layers need to display or serialize source locations for errors. It is self-contained except for consulting the wrapped Starlark error's span metadata.


### `network-proxy/src/policy.rs`

`domain_logic` · `config compilation and per-request host evaluation`

This file turns messy host inputs and user-configured domain patterns into normalized, comparable forms. `Host` is a thin validated wrapper around a normalized host string; `Host::parse` trims whitespace, lowercases DNS names, strips trailing dots, removes brackets around IPv6 literals, and defensively strips `:port` only when there is exactly one colon so unbracketed IPv6 is preserved. Scoped IPv6 literals are normalized so `%25` and `%` forms become a consistent `%scope` representation.

For SSRF-style protections, `is_loopback_host` recognizes `localhost`, loopback IP literals, and scoped IP literals after removing the scope for classification. `is_non_public_ip` delegates to IPv4/IPv6 helpers that treat loopback, RFC1918, link-local, unspecified, multicast, CGNAT, TEST-NET, benchmarking, and reserved ranges as non-public. IPv6-mapped IPv4 addresses are reduced back through the IPv4 classifier.

Pattern handling is split between glob compilation and semantic comparison. `normalize_pattern` preserves leading `*.` or `**.` wildcard prefixes while normalizing the remainder like a host. `compile_globset_with_policy` expands `*.example.com` into `?*.example.com` so the apex does not match, expands `**.example.com` into both `example.com` and `?*.example.com`, deduplicates candidates, and rejects global wildcard patterns for deny lists. Separately, `DomainPattern` parses patterns into `Exact`, `SubdomainsOnly`, or `ApexAndSubdomains` so constraint checks can ask whether one managed pattern semantically allows another without relying on glob syntax internals.

#### Function details

##### `Host::parse`  (lines 21–25)

```
fn parse(input: &str) -> Result<Self>
```

**Purpose**: Normalizes an input host string and rejects the empty result.

**Data flow**: Takes `&str`, passes it through `normalize_host`, checks with `ensure!` that the normalized string is non-empty, and returns `Ok(Host(normalized))` or an error.

**Call relations**: Called by runtime host checks and domain-list mutation paths so later policy logic always works with normalized host strings.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (host_blocked, update_domain_list); 1 external calls (ensure!).


##### `Host::as_str`  (lines 27–29)

```
fn as_str(&self) -> &str
```

**Purpose**: Exposes the normalized inner host string.

**Data flow**: Borrows `self.0` and returns `&str`.

**Call relations**: Used by loopback checks and explicit-local-allowlist matching in runtime policy evaluation.

*Call graph*: called by 2 (is_loopback_host, is_explicit_local_allowlisted).


##### `is_loopback_host`  (lines 33–43)

```
fn is_loopback_host(host: &Host) -> bool
```

**Purpose**: Determines whether a normalized host refers to localhost or a loopback IP literal.

**Data flow**: Reads `host.as_str()`, strips any IPv6 scope with `unscoped_ip_literal`, compares against `localhost`, otherwise parses as `IpAddr` and returns `ip.is_loopback()`, falling back to `false`.

**Call relations**: Called by `NetworkProxyState::host_blocked` as part of local/private-network protection.

*Call graph*: calls 2 internal fn (as_str, unscoped_ip_literal); called by 1 (host_blocked).


##### `is_non_public_ip`  (lines 45–50)

```
fn is_non_public_ip(ip: IpAddr) -> bool
```

**Purpose**: Classifies an IP address as non-public regardless of whether it is IPv4 or IPv6.

**Data flow**: Matches on `IpAddr` and delegates to `is_non_public_ipv4` or `is_non_public_ipv6`, returning the boolean result.

**Call relations**: Used by runtime host checks, DNS-resolution checks, and connection policy enforcement.

*Call graph*: calls 2 internal fn (is_non_public_ipv4, is_non_public_ipv6); called by 3 (connect, host_blocked, host_resolves_to_non_public_ip).


##### `is_non_public_ipv4`  (lines 52–70)

```
fn is_non_public_ipv4(ip: Ipv4Addr) -> bool
```

**Purpose**: Recognizes IPv4 addresses that should be treated as local/internal/non-public for sandboxing.

**Data flow**: Reads an `Ipv4Addr`, checks stdlib predicates (`is_loopback`, `is_private`, `is_link_local`, `is_unspecified`, `is_multicast`, `is_broadcast`) and several explicit CIDR ranges via `ipv4_in_cidr`, then returns whether any match.

**Call relations**: Called directly for IPv4 inputs and indirectly from IPv6 classification for IPv4-mapped addresses.

*Call graph*: calls 1 internal fn (ipv4_in_cidr); called by 2 (is_non_public_ip, is_non_public_ipv6); 6 external calls (is_broadcast, is_link_local, is_loopback, is_multicast, is_private, is_unspecified).


##### `ipv4_in_cidr`  (lines 72–81)

```
fn ipv4_in_cidr(ip: Ipv4Addr, base: [u8; 4], prefix: u8) -> bool
```

**Purpose**: Tests whether an IPv4 address falls within a given CIDR block.

**Data flow**: Converts the IP and base address to `u32`, computes a prefix mask (special-casing prefix 0), compares masked values, and returns the equality result.

**Call relations**: Internal helper used by `is_non_public_ipv4` for ranges not covered by stable stdlib helpers.

*Call graph*: called by 1 (is_non_public_ipv4); 2 external calls (from, from).


##### `is_non_public_ipv6`  (lines 83–98)

```
fn is_non_public_ipv6(ip: Ipv6Addr) -> bool
```

**Purpose**: Recognizes IPv6 addresses that are not globally routable and should be treated as local/internal.

**Data flow**: If the IPv6 address maps to IPv4, delegates to `is_non_public_ipv4(v4)` and also checks IPv6 loopback. Otherwise checks loopback, unspecified, multicast, unique-local, and unicast link-local predicates and returns whether any are true.

**Call relations**: Called by `is_non_public_ip` for IPv6 inputs.

*Call graph*: calls 1 internal fn (is_non_public_ipv4); called by 1 (is_non_public_ip); 6 external calls (is_loopback, is_multicast, is_unicast_link_local, is_unique_local, is_unspecified, to_ipv4).


##### `normalize_host`  (lines 101–119)

```
fn normalize_host(host: &str) -> String
```

**Purpose**: Canonicalizes host fragments for policy matching while preserving unbracketed IPv6 literals.

**Data flow**: Trims whitespace; if the string starts with `[` and contains `]`, extracts the bracketed portion and normalizes it; otherwise, if there is exactly one colon, strips the trailing `:port`; finally delegates to `normalize_dns_host_or_ip_literal`. Returns the normalized `String`.

**Call relations**: This is the central normalization routine used by HTTP/SOCKS handlers, MITM code, host parsing, and pattern normalization.

*Call graph*: calls 1 internal fn (normalize_dns_host_or_ip_literal); called by 12 (http_connect_accept, http_connect_proxy, http_plain_proxy, evaluate_mitm_policy, mitm_stream, evaluate_mitm_hooks, normalize_hook_host, parse, normalize_pattern, host_has_mitm_hooks (+2 more)).


##### `normalize_dns_host_or_ip_literal`  (lines 121–128)

```
fn normalize_dns_host_or_ip_literal(host: &str) -> String
```

**Purpose**: Lowercases DNS names, strips trailing dots, and preserves normalized IP literals including scoped IPv6.

**Data flow**: Lowercases the input, trims trailing `.`, tries `normalize_ip_literal`, and returns either the normalized IP string or the lowercased hostname.

**Call relations**: Used only by `normalize_host` after bracket/port handling.

*Call graph*: calls 1 internal fn (normalize_ip_literal); called by 1 (normalize_host).


##### `unscoped_ip_literal`  (lines 130–134)

```
fn unscoped_ip_literal(host: &str) -> Option<&str>
```

**Purpose**: Extracts the IP portion of a scoped IP literal if the prefix parses as an IP address.

**Data flow**: Splits the host once on `%`; if present and the left side parses as `IpAddr`, returns `Some(ip_part)`, otherwise `None`.

**Call relations**: Used by loopback checks and runtime matching so scoped IPv6 literals can be compared against unscoped allow/deny entries.

*Call graph*: called by 4 (is_loopback_host, host_blocked, globset_matches_host_or_unscoped, is_explicit_local_allowlisted).


##### `normalize_ip_literal`  (lines 136–148)

```
fn normalize_ip_literal(host: &str) -> Option<String>
```

**Purpose**: Normalizes plain or scoped IP literals into a consistent string representation.

**Data flow**: If the whole host parses as `IpAddr`, returns it unchanged as `String`. Otherwise tries delimiters `%25` and `%`; when the left side parses as an IP, returns `format!("{ip}%{scope}")`. Returns `None` if the input is not an IP literal.

**Call relations**: Called by `normalize_dns_host_or_ip_literal` to preserve IP literals rather than treating them as ordinary hostnames.

*Call graph*: called by 1 (normalize_dns_host_or_ip_literal); 1 external calls (format!).


##### `normalize_pattern`  (lines 150–170)

```
fn normalize_pattern(pattern: &str) -> String
```

**Purpose**: Normalizes a configured domain pattern while preserving supported wildcard prefixes.

**Data flow**: Trims the pattern, returns `*` unchanged for the global wildcard, strips and remembers a leading `**.` or `*.` prefix if present, normalizes the remainder with `normalize_host`, then reattaches the prefix if needed.

**Call relations**: Used before wildcard detection and glob compilation so pattern matching is case-insensitive and trailing-dot tolerant.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (compile_globset_with_policy, is_global_wildcard_domain_pattern); 1 external calls (format!).


##### `is_global_wildcard_domain_pattern`  (lines 172–177)

```
fn is_global_wildcard_domain_pattern(pattern: &str) -> bool
```

**Purpose**: Detects whether a pattern semantically expands to a global wildcard match.

**Data flow**: Normalizes the pattern, expands it with `expand_domain_pattern`, and returns true if any expanded candidate equals `*`.

**Call relations**: Used to reject unsupported global wildcard patterns in deny lists and managed constraints.

*Call graph*: calls 2 internal fn (expand_domain_pattern, normalize_pattern); called by 1 (compile_globset_with_policy).


##### `compile_allowlist_globset`  (lines 185–187)

```
fn compile_allowlist_globset(patterns: &[String]) -> Result<GlobSet>
```

**Purpose**: Compiles allowlist patterns into a `GlobSet`, permitting explicit global wildcard patterns.

**Data flow**: Passes the pattern slice and `GlobalWildcard::Allow` to `compile_globset_with_policy` and returns the resulting `GlobSet` or error.

**Call relations**: Called when building runtime config state and in tests validating allowlist behavior.

*Call graph*: calls 1 internal fn (compile_globset_with_policy); called by 3 (network_proxy_state_for_policy, compile_globset_allows_global_wildcard_when_enabled, build_config_state).


##### `compile_denylist_globset`  (lines 189–191)

```
fn compile_denylist_globset(patterns: &[String]) -> Result<GlobSet>
```

**Purpose**: Compiles denylist patterns into a `GlobSet`, rejecting global wildcard patterns.

**Data flow**: Delegates to `compile_globset_with_policy` with `GlobalWildcard::Reject`.

**Call relations**: Used during config-state construction and by tests covering denylist normalization and validation.

*Call graph*: calls 1 internal fn (compile_globset_with_policy); called by 12 (compile_globset_normalizes_apex_and_subdomains, compile_globset_normalizes_bracketed_ipv6_literals, compile_globset_normalizes_trailing_dots, compile_globset_normalizes_wildcards, compile_globset_preserves_scoped_ipv6_literals, compile_globset_supports_mid_label_wildcards, network_proxy_state_for_policy, compile_globset_dedupes_patterns_without_changing_behavior, compile_globset_excludes_apex_for_subdomain_patterns, compile_globset_includes_apex_for_double_wildcard_patterns (+2 more)).


##### `compile_globset_with_policy`  (lines 193–223)

```
fn compile_globset_with_policy(
    patterns: &[String],
    global_wildcard: GlobalWildcard,
) -> Result<GlobSet>
```

**Purpose**: Normalizes, validates, expands, deduplicates, and compiles domain patterns into a case-insensitive `GlobSet` under either allowlist or denylist wildcard rules.

**Data flow**: Creates a `GlobSetBuilder` and `HashSet` of seen candidates. For each input pattern, optionally rejects global wildcards, normalizes it, expands it into one or more concrete glob candidates, skips duplicates, builds each candidate with `GlobBuilder::case_insensitive(true)`, adds it to the builder, then builds and returns the final `GlobSet`.

**Call relations**: Shared implementation behind both allowlist and denylist compilation.

*Call graph*: calls 3 internal fn (expand_domain_pattern, is_global_wildcard_domain_pattern, normalize_pattern); called by 2 (compile_allowlist_globset, compile_denylist_globset); 4 external calls (new, new, new, bail!).


##### `DomainPattern::parse`  (lines 237–249)

```
fn parse(input: &str) -> Self
```

**Purpose**: Parses a pattern into a semantic wildcard form without validating domain syntax.

**Data flow**: Trims input, returns `Exact("")` for empty strings, recognizes `**.` as `ApexAndSubdomains`, `*.` as `SubdomainsOnly`, and otherwise returns `Exact(input.to_string())`, using `parse_domain` for wildcard cases.

**Call relations**: Used by `expand_domain_pattern` to interpret wildcard prefixes cheaply.

*Call graph*: called by 1 (expand_domain_pattern); 3 external calls (Exact, parse_domain, new).


##### `DomainPattern::parse_for_constraints`  (lines 252–264)

```
fn parse_for_constraints(input: &str) -> Self
```

**Purpose**: Parses a pattern for managed-constraint comparisons while validating domain-like inputs through `url::Host` parsing.

**Data flow**: Trims input, handles empty strings, recognizes `**.` and `*.` prefixes, normalizes the remainder with `parse_domain_for_constraints`, and returns the corresponding `DomainPattern` variant.

**Call relations**: Used by constraint validation to compare candidate patterns against managed baselines semantically.

*Call graph*: calls 1 internal fn (parse_domain_for_constraints); 4 external calls (ApexAndSubdomains, Exact, SubdomainsOnly, new).


##### `DomainPattern::parse_domain`  (lines 266–272)

```
fn parse_domain(domain: &str, build: impl FnOnce(String) -> Self) -> Self
```

**Purpose**: Helper for wildcard parsing that trims the domain portion and collapses empty wildcard domains to `Exact("")`.

**Data flow**: Trims the domain string; if empty returns `Exact(String::new())`, otherwise applies the supplied constructor to `domain.to_string()`.

**Call relations**: Internal helper used by `DomainPattern::parse`.

*Call graph*: 2 external calls (Exact, new).


##### `DomainPattern::allows`  (lines 274–299)

```
fn allows(&self, candidate: &DomainPattern) -> bool
```

**Purpose**: Determines whether one semantic domain pattern permits another exact or wildcard candidate pattern.

**Data flow**: Matches on `self` and `candidate`, then uses `domain_eq`, `is_strict_subdomain`, or `is_subdomain_or_equal` to decide whether the candidate is equal to or narrower than the managed pattern. Returns a boolean.

**Call relations**: Used by managed-constraint validation to ensure user-supplied allowlist entries do not widen the managed baseline.

*Call graph*: calls 3 internal fn (domain_eq, is_strict_subdomain, is_subdomain_or_equal).


##### `parse_domain_for_constraints`  (lines 302–319)

```
fn parse_domain_for_constraints(domain: &str) -> String
```

**Purpose**: Normalizes a domain string for constraint comparison, validating ordinary host syntax while preserving wildcard-like or scoped forms as-is.

**Data flow**: Trims whitespace and trailing dots, strips surrounding brackets if present, returns the original domain when it contains `*`, `?`, or `%`, otherwise tries `UrlHost::parse(host)` and returns its normalized string or an empty string on parse failure.

**Call relations**: Called by `DomainPattern::parse_for_constraints`.

*Call graph*: called by 1 (parse_for_constraints); 2 external calls (new, parse).


##### `expand_domain_pattern`  (lines 321–331)

```
fn expand_domain_pattern(pattern: &str) -> Vec<String>
```

**Purpose**: Expands a semantic domain pattern into one or more glob candidates used by `globset`.

**Data flow**: Parses the pattern with `DomainPattern::parse`; returns `[domain]` for exact patterns, `["?*.{domain}"]` for subdomains-only patterns, and `[domain, "?*.{domain}"]` for apex-and-subdomains patterns.

**Call relations**: Used by wildcard detection and globset compilation.

*Call graph*: calls 1 internal fn (parse); called by 2 (compile_globset_with_policy, is_global_wildcard_domain_pattern); 1 external calls (vec!).


##### `normalize_domain`  (lines 333–335)

```
fn normalize_domain(domain: &str) -> String
```

**Purpose**: Canonicalizes a domain string for equality/subdomain comparisons.

**Data flow**: Strips trailing dots and lowercases ASCII characters, returning the normalized `String`.

**Call relations**: Shared helper for exact and subdomain comparison functions.

*Call graph*: called by 3 (domain_eq, is_strict_subdomain, is_subdomain_or_equal).


##### `domain_eq`  (lines 337–339)

```
fn domain_eq(left: &str, right: &str) -> bool
```

**Purpose**: Performs case-insensitive, trailing-dot-insensitive domain equality.

**Data flow**: Normalizes both inputs with `normalize_domain` and compares the resulting strings.

**Call relations**: Used by `DomainPattern::allows` for exact-pattern comparisons.

*Call graph*: calls 1 internal fn (normalize_domain); called by 1 (allows).


##### `is_subdomain_or_equal`  (lines 341–348)

```
fn is_subdomain_or_equal(child: &str, parent: &str) -> bool
```

**Purpose**: Checks whether one domain is equal to or a descendant of another.

**Data flow**: Normalizes child and parent, returns true if equal, otherwise checks whether the child ends with `.{parent}`.

**Call relations**: Used by `DomainPattern::allows` for apex-inclusive wildcard semantics.

*Call graph*: calls 1 internal fn (normalize_domain); called by 1 (allows); 1 external calls (format!).


##### `is_strict_subdomain`  (lines 350–354)

```
fn is_strict_subdomain(child: &str, parent: &str) -> bool
```

**Purpose**: Checks whether one domain is a proper subdomain of another, excluding equality.

**Data flow**: Normalizes child and parent and returns true only if they differ and the child ends with `.{parent}`.

**Call relations**: Used by `DomainPattern::allows` for `*.example.com` semantics where the apex must not match.

*Call graph*: calls 1 internal fn (normalize_domain); called by 1 (allows); 1 external calls (format!).


##### `tests::method_allowed_full_allows_everything`  (lines 363–367)

```
fn method_allowed_full_allows_everything()
```

**Purpose**: Verifies that full network mode permits representative HTTP methods including CONNECT.

**Data flow**: Calls `NetworkMode::Full.allows_method(...)` for several methods and asserts each result is true.

**Call relations**: Regression test for method-policy behavior defined elsewhere but exercised from this module.

*Call graph*: 1 external calls (assert!).


##### `tests::method_allowed_limited_allows_only_safe_methods`  (lines 370–376)

```
fn method_allowed_limited_allows_only_safe_methods()
```

**Purpose**: Verifies that limited mode allows safe methods and rejects mutating/tunneling methods.

**Data flow**: Checks `GET`, `HEAD`, and `OPTIONS` are allowed and `POST` and `CONNECT` are rejected.

**Call relations**: Documents the expected method policy used by HTTP/SOCKS guards.

*Call graph*: 1 external calls (assert!).


##### `tests::compile_globset_normalizes_trailing_dots`  (lines 379–384)

```
fn compile_globset_normalizes_trailing_dots()
```

**Purpose**: Confirms denylist compilation strips trailing dots and lowercases hostnames.

**Data flow**: Builds a deny globset from `Example.COM.`, then asserts it matches `example.com` but not `api.example.com`.

**Call relations**: Covers normalization behavior in `compile_denylist_globset`.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_normalizes_wildcards`  (lines 387–392)

```
fn compile_globset_normalizes_wildcards()
```

**Purpose**: Checks wildcard deny patterns are normalized and still exclude the apex.

**Data flow**: Compiles `*.Example.COM.` and asserts it matches `api.example.com` but not `example.com`.

**Call relations**: Exercises wildcard-prefix preservation in `normalize_pattern` and expansion logic.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_supports_mid_label_wildcards`  (lines 395–402)

```
fn compile_globset_supports_mid_label_wildcards()
```

**Purpose**: Verifies ordinary glob wildcards inside labels are preserved by compilation.

**Data flow**: Compiles `region*.v2.argotunnel.com` and asserts matching/non-matching host examples.

**Call relations**: Shows that only leading `*.`/`**.` receive special semantic handling; other glob syntax is passed through.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_normalizes_apex_and_subdomains`  (lines 405–410)

```
fn compile_globset_normalizes_apex_and_subdomains()
```

**Purpose**: Checks `**.` patterns match both the apex and subdomains after normalization.

**Data flow**: Compiles `**.Example.COM.` and asserts matches for `example.com` and `api.example.com`.

**Call relations**: Covers the dual-candidate expansion in `expand_domain_pattern`.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_normalizes_bracketed_ipv6_literals`  (lines 413–417)

```
fn compile_globset_normalizes_bracketed_ipv6_literals()
```

**Purpose**: Verifies bracketed IPv6 literals are normalized before glob matching.

**Data flow**: Compiles `[::1]` and asserts the resulting set matches `::1`.

**Call relations**: Tests host normalization for IP literals inside pattern compilation.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_preserves_scoped_ipv6_literals`  (lines 420–426)

```
fn compile_globset_preserves_scoped_ipv6_literals()
```

**Purpose**: Checks scoped IPv6 literals retain their scope and normalize `%25` encoding.

**Data flow**: Compiles `[fe80::1%25lo0]` and asserts it matches `fe80::1%lo0` but not a different scope or the unscoped literal.

**Call relations**: Documents the exact-scope matching behavior of normalized IP literals.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::is_loopback_host_handles_localhost_variants`  (lines 429–434)

```
fn is_loopback_host_handles_localhost_variants()
```

**Purpose**: Verifies localhost names are recognized case-insensitively and with trailing dots.

**Data flow**: Parses several host strings into `Host` and asserts loopback classification results.

**Call relations**: Covers `Host::parse` normalization plus `is_loopback_host` logic.

*Call graph*: 1 external calls (assert!).


##### `tests::is_loopback_host_handles_ip_literals`  (lines 437–441)

```
fn is_loopback_host_handles_ip_literals()
```

**Purpose**: Verifies loopback classification for IPv4 and IPv6 literals.

**Data flow**: Parses IP literal hosts and asserts loopback/non-loopback outcomes.

**Call relations**: Regression test for IP parsing inside `is_loopback_host`.

*Call graph*: 1 external calls (assert!).


##### `tests::is_non_public_ip_rejects_private_and_loopback_ranges`  (lines 444–465)

```
fn is_non_public_ip_rejects_private_and_loopback_ranges()
```

**Purpose**: Checks the non-public IP classifier across many IPv4, IPv6, and IPv4-mapped IPv6 ranges.

**Data flow**: Parses representative addresses and asserts expected true/false results for private, loopback, CGNAT, test-net, reserved, and public addresses.

**Call relations**: Documents the security-sensitive address ranges treated as local/internal.

*Call graph*: 1 external calls (assert!).


##### `tests::normalize_host_lowercases_and_trims`  (lines 468–470)

```
fn normalize_host_lowercases_and_trims()
```

**Purpose**: Verifies basic whitespace trimming and lowercasing.

**Data flow**: Calls `normalize_host` on a mixed-case padded hostname and asserts the normalized string.

**Call relations**: Simple unit test for the main normalization entry point.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_port_for_host_port`  (lines 473–475)

```
fn normalize_host_strips_port_for_host_port()
```

**Purpose**: Checks that a single `:port` suffix is removed from ordinary hostnames.

**Data flow**: Normalizes `example.com:1234` and asserts the result is `example.com`.

**Call relations**: Covers the defensive host:port stripping branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_preserves_unbracketed_ipv6`  (lines 478–480)

```
fn normalize_host_preserves_unbracketed_ipv6()
```

**Purpose**: Ensures unbracketed IPv6 literals are not mangled by the single-colon host:port heuristic.

**Data flow**: Normalizes `2001:db8::1` and asserts it is unchanged.

**Call relations**: Protects the invariant that IPv6 literals survive normalization intact.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_trailing_dot`  (lines 483–486)

```
fn normalize_host_strips_trailing_dot()
```

**Purpose**: Verifies fully qualified domain names normalize to their dotless lowercase form.

**Data flow**: Normalizes dotted mixed-case hostnames and asserts the trailing dot is removed.

**Call relations**: Covers DNS-name normalization behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_trailing_dot_with_port`  (lines 489–491)

```
fn normalize_host_strips_trailing_dot_with_port()
```

**Purpose**: Checks that trailing-dot hostnames still normalize correctly when a port is present.

**Data flow**: Normalizes `example.com.:443` and asserts the result is `example.com`.

**Call relations**: Exercises combined host:port stripping and trailing-dot normalization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_brackets_for_ipv6`  (lines 494–497)

```
fn normalize_host_strips_brackets_for_ipv6()
```

**Purpose**: Verifies bracketed IPv6 literals normalize to bare literals, with or without a port suffix.

**Data flow**: Normalizes `[::1]` and `[::1]:443` and asserts both become `::1`.

**Call relations**: Covers the bracket-handling branch in `normalize_host`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_preserves_ipv6_scope_ids`  (lines 500–504)

```
fn normalize_host_preserves_ipv6_scope_ids()
```

**Purpose**: Checks that scoped IPv6 literals preserve their scope and normalize `%25` encoding.

**Data flow**: Normalizes scoped literals in bare and bracketed forms and asserts the canonical `%scope` output.

**Call relations**: Regression test for scoped IPv6 normalization used by allow/deny matching.

*Call graph*: 1 external calls (assert_eq!).


### `network-proxy/src/config.rs`

`config` · `config load and startup validation`

This file is the proxy’s configuration model plus the logic that interprets it. `NetworkProxyConfig` wraps `NetworkProxySettings`, whose defaults describe a disabled local proxy listening on loopback HTTP and SOCKS ports, with upstream proxying enabled, MITM disabled, and no domain or unix-socket exceptions. Domain policy is represented as ordered `NetworkDomainPermissionEntry` values, but serialization collapses duplicates into an effective map where enum ordering (`None < Allow < Deny`) makes deny win over allow for the same pattern. That precedence is preserved by `effective_entries`, which keeps first-seen pattern order while upgrading the stored permission when a stronger duplicate appears.

The file also provides mutators for allowed/denied domains and allowed unix sockets. These methods intentionally preserve opposite-permission entries, deduplicate exact duplicates, and drop the optional wrapper back to `None` when no entries remain. `NetworkMode` encodes the HTTP method policy: full mode allows everything, limited mode only GET/HEAD/OPTIONS.

Runtime resolution is safety-focused. `resolve_runtime` validates every allowlisted unix-socket path as absolute, parses proxy URLs or loose host:port strings into `SocketAddr`s, maps `localhost` and unresolved hostnames to loopback, and then clamps non-loopback bind addresses unless explicitly allowed. Even when non-loopback binding is enabled, unix-socket proxying forces both listeners back to loopback to avoid exposing local-daemon access remotely. The host/port parser handles URL-like inputs, strips userinfo, preserves unbracketed IPv6 literals, and falls back carefully when URL parsing fails.

#### Function details

##### `NetworkDomainPermissions::serialize`  (lines 46–55)

```
fn serialize(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
```

**Purpose**: Serializes domain permissions as a map from pattern to effective permission rather than preserving raw duplicate entries. This ensures persisted config reflects the deny-wins semantics users actually experience.

**Data flow**: It takes `&self` and a Serde serializer. It computes `self.effective_entries()`, converts those entries into a `BTreeMap<String, NetworkDomainPermission>`, and serializes that map.

**Call relations**: Serde invokes this when writing config. It depends on `effective_entries` so duplicate raw entries collapse into a single visible permission per pattern.

*Call graph*: calls 1 internal fn (effective_entries).


##### `NetworkDomainPermissions::deserialize`  (lines 59–71)

```
fn deserialize(deserializer: D) -> std::result::Result<Self, D::Error>
```

**Purpose**: Deserializes domain permissions from a simple map shape into the internal entry-vector representation.

**Data flow**: It takes a Serde deserializer, reads a `BTreeMap<String, NetworkDomainPermission>`, maps each pair into `NetworkDomainPermissionEntry { pattern, permission }`, collects them into `entries`, and returns `NetworkDomainPermissions { entries }`.

**Call relations**: Serde uses this when loading config. It reconstructs the internal list form expected by the rest of the file.

*Call graph*: 1 external calls (deserialize).


##### `NetworkDomainPermissions::effective_entries`  (lines 75–103)

```
fn effective_entries(&self) -> Vec<NetworkDomainPermissionEntry>
```

**Purpose**: Computes the effective permission list after resolving duplicate patterns with precedence rules while preserving first-seen pattern order.

**Data flow**: It reads `self.entries`, tracks first occurrence order in a `Vec<String>`, stores strongest permission per pattern in a `BTreeMap`, upgrades an existing permission when a later entry has a larger enum value, then emits `NetworkDomainPermissionEntry` values in original pattern order using the final effective permission.

**Call relations**: Serialization and domain filtering rely on this helper to present the actual policy rather than raw historical edits.

*Call graph*: called by 1 (serialize); 2 external calls (new, new).


##### `NetworkProxySettings::default`  (lines 149–166)

```
fn default() -> Self
```

**Purpose**: Constructs the baseline local-use proxy configuration with conservative safety defaults and no explicit allowlists.

**Data flow**: It returns a `NetworkProxySettings` with fixed booleans and URLs: disabled proxy, loopback HTTP/SOCKS URLs, SOCKS enabled, upstream proxying allowed, non-loopback and broad unix-socket access disabled, mode `Full`, no domain or unix-socket entries, local binding disabled, MITM disabled, and empty MITM hooks.

**Call relations**: Many tests and runtime builders start from this baseline and then override only the fields relevant to the scenario under test.

*Call graph*: calls 2 internal fn (default_proxy_url, default_socks_url); called by 50 (network_domain_permissions_serialize_to_effective_map_shape, partial_network_config_uses_struct_defaults_for_missing_fields, set_allowed_domains_preserves_existing_deny_for_same_pattern, settings_with_unix_sockets, direct_connector_allows_non_public_target_when_local_binding_enabled, direct_connector_rejects_non_public_target_when_local_binding_disabled, http_connect_accept_allows_allowlisted_host_in_full_mode, http_connect_accept_blocks_in_limited_mode, http_connect_accept_denies_denylisted_host, http_plain_proxy_attempts_allowed_unix_socket_proxy (+15 more)); 2 external calls (new, default).


##### `NetworkProxySettings::allowed_domains`  (lines 170–172)

```
fn allowed_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Returns the effective allowlisted domain patterns, if any exist.

**Data flow**: It takes `&self`, delegates to `domain_entries(NetworkDomainPermission::Allow)`, and returns `Option<Vec<String>>`.

**Call relations**: Higher-level policy code uses this accessor when it needs only allow entries rather than the full mixed permission structure.

*Call graph*: calls 1 internal fn (domain_entries); called by 2 (entries, opposite_entries).


##### `NetworkProxySettings::denied_domains`  (lines 174–176)

```
fn denied_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Returns the effective denylisted domain patterns, if any exist.

**Data flow**: It takes `&self`, delegates to `domain_entries(NetworkDomainPermission::Deny)`, and returns `Option<Vec<String>>`.

**Call relations**: This is the deny-side counterpart to `allowed_domains`, used by policy consumers that need explicit blocked patterns.

*Call graph*: calls 1 internal fn (domain_entries); called by 2 (entries, opposite_entries).


##### `NetworkProxySettings::domain_entries`  (lines 178–190)

```
fn domain_entries(&self, permission: NetworkDomainPermission) -> Option<Vec<String>>
```

**Purpose**: Filters the effective domain-permission set down to patterns with a specific permission and suppresses empty results.

**Data flow**: It takes `&self` and a `NetworkDomainPermission`. If `self.domains` is present, it computes `effective_entries()`, filters entries whose permission matches the requested one, clones their patterns into a `Vec<String>`, and returns `Some(vec)` only when non-empty.

**Call relations**: Both `allowed_domains` and `denied_domains` are thin wrappers around this helper.

*Call graph*: called by 2 (allowed_domains, denied_domains).


##### `NetworkProxySettings::allow_unix_sockets`  (lines 192–206)

```
fn allow_unix_sockets(&self) -> Vec<String>
```

**Purpose**: Extracts the configured unix-socket allowlist paths from the flattened permission map.

**Data flow**: It takes `&self`, reads `self.unix_sockets`, filters entries whose permission is `Allow`, clones the path keys into a `Vec<String>`, and returns an empty vector when no unix-socket config exists.

**Call relations**: Bind-address clamping and unix-socket validation use this accessor to decide whether local-daemon proxying is enabled.

*Call graph*: called by 1 (clamp_bind_addrs).


##### `NetworkProxySettings::set_allowed_domains`  (lines 208–210)

```
fn set_allowed_domains(&mut self, allowed_domains: Vec<String>)
```

**Purpose**: Replaces all current allow entries with the provided patterns while preserving deny entries.

**Data flow**: It takes `&mut self` and `allowed_domains: Vec<String>`, then forwards to `set_domain_entries(..., Allow)`.

**Call relations**: Tests and config mutation paths call this when constructing or updating allowlists.

*Call graph*: calls 1 internal fn (set_domain_entries).


##### `NetworkProxySettings::set_denied_domains`  (lines 212–214)

```
fn set_denied_domains(&mut self, denied_domains: Vec<String>)
```

**Purpose**: Replaces all current deny entries with the provided patterns while preserving allow entries.

**Data flow**: It takes `&mut self` and `denied_domains: Vec<String>`, then forwards to `set_domain_entries(..., Deny)`.

**Call relations**: This is the deny-side counterpart to `set_allowed_domains`.

*Call graph*: calls 1 internal fn (set_domain_entries).


##### `NetworkProxySettings::upsert_domain_permission`  (lines 216–232)

```
fn upsert_domain_permission(
        &mut self,
        host: String,
        permission: NetworkDomainPermission,
        normalize: impl Fn(&str) -> String,
    )
```

**Purpose**: Adds or replaces a single domain permission after normalizing patterns for equality comparison. It is designed for interactive updates where equivalent host spellings should overwrite each other.

**Data flow**: It takes `&mut self`, `host: String`, a `permission`, and a normalization closure. It removes any existing entries whose normalized pattern matches the normalized new host, pushes a new `NetworkDomainPermissionEntry { pattern: host, permission }`, and stores `Some(domains)` only if entries remain.

**Call relations**: This function is used by callers that need one-at-a-time edits rather than wholesale replacement lists.


##### `NetworkProxySettings::set_allow_unix_sockets`  (lines 234–236)

```
fn set_allow_unix_sockets(&mut self, allow_unix_sockets: Vec<String>)
```

**Purpose**: Replaces all current allowed unix-socket paths with the provided list.

**Data flow**: It takes `&mut self` and `allow_unix_sockets: Vec<String>`, then delegates to `set_unix_socket_entries(..., Allow)`.

**Call relations**: Tests and config-building code use this helper to populate the unix-socket allowlist.

*Call graph*: calls 1 internal fn (set_unix_socket_entries).


##### `NetworkProxySettings::set_domain_entries`  (lines 238–256)

```
fn set_domain_entries(&mut self, entries: Vec<String>, permission: NetworkDomainPermission)
```

**Purpose**: Rewrites all entries for one domain-permission class while leaving opposite-permission entries intact and avoiding exact duplicates.

**Data flow**: It takes `&mut self`, `entries: Vec<String>`, and a `permission`. It removes existing entries with that permission, then for each new pattern pushes a `NetworkDomainPermissionEntry` only if an identical pattern/permission pair is not already present. Finally it stores `None` if the resulting list is empty.

**Call relations**: Both `set_allowed_domains` and `set_denied_domains` funnel through this helper.

*Call graph*: called by 2 (set_allowed_domains, set_denied_domains).


##### `NetworkProxySettings::set_unix_socket_entries`  (lines 258–271)

```
fn set_unix_socket_entries(
        &mut self,
        entries: Vec<String>,
        permission: NetworkUnixSocketPermission,
    )
```

**Purpose**: Rewrites all unix-socket entries for one permission class and stores them in the flattened map representation.

**Data flow**: It takes `&mut self`, `entries: Vec<String>`, and a `NetworkUnixSocketPermission`. It removes existing map entries with that permission, inserts each provided path with the new permission, and stores `None` if the map ends up empty.

**Call relations**: Currently `set_allow_unix_sockets` is the public wrapper that uses this helper.

*Call graph*: called by 1 (set_allow_unix_sockets).


##### `NetworkMode::allows_method`  (lines 288–293)

```
fn allows_method(self, method: &str) -> bool
```

**Purpose**: Encodes the proxy’s HTTP method policy for full versus limited network mode.

**Data flow**: It takes `self` and `method: &str`. In `Full` mode it returns `true` for any method; in `Limited` mode it returns `true` only for `GET`, `HEAD`, or `OPTIONS`.

**Call relations**: HTTP and MITM request paths consult this method when enforcing limited-mode restrictions.

*Call graph*: 1 external calls (matches!).


##### `default_proxy_url`  (lines 296–298)

```
fn default_proxy_url() -> String
```

**Purpose**: Supplies the default HTTP proxy listener URL.

**Data flow**: It returns the fixed string `http://127.0.0.1:3128`.

**Call relations**: Used only by `NetworkProxySettings::default`.

*Call graph*: called by 1 (default).


##### `default_socks_url`  (lines 300–302)

```
fn default_socks_url() -> String
```

**Purpose**: Supplies the default SOCKS5 proxy listener URL.

**Data flow**: It returns the fixed string `http://127.0.0.1:8081`.

**Call relations**: Used only by `NetworkProxySettings::default`.

*Call graph*: called by 1 (default).


##### `clamp_non_loopback`  (lines 305–325)

```
fn clamp_non_loopback(
    addr: SocketAddr,
    allow_non_loopback: bool,
    name: &str,
    override_setting_name: &str,
) -> SocketAddr
```

**Purpose**: For a single listener address, either preserves a loopback bind, allows a dangerous non-loopback bind with a warning, or rewrites it to loopback with the same port.

**Data flow**: It takes `addr: SocketAddr`, `allow_non_loopback: bool`, and descriptive names. If `addr.ip().is_loopback()` it returns the address unchanged. If non-loopback is explicitly allowed it logs a dangerous warning and returns the original address. Otherwise it warns and returns `127.0.0.1:<same port>`.

**Call relations**: Called by `clamp_bind_addrs` for both HTTP and SOCKS listener addresses.

*Call graph*: called by 1 (clamp_bind_addrs); 4 external calls (from, ip, port, warn!).


##### `clamp_bind_addrs`  (lines 327–366)

```
fn clamp_bind_addrs(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    cfg: &NetworkProxySettings,
) -> (SocketAddr, SocketAddr)
```

**Purpose**: Applies bind-address safety rules to both HTTP and SOCKS listeners, with an extra hard clamp when unix-socket proxying is enabled.

**Data flow**: It takes `http_addr`, `socks_addr`, and `cfg: &NetworkProxySettings`. It first clamps each address individually via `clamp_non_loopback`. If no unix sockets are allowlisted and `dangerously_allow_all_unix_sockets` is false, it returns those results. Otherwise it warns that unix-socket proxying overrides dangerous non-loopback settings and returns both addresses rewritten to `127.0.0.1` with their original ports.

**Call relations**: Runtime resolution and some builder paths call this after parsing configured listener URLs. It depends on `allow_unix_sockets()` to detect whether local-daemon proxying is active.

*Call graph*: calls 2 internal fn (allow_unix_sockets, clamp_non_loopback); called by 5 (resolve_runtime, clamp_bind_addrs_allows_non_loopback_when_enabled, clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled, clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled, build); 4 external calls (from, ip, port, warn!).


##### `UnixStyleAbsolutePath::parse`  (lines 377–379)

```
fn parse(value: &str) -> Option<Self>
```

**Purpose**: Recognizes strings that look like Unix absolute paths even when the host platform may not treat them as native absolute paths.

**Data flow**: It takes `value: &str` and returns `Some(UnixStyleAbsolutePath(value.to_string()))` when the string starts with `/`, otherwise `None`.

**Call relations**: Used by `ValidatedUnixSocketPath::parse` as a fallback after native absolute-path parsing.

*Call graph*: called by 1 (parse).


##### `ValidatedUnixSocketPath::parse`  (lines 389–402)

```
fn parse(socket_path: &str) -> Result<Self>
```

**Purpose**: Validates that a configured unix-socket path is absolute, either as a native absolute path or as a Unix-style absolute path string.

**Data flow**: It takes `socket_path: &str`. If `Path::new(socket_path).is_absolute()` it normalizes it into `AbsolutePathBuf` and returns `ValidatedUnixSocketPath::Native`. Otherwise it tries `UnixStyleAbsolutePath::parse` and returns `UnixStyleAbsolute` if that succeeds. If neither path form is absolute, it returns an error.

**Call relations**: Allowlist validation and runtime unix-socket permission checks use this parser to reject relative paths early.

*Call graph*: calls 2 internal fn (parse, from_absolute_path); called by 2 (validate_unix_socket_allowlist_paths, is_unix_socket_allowed); 4 external calls (new, Native, UnixStyleAbsolute, bail!).


##### `validate_unix_socket_allowlist_paths`  (lines 405–411)

```
fn validate_unix_socket_allowlist_paths(cfg: &NetworkProxyConfig) -> Result<()>
```

**Purpose**: Validates every configured allowlisted unix-socket path and annotates errors with the offending list index.

**Data flow**: It takes `cfg: &NetworkProxyConfig`, iterates over `cfg.network.allow_unix_sockets()` with indices, parses each path via `ValidatedUnixSocketPath::parse`, and returns `Ok(())` only if all entries are valid absolute paths.

**Call relations**: Called during runtime resolution and config-state building so invalid unix-socket allowlists fail before the proxy starts.

*Call graph*: calls 1 internal fn (parse); called by 2 (resolve_runtime, build_config_state).


##### `resolve_runtime`  (lines 413–426)

```
fn resolve_runtime(cfg: &NetworkProxyConfig) -> Result<RuntimeConfig>
```

**Purpose**: Turns user configuration into concrete listener socket addresses after validating unix-socket allowlists and applying bind-address safety clamps.

**Data flow**: It takes `cfg: &NetworkProxyConfig`. It first calls `validate_unix_socket_allowlist_paths(cfg)`, parses `cfg.network.proxy_url` and `cfg.network.socks_url` into `SocketAddr`s via `resolve_addr` with default ports 3128 and 8081, clamps them with `clamp_bind_addrs`, and returns `RuntimeConfig { http_addr, socks_addr }`.

**Call relations**: Startup code calls this to derive actual listener addresses. It orchestrates validation, parsing, and safety clamping rather than implementing those pieces inline.

*Call graph*: calls 3 internal fn (clamp_bind_addrs, resolve_addr, validate_unix_socket_allowlist_paths); called by 2 (resolve_runtime_rejects_relative_allow_unix_sockets_entries, build).


##### `resolve_addr`  (lines 428–439)

```
fn resolve_addr(url: &str, default_port: u16) -> Result<SocketAddr>
```

**Purpose**: Parses a configured proxy address string into a concrete `SocketAddr`, mapping hostnames to loopback rather than performing DNS resolution.

**Data flow**: It takes `url: &str` and `default_port: u16`. It parses host and port via `parse_host_port`, rewrites `localhost` to `127.0.0.1`, then tries to parse the host as `IpAddr`. If parsing succeeds it returns that IP with the parsed port; otherwise it falls back to `127.0.0.1:<port>`.

**Call relations**: Used by `resolve_runtime` for both HTTP and SOCKS listener URLs. The deliberate hostname-to-loopback fallback keeps listener binding local even when users specify names.

*Call graph*: calls 1 internal fn (parse_host_port); called by 1 (resolve_runtime); 2 external calls (from, new).


##### `host_and_port_from_network_addr`  (lines 441–455)

```
fn host_and_port_from_network_addr(value: &str, default_port: u16) -> String
```

**Purpose**: Formats a user-supplied network address string into a normalized `host:port` display string, with graceful fallback for malformed input.

**Data flow**: It takes `value: &str` and `default_port: u16`. It trims whitespace, returns `<missing>` for empty input, otherwise tries `parse_host_port`; on success it formats the parsed host and port with `format_host_and_port`, and on parse failure it formats the raw trimmed input with the default port.

**Call relations**: This helper is for display/reporting paths that need a readable endpoint string without failing hard on bad input.

*Call graph*: calls 2 internal fn (format_host_and_port, parse_host_port).


##### `format_host_and_port`  (lines 457–463)

```
fn format_host_and_port(host: &str, port: u16) -> String
```

**Purpose**: Formats a host and port pair, adding IPv6 brackets when needed.

**Data flow**: It takes `host: &str` and `port: u16`. If the host contains `:`, it returns `[{host}]:{port}`; otherwise it returns `{host}:{port}`.

**Call relations**: Used by `host_and_port_from_network_addr` after parsing or fallback.

*Call graph*: called by 1 (host_and_port_from_network_addr); 1 external calls (format!).


##### `parse_host_port`  (lines 471–506)

```
fn parse_host_port(url: &str, default_port: u16) -> Result<SocketAddressParts>
```

**Purpose**: Parses a broad range of proxy address inputs—URLs, loose host:port strings, bracketed IPv6, and bare IP literals—into normalized host and port parts.

**Data flow**: It takes `url: &str` and `default_port: u16`. It trims whitespace and errors on empty input. If the trimmed string is an unbracketed IPv6 literal, it returns that host with the default port immediately. Otherwise it prefixes `http://` when no scheme is present, tries `Url::parse`, extracts and de-brackets the host plus parsed or default port when successful, and falls back to `parse_host_port_fallback` if URL parsing does not yield a host.

**Call relations**: Both runtime address resolution and display formatting depend on this parser. It delegates edge-case recovery to `parse_host_port_fallback`.

*Call graph*: calls 1 internal fn (parse_host_port_fallback); called by 2 (host_and_port_from_network_addr, resolve_addr); 4 external calls (parse, bail!, format!, matches!).


##### `parse_host_port_fallback`  (lines 508–557)

```
fn parse_host_port_fallback(input: &str, default_port: u16) -> Result<SocketAddressParts>
```

**Purpose**: Recovers host and port information from malformed or loosely structured address strings when standard URL parsing is insufficient.

**Data flow**: It takes `input: &str` and `default_port: u16`. It strips any scheme prefix, truncates at the first `/`, strips userinfo before `@`, handles bracketed IPv6 with optional port, treats `host:port` specially only when there is exactly one colon, falls back to the default port when port parsing fails, and errors if the resulting host is empty.

**Call relations**: This helper is only called from `parse_host_port` after the preferred URL-based parse path fails.

*Call graph*: called by 1 (parse_host_port); 1 external calls (bail!).


##### `tests::settings_with_unix_sockets`  (lines 565–576)

```
fn settings_with_unix_sockets(unix_sockets: &[&str]) -> NetworkProxySettings
```

**Purpose**: Builds a `NetworkProxySettings` test fixture with an optional unix-socket allowlist.

**Data flow**: It starts from `NetworkProxySettings::default()`, and when the input slice is non-empty it converts each `&str` path into `String` and calls `set_allow_unix_sockets`; then it returns the settings.

**Call relations**: Several tests use this fixture helper to avoid repeating allowlist setup.

*Call graph*: calls 1 internal fn (default).


##### `tests::network_proxy_settings_default_matches_local_use_baseline`  (lines 579–599)

```
fn network_proxy_settings_default_matches_local_use_baseline()
```

**Purpose**: Asserts that the `Default` implementation matches the intended baseline local proxy configuration exactly.

**Data flow**: The test constructs `NetworkProxySettings::default()` and compares it against a fully spelled-out expected struct.

**Call relations**: It guards against accidental default changes that would alter startup behavior or serialized config shape.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::partial_network_config_uses_struct_defaults_for_missing_fields`  (lines 602–617)

```
fn partial_network_config_uses_struct_defaults_for_missing_fields()
```

**Purpose**: Verifies Serde defaulting fills in omitted network settings when only a subset of fields is provided.

**Data flow**: It deserializes JSON containing only `network.enabled = true`, constructs an expected settings struct using `..Default::default()`, and asserts equality.

**Call relations**: This test covers the interaction between `#[serde(default)]` and the manual `Default` implementation.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, from_str).


##### `tests::set_allowed_domains_preserves_existing_deny_for_same_pattern`  (lines 620–631)

```
fn set_allowed_domains_preserves_existing_deny_for_same_pattern()
```

**Purpose**: Checks that replacing allow entries does not erase an existing deny entry for the same domain pattern.

**Data flow**: It creates default settings, sets a deny for `example.com`, then sets an allow for the same pattern and asserts that effective allows are `None` while denies still contain `example.com`.

**Call relations**: This test exercises the deny-wins semantics encoded by `effective_entries` and the mutator behavior that preserves opposite-permission entries.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, vec!).


##### `tests::network_domain_permissions_serialize_to_effective_map_shape`  (lines 634–665)

```
fn network_domain_permissions_serialize_to_effective_map_shape()
```

**Purpose**: Verifies that serialized config emits only effective domain permissions, not raw duplicate allow/deny entries.

**Data flow**: It builds settings with both deny and allow for `example.com`, wraps them in `NetworkProxyConfig`, serializes to JSON value, and asserts the `domains` object contains only `example.com: deny`.

**Call relations**: This test specifically covers `NetworkDomainPermissions::serialize` and `effective_entries`.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert_eq!, to_value, vec!).


##### `tests::parse_host_port_defaults_for_empty_string`  (lines 668–670)

```
fn parse_host_port_defaults_for_empty_string()
```

**Purpose**: Ensures empty address strings are rejected rather than silently defaulted.

**Data flow**: It calls `parse_host_port("", 1234)` and asserts the result is an error.

**Call relations**: This is one of several parser edge-case tests for startup validation.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_host_port_defaults_for_whitespace`  (lines 673–675)

```
fn parse_host_port_defaults_for_whitespace()
```

**Purpose**: Ensures whitespace-only address strings are rejected.

**Data flow**: It calls `parse_host_port("   ", 5555)` and asserts the result is an error.

**Call relations**: It complements the empty-string parser test.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_host_port_parses_host_port_without_scheme`  (lines 678–686)

```
fn parse_host_port_parses_host_port_without_scheme()
```

**Purpose**: Checks that loose `host:port` input parses correctly without requiring a URL scheme.

**Data flow**: It calls `parse_host_port("127.0.0.1:8080", 3128)` and compares the result to the expected `SocketAddressParts`.

**Call relations**: This covers the scheme-prefixing path in `parse_host_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_parses_host_port_with_scheme_and_path`  (lines 689–701)

```
fn parse_host_port_parses_host_port_with_scheme_and_path()
```

**Purpose**: Checks that URL-like inputs with paths still yield the correct host and port.

**Data flow**: It parses `http://example.com:8080/some/path` and asserts the extracted host is `example.com` and port is `8080`.

**Call relations**: This exercises the preferred `Url::parse` branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_strips_userinfo`  (lines 704–716)

```
fn parse_host_port_strips_userinfo()
```

**Purpose**: Verifies that embedded userinfo does not become part of the parsed host.

**Data flow**: It parses `http://user:pass@host.example:5555` and asserts the host is `host.example` and port `5555`.

**Call relations**: This covers both URL parsing and fallback expectations around userinfo stripping.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_parses_ipv6_with_brackets`  (lines 719–727)

```
fn parse_host_port_parses_ipv6_with_brackets()
```

**Purpose**: Checks bracketed IPv6 parsing with an explicit port.

**Data flow**: It parses `http://[::1]:9999` and asserts host `::1` and port `9999`.

**Call relations**: This validates the IPv6-aware host extraction path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_does_not_treat_unbracketed_ipv6_as_host_port`  (lines 730–738)

```
fn parse_host_port_does_not_treat_unbracketed_ipv6_as_host_port()
```

**Purpose**: Ensures bare IPv6 literals are not misinterpreted as `host:port` pairs.

**Data flow**: It parses `2001:db8::1` with default port `3128` and asserts the host remains the full IPv6 literal and the port stays at the default.

**Call relations**: This covers the early IPv6-literal special case in `parse_host_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_falls_back_to_default_port_when_port_is_invalid`  (lines 741–749)

```
fn parse_host_port_falls_back_to_default_port_when_port_is_invalid()
```

**Purpose**: Checks that malformed port text does not fail parsing when a host is still recoverable.

**Data flow**: It parses `example.com:notaport` and asserts the host is `example.com` and the port falls back to `3128`.

**Call relations**: This exercises the fallback parser’s forgiving invalid-port behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::host_and_port_from_network_addr_defaults_for_empty_string`  (lines 752–757)

```
fn host_and_port_from_network_addr_defaults_for_empty_string()
```

**Purpose**: Verifies the display helper returns a placeholder for missing input.

**Data flow**: It calls `host_and_port_from_network_addr("", 1234)` and asserts the result is `<missing>`.

**Call relations**: This covers the non-erroring display-oriented wrapper around address parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::host_and_port_from_network_addr_formats_ipv6`  (lines 760–765)

```
fn host_and_port_from_network_addr_formats_ipv6()
```

**Purpose**: Checks that the display helper preserves IPv6 bracket formatting.

**Data flow**: It formats `http://[::1]:8080` and asserts the output is `[::1]:8080`.

**Call relations**: This indirectly covers both parsing and `format_host_and_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_maps_localhost_to_loopback`  (lines 768–773)

```
fn resolve_addr_maps_localhost_to_loopback()
```

**Purpose**: Ensures `localhost` is normalized to an explicit loopback IP address.

**Data flow**: It calls `resolve_addr("localhost", 3128)` and asserts the result is `127.0.0.1:3128`.

**Call relations**: This covers the special-case hostname rewrite in runtime address resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_parses_ip_literals`  (lines 776–781)

```
fn resolve_addr_parses_ip_literals()
```

**Purpose**: Checks that IPv4 literals are preserved as concrete bind addresses.

**Data flow**: It resolves `1.2.3.4` with default port `80` and asserts the resulting `SocketAddr` matches.

**Call relations**: This covers the successful `IpAddr` parse branch in `resolve_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_parses_ipv6_literals`  (lines 784–789)

```
fn resolve_addr_parses_ipv6_literals()
```

**Purpose**: Checks that IPv6 literals survive runtime address resolution.

**Data flow**: It resolves `http://[::1]:8080` and asserts the resulting `SocketAddr` is `[::1]:8080`.

**Call relations**: This complements the IPv4 literal resolution test.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_falls_back_to_loopback_for_hostnames`  (lines 792–797)

```
fn resolve_addr_falls_back_to_loopback_for_hostnames()
```

**Purpose**: Verifies that non-IP hostnames do not trigger DNS resolution and instead bind to loopback with the parsed port.

**Data flow**: It resolves `http://example.com:5555` and asserts the result is `127.0.0.1:5555`.

**Call relations**: This covers the hostname fallback branch in `resolve_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::clamp_bind_addrs_allows_non_loopback_when_enabled`  (lines 800–812)

```
fn clamp_bind_addrs_allows_non_loopback_when_enabled()
```

**Purpose**: Checks that dangerous non-loopback binding is preserved when explicitly enabled and unix-socket proxying is not active.

**Data flow**: It builds settings with `dangerously_allow_non_loopback_proxy = true`, passes `0.0.0.0` HTTP and SOCKS addresses into `clamp_bind_addrs`, and asserts both remain unchanged.

**Call relations**: This test covers the permissive branch of bind-address clamping.

*Call graph*: calls 1 internal fn (clamp_bind_addrs); 2 external calls (default, assert_eq!).


##### `tests::clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled`  (lines 815–828)

```
fn clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled()
```

**Purpose**: Verifies that enabling specific unix-socket proxying forces listener binds back to loopback even when dangerous non-loopback binding is requested.

**Data flow**: It builds settings with an allowlisted unix socket and `dangerously_allow_non_loopback_proxy = true`, clamps `0.0.0.0` addresses, and asserts both become loopback.

**Call relations**: This covers the extra safety rule that protects local-daemon access from remote exposure.

*Call graph*: calls 1 internal fn (clamp_bind_addrs); 2 external calls (assert_eq!, settings_with_unix_sockets).


##### `tests::clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled`  (lines 831–844)

```
fn clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled()
```

**Purpose**: Verifies the same loopback-forcing behavior when broad unix-socket access is enabled globally rather than via an explicit allowlist.

**Data flow**: It builds settings with `dangerously_allow_all_unix_sockets = true` and dangerous non-loopback binding enabled, clamps `0.0.0.0` addresses, and asserts both become loopback.

**Call relations**: This is the broad-access counterpart to the explicit-allowlist clamp test.

*Call graph*: calls 1 internal fn (clamp_bind_addrs); 2 external calls (default, assert_eq!).


##### `tests::resolve_runtime_rejects_relative_allow_unix_sockets_entries`  (lines 847–863)

```
fn resolve_runtime_rejects_relative_allow_unix_sockets_entries()
```

**Purpose**: Ensures startup runtime resolution fails when the unix-socket allowlist contains a relative path.

**Data flow**: It builds a config with `relative.sock` in the allowlist, calls `resolve_runtime`, expects an error, and asserts the message points to `network.allow_unix_sockets[0]`.

**Call relations**: This test covers indexed error annotation from `validate_unix_socket_allowlist_paths`.

*Call graph*: calls 1 internal fn (resolve_runtime); 3 external calls (assert!, settings_with_unix_sockets, panic!).


##### `tests::resolve_runtime_accepts_unix_style_absolute_allow_unix_sockets_entries`  (lines 866–875)

```
fn resolve_runtime_accepts_unix_style_absolute_allow_unix_sockets_entries()
```

**Purpose**: Checks that Unix-style absolute paths are accepted as valid allowlist entries.

**Data flow**: It builds a config with `/private/tmp/example.sock` in the allowlist, calls `resolve_runtime`, and asserts success.

**Call relations**: This covers the `UnixStyleAbsolutePath` fallback accepted by `ValidatedUnixSocketPath::parse`.

*Call graph*: 2 external calls (assert!, settings_with_unix_sockets).


### Version and release diagnostics
These utilities expose the current build version and validate or compare external release metadata for update and publish checks.

### `tui/src/npm_registry.rs`

`domain_logic` · `release/update validation`

This file defines a small deserialization model for the npm registry response and a strict readiness check used by update/publish logic. `NpmPackageInfo` mirrors the registry JSON shape with a renamed `dist-tags` map and a `versions` map keyed by version string; each version may contain optional `dist` metadata, and that metadata may in turn contain optional `tarball` and `integrity` strings. The central invariant is that a version is only considered ready if the package-level `latest` dist-tag exactly equals the requested version after trimming whitespace, and the corresponding version entry exists with non-empty `dist.tarball` and `dist.integrity` values. The helper `version_info_with_dist` performs the structural checks in order and emits precise `anyhow` errors for each missing piece, so callers can distinguish stale tags from incomplete publish propagation. In non-debug builds the file also exposes the concrete registry URL for `@openai/codex`. The tests build synthetic registry payloads with `serde_json`, covering the success path, stale `latest` tags, and missing `dist` metadata to lock in both acceptance criteria and human-readable error wording.

#### Function details

##### `ensure_version_ready`  (lines 25–41)

```
fn ensure_version_ready(
    package_info: &NpmPackageInfo,
    version: &str,
) -> anyhow::Result<()>
```

**Purpose**: Checks whether a specific npm version is fully publish-ready according to the registry metadata. It first verifies that the package's `latest` dist-tag points at the requested version, then verifies that the version entry has complete distribution metadata.

**Data flow**: Reads `package_info.dist_tags` and `package_info.versions`, and trims the input `version` string. It compares the trimmed version against the `latest` dist-tag, then delegates structural validation of the version entry to `version_info_with_dist`; it returns `Ok(())` on success or an `anyhow` error describing the exact mismatch or missing field.

**Call relations**: This is the public checker used by `check_for_update` and by the unit tests. After the top-level dist-tag gate passes, it delegates the deeper per-version checks to `version_info_with_dist`; otherwise it exits early with `bail!` for stale or absent `latest` metadata.

*Call graph*: calls 1 internal fn (version_info_with_dist); called by 4 (ready_version_rejects_missing_root_dist, ready_version_rejects_stale_latest_dist_tag, ready_version_requires_latest_dist_tag_and_root_dist, check_for_update); 1 external calls (bail!).


##### `version_info_with_dist`  (lines 43–69)

```
fn version_info_with_dist(
    package_info: &'a NpmPackageInfo,
    version: &str,
) -> anyhow::Result<&'a NpmPackageVersionInfo>
```

**Purpose**: Looks up one version entry in the npm metadata and enforces that its `dist`, `dist.tarball`, and `dist.integrity` fields are present and non-empty. It is the low-level validator behind the public readiness check.

**Data flow**: Consumes `package_info` plus a version string, reads `package_info.versions[version]`, then inspects nested optional fields under `dist`. It returns a borrowed `&NpmPackageVersionInfo` when all checks pass; otherwise it produces an `anyhow` error naming the missing version, missing `dist`, missing tarball, or missing integrity field.

**Call relations**: This helper is only reached from `ensure_version_ready` after the `latest` tag has already been validated. It centralizes the nested metadata checks so the caller can keep the top-level control flow focused on tag consistency.

*Call graph*: called by 1 (ensure_version_ready); 1 external calls (bail!).


##### `tests::version_json`  (lines 75–82)

```
fn version_json(version: &str) -> serde_json::Value
```

**Purpose**: Builds a synthetic JSON object for one npm version entry with valid `dist.integrity` and `dist.tarball` fields. It gives tests a compact way to create realistic version metadata.

**Data flow**: Takes a version string and formats it into a `serde_json::Value` object containing a `dist` object with deterministic integrity and tarball strings. It returns that JSON value without mutating external state.

**Call relations**: Used by `tests::package_info` to populate the `versions` map in test fixtures. It isolates the exact JSON shape expected by deserialization.

*Call graph*: 1 external calls (json!).


##### `tests::package_info`  (lines 84–93)

```
fn package_info(github_latest: &str, npm_latest: &str) -> NpmPackageInfo
```

**Purpose**: Constructs a deserialized `NpmPackageInfo` fixture with a chosen GitHub-latest version entry and an independently chosen npm `latest` dist-tag. This lets tests model both aligned and stale registry states.

**Data flow**: Accepts `github_latest` and `npm_latest`, creates a JSON object map containing one version entry from `tests::version_json`, then deserializes the assembled JSON into `NpmPackageInfo`. It returns the parsed struct and panics only if the fixture shape is invalid.

**Call relations**: Called by the readiness tests to avoid repeating fixture assembly. It feeds `ensure_version_ready` with controlled combinations of version presence and dist-tag values.

*Call graph*: 4 external calls (new, from_value, json!, version_json).


##### `tests::ready_version_requires_latest_dist_tag_and_root_dist`  (lines 96–101)

```
fn ready_version_requires_latest_dist_tag_and_root_dist()
```

**Purpose**: Verifies the happy path where the npm `latest` tag matches the requested version and the version entry contains complete `dist` metadata. It confirms that the validator accepts a fully propagated release.

**Data flow**: Creates a fixture via `tests::package_info`, passes it with the same version string into `ensure_version_ready`, and asserts that the result is successful. It writes no shared state.

**Call relations**: This test exercises the normal call path into `ensure_version_ready` and implicitly through `version_info_with_dist`, proving the acceptance criteria for a ready package.

*Call graph*: calls 1 internal fn (ensure_version_ready); 1 external calls (package_info).


##### `tests::ready_version_rejects_stale_latest_dist_tag`  (lines 104–113)

```
fn ready_version_rejects_stale_latest_dist_tag()
```

**Purpose**: Checks that readiness fails when npm's `latest` dist-tag still points to an older version. It also verifies that the resulting error message explicitly mentions the dist-tag problem.

**Data flow**: Builds a fixture whose version map contains `1.2.3` but whose `latest` tag is `1.2.2`, calls `ensure_version_ready`, captures the error, and asserts that its string contains `latest dist-tag`. It returns no value beyond the test assertion outcome.

**Call relations**: This test targets the early branch in `ensure_version_ready` before `version_info_with_dist` can make the version pass. It documents that stale tag propagation is treated as a hard failure.

*Call graph*: calls 1 internal fn (ensure_version_ready); 2 external calls (assert!, package_info).


##### `tests::ready_version_rejects_missing_root_dist`  (lines 116–129)

```
fn ready_version_rejects_missing_root_dist()
```

**Purpose**: Ensures that a version entry without `dist` metadata is rejected even if the package-level `latest` tag is correct. It locks in the specific missing-metadata failure mode.

**Data flow**: Deserializes a hand-written JSON payload with matching `latest` and version keys but an empty version object, calls `ensure_version_ready`, captures the error, and asserts that the message mentions missing dist metadata. It mutates no external state.

**Call relations**: This test drives `ensure_version_ready` past the dist-tag check and into `version_info_with_dist`, validating the nested metadata guardrails.

*Call graph*: calls 1 internal fn (ensure_version_ready); 3 external calls (assert!, from_value, json!).


### `tui/src/update_versions.rs`

`util` · `update version parsing and comparison during startup checks`

This file contains pure helpers for interpreting version strings in the limited format the updater expects. The internal workhorse is `parse_version`, which trims surrounding whitespace, splits on `.`, parses exactly three numeric components into `(u64, u64, u64)`, and returns `None` if any component is missing or non-numeric. Because it does not understand prerelease or build metadata, strings like `0.11.0-beta.1` intentionally fail to parse.

`is_newer` uses that parser on both the fetched latest version and the current version. If both parse successfully, it compares the tuples lexicographically and returns `Some(true)` or `Some(false)`; if either side is unparsable, it returns `None` rather than guessing. That conservative behavior prevents prerelease tags or malformed data from triggering misleading update banners.

`extract_version_from_latest_tag` converts GitHub release tags into plain version strings by requiring the `rust-v` prefix and stripping it; any other tag shape becomes an error with the original tag embedded in the message. `is_source_build_version` treats exactly `0.0.0` as the sentinel for source builds, allowing higher-level update logic to skip network checks for locally built binaries.

The tests document the intended semantics: strict prefix parsing for tags, no prerelease support, ordinary numeric comparisons, source-build detection, and whitespace tolerance.

#### Function details

##### `is_newer`  (lines 1–6)

```
fn is_newer(latest: &str, current: &str) -> Option<bool>
```

**Purpose**: Compares two plain three-part numeric versions and reports whether the first is newer than the second.

**Data flow**: It takes `latest` and `current` as `&str`, parses both with `parse_version`, and if both succeed compares the resulting tuples with `>`. It returns `Some(bool)` on successful parsing or `None` if either version string is outside the supported format.

**Call relations**: Higher-level update logic uses this helper after reading cached or fetched version strings. Its `None` result is treated conservatively by callers so malformed or prerelease versions do not trigger update notices.

*Call graph*: calls 1 internal fn (parse_version).


##### `extract_version_from_latest_tag`  (lines 8–13)

```
fn extract_version_from_latest_tag(latest_tag_name: &str) -> anyhow::Result<String>
```

**Purpose**: Converts a GitHub release tag name like `rust-v1.5.0` into the bare version string `1.5.0`.

**Data flow**: It takes `latest_tag_name`, attempts `strip_prefix("rust-v")`, clones the remainder into an owned `String` on success, and otherwise constructs an `anyhow` error mentioning the original tag. It returns `anyhow::Result<String>`.

**Call relations**: This function is called by `fetch_latest_github_release_version` after deserializing the GitHub API response, isolating tag-shape validation from the HTTP code.

*Call graph*: called by 1 (fetch_latest_github_release_version).


##### `is_source_build_version`  (lines 15–17)

```
fn is_source_build_version(version: &str) -> bool
```

**Purpose**: Recognizes the special `0.0.0` version used to identify source builds that should not participate in normal update checks.

**Data flow**: It parses the input string with `parse_version` and compares the result to `Some((0, 0, 0))`. It returns a boolean and does not mutate state.

**Call relations**: Both `get_upgrade_version` and `get_upgrade_version_for_popup` call this early to short-circuit update logic for source-built binaries.

*Call graph*: calls 1 internal fn (parse_version); called by 2 (get_upgrade_version, get_upgrade_version_for_popup).


##### `parse_version`  (lines 19–25)

```
fn parse_version(v: &str) -> Option<(u64, u64, u64)>
```

**Purpose**: Parses a trimmed dotted version string into a numeric `(major, minor, patch)` tuple.

**Data flow**: It trims the input, splits on `.`, reads the first three segments, parses each as `u64`, and returns `Some((maj, min, pat))` if all succeed. Missing segments, extra prerelease text in a segment, or parse failures produce `None`.

**Call relations**: This private helper underpins both `is_newer` and `is_source_build_version`, centralizing the file's intentionally strict version grammar.

*Call graph*: called by 2 (is_newer, is_source_build_version).


##### `tests::extracts_version_from_latest_tag`  (lines 33–38)

```
fn extracts_version_from_latest_tag()
```

**Purpose**: Confirms that a correctly prefixed GitHub tag is reduced to the expected bare version string.

**Data flow**: It calls `extract_version_from_latest_tag("rust-v1.5.0")`, unwraps the result, and asserts equality with `"1.5.0"`.

**Call relations**: This test protects the tag parsing relied on by the GitHub release fetch path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::latest_tag_without_prefix_is_invalid`  (lines 41–43)

```
fn latest_tag_without_prefix_is_invalid()
```

**Purpose**: Confirms that tags missing the required `rust-v` prefix are rejected.

**Data flow**: It calls `extract_version_from_latest_tag("v1.5.0")` and asserts that the result is an error.

**Call relations**: This test documents the invariant that only the expected release-tag naming scheme is accepted.

*Call graph*: 1 external calls (assert!).


##### `tests::prerelease_version_is_not_considered_newer`  (lines 46–49)

```
fn prerelease_version_is_not_considered_newer()
```

**Purpose**: Verifies that prerelease strings are outside the supported parser and therefore do not produce a newer/not-newer answer.

**Data flow**: It calls `is_newer` with prerelease examples and asserts both results are `None`.

**Call relations**: This test captures the deliberate design choice that update comparison is strict numeric semver only, with no prerelease handling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plain_semver_comparisons_work`  (lines 52–57)

```
fn plain_semver_comparisons_work()
```

**Purpose**: Checks ordinary numeric comparisons across patch, minor, and major boundaries.

**Data flow**: It invokes `is_newer` on several plain version pairs and asserts the expected `Some(true)` or `Some(false)` results.

**Call relations**: This test validates the tuple-comparison semantics used by cached update evaluation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::source_build_version_is_not_checked`  (lines 60–63)

```
fn source_build_version_is_not_checked()
```

**Purpose**: Confirms that only `0.0.0` is treated as the source-build sentinel.

**Data flow**: It calls `is_source_build_version` with `0.0.0` and `0.1.0` and asserts true for the former and false for the latter.

**Call relations**: This test protects the startup short-circuit used by update-checking code.

*Call graph*: 1 external calls (assert!).


##### `tests::whitespace_is_ignored`  (lines 66–69)

```
fn whitespace_is_ignored()
```

**Purpose**: Verifies that surrounding whitespace does not affect parsing or comparison.

**Data flow**: It calls `parse_version` on a whitespace-padded string and `is_newer` on a padded latest version, asserting successful parsing and comparison.

**Call relations**: This test documents the parser's initial `trim()` behavior, which makes network or file inputs slightly more robust.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/version.rs`

`config` · `startup`

This module defines one public constant, `CODEX_CLI_VERSION`, whose value comes from Rust’s `env!` macro reading `CARGO_PKG_VERSION` during compilation. That means the version string is baked into the binary and always matches the package version Cargo built, with no runtime environment dependency and no parsing step. The constant is `pub`, not `pub(crate)`, so it is intended as a broadly consumable identifier for version banners, status screens, diagnostics, or protocol metadata that needs to report the CLI build. The implementation is deliberately minimal because the important behavior is the compile-time contract: if the package metadata changes, the embedded version changes automatically on rebuild. There are no fallback paths or formatting rules here; consumers receive the raw Cargo version string exactly as declared in the package manifest. This file serves as the canonical source for version identity within the TUI codebase.
