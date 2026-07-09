# Auxiliary binaries and developer tools  `stage-1.2`

This stage is the toolbox beside the main Codex program. These binaries are run directly by developers, tests, editors, or helper processes, rather than through the normal user command. Some tools produce machine-readable descriptions: config_schema and schema.rs describe valid config.toml settings, protocol exporters write TypeScript and JSON Schema files, hook and app-server fixture writers refresh checked-in schemas, and generate-proto rebuilds Rust code from Protocol Buffers. Some tools do focused user work: apply_patch edits files from a patch, file-search finds likely matching paths, md-events shows how Markdown is parsed, and state logs_client watches stored logs like tail -f. Others start services or bridges: the app server, MCP server, Responses API proxy, stdio-to-socket bridge, exec server, filesystem helper, and test MCP/app clients. Several are samples or test probes, including extension examples, notification capture helpers, custom certificate checks, and Wine or Windows exec-server runners. The remaining tools enforce safe execution: execpolicy checkers decide whether commands are allowed, while Linux, Bubblewrap, Unix execve, and Windows sandbox launchers set up restricted environments before running commands.

## Files in this stage

### Schema and protocol generators
These binaries and helpers generate or refresh schemas, bindings, and protocol fixtures used by other tools and tests.

### `core/src/bin/config_schema.rs`

`entrypoint` · `developer tooling / schema generation`

This is a helper program for producing documentation-like machine-readable rules for the project’s configuration file. A JSON Schema is a standard format that describes what fields are allowed, what types of values they should have, and how a configuration file should be shaped. Without this tool, the schema would have to be written or updated by hand, which could easily drift away from the real configuration code.

When the program runs, it reads command-line arguments using `clap`, a library that turns typed Rust structures into command-line options. The user may provide an output path with `--out` or `-o`. If they do not, the program writes to `config.schema.json` in the crate’s main directory.

After choosing the destination path, the program asks `codex_config::schema::write_config_schema` to do the real work of generating and saving the schema. This file is therefore mostly a front door: it gathers the user’s requested output location, picks a sensible default when needed, and hands the job to the configuration schema code. If writing fails, the error is returned so the command-line run can report failure instead of silently producing a missing or broken file.

#### Function details

##### `main`  (lines 13–20)

```
fn main() -> Result<()>
```

**Purpose**: Runs the `codex-write-config-schema` command-line tool. It decides where the generated `config.schema.json` file should go, then asks the configuration schema code to write it there.

**Data flow**: It starts with command-line input from the user. It parses that input into an `Args` value, checks whether an output path was provided, and otherwise builds a default path next to the crate’s manifest. It then passes that path to `write_config_schema`; on success it returns `Ok(())`, and on failure it returns the error to the operating system-facing command runner.

**Call relations**: This is the program’s entry point, so it is called when the binary starts. It first calls `Args::parse` from `clap` to understand the command-line options, then hands the chosen file path to `write_config_schema`, which performs the actual schema generation and file writing.

*Call graph*: calls 1 internal fn (write_config_schema); 1 external calls (parse).


### `config/src/schema.rs`

`config` · `config schema generation`

This file is like the rulebook for the configuration file. A `config.toml` file is written by humans, but the project also needs a precise way to say which sections, keys, and value types are valid. This code creates that precise rulebook as JSON Schema, a common format that editors, validators, and tests can understand.

Most of the file is about special cases in the configuration. The `[features]` section is not just any free-form map: it may contain only known feature flags and older legacy names. Most features are simple true-or-false switches, but a few have their own small configuration objects, so the schema gives those keys a more detailed shape. One removed feature is still accepted in two old forms so existing config files do not break immediately.

The `[mcp_servers]` section is also described here. It allows arbitrary server names, but each server entry must match the raw server configuration shape used when reading the TOML file.

Finally, the file can turn the schema into stable, pretty JSON and write it to disk. It sorts JSON object keys first, so generated schema files do not change just because map ordering changed. That makes diffs and fixtures easier to review.

#### Function details

##### `features_schema`  (lines 18–76)

```
fn features_schema(schema_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds the schema for the `[features]` section of `config.toml`. It says exactly which feature names are allowed and what kind of value each one may have.

**Data flow**: It receives a schema generator, which is a helper that knows how to turn Rust types into JSON Schema pieces. It walks through the known feature list, skips the artifact feature, gives special configuration shapes to features that need more than a true-or-false value, and treats ordinary features as booleans. It also adds legacy feature keys as booleans, then closes the door on unknown keys by disallowing extra properties. The result is a JSON Schema object for the whole features map.

**Call relations**: This function is used when the wider `ConfigToml` schema needs to describe the features section. During that work it calls `removed_apps_mcp_path_override_schema` for one old feature whose accepted shape is unusual, and it consults the external legacy feature list so older config names are still recognized.

*Call graph*: calls 1 internal fn (removed_apps_mcp_path_override_schema); 6 external calls (new, default, default, Bool, Object, legacy_feature_keys).


##### `removed_apps_mcp_path_override_schema`  (lines 78–100)

```
fn removed_apps_mcp_path_override_schema(schema_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Describes the accepted shape for an old `apps_mcp_path_override` feature setting. It exists so older configuration files can still be understood even though this feature has been removed or changed.

**Data flow**: It receives the schema generator. It builds one allowed form as a simple boolean, and another allowed form as an object with only `enabled` and `path` fields. It then returns a schema that accepts either form. Unknown fields inside the object form are rejected.

**Call relations**: This is a helper for `features_schema`. When `features_schema` reaches the special removed feature, it hands off to this function so the unusual backward-compatible rule stays isolated instead of cluttering the main feature loop.

*Call graph*: called by 1 (features_schema); 6 external calls (new, default, default, Bool, Object, vec!).


##### `mcp_servers_schema`  (lines 103–116)

```
fn mcp_servers_schema(schema_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds the schema for the `[mcp_servers]` section of `config.toml`. It allows users to choose their own server names, while still requiring each server's settings to have the expected shape.

**Data flow**: It receives a schema generator. It creates a JSON object schema where each additional key is allowed, but each value must match `RawMcpServerConfig`, the raw form used when reading server settings from the config file. It returns that object schema.

**Call relations**: This function is used by schema generation for the overall config structure. It does not call other project helpers; it mainly asks the schema generator for the schema of `RawMcpServerConfig` and wraps that as the rule for every server entry.

*Call graph*: 3 external calls (new, default, Object).


##### `config_schema`  (lines 119–126)

```
fn config_schema() -> RootSchema
```

**Purpose**: Creates the full JSON Schema for the entire `config.toml` file. This is the central schema-building function for the config file as a whole.

**Data flow**: It starts from JSON Schema draft 7 settings, which means it uses a specific version of the JSON Schema standard. It changes one option so optional fields are not automatically described as allowing `null`, then asks the generator to build a root schema from the `ConfigToml` Rust type. The output is the complete schema tree.

**Call relations**: This function is called by `config_schema_json` when the schema needs to be turned into a JSON file. It relies on the schema support attached to `ConfigToml` and related custom schema functions such as the ones for features and MCP servers.

*Call graph*: called by 1 (config_schema_json); 1 external calls (draft07).


##### `canonicalize`  (lines 129–143)

```
fn canonicalize(value: &Value) -> Value
```

**Purpose**: Returns a copy of a JSON value with all object keys sorted. This makes generated JSON stable and easy to compare in version control.

**Data flow**: It receives any JSON value. If the value is an array, it canonicalizes each item. If it is an object, it sorts the keys alphabetically and canonicalizes each child value before inserting it into a new object. Simple values like strings, numbers, booleans, and null are copied as-is. The output is a new JSON value with the same meaning but predictable ordering.

**Call relations**: This function is called by `config_schema_json` after the Rust schema has been converted into generic JSON. It acts like tidying a filing cabinet alphabetically before printing the final document.

*Call graph*: called by 1 (config_schema_json); 4 external calls (with_capacity, Array, Object, clone).


##### `config_schema_json`  (lines 146–152)

```
fn config_schema_json() -> anyhow::Result<Vec<u8>>
```

**Purpose**: Produces the full config schema as nicely formatted JSON bytes. This is the form that can be written to a file or compared in a test fixture.

**Data flow**: It first calls `config_schema` to build the schema structure. It converts that structure into a general JSON value, passes it through `canonicalize` so object keys are sorted, then serializes it as pretty-printed JSON. If any conversion or serialization step fails, it returns an error; otherwise it returns the JSON bytes.

**Call relations**: This function sits between schema construction and disk output. `write_config_schema` calls it when it needs the final bytes to save, and it delegates the actual schema building to `config_schema` and ordering cleanup to `canonicalize`.

*Call graph*: calls 2 internal fn (canonicalize, config_schema); called by 1 (write_config_schema); 2 external calls (to_value, to_vec_pretty).


##### `write_config_schema`  (lines 155–159)

```
fn write_config_schema(out_path: &Path) -> anyhow::Result<()>
```

**Purpose**: Writes the generated config schema JSON to a chosen file path. This is the file-level output step for schema generation.

**Data flow**: It receives a path on disk. It calls `config_schema_json` to get the pretty, sorted JSON bytes, then writes those bytes to the requested path. If schema generation or file writing fails, it returns an error; otherwise it finishes successfully with no extra result.

**Call relations**: This function is called by `main`, so it is likely used by a command or build tool that refreshes the schema fixture. It hands off schema creation to `config_schema_json` and uses the standard file-writing operation to persist the result.

*Call graph*: calls 1 internal fn (config_schema_json); called by 1 (main); 1 external calls (write).


### `app-server-protocol/src/bin/export.rs`

`entrypoint` · `developer tooling / export command`

This file exists so the protocol used by the Codex app server can be shared outside the Rust codebase. In practice, that means generating TypeScript definitions for JavaScript or TypeScript clients, and JSON Schemas, which are machine-readable descriptions of what valid protocol messages look like. Without this tool, those files would have to be kept in sync by hand, which is error-prone and can easily lead to clients and the server disagreeing about message shapes.

The file defines the command-line arguments for the tool: where to write the generated files, whether to run Prettier to format the TypeScript output, and whether to include experimental API items. The main function reads those options from the command line, then asks the protocol library to generate the TypeScript files first and the JSON Schema files after that.

A useful way to think about it is as an export button for the protocol. The real knowledge of the protocol lives in the library; this file is the thin wrapper that turns that knowledge into a runnable command with user-friendly options.

#### Function details

##### `main`  (lines 23–34)

```
fn main() -> Result<()>
```

**Purpose**: Runs the export command. It reads the user’s command-line choices, then generates TypeScript bindings and JSON Schema files into the requested output directory.

**Data flow**: It starts with command-line arguments supplied by the user: an output folder, an optional Prettier executable path, and a flag for experimental API items. It turns those into generation options, passes them to the TypeScript generator, then passes the output folder and experimental flag to the JSON Schema generator. If everything succeeds it finishes normally; if a generator reports an error, that error is returned to the caller.

**Call relations**: This is the program’s starting point. It uses the command-line parser to build the argument values, uses the default generation settings as a base, then hands the actual file creation work to the protocol library through `generate_ts_with_options` and `generate_json_with_experimental`.

*Call graph*: calls 1 internal fn (default); 3 external calls (parse, generate_json_with_experimental, generate_ts_with_options).


### `app-server-protocol/src/bin/write_schema_fixtures.rs`

`entrypoint` · `developer tooling / schema fixture regeneration`

This is a developer tool, not part of the normal app-server runtime. Its job is to refresh vendored schema fixtures: saved copies of generated schema files that the project can keep under version control and use for tests, documentation, or compatibility checks. Without this tool, updating those fixtures would be more manual and easier to get wrong.

The program reads command-line options using Clap, a library that turns command-line flags into a Rust struct. The user can pass a schema root directory, a path to a Prettier executable, and a flag to include experimental API methods and fields. If no schema root is given, it uses the crate's own `schema` directory as the default.

After deciding these options, it hands the real work to `codex_app_server_protocol::write_schema_fixtures_with_options`. That library function is the worker that writes the fixture files. This binary is mainly the front desk: it collects the user's choices, fills in sensible defaults, calls the fixture writer, and adds a clear error message if regeneration fails.

#### Function details

##### `main`  (lines 22–42)

```
fn main() -> Result<()>
```

**Purpose**: This is the command-line entry point for regenerating schema fixtures. It reads the user's flags, chooses a default schema directory when needed, and asks the protocol library to write the updated fixture files.

**Data flow**: It starts with command-line arguments supplied by the user. Those become an `Args` value containing an optional schema folder, an optional Prettier path, and a true-or-false experimental API choice. If the schema folder is missing, it builds a default path from this crate's directory plus `schema`. It then passes the final folder, optional formatter path, and fixture options into the schema-writing library. The result is either success or an error with extra context explaining which schema directory failed.

**Call relations**: When the binary is run, `main` first calls `Args::parse` from Clap to turn raw command-line text into structured settings. Once it has those settings, it calls `write_schema_fixtures_with_options`, which performs the actual regeneration work. `main` does not generate files itself; it prepares the request and reports any failure in a useful way.

*Call graph*: 2 external calls (parse, write_schema_fixtures_with_options).


### `hooks/src/bin/write_hooks_schema_fixtures.rs`

`entrypoint` · `developer tooling / fixture generation`

This is a helper program, meant to be run from the command line, for producing or refreshing schema fixtures. A schema is a formal description of what a data shape should look like, and fixtures are saved example files used by tests or documentation to prove that shape stays stable.

The program does one simple job. First, it checks whether the user gave it a path as the first command-line argument. If so, that path is treated as the schema root folder. If not, it falls back to a built-in default: the `schema` directory inside this crate’s source tree. That default is found using `CARGO_MANIFEST_DIR`, which is a build-time value pointing at the package’s root directory.

After choosing the folder, the program hands the work to `codex_hooks::write_schema_fixtures`. This file does not know the details of how fixture files are created; it is the front door that chooses the destination and starts the real writer. Without this file, developers would need another way to run that fixture-generation step from the command line.

#### Function details

##### `main`  (lines 3–9)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: This is the command-line entry point. It chooses the schema directory to write into, then asks the hooks library to write the schema fixtures there.

**Data flow**: It reads the program’s command-line arguments. If the first argument exists, it turns that into a filesystem path; otherwise it builds a default path pointing to this crate’s `schema` directory. It then passes that path into `codex_hooks::write_schema_fixtures`, and returns success or an error depending on whether that writing step worked.

**Call relations**: When the tool is launched, `main` runs first. It uses the standard argument reader to find an optional destination path, then hands off to `write_schema_fixtures`, which performs the actual fixture-writing work.

*Call graph*: 2 external calls (write_schema_fixtures, args_os).


### `config/examples/generate-proto.rs`

`entrypoint` · `developer tooling / code generation`

This file is a tiny code-generation tool. Its job is to read a folder path from the command line, find the file named `codex.thread_config.v1.proto` inside that folder, and ask the Protocol Buffers build tool to generate Rust code from it. Protocol Buffers, often called “protobuf,” are a way to describe messages and services in a language-neutral format, like a shared contract that different programs can agree on.

Without this helper, a developer would have to remember the exact build settings needed to regenerate the Rust files by hand. This tool keeps that recipe in one place. It enables both client code and server code, meaning it generates Rust pieces for calling the service and for implementing the service. It writes the generated output back into the same directory that was passed in.

The program is intentionally strict: if no folder is provided, it prints a usage message and exits with an error. If code generation itself fails, the error is returned to the operating system. In everyday terms, this file is like a labeled machine in a workshop: give it the folder containing the blueprint, and it produces the Rust parts built from that blueprint.

#### Function details

##### `main`  (lines 3–19)

```
fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Runs the command-line tool. It checks that the user provided a protobuf directory, builds the path to the expected `.proto` file, and invokes the Rust protobuf generator with client and server generation turned on.

**Data flow**: It reads the first command-line argument after the program name. If that argument is missing, it prints `Usage: generate-proto <proto-dir>` and stops the process with an error code. If the argument is present, it treats it as a folder path, appends `codex.thread_config.v1.proto`, and passes both the file and folder to `tonic_prost_build`, which writes generated Rust files into that same folder. On success it returns `Ok(())`; on generation failure it returns the error.

**Call relations**: This is the whole entry point for the helper program. It relies on standard environment argument reading to learn what folder to use, standard error printing and process exit for bad usage, and `tonic_prost_build::configure` to do the actual protobuf-to-Rust generation.

*Call graph*: 5 external calls (from, eprintln!, args, exit, configure).


### Standalone utility binaries
This group covers small direct-invocation tools for patching, searching, bridging, debugging, and sample execution.

### `apply-patch/src/main.rs`

`entrypoint` · `startup`

This file is deliberately tiny because its job is only to be the executable doorway. When someone runs the apply-patch program, Rust starts here, in `main`. Instead of doing the patching work itself, this file calls into `codex_apply_patch::main`, where the actual behavior lives.

This split matters because it keeps the runnable program separate from the reusable logic. Think of this file like the front door of a workshop: it does not build anything itself, but it gets you into the place where the work happens. Without this file, there would be no binary entry point for the operating system to launch, even though the library code might still exist.

One small detail is the return type: `!`, called the “never” type in Rust. It means this function is not expected to return normally. The delegated library `main` likely exits the process itself or runs until termination. So this file starts the tool, passes control onward, and never expects to get control back.

#### Function details

##### `main`  (lines 1–3)

```
fn main() -> !
```

**Purpose**: This is the executable entry point for the apply-patch program. Its only job is to start the real application logic by calling `codex_apply_patch::main`.

**Data flow**: No command-line data is read directly in this file. Execution enters here when the program starts, then it is passed straight into the external library function; that function takes over and this wrapper does not produce its own result.

**Call relations**: The operating system launches this function first. It immediately calls the external `codex_apply_patch::main`, handing off all real work such as reading inputs, applying patches, reporting errors, and exiting.

*Call graph*: 1 external calls (main).


### `apply-patch/src/standalone_executable.rs`

`entrypoint` · `command execution`

This file turns the patch-applying library code into a small standalone program someone can run from a terminal. Its job is mostly practical: collect the patch text, check that the command was used correctly, prepare the few things the patch engine needs, and turn success or failure into a process exit code.

The program accepts the patch in one of two ways. A user can pass the whole patch as the single command-line argument, or pipe it in through standard input, like handing a note directly to a clerk versus dropping it in a mailbox. If the input is missing, not valid UTF-8 text, or there are extra arguments, it prints a clear error and exits with a usage or failure code.

After it has the patch text, it finds the current working directory, because patches are applied relative to where the command is run. It also creates a Tokio runtime, which is the small event loop needed to run asynchronous Rust code from this otherwise simple command-line program. Then it calls the shared `apply_patch` function, giving it the patch, current directory, output streams, local filesystem access, and no sandbox. On success it flushes standard output so messages appear in the right order, especially in shell pipelines.

#### Function details

##### `main`  (lines 4–7)

```
fn main() -> !
```

**Purpose**: This is the actual process entry point for the standalone `apply_patch` executable. It runs the program logic and then ends the operating-system process with the returned exit code.

**Data flow**: Nothing meaningful comes in directly except the process environment. It calls `run_main` to do all real work, receives a numeric exit code, and passes that code to the operating system by exiting the process.

**Call relations**: When the executable starts, `main` is called first. It immediately delegates to `run_main`, then hands the result to the standard process-exit function so shell scripts and users can tell whether the command succeeded.

*Call graph*: calls 1 internal fn (run_main); 1 external calls (exit).


##### `run_main`  (lines 11–83)

```
fn run_main() -> i32
```

**Purpose**: This function performs the command-line program's real work: it reads the patch text, validates how the command was used, prepares the runtime environment, and calls the patch engine. It returns an exit code instead of exiting directly, which keeps the main workflow easier to test and reason about.

**Data flow**: It reads command-line arguments first. If there is one patch argument, it converts it to UTF-8 text; if there is no argument, it reads all text from standard input. It rejects empty input, invalid text, or extra arguments with an error message. Once it has a patch, it reads the current directory, opens standard output and standard error, builds a Tokio runtime for asynchronous work, and runs the shared `apply_patch` operation against the local filesystem. It returns `0` when the patch succeeds, `1` for operational failures, and `2` for incorrect usage.

**Call relations**: `main` calls this function at process startup. Inside, `run_main` gathers input from the operating system, reports problems with `eprintln!`, asks for the current directory, creates the async runtime, and finally hands everything to the central `apply_patch` function that actually changes files.

*Call graph*: calls 1 internal fn (current_dir); called by 1 (main); 8 external calls (new, apply_patch, eprintln!, args_os, stderr, stdin, stdout, new_current_thread).


### `file-search/src/main.rs`

`entrypoint` · `startup and result reporting`

This file is the small front door to the file-search program. Its job is not to search files itself. Instead, it turns command-line text into structured settings, chooses an output style, and connects the search engine to the terminal.

The main idea is a separation between finding results and reporting results. The search logic lives in `codex_file_search::run_main`. This file provides `StdioReporter`, a reporter that knows how to write to standard output and standard error. Standard output is the normal stream a command prints results to; standard error is the separate stream usually used for warnings.

The reporter can print matches in three ways. If the user asked for JSON, each match is printed as a machine-readable JSON object. If the user asked to compute match indices and the output is a real terminal, it prints the file path with matching characters in bold. Otherwise it prints plain file paths, one per line. This matters because the same tool must work well both for humans in a terminal and for scripts that want clean data.

It also prints helpful warnings: one when too many matches were found and only some are shown, and another when the user did not provide a search pattern.

#### Function details

##### `main`  (lines 12–20)

```
async fn main() -> anyhow::Result<()>
```

**Purpose**: This starts the file-search command-line program. It reads the user's command-line options, prepares a terminal reporter, and then starts the main search workflow.

**Data flow**: The raw command-line arguments come in from the operating system. `Cli::parse` turns them into a structured `cli` value. `main` then builds a `StdioReporter`, using the user's JSON choice and checking whether standard output is an actual terminal before enabling bold highlighted indices. It passes both the settings and reporter into `run_main`, waits for it to finish, and returns success or any error that occurred.

**Call relations**: This function is the first project code that runs. After parsing options and checking standard output, it hands control to `run_main`, which performs the larger search flow and calls back into the reporter methods when there are matches or warnings to print.

*Call graph*: calls 1 internal fn (run_main); 2 external calls (parse, stdout).


##### `StdioReporter::report_match`  (lines 28–62)

```
fn report_match(&self, file_match: &FileMatch)
```

**Purpose**: This prints one search result in the format the user asked for. It is the bridge between an internal `FileMatch` value and what a person or script sees on the screen.

**Data flow**: A `FileMatch` comes in, containing at least a file path and sometimes character positions that matched the search. If JSON output is enabled, the whole match is converted to a JSON string and printed. If highlighted indices should be shown, it walks through the path character by character and prints matching positions in bold using terminal color-control text. Otherwise, it prints only the path as plain text.

**Call relations**: The main search workflow calls this through the `Reporter` interface whenever it has a match to show. This method does not decide what counts as a match; it only decides how that match appears to the outside world.

*Call graph*: 3 external calls (print!, println!, to_string).


##### `StdioReporter::warn_matches_truncated`  (lines 64–75)

```
fn warn_matches_truncated(&self, total_match_count: usize, shown_match_count: usize)
```

**Purpose**: This warns the user that the tool found more matches than it is showing. It helps prevent a misleading result list that looks complete but is actually capped by a limit.

**Data flow**: It receives the total number of matches and the number actually shown. If JSON output is enabled, it prints a small JSON object saying that matches were truncated. Otherwise, it writes a human-readable warning to standard error, including both counts and suggesting a more specific pattern or a higher limit.

**Call relations**: The search workflow calls this through the `Reporter` interface when it has to stop showing results because of a configured limit. This keeps warning output consistent with the selected output mode: script-friendly JSON for JSON mode, readable text for terminal use.

*Call graph*: 4 external calls (eprintln!, json!, println!, to_string).


##### `StdioReporter::warn_no_search_pattern`  (lines 77–82)

```
fn warn_no_search_pattern(&self, search_directory: &Path)
```

**Purpose**: This tells the user that they did not give a search pattern, so the tool is falling back to showing the contents of a directory. It makes an otherwise surprising behavior explicit.

**Data flow**: It receives the directory being searched or listed. It converts that path into readable text and writes a warning message to standard error, naming the directory whose contents will be shown.

**Call relations**: The main search workflow calls this through the `Reporter` interface when it detects that no search pattern was provided. The method does not choose the fallback behavior; it simply explains that behavior to the user before results are shown.

*Call graph*: 1 external calls (eprintln!).


### `file-search/src/cli.rs`

`config` · `startup / command-line parsing`

This file is the front desk for user input. It describes the shape of the command a person can type, such as whether they want JSON output, how many matches they want back, which directory to search, and what pattern to look for. The actual searching happens elsewhere; this file only defines how those choices are received and stored.

The main piece is the `Cli` struct. A struct is a named bundle of fields, like a form with labeled boxes. The `clap` library reads the user’s command-line text and fills in this form automatically. For example, `--json` becomes `json: true`, `--limit 20` becomes a non-zero result limit, and `-C some/path` becomes the directory to search.

A few choices here protect the rest of the program from bad input. `limit` and `threads` use `NonZero<usize>`, meaning they must be positive numbers, not zero. That matters because asking for zero results or zero worker threads would not make sense for the search engine. The comments also explain why the default worker thread count is only 2: walking a file tree is mostly limited by disk input/output, so many extra threads do not help much.

Without this file, the tool would have no clear contract with its users about which command-line options exist or how they are turned into usable settings.


### `file-search/src/lib.rs`

`domain_logic` · `request handling and interactive search sessions`

This file solves the problem of finding files quickly when the user only types part of a name. Think of it like a librarian who first scans the shelves, then keeps re-sorting the best books as you type more letters. The scanning side uses the `ignore` crate, which knows how to walk folders while respecting rules such as `.gitignore`. The matching side uses `nucleo`, a fuzzy matcher that scores paths even when the query is incomplete or not exact.

There are two main ways to use it. `run` is a simple one-shot search: give it a query and folders, and it waits until the search finishes. `create_session` is interactive: it starts background worker threads, lets callers update the query cheaply, and reports snapshots as results improve. One worker walks the disk and injects paths into the matcher. Another worker listens for query changes, matcher notifications, completion, or shutdown, then sends updated snapshots to a reporter.

The file also defines the data returned to callers, such as `FileMatch`, `MatchType`, search options, and snapshots. A cancellation flag can stop long searches. A session has its own shutdown flag, so dropping one session does not accidentally cancel other sessions that share the same external cancellation flag.

#### Function details

##### `FileMatch::full_path`  (lines 71–73)

```
fn full_path(&self) -> PathBuf
```

**Purpose**: Builds the absolute or full filesystem path for a match. Callers use this when they need to open or display the real path, not just the path relative to the search folder.

**Data flow**: It starts with a `FileMatch` that stores a root folder and a relative path. It joins those two pieces together. The result is a new path pointing to the actual file or directory on disk.

**Call relations**: This is a small convenience method on search results. It relies on the standard path join operation and is available whenever code receives a `FileMatch`.

*Call graph*: 1 external calls (join).


##### `file_name_from_path`  (lines 77–82)

```
fn file_name_from_path(path: &str) -> String
```

**Purpose**: Extracts the last name from a path string, such as turning `foo/bar.txt` into `bar.txt`. It falls back to the original text when there is no separate filename to extract.

**Data flow**: It receives a path as plain text. It interprets that text as a path, asks for the final component, converts it back to text if present, and otherwise returns the original input string.

**Call relations**: This helper is tested directly by the basename tests. It is a utility for display code that wants a friendly filename instead of a whole path.

*Call graph*: 1 external calls (new).


##### `FileSearchOptions::default`  (lines 116–126)

```
fn default() -> Self
```

**Purpose**: Provides safe, ordinary settings for file search. These defaults limit results, use two worker threads, do not compute highlight indices, and respect `.gitignore` rules.

**Data flow**: It takes no input. It creates non-zero numeric values for the result limit and thread count, uses an empty exclude list, and returns a complete `FileSearchOptions` value.

**Call relations**: Many session tests use this to avoid repeating standard settings. Production callers can also start from these defaults and override only what they care about.

*Call graph*: called by 6 (dropping_session_does_not_cancel_siblings_with_shared_cancel_flag, session_accepts_query_updates_after_walk_complete, session_emits_complete_when_query_changes_with_no_matches, session_emits_updates_when_query_changes, session_scanned_file_count_is_monotonic_across_queries, session_streams_updates_before_walk_complete); 2 external calls (new, new).


##### `FileSearchSession::update_query`  (lines 143–148)

```
fn update_query(&self, pattern_text: &str)
```

**Purpose**: Changes the search text for an existing live search session. This is meant to be cheap, so an interactive UI can call it on every keystroke without walking the disk again.

**Data flow**: It receives new query text. It wraps that text in a work signal and sends it to the matcher worker thread. It does not return search results directly; results come later through the session reporter.

**Call relations**: Clients call this after `create_session` returns a session. The matcher worker receives the query update and reparses the fuzzy pattern before producing a new snapshot.

*Call graph*: called by 1 (update_query); 1 external calls (QueryUpdated).


##### `FileSearchSession::drop`  (lines 152–155)

```
fn drop(&mut self)
```

**Purpose**: Shuts down the background work for a search session when the session object is dropped. This prevents worker threads from continuing to work after the caller is done.

**Data flow**: It takes the session being destroyed, sets that session's private shutdown flag, and sends a shutdown signal to the worker channel. It does not produce a value.

**Call relations**: Rust calls this automatically when a `FileSearchSession` goes out of scope. The matcher and walker workers check the shutdown flag or receive the shutdown signal and stop.


##### `create_session`  (lines 158–211)

```
fn create_session(
    search_directories: Vec<PathBuf>,
    options: FileSearchOptions,
    reporter: Arc<dyn SessionReporter>,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> anyhow::Result<FileSearc
```

**Purpose**: Starts an interactive file search session. It sets up shared state, the fuzzy matcher, the disk walker, and the channel that lets the workers talk to each other.

**Data flow**: It receives search folders, options, a reporter, and an optional cancellation flag. It validates that at least one folder exists, builds exclude rules, creates the matcher and communication channel, starts two background threads, and returns a `FileSearchSession`.

**Call relations**: The one-shot `run` function calls this internally, and tests call it to exercise live sessions. It starts `matcher_worker` for query and result updates, and `walker_worker` for finding paths on disk.

*Call graph*: calls 1 internal fn (build_override_matcher); called by 7 (run, dropping_session_does_not_cancel_siblings_with_shared_cancel_flag, session_accepts_query_updates_after_walk_complete, session_emits_complete_when_query_changes_with_no_matches, session_emits_updates_when_query_changes, session_scanned_file_count_is_monotonic_across_queries, session_streams_updates_before_walk_complete); 6 external calls (new, new, new, bail!, unbounded, spawn).


##### `run_main`  (lines 219–287)

```
async fn run_main(
    Cli {
        pattern,
        limit,
        cwd,
        compute_indices,
        json: _,
        exclude,
        threads,
    }: Cli,
    reporter: T,
) -> anyhow::Result<(
```

**Purpose**: Connects command-line input to the search library. It decides where to search, what to do when no pattern is provided, and how to print or warn about results through a reporter.

**Data flow**: It receives parsed CLI settings and a reporter. It chooses the current directory if no directory was given, lists the directory when no search pattern was given, otherwise calls `run`, reports each match, and warns if more matches existed than were shown.

**Call relations**: The program's `main` function calls this. It hands real searching to `run` and hands user-facing messages to the `Reporter` implementation.

*Call graph*: calls 1 internal fn (run); called by 1 (main); 7 external calls (report_match, warn_matches_truncated, warn_no_search_pattern, new, current_dir, inherit, vec!).


##### `run`  (lines 291–307)

```
fn run(
    pattern_text: &str,
    roots: Vec<PathBuf>,
    options: FileSearchOptions,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> anyhow::Result<FileSearchResults>
```

**Purpose**: Performs a complete search and waits for it to finish. This is the simple API for callers that do not need streaming updates.

**Data flow**: It receives a query, roots, options, and an optional cancellation flag. It creates a hidden reporter, starts a session, sends the query, waits until the reporter says the search is complete, and returns the final matches and total count.

**Call relations**: `run_main` uses this for command-line searches, and several tests use it for direct library checks. Internally it relies on `create_session` and `RunReporter::wait_for_complete`.

*Call graph*: calls 1 internal fn (create_session); called by 5 (run_main, git_repo_still_respects_local_gitignore_when_enabled, parent_gitignore_outside_repo_does_not_hide_repo_files, run_returns_directory_matches_for_query, run_returns_matches_for_query); 2 external calls (new, default).


##### `sort_matches`  (lines 311–316)

```
fn sort_matches(matches: &mut [(u32, String)])
```

**Purpose**: Sorts test match data so better scores come first, with alphabetical path order used to break ties. It exists only for tests.

**Data flow**: It receives a mutable list of score-and-path pairs. It sorts that list in place using the shared comparator. It returns nothing because the input list is changed directly.

**Call relations**: The tie-breaker test calls this to confirm the intended ordering. It delegates the actual comparison rule to `cmp_by_score_desc_then_path_asc`.

*Call graph*: called by 1 (tie_breakers_sort_by_path_when_scores_equal).


##### `cmp_by_score_desc_then_path_asc`  (lines 320–333)

```
fn cmp_by_score_desc_then_path_asc(
    score_of: FScore,
    path_of: FPath,
) -> impl FnMut(&T, &T) -> std::cmp::Ordering
```

**Purpose**: Creates a reusable sorting rule for search results. Higher scores are treated as better, and equal scores are ordered by path text so results are stable and predictable.

**Data flow**: It receives two accessor functions: one that extracts a score and one that extracts a path. It returns a comparison function that sorting code can use on any item type with those two pieces of information.

**Call relations**: The test-only `sort_matches` helper uses this comparator. Other code can also use it when it needs the same result ordering without duplicating the rule.


##### `create_pattern`  (lines 336–343)

```
fn create_pattern(pattern: &str) -> Pattern
```

**Purpose**: Builds a fuzzy matching pattern for tests. It uses case-insensitive matching and smart text normalization so tests match the same style used by the search logic.

**Data flow**: It receives pattern text. It constructs and returns a `nucleo` pattern configured for fuzzy matching, meaning letters can match even when they are not typed as a full exact filename.

**Call relations**: The non-match scoring test calls this before asking `nucleo` for a score. It is compiled only during tests.

*Call graph*: called by 1 (verify_score_is_none_for_non_match); 1 external calls (new).


##### `build_override_matcher`  (lines 364–378)

```
fn build_override_matcher(
    search_directory: &Path,
    exclude: &[String],
) -> anyhow::Result<Option<ignore::overrides::Override>>
```

**Purpose**: Turns caller-provided exclude patterns into rules for the directory walker. These rules tell the walker which paths should be skipped.

**Data flow**: It receives the base search directory and a list of exclude strings. If the list is empty it returns no matcher; otherwise it prefixes each rule in the form expected by the `ignore` crate, builds the matcher, and returns it.

**Call relations**: `create_session` calls this before starting the walker. The resulting matcher is passed into `walker_worker`, where it affects which files are discovered.

*Call graph*: called by 1 (create_session); 2 external calls (new, format!).


##### `get_file_path`  (lines 380–397)

```
fn get_file_path(path: &'a Path, search_directories: &[PathBuf]) -> Option<(usize, &'a str)>
```

**Purpose**: Finds the best search root for a full path and returns the path relative to that root. This matters when there are multiple roots or nested roots.

**Data flow**: It receives a filesystem path and the list of search directories. It checks which roots contain the path, chooses the deepest matching root, converts the remaining relative path to text, and returns the root index plus that relative text.

**Call relations**: Both `walker_worker` and `matcher_worker` use this. The walker uses it before feeding relative paths into the matcher; the matcher uses it later to rebuild `FileMatch` values.

*Call graph*: 2 external calls (strip_prefix, iter).


##### `walker_worker`  (lines 411–481)

```
fn walker_worker(
    inner: Arc<SessionInner>,
    override_matcher: Option<ignore::overrides::Override>,
    injector: Injector<Arc<str>>,
)
```

**Purpose**: Scans the search directories and feeds every discovered path into the fuzzy matcher. It is the part that reads the filesystem.

**Data flow**: It receives shared session state, optional exclude rules, and a `nucleo` injector. It builds a parallel directory walker, applies ignore and exclude settings, visits files and directories, converts paths to matcher input, and sends a walk-complete signal when done.

**Call relations**: `create_session` starts this in a background thread. It supplies paths to `nucleo`, while `matcher_worker` listens for matcher notifications and turns the growing index into result snapshots.

*Call graph*: 1 external calls (new).


##### `matcher_worker`  (lines 483–604)

```
fn matcher_worker(
    inner: Arc<SessionInner>,
    work_rx: Receiver<WorkSignal>,
    mut nucleo: Nucleo<Arc<str>>,
) -> anyhow::Result<()>
```

**Purpose**: Runs the live fuzzy matching loop. It reacts to query changes, new indexed paths, cancellation, completion, and shutdown, then reports updated search snapshots.

**Data flow**: It receives shared session state, a channel of work signals, and the `nucleo` matcher. It updates the matcher pattern when the query changes, ticks the matcher when work is ready, collects the top results, optionally computes highlight indices, and sends snapshots to the reporter.

**Call relations**: `create_session` starts this in a background thread. It receives signals from `FileSearchSession::update_query`, from `walker_worker`, and from `nucleo` notifications, then calls the reporter's update and complete methods.

*Call graph*: 3 external calls (new, never, select!).


##### `RunReporter::on_update`  (lines 613–617)

```
fn on_update(&self, snapshot: &FileSearchSnapshot)
```

**Purpose**: Stores the newest search snapshot for the one-shot `run` API. It lets `run` remember the latest results while the background session is still working.

**Data flow**: It receives a snapshot from the matcher worker. It locks the stored snapshot, replaces it with a clone of the new one, and returns nothing.

**Call relations**: `matcher_worker` calls this through the `SessionReporter` trait. Later, `RunReporter::wait_for_complete` reads the stored snapshot and gives it back to `run`.

*Call graph*: 1 external calls (clone).


##### `RunReporter::on_complete`  (lines 619–625)

```
fn on_complete(&self)
```

**Purpose**: Wakes anyone waiting for a one-shot search to finish. It marks the run as complete and notifies the condition variable, which is a waiting-room signal for another thread.

**Data flow**: It receives no extra data. It locks the completion flag, changes it to true, and wakes all waiters. It does not return a value.

**Call relations**: `matcher_worker` calls this when the session becomes idle, finishes walking, is cancelled, or exits. `RunReporter::wait_for_complete` is the waiting side that reacts to this notification.


##### `RunReporter::wait_for_complete`  (lines 629–641)

```
fn wait_for_complete(&self) -> FileSearchSnapshot
```

**Purpose**: Blocks until the one-shot search has completed, then returns the latest snapshot. This is what makes `run` feel synchronous to its caller.

**Data flow**: It starts by checking a shared completion flag. If the flag is false, it waits on a condition variable until another thread marks completion. Then it reads and clones the stored snapshot and returns it.

**Call relations**: `run` calls this after sending the query to the session. It pairs with `RunReporter::on_complete`, which is called by the matcher worker.


##### `tests::verify_score_is_none_for_non_match`  (lines 661–669)

```
fn verify_score_is_none_for_non_match()
```

**Purpose**: Checks that the fuzzy matcher reports no score when a query clearly does not match the text. This protects the basic assumption that non-matches are filtered out.

**Data flow**: It creates matcher input from `hello`, builds a pattern for `zzz`, asks for a score, and asserts that the score is absent.

**Call relations**: This test uses `create_pattern` to build the test pattern. It verifies behavior from the external `nucleo` matcher that the search code depends on.

*Call graph*: calls 1 internal fn (create_pattern); 4 external calls (new, new, new, assert_eq!).


##### `tests::tie_breakers_sort_by_path_when_scores_equal`  (lines 672–689)

```
fn tie_breakers_sort_by_path_when_scores_equal()
```

**Purpose**: Confirms that equal-scoring matches are ordered alphabetically by path. This keeps result ordering predictable for users.

**Data flow**: It starts with three fake matches, two with the same score. It sorts them with `sort_matches` and compares the final order to the expected list.

**Call relations**: This test exercises `sort_matches`, which in turn uses the shared comparator rule from `cmp_by_score_desc_then_path_asc`.

*Call graph*: calls 1 internal fn (sort_matches); 2 external calls (assert_eq!, vec!).


##### `tests::file_name_from_path_uses_basename`  (lines 692–694)

```
fn file_name_from_path_uses_basename()
```

**Purpose**: Checks that `file_name_from_path` returns only the final filename from a normal path.

**Data flow**: It passes `foo/bar.txt` into the helper and expects `bar.txt` to come out.

**Call relations**: This test directly protects the display helper `file_name_from_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::file_name_from_path_falls_back_to_full_path`  (lines 697–699)

```
fn file_name_from_path_falls_back_to_full_path()
```

**Purpose**: Checks the helper's fallback behavior for a path with no extractable filename.

**Data flow**: It passes an empty string into `file_name_from_path` and expects the same empty string back.

**Call relations**: This complements the basename test by covering the fallback branch of `file_name_from_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::RecordingReporter::wait_until`  (lines 710–736)

```
fn wait_until(
            &self,
            mutex: &Mutex<T>,
            cv: &Condvar,
            timeout: Duration,
            mut predicate: F,
        ) -> bool
```

**Purpose**: Waits during tests until some shared reporter state satisfies a condition or a timeout expires. It avoids brittle tests that sleep for a fixed amount of time and hope work is done.

**Data flow**: It receives a mutex-protected value, a condition variable, a timeout, and a predicate function. It repeatedly checks the predicate, waits for notifications with the remaining time, and returns true if the condition became true before the deadline.

**Call relations**: The test reporter's `wait_for_complete` and `wait_for_updates_at_least` helpers both use this. It is the common waiting mechanism for session tests.

*Call graph*: called by 2 (wait_for_complete, wait_for_updates_at_least); 2 external calls (wait_timeout, now).


##### `tests::RecordingReporter::wait_for_complete`  (lines 738–745)

```
fn wait_for_complete(&self, timeout: Duration) -> bool
```

**Purpose**: Waits for a test session to report at least one completion event.

**Data flow**: It receives a timeout. It calls `wait_until` on the stored completion times and returns whether any completion was recorded before time ran out.

**Call relations**: Many session tests call this after updating a query. It depends on `RecordingReporter::on_complete` to record and notify completion.

*Call graph*: calls 1 internal fn (wait_until).


##### `tests::RecordingReporter::clear`  (lines 746–749)

```
fn clear(&self)
```

**Purpose**: Resets the test reporter so a test can observe the next phase separately. This is useful when a session receives more than one query.

**Data flow**: It locks the stored updates and completion times, empties both lists, and returns nothing.

**Call relations**: Tests call this between query updates. Later reporter callbacks repopulate the cleared lists.


##### `tests::RecordingReporter::updates`  (lines 751–753)

```
fn updates(&self) -> Vec<FileSearchSnapshot>
```

**Purpose**: Returns a copy of all snapshots recorded by the test reporter.

**Data flow**: It locks the updates list, clones it, and returns the clone so the caller can inspect it without holding the lock.

**Call relations**: Session tests use this to check whether updates arrived and what they contained. The list is filled by `RecordingReporter::on_update`.


##### `tests::RecordingReporter::wait_for_updates_at_least`  (lines 755–759)

```
fn wait_for_updates_at_least(&self, min_len: usize, timeout: Duration) -> bool
```

**Purpose**: Waits until the test reporter has received a minimum number of update snapshots.

**Data flow**: It receives a target count and timeout. It calls `wait_until` on the updates list and returns true once the list is long enough, or false if time expires.

**Call relations**: The test for query updates after walk completion uses this to wait for a later query result. It depends on `RecordingReporter::on_update` to notify waiting tests.

*Call graph*: calls 1 internal fn (wait_until).


##### `tests::RecordingReporter::snapshot`  (lines 761–768)

```
fn snapshot(&self) -> FileSearchSnapshot
```

**Purpose**: Fetches the latest recorded search snapshot for assertions in tests. If no update has arrived, it returns an empty default snapshot.

**Data flow**: It locks the updates list, takes the last snapshot if one exists, clones it, and returns it. If the list is empty, it returns a default snapshot.

**Call relations**: Session tests call this after waiting or briefly sleeping to inspect current state. The snapshots come from `RecordingReporter::on_update`.


##### `tests::RecordingReporter::on_update`  (lines 772–776)

```
fn on_update(&self, snapshot: &FileSearchSnapshot)
```

**Purpose**: Records each session update during tests and wakes any test waiting for updates.

**Data flow**: It receives a snapshot, clones it into the updates list, and notifies the update condition variable.

**Call relations**: `matcher_worker` calls this through the `SessionReporter` trait during test sessions. Waiting helpers such as `wait_for_updates_at_least` react to its notification.

*Call graph*: 2 external calls (notify_all, clone).


##### `tests::RecordingReporter::on_complete`  (lines 778–784)

```
fn on_complete(&self)
```

**Purpose**: Records that a test session reported completion and wakes any test waiting for completion.

**Data flow**: It records the current time in the completion list and notifies the completion condition variable.

**Call relations**: `matcher_worker` calls this through the `SessionReporter` trait. `wait_for_complete` watches the recorded completion list.

*Call graph*: 2 external calls (notify_all, now).


##### `tests::create_temp_tree`  (lines 787–794)

```
fn create_temp_tree(file_count: usize) -> TempDir
```

**Purpose**: Creates a temporary directory filled with a chosen number of test files. This gives search tests realistic filesystem data without touching the user's files.

**Data flow**: It receives a file count. It creates a temporary directory, writes files named like `file-0000.txt`, and returns the temporary directory object so it stays alive during the test.

**Call relations**: Many tests use this helper before calling `create_session` or `run`. It supplies predictable filenames for fuzzy search assertions.

*Call graph*: 3 external calls (format!, write, tempdir).


##### `tests::session_scanned_file_count_is_monotonic_across_queries`  (lines 797–819)

```
fn session_scanned_file_count_is_monotonic_across_queries()
```

**Purpose**: Checks that the reported scanned-file count never goes backward when the query changes. Users should see progress that only increases during one session.

**Data flow**: It creates a temporary tree, starts a session, sends one query, records a snapshot, sends another query, records another snapshot, waits for completion, and asserts the scanned counts are non-decreasing.

**Call relations**: This test uses `create_temp_tree`, `create_session`, default options, and session query updates. It verifies the snapshots produced by `matcher_worker`.

*Call graph*: calls 2 internal fn (default, create_session); 8 external calls (new, from_millis, from_secs, assert!, default, create_temp_tree, sleep, vec!).


##### `tests::session_streams_updates_before_walk_complete`  (lines 822–839)

```
fn session_streams_updates_before_walk_complete()
```

**Purpose**: Checks that a live session can report partial results before the directory walk has fully finished. This is important for responsive user interfaces.

**Data flow**: It creates many files, starts a session, sends a query, waits for completion, then inspects all updates and expects at least one snapshot whose walk was not complete yet.

**Call relations**: This test exercises the cooperation between `walker_worker`, `matcher_worker`, and the reporter. It proves updates are streamed instead of saved until the end.

*Call graph*: calls 2 internal fn (default, create_session); 6 external calls (new, from_secs, assert!, default, create_temp_tree, vec!).


##### `tests::session_accepts_query_updates_after_walk_complete`  (lines 842–870)

```
fn session_accepts_query_updates_after_walk_complete()
```

**Purpose**: Checks that a session remains useful after the initial folder scan is done. A user can keep typing new searches without restarting the session.

**Data flow**: It creates two files, starts a session, searches for `alpha`, waits for completion, then searches for `beta` and waits for another update containing the beta file.

**Call relations**: This test uses `create_session` and `FileSearchSession::update_query`. It confirms `matcher_worker` keeps accepting query updates after `walker_worker` has sent walk completion.

*Call graph*: calls 2 internal fn (default, create_session); 6 external calls (new, assert!, default, write, tempdir, vec!).


##### `tests::session_emits_complete_when_query_changes_with_no_matches`  (lines 873–898)

```
fn session_emits_complete_when_query_changes_with_no_matches()
```

**Purpose**: Checks that a query with no matches still produces an update and a completion event. Without this, callers could wait forever when the answer is empty.

**Data flow**: It creates two files, searches for text that matches nothing, waits for completion, checks that the result is empty, clears the reporter, then sends a slightly different no-match query and expects completion again.

**Call relations**: This test relies on `create_session`, the recording reporter, and query updates. It protects the `matcher_worker` completion behavior for empty result sets.

*Call graph*: calls 2 internal fn (default, create_session); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `tests::dropping_session_does_not_cancel_siblings_with_shared_cancel_flag`  (lines 901–932)

```
fn dropping_session_does_not_cancel_siblings_with_shared_cancel_flag()
```

**Purpose**: Checks that dropping one session does not cancel another session that shares the same external cancellation flag. Each session should clean up only itself.

**Data flow**: It creates two roots and one shared cancellation flag, starts two sessions, sends queries to both, drops the first session, and verifies the second session still completes.

**Call relations**: This test exercises `FileSearchSession::drop` together with `create_session`. It protects the design where session shutdown is separate from the caller-provided cancellation flag.

*Call graph*: calls 2 internal fn (default, create_session); 9 external calls (new, new, from_millis, from_secs, assert_eq!, default, create_temp_tree, sleep, vec!).


##### `tests::session_emits_updates_when_query_changes`  (lines 935–958)

```
fn session_emits_updates_when_query_changes()
```

**Purpose**: Checks that changing the query causes a fresh update even when there are no matches. This keeps user interfaces informed that the new query has been processed.

**Data flow**: It creates files, starts a session, sends a no-match query and waits for completion, clears recorded events, sends another no-match query, and expects exactly one new update.

**Call relations**: This test uses default options, `create_session`, and the recording reporter. It focuses on the matcher worker's response to `QueryUpdated` signals.

*Call graph*: calls 2 internal fn (default, create_session); 7 external calls (new, from_secs, assert!, assert_eq!, default, create_temp_tree, vec!).


##### `tests::run_returns_matches_for_query`  (lines 961–986)

```
fn run_returns_matches_for_query()
```

**Purpose**: Checks the simple `run` API returns real file matches for a query. This verifies the one-shot path through the library.

**Data flow**: It creates a temporary tree, builds explicit options, calls `run` with a query, then asserts that results are non-empty, the total count is sensible, and a known filename appears.

**Call relations**: This test goes through `run`, which internally uses `create_session`, `RunReporter`, the walker, and the matcher.

*Call graph*: calls 1 internal fn (run); 5 external calls (new, new, assert!, create_temp_tree, vec!).


##### `tests::run_returns_directory_matches_for_query`  (lines 989–1013)

```
fn run_returns_directory_matches_for_query()
```

**Purpose**: Checks that directories, not just files, can appear as search matches. This matters for file pickers that let users navigate to folders.

**Data flow**: It creates a small folder tree and files, calls `run` with a directory name, and asserts that the matching directory is returned with the directory match type.

**Call relations**: This test exercises `run` and the match-type detection inside `matcher_worker`.

*Call graph*: calls 1 internal fn (run); 7 external calls (new, new, assert!, create_dir_all, write, tempdir, vec!).


##### `tests::cancel_exits_run`  (lines 1016–1039)

```
fn cancel_exits_run()
```

**Purpose**: Checks that a one-shot search exits promptly when the cancellation flag is already set. This prevents long searches from hanging after a caller has cancelled them.

**Data flow**: It creates files, sets a cancellation flag to true, runs `run` on another thread, waits for the result with a timeout, and asserts the returned result is empty.

**Call relations**: This test verifies cancellation checks in the worker flow used by `run`, especially the walker and matcher shutdown path.

*Call graph*: 8 external calls (new, new, default, from_secs, assert_eq!, create_temp_tree, channel, spawn).


##### `tests::parent_gitignore_outside_repo_does_not_hide_repo_files`  (lines 1048–1102)

```
fn parent_gitignore_outside_repo_does_not_hide_repo_files()
```

**Purpose**: Protects against a bug where a broad parent `.gitignore` outside a repository could hide every file in the searched folder. The intended behavior is to avoid applying such parent rules when there is no git repository context.

**Data flow**: It creates a fake home folder with a parent `.gitignore`, a child folder with its own `.gitignore`, and some files. It runs searches and asserts expected files are still found.

**Call relations**: This test calls `run` and checks the ignore behavior configured in `walker_worker`, especially the `require_git(true)` setting.

*Call graph*: calls 1 internal fn (run); 7 external calls (new, new, assert!, create_dir_all, write, tempdir, vec!).


##### `tests::git_repo_still_respects_local_gitignore_when_enabled`  (lines 1105–1186)

```
fn git_repo_still_respects_local_gitignore_when_enabled()
```

**Purpose**: Checks that real git repositories still honor their local `.gitignore` rules. The code should avoid harmful parent ignores outside repos without ignoring valid repo-local rules.

**Data flow**: It creates a fake repository with a `.git` directory, local ignore rules, allowed files, and ignored files. It runs several searches and asserts allowed files are found while the ignored file is not.

**Call relations**: This test exercises `run` and the walker configuration in `walker_worker`. It complements the parent-ignore regression test by covering the true git-repository case.

*Call graph*: calls 1 internal fn (run); 7 external calls (new, new, assert!, create_dir_all, write, tempdir, vec!).


### `stdio-to-uds/src/main.rs`

`entrypoint` · `startup and process lifetime`

This file is the front door of a small command-line program. Its job is not to do the data forwarding itself, but to make sure the program is started correctly and then hand control to the library code that does the work. The tool expects exactly one piece of information from the user: the path to a Unix domain socket, which is a local machine communication endpoint similar to a private pipe between programs. If the user forgets the path, or provides extra arguments, the program prints a clear error message and exits with a failure code instead of guessing what to do. Once the argument is accepted, it is turned into a path object and passed to `codex_stdio_to_uds::run`. That external `run` function is where the actual bridge behavior happens: connecting standard input/output to the Unix socket. The `#[tokio::main]` line means the program runs inside Tokio, an asynchronous runtime that lets it wait on input and output without blocking the whole process unnecessarily.

#### Function details

##### `main`  (lines 6–20)

```
async fn main() -> anyhow::Result<()>
```

**Purpose**: Starts the command-line tool. It validates that the user gave exactly one socket path, then launches the asynchronous bridge logic using that path.

**Data flow**: It reads the process command-line arguments, ignoring the program name. If there is no socket path, it prints usage text and exits. If there is more than one argument, it prints an error and exits. If there is exactly one argument, it converts that value into a filesystem path and passes it to `codex_stdio_to_uds::run`, returning whatever success or error result that function produces.

**Call relations**: This is called by the operating system when the program starts. It uses standard library argument reading and error printing for startup checks, calls `process::exit` when the command line is invalid, and hands the valid socket path to the external `run` function, which carries out the program's real work.

*Call graph*: 5 external calls (from, run, args_os, eprintln!, exit).


### `tui/src/bin/md-events.rs`

`entrypoint` · `command-line execution`

This file defines a tiny helper program for inspecting Markdown. Instead of rendering Markdown as formatted text, it shows the stream of parser events that come out of `pulldown_cmark`, the Markdown parsing library used here. A parser event is a step like “start a heading,” “read this text,” or “end a list.” This is like watching a recipe being broken into individual cooking instructions instead of only seeing the finished meal.

When the program runs, it reads all text sent to it through standard input, which is the usual pipe or terminal input for command-line programs. If reading fails, it prints a clear error message and exits with a failure code. If reading succeeds, it gives the whole input string to the Markdown parser. Then it walks through every event the parser produces and prints each one in a debug-friendly form.

This matters because Markdown behavior can be subtle. A developer can pipe a sample Markdown file into this tool and immediately see what the parser thinks the structure is. Without a tool like this, debugging Markdown parsing or rendering problems would require guessing or adding temporary logging elsewhere.

#### Function details

##### `main`  (lines 4–15)

```
fn main()
```

**Purpose**: This is the whole command-line program. It reads Markdown from standard input, asks the Markdown parser to break it into events, and prints those events so a person can inspect them.

**Data flow**: Input text comes in from standard input and is collected into one string. If that read fails, the function prints an error and stops the process with a non-zero exit code. If it succeeds, the string is passed into `pulldown_cmark::Parser`, and each parser event that comes out is printed to standard output.

**Call relations**: Because this is `main`, the operating system calls it when the tool starts. It relies on standard input for the Markdown source, hands the text to the external Markdown parser, and sends the resulting event descriptions to standard output. If the first read step fails, it hands control to the process exit call instead of continuing.

*Call graph*: 6 external calls (new, eprintln!, stdin, println!, new, exit).


### `thread-manager-sample/src/main.rs`

`entrypoint` · `startup through one prompt turn, then teardown`

This file is like a minimal “test drive” for Codex’s thread system. A user runs the binary with a prompt, or pipes a prompt into standard input. The program builds a temporary Codex configuration, starts the services needed for one conversation thread, sends the prompt, then watches the thread’s event stream until the turn finishes.

The important job here is translating Codex’s internal activity into simple JSON notifications. As Codex works, it may emit events such as “tool call started,” “command output arrived,” or “agent message changed.” This sample filters for the event types that can be mapped into server-style notifications, converts them, and writes one JSON object per line to standard output. That format is easy for other tools to read because each line is one complete message.

The file also deliberately keeps the run safe and simple. It creates read-only permissions and sets approval to “never,” meaning the sample should not pause to ask the user for permission. If Codex tries to do something that would require approval, extra input, or a dynamic tool call, the program stops with an error instead of entering an interactive flow. After the turn ends, it shuts down the thread and removes it from the manager so background work is cleaned up.

#### Function details

##### `main`  (lines 81–83)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: This is the program’s starting point. It hands control to Codex’s argument-zero dispatcher, which can adjust how the executable is run depending on the path or wrapper used to start it.

**Data flow**: The operating system starts the program → this function calls the dispatcher with the real async runner → the dispatcher either performs its special startup behavior or calls into the main sample flow. The result is returned as the program’s success or failure.

**Call relations**: This is the outer doorway into the sample. It does not do the Codex work itself; it passes that job to run_main through arg0_dispatch_or_else so the rest of the file can assume the needed executable paths have already been resolved.

*Call graph*: 1 external calls (arg0_dispatch_or_else).


##### `run_main`  (lines 85–157)

```
async fn run_main(arg0_paths: Arg0DispatchPaths) -> anyhow::Result<()>
```

**Purpose**: This is the main coordinator for the sample run. It reads the prompt, creates the Codex configuration and supporting services, starts one thread, runs one turn, and then cleans everything up.

**Data flow**: It receives resolved executable paths from startup → reads command-line options and either joins the prompt arguments or reads piped standard input → builds a Config with new_config → opens state storage, authentication, runtime paths, environment support, user instructions, and the thread store → creates a ThreadManager and starts a new thread → sends the prompt to run_turn → shuts the thread down and removes it from the manager. It returns success only if the turn and shutdown both succeed.

**Call relations**: main reaches this function through the dispatcher. run_main is the conductor: it calls new_config before any Codex services are created, calls run_turn once the thread is ready, and then performs teardown after run_turn finishes or reports an error.

*Call graph*: calls 7 internal fn (new, new, from_codex_home, from_optional_paths, shared_from_config, new_config, run_turn); 12 external calls (clone, new, new, parse, bail!, empty_extension_registry, init_state_db, resolve_installation_id, set_default_originator, thread_store_from_config (+2 more)).


##### `new_config`  (lines 159–295)

```
fn new_config(model: Option<String>, arg0_paths: Arg0DispatchPaths) -> anyhow::Result<Config>
```

**Purpose**: This builds the configuration object used for the sample Codex run. It chooses defaults that make the sample temporary, non-interactive, and read-only unless a model override was supplied.

**Data flow**: It receives an optional model name and the executable paths discovered at startup → finds the Codex home folder and current working directory → selects the built-in OpenAI provider → fills a large Config structure with defaults, paths, permissions, feature flags, and disabled optional services → enables default feature settings → returns the finished Config or an error if required setup could not be resolved.

**Call relations**: run_main calls this before constructing the state database, authentication manager, environment manager, and thread manager. The returned Config becomes the shared instruction sheet for the rest of the run, telling every later component where files live, what model/provider to use, and what actions are allowed.

*Call graph*: calls 9 internal fn (allow_any, default, default, default, default, from_approval_and_profile, with_defaults, read_only, current_dir); called by 1 (run_main); 17 external calls (new, default, new, new, built_in_model_providers, find_codex_home, default, default, default, default (+7 more)).


##### `run_turn`  (lines 297–393)

```
async fn run_turn(thread: &CodexThread, thread_id: &str, prompt: String) -> anyhow::Result<()>
```

**Purpose**: This sends the user’s prompt into an existing Codex thread and watches the thread until the answer is complete. While it waits, it converts selected internal Codex events into JSON notifications and prints them one per line.

**Data flow**: It receives a running CodexThread, that thread’s ID as text, and the prompt → wraps the prompt as user input and submits it → repeatedly reads the next event from the thread → remembers the current turn ID when the turn starts → converts supported progress events into server notifications using the thread ID and turn ID → writes each converted notification to standard output as JSON followed by a newline. It returns success when the turn completes, or returns an error if Codex reports failure, aborts, asks for approval, asks for more user input, or requests an unsupported tool flow.

**Call relations**: run_main calls this after ThreadManager has started a thread. run_turn depends on the thread’s event stream to know what is happening, hands mappable events to item_event_to_server_notification, and hands the resulting objects to JSON serialization. When it finishes, control returns to run_main so the thread can be shut down and removed.

*Call graph*: calls 2 internal fn (next_event, submit); called by 1 (run_main); 6 external calls (default, bail!, item_event_to_server_notification, to_writer, stdout, vec!).


### `code-mode-host/src/main.rs`

`entrypoint` · `startup`

In a Rust program, `main` is the front door: it is the first function the operating system enters when the program starts. This file provides that required front door for the `code-mode-host` executable, but the room behind it is currently empty. There is no setup, no command-line parsing, no server loop, no file reading, and no cleanup. If this file were missing, the project could not build as a normal runnable program because Rust would not know where execution should begin. As it stands, running this binary is like opening a shop, turning the lights on for a moment, and then immediately closing again. This can be useful as a placeholder while the rest of the project is being built, or as a minimal shell that proves the binary target exists.

#### Function details

##### `main`  (lines 1–1)

```
fn main()
```

**Purpose**: `main` is the required starting function for this executable. At the moment, it intentionally does nothing, so running the program simply starts and exits successfully.

**Data flow**: Nothing goes in: it reads no arguments, files, settings, or external input. It performs no actions and produces no output. After it is entered, it immediately finishes, returning control to the operating system.

**Call relations**: The operating system and Rust runtime call `main` when the `code-mode-host` program is launched. Since it calls no other functions, the larger program flow stops here for now.


### `ext/extension-api/examples/enabled_extensions.rs`

`entrypoint` · `example run`

This file is a small runnable example for the extension API. It answers a practical question: if extensions can remember things, who decides what memory they share? Here, the host program does. First it builds an extension registry, which is like a sign-up sheet of enabled extension features. It installs one sample extension into that registry. Then it creates three data stores: one for the whole session, one for a first thread, and one for a second thread. A data store is a place where an extension can keep small pieces of state between calls.

The example then asks the enabled prompt contributors to contribute prompt fragments several times. It deliberately reuses the same session store each time, so session-level counts accumulate across both threads. It reuses the first thread store twice, so that thread also keeps its own history. The second thread gets a separate store, so its thread-level history starts fresh.

At the end, it prints how many prompt fragments were produced and how many style and usage contributions were recorded in each store. The important lesson is that extensions do not secretly choose global state. The host controls sharing by passing the same or different `ExtensionData` values, much like choosing whether two people write in the same notebook or in separate notebooks.

#### Function details

##### `main`  (lines 15–68)

```
fn main()
```

**Purpose**: Runs the whole example from start to finish. It enables the sample extension, creates session and thread storage, asks the extension to contribute prompt fragments, and prints the recorded results so a reader can see how shared state behaves.

**Data flow**: It starts with no registry or stores. It creates a registry builder, installs the shared-state extension into it, and builds the registry. It then creates one session store and two thread stores. These stores are passed into prompt contribution calls, which may record counts inside them. Finally, it reads those recorded counts and prints them for the user.

**Call relations**: This is the top-level driver. It calls `install` from the sample extension to register contributors, then calls `contribute_prompt` through `block_on_ready` each time it wants prompt fragments. After the contribution calls finish, it asks the sample extension for the recorded counts and prints the outcome.

*Call graph*: calls 4 internal fn (block_on_ready, contribute_prompt, install, new); 2 external calls (new, println!).


##### `contribute_prompt`  (lines 70–80)

```
async fn contribute_prompt(
    registry: &codex_extension_api::ExtensionRegistry<()>,
    session_store: &ExtensionData,
    thread_store: &ExtensionData,
) -> Vec<codex_extension_api::PromptFragment
```

**Purpose**: Asks every enabled context contributor to add its prompt fragments for a given session and thread. A context contributor is an extension hook that can add useful text to the prompt before a model sees it.

**Data flow**: It receives a registry plus a session store and thread store. It creates an empty list of prompt fragments, loops through the contributors in the registry, and awaits each contributor's result. Each returned fragment is appended to the list. It returns the combined list of fragments to the caller.

**Call relations**: `main` calls this whenever it wants to simulate building prompt context. This function gets the contributors from the registry and hands each one the two stores, letting the extension update or read shared state as part of producing its fragments.

*Call graph*: calls 1 internal fn (context_contributors); called by 1 (main); 1 external calls (new).


##### `block_on_ready`  (lines 82–93)

```
fn block_on_ready(future: F) -> F::Output
```

**Purpose**: Runs one asynchronous operation just far enough to get its result, but only if it finishes immediately. It is a tiny helper for this example so the code can call async contributors without setting up a full async runtime.

**Data flow**: It receives a future, which is Rust's name for work that may finish later. It creates a no-op waker, which is the object normally used to wake sleeping async work, and polls the future once. If the future is ready, it returns the output. If the future is still waiting, it stops the program with an error because this example expects contributors to complete right away.

**Call relations**: `main` wraps each `contribute_prompt` call with this helper. The helper does not know anything about extensions; it only bridges the example's synchronous `main` function with the async shape of the extension API.

*Call graph*: called by 1 (main); 5 external calls (from_waker, as_mut, noop, panic!, pin!).


### App server and notification helpers
These files define the app-server executable surface along with companion test client and file-based notification capture helpers.

### `app-server-test-client/src/main.rs`

`entrypoint` · `startup and full program run`

This file is like the ignition switch for a small command-line program. Most of the useful work lives elsewhere, in `codex_app_server_test_client::run()`. But that work is asynchronous, meaning it can wait for things like network replies or timers without freezing the whole program. Rust async code needs a runtime, which is the engine that drives those waiting tasks forward.

The `main` function builds a Tokio runtime. Tokio is a common Rust tool for running asynchronous tasks. This runtime is configured to run on the current thread, so it does not start a whole pool of worker threads. It also enables Tokio’s built-in support for things such as timers and input/output operations. If creating the runtime fails, the error is returned cleanly using `anyhow::Result`, a flexible error type.

Once the runtime exists, the file uses it to run the test client’s main async routine until it finishes. Without this file, the test client would have no process entry point and no async engine to execute its real work.

#### Function details

##### `main`  (lines 4–7)

```
fn main() -> Result<()>
```

**Purpose**: This is the program’s starting point. It prepares a Tokio async runtime and then runs the test client’s main async workflow inside it.

**Data flow**: Nothing is passed in directly. The function creates a single-threaded Tokio runtime with async features enabled, then gives that runtime the `codex_app_server_test_client::run()` future to execute. If setup or the client run fails, the error comes back as the function’s result; otherwise it exits successfully.

**Call relations**: When the operating system starts this binary, it enters `main`. `main` first calls Tokio’s runtime builder through `new_current_thread`, then hands off to `codex_app_server_test_client::run()` by blocking until that async work is done. In other words, this function does the launch work, and the library `run` function does the actual client behavior.

*Call graph*: 2 external calls (new_current_thread, run).


### `app-server/src/bin/notify_capture.rs`

`entrypoint` · `short-lived command execution`

This program is like a reliable note-drop box. It expects exactly two command-line inputs: where to write the note, and the note text itself. If either input is missing, or if extra inputs are present, it stops with a clear error instead of guessing what the caller meant.

The important detail is how it writes the file. Rather than writing straight to the final destination, it first creates a sibling temporary file whose name ends in `.tmp`. It writes the payload there, asks the operating system to flush the data to storage, and only then renames the temporary file to the requested output path. This matters because a direct write could leave a half-written file if the program or machine fails at the wrong moment. The rename step acts like swapping a finished letter into an envelope: readers should see either the old file or the complete new file, not a partly written one.

The file uses `anyhow`, a Rust error-reporting library, so failures include helpful context such as which file could not be created, written, synced, or moved.

#### Function details

##### `main`  (lines 12–44)

```
fn main() -> Result<()>
```

**Purpose**: Runs the whole command-line program. It checks the arguments, writes the given payload to a temporary file, makes sure it is flushed to storage, and then moves it into the requested final location.

**Data flow**: It reads the command-line arguments from the operating system. The first real argument becomes the output file path, and the second becomes the payload text. It rejects missing or extra arguments. It turns the payload into bytes, writes those bytes to a `.tmp` file, syncs that file so the operating system has pushed the data out, then renames the temporary file to the final path. On success it returns nothing visible; on failure it returns an error with context.

**Call relations**: As the program entry point, this function is where execution begins. It calls the standard argument reader to get inputs, builds file paths, creates the temporary file, and finally asks the filesystem to rename it into place. If the argument shape is wrong, it uses the error path immediately instead of attempting any file write.

*Call graph*: 6 external calls (create, from, bail!, args_os, format!, rename).


### `app-server/src/bin/test_notify_capture.rs`

`entrypoint` · `test helper execution`

This is a small standalone program, not a long-running server. Its job is simple: receive two command-line arguments, treat the first as a file path and the second as the message content, and save that content to disk. This is useful in tests where the larger system needs to “send” a notification, but instead of actually contacting an outside service, the test can point it at this helper and then check the file it creates.

The program is careful about two things. First, it checks that both required arguments are present, and it gives a clear error if either is missing. Second, it writes to a temporary file first and then renames that file to the final output path. That rename step is commonly used as an atomic handoff: like writing a note on scratch paper before placing the finished note in someone’s inbox. A reader should either see the old file or the complete new file, not a half-written one.

It also insists that the payload is valid UTF-8 text, which means the bytes must form ordinary Unicode text. If the payload is not valid text, the program stops with an error instead of writing unclear data.

#### Function details

##### `main`  (lines 6–23)

```
fn main() -> Result<()>
```

**Purpose**: Runs the helper program. It reads the output file path and payload from the command line, validates them, and writes the payload to disk through a temporary file so the final file appears complete.

**Data flow**: It starts with the command-line arguments supplied by the caller. The first argument becomes the destination path, and the second becomes the text payload after checking that it is valid UTF-8. It writes that payload to a temporary file next to the destination, then renames the temporary file to the requested output path. On success it returns nothing meaningful except success; on missing or invalid input, or a file system failure, it returns an error.

**Call relations**: This is the program’s entry point, so it is invoked when the operating system starts this test helper. During its short run it asks the standard environment for command-line arguments, uses the file system to write the temporary file, and then uses the file system again to rename it into place.

*Call graph*: 4 external calls (from, args_os, rename, write).


### `app-server/src/main.rs`

`entrypoint` · `startup`

This file is the front door of the app-server program. When someone starts the binary, this code decides what options the server should use before the real server machinery begins. It uses command-line flags to choose how the server listens for clients, such as standard input/output, a Unix socket, or a WebSocket address. It also accepts configuration overrides, authentication settings for WebSocket use, a session source that describes where the session is coming from, and a strict mode that can reject unknown configuration fields.

A small but important part of the file exists for tests. In debug builds, integration tests can point the server at a temporary managed configuration file or disable managed configuration entirely. That keeps tests from touching machine-wide files such as `/etc`. These hooks are guarded so normal release builds do not expose them.

The `main` function also decides how remote control should start. A command-line flag can enable it just for this run, while an environment setting can temporarily disable it. After collecting all of this, the file creates runtime options and passes everything to `run_main_with_transport_options`, which is the shared app-server startup path. In short, this file is like the reception desk: it checks the startup instructions, chooses the right badges and routes, then sends the program into the main server.

#### Function details

##### `main`  (lines 61–109)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Starts the app-server process. It gathers command-line choices and environment-based startup hints, turns them into server options, and then launches the shared app-server runner.

**Data flow**: The function begins with information from the environment, especially whether remote control was disabled elsewhere. It then lets the arg0 dispatch layer inspect how the program was invoked; if normal app-server startup should continue, it parses command-line arguments into `AppServerArgs`. From those inputs it builds configuration loader overrides, transport settings, authentication settings, and runtime behavior such as plugin startup and remote-control mode. The result is not a returned data object; instead, it starts the server through the shared runner and returns success or an error if startup fails.

**Call relations**: This is called by the operating system when the binary starts. It first asks `take_remote_control_disabled_env` for a one-time remote-control disable signal, then hands the rest of startup to `arg0_dispatch_or_else`, which can redirect execution depending on the program name or continue into the async app-server startup path.

*Call graph*: 2 external calls (take_remote_control_disabled_env, arg0_dispatch_or_else).


##### `disable_managed_config_from_debug_env`  (lines 111–120)

```
fn disable_managed_config_from_debug_env() -> bool
```

**Purpose**: Checks a debug-only environment variable that tells tests to skip managed configuration. This is useful when integration tests need a clean, isolated setup instead of reading machine-level configuration.

**Data flow**: The input is the process environment. In debug builds, it reads `CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG`; values like `1`, `true`, `TRUE`, `yes`, or `YES` become `true`. If the variable is missing, has another value, or the program is not a debug build, the function returns `false`.

**Call relations**: During startup, `main` uses this helper before loading configuration. If it returns `true`, `main` builds loader overrides that avoid managed configuration; otherwise startup continues with either a test-supplied managed config path or the normal defaults.

*Call graph*: 2 external calls (matches!, var).


##### `managed_config_path_from_debug_env`  (lines 122–135)

```
fn managed_config_path_from_debug_env() -> Option<PathBuf>
```

**Purpose**: Looks for a debug-only environment variable that points to a test managed-configuration file. This lets tests run the real binary while using a temporary config file instead of a system one.

**Data flow**: The input is the process environment. In debug builds, it reads `CODEX_APP_SERVER_MANAGED_CONFIG_PATH`. If the variable exists and is not empty, the string is turned into a filesystem path and returned. If it is empty, missing, or the program is not a debug build, the function returns no path.

**Call relations**: During startup, `main` calls this after checking whether managed configuration should be disabled. If this helper returns a path, `main` passes that path into the configuration loader overrides so the rest of startup reads managed configuration from the test location.

*Call graph*: 2 external calls (from, var).


### MCP and proxy test servers
This set contains directly runnable MCP-related servers, proxies, and connectivity probes used for integration testing and local experimentation.

### `rmcp-client/src/bin/test_stdio_server.rs`

`entrypoint` · `startup and request handling`

This binary is a controlled pretend server for MCP, the Model Context Protocol, which is a way for an app to discover and call external tools and read external resources. Think of it like a practice vending machine: it offers known buttons, returns known items, and can be used to check whether the customer side works correctly.

When started, it builds a `TestToolServer` with several tools. Some are simple, like `echo`, which repeats a message and reports an environment variable, and `cwd`, which reports the server process's current folder. Others are made for harder tests: `sync` can pause several concurrent calls at a shared barrier, and the image tools return image content in different shapes so the user interface can prove it displays tool images correctly. The server also exposes one sample text resource and one matching resource template.

The file implements the MCP server callbacks: reporting server capabilities, listing tools, listing resources, reading the sample resource, and dispatching tool calls by name. It also includes the program `main`, which starts the server on standard input/output. Without this file, integration tests and manual UI checks would need a real external MCP server, making them slower, less predictable, and harder to reproduce.

#### Function details

##### `stdio`  (lines 48–50)

```
fn stdio() -> (tokio::io::Stdin, tokio::io::Stdout)
```

**Purpose**: Returns the process's standard input and standard output as the communication channel for the MCP server. This lets the server talk to a client through pipes instead of a network port.

**Data flow**: It takes no input. It asks Tokio, the asynchronous runtime, for handles to stdin and stdout, then returns them as a pair for the server to use.

**Call relations**: During startup, `main` calls this function and hands the returned input/output pair to the MCP serving layer. After that, the protocol reads requests from stdin and writes responses to stdout.

*Call graph*: called by 1 (main); 2 external calls (stdin, stdout).


##### `TestToolServer::new`  (lines 53–85)

```
fn new() -> Self
```

**Purpose**: Builds a fresh test server with all of its advertised tools, resources, and resource templates. This is the central setup step that defines what the fake server can do.

**Data flow**: It starts with no caller-provided data. It creates JSON schemas that describe each tool's expected inputs, collects tool definitions, creates the sample memo resource and template, wraps the lists in shared pointers, and returns a ready-to-serve `TestToolServer`.

**Call relations**: `main` calls this once at startup before serving begins. The objects created here are later used by `list_tools`, `list_resources`, `list_resource_templates`, and `call_tool` to answer client requests.

*Call graph*: 7 external calls (new, Borrowed, new, new, from_value, json!, vec!).


##### `TestToolServer::echo_tool`  (lines 87–92)

```
fn echo_tool() -> Tool
```

**Purpose**: Creates the normal `echo` tool definition. A client can discover this tool and learn that it repeats a message and can include environment data.

**Data flow**: It takes no input. It supplies the name `echo` and a short description to the shared echo-tool builder, then returns the finished tool description.

**Call relations**: `TestToolServer::new` calls this while assembling the server's tool list. It delegates the common schema-building work to `TestToolServer::build_echo_tool` so both echo variants stay consistent.

*Call graph*: 1 external calls (build_echo_tool).


##### `TestToolServer::echo_dash_tool`  (lines 94–99)

```
fn echo_dash_tool() -> Tool
```

**Purpose**: Creates an echo tool whose name contains a dash, `echo-tool`. This tests clients that must handle tool names that are not valid JavaScript-style identifiers.

**Data flow**: It takes no input. It passes the dashed name and its description to the shared echo-tool builder and returns the resulting tool definition.

**Call relations**: `TestToolServer::new` includes this in the advertised tools. It uses `TestToolServer::build_echo_tool`, just like the regular echo tool, so the behavior is the same apart from the name.

*Call graph*: 1 external calls (build_echo_tool).


##### `TestToolServer::build_echo_tool`  (lines 101–138)

```
fn build_echo_tool(name: &'static str, description: &'static str) -> Tool
```

**Purpose**: Builds the reusable definition for echo-like tools. It describes both what arguments the tool accepts and what structured result it promises to return.

**Data flow**: It receives a tool name and description. It creates an input schema requiring a `message` string and optionally accepting an `env_var`, creates an output schema with `echo` and `env` fields, marks the tool as read-only, and returns the complete `Tool` object.

**Call relations**: `TestToolServer::echo_tool` and `TestToolServer::echo_dash_tool` call this during startup. Later, when a client calls either tool, `TestToolServer::call_tool` produces results that match the schemas built here.

*Call graph*: 6 external calls (new, Borrowed, new, json!, new, from_value).


##### `TestToolServer::cwd_tool`  (lines 140–167)

```
fn cwd_tool() -> Tool
```

**Purpose**: Creates the `cwd` tool definition, which lets tests ask where the server process is running. This is useful for checking process setup and working-directory behavior.

**Data flow**: It takes no input. It creates an empty input schema, an output schema with one `cwd` string field, marks the tool read-only, and returns the tool description.

**Call relations**: `TestToolServer::new` adds this tool to the server's advertised tool list. When a client later calls `cwd`, `TestToolServer::call_tool` reads the actual current directory and returns data matching this definition.

*Call graph*: 6 external calls (new, Borrowed, new, json!, new, from_value).


##### `TestToolServer::sync_tool`  (lines 169–210)

```
fn sync_tool() -> Tool
```

**Purpose**: Creates the `sync` tool definition, used to coordinate concurrent test calls. It can sleep before or after a shared barrier so tests can force timing-sensitive situations.

**Data flow**: It takes no input. It builds an input schema with optional sleep delays and an optional barrier description, builds an output schema saying the result is a string, and returns the tool definition.

**Call relations**: `TestToolServer::new` includes this tool in the server. When clients call it, `TestToolServer::call_tool` parses the arguments and hands them to `TestToolServer::sync_result`.

*Call graph*: 5 external calls (new, Borrowed, json!, new, from_value).


##### `TestToolServer::sync_readonly_tool`  (lines 212–217)

```
fn sync_readonly_tool() -> Tool
```

**Purpose**: Creates a read-only version of the synchronization tool named `sync_readonly`. This lets tests check behavior that depends on a tool being marked safe to call without changing external state.

**Data flow**: It starts by building the normal `sync` tool. It then changes the name to `sync_readonly`, adds a read-only annotation, and returns the adjusted tool definition.

**Call relations**: `TestToolServer::new` adds this variant alongside `sync`. At call time, `TestToolServer::call_tool` sends it through the same execution path as `sync`, but clients see different metadata when listing tools.

*Call graph*: 3 external calls (Borrowed, sync_tool, new).


##### `TestToolServer::image_tool`  (lines 219–235)

```
fn image_tool() -> Tool
```

**Purpose**: Creates the `image` tool definition, which returns a single image block. It is mainly used to test whether clients can receive and display image tool output.

**Data flow**: It takes no input. It creates an empty input schema, names and describes the tool, marks it read-only, and returns the tool definition.

**Call relations**: `TestToolServer::new` advertises this tool. When a client calls `image`, `TestToolServer::call_tool` reads a data URL from an environment variable and converts it into an MCP image response.

*Call graph*: 6 external calls (new, Borrowed, new, new, from_value, json!).


##### `TestToolServer::image_scenario_tool`  (lines 256–294)

```
fn image_scenario_tool() -> Tool
```

**Purpose**: Creates the `image_scenario` tool definition for manual and automated checks of tricky image-result layouts. It can describe cases like text before an image, invalid images before valid ones, or multiple images.

**Data flow**: It takes no input. It builds a schema requiring a `scenario` value, optionally accepting a caption and a data URL, marks the tool read-only, and returns the tool definition.

**Call relations**: `TestToolServer::new` adds this tool to the list clients can discover. When called, `TestToolServer::call_tool` parses the arguments and asks `TestToolServer::image_scenario_result` to build the requested content blocks.

*Call graph*: 6 external calls (new, Borrowed, new, new, from_value, json!).


##### `TestToolServer::memo_resource`  (lines 296–308)

```
fn memo_resource() -> Resource
```

**Purpose**: Creates the server's one concrete sample resource. The resource is a small text memo with a fixed URI, name, title, description, and plain-text MIME type.

**Data flow**: It takes no input. It fills out raw resource metadata for the fixed memo URI and wraps it as an MCP `Resource`, then returns it.

**Call relations**: `TestToolServer::new` stores this resource in the server. `list_resources` later returns it to clients, and `read_resource` returns its contents when the matching URI is requested.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_template`  (lines 310–322)

```
fn memo_template() -> ResourceTemplate
```

**Purpose**: Creates a resource template for memo-style URIs. This tells clients that resources following the `memo://codex/{slug}` pattern are meaningful in this test server.

**Data flow**: It takes no input. It fills out template metadata, including the URI pattern and text MIME type, wraps it as a `ResourceTemplate`, and returns it.

**Call relations**: `TestToolServer::new` stores this template. `list_resource_templates` later returns it when a client asks what resource patterns the server supports.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_text`  (lines 324–326)

```
fn memo_text() -> &'static str
```

**Purpose**: Returns the fixed text content of the sample memo resource. Keeping this in one helper avoids repeating the literal content where the resource is read.

**Data flow**: It takes no input and reads no changing state. It returns the static memo string stored in the file.

**Call relations**: `TestToolServer::read_resource` calls this when the client asks for the known memo URI, then places the returned text into an MCP resource response.


##### `default_sync_timeout_ms`  (lines 363–365)

```
fn default_sync_timeout_ms() -> u64
```

**Purpose**: Provides the default timeout for synchronization barriers. If a test call does not say how long it is willing to wait, this value is used.

**Data flow**: It takes no input. It returns the constant timeout value in milliseconds.

**Call relations**: This function is used by deserialization of `SyncBarrierArgs`: when incoming JSON omits `timeout_ms`, the argument parser fills in this default before `TestToolServer::sync_result` reaches `wait_on_sync_barrier`.


##### `sync_barrier_map`  (lines 367–369)

```
fn sync_barrier_map() -> &'static tokio::sync::Mutex<HashMap<String, SyncBarrierState>>
```

**Purpose**: Returns the shared table of named synchronization barriers. A barrier is like a meeting point where several tool calls must all arrive before any of them continue.

**Data flow**: It takes no input. On first use, it creates a mutex-protected hash map; on later uses, it returns the same shared map. The mutex is a lock that prevents two tasks from changing the table at the same time.

**Call relations**: `wait_on_sync_barrier` uses this table to find or create barriers by ID. `remove_sync_barrier_if_current` uses it to clean up barriers after they finish or time out.

*Call graph*: called by 2 (remove_sync_barrier_if_current, wait_on_sync_barrier).


##### `TestToolServer::get_info`  (lines 399–412)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Reports what this server can do. It tells the client that tools and resources are available, and it advertises one experimental capability used by tests.

**Data flow**: It reads no request data. It builds a capability object, adds the experimental sandbox metadata marker, attaches a short instruction string, and returns a `ServerInfo` response.

**Call relations**: The MCP framework calls this during server initialization or capability discovery. The information it returns shapes what the client believes it can ask this server for later.

*Call graph*: 4 external calls (from, new, builder, new).


##### `TestToolServer::list_tools`  (lines 414–427)

```
fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = R
```

**Purpose**: Returns the full list of tools this test server offers. This is how a client discovers names like `echo`, `cwd`, `sync`, and the image tools.

**Data flow**: It receives an optional pagination request and request context, but this server ignores both because the list is small and fixed. It clones the stored tool list and returns it with no next-page cursor.

**Call relations**: The MCP framework calls this when a client asks to list tools. The list was built in `TestToolServer::new`, and later client tool calls are routed by `TestToolServer::call_tool`.


##### `TestToolServer::list_resources`  (lines 429–442)

```
fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output
```

**Purpose**: Returns the concrete resources available from this server. In this file, that means the single fixed sample memo resource.

**Data flow**: It receives an optional pagination request and context, but ignores them. It clones the stored resource list and returns it with no next-page cursor.

**Call relations**: The MCP framework calls this when a client asks for resources. The returned resource was created by `TestToolServer::memo_resource`, and `TestToolServer::read_resource` can later provide its contents.


##### `TestToolServer::list_resource_templates`  (lines 444–454)

```
async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResou
```

**Purpose**: Returns the URI templates this server supports. This lets clients learn that memo resources follow a predictable `memo://codex/{slug}` shape.

**Data flow**: It receives optional pagination information and context, but ignores them. It clones the stored template list and returns it with no next-page cursor.

**Call relations**: The MCP framework calls this when a client asks for resource templates. The template was created during `TestToolServer::new` by `TestToolServer::memo_template`.


##### `TestToolServer::read_resource`  (lines 456–476)

```
async fn read_resource(
        &self,
        ReadResourceRequestParams { uri, .. }: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Re
```

**Purpose**: Returns the contents of the sample memo resource, or a clear error if the client asks for anything else. This makes resource-reading behavior predictable for tests.

**Data flow**: It receives a resource-read request containing a URI. If the URI matches the fixed memo URI, it returns a plain-text resource content block containing the memo text; otherwise it returns a `resource_not_found` error that includes the requested URI.

**Call relations**: The MCP framework calls this after a client chooses to read a resource. It relies on `TestToolServer::memo_text` for the fixed content and matches the resource advertised by `list_resources`.

*Call graph*: 4 external calls (resource_not_found, new, json!, vec!).


##### `TestToolServer::call_tool`  (lines 478–554)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError>
```

**Purpose**: Runs the requested test tool and returns its result. This is the main dispatcher for all tool behavior in the server.

**Data flow**: It receives a tool-call request and request context. It looks at the requested tool name, parses any JSON arguments, reads environment variables or process state when needed, builds text, image, or structured JSON results, and returns either a successful `CallToolResult` or an MCP error for bad input or unknown tools.

**Call relations**: The MCP framework calls this whenever the client invokes a tool listed by `list_tools`. It hands off shared parsing to `TestToolServer::parse_call_args`, image scenario creation to `TestToolServer::image_scenario_result`, synchronization to `TestToolServer::sync_result`, data URL splitting to `parse_data_url`, and structured JSON wrapping to `TestToolServer::structured_result`.

*Call graph*: calls 1 internal fn (parse_data_url); 13 external calls (invalid_params, image_scenario_result, structured_result, sync_result, format!, json!, success, Object, from_value, current_dir (+3 more)).


##### `TestToolServer::parse_call_args`  (lines 558–572)

```
fn parse_call_args(
        request: &CallToolRequestParams,
        tool_name: &'static str,
    ) -> Result<T, McpError>
```

**Purpose**: Turns a tool call's raw JSON arguments into a typed Rust argument struct. This gives each tool a simple, checked input object instead of loose JSON.

**Data flow**: It receives the full tool-call request and the expected tool name. If arguments are present, it converts the JSON object into the requested type; if conversion fails or arguments are missing, it returns an `invalid_params` error.

**Call relations**: `TestToolServer::call_tool` uses this helper for tools with structured inputs, such as `image_scenario`, `sync`, and `sync_readonly`. The parsed result is then passed to the tool-specific result builder.

*Call graph*: 4 external calls (invalid_params, format!, Object, from_value).


##### `TestToolServer::image_scenario_result`  (lines 574–645)

```
fn image_scenario_result(args: ImageScenarioArgs) -> Result<CallToolResult, McpError>
```

**Purpose**: Builds the output for the `image_scenario` tool. It creates different combinations of text, valid images, invalid images, and metadata so clients can be tested against real edge cases.

**Data flow**: It receives parsed image-scenario arguments. It chooses image data either from an optional data URL or from a built-in tiny PNG, chooses a caption, builds content blocks according to the requested scenario, and returns a successful tool result containing those blocks.

**Call relations**: `TestToolServer::call_tool` calls this after parsing `image_scenario` arguments. It uses `parse_data_url` when custom image data is supplied, then hands the completed content list back as the final tool response.

*Call graph*: calls 1 internal fn (parse_data_url); 8 external calls (new, success, new, image, text, new, Image, json!).


##### `TestToolServer::sync_result`  (lines 647–665)

```
async fn sync_result(args: SyncArgs) -> Result<CallToolResult, McpError>
```

**Purpose**: Executes the timing behavior for `sync` and `sync_readonly`. It can delay before a barrier, wait for other calls, delay after the barrier, and then report success.

**Data flow**: It receives parsed synchronization arguments. It sleeps for the requested pre-delay, waits on the named barrier if one was provided, sleeps for the requested post-delay, then returns structured JSON saying the result is `ok`.

**Call relations**: `TestToolServer::call_tool` invokes this for both synchronization tools. If a barrier is included, it delegates the meeting-point logic to `wait_on_sync_barrier`, then wraps the final success through `TestToolServer::structured_result`.

*Call graph*: calls 1 internal fn (wait_on_sync_barrier); 4 external calls (from_millis, structured_result, json!, sleep).


##### `TestToolServer::structured_result`  (lines 667–671)

```
fn structured_result(value: serde_json::Value) -> CallToolResult
```

**Purpose**: Creates a tool result whose main payload is structured JSON rather than ordinary text content. This keeps simple tools like `echo` and `cwd` consistent.

**Data flow**: It receives a JSON value. It starts with an empty successful tool result, places that JSON value into the result's `structured_content` field, and returns the result.

**Call relations**: `TestToolServer::call_tool` uses this for tools such as `sandbox_meta`, `cwd`, and `echo`. `TestToolServer::sync_result` also uses it to return its final `ok` response.

*Call graph*: 2 external calls (new, success).


##### `wait_on_sync_barrier`  (lines 674–734)

```
async fn wait_on_sync_barrier(args: SyncBarrierArgs) -> Result<(), McpError>
```

**Purpose**: Makes one tool call wait until the required number of matching calls reach the same named barrier. This is used to test concurrency, like making several runners line up at the same starting gate before continuing.

**Data flow**: It receives a barrier ID, participant count, and timeout. It rejects impossible settings, looks up or creates the shared barrier, waits until all participants arrive or the timeout expires, cleans up the barrier when appropriate, and returns success or an `invalid_params` error.

**Call relations**: `TestToolServer::sync_result` calls this when the incoming sync arguments include a barrier. It uses `sync_barrier_map` to share barrier state across calls and calls `remove_sync_barrier_if_current` to remove stale or completed entries safely.

*Call graph*: calls 2 internal fn (remove_sync_barrier_if_current, sync_barrier_map); called by 1 (sync_result); 6 external calls (new, new, from_millis, invalid_params, format!, timeout).


##### `remove_sync_barrier_if_current`  (lines 736–743)

```
async fn remove_sync_barrier_if_current(barrier_id: &str, barrier: &Arc<Barrier>)
```

**Purpose**: Removes a named synchronization barrier only if it is still the exact barrier this caller used. This avoids deleting a newer barrier that reused the same name after an older one finished or timed out.

**Data flow**: It receives a barrier ID and a reference to the barrier object that should be removed. It locks the shared barrier map, checks whether the stored barrier is the same object, and removes the entry only when it matches.

**Call relations**: `wait_on_sync_barrier` calls this after a timeout and after the leader participant releases a completed barrier. It uses `sync_barrier_map` to access the shared table.

*Call graph*: calls 1 internal fn (sync_barrier_map); called by 1 (wait_on_sync_barrier); 1 external calls (ptr_eq).


##### `parse_data_url`  (lines 745–750)

```
fn parse_data_url(url: &str) -> Option<(String, String)>
```

**Purpose**: Splits a simple data URL into its MIME type and base64 data. A data URL is a string like `data:image/png;base64,...` that carries file data inline.

**Data flow**: It receives a string. If the string starts with `data:`, contains a comma, and has a MIME section, it returns the MIME type and the data after the comma; otherwise it returns nothing.

**Call relations**: `TestToolServer::call_tool` uses this for the `image` tool's environment-provided image. `TestToolServer::image_scenario_result` uses it when the caller supplies custom image data for image scenarios.

*Call graph*: called by 2 (call_tool, image_scenario_result).


##### `main`  (lines 753–768)

```
async fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Starts the test server process. It performs small startup chores, serves MCP over standard input/output, and waits until the client disconnects.

**Data flow**: It prints a startup message, optionally writes the process ID to a file named by `MCP_TEST_PID_FILE`, creates a `TestToolServer`, connects it to stdin/stdout, waits for the serving task to finish, yields once so background work can drain, and returns success or an error.

**Call relations**: This is the binary entry point run by the operating system. It calls `TestToolServer::new` to build the server and `stdio` to choose the transport, then hands both to the MCP serving layer for the rest of the process lifetime.

*Call graph*: calls 2 internal fn (new, stdio); 5 external calls (eprintln!, var, write, id, yield_now).


### `rmcp-client/src/bin/rmcp_test_server.rs`

`entrypoint` · `startup, request handling, shutdown`

This is a simple server program used for testing an MCP client. MCP, or Model Context Protocol, is a way for a client and server to exchange requests about tools and data. Here, the server is deliberately tiny: it advertises one tool named `echo`, waits for a client to call it, and returns a structured response.

Think of it like a practice vending machine for client code. The client can ask, “What buttons do you have?” and the server says, “I have an echo button.” Then the client presses that button with a message, and the server gives back the same message plus the value of an environment variable.

The `TestToolServer` stores the list of available tools. Its tool definition includes an input schema, which says what arguments are allowed, and an output schema, which says what shape the answer will have. When `echo` is called, the server checks that the request has valid arguments, reads the current process environment, chooses the requested environment variable name or falls back to `MCP_TEST_VALUE`, and returns JSON-like structured content.

The `main` function starts the server using standard input/output as the transport. That makes it easy for another process to launch this binary and communicate with it directly.

#### Function details

##### `stdio`  (lines 24–26)

```
fn stdio() -> (tokio::io::Stdin, tokio::io::Stdout)
```

**Purpose**: This function provides the communication channel for the test server. It returns the process standard input and standard output, which let another program talk to this server through normal terminal-style streams.

**Data flow**: It takes no inputs. It asks Tokio, the asynchronous runtime, for standard input and standard output handles, then returns them as a pair. Nothing else is changed.

**Call relations**: During startup, `main` calls this when it is ready to serve requests. The returned input/output pair is handed to the MCP service runner so client messages can come in through stdin and server replies can go out through stdout.

*Call graph*: called by 1 (main); 2 external calls (stdin, stdout).


##### `TestToolServer::new`  (lines 28–33)

```
fn new() -> Self
```

**Purpose**: This builds a fresh test server with its known tools already registered. In this file, that means creating a server that can offer the single `echo` tool.

**Data flow**: It takes no inputs. It creates a vector containing the echo tool definition, wraps that vector in shared storage so cloned server values can point to the same tool list, and returns a `TestToolServer` ready to run.

**Call relations**: At startup, `main` calls this to create the server before serving begins. It relies on the tool-building logic for the echo tool so that later tool-list requests can return a complete description of what the server supports.

*Call graph*: called by 2 (main, main); 2 external calls (new, vec!).


##### `TestToolServer::echo_tool`  (lines 35–71)

```
fn echo_tool() -> Tool
```

**Purpose**: This creates the description of the server’s `echo` tool. The description tells clients the tool’s name, what it does, what input it accepts, and what output shape to expect.

**Data flow**: It starts with hard-coded JSON schema data. It turns that schema into the object type expected by the MCP library, builds a `Tool` named `echo`, attaches a second schema describing the structured output, and returns the finished tool definition.

**Call relations**: This is part of server construction. The server’s tool list needs this definition so that when a client asks what tools exist, the server can advertise `echo` accurately before any tool call is made.

*Call graph*: 5 external calls (new, Borrowed, json!, new, from_value).


##### `TestToolServer::get_info`  (lines 81–88)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: This tells MCP clients what this server is capable of. In particular, it says the server supports tools and can report changes to the tool list.

**Data flow**: It reads no request-specific data. It builds a `ServerInfo` value with tool support enabled, then returns that information to the MCP framework.

**Call relations**: The MCP framework calls this as part of identifying the server to a client. The returned information helps the client know it is allowed to ask for tools and call them.

*Call graph*: 2 external calls (builder, new).


##### `TestToolServer::list_tools`  (lines 90–103)

```
fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = R
```

**Purpose**: This answers the client’s question, “What tools can I use?” It returns the server’s stored list of tool definitions.

**Data flow**: It receives an optional pagination request and a request context, but this test server does not need either one. It clones the shared tool list, wraps it in a successful `ListToolsResult`, sets no next page because all tools fit in one response, and returns that result asynchronously.

**Call relations**: The MCP framework calls this when a client requests the available tools. It hands back the tool list created during server startup so the client can discover and understand the `echo` tool before calling it.


##### `TestToolServer::call_tool`  (lines 105–141)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError>
```

**Purpose**: This runs a requested tool call. For the `echo` tool, it validates the arguments, echoes the message, looks up an environment variable, and returns both pieces as structured content.

**Data flow**: It receives the tool name and optional arguments from the client. If the name is `echo`, it converts the arguments into an `EchoArgs` value, rejecting the request if arguments are missing or malformed. It then reads all process environment variables, chooses the requested variable name or `MCP_TEST_VALUE`, builds a JSON-like result with `echo` and `env` fields, and returns a successful tool result. If the tool name is unknown, it returns an invalid-parameters error.

**Call relations**: The MCP framework calls this when a client invokes a tool. Successful `echo` calls end here with a structured response for the client; bad input or an unknown tool name is turned into an MCP error so the client can understand what went wrong.

*Call graph*: 8 external calls (invalid_params, new, format!, json!, success, Object, from_value, vars).


##### `main`  (lines 145–157)

```
async fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: This is the program entry point. It starts the test server, connects it to standard input/output, waits while the client talks to it, and then shuts down cleanly.

**Data flow**: It begins by printing a startup message to standard error. It creates a `TestToolServer`, gets stdin/stdout from `stdio`, starts serving over those streams, waits until the client interaction finishes, gives background tasks a chance to settle, and returns success or any error that occurred.

**Call relations**: This ties the whole file together. It calls `TestToolServer::new` to build the service and `stdio` to choose the transport, then hands both to the MCP serving machinery. When serving ends, it yields once to let asynchronous cleanup complete before the process exits.

*Call graph*: calls 2 internal fn (new, stdio); 2 external calls (eprintln!, yield_now).


### `rmcp-client/src/bin/test_streamable_http_server.rs`

`entrypoint` · `startup and request handling`

This binary is a self-contained test stand for the project's streamable HTTP MCP transport. MCP, or Model Context Protocol, is the protocol being tested here: it lets a client ask a server what tools and resources it has, call those tools, and read those resources. Without this file, integration tests would need a separate live server, making them slower, harder to reproduce, and less able to test awkward network and authentication failures.

At startup, the program chooses a bind address from environment variables or a default local address. It opens a TCP listener, builds an Axum HTTP router, and mounts the real rmcp streamable HTTP service at `/mcp`. The server implementation is `TestToolServer`: it advertises one tool named `echo`, one text resource at a fixed `memo://` URI, and one matching resource template.

The file also adds test-only behavior around that service. If `MCP_EXPECT_BEARER` is set, requests must include the expected `Authorization: Bearer ...` header, except for the OAuth metadata discovery endpoint. Separate control endpoints can “arm” a forced failure for initialize, initialized-notification, or normal session POST requests. That is like telling a practice fire alarm to go off on the next matching request, so tests can verify retry and error-handling behavior.

#### Function details

##### `main`  (lines 116–206)

```
async fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Starts the test HTTP server. It chooses where to listen, builds all routes and middleware, optionally enables bearer-token checks, and then serves requests until the process stops.

**Data flow**: It reads environment variables for the bind address, optional output file, and optional expected bearer token. It creates shared failure-test state, binds a TCP listener with short retries if the address is temporarily busy, writes the actual address if requested, builds the router, and hands the listener and router to Axum. The visible result is a running server, usually at `/mcp` on localhost.

**Call relations**: This is the top-level entry point. It calls `parse_bind_addr` before doing any networking, creates new `TestToolServer` instances for the MCP service when sessions need them, wires the control routes to the arm functions, installs `fail_mcp_post_when_armed` as request middleware, and may install `require_bearer` when authentication testing is enabled.

*Call graph*: calls 1 internal fn (parse_bind_addr); 18 external calls (new, from_millis, default, new, default, new, get, post, serve, eprintln! (+8 more)).


##### `TestToolServer::get_info`  (lines 209–217)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Tells MCP clients what this test server can do. It advertises support for tools, tool-list-change notices, and resources.

**Data flow**: It reads no request-specific data. It builds a `ServerInfo` value containing capability flags, then returns that value to the MCP framework. Nothing else is changed.

**Call relations**: The rmcp service calls this during MCP setup so the client can learn the server's abilities. The information it returns explains why later calls such as `TestToolServer::list_tools` and `TestToolServer::list_resources` are valid.

*Call graph*: 2 external calls (builder, new).


##### `TestToolServer::list_tools`  (lines 219–232)

```
fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = R
```

**Purpose**: Returns the list of tools that clients may call. In this test server, that list contains the single `echo` tool.

**Data flow**: It receives optional paging information and a server request context, but this simple server does not use them. It clones the shared tool list stored inside `TestToolServer` and returns it with no next page cursor.

**Call relations**: The rmcp service calls this when an MCP client asks what tools are available. The data was prepared earlier by `TestToolServer::new`, mainly through `TestToolServer::echo_tool`.


##### `TestToolServer::list_resources`  (lines 234–247)

```
fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output
```

**Purpose**: Returns the concrete resources that clients can read. Here it exposes one sample memo resource.

**Data flow**: It receives optional paging information and a request context, but ignores both because the resource list is fixed and small. It clones the stored resource list and returns it without pagination.

**Call relations**: The rmcp service calls this when a client asks for available resources. The resource was created by `TestToolServer::memo_resource` during `TestToolServer::new`.


##### `TestToolServer::list_resource_templates`  (lines 249–259)

```
async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResou
```

**Purpose**: Returns resource URI patterns that clients can use as examples or templates. This server exposes a memo-style template for tests.

**Data flow**: It receives optional paging information and a request context, but does not need them. It clones the stored resource template list and returns it with no next page cursor.

**Call relations**: The rmcp service calls this when a client asks for resource templates. The template itself is built by `TestToolServer::memo_template` when the server instance is created.


##### `TestToolServer::read_resource`  (lines 261–281)

```
async fn read_resource(
        &self,
        ReadResourceRequestParams { uri, .. }: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Re
```

**Purpose**: Reads the test memo resource when a client requests its exact URI. If the URI is not the known memo URI, it returns a clear MCP “resource not found” error.

**Data flow**: It takes a resource-read request containing a URI. If the URI matches the constant memo URI, it wraps the fixed memo text in a text resource response and returns it. If not, it returns an error that includes the missing URI for easier debugging.

**Call relations**: The rmcp service calls this after a client chooses to read a resource, often one discovered through `TestToolServer::list_resources`. It uses `TestToolServer::memo_text` for the successful response and uses the rmcp error helper for the failure response.

*Call graph*: 4 external calls (resource_not_found, new, json!, vec!).


##### `TestToolServer::call_tool`  (lines 283–318)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError>
```

**Purpose**: Runs a named tool requested by an MCP client. This test server only understands the `echo` tool, which returns the message back in structured JSON and includes a snapshot of one test environment value.

**Data flow**: It receives a tool-call request with a tool name and optional JSON arguments. For `echo`, it parses the arguments into an `EchoArgs` shape, requires a `message`, reads environment variables, builds structured output containing `ECHOING: <message>` and the value of `MCP_TEST_VALUE`, and returns success. Missing or invalid arguments, or an unknown tool name, become MCP invalid-parameter errors.

**Call relations**: The rmcp service calls this when a client invokes a tool that was advertised by `TestToolServer::list_tools`. Its expected input and output match the schemas created in `TestToolServer::echo_tool`.

*Call graph*: 8 external calls (invalid_params, new, format!, json!, success, Object, from_value, vars).


##### `TestToolServer::new`  (lines 322–331)

```
fn new() -> Self
```

**Purpose**: Builds a fresh test server instance with its fixed catalog of tools, resources, and resource templates. This gives each new MCP service session the same predictable behavior.

**Data flow**: It calls helper constructors to create the echo tool, memo resource, and memo template. It stores each list in shared reference-counted containers so cloned server values can cheaply share the same read-only data. It returns a ready-to-use `TestToolServer`.

**Call relations**: The streamable HTTP service created in `main` calls this factory when it needs a server handler. It gathers the pieces produced by `TestToolServer::echo_tool`, `TestToolServer::memo_resource`, and `TestToolServer::memo_template`.

*Call graph*: 2 external calls (new, vec!).


##### `TestToolServer::echo_tool`  (lines 333–370)

```
fn echo_tool() -> Tool
```

**Purpose**: Defines the `echo` tool that this test server advertises to clients. It describes what arguments the tool accepts and what structured output it returns.

**Data flow**: It builds a JSON input schema requiring a string `message` and optionally allowing `env_var`. It creates a tool named `echo`, then attaches an output schema with `echo` and `env` fields and marks the tool as read-only, meaning it should not change external state. The completed tool definition is returned.

**Call relations**: Called by `TestToolServer::new` while assembling the server's tool list. The schema it creates is the contract later enforced in spirit by `TestToolServer::call_tool`, which parses and responds to calls of this tool.

*Call graph*: 6 external calls (new, Borrowed, new, json!, new, from_value).


##### `TestToolServer::memo_resource`  (lines 372–384)

```
fn memo_resource() -> Resource
```

**Purpose**: Defines the one concrete sample resource exposed by the test server. It gives the resource a stable URI, name, title, description, and plain-text type.

**Data flow**: It fills a raw resource record with fixed metadata, including the `memo://codex/example-note` URI. It wraps that raw record in the rmcp `Resource` type and returns it. It does not read files or external data.

**Call relations**: Called by `TestToolServer::new` to populate the resource list returned by `TestToolServer::list_resources`. The URI it defines is the one `TestToolServer::read_resource` accepts for successful reads.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_template`  (lines 386–398)

```
fn memo_template() -> ResourceTemplate
```

**Purpose**: Defines a URI template for memo resources used in tests. A template is a pattern, not a specific readable resource.

**Data flow**: It creates a raw resource-template record with the pattern `memo://codex/{slug}` and descriptive metadata. It wraps that record in the rmcp `ResourceTemplate` type and returns it.

**Call relations**: Called by `TestToolServer::new` to populate the template list returned by `TestToolServer::list_resource_templates`. It sits alongside the concrete memo resource to let clients test both resource discovery paths.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_text`  (lines 400–402)

```
fn memo_text() -> &'static str
```

**Purpose**: Returns the fixed text content of the sample memo resource. Keeping this in one helper makes the resource body easy to reuse and compare in tests.

**Data flow**: It takes no input and returns a static string constant. It does not allocate new content or change state.

**Call relations**: Used by `TestToolServer::read_resource` when the requested URI matches the known memo resource. It is the final source of the text sent back to the MCP client.


##### `parse_bind_addr`  (lines 405–411)

```
fn parse_bind_addr() -> Result<SocketAddr, Box<dyn std::error::Error>>
```

**Purpose**: Chooses the network address where the test server should listen. It lets tests override the default address through environment variables.

**Data flow**: It first looks for `MCP_STREAMABLE_HTTP_BIND_ADDR`, then `BIND_ADDR`, and finally falls back to `127.0.0.1:3920`. It parses the chosen string into a socket address and returns either that address or a parse error.

**Call relations**: Called by `main` before the server binds its TCP listener. Its result decides the address used for all later HTTP requests to this test server.

*Call graph*: called by 1 (main); 1 external calls (var).


##### `require_bearer`  (lines 413–430)

```
async fn require_bearer(
    State(expected): State<Arc<String>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
```

**Purpose**: Acts as an optional gatekeeper for bearer-token authentication tests. A bearer token is a value sent in the HTTP `Authorization` header to prove the caller is allowed in.

**Data flow**: It receives the expected `Bearer ...` string, the incoming HTTP request, and the next step in the router. If the path is an OAuth discovery path, it lets the request through. Otherwise it compares the request's `Authorization` header to the expected value; a match continues to the next handler, and a mismatch returns `401 Unauthorized`.

**Call relations**: Installed by `main` only when `MCP_EXPECT_BEARER` is set. When active, it runs before normal route handling, protecting `/mcp` and the control endpoints while deliberately leaving the discovery metadata endpoint reachable.

*Call graph*: 3 external calls (run, headers, uri).


##### `arm_session_post_failure`  (lines 432–437)

```
async fn arm_session_post_failure(
    State(state): State<PostFailureState>,
    Json(request): Json<ArmSessionPostFailureRequest>,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Control endpoint for telling the test server to fail future normal session POST requests. Tests use it to simulate server errors after a session already exists.

**Data flow**: It receives shared failure state and a JSON request describing the status code, number of failures, headers, content type, and body. It passes those details to `arm_post_failure` with the target set to normal session requests, then returns the status from that helper.

**Call relations**: Registered by `main` at the session failure control path. It is a thin route-specific wrapper around `arm_post_failure`; the actual forced failure is later applied by `fail_mcp_post_when_armed`.

*Call graph*: calls 1 internal fn (arm_post_failure).


##### `arm_initialize_post_failure`  (lines 439–444)

```
async fn arm_initialize_post_failure(
    State(state): State<PostFailureState>,
    Json(request): Json<ArmSessionPostFailureRequest>,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Control endpoint for telling the test server to fail future initialize POST requests. Tests use it to check what clients do when the first MCP handshake request fails.

**Data flow**: It receives the shared state and a JSON failure description. It forwards them to `arm_post_failure` with the target set to initialize requests, then returns success or bad request depending on validation.

**Call relations**: Registered by `main` at the initialize failure control path. It only records the plan; `fail_mcp_post_when_armed` later watches incoming `/mcp` POST requests and carries out that plan.

*Call graph*: calls 1 internal fn (arm_post_failure).


##### `arm_initialized_notification_post_failure`  (lines 446–451)

```
async fn arm_initialized_notification_post_failure(
    State(state): State<PostFailureState>,
    Json(request): Json<ArmSessionPostFailureRequest>,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Control endpoint for telling the test server to fail future `notifications/initialized` POST requests. This lets tests isolate a special post-handshake notification from other session traffic.

**Data flow**: It receives shared failure state plus a JSON request describing how the forced failure should look. It calls `arm_post_failure` with the initialized-notification target and returns that helper's result.

**Call relations**: Registered by `main` at the initialized-notification failure control path. It sets up state that `fail_mcp_post_when_armed` later checks against the MCP method name extracted by `request_mcp_method`.

*Call graph*: calls 1 internal fn (arm_post_failure).


##### `arm_post_failure`  (lines 453–482)

```
async fn arm_post_failure(
    state: PostFailureState,
    request: ArmSessionPostFailureRequest,
    target: ArmedFailureTarget,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Stores, updates, or clears the shared instruction for a future forced POST failure. This is the common validation and setup logic behind all three failure-control endpoints.

**Data flow**: It receives the shared state, a JSON-like request object, and the target kind. It validates the HTTP status code and optional header values. If `remaining` is zero, it clears any armed failure; otherwise it stores a new `ArmedFailure` with the target, status, remaining count, optional authentication challenges, optional content type, and optional body. It returns `204 No Content` on success or `400 Bad Request` for invalid input.

**Call relations**: Called by `arm_session_post_failure`, `arm_initialize_post_failure`, and `arm_initialized_notification_post_failure`. The state it writes is later read and consumed by `fail_mcp_post_when_armed` as matching `/mcp` requests arrive.

*Call graph*: called by 3 (arm_initialize_post_failure, arm_initialized_notification_post_failure, arm_session_post_failure); 1 external calls (from_u16).


##### `fail_mcp_post_when_armed`  (lines 484–545)

```
async fn fail_mcp_post_when_armed(
    State(state): State<PostFailureState>,
    request: Request<Body>,
    next: Next,
) -> Response
```

**Purpose**: Intercepts `/mcp` POST requests and, when a matching forced failure has been armed, returns that fake failure instead of letting the real MCP service handle the request. This is the main fault-injection mechanism for integration tests.

**Data flow**: It receives shared failure state, an incoming HTTP request, and the next router step. Non-POST or non-`/mcp` requests pass through unchanged. For MCP POSTs, it reads the body up to a fixed size limit, checks whether the request has an MCP session id header, extracts the JSON-RPC method name if present, and compares those facts to the armed target. If there is a match, it decrements the remaining failure count, builds a response with the configured status, headers, content type, and body, and may clear the armed failure. If there is no match, it rebuilds the request with the same body bytes and passes it onward.

**Call relations**: Installed by `main` as middleware around the router. It reads the state written by `arm_post_failure`, calls `request_mcp_method` to distinguish special initialized notifications from other session traffic, and otherwise hands requests off to the underlying streamable HTTP service through the router's next step.

*Call graph*: calls 1 internal fn (request_mcp_method); 8 external calls (run, to_bytes, from_parts, into_parts, method, uri, new, from).


##### `request_mcp_method`  (lines 547–553)

```
fn request_mcp_method(body: &[u8]) -> Option<String>
```

**Purpose**: Pulls the MCP method name out of a JSON request body, if one is present. This helps the failure middleware tell different kinds of MCP POST messages apart.

**Data flow**: It receives raw request-body bytes. It tries to parse them as JSON, looks for a top-level `method` field, checks that the field is a string, and returns that string. If parsing fails or the field is missing or not a string, it returns nothing.

**Call relations**: Called only by `fail_mcp_post_when_armed`. Its result is used to decide whether an armed initialized-notification failure or a normal session failure should be triggered.

*Call graph*: called by 1 (fail_mcp_post_when_armed).


### `mcp-server/src/main.rs`

`entrypoint` · `startup`

This file is the front door of the MCP server executable. When a user starts this program, Rust calls `main`, and this file’s job is to do just enough setup to launch the server correctly.

The important detail is that this project can change behavior based on the name used to start the program. That name is often called `argv[0]`, or “arg zero”: the command path the operating system used to run the program. Think of it like a building with several doors that all lead inside, but each door may send you to a different reception desk. The helper `arg0_dispatch_or_else` checks that startup name and either routes to a special behavior or runs the normal MCP server path.

For the normal path, the file calls `run_main` from the MCP server library. It gives it the discovered startup paths, an empty set of command-line configuration overrides, and tells it not to require strict configuration checking. After that, the deeper server code takes over. Without this file, the compiled MCP server would not have a clear entry point, and the shared server logic would never be started as a standalone command.

#### Function details

##### `main`  (lines 6–16)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: `main` is the first project code that runs when the MCP server executable starts. It chooses the correct startup route based on how the program was invoked, then launches the normal MCP server runner when no special route takes over.

**Data flow**: It starts with no direct input from other project code, but the operating system has already provided the program name and command-line context. `main` passes control to `arg0_dispatch_or_else`, giving it an async fallback task. If that fallback is used, it receives the resolved startup paths, creates default command-line configuration overrides, calls the MCP server’s main runner, waits for it to finish, and returns success or an error.

**Call relations**: `main` is called by the runtime when the executable starts. Its first handoff is to `arg0_dispatch_or_else`, which decides whether the startup name means some alternate behavior should run. If not, the fallback closure continues into the server’s normal `run_main` path, where the real MCP server setup and execution happen.

*Call graph*: 1 external calls (arg0_dispatch_or_else).


### `responses-api-proxy/src/main.rs`

`entrypoint` · `startup`

This file is the front door of the Responses API proxy executable. It does very little by design: it starts the program safely, turns the user’s command-line text into structured settings, and then passes those settings to the main proxy code elsewhere.

Before the normal `main` function runs, `pre_main` asks the shared process-hardening code to apply safety protections. Process hardening means tightening how the program runs so it is less exposed to certain mistakes or attacks. You can think of it like locking the doors and checking the alarms before opening a shop.

Then `main` uses `clap`, a command-line parsing library, to read the arguments the user supplied when starting the program. Those arguments are converted into a `ResponsesApiProxyArgs` value, which is easier for the rest of the code to work with than raw text. Finally, this file calls `codex_responses_api_proxy::run_main(args)`, which contains the real application startup and proxy behavior.

Without this file, the proxy would have no executable entry point: no early hardening step, no command-line parsing, and no handoff into the actual proxy implementation.

#### Function details

##### `pre_main`  (lines 5–7)

```
fn pre_main()
```

**Purpose**: This function runs before the normal program entry point and applies process-level safety protections. It exists so the executable is hardened as early as possible, before regular startup code begins.

**Data flow**: It takes no input from the caller. It calls the shared hardening routine, which changes the running process’s safety settings, and then returns without producing a value.

**Call relations**: The special constructor attribute makes this function run automatically before `main`. Its only handoff is to `pre_main_hardening`, which performs the actual safety setup.

*Call graph*: 1 external calls (pre_main_hardening).


##### `main`  (lines 9–12)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: This is the normal entry point of the proxy executable. It reads the command-line options and starts the main Responses API proxy logic with those options.

**Data flow**: It begins with the raw command-line arguments supplied by the operating system. `parse` converts them into a structured `ResponsesApiProxyArgs` value, then `main` passes that value to `run_main`; the final result is either successful completion or an error reported through `anyhow::Result`.

**Call relations**: After the early `pre_main` safety step has already run, `main` performs the user-facing startup work. It relies on `parse` to understand the command line, then hands control to `run_main`, where the actual proxy application continues.

*Call graph*: 2 external calls (parse, run_main).


### `codex-client/src/bin/custom_ca_probe.rs`

`entrypoint` · `integration test subprocess`

This file is a helper program used by integration tests, not a normal user-facing command. Its job is to prove that the shared Codex HTTP client can be built with custom CA certificates. A CA certificate is a certificate used to decide which HTTPS servers should be trusted. The tricky part is that the relevant settings, such as `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE`, come from environment variables, and environment variables belong to the whole process. In parallel tests, changing them inside one test process would be like changing a building-wide thermostat while other rooms are also testing heating behavior. This probe avoids that by running as its own process.

When started, the program creates a small asynchronous runtime, then runs `run_probe`. The probe reads optional environment variables that tell it whether to force TLS 1.3, whether to use an HTTPS proxy, and whether to send a real HTTPS request to a test server. It builds a `reqwest` HTTP client through Codex’s shared custom-CA construction path, so the test exercises the real client-building code. If a target URL is provided, it sends a simple form-style POST request and expects a successful response with body `ok`. On success it prints `ok`; on any setup or request failure it prints a useful error and exits with a failing status.

#### Function details

##### `main`  (lines 26–45)

```
fn main()
```

**Purpose**: This is the program’s starting point. It creates the small async runtime needed to run network code, runs the probe, and turns the result into a clear process outcome: print `ok` on success or print an error and exit with failure.

**Data flow**: It starts with no direct input beyond the process environment. It tries to create a Tokio runtime, which is the engine that can drive asynchronous work such as HTTP requests. If runtime creation fails, it prints an error and exits. Otherwise it runs `run_probe`; a successful result becomes `ok` on standard output, and an error becomes a message on standard error plus exit code 1.

**Call relations**: The operating system calls `main` when this helper binary starts. `main` then hands control to `run_probe`, because that function contains the actual certificate and request test flow. It uses standard printing and process-exit functions to communicate the result back to the integration test that launched it.

*Call graph*: calls 1 internal fn (run_probe); 4 external calls (eprintln!, println!, exit, new_current_thread).


##### `run_probe`  (lines 47–63)

```
async fn run_probe() -> Result<(), String>
```

**Purpose**: This function reads the probe’s environment settings, prepares an HTTP client builder, builds the Codex client with custom CA behavior, and optionally performs a real HTTPS request. It is the main script for the probe’s test scenario.

**Data flow**: It reads three environment variables: one for an optional proxy URL, one for an optional target URL, and one flag that asks for TLS 1.3. It starts with a fresh `reqwest` client builder, adds a short timeout if it will make a request, and raises the minimum TLS version if requested. It then passes the builder and optional proxy setting to `build_probe_client`. If a target URL was provided, it sends that URL and the finished client to `post_probe_request`. It returns success if client creation and the optional request both work, or a readable error string if anything fails.

**Call relations**: `main` calls this after setting up the async runtime. `run_probe` calls `build_probe_client` to make sure the client is created through the same Codex custom-CA paths used elsewhere. If the test wants a live HTTPS check, it then calls `post_probe_request` to verify the constructed client can actually complete a request.

*Call graph*: calls 2 internal fn (build_probe_client, post_probe_request); called by 1 (main); 4 external calls (from_secs, builder, var, var_os).


##### `build_probe_client`  (lines 65–78)

```
fn build_probe_client(
    builder: reqwest::ClientBuilder,
    proxy_url: Option<&str>,
) -> Result<reqwest::Client, String>
```

**Purpose**: This function turns a prepared HTTP client builder into a real `reqwest` client while preserving the custom CA behavior under test. It also supports a special proxy path for tests that need to route HTTPS through a proxy.

**Data flow**: It receives a `reqwest::ClientBuilder`, which is a not-yet-built set of HTTP client options, and an optional proxy URL. If a proxy URL is present, it first converts that string into an HTTPS proxy setting, attaches it to the builder, and then calls Codex’s custom-CA client builder. If there is no proxy, it calls the Codex subprocess-test client builder directly. In both cases, the output is either a finished HTTP client or a plain error string explaining what went wrong.

**Call relations**: `run_probe` calls this after reading the environment and preparing basic client options. This function is the bridge between the test probe and the real Codex client-construction helpers: it delegates to `build_reqwest_client_with_custom_ca` when a proxy is involved, or to `build_reqwest_client_for_subprocess_tests` for the normal subprocess test path.

*Call graph*: called by 1 (run_probe); 4 external calls (proxy, build_reqwest_client_for_subprocess_tests, build_reqwest_client_with_custom_ca, https).


##### `post_probe_request`  (lines 80–100)

```
async fn post_probe_request(client: &reqwest::Client, url: &str) -> Result<(), String>
```

**Purpose**: This function performs the optional live HTTPS check. It sends a small POST request through the constructed client and verifies that the test server replies exactly as expected.

**Data flow**: It receives a finished HTTP client and a URL. It sends a POST request to that URL with a form content type and a small fake authorization-code body. It waits for the response, reads the status code and response body, and then checks two things: the status must be successful, and the body must be exactly `ok`. If both checks pass it returns success; otherwise it returns an error string that includes the unexpected status or body.

**Call relations**: `run_probe` calls this only when the environment provides a target URL. It is the final proof step: after `build_probe_client` constructs the client with the desired certificate settings, this function uses that client against a test endpoint to confirm the setup works in practice.

*Call graph*: called by 1 (run_probe); 2 external calls (post, format!).


### Execution policy and exec-server tools
These binaries expose policy checking and remote execution helper processes, including test-only wrappers for alternate environments.

### `exec-server/src/fs_helper_main.rs`

`entrypoint` · `startup and one-shot request handling`

This helper acts like a tiny worker process for filesystem operations that need to be done outside the main program’s normal flow. Think of it as a clerk who receives one written instruction, does that one job, writes back the result, and then exits. Without this file, there would be no standalone program that can accept a filesystem helper request over standard input and return a clean machine-readable answer.

The file starts a Tokio runtime, which is the engine Rust uses here to run asynchronous input and output without blocking the whole program unnecessarily. It then reads all bytes sent to standard input. Those bytes are expected to be JSON describing an FsHelperRequest. After decoding the request, it passes the real work to run_direct_request, which belongs to the filesystem helper module. That function returns either a successful payload or an error.

This file does not decide filesystem policy itself. Its job is the wrapper: translate incoming JSON into an internal request, call the worker, translate the result into an FsHelperResponse, and print JSON back out followed by a newline. If anything goes wrong while starting the runtime or running the request, it reports a clear error message to standard error and exits with a non-zero status code so the caller can tell the helper failed.

#### Function details

##### `main`  (lines 11–29)

```
fn main() -> !
```

**Purpose**: This is the program’s starting point. It creates the asynchronous runtime needed by the helper, runs the main helper task, and turns success or failure into a process exit code.

**Data flow**: It starts with no direct input except the process environment and whatever will later be read from standard input. It tries to build a single-threaded Tokio runtime, uses that runtime to run run_main, prints an error message if setup or execution fails, and finally exits the process with code 0 for success or 1 for failure.

**Call relations**: This function is the outer shell around the helper. It calls run_main once the runtime exists, and it is responsible for reporting failures with eprintln! and ending the process with exit.

*Call graph*: calls 1 internal fn (run_main); 3 external calls (eprintln!, exit, new_current_thread).


##### `run_main`  (lines 31–45)

```
async fn run_main() -> Result<(), Box<dyn Error + Send + Sync>>
```

**Purpose**: This function performs the helper’s actual one-request exchange. It reads a JSON request from standard input, runs the filesystem helper operation, and writes a JSON response to standard output.

**Data flow**: It takes no ordinary function arguments. It reads all incoming bytes from stdin, decodes them into an FsHelperRequest, gives that request to run_direct_request, wraps the result as either FsHelperResponse::Ok or FsHelperResponse::Error, then serializes that response to JSON and writes it to stdout with a trailing newline. If reading, decoding, running, or writing fails, it returns an error to its caller.

**Call relations**: main calls this after setting up the async runtime. run_main then hands the decoded request to run_direct_request for the real filesystem work, and it returns either success or an error back to main so main can choose the final exit code.

*Call graph*: calls 1 internal fn (run_direct_request); called by 1 (main); 7 external calls (new, Error, Ok, stdin, stdout, from_slice, to_string).


### `exec-server/src/server.rs`

`entrypoint` · `startup and main loop`

This file acts like the reception desk for the exec server module. The exec server itself is split into smaller parts: code for talking over the network, processing connections, tracking sessions, working with files, and launching processes. Rather than making outside code know about all of those internal rooms, this file presents a small public surface.

It declares the submodules that make up the server, then re-exports a few important names so other parts of the project can use them without reaching into the server’s internal layout. For example, it exposes the default listening address and the error type used when a listen URL cannot be understood.

The main action is `run_main`. It receives a listen URL, which tells the server where to wait for incoming clients, and runtime paths, which tell it where to store or find files it needs while running. It does not do the networking work itself. Instead, it hands those inputs to the transport layer, which is the part responsible for opening the listening connection and running the server loop. Without this file, callers would need to know which lower-level transport function to call and how the server pieces are organized internally.

#### Function details

##### `run_main`  (lines 16–21)

```
async fn run_main(
    listen_url: &str,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: `run_main` starts the exec server using a listening address and a set of runtime file paths. It is the simple entry function callers use when they want the server to begin accepting work.

**Data flow**: It takes in `listen_url`, a text address such as where to bind or connect for incoming requests, and `runtime_paths`, the locations the server should use while running. It passes both straight to the transport layer. The result is either successful completion or an error that explains why the server could not run.

**Call relations**: When outside code wants to start the exec server, it calls `run_main`. This function immediately hands control to `run_transport`, because the transport layer knows how to listen for connections and drive the server’s communication loop.

*Call graph*: calls 1 internal fn (run_transport).


### `exec-server/testing/windows_exec_server.rs`

`entrypoint` · `test startup and exec-server run`

This file is a minimal wrapper around the real exec server. Think of it like a small test key that starts only the part of the machine the test needs, instead of powering up the whole factory. The comments explain the reason: the full Codex binary is not yet easy to cross-build for Windows in the Bazel build setup, and tests run faster when they link only the exec-server code.

When the program starts, it asks the operating system for the path to its own executable file. Because this fixture is always built as a Windows executable, it does not need a separate Linux sandbox helper program. It then packages that information into `ExecServerRuntimePaths`, which is the object the exec server uses to know where its runtime pieces live.

Finally, it starts the exec server by calling `codex_exec_server::run_main` with a WebSocket address of `ws://127.0.0.1:0`. `127.0.0.1` means it listens only on the local machine, and port `0` means the operating system chooses an available port. Without this file, the Windows exec-server tests would have to depend on a larger and less portable binary, making the cross-platform test setup slower and more fragile.

#### Function details

##### `main`  (lines 11–18)

```
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Starts the Windows exec-server test fixture. It prepares the small amount of runtime path information the server needs, then launches the real exec-server loop on a local WebSocket address.

**Data flow**: It begins with no user input. It reads the path of the currently running executable from the operating system, turns that into `ExecServerRuntimePaths` while leaving out the Linux sandbox path, then passes those paths plus the local WebSocket address into the exec server. If setup or startup fails, the error is returned; otherwise the server runs until its normal shutdown path completes.

**Call relations**: This is the program entry point for the fixture. It first calls `current_exe` to discover where the Windows test executable is located, then calls `new` to build the runtime path bundle, and finally hands control to `run_main`, which is the real exec-server startup routine.

*Call graph*: calls 1 internal fn (new); 2 external calls (run_main, current_exe).


### `exec-server/testing/wine_remote_test_runner.rs`

`entrypoint` · `test startup and execution`

This program sits between Bazel, the build/test tool, and the real integration test binary. Bazel tells it which test binary to run through an environment variable. The runner then decides whether it is only being asked to list tests, or whether it should actually run them.

Listing tests is treated specially. When Rust’s test harness is asked for a terse list of tests, this runner simply calls the real test binary directly. That avoids starting the Wine execution server just to print names.

For a real test run, the file creates a scoped Wine execution server using `WineExecServer`. You can think of this like setting up a temporary remote workshop before sending work into it. Inside that scope, it launches the real test binary with environment variables that tell the tests: “you are running in the wine-exec environment” and “here is the server URL to use.” It also removes older environment variables that could point tests at a different remote setup, preventing confusing mixed configurations.

The child test process has no standard input, but its output and errors are passed straight through to the terminal. If listing or testing exits with a failure code, this runner reports that as an error so the surrounding test system sees the failure.

#### Function details

##### `main`  (lines 18–54)

```
async fn main() -> Result<()>
```

**Purpose**: This is the program’s starting point. It finds the real test binary, decides whether to list tests directly or run them through a Wine execution server, and reports failure if the child process fails.

**Data flow**: It reads the path to the test binary from the `CODEX_WINE_EXEC_TEST_BINARY` environment variable and collects any command-line arguments passed to this runner. If those arguments mean “list tests in terse format,” it runs the test binary directly with those arguments and returns success only if that process succeeds. Otherwise, it starts a scoped Wine execution server, builds a command for the test binary, adds environment variables pointing at that server, removes older remote-environment variables, forwards the original arguments, connects output to the terminal, and waits for the test binary to finish. The result is either success or an error describing what failed.

**Call relations**: When the runner starts, `main` calls `is_terse_list_request` to choose the lightweight path for test listing. For normal runs it relies on external library pieces to read environment variables, create commands, start the Wine execution server scope, and check exit statuses. It hands the server URL created by `WineExecServer` into the child test process through an environment variable so the tests know where to send remote execution requests.

*Call graph*: calls 1 internal fn (is_terse_list_request); 5 external calls (from, ensure!, new, args_os, var_os).


##### `is_terse_list_request`  (lines 56–62)

```
fn is_terse_list_request(args: &[OsString]) -> bool
```

**Purpose**: This helper answers one narrow question: are the forwarded command-line arguments exactly the Rust test-harness request to list tests in terse format? It exists so `main` can avoid starting the Wine server when only a test list is needed.

**Data flow**: It receives the forwarded arguments as operating-system strings, which are strings kept in a platform-safe form. It compares them, in order, with `--list`, `--format`, and `terse`. It returns `true` only for that exact three-argument sequence; every other argument list returns `false`.

**Call relations**: `main` calls this before doing any expensive test setup. If it returns `true`, `main` runs the real test binary directly for listing. If it returns `false`, `main` continues into the full Wine execution server setup and test run.

*Call graph*: called by 1 (main); 2 external calls (new, iter).


### `execpolicy-legacy/src/main.rs`

`entrypoint` · `command invocation`

This file turns the execution-policy library into a small command-line tool. Its job is to answer a practical question: “Is this command safe or allowed to run?” Without this file, the policy-checking logic would exist as a library, but users and scripts would not have a simple executable they could call.

The tool accepts either a normal command line, like a program name followed by its arguments, or a JSON-encoded command with a `program` and `args` field. It then loads a policy file if one was provided, or falls back to the built-in default policy. A policy is a set of rules that describes which commands are safe, which are forbidden, and which are only acceptable under certain conditions.

After building an `ExecCall` from the input, it asks the policy to check it. The answer is converted into an `Output` value and printed as JSON. This is important because other programs can reliably parse the result instead of scraping human text. The tool also uses different exit codes when `--require-safe` is set, so automation can distinguish “definitely forbidden,” “not verified,” and “matched but may write files.” In everyday terms, this file is like the reception desk for a secure building: it reads the visitor’s request, checks the rulebook, gives a clear written verdict, and signals whether entry should stop.

#### Function details

##### `main`  (lines 62–95)

```
fn main() -> Result<()>
```

**Purpose**: This is the program’s starting point. It reads command-line options, loads the right policy, turns the requested command into a standard internal shape, asks for a safety verdict, prints that verdict as JSON, and exits with the right status code.

**Data flow**: It starts with raw command-line input from the user. It reads an optional policy file path, or uses the default policy if none is given. It converts either plain command arguments or a JSON command into an `ExecArg`, passes that to `check_command`, turns the returned `Output` into JSON text, prints it, and ends the process with the chosen exit code. If the user gives no command for the plain `check` mode, it prints an error message and exits with failure.

**Call relations**: This function coordinates the whole run. It initializes logging, calls the policy parser or default policy loader, then hands the final policy and command to `check_command`. After `check_command` returns the verdict and exit code, `main` is responsible for presenting the result to the outside world.

*Call graph*: calls 3 internal fn (check_command, get_default_policy, new); 7 external calls (parse, init, eprintln!, println!, to_string, read_to_string, exit).


##### `check_command`  (lines 97–125)

```
fn check_command(
    policy: &Policy,
    ExecArg { program, args }: ExecArg,
    check: bool,
) -> (Output, i32)
```

**Purpose**: This function applies a loaded policy to one command and turns the result into the public JSON-friendly answer. It also decides which exit code should be used, especially when the caller asked to require a definitely safe command.

**Data flow**: It receives a policy, an `ExecArg` containing a program name and arguments, and a boolean that says whether strict safety is required. It wraps the program and arguments into an `ExecCall`, asks the policy to check it, and then translates the policy result into one of four outcomes: safe, matched but may write files, forbidden, or unverified. It returns both that outcome and the process exit code that should accompany it.

**Call relations**: `main` calls this after input parsing and policy loading are complete. `check_command` delegates the real rule evaluation to the policy’s `check` method, then packages the result in the format that `main` prints for users or automation.

*Call graph*: called by 1 (main); 1 external calls (check).


##### `deserialize_from_json`  (lines 153–161)

```
fn deserialize_from_json(deserializer: D) -> Result<ExecArg, D::Error>
```

**Purpose**: This helper lets the `check-json` command accept an execution request as a JSON string. It converts that string into an `ExecArg` with a program and argument list.

**Data flow**: It receives data from the command-line deserializer as a string. It parses that string as JSON and expects it to describe an `ExecArg`. If parsing succeeds, it returns the decoded command. If parsing fails, it turns the JSON parsing problem into a clear deserialization error that can be reported to the caller.

**Call relations**: This function is used automatically by the command-line parsing setup for the `check-json` subcommand. It runs before `main` receives the final parsed `Args`, so `main` can work with a normal `ExecArg` instead of raw JSON text.

*Call graph*: 2 external calls (deserialize, from_str).


##### `ExecArg::from_str`  (lines 166–168)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: This function defines how to build an `ExecArg` from a text string. It is useful anywhere Rust code wants to parse a JSON command string directly into the same command shape used by this tool.

**Data flow**: It receives a string, treats it as JSON, and tries to decode it into an `ExecArg`. On success, it returns the program-and-arguments structure. On failure, it returns an error explaining that the string could not be parsed into the expected form.

**Call relations**: This is an implementation of Rust’s standard `FromStr` pattern, which means other parsing code can ask for an `ExecArg` from text in a familiar way. Internally it relies on JSON parsing, matching the same data format accepted by the `check-json` path.

*Call graph*: 1 external calls (from_str).


### `execpolicy/src/main.rs`

`entrypoint` · `startup and command invocation`

This is the small front door for the exec policy checker. Its job is not to decide policy rules itself, but to turn what the user typed in the terminal into the right action inside the program. Without this file, there would be no runnable command-line tool for people or scripts to call.

The file defines a command-line interface, often called a CLI, which simply means “the shape of commands a user can type.” Here there is one subcommand: `Check`. That subcommand carries an `ExecPolicyCheckCommand`, which comes from the main `codex_execpolicy` library and contains the real checking behavior.

When the program starts, `main` asks `clap` to parse the command-line text. `clap` is a helper library that reads flags, subcommands, and arguments and turns them into Rust values. This is like a receptionist reading a form and routing it to the right department. If the user chose `Check`, this file passes control to the check command’s `run` method. Any error is returned through `anyhow::Result`, a general-purpose error wrapper that lets the program report failures cleanly.

#### Function details

##### `main`  (lines 13–18)

```
fn main() -> Result<()>
```

**Purpose**: This is the first project code that runs when someone starts the `codex-execpolicy` program. It reads the user’s command-line request and sends it to the policy-checking command.

**Data flow**: The inputs are the arguments the user typed in the terminal. `main` asks `clap` to turn those raw words into a `Cli` value, then matches on that value. If the user requested `Check`, it passes the parsed check command onward and returns either success or an error.

**Call relations**: At program launch, `main` calls the external parsing machinery to understand the command line. Once parsing has identified the `Check` command, `main` hands the work to the command object from the exec policy library, which performs the actual evaluation.

*Call graph*: 1 external calls (parse).


### `execpolicy/src/execpolicycheck.rs`

`orchestration` · `command execution`

This file exists so a person or script can ask a simple question: “If I tried to run this command, what would the exec policy say about it?” Without it, the policy-matching code might still exist, but there would be no convenient command-line tool for loading policy files, testing a command, and getting a machine-readable answer.

The main type, `ExecPolicyCheckCommand`, describes the command-line arguments. The user must provide one or more rule files and the command tokens to check. Optional flags control whether the JSON should be nicely spaced for humans, and whether absolute program paths should be matched against rules that name host executables.

The flow is straightforward. First, `load_policies` opens each policy file from disk and feeds its text into a `PolicyParser`. Think of this like gathering several instruction sheets into one rulebook. Then `ExecPolicyCheckCommand::run` asks the built `Policy` which rules match the requested command, using the chosen matching options. Finally, `format_matches_json` wraps the matched rules and the overall decision into a JSON object and turns it into text. The command prints that JSON to standard output, so other tools can read it reliably.

#### Function details

##### `ExecPolicyCheckCommand::run`  (lines 43–57)

```
fn run(&self) -> Result<()>
```

**Purpose**: This is the main action for the `execpolicycheck` command. It loads the requested policy files, checks the user-provided command against them, turns the result into JSON, and prints it.

**Data flow**: It starts with the parsed command-line options stored in `self`: policy file paths, the command tokens, and output/matching flags. It passes the rule paths into `load_policies`, then sends the command and match options into the built policy. The matched rules are passed to `format_matches_json`, and the resulting JSON string is printed. If reading, parsing, or JSON formatting fails, the error is returned instead of printing a successful result.

**Call relations**: This function is called by `run_execpolicycheck` when the user has chosen this subcommand. It delegates file loading to `load_policies`, delegates JSON creation to `format_matches_json`, and uses printing only at the end, after the policy check has succeeded.

*Call graph*: calls 2 internal fn (format_matches_json, load_policies); called by 1 (run_execpolicycheck); 1 external calls (println!).


##### `format_matches_json`  (lines 60–71)

```
fn format_matches_json(matched_rules: &[RuleMatch], pretty: bool) -> Result<String>
```

**Purpose**: This function turns policy match results into the JSON text shown to the user or calling script. It includes both the list of matching rules and the strongest final decision, if any rule produced one.

**Data flow**: It receives a slice of `RuleMatch` values and a `pretty` flag. It builds a small output object containing those matches and a decision computed by looking through the matches and taking the maximum decision value. If `pretty` is true, it creates indented JSON that is easier for people to read; otherwise it creates compact JSON that is better for scripts and logs. The output is a JSON string, or an error if serialization fails.

**Call relations**: This function is called by `ExecPolicyCheckCommand::run` after the policy engine has already found matching rules. It does not read files or perform matching itself; its job is to package the result into a stable external format.

*Call graph*: called by 1 (run); 3 external calls (iter, to_string, to_string_pretty).


##### `load_policies`  (lines 73–86)

```
fn load_policies(policy_paths: &[PathBuf]) -> Result<Policy>
```

**Purpose**: This function reads one or more policy files from disk and combines them into a single `Policy` that can be used for matching commands. It gives helpful error context if a file cannot be read or parsed.

**Data flow**: It receives a list of file paths. For each path, it reads the file text, uses the path as an identifier for error messages and parser bookkeeping, and feeds the text into a `PolicyParser`. After all files have been parsed, it asks the parser to build the final `Policy` and returns it. If any file is missing, unreadable, or invalid, the function stops and returns an error that names the problem file.

**Call relations**: This function is called by `ExecPolicyCheckCommand::run` at the start of command execution. It prepares the rulebook that the rest of the check depends on, so matching cannot happen until this has successfully finished.

*Call graph*: calls 1 internal fn (new); called by 1 (run); 1 external calls (read_to_string).


### `state/src/bin/logs_client.rs`

`entrypoint` · `startup and continuous log tailing`

This file is a small terminal program for reading Codex logs from the state database. Without it, a developer or operator would have to inspect the SQLite database directly, which is slow and unfriendly when trying to understand what the system is doing right now.

The program starts by reading command-line options: where the Codex home folder or log database is, which log level to show, optional time bounds, module or file filters, thread filters, and whether the output should be compact. It turns those options into a `LogFilter`, which is the program’s internal checklist for deciding what log rows are interesting.

It then opens the Codex state runtime, asks for a recent “backfill” of matching logs, prints those oldest-to-newest, and remembers the largest log row id it has seen. After that it enters a loop. Every poll interval, it asks the database for matching rows with ids greater than the last seen id, prints them, updates that id, and sleeps again.

The formatting code makes the output easier to scan. Timestamps are dimmed, levels are colored by severity, thread ids and targets are shown in full mode, and `apply_patch` tool output gets simple diff-style coloring: added lines green, removed lines red. The tests focus on log-level parsing rules so the command accepts only the intended level names.

#### Function details

##### `LogLevelThreshold::levels_upper`  (lines 93–102)

```
fn levels_upper(self) -> Vec<String>
```

**Purpose**: Turns a chosen minimum log level into the full set of levels that should be shown. For example, choosing `Warn` means both warnings and errors are included, because errors are more severe than warnings.

**Data flow**: It starts with one threshold value such as `Info` or `Error`. It chooses the matching list of uppercase level names, converts each name into an owned string, and returns that list for use in database queries.

**Call relations**: When `build_filter` prepares the user’s command-line choices, it uses this method to translate the friendly level threshold into exact level strings the log query can match.


##### `main`  (lines 106–131)

```
async fn main() -> anyhow::Result<()>
```

**Purpose**: Runs the `codex-state-logs` command from start to finish. It reads the user’s options, connects to the state runtime, prints recent matching logs, then keeps watching for new ones.

**Data flow**: It receives command-line arguments from the operating system, resolves the database location, builds a filter, initializes the state runtime, prints an initial batch of rows, and then repeatedly fetches newer rows. Its visible output is colored log text printed to the terminal, and it keeps internal track of the last log id it has printed.

**Call relations**: This is the top-level driver. It calls `resolve_db_path` and `build_filter` during startup, uses `print_backfill` for the initial display, falls back to `fetch_max_id` when there was no backfill, and then calls `fetch_new_rows` inside the polling loop.

*Call graph*: calls 6 internal fn (build_filter, fetch_max_id, fetch_new_rows, print_backfill, resolve_db_path, init); 4 external calls (from_millis, parse, println!, sleep).


##### `resolve_db_path`  (lines 133–140)

```
fn resolve_db_path(args: &Args) -> anyhow::Result<PathBuf>
```

**Purpose**: Decides which logs database path the command should use. A direct `--db` path wins; otherwise it builds the standard logs database path under the Codex home folder.

**Data flow**: It reads the parsed command-line arguments. If a database path was provided, it returns that path unchanged. If not, it finds the Codex home folder from the arguments or from the default location, then asks the Codex state library for the logs database path inside it.

**Call relations**: Called by `main` at startup before the runtime is initialized. It relies on `default_codex_home` indirectly through the fallback expression and on the external `logs_db_path` helper to follow the project’s normal database layout.

*Call graph*: called by 1 (main); 1 external calls (logs_db_path).


##### `default_codex_home`  (lines 142–147)

```
fn default_codex_home() -> PathBuf
```

**Purpose**: Provides the fallback Codex home directory when the user does not specify one. It normally points to `~/.codex`.

**Data flow**: It asks the system for the current user’s home directory. If that exists, it appends `.codex`; if the home directory cannot be found, it returns a relative `.codex` path instead.

**Call relations**: Used as the fallback path source while resolving the database location. It keeps the command aligned with Codex’s usual home-directory convention.

*Call graph*: 2 external calls (from, home_dir).


##### `build_filter`  (lines 149–195)

```
fn build_filter(args: &Args) -> anyhow::Result<LogFilter>
```

**Purpose**: Converts raw command-line options into a clean `LogFilter` that the database-query code can use. It also validates and parses time inputs.

**Data flow**: It reads level, time range, module filters, file filters, thread ids, search text, and the threadless flag from `Args`. It parses the optional `--from` and `--to` values into Unix seconds, removes empty repeated filter values, expands the level threshold into concrete levels, and returns a `LogFilter`.

**Call relations**: Called by `main` before any database reads happen. Its output is passed through `to_log_query` later by the fetch functions, so this is where user-friendly options become structured query criteria.

*Call graph*: called by 1 (main).


##### `parse_timestamp`  (lines 197–205)

```
fn parse_timestamp(value: &str) -> anyhow::Result<i64>
```

**Purpose**: Accepts a timestamp written either as Unix seconds or as an RFC3339 date-time string and turns it into Unix seconds. This lets users type either a simple number or a standard timestamp.

**Data flow**: It receives one string. First it tries to read it as a whole number of seconds. If that fails, it tries to parse it as an RFC3339 timestamp, such as `2025-01-01T12:00:00Z`, then returns that time as seconds since the Unix epoch.

**Call relations**: Used by `build_filter` for the `--from` and `--to` options. If parsing fails, the error is wrapped with context so the user knows which time option was bad.

*Call graph*: 1 external calls (parse_from_rfc3339).


##### `print_backfill`  (lines 207–226)

```
async fn print_backfill(
    runtime: &StateRuntime,
    filter: &LogFilter,
    backfill: usize,
    compact: bool,
) -> anyhow::Result<i64>
```

**Purpose**: Prints a starting batch of recent matching logs before live tailing begins. This gives the user context instead of showing only logs that arrive after the command starts.

**Data flow**: It receives the state runtime, a filter, a maximum number of rows, and the compact-output flag. If the requested count is zero, it returns `0`. Otherwise it fetches recent rows, reverses them into normal time order, prints each formatted row, and returns the largest row id it printed.

**Call relations**: Called by `main` once during startup. It delegates the database read to `fetch_backfill` and uses `format_row` before printing each row.

*Call graph*: calls 1 internal fn (fetch_backfill); called by 1 (main); 1 external calls (println!).


##### `fetch_backfill`  (lines 228–243)

```
async fn fetch_backfill(
    runtime: &StateRuntime,
    filter: &LogFilter,
    backfill: usize,
) -> anyhow::Result<Vec<LogRow>>
```

**Purpose**: Fetches the most recent matching log rows for the initial display. It asks for the rows in descending order so the database can efficiently return the latest entries.

**Data flow**: It receives the runtime, filter, and row limit. It converts those into a `LogQuery` with a limit, no `after_id`, and descending order, then asks the runtime for matching log rows. It returns those rows or an error with a clear message if the database read fails.

**Call relations**: Called only by `print_backfill`. It uses `to_log_query` to avoid duplicating query-building rules and then hands the query to the state runtime’s log-reading API.

*Call graph*: calls 1 internal fn (to_log_query); called by 1 (print_backfill); 1 external calls (query_logs).


##### `fetch_new_rows`  (lines 245–260)

```
async fn fetch_new_rows(
    runtime: &StateRuntime,
    filter: &LogFilter,
    last_id: i64,
) -> anyhow::Result<Vec<LogRow>>
```

**Purpose**: Fetches matching logs that were added after the last row already printed. This is the core of the live tailing behavior.

**Data flow**: It receives the runtime, filter, and last seen log id. It builds a query with `after_id` set to that id, no limit, and ascending order, then returns all newer matching rows from the runtime.

**Call relations**: Called repeatedly by `main` inside the polling loop. It uses `to_log_query` for consistent filtering and relies on the runtime’s `query_logs` method to read from the database.

*Call graph*: calls 1 internal fn (to_log_query); called by 1 (main); 1 external calls (query_logs).


##### `fetch_max_id`  (lines 262–270)

```
async fn fetch_max_id(runtime: &StateRuntime, filter: &LogFilter) -> anyhow::Result<i64>
```

**Purpose**: Finds the current highest matching log id without printing any rows. This prevents the command from dumping old logs when the user requested no backfill.

**Data flow**: It receives the runtime and filter, builds an unrestricted ascending query, and asks the runtime for the maximum log id matching that query. It returns that id so future polling starts after the current end of the log stream.

**Call relations**: Called by `main` when `print_backfill` returned `0`. It uses `to_log_query` and then delegates the actual database check to the runtime’s `max_log_id` method.

*Call graph*: calls 1 internal fn (to_log_query); called by 1 (main); 1 external calls (max_log_id).


##### `to_log_query`  (lines 272–291)

```
fn to_log_query(
    filter: &LogFilter,
    limit: Option<usize>,
    after_id: Option<i64>,
    descending: bool,
) -> LogQuery
```

**Purpose**: Translates this command’s internal `LogFilter` into the `LogQuery` type expected by the Codex state library. It adds paging and ordering details such as a row limit or “only after this id.”

**Data flow**: It receives a filter plus optional limit, optional `after_id`, and a descending-order flag. It copies the filter fields into a new `LogQuery`, attaches the extra query controls, and returns that query object.

**Call relations**: Shared by `fetch_backfill`, `fetch_new_rows`, and `fetch_max_id`. This keeps all three database reads using the same interpretation of filters.

*Call graph*: called by 3 (fetch_backfill, fetch_max_id, fetch_new_rows).


##### `format_row`  (lines 293–311)

```
fn format_row(row: &LogRow, compact: bool) -> String
```

**Purpose**: Turns one database log row into a human-readable, colored terminal line. It supports both full output and compact output.

**Data flow**: It receives a `LogRow` and the compact flag. It formats the timestamp, colors the level, fills in missing message or thread id values with safe defaults, applies message highlighting, and returns the final string to print.

**Call relations**: Used when rows are printed by `print_backfill` and by the live loop in `main`. It calls timestamp and level formatting helpers, and sends the message through `heuristic_formatting` for special treatment of patch output.

*Call graph*: calls 1 internal fn (heuristic_formatting); 3 external calls (format!, level, ts).


##### `heuristic_formatting`  (lines 313–319)

```
fn heuristic_formatting(message: &str) -> String
```

**Purpose**: Chooses how to color the body of a log message. Ordinary messages are made bold, while detected `apply_patch` messages get diff-style coloring.

**Data flow**: It receives a message string. It asks the matcher whether the message looks like an `apply_patch` tool call; if yes, it formats lines as added, removed, or normal patch text. If not, it returns the whole message in bold.

**Call relations**: Called by `format_row` while building the terminal output. It bridges the simple detector in `matcher::apply_patch` and the specialized formatter in `formatter::apply_patch`.

*Call graph*: called by 1 (format_row); 2 external calls (apply_patch, apply_patch).


##### `matcher::apply_patch`  (lines 322–324)

```
fn apply_patch(message: &str) -> bool
```

**Purpose**: Detects whether a log message appears to contain an `apply_patch` tool call. This is a lightweight check used only to decide whether special patch coloring should be applied.

**Data flow**: It receives the message text, searches for the literal phrase `ToolCall: apply_patch`, and returns true or false.

**Call relations**: Used by `heuristic_formatting`. If it returns true, the message is passed to the patch formatter; otherwise the message gets normal bold styling.


##### `formatter::apply_patch`  (lines 333–347)

```
fn apply_patch(message: &str) -> String
```

**Purpose**: Colors patch-like log text so additions and removals stand out. Added lines become green, removed lines become red, and other lines are bold.

**Data flow**: It receives a multi-line message. It walks through each line, checks whether the line starts with `+` or `-`, applies the matching color and bold style, then joins the lines back into one string.

**Call relations**: Called by `heuristic_formatting` after the matcher identifies an `apply_patch` message. It makes patch logs easier to read in the terminal.


##### `formatter::ts`  (lines 349–356)

```
fn ts(ts: i64, ts_nanos: i64, compact: bool) -> String
```

**Purpose**: Formats a stored timestamp for display. Compact mode shows only the time of day; full mode shows a full UTC timestamp with milliseconds.

**Data flow**: It receives seconds, nanoseconds, and the compact flag. It tries to build a UTC date-time from those pieces. If successful, it formats it according to the output mode; if not, it falls back to a raw seconds-and-nanoseconds string.

**Call relations**: Called by `format_row` for every printed log row. It hides the details of converting database timestamp fields into readable terminal text.

*Call graph*: 3 external calls (from_timestamp, format!, try_from).


##### `formatter::level`  (lines 358–376)

```
fn level(level: &str) -> String
```

**Purpose**: Formats and colors a log level so severity is easy to scan. Errors are red, warnings yellow, info green, debug blue, and trace magenta.

**Data flow**: It receives a level string, pads it to a fixed width for neat columns, compares it case-insensitively to known level names, applies the matching color and bold style, and returns the styled string.

**Call relations**: Called by `format_row` whenever a log row is printed. It gives the live log output the familiar visual cues people expect from terminal logs.

*Call graph*: 1 external calls (format!).


##### `tests::log_level_threshold_includes_more_severe_levels`  (lines 385–400)

```
fn log_level_threshold_includes_more_severe_levels()
```

**Purpose**: Checks that choosing a minimum log level includes that level and all more severe levels. This protects the expected threshold behavior.

**Data flow**: It calls `levels_upper` for selected thresholds and compares the returned lists with the expected uppercase level names. The test passes only if the expansion order and contents are correct.

**Call relations**: This test exercises `LogLevelThreshold::levels_upper` directly. It helps ensure filter construction will ask the database for the right severity levels.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::log_level_rejects_aliases_and_unknown_values`  (lines 403–407)

```
fn log_level_rejects_aliases_and_unknown_values()
```

**Purpose**: Checks that the command rejects unsupported log-level spellings such as `warning`, `err`, or comma-separated lists. This keeps the command-line interface strict and predictable.

**Data flow**: It tries to parse several invalid command lines. Each parse is expected to fail, and the assertions confirm that these aliases are not silently accepted.

**Call relations**: This test uses the command-line parser for `Args`. It protects the behavior configured by the `ValueEnum` log-level option.

*Call graph*: 1 external calls (assert!).


##### `tests::log_level_accepts_canonical_values_case_insensitively`  (lines 410–415)

```
fn log_level_accepts_canonical_values_case_insensitively()
```

**Purpose**: Checks that valid log-level names work even when written in a different case. For example, `WARN` should be accepted as the `Warn` threshold.

**Data flow**: It parses a sample command line containing `--level WARN`, unwraps the parsed arguments, and compares the resulting level value to the expected enum variant.

**Call relations**: This test exercises the `Args` parser and the case-insensitive level configuration. It complements the rejection test by confirming the intended accepted form.

*Call graph*: 2 external calls (try_parse_from, assert_eq!).


### Linux sandbox and shell wrappers
This group covers Linux-oriented process isolation entrypoints, the bubblewrap wrapper, and the Unix execve interception helper.

### `linux-sandbox/src/lib.rs`

`entrypoint` · `startup`

This file is a small but important front door. The sandbox helper is meant to run commands in a safer, more isolated Linux environment. On Linux, that involves tools and kernel features such as seccomp, which limits what system calls a process can make, and bubblewrap, which creates a restricted view of the filesystem. Those details live in the private modules listed at the top of the file.

The job of this file is not to implement the sandbox itself. Instead, it chooses what code is available for the current operating system and exposes a single public starting point. If the code is being built for Linux, it includes the Linux-specific modules and forwards `run_main` to the real Linux runner. If the code is being built anywhere else, it still provides a `run_main` symbol, but calling it immediately stops with a clear error message.

This matters because the sandbox depends on Linux-only features. Without this gate, the project might appear to support other systems and then fail later in confusing ways. This file makes the boundary explicit: Linux gets the sandbox entry point; non-Linux systems get an immediate, understandable failure.

#### Function details

##### `run_main`  (lines 29–31)

```
fn run_main() -> !
```

**Purpose**: This is the public start function for the sandbox helper. On Linux, it hands control to the real Linux sandbox runner; on non-Linux systems, it stops immediately because this helper cannot work there.

**Data flow**: The function takes no input and is not meant to return. On a Linux build, it passes execution into the Linux-specific runner, which takes over the process. On a non-Linux build, it creates an error by panicking with a message that the sandbox only supports Linux.

**Call relations**: When something outside this crate wants to start the sandbox helper, it calls `run_main`. This function then either delegates to the Linux implementation of `run_main` during a Linux run, or calls `panic!` right away on unsupported operating systems so the failure is clear and early.

*Call graph*: calls 1 internal fn (run_main); 1 external calls (panic!).


### `linux-sandbox/src/linux_run_main.rs`

`entrypoint` · `sandbox helper startup through command launch and cleanup`

This file is the front door for the Linux sandbox helper. Its job is to take a requested command, read the permission profile that says what files and network access are allowed, build the right sandbox around it, and then run the command inside that sandbox. Without it, the rest of the sandbox pieces would exist, but nothing would reliably connect them into a safe launch sequence.

The normal path uses bubblewrap, a Linux tool that starts a process with a restricted view of the filesystem, much like putting the command in a temporary room where only selected doors exist. After bubblewrap has built that room, this helper re-enters itself inside the room and applies seccomp, a Linux filter that limits system calls, meaning it restricts what kinds of kernel operations the process can ask for. A legacy Landlock path remains for compatibility; Landlock is another Linux permission system for filesystem access.

The file also contains careful low-level support code. It forwards Ctrl-C and termination signals to the bubblewrap child, probes whether mounting `/proc` is allowed in the current environment, cleans up temporary placeholder files or directories made for sandbox mounts, and watches for forbidden creation of protected workspace metadata. Much of the code is defensive because sandbox setup happens before the final command starts, where leaked files, missed signals, or bad cleanup could leave confusing or unsafe leftovers.

#### Function details

##### `run_main`  (lines 147–255)

```
fn run_main() -> !
```

**Purpose**: This is the main launch path for the Linux sandbox helper. It reads command-line options, turns the permission profile into runtime rules, chooses the sandbox method, applies restrictions in the correct order, and finally runs the requested command.

**Data flow**: It starts with CLI arguments such as the workspace path, permission profile JSON, network options, and command. It validates incompatible modes, resolves filesystem and network policies, possibly prepares proxy routing, builds an inner command for the second sandbox stage, and either starts bubblewrap or applies Landlock/seccomp directly. It does not return; the process becomes the target command or exits/panics on setup failure.

**Call relations**: This function is the conductor. It calls the profile-resolution and validation helpers first, then either hands off to the bubblewrap flow, activates proxy routing for an inner stage, or applies legacy restrictions before calling `exec_or_panic` to replace the helper with the real command.

*Call graph*: calls 9 internal fn (apply_permission_profile_to_current_thread, build_inner_seccomp_command, ensure_inner_stage_mode_is_valid, ensure_legacy_landlock_mode_supports_policy, exec_or_panic, resolve_permission_profile, run_bwrap_with_proc_fallback, activate_proxy_routes_in_netns, prepare_host_proxy_route_spec); called by 1 (run_main); 2 external calls (parse, panic!).


##### `ResolvePermissionProfileError::fmt`  (lines 270–274)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This gives a human-readable message for permission profile resolution errors. It is used when a missing configuration needs to be shown as text instead of as an internal enum value.

**Data flow**: It receives an error value and a formatter. For the known missing-configuration case, it writes a clear message into the formatter. The output is the text that can appear in a panic or error display.

**Call relations**: When `resolve_permission_profile` cannot find a supplied profile, `run_main` turns that error into a panic message; this formatter supplies the wording.

*Call graph*: 1 external calls (write!).


##### `parse_permission_profile`  (lines 277–279)

```
fn parse_permission_profile(value: &str) -> std::result::Result<PermissionProfile, String>
```

**Purpose**: This converts the hidden command-line permission profile argument from JSON text into a structured permission profile. It exists so the sandbox helper can receive rich policy data through a CLI flag.

**Data flow**: It takes a string from the command line. It asks the JSON parser to decode it as a `PermissionProfile`; if decoding fails, it turns the parser error into a plain string. The result is either a usable profile or a readable validation error.

**Call relations**: The command-line parser uses this function while building `LandlockCommand`, before `run_main` receives the parsed options.

*Call graph*: 1 external calls (from_str).


##### `resolve_permission_profile`  (lines 281–293)

```
fn resolve_permission_profile(
    permission_profile: Option<PermissionProfile>,
) -> Result<EffectivePermissions, ResolvePermissionProfileError>
```

**Purpose**: This turns the optional permission profile into the concrete rules the launcher needs. It refuses to continue if no profile was supplied.

**Data flow**: It receives an optional `PermissionProfile`. If it is missing, it returns a missing-configuration error; otherwise it derives filesystem and network sandbox policies from the profile and packages all three pieces together. The caller gets an `EffectivePermissions` bundle.

**Call relations**: `run_main` calls this early so every later decision uses one consistent view of the requested permissions.

*Call graph*: called by 1 (run_main).


##### `ensure_inner_stage_mode_is_valid`  (lines 295–299)

```
fn ensure_inner_stage_mode_is_valid(apply_seccomp_then_exec: bool, use_legacy_landlock: bool)
```

**Purpose**: This prevents an invalid combination of sandbox modes. The inner seccomp stage is meant for the bubblewrap flow, not for the legacy Landlock-only path.

**Data flow**: It receives two booleans: whether this process is the inner seccomp stage and whether legacy Landlock is requested. If both are true, it stops with a panic; otherwise it changes nothing and returns normally.

**Call relations**: `run_main` calls it before doing any setup, so the helper fails fast instead of creating a confusing half-sandboxed launch.

*Call graph*: called by 1 (run_main); 1 external calls (panic!).


##### `ensure_legacy_landlock_mode_supports_policy`  (lines 301–315)

```
fn ensure_legacy_landlock_mode_supports_policy(
    use_legacy_landlock: bool,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    sandbox_p
```

**Purpose**: This checks that the old Landlock path can actually enforce the requested policy. Some permission profiles need runtime behavior that legacy Landlock mode cannot provide.

**Data flow**: It receives the legacy-mode flag, the filesystem policy, the network policy, and the policy working directory. If legacy mode is active and the policy says it needs direct runtime enforcement, it panics. Otherwise it leaves the launch path unchanged.

**Call relations**: `run_main` uses this after resolving permissions and before choosing the sandbox path, so unsupported legacy launches are rejected clearly.

*Call graph*: calls 1 internal fn (needs_direct_runtime_enforcement); called by 1 (run_main); 1 external calls (panic!).


##### `run_bwrap_with_proc_fallback`  (lines 317–359)

```
fn run_bwrap_with_proc_fallback(
    sandbox_policy_cwd: &Path,
    command_cwd: Option<&Path>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPoli
```

**Purpose**: This starts the bubblewrap-based sandbox, with a safety fallback for systems that do not allow mounting `/proc`. `/proc` is a special Linux information filesystem, and some containers forbid creating it inside another sandbox.

**Data flow**: It receives paths, filesystem and network policies, the inner command, and options about `/proc` and proxy networking. It chooses the bubblewrap network mode, optionally runs a small preflight test for `/proc`, builds the final bubblewrap argument list, adjusts how the inner command name appears, and then runs or execs bubblewrap. It never returns.

**Call relations**: `run_main` hands the bubblewrap path to this function. It coordinates smaller helpers that choose network behavior, build arguments, probe `/proc`, and finally enter the bubblewrap execution flow.

*Call graph*: calls 5 internal fn (apply_inner_command_argv0, build_bwrap_argv, bwrap_network_mode, preflight_proc_mount_support, run_or_exec_bwrap); called by 1 (run_main); 1 external calls (default).


##### `bwrap_network_mode`  (lines 361–372)

```
fn bwrap_network_mode(
    network_sandbox_policy: NetworkSandboxPolicy,
    allow_network_for_proxy: bool,
) -> BwrapNetworkMode
```

**Purpose**: This translates the project’s network policy into the network mode bubblewrap should use. It decides whether the sandbox gets full network access, isolated networking, or proxy-only networking.

**Data flow**: It receives the network policy and a flag for managed proxy mode. Proxy mode wins first; otherwise enabled networking becomes full access, and disabled networking becomes isolation. It returns a `BwrapNetworkMode` value used to build bubblewrap arguments.

**Call relations**: `run_bwrap_with_proc_fallback` calls this before building bubblewrap options, so filesystem setup and network setup are described in one final argument list.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (run_bwrap_with_proc_fallback).


##### `build_bwrap_argv`  (lines 374–397)

```
fn build_bwrap_argv(
    inner: Vec<String>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    sandbox_policy_cwd: &Path,
    command_cwd: &Path,
    options: BwrapOptions,
) -> CodexResul
```

**Purpose**: This builds the full command-line argument list used to start bubblewrap. It adds the `bwrap` program name in front of the detailed arguments produced by the bubblewrap module.

**Data flow**: It receives the inner command, policy paths, filesystem policy, and bubblewrap options. It asks the bubblewrap argument builder for the detailed setup, prefixes the executable name, and returns the arguments plus any files or cleanup targets that must be preserved or tracked.

**Call relations**: Both the real bubblewrap launch and the `/proc` preflight use this function so their argument construction stays consistent.

*Call graph*: calls 1 internal fn (create_bwrap_command_args); called by 2 (build_preflight_bwrap_argv, run_bwrap_with_proc_fallback); 1 external calls (vec!).


##### `exit_with_bwrap_build_error`  (lines 399–402)

```
fn exit_with_bwrap_build_error(err: codex_protocol::error::CodexErr) -> !
```

**Purpose**: This prints a clear error when bubblewrap arguments cannot be built, then exits the helper. It avoids continuing with an incomplete or unsafe sandbox command.

**Data flow**: It receives a build error, writes it to standard error, and exits the process with status code 1. It produces no normal return value.

**Call relations**: `run_bwrap_with_proc_fallback` uses this as the failure path when either the preflight or real bubblewrap argument construction fails.

*Call graph*: 2 external calls (eprintln!, exit).


##### `apply_inner_command_argv0`  (lines 404–410)

```
fn apply_inner_command_argv0(argv: &mut Vec<String>)
```

**Purpose**: This adjusts how the re-entered helper identifies itself inside bubblewrap. That matters because the same executable is run twice: once outside the sandbox and once inside it.

**Data flow**: It receives the mutable bubblewrap argument list. It checks whether the installed bubblewrap supports setting `argv[0]`, gets the current process name as a fallback, and delegates the actual edit. The argument list is modified in place.

**Call relations**: `run_bwrap_with_proc_fallback` calls this after building arguments and before launching bubblewrap, so the inner stage can be recognized correctly.

*Call graph*: calls 3 internal fn (preferred_bwrap_supports_argv0, apply_inner_command_argv0_for_launcher, current_process_argv0); called by 1 (run_bwrap_with_proc_fallback).


##### `apply_inner_command_argv0_for_launcher`  (lines 412–435)

```
fn apply_inner_command_argv0_for_launcher(
    argv: &mut Vec<String>,
    supports_argv0: bool,
    argv0_fallback_command: String,
)
```

**Purpose**: This performs the actual argument-list edit that controls the inner command’s displayed program name. It supports both newer bubblewrap versions and older ones that lack direct `argv[0]` support.

**Data flow**: It receives the bubblewrap argument list, a flag saying whether `--argv0` is supported, and a fallback command string. It finds the `--` separator before the inner command. If supported, it inserts `--argv0` and the special sandbox name; otherwise it replaces the inner command path with the fallback command. The modified list is left in the same vector.

**Call relations**: `apply_inner_command_argv0` provides environment-specific inputs, and this helper applies the concrete change before `run_or_exec_bwrap` starts bubblewrap.

*Call graph*: called by 1 (apply_inner_command_argv0); 1 external calls (panic!).


##### `current_process_argv0`  (lines 437–442)

```
fn current_process_argv0() -> String
```

**Purpose**: This reads the current process’s original command name. It is used as a fallback when bubblewrap cannot explicitly set the inner command’s `argv[0]`.

**Data flow**: It reads the first process argument from the operating system. If one exists, it converts it into a string; if not, it panics because the launcher cannot safely build the fallback. The output is the current executable name as seen by the process.

**Call relations**: `apply_inner_command_argv0` calls this only when preparing the bubblewrap launch argument adjustment.

*Call graph*: called by 1 (apply_inner_command_argv0); 2 external calls (panic!, args_os).


##### `preflight_proc_mount_support`  (lines 444–458)

```
fn preflight_proc_mount_support(
    sandbox_policy_cwd: &Path,
    command_cwd: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_mode: BwrapNetworkMode,
) -> CodexResult<b
```

**Purpose**: This checks whether the current environment allows bubblewrap to mount `/proc`. It lets the real command avoid a known setup failure by retrying without that mount.

**Data flow**: It receives the same paths and policies needed for a bubblewrap run. It builds a tiny bubblewrap command that runs `true`, captures its standard error, and checks whether the error text matches known `/proc` mount failures. It returns true if `/proc` looks usable and false if the launch should skip it.

**Call relations**: `run_bwrap_with_proc_fallback` calls this before the real launch when `/proc` mounting is requested.

*Call graph*: calls 3 internal fn (build_preflight_bwrap_argv, is_proc_mount_failure, run_bwrap_in_child_capture_stderr); called by 1 (run_bwrap_with_proc_fallback).


##### `build_preflight_bwrap_argv`  (lines 460–478)

```
fn build_preflight_bwrap_argv(
    sandbox_policy_cwd: &Path,
    command_cwd: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_mode: BwrapNetworkMode,
) -> CodexResult<cra
```

**Purpose**: This builds the bubblewrap arguments for the small `/proc` test run. The command inside the sandbox is just `true`, a program that immediately exits successfully.

**Data flow**: It receives policy paths, filesystem policy, and network mode. It chooses a `true` command and builds bubblewrap arguments with `/proc` mounting enabled. The output is a `BwrapArgs` package for the preflight child process.

**Call relations**: `preflight_proc_mount_support` uses this, then passes the result to the child-runner that captures standard error.

*Call graph*: calls 1 internal fn (build_bwrap_argv); called by 1 (preflight_proc_mount_support); 2 external calls (default, vec!).


##### `resolve_true_command`  (lines 480–487)

```
fn resolve_true_command() -> String
```

**Purpose**: This finds a usable `true` command for quick test runs. `true` is a tiny standard utility that simply exits successfully.

**Data flow**: It checks common absolute paths, `/usr/bin/true` and `/bin/true`. If one exists, it returns that path; otherwise it returns `true` and lets the system path lookup handle it later.

**Call relations**: This supports the preflight bubblewrap command, keeping the probe simple and portable across Linux layouts.

*Call graph*: 1 external calls (new).


##### `run_or_exec_bwrap`  (lines 489–496)

```
fn run_or_exec_bwrap(bwrap_args: crate::bwrap::BwrapArgs) -> !
```

**Purpose**: This chooses whether bubblewrap can replace the current process directly or must be run as a child with cleanup supervision. Direct replacement is simpler, but cleanup targets require a parent process to stay behind.

**Data flow**: It receives a `BwrapArgs` bundle. If there are no synthetic mount targets or protected-create targets to clean up, it directly execs bubblewrap. Otherwise it starts the supervised child flow. It never returns.

**Call relations**: `run_bwrap_with_proc_fallback` hands the completed bubblewrap setup here as the final launch step.

*Call graph*: calls 2 internal fn (exec_bwrap, run_bwrap_in_child_with_synthetic_mount_cleanup); called by 1 (run_bwrap_with_proc_fallback).


##### `run_bwrap_in_child_with_synthetic_mount_cleanup`  (lines 498–547)

```
fn run_bwrap_in_child_with_synthetic_mount_cleanup(bwrap_args: crate::bwrap::BwrapArgs) -> !
```

**Purpose**: This runs bubblewrap in a child process while the parent watches signals, protected paths, and cleanup duties. It exists for cases where the sandbox setup creates temporary placeholder paths that must be removed afterward.

**Data flow**: It receives bubblewrap arguments plus lists of temporary mount targets and protected-create targets. The parent registers cleanup markers, forks a child, starts monitoring, forwards signals, waits for the child to finish, cleans up temporary files/directories, detects policy violations, restores signal handlers, and exits with the child’s status or with failure if protected paths were created. The child waits for permission to start, then execs bubblewrap.

**Call relations**: `run_or_exec_bwrap` uses this when cleanup is needed. It brings together marker registration, process forking, signal forwarding, protected-create monitoring, wait-status handling, and final cleanup.

*Call graph*: calls 16 internal fn (exec_bwrap, block, start, cleanup_protected_create_targets, cleanup_synthetic_mount_targets, close_child_exec_start_read, create_exec_start_pipe, exit_with_wait_status_or_policy_violation, install_bwrap_signal_forwarders, register_protected_create_targets (+6 more)); called by 1 (run_or_exec_bwrap); 5 external calls (last_os_error, fork, getpid, setpgid, panic!).


##### `ProtectedCreateMonitor::start`  (lines 550–581)

```
fn start(targets: &[crate::bwrap::ProtectedCreateTarget]) -> Option<Self>
```

**Purpose**: This starts a background thread that watches for forbidden creation of protected paths. It is a guard dog for metadata paths that the sandboxed command should not create.

**Data flow**: It receives protected-create targets. If there are none, it returns no monitor. Otherwise it clones the targets, creates shared stop and violation flags, starts a thread that repeatedly removes any created target and records that a violation happened, and returns a monitor handle.

**Call relations**: `run_bwrap_in_child_with_synthetic_mount_cleanup` starts this before releasing the bubblewrap child so violations can be caught while the command runs.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 6 external calls (clone, new, new, is_empty, to_vec, spawn).


##### `ProtectedCreateMonitor::stop`  (lines 583–589)

```
fn stop(self) -> bool
```

**Purpose**: This stops the protected-create watcher thread and reports whether it saw a violation. It makes sure the background guard is joined before cleanup continues.

**Data flow**: It receives the monitor object. It sets the stop flag, waits for the thread to finish, then reads the violation flag. The output is true if a protected path was created and removed, false otherwise.

**Call relations**: The supervised bubblewrap parent calls this after the child exits, then combines its result with final cleanup checks before deciding the final exit status.

*Call graph*: 1 external calls (join).


##### `ProtectedCreateWatcher::new`  (lines 593–631)

```
fn new(targets: &[crate::bwrap::ProtectedCreateTarget]) -> Option<Self>
```

**Purpose**: This creates an inotify watcher for parent directories of protected paths. Inotify is a Linux feature that reports filesystem events, like a doorbell for file creation.

**Data flow**: It receives protected targets, opens an inotify file descriptor, adds watches for each unique parent directory, and stores the watch identifiers. If no watch can be installed, it closes the descriptor and returns no watcher.

**Call relations**: The protected-create monitor thread uses this to sleep efficiently until filesystem activity happens, instead of constantly polling as fast as possible.

*Call graph*: 6 external calls (new, new, new, close, inotify_add_watch, inotify_init1).


##### `ProtectedCreateWatcher::wait_for_create_event`  (lines 633–654)

```
fn wait_for_create_event(&self, stop: &AtomicBool)
```

**Purpose**: This waits briefly for a create or move event in a watched directory. It lets the monitor thread wake up when something relevant may have happened.

**Data flow**: It receives the watcher and a shared stop flag. It polls the inotify descriptor for up to a short interval, drains pending events if any arrive, and returns if stopped, timed out, interrupted, or errored.

**Call relations**: The monitor thread calls this between removal checks so it can respond quickly without wasting CPU.

*Call graph*: calls 1 internal fn (drain_events); 3 external calls (load, last_os_error, poll).


##### `ProtectedCreateWatcher::drain_events`  (lines 656–672)

```
fn drain_events(&self)
```

**Purpose**: This clears pending inotify events after the watcher wakes up. The event contents are not needed; their presence is enough to trigger another protected-path check.

**Data flow**: It repeatedly reads from the inotify descriptor into a buffer until there are no more events or a non-retryable error occurs. It returns no data and only empties the notification queue.

**Call relations**: `ProtectedCreateWatcher::wait_for_create_event` calls this when polling says events are ready.

*Call graph*: called by 1 (wait_for_create_event); 2 external calls (last_os_error, read).


##### `ProtectedCreateWatcher::drop`  (lines 676–680)

```
fn drop(&mut self)
```

**Purpose**: This closes the inotify file descriptor when the watcher is destroyed. It prevents leaking a low-level operating-system resource.

**Data flow**: It receives the watcher during cleanup and closes its stored descriptor. There is no returned value.

**Call relations**: Rust calls this automatically when the monitor thread’s watcher goes out of scope.

*Call graph*: 1 external calls (close).


##### `create_exec_start_pipe`  (lines 683–693)

```
fn create_exec_start_pipe(enabled: bool) -> [libc::c_int; 2]
```

**Purpose**: This optionally creates a small pipe used to hold the child process until the parent is ready. A pipe is an operating-system communication channel between processes.

**Data flow**: It receives a boolean. If disabled, it returns invalid placeholder file descriptors. If enabled, it creates a close-on-exec pipe and returns the read and write ends, or panics if creation fails.

**Call relations**: The supervised bubblewrap runner uses this when protected-create monitoring is needed, so the child does not start before the monitor is active.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (last_os_error, pipe2, panic!).


##### `wait_for_parent_exec_start`  (lines 695–719)

```
fn wait_for_parent_exec_start(read_fd: libc::c_int, write_fd: libc::c_int)
```

**Purpose**: This makes the child process wait until the parent signals that setup is complete. It prevents a race where the sandboxed command could create protected paths before monitoring starts.

**Data flow**: It receives the read and write pipe descriptors. In the child, it closes the write end, waits for one byte or pipe closure on the read end, then closes the read end. If no pipe is active, it returns immediately.

**Call relations**: The child side of `run_bwrap_in_child_with_synthetic_mount_cleanup` calls this just before execing bubblewrap.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (last_os_error, close, read).


##### `close_child_exec_start_read`  (lines 721–727)

```
fn close_child_exec_start_read(read_fd: libc::c_int)
```

**Purpose**: This closes the parent’s copy of the child-start pipe read end. Closing unused pipe ends avoids keeping the communication channel accidentally alive.

**Data flow**: It receives a read file descriptor. If it is valid, it closes it; otherwise it does nothing.

**Call relations**: The parent side of the supervised bubblewrap runner calls this after forking.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 1 external calls (close).


##### `release_child_exec_start`  (lines 729–738)

```
fn release_child_exec_start(write_fd: libc::c_int)
```

**Purpose**: This tells the waiting child that it may now exec bubblewrap. It is the parent’s “green light” after signal forwarding and monitoring are ready.

**Data flow**: It receives the pipe write descriptor. If valid, it writes one byte and closes the descriptor; if invalid, it does nothing.

**Call relations**: `run_bwrap_in_child_with_synthetic_mount_cleanup` calls this after installing signal forwarding and starting protected-create monitoring.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 2 external calls (close, write).


##### `ForwardedSignalMask::block`  (lines 749–763)

```
fn block() -> Self
```

**Purpose**: This temporarily blocks signals that will later be forwarded to the bubblewrap child. Blocking here avoids losing or mishandling signals during the small window when handlers are being changed.

**Data flow**: It builds a signal set containing hangup, interrupt, quit, and terminate signals, asks the operating system to block them, and stores the previous signal mask. The returned object can later restore the prior state.

**Call relations**: Both supervised bubblewrap runs and preflight runs use this around fork and handler setup.

*Call graph*: called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup); 6 external calls (last_os_error, sigaddset, sigemptyset, sigprocmask, panic!, zeroed).


##### `ForwardedSignalMask::restore`  (lines 765–776)

```
fn restore(&self)
```

**Purpose**: This restores signal handling after a temporary block. It returns the process to the signal mask it had before setup, except for the forwarded signals that are deliberately unblocked.

**Data flow**: It receives the saved mask, removes the forwarded signals from it, and asks the operating system to apply it. It returns no value.

**Call relations**: The bubblewrap parent and child call this after fork-time setup so normal signal delivery can resume.

*Call graph*: 5 external calls (last_os_error, sigdelset, sigprocmask, panic!, null_mut).


##### `terminate_with_parent`  (lines 779–790)

```
fn terminate_with_parent(parent_pid: libc::pid_t)
```

**Purpose**: This makes the bubblewrap child die if the supervising parent disappears. It avoids leaving a sandbox child running on its own after the launcher crashes or exits early.

**Data flow**: It receives the expected parent process ID. It asks Linux to send SIGTERM when the parent dies, then checks whether the parent already changed; if so, it terminates itself immediately.

**Call relations**: The child side of the supervised bubblewrap flow calls this before starting bubblewrap.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 5 external calls (last_os_error, getppid, prctl, raise, panic!).


##### `ForwardedSignalHandlers::restore`  (lines 793–804)

```
fn restore(self)
```

**Purpose**: This restores the signal handlers that were replaced while supervising bubblewrap. It also clears the stored child process ID and any pending forwarded signal.

**Data flow**: It consumes the handler object containing previous signal actions. It resets global tracking values and reinstalls each old handler. It returns no value.

**Call relations**: The supervised bubblewrap parent calls this after the child has exited and cleanup is complete.

*Call graph*: 4 external calls (last_os_error, sigaction, panic!, null_mut).


##### `install_bwrap_signal_forwarders`  (lines 807–825)

```
fn install_bwrap_signal_forwarders(pid: libc::pid_t) -> ForwardedSignalHandlers
```

**Purpose**: This installs handlers that forward common termination signals from the parent process to the bubblewrap child. This makes Ctrl-C and similar signals affect the sandboxed command instead of only the wrapper.

**Data flow**: It receives the child process ID, stores it globally, replaces handlers for the forwarded signals, records the previous handlers, replays any signal that arrived during setup, and returns an object that can restore the old handlers.

**Call relations**: The supervised bubblewrap runner and the stderr-capturing preflight use this after forking, so the child receives user interruption signals.

*Call graph*: calls 1 internal fn (replay_pending_forwarded_signal); called by 3 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup, run_bwrap_signal_forwarder_test_supervisor); 6 external calls (with_capacity, last_os_error, sigaction, sigemptyset, panic!, zeroed).


##### `forward_signal_to_bwrap_child`  (lines 827–833)

```
fn forward_signal_to_bwrap_child(signal: libc::c_int)
```

**Purpose**: This is the actual signal handler used while supervising bubblewrap. It records the signal and sends it to the child if the child process is known.

**Data flow**: It receives a signal number from the operating system. It stores that signal as pending, reads the tracked child process ID, and forwards the signal if the ID is valid. It returns nothing because signal handlers cannot do normal error reporting.

**Call relations**: Installed by `install_bwrap_signal_forwarders`; it delegates the actual sending to `send_signal_to_bwrap_child`.

*Call graph*: calls 1 internal fn (send_signal_to_bwrap_child).


##### `replay_pending_forwarded_signal`  (lines 835–840)

```
fn replay_pending_forwarded_signal(pid: libc::pid_t)
```

**Purpose**: This forwards a signal that arrived before the child process ID was fully installed. It closes a small race during signal-handler setup.

**Data flow**: It receives the child process ID. It atomically takes the pending signal value; if a signal was recorded, it sends that signal to the child. It clears the pending slot as part of the swap.

**Call relations**: `install_bwrap_signal_forwarders` calls this after handlers and child tracking are in place.

*Call graph*: calls 1 internal fn (send_signal_to_bwrap_child); called by 1 (install_bwrap_signal_forwarders).


##### `send_signal_to_bwrap_child`  (lines 842–847)

```
fn send_signal_to_bwrap_child(pid: libc::pid_t, signal: libc::c_int)
```

**Purpose**: This sends a signal to the bubblewrap child and its process group. A process group is a set of related processes, so this reaches both bubblewrap and programs it starts.

**Data flow**: It receives a child process ID and signal number. It asks the operating system to signal the negative process ID, meaning the group, and then the specific child PID as well. It returns no result.

**Call relations**: Both the live signal handler and the pending-signal replay use this as the shared low-level sender.

*Call graph*: called by 2 (forward_signal_to_bwrap_child, replay_pending_forwarded_signal); 1 external calls (kill).


##### `reset_forwarded_signal_handlers_to_default`  (lines 849–858)

```
fn reset_forwarded_signal_handlers_to_default()
```

**Purpose**: This resets forwarded signals back to their normal behavior in the child process. The child should not inherit the parent’s forwarding handlers.

**Data flow**: It loops over the forwarded signal list and sets each signal action to the default operating-system behavior. If a reset fails, it panics.

**Call relations**: Child processes in the supervised bubblewrap and preflight flows call this immediately after fork and before execing bubblewrap.

*Call graph*: called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (last_os_error, signal, panic!).


##### `wait_for_bwrap_child`  (lines 860–873)

```
fn wait_for_bwrap_child(pid: libc::pid_t) -> libc::c_int
```

**Purpose**: This waits for the bubblewrap child process to exit and returns its raw wait status. It retries cleanly if waiting is interrupted by a signal.

**Data flow**: It receives the child process ID. It repeatedly calls the operating system wait function until it gets a status or a real error. The output is the status word that says whether the child exited normally or died from a signal.

**Call relations**: Supervised bubblewrap runs, preflight runs, and signal-forwarder tests use this to learn how the child ended.

*Call graph*: called by 4 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup, bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive, run_bwrap_signal_forwarder_test_supervisor); 3 external calls (last_os_error, waitpid, panic!).


##### `register_synthetic_mount_targets`  (lines 875–922)

```
fn register_synthetic_mount_targets(
    targets: &[crate::bwrap::SyntheticMountTarget],
) -> Vec<SyntheticMountTargetRegistration>
```

**Purpose**: This records that the current process owns temporary synthetic mount targets. These markers prevent one sandbox run from deleting placeholder paths still needed by another run.

**Data flow**: It receives synthetic mount targets. Under a registry lock, it creates marker directories, adjusts targets if another active synthetic owner already exists, writes a marker file named after the current process ID, and returns registrations describing what must later be cleaned up.

**Call relations**: Both supervised real runs and preflight runs call this before starting bubblewrap; cleanup functions later use the returned registrations.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `register_protected_create_targets`  (lines 924–953)

```
fn register_protected_create_targets(
    targets: &[crate::bwrap::ProtectedCreateTarget],
) -> Vec<ProtectedCreateTargetRegistration>
```

**Purpose**: This records protected paths that must not be created by the sandboxed command. The records coordinate cleanup and violation detection across overlapping sandbox runs.

**Data flow**: It receives protected-create targets. Under the registry lock, it creates marker directories, writes a marker file for the current process, and returns registrations for later cleanup.

**Call relations**: The bubblewrap supervision paths call this before running the child, and cleanup later removes these markers.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `synthetic_mount_marker_contents`  (lines 955–961)

```
fn synthetic_mount_marker_contents(target: &crate::bwrap::SyntheticMountTarget) -> &'static [u8]
```

**Purpose**: This chooses the marker text for a synthetic mount target. The marker says whether the target represents a newly synthetic path or one that preserves an existing path.

**Data flow**: It receives a synthetic mount target. If the target preserves a pre-existing path, it returns the `existing` marker bytes; otherwise it returns the `synthetic` marker bytes.

**Call relations**: Synthetic target registration uses this when writing marker files into the shared registry.

*Call graph*: calls 1 internal fn (preserves_pre_existing_path).


##### `synthetic_mount_marker_dir_has_active_synthetic_owner`  (lines 963–974)

```
fn synthetic_mount_marker_dir_has_active_synthetic_owner(marker_dir: &Path) -> bool
```

**Purpose**: This checks whether a marker directory has a live process that owns a truly synthetic target. That distinction affects whether another sandbox should treat the path as already synthetic.

**Data flow**: It receives a marker directory path. It scans active marker files and reads their contents, looking specifically for the synthetic marker. It returns true if a live matching owner is found.

**Call relations**: Synthetic target registration calls this when deciding how to register a target that might overlap with another running sandbox.

*Call graph*: calls 1 internal fn (synthetic_mount_marker_dir_has_active_process_matching).


##### `synthetic_mount_marker_dir_has_active_process`  (lines 976–978)

```
fn synthetic_mount_marker_dir_has_active_process(marker_dir: &Path) -> bool
```

**Purpose**: This checks whether any live sandbox process is registered in a marker directory. It is used to avoid deleting shared temporary paths too early.

**Data flow**: It receives a marker directory path and scans marker files for process IDs that are still active. It returns true if any active owner remains.

**Call relations**: Cleanup for both synthetic mounts and protected-create targets uses this before removing shared marker directories or target paths.

*Call graph*: calls 1 internal fn (synthetic_mount_marker_dir_has_active_process_matching).


##### `synthetic_mount_marker_dir_has_active_process_matching`  (lines 980–1024)

```
fn synthetic_mount_marker_dir_has_active_process_matching(
    marker_dir: &Path,
    matches_marker: impl Fn(&Path) -> bool,
) -> bool
```

**Purpose**: This is the shared scanner for marker directories. It removes stale marker files for dead processes and reports whether any live marker matches a caller-provided condition.

**Data flow**: It receives a marker directory and a test function for marker files. It reads entries, parses file names as process IDs, removes stale markers for inactive processes, and applies the test to active markers. It returns true on the first active matching marker, otherwise false.

**Call relations**: The more specific active-owner checks use this so registry scanning and stale-marker cleanup are implemented in one place.

*Call graph*: calls 1 internal fn (process_is_active); called by 2 (synthetic_mount_marker_dir_has_active_process, synthetic_mount_marker_dir_has_active_synthetic_owner); 3 external calls (read_dir, remove_file, panic!).


##### `cleanup_synthetic_mount_targets`  (lines 1026–1055)

```
fn cleanup_synthetic_mount_targets(targets: &[SyntheticMountTargetRegistration])
```

**Purpose**: This unregisters synthetic mount targets and removes temporary placeholder files or directories when safe. It prevents sandbox-created scaffolding from being left in the user’s workspace.

**Data flow**: It receives registrations from setup. Under the registry lock, it removes this process’s marker files, then for each target checks whether another active process still uses the same marker directory. If not, it removes the synthetic target when appropriate and tries to remove the marker directory.

**Call relations**: Supervised real runs and preflight runs call this after the bubblewrap child finishes.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `cleanup_protected_create_targets`  (lines 1057–1091)

```
fn cleanup_protected_create_targets(targets: &[ProtectedCreateTargetRegistration]) -> bool
```

**Purpose**: This unregisters protected-create targets and detects whether forbidden paths were created. It returns a policy-violation flag that can make an otherwise successful command fail.

**Data flow**: It receives protected-create registrations. Under the registry lock, it removes this process’s marker files, checks for other active owners, removes created protected paths when safe, and records whether any such path existed. The output is true if a violation was found.

**Call relations**: The supervised bubblewrap runner combines this result with the live monitor result before choosing the final exit status.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `remove_protected_create_target`  (lines 1093–1109)

```
fn remove_protected_create_target(target: &crate::bwrap::ProtectedCreateTarget) -> bool
```

**Purpose**: This removes a protected path and treats failure as serious. It is used during final cleanup where the launcher expects to be able to cleanly remove forbidden creations.

**Data flow**: It receives a protected target and tries up to 100 times to remove it, waiting briefly if a directory is still busy or changing. If removal succeeds, it returns true when something was removed and false when nothing existed; if removal keeps failing, it panics.

**Call relations**: Protected-create cleanup uses this stricter remover after the child has exited.

*Call graph*: calls 1 internal fn (try_remove_protected_create_target); 4 external calls (from_millis, panic!, sleep, unreachable!).


##### `remove_protected_create_target_best_effort`  (lines 1111–1124)

```
fn remove_protected_create_target_best_effort(
    target: &crate::bwrap::ProtectedCreateTarget,
) -> Option<ProtectedCreateRemoval>
```

**Purpose**: This tries to remove a protected path during live monitoring without panicking on ordinary failures. It is intentionally tolerant because the sandboxed process may still be racing with the monitor.

**Data flow**: It receives a protected target and repeatedly attempts removal. If something is removed, it returns the kind of removal; if nothing exists, it returns none; if it cannot confidently remove the path, it returns a generic violation marker instead of crashing.

**Call relations**: The protected-create monitor thread uses this while the command is still running.

*Call graph*: calls 1 internal fn (try_remove_protected_create_target); 2 external calls (from_millis, sleep).


##### `try_remove_protected_create_target`  (lines 1126–1156)

```
fn try_remove_protected_create_target(
    target: &crate::bwrap::ProtectedCreateTarget,
) -> std::io::Result<Option<ProtectedCreateRemoval>>
```

**Purpose**: This performs one actual attempt to remove a protected path. It distinguishes directories from other filesystem objects so it can remove them correctly.

**Data flow**: It receives a protected target, inspects the path without following symlinks, and returns none if the path is absent. If present, it removes a directory tree or a file-like object, prints a warning that creation was blocked, and returns the kind of thing removed. Errors are returned to the caller for retry or handling.

**Call relations**: Both the strict final remover and the best-effort live remover rely on this one-attempt primitive.

*Call graph*: calls 1 internal fn (path); called by 2 (remove_protected_create_target, remove_protected_create_target_best_effort); 4 external calls (eprintln!, remove_dir_all, remove_file, symlink_metadata).


##### `remove_synthetic_mount_target`  (lines 1158–1190)

```
fn remove_synthetic_mount_target(target: &crate::bwrap::SyntheticMountTarget)
```

**Purpose**: This removes a temporary synthetic mount target if it still looks like something the sandbox created. It avoids deleting real user content by asking the target whether removal is safe.

**Data flow**: It receives a synthetic target, inspects the path, and returns if the path is gone or should not be removed. For removable empty-file targets it removes the file; for removable empty-directory targets it removes the directory if empty. It panics on unexpected cleanup errors.

**Call relations**: Synthetic mount cleanup calls this only after the registry says no other active sandbox owns that target.

*Call graph*: calls 3 internal fn (kind, path, should_remove_after_bwrap); 4 external calls (remove_dir, remove_file, symlink_metadata, panic!).


##### `process_is_active`  (lines 1192–1199)

```
fn process_is_active(pid: libc::pid_t) -> bool
```

**Purpose**: This checks whether a process ID still appears to be alive. It is used to tell active registry markers from stale ones.

**Data flow**: It receives a process ID and sends signal 0, which is a Linux way to test for process existence without actually signaling it. It returns false only when the operating system says the process does not exist; other outcomes are treated as active or not safely removable.

**Call relations**: Marker-directory scanning uses this before deciding whether to remove old marker files.

*Call graph*: called by 1 (synthetic_mount_marker_dir_has_active_process_matching); 3 external calls (last_os_error, kill, matches!).


##### `with_synthetic_mount_registry_lock`  (lines 1201–1238)

```
fn with_synthetic_mount_registry_lock(f: impl FnOnce() -> T) -> T
```

**Purpose**: This runs registry operations while holding a filesystem lock. The lock is like a checkout token that stops two sandbox helpers from editing the same marker registry at the same time.

**Data flow**: It creates the registry directory, opens a lock file, takes an exclusive lock, runs the provided closure, unlocks the file, and returns the closure’s result. If locking or setup fails, it panics.

**Call relations**: All registration and cleanup of synthetic mount and protected-create markers go through this function to avoid races between concurrent sandbox runs.

*Call graph*: calls 1 internal fn (synthetic_mount_registry_root); called by 4 (cleanup_protected_create_targets, cleanup_synthetic_mount_targets, register_protected_create_targets, register_synthetic_mount_targets); 5 external calls (new, last_os_error, create_dir_all, flock, panic!).


##### `synthetic_mount_marker_dir`  (lines 1240–1242)

```
fn synthetic_mount_marker_dir(path: &Path) -> PathBuf
```

**Purpose**: This maps a target path to the registry directory used for that path’s marker files. It uses a hash so paths become safe, compact directory names.

**Data flow**: It receives a filesystem path, hashes it, formats the hash as fixed-width hexadecimal text, and joins it under the registry root. The output is the marker directory path.

**Call relations**: Registration functions use this when creating per-target marker directories.

*Call graph*: calls 1 internal fn (synthetic_mount_registry_root); 1 external calls (format!).


##### `synthetic_mount_registry_root`  (lines 1244–1249)

```
fn synthetic_mount_registry_root() -> PathBuf
```

**Purpose**: This chooses the shared registry root directory for the current effective user. Separating by user avoids different users interfering with each other’s sandbox markers.

**Data flow**: It reads the effective user ID, formats a directory name containing that ID, and places it under the system temporary directory. The output is a path like a per-user sandbox registry folder.

**Call relations**: The registry lock helper and marker-directory builder both use this as the base location.

*Call graph*: called by 2 (synthetic_mount_marker_dir, with_synthetic_mount_registry_lock); 3 external calls (format!, geteuid, temp_dir).


##### `hash_path`  (lines 1251–1258)

```
fn hash_path(path: &Path) -> u64
```

**Purpose**: This creates a stable numeric hash from a filesystem path. The hash is used to name marker directories without embedding raw path text.

**Data flow**: It receives a path, reads its raw OS bytes, and applies a simple byte-by-byte hash calculation. The output is a 64-bit number.

**Call relations**: `synthetic_mount_marker_dir` uses this to turn arbitrary paths into safe registry directory names.

*Call graph*: 2 external calls (as_os_str, from).


##### `exit_with_wait_status`  (lines 1260–1275)

```
fn exit_with_wait_status(status: libc::c_int) -> !
```

**Purpose**: This makes the helper exit the same way the bubblewrap child exited. If the child was killed by a signal, the helper re-raises that signal so callers see the expected behavior.

**Data flow**: It receives a raw wait status. If the child exited normally, it exits with the child’s exit code. If the child died from a signal, it resets that signal to default, sends it to itself, and falls back to the conventional `128 + signal` exit code. Unknown cases exit with 1.

**Call relations**: The supervised bubblewrap path and the preflight signal path use this to preserve child process semantics.

*Call graph*: called by 2 (exit_with_wait_status_or_policy_violation, run_bwrap_in_child_capture_stderr); 8 external calls (WEXITSTATUS, WIFEXITED, WIFSIGNALED, WTERMSIG, getpid, kill, signal, exit).


##### `exit_with_wait_status_or_policy_violation`  (lines 1277–1286)

```
fn exit_with_wait_status_or_policy_violation(
    status: libc::c_int,
    protected_create_violation: bool,
) -> !
```

**Purpose**: This exits like the child unless a protected-create violation should turn success into failure. It ensures blocked metadata creation is visible to the caller.

**Data flow**: It receives the child wait status and a violation flag. If there was a violation and the child otherwise exited with code 0, it exits with code 1. Otherwise it delegates to the normal wait-status exit logic.

**Call relations**: The supervised bubblewrap runner uses this as its final step after cleanup and violation checks.

*Call graph*: calls 1 internal fn (exit_with_wait_status); called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (WEXITSTATUS, WIFEXITED, exit).


##### `run_bwrap_in_child_capture_stderr`  (lines 1299–1368)

```
fn run_bwrap_in_child_capture_stderr(bwrap_args: crate::bwrap::BwrapArgs) -> String
```

**Purpose**: This runs a short bubblewrap command in a child process and captures its standard error text. It is used for the `/proc` mount probe, not for the real user command.

**Data flow**: It receives bubblewrap arguments, registers cleanup markers, creates a pipe for standard error, forks, redirects the child’s standard error to the pipe, execs bubblewrap in the child, reads up to a fixed amount of error output in the parent, waits for the child, cleans up markers, restores signal handlers, and returns the captured text. If the child died from a signal, the parent exits the same way.

**Call relations**: `preflight_proc_mount_support` uses this to inspect bubblewrap’s error message without leaking probe noise into the real command’s output.

*Call graph*: calls 11 internal fn (exec_bwrap, block, cleanup_protected_create_targets, cleanup_synthetic_mount_targets, close_fd_or_panic, exit_with_wait_status, install_bwrap_signal_forwarders, register_protected_create_targets, register_synthetic_mount_targets, reset_forwarded_signal_handlers_to_default (+1 more)); called by 1 (preflight_proc_mount_support); 9 external calls (from_raw_fd, from_utf8_lossy, new, last_os_error, WIFSIGNALED, dup2, fork, pipe2, panic!).


##### `close_fd_or_panic`  (lines 1375–1381)

```
fn close_fd_or_panic(fd: libc::c_int, context: &str)
```

**Purpose**: This closes a file descriptor and treats failure as a setup bug. A file descriptor is a small operating-system handle for an open file, pipe, or similar resource.

**Data flow**: It receives a file descriptor and a context string. It calls close; if close fails, it panics with the context and operating-system error. It returns nothing on success.

**Call relations**: The stderr-capturing preflight uses this for explicit, checked pipe cleanup in both parent and child.

*Call graph*: called by 1 (run_bwrap_in_child_capture_stderr); 3 external calls (last_os_error, close, panic!).


##### `is_proc_mount_failure`  (lines 1383–1389)

```
fn is_proc_mount_failure(stderr: &str) -> bool
```

**Purpose**: This recognizes bubblewrap error text that specifically means mounting `/proc` failed. It keeps the fallback narrow so unrelated failures are not silently ignored.

**Data flow**: It receives standard error text. It checks for bubblewrap’s proc-mount wording, the expected `/newroot/proc` path, and one of several permission-related error phrases. It returns true only when all required clues are present.

**Call relations**: `preflight_proc_mount_support` uses this after capturing stderr from the preflight run.

*Call graph*: called by 1 (preflight_proc_mount_support).


##### `build_inner_seccomp_command`  (lines 1401–1443)

```
fn build_inner_seccomp_command(args: InnerSeccompCommandArgs<'_>) -> Vec<String>
```

**Purpose**: This builds the command line for the second stage of the sandbox helper. That inner stage runs inside bubblewrap, applies seccomp and related restrictions, then execs the user command.

**Data flow**: It receives paths, the permission profile, proxy options, an optional route spec, and the final command. It finds the current executable, serializes the permission profile to JSON, assembles flags for the inner stage, appends `--`, and then appends the user command. The output is a vector of command-line strings.

**Call relations**: `run_main` calls this before building the outer bubblewrap command, so bubblewrap knows what program to run inside the sandbox.

*Call graph*: called by 1 (run_main); 4 external calls (panic!, to_string, current_exe, vec!).


##### `exec_or_panic`  (lines 1446–1466)

```
fn exec_or_panic(command: Vec<String>) -> !
```

**Purpose**: This replaces the current helper process with the requested command. If replacement fails, it panics with the operating-system error.

**Data flow**: It receives the command and its arguments as strings. It converts them to C-compatible strings, builds the null-terminated argument pointer list required by `execvp`, and asks the operating system to execute the program. On success there is no return because the process has become the command; on failure it panics.

**Call relations**: `run_main` uses this after applying restrictions in inner-stage, direct-seccomp, or legacy-Landlock paths.

*Call graph*: called by 1 (run_main); 5 external calls (new, last_os_error, execvp, panic!, null).


### `linux-sandbox/src/main.rs`

`entrypoint` · `startup`

This file exists so the project can build an executable program. When the operating system starts this binary, it enters `main`, and `main` delegates all real work to `codex_linux_sandbox::run_main()`. In other words, this file is like the front door of a building: it does not contain the rooms or machinery, but it is the official place where execution begins.

The comment is important. It says that the current working directory, environment variables, and command-line arguments are preserved when the sandbox eventually calls `execv` — a system call that replaces the current process with another program. That means this launcher does not clean up or rewrite those values. Whoever starts the sandbox must provide the right directory, environment, and arguments ahead of time.

Without this file, there would be no binary entry point for the Linux sandbox. The actual sandbox behavior lives elsewhere, but this file connects that behavior to the operating system’s normal program-start mechanism.

#### Function details

##### `main`  (lines 4–6)

```
fn main() -> !
```

**Purpose**: This is the program’s starting function. It immediately starts the Linux sandbox runner and never returns to its caller.

**Data flow**: The operating system starts the program with its existing command-line arguments, environment variables, and current working directory already in place. `main` does not inspect or change them; it passes control to `codex_linux_sandbox::run_main()`, which continues the sandbox startup and eventually takes over the process flow.

**Call relations**: `main` is called by the operating system when the sandbox executable starts. Its only job is to call `run_main`, handing off to the shared sandbox implementation where the real setup and execution happen.

*Call graph*: 1 external calls (run_main).


### `bwrap/src/main.rs`

`entrypoint` · `startup`

Bubblewrap is a Linux sandboxing tool: it starts another program inside a restricted environment, a bit like putting that program in a controlled room where only selected doors are open. This file is the front door for the Rust-built `bwrap` executable.

On Linux builds where Bubblewrap support is available, `main` collects the arguments used to start the program and converts them into the C-style format expected by Bubblewrap’s original C entry function. C programs expect command-line arguments as a list of pointers ending with a null pointer, so this file carefully builds that list and keeps the underlying strings alive while calling into the C function. It then exits the Rust process with the same exit code returned by Bubblewrap, so the outside world sees the correct success or failure result.

There are also two safety-check versions of `main` chosen at compile time. If the target is Linux but Bubblewrap was not included correctly, the program immediately explains what is missing. If the target is not Linux, it stops because Bubblewrap depends on Linux-only sandboxing features. Without this file, there would be no executable bridge between Rust startup and the Bubblewrap sandbox code.

#### Function details

##### `main`  (lines 43–45)

```
fn main()
```

**Purpose**: This is the program’s starting point. On a supported Linux build, it forwards the process arguments to Bubblewrap’s C entry function and exits with Bubblewrap’s result; on unsupported builds, it fails immediately with an explanatory message.

**Data flow**: It starts with the arguments passed to the executable by the operating system. In the supported case, it converts each argument into a C-compatible string, builds the argument pointer list Bubblewrap expects, calls the Bubblewrap C function, then turns that returned number into the process exit code. In unsupported cases, it does not run Bubblewrap at all; it produces an error message and stops.

**Call relations**: This function is called by the operating system when the `bwrap` executable starts. Its main job is to prepare the command-line data in the form required by the underlying Bubblewrap code, hand control to that code, and then end the process with the result Bubblewrap reports. If the build or platform is wrong, it stops before handing anything off so the failure is clear rather than mysterious.

*Call graph*: 4 external calls (panic!, args_os, exit, null).


### `shell-escalation/src/bin/main_execve_wrapper.rs`

`entrypoint` · `startup`

This file exists because the wrapper program only makes sense on Unix-like operating systems, where `execve` is the system call used to replace the current process with another program. Think of it like a front door: on supported systems, the door leads into the real house; on unsupported systems, it shows a sign saying this entrance is not available.

The file is mostly platform selection. If the code is being built for a Unix system, it does not define its own full program logic here. Instead, it reuses `codex_shell_escalation::main_execve_wrapper` as the executable's `main` function, so the actual work lives in the shared library code.

If the code is built for a non-Unix system, the file provides a tiny fallback `main`. That fallback prints a plain error message to standard error and exits with status code `1`, which conventionally means failure. Without this file, the executable would either be missing its entry point on some platforms or might fail in a more confusing way.

#### Function details

##### `main`  (lines 2–5)

```
fn main()
```

**Purpose**: On non-Unix systems, this function stops the wrapper immediately and tells the user why. It prevents someone from running a Unix-only tool on an operating system where its core process-replacement behavior is not implemented.

**Data flow**: Nothing is passed in. The function writes the message `codex-execve-wrapper is only implemented for UNIX` to standard error, then ends the process with exit code `1`. The result is that no further program logic runs.

**Call relations**: When this executable starts on a non-Unix build, this is the entry function. Its only follow-up actions are to print the error message and call the process-exit routine, so control does not return to any larger flow.

*Call graph*: 2 external calls (eprintln!, exit).


### `shell-escalation/src/unix/execve_wrapper.rs`

`entrypoint` · `startup of the execve wrapper helper process`

This file exists so the project can provide a tiny executable whose only job is to start cleanly, understand its command-line inputs, and delegate the actual shell-escalation behavior elsewhere. In Unix terms, `execve` is the low-level “run this program now” system call. This wrapper acts like a receptionist: it records how to report problems, reads who the visitor wants to see, then sends them to the right office.

The `ExecveWrapperCli` type describes the command-line shape. It expects a `file`, meaning the program path to execute or inspect, followed by any remaining arguments for that program. The `trailing_var_arg` setting is important because those later arguments belong to the target program, not to the wrapper itself.

The main function first configures tracing output, which is structured logging used for debugging and diagnostics. It reads logging settings from the environment, writes logs to standard error, and disables colored output so logs are safe for plain terminals or machine readers. Then it parses the command line, calls `run_shell_escalation_execve_wrapper` with the target file and argument list, and exits the process using the returned exit code. Without this file, the helper binary would have no clean entrypoint, no command-line parsing, and no consistent way to turn the delegated result into the process exit status.

#### Function details

##### `main_execve_wrapper`  (lines 15–25)

```
async fn main_execve_wrapper() -> anyhow::Result<()>
```

**Purpose**: This is the async entrypoint for the execve wrapper helper binary. It prepares logging, reads the target program and its arguments from the command line, runs the wrapper logic, and ends the process with the exit code produced by that logic.

**Data flow**: It starts with process-level inputs: environment variables for logging and command-line arguments for what should be wrapped. It turns the environment into a logging filter, parses the command line into a target `file` and an `argv` list, passes those to `run_shell_escalation_execve_wrapper`, waits for the result, then uses the returned number as the process exit code.

**Call relations**: When the helper executable starts, this function is called by the runtime created by `tokio::main`, which provides an asynchronous event loop. It uses Clap's parser to understand the command line, uses tracing setup functions to prepare diagnostics, hands the real shell-escalation wrapper work to `run_shell_escalation_execve_wrapper`, and finally calls `exit` so the operating system sees the intended success or failure code.

*Call graph*: 5 external calls (from_default_env, run_shell_escalation_execve_wrapper, parse, exit, fmt).


### Windows sandbox helpers
These files implement the Windows sandbox setup, elevated command runner, and wrapper protocol used to launch restricted processes.

### `windows-sandbox-rs/src/bin/command_runner/main.rs`

`entrypoint` · `startup`

This file is the front door of the `codex-command-runner` executable. Its main job is to decide, at compile time, whether the program is being built for Windows or for some other operating system. On Windows, it includes the Windows-specific `win` module and simply hands control to `win::main()`, where the real work lives. On non-Windows systems, it does not try to fake or partially support the tool; it immediately stops with a clear panic saying the command runner is Windows-only.

The important idea here is conditional compilation: the Rust compiler includes different pieces of code depending on the target operating system. That is like packing different tools in a toolbox depending on the country you are traveling to. If the target is Windows, the Windows toolbox is packed. If not, the program contains only a guard that refuses to run.

Without this file, there would be no clean entry point for the executable, and the project could accidentally appear portable when it is not. This small wrapper keeps the boundary honest: platform-independent code does not leak into a Windows-only command runner, and unsupported platforms fail loudly instead of behaving unpredictably.

#### Function details

##### `main`  (lines 10–12)

```
fn main()
```

**Purpose**: This is the program’s entry point. On Windows, it starts the real command runner by calling the Windows-specific main function; on other operating systems, it stops immediately with an error message.

**Data flow**: The operating system starts the executable, which enters `main` with no explicit input from this file. If the build target is Windows, control is passed to `win::main()`, and that function’s success or failure becomes the program’s result. If the build target is not Windows, the function produces no normal result because it panics with a message explaining that the tool is Windows-only.

**Call relations**: At startup, `main` is the first project function reached. In a Windows build, it immediately hands off to the platform-specific `main` in the `win` module, where the actual command runner behavior happens. In a non-Windows build, it instead calls `panic!` so the program cannot continue in an unsupported environment.

*Call graph*: 2 external calls (panic!, main).


### `windows-sandbox-rs/src/bin/command_runner/win.rs`

`entrypoint` · `active for the lifetime of one elevated sandbox command`

This file is the small helper program that actually runs a command inside the elevated Windows sandbox flow. Think of it as a careful stage manager: the main application gives it instructions through named pipes, and it sets up the restricted child process, watches it, and relays everything back.

At startup, it opens two named pipes supplied on the command line. A named pipe is a Windows communication channel between processes. It reads one framed message, checks that both sides speak the same protocol version, and expects that message to describe the command to run.

Before starting the command, it creates a restricted Windows token. A token is the operating system’s proof of what a process is allowed to do. This runner derives a safer token from the sandbox user, adds the requested capability identifiers, chooses the right working directory, and then starts the child either with a pseudo-terminal, called ConPTY, or with ordinary input/output pipes.

Once the child is running, the runner sends a “ready” message back to the parent. Separate threads copy stdout and stderr into output frames. Another thread listens for stdin, terminal resize, and terminate messages from the parent. The main thread waits for the process to finish or time out, cleans up Windows handles, and sends a final exit frame. Without this file, the elevated sandbox path would have no trusted worker to bridge the parent process and the restricted child process.

#### Function details

##### `OwnedWinHandle::new`  (lines 101–103)

```
fn new(handle: HANDLE) -> Self
```

**Purpose**: Wraps a raw Windows handle in a small safety guard. This helps make sure the handle is closed automatically if setup fails partway through.

**Data flow**: It receives a raw Windows handle number from the operating system. It stores that handle inside an OwnedWinHandle value. The returned wrapper now owns responsibility for closing the handle unless ownership is later transferred.

**Call relations**: Setup code calls this after opening jobs, pipes, or tokens. create_job_kill_on_close, main, and spawn_ipc_process use it so early errors do not leave operating system resources open.

*Call graph*: called by 3 (create_job_kill_on_close, main, spawn_ipc_process).


##### `OwnedWinHandle::raw`  (lines 105–107)

```
fn raw(&self) -> HANDLE
```

**Purpose**: Returns the underlying Windows handle without giving up ownership. Code uses this when a Windows API call needs to see the handle but should not take responsibility for closing it.

**Data flow**: It reads the stored handle from the wrapper and returns the raw value. Nothing is changed; the wrapper still owns the handle afterward.

**Call relations**: This is a small helper on OwnedWinHandle. It fits into the setup steps where Windows calls need a plain handle while the Rust wrapper still protects cleanup.


##### `OwnedWinHandle::into_raw`  (lines 109–115)

```
fn into_raw(mut self) -> HANDLE
```

**Purpose**: Transfers a Windows handle out of the safety wrapper. This is used when another owner, such as a File object or later cleanup code, will take responsibility for closing it.

**Data flow**: It starts with a wrapper that owns a handle. It returns the raw handle and clears the wrapper’s stored value to zero, so the wrapper will not close it when dropped.

**Call relations**: This method is used at the handoff points. For example, main opens pipe handles safely first, then transfers them into File objects after both opens succeed.


##### `OwnedWinHandle::drop`  (lines 119–125)

```
fn drop(&mut self)
```

**Purpose**: Closes the stored Windows handle when the wrapper goes out of scope. This is the cleanup safety net for failure paths.

**Data flow**: When the wrapper is being destroyed, it checks whether the stored handle looks valid. If so, it calls the Windows CloseHandle function, which releases the operating system resource.

**Call relations**: This runs automatically rather than being called by the main flow. It supports the rest of the file by preventing leaked handles when setup returns early with an error.

*Call graph*: 1 external calls (CloseHandle).


##### `create_job_kill_on_close`  (lines 128–145)

```
fn create_job_kill_on_close() -> Result<HANDLE>
```

**Purpose**: Creates a Windows job object configured to kill the child process when the job is closed. A job object is like a container for processes; this setting prevents orphaned sandbox processes from living on after the runner exits.

**Data flow**: It asks Windows for a new job object, applies the “kill on close” limit, and returns the job handle. If either Windows call fails, it returns an error instead.

**Call relations**: main calls this after spawning the child. If job creation succeeds, main assigns the child process to the job so cleanup becomes safer even if shutdown is messy.

*Call graph*: calls 1 internal fn (new); called by 1 (main); 6 external calls (anyhow!, zeroed, null, null_mut, CreateJobObjectW, SetInformationJobObject).


##### `open_pipe`  (lines 148–166)

```
fn open_pipe(name: &str, access: u32) -> Result<HANDLE>
```

**Purpose**: Opens one of the named pipes created by the parent process. The runner needs these pipes to receive commands and send results.

**Data flow**: It receives a pipe name and an access mode, such as read or write. It converts the name into Windows’ wide-character text format, asks Windows to open the pipe, and returns the handle or an error with the Windows failure code.

**Call relations**: main calls this twice at startup: once for the incoming pipe and once for the outgoing pipe. If either pipe cannot be opened, the runner cannot communicate with the parent and stops.

*Call graph*: called by 1 (main); 5 external calls (anyhow!, to_wide, null_mut, GetLastError, CreateFileW).


##### `send_error`  (lines 169–183)

```
fn send_error(writer: &Arc<StdMutex<File>>, code: &str, message: String) -> Result<()>
```

**Purpose**: Sends a structured error message back to the parent process. This lets the parent know why startup failed instead of seeing only a broken pipe or silent exit.

**Data flow**: It receives the shared output pipe writer, an error code, and a human-readable message. It builds an Error frame using the IPC protocol version, locks the writer so only one thread writes at a time, and writes the frame.

**Call relations**: main uses this when reading the spawn request or starting the child fails. It hands the failure back through the same framed-message channel used for normal output.

*Call graph*: called by 1 (main); 1 external calls (write_frame).


##### `read_spawn_request`  (lines 186–197)

```
fn read_spawn_request(reader: &mut File) -> Result<SpawnRequest>
```

**Purpose**: Reads the first instruction from the parent and verifies that it is a valid request to start a process. This prevents the runner from acting on missing, outdated, or unexpected messages.

**Data flow**: It reads one frame from the input pipe. If the pipe is closed, the protocol version is wrong, or the message is not a SpawnRequest, it returns an error. Otherwise, it extracts and returns the SpawnRequest payload.

**Call relations**: main calls this immediately after opening the pipes. Its result is the blueprint that spawn_ipc_process uses to create the restricted child process.

*Call graph*: called by 1 (main); 2 external calls (bail!, read_frame).


##### `read_acl_mutex_exists`  (lines 199–213)

```
fn read_acl_mutex_exists() -> Result<bool>
```

**Purpose**: Checks whether a special Windows mutex exists to signal that the ACL helper is active. A mutex is normally a lock, but here its presence is used like a small signpost shared between processes.

**Data flow**: It tries to open a named mutex. If Windows says the mutex file was not found, it returns false. If it opens successfully, it closes the handle and returns true. Other Windows errors become normal errors.

**Call relations**: effective_cwd calls this before deciding whether to use a junction for the working directory. That choice affects how the child sees and accesses the current directory.

*Call graph*: called by 1 (effective_cwd); 6 external calls (new, anyhow!, to_wide, CloseHandle, GetLastError, OpenMutexW).


##### `effective_cwd`  (lines 216–234)

```
fn effective_cwd(req_cwd: &Path, log_dir: Option<&Path>) -> PathBuf
```

**Purpose**: Chooses the actual working directory path to give to the child process. When the ACL helper is active, it may use a Windows junction, which is like a filesystem shortcut, to make access rules work correctly.

**Data flow**: It receives the requested current directory and an optional log directory. It checks for the ACL mutex. If the helper appears active, or if checking fails, it tries to create a junction and returns that path; otherwise it returns the requested directory unchanged.

**Call relations**: spawn_ipc_process calls this just before launching the child. If checking the mutex fails, this function logs the problem and chooses the safer junction path rather than assuming normal access will work.

*Call graph*: calls 2 internal fn (create_cwd_junction, read_acl_mutex_exists); called by 1 (spawn_ipc_process); 3 external calls (to_path_buf, log_note, format!).


##### `spawn_ipc_process`  (lines 236–348)

```
fn spawn_ipc_process(req: &SpawnRequest) -> Result<IpcSpawnedProcess>
```

**Purpose**: Builds the restricted environment and starts the child command. This is the heart of the runner: it turns the parent’s SpawnRequest into a real Windows process with limited permissions.

**Data flow**: It receives a SpawnRequest containing the command, working directory, environment, permission profile, terminal choice, and capability SIDs. It hides the current user profile path, chooses a token mode, converts capability SID strings into Windows SID values, creates a restricted token, adjusts access to the null device, chooses the effective working directory, and starts the child either through ConPTY for terminal mode or through normal pipes. It returns an IpcSpawnedProcess containing the process information and the handles needed for stdin, stdout, stderr, and terminal resizing.

**Call relations**: main calls this after successfully reading the spawn request. It relies on effective_cwd and lower-level sandbox token and process-spawning helpers, then hands main all the pieces needed to stream data and wait for completion.

*Call graph*: calls 3 internal fn (new, effective_cwd, from_string); called by 1 (main); 11 external calls (new, bail!, allow_null_device, create_readonly_token_with_caps_and_user_from, create_workspace_write_token_with_caps_and_user_from, get_current_token_for_restriction, hide_current_user_profile_dir, spawn_conpty_process_as_user, spawn_process_with_pipes, token_mode_for_permission_profile (+1 more)).


##### `spawn_output_reader`  (lines 351–376)

```
fn spawn_output_reader(
    writer: Arc<StdMutex<File>>,
    handle: HANDLE,
    stream: OutputStream,
    log_dir: Option<PathBuf>,
) -> std::thread::JoinHandle<()>
```

**Purpose**: Starts a background thread that reads output from the child and sends it to the parent as Output frames. It is used for stdout and, when available, stderr.

**Data flow**: It receives the shared output writer, a Windows handle to read from, which stream the data belongs to, and an optional log directory. The background reader takes chunks from the handle, base64-encodes the bytes so they can safely travel inside the framed message format, and writes each chunk to the parent. If writing fails, it logs a note.

**Call relations**: main calls this after sending SpawnReady. One reader is started for stdout, and another may be started for stderr; both share the same locked writer so their frames do not collide.

*Call graph*: called by 1 (main); 1 external calls (read_handle_loop).


##### `spawn_input_loop`  (lines 379–497)

```
fn spawn_input_loop(
    mut reader: File,
    stdin_handle: Option<HANDLE>,
    hpc_handle: Arc<StdMutex<Option<HANDLE>>>,
    process_handle: Arc<StdMutex<Option<HANDLE>>>,
    log_dir: Option<PathB
```

**Purpose**: Starts a background thread that listens for instructions from the parent while the child is running. It forwards stdin, handles terminal resize requests, and can terminate the child.

**Data flow**: It receives the input pipe reader, the child’s optional stdin handle, shared access to the ConPTY handle, shared access to the process handle, and an optional log directory. The thread reads framed messages in a loop. Stdin messages are decoded and written fully to the child’s stdin, CloseStdin closes that input handle, Resize changes the pseudo-terminal size when one exists, and Terminate calls Windows to stop the process. At the end, any still-open stdin handle is closed.

**Call relations**: main starts this loop after the output readers are running. It runs alongside the main wait operation, so the parent can keep interacting with the child while main waits for exit or timeout.

*Call graph*: called by 1 (main); 1 external calls (spawn).


##### `main`  (lines 500–653)

```
fn main() -> Result<()>
```

**Purpose**: Runs the entire command-runner process from start to finish. It connects to the parent, starts the sandboxed child, relays communication, waits for completion, and exits with the child’s exit code.

**Data flow**: It reads command-line arguments for the input and output pipe names. It opens those pipes, reads the SpawnRequest, starts the restricted child process, optionally creates a kill-on-close job object, sends SpawnReady, starts output and input threads, waits for the child or a timeout, terminates on timeout, collects the exit code, closes process and job handles, drops terminal resources, waits for output threads to finish, sends the final Exit frame, and then exits the runner process with the same code.

**Call relations**: This is the entry point for the elevated sandbox runner. It calls the helper functions in this file in order: open communication, validate the request, spawn the child, set up cleanup protection, run the data relay threads, and finally report the result to the parent.

*Call graph*: calls 8 internal fn (new, create_job_kill_on_close, open_pipe, read_spawn_request, send_error, spawn_input_loop, spawn_ipc_process, spawn_output_reader); 16 external calls (clone, new, from_raw_handle, new, bail!, log_note, write_frame, format!, args, exit (+6 more)).


### `windows-sandbox-rs/src/bin/setup_main/main.rs`

`entrypoint` · `startup`

This is the front door for the `codex-windows-sandbox-setup` program. Its job is deliberately small: decide whether the program is being built for Windows, then either hand control to the Windows-specific setup code or stop immediately.

On Windows, the file includes a separate `win` module and calls `win::main()`. That keeps the operating-system-specific work out of this launcher, like a receptionist sending the visitor to the right specialist. The Windows setup logic can then use Windows APIs without cluttering this top-level file.

On non-Windows systems, the program does not try to run at all. It panics with a clear message saying the setup tool is Windows-only. A panic means the program stops because it has reached a situation it is not designed to support. This matters because setup code for a Windows sandbox would be meaningless, and possibly misleading, on Linux or macOS.

The important behavior is that the choice is made at compile time using Rust's conditional compilation. In plain terms, Rust includes only the version of the code that matches the target operating system.

#### Function details

##### `main`  (lines 10–12)

```
fn main()
```

**Purpose**: This is the program's starting point. On Windows, it starts the real setup routine; on other operating systems, it stops with a clear error because this setup tool is not meant to run there.

**Data flow**: Nothing is passed in directly. If the program is built for Windows, control is passed to the Windows-specific `win::main()` function, and its success or failure result becomes the program's result. If it is built for a non-Windows system, the function produces no normal result because it immediately panics with a Windows-only message.

**Call relations**: When the operating system matches Windows, this entrypoint hands off to the platform-specific setup code in `win::main()`. When the operating system is not Windows, it calls `panic!` instead, ending the run before any setup work can happen.

*Call graph*: 2 external calls (panic!, main).


### `windows-sandbox-rs/src/bin/setup_main/win.rs`

`entrypoint` · `sandbox setup before command execution, with refresh helpers during setup`

This file is the Windows-only entry point for preparing the Codex sandbox before a command runs. The sandbox depends on ordinary Windows security tools: user accounts, security identifiers called SIDs (Windows IDs for users or groups), ACLs (access control lists on files and folders), and firewall/WFP rules (network filtering rules). Without this setup, the sandbox users might not exist, might be able to read or write the wrong files, or might reach the network when they are supposed to be offline.

The helper receives one encoded payload from its caller. That payload says which sandbox users to use, where Codex stores its own files, which folders should be readable or writable, which paths must be protected, and which local proxy ports are allowed. The file then chooses one of three modes: full setup, user/network provisioning only, or read-permission refresh only.

A full setup provisions sandbox users, configures the offline user’s network restrictions, applies deny-read protections immediately, starts a background helper to add broader read permissions, grants write permissions for approved workspace roots, applies deny-write carveouts, and locks down Codex’s own sandbox folders. It logs each important step and writes a structured error report if setup fails. The design is like preparing a rented workshop: create the worker badges, lock the private cabinets, open only the right tool drawers, and block outside phone calls except through approved lines.

#### Function details

##### `log_line`  (lines 114–123)

```
fn log_line(log: &mut dyn Write, msg: &str) -> Result<()>
```

**Purpose**: Writes one timestamped message to the setup log. It turns a logging failure into a setup-specific error so the caller can tell that even recording progress failed.

**Data flow**: It receives a writable log destination and a text message. It adds the current UTC time, writes the combined line, and returns success; if the write fails, it returns a structured helper-log failure.

**Call relations**: The setup flow calls this whenever it needs a durable note about what happened. Permission refresh, ACL checks, top-level error handling, and the full setup path all use it so later troubleshooting has a clear timeline.

*Call graph*: called by 5 (apply_read_acls, read_mask_allows_or_log, real_main, run_read_acl_only, run_setup_full); 2 external calls (now, writeln!).


##### `workspace_write_cap_sids_for_path`  (lines 125–159)

```
fn workspace_write_cap_sids_for_path(
    codex_home: &Path,
    command_cwd: &Path,
    write_roots: &[PathBuf],
    path: &Path,
) -> Result<Vec<String>>
```

**Purpose**: Finds which write-capability SIDs should be denied for a protected path. A capability SID is a Windows security identity used here like a special key for one writable workspace root.

**Data flow**: It receives Codex’s home folder, the command’s working folder, the active write roots, and the path being protected. It checks which write roots overlap that path and returns the matching capability SID strings; if none match, it falls back to the default workspace capability or all active root capabilities so protection is still applied.

**Call relations**: The full setup path uses this when applying deny-write rules. The tests exercise edge cases so deny rules attach to the right active roots instead of stale or unrelated roots.

*Call graph*: called by 4 (run_setup_full, deny_path_includes_nested_active_root_sid, deny_path_outside_active_roots_falls_back_to_all_active_root_sids, deny_path_under_active_root_uses_only_matching_root_sid); 4 external calls (is_empty, new, workspace_write_cap_sid_for_root, workspace_write_root_overlaps_path).


##### `spawn_read_acl_helper`  (lines 161–177)

```
fn spawn_read_acl_helper(payload: &Payload, _log: &mut dyn Write) -> Result<()>
```

**Purpose**: Starts a second copy of this setup helper in the background to add read permissions. This keeps the main setup from waiting on potentially slow read-permission work.

**Data flow**: It copies the setup payload, changes it to read-ACL-only refresh mode, serializes it as JSON, encodes it with base64, then launches the current executable with that encoded payload and no visible window. It returns once the child process has been started.

**Call relations**: The full setup path calls this after required deny-read protections are already applied. The child later enters the same program but is routed by mode into the read-only ACL refresh path.

*Call graph*: called by 1 (run_setup_full); 5 external calls (null, new, to_vec, current_exe, clone).


##### `apply_read_acls`  (lines 184–255)

```
fn apply_read_acls(
    read_roots: &[PathBuf],
    subjects: &ReadAclSubjects<'_>,
    log: &mut dyn Write,
    refresh_errors: &mut Vec<String>,
    access_mask: u32,
    access_label: &str,
    inh
```

**Purpose**: Makes sure sandbox users can read and execute the allowed read roots. It avoids changing a folder if ordinary built-in Windows groups already provide the needed access.

**Data flow**: It receives a list of read roots, the Windows identities to check, a log, a shared error list, and the permission bits to require. For each existing root, it checks whether common built-in groups or the sandbox group already have the needed access; if not, it adds an inheritable allow rule for the sandbox group and records any failures.

**Call relations**: The read-ACL-only mode calls this after resolving the sandbox group and common Windows groups. It relies on read_mask_allows_or_log for safe permission checks and then hands off to the lower-level ACL function that actually writes Windows permissions.

*Call graph*: calls 2 internal fn (log_line, read_mask_allows_or_log); called by 1 (run_read_acl_only); 2 external calls (ensure_allow_mask_aces_with_inheritance, format!).


##### `read_mask_allows_or_log`  (lines 257–290)

```
fn read_mask_allows_or_log(
    root: &Path,
    psids: &[*mut c_void],
    label: Option<&str>,
    read_mask: u32,
    access_label: &str,
    refresh_errors: &mut Vec<String>,
    log: &mut dyn Wri
```

**Purpose**: Checks whether a path already grants a required permission mask, while treating check failures as recoverable. This helps setup continue instead of stopping at the first unreadable or unusual folder.

**Data flow**: It receives a path, one or more Windows identity pointers, a label for logging, the required permission bits, the shared error list, and the log. It asks Windows permission helpers whether access is already allowed; on success it returns true or false, and on check failure it logs the problem, records it, and returns false so the caller may try to repair access.

**Call relations**: apply_read_acls calls this twice per root: first for broad built-in groups, then for the sandbox group. Its result decides whether an ACL grant is needed.

*Call graph*: calls 1 internal fn (log_line); called by 1 (apply_read_acls); 2 external calls (path_mask_allows, format!).


##### `lock_sandbox_dir`  (lines 292–387)

```
fn lock_sandbox_dir(
    dir: &Path,
    real_user: &str,
    sandbox_group_sid: &[u8],
    sandbox_group_access_mode: i32,
    sandbox_group_mask: u32,
    real_user_mask: u32,
    _log: &mut dyn Wri
```

**Purpose**: Creates a sandbox-owned folder if needed and replaces its Windows access rules with a strict set. This protects Codex’s own sandbox files from the wrong users while still letting required accounts work.

**Data flow**: It receives the folder path, the real user name, the sandbox group SID, the sandbox group access mode and permission mask, and the real user’s permission mask. It resolves SYSTEM, Administrators, and the real user to SIDs, builds Windows ACL entries for all of them, applies those entries to the folder, and frees the temporary Windows memory it allocated.

**Call relations**: The folder-locking helpers call this for the main sandbox directory, secrets directory, and runtime binary directory. It is the low-level routine that turns the project’s desired policy into actual Windows folder security settings.

*Call graph*: calls 1 internal fn (resolve_sid); called by 2 (lock_persistent_sandbox_dirs, lock_sandbox_bin_dir); 12 external calls (new, as_os_str, new, anyhow!, string_from_sid_bytes, to_wide, create_dir_all, null_mut, LocalFree, ConvertStringSidToSidW (+2 more)).


##### `main`  (lines 389–407)

```
fn main() -> Result<()>
```

**Purpose**: Runs the Windows setup helper and adds a final safety net for unexpected top-level failures. It is the public entry point of this binary module.

**Data flow**: It calls the real setup function. If setup returns an error, it tries to find CODEX_HOME from the environment, create the sandbox log directory, and write a best-effort top-level error line before returning the original result.

**Call relations**: The operating system starts here. It immediately delegates normal work to real_main, but catches failures that happen too early or too broadly for the usual error-reporting path.

*Call graph*: calls 1 internal fn (real_main); 6 external calls (new, log_writer, sandbox_dir, var, create_dir_all, writeln!).


##### `real_main`  (lines 409–477)

```
fn real_main() -> Result<()>
```

**Purpose**: Reads and validates the setup request, opens logging, runs setup, and records a structured failure report if anything goes wrong.

**Data flow**: It expects exactly one command-line argument: a base64-encoded JSON payload. It decodes and parses that payload, checks the setup version, creates the sandbox directory, opens the setup log, and calls run_setup. If run_setup fails, it logs the error, extracts or creates a setup failure code and message, and writes an error report under Codex home.

**Call relations**: main calls this as the main body of the program. Once it has turned the raw command-line argument into a trusted Payload, it hands control to run_setup for mode-specific work.

*Call graph*: calls 3 internal fn (log_line, run_setup, new); called by 1 (main); 10 external calls (new, extract_setup_failure, log_note, log_writer, sandbox_dir, write_setup_error_report, format!, from_slice, args, create_dir_all).


##### `run_setup`  (lines 479–499)

```
fn run_setup(payload: &Payload, log: &mut dyn Write, sbx_dir: &Path) -> Result<()>
```

**Purpose**: Chooses which kind of setup to perform and wraps full/provisioning runs with a setup marker. The marker lets other parts of the system know whether setup completed cleanly.

**Data flow**: It receives the parsed payload, log, and sandbox directory. If this run should update setup state, it prepares a marker, dispatches to read-ACL-only, provision-only, or full setup based on the payload mode, then commits the marker with the final sandbox user and proxy settings.

**Call relations**: real_main calls this after decoding the request. It is the dispatcher that routes the request to run_read_acl_only, run_provision_only, or run_setup_full.

*Call graph*: calls 5 internal fn (run_provision_only, run_read_acl_only, run_setup_full, commit_setup_marker, prepare_setup_marker); called by 1 (real_main).


##### `run_read_acl_only`  (lines 501–562)

```
fn run_read_acl_only(payload: &Payload, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Runs only the read-permission refresh portion of setup. This is used by the background helper so full setup can continue while read ACLs are added.

**Data flow**: It first tries to acquire a mutex, which is a lock that prevents two read-ACL helpers from running at once. If it gets the lock, it resolves the sandbox group and common Windows group SIDs, converts them to Windows pointer form, calls apply_read_acls for the requested read roots, frees the Windows pointers, and fails only if refresh-only mode collected errors.

**Call relations**: run_setup calls this when the payload mode is read-acls-only. In the normal full setup story, run_setup_full spawns a second helper process, and that helper re-enters the program and lands here.

*Call graph*: calls 6 internal fn (apply_read_acls, log_line, acquire_read_acl_mutex, resolve_sandbox_users_group_sid, resolve_sid, sid_bytes_to_psid); called by 1 (run_setup); 5 external calls (new, bail!, format!, vec!, LocalFree).


##### `provision_and_hide_sandbox_users`  (lines 564–590)

```
fn provision_and_hide_sandbox_users(
    payload: &Payload,
    log: &mut dyn Write,
    sbx_dir: &Path,
) -> Result<()>
```

**Purpose**: Creates or updates the two sandbox Windows users and hides newly created accounts from normal user-facing places. This keeps the sandbox accounts available to the system but less visible to humans.

**Data flow**: It receives the payload, log, and sandbox directory. It asks the sandbox user module to provision the offline and online users; if that fails, it wraps unknown errors in a setup-specific user-provisioning failure. Then it passes both usernames to the hiding helper.

**Call relations**: Both provision-only and full setup call this before depending on the sandbox users. Later steps resolve those users’ SIDs and attach file and network rules to them.

*Call graph*: calls 2 internal fn (provision_sandbox_users, new); called by 2 (run_provision_only, run_setup_full); 5 external calls (new, extract_setup_failure, hide_newly_created_users, format!, vec!).


##### `configure_offline_sandbox_network`  (lines 592–631)

```
fn configure_offline_sandbox_network(
    payload: &Payload,
    offline_sid_str: &str,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Applies the network rules for the offline sandbox user. It allows only approved local proxy access and blocks ordinary outbound network traffic.

**Data flow**: It receives the payload, the offline user SID as text, and the log. It creates or updates firewall allow rules for the requested proxy ports, creates or updates an outbound block rule, and installs lower-level WFP filters while logging messages from that installer.

**Call relations**: Provision-only and full setup call this after resolving the offline user SID. It delegates the firewall pieces to the firewall module and the deeper Windows Filtering Platform setup to the shared sandbox library.

*Call graph*: calls 3 internal fn (ensure_offline_outbound_block, ensure_offline_proxy_allowlist, new); called by 2 (run_provision_only, run_setup_full); 4 external calls (new, extract_setup_failure, install_wfp_filters, format!).


##### `lock_persistent_sandbox_dirs`  (lines 633–679)

```
fn lock_persistent_sandbox_dirs(
    payload: &Payload,
    sandbox_group_sid: &[u8],
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Locks down Codex’s persistent sandbox folders, including the secrets folder. This prevents sandbox users from reading secrets while still allowing the real user and system accounts to use needed files.

**Data flow**: It receives the payload, sandbox group SID, and log. It locks the main sandbox directory with access for the sandbox group, locks the secrets directory with denied access for the sandbox group, and removes an old legacy sandbox-users file if it still exists.

**Call relations**: Provision-only and full setup call this near the end of setup. It uses lock_sandbox_dir to apply the actual Windows ACLs for each folder.

*Call graph*: calls 1 internal fn (lock_sandbox_dir); called by 2 (run_provision_only, run_setup_full); 3 external calls (sandbox_dir, sandbox_secrets_dir, remove_file).


##### `lock_sandbox_bin_dir`  (lines 681–704)

```
fn lock_sandbox_bin_dir(
    payload: &Payload,
    sandbox_group_sid: &[u8],
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Locks down the directory that contains sandbox runtime binaries. Sandbox users are allowed to read and execute these files, but not rewrite them.

**Data flow**: It receives the payload, sandbox group SID, and log. It locates the sandbox binary directory under Codex home and calls lock_sandbox_dir with read-and-execute permissions for the sandbox group and broader permissions for the real user.

**Call relations**: Provision-only and full setup both call this before considering setup complete. It relies on lock_sandbox_dir for the low-level Windows security update.

*Call graph*: calls 1 internal fn (lock_sandbox_dir); called by 2 (run_provision_only, run_setup_full); 1 external calls (sandbox_bin_dir).


##### `run_provision_only`  (lines 706–732)

```
fn run_provision_only(payload: &Payload, log: &mut dyn Write, sbx_dir: &Path) -> Result<()>
```

**Purpose**: Performs the parts of setup that create users, configure network policy, and lock Codex-owned sandbox directories, without touching per-command workspace ACLs.

**Data flow**: It provisions and hides sandbox users, resolves the offline user SID and sandbox group SID, converts the offline SID to text, configures the offline network restrictions, locks the runtime binary directory, locks persistent sandbox directories, logs completion, and returns success or a setup-specific error.

**Call relations**: run_setup calls this when the payload asks for provision-only mode. It is useful when the system needs durable sandbox accounts and protections prepared separately from a specific command’s read/write roots.

*Call graph*: calls 6 internal fn (configure_offline_sandbox_network, lock_persistent_sandbox_dirs, lock_sandbox_bin_dir, provision_and_hide_sandbox_users, resolve_sandbox_users_group_sid, resolve_sid); called by 1 (run_setup); 2 external calls (log_note, string_from_sid_bytes).


##### `run_setup_full`  (lines 734–1033)

```
fn run_setup_full(payload: &Payload, log: &mut dyn Write, sbx_dir: &Path) -> Result<()>
```

**Purpose**: Performs the complete sandbox preparation for a command. It combines user setup, network policy, read and write file permissions, deny rules, and Codex directory lockdown.

**Data flow**: It receives the payload, log, and sandbox directory. If this is not a refresh, it provisions users and configures network restrictions. It resolves needed SIDs, applies deny-read ACLs synchronously, starts the background read-ACL helper if needed, refreshes runtime-bin readability when appropriate, checks and grants write ACLs for active write roots, applies deny-write carveouts to protected paths, locks sandbox binary and persistent directories, frees Windows SID pointers, and fails refresh mode if any collected refresh errors remain.

**Call relations**: run_setup calls this for normal full setup. It is the central workflow: it calls the smaller helpers in this file for users, network, logging, and directory locks, and calls shared Windows-sandbox library functions for the actual ACL and SID operations.

*Call graph*: calls 12 internal fn (configure_offline_sandbox_network, lock_persistent_sandbox_dirs, lock_sandbox_bin_dir, log_line, provision_and_hide_sandbox_users, read_acl_mutex_exists, resolve_sandbox_users_group_sid, resolve_sid, sid_bytes_to_psid, ensure_codex_app_runtime_bin_readable (+2 more)); called by 1 (run_setup); 16 external calls (new, new, bail!, add_deny_write_ace, canonicalize_path, convert_string_sid_to_sid, is_command_cwd_root, log_note, path_mask_allows, string_from_sid_bytes (+6 more)).


##### `tests::payload_json`  (lines 1047–1059)

```
fn payload_json() -> serde_json::Value
```

**Purpose**: Builds a minimal valid setup payload for tests. It gives the test cases a shared starting request that matches the current setup version.

**Data flow**: It creates a JSON object with required fields such as usernames, Codex home, command working directory, empty roots, proxy ports, and real user. The JSON value is returned to individual tests, which may modify it.

**Call relations**: The payload parsing tests call this helper instead of repeating the same JSON. It keeps those tests focused on the specific optional field or mode they are checking.

*Call graph*: 1 external calls (json!).


##### `tests::payload_defaults_otel_absent`  (lines 1062–1066)

```
fn payload_defaults_otel_absent()
```

**Purpose**: Checks that the optional telemetry settings are absent by default when the payload does not include them.

**Data flow**: It builds the default test JSON, parses it into a Payload, and compares the payload’s otel field with None.

**Call relations**: The Rust test runner invokes this test. It protects the contract that callers do not have to send telemetry settings.

*Call graph*: 3 external calls (assert_eq!, from_value, payload_json).


##### `tests::payload_accepts_provision_only_mode`  (lines 1069–1075)

```
fn payload_accepts_provision_only_mode()
```

**Purpose**: Checks that the payload accepts the text form of provision-only mode. This guards the command-line request format used by the caller.

**Data flow**: It starts with the shared payload JSON, sets the mode field to "provision-only", parses it into a Payload, and verifies that the resulting mode is SetupMode::ProvisionOnly.

**Call relations**: The Rust test runner invokes this test. It confirms that run_setup can later dispatch provision-only requests that arrive through JSON.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, payload_json).


##### `tests::payload_accepts_otel_settings`  (lines 1078–1091)

```
fn payload_accepts_otel_settings()
```

**Purpose**: Checks that telemetry settings can be included in the setup payload. Telemetry here means configuration for reporting metrics about setup behavior.

**Data flow**: It adds an otel object with an environment value to the shared payload JSON, parses it into a Payload, and verifies that the parsed settings match the expected StatsigMetricsSettings value.

**Call relations**: The Rust test runner invokes this test. It supports the later path where configure_offline_sandbox_network passes optional telemetry settings into WFP filter installation.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, payload_json).


##### `tests::deny_path_under_active_root_uses_only_matching_root_sid`  (lines 1094–1127)

```
fn deny_path_under_active_root_uses_only_matching_root_sid()
```

**Purpose**: Checks that a protected path inside one active write root is denied only for that root’s capability SID. This prevents unrelated or stale write roots from being affected.

**Data flow**: It creates temporary Codex, workspace, active-root, stale-root, and deny-path folders. It computes capability SIDs for the roots, asks workspace_write_cap_sids_for_path which SIDs apply to the deny path, and asserts that only the active root SID is returned.

**Call relations**: The Rust test runner invokes this test. It directly exercises the helper used by run_setup_full before deny-write ACLs are applied.

*Call graph*: calls 1 internal fn (workspace_write_cap_sids_for_path); 6 external calls (assert!, assert_eq!, load_or_create_cap_sids, workspace_write_cap_sid_for_root, create_dir_all, tempdir).


##### `tests::deny_path_outside_active_roots_falls_back_to_all_active_root_sids`  (lines 1130–1164)

```
fn deny_path_outside_active_roots_falls_back_to_all_active_root_sids()
```

**Purpose**: Checks the fallback behavior for a protected path that is outside every active write root. In that case, all active write capabilities should be denied so no active writer can bypass the protection.

**Data flow**: It creates temporary folders for Codex home, workspace, active root, stale root, and an outside deny path. It computes several capability SIDs, asks workspace_write_cap_sids_for_path for the applicable ones, and verifies that the active workspace and active root SIDs are included while stale or generic saved capabilities are not.

**Call relations**: The Rust test runner invokes this test. It protects the conservative fallback used by run_setup_full when preparing deny-write ACLs.

*Call graph*: calls 1 internal fn (workspace_write_cap_sids_for_path); 6 external calls (assert!, assert_eq!, load_or_create_cap_sids, workspace_write_cap_sid_for_root, create_dir_all, tempdir).


##### `tests::deny_path_includes_nested_active_root_sid`  (lines 1167–1191)

```
fn deny_path_includes_nested_active_root_sid()
```

**Purpose**: Checks that nested active write roots are included when protecting a parent path. This matters when a writable sub-root sits inside a normally protected directory.

**Data flow**: It creates a temporary workspace, a protected directory under it, and a nested active root inside that protected directory. It computes the workspace and nested-root capability SIDs, asks workspace_write_cap_sids_for_path for the protected directory, and verifies that both SIDs are returned in order.

**Call relations**: The Rust test runner invokes this test. It ensures run_setup_full denies write access for every active capability that overlaps a protected path, including nested roots.

*Call graph*: calls 1 internal fn (workspace_write_cap_sids_for_path); 4 external calls (assert_eq!, workspace_write_cap_sid_for_root, create_dir_all, tempdir).


### `windows-sandbox-rs/src/wrapper.rs`

`entrypoint` · `sandbox launch`

This file exists so code that can only launch a normal executable can still ask Codex to run something in the Windows sandbox. Think of it like a shipping label: one side writes all the safety instructions, paths, environment variables, and the real command onto the label; the other side reads the label and launches the package in the right protected room.

The first half builds the special argument list used to re-run `codex.exe` with `--run-as-windows-sandbox`. That list includes the working folder, workspace roots, Codex home folder, environment variables, permission profile, sandbox level, optional read/write allow-lists, deny-lists, and finally the actual command after a `--` separator.

The second half is the wrapper entry path. It skips the already-known leading arguments, creates a small asynchronous runtime, parses the wrapper arguments into a structured request, and starts the Windows sandbox session. Once the sandboxed command is running, this file forwards standard input, output, and error, so the caller experiences it much like a directly spawned process.

Important checks happen during parsing: required flags must be present, key paths must be absolute, JSON values must be valid, and the sandbox level must be one of the known choices. Without this file, direct-spawn callers would not have a simple argv-shaped way to launch Windows sandboxed commands.

#### Function details

##### `create_windows_sandbox_command_args_for_permission_profile`  (lines 37–111)

```
fn create_windows_sandbox_command_args_for_permission_profile(
    command: Vec<String>,
    command_cwd: &AbsolutePathBuf,
    workspace_roots: &[AbsolutePathBuf],
    env_map: &HashMap<String, Strin
```

**Purpose**: Builds the full list of command-line arguments needed to re-run Codex as the Windows sandbox wrapper. Callers use this when they want to launch a command through the sandbox but can only pass ordinary process arguments.

**Data flow**: It receives the real command, working directory, workspace roots, environment map, permission settings, sandbox level, optional path overrides, deny-lists, and Codex home path. It turns structured data such as the permission profile and environment into JSON strings, adds flags in the format the wrapper parser expects, supplies the command working directory as the workspace root if no roots were given, and appends the real command after `--`. The output is a `Vec<String>` ready to pass as process arguments.

**Call relations**: This is the producer side of the wrapper protocol. It calls `push_json_arg` for optional JSON-encoded path lists, and the arguments it creates are later understood by `parse_windows_sandbox_wrapper_args` when the wrapper process starts.

*Call graph*: calls 1 internal fn (push_json_arg); 4 external calls (to_string, from_ref, is_empty, vec!).


##### `push_json_arg`  (lines 113–119)

```
fn push_json_arg(args: &mut Vec<String>, flag: &str, value: &T)
```

**Purpose**: Adds one flag plus one JSON-encoded value to an argument list. It is a small helper that keeps JSON flag formatting consistent.

**Data flow**: It receives a mutable argument list, a flag name, and any value that can be serialized to JSON. It appends the flag, converts the value into a JSON string, and appends that string too. The argument list is changed in place; there is no separate return value.

**Call relations**: `create_windows_sandbox_command_args_for_permission_profile` calls this whenever it needs to include optional lists, such as read roots, write roots, or denied paths. It hides the repeated serialize-and-push pattern from the larger argument-building function.

*Call graph*: called by 1 (create_windows_sandbox_command_args_for_permission_profile); 1 external calls (to_string).


##### `run_windows_sandbox_wrapper_main`  (lines 121–141)

```
fn run_windows_sandbox_wrapper_main() -> !
```

**Purpose**: Acts as the wrapper's process entry point. It sets up the async runtime, runs the wrapper request, reports any error to standard error, and exits with the sandboxed command's exit code or `1` on failure.

**Data flow**: It reads the current process arguments and skips the first two entries, because the executable name and sandbox marker have already been consumed by the outer Codex dispatch. It creates a single-thread async runtime, runs `run_windows_sandbox_wrapper_args`, and receives an exit code or an error. It then terminates the process with that code, printing a human-readable error first if setup or execution failed.

**Call relations**: This is where the wrapper path begins once Codex has detected `--run-as-windows-sandbox`. It hands the remaining arguments to `run_windows_sandbox_wrapper_args`, which does the parse-and-run work underneath.

*Call graph*: calls 1 internal fn (run_windows_sandbox_wrapper_args); 4 external calls (eprintln!, args, exit, new_current_thread).


##### `run_windows_sandbox_wrapper_args`  (lines 143–146)

```
async fn run_windows_sandbox_wrapper_args(args: Vec<String>) -> Result<i32>
```

**Purpose**: Turns raw wrapper arguments into a sandbox request and runs it. This separates argument parsing from the actual sandbox launch.

**Data flow**: It receives a list of strings from the command line. First it calls `parse_windows_sandbox_wrapper_args` to validate and organize them into a `WindowsSandboxWrapperRequest`. Then it passes that request to `run_windows_sandbox_wrapper_request`. The result is either the sandboxed command's exit code or an error explaining why the wrapper could not run.

**Call relations**: `run_windows_sandbox_wrapper_main` calls this inside the async runtime. It is the bridge between the outer entry point and the lower-level request runner.

*Call graph*: calls 2 internal fn (parse_windows_sandbox_wrapper_args, run_windows_sandbox_wrapper_request); called by 1 (run_windows_sandbox_wrapper_main).


##### `run_windows_sandbox_wrapper_request`  (lines 165–192)

```
async fn run_windows_sandbox_wrapper_request(request: WindowsSandboxWrapperRequest) -> Result<i32>
```

**Purpose**: Starts the actual Windows sandbox session for the parsed request and forwards the sandboxed command's input and output. This is the point where validated settings become a running protected process.

**Data flow**: It receives a structured request containing the command, folders, environment variables, permissions, sandbox level, and optional path rules. If the command is empty, it returns an error. Otherwise it builds a `WindowsSandboxSessionRequest`, asks the crate-level sandbox launcher to spawn it, then forwards standard input, output, and error until the sandboxed command finishes. The returned value is the command's exit code.

**Call relations**: `run_windows_sandbox_wrapper_args` calls this after parsing succeeds. It hands the real launch work to `spawn_windows_sandbox_session_for_level`, then hands the running session to `forward_sandbox_session_stdio` so the caller can interact with it like a normal child process.

*Call graph*: called by 1 (run_windows_sandbox_wrapper_args); 3 external calls (bail!, forward_sandbox_session_stdio, spawn_windows_sandbox_session_for_level).


##### `parse_windows_sandbox_wrapper_args`  (lines 194–292)

```
fn parse_windows_sandbox_wrapper_args(args: Vec<String>) -> Result<WindowsSandboxWrapperRequest>
```

**Purpose**: Reads the wrapper's command-line flags and turns them into a checked, structured request. It protects the rest of the sandbox code from missing flags, malformed JSON, invalid paths, and unknown options.

**Data flow**: It receives raw argument strings. It walks through them one by one, collecting required values such as Codex home, command working directory, environment JSON, permission profile JSON, sandbox level, and the command after `--`. It also collects optional switches and path lists. It checks that required fields are present, that certain paths are absolute, and that JSON fields can be decoded. The output is a `WindowsSandboxWrapperRequest`; on bad input, it returns a clear error instead.

**Call relations**: `run_windows_sandbox_wrapper_args` calls this before any sandbox is launched. During parsing it uses `next_flag_value` to fetch flag values, `absolute_path_arg` to validate absolute paths, `json_flag_value` for generic JSON lists, and `parse_windows_sandbox_level` for the sandbox level string.

*Call graph*: calls 4 internal fn (absolute_path_arg, json_flag_value, next_flag_value, parse_windows_sandbox_level); called by 1 (run_windows_sandbox_wrapper_args); 4 external calls (from, new, bail!, from_str).


##### `next_flag_value`  (lines 294–297)

```
fn next_flag_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String>
```

**Purpose**: Gets the value that should immediately follow a command-line flag. It gives a clear error if a flag is present but its value is missing.

**Data flow**: It receives the argument iterator and the flag name being processed. It asks for the next string from the iterator. If there is one, that string is returned; if not, it returns an error naming the flag that needed a value.

**Call relations**: `parse_windows_sandbox_wrapper_args` calls this whenever it sees a flag such as `--command-cwd` or `--env-json` that must be followed by a value. This keeps missing-value errors consistent across all flags.

*Call graph*: called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (next).


##### `absolute_path_arg`  (lines 299–303)

```
fn absolute_path_arg(value: String, flag: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Converts a path string from the command line into an absolute path type. It is used for paths that must not depend on the current process's location.

**Data flow**: It receives a string value and the flag it came from. It builds a path from the string, checks that the path is absolute, and returns an `AbsolutePathBuf` if the check passes. If the path is relative, it returns an error that includes the flag name and the bad path.

**Call relations**: `parse_windows_sandbox_wrapper_args` calls this for the command working directory and workspace roots. That means the later sandbox launch code can trust those paths are already absolute.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (from).


##### `json_flag_value`  (lines 305–307)

```
fn json_flag_value(value: String, flag: &str) -> Result<T>
```

**Purpose**: Parses a JSON string supplied after a flag into the expected Rust value. It is used for wrapper options that carry lists or other structured data.

**Data flow**: It receives the raw JSON string and the flag name. It asks the JSON parser to decode the string into the caller's expected type. On success, it returns that decoded value; on failure, it returns an error that says which flag could not be parsed.

**Call relations**: `parse_windows_sandbox_wrapper_args` calls this for JSON-based path override and deny-list flags. This keeps JSON parsing errors tied to the exact command-line option that caused them.

*Call graph*: called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (from_str).


##### `parse_windows_sandbox_level`  (lines 309–316)

```
fn parse_windows_sandbox_level(value: &str) -> Result<WindowsSandboxLevel>
```

**Purpose**: Turns the sandbox level text from the command line into the internal sandbox level value. It accepts only the known level names.

**Data flow**: It receives a string such as `disabled`, `restricted-token`, or `elevated`. It matches that text to the corresponding `WindowsSandboxLevel` value. If the text is not recognized, it returns an error instead of guessing.

**Call relations**: `parse_windows_sandbox_wrapper_args` calls this after reading `--windows-sandbox-level`. The parsed value is later used by `run_windows_sandbox_wrapper_request` when choosing how to spawn the Windows sandbox session.

*Call graph*: called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (bail!).
