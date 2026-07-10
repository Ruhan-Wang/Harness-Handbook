# Build scripts and build-time asset/platform glue  `stage-22.6`

This stage is behind-the-scenes build support. It runs while the project is being compiled, before the program starts, and makes sure each platform gets the extra pieces it needs. You can think of it as the packing and labeling step before shipping.

The `bwrap/build.rs` script prepares Linux sandbox support. If the target is Linux, it can compile the bundled Bubblewrap C code into a static library, meaning native code packed directly into the final binary. It also tells Cargo, Rust’s build tool, when to rebuild, where to find the compiled library, and sets a flag so the Rust code knows Bubblewrap is available.

The `windows-sandbox-rs/build.rs` script prepares Windows-specific metadata. It embeds a manifest, a small file that tells Windows how the helper program should run, but only when the compiler toolchain supports that feature.

The `cli/build.rs` script adds a special macOS linker option so the final CLI binary includes Objective-C pieces correctly.

The `skills/build.rs` script watches embedded sample assets. If anything under `src/assets/samples` changes, it forces a rebuild so the bundled assets stay up to date.

## Files in this stage

### Native component builds
These build scripts prepare platform-specific native pieces by compiling vendored code and embedding Windows metadata when supported.

### `bwrap/build.rs`

`orchestration` · `build time`

This build script runs during Cargo build planning for the `bwrap` crate. `main` first emits `cargo:` directives so Cargo knows which environment variables and source files should trigger a rebuild. It computes the vendored source directory relative to `CARGO_MANIFEST_DIR`, registers the four bubblewrap C files as watched inputs, and then exits early unless the target OS is Linux and `CODEX_SKIP_BWRAP_BUILD` is unset.

When a Linux build is allowed, `try_build_bwrap` performs the actual native compilation. It reads `CARGO_MANIFEST_DIR` and `OUT_DIR`, resolves the source tree either from `CODEX_BWRAP_SOURCE_DIR` or the vendored checkout, and probes `libcap` through `pkg-config`. It writes a minimal generated `config.h` into `OUT_DIR`, configures `cc::Build` with the four source files, include directories, `_GNU_SOURCE`, and a `main` rename to `bwrap_main` so Rust can provide the executable entrypoint. A notable design choice is adding libcap include directories with `-idirafter`, allowing target sysroot headers to win during cross-compilation while still finding host-provided libcap headers. After compilation it emits native link-search and link-lib directives for libcap and sets `cargo:rustc-cfg=bwrap_available`. `resolve_bwrap_source_dir` enforces the source lookup priority and returns explicit, actionable error messages when neither an override nor the vendored tree exists.

#### Function details

##### `main`  (lines 5–30)

```
fn main()
```

**Purpose**: Coordinates the build-script workflow: declare rebuild triggers, detect whether bubblewrap should be built, and invoke the native compilation step for supported targets. It is the Cargo-facing entrypoint for this crate’s build-time logic.

**Data flow**: It reads environment variables such as `CARGO_MANIFEST_DIR`, `CARGO_CFG_TARGET_OS`, and `CODEX_SKIP_BWRAP_BUILD`; constructs `manifest_dir` and `vendor_dir`; prints multiple `cargo:` directives for cfg checking, env tracking, and source-file tracking; then conditionally calls `try_build_bwrap()`. If compilation fails, it panics with the returned error string; otherwise it returns normally.

**Call relations**: Cargo invokes this script before compiling the crate. On Linux builds that are not explicitly skipped, it delegates all native compilation details to `try_build_bwrap`; on other targets or skipped builds, it exits without attempting compilation.

*Call graph*: calls 1 internal fn (try_build_bwrap); 5 external calls (from, var, var_os, panic!, println!).


##### `try_build_bwrap`  (lines 32–77)

```
fn try_build_bwrap() -> Result<(), String>
```

**Purpose**: Builds the vendored or externally supplied bubblewrap sources into a Cargo-linked native library and emits the cfg/link metadata needed by the Rust crate. It encapsulates all fallible build steps behind a `Result<(), String>`.

**Data flow**: It reads `CARGO_MANIFEST_DIR` and `OUT_DIR`, resolves the source directory via `resolve_bwrap_source_dir`, probes `libcap` with `pkg_config`, writes `config.h` into `OUT_DIR`, configures a `cc::Build` with four C source files, include paths, `_GNU_SOURCE`, and `main=bwrap_main`, then adds `-idirafter...` flags for each libcap include path. After `build.compile("standalone_bwrap")`, it prints Cargo link-search directives for each libcap link path, prints `cargo:rustc-link-lib` for each library, emits `cargo:rustc-cfg=bwrap_available`, and returns `Ok(())`; any failure is converted into a descriptive `String` error.

**Call relations**: Called only by `main` after target gating passes. It depends on `resolve_bwrap_source_dir` to locate sources and then performs the rest of the build pipeline itself.

*Call graph*: calls 1 internal fn (resolve_bwrap_source_dir); called by 1 (main); 7 external calls (from, new, new, var, format!, println!, write).


##### `resolve_bwrap_source_dir`  (lines 84–106)

```
fn resolve_bwrap_source_dir(manifest_dir: &Path) -> Result<PathBuf, String>
```

**Purpose**: Chooses the bubblewrap source tree to compile, preferring an explicit environment override and otherwise falling back to the vendored checkout. It validates existence and produces actionable error text when no usable source tree is found.

**Data flow**: It takes `manifest_dir: &Path`, reads `CODEX_BWRAP_SOURCE_DIR` if set, converts it to a `PathBuf`, and returns it if it exists; otherwise it returns an error naming the missing override path. If no override is set, it computes `manifest_dir.join("../vendor/bubblewrap")`, returns that path if it exists, or returns an error explaining the expected vendored location and how to override it.

**Call relations**: This helper is called by `try_build_bwrap` before any compilation work begins. Its result determines which source tree `cc::Build` compiles.

*Call graph*: called by 1 (try_build_bwrap); 4 external calls (join, from, var, format!).


### `windows-sandbox-rs/build.rs`

`orchestration` · `build time`

This build script exists solely to attach `codex-windows-sandbox-setup.manifest` to the `codex-windows-sandbox-setup` binary without leaking that resource metadata into every binary that links the library crate. It first emits `cargo:rerun-if-changed` for the manifest file so Cargo rebuilds when the manifest changes. It then exits immediately for non-Windows targets, making the script effectively inert on other platforms.

On Windows, it resolves `CARGO_MANIFEST_DIR`, joins it with the manifest filename, and formats the resulting path for linker arguments. The key control flow is a match on `CARGO_CFG_TARGET_ENV` and `CARGO_CFG_TARGET_ABI`: MSVC receives `/MANIFEST:EMBED` and `/MANIFESTINPUT:...` arguments, while the GNU+LLVM combination receives equivalent `-Wl,-Xlink=...` forms suitable for that linker stack. Any other environment/ABI combination is ignored rather than treated as an error. The script returns `Result<(), String>` so missing required environment like `CARGO_MANIFEST_DIR` becomes a readable build failure.

#### Function details

##### `main`  (lines 7–39)

```
fn main() -> Result<(), String>
```

**Purpose**: Configures Cargo linker arguments so the setup helper binary embeds its Windows manifest when the target platform and toolchain support it.

**Data flow**: Reads Cargo-provided environment variables including target OS, manifest directory, target environment, and target ABI. It prints Cargo directives to stdout: always a `rerun-if-changed` line, and on supported Windows toolchains one or two `rustc-link-arg-bin` lines scoped to `codex-windows-sandbox-setup`; it returns `Ok(())` on success or an error string if `CARGO_MANIFEST_DIR` is missing.

**Call relations**: This is the build-script entrypoint invoked by Cargo before compilation. Its only downstream effects are emitted build directives that alter linker behavior for the setup helper binary.

*Call graph*: 4 external calls (from, var, var_os, println!).


### Platform linker configuration
This build script adjusts linker behavior for macOS-specific CLI builds.

### `cli/build.rs`

`config` · `build time`

This build script runs during compilation, not at application runtime. Its entire job is to inspect Cargo's target OS environment via `CARGO_CFG_TARGET_OS` and, when the target is `macos`, emit `cargo:rustc-link-arg=-ObjC` on stdout. Cargo interprets that line as an instruction to pass `-ObjC` to the linker for the crate being built. The script does nothing for non-macOS targets, so Linux and Windows builds remain unaffected. The implementation is intentionally minimal and side-effect free beyond the printed directive. A subtle but important detail is that it checks the target OS rather than the host OS, so cross-compilation behavior follows the intended output platform.

#### Function details

##### `main`  (lines 1–5)

```
fn main()
```

**Purpose**: Evaluates the Cargo target OS and conditionally emits a linker flag for macOS builds. It is the sole entrypoint of the build script.

**Data flow**: The function reads `CARGO_CFG_TARGET_OS` from the environment with `std::env::var`, compares the borrowed string view to `Ok("macos")`, and if it matches prints `cargo:rustc-link-arg=-ObjC` to stdout. It returns unit and writes only the Cargo build-script directive when applicable.

**Call relations**: Cargo invokes this function automatically during compilation. It does not call into project code; its only delegated operations are environment lookup and the conditional `println!` that communicates with Cargo.

*Call graph*: 2 external calls (println!, var).


### Embedded asset tracking
This build script wires embedded sample assets into Cargo's change detection so rebuilds happen when the asset tree changes.

### `skills/build.rs`

`orchestration` · `startup`

This build script is intentionally small and filesystem-focused. `main` points at `src/assets/samples`, exits immediately if that directory does not exist, and otherwise emits a `cargo:rerun-if-changed=` line for the root directory before recursively walking it. The recursive walk is implemented by `visit_dir`, which calls `fs::read_dir`, ignores unreadable directories by returning early, and iterates entries with `flatten()` so individual unreadable entries are skipped rather than failing the build.

For every discovered path, the script prints another `cargo:rerun-if-changed=` directive. If the path is itself a directory, `visit_dir` recurses into it. The result is that Cargo watches both the top-level samples directory and every nested file and subdirectory beneath it. There is no code generation or file copying here; the script’s sole job is dependency tracking for the `include_dir!`-embedded assets used by the `skills` crate. The design deliberately favors resilience over strictness: missing sample assets or transient read errors simply suppress rerun registration for those paths instead of breaking the build.

#### Function details

##### `main`  (lines 4–12)

```
fn main()
```

**Purpose**: Entry point for the build script that registers the sample-assets tree with Cargo’s change detection. It only does work when the expected samples directory exists.

**Data flow**: It constructs `Path::new("src/assets/samples")`, checks `exists()`, returns early if absent, otherwise prints a `cargo:rerun-if-changed` line for that directory and calls `visit_dir` to recurse through descendants.

**Call relations**: As the build-script entrypoint, it drives the entire traversal and delegates recursive enumeration to `visit_dir`.

*Call graph*: calls 1 internal fn (visit_dir); 2 external calls (new, println!).


##### `visit_dir`  (lines 14–27)

```
fn visit_dir(dir: &Path)
```

**Purpose**: Recursively walks a directory tree and emits Cargo rerun directives for every encountered path. It tolerates unreadable directories and entries instead of failing.

**Data flow**: It takes a `&Path`, attempts `fs::read_dir`, returns immediately on error, iterates successful entries via `flatten()`, obtains each entry’s path, prints `cargo:rerun-if-changed` for that path, and recursively calls itself for subdirectories.

**Call relations**: It is called from `main` on the root samples directory and then recursively on nested directories to cover the full asset tree.

*Call graph*: called by 1 (main); 2 external calls (read_dir, println!).
