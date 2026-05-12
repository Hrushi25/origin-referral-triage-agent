import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";

type LlmExtraction = {
  classification: Classification;
  urgency_hint: Urgency;
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: Discipline[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
  language: "en" | "es" | null;
  preferences: string | null;
  missing_info: string[];
  draft_reply: string | null;
  decision_rationale: string;
};

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function textOf(item: InboxItem): string {
  return `${item.channel}\n${item.sender}\n${item.subject}\n${item.body}\n${item.attachments.join(
    "\n",
  )}`.toLowerCase();
}

function normalizeClassification(value: unknown): Classification {
  const allowed: Classification[] = [
    "new_referral",
    "existing_patient_request",
    "scheduling",
    "clinical_question",
    "billing_question",
    "missing_paperwork",
    "provider_followup",
    "complaint",
    "safeguarding",
    "spam",
    "other",
  ];

  return allowed.includes(value as Classification)
    ? (value as Classification)
    : "other";
}

function normalizeUrgency(value: unknown): Urgency {
  const allowed: Urgency[] = ["P0", "P1", "P2", "P3"];
  return allowed.includes(value as Urgency) ? (value as Urgency) : "P2";
}

function normalizeDiscipline(value: unknown): Discipline[] | null {
  const allowed: Discipline[] = ["SLP", "OT", "PT"];

  if (Array.isArray(value)) {
    const disciplines = value.filter((entry): entry is Discipline =>
      allowed.includes(entry as Discipline),
    );
    return disciplines.length > 0 ? disciplines : null;
  }

  if (allowed.includes(value as Discipline)) {
    return [value as Discipline];
  }

  return null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function cleanExtraction(raw: Partial<LlmExtraction>): LlmExtraction {
  return {
    classification: normalizeClassification(raw.classification),
    urgency_hint: normalizeUrgency(raw.urgency_hint),
    child_name: safeString(raw.child_name),
    dob_or_age: safeString(raw.dob_or_age),
    parent_contact: safeString(raw.parent_contact),
    discipline: normalizeDiscipline(raw.discipline),
    diagnosis_or_concern: safeString(raw.diagnosis_or_concern),
    payer: safeString(raw.payer),
    member_id: safeString(raw.member_id),
    language: raw.language === "es" ? "es" : "en",
    preferences: safeString(raw.preferences),
    missing_info: safeStringArray(raw.missing_info),
    draft_reply: safeString(raw.draft_reply),
    decision_rationale:
      safeString(raw.decision_rationale) ||
      "The item was triaged using structured extraction, safety rules, and tool-backed workflow decisions.",
  };
}


function parseJsonFromModel(text: string): Partial<LlmExtraction> {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned) as Partial<LlmExtraction>;
}

async function extractWithLlm(item: InboxItem): Promise<LlmExtraction | null> {
  if (!anthropic) return null;

  const prompt = `
You are an intake triage assistant for Cedar Kids Therapy, a pediatric SLP/OT/PT practice.

Extract structured information from the inbox item and return JSON only.

Rules:
- Return only valid JSON. No markdown.
- Do not provide clinical advice.
- Do not say a message was sent.
- Do not say an appointment was scheduled.
- Use classification exactly from:
  new_referral, existing_patient_request, scheduling, clinical_question, billing_question,
  missing_paperwork, provider_followup, complaint, safeguarding, spam, other.
- Use urgency exactly from: P0, P1, P2, P3.
- P0 is only safeguarding, imminent harm, abuse/neglect, or mandated-reporter escalation.
- P1 is same-day operational issue.
- Default to P2.
- discipline must be an array containing any of: SLP, OT, PT, or null.
- parent_contact should combine useful parent/guardian contact details if available.
- dob_or_age may contain either DOB or age.
- missing_info should list intake fields needed before next action.

Inbox item:
${JSON.stringify(item, null, 2)}

Return JSON with this exact shape:
{
  "classification": "new_referral",
  "urgency_hint": "P2",
  "child_name": string|null,
  "dob_or_age": string|null,
  "parent_contact": string|null,
  "discipline": ["SLP"]|["OT"]|["PT"]|null,
  "diagnosis_or_concern": string|null,
  "payer": string|null,
  "member_id": string|null,
  "language": "en"|"es"|null,
  "preferences": string|null,
  "missing_info": string[],
  "draft_reply": string|null,
  "decision_rationale": string
}
`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1200,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    const parsed = parseJsonFromModel(text);
    return cleanExtraction(parsed);
  } catch (error) {
    console.error("LLM extraction failed for item", item.id);
    console.error(error);
    return null;
  }
}

function fallbackExtract(item: InboxItem): LlmExtraction {
  const text = textOf(item);

  let classification: Classification = "other";
  let urgency: Urgency = "P2";

  if (
    text.includes("rough") ||
    text.includes("abuse") ||
    text.includes("neglect") ||
    text.includes("unsafe") ||
    text.includes("harm")
  ) {
    classification = "safeguarding";
    urgency = "P0";
  } else if (
    text.includes("today") &&
    (text.includes("reschedule") || text.includes("cancel"))
  ) {
    classification = "scheduling";
    urgency = "P1";
  } else if (
    text.includes("reschedule") ||
    text.includes("cancel") ||
    text.includes("appointment")
  ) {
    classification = "scheduling";
  } else if (
    text.includes("should i worry") ||
    text.includes("is this normal") ||
    text.includes("normal for")
  ) {
    classification = "clinical_question";
  } else if (
    text.includes("incomplete") ||
    text.includes("missing") ||
    text.includes("blank")
  ) {
    classification = "missing_paperwork";
  } else if (
    text.includes("referral") ||
    text.includes("evaluation") ||
    text.includes(" eval")
  ) {
    classification = "new_referral";
  }

  const discipline: Discipline[] | null =
    text.includes("speech") || text.includes("slp")
      ? ["SLP"]
      : text.includes("occupational") || text.includes(" ot ")
        ? ["OT"]
        : text.includes("physical") || text.includes(" pt ")
          ? ["PT"]
          : null;

  const payer =
    text.includes("kaiser")
      ? "Kaiser"
      : text.includes("aetna")
        ? "Aetna"
        : text.includes("bcbs") || text.includes("blue cross")
          ? "BCBS"
          : text.includes("medicaid")
            ? "Medicaid"
            : null;

  return {
    classification,
    urgency_hint: urgency,
    child_name: null,
    dob_or_age: null,
    parent_contact: item.sender || null,
    discipline,
    diagnosis_or_concern: null,
    payer,
    member_id: null,
    language: text.includes("spanish") || text.includes("español") ? "es" : "en",
    preferences: null,
    missing_info: [],
    draft_reply: null,
    decision_rationale:
      "Fallback rule-based extraction was used because LLM extraction was unavailable.",
  };
}


function hasCriticalMissingReferralInfo(extraction: LlmExtraction): boolean {
  const missingDobOrAge = !extraction.dob_or_age;
  const missingParentContact = !extraction.parent_contact;
  const missingPayer = !extraction.payer;
  const missingMemberId = !extraction.member_id;

  return (
    extraction.classification === "new_referral" &&
    (missingDobOrAge || missingParentContact || missingPayer || missingMemberId)
  );
}

function hasMinimumIntakeForSlotHold(extraction: LlmExtraction): boolean {
  return Boolean(
    extraction.child_name &&
      extraction.dob_or_age &&
      extraction.parent_contact &&
      extraction.payer &&
      extraction.member_id,
  );
}



function applySafetyOverrides(
  item: InboxItem,
  extraction: LlmExtraction,
): LlmExtraction {
  const text = textOf(item);

  if (
    text.includes("rough") ||
    text.includes("abuse") ||
    text.includes("neglect") ||
    text.includes("unsafe") ||
    text.includes("harm")
  ) {
    return {
      ...extraction,
      classification: "safeguarding",
      urgency_hint: "P0",
      missing_info: [
        "Full child name and DOB if not already available",
        "Safe callback number",
        "Current guardian/contact information",
      ],
      decision_rationale:
        "The message contains possible harm, abuse, neglect, or unsafe caregiving language, so deterministic safety rules override the item to P0 safeguarding review.",
    };
  }

  if (
    text.includes("today") &&
    (text.includes("reschedule") || text.includes("cancel"))
  ) {
    return {
      ...extraction,
      classification: "scheduling",
      urgency_hint: "P1",
      decision_rationale:
        "The message describes a same-day cancellation or reschedule request, so deterministic rules classify it as a P1 operational scheduling issue.",
    };
  }

  if (hasCriticalMissingReferralInfo(extraction)) {
    return {
      ...extraction,
      classification: "missing_paperwork",
      urgency_hint: "P2",
      decision_rationale:
        "The item appears to be a referral but is missing critical intake fields such as DOB/age, guardian contact, payer, or member ID. Deterministic guardrails route it to missing paperwork before any slot hold or scheduling workflow.",
    };
  }


  return {
    ...extraction,
    urgency_hint: extraction.urgency_hint || "P2",
  };
}

function toExtractedIntake(extraction: LlmExtraction): ExtractedIntake {
  return {
    child_name: extraction.child_name,
    dob_or_age: extraction.dob_or_age,
    parent_contact: extraction.parent_contact,
    discipline: extraction.discipline,
    diagnosis_or_concern: extraction.diagnosis_or_concern,
    payer: extraction.payer,
    member_id: extraction.member_id,
  };
}

function buildDraft(extraction: LlmExtraction): string {
  if (extraction.classification === "safeguarding") {
    return "Thank you for reaching out. Your message has been flagged for prompt review by our clinical leadership team. A staff member will follow up as soon as possible.";
  }

  if (extraction.classification === "clinical_question") {
    return "Thank you for reaching out. We cannot assess clinical concerns over message, but our clinical team can review the concern and help determine whether a screening or evaluation is appropriate. A staff member will follow up with next steps.";
  }

  if (extraction.classification === "missing_paperwork") {
    return "Thank you for the referral. We need a few additional details before intake can proceed, such as the child’s DOB, guardian contact information, insurance details, and member ID if available. Our team will follow up to collect the missing information. No appointment has been scheduled yet.";
  }

  if (extraction.language === "es") {
    return "Gracias por comunicarse con Cedar Kids Therapy. Recibimos su solicitud y nuestro equipo revisará los detalles de admisión, beneficios y disponibilidad. Un miembro del personal se comunicará con usted con los próximos pasos. Aún no se ha programado ninguna cita.";
  }

  if (extraction.classification === "scheduling") {
    return "Thank you for letting us know. Our front desk team will review the schedule and follow up with available options. No appointment has been changed or confirmed yet.";
  }

  if (extraction.classification === "new_referral") {
    return "Thank you for reaching out to Cedar Kids Therapy. We received the referral information and our team will review the intake details, benefits status, and appointment availability. A staff member will follow up with next steps. No appointment has been scheduled yet.";
  }

  if (extraction.classification === "existing_patient_request") {
    return "Thank you for reaching out. Our team will review the patient record and request details before taking action. A staff member will follow up with next steps.";
  }

  if (extraction.classification === "billing_question") {
    return "Thank you for reaching out. Our billing team will review the insurance or payment question and follow up with next steps.";
  }

  return (
    extraction.draft_reply ||
    "Thank you for reaching out to Cedar Kids Therapy. Our team will review your message and follow up with next steps."
  );
}

function buildNextAction(
  extraction: LlmExtraction,
  insuranceStatus?: "in_network" | "out_of_network" | "expired" | "unknown" | null,
): string {
  switch (extraction.classification) {
    case "safeguarding":
      return "Clinical lead should review same-hour for safeguarding or mandated-reporter concern before any parent-facing follow-up.";
    case "scheduling":
      return "Front desk should review the same-day scheduling issue and contact the family with available options.";
    case "clinical_question":
      return "Clinical team should review the question and determine whether a screening or evaluation is appropriate.";
    case "missing_paperwork":
      return "Intake team should request missing required referral information before proceeding.";
      case "new_referral":
        if (insuranceStatus === "out_of_network") {
          return "Billing should complete a benefits conversation for the out-of-network payer before intake considers any slot hold.";
        }
      
        if (insuranceStatus === "expired") {
          return "Billing should resolve expired coverage before intake considers any slot hold.";
        }
      
        if (insuranceStatus === "unknown") {
          return "Intake or billing should clarify insurance coverage before any slot hold or scheduling workflow.";
        }
      
        return "Intake team should review referral details, insurance result, and any pending-review slot hold before contacting the family.";
    case "existing_patient_request":
      return "Staff should verify patient identity and guardian relationship before taking action.";
    case "billing_question":
      return "Billing team should review insurance or payment details and follow up with the family.";
    default:
      return "Staff should review the message and determine the appropriate next step.";
  }
}

function dueInHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function firstDiscipline(extraction: LlmExtraction): Discipline | undefined {
  return extraction.discipline?.[0];
}

function channelForDraft(item: InboxItem): "portal" | "email" | "phone" {
  if (item.channel === "portal_message") return "portal";
  if (item.channel === "voicemail_transcript") return "phone";
  return "email";
}

function draftRecipient(item: InboxItem, extraction: LlmExtraction): string {
  return extraction.parent_contact || item.sender || "unknown recipient";
}

async function processItem(item: InboxItem): Promise<ItemOutput> {
  const llmExtraction = await extractWithLlm(item);
  const extraction = applySafetyOverrides(
    item,
    llmExtraction ?? fallbackExtract(item),
  );

  const taskIds: string[] = [];
  let escalation: ItemOutput["escalation"] = null;
  let draftReply: string | null = null;
  let insuranceStatus:
  | "in_network"
  | "out_of_network"
  | "expired"
  | "unknown"
  | null = null;
  let existingPatientMatch = false;
  let guardianVerificationNeeded = false;

  return withItemContext(item.id, async () => {
    if (extraction.classification === "safeguarding") {
      await lookup_policy({ topic: "safeguarding" });

      await escalate({
        item_id: item.id,
        severity: "P0",
        reason:
          "Message contains a possible safeguarding concern requiring immediate clinical leadership review.",
      });

      escalation = {
        severity: "P0",
        reason:
          "Possible safeguarding concern requiring same-hour clinical leadership review.",
      };

      const task = await create_task({
        assignee: "clinical_lead",
        title: "Same-hour safeguarding review",
        due: dueInHours(1),
        notes:
          "Review this inbox item for possible safeguarding or mandated-reporter concern. Do not send automated clinical or investigative advice.",
      });

      taskIds.push(task.data.task_id);
    }

    if (extraction.classification === "clinical_question") {
      await lookup_policy({ topic: "clinical_advice" });

      const task = await create_task({
        assignee: "clinical_lead",
        title: "Review clinical question",
        due: dueInHours(24),
        notes:
          "Parent asked a clinical question. Clinician should review and determine whether screening or evaluation is appropriate.",
      });

      taskIds.push(task.data.task_id);
    }

    if (extraction.classification === "scheduling") {
      await lookup_policy({ topic: "scheduling" });
      await lookup_policy({ topic: "cancellation" });

      if (extraction.child_name || extraction.dob_or_age) {
        await search_patient({
          name: extraction.child_name || undefined,
          dob: extraction.dob_or_age || undefined,
        });
      }

      const discipline = firstDiscipline(extraction);
      if (discipline) {
        const slots = await find_slots({
          discipline,
          preferences: extraction.preferences || undefined,
        });

        if (slots.data[0]) {
          await hold_slot({
            slot_id: slots.data[0].slot_id,
            patient_ref: extraction.child_name || item.id,
          });
        }
      }

      const task = await create_task({
        assignee: "front_desk",
        title: "Same-day scheduling follow-up",
        due: dueInHours(extraction.urgency_hint === "P1" ? 2 : 24),
        notes:
          "Review cancellation/reschedule request and contact family with available options. Do not confirm appointment changes without staff review.",
      });

      taskIds.push(task.data.task_id);
    }

    if (
      extraction.classification === "new_referral" ||
      extraction.classification === "existing_patient_request"
    ) {
      if (extraction.child_name || extraction.dob_or_age) {
        const patientSearch = await search_patient({
          name: extraction.child_name || undefined,
          dob: extraction.dob_or_age || undefined,
        });
      
        existingPatientMatch = patientSearch.data.length > 0;
      
        guardianVerificationNeeded = patientSearch.data.some((patient) => {
          const knownGuardian = patient.guardian_name.toLowerCase();
          const incomingContact = (extraction.parent_contact || "").toLowerCase();
      
          return incomingContact.length > 0 && !incomingContact.includes(knownGuardian);
        });
      }

      if (extraction.payer || extraction.member_id) {
        const insurance = await verify_insurance({
          payer: extraction.payer || undefined,
          member_id: extraction.member_id || undefined,
        });

        insuranceStatus = insurance.data.status;

        if (
          insuranceStatus === "out_of_network" ||
          insuranceStatus === "expired" ||
          insuranceStatus === "unknown"
        ) {
          await lookup_policy({ topic: "insurance" });
        }
      }

      if (extraction.language === "es") {
        await lookup_policy({ topic: "language_access" });
      }

      const discipline = firstDiscipline(extraction);
      if (
        discipline &&
        hasMinimumIntakeForSlotHold(extraction) &&
        !guardianVerificationNeeded &&
        insuranceStatus !== "out_of_network" &&
        insuranceStatus !== "expired" &&
        insuranceStatus !== "unknown"
      ) {
        const slots = await find_slots({
          discipline,
          preferences: extraction.preferences || undefined,
          language: extraction.language === "es" ? "es" : undefined,
        });
      
        if (slots.data[0]) {
          await hold_slot({
            slot_id: slots.data[0].slot_id,
            patient_ref: extraction.child_name || item.id,
          });
        }
      }

      const task = await create_task({
        assignee:
          insuranceStatus === "out_of_network" || insuranceStatus === "expired"
            ? "billing"
            : "intake",
        title: "Review referral intake",
        due: dueInHours(24),
        notes: guardianVerificationNeeded
          ? "Existing patient match found, but incoming contact may not match the guardian on file. Verify guardian/contact relationship before outreach, slot confirmation, or intake action."
          : existingPatientMatch
            ? "Existing patient match found. Verify patient identity, referral details, insurance result, and any pending slot hold before contacting the family."
            : "Review extracted referral details, insurance result, missing information, and any pending slot hold before contacting the family.",
      });

      taskIds.push(task.data.task_id);
    }

    if (extraction.classification === "missing_paperwork") {
      await lookup_policy({ topic: "service_lines" });

      const task = await create_task({
        assignee: "intake",
        title: "Request missing referral information",
        due: dueInHours(24),
        notes:
          "Referral is missing required intake information such as DOB/age, guardian contact, payer, member ID, discipline, or concern.",
      });

      taskIds.push(task.data.task_id);
    }

    if (
      extraction.classification === "billing_question" ||
      extraction.classification === "provider_followup" ||
      extraction.classification === "complaint" ||
      extraction.classification === "other"
    ) {
      const task = await create_task({
        assignee:
          extraction.classification === "billing_question"
            ? "billing"
            : "front_desk",
        title: "Review inbox item",
        due: dueInHours(24),
        notes:
          "Review item and route to the correct team. Agent did not identify a fully automatable workflow.",
      });

      taskIds.push(task.data.task_id);
    }

    if (extraction.classification !== "spam") {
      draftReply = buildDraft(extraction);

      await draft_message({
        recipient: draftRecipient(item, extraction),
        channel: channelForDraft(item),
        language: extraction.language === "es" ? "es" : "en",
        body: draftReply,
      });
    }

    return {
      item_id: item.id,
      classification: extraction.classification,
      urgency: extraction.urgency_hint,
      requires_human_review: true,
      extracted_intake: toExtractedIntake(extraction),
      missing_info: extraction.missing_info,
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: buildNextAction(extraction, insuranceStatus),
      draft_reply: draftReply,
      task_ids: taskIds,
      escalation,
      decision_rationale: extraction.decision_rationale,
    };
  });
}

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const outputs: ItemOutput[] = [];

  for (const item of inbox) {
    outputs.push(await processItem(item));
  }

  return outputs;
}