import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { EobExtractorStack } from '../lib/eob-extractor-stack';

/**
 * Reintento del 429 de Lambda (concurrencia agotada).
 *
 * `retryOnServiceExceptions: true` NO cubre TooManyRequestsException: el retrier
 * que genera CDK lleva ClientExecutionTimeout, ServiceException,
 * AWSLambdaException y SdkClientException, y nada mas. Sin un retrier explicito
 * el 429 mata la ejecucion al primer rechazo.
 *
 * Paso el 2026-08-11: un lote de ~56 ejecuciones simultaneas contra classify-eob
 * y extract-eob, que tienen concurrencia reservada de 10, perdio 14 EOBs.
 *
 * El presupuesto tiene que ser largo porque lo que se espera es que DRENE la
 * cola, no un error transitorio: 10 ranuras y extract-eob con timeout de 300s
 * significa que un lote de 56 puede tardar media hora.
 */

const CONSTREÑIDAS = ['ClassifyEOB', 'ExtractEOB'] as const;
const PRESUPUESTO_MINIMO_MIN = 25;

function definicion(): any {
  const app = new cdk.App({
    context: {
      account: '165505826690',
      bucketName: 'bucket-specialops',
      environment: 'production',
    },
  });
  const stack = new EobExtractorStack(app, 'TestStack', {
    env: { account: '165505826690', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);
  const sms = template.findResources('AWS::StepFunctions::StateMachine');
  const sm: any = Object.values(sms)[0];
  const d = sm.Properties.DefinitionString;
  const texto = typeof d === 'string'
    ? d
    : d['Fn::Join'][1].filter((x: unknown) => typeof x === 'string').join('');
  return JSON.parse(texto);
}

/** Minutos totales de espera de un retrier: interval * sum(backoff^i). */
function presupuestoMinutos(retrier: any): number {
  let total = 0;
  for (let i = 0; i < retrier.MaxAttempts; i++) {
    total += retrier.IntervalSeconds * Math.pow(retrier.BackoffRate, i);
  }
  return total / 60;
}

function retrier429(estado: any): any | undefined {
  return (estado.Retry ?? []).find((r: any) =>
    (r.ErrorEquals ?? []).includes('Lambda.TooManyRequestsException'),
  );
}

describe('reintento de concurrencia agotada (429 de Lambda)', () => {
  const def = definicion();

  it.each(CONSTREÑIDAS)('%s reintenta el 429', (nombre) => {
    const estado = def.States[nombre];
    expect(estado, `el estado ${nombre} no existe`).toBeDefined();
    expect(
      retrier429(estado),
      `${nombre} tiene concurrencia reservada de 10 y sin retrier para ` +
        'Lambda.TooManyRequestsException un lote pierde EOBs. ' +
        'retryOnServiceExceptions NO cubre este error.',
    ).toBeDefined();
  });

  it.each(CONSTREÑIDAS)('%s espera lo suficiente para que drene la cola', (nombre) => {
    const r = retrier429(def.States[nombre]);
    const min = presupuestoMinutos(r);
    expect(
      min,
      `${min.toFixed(0)} min no alcanza: con 10 ranuras y extract-eob en 300s, ` +
        `un lote de 56 puede tardar media hora. Minimo ${PRESUPUESTO_MINIMO_MIN} min.`,
    ).toBeGreaterThanOrEqual(PRESUPUESTO_MINIMO_MIN);
  });

  it('el retrier del 429 no tapa el de throttling de Bedrock', () => {
    // Son errores distintos con presupuestos distintos: si un retrier de 429
    // listara tambien ThrottlingException, se comeria el de Bedrock por orden.
    for (const nombre of CONSTREÑIDAS) {
      const r = retrier429(def.States[nombre]);
      expect(r.ErrorEquals, `${nombre}: el retrier del 429 debe ser exclusivo`)
        .toEqual(['Lambda.TooManyRequestsException']);

      const bedrock = (def.States[nombre].Retry ?? []).find((x: any) =>
        (x.ErrorEquals ?? []).includes('ThrottlingException'),
      );
      expect(bedrock, `${nombre}: se perdio el retrier de Bedrock`).toBeDefined();
    }
  });

  it('CDK sigue sin cubrir el 429 por su cuenta', () => {
    // Si una version futura de CDK lo agrega a retryOnServiceExceptions, este
    // test avisa: habria dos retriers para el mismo error y ganaria el de CDK,
    // que tiene un presupuesto de 2 minutos.
    const generado = (def.States.ValidatePDF.Retry ?? []).find((r: any) =>
      (r.ErrorEquals ?? []).includes('Lambda.ServiceException'),
    );
    expect(generado, 'no se encontro el retrier que genera CDK').toBeDefined();
    expect(
      generado.ErrorEquals,
      'CDK ahora cubre el 429 en retryOnServiceExceptions: revisar el orden de ' +
        'los retriers, porque el suyo tiene un presupuesto de ~2 min y ganaria.',
    ).not.toContain('Lambda.TooManyRequestsException');
  });
});
