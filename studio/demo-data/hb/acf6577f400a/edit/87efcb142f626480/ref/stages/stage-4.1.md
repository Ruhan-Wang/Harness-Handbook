# Config layer ingestion and requirements composition  `stage-4.1`

This stage is the system’s configuration assembly line. It runs in shared support, before the main work can rely on settings and rules. Its job is to gather configuration from files and managed sources, combine those layers in priority order, and turn them into one checked result the rest of the app can trust.

The core schema, diagnostics, merge, and loading part defines what valid config looks like, reads it from places like disk, cloud, projects, and per-thread settings, then merges it while remembering where each value came from. It also gives precise errors when something is misspelled, the wrong type, or not allowed.

The requirements and execution-policy part does the same for rule files: it reads layered requirements, combines permissions, hooks, and policy rules with special merge behavior, and builds the final rule stack. It also enforces trust gates, meaning only approved sources may set sensitive options.

The management services part lets other parts of the app read, edit, migrate, and save config safely. `config/src/lib.rs` is the front desk for all of this, exposing one public entry point so other crates can use the whole configuration system consistently.

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
