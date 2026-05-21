import { vi, type Mock } from 'vitest';

// Mock the bedrock-client module before importing model-fallback
vi.mock('../../../src/infrastructure/bedrock/bedrock-client', () => ({
  invokeModel: vi.fn(),
}));

import { invokeModel } from '../../../src/infrastructure/bedrock/bedrock-client';
import {
  invokeWithFallback,
  AllModelsExhaustedException,
} from '../../../src/infrastructure/bedrock/model-fallback';
import type { InvokeModelResult } from '../../../src/infrastructure/bedrock/bedrock-client';

const mockInvokeModel = invokeModel as Mock;

const TEST_CHAIN = ['model-primary', 'model-secondary'];
const TEST_MESSAGES = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'test' }] }];
const TEST_SYSTEM = 'system prompt';

function makeSuccessResult(text = '{"ok": true}'): InvokeModelResult {
  return { text, inputTokens: 100, outputTokens: 50, stopReason: 'end_turn' };
}

function makeDailyQuotaError(): Error {
  const err = new Error('ThrottlingException: Too many tokens processed');
  err.name = 'ThrottlingException';
  return err;
}

function makeTransientThrottleError(): Error {
  const err = new Error('ThrottlingException: Too many requests');
  err.name = 'ThrottlingException';
  return err;
}

function makeNonThrottleError(): Error {
  const err = new Error('ValidationException: Invalid input');
  err.name = 'ValidationException';
  return err;
}

describe('invokeWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Use fake timers and eliminate random jitter for deterministic tests
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('succeeds on the first model', async () => {
    const expected = makeSuccessResult();
    mockInvokeModel.mockResolvedValueOnce(expected);

    const result = await invokeWithFallback(TEST_CHAIN, TEST_MESSAGES, TEST_SYSTEM);

    expect(result.modelId).toBe('model-primary');
    expect(result.response).toBe(expected);
    expect(mockInvokeModel).toHaveBeenCalledTimes(1);
    expect(mockInvokeModel).toHaveBeenCalledWith(
      'model-primary',
      TEST_MESSAGES,
      TEST_SYSTEM,
      {},
    );
  });

  it('falls back to second model on daily quota error', async () => {
    const expected = makeSuccessResult();
    mockInvokeModel
      .mockRejectedValueOnce(makeDailyQuotaError())
      .mockResolvedValueOnce(expected);

    const result = await invokeWithFallback(TEST_CHAIN, TEST_MESSAGES, TEST_SYSTEM);

    expect(result.modelId).toBe('model-secondary');
    expect(result.response).toBe(expected);
    expect(mockInvokeModel).toHaveBeenCalledTimes(2);
  });

  it('retries on transient throttle with backoff then succeeds', async () => {
    const expected = makeSuccessResult();
    mockInvokeModel
      .mockRejectedValueOnce(makeTransientThrottleError())
      .mockResolvedValueOnce(expected);

    const promise = invokeWithFallback(TEST_CHAIN, TEST_MESSAGES, TEST_SYSTEM);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.modelId).toBe('model-primary');
    expect(result.response).toBe(expected);
    expect(mockInvokeModel).toHaveBeenCalledTimes(2);
    expect(mockInvokeModel.mock.calls[0][0]).toBe('model-primary');
    expect(mockInvokeModel.mock.calls[1][0]).toBe('model-primary');
  });

  it('throws AllModelsExhaustedException when all models fail', async () => {
    mockInvokeModel
      .mockRejectedValueOnce(makeDailyQuotaError())
      .mockRejectedValueOnce(makeDailyQuotaError());

    await expect(
      invokeWithFallback(TEST_CHAIN, TEST_MESSAGES, TEST_SYSTEM),
    ).rejects.toThrow(AllModelsExhaustedException);
  });

  it('does NOT retry on non-throttle errors — throws immediately', async () => {
    const nonThrottleErr = makeNonThrottleError();
    mockInvokeModel.mockRejectedValueOnce(nonThrottleErr);

    await expect(
      invokeWithFallback(TEST_CHAIN, TEST_MESSAGES, TEST_SYSTEM),
    ).rejects.toThrow('ValidationException: Invalid input');

    expect(mockInvokeModel).toHaveBeenCalledTimes(1);
  });

  it('exhausts transient retries then moves to next model', async () => {
    const expected = makeSuccessResult();
    // Primary: 3 transient throttles (1 initial + 2 retries = MAX_TRANSIENT_RETRIES)
    // Secondary: success
    mockInvokeModel
      .mockRejectedValueOnce(makeTransientThrottleError()) // attempt 1
      .mockRejectedValueOnce(makeTransientThrottleError()) // retry 1
      .mockRejectedValueOnce(makeTransientThrottleError()) // retry 2 (max reached)
      .mockResolvedValueOnce(expected);                     // secondary succeeds

    const promise = invokeWithFallback(TEST_CHAIN, TEST_MESSAGES, TEST_SYSTEM);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.modelId).toBe('model-secondary');
    expect(mockInvokeModel).toHaveBeenCalledTimes(4);
  });
});
