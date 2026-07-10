# Shared extension backends and rollout trace models  `stage-18.4.6`

This stage provides shared “record formats” that other parts of the system can agree on. It is not the main work loop itself. Instead, it is behind-the-scenes support: the common shapes used to describe what happened during a rollout trace, which is a compact history of a run.

The session model is the top-level map. It describes the overall rollout status, the threads or parallel lines of work, the time windows when work happened, and when a Codex turn became active. In simple terms, it says who was involved, when things happened, and how the work was grouped.

The runtime model adds the action details from the execution side. It records code runs, compaction steps, tool calls, terminal activity, and links between threads. This explains how conversation events led to actual side effects, like a machine log that sits beside a chat transcript.

The payload reference file keeps the trace small. Instead of stuffing large requests, responses, or runtime dumps directly into the trace, it stores lightweight IDs and pointers to those separate files. Together, these pieces give a compact but connected picture of a session.

## Files in this stage

### Trace session structure
These models establish the top-level rollout trace lifecycle and then define the runtime execution objects that live within that session and thread structure.

### `rollout-trace/src/model/session.rs`

`data_model` · `trace replay and viewer projection`

This file supplies the coarse-grained session model that the rest of the reduced trace hangs from. `RolloutStatus` records whether the overall rollout is still running, completed normally, failed, or was aborted before normal completion. At the thread level, `AgentThread` represents one participating Codex thread or agent, including the root interactive session. It stores stable identity (`AgentThreadId`), routing identity (`AgentPath`), optional nickname for presentation, provenance via `AgentOrigin`, a thread-scoped `ExecutionWindow`, an optional default model hint, and the ordered list of conversation items first observed in that thread.

`AgentOrigin` distinguishes the root thread from spawned children. Spawned threads retain the parent thread ID, the `EdgeId` of the spawn interaction, the selected task name, and the chosen agent role. That preserves multi-agent lineage without overloading display names as identity.

`ExecutionWindow` is a reusable lifecycle envelope shared by threads, turns, and runtime objects elsewhere in the model. It combines wall-clock timestamps with causal `RawEventSeq` sequence numbers for start and optional end, plus an `ExecutionStatus` enum that distinguishes running, completed, failed, cancelled, and aborted states. The comments emphasize an important invariant: sequence numbers, not timestamps, are the authoritative ordering primitive.

Finally, `CodexTurn` models one activation of the Codex runtime for a thread. It groups protocol/runtime work under a stable `CodexTurnId`, points back to the owning thread, carries its own execution window, and optionally lists the conversation items that triggered the activation.


### `rollout-trace/src/model/runtime.rs`

`data_model` · `trace replay and viewer projection`

This file models the non-transcript runtime graph reconstructed from raw trace events. `CodeCell` captures one model-authored `exec` cell, tying a reducer-owned `CodeCellId` to the model-visible call ID, owning thread and turn, source and output conversation items, optional runtime cell ID, execution window, runtime status, key event timestamps/sequences, original JavaScript source, and nested or wait tool-call IDs. `CodeCellRuntimeStatus` distinguishes accepted, running, yielded, completed, failed, and terminated states.

Compaction is split into two layers: `Compaction` records the installed checkpoint where live history changed, including marker item, contributing request IDs, input items, and replacement items; `CompactionRequest` records each upstream remote request with execution timing, model/provider, and raw request/response payload IDs. This separation preserves both the semantic boundary and the operational attempts that produced it.

`ToolCall` is the main runtime operation object. It links optional MCP, model-visible, and code-mode runtime identifiers to thread, starting turn, execution window, requester, kind, model-visible call/output items, optional terminal operation, summary, canonical invocation/result payloads, and auxiliary runtime payloads. Supporting enums classify requester, tool kind, and bounded summaries. Terminal activity is modeled explicitly through `TerminalSession`, `TerminalOperation`, `TerminalRequest`, `TerminalResult`, and `TerminalModelObservation`, keeping runtime bytes separate from proof of model visibility.

Finally, `InteractionEdge`, `InteractionEdgeKind`, and `TraceAnchor` represent directed information flow between threads, tool calls, and conversation items, including carried item and payload IDs. The overall design keeps semantic transcript state and operational causality linked but distinct.


### Payload references
This module provides the lightweight identifiers used by the reduced trace models to point at external raw payload artifacts.

### `rollout-trace/src/payload.rs`

`data_model` · `trace writing, replay, and details loading`

This file is the payload-reference layer of the rollout-trace schema. It introduces `RawPayloadId` as a stable string identifier for one raw payload within a bundle, then wraps that identifier in `RawPayloadRef`, which also records the payload’s coarse role and its bundle-local relative path. The path is intentionally just a plain string relative to the bundle root; the comments note that the writer always materializes payloads as local files, so the schema does not expose alternate storage backends or transport abstractions.

`RawPayloadRef` exists to keep the reduced `RolloutTrace` compact. Conversation timelines, cards, and summaries can carry references to large upstream requests, responses, terminal logs, or protocol events without forcing replay output or browser consumers to inline every byte. UI code can inspect `kind` first to choose labels or syntax highlighting before opening the file.

The `RawPayloadKind` enum enumerates the payload categories the writer and reducer understand: inference request/response, compaction request/checkpoint/response, tool invocation/result/runtime event, terminal runtime event, protocol event, session metadata, and child-agent result payloads. It derives ordering traits in addition to serialization traits, which makes these kinds usable in sorted collections or deterministic presentation. Overall, this file is a small but important schema boundary between the semantic reduced graph and the raw artifacts captured in the trace bundle.
