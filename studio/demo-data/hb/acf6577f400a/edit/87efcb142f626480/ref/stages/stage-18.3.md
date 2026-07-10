# Generated backend and protobuf contracts  `stage-18.3`

This stage is the system’s translation layer. It sits behind the scenes and defines the exact shapes of messages shared with other services, so the handwritten code can speak to the backend and other processes without guessing.

Most of the files in codex-backend-openapi-models are generated from an API description. They act like forms: task summaries and full task responses, pull request data, rate-limit and spending status, credit status, and delivered config files such as config.toml fragments. The crate root and models/mod.rs gather these generated pieces into one place and expose only the models the rest of the workspace uses.

backend-client/src/types.rs is the practical adapter on top. It deals with backend JSON that is not always consistent, then offers cleaner helpers for things like account checks, rate-limit details, task diffs, assistant messages, and errors.

The protobuf files play a similar role for binary service-to-service messages. The thread-config file defines messages and gRPC plumbing for loading remote thread settings. The exec-server relay protobuf defines the low-level relay packets, while relay_proto.rs re-exports just the parts the rest of exec-server needs.

## Files in this stage

### Backend type facade
These files introduce the handwritten backend-facing type layer and the generated model crate surface it builds on.

### `backend-client/src/types.rs`

`data_model` · `response deserialization and downstream task/account inspection`

This file is the backend client’s type layer: it re-exports many generated OpenAPI models, then fills gaps with custom structs and enums where the generated schema is either awkward or too lossy. The first custom area is account-check parsing. `AccountsCheckResponse` accepts two incompatible wire formats for `accounts`: either a direct `Vec<AccountEntry>` or a map keyed by account id containing nested ChatGPT account objects. Its manual `Deserialize` implementation normalizes both into a single ordered `Vec<AccountEntry>`, using `account_ordering` to preserve server ordering and dropping map entries that are missing from the ordering or lack an `account_id`.

The second major area is task-details parsing. `CodeTaskDetailsResponse`, `Turn`, `TurnItem`, `ContentFragment`, `WorklogMessage`, and `TurnError` model only the fields needed by the client. Many collection fields use `deserialize_vec` so absent arrays deserialize as empty vectors instead of failing or producing `None`. The helper methods then interpret these raw structures: `ContentFragment::text` extracts only meaningful text fragments; `TurnItem::diff_text` understands both `output_diff` items and PR payloads; `Turn::message_texts`, `user_prompt`, and `error_summary` aggregate assistant output, user prompts, and failures into plain strings. The `CodeTaskDetailsResponseExt` trait exposes these as stable, higher-level queries over the current user, assistant, and diff turns. The included tests lock down precedence rules such as preferring `current_diff_task_turn` for diffs and joining multi-part prompts with blank lines.

#### Function details

##### `RawAccounts::default`  (lines 91–93)

```
fn default() -> Self
```

**Purpose**: Provides the serde default for the polymorphic `accounts` field by choosing an empty list representation. This lets missing `accounts` deserialize cleanly without special-case callers.

**Data flow**: It takes no arguments and constructs `RawAccounts::List(Vec::new())`. It reads no external state and returns the enum value used when serde applies `#[serde(default)]`.

**Call relations**: Serde invokes this when `RawAccountsCheckResponse.accounts` is absent. Its output is then consumed by `AccountsCheckResponse::deserialize`, which treats the empty list as a normalized no-accounts case.

*Call graph*: 2 external calls (List, new).


##### `AccountsCheckResponse::deserialize`  (lines 113–139)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Manually deserializes account-check JSON that may encode accounts either as a list of `AccountEntry` values or as a map of nested ChatGPT account objects. It normalizes both shapes into the public `AccountsCheckResponse` structure.

**Data flow**: It receives a serde `Deserializer`, first deserializes into `RawAccountsCheckResponse`, then matches `raw.accounts`. For `RawAccounts::List`, it forwards the list unchanged. For `RawAccounts::Map`, it iterates `raw.account_ordering`, removes matching entries from the map, extracts the nested `account`, requires a present `account_id`, and builds `AccountEntry` values with copied `name`, `profile_picture_url`, and `structure`. It returns `AccountsCheckResponse { accounts, account_ordering, default_account_id }`.

**Call relations**: Serde calls this whenever an `AccountsCheckResponse` is decoded from backend JSON. It does not delegate to other local helpers beyond the intermediate raw types; downstream code receives a single normalized representation regardless of which wire format the backend emitted.

*Call graph*: 1 external calls (deserialize).


##### `ContentFragment::text`  (lines 245–267)

```
fn text(&self) -> Option<&str>
```

**Purpose**: Extracts meaningful text from a content fragment while ignoring empty strings and non-text structured payloads. It is the core normalization step used by message and prompt extraction.

**Data flow**: It reads `self` and matches on the enum variant. For `Structured`, it checks whether `content_type` equals `text` case-insensitively and, if so, returns the non-empty `text` field as `&str`. For `Text`, it trims whitespace and returns the raw string slice only when it is not blank. It returns `Option<&str>` and writes no state.

**Call relations**: This helper is called by `TurnItem::text_values` and `WorklogMessage::text_values` while flattening nested content arrays into plain strings. Its filtering behavior determines which fragments appear in assistant messages and user prompts.


##### `TurnItem::text_values`  (lines 271–276)

```
fn text_values(&self) -> Vec<String>
```

**Purpose**: Collects all textual fragments from a single turn item into owned strings. It converts the item’s heterogeneous `content` array into a simple `Vec<String>`.

**Data flow**: It reads `self.content`, iterates each `ContentFragment`, calls `ContentFragment::text`, converts present `&str` values to owned `String`s, and collects them. It returns the resulting vector without mutating any state.

**Call relations**: This is used by `Turn::message_texts` for assistant output items and by `Turn::user_prompt` for user input items. It delegates fragment-level filtering to `ContentFragment::text`.


##### `TurnItem::diff_text`  (lines 278–293)

```
fn diff_text(&self) -> Option<String>
```

**Purpose**: Extracts a unified diff string from a turn item when that item encodes diff output in one of the backend’s supported shapes. It understands both direct `output_diff` items and PR items carrying nested `output_diff.diff`.

**Data flow**: It reads `self.kind`, `self.diff`, and `self.output_diff`. If `kind == "output_diff"`, it returns a cloned non-empty `self.diff`. Otherwise, if `kind == "pr"`, it looks for `self.output_diff.as_ref()?.diff` and returns a cloned non-empty nested diff. If neither pattern matches, it returns `None`.

**Call relations**: Called by `Turn::unified_diff` while scanning output items. Its branching captures backend schema variation so higher-level code can ask for a diff without caring which item type carried it.


##### `Turn::unified_diff`  (lines 297–299)

```
fn unified_diff(&self) -> Option<String>
```

**Purpose**: Finds the first diff-bearing output item in a turn and returns its unified diff text. It reduces a turn’s output list to a single optional patch string.

**Data flow**: It reads `self.output_items`, iterates in order, applies `TurnItem::diff_text` to each item, and returns the first non-`None` result. It returns `Option<String>` and does not modify state.

**Call relations**: This helper is used by `CodeTaskDetailsResponse::unified_diff`, which checks the diff-task turn before the assistant turn. It delegates item-level interpretation to `TurnItem::diff_text`.


##### `Turn::message_texts`  (lines 301–318)

```
fn message_texts(&self) -> Vec<String>
```

**Purpose**: Aggregates assistant-visible text messages from a turn’s output items and assistant-authored worklog entries. It produces the plain-text conversational output for a turn, excluding diffs.

**Data flow**: It starts with an output vector built from `self.output_items`: only items with `kind == "message"` are kept, and each contributes strings from `TurnItem::text_values`. It then inspects `self.worklog`; for each `WorklogMessage`, if `is_assistant()` is true, it appends that message’s `text_values()`. It returns the accumulated `Vec<String>`.

**Call relations**: Used by `CodeTaskDetailsResponse::assistant_text_messages` when combining current diff-task and assistant turns. It delegates role filtering and fragment extraction to `WorklogMessage::is_assistant`, `WorklogMessage::text_values`, and `TurnItem::text_values`.


##### `Turn::user_prompt`  (lines 320–343)

```
fn user_prompt(&self) -> Option<String>
```

**Purpose**: Extracts the user’s prompt text from input message items and joins multiple parts with blank lines. It treats missing roles as user messages by default.

**Data flow**: It reads `self.input_items`, keeps only items with `kind == "message"`, then filters to items whose `role` is either absent or equals `user` case-insensitively. It flattens each item through `TurnItem::text_values`, collects the strings, and returns `None` if no parts were found; otherwise it joins them with `"\n\n"` and returns `Some(String)`.

**Call relations**: Called by `CodeTaskDetailsResponse::user_text_prompt` for the current user turn. Its permissive role handling is important for backend payloads that omit the role field.


##### `Turn::error_summary`  (lines 345–347)

```
fn error_summary(&self) -> Option<String>
```

**Purpose**: Converts an optional structured turn error into a single summary string. It is a thin adapter from `Option<TurnError>` to `Option<String>`.

**Data flow**: It reads `self.error`, borrows it if present, and calls `TurnError::summary`. It returns that optional summary and writes no state.

**Call relations**: Used by `CodeTaskDetailsResponse::assistant_error_message` to expose assistant-turn failures. All formatting logic lives in `TurnError::summary`.


##### `WorklogMessage::is_assistant`  (lines 351–357)

```
fn is_assistant(&self) -> bool
```

**Purpose**: Determines whether a worklog message was authored by the assistant. It performs a case-insensitive role check and treats missing author information as non-assistant.

**Data flow**: It reads `self.author`, then `author.role` if present, compares it to `assistant` ignoring ASCII case, and returns a boolean. No state is mutated.

**Call relations**: This predicate is used by `Turn::message_texts` to include only assistant-authored worklog messages in extracted output text.


##### `WorklogMessage::text_values`  (lines 359–370)

```
fn text_values(&self) -> Vec<String>
```

**Purpose**: Extracts all textual parts from a worklog message’s optional content payload. It flattens nested content fragments into owned strings.

**Data flow**: It reads `self.content`. If present, it iterates `content.parts`, calls `ContentFragment::text` on each fragment, converts present slices to `String`, and collects them; if content is absent, it returns an empty vector. It writes no state.

**Call relations**: Called by `Turn::message_texts` after `WorklogMessage::is_assistant` has selected assistant-authored entries. It delegates fragment filtering to `ContentFragment::text`.


##### `TurnError::summary`  (lines 374–383)

```
fn summary(&self) -> Option<String>
```

**Purpose**: Formats a turn error’s code and message into the most informative single-line summary available. It suppresses empty fields rather than emitting awkward separators.

**Data flow**: It reads `self.code` and `self.message`, substitutes empty strings for missing values, then matches on whether each is empty. It returns `None` if both are empty, just the code if only code exists, just the message if only message exists, or `"{code}: {message}"` if both exist.

**Call relations**: Invoked by `Turn::error_summary`, which in turn feeds `CodeTaskDetailsResponse::assistant_error_message`. This function centralizes the formatting invariant used by tests.

*Call graph*: 1 external calls (format!).


##### `CodeTaskDetailsResponse::unified_diff`  (lines 398–406)

```
fn unified_diff(&self) -> Option<String>
```

**Purpose**: Extracts the preferred unified diff from the current task details, prioritizing the dedicated diff-task turn over the assistant turn. It gives callers one place to ask for patch output.

**Data flow**: It reads `self.current_diff_task_turn` and `self.current_assistant_turn`, iterates those optional references in that order, calls `Turn::unified_diff` on each present turn, and returns the first diff found. It returns `Option<String>`.

**Call relations**: This is the trait implementation behind the public extension API for task details. Tests verify its precedence rule, and it delegates actual turn scanning to `Turn::unified_diff`.


##### `CodeTaskDetailsResponse::assistant_text_messages`  (lines 408–420)

```
fn assistant_text_messages(&self) -> Vec<String>
```

**Purpose**: Collects assistant text output from the current diff-task and assistant turns. It merges both sources into a single ordered vector of message strings.

**Data flow**: It initializes an empty `Vec<String>`, iterates over `self.current_diff_task_turn` and `self.current_assistant_turn` if present, extends the vector with each turn’s `message_texts()`, and returns the accumulated messages.

**Call relations**: This extension method is used by consumers that want conversational assistant output without parsing the raw turn structure. It delegates per-turn extraction to `Turn::message_texts`.

*Call graph*: 1 external calls (new).


##### `CodeTaskDetailsResponse::user_text_prompt`  (lines 422–424)

```
fn user_text_prompt(&self) -> Option<String>
```

**Purpose**: Returns the current user turn’s prompt text, if any. It is the high-level accessor for the normalized prompt assembled from input message fragments.

**Data flow**: It reads `self.current_user_turn`, borrows it if present, calls `Turn::user_prompt`, and returns the resulting `Option<String>`. No state is changed.

**Call relations**: Part of the `CodeTaskDetailsResponseExt` trait implementation. It simply forwards to `Turn::user_prompt` for the current user turn.


##### `CodeTaskDetailsResponse::assistant_error_message`  (lines 426–430)

```
fn assistant_error_message(&self) -> Option<String>
```

**Purpose**: Returns a summarized assistant-turn error message when the current assistant turn failed with structured error data. It exposes the assistant error in the same extension API as diffs and messages.

**Data flow**: It reads `self.current_assistant_turn`, borrows it if present, calls `Turn::error_summary`, and returns the optional summary string.

**Call relations**: This method is the top-level consumer-facing path for assistant error extraction. It delegates formatting to `Turn::error_summary` and ultimately `TurnError::summary`.


##### `deserialize_vec`  (lines 433–439)

```
fn deserialize_vec(deserializer: D) -> Result<Vec<T>, D::Error>
```

**Purpose**: Deserializes an optional JSON array into a concrete vector, defaulting missing or null values to an empty `Vec`. It removes `Option<Vec<T>>` boilerplate from many struct fields.

**Data flow**: It accepts a serde `Deserializer`, deserializes `Option<Vec<T>>`, then maps `None` to `Vec::new()` via `unwrap_or_default`. It returns `Result<Vec<T>, D::Error>`.

**Call relations**: Serde uses this helper for `Turn.sibling_turn_ids`, `Turn.input_items`, `Turn.output_items`, `TurnItem.content`, and `Worklog.messages`. Those fields therefore always deserialize to usable vectors.

*Call graph*: 1 external calls (deserialize).


##### `tests::fixture`  (lines 473–480)

```
fn fixture(name: &str) -> CodeTaskDetailsResponse
```

**Purpose**: Loads one of the embedded task-details JSON fixtures and deserializes it into `CodeTaskDetailsResponse`. It centralizes fixture selection for the unit tests.

**Data flow**: It takes a fixture name string, matches it to either `task_details_with_diff.json` or `task_details_with_error.json` via `include_str!`, panics on unknown names, then parses the JSON with `serde_json::from_str` and returns the typed response.

**Call relations**: All task-details tests call this helper before exercising the extension methods. It isolates fixture lookup so each test focuses on one extraction behavior.

*Call graph*: 3 external calls (include_str!, panic!, from_str).


##### `tests::unified_diff_prefers_current_diff_task_turn`  (lines 483–487)

```
fn unified_diff_prefers_current_diff_task_turn()
```

**Purpose**: Verifies that diff extraction prefers `current_diff_task_turn` when both task-detail turns may contain diff-like data. It guards the intended precedence rule.

**Data flow**: It loads the `diff` fixture with `tests::fixture`, calls `unified_diff()`, asserts a diff is present, and checks that the returned string contains `diff --git`.

**Call relations**: This test exercises `CodeTaskDetailsResponse::unified_diff` through the fixture helper. It exists specifically to catch regressions in turn ordering.

*Call graph*: 2 external calls (assert!, fixture).


##### `tests::unified_diff_falls_back_to_pr_output_diff`  (lines 490–494)

```
fn unified_diff_falls_back_to_pr_output_diff()
```

**Purpose**: Checks that diff extraction can fall back to a PR item’s nested `output_diff.diff` when no direct diff item is available. It validates the alternate backend shape handled by `TurnItem::diff_text`.

**Data flow**: It loads the `error` fixture, calls `unified_diff()`, asserts a diff exists, and verifies the returned patch mentions `lib.rs`.

**Call relations**: This test covers the path from `CodeTaskDetailsResponse::unified_diff` through `Turn::unified_diff` into the PR branch of `TurnItem::diff_text`.

*Call graph*: 2 external calls (assert!, fixture).


##### `tests::assistant_text_messages_extracts_text_content`  (lines 497–501)

```
fn assistant_text_messages_extracts_text_content()
```

**Purpose**: Ensures assistant message extraction returns only the expected text fragments from the fixture payload. It confirms that structured and raw text content are normalized correctly.

**Data flow**: It loads the `diff` fixture, calls `assistant_text_messages()`, and asserts the resulting vector equals a single `"Assistant response"` string.

**Call relations**: This test exercises the chain `CodeTaskDetailsResponse::assistant_text_messages` → `Turn::message_texts` → `TurnItem::text_values`/`ContentFragment::text`.

*Call graph*: 2 external calls (assert_eq!, fixture).


##### `tests::user_text_prompt_joins_parts_with_spacing`  (lines 504–513)

```
fn user_text_prompt_joins_parts_with_spacing()
```

**Purpose**: Verifies that multiple user prompt parts are joined with a blank line separator. It locks down the exact formatting of `Turn::user_prompt`.

**Data flow**: It loads the `diff` fixture, calls `user_text_prompt()`, asserts a prompt exists, and compares it to the expected two-line string separated by `\n\n`.

**Call relations**: This test covers `CodeTaskDetailsResponse::user_text_prompt` and the joining behavior inside `Turn::user_prompt`.

*Call graph*: 2 external calls (assert_eq!, fixture).


##### `tests::assistant_error_message_combines_code_and_message`  (lines 516–522)

```
fn assistant_error_message_combines_code_and_message()
```

**Purpose**: Checks that assistant error extraction combines both error code and message into a single summary string. It validates the formatting contract for failed turns.

**Data flow**: It loads the `error` fixture, calls `assistant_error_message()`, asserts a value is present, and compares it to `APPLY_FAILED: Patch could not be applied`.

**Call relations**: This test exercises `CodeTaskDetailsResponse::assistant_error_message` through `Turn::error_summary` and `TurnError::summary`.

*Call graph*: 2 external calls (assert_eq!, fixture).


### `codex-backend-openapi-models/src/lib.rs`

`generated` · `cross-cutting`

This crate root exists to wrap and re-export OpenAPI-generated data structures without adding handwritten domain behavior. It enables `clippy::unwrap_used` and `clippy::expect_used` allowances at the crate level, reflecting the fact that generated code often uses patterns that would be discouraged in handwritten Rust but are acceptable for machine-produced model definitions. The only public item is `pub mod models;`, which delegates all actual type definitions to the generated or curated module tree under `src/models`. The comments document the intended workflow: regeneration scripts populate individual model files and the module index, and this root intentionally remains minimal so regeneration does not have to preserve custom logic. In practice, this file marks the crate as a pure schema package: consumers import request/response payload structs and enums from here, while serialization behavior, validation assumptions, and field layouts live in the generated model modules themselves.


### `codex-backend-openapi-models/src/models/mod.rs`

`data_model` · `cross-cutting`

This module is the index for the backend model crate's concrete schema types. Rather than exposing every generated artifact wholesale, it declares each backing module as `pub(crate)` and then selectively re-exports the public types needed elsewhere in the workspace. The exports are grouped by feature area: configuration payloads such as `ConfigBundleResponse`, `ConfigFileResponse`, and delivered TOML fragments; cloud task entities such as `CodeTaskDetailsResponse`, `TaskResponse`, `ExternalPullRequestResponse`, `GitPullRequest`, `TaskListItem`, and the paginated task list wrapper; and rate-limit or billing-related payloads including `AdditionalRateLimitDetails`, `RateLimitStatusPayload`, `RateLimitStatusDetails`, `RateLimitWindowSnapshot`, `CreditStatusDetails`, `SpendControlLimitDetails`, and `SpendControlStatusDetails`. It also re-exports enum-like companion types from `rate_limit_status_payload`, including `PlanType`, `RateLimitReachedKind`, and `RateLimitReachedType`. The design keeps module filenames and generated internals hidden while giving the rest of the workspace a stable import surface. The comments note that this file used to be generator-produced but is now manually curated, which is important: adding a new model requires updating this export list explicitly, and unused generated types remain inaccessible by default.


### Rate and spend status models
These generated schemas define the nested transport types for rate limits, credit availability, and spend-control reporting consumed by backend responses.

### `codex-backend-openapi-models/src/models/additional_rate_limit_details.rs`

`generated` · `cross-cutting`

This generated model file defines `AdditionalRateLimitDetails`, a serde-serializable struct used to move rate-limit detail payloads between the backend API and Rust code. The struct has two required string fields, `limit_name` and `metered_feature`, both serialized under those exact JSON keys. Its third field, `rate_limit`, is typed as `Option<Option<Box<models::RateLimitStatusDetails>>>` and uses `serde_with::rust::double_option`; that encoding preserves three distinct states during deserialization and serialization: field absent (`None`), field explicitly present with JSON `null` (`Some(None)`), and field present with an actual nested object (`Some(Some(Box<...>))`). `skip_serializing_if = "Option::is_none"` means the outer `None` state omits the key entirely.

Aside from derived traits (`Clone`, `Default`, `Debug`, `PartialEq`, `Serialize`, `Deserialize`), the file contains only a constructor that initializes the required fields and leaves the optional nested rate-limit detail absent. There is no validation logic, normalization, or behavior beyond data representation, which is typical for OpenAPI-generated model leaf files.

#### Function details

##### `AdditionalRateLimitDetails::new`  (lines 31–37)

```
fn new(limit_name: String, metered_feature: String) -> AdditionalRateLimitDetails
```

**Purpose**: Creates a new `AdditionalRateLimitDetails` with the required identifiers populated and no nested `rate_limit` value set.

**Data flow**: It takes `limit_name: String` and `metered_feature: String`, moves them directly into the struct fields, sets `rate_limit` to `None`, and returns the fully constructed `AdditionalRateLimitDetails` by value.

**Call relations**: This constructor is the file’s only behavior and serves as the convenient initialization path when callers have the required fields but no explicit rate-limit-status payload yet.


### `codex-backend-openapi-models/src/models/credit_status_details.rs`

`generated` · `cross-cutting`

This generated model file defines `CreditStatusDetails`, which captures whether an account has credits and whether usage is unlimited, plus optional descriptive fields about balances and estimated message counts. The required fields `has_credits` and `unlimited` are plain booleans. The optional fields use `Option<Option<...>>` with `serde_with::rust::double_option`: `balance` is an optional optional string, while `approx_local_messages` and `approx_cloud_messages` are optional optional vectors of arbitrary `serde_json::Value`. That schema preserves absent-vs-null-vs-present distinctions from the OpenAPI contract, which matters when the backend wants to signal “not provided” separately from “explicitly empty/unknown.”

As with the other generated model leaf files, behavior is intentionally minimal. Derived traits provide serialization, deserialization, cloning, equality, and debugging. The constructor initializes the two required booleans from its arguments and leaves all optional detail fields absent (`None`). Any richer state, such as explicit null balances or populated approximate message arrays, must be assigned by callers after construction. The file contains no business rules about how credits are computed or interpreted.

#### Function details

##### `CreditStatusDetails::new`  (lines 43–51)

```
fn new(has_credits: bool, unlimited: bool) -> CreditStatusDetails
```

**Purpose**: Builds a `CreditStatusDetails` value with the required credit flags set and all optional balance/message estimate fields omitted.

**Data flow**: It takes `has_credits: bool` and `unlimited: bool`, stores them directly in the struct, sets `balance`, `approx_local_messages`, and `approx_cloud_messages` to `None`, and returns the new `CreditStatusDetails`.

**Call relations**: This constructor is the sole explicit behavior in the file and provides the minimal initialization path for the generated credit-status model.


### `codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs`

`data_model` · `request/response serialization`

This file declares `RateLimitWindowSnapshot`, a generated schema struct representing the state of a single rate-limit window at a point in time. All four fields are required integers: `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and `reset_at`. Together they describe how much of the window has been consumed, the total window duration, how long remains until reset, and the reset timestamp or epoch-like integer value expected by the API.

The constructor requires all four values and stores them directly, reflecting that a snapshot is only meaningful when complete. There is no validation that `used_percent` falls within 0–100, that durations are nonnegative, or that `reset_after_seconds` is consistent with `reset_at`; those invariants, if needed, must be enforced by upstream logic. The file’s role is purely to preserve the schema and serde mapping for this nested object, which is then embedded inside broader rate-limit status models. Because it derives the standard serde and utility traits, it can be serialized, deserialized, cloned, and compared as a passive value object.

#### Function details

##### `RateLimitWindowSnapshot::new`  (lines 26–38)

```
fn new(
        used_percent: i32,
        limit_window_seconds: i32,
        reset_after_seconds: i32,
        reset_at: i32,
    ) -> RateLimitWindowSnapshot
```

**Purpose**: Creates a complete rate-limit window snapshot from its four required numeric fields. It is the direct constructor for this telemetry record.

**Data flow**: It consumes `used_percent: i32`, `limit_window_seconds: i32`, `reset_after_seconds: i32`, and `reset_at: i32`, moves them into a new `RateLimitWindowSnapshot`, and returns the populated struct without touching external state.

**Call relations**: This constructor is a leaf used when assembling detailed rate-limit responses that include primary or secondary window data. It performs no delegation and simply packages already computed metrics.


### `codex-backend-openapi-models/src/models/rate_limit_status_details.rs`

`data_model` · `request/response serialization`

This file provides `RateLimitStatusDetails`, a generated schema object that captures both coarse and fine-grained rate-limit information. The required booleans `allowed` and `limit_reached` summarize the current decision state. Two additional fields, `primary_window` and `secondary_window`, are typed as `Option<Option<Box<models::RateLimitWindowSnapshot>>>` and use `serde_with::rust::double_option`, preserving the distinction between an omitted field, an explicit JSON `null`, and a concrete nested snapshot object. Each nested snapshot is boxed, which is typical of generated code for nested models.

The constructor requires only the two booleans and initializes both window fields to `None`, meaning they are absent from the serialized payload unless later populated. This is important because the API can communicate a simple allow/deny result without committing to detailed window telemetry. The file contains no logic for computing percentages, reset times, or policy decisions; those values must be produced elsewhere and inserted into this model. Its main design nuance is the explicit preservation of wire-level nullability semantics for the optional window snapshots.

#### Function details

##### `RateLimitStatusDetails::new`  (lines 38–45)

```
fn new(allowed: bool, limit_reached: bool) -> RateLimitStatusDetails
```

**Purpose**: Builds a rate-limit status object from the required decision booleans. It leaves both optional window snapshots absent.

**Data flow**: It accepts `allowed: bool` and `limit_reached: bool`, moves them into a new `RateLimitStatusDetails`, sets `primary_window` and `secondary_window` to `None`, and returns the struct.

**Call relations**: This is a leaf constructor used by higher-level rate-limit payload assembly when only the summary state is known initially. It delegates no work and serves as the base object before optional snapshots are attached.


### `codex-backend-openapi-models/src/models/spend_control_limit_details.rs`

`data_model` · `request/response serialization`

This file is a pure data-model leaf generated from the backend OpenAPI schema. `SpendControlLimitDetails` carries the concrete fields returned over the API for one limit window: textual `limit`, `used`, and `remaining` values; integer `used_percent` and `remaining_percent`; and integer reset timestamps/durations in `reset_after_seconds` and `reset_at`. The `source` field is notable because it uses `serde_with::rust::double_option`, making it a tri-state `Option<Option<String>>`: the field can be absent entirely, present with `null`, or present with a string value. That distinction matters for generated clients that need to preserve API semantics during serialization and deserialization.

The struct derives `Clone`, `Default`, `Debug`, `PartialEq`, `Serialize`, and `Deserialize`, so it is intended to move unchanged between transport and application layers rather than enforce business rules locally. The only behavior is a convenience constructor that requires all non-optional fields and initializes `source` to `None`, meaning omitted rather than explicitly null. There is no validation of numeric ranges, timestamp meaning, or consistency between `used`, `remaining`, and percentages; callers must treat this type as a faithful schema container.

#### Function details

##### `SpendControlLimitDetails::new`  (lines 40–59)

```
fn new(
        limit: String,
        used: String,
        remaining: String,
        used_percent: i32,
        remaining_percent: i32,
        reset_after_seconds: i32,
        reset_at: i32,
```

**Purpose**: Constructs a `SpendControlLimitDetails` with all required limit metrics populated and the optional `source` field omitted.

**Data flow**: Takes owned `String` values for `limit`, `used`, and `remaining`, plus `i32` values for `used_percent`, `remaining_percent`, `reset_after_seconds`, and `reset_at`. It places those inputs directly into a new struct, sets `source` to `None`, and returns the fully assembled `SpendControlLimitDetails` without mutating external state.

**Call relations**: This is a local convenience constructor for code that wants to instantiate the generated model without spelling every field name. It does not delegate to helpers or perform validation; serialization behavior is then handled by the derived serde implementations.


### `codex-backend-openapi-models/src/models/spend_control_status_details.rs`

`data_model` · `request/response serialization`

This generated model wraps the higher-level status around spend controls. `SpendControlStatusDetails` contains a required boolean `reached` and an optional `individual_limit` pointing to `SpendControlLimitDetails` through `Option<Option<Box<...>>>`. As with other generated models using `serde_with::rust::double_option`, that nested option preserves three distinct wire states: field omitted, field present as `null`, or field present with an object payload. Boxing the nested model avoids embedding a potentially larger recursive value directly in the outer struct layout and matches the generator's conventions for optional nested objects.

The file contains no domain logic beyond construction. Derived serde traits make it a transport-facing schema object, and the constructor intentionally initializes `individual_limit` to `None`, meaning the field is absent unless a caller explicitly sets it later. There is no enforcement that `individual_limit` be present when `reached` is true, or absent when false; those semantics belong to the backend contract rather than this Rust type. Readers should treat this file as a thin schema mirror whose main subtlety is preserving null-vs-missing distinctions during JSON round-trips.

#### Function details

##### `SpendControlStatusDetails::new`  (lines 29–34)

```
fn new(reached: bool) -> SpendControlStatusDetails
```

**Purpose**: Creates a status object with the required `reached` flag set and no individual-limit payload attached.

**Data flow**: Accepts a single `bool` argument, writes it into the `reached` field, initializes `individual_limit` to `None`, and returns the new `SpendControlStatusDetails`. It reads no external state and performs no transformation beyond field assignment.

**Call relations**: This constructor is used when callers need the generated model in code before serde fills it from JSON. It is self-contained and leaves any nested `SpendControlLimitDetails` to be attached separately if needed.


### `codex-backend-openapi-models/src/models/rate_limit_status_payload.rs`

`data_model` · `request/response serialization`

This file contains the most structurally rich model in the set: `RateLimitStatusPayload`. Its required field, `plan_type`, uses the local `PlanType` enum to encode the caller’s subscription or workspace plan. The remaining fields—`rate_limit`, `credits`, `spend_control`, `additional_rate_limits`, and `rate_limit_reached_type`—all use `Option<Option<...>>` with `serde_with::rust::double_option`, preserving absent vs explicit-null vs concrete-value semantics across nested objects and lists. Nested detail objects are boxed where appropriate, and `additional_rate_limits` carries a vector of `AdditionalRateLimitDetails` when present.

Two enums are defined alongside the payload. `RateLimitReachedKind` enumerates specific reasons for denial or exhaustion and includes an `Unknown` fallback via `#[serde(other)]`, making deserialization forward-compatible with new server values. `PlanType` similarly enumerates many plan variants and also falls back to `Unknown`. `RateLimitReachedType` is a small wrapper struct exposing the serialized field name `type` while avoiding Rust keyword conflicts by storing it as `kind`.

The constructor requires only `plan_type` and initializes every optional status field to `None`, producing a minimal payload that communicates plan identity without any attached limit diagnostics. No policy evaluation occurs here; this file only defines and instantiates the wire schema.

#### Function details

##### `RateLimitStatusPayload::new`  (lines 57–66)

```
fn new(plan_type: PlanType) -> RateLimitStatusPayload
```

**Purpose**: Constructs a top-level rate-limit payload with a required plan type and no optional detail sections populated. It is the minimal valid instance of this API schema.

**Data flow**: It takes `plan_type: PlanType`, stores it directly, initializes `rate_limit`, `credits`, `spend_control`, `additional_rate_limits`, and `rate_limit_reached_type` to `None`, and returns the new `RateLimitStatusPayload`.

**Call relations**: This constructor is used when higher-level code begins assembling a rate-limit response from plan information and may later fill in detailed sections conditionally. It is a leaf function and does not invoke any subordinate helpers.


### Task and pull request responses
These models cover task listings, detailed task payloads, and the pull-request structures attached to assistant work.

### `codex-backend-openapi-models/src/models/code_task_details_response.rs`

`generated` · `cross-cutting`

This file defines `CodeTaskDetailsResponse`, a generated serde model for backend responses that expose a task plus optional turn snapshots. The required `task` field is stored as `Box<models::TaskResponse>`, which keeps the outer struct size stable and avoids embedding a potentially large nested task object inline. Three additional fields — `current_user_turn`, `current_assistant_turn`, and `current_diff_task_turn` — are each `Option<std::collections::HashMap<String, serde_json::Value>>`, allowing arbitrary JSON-shaped turn payloads keyed by string while still omitting absent sections during serialization via `skip_serializing_if = "Option::is_none"`.

The struct derives the standard generated-model traits (`Clone`, `Default`, `Debug`, `PartialEq`, `Serialize`, `Deserialize`) and contains no domain logic. Its constructor accepts a concrete `models::TaskResponse`, boxes it, and initializes all optional turn maps to `None`. That makes the constructor suitable for building the minimal valid response object first and then selectively attaching whichever turn snapshots are available. The file is purely representational and relies on serde attributes rather than custom code to preserve the API schema.

#### Function details

##### `CodeTaskDetailsResponse::new`  (lines 34–41)

```
fn new(task: models::TaskResponse) -> CodeTaskDetailsResponse
```

**Purpose**: Builds the minimal valid `CodeTaskDetailsResponse` around a required task payload, leaving all optional turn snapshots unset.

**Data flow**: It takes `task: models::TaskResponse`, wraps it with `Box::new(task)`, assigns that boxed value to the `task` field, sets `current_user_turn`, `current_assistant_turn`, and `current_diff_task_turn` to `None`, and returns the struct.

**Call relations**: This constructor is the file’s sole behavior and provides the standard generated-model initialization path before callers optionally populate any of the turn-map fields.

*Call graph*: 1 external calls (new).


### `codex-backend-openapi-models/src/models/git_pull_request.rs`

`data_model` · `request/response serialization`

This file contains the generated `GitPullRequest` schema, a fairly broad transport object for pull request details. Five fields are required: numeric PR `number`, `url`, textual `state`, and the booleans `merged` and `mergeable`. The remaining fields are optional and omitted when absent: `draft`, `title`, `body`, branch names (`base`, `head`), commit SHAs (`base_sha`, `head_sha`, `merge_commit_sha`), and three untyped JSON blobs for `comments`, `diff`, and `user`. Those `serde_json::Value` fields are a notable design choice: instead of modeling those nested structures precisely, the generated schema preserves arbitrary JSON payloads for consumers that need raw data.

The constructor requires only the core fields and initializes every optional field to `None`, producing a minimal but valid PR object. There is no normalization of state strings, no consistency checks between `merged` and `mergeable`, and no parsing of the JSON-valued fields. This file is therefore purely about preserving the API contract and ownership of PR data, leaving interpretation and validation to higher layers. The derive set makes it easy to clone, compare, debug-print, and serialize the object as needed.

#### Function details

##### `GitPullRequest::new`  (lines 51–76)

```
fn new(
        number: i32,
        url: String,
        state: String,
        merged: bool,
        mergeable: bool,
    ) -> GitPullRequest
```

**Purpose**: Constructs a minimal `GitPullRequest` from its required core fields. All optional metadata fields start absent.

**Data flow**: It consumes `number: i32`, `url: String`, `state: String`, `merged: bool`, and `mergeable: bool`. Those values are copied or moved into a new `GitPullRequest`, while `draft`, `title`, `body`, branch refs, SHAs, and raw JSON fields are all initialized to `None`; the completed struct is then returned.

**Call relations**: This is a leaf constructor used by code that needs a valid PR model before optionally attaching richer metadata. It does not call into any other helper and serves as the nested object source for higher-level response models.


### `codex-backend-openapi-models/src/models/external_pull_request_response.rs`

`data_model` · `request/response serialization`

This generated model file introduces `ExternalPullRequestResponse`, a transport struct used to serialize or deserialize pull-request-related API responses. The required fields are `id`, `assistant_turn_id`, and `pull_request`; the nested pull request is stored as `Box<models::GitPullRequest>`, which keeps the outer struct’s size stable and matches the generator’s strategy for nested object ownership. An additional optional field, `codex_updated_sha`, carries a SHA string when available and is omitted from serialized output when absent.

The constructor enforces the required shape by taking the two identifier strings and a concrete `GitPullRequest`, boxing the nested object internally, and initializing `codex_updated_sha` to `None`. That means a newly constructed response always represents the baseline API object without any post-update SHA attached. The file itself contains no logic for fetching pull requests, computing SHAs, or correlating assistant turns; it only preserves the response schema and ownership layout expected by serde and the OpenAPI contract. The distinction between required identifiers and optional update metadata is encoded directly in the field types and serde attributes.

#### Function details

##### `ExternalPullRequestResponse::new`  (lines 28–39)

```
fn new(
        id: String,
        assistant_turn_id: String,
        pull_request: models::GitPullRequest,
    ) -> ExternalPullRequestResponse
```

**Purpose**: Creates a response object for an external pull request using required identifiers and a nested `GitPullRequest`. It also initializes the optional `codex_updated_sha` as absent.

**Data flow**: It takes ownership of `id: String`, `assistant_turn_id: String`, and `pull_request: models::GitPullRequest`. The function wraps `pull_request` in `Box::new`, stores all three values in a new `ExternalPullRequestResponse`, sets `codex_updated_sha` to `None`, and returns the assembled struct.

**Call relations**: According to the call graph, this constructor invokes an external `new` while boxing or constructing nested content as part of response assembly. It is used when higher-level code needs to emit a pull-request response tied to an assistant turn, and it delegates only the nested object construction/boxing step rather than performing any API-side computation.

*Call graph*: 1 external calls (new).


### `codex-backend-openapi-models/src/models/task_list_item.rs`

`data_model` · `request/response serialization`

This file provides the list-view representation of a task. `TaskListItem` includes required identity and visibility fields (`id`, `title`, `archived`, `has_unread_turn`) plus several optional enrichments: `has_generated_title`, floating-point `updated_at` and `created_at` timestamps, a free-form `task_status_display` map of JSON values, and optional `pull_requests` containing `ExternalPullRequestResponse` items. The use of `HashMap<String, serde_json::Value>` for status display indicates the backend can emit structured but not statically modeled display metadata, and the optional vectors/maps are omitted from serialized output when absent.

The constructor reflects the intended minimum payload for creating or synthesizing this model in client code: it requires the stable identifiers and booleans, accepts `has_generated_title` because that flag may be known at creation time, and defaults all other optional metadata to `None`. No normalization or timestamp conversion occurs; `f64` values are stored exactly as provided by the API. This is therefore a transport schema rather than a richer domain object. A reader should note that list items and full task responses are modeled separately, so this type intentionally carries less detail than `TaskResponse`.

#### Function details

##### `TaskListItem::new`  (lines 44–62)

```
fn new(
        id: String,
        title: String,
        has_generated_title: Option<bool>,
        archived: bool,
        has_unread_turn: bool,
    ) -> TaskListItem
```

**Purpose**: Builds a minimal task-list item with required identifiers and flags while leaving optional metadata unset.

**Data flow**: Consumes `id` and `title` strings, an `Option<bool>` for `has_generated_title`, and required `archived` and `has_unread_turn` booleans. It copies those inputs into the struct, sets `updated_at`, `created_at`, `task_status_display`, and `pull_requests` to `None`, and returns the assembled `TaskListItem`.

**Call relations**: This is a convenience constructor for code paths that need a list-item model without manually populating every optional field. It does not call other helpers and relies on derived serde behavior for later JSON encoding/decoding.


### `codex-backend-openapi-models/src/models/paginated_list_task_list_item_.rs`

`data_model` · `request/response serialization`

This generated file declares `PaginatedListTaskListItem`, the schema used when the backend returns a page of `TaskListItem` records. The `items` field is required and stored as `Vec<models::TaskListItem>`, while `cursor` is optional and omitted from serialized output when absent. That shape reflects a common cursor-based pagination contract: every page has concrete items, and only some pages include a continuation token.

The constructor takes the item vector and initializes `cursor` to `None`, yielding a first-pass or terminal page representation with no next-page token attached. The file contains no pagination logic itself—no cursor encoding/decoding, no page-size enforcement, and no iteration helpers. Its responsibility is simply to preserve the wire format and ownership of the page contents. Because the type derives serde traits and standard utility traits, it can move cleanly between HTTP handlers, generated clients, and tests. The underscore in the filename reflects generator naming for a generic-like schema specialization, but the Rust type itself is the concrete `PaginatedListTaskListItem` model used throughout the API layer.

#### Function details

##### `PaginatedListTaskListItem::new`  (lines 24–29)

```
fn new(items: Vec<models::TaskListItem>) -> PaginatedListTaskListItem
```

**Purpose**: Creates a paginated task-list page with a required set of items and no cursor. It is the minimal constructor for this page wrapper.

**Data flow**: It takes ownership of `items: Vec<models::TaskListItem>`, stores that vector directly, sets `cursor` to `None`, and returns the resulting `PaginatedListTaskListItem`.

**Call relations**: This constructor is used when callers have already assembled the page contents and either do not yet know or do not need a continuation cursor. It is a leaf function with no delegated work.


### `codex-backend-openapi-models/src/models/task_response.rs`

`data_model` · `request/response serialization`

This generated schema represents a fuller task payload than the list item model. `TaskResponse` stores required `id`, `title`, `archived`, and a non-optional `external_pull_requests` vector, while optional fields capture creation time, generated-title status, current turn identity, unread-turn state, and arbitrary `denormalized_metadata` as a JSON map. The distinction between required and optional fields mirrors the API contract: external pull requests are always present as a vector, even if empty, whereas several other pieces of metadata may be omitted.

The constructor enforces that split by requiring the core identifiers plus the pull-request vector and defaulting all optional metadata to `None`. There is no validation of timestamp precision, metadata shape, or consistency between `current_turn_id` and `has_unread_turn`; the type simply preserves backend data. Because this file is generated and derives serde traits, its main role is stable serialization/deserialization rather than behavior. Readers comparing models should note that `TaskResponse` uses `external_pull_requests` while `TaskListItem` uses optional `pull_requests`, reflecting different response shapes rather than an internal transformation layer.

#### Function details

##### `TaskResponse::new`  (lines 44–61)

```
fn new(
        id: String,
        title: String,
        archived: bool,
        external_pull_requests: Vec<models::ExternalPullRequestResponse>,
    ) -> TaskResponse
```

**Purpose**: Constructs a full task response object with required task identity, archive state, and pull-request list, leaving optional metadata absent.

**Data flow**: Takes owned `String` values for `id` and `title`, a required `bool` for `archived`, and a `Vec<ExternalPullRequestResponse>` for `external_pull_requests`. It writes those directly into the struct, initializes `created_at`, `has_generated_title`, `current_turn_id`, `has_unread_turn`, and `denormalized_metadata` to `None`, and returns the new `TaskResponse`.

**Call relations**: This constructor supports manual instantiation of the generated response model. It is standalone, with later serialization and field access handled by the derived trait implementations and consuming code.


### Configuration delivery payloads
These generated types describe delivered configuration files and TOML fragment bundles returned by the backend.

### `codex-backend-openapi-models/src/models/config_bundle_response.rs`

`generated` · `cross-cutting`

This generated file defines `ConfigBundleResponse`, a small serde model used when the backend returns one or both configuration documents as nested objects. Both fields, `config_toml` and `requirements_toml`, use the type `Option<Option<Box<...>>>` with `serde_with::rust::double_option`. That representation preserves the distinction between a field omitted from the response entirely, a field explicitly set to `null`, and a field present with a concrete nested `DeliveredConfigToml` or `DeliveredRequirementsToml` object. Because `skip_serializing_if = "Option::is_none"` is applied to the outer option, absent values are not emitted during serialization.

The file contains no custom parsing or validation logic; serde attributes carry the schema semantics. Derived traits provide cloning, debugging, equality comparison, defaults, and serialization support. The constructor simply returns an empty bundle with both optional documents absent, which is the minimal baseline state for this response type. Callers that need to represent explicit nulls or actual delivered TOML fragments must set the nested options themselves after construction.

#### Function details

##### `ConfigBundleResponse::new`  (lines 34–39)

```
fn new() -> ConfigBundleResponse
```

**Purpose**: Constructs an empty configuration bundle response with neither `config_toml` nor `requirements_toml` present.

**Data flow**: It takes no arguments, initializes `config_toml` to `None` and `requirements_toml` to `None`, and returns the resulting `ConfigBundleResponse`.

**Call relations**: As the only function in the file, it serves as the default explicit constructor for callers that want to start from an all-absent bundle and populate fields later if needed.


### `codex-backend-openapi-models/src/models/config_file_response.rs`

`generated` · `cross-cutting`

This file defines `ConfigFileResponse`, a straightforward generated serde struct representing one configuration file and its metadata. All four fields are optional strings: `contents`, `sha256`, `updated_at`, and `updated_by_user_id`. Each field is serialized under its corresponding JSON key and omitted entirely when `None`, which lets the backend distinguish between known and unavailable metadata without introducing nested option semantics. Unlike some neighboring generated models, this type does not use `double_option`; there are only two states per field: present with a string or absent.

The struct derives `Clone`, `Default`, `Debug`, `PartialEq`, `Serialize`, and `Deserialize`, making it suitable for transport and comparison but intentionally behavior-light. Its constructor accepts all four optional values directly and stores them unchanged, so callers can build fully populated responses or sparse partial ones in a single step. There is no checksum verification, timestamp parsing, or content normalization in this file; it is purely the schema-level representation of the API response.

#### Function details

##### `ConfigFileResponse::new`  (lines 27–39)

```
fn new(
        contents: Option<String>,
        sha256: Option<String>,
        updated_at: Option<String>,
        updated_by_user_id: Option<String>,
    ) -> ConfigFileResponse
```

**Purpose**: Creates a `ConfigFileResponse` from caller-supplied optional file contents and metadata fields without applying any transformation.

**Data flow**: It takes four arguments — `contents`, `sha256`, `updated_at`, and `updated_by_user_id`, each `Option<String>` — assigns them directly to the identically named struct fields, and returns the constructed `ConfigFileResponse`.

**Call relations**: This constructor is the file’s only behavior and acts as a thin convenience wrapper over direct struct initialization for generated API model usage.


### `codex-backend-openapi-models/src/models/delivered_toml_fragment.rs`

`data_model` · `request/response serialization`

This file declares `DeliveredTomlFragment`, a simple generated schema object with three required string fields: `id`, `name`, and `contents`. The serde annotations pin the serialized field names to the API contract, and the derive list (`Clone`, `Default`, `Debug`, `PartialEq`, `Serialize`, `Deserialize`) makes the type usable as a plain transport struct in both client and server code. Unlike richer domain types, this model does not interpret or validate the TOML text in `contents`; it preserves exactly what the API sends or expects.

The constructor requires all three fields up front, reflecting that none of them are optional in the schema. That design forces callers to provide a complete fragment object rather than constructing a partially initialized value. Because the file contains no parsing, formatting, or mutation helpers, its role is to carry fragment metadata and body text intact between layers. In practice, instances of this type are embedded in higher-level payloads such as delivered requirements collections, where the distinction between fragment identity (`id`), human-readable label (`name`), and actual TOML source (`contents`) matters for downstream display or assembly.

#### Function details

##### `DeliveredTomlFragment::new`  (lines 25–27)

```
fn new(id: String, name: String, contents: String) -> DeliveredTomlFragment
```

**Purpose**: Builds a fully populated TOML fragment model from its required fields. It is the straightforward constructor for this generated schema type.

**Data flow**: It consumes three `String` arguments—`id`, `name`, and `contents`—and moves them directly into a new `DeliveredTomlFragment`. It returns that struct without modifying any external state or performing validation.

**Call relations**: This constructor is a leaf utility for callers assembling API payloads that include TOML fragments. It does not branch or delegate; it simply packages the provided values into the generated model.


### `codex-backend-openapi-models/src/models/delivered_config_toml.rs`

`generated` · `cross-cutting`

This file defines `DeliveredConfigToml`, a generated serde model used inside larger configuration bundle responses. Its single field, `enterprise_managed`, is typed as `Option<Option<Vec<models::DeliveredTomlFragment>>>` and annotated with `serde_with::rust::double_option`. That means the model can preserve three wire-level states for the `enterprise_managed` key: omitted entirely, explicitly present as `null`, or present with a concrete vector of `DeliveredTomlFragment` entries. The outer option is skipped during serialization when `None`, matching the OpenAPI schema’s optional-field semantics.

The struct derives the standard generated traits and contains no parsing or merge logic for TOML fragments; it is only the transport representation. The constructor returns an instance with `enterprise_managed` absent, which is the minimal empty state. Any actual fragment list or explicit null must be assigned by callers after construction. Because this file is a leaf generated model, all meaningful behavior around interpreting or combining delivered TOML content lives elsewhere in the system.

#### Function details

##### `DeliveredConfigToml::new`  (lines 27–31)

```
fn new() -> DeliveredConfigToml
```

**Purpose**: Constructs an empty `DeliveredConfigToml` with no `enterprise_managed` fragments present.

**Data flow**: It takes no arguments, sets `enterprise_managed` to `None`, and returns the resulting `DeliveredConfigToml` value.

**Call relations**: This is the file’s only function and serves as the default constructor for the generated model before callers optionally attach fragment data.


### `codex-backend-openapi-models/src/models/delivered_requirements_toml.rs`

`data_model` · `request/response serialization`

This file contains a single generated data model, `DeliveredRequirementsToml`, representing a response or nested payload that may include enterprise-managed TOML fragments. Its only field, `enterprise_managed`, is typed as `Option<Option<Vec<models::DeliveredTomlFragment>>>`, which is a deliberate three-state encoding used by the OpenAPI generator together with `serde_with::rust::double_option`: `None` means the field was absent, `Some(None)` means the field was explicitly present as `null`, and `Some(Some(vec))` means a concrete list of `DeliveredTomlFragment` values was supplied. The serde attributes also rename the field to `enterprise_managed` in serialized form and omit it entirely when the outer option is `None`.

The struct derives `Clone`, `Default`, `Debug`, `PartialEq`, `Serialize`, and `Deserialize`, making it suitable as a passive transport object across API boundaries. The constructor does not populate any fragments; it creates the schema in its minimal absent-field state by setting `enterprise_managed` to `None`. There is no validation, normalization, or TOML parsing here—the file’s responsibility is strictly to preserve the wire-level shape and nullability semantics of the API contract.

#### Function details

##### `DeliveredRequirementsToml::new`  (lines 27–31)

```
fn new() -> DeliveredRequirementsToml
```

**Purpose**: Constructs an empty `DeliveredRequirementsToml` with no `enterprise_managed` field present. It provides the generated model’s minimal default wire representation.

**Data flow**: It takes no arguments and reads no external state. It allocates and returns a `DeliveredRequirementsToml` whose `enterprise_managed` field is initialized to `None`, meaning the field is absent rather than null or an empty list.

**Call relations**: This is a leaf constructor on a generated model. It is used when callers need to instantiate the payload before optionally filling in `enterprise_managed`; it delegates to no other helper.


### Thread-config protobuf bindings
This generated protobuf module provides the wire messages and gRPC service definitions for remote thread-config loading.

### `config/src/thread_config/proto/codex.thread_config.v1.rs`

`generated` · `request handling`

This generated file is the transport contract for fetching thread configuration over gRPC. Its message types mirror the domain concepts used elsewhere in config loading: `LoadThreadConfigRequest` carries optional `thread_id` and `cwd`; `LoadThreadConfigResponse` returns an ordered `Vec<ThreadConfigSource>`; `ThreadConfigSource` is a `oneof` wrapper around either `SessionThreadConfig` or `UserThreadConfig`. `SessionThreadConfig` contains an optional default `model_provider`, a repeated list of `ModelProvider` records, and a `HashMap<String, bool>` of feature flags. `ModelProvider` is the densest payload, carrying endpoint/auth/header/retry/websocket settings plus a numeric `wire_api` enum field. `StringMap` wraps string-to-string maps for query params and headers, and `ModelProviderAuthInfo` describes an external auth command invocation.

The tonic client wrapper stores `tonic::client::Grpc<T>` and exposes builder-style configuration for origin, interceptor, compression, and message-size limits before issuing the unary `Load` RPC. The server wrapper stores the implementation behind `Arc<T>`, tracks accepted/sent compression encodings and optional message-size caps, and dispatches incoming HTTP requests by exact gRPC path. Unknown paths return a gRPC `Unimplemented` response. Because this file is generated, its logic is mostly glue: enum/string conversion, request metadata insertion, readiness checks, and tonic codec setup rather than domain validation.

#### Function details

##### `WireApi::as_str_name`  (lines 109–114)

```
fn as_str_name(&self) -> &'static str
```

**Purpose**: Returns the protobuf field-name spelling for a `WireApi` enum variant. The strings are the stable wire-schema identifiers, not Rust-friendly names.

**Data flow**: Reads `self` and matches it against `WireApi::Unspecified` and `WireApi::Responses` → selects the corresponding static string literal → returns `&'static str` without mutating any state.

**Call relations**: Used by callers that need protobuf enum names rather than numeric values, typically for serialization-adjacent or diagnostic code generated around the schema; it is a leaf helper in this file.


##### `WireApi::from_str_name`  (lines 116–122)

```
fn from_str_name(value: &str) -> ::core::option::Option<Self>
```

**Purpose**: Parses a protobuf enum field-name string back into a `WireApi` variant. It only accepts the exact schema names emitted by the proto definition.

**Data flow**: Consumes `value: &str` → matches exact literals `WIRE_API_UNSPECIFIED` and `WIRE_API_RESPONSES` → returns `Some(WireApi)` for known names or `None` for anything else.

**Call relations**: Acts as the inverse of `WireApi::as_str_name` for code paths that receive textual enum names; it does not delegate further.


##### `thread_config_loader_client::ThreadConfigLoaderClient::connect`  (lines 141–148)

```
async fn connect(dst: D) -> Result<Self, tonic::transport::Error>
```

**Purpose**: Builds a transport-backed gRPC client by opening a `tonic::transport::Channel` to the supplied endpoint. It is the convenience constructor used when the caller has a URI-like destination rather than an already-built service.

**Data flow**: Takes `dst` convertible into `tonic::transport::Endpoint` → constructs an endpoint, asynchronously connects it to obtain a `Channel` → wraps that channel with `Self::new` → returns `Result<ThreadConfigLoaderClient<Channel>, tonic::transport::Error>`.

**Call relations**: Invoked by higher-level remote loaders before issuing RPCs. Internally it delegates endpoint creation/connection to tonic transport and then funnels the result through the client `new` constructor.

*Call graph*: 2 external calls (new, new).


##### `thread_config_loader_client::ThreadConfigLoaderClient::new`  (lines 157–160)

```
fn new(inner: T) -> Self
```

**Purpose**: Wraps an arbitrary tonic-compatible transport/service in the generated client type. This is the base constructor for callers that already manage the underlying service.

**Data flow**: Accepts `inner: T` → converts it into `tonic::client::Grpc<T>` → stores it in `Self { inner }` → returns the initialized client.

**Call relations**: Used by `connect` after opening a channel and by interceptor/origin constructors to normalize all client creation through the same wrapper.

*Call graph*: 1 external calls (new).


##### `thread_config_loader_client::ThreadConfigLoaderClient::with_origin`  (lines 161–164)

```
fn with_origin(inner: T, origin: Uri) -> Self
```

**Purpose**: Constructs a client that sends requests with an explicit origin URI. This is useful when the transport target and logical origin need to differ.

**Data flow**: Takes `inner: T` and `origin: Uri` → builds `tonic::client::Grpc::with_origin(inner, origin)` → returns `Self` containing that configured gRPC client.

**Call relations**: Alternative constructor alongside `new`; it delegates origin handling to tonic and is chosen by callers that need custom authority/origin behavior.

*Call graph*: 1 external calls (with_origin).


##### `thread_config_loader_client::ThreadConfigLoaderClient::with_interceptor`  (lines 165–182)

```
fn with_interceptor(
            inner: T,
            interceptor: F,
        ) -> ThreadConfigLoaderClient<InterceptedService<T, F>>
```

**Purpose**: Builds a client whose requests pass through a tonic interceptor. This enables cross-cutting request mutation such as auth metadata injection.

**Data flow**: Consumes `inner: T` and an interceptor `F` → wraps them in `InterceptedService::new(inner, interceptor)` → passes that wrapped service into `ThreadConfigLoaderClient::new` → returns a client specialized on `InterceptedService<T, F>`.

**Call relations**: Chosen by callers that need per-request interception. It composes tonic’s interceptor wrapper with the standard client constructor rather than implementing request mutation itself.

*Call graph*: 2 external calls (new, new).


##### `thread_config_loader_client::ThreadConfigLoaderClient::send_compressed`  (lines 188–191)

```
fn send_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Enables outbound request compression on the client. The setting is stored in the inner tonic client and returned in builder style.

**Data flow**: Takes ownership of `self` plus a `CompressionEncoding` → mutates `self.inner` via tonic’s `send_compressed` → returns the updated client.

**Call relations**: Typically chained during client setup before `load`; it delegates compression configuration entirely to tonic.

*Call graph*: 1 external calls (send_compressed).


##### `thread_config_loader_client::ThreadConfigLoaderClient::accept_compressed`  (lines 194–197)

```
fn accept_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Configures the client to accept compressed responses from the server. This affects response decoding behavior for subsequent RPCs.

**Data flow**: Consumes `self` and an encoding → updates `self.inner` with tonic’s `accept_compressed` setting → returns the modified client.

**Call relations**: Another builder-stage configuration method used before issuing RPCs; it simply forwards to tonic’s transport machinery.

*Call graph*: 1 external calls (accept_compressed).


##### `thread_config_loader_client::ThreadConfigLoaderClient::max_decoding_message_size`  (lines 202–205)

```
fn max_decoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets an upper bound on decoded response size for this client. It overrides tonic’s default 4 MB decode limit.

**Data flow**: Consumes `self` and `limit: usize` → applies `max_decoding_message_size` to `self.inner` → returns the updated client.

**Call relations**: Used during client construction when larger responses are expected; it delegates enforcement to tonic.

*Call graph*: 1 external calls (max_decoding_message_size).


##### `thread_config_loader_client::ThreadConfigLoaderClient::max_encoding_message_size`  (lines 210–213)

```
fn max_encoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets an upper bound on encoded request size for this client. This constrains how large outbound protobuf payloads may be.

**Data flow**: Consumes `self` and `limit: usize` → applies `max_encoding_message_size` to `self.inner` → returns the updated client.

**Call relations**: Builder-stage companion to the decode limit setter; it is not involved in request semantics beyond transport sizing.

*Call graph*: 1 external calls (max_encoding_message_size).


##### `thread_config_loader_client::ThreadConfigLoaderClient::load`  (lines 214–232)

```
async fn load(
            &mut self,
            request: impl tonic::IntoRequest<super::LoadThreadConfigRequest>,
        ) -> std::result::Result<tonic::Response<super::LoadThreadConfigResponse>, t
```

**Purpose**: Issues the unary `Load` RPC against the remote `ThreadConfigLoader` service. It prepares tonic metadata, verifies readiness, and dispatches the protobuf request to the fixed service path.

**Data flow**: Accepts any `request` convertible into `tonic::Request<LoadThreadConfigRequest>` → awaits `self.inner.ready()` and maps readiness failures into `tonic::Status::unknown` → creates a default `tonic_prost::ProstCodec`, fixed `PathAndQuery` for `/codex.thread_config.v1.ThreadConfigLoader/Load`, and inserts `GrpcMethod` metadata into request extensions → performs `self.inner.unary(req, path, codec).await` → returns `Result<Response<LoadThreadConfigResponse>, tonic::Status>`.

**Call relations**: This is the client’s main RPC entrypoint, called by higher-level remote config loaders after constructing a request. It delegates transport readiness and unary invocation to tonic.

*Call graph*: 6 external calls (ready, unary, new, into_request, from_static, default).


##### `thread_config_loader_server::ThreadConfigLoaderServer::new`  (lines 262–264)

```
fn new(inner: T) -> Self
```

**Purpose**: Constructs a server wrapper around a concrete `ThreadConfigLoader` implementation. It stores the implementation behind an `Arc` and initializes default transport settings.

**Data flow**: Takes `inner: T` → wraps it in `Arc::new(inner)` → forwards to `Self::from_arc` → returns the configured server wrapper.

**Call relations**: Used by server bootstrap code when registering the service with tonic’s `Server::builder`; it centralizes setup through `from_arc`.

*Call graph*: 2 external calls (new, from_arc).


##### `thread_config_loader_server::ThreadConfigLoaderServer::from_arc`  (lines 265–273)

```
fn from_arc(inner: Arc<T>) -> Self
```

**Purpose**: Constructs the server wrapper from an already-shared `Arc<T>`. This avoids an extra allocation when the implementation is already reference-counted.

**Data flow**: Accepts `inner: Arc<T>` → builds `Self` with that `inner`, default compression-encoding sets, and `None` message-size limits → returns the server.

**Call relations**: Called by `new` and available to callers that already manage shared ownership of the service implementation.

*Call graph*: 1 external calls (default).


##### `thread_config_loader_server::ThreadConfigLoaderServer::with_interceptor`  (lines 274–279)

```
fn with_interceptor(inner: T, interceptor: F) -> InterceptedService<Self, F>
```

**Purpose**: Wraps the generated server in a tonic interceptor service. This allows request inspection or metadata enforcement before dispatch reaches the trait implementation.

**Data flow**: Consumes `inner: T` and interceptor `F` → constructs `Self::new(inner)` → wraps it with `InterceptedService::new` → returns the intercepted service.

**Call relations**: Alternative to plain `new` during server registration when cross-cutting interception is required.

*Call graph*: 2 external calls (new, new).


##### `thread_config_loader_server::ThreadConfigLoaderServer::accept_compressed`  (lines 282–285)

```
fn accept_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Enables decompression of incoming compressed requests on the server. The chosen encoding is recorded in the server’s accepted-encodings set.

**Data flow**: Consumes `self` and `encoding` → mutates `self.accept_compression_encodings` by enabling that encoding → returns the updated server wrapper.

**Call relations**: Used during server setup before registration; it affects how `call` later configures tonic’s per-request gRPC handler.

*Call graph*: 1 external calls (enable).


##### `thread_config_loader_server::ThreadConfigLoaderServer::send_compressed`  (lines 288–291)

```
fn send_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Enables compression of outgoing responses when the client supports the selected encoding. The setting is stored for later use during request dispatch.

**Data flow**: Consumes `self` and `encoding` → enables that encoding in `self.send_compression_encodings` → returns the modified server.

**Call relations**: Builder-stage transport configuration consumed later by `call` when constructing the tonic `Grpc` handler.

*Call graph*: 1 external calls (enable).


##### `thread_config_loader_server::ThreadConfigLoaderServer::max_decoding_message_size`  (lines 296–299)

```
fn max_decoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets the maximum inbound message size the server will decode. This overrides tonic’s default decode limit for requests.

**Data flow**: Consumes `self` and `limit: usize` → stores `Some(limit)` in `self.max_decoding_message_size` → returns the updated server.

**Call relations**: Configured before serving; the stored limit is later applied inside `call` when dispatching a matching RPC.


##### `thread_config_loader_server::ThreadConfigLoaderServer::max_encoding_message_size`  (lines 304–307)

```
fn max_encoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets the maximum outbound message size the server will encode. This constrains response payload size at the transport layer.

**Data flow**: Consumes `self` and `limit: usize` → stores `Some(limit)` in `self.max_encoding_message_size` → returns the updated server.

**Call relations**: Another setup-time knob whose value is consumed by `call` when constructing the tonic gRPC responder.


##### `thread_config_loader_server::ThreadConfigLoaderServer::poll_ready`  (lines 318–323)

```
fn poll_ready(
            &mut self,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>>
```

**Purpose**: Reports the generated service as always ready to accept requests. The wrapper itself has no internal backpressure state.

**Data flow**: Ignores the task context argument → immediately returns `Poll::Ready(Ok(()))`.

**Call relations**: Called by the surrounding hyper/tonic service machinery before dispatching requests; it does not delegate to the inner implementation.

*Call graph*: 1 external calls (Ready).


##### `thread_config_loader_server::ThreadConfigLoaderServer::call`  (lines 324–381)

```
fn call(&mut self, req: http::Request<B>) -> Self::Future
```

**Purpose**: Routes incoming HTTP requests to the generated gRPC method handler or returns an `Unimplemented` gRPC response for unknown paths. For the `Load` path it builds a unary service adapter around the user-implemented trait method and applies compression and message-size settings.

**Data flow**: Takes `req: http::Request<B>` → inspects `req.uri().path()` → if the path matches `/codex.thread_config.v1.ThreadConfigLoader/Load`, clones the inner `Arc<T>` and current compression/size settings, constructs a local `LoadSvc` implementing `tonic::server::UnaryService<LoadThreadConfigRequest>`, creates a default `ProstCodec`, builds `tonic::server::Grpc`, applies compression and max-message-size config, and awaits `grpc.unary(method, req)` inside a boxed future returning `Ok(http::Response<tonic::body::Body>)`; otherwise constructs a default empty body response with gRPC status `Unimplemented` and content type headers and returns it in a boxed future.

**Call relations**: This is the central server dispatch point invoked by tonic/hyper for every inbound request. On the happy path it delegates actual business handling to the implementor’s `ThreadConfigLoader::load`; on unmatched paths it short-circuits locally.

*Call graph*: 6 external calls (pin, uri, new, default, new, default).


##### `thread_config_loader_server::ThreadConfigLoaderServer::clone`  (lines 384–393)

```
fn clone(&self) -> Self
```

**Purpose**: Duplicates the generated server wrapper while preserving shared access to the same inner implementation and transport settings. Cloning is shallow because the implementation is stored in an `Arc`.

**Data flow**: Reads `self.inner`, compression settings, and message-size options → clones the `Arc` and copies the remaining fields → returns a new `ThreadConfigLoaderServer<T>`.

**Call relations**: Used by tonic service infrastructure when the server wrapper must be duplicated across tasks or connections; it does not alter the underlying implementation.


### Exec relay protobuf bindings
These files expose the generated relay protocol types and the small handwritten wrapper that re-exports the subset used by exec-server.

### `exec-server/src/proto/codex.exec_server.relay.v1.rs`

`generated` · `relay transport serialization/deserialization`

This file is generated code from `prost-build`, so it mirrors the protobuf schema directly rather than expressing handwritten domain logic. The top-level message is `RelayMessageFrame`, which carries protocol bookkeeping (`version`, `stream_id`, `ack`, `ack_bits`) plus a `oneof` body. That body can be one of six message variants exposed through the nested `relay_message_frame::Body` enum: `Data`, `AckFrame`, `Resume`, `Reset`, `Heartbeat`, or `Handshake`.

The payload messages are intentionally compact. `RelayData` carries a sequence number, segmentation metadata (`segment_index`, `segment_count`), and raw bytes, allowing larger logical payloads to be split across frames. `RelayAck` and `RelayHeartbeat` are empty marker messages. `RelayResume` communicates the next expected sequence number after interruption. `RelayReset` carries a textual reason for tearing down or invalidating a stream. `RelayHandshake` wraps opaque handshake bytes, likely for session establishment or cryptographic negotiation at a higher layer.

Because this is generated, field tags, derives, and naming are schema-driven. Consumers should treat these structs as wire containers: they preserve protobuf compatibility and are typically wrapped by higher-level relay code rather than manipulated as business objects. Any schema evolution should happen in the `.proto` source, not here.


### `exec-server/src/relay_proto.rs`

`orchestration` · `relay transport type wiring`

This module is a narrow adapter over the generated protobuf output in `proto/codex.exec_server.relay.v1.rs`. Using `#[path = ...] mod generated;`, it binds the generated file into the crate without exposing that long generated-module path everywhere else. It then selectively re-exports the relay protocol types with crate visibility: `RelayData`, `RelayHandshake`, `RelayMessageFrame`, `RelayReset`, `RelayResume`, and the nested `relay_message_frame` module that contains the `Body` oneof enum.

The omission of some generated types from re-export is itself informative. For example, empty marker messages such as ack/heartbeat may be accessed through the generated module internally elsewhere or may not need direct exposure from this facade. The wrapper keeps the rest of the codebase insulated from generated-file naming and location details, which makes regeneration or path changes less invasive.

There is no runtime behavior here; the file’s role is namespace control and dependency hygiene. Higher-level relay code can import concise crate-local names from `relay_proto` instead of depending directly on the generated module layout, while the generated code remains clearly isolated as machine-produced wire definitions.
