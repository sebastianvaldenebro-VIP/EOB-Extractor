import { z } from 'zod/v4';

export const eobExtractionResponseSchema = z.object({
  is_eob: z.boolean(),
  confidence_score: z.number().min(0).max(1),
  extraction_notes: z.nullable(z.string()),
  insurance_name: z.nullable(z.string()),
  insurance_identifier: z.nullable(z.string()),
  address: z.nullable(z.string()),
  city: z.nullable(z.string()),
  state: z.nullable(z.string()),
  zip_code: z.nullable(z.string()),
  location_state: z.nullable(z.string()),
  arbitration_phone: z.nullable(z.string()),
  arbitration_fax: z.nullable(z.string()),
  arbitration_email: z.nullable(z.string()),
});

export type EobExtractionResponse = z.infer<typeof eobExtractionResponseSchema>;
