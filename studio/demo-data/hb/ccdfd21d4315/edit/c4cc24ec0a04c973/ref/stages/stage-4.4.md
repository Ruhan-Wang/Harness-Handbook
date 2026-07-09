### 4.4 · Response Parse

#### (a) Opening Explanation

This stage exists to turn the LLM’s raw reply into something the agent can safely act on. The model does not return ready-to-run commands in a guaranteed shape. It may mix prose with structured output, cut off partway through, or mark a task as done in the wrong way. Response Parse is the boundary that says: “Did we get a valid action plan, a completion signal, or feedback we need to send back?” It sits right after the LLM call and before any user handoff or command handling. Without this stage, later parts of the pipeline would have to guess what the model meant, and the agent would be much more brittle.

#### (b) Main Flow

1. `Terminus2._handle_llm_interaction()` (takes one LLM reply and turns it into agent-ready data) sends the reply text into the selected parser.  
   The parser format is chosen earlier at construction time: JSON or XML. That choice matters because the agent wants a strict contract for how commands, analysis, plan, warnings, and completion are expressed.

2. `TerminusJSONPlainParser.parse_response()` or `TerminusXMLPlainParser.parse_response()` (read the model reply and extract the structured pieces) tries to recover a usable result even when the reply is messy.  
   This is why the parser is more than a decoder. It also repairs common model failures:
   - JSON parser: incomplete JSON, mixed prose plus JSON
   - XML parser: missing closing tags, truncated output  
   The reason is simple: the LLM is useful but not perfectly reliable, and the agent still needs a stable next step.

3. The parser returns a `ParseResult`: commands, task-complete flag, error, warning, analysis, and plan.  
   This is the core responsibility of the stage. It converts one blob of model text into a small set of decisions the rest of the system can trust.

4. `_handle_llm_interaction()` then compresses parse problems into a single `feedback` string, using markers like `ERROR: ...` and `WARNINGS: ...`.  
   This exists so later stages do not need to understand every parser detail. They only need one clear message to send back into the loop if the model output was malformed or questionable.

5. Any parsed command is wrapped as a `Command(...)`, with its duration capped at 60 seconds.  
   The point is not just formatting. It normalizes the LLM’s intent into the agent’s own command object, and it applies a safety limit so one bad duration value does not create an overly long terminal action.

6. At the end of this stage, the agent knows one of a few clean outcomes:
   - here are valid commands
   - the task is complete
   - the reply had issues, and here is feedback to give the model  
   That clean split is why this stage exists. It turns ambiguous model output into controlled agent behavior.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: 无 — this stage is not described as writing any explicit register from the provided skeleton
- reads: 无 — no explicit register use is identified in the provided stage/register list
- clears: 无 — no explicit register clearing is identified in the provided stage/register list
- triggers downstream: `stage-4.6 Pending Handoff Prompt → User Step (or Split)` — after the LLM reply has been parsed into commands / completion / feedback, downstream can decide whether to hand off, ask the user, or split based on that normalized result

#### (d) Pipeline Hand-Off

Upstream, this stage receives the raw text reply from stage 4.3, the LLM Query. It produces a normalized parse result: safe command objects, a task-complete signal, and a single feedback string for parse problems, which downstream stages use to decide whether to continue, ask for correction, or move toward user-facing handoff.

<details id="fn-terminus2_handle_llm_interaction">
<summary><b>Terminus2._handle_llm_interaction</b> — terminus_2.py:1196-1225 · Parse LLM reply into commands and feedback</summary>

> **Stage context**: This region is the parse-and-normalize part of `Terminus2._handle_llm_interaction`. It runs after the method has an `llm_response` object and turns `llm_response.content` into structured outputs for the rest of the method's return tuple.

**What this code does**

This code asks `self._parser` to parse `llm_response.content`, then reshapes the parser result into the method's return values. It builds one `feedback` string from `result.error` and `result.warning`, logs parser warnings through `self.logger.debug`, converts each parsed command into a `Command`, and clamps each command duration to at most 60 seconds. It returns the converted commands, completion flag, feedback text, analysis, plan, and the original `llm_response` object.

**Interface · params / IO**

`(self, llm_response)`

- params: `self`: `?` — Owns `_parser` and `logger` used during parse handling; `llm_response`: `?` — Response object whose `content` is parsed and which is returned unchanged as the sixth tuple element
- reads: `self._parser`, `self.logger`, `llm_response.content`, `result.error`, `result.warning`, `result.commands`, `result.is_task_complete`, `result.analysis`, `result.plan`
- returns: A 6-tuple: (`list[Command]` built from `result.commands`, `result.is_task_complete`, synthesized `feedback` string, `result.analysis`, `result.plan`, the same `llm_response` object passed in)
- effects: Calls `self.logger.debug(...)` when `result.warning` is truthy

**Execution flow**

1. Call `self._parser.parse_response(llm_response.content)` and store the structured parse output in `result`.
2. Build `feedback` from parser diagnostics: start empty, prepend `ERROR: ...` when `result.error` exists, append `\nWARNINGS: ...` only when both `result.error` and `result.warning` exist, otherwise use `WARNINGS: ...` alone when there is no error.
3. If `result.warning` is truthy, emit `self.logger.debug(f"Parser warnings: {result.warning}")`.
4. Iterate over `result.commands`, wrap each `parsed_cmd` as `Command(keystrokes=parsed_cmd.keystrokes, duration_sec=min(parsed_cmd.duration, 60))`, and collect them in `commands`.
5. Return `commands`, `result.is_task_complete`, `feedback`, `result.analysis`, `result.plan`, and the original `llm_response` object.

**Source**

```python
        result = self._parser.parse_response(llm_response.content)

        feedback = ""
        if result.error:
            feedback += f"ERROR: {result.error}"
            if result.warning:
                feedback += f"\nWARNINGS: {result.warning}"
        elif result.warning:
            feedback += f"WARNINGS: {result.warning}"

        if result.warning:
            self.logger.debug(f"Parser warnings: {result.warning}")

        commands = []
        for parsed_cmd in result.commands:
            commands.append(
                Command(
                    keystrokes=parsed_cmd.keystrokes,
                    duration_sec=min(parsed_cmd.duration, 60),
                )
            )

        return (
            commands,
            result.is_task_complete,
            feedback,
            result.analysis,
            result.plan,
            llm_response,
        )
```

**Non-obvious design decisions**

- The feedback builder gives `result.error` priority by placing `ERROR: ...` first and only adding warnings as a second line when both fields are present. That choice preserves both diagnostics without collapsing them into one label.
- The code logs only `result.warning`, not `result.error`. The implementation treats warnings as something to surface through `self.logger.debug` while leaving errors only in the returned `feedback` string.
- Command conversion applies `min(parsed_cmd.duration, 60)` at construction time. This enforces a hard upper bound on `duration_sec` even if the parser returned a larger duration.

**Relations**

- **Callers**: `Terminus2._handle_llm_interaction`
- **Core callees**: `self._parser.parse_response`; `self.logger.debug`; `Command`
- **Config / state sources**: `self._parser`; `self.logger`
- **Results to**: Returns parser-derived values to the enclosing `Terminus2._handle_llm_interaction` call result; Exposes the original `llm_response` unchanged as the sixth return element

</details>


<details id="fn-terminusjsonplainparser_parse_response">
<summary><b>TerminusJSONPlainParser.parse_response</b> — terminus_json_plain_parser.py:29-62 · Parse response with retry-on-autofix</summary>

> **Stage context**: This method turns one raw `response` string into a `ParseResult`. It first asks `_try_parse_response(...)` for a direct parse, then only enters its fallback path when `result.error` is non-empty. The fallback path retries parsing against corrected text candidates from `_get_auto_fixes()` and returns the first corrected parse whose `corrected_result.error` is exactly `""`.

**What this code does**

`parse_response` parses the input `response` and returns a `ParseResult`. It reads `result.error` from the initial parse result to decide whether to try auto-fixes, and on a successful corrected parse it reads `corrected_result.error` and `corrected_result.warning`, then assigns `corrected_result.warning` to the value returned by `_combine_warnings(...)`. It does not write any `self` state.

**Interface · params / IO**

`(self, response: str) -> ParseResult`

- params: `self`: `?` — parser instance that supplies parse and auto-fix helpers; `response`: `str` — full response text to parse
- reads: `self._try_parse_response`, `self._get_auto_fixes`, `self._combine_warnings`
- returns: A `ParseResult`: either the initial `result`, or the first `corrected_result` whose `corrected_result.error` is `""` after an auto-fix attempt.
- effects: Assigns `corrected_result.warning` on the successful auto-fix path

**Execution flow**

1. Call `self._try_parse_response(response)` and store the returned `ParseResult` in `result`.
2. Check `result.error`; if it is non-empty, iterate through `(fix_name, fix_function)` pairs from `self._get_auto_fixes()`.
3. For each fix, call `fix_function(response, result.error)` to get `corrected_response` and `was_fixed`, and skip reparsing when `was_fixed` is false.
4. When `was_fixed` is true, call `self._try_parse_response(corrected_response)` and store that `ParseResult` in `corrected_result`.
5. Accept the corrected parse only when `corrected_result.error == ""`; then build `auto_warning`, combine it with `corrected_result.warning` via `self._combine_warnings(...)`, assign the combined value back to `corrected_result.warning`, and return `corrected_result`.
6. If no attempted fix produces a `corrected_result` with an empty error string, return the original `result`.

**Source**

```python
    def parse_response(self, response: str) -> ParseResult:
        """
        Parse a terminus JSON plain response and extract commands.

        Args:
            response: The full LLM response string

        Returns:
            ParseResult with commands, completion status, errors and warnings
        """

        # Try normal parsing first
        result = self._try_parse_response(response)

        if result.error:
            # Try auto-fixes in order until one works
            for fix_name, fix_function in self._get_auto_fixes():
                corrected_response, was_fixed = fix_function(response, result.error)
                if was_fixed:
                    corrected_result = self._try_parse_response(corrected_response)

                    if corrected_result.error == "":
                        # Success! Add auto-correction warning
                        auto_warning = (
                            f"AUTO-CORRECTED: {fix_name} - "
                            "please fix this in future responses"
                        )
                        corrected_result.warning = self._combine_warnings(
                            auto_warning, corrected_result.warning
                        )
                        return corrected_result

        # Return original result if no fix worked
        return result
```

**Non-obvious design decisions**

- It gates the fallback path on `result.error` instead of always running fixes. That keeps the normal path simple and avoids changing already-parseable input.
- It tests correction success with the exact condition `corrected_result.error == ""`. That makes acceptance depend on the parser's own error field rather than on whether a fix function reported `was_fixed`.
- It returns on the first successful fix from `_get_auto_fixes()`. This gives the fix list an ordered priority and avoids merging or comparing multiple corrected parses.
- It preserves the original `result` when no fix yields an empty `corrected_result.error`. That keeps the original parser outcome, including its original error, instead of replacing it with a later failed retry.

**Relations**

- **Callers**: External code that needs to parse a raw response string into a `ParseResult`; Owning parser users that invoke `parse_response(response)` on this parser instance
- **Core callees**: self._try_parse_response; self._get_auto_fixes; fix_function(response, result.error); self._combine_warnings
- **Config / state sources**: self._get_auto_fixes
- **Results to**: The immediate caller of `parse_response`; Code that consumes the returned `ParseResult`
- **Related siblings**: Related to `Terminus2._handle_llm_interaction`, which consumes a parser result and reshapes it for its own return values

</details>


<details id="fn-terminusjsonplainparser_try_parse_response">
<summary><b>TerminusJSONPlainParser._try_parse_response</b> — terminus_json_plain_parser.py:64-163 · JSON response parser and ParseResult builder</summary>

> **Stage context**: This helper does the first strict parse attempt inside stage 4.4's response-parse path. `TerminusJSONPlainParser.parse_response` calls it before deciding whether to apply auto-correction, and `Terminus2._handle_llm_interaction` later consumes the returned `ParseResult`. Compared with its sibling `parse_response`, this method focuses on extraction, decoding, validation, and command conversion for one raw response string.

**What this code does**

`_try_parse_response` turns one LLM `response` string into a `ParseResult`. It extracts a JSON fragment, decodes it, checks the expected schema, normalizes `task_complete`, and converts the `commands` payload through `_parse_commands`. It returns structured errors and warnings instead of raising, and it does not mutate any instance state.

**Interface · params / IO**

`(self, response: str) -> ParseResult`

- params: `response`: `str` — full LLM response text to extract JSON from and parse
- returns: A `ParseResult(commands, is_task_complete, error, warning, analysis, plan)` built from the parsed JSON, or a failure result with empty commands and diagnostic text.

**Execution flow**

1. It starts a local `warnings` list, then calls `_extract_json_content(response)` to split out `json_content` and collect format warnings about extra text before or after the JSON.
2. If `_extract_json_content` finds no `json_content`, it returns a failure `ParseResult` with `error` set to `"No valid JSON found in response"` and the accumulated warnings joined into the bullet-list warning string.
3. It tries `json.loads(json_content)`. On `json.JSONDecodeError`, it returns a failure `ParseResult` whose `error` includes the exception text plus either the full `json_content` or a 100-character preview, depending on length.
4. It calls `_validate_json_structure(parsed_data, json_content, warnings)`. If that helper returns `validation_error`, it stops and returns a failure `ParseResult`, again preserving any warnings already accumulated.
5. It reads `parsed_data.get("task_complete", False)` into `is_complete` and coerces string forms like `"true"`, `"1"`, and `"yes"` to booleans. It also pulls `analysis` and `plan` from `parsed_data` with empty-string defaults.
6. It reads `commands_data = parsed_data.get("commands", [])` and passes it to `_parse_commands(commands_data, warnings)`. If `_parse_commands` reports `parse_error`, the method either downgrades that problem into an added warning and returns `is_task_complete=True` with no commands when `is_complete` is already true, or returns the parse error as a hard failure when completion is false.
7. If command parsing succeeds, it returns a success `ParseResult` with the parsed `commands`, the normalized `is_complete` flag, no `error`, the joined warning text, and the extracted `analysis` and `plan`.

**Source**

```python
    def _try_parse_response(self, response: str) -> ParseResult:
        """
        Try to parse a terminus JSON plain response.

        Args:
            response: The full LLM response string

        Returns:
            ParseResult with commands, completion status, errors and warnings
        """
        warnings = []

        # Check for extra text before/after JSON
        json_content, extra_text_warnings = self._extract_json_content(response)
        warnings.extend(extra_text_warnings)

        if not json_content:
            return ParseResult(
                [],
                False,
                "No valid JSON found in response",
                "- " + "\n- ".join(warnings) if warnings else "",
                "",
                "",
            )

        # Parse JSON
        try:
            parsed_data = json.loads(json_content)
        except json.JSONDecodeError as e:
            # Add debug info
            error_msg = f"Invalid JSON: {str(e)}"
            if len(json_content) < 200:
                error_msg += f" | Content: {repr(json_content)}"
            else:
                error_msg += f" | Content preview: {repr(json_content[:100])}..."
            return ParseResult(
                [],
                False,
                error_msg,
                "- " + "\n- ".join(warnings) if warnings else "",
                "",
                "",
            )

        # Validate structure
        validation_error = self._validate_json_structure(
            parsed_data, json_content, warnings
        )
        if validation_error:
            return ParseResult(
                [],
                False,
                validation_error,
                "- " + "\n- ".join(warnings) if warnings else "",
                "",
                "",
            )

        # Check if task is complete
        is_complete = parsed_data.get("task_complete", False)
        if isinstance(is_complete, str):
            is_complete = is_complete.lower() in ("true", "1", "yes")

        # Extract analysis and plan for reasoning content
        analysis = parsed_data.get("analysis", "")
        plan = parsed_data.get("plan", "")

        # Parse commands
        commands_data = parsed_data.get("commands", [])
        commands, parse_error = self._parse_commands(commands_data, warnings)
        if parse_error:
            # If task is complete, parse errors are just warnings
            if is_complete:
                warnings.append(parse_error)
                return ParseResult(
                    [],
                    True,
                    "",
                    "- " + "\n- ".join(warnings) if warnings else "",
                    analysis,
                    plan,
                )
            return ParseResult(
                [],
                False,
                parse_error,
                "- " + "\n- ".join(warnings) if warnings else "",
                analysis,
                plan,
            )

        return ParseResult(
            commands,
            is_complete,
            "",
            "- " + "\n- ".join(warnings) if warnings else "",
            analysis,
            plan,
        )
```

**Non-obvious design decisions**

- It separates hard failures from recoverable format issues by collecting `warnings` alongside normal parsing. This lets `_extract_json_content(...)` and `_parse_commands(...)` report extra text or non-fatal command issues without discarding the whole response.
- It embeds `json_content` or a preview in the `JSONDecodeError` path. That choice favors diagnosis of malformed model output; the size check (`len(json_content) < 200`) limits how much bad content the error string carries.
- It coerces string `task_complete` values to booleans because model output may not honor the expected JSON boolean type exactly. Without this branch, values like `"true"` would pass schema extraction but drive the completion logic incorrectly.
- It treats `parse_error` from `_parse_commands` as a warning when `is_complete` is already true. That trade-off prefers honoring an explicit completion signal over rejecting the whole response for unusable commands that no longer matter.

**Relations**

- **Callers**: `TerminusJSONPlainParser.parse_response`
- **Core callees**: `self._extract_json_content`; `json.loads`; `self._validate_json_structure`; `self._parse_commands`; `ParseResult` constructor
- **Config / state sources**: `response` argument; parsed JSON fields `task_complete`, `analysis`, `plan`, and `commands`; warnings accumulated from `_extract_json_content` and `_parse_commands`
- **Results to**: `TerminusJSONPlainParser.parse_response`, which may retry with auto-correction and combine warnings; `Terminus2._handle_llm_interaction`, which maps `error` and `warning` into one feedback string and wraps parsed commands into `Command` objects
- **Related siblings**: `TerminusJSONPlainParser.parse_response` wraps this method with auto-fix retries and warning combination; `Terminus2._handle_llm_interaction` consumes this method's `ParseResult` shape during the same stage

</details>


<details id="fn-terminusjsonplainparser_extract_json_content">
<summary><b>TerminusJSONPlainParser._extract_json_content</b> — terminus_json_plain_parser.py:165-212 · Extract first balanced JSON object from reply text</summary>

> **Stage context**: This helper lives under the stage's response-parsing code and handles one narrow task: isolate a JSON object from a raw `response` string. The body shows no instance-state access and no downstream work beyond returning extracted text plus warning strings. It is a local utility for the parser methods in this class.

**What this code does**

`_extract_json_content` scans `response` and returns the first top-level `{...}` segment whose braces balance outside quoted strings. It also reports whether trimmed text exists before or after that segment. On failure, it returns an empty string and exactly `["No valid JSON object found"]`. It does not mutate `self` or any external state.

**Interface · params / IO**

`(self, response: str) -> tuple[str, List[str]]`

- params: `self`: `?` — parser instance; unused in this body; `response`: `str` — raw text to scan for one complete top-level JSON object
- returns: A `(json_text, warnings)` tuple. On success, `json_text` is `response[json_start:json_end]` and `warnings` may include `"Extra text detected before JSON object"` if `response[:json_start].strip()` is non-empty and/or `"Extra text detected after JSON object"` if `response[json_end:].strip()` is non-empty. On failure, it returns `""` and exactly `["No valid JSON object found"]` when either `json_start == -1` or `json_end == -1` after the scan.

**Execution flow**

1. Initialize local scan state: `warnings`, `json_start`, `json_end`, `brace_count`, `in_string`, and `escape_next`.
2. Walk `response` with `enumerate(response)`. If `escape_next` was set by the prior character, clear it and `continue` immediately, so the current character does not reach quote or brace handling.
3. When the current `char` is `"\\"`, set `escape_next = True` and `continue`, so that backslash itself does not affect `in_string` or brace counting on this iteration.
4. When the current `char` is `"` and the code has not already continued, toggle `in_string` and `continue`, so quote characters only change string state and do not count as structure.
5. Only while `not in_string`, treat `{` and `}` as JSON structure: the first `{` seen at `brace_count == 0` sets `json_start`; every `{` increments `brace_count`; every `}` decrements it; when a `}` brings `brace_count` back to `0` and `json_start != -1`, set `json_end = i + 1` and stop scanning with `break`.
6. After the loop, fail if either boundary was never found by returning `""` and `["No valid JSON object found"]`.
7. On success, compute `before_text = response[:json_start].strip()` and `after_text = response[json_end:].strip()`, append the exact warning strings for any non-empty surrounding text, and return the sliced JSON text plus `warnings`.

**Source**

```python
    def _extract_json_content(self, response: str) -> tuple[str, List[str]]:
        """Extract JSON content from response, handling extra text."""
        warnings = []

        # Try to find JSON object boundaries
        json_start = -1
        json_end = -1
        brace_count = 0
        in_string = False
        escape_next = False

        for i, char in enumerate(response):
            if escape_next:
                escape_next = False
                continue

            if char == "\\":
                escape_next = True
                continue

            if char == '"' and not escape_next:
                in_string = not in_string
                continue

            if not in_string:
                if char == "{":
                    if brace_count == 0:
                        json_start = i
                    brace_count += 1
                elif char == "}":
                    brace_count -= 1
                    if brace_count == 0 and json_start != -1:
                        json_end = i + 1
                        break

        if json_start == -1 or json_end == -1:
            return "", ["No valid JSON object found"]

        # Check for extra text
        before_text = response[:json_start].strip()
        after_text = response[json_end:].strip()

        if before_text:
            warnings.append("Extra text detected before JSON object")
        if after_text:
            warnings.append("Extra text detected after JSON object")

        return response[json_start:json_end], warnings
```

**Non-obvious design decisions**

- The scan tracks `in_string` and `escape_next` separately, so braces only count when they appear outside quoted text. This choice makes `brace_count` reflect top-level structure instead of literal characters inside JSON strings.
- The code uses immediate `continue` after both the prior-escape case and the backslash case. That ordering ensures an escaped quote does not toggle `in_string`, and a backslash character does not also enter the quote or brace branches in the same iteration.
- It stops at the first complete object by `break`ing as soon as `brace_count` returns to zero after `json_start` was set. That favors a single extracted object over trying to parse multiple JSON regions from one `response`.
- It treats surrounding prose as warnings, not failure, by checking `before_text` and `after_text` only after a valid object boundary pair exists. By contrast, missing boundaries produce the single hard failure message `"No valid JSON object found"`.

**Relations**

- **Callers**: `TerminusJSONPlainParser` methods in this class that need a JSON substring from raw text
- **Core callees**: `enumerate(response)` for ordered character scanning; `response[:json_start].strip()` to detect leading non-JSON text; `response[json_end:].strip()` to detect trailing non-JSON text
- **Config / state sources**: none; the body reads no `self._*` attributes or external registers
- **Results to**: Returns `json_text` for later JSON decoding by its caller; Returns warning strings describing surrounding non-JSON text or total extraction failure
- **Related siblings**: `TerminusJSONPlainParser._try_parse_response` performs the later decode and schema checks after extraction; `TerminusJSONPlainParser.parse_response` wraps lower-level parse attempts and warning combination

</details>


<details id="fn-terminusjsonplainparser_validate_json_structure">
<summary><b>TerminusJSONPlainParser._validate_json_structure</b> — terminus_json_plain_parser.py:214-249 · Validate decoded JSON response schema</summary>

> **Stage context**: This helper is part of the stage-4.4 response-parse path. `TerminusJSONPlainParser._try_parse_response` calls it after `_extract_json_content` has found a JSON fragment and `json.loads(...)` has decoded it. In the JSON parser sibling flow, this method handles schema-level checks before `_try_parse_response` normalizes `task_complete` and passes `commands` to `_parse_commands`.

**What this code does**

`_validate_json_structure` checks whether decoded `data` matches the parser's expected top-level JSON shape. It inspects `data`, `json_content`, and the parser configuration in `self.required_fields`, returns a non-empty error string for hard failures, and returns `""` when validation can continue. It also appends non-fatal issues to the caller-provided `warnings` list and delegates field-order checks to `_check_field_order`.

**Interface · params / IO**

`(self, data: dict, json_content: str, warnings: List[str]) -> str`

- params: `data`: `dict` — decoded JSON payload to validate; `json_content`: `str` — raw JSON text, used for field-order checks; `warnings`: `List[str]` — mutable warning accumulator shared with the caller
- reads: `self.required_fields`
- returns: A validation error string for hard schema failures, or `""` if the structure is acceptable enough to continue parsing.
- effects: appends warning messages to `warnings`; calls `self._check_field_order(data, json_content, warnings)`

**Execution flow**

1. It first rejects any non-dictionary `data` and returns `"Response must be a JSON object"` immediately.
2. It checks every name in `self.required_fields`, collects missing ones into `missing_fields`, and returns a single `"Missing required fields: ..."` error if any are absent.
3. It treats `analysis` and `plan` as soft checks: if `data.get("analysis", "")` or `data.get("plan", "")` is not a `str`, it appends a warning instead of failing.
4. It reads `commands = data.get("commands", [])` and hard-fails with `"Field 'commands' must be an array"` if that value is not a `list`.
5. It invokes `self._check_field_order(data, json_content, warnings)` so field-order issues become warnings tied to the original JSON text.
6. It validates `task_complete` only when `data.get("task_complete")` is not `None`; if present and not a `bool` or `str`, it appends a warning, then returns `""` to signal that hard validation passed.

**Source**

```python
    def _validate_json_structure(
        self, data: dict, json_content: str, warnings: List[str]
    ) -> str:
        """Validate the JSON structure has required fields."""
        if not isinstance(data, dict):
            return "Response must be a JSON object"

        # Check for required fields
        missing_fields = []
        for field in self.required_fields:
            if field not in data:
                missing_fields.append(field)

        if missing_fields:
            return f"Missing required fields: {', '.join(missing_fields)}"

        # Validate field types
        if not isinstance(data.get("analysis", ""), str):
            warnings.append("Field 'analysis' should be a string")

        if not isinstance(data.get("plan", ""), str):
            warnings.append("Field 'plan' should be a string")

        commands = data.get("commands", [])
        if not isinstance(commands, list):
            return "Field 'commands' must be an array"

        # Check for correct order of fields (analysis, plan, commands)
        self._check_field_order(data, json_content, warnings)

        # Validate task_complete if present
        task_complete = data.get("task_complete")
        if task_complete is not None and not isinstance(task_complete, (bool, str)):
            warnings.append("Field 'task_complete' should be a boolean or string")

        return ""
```

**Non-obvious design decisions**

- It splits schema problems into hard errors and warnings. The code returns immediately for top-level shape, missing required fields, and non-list `commands`, but only appends warnings for `analysis`, `plan`, and `task_complete` type mismatches. That choice lets `_try_parse_response` keep useful command data when descriptive fields are malformed.
- It accepts `task_complete` as either `bool` or `str` via `isinstance(task_complete, (bool, str))`. This is broader than strict JSON-schema typing, but it matches the parser pipeline where `_try_parse_response` later normalizes that field instead of rejecting the whole response.
- It guards the `task_complete` type check with `task_complete is not None`. That preserves omission as acceptable while still flagging present-but-wrong values, avoiding a warning for missing optional data.
- It validates field order through `_check_field_order(data, json_content, warnings)` using both parsed `data` and raw `json_content`. That separates semantic validation from presentation-order checks, and it keeps ordering issues non-fatal.

**Relations**

- **Callers**: `TerminusJSONPlainParser._try_parse_response`
- **Core callees**: `TerminusJSONPlainParser._check_field_order`
- **Config / state sources**: `self.required_fields`
- **Results to**: returned error string is consumed by `TerminusJSONPlainParser._try_parse_response`; mutated `warnings` list flows into the `ParseResult.warning` assembly in `TerminusJSONPlainParser._try_parse_response` and `TerminusJSONPlainParser.parse_response`
- **Related siblings**: `TerminusJSONPlainParser.parse_response` retries parsing and combines warnings around this validation step; `TerminusJSONPlainParser._try_parse_response` performs decode, calls this validator, then normalizes `task_complete` and parses `commands`; `TerminusJSONPlainParser._extract_json_content` provides the `json_content` string that this function uses for field-order checks; `Terminus2._handle_llm_interaction` later turns parser `error` and `warning` outputs into user-facing `feedback`

</details>


<details id="fn-terminusjsonplainparser_check_field_order">
<summary><b>TerminusJSONPlainParser._check_field_order</b> — terminus_json_plain_parser.py:352-393 · JSON required-field presentation order checker</summary>

> **Stage context**: This helper performs one narrow validation on the raw `response` text: it checks whether the keys `analysis`, `plan`, and `commands` appear in that textual order. The provided sibling synopsis for `TerminusJSONPlainParser._validate_json_structure` states that it delegates field-order checks to `_check_field_order`, so this function contributes a soft warning during JSON structure validation rather than producing parse data itself.

**What this code does**

`_check_field_order` inspects `response` for quoted key occurrences of `analysis`, `plan`, and `commands`, then compares their observed text order against the fixed `expected_order`. It uses `warnings` as its real output: it may append at most one human-readable warning, and only when at least two of those target fields are found and their observed order differs from `expected_present`. It does not return a value and does not mutate any `self` attributes.

**Interface · params / IO**

`(self, data: dict, response: str, warnings: List[str]) -> None`

- params: `self`: `?` — parser instance; present but not read for any `self.` state here; `data`: `dict` — parsed JSON object; accepted by signature but unused in this body; `response`: `str` — original response text searched for key positions with `re.search(...)`; `warnings`: `List[str]` — mutable warning sink; may receive at most one appended message if order is wrong
- returns: Returns `None`; its real product is a possible single appended warning in `warnings`.
- effects: May call `warnings.append(...)` once, but only if at least two target fields are found and `actual_order != expected_present`.

**Execution flow**

1. It fixes the target sequence in `expected_order = ["analysis", "plan", "commands"]` and initializes `positions = {}`.
2. For each field in `expected_order`, it builds the regex `pattern = f'"({field})"\\s*:'`, searches `response` with `re.search(pattern, response)`, and records `match.start()` in `positions[field]` when found.
3. It stops early with `return` when `len(positions) < 2`, because there are not enough discovered fields to compare order.
4. It builds `present_fields` by iterating through `expected_order` again and collecting `(field, positions[field])` only for fields that were found.
5. It sorts `present_fields` by the recorded position to derive `actual_order`, and separately derives `expected_present` by filtering `expected_order` down to the fields present in `positions`.
6. If `actual_order != expected_present`, it formats both orders with `" → ".join(...)` and appends one warning string to `warnings`.

**Source**

```python
    def _check_field_order(
        self, data: dict, response: str, warnings: List[str]
    ) -> None:
        """Check if fields appear in the correct order: analysis, plan, commands."""
        # Expected order for required fields
        expected_order = ["analysis", "plan", "commands"]

        # Find positions of each field in the original response
        positions = {}
        for field in expected_order:
            # Look for the field name in quotes
            pattern = f'"({field})"\\s*:'
            match = re.search(pattern, response)
            if match:
                positions[field] = match.start()

        # Check if we have at least 2 fields to compare order
        if len(positions) < 2:
            return

        # Get fields that are present, in the order they appear
        present_fields = []
        for field in expected_order:
            if field in positions:
                present_fields.append((field, positions[field]))

        # Sort by position to get actual order
        actual_order = [
            field for field, pos in sorted(present_fields, key=lambda x: x[1])
        ]

        # Get expected order for present fields only
        expected_present = [f for f in expected_order if f in positions]

        # Compare orders
        if actual_order != expected_present:
            actual_str = " → ".join(actual_order)
            expected_str = " → ".join(expected_present)
            warnings.append(
                f"Fields appear in wrong order. Found: {actual_str}, "
                f"expected: {expected_str}"
            )
```

**Non-obvious design decisions**

- It checks order against the raw `response` text via `re.search(...)` and `match.start()` instead of relying on `data`. That choice preserves the original presentation order, which a parsed `dict` parameter does not expose in this function.
- It compares only the subset in `expected_present` rather than requiring all three keys. That lets it warn about misordering among whichever target fields were actually found, while skipping cases where fewer than two positions exist.
- It records the issue through `warnings.append(...)` instead of raising or returning an error value. The code treats wrong field order as a soft formatting problem, not as a hard failure.

**Relations**

- **Callers**: `TerminusJSONPlainParser._validate_json_structure` delegates field-order checks here according to the provided sibling synopsis
- **Core callees**: `re.search` to locate each quoted field name in `response`; `sorted(..., key=lambda x: x[1])` to order found fields by position; `warnings.append(...)` to report one mismatch message; `" → ".join(...)` to format found and expected orders
- **Config / state sources**: Local constant `expected_order` defines the only accepted sequence: `analysis`, `plan`, `commands`; Argument `response` supplies the raw text searched for field positions; Argument `warnings` supplies the mutable destination for any soft validation message; Argument `data` is part of the interface but unused in this implementation
- **Results to**: `warnings` list passed by the caller; Caller-visible `None` return after optional warning append
- **Related siblings**: `TerminusJSONPlainParser._validate_json_structure`; `TerminusJSONPlainParser._try_parse_response`; `TerminusJSONPlainParser.parse_response`

</details>


<details id="fn-terminusjsonplainparser_parse_commands">
<summary><b>TerminusJSONPlainParser._parse_commands</b> — terminus_json_plain_parser.py:251-303 · Validate command objects into parsed command records</summary>

> **Stage context**: This helper sits inside the stage-4.4 response-parsing path. `TerminusJSONPlainParser._try_parse_response` calls it after JSON decoding and top-level schema checks to turn the `commands` payload into `ParsedCommand` objects. It complements `_validate_json_structure` by handling per-command validation, and its warnings flow back through `parse_response` and then `Terminus2._handle_llm_interaction` into the stage feedback string.

**What this code does**

`_parse_commands` inspects `commands_data`, which should be a list of command dictionaries, and converts each valid entry into a `ParsedCommand`. It returns a pair `(commands, error_message)`, where any hard validation failure returns `[]` plus a non-empty error string, and successful parsing returns the built command list plus `""`. It also appends non-fatal notices into the caller-supplied `warnings` list for missing or invalid `duration`, unknown fields, and missing trailing newlines before later commands. The function does not read or write any `self` state.

**Interface · params / IO**

`(self, commands_data: List[dict], warnings: List[str]) -> tuple[List[ParsedCommand], str]`

- params: `self`: `?` — parser instance; unused for state access in this method; `commands_data`: `List[dict]` — decoded JSON `commands` payload to validate and convert; `warnings`: `List[str]` — caller-owned warning accumulator that this method appends to
- returns: A `(commands, error_message)` tuple. On success, `commands` is a `List[ParsedCommand]` and `error_message` is `""`; on hard validation failure, `commands` is `[]` and `error_message` explains the first fatal issue found.
- effects: appends human-readable warning strings to the passed-in `warnings` list

**Execution flow**

1. Initialize an empty `commands` list, then walk `commands_data` with `enumerate` so each message can name `Command {i + 1}`.
2. For each `cmd_data`, reject non-dict entries immediately with `([], f"Command {i + 1} must be an object")`, then require a `keystrokes` key and require `cmd_data["keystrokes"]` to be a string.
3. Read optional `duration`: if the key is missing, append a warning and use `1.0`; if present but not an `int` or `float`, append a warning and also fall back to `1.0`.
4. Compute `unknown_fields` as `set(cmd_data.keys()) - {"keystrokes", "duration"}` and append a warning when extra keys are present.
5. If this is not the last command and `keystrokes` does not end with `"\n"`, append a warning about line concatenation risk across adjacent commands.
6. Create `ParsedCommand(keystrokes=keystrokes, duration=float(duration))`, append it to `commands`, and after the loop return `(commands, "")`.

**Source**

```python
    def _parse_commands(
        self, commands_data: List[dict], warnings: List[str]
    ) -> tuple[List[ParsedCommand], str]:
        """Parse commands array into ParsedCommand objects."""
        commands = []

        for i, cmd_data in enumerate(commands_data):
            if not isinstance(cmd_data, dict):
                return [], f"Command {i + 1} must be an object"

            # Check for required keystrokes field
            if "keystrokes" not in cmd_data:
                return [], f"Command {i + 1} missing required 'keystrokes' field"

            keystrokes = cmd_data["keystrokes"]
            if not isinstance(keystrokes, str):
                return [], f"Command {i + 1} 'keystrokes' must be a string"

            # Parse optional fields with defaults
            if "duration" in cmd_data:
                duration = cmd_data["duration"]
                if not isinstance(duration, (int, float)):
                    warnings.append(
                        f"Command {i + 1}: Invalid duration value, using default 1.0"
                    )
                    duration = 1.0
            else:
                warnings.append(
                    f"Command {i + 1}: Missing duration field, using default 1.0"
                )
                duration = 1.0

            # Check for unknown fields
            known_fields = {"keystrokes", "duration"}
            unknown_fields = set(cmd_data.keys()) - known_fields
            if unknown_fields:
                warnings.append(
                    f"Command {i + 1}: Unknown fields: {', '.join(unknown_fields)}"
                )

            # Check for newline at end of keystrokes if followed by another command
            if i < len(commands_data) - 1 and not keystrokes.endswith("\n"):
                warnings.append(
                    f"Command {i + 1} should end with newline when followed "
                    "by another command. Otherwise the two commands will be "
                    "concatenated together on the same line."
                )

            commands.append(
                ParsedCommand(keystrokes=keystrokes, duration=float(duration))
            )

        return commands, ""
```

**Non-obvious design decisions**

- It treats `keystrokes` as a hard requirement but treats `duration` as recoverable. The branches around `"keystrokes"` and `isinstance(keystrokes, str)` abort immediately, while bad or missing `duration` only adds to `warnings` and falls back to `1.0`. That choice preserves executable command text when timing metadata is weak.
- It stops at the first fatal command error instead of collecting every structural problem. The early `return [], ...` branches keep downstream code from receiving a partially parsed command list, at the cost of less comprehensive error reporting in one pass.
- It warns about unknown keys instead of rejecting them. The `unknown_fields` check makes the parser strict enough to surface schema drift but permissive enough to keep useful commands.
- It checks for a trailing newline only when another command follows. The `i < len(commands_data) - 1` guard reflects the real hazard: separate command payloads can concatenate on one shell line, so the parser reports this as advisory formatting risk rather than invalid syntax.

**Relations**

- **Callers**: `TerminusJSONPlainParser._try_parse_response`
- **Core callees**: `enumerate` over `commands_data`; `isinstance` for dict/string/number validation; `set(cmd_data.keys())` to detect unknown fields; `ParsedCommand(...)` constructor; `float(duration)` coercion
- **Config / state sources**: `commands_data` argument supplies the decoded command objects; `warnings` argument supplies the mutable warning sink shared with parser siblings
- **Results to**: returned `commands` populate `ParseResult.commands` in `TerminusJSONPlainParser._try_parse_response`; returned error string becomes the parse error path in `TerminusJSONPlainParser._try_parse_response`; appended warnings are carried through `TerminusJSONPlainParser.parse_response`; those warnings are later folded into `feedback` by `Terminus2._handle_llm_interaction`
- **Related siblings**: `TerminusJSONPlainParser._try_parse_response` calls this after `_validate_json_structure` passes; `TerminusJSONPlainParser.parse_response` may combine this method's warnings with auto-correction warnings; `Terminus2._handle_llm_interaction` converts successful `ParsedCommand` results into `Command` objects with duration clamping

</details>


<details id="fn-terminusjsonplainparser_fix_mixed_content">
<summary><b>TerminusJSONPlainParser._fix_mixed_content</b> — terminus_json_plain_parser.py:330-343 · Mixed-content JSON candidate extractor</summary>

> **Stage context**: This helper belongs to the stage's parser-side recovery toolkit. Within this entry's own code, it only searches a `response` string for brace-delimited candidates and tests them as JSON; it does not inspect parser configuration or mutate parser state.

**What this code does**

`_fix_mixed_content` scans `response` for substrings that look like JSON objects and returns the first candidate that `json.loads` accepts. It takes `error` as a parameter but this body never reads it. On success it returns `(match, True)`; if no candidate parses, it returns the original `response` unchanged with `False`. It reads no `self` attributes and writes no state.

**Interface · params / IO**

`(self, response: str, error: str) -> tuple[str, bool]`

- params: `self`: `?` — parser instance; unused by this method body; `response`: `str` — source text to search for brace-delimited JSON-like substrings; `error`: `str` — unused input parameter
- returns: A tuple `(text, ok)` where `text` is either the first candidate substring accepted by `json.loads` or the original `response`, and `ok` is `True` on successful extraction and `False` otherwise.

**Execution flow**

1. Build `json_pattern = r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}"` and call `re.findall(json_pattern, response, re.DOTALL)` to collect brace-delimited, object-like substrings from `response`.
2. Iterate through each `match` from `matches` and call `json.loads(match)` to validate whether that candidate is real JSON.
3. If `json.loads(match)` succeeds for a candidate, return that exact `match` with `True` immediately.
4. If `json.loads(match)` raises `json.JSONDecodeError`, ignore that candidate and continue to the next one; the function does not handle other exception types here.
5. If no candidate survives validation, return the original `response` with `False`.

**Source**

```python
    def _fix_mixed_content(self, response: str, error: str) -> tuple[str, bool]:
        """Extract JSON from response with mixed content."""
        # Look for JSON-like patterns
        json_pattern = r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}"
        matches = re.findall(json_pattern, response, re.DOTALL)

        for match in matches:
            try:
                json.loads(match)
                return match, True
            except json.JSONDecodeError:
                continue

        return response, False
```

**Non-obvious design decisions**

- It separates candidate extraction from acceptance: the regex only finds object-like text, and `json.loads` makes the final decision. That avoids trusting the pattern to recognize valid JSON on its own.
- The pattern targets brace-delimited substrings, not arbitrary JSON values. This keeps the search focused on object-shaped fragments, but it also means the method is only an approximation for nested structures.
- The `except` block catches only `json.JSONDecodeError` and then continues scanning. This choice deliberately treats malformed candidates as normal misses instead of failing the whole recovery attempt.

**Relations**

- **Callers**: Unknown from provided code; this entry does not show its caller
- **Core callees**: `re.findall`; `json.loads`
- **Config / state sources**: `response` argument; `error` argument (present but unused)
- **Results to**: Its direct caller, via the returned `(text, ok)` tuple

</details>


<details id="fn-terminusxmlplainparser_parse_response">
<summary><b>TerminusXMLPlainParser.parse_response</b> — terminus_xml_plain_parser.py:28-60 · </summary>

> **Stage context**: 

**What this code does**



**Source**

```python
    def parse_response(self, response: str) -> ParseResult:
        """
        Parse a terminus XML plain response and extract commands.

        Args:
            response: The full LLM response string

        Returns:
            ParseResult with commands, completion status, errors and warnings
        """
        # Try normal parsing first
        result = self._try_parse_response(response)

        if result.error:
            # Try auto-fixes in order until one works
            for fix_name, fix_function in self._get_auto_fixes():
                corrected_response, was_fixed = fix_function(response, result.error)
                if was_fixed:
                    corrected_result = self._try_parse_response(corrected_response)

                    if corrected_result.error == "":
                        # Success! Add auto-correction warning
                        auto_warning = (
                            f"AUTO-CORRECTED: {fix_name} - "
                            "please fix this in future responses"
                        )
                        corrected_result.warning = self._combine_warnings(
                            auto_warning, corrected_result.warning
                        )
                        return corrected_result

        # Return original result if no fix worked
        return result
```

**Non-obvious design decisions**



**Relations**



</details>


<details id="fn-terminusxmlplainparser_try_parse_response">
<summary><b>TerminusXMLPlainParser._try_parse_response</b> — terminus_xml_plain_parser.py:62-169 · Parse one XML reply into ParseResult</summary>

> **Stage context**: This function is the XML parser's core stage-4.4 worker for turning one LLM reply string into the normalized `ParseResult` that later response-handling code consumes. `TerminusXMLPlainParser.parse_response` calls it before any higher-level feedback mapping happens. In the XML path, it plays the same role that `TerminusJSONPlainParser._try_parse_response` plays for JSON, but it works through XML-specific helpers for wrapper extraction, section discovery, completion detection, and command parsing.

**What this code does**

`_try_parse_response` consumes a full XML-formatted `response` string and returns a `ParseResult(commands, is_task_complete, error, warning, analysis, plan)`. It validates the outer `<response>` wrapper, extracts section content, detects completion through `is_complete`, and parses `<commands>` content into command objects through `_parse_xml_commands`. It accumulates human-readable warnings in `warnings` and returns parse failures as `error` strings instead of raising. It does not mutate any instance state.

**Interface · params / IO**

`(self, response: str) -> ParseResult`

- params: `response`: `str` — full LLM reply to parse as Terminus plain XML
- returns: a `ParseResult` containing parsed commands, completion flag, parse error text, warning text, and extracted `analysis` / `plan` section text

**Execution flow**

1. It starts a local `warnings` list, then calls `_check_extra_text(response, warnings)` so any text outside the expected `<response>` wrapper becomes non-fatal warning output.
2. It extracts the wrapper body with `_extract_response_content(response)`; if that returns a falsey value, it stops immediately and returns a `ParseResult` with `error` set to `"No <response> tag found"`, no commands, `False` completion, and any accumulated warnings joined into the bullet-list string format.
3. It computes `is_complete` from `_check_task_complete(response_content)`, then calls `_extract_sections(response_content, warnings)` to gather named section payloads and section-related warnings.
4. It pulls `analysis` and `plan` from `sections` with default `""`, then inspects `commands_content = sections.get("commands", "")` to decide whether commands are present, empty, or missing.
5. If `commands_content` is empty but the key `"commands"` exists in `sections`, it treats that as an empty commands section: when `is_complete` is false it appends a specific waiting-related warning, and then returns success-with-no-commands using the current `is_complete`, `analysis`, and `plan` values.
6. If the `"commands"` section is missing entirely, it accepts that only when `is_complete` is true; otherwise it returns a hard parse error `"Missing <commands> section"` with no commands.
7. When command content exists, it delegates to `_parse_xml_commands(commands_content, warnings)`; if that returns `parse_error`, the function downgrades that error into an added warning when `is_complete` is true, but returns it as the `error` field when `is_complete` is false.
8. If command parsing succeeds, it returns a `ParseResult` with the parsed `commands`, the previously computed `is_complete`, an empty `error`, the joined warning string, and the extracted `analysis` and `plan` text.

**Source**

```python
    def _try_parse_response(self, response: str) -> ParseResult:
        """
        Try to parse a terminus XML plain response.

        Args:
            response: The full LLM response string

        Returns:
            ParseResult with commands, completion status, errors and warnings
        """
        warnings = []

        # Check for extra text before/after <response> tags
        self._check_extra_text(response, warnings)

        # Extract <response> content
        response_content = self._extract_response_content(response)
        if not response_content:
            return ParseResult(
                [],
                False,
                "No <response> tag found",
                "- " + "\n- ".join(warnings) if warnings else "",
                "",
                "",
            )

        # Check if task is complete first
        is_complete = self._check_task_complete(response_content)

        # Check for required sections and extract content
        sections = self._extract_sections(response_content, warnings)

        # Extract analysis and plan for reasoning content
        analysis = sections.get("analysis", "")
        plan = sections.get("plan", "")

        # Extract commands section
        commands_content = sections.get("commands", "")
        if not commands_content:
            if "commands" in sections:
                # Commands section exists but is empty
                if not is_complete:
                    warnings.append(
                        "Commands section is empty; not taking any action. "
                        "If you want to wait a specific amount of time please use "
                        "`sleep`, but if you're waiting for a command to finish then "
                        "continue to wait."
                    )
                return ParseResult(
                    [],
                    is_complete,
                    "",
                    "- " + "\n- ".join(warnings) if warnings else "",
                    analysis,
                    plan,
                )
            else:
                # Commands section is missing entirely
                if is_complete:
                    return ParseResult(
                        [],
                        True,
                        "",
                        "- " + "\n- ".join(warnings) if warnings else "",
                        analysis,
                        plan,
                    )
                return ParseResult(
                    [],
                    False,
                    "Missing <commands> section",
                    "- " + "\n- ".join(warnings) if warnings else "",
                    analysis,
                    plan,
                )

        # Parse commands directly from XML (no code blocks in plain format)
        commands, parse_error = self._parse_xml_commands(commands_content, warnings)
        if parse_error:
            # If task is complete, parse errors are just warnings
            if is_complete:
                warnings.append(parse_error)
                return ParseResult(
                    [],
                    True,
                    "",
                    "- " + "\n- ".join(warnings) if warnings else "",
                    analysis,
                    plan,
                )
            return ParseResult(
                [],
                False,
                parse_error,
                "- " + "\n- ".join(warnings) if warnings else "",
                analysis,
                plan,
            )

        return ParseResult(
            commands,
            is_complete,
            "",
            "- " + "\n- ".join(warnings) if warnings else "",
            analysis,
            plan,
        )
```

**Non-obvious design decisions**

- It separates hard failures from recoverable format issues by collecting `warnings` locally and returning them in `ParseResult.warning`. That keeps stage-4.4 parsing tolerant of wrapper noise and section quirks, while still preserving machine-readable failure state in `error` for callers that need to gate execution.
- It checks `is_complete` before enforcing command validity so a completion-marked reply can omit usable commands. That choice appears in both the missing-`<commands>` branch and the `parse_error` branch, and it avoids rejecting final-answer messages just because they no longer carry executable actions.
- It distinguishes an empty `<commands>` section from a missing `<commands>` section by testing both `commands_content` and `"commands" in sections`. This lets the parser give a softer, instructional warning for an explicitly empty section while still treating a truly absent section as malformed unless the task is already complete.
- It returns bullet-formatted warning text (`"- " + "\n- ".join(warnings)`) at every exit point instead of exposing the raw list. That keeps this function aligned with the stage contract described for later feedback mapping, where downstream code expects warning text rather than parser-internal list structure.

**Relations**

- **Callers**: `TerminusXMLPlainParser.parse_response`
- **Core callees**: `TerminusXMLPlainParser._check_extra_text`; `TerminusXMLPlainParser._extract_response_content`; `TerminusXMLPlainParser._check_task_complete`; `TerminusXMLPlainParser._extract_sections`; `TerminusXMLPlainParser._parse_xml_commands`
- **Config / state sources**: input parameter `response`; local `warnings` accumulator populated by helper calls; section mapping returned by `_extract_sections`; command parse result returned by `_parse_xml_commands`
- **Results to**: `TerminusXMLPlainParser.parse_response`; stage-4.4 response-parse output contract; `_handle_llm_interaction` warning/error to feedback mapping described in the owning stage; later command-wrapping logic that consumes `ParseResult.commands`
- **Related siblings**: `TerminusJSONPlainParser._try_parse_response` is the JSON-path counterpart with the same `ParseResult` target but different extraction and validation strategy.; `TerminusXMLPlainParser.parse_response` is the public XML entry point that wraps this lower-level attempt function.

</details>


<details id="fn-terminusxmlplainparser_check_extra_text">
<summary><b>TerminusXMLPlainParser._check_extra_text</b> — terminus_xml_plain_parser.py:196-223 · Warn on XML text outside response block</summary>

> **Stage context**: This helper belongs to the XML response parser path in `TerminusXMLPlainParser`. It runs as a structural check on the raw `response` string and contributes only warning text, complementing `_try_parse_response`, which handles the main XML extraction and error reporting.

**What this code does**

`_check_extra_text` inspects a raw XML-like `response` string for non-whitespace text outside the first `<response>` / `</response>` block. It takes `response` and a mutable `warnings` list, returns `None`, and communicates solely by appending warning strings to `warnings`. It adds `"Extra text detected before <response> tag"` when stripped text exists before the first opening tag, `"Extra text detected after </response> tag"` when stripped text exists after a found closing tag, and an additional `IMPORTANT:` warning only when that trailing extra text exists and `response.count("<response>") > 1`.

**Interface · params / IO**

`(self, response: str, warnings: List[str]) -> None`

- params: `self`: `?` — parser instance; this body does not read instance attributes; `response`: `str` — raw model output to scan for text before or after `<response>` tags; `warnings`: `List[str]` — mutable accumulator that receives any detected warning messages
- returns: None; the real output is mutation of `warnings`
- effects: Appends `"Extra text detected before <response> tag"` if `response[:start_pos].strip()` is non-empty; Appends `"Extra text detected after </response> tag"` if `end_pos != -1` and `response[end_pos + len("</response>"):].strip()` is non-empty; Appends `"IMPORTANT: Only issue one <response> block at a time. You issued {total_response_count} and only the first was executed."` only when trailing extra text was detected and `response.count("<response>") > 1`

**Execution flow**

1. It computes both tag positions up front with `response.find("<response>")` and `response.find("</response>")` into `start_pos` and `end_pos`.
2. If `start_pos == -1`, it returns immediately and emits no warnings from this helper.
3. It slices `response[:start_pos]`, strips whitespace into `before_text`, and appends `"Extra text detected before <response> tag"` when that text is non-empty.
4. It checks trailing text only when `end_pos != -1`: it slices from just after `</response>`, strips into `after_text`, and appends `"Extra text detected after </response> tag"` when that text is non-empty.
5. Inside that same trailing-text branch, it counts opening tags with `response.count("<response>")` and appends the `IMPORTANT:` warning only if the count is greater than 1.

**Source**

```python
    def _check_extra_text(self, response: str, warnings: List[str]) -> None:
        """Check for extra text before/after <response> tags."""
        # Find response tag positions
        start_pos = response.find("<response>")
        end_pos = response.find("</response>")

        if start_pos == -1:
            return  # Will be handled as error later

        # Check text before <response>
        before_text = response[:start_pos].strip()
        if before_text:
            warnings.append("Extra text detected before <response> tag")

        # Check text after </response> if closing tag exists
        if end_pos != -1:
            after_text = response[end_pos + len("</response>") :].strip()
            if after_text:
                warnings.append("Extra text detected after </response> tag")

                # Count total <response> tags
                total_response_count = response.count("<response>")
                if total_response_count > 1:
                    warnings.append(
                        f"IMPORTANT: Only issue one <response> block at a time. "
                        f"You issued {total_response_count} and only the first "
                        f"was executed."
                    )
```

**Non-obvious design decisions**

- The function treats a missing opening tag as out of scope for warnings: the `if start_pos == -1: return` branch suppresses all extra-text checks in that case.
- It warns about leading text independently of the closing tag, because the `before_text` check runs as soon as an opening tag exists, while the `after_text` check is separately gated by `if end_pos != -1`.
- It ties duplicate-`<response>` reporting to actual trailing spillover, not merely to multiple openings anywhere in the string, because `response.count("<response>")` runs only inside the `if after_text:` branch.

**Relations**

- **Callers**: `TerminusXMLPlainParser._try_parse_response`
- **Core callees**: `str.find` on `response` for `<response>` and `</response>`; `str.strip` on the before/after slices; `warnings.append`; `str.count` on `response` for `<response>`
- **Config / state sources**: `response` argument; `warnings` argument
- **Results to**: the caller-provided `warnings` list; `TerminusXMLPlainParser._try_parse_response` warning accumulation; the XML parser path alongside `TerminusXMLPlainParser.parse_response`; sibling XML parse logic that also validates response structure
- **Related siblings**: `TerminusXMLPlainParser.parse_response`; `TerminusXMLPlainParser._try_parse_response`

</details>


<details id="fn-terminusxmlplainparser_extract_sections">
<summary><b>TerminusXMLPlainParser._extract_sections</b> — terminus_xml_plain_parser.py:238-318 · Extract and validate XML response sections</summary>

> **Stage context**: This helper sits inside stage 4.4's XML response parsing path. `TerminusXMLPlainParser._try_parse_response` calls it after it has identified the XML-like response body and before later logic interprets section contents such as command XML and completion flags. It complements sibling helpers that check extra wrapper text and parse commands by turning raw section markup into a normalized `dict` plus warning messages.

**What this code does**

`_extract_sections` scans `content` for `<analysis>`, `<plan>`, `<commands>`, and `<task_complete>` blocks and returns a dictionary of the sections it found, with each value stripped to plain inner text. It accepts three encodings for each section: a normal open/close pair, a self-closing tag, or an explicitly empty pair, and the normal pair search uses `re.DOTALL` so section bodies may span multiple lines. It appends diagnostics to `warnings` for missing required sections except `task_complete`, unknown direct-child tags reported by `_find_top_level_tags`, duplicate expected tags counted over `self.required_sections + ["task_complete"]`, and any ordering issues delegated to `_check_section_order`.

**Interface · params / IO**

`(self, content: str, warnings: List[str]) -> dict`

- params: `content`: `str` — Raw XML-like response text to scan for section tags; `warnings`: `List[str]` — Caller-owned list that collects non-fatal validation messages
- reads: `self.required_sections`, `self._find_top_level_tags`, `self._check_section_order`
- returns: A `dict` mapping found section names to stripped inner text, with empty strings for self-closing or explicitly empty tags
- effects: Appends missing-section warnings to `warnings` for required sections other than `task_complete`; Appends unknown top-level tag warnings to `warnings` based on `self._find_top_level_tags(content)`; Appends duplicate-section warnings to `warnings` when counts over `self.required_sections + ["task_complete"]` exceed one; Passes `content` and `warnings` to `self._check_section_order`, which may append ordering warnings

**Execution flow**

1. Initialize `sections` and `found_sections`, then define `section_patterns` for the four supported section names: each name gets a full open/close regex, a self-closing regex, and an explicit empty-pair regex.
2. For each entry in `section_patterns`, try the full open/close pattern first with `re.search(full_pattern, content, re.DOTALL)`; on a match, store `match.group(1).strip()` under that section name and mark it in `found_sections`.
3. If the full pattern did not match, look for the self-closing form and then the explicit empty form; either case records that section with `""` as its value and adds the name to `found_sections`.
4. Compute `missing` as `set(self.required_sections) - found_sections` and append `Missing <...> section` for each missing required section except `task_complete`, which this branch treats as optional.
5. Call `self._find_top_level_tags(content)` to get direct-child tag names, compare them against `set(self.required_sections + ["task_complete"])`, and append an `Unknown tag found` warning for each unexpected top-level tag.
6. Count duplicates by iterating over `self.required_sections + ["task_complete"]` and running `re.findall(f"<{section_name}(?:\\s|>|/>)", content)`; append a special `IMPORTANT:` warning for duplicate `commands` tags and a generic multiple-section warning for other names.
7. Delegate final ordering checks to `self._check_section_order(content, warnings)`, then return the assembled `sections` dictionary.

**Source**

```python
    def _extract_sections(self, content: str, warnings: List[str]) -> dict:
        """Extract analysis, plan, commands, and task_complete sections."""
        sections = {}
        found_sections = set()

        # Define patterns for each section
        section_patterns = {
            "analysis": (
                r"<analysis>(.*?)</analysis>",
                r"<analysis\s*/>",
                r"<analysis></analysis>",
            ),
            "plan": (r"<plan>(.*?)</plan>", r"<plan\s*/>", r"<plan></plan>"),
            "commands": (
                r"<commands>(.*?)</commands>",
                r"<commands\s*/>",
                r"<commands></commands>",
            ),
            "task_complete": (
                r"<task_complete>(.*?)</task_complete>",
                r"<task_complete\s*/>",
                r"<task_complete></task_complete>",
            ),
        }

        for section_name, patterns in section_patterns.items():
            full_pattern, self_closing_pattern, empty_pattern = patterns

            # Try full pattern first
            match = re.search(full_pattern, content, re.DOTALL)
            if match:
                sections[section_name] = match.group(1).strip()
                found_sections.add(section_name)
                continue

            # Try self-closing pattern
            if re.search(self_closing_pattern, content):
                sections[section_name] = ""  # Self-closing = empty content
                found_sections.add(section_name)
                continue

            # Try empty pattern
            if re.search(empty_pattern, content):
                sections[section_name] = ""  # Empty = empty content
                found_sections.add(section_name)
                continue

        # Check for missing required sections
        required = set(self.required_sections)
        missing = required - found_sections
        for section in missing:
            if section != "task_complete":  # task_complete is optional
                warnings.append(f"Missing <{section}> section")

        # Check for unexpected tags at the direct child level of <response> only
        # Find all top-level tags (not nested inside other tags)
        top_level_tags = self._find_top_level_tags(content)
        expected_tags = set(self.required_sections + ["task_complete"])
        unexpected = set(top_level_tags) - expected_tags
        for tag in unexpected:
            warnings.append(
                f"Unknown tag found: <{tag}>, expected "
                f"analysis/plan/commands/task_complete"
            )

        # Check for multiple instances of same tag
        for section_name in self.required_sections + ["task_complete"]:
            tag_count = len(re.findall(f"<{section_name}(?:\\s|>|/>)", content))
            if tag_count > 1:
                if section_name == "commands":
                    warnings.append(
                        f"IMPORTANT: Only issue one <commands> block at a time. "
                        f"You issued {tag_count} and only the first was executed."
                    )
                else:
                    warnings.append(f"Multiple <{section_name}> sections found")

        # Check for correct order of sections (analysis, plan, commands)
        self._check_section_order(content, warnings)

        return sections
```

**Non-obvious design decisions**

- It recognizes three tag forms per section—full, self-closing, and explicit empty—so callers receive a section key with `""` instead of treating empty content as missing. Without the extra self-closing and empty-pattern branches, the function would collapse 'present but empty' into 'not found'.
- It searches the full open/close form before empty forms and only stores one value per section name. That choice makes the first full match the extracted payload while leaving duplicate detection to a later counting pass, instead of trying to merge or reconcile repeated sections.
- It exempts `task_complete` in the missing-section loop even though `task_complete` still appears in extraction and duplicate checks. The code separates 'may appear and should be parsed if present' from 'must exist to avoid a warning'.
- It limits unknown-tag warnings to names returned by `_find_top_level_tags(content)` rather than scanning every nested tag. That keeps the warning scope tied to direct children of `<response>` and avoids flagging nested command markup as an unknown response section.
- It iterates duplicate checks over `self.required_sections + ["task_complete"]`, not over the hard-coded `section_patterns` keys alone. That keeps the duplicate-warning scope aligned with configured expected sections while still always checking `task_complete`.

**Relations**

- **Callers**: `TerminusXMLPlainParser._try_parse_response`
- **Core callees**: `re.search`; `re.findall`; `self._find_top_level_tags`; `self._check_section_order`
- **Config / state sources**: `self.required_sections`
- **Results to**: Returned `sections` dict feeds later section interpretation in `TerminusXMLPlainParser._try_parse_response`; Mutated `warnings` list contributes non-fatal parser diagnostics returned from `TerminusXMLPlainParser._try_parse_response`; Extracted `commands` section text is later consumed by XML command parsing in the caller; Extracted `task_complete` text is later consumed by completion detection in the caller
- **Related siblings**: `TerminusXMLPlainParser.parse_response`; `TerminusXMLPlainParser._try_parse_response`; `TerminusXMLPlainParser._check_extra_text`

</details>


<details id="fn-terminusxmlplainparser_check_section_order">
<summary><b>TerminusXMLPlainParser._check_section_order</b> — terminus_xml_plain_parser.py:442-480 · XML section order warning checker</summary>

> **Stage context**: This helper is a local validator for XML-like section ordering. It inspects a raw `content` string for the opening tags of `analysis`, `plan`, and `commands`, and reports only a warning through the caller-provided `warnings` list when the found order disagrees with the fixed expected sequence.

**What this code does**

`_check_section_order` scans `content` for the first opening-tag occurrence of `analysis`, `plan`, and `commands`. For each section, it records `match.start()` from `re.search(f"<{section}(?:\\s|>|/>)", content)`, so it recognizes `<section>`, `<section ...>`, and `<section/>` forms. It returns `None` and communicates only by possibly appending one warning to `warnings`, and it does that only when at least two target sections are present and their observed text order differs from the expected `analysis → plan → commands` order after filtering to the sections actually found.

**Interface · params / IO**

`(self, content: str, warnings: List[str]) -> None`

- params: `self`: `?` — instance parameter; this body does not read instance state; `content`: `str` — input string scanned for the first opening-tag match of `analysis`, `plan`, and `commands`; `warnings`: `List[str]` — mutable output list that receives one human-readable order warning when two or more matched sections are out of order
- returns: None; the real product is a possible `warnings.append(...)` side effect
- effects: May append `"Sections appear in wrong order. Found: ... expected: ..."` to `warnings` only when at least two target sections were matched and `actual_order != expected_present`

**Execution flow**

1. Build `positions` by looping over `"analysis"`, `"plan"`, and `"commands"`, running `re.search(f"<{section}(?:\\s|>|/>)", content)` for each, and storing `positions[section] = match.start()` only for sections whose first opening-tag match exists.
2. Stop early with `return` when `len(positions) < 2`, because there are not enough matched sections to compare order.
3. Define the fixed `expected_order = ["analysis", "plan", "commands"]`, then build `present_sections` by iterating that expected order and collecting `(section, positions[section])` pairs only for sections present in `positions`.
4. Sort `present_sections` by the recorded start offset to produce `actual_order`, and separately build `expected_present` by filtering `expected_order` down to the sections found in `positions`.
5. Compare `actual_order` against `expected_present`; if they differ, format both sequences with `" → ".join(...)` and append one warning string to `warnings`.

**Source**

```python
    def _check_section_order(self, content: str, warnings: List[str]) -> None:
        """Check if sections appear in the correct order: analysis, plan, commands."""
        # Find positions of each section
        positions = {}
        for section in ["analysis", "plan", "commands"]:
            # Look for opening tags
            match = re.search(f"<{section}(?:\\s|>|/>)", content)
            if match:
                positions[section] = match.start()

        # Check if we have at least 2 sections to compare order
        if len(positions) < 2:
            return

        # Expected order
        expected_order = ["analysis", "plan", "commands"]

        # Get sections that are present, in the order they appear
        present_sections = []
        for section in expected_order:
            if section in positions:
                present_sections.append((section, positions[section]))

        # Sort by position to get actual order
        actual_order = [
            section for section, pos in sorted(present_sections, key=lambda x: x[1])
        ]

        # Get expected order for present sections only
        expected_present = [s for s in expected_order if s in positions]

        # Compare orders
        if actual_order != expected_present:
            actual_str = " → ".join(actual_order)
            expected_str = " → ".join(expected_present)
            warnings.append(
                f"Sections appear in wrong order. Found: {actual_str}, "
                f"expected: {expected_str}"
            )
```

**Non-obvious design decisions**

- It uses a regex on opening tags instead of parsing XML structure. The pattern `(?:\s|>|/>)` deliberately accepts three syntactic forms—plain open tags, open tags with attributes or whitespace, and self-closing tags—while keeping the check lightweight.
- It records only `match.start()` from `re.search`, so each section's position comes from the first matching opening tag in `content`. That choice makes the check a first-occurrence ordering test and ignores later duplicate tags.
- It returns immediately when fewer than two sections matched. This avoids emitting a misleading order warning when the code cannot form a meaningful comparison.
- It filters the expected order down to `expected_present` before comparing. That means missing sections do not count as an ordering error; only the relative order of sections that were actually found matters.
- It builds `present_sections` by iterating `expected_order` before sorting by position, rather than iterating `positions.items()`. That keeps the comparison anchored to the fixed canonical section list and avoids depending on dictionary insertion order.

**Relations**

- **Callers**: external caller not proven from this function's source
- **Core callees**: `re.search`; `sorted`; `warnings.append`; `str.join`
- **Config / state sources**: hard-coded `expected_order = ["analysis", "plan", "commands"]` inside this function; hard-coded regex template `f"<{section}(?:\\s|>|/>)"` inside this function
- **Results to**: the caller-provided `warnings` list; local `positions` mapping; local `present_sections` list; local `actual_order` and `expected_present` comparisons
- **Related siblings**: `TerminusXMLPlainParser._extract_sections` is a related helper mentioned in sibling context, but that call relationship is not proven by this function's source

</details>


<details id="fn-terminusxmlplainparser_check_task_complete">
<summary><b>TerminusXMLPlainParser._check_task_complete</b> — terminus_xml_plain_parser.py:514-526 · XML task completion flag detector</summary>

> **Stage context**: This helper contributes one small part of stage 4.4 response parsing: it turns the XML `<task_complete>` section into the boolean completion flag that ends up in the stage parse result. `TerminusXMLPlainParser._try_parse_response` invokes it while assembling `ParseResult(...)` from an LLM reply. It complements sibling helpers that extract sections and warnings, but unlike `_extract_sections` or `_check_section_order`, it produces only a boolean and no diagnostics.

**What this code does**

`_check_task_complete` inspects the `response_content` string for a `<task_complete>true</task_complete>` tag pair. It returns `True` only when that tag contains `true`, ignoring case and surrounding whitespace. For every other form of the section, including missing tags or non-`true` content, it returns `False`. It does not read or write any `self` state.

**Interface · params / IO**

`(self, response_content: str) -> bool`

- params: `self`: `?` — parser instance; unused in this body; `response_content`: `str` — raw XML-like response text to inspect for task completion
- returns: A boolean completion flag: `True` only for a matching `<task_complete>true</task_complete>` marker, otherwise `False`.

**Execution flow**

1. Search `response_content` with `re.search(...)` for the exact tag pattern `r"<task_complete>\s*true\s*</task_complete>"`, using `re.IGNORECASE` so `true` may vary in case and may be surrounded by whitespace.
2. If that search returns `true_match`, return `True` immediately.
3. If no such match exists, fall through to the default `False` return for all other cases.

**Source**

```python
    def _check_task_complete(self, response_content: str) -> bool:
        """Check if the response indicates the task is complete."""
        # Check for <task_complete>true</task_complete>
        true_match = re.search(
            r"<task_complete>\s*true\s*</task_complete>",
            response_content,
            re.IGNORECASE,
        )
        if true_match:
            return True

        # All other cases (false, empty, self-closing, missing) = not complete
        return False
```

**Non-obvious design decisions**

- The function accepts only the explicit positive form `<task_complete>true</task_complete>`. That keeps completion detection conservative: malformed, empty, self-closing, `false`, or absent tags all map to the same non-complete result instead of trying to classify several negative or invalid variants.
- It uses a direct regex on `response_content` instead of reusing section extraction state. That keeps this check independent and cheap inside `_try_parse_response`, at the cost of not distinguishing parse errors from an ordinary `False` completion flag.

**Relations**

- **Callers**: `TerminusXMLPlainParser._try_parse_response` while building `ParseResult.is_task_complete`; `TerminusXMLPlainParser.parse_response` indirectly through `_try_parse_response`
- **Core callees**: `re.search`
- **Config / state sources**: `response_content` argument; hard-coded regex `r"<task_complete>\s*true\s*</task_complete>"`; hard-coded flag `re.IGNORECASE`
- **Results to**: `ParseResult.is_task_complete` produced by `TerminusXMLPlainParser._try_parse_response`; stage-4.4 parse output consumed by later completion-handling stages
- **Related siblings**: `TerminusXMLPlainParser._try_parse_response`; `TerminusXMLPlainParser._extract_sections`; `TerminusXMLPlainParser._check_extra_text`; `TerminusXMLPlainParser._check_section_order`

</details>


<details id="fn-terminusxmlplainparser_parse_xml_commands">
<summary><b>TerminusXMLPlainParser._parse_xml_commands</b> — terminus_xml_plain_parser.py:320-391 · Parse XML keystroke command blocks</summary>

> **Stage context**: This helper handles the `<commands>` payload inside the XML parser's response path. `TerminusXMLPlainParser._try_parse_response` calls it after `_extract_sections` has isolated the `commands` section, and its output becomes the `commands` field of the stage's `ParseResult`. Unlike `_extract_sections`, which finds high-level sections, this function focuses only on repeated `<keystrokes ...>...</keystrokes>` command entries and adds command-specific warnings.

**What this code does**

`_parse_xml_commands` scans `xml_content` for `<keystrokes>` elements, converts each match into a `ParsedCommand`, and returns `(commands, "")`. It reads each tag's `duration` attribute, falls back to `1.0` when the attribute is missing or not numeric, and appends human-readable warnings into the caller-supplied `warnings` list. It also warns about missing trailing newlines between adjacent commands, literal XML entities found in `xml_content`, and literal `"\\r\\n"` sequences.

**Interface · params / IO**

`(self, xml_content: str, warnings: List[str]) -> tuple[List[ParsedCommand], str]`

- params: `self`: `?` — XML parser instance used only to call `_check_attribute_issues`; `xml_content`: `str` — raw XML-like command section content to scan for `<keystrokes>` blocks; `warnings`: `List[str]` — mutable warning sink that collects non-fatal parse diagnostics
- returns: A tuple `(commands, "")`, where `commands` is a list of `ParsedCommand(keystrokes, duration)` built from matched `<keystrokes>` elements and the error string is always empty.
- effects: Appends warning strings to the provided `warnings` list; Calls `self._check_attribute_issues(attributes_str, i + 1, warnings)` for each matched command tag

**Execution flow**

1. Compile `keystrokes_pattern = re.compile(r"<keystrokes([^>]*)>(.*?)</keystrokes>", re.DOTALL)` and use `findall(xml_content)` to collect every matched command body plus its raw attribute text.
2. For each `(attributes_str, keystrokes_content)` match, call `self._check_attribute_issues(attributes_str, i + 1, warnings)` before parsing any known attributes.
3. Initialize `duration = 1.0`, then search `attributes_str` for `duration\s*=\s*["\']([^"\']*)["\']`; if present, convert the captured value with `float(...)`, and if that conversion raises `ValueError`, keep `1.0` and append an invalid-duration warning.
4. If the `duration` attribute is absent, append a missing-duration warning and keep the default `1.0`.
5. For every command except the last one, check `keystrokes_content.endswith("\n")`; when it does not, append a warning that the next command will concatenate onto the same line.
6. Append `ParsedCommand(keystrokes=keystrokes_content, duration=duration)` to `commands` for each match.
7. After command extraction, scan the full `xml_content` for each literal entity key in `entities = {"&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'"}` and append a warning for every entity found.
8. Check whether the literal substring `"\\r\\n"` appears in `xml_content`; if it does, append a line-ending warning, then return `commands, ""`.

**Source**

```python
    def _parse_xml_commands(
        self, xml_content: str, warnings: List[str]
    ) -> tuple[List[ParsedCommand], str]:
        """Parse XML content and extract command objects manually."""

        # Find all keystrokes elements manually for better error reporting
        commands = []
        keystrokes_pattern = re.compile(
            r"<keystrokes([^>]*)>(.*?)</keystrokes>", re.DOTALL
        )

        matches = keystrokes_pattern.findall(xml_content)
        for i, (attributes_str, keystrokes_content) in enumerate(matches):
            # Check for attribute issues
            self._check_attribute_issues(attributes_str, i + 1, warnings)

            # Parse attributes
            duration = 1.0

            # Parse duration attribute
            duration_match = re.search(
                r'duration\s*=\s*["\']([^"\']*)["\']', attributes_str
            )
            if duration_match:
                try:
                    duration = float(duration_match.group(1))
                except ValueError:
                    warnings.append(
                        f"Command {i + 1}: Invalid duration value "
                        f"'{duration_match.group(1)}', using default 1.0"
                    )
            else:
                warnings.append(
                    f"Command {i + 1}: Missing duration attribute, using default 1.0"
                )

            # Check for newline at end of keystrokes
            if i < len(matches) - 1 and not keystrokes_content.endswith("\n"):
                warnings.append(
                    f"Command {i + 1} should end with newline when followed "
                    f"by another command. Otherwise the two commands will be "
                    f"concatenated together on the same line."
                )

            commands.append(
                ParsedCommand(keystrokes=keystrokes_content, duration=duration)
            )

        # Check for XML entities and warn
        entities = {
            "&lt;": "<",
            "&gt;": ">",
            "&amp;": "&",
            "&quot;": '"',
            "&apos;": "'",
        }
        for entity, char in entities.items():
            if entity in xml_content:
                warnings.append(
                    f"Warning: {entity} is read verbatim and not converted to {char}. "
                    f"NEVER USE {entity}, unless you want these exact characters to "
                    f"appear directly in the output."
                )

        # Check for \r\n line endings and warn
        if "\\r\\n" in xml_content:
            warnings.append(
                "Warning: \\r\\n line endings are not necessary - use \\n "
                "instead for simpler output"
            )

        return commands, ""
```

**Non-obvious design decisions**

- It uses a targeted regex over `<keystrokes>` tags instead of a full XML parser so it can keep parsing simple command blocks while issuing command-numbered diagnostics tied to `attributes_str`, `keystrokes_content`, and adjacency checks. A stricter XML parser would validate structure differently, but it would make these focused warnings harder to phrase in terms of the original command text.
- It treats missing or bad `duration` as a warning, not a hard error, by initializing `duration = 1.0` and preserving that value through the `except ValueError` branch. That choice keeps usable commands flowing downstream even when metadata is malformed.
- It checks newline termination only when `i < len(matches) - 1`, so the warning targets the specific case that changes terminal behavior: one command's text running directly into the next command. It does not require a trailing newline on the last command because there is no following command to concatenate with.
- It warns that entity strings like `&lt;` and `&amp;` are read literally instead of decoding them. This matches the function's plain-text extraction model: `keystrokes_content` goes straight into `ParsedCommand` without any entity unescaping, so warning early is safer than silently changing user-visible output.

**Relations**

- **Callers**: `TerminusXMLPlainParser._try_parse_response`
- **Core callees**: `self._check_attribute_issues`; `re.compile`; `re.search`; `ParsedCommand`
- **Config / state sources**: No `self._...` configuration or register-backed state is read; Behavior is driven entirely by `xml_content`, `warnings`, and hard-coded patterns such as `keystrokes_pattern` and `entities`
- **Results to**: Returns `commands` to `TerminusXMLPlainParser._try_parse_response` for inclusion in `ParseResult.commands`; Appended `warnings` continue upward through `TerminusXMLPlainParser._try_parse_response` into `ParseResult.warning`; Successful `ParsedCommand.duration` values later feed stage-4.4 command wrapping into `Command(..., duration_sec=min(duration, 60))`
- **Related siblings**: `TerminusXMLPlainParser._try_parse_response` delegates command-section parsing here after `_extract_sections`; `TerminusXMLPlainParser._extract_sections` finds the `<commands>` block that becomes this function's `xml_content` input; `TerminusJSONPlainParser._parse_commands` is the JSON-side analogue: both build parsed command lists and report non-fatal issues through warnings

</details>


<details id="fn-terminusxmlplainparser_check_attribute_issues">
<summary><b>TerminusXMLPlainParser._check_attribute_issues</b> — terminus_xml_plain_parser.py:482-512 · XML attribute warning checker</summary>

> **Stage context**: This helper validates an XML attribute substring by adding human-readable warnings to a caller-supplied list. In the Response Parse stage, it serves as a narrow diagnostic step alongside other XML parser helpers such as `_check_extra_text` and `_extract_sections`, but this function itself only inspects `attributes_str` and does not parse whole responses.

**What this code does**

`_check_attribute_issues` inspects `attributes_str` for three advisory problems: unquoted attribute values, single-quoted values, and attribute names outside a hard-coded allowed set. It uses `command_num` only to label each warning message and appends all findings into the mutable `warnings` list. It returns `None` and does not read or write any instance state. The three checks run independently, so one attribute text can produce multiple warnings and the function does not deduplicate them.

**Interface · params / IO**

`(self, attributes_str: str, command_num: int, warnings: List[str]) -> None`

- params: `self`: `?` — instance reference; unused by this body; `attributes_str`: `str` — raw attribute text to inspect; `command_num`: `int` — command identifier interpolated into warning text; `warnings`: `List[str]` — mutable sink for diagnostic messages
- returns: None; the real output is any warning strings appended to `warnings`
- effects: appends warning strings to the caller-provided `warnings` list

**Execution flow**

1. Compile `unquoted_pattern = re.compile(r'(\w+)\s*=\s*([^"\'\s>]+)')`, find all matches in `attributes_str`, and append one warning per `(attr_name, attr_value)` saying the value should be written as `name="value"`.
2. Compile `single_quote_pattern = re.compile(r"(\w+)\s*=\s*'([^']*)'")`, find all matches in `attributes_str`, and append one warning per match telling the caller to use double quotes for that attribute.
3. Set `known_attributes = {"duration"}`, collect every attribute name matched by `re.findall(r"(\w+)\s*=", attributes_str)`, and append an unknown-attribute warning for each name not in that set.
4. Return `None` without short-circuiting or deduplicating, so warnings from earlier passes remain and later passes can add more messages for the same source text.

**Source**

```python
    def _check_attribute_issues(
        self, attributes_str: str, command_num: int, warnings: List[str]
    ) -> None:
        """Check for attribute-related issues."""
        # Check for missing quotes
        unquoted_pattern = re.compile(r'(\w+)\s*=\s*([^"\'\s>]+)')
        unquoted_matches = unquoted_pattern.findall(attributes_str)
        for attr_name, attr_value in unquoted_matches:
            warnings.append(
                f"Command {command_num}: Attribute '{attr_name}' value should be "
                f'quoted: {attr_name}="{attr_value}"'
            )

        # Check for single quotes (should use double quotes for consistency)
        single_quote_pattern = re.compile(r"(\w+)\s*=\s*'([^']*)'")
        single_quote_matches = single_quote_pattern.findall(attributes_str)
        for attr_name, attr_value in single_quote_matches:
            warnings.append(
                f"Command {command_num}: Use double quotes for attribute "
                f"'{attr_name}': {attr_name}=\"{attr_value}\""
            )

        # Check for unknown attribute names
        known_attributes = {"duration"}
        all_attributes = re.findall(r"(\w+)\s*=", attributes_str)
        for attr_name in all_attributes:
            if attr_name not in known_attributes:
                warnings.append(
                    f"Command {command_num}: Unknown attribute '{attr_name}' - "
                    f"known attributes are: {', '.join(sorted(known_attributes))}"
                )
```

**Non-obvious design decisions**

- The function reports problems through `warnings.append(...)` instead of raising or returning a status object. That keeps attribute issues advisory in this helper and lets the caller accumulate multiple diagnostics from one input string.
- It hard-codes `known_attributes = {"duration"}` inside the function. That makes the accepted attribute set explicit at the point of validation, but any new supported XML attributes would require changing this function.
- It uses regex heuristics (`unquoted_pattern`, `single_quote_pattern`, and `re.findall(r"(\w+)\s*=", ...)`) rather than a stricter XML attribute parser. The result is lightweight validation focused on specific formatting and naming issues, not full XML conformance.
- The three passes are intentionally independent. Because the unknown-name scan runs over all `name=` occurrences and there is no deduplication, a single attribute can trigger both a quoting/style warning and an unknown-attribute warning.

**Relations**

- **Callers**: caller that extracts an XML attribute substring and wants advisory diagnostics; XML command parsing path in `TerminusXMLPlainParser`
- **Core callees**: `re.compile`; `Pattern.findall`; `re.findall`; `warnings.append`; `sorted`; `str.join`
- **Config / state sources**: `attributes_str` input text; `command_num` warning label input; `warnings` mutable output list; local `known_attributes` constant
- **Results to**: caller-owned `warnings` list; human-readable warning strings labeled with `command_num`; downstream parser diagnostics that consume the accumulated `warnings` list
- **Related siblings**: `TerminusXMLPlainParser._parse_xml_commands`; `TerminusXMLPlainParser._check_extra_text`; `TerminusXMLPlainParser._extract_sections`

</details>
