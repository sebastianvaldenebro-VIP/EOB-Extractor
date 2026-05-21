import { readPdf } from '../infrastructure/storage/s3-pdf-reader';
import { invokeWithFallback, CLASSIFY_CHAIN } from '../infrastructure/bedrock/model-fallback';
import type { BedrockMessage } from '../infrastructure/bedrock/bedrock-client';
import { EOB_CLASSIFICATION_SYSTEM_PROMPT } from '../application/prompts/classify-prompt';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';

interface ClassifyInput {
  readonly bucket: string;
  readonly key: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly versionId: string;
}

interface ClassifyOutput extends ClassifyInput {
  readonly classification: Record<string, unknown>;
  readonly classifyModelId: string;
  readonly isEob: boolean;
}

export async function handler(event: ClassifyInput): Promise<ClassifyOutput> {
  const { bucket, key, taskId, correlationId, versionId } = event;

  logEvent(correlationId, 'classify_eob_start', 'INFO', { taskId, s3Key: key });

  try {
    const { buffer } = await readPdf(bucket, key);
    const pdfBase64 = buffer.toString('base64');

    const messages: BedrockMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: 'Classify this document. Is it an Explanation of Benefits (EOB)? Identify the insurer if possible.',
          },
        ],
      },
    ];

    const { response, modelId } = await invokeWithFallback(
      CLASSIFY_CHAIN,
      messages,
      EOB_CLASSIFICATION_SYSTEM_PROMPT,
    );

    let classification: Record<string, unknown>;
    try {
      classification = JSON.parse(response.text) as Record<string, unknown>;
    } catch {
      logEvent(correlationId, 'classify_eob_json_retry', 'WARN', { taskId, modelId });

      const retryMessages: BedrockMessage[] = [
        ...messages,
        {
          role: 'assistant',
          content: [{ type: 'text', text: response.text }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Your previous response was not valid JSON. Return ONLY a valid JSON object matching the schema. No markdown, no explanation, no code fences.',
            },
          ],
        },
      ];

      const retryResult = await invokeWithFallback(
        CLASSIFY_CHAIN,
        retryMessages,
        EOB_CLASSIFICATION_SYSTEM_PROMPT,
      );
      classification = JSON.parse(retryResult.response.text) as Record<string, unknown>;
    }

    logEvent(correlationId, 'classify_eob_complete', 'INFO', {
      taskId,
      modelId,
      documentType: classification.document_type as string,
      isEob: classification.is_eob as boolean,
    });

    const isEob = classification.is_eob === true || classification.document_type === 'EOB';

    return {
      bucket,
      key,
      taskId,
      correlationId,
      versionId,
      classification,
      classifyModelId: modelId,
      isEob,
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
