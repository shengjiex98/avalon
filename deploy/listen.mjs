// Wait on a deployment topic and start the updater when one arrives.
//
// The channel is deliberately untrusted. Anyone who learns the topic name can
// publish to it, so nothing here interprets what a message says: a body has to
// match one exact shape, and the only thing a match can do is start a fixed
// unit template. Worst case, a stranger makes the controller compare one SHA
// with GitHub's current main. Authority over *what* gets deployed remains in
// the controller; the message is never sufficient authority by itself.
//
// Reconnection is systemd's job (Restart=always); this exits on any stream
// error and is started again a few seconds later.

import { spawn } from 'node:child_process';

const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/+$/, '');
const topic = process.env.NTFY_TOPIC;
if (!topic) {
  console.error('NTFY_TOPIC is not set; nothing to listen to');
  process.exit(78); // EX_CONFIG
}

// Capturing the SHA lets systemd preserve which trigger CI sent. The controller
// independently requires it to equal GitHub's current main before deployment.
const TRIGGER = /^deploy ([0-9a-f]{40})$/;

let running = false;

function startUpdate(commit) {
  if (running) return console.log('update already running; ignoring trigger');
  running = true;
  const child = spawn('systemctl', ['--user', 'start', `avalon-update@${commit}.service`], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    running = false;
    console.log(`avalon-update finished with code ${code}`);
  });
}

// since=1m so a trigger published while systemd was restarting this is not lost.
const response = await fetch(`${server}/${encodeURIComponent(topic)}/json?since=1m`);
if (!response.ok) {
  console.error(`subscribe failed: ${response.status}`);
  process.exit(1);
}
console.log(`listening on ${server} for deployment triggers`); // never log the topic: it is the secret

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
    const trigger = TRIGGER.exec(message);
    if (trigger) startUpdate(trigger[1]);
    else console.log(`ignored: ${message.slice(0, 60)}`);
  }
}

console.error('stream ended; exiting so systemd reconnects');
process.exit(1);
