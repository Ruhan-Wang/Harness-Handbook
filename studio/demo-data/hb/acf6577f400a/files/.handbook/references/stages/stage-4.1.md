# Config layer ingestion and requirements composition  `stage-4.1`

This stage is the startup-time configuration assembly point that turns raw settings and policy inputs into the effective, source-aware configuration and requirements stack used by the rest of the system. It sits between low-level file/source ingestion and higher-level services that read, edit, or enforce configuration at runtime.

Its first part, core config schemas, diagnostics, merge, and layered loading, defines the shapes of supported config files, reads local, managed, cloud, project, thread, and runtime layers, merges them by precedence, applies trust and path rules, and produces strict diagnostics with provenance. On top of that, requirements layering and execution-policy composition loads `requirements.toml` layers and embedded execution-policy sections, applies specialized merge rules for permissions, hooks, and prefix rules, and builds the final requirements/policy object with source tracking and trusted constraints. Configuration management services and editable persistence surfaces then expose that effective state through APIs, support validated user-layer edits, and maintain auxiliary editable settings. `config/src/lib.rs` ties these pieces together as the crate’s public entry point, re-exporting loaders, schemas, diagnostics, and editing utilities for other crates.

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
