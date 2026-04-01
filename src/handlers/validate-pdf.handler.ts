import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readPdf, validatePdf, PdfValidationError } from '../infrastructure/storage/s3-pdf-reader';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';

const s3Client = new S3Client({});

interface ValidatePdfInput {
  readonly bucket: string;
  readonly key: string;
  readonly taskId: string;
  readonly correlationId: string;
}

interface ValidatePdfOutput {
  readonly valid: boolean;
  readonly reason?: string;
  readonly bucket?: string;
  readonly key?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly versionId?: string;
  readonly sizeBytes?: number;
}

export async function handler(event: ValidatePdfInput): Promise<ValidatePdfOutput> {
  const { bucket, key, taskId, correlationId } = event;

  logEvent(correlationId, 'validate_pdf_start', 'INFO', { taskId, s3Key: key });

  try {
    const { buffer, versionId } = await readPdf(bucket, key);

    validatePdf(buffer);

    logEvent(correlationId, 'validate_pdf_success', 'INFO', {
      taskId,
      s3Key: key,
      sizeBytes: buffer.length,
    });

    return {
      valid: true,
      bucket,
      key,
      taskId,
      correlationId,
      versionId,
      sizeBytes: buffer.length,
    };
  } catch (error: unknown) {
    if (error instanceof PdfValidationError) {
      logEvent(correlationId, 'validate_pdf_invalid', 'WARN', {
        taskId,
        s3Key: key,
        reason: error.message,
      });

      const quarantineKey = `quarantine/${key}`;
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${key}`,
          Key: quarantineKey,
        }),
      );

      logEvent(correlationId, 'validate_pdf_quarantined', 'INFO', {
        taskId,
        quarantineKey,
      });

      return { valid: false, reason: error.message };
    }

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
