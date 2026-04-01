import { eobExtractionResponseSchema, type EobExtractionResponse } from '../application/schemas/eob-extraction.schema';
import { validateBusinessRules } from '../application/validation/business-rules';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';

interface ValidateDataInput {
  readonly bucket: string;
  readonly key: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly versionId: string;
  readonly classification: Record<string, unknown>;
  readonly extraction: string;
  readonly extractModelId: string;
  readonly processingDurationMs: number;
}

interface ValidateDataOutput extends ValidateDataInput {
  readonly validatedExtraction: EobExtractionResponse;
  readonly confidenceScore: number;
  readonly missingFields: readonly string[];
  readonly warnings: readonly string[];
  readonly isValid: boolean;
}

export async function handler(event: ValidateDataInput): Promise<ValidateDataOutput> {
  const { correlationId, taskId, key } = event;

  logEvent(correlationId, 'validate_data_start', 'INFO', { taskId, s3Key: key });

  try {
    const rawExtraction = JSON.parse(event.extraction) as unknown;

    const schemaResult = eobExtractionResponseSchema.safeParse(rawExtraction);
    if (!schemaResult.success) {
      const schemaErrors = schemaResult.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      );

      logEvent(correlationId, 'validate_data_schema_failed', 'WARN', {
        taskId,
        errorCount: schemaErrors.length,
      });

      // Even on schema failure, pass through with low confidence — don't block
      return {
        ...event,
        validatedExtraction: rawExtraction as EobExtractionResponse,
        confidenceScore: 0.1,
        missingFields: [],
        warnings: schemaErrors,
        isValid: false,
      };
    }

    const validatedExtraction = schemaResult.data;
    const businessResult = validateBusinessRules(validatedExtraction);
    const confidenceScore = validatedExtraction.confidence_score;

    if (businessResult.missingFields.length > 0) {
      logEvent(correlationId, 'validate_data_missing_fields', 'INFO', {
        taskId,
        missingFields: businessResult.missingFields,
        missingCount: businessResult.missingFields.length,
      });
    }

    logEvent(correlationId, 'validate_data_complete', 'INFO', {
      taskId,
      confidenceScore,
      missingFieldCount: businessResult.missingFields.length,
      warningCount: businessResult.warnings.length,
    });

    return {
      ...event,
      validatedExtraction,
      confidenceScore,
      missingFields: businessResult.missingFields,
      warnings: businessResult.warnings,
      isValid: true,
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
}
