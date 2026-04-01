import { validateBusinessRules } from '../../../src/application/validation/business-rules';
import type { EobExtractionResponse } from '../../../src/application/schemas/eob-extraction.schema';
import highConfidence from '../../fixtures/sample-eob-responses/valid-high-confidence.json';
import notEob from '../../fixtures/sample-eob-responses/not-eob.json';

function buildValidEob(overrides: Partial<EobExtractionResponse> = {}): EobExtractionResponse {
  return { ...highConfidence, ...overrides } as EobExtractionResponse;
}

describe('validateBusinessRules', () => {
  it('always returns valid=true (never blocks)', () => {
    const result = validateBusinessRules(highConfidence as EobExtractionResponse);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.missingFields).toHaveLength(0);
  });

  it('reports missing fields for incomplete EOB', () => {
    const data = buildValidEob({ address: null, city: null, arbitration_fax: null });
    const result = validateBusinessRules(data);
    expect(result.valid).toBe(true);
    expect(result.missingFields).toContain('address');
    expect(result.missingFields).toContain('city');
    expect(result.missingFields).toContain('arbitration_fax');
  });

  it('reports no missing fields for non-EOB', () => {
    const result = validateBusinessRules(notEob as EobExtractionResponse);
    expect(result.valid).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });

  it('warns on unusual state format but stays valid', () => {
    const data = buildValidEob({ state: 'Illinois' });
    const result = validateBusinessRules(data);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('state'))).toBe(true);
  });

  it('warns on unusual zip_code format but stays valid', () => {
    const data = buildValidEob({ zip_code: '123' });
    const result = validateBusinessRules(data);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('zip_code'))).toBe(true);
  });

  it('no warnings for valid state abbreviation', () => {
    const data = buildValidEob({ state: 'CA' });
    const result = validateBusinessRules(data);
    expect(result.warnings).toHaveLength(0);
  });

  it('no warnings for valid zip codes', () => {
    expect(validateBusinessRules(buildValidEob({ zip_code: '60601' })).warnings).toHaveLength(0);
    expect(validateBusinessRules(buildValidEob({ zip_code: '60601-1234' })).warnings).toHaveLength(0);
  });

  it('treats empty strings as missing', () => {
    const data = buildValidEob({ insurance_name: '' });
    const result = validateBusinessRules(data);
    expect(result.missingFields).toContain('insurance_name');
  });
});
