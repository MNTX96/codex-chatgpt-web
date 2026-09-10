# Retained Conversation / Rolling Checkpoint — Implementation Note

Date: 2026-09-10

## Current conclusion

No architecture change is required now for the proposed **retained conversation + rolling checkpoint + delta-only resume** direction.

The project already implements the important parts of that design for ChatGPT Web/Sol:

- Codex/local history remains the canonical source of truth.
- A retained ChatGPT Web conversation can continue the same task across native Codex turns.
- When the exact retained conversation is available, the adapter sends only the suffix after the last assistant reply instead of replaying the full compiled history.
- Compaction can ask the retained Web agent for a structured checkpoint, retire the old browser conversation, and continue in a fresh Temporary Chat.
- If the retained source is missing, the bridge can recover from canonical Codex history through the existing compaction/recovery path.
- Bigger Context remains useful as a transport fallback when a bootstrap/compaction payload cannot fit a normal single browser message.

Because these primitives already exist, adding a second retained-history/checkpoint system would duplicate state management and increase failure modes without a demonstrated benefit.

## Why Bigger Context still exists

Retained conversation reduces repeated context only while the exact source conversation is still available and valid. It does not remove every large-payload case.

Bigger Context is still useful for cases such as:

- a very large initial/bootstrap task;
- rebuilding context after the retained Web conversation is unavailable;
- compaction/recovery payloads that exceed one browser message budget;
- other payloads that must be transported before a retained conversation can resume normally.

It should therefore be treated as a fallback transport mechanism rather than evidence that the normal Sol path must replay all history every turn.

## Known limitations / risks

The retained/checkpoint path is operationally more complex than a simple stateless request:

1. The retained browser conversation can disappear, expire, or fail ownership/identity checks.
2. Compaction must preserve both task state and execution/tool state before the old browser owner is retired.
3. A checkpoint is compressed working state, so important details can be lost if the summary is incomplete. Canonical Codex/local history remains necessary for recovery and verification.
4. A small delta does not mean the model has unlimited context; the retained ChatGPT conversation still accumulates model-side history until compaction/rollover.
5. Bigger Context partitions complete records across messages. A single atomic record that is itself larger than one allowed browser message still needs a separate chunking/read-on-demand strategy.

Upstream history already contains several fixes around retained conversations, compaction handoff, browser lifecycle and Bigger Context. That is evidence that these paths need careful stabilization, but not evidence that the overall retained-conversation design is unsuitable.

## When to revisit this architecture

Do not redesign this area unless measurements or reproducible failures show one of the following:

- normal Sol turns are still replaying large portions of canonical history despite an available retained conversation;
- retained-conversation loss happens often enough to make recovery expensive or unreliable;
- compaction/checkpoint handoff repeatedly loses required constraints, tool state or task state;
- multipart Bigger Context is being used on ordinary continuation turns instead of only bootstrap/recovery cases;
- request count, cooldowns or rate limits remain materially worse after confirming delta-only resume is working;
- one-record-too-large failures become common enough to justify record-level chunking or read-on-demand retrieval.

If one of these conditions appears, first instrument the existing path and identify the failing state transition before introducing new persistence or summarization primitives.

## Relevant implementation points

Review these files first when investigating this area:

- `src/adapters/chatgpt-web/conversation-key.ts` — retained conversation identity and incremental resume request.
- `src/adapters/chatgpt-web/index.ts` — retained conversation selection, resume flow and compaction integration.
- `src/adapters/chatgpt-web/compaction-handoff.ts` — structured retained-source compaction handoff.
- `src/adapters/chatgpt-web/compaction-continuation.ts` — checkpoint validation/continuation evidence.
- `src/adapters/chatgpt-web/rolling-checkpoint.ts` — rolling checkpoint implementation used by Luna.
- `src/adapters/chatgpt-web/usage.ts` — Bigger Context part selection and transport budgeting.
- `src/chatgpt-web-models.ts` — context windows, browser message limits and Bigger Context multiplier.
- `docs/architecture.md` — documented retained browser lifecycle, incremental prompts and compaction behavior.
- `docs/dev-chat.md` — user/developer-facing behavior for Bigger Context and compaction.

## Recommended future direction

Keep the current architecture and improve it incrementally:

`bootstrap -> retained Sol conversation -> delta turns -> checkpoint/compaction -> fresh retained Sol conversation -> delta turns`

Use Bigger Context only when the bootstrap or recovery payload cannot fit a normal single message. Keep full canonical history in Codex/local as the recovery source of truth.
