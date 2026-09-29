import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComplianceReport } from '../src/domain/compliance.js';

test('matriz de conformidade não confunde contrato local com homologação', () => {
  const report = buildComplianceReport({ integrationMode: 'DEMO' });
  assert.equal(report.summary.total, 13);
  assert.equal(report.summary.implemented, 9);
  assert.equal(report.summary.pendingImplementation, 4);
  assert.equal(report.checks.every(item => item.verified === false), true);
  assert.match(report.disclaimer, /não substitui homologação oficial/);
});
