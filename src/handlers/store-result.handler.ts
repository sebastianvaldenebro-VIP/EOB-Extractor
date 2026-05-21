import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EobExtraction } from '../domain/entities/eob-extraction';
import { ConfidenceScore } from '../domain/value-objects/confidence-score';
import { ExtractionStatus } from '../domain/value-objects/extraction-status';
import { DynamoDbEobRepository } from '../infrastructure/persistence/dynamodb-eob.repository';
import type { EobExtractionRepository } from '../domain/repositories/eob-extraction.repository';
import { logExtraction, logEvent, logError } from '../infrastructure/logging/audit-logger';
import type { EobExtractionResponse } from '../application/schemas/eob-extraction.schema';

const REVIEW_QUEUE_URL = process.env.REVIEW_QUEUE_URL ?? '';

export interface StoreResultDeps {
  readonly repository: Pick<EobExtractionRepository, 'save'>;
  readonly sendToReviewQueue: (messageBody: string) => Promise<void>;
}

interface StoreResultInput {
  readonly bucket: string;
  readonly key: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly versionId: string;
  readonly classification: Record<string, unknown>;
  readonly extraction: string;
  readonly extractModelId: string;
  readonly processingDurationMs: number;
  readonly validatedExtraction: EobExtractionResponse;
  readonly confidenceScore: number;
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
  readonly isValid: boolean;
  readonly lookupResult: string;
  readonly mismatches: readonly string[];
  readonly contactRecord: Record<string, string> | null;
}

interface StoreResultOutput {
  readonly extractionId: string;
  readonly taskId: string;
  readonly status: ExtractionStatus;
  readonly confidenceScore: number;
}

export function createHandler(deps: StoreResultDeps) {
  return async function handler(event: StoreResultInput): Promise<StoreResultOutput> {
    const { correlationId, taskId, key, versionId, extractModelId, processingDurationMs } = event;
    const data = event.validatedExtraction;

    logEvent(correlationId, 'store_result_start', 'INFO', { taskId, s3Key: key });

    try {
      const confidenceScore = ConfidenceScore.fromNumber(event.confidenceScore);

      const extraction = EobExtraction.createFromExtraction(
        taskId,
        key,
        versionId || null,
        confidenceScore,
        event.extraction,
        extractModelId,
        JSON.stringify(event.classification),
        processingDurationMs,
        correlationId,
        {
          insuranceName: data.insurance_name ?? null,
          insuranceIdentifier: data.insurance_identifier ?? null,
          address: data.address ?? null,
          city: data.city ?? null,
          state: data.state ?? null,
          zipCode: data.zip_code ?? null,
          locationState: data.location_state ?? null,
          arbitrationPhone: data.arbitration_phone ?? null,
          arbitrationFax: data.arbitration_fax ?? null,
          arbitrationEmail: data.arbitration_email ?? null,
        },
      );

      await deps.repository.save(extraction);

      if (extraction.status === ExtractionStatus.REVIEW_PENDING && REVIEW_QUEUE_URL) {
        await deps.sendToReviewQueue(JSON.stringify({
          extractionId: extraction.extractionId,
          taskId,
          correlationId,
          confidenceScore: extraction.confidenceScore.value,
          status: extraction.status,
        }));

        logEvent(correlationId, 'store_result_review_queued', 'INFO', {
          taskId,
          extractionId: extraction.extractionId,
        });
      }

      logExtraction({
        correlationId,
        extractionId: extraction.extractionId,
        modelId: extractModelId,
        status: extraction.status,
        confidenceScore: extraction.confidenceScore.value,
        processingDurationMs,
        s3Key: key,
        taskId,
      });

      return {
        extractionId: extraction.extractionId,
        taskId,
        status: extraction.status,
        confidenceScore: extraction.confidenceScore.value,
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logError({
        correlationId,
        errorMessage: err.message,
        errorName: err.name,
        s3Key: key,
        taskId,
      });
      throw error;
    }
  };
}

const repository = new DynamoDbEobRepository();
const sqsClient = new SQSClient({});

export const handler = createHandler({
  repository,
  sendToReviewQueue: async (messageBody) => {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: REVIEW_QUEUE_URL,
      MessageBody: messageBody,
    }));
  },
});
