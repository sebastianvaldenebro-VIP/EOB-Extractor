import { ConfidenceScore } from './confidence-score';

export const ExtractionStatus = {
  EXTRACTED: 'EXTRACTED',
  REVIEW_PENDING: 'REVIEW_PENDING',
  FAILED: 'FAILED',
} as const;

export type ExtractionStatus = (typeof ExtractionStatus)[keyof typeof ExtractionStatus];

export function extractionStatusFromConfidence(score: ConfidenceScore): ExtractionStatus {
  if (score.isHighConfidence()) {
    return ExtractionStatus.EXTRACTED;
  }
  return ExtractionStatus.REVIEW_PENDING;
}
