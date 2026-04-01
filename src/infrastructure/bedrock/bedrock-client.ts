import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface BedrockMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ReadonlyArray<BedrockContentBlock>;
}

export interface BedrockTextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface BedrockDocumentBlock {
  readonly type: 'document';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: 'application/pdf';
    readonly data: string;
  };
}

export type BedrockContentBlock = BedrockTextBlock | BedrockDocumentBlock;

export interface InvokeModelOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface InvokeModelResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: string;
}

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0;

const client = new BedrockRuntimeClient({});

/**
 * Strip markdown code fences from LLM JSON responses.
 * Handles ```json\n{...}\n``` and ```\n{...}\n```.
 */
function stripJsonFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline === -1) return cleaned;
    cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.trimEnd().endsWith('```')) {
      cleaned = cleaned.trimEnd().slice(0, -3).trimEnd();
    }
  }
  return cleaned;
}

/**
 * Invoke a Bedrock model using the Messages API.
 * Temperature defaults to 0 for deterministic extraction.
 * Strips markdown fences from JSON responses.
 */
export async function invokeModel(
  modelId: string,
  messages: readonly BedrockMessage[],
  systemPrompt: string,
  options: InvokeModelOptions = {},
): Promise<InvokeModelResult> {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages,
  };

  const command = new InvokeModelCommand({
    modelId,
    body: JSON.stringify(requestBody),
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  const rawText: string = responseBody.content
    ?.map((block: { type: string; text?: string }) =>
      block.type === 'text' ? block.text ?? '' : '',
    )
    .join('') ?? '';

  return {
    text: stripJsonFences(rawText),
    inputTokens: responseBody.usage?.input_tokens ?? 0,
    outputTokens: responseBody.usage?.output_tokens ?? 0,
    stopReason: responseBody.stop_reason ?? '',
  };
}
