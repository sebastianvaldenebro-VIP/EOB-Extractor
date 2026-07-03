# EOB Extractor — Dependency Manifest

**Date:** 2026-06-08  
**Runtime:** Node.js 20.x  
**Language:** TypeScript ~5.9.3

---

## 1. Production Dependencies

| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `@aws-sdk/client-bedrock-runtime` | ^3.1014.0 | Bedrock InvokeModel API | `InvokeModelCommand`, `BedrockRuntimeClient` |
| `@aws-sdk/client-dynamodb` | ^3.1014.0 | DynamoDB low-level client | Used in `DynamoDBDocumentClient.from()` |
| `@aws-sdk/client-s3` | ^3.1014.0 | S3 GetObject / PutObject | PDF read; quarantine move |
| `@aws-sdk/client-sfn` | ^3.1014.0 | Step Functions StartExecution | `eob-trigger` |
| `@aws-sdk/client-sns` | ^3.1014.0 | SNS Publish | `eob-lookup-insurance` notifications |
| `@aws-sdk/client-sqs` | ^3.1014.0 | SQS SendMessage | `eob-store-result` review queue |
| `@aws-sdk/lib-dynamodb` | ^3.1014.0 | DynamoDB Document client | `PutCommand`, `QueryCommand` |
| `aws-cdk-lib` | ^2.243.0 | CDK constructs | Infrastructure only |
| `constructs` | ^10.5.0 | CDK constructs base | Infrastructure only |
| `ulid` | ^3.0.2 | ULID generation | Correlation IDs, extraction IDs |
| `zod` | ^4.3.6 | Runtime schema validation | `eob-extraction.schema.ts` — uses `zod/v4` import path |

---

## 2. Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/aws-lambda` | ^8.10.161 | TypeScript types for Lambda events (SQSEvent) |
| `@types/jest` | ^30 | Jest type definitions |
| `@types/node` | ^24.10.1 | Node.js type definitions |
| `aws-cdk` | 2.1112.0 | CDK CLI |
| `esbuild` | ^0.27.4 | Lambda bundler (via CDK NodejsFunction) |
| `jest` | ^30 | Test framework |
| `ts-jest` | ^29 | Jest TypeScript transformer |
| `ts-node` | ^10.9.2 | TypeScript execution (CDK bin) |
| `typescript` | ~5.9.3 | TypeScript compiler |
| `vitest` | ^4.1.1 | Unit test runner (primary) |

---

## 3. AWS Service Dependencies

| Service | Version / Config | Dependency Type |
|---------|-----------------|-----------------|
| Lambda runtime | `NODEJS_20_X` | Runtime |
| Lambda architecture | `ARM_64` | Infrastructure |
| Step Functions | STANDARD type | Orchestration |
| DynamoDB | Standard (not global) | Storage |
| Bedrock | `bedrock-2023-05-31` Messages API | AI/ML |
| KMS | Customer-managed CMKs | Security |
| SQS | Standard queues (not FIFO) | Messaging |

---

## 4. Bedrock Model Dependencies

| Model ID | Chain | Tier | Notes |
|----------|-------|------|-------|
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | CLASSIFY_CHAIN[0], EXTRACT_CHAIN[2] | On-demand | Cross-region inference profile |
| `us.anthropic.claude-sonnet-4-20250514-v1:0` | CLASSIFY_CHAIN[1], EXTRACT_CHAIN[1] | On-demand | Cross-region inference profile |
| `us.anthropic.claude-sonnet-4-6` | EXTRACT_CHAIN[0] | On-demand | Cross-region inference profile |

All models accessed via cross-region inference profiles (`us.anthropic.*`). IAM policies grant `bedrock:InvokeModel` for foundation model ARNs in `us-east-1`, `us-east-2`, `us-west-2` and inference profile ARNs in the deployment region.

---

## 5. External Data Dependencies

| Resource | Owner | Access | Criticality |
|----------|-------|--------|-------------|
| `Insurance-Arbitration-contacts` DynamoDB table | Platform team | Read + conditional write | HIGH — pipeline lookup step fails without it |
| `bucket-specialops` / `bucket-specialops-sandbox` S3 bucket | Platform team | Read (clickup/* prefix) | HIGH — source of all PDFs |

Neither resource is managed by the EOB Extractor CDK stack. Changes (deletion, rename, IAM policy changes) require coordination with the platform team.

---

## 6. CDK Context Dependencies

The stack requires the following CDK context values at deploy time:

| Context Key | Default | Required |
|-------------|---------|----------|
| `environment` | `sandbox` | No |
| `bucketName` | `bucket-specialops-sandbox` | No |
| `contactsTable` | `Insurance-Arbitration-contacts` | No |
| `costCenter` | `engineering` | No |

---

## 7. Vulnerability Scanning Notes

- All AWS SDK packages are locked at `^3.1014.0` — pin and update together to avoid SDK version skew
- `aws-cdk-lib` and `constructs` are infrastructure-only and not bundled into Lambda artifacts
- `zod` v4 uses the `zod/v4` import path — verify compatibility if upgrading from v3
- `ulid` v3 API may differ from v2 — `ulid()` function import unchanged
