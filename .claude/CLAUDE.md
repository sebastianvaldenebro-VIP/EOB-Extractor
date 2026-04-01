# EOB PDF Data Extractor

## Overview
Extracts structured insurance data from Explanation of Benefits (EOB) PDFs using Amazon Bedrock Claude. Processes PDFs from many unknown insurers via a Step Functions orchestration pipeline.

## Tech Stack
- Runtime: Node.js 20 + TypeScript 5.x
- IaC: AWS CDK (TypeScript)
- Orchestration: AWS Step Functions
- Extraction: Amazon Bedrock (Claude Sonnet 4.6 primary, Haiku 4.5 for classification)
- Storage: DynamoDB (single-table design, PK=TASK#{taskId})
- Source: Existing S3 bucket `bucket-specialops-sandbox` (sandbox) / `bucket-specialops` (prod)
- PDFs at: `clickup/{taskId}/*.pdf`

## Commands
- Install: `npm ci`
- Build: `npx tsc`
- Synth: `npx cdk synth`
- Deploy: `npx cdk deploy -c bucketName=bucket-specialops-sandbox`
- Test: `npx vitest run`
- Lint: `npx tsc --noEmit`

## Architecture
Clean Architecture: domain/ > application/ > infrastructure/ > handlers/

Pipeline: S3 event → SQS → Trigger Lambda → Step Functions:
1. ValidatePDF (magic bytes, size, quarantine)
2. ClassifyEOB (Haiku — insurer identification)
3. ExtractEOB (Sonnet — full JSON extraction)
4. ValidateData (Zod schema + business rules)
5. RouteByConfidence (>=0.85 EXTRACTED, 0.50-0.84 REVIEW_PENDING, <0.50 FAILED)

## HIPAA
This project handles PHI. PHI fields: patientName, memberId.
- Never log PHI — use correlationId for tracing
- KMS CMK encryption on all storage (DynamoDB, S3, SQS, CloudWatch)
- EngineeringPermissionBoundary on all IAM roles
- S3 Object Lock COMPLIANCE mode on audit bucket (6yr retention)
- Bedrock model improvement opt-out required

## Key Patterns (ported from ENLO)
- Bedrock model fallback chain: src/infrastructure/bedrock/model-fallback.ts
- Permission boundary aspect: lib/aspects/permission-boundary.aspect.ts
- Prompt injection defense: src/infrastructure/storage/s3-pdf-reader.ts (sanitizeForPrompt)
- Structured audit logging: src/infrastructure/logging/audit-logger.ts