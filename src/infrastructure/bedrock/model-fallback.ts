import { BedrockMessage, InvokeModelOptions, InvokeModelResult, invokeModel } from './bedrock-client';

// ---------------------------------------------------------------------------
// Model chains — ordered by preference per task type
// ---------------------------------------------------------------------------

/** Classification: Haiku-first for speed, Sonnet as fallback. */
export const CLASSIFY_CHAIN: readonly string[] = [
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
];

/** Extraction: Sonnet 4.6 primary for accuracy, Sonnet 4.0 fallback, Haiku last resort. */
export const EXTRACT_CHAIN: readonly string[] = [
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FallbackResult {
  readonly response: InvokeModelResult;
  readonly modelId: string;
}

export class AllModelsExhaustedException extends Error {
  constructor(
    public readonly chain: readonly string[],
    public readonly lastError: Error,
  ) {
    super(
      `All models in fallback chain exhausted. Tried: ${chain.join(', ')}. Last error: ${lastError.message}`,
    );
    this.name = 'AllModelsExhaustedException';
  }
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isDailyQuotaError(error: unknown): boolean {
  if (!isAwsError(error)) return false;
  const code = (error as AwsServiceError).name ?? '';
  const message = String(error).toLowerCase();
  return code === 'ThrottlingException' && message.includes('too many tokens');
}

function isTransientThrottle(error: unknown): boolean {
  if (!isAwsError(error)) return false;
  const code = (error as AwsServiceError).name ?? '';
  const message = String(error).toLowerCase();
  return code === 'ThrottlingException' && !message.includes('too many tokens');
}

interface AwsServiceError {
  name: string;
  message: string;
  $metadata?: unknown;
}

function isAwsError(error: unknown): error is AwsServiceError {
  return (
    error instanceof Error &&
    typeof (error as AwsServiceError).name === 'string'
  );
}

// ---------------------------------------------------------------------------
// Sleep with jitter
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithJitter(attempt: number): number {
  const base = TRANSIENT_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1_000;
  return base + jitter;
}

// ---------------------------------------------------------------------------
// Core: invoke with fallback
// ---------------------------------------------------------------------------

/**
 * Invoke Bedrock with model fallback chain and transient throttle retry.
 *
 * For each model in the chain:
 * 1. Try the invocation.
 * 2. On transient throttle ("Too many requests"): retry same model with
 *    exponential backoff (1s, 2s base + jitter), max 2 retries.
 * 3. On daily quota exhaustion ("Too many tokens"): advance to next model.
 * 4. On any other error: throw immediately.
 * 5. All models exhausted: throw AllModelsExhaustedException.
 */
export async function invokeWithFallback(
  chain: readonly string[],
  messages: readonly BedrockMessage[],
  systemPrompt: string,
  options: InvokeModelOptions = {},
): Promise<FallbackResult> {
  let lastError: Error = new Error('No models in chain');

  for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
    const currentModel = chain[modelIndex];
    let transientRetries = 0;

    while (true) {
      try {
        console.log(
          JSON.stringify({
            level: 'INFO',
            event: 'bedrock_invoke_attempt',
            modelId: currentModel,
            modelIndex: modelIndex + 1,
            totalModels: chain.length,
            transientRetry: transientRetries,
            timestamp: new Date().toISOString(),
          }),
        );

        const response = await invokeModel(currentModel, messages, systemPrompt, options);

        if (modelIndex > 0 || transientRetries > 0) {
          console.log(
            JSON.stringify({
              level: 'WARN',
              event: 'bedrock_invoke_fallback_success',
              modelId: currentModel,
              modelIndex,
              transientRetries,
              timestamp: new Date().toISOString(),
            }),
          );
        }

        return { response, modelId: currentModel };
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Daily quota exhaustion: advance to next model
        if (isDailyQuotaError(error)) {
          console.log(
            JSON.stringify({
              level: 'WARN',
              event: 'bedrock_daily_quota_exhausted',
              modelId: currentModel,
              timestamp: new Date().toISOString(),
            }),
          );
          lastError = err;
          break; // Next model
        }

        // Transient throttle: retry same model with backoff
        if (isTransientThrottle(error)) {
          if (transientRetries < MAX_TRANSIENT_RETRIES) {
            const delay = delayWithJitter(transientRetries);
            console.log(
              JSON.stringify({
                level: 'WARN',
                event: 'bedrock_transient_throttle_retry',
                modelId: currentModel,
                retry: transientRetries + 1,
                maxRetries: MAX_TRANSIENT_RETRIES,
                delayMs: Math.round(delay),
                timestamp: new Date().toISOString(),
              }),
            );
            await sleep(delay);
            transientRetries++;
            continue; // Retry same model
          }

          // Max retries exhausted for this model
          console.log(
            JSON.stringify({
              level: 'WARN',
              event: 'bedrock_transient_retries_exhausted',
              modelId: currentModel,
              timestamp: new Date().toISOString(),
            }),
          );
          lastError = err;
          break; // Next model
        }

        // Non-throttle error: throw immediately
        throw error;
      }
    }
  }

  // All models exhausted
  throw new AllModelsExhaustedException(chain, lastError);
}
