import type { EobExtractionResponse } from '../schemas/eob-extraction.schema';

export interface ValidationResult {
  readonly valid: boolean;
  readonly warnings: string[];
  readonly missingFields: string[];
}

const EXPECTED_FIELDS = [
  'insurance_name', 'insurance_identifier', 'address', 'city',
  'state', 'zip_code', 'location_state',
  'arbitration_phone', 'arbitration_fax', 'arbitration_email',
] as const;

export function validateBusinessRules(data: EobExtractionResponse): ValidationResult {
  const warnings: string[] = [];
  const missingFields: string[] = [];

  // Identify missing fields — informational only, never blocks
  if (data.is_eob) {
    for (const field of EXPECTED_FIELDS) {
      if (data[field] === null || data[field] === '') {
        missingFields.push(field);
      }
    }
  }

  // Format warnings (non-blocking)
  if (data.state !== null && data.state !== '' && !/^[A-Z]{2}$/i.test(data.state)) {
    warnings.push(`state format unusual: "${data.state}"`);
  }

  if (data.location_state !== null && data.location_state !== '' && !/^[A-Z]{2}$/i.test(data.location_state)) {
    warnings.push(`location_state format unusual: "${data.location_state}"`);
  }

  if (data.zip_code !== null && data.zip_code !== '' && !/^\d{5}(-\d{4})?$/.test(data.zip_code)) {
    warnings.push(`zip_code format unusual: "${data.zip_code}"`);
  }

  // Always valid — we store whatever was extracted and notify about missing fields
  return { valid: true, warnings, missingFields };
}
