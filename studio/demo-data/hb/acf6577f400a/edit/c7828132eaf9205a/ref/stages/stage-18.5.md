# API annotation macros and compile-time contract support  `stage-18.5`

This stage is behind-the-scenes support. It does not do the program’s main work at runtime. Instead, it helps shape the code while the project is being compiled, so the rest of the system can follow shared API rules in a consistent way.

Its one part, codex-experimental-api-macros/src/lib.rs, defines a procedural macro. A procedural macro is a code generator that runs during compilation: you write a simple annotation in source code, and the compiler expands it into extra Rust code for you. Here, the #[derive(ExperimentalApi)] macro is used on types that contain experimental features.

When a developer marks a type this way, the macro creates two kinds of support code. First, it generates runtime checks, so the program can notice when someone tries to use a field or enum choice that is still experimental. Second, it adds inventory registrations, meaning it records these experimental pieces in a shared catalog the program can inspect later. In effect, this stage is like a stamp-and-log system: it labels experimental parts and makes sure they are tracked everywhere automatically.

## Files in this stage

### API annotation macros and compile-time contract support
### `codex-experimental-api-macros/src/lib.rs`

`generated` · `compile time during macro expansion`

This proc-macro crate inspects structs and enums annotated with `#[derive(ExperimentalApi)]` and emits implementations of `crate::experimental_api::ExperimentalApi`. The derive entrypoint parses a `syn::DeriveInput` and dispatches by data kind: structs and enums are supported, while unions produce a compile error. For structs, `derive_for_struct` walks fields and distinguishes two attribute forms on `#[experimental(...)]`: a string literal reason marks the field itself as experimental, while `nested` means the field’s own `ExperimentalApi::experimental_reason` should be consulted recursively.

Generated code is concrete and type-sensitive. For directly experimental fields, the macro emits presence checks rather than unconditional triggers: `Option<T>` fields are experimental only when `is_some()`, `Vec`/`HashMap`/`BTreeMap` fields only when non-empty, `bool` fields only when true, and all other field types count as present unconditionally. Named fields also get camelCase serialized names via `snake_to_camel`, and the macro emits both a `pub(crate) const EXPERIMENTAL_FIELDS` slice and `inventory::submit!` registrations containing `type_name`, `field_name`, and `reason`. Tuple structs use numeric field names as strings. For enums, the generated implementation simply matches variants and returns the variant-level experimental reason if present; it does not inspect nested fields. The helper functions are mostly small `syn` analyzers that recognize attribute shapes and classify types by their last path segment.

#### Function details

##### `derive_experimental_api`  (lines 17–28)

```
fn derive_experimental_api(input: TokenStream) -> TokenStream
```

**Purpose**: Entry point for the derive macro that parses the input item and dispatches to struct or enum code generation.

**Data flow**: Takes the compiler-provided `proc_macro::TokenStream`, parses it as `syn::DeriveInput`, matches `input.data`, and returns generated tokens from `derive_for_struct` or `derive_for_enum`. For unions it constructs a `syn::Error` tied to `input.ident` and returns its compile-error tokens.

**Call relations**: This is the only exported macro function. It delegates all real generation work to the struct/enum-specific helpers.

*Call graph*: calls 2 internal fn (derive_for_enum, derive_for_struct); 2 external calls (new_spanned, parse_macro_input!).


##### `derive_for_struct`  (lines 30–158)

```
fn derive_for_struct(input: &DeriveInput, data: &DataStruct) -> TokenStream
```

**Purpose**: Generates `ExperimentalApi` logic, experimental field metadata, and inventory registrations for struct types.

**Data flow**: Reads the struct name and fields from `DeriveInput`/`DataStruct`, builds vectors of quoted token fragments for runtime checks, `EXPERIMENTAL_FIELDS` entries, and `inventory::submit!` registrations. For each field it either extracts a literal reason with `experimental_reason`, computes a presence expression with `experimental_presence_expr` or `index_presence_expr`, or emits nested recursive checks when `has_nested_experimental` is true. It then assembles an impl block containing the const slice and an `ExperimentalApi` impl returning the first matching reason or `None`, and returns the expanded `TokenStream`.

**Call relations**: Called only from `derive_experimental_api` for struct inputs. It relies on most of the helper functions in this file to interpret attributes, names, and field types.

*Call graph*: calls 5 internal fn (experimental_presence_expr, experimental_reason, field_serialized_name, has_nested_experimental, index_presence_expr); called by 1 (derive_experimental_api); 5 external calls (new, call_site, new, quote!, from).


##### `derive_for_enum`  (lines 160–193)

```
fn derive_for_enum(input: &DeriveInput, data: &DataEnum) -> TokenStream
```

**Purpose**: Generates an `ExperimentalApi` implementation for enums based on variant-level `#[experimental("...")]` attributes.

**Data flow**: Reads the enum name and variants, constructs a match arm for each variant pattern (`named`, `unnamed`, or `unit`), uses `experimental_reason` to decide whether that arm returns `Some(reason)` or `None`, wraps the arms in an impl of `ExperimentalApi::experimental_reason`, and returns the generated tokens.

**Call relations**: Called only from `derive_experimental_api` for enum inputs. Unlike struct generation, it does not recurse into fields.

*Call graph*: calls 1 internal fn (experimental_reason); called by 1 (derive_experimental_api); 2 external calls (new, quote!).


##### `experimental_reason`  (lines 195–197)

```
fn experimental_reason(attrs: &[Attribute]) -> Option<LitStr>
```

**Purpose**: Finds the first `#[experimental("reason")]` attribute in an attribute list and returns its string literal.

**Data flow**: Iterates over `attrs`, applies `experimental_reason_attr` to each, and returns the first `Some(LitStr)` found or `None`.

**Call relations**: Used by both struct and enum generation to detect directly experimental fields or variants.

*Call graph*: called by 2 (derive_for_enum, derive_for_struct); 1 external calls (iter).


##### `experimental_reason_attr`  (lines 199–205)

```
fn experimental_reason_attr(attr: &Attribute) -> Option<LitStr>
```

**Purpose**: Parses a single attribute as an experimental reason string if it has the expected path and literal argument.

**Data flow**: Checks whether `attr.path().is_ident("experimental")`; if not, returns `None`. Otherwise it attempts `attr.parse_args::<LitStr>().ok()` and returns the parsed literal on success.

**Call relations**: This is the per-attribute parser used indirectly by `experimental_reason`.

*Call graph*: 1 external calls (path).


##### `has_nested_experimental`  (lines 207–209)

```
fn has_nested_experimental(field: &Field) -> bool
```

**Purpose**: Detects whether a field is marked with `#[experimental(nested)]` for recursive experimental checks.

**Data flow**: Iterates over `field.attrs` and returns true if any attribute satisfies `experimental_nested_attr`, otherwise false.

**Call relations**: Used by `derive_for_struct` when a field is not directly experimental but should delegate to its nested type’s `ExperimentalApi` implementation.

*Call graph*: called by 1 (derive_for_struct).


##### `experimental_nested_attr`  (lines 211–218)

```
fn experimental_nested_attr(attr: &Attribute) -> bool
```

**Purpose**: Recognizes the specific attribute form `#[experimental(nested)]`.

**Data flow**: Checks the attribute path for `experimental`; if it matches, parses the arguments as an `Ident` and returns true only when that identifier equals `nested`.

**Call relations**: This is the predicate behind `has_nested_experimental`.

*Call graph*: 1 external calls (path).


##### `field_serialized_name`  (lines 220–224)

```
fn field_serialized_name(field: &Field) -> Option<String>
```

**Purpose**: Computes the serialized field name used in generated metadata for named struct fields.

**Data flow**: Reads `field.ident`, converts it to a string, transforms that snake_case name with `snake_to_camel`, and returns `Some(String)`; unnamed fields yield `None`.

**Call relations**: Used by `derive_for_struct` when generating `ExperimentalField` metadata and inventory registrations for named fields.

*Call graph*: calls 1 internal fn (snake_to_camel); called by 1 (derive_for_struct).


##### `snake_to_camel`  (lines 226–242)

```
fn snake_to_camel(s: &str) -> String
```

**Purpose**: Converts a snake_case identifier into lowerCamelCase for metadata emission.

**Data flow**: Allocates an output string with the input length as capacity, iterates characters, drops underscores while uppercasing the following character, and returns the transformed string.

**Call relations**: Called only by `field_serialized_name` to align generated field metadata with serialized naming conventions.

*Call graph*: called by 1 (field_serialized_name); 1 external calls (with_capacity).


##### `experimental_presence_expr`  (lines 244–253)

```
fn experimental_presence_expr(
    field: &Field,
    tuple_struct: bool,
) -> Option<proc_macro2::TokenStream>
```

**Purpose**: Builds a token expression that tests whether a named struct field is meaningfully present for experimental detection.

**Data flow**: Takes a `Field` and a `tuple_struct` flag; returns `None` immediately for tuple-struct mode, otherwise reads the field identifier and passes `quote!(self.#ident)` plus the field type into `presence_expr_for_access`, returning the resulting token stream.

**Call relations**: Used by `derive_for_struct` for directly experimental named fields so the generated runtime check only triggers when the field is actually set/non-empty/true.

*Call graph*: calls 1 internal fn (presence_expr_for_access); called by 1 (derive_for_struct); 1 external calls (quote!).


##### `index_presence_expr`  (lines 255–258)

```
fn index_presence_expr(index: usize, ty: &Type) -> proc_macro2::TokenStream
```

**Purpose**: Builds a token expression that tests presence for a tuple-struct field by numeric index.

**Data flow**: Converts the numeric `index` into `syn::Index`, forms `quote!(self.#index)`, passes that and the field type to `presence_expr_for_access`, and returns the resulting token stream.

**Call relations**: Used by `derive_for_struct` when generating checks for directly experimental unnamed fields.

*Call graph*: calls 1 internal fn (presence_expr_for_access); called by 1 (derive_for_struct); 2 external calls (quote!, from).


##### `presence_expr_for_access`  (lines 260–274)

```
fn presence_expr_for_access(
    access: proc_macro2::TokenStream,
    ty: &Type,
) -> proc_macro2::TokenStream
```

**Purpose**: Chooses the runtime presence test to generate for a field access based on its Rust type.

**Data flow**: Takes a quoted field access expression and a `syn::Type`. If `option_inner(ty)` succeeds it returns tokens for `.is_some()`. If the type is vec-like or map-like it returns tokens for `!is_empty()`. If it is bool it returns the access expression itself. Otherwise it returns `true`.

**Call relations**: This helper centralizes the macro’s notion of when an experimental field should count as active, and is used by both named-field and tuple-field generation.

*Call graph*: calls 4 internal fn (is_bool, is_map_like, is_vec_like, option_inner); called by 2 (experimental_presence_expr, index_presence_expr); 1 external calls (quote!).


##### `option_inner`  (lines 276–291)

```
fn option_inner(ty: &Type) -> Option<&Type>
```

**Purpose**: Detects whether a type is `Option<...>` and extracts the inner type if so.

**Data flow**: Pattern-matches the `Type` as `Type::Path`, inspects the last path segment for identifier `Option`, requires angle-bracketed generic arguments, and returns the first generic argument that is a type.

**Call relations**: Used only by `presence_expr_for_access` to generate `.is_some()` checks for optional fields.

*Call graph*: called by 1 (presence_expr_for_access).


##### `is_vec_like`  (lines 293–295)

```
fn is_vec_like(ty: &Type) -> bool
```

**Purpose**: Classifies a type as vector-like when its last path segment is `Vec`.

**Data flow**: Calls `type_last_ident(ty)` and returns true when the identifier equals `Vec`.

**Call relations**: Used by `presence_expr_for_access` to generate non-empty checks.

*Call graph*: calls 1 internal fn (type_last_ident); called by 1 (presence_expr_for_access).


##### `is_map_like`  (lines 297–299)

```
fn is_map_like(ty: &Type) -> bool
```

**Purpose**: Classifies a type as map-like when its last path segment is `HashMap` or `BTreeMap`.

**Data flow**: Calls `type_last_ident(ty)` and returns true when the identifier matches either supported map type.

**Call relations**: Used by `presence_expr_for_access` to generate non-empty checks for map fields.

*Call graph*: calls 1 internal fn (type_last_ident); called by 1 (presence_expr_for_access).


##### `is_bool`  (lines 301–303)

```
fn is_bool(ty: &Type) -> bool
```

**Purpose**: Classifies a type as `bool` for direct truthiness checks in generated code.

**Data flow**: Calls `type_last_ident(ty)` and returns true when the identifier equals `bool`.

**Call relations**: Used by `presence_expr_for_access` so boolean experimental fields only trigger when true.

*Call graph*: calls 1 internal fn (type_last_ident); called by 1 (presence_expr_for_access).


##### `type_last_ident`  (lines 305–310)

```
fn type_last_ident(ty: &Type) -> Option<Ident>
```

**Purpose**: Extracts the final path-segment identifier from a `syn::Type::Path`.

**Data flow**: Pattern-matches the type as `Type::Path`, reads the last segment of the path, clones its `Ident`, and returns `Option<Ident>`.

**Call relations**: This is the low-level type classifier used by `is_vec_like`, `is_map_like`, and `is_bool`.

*Call graph*: called by 3 (is_bool, is_map_like, is_vec_like).
