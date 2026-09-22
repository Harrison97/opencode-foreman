import { JevClient } from '../../src/jev/client.js';
const result = await new JevClient().choose(
  { current: 'VERIFY', requiredChecks: [{ command: 'node --test', exit: 1 }], result: 'A required assertion failed. The implementation needs correction.' },
  { IMPLEMENT: 'Fix an implementation after failed tests.', COMPLETE: 'All required tests passed and acceptance criteria are met.' },
  'Choose the next software engineering workflow state based on the actual test result.',
);
if (result.choice !== 'IMPLEMENT') throw new Error('Live Jev smoke selected an unexpected state');
console.log(JSON.stringify({ endpoint: 'https://api.typesafe.ai/v1/systemone', ...result }, null, 2));
