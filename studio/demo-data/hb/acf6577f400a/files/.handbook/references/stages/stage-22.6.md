# Build scripts and build-time asset/platform glue  `stage-22.6`

This stage runs before the main program is built. It is behind-the-scenes setup for Cargo, Rust’s build tool, so the final binaries are assembled correctly on each platform and stay up to date when bundled files change. The Bubblewrap build script prepares a Linux sandbox helper: it checks whether Bubblewrap can be built, compiles its C source code when appropriate, and tells Cargo how to link that compiled code into the Rust crate. The Windows sandbox build script does a similar kind of platform glue for Windows, but instead of compiling code it attaches an application manifest, a small settings file Windows reads to know how the helper should run. The CLI build script adds a special macOS linker option so code that depends on Objective-C-related system pieces can link cleanly. The skills build script watches sample asset folders and tells Cargo to rebuild if those files change. Together, these scripts act like workshop notes for the compiler, adjusting the build for each operating system and for bundled assets.

## Files in this stage

### Native component builds
These build scripts prepare platform-specific native pieces by compiling vendored code and embedding Windows metadata when supported.

### `bwrap/build.rs`

`orchestration` · `build time`

This file runs before the Rust crate itself is compiled. Its job is to make the Bubblewrap sandbox code available as part of the build, but only when that makes sense. Bubblewrap is a Linux tool for running programs in a restricted environment, like putting a process in a temporary locked room with only the doors and shelves it is allowed to use.

First, the script tells Cargo which environment variables and source files should cause a rebuild if they change. That keeps builds honest: if the Bubblewrap source location, package-config paths, or skip flag changes, Cargo knows it should run this script again.

Then it checks the target operating system. If the target is not Linux, or if `CODEX_SKIP_BWRAP_BUILD` is set, it stops early. This avoids trying to build a Linux-only sandbox on other platforms.

On Linux, it locates the Bubblewrap C source, either from `CODEX_BWRAP_SOURCE_DIR` or from the vendored copy in the repository. It checks for `libcap`, a system library used for Linux process capabilities, through `pkg-config` (a tool that tells builds where libraries and headers live). It writes a tiny `config.h`, compiles several C files into a static library, links the needed `libcap` libraries, and finally enables the Rust conditional flag `bwrap_available` so the rest of the crate can know Bubblewrap support exists.

#### Function details

##### `main`  (lines 5–30)

```
fn main()
```

**Purpose**: This is the entry point for the build script. It tells Cargo what changes should rerun the script, skips unsupported builds, and starts the Bubblewrap compilation when the target is Linux.

**Data flow**: It reads environment values such as the crate directory, target operating system, and skip flag. It prints instructions for Cargo, checks whether the build should continue, and either exits quietly or asks `try_build_bwrap` to compile Bubblewrap. If that compilation reports an error, it turns the error into a build failure.

**Call relations**: Cargo calls `main` automatically before compiling the crate. `main` does the broad decision-making, then hands the detailed Linux build work to `try_build_bwrap`. If `try_build_bwrap` cannot finish, `main` stops the whole build with a clear failure message.

*Call graph*: calls 1 internal fn (try_build_bwrap); 5 external calls (from, var, var_os, panic!, println!).


##### `try_build_bwrap`  (lines 32–77)

```
fn try_build_bwrap() -> Result<(), String>
```

**Purpose**: This function does the actual work of compiling Bubblewrap's C code and telling Cargo how to link it. It is used when the build target is Linux and Bubblewrap has not been explicitly skipped.

**Data flow**: It reads Cargo's manifest and output directories, finds the Bubblewrap source directory, asks `pkg-config` where `libcap` is installed, writes a small generated `config.h` file, and configures the C compiler with source files, include paths, and compile definitions. After compiling a library named `standalone_bwrap`, it prints Cargo link instructions and enables the `bwrap_available` build flag. It returns success if all of this works, or a readable error string if something is missing or cannot be written.

**Call relations**: `main` calls this after deciding that a Linux Bubblewrap build should happen. Inside, it calls `resolve_bwrap_source_dir` to find the C source tree before setting up the compiler. Its printed Cargo instructions are picked up by Cargo and affect how the Rust crate is compiled and linked.

*Call graph*: calls 1 internal fn (resolve_bwrap_source_dir); called by 1 (main); 7 external calls (from, new, new, var, format!, println!, write).


##### `resolve_bwrap_source_dir`  (lines 84–106)

```
fn resolve_bwrap_source_dir(manifest_dir: &Path) -> Result<PathBuf, String>
```

**Purpose**: This function chooses where the Bubblewrap source code should come from. It lets developers override the source location with an environment variable, while falling back to the vendored copy in the repository.

**Data flow**: It receives the crate's manifest directory. It first checks `CODEX_BWRAP_SOURCE_DIR`; if that variable points to an existing directory, it returns that path, and if it points nowhere, it returns an error. If no override is set, it looks for `../vendor/bubblewrap` relative to the crate. It returns that path if it exists, otherwise it returns an error explaining how to fix the missing source.

**Call relations**: `try_build_bwrap` calls this before compiling anything, because the compiler needs to know where the Bubblewrap C files are. This function acts like a source-code locator: it decides between a developer-provided checkout and the repository's bundled copy, then hands the chosen path back to the build step.

*Call graph*: called by 1 (try_build_bwrap); 4 external calls (join, from, var, format!).


### `windows-sandbox-rs/build.rs`

`config` · `build time`

This file runs during compilation, before the final program is linked together. Its job is to make sure the special setup helper binary, `codex-windows-sandbox-setup`, gets the right Windows manifest embedded into it. A manifest is a small metadata file Windows reads to understand how a program should run, for example what privileges or compatibility settings it needs.

The script first tells Cargo to rerun the build script if the manifest file changes. That is like putting a sticky note on the manifest saying, “if this changes, rebuild the thing that depends on it.”

If the target operating system is not Windows, the script exits immediately because the manifest is only meaningful there. On Windows builds, it finds the crate’s folder, builds the full path to `codex-windows-sandbox-setup.manifest`, and then prints special Cargo instructions. Cargo reads lines beginning with `cargo:` as build directions.

The exact linker instructions differ depending on the Windows toolchain. Microsoft’s MSVC linker and the GNU/LLVM linker spell the manifest options differently, so the script chooses the right wording. Importantly, it scopes these instructions only to the setup helper binary, so other Codex binaries that use this library do not accidentally inherit the same Windows resource metadata.

#### Function details

##### `main`  (lines 7–39)

```
fn main() -> Result<(), String>
```

**Purpose**: Runs as Cargo’s build script entry point and emits build instructions for embedding the Windows manifest into the setup helper executable. It does nothing for non-Windows targets.

**Data flow**: It reads environment variables that Cargo provides, such as the target operating system, target toolchain, and crate directory. From those values it decides whether a manifest is needed, builds the manifest file path, and prints Cargo directives to standard output. The result is either success with no changes for non-Windows builds, success after printing linker instructions for supported Windows toolchains, or an error if Cargo did not provide the crate directory.

**Call relations**: Cargo calls this function automatically while building the crate. The function asks the standard environment APIs for build settings and uses printed `cargo:` lines to hand instructions back to Cargo. Cargo then passes those instructions to the linker when building only the `codex-windows-sandbox-setup` binary.

*Call graph*: 4 external calls (from, var, var_os, println!).


### Platform linker configuration
This build script adjusts linker behavior for macOS-specific CLI builds.

### `cli/build.rs`

`config` · `build time`

This file runs during the build, before the main command-line program is compiled and linked. Its job is very narrow: it asks Cargo, Rust’s build tool, what operating system the program is being built for. If the answer is macOS, it prints a special instruction back to Cargo: pass the `-ObjC` flag to the Rust compiler’s linker step.

A linker is the tool that stitches compiled pieces of code and libraries into the final executable. On macOS, some libraries use Objective-C, a language and runtime commonly used by Apple frameworks. The `-ObjC` option tells the linker to pull in Objective-C categories and related code that might otherwise be skipped. Without this, a macOS build could compile successfully but fail later with missing behavior or unresolved symbols when Apple or Objective-C-based libraries are involved.

For non-macOS targets, the script does nothing. Think of it like adding a special shipping label only when the package is going to one country; everywhere else, the normal process is left alone.

#### Function details

##### `main`  (lines 1–5)

```
fn main()
```

**Purpose**: This build-script entry point checks whether the current build target is macOS. If it is, it tells Cargo to add the `-ObjC` linker argument so macOS Objective-C code is linked correctly.

**Data flow**: It reads the `CARGO_CFG_TARGET_OS` environment variable, which Cargo sets to describe the target operating system. If that value is exactly `macos`, it prints a Cargo instruction to standard output. Cargo reads that printed line and changes the later compiler/linker command; otherwise, nothing is changed.

**Call relations**: Cargo runs this `main` function automatically as part of the build process. Inside it, the function asks the environment for the target operating system and, only for macOS, hands a linker instruction back to Cargo by printing it in Cargo’s expected format.

*Call graph*: 2 external calls (println!, var).


### Embedded asset tracking
This build script wires embedded sample assets into Cargo's change detection so rebuilds happen when the asset tree changes.

### `skills/build.rs`

`orchestration` · `build time`

Rust projects can include a small build script that runs before the main code is compiled. This file's job is to keep Cargo, the Rust build tool, aware of sample files stored under `src/assets/samples`. Without it, changing one of those sample files might not cause Cargo to rebuild, so the program could keep using stale embedded or generated content.

The script first checks whether the samples folder exists. If it does not, it quietly stops, which makes the build safe for setups where those assets are absent. If the folder does exist, it prints special `cargo:rerun-if-changed=...` lines. Cargo reads these lines as instructions: “run this build script again if this path changes.”

It starts with the top-level samples folder, then walks through every file and nested folder underneath it. This is like giving Cargo not just the address of a filing cabinet, but also every drawer and document inside, so it knows exactly what to watch. If a directory cannot be read, the script skips it instead of failing the whole build.

#### Function details

##### `main`  (lines 4–12)

```
fn main()
```

**Purpose**: This is the entry point of the build script. It decides whether the samples folder exists and, if so, starts telling Cargo to watch it for changes.

**Data flow**: It begins with the fixed path `src/assets/samples`. If that path is missing, nothing else happens. If it exists, the function prints a Cargo instruction for that folder, then passes the folder path to `visit_dir` so every file and subfolder can also be registered for change tracking.

**Call relations**: Cargo runs `main` automatically before compiling the crate. `main` sets up the first watch instruction, then hands the deeper folder-walking work to `visit_dir`.

*Call graph*: calls 1 internal fn (visit_dir); 2 external calls (new, println!).


##### `visit_dir`  (lines 14–27)

```
fn visit_dir(dir: &Path)
```

**Purpose**: This function walks through a folder and tells Cargo to rerun the build script if anything inside that folder changes. It also goes into nested folders so the watch list covers the whole sample tree.

**Data flow**: It receives a directory path. It tries to read the directory's contents; if that fails, it returns without making noise. For each readable entry, it prints a Cargo watch instruction for that path. If an entry is itself a directory, it repeats the same process inside that directory.

**Call relations**: It is called by `main` after the top-level samples folder has been found. From there, it continues recursively, meaning each folder can call `visit_dir` again for its own subfolders until all reachable sample paths have been announced to Cargo.

*Call graph*: called by 1 (main); 2 external calls (read_dir, println!).
