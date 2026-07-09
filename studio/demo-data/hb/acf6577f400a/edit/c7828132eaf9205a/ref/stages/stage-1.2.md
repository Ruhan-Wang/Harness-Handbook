# Auxiliary binaries and developer tools  `stage-1.2`

This stage is a toolbox of small programs that support the rest of the system. They are not the main everyday command path. Instead, they help developers generate files, inspect behavior, run test servers, or launch special helper processes.

One group creates shared descriptions of data formats. The config schema tools write the JSON Schema for config.toml, and the protocol and hooks exporters refresh TypeScript and schema fixture files that tests and other tools rely on. A similar helper regenerates example protobuf code.

Another group is made of standalone utilities. apply_patch wraps the patch engine as its own command. file-search scans folders and ranks matching paths, then prints results in human-friendly or JSON form. The state log viewer tails the SQLite log database. Markdown and extension examples help inspect parser output and demonstrate extension behavior.

The rest are bridge, server, and sandbox helpers. They start test servers, proxy APIs, connect stdio to sockets, capture notifications safely, and launch execution or policy-check tools. Linux and Windows sandbox binaries set up restricted environments and run commands inside them, acting like safety gear around risky work.

## Files in this stage

### Schema and protocol generators
These binaries and helpers generate or refresh schemas, bindings, and protocol fixtures used by other tools and tests.

### `core/src/bin/config_schema.rs`

`entrypoint` · `tool invocation / schema generation`

This file defines a standalone command-line program named `codex-write-config-schema`. Its `Args` struct uses `clap::Parser` to accept an optional `--out` / `-o` path. The binary’s `main` function parses arguments, resolves the output location, and delegates schema generation to `codex_config::schema::write_config_schema`.

The output path logic is the only real control flow: if the user supplies `--out`, that exact `PathBuf` is used; otherwise the program derives a default path by taking the crate manifest directory from `env!("CARGO_MANIFEST_DIR")` and appending `config.schema.json`. The function returns `anyhow::Result<()>`, so any filesystem or schema-generation failure from `write_config_schema` bubbles up naturally through `?` and terminates the process with an error. There is no additional validation, logging, or post-processing in this file; it is intentionally a thin binary wrapper around the schema writer. That makes it suitable for CI, release tooling, or developer workflows where the schema file must stay synchronized with the Rust config types.

#### Function details

##### `main`  (lines 13–20)

```
fn main() -> Result<()>
```

**Purpose**: Parses CLI arguments, chooses an output path, and writes the config schema JSON file. It is the binary entrypoint for schema generation.

**Data flow**: Calls `Args::parse()` to read `--out` from process arguments → if `args.out` is `Some`, uses it directly; otherwise constructs `<CARGO_MANIFEST_DIR>/config.schema.json` → passes the resolved path to `codex_config::schema::write_config_schema` → returns `Ok(())` on success or propagates any error.

**Call relations**: As the only function in the file, `main` orchestrates the entire binary. It delegates argument parsing to Clap’s derived parser and the actual schema emission to `write_config_schema`.

*Call graph*: calls 1 internal fn (write_config_schema); 1 external calls (parse).


### `config/src/schema.rs`

`config` · `build-time tooling / schema generation`

This file is responsible for schema generation rather than runtime config loading. `features_schema` constructs a strict object schema for the `[features]` table using the `codex_features::FEATURES` registry plus `legacy_feature_keys()`. Most feature keys are simple booleans, but several receive typed subschemas: `CodeMode`, `MultiAgentV2`, and `NetworkProxy` use `FeatureToml<...ConfigToml>` wrappers, while `AppsMcpPathOverride` uses a custom compatibility schema from `removed_apps_mcp_path_override_schema` that accepts either a boolean or an object with `enabled` and `path`. The `Artifact` feature is intentionally skipped. Additional properties are forbidden so only known and legacy keys validate.

`mcp_servers_schema` similarly creates an object schema whose arbitrary keys map to `RawMcpServerConfig`, matching the raw input shape rather than a postprocessed internal form. `config_schema` then configures `schemars` draft-07 generation for `ConfigToml`, explicitly disabling `null` as an automatic option type.

For fixture stability, `canonicalize` recursively sorts object keys in a `serde_json::Value` while preserving array order and scalar values. `config_schema_json` generates the root schema, converts it to JSON, canonicalizes it, and pretty-prints it to bytes. `write_config_schema` is the final I/O step, writing those bytes to a caller-supplied path. The separation keeps schema construction pure and deterministic while isolating filesystem output to one small function.

#### Function details

##### `features_schema`  (lines 18–76)

```
fn features_schema(schema_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Constructs the JSON Schema fragment for the `[features]` table, allowing only known current and legacy feature keys. It assigns specialized schemas to features whose values are not plain booleans.

**Data flow**: Takes `&mut SchemaGenerator`, creates a `SchemaObject` with object instance type and an `ObjectValidation`, iterates `FEATURES`, skips `Artifact`, inserts typed subschemas for `CodeMode`, `MultiAgentV2`, `AppsMcpPathOverride`, and `NetworkProxy`, inserts boolean subschemas for all other features, then adds boolean schemas for every key from `legacy_feature_keys()`. It sets `additional_properties` to `false`, attaches the validation to the object, and returns `Schema::Object(object)`.

**Call relations**: Used as a custom schema fragment when generating the overall config schema; it delegates one special case to `removed_apps_mcp_path_override_schema`.

*Call graph*: calls 1 internal fn (removed_apps_mcp_path_override_schema); 6 external calls (new, default, default, Bool, Object, legacy_feature_keys).


##### `removed_apps_mcp_path_override_schema`  (lines 78–100)

```
fn removed_apps_mcp_path_override_schema(schema_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds the compatibility schema for the removed `AppsMcpPathOverride` feature format. It accepts either a bare boolean or a strict object containing `enabled` and `path` fields.

**Data flow**: Accepts `&mut SchemaGenerator`, builds an object validation with `enabled: bool` and `path: String`, forbids additional properties, wraps that object schema, then returns a `Schema::Object` whose `subschemas.any_of` contains both `schema_gen.subschema_for::<bool>()` and the object schema.

**Call relations**: Called only by `features_schema` for the `AppsMcpPathOverride` feature key.

*Call graph*: called by 1 (features_schema); 6 external calls (new, default, default, Bool, Object, vec!).


##### `mcp_servers_schema`  (lines 103–116)

```
fn mcp_servers_schema(schema_gen: &mut SchemaGenerator) -> Schema
```

**Purpose**: Constructs the JSON Schema fragment for the `[mcp_servers]` table. Arbitrary server names are allowed, but each value must match `RawMcpServerConfig`.

**Data flow**: Takes `&mut SchemaGenerator`, creates an object-typed `SchemaObject`, sets `additional_properties` to the generated subschema for `RawMcpServerConfig`, attaches the validation, and returns `Schema::Object(object)`.

**Call relations**: Used as a custom schema fragment for MCP server configuration within the overall config schema.

*Call graph*: 3 external calls (new, default, Object).


##### `config_schema`  (lines 119–126)

```
fn config_schema() -> RootSchema
```

**Purpose**: Generates the full root JSON Schema for `ConfigToml` using draft-07 settings. It tweaks schemars so optional fields are not represented with explicit `null` types.

**Data flow**: Creates `SchemaSettings::draft07()`, mutates the settings to set `option_add_null_type = false`, converts the settings into a generator, and returns `into_root_schema_for::<ConfigToml>()`.

**Call relations**: Called by `config_schema_json` as the pure schema-construction step before JSON serialization.

*Call graph*: called by 1 (config_schema_json); 1 external calls (draft07).


##### `canonicalize`  (lines 129–143)

```
fn canonicalize(value: &Value) -> Value
```

**Purpose**: Recursively sorts object keys in a JSON value to produce deterministic output. Arrays keep their original order, and scalars are cloned unchanged.

**Data flow**: Reads `&serde_json::Value`. For arrays, it maps `canonicalize` over each element and returns a new `Value::Array`. For objects, it collects entries, sorts them by key, recursively canonicalizes each child, inserts them into a new `Map` with matching capacity, and returns `Value::Object(sorted)`. For all other variants, it clones and returns the original value.

**Call relations**: Used by `config_schema_json` to stabilize generated schema fixtures before pretty-printing.

*Call graph*: called by 1 (config_schema_json); 4 external calls (with_capacity, Array, Object, clone).


##### `config_schema_json`  (lines 146–152)

```
fn config_schema_json() -> anyhow::Result<Vec<u8>>
```

**Purpose**: Produces the full config schema as canonicalized, pretty-printed JSON bytes. It is the main serialization helper used by tooling.

**Data flow**: Calls `config_schema()` to build the root schema, converts it to `serde_json::Value` with `serde_json::to_value`, canonicalizes that value with `canonicalize`, pretty-prints it with `serde_json::to_vec_pretty`, and returns the resulting `Vec<u8>` inside `anyhow::Result`.

**Call relations**: Called by `write_config_schema`; it composes the pure generation and canonicalization steps into one serialization pipeline.

*Call graph*: calls 2 internal fn (canonicalize, config_schema); called by 1 (write_config_schema); 2 external calls (to_value, to_vec_pretty).


##### `write_config_schema`  (lines 155–159)

```
fn write_config_schema(out_path: &Path) -> anyhow::Result<()>
```

**Purpose**: Writes the generated config schema JSON to disk at a caller-provided path. It is the only function in this file that performs filesystem I/O.

**Data flow**: Accepts `&Path`, obtains the schema bytes from `config_schema_json()?`, writes them with `std::fs::write(out_path, json)?`, and returns `Ok(())` or any propagated `anyhow` error.

**Call relations**: Invoked by the schema-generation CLI `main`, serving as the final output step after schema construction and serialization.

*Call graph*: calls 1 internal fn (config_schema_json); called by 1 (main); 1 external calls (write).


### `app-server-protocol/src/bin/export.rs`

`entrypoint` · `manual tooling`

This binary uses `clap::Parser` to expose a small schema-export command. The `Args` struct defines three command-line inputs: a required output directory (`out_dir`), an optional Prettier executable path (`prettier`) used to format generated TypeScript, and a boolean `experimental` flag that controls whether experimental API methods and fields are included in the generated artifacts.

`main` is intentionally minimal. It parses CLI arguments, then invokes `codex_app_server_protocol::generate_ts_with_options` first so TypeScript files are emitted into the requested directory. The options passed are built from `GenerateTsOptions::default()` with only `experimental_api` overridden from the CLI flag, preserving the library defaults for index generation, header insertion, and Prettier execution. After TypeScript generation succeeds, it invokes `generate_json_with_experimental` with the same output directory and experimental toggle to emit JSON Schema files and bundled schema documents.

The function returns `anyhow::Result<()>`, so any generation failure exits the process with an error. There is no extra orchestration, cleanup, or validation here; the binary’s job is simply to translate CLI inputs into the library’s export configuration.

#### Function details

##### `main`  (lines 23–34)

```
fn main() -> Result<()>
```

**Purpose**: Parses export CLI arguments and runs both TypeScript and JSON schema generation with a shared experimental-API setting. It is the executable entrypoint for protocol export tooling.

**Data flow**: Reads process arguments into `Args` via Clap, then passes `&args.out_dir`, `args.prettier.as_deref()`, and a `GenerateTsOptions` value derived from `default()` into `generate_ts_with_options`. If that succeeds, it calls `generate_json_with_experimental(&args.out_dir, args.experimental)` and returns the final `Result<()>`.

**Call relations**: As the binary entrypoint, this function is not called by internal library code. It delegates all substantive work to `codex_app_server_protocol` generation functions and relies on `GenerateTsOptions::default` for the baseline TypeScript export behavior.

*Call graph*: calls 1 internal fn (default); 3 external calls (parse, generate_json_with_experimental, generate_ts_with_options).


### `app-server-protocol/src/bin/write_schema_fixtures.rs`

`entrypoint` · `manual tooling`

This binary wraps the protocol crate’s fixture-writing API behind a small Clap interface. Its `Args` struct accepts an optional `--schema-root` directory, an optional Prettier path, and an `--experimental` flag. If `schema_root` is omitted, `main` derives a default fixture location by taking `env!("CARGO_MANIFEST_DIR")` and appending `schema`, so the command naturally targets the crate’s vendored fixture tree.

The implementation is intentionally straightforward: parse arguments, resolve the target root directory, and call `codex_app_server_protocol::write_schema_fixtures_with_options`. The options object only carries the `experimental_api` boolean, while the optional Prettier path is forwarded as `Option<&Path>`. Unlike the export binary, this command adds a path-specific `with_context` wrapper around the library call so failures clearly identify which fixture root could not be regenerated.

There is no direct file traversal or generation logic in this file; all semantics live in the library. The binary’s main value is reproducible invocation and better operator-facing error messages when fixture regeneration fails.

#### Function details

##### `main`  (lines 22–42)

```
fn main() -> Result<()>
```

**Purpose**: Parses fixture-regeneration arguments, resolves the schema fixture root, and invokes the library routine that rewrites vendored schema fixtures. It adds contextual error reporting naming the target directory.

**Data flow**: Parses `Args`, computes `schema_root` either from `args.schema_root` or from `CARGO_MANIFEST_DIR/schema`, then calls `write_schema_fixtures_with_options(&schema_root, args.prettier.as_deref(), SchemaFixtureOptions { experimental_api: args.experimental })`. It returns `Result<()>`, enriching any failure with a message containing `schema_root.display()`.

**Call relations**: This is the standalone binary entrypoint and is not called by other crate code. It delegates all generation and writing behavior to `codex_app_server_protocol::write_schema_fixtures_with_options`.

*Call graph*: 2 external calls (parse, write_schema_fixtures_with_options).


### `hooks/src/bin/write_hooks_schema_fixtures.rs`

`entrypoint` · `developer CLI invocation`

This binary exists purely as a developer/tooling entrypoint for generating schema fixtures. Its `main` function reads process arguments with `std::env::args_os()`, takes the first positional argument if present, and converts it into a `PathBuf`. If no argument is supplied, it falls back to `<CARGO_MANIFEST_DIR>/schema`, using the compile-time manifest directory and appending `schema`.

After resolving that root directory, it delegates all real work to `codex_hooks::write_schema_fixtures`. The function returns `anyhow::Result<()>`, so argument handling stays minimal and any downstream generation or filesystem failure bubbles up naturally to the process exit path. There is no custom validation, logging, or branching beyond choosing the destination path. The file’s role is therefore to expose an executable wrapper around library functionality rather than implement schema generation itself.

#### Function details

##### `main`  (lines 3–9)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Resolves the schema fixture output directory and invokes the library routine that writes the fixtures. It supports an optional first positional argument and otherwise uses the crate-local `schema` directory.

**Data flow**: It reads OS-native command-line arguments, extracts argument 1 if present, converts it to `PathBuf`, or constructs a default path from `env!("CARGO_MANIFEST_DIR")/schema`. That path is passed to `codex_hooks::write_schema_fixtures`, and the resulting `anyhow::Result<()>` is returned unchanged.

**Call relations**: As the binary entrypoint, it is invoked directly by the process runtime. Its only substantive delegation is to `write_schema_fixtures`, after a small amount of startup argument parsing via `args_os`.

*Call graph*: 2 external calls (write_schema_fixtures, args_os).


### `config/examples/generate-proto.rs`

`entrypoint` · `manual developer invocation`

This example binary is a one-shot developer utility rather than runtime application logic. It expects a single positional argument naming the directory that contains `codex.thread_config.v1.proto`. If the argument is missing, it prints a usage line to stderr and exits the process with status 1 instead of returning an error.

When an argument is present, it constructs a `PathBuf` for the directory, joins the fixed proto filename, and configures `tonic_prost_build` to emit both client and server code into that same directory. The builder is set up with `build_client(true)`, `build_server(true)`, and `out_dir(&proto_dir)`, then `compile_protos` is invoked with the single proto file and include path rooted at the provided directory. Any code generation failure is propagated through the function’s `Result<(), Box<dyn Error>>` return type.

The file has no internal abstractions because its job is narrowly procedural: validate CLI shape, derive paths, invoke the protobuf code generator, and terminate.

#### Function details

##### `main`  (lines 3–19)

```
fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Parses the proto directory argument, validates that it exists conceptually as input, and runs tonic/prost code generation for the fixed thread-config proto file.

**Data flow**: Reads `std::env::args().nth(1)` for the first positional argument. If absent, it writes a usage message to stderr and terminates the process with exit code 1. Otherwise it converts the argument into a `PathBuf`, derives `codex.thread_config.v1.proto` under that directory, configures `tonic_prost_build` to generate client and server code into the same directory, runs `compile_protos`, and returns `Ok(())` on success or propagates the build error.

**Call relations**: As the binary entrypoint, it is invoked directly by the process runtime. Its only delegation is to standard library argument/path helpers and the `tonic_prost_build` builder chain that performs the actual code generation.

*Call graph*: 5 external calls (from, eprintln!, args, exit, configure).


### Standalone utility binaries
This group covers small direct-invocation tools for patching, searching, bridging, debugging, and sample execution.

### `apply-patch/src/main.rs`

`entrypoint` · `startup`

This file is intentionally minimal: it defines the process entrypoint and immediately delegates to `codex_apply_patch::main()`. There is no argument parsing, error handling, state setup, or I/O logic here; all runtime behavior lives in the external crate function it calls. The `-> !` return type makes the contract explicit that control never returns to this wrapper, which matches a process-level main that exits internally. In handbook terms, this file is just the binary shim that exposes the library implementation as an executable target.

#### Function details

##### `main`  (lines 1–3)

```
fn main() -> !
```

**Purpose**: Transfers execution from the Rust binary target into the library-provided apply-patch main function.

**Data flow**: It takes no arguments, reads no local state, and forwards control directly to `codex_apply_patch::main()`. It never returns because the delegated function is also process-terminating.

**Call relations**: This is the OS-invoked entrypoint for the binary target. Its only role in the call flow is to invoke the external main implementation immediately so the executable can reuse library logic.

*Call graph*: 1 external calls (main).


### `apply-patch/src/standalone_executable.rs`

`entrypoint` · `startup and CLI invocation`

This file contains the real command-line driver used by the standalone binary. `main` is a thin wrapper that calls `run_main` and exits the process with its integer status code. `run_main` accepts exactly one UTF-8 patch payload either as the sole positional argument or, if no argument is provided, by reading all of stdin into a `String`. It rejects non-UTF-8 arguments, empty stdin, and extra arguments with explicit usage or error messages and distinct exit codes (`1` for operational failures, `2` for usage errors).

After obtaining the patch text, it opens stdout and stderr handles, resolves the current working directory through `AbsolutePathBuf::current_dir()`, and builds a single-threaded Tokio runtime with all features enabled. It then synchronously blocks on the crate-level async `apply_patch` function, passing the patch text, cwd, mutable stdout/stderr writers, the local filesystem implementation from `codex_exec_server::LOCAL_FS`, and no sandbox. On success it flushes stdout to preserve output ordering in pipelines and returns exit code 0; on any reported patch-application error it returns 1, relying on the callee to have already emitted diagnostics to stderr. The design keeps CLI concerns—input source, process exit, runtime creation—separate from patch semantics.

#### Function details

##### `main`  (lines 4–7)

```
fn main() -> !
```

**Purpose**: Runs the CLI driver and terminates the process with its returned exit code.

**Data flow**: It takes no arguments, calls `run_main()` to compute an `i32` status, and passes that status to `std::process::exit`, so it never returns.

**Call relations**: This is the executable entrypoint. It exists solely to bridge Rust’s main function to the integer-returning `run_main` helper.

*Call graph*: calls 1 internal fn (run_main); 1 external calls (exit).


##### `run_main`  (lines 11–83)

```
fn run_main() -> i32
```

**Purpose**: Parses CLI input, initializes runtime dependencies, invokes async patch application, and maps outcomes to process exit codes.

**Data flow**: It reads `std::env::args_os()`, consumes argv[0], and either converts the next argument into UTF-8 or reads stdin into a `String`. It validates argument count, acquires stdout/stderr handles, resolves the current directory, builds a Tokio current-thread runtime, and calls `crate::apply_patch(...)` with the patch text, cwd, writers, local filesystem backend, and `None` sandbox. It writes diagnostics with `eprintln!`, flushes stdout on success, and returns `0`, `1`, or `2` depending on outcome.

**Call relations**: Called only by `main`, this function orchestrates the entire standalone CLI flow. It delegates actual patch semantics to the crate-level async `apply_patch` function and handles only process-facing concerns such as input source selection and exit status.

*Call graph*: calls 1 internal fn (current_dir); called by 1 (main); 8 external calls (new, apply_patch, eprintln!, args_os, stderr, stdin, stdout, new_current_thread).


### `file-search/src/main.rs`

`entrypoint` · `CLI startup and result rendering`

This binary is a thin wrapper around the library in `file-search/src/lib.rs`. `main` parses the command line with `clap`, derives a `StdioReporter`, and delegates all search behavior to `run_main`. The only local policy is output formatting: `write_output_as_json` mirrors the CLI’s `--json` flag, while `show_indices` is enabled only when `--compute-indices` was requested and stdout is an interactive terminal, avoiding ANSI escapes in piped output.

`StdioReporter` implements the library `Reporter` trait. `report_match` has three output modes. In JSON mode it serializes the full `FileMatch` with `serde_json`, preserving score, root, match type, and optional indices. In highlighted terminal mode it expects `file_match.indices` to be present and walks the path string character-by-character while advancing a peekable iterator over the sorted index list; matching characters are wrapped in ANSI bold escape codes without repeatedly scanning the index vector. Otherwise it prints the path as plain text.

Warnings are also mode-sensitive. `warn_matches_truncated` emits either a JSON sentinel object `{ "matches_truncated": true }` or a human-readable stderr warning explaining that the result set was limited. `warn_no_search_pattern` always writes a stderr message explaining that the current directory contents will be shown instead of search results.

#### Function details

##### `main`  (lines 12–20)

```
async fn main() -> anyhow::Result<()>
```

**Purpose**: Parses CLI arguments, chooses stdout formatting behavior, and runs the file-search command.

**Data flow**: Calls `Cli::parse()` to obtain arguments, computes `show_indices` from `cli.compute_indices && stdout().is_terminal()`, constructs `StdioReporter`, awaits `run_main(cli, reporter)`, and returns `Ok(())` on success.

**Call relations**: This is the binary entrypoint; all actual search logic is delegated to the library’s `run_main`.

*Call graph*: calls 1 internal fn (run_main); 2 external calls (parse, stdout).


##### `StdioReporter::report_match`  (lines 28–62)

```
fn report_match(&self, file_match: &FileMatch)
```

**Purpose**: Renders one search match to stdout in JSON, highlighted terminal text, or plain path form.

**Data flow**: Reads `self` mode flags and the `FileMatch`. In JSON mode it serializes the whole match and prints it. In highlighted mode it reads `file_match.indices`, iterates over the path string’s characters with indices, compares them against a peekable iterator over the sorted match indices, prints matching characters in ANSI bold and others normally, then prints a newline. Otherwise it prints the path string directly.

**Call relations**: Called by library `run_main` for each returned match; its highlighted branch relies on the library’s guarantee that indices are sorted and deduplicated.

*Call graph*: 3 external calls (print!, println!, to_string).


##### `StdioReporter::warn_matches_truncated`  (lines 64–75)

```
fn warn_matches_truncated(&self, total_match_count: usize, shown_match_count: usize)
```

**Purpose**: Reports that only a subset of total matches is being shown.

**Data flow**: If JSON mode is enabled, it builds `{"matches_truncated": true}`, serializes it, and prints it to stdout. Otherwise it writes a human-readable warning to stderr including `shown_match_count` and `total_match_count`.

**Call relations**: Invoked by library `run_main` when `total_match_count` exceeds the number of emitted matches.

*Call graph*: 4 external calls (eprintln!, json!, println!, to_string).


##### `StdioReporter::warn_no_search_pattern`  (lines 77–82)

```
fn warn_no_search_pattern(&self, search_directory: &Path)
```

**Purpose**: Warns the user that no search pattern was provided and that a directory listing will be shown instead.

**Data flow**: Formats the provided `search_directory` path with `to_string_lossy()` and writes a message to stderr.

**Call relations**: Called by library `run_main` before it falls back to shelling out to a directory listing command.

*Call graph*: 1 external calls (eprintln!).


### `file-search/src/cli.rs`

`config` · `startup / argument parsing`

This file contains the `Cli` struct, the complete argument contract for the file-search binary. It derives `clap::Parser`, so Clap generates the actual parsing logic from the field annotations and doc comments. The fields are concrete and typed to enforce invariants at parse time: `limit` and `threads` use `NonZero<usize>` so the program can never receive zero for result count or worker count; `cwd` is an optional `PathBuf` for overriding the search root; `exclude` is a repeatable `Vec<String>` collected via `ArgAction::Append`; and `pattern` is optional positional input, allowing the caller to omit the search term entirely if the surrounding program supports that mode.

Several defaults are encoded directly in the CLI definition: JSON output and index computation both default to `false`, result limit defaults to `64`, and worker threads default to `2`. The comment above `threads` documents an important performance assumption: filesystem traversal is I/O-bound enough that a small fixed thread count outperforms scaling to CPU count. This file does not execute the search itself; instead, it defines the validated configuration object that downstream search code consumes. Its main invariant is that parsed values are already normalized into usable Rust types before any search logic runs.


### `file-search/src/lib.rs`

`domain_logic` · `request handling and background search session`

This file contains both the synchronous one-shot search API and the incremental session engine behind it. Search results are represented by `FileMatch`, which stores the fuzzy score, relative path, whether the match is a file or directory, the root it came from, and optional sorted/deduplicated match indices for terminal highlighting. `FileSearchOptions` controls result limit, exclusion globs, worker thread count, whether to compute indices, and whether `.gitignore` semantics are respected.

The core runtime is `create_session`. It validates that at least one search root exists, builds an `ignore::overrides::Override` matcher from exclusion patterns, creates a crossbeam work channel, initializes `nucleo` with a notify callback that sends `WorkSignal::NucleoNotify`, and spawns two threads sharing `SessionInner`. `walker_worker` traverses all roots with `ignore::WalkBuilder`, following symlinks and optionally honoring gitignore rules only inside actual git repositories via `require_git(true)`. For each discovered path it computes the best matching root-relative path with `get_file_path` and injects the full path plus relative matcher column into `nucleo`. It periodically checks cancellation and shutdown flags.

`matcher_worker` owns the `Nucleo` instance and reacts to `QueryUpdated`, `NucleoNotify`, `WalkComplete`, and `Shutdown` signals. Query updates reparse the fuzzy pattern, preserving append optimization when the new query extends the previous one. Notifications are debounced with `after(...)` timers so repeated walker updates coalesce. On each tick, if `nucleo` reports changes, the worker snapshots the top matches, reconstructs root-relative paths, optionally computes highlight indices using a separate `Matcher`, determines file-vs-directory by probing the full path, and sends a `FileSearchSnapshot` to the reporter. Completion is signaled once matching is no longer running and the walk has finished; cancellation or drop also guarantees `on_complete()` is called.

The one-shot `run` helper simply creates a `RunReporter`, starts a session, submits the query, waits on a condition variable, and returns the final `FileSearchResults`. `run_main` wraps that for the CLI, including the special no-pattern behavior that warns and shells out to directory listing instead of searching.

#### Function details

##### `FileMatch::full_path`  (lines 71–73)

```
fn full_path(&self) -> PathBuf
```

**Purpose**: Reconstructs the absolute or root-qualified path for a match by joining its root and relative path.

**Data flow**: Reads `self.root` and `self.path`, joins them with `PathBuf::join`, and returns the resulting `PathBuf`.

**Call relations**: Used by callers that need a concrete filesystem path rather than the relative path stored in search results.

*Call graph*: 1 external calls (join).


##### `file_name_from_path`  (lines 77–82)

```
fn file_name_from_path(path: &str) -> String
```

**Purpose**: Extracts the basename from a path string, falling back to the original string when no final component exists.

**Data flow**: Creates a `Path` from the input `&str`, calls `file_name()`, converts the component to an owned string if present, otherwise returns `path.to_string()`.

**Call relations**: A small helper for presentation logic that wants just the final path component.

*Call graph*: 1 external calls (new).


##### `FileSearchOptions::default`  (lines 116–126)

```
fn default() -> Self
```

**Purpose**: Provides the standard search configuration used by most callers and tests.

**Data flow**: Constructs `FileSearchOptions` with `limit = 20`, `threads = 2`, empty `exclude`, `compute_indices = false`, and `respect_gitignore = true`.

**Call relations**: Used whenever callers want conventional fuzzy search behavior without specifying tuning knobs.

*Call graph*: called by 6 (dropping_session_does_not_cancel_siblings_with_shared_cancel_flag, session_accepts_query_updates_after_walk_complete, session_emits_complete_when_query_changes_with_no_matches, session_emits_updates_when_query_changes, session_scanned_file_count_is_monotonic_across_queries, session_streams_updates_before_walk_complete); 2 external calls (new, new).


##### `FileSearchSession::update_query`  (lines 143–148)

```
fn update_query(&self, pattern_text: &str)
```

**Purpose**: Submits a new search query to an existing session without restarting the filesystem walk.

**Data flow**: Clones the query text into a `String`, wraps it in `WorkSignal::QueryUpdated`, and sends it on `inner.work_tx`, ignoring send errors.

**Call relations**: Called by interactive clients and by `run`; the matcher thread reacts by reparsing the pattern and producing updated snapshots.

*Call graph*: called by 1 (update_query); 1 external calls (QueryUpdated).


##### `FileSearchSession::drop`  (lines 152–155)

```
fn drop(&mut self)
```

**Purpose**: Shuts down a session’s worker threads when the session handle is dropped.

**Data flow**: Sets `inner.shutdown` to `true` with relaxed ordering and sends `WorkSignal::Shutdown` on the work channel, ignoring send errors.

**Call relations**: Ensures dropping one session stops its own workers without touching any shared external cancel flag.


##### `create_session`  (lines 158–211)

```
fn create_session(
    search_directories: Vec<PathBuf>,
    options: FileSearchOptions,
    reporter: Arc<dyn SessionReporter>,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> anyhow::Result<FileSearc
```

**Purpose**: Creates the full asynchronous file-search pipeline over one or more roots and returns a handle for query updates.

**Data flow**: Consumes search roots, options, a reporter, and an optional cancel flag. It validates that `search_directories` is non-empty, builds an override matcher from `exclude`, creates an unbounded work channel, constructs a `nucleo` instance with a notify closure that sends `NucleoNotify`, derives an injector, chooses or allocates the cancellation flag, builds `SessionInner`, spawns `matcher_worker` and `walker_worker` threads with cloned shared state, and returns `FileSearchSession { inner }`.

**Call relations**: This is the main constructor used by both interactive sessions and the one-shot `run` helper.

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

**Purpose**: Implements the CLI-facing search flow, including the special case where no pattern is provided.

**Data flow**: Consumes parsed `Cli` options and a `Reporter`. It resolves the search directory from `cwd` or `current_dir()`. If `pattern` is `None`, it calls `reporter.warn_no_search_pattern`, then on Unix runs `ls -al` in that directory (or `cmd /c <dir>` on Windows), inheriting stdio, and returns `Ok(())`. Otherwise it calls `run(...)` with one root and options derived from the CLI, reports each returned match through `report_match`, and if `total_match_count > matches.len()` calls `warn_matches_truncated`.

**Call relations**: Called by the binary entrypoint in `main.rs`; it bridges CLI parsing to the library search API and reporter callbacks.

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

**Purpose**: Performs a one-shot search by creating a session, submitting one query, and waiting for completion.

**Data flow**: Creates an `Arc<RunReporter>`, starts a session with `create_session`, calls `session.update_query(pattern_text)`, waits for the reporter’s completion condition variable, and returns `FileSearchResults` containing the final snapshot’s matches and total count.

**Call relations**: Used by `run_main` and tests that want a simple blocking API instead of managing a session directly.

*Call graph*: calls 1 internal fn (create_session); called by 5 (run_main, git_repo_still_respects_local_gitignore_when_enabled, parent_gitignore_outside_repo_does_not_hide_repo_files, run_returns_directory_matches_for_query, run_returns_matches_for_query); 2 external calls (new, default).


##### `sort_matches`  (lines 311–316)

```
fn sort_matches(matches: &mut [(u32, String)])
```

**Purpose**: Test-only helper that sorts `(score, path)` tuples using the library’s canonical ordering.

**Data flow**: Mutably borrows a slice of tuples and sorts it in place using `cmp_by_score_desc_then_path_asc` with tuple field accessors.

**Call relations**: Used only by the tie-breaker test to validate comparator behavior.

*Call graph*: called by 1 (tie_breakers_sort_by_path_when_scores_equal).


##### `cmp_by_score_desc_then_path_asc`  (lines 320–333)

```
fn cmp_by_score_desc_then_path_asc(
    score_of: FScore,
    path_of: FPath,
) -> impl FnMut(&T, &T) -> std::cmp::Ordering
```

**Purpose**: Builds a comparator that orders items by descending score and then ascending path.

**Data flow**: Captures two accessor closures, `score_of` and `path_of`, and returns a closure that compares `score_of(b)` to `score_of(a)` first; if equal, it compares `path_of(a)` to `path_of(b)` lexicographically.

**Call relations**: Provides reusable ordering logic for tests and any caller that wants deterministic ranking tie-breaks.


##### `create_pattern`  (lines 336–343)

```
fn create_pattern(pattern: &str) -> Pattern
```

**Purpose**: Test-only helper that constructs a fuzzy `nucleo::Pattern` with the same matching settings used by the search engine.

**Data flow**: Calls `Pattern::new` with the input string, `CaseMatching::Ignore`, `Normalization::Smart`, and `AtomKind::Fuzzy`, returning the pattern.

**Call relations**: Used by tests that inspect raw `nucleo` scoring behavior independently of the session pipeline.

*Call graph*: called by 1 (verify_score_is_none_for_non_match); 1 external calls (new).


##### `build_override_matcher`  (lines 364–378)

```
fn build_override_matcher(
    search_directory: &Path,
    exclude: &[String],
) -> anyhow::Result<Option<ignore::overrides::Override>>
```

**Purpose**: Builds an `ignore` override matcher from exclusion patterns supplied in search options.

**Data flow**: If `exclude` is empty, returns `Ok(None)`. Otherwise it creates an `OverrideBuilder` rooted at `search_directory`, prefixes each exclude pattern with `!`, adds it to the builder, builds the matcher, and returns `Ok(Some(matcher))`.

**Call relations**: Called by `create_session` before spawning the walker so excluded paths are filtered during traversal.

*Call graph*: called by 1 (create_session); 2 external calls (new, format!).


##### `get_file_path`  (lines 380–397)

```
fn get_file_path(path: &'a Path, search_directories: &[PathBuf]) -> Option<(usize, &'a str)>
```

**Purpose**: Finds the best root-relative string path for a discovered filesystem path across multiple search roots.

**Data flow**: Iterates over `search_directories` with indices, tries `path.strip_prefix(root)` for each, and keeps the match whose root has the greatest component depth. It then converts the chosen relative path to UTF-8 and returns `Some((root_idx, relative_str))`, or `None` if no root matches or the relative path is non-UTF-8.

**Call relations**: Used by both `walker_worker` and `matcher_worker` so injected items and emitted matches consistently refer to the deepest applicable root.

*Call graph*: 2 external calls (strip_prefix, iter).


##### `walker_worker`  (lines 411–481)

```
fn walker_worker(
    inner: Arc<SessionInner>,
    override_matcher: Option<ignore::overrides::Override>,
    injector: Injector<Arc<str>>,
)
```

**Purpose**: Traverses the filesystem roots in parallel and injects discovered paths into `nucleo` for matching.

**Data flow**: Reads `SessionInner` and an optional override matcher. If there is no first root, it sends `WalkComplete` and returns. Otherwise it configures `WalkBuilder` with all roots, thread count, hidden-file inclusion, symlink following, and `require_git(true)`. If `respect_gitignore` is false it disables all git and ignore-file processing; if an override matcher exists it installs it. It then runs the parallel walker, and for each successful entry with a UTF-8 path computes a root-relative path via `get_file_path` and injects the full path into `nucleo`, storing the relative path in matcher column 0. Every 1024 entries it checks `cancelled` and `shutdown` flags and quits early if set. After the walk ends it sends `WorkSignal::WalkComplete`.

**Call relations**: Spawned by `create_session`; it is the producer side of the search pipeline, feeding paths and signaling completion to the matcher thread.

*Call graph*: 1 external calls (new).


##### `matcher_worker`  (lines 483–604)

```
fn matcher_worker(
    inner: Arc<SessionInner>,
    work_rx: Receiver<WorkSignal>,
    mut nucleo: Nucleo<Arc<str>>,
) -> anyhow::Result<()>
```

**Purpose**: Owns the fuzzy matcher state, reacts to query and walker notifications, and emits ranked snapshots to the session reporter.

**Data flow**: Consumes shared `SessionInner`, a `Receiver<WorkSignal>`, and a mutable `Nucleo`. It initializes matching config, an optional indices matcher, query state, debounce timer state, and a `walk_complete` flag. In a loop it `select!`s over work signals, the next notify timer, and a periodic default timeout. `QueryUpdated` reparses the pattern with append optimization and schedules immediate notification; `NucleoNotify` schedules a short delayed tick if one is not already pending; `WalkComplete` marks the walk done and schedules an immediate tick; `Shutdown` breaks. On notify, it calls `nucleo.tick`, and if results changed it snapshots matches, limits them, reconstructs root-relative paths with `get_file_path`, optionally computes sorted/deduplicated indices from the pattern and matcher column, determines `MatchType` by checking `Path::is_dir`, builds a `FileSearchSnapshot`, and calls `inner.reporter.on_update`. If matching is no longer running and the walk is complete, it calls `on_complete`. After loop exit, it calls `on_complete` again to guarantee completion notification on cancellation or shutdown, then returns `Ok(())`.

**Call relations**: Spawned by `create_session`; it is the consumer/aggregator side of the pipeline and the only thread that touches `Nucleo` matching state.

*Call graph*: 3 external calls (new, never, select!).


##### `RunReporter::on_update`  (lines 613–617)

```
fn on_update(&self, snapshot: &FileSearchSnapshot)
```

**Purpose**: Stores the latest search snapshot for one-shot `run` callers.

**Data flow**: Acquires the write lock on `self.snapshot` and replaces the stored `FileSearchSnapshot` with a clone of the incoming snapshot.

**Call relations**: Called by `matcher_worker` through the `SessionReporter` trait during one-shot searches.

*Call graph*: 1 external calls (clone).


##### `RunReporter::on_complete`  (lines 619–625)

```
fn on_complete(&self)
```

**Purpose**: Signals that the search session has become idle or finished.

**Data flow**: Locks the `completed` mutex, sets the boolean to `true`, and notifies all waiters on the condition variable.

**Call relations**: Called by `matcher_worker`; `run` waits on this signal before reading the final snapshot.


##### `RunReporter::wait_for_complete`  (lines 629–641)

```
fn wait_for_complete(&self) -> FileSearchSnapshot
```

**Purpose**: Blocks until the reporter has observed completion, then returns the last stored snapshot.

**Data flow**: Locks the completion mutex, waits on the condition variable until the boolean becomes true, then reads and clones the snapshot from the `RwLock` and returns it.

**Call relations**: Used only by `run` to turn the asynchronous session into a blocking API.


##### `tests::verify_score_is_none_for_non_match`  (lines 661–669)

```
fn verify_score_is_none_for_non_match()
```

**Purpose**: Checks raw `nucleo` behavior for a query that does not match the haystack.

**Data flow**: Builds a UTF-32 haystack and fuzzy pattern, scores it with a `Matcher`, and asserts the result is `None`.

**Call relations**: Validates assumptions about the underlying fuzzy-matching library.

*Call graph*: calls 1 internal fn (create_pattern); 4 external calls (new, new, new, assert_eq!).


##### `tests::tie_breakers_sort_by_path_when_scores_equal`  (lines 672–689)

```
fn tie_breakers_sort_by_path_when_scores_equal()
```

**Purpose**: Verifies that equal scores are ordered alphabetically by path.

**Data flow**: Creates a vector of `(score, path)` tuples, sorts it with `sort_matches`, and asserts the expected order.

**Call relations**: Tests the comparator helper used for deterministic ordering semantics.

*Call graph*: calls 1 internal fn (sort_matches); 2 external calls (assert_eq!, vec!).


##### `tests::file_name_from_path_uses_basename`  (lines 692–694)

```
fn file_name_from_path_uses_basename()
```

**Purpose**: Checks basename extraction for a normal path string.

**Data flow**: Calls `file_name_from_path("foo/bar.txt")` and asserts the result is `"bar.txt"`.

**Call relations**: Covers the common branch of the helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::file_name_from_path_falls_back_to_full_path`  (lines 697–699)

```
fn file_name_from_path_falls_back_to_full_path()
```

**Purpose**: Checks fallback behavior when a path has no basename component.

**Data flow**: Calls `file_name_from_path("")` and asserts the empty string is returned unchanged.

**Call relations**: Covers the helper’s fallback branch.

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

**Purpose**: Generic timed wait helper for test reporters that blocks until a predicate over shared state becomes true or a timeout expires.

**Data flow**: Locks the provided mutex, repeatedly checks the predicate, computes remaining time until a deadline, waits on the condition variable with timeout, and returns whether the predicate became true before time ran out.

**Call relations**: Used by `wait_for_complete` and `wait_for_updates_at_least` in the test reporter.

*Call graph*: called by 2 (wait_for_complete, wait_for_updates_at_least); 2 external calls (wait_timeout, now).


##### `tests::RecordingReporter::wait_for_complete`  (lines 738–745)

```
fn wait_for_complete(&self, timeout: Duration) -> bool
```

**Purpose**: Waits until at least one completion notification has been recorded.

**Data flow**: Delegates to `wait_until` over `complete_times`, using a predicate that checks the vector is non-empty.

**Call relations**: Used by session tests to wait for idle/completion without inspecting internal worker state.

*Call graph*: calls 1 internal fn (wait_until).


##### `tests::RecordingReporter::clear`  (lines 746–749)

```
fn clear(&self)
```

**Purpose**: Resets recorded updates and completion timestamps between phases of a test.

**Data flow**: Locks `updates` and `complete_times` and clears both vectors.

**Call relations**: Used by tests that reuse one session across multiple query updates.


##### `tests::RecordingReporter::updates`  (lines 751–753)

```
fn updates(&self) -> Vec<FileSearchSnapshot>
```

**Purpose**: Returns a clone of all snapshots observed so far.

**Data flow**: Locks `updates`, clones the vector of `FileSearchSnapshot`s, and returns it.

**Call relations**: Used by tests that need to inspect the full stream of updates.


##### `tests::RecordingReporter::wait_for_updates_at_least`  (lines 755–759)

```
fn wait_for_updates_at_least(&self, min_len: usize, timeout: Duration) -> bool
```

**Purpose**: Waits until the reporter has observed at least a specified number of updates.

**Data flow**: Delegates to `wait_until` over `updates`, using a predicate that checks `updates.len() >= min_len`.

**Call relations**: Used by tests that verify additional updates arrive after a query change.

*Call graph*: calls 1 internal fn (wait_until).


##### `tests::RecordingReporter::snapshot`  (lines 761–768)

```
fn snapshot(&self) -> FileSearchSnapshot
```

**Purpose**: Returns the most recent observed snapshot, or a default snapshot if none exist.

**Data flow**: Locks `updates`, takes the last element if present, clones it, and otherwise returns `FileSearchSnapshot::default()`.

**Call relations**: Convenience accessor used throughout session tests.


##### `tests::RecordingReporter::on_update`  (lines 772–776)

```
fn on_update(&self, snapshot: &FileSearchSnapshot)
```

**Purpose**: Records each emitted snapshot and wakes waiting test threads.

**Data flow**: Locks `updates`, pushes a clone of the incoming snapshot, and notifies all waiters on `update_cv`.

**Call relations**: Implements `SessionReporter` for tests so worker threads can be observed deterministically.

*Call graph*: 2 external calls (notify_all, clone).


##### `tests::RecordingReporter::on_complete`  (lines 778–784)

```
fn on_complete(&self)
```

**Purpose**: Records completion timestamps and wakes waiting test threads.

**Data flow**: Locks `complete_times`, pushes `Instant::now()`, then notifies all waiters on `complete_cv`.

**Call relations**: Implements the completion side of the test reporter.

*Call graph*: 2 external calls (notify_all, now).


##### `tests::create_temp_tree`  (lines 787–794)

```
fn create_temp_tree(file_count: usize) -> TempDir
```

**Purpose**: Creates a temporary directory populated with a numbered set of text files for search tests.

**Data flow**: Allocates a temp directory, writes `file-XXXX.txt` files with simple contents for `0..file_count`, and returns the `TempDir`.

**Call relations**: Shared fixture helper for many search tests.

*Call graph*: 3 external calls (format!, write, tempdir).


##### `tests::session_scanned_file_count_is_monotonic_across_queries`  (lines 797–819)

```
fn session_scanned_file_count_is_monotonic_across_queries()
```

**Purpose**: Verifies that the reported scanned-file count never decreases across successive query updates and final completion.

**Data flow**: Creates a temp tree and session, submits two queries with short sleeps between them, captures snapshots after each, waits for completion, and asserts monotonic non-decrease of `scanned_file_count`.

**Call relations**: Exercises incremental session behavior while the walker continues feeding paths.

*Call graph*: calls 2 internal fn (default, create_session); 8 external calls (new, from_millis, from_secs, assert!, default, create_temp_tree, sleep, vec!).


##### `tests::session_streams_updates_before_walk_complete`  (lines 822–839)

```
fn session_streams_updates_before_walk_complete()
```

**Purpose**: Checks that sessions emit intermediate updates before the filesystem walk has fully completed.

**Data flow**: Creates a larger temp tree and session, submits a query, waits for completion, collects all updates, and asserts at least one snapshot had `walk_complete == false`.

**Call relations**: Validates the streaming nature of `matcher_worker` updates.

*Call graph*: calls 2 internal fn (default, create_session); 6 external calls (new, from_secs, assert!, default, create_temp_tree, vec!).


##### `tests::session_accepts_query_updates_after_walk_complete`  (lines 842–870)

```
fn session_accepts_query_updates_after_walk_complete()
```

**Purpose**: Ensures a completed session can still accept a new query and emit fresh results without rewalking.

**Data flow**: Creates a small directory, runs one query to completion, records the number of updates, submits a second query, waits for at least one more update, and asserts the latest snapshot contains the new target file.

**Call relations**: Tests that `matcher_worker` remains alive and responsive after `walk_complete`.

*Call graph*: calls 2 internal fn (default, create_session); 6 external calls (new, assert!, default, write, tempdir, vec!).


##### `tests::session_emits_complete_when_query_changes_with_no_matches`  (lines 873–898)

```
fn session_emits_complete_when_query_changes_with_no_matches()
```

**Purpose**: Checks that even no-match queries still produce completion notifications and updates on subsequent query changes.

**Data flow**: Creates a session over two files, submits a query with no matches, waits for completion, asserts empty results, clears the reporter, submits another no-match query, waits again, and asserts at least one update was emitted.

**Call relations**: Covers the edge case where result sets are empty but the session must still signal completion.

*Call graph*: calls 2 internal fn (default, create_session); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `tests::dropping_session_does_not_cancel_siblings_with_shared_cancel_flag`  (lines 901–932)

```
fn dropping_session_does_not_cancel_siblings_with_shared_cancel_flag()
```

**Purpose**: Verifies that dropping one session only triggers its own shutdown path and does not set or misuse a shared external cancel flag.

**Data flow**: Creates two sessions over different roots sharing one `AtomicBool`, submits queries to both, drops one session, waits for the other reporter to complete, and asserts it still finishes successfully.

**Call relations**: Protects the separation between per-session shutdown and caller-owned cancellation.

*Call graph*: calls 2 internal fn (default, create_session); 9 external calls (new, new, from_millis, from_secs, assert_eq!, default, create_temp_tree, sleep, vec!).


##### `tests::session_emits_updates_when_query_changes`  (lines 935–958)

```
fn session_emits_updates_when_query_changes()
```

**Purpose**: Checks that changing the query after completion produces a new update even when both queries have no matches.

**Data flow**: Creates a session, submits one no-match query and waits for completion, clears the reporter, submits a slightly different no-match query, waits again, and asserts exactly one update was recorded.

**Call relations**: Exercises query-change handling in `matcher_worker` independent of walker progress.

*Call graph*: calls 2 internal fn (default, create_session); 7 external calls (new, from_secs, assert!, assert_eq!, default, create_temp_tree, vec!).


##### `tests::run_returns_matches_for_query`  (lines 961–986)

```
fn run_returns_matches_for_query()
```

**Purpose**: Verifies the one-shot `run` API returns non-empty matches and a total count at least as large as the returned page.

**Data flow**: Creates a temp tree, builds explicit options, calls `run`, and asserts the result contains matches including `file-0000.txt` and that `total_match_count >= matches.len()`.

**Call relations**: End-to-end test of the blocking search API.

*Call graph*: calls 1 internal fn (run); 5 external calls (new, new, assert!, create_temp_tree, vec!).


##### `tests::run_returns_directory_matches_for_query`  (lines 989–1013)

```
fn run_returns_directory_matches_for_query()
```

**Purpose**: Checks that directory paths, not just files, can appear as search matches with the correct `MatchType`.

**Data flow**: Creates a nested directory tree, runs a query for `guides`, and asserts one result has path `docs/guides` and `match_type == MatchType::Directory`.

**Call relations**: Exercises the `Path::is_dir` classification logic in `matcher_worker`.

*Call graph*: calls 1 internal fn (run); 7 external calls (new, new, assert!, create_dir_all, write, tempdir, vec!).


##### `tests::cancel_exits_run`  (lines 1016–1039)

```
fn cancel_exits_run()
```

**Purpose**: Verifies that a pre-set cancellation flag causes the blocking `run` API to exit promptly with empty results.

**Data flow**: Creates a temp tree and an `AtomicBool(true)`, spawns a thread that calls `run`, receives the result through an `mpsc` channel with timeout, joins the thread, and asserts the returned `FileSearchResults` has no matches and zero total count.

**Call relations**: Covers cancellation handling across both worker threads and the one-shot wrapper.

*Call graph*: 8 external calls (new, new, default, from_secs, assert_eq!, create_temp_tree, channel, spawn).


##### `tests::parent_gitignore_outside_repo_does_not_hide_repo_files`  (lines 1048–1102)

```
fn parent_gitignore_outside_repo_does_not_hide_repo_files()
```

**Purpose**: Regression test ensuring a parent directory’s `.gitignore` does not suppress files in a child directory that is not actually a git repository.

**Data flow**: Builds a temp directory tree with a parent `.gitignore` containing `*`, a child repo-like directory without `.git`, and files that should remain visible. It runs searches with `respect_gitignore: true` and asserts `package.json` and `.vscode/settings.json` are still matched.

**Call relations**: Validates the `require_git(true)` walker configuration described in the file comments.

*Call graph*: calls 1 internal fn (run); 7 external calls (new, new, assert!, create_dir_all, write, tempdir, vec!).


##### `tests::git_repo_still_respects_local_gitignore_when_enabled`  (lines 1105–1186)

```
fn git_repo_still_respects_local_gitignore_when_enabled()
```

**Purpose**: Checks that once a `.git` directory exists, local `.gitignore` rules are honored while whitelisted files remain visible.

**Data flow**: Creates a similar fixture but adds `.git`, then runs searches for `package`, `extensions.json`, and `settings.json`, asserting the ignored file is absent while allowed files are present.

**Call relations**: Complements the previous regression test by confirming gitignore behavior still works inside real repositories.

*Call graph*: calls 1 internal fn (run); 7 external calls (new, new, assert!, create_dir_all, write, tempdir, vec!).


### `stdio-to-uds/src/main.rs`

`entrypoint` · `process startup and CLI argument validation`

This small binary wrapper is responsible only for argument parsing and process-level usage errors. It reads `env::args_os()`, skips the executable name, and requires exactly one positional argument representing the Unix domain socket path. If no argument is provided, it prints `Usage: codex-stdio-to-uds <socket-path>` to stderr and exits with status 1. If more than one argument is present, it prints a stricter error message indicating that exactly one argument is expected and also exits with status 1.

When the argument count is correct, the code converts the OS string into a `PathBuf` and calls `codex_stdio_to_uds::run(&socket_path)` inside the Tokio runtime created by `#[tokio::main]`. It does not add any additional transport logic or error handling beyond returning the library result, so connection and relay failures propagate as the program’s `anyhow::Result`. The design keeps the binary thin and leaves all socket and stdio behavior in the reusable library crate.

#### Function details

##### `main`  (lines 6–20)

```
async fn main() -> anyhow::Result<()>
```

**Purpose**: Parses the single required socket-path argument, emits usage errors for invalid invocation, and launches the stdio-to-UDS relay. It is the executable entrypoint.

**Data flow**: It reads OS arguments from `env::args_os()`, skips argv[0], and inspects the remaining iterator. On zero arguments it writes a usage line to stderr and exits the process with code 1; on more than one argument it writes an exact-arity error and exits with code 1. Otherwise it converts the sole argument into a `PathBuf` and awaits `codex_stdio_to_uds::run`, returning that `anyhow::Result<()>`.

**Call relations**: This function is invoked by the operating system when the binary starts. After validating CLI shape, it delegates all actual transport work to the library `run` function.

*Call graph*: 5 external calls (from, run, args_os, eprintln!, exit).


### `tui/src/bin/md-events.rs`

`entrypoint` · `ad hoc developer invocation`

This file is a minimal CLI entrypoint built around `pulldown_cmark::Parser`. It allocates a `String`, reads all of standard input into it with `Read::read_to_string`, and treats any read failure as fatal: the error is printed to stderr and the process exits with status 1. On success, it constructs a parser over the full input buffer and iterates the resulting event stream, printing each event with Rust's debug formatting. There is no incremental streaming, no command-line argument handling, and no transformation of the parser output beyond `Debug` rendering, so the binary acts as a transparent parser probe. Because it reads the entire input before parsing, behavior is deterministic for a given stdin payload, but very large inputs will be buffered fully in memory. The design is intentionally barebones: it exists as a developer tool for understanding parser behavior, not as part of the interactive application runtime.

#### Function details

##### `main`  (lines 4–15)

```
fn main()
```

**Purpose**: Reads all Markdown text from stdin, parses it with `pulldown_cmark`, and prints each parser event. It exits nonzero if stdin cannot be read.

**Data flow**: Starts with an empty `String` buffer → fills it from `io::stdin()` via `read_to_string` → on error writes a formatted message to stderr and terminates the process with exit code 1 → on success constructs `pulldown_cmark::Parser::new(&input)` and prints every yielded event with `println!`.

**Call relations**: As the binary entrypoint, this is invoked directly by the OS when the tool runs. It does not call any project-local helpers; instead it delegates all work to standard I/O and the external Markdown parser, then serializes the parser's event stream to stdout.

*Call graph*: 6 external calls (new, eprintln!, stdin, println!, new, exit).


### `thread-manager-sample/src/main.rs`

`entrypoint` · `process startup, one-shot request handling, shutdown`

This binary is a thin but concrete integration driver for the Codex thread runtime. `main` delegates through `arg0_dispatch_or_else`, so the executable can participate in arg0-based dispatch before running its own logic. `run_main` sets an originator string for telemetry, parses CLI arguments with `clap`, and resolves the prompt either from trailing arguments or from piped stdin; interactive stdin without a prompt and blank piped input are rejected with `bail!`. It then constructs a deliberately minimal ephemeral `Config` via `new_config`, initializes the state DB, auth manager, runtime paths, thread store, environment manager, installation ID, and user-instructions provider, and wires them into `ThreadManager::new`.

After starting a new thread, the sample runs exactly one turn with `run_turn`, then always attempts orderly shutdown and thread removal. `new_config` is intentionally verbose: it fills nearly every `Config` field explicitly, choosing read-only permissions with no approval prompts, local file-backed auth stores, disabled analytics, disabled web search, local thread store, ephemeral mode, VS Code URI opener, and default feature sets. `run_turn` submits a single `Op::UserInput` containing one text item, then loops over `thread.next_event()`. It tracks the current turn ID from `EventMsg::TurnStarted`, maps a curated subset of item/tool/collaboration/exec events into server notifications with `item_event_to_server_notification`, writes each as JSON plus newline to locked stdout, and treats completion, errors, approval requests, permission requests, user-input requests, and dynamic tool requests as terminal outcomes. A mapped notification arriving before `TurnStarted` is treated as an error via `context(...)`.

#### Function details

##### `main`  (lines 81–83)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Starts the sample binary through arg0-aware dispatch. It does not contain business logic itself.

**Data flow**: Takes no arguments, calls `arg0_dispatch_or_else(run_main)`, and returns the resulting `anyhow::Result<()>`.

**Call relations**: This is the process entrypoint; if arg0 dispatch does not intercept execution, control flows into `run_main`.

*Call graph*: 1 external calls (arg0_dispatch_or_else).


##### `run_main`  (lines 85–157)

```
async fn run_main(arg0_paths: Arg0DispatchPaths) -> anyhow::Result<()>
```

**Purpose**: Bootstraps all runtime dependencies for a single Codex thread, obtains the prompt, starts the thread, runs one turn, and performs shutdown cleanup. It is the binary’s main orchestration routine.

**Data flow**: Consumes `Arg0DispatchPaths`, attempts to set a default originator, parses `Args`, derives the prompt from CLI args or stdin, builds a `Config` with `new_config`, initializes state DB and auth, derives `ExecServerRuntimePaths`, creates a thread store and `EnvironmentManager`, resolves installation ID, constructs a `CodexHomeUserInstructionsProvider`, and creates a `ThreadManager`. It then starts a thread, extracts `thread_id` and `thread`, calls `run_turn`, awaits `thread.shutdown_and_wait()`, removes the thread from the manager, propagates any turn or shutdown errors, and returns `Ok(())` on success.

**Call relations**: Called from `main` after arg0 dispatch resolution. It delegates configuration assembly to `new_config` and event processing to `run_turn`, while owning setup and teardown sequencing.

*Call graph*: calls 7 internal fn (new, new, from_codex_home, from_optional_paths, shared_from_config, new_config, run_turn); 12 external calls (clone, new, new, parse, bail!, empty_extension_registry, init_state_db, resolve_installation_id, set_default_originator, thread_store_from_config (+2 more)).


##### `new_config`  (lines 159–295)

```
fn new_config(model: Option<String>, arg0_paths: Arg0DispatchPaths) -> anyhow::Result<Config>
```

**Purpose**: Constructs a fully populated `Config` suitable for this sample’s one-turn execution model. It chooses conservative defaults and injects executable paths from arg0 dispatch.

**Data flow**: Takes an optional model override and `Arg0DispatchPaths`, resolves `codex_home` and current working directory, loads built-in model providers, clones the OpenAI provider entry, and fills a large `Config` struct literal with explicit values for permissions, UI settings, auth storage, workspace roots, runtime paths, thread-store mode, feature flags, telemetry, and many optional experimental fields. After construction it enables default features via `config.features.set(Features::with_defaults())` and returns the configured `Config` or an error.

**Call relations**: This helper is called only by `run_main`, which uses its result to initialize all downstream runtime components.

*Call graph*: calls 9 internal fn (allow_any, default, default, default, default, from_approval_and_profile, with_defaults, read_only, current_dir); called by 1 (run_main); 17 external calls (new, default, new, new, built_in_model_providers, find_codex_home, default, default, default, default (+7 more)).


##### `run_turn`  (lines 297–393)

```
async fn run_turn(thread: &CodexThread, thread_id: &str, prompt: String) -> anyhow::Result<()>
```

**Purpose**: Submits one user prompt to an active `CodexThread`, converts selected emitted events into server notifications, writes them as NDJSON, and stops on completion or unsupported interactive flows. It is the sample’s event-processing loop.

**Data flow**: Takes a `&CodexThread`, thread ID string, and prompt text. It submits `Op::UserInput` containing one `UserInput::Text`, then repeatedly awaits `thread.next_event()`. It updates `current_turn_id` on `EventMsg::TurnStarted`; for a specific set of item/tool/collaboration/exec event variants it calls `item_event_to_server_notification` using the current thread and turn IDs, serializes the notification to locked stdout with `serde_json::to_writer`, appends a newline, and flushes. It returns `Ok(())` on `TurnComplete`, and returns errors via `bail!` for `Error`, `TurnAborted`, approval requests, permission requests, user-input requests, and dynamic tool call requests.

**Call relations**: This function is called by `run_main` after a thread has been started. It depends on the thread runtime to emit events and on the notification-mapping helper to produce the JSON payloads.

*Call graph*: calls 2 internal fn (next_event, submit); called by 1 (run_main); 6 external calls (default, bail!, item_event_to_server_notification, to_writer, stdout, vec!).


### `code-mode-host/src/main.rs`

`entrypoint` · `startup`

This file contains only `fn main() {}`. There is no argument parsing, initialization, logging, runtime setup, or host loop. As written, the compiled binary starts and exits immediately with success.

The presence of this file indicates the crate is configured as an executable target even though its runtime behavior has not yet been implemented or has been intentionally disabled. Readers should not expect any protocol handling or service orchestration here; those responsibilities must live elsewhere or remain future work.

#### Function details

##### `main`  (lines 1–1)

```
fn main()
```

**Purpose**: Serves as the process entry point and immediately returns. It is a no-op placeholder.

**Data flow**: Takes no arguments, reads no state, writes no state, and returns unit.

**Call relations**: Invoked by the operating system when the binary starts. It does not call into any other code paths.


### `ext/extension-api/examples/enabled_extensions.rs`

`entrypoint` · `example startup and prompt contribution`

This example is a host-side walkthrough for the extension API’s shared-state model. `main` first constructs an `ExtensionRegistryBuilder<()>`, installs the example contributors from `shared_state_extension`, and builds the registry. It then creates three `ExtensionData` stores: one session-scoped store and two thread-scoped stores. The key design point the example illustrates is that state sharing is entirely host-controlled: reusing the same `session_store` across multiple prompt contributions shares session counters, while separate thread stores isolate per-thread counters.

Prompt generation is performed by `contribute_prompt`, which iterates `registry.context_contributors()` and awaits each contributor’s `contribute(session_store, thread_store)` future, extending a single `Vec<PromptFragment>` with all returned fragments. Because the example contributors are synchronous-in-practice async blocks, `main` drives them with `block_on_ready`, a minimal executor that polls once using `Waker::noop()` and panics if any future returns `Poll::Pending`. After invoking contributors for one thread twice and another thread once, `main` prints the fragment count from the first prompt and the recorded style/usage contribution counts for the shared session store and each thread store, making the state-sharing behavior visible.

#### Function details

##### `main`  (lines 15–68)

```
fn main()
```

**Purpose**: Runs the example host flow: register contributors, create shared stores, invoke prompt contribution several times, and print the resulting shared-state counters. It demonstrates how store reuse controls whether extension state is shared across prompts and threads.

**Data flow**: It creates an `ExtensionRegistryBuilder<()>`, passes it to `shared_state_extension::install`, builds the registry, constructs three `ExtensionData` stores (`session`, `thread-1`, `thread-2`), calls `contribute_prompt` three times via `block_on_ready`, captures the first call’s fragment vector, and prints fragment counts plus per-store contribution counters using the helper accessors from the shared-state module.

**Call relations**: This is the example binary entrypoint. It orchestrates the whole demonstration by invoking both local helpers and the installed contributors indirectly through the registry.

*Call graph*: calls 4 internal fn (block_on_ready, contribute_prompt, install, new); 2 external calls (new, println!).


##### `contribute_prompt`  (lines 70–80)

```
async fn contribute_prompt(
    registry: &codex_extension_api::ExtensionRegistry<()>,
    session_store: &ExtensionData,
    thread_store: &ExtensionData,
) -> Vec<codex_extension_api::PromptFragment
```

**Purpose**: Collects prompt fragments from every registered context contributor for a given session/thread store pair. It is the host-side loop that fans out one prompt-building request to all contributors.

**Data flow**: Inputs are a registry reference plus `session_store` and `thread_store`. It creates an empty `Vec<PromptFragment>`, iterates `registry.context_contributors()`, awaits each contributor’s `contribute(session_store, thread_store)` future, extends the accumulator with the returned fragments, and returns the combined vector.

**Call relations**: Called by `main` for each simulated prompt request. It delegates actual fragment generation and state mutation to the registered contributors.

*Call graph*: calls 1 internal fn (context_contributors); called by 1 (main); 1 external calls (new).


##### `block_on_ready`  (lines 82–93)

```
fn block_on_ready(future: F) -> F::Output
```

**Purpose**: Synchronously polls a future exactly once and returns its output if it is immediately ready. It exists only for this example, where contributors are expected not to suspend.

**Data flow**: It takes any `Future`, creates a no-op `Waker`, builds a `Context`, pins the future on the stack, polls it once, and either returns the `Poll::Ready` output or panics if the future is `Poll::Pending`.

**Call relations**: Used by `main` to drive `contribute_prompt` without bringing in a full async runtime. The panic documents the example’s assumption that these contributors complete immediately.

*Call graph*: called by 1 (main); 5 external calls (from_waker, as_mut, noop, panic!, pin!).


### App server and notification helpers
These files define the app-server executable surface along with companion test client and file-based notification capture helpers.

### `app-server-test-client/src/main.rs`

`entrypoint` · `startup`

This file contains only the executable bootstrap. `main` constructs a single-threaded Tokio runtime with all runtime components enabled, then blocks on the async `codex_app_server_test_client::run()` function from the library crate. There is no additional CLI parsing or business logic here; all command dispatch, transport setup, tracing, and scenario execution live in `src/lib.rs`.

The design keeps the binary thin and pushes nearly all behavior into the library, which makes the command logic easier to reuse from tests or other binaries and keeps startup concerns isolated. Because `main` returns `anyhow::Result<()>`, any runtime-construction failure or error bubbled up from `run` exits the process with a propagated error rather than being manually handled in this file.

#### Function details

##### `main`  (lines 4–7)

```
fn main() -> Result<()>
```

**Purpose**: Builds the Tokio runtime and executes the async test-client command dispatcher to completion.

**Data flow**: Creates a current-thread Tokio runtime with `enable_all()`, then calls `runtime.block_on(codex_app_server_test_client::run())` and returns its `Result<()>`. Runtime construction errors or command errors propagate directly.

**Call relations**: This is the process entrypoint; after runtime setup it hands control entirely to the library-level `run` function.

*Call graph*: 2 external calls (new_current_thread, run).


### `app-server/src/bin/notify_capture.rs`

`entrypoint` · `startup`

This binary expects exactly two positional arguments after the program name: an output path and a payload. It parses arguments from `env::args_os`, preserving non-UTF-8 path handling for the destination while allowing the payload to be lossy-converted to text. If the first or second argument is missing, or if any extra argument is present, it returns an `anyhow` error or `bail!`s with a precise usage complaint.

The write path is deliberately atomic-ish: it derives a sibling temporary path by appending `.tmp` to the destination’s display string, creates that temp file, writes the payload bytes, calls `sync_all` to flush file contents and metadata, then renames the temp file over the final output path. Each filesystem step is wrapped with `Context` so failures mention the exact path involved. The implementation uses `std::fs::File` plus `std::io::Write` rather than `fs::write` specifically so it can force the sync before rename.

There is no directory creation, locking, or retry logic; callers must ensure the parent directory exists and that rename semantics are acceptable on the host filesystem.

#### Function details

##### `main`  (lines 12–44)

```
fn main() -> Result<()>
```

**Purpose**: Parses the output path and payload from the command line, writes the payload to a temporary file, fsyncs it, and renames it into place. It enforces an exact two-argument interface.

**Data flow**: Reads `env::args_os()` → extracts program name, required output path, required payload, and rejects any extra argument → converts payload to a lossy string, derives `<output>.tmp`, creates the temp file, writes payload bytes, syncs the file, renames temp to final path, and returns `Result<()>`.

**Call relations**: This is the binary entrypoint. It does all work inline and delegates only to standard library filesystem primitives.

*Call graph*: 6 external calls (create, from, bail!, args_os, format!, rename).


### `app-server/src/bin/test_notify_capture.rs`

`entrypoint` · `startup`

This binary is a stripped-down companion to `notify_capture`. It reads two arguments after the executable name using `env::args_os().skip(1)`: the output path and a payload. Unlike the production helper, it requires the payload to be valid UTF-8 by calling `into_string`; invalid UTF-8 becomes an `anyhow!("payload must be valid UTF-8")` error. Missing arguments also produce explicit `anyhow` errors.

For output, it derives a temporary path by replacing or appending the extension with `json.tmp` using `PathBuf::with_extension`. It then writes the payload in one shot with `std::fs::write` and renames the temp file to the final destination with `std::fs::rename`. There is no explicit fsync, no extra-argument validation beyond consuming the two expected arguments, and no contextual wrapping of I/O errors.

The file exists as a lightweight executable fixture for tests or harnesses that need deterministic file emission behavior without depending on the full production binary’s exact implementation details.

#### Function details

##### `main`  (lines 6–23)

```
fn main() -> Result<()>
```

**Purpose**: Reads an output path and UTF-8 payload from the command line, writes the payload to a temporary file, and renames it into place. It is a minimal test-oriented file writer.

**Data flow**: Reads `env::args_os().skip(1)` → parses required output path and required payload string, erroring on missing args or invalid UTF-8 → derives `output_path.with_extension("json.tmp")`, writes the payload bytes to that temp path, renames temp to final path, and returns `Result<()>`.

**Call relations**: This is the binary’s sole entrypoint and performs all work directly with standard library calls.

*Call graph*: 4 external calls (from, args_os, rename, write).


### `app-server/src/main.rs`

`entrypoint` · `startup`

This file is the executable entrypoint for the app-server process. Its central type is `AppServerArgs`, a `clap::Parser` struct that combines several flattened argument groups (`CliConfigOverrides` and `AppServerWebsocketAuthArgs`) with server-specific flags such as `--listen`, `--session-source`, `--strict-config`, and hidden switches for remote control and debug/test behavior. The accepted transport defaults to `AppServerTransport::DEFAULT_LISTEN_URL`, and session source parsing is delegated to `SessionSource::from_startup_arg`, so CLI validation happens before runtime startup.

`main` performs only startup orchestration: it snapshots whether remote control has been globally disabled via environment, then enters `arg0_dispatch_or_else` so the binary can participate in arg0-based dispatch before falling back to normal server startup. Inside that async path it parses CLI args, derives `LoaderOverrides` from debug-only environment variables, converts websocket auth CLI fields into concrete settings, and mutates an `AppServerRuntimeOptions` value. In debug builds, tests can suppress plugin startup tasks or redirect/disable managed config loading without touching system paths like `/etc`. Remote control startup mode is resolved from the combination of the hidden `--remote-control` flag and the external disable signal, with explicit CLI enablement taking precedence. Finally, all assembled inputs are handed to `run_main_with_transport_options`, making this file a thin but important adapter between process startup inputs and the reusable server runtime.

#### Function details

##### `main`  (lines 61–109)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Bootstraps the app-server process by parsing CLI arguments, applying debug/test environment overrides, constructing runtime options, and invoking the shared async server startup routine.

**Data flow**: It first reads process-level remote-control disable state via `codex_app_server::take_remote_control_disabled_env()`. Inside the `arg0_dispatch_or_else` fallback closure, it parses `AppServerArgs` from argv, destructuring `config_overrides`, `listen`, `session_source`, websocket auth args, strict-config mode, and hidden debug flags. It computes `LoaderOverrides` either by disabling managed config entirely for tests or by injecting a managed config `PathBuf` from an environment variable; otherwise it uses the default overrides. It converts auth CLI fields with `try_into_settings()`, initializes `AppServerRuntimeOptions::default()`, optionally sets `plugin_startup_tasks = PluginStartupTasks::Skip` in debug builds, and sets `remote_control_startup_mode` from the `(remote_control, remote_control_disabled)` combination. It then passes `arg0_paths`, config overrides, loader overrides, strictness, analytics default, transport, session source, auth settings, and runtime options into `run_main_with_transport_options`, returning `Ok(())` on success or propagating any startup error.

**Call relations**: This is the process entrypoint and is invoked by the OS when the binary starts. Its first delegation is to `arg0_dispatch_or_else`, which decides whether some alternate arg0-based behavior should run or whether the provided async closure should execute normal app-server startup. Within that closure, `main` relies on the local debug-env helpers to shape config loading behavior and then hands off all real server initialization and execution to the external `run_main_with_transport_options` function.

*Call graph*: 2 external calls (take_remote_control_disabled_env, arg0_dispatch_or_else).


##### `disable_managed_config_from_debug_env`  (lines 111–120)

```
fn disable_managed_config_from_debug_env() -> bool
```

**Purpose**: Checks a debug-only environment variable that tells test runs to suppress managed-config loading entirely.

**Data flow**: In debug builds, it reads `CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG` from the environment with `std::env::var`. If the variable exists, it compares the string against a small accepted truthy set (`"1"`, `"true"`, `"TRUE"`, `"yes"`, `"YES"`) and returns `true` only for those values. In non-debug builds, or when the variable is absent or not truthy, it returns `false`. It does not mutate any state; it only interprets process environment into a boolean.

**Call relations**: It is called from `main` during startup before loader overrides are finalized. Its result takes precedence over the managed-config path hook: when it returns true, `main` chooses `LoaderOverrides::without_managed_config_for_tests()` instead of consulting `managed_config_path_from_debug_env`.

*Call graph*: 2 external calls (matches!, var).


##### `managed_config_path_from_debug_env`  (lines 122–135)

```
fn managed_config_path_from_debug_env() -> Option<PathBuf>
```

**Purpose**: Reads a debug-only environment variable that points the server at an alternate managed config file path for integration testing.

**Data flow**: In debug builds, it reads `CODEX_APP_SERVER_MANAGED_CONFIG_PATH` from the environment using `std::env::var`. If the variable is missing, it returns `None`. If present but the value is the empty string, it also returns `None`; otherwise it converts the string into a `PathBuf` with `PathBuf::from` and returns `Some(path)`. In non-debug builds it always returns `None`. The function is pure aside from reading environment state.

**Call relations**: It is called by `main` only when `disable_managed_config_from_debug_env` is false. `main` uses its optional `PathBuf` to decide whether to build `LoaderOverrides::with_managed_config_path_for_tests(...)` or fall back to default loader behavior.

*Call graph*: 2 external calls (from, var).


### MCP and proxy test servers
This set contains directly runnable MCP-related servers, proxies, and connectivity probes used for integration testing and local experimentation.

### `rmcp-client/src/bin/test_stdio_server.rs`

`entrypoint` · `startup and request handling`

This binary builds a `TestToolServer` and serves it through rmcp's stdio transport. The server precomputes immutable catalogs of `Tool`, `Resource`, and `ResourceTemplate` values and shares them through `Arc<Vec<...>>`, so list operations simply clone the vectors into rmcp result structs. Tool definitions are concrete and schema-rich: `echo` and `echo-tool` accept a required `message` plus optional `env_var`; `cwd` returns the process working directory; `image` converts an environment-provided data URL into an MCP image block; `image_scenario` emits carefully arranged content sequences for TUI rendering edge cases; `sync` and `sync_readonly` coordinate concurrent calls through named Tokio barriers; and `sandbox_meta` returns request `_meta` as structured JSON. Resource support is intentionally tiny but complete: one fixed `memo://codex/example-note` resource and one `memo://codex/{slug}` template.

The most stateful logic is the global `SYNC_BARRIERS` map, a `OnceLock<Mutex<HashMap<String, SyncBarrierState>>>` keyed by barrier id. Calls with the same id must agree on participant count; timeouts or leader completion remove the barrier entry, and pointer equality prevents deleting a newer barrier with the same id. `call_tool` is the central dispatcher: it validates arguments, maps serde failures to MCP `invalid_params`, and returns either structured content or explicit MCP errors. `main` optionally writes its PID to a file for tests, starts the service on stdin/stdout, waits for client shutdown, then yields once so background tasks drain cleanly.

#### Function details

##### `stdio`  (lines 48–50)

```
fn stdio() -> (tokio::io::Stdin, tokio::io::Stdout)
```

**Purpose**: Constructs the stdio transport endpoints used by rmcp to speak JSON-RPC over newline-delimited stdin/stdout.

**Data flow**: It reads no application state, obtains Tokio's process `stdin()` and `stdout()`, and returns them as a tuple `(tokio::io::Stdin, tokio::io::Stdout)`.

**Call relations**: It is invoked by `main` immediately before the server is served, supplying the transport pair passed into rmcp's `serve` extension method.

*Call graph*: called by 1 (main); 2 external calls (stdin, stdout).


##### `TestToolServer::new`  (lines 53–85)

```
fn new() -> Self
```

**Purpose**: Builds the full in-memory test server definition, including all tools, the sample resource, and the sample resource template.

**Data flow**: It creates JSON schemas for `sandbox_meta`, constructs tool values via helper constructors, assembles vectors for tools/resources/templates, wraps each vector in `Arc`, and returns a populated `TestToolServer`.

**Call relations**: It is the constructor used at process startup by `main`; the resulting server instance is later queried through the `ServerHandler` trait methods.

*Call graph*: 7 external calls (new, Borrowed, new, new, from_value, json!, vec!).


##### `TestToolServer::echo_tool`  (lines 87–92)

```
fn echo_tool() -> Tool
```

**Purpose**: Creates the standard `echo` tool definition with its fixed name and description.

**Data flow**: It takes no inputs, forwards the literal tool name and description into the shared echo-tool builder, and returns the resulting `Tool`.

**Call relations**: It is used only during `TestToolServer::new` to populate the tool catalog, delegating all schema and annotation setup to `TestToolServer::build_echo_tool`.

*Call graph*: 1 external calls (build_echo_tool).


##### `TestToolServer::echo_dash_tool`  (lines 94–99)

```
fn echo_dash_tool() -> Tool
```

**Purpose**: Creates an alternate echo tool named `echo-tool` to test tool names that are not valid JavaScript identifiers.

**Data flow**: It takes no inputs, passes a dashed tool name and matching description into the shared echo-tool builder, and returns the resulting `Tool`.

**Call relations**: It is called from `TestToolServer::new` alongside `echo_tool`, reusing `TestToolServer::build_echo_tool` so both tools share identical schemas and output shape.

*Call graph*: 1 external calls (build_echo_tool).


##### `TestToolServer::build_echo_tool`  (lines 101–138)

```
fn build_echo_tool(name: &'static str, description: &'static str) -> Tool
```

**Purpose**: Defines the shared schema, output schema, and read-only annotation for echo-style tools.

**Data flow**: Given a static `name` and `description`, it deserializes an input JSON Schema requiring `message` and optionally allowing `env_var`, constructs a `Tool`, deserializes an output schema with `echo` and nullable `env`, assigns that schema to `tool.output_schema`, marks the tool read-only, and returns it.

**Call relations**: It is the common implementation behind both `TestToolServer::echo_tool` and `TestToolServer::echo_dash_tool`, ensuring the dispatcher in `call_tool` can treat both names identically.

*Call graph*: 6 external calls (new, Borrowed, new, json!, new, from_value).


##### `TestToolServer::cwd_tool`  (lines 140–167)

```
fn cwd_tool() -> Tool
```

**Purpose**: Defines the `cwd` tool that reports the server process's current working directory.

**Data flow**: It builds an empty-object input schema, constructs a `Tool` named `cwd`, attaches an output schema requiring a single string field `cwd`, marks it read-only, and returns it.

**Call relations**: It is called during `TestToolServer::new`; later `call_tool` matches the `cwd` name and produces data conforming to this declared output schema.

*Call graph*: 6 external calls (new, Borrowed, new, json!, new, from_value).


##### `TestToolServer::sync_tool`  (lines 169–210)

```
fn sync_tool() -> Tool
```

**Purpose**: Defines the mutable synchronization tool used to coordinate concurrent test calls with optional sleeps and a named barrier.

**Data flow**: It deserializes an input schema allowing `sleep_before_ms`, `sleep_after_ms`, and a nested `barrier` object with `id`, `participants`, and optional `timeout_ms`; it then constructs a `Tool` named `sync`, attaches an output schema containing a required `result` string, and returns it.

**Call relations**: It is used by `TestToolServer::new` and mirrored at runtime by `call_tool`, which parses matching arguments and delegates execution to `TestToolServer::sync_result`.

*Call graph*: 5 external calls (new, Borrowed, json!, new, from_value).


##### `TestToolServer::sync_readonly_tool`  (lines 212–217)

```
fn sync_readonly_tool() -> Tool
```

**Purpose**: Creates a read-only variant of the synchronization tool under the name `sync_readonly`.

**Data flow**: It starts from `TestToolServer::sync_tool()`, mutates the returned tool's `name` to `sync_readonly`, sets read-only annotations, and returns the modified `Tool`.

**Call relations**: It is added during `TestToolServer::new`; `call_tool` dispatches both `sync` and `sync_readonly` to the same execution path, differing only in advertised annotations.

*Call graph*: 3 external calls (Borrowed, sync_tool, new).


##### `TestToolServer::image_tool`  (lines 219–235)

```
fn image_tool() -> Tool
```

**Purpose**: Defines the simple `image` tool that returns exactly one image content block.

**Data flow**: It builds an empty-object input schema, constructs a `Tool` named `image`, marks it read-only, and returns it without an explicit output schema because the result is content blocks rather than structured JSON.

**Call relations**: It is registered in `TestToolServer::new`; `call_tool` later reads `MCP_TEST_IMAGE_DATA_URL`, parses it with `parse_data_url`, and emits the corresponding image block.

*Call graph*: 6 external calls (new, Borrowed, new, new, from_value, json!).


##### `TestToolServer::image_scenario_tool`  (lines 256–294)

```
fn image_scenario_tool() -> Tool
```

**Purpose**: Defines the manual-testing tool that emits different combinations of text and image content blocks to exercise UI rendering edge cases.

**Data flow**: It deserializes an input schema requiring `scenario` and optionally accepting `caption` and `data_url`, constructs a read-only `Tool` named `image_scenario`, and returns it.

**Call relations**: It is installed by `TestToolServer::new`; `call_tool` parses its arguments with `TestToolServer::parse_call_args` and delegates result construction to `TestToolServer::image_scenario_result`.

*Call graph*: 6 external calls (new, Borrowed, new, new, from_value, json!).


##### `TestToolServer::memo_resource`  (lines 296–308)

```
fn memo_resource() -> Resource
```

**Purpose**: Creates the single concrete sample resource exposed by the test server.

**Data flow**: It fills a `RawResource` with the fixed memo URI, display metadata, and `text/plain` MIME type, wraps it with `Resource::new`, and returns the `Resource`.

**Call relations**: It is called during `TestToolServer::new`; the resulting resource is returned by `list_resources`, and `read_resource` recognizes the same URI when serving contents.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_template`  (lines 310–322)

```
fn memo_template() -> ResourceTemplate
```

**Purpose**: Creates the sample resource template for `memo://codex/{slug}` URIs.

**Data flow**: It fills a `RawResourceTemplate` with the fixed URI template, names, descriptions, and MIME type, wraps it with `ResourceTemplate::new`, and returns the template.

**Call relations**: It is used only by `TestToolServer::new`; `list_resource_templates` later clones and returns this template to clients.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_text`  (lines 324–326)

```
fn memo_text() -> &'static str
```

**Purpose**: Returns the fixed text body served for the sample memo resource.

**Data flow**: It reads no mutable state and returns the `MEMO_CONTENT` string slice.

**Call relations**: It is used by `read_resource` when the requested URI matches the built-in memo resource.


##### `default_sync_timeout_ms`  (lines 363–365)

```
fn default_sync_timeout_ms() -> u64
```

**Purpose**: Supplies the serde default timeout for synchronization barriers.

**Data flow**: It takes no inputs and returns the constant `DEFAULT_SYNC_TIMEOUT_MS` as `u64`.

**Call relations**: Serde uses it while deserializing `SyncBarrierArgs` when `timeout_ms` is omitted from tool arguments.


##### `sync_barrier_map`  (lines 367–369)

```
fn sync_barrier_map() -> &'static tokio::sync::Mutex<HashMap<String, SyncBarrierState>>
```

**Purpose**: Provides access to the lazily initialized global map of active synchronization barriers.

**Data flow**: It reads the `SYNC_BARRIERS` `OnceLock`, initializes it on first use with a Tokio `Mutex<HashMap<String, SyncBarrierState>>`, and returns a shared static reference.

**Call relations**: It is the shared state accessor used by both `wait_on_sync_barrier` and `remove_sync_barrier_if_current` whenever sync tool calls create, inspect, or remove barriers.

*Call graph*: called by 2 (remove_sync_barrier_if_current, wait_on_sync_barrier).


##### `TestToolServer::get_info`  (lines 399–412)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the server's MCP capabilities, including tools, resources, and an experimental sandbox metadata capability.

**Data flow**: It builds `ServerCapabilities` with tools, tool-list-changed, and resources enabled; inserts an experimental capability map entry keyed by `codex/sandbox-state-meta`; wraps that in `ServerInfo`; and adds human-readable instructions.

**Call relations**: rmcp invokes this as part of server initialization so clients know which features and experimental metadata this test server supports.

*Call graph*: 4 external calls (from, new, builder, new).


##### `TestToolServer::list_tools`  (lines 414–427)

```
fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = R
```

**Purpose**: Returns the full static tool catalog without pagination.

**Data flow**: It clones the `Arc<Vec<Tool>>` from `self`, then the async block clones the underlying vector into `ListToolsResult { tools, next_cursor: None, meta: None }`.

**Call relations**: rmcp calls it in response to MCP tool-list requests; it does not delegate further because the tool set is fixed at construction time.


##### `TestToolServer::list_resources`  (lines 429–442)

```
fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output
```

**Purpose**: Returns the full static resource catalog without pagination.

**Data flow**: It clones `self.resources`, then asynchronously clones the underlying `Vec<Resource>` into `ListResourcesResult` with no cursor and no metadata.

**Call relations**: It is invoked by rmcp for MCP resource-list requests and simply exposes the resource vector created in `TestToolServer::new`.


##### `TestToolServer::list_resource_templates`  (lines 444–454)

```
async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResou
```

**Purpose**: Returns the full static resource-template catalog.

**Data flow**: It clones `self.resource_templates` into `ListResourceTemplatesResult` with `next_cursor: None` and `meta: None`.

**Call relations**: rmcp calls it for template-list requests; it serves the single template created during server construction.


##### `TestToolServer::read_resource`  (lines 456–476)

```
async fn read_resource(
        &self,
        ReadResourceRequestParams { uri, .. }: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Re
```

**Purpose**: Serves the built-in memo resource contents or returns a resource-not-found MCP error for any other URI.

**Data flow**: It destructures `ReadResourceRequestParams` to obtain `uri`. If the URI equals `MEMO_URI`, it returns `ReadResourceResult::new` containing one `ResourceContents::TextResourceContents` with `text/plain` and `TestToolServer::memo_text()`. Otherwise it constructs `McpError::resource_not_found` with the missing URI in JSON metadata.

**Call relations**: rmcp invokes it for MCP resource reads after clients discover resources via `list_resources`; it is the only place that turns the static resource definition into actual content bytes.

*Call graph*: 4 external calls (resource_not_found, new, json!, vec!).


##### `TestToolServer::call_tool`  (lines 478–554)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError>
```

**Purpose**: Dispatches incoming tool calls by name, validates and deserializes arguments, executes the requested behavior, and maps failures into MCP errors.

**Data flow**: It consumes `CallToolRequestParams` plus request `context`. For `sandbox_meta`, it returns `context.meta.0` as structured JSON. For `cwd`, it reads `std::env::current_dir()` and returns `{ "cwd": ... }`. For `echo` and `echo-tool`, it deserializes `EchoArgs`, snapshots environment variables, chooses either the requested env var or `MCP_TEST_VALUE`, and returns `{ "echo": "ECHOING: ...", "env": ... }`. For `image`, it reads `MCP_TEST_IMAGE_DATA_URL`, parses it with `parse_data_url`, and returns one image content block. For `image_scenario`, `sync`, and `sync_readonly`, it parses typed arguments via `TestToolServer::parse_call_args` and delegates to `TestToolServer::image_scenario_result` or `TestToolServer::sync_result`. Unknown names become `invalid_params` errors.

**Call relations**: This is the central runtime entrypoint for all tool execution, called by rmcp when a client issues `tools/call`. It delegates specialized parsing and result construction to helper methods and to `parse_data_url`/barrier logic where appropriate.

*Call graph*: calls 1 internal fn (parse_data_url); 13 external calls (invalid_params, image_scenario_result, structured_result, sync_result, format!, json!, success, Object, from_value, current_dir (+3 more)).


##### `TestToolServer::parse_call_args`  (lines 558–572)

```
fn parse_call_args(
        request: &CallToolRequestParams,
        tool_name: &'static str,
    ) -> Result<T, McpError>
```

**Purpose**: Shared helper for deserializing a tool call's argument object into a typed Rust struct with consistent missing-argument errors.

**Data flow**: It reads `request.arguments`; if present, it clones the argument map into a `serde_json::Value::Object` and deserializes it into generic `T`. Deserialization failures become `McpError::invalid_params`. If arguments are absent, it returns an `invalid_params` error naming the tool.

**Call relations**: It is used by `TestToolServer::call_tool` for `image_scenario`, `sync`, and `sync_readonly` so those branches share identical argument validation behavior.

*Call graph*: 4 external calls (invalid_params, format!, Object, from_value).


##### `TestToolServer::image_scenario_result`  (lines 574–645)

```
fn image_scenario_result(args: ImageScenarioArgs) -> Result<CallToolResult, McpError>
```

**Purpose**: Builds a `CallToolResult` whose content blocks match one of several image-rendering test scenarios.

**Data flow**: It takes `ImageScenarioArgs`, optionally parses `args.data_url` with `parse_data_url` or falls back to the built-in tiny PNG, chooses a default caption when absent, then pushes `rmcp::model::Content` or annotated raw image blocks into a `Vec` according to `args.scenario`. Cases include image-only, text-before-image, invalid-image-before-valid-image, multiple images, image-then-text, and text-only. It returns `CallToolResult::success(content)` or an `invalid_params` error if a supplied data URL is malformed.

**Call relations**: It is called only from the `image_scenario` branch of `TestToolServer::call_tool`, encapsulating all scenario-specific content ordering and metadata details.

*Call graph*: calls 1 internal fn (parse_data_url); 8 external calls (new, success, new, image, text, new, Image, json!).


##### `TestToolServer::sync_result`  (lines 647–665)

```
async fn sync_result(args: SyncArgs) -> Result<CallToolResult, McpError>
```

**Purpose**: Executes the synchronization tool by optionally sleeping before and after a barrier wait, then returning a structured success payload.

**Data flow**: It reads `SyncArgs`. If `sleep_before_ms` is present and positive, it awaits `sleep`. If `barrier` is present, it awaits `wait_on_sync_barrier`. If `sleep_after_ms` is present and positive, it sleeps again. On success it returns `TestToolServer::structured_result(json!({"result":"ok"}))`; barrier validation failures propagate as MCP errors.

**Call relations**: It is invoked by `TestToolServer::call_tool` for both `sync` and `sync_readonly`, delegating the shared barrier coordination to `wait_on_sync_barrier`.

*Call graph*: calls 1 internal fn (wait_on_sync_barrier); 4 external calls (from_millis, structured_result, json!, sleep).


##### `TestToolServer::structured_result`  (lines 667–671)

```
fn structured_result(value: serde_json::Value) -> CallToolResult
```

**Purpose**: Creates a successful tool result whose payload lives in `structured_content` rather than text/image content blocks.

**Data flow**: It starts from `CallToolResult::success(Vec::new())`, assigns the provided `serde_json::Value` into `result.structured_content`, and returns the modified result.

**Call relations**: It is the common result constructor used by several `call_tool` branches and by `TestToolServer::sync_result` to keep structured-return behavior consistent.

*Call graph*: 2 external calls (new, success).


##### `wait_on_sync_barrier`  (lines 674–734)

```
async fn wait_on_sync_barrier(args: SyncBarrierArgs) -> Result<(), McpError>
```

**Purpose**: Coordinates callers on a named Tokio barrier with participant-count consistency checks and timeout-based cleanup.

**Data flow**: It consumes `SyncBarrierArgs`. It first rejects `participants == 0` and `timeout_ms == 0` with `invalid_params`. It then locks the global barrier map from `sync_barrier_map()`: if the id already exists with a different participant count, it errors; otherwise it reuses or inserts an `Arc<Barrier>`. It waits on that barrier under `tokio::time::timeout`. On timeout it removes the barrier if still current via `remove_sync_barrier_if_current` and returns an error. If the wait succeeds and this caller is the barrier leader, it removes the barrier entry. Otherwise it returns `Ok(())`.

**Call relations**: It is called by `TestToolServer::sync_result` whenever a sync tool invocation includes a barrier specification. It relies on `sync_barrier_map` for shared state and `remove_sync_barrier_if_current` for safe cleanup.

*Call graph*: calls 2 internal fn (remove_sync_barrier_if_current, sync_barrier_map); called by 1 (sync_result); 6 external calls (new, new, from_millis, invalid_params, format!, timeout).


##### `remove_sync_barrier_if_current`  (lines 736–743)

```
async fn remove_sync_barrier_if_current(barrier_id: &str, barrier: &Arc<Barrier>)
```

**Purpose**: Deletes a barrier-map entry only if it still points at the exact barrier instance the caller expects.

**Data flow**: It locks the global map from `sync_barrier_map()`, looks up `barrier_id`, compares the stored `Arc<Barrier>` with the provided one using `Arc::ptr_eq`, and removes the entry only on pointer match.

**Call relations**: It is used by `wait_on_sync_barrier` after timeout or leader completion to avoid accidentally deleting a newer barrier that reused the same id.

*Call graph*: calls 1 internal fn (sync_barrier_map); called by 1 (wait_on_sync_barrier); 1 external calls (ptr_eq).


##### `parse_data_url`  (lines 745–750)

```
fn parse_data_url(url: &str) -> Option<(String, String)>
```

**Purpose**: Performs minimal parsing of a `data:` URL into MIME type and raw base64 payload text.

**Data flow**: Given a string, it strips the `data:` prefix, splits once on the first comma into metadata and data, splits metadata once on `;` to isolate the MIME type, and returns `Some((mime_type, data))` or `None` if required delimiters are missing.

**Call relations**: It is used by the `image` branch of `TestToolServer::call_tool` and by `TestToolServer::image_scenario_result` to turn test-provided data URLs into MCP image content fields.

*Call graph*: called by 2 (call_tool, image_scenario_result).


##### `main`  (lines 753–768)

```
async fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Starts the stdio test server process, optionally records its PID for tests, and waits until the client disconnects.

**Data flow**: It logs startup to stderr, optionally reads `MCP_TEST_PID_FILE` and writes the current process id there, constructs the service with `TestToolServer::new`, serves it over `stdio()`, awaits the returned running handle's `waiting()` future, yields once to let background tasks finish, and returns success or any propagated startup/transport error.

**Call relations**: As the binary entrypoint, it is the only top-level driver: it constructs the server, invokes rmcp serving, and then remains active until the stdio client session ends.

*Call graph*: calls 2 internal fn (new, stdio); 5 external calls (eprintln!, var, write, id, yield_now).


### `rmcp-client/src/bin/rmcp_test_server.rs`

`entrypoint` · `test server startup, stdio request handling, shutdown`

This binary is a lightweight MCP server used for testing client behavior over stdio transport. `TestToolServer` stores its tool catalog in `Arc<Vec<Tool>>` so cloned handlers can cheaply share immutable tool definitions. `new` currently registers one tool, `echo`, whose input schema requires a `message` string and optionally accepts `env_var`; its output schema promises an object with `echo` and nullable `env` fields. Both schemas are built from `serde_json::json!` values and deserialized into `rmcp::model::JsonObject`.

The `ServerHandler` implementation exposes standard MCP metadata. `get_info` enables tools and tool-list-changed capability flags. `list_tools` clones the shared tool vector into a `ListToolsResult` with no pagination cursor or metadata. `call_tool` matches on `request.name`: for `echo`, it requires arguments, converts the incoming argument map into a JSON object, deserializes it into `EchoArgs`, snapshots the current process environment into a `HashMap<String, String>`, chooses either the requested variable name or default `MCP_TEST_VALUE`, and returns a successful `CallToolResult` whose `structured_content` contains the echoed message and the looked-up environment value. Unknown tool names and malformed/missing arguments become MCP invalid-params errors.

The async `main` function logs startup, constructs the server, serves it over `(stdin, stdout)`, waits for the client session to finish, then yields once to let background tasks drain before exiting cleanly.

#### Function details

##### `stdio`  (lines 24–26)

```
fn stdio() -> (tokio::io::Stdin, tokio::io::Stdout)
```

**Purpose**: Returns the Tokio stdin/stdout pair used as the MCP transport for this test server. It isolates transport construction behind a tiny helper.

**Data flow**: Takes no arguments and returns `(tokio::io::stdin(), tokio::io::stdout())`.

**Call relations**: Called by `main` when starting the RMCP service over stdio.

*Call graph*: called by 1 (main); 2 external calls (stdin, stdout).


##### `TestToolServer::new`  (lines 28–33)

```
fn new() -> Self
```

**Purpose**: Constructs the test server with its static tool catalog. At present that catalog contains only the `echo` tool.

**Data flow**: Takes no arguments, builds `tools = vec![Self::echo_tool()]`, wraps it in `Arc::new(tools)`, and returns `TestToolServer { tools }`.

**Call relations**: Used during binary startup from `main`. It delegates actual tool definition construction to `TestToolServer::echo_tool`.

*Call graph*: called by 2 (main, main); 2 external calls (new, vec!).


##### `TestToolServer::echo_tool`  (lines 35–71)

```
fn echo_tool() -> Tool
```

**Purpose**: Defines the `echo` tool, including both input and output JSON schemas and human-readable metadata. It prepares the `Tool` object advertised to clients.

**Data flow**: Builds an input schema JSON object requiring `message` and optionally `env_var`, deserializes it into `JsonObject`, constructs `Tool::new` with name `echo`, description text, and the input schema, then builds and deserializes an output schema describing `echo` and nullable `env`, assigns it to `tool.output_schema`, and returns the configured `Tool`.

**Call relations**: Called only by `TestToolServer::new` to populate the server’s tool list.

*Call graph*: 5 external calls (new, Borrowed, json!, new, from_value).


##### `TestToolServer::get_info`  (lines 81–88)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the server’s capabilities to MCP clients. It declares support for tools and tool-list-changed notifications.

**Data flow**: Borrows `self`, builds `ServerCapabilities` with `.enable_tools()` and `.enable_tool_list_changed()`, wraps that in `ServerInfo::new(...)`, and returns the `ServerInfo`.

**Call relations**: Invoked by the RMCP framework as part of server handshake/metadata exchange.

*Call graph*: 2 external calls (builder, new).


##### `TestToolServer::list_tools`  (lines 90–103)

```
fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = R
```

**Purpose**: Returns the current tool catalog to the client. It serves the immutable shared tool list without pagination.

**Data flow**: Borrows `self`, clones `self.tools` into the async block, and returns `Ok(ListToolsResult { tools: (*tools).clone(), next_cursor: None, meta: None })`.

**Call relations**: Called by the RMCP framework when the client requests available tools. It uses the tool vector prepared by `TestToolServer::new`.


##### `TestToolServer::call_tool`  (lines 105–141)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError>
```

**Purpose**: Executes the requested tool invocation, currently supporting only `echo`. It validates arguments, snapshots environment variables, and returns structured JSON content.

**Data flow**: Takes `request: CallToolRequestParams` and matches `request.name.as_ref()`. For `"echo"`, it requires `request.arguments`, converts the argument map into `serde_json::Value::Object(arguments.into_iter().collect())`, deserializes that into `EchoArgs`, collects `std::env::vars()` into `HashMap<String, String>`, chooses `args.env_var.as_deref().unwrap_or("MCP_TEST_VALUE")`, builds `structured_content = json!({ "echo": args.message, "env": env_snapshot.get(env_name) })`, creates `CallToolResult::success(Vec::new())`, sets `structured_content`, and returns it. Missing arguments, deserialization failures, and unknown tool names return `McpError::invalid_params(...)`.

**Call relations**: Invoked by the RMCP framework for tool execution requests. It is the file’s main behavior implementation and relies on the schema/argument shape established by `echo_tool`.

*Call graph*: 8 external calls (invalid_params, new, format!, json!, success, Object, from_value, vars).


##### `main`  (lines 145–157)

```
async fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Starts the stdio MCP test server and waits for the client session to complete. It also yields once before exit to help background tasks shut down cleanly.

**Data flow**: Logs startup to stderr, constructs `TestToolServer::new()`, starts serving it with `service.serve(stdio()).await?`, awaits `running.waiting().await?`, then awaits `task::yield_now()` and returns `Ok(())`.

**Call relations**: This is the binary entrypoint. It wires together `TestToolServer::new` and `stdio`, then hands control to the RMCP service runtime until the client disconnects.

*Call graph*: calls 2 internal fn (new, stdio); 2 external calls (eprintln!, yield_now).


### `rmcp-client/src/bin/test_streamable_http_server.rs`

`entrypoint` · `startup and HTTP request handling`

This binary hosts the same basic MCP surface as the stdio test server—one `echo` tool plus a sample memo resource and template—but wraps it in an Axum router and rmcp's `StreamableHttpService`. Startup begins by parsing a bind address from environment, retrying `TcpListener::bind` on `AddrInUse`, and exiting quietly on `PermissionDenied` with a diagnostic about missing network access. Once bound, it can write the actual address to `MCP_STREAMABLE_HTTP_BOUND_ADDR_FILE`, then serves `/mcp` plus several test-only control routes.

The distinctive logic is the `PostFailureState`, an `Arc<Mutex<Option<ArmedFailure>>>` shared through middleware. Control endpoints accept JSON describing an HTTP status, remaining failure count, optional `WWW-Authenticate` headers, optional content type, and optional body; they arm failures targeted at initialize POSTs, initialized notifications, or later session POSTs. The `fail_mcp_post_when_armed` middleware intercepts only `POST /mcp`, buffers the request body, detects whether the request has an MCP session id and which JSON-RPC method it carries, and conditionally returns the armed synthetic response while decrementing the remaining count. Another optional middleware, enabled by `MCP_EXPECT_BEARER`, rejects all non-well-known requests lacking the exact expected `Authorization` header. The server also exposes OAuth authorization-server metadata under `/.well-known/oauth-authorization-server/mcp`, deriving endpoint URLs from the `Host` header when present.

#### Function details

##### `main`  (lines 116–206)

```
async fn main() -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Bootstraps the Axum-based streamable HTTP test server, installs middleware and control routes, and serves until shutdown.

**Data flow**: It parses the desired bind address with `parse_bind_addr`, creates default `PostFailureState`, retries TCP bind on address-in-use with a fixed delay, optionally writes the actual bound address to `MCP_STREAMABLE_HTTP_BOUND_ADDR_FILE`, logs the final MCP endpoint, builds a `Router` containing failure-control POST routes, OAuth metadata GET, and a nested `/mcp` `StreamableHttpService`, layers `fail_mcp_post_when_armed`, optionally layers `require_bearer` when `MCP_EXPECT_BEARER` is set, then awaits `axum::serve` and yields once before returning.

**Call relations**: As the binary entrypoint, it orchestrates all server setup. It depends on `parse_bind_addr` for configuration and wires in `arm_*` handlers, `fail_mcp_post_when_armed`, and optionally `require_bearer` into the request path.

*Call graph*: calls 1 internal fn (parse_bind_addr); 18 external calls (new, from_millis, default, new, default, new, get, post, serve, eprintln! (+8 more)).


##### `TestToolServer::get_info`  (lines 209–217)

```
fn get_info(&self) -> ServerInfo
```

**Purpose**: Advertises the MCP capabilities supported by the HTTP test server.

**Data flow**: It builds `ServerCapabilities` with tools, tool-list-changed, and resources enabled, wraps them in `ServerInfo`, and returns that value.

**Call relations**: rmcp invokes it during MCP initialization for the nested `/mcp` service so clients can discover the server's supported features.

*Call graph*: 2 external calls (builder, new).


##### `TestToolServer::list_tools`  (lines 219–232)

```
fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = R
```

**Purpose**: Returns the static list of tools exposed by the HTTP test server.

**Data flow**: It clones `self.tools`, then asynchronously clones the underlying vector into `ListToolsResult` with no pagination cursor or metadata.

**Call relations**: It is called by rmcp in response to MCP tool-list requests and serves the catalog created by `TestToolServer::new`.


##### `TestToolServer::list_resources`  (lines 234–247)

```
fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output
```

**Purpose**: Returns the static list of resources exposed by the HTTP test server.

**Data flow**: It clones `self.resources`, then asynchronously clones the underlying vector into `ListResourcesResult` with `next_cursor: None` and `meta: None`.

**Call relations**: rmcp invokes it for MCP resource-list requests; it simply exposes the resource vector assembled at construction.


##### `TestToolServer::list_resource_templates`  (lines 249–259)

```
async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResou
```

**Purpose**: Returns the static list of resource templates exposed by the HTTP test server.

**Data flow**: It clones `self.resource_templates` into `ListResourceTemplatesResult` with no pagination cursor and no metadata.

**Call relations**: It is called by rmcp for template-list requests and returns the single memo template created in `TestToolServer::new`.


##### `TestToolServer::read_resource`  (lines 261–281)

```
async fn read_resource(
        &self,
        ReadResourceRequestParams { uri, .. }: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Re
```

**Purpose**: Serves the built-in memo resource contents or reports a resource-not-found MCP error.

**Data flow**: It extracts `uri` from `ReadResourceRequestParams`. If it matches `MEMO_URI`, it returns a `ReadResourceResult` containing one `TextResourceContents` item with `text/plain` and `TestToolServer::memo_text()`. Otherwise it returns `McpError::resource_not_found` with the missing URI in JSON metadata.

**Call relations**: rmcp calls it when a client reads a resource discovered through `list_resources`; it is the content-serving counterpart to the static resource definition.

*Call graph*: 4 external calls (resource_not_found, new, json!, vec!).


##### `TestToolServer::call_tool`  (lines 283–318)

```
async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, McpError>
```

**Purpose**: Executes the only supported tool, `echo`, and rejects all other tool names.

**Data flow**: It matches `request.name`. For `echo`, it requires `request.arguments`, deserializes them into `EchoArgs`, snapshots environment variables, builds structured JSON containing `ECHOING: <message>` and the value of `MCP_TEST_VALUE`, stores that JSON in `CallToolResult.structured_content`, and returns success. Missing or malformed arguments become `invalid_params`; unknown tool names also become `invalid_params`.

**Call relations**: This is the runtime tool dispatcher used by rmcp for `/mcp` tool calls. Unlike the stdio test server, it keeps behavior intentionally minimal so HTTP transport tests can focus on protocol behavior.

*Call graph*: 8 external calls (invalid_params, new, format!, json!, success, Object, from_value, vars).


##### `TestToolServer::new`  (lines 322–331)

```
fn new() -> Self
```

**Purpose**: Constructs the HTTP test server's fixed tool, resource, and template catalogs.

**Data flow**: It creates vectors containing `Self::echo_tool()`, `Self::memo_resource()`, and `Self::memo_template()`, wraps each vector in `Arc`, and returns a `TestToolServer`.

**Call relations**: It is supplied to `StreamableHttpService::new` as the per-session server factory, so each MCP session gets a fresh handler instance with the same static definitions.

*Call graph*: 2 external calls (new, vec!).


##### `TestToolServer::echo_tool`  (lines 333–370)

```
fn echo_tool() -> Tool
```

**Purpose**: Defines the `echo` tool schema, output schema, and read-only annotation for the HTTP test server.

**Data flow**: It deserializes an input schema requiring `message` and optionally allowing `env_var`, constructs a `Tool` named `echo`, deserializes an output schema with required `echo` and nullable `env`, assigns that schema to `tool.output_schema`, marks the tool read-only, and returns it.

**Call relations**: It is called only from `TestToolServer::new`; `TestToolServer::call_tool` later returns structured content matching this declared schema.

*Call graph*: 6 external calls (new, Borrowed, new, json!, new, from_value).


##### `TestToolServer::memo_resource`  (lines 372–384)

```
fn memo_resource() -> Resource
```

**Purpose**: Creates the sample memo resource advertised by the HTTP test server.

**Data flow**: It fills a `RawResource` with the fixed memo URI, display metadata, and `text/plain` MIME type, wraps it with `Resource::new`, and returns the resulting `Resource`.

**Call relations**: It is used during `TestToolServer::new`; the resulting resource is listed by `list_resources` and recognized by `read_resource`.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_template`  (lines 386–398)

```
fn memo_template() -> ResourceTemplate
```

**Purpose**: Creates the sample memo resource template advertised by the HTTP test server.

**Data flow**: It fills a `RawResourceTemplate` with the fixed URI template and descriptive metadata, wraps it with `ResourceTemplate::new`, and returns it.

**Call relations**: It is called from `TestToolServer::new` and later returned by `list_resource_templates`.

*Call graph*: 1 external calls (new).


##### `TestToolServer::memo_text`  (lines 400–402)

```
fn memo_text() -> &'static str
```

**Purpose**: Returns the fixed text body for the sample memo resource.

**Data flow**: It reads no mutable state and returns the `MEMO_CONTENT` string slice.

**Call relations**: It is used by `TestToolServer::read_resource` when serving the built-in memo URI.


##### `parse_bind_addr`  (lines 405–411)

```
fn parse_bind_addr() -> Result<SocketAddr, Box<dyn std::error::Error>>
```

**Purpose**: Resolves the server bind address from environment variables with a localhost default.

**Data flow**: It checks `MCP_STREAMABLE_HTTP_BIND_ADDR`, then `BIND_ADDR`, falling back to `127.0.0.1:3920`, parses the chosen string into `SocketAddr`, and returns it or a boxed parse error.

**Call relations**: It is called once by `main` during startup before the TCP listener bind loop begins.

*Call graph*: called by 1 (main); 1 external calls (var).


##### `require_bearer`  (lines 413–430)

```
async fn require_bearer(
    State(expected): State<Arc<String>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
```

**Purpose**: Axum middleware that enforces an exact bearer token on most requests when bearer auth testing is enabled.

**Data flow**: It receives the expected header string from `State<Arc<String>>`, inspects the incoming `Request<Body>`, bypasses checks for `/.well-known/` paths, compares the `Authorization` header bytes against the expected bytes, and either forwards the request to `next.run` or returns `StatusCode::UNAUTHORIZED`.

**Call relations**: It is conditionally layered by `main` only when `MCP_EXPECT_BEARER` is present, allowing tests to verify client auth behavior while still permitting OAuth metadata discovery.

*Call graph*: 3 external calls (run, headers, uri).


##### `arm_session_post_failure`  (lines 432–437)

```
async fn arm_session_post_failure(
    State(state): State<PostFailureState>,
    Json(request): Json<ArmSessionPostFailureRequest>,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Control-route handler that arms a synthetic failure for session-scoped MCP POST requests.

**Data flow**: It extracts shared `PostFailureState` and a JSON `ArmSessionPostFailureRequest`, then forwards both plus `ArmedFailureTarget::Session` into `arm_post_failure`, returning that result.

**Call relations**: It is mounted by `main` at `/test/control/session-post-failure` and exists purely to configure later behavior in `fail_mcp_post_when_armed`.

*Call graph*: calls 1 internal fn (arm_post_failure).


##### `arm_initialize_post_failure`  (lines 439–444)

```
async fn arm_initialize_post_failure(
    State(state): State<PostFailureState>,
    Json(request): Json<ArmSessionPostFailureRequest>,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Control-route handler that arms a synthetic failure for initialize POST requests before a session id exists.

**Data flow**: It extracts state and JSON request data, then delegates to `arm_post_failure` with `ArmedFailureTarget::Initialize`.

**Call relations**: It is mounted by `main` at `/test/control/initialize-post-failure` so tests can force failures specifically on the initial MCP initialize request.

*Call graph*: calls 1 internal fn (arm_post_failure).


##### `arm_initialized_notification_post_failure`  (lines 446–451)

```
async fn arm_initialized_notification_post_failure(
    State(state): State<PostFailureState>,
    Json(request): Json<ArmSessionPostFailureRequest>,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Control-route handler that arms a synthetic failure for the `notifications/initialized` POST.

**Data flow**: It extracts state and JSON request data, then delegates to `arm_post_failure` with `ArmedFailureTarget::InitializedNotification`.

**Call relations**: It is mounted by `main` at `/test/control/initialized-notification-post-failure` and configures the middleware to fail only that notification phase.

*Call graph*: calls 1 internal fn (arm_post_failure).


##### `arm_post_failure`  (lines 453–482)

```
async fn arm_post_failure(
    state: PostFailureState,
    request: ArmSessionPostFailureRequest,
    target: ArmedFailureTarget,
) -> Result<StatusCode, StatusCode>
```

**Purpose**: Validates a failure-control request and stores or clears the currently armed synthetic HTTP failure.

**Data flow**: It converts `request.status` into `StatusCode`, parses each raw `www_authenticate_headers` string into `HeaderValue`, optionally parses `content_type`, and builds `Some(ArmedFailure { target, status, remaining, www_authenticate_headers, content_type, body })` unless `remaining == 0`, in which case it stores `None`. It writes the result into `state.armed_failure` under the mutex and returns `204 No Content`, or `400 Bad Request` on invalid status/header values.

**Call relations**: It is the shared implementation behind all three `arm_*` control handlers, centralizing validation and state mutation for the middleware-driven failure injection path.

*Call graph*: called by 3 (arm_initialize_post_failure, arm_initialized_notification_post_failure, arm_session_post_failure); 1 external calls (from_u16).


##### `fail_mcp_post_when_armed`  (lines 484–545)

```
async fn fail_mcp_post_when_armed(
    State(state): State<PostFailureState>,
    request: Request<Body>,
    next: Next,
) -> Response
```

**Purpose**: Axum middleware that conditionally replaces `POST /mcp` responses with a pre-armed synthetic failure based on session phase and JSON-RPC method.

**Data flow**: It first passes through any non-`POST /mcp` request. For MCP POSTs, it splits the request, buffers the body up to `MAX_MCP_POST_BODY_BYTES`, returns `400` if body reading fails, detects whether the request has the `mcp-session-id` header, extracts the JSON-RPC method via `request_mcp_method`, then locks `state.armed_failure`. If an armed failure matches the current phase (`Initialize`, `InitializedNotification`, or `Session`) and still has remaining uses, it decrements `remaining`, optionally clears the armed state when it reaches zero, constructs a `Response` with the configured status/body/content-type and appended `WWW-Authenticate` headers, and returns it. Otherwise it reconstructs the request from the saved parts and body bytes and forwards it to `next.run`.

**Call relations**: It is layered globally by `main` ahead of the nested MCP service. Its behavior is configured by the `arm_*` control endpoints and depends on `request_mcp_method` to distinguish initialized notifications from other session traffic.

*Call graph*: calls 1 internal fn (request_mcp_method); 8 external calls (run, to_bytes, from_parts, into_parts, method, uri, new, from).


##### `request_mcp_method`  (lines 547–553)

```
fn request_mcp_method(body: &[u8]) -> Option<String>
```

**Purpose**: Extracts the JSON-RPC `method` string from a raw MCP POST body when present.

**Data flow**: It attempts to deserialize the byte slice into `serde_json::Value`, looks up the `method` field, converts it to `&str`, clones it into `String`, and returns `Some(method)` or `None` if parsing or field extraction fails.

**Call relations**: It is used only by `fail_mcp_post_when_armed` to classify intercepted MCP POSTs by protocol phase.

*Call graph*: called by 1 (fail_mcp_post_when_armed).


### `mcp-server/src/main.rs`

`entrypoint` · `startup`

This binary file is intentionally thin. Its only job is to invoke `codex_arg0::arg0_dispatch_or_else`, which determines the effective executable layout and supplies an `Arg0DispatchPaths` value to an async closure. Inside that closure, it calls `codex_mcp_server::run_main` with default CLI config overrides and `strict_config` hard-coded to `false`, then propagates any error.

The design keeps process setup logic in `lib.rs` while preserving the arg0-based dispatch behavior expected by the wider Codex toolchain. Because the closure is async, the binary can remain synchronous at the top level while still delegating to the Tokio-based server runtime. There is no additional parsing, logging, or shutdown logic here; all substantive behavior lives in the library.

#### Function details

##### `main`  (lines 6–16)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Starts the MCP server binary by resolving dispatch paths and invoking the async library runner. It is the process entrypoint exposed to the OS.

**Data flow**: It takes no explicit arguments and returns `anyhow::Result<()>`. Through `arg0_dispatch_or_else`, it receives `Arg0DispatchPaths`, constructs default `CliConfigOverrides`, passes those plus `false` for strict config into `run_main`, awaits completion, and forwards success or failure outward.

**Call relations**: This function is the top of the runtime call chain. Its only substantive delegation is to `arg0_dispatch_or_else`, which in turn invokes the closure that calls `run_main`.

*Call graph*: 1 external calls (arg0_dispatch_or_else).


### `responses-api-proxy/src/main.rs`

`entrypoint` · `process startup`

This binary file contains only startup glue. The `pre_main` function is annotated with `#[ctor::ctor]`, so it runs before the standard program entrypoint and invokes `codex_process_hardening::pre_main_hardening()`. That means process-level hardening is applied as early as possible, before argument parsing or network setup.

The actual `main` function is intentionally minimal: it parses CLI arguments into `ResponsesApiProxyArgs` using Clap’s derived parser and then hands control to `codex_responses_api_proxy::run_main(args)`. All substantive behavior—stdin auth loading, listener binding, request forwarding, optional dump writing, and shutdown handling—lives in the library. This separation keeps the binary focused on executable concerns while allowing the proxy logic to be reused or tested independently through the library API.

#### Function details

##### `pre_main`  (lines 5–7)

```
fn pre_main()
```

**Purpose**: Runs process hardening before the normal Rust entrypoint executes. It exists solely for early initialization side effects.

**Data flow**: Takes no arguments, calls `codex_process_hardening::pre_main_hardening()`, and returns `()`. It does not manage local state.

**Call relations**: Triggered automatically by the constructor attribute during process startup, before `main` parses arguments or invokes library logic.

*Call graph*: 1 external calls (pre_main_hardening).


##### `main`  (lines 9–12)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Parses CLI arguments and delegates execution to the proxy library entrypoint. It keeps the binary wrapper extremely thin.

**Data flow**: Takes no explicit arguments, obtains `ResponsesApiProxyArgs` via `ResponsesApiProxyArgs::parse()`, passes them to `codex_responses_api_proxy::run_main(args)`, and returns that `anyhow::Result<()>`.

**Call relations**: This is the executable’s standard entrypoint. After `pre_main` has already run, it hands off all real work to `run_main` in the library crate.

*Call graph*: 2 external calls (parse, run_main).


### `codex-client/src/bin/custom_ca_probe.rs`

`entrypoint` · `subprocess test startup and optional one-shot request handling`

This binary exists specifically to test the shared custom-CA logic without mutating process-global environment variables inside the main test runner. `main` creates a single-threaded Tokio runtime, exits with code 1 if runtime creation fails, and otherwise blocks on `run_probe`. Successful completion prints `ok`; any probe error is rendered to stderr and terminates the process nonzero so integration tests can assert on both success and failure text.

`run_probe` reads three probe-specific environment variables: an optional proxy URL, an optional target URL to actually contact, and a TLS-1.3 flag. It starts from `reqwest::Client::builder()`, adds a 5-second timeout only when a real request will be sent, and optionally forces a minimum TLS version of 1.3. It then delegates client construction to `build_probe_client`, which chooses between the production custom-CA path with an explicit HTTPS proxy and the subprocess-test helper that disables reqwest proxy autodetection for hermetic tests. If a target URL is present, `run_probe` sends a fixed form-encoded POST via `post_probe_request` and validates both HTTP success and exact body text `ok`.

The design keeps all CA-loading logic in `codex_client`, so this file is a thin orchestration wrapper around environment-driven setup and observable process exit behavior.

#### Function details

##### `main`  (lines 26–45)

```
fn main()
```

**Purpose**: Bootstraps a current-thread Tokio runtime, runs the async probe, and converts success or failure into stable process output and exit codes.

**Data flow**: It reads no probe inputs directly beyond runtime creation. It attempts to build a Tokio runtime; on failure it writes an error to stderr and exits the process with status 1. On success it blocks on `run_probe()`, prints `ok` to stdout when that returns `Ok(())`, or prints the returned error string to stderr and exits 1 when it returns `Err`.

**Call relations**: This is the binary entrypoint. It is the sole caller of `run_probe`, and it does not implement probe logic itself; instead it wraps runtime setup and process-level reporting around the async workflow.

*Call graph*: calls 1 internal fn (run_probe); 4 external calls (eprintln!, println!, exit, new_current_thread).


##### `run_probe`  (lines 47–63)

```
async fn run_probe() -> Result<(), String>
```

**Purpose**: Reads probe configuration from environment variables, prepares a reqwest builder accordingly, constructs the client, and optionally performs the probe request.

**Data flow**: It reads `CODEX_CUSTOM_CA_PROBE_PROXY`, `CODEX_CUSTOM_CA_PROBE_URL`, and `CODEX_CUSTOM_CA_PROBE_TLS13` from the process environment. From those values it derives an optional proxy URL, optional target URL, a base `reqwest::ClientBuilder`, an optional 5-second timeout, and an optional minimum TLS version. It passes the builder and proxy choice into `build_probe_client`, then if a target URL exists it awaits `post_probe_request`; otherwise it returns `Ok(())` immediately.

**Call relations**: Called only by `main` after runtime setup. It delegates client construction to `build_probe_client` so proxy-vs-hermetic behavior stays centralized, and delegates actual network verification to `post_probe_request` only when the caller requested an HTTPS probe.

*Call graph*: calls 2 internal fn (build_probe_client, post_probe_request); called by 1 (main); 4 external calls (from_secs, builder, var, var_os).


##### `build_probe_client`  (lines 65–78)

```
fn build_probe_client(
    builder: reqwest::ClientBuilder,
    proxy_url: Option<&str>,
) -> Result<reqwest::Client, String>
```

**Purpose**: Chooses the appropriate Codex client-construction helper based on whether the probe should route through an explicit HTTPS proxy.

**Data flow**: It takes a prepared `reqwest::ClientBuilder` and an optional proxy URL string slice. If a proxy URL is present, it converts that string into a `reqwest::Proxy::https` value, attaches it to the builder, and calls `codex_client::build_reqwest_client_with_custom_ca`; if proxy parsing fails, it returns a formatted `String` error. Without a proxy URL, it calls `codex_client::build_reqwest_client_for_subprocess_tests` and stringifies any transport-construction error.

**Call relations**: Invoked by `run_probe` after environment parsing. It is the branch point between the normal custom-CA builder path needed for explicit proxy tests and the special subprocess-test path used to avoid reqwest proxy autodetection side effects.

*Call graph*: called by 1 (run_probe); 4 external calls (proxy, build_reqwest_client_for_subprocess_tests, build_reqwest_client_with_custom_ca, https).


##### `post_probe_request`  (lines 80–100)

```
async fn post_probe_request(client: &reqwest::Client, url: &str) -> Result<(), String>
```

**Purpose**: Sends a fixed POST request through the constructed client and verifies both the HTTP status and exact response body expected by the integration tests.

**Data flow**: It receives a borrowed `reqwest::Client` and target URL string. It issues a POST with `Content-Type: application/x-www-form-urlencoded` and body `grant_type=authorization_code&code=test`, awaits the response, extracts the status, then reads the full body text. Network send failures, body-read failures, non-success statuses, and body text other than `ok` are each converted into descriptive `String` errors; otherwise it returns `Ok(())`.

**Call relations**: Called by `run_probe` only when `CODEX_CUSTOM_CA_PROBE_URL` is set. It is the terminal network step of the probe flow and does not delegate further beyond reqwest's request/response APIs.

*Call graph*: called by 1 (run_probe); 2 external calls (post, format!).


### Execution policy and exec-server tools
These binaries expose policy checking and remote execution helper processes, including test-only wrappers for alternate environments.

### `exec-server/src/fs_helper_main.rs`

`entrypoint` · `sandbox helper process startup and single-request execution`

This file is the tiny binary-style wrapper around the helper protocol defined in `fs_helper.rs`. `main` creates a single-threaded Tokio runtime with I/O and timer support, runs the async `run_main`, prints a human-readable error to stderr on startup or execution failure, and exits the process with status code 0 or 1. The helper is intentionally one-shot: it handles exactly one request and then terminates.

`run_main` performs the full request/response exchange over standard streams. It reads all bytes from stdin into a `Vec<u8>`, deserializes them as `FsHelperRequest`, executes the request with `run_direct_request`, wraps success as `FsHelperResponse::Ok` and helper-level failures as `FsHelperResponse::Error`, serializes the response to JSON text, writes it to stdout, appends a trailing newline, and returns. Because the helper protocol itself carries structured JSON-RPC errors, most operational failures become successful process exits with an `Error(...)` payload; only failures in runtime setup, stdin/stdout I/O, or JSON encoding/decoding cause `run_main` or `main` to fail and produce a nonzero exit code.

This separation is important for the sandbox runner: a nonzero process exit means the helper process itself malfunctioned, while a zero exit with `FsHelperResponse::Error` means the requested filesystem operation failed in a controlled, protocol-level way.

#### Function details

##### `main`  (lines 11–29)

```
fn main() -> !
```

**Purpose**: Starts a current-thread Tokio runtime, runs the helper request loop once, reports fatal failures to stderr, and exits the process with an OS status code.

**Data flow**: Builds a Tokio runtime → on success blocks on `run_main()`, mapping `Ok(())` to exit code 0 and `Err(err)` to stderr plus exit code 1; on runtime-build failure also prints to stderr and uses exit code 1 → calls `std::process::exit(exit_code)`.

**Call relations**: This is the helper binary entrypoint; it delegates all protocol work to `run_main`.

*Call graph*: calls 1 internal fn (run_main); 3 external calls (eprintln!, exit, new_current_thread).


##### `run_main`  (lines 31–45)

```
async fn run_main() -> Result<(), Box<dyn Error + Send + Sync>>
```

**Purpose**: Reads one helper request from stdin, executes it, and writes one serialized helper response to stdout.

**Data flow**: Allocates an input buffer, reads stdin to EOF, deserializes `FsHelperRequest` from the bytes, awaits `run_direct_request`, wraps the result as `FsHelperResponse::Ok` or `FsHelperResponse::Error`, serializes the response to JSON, writes it and a trailing newline to stdout, and returns `Result<(), Box<dyn Error + Send + Sync>>`.

**Call relations**: Called only by `main`; it is the one-shot protocol loop for the helper subprocess.

*Call graph*: calls 1 internal fn (run_direct_request); called by 1 (main); 7 external calls (new, Error, Ok, stdin, stdout, from_slice, to_string).


### `exec-server/src/server.rs`

`entrypoint` · `startup`

This file is intentionally small and organizational. It declares the internal server submodules (`file_system_handler`, `handler`, `process_handler`, `processor`, `registry`, `session_registry`, and `transport`) and re-exports the pieces that other parts of the crate or external callers need: `ExecServerHandler`, `ConnectionProcessor`, the default listen URL constant, and the listen-URL parse error type.

Its only executable logic is `run_main`, which is the server-facing startup function. Rather than embedding setup logic here, it accepts the already-parsed listen URL string and validated `ExecServerRuntimePaths`, then delegates directly to `transport::run_transport`. That keeps this file as the stable public façade while the actual listener creation, connection acceptance, and per-connection processing remain encapsulated in the transport submodule.

Because it sits at the module boundary, this file is active at startup and serves as the handoff point from CLI/application code into the server subsystem. The design choice is explicit separation: this file names the server’s pieces and exports them, but does not own the runtime behavior beyond forwarding the startup call.

#### Function details

##### `run_main`  (lines 16–21)

```
async fn run_main(
    listen_url: &str,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Starts the exec-server transport listener using the provided listen URL and runtime executable paths.

**Data flow**: Accepts `&str` `listen_url` and `ExecServerRuntimePaths` by value, forwards both to `transport::run_transport(listen_url, runtime_paths).await`, and returns that async result unchanged as `Result<(), Box<dyn std::error::Error + Send + Sync>>`.

**Call relations**: Called by higher-level application startup code when launching the exec server. It is a pure delegation layer into the transport module.

*Call graph*: calls 1 internal fn (run_transport).


### `exec-server/testing/windows_exec_server.rs`

`entrypoint` · `startup`

This tiny executable exists specifically for cross-platform test infrastructure. The module-level comment explains the motivation: building the full Codex binary for Windows is not yet supported in the Bazel graph, and linking only the exec-server makes Wine-based tests faster to iterate on. The file therefore provides a dedicated `#[tokio::main]` async entrypoint that does just enough setup to run the server.

At startup, `main` resolves the path of the current executable with `std::env::current_exe`. It then constructs `ExecServerRuntimePaths` from that executable path and explicitly passes `None` for the optional Linux sandbox binary. That omission is intentional and safe here because this fixture is always itself a Windows executable and will never invoke the separate Linux sandbox helper. Finally, it calls `codex_exec_server::run_main` with a fixed listen URL of `ws://127.0.0.1:0`, causing the server to bind an ephemeral localhost websocket port and print the chosen address for the test harness to consume.

There is no additional logic, argument parsing, or transport branching in this file; its value is in being a stable, lightweight binary target tailored to the needs of integration tests running under Windows or Wine.

#### Function details

##### `main`  (lines 11–18)

```
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Starts the lightweight Windows exec-server fixture on an ephemeral localhost websocket port. It prepares runtime paths from the current executable and delegates all real server work to the library entrypoint.

**Data flow**: Reads the current executable path with `std::env::current_exe()`, constructs `ExecServerRuntimePaths::new(current_exe, None)`, then awaits `codex_exec_server::run_main("ws://127.0.0.1:0", runtime_paths)`. It returns any startup or runtime error as `Box<dyn std::error::Error + Send + Sync>`.

**Call relations**: This is the binary entrypoint invoked by cross-platform tests. It delegates runtime-path validation to `ExecServerRuntimePaths::new` and server startup/orchestration to `codex_exec_server::run_main`.

*Call graph*: calls 1 internal fn (new); 2 external calls (run_main, current_exe).


### `exec-server/testing/wine_remote_test_runner.rs`

`entrypoint` · `test process startup and child test execution`

This file is an executable wrapper around another test binary. Its `main` function reads the path to that binary from `CODEX_WINE_EXEC_TEST_BINARY`, forwards any command-line arguments, and decides whether to run in a fast passthrough mode or in full remote-exec mode. The passthrough case is narrowly defined by `is_terse_list_request`: if the arguments are exactly `--list --format terse`, the wrapper invokes the test binary directly and returns its success status. That special case avoids booting Wine and the exec-server just to enumerate tests. For all other invocations, `main` creates a `WineExecServer` scope and receives the server's WebSocket URL. It then constructs a `tokio::process::Command` for the test binary, explicitly sets `CODEX_TEST_ENVIRONMENT=wine-exec` and `CODEX_TEST_REMOTE_EXEC_SERVER_URL=<url>`, removes older remote-environment variables (`CODEX_TEST_REMOTE_ENV` and `CODEX_TEST_REMOTE_ENV_CONTAINER_NAME`) to prevent conflicting configuration, forwards the original arguments, disconnects stdin, inherits stdout/stderr, and enables `kill_on_drop`. After awaiting process completion, it fails the wrapper if the child exits unsuccessfully. The result is a stable adapter that makes ordinary integration tests run against a Windows exec-server hosted under Wine without changing the tests themselves.

#### Function details

##### `main`  (lines 18–54)

```
async fn main() -> Result<()>
```

**Purpose**: Loads the target test binary path, optionally short-circuits terse test listing, otherwise starts a Wine exec-server and runs the target tests against it.

**Data flow**: Reads `CODEX_WINE_EXEC_TEST_BINARY` from the environment into a `PathBuf` and collects forwarded CLI arguments from `std::env::args_os()`. If the arguments match the terse-list pattern, it spawns the test binary directly and returns success only if the exit status is successful. Otherwise it enters `WineExecServer.scope`, receives the exec-server URL, builds a child command with remote-exec environment variables set and legacy ones removed, forwards args, inherits output streams, waits for completion, and returns `Ok(())` only on success.

**Call relations**: As the binary entrypoint, this function is invoked by the OS/test harness. It consults `is_terse_list_request` to decide whether to bypass Wine startup; in the normal path it delegates server lifecycle management to `WineExecServer::scope` and uses the resulting URL to configure the child test process.

*Call graph*: calls 1 internal fn (is_terse_list_request); 5 external calls (from, ensure!, new, args_os, var_os).


##### `is_terse_list_request`  (lines 56–62)

```
fn is_terse_list_request(args: &[OsString]) -> bool
```

**Purpose**: Recognizes the exact argument sequence used by Rust test binaries to request terse test enumeration.

**Data flow**: Takes a slice of `OsString`, converts each element to `&OsStr`, and compares the iterator against the fixed three-element sequence `--list`, `--format`, `terse`. It returns `true` only for that exact ordered argument list.

**Call relations**: This helper is called only from `main` during startup argument inspection. Its narrow equality check is what enables the wrapper to skip launching the Wine exec-server for test discovery requests.

*Call graph*: called by 1 (main); 2 external calls (new, iter).


### `execpolicy-legacy/src/main.rs`

`entrypoint` · `startup`

This binary parses CLI arguments with `clap`, loads either a user-specified policy file or the embedded default policy, evaluates one command, and emits a machine-readable JSON result. `Args` supports a `--require-safe` mode that changes exit-code behavior, an optional `--policy` path, and two subcommands: `check`, which treats trailing CLI tokens as an exec-style argv vector, and `check-json`, which accepts a JSON object containing `program` and `args`. `ExecArg` is the local deserializable representation of that command.

`main` initializes logging, parses CLI arguments, reads and parses the policy, and converts Starlark parser errors into `anyhow` errors. For `Command::Check`, it splits the provided vector into program and remaining args, exiting with code 1 if no command was supplied. It then calls `check_command`, serializes the returned `Output` enum with `serde_json`, prints it, and exits with the chosen status code. `check_command` is the policy-to-user contract: a successful `MatchedExec::Match` becomes either `Output::Safe` or `Output::Match` depending on `ValidExec::might_write_files()`, forbidden matches become `Output::Forbidden`, and policy-check errors become `Output::Unverified`. The three nonzero constants distinguish “matched but writes files,” “could not verify,” and “explicitly forbidden” when `--require-safe` is active; otherwise all policy outcomes still print JSON but exit 0.

#### Function details

##### `main`  (lines 62–95)

```
fn main() -> Result<()>
```

**Purpose**: Runs the CLI: initialize logging, parse arguments, load policy, decode the command to inspect, print JSON output, and terminate with the appropriate exit code.

**Data flow**: Reads process arguments via `Args::parse`, optional filesystem policy contents via `std::fs::read_to_string`, and default policy text via `get_default_policy`. It transforms those into a parsed `Policy`, then into an `ExecArg` from either raw trailing args or deserialized JSON. It passes the policy and command into `check_command`, serializes the returned `Output` to JSON, writes it to stdout, and exits the process with the returned code; if no command is provided for `check`, it writes an error to stderr and exits 1.

**Call relations**: This is the binary entrypoint. It delegates policy evaluation and exit-code classification to `check_command`, and policy construction either to `PolicyParser::new(...).parse()` for user files or `get_default_policy()` for the embedded rules.

*Call graph*: calls 3 internal fn (check_command, get_default_policy, new); 7 external calls (parse, init, eprintln!, println!, to_string, read_to_string, exit).


##### `check_command`  (lines 97–125)

```
fn check_command(
    policy: &Policy,
    ExecArg { program, args }: ExecArg,
    check: bool,
) -> (Output, i32)
```

**Purpose**: Converts a parsed command into an `ExecCall`, runs policy checking, and maps the result into the public JSON `Output` plus CLI exit code.

**Data flow**: Consumes `ExecArg { program, args }`, builds `ExecCall { program, args }`, and calls `policy.check(&exec_call)`. A successful `MatchedExec::Match` is further inspected with `exec.might_write_files()` to choose between `Output::Safe` and `Output::Match`; forbidden matches become `Output::Forbidden`; errors become `Output::Unverified`. The boolean `check` controls whether non-safe outcomes produce one of the predefined nonzero exit codes or still return 0.

**Call relations**: Invoked only by `main` after policy loading and command decoding. It is the central decision point translating library-level policy results into CLI-visible semantics.

*Call graph*: called by 1 (main); 1 external calls (check).


##### `deserialize_from_json`  (lines 153–161)

```
fn deserialize_from_json(deserializer: D) -> Result<ExecArg, D::Error>
```

**Purpose**: Implements custom serde deserialization for the `check-json` subcommand by parsing a JSON string into `ExecArg`.

**Data flow**: Reads a string from the incoming serde `Deserializer`, then feeds that string to `serde_json::from_str`. JSON parse failures are converted into the deserializer's error type with a `JSON parse error: ...` message; successful decoding returns the `ExecArg`.

**Call relations**: Used by serde on the `Command::CheckJson { exec }` field so clap/serde can accept a single string argument containing the JSON object.

*Call graph*: 2 external calls (deserialize, from_str).


##### `ExecArg::from_str`  (lines 166–168)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Allows `ExecArg` to be parsed directly from a JSON string using the standard `FromStr` trait.

**Data flow**: Takes an input `&str`, calls `serde_json::from_str`, and maps any serde error into `anyhow::Error`. It returns the decoded `ExecArg` on success.

**Call relations**: Supports string-based parsing of `ExecArg`; it complements `deserialize_from_json` for contexts that rely on `FromStr` rather than serde field customization.

*Call graph*: 1 external calls (from_str).


### `execpolicy/src/main.rs`

`entrypoint` · `startup`

This file is the executable front door for the crate. It declares a small `Cli` enum derived with `clap::Parser`, currently containing a single `Check` variant that wraps `ExecPolicyCheckCommand`. The enum-level `#[command(name = "codex-execpolicy")]` attribute fixes the program name shown in help and parsing diagnostics, while the variant doc comment becomes the subcommand description.

The `main` function is intentionally minimal. It asks Clap to parse process arguments into `Cli`, then pattern-matches on the resulting variant and forwards execution to the corresponding command object's `run` method. Because `main` returns `anyhow::Result<()>`, any error from subcommand execution propagates naturally to the runtime's standard error handling instead of being manually formatted here. This design keeps argument parsing and top-level dispatch in one place while leaving all substantive behavior to the subcommand modules. As additional subcommands are added, this file is the place where they would be wired into the binary's command tree.

#### Function details

##### `main`  (lines 13–18)

```
fn main() -> Result<()>
```

**Purpose**: Parses CLI arguments and dispatches to the selected subcommand implementation. In the current binary, that means forwarding `check` invocations to `ExecPolicyCheckCommand::run`.

**Data flow**: It takes no explicit arguments and returns `Result<()>`. It calls `Cli::parse()` to read process arguments into a `Cli` enum, matches on the parsed value, and for `Cli::Check(cmd)` returns the result of `cmd.run()`.

**Call relations**: This is the process entrypoint invoked by the runtime. It delegates argument interpretation to Clap's generated parser and hands off all real work to the subcommand object selected by the parsed CLI.

*Call graph*: 1 external calls (parse).


### `execpolicy/src/execpolicycheck.rs`

`orchestration` · `CLI request handling`

This module is the orchestration layer behind the command-line policy checker. `ExecPolicyCheckCommand` is a `clap::Parser` struct that defines the subcommand's inputs: one or more `--rules` paths, a `--pretty` toggle for JSON formatting, a `--resolve-host-executables` flag that enables basename matching against absolute paths when allowed by policy, and the trailing command tokens to evaluate. The implementation keeps parsing, evaluation, and rendering separate.

`run` is the top-level driver. It first calls `load_policies`, which creates a `PolicyParser`, reads each specified file from disk, parses each file using its path string as the policy identifier, and finally builds a combined `Policy`. `run` then evaluates the provided command tokens with `matches_for_command_with_options`, passing `None` for heuristic fallback and a `MatchOptions` value populated from the CLI flag. The resulting slice of `RuleMatch` values is handed to `format_matches_json`.

`format_matches_json` wraps the matches in a small serializable `ExecPolicyCheckOutput` struct. Besides the raw `matched_rules`, it computes an aggregate `decision` by taking the maximum over `RuleMatch::decision()` values; if there are no matches, the field is omitted entirely via `skip_serializing_if`. Depending on `pretty`, it chooses compact or pretty JSON serialization. The module therefore owns the full check-command flow from disk input to stdout output, while preserving contextual error messages for file read and parse failures using `anyhow::Context`.

#### Function details

##### `ExecPolicyCheckCommand::run`  (lines 43–57)

```
fn run(&self) -> Result<()>
```

**Purpose**: Executes the `check` subcommand end to end: load policies, evaluate the requested command, serialize the result, and print it. It is the main operational entry point for this module.

**Data flow**: It reads `self.rules`, `self.command`, `self.resolve_host_executables`, and `self.pretty`. It calls `load_policies(&self.rules)` to obtain a combined `Policy`, invokes `policy.matches_for_command_with_options(&self.command, None, &MatchOptions { resolve_host_executables: self.resolve_host_executables })` to compute `matched_rules`, passes those matches to `format_matches_json`, prints the resulting JSON string to stdout with `println!`, and returns `Ok(())` or propagates any `anyhow::Error`.

**Call relations**: This method is invoked by the CLI dispatch in `main` through the `Check` subcommand. It delegates policy-file loading to `load_policies` and output rendering to `format_matches_json`, acting as the coordinator between input parsing and final stdout emission.

*Call graph*: calls 2 internal fn (format_matches_json, load_policies); called by 1 (run_execpolicycheck); 1 external calls (println!).


##### `format_matches_json`  (lines 60–71)

```
fn format_matches_json(matched_rules: &[RuleMatch], pretty: bool) -> Result<String>
```

**Purpose**: Converts a slice of `RuleMatch` values into the JSON payload emitted by the CLI. It also computes the aggregate decision field from the matched rules.

**Data flow**: Inputs are `matched_rules: &[RuleMatch]` and `pretty: bool`. It constructs an `ExecPolicyCheckOutput` borrowing the slice and setting `decision` to `matched_rules.iter().map(RuleMatch::decision).max()`. It then serializes that struct with `serde_json::to_string_pretty` when `pretty` is true or `serde_json::to_string` otherwise, returning the JSON string or a serialization error converted into `anyhow::Result`.

**Call relations**: Called only from `ExecPolicyCheckCommand::run` after command evaluation. It does not perform matching itself; its role is to transform already computed rule matches into the stable CLI output format.

*Call graph*: called by 1 (run); 3 external calls (iter, to_string, to_string_pretty).


##### `load_policies`  (lines 73–86)

```
fn load_policies(policy_paths: &[PathBuf]) -> Result<Policy>
```

**Purpose**: Reads and parses all policy files specified on the command line into one combined `Policy`. It adds path-specific context to both I/O and parse failures.

**Data flow**: It takes `policy_paths: &[PathBuf]`, creates a mutable `PolicyParser`, then iterates over each path. For each file it reads the contents with `fs::read_to_string`, wraps read errors with `failed to read policy at ...`, converts the path to a string identifier, parses the contents with `parser.parse(&policy_identifier, &policy_file_contents)`, wraps parse errors with `failed to parse policy at ...`, and after the loop returns `parser.build()`.

**Call relations**: This helper is called by `ExecPolicyCheckCommand::run` before any command matching occurs. It encapsulates the multi-file load/parse phase so the top-level runner can treat policy acquisition as a single fallible step.

*Call graph*: calls 1 internal fn (new); called by 1 (run); 1 external calls (read_to_string).


### `state/src/bin/logs_client.rs`

`entrypoint` · `main loop`

This binary is a polling log-tail client built around `clap`, `StateRuntime`, and the state crate’s `LogQuery` API. `Args` defines filters for log level threshold, time range, module/file substrings, thread IDs, free-text search, inclusion of threadless rows, backfill count, poll interval, and compact formatting. `resolve_db_path` chooses either an explicit `--db` path or a logs DB under `--codex-home` / `$CODEX_HOME` / `~/.codex`, and `main` derives the runtime root from the DB’s parent directory before calling `StateRuntime::init`.

Filtering is normalized into `LogFilter`: timestamps are parsed from either Unix seconds or RFC3339 strings, empty repeated filter values are dropped, and `LogLevelThreshold::levels_upper` expands a threshold like `Warn` into the inclusive set `["WARN", "ERROR"]`. Query construction is centralized in `to_log_query`, which copies the filter fields and injects pagination controls (`limit`, `after_id`, `descending`).

At runtime, `main` first prints a backfill window in chronological order by fetching descending rows and reversing them. It tracks the highest seen row ID; if no backfill rows matched, it asks the runtime for the current max matching ID so tailing starts from “now” rather than replaying old rows later. The main loop then polls every `poll_ms`, fetches rows with IDs greater than `last_id`, prints each formatted row, and advances `last_id` monotonically.

Formatting is intentionally user-facing: timestamps are rendered compactly or as RFC3339, levels are colorized by severity, thread IDs and targets are dimmed, and messages containing `ToolCall: apply_patch` receive line-by-line diff coloring for `+` and `-` lines.

#### Function details

##### `LogLevelThreshold::levels_upper`  (lines 93–102)

```
fn levels_upper(self) -> Vec<String>
```

**Purpose**: Expands a minimum severity threshold into the set of uppercase log levels that should be included in queries. The returned list is inclusive of all more severe levels.

**Data flow**: It takes a `LogLevelThreshold` enum value, selects a static slice of uppercase level names based on the threshold, converts each to `String`, collects them into a `Vec<String>`, and returns it.

**Call relations**: This helper is used by `build_filter` when translating the CLI’s `--level` option into the `levels_upper` field consumed by `LogQuery`.


##### `main`  (lines 106–131)

```
async fn main() -> anyhow::Result<()>
```

**Purpose**: Parses CLI arguments, initializes the state runtime, prints an initial backfill, and then continuously polls for and prints new matching log rows. It is the binary’s top-level control loop.

**Data flow**: It parses `Args`, resolves the logs DB path with `resolve_db_path`, builds a normalized `LogFilter` with `build_filter`, derives `codex_home` from the DB path’s parent or `.` fallback, and awaits `StateRuntime::init`. It then calls `print_backfill` to emit recent rows and capture the highest seen ID; if no rows were printed, it calls `fetch_max_id` to anchor tailing at the current end of the matching stream. Finally it enters an infinite loop that sleeps for `poll_ms`, fetches rows newer than `last_id` via `fetch_new_rows`, prints each formatted row, and updates `last_id` to the maximum observed row ID.

**Call relations**: As the entrypoint, it orchestrates all helper functions in this file: path resolution, filter building, backfill retrieval, max-ID anchoring, incremental polling, and row formatting.

*Call graph*: calls 6 internal fn (build_filter, fetch_max_id, fetch_new_rows, print_backfill, resolve_db_path, init); 4 external calls (from_millis, parse, println!, sleep).


##### `resolve_db_path`  (lines 133–140)

```
fn resolve_db_path(args: &Args) -> anyhow::Result<PathBuf>
```

**Purpose**: Determines which SQLite logs database file the CLI should read. An explicit `--db` path wins over CODEX_HOME-based resolution.

**Data flow**: It takes parsed `Args`, returns a clone of `args.db` if present, otherwise chooses a CODEX_HOME from `args.codex_home` or `default_codex_home()` and passes that path to `codex_state::logs_db_path`, returning the resulting `PathBuf`.

**Call relations**: It is called early in `main` before runtime initialization so the binary knows both which DB to inspect and which parent directory to treat as CODEX_HOME.

*Call graph*: called by 1 (main); 1 external calls (logs_db_path).


##### `default_codex_home`  (lines 142–147)

```
fn default_codex_home() -> PathBuf
```

**Purpose**: Computes the fallback CODEX_HOME when neither `--db` nor `--codex-home` is supplied. It prefers the user’s home directory and falls back to a relative `.codex` path.

**Data flow**: It calls `dirs::home_dir()`, returns `home.join(".codex")` when available, or `PathBuf::from(".codex")` otherwise.

**Call relations**: This helper is used only by `resolve_db_path` when no explicit location was provided on the command line.

*Call graph*: 2 external calls (from, home_dir).


##### `build_filter`  (lines 149–195)

```
fn build_filter(args: &Args) -> anyhow::Result<LogFilter>
```

**Purpose**: Normalizes parsed CLI arguments into the internal `LogFilter` structure used to build `LogQuery` values. It performs timestamp parsing and removes empty repeated filter strings.

**Data flow**: It reads `args.from` and `args.to`, parses them through `parse_timestamp` with contextual error messages, expands `args.level` through `LogLevelThreshold::levels_upper`, filters empty strings out of `module`, `file`, and `thread_id`, clones the optional search string and threadless flag, and returns a populated `LogFilter`.

**Call relations**: Called by `main`, it prepares the reusable filter object later consumed by `print_backfill`, `fetch_new_rows`, and `fetch_max_id` through `to_log_query`.

*Call graph*: called by 1 (main).


##### `parse_timestamp`  (lines 197–205)

```
fn parse_timestamp(value: &str) -> anyhow::Result<i64>
```

**Purpose**: Parses a timestamp argument supplied either as Unix seconds or RFC3339 text. It gives a user-facing error message when RFC3339 parsing fails.

**Data flow**: It takes a `&str`, first attempts `value.parse::<i64>()` and returns that on success. If parsing as integer fails, it calls `DateTime::parse_from_rfc3339`, attaches context mentioning the original value, and returns the resulting Unix timestamp seconds.

**Call relations**: This helper is used by `build_filter` for both `--from` and `--to` arguments.

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

**Purpose**: Fetches and prints the initial batch of matching historical rows before tailing begins. It returns the highest row ID printed so the caller can continue from there.

**Data flow**: It takes the runtime, filter, backfill count, and compact flag. If `backfill == 0`, it returns `0` immediately. Otherwise it awaits `fetch_backfill`, reverses the descending result set into chronological order, iterates rows printing each via `format_row`, tracks the maximum `row.id`, and returns that max ID.

**Call relations**: Called by `main` during startup, it delegates the actual query to `fetch_backfill` and uses `format_row` for display.

*Call graph*: calls 1 internal fn (fetch_backfill); called by 1 (main); 1 external calls (println!).


##### `fetch_backfill`  (lines 228–243)

```
async fn fetch_backfill(
    runtime: &StateRuntime,
    filter: &LogFilter,
    backfill: usize,
) -> anyhow::Result<Vec<LogRow>>
```

**Purpose**: Queries the runtime for the most recent matching rows, ordered descending, for startup backfill. It wraps query failures with a backfill-specific context string.

**Data flow**: It builds a `LogQuery` by calling `to_log_query(filter, Some(backfill), None, true)`, awaits `runtime.query_logs(&query)`, and returns the resulting `Vec<LogRow>` or an error annotated as `failed to fetch backfill logs`.

**Call relations**: It is called only by `print_backfill`, which then reverses the descending rows for user-friendly output.

*Call graph*: calls 1 internal fn (to_log_query); called by 1 (print_backfill); 1 external calls (query_logs).


##### `fetch_new_rows`  (lines 245–260)

```
async fn fetch_new_rows(
    runtime: &StateRuntime,
    filter: &LogFilter,
    last_id: i64,
) -> anyhow::Result<Vec<LogRow>>
```

**Purpose**: Queries for rows newer than the last printed ID while preserving ascending order for tailing. It is the incremental polling query used in the main loop.

**Data flow**: It builds a `LogQuery` with no limit, `after_id = Some(last_id)`, and `descending = false`, awaits `runtime.query_logs(&query)`, and returns the matching `Vec<LogRow>` or an error annotated as `failed to fetch new logs`.

**Call relations**: This function is called repeatedly from `main` inside the infinite poll loop.

*Call graph*: calls 1 internal fn (to_log_query); called by 1 (main); 1 external calls (query_logs).


##### `fetch_max_id`  (lines 262–270)

```
async fn fetch_max_id(runtime: &StateRuntime, filter: &LogFilter) -> anyhow::Result<i64>
```

**Purpose**: Finds the current maximum matching log row ID without fetching all rows. It is used to anchor tailing when no backfill rows were printed.

**Data flow**: It builds a `LogQuery` from the filter with no limit and no `after_id`, asks `runtime.max_log_id(&query)`, and returns the resulting `i64` or an error annotated as `failed to fetch max log id`.

**Call relations**: Called by `main` only when `print_backfill` returned `0`, preventing later polling from replaying old matching rows.

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

**Purpose**: Converts the internal `LogFilter` plus pagination controls into the `codex_state::LogQuery` struct expected by the runtime. It centralizes field copying so all query paths stay consistent.

**Data flow**: It takes a `LogFilter`, optional `limit`, optional `after_id`, and a `descending` flag, clones the filter’s owned vectors and optional search string, copies scalar fields, inserts the pagination arguments, and returns a `LogQuery` value.

**Call relations**: All three query helpers—`fetch_backfill`, `fetch_new_rows`, and `fetch_max_id`—delegate query construction to this function.

*Call graph*: called by 3 (fetch_backfill, fetch_max_id, fetch_new_rows).


##### `format_row`  (lines 293–311)

```
fn format_row(row: &LogRow, compact: bool) -> String
```

**Purpose**: Renders one `LogRow` into the colored terminal string shown by the CLI. It supports both compact and full output layouts.

**Data flow**: It reads timestamp, level, target, optional message, and optional thread ID from the row; formats the timestamp with `formatter::ts`, colorizes the level with `formatter::level`, dims timestamp/target/thread ID, transforms the message through `heuristic_formatting`, and returns either `"time level message"` or `"time level [thread] target - message"` depending on `compact`.

**Call relations**: It is used by both `print_backfill` and the main polling loop in `main` to produce user-visible output.

*Call graph*: calls 1 internal fn (heuristic_formatting); 3 external calls (format!, level, ts).


##### `heuristic_formatting`  (lines 313–319)

```
fn heuristic_formatting(message: &str) -> String
```

**Purpose**: Applies special formatting to messages that look like `apply_patch` tool output and otherwise bolds the whole message. It is a lightweight content-aware presentation layer.

**Data flow**: It takes a message string, asks `matcher::apply_patch` whether it contains the identifying substring, and either delegates to `formatter::apply_patch` for line-by-line diff coloring or returns `message.bold().to_string()`.

**Call relations**: This helper is called only by `format_row` to decide how the message body should be styled.

*Call graph*: called by 1 (format_row); 2 external calls (apply_patch, apply_patch).


##### `matcher::apply_patch`  (lines 322–324)

```
fn apply_patch(message: &str) -> bool
```

**Purpose**: Detects whether a log message should be treated as `apply_patch` output for special formatting. The heuristic is a simple substring check.

**Data flow**: It takes `&str`, checks `message.contains("ToolCall: apply_patch")`, and returns the resulting boolean.

**Call relations**: It is used by `heuristic_formatting` as the gate for diff-style formatting.


##### `formatter::apply_patch`  (lines 333–347)

```
fn apply_patch(message: &str) -> String
```

**Purpose**: Formats an `apply_patch` log body with diff-like coloring, highlighting added and removed lines. Non-diff lines are still bolded for readability.

**Data flow**: It splits the message into lines, maps each line to a colored string—green bold for `+` prefix, red bold for `-` prefix, plain bold otherwise—collects the lines into a vector, joins them with newlines, and returns the final string.

**Call relations**: It is called by `heuristic_formatting` only when `matcher::apply_patch` identifies a patch-related message.


##### `formatter::ts`  (lines 349–356)

```
fn ts(ts: i64, ts_nanos: i64, compact: bool) -> String
```

**Purpose**: Formats a log timestamp either as compact wall-clock time or full RFC3339 with millisecond precision. It also provides a fallback string for invalid timestamps.

**Data flow**: It takes seconds, nanoseconds, and the compact flag, converts `ts_nanos` to `u32` with a forgiving `unwrap_or(0)`, attempts `DateTime::<Utc>::from_timestamp(ts, nanos)`, and returns `%H:%M:%S` for compact mode, RFC3339 millis otherwise, or a raw `"{ts}.{ts_nanos:09}Z"` fallback if the timestamp is invalid.

**Call relations**: This formatter is called by `format_row` for every displayed log row.

*Call graph*: 3 external calls (from_timestamp, format!, try_from).


##### `formatter::level`  (lines 358–376)

```
fn level(level: &str) -> String
```

**Purpose**: Formats and colorizes a log level string for terminal output. Known levels receive severity-specific colors and all outputs are padded to width five.

**Data flow**: It builds a left-padded `String` with `format!("{level:<5}")`, compares the input case-insensitively against known levels, and returns a colored bold string for error/warn/info/debug/trace or a plain bold padded string for unknown levels.

**Call relations**: It is called by `format_row` to render the level column consistently.

*Call graph*: 1 external calls (format!).


##### `tests::log_level_threshold_includes_more_severe_levels`  (lines 385–400)

```
fn log_level_threshold_includes_more_severe_levels()
```

**Purpose**: Verifies that threshold expansion includes the selected level and all more severe levels. It protects the semantics of `LogLevelThreshold::levels_upper`.

**Data flow**: The test calls `levels_upper()` on `Warn` and `Trace` and asserts the returned vectors exactly match the expected uppercase level lists.

**Call relations**: It directly validates the helper used by `build_filter` for level filtering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::log_level_rejects_aliases_and_unknown_values`  (lines 403–407)

```
fn log_level_rejects_aliases_and_unknown_values()
```

**Purpose**: Checks that clap parsing accepts only canonical level names and rejects aliases or comma-separated lists. This keeps the CLI contract strict and predictable.

**Data flow**: The test invokes `Args::try_parse_from` with invalid `--level` values such as `warning`, `err`, and `warn,error`, and asserts each parse attempt returns an error.

**Call relations**: It validates the `ValueEnum`-driven CLI parsing behavior that feeds into `build_filter`.

*Call graph*: 1 external calls (assert!).


##### `tests::log_level_accepts_canonical_values_case_insensitively`  (lines 410–415)

```
fn log_level_accepts_canonical_values_case_insensitively()
```

**Purpose**: Confirms that canonical log level names are parsed regardless of case. It verifies the `ignore_case = true` CLI configuration.

**Data flow**: The test parses `--level WARN` with `Args::try_parse_from`, unwraps the result, and asserts that `args.level` equals `Some(LogLevelThreshold::Warn)`.

**Call relations**: It checks the command-line parsing path that ultimately supplies `build_filter` with a `LogLevelThreshold`.

*Call graph*: 2 external calls (try_parse_from, assert_eq!).


### Linux sandbox and shell wrappers
This group covers Linux-oriented process isolation entrypoints, the bubblewrap wrapper, and the Unix execve interception helper.

### `linux-sandbox/src/lib.rs`

`orchestration` · `process startup entry dispatch`

This library root is intentionally thin. Its main job is to declare the Linux-specific submodules behind `#[cfg(target_os = "linux")]` and expose a single public `run_main()` function that the binary crate can call. The module list shows the subsystem split: bubblewrap argument construction, launcher selection, in-process seccomp/Landlock enforcement, proxy routing, and the main orchestration logic all live in separate files and are only compiled on Linux.

The exported `run_main` function has two platform-specific definitions. On Linux, it simply tail-calls `linux_run_main::run_main()`, making that file the real operational entrypoint while keeping the crate API stable. On non-Linux targets, the same symbol exists but immediately panics with a clear unsupported-platform message. That design lets downstream code link against a uniform crate interface while ensuring unsupported builds fail loudly rather than silently doing nothing.

Because this file contains almost no logic of its own, its importance is architectural: it is the boundary between the binary and the Linux sandbox subsystem, and it centralizes the compile-time gating that prevents Linux-only code from being referenced on other operating systems.

#### Function details

##### `run_main`  (lines 29–31)

```
fn run_main() -> !
```

**Purpose**: Provides the crate's public entrypoint and dispatches to the Linux implementation when available. On unsupported platforms it aborts immediately with a panic.

**Data flow**: Takes no arguments. Under `target_os = "linux"`, it calls `linux_run_main::run_main()` and never returns; under other targets, it panics with a fixed message. It does not maintain internal state.

**Call relations**: This function is invoked by the binary's `main`. It is a thin forwarding layer whose only role is to select the platform-appropriate behavior before handing control to the real runtime driver.

*Call graph*: calls 1 internal fn (run_main); 1 external calls (panic!).


### `linux-sandbox/src/linux_run_main.rs`

`entrypoint` · `startup through sandbox setup, child supervision, and final exec/exit`

This is the operational core of the helper. It defines the `LandlockCommand` CLI, parses flags, resolves a required `PermissionProfile` into runtime filesystem and network policies, and then chooses among three execution strategies: an inner post-bubblewrap stage (`--apply-seccomp-then-exec`), a direct in-process seccomp path when filesystem isolation is unnecessary, or the normal two-stage bubblewrap path. The normal path may prepare managed proxy routing, build an inner command that re-enters this same executable, preflight whether `--proc /proc` works, and then launch bubblewrap with fallback to `--no-proc` when mount failures are detected.

Beyond orchestration, the file contains the low-level process-control machinery needed around bubblewrap. It can either exec bubblewrap directly or fork a supervising parent when synthetic mount targets or protected-create targets require cleanup after the child exits. That supervised path blocks forwarded signals during setup, forks, places the child in its own process group, installs parent-death handling, optionally gates child exec on a pipe, forwards termination signals to the bubblewrap child/process group, waits for exit, and then removes synthetic files/directories or protected metadata paths while respecting concurrent registrations from other helper processes.

The synthetic/protected target registry is coordinated through per-path marker directories under a temp root keyed by effective uid and protected by `flock`. Marker contents distinguish truly synthetic ownership from pre-existing empty paths so cleanup does not delete real user files. A background `ProtectedCreateMonitor` optionally uses inotify to detect forbidden path creation during execution and aggressively removes those paths, turning a successful child exit into failure if policy was violated. The file also includes utility routines for argv rewriting (`--argv0` compatibility), proc-mount preflight stderr capture, wait-status propagation, and final `execvp` into the user command.

#### Function details

##### `run_main`  (lines 147–255)

```
fn run_main() -> !
```

**Purpose**: Parses CLI arguments, resolves effective permissions, selects the appropriate sandboxing pipeline, and ultimately execs the target command or bubblewrap. It is the real runtime entrypoint for the Linux helper.

**Data flow**: Reads `LandlockCommand::parse()` output, validates mode combinations, resolves `permission_profile` into `EffectivePermissions`, checks legacy-mode compatibility, and then branches. In inner-stage mode it may activate proxy routes, applies in-process restrictions without Landlock FS, and `exec_or_panic`s the user command. In direct-exec mode for full-write/no-proxy policies it applies restrictions and execs directly. Otherwise it either prepares proxy route spec and runs bubblewrap with proc fallback, or applies legacy Landlock FS restrictions and execs. It mutates process sandbox state, environment in proxy mode, and may replace the process image.

**Call relations**: Called from the crate-level `run_main`. It orchestrates nearly every helper in this file and delegates concrete enforcement to `apply_permission_profile_to_current_thread`, bubblewrap construction/execution helpers, and proxy-routing helpers depending on the parsed flags and resolved policy.

*Call graph*: calls 9 internal fn (apply_permission_profile_to_current_thread, build_inner_seccomp_command, ensure_inner_stage_mode_is_valid, ensure_legacy_landlock_mode_supports_policy, exec_or_panic, resolve_permission_profile, run_bwrap_with_proc_fallback, activate_proxy_routes_in_netns, prepare_host_proxy_route_spec); called by 1 (run_main); 2 external calls (parse, panic!).


##### `ResolvePermissionProfileError::fmt`  (lines 270–274)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats `ResolvePermissionProfileError` values into human-readable messages. The only current variant reports missing permission-profile configuration.

**Data flow**: Reads `self` and writes the corresponding string into the provided formatter `f`. Returns `fmt::Result` from the `write!` call and does not mutate external state.

**Call relations**: Used implicitly when `resolve_permission_profile(...).unwrap_or_else(|err| panic!("{err}"))` formats the error in `run_main`.

*Call graph*: 1 external calls (write!).


##### `parse_permission_profile`  (lines 277–279)

```
fn parse_permission_profile(value: &str) -> std::result::Result<PermissionProfile, String>
```

**Purpose**: Parses the `--permission-profile` CLI argument from JSON into a `PermissionProfile`. It converts serde parse failures into clap-friendly strings.

**Data flow**: Consumes `value: &str`, calls `serde_json::from_str`, maps any error into `format!("invalid permission profile JSON: {err}")`, and returns `Result<PermissionProfile, String>`. It is pure.

**Call relations**: Referenced by the clap parser on the `LandlockCommand.permission_profile` field, so it runs during CLI parsing before `run_main` begins policy orchestration.

*Call graph*: 1 external calls (from_str).


##### `resolve_permission_profile`  (lines 281–293)

```
fn resolve_permission_profile(
    permission_profile: Option<PermissionProfile>,
) -> Result<EffectivePermissions, ResolvePermissionProfileError>
```

**Purpose**: Turns an optional parsed permission profile into the concrete runtime policies the helper needs. It rejects missing configuration explicitly instead of defaulting silently.

**Data flow**: Takes `permission_profile: Option<PermissionProfile>`, returns `Err(MissingConfiguration)` if absent, otherwise derives `(file_system_sandbox_policy, network_sandbox_policy)` via `to_runtime_permissions()` and packages them with the original profile into `EffectivePermissions`.

**Call relations**: Called early in `run_main` after CLI parsing. Its output feeds both policy validation and the later choice between direct seccomp, bubblewrap, and legacy Landlock paths.

*Call graph*: called by 1 (run_main).


##### `ensure_inner_stage_mode_is_valid`  (lines 295–299)

```
fn ensure_inner_stage_mode_is_valid(apply_seccomp_then_exec: bool, use_legacy_landlock: bool)
```

**Purpose**: Rejects incompatible CLI mode combinations for the helper's two-stage execution model. Specifically, it forbids combining inner-stage seccomp application with legacy Landlock mode.

**Data flow**: Reads `apply_seccomp_then_exec` and `use_legacy_landlock`; if both are true it panics with a fixed message, otherwise returns `()`. No state is mutated.

**Call relations**: Called near the start of `run_main` before any sandbox setup. It prevents impossible control-flow combinations from reaching later code paths.

*Call graph*: called by 1 (run_main); 1 external calls (panic!).


##### `ensure_legacy_landlock_mode_supports_policy`  (lines 301–315)

```
fn ensure_legacy_landlock_mode_supports_policy(
    use_legacy_landlock: bool,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    sandbox_p
```

**Purpose**: Checks whether the requested permission profile requires direct runtime filesystem enforcement that the legacy Landlock path cannot provide. It fails fast when such a policy is paired with `--use-legacy-landlock`.

**Data flow**: Reads `use_legacy_landlock`, `file_system_sandbox_policy`, `network_sandbox_policy`, and `sandbox_policy_cwd`; if legacy mode is enabled and `needs_direct_runtime_enforcement(...)` returns true, it panics. Otherwise it returns `()`.

**Call relations**: Invoked by `run_main` immediately after resolving permissions. It guards the legacy branch before any attempt is made to apply unsupported filesystem semantics.

*Call graph*: calls 1 internal fn (needs_direct_runtime_enforcement); called by 1 (run_main); 1 external calls (panic!).


##### `run_bwrap_with_proc_fallback`  (lines 317–359)

```
fn run_bwrap_with_proc_fallback(
    sandbox_policy_cwd: &Path,
    command_cwd: Option<&Path>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPoli
```

**Purpose**: Builds the bubblewrap command, optionally probes whether `/proc` mounting works in the current environment, rewrites argv0 compatibility flags, and then launches bubblewrap. It encapsulates the normal outer-stage bubblewrap path.

**Data flow**: Consumes sandbox cwd, optional command cwd, filesystem and network policies, the inner command argv, a `mount_proc` preference, and the proxy flag. It computes `network_mode`, defaults `command_cwd` to `sandbox_policy_cwd`, optionally runs `preflight_proc_mount_support` and disables proc mounting on known failures, constructs `BwrapOptions`, builds argv via `build_bwrap_argv`, rewrites inner argv0 via `apply_inner_command_argv0`, and hands the result to `run_or_exec_bwrap`. On build/preflight errors it exits via `exit_with_bwrap_build_error`.

**Call relations**: Called from `run_main` only in the bubblewrap pipeline. It delegates policy-to-network translation, preflight probing, argv construction, and final execution to specialized helpers.

*Call graph*: calls 5 internal fn (apply_inner_command_argv0, build_bwrap_argv, bwrap_network_mode, preflight_proc_mount_support, run_or_exec_bwrap); called by 1 (run_main); 1 external calls (default).


##### `bwrap_network_mode`  (lines 361–372)

```
fn bwrap_network_mode(
    network_sandbox_policy: NetworkSandboxPolicy,
    allow_network_for_proxy: bool,
) -> BwrapNetworkMode
```

**Purpose**: Maps the resolved network policy and managed-proxy flag into the bubblewrap network namespace mode. Proxy-only mode takes precedence over nominal full network access.

**Data flow**: Reads `network_sandbox_policy` and `allow_network_for_proxy`; returns `ProxyOnly` if proxy mode is enabled, `FullAccess` if the policy is enabled, otherwise `Isolated`. It is pure.

**Call relations**: Used by `run_bwrap_with_proc_fallback` to choose the network-related bubblewrap flags before command construction.

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

**Purpose**: Constructs the full bubblewrap argv vector and carries through any preserved files and cleanup targets produced by the lower-level builder. It prepends the executable name expected by the launcher layer.

**Data flow**: Takes the inner command argv, filesystem policy, sandbox and command cwd, and `BwrapOptions`; calls `create_bwrap_command_args`, prepends `"bwrap"` to the returned args, and returns a new `crate::bwrap::BwrapArgs` containing args plus preserved files, synthetic mount targets, and protected create targets.

**Call relations**: Called by both `run_bwrap_with_proc_fallback` and `build_preflight_bwrap_argv`. It is the bridge between policy-aware bubblewrap argument generation and the launcher/supervision code in this file.

*Call graph*: calls 1 internal fn (create_bwrap_command_args); called by 2 (build_preflight_bwrap_argv, run_bwrap_with_proc_fallback); 1 external calls (vec!).


##### `exit_with_bwrap_build_error`  (lines 399–402)

```
fn exit_with_bwrap_build_error(err: codex_protocol::error::CodexErr) -> !
```

**Purpose**: Reports a bubblewrap command-construction failure to stderr and terminates the process with exit code 1. It is used instead of panicking so user-facing setup errors are cleaner.

**Data flow**: Consumes a `CodexErr`, prints `error building bubblewrap command: {err}` to stderr, and calls `std::process::exit(1)`. It never returns.

**Call relations**: Used as the error sink for `build_bwrap_argv` and proc-mount preflight failures inside `run_bwrap_with_proc_fallback`.

*Call graph*: 2 external calls (eprintln!, exit).


##### `apply_inner_command_argv0`  (lines 404–410)

```
fn apply_inner_command_argv0(argv: &mut Vec<String>)
```

**Purpose**: Adjusts the inner command portion of a bubblewrap argv so the re-entered helper has the desired argv0 semantics. It chooses between native `--argv0` support and a fallback command-path rewrite based on the selected launcher.

**Data flow**: Mutably borrows `argv: &mut Vec<String>`, queries `preferred_bwrap_supports_argv0()` and `current_process_argv0()`, and forwards all three values to `apply_inner_command_argv0_for_launcher`. It mutates the argv vector in place.

**Call relations**: Called by `run_bwrap_with_proc_fallback` after bubblewrap args are built but before execution. It delegates the actual splice/replace logic to the launcher-specific helper.

*Call graph*: calls 3 internal fn (preferred_bwrap_supports_argv0, apply_inner_command_argv0_for_launcher, current_process_argv0); called by 1 (run_bwrap_with_proc_fallback).


##### `apply_inner_command_argv0_for_launcher`  (lines 412–435)

```
fn apply_inner_command_argv0_for_launcher(
    argv: &mut Vec<String>,
    supports_argv0: bool,
    argv0_fallback_command: String,
)
```

**Purpose**: Performs the concrete argv mutation needed to preserve the helper's argv0 across bubblewrap versions. It either inserts `--argv0 codex-linux-sandbox` before `--` or rewrites the first post-`--` command path.

**Data flow**: Mutably reads and writes `argv`, scans for the command separator `"--"`, panics if missing, and then either splices `"--argv0", CODEX_LINUX_SANDBOX_ARG0` before the separator when `supports_argv0` is true, or replaces the command immediately after `--` with `argv0_fallback_command`, panicking if no command follows. Returns `()` after in-place mutation.

**Call relations**: Called only by `apply_inner_command_argv0`. Tests exercise both branches to ensure only the helper command is rewritten, not nested user commands later in argv.

*Call graph*: called by 1 (apply_inner_command_argv0); 1 external calls (panic!).


##### `current_process_argv0`  (lines 437–442)

```
fn current_process_argv0() -> String
```

**Purpose**: Retrieves the current process's argv[0] as a lossy UTF-8 `String`. It is used as the fallback helper command path when system bubblewrap lacks `--argv0` support.

**Data flow**: Reads `std::env::args_os().next()`, converts the first argument to an owned string with `to_string_lossy`, and panics if no argv0 is available. It does not mutate state.

**Call relations**: Called by `apply_inner_command_argv0` to supply the fallback replacement path for `apply_inner_command_argv0_for_launcher`.

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

**Purpose**: Runs a short-lived bubblewrap probe with `--proc /proc` and inspects stderr to determine whether proc mounting is supported in the current environment. It enables silent fallback to `--no-proc` in restrictive containers.

**Data flow**: Builds a preflight `BwrapArgs` via `build_preflight_bwrap_argv`, executes it with `run_bwrap_in_child_capture_stderr`, passes the captured stderr to `is_proc_mount_failure`, and returns `Ok(true)` when no known proc-mount failure is detected. It may fork and exec through delegated helpers.

**Call relations**: Called from `run_bwrap_with_proc_fallback` only when proc mounting is initially desired. It delegates command construction, child execution, and stderr classification to specialized helpers.

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

**Purpose**: Constructs the bubblewrap argv for the proc-mount preflight probe. The probe runs a trivial true command under the same filesystem/network setup but always requests `mount_proc: true`.

**Data flow**: Reads sandbox cwd, command cwd, filesystem policy, and network mode; resolves a trivial command via `resolve_true_command`; calls `build_bwrap_argv` with `BwrapOptions { mount_proc: true, network_mode, ..Default::default() }`; returns the resulting `BwrapArgs`.

**Call relations**: Used only by `preflight_proc_mount_support` to create the one-shot probe command whose stderr is later inspected.

*Call graph*: calls 1 internal fn (build_bwrap_argv); called by 1 (preflight_proc_mount_support); 2 external calls (default, vec!).


##### `resolve_true_command`  (lines 480–487)

```
fn resolve_true_command() -> String
```

**Purpose**: Chooses a minimal command for bubblewrap preflight probing. It prefers absolute paths to `true` when present and falls back to plain `true` otherwise.

**Data flow**: Checks `Path::new("/usr/bin/true").exists()` and then `/bin/true`, returning the first existing absolute path or the string `"true"`. It is pure.

**Call relations**: Called only by `build_preflight_bwrap_argv` so the proc-mount probe runs a harmless command with minimal dependencies.

*Call graph*: 1 external calls (new).


##### `run_or_exec_bwrap`  (lines 489–496)

```
fn run_or_exec_bwrap(bwrap_args: crate::bwrap::BwrapArgs) -> !
```

**Purpose**: Chooses whether bubblewrap can be exec'd directly or must be run under a supervising parent that performs post-exit cleanup. Direct exec is used only when no synthetic mount or protected-create bookkeeping is needed.

**Data flow**: Consumes `crate::bwrap::BwrapArgs`, checks whether `synthetic_mount_targets` and `protected_create_targets` are both empty, and either calls `exec_bwrap` directly or forwards the full struct to `run_bwrap_in_child_with_synthetic_mount_cleanup`. It never returns.

**Call relations**: Called by `run_bwrap_with_proc_fallback` after argv construction. It is the branch point between the simple launcher path and the more complex supervised cleanup path.

*Call graph*: calls 2 internal fn (exec_bwrap, run_bwrap_in_child_with_synthetic_mount_cleanup); called by 1 (run_bwrap_with_proc_fallback).


##### `run_bwrap_in_child_with_synthetic_mount_cleanup`  (lines 498–547)

```
fn run_bwrap_in_child_with_synthetic_mount_cleanup(bwrap_args: crate::bwrap::BwrapArgs) -> !
```

**Purpose**: Forks and supervises a bubblewrap child when filesystem cleanup or protected-create enforcement is required. It coordinates signal masking, child startup ordering, monitoring, cleanup, and final exit-status propagation.

**Data flow**: Consumes `BwrapArgs`, blocks forwarded signals, registers synthetic/protected targets, optionally creates an exec-start pipe, forks, and then diverges. In the child it resets handlers, restores the signal mask, creates a new process group, installs parent-death termination, waits for parent release if needed, and `exec_bwrap`s. In the parent it closes the child's read end, optionally starts `ProtectedCreateMonitor`, installs signal forwarders, releases the child, waits for exit, blocks signals again for cleanup, stops the monitor, cleans synthetic and protected targets, restores handlers/masks, and exits via `exit_with_wait_status_or_policy_violation`.

**Call relations**: Reached from `run_or_exec_bwrap` when cleanup targets exist. It orchestrates many helpers in this file: signal-mask/handler management, registry registration, child synchronization, monitoring, waiting, cleanup, and final exit handling.

*Call graph*: calls 16 internal fn (exec_bwrap, block, start, cleanup_protected_create_targets, cleanup_synthetic_mount_targets, close_child_exec_start_read, create_exec_start_pipe, exit_with_wait_status_or_policy_violation, install_bwrap_signal_forwarders, register_protected_create_targets (+6 more)); called by 1 (run_or_exec_bwrap); 5 external calls (last_os_error, fork, getpid, setpgid, panic!).


##### `ProtectedCreateMonitor::start`  (lines 550–581)

```
fn start(targets: &[crate::bwrap::ProtectedCreateTarget]) -> Option<Self>
```

**Purpose**: Starts a background monitor thread that repeatedly removes forbidden protected-create targets while the bubblewrap child runs and records whether any violation occurred. It optionally uses inotify to avoid pure busy-waiting.

**Data flow**: Reads `targets`, returns `None` immediately if empty, otherwise clones the targets into owned storage, creates shared `Arc<AtomicBool>` stop/violation flags, spawns a thread that constructs an optional `ProtectedCreateWatcher`, loops until `stop` is set, tries `remove_protected_create_target_best_effort` on each target and sets `violation` if anything was removed, then either waits for inotify events or sleeps 1 ms. Returns `Some(ProtectedCreateMonitor { stop, violation, handle })`.

**Call relations**: Called by `run_bwrap_in_child_with_synthetic_mount_cleanup` only when protected-create targets exist. Its paired `stop` method is used during cleanup to join the thread and retrieve the violation flag.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 6 external calls (clone, new, new, is_empty, to_vec, spawn).


##### `ProtectedCreateMonitor::stop`  (lines 583–589)

```
fn stop(self) -> bool
```

**Purpose**: Stops the monitor thread, waits for it to finish, and returns whether any protected-create violation was observed. It turns the monitor's shared state into a final boolean result.

**Data flow**: Consumes `self`, stores `true` into the `stop` atomic, joins the thread handle and panics if the thread panicked, then loads and returns the `violation` atomic. It mutates only the monitor's shared stop flag.

**Call relations**: Called during parent-side cleanup in `run_bwrap_in_child_with_synthetic_mount_cleanup` after the bubblewrap child exits.

*Call graph*: 1 external calls (join).


##### `ProtectedCreateWatcher::new`  (lines 593–631)

```
fn new(targets: &[crate::bwrap::ProtectedCreateTarget]) -> Option<Self>
```

**Purpose**: Creates an inotify watcher over the parent directories of protected-create targets so the monitor thread can wake promptly on creation events. It deduplicates parent directories and gracefully falls back to polling when setup fails.

**Data flow**: Reads `targets`, calls `inotify_init1(IN_NONBLOCK | IN_CLOEXEC)`, iterates targets to collect unique parent directories, converts each parent path to `CString`, adds watches for create/move/delete-self events, closes the inotify fd and returns `None` if no watches were installed, otherwise returns `Some(ProtectedCreateWatcher { fd, _watches })`.

**Call relations**: Constructed inside `ProtectedCreateMonitor::start`. If it returns `None`, the monitor thread falls back to sleeping between best-effort removal scans.

*Call graph*: 6 external calls (new, new, new, close, inotify_add_watch, inotify_init1).


##### `ProtectedCreateWatcher::wait_for_create_event`  (lines 633–654)

```
fn wait_for_create_event(&self, stop: &AtomicBool)
```

**Purpose**: Waits briefly for inotify readability or stop requests, then drains any queued events. It is designed to reduce CPU usage without blocking monitor shutdown for long.

**Data flow**: Reads `self.fd` and `stop`, initializes a `pollfd`, loops while `stop` is false, calls `poll(..., timeout=10ms)`, drains events and returns on positive readiness, returns on timeout, retries on interrupted syscalls, and otherwise returns silently on errors. It does not mutate external state.

**Call relations**: Called by the monitor thread created in `ProtectedCreateMonitor::start` when an inotify watcher exists. It delegates actual event consumption to `drain_events`.

*Call graph*: calls 1 internal fn (drain_events); 3 external calls (load, last_os_error, poll).


##### `ProtectedCreateWatcher::drain_events`  (lines 656–672)

```
fn drain_events(&self)
```

**Purpose**: Consumes all currently queued inotify events from the watcher fd. It ignores event contents because the monitor only needs a wakeup signal to rescan targets.

**Data flow**: Allocates a fixed 4096-byte buffer, repeatedly calls `libc::read(self.fd, ...)`, continues while bytes are read, returns on EOF or non-interrupted errors, and retries on `Interrupted`. It mutates only the kernel read position on the fd.

**Call relations**: Used only by `ProtectedCreateWatcher::wait_for_create_event` after poll indicates readability.

*Call graph*: called by 1 (wait_for_create_event); 2 external calls (last_os_error, read).


##### `ProtectedCreateWatcher::drop`  (lines 676–680)

```
fn drop(&mut self)
```

**Purpose**: Closes the inotify file descriptor when the watcher is dropped. It ensures the monitor's kernel resources are released even on early exits.

**Data flow**: Uses `libc::close(self.fd)` in `Drop` and ignores the return value. It mutates kernel fd state by closing the descriptor.

**Call relations**: Runs automatically when the optional watcher owned by the monitor thread goes out of scope.

*Call graph*: 1 external calls (close).


##### `create_exec_start_pipe`  (lines 683–693)

```
fn create_exec_start_pipe(enabled: bool) -> [libc::c_int; 2]
```

**Purpose**: Creates a close-on-exec pipe used to delay child exec until the parent has installed monitoring and signal forwarding. It is only enabled when protected-create monitoring requires tighter startup ordering.

**Data flow**: Reads `enabled`; if false returns `[-1, -1]`. Otherwise allocates a two-element fd array, calls `pipe2(..., O_CLOEXEC)`, panics on failure, and returns the read/write fds.

**Call relations**: Called by `run_bwrap_in_child_with_synthetic_mount_cleanup` before forking. The resulting fds are consumed by `wait_for_parent_exec_start`, `close_child_exec_start_read`, and `release_child_exec_start`.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (last_os_error, pipe2, panic!).


##### `wait_for_parent_exec_start`  (lines 695–719)

```
fn wait_for_parent_exec_start(read_fd: libc::c_int, write_fd: libc::c_int)
```

**Purpose**: Blocks the child until the parent signals that setup is complete, then closes the synchronization pipe. This prevents the child from execing bubblewrap before monitoring and signal forwarding are ready.

**Data flow**: Consumes `read_fd` and `write_fd`, closes `write_fd` if valid, returns immediately if `read_fd < 0`, otherwise loops reading one byte until success or a non-interrupted error, then closes `read_fd`. It mutates fd state by closing descriptors.

**Call relations**: Called only in the child branch of `run_bwrap_in_child_with_synthetic_mount_cleanup` when exec-start synchronization is enabled.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (last_os_error, close, read).


##### `close_child_exec_start_read`  (lines 721–727)

```
fn close_child_exec_start_read(read_fd: libc::c_int)
```

**Purpose**: Closes the parent's copy of the child's exec-start read end. It is a small helper to keep the parent-side startup sequence explicit.

**Data flow**: Reads `read_fd`; if it is nonnegative, closes it with `libc::close`. Returns `()`.

**Call relations**: Used by the parent branch of `run_bwrap_in_child_with_synthetic_mount_cleanup` immediately after forking.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 1 external calls (close).


##### `release_child_exec_start`  (lines 729–738)

```
fn release_child_exec_start(write_fd: libc::c_int)
```

**Purpose**: Signals the child that parent setup is complete and closes the write end of the exec-start pipe. It is the parent-side counterpart to `wait_for_parent_exec_start`.

**Data flow**: Reads `write_fd`; if negative it returns. Otherwise it writes one byte to the fd and closes it. It mutates kernel pipe state.

**Call relations**: Called by the parent branch of `run_bwrap_in_child_with_synthetic_mount_cleanup` after monitors and signal forwarders are installed.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 2 external calls (close, write).


##### `ForwardedSignalMask::block`  (lines 749–763)

```
fn block() -> Self
```

**Purpose**: Temporarily blocks the set of signals that should be forwarded to the bubblewrap child during sensitive setup/cleanup windows. It captures the previous signal mask for later restoration.

**Data flow**: Builds a `sigset_t` containing `FORWARDED_SIGNALS`, calls `sigprocmask(SIG_BLOCK, ...)`, panics on failure, and returns `ForwardedSignalMask { previous }` holding the old mask. It mutates the calling thread's signal mask.

**Call relations**: Used around both supervised bubblewrap execution and stderr-capture preflight runs so signal forwarding state can be installed or torn down without races.

*Call graph*: called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup); 6 external calls (last_os_error, sigaddset, sigemptyset, sigprocmask, panic!, zeroed).


##### `ForwardedSignalMask::restore`  (lines 765–776)

```
fn restore(&self)
```

**Purpose**: Restores the previously saved signal mask while ensuring the forwarded signals are not left spuriously blocked. It undoes `ForwardedSignalMask::block`.

**Data flow**: Copies `self.previous` into a mutable local, removes each forwarded signal from that set with `sigdelset`, then calls `sigprocmask(SIG_SETMASK, ...)`, panicking on failure. It mutates the calling thread's signal mask.

**Call relations**: Called after setup and after cleanup in the parent, and in child branches before exec, to return signal delivery to normal.

*Call graph*: 5 external calls (last_os_error, sigdelset, sigprocmask, panic!, null_mut).


##### `terminate_with_parent`  (lines 779–790)

```
fn terminate_with_parent(parent_pid: libc::pid_t)
```

**Purpose**: Configures the child to receive `SIGTERM` if its parent dies and immediately self-terminates if the original parent has already disappeared. This prevents orphaned bubblewrap children.

**Data flow**: Calls `prctl(PR_SET_PDEATHSIG, SIGTERM)`, panics on failure, then compares `getppid()` to the expected `parent_pid`; if they differ it raises `SIGTERM` in the child. It mutates child process death-signal state.

**Call relations**: Called only in the child branch of `run_bwrap_in_child_with_synthetic_mount_cleanup` after `setpgid` and before waiting for parent release.

*Call graph*: called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 5 external calls (last_os_error, getppid, prctl, raise, panic!).


##### `ForwardedSignalHandlers::restore`  (lines 793–804)

```
fn restore(self)
```

**Purpose**: Restores the process's previous handlers for all forwarded signals and clears the global child/signal tracking atomics. It undoes `install_bwrap_signal_forwarders`.

**Data flow**: Consumes `self`, stores 0 into `BWRAP_CHILD_PID` and `PENDING_FORWARDED_SIGNAL`, iterates saved `(signal, sigaction)` pairs, and reinstalls each previous action with `sigaction`, panicking on failure. It mutates process signal-handler state and global atomics.

**Call relations**: Called during cleanup after waiting for the bubblewrap child in both the supervised and stderr-capture paths.

*Call graph*: 4 external calls (last_os_error, sigaction, panic!, null_mut).


##### `install_bwrap_signal_forwarders`  (lines 807–825)

```
fn install_bwrap_signal_forwarders(pid: libc::pid_t) -> ForwardedSignalHandlers
```

**Purpose**: Installs handlers for selected termination signals that forward those signals to the bubblewrap child and its process group. It also replays any signal that arrived while setup was still in progress.

**Data flow**: Stores `pid` into `BWRAP_CHILD_PID`, allocates a vector for previous handlers, installs `forward_signal_to_bwrap_child` as the handler for each signal in `FORWARDED_SIGNALS` while saving the old action, panics on failure, calls `replay_pending_forwarded_signal(pid)`, and returns `ForwardedSignalHandlers { previous }`.

**Call relations**: Used by both bubblewrap child-supervision paths and by the signal-forwarder test supervisor. It pairs with `ForwardedSignalHandlers::restore` and relies on `forward_signal_to_bwrap_child`/`send_signal_to_bwrap_child` for actual delivery.

*Call graph*: calls 1 internal fn (replay_pending_forwarded_signal); called by 3 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup, run_bwrap_signal_forwarder_test_supervisor); 6 external calls (with_capacity, last_os_error, sigaction, sigemptyset, panic!, zeroed).


##### `forward_signal_to_bwrap_child`  (lines 827–833)

```
fn forward_signal_to_bwrap_child(signal: libc::c_int)
```

**Purpose**: Signal-handler entrypoint that records the most recent forwarded signal and immediately sends it to the tracked bubblewrap child if one is registered. It is async-signal-safe in structure by using atomics and `kill`.

**Data flow**: Stores `signal` into `PENDING_FORWARDED_SIGNAL`, loads `BWRAP_CHILD_PID`, and if positive calls `send_signal_to_bwrap_child(pid, signal)`. It mutates global atomics and sends signals.

**Call relations**: Installed by `install_bwrap_signal_forwarders` as the handler for forwarded signals. `replay_pending_forwarded_signal` handles the race where a signal arrived before the child pid was fully installed.

*Call graph*: calls 1 internal fn (send_signal_to_bwrap_child).


##### `replay_pending_forwarded_signal`  (lines 835–840)

```
fn replay_pending_forwarded_signal(pid: libc::pid_t)
```

**Purpose**: Delivers any signal that was recorded before the child pid was ready for immediate forwarding. It closes the setup race between handler installation and child registration.

**Data flow**: Atomically swaps `PENDING_FORWARDED_SIGNAL` to 0, and if the retrieved signal is positive, calls `send_signal_to_bwrap_child(pid, signal)`. It mutates the pending-signal atomic and sends signals.

**Call relations**: Called at the end of `install_bwrap_signal_forwarders` after handlers are installed and the child pid is known.

*Call graph*: calls 1 internal fn (send_signal_to_bwrap_child); called by 1 (install_bwrap_signal_forwarders).


##### `send_signal_to_bwrap_child`  (lines 842–847)

```
fn send_signal_to_bwrap_child(pid: libc::pid_t, signal: libc::c_int)
```

**Purpose**: Sends a signal both to the bubblewrap child's process group and to the child pid itself. This covers cases where descendants or the leader need explicit delivery.

**Data flow**: Calls `kill(-pid, signal)` and `kill(pid, signal)` and ignores return values. It mutates kernel signal state by delivering signals.

**Call relations**: Used by both the signal handler and the replay helper as the concrete forwarding primitive.

*Call graph*: called by 2 (forward_signal_to_bwrap_child, replay_pending_forwarded_signal); 1 external calls (kill).


##### `reset_forwarded_signal_handlers_to_default`  (lines 849–858)

```
fn reset_forwarded_signal_handlers_to_default()
```

**Purpose**: Restores default dispositions for the forwarded signals in a freshly forked child before exec. This prevents the child from inheriting the parent's forwarding handlers.

**Data flow**: Iterates `FORWARDED_SIGNALS`, calls `libc::signal(*signal, SIG_DFL)`, and panics if any reset fails. It mutates process signal-handler state in the child.

**Call relations**: Called in child branches before `exec_bwrap` in both supervised execution and stderr-capture preflight.

*Call graph*: called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (last_os_error, signal, panic!).


##### `wait_for_bwrap_child`  (lines 860–873)

```
fn wait_for_bwrap_child(pid: libc::pid_t) -> libc::c_int
```

**Purpose**: Waits synchronously for a specific child process to exit, retrying on `EINTR`. It returns the raw wait status for later interpretation.

**Data flow**: Loops calling `waitpid(pid, &mut status, 0)`, returns `status` on success, retries on `EINTR`, and panics on other errors. It mutates only local wait status storage.

**Call relations**: Used by both bubblewrap execution paths and by tests that fork helper children. Its raw status feeds `exit_with_wait_status` and policy-violation handling.

*Call graph*: called by 4 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup, bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive, run_bwrap_signal_forwarder_test_supervisor); 3 external calls (last_os_error, waitpid, panic!).


##### `register_synthetic_mount_targets`  (lines 875–922)

```
fn register_synthetic_mount_targets(
    targets: &[crate::bwrap::SyntheticMountTarget],
) -> Vec<SyntheticMountTargetRegistration>
```

**Purpose**: Registers synthetic mount targets in a shared on-disk registry so cleanup can coordinate across concurrent helper processes. It also downgrades ownership semantics when another active synthetic owner already exists.

**Data flow**: Under `with_synthetic_mount_registry_lock`, iterates `targets`, computes a marker directory from the target path hash, creates it, checks whether a pre-existing-path-preserving target conflicts with an active synthetic owner, possibly rewrites the target to a missing variant, writes a per-process marker file containing synthetic/existing marker bytes, and returns `Vec<SyntheticMountTargetRegistration>` with target and marker paths.

**Call relations**: Called before forking in both bubblewrap execution paths whenever synthetic mount targets are present. The returned registrations are later consumed by `cleanup_synthetic_mount_targets`.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `register_protected_create_targets`  (lines 924–953)

```
fn register_protected_create_targets(
    targets: &[crate::bwrap::ProtectedCreateTarget],
) -> Vec<ProtectedCreateTargetRegistration>
```

**Purpose**: Registers protected-create targets in the same shared registry mechanism used for synthetic mounts. Marker files indicate that a path should not be allowed to appear during the sandboxed run.

**Data flow**: Under `with_synthetic_mount_registry_lock`, iterates `targets`, creates each marker directory, writes a per-process marker file containing `PROTECTED_CREATE_MARKER`, and returns `Vec<ProtectedCreateTargetRegistration>` with cloned targets and marker paths.

**Call relations**: Called before forking in both bubblewrap execution paths when protected-create targets exist. The registrations are later passed to `cleanup_protected_create_targets`.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `synthetic_mount_marker_contents`  (lines 955–961)

```
fn synthetic_mount_marker_contents(target: &crate::bwrap::SyntheticMountTarget) -> &'static [u8]
```

**Purpose**: Chooses the marker-file payload that records whether a synthetic mount target represents a truly synthetic path or a preserved pre-existing path. This distinction drives safe cleanup behavior.

**Data flow**: Reads `target.preserves_pre_existing_path()` and returns either `SYNTHETIC_MOUNT_MARKER_EXISTING` or `SYNTHETIC_MOUNT_MARKER_SYNTHETIC`. It is pure.

**Call relations**: Used during `register_synthetic_mount_targets` when writing marker files for later concurrent-owner checks.

*Call graph*: calls 1 internal fn (preserves_pre_existing_path).


##### `synthetic_mount_marker_dir_has_active_synthetic_owner`  (lines 963–974)

```
fn synthetic_mount_marker_dir_has_active_synthetic_owner(marker_dir: &Path) -> bool
```

**Purpose**: Checks whether a marker directory contains any active process marker specifically claiming synthetic ownership. It ignores active markers for preserved pre-existing paths.

**Data flow**: Calls `synthetic_mount_marker_dir_has_active_process_matching` with a predicate that reads each marker file and returns true only when its contents equal `SYNTHETIC_MOUNT_MARKER_SYNTHETIC`, treating missing files as non-matches and panicking on other read errors.

**Call relations**: Used by `register_synthetic_mount_targets` to decide whether a new registration for a pre-existing empty path should be treated as synthetic-missing instead, avoiding accidental preservation of transient artifacts.

*Call graph*: calls 1 internal fn (synthetic_mount_marker_dir_has_active_process_matching).


##### `synthetic_mount_marker_dir_has_active_process`  (lines 976–978)

```
fn synthetic_mount_marker_dir_has_active_process(marker_dir: &Path) -> bool
```

**Purpose**: Checks whether any active process still has a registration in a marker directory, regardless of marker contents. It is the generic liveness test for cleanup coordination.

**Data flow**: Delegates to `synthetic_mount_marker_dir_has_active_process_matching` with a predicate that always returns true. Returns a boolean and does not mutate state except for stale-marker cleanup performed by the delegate.

**Call relations**: Used during cleanup of both synthetic mount and protected-create targets to decide whether another active owner still exists.

*Call graph*: calls 1 internal fn (synthetic_mount_marker_dir_has_active_process_matching).


##### `synthetic_mount_marker_dir_has_active_process_matching`  (lines 980–1024)

```
fn synthetic_mount_marker_dir_has_active_process_matching(
    marker_dir: &Path,
    matches_marker: impl Fn(&Path) -> bool,
) -> bool
```

**Purpose**: Scans a marker directory, removes stale pid marker files for dead processes, and reports whether any active marker satisfies a caller-provided predicate. It is the shared registry-liveness primitive.

**Data flow**: Reads `marker_dir`, attempts `fs::read_dir`, returns false on `NotFound`, panics on other directory-read errors, iterates entries, parses each filename as a `pid_t`, checks `process_is_active(pid)`, removes stale marker files for dead processes, applies `matches_marker(&path)` to active markers, and returns true on the first match or false otherwise.

**Call relations**: Called by both active-process query helpers. Its stale-marker cleanup is important because later cleanup decisions depend on accurate concurrent-owner state.

*Call graph*: calls 1 internal fn (process_is_active); called by 2 (synthetic_mount_marker_dir_has_active_process, synthetic_mount_marker_dir_has_active_synthetic_owner); 3 external calls (read_dir, remove_file, panic!).


##### `cleanup_synthetic_mount_targets`  (lines 1026–1055)

```
fn cleanup_synthetic_mount_targets(targets: &[SyntheticMountTargetRegistration])
```

**Purpose**: Unregisters synthetic mount targets and removes the underlying synthetic files/directories only when no other active registration remains. Cleanup runs in reverse registration order.

**Data flow**: Under `with_synthetic_mount_registry_lock`, iterates registrations in reverse to remove marker files, ignoring missing markers, then iterates again in reverse: if the marker dir still has an active process it skips removal; otherwise it calls `remove_synthetic_mount_target` and attempts to remove the marker directory, tolerating missing or non-empty directories. It returns `()` after mutating filesystem state.

**Call relations**: Called after bubblewrap child exit in both execution paths. It consumes the registrations produced by `register_synthetic_mount_targets` and relies on active-process checks to avoid deleting paths still owned by concurrent helpers.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `cleanup_protected_create_targets`  (lines 1057–1091)

```
fn cleanup_protected_create_targets(targets: &[ProtectedCreateTargetRegistration]) -> bool
```

**Purpose**: Unregisters protected-create targets, removes any forbidden paths that were created, and reports whether a policy violation occurred. It respects concurrent registrations similarly to synthetic mount cleanup.

**Data flow**: Under `with_synthetic_mount_registry_lock`, removes marker files in reverse order, then for each registration checks whether another active process still owns the marker dir. If so, it marks a violation when the target path currently exists and leaves removal to the remaining owner; otherwise it calls `remove_protected_create_target`, ORs its boolean result into `violation`, and tries to remove the marker directory. Returns the final `bool` violation flag.

**Call relations**: Called after bubblewrap child exit in both execution paths, and its result feeds `exit_with_wait_status_or_policy_violation` in the supervised path.

*Call graph*: calls 1 internal fn (with_synthetic_mount_registry_lock); called by 2 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup).


##### `remove_protected_create_target`  (lines 1093–1109)

```
fn remove_protected_create_target(target: &crate::bwrap::ProtectedCreateTarget) -> bool
```

**Purpose**: Reliably removes a protected-create target, retrying briefly when directory removal races with concurrent writes. It returns whether anything was actually removed.

**Data flow**: Loops up to 100 attempts calling `try_remove_protected_create_target(target)`. On `Ok(removal)` it returns `removal.is_some()`. On `DirectoryNotEmpty` before the last attempt it sleeps 1 ms and retries; on any other error it panics. It mutates filesystem state by deleting the target path when possible.

**Call relations**: Used by `cleanup_protected_create_targets` for final authoritative cleanup after the child exits.

*Call graph*: calls 1 internal fn (try_remove_protected_create_target); 4 external calls (from_millis, panic!, sleep, unreachable!).


##### `remove_protected_create_target_best_effort`  (lines 1111–1124)

```
fn remove_protected_create_target_best_effort(
    target: &crate::bwrap::ProtectedCreateTarget,
) -> Option<ProtectedCreateRemoval>
```

**Purpose**: Attempts to remove a protected-create target during execution without panicking on errors. It is designed for the background monitor thread, where any failure should still count as a violation.

**Data flow**: Loops up to 100 attempts calling `try_remove_protected_create_target`. Returns the `Option<ProtectedCreateRemoval>` on success, retries on `DirectoryNotEmpty` with 1 ms sleeps, and returns `Some(Other)` on any other error or after exhausting retries. It may delete filesystem paths.

**Call relations**: Called repeatedly by the monitor thread in `ProtectedCreateMonitor::start` to enforce protected-create policy while the child is still running.

*Call graph*: calls 1 internal fn (try_remove_protected_create_target); 2 external calls (from_millis, sleep).


##### `try_remove_protected_create_target`  (lines 1126–1156)

```
fn try_remove_protected_create_target(
    target: &crate::bwrap::ProtectedCreateTarget,
) -> std::io::Result<Option<ProtectedCreateRemoval>>
```

**Purpose**: Performs one removal attempt for a protected-create target and reports what kind of object was removed. It also emits a user-visible stderr message when a forbidden path was successfully deleted.

**Data flow**: Reads `target.path()`, calls `fs::symlink_metadata`; returns `Ok(None)` on `NotFound`, otherwise classifies the target as `Directory` or `Other`, removes it with `remove_dir_all` or `remove_file`, treats `NotFound` during removal as `Ok(None)`, prints `sandbox blocked creation of protected workspace metadata path ...` on successful deletion, and returns `Ok(Some(removal))`.

**Call relations**: This is the shared worker behind both authoritative and best-effort protected-create removal helpers.

*Call graph*: calls 1 internal fn (path); called by 2 (remove_protected_create_target, remove_protected_create_target_best_effort); 4 external calls (eprintln!, remove_dir_all, remove_file, symlink_metadata).


##### `remove_synthetic_mount_target`  (lines 1158–1190)

```
fn remove_synthetic_mount_target(target: &crate::bwrap::SyntheticMountTarget)
```

**Purpose**: Deletes a synthetic mount target after bubblewrap exits, but only when the target's metadata still matches the conditions under which cleanup is safe. It avoids deleting real user content that may have appeared at the same path.

**Data flow**: Reads `target.path()`, obtains metadata with `symlink_metadata`, returns early on `NotFound`, panics on other stat errors, checks `target.should_remove_after_bwrap(&metadata)`, and if true removes either the file or directory according to `target.kind()`, tolerating missing paths and non-empty directories where appropriate.

**Call relations**: Called from `cleanup_synthetic_mount_targets` only after registry coordination determines no other active owner remains.

*Call graph*: calls 3 internal fn (kind, path, should_remove_after_bwrap); 4 external calls (remove_dir, remove_file, symlink_metadata, panic!).


##### `process_is_active`  (lines 1192–1199)

```
fn process_is_active(pid: libc::pid_t) -> bool
```

**Purpose**: Determines whether a pid still refers to a live process by using `kill(pid, 0)`. It treats any error other than `ESRCH` as evidence that the process still exists.

**Data flow**: Calls `libc::kill(pid, 0)`, returns true on success, otherwise reads `last_os_error()` and returns false only when the raw OS error is `ESRCH`. It is pure aside from the kernel liveness probe.

**Call relations**: Used by marker-directory scanning to remove stale registrations and decide whether cleanup can proceed.

*Call graph*: called by 1 (synthetic_mount_marker_dir_has_active_process_matching); 3 external calls (last_os_error, kill, matches!).


##### `with_synthetic_mount_registry_lock`  (lines 1201–1238)

```
fn with_synthetic_mount_registry_lock(f: impl FnOnce() -> T) -> T
```

**Purpose**: Executes a closure while holding an exclusive `flock` on the shared synthetic/protected target registry. It serializes registration and cleanup across concurrent helper processes.

**Data flow**: Computes the registry root, creates it if needed, opens/creates a `lock` file with read/write access, acquires `LOCK_EX` via `flock`, runs the provided closure `f`, then unlocks with `LOCK_UN`, panicking on any filesystem or lock error. Returns the closure's result.

**Call relations**: This wrapper is used by all registry-mutating operations: registering synthetic targets, registering protected-create targets, and both cleanup functions.

*Call graph*: calls 1 internal fn (synthetic_mount_registry_root); called by 4 (cleanup_protected_create_targets, cleanup_synthetic_mount_targets, register_protected_create_targets, register_synthetic_mount_targets); 5 external calls (new, last_os_error, create_dir_all, flock, panic!).


##### `synthetic_mount_marker_dir`  (lines 1240–1242)

```
fn synthetic_mount_marker_dir(path: &Path) -> PathBuf
```

**Purpose**: Maps a target path to its registry marker directory by hashing the path bytes. This gives each tracked path a stable per-user registry location.

**Data flow**: Calls `synthetic_mount_registry_root()` and appends a hex string derived from `hash_path(path)`. Returns the resulting `PathBuf` without mutating state.

**Call relations**: Used by registration helpers to locate marker directories for both synthetic mount and protected-create targets.

*Call graph*: calls 1 internal fn (synthetic_mount_registry_root); 1 external calls (format!).


##### `synthetic_mount_registry_root`  (lines 1244–1249)

```
fn synthetic_mount_registry_root() -> PathBuf
```

**Purpose**: Computes the root directory under the system temp dir where synthetic/protected target registry state is stored for the current effective user. The uid scoping prevents cross-user interference.

**Data flow**: Reads `geteuid()` and `std::env::temp_dir()`, formats `codex-bwrap-synthetic-mount-targets-{effective_uid}`, and returns the joined `PathBuf`. It is pure.

**Call relations**: Called by `synthetic_mount_marker_dir` and `with_synthetic_mount_registry_lock` whenever registry paths are needed.

*Call graph*: called by 2 (synthetic_mount_marker_dir, with_synthetic_mount_registry_lock); 3 external calls (format!, geteuid, temp_dir).


##### `hash_path`  (lines 1251–1258)

```
fn hash_path(path: &Path) -> u64
```

**Purpose**: Computes a stable 64-bit hash of a filesystem path's raw bytes using an FNV-1a-style algorithm. The hash is used to derive marker directory names.

**Data flow**: Reads `path.as_os_str().as_bytes()`, initializes a fixed 64-bit seed, XORs and multiplies for each byte, and returns the final `u64`. It does not mutate state.

**Call relations**: Used only by `synthetic_mount_marker_dir` to produce deterministic registry subdirectory names.

*Call graph*: 2 external calls (as_os_str, from).


##### `exit_with_wait_status`  (lines 1260–1275)

```
fn exit_with_wait_status(status: libc::c_int) -> !
```

**Purpose**: Propagates a child process's raw wait status to the current process in the conventional Unix way. It preserves normal exit codes and re-raises terminating signals.

**Data flow**: Reads `status`; if `WIFEXITED`, exits with `WEXITSTATUS(status)`. If `WIFSIGNALED`, it resets the current process's handler for that signal to default, sends the signal to itself, and then exits with `128 + signal` as a fallback. Otherwise it exits with code 1. It never returns.

**Call relations**: Used by `exit_with_wait_status_or_policy_violation` and by the stderr-capture path when the preflight child died from a signal.

*Call graph*: called by 2 (exit_with_wait_status_or_policy_violation, run_bwrap_in_child_capture_stderr); 8 external calls (WEXITSTATUS, WIFEXITED, WIFSIGNALED, WTERMSIG, getpid, kill, signal, exit).


##### `exit_with_wait_status_or_policy_violation`  (lines 1277–1286)

```
fn exit_with_wait_status_or_policy_violation(
    status: libc::c_int,
    protected_create_violation: bool,
) -> !
```

**Purpose**: Overrides a successful child exit with failure when protected-create policy was violated, otherwise propagates the child's wait status unchanged. This ensures policy violations are not masked by a zero exit code.

**Data flow**: Reads `status` and `protected_create_violation`; if violation is true and the child exited normally with status 0, it exits with code 1. Otherwise it delegates to `exit_with_wait_status(status)`. It never returns.

**Call relations**: Called at the end of `run_bwrap_in_child_with_synthetic_mount_cleanup` after cleanup and monitor results have been combined.

*Call graph*: calls 1 internal fn (exit_with_wait_status); called by 1 (run_bwrap_in_child_with_synthetic_mount_cleanup); 3 external calls (WEXITSTATUS, WIFEXITED, exit).


##### `run_bwrap_in_child_capture_stderr`  (lines 1299–1368)

```
fn run_bwrap_in_child_capture_stderr(bwrap_args: crate::bwrap::BwrapArgs) -> String
```

**Purpose**: Runs a short-lived bubblewrap child, captures up to 64 KiB of its stderr, performs the same synthetic/protected target registration and cleanup as normal execution, and returns the captured stderr text. It is used only for proc-mount preflight probing.

**Data flow**: Consumes `BwrapArgs`, blocks forwarded signals, registers cleanup targets, creates a CLOEXEC pipe, forks, and in the child resets handlers, restores the signal mask, redirects stderr to the pipe with `dup2`, closes unused fds, and `exec_bwrap`s. In the parent it installs signal forwarders, restores the setup mask, closes the write end, wraps the read end in `File::from_raw_fd`, reads up to `MAX_PREFLIGHT_STDERR_BYTES`, waits for the child, blocks signals for cleanup, clears global child pid, cleans synthetic/protected targets, restores handlers/masks, exits on signaled child, and otherwise returns `String::from_utf8_lossy(&stderr_bytes).into_owned()`.

**Call relations**: Called only by `preflight_proc_mount_support`. It mirrors much of the supervised bubblewrap machinery but replaces final status propagation with bounded stderr capture for error classification.

*Call graph*: calls 11 internal fn (exec_bwrap, block, cleanup_protected_create_targets, cleanup_synthetic_mount_targets, close_fd_or_panic, exit_with_wait_status, install_bwrap_signal_forwarders, register_protected_create_targets, register_synthetic_mount_targets, reset_forwarded_signal_handlers_to_default (+1 more)); called by 1 (preflight_proc_mount_support); 9 external calls (from_raw_fd, from_utf8_lossy, new, last_os_error, WIFSIGNALED, dup2, fork, pipe2, panic!).


##### `close_fd_or_panic`  (lines 1375–1381)

```
fn close_fd_or_panic(fd: libc::c_int, context: &str)
```

**Purpose**: Closes an owned file descriptor and panics with contextual text if the close fails. It is used in low-level setup code where silent fd leaks would obscure later failures.

**Data flow**: Takes `fd` and `context`, calls `libc::close(fd)`, and on negative return reads `last_os_error()` and panics with `{context}: {err}`. Otherwise returns `()`.

**Call relations**: Used only by `run_bwrap_in_child_capture_stderr` around pipe-end management in both parent and child branches.

*Call graph*: called by 1 (run_bwrap_in_child_capture_stderr); 3 external calls (last_os_error, close, panic!).


##### `is_proc_mount_failure`  (lines 1383–1389)

```
fn is_proc_mount_failure(stderr: &str) -> bool
```

**Purpose**: Recognizes bubblewrap stderr text that specifically indicates failure to mount `/proc` inside `/newroot/proc`. It matches several common errno strings.

**Data flow**: Reads `stderr: &str` and returns true only when it contains `"Can't mount proc"`, `"/newroot/proc"`, and one of `"Invalid argument"`, `"Operation not permitted"`, or `"Permission denied"`. It is pure.

**Call relations**: Called by `preflight_proc_mount_support` to decide whether the real bubblewrap run should silently retry with `mount_proc = false`.

*Call graph*: called by 1 (preflight_proc_mount_support).


##### `build_inner_seccomp_command`  (lines 1401–1443)

```
fn build_inner_seccomp_command(args: InnerSeccompCommandArgs<'_>) -> Vec<String>
```

**Purpose**: Builds the argv for the inner helper invocation that runs inside bubblewrap, reapplies seccomp/no_new_privs, optionally activates proxy routing, and then execs the user command. It serializes the permission profile back into JSON for the re-entry.

**Data flow**: Consumes `InnerSeccompCommandArgs`, resolves `current_exe`, serializes `permission_profile` with `serde_json::to_string`, builds a vector beginning with the current executable path and `--sandbox-policy-cwd`, optionally appends `--command-cwd`, always appends `--permission-profile <json> --apply-seccomp-then-exec`, conditionally appends `--allow-network-for-proxy --proxy-route-spec <spec>` and panics if proxy mode lacks a spec, then appends `--` and the user command. Returns the assembled `Vec<String>`.

**Call relations**: Called by `run_main` in the normal bubblewrap path before `run_bwrap_with_proc_fallback`. Tests validate both the proxy and non-proxy argument shapes.

*Call graph*: called by 1 (run_main); 4 external calls (panic!, to_string, current_exe, vec!).


##### `exec_or_panic`  (lines 1446–1466)

```
fn exec_or_panic(command: Vec<String>) -> !
```

**Purpose**: Execs the final user command with `execvp`, panicking with context if the exec fails. It is the last step after all sandbox setup is complete.

**Data flow**: Consumes `command: Vec<String>`, converts `command[0]` and every arg into `CString`, builds a null-terminated pointer array, calls `libc::execvp`, and if it returns reads `last_os_error()` and panics with the command name. On success it never returns.

**Call relations**: Used by `run_main` in the inner-stage path, the direct seccomp path, and the legacy Landlock path once all restrictions have been applied.

*Call graph*: called by 1 (run_main); 5 external calls (new, last_os_error, execvp, panic!, null).


### `linux-sandbox/src/main.rs`

`entrypoint` · `process startup`

This binary crate is intentionally minimal. Its `main` function contains no argument parsing, setup, or error handling of its own; instead it delegates immediately to `codex_linux_sandbox::run_main()`, which performs platform gating and then enters the full Linux helper orchestration in the library. The doc comment notes an important contract: because the helper ultimately reaches an `execv`/`execvp` boundary, the caller is responsible for ensuring the current working directory, environment, and command arguments are already correct before invoking the binary.

Architecturally, this file exists to keep the executable target thin and to place all substantive logic in reusable library modules. That makes testing and conditional compilation easier, while preserving a standard Rust binary entrypoint for packaging and invocation.

#### Function details

##### `main`  (lines 4–6)

```
fn main() -> !
```

**Purpose**: Starts the sandbox helper by delegating to the library entrypoint. It never returns because the library either execs another program or exits/panics.

**Data flow**: Takes no arguments, calls `codex_linux_sandbox::run_main()`, and returns `!`. It does not manage any local state.

**Call relations**: This is the topmost process entrypoint. All real control flow continues in the library's `run_main`, which performs platform dispatch and sandbox orchestration.

*Call graph*: 1 external calls (run_main).


### `bwrap/src/main.rs`

`entrypoint` · `process startup`

This file is intentionally tiny but critical: it bridges the Rust binary crate to the bubblewrap C program compiled by the build script. The active `main` function depends on compile-time cfgs. In the successful Linux + `bwrap_available` configuration, it declares the external `bwrap_main` symbol, converts `std::env::args_os()` into `CString`s using raw OS bytes, builds a null-terminated `argv` pointer array, and calls the C entrypoint with `argc` and `argv`. The safety comment documents the key invariant: the `CString` storage outlives the FFI call, so the pointers remain valid. The returned C exit code is then passed directly to `std::process::exit`, making the wrapper behave like the native program.

The other cfg variants are deliberate fail-fast stubs. If the target is Linux but the build script did not produce `bwrap_available`, `main` panics with guidance about Linux targeting, libcap headers, and the expected source location. On non-Linux targets it panics unconditionally that bubblewrap is only supported on Linux. This design keeps unsupported builds explicit rather than silently no-oping.

#### Function details

##### `main`  (lines 43–45)

```
fn main()
```

**Purpose**: Acts as the binary entrypoint, either dispatching into the compiled bubblewrap C `main` or panicking for unsupported build/target combinations. The exact behavior is selected at compile time by cfgs.

**Data flow**: In the Linux-supported build, it reads process arguments from `args_os`, converts each to `CString`, collects raw pointers plus a trailing null pointer, calls the external `bwrap_main(argc, argv)`, and exits the Rust process with the returned code. In the unsupported cfg variants, it immediately panics with a descriptive message instead of invoking any external code.

**Call relations**: This is the top-level executable entrypoint and is not called by other project code. In the supported configuration it delegates all substantive behavior to the C symbol produced by the build script’s `main=bwrap_main` rename.

*Call graph*: 4 external calls (panic!, args_os, exit, null).


### `shell-escalation/src/bin/main_execve_wrapper.rs`

`entrypoint` · `startup`

This file is a tiny platform-selecting binary shim for the `codex-execve-wrapper` executable. Its entire job is to expose a `main` symbol appropriate to the target OS. The file is split by conditional compilation: under `#[cfg(unix)]`, it does not define its own logic at all, but publicly re-exports `codex_shell_escalation::main_execve_wrapper` as the process entrypoint. That means all real startup behavior, argument handling, and exec-related work live in the library crate, while this binary target remains minimal.

Under `#[cfg(not(unix))]`, the file provides a fallback `main` that prints a fixed error message to standard error — `codex-execve-wrapper is only implemented for UNIX` — and then terminates the process with exit status `1`. There is no branching, recovery, or feature probing at runtime; the decision is made entirely at compile time via Rust cfg attributes. An important design detail is that unsupported platforms still build a valid binary entrypoint rather than failing mysteriously at link or startup time, and the explicit nonzero exit code makes the unsupported-platform condition observable to scripts and callers.

#### Function details

##### `main`  (lines 2–5)

```
fn main()
```

**Purpose**: On non-Unix targets, this is the executable's fallback entrypoint that reports the platform is unsupported and exits unsuccessfully. It exists only when the Unix-specific library implementation is not compiled in.

**Data flow**: It takes no arguments directly. It emits a constant diagnostic string to stderr via `eprintln!`, then invokes process termination with status code `1` via `std::process::exit`; it does not return normally and does not mutate any application state beyond writing the error output and setting the process exit status.

**Call relations**: This function is invoked by the runtime as the binary entrypoint only on builds where `cfg(not(unix))` is active. Its control flow is self-contained: it delegates only to stderr output and immediate process exit, whereas on Unix this local function is absent and the binary instead routes startup into `codex_shell_escalation::main_execve_wrapper` through the public re-export.

*Call graph*: 2 external calls (eprintln!, exit).


### `shell-escalation/src/unix/execve_wrapper.rs`

`entrypoint` · `startup`

This file is a thin startup layer for a helper binary used around execve interception on Unix. Its only local data model is `ExecveWrapperCli`, a `clap::Parser` struct with two positional fields: `file`, the executable path or command name to run, and `argv`, a trailing variadic vector that captures the remaining command-line arguments exactly as provided. The `trailing_var_arg = true` annotation is important because it preserves the rest of the command line as payload for the wrapped exec invocation rather than letting clap continue option parsing.

The main behavior lives in `main_execve_wrapper`, which is marked `#[tokio::main]` so the helper runs inside a Tokio async runtime without requiring a separate bootstrap file. On startup it configures `tracing_subscriber` to emit formatted logs to stderr, disables ANSI color codes, and derives filtering rules from environment variables via `EnvFilter::from_default_env()`. After logging is initialized, it parses CLI arguments into `ExecveWrapperCli`, destructures out `file` and `argv`, and asynchronously invokes `crate::run_shell_escalation_execve_wrapper(file, argv)`. That external routine returns an integer process exit code; this function does not return normally after success, but terminates the process with `std::process::exit(exit_code)`. Errors from the async wrapper setup or execution are propagated as `anyhow::Result<()>`, making this file responsible only for startup, argument capture, and final process termination semantics.

#### Function details

##### `main_execve_wrapper`  (lines 15–25)

```
async fn main_execve_wrapper() -> anyhow::Result<()>
```

**Purpose**: Bootstraps the execve-wrapper helper process: it installs tracing, parses the command line into a target file plus trailing argv, invokes the async wrapper implementation, and exits the process with the returned status code.

**Data flow**: It takes no explicit arguments and starts by reading logging configuration from the environment through `EnvFilter::from_default_env()`. It builds and initializes a tracing subscriber that writes formatted, non-ANSI logs to stderr, then reads process CLI arguments via `ExecveWrapperCli::parse()` into `file: String` and `argv: Vec<String>`. Those values are passed into `crate::run_shell_escalation_execve_wrapper(file, argv).await`, which yields an exit code on success; that code is written to process state by calling `std::process::exit(exit_code)`. If the delegated async routine returns an error, the error is propagated as `anyhow::Result<()>` instead of exiting normally.

**Call relations**: This function is the file's sole entrypoint and is invoked when the helper binary starts. Its control flow is strictly linear: initialize tracing first so downstream startup and wrapper execution can log, parse CLI input next, then delegate all substantive execve-wrapper behavior to `run_shell_escalation_execve_wrapper`; on successful completion it does not continue upward but terminates the process explicitly with the delegated exit status.

*Call graph*: 5 external calls (from_default_env, run_shell_escalation_execve_wrapper, parse, exit, fmt).


### Windows sandbox helpers
These files implement the Windows sandbox setup, elevated command runner, and wrapper protocol used to launch restricted processes.

### `windows-sandbox-rs/src/bin/command_runner/main.rs`

`entrypoint` · `process startup`

This file is a thin dispatch layer that keeps the binary buildable across platforms while making its real implementation Windows-specific. On Windows targets it declares the `win` module and forwards `main` directly to `win::main()`, preserving the `anyhow::Result<()>` return type from the implementation module. On non-Windows targets it defines a different `main` that immediately panics with a clear message that `codex-command-runner` is Windows-only.

The design keeps all substantive logic out of this file and avoids conditional compilation noise in the larger runner implementation. It also ensures accidental invocation or packaging on unsupported platforms fails loudly rather than silently doing nothing.

#### Function details

##### `main`  (lines 10–12)

```
fn main()
```

**Purpose**: Selects the platform-specific runner behavior: delegate to the Windows implementation or panic on unsupported targets.

**Data flow**: On Windows builds, it takes no arguments and returns the `anyhow::Result<()>` from `win::main()`. On non-Windows builds, it takes no arguments and terminates by panicking with a fixed message.

**Call relations**: This is the binary entrypoint invoked by the OS. Its only role is to hand control to `win::main` when compiled for Windows.

*Call graph*: 2 external calls (panic!, main).


### `windows-sandbox-rs/src/bin/command_runner/win.rs`

`entrypoint` · `sandboxed child-process startup and IPC session loop`

This is the main runtime for the elevated Windows sandbox path. It speaks a framed IPC protocol over named pipes: the parent sends a `SpawnRequest`, the runner derives a restricted token from the current token plus capability SIDs, spawns the child either under ConPTY (`tty=true`) or ordinary pipes (`tty=false`), emits `SpawnReady`, streams output frames back, accepts stdin/resize/terminate frames, and finally sends an `Exit` frame.

Several pieces are carefully engineered around Windows resource management. `OwnedWinHandle` provides RAII for raw `HANDLE`s so early-return failures do not leak tokens, jobs, or pipe handles. `spawn_ipc_process` parses capability SID strings into `LocalSid` owners, chooses token creation based on `token_mode_for_permission_profile`, grants null-device access to those SIDs, optionally rewrites the working directory through a junction when the ACL helper mutex indicates that path should be used, and then spawns either a ConPTY-backed or pipe-backed child. `main` opens both named pipes under guards before converting them into `File`s, validates protocol version and message type, assigns the child to a kill-on-close job object when possible, and coordinates reader/writer threads.

The input loop handles partial `WriteFile` progress correctly, closes stdin on failure or explicit close, resizes the pseudoconsole when requested, and terminates the child on command. After waiting with an optional timeout, the runner kills timed-out children, closes process/thread/job handles, drops the ConPTY owner to release the pseudoconsole, joins output threads, attempts to send the final exit frame, and then exits the runner process with the child’s exit code.

#### Function details

##### `OwnedWinHandle::new`  (lines 101–103)

```
fn new(handle: HANDLE) -> Self
```

**Purpose**: Wraps a raw Win32 `HANDLE` in an RAII owner.

**Data flow**: Accepts a `HANDLE` and stores it in `OwnedWinHandle` without validation or duplication.

**Call relations**: Used wherever the runner acquires a raw handle that should be automatically closed on early return, including job creation, pipe opening, and token acquisition.

*Call graph*: called by 3 (create_job_kill_on_close, main, spawn_ipc_process).


##### `OwnedWinHandle::raw`  (lines 105–107)

```
fn raw(&self) -> HANDLE
```

**Purpose**: Returns the wrapped raw `HANDLE` without transferring ownership.

**Data flow**: Reads the stored handle value and returns it unchanged.

**Call relations**: Used by setup code such as job configuration and token-based spawn helpers when they need to pass the handle to Win32 APIs while retaining RAII ownership.


##### `OwnedWinHandle::into_raw`  (lines 109–115)

```
fn into_raw(mut self) -> HANDLE
```

**Purpose**: Transfers ownership of the wrapped handle to the caller and disables automatic closing in `Drop`.

**Data flow**: Takes ownership of `self`, copies out the current handle, sets the internal field to `0`, and returns the original `HANDLE`.

**Call relations**: Used in `main` when converting successfully opened pipe handles into `File`s so the `File` becomes responsible for closing them.


##### `OwnedWinHandle::drop`  (lines 119–125)

```
fn drop(&mut self)
```

**Purpose**: Closes the wrapped handle automatically when the guard goes out of scope, unless ownership was transferred or the handle is invalid.

**Data flow**: On drop, it checks whether the stored handle is neither `0` nor `INVALID_HANDLE_VALUE`; if valid, it calls `CloseHandle`.

**Call relations**: Provides the cleanup guarantee relied on by all early-return paths in this module.

*Call graph*: 1 external calls (CloseHandle).


##### `create_job_kill_on_close`  (lines 128–145)

```
fn create_job_kill_on_close() -> Result<HANDLE>
```

**Purpose**: Creates a Windows job object configured to terminate assigned processes when the job handle is closed.

**Data flow**: Calls `CreateJobObjectW`, wraps the result in `OwnedWinHandle`, initializes a zeroed `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, applies it with `SetInformationJobObject`, and returns the raw job handle on success or an `anyhow` error on failure.

**Call relations**: Called by `main` after spawning the child so the runner can best-effort tie child lifetime to the runner process.

*Call graph*: calls 1 internal fn (new); called by 1 (main); 6 external calls (anyhow!, zeroed, null, null_mut, CreateJobObjectW, SetInformationJobObject).


##### `open_pipe`  (lines 148–166)

```
fn open_pipe(name: &str, access: u32) -> Result<HANDLE>
```

**Purpose**: Opens one named pipe endpoint created by the parent process with the requested access mode.

**Data flow**: Accepts a pipe name and access mask, converts the name to UTF-16 with `to_wide`, calls `CreateFileW` with `OPEN_EXISTING`, and returns the resulting `HANDLE` or an `anyhow` error containing the pipe name and `GetLastError()` code.

**Call relations**: Used by `main` to open both the inbound and outbound IPC pipes before wrapping them as `File`s.

*Call graph*: called by 1 (main); 5 external calls (anyhow!, to_wide, null_mut, GetLastError, CreateFileW).


##### `send_error`  (lines 169–183)

```
fn send_error(writer: &Arc<StdMutex<File>>, code: &str, message: String) -> Result<()>
```

**Purpose**: Sends a framed protocol error message back to the parent over the output pipe.

**Data flow**: Accepts the shared writer mutex, an error code string, and a message string. It constructs a `FramedMessage` containing `Message::Error { payload: ErrorPayload { ... } }`, locks the writer if possible, writes the frame with `write_frame`, and returns `Result<()>`.

**Call relations**: Used by `main` when reading the spawn request or spawning the child fails, so the parent receives a structured failure before the runner exits.

*Call graph*: called by 1 (main); 1 external calls (write_frame).


##### `read_spawn_request`  (lines 186–197)

```
fn read_spawn_request(reader: &mut File) -> Result<SpawnRequest>
```

**Purpose**: Reads the first IPC frame and validates that it is a `SpawnRequest` using the expected protocol version.

**Data flow**: Accepts a mutable `File`, reads one optional frame with `read_frame`, errors if the pipe closed before a frame arrived, checks `msg.version` against `IPC_PROTOCOL_VERSION`, matches `msg.message`, and returns the boxed `SpawnRequest` payload or a descriptive error.

**Call relations**: Called by `main` immediately after pipe setup; it enforces the protocol contract before any child process is created.

*Call graph*: called by 1 (main); 2 external calls (bail!, read_frame).


##### `read_acl_mutex_exists`  (lines 199–213)

```
fn read_acl_mutex_exists() -> Result<bool>
```

**Purpose**: Checks whether the named ACL-helper mutex currently exists.

**Data flow**: Builds the mutex name as UTF-16, calls `OpenMutexW(MUTEX_ALL_ACCESS, ...)`, returns `Ok(false)` if the error is `ERROR_FILE_NOT_FOUND`, returns an error for other open failures, and closes the mutex handle before returning `Ok(true)` when it exists.

**Call relations**: Used by `effective_cwd` to decide whether the runner should prefer a junction-based working directory.

*Call graph*: called by 1 (effective_cwd); 6 external calls (new, anyhow!, to_wide, CloseHandle, GetLastError, OpenMutexW).


##### `effective_cwd`  (lines 216–234)

```
fn effective_cwd(req_cwd: &Path, log_dir: Option<&Path>) -> PathBuf
```

**Purpose**: Chooses the working directory to pass to the child process, optionally replacing the requested CWD with a junction path.

**Data flow**: Accepts the requested CWD and optional log directory. It probes `read_acl_mutex_exists`; if the mutex exists it tries `cwd_junction::create_cwd_junction(req_cwd, log_dir)` and falls back to `req_cwd.to_path_buf()` on failure, if the mutex does not exist it returns the original CWD, and if probing fails it logs the error and defaults to attempting the junction path.

**Call relations**: Called by `spawn_ipc_process` just before process creation so the chosen CWD reflects current ACL-helper state.

*Call graph*: calls 2 internal fn (create_cwd_junction, read_acl_mutex_exists); called by 1 (spawn_ipc_process); 3 external calls (to_path_buf, log_note, format!).


##### `spawn_ipc_process`  (lines 236–348)

```
fn spawn_ipc_process(req: &SpawnRequest) -> Result<IpcSpawnedProcess>
```

**Purpose**: Builds the restricted token and spawns the requested child process with either ConPTY or ordinary pipes, returning all handles needed for IPC forwarding.

**Data flow**: Accepts a `SpawnRequest`. It derives `log_dir`, hides the current user profile directory, resolves `WindowsSandboxTokenMode` from the permission profile, parses capability SID strings into `LocalSid` owners, errors if no capability SIDs are present, collects raw SID pointers, acquires the current token for restriction, creates either a readonly-capability or writable-roots-capability token, grants null-device access to the capability SIDs, computes the effective CWD, and then spawns either a ConPTY child or a pipe-backed child. It returns an `IpcSpawnedProcess` containing process info, stdio handles, optional stdin handle, optional ConPTY owner and pseudoconsole handle, and optional pipe-handle bundle.

**Call relations**: Called by `main` after the spawn request is validated; it is the central setup phase that bridges protocol input to an actual child process.

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

**Purpose**: Starts a background reader that converts child stdout or stderr bytes into framed `Output` messages sent to the parent.

**Data flow**: Accepts the shared writer, a read handle, an `OutputStream` discriminator, and an optional log directory. It calls `read_handle_loop` with a closure that base64-encodes each chunk, wraps it in `FramedMessage { Message::Output { ... } }`, locks the writer, and writes the frame; write failures are logged.

**Call relations**: Used by `main` to create one thread for stdout and, when present, another for stderr.

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

**Purpose**: Starts a background thread that reads control/input frames from the parent and forwards them to the child process or pseudoconsole.

**Data flow**: Accepts the input `File`, optional stdin handle, shared optional pseudoconsole handle, shared optional process handle, and optional log directory. In a spawned thread it repeatedly reads frames with `read_frame`, decodes `Stdin` payloads from base64 and writes them to the child stdin handle with repeated `WriteFile` calls until all bytes are consumed or progress stops, closes stdin on `CloseStdin`, resizes the pseudoconsole on `Resize`, terminates the process on `Terminate`, ignores other message variants, and closes any remaining stdin handle before exiting.

**Call relations**: Started by `main` after `SpawnReady` is sent so the parent can stream stdin and control messages while output readers and process waiting proceed concurrently.

*Call graph*: called by 1 (main); 1 external calls (spawn).


##### `main`  (lines 500–653)

```
fn main() -> Result<()>
```

**Purpose**: Implements the full elevated-runner lifecycle: parse pipe arguments, establish IPC, receive the spawn request, spawn the child, proxy I/O and control messages, wait for completion or timeout, and emit the final exit frame.

**Data flow**: Reads `--pipe-in=` and `--pipe-out=` from `std::env::args`, errors if either is missing, opens both named pipes with `open_pipe`, converts them into `File`s via `OwnedWinHandle::into_raw`, reads and validates the initial `SpawnRequest`, spawns the child with `spawn_ipc_process`, optionally creates and assigns a kill-on-close job object, sends `SpawnReady` with the child PID, starts stdout/stderr reader threads and the input loop, waits on the child with an optional timeout, terminates on timeout and computes the final exit code, closes process/thread/job handles, drops pseudoconsole ownership, joins output threads, attempts to send an `Exit` frame, and finally terminates the runner process with `std::process::exit(exit_code)`.

**Call relations**: This is the Windows binary entrypoint reached from the platform-gated outer `main`. It orchestrates every helper in the module and is the sole owner of the end-to-end IPC session.

*Call graph*: calls 8 internal fn (new, create_job_kill_on_close, open_pipe, read_spawn_request, send_error, spawn_input_loop, spawn_ipc_process, spawn_output_reader); 16 external calls (clone, new, from_raw_handle, new, bail!, log_note, write_frame, format!, args, exit (+6 more)).


### `windows-sandbox-rs/src/bin/setup_main/main.rs`

`entrypoint` · `startup`

This file exists solely to select the platform-specific setup implementation at compile time. When built for Windows, it exposes `mod win` and the binary `main` returns `anyhow::Result<()>`, delegating directly to `win::main()` so all setup logic, logging, ACL work, user provisioning, and firewall configuration live in the Windows-only module tree. When built for any non-Windows target, the alternate `main` panics with a fixed message stating that `codex-windows-sandbox-setup` is Windows-only. There is no argument parsing, state, or error translation here; the file’s only design role is to keep the crate buildable across targets while making the unsupported path fail loudly and early.

#### Function details

##### `main`  (lines 10–12)

```
fn main()
```

**Purpose**: Acts as the binary entrypoint and dispatches to the Windows implementation when available, otherwise aborts on unsupported platforms.

**Data flow**: It takes no explicit arguments and reads only compile-time target configuration. On Windows it returns the `anyhow::Result<()>` produced by the delegated implementation; on non-Windows it emits no structured result and instead panics with a fixed message.

**Call relations**: This is the process entrypoint. In the Windows build it immediately hands control to the external `win::main`; in non-Windows builds the only control flow is the panic path.

*Call graph*: 2 external calls (panic!, main).


### `windows-sandbox-rs/src/bin/setup_main/win.rs`

`orchestration` · `setup request handling`

This file is the core orchestration layer for Windows sandbox setup. It defines the serialized `Payload` consumed from a single base64-encoded CLI argument and the `SetupMode` enum controlling whether the helper performs a full setup, only provisions users/network, or only refreshes read ACLs. `real_main` validates the payload version against `SETUP_VERSION`, creates the sandbox directory under `codex_home`, opens the setup log, and routes execution through `run_setup`; failures are normalized into `SetupFailure`/`SetupErrorReport` records and persisted for the caller.

The setup flow is split deliberately. `run_provision_only` creates local users and group membership, hides those users, resolves SIDs, installs firewall/WFP restrictions for the offline account, and locks persistent sandbox directories. `run_read_acl_only` is serialized by a named mutex so only one background ACL refresher runs at a time; it checks whether broad built-in principals already grant read/execute and otherwise grants inherited ACEs to the sandbox group. `run_setup_full` combines both worlds and additionally applies synchronous deny-read ACLs before command launch, spawns a detached helper for slower read-grant work, verifies runtime binary readability during refreshes, computes per-write-root capability SIDs, grants write ACEs in parallel threads, and materializes missing deny-write carveout directories before attaching deny ACEs. The file is careful about idempotence, duplicate path suppression via `HashSet`, canonical path comparisons, and fail-closed behavior: refresh runs accumulate soft errors into `refresh_errors` but ultimately fail if any remain, while top-level setup writes a protected marker only after successful completion.

#### Function details

##### `log_line`  (lines 114–123)

```
fn log_line(log: &mut dyn Write, msg: &str) -> Result<()>
```

**Purpose**: Writes a timestamped line into the setup log and converts write failures into a structured setup failure.

**Data flow**: It takes a mutable `Write` sink and a message string, prepends the current UTC RFC3339 timestamp, and writes one line. It returns `Ok(())` on success or an `anyhow::Error` wrapping `SetupFailure { code: HelperLogFailed, ... }` if the write fails.

**Call relations**: This is the common logging primitive used throughout setup paths whenever ACL checks, grants, refresh summaries, or top-level failures need to be recorded. Callers use it for best-effort diagnostics before continuing or before converting an operation into a hard failure.

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

**Purpose**: Computes which workspace/write-root capability SID strings should receive deny-write protection for a specific path.

**Data flow**: It reads `codex_home`, `command_cwd`, the active `write_roots`, and a target `path`. It collects capability SIDs for roots whose canonicalized paths overlap the target; if none overlap, it falls back to either the command CWD capability when there are no explicit write roots or all active write-root capabilities otherwise, and returns the resulting `Vec<String>`.

**Call relations**: This helper is used during full setup when deny-write carveouts are applied, ensuring deny ACEs target only currently active capability SIDs rather than stale historical ones. The tests in this file exercise its overlap and fallback behavior for active, outside-root, and nested-root cases.

*Call graph*: called by 4 (run_setup_full, deny_path_includes_nested_active_root_sid, deny_path_outside_active_roots_falls_back_to_all_active_root_sids, deny_path_under_active_root_uses_only_matching_root_sid); 4 external calls (is_empty, new, workspace_write_cap_sid_for_root, workspace_write_root_overlaps_path).


##### `spawn_read_acl_helper`  (lines 161–177)

```
fn spawn_read_acl_helper(payload: &Payload, _log: &mut dyn Write) -> Result<()>
```

**Purpose**: Launches a detached copy of the setup helper in `ReadAclsOnly` refresh mode.

**Data flow**: It clones the incoming `Payload`, rewrites `mode` to `ReadAclsOnly` and `refresh_only` to `true`, serializes it to JSON, base64-encodes it, resolves the current executable path, and spawns a child process with the payload as its sole argument and all stdio redirected to null. It returns success once the child is spawned.

**Call relations**: This is invoked from the full setup path when read roots exist and no other read-ACL helper appears to be running. It offloads slower inherited read-grant work so the main setup can finish sooner while deny-read ACLs remain synchronous.

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

**Purpose**: Walks configured read roots and grants inherited read/execute ACEs to the sandbox group only when equivalent access is not already present.

**Data flow**: It consumes the list of `read_roots`, a `ReadAclSubjects` bundle containing the sandbox group PSID and built-in read-capable PSIDs, mutable log and refresh-error sinks, plus the desired access mask/label/inheritance flags. For each existing root it first checks built-in principals, then the sandbox group, logs skips or grant attempts, calls `ensure_allow_mask_aces_with_inheritance` when needed, and appends any grant failures to `refresh_errors`.

**Call relations**: This function is the core worker for `run_read_acl_only`. It delegates access probing to `read_mask_allows_or_log` so ACL read failures become logged soft errors rather than immediate aborts.

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

**Purpose**: Checks whether a path already grants a required access mask to one or more SIDs and downgrades ACL-read failures into logged refresh errors.

**Data flow**: It takes a filesystem `root`, a slice of PSIDs, an optional label suffix, the required mask and human-readable access label, plus mutable error and log sinks. It calls `path_mask_allows`; on success it returns the boolean result, and on failure it records a formatted message in `refresh_errors`, logs a continuing warning, and returns `false`.

**Call relations**: This helper is only used by `apply_read_acls` to keep the read-refresh loop resilient: inability to inspect one ACL does not stop processing of later roots.

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

**Purpose**: Replaces a directory’s DACL with an explicit ACL granting or denying the sandbox group and granting access to SYSTEM, Administrators, and the real user.

**Data flow**: It takes the target directory path, the real username, raw sandbox-group SID bytes, access mode and masks for the sandbox group and real user, and a log sink. It ensures the directory exists, resolves well-known and real-user SIDs, converts each SID to a Windows PSID, builds `EXPLICIT_ACCESS_W` entries with object/container inheritance, creates a new ACL via `SetEntriesInAclW`, applies it with `SetNamedSecurityInfoW`, frees all allocated ACL/SID memory, and returns success or an error describing the failing Win32 call.

**Call relations**: This is the low-level ACL setter used by both `lock_persistent_sandbox_dirs` and `lock_sandbox_bin_dir`. Those wrappers choose the masks and whether the sandbox group receives `GRANT_ACCESS` or the local `DENY_ACCESS` constant.

*Call graph*: calls 1 internal fn (resolve_sid); called by 2 (lock_persistent_sandbox_dirs, lock_sandbox_bin_dir); 12 external calls (new, as_os_str, new, anyhow!, string_from_sid_bytes, to_wide, create_dir_all, null_mut, LocalFree, ConvertStringSidToSidW (+2 more)).


##### `main`  (lines 389–407)

```
fn main() -> Result<()>
```

**Purpose**: Wraps the real setup entrypoint with best-effort top-level error logging into the sandbox log directory.

**Data flow**: It calls `real_main` and inspects the returned `Result`. On error, it reads `CODEX_HOME` from the environment, derives the sandbox directory, ensures it exists, opens a log writer if possible, and appends a timestamped `top-level error` line before returning the original result unchanged.

**Call relations**: This is the Windows binary entrypoint reached from the outer `main.rs`. It exists mainly to preserve diagnostics for unexpected failures that occur before normal error-report writing succeeds.

*Call graph*: calls 1 internal fn (real_main); 6 external calls (new, log_writer, sandbox_dir, var, create_dir_all, writeln!).


##### `real_main`  (lines 409–477)

```
fn real_main() -> Result<()>
```

**Purpose**: Parses the encoded setup request, validates it, initializes logging, runs setup, and emits structured error reports on failure.

**Data flow**: It reads process arguments, requiring exactly one payload argument; base64-decodes it, deserializes `Payload`, checks `payload.version` against `SETUP_VERSION`, creates the sandbox directory, opens the setup log, and invokes `run_setup`. If setup fails, it logs the debug-form error, emits a note, extracts or synthesizes a `SetupFailure`, writes a `SetupErrorReport` under `codex_home`, and returns the original error.

**Call relations**: This function is called only by the Windows `main`. It is the central boundary between external invocation and the internal mode-specific setup routines.

*Call graph*: calls 3 internal fn (log_line, run_setup, new); called by 1 (main); 10 external calls (new, extract_setup_failure, log_note, log_writer, sandbox_dir, write_setup_error_report, format!, from_slice, args, create_dir_all).


##### `run_setup`  (lines 479–499)

```
fn run_setup(payload: &Payload, log: &mut dyn Write, sbx_dir: &Path) -> Result<()>
```

**Purpose**: Selects the requested setup mode and brackets it with protected setup-marker creation and commit when appropriate.

**Data flow**: It reads `payload.mode` and `payload.refresh_only` to decide whether a setup marker should be written. Before running the selected mode it may call `prepare_setup_marker`; after successful completion it may call `commit_setup_marker` with usernames, proxy ports, and local-binding state, then returns `Ok(())`.

**Call relations**: This dispatcher is invoked by `real_main`. It routes to `run_read_acl_only`, `run_provision_only`, or `run_setup_full`, and suppresses marker writes for refresh-only and read-ACL-only runs.

*Call graph*: calls 5 internal fn (run_provision_only, run_read_acl_only, run_setup_full, commit_setup_marker, prepare_setup_marker); called by 1 (real_main).


##### `run_read_acl_only`  (lines 501–562)

```
fn run_read_acl_only(payload: &Payload, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Executes the background read-ACL refresh pass under a named mutex so only one helper instance runs at a time.

**Data flow**: It acquires the read-ACL mutex, returning early with a log message if another helper already owns it. It resolves the sandbox users group SID and PSID, optionally resolves `Users`, `Authenticated Users`, and `Everyone` PSIDs, calls `apply_read_acls` for `payload.read_roots` with read/execute inheritance, frees all allocated PSIDs, logs completion, and if `payload.refresh_only` is true converts any accumulated refresh errors into a hard failure.

**Call relations**: This mode is selected by `run_setup` directly or by a detached child spawned from `run_setup_full`. It relies on `apply_read_acls` for the per-root logic and on the mutex helpers to avoid duplicate concurrent refreshers.

*Call graph*: calls 6 internal fn (apply_read_acls, log_line, acquire_read_acl_mutex, resolve_sandbox_users_group_sid, resolve_sid, sid_bytes_to_psid); called by 1 (run_setup); 5 external calls (new, bail!, format!, vec!, LocalFree).


##### `provision_and_hide_sandbox_users`  (lines 564–590)

```
fn provision_and_hide_sandbox_users(
    payload: &Payload,
    log: &mut dyn Write,
    sbx_dir: &Path,
) -> Result<()>
```

**Purpose**: Creates or updates the sandbox accounts and then hides them from normal user-facing account surfaces.

**Data flow**: It passes `codex_home`, offline and online usernames, and the log sink into `provision_sandbox_users`. If that returns a non-`SetupFailure` error, it wraps it as `HelperUserProvisionFailed`; on success it builds a two-element username list and calls `hide_newly_created_users` with the sandbox directory.

**Call relations**: This helper is shared by both provisioning-only and full setup flows so user creation and error normalization stay consistent.

*Call graph*: calls 2 internal fn (provision_sandbox_users, new); called by 2 (run_provision_only, run_setup_full); 5 external calls (new, extract_setup_failure, hide_newly_created_users, format!, vec!).


##### `configure_offline_sandbox_network`  (lines 592–631)

```
fn configure_offline_sandbox_network(
    payload: &Payload,
    offline_sid_str: &str,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Installs the offline sandbox account’s firewall rules and WFP filters.

**Data flow**: It takes the parsed payload, the offline user SID string, and a log sink. It first calls `firewall::ensure_offline_proxy_allowlist`, then `firewall::ensure_offline_outbound_block`, wrapping unexpected errors as `HelperFirewallRuleCreateOrAddFailed`, and finally invokes `install_wfp_filters` with `codex_home`, the offline username, optional OTEL settings, and a closure that forwards messages into `log_line`.

**Call relations**: This is called from both `run_provision_only` and `run_setup_full`. It centralizes network lockdown so both modes produce the same firewall/WFP state.

*Call graph*: calls 3 internal fn (ensure_offline_outbound_block, ensure_offline_proxy_allowlist, new); called by 2 (run_provision_only, run_setup_full); 4 external calls (new, extract_setup_failure, install_wfp_filters, format!).


##### `lock_persistent_sandbox_dirs`  (lines 633–679)

```
fn lock_persistent_sandbox_dirs(
    payload: &Payload,
    sandbox_group_sid: &[u8],
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Applies restrictive ACLs to the persistent sandbox directories and removes a legacy users file if present.

**Data flow**: It derives the main sandbox directory and sandbox secrets directory from `payload.codex_home`, then calls `lock_sandbox_dir` twice with different masks: the main sandbox dir grants the sandbox group full read/write/execute/delete, while the secrets dir applies a deny entry for the sandbox group. It maps any failure into `HelperSandboxLockFailed` and deletes `sandbox_users.json` from the legacy location if it still exists.

**Call relations**: This wrapper is used after provisioning in both provisioning-only and full setup. It encapsulates the policy distinction between general sandbox state and secrets.

*Call graph*: calls 1 internal fn (lock_sandbox_dir); called by 2 (run_provision_only, run_setup_full); 3 external calls (sandbox_dir, sandbox_secrets_dir, remove_file).


##### `lock_sandbox_bin_dir`  (lines 681–704)

```
fn lock_sandbox_bin_dir(
    payload: &Payload,
    sandbox_group_sid: &[u8],
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Locks down the sandbox binary directory so sandbox users can read/execute but not modify it, while the real user retains full control.

**Data flow**: It computes the sandbox bin directory from `payload.codex_home` and calls `lock_sandbox_dir` with a sandbox-group mask of read/execute and a real-user mask including write/delete. Any failure is wrapped as `HelperSandboxLockFailed` with the directory path in the message.

**Call relations**: This is called by both provisioning-only and full setup before or alongside persistent-directory locking to protect the helper/runtime binaries from sandbox modification.

*Call graph*: calls 1 internal fn (lock_sandbox_dir); called by 2 (run_provision_only, run_setup_full); 1 external calls (sandbox_bin_dir).


##### `run_provision_only`  (lines 706–732)

```
fn run_provision_only(payload: &Payload, log: &mut dyn Write, sbx_dir: &Path) -> Result<()>
```

**Purpose**: Performs only account provisioning, network lockdown, and persistent directory locking without the broader ACL refresh/grant work.

**Data flow**: It provisions and hides users, resolves the offline user SID bytes and string, resolves the sandbox users group SID, configures offline networking, locks the sandbox bin and persistent directories, emits a completion note, and returns success. SID resolution failures are converted into `HelperSidResolveFailed`.

**Call relations**: This branch is selected by `run_setup` when `payload.mode` is `ProvisionOnly`. It is the minimal setup path used when only account/network/bootstrap state must be established.

*Call graph*: calls 6 internal fn (configure_offline_sandbox_network, lock_persistent_sandbox_dirs, lock_sandbox_bin_dir, provision_and_hide_sandbox_users, resolve_sandbox_users_group_sid, resolve_sid); called by 1 (run_setup); 2 external calls (log_note, string_from_sid_bytes).


##### `run_setup_full`  (lines 734–1033)

```
fn run_setup_full(payload: &Payload, log: &mut dyn Write, sbx_dir: &Path) -> Result<()>
```

**Purpose**: Executes the complete setup flow: optional provisioning, network lockdown, deny-read ACLs, delegated read grants, write grants, deny-write carveouts, runtime-bin refresh, and final directory locking.

**Data flow**: It reads the full `Payload`, log sink, and sandbox directory path. Depending on `refresh_only`, it may skip user provisioning and network setup; it resolves offline and sandbox-group SIDs/PSIDs, applies synchronous persistent deny-read ACLs, conditionally spawns the detached read-ACL helper, optionally ensures the Codex runtime bin cache is readable, computes which write roots need grants by checking both sandbox-group and per-root capability SIDs, grants those ACEs in parallel worker threads, creates missing deny-write carveout directories and applies deny ACEs for the relevant capability SIDs, locks the sandbox bin directory, optionally locks persistent directories, frees the sandbox-group PSID, and in refresh mode fails if any soft errors accumulated.

**Call relations**: This is the main branch selected by `run_setup` for normal operation. It delegates specialized work to the firewall module, mutex helpers, runtime-bin helper, sandbox-user helpers, and many `codex_windows_sandbox` ACL primitives, while coordinating ordering so deny protections are in place before sandboxed commands can start.

*Call graph*: calls 12 internal fn (configure_offline_sandbox_network, lock_persistent_sandbox_dirs, lock_sandbox_bin_dir, log_line, provision_and_hide_sandbox_users, read_acl_mutex_exists, resolve_sandbox_users_group_sid, resolve_sid, sid_bytes_to_psid, ensure_codex_app_runtime_bin_readable (+2 more)); called by 1 (run_setup); 16 external calls (new, new, bail!, add_deny_write_ace, canonicalize_path, convert_string_sid_to_sid, is_command_cwd_root, log_note, path_mask_allows, string_from_sid_bytes (+6 more)).


##### `tests::payload_json`  (lines 1047–1059)

```
fn payload_json() -> serde_json::Value
```

**Purpose**: Builds a minimal valid JSON payload fixture used by the deserialization tests.

**Data flow**: It constructs and returns a `serde_json::Value` containing required payload fields such as version, usernames, paths, proxy ports, and real user, while omitting optional fields to exercise defaults.

**Call relations**: This helper is called by the payload parsing tests so each test can mutate a shared baseline fixture instead of rebuilding it manually.

*Call graph*: 1 external calls (json!).


##### `tests::payload_defaults_otel_absent`  (lines 1062–1066)

```
fn payload_defaults_otel_absent()
```

**Purpose**: Verifies that omitting the `otel` field deserializes to `None`.

**Data flow**: It obtains the baseline JSON fixture, deserializes it into `Payload`, and asserts that `payload.otel` equals `None`.

**Call relations**: This test exercises serde defaults on the `Payload` struct.

*Call graph*: 3 external calls (assert_eq!, from_value, payload_json).


##### `tests::payload_accepts_provision_only_mode`  (lines 1069–1075)

```
fn payload_accepts_provision_only_mode()
```

**Purpose**: Verifies that the kebab-case string `provision-only` maps to `SetupMode::ProvisionOnly`.

**Data flow**: It mutates the baseline JSON fixture to include a `mode` field, deserializes into `Payload`, and asserts the parsed enum value.

**Call relations**: This test covers serde enum renaming for setup mode selection.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, payload_json).


##### `tests::payload_accepts_otel_settings`  (lines 1078–1091)

```
fn payload_accepts_otel_settings()
```

**Purpose**: Verifies that nested OTEL settings deserialize into `StatsigMetricsSettings`.

**Data flow**: It inserts an `otel` object into the baseline JSON fixture, deserializes to `Payload`, and asserts that the resulting optional settings struct contains the expected environment string.

**Call relations**: This test confirms that optional telemetry configuration survives payload parsing.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, payload_json).


##### `tests::deny_path_under_active_root_uses_only_matching_root_sid`  (lines 1094–1127)

```
fn deny_path_under_active_root_uses_only_matching_root_sid()
```

**Purpose**: Checks that a deny-write path inside one active write root receives only that root’s capability SID, not stale or workspace-wide ones.

**Data flow**: It creates temporary codex-home/workspace/root directories, derives several capability SIDs, calls `workspace_write_cap_sids_for_path` for a protected path under the active root, and asserts the returned vector contains only the active-root SID.

**Call relations**: This test validates the overlap-selection branch used by full setup when applying deny-write carveouts.

*Call graph*: calls 1 internal fn (workspace_write_cap_sids_for_path); 6 external calls (assert!, assert_eq!, load_or_create_cap_sids, workspace_write_cap_sid_for_root, create_dir_all, tempdir).


##### `tests::deny_path_outside_active_roots_falls_back_to_all_active_root_sids`  (lines 1130–1164)

```
fn deny_path_outside_active_roots_falls_back_to_all_active_root_sids()
```

**Purpose**: Checks that a deny-write path outside all active roots falls back to every currently active root capability SID.

**Data flow**: It creates temporary directories and capability SIDs, calls `workspace_write_cap_sids_for_path` for an outside path, and asserts the result contains the workspace and active-root SIDs but excludes stale and generic workspace capability entries.

**Call relations**: This test covers the fallback branch used when no active root overlaps the deny path.

*Call graph*: calls 1 internal fn (workspace_write_cap_sids_for_path); 6 external calls (assert!, assert_eq!, load_or_create_cap_sids, workspace_write_cap_sid_for_root, create_dir_all, tempdir).


##### `tests::deny_path_includes_nested_active_root_sid`  (lines 1167–1191)

```
fn deny_path_includes_nested_active_root_sid()
```

**Purpose**: Verifies that a protected directory containing a nested active write root receives deny ACEs for both the outer workspace and nested-root capabilities.

**Data flow**: It creates a workspace with a `.codex/nested-root` structure, derives the workspace and nested-root capability SIDs, calls `workspace_write_cap_sids_for_path` for `.codex`, and asserts the returned vector preserves both SIDs.

**Call relations**: This test exercises the overlap logic for nested active roots, matching the deny-write carveout behavior in full setup.

*Call graph*: calls 1 internal fn (workspace_write_cap_sids_for_path); 4 external calls (assert_eq!, workspace_write_cap_sid_for_root, create_dir_all, tempdir).


### `windows-sandbox-rs/src/wrapper.rs`

`entrypoint` · `process startup and sandbox launch`

This file defines the command-line contract for the Windows sandbox wrapper. `create_windows_sandbox_command_args_for_permission_profile` turns a structured launch request into a flat `Vec<String>` beginning with `--run-as-windows-sandbox`, followed by required flags for Codex home, command cwd, permission profile JSON, environment JSON, sandbox level, one or more workspace roots, optional booleans, optional JSON-encoded path override lists, and finally `--` plus the inner command. A notable defaulting rule is that if no workspace roots are supplied, the command cwd is emitted as the sole workspace root.

The runtime side starts in `run_windows_sandbox_wrapper_main`, which strips the first two process arguments, builds a current-thread Tokio runtime, and exits the process with either the sandboxed command's exit code or `1` on wrapper failure. `parse_windows_sandbox_wrapper_args` performs strict flag parsing into `WindowsSandboxWrapperRequest`: required fields must be present, `--codex-home` and path-bearing flags must be absolute, repeated `--workspace-root` values accumulate, booleans are toggled by presence, JSON-bearing flags are deserialized with contextual errors, and `--` terminates wrapper parsing and captures the remaining command argv verbatim. `run_windows_sandbox_wrapper_request` then validates that a command exists, constructs `WindowsSandboxSessionRequest` by borrowing or moving the parsed fields, spawns the sandbox session, and forwards stdio until completion. Small helpers isolate repeated parsing concerns: fetching the next flag value, validating absolute paths, decoding JSON, and mapping textual sandbox levels to the `WindowsSandboxLevel` enum.

#### Function details

##### `create_windows_sandbox_command_args_for_permission_profile`  (lines 37–111)

```
fn create_windows_sandbox_command_args_for_permission_profile(
    command: Vec<String>,
    command_cwd: &AbsolutePathBuf,
    workspace_roots: &[AbsolutePathBuf],
    env_map: &HashMap<String, Strin
```

**Purpose**: Serializes a structured Windows sandbox launch request into the wrapper's argv protocol. It produces the exact argument vector that a direct-spawn caller can pass to `codex.exe --run-as-windows-sandbox`.

**Data flow**: Consumes the inner `command`, absolute command cwd, workspace roots, environment map, permission profile, sandbox level, boolean flags, optional read/write root overrides, deny-path overrides, and `codex_home`. It JSON-serializes `permission_profile` and `env_map`, initializes an argument vector with required flags and values, substitutes `command_cwd` as the only workspace root when `workspace_roots` is empty, appends one `--workspace-root` pair per root, conditionally appends boolean flags, conditionally appends JSON-bearing flags via `push_json_arg`, then appends `--` and extends with the inner command. It returns the completed `Vec<String>` and panics if required JSON serialization fails.

**Call relations**: Used by callers that need to invoke the wrapper path rather than launching the sandbox directly. It delegates repeated JSON flag emission to `push_json_arg`, and its output is validated by `parse_windows_sandbox_wrapper_args` in tests.

*Call graph*: calls 1 internal fn (push_json_arg); 4 external calls (to_string, from_ref, is_empty, vec!).


##### `push_json_arg`  (lines 113–119)

```
fn push_json_arg(args: &mut Vec<String>, flag: &str, value: &T)
```

**Purpose**: Appends one flag and its JSON-serialized value to the wrapper argv vector. It centralizes the serialization-and-push pattern for optional structured arguments.

**Data flow**: Takes mutable `args: &mut Vec<String>`, `flag: &str`, and serializable `value: &T`, pushes `flag.to_string()`, serializes `value` with `serde_json::to_string`, pushes the resulting JSON string, and panics with a flag-specific message if serialization fails.

**Call relations**: Called only by `create_windows_sandbox_command_args_for_permission_profile` for read roots, write roots, and deny-path override flags.

*Call graph*: called by 1 (create_windows_sandbox_command_args_for_permission_profile); 1 external calls (to_string).


##### `run_windows_sandbox_wrapper_main`  (lines 121–141)

```
fn run_windows_sandbox_wrapper_main() -> !
```

**Purpose**: Acts as the process-level entrypoint for the wrapper mode. It builds a Tokio runtime, runs the async wrapper logic, prints failures to stderr, and terminates the process with the chosen exit code.

**Data flow**: Reads process arguments via `std::env::args()`, skips the executable path and wrapper selector argument, collects the remainder into `Vec<String>`, then attempts to build a current-thread Tokio runtime with all features enabled. If runtime creation fails it prints an error and exits with code 1. Otherwise it `block_on`s `run_windows_sandbox_wrapper_args(args)`, maps success to the returned exit code and failure to stderr plus exit code 1, then calls `std::process::exit(exit_code)`.

**Call relations**: This is the file's runtime entrypoint, invoked when the binary is launched in wrapper mode. It delegates all semantic work to `run_windows_sandbox_wrapper_args`.

*Call graph*: calls 1 internal fn (run_windows_sandbox_wrapper_args); 4 external calls (eprintln!, args, exit, new_current_thread).


##### `run_windows_sandbox_wrapper_args`  (lines 143–146)

```
async fn run_windows_sandbox_wrapper_args(args: Vec<String>) -> Result<i32>
```

**Purpose**: Parses wrapper argv into a structured request and executes it asynchronously. It is the narrow bridge between CLI parsing and sandbox session launch.

**Data flow**: Takes `args: Vec<String>`, calls `parse_windows_sandbox_wrapper_args(args)?` to obtain `WindowsSandboxWrapperRequest`, then awaits `run_windows_sandbox_wrapper_request(request)` and returns its `Result<i32>`.

**Call relations**: Called by `run_windows_sandbox_wrapper_main` inside the Tokio runtime. It sequences the two major phases: parse first, then launch.

*Call graph*: calls 2 internal fn (parse_windows_sandbox_wrapper_args, run_windows_sandbox_wrapper_request); called by 1 (run_windows_sandbox_wrapper_main).


##### `run_windows_sandbox_wrapper_request`  (lines 165–192)

```
async fn run_windows_sandbox_wrapper_request(request: WindowsSandboxWrapperRequest) -> Result<i32>
```

**Purpose**: Launches the parsed sandbox request and forwards stdio until the inner command exits. It converts the wrapper-specific request struct into the crate's broader sandbox session request type.

**Data flow**: Consumes `WindowsSandboxWrapperRequest`. It first checks `request.command.is_empty()` and returns an error if no inner command was supplied. Otherwise it constructs `crate::WindowsSandboxSessionRequest` using borrowed references for permission profile, workspace roots, codex home, cwd, and optional override slices, moves owned `command` and `env_map`, sets `timeout_ms` to `None`, `tty` to `false`, `stdin_open` to `true`, and `use_private_desktop` from the parsed flag, then awaits `spawn_windows_sandbox_session_for_level(...)`. It passes the spawned session to `forward_sandbox_session_stdio(...).await` and returns that exit code.

**Call relations**: Called only by `run_windows_sandbox_wrapper_args` after successful parsing. It delegates actual sandbox creation and stdio pumping to crate-level async functions.

*Call graph*: called by 1 (run_windows_sandbox_wrapper_args); 3 external calls (bail!, forward_sandbox_session_stdio, spawn_windows_sandbox_session_for_level).


##### `parse_windows_sandbox_wrapper_args`  (lines 194–292)

```
fn parse_windows_sandbox_wrapper_args(args: Vec<String>) -> Result<WindowsSandboxWrapperRequest>
```

**Purpose**: Parses the wrapper's flat argv protocol into a strongly typed `WindowsSandboxWrapperRequest` with validation and defaults. It enforces required flags, absolute-path constraints, JSON decoding, and `--` command separation.

**Data flow**: Consumes `args: Vec<String>` into an iterator and initializes mutable option/collection fields for every request component. It loops over arguments, matching each flag string: path flags consume the next token via `next_flag_value` and may pass through `absolute_path_arg` or `PathBuf::from`; JSON flags consume the next token and deserialize via `serde_json::from_str` or `json_flag_value`; sandbox level consumes the next token and parses via `parse_windows_sandbox_level`; boolean flags flip booleans; repeated workspace-root flags push onto a vector; `--` captures the remaining iterator into `command` and ends parsing; any unknown token causes `bail!`. After the loop it checks that `codex_home`, `command_cwd`, `env_map`, `permission_profile`, `windows_sandbox_level`, and `command` are present, verifies `codex_home.is_absolute()`, defaults `workspace_roots` to `[command_cwd.clone()]` when none were supplied, and returns the assembled `WindowsSandboxWrapperRequest`.

**Call relations**: Called by `run_windows_sandbox_wrapper_args` before any sandbox launch occurs. It relies on `next_flag_value`, `absolute_path_arg`, `json_flag_value`, and `parse_windows_sandbox_level` to keep individual parsing concerns small and reusable.

*Call graph*: calls 4 internal fn (absolute_path_arg, json_flag_value, next_flag_value, parse_windows_sandbox_level); called by 1 (run_windows_sandbox_wrapper_args); 4 external calls (from, new, bail!, from_str).


##### `next_flag_value`  (lines 294–297)

```
fn next_flag_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String>
```

**Purpose**: Fetches the required value token following a flag and errors if it is missing. It prevents repetitive end-of-iterator checks in the parser.

**Data flow**: Takes a mutable string iterator and `flag: &str`, calls `args.next()`, and returns the next string or an `anyhow` error of the form `missing value for {flag}`.

**Call relations**: Used repeatedly by `parse_windows_sandbox_wrapper_args` whenever a flag expects a following value.

*Call graph*: called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (next).


##### `absolute_path_arg`  (lines 299–303)

```
fn absolute_path_arg(value: String, flag: &str) -> Result<AbsolutePathBuf>
```

**Purpose**: Validates that a string argument is an absolute path and converts it into `AbsolutePathBuf`. It gives path-bearing flags a consistent error message.

**Data flow**: Takes `value: String` and `flag: &str`, converts the string to `PathBuf`, then calls `AbsolutePathBuf::from_absolute_path(path.as_path())`; on failure it adds context stating that the given flag must be absolute and includes the original display path.

**Call relations**: Called by `parse_windows_sandbox_wrapper_args` for `--command-cwd` and repeated `--workspace-root` values.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (from).


##### `json_flag_value`  (lines 305–307)

```
fn json_flag_value(value: String, flag: &str) -> Result<T>
```

**Purpose**: Deserializes a JSON-encoded flag value into the requested type with flag-specific context. It keeps JSON parsing errors tied to the originating CLI flag.

**Data flow**: Accepts `value: String` and `flag: &str`, calls `serde_json::from_str(&value)`, and returns the decoded `T` or an error annotated with `failed to parse {flag}`.

**Call relations**: Used by `parse_windows_sandbox_wrapper_args` for read/write root overrides and deny-path override lists.

*Call graph*: called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (from_str).


##### `parse_windows_sandbox_level`  (lines 309–316)

```
fn parse_windows_sandbox_level(value: &str) -> Result<WindowsSandboxLevel>
```

**Purpose**: Maps the textual sandbox level flag value to the `WindowsSandboxLevel` enum. It accepts only the wrapper protocol's three supported spellings.

**Data flow**: Takes `value: &str`, matches `"disabled"`, `"restricted-token"`, and `"elevated"` to the corresponding enum variants, and otherwise returns a `bail!` error naming the invalid value.

**Call relations**: Called by `parse_windows_sandbox_wrapper_args` when handling `--windows-sandbox-level`.

*Call graph*: called by 1 (parse_windows_sandbox_wrapper_args); 1 external calls (bail!).
