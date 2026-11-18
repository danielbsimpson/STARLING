---
document_type: research-report
title: Conversational User-Fact Memory and Tool Selection
date_created: 2026-11-18
status: Research
tags: [research, memory, privacy, tools, routing, evaluation]
---

# Conversational User-Fact Memory and Tool Selection

**Scope.** Repository observations below are marked **Observed**; proposed changes are marked **Proposal**. `TODO.md` and the feature plans identify several ideas as planned, not implemented. This report does not change those plans or make legal determinations.

## Summary

STARLING already has a useful foundation: local session logs, a shutdown/sleep “dream” pipeline, a Chroma-backed fact collection, prompt/context injection, explicit voice-tool handlers, and localhost-only memory administration. The principal gaps are lifecycle rather than storage: facts are extracted automatically without a fact-level review/update lifecycle; retrieval is vector-only; deleting a session removes its Chroma facts but not their other representations; and tool choice remains a long, ordered front-end trigger chain with a keyword-score recovery step.

**Proposal:** improve the current fact-memory path before adding more stores; make retention, review, correction, and deletion visible user controls; and introduce model-proposed, schema-shaped tool calls behind the existing tool handlers and a deterministic authorization/confirmation boundary. Keep current routing as a rollback and explicit-mode path. Evaluate with local, labeled data before enabling either feature by default.

## What exists today

- **Conversation and memory path — Observed.** `backend/dream.py` reads session JSONL, checks a minimum-substance threshold, then runs four LLM passes: summary, fact extraction, reflection, and SOUL evolution. Pass 2 writes `facts_<session>.md`; `backend/rag.py::ingest_facts()` parses fact bullets and upserts them into `starling_memory` with `session_id`, category, timestamp, and `dream_pass_2` source metadata. See [`backend/dream.py`](../backend/dream.py) and [`backend/rag.py`](../backend/rag.py).
- **Retrieval and controls — Observed.** `backend/llm_rag_injection.py` computes one embedding for the latest user message and passes it to both document and fact retrieval. Fact retrieval ranks by vector distance, takes top-k, and injects a bounded system block; it has no temporal filter or explicit freshness/confidence weighting. `/memory/facts` lists session groups, and localhost-only `DELETE /memory/facts/{session_id}` removes those session’s Chroma facts. It does not remove the fact Markdown, session log, dream summary/reflection, or related SOUL archives. See [`backend/llm_rag_injection.py`](../backend/llm_rag_injection.py), [`backend/main.py`](../backend/main.py), and [`backend/rag.py`](../backend/rag.py).
- **Other persistent context — Observed.** SOUL is separately archived and rewritten by `backend/soul.py`; the prompt registry also has a static persona prompt containing user-profile material. Treating these as separate from user-editable facts matters for correction and deletion. See [`backend/soul.py`](../backend/soul.py) and [`backend/prompts.py`](../backend/prompts.py).
- **Tool path — Observed.** `frontend/app.js::_routeInput()` gives priority to active conversational modes and confirmation states, then runs ordered explicit intercepts. If none matches, `detectFuzzyToolIntent()` counts exact keyword hits and returns the best match for a yes/no confirmation; otherwise the request falls back to chat. `_retriggerTool()` duplicates a dispatch mapping that must stay in sync with the intercepts and fuzzy map. See [`frontend/app.js`](../frontend/app.js), [`frontend/fuzzy-tool-detect.js`](../frontend/fuzzy-tool-detect.js), and [`toolkit/TRIGGER_PHRASES.md`](../toolkit/TRIGGER_PHRASES.md).
- **Model boundary — Observed.** The Ollama and llama-server chat relays currently accept role/content messages and stream assistant text; neither relay passes tool definitions or handles structured tool-call responses. The `llama-server` target is already an OpenAI-compatible local API. See [`backend/ollama.py`](../backend/ollama.py) and [`backend/llama_server.py`](../backend/llama_server.py).
- **Existing plans — Observed.** `TODO.md` marks episodic memory, the Jev decision layer, and Jev memory classifier as planned. Detailed specs already exist in [`plan/feature-episodic-memory-1.md`](../plan/feature-episodic-memory-1.md), [`plan/feature-jev-decision-layer-1.md`](../plan/feature-jev-decision-layer-1.md), and [`plan/feature-jev-memory-classifier-1.md`](../plan/feature-jev-memory-classifier-1.md). The RAG Manager plan covers file-source management, not per-fact conversational-memory correction. These plans are useful inputs, but their proposed behavior is not current behavior.

## Recommendations

### 1. Model memory as a user-controlled lifecycle

**Proposal.** Keep the current fact store as the first target; avoid adding a second index until its governance and retrieval quality are measurable. Distinguish at least:

1. **User profile** — explicit, editable preferences or stable facts.
2. **Session facts** — compact assertions derived from prior sessions, with provenance.
3. **Episodes** — selectively indexed turns/journal entries, if temporal recall proves valuable.
4. **Assistant persona** — SOUL and prompt configuration, kept separate from claims about the user.

For each retained fact, record a stable ID, normalized text, category, source/session, evidence or a safe reference to it, created/updated/valid times, confidence as an uncalibrated estimate unless tested, sensitivity class, retention policy, and whether it was explicitly supplied or inferred. A source/session field already exists; the additional fields are a proposal. Treat retrieved memory as fallible context, not system instructions.

Use an opt-in memory setting with a clear explanation, a “remember this” action, and a way to review/edit/delete individual facts. A classifier can suggest candidates, but should not silently convert every positive score into permanent memory. If consent is selected as the legal basis, GDPR Article 7 requires conditions including that withdrawal be as easy as giving consent; Articles 5, 15, 16, and 17 address principles, access, rectification, and erasure respectively, subject to their scope and exceptions. [GDPR Arts. 5, 7, 15–17](https://eur-lex.europa.eu/eli/reg/2016/679/oj). Applicability and legal basis require separate legal analysis.

Local inference and local Chroma storage fit this project’s stated local-first design, but do not by themselves establish meaningful user consent or cover networked tools. Make memory processing visible, identify any external service involved in a tool action, minimize logged content, and keep memory off when disabled. This is a product recommendation, not a claim that the repository currently transmits its memory store.

### 2. Improve retrieval, updating, and deletion together

- **Retrieval — Proposal.** Reuse the already-computed query embedding. Add a hybrid ranker that can use semantic similarity plus lexical match and recency/valid-time filters; use query intent to distinguish “what do you know about me?” from “what did I say last week?”. Enforce a relevance floor and context budget, show sources/dates where useful, and allow “I don’t know” instead of injecting weak matches. Add episodic indexing only for selected/salient turns and only when its temporal-recall benefit beats fact-only retrieval.
- **Updates and conflicts — Proposal.** Keep deterministic IDs for idempotent imports, but use stable fact identity for revisions so a corrected preference supersedes the active value rather than creating another near-duplicate. Retain dated history only when useful and permitted. On ambiguity or contradiction, ask the user or leave the active fact unchanged; do not infer a fact’s truth from vector similarity.
- **Deletion — Proposal.** Extend the current session-wide Chroma delete into explicit fact/source/session/global operations. Make the deletion contract enumerate every derived copy: Chroma records and embeddings, `facts_*.md`, session logs, dream summaries/reflections, SOUL current/archive content where applicable, and future episodic indexes. Use a deletion manifest or source IDs to make it auditable and repeatable; report partial failures rather than success when a copy remains. Provide preview and confirmation for broad deletion. Add an end-to-end test that re-queries after deletion and checks all in-scope stores, not merely the Chroma count.
- **Retention — Proposal.** Separate “disable future memory writes” from “delete existing memories.” Add retention/expiry for low-value episodic data and avoid copying full transcript text into additional stores. Preserve session logs only under a clearly documented retention policy.

### 3. Move tool selection beyond trigger words without handing over execution

**Proposal.** Use a single local tool catalog as the source for model descriptions, JSON input schemas, frontend labels, handler references, risk level, authorization checks, and confirmation policy. The two current local backends have first-party tool-calling support: Ollama documents tool definitions plus a tool-result/follow-up loop; llama.cpp documents function calling in `llama-server` when started with `--jinja`, with native/generic handlers and model/template-specific behavior. [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling); [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md). This makes a tool-call adapter worth evaluating before adding a separate Jev decision server, but it does not guarantee every configured model performs reliably.

Use this staged flow:

1. Preserve active modes, cancel/confirm handling, and explicit deterministic intercepts for safety-critical UI states.
2. For ordinary chat, give the local model only enabled, relevant tools and ask it to propose either a typed call or normal conversational response.
3. Parse a proposal as untrusted input. Resolve its name through the server-side allowlist, validate arguments against a strict schema (types, required fields, enums, ranges, and no unknown fields), and independently check user/config authorization.
4. Invoke only an existing bounded handler, then return a size-limited, sanitized result to the model for its user-facing response. Never let the model provide arbitrary code, shell commands, unrestricted URLs, or credentials.
5. Require explicit confirmation for writes, deletes, device control, disabling protections, or other consequential operations. Keep read-only, low-impact actions as a separately configurable policy.

This separation is important: MCP describes tool invocation as model-controlled, but also recommends visible tool-use UI and human denial/confirmation; it says clients must validate tool inputs and implement access controls, rate limits, and output sanitization. [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). OWASP identifies excessive functionality, permissions, and autonomy as causes of excessive agency, and recommends least functionality/privilege and human approval for high-impact actions. [OWASP LLM06:2025](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).

Keep retrieved web pages, email headers, documents, and memory clearly marked as untrusted data; do not obey instructions found inside them. OWASP notes direct and indirect prompt injection can influence model output and that RAG does not itself eliminate prompt-injection risk. [OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).

For Starling specifically, start with one read-only tool (for example Weather) and a single-call-per-turn policy. Keep `_routeInput()` as a fallback and compatibility path while testing. Add write-capable tools only after the permission/confirmation path is proven. The planned Jev layer remains a viable alternative classifier, but any returned tool name/parameters must pass through the same catalog, validation, authorization, and confirmation code; a confidence threshold is not a security control.

### 4. Evaluate quality and safety locally

Create a versioned, locally stored, non-production test set before enabling new behavior. Do not send transcripts or repository contents to hosted evaluation services. Include:

- Tool paraphrases, negatives, keyword collisions, negation, follow-up discussion, ambiguous intent, ASR-like substitutions, and multi-tool requests.
- Expected tool/no-tool, normalized argument values, whether confirmation is required, and whether authorization should permit execution.
- Memory extraction cases for preferences, temporary facts, sensitive facts, third-party facts, corrections, contradictions, explicit “forget” requests, and small talk.
- Retrieval questions that test semantic match, dates, stale-vs-current facts, unrelated queries, and deleted data.

Measure per-tool precision/recall and false activations; argument exact/semantic accuracy; abstention and confirmation rates; unauthorized/unsafe actions (target zero in tests); memory extraction precision/recall; retrieval precision@k and temporal correctness; update/delete propagation; and p50/p95 selection and total-action latency. Calibrate thresholds only on a held-out local set—do not interpret raw model scores as calibrated probabilities. Run deterministic handler mocks first, then a fixed local-model matrix, then opt-in shadow/A-B evaluation with no side effects. Keep regressions for today’s explicit routing and active modes.

## Implementation priorities

1. **Baseline and contracts.** Add a small labeled routing/memory evaluation set and document current memory locations, tool effects, and retention. Keep test data synthetic or locally redacted.
2. **Memory controls before more storage.** Add opt-in/disable controls, fact review/edit/delete, provenance, conflict behavior, and cascade deletion. Verify all storage paths and distinguish deletion from disabling.
3. **Tool registry and policy seam.** Consolidate catalog/handler metadata and implement schema validation, authorization, confirmation, timeouts, result sanitization, and audit metadata with deterministic tests.
4. **Pilot one model/tool path.** Extend one backend relay to accept tool definitions and parse tool calls; test Ollama and llama.cpp independently, including llama-server `--jinja` and the actual configured model/template. Keep explicit routing available.
5. **Expand conservatively.** Add read-only tools, then separately approved write tools. Decide whether Jev is needed based on measured selection quality/latency, not architecture preference.
6. **Add episodic recall or automatic memory classification only after lifecycle safety.** Reuse the existing embedding/query path; gate by explicit settings and validate candidate precision, time-aware recall, and full deletion. Do not make a new classifier the sole safety or consent mechanism.

## Sources

All external sources below are first-party documentation/specification or the primary legal text; accessed 2026-11-18.

1. European Union, [Regulation (EU) 2016/679 (GDPR), official EUR-Lex text](https://eur-lex.europa.eu/eli/reg/2016/679/oj), especially Articles 5, 7, 15, 16, and 17.
2. Model Context Protocol, [Tools specification, version 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
3. Ollama, [Tool calling capability documentation](https://docs.ollama.com/capabilities/tool-calling).
4. ggml-org/llama.cpp, [Function calling documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md).
5. OWASP GenAI Security Project, [LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).
6. OWASP GenAI Security Project, [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).

## Limitations

- This is a repository-grounded research report, not a code audit, security review, legal opinion, or performance benchmark.
- The EUR-Lex pages are cited as the canonical source; the web reader could not render their text during this session.
- The reported tool-calling capabilities are platform documentation, not evidence that STARLING’s configured models/template produce valid calls or that the current relays implement them. That requires an in-repository implementation and local testing.
- The plans may have changed since inspection; report conclusions distinguish planned specs from implementation observed in the checked files.
