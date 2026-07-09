# API annotation macros and compile-time contract support  `stage-18.5`

This stage is behind-the-scenes support that runs while the code is being built, not while the program is doing its main work. Its job is to help the project keep track of “experimental” API features, meaning parts of the interface that may still change and should be used with care.

The source file `codex-experimental-api-macros/src/lib.rs` defines a Rust derive macro. A derive macro is build-time code that writes repetitive code for developers automatically. Here, it lets a struct or enum learn how to say whether it contains any experimental API pieces. Instead of every developer manually writing the same checking logic, they can place small annotations on fields or enum variants. During compilation, the macro reads those annotations and generates the needed checking code.

In the larger system, this acts like a labeling machine on an assembly line. It marks API shapes consistently before the program ever runs.

## Files in this stage

### API annotation macros and compile-time contract support
### `codex-experimental-api-macros/src/lib.rs`

`domain_logic` · `compile time`

This file runs at compile time, not while the program is serving users. It is a code generator: when a type says it derives `ExperimentalApi`, this macro looks at that type and writes extra Rust code for it. The real problem it solves is consistency. If some request or data type contains an experimental option, the system needs a reliable way to notice that and explain why it is experimental. Without this macro, every struct and enum would need custom, repetitive code, and mistakes would be easy.

For structs, the macro checks each field. A field marked like `#[experimental("reason")]` becomes a trigger: if that field is actually present or set, the generated code returns that reason. Presence depends on the field type: an `Option` must be `Some`, a list or map must be non-empty, a `bool` must be true, and other types count as present. A field marked `#[experimental(nested)]` means “look inside this child value and ask it the same question.”

For enums, the macro checks which variant is being used. If the selected variant is marked experimental, it returns that variant’s reason.

The file also records experimental fields in an inventory so other parts of the program can discover and list them. Think of it like putting warning labels on parts of a machine, then generating both the alarm wiring and a catalog of all warning labels.

#### Function details

##### `derive_experimental_api`  (lines 17–28)

```
fn derive_experimental_api(input: TokenStream) -> TokenStream
```

**Purpose**: This is the public derive macro entry point. Rust calls it when it sees `#[derive(ExperimentalApi)]`, and it decides whether the annotated item is a struct, enum, or unsupported union.

**Data flow**: It receives raw Rust syntax from the compiler, parses it into a structured description of the type, then sends structs to the struct generator and enums to the enum generator. If the input is a union, it produces a compile-time error instead of generated code.

**Call relations**: This function starts the whole flow. It calls `derive_for_struct` or `derive_for_enum` for supported shapes, and uses Rust macro parsing and error reporting helpers when preparing the result for the compiler.

*Call graph*: calls 2 internal fn (derive_for_enum, derive_for_struct); 2 external calls (new_spanned, parse_macro_input!).


##### `derive_for_struct`  (lines 30–158)

```
fn derive_for_struct(input: &DeriveInput, data: &DataStruct) -> TokenStream
```

**Purpose**: This builds the generated code for a struct that wants to report experimental API usage. It inspects the struct’s fields and creates checks for fields that are directly experimental or contain nested experimental values.

**Data flow**: It takes the parsed struct name and fields. For each field, it reads attributes such as `#[experimental("reason")]` or `#[experimental(nested)]`, decides how to test whether the field is meaningfully set, and builds Rust code that returns the first matching reason. It also builds a static list and inventory registrations for directly experimental fields.

**Call relations**: It is called by `derive_experimental_api` when the input is a struct. It relies on helpers such as `experimental_reason`, `has_nested_experimental`, `experimental_presence_expr`, `index_presence_expr`, and `field_serialized_name` to understand attributes, field names, and presence checks before handing generated code back to the macro entry point.

*Call graph*: calls 5 internal fn (experimental_presence_expr, experimental_reason, field_serialized_name, has_nested_experimental, index_presence_expr); called by 1 (derive_experimental_api); 5 external calls (new, call_site, new, quote!, from).


##### `derive_for_enum`  (lines 160–193)

```
fn derive_for_enum(input: &DeriveInput, data: &DataEnum) -> TokenStream
```

**Purpose**: This builds the generated code for an enum that wants to report experimental API usage. Each enum variant becomes one branch in a generated `match` statement.

**Data flow**: It receives the parsed enum name and variants. For each variant, it checks whether the variant has an experimental reason, then writes a branch that returns that reason when the variant is selected, or `None` when it is not experimental.

**Call relations**: It is called by `derive_experimental_api` when the input is an enum. It uses `experimental_reason` to read variant attributes and then returns generated Rust code implementing the shared `ExperimentalApi` behavior.

*Call graph*: calls 1 internal fn (experimental_reason); called by 1 (derive_experimental_api); 2 external calls (new, quote!).


##### `experimental_reason`  (lines 195–197)

```
fn experimental_reason(attrs: &[Attribute]) -> Option<LitStr>
```

**Purpose**: This looks through a list of Rust attributes and finds the experimental reason, if one is present. It is the common reader for `#[experimental("...")]` markers.

**Data flow**: It receives all attributes attached to a field or enum variant. It scans them one by one and returns the first string reason it can parse from an `experimental` attribute, or `None` if there is no such reason.

**Call relations**: Both `derive_for_struct` and `derive_for_enum` call this when deciding whether a field or variant is directly experimental. It delegates the exact attribute check to `experimental_reason_attr` during the scan.

*Call graph*: called by 2 (derive_for_enum, derive_for_struct); 1 external calls (iter).


##### `experimental_reason_attr`  (lines 199–205)

```
fn experimental_reason_attr(attr: &Attribute) -> Option<LitStr>
```

**Purpose**: This checks one attribute to see whether it is an experimental reason attribute. It accepts only attributes named `experimental` whose contents are a string.

**Data flow**: It receives a single Rust attribute. If the attribute name is not `experimental`, it returns nothing. If it is `experimental`, it tries to parse the contents as a string literal and returns that string when parsing succeeds.

**Call relations**: It is used as the small per-attribute test behind `experimental_reason`. In the larger flow, it helps the struct and enum generators turn `#[experimental("reason")]` into generated runtime checks.

*Call graph*: 1 external calls (path).


##### `has_nested_experimental`  (lines 207–209)

```
fn has_nested_experimental(field: &Field) -> bool
```

**Purpose**: This decides whether a field is marked as containing nested experimental API data. A nested field is not experimental by itself, but the generated code should ask the child value whether it is experimental.

**Data flow**: It receives a field and scans that field’s attributes. If any attribute matches the `#[experimental(nested)]` form, it returns true; otherwise it returns false.

**Call relations**: It is called by `derive_for_struct` for fields that do not have their own direct experimental reason. When it returns true, the generated struct code calls `ExperimentalApi::experimental_reason` on that field at runtime.

*Call graph*: called by 1 (derive_for_struct).


##### `experimental_nested_attr`  (lines 211–218)

```
fn experimental_nested_attr(attr: &Attribute) -> bool
```

**Purpose**: This checks one attribute to see whether it is exactly the nested experimental marker. It recognizes `#[experimental(nested)]`.

**Data flow**: It receives a single attribute. It first checks that the attribute name is `experimental`, then checks whether its argument is the identifier `nested`. It returns true only for that exact shape.

**Call relations**: It is the detailed test used by `has_nested_experimental`. Together, they let `derive_for_struct` distinguish a direct experimental field from a field whose child value should be inspected.

*Call graph*: 1 external calls (path).


##### `field_serialized_name`  (lines 220–224)

```
fn field_serialized_name(field: &Field) -> Option<String>
```

**Purpose**: This turns a Rust field name into the API-style field name used in the experimental field registry. For example, a Rust field like `max_tokens` becomes `maxTokens`.

**Data flow**: It receives a field, reads its identifier if the field has one, converts that snake_case name to camelCase, and returns the converted string. If the field has no name, it returns nothing.

**Call relations**: It is called by `derive_for_struct` when registering named struct fields as experimental. It uses `snake_to_camel` to do the actual name conversion before the generated inventory entry is built.

*Call graph*: calls 1 internal fn (snake_to_camel); called by 1 (derive_for_struct).


##### `snake_to_camel`  (lines 226–242)

```
fn snake_to_camel(s: &str) -> String
```

**Purpose**: This converts a name written with underscores into a name where each post-underscore letter is capitalized. It is used to match common JSON or API naming style.

**Data flow**: It receives a string such as `tool_choice`. It walks through each character, skips underscores, capitalizes the character after each underscore, and returns a new string such as `toolChoice`.

**Call relations**: It is called by `field_serialized_name`. In the bigger macro flow, this makes the generated experimental field catalog use public API field names rather than Rust’s internal field spelling.

*Call graph*: called by 1 (field_serialized_name); 1 external calls (with_capacity).


##### `experimental_presence_expr`  (lines 244–253)

```
fn experimental_presence_expr(
    field: &Field,
    tuple_struct: bool,
) -> Option<proc_macro2::TokenStream>
```

**Purpose**: This builds the generated test for whether a named struct field is actually in use. A field being marked experimental matters only when the value is meaningfully present.

**Data flow**: It receives a field and a flag for tuple-struct handling. For normal named fields, it creates code that accesses `self.field_name` and passes that access plus the field type to `presence_expr_for_access`. If tuple-struct handling is requested, or the field has no name, it returns nothing.

**Call relations**: It is called by `derive_for_struct` for directly experimental named fields. It hands off the type-specific decision to `presence_expr_for_access`, which decides whether to generate an `is_some`, `is_empty`, boolean, or always-true check.

*Call graph*: calls 1 internal fn (presence_expr_for_access); called by 1 (derive_for_struct); 1 external calls (quote!).


##### `index_presence_expr`  (lines 255–258)

```
fn index_presence_expr(index: usize, ty: &Type) -> proc_macro2::TokenStream
```

**Purpose**: This builds the generated test for whether a tuple struct field is actually in use. Tuple struct fields are addressed by number rather than by name.

**Data flow**: It receives a numeric field position and the field’s type. It creates code that accesses `self.0`, `self.1`, and so on, then asks `presence_expr_for_access` to create the correct presence test for that type.

**Call relations**: It is called by `derive_for_struct` for directly experimental unnamed fields. It converts the field number into Rust field-access syntax, then hands the rest of the work to `presence_expr_for_access`.

*Call graph*: calls 1 internal fn (presence_expr_for_access); called by 1 (derive_for_struct); 2 external calls (quote!, from).


##### `presence_expr_for_access`  (lines 260–274)

```
fn presence_expr_for_access(
    access: proc_macro2::TokenStream,
    ty: &Type,
) -> proc_macro2::TokenStream
```

**Purpose**: This decides what “present” means for a field based on its type and writes the matching Rust expression. This avoids treating an empty list or a false flag as active experimental usage.

**Data flow**: It receives generated code for accessing a field and the field’s type. If the type is `Option`, it generates an `is_some()` check. If it is a vector or map, it checks that it is not empty. If it is a boolean, it uses the boolean value itself. For other types, it generates `true`, meaning the field always counts as present.

**Call relations**: It is called by both `experimental_presence_expr` and `index_presence_expr`. It uses `option_inner`, `is_vec_like`, `is_map_like`, and `is_bool` to classify the type before returning the expression that `derive_for_struct` places into the generated implementation.

*Call graph*: calls 4 internal fn (is_bool, is_map_like, is_vec_like, option_inner); called by 2 (experimental_presence_expr, index_presence_expr); 1 external calls (quote!).


##### `option_inner`  (lines 276–291)

```
fn option_inner(ty: &Type) -> Option<&Type>
```

**Purpose**: This checks whether a type is an `Option<T>` and, if so, returns the inner `T` type. In this file, the important part is simply knowing that the field is optional.

**Data flow**: It receives a parsed Rust type. It looks for a path type whose final segment is `Option` and whose angle-bracketed generic argument contains a type. If that shape matches, it returns the inner type; otherwise it returns nothing.

**Call relations**: It is called by `presence_expr_for_access` before the other type checks. When it succeeds, the generated presence test becomes `field.is_some()`.

*Call graph*: called by 1 (presence_expr_for_access).


##### `is_vec_like`  (lines 293–295)

```
fn is_vec_like(ty: &Type) -> bool
```

**Purpose**: This checks whether a type looks like `Vec`, Rust’s common growable list type. Lists count as present only when they contain at least one item.

**Data flow**: It receives a parsed Rust type, asks for the type’s final name, and returns true if that name is `Vec`. Otherwise it returns false.

**Call relations**: It is called by `presence_expr_for_access`. It uses `type_last_ident` for the shared task of extracting the final type name.

*Call graph*: calls 1 internal fn (type_last_ident); called by 1 (presence_expr_for_access).


##### `is_map_like`  (lines 297–299)

```
fn is_map_like(ty: &Type) -> bool
```

**Purpose**: This checks whether a type looks like a common map or dictionary type. Maps count as present only when they contain at least one key-value entry.

**Data flow**: It receives a parsed Rust type, asks for the type’s final name, and returns true for `HashMap` or `BTreeMap`. Otherwise it returns false.

**Call relations**: It is called by `presence_expr_for_access`. It uses `type_last_ident` so the map check does not need to know all the details of Rust’s parsed type structure.

*Call graph*: calls 1 internal fn (type_last_ident); called by 1 (presence_expr_for_access).


##### `is_bool`  (lines 301–303)

```
fn is_bool(ty: &Type) -> bool
```

**Purpose**: This checks whether a type is `bool`, Rust’s true-or-false type. For an experimental boolean flag, only `true` means the feature is being used.

**Data flow**: It receives a parsed Rust type, extracts the final type name, and returns true if that name is `bool`. Otherwise it returns false.

**Call relations**: It is called by `presence_expr_for_access`. It depends on `type_last_ident` for the low-level type-name extraction.

*Call graph*: calls 1 internal fn (type_last_ident); called by 1 (presence_expr_for_access).


##### `type_last_ident`  (lines 305–310)

```
fn type_last_ident(ty: &Type) -> Option<Ident>
```

**Purpose**: This extracts the last name segment from a Rust type path. It is a small helper for recognizing simple type names like `Vec`, `HashMap`, or `bool`.

**Data flow**: It receives a parsed Rust type. If the type is written as a path, it returns the final identifier in that path; if the type has another shape, it returns nothing.

**Call relations**: It supports `is_vec_like`, `is_map_like`, and `is_bool`. Those helpers use it so `presence_expr_for_access` can make simple, readable decisions about how to test whether a field is present.

*Call graph*: called by 3 (is_bool, is_map_like, is_vec_like).
