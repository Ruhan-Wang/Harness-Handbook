# Configuration, metadata, schema, auth, and network glue utilities  `stage-22.3`

This stage is shared behind-the-scenes support. It is the toolbox other features reach for when they need clean settings, safe network rules, login helpers, or small bits of display data. The cloud tasks, login, API, proxy, MCP, and Ollama helpers prepare authentication, headers, URLs, readable errors, and server environment values so requests leave the app with the right context and fewer secret-handling mistakes. The configuration helpers explain where settings came from, enforce allowed values, rename old keys, convert JSON to TOML, and turn command-line options such as approval mode, sandbox mode, and key=value overrides into the internal settings the program uses. Metadata helpers give connectors, plugins, skills, mentions, memories, and execution-policy errors consistent names, schemas, counts, symbols, and messages. The network proxy files turn user-facing allow and deny rules into normalized host and IP policies, blocking risky local targets and choosing safe listen addresses. Finally, the TUI version helpers read baked-in version data, compare releases, and check npm registry records before treating an update as real. Together, these files act like adapters and gauges that keep the larger machine understandable and safe.

## Files in this stage

### API and auth request glue
These helpers shape outbound request metadata, normalize service URLs, and support lightweight authentication flows reused by clients and proxies.

### `cloud-tasks/src/util.rs`

`util` · `cross-cutting`

This file is the toolbox for the cloud tasks part of the project. It does not define the main task workflow itself. Instead, it solves repeated support problems that many parts of that workflow need: making sure web addresses have the shape the backend expects, building the right HTTP headers for ChatGPT-backed requests, loading saved login information, writing emergency errors to a local log file, and turning timestamps into labels like “5m ago”.

A useful way to think about it is as the “front desk supplies” for the app. Before the app can talk to the cloud service, it needs a standard base URL, a User-Agent header that identifies this client, and sometimes authorization headers from the user’s stored login. Before it can show links to users, it needs to turn backend URLs into browser-friendly task URLs. Before it can show task status, it needs dates in a form people can quickly read.

The file is careful to fail softly in a few places. If the error log cannot be opened, it simply skips logging. If authentication cannot be loaded, header creation still returns a basic header map. That makes these helpers safe to use during startup and command execution, where a secondary failure should not crash the whole tool.

#### Function details

##### `set_user_agent_suffix`  (lines 9–13)

```
fn set_user_agent_suffix(suffix: &str)
```

**Purpose**: Sets a short label that is added to the program’s User-Agent string, which is the name an HTTP client sends to a server to identify itself. This lets backend services see that requests are coming from the cloud tasks text interface rather than some other Codex client.

**Data flow**: It receives a suffix string. It tries to take a lock on the shared User-Agent suffix setting, and if that succeeds, it replaces the old suffix with the new one. It does not return a value; the visible result is that later HTTP requests can include the updated client label.

**Call relations**: Startup code uses this when preparing the backend, and header-building code uses it just before creating ChatGPT request headers. After this helper sets the shared suffix, the code that asks for the full Codex User-Agent can include that suffix in the outgoing request metadata.

*Call graph*: called by 2 (init_backend, build_chatgpt_headers).


##### `append_error_log`  (lines 15–25)

```
fn append_error_log(message: impl AsRef<str>)
```

**Purpose**: Adds a timestamped message to a local `error.log` file. It gives the tool a simple fallback place to record problems, especially during startup or main command execution when richer reporting may not be available.

**Data flow**: It receives any message that can be viewed as text. It gets the current time in UTC, opens or creates `error.log` in append mode, and writes one line containing the timestamp and message. It returns nothing, and if opening or writing fails, it quietly ignores that logging failure.

**Call relations**: Backend initialization and the main run path call this when they need to record an error for later inspection. It relies only on the system clock and local file writing, so it can be used even when network or authentication setup is failing.

*Call graph*: called by 2 (init_backend, run_main); 3 external calls (now, new, writeln!).


##### `normalize_base_url`  (lines 30–42)

```
fn normalize_base_url(input: &str) -> String
```

**Purpose**: Turns a configured service URL into the standard form expected by backend clients. This avoids small URL differences, like extra slashes or missing backend path segments, causing requests to go to the wrong place.

**Data flow**: It receives a URL as text. It removes trailing `/` characters, then checks whether the URL points at a ChatGPT host and is missing `/backend-api`; if so, it adds that path. It returns the cleaned-up URL string.

**Call relations**: Code that resolves environments, runs the main command flow, and builds task links calls this before using a base URL. It is also the first step inside `task_url`, where a backend-style URL must be converted into a browser-style task page link.

*Call graph*: called by 3 (resolve_environment_id, run_main, task_url); 1 external calls (format!).


##### `load_auth_manager`  (lines 44–57)

```
async fn load_auth_manager(chatgpt_base_url: Option<String>) -> Option<AuthManager>
```

**Purpose**: Loads the app’s configuration and creates an authentication manager, which is the object responsible for finding the user’s saved login credentials. Other code uses it when it needs to make authenticated ChatGPT-backed requests.

**Data flow**: It receives an optional ChatGPT base URL override. It loads the normal Codex configuration without command-line overrides, then builds an `AuthManager` using the Codex home directory, credential storage settings, chosen ChatGPT base URL, and keyring backend. If configuration loading fails, it returns `None`; otherwise it returns the ready authentication manager.

**Call relations**: Backend startup and ChatGPT header creation call this before they need credentials. Once it returns an authentication manager, callers can ask that manager for the current auth data and turn it into request headers.

*Call graph*: calls 1 internal fn (new); called by 2 (init_backend, build_chatgpt_headers); 2 external calls (new, load_with_cli_overrides).


##### `build_chatgpt_headers`  (lines 61–79)

```
async fn build_chatgpt_headers() -> HeaderMap
```

**Purpose**: Builds the HTTP headers needed for requests to ChatGPT-backed services. At minimum it sets a User-Agent, and when a suitable saved login exists, it also adds authorization information.

**Data flow**: It first sets the User-Agent suffix for the cloud tasks interface, then asks the shared client code for the full User-Agent string. It creates a new header map and inserts that User-Agent. It then tries to load authentication, read the current auth data, and, if that auth is for the Codex backend, convert it into authorization headers. The result is a header map ready to attach to outgoing HTTP requests.

**Call relations**: Environment resolution and the main run flow call this before making ChatGPT-backed network requests. Internally it depends on `set_user_agent_suffix` for client identification and `load_auth_manager` for credentials, then hands the finished headers back to the caller for use in request setup.

*Call graph*: calls 3 internal fn (load_auth_manager, set_user_agent_suffix, get_codex_user_agent); called by 2 (resolve_environment_id, run_main); 4 external calls (new, from_static, from_str, auth_provider_from_auth).


##### `task_url`  (lines 82–94)

```
fn task_url(base_url: &str, task_id: &str) -> String
```

**Purpose**: Creates a browser-friendly web link for a specific cloud task. This matters because backend API base URLs are not always the same as the web page URLs a person should open in a browser.

**Data flow**: It receives a base URL and a task ID. It first normalizes the base URL, then checks for known API suffixes such as `/backend-api` or `/api/codex` and removes or reshapes them as needed. It returns a URL pointing at the task page, usually ending in `/codex/tasks/{task_id}` or `/codex/tasks/{task_id}`-equivalent form for that host.

**Call relations**: Task list formatting calls this to show usable links, and command execution calls it when it needs to open or report a task URL. It leans on `normalize_base_url` so callers do not have to worry about small differences in configured service addresses.

*Call graph*: calls 1 internal fn (normalize_base_url); called by 2 (format_task_list_lines, run_exec_command); 1 external calls (format!).


##### `format_relative_time`  (lines 96–114)

```
fn format_relative_time(reference: DateTime<Utc>, ts: DateTime<Utc>) -> String
```

**Purpose**: Formats a timestamp as a short, human-readable age such as `12s ago`, `8m ago`, or `3h ago`. For older times, it switches to a local calendar-style date so the display stays useful.

**Data flow**: It receives a reference time and the timestamp to describe, both in UTC. It subtracts the timestamp from the reference time, clamps future timestamps to zero seconds, and chooses seconds, minutes, hours, or a local date format depending on how old the timestamp is. It returns the formatted text.

**Call relations**: Task status formatting uses this when it already has a reference time, which keeps multiple displayed times consistent. `format_relative_time_now` also delegates to it after choosing the current time as the reference.

*Call graph*: called by 2 (format_task_status_lines, format_relative_time_now); 2 external calls (with_timezone, format!).


##### `format_relative_time_now`  (lines 116–118)

```
fn format_relative_time_now(ts: DateTime<Utc>) -> String
```

**Purpose**: Formats a timestamp relative to the current moment. It is a convenience wrapper for places that simply want to show how long ago something happened.

**Data flow**: It receives a UTC timestamp. It gets the current UTC time, passes both times into `format_relative_time`, and returns the resulting label such as `2m ago`.

**Call relations**: Task item rendering calls this while drawing each task entry. Rather than duplicating time comparison logic, it hands the work to `format_relative_time`, which keeps all relative-time labels consistent.

*Call graph*: calls 1 internal fn (format_relative_time); called by 1 (render_task_item); 1 external calls (now).


### `codex-api/src/requests/headers.rs`

`io_transport` · `request preparation`

When the client talks to the API, it sometimes needs to attach extra labels to the request. These labels are HTTP headers: small name-and-value fields sent alongside the main request, like a shipping label on a package. This file creates those labels for session tracking and sub-agent tracking.

The main job is to add optional session and thread identifiers only when they exist. If there is no session ID or thread ID, the file simply leaves that header out rather than sending an empty or invalid value. It also translates a `SessionSource` into a short text label when the request comes from a sub-agent, such as a review task, a compaction task, or a spawned collaboration thread.

A small helper, `insert_header`, does the careful part: it only inserts a header if both the header name and value can be converted into valid HTTP header forms. That means bad header text is silently ignored instead of causing a crash here. In the bigger request flow, this file is used while preparing a streaming API request, so the server can understand which session, thread, or sub-agent the request belongs to.

#### Function details

##### `build_session_headers`  (lines 5–14)

```
fn build_session_headers(session_id: Option<String>, thread_id: Option<String>) -> HeaderMap
```

**Purpose**: Creates a fresh collection of HTTP headers for optional session and thread IDs. It is used when an outgoing request should tell the server which conversation session or thread it belongs to.

**Data flow**: It receives an optional session ID and an optional thread ID. It starts with an empty header collection, adds a `session-id` header if a session ID was provided, adds a `thread-id` header if a thread ID was provided, and returns the finished header collection.

**Call relations**: During request setup, `stream_request` calls this function when it needs session-related headers. This function delegates the actual safe insertion work to `insert_header`, so it does not have to repeat the rules for turning plain strings into valid HTTP headers.

*Call graph*: calls 1 internal fn (insert_header); called by 1 (stream_request); 1 external calls (new).


##### `subagent_header`  (lines 16–31)

```
fn subagent_header(source: &Option<SessionSource>) -> Option<String>
```

**Purpose**: Turns a sub-agent source into the text value used for a request header. This lets the API know whether a request came from a review helper, a compacting helper, a memory-consolidation helper, a spawned thread, or another labeled source.

**Data flow**: It receives an optional `SessionSource`, which says where a session or request came from. If there is no source, or the source is not a sub-agent, it returns nothing. If it is a sub-agent, it returns the matching short label, such as `review`, `compact`, `memory_consolidation`, `collab_spawn`, or a custom label.

**Call relations**: `stream_request` calls this while preparing an outgoing streaming request. The returned text, when present, can then be placed into a header so the server gets a clear origin label for the request.

*Call graph*: called by 1 (stream_request).


##### `insert_header`  (lines 33–40)

```
fn insert_header(headers: &mut HeaderMap, name: &str, value: &str)
```

**Purpose**: Safely adds one HTTP header to an existing header collection. It protects the request-building code from invalid header names or values by inserting only when both are acceptable to the HTTP library.

**Data flow**: It receives a mutable header collection, a header name as plain text, and a header value as plain text. It tries to convert the name and value into valid HTTP header types. If both conversions succeed, it adds the header to the collection; if either fails, it leaves the collection unchanged.

**Call relations**: `build_session_headers` uses this helper when adding session and thread headers, and `stream_request` also calls it directly when preparing other request headers. The actual storage is handed off to the HTTP header map's insert operation after the text has been validated.

*Call graph*: called by 2 (stream_request, build_session_headers); 2 external calls (insert, from_str).


### `codex-client/src/chatgpt_hosts.rs`

`domain_logic` · `request handling`

Codex sometimes needs to decide whether a web address belongs to ChatGPT itself, for example when checking whether a cookie URL should be treated as ChatGPT-related. This file is the small gatekeeper for that decision.

The core idea is an allowlist: only a few exact host names are accepted, such as `chatgpt.com`, `chat.openai.com`, and `chatgpt-staging.com`. It also accepts real subdomains of selected ChatGPT domains, such as `foo.chatgpt.com`, by requiring the host to end with a suffix that includes the dot before the domain. That dot matters. It means `foo.chatgpt.com` is allowed, but `evilchatgpt.com` is not, even though the text `chatgpt.com` appears inside it.

An everyday analogy is checking an ID badge at a building entrance. The guard accepts badges from the company and its official branch offices, but does not accept a fake badge that merely contains the company name as part of a longer word.

The included test locks down this safety behavior. It checks both accepted hosts and common “suffix trick” attempts, where a hostile site tries to look legitimate by putting `chatgpt.com` in the wrong place.

#### Function details

##### `is_allowed_chatgpt_host`  (lines 3–11)

```
fn is_allowed_chatgpt_host(host: &str) -> bool
```

**Purpose**: This function answers a yes-or-no question: does this host name belong to the set of ChatGPT hosts Codex is allowed to trust? It is used to avoid treating misleading lookalike domains as real ChatGPT traffic.

**Data flow**: It takes a host name as text. It first checks whether the host exactly matches one of the approved names. If not, it checks whether the host ends with an approved subdomain suffix, including the leading dot so only true subdomains match. It returns `true` for trusted ChatGPT hosts and `false` for everything else; it does not change any outside state.

**Call relations**: When `is_chatgpt_cookie_url` needs to decide whether a cookie URL belongs to ChatGPT, it calls this function for the host-name part of the URL. This function gives back the trust decision that the cookie-checking logic can then use.

*Call graph*: called by 1 (is_chatgpt_cookie_url).


##### `tests::recognizes_chatgpt_hosts_without_suffix_tricks`  (lines 18–38)

```
fn recognizes_chatgpt_hosts_without_suffix_tricks()
```

**Purpose**: This test proves that the host checker accepts the intended ChatGPT hosts and rejects common fake-looking alternatives. It protects the security-sensitive boundary around which domains are considered trusted.

**Data flow**: It feeds several known-good host names into `is_allowed_chatgpt_host` and asserts that each one is accepted. Then it feeds several known-bad host names, including domains that merely contain `chatgpt.com` as text, and asserts that each one is rejected. The output is the test result: pass if all checks behave as expected, fail if any host is classified incorrectly.

**Call relations**: During the test run, this function exercises the host-checking function directly. It uses assertions to stop the test if the allowlist logic ever becomes too broad or too narrow.

*Call graph*: 1 external calls (assert!).


### `login/src/auth/util.rs`

`util` · `error handling during authentication requests`

When the login system talks to a server, failures may come back in different shapes. Some replies are structured JSON, which is a common text format for sending named fields. OpenAI-style errors often put the useful human message inside `error.message`. This file looks for that specific place and pulls the message out.

The main helper, `try_parse_error_message`, is deliberately forgiving. It first logs the raw server text for debugging. Then it tries to read the text as JSON. If the text is not valid JSON, it does not crash; it treats it as empty structured data and keeps going. If it finds `error.message` and that value is plain text, it returns only that message. If the structured message is not present, it falls back to returning the original text. If there is no text at all, it returns `Unknown error`.

An everyday analogy is opening a letter from a help desk: if there is a clearly marked “reason” box, this helper copies that. If not, it hands you the whole letter. The tests check both the successful extraction case and the fallback case.

#### Function details

##### `try_parse_error_message`  (lines 3–16)

```
fn try_parse_error_message(text: &str) -> String
```

**Purpose**: This function extracts the most useful human-readable error message from a server response. It is used when authentication requests fail, especially token refresh or token revocation, so the rest of the login flow can report a clearer reason.

**Data flow**: It receives raw response text from the server. It logs that text for debugging, tries to interpret it as JSON, and looks for a nested `error.message` field. If that field exists and is text, it returns that message; if the input is empty, it returns `Unknown error`; otherwise it returns the original text unchanged.

**Call relations**: The token refresh and token revocation flows call this when the server sends back an error. Instead of forcing those flows to understand every possible error format, they hand the raw response here and get back one clean string. The test functions also call it to prove both the OpenAI-style extraction path and the fallback path work.

*Call graph*: called by 4 (request_chatgpt_token_refresh, revoke_oauth_token, try_parse_error_message_extracts_openai_error_message, try_parse_error_message_falls_back_to_raw_text); 1 external calls (debug!).


##### `tests::try_parse_error_message_extracts_openai_error_message`  (lines 23–37)

```
fn try_parse_error_message_extracts_openai_error_message()
```

**Purpose**: This test proves that the helper can find the useful message inside an OpenAI-style error response. It protects the behavior that turns nested JSON into a simple sentence.

**Data flow**: It builds a sample JSON error response with `error.message` filled in. It passes that text into `try_parse_error_message`, then checks that the returned value is exactly the nested message and not the whole JSON block.

**Call relations**: This test calls `try_parse_error_message` in the same way the authentication code would after a failed server request. It uses an equality check to confirm the helper returns the clean message expected by callers.

*Call graph*: calls 1 internal fn (try_parse_error_message); 1 external calls (assert_eq!).


##### `tests::try_parse_error_message_falls_back_to_raw_text`  (lines 40–44)

```
fn try_parse_error_message_falls_back_to_raw_text()
```

**Purpose**: This test proves that the helper does not invent or discard information when the expected `error.message` field is missing. It confirms callers still get the original server text back.

**Data flow**: It creates JSON text that has a `message` field at the top level, but not the expected nested `error.message` field. It sends that text into `try_parse_error_message` and checks that the result is the unchanged input text.

**Call relations**: This test exercises the fallback path of `try_parse_error_message`. It helps ensure that token refresh and token revocation errors remain visible even when the server response is not in the expected OpenAI-style shape.

*Call graph*: calls 1 internal fn (try_parse_error_message); 1 external calls (assert_eq!).


### `login/src/pkce.rs`

`domain_logic` · `login startup`

This file implements PKCE, which stands for Proof Key for Code Exchange. In plain terms, PKCE is a safety check used during OAuth-style login. It is like giving the login provider a sealed clue at the start, then later proving you still have the original clue when the login comes back.

The file defines `PkceCodes`, a small container with two strings. The `code_verifier` is a random secret kept by this app. The `code_challenge` is a transformed version of that secret, safe to send to the login provider. The challenge is made by hashing the verifier with SHA-256, which turns text into a fixed-size fingerprint, then encoding it in URL-safe Base64, a text format that can travel safely in web addresses.

Without this file, the login server would not have the PKCE values it needs to start the login securely. That would weaken the flow because another program could try to reuse or intercept the login response. The important behavior is that every login attempt gets fresh random bytes, so the verifier and challenge are different each time.

#### Function details

##### `generate_pkce`  (lines 12–27)

```
fn generate_pkce() -> PkceCodes
```

**Purpose**: Creates a fresh PKCE verifier and matching challenge for one login attempt. The verifier is the secret the app keeps, and the challenge is the related value sent to the login provider.

**Data flow**: It starts with an empty 64-byte buffer, fills it with random data, and turns those bytes into a URL-safe Base64 string to become the `code_verifier`. It then hashes that verifier with SHA-256 and Base64-encodes the hash to make the `code_challenge`. It returns both strings together inside a `PkceCodes` value and does not change any outside state.

**Call relations**: When `run_login_server` is preparing a login flow, it calls `generate_pkce` to get the secret pair it needs. Inside this function, the random-number generator provides unpredictable bytes, and the SHA-256 digest function turns the verifier into the challenge that can be safely shared.

*Call graph*: called by 1 (run_login_server); 2 external calls (digest, rng).


### `ollama/src/url.rs`

`util` · `config load`

Ollama can be reached through different URL shapes. Some clients talk to an OpenAI-compatible endpoint, which commonly ends in `/v1`, while Ollama’s own host root does not need that suffix. This file keeps that small but important distinction in one place.

Think of it like removing the department name from a mailing address when you only need the building address. If a provider is configured as `http://localhost:11434/v1`, the OpenAI-compatible API lives under `/v1`, but the Ollama host itself is `http://localhost:11434`. Code that needs the host root should not have to guess or duplicate string cleanup rules.

The helpers first ignore harmless trailing slashes, so `.../v1/` is treated the same as `.../v1`. One function answers the yes-or-no question: “does this look like an OpenAI-compatible base URL?” The other returns a cleaned host root, removing `/v1` only when it is actually present at the end. A small test checks the common cases, including URLs with and without trailing slashes.

#### Function details

##### `is_openai_compatible_base_url`  (lines 2–4)

```
fn is_openai_compatible_base_url(base_url: &str) -> bool
```

**Purpose**: This function checks whether a configured base URL points to an OpenAI-compatible API root. In plain terms, it answers: “does this URL end with `/v1`, ignoring extra slashes at the end?”

**Data flow**: It receives a URL as text. It first removes any trailing `/` characters, then checks whether the remaining text ends with `/v1`. It returns `true` if it does, and `false` otherwise; it does not change anything outside itself.

**Call relations**: When provider configuration is being converted in `try_from_provider`, this helper is used to recognize the OpenAI-compatible URL shape. That lets the caller decide which kind of provider endpoint it is dealing with before continuing setup.

*Call graph*: called by 1 (try_from_provider).


##### `base_url_to_host_root`  (lines 8–18)

```
fn base_url_to_host_root(base_url: &str) -> String
```

**Purpose**: This function turns a configured provider base URL into the plain Ollama host root. It is useful when the input might include the OpenAI-style `/v1` suffix, but later code needs the underlying server address.

**Data flow**: It receives a URL as text. It removes trailing slashes, then, if the cleaned URL ends in `/v1`, it removes that suffix and cleans up any slash left behind. It returns the cleaned URL as a new string, leaving the input unchanged.

**Call relations**: During provider conversion, `try_from_provider` calls this function after reading the provider’s base URL. The cleaned host root it returns can then be passed along to code that needs to contact Ollama at its native root rather than at the OpenAI-compatible path.

*Call graph*: called by 1 (try_from_provider).


##### `tests::test_base_url_to_host_root`  (lines 25–38)

```
fn test_base_url_to_host_root()
```

**Purpose**: This test proves that `base_url_to_host_root` returns the expected host root for the main URL forms the project cares about. It protects against accidental changes that would leave `/v1` attached or fail to remove a trailing slash.

**Data flow**: It feeds several example URLs into `base_url_to_host_root`: one with `/v1`, one already at the host root, and one with a trailing slash. For each example, it compares the returned string with the expected cleaned URL using test assertions. The output is a passing or failing test result.

**Call relations**: This test is run by Rust’s test system, not by normal application code. It calls `assert_eq!` to check the helper’s behavior, giving future maintainers quick feedback if URL cleanup stops working as intended.

*Call graph*: 1 external calls (assert_eq!).


### `responses-api-proxy/src/read_api_key.rs`

`io_transport` · `startup`

This file solves a small but sensitive problem: the proxy needs an API key, but API keys are secrets. If this code were careless, the key could be copied into hidden buffers, left behind in memory, or accepted in a malformed form. The file reads the key from stdin, which means the caller can pipe it in from an environment variable or another command. It then adds the `Bearer ` prefix expected by HTTP Authorization headers.

The main routine reads into a fixed-size byte buffer, stops at a newline or end of input, trims trailing newline characters, and rejects empty input. It also checks that the key contains only simple safe characters: letters, numbers, hyphen, and underscore. Think of it like a secure mail slot: it accepts one secret, checks it is shaped correctly, then seals it in the form the rest of the program needs.

On Unix systems, it avoids Rust's usual buffered stdin because that could keep an extra hidden copy of the key. It reads directly from the operating system instead. After building the final header string, it wipes the temporary buffer and tries to lock the final string's memory so the operating system will not swap it to disk. Tests cover normal reads, split-up reads, newline trimming, empty input, oversized input, I/O errors, and invalid characters.

#### Function details

##### `read_auth_header_from_stdin`  (lines 21–30)

```
fn read_auth_header_from_stdin() -> Result<&'static str>
```

**Purpose**: This is the public helper used by the proxy startup code to get the API key from stdin and return it as a ready-to-use Authorization header. On Unix it uses the safer low-level stdin reader; on Windows it currently falls back to standard input reading.

**Data flow**: It takes no direct arguments. It chooses a platform-appropriate way to read bytes from stdin, passes that reader into `read_auth_header_with`, and returns either a leaked static header string such as `Bearer sk-...` or an error explaining why reading failed.

**Call relations**: During startup, `run_main` calls this function when the proxy needs credentials. This function does not do the parsing itself; it hands the actual read-and-validate work to `read_auth_header_with`.

*Call graph*: calls 1 internal fn (read_auth_header_with); called by 1 (run_main).


##### `read_from_unix_stdin`  (lines 41–70)

```
fn read_from_unix_stdin(buffer: &mut [u8]) -> std::io::Result<usize>
```

**Purpose**: This Unix-only helper reads raw bytes directly from stdin without using Rust's normal buffered stdin wrapper. It exists to avoid hidden extra copies of the API key in memory.

**Data flow**: It receives a mutable byte slice to fill. It asks the operating system to read into that exact slice, retries if the read was interrupted, and returns the number of bytes placed there, zero for end of input, or an I/O error.

**Call relations**: On Unix, `read_auth_header_from_stdin` supplies this function to `read_auth_header_with`. It relies on the operating system read call and checks `last_os_error` when that call reports a failure.

*Call graph*: 1 external calls (last_os_error).


##### `read_auth_header_with`  (lines 72–162)

```
fn read_auth_header_with(mut read_fn: F) -> Result<&'static str>
```

**Purpose**: This is the core routine that reads an API key, turns it into a `Bearer ...` header, validates it, wipes temporary memory, and protects the final string as much as the platform allows. Tests also use it with fake readers so they can check edge cases without real stdin.

**Data flow**: It receives a function that can fill a byte buffer with input. It first writes `Bearer ` into a local buffer, then reads the key after that prefix until it sees a newline, reaches end of input, or fills the buffer. It trims newline characters, rejects empty, oversized, or invalid keys, converts the bytes to text, copies the final header into a string, zeroes the temporary buffer, leaks the string so it can live for the rest of the process, tries to lock its memory with `mlock_str`, and returns the static string.

**Call relations**: `read_auth_header_from_stdin` calls this in real startup flow. The test functions call it with small custom read functions to simulate normal input, short reads, no input, errors, oversized input, and invalid bytes. Inside, it delegates key character checking to `validate_auth_header_bytes` and memory locking to `mlock_str`.

*Call graph*: calls 2 internal fn (mlock_str, validate_auth_header_bytes); called by 9 (read_auth_header_from_stdin, errors_on_invalid_characters, errors_on_invalid_utf8, errors_when_buffer_filled, errors_when_no_input_provided, propagates_io_error, reads_key_and_trims_newlines, reads_key_with_no_newlines, reads_key_with_short_reads); 3 external calls (from, anyhow!, from_utf8).


##### `mlock_str`  (lines 204–204)

```
fn mlock_str(_value: &str)
```

**Purpose**: This helper tries to keep the final Authorization header in physical memory so the operating system will not copy it to swap space on disk. On non-Unix platforms in this file, it does nothing.

**Data flow**: It receives the final header string. On Unix, it calculates the memory pages that contain that string and asks the operating system to lock those pages; it does not return an error if locking fails. On non-Unix systems, the input is ignored and nothing changes.

**Call relations**: `read_auth_header_with` calls this after it has built and leaked the final header string. It is the last protective step after the temporary buffer has already been wiped.

*Call graph*: called by 1 (read_auth_header_with).


##### `validate_auth_header_bytes`  (lines 208–219)

```
fn validate_auth_header_bytes(key_bytes: &[u8]) -> Result<()>
```

**Purpose**: This function checks that the API key contains only allowed plain ASCII characters: letters, numbers, hyphen, or underscore. This prevents surprising bytes such as null characters, punctuation, or invalid text from becoming part of an HTTP header.

**Data flow**: It receives the bytes of the key without the `Bearer ` prefix. It scans every byte and returns success if all bytes match the allowed set; otherwise it returns an error message saying what characters are permitted.

**Call relations**: `read_auth_header_with` calls this after trimming the input and before converting the full header to UTF-8 text. If validation fails, the caller wipes the temporary buffer and stops.

*Call graph*: called by 1 (read_auth_header_with); 1 external calls (anyhow!).


##### `tests::reads_key_with_no_newlines`  (lines 228–242)

```
fn reads_key_with_no_newlines()
```

**Purpose**: This test confirms that a key does not need to end with a newline. A single chunk of input followed by end-of-file should still produce a valid `Bearer ...` header.

**Data flow**: It feeds `sk-abc123` into `read_auth_header_with` through a fake reader. The function returns a header string, and the test checks that it exactly equals `Bearer sk-abc123`.

**Call relations**: The test directly exercises `read_auth_header_with` with controlled input. It verifies the normal success path used indirectly by `read_auth_header_from_stdin` during startup.

*Call graph*: calls 1 internal fn (read_auth_header_with); 1 external calls (assert_eq!).


##### `tests::reads_key_with_short_reads`  (lines 245–258)

```
fn reads_key_with_short_reads()
```

**Purpose**: This test confirms that the reader can handle input arriving in several small pieces. That matters because real I/O is not guaranteed to deliver all bytes at once.

**Data flow**: It gives `read_auth_header_with` three chunks: `sk-`, `abc`, and `123\n`. The function joins what it reads, stops at the newline, trims it, and returns `Bearer sk-abc123`, which the test checks.

**Call relations**: The test calls `read_auth_header_with` with a fake chunked reader. It protects the loop inside that function from regressions where only the first read would be used.

*Call graph*: calls 1 internal fn (read_auth_header_with); 3 external calls (from, assert_eq!, vec!).


##### `tests::reads_key_and_trims_newlines`  (lines 261–275)

```
fn reads_key_and_trims_newlines()
```

**Purpose**: This test checks that common line endings are removed from the key. This lets users pipe values from shell commands that naturally add `\n` or `\r\n`.

**Data flow**: It feeds `sk-abc123\r\n` into `read_auth_header_with`. The function trims the carriage return and newline, returns `Bearer sk-abc123`, and the test compares that result to the expected string.

**Call relations**: The test calls `read_auth_header_with` and focuses on its trimming step. It supports the real stdin path, where users often provide secrets one line at a time.

*Call graph*: calls 1 internal fn (read_auth_header_with); 1 external calls (assert_eq!).


##### `tests::errors_when_no_input_provided`  (lines 278–282)

```
fn errors_when_no_input_provided()
```

**Purpose**: This test confirms that empty stdin is treated as a clear error instead of creating an unusable `Bearer ` header with no key.

**Data flow**: It gives `read_auth_header_with` a fake reader that immediately reports end-of-input. The function returns an error, and the test checks that the message tells the user an API key must be provided.

**Call relations**: The test calls `read_auth_header_with` directly. It verifies the failure path that `read_auth_header_from_stdin` would expose if startup received no key.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


##### `tests::errors_when_buffer_filled`  (lines 285–296)

```
fn errors_when_buffer_filled()
```

**Purpose**: This test makes sure an API key that fills the entire allowed space without a newline or end-of-input is rejected as too large. This prevents silent truncation, where the program would use only part of the secret.

**Data flow**: It fills the available token area of the buffer with `a` bytes. `read_auth_header_with` sees that the buffer is full without a stopping point, returns a size error, and the test checks for that message.

**Call relations**: The test calls `read_auth_header_with` with oversized simulated input. It protects the code's safety rule that too-long keys must fail loudly instead of being cut off.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


##### `tests::propagates_io_error`  (lines 299–305)

```
fn propagates_io_error()
```

**Purpose**: This test confirms that read failures are not hidden or rewritten beyond recognition. If stdin reading fails, callers should be able to see the original I/O error.

**Data flow**: It gives `read_auth_header_with` a fake reader that returns an I/O error saying `boom`. The function returns that error, and the test checks that the error kind and message are preserved.

**Call relations**: The test calls `read_auth_header_with` directly. It verifies the path where the supplied reader fails before a usable key can be built.

*Call graph*: calls 1 internal fn (read_auth_header_with); 1 external calls (assert_eq!).


##### `tests::errors_on_invalid_utf8`  (lines 308–323)

```
fn errors_on_invalid_utf8()
```

**Purpose**: This test checks that non-text or otherwise invalid bytes are rejected before they can become part of the Authorization header.

**Data flow**: It feeds bytes containing `0xff` into `read_auth_header_with`. The validation step rejects the byte because it is not an allowed ASCII letter, number, hyphen, or underscore, and the test checks for the expected error message.

**Call relations**: The test drives `read_auth_header_with`, which in turn uses `validate_auth_header_bytes`. It confirms invalid byte input is stopped before UTF-8 conversion and header creation.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


##### `tests::errors_on_invalid_characters`  (lines 326–341)

```
fn errors_on_invalid_characters()
```

**Purpose**: This test confirms that punctuation outside the allowed key format is rejected. For example, an exclamation mark should not be accepted in the API key.

**Data flow**: It feeds `sk-abc!23` into `read_auth_header_with`. The validation step finds the `!`, returns an error, and the test checks that the error explains the allowed character set.

**Call relations**: The test calls `read_auth_header_with` and indirectly checks `validate_auth_header_bytes`. It protects the rule that only simple safe key characters may enter the final header.

*Call graph*: calls 1 internal fn (read_auth_header_with); 2 external calls (assert!, format!).


### `rmcp-client/src/utils.rs`

`util` · `server launch and HTTP client setup`

An MCP server is an external helper process or service that the client talks to. Before starting or contacting one, the client needs two kinds of setup: the right environment variables, and the right HTTP headers. This file is the small toolbox for that setup.

For local stdio servers, it builds a safe environment by copying a short allowlist of familiar variables such as PATH, HOME, and LANG, then adding any extra variables named in the MCP configuration, and finally applying explicit overrides. This is like packing a travel bag with only the essentials, plus anything the user specifically asked for. It also rejects variables marked as coming from a remote source, because those only make sense when the server runs somewhere else.

For remote stdio servers, it is more careful. It does not copy PATH or HOME from the orchestrator process, because those belong to the wrong machine. Instead, it forwards only locally sourced variables explicitly named in the configuration, plus literal overrides.

The HTTP side turns configured header names and values into reqwest header objects. Invalid names or values are skipped with a warning rather than crashing the whole setup. The file also includes tests that temporarily change environment variables and then restore them, so the tests do not leak state into each other.

#### Function details

##### `create_env_for_mcp_server`  (lines 12–25)

```
fn create_env_for_mcp_server(
    extra_env: Option<HashMap<OsString, OsString>>,
    env_vars: &[McpServerEnvVar],
) -> Result<HashMap<OsString, OsString>>
```

**Purpose**: Builds the environment map for a local MCP server process. It copies a default safe set of variables, adds extra configured variables, and lets explicit overrides win.

**Data flow**: It receives optional override variables and a list of configured environment-variable requests. It first asks local_stdio_env_var_names to confirm that none are marked as remote-only. Then it reads the allowed variables from the current process environment, merges in the overrides, and returns the finished map or an error.

**Call relations**: This is used when a local server is created or launched, including from new and launch_server. The tests call it to prove overrides work, extra allowlisted variables are included, non-UTF-8 PATH values are preserved, and remote-only variables are rejected before a local process is started.

*Call graph*: calls 1 internal fn (local_stdio_env_var_names); called by 6 (new, launch_server, create_env_honors_overrides, create_env_includes_additional_whitelisted_variables, create_env_preserves_path_when_it_is_not_utf8, create_local_env_rejects_remote_source_variables).


##### `create_env_overlay_for_remote_mcp_server`  (lines 27–40)

```
fn create_env_overlay_for_remote_mcp_server(
    extra_env: Option<HashMap<OsString, OsString>>,
    env_vars: &[McpServerEnvVar],
) -> HashMap<OsString, OsString>
```

**Purpose**: Builds only the environment overlay that should be sent for a remote MCP stdio server. It avoids copying machine-local defaults like PATH or HOME from the orchestrator, because those may be wrong on the remote executor.

**Data flow**: It receives optional overrides and configured environment-variable requests. It reads values only for variables whose source is not marked remote, combines those with explicit overrides, and returns the resulting map.

**Call relations**: launch_server uses this when the MCP server will run remotely. The related tests check that default variables are not copied by accident and that variables marked as remote-source are left for the remote side instead of being read locally.

*Call graph*: called by 3 (launch_server, create_remote_env_overlay_does_not_copy_remote_source_variables, create_remote_env_overlay_only_forwards_explicit_variables); 1 external calls (iter).


##### `remote_mcp_env_var_names`  (lines 42–48)

```
fn remote_mcp_env_var_names(env_vars: &[McpServerEnvVar]) -> Vec<String>
```

**Purpose**: Extracts the names of configured environment variables that must be supplied by the remote side. This lets the launch flow tell the remote executor which variables it should look up there.

**Data flow**: It receives the configured environment-variable list. It filters that list down to entries marked with source remote, converts their names into strings, and returns those names.

**Call relations**: launch_server calls this as part of preparing a remote MCP server. Its test checks that legacy and local entries are ignored while the remote entry is returned.

*Call graph*: called by 2 (launch_server, remote_mcp_env_var_names_returns_remote_source_names); 1 external calls (iter).


##### `local_stdio_env_var_names`  (lines 50–58)

```
fn local_stdio_env_var_names(env_vars: &[McpServerEnvVar]) -> Result<impl Iterator<Item = &str>>
```

**Purpose**: Checks which configured environment variables may be copied for a local stdio MCP server. It prevents remote-only variables from being used in the wrong launch mode.

**Data flow**: It receives a list of configured environment-variable requests. If any entry is marked as remote-source, it returns an explanatory error. Otherwise, it returns an iterator over the variable names.

**Call relations**: create_env_for_mcp_server calls this before reading environment values. That keeps local launch setup honest: remote-source entries must go through the remote stdio path instead.

*Call graph*: called by 1 (create_env_for_mcp_server); 2 external calls (anyhow!, iter).


##### `build_default_headers`  (lines 60–116)

```
fn build_default_headers(
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: Option<HashMap<String, String>>,
) -> Result<HeaderMap>
```

**Purpose**: Creates the default HTTP headers that should be attached to MCP HTTP requests. It supports both literal configured header values and values read from environment variables, such as tokens.

**Data flow**: It receives optional static headers and optional mappings from header names to environment-variable names. It validates each header name and value, reads environment-backed values when available and non-empty, skips invalid entries with a warning, and returns a reqwest HeaderMap.

**Call relations**: This is used during HTTP setup in new, create_pending_transport, determine_streamable_http_auth_status, and discover_streamable_http_oauth. It prepares a clean header set before later code decides how to connect or authenticate.

*Call graph*: called by 4 (determine_streamable_http_auth_status, discover_streamable_http_oauth, new, create_pending_transport); 5 external calls (new, from_bytes, from_str, var, warn!).


##### `apply_default_headers`  (lines 118–127)

```
fn apply_default_headers(
    builder: ClientBuilder,
    default_headers: &HeaderMap,
) -> ClientBuilder
```

**Purpose**: Adds a prepared set of default headers to a reqwest HTTP client builder, but only when there are headers to add. This avoids changing the builder unnecessarily.

**Data flow**: It receives a ClientBuilder and a HeaderMap. If the map is empty, it returns the builder unchanged. Otherwise, it clones the headers into the builder and returns the updated builder.

**Call relations**: This is called by flows that build HTTP clients, including new, discover_streamable_http_oauth_with_headers, and create_oauth_transport_and_runtime. It takes the header map prepared earlier and attaches it at the last step where the HTTP client is being assembled.

*Call graph*: called by 3 (discover_streamable_http_oauth_with_headers, new, create_oauth_transport_and_runtime); 3 external calls (default_headers, clone, is_empty).


##### `tests::EnvVarGuard::set`  (lines 162–171)

```
fn set(key: &str, value: impl AsRef<OsStr>) -> Self
```

**Purpose**: Temporarily sets an environment variable for a test while remembering its previous value. It lets tests change process-wide environment state safely.

**Data flow**: It receives a variable name and a value. It reads and stores the current value, sets the new value, and returns an EnvVarGuard that owns the saved state.

**Call relations**: Several tests call this before exercising environment-building functions. The returned guard later restores the old value through tests::EnvVarGuard::drop when the test scope ends.

*Call graph*: 3 external calls (as_ref, set_var, var_os).


##### `tests::EnvVarGuard::drop`  (lines 175–185)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable after a test finishes. This prevents one test’s temporary environment changes from affecting later tests.

**Data flow**: It reads the saved original value inside the guard. If there was an original value, it sets the variable back to that value; if not, it removes the variable.

**Call relations**: Rust calls this automatically when an EnvVarGuard goes out of scope. It completes the cleanup for tests that used tests::EnvVarGuard::set.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::create_env_honors_overrides`  (lines 189–198)

```
async fn create_env_honors_overrides()
```

**Purpose**: Checks that explicit environment overrides take priority when building a local MCP server environment. This matters because user configuration should be able to replace inherited defaults.

**Data flow**: It creates an override for TZ, calls create_env_for_mcp_server with that override, and then checks that the returned environment contains the override value.

**Call relations**: This test exercises create_env_for_mcp_server directly. It verifies the merge order used by the local launch setup.

*Call graph*: calls 1 internal fn (create_env_for_mcp_server); 3 external calls (from, from, assert_eq!).


##### `tests::create_env_includes_additional_whitelisted_variables`  (lines 202–210)

```
fn create_env_includes_additional_whitelisted_variables()
```

**Purpose**: Checks that a configured extra environment variable is copied into the local MCP server environment. This lets users deliberately pass through variables beyond the built-in defaults.

**Data flow**: It temporarily sets an environment variable, asks create_env_for_mcp_server to include that variable, and checks that the returned map contains the expected value.

**Call relations**: It uses tests::EnvVarGuard::set to safely alter the test environment, then calls create_env_for_mcp_server to confirm configured local pass-through variables are honored.

*Call graph*: calls 2 internal fn (set, create_env_for_mcp_server); 2 external calls (from, assert_eq!).


##### `tests::create_remote_env_overlay_only_forwards_explicit_variables`  (lines 214–228)

```
fn create_remote_env_overlay_only_forwards_explicit_variables()
```

**Purpose**: Checks that remote MCP environment overlays do not include default local variables automatically. This protects remote launches from accidentally receiving PATH, HOME, or similar values from the orchestrator machine.

**Data flow**: It temporarily sets one default variable and one custom variable. It asks create_env_overlay_for_remote_mcp_server to build an overlay for only the custom variable, then checks that only the custom variable appears.

**Call relations**: It uses tests::EnvVarGuard::set for temporary environment changes and then tests create_env_overlay_for_remote_mcp_server’s remote-specific filtering behavior.

*Call graph*: calls 2 internal fn (set, create_env_overlay_for_remote_mcp_server); 2 external calls (from, assert_eq!).


##### `tests::create_remote_env_overlay_does_not_copy_remote_source_variables`  (lines 232–257)

```
fn create_remote_env_overlay_does_not_copy_remote_source_variables()
```

**Purpose**: Checks that variables marked as remote-source are not read from the local process environment. They should be supplied by the remote executor instead.

**Data flow**: It temporarily sets both a remote-marked variable and a local-marked variable. It calls create_env_overlay_for_remote_mcp_server with both entries and checks that only the local-marked variable is copied.

**Call relations**: This test focuses on the source flag used by create_env_overlay_for_remote_mcp_server. It proves the remote launch path separates local-sourced and remote-sourced variables correctly.

*Call graph*: calls 2 internal fn (set, create_env_overlay_for_remote_mcp_server); 2 external calls (from, assert_eq!).


##### `tests::remote_mcp_env_var_names_returns_remote_source_names`  (lines 260–274)

```
fn remote_mcp_env_var_names_returns_remote_source_names()
```

**Purpose**: Checks that only remote-source environment variable names are returned for remote lookup. Local and legacy entries should not be included in that list.

**Data flow**: It builds a small list containing legacy, local-source, and remote-source entries. It calls remote_mcp_env_var_names and checks that the result contains only the remote name.

**Call relations**: This directly tests remote_mcp_env_var_names, which launch_server uses to tell the remote executor what environment names it should resolve.

*Call graph*: calls 1 internal fn (remote_mcp_env_var_names); 1 external calls (assert_eq!).


##### `tests::create_local_env_rejects_remote_source_variables`  (lines 277–291)

```
fn create_local_env_rejects_remote_source_variables()
```

**Purpose**: Checks that local MCP environment creation refuses variables marked as remote-source. This prevents a misleading configuration from being silently interpreted on the wrong machine.

**Data flow**: It calls create_env_for_mcp_server with a remote-source variable. It expects an error and checks that the error message explains that remote MCP stdio is required.

**Call relations**: This test verifies the guardrail enforced by local_stdio_env_var_names through create_env_for_mcp_server.

*Call graph*: calls 1 internal fn (create_env_for_mcp_server); 1 external calls (assert!).


##### `tests::create_env_preserves_path_when_it_is_not_utf8`  (lines 296–307)

```
fn create_env_preserves_path_when_it_is_not_utf8()
```

**Purpose**: Checks that the local environment builder preserves a PATH value even when it is not valid UTF-8 text. This matters on Unix systems, where environment values can be arbitrary bytes.

**Data flow**: It creates a raw byte PATH value, temporarily sets PATH to that value, calls create_env_for_mcp_server, and checks that the exact byte value is still present in the returned environment.

**Call relations**: This Unix-only test uses tests::EnvVarGuard::set and then exercises create_env_for_mcp_server. It confirms the code uses OsString-style values rather than forcing everything into normal text strings.

*Call graph*: calls 2 internal fn (set, create_env_for_mcp_server); 2 external calls (assert_eq!, from_bytes).


### Configuration normalization primitives
This group provides the shared building blocks for labeling, constraining, renaming, converting, and overriding configuration values across interfaces.

### `config/src/config_layer_source.rs`

`util` · `config load and reporting`

Configuration can come from several places, and that can be confusing for a person trying to understand why the program behaves a certain way. This file solves that by giving each configuration source a short, readable name. Think of it like labeling boxes in a storage room: instead of seeing an internal code, you see “user (/path/to/file)” or “project (/path/.codex/config.toml)”.

The main idea is simple. The function receives a `ConfigLayerSource`, which is an enum: a value that can be one of several named choices. Each choice represents a different origin for configuration, such as mobile device management policy, a system file, an enterprise-managed setting, a user config file, a project config folder, command-line session flags, or legacy managed config locations.

For each possible source, the function builds a string that includes the source type and, when useful, identifying details like a file path, policy domain and key, or enterprise name and ID. The project case also receives the expected config file name separately, so it can show the full project config path. Without this helper, different parts of the program might describe the same source in inconsistent or unclear ways.

#### Function details

##### `format_config_layer_source`  (lines 3–31)

```
fn format_config_layer_source(source: &ConfigLayerSource, config_toml_file: &str) -> String
```

**Purpose**: This function makes a readable label for a configuration source. Someone would use it when they need to show a person where a setting came from, instead of exposing the program’s internal representation.

**Data flow**: It receives a `ConfigLayerSource`, meaning the recorded origin of some configuration, plus the filename used for the main config TOML file. It checks which kind of source it is, pulls out useful details such as file paths, policy names, or IDs, and returns one finished text string. It does not change the source or write anything anywhere.

**Call relations**: Inside this file, the function’s only work is building strings using Rust’s formatting macro. The call graph shows it calling `format!` to assemble those labels; no callers are listed here, so it acts as a reusable helper for whichever part of the configuration system needs to present source information to a human.

*Call graph*: 1 external calls (format!).


### `config/src/constraint.rs`

`config` · `config load and configuration updates`

Configuration often has limits: a field may have to be non-empty, a mode may have to come from an approved list, or a value may need to be forced into a safe form before use. This file provides the shared tool for that: `Constrained<T>`, a wrapper around any value `T` that keeps the value together with the rule used to check it. Think of it like a gate in front of a setting: every new value must pass through the gate before it can replace the old one.

The file also defines `ConstraintError`, the standard way to explain why a value was rejected. These errors include a bad value, an empty field, or invalid requirement rules. They carry enough detail to tell the user which field failed and, when relevant, where the rule came from.

`Constrained` can be used in several ways. It can accept anything, accept only one fixed value, validate with a custom rule, or normalize values first. A normalizer is a small cleanup step that transforms a value into the form the program wants, such as turning a negative number into zero, before validation. The important safety behavior is that `set` checks the candidate first and only changes the stored value if the check passes. That prevents a bad update from corrupting the current configuration.

#### Function details

##### `ConstraintError::empty_field`  (lines 30–34)

```
fn empty_field(field_name: impl Into<String>) -> Self
```

**Purpose**: Creates a standard error saying that a named configuration field was left empty. This gives callers a short, consistent way to report missing required text or data.

**Data flow**: It receives a field name in any form that can become a string. It converts that name into a stored string and returns a `ConstraintError::EmptyField` containing it.

**Call relations**: Configuration conversion code calls this when building constrained settings and discovers that a required field has no value. It does not call other project code; it only converts the provided name into owned text.

*Call graph*: called by 1 (try_from); 1 external calls (into).


##### `Error::from`  (lines 40–42)

```
fn from(err: ConstraintError) -> Self
```

**Purpose**: Turns a `ConstraintError` into a standard input/output error. This lets constraint failures be returned through APIs that expect `std::io::Error` instead of this crate's custom error type.

**Data flow**: It receives a constraint error. It wraps that error inside a standard I/O error marked as invalid input, then returns the wrapped error.

**Call relations**: This is used automatically by Rust's conversion system when code needs to treat a configuration constraint failure like a general invalid-input error. It hands the original error message to the standard library's error constructor.

*Call graph*: 1 external calls (new).


##### `Constrained::new`  (lines 58–69)

```
fn new(
        initial_value: T,
        validator: impl Fn(&T) -> ConstraintResult<()> + Send + Sync + 'static,
    ) -> ConstraintResult<Self>
```

**Purpose**: Creates a constrained value with a caller-provided validation rule. It is used when a configuration value must be checked before it is accepted.

**Data flow**: It receives an initial value and a validator function. It stores the validator in shared form, runs it against the initial value, and returns either a ready `Constrained` value or the validation error. If the initial value fails, nothing is created.

**Call relations**: Many configuration-building paths call this when turning raw config into safer, rule-checked settings. Tests also call it to prove invalid starting values are rejected, later updates are checked, and validators can be combined.

*Call graph*: called by 13 (try_from, constrained_add_validator_composes_with_existing_validator, constrained_can_set_allows_probe_without_setting, constrained_new_rejects_invalid_initial_value, constrained_set_rejects_invalid_value_and_leaves_previous, derive_sandbox_policy_falls_back_to_read_only_for_implicit_defaults, derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback, test_requirements_web_search_mode_allowlist_does_not_warn_when_unset, web_search_mode_for_turn_falls_back_when_live_is_disallowed, from_constrained_resolved (+3 more)); 1 external calls (new).


##### `Constrained::normalized`  (lines 72–85)

```
fn normalized(
        initial_value: T,
        normalizer: impl Fn(T) -> T + Send + Sync + 'static,
    ) -> ConstraintResult<Self>
```

**Purpose**: Creates a constrained value that first rewrites values into an acceptable form. This is useful when a setting should be automatically cleaned up or forced into a safe range instead of simply rejected.

**Data flow**: It receives an initial value and a normalizer function. It applies the normalizer to the initial value, uses an always-accepting validator, stores both the normalized value and the normalizer, and returns the constrained value.

**Call relations**: Code that constrains MCP server configuration uses this when values need automatic adjustment. The related test shows that the same normalizer is applied both at creation time and when setting a new value.

*Call graph*: called by 2 (constrained_normalizer_applies_on_init_and_set, constrain_mcp_servers); 1 external calls (new).


##### `Constrained::allow_any`  (lines 87–93)

```
fn allow_any(initial_value: T) -> Self
```

**Purpose**: Creates a constrained value that accepts every future value. This is used when the rest of the system expects a `Constrained` wrapper, but this particular setting has no extra rule.

**Data flow**: It receives an initial value. It stores that value with a validator that always says yes and no normalizer, then returns the wrapper immediately.

**Call relations**: Many parts of the system use this for settings or cached data that need the common constrained-value shape without actual restrictions. Tests use it to confirm that any replacement value is accepted.

*Call graph*: called by 39 (list_all_tools_accepts_canonical_namespaced_tool_names, list_all_tools_adds_server_metadata_to_cached_tools, list_all_tools_applies_legacy_mcp_prefix_by_default, list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot, list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending, list_available_server_infos_uses_cache_while_client_is_pending, no_local_runtime_fails_local_stdio_but_keeps_local_http_server, shutdown_cancels_pending_tool_listing (+15 more)); 1 external calls (new).


##### `Constrained::allow_only`  (lines 95–116)

```
fn allow_only(only_value: T) -> Self
```

**Purpose**: Creates a constrained value that can only ever be set to one specific value. This is useful when requirements lock a setting so later code cannot change it to something else.

**Data flow**: It receives the only allowed value. It clones that value for comparison, stores the original as the current value, and builds a validator that rejects every candidate except the allowed one with an `InvalidValue` error.

**Call relations**: Permission and sandbox configuration code calls this when a session or requirement fixes a setting. Tests confirm that the allowed value still works and any different value is rejected while the old value remains unchanged.

*Call graph*: called by 8 (resolve_allowed_windows_sandbox_setup_mode_rejects_disallowed_mode, constrained_allow_only_rejects_different_values, replace_permission_profile_from_session_snapshot, permission_snapshot_setter_preserves_permission_constraints, build_guardian_review_session_config, start_review_conversation, get_config, on_session_configured_with_display_and_fork_parent_title); 2 external calls (new, clone).


##### `Constrained::allow_any_from_default`  (lines 119–124)

```
fn allow_any_from_default() -> Self
```

**Purpose**: Creates an unrestricted constrained value using the type's default value as its starting point. This is a convenience for settings where the normal default is acceptable and no rule is needed.

**Data flow**: It asks the inner type for its default value, then passes that value to `allow_any`. The result is a `Constrained` wrapper that accepts any later value.

**Call relations**: Default-building and conversion code call this when a setting should start from its normal default. The test verifies that, for an integer, the stored starting value is zero.

*Call graph*: called by 2 (default, try_from); 2 external calls (allow_any, default).


##### `Constrained::get`  (lines 126–128)

```
fn get(&self) -> &T
```

**Purpose**: Returns a shared reference to the stored value without copying it. This is used when callers need to inspect larger or non-copyable configuration data safely.

**Data flow**: It receives the constrained wrapper by reference. It returns a reference to the inner value and does not change anything.

**Call relations**: Configuration snapshot and permission-profile code call this when they need to read the current constrained setting. It keeps the constraint wrapper in place while letting other code look at the value.

*Call graph*: called by 7 (new_uninitialized, to_mcp_config_with_plugin_registrations, active_permission_profile, from_constrained_active_profile, from_constrained_legacy, permission_profile, profile_workspace_roots).


##### `Constrained::value`  (lines 130–135)

```
fn value(&self) -> T
```

**Purpose**: Returns a copied version of the stored value for small copyable types. This is a convenience for simple settings such as numbers, booleans, or small enums.

**Data flow**: It receives the constrained wrapper by reference. Because the inner type can be copied, it returns a copy of the current value and leaves the stored value unchanged.

**Call relations**: Runtime configuration code calls this when it needs the current setting to build thread snapshots, turn context, approval policy, or web-search decisions. It is the read path for simple constrained values.

*Call graph*: called by 6 (new, new_uninitialized_with_permission_profile, set_approval_policy, resolve_web_search_mode_for_turn, thread_config_snapshot, to_turn_context_item).


##### `Constrained::can_set`  (lines 137–139)

```
fn can_set(&self, candidate: &T) -> ConstraintResult<()>
```

**Purpose**: Checks whether a candidate value would be accepted without actually changing the stored value. This is useful for asking, 'would this update be legal?' before deciding what to do.

**Data flow**: It receives a reference to a candidate value. It runs the stored validator on that candidate and returns success or the validation error, while leaving the current value untouched.

**Call relations**: Decision-making code uses this to test possible web-search or permission-profile changes before applying them. The test confirms that rejected candidates do not alter the existing value.

*Call graph*: called by 2 (resolve_web_search_mode_for_turn, can_set_legacy_permission_profile).


##### `Constrained::add_validator`  (lines 144–160)

```
fn add_validator(
        &mut self,
        validator: impl Fn(&T) -> ConstraintResult<()> + Send + Sync + 'static,
    ) -> ConstraintResult<()>
```

**Purpose**: Adds another validation rule on top of the rule already attached to a constrained value. This lets configuration become stricter over time while preserving the old checks.

**Data flow**: It receives a new validator. It builds a combined validator that first runs the existing rule and then the new one, checks that the current stored value passes both, and only then installs the combined rule.

**Call relations**: This function is a helper for code that needs layered requirements. The related test shows the intended story: start with one rule, add another, and then candidates must satisfy both.

*Call graph*: 1 external calls (new).


##### `Constrained::set`  (lines 162–171)

```
fn set(&mut self, value: T) -> ConstraintResult<()>
```

**Purpose**: Attempts to replace the stored value while respecting the constraint. It is the safe update path for constrained configuration.

**Data flow**: It receives a new value. If a normalizer exists, it rewrites the value first; then it runs the validator. If validation succeeds, it stores the new value and returns success. If validation fails, it returns the error and keeps the old value.

**Call relations**: Permission-profile update code calls this when applying requested changes. Tests cover the key safety behavior: invalid updates are rejected and the previous value remains in place.

*Call graph*: called by 2 (set_legacy_permission_profile, set_permission_profile_snapshot).


##### `Constrained::deref`  (lines 177–179)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets a `Constrained<T>` be read like a reference to its inner `T` in places where Rust supports automatic dereferencing. This makes the wrapper less awkward to use while still protecting updates.

**Data flow**: It receives the wrapper by reference and returns a reference to the stored value. It does not validate or change anything.

**Call relations**: This is used implicitly by Rust when code treats a constrained value like its inner value for reading. It supports convenient access without bypassing the checked `set` path for writes.


##### `Constrained::fmt`  (lines 183–187)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a constrained value appears in debug output. It shows the stored value but not the validator or normalizer functions, which are not useful to print.

**Data flow**: It receives a formatter and the constrained value. It builds a debug structure named `Constrained`, includes the current `value` field, and writes that representation to the formatter.

**Call relations**: Rust's debug-printing tools call this when developers log or inspect a `Constrained` value. It hands formatting work to the standard debug builder.

*Call graph*: 1 external calls (debug_struct).


##### `Constrained::eq`  (lines 191–193)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Defines equality for constrained values by comparing only their stored values. Two wrappers are considered equal if the values inside are equal, even if their validation functions differ.

**Data flow**: It receives two constrained values. It compares their inner values and returns true or false.

**Call relations**: Rust's equality checks and assertions use this when comparing constrained values. This is especially useful in tests and snapshots where the meaningful part is the current stored setting.


##### `tests::invalid_value`  (lines 201–208)

```
fn invalid_value(candidate: impl Into<String>, allowed: impl Into<String>) -> ConstraintError
```

**Purpose**: Builds the expected `InvalidValue` error used by the tests. It avoids repeating the same error construction in every test case.

**Data flow**: It receives a candidate value and an allowed-values description as string-like inputs. It converts both into owned strings and returns a `ConstraintError::InvalidValue` with an unknown field and unknown requirement source.

**Call relations**: The test functions call this helper when checking that rejection errors are exactly what they expect. It mirrors the error shape produced by constrained validators in the tests.

*Call graph*: 1 external calls (into).


##### `tests::constrained_allow_any_accepts_any_value`  (lines 211–217)

```
fn constrained_allow_any_accepts_any_value()
```

**Purpose**: Checks that an unrestricted constrained value really accepts a replacement value. This protects the simple 'no rule' case from accidentally becoming restrictive.

**Data flow**: It creates a constrained integer starting at 5 with `allow_any`, sets it to -10, and then reads the stored value. The expected result is that the stored value becomes -10.

**Call relations**: This test drives `Constrained::allow_any` and then the update path through `set`. It uses an assertion to confirm the wrapper accepted the new value.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (assert_eq!).


##### `tests::constrained_allow_any_default_uses_default_value`  (lines 220–223)

```
fn constrained_allow_any_default_uses_default_value()
```

**Purpose**: Checks that the default-based constructor starts with the type's normal default value. For integers, that default is zero.

**Data flow**: It creates an unrestricted constrained `i32` using `allow_any_from_default`, reads the copied value, and compares it to 0.

**Call relations**: This test exercises the convenience constructor that delegates to the unrestricted constructor. It confirms default initialization works as expected.

*Call graph*: 2 external calls (allow_any_from_default, assert_eq!).


##### `tests::constrained_allow_only_rejects_different_values`  (lines 226–237)

```
fn constrained_allow_only_rejects_different_values()
```

**Purpose**: Checks that a value locked to one allowed choice rejects any different value. It also confirms that a failed update does not change the stored value.

**Data flow**: It creates a constrained value that only allows 5, successfully sets 5, then tries to set 6. The attempt returns an `InvalidValue` error, and the stored value remains 5.

**Call relations**: This test drives `Constrained::allow_only` and the `set` path. It verifies the fixed-value rule that permission and session configuration code relies on.

*Call graph*: calls 1 internal fn (allow_only); 1 external calls (assert_eq!).


##### `tests::constrained_normalizer_applies_on_init_and_set`  (lines 240–249)

```
fn constrained_normalizer_applies_on_init_and_set() -> anyhow::Result<()>
```

**Purpose**: Checks that a normalizer is applied both when the constrained value is created and when it is updated later. This proves cleanup is not a one-time operation.

**Data flow**: It creates a normalized integer where negative values become zero. The initial -1 becomes 0, setting -5 also leaves 0, and setting 10 stores 10.

**Call relations**: This test exercises `Constrained::normalized` and later updates through `set`. It shows how the normalizer sits before storage every time.

*Call graph*: calls 1 internal fn (normalized); 1 external calls (assert_eq!).


##### `tests::constrained_add_validator_composes_with_existing_validator`  (lines 252–279)

```
fn constrained_add_validator_composes_with_existing_validator() -> anyhow::Result<()>
```

**Purpose**: Checks that adding a validator keeps the old rule and adds the new one. A candidate must pass both rules to be accepted.

**Data flow**: It creates a constrained integer that must be at least 0, then adds a second rule requiring it to be at most 10. It probes 7, 11, and -1, expecting only 7 to pass.

**Call relations**: This test starts with `Constrained::new`, then uses `add_validator` and `can_set`. It confirms validators are composed rather than replaced.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::constrained_new_rejects_invalid_initial_value`  (lines 282–292)

```
fn constrained_new_rejects_invalid_initial_value()
```

**Purpose**: Checks that construction fails if the starting value does not satisfy the validator. This prevents invalid configuration from entering the system at creation time.

**Data flow**: It tries to create a constrained integer with initial value 0 while the validator only allows positive values. The result is an `InvalidValue` error instead of a constructed wrapper.

**Call relations**: This test directly exercises `Constrained::new`. It proves the initial value goes through the same kind of gate as later updates.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::constrained_set_rejects_invalid_value_and_leaves_previous`  (lines 295–310)

```
fn constrained_set_rejects_invalid_value_and_leaves_previous()
```

**Purpose**: Checks that a rejected update does not overwrite the last valid value. This is the main safety guarantee of the `set` method.

**Data flow**: It creates a constrained integer starting at 1 with a positive-only rule. It tries to set -5, receives an `InvalidValue` error, and then confirms the stored value is still 1.

**Call relations**: This test uses `Constrained::new` to establish the rule, then tests the update behavior of `set`. It protects callers that rely on failed updates being harmless.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::constrained_can_set_allows_probe_without_setting`  (lines 313–331)

```
fn constrained_can_set_allows_probe_without_setting()
```

**Purpose**: Checks that `can_set` can test possible values without changing the current value. This supports decision code that needs to preview whether an update would be legal.

**Data flow**: It creates a positive-only constrained integer starting at 1. It probes 2 and gets success, probes -1 and gets an error, then confirms the stored value remains 1.

**Call relations**: This test uses `Constrained::new` and then the non-mutating check path through `can_set`. It confirms probing and setting are separate operations.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `config/src/key_aliases.rs`

`config` · `config load`

Configuration files often live longer than the code that reads them. If a setting is renamed, people may still have the old name in their files. This file is the small translation layer that protects those users from sudden breakage.

It knows about one alias today: inside the `memories` table, the old key `no_memories_if_mcp_or_web_search` now means `disable_on_external_context`. When config TOML is read, this code walks through the TOML value tree. A TOML value can be a table, an array, a string, a number, and so on. When it reaches a table, it first normalizes any child values, then checks whether that table is one of the known places where an old key might appear.

If the old key is found, the code removes it and inserts the value under the new key, but only if the new key is not already present. That last rule matters: if a user wrote both names, the newer name wins. An everyday analogy is mail forwarding: letters sent to an old address are redirected to the new one, unless the new address already has its own delivery instructions.

Without this file, renamed settings would be ignored or rejected, making upgrades more fragile for users with existing config files.

#### Function details

##### `normalize_key_aliases`  (lines 17–30)

```
fn normalize_key_aliases(path: &[String], table: &mut TomlMap<String, TomlValue>)
```

**Purpose**: This function rewrites known old key names to their current names inside one TOML table. It is used so a user’s older config spelling can still produce the same setting value.

**Data flow**: It receives the current table path, such as `memories`, and a mutable TOML table. It checks the built-in alias list, and when the path matches an alias location, it removes the legacy key from the table if present. It then inserts that value under the canonical key, unless the canonical key already exists, leaving the table in its normalized form.

**Call relations**: This is the local table-level cleanup step. `normalized_with_key_aliases` calls it after walking through nested config values, and `merge_toml_values_at_path` also calls it when combining TOML values at a specific path. It relies on normal map operations such as removing an old entry and inserting a new one only when needed.

*Call graph*: called by 2 (normalized_with_key_aliases, merge_toml_values_at_path); 2 external calls (entry, remove).


##### `normalized_with_key_aliases`  (lines 32–52)

```
fn normalized_with_key_aliases(value: &TomlValue, path: &[String]) -> TomlValue
```

**Purpose**: This function creates a normalized copy of a TOML value, with legacy config keys translated anywhere they appear in the supported structure. It is useful when the code wants to treat old and new config spellings as the same before later processing.

**Data flow**: It receives a TOML value and the path showing where that value sits in the config tree. If the value is a table, it builds a new table, recursively normalizes each child, then applies key alias cleanup to that table. If the value is an array, it normalizes each item in the array. If it is any other kind of value, it simply copies it. The output is a new TOML value with known aliases converted.

**Call relations**: This is the recursive walker that prepares config data for the rest of the configuration system. It calls `normalize_key_aliases` whenever it finishes rebuilding a table, so table-specific aliases can be applied at the right location. It is called by `merge_toml_values_at_path` during config merging and by `origins` when config origin tracking needs the same normalized view.

*Call graph*: calls 1 internal fn (normalize_key_aliases); called by 2 (merge_toml_values_at_path, origins); 4 external calls (new, Array, Table, clone).


### `utils/json-to-toml/src/lib.rs`

`util` · `cross-cutting, whenever JSON data needs to be represented as TOML; tests run during automated test execution`

JSON and TOML can describe many of the same things: text, numbers, true-or-false values, lists, and nested objects. This file is the bridge between those two worlds. Its main function, `json_to_toml`, takes a `serde_json::Value`, which is Rust’s general-purpose representation of any JSON value, and produces the matching `toml::Value`, which is the equivalent representation for TOML.

The conversion is mostly direct. A JSON boolean becomes a TOML boolean. A JSON integer becomes a TOML integer. A JSON floating-point number becomes a TOML float. A JSON string stays a string. A JSON array is converted item by item, like translating every word in a sentence. A JSON object becomes a TOML table, which is TOML’s name for a group of key-value pairs.

One important detail is JSON `null`. TOML does not have a real `null` value, so this converter turns it into an empty string. That is a deliberate compromise: it preserves the shape of the data, but readers should know that “missing value” becomes “blank text.”

The rest of the file is a set of tests that check the converter on numbers, arrays, booleans, floats, nulls, and nested objects.

#### Function details

##### `json_to_toml`  (lines 5–28)

```
fn json_to_toml(v: JsonValue) -> TomlValue
```

**Purpose**: Converts one JSON value into the closest matching TOML value. Someone would use it when data has already been parsed as JSON but must be passed on, saved, or compared in TOML form.

**Data flow**: It receives a single JSON value. It looks at what kind of value it is: null, true-or-false, number, text, list, or object. Simple values are turned directly into TOML values; lists are converted one item at a time; objects are converted one field at a time into a TOML table. The result is a new TOML value, and the original JSON value is consumed during the conversion.

**Call relations**: This is the central function in the file. When it sees an array or object, it calls itself again for each nested value, so deeply nested JSON is translated all the way down. The tests call it with different kinds of sample JSON values to prove each branch of the conversion behaves as expected.

*Call graph*: 7 external calls (new, Array, Boolean, Float, Integer, String, Table).


##### `tests::json_number_to_toml`  (lines 37–40)

```
fn json_number_to_toml()
```

**Purpose**: Checks that a whole JSON number becomes a TOML integer. This guards the basic number conversion path.

**Data flow**: It creates the JSON value `123`, sends it through `json_to_toml`, and compares the result with the expected TOML integer `123`. Nothing is returned; the test passes if the two values match and fails if they do not.

**Call relations**: This test is run by Rust’s test runner. It exercises the integer branch of `json_to_toml`, making sure ordinary whole numbers are not accidentally treated as text or floating-point numbers.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_array_to_toml`  (lines 43–49)

```
fn json_array_to_toml()
```

**Purpose**: Checks that a JSON list becomes a TOML array and that each item inside the list is converted too. This matters because arrays are containers, not just single values.

**Data flow**: It builds a JSON array containing `true` and `1`, passes that array into `json_to_toml`, and expects a TOML array containing a boolean and an integer. The before-and-after comparison proves both the outer list and its inner values were translated correctly.

**Call relations**: This test is run by the test runner and focuses on the recursive part of `json_to_toml`. It shows that when the converter meets a list, it hands each list item back through the same converter rather than leaving the contents unchanged.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_bool_to_toml`  (lines 52–55)

```
fn json_bool_to_toml()
```

**Purpose**: Checks that a JSON true-or-false value becomes the matching TOML true-or-false value. This protects one of the simplest and most common conversions.

**Data flow**: It creates the JSON value `false`, converts it with `json_to_toml`, and compares the result with TOML `false`. The test changes no shared state; it only verifies the returned value.

**Call relations**: This test is invoked during automated testing. It exercises the boolean branch of `json_to_toml`, confirming that boolean meaning is preserved exactly.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_float_to_toml`  (lines 58–61)

```
fn json_float_to_toml()
```

**Purpose**: Checks that a JSON decimal number becomes a TOML floating-point number. This is separate from whole-number testing because TOML stores integers and decimals differently.

**Data flow**: It creates the JSON value `1.25`, passes it to `json_to_toml`, and expects the TOML float `1.25`. If the converter returned an integer or string instead, the comparison would fail.

**Call relations**: This test is run by the test runner and covers the decimal-number path in `json_to_toml`. It complements the integer test so both common number forms are checked.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::json_null_to_toml`  (lines 64–67)

```
fn json_null_to_toml()
```

**Purpose**: Checks the file’s special rule for JSON `null`: it becomes an empty TOML string. This is important because TOML has no direct `null` equivalent.

**Data flow**: It starts with a JSON null value, sends it through `json_to_toml`, and expects an empty TOML string. The test documents and verifies this deliberate fallback behavior.

**Call relations**: This test is run by the test runner and focuses on the most surprising conversion rule in the file. It makes sure future changes do not silently alter how missing JSON values are represented in TOML.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::json_object_nested`  (lines 70–82)

```
fn json_object_nested()
```

**Purpose**: Checks that nested JSON objects become nested TOML tables. This proves the converter works for structured configuration-like data, not only simple single values.

**Data flow**: It creates a JSON object with an `outer` field containing another object with an `inner` number. It manually builds the expected nested TOML table, converts the JSON with `json_to_toml`, and compares the two. The result should preserve both the keys and the nested shape.

**Call relations**: This test is run by the test runner and exercises the object/table branch of `json_to_toml`. It also confirms the converter’s recursive behavior for objects: inner values are translated before being placed into the final TOML table.

*Call graph*: 5 external calls (Integer, Table, assert_eq!, json!, new).


### `utils/cli/src/config_override.rs`

`config` · `config load and command startup`

This file solves a practical problem: users often need to change one setting for one run without editing their main config file. It provides a shared `CliConfigOverrides` command-line option so different Codex tools can all understand flags like `-c model="o3"` or `-c shell_environment_policy.inherit=all` in the same way.

The file first stores each override exactly as the user typed it. Later, it splits each string at the first `=`, treats the left side as a dotted path such as `foo.bar.baz`, and parses the right side as TOML, the same configuration language used by the config file. This means numbers, booleans, arrays, and inline tables can become real typed values instead of plain text. If parsing fails, it falls back to using the value as a string, which keeps simple commands like `-c model=o3` convenient.

It can also apply the overrides onto an existing TOML configuration tree, creating missing nested tables as needed. Think of the dotted key as directions through folders: if a folder does not exist yet, this file creates it before putting the value inside. It also preserves one older shortcut, `use_legacy_landlock`, by rewriting it to its newer full path.

#### Function details

##### `CliConfigOverrides::prepend_root_overrides`  (lines 42–45)

```
fn prepend_root_overrides(&mut self, root_overrides: Self)
```

**Purpose**: This puts configuration flags from the top-level command before flags from a subcommand. That ordering matters because later overrides can win over earlier ones when the final config is built.

**Data flow**: It starts with one `CliConfigOverrides` value already holding subcommand override strings, and another holding root-level override strings. It inserts the root strings at the front of the existing list. The result is the same object, now ordered from broader settings first to more specific settings later.

**Call relations**: This is used when command-line parsing has collected some `-c` flags before a subcommand and some after it. `prepend_config_flags` calls it to combine those two groups while keeping the intended priority order.

*Call graph*: called by 1 (prepend_config_flags).


##### `CliConfigOverrides::parse_overrides`  (lines 49–84)

```
fn parse_overrides(&self) -> Result<Vec<(String, Value)>, String>
```

**Purpose**: This turns raw `key=value` command-line text into cleaned-up configuration paths paired with TOML values. Callers use it when they need the overrides in a structured form instead of as strings.

**Data flow**: It reads the stored list of raw override strings. For each one, it splits only at the first `=`, trims whitespace, checks that the key is not empty, parses the value as TOML when possible, and otherwise keeps it as a plain string with surrounding quotes removed. It also rewrites known legacy keys to their current full path. It returns either a list of `(path, value)` pairs or an error message explaining what was malformed.

**Call relations**: Many command and config-loading paths call this when they need to interpret `-c` flags, including main command execution, sandboxed command execution, config loading, exec server config loading, and several subcommands. Inside the parsing flow, it relies on the TOML parsing helper for typed values and the key-normalizing helper for compatibility with older flag names.

*Call graph*: called by 17 (run_main_with_transport_options, run_command_under_sandbox, load_config, load_exec_server_config, load_config_or_exit, run_add, run_get, run_list, run_login, run_logout (+7 more)).


##### `CliConfigOverrides::apply_on_value`  (lines 89–95)

```
fn apply_on_value(&self, target: &mut Value) -> Result<(), String>
```

**Purpose**: This applies all command-line overrides directly onto an existing TOML configuration value. It is useful when code already has a config tree and wants the `-c` flags to modify it in place.

**Data flow**: It takes a mutable TOML value as the target. First it parses the raw override strings into paths and values. Then, for each parsed override, it walks or creates the needed nested tables and writes the new value at the destination. It returns success when every override is applied, or an error if parsing the raw flags failed.

**Call relations**: This is the bridge between parsing and changing the actual config tree. It calls `CliConfigOverrides::parse_overrides` to understand the user input, then calls `apply_single_override` once for each parsed item to make the concrete edit.

*Call graph*: calls 2 internal fn (parse_overrides, apply_single_override).


##### `canonicalize_override_key`  (lines 98–104)

```
fn canonicalize_override_key(key: &str) -> String
```

**Purpose**: This converts supported old shortcut keys into their current full configuration path. It keeps older command examples or user habits working after the config layout has changed.

**Data flow**: It receives one key string from an override. If the key is exactly `use_legacy_landlock`, it returns `features.use_legacy_landlock`; otherwise it returns the key unchanged. Nothing else is modified.

**Call relations**: It is part of the override parsing path. After a key is split from `key=value`, this helper gives the rest of the system the canonical path that should be written into the config tree.


##### `apply_single_override`  (lines 108–148)

```
fn apply_single_override(root: &mut Value, path: &str, value: Value)
```

**Purpose**: This writes one parsed override into the correct place inside a TOML configuration tree. It also creates missing parent tables so a deeply nested setting can be added even if its path does not exist yet.

**Data flow**: It receives a mutable root TOML value, a dotted path such as `a.b.c`, and the TOML value to place there. It splits the path into parts, walks down through TOML tables, creates new tables where needed, and finally inserts or replaces the value at the last path part. The root value may be changed in place, including being turned into a table if it was not one already.

**Call relations**: This function is called by `CliConfigOverrides::apply_on_value` for each parsed override. It is the low-level writer that turns a user’s dotted path into actual nested TOML table updates.

*Call graph*: called by 1 (apply_on_value); 2 external calls (new, Table).


##### `parse_toml_value`  (lines 150–157)

```
fn parse_toml_value(raw: &str) -> Result<Value, toml::de::Error>
```

**Purpose**: This tries to read a single command-line value using TOML rules. That lets overrides preserve real types like booleans, numbers, arrays, and inline tables instead of treating everything as text.

**Data flow**: It receives a raw value string such as `true`, `42`, or `[1, 2, 3]`. Because the TOML parser expects a full assignment, it temporarily wraps the value as `_x_ = <value>`, parses that mini TOML document, and then pulls out the `_x_` value. It returns the parsed TOML value or a TOML parsing error.

**Call relations**: The override parser uses this to decide whether a right-hand side is a real TOML value. The test functions also call it directly to confirm that common value forms succeed or fail as expected.

*Call graph*: called by 4 (parses_array, parses_basic_scalar, parses_bool, parses_inline_table); 2 external calls (format!, from_str).


##### `tests::parses_basic_scalar`  (lines 164–167)

```
fn parses_basic_scalar()
```

**Purpose**: This test checks that a simple numeric override value is parsed as a number. It protects the behavior that `-c some_number=42` should not become the string `"42"`.

**Data flow**: It sends the text `42` into `parse_toml_value`. It then checks that the returned TOML value contains the integer 42. The test passes if the parsed type and value are correct.

**Call relations**: This is part of the file’s test coverage for `parse_toml_value`. It directly exercises the helper that production override parsing depends on for typed values.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


##### `tests::parses_bool`  (lines 170–176)

```
fn parses_bool()
```

**Purpose**: This test checks that TOML boolean text becomes real true and false values. It ensures flags like `-c feature_enabled=true` behave like booleans, not strings.

**Data flow**: It sends `true` and `false` into `parse_toml_value` separately. For each returned value, it checks that the TOML boolean matches the expected result. Nothing outside the test is changed.

**Call relations**: This test directly checks `parse_toml_value`, supporting the larger override parsing behavior used by command and config-loading code.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


##### `tests::fails_on_unquoted_string`  (lines 179–181)

```
fn fails_on_unquoted_string()
```

**Purpose**: This test confirms that bare words are not considered valid TOML strings by the low-level TOML parser. That distinction matters because the higher-level override parser deliberately falls back to plain strings when this parsing fails.

**Data flow**: It tries to parse the text `hello` as a TOML value. The expected result is an error, because TOML strings normally need quotes. The test passes when parsing fails.

**Call relations**: This test explains an important part of the design around `parse_toml_value`: failure is not always bad at the higher level, because `CliConfigOverrides::parse_overrides` can use that failure to choose the convenient string fallback.

*Call graph*: 1 external calls (assert!).


##### `tests::parses_array`  (lines 184–188)

```
fn parses_array()
```

**Purpose**: This test checks that array values are accepted in overrides. It protects use cases like passing lists of permissions or other multi-value settings from the command line.

**Data flow**: It gives `parse_toml_value` the text `[1, 2, 3]`. It then reads the parsed value as an array and checks that it has three items. The test passes if the TOML parser preserved the array shape.

**Call relations**: This directly exercises `parse_toml_value`, which is the same helper used when command-line overrides contain TOML arrays.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


##### `tests::canonicalizes_use_legacy_landlock_alias`  (lines 191–198)

```
fn canonicalizes_use_legacy_landlock_alias()
```

**Purpose**: This test checks that the old `use_legacy_landlock` override name is rewritten to its newer full path. It helps keep backward compatibility from breaking silently.

**Data flow**: It creates a `CliConfigOverrides` value containing `use_legacy_landlock=true`. It parses the overrides and checks that the resulting key is `features.use_legacy_landlock` and the value is the boolean `true`. The test only inspects the parsed output.

**Call relations**: This test covers the compatibility behavior used during `CliConfigOverrides::parse_overrides`. It indirectly verifies that key normalization is part of the parsing path.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::prepends_root_overrides`  (lines 201–216)

```
fn prepends_root_overrides()
```

**Purpose**: This test checks that root-level config flags are placed before subcommand-level flags. It protects the priority rule where more specific command flags can appear later and override earlier broad settings.

**Data flow**: It creates one override list for a subcommand and another for the root command. It calls `prepend_root_overrides`, then checks that the root value appears first and the subcommand value remains after it. The changed list is inspected in memory.

**Call relations**: This test directly exercises `CliConfigOverrides::prepend_root_overrides`, the helper used when command-line parsing needs to merge root and subcommand config flags.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::parses_inline_table`  (lines 219–224)

```
fn parses_inline_table()
```

**Purpose**: This test checks that inline TOML tables can be used as override values. That allows a single `-c` flag to provide a small group of related settings.

**Data flow**: It passes `{a = 1, b = 2}` into `parse_toml_value`. It then reads the result as a table and checks that keys `a` and `b` contain the integers 1 and 2. The test passes if the structure and values are preserved.

**Call relations**: This test directly checks `parse_toml_value`, strengthening confidence that the override parser can accept more than just simple scalar values.

*Call graph*: calls 1 internal fn (parse_toml_value); 1 external calls (assert_eq!).


### `utils/cli/src/approval_mode_cli_arg.rs`

`config` · `command-line parsing and startup configuration`

This file is a small bridge between what a person types in the terminal and what the program needs internally. The `--approval-mode` option controls when the tool should stop and ask the user before running a command. That matters because some commands are safe and routine, while others could change files, expose data, or need to run outside a sandbox.

The file defines `ApprovalModeCliArg`, an enum, which is a fixed list of allowed choices. The command-line parser, `clap`, can use this list to accept values like `untrusted`, `on-failure`, `on-request`, and `never`. The `kebab-case` setting means the typed command-line names use dashes instead of Rust-style names.

Each option describes a different trust style. For example, `untrusted` allows only known safe commands without asking, while `never` means the tool will not ask for approval at all. `on-failure` is kept for compatibility but is marked as deprecated in the comments.

The rest of the application does not use this CLI-specific enum directly. Instead, the file converts it into `AskForApproval`, the shared protocol type used deeper in the system. In everyday terms, this file is like a receptionist translating a visitor’s plain-language choice into the exact internal badge the building security system understands.

#### Function details

##### `AskForApproval::from`  (lines 30–37)

```
fn from(value: ApprovalModeCliArg) -> Self
```

**Purpose**: This function converts a command-line approval choice into the internal approval setting used by the application. It keeps the user-facing names separate from the protocol-level values used elsewhere.

**Data flow**: It receives one `ApprovalModeCliArg`, such as `OnRequest` or `Never`. It matches that choice to the corresponding `AskForApproval` value, such as `AskForApproval::OnRequest` or `AskForApproval::Never`, and returns that internal value without changing anything else.

**Call relations**: After the command-line parser has accepted an approval mode, this conversion is the handoff from CLI setup into the rest of the program. It does not call other project functions; it simply maps each accepted CLI option to the approval policy that later command-execution code can follow.


### `utils/cli/src/sandbox_mode_cli_arg.rs`

`config` · `startup / command-line parsing`

This file is a small bridge between what a person types in the terminal and what the program uses internally. The sandbox setting controls how much access the tool has to the user’s machine, such as read-only access, write access inside the workspace, or full access. Because command-line flags need to be simple words, this file defines a plain enum, `SandboxModeCliArg`, with the three supported choices.

The file uses `clap`, a command-line parsing library, so these choices can be accepted directly from the command line. The setting names are written in kebab-case for users, so `WorkspaceWrite` becomes `workspace-write`, which is easier and more conventional to type in a shell.

The internal protocol already has its own `SandboxMode` type. This file does not replace it. Instead, it converts the command-line version into that internal version. Think of it like a ticket counter: the user asks for a simple ticket by name, and this file hands the rest of the system the official form it expects.

Without this file, each command-line entry point would need to repeat the same sandbox flag definitions and conversion rules, increasing the chance that one command would interpret sandbox modes differently from another.

#### Function details

##### `SandboxMode::from`  (lines 21–27)

```
fn from(value: SandboxModeCliArg) -> Self
```

**Purpose**: This function converts a sandbox choice parsed from the command line into the internal sandbox mode used by the rest of the program. It keeps the user-facing flag names separate from the deeper configuration type.

**Data flow**: It receives one `SandboxModeCliArg`, such as `ReadOnly` or `WorkspaceWrite`. It matches that choice to the equivalent `SandboxMode` value. It returns the internal value and does not change anything else.

**Call relations**: This conversion is used after the command-line parser has turned the user’s `--sandbox` value into a `SandboxModeCliArg`. The result is handed onward to configuration or startup code that needs the real sandbox policy. The test in this file checks that each command-line option maps to the expected internal mode.


##### `tests::maps_cli_args_to_protocol_modes`  (lines 36–46)

```
fn maps_cli_args_to_protocol_modes()
```

**Purpose**: This test proves that every command-line sandbox option converts to the correct internal sandbox mode. It protects against accidental mismatches if either enum changes later.

**Data flow**: It creates each command-line sandbox value, converts it with `.into()`, and compares the result with the expected internal `SandboxMode`. It produces no runtime output unless a comparison fails during testing.

**Call relations**: This function runs only in the test build. It calls the external `assert_eq!` macro to compare expected and actual values, confirming that `SandboxMode::from` behaves correctly for all three sandbox choices.

*Call graph*: 1 external calls (assert_eq!).


### Metadata and schema shaping
These files define small reusable adapters for connector metadata, plugin and skill naming state, mention syntax, and generated JSON schemas.

### `connectors/src/metadata.rs`

`util` · `cross-cutting`

A connector is an external app or service that this system can talk to. This file is like the label maker and filing rulebook for those connectors. It answers simple but important questions: What name should users see? What short text should represent this connector when someone mentions it? What install link should be shown? In what order should connectors appear?

Most of the functions are thin wrappers around shared naming rules elsewhere in the crate. That is deliberate: it gives the rest of the program one clear place to ask for connector-facing metadata, instead of repeating string cleanup rules in many places. For example, a connector name may need to become a “slug,” which means a safe, simplified version of text that can be used in mentions or URLs.

The sorting function is the only place here with a little more policy. It puts accessible connectors first, then sorts by name, then by id as a final tie-breaker. That means users see the usable connectors before unavailable ones, and the order stays predictable even when two connectors have the same name. Without this file, connector names, mention forms, install URLs, and list ordering could drift apart across the interface.

#### Function details

##### `connector_display_label`  (lines 3–5)

```
fn connector_display_label(connector: &AppInfo) -> String
```

**Purpose**: Returns the human-readable name for a connector. Other parts of the system use this when they need the label a user should actually see.

**Data flow**: It receives an AppInfo object, reads its name field, copies that name into a new string, and returns it. It does not change the connector.

**Call relations**: When the interface or mention-building code needs a connector label, it calls this function first. The mention slug builder also uses it so that mention text is based on the same display name users see.

*Call graph*: called by 3 (connector_mention_slug, mention_items, connectors_popup_params).


##### `connector_mention_slug`  (lines 7–9)

```
fn connector_mention_slug(connector: &AppInfo) -> String
```

**Purpose**: Turns a connector into the short, safe name used when mentioning that connector in text. This helps the system recognize references like app mentions consistently.

**Data flow**: It receives an AppInfo object, asks connector_display_label for the connector’s visible name, then passes that name to connector_mention_slug_from_name. The result is a cleaned-up slug string.

**Call relations**: This is the common path used by mention-related code when it starts from a full connector record. It sits between raw connector metadata and features that count, collect, submit, or find connector mentions.

*Call graph*: calls 2 internal fn (connector_display_label, connector_mention_slug_from_name); called by 5 (build_connector_slug_counts, collect_explicit_app_ids_from_skill_items, mention_items, submit_user_message_with_history_and_shell_escape_policy, find_app_mentions).


##### `connector_mention_slug_from_name`  (lines 11–13)

```
fn connector_mention_slug_from_name(name: &str) -> String
```

**Purpose**: Turns a plain connector name into a mention-friendly slug. Use this when the code has only the name, not the full connector record.

**Data flow**: It receives a name as text, sends it to the crate’s shared connector name slug function, and returns the cleaned-up version. The exact cleanup rule lives in that shared function.

**Call relations**: connector_mention_slug calls this after extracting the display label. This function hands the actual name-cleaning work to the shared slug helper so mention formatting stays consistent with the rest of the connector code.

*Call graph*: called by 1 (connector_mention_slug); 1 external calls (connector_name_slug).


##### `connector_install_url`  (lines 15–17)

```
fn connector_install_url(name: &str, connector_id: &str) -> String
```

**Purpose**: Builds the installation URL for a connector from its name and connector id. This gives UI and merging code a single way to produce the link used to install or connect an app.

**Data flow**: It receives a connector name and connector id, passes both to the crate’s shared install URL builder, and returns the finished URL string.

**Call relations**: Code that combines connector records or converts plugin connector data into app information calls this when it needs an install link. This wrapper keeps URL creation centralized rather than scattered through those conversion paths.

*Call graph*: called by 4 (merged_app, named_app, merge_connectors, plugin_connector_to_app_info); 1 external calls (connector_install_url).


##### `sanitize_name`  (lines 19–21)

```
fn sanitize_name(name: &str) -> String
```

**Purpose**: Creates a stricter safe version of a connector name by making a slug and replacing dashes with underscores. This is useful when a name must fit places where underscores are preferred over hyphens.

**Data flow**: It receives raw name text, converts it with the shared connector slug rule, then replaces every hyphen in that result with an underscore. It returns the sanitized string and changes nothing else.

**Call relations**: This function is a standalone naming helper. It relies on the same shared slug logic as mention naming, then applies one extra transformation for callers that need underscore-style names.

*Call graph*: 1 external calls (connector_name_slug).


##### `sort_connectors_by_accessibility_and_name`  (lines 23–31)

```
fn sort_connectors_by_accessibility_and_name(connectors: &mut [AppInfo])
```

**Purpose**: Sorts a list of connectors so the most useful ones appear first. Accessible connectors come before inaccessible ones, then names are alphabetical, and ids break any remaining ties.

**Data flow**: It receives a mutable slice of AppInfo connector records. It reorders that slice in place: first by whether each connector is accessible, then by name, then by id. It returns no separate value because the input list itself is changed.

**Call relations**: After connector lists are merged from different sources, merge code calls this to make the final order predictable and user-friendly. It delegates the actual rearranging to Rust’s standard sorting operation, while this function supplies the comparison rule.

*Call graph*: called by 2 (merge_connectors, merge_plugin_connectors); 1 external calls (sort_by).


### `core-plugins/src/toggles.rs`

`domain_logic` · `configuration write handling`

Plugins can be enabled or disabled through configuration, but that configuration may be written in different ways. Someone might write one exact value like `plugins.sample@test.enabled = true`, replace one plugin's whole settings table, or replace the entire `plugins` table. This file is the small translator that recognizes all of those forms and extracts only the meaningful toggle changes.

The main function reads a stream of edited key paths and JSON values. A JSON value is a general data value such as a boolean, object, string, or number. The function looks for paths that start with `plugins`, then checks whether the edit contains an `enabled` boolean. If it does, it records the plugin ID and the requested true-or-false state. If the edit is about something else, or if `enabled` is missing or not a boolean, it ignores it.

The result is a sorted map, like a tidy checklist: each plugin ID points to its final requested enabled state. If the same plugin appears more than once, the later edit wins because it overwrites the earlier map entry. This matters during configuration writes: the rest of the system can ask, “Which plugin toggles changed?” without needing to understand every possible JSON shape a user may have edited.

#### Function details

##### `collect_plugin_enabled_candidates`  (lines 4–43)

```
fn collect_plugin_enabled_candidates(
    edits: impl Iterator<Item = (&'a String, &'a JsonValue)>,
) -> BTreeMap<String, bool>
```

**Purpose**: This function scans configuration edits and pulls out plugin enable or disable requests. It is used when the system needs a clean list of plugin IDs and their desired on/off state, regardless of how the configuration edit was shaped.

**Data flow**: It receives an iterator of key paths paired with JSON values. For each edit, it splits the key path on dots and checks for three supported forms: a direct `plugins.<id>.enabled` boolean, a whole `plugins.<id>` object containing an `enabled` boolean, or a whole `plugins` object containing plugin objects. It adds any found plugin toggle to a sorted map, overwriting earlier entries for the same plugin if a later edit appears. It returns that map and does not change anything outside itself.

**Call relations**: During normal configuration writes, callers such as `batch_write_inner` and `write_value` call this function to detect plugin toggle changes before applying or reacting to them. The test functions also call it directly with sample edits to prove it recognizes the supported edit shapes and uses the latest value when the same plugin is written twice.

*Call graph*: called by 4 (batch_write_inner, write_value, collect_plugin_enabled_candidates_tracks_direct_and_table_writes, collect_plugin_enabled_candidates_uses_last_write_for_same_plugin); 1 external calls (new).


##### `tests::collect_plugin_enabled_candidates_tracks_direct_and_table_writes`  (lines 53–80)

```
fn collect_plugin_enabled_candidates_tracks_direct_and_table_writes()
```

**Purpose**: This test proves that plugin toggle changes are found in all supported configuration shapes. It checks direct writes, single-plugin table writes, and whole-plugin-list writes in one example.

**Data flow**: It builds three sample JSON edits: one direct enabled flag, one plugin object with an enabled flag, and one whole plugins object containing both a valid enabled flag and an irrelevant entry. It sends those edits into `collect_plugin_enabled_candidates`, then compares the returned map with the expected plugin IDs and boolean states. Nothing is changed outside the test.

**Call relations**: This test exercises the main collection function as a safety check. It uses JSON-building and equality-checking helpers to create readable test data and confirm that only real plugin enabled values are passed through.

*Call graph*: calls 1 internal fn (collect_plugin_enabled_candidates); 2 external calls (assert_eq!, json!).


##### `tests::collect_plugin_enabled_candidates_uses_last_write_for_same_plugin`  (lines 83–99)

```
fn collect_plugin_enabled_candidates_uses_last_write_for_same_plugin()
```

**Purpose**: This test proves that when the same plugin is mentioned more than once, the later edit wins. That matches how layered or repeated configuration writes are expected to behave.

**Data flow**: It creates two edits for the same plugin: first setting it to enabled, then replacing the plugin object with `enabled` set to false. It passes both edits to `collect_plugin_enabled_candidates` and checks that the final map contains only the later false value for that plugin. The test only observes the returned result.

**Call relations**: This test focuses on the overwrite behavior inside the main collection function. It protects callers such as configuration write paths from accidentally acting on an earlier toggle value when a later edit has replaced it.

*Call graph*: calls 1 internal fn (collect_plugin_enabled_candidates); 2 external calls (assert_eq!, json!).


### `core-skills/src/mention_counts.rs`

`domain_logic` · `skill discovery or validation`

Skills appear to be described by metadata, including a skill name and the path to that skill's `SKILLS.md` file. This file answers a simple but important question: “How many active skills use this name?” That matters because duplicate names can make references ambiguous, especially if two names differ only by letter case, such as `Deploy` and `deploy`.

The main function walks through a list of skills one by one. Before counting a skill, it checks whether that skill's path is in a set of disabled paths. A disabled path is skipped, like ignoring a closed shop when making a list of open stores. For every enabled skill, it updates two count tables. One table uses the name exactly as written. The other converts the name to ASCII lowercase first, so names that differ only by basic English letter casing are grouped together.

At the end, the function returns both tables. Other code can then use the exact table to find truly identical names, and the lowercase table to find names that may look the same to a user even if their capitalization differs.

#### Function details

##### `build_skill_name_counts`  (lines 8–24)

```
fn build_skill_name_counts(
    skills: &[SkillMetadata],
    disabled_paths: &HashSet<AbsolutePathBuf>,
) -> (HashMap<String, usize>, HashMap<String, usize>)
```

**Purpose**: This function counts enabled skill names in two ways: exactly as written, and after converting ASCII letters to lowercase. It is useful when the system needs to detect duplicate skill names or names that only differ by capitalization.

**Data flow**: It receives a list of skill metadata and a set of disabled skill file paths. It creates two empty count tables, skips any skill whose path is disabled, then adds one count for the skill's exact name and one count for its ASCII-lowercase name. It returns the two completed tables and does not change the input lists or paths.

**Call relations**: When some other part of the skill system needs name counts, it can call this function with the current skills and disabled paths. Inside, the function only relies on standard map creation and updating: it starts fresh count tables, fills them from the enabled skills, and hands the finished counts back to the caller for later decisions.

*Call graph*: 1 external calls (new).


### `ext/memories/src/schema.rs`

`util` · `schema generation`

This file is a translator between Rust types and JSON Schema, which is a standard way to describe the shape of JSON data. In plain terms, it creates a form or checklist that says: this value is an object, these fields may appear, these fields are required, and extra fields may or may not be allowed.

The file has two public helpers for the rest of this crate. One is for input schemas, where optional fields are treated normally. The other is for output schemas, where optional values may also be written as null. That difference matters because data coming out of a tool or API may need to explicitly say “there is no value here,” while incoming data may follow stricter expectations.

The shared worker function builds a schema using schemars, a Rust library that can inspect types which implement JsonSchema. It asks for the 2019-09 version of JSON Schema, inlines nested schemas to make the result easier to pass around, serializes the generated schema into JSON, and then keeps only the pieces this project cares about. It is like taking a full instruction manual and copying only the pages needed by a particular form validator.

#### Function details

##### `input_schema_for`  (lines 6–8)

```
fn input_schema_for() -> Value
```

**Purpose**: Creates a JSON Schema for data that will be accepted as input. It is used when the system needs to describe what callers are allowed to send in.

**Data flow**: It receives a Rust type through its generic parameter, as long as that type knows how to describe itself as JSON Schema. It passes that type to the shared schema builder with the setting that optional values should not automatically include null. It returns the resulting schema as a JSON value.

**Call relations**: This is a small front door into the shared schema-building logic. When code needs an input schema, it calls this function, which delegates the real work to schema_for with the input-specific setting.


##### `output_schema_for`  (lines 10–12)

```
fn output_schema_for() -> Value
```

**Purpose**: Creates a JSON Schema for data that the system may produce as output. It allows optional output fields to be represented as null, which is common when a value is intentionally absent.

**Data flow**: It receives a Rust type through its generic parameter. It sends that type to the shared schema builder with the setting that optional values should include null as an allowed type. It returns the cleaned-up schema as a JSON value.

**Call relations**: This is the output-focused front door into the shared schema-building logic. Code that needs to publish or validate an output shape calls this function, and it asks schema_for to do the actual generation with output-friendly rules.


##### `schema_for`  (lines 14–42)

```
fn schema_for(option_add_null_type: bool) -> Value
```

**Purpose**: Builds the actual JSON Schema for a Rust type and trims it down to the fields this project wants to expose. This keeps schema generation consistent for both inputs and outputs.

**Data flow**: It takes a yes-or-no setting that says whether optional values should also allow null. It creates schema-generation settings, asks schemars to generate a root schema for the given Rust type, converts that schema into ordinary JSON, checks that the root is a JSON object, and then copies only selected top-level fields such as properties, required, type, and definitions into a new JSON object. The returned value is the simplified schema.

**Call relations**: This function is the shared engine behind input_schema_for and output_schema_for. Inside, it relies on external library calls from schemars to build the schema and serde_json to turn it into JSON. If schema generation ever produced something impossible, such as a non-object root schema, the function treats that as a programmer error rather than trying to recover.

*Call graph*: 5 external calls (new, draft2019_09, Object, to_value, unreachable!).


### `utils/plugins/src/mention_syntax.rs`

`config` · `cross-cutting`

When people write plain text that refers to a tool or plugin, the system needs a simple way to spot that reference. This file names the two marker characters, or “sigils,” used for that purpose. A sigil is a leading symbol, like the dollar sign in `$tool`, that tells the reader or program, “the next word has a special meaning.”

The file sets `$` as the default marker for tools, and `@` as the marker for plugins in linked plain text outside the terminal user interface. By putting these choices in one shared file, the rest of the codebase can import the same constants instead of hard-coding the characters in many places. That matters because if one part of the system looked for `$` while another produced `@` for the same kind of mention, links or references could fail in confusing ways.

There are no functions here because nothing needs to be calculated. The file acts like a small shared dictionary of punctuation rules for plugin-related text.


### Network policy and proxy configuration
This cluster covers the error model, host and domain normalization rules, and the higher-level proxy configuration that validates and applies them.

### `execpolicy/src/error.rs`

`data_model` · `cross-cutting error reporting`

This file is the project’s error-reporting vocabulary for execution policy code. Instead of every part of the program inventing its own failure messages, it defines one `Error` enum, which is a list of known problem types such as an invalid rule, an invalid example, or an error coming from Starlark, the embedded configuration language.

It also defines small location types: `TextPosition`, `TextRange`, and `ErrorLocation`. These describe where a problem happened in a file: the file path, the starting line and column, and the ending line and column. This matters because policy files are read by people. A message like “example matched when it should not” is much more useful when it can point to the exact place in the source text.

Two special error cases, `ExampleDidNotMatch` and `ExampleDidMatch`, can carry an optional location. The file provides helper methods to add that location later, or to ask an error whether it knows where it came from. For Starlark errors, it can translate Starlark’s own span information into this crate’s simpler `ErrorLocation` shape. Without this file, callers would have less consistent error messages and weaker links between failures and the policy text that caused them.

#### Function details

##### `Error::with_location`  (lines 54–76)

```
fn with_location(self, location: ErrorLocation) -> Self
```

**Purpose**: Adds a source-code location to certain example-related errors, but only if they do not already have one. This lets code create the error first and attach the file position later when that position becomes known.

**Data flow**: It takes an existing `Error` and an `ErrorLocation`, which contains a file path and text range. If the error is `ExampleDidNotMatch` or `ExampleDidMatch` and its location is currently empty, it returns a new version of that same error with the location filled in. For all other errors, or for example errors that already have a location, it returns the original error unchanged.

**Call relations**: This method is used as a finishing step in error creation: after another part of the policy checker detects a mismatch involving examples, it can call this to pin the error to a place in the source file. It does not call out to other project code; it simply reshapes the error value before it is handed upward to whoever will display or return it.


##### `Error::location`  (lines 78–100)

```
fn location(&self) -> Option<ErrorLocation>
```

**Purpose**: Looks at an error and returns the best source-code location known for it, if there is one. This is useful for showing users where to look in a policy file when something goes wrong.

**Data flow**: It reads the current `Error`. For example-matching errors, it copies out the stored `ErrorLocation` if present. For a Starlark error, it asks Starlark for its span, converts that span into this crate’s path, start position, and end position, and adjusts line and column numbers into the usual human-friendly one-based form. For errors that do not carry location information, it returns nothing.

**Call relations**: This method sits at the reporting boundary: when higher-level code needs to present an error to a person, it can call `location` to find out whether the message can include a file position. It bridges internal errors from this crate and location data supplied by Starlark, turning both into the same simple `ErrorLocation` format.


### `network-proxy/src/policy.rs`

`domain_logic` · `config load and request handling`

A network proxy sits between a client and the outside network, so it needs clear rules about where traffic may go. This file is the rulebook for host names, IP addresses, and domain patterns. Without it, the proxy could treat the same host differently depending on spelling, or accidentally allow requests to private addresses such as `localhost`, `127.0.0.1`, or internal network ranges. That matters for preventing server-side request forgery, often called SSRF: an attacker tricking a server into connecting to places it should not.

The file first defines `Host`, a small wrapper around a normalized host string. Normalizing means trimming spaces, lowercasing names, removing harmless trailing dots, stripping ports when safe, and handling IPv6 brackets and scope IDs. This is like writing every address in the same handwriting before comparing it.

It then classifies addresses. It can tell whether a host is loopback, meaning it points back to the same machine, and whether an IP address is non-public, meaning it belongs to private, local, testing, multicast, reserved, or otherwise not globally reachable ranges.

Finally, it compiles human-friendly domain rules into glob sets, which are efficient pattern matchers. It supports exact hosts, one-level-or-more subdomain patterns like `*.example.com`, apex-plus-subdomain patterns like `**.example.com`, and carefully controls the global `*` wildcard so deny rules cannot accidentally block everything.

#### Function details

##### `Host::parse`  (lines 21–25)

```
fn parse(input: &str) -> Result<Self>
```

**Purpose**: Creates a `Host` value from raw text after putting it into the proxy's standard host format. It rejects an empty result so later policy checks do not compare against a meaningless blank host.

**Data flow**: It receives a string from another part of the proxy, sends it through `normalize_host`, checks that the normalized text is not empty, and returns either a `Host` containing that clean text or an error.

**Call relations**: When code such as `host_blocked` or `update_domain_list` needs to evaluate a host against policy, it calls this first so all later checks work with a consistent spelling.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (host_blocked, update_domain_list); 1 external calls (ensure!).


##### `Host::as_str`  (lines 27–29)

```
fn as_str(&self) -> &str
```

**Purpose**: Gives read-only access to the normalized host text inside a `Host`. This lets policy checks inspect the host without changing it.

**Data flow**: It takes an existing `Host`, reads its stored string, and returns that string as a borrowed view. Nothing is modified.

**Call relations**: `is_loopback_host` and `is_explicit_local_allowlisted` call this when they need the plain host text for comparisons.

*Call graph*: called by 2 (is_loopback_host, is_explicit_local_allowlisted).


##### `is_loopback_host`  (lines 33–43)

```
fn is_loopback_host(host: &Host) -> bool
```

**Purpose**: Answers whether a host points back to the same machine, such as `localhost`, `127.0.0.1`, or `::1`. This is important because proxies often must prevent outside requests from reaching local-only services.

**Data flow**: It receives a normalized `Host`, reads its string, removes an IPv6 scope suffix if present, checks for the special name `localhost`, then tries to parse the host as an IP address and asks whether that IP is loopback. It returns true or false.

**Call relations**: `host_blocked` calls this during request policy checks. Internally it uses `Host::as_str` to read the host and `unscoped_ip_literal` to compare scoped IP literals safely.

*Call graph*: calls 2 internal fn (as_str, unscoped_ip_literal); called by 1 (host_blocked).


##### `is_non_public_ip`  (lines 45–50)

```
fn is_non_public_ip(ip: IpAddr) -> bool
```

**Purpose**: Classifies an IP address as not publicly reachable or otherwise unsafe for open proxying. This includes private networks, loopback, link-local, multicast, testing, and reserved ranges.

**Data flow**: It receives either an IPv4 or IPv6 address, chooses the matching helper, and returns true if the address belongs to a non-public category.

**Call relations**: Connection and blocking paths such as `connect`, `host_blocked`, and `host_resolves_to_non_public_ip` call this before allowing traffic to proceed.

*Call graph*: calls 2 internal fn (is_non_public_ipv4, is_non_public_ipv6); called by 3 (connect, host_blocked, host_resolves_to_non_public_ip).


##### `is_non_public_ipv4`  (lines 52–70)

```
fn is_non_public_ipv4(ip: Ipv4Addr) -> bool
```

**Purpose**: Checks an IPv4 address against the set of local, private, reserved, testing, and special-use IPv4 ranges. This is the detailed IPv4 part of the proxy's safety check.

**Data flow**: It receives an IPv4 address, applies built-in address classification checks where available, then checks extra special ranges using CIDR matching. It returns true when the address is not considered public.

**Call relations**: `is_non_public_ip` calls this for normal IPv4 addresses, and `is_non_public_ipv6` calls it for IPv6 addresses that contain an embedded IPv4 address.

*Call graph*: calls 1 internal fn (ipv4_in_cidr); called by 2 (is_non_public_ip, is_non_public_ipv6); 6 external calls (is_broadcast, is_link_local, is_loopback, is_multicast, is_private, is_unspecified).


##### `ipv4_in_cidr`  (lines 72–81)

```
fn ipv4_in_cidr(ip: Ipv4Addr, base: [u8; 4], prefix: u8) -> bool
```

**Purpose**: Checks whether an IPv4 address falls inside a particular CIDR range. A CIDR range is a compact way to describe a block of IP addresses, like saying 'all addresses starting with these bits.'

**Data flow**: It receives an IPv4 address, a base address, and a prefix length. It converts both addresses to numbers, builds a bit mask, compares the shared prefix bits, and returns true if they match.

**Call relations**: `is_non_public_ipv4` uses this for special IPv4 ranges that the standard library does not fully classify on its own.

*Call graph*: called by 1 (is_non_public_ipv4); 2 external calls (from, from).


##### `is_non_public_ipv6`  (lines 83–98)

```
fn is_non_public_ipv6(ip: Ipv6Addr) -> bool
```

**Purpose**: Checks whether an IPv6 address is local, private-like, multicast, unspecified, or otherwise not globally routable. It also handles IPv6 addresses that wrap an IPv4 address.

**Data flow**: It receives an IPv6 address. If the address contains an IPv4 address, it checks that embedded IPv4 address too. Otherwise it applies IPv6-specific local and special-range tests, then returns true or false.

**Call relations**: `is_non_public_ip` calls this for IPv6 inputs. It delegates embedded IPv4 cases to `is_non_public_ipv4` so the same IPv4 safety rules apply everywhere.

*Call graph*: calls 1 internal fn (is_non_public_ipv4); called by 1 (is_non_public_ip); 6 external calls (is_loopback, is_multicast, is_unicast_link_local, is_unique_local, is_unspecified, to_ipv4).


##### `normalize_host`  (lines 101–119)

```
fn normalize_host(host: &str) -> String
```

**Purpose**: Turns host text into a predictable form before any policy comparison. It trims spaces, lowercases domain names, removes IPv6 brackets, strips a simple `:port`, and treats trailing-dot domain names the same as ordinary ones.

**Data flow**: It receives raw host text, detects bracketed IPv6 and simple host-plus-port forms, then passes the host portion to `normalize_dns_host_or_ip_literal`. The output is a cleaned string suitable for matching.

**Call relations**: Many request and MITM policy paths call this before deciding what to do with a host, including HTTP proxy handling, CONNECT handling, hook evaluation, and `Host::parse`.

*Call graph*: calls 1 internal fn (normalize_dns_host_or_ip_literal); called by 12 (http_connect_accept, http_connect_proxy, http_plain_proxy, evaluate_mitm_policy, mitm_stream, evaluate_mitm_hooks, normalize_hook_host, parse, normalize_pattern, host_has_mitm_hooks (+2 more)).


##### `normalize_dns_host_or_ip_literal`  (lines 121–128)

```
fn normalize_dns_host_or_ip_literal(host: &str) -> String
```

**Purpose**: Applies the final shared cleanup for either a DNS name or an IP literal. DNS means a normal name like `example.com`; an IP literal means an address written directly, like `::1`.

**Data flow**: It lowercases the host, removes trailing dots, asks `normalize_ip_literal` whether the result is an IP address that needs special handling, and returns either the normalized IP string or the normalized domain string.

**Call relations**: `normalize_host` calls this after it has dealt with brackets and simple ports.

*Call graph*: calls 1 internal fn (normalize_ip_literal); called by 1 (normalize_host).


##### `unscoped_ip_literal`  (lines 130–134)

```
fn unscoped_ip_literal(host: &str) -> Option<&str>
```

**Purpose**: Removes the scope part from an IP literal when one is present, after confirming the part before `%` is a real IP address. IPv6 scope IDs name a local network interface, such as `%lo0`.

**Data flow**: It receives host text, splits it at `%`, verifies that the left side parses as an IP address, and returns that left side if valid. If the host is not a scoped IP literal, it returns nothing.

**Call relations**: `is_loopback_host`, `host_blocked`, `globset_matches_host_or_unscoped`, and `is_explicit_local_allowlisted` use this when policy should compare the address itself without being confused by the local scope label.

*Call graph*: called by 4 (is_loopback_host, host_blocked, globset_matches_host_or_unscoped, is_explicit_local_allowlisted).


##### `normalize_ip_literal`  (lines 136–148)

```
fn normalize_ip_literal(host: &str) -> Option<String>
```

**Purpose**: Recognizes IP addresses written directly and normalizes scoped IPv6 spellings. In particular, it treats `%25` in bracketed URLs as the same scope separator as `%`.

**Data flow**: It receives lowercase host text. If the whole string is an IP address, it returns it. Otherwise it looks for `%25` or `%`, confirms the part before it is an IP address, and returns the IP plus a normalized `%scope` suffix.

**Call relations**: `normalize_dns_host_or_ip_literal` calls this so IP literals are preserved and scope IDs are made consistent before policy matching.

*Call graph*: called by 1 (normalize_dns_host_or_ip_literal); 1 external calls (format!).


##### `normalize_pattern`  (lines 150–170)

```
fn normalize_pattern(pattern: &str) -> String
```

**Purpose**: Normalizes a domain rule pattern while preserving its wildcard meaning. For example, it can clean `*.Example.COM.` into `*.example.com`.

**Data flow**: It receives a pattern string, trims it, preserves a bare `*`, separates special prefixes like `*.` or `**.`, normalizes the domain part with `normalize_host`, and returns the rebuilt pattern.

**Call relations**: `compile_globset_with_policy` calls this before compiling patterns, and `is_global_wildcard_domain_pattern` calls it before checking whether a pattern expands to `*`.

*Call graph*: calls 1 internal fn (normalize_host); called by 2 (compile_globset_with_policy, is_global_wildcard_domain_pattern); 1 external calls (format!).


##### `is_global_wildcard_domain_pattern`  (lines 172–177)

```
fn is_global_wildcard_domain_pattern(pattern: &str) -> bool
```

**Purpose**: Detects whether a domain pattern effectively means 'match every host.' This matters because such a rule is allowed in some allowlist cases but rejected for denylists.

**Data flow**: It receives pattern text, normalizes it, expands it into the actual matching candidates, and returns true if any candidate is exactly `*`.

**Call relations**: `compile_globset_with_policy` uses this when building a denylist so it can reject a global wildcard before it becomes an overly broad block rule.

*Call graph*: calls 2 internal fn (expand_domain_pattern, normalize_pattern); called by 1 (compile_globset_with_policy).


##### `compile_allowlist_globset`  (lines 185–187)

```
fn compile_allowlist_globset(patterns: &[String]) -> Result<GlobSet>
```

**Purpose**: Builds an efficient matcher for allowed host patterns. Unlike denylists, it permits the global `*` wildcard when the caller explicitly wants an allow-everything rule.

**Data flow**: It receives a list of pattern strings and passes them to the shared compiler with the policy that global wildcards are allowed. It returns a compiled `GlobSet` or an error.

**Call relations**: Configuration-building paths such as `network_proxy_state_for_policy` and `build_config_state` call this when turning allowlist settings into something fast to use during requests.

*Call graph*: calls 1 internal fn (compile_globset_with_policy); called by 3 (network_proxy_state_for_policy, compile_globset_allows_global_wildcard_when_enabled, build_config_state).


##### `compile_denylist_globset`  (lines 189–191)

```
fn compile_denylist_globset(patterns: &[String]) -> Result<GlobSet>
```

**Purpose**: Builds an efficient matcher for blocked host patterns. It rejects a bare global wildcard so a denylist cannot accidentally mean 'block every possible host.'

**Data flow**: It receives a list of pattern strings and passes them to the shared compiler with the policy that global wildcards are rejected. It returns a compiled `GlobSet` or an error.

**Call relations**: The proxy's configuration setup and many tests call this to turn denylist settings into matchers. It relies on `compile_globset_with_policy` for the actual normalization and compilation.

*Call graph*: calls 1 internal fn (compile_globset_with_policy); called by 12 (compile_globset_normalizes_apex_and_subdomains, compile_globset_normalizes_bracketed_ipv6_literals, compile_globset_normalizes_trailing_dots, compile_globset_normalizes_wildcards, compile_globset_preserves_scoped_ipv6_literals, compile_globset_supports_mid_label_wildcards, network_proxy_state_for_policy, compile_globset_dedupes_patterns_without_changing_behavior, compile_globset_excludes_apex_for_subdomain_patterns, compile_globset_includes_apex_for_double_wildcard_patterns (+2 more)).


##### `compile_globset_with_policy`  (lines 193–223)

```
fn compile_globset_with_policy(
    patterns: &[String],
    global_wildcard: GlobalWildcard,
) -> Result<GlobSet>
```

**Purpose**: Does the real work of turning human-written host patterns into a `GlobSet`, an efficient collection of wildcard match rules. It also enforces whether `*` is allowed.

**Data flow**: It receives pattern strings and a wildcard policy. For each pattern it may reject a global wildcard, normalizes the pattern, expands domain shorthand into concrete glob patterns, skips duplicates, builds each glob case-insensitively, and returns the finished matcher.

**Call relations**: Both `compile_allowlist_globset` and `compile_denylist_globset` use this shared path so allowlists and denylists interpret domain syntax the same way, except for the global wildcard rule.

*Call graph*: calls 3 internal fn (expand_domain_pattern, is_global_wildcard_domain_pattern, normalize_pattern); called by 2 (compile_allowlist_globset, compile_denylist_globset); 4 external calls (new, new, new, bail!).


##### `DomainPattern::parse`  (lines 237–249)

```
fn parse(input: &str) -> Self
```

**Purpose**: Interprets a domain pattern as one of three meanings: exact host, subdomains only, or apex plus subdomains. The apex is the base domain itself, such as `example.com`.

**Data flow**: It receives trimmed pattern text, checks for `**.` or `*.` prefixes, and returns the matching `DomainPattern` variant with the remaining domain text. Empty input becomes an exact empty pattern.

**Call relations**: `expand_domain_pattern` calls this when converting policy syntax into glob strings for matching.

*Call graph*: called by 1 (expand_domain_pattern); 3 external calls (Exact, parse_domain, new).


##### `DomainPattern::parse_for_constraints`  (lines 252–264)

```
fn parse_for_constraints(input: &str) -> Self
```

**Purpose**: Parses a domain pattern for comparing policy constraints, while also validating and normalizing domain parts through the URL library when possible.

**Data flow**: It receives pattern text, checks the same wildcard prefixes as `parse`, sends the domain portion through `parse_domain_for_constraints`, and returns a `DomainPattern` variant.

**Call relations**: No caller is shown in the provided graph, but this function is designed for constraint comparison code that needs cleaner, validated domain names before using `DomainPattern::allows`.

*Call graph*: calls 1 internal fn (parse_domain_for_constraints); 4 external calls (ApexAndSubdomains, Exact, SubdomainsOnly, new).


##### `DomainPattern::parse_domain`  (lines 266–272)

```
fn parse_domain(domain: &str, build: impl FnOnce(String) -> Self) -> Self
```

**Purpose**: Small helper used while parsing wildcard domain patterns. It avoids creating wildcard variants with an empty domain.

**Data flow**: It receives a domain fragment and a builder function for the desired pattern kind. After trimming, it returns an exact empty pattern if the domain is blank, or calls the builder with the domain string.

**Call relations**: `DomainPattern::parse` uses this after it has identified whether the input began with `*.` or `**.`.

*Call graph*: 2 external calls (Exact, new).


##### `DomainPattern::allows`  (lines 274–299)

```
fn allows(&self, candidate: &DomainPattern) -> bool
```

**Purpose**: Decides whether one domain pattern is broad enough to include another. This is useful when checking whether a requested or configured rule fits inside a permitted constraint.

**Data flow**: It receives the current pattern and a candidate pattern. It compares exact names, subdomain relationships, and apex-plus-subdomain relationships, then returns true if the current pattern covers the candidate.

**Call relations**: No direct caller is shown in the provided graph. Inside, it uses `domain_eq`, `is_subdomain_or_equal`, and `is_strict_subdomain` to make the coverage decision.

*Call graph*: calls 3 internal fn (domain_eq, is_strict_subdomain, is_subdomain_or_equal).


##### `parse_domain_for_constraints`  (lines 302–319)

```
fn parse_domain_for_constraints(domain: &str) -> String
```

**Purpose**: Cleans and validates a domain-like value for constraint comparisons. It avoids treating malformed host text as a real normalized domain.

**Data flow**: It receives a domain string, trims whitespace and a trailing dot, removes surrounding IPv6 brackets when present, leaves wildcard-like or scoped strings alone, and otherwise asks the URL host parser to normalize it. Invalid ordinary host text becomes an empty string.

**Call relations**: `DomainPattern::parse_for_constraints` calls this for the domain portion of exact and wildcard constraint patterns.

*Call graph*: called by 1 (parse_for_constraints); 2 external calls (new, parse).


##### `expand_domain_pattern`  (lines 321–331)

```
fn expand_domain_pattern(pattern: &str) -> Vec<String>
```

**Purpose**: Turns the project's domain pattern shorthand into the concrete glob patterns used by the matcher. For example, `**.example.com` becomes one pattern for `example.com` and one for its subdomains.

**Data flow**: It receives normalized pattern text, parses it into a `DomainPattern`, and returns a list of one or more glob strings that represent the same meaning.

**Call relations**: `compile_globset_with_policy` calls this while building matchers, and `is_global_wildcard_domain_pattern` calls it when checking for a global `*`.

*Call graph*: calls 1 internal fn (parse); called by 2 (compile_globset_with_policy, is_global_wildcard_domain_pattern); 1 external calls (vec!).


##### `normalize_domain`  (lines 333–335)

```
fn normalize_domain(domain: &str) -> String
```

**Purpose**: Puts a domain into a simple comparison form by removing trailing dots and lowercasing it. This keeps `Example.COM.` and `example.com` from being treated as different domains.

**Data flow**: It receives domain text and returns a lowercase, trailing-dot-free string.

**Call relations**: `domain_eq`, `is_subdomain_or_equal`, and `is_strict_subdomain` call this before comparing domain relationships.

*Call graph*: called by 3 (domain_eq, is_strict_subdomain, is_subdomain_or_equal).


##### `domain_eq`  (lines 337–339)

```
fn domain_eq(left: &str, right: &str) -> bool
```

**Purpose**: Checks whether two domain names are the same after normalizing their spelling. It is a safer equality check for policy comparisons than raw string equality.

**Data flow**: It receives two domain strings, normalizes both with `normalize_domain`, compares them, and returns true or false.

**Call relations**: `DomainPattern::allows` calls this when an exact pattern must match another exact domain.

*Call graph*: calls 1 internal fn (normalize_domain); called by 1 (allows).


##### `is_subdomain_or_equal`  (lines 341–348)

```
fn is_subdomain_or_equal(child: &str, parent: &str) -> bool
```

**Purpose**: Checks whether one domain is either the same as another domain or sits beneath it. For example, `api.example.com` is under `example.com`, and `example.com` is equal to itself.

**Data flow**: It receives child and parent domain strings, normalizes both, first checks equality, then checks whether the child ends with `.` plus the parent. It returns true if either condition holds.

**Call relations**: `DomainPattern::allows` uses this for patterns that include the apex domain as well as its subdomains.

*Call graph*: calls 1 internal fn (normalize_domain); called by 1 (allows); 1 external calls (format!).


##### `is_strict_subdomain`  (lines 350–354)

```
fn is_strict_subdomain(child: &str, parent: &str) -> bool
```

**Purpose**: Checks whether one domain is beneath another but not exactly the same. For example, `api.example.com` qualifies, but `example.com` does not.

**Data flow**: It receives child and parent domain strings, normalizes both, verifies they are not equal, then checks whether the child ends with `.` plus the parent. It returns true or false.

**Call relations**: `DomainPattern::allows` uses this for `*.example.com` style rules, where subdomains are allowed but the base domain itself is not.

*Call graph*: calls 1 internal fn (normalize_domain); called by 1 (allows); 1 external calls (format!).


##### `tests::method_allowed_full_allows_everything`  (lines 363–367)

```
fn method_allowed_full_allows_everything()
```

**Purpose**: Verifies that full network mode allows common HTTP methods, including methods that can change data or open tunnels.

**Data flow**: The test calls the method policy for `GET`, `POST`, and `CONNECT`, then asserts each one is accepted.

**Call relations**: This test exercises `NetworkMode::Full` behavior from the configuration module rather than the helper functions in this file.

*Call graph*: 1 external calls (assert!).


##### `tests::method_allowed_limited_allows_only_safe_methods`  (lines 370–376)

```
fn method_allowed_limited_allows_only_safe_methods()
```

**Purpose**: Verifies that limited network mode only permits safer HTTP methods and rejects riskier ones.

**Data flow**: The test checks that `GET`, `HEAD`, and `OPTIONS` are allowed, while `POST` and `CONNECT` are not.

**Call relations**: This test protects the expected behavior of `NetworkMode::Limited`, which is used alongside host policy when deciding what network access is permitted.

*Call graph*: 1 external calls (assert!).


##### `tests::compile_globset_normalizes_trailing_dots`  (lines 379–384)

```
fn compile_globset_normalizes_trailing_dots()
```

**Purpose**: Checks that a domain pattern with a trailing dot matches the ordinary version of the same domain. This mirrors how fully qualified domain names are often written.

**Data flow**: The test builds a denylist matcher from `Example.COM.`, then confirms it matches `example.com` but not `api.example.com`.

**Call relations**: It calls `compile_denylist_globset`, which routes through the normal pattern normalization and glob compilation path.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_normalizes_wildcards`  (lines 387–392)

```
fn compile_globset_normalizes_wildcards()
```

**Purpose**: Checks that wildcard domain patterns are lowercased and have trailing dots removed before matching.

**Data flow**: The test compiles `*.Example.COM.`, then confirms a subdomain matches while the base domain itself does not.

**Call relations**: It calls `compile_denylist_globset` to exercise wildcard normalization through the same path used by real denylist configuration.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_supports_mid_label_wildcards`  (lines 395–402)

```
fn compile_globset_supports_mid_label_wildcards()
```

**Purpose**: Verifies that wildcard characters can appear inside a domain label, not only at the beginning of a full subdomain pattern.

**Data flow**: The test compiles `region*.v2.argotunnel.com`, then checks that matching names beginning with `region` are accepted and unrelated or deeper names are rejected.

**Call relations**: It uses `compile_denylist_globset`, confirming that the glob compiler preserves this more specific wildcard behavior.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_normalizes_apex_and_subdomains`  (lines 405–410)

```
fn compile_globset_normalizes_apex_and_subdomains()
```

**Purpose**: Checks that `**.example.com` means both the base domain and its subdomains.

**Data flow**: The test compiles `**.Example.COM.`, then confirms the resulting matcher accepts both `example.com` and `api.example.com`.

**Call relations**: It calls `compile_denylist_globset`, which uses `expand_domain_pattern` to turn the apex-plus-subdomains shorthand into concrete glob patterns.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_normalizes_bracketed_ipv6_literals`  (lines 413–417)

```
fn compile_globset_normalizes_bracketed_ipv6_literals()
```

**Purpose**: Verifies that bracketed IPv6 addresses are normalized before matching. Brackets are common in URLs but should not be part of the address comparison.

**Data flow**: The test compiles a denylist pattern for `[::1]` and confirms it matches the plain address `::1`.

**Call relations**: It calls `compile_denylist_globset`, indirectly exercising `normalize_host` and IP literal normalization.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::compile_globset_preserves_scoped_ipv6_literals`  (lines 420–426)

```
fn compile_globset_preserves_scoped_ipv6_literals()
```

**Purpose**: Checks that IPv6 scope IDs are preserved and decoded consistently. Scope IDs matter because they distinguish local network interfaces.

**Data flow**: The test compiles `[fe80::1%25lo0]`, then confirms it matches `fe80::1%lo0` but not a different scope or the same address without a scope.

**Call relations**: It calls `compile_denylist_globset`, protecting the scope-handling behavior in `normalize_ip_literal`.

*Call graph*: calls 1 internal fn (compile_denylist_globset); 1 external calls (assert_eq!).


##### `tests::is_loopback_host_handles_localhost_variants`  (lines 429–434)

```
fn is_loopback_host_handles_localhost_variants()
```

**Purpose**: Confirms that different spellings of `localhost` are recognized as loopback while unrelated names are not.

**Data flow**: The test parses several host strings and asserts that `localhost`, `localhost.`, and uppercase `LOCALHOST` are loopback, while `notlocalhost` is not.

**Call relations**: Although the function list only records assertions, the test is meant to protect the behavior of `Host::parse`, `normalize_host`, and `is_loopback_host` together.

*Call graph*: 1 external calls (assert!).


##### `tests::is_loopback_host_handles_ip_literals`  (lines 437–441)

```
fn is_loopback_host_handles_ip_literals()
```

**Purpose**: Confirms that direct loopback IP addresses are detected correctly.

**Data flow**: The test parses `127.0.0.1`, `::1`, and `1.2.3.4`, then asserts that only the loopback addresses are classified as loopback.

**Call relations**: This test protects the IP parsing path used by `is_loopback_host` during request blocking.

*Call graph*: 1 external calls (assert!).


##### `tests::is_non_public_ip_rejects_private_and_loopback_ranges`  (lines 444–465)

```
fn is_non_public_ip_rejects_private_and_loopback_ranges()
```

**Purpose**: Verifies that the non-public IP classifier catches many important unsafe ranges and does not reject a normal public address like `8.8.8.8`.

**Data flow**: The test feeds many IPv4, IPv6, and IPv4-embedded-IPv6 addresses into the classifier and asserts the expected true or false result for each.

**Call relations**: The recorded calls are assertions, but the test is designed to protect `is_non_public_ip` and its IPv4 and IPv6 helper logic.

*Call graph*: 1 external calls (assert!).


##### `tests::normalize_host_lowercases_and_trims`  (lines 468–470)

```
fn normalize_host_lowercases_and_trims()
```

**Purpose**: Checks that host normalization removes surrounding spaces and lowercases domain names.

**Data flow**: The test passes spaced mixed-case text into `normalize_host` and asserts the clean lowercase domain comes out.

**Call relations**: This protects the first and most common cleanup step used before host policy matching.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_port_for_host_port`  (lines 473–475)

```
fn normalize_host_strips_port_for_host_port()
```

**Purpose**: Checks that a simple `host:port` string is reduced to just the host.

**Data flow**: The test normalizes `example.com:1234` and expects `example.com`.

**Call relations**: This protects `normalize_host` behavior for callers that may pass a host header or address containing a port.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_preserves_unbracketed_ipv6`  (lines 478–480)

```
fn normalize_host_preserves_unbracketed_ipv6()
```

**Purpose**: Checks that an IPv6 address without brackets is not accidentally cut at a colon as if it were `host:port`.

**Data flow**: The test normalizes `2001:db8::1` and expects the same IPv6 address back.

**Call relations**: This protects the colon-counting branch in `normalize_host`, which must distinguish IPv6 from a simple port suffix.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_trailing_dot`  (lines 483–486)

```
fn normalize_host_strips_trailing_dot()
```

**Purpose**: Checks that fully qualified domain spellings with a final dot compare the same as ordinary domain names.

**Data flow**: The test normalizes lowercase and mixed-case domains ending in `.` and expects lowercase names without the dot.

**Call relations**: This protects normalization used by both direct host checks and pattern compilation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_trailing_dot_with_port`  (lines 489–491)

```
fn normalize_host_strips_trailing_dot_with_port()
```

**Purpose**: Checks that a domain with both a trailing dot and a port is normalized correctly.

**Data flow**: The test passes `example.com.:443` into `normalize_host` and expects `example.com`.

**Call relations**: This protects the combined behavior of port stripping and trailing-dot cleanup in `normalize_host`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_strips_brackets_for_ipv6`  (lines 494–497)

```
fn normalize_host_strips_brackets_for_ipv6()
```

**Purpose**: Checks that bracketed IPv6 addresses are converted to the plain address form used for matching.

**Data flow**: The test normalizes `[::1]` and `[::1]:443`, expecting `::1` in both cases.

**Call relations**: This protects the bracket-handling branch in `normalize_host`, which is important for IPv6 addresses taken from URLs.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_host_preserves_ipv6_scope_ids`  (lines 500–504)

```
fn normalize_host_preserves_ipv6_scope_ids()
```

**Purpose**: Checks that scoped IPv6 addresses keep their scope information, while URL-encoded `%25` is normalized to `%`.

**Data flow**: The test normalizes unbracketed, bracketed, and `%25`-encoded scoped IPv6 inputs and expects the same canonical scoped address form.

**Call relations**: This protects the interaction between `normalize_host` and `normalize_ip_literal` for link-local IPv6 addresses.

*Call graph*: 1 external calls (assert_eq!).


### `network-proxy/src/config.rs`

`config` · `config load and startup`

This file is the proxy's rulebook and safety checker. It describes the settings a user can write, supplies safe defaults, and validates risky options before the proxy starts. Without it, the proxy could listen on unsafe network addresses, accept malformed socket paths, or apply allow and deny rules inconsistently.

The main configuration type is `NetworkProxySettings`. It includes the HTTP proxy address, SOCKS5 proxy address, network mode, domain permissions, Unix socket permissions, and several deliberately named dangerous escape hatches. The file treats those escape hatches carefully. For example, if a user asks the proxy to listen on `0.0.0.0`, meaning every network interface, the code normally clamps that back to `127.0.0.1`, meaning only this machine. That is like moving a front-door service back behind a locked office door unless the user explicitly accepts the risk.

Domain rules are stored so that deny wins over allow when the same pattern appears twice. Unix socket paths are checked to make sure they are absolute paths, because relative paths can point somewhere surprising depending on where the program runs. The file also parses loose address strings, such as `localhost:3128` or IPv6 forms, into concrete socket addresses. The tests at the bottom lock down these safety and parsing behaviors.

#### Function details

##### `NetworkDomainPermissions::serialize`  (lines 46–55)

```
fn serialize(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
```

**Purpose**: Turns the domain permission list into the map shape used in saved or exported configuration. It writes only the effective result, so duplicate patterns collapse into one final permission.

**Data flow**: It starts with the in-memory list of domain permission entries. It asks `effective_entries` to resolve duplicates, turns those entries into a sorted map from pattern to permission, and gives that map to the serializer. The output is serialized configuration data.

**Call relations**: Serialization code calls this when `NetworkDomainPermissions` needs to be written out. It delegates the important conflict-resolution step to `effective_entries` before handing the clean map to Serde, the Rust library used for reading and writing structured data.

*Call graph*: calls 1 internal fn (effective_entries).


##### `NetworkDomainPermissions::deserialize`  (lines 59–71)

```
fn deserialize(deserializer: D) -> std::result::Result<Self, D::Error>
```

**Purpose**: Reads domain permission settings from configuration data. It accepts a map such as domain pattern to allow or deny and converts it into the internal list format.

**Data flow**: It receives serialized data from the deserializer. That data is read as a sorted map, each map pair becomes a `NetworkDomainPermissionEntry`, and the entries are stored in a new `NetworkDomainPermissions` value.

**Call relations**: Serde calls this while loading configuration. Unlike serialization, this step mostly reshapes the data; later code such as `effective_entries` decides what happens if entries conflict.

*Call graph*: 1 external calls (deserialize).


##### `NetworkDomainPermissions::effective_entries`  (lines 75–103)

```
fn effective_entries(&self) -> Vec<NetworkDomainPermissionEntry>
```

**Purpose**: Calculates the final domain rules after duplicate patterns are considered. If the same pattern appears with conflicting permissions, the stronger permission wins, with deny stronger than allow.

**Data flow**: It reads the stored entries in order. It remembers the first time each pattern appeared, keeps the strongest permission seen for that pattern, and then returns a cleaned list in original pattern order.

**Call relations**: `NetworkDomainPermissions::serialize` calls this so saved configuration reflects the real rules. `NetworkProxySettings::domain_entries` also relies on this behavior indirectly when it asks for allowed or denied domains.

*Call graph*: called by 1 (serialize); 2 external calls (new, new).


##### `NetworkProxySettings::default`  (lines 149–166)

```
fn default() -> Self
```

**Purpose**: Builds the default network proxy settings used when the user leaves fields out. The defaults keep the proxy disabled, bind it locally, and leave risky behavior turned off.

**Data flow**: It creates a full `NetworkProxySettings` value from fixed defaults, including default HTTP and SOCKS addresses, full network mode, no domain or socket rules, and empty MITM hook settings. The result is a complete settings object.

**Call relations**: Configuration loading uses this default when fields are missing. Many tests and other proxy components call it as a safe baseline before changing just the setting they care about.

*Call graph*: calls 2 internal fn (default_proxy_url, default_socks_url); called by 50 (network_domain_permissions_serialize_to_effective_map_shape, partial_network_config_uses_struct_defaults_for_missing_fields, set_allowed_domains_preserves_existing_deny_for_same_pattern, settings_with_unix_sockets, direct_connector_allows_non_public_target_when_local_binding_enabled, direct_connector_rejects_non_public_target_when_local_binding_disabled, http_connect_accept_allows_allowlisted_host_in_full_mode, http_connect_accept_blocks_in_limited_mode, http_connect_accept_denies_denylisted_host, http_plain_proxy_attempts_allowed_unix_socket_proxy (+15 more)); 2 external calls (new, default).


##### `NetworkProxySettings::allowed_domains`  (lines 170–172)

```
fn allowed_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Returns the list of domain patterns that are effectively allowed. It hides empty results by returning nothing instead of an empty list.

**Data flow**: It asks `domain_entries` for entries with the allow permission. If allow rules exist, it returns their patterns; if not, it returns `None`.

**Call relations**: Higher-level domain rule code calls this when it needs the allow side of the configuration. It is the public, simple wrapper around the shared filtering logic in `domain_entries`.

*Call graph*: calls 1 internal fn (domain_entries); called by 2 (entries, opposite_entries).


##### `NetworkProxySettings::denied_domains`  (lines 174–176)

```
fn denied_domains(&self) -> Option<Vec<String>>
```

**Purpose**: Returns the list of domain patterns that are effectively denied. It is the deny-side counterpart to `allowed_domains`.

**Data flow**: It asks `domain_entries` for entries with the deny permission. If denied patterns exist, it returns them; otherwise it returns `None`.

**Call relations**: Higher-level domain rule code calls this when it needs to know what should be blocked. It shares the same filtering path as allowed-domain lookup, so allow and deny results are based on the same conflict rules.

*Call graph*: calls 1 internal fn (domain_entries); called by 2 (entries, opposite_entries).


##### `NetworkProxySettings::domain_entries`  (lines 178–190)

```
fn domain_entries(&self, permission: NetworkDomainPermission) -> Option<Vec<String>>
```

**Purpose**: Filters the configured domain rules down to only one permission type, either allow or deny. It also avoids returning meaningless empty lists.

**Data flow**: It reads the optional domain permissions from the settings. If present, it takes the effective entries, keeps only entries with the requested permission, copies their patterns, and returns them if the result is non-empty.

**Call relations**: `allowed_domains` and `denied_domains` call this to avoid duplicating the same filtering work. It sits between the raw stored rules and the simple lists used elsewhere.

*Call graph*: called by 2 (allowed_domains, denied_domains).


##### `NetworkProxySettings::allow_unix_sockets`  (lines 192–206)

```
fn allow_unix_sockets(&self) -> Vec<String>
```

**Purpose**: Returns the Unix socket paths that the proxy is allowed to reach. A Unix socket is a local file-like endpoint used by services on the same machine, such as Docker.

**Data flow**: It reads the optional Unix socket permission map. It keeps only entries marked allow, copies their path strings, and returns an empty list if no socket rules are configured.

**Call relations**: `clamp_bind_addrs` calls this to decide whether Unix socket proxying is enabled. That matters because enabling local socket access forces the proxy to bind only to loopback addresses for safety.

*Call graph*: called by 1 (clamp_bind_addrs).


##### `NetworkProxySettings::set_allowed_domains`  (lines 208–210)

```
fn set_allowed_domains(&mut self, allowed_domains: Vec<String>)
```

**Purpose**: Replaces the current allow-list domain entries with a new set. It is a convenience method for callers that want to update allowed domains without touching deny rules directly.

**Data flow**: It receives a list of domain patterns. It passes that list and the allow permission to `set_domain_entries`, which rewrites the allow entries while preserving other permission types.

**Call relations**: Callers that edit configuration use this as the allow-specific front door. It hands the real update work to `set_domain_entries`.

*Call graph*: calls 1 internal fn (set_domain_entries).


##### `NetworkProxySettings::set_denied_domains`  (lines 212–214)

```
fn set_denied_domains(&mut self, denied_domains: Vec<String>)
```

**Purpose**: Replaces the current deny-list domain entries with a new set. It lets callers update blocked domains while leaving allow entries alone.

**Data flow**: It receives domain patterns to deny. It passes them with the deny permission to `set_domain_entries`, which updates the stored domain permission list.

**Call relations**: Callers that edit configuration use this as the deny-specific front door. It shares the same underlying update logic as `set_allowed_domains`.

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

**Purpose**: Adds or replaces one domain permission, using a caller-provided normalizer to decide when two patterns mean the same host. This is useful when a single domain rule changes interactively.

**Data flow**: It takes a host string, a permission, and a normalization function. It removes existing entries whose normalized pattern matches the new normalized host, appends the new entry, and stores the updated domain list or clears it if empty.

**Call relations**: This is an editing helper for code that updates one rule at a time. It does not call other project functions, but it follows the same storage format used by the rest of the settings.


##### `NetworkProxySettings::set_allow_unix_sockets`  (lines 234–236)

```
fn set_allow_unix_sockets(&mut self, allow_unix_sockets: Vec<String>)
```

**Purpose**: Replaces the configured list of Unix socket paths that are allowed. It is the public helper for setting socket allow rules.

**Data flow**: It receives path strings and passes them with the allow permission to `set_unix_socket_entries`. The settings are updated to contain those allowed socket paths.

**Call relations**: Callers use this instead of editing the socket permission map directly. It hands the detailed map update to `set_unix_socket_entries`.

*Call graph*: calls 1 internal fn (set_unix_socket_entries).


##### `NetworkProxySettings::set_domain_entries`  (lines 238–256)

```
fn set_domain_entries(&mut self, entries: Vec<String>, permission: NetworkDomainPermission)
```

**Purpose**: Updates all domain entries for one permission type while preserving entries of other types. It also avoids adding exact duplicates for the same pattern and permission.

**Data flow**: It temporarily takes the current domain list, removes entries with the target permission, appends the new non-duplicate entries, and then stores the list back only if it is not empty.

**Call relations**: `set_allowed_domains` and `set_denied_domains` call this as their shared worker. It keeps the two public setters consistent.

*Call graph*: called by 2 (set_allowed_domains, set_denied_domains).


##### `NetworkProxySettings::set_unix_socket_entries`  (lines 258–271)

```
fn set_unix_socket_entries(
        &mut self,
        entries: Vec<String>,
        permission: NetworkUnixSocketPermission,
    )
```

**Purpose**: Updates Unix socket permission entries for one permission type. In this file it is used to set the allow list.

**Data flow**: It temporarily takes the current socket permission map, removes entries with the target permission, inserts each new path with that permission, and then stores the map back only if it still has entries.

**Call relations**: `set_allow_unix_sockets` calls this to perform the actual map update. The resulting paths are later read by `allow_unix_sockets` and validated before runtime.

*Call graph*: called by 1 (set_allow_unix_sockets).


##### `NetworkMode::allows_method`  (lines 288–293)

```
fn allows_method(self, method: &str) -> bool
```

**Purpose**: Decides whether an HTTP method is permitted under the selected network mode. In limited mode, only read-style methods are allowed.

**Data flow**: It receives a network mode and a method string such as `GET` or `POST`. Full mode returns true for everything; limited mode returns true only for `GET`, `HEAD`, or `OPTIONS`.

**Call relations**: Request-handling code can call this when deciding whether to allow an HTTP request. It is the small policy check behind the larger limited-versus-full network behavior.

*Call graph*: 1 external calls (matches!).


##### `default_proxy_url`  (lines 296–298)

```
fn default_proxy_url() -> String
```

**Purpose**: Provides the default HTTP proxy listen address. The default points to localhost on port 3128.

**Data flow**: It takes no input. It returns the string `http://127.0.0.1:3128`.

**Call relations**: `NetworkProxySettings::default` calls this when building the default settings, and Serde also uses it for the `proxy_url` field when that field is missing.

*Call graph*: called by 1 (default).


##### `default_socks_url`  (lines 300–302)

```
fn default_socks_url() -> String
```

**Purpose**: Provides the default SOCKS5 proxy listen address. The default points to localhost on port 8081.

**Data flow**: It takes no input. It returns the string `http://127.0.0.1:8081`.

**Call relations**: `NetworkProxySettings::default` calls this when building the default settings, and Serde uses it for the `socks_url` field when omitted.

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

**Purpose**: Prevents the proxy from listening on outside-facing network addresses unless the user explicitly allows that dangerous behavior. A loopback address is one reachable only from the same machine.

**Data flow**: It receives a socket address, a boolean saying whether non-loopback binding is allowed, a human-readable proxy name, and the setting name for warnings. It returns the address unchanged if safe or explicitly allowed; otherwise it returns the same port on `127.0.0.1` and logs a warning.

**Call relations**: `clamp_bind_addrs` calls this once for the HTTP proxy and once for the SOCKS5 proxy. It is the first safety gate for bind addresses.

*Call graph*: called by 1 (clamp_bind_addrs); 4 external calls (from, ip, port, warn!).


##### `clamp_bind_addrs`  (lines 327–366)

```
fn clamp_bind_addrs(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    cfg: &NetworkProxySettings,
) -> (SocketAddr, SocketAddr)
```

**Purpose**: Applies final safety rules to the HTTP and SOCKS5 listen addresses before the proxy starts. It especially protects Unix socket access from being exposed to other machines.

**Data flow**: It receives proposed HTTP and SOCKS addresses plus the network settings. It first clamps each address with `clamp_non_loopback`; then, if Unix socket proxying is enabled, it forces both addresses to `127.0.0.1` even if non-loopback binding was otherwise allowed.

**Call relations**: `resolve_runtime` calls this after parsing configured addresses. Proxy startup code also uses it when building the running service, and tests check its safety behavior.

*Call graph*: calls 2 internal fn (allow_unix_sockets, clamp_non_loopback); called by 5 (resolve_runtime, clamp_bind_addrs_allows_non_loopback_when_enabled, clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled, clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled, build); 4 external calls (from, ip, port, warn!).


##### `UnixStyleAbsolutePath::parse`  (lines 377–379)

```
fn parse(value: &str) -> Option<Self>
```

**Purpose**: Recognizes paths that are absolute in Unix style because they start with `/`. This helps accept Unix-looking socket paths even on systems where Rust's native path rules may differ.

**Data flow**: It receives a path string. If the string starts with `/`, it wraps and returns it; otherwise it returns nothing.

**Call relations**: `ValidatedUnixSocketPath::parse` calls this after trying the platform-native absolute path check. It is the fallback for Unix-style absolute paths.

*Call graph*: called by 1 (parse).


##### `ValidatedUnixSocketPath::parse`  (lines 389–402)

```
fn parse(socket_path: &str) -> Result<Self>
```

**Purpose**: Checks that a Unix socket allow-list path is absolute. Absolute paths are required so the proxy does not accidentally trust a path whose meaning changes with the current directory.

**Data flow**: It receives a socket path string. It first accepts native absolute paths and normalizes them; if that fails, it accepts Unix-style paths starting with `/`; otherwise it returns an error explaining that an absolute path was expected.

**Call relations**: `validate_unix_socket_allowlist_paths` calls this during startup validation, and socket permission checks can call it when deciding whether a socket path is allowed.

*Call graph*: calls 2 internal fn (parse, from_absolute_path); called by 2 (validate_unix_socket_allowlist_paths, is_unix_socket_allowed); 4 external calls (new, Native, UnixStyleAbsolute, bail!).


##### `validate_unix_socket_allowlist_paths`  (lines 405–411)

```
fn validate_unix_socket_allowlist_paths(cfg: &NetworkProxyConfig) -> Result<()>
```

**Purpose**: Validates every configured allowed Unix socket path. It makes configuration errors clear before the proxy starts.

**Data flow**: It reads allowed Unix socket paths from the network settings. Each path is passed to `ValidatedUnixSocketPath::parse`; if any path is invalid, the returned error includes the list index that failed.

**Call relations**: `resolve_runtime` calls this before resolving bind addresses, and configuration-state building code also calls it. It is the startup guard for socket allow-list correctness.

*Call graph*: calls 1 internal fn (parse); called by 2 (resolve_runtime, build_config_state).


##### `resolve_runtime`  (lines 413–426)

```
fn resolve_runtime(cfg: &NetworkProxyConfig) -> Result<RuntimeConfig>
```

**Purpose**: Turns user configuration into the concrete runtime addresses the proxy will use. It validates socket paths, parses listen URLs, and applies safety clamps.

**Data flow**: It receives the full proxy config. It validates Unix socket allow-list paths, resolves the HTTP and SOCKS address strings into `SocketAddr` values, clamps unsafe bind addresses, and returns a `RuntimeConfig` with final addresses.

**Call relations**: Proxy startup calls this before binding network listeners. It coordinates `validate_unix_socket_allowlist_paths`, `resolve_addr`, and `clamp_bind_addrs` into one startup-ready result.

*Call graph*: calls 3 internal fn (clamp_bind_addrs, resolve_addr, validate_unix_socket_allowlist_paths); called by 2 (resolve_runtime_rejects_relative_allow_unix_sockets_entries, build).


##### `resolve_addr`  (lines 428–439)

```
fn resolve_addr(url: &str, default_port: u16) -> Result<SocketAddr>
```

**Purpose**: Converts a configured address string into a concrete IP address and port. Hostnames are deliberately mapped to loopback rather than resolved through DNS.

**Data flow**: It receives a URL-like address and a default port. It uses `parse_host_port` to extract host and port, turns `localhost` into `127.0.0.1`, keeps literal IP addresses, and maps other hostnames to `127.0.0.1` with the chosen port.

**Call relations**: `resolve_runtime` calls this for both the HTTP proxy URL and the SOCKS URL. It provides the concrete addresses that `clamp_bind_addrs` then safety-checks.

*Call graph*: calls 1 internal fn (parse_host_port); called by 1 (resolve_runtime); 2 external calls (from, new).


##### `host_and_port_from_network_addr`  (lines 441–455)

```
fn host_and_port_from_network_addr(value: &str, default_port: u16) -> String
```

**Purpose**: Formats a network address setting as a simple `host:port` display string. It is forgiving, so it can still produce a useful display even for imperfect input.

**Data flow**: It receives an address string and a default port. Empty input becomes `<missing>`; parseable input is normalized with `parse_host_port`; unparseable input is formatted with the default port.

**Call relations**: This helper uses `parse_host_port` for normal cases and `format_host_and_port` for final display formatting. It is meant for showing addresses, not for opening sockets.

*Call graph*: calls 2 internal fn (format_host_and_port, parse_host_port).


##### `format_host_and_port`  (lines 457–463)

```
fn format_host_and_port(host: &str, port: u16) -> String
```

**Purpose**: Builds a display string from a host and port, using brackets when needed for IPv6 addresses. Brackets keep IPv6 colons from being confused with the port separator.

**Data flow**: It receives a host string and a port number. If the host contains a colon, it returns `[host]:port`; otherwise it returns `host:port`.

**Call relations**: `host_and_port_from_network_addr` calls this after it has chosen the host and port to display.

*Call graph*: called by 1 (host_and_port_from_network_addr); 1 external calls (format!).


##### `parse_host_port`  (lines 471–506)

```
fn parse_host_port(url: &str, default_port: u16) -> Result<SocketAddressParts>
```

**Purpose**: Extracts a host and port from flexible address input. It accepts full URLs, plain `host:port`, hostnames without ports, and IPv6 forms.

**Data flow**: It trims the input, rejects empty values, treats unbracketed IPv6 literals carefully, tries the standard URL parser with a temporary scheme if needed, and falls back to manual parsing if the URL parser cannot help.

**Call relations**: `resolve_addr` calls this for runtime binding, and `host_and_port_from_network_addr` calls it for display. It hands difficult leftovers to `parse_host_port_fallback`.

*Call graph*: calls 1 internal fn (parse_host_port_fallback); called by 2 (host_and_port_from_network_addr, resolve_addr); 4 external calls (parse, bail!, format!, matches!).


##### `parse_host_port_fallback`  (lines 508–557)

```
fn parse_host_port_fallback(input: &str, default_port: u16) -> Result<SocketAddressParts>
```

**Purpose**: Manually extracts host and port when normal URL parsing is not enough. It covers loose or unusual address strings without accidentally breaking IPv6 addresses.

**Data flow**: It removes any scheme, path, and user-info prefix, then looks for bracketed IPv6 with an optional port or a single-colon `host:port` form. If no port is found, it uses the default port; if no host exists, it returns an error.

**Call relations**: `parse_host_port` calls this only after its preferred parsing path fails. It is the backup parser that keeps configuration input flexible.

*Call graph*: called by 1 (parse_host_port); 1 external calls (bail!).


##### `tests::settings_with_unix_sockets`  (lines 565–576)

```
fn settings_with_unix_sockets(unix_sockets: &[&str]) -> NetworkProxySettings
```

**Purpose**: Builds test settings with a chosen Unix socket allow list. It saves each test from repeating setup code.

**Data flow**: It receives a slice of socket path strings. It starts from default settings, optionally sets those paths as allowed Unix sockets, and returns the settings.

**Call relations**: Several tests call this helper before checking address clamping or runtime validation. It relies on `NetworkProxySettings::default` for the safe baseline.

*Call graph*: calls 1 internal fn (default).


##### `tests::network_proxy_settings_default_matches_local_use_baseline`  (lines 579–599)

```
fn network_proxy_settings_default_matches_local_use_baseline()
```

**Purpose**: Checks that the default settings stay aligned with the intended safe local baseline. This prevents accidental changes to important defaults.

**Data flow**: It constructs the default settings and compares them with an explicitly written expected settings value. The test passes only if every field matches.

**Call relations**: The Rust test runner calls this test. It protects `NetworkProxySettings::default` from quiet regressions.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::partial_network_config_uses_struct_defaults_for_missing_fields`  (lines 602–617)

```
fn partial_network_config_uses_struct_defaults_for_missing_fields()
```

**Purpose**: Checks that loading a partial configuration fills in missing network fields with defaults. Users should not have to specify every field manually.

**Data flow**: It parses JSON containing only `enabled: true`, builds the expected settings by changing that one default field, and compares the two.

**Call relations**: The test runner calls this test. It verifies the interaction between Serde configuration loading and `NetworkProxySettings::default`.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, from_str).


##### `tests::set_allowed_domains_preserves_existing_deny_for_same_pattern`  (lines 620–631)

```
fn set_allowed_domains_preserves_existing_deny_for_same_pattern()
```

**Purpose**: Checks that deny wins when the same domain is both denied and allowed. This protects the safer conflict rule.

**Data flow**: It starts from default settings, denies `example.com`, then tries to allow the same domain. It verifies there is no effective allow entry and that the deny entry remains.

**Call relations**: The test runner calls this test. It exercises the domain setters and the effective permission logic used by `allowed_domains` and `denied_domains`.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, vec!).


##### `tests::network_domain_permissions_serialize_to_effective_map_shape`  (lines 634–665)

```
fn network_domain_permissions_serialize_to_effective_map_shape()
```

**Purpose**: Checks that domain permissions serialize as the final effective map, not as raw duplicate entries. This keeps saved configuration clean and faithful to actual behavior.

**Data flow**: It creates settings with conflicting allow and deny entries for the same domain, serializes the config to JSON, and compares it with JSON containing only the effective deny rule.

**Call relations**: The test runner calls this test. It verifies `NetworkDomainPermissions::serialize` and its use of effective entries.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert_eq!, to_value, vec!).


##### `tests::parse_host_port_defaults_for_empty_string`  (lines 668–670)

```
fn parse_host_port_defaults_for_empty_string()
```

**Purpose**: Checks that an empty address is rejected instead of silently becoming some default host. That makes missing configuration obvious.

**Data flow**: It passes an empty string to `parse_host_port` and asserts that the result is an error.

**Call relations**: The test runner calls this test. It protects the missing-host error path in `parse_host_port`.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_host_port_defaults_for_whitespace`  (lines 673–675)

```
fn parse_host_port_defaults_for_whitespace()
```

**Purpose**: Checks that an address containing only spaces is rejected. Whitespace should be treated as missing input.

**Data flow**: It passes a whitespace-only string to `parse_host_port` and asserts that parsing fails.

**Call relations**: The test runner calls this test. It verifies that trimming in `parse_host_port` does not hide an empty value.

*Call graph*: 1 external calls (assert!).


##### `tests::parse_host_port_parses_host_port_without_scheme`  (lines 678–686)

```
fn parse_host_port_parses_host_port_without_scheme()
```

**Purpose**: Checks that plain `host:port` input works even without `http://`. This supports convenient configuration.

**Data flow**: It parses `127.0.0.1:8080` with a default port and expects host `127.0.0.1` and port `8080`.

**Call relations**: The test runner calls this test. It protects the common loose-address path in `parse_host_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_parses_host_port_with_scheme_and_path`  (lines 689–701)

```
fn parse_host_port_parses_host_port_with_scheme_and_path()
```

**Purpose**: Checks that full URL input is parsed correctly, ignoring the path for bind-address purposes. Only host and port matter here.

**Data flow**: It parses `http://example.com:8080/some/path` and expects host `example.com` with port `8080`.

**Call relations**: The test runner calls this test. It verifies the standard URL parser path inside `parse_host_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_strips_userinfo`  (lines 704–716)

```
fn parse_host_port_strips_userinfo()
```

**Purpose**: Checks that usernames and passwords in URL-like input do not become part of the host. This keeps parsing correct for addresses that include credentials.

**Data flow**: It parses `http://user:pass@host.example:5555` and expects only `host.example` and port `5555`.

**Call relations**: The test runner calls this test. It verifies that `parse_host_port` extracts the real host from URL-style input.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_parses_ipv6_with_brackets`  (lines 719–727)

```
fn parse_host_port_parses_ipv6_with_brackets()
```

**Purpose**: Checks that bracketed IPv6 addresses parse correctly. IPv6 uses colons internally, so brackets show where the host ends and the port begins.

**Data flow**: It parses `http://[::1]:9999` and expects host `::1` and port `9999`.

**Call relations**: The test runner calls this test. It protects IPv6 support in `parse_host_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_does_not_treat_unbracketed_ipv6_as_host_port`  (lines 730–738)

```
fn parse_host_port_does_not_treat_unbracketed_ipv6_as_host_port()
```

**Purpose**: Checks that an unbracketed IPv6 address is not mistaken for a `host:port` pair. This avoids splitting IPv6 at the wrong colon.

**Data flow**: It parses `2001:db8::1` with default port `3128` and expects the whole string as the host plus the default port.

**Call relations**: The test runner calls this test. It verifies the special IPv6 guard near the start of `parse_host_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_host_port_falls_back_to_default_port_when_port_is_invalid`  (lines 741–749)

```
fn parse_host_port_falls_back_to_default_port_when_port_is_invalid()
```

**Purpose**: Checks that an invalid port text falls back to the default port. This matches the parser's forgiving behavior for loose input.

**Data flow**: It parses `example.com:notaport` with default port `3128` and expects host `example.com` with port `3128`.

**Call relations**: The test runner calls this test. It covers the fallback behavior used by `parse_host_port` and its manual parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::host_and_port_from_network_addr_defaults_for_empty_string`  (lines 752–757)

```
fn host_and_port_from_network_addr_defaults_for_empty_string()
```

**Purpose**: Checks that display formatting reports missing address input clearly. Empty input should show as `<missing>`.

**Data flow**: It passes an empty string to `host_and_port_from_network_addr` and expects the string `<missing>`.

**Call relations**: The test runner calls this test. It verifies the user-facing display helper's empty-input branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::host_and_port_from_network_addr_formats_ipv6`  (lines 760–765)

```
fn host_and_port_from_network_addr_formats_ipv6()
```

**Purpose**: Checks that IPv6 display strings include brackets. This makes the displayed host and port unambiguous.

**Data flow**: It formats `http://[::1]:8080` and expects `[::1]:8080`.

**Call relations**: The test runner calls this test. It covers `host_and_port_from_network_addr` and the bracket logic in `format_host_and_port`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_maps_localhost_to_loopback`  (lines 768–773)

```
fn resolve_addr_maps_localhost_to_loopback()
```

**Purpose**: Checks that `localhost` becomes the concrete loopback IP address. This avoids depending on hostname lookup.

**Data flow**: It resolves `localhost` with default port `3128` and expects `127.0.0.1:3128`.

**Call relations**: The test runner calls this test. It protects the hostname mapping behavior in `resolve_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_parses_ip_literals`  (lines 776–781)

```
fn resolve_addr_parses_ip_literals()
```

**Purpose**: Checks that plain IPv4 address strings resolve directly. Literal IP addresses should be preserved.

**Data flow**: It resolves `1.2.3.4` with default port `80` and expects `1.2.3.4:80`.

**Call relations**: The test runner calls this test. It verifies the IP-literal path in `resolve_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_parses_ipv6_literals`  (lines 784–789)

```
fn resolve_addr_parses_ipv6_literals()
```

**Purpose**: Checks that IPv6 literal URLs resolve correctly. This confirms IPv6 bind addresses are supported.

**Data flow**: It resolves `http://[::1]:8080` and expects the matching IPv6 socket address.

**Call relations**: The test runner calls this test. It exercises `resolve_addr` through the IPv6 parsing path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_addr_falls_back_to_loopback_for_hostnames`  (lines 792–797)

```
fn resolve_addr_falls_back_to_loopback_for_hostnames()
```

**Purpose**: Checks that ordinary hostnames do not cause external DNS resolution for bind addresses. They are mapped to loopback with the configured port.

**Data flow**: It resolves `http://example.com:5555` and expects `127.0.0.1:5555`.

**Call relations**: The test runner calls this test. It protects the safety choice made inside `resolve_addr` for non-IP hostnames.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::clamp_bind_addrs_allows_non_loopback_when_enabled`  (lines 800–812)

```
fn clamp_bind_addrs_allows_non_loopback_when_enabled()
```

**Purpose**: Checks that the explicit dangerous setting really allows outside-facing bind addresses when no Unix socket proxying is enabled.

**Data flow**: It builds settings with non-loopback binding allowed, passes `0.0.0.0` HTTP and SOCKS addresses to `clamp_bind_addrs`, and expects both addresses to remain unchanged.

**Call relations**: The test runner calls this test. It verifies the override path through `clamp_bind_addrs` and `clamp_non_loopback`.

*Call graph*: calls 1 internal fn (clamp_bind_addrs); 2 external calls (default, assert_eq!).


##### `tests::clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled`  (lines 815–828)

```
fn clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled()
```

**Purpose**: Checks that Unix socket proxying forces local-only binding even when the dangerous non-loopback setting is enabled. This prevents remote users from reaching local sockets through the proxy.

**Data flow**: It creates settings with an allowed Unix socket and non-loopback binding enabled, passes outside-facing addresses to `clamp_bind_addrs`, and expects both to become `127.0.0.1` on the same ports.

**Call relations**: The test runner calls this test. It uses `settings_with_unix_sockets` and checks the Unix-socket safety branch in `clamp_bind_addrs`.

*Call graph*: calls 1 internal fn (clamp_bind_addrs); 2 external calls (assert_eq!, settings_with_unix_sockets).


##### `tests::clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled`  (lines 831–844)

```
fn clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled()
```

**Purpose**: Checks the same local-only safety rule when all Unix sockets are allowed. This is an even broader and riskier setting, so loopback binding is required.

**Data flow**: It creates settings with `dangerously_allow_all_unix_sockets` and non-loopback binding enabled, runs `clamp_bind_addrs`, and expects both addresses to be clamped to `127.0.0.1`.

**Call relations**: The test runner calls this test. It covers the all-sockets branch of the safety logic in `clamp_bind_addrs`.

*Call graph*: calls 1 internal fn (clamp_bind_addrs); 2 external calls (default, assert_eq!).


##### `tests::resolve_runtime_rejects_relative_allow_unix_sockets_entries`  (lines 847–863)

```
fn resolve_runtime_rejects_relative_allow_unix_sockets_entries()
```

**Purpose**: Checks that startup rejects relative Unix socket allow-list entries. Relative paths are unsafe because their target depends on the process working directory.

**Data flow**: It builds a config allowing `relative.sock`, calls `resolve_runtime`, expects an error, and checks that the error message points to the bad allow-list index.

**Call relations**: The test runner calls this test. It verifies that `resolve_runtime` calls `validate_unix_socket_allowlist_paths` before accepting runtime settings.

*Call graph*: calls 1 internal fn (resolve_runtime); 3 external calls (assert!, settings_with_unix_sockets, panic!).


##### `tests::resolve_runtime_accepts_unix_style_absolute_allow_unix_sockets_entries`  (lines 866–875)

```
fn resolve_runtime_accepts_unix_style_absolute_allow_unix_sockets_entries()
```

**Purpose**: Checks that Unix-style absolute socket paths are accepted. Paths beginning with `/` should work for Unix socket allow lists.

**Data flow**: It builds a config allowing `/private/tmp/example.sock` and asserts that `resolve_runtime` succeeds.

**Call relations**: The test runner calls this test. It confirms the positive path through `ValidatedUnixSocketPath::parse` and runtime resolution.

*Call graph*: 2 external calls (assert!, settings_with_unix_sockets).


### Version and release diagnostics
These utilities expose the current build version and validate or compare external release metadata for update and publish checks.

### `tui/src/npm_registry.rs`

`domain_logic` · `update checking`

This file is a safety check around npm, the package registry used for JavaScript packages. The app can compare a GitHub release version with the npm registry entry for `@openai/codex`. Before saying an update is available, it needs to know that npm has really finished publishing that exact version.

The file defines simple data shapes for the parts of the npm response it cares about: the `dist-tags` map, the list of versions, and each version's `dist` data. In npm, the `latest` dist-tag is like a store shelf label saying “this is the current version.” The `dist` section then gives the actual package download address and an integrity string, which is a checksum-like value used to verify the downloaded package has not been changed.

The main check, `ensure_version_ready`, first trims the requested version and confirms that npm's `latest` tag points to that exact version. Then it asks `version_info_with_dist` to make sure that version exists and has both a non-empty tarball URL and non-empty integrity value. If anything is missing or stale, it returns a clear error instead of silently accepting a half-published package.

The tests build small fake npm responses and verify the important cases: a good package passes, a stale `latest` tag fails, and missing distribution metadata fails.

#### Function details

##### `ensure_version_ready`  (lines 25–41)

```
fn ensure_version_ready(
    package_info: &NpmPackageInfo,
    version: &str,
) -> anyhow::Result<()>
```

**Purpose**: Checks whether the npm registry data says a particular version is truly ready to use. It makes sure npm's `latest` label matches the expected release version and that the package version has the download and verification details needed for installation.

**Data flow**: It receives parsed npm package information and a version string. It trims extra spaces from the version, reads the `latest` entry from the registry's dist-tags, compares it with the expected version, then asks `version_info_with_dist` to inspect the version's distribution data. If all checks pass, it returns success with no extra value; if something is wrong, it returns an explanatory error.

**Call relations**: This is the public check used by the update flow, including `check_for_update`, before trusting npm as ready for a release. The tests also call it directly to prove that good metadata is accepted and broken metadata is rejected. When the top-level `latest` tag looks right, it hands the deeper version-specific validation to `version_info_with_dist`.

*Call graph*: calls 1 internal fn (version_info_with_dist); called by 4 (ready_version_rejects_missing_root_dist, ready_version_rejects_stale_latest_dist_tag, ready_version_requires_latest_dist_tag_and_root_dist, check_for_update); 1 external calls (bail!).


##### `version_info_with_dist`  (lines 43–69)

```
fn version_info_with_dist(
    package_info: &'a NpmPackageInfo,
    version: &str,
) -> anyhow::Result<&'a NpmPackageVersionInfo>
```

**Purpose**: Looks up one exact package version and verifies that npm included the metadata needed to download and verify it. This is the stricter, version-level part of the readiness check.

**Data flow**: It receives the parsed package information and the version to find. It searches the `versions` map for that version, checks that the version has a `dist` section, then confirms that `dist.tarball` and `dist.integrity` are both present and not empty. It returns a reference to the version information when everything is valid, or an error describing the missing piece.

**Call relations**: It is called by `ensure_version_ready` after the registry's `latest` tag has already matched the expected version. This keeps the larger check readable: `ensure_version_ready` decides whether npm points at the right release, while this helper confirms the release entry is complete enough to use.

*Call graph*: called by 1 (ensure_version_ready); 1 external calls (bail!).


##### `tests::version_json`  (lines 75–82)

```
fn version_json(version: &str) -> serde_json::Value
```

**Purpose**: Builds a small fake npm version entry for tests. It creates realistic-looking `dist` data for a supplied version so the tests do not need to repeat the same JSON shape by hand.

**Data flow**: It receives a version string. It inserts that version into a fake integrity value and tarball URL, wraps them in a JSON object shaped like npm's version metadata, and returns that JSON value for test setup.

**Call relations**: The test helper `tests::package_info` calls this when it needs to create a complete fake version entry. It is part of the test scaffolding that lets the actual test cases focus on what condition is being checked.

*Call graph*: 1 external calls (json!).


##### `tests::package_info`  (lines 84–93)

```
fn package_info(github_latest: &str, npm_latest: &str) -> NpmPackageInfo
```

**Purpose**: Creates a fake parsed npm package response for tests. It lets each test choose what GitHub thinks the latest version is and what npm's `latest` tag says.

**Data flow**: It receives two version strings: one to include as the available version entry, and one to use as npm's `latest` tag. It builds a JSON object with `dist-tags` and `versions`, uses `tests::version_json` to make the version's download metadata, then deserializes the JSON into `NpmPackageInfo`. The result is ready to pass into `ensure_version_ready`.

**Call relations**: The positive test and stale-tag test call this helper to create their input data. It sits between raw JSON construction and the real validation function, so the tests exercise the same parsed data shape that production code uses.

*Call graph*: 4 external calls (new, from_value, json!, version_json).


##### `tests::ready_version_requires_latest_dist_tag_and_root_dist`  (lines 96–101)

```
fn ready_version_requires_latest_dist_tag_and_root_dist()
```

**Purpose**: Tests the happy path: npm says the expected version is `latest`, and that version has the needed distribution metadata. It proves that valid registry data is accepted.

**Data flow**: It creates fake package information where both the expected release and npm's `latest` tag are `1.2.3`. It passes that data into `ensure_version_ready` and expects the result to be successful.

**Call relations**: This test uses `tests::package_info` to build valid input, then calls the same `ensure_version_ready` function used by update checking. It confirms the guard does not block a properly published package.

*Call graph*: calls 1 internal fn (ensure_version_ready); 1 external calls (package_info).


##### `tests::ready_version_rejects_stale_latest_dist_tag`  (lines 104–113)

```
fn ready_version_rejects_stale_latest_dist_tag()
```

**Purpose**: Tests that a package is rejected when npm's `latest` label still points to an older version. This protects users from a release state where GitHub and npm disagree.

**Data flow**: It creates fake package information where the desired version exists as `1.2.3`, but npm's `latest` tag says `1.2.2`. It calls `ensure_version_ready`, expects an error, and checks that the error message mentions the stale `latest` tag.

**Call relations**: This test uses `tests::package_info` to create a mismatch, then exercises `ensure_version_ready`. It verifies the first stage of the readiness check: npm must point `latest` at the same version the update flow expects.

*Call graph*: calls 1 internal fn (ensure_version_ready); 2 external calls (assert!, package_info).


##### `tests::ready_version_rejects_missing_root_dist`  (lines 116–129)

```
fn ready_version_rejects_missing_root_dist()
```

**Purpose**: Tests that a version is rejected when its npm entry lacks the `dist` metadata needed for downloading and verification. This catches a package record that exists but is not usable.

**Data flow**: It builds fake npm package information where the `latest` tag points to `1.2.3` and the version entry exists, but that entry has no `dist` section. It passes the data to `ensure_version_ready`, expects an error, and checks that the error explains the missing distribution metadata.

**Call relations**: This test constructs its JSON directly so it can leave out the `dist` section on purpose. It calls `ensure_version_ready`, which in turn relies on `version_info_with_dist` to catch the missing metadata.

*Call graph*: calls 1 internal fn (ensure_version_ready); 3 external calls (assert!, from_value, json!).


### `tui/src/update_versions.rs`

`util` · `upgrade check`

This file supports the app’s upgrade-checking behavior. When the program hears about a latest release, it needs to answer simple questions: “What version number is in this tag?”, “Is that newer than what I am running?”, and “Am I running a special source build where update checks should be skipped?” Without these helpers, the update prompt could show at the wrong time, fail on valid release tags, or try to compare versions it does not understand.

The file deliberately uses a simple version format: three numbers separated by dots, like `1.2.3`. This is often called semantic versioning, but this code only accepts the plain numeric shape. If a version has extra labels such as `1.0.0-rc.1` or `0.11.0-beta.1`, the parser rejects it instead of guessing. In that case, comparison returns `None`, meaning “I cannot safely say.”

The main flow is like checking dates on two product labels. First, `parse_version` trims whitespace and splits a version into major, minor, and patch numbers. Then `is_newer` compares those number triples. `extract_version_from_latest_tag` removes the project’s expected GitHub tag prefix, `rust-v`, so `rust-v1.5.0` becomes `1.5.0`. The tests pin down these rules so update messages stay predictable.

#### Function details

##### `is_newer`  (lines 1–6)

```
fn is_newer(latest: &str, current: &str) -> Option<bool>
```

**Purpose**: Compares two plain version strings and says whether the latest one is newer than the current one. If either version is not in the simple `number.number.number` format, it returns “unknown” instead of making a risky guess.

**Data flow**: It receives two text strings: the reported latest version and the current running version. It sends both through `parse_version`, which tries to turn each into three numbers. If both parse successfully, it compares the number triples and returns `Some(true)` or `Some(false)`; if either parse fails, it returns `None`.

**Call relations**: This function relies on `parse_version` for the careful text-to-number step. It is the comparison layer that other update-checking code can use after a latest release version has been discovered.

*Call graph*: calls 1 internal fn (parse_version).


##### `extract_version_from_latest_tag`  (lines 8–13)

```
fn extract_version_from_latest_tag(latest_tag_name: &str) -> anyhow::Result<String>
```

**Purpose**: Pulls the usable version number out of a GitHub release tag that is expected to start with `rust-v`. For example, it turns `rust-v1.5.0` into `1.5.0`.

**Data flow**: It receives a tag name as text. It checks whether the text begins with `rust-v`; if so, it removes that prefix and returns the rest as the version string. If the prefix is missing, it returns an error explaining that the tag could not be parsed.

**Call relations**: This function is called by `fetch_latest_github_release_version` after release information has been fetched. It translates the release tag into the plain version text that the rest of the upgrade-checking path can compare.

*Call graph*: called by 1 (fetch_latest_github_release_version).


##### `is_source_build_version`  (lines 15–17)

```
fn is_source_build_version(version: &str) -> bool
```

**Purpose**: Detects the special version `0.0.0`, which represents a build made from source rather than a normal packaged release. The update UI can use this to avoid showing normal upgrade checks for that kind of build.

**Data flow**: It receives a version string. It uses `parse_version` to turn the text into three numbers, then checks whether those numbers are exactly `(0, 0, 0)`. It returns `true` only for that exact parsed value; otherwise it returns `false`.

**Call relations**: This function is used by `get_upgrade_version` and `get_upgrade_version_for_popup` when deciding whether an upgrade check or popup should proceed. It hands those callers a simple yes-or-no answer about whether the current version is a source build.

*Call graph*: calls 1 internal fn (parse_version); called by 2 (get_upgrade_version, get_upgrade_version_for_popup).


##### `parse_version`  (lines 19–25)

```
fn parse_version(v: &str) -> Option<(u64, u64, u64)>
```

**Purpose**: Turns a simple version string like `1.2.3` into three numbers that Rust can compare safely. It is intentionally strict and does not accept prerelease suffixes or other extra text.

**Data flow**: It receives version text, trims surrounding whitespace, and splits the text at dots. It then tries to read the first three pieces as unsigned numbers: major, minor, and patch. If all three are present and numeric, it returns them as a tuple; if any part is missing or not numeric, it returns `None`.

**Call relations**: This is the shared helper underneath `is_newer` and `is_source_build_version`. Those functions depend on it to reject unclear version strings before they make update decisions.

*Call graph*: called by 2 (is_newer, is_source_build_version).


##### `tests::extracts_version_from_latest_tag`  (lines 33–38)

```
fn extracts_version_from_latest_tag()
```

**Purpose**: Checks that a correctly formatted release tag can be converted into a plain version string.

**Data flow**: It gives `extract_version_from_latest_tag` the text `rust-v1.5.0`. The function should remove the expected prefix and return `1.5.0`; the test compares the result with that expected value.

**Call relations**: This test protects the behavior used later by `fetch_latest_github_release_version`, making sure release tags from GitHub are translated in the format the comparison code expects.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::latest_tag_without_prefix_is_invalid`  (lines 41–43)

```
fn latest_tag_without_prefix_is_invalid()
```

**Purpose**: Checks that a tag without the required `rust-v` prefix is treated as invalid.

**Data flow**: It passes `v1.5.0` into `extract_version_from_latest_tag`. Because the expected prefix is missing, the function should return an error, and the test confirms that an error occurred.

**Call relations**: This test supports the same release-fetching path by making sure unexpected tag names do not silently turn into misleading version numbers.

*Call graph*: 1 external calls (assert!).


##### `tests::prerelease_version_is_not_considered_newer`  (lines 46–49)

```
fn prerelease_version_is_not_considered_newer()
```

**Purpose**: Checks that prerelease-style versions, such as beta or release-candidate labels, are not compared as if they were ordinary releases.

**Data flow**: It asks `is_newer` to compare `0.11.0-beta.1` with `0.11.0`, and `1.0.0-rc.1` with `1.0.0`. Since those latest-version strings are not plain three-number versions, the result should be `None` in both cases.

**Call relations**: This test protects the strict parsing rule used by `is_newer`: if `parse_version` cannot understand a version cleanly, update-checking code should get “unknown,” not a possibly wrong newer-or-older answer.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plain_semver_comparisons_work`  (lines 52–57)

```
fn plain_semver_comparisons_work()
```

**Purpose**: Checks that ordinary three-part version comparisons behave as people expect.

**Data flow**: It feeds several plain version pairs into `is_newer`: patch increases, patch decreases, major version increases, and major version decreases. Each call should return `Some(true)` or `Some(false)` according to the numeric ordering.

**Call relations**: This test confirms that `is_newer` and `parse_version` work together for the normal release versions the upgrade checker is designed to handle.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::source_build_version_is_not_checked`  (lines 60–63)

```
fn source_build_version_is_not_checked()
```

**Purpose**: Checks that only `0.0.0` is recognized as the special source-build version.

**Data flow**: It calls `is_source_build_version` with `0.0.0` and expects `true`. It then calls the same function with `0.1.0` and expects `false`.

**Call relations**: This test protects the decision used by `get_upgrade_version` and `get_upgrade_version_for_popup`, so normal versions are not accidentally skipped and source builds are not accidentally prompted for regular upgrades.

*Call graph*: 1 external calls (assert!).


##### `tests::whitespace_is_ignored`  (lines 66–69)

```
fn whitespace_is_ignored()
```

**Purpose**: Checks that extra spaces or newline characters around a version do not stop parsing or comparison.

**Data flow**: It gives `parse_version` the text ` 1.2.3 \n` and expects the numbers `(1, 2, 3)`. It also asks `is_newer` to compare ` 1.2.3 ` with `1.2.2` and expects the latest version to be considered newer.

**Call relations**: This test confirms that `parse_version` cleans up harmless surrounding whitespace before `is_newer` or other callers rely on its result.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/version.rs`

`config` · `compile time and version reporting`

This file is a tiny but useful source of truth for the app's version number. When the Codex CLI is compiled, Rust reads the package version from the project's build metadata and places it into the program as a constant named `CODEX_CLI_VERSION`. That means the running program does not need to open a file or ask an external service to know its own version; the answer is already built in.

This matters for things like `--version` output, diagnostics, logs, bug reports, or user interface screens that need to say exactly which release is running. Without this file, different parts of the program might invent their own way to find the version, which could lead to duplicated code or inconsistent answers.

A simple analogy: this is like a label printed on a product at the factory. Once the product ships, anyone can read the label to know which version they have.
