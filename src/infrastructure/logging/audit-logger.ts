// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

interface BaseLogEntry {
  readonly timestamp: string;
  readonly correlationId: string;
  readonly level: LogLevel;
  readonly event: string;
}

export interface ExtractionLogParams {
  readonly correlationId: string;
  readonly extractionId: string;
  readonly modelId: string;
  readonly status: string;
  readonly confidenceScore: number;
  readonly processingDurationMs: number;
  readonly s3Key: string;
  readonly taskId: string;
}

export interface ErrorLogParams {
  readonly correlationId: string;
  readonly errorMessage: string;
  readonly errorName: string;
  readonly s3Key?: string;
  readonly taskId?: string;
}

// ---------------------------------------------------------------------------
// PHI field names that must NEVER appear in logs
// ---------------------------------------------------------------------------

const PHI_FIELDS = [
  'patientname',
  'patient_name',
  'memberid',
  'member_id',
  'subscribername',
  'subscriber_name',
  'ssn',
  'socialsecuritynumber',
  'social_security_number',
  'dateofbirth',
  'date_of_birth',
  'dob',
  'address',
  'phonenumber',
  'phone_number',
  'email',
  'accountnumber',
  'account_number',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}
function sanitizeS3Key(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  return lastSlash >= 0 ? `${key.slice(0, lastSlash + 1)}*` : '*';
}

/**
 * Scrub potential PHI from an error message.
 * Replaces known PHI-indicative patterns with [REDACTED].
 */
function sanitizeErrorMessage(message: string): string {
  let sanitized = message;

  // Remove anything that looks like a member ID pattern (alphanumeric 8-20 chars after key labels)
  sanitized = sanitized.replace(
    /(?:member[_\s-]?id|patient[_\s-]?name|ssn|account[_\s-]?number)\s*[:=]\s*\S+/gi,
    '[REDACTED]',
  );

  return sanitized;
}

function emit(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a successful or completed extraction event.
 * NEVER includes patientName, memberId, or any PHI.
 * Only includes correlation IDs and operational metadata.
 */
export function logExtraction(params: ExtractionLogParams): void {
  const entry: BaseLogEntry & Record<string, unknown> = {
    timestamp: now(),
    correlationId: params.correlationId,
    level: 'INFO',
    event: 'eob_extraction_complete',
    extractionId: params.extractionId,
    modelId: params.modelId,
    status: params.status,
    confidenceScore: params.confidenceScore,
    processingDurationMs: params.processingDurationMs,
    s3Key: params.s3Key,
    taskId: params.taskId,
  };
  emit(entry);
}

/**
 * Log an error event with PHI sanitized from the message.
 */
export function logError(params: ErrorLogParams): void {
  const entry: BaseLogEntry & Record<string, unknown> = {
    timestamp: now(),
    correlationId: params.correlationId,
    level: 'ERROR',
    event: 'eob_extraction_error',
    errorName: params.errorName,
    errorMessage: sanitizeErrorMessage(params.errorMessage),
    ...(params.s3Key && { s3Key: sanitizeS3Key(params.s3Key) }),
    ...(params.taskId && { taskId: params.taskId }),
  };
  emit(entry);
}

/**
 * Log a general operational event (non-PHI).
 */
export function logEvent(
  correlationId: string,
  event: string,
  level: LogLevel = 'INFO',
  details: Record<string, unknown> = {},
): void {
  // Safety check: reject any detail keys that look like PHI fields
  const safeDetails: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (PHI_FIELDS.includes(key.toLowerCase())) {
      safeDetails[key] = '[REDACTED]';
    } else if (key === 's3Key' && typeof value === 'string') {
      safeDetails[key] = sanitizeS3Key(value);
    } else {
      safeDetails[key] = value;
    }
  }

  const entry: BaseLogEntry & Record<string, unknown> = {
    timestamp: now(),
    correlationId,
    level,
    event,
    ...safeDetails,
  };
  emit(entry);
}
