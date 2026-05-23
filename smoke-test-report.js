import { buildValidationReport } from './dist/validation-report.js';

const inputDisagreement = {
  validationId: 'v1',
  status: 'partial',
  startedAt: new Date().toISOString(),
  intent: 'validate',
  originalRequest: { question: 'Is 2+2=5?' },
  modelList: ['claude', 'codex'],
  results: [
    {
      provider: 'claude',
      model: 'sonnet',
      status: 'completed',
      verdict: 'No',
      rationale: '2+2=4',
      risks: [],
      rawJobReference: { jobId: 'j1', correlationId: 'c1', statusTool: 'job_status', resultTool: 'job_result' }
    },
    {
      provider: 'codex',
      model: 'gpt-4',
      status: 'completed',
      verdict: 'Yes',
      rationale: 'In some bases maybe?',
      risks: ['Hallucination'],
      rawJobReference: { jobId: 'j2', correlationId: 'c2', statusTool: 'job_status', resultTool: 'job_result' }
    }
  ],
  synthesis: { status: 'not_requested', judgeModel: null, rawJobReference: null, note: '' }
};

const report = buildValidationReport(inputDisagreement);
console.log('Schema version:', report.schemaVersion);
console.log('Has material disagreement:', report.structuredContent.disagreements.hasMaterialDisagreement);
console.log('Confidence:', report.structuredContent.confidence);
console.log('Job IDs:', report.structuredContent.jobIds);
console.log('Human readable snippet:', report.humanReadable.split('\n').slice(0, 5).join('\n'));

if (report.schemaVersion !== 'validation-report.v1') throw new Error('Invalid schema version');
if (!report.structuredContent.disagreements.hasMaterialDisagreement) throw new Error('Should have disagreement');
if (report.structuredContent.confidence !== 'low') throw new Error('Confidence should be low');
if (report.structuredContent.jobIds.length !== 2) throw new Error('Should have 2 job IDs');
if (!report.humanReadable.includes('j1') || !report.humanReadable.includes('j2')) throw new Error('Job IDs missing from human report');

console.log('SMOKE TEST PASSED');
