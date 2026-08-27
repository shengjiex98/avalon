import { setTimeout as delay } from 'node:timers/promises';

const [, , portArg, expected, timeoutArg = '30'] = process.argv;
const port = Number(portArg);
const timeoutMs = Number(timeoutArg) * 1000;
const sha = /^[0-9a-f]{40}$/;

if (!Number.isInteger(port) || port < 1 || port > 65535 || !sha.test(expected ?? '') || timeoutMs < 1) {
  console.error('Usage: wait-for-health.mjs <port> <40-character-commit> [timeout-seconds]');
  process.exitCode = 64;
} else {
  const deadline = Date.now() + timeoutMs;
  let last = 'server did not answer';
  let matched = false;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = await response.json();
      last = `server reported ${health.commit ?? 'no commit'}`;
      if (response.ok && health.commit === expected) {
        process.stdout.write(`${JSON.stringify(health)}\n`);
        matched = true;
        break;
      }
    } catch (error) {
      last = error.message;
    }
    await delay(250);
  }

  if (!matched) {
    console.error(`Avalon did not serve ${expected}: ${last}`);
    process.exitCode = 1;
  }
}
