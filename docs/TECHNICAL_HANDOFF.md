# EOB Extractor — Technical Handoff

**Project:** eob-extractor  
**Date:** 2026-06-08  
**Status:** Production-ready (audit findings tracked below)  
**Owner:** engineering  
**Compliance:** HIPAA

---

## 1. Overview

EOB Extractor is a serverless pipeline that automatically extracts insurance company and arbitration contact information from Explanation of Benefits (EOB) PDF documents. It ingests PDFs uploaded to S3, classifies them using Amazon Bedrock, extracts structured data, validates it against a Zod schema and business rules, cross-references an existing insurance contact database, and stores results in DynamoDB. Low-confidence extractions are routed to a human review queue.

**Purpose:** Remove manual data-entry for arbitration contact discovery across EOB documents uploaded via the ClickUp integration.

---

## 2. Repository Structure

```
eob-extractor/
├── src/
│   ├── domain/
│   │   ├── entities/eob-extraction.ts          # EobExtraction aggregate root
│   │   ├── repositories/eob-extraction.repository.ts
│   │   └── value-objects/
│   │       ├── confidence-score.ts             # HIGH>=0.85, MEDIUM>=0.50, LOW<0.50
│   │       └── extraction-status.ts            # EXTRACTED | REVIEW_PENDING | FAILED
│   ├── application/
│   │   ├── prompts/
│   │   │   ├── classify-prompt.ts              # EOB_CLASSIFICATION_SYSTEM_PROMPT
│   │   │   ├── extract-prompt.ts               # buildExtractionUserPrompt()
│   │   │   └── system-prompt.ts
│   │   ├── schemas/eob-extraction.schema.ts    # Zod v4 output schema
│   │   └── validation/business-rules.ts
│   ├── infrastructure/
│   │   ├── bedrock/
│   │   │   ├── bedrock-client.ts               # invokeModel(), InvokeModelCommand
│   │   │   └── model-fallback.ts               # CLASSIFY_CHAIN, EXTRACT_CHAIN
│   │   ├── logging/audit-logger.ts             # PHI_FIELDS blocklist, sanitizeS3Key()
│   │   ├── persistence/dynamodb-eob.repository.ts
│   │   └── storage/s3-pdf-reader.ts
│   └── handlers/
│       ├── trigger.handler.ts                  # SQS → SFN start
│       ├── validate-pdf.handler.ts
│       ├── classify-eob.handler.ts
│       ├── extract-eob.handler.ts
│       ├── validate-data.handler.ts
│       ├── lookup-insurance.handler.ts
│       └── store-result.handler.ts
├── lib/
│   ├── eob-extractor-stack.ts                  # CDK root stack
│   └── constructs/
│       ├── storage.construct.ts                # KMS keys, DynamoDB, S3
│       ├── queuing.construct.ts                # SQS ingest/review/DLQ
│       ├── monitoring.construct.ts             # SNS topics, CloudWatch alarms
│       ├── extraction.construct.ts             # Lambda wiring + event sources
│       ├── pipeline-functions.ts               # 6 pipeline Lambda definitions
│       ├── extraction-state-machine.ts         # Step Functions definition
│       └── dashboard.construct.ts
└── test/
    └── unit/                                   # Vitest unit tests per handler
```

---

## 3. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 20.x |
| Language | TypeScript | ~5.9.3 |
| IaC | AWS CDK | 2.1112.0 |
| Schema validation | Zod | v4 (^4.3.6) |
| ID generation | ULID | ^3.0.2 |
| Test framework | Vitest | ^4.1.1 |
| Bundler | esbuild | ^0.27.4 |

---

## 4. AWS Resources Summary

| Service | Resource | Purpose |
|---------|----------|---------|
| Lambda (7) | eob-trigger | SQS consumer; starts SFN execution |
| Lambda | eob-validate-pdf | Validates PDF existence/format |
| Lambda | eob-classify-eob | Bedrock classify chain |
| Lambda | eob-extract-eob | Bedrock extract chain |
| Lambda | eob-validate-data | Zod + business-rule validation |
| Lambda | eob-lookup-insurance | Cross-ref Insurance-Arbitration-contacts |
| Lambda | eob-store-result | DynamoDB write + review queue |
| Step Functions | eob-extraction-pipeline | STANDARD; 15-min timeout; X-Ray; KMS logs |
| DynamoDB | eob-extractions | PAY_PER_REQUEST; KMS CMK; PITR; Streams |
| DynamoDB (ext) | Insurance-Arbitration-contacts | Pre-existing; read + conditional write |
| S3 (ext) | bucket-specialops / bucket-specialops-sandbox | PDF source; not CDK-managed |
| S3 | eob-extractor-audit-{account} | Audit logs; Object Lock COMPLIANCE; 6yr |
| SQS | eob-extractor-ingest | S3 events → trigger; DLQ after 3 retries |
| SQS | eob-extractor-review | Low-confidence review (⚠ no DLQ — TD-005) |
| SQS | eob-extractor-dlq | Dead letters; 14-day retention |
| SNS | eob-extractor-ops-alerts | Operational alerts |
| SNS | eob-extractor-review-alerts | New/mismatch insurance contact alerts |
| KMS | alias/eob-extractor/phi | DynamoDB + Lambda env encryption |
| KMS | alias/eob-extractor/audit | S3 audit + SFN log group encryption |
| Bedrock | us.anthropic.claude-haiku-4-5 | Classify primary |
| Bedrock | us.anthropic.claude-sonnet-4-20250514 | Classify fallback; Extract fallback 2 |
| Bedrock | us.anthropic.claude-sonnet-4-6 | Extract primary |

---

## 5. Environment Variables (per Lambda)

| Lambda | Env Var | Value |
|--------|---------|-------|
| eob-trigger | `STATE_MACHINE_ARN` | eob-extraction-pipeline ARN |
| eob-trigger | `TABLE_NAME` | eob-extractions |
| eob-validate-pdf | `BUCKET_NAME` | bucket-specialops[-sandbox] |
| eob-classify-eob | `BUCKET_NAME` | bucket-specialops[-sandbox] |
| eob-extract-eob | `BUCKET_NAME` | bucket-specialops[-sandbox] |
| eob-lookup-insurance | `CONTACTS_TABLE_NAME` | Insurance-Arbitration-contacts |
| eob-lookup-insurance | `NOTIFY_TOPIC_ARN` | eob-extractor-review-alerts ARN |
| eob-store-result | `TABLE_NAME` | eob-extractions |
| eob-store-result | `REVIEW_QUEUE_URL` | eob-extractor-review URL |

---

## 6. S3 Trigger Path

The pipeline activates on S3 `OBJECT_CREATED` events matching:
- **Bucket:** `bucket-specialops` (prod) or `bucket-specialops-sandbox` (dev)
- **Prefix:** `clickup/`
- **Suffix:** `.pdf`

Documents outside this path are ignored by the event notification filter.

---

## 7. Confidence Score Thresholds

| Score | Level | Status | Routing |
|-------|-------|--------|---------|
| >= 0.85 | HIGH | EXTRACTED | LookupInsurance → StoreExtracted |
| 0.50 – 0.84 | MEDIUM | REVIEW_PENDING | LookupInsurance → StoreReviewPending |
| < 0.50 | LOW | FAILED | StoreFailed (no lookup) |

---

## 8. Open Audit Findings

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| #001 | HIGH | S3 PatientName in keys | **FIXED** (audit/2026-06-04 — `sanitizeS3Key()`) |
| #002 | HIGH | Lambda functions NOT VPC-attached | **OPEN** — architectural gap |
| #004 | MEDIUM | PHI blocklist incomplete in sanitizers | **OPEN** |
| #005 | MEDIUM | eob-extractor-review queue has no DLQ | **OPEN** (TD-005) |
| #006 | MEDIUM | Bedrock inference not logged with user identity | **OPEN** |
| #007 | MEDIUM | Insurance-Arbitration-contacts read without PITR/audit trail | **OPEN** |
| #008 | LOW | ULID generation not seeded from KMS | **OPEN** |
| #009 | LOW | No IaC for bucket-specialops (pre-existing, manual) | **OPEN** |

**Critical path for next sprint:** #002 (VPC), #004 (PHI blocklist), #005 (review DLQ).

---

## 9. CDK Deployment

```bash
# Install dependencies
npm ci

# Synthesize (review before deploying)
npx cdk synth --context environment=sandbox --context bucketName=bucket-specialops-sandbox

# Deploy sandbox
npx cdk deploy --context environment=sandbox --context bucketName=bucket-specialops-sandbox

# Deploy production
npx cdk deploy --context environment=production --context bucketName=bucket-specialops
```

**CDK context keys:**
- `environment` — `sandbox` | `production` (controls RemovalPolicy + deletionProtection)
- `bucketName` — source PDF bucket name
- `contactsTable` — external contacts table (default: `Insurance-Arbitration-contacts`)
- `costCenter` — cost allocation tag (default: `engineering`)

---

## 10. Running Tests

```bash
npm run test             # all tests via Vitest
npm run test:unit        # unit tests only (test/unit/)
npm run test:watch       # watch mode
```

---

## 11. Architecture Decision Records

| Decision | Rationale |
|----------|-----------|
| Step Functions STANDARD (not EXPRESS) | Execution history retention for audit; 15-min timeout sufficient |
| Bedrock fallback chain | On-demand quotas per model; chain ensures completion under throttling |
| ULID correlation IDs | Time-sortable, collision-resistant, no external dependency |
| Zod v4 schema validation | Runtime type safety at Lambda boundary; schema-as-truth for extraction contract |
| `includeExecutionData: false` on SFN logs | Prevents PHI (PDF content, extraction JSON) from appearing in CloudWatch |
| `attribute_not_exists` condition on DynamoDB PutItem | Idempotent writes; concurrent executions cannot overwrite existing extraction records |
| DLQ ingest maxReceiveCount=3 | After 3 visibility-timeout expiries the message routes to DLQ for inspection |
