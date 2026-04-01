import { ConfidenceScore } from '../../../src/domain/value-objects/confidence-score';

describe('ConfidenceScore', () => {
  describe('validation', () => {
    it('rejects values below 0', () => {
      expect(() => ConfidenceScore.fromNumber(-0.01)).toThrow(
        'Confidence score must be between 0 and 1',
      );
    });

    it('rejects values above 1', () => {
      expect(() => ConfidenceScore.fromNumber(1.01)).toThrow(
        'Confidence score must be between 0 and 1',
      );
    });

    it('accepts boundary value 0', () => {
      const score = ConfidenceScore.fromNumber(0);
      expect(score.value).toBe(0);
    });

    it('accepts boundary value 1', () => {
      const score = ConfidenceScore.fromNumber(1);
      expect(score.value).toBe(1);
    });
  });

  describe('isHighConfidence', () => {
    it('returns true at threshold 0.85', () => {
      expect(ConfidenceScore.fromNumber(0.85).isHighConfidence()).toBe(true);
    });

    it('returns true above threshold', () => {
      expect(ConfidenceScore.fromNumber(0.95).isHighConfidence()).toBe(true);
    });

    it('returns true at 1.0', () => {
      expect(ConfidenceScore.fromNumber(1.0).isHighConfidence()).toBe(true);
    });

    it('returns false just below threshold', () => {
      expect(ConfidenceScore.fromNumber(0.84).isHighConfidence()).toBe(false);
    });
  });

  describe('isMediumConfidence', () => {
    it('returns true at threshold 0.50', () => {
      expect(ConfidenceScore.fromNumber(0.50).isMediumConfidence()).toBe(true);
    });

    it('returns true at 0.84', () => {
      expect(ConfidenceScore.fromNumber(0.84).isMediumConfidence()).toBe(true);
    });

    it('returns false at 0.85 (high boundary)', () => {
      expect(ConfidenceScore.fromNumber(0.85).isMediumConfidence()).toBe(false);
    });

    it('returns false at 0.49', () => {
      expect(ConfidenceScore.fromNumber(0.49).isMediumConfidence()).toBe(false);
    });
  });

  describe('isLowConfidence', () => {
    it('returns true at 0.49', () => {
      expect(ConfidenceScore.fromNumber(0.49).isLowConfidence()).toBe(true);
    });

    it('returns true at 0.0', () => {
      expect(ConfidenceScore.fromNumber(0.0).isLowConfidence()).toBe(true);
    });

    it('returns false at 0.50', () => {
      expect(ConfidenceScore.fromNumber(0.50).isLowConfidence()).toBe(false);
    });
  });

  describe('level', () => {
    it('returns HIGH for >= 0.85', () => {
      expect(ConfidenceScore.fromNumber(0.85).level).toBe('HIGH');
    });

    it('returns MEDIUM for 0.50-0.84', () => {
      expect(ConfidenceScore.fromNumber(0.50).level).toBe('MEDIUM');
    });

    it('returns LOW for < 0.50', () => {
      expect(ConfidenceScore.fromNumber(0.49).level).toBe('LOW');
    });
  });

  describe('equals', () => {
    it('returns true for equal scores', () => {
      const a = ConfidenceScore.fromNumber(0.85);
      const b = ConfidenceScore.fromNumber(0.85);
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for different scores', () => {
      const a = ConfidenceScore.fromNumber(0.85);
      const b = ConfidenceScore.fromNumber(0.50);
      expect(a.equals(b)).toBe(false);
    });
  });
});
