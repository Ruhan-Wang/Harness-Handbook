### 4.9 · Parser internal helpers

#### (a) Opening Explanation

This stage exists to rescue and normalize a model reply when the parser can see the intended shape but the text is slightly broken. The problem it solves is simple: large language models often produce almost-correct XML or JSON, and throwing that away would make the agent brittle for no good reason. So this stage owns the parser’s **internal repair and extraction work** after the loop has decided parsing should happen, but before the parse result is handed back as a clean boundary object. It sits inside the parser subsystem, between “we have raw model output” and “we have a usable parsed response or a real failure.” Without it, small formatting mistakes would turn into unnecessary retries, warnings would be lost, and truncated answers would fail more often than they need to.

#### (b) Main Flow

1. **Before any run, the parser object is configured.**  
   `TerminusXMLPlainParser.__init__()` and `TerminusJSONPlainParser.__init__()` set up parser-specific behavior. This is not the interesting runtime step. It just decides what kind of repair tools are available later: XML-oriented fixes for tag problems, or JSON-oriented fixes for incomplete structures.

2. **At runtime, this stage is entered only after the parser has been given raw model text and a normal parse is attempted or considered.**  
   The key decision point is: **which parser mode are we in?** XML and JSON fail in different ways, so the recovery path branches early.

3. **If the reply is XML-like, the parser first tries narrow repairs instead of aggressive salvage.**  
   The XML branch looks for top-level tags with `_find_top_level_tags()` (find the main XML blocks the model likely meant to send). This exists so the parser can tell the difference between “totally invalid output” and “mostly valid structure with one missing wrapper or cut-off section.”

4. **If the XML is malformed but still recognizable, bounded fixes are tried first.**  
   `_get_auto_fixes()` (choose small safe repairs) collects candidate fixes, and `_fix_missing_response_tag()` (wrap content in the expected outer tag if the model forgot it) handles one common failure mode. The branch order matters: the parser tries **small, targeted fixes first** because they are safer than broad salvage. If a tiny fix recovers the intended structure, the system keeps more signal and makes fewer risky guesses.

5. **If the XML reply looks truncated, a stronger salvage path is used.**  
   `salvage_truncated_response()` is the “best effort” branch for cut-off XML. This is here because model output often stops mid-stream due to token limits or interruption. Instead of discarding the whole reply, the parser tries to recover the valid response content that is already present. That gives the agent a chance to use partial but trustworthy output.

6. **If the reply is JSON-like, the parser uses the JSON repair path instead.**  
   `_get_auto_fixes()` on the JSON parser gathers small repair options, and `_fix_incomplete_json()` (close or complete a cut-off JSON structure when the intent is obvious) handles the common “almost valid JSON” case. Same idea as XML: fix obvious structural damage before declaring failure.

7. **Once structure is good enough, the parser extracts the actual payload the rest of the agent cares about.**  
   `_extract_response_content()` (pull out the real response body from the repaired XML structure) turns parser-facing structure into agent-facing content. This stage exists because the model’s wrapper format is not the thing downstream code wants; downstream wants the normalized response inside it.

8. **Warnings from every repair step are merged, not lost.**  
   `_combine_warnings()` on XML or JSON collects repair notes into one warning set. This matters because the system should know whether the parse was clean or recovered. A repaired parse is usable, but it is not the same as a pristine parse.

9. **The stage then emits one of two outcomes back to the public parser boundary.**  
   Either it returns a normalized parsed payload plus any warnings, or it gives up and lets the public parser layer treat the output as a real parse failure. That boundary logic stays outside this stage; this stage’s job is to improve the odds that parsing succeeds safely.

#### (c) 📊 State Flow

**📊 State Flow**

- writes: none explicitly in this stage’s own skeleton register list — this unit is helper-only and does not directly own a named loop register
- reads: none explicitly in this stage’s own skeleton register list — it works on parser-local artifacts passed in from the parent parser stage, chiefly raw model text and parser-local warning/result objects
- clears: none explicitly in this stage’s own skeleton register list
- triggers downstream: `stage-5 Run Teardown` — not directly; this helper stage returns repaired-or-failed parse artifacts to its parent parser boundary in stage-4.4, and only the broader loop later reaches teardown

#### (d) Pipeline Hand-Off

Upstream, the parent parser stage receives raw model output from the loop after completion gating says the turn is ready to parse. This helper unit turns that raw text into a **cleaner parser-local artifact**: repaired XML/JSON content, extracted response payload, and merged warnings; the public parser boundary then interprets that result and passes a usable parse result back into the loop, which eventually proceeds to later stages such as teardown.

<details id="fn-terminusxmlplainparser_init">
<summary><b>TerminusXMLPlainParser.__init__</b> — terminus_xml_plain_parser.py:25-26 · Parser instance section-list initializer</summary>

> **Stage context**: This entry is an internal parser helper constructor. In this unit, its entire role is to initialize one parser-local instance attribute, `self.required_sections`, with a fixed list literal.

**What this code does**

`TerminusXMLPlainParser.__init__` takes only `self` and initializes parser instance state. It writes `self.required_sections` to `['analysis', 'plan', 'commands']` and returns `None`. The function does not read any existing instance state and does not call other code.

**Interface · params / IO**

`(self)`

- params: `self`: `?` — parser instance being initialized
- returns: None; the effect is writing `self.required_sections = ['analysis', 'plan', 'commands']`
- effects: writes `self.required_sections = ['analysis', 'plan', 'commands']`

**Execution flow**

1. Receive the new instance as `self`.
2. Assign the list literal `['analysis', 'plan', 'commands']` to `self.required_sections`.

**Source**

```python
    def __init__(self):
        self.required_sections = ["analysis", "plan", "commands"]
```

**Non-obvious design decisions**



**Relations**

- **Callers**: instance construction for `TerminusXMLPlainParser`
- **Core callees**: none
- **Config / state sources**: hard-coded list literal `['analysis', 'plan', 'commands']` in `__init__`
- **Results to**: `self.required_sections` on the constructed parser instance

</details>


<details id="fn-terminusxmlplainparser_get_auto_fixes">
<summary><b>TerminusXMLPlainParser._get_auto_fixes</b> — terminus_xml_plain_parser.py:171-178 · Enumerates parser auto-fix candidates</summary>

> **Stage context**: This helper sits in the parser-internal stage as a small policy function. It packages the parser's available automatic fixers into a returned value instead of storing them elsewhere. Compared with sibling `TerminusXMLPlainParser.__init__`, which initializes parser state, this method reads one existing bound method and returns configuration-like data without mutating state.

**What this code does**

`TerminusXMLPlainParser._get_auto_fixes` returns the parser's current automatic-fix list as a literal one-element list. It takes only `self`, reads `self._fix_missing_response_tag`, and returns `[('Missing </response> tag was automatically inserted', self._fix_missing_response_tag)]`. It does not write any instance state or trigger any external effect.

**Interface · params / IO**

`(self)`

- params: `self`: `?` — parser instance that supplies the bound fixer method `self._fix_missing_response_tag`
- reads: `self._fix_missing_response_tag`
- returns: the exact one-element list `[("Missing </response> tag was automatically inserted", self._fix_missing_response_tag)]`, where the tuple contains a human-readable message string and a bound fixer method

**Execution flow**

1. Build a literal list with exactly one tuple entry.
2. Populate that tuple with the exact message string `'Missing </response> tag was automatically inserted'` and the bound method `self._fix_missing_response_tag`, then return the list directly.

**Source**

```python
    def _get_auto_fixes(self):
        """Return list of auto-fix functions to try in order."""
        return [
            (
                "Missing </response> tag was automatically inserted",
                self._fix_missing_response_tag,
            ),
        ]
```

**Non-obvious design decisions**

- The function returns an ordered list even though it currently contains only one entry. That keeps the auto-fix set expressible as a sequence rather than a single special-case value.
- Each entry is a `(message, fixer)` pair, not just a callable. The returned data carries both the bound method `self._fix_missing_response_tag` and the exact descriptive string attached to that fix.
- The fixer is returned as a bound method on `self`. That means the caller receives a callable that already closes over the instance, with no extra instance argument needed.
- The method does not cache or store the list on the instance. It recreates and returns the literal structure each time, which keeps this helper read-only.

**Relations**

- **Callers**: unknown caller inside `TerminusXMLPlainParser` or nearby parser code
- **Core callees**: `self._fix_missing_response_tag` (returned as a bound method reference, not invoked here)
- **Config / state sources**: `self._fix_missing_response_tag`
- **Results to**: the immediate caller that consumes the returned list of `(message, fixer)` tuples
- **Related siblings**: `TerminusXMLPlainParser.__init__` initializes parser instance state; `_get_auto_fixes` instead exposes a read-only fixer list

</details>


<details id="fn-terminusxmlplainparser_fix_missing_response_tag">
<summary><b>TerminusXMLPlainParser._fix_missing_response_tag</b> — terminus_xml_plain_parser.py:187-194 · Targeted XML closing-tag auto-fix helper</summary>

> **Stage context**: This stage holds parser implementation helpers. Within that role, `TerminusXMLPlainParser._fix_missing_response_tag` is a narrow repair routine that works only from its `response` and `error` inputs and returns a corrected string plus a success flag. It sits alongside other parser internals such as `TerminusXMLPlainParser.__init__` and the auto-fix list builder `TerminusXMLPlainParser._get_auto_fixes`.

**What this code does**

`TerminusXMLPlainParser._fix_missing_response_tag` checks whether `error` contains the specific diagnostic substring `"Missing </response> closing tag"`. If not, it returns the original `response` and `False`. If the substring is present, it returns exactly `response.rstrip() + "\n</response>"` and `True`. The function reads no instance state and causes no side effects.

**Interface · params / IO**

`(self, response: str, error: str) -> tuple[str, bool]`

- params: `self`: `?` — parser instance; unused by this helper; `response`: `str` — raw response text to leave unchanged or repair; `error`: `str` — diagnostic text inspected for the missing-tag substring
- returns: A `(text, did_fix)` tuple. It returns `(response, False)` when `"Missing </response> closing tag" not in error`; otherwise it returns `(response.rstrip() + "\n</response>", True)`.

**Execution flow**

1. Check `error` with the containment test `"Missing </response> closing tag" not in error`.
2. If that test is true, stop immediately and return the original `response` with `False`.
3. Otherwise, build `corrected` as exactly `response.rstrip() + "\n</response>"`.
4. Return `corrected` with `True` to report that this helper changed the text.

**Source**

```python
    def _fix_missing_response_tag(self, response: str, error: str) -> tuple[str, bool]:
        """Fix missing </response> closing tag by appending it."""
        if "Missing </response> closing tag" not in error:
            return response, False

        # Simply append </response> at the end
        corrected = response.rstrip() + "\n</response>"
        return corrected, True
```

**Non-obvious design decisions**

- It gates the fix on a specific diagnostic substring in `error` instead of changing every malformed `response`. That choice limits this helper to one known failure mode; a broader fixer would risk altering unrelated XML problems.
- It uses `response.rstrip()` before adding `"\n</response>"`. That normalizes trailing whitespace so the inserted closing tag lands cleanly at the end instead of after arbitrary spaces or blank lines.
- It reports the outcome as a boolean in the returned tuple rather than writing instance state. That keeps the helper stateless and makes the caller distinguish between pass-through and repaired output without consulting `self`.

**Relations**

- **Callers**: Unknown from this snippet; some parser-internal code must supply `response` and `error` and consume the returned tuple
- **Core callees**: `str.rstrip` on `response`
- **Config / state sources**: `response` argument; `error` argument
- **Results to**: The immediate caller that receives the `(text, did_fix)` tuple; Parser-local control flow that can branch on the returned `bool`; Subsequent XML handling that may use the returned text; `TerminusXMLPlainParser._get_auto_fixes`, as a sibling that exposes this bound method in a returned list
- **Related siblings**: `TerminusXMLPlainParser.__init__` initializes parser helper state; `TerminusXMLPlainParser._get_auto_fixes` returns a list containing this helper

</details>


<details id="fn-terminusxmlplainparser_combine_warnings">
<summary><b>TerminusXMLPlainParser._combine_warnings</b> — terminus_xml_plain_parser.py:180-185 · warning string combiner helper</summary>

> **Stage context**: This helper sits in the parser's internal-helper stage as a small string-formatting routine. Within that role, it contributes one combined warning text from two inputs and keeps all work local to the return value. The snippet shows no interaction with parser instance state or other helpers.

**What this code does**

`TerminusXMLPlainParser._combine_warnings` builds one warning string from `auto_warning` and `existing_warning`. It always formats `auto_warning` as a leading `- ` bullet, then uses the truthiness of `existing_warning` to decide whether to append a newline plus that existing text. It returns the combined string and does not mutate `self` or any external state.

**Interface · params / IO**

`(self, auto_warning: str, existing_warning: str) -> str`

- params: `self`: `?` — parser instance; present but not read; `auto_warning`: `str` — new warning text to prefix with `- `; `existing_warning`: `str` — prior warning text whose truthiness controls whether `\n{existing_warning}` is appended
- returns: A `str`: either `f"- {auto_warning}\n{existing_warning}"` when `existing_warning` is truthy, or `f"- {auto_warning}"` when `existing_warning` is falsey.

**Execution flow**

1. Start from a shared output shape: both branches place `auto_warning` first and prefix it with `- `.
2. Check the truthiness of `existing_warning` with `if existing_warning:`.
3. If `existing_warning` is truthy, return `f"- {auto_warning}\n{existing_warning}"`, so the existing text appears on the next line.
4. If `existing_warning` is falsey, return `f"- {auto_warning}"` with no trailing newline and no appended text.

**Source**

```python
    def _combine_warnings(self, auto_warning: str, existing_warning: str) -> str:
        """Combine auto-correction warning with existing warnings."""
        if existing_warning:
            return f"- {auto_warning}\n{existing_warning}"
        else:
            return f"- {auto_warning}"
```

**Non-obvious design decisions**

- The function prepends `auto_warning` rather than appending it, because both return formats place `- {auto_warning}` before any `existing_warning` text.
- It uses a truthiness test on `existing_warning`, not a more specific content check. Any falsey value that reaches this parameter takes the `else` branch.
- It emits the newline only in the truthy branch, which avoids adding a blank separator when no existing text is included.

**Relations**

- **Callers**: Not shown in this snippet
- **Core callees**: none
- **Config / state sources**: `auto_warning` argument; `existing_warning` argument
- **Results to**: returned directly to this function's caller as combined warning text

</details>


<details id="fn-terminusxmlplainparser_extract_response_content">
<summary><b>TerminusXMLPlainParser._extract_response_content</b> — terminus_xml_plain_parser.py:225-236 · Extract `<response>` body from parser input</summary>

> **Stage context**: This helper lives inside the parser's internal response-processing path. `TerminusXMLPlainParser._try_parse_response` invokes it after control has already entered parser-specific handling, and it supplies the raw inner payload that later parsing steps interpret. Among this stage's siblings, it pairs with `_fix_missing_response_tag` by tolerating malformed wrappers, but it only extracts text and does not attempt any repair itself.

**What this code does**

`TerminusXMLPlainParser._extract_response_content` pulls out the text enclosed by a `<response>...</response>` wrapper from the `response` argument. It returns `""` when `response.find("<response>")` cannot locate an opening tag. If the closing `</response>` tag is missing, it returns the substring from the opening tag to the end of `response`, with surrounding whitespace stripped. The function reads no instance state and has no side effects.

**Interface · params / IO**

`(self, response: str) -> str`

- params: `self`: `?` — parser instance; unused by this helper; `response`: `str` — full model reply string that may contain a `<response>` wrapper
- returns: A stripped inner-content string extracted from `response`; returns `""` if no `<response>` opening tag exists.

**Execution flow**

1. Search `response` for the first `"<response>"` with `response.find(...)` and return `""` immediately if that marker is absent.
2. Search for `"</response>"` starting at `start_pos`; if that closing marker is absent, slice from just after the opening tag to the end of `response` and return `.strip()` of that slice.
3. If both markers exist, slice between the end of `"<response>"` and `end_pos`, then return the stripped substring.

**Source**

```python
    def _extract_response_content(self, response: str) -> str:
        """Extract content from <response> tags."""
        start_pos = response.find("<response>")
        if start_pos == -1:
            return ""

        end_pos = response.find("</response>", start_pos)
        if end_pos == -1:
            # Missing closing tag - return content from opening tag to end
            return response[start_pos + len("<response>") :].strip()

        return response[start_pos + len("<response>") : end_pos].strip()
```

**Non-obvious design decisions**

- It accepts a missing closing tag by using the `end_pos == -1` branch to return content through the end of `response`. That keeps parsing usable on partially malformed LLM output; a stricter alternative would reject the whole reply.
- It strips whitespace in both success paths with `.strip()`. This normalizes incidental formatting around the wrapped body so downstream parsing sees the payload rather than wrapper-adjacent indentation or blank lines.
- It uses plain substring search for exact `"<response>"` and `"</response>"` markers instead of an XML parser. For this narrow wrapper-extraction job, that avoids parser overhead and stays aligned with the parser's tolerance for malformed output.

**Relations**

- **Callers**: `TerminusXMLPlainParser._try_parse_response`
- **Core callees**: `str.find` on `response` for `"<response>"` and `"</response>"`; `str.strip` on the extracted slice
- **Config / state sources**: `response` argument supplied by parser response-handling code
- **Results to**: Returned inner text goes back to `TerminusXMLPlainParser._try_parse_response` for further interpretation; Its malformed-wrapper tolerance complements `_fix_missing_response_tag`, which can repair a missing closing tag in a separate helper
- **Related siblings**: `TerminusXMLPlainParser._fix_missing_response_tag` handles one specific malformed-tag repair instead of extraction; `TerminusXMLPlainParser._combine_warnings` formats warning text after parser auto-fixes, not content extraction

</details>


<details id="fn-terminusxmlplainparser_find_top_level_tags">
<summary><b>TerminusXMLPlainParser._find_top_level_tags</b> — terminus_xml_plain_parser.py:393-440 · Top-level XML child tag scanner</summary>

> **Stage context**: This helper belongs to the parser's internal extraction layer. `_extract_sections` uses it after `_extract_response_content` has isolated the body text, so the parser can identify which section tags appear as direct children of the response wrapper. It complements the sibling helpers that fix wrapper issues and slice out response content by handling the next parsing task: lightweight tag discovery without full XML parsing.

**What this code does**

`TerminusXMLPlainParser._find_top_level_tags` scans the `content` string and collects tag names that appear when the manual nesting counter `depth` is zero. It returns a `List[str]` of direct-child tag names in encounter order, including self-closing tags, while ignoring tags whose raw `tag_content` starts with `!` or `?`. The function reads no instance state, writes no parser state, and has no external side effects.

**Interface · params / IO**

`(self, content: str) -> List[str]`

- params: `self`: `?` — parser instance; unused by this helper; `content`: `str` — XML-like response body text to inspect for direct-child tags
- returns: a `List[str]` of tag names appended from opening or self-closing tags seen at `depth == 0`

**Execution flow**

1. Initialize `top_level_tags`, `depth`, and scan index `i`, then walk through `content` until `i` reaches `len(content)`.
2. When the scan sees `"<"`, find the matching `">"` with `content.find(">", i)`; if no closing bracket exists (`tag_end == -1`), stop scanning and return whatever `top_level_tags` already holds.
3. Slice the raw tag text into `tag_content = content[i + 1 : tag_end]` and skip processing entirely when `tag_content.startswith("!")` or `tag_content.startswith("?")` marks a declaration-, comment-, or processing-instruction-style tag.
4. If `tag_content.startswith("/")`, treat it as a closing tag, decrement `depth`, advance `i` past `tag_end`, and continue without recording a name.
5. Otherwise, detect `is_self_closing` from `tag_content.endswith("/")`, derive `tag_name` from the first whitespace-delimited token, and strip a trailing `/` from that extracted name when present.
6. Append `tag_name` to `top_level_tags` only when the current nesting level is `depth == 0`, then increment `depth` for non-self-closing opening tags and continue scanning after the current tag.

**Source**

```python
    def _find_top_level_tags(self, content: str) -> List[str]:
        """Find all top-level XML tags (direct children of response), not
        nested tags."""
        top_level_tags = []
        depth = 0
        i = 0

        while i < len(content):
            if content[i] == "<":
                # Find the end of this tag
                tag_end = content.find(">", i)
                if tag_end == -1:
                    break

                tag_content = content[i + 1 : tag_end]

                # Skip comments, CDATA, etc.
                if tag_content.startswith("!") or tag_content.startswith("?"):
                    i = tag_end + 1
                    continue

                # Check if this is a closing tag
                if tag_content.startswith("/"):
                    depth -= 1
                    i = tag_end + 1
                    continue

                # Check if this is a self-closing tag
                is_self_closing = tag_content.endswith("/")

                # Extract tag name (first word)
                tag_name = tag_content.split()[0] if " " in tag_content else tag_content
                if tag_name.endswith("/"):
                    tag_name = tag_name[:-1]

                # If we're at depth 0, this is a top-level tag
                if depth == 0:
                    top_level_tags.append(tag_name)

                # Adjust depth for opening tags (but not self-closing)
                if not is_self_closing:
                    depth += 1

                i = tag_end + 1
            else:
                i += 1

        return top_level_tags
```

**Non-obvious design decisions**

- It uses a manual `depth` counter instead of an XML parser so `_extract_sections` can cheaply identify direct-child section tags from loosely XML-shaped model output. A strict parser would reject malformed fragments that this helper still partially interprets.
- It skips tags whose `tag_content` starts with `!` or `?` so comment-, declaration-, and processing-instruction-like constructs do not alter `depth` or appear in results. Treating those forms as normal tags would create false section names and corrupt nesting.
- It stops quietly when `content.find(">", i)` returns `-1` rather than raising an error. That choice lets the parser salvage tags found before a truncated tail, which matches the lightweight, fault-tolerant role of this helper.
- It extracts `tag_name` from only the first token in `tag_content`, with a follow-up trim for a trailing `/`, so attributes do not pollute the returned names and self-closing forms like `<plan/>` and `<plan />` normalize to `plan`.

**Relations**

- **Callers**: `TerminusXMLPlainParser._extract_sections`
- **Core callees**: `content.find`; `tag_content.startswith`; `tag_content.endswith`; `tag_content.split`; `top_level_tags.append`
- **Config / state sources**: none; the function does not read `self` state or stage registers
- **Results to**: `TerminusXMLPlainParser._extract_sections` uses the returned tag list to decide which response sections are present; parser-side section extraction after `_extract_response_content` has isolated response-body text
- **Related siblings**: `TerminusXMLPlainParser._extract_response_content` supplies the response-body text this helper scans; `TerminusXMLPlainParser._fix_missing_response_tag` and `_get_auto_fixes` handle wrapper repair before parsing reaches section discovery

</details>


<details id="fn-terminusjsonplainparser_init">
<summary><b>TerminusJSONPlainParser.__init__</b> — terminus_json_plain_parser.py:26-27 · JSON/plain parser required-fields initializer</summary>

> **Stage context**: This entry is a parser-internal helper method on the JSON/plain parser class. Within this stage, it is the instance-setup counterpart to other parser helpers: it establishes parser-local state and does not parse input, call other helpers, or touch shared runtime registers.

**What this code does**

`TerminusJSONPlainParser.__init__` takes only `self` and initializes one instance attribute. It assigns `self.required_fields = ['analysis', 'plan', 'commands']` and returns `None`. The function does not read any existing state, does not call other code, and has no external side effects beyond that instance-state write.

**Interface · params / IO**

`(self)`

- params: `self`: `?` — parser instance being initialized
- returns: returns `None`; the real product is the instance-state write `self.required_fields = ['analysis', 'plan', 'commands']`
- effects: writes `self.required_fields = ['analysis', 'plan', 'commands']`

**Execution flow**

1. Receive the parser instance as `self`.
2. Assign the literal list `['analysis', 'plan', 'commands']` to `self.required_fields`.

**Source**

```python
    def __init__(self):
        self.required_fields = ["analysis", "plan", "commands"]
```

**Non-obvious design decisions**

- The function hard-codes the field names as the literal list `['analysis', 'plan', 'commands']` instead of computing them or reading them from another source.
- It stores those names on the instance in `self.required_fields`, which makes the initializer's only effect explicit and local to parser object state.

**Relations**

- **Callers**: class instantiation of `TerminusJSONPlainParser`
- **Core callees**: none
- **Config / state sources**: literal list `['analysis', 'plan', 'commands']` in the function body
- **Results to**: `self.required_fields` on the parser instance
- **Related siblings**: `TerminusXMLPlainParser.__init__` performs the analogous initializer write for XML/plain parsing, using `self.required_sections`.

</details>


<details id="fn-terminusjsonplainparser_get_auto_fixes">
<summary><b>TerminusJSONPlainParser._get_auto_fixes</b> — terminus_json_plain_parser.py:305-313 · ordered JSON auto-fix table builder</summary>

> **Stage context**: This helper belongs to the parser subsystem's internal support code. It packages the parser's available JSON repair helpers into one ordered table, using the exact descriptions and bound methods named in the function body. In this stage, it serves as a small policy point alongside other parser-internal helpers, but this snippet itself only constructs and returns data.

**What this code does**

`TerminusJSONPlainParser._get_auto_fixes` returns a fixed two-entry list of automatic-fix definitions. It takes only `self`, reads the bound methods `self._fix_incomplete_json` and `self._fix_mixed_content`, and pairs each one with a human-readable description string. It does not call either fixer, does not mutate instance state, and has no external side effects.

**Interface · params / IO**

`(self)`

- params: `self`: `?` — parser instance that supplies the bound fixer methods
- reads: `self._fix_incomplete_json`, `self._fix_mixed_content`
- returns: a list of two tuples: each tuple contains a description string and a bound method reference

**Execution flow**

1. Build the first tuple with the exact description `"Fixed incomplete JSON by adding missing closing brace"` and the bound method reference `self._fix_incomplete_json`.
2. Build the second tuple with the exact description `"Extracted JSON from mixed content"` and the bound method reference `self._fix_mixed_content`.
3. Return the assembled two-entry list in that literal order.

**Source**

```python
    def _get_auto_fixes(self):
        """Return list of auto-fix functions to try in order."""
        return [
            (
                "Fixed incomplete JSON by adding missing closing brace",
                self._fix_incomplete_json,
            ),
            ("Extracted JSON from mixed content", self._fix_mixed_content),
        ]
```

**Non-obvious design decisions**

- The function hard-codes a fixed two-entry policy table instead of discovering fixers dynamically. That choice keeps both the available repairs and their labels explicit in one place.
- The order is semantically meaningful because the docstring says these are auto-fix functions "to try in order." The source encodes that ordering directly in the returned list literal.
- Each entry stores both a user-facing description string and a bound method reference. That keeps explanation text attached to the exact fixer object without invoking the fixer here.

**Relations**

- **Callers**: unknown from this snippet; some parser-internal code can consume the returned list
- **Core callees**: none; it only returns bound method references and does not invoke them
- **Config / state sources**: `self._fix_incomplete_json` bound method on the parser instance; `self._fix_mixed_content` bound method on the parser instance
- **Results to**: the function's direct return value; consumer code that needs an ordered list of description-and-fixer tuples
- **Related siblings**: TerminusJSONPlainParser.__init__ initializes related parser instance state for the same class

</details>


<details id="fn-terminusjsonplainparser_fix_incomplete_json">
<summary><b>TerminusJSONPlainParser._fix_incomplete_json</b> — terminus_json_plain_parser.py:315-328 · JSON brace-balancing auto-fix helper</summary>

> **Stage context**: This stage holds parser-internal helpers that transform or inspect parser inputs without exposing public parse-entry behavior. `TerminusJSONPlainParser._fix_incomplete_json` is one such narrow fixer: it looks only at the provided `response` and `error` strings and returns a tuple result without touching parser state. Within the stage, it pairs with other small JSON parser helpers such as `TerminusJSONPlainParser.__init__` and `TerminusJSONPlainParser._get_auto_fixes`.

**What this code does**

`TerminusJSONPlainParser._fix_incomplete_json` conditionally appends closing curly braces to `response`. It succeeds only when `error` contains at least one of four checked substrings—`"Invalid JSON"`, `"Expecting"`, `"Unterminated"`, or `"No valid JSON found"`—and the computed `brace_count` from `response.count("{") - response.count("}")` is greater than zero. It returns a tuple whose first element is either the original `response` or `response + ("}" * brace_count)`, and whose second element reports whether it changed the text. The function reads no instance attributes and causes no side effects.

**Interface · params / IO**

`(self, response: str, error: str) -> tuple[str, bool]`

- params: `self`: `?` — parser instance passed implicitly; unused by this function body; `response`: `str` — input text whose unmatched `{` and `}` counts determine whether to append closing braces; `error`: `str` — diagnostic string checked for the four trigger substrings
- returns: a `(str, bool)` tuple: either `(response + ('}' * brace_count), True)` when a trigger substring matches and `brace_count > 0`, or `(response, False)` otherwise

**Execution flow**

1. Check `error` for any of four literal substrings: `"Invalid JSON"`, `"Expecting"`, `"Unterminated"`, or `"No valid JSON found"`.
2. If none of those substrings appear, return `(response, False)` immediately.
3. If a substring matches, compute `brace_count` as `response.count("{") - response.count("}")`.
4. When `brace_count > 0`, build `fixed` as `response + "}" * brace_count` and return `(fixed, True)`.
5. When `brace_count <= 0`, leave the text unchanged and return `(response, False)`.

**Source**

```python
    def _fix_incomplete_json(self, response: str, error: str) -> tuple[str, bool]:
        """Fix incomplete JSON by adding missing closing braces."""
        if (
            "Invalid JSON" in error
            or "Expecting" in error
            or "Unterminated" in error
            or "No valid JSON found" in error
        ):
            # Try adding closing braces
            brace_count = response.count("{") - response.count("}")
            if brace_count > 0:
                fixed = response + "}" * brace_count
                return fixed, True
        return response, False
```

**Non-obvious design decisions**

- The helper gates on specific `error` substrings before counting braces. That choice limits edits to cases the caller has already labeled with one of those four diagnostics, instead of rewriting every brace-imbalanced string.
- A matching `error` string is not enough on its own. The extra `brace_count > 0` check avoids adding braces when `response` is already balanced or has more `}` than `{`.
- The repair only balances curly braces with `"}" * brace_count`. This keeps the fix narrow and deterministic, but it also means the function does not attempt broader JSON repair such as inserting brackets, quotes, commas, or removing extra closers.

**Relations**

- **Callers**: internal parser code that passes a `response` string and an `error` string into this helper; `TerminusJSONPlainParser` methods that choose among parser-local auto-fix helpers
- **Core callees**: `error.__contains__` via the four `in error` substring checks; `response.count` for `"{"`; `response.count` for `"}"`; string repetition and concatenation to build `fixed`
- **Config / state sources**: `response` argument; `error` argument
- **Results to**: the caller receives the possibly modified response text as tuple element 0; the caller receives the fix-applied flag as tuple element 1
- **Related siblings**: `TerminusJSONPlainParser.__init__` initializes JSON parser instance fields, while this helper uses no instance state; `TerminusJSONPlainParser._get_auto_fixes` is a related stage sibling that exposes auto-fix definitions

</details>


<details id="fn-terminusjsonplainparser_combine_warnings">
<summary><b>TerminusJSONPlainParser._combine_warnings</b> — terminus_json_plain_parser.py:345-350 · JSON warning text combiner helper</summary>

> **Stage context**: `TerminusJSONPlainParser._combine_warnings` is a small parser-internal string helper in the JSON parser implementation. Within this stage, it matches the role of the XML sibling `TerminusXMLPlainParser._combine_warnings`: both turn one automatic-warning string plus prior warning text into a single warning block. This entry covers only the local string-combination behavior visible in this function.

**What this code does**

`TerminusJSONPlainParser._combine_warnings` combines `auto_warning` with `existing_warning` and returns one string. It always formats `auto_warning` as a `- `-prefixed line. When `existing_warning` is truthy, it appends a newline and then inserts `existing_warning` unchanged; otherwise it returns only the bullet line. The function reads no instance state and causes no side effects.

**Interface · params / IO**

`(self, auto_warning: str, existing_warning: str) -> str`

- params: `self`: `?` — parser instance; unused by this function body; `auto_warning`: `str` — new warning text to format as a bullet line; `existing_warning`: `str` — previous warning text block, included only if truthy
- returns: A combined warning string: either `f"- {auto_warning}"` or `f"- {auto_warning}\n{existing_warning}"`.

**Execution flow**

1. Check the truthiness of `existing_warning` with `if existing_warning:`.
2. If that condition is true, return `f"- {auto_warning}\n{existing_warning}"` directly.
3. If that condition is false, return `f"- {auto_warning}"` directly.

**Source**

```python
    def _combine_warnings(self, auto_warning: str, existing_warning: str) -> str:
        """Combine auto-correction warning with existing warnings."""
        if existing_warning:
            return f"- {auto_warning}\n{existing_warning}"
        else:
            return f"- {auto_warning}"
```

**Non-obvious design decisions**

- The branch tests `existing_warning` by truthiness, not by an explicit comparison such as `is not None` or `!= ""`. That means empty strings and other falsey values all take the same path.
- The function inserts `existing_warning` verbatim in the true branch. It does not add bullets to existing lines, trim whitespace, or normalize any formatting already present in that string.

**Relations**

- **Callers**: Unknown from this source slice; caller not shown
- **Core callees**: No helper or external calls; uses only f-string formatting
- **Config / state sources**: `auto_warning` argument; `existing_warning` argument
- **Results to**: Direct return value to this function's caller; Combined warning text consumed by surrounding parser logic not shown here
- **Related siblings**: `TerminusXMLPlainParser._combine_warnings` implements the same string-combination pattern for the XML parser

</details>


<details id="fn-terminusxmlplainparser_salvage_truncated_response">
<summary><b>TerminusXMLPlainParser.salvage_truncated_response</b> — terminus_xml_plain_parser.py:528-580 · truncate-and-reparse XML response salvage helper</summary>

> **Stage context**: This entry is an internal parser helper in the `subsys-parser-internal` stage. It performs a best-effort salvage pass on a truncated XML/plain response by cutting at a later `</response>` boundary and validating that fragment through `self.parse_response`.

**What this code does**

`TerminusXMLPlainParser.salvage_truncated_response` tries to recover a usable response string from `truncated_response`. It returns a tuple `(salvaged_response, has_multiple_blocks)`, where `salvaged_response` is either a clipped XML string ending at the `</response>` found after `</commands>` or `None`, and `has_multiple_blocks` reports only the specific warning pattern checked after reparsing. The function does not read or write instance attributes directly and has no side effects beyond calling `self.parse_response`.

**Interface · params / IO**

`(self, truncated_response: str) -> tuple[str | None, bool]`

- params: `self`: `TerminusXMLPlainParser` — parser instance used only to call `self.parse_response`; `truncated_response`: `str` — possibly cut-off LLM output to inspect and salvage
- returns: A tuple `(salvaged_response, has_multiple_blocks)`. It returns `(clean_response, False)` only when it finds `</commands>`, then finds `</response>` after that position, reparses the clipped string, and gets neither `parse_result.error` nor the checked multiple-blocks warning pattern. It returns `(None, False)` in three explicit cases: `truncated_response.find("</commands>") == -1`, `truncated_response.find("</response>", commands_end) == -1`, or `self.parse_response(clean_response)` raises any `Exception`. It returns `(None, True)` when reparsing succeeds but `parse_result.warning` contains both `"only issue one"` and `"block at a time"` after lowercasing.

**Execution flow**

1. It searches `truncated_response` for `"</commands>"` and returns `(None, False)` immediately when `commands_end` is `-1`.
2. From `commands_end`, it searches for `"</response>"`; if `response_end` is `-1`, it returns `(None, False)`.
3. When both tags exist in that order, it builds `clean_response` by slicing `truncated_response[: response_end + len("</response>")]`, so the candidate stops at the `</response>` found after `commands_end`.
4. It calls `self.parse_response(clean_response)` inside a `try` block and initializes `has_multiple_blocks = False` before inspecting the parse result.
5. If `parse_result.warning` is truthy, it lowercases that warning into `warning_lower` and sets `has_multiple_blocks` only when both substrings `"only issue one"` and `"block at a time"` are present.
6. It returns `(clean_response, False)` only when `parse_result.error` is falsy and `has_multiple_blocks` is still `False`; otherwise it returns `(None, has_multiple_blocks)`.
7. If `self.parse_response(clean_response)` raises any `Exception`, the broad `except` swallows it and returns `(None, False)`.

**Source**

```python
    def salvage_truncated_response(
        self, truncated_response: str
    ) -> tuple[str | None, bool]:
        """
        Try to salvage a valid response from truncated output.

        Args:
            truncated_response: The truncated response from the LLM

        Returns:
            Tuple of (salvaged_response, has_multiple_blocks)
            - salvaged_response: Clean response up to </response> if salvageable, "
                "None otherwise
            - has_multiple_blocks: True if multiple response/commands blocks "
                "were detected
        """
        # Check if we can find a complete response structure
        commands_end = truncated_response.find("</commands>")
        if commands_end == -1:
            return None, False

        # Find the </response> tag after </commands>
        response_end = truncated_response.find("</response>", commands_end)
        if response_end == -1:
            return None, False

        # We have a complete response up to at least </commands>
        # Truncate cleanly at </response>
        clean_response = truncated_response[: response_end + len("</response>")]

        # Check if this is a valid response with no critical issues
        try:
            parse_result = self.parse_response(clean_response)

            # Check if there are no errors and no "multiple blocks" warnings
            has_multiple_blocks = False
            if parse_result.warning:
                warning_lower = parse_result.warning.lower()
                has_multiple_blocks = (
                    "only issue one" in warning_lower
                    and "block at a time" in warning_lower
                )

            if not parse_result.error and not has_multiple_blocks:
                # Valid response! Return the clean truncated version
                return clean_response, False
            else:
                # Has errors or multiple blocks
                return None, has_multiple_blocks

        except Exception:
            # If parsing fails, not salvageable
            return None, False
```

**Non-obvious design decisions**

- The salvage path requires `"</commands>"` before it will even look for `"</response>"`, because the code anchors the second search at `commands_end`. That choice rejects outputs that happen to contain a later response close without a completed commands close.
- The function treats only one warning shape as a separate `has_multiple_blocks` signal: `parse_result.warning.lower()` must contain both `"only issue one"` and `"block at a time"`. Other warnings do not set that flag.
- It validates the clipped candidate by reparsing with `self.parse_response` instead of trusting tag presence alone. That makes success depend on the parser's normal `error` and `warning` fields, not just string structure.
- The `except Exception:` branch deliberately collapses every parse failure into the same `(None, False)` result. This keeps salvage as a fail-closed helper, but it also hides the underlying parse exception from the caller.

**Relations**

- **Callers**: External caller not shown in the provided source snippet
- **Core callees**: `TerminusXMLPlainParser.parse_response`
- **Config / state sources**: `parse_result.error` from `self.parse_response(clean_response)`; `parse_result.warning` from `self.parse_response(clean_response)`
- **Results to**: Returns `salvaged_response` to this function's caller; Returns `has_multiple_blocks` to this function's caller
- **Related siblings**: `TerminusXMLPlainParser._extract_response_content` also works with `<response>...</response>` boundaries, but this helper reparses a clipped full response candidate instead of extracting inner text.

</details>
