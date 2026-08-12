import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { EobExtractorStack } from '../lib/eob-extractor-stack';

/**
 * Los PDFs de origen los escribe SendClickUpAttachmentsToS3 (stack de
 * Arbitration) pasando su propia llave SSE-KMS, que sobreescribe el default del
 * bucket. Este stack tiene que recibir kms:Decrypt sobre esa llave de forma
 * explicita.
 *
 * El 2026-08-10 faltaba, y el pipeline fallo 12 de 12 ejecuciones:
 *
 *   eob-validate-pdf is not authorized to perform: kms:Decrypt on
 *   key/4ae0f1f9... because no identity-based policy allows the kms:Decrypt action
 *
 * Lo que hace peligroso este fallo es que se arregla "de a poco": darle el
 * permiso solo al Lambda que aparece en el error mueve la falla al paso
 * siguiente, porque hay CUATRO funciones que leen el objeto del bucket.
 */

const SOURCE_KEY_ARN =
  'arn:aws:kms:us-east-1:165505826690:key/4ae0f1f9-a0e0-4d1a-8ff9-231bb18cadff';

/** Las funciones que LEEN un objeto del bucket de origen. */
const LECTORAS_DEL_BUCKET = ['Trigger', 'ValidatePdf', 'ClassifyEob', 'ExtractEob'];

function sintetizar(context: Record<string, unknown>): Template {
  const app = new cdk.App({ context: { account: '165505826690', ...context } });
  const stack = new EobExtractorStack(app, 'TestStack', {
    env: { account: '165505826690', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

/** Politicas IAM que otorgan kms:Decrypt sobre `keyArn`, por rol. */
function rolesConDecryptSobre(template: Template, keyArn: string): string[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const roles: string[] = [];
  for (const policy of Object.values(policies) as any[]) {
    const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
    const otorga = statements.some((s: any) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return (
        s.Effect === 'Allow' &&
        actions.some((a: unknown) => a === 'kms:Decrypt') &&
        resources.some((r: unknown) => JSON.stringify(r ?? '').includes(keyArn))
      );
    });
    if (otorga) roles.push(JSON.stringify(policy.Properties?.Roles ?? []));
  }
  return roles;
}

describe('grant de la llave KMS de origen', () => {
  it('otorga kms:Decrypt a TODAS las funciones que leen el bucket', () => {
    const template = sintetizar({
      bucketName: 'bucket-specialops',
      environment: 'production',
      sourceKmsKeyArn: SOURCE_KEY_ARN,
    });

    const roles = rolesConDecryptSobre(template, SOURCE_KEY_ARN);
    expect(
      roles.length,
      `se esperaban ${LECTORAS_DEL_BUCKET.length} roles con Decrypt sobre la llave ` +
        `de origen (${LECTORAS_DEL_BUCKET.join(', ')}), hay ${roles.length}. ` +
        'Otorgarlo a menos mueve el fallo al paso siguiente en vez de arreglarlo.',
    ).toBe(LECTORAS_DEL_BUCKET.length);
  });

  it('nombra la llave de origen exactamente, no con un comodin', () => {
    const template = sintetizar({
      bucketName: 'bucket-specialops',
      environment: 'production',
      sourceKmsKeyArn: SOURCE_KEY_ARN,
    });
    // Un Resource: "*" pasaria el test anterior y seria un agujero de seguridad.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.anyValue(),
            Effect: 'Allow',
            Resource: SOURCE_KEY_ARN,
          }),
        ]),
      }),
    });
  });

  it('solo Decrypt sobre la llave de origen — este stack no cifra con ella', () => {
    const template = sintetizar({
      bucketName: 'bucket-specialops',
      environment: 'production',
      sourceKmsKeyArn: SOURCE_KEY_ARN,
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const prohibidas = ['kms:Encrypt', 'kms:GenerateDataKey', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'];
    for (const policy of Object.values(policies) as any[]) {
      for (const s of policy.Properties?.PolicyDocument?.Statement ?? []) {
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        if (!resources.some((r: unknown) => JSON.stringify(r ?? '').includes(SOURCE_KEY_ARN))) continue;
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        for (const a of actions) {
          expect(
            prohibidas,
            `${a} sobre la llave de origen excede lo necesario: este stack escribe ` +
              'sus resultados con su propia llave (phiKey).',
          ).not.toContain(a);
        }
      }
    }
  });

  it('sin el contexto no referencia ninguna llave externa (sandbox intacto)', () => {
    const template = sintetizar({
      bucketName: 'bucket-specialops-sandbox',
      environment: 'sandbox',
    });
    expect(rolesConDecryptSobre(template, SOURCE_KEY_ARN)).toHaveLength(0);
    expect(JSON.stringify(template.toJSON())).not.toContain('4ae0f1f9');
  });

  it('resuelve la llave desde cdk.json SIN pasarla por -c', () => {
    // El test que fallo el 2026-08-10 comprobaba que el ARN estuviera en
    // cdk.json, no que el stack lo RESOLVIERA. tryGetContext('sourceKmsKeyArn')
    // busca una clave de primer nivel, asi que un valor dentro de
    // environments.production queda invisible y el deploy sale "exitoso" sin
    // aplicar nada. Este test sintetiza como lo hace el comando de deploy real:
    // pasando solo environment, con el resto viniendo de cdk.json.
    const cdkJson = JSON.parse(
      require('fs').readFileSync(require('path').join(__dirname, '../cdk.json'), 'utf8'),
    );
    const template = sintetizar({
      ...cdkJson.context,
      bucketName: 'bucket-specialops',
      environment: 'production',
    });
    expect(
      rolesConDecryptSobre(template, SOURCE_KEY_ARN).length,
      'el stack no resolvio sourceKmsKeyArn desde cdk.json: el deploy saldria ' +
        'exitoso sin aplicar el grant, que es exactamente el fallo del 2026-08-10',
    ).toBe(LECTORAS_DEL_BUCKET.length);
  });

  it('un -c explicito sobreescribe lo de cdk.json', () => {
    const otra = 'arn:aws:kms:us-east-1:165505826690:key/00000000-0000-0000-0000-000000000000';
    const template = sintetizar({
      bucketName: 'bucket-specialops',
      environment: 'production',
      sourceKmsKeyArn: otra,
    });
    expect(rolesConDecryptSobre(template, otra)).toHaveLength(LECTORAS_DEL_BUCKET.length);
  });
});
