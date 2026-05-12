# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

This project implements an AI-assisted triage agent for Cedar Kids Therapy, a fictional pediatric therapy practice. The agent processes a messy Monday inbox containing fax referrals, voicemail transcripts, portal messages, and emails, then produces a structured, human-reviewable action plan for each item.

The goal of this implementation is not to fully automate intake or scheduling. Instead, the agent helps staff quickly understand what each message is about, what information is available or missing, what tools were used, and what the recommended next human action should be.

## How to run

Install dependencies:

npm install

Create a local .env file in the project root:

ANTHROPIC_API_KEY=your_key_here

Run the triage agent with the default paths:

npm run triage

Validate the generated output:

npm run validate


The commands also work with explicit paths:
npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl



Do not commit .env, .trace/, node_modules/, or any API keys. The final generated output.json is included for review.

Stack and runtime

This project uses:

TypeScript
Node.js LTS
npm
Anthropic SDK for runtime LLM extraction
dotenv for local environment variable loading
The provided tool layer in src/tools.ts
The provided schema and validation flow

The Anthropic API key is loaded from the ANTHROPIC_API_KEY environment variable. The key is not stored in source code.

I used the LLM for structured extraction from messy text, but kept safety-critical and workflow-critical decisions deterministic. This keeps the prototype flexible while still being predictable, auditable, and safer for a healthcare-adjacent intake workflow.

Architecture

The agent is implemented in src/agent.ts.

The processing flow is:

Receive an array of InboxItem objects.
Process each item independently.
Use an LLM to extract structured intake fields:
child name
DOB or age
parent or guardian contact
requested discipline
diagnosis or concern
payer
member ID
language preference
scheduling preference
missing information
initial classification and rationale
Apply deterministic guardrails to override or refine the LLM output.
Use the provided tools where appropriate.
Return one ItemOutput per inbox item.
Let the starter src/index.ts wrap the item outputs with buildBatchOutput().

The implementation uses the provided tools only:

search_patient
verify_insurance
lookup_policy
find_slots
hold_slot
create_task
draft_message
escalate

All item-level tool calls are wrapped in:

withItemContext(item.id, async () => {
  // tool calls
});

The tools_called field is populated with:

getToolCallsForItem(item.id)

I do not manually create tool call IDs or bypass the tool layer, because the trace is part of the audit and validation flow.

Decision model

The agent uses a hybrid decision model.

LLM-assisted extraction

The LLM reads the raw inbox item and extracts structured intake information. This helps with messy messages like voicemails, parent portal messages, and fax-style referrals.

If the LLM returns markdown-wrapped JSON, the agent cleans and parses the JSON. If the LLM call or parsing fails, the agent falls back to deterministic extraction so that every item still receives an output.

Deterministic guardrails

I intentionally kept several decisions deterministic instead of relying only on the LLM:

Safeguarding language is always escalated to P0.
Same-day cancellation or reschedule requests are routed as P1.
Incomplete referrals are routed to missing_paperwork.
Out-of-network, expired, or unknown insurance prevents slot holds.
Referrals missing minimum intake information do not receive slot holds.
Existing patient matches with possible guardian/contact mismatch require human verification before outreach or slot confirmation.
Clinical questions are routed to clinician review and do not receive automated clinical advice.
Every item is marked requires_human_review: true.

This design is meant to make the system more reliable and safer under hidden synthetic variants.

Urgency calibration

The agent follows the urgency guidance from the prompt:

P0: safeguarding, possible harm, abuse, neglect, unsafe caregiving, or mandated-reporter concern.
P1: same-day operational issue requiring prompt staff action.
P2: normal intake, scheduling, billing, missing paperwork, or clinical-review workflow.
P3: low-priority admin, FYI, or spam.

The agent defaults to P2 unless there is a clear safety or same-day operational reason to escalate. This is intentional because over-escalation is also a production failure mode.

Human-review action model

The agent does not send messages or schedule appointments.

It may create:

draft replies for staff review
tasks for intake, billing, front desk, or clinical lead
pending-review slot holds when appropriate
escalations for urgent safeguarding cases

Draft replies are written to be clear, empathetic, and operationally useful. They do not provide clinical advice and do not imply that a message was sent or that an appointment was scheduled.

For example:

Clinical questions are routed to clinical review.
Same-day scheduling requests say no appointment has been changed or confirmed.
Referral acknowledgements say the team will review intake details, benefits status, and availability.
Missing-paperwork replies ask for required intake details before proceeding.
Spanish-language requests receive a Spanish draft acknowledgement.
Notable workflow choices
Safeguarding

If a message contains possible harm, abuse, neglect, or unsafe caregiving language, the agent:

classifies it as safeguarding
assigns urgency P0
looks up safeguarding policy
creates a same-hour clinical lead task
creates a P0 escalation
drafts only a neutral acknowledgement

The agent does not provide investigative advice.

Out-of-network insurance

If insurance verification returns out-of-network, expired, or unknown coverage, the agent avoids slot holds and routes the item to billing or intake for coverage review.

For example, a Kaiser HMO referral is routed to billing for a benefits conversation before any slot hold is considered.

Missing paperwork

If a referral is missing critical intake information such as DOB/age, guardian contact, payer, or member ID, the agent classifies it as missing_paperwork.

The agent does not hold a slot for incomplete referrals. It creates an intake task and drafts a response requesting the missing information.

Existing patient match and guardian verification

If search_patient finds an existing patient but the incoming contact does not appear to match the guardian on file, the agent creates a human verification task and avoids slot holds.

This is intended to reduce the risk of acting on a request before staff verifies patient identity and guardian/contact relationship.

Language access

If a Spanish-language need is detected, the agent looks up the language access policy, searches for Spanish-capable providers when finding slots, and drafts the acknowledgement in Spanish.

Failure modes and production evaluation

Important failure modes I considered:

1. Missed safeguarding concern

A missed safeguarding cue would be the highest-risk failure. I added deterministic keyword-based safety overrides so that possible harm, abuse, neglect, or unsafe caregiving language is escalated to P0 even if the LLM classifies the item differently.

2. Over-escalation

Overusing P0 can create alert fatigue. The agent only uses P0 for safeguarding-like concerns and uses P1 for same-day operational scheduling issues.

3. Clinical advice leakage

Automated systems should not provide clinical advice over message. The agent routes clinical questions to clinician review and drafts a safe response that offers review, screening, or evaluation as next steps.

4. Unsafe scheduling behavior

The agent never schedules appointments. It may call find_slots or create a hold_slot, but only as a pending-review action. Draft replies explicitly say no appointment has been scheduled, changed, or confirmed.

5. Slot holds with incomplete intake

The agent avoids slot holds when critical intake information is missing, when insurance is out-of-network/expired/unknown, or when guardian/contact verification is needed.

6. Insurance workflow errors

The agent uses verify_insurance and routes out-of-network or expired coverage to billing before considering any slot hold.

7. Identity and guardian mismatch risk

The agent uses search_patient to identify existing patient matches. If the incoming contact does not appear to match the guardian on file, the agent requires human verification before outreach or slot confirmation.

8. LLM extraction or formatting failure

The model may return malformed JSON or markdown-wrapped JSON. The agent handles markdown-wrapped JSON and falls back to deterministic extraction if parsing fails.

9. Hidden input variants

The visible examples informed the workflow design, but I avoided hardcoding item IDs or output paths. The agent uses reusable extraction, classification, safety, and tool-selection logic so it can handle similar synthetic variants.

In a production evaluation, I would track:

classification accuracy
safeguarding recall
P0/P1 calibration precision
missing-information extraction accuracy
inappropriate clinical advice rate
inappropriate slot-hold rate
tool-call relevance
human reviewer override rate
LLM fallback rate
trace completeness
latency and cost per batch
What I chose not to build, and why

Given the suggested two-hour time box, I focused on the core triage workflow and did not build:

A full human-review UI
A persistent database
Real EHR integration
Real scheduling integration
Real messaging integration
Real PHI handling
OCR or fax attachment parsing
A full RAG system over policies
A broad automated test suite
Advanced multilingual workflows beyond Spanish acknowledgement and Spanish-capable provider matching

I prioritized safe triage judgment, tool orchestration, schema-valid output, auditability, and clear human handoff.

What I would do with another 4 hours

With another 4 hours, I would improve the prototype in these areas:

1. Evaluation set

I would add a small synthetic eval suite covering:

indirect safeguarding language
urgent but non-P0 parent messages
same-day cancellation variants
incomplete referrals
out-of-network insurance
expired insurance
unknown insurance
existing patient and guardian mismatch cases
Spanish-language requests
spam or FYI messages
2. Stronger structured extraction

I would add:

stricter JSON schema validation for LLM output
confidence scores per extracted field
source-text evidence for each extracted field
better DOB versus age normalization
better phone and email extraction
3. Better policy grounding

I would improve policy use by:

retrieving policy snippets dynamically
attaching policy references to rationale
testing draft replies for clinical advice leakage
adding policy-specific safety checks
4. Improved slot logic

I would improve slot handling by:

checking whether a slot matches family day/time preferences
avoiding holds when no slot matches required constraints
explaining why a slot was or was not held
ranking providers by discipline, language, age range, and availability
5. Human-review UI

I would build a small review interface showing:

sorted queue by urgency
original message beside extracted intake
tool trace
missing information
recommended next action
editable draft reply
approve/edit controls for staff
6. Observability

I would add:

structured logs
per-item latency
LLM fallback rate
tool failure rate
reviewer correction tracking
cost per batch
audit dashboards for safety-critical cases