# EOB Extractor — Data Dictionary

**Date:** 2026-06-08

---

## 1. DynamoDB Table: `eob-extractions`

### Access Pattern Summary

| Access Pattern | Key Used |
|---------------|----------|
| Get all extractions for a task | `PK = TASK#{taskId}` |
| Get specific extraction | `PK = TASK#{taskId}`, `SK = EOB#{extractionId}` |
| List by status + time | GSI-Status: `status = REVIEW_PENDING`, sorted by `extractedAt` |
| Deduplication check by S3 key | GSI-S3Key: `s3Key = {key}` |
| Future: lookup by claim number | GSI-ClaimNumber: `claimNumber` (currently inert — field not yet populated) |
| Future: analytics by insurer | GSI-Insurer: `insurerName` (currently inert — field not yet populated) |

### Table Configuration

| Property | Value |
|----------|-------|
| Billing mode | PAY_PER_REQUEST |
| Partition key | `PK` (String) |
| Sort key | `SK` (String) |
| Encryption | CUSTOMER_MANAGED — `alias/eob-extractor/phi` |
| Point-in-time recovery | Enabled |
| DynamoDB Streams | NEW_AND_OLD_IMAGES |
| TTL attribute | `ttl` (reserved; not currently set by handlers) |
| Deletion protection | Enabled in production; disabled in sandbox |

### Item Schema

| Attribute | Type | PK/SK/GSI | Required | PHI | Description |
|-----------|------|-----------|----------|-----|-------------|
| `PK` | String | PK | Yes | No | `TASK#{taskId}` — partition key |
| `SK` | String | SK | Yes | No | `EOB#{extractionId}` — sort key |
| `extractionId` | String | — | Yes | No | ULID generated at entity creation |
| `taskId` | String | — | Yes | No | ClickUp task ID from S3 key path |
| `s3Key` | String | GSI-S3Key PK | Yes | No | Full S3 object key (contains taskId, not patient identifiers) |
| `s3VersionId` | String | — | No | No | S3 object version ID at time of processing; null if versioning off |
| `status` | String | GSI-Status PK | Yes | No | `EXTRACTED` \| `REVIEW_PENDING` \| `FAILED` |
| `confidenceScore` | Number | — | Yes | No | 0.0–1.0; float from Bedrock extraction response |
| `insuranceName` | String | — | No | No | Insurance company name (e.g., "Blue Cross Blue Shield of Illinois") |
| `insuranceIdentifier` | String | — | No | No | Payer ID or plan number |
| `address` | String | — | No | **No** | Insurance company mailing address (street) — not patient address |
| `city` | String | — | No | No | Insurance company city |
| `state` | String | — | No | No | Insurance company state abbreviation |
| `zipCode` | String | — | No | No | Insurance company ZIP code |
| `locationState` | String | — | No | No | State where plan is regulated (may differ from mailing address) |
| `arbitrationPhone` | String | — | No | No | Phone for appeals/arbitration |
| `arbitrationFax` | String | — | No | No | Fax for appeals/arbitration |
| `arbitrationEmail` | String | — | No | No | Email for appeals/arbitration |
| `rawExtractionJson` | String | — | Yes | No | JSON-stringified `EobExtractionResponse` — full Zod-validated output |
| `modelId` | String | — | Yes | No | Bedrock model ID that produced the extraction |
| `classificationResult` | String | — | No | No | JSON-stringified classification output from `eob-classify-eob` |
| `extractedAt` | String | GSI-Status SK, GSI-ClaimNumber SK, GSI-Insurer SK | Yes | No | ISO-8601 timestamp of extraction |
| `processingDurationMs` | Number | — | Yes | No | End-to-end processing time in milliseconds |
| `correlationId` | String | — | Yes | No | ULID; ties all log events for a single execution together |
| `claimNumber` | String | GSI-ClaimNumber PK | No | No | Not populated by any handler yet — index is currently inert |
| `insurerName` | String | GSI-Insurer PK | No | No | Not populated by any handler yet — index is currently inert |
| `ttl` | Number | — | No | No | Unix epoch expiry; reserved for future data lifecycle; currently not set |

### Global Secondary Indexes

| Index | Partition Key | Sort Key | Projection | Purpose |
|-------|--------------|----------|-----------|---------|
| `GSI-Status` | `status` (S) | `extractedAt` (S) | ALL | Query REVIEW_PENDING or FAILED extractions by time |
| `GSI-S3Key` | `s3Key` (S) | — | KEYS_ONLY | O(1) deduplication check before starting new execution |
| `GSI-ClaimNumber` | `claimNumber` (S) | `extractedAt` (S) | ALL | Future: lookup by claim number (index currently inert) |
| `GSI-Insurer` | `insurerName` (S) | `extractedAt` (S) | ALL | Future: analytics by insurer (index currently inert) |

### PHI Assessment — `eob-extractions`

All fields in this table store **insurance company contact information**, not patient-level identifiers. The `address`, `arbitrationPhone`, `arbitrationFax`, and `arbitrationEmail` fields refer to the insurance company, not to any individual. There is no HIPAA Safe Harbor identifier stored in this table.

**No patient PHI is stored in `eob-extractions`.**

---

## 2. DynamoDB Table: `Insurance-Arbitration-contacts`

**Status:** External, pre-existing table. EOB Extractor reads and conditionally writes. Not CDK-managed by this stack.  
**Audit finding #007:** PITR not confirmed enabled; no audit trail for reads from this table.

### Table Configuration

| Property | Value |
|----------|-------|
| Billing mode | Unknown (pre-existing) |
| Partition key | `Insurance` (String) |
| Encryption | Unknown (pre-existing) |
| PITR | Not confirmed (Audit #007) |

### Item Schema

| Attribute | Type | PK/GSI | Description |
|-----------|------|--------|-------------|
| `Insurance` | String | PK | Composite key: `*{locationState} - {insuranceName}` (e.g., `*IL - Blue Cross Blue Shield`) |
| `InsuranceName` | String | GSI-InsuranceName-LocationState PK | Plain insurance company name |
| `LocationState` | String | GSI-InsuranceName-LocationState SK | State abbreviation where plan is regulated |
| `Address` | String | — | Insurance company street address |
| `City` | String | — | City |
| `State` | String | — | State abbreviation |
| `ZipCode` | String | — | ZIP code |
| `ArbitrationPhone` | String | — | Arbitration/appeals phone |
| `ArbitrationFax` | String | — | Arbitration/appeals fax |
| `ArbitrationEmail` | String | — | Arbitration/appeals email |

### GSI

| Index | Partition Key | Sort Key | Used By |
|-------|--------------|----------|---------|
| `GSI-InsuranceName-LocationState` | `InsuranceName` (S) | `LocationState` (S) | `eob-lookup-insurance` QueryCommand |

### Write Behavior (from eob-lookup-insurance)

- `createContact` uses `ConditionExpression: 'attribute_not_exists(Insurance)'` — safe concurrent write guard
- If `ConditionalCheckFailedException` is thrown (concurrent write already created the record), the error is silently swallowed as a no-op
- New contacts trigger a publish to `eob-extractor-review-alerts` SNS topic

### Comparison Fields (Mismatch Detection)

When an existing contact is found, these fields are compared (normalized: `.trim().toLowerCase()`):

| Extracted Field | Contact Field |
|----------------|--------------|
| `address` | `Address` |
| `arbitration_email` | `ArbitrationEmail` |
| `arbitration_fax` | `ArbitrationFax` |
| `arbitration_phone` | `ArbitrationPhone` |
| `city` | `City` |
| `state` | `State` |
| `zip_code` | `ZipCode` |

Note: Empty extracted fields with empty contact fields are treated as equal (both sides must be non-empty to compare).

---

## 3. S3 Key Structure

### Source PDFs — `bucket-specialops` / `bucket-specialops-sandbox`

```
clickup/{taskId}/{filename}.pdf
```

| Segment | Description |
|---------|-------------|
| `clickup/` | Fixed prefix — required by S3 event notification filter |
| `{taskId}` | ClickUp task ID; used as the extraction's `taskId` |
| `{filename}.pdf` | Original filename; never logged (sanitized to `clickup/{taskId}/*` in logs) |

**S3 key sanitization:** `sanitizeS3Key()` in `audit-logger.ts` strips everything after the last `/`, replacing the filename with `*`. Logged S3 keys are always of the form `clickup/{taskId}/*`.

### Quarantine Path (from eob-validate-pdf)

```
quarantine/{taskId}/{filename}.pdf
```

Invalid PDFs are moved to the `quarantine/` prefix instead of being processed.

### Audit Logs — `eob-extractor-audit-{account}`

| Path | Content |
|------|---------|
| CloudWatch export path | Structured JSON log events exported from `/aws/lambda/eob-extractor` and `/aws/stepfunctions/eob-extractor` |

---

## 4. Zod Schema — Bedrock Extraction Output (`eob-extraction.schema.ts`)

```typescript
z.object({
  is_eob:               z.boolean(),
  confidence_score:     z.number().min(0).max(1),
  extraction_notes:     z.nullable(z.string()),
  insurance_name:       z.nullable(z.string()),
  insurance_identifier: z.nullable(z.string()),
  address:              z.nullable(z.string()),
  city:                 z.nullable(z.string()),
  state:                z.nullable(z.string()),
  zip_code:             z.nullable(z.string()),
  location_state:       z.nullable(z.string()),
  arbitration_phone:    z.nullable(z.string()),
  arbitration_fax:      z.nullable(z.string()),
  arbitration_email:    z.nullable(z.string()),
})
```

Schema failures do not abort the pipeline. If Zod parse fails, a zeroed extraction with `confidence_score=0.1` is returned and `isValid=false` is propagated to subsequent steps.

---

## 5. PHI Field Blocklist (`audit-logger.ts`)

The following field names are blocked from appearing in any log output. If passed to `logEvent()`, their values are replaced with `[REDACTED]`:

```
patientname, patient_name, memberid, member_id,
subscribername, subscriber_name, ssn, socialsecuritynumber,
social_security_number, dateofbirth, date_of_birth, dob,
address, phonenumber, phone_number, email,
accountnumber, account_number
```

**Audit finding #004 (MEDIUM):** This blocklist does not cover all 18 HIPAA Safe Harbor identifiers. Missing categories include: fax numbers, medical record numbers, health plan beneficiary numbers, certificate/license numbers, vehicle identifiers, device identifiers, URLs, IP addresses, and biometric identifiers. Expansion required before any handler change that might introduce new PHI fields.

**Note on `address`:** The `address` key is in the blocklist as a precaution. The `address` stored in `eob-extractions` is the insurance company's address, not a patient address. If any future handler passes a field named `address` to `logEvent()`, it will be redacted regardless.
