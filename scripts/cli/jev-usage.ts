import { resolve } from 'node:path';
import { UsageLog, summarizeUsage } from '../../src/jev/usage.js';

const project = resolve(process.argv[2] ?? '.');
const sessionID = process.argv[3];
const log = new UsageLog(project);
const { records, unreadableLines } = await log.read();
const summary = summarizeUsage(sessionID ? records.filter(r => r.sessionID === sessionID) : records);
console.log(JSON.stringify({ project, log: log.path, ...(sessionID ? { sessionID } : {}),
  ...summary, unreadableLines,
  complete: unreadableLines === 0 && summary.unknownInputRequests === 0 && summary.unknownOutputRequests === 0,
  note: 'Token totals include reported usage only. Unknown or interrupted requests are not assumed free. No pricing or spending limits are applied.',
}, null, 2));
