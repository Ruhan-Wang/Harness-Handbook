# Config layer ingestion and requirements composition  `stage-4.1`

This stage is the system’s configuration assembly shop. It runs after raw config files and managed inputs are available, but before the rest of the program starts relying on them. Its job is to turn many possible sources of settings and rules into one checked, trustworthy result.

The core config loading part reads TOML files (a human-friendly config file format), cloud or managed inputs, profiles, thread settings, and command-line overrides. It knows what valid settings should look like, merges layers in priority order, remembers where each value came from, and produces clear errors with file and line numbers when something is wrong. It can also freeze the final result as a snapshot.

The requirements composition part does the same kind of work for requirement rules and execution policies. It standardizes messy input, combines special fields like permissions and hooks carefully, and builds the final rule stack that runtime code will enforce.

The management services part lets other parts of the app read, edit, and save settings safely.

config/src/lib.rs is the front desk for all of this: one public entry point that re-exports the loaders, schemas, diagnostics, and editing tools.

## Sub-stages

- [Core config schemas, diagnostics, merge, and layered loading](stage-4.1.1.md) `stage-4.1.1` — 22 files
- [Requirements layering and execution-policy composition](stage-4.1.2.md) `stage-4.1.2` — 11 files
- [Configuration management services and editable persistence surfaces](stage-4.1.3.md) `stage-4.1.3` — 8 files

## Files in this stage

### Config layer ingestion and requirements composition
### `config/src/lib.rs`

`orchestration` · `config load and cross-cutting configuration access`

This file is the root module for the configuration crate. It declares a large set of focused submodules covering layered config loading, cloud-provided config bundles, TOML schemas, requirement composition, diagnostics, merge behavior, plugin and marketplace edits, MCP server configuration, thread-scoped config, strict-field checking, and test support. Rather than implementing behavior directly, it assembles the crate's public interface by selectively `pub use`-ing concrete types and functions from those modules.

A key design choice is that this root exposes both low-level schema/data types such as `ConfigProfile`, `HooksToml`, `McpServerConfig`, and `RequirementsExecPolicyToml`, and higher-level orchestration pieces such as `CloudConfigBundleLoader`, `compose_requirements`, `build_cli_overrides_layer`, and thread config loaders. It also re-exports external types that are part of the crate's API contract, including `ConfigLayerSource`, `ProfileV2Name`, `AbsolutePathBuf`, and `toml::Value` as `TomlValue`. The lone constant, `CONFIG_TOML_FILE`, standardizes the expected filename `config.toml` across loaders and editors. In effect, this file defines the subsystem boundary: consumers rely on these exports instead of reaching into internal modules, which preserves encapsulation while keeping the crate ergonomically accessible.
