export interface ClassificationContext {
  readonly insurerName: string | null;
  readonly insurerIdentifier: string | null;
  readonly documentType: string;
}

export function buildExtractionUserPrompt(classification?: ClassificationContext): string {
  const insurerContext = classification?.insurerName
    ? `\nThis document has been pre-classified as an EOB from ${classification.insurerName}${classification.insurerIdentifier ? ` (Payer ID: ${classification.insurerIdentifier})` : ''}. Use this context to guide your extraction but verify against the document content.`
    : '';

  return `Extract the insurance company details and arbitration/appeals contact information from this EOB document.${insurerContext}

Return a single JSON object with the following schema:

{
  "is_eob": boolean,
  "confidence_score": number (0.0-1.0),
  "extraction_notes": string | null,
  "insurance_name": string | null,
  "insurance_identifier": string | null,
  "address": string | null,
  "city": string | null,
  "state": string | null,
  "zip_code": string | null,
  "location_state": string | null,
  "arbitration_phone": string | null,
  "arbitration_fax": string | null,
  "arbitration_email": string | null
}

Field definitions:
- insurance_name: The name of the insurance company (e.g., "Blue Cross Blue Shield of Illinois")
- insurance_identifier: The payer ID, plan number, or insurance company identifier
- address: The mailing address of the insurance company (street address only)
- city: City of the insurance company address
- state: State abbreviation of the insurance company address (e.g., "IL")
- zip_code: ZIP code of the insurance company address
- location_state: The state where the insurance plan is located/regulated (may differ from mailing address state)
- arbitration_phone: Phone number for appeals, grievances, or arbitration
- arbitration_fax: Fax number for appeals, grievances, or arbitration
- arbitration_email: Email address for appeals, grievances, or arbitration

IMPORTANT:
- Return exactly ONE record — do not return arrays or multiple objects.
- If the document is not an EOB, set is_eob to false and all other fields to null.
- Look for appeals/grievance/arbitration contact info in sections like "How to Appeal", "Your Rights", "Grievance Process", "Contact Us", or the footer.
- Return ONLY the JSON object. No markdown, no explanation.`;
}
