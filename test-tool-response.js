import { startValidationRun } from './dist/validation-orchestrator.js';

// Mock dependencies
const deps = {
  asyncJobManager: {
    startJob: () => ({ id: 'job-1', status: 'running', correlationId: 'c1' }),
  },
  getProviderRuntimeStatus: () => ({ installed: true, displayName: 'Fake' })
};

const toolResult = {
  success: true,
  tool: "validate_with_models",
  readMostly: true,
  report: startValidationRun(deps, {
    intent: "validate",
    question: "test",
    providers: ["claude"],
  }),
};

function responseText(body) {
  if (typeof body === "object" && body !== null && "report" in body) {
    const report = body.report;
    if (typeof report?.humanReadable === "string") return report.humanReadable;
  }
  return JSON.stringify(body, null, 2);
}

const text = responseText(toolResult);
console.log('Result length:', text.length);
if (text.startsWith('{')) {
  console.log('BUG DETECTED: Response is JSON instead of human-readable text');
  console.log('Body keys in "report":', Object.keys(toolResult.report));
  if (toolResult.report.report) {
    console.log('Human readable text is nested at toolResult.report.report.humanReadable');
  }
} else {
  console.log('No bug: Response is human-readable text');
}
