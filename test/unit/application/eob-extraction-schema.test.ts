import { eobExtractionResponseSchema } from '../../../src/application/schemas/eob-extraction.schema';
import highConfidence from '../../fixtures/sample-eob-responses/valid-high-confidence.json';
import lowConfidence from '../../fixtures/sample-eob-responses/valid-low-confidence.json';
import notEob from '../../fixtures/sample-eob-responses/not-eob.json';

describe('eobExtractionResponseSchema', () => {
  describe('valid fixtures', () => {
    it('validates the high-confidence fixture', () => {
      const result = eobExtractionResponseSchema.safeParse(highConfidence);
      expect(result.success).toBe(true);
    });

    it('validates the low-confidence fixture', () => {
      const result = eobExtractionResponseSchema.safeParse(lowConfidence);
      expect(result.success).toBe(true);
    });

    it('validates the not-eob fixture', () => {
      const result = eobExtractionResponseSchema.safeParse(notEob);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid data', () => {
    it('rejects when is_eob is missing', () => {
      const data = { ...highConfidence, is_eob: undefined };
      delete (data as Record<string, unknown>).is_eob;
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('rejects confidence_score below 0', () => {
      const data = { ...notEob, confidence_score: -0.1 };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('rejects confidence_score above 1', () => {
      const data = { ...notEob, confidence_score: 1.1 };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('rejects non-boolean is_eob', () => {
      const data = { ...notEob, is_eob: 'yes' };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('rejects completely empty object', () => {
      const result = eobExtractionResponseSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('nullable fields', () => {
    it('accepts null insurance_name', () => {
      const data = { ...highConfidence, insurance_name: null };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('accepts null insurance_identifier', () => {
      const data = { ...highConfidence, insurance_identifier: null };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('accepts null address', () => {
      const data = { ...highConfidence, address: null };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('accepts null extraction_notes', () => {
      const data = { ...highConfidence, extraction_notes: null };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('accepts all nullable fields as null', () => {
      const data = {
        is_eob: true,
        confidence_score: 0.5,
        extraction_notes: null,
        insurance_name: null,
        insurance_identifier: null,
        address: null,
        city: null,
        state: null,
        zip_code: null,
        location_state: null,
        arbitration_phone: null,
        arbitration_fax: null,
        arbitration_email: null,
      };
      const result = eobExtractionResponseSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });
});
