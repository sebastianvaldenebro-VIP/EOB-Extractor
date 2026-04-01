import { readPdf } from '../infrastructure/storage/s3-pdf-reader';
import { invokeWithFallback, EXTRACT_CHAIN } from '../infrastructure/bedrock/model-fallback';
import type { BedrockMessage } from '../infrastructure/bedrock/bedrock-client';
import { EOB_EXTRACTION_SYSTEM_PROMPT } from '../application/prompts/system-prompt';
import {
  buildExtractionUserPrompt,
  type ClassificationContext,
} from '../application/prompts/extract-prompt';
import { logEvent, logError } from '../infrastructure/logging/audit-logger';

interface ExtractInput {
  readonly bucket: string;
  readonly key: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly versionId: string;
  readonly classification: {
    readonly insurer_name?: string | null;
    readonly insurer_identifier?: string | null;
    readonly document_type?: string;
  };
}

interface ExtractOutput extends Omit<ExtractInput, 'classification'> {
  readonly classification: ExtractInput['classification'];
  readonly extraction: string;
  readonly extractModelId: string;
  readonly processingDurationMs: number;
}

export async function handler(event: ExtractInput): Promise<ExtractOutput> {
  const { bucket, key, taskId, correlationId, versionId, classification } = event;

  logEvent(correlationId, 'extract_eob_start', 'INFO', { taskId, s3Key: key });

  const startTime = Date.now();

  try {
    const { buffer } = await readPdf(bucket, key);
    const pdfBase64 = buffer.toString('base64');

    const classificationContext: ClassificationContext = {
      insurerName: classification.insurer_name ?? null,
      insurerIdentifier: classification.insurer_identifier ?? null,
      documentType: classification.document_type ?? 'unknown',
    };

    const userPrompt = buildExtractionUserPrompt(classificationContext);

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
            text: userPrompt,
          },
        ],
      },
    ];

    const { response, modelId } = await invokeWithFallback(
      EXTRACT_CHAIN,
      messages,
      EOB_EXTRACTION_SYSTEM_PROMPT,
    );

    let extraction: string;
    try {
      JSON.parse(response.text);
      extraction = response.text;
    } catch {
      logEvent(correlationId, 'extract_eob_json_retry', 'WARN', { taskId, modelId });

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
        EXTRACT_CHAIN,
        retryMessages,
        EOB_EXTRACTION_SYSTEM_PROMPT,
      );

      JSON.parse(retryResult.response.text);
      extraction = retryResult.response.text;
    }

    const processingDurationMs = Date.now() - startTime;

    logEvent(correlationId, 'extract_eob_complete', 'INFO', {
      taskId,
      extractModelId: modelId,
      processingDurationMs,
    });

    return {
      bucket,
      key,
      taskId,
      correlationId,
      versionId,
      classification,
      extraction,
      extractModelId: modelId,
      processingDurationMs,
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
