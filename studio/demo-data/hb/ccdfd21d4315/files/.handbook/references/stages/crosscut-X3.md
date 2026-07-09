## crosscut-X3 · Logging

#### (a) Opening Explanation

Logging exists to make the agent explain itself while it is running and failing. This is not a run-advancing pipeline stage. It is a cross-cutting concern: a side channel used by many real stages to leave clues about what just happened, what is about to happen, and why the agent stopped, retried, or continued. The system needs it because an agent loop has many branches that look silent from the outside: LLM calls fail, terminal sessions die, summaries trigger, subagents report progress, and safety limits warn before they bite. Without logs, those paths are hard to debug. In the handbook structure, this page explains the shared `self.logger` calls; for actual state-changing logic, look back to the neighboring real stages.

#### (b) Main Flow

1. **Log before risky or important work.**  
   Stages emit `self.logger...` messages right before actions that may branch. Think: before an LLM call, before a summarize path, or when setup notices something unusual. The job here is simple: leave a breadcrumb so a human can later say, “the agent was trying to do this.”

2. **Log on exception, then choose the branch.**  
   In `_query_llm()` (ask the language model for the next response), exception handlers log what failed. The log does not fix the failure. It records it, then the real stage decides the outcome: **log then retry**, **log then abort**, or **log then surface an error**.

3. **Log before continue paths.**  
   Some branches are not failures. A proactive summarize trigger logs that the agent is compressing context to stay within limits. Subagent progress markers log that a smaller helper agent is starting or reporting back. These are **log then continue** points.

4. **Log before abort or degraded operation.**  
   If a tmux session (a terminal the agent can drive remotely) dies, a message is logged so the later stop or recovery path is visible. Likewise, construction may log a max-turns warning before the run ever reaches that limit. These are early warnings that explain later behavior.

5. **Produce no pipeline state.**  
   The only output of logging is an external side effect: lines written to logs. That is exactly why this chapter exists separately. It helps readers not confuse “the agent changed state” with “the agent reported what state it was in.”

#### (c) 📊 State Flow

**📊 State Flow**

- writes: `无` — no listed state register is written by logging itself; log emission is an external side effect
- reads: `无` — no listed state register is read by this concern itself, even though surrounding stages may read state and then log about it
- clears: `无` — logging does not clear any listed state register
- triggers downstream: `无` — logging does not own transitions; the surrounding real stage decides whether to retry, abort, or continue after emitting a log

#### (d) Pipeline Hand-Off

Upstream real stages bring the current situation: setup warnings, LLM-call failures, summarize decisions, subagent progress, or terminal-session errors. Logging adds observability, not state; downstream stages consume the same pipeline state as before, while humans consume the log lines to understand why the run retried, continued, or stopped.
