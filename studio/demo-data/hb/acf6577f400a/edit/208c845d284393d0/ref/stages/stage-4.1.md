# Config layer ingestion and requirements composition  `stage-4.1`

This stage is the system’s configuration assembly line. It runs mostly behind the scenes during startup, before the main work begins, and builds the final settings and rulebook that the rest of the app will trust.

One part focuses on ordinary configuration. It knows what valid config files should look like, reads them from different places such as user files, project files, managed sources, cloud sources, and command-line overrides, then merges them into one layered result. It also remembers where each value came from, produces clear error messages when something is wrong, and can save a normalized snapshot of the final config.

Another part does the same kind of work for requirements and execution policy. In plain terms, these are the extra rules that restrict what the app is allowed to do. It reads multiple requirement files, combines them in priority order, applies special merge rules for things like permissions, hooks, and proxy settings, and rejects forbidden combinations with source-aware errors.

Finally, config/src/lib.rs is the front door to all of this. It gathers the loaders, validators, editors, and data types into one public API so other parts of the codebase can use the finished configuration system from one place.

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
