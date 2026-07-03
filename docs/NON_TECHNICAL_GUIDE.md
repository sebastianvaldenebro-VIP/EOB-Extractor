# EOB Extractor — Non-Technical Guide

**Date:** 2026-06-08  
**Audience:** Operations, compliance, legal, clinical operations

---

## What Does This System Do?

When a healthcare provider uploads an Explanation of Benefits (EOB) document to ClickUp, EOB Extractor automatically reads the PDF and pulls out the insurance company's contact information — specifically the phone number, email, and fax number used for arbitration and appeals.

This data is then stored and cross-checked against our existing database of insurance contacts. If a new insurance company is found, or if the contact details have changed, the team is notified so a human can review and confirm the information.

The goal is to eliminate manual data entry and ensure that arbitration contact details are always up-to-date.

---

## What Data Does It Process?

**The system processes EOB documents.** These documents tell us:
- Which insurance company issued the EOB
- The insurance company's mailing address
- The phone number, fax, and email for appeals and arbitration

**The system does NOT capture or store:**
- Patient names
- Member IDs
- Dates of birth
- Social Security Numbers
- Claim details
- Any other patient-level information

The extracted data is about the **insurance company**, not the patient. This is by design — the system extracts only the contact fields needed for arbitration workflows.

---

## How Does a Document Get Processed?

1. A document is uploaded to a designated folder in the connected S3 storage (via the ClickUp integration)
2. The system detects the upload automatically — no manual trigger needed
3. The document passes through several automated checks:
   - Is it a valid PDF?
   - Is it an EOB (not a different type of document)?
   - What insurance company is it from?
   - What are the arbitration contact details?
4. The extracted data is validated and compared to known contacts
5. Results are stored and the team is notified if human review is needed

The entire process typically takes under 5 minutes per document.

---

## What Happens When the System Is Not Sure?

The AI model assigns a confidence score to every extraction (0–100%). If the score is:

| Score | Meaning | What Happens |
|-------|---------|-------------|
| 85%–100% | High confidence | Automatically stored; no review needed |
| 50%–84% | Medium confidence | Stored but flagged for human review |
| Below 50% | Low confidence | Stored as failed; no contact record created |

When a document is flagged for review, it appears in the review queue and the team receives a notification via SNS alert.

---

## What Happens When a New Insurance Company Is Found?

If the extracted insurance company does not exist in our database:
1. A new contact record is created automatically
2. The operations team receives an alert via the `eob-extractor-review-alerts` notification channel
3. A human should verify the new contact information is accurate

---

## What Happens When Contact Details Have Changed?

If an insurance company is already in our database but the extracted contact details differ:
1. A mismatch alert is sent to the operations team
2. The extraction is flagged for human review (REVIEW_PENDING status)
3. A human reviews which version is correct and updates the record if needed

---

## Compliance and Data Protection

**HIPAA:** Patient Protected Health Information (PHI) is never stored, logged, or transmitted by this system. The system only handles insurance company data.

**Encryption:** All stored data is encrypted using dedicated encryption keys (AWS KMS). Encryption keys rotate automatically every year.

**Audit trail:** All system activity is logged and stored for 6 years in a tamper-proof audit bucket. Audit logs cannot be modified or deleted.

**Access:** Only the minimum necessary access is granted to each component of the system. No single service can access data it does not need.

---

## Alerts and Notifications

The team receives two categories of alerts:

**Operations alerts** (`eob-extractor-ops-alerts`):
- Pipeline failures requiring engineering intervention
- Queue depth anomalies

**Review alerts** (`eob-extractor-review-alerts`):
- New insurance company discovered
- Insurance contact details mismatch detected

---

## Known Limitations (Open Items)

| Issue | Impact | Status |
|-------|--------|--------|
| Lambda functions are not network-isolated (not VPC-attached) | Security posture gap — HIGH priority | Engineering backlog |
| Review queue has no safety net for failed processing | Low-confidence items could be lost if the review consumer crashes | Engineering backlog (add DLQ) |
| Bedrock inference requests do not record which user triggered the extraction | Audit trail gap for AI decisions | Engineering backlog |
| The original PDF source bucket is not managed by Infrastructure as Code | Manual configuration — change history not tracked | Low priority |

---

## Who to Contact

| Question | Contact |
|----------|---------|
| Pipeline failure or alert | Engineering on-call (via `eob-extractor-ops-alerts` subscriber list) |
| Review queue backlog | Clinical operations team |
| Compliance or HIPAA questions | Compliance officer |
| Insurance contact data accuracy | Operations team |
| System architecture or code | Engineering team |
