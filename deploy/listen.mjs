// Wait on a deployment topic and start the updater when one arrives.
//
// The channel is deliberately untrusted. Anyone who learns the topic name can
// publish to it, so nothing here interprets what a message says: a body has to
// match the exact wake-up word, and the only thing a match can do is start one
// fixed reconciliation unit. Authority over *what*
// gets deployed remains in the published release pointer; the message is never
// sufficient authority by itself.
//
// Stream failures are routine for a long poll. Reconnect here with bounded
// backoff so a transient reset does not turn into a systemd crash loop.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/+$/, '');
const topic = process.env.NTFY_TOPIC;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

const TRIGGER = /^deploy$/;

let running = false;

function startUpdate() {
  if (running) return console.log('update already running; ignoring trigger');
  running = true;
  const child = spawn('systemctl', ['--user', 'start', 'avalon-update.service'], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    running = false;
    console.log(`avalon-update finished with code ${code}`);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function listenForever({
  serverUrl = server,
  topicName = topic,
  fetchImpl = fetch,
  sleep = delay,
} = {}) {
  if (!topicName) throw new Error('NTFY_TOPIC is not set; nothing to listen to');

  let retryMs = RETRY_MIN_MS;
  for (;;) {
    try {
      // since=1m covers a trigger published while this reconnects.
      const response = await fetchImpl(
        `${serverUrl}/${encodeURIComponent(topicName)}/json?since=1m`,
      );
      if (!response.ok) throw new Error(`subscribe failed: ${response.status}`);

      retryMs = RETRY_MIN_MS;
      console.log(`listening on ${serverUrl} for deployment triggers`); // never log the topic: it is the secret

      let buffer = '';
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        let split;
        while ((split = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, split).trim();
          buffer = buffer.slice(split + 1);
          if (!line) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // keepalives and anything else unparseable are not our problem
          }
          if (event.event !== 'message') continue;

          const message = String(event.message ?? '');
          if (TRIGGER.test(message)) startUpdate();
          else console.log(`ignored: ${message.slice(0, 60)}`);
        }
      }
      throw new Error('stream ended');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`listener disconnected: ${detail}; retrying in ${retryMs / 1000}s`);
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!topic) {
    console.error('NTFY_TOPIC is not set; nothing to listen to');
    process.exit(78); // EX_CONFIG
  }
  await listenForever();
}
