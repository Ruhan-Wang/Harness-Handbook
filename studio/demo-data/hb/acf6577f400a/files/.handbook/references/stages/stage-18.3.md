# Generated backend and protobuf contracts  `stage-18.3`

This stage is shared behind-the-scenes support. It is the system’s set of “forms” that different parts agree to fill out the same way. Most of it is generated from contracts: OpenAPI for web JSON APIs, and protobuf/gRPC for compact service messages sent between programs.

The backend client types describe the data the Codex backend sends back, such as accounts, usage limits, tasks, diffs, messages, errors, and token counts, with helpers to turn awkward responses into readable text. The OpenAPI crate exposes generated model modules, then gathers the needed types in one place. Those models cover rate limits, credit and spend controls, task details and task lists, pull requests, paginated results, and delivered configuration files or TOML fragments.

The protobuf files do the same job for internal services. The thread-config file defines requests, responses, and provider settings for asking another component for configuration. The exec-server relay file defines messages for handshakes, heartbeats, reconnects, resets, acknowledgements, and data transfer. The relay wrapper hides the generated details behind cleaner names.

## Files in this stage

### Backend type facade
These files introduce the handwritten backend-facing type layer and the generated model crate surface it builds on.

### `backend-client/src/types.rs`

`data_model` · `response parsing and task display`

This file is the backend client's translation layer for several API responses. When the client asks the server for account status, task details, rate limit information, or token usage, the answer comes back as JSON. JSON is just structured text, so this file describes how that text should be turned into Rust values the rest of the program can safely use.

Some of the backend responses are not perfectly uniform. For example, account data may arrive either as a list or as a map keyed by account id. This file accepts both shapes and normalizes them into one cleaner form. It does something similar for task details: generated OpenAPI types were not good enough here, so the file defines hand-written models for turns, messages, content fragments, diffs, worklogs, and errors.

The helper methods are like a clerk sorting a messy inbox. They pull out the important human-facing pieces: the assistant's text, the user's prompt, a unified diff, or a readable error message. They also ignore empty text and tolerate missing fields, which makes the client more robust when the backend omits optional data.

#### Function details

##### `RawAccounts::default`  (lines 91–93)

```
fn default() -> Self
```

**Purpose**: Provides the fallback value for account data when the backend does not include an accounts field. It treats missing accounts as an empty list rather than as an error.

**Data flow**: No outside data comes in. It creates a RawAccounts value containing an empty vector, so later parsing code can continue as if the server simply returned no accounts.

**Call relations**: This is used by deserialization when RawAccountsCheckResponse is built from JSON and the accounts field is absent. It supports AccountsCheckResponse::deserialize by giving that function a safe starting point.

*Call graph*: 2 external calls (List, new).


##### `AccountsCheckResponse::deserialize`  (lines 113–139)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Turns the backend's account-check JSON into the cleaner AccountsCheckResponse shape used by the client. It exists because the backend can send accounts in more than one format.

**Data flow**: It receives raw JSON through Serde, Rust's serialization and deserialization library. First it reads the JSON into RawAccountsCheckResponse. If accounts are already a list, it keeps them. If accounts are a map, it walks through account_ordering, looks up each account, pulls out the nested account information, and builds AccountEntry values. The result is one AccountsCheckResponse with accounts, ordering, and the default account id.

**Call relations**: Serde calls this custom deserializer whenever code asks to parse an AccountsCheckResponse. It hands off the first parsing step to RawAccountsCheckResponse::deserialize, then performs the normalization that ordinary generated parsing could not do.

*Call graph*: 1 external calls (deserialize).


##### `ContentFragment::text`  (lines 245–267)

```
fn text(&self) -> Option<&str>
```

**Purpose**: Extracts useful text from one piece of message content. It filters out non-text structured content and empty plain strings.

**Data flow**: It reads one ContentFragment. If the fragment is structured, it only returns text when its content_type says it is text and the text is not empty. If the fragment is a raw string, it returns it only when it is not just whitespace. The output is either a borrowed text slice or nothing.

**Call relations**: TurnItem::text_values and WorklogMessage::text_values rely on this method to avoid repeating the rules for what counts as real text. It is the small gatekeeper that keeps empty or non-text fragments out of user-facing output.


##### `TurnItem::text_values`  (lines 271–276)

```
fn text_values(&self) -> Vec<String>
```

**Purpose**: Collects all meaningful text pieces from a single turn item. A turn item can contain several content fragments, so this gathers them into a simple list of strings.

**Data flow**: It reads the item's content list. For each ContentFragment, it asks ContentFragment::text whether there is usable text. It copies each usable piece into a String and returns the list.

**Call relations**: Turn::message_texts and Turn::user_prompt use this when they need the text inside message items. It delegates the fine-grained filtering to ContentFragment::text.


##### `TurnItem::diff_text`  (lines 278–293)

```
fn diff_text(&self) -> Option<String>
```

**Purpose**: Finds a code diff inside a turn item, if that item represents one. A diff is the patch-style text showing what changed in files.

**Data flow**: It reads the item's kind and diff-related fields. If the kind is output_diff, it returns the direct diff field when it is not empty. If the kind is pr, it looks inside output_diff.diff and returns that when present. If neither shape contains a real diff, it returns nothing.

**Call relations**: Turn::unified_diff calls this across output items to find the first available patch. This method hides the fact that the backend may store diff text in different places depending on item type.


##### `Turn::unified_diff`  (lines 297–299)

```
fn unified_diff(&self) -> Option<String>
```

**Purpose**: Gets the first available unified diff from a turn's output items. A unified diff is the common patch format used by tools like git.

**Data flow**: It reads the turn's output_items in order. For each item, it asks TurnItem::diff_text whether that item contains a usable diff. It returns the first diff it finds, or nothing if none of the items contain one.

**Call relations**: CodeTaskDetailsResponse::unified_diff calls this on the current diff task turn and assistant turn. This method is the turn-level search step between the full task response and individual output items.


##### `Turn::message_texts`  (lines 301–318)

```
fn message_texts(&self) -> Vec<String>
```

**Purpose**: Collects assistant-facing text messages from a turn. It looks both at normal output message items and at assistant messages stored in the worklog.

**Data flow**: It starts with an empty list. It reads output_items, keeps only items whose kind is message, and adds their text values. Then, if there is a worklog, it scans each worklog message, keeps only messages written by the assistant, and adds their text values too. It returns the combined list of strings.

**Call relations**: CodeTaskDetailsResponse::assistant_text_messages calls this for the current diff task turn and assistant turn. Inside the worklog path, it uses WorklogMessage::is_assistant and WorklogMessage::text_values to decide what to include.


##### `Turn::user_prompt`  (lines 320–343)

```
fn user_prompt(&self) -> Option<String>
```

**Purpose**: Extracts the user's prompt text from a turn. It joins multiple prompt parts with blank lines so the result reads like a single message.

**Data flow**: It reads input_items, keeps message items, and only includes items whose role is user or whose role is missing. It collects their text values. If there are no parts, it returns nothing. Otherwise, it joins the parts with two newline characters and returns the combined prompt.

**Call relations**: CodeTaskDetailsResponse::user_text_prompt calls this on the current user turn. It uses TurnItem::text_values to handle the content fragments inside each input item.


##### `Turn::error_summary`  (lines 345–347)

```
fn error_summary(&self) -> Option<String>
```

**Purpose**: Returns a readable error message for a turn if the turn has an error. It keeps callers from needing to inspect the error object directly.

**Data flow**: It looks at the turn's optional error field. If an error is present, it asks TurnError::summary to turn the code and message into one string. If there is no error, it returns nothing.

**Call relations**: CodeTaskDetailsResponse::assistant_error_message uses this on the current assistant turn. It is the bridge from task-level error lookup to TurnError's formatting rule.


##### `WorklogMessage::is_assistant`  (lines 351–357)

```
fn is_assistant(&self) -> bool
```

**Purpose**: Checks whether a worklog message was written by the assistant. This matters because only assistant worklog text should be shown as assistant output.

**Data flow**: It reads the optional author and the author's optional role. If the role exists and equals assistant, ignoring letter case, it returns true. Missing author, missing role, or any other role returns false.

**Call relations**: Turn::message_texts uses this while scanning a worklog. It acts as the filter that separates assistant messages from other worklog entries.


##### `WorklogMessage::text_values`  (lines 359–370)

```
fn text_values(&self) -> Vec<String>
```

**Purpose**: Collects meaningful text fragments from a worklog message. It safely returns an empty list when the message has no content.

**Data flow**: It reads the message's optional content. If content exists, it walks through content.parts and uses ContentFragment::text to keep only usable text, returning those pieces as strings. If content is missing, it returns an empty vector.

**Call relations**: Turn::message_texts calls this after WorklogMessage::is_assistant confirms the message came from the assistant. It reuses ContentFragment::text so worklog text follows the same filtering rules as normal message text.


##### `TurnError::summary`  (lines 374–383)

```
fn summary(&self) -> Option<String>
```

**Purpose**: Turns an error code and error message into one readable string. It avoids showing awkward empty pieces when only one part is present.

**Data flow**: It reads the optional code and message, treating missing values as empty strings. If both are empty, it returns nothing. If only one is present, it returns that one. If both are present, it returns them as "code: message".

**Call relations**: Turn::error_summary calls this when a turn contains an error. It uses formatting to combine both fields in the common case where the backend provides both a machine-style code and a human-readable message.

*Call graph*: 1 external calls (format!).


##### `CodeTaskDetailsResponse::unified_diff`  (lines 398–406)

```
fn unified_diff(&self) -> Option<String>
```

**Purpose**: Finds the most relevant code diff in a task-details response. It prefers the dedicated diff task turn, then falls back to the assistant turn.

**Data flow**: It looks at current_diff_task_turn first and current_assistant_turn second. For each present turn, it asks Turn::unified_diff for a patch. It returns the first patch found, or nothing if neither turn contains one.

**Call relations**: This is part of the CodeTaskDetailsResponseExt trait implementation, giving callers a simple task-level method instead of making them know where diffs may be stored. It hands the detailed search to Turn::unified_diff.


##### `CodeTaskDetailsResponse::assistant_text_messages`  (lines 408–420)

```
fn assistant_text_messages(&self) -> Vec<String>
```

**Purpose**: Collects assistant text messages from the task-details response. It gives the rest of the client a plain list of assistant-visible text, separate from diffs.

**Data flow**: It creates an empty list. It checks the current diff task turn and current assistant turn, skipping any that are missing. For each present turn, it appends the result of Turn::message_texts. The output is one combined vector of strings.

**Call relations**: This method is exposed through CodeTaskDetailsResponseExt for higher-level display code. It delegates per-turn extraction to Turn::message_texts, which in turn reads output items and assistant worklog messages.

*Call graph*: 1 external calls (new).


##### `CodeTaskDetailsResponse::user_text_prompt`  (lines 422–424)

```
fn user_text_prompt(&self) -> Option<String>
```

**Purpose**: Returns the user's prompt from the current user turn, when one exists. It provides a simple way to show or reuse what the user asked.

**Data flow**: It reads current_user_turn. If there is a turn, it asks Turn::user_prompt to extract and join the prompt text. If the user turn is missing or has no prompt text, it returns nothing.

**Call relations**: This is the task-level entry point for prompt extraction in CodeTaskDetailsResponseExt. It hands the actual item filtering and joining to Turn::user_prompt.


##### `CodeTaskDetailsResponse::assistant_error_message`  (lines 426–430)

```
fn assistant_error_message(&self) -> Option<String>
```

**Purpose**: Returns a readable assistant error message from the task response, if the assistant turn failed and reported one.

**Data flow**: It reads current_assistant_turn. If present, it asks Turn::error_summary for the turn's formatted error. If there is no assistant turn or no usable error, it returns nothing.

**Call relations**: This is the task-level error lookup method in CodeTaskDetailsResponseExt. It delegates the turn-specific part to Turn::error_summary, which delegates formatting to TurnError::summary.


##### `deserialize_vec`  (lines 433–439)

```
fn deserialize_vec(deserializer: D) -> Result<Vec<T>, D::Error>
```

**Purpose**: Deserializes a vector field while treating a missing or null value as an empty list. This makes parsing tolerant of backend responses that omit arrays.

**Data flow**: It receives a Serde deserializer for a field that should be a Vec<T>. It first tries to read it as Option<Vec<T>>. If the value is present, it returns the vector. If it is missing or null, it returns an empty vector.

**Call relations**: Several fields in Turn, TurnItem, and Worklog use this helper through serde attributes. During JSON parsing, Serde calls it for those fields so the rest of the code can safely loop over vectors without checking for null.

*Call graph*: 1 external calls (deserialize).


##### `tests::fixture`  (lines 473–480)

```
fn fixture(name: &str) -> CodeTaskDetailsResponse
```

**Purpose**: Loads a named test fixture and parses it as CodeTaskDetailsResponse. It keeps the tests short by centralizing fixture lookup and JSON parsing.

**Data flow**: It receives a fixture name such as diff or error. It chooses the matching JSON file embedded at compile time, panics if the name is unknown, and parses the JSON into CodeTaskDetailsResponse. The parsed response is returned to the test.

**Call relations**: All the tests in this module call this helper before checking extraction behavior. It uses include_str! to read fixture files into the test binary and serde_json::from_str to parse them.

*Call graph*: 3 external calls (include_str!, panic!, from_str).


##### `tests::unified_diff_prefers_current_diff_task_turn`  (lines 483–487)

```
fn unified_diff_prefers_current_diff_task_turn()
```

**Purpose**: Checks that diff extraction finds the expected diff when the current diff task turn contains one. This protects the preference order used by CodeTaskDetailsResponse::unified_diff.

**Data flow**: It loads the diff fixture, calls unified_diff on the parsed details, and expects a diff to be present. It then asserts that the returned text contains a git-style diff marker.

**Call relations**: This test calls tests::fixture to get sample data and then exercises the public extension method. It indirectly covers CodeTaskDetailsResponse::unified_diff, Turn::unified_diff, and TurnItem::diff_text.

*Call graph*: 2 external calls (assert!, fixture).


##### `tests::unified_diff_falls_back_to_pr_output_diff`  (lines 490–494)

```
fn unified_diff_falls_back_to_pr_output_diff()
```

**Purpose**: Checks that diff extraction can fall back to a pull-request-style output_diff payload. This matters because the backend may store patch text in more than one shape.

**Data flow**: It loads the error fixture, calls unified_diff, and expects a diff to be present. It asserts that the returned patch mentions lib.rs, proving the fallback path found the embedded diff.

**Call relations**: This test uses tests::fixture and then calls the task-level unified_diff method. It specifically protects the branch in TurnItem::diff_text that reads output_diff.diff from pr items.

*Call graph*: 2 external calls (assert!, fixture).


##### `tests::assistant_text_messages_extracts_text_content`  (lines 497–501)

```
fn assistant_text_messages_extracts_text_content()
```

**Purpose**: Checks that assistant text extraction returns the expected text and ignores non-text or irrelevant content. It verifies the client can show a clean assistant message.

**Data flow**: It loads the diff fixture, calls assistant_text_messages, and compares the result with a one-item list containing "Assistant response".

**Call relations**: This test calls tests::fixture and the CodeTaskDetailsResponseExt assistant_text_messages method. It indirectly exercises Turn::message_texts, TurnItem::text_values, and ContentFragment::text.

*Call graph*: 2 external calls (assert_eq!, fixture).


##### `tests::user_text_prompt_joins_parts_with_spacing`  (lines 504–513)

```
fn user_text_prompt_joins_parts_with_spacing()
```

**Purpose**: Checks that multiple user prompt fragments are joined with a blank line between them. This keeps reconstructed prompts readable.

**Data flow**: It loads the diff fixture, calls user_text_prompt, and expects a prompt to be present. It then compares the result with two lines joined by two newline characters.

**Call relations**: This test uses tests::fixture and the task-level user_text_prompt method. It protects the joining behavior inside Turn::user_prompt.

*Call graph*: 2 external calls (assert_eq!, fixture).


##### `tests::assistant_error_message_combines_code_and_message`  (lines 516–522)

```
fn assistant_error_message_combines_code_and_message()
```

**Purpose**: Checks that an assistant error with both a code and a message is displayed as one combined string. This protects the readable error format shown to users.

**Data flow**: It loads the error fixture, calls assistant_error_message, and expects an error string to be present. It compares that string with "APPLY_FAILED: Patch could not be applied".

**Call relations**: This test uses tests::fixture and the task-level assistant_error_message method. It indirectly checks Turn::error_summary and TurnError::summary.

*Call graph*: 2 external calls (assert_eq!, fixture).


### `codex-backend-openapi-models/src/lib.rs`

`data_model` · `compile time and whenever code imports API model types`

This file exists to make generated API data shapes available to the rest of the project. An OpenAPI model is a Rust type created from an API description, usually representing request and response data that travels over the network. Instead of hand-writing those types here, a regeneration script fills `src/models/` with generated Rust files and creates `src/models/mod.rs` to connect them together.

This file then re-exports that generated area with `pub mod models;`, which is like putting a clear sign on a cabinet: “the API model definitions are in here.” Other crates can depend on this crate and access those shared data types through the `models` module.

The `allow` line at the top relaxes two lint rules for this crate: it permits generated code to use `unwrap` and `expect`, which are Rust shortcuts that stop the program if a value is missing or invalid. That choice is common for generated code because the generator may produce patterns that would be noisy or impractical to edit by hand. Without this file, the generated model files would exist on disk but would not be exposed as the crate’s public API.


### `codex-backend-openapi-models/src/models/mod.rs`

`data_model` · `cross-cutting`

This file acts like an index page for backend API models. The project has many possible data shapes that can come from an OpenAPI definition, which is a machine-readable description of an HTTP API. Instead of exposing every generated model, this file deliberately keeps a shorter, curated list of only the types the current workspace uses.

Each section groups related models by what they describe. The config section exposes response and TOML-related types, where TOML is a human-readable configuration file format. The cloud task section exposes types used to describe coding tasks, pull requests, and paginated task lists. The rate limit section exposes types that describe usage limits, credit status, spend controls, and limit windows.

The pattern is simple: each `mod` line tells Rust where to find the actual model definition, and each `pub use` line makes that model available from this central `models` module. Without this file, other parts of the codebase would need to know the exact sub-file for every model, which would make imports more scattered and fragile. It is like a neatly labeled shelf: the actual items live in separate boxes, but this file decides which boxes are visible and easy to reach.


### Rate and spend status models
These generated schemas define the nested transport types for rate limits, credit availability, and spend-control reporting consumed by backend responses.

### `codex-backend-openapi-models/src/models/additional_rate_limit_details.rs`

`generated` · `API serialization and deserialization`

This file is a small data definition used when the backend talks through its OpenAPI interface. A rate limit is a rule that restricts how much of something a user or client can use, such as requests, messages, or another metered feature. This object names the limit, names the feature being measured, and may include a detailed status object for the actual limit.

The main type, `AdditionalRateLimitDetails`, is a plain container. It has `limit_name`, which is the human or system name of the limit, and `metered_feature`, which says what usage is being counted. It also has `rate_limit`, which is optional in a careful way: the field may be absent, or it may be present with either a real value or an explicit `null`. That distinction matters in API data, because “not sent” and “sent as empty” can mean different things.

The `serde` annotations tell Rust how to convert this struct to and from JSON, the common text format used by web APIs. Without this file, code using the generated API models would not have a shared, typed way to represent these extra rate-limit details.

#### Function details

##### `AdditionalRateLimitDetails::new`  (lines 31–37)

```
fn new(limit_name: String, metered_feature: String) -> AdditionalRateLimitDetails
```

**Purpose**: Creates a new `AdditionalRateLimitDetails` value with the required fields filled in. It leaves the optional detailed rate-limit status unset, so callers can add it later only when they have that information.

**Data flow**: It takes a `limit_name` and a `metered_feature` as input. It puts those two strings into a new `AdditionalRateLimitDetails` struct and sets `rate_limit` to `None`, meaning no rate-limit detail field is included yet. The finished struct is returned to the caller.

**Call relations**: This is the convenience constructor for this generated model. Other code can call it when building an API response or request object, then optionally fill in `rate_limit` before the value is serialized to JSON or used elsewhere.


### `codex-backend-openapi-models/src/models/credit_status_details.rs`

`generated` · `API request and response serialization`

This is a generated model file, created from the project’s OpenAPI description, which is the contract that says what the backend API sends and expects. Its job is simple but important: describe the fields that make up credit status details in a way Rust can check at compile time.

The main type, `CreditStatusDetails`, is a small data container. It records whether the user has credits, whether their access is unlimited, and optional extra information such as a balance or approximate message counts. The optional fields use a "double option" pattern. In plain terms, this lets the code tell the difference between a field being missing altogether and a field being present but explicitly set to `null`. That matters for APIs, because those two cases can carry different meanings.

The `serde` annotations explain how this struct turns into JSON and back. `serde` is Rust’s common tool for serialization, meaning converting between in-memory values and formats like JSON. Without this file, other parts of the system would have to build and read this credit-status JSON by hand, which would be more error-prone and easier to get out of sync with the API contract.

#### Function details

##### `CreditStatusDetails::new`  (lines 43–51)

```
fn new(has_credits: bool, unlimited: bool) -> CreditStatusDetails
```

**Purpose**: Creates a new credit-status value with the two required facts: whether credits exist and whether access is unlimited. The extra fields start out absent, so callers can fill them in only when they have that information.

**Data flow**: It takes two boolean inputs: `has_credits` and `unlimited`. It places those values into a new `CreditStatusDetails` struct, sets `balance`, `approx_local_messages`, and `approx_cloud_messages` to `None`, and returns the completed struct to the caller.

**Call relations**: The call graph does not show a specific caller for this constructor. In normal use, code that needs to create a credit-status API object would call this first, then optionally add balance or message-count details before the value is serialized into JSON or passed deeper into the backend model layer.


### `codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs`

`generated` · `request handling`

This is a generated model file, meaning it was created from the project’s OpenAPI description rather than handwritten. OpenAPI is a machine-readable contract for an HTTP API: it says what data the API expects and returns. This file is one small piece of that contract in Rust form.

The main type, `RateLimitWindowSnapshot`, is a simple data container. It represents a snapshot of one rate-limit window: how full the window is, how long the window lasts, how many seconds remain until it resets, and the reset time. In everyday terms, it is like a fuel gauge for API usage: it says how much quota has been spent and when the tank refills.

The `serde` annotations connect Rust field names to the JSON field names used over the network. `serde` is the common Rust tool for turning structured data into formats like JSON and back again. Without this file, other code would have to guess or duplicate the exact fields used for rate-limit information, increasing the chance of mismatches between the backend API and the client code.

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

**Purpose**: Creates a new `RateLimitWindowSnapshot` from four integer values. Code uses it when it already knows the rate-limit numbers and wants them packaged into the standard API model.

**Data flow**: The function receives four numbers: the percentage used, the window length in seconds, the seconds until reset, and the reset time. It places those values directly into a new `RateLimitWindowSnapshot` object and returns that object. It does not read outside state or change anything else.

**Call relations**: This constructor is the simple front door for building this model by hand. Other generated or application code can call it when preparing rate-limit data to pass around or serialize to JSON; the returned object can then be sent onward through the API serialization layer.


### `codex-backend-openapi-models/src/models/rate_limit_status_details.rs`

`generated` · `API request and response serialization`

This is a generated OpenAPI model file. In plain terms, it is a small data container for telling a client, “yes, you may do this” or “no, you have hit a limit.” Rate limits are rules that stop someone from making too many requests in a period of time, like a turnstile that only allows a certain number of entries per minute.

The main type, RateLimitStatusDetails, stores two required answers: whether the request is allowed, and whether a limit has been reached. It can also include optional snapshots of two time windows: a primary window and a secondary window. A window snapshot is likely a small report about a counting period, such as how many requests were used and when the count resets.

The optional window fields are intentionally flexible. They can be missing entirely, present with a real snapshot, or present as an explicit null value. That distinction matters in API traffic because “not provided” and “provided but empty” can mean different things.

The file also derives serialization and deserialization support, meaning Rust values can be turned into JSON and JSON can be turned back into Rust values. Without this model, different parts of the backend and its clients would not have a shared, reliable structure for rate-limit status responses.

#### Function details

##### `RateLimitStatusDetails::new`  (lines 38–45)

```
fn new(allowed: bool, limit_reached: bool) -> RateLimitStatusDetails
```

**Purpose**: Creates a new rate-limit status value with the two essential answers: whether the action is allowed and whether the limit has been reached. It starts with no primary or secondary window details attached.

**Data flow**: It receives two boolean values: allowed and limit_reached. It places those into a new RateLimitStatusDetails object, sets both optional window fields to absent, and returns the completed object to the caller.

**Call relations**: Code that needs to build a rate-limit status response can call this constructor first, then optionally fill in the primary_window or secondary_window fields later. This function does not call other project functions; it simply prepares the basic data object for later API serialization or internal use.


### `codex-backend-openapi-models/src/models/spend_control_limit_details.rs`

`data_model` · `request and response serialization`

This file is a small data model. It gives the rest of the backend a dependable container for spend-limit information, like a receipt that says: total allowance, amount already spent, amount still available, percentages, and reset time. Without this shared shape, different parts of the system might disagree about field names or missing values when sending or receiving API data.

The main type is `SpendControlLimitDetails`. It can be converted to and from JSON using Serde, a Rust library for serialization, meaning “turning structured data into a format like JSON” and deserialization, meaning “reading JSON back into structured data.” The field names are explicitly tied to the API names, such as `used_percent` and `reset_after_seconds`, so the JSON stays compatible with clients and servers.

Most fields are required. The `source` field is special: it can be absent, present with a text value, or present as `null`. That distinction matters in APIs because “not mentioned” can mean something different from “intentionally empty.” The `new` function creates a valid record with all required values and leaves `source` unset by default.

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

**Purpose**: Creates a new spend-control limit details record from the required pieces of information. It is a convenience constructor so callers do not have to fill every field by hand.

**Data flow**: The caller provides the limit, used amount, remaining amount, used and remaining percentages, and reset timing values. The function puts those values into a new `SpendControlLimitDetails` object, sets `source` to missing by default, and returns the completed object.

**Call relations**: This constructor is used when some other part of the program needs to build this API model before storing it, returning it, or turning it into JSON. It does not call other project functions; it simply packages the supplied values into the standard data shape expected by the API.


### `codex-backend-openapi-models/src/models/spend_control_status_details.rs`

`data_model` · `request and response serialization`

This is a generated data model, meaning it was produced from the project’s OpenAPI description rather than handwritten business logic. OpenAPI is a machine-readable description of an HTTP API: what requests and responses look like. This file gives Rust code a safe, predictable way to work with one particular API object: `SpendControlStatusDetails`.

The object has two pieces of information. First, `reached` is a simple yes-or-no value that says whether the spend control threshold has been hit. Second, `individual_limit` can carry more detail about a specific spending limit. That field is deliberately wrapped so it can express subtle API states: the field may be missing entirely, present with no value, or present with actual limit details. This matters when talking to an API, because “not sent” and “sent as null” can mean different things.

The `Serialize` and `Deserialize` traits let this structure be converted to and from formats such as JSON. In everyday terms, this file is like a labeled form: it says which boxes exist, which names they use in the API, and how to fill in a new blank copy with the minimum required information.

#### Function details

##### `SpendControlStatusDetails::new`  (lines 29–34)

```
fn new(reached: bool) -> SpendControlStatusDetails
```

**Purpose**: Creates a new spend-control status object when the caller knows whether the limit has been reached. It starts with no individual limit details attached, leaving that optional information to be filled in later if needed.

**Data flow**: The caller gives in one value: `reached`, a true-or-false answer to whether the spend control was hit. The function puts that value into a new `SpendControlStatusDetails` object and sets `individual_limit` to `None`, meaning the individual limit field is not included yet. The result is a ready-to-use status object.

**Call relations**: This constructor is used when other parts of the code need to build this API model before sending it, storing it, or returning it. It does not call out to other functions; it simply creates the data structure in its default minimal form so later code can serialize it or add optional details.


### `codex-backend-openapi-models/src/models/rate_limit_status_payload.rs`

`generated` · `request handling and API serialization`

This file is a data blueprint for rate-limit status information. When the backend needs to send or receive JSON about a user's plan and usage limits, these Rust types describe exactly what fields can appear and what values are allowed. Think of it like a form template: every response must say the plan type, and it may also include details about rate limits, credits, spending controls, extra limits, or the specific reason a limit was reached.

The main type is `RateLimitStatusPayload`. Its required field is `plan_type`, which uses the `PlanType` enum to avoid loose strings like "plus" or "enterprise" being passed around unchecked. The other fields are optional in a careful way: they can be missing entirely, present with a real value, or present as JSON `null`. That distinction matters for APIs because “not provided” and “explicitly empty” can mean different things.

`RateLimitReachedType` and `RateLimitReachedKind` describe why access may have been blocked, such as normal rate limiting, depleted workspace credits, or a usage cap being reached. Unknown values are safely accepted instead of crashing, which helps older clients survive newer server responses. Because this file is generated, developers usually should not edit it by hand; changes should come from the OpenAPI definition.

#### Function details

##### `RateLimitStatusPayload::new`  (lines 57–66)

```
fn new(plan_type: PlanType) -> RateLimitStatusPayload
```

**Purpose**: Creates a new rate-limit status payload with the required plan type filled in and all optional details left out. This is useful when code wants to start with the smallest valid response and add extra information only when it is available.

**Data flow**: It takes one input, `plan_type`, which says what subscription or workspace plan applies. It places that value into a new `RateLimitStatusPayload` and sets every optional field, such as credits and spending controls, to `None`, meaning they will be absent unless later filled in. The result is a ready-to-use payload object.

**Call relations**: This constructor is the simple starting point for building this API model. Other backend code can call it when preparing a rate-limit status response, then optionally attach more detailed limit, credit, or spending information before the payload is serialized into JSON for the client.


### Task and pull request responses
These models cover task listings, detailed task payloads, and the pull-request structures attached to assistant work.

### `codex-backend-openapi-models/src/models/code_task_details_response.rs`

`generated` · `request handling`

This file is a small data model: it says what information a “code task details” response contains when sent over the API. The main required piece is the task itself, stored as a TaskResponse. It can also include three optional pieces of extra turn information: the current user turn, the current assistant turn, and the current diff-task turn. A “turn” here means one step in an interaction, like a message or action in an ongoing back-and-forth.

The optional fields are flexible maps from text keys to JSON values. In plain terms, that means they can hold mixed structured data without this file needing to spell out every possible field in advance. If one of these optional pieces is missing, it is left out when the response is converted to JSON, keeping the API response smaller and cleaner.

The struct derives common Rust abilities such as cloning, debugging, comparison, and conversion to and from JSON through Serde, a library used for serialization and deserialization. Without this file, the backend and generated clients would not have a clear, typed description of this API response, making it easier for different parts of the system to disagree about what a task-details response looks like.

#### Function details

##### `CodeTaskDetailsResponse::new`  (lines 34–41)

```
fn new(task: models::TaskResponse) -> CodeTaskDetailsResponse
```

**Purpose**: This creates a new code task details response from a required task. It starts with no current turn information, leaving those optional fields empty until another part of the program fills them in if needed.

**Data flow**: It receives a TaskResponse as input. It wraps that task in a Box, which means the task is stored indirectly on the heap rather than directly inside the struct, and then builds a CodeTaskDetailsResponse with all three optional turn fields set to None. The result is a ready-to-use response object containing the task and no extra turn data.

**Call relations**: This constructor is used when some other part of the API code needs to build a task-details response. Inside, it calls the standard Box::new-style constructor to wrap the task before returning the finished response object.

*Call graph*: 1 external calls (new).


### `codex-backend-openapi-models/src/models/git_pull_request.rs`

`generated` · `request handling and JSON serialization`

This is a generated OpenAPI model file. In plain terms, it is a labeled form for pull request information: number, URL, state, whether it was merged, whether it can be merged, and optional details like title, body, branch names, commit hashes, comments, diff, and user data.

The main type, `GitPullRequest`, is a Rust struct, which means a grouped set of named fields. The `serde` annotations tell Rust how each field should appear when converted to or from JSON. For example, the Rust field `base_sha` is written as `base_sha` in JSON. Some fields are optional, meaning they may be missing. When those optional fields have no value, they are skipped during JSON output instead of being written as empty placeholders.

This file matters because API clients and servers need to agree on the exact shape of pull request data. Without a shared model like this, one part of the system might send a field under one name while another part expects a different name, causing confusing failures. Think of it like a standard shipping label: every package can contain different contents, but the address, tracking number, and required fields must be in predictable places.

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

**Purpose**: Creates a new pull request record with the required fields filled in and all optional fields left empty. Someone would use this when they know the core pull request facts but may add extra details later.

**Data flow**: It receives the required pull request details: its number, URL, state, whether it has been merged, and whether it is mergeable. It places those values into a new `GitPullRequest` object, sets every optional field to `None` to mean “not provided,” and returns the completed object.

**Call relations**: The call graph does not show specific callers for this constructor. In the broader flow, code that needs to create a pull request model would call this first, then optionally fill in extra fields such as title, body, branch names, comments, or diff before the object is serialized to JSON or passed around inside the program.


### `codex-backend-openapi-models/src/models/external_pull_request_response.rs`

`generated` · `API response serialization and deserialization`

This file is a small data container for one kind of backend response: an external pull request response. In plain terms, it says, “when the backend talks about a pull request created or updated outside the main system, this is the information that must travel over the API.”

The struct stores four pieces of information. It has an `id` for this response record, an `assistant_turn_id` linking it back to the assistant interaction that caused it, a `pull_request` with the actual pull request details, and an optional `codex_updated_sha`, which is likely a Git commit identifier if Codex updated something. “Optional” means the value may be missing, and if it is missing it will not be included when the response is converted to JSON.

The file uses Serde, a Rust library that turns Rust data into formats like JSON and back again. That matters because this type is meant to cross the boundary between the backend and outside clients. Without this file, code using the generated API models would not have a shared, typed way to represent this response, making API communication easier to get wrong.

#### Function details

##### `ExternalPullRequestResponse::new`  (lines 28–39)

```
fn new(
        id: String,
        assistant_turn_id: String,
        pull_request: models::GitPullRequest,
    ) -> ExternalPullRequestResponse
```

**Purpose**: Creates a new `ExternalPullRequestResponse` with the required fields filled in. It starts with no `codex_updated_sha`, because that value is optional and may not be known or relevant.

**Data flow**: It receives an response id, an assistant turn id, and a `GitPullRequest` object. It puts those values into a new response struct, wraps the pull request in a heap-owned box so the struct stores it indirectly, sets `codex_updated_sha` to missing, and returns the completed response object.

**Call relations**: This constructor is used when other code needs to build this API response in a safe, consistent way. During construction it hands the pull request value to `Box::new`, which is the standard Rust tool for placing a value behind a pointer-like container.

*Call graph*: 1 external calls (new).


### `codex-backend-openapi-models/src/models/task_list_item.rs`

`data_model` · `API request and response serialization`

This file is a data model: it says what information makes up a task list item when the backend sends or receives it as JSON. Think of it like a standard form for a row in a task list. Every row must have an id, a title, whether it is archived, and whether it has an unread turn. Some fields are optional, such as creation and update times, a generated-title flag, display status details, and related pull requests.

The serde annotations tell Rust how to turn this struct into JSON and back again. Serde is a common Rust library for serialization, meaning converting in-memory data into formats like JSON, and deserialization, meaning reading JSON back into Rust values. Optional fields are skipped when they are missing, which keeps API responses clean and avoids sending empty values unnecessarily.

The file also provides a small constructor, TaskListItem::new, for making a basic task list item with the required fields and a few selected optional values. Other optional fields start as empty and can be filled in later if the caller has that information. Without this model, different parts of the system could disagree about what a task list item looks like, making API communication fragile.

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

**Purpose**: Creates a new TaskListItem with the required task-list fields filled in. It gives callers a safe starting point where optional details that are not yet known are left empty.

**Data flow**: The caller provides an id, a title, an optional has_generated_title flag, an archived flag, and a has_unread_turn flag. The function places those values into a new TaskListItem, sets updated_at, created_at, task_status_display, and pull_requests to None, and returns the completed struct to the caller.

**Call relations**: This constructor is used when code needs to build a task list item from known core details before sending it through the API model layer. It does not call other project functions; it simply assembles the data into the standard shape expected by the rest of the generated OpenAPI models.


### `codex-backend-openapi-models/src/models/paginated_list_task_list_item_.rs`

`generated` · `request handling`

This is a generated data model for the backend API. Its job is to describe, in Rust code, what a paginated task-list response looks like when data is sent to or received from JSON. Pagination means the server does not send every task at once; it sends a manageable batch, like one page of search results, and may include a cursor that points to where the next page starts.

The main type is `PaginatedListTaskListItem`. It contains two pieces of data: `items`, which is a list of `TaskListItem` records, and `cursor`, which may or may not be present. If `cursor` is missing, that usually means there is no next page or the caller did not provide one. The `serde` annotations tell Rust how to convert this structure to and from JSON. For example, the Rust field `items` appears as `"items"` in JSON, and `cursor` is skipped when it is empty.

Without this file, other parts of the backend and generated client/server code would not have a shared, type-checked way to describe this particular paginated response. That would make API communication more error-prone, because callers would have to build the JSON shape by hand.

#### Function details

##### `PaginatedListTaskListItem::new`  (lines 24–29)

```
fn new(items: Vec<models::TaskListItem>) -> PaginatedListTaskListItem
```

**Purpose**: Creates a new paginated task-list response from a list of task items. It starts with no cursor, which is useful when there is no next-page marker yet or the caller plans to fill it in later.

**Data flow**: It receives a vector, meaning an ordered list, of `TaskListItem` values. It puts that list into the `items` field, sets `cursor` to `None`, and returns a complete `PaginatedListTaskListItem` object ready to serialize to JSON or pass around in Rust.

**Call relations**: This constructor is the simple entry point for code that needs to build this response model. Generated API or backend code can call it when preparing a paginated task-list reply, then optionally set the cursor before the response is sent.


### `codex-backend-openapi-models/src/models/task_response.rs`

`data_model` · `API serialization and response building`

A task is the unit of work or conversation that the backend exposes to clients. This file describes what information a task response can contain when the backend sends task data as JSON: its id, title, archive status, current turn, unread state, metadata, and related external pull requests.

The main piece is the `TaskResponse` struct. A struct is a named bundle of fields, like a form with labeled boxes. Some boxes are always required, such as `id`, `title`, `archived`, and `external_pull_requests`. Others are optional, such as `created_at` or `current_turn_id`; if they are missing, they are left out when the value is converted to JSON.

The `serde` annotations tell Rust how to translate this struct to and from JSON. For example, the Rust field `created_at` becomes the JSON field `created_at`, and optional fields are skipped when empty. This matters because API clients expect a stable, predictable shape.

The file also provides a small constructor, `TaskResponse::new`, for creating a task response with the required fields while safely starting all optional fields as empty. Without this model, different parts of the backend could accidentally send task data in inconsistent shapes.

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

**Purpose**: Creates a new `TaskResponse` with the required task information filled in and all optional information left empty. This gives callers a safe starting point when they only know the minimum fields needed for an API response.

**Data flow**: It receives a task id, a title, an archived flag, and a list of external pull request responses. It places those values into a new `TaskResponse`, sets optional fields like creation time, current turn id, unread status, and metadata to `None`, and returns the completed struct.

**Call relations**: This constructor is used when some other part of the backend needs to build a task response before sending or further filling it. It does not hand work off to other functions; it simply packages the given values into the API model in the expected format.


### Configuration delivery payloads
These generated types describe delivered configuration files and TOML fragment bundles returned by the backend.

### `codex-backend-openapi-models/src/models/config_bundle_response.rs`

`generated` · `API serialization and deserialization`

This file is a small data container for a “config bundle” response from the codex backend. In everyday terms, it describes the package the server may send back when a client asks for configuration: one possible item is a `config_toml` file, and another is a `requirements_toml` file. TOML is a human-readable configuration file format, often used for settings.

The struct is designed for JSON communication. The `serde` annotations tell Rust how to turn this struct into JSON and how to read JSON back into it. A notable detail is that each field uses a double optional value: `Option<Option<...>>`. That lets the code tell three cases apart: the field was not included at all, the field was included but explicitly set to `null`, or the field included a real delivered file object. This distinction matters for APIs because “not mentioned” and “intentionally empty” can mean different things.

Without this file, other generated client or server code would not have a shared Rust type for this response. That would make it easier for the API and the code to drift apart, or force callers to work with loose, error-prone JSON by hand.

#### Function details

##### `ConfigBundleResponse::new`  (lines 34–39)

```
fn new() -> ConfigBundleResponse
```

**Purpose**: Creates an empty `ConfigBundleResponse`, with neither configuration file set. This is useful as a clean starting point before filling in whichever files the response should include.

**Data flow**: No information is passed in. The function builds a new response object where `config_toml` is absent and `requirements_toml` is absent. It returns that newly created object and does not change anything else.

**Call relations**: Code that needs to construct this API response can call this function first, then add the delivered config or requirements data if needed. It does not hand work off to other functions; it simply creates the default response shape expected by the generated model.


### `codex-backend-openapi-models/src/models/config_file_response.rs`

`generated` · `request and response serialization`

This file is a small data container for information about a configuration file. When the backend sends or receives this kind of API response, it needs a shared shape so both sides agree on the field names and meanings. This struct is that shape.

The main type, `ConfigFileResponse`, can hold four optional pieces of information: the file contents, a SHA-256 hash of those contents, the time it was last updated, and the user ID of the person who updated it. A SHA-256 hash is a fixed-length fingerprint of data; it helps check whether the contents changed or stayed the same.

Each field is optional, meaning the response can leave it out. The serialization settings tell Rust how to turn this struct into JSON and back again. For example, the Rust field `updated_at` maps to the JSON name `updated_at`, and missing values are skipped when sending JSON. This matters because APIs often return partial information depending on permissions, state, or endpoint behavior.

The file was generated by OpenAPI Generator, so it should usually not be edited by hand. Think of it like a printed form made from the official API blueprint: other code fills it in, reads from it, or converts it to JSON.

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

**Purpose**: Creates a new `ConfigFileResponse` from the four possible pieces of configuration file information. Code uses it when it wants to build this API response in one clear step.

**Data flow**: It receives optional values for the file contents, the SHA-256 fingerprint, the update time, and the updater's user ID. It places those values into a new `ConfigFileResponse` object without changing them. The result is a ready-to-use response value that can later be serialized into JSON or inspected by Rust code.

**Call relations**: This constructor belongs to the generated model itself. Other parts of the backend or API client can call it when they need to create a response object, and the resulting value can then be handed to serialization code from `serde` to become JSON for the API boundary.


### `codex-backend-openapi-models/src/models/delivered_toml_fragment.rs`

`data_model` · `request handling`

This is a generated model file from the OpenAPI description, which is the project’s machine-readable contract for its web API. In plain terms, it describes one kind of message the system can send or receive: a `DeliveredTomlFragment`. TOML is a human-readable configuration file format, and a “fragment” here means a piece of TOML content rather than a whole application by itself.

The struct has three fields: `id`, which identifies the fragment; `name`, which gives it a human-friendly label; and `contents`, which holds the TOML text itself. The `serde` annotations tell Rust how to turn this struct into formats like JSON and back again. `serde` is a serialization library, meaning it helps convert in-memory Rust data into data that can travel over an API, and then reconstruct it later.

Without this file, code using the generated API models would not have a shared, type-checked container for this response or request data. It is like having a standard delivery label on a package: every part of the system knows where to find the package ID, the name, and the contents.

#### Function details

##### `DeliveredTomlFragment::new`  (lines 25–27)

```
fn new(id: String, name: String, contents: String) -> DeliveredTomlFragment
```

**Purpose**: This creates a new `DeliveredTomlFragment` from an ID, a name, and the TOML text contents. It is a convenience constructor so callers can build the model in one clear step.

**Data flow**: The caller provides three strings: the fragment ID, the fragment name, and the fragment contents. The function places those strings into the matching fields of a new `DeliveredTomlFragment` value. It returns that completed value and does not change anything else.

**Call relations**: This constructor is used when some other part of the code needs to produce this API model before sending it onward or storing it in memory. It does not call other project functions; it simply packages the provided pieces of data into the agreed API shape.


### `codex-backend-openapi-models/src/models/delivered_config_toml.rs`

`data_model` · `request handling`

This file is a small data model: it describes one kind of API object called `DeliveredConfigToml`. In plain terms, this object represents configuration text, in TOML form, that may be delivered to a client or another part of the system. TOML is a human-readable configuration format often used for settings files.

The struct currently has one field, `enterprise_managed`. That field can contain a list of delivered TOML fragments, meaning separate pieces of configuration. It is wrapped in two layers of `Option`, which lets the API distinguish between “this field was not provided at all” and “this field was provided but explicitly set to null.” That distinction matters in APIs because absence and intentional emptiness can mean different things.

The `serde` settings tell Rust how to turn this struct into JSON and back again. Serde is the common Rust library for serialization, which means converting in-memory data into formats that can be sent over a network or stored, and deserialization, which is the reverse. The field is named `enterprise_managed` in the external API, and it is skipped when serializing if the outer option is missing.

Without this file, code using the generated API models would not have a shared, type-checked way to represent this delivered configuration object.

#### Function details

##### `DeliveredConfigToml::new`  (lines 27–31)

```
fn new() -> DeliveredConfigToml
```

**Purpose**: Creates a blank `DeliveredConfigToml` value. Someone would use this when they need to start with an empty delivered configuration object and fill in fields later if needed.

**Data flow**: No input is required. The function builds a new `DeliveredConfigToml` where `enterprise_managed` is set to `None`, meaning the field is not present yet. It returns that new struct and does not change anything else.

**Call relations**: This constructor is the simple starting point for code that wants to create this API model by hand. After it returns the empty object, other code can set `enterprise_managed` before the value is serialized and sent, or leave it absent so it is omitted from the outgoing data.


### `codex-backend-openapi-models/src/models/delivered_requirements_toml.rs`

`data_model` · `request handling and API serialization/deserialization`

This file is a data model: it describes what information can appear in one part of the backend API, rather than doing calculations itself. The object represents delivered requirements related to TOML, which is a common plain-text configuration file format. Its one field, `enterprise_managed`, can be absent entirely, present with no value, or present with a list of `DeliveredTomlFragment` items. That extra distinction matters in APIs: “not mentioned” can mean something different from “explicitly set to empty or null,” much like leaving a form field blank versus checking a box that says “none.”

The file also teaches Rust’s serialization tools how to turn this object into JSON and back again. The `serde` settings say the API field name should be `enterprise_managed`, that missing data should be accepted, and that the field should be skipped when it is not set. Because this was generated from an OpenAPI contract, it helps keep the code in sync with the published API. Without this file, code using this API object would have to pass around loose, error-prone JSON instead of a typed structure.

#### Function details

##### `DeliveredRequirementsToml::new`  (lines 27–31)

```
fn new() -> DeliveredRequirementsToml
```

**Purpose**: Creates a fresh `DeliveredRequirementsToml` value with no `enterprise_managed` data set yet. Someone would use this when they want to build the API object step by step in Rust.

**Data flow**: Nothing is passed in. The function makes a new struct and sets `enterprise_managed` to `None`, meaning the field is absent for now. It returns that new empty model to the caller, which may later fill in the field or serialize it as part of an API response or request.

**Call relations**: This is the simple constructor for the model. Other code can call it whenever it needs a blank `DeliveredRequirementsToml` value; after that, Rust’s serialization and deserialization support can turn the value into API data or read API data back into the same shape.


### Thread-config protobuf bindings
This generated protobuf module provides the wire messages and gRPC service definitions for remote thread-config loading.

### `config/src/thread_config/proto/codex.thread_config.v1.rs`

`generated` · `config load and gRPC request handling`

This file is machine-generated from a Protocol Buffers definition. Protocol Buffers are a compact way to describe data so different parts of a system can exchange it safely. Here, the data is about loading configuration for a “thread”: which model provider to use, what features are on, authentication commands, headers, timeouts, and similar settings.

Think of this file as both the form and the post office instructions. The message structs describe the form: a request can include a thread id and current working directory; a response contains one or more configuration sources; a source can be session-specific or user-level. The generated client knows how to send the form over gRPC, which is a remote procedure call system that lets code call a function across a network or process boundary. The generated server knows how to receive that call and pass it to real application code that implements the actual loading behavior.

The important point is that this file does not decide what the configuration should be. It only defines how configuration data is packaged, sent, received, and decoded. Without it, the configuration loader client and server could easily disagree about field names, types, paths, or service names, and calls to load thread configuration would fail or return unreadable data.

#### Function details

##### `WireApi::as_str_name`  (lines 109–114)

```
fn as_str_name(&self) -> &'static str
```

**Purpose**: Returns the stable Protocol Buffers name for a wire API value. This is useful when code needs the exact text name used in the schema, for logging, storage, or matching with protocol-level data.

**Data flow**: It starts with a `WireApi` enum value, such as `Unspecified` or `Responses`. It matches that value to the official schema name and returns that name as text. It does not change any stored data.

**Call relations**: This helper belongs to the generated enum support code. Other code can call it whenever it needs to turn the numeric Rust enum value into the schema’s string label.


##### `WireApi::from_str_name`  (lines 116–122)

```
fn from_str_name(value: &str) -> ::core::option::Option<Self>
```

**Purpose**: Turns an official Protocol Buffers enum name back into a `WireApi` value. It lets code safely interpret text that uses the schema’s enum names.

**Data flow**: It receives a string. If the string is one of the known wire API names, it returns the matching enum value wrapped in `Some`; if the text is unknown, it returns `None`. Nothing else is changed.

**Call relations**: This is the reverse of `WireApi::as_str_name`. Code that reads protocol-style names can call it before storing or comparing the value as a Rust enum.


##### `thread_config_loader_client::ThreadConfigLoaderClient::connect`  (lines 141–148)

```
async fn connect(dst: D) -> Result<Self, tonic::transport::Error>
```

**Purpose**: Creates a ready-to-use client by opening a connection to a gRPC endpoint. A caller uses this when it has an address for the configuration loader service and wants to call it remotely.

**Data flow**: It receives a destination, such as a service URL or endpoint-like value. It turns that into a tonic endpoint, connects asynchronously, then wraps the connection in a `ThreadConfigLoaderClient`. The result is either a connected client or a transport error if the connection cannot be made.

**Call relations**: This is the convenient starting point for client-side code. After connecting, it hands the live connection to `ThreadConfigLoaderClient::new`, which builds the actual client wrapper used for later `load` calls.

*Call graph*: 2 external calls (new, new).


##### `thread_config_loader_client::ThreadConfigLoaderClient::new`  (lines 157–160)

```
fn new(inner: T) -> Self
```

**Purpose**: Wraps an existing gRPC transport in a thread configuration loader client. This is used when the caller already has a channel or service object and just needs the generated client interface around it.

**Data flow**: It receives an inner transport object. It wraps that object in tonic’s gRPC client machinery and returns a `ThreadConfigLoaderClient` containing it. The original transport becomes owned by the new client.

**Call relations**: This is used by `connect` after a network connection is opened, and also by generated setup helpers such as `with_interceptor`. It is the basic constructor for the client side of this service.

*Call graph*: 1 external calls (new).


##### `thread_config_loader_client::ThreadConfigLoaderClient::with_origin`  (lines 161–164)

```
fn with_origin(inner: T, origin: Uri) -> Self
```

**Purpose**: Creates a client that sends requests with a specific origin URI. This is useful in advanced routing setups where the transport connection and the logical service origin need to be distinguished.

**Data flow**: It receives an inner transport and an origin URI. It builds tonic’s gRPC client wrapper using that origin and returns a `ThreadConfigLoaderClient`. The returned client will use that origin when making service calls.

**Call relations**: This is another client construction path. It delegates the origin-aware wrapping to tonic’s generated support code, then returns the same kind of client used by `load`.

*Call graph*: 1 external calls (with_origin).


##### `thread_config_loader_client::ThreadConfigLoaderClient::with_interceptor`  (lines 165–182)

```
fn with_interceptor(
            inner: T,
            interceptor: F,
        ) -> ThreadConfigLoaderClient<InterceptedService<T, F>>
```

**Purpose**: Creates a client that runs an interceptor around each request. An interceptor is a small hook that can inspect or modify outgoing calls, often to add authentication or tracing information.

**Data flow**: It receives a transport and an interceptor function or object. It combines them into an intercepted service, then wraps that service in a new `ThreadConfigLoaderClient`. The output is a client whose future requests pass through the interceptor first.

**Call relations**: This sits in the client setup path before any actual load request is sent. It uses the same underlying `new` construction pattern, but inserts the extra request hook in front of the transport.

*Call graph*: 2 external calls (new, new).


##### `thread_config_loader_client::ThreadConfigLoaderClient::send_compressed`  (lines 188–191)

```
fn send_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Configures the client to compress outgoing requests using a chosen compression format. Compression can reduce network size, but the server must support the same format.

**Data flow**: It receives the client and a compression encoding. It updates the inner gRPC client so future requests are sent compressed, then returns the updated client for chaining. It does not send a request by itself.

**Call relations**: This is a client configuration step used before calling `load`. It hands the compression choice to tonic’s client machinery, which applies it when a request is later sent.

*Call graph*: 1 external calls (send_compressed).


##### `thread_config_loader_client::ThreadConfigLoaderClient::accept_compressed`  (lines 194–197)

```
fn accept_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Configures the client to accept compressed responses from the server. This tells the client which compressed response format it knows how to decode.

**Data flow**: It receives the client and a compression encoding. It updates the inner gRPC client so later responses using that encoding can be decompressed, then returns the updated client. No network call happens here.

**Call relations**: This is usually called during client setup. When `load` later receives a response, tonic uses this setting to decode compressed response bodies if needed.

*Call graph*: 1 external calls (accept_compressed).


##### `thread_config_loader_client::ThreadConfigLoaderClient::max_decoding_message_size`  (lines 202–205)

```
fn max_decoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets the largest response message the client is willing to decode. This protects the client from unexpectedly huge messages.

**Data flow**: It receives the client and a byte-size limit. It stores that limit in the inner gRPC client and returns the updated client. Future responses larger than the limit may be rejected by tonic.

**Call relations**: This is part of client setup before request sending. The limit is enforced later by tonic when `load` receives and decodes a response.

*Call graph*: 1 external calls (max_decoding_message_size).


##### `thread_config_loader_client::ThreadConfigLoaderClient::max_encoding_message_size`  (lines 210–213)

```
fn max_encoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets the largest request message the client is willing to encode and send. This helps prevent accidental oversized outbound requests.

**Data flow**: It receives the client and a byte-size limit. It records that limit inside the inner gRPC client and returns the updated client. Future outgoing requests are checked against this setting.

**Call relations**: This prepares the client before calling `load`. Tonic uses the stored limit when it serializes the request into bytes for the gRPC call.

*Call graph*: 1 external calls (max_encoding_message_size).


##### `thread_config_loader_client::ThreadConfigLoaderClient::load`  (lines 214–232)

```
async fn load(
            &mut self,
            request: impl tonic::IntoRequest<super::LoadThreadConfigRequest>,
        ) -> std::result::Result<tonic::Response<super::LoadThreadConfigResponse>, t
```

**Purpose**: Sends a `LoadThreadConfigRequest` to the thread configuration loader service and waits for a `LoadThreadConfigResponse`. This is the generated client method for the service’s main operation.

**Data flow**: It receives a request-like value containing fields such as thread id and current working directory. It first waits until the inner gRPC service is ready, converts the input into a proper gRPC request, attaches method metadata, and sends a unary call, meaning one request produces one response. It returns either the response from the server or a gRPC status error.

**Call relations**: This is the client-side endpoint that application code calls when it wants thread configuration. It uses tonic’s readiness check, Protocol Buffers codec, fixed service path, and unary-call machinery to hand the request over to the remote server method named `Load`.

*Call graph*: 6 external calls (ready, unary, new, into_request, from_static, default).


##### `thread_config_loader_server::ThreadConfigLoaderServer::new`  (lines 262–264)

```
fn new(inner: T) -> Self
```

**Purpose**: Builds a server wrapper around application code that implements the thread configuration loading behavior. The wrapper is what tonic can register as a gRPC service.

**Data flow**: It receives an implementation object for the `ThreadConfigLoader` trait. It places that object in shared ownership storage and builds a `ThreadConfigLoaderServer` around it. The result is a service object ready for further configuration or registration.

**Call relations**: This is the common server setup entry point. It immediately delegates to `from_arc`, which does the actual field setup using a shared pointer so requests can safely refer to the same implementation.

*Call graph*: 2 external calls (new, from_arc).


##### `thread_config_loader_server::ThreadConfigLoaderServer::from_arc`  (lines 265–273)

```
fn from_arc(inner: Arc<T>) -> Self
```

**Purpose**: Builds a server wrapper around an already shared implementation object. This is useful when the application already keeps the loader in an `Arc`, which is Rust’s thread-safe shared pointer.

**Data flow**: It receives a shared pointer to the real loader implementation. It stores that pointer and initializes compression and message-size settings to their defaults. It returns a configured server wrapper with no custom limits or compression enabled yet.

**Call relations**: This is called by `new`, and can also be used directly by server setup code. Later, `call` uses the stored shared implementation to dispatch incoming gRPC requests to the real `load` method.

*Call graph*: 1 external calls (default).


##### `thread_config_loader_server::ThreadConfigLoaderServer::with_interceptor`  (lines 274–279)

```
fn with_interceptor(inner: T, interceptor: F) -> InterceptedService<Self, F>
```

**Purpose**: Creates a server service that runs an interceptor around incoming requests. This hook can check or decorate requests before they reach the actual loader, for example for authentication or logging.

**Data flow**: It receives the loader implementation and an interceptor. It first builds a normal server wrapper, then combines it with the interceptor and returns the intercepted service. Incoming requests will pass through that interceptor before normal service handling.

**Call relations**: This is used during server setup instead of plain `new` when request filtering or metadata handling is needed. It wraps the generated server before tonic starts routing calls to `call`.

*Call graph*: 2 external calls (new, new).


##### `thread_config_loader_server::ThreadConfigLoaderServer::accept_compressed`  (lines 282–285)

```
fn accept_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Configures the server to accept compressed requests in a chosen format. This lets clients reduce request size when both sides support the same compression.

**Data flow**: It receives the server wrapper and a compression encoding. It marks that encoding as allowed for incoming requests, then returns the updated server. No request is processed at this point.

**Call relations**: This is a server setup step. When `call` later receives a matching request, the generated gRPC machinery uses this setting while decoding the request body.

*Call graph*: 1 external calls (enable).


##### `thread_config_loader_server::ThreadConfigLoaderServer::send_compressed`  (lines 288–291)

```
fn send_compressed(mut self, encoding: CompressionEncoding) -> Self
```

**Purpose**: Configures the server to compress responses using a chosen format when the client supports it. This can make responses smaller over the wire.

**Data flow**: It receives the server wrapper and a compression encoding. It marks that encoding as available for outgoing responses and returns the updated server. The effect is applied later during request handling.

**Call relations**: This is called during server setup. The `call` function later copies this setting into tonic’s per-request gRPC handler so responses can be compressed when appropriate.

*Call graph*: 1 external calls (enable).


##### `thread_config_loader_server::ThreadConfigLoaderServer::max_decoding_message_size`  (lines 296–299)

```
fn max_decoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets the largest incoming request message the server will decode. This protects the service from unexpectedly large or abusive requests.

**Data flow**: It receives the server wrapper and a byte-size limit. It stores that limit in the server configuration and returns the updated server. Future incoming requests are checked against this size during decoding.

**Call relations**: This is configured before the service starts receiving calls. When `call` builds the gRPC handler for a request, it passes this limit into tonic’s message-size configuration.


##### `thread_config_loader_server::ThreadConfigLoaderServer::max_encoding_message_size`  (lines 304–307)

```
fn max_encoding_message_size(mut self, limit: usize) -> Self
```

**Purpose**: Sets the largest response message the server will encode and send. This helps avoid sending unexpectedly huge responses.

**Data flow**: It receives the server wrapper and a byte-size limit. It stores that limit in the server configuration and returns the updated server. Later responses larger than the limit may be rejected by tonic.

**Call relations**: This is a server setup option. During `call`, the stored limit is applied to the gRPC handler that serializes the response.


##### `thread_config_loader_server::ThreadConfigLoaderServer::poll_ready`  (lines 318–323)

```
fn poll_ready(
            &mut self,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>>
```

**Purpose**: Reports whether the generated server is ready to receive a request. In this generated implementation, it always says it is ready.

**Data flow**: It receives a mutable reference to the server and a task context, but does not need to inspect either in this implementation. It immediately returns a ready success value. It changes no server state.

**Call relations**: The HTTP/gRPC runtime calls this before sending a request into `call`. Because this server wrapper has no internal back-pressure here, it simply tells the runtime to continue.

*Call graph*: 1 external calls (Ready).


##### `thread_config_loader_server::ThreadConfigLoaderServer::call`  (lines 324–381)

```
fn call(&mut self, req: http::Request<B>) -> Self::Future
```

**Purpose**: Routes an incoming HTTP/gRPC request to the correct generated service method. For this service, it recognizes the `Load` path and forwards the decoded request to the real loader implementation.

**Data flow**: It receives an HTTP request. It checks the request path: if it is the thread configuration `Load` path, it builds a small adapter service, applies compression and message-size settings, decodes the request with the Protocol Buffers codec, calls the implementation’s `load` method, and returns the gRPC response. If the path is unknown, it returns a gRPC “unimplemented” response.

**Call relations**: This is the main server-side request dispatch point. The runtime calls it after `poll_ready`; for valid `Load` calls it hands work to the application’s implementation of the `ThreadConfigLoader` trait, while tonic handles the byte-level encoding and response wrapping.

*Call graph*: 6 external calls (pin, uri, new, default, new, default).


##### `thread_config_loader_server::ThreadConfigLoaderServer::clone`  (lines 384–393)

```
fn clone(&self) -> Self
```

**Purpose**: Creates another server wrapper pointing at the same underlying loader implementation and using the same settings. This lets the gRPC runtime duplicate the service handle safely when needed.

**Data flow**: It reads the existing server’s shared implementation pointer and configuration fields. It clones the shared pointer and copies the compression and size settings into a new server wrapper. The original and cloned wrappers both refer to the same real loader.

**Call relations**: This supports tonic’s service infrastructure, which may clone services as it builds routing or serves requests. The clone preserves the behavior configured by `new`, `from_arc`, and the compression or message-size setup methods.


### Exec relay protobuf bindings
These files expose the generated relay protocol types and the small handwritten wrapper that re-exports the subset used by exec-server.

### `exec-server/src/proto/codex.exec_server.relay.v1.rs`

`generated` · `network relay serialization`

This file is produced automatically from a Protocol Buffers schema. Protocol Buffers are a compact, agreed-upon way for two programs to turn structured messages into bytes and back again. In plain terms, this file is the relay’s shared vocabulary: both sides need to know what a “data packet”, “acknowledgement”, or “heartbeat” looks like so they can understand each other.

The central message is `RelayMessageFrame`. Think of it like an envelope. The envelope says which protocol version is being used, which stream it belongs to, and what has already been received. It then carries exactly one kind of body: actual data, an acknowledgement-only frame, a resume request, a reset notice, a heartbeat, or a handshake.

`RelayData` carries real bytes and includes sequence and segment numbers so larger payloads can be split into pieces and reassembled in order. `RelayResume` tells the other side where to continue after an interruption. `RelayReset` explains why a stream is being closed or restarted. `RelayHeartbeat` is an empty “I am still alive” signal. `RelayHandshake` carries initial setup bytes.

Because this file is generated, people normally should not edit it by hand. Changes should be made in the source `.proto` definition and regenerated, otherwise the Rust code and the protocol definition can drift apart.


### `exec-server/src/relay_proto.rs`

`data_model` · `cross-cutting`

The exec server needs to send and receive structured relay messages, such as handshakes, data packets, resets, and resume requests. Those message shapes are generated from a protocol definition, likely by a tool such as Protocol Buffers, which turns a shared message schema into Rust code. Generated files are often noisy and not meant to be edited by hand, so this file acts like a neat front desk: other code can import the important relay message types from here without caring where the generated code lives.

It first points Rust at the generated source file, `proto/codex.exec_server.relay.v1.rs`, and loads it as a private module named `generated`. Then it re-exports only the relay types the rest of this crate is meant to use: `RelayData`, `RelayHandshake`, `RelayMessageFrame`, `RelayReset`, `RelayResume`, and the `relay_message_frame` helper module. The `pub(crate)` visibility means these names are available inside this crate, but not exposed as part of a public library API.

Without this file, many parts of the exec server would need to know the exact generated file path and module layout. That would make the code more fragile if the generated protocol code ever moves or changes shape.
