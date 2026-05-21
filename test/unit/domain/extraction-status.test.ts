import { ConfidenceScore } from '../../../src/domain/value-objects/confidence-score';
import {
  ExtractionStatus,
  extractionStatusFromConfidence,
} from '../../../src/domain/value-objects/extraction-status';

describe('extractionStatusFromConfidence', () => {
  it('maps HIGH confidence to EXTRACTED', () => {
    const score = ConfidenceScore.fromNumber(0.90);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.EXTRACTED);
  });

  it('maps threshold 0.85 to EXTRACTED', () => {
    const score = ConfidenceScore.fromNumber(0.85);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.EXTRACTED);
  });

  it('maps MEDIUM confidence to REVIEW_PENDING', () => {
    const score = ConfidenceScore.fromNumber(0.62);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.REVIEW_PENDING);
  });

  it('maps LOW confidence to FAILED', () => {
    const score = ConfidenceScore.fromNumber(0.30);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.FAILED);
  });

  it('maps 0.50 boundary to REVIEW_PENDING', () => {
    const score = ConfidenceScore.fromNumber(0.50);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.REVIEW_PENDING);
  });

  it('maps 0.0 to FAILED', () => {
    const score = ConfidenceScore.fromNumber(0.0);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.FAILED);
  });

  it('maps score just below 0.50 to FAILED', () => {
    const score = ConfidenceScore.fromNumber(0.49);
    expect(extractionStatusFromConfidence(score)).toBe(ExtractionStatus.FAILED);
  });
});
