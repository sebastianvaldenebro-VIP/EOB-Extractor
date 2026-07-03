# EOB Extractor — Architecture

**Date:** 2026-06-08 (verified current + migration section added 2026-07-03)  
**Model:** C4 (Context → Container → Component)

---

## 1. System Context

```mermaid
C4Context
  title EOB Extractor — System Context

  Person(ops, "Operations Team", "Monitors pipeline health and reviews low-confidence extractions")
  Person(dev, "Engineering", "Deploys and maintains the pipeline")

  System(eob, "EOB Extractor", "Serverless pipeline that extracts insurance and arbitration contact data from EOB PDF documents")

  System_Ext(clickup, "ClickUp Integration", "Uploads EOB PDFs to S3 bucket-specialops via webhook")
  System_Ext(bedrock, "Amazon Bedrock", "Foundation model API for document classification and data extraction")
  System_Ext(contacts, "Insurance-Arbitration-contacts", "Pre-existing DynamoDB table of known insurance arbitration contacts")

  Rel(clickup, eob, "Uploads PDFs", "S3 PUT clickup/*.pdf")
  Rel(eob, bedrock, "Classify + extract", "HTTPS / InvokeModel")
  Rel(eob, contacts, "Cross-reference insurance data", "DynamoDB Query / PutItem")
  Rel(ops, eob, "Monitors via CloudWatch + SNS alerts")
  Rel(dev, eob, "Deploys via CDK")
```

---

## 2. Container Diagram

```mermaid
C4Container
  title EOB Extractor — Containers

  Container(ingest, "eob-extractor-ingest", "SQS Queue", "Buffers S3 ObjectCreated events; visibility 120s; DLQ after 3 retries")
  Container(trigger, "eob-trigger", "Lambda / Node.js 20", "Deduplication check + Step Functions StartExecution")
  Container(sfn, "eob-extraction-pipeline", "Step Functions STANDARD", "Orchestrates 6-step extraction pipeline; 15-min timeout; X-Ray tracing")
  Container(review, "eob-extractor-review", "SQS Queue", "Holds REVIEW_PENDING extractions for human review; no DLQ (TD-005)")
  Container(dlq, "eob-extractor-dlq", "SQS Queue", "Dead letters from ingest; 14-day retention")
  Container(dynamo, "eob-extractions", "DynamoDB", "Extraction results; KMS CMK alias/eob-extractor/phi; PITR; Streams")
  Container(audit, "eob-extractor-audit-{account}", "S3 Bucket", "Immutable audit logs; Object Lock COMPLIANCE; 6-year retention")
  Container(ops_sns, "eob-extractor-ops-alerts", "SNS Topic", "Operational alerts to on-call")
  Container(review_sns, "eob-extractor-review-alerts", "SNS Topic", "New/mismatch insurance contact notifications")

  Rel(ingest, trigger, "SQS batch=1", "event source mapping")
  Rel(trigger, sfn, "StartExecution", "input: {bucket, key, taskId, correlationId}")
  Rel(sfn, dynamo, "Write extraction result", "via eob-store-result")
  Rel(sfn, review, "Route REVIEW_PENDING", "via eob-store-result")
  Rel(sfn, review_sns, "Publish new/mismatch contact", "via eob-lookup-insurance")
  Rel(sfn, ops_sns, "Publish operational alerts")
  Rel(sfn, audit, "Structured JSON logs", "CloudWatch → S3 export")
```

---

## 3. Step Functions Pipeline — Full Flow

```mermaid
flowchart TD
    SQS[eob-extractor-ingest\nSQS Queue]
    T[eob-trigger\nLambda]
    SFN_START([SFN Start])

    VP[eob-validate-pdf]
    VPCHK{IsPDFValid?}
    CL[eob-classify-eob]
    ISEOБ{IsDocumentEOB?}
    EX[eob-extract-eob]
    VD[eob-validate-data]
    CONF{RouteByConfidence\nconfidenceScore >= 0.50?}
    LI[eob-lookup-insurance]
    LOOKUP{RouteByLookup\nlookupResult = MATCH?}
    SE[eob-store-result\nStoreExtracted]
    SR[eob-store-result\nStoreReviewPending]
    SF[eob-store-result\nStoreFailed]

    DONE1([ExtractionComplete])
    DONE2([MatchGoodToGo])
    DONE3([PDFInvalid])
    DONE4([NotAnEOB])
    FAIL([PipelineFailed])

    SQS -->|S3 ObjectCreated event| T
    T -->|dedup check passes| SFN_START
    SFN_START --> VP
    VP --> VPCHK
    VPCHK -->|valid=false| DONE3
    VPCHK -->|valid=true| CL
    CL --> ISEOБ
    ISEOБ -->|isEob=false| DONE4
    ISEOБ -->|isEob=true| EX
    EX --> VD
    VD --> CONF
    CONF -->|score < 0.50| SF --> DONE1
    CONF -->|score >= 0.50| LI
    LI --> LOOKUP
    LOOKUP -->|MATCH| SE --> DONE2
    LOOKUP -->|NEW or MISMATCH| SR --> DONE1

    VP -.->|States.ALL catch| FAIL
    CL -.->|after 3 retries\nAllModelsExhausted\nThrottling| FAIL
    EX -.->|after 3 retries\nAllModelsExhausted\nThrottling| FAIL
    VD -.->|States.ALL catch| FAIL
    LI -.->|States.ALL catch| FAIL
    SE -.->|States.ALL catch| FAIL
    SR -.->|States.ALL catch| FAIL
    SF -.->|States.ALL catch| FAIL

    style FAIL fill:#d9534f,color:#fff
    style DONE2 fill:#5cb85c,color:#fff
    style DONE1 fill:#5cb85c,color:#fff
```

---

## 4. Bedrock Model Fallback Chains

```mermaid
flowchart LR
    subgraph CLASSIFY_CHAIN
        C1[claude-haiku-4-5\nus.anthropic.claude-haiku-4-5-20251001-v1:0\nPrimary — speed]
        C2[claude-sonnet-4-20250514\nus.anthropic.claude-sonnet-4-20250514-v1:0\nFallback — quota exhausted]
        C1 -->|ThrottlingException daily quota| C2
        C1 -->|transient throttle: 2 retries exp backoff| C1
    end

    subgraph EXTRACT_CHAIN
        E1[claude-sonnet-4-6\nus.anthropic.claude-sonnet-4-6\nPrimary — accuracy]
        E2[claude-sonnet-4-20250514\nus.anthropic.claude-sonnet-4-20250514-v1:0\nFallback 1]
        E3[claude-haiku-4-5\nus.anthropic.claude-haiku-4-5-20251001-v1:0\nLast resort]
        E1 -->|daily quota exhausted| E2
        E2 -->|daily quota exhausted| E3
    end
```

**Retry logic:**
- Transient `ThrottlingException` (not "too many tokens"): retry same model, max 2 retries, exponential backoff (1s × 2^n + jitter up to 1s)
- Daily quota `ThrottlingException` ("too many tokens"): advance to next model immediately
- All other errors: throw immediately, caught by SFN `States.ALL` catch → `PipelineFailed`

---

## 5. Data Flow — PHI Boundary

```mermaid
flowchart LR
    PDF[PDF in S3\nPHI content inside document]
    BED[Amazon Bedrock\nPDF sent as base64]
    EXT[Extracted JSON\nInsurance contact fields only\nNo patient identifiers]
    DDB[DynamoDB eob-extractions\nInsurance fields + metadata\nKMS encrypted]
    LOG[CloudWatch Logs\nCorrelation IDs only\nPHI redacted by audit-logger.ts]

    PDF -->|base64 document block| BED
    BED -->|structured JSON response| EXT
    EXT -->|Zod validated| DDB
    EXT -.->|PHI_FIELDS blocklist enforced| LOG

    style PDF fill:#f0ad4e
    style BED fill:#f0ad4e
    style LOG fill:#5cb85c
    style DDB fill:#5cb85c
```

**PHI handling note:** The PDF is transmitted to Bedrock in-memory as a base64 block and never written to logs. The extracted JSON contains only insurance company details (name, address, arbitration contacts) — not patient-level identifiers. All log paths go through `audit-logger.ts` which enforces the `PHI_FIELDS` blocklist and `sanitizeS3Key()` before emitting to CloudWatch.

---

## 6. Infrastructure — Key AWS Resources

```mermaid
graph TB
    subgraph Storage ["Storage (StorageConstruct)"]
        PHI_KEY["KMS alias/eob-extractor/phi\nAuto-rotation enabled"]
        AUDIT_KEY["KMS alias/eob-extractor/audit\nAuto-rotation enabled"]
        DYNAMO["DynamoDB eob-extractions\nPAY_PER_REQUEST | PITR | Streams\nKMS: alias/eob-extractor/phi"]
        AUDIT_S3["S3 eob-extractor-audit-{account}\nObject Lock COMPLIANCE | 6yr\nKMS: alias/eob-extractor/audit"]
        EOB_BUCKET["S3 bucket-specialops\nImported — not CDK-managed\n(Audit finding #009)"]
    end

    subgraph Queuing ["Queuing (QueuingConstruct)"]
        INGEST["SQS eob-extractor-ingest\nvisibilityTimeout=120s | retention=4h\nDLQ: maxReceiveCount=3"]
        REVIEW["SQS eob-extractor-review\nretention=14d | NO DLQ (TD-005)"]
        DLQ["SQS eob-extractor-dlq\nretention=14d"]
    end

    subgraph Monitoring ["Monitoring (MonitoringConstruct)"]
        OPS_SNS["SNS eob-extractor-ops-alerts"]
        REVIEW_SNS["SNS eob-extractor-review-alerts"]
    end

    subgraph Lambdas ["Lambda (ExtractionConstruct)"]
        TRIGGER["eob-trigger\n256MB | 10s | concur=2"]
        VALIDATE_PDF["eob-validate-pdf\n512MB | 30s"]
        CLASSIFY["eob-classify-eob\n512MB | 60s | concur=10"]
        EXTRACT["eob-extract-eob\n1024MB | 300s | concur=10"]
        VALIDATE_DATA["eob-validate-data\n256MB | 30s"]
        LOOKUP["eob-lookup-insurance\n512MB | 30s"]
        STORE["eob-store-result\n512MB | 30s"]
    end

    INGEST --> TRIGGER
    EOB_BUCKET -->|S3 ObjectCreated\nclickup/*.pdf| INGEST
    TRIGGER --> SFN
    SFN["Step Functions\neob-extraction-pipeline\nSTANDARD | 15min | X-Ray"] --> VALIDATE_PDF
    VALIDATE_PDF --> CLASSIFY --> EXTRACT --> VALIDATE_DATA --> LOOKUP --> STORE
    STORE --> DYNAMO
    STORE --> REVIEW
    LOOKUP --> REVIEW_SNS
    STORE --> OPS_SNS

    PHI_KEY --> DYNAMO
    AUDIT_KEY --> AUDIT_S3
```

---

## 7. Lambda Architecture Pattern

All Lambda handlers follow the same Clean Architecture + DI pattern:

```
Handler File
├── createHandler(deps) → handler function    ← testable, deps injected
├── Production deps (DynamoDB client, SQS client, etc.)
└── export const handler = createHandler(productionDeps)
```

The handler function contains business logic; the production wiring at the bottom creates real AWS clients. Tests inject mocks via `createHandler`.

---

## 8. Migration Considerations (sandbox → production)

Risk-ordered checklist for promoting this POC to the production account:

1. **VPC attachment first (Finding #002)** — do not replicate the sandbox's no-VPC posture in production; PHI workloads require VPC-attached Lambdas + VPC endpoints per Medwork convention. This is the top architectural gap.
2. **Bucket switch** — sandbox reads `bucket-specialops-sandbox`; production is `bucket-specialops` (`clickup/{taskId}/` prefix). The bucket is NOT managed by this CDK app (Finding #009) — the S3 event notification to the ingest queue must be recreated manually against the prod bucket.
3. **KMS keys** — recreate both CMKs (PHI + audit) in the prod account; all log groups, `eob-extractions`, queues, and SNS re-encrypt against the new keys. Verify key policies before first invoke.
4. **`Insurance-Arbitration-contacts` dependency** — the lookup table lives in the Arbitration platform's account/stack (read-only external dependency, Finding #007). Cross-check table name, region, and the reader role's grant in prod.
5. **Bedrock model access + quotas** — the fallback chain (`us.anthropic.claude-sonnet-4-6` → `sonnet-4-20250514` → `haiku-4-5`) needs model access in the prod account and quota headroom for 1K–10K docs/month; the `us.*` profiles route across us-east-1/2 + us-west-2, so IAM must allow all three regions.
6. **Permission boundary** — `permission-boundary.aspect.ts` applies the boundary to every role; confirm the prod account's boundary policy name matches or parameterize it.
7. **Review-queue operations** — `eob-extractor-review` has no DLQ (Finding #005) and no consumer beyond humans; define the prod review workflow (who drains it, SLA) before go-live.
8. **CI gates** — the GitHub Actions workflow has no SAST/dependency-scan step (audit finding from the 2026-05 smoke test); add Semgrep + npm audit gates before prod deploys.
9. **Data migration** — none required (extractions are derived data; re-extraction from source PDFs is the recovery path — see RB-005 for PITR).
