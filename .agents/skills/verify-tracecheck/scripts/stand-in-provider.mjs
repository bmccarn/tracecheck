#!/usr/bin/env node
// A loopback stand-in for the System One API. It answers every question with a valid typed answer after a fixed
// latency, so review timing, failure handling, and cancellation can be observed without a key or provider cost.
// Usage: node .agents/skills/verify-tracecheck/scripts/stand-in-provider.mjs [--port 0] [--latency-ms 1000]
//          [--fail-path REGEX] [--fail-status 500] [--fail-times N]
// Point Tracecheck at it with TYPESAFE_BASE_URL=http://127.0.0.1:<port> and a placeholder TYPESAFE_API_KEY.
// A request whose changed source paths match --fail-path gets --fail-status, for the first N such requests when
// --fail-times is set. Prints `listening <port>`, then one JSON line per request with its packet, question count,
// requests in flight when it arrived, and status; a request the client abandons is logged with `aborted: true`.
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '0' }, 'latency-ms': { type: 'string', default: '1000' },
  'fail-path': { type: 'string' }, 'fail-status': { type: 'string', default: '500' }, 'fail-times': { type: 'string' },
} });
const latency = Number(values['latency-ms']);
const failPath = values['fail-path'] ? new RegExp(values['fail-path']) : undefined;
const failStatus = Number(values['fail-status']);
let failuresLeft = values['fail-times'] === undefined ? Infinity : Number(values['fail-times']);
let inFlight = 0;
let peak = 0;
let received = 0;

const spread = (keys, selected) => Object.fromEntries(keys.map(key => [key, key === selected ? 0.97 : 0.03 / (keys.length - 1)]));
function answer(id, question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.95 };
  if (question.type === 'score') {
    const keys = question.criteria.map((_value, index) => String(index));
    const selected = String(Math.min(7, keys.length - 1));
    return { type: 'score', score: Number(selected), confidence: 0.9, probabilities: spread(keys, selected),
      legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])) };
  }
  const keys = Object.keys(question.criteria);
  const selected = id.endsWith('_impact') ? 'medium' : ['supported', 'none'].find(key => keys.includes(key)) ?? keys[0];
  return { type: 'choice', choice: selected, confidence: 0.95, probabilities: spread(keys, selected) };
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const started = Date.now();
    const number = ++received;
    const atStart = ++inFlight;
    peak = Math.max(peak, inFlight);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
    const changed = (body?.state?.sources ?? []).filter(source => source.role === 'changed').map(source => source.path);
    const valid = request.method === 'POST' && request.url?.endsWith('/v1/systemone') && body?.questions;
    const fail = valid && failPath !== undefined && failuresLeft > 0 && changed.some(path => failPath.test(path));
    if (fail) failuresLeft--;
    const status = !valid ? 400 : fail ? failStatus : 200;
    const log = extra => console.log(JSON.stringify({ request: number, packetId: body?.state?.packetId, changed: changed.length,
      questions: Object.keys(body?.questions ?? {}).length, inFlightAtStart: atStart, peak, ...extra, ms: Date.now() - started }));
    const timer = setTimeout(() => {
      inFlight--;
      log({ status });
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' }).end('{"error":"stand-in failure"}');
        return;
      }
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(id, question)]));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'stand-in-provider-not-jev', answers,
        usage: { input_tokens: Math.round(Buffer.concat(chunks).length / 4), output_tokens: 5 * Object.keys(answers).length } }));
    }, latency);
    response.on('close', () => {
      if (response.writableFinished) return;
      clearTimeout(timer);
      inFlight--;
      log({ aborted: true });
    });
  });
});
server.listen(Number(values.port), '127.0.0.1', () => console.log(`listening ${server.address().port}`));
process.once('SIGTERM', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
process.once('SIGINT', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
