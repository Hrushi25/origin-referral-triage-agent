# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

This project implements an AI-assisted triage agent for Cedar Kids Therapy, a fictional pediatric therapy practice. It processes a messy Monday inbox and returns a structured, human-reviewable action plan for each item.

The goal is not to fully automate intake or scheduling. The agent helps staff extract key details, identify missing information, use the right tools, and decide the next human action.

## How to run

Install dependencies:

    npm install

Create a local `.env` file:

    ANTHROPIC_API_KEY=your_key_here

Run triage:

    npm run triage

Validate output:

    npm run validate

Explicit path commands also work:

    npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
    npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl

The generated `output.json` is included for review.

## Stack and runtime

- TypeScript
- Node.js LTS
- npm
- Anthropic SDK
- Provided tools in `src/tools.ts`
- Provided schema and validator

The API key is loaded from `ANTHROPIC_API_KEY` and is not stored in source code.

## Architecture

The agent is implemented in `src/agent.ts`.

Flow:

1. Process each `InboxItem` independently.
2. Use an LLM to extract structured intake details.
3. Apply deterministic guardrails for safety and workflow decisions.
4. Use the provided tools where appropriate.
5. Return one `ItemOutput` per inbox item.
6. Let `src/index.ts` wrap results with `buildBatchOutput()`.

The implementation uses only the provided tools:

- `search_patient`
- `verify_insurance`
- `lookup_policy`
- `find_slots`
- `hold_slot`
- `create_task`
- `draft_message`
- `escalate`

All tool calls are made inside `withItemContext(item.id, async () => ...)`, and `tools_called` is populated through `getToolCallsForItem(item.id)`.

## Decision model

I used a hybrid LLM + deterministic guardrail approach.

The LLM extracts messy intake information such as child name, DOB/age, parent contact, discipline, concern, payer, member ID, language preference, missing information, and initial classification.

Deterministic guardrails handle higher-risk decisions:

- Safeguarding language is always escalated to `P0`.
- Same-day cancellation/reschedule requests are routed as `P1`.
- Incomplete referrals are routed to `missing_paperwork`.
- Out-of-network, expired, or unknown insurance prevents slot holds.
- Referrals missing minimum intake information do not receive slot holds.
- Existing patient matches with possible guardian/contact mismatch require human verification before outreach or slot confirmation.
- Clinical questions are routed to clinician review.


## Urgency calibration

- `P0`: safeguarding, possible harm, abuse, neglect, unsafe caregiving, or mandated-reporter concern.
- `P1`: same-day operational issue requiring prompt staff action.
- `P2`: normal intake, scheduling, billing, missing paperwork, or clinical-review workflow.
- `P3`: low-priority admin, FYI, or spam.

The agent defaults to `P2` unless there is a clear safety or same-day operational reason to escalate.

## Human-review action model

The agent does not send messages or schedule appointments.

It may create:

- draft replies for staff review
- tasks for intake, billing, front desk, or clinical lead
- pending-review slot holds
- escalations for safeguarding cases

Draft replies are concise and operational. They do not provide clinical advice and do not imply that a message was sent or that an appointment was scheduled.

## Notable workflow choices

- **Safeguarding:** P0 escalation, same-hour clinical lead task, neutral draft only, no investigative advice.
- **Insurance:** Out-of-network, expired, or unknown coverage is routed to billing/intake before any slot hold.
- **Missing paperwork:** Incomplete referrals do not receive slot holds; intake is asked to collect missing information first.
- **Existing patient match:** Possible guardian/contact mismatch requires human verification before outreach or slot confirmation.
- **Language access:** Spanish-language needs trigger language-access policy lookup, Spanish-capable provider search, and Spanish draft acknowledgement.

## Failure modes and production evaluation

Main failure modes considered:

- missed safeguarding concern
- over-escalation to `P0`
- clinical advice leakage
- unsafe scheduling behavior
- slot holds with incomplete intake
- insurance workflow errors
- patient identity or guardian mismatch
- LLM extraction or JSON formatting failure
- hidden synthetic input variants

In production, I would evaluate classification accuracy, safeguarding recall, urgency calibration, missing-information extraction accuracy, inappropriate clinical advice rate, inappropriate slot-hold rate, tool-call relevance, reviewer override rate, trace completeness, latency, and cost.

## What I chose not to build, and why

Given the suggested two-hour time box, I focused on the core triage workflow and did not build:

- a full human-review UI
- persistent storage
- real EHR, scheduling, or messaging integrations
- real PHI handling
- full RAG over policies
- a broad automated eval suite
- advanced multilingual workflows beyond Spanish acknowledgement and provider matching

I prioritized safe triage judgment, tool orchestration, schema-valid output, auditability, and clear human handoff.

## What I would do with another 4 hours

With more time, I would add:

- synthetic eval cases for safeguarding, missing paperwork, insurance, guardian mismatch, spam, and multilingual requests
- stricter JSON schema validation for LLM output
- confidence scores and source-text evidence for extracted fields
- better DOB/age normalization
- stronger policy grounding
- smarter slot matching against family preferences
- a simple human-review UI
- structured logs for latency, fallback rate, tool failures, reviewer corrections, and cost

## Validation status

The current implementation successfully runs:

    npx tsc --noEmit
    npm run triage
    npm run validate

The generated `output.json` contains one output per input item, uses real tool call IDs from the trace, and passes the provided validator.