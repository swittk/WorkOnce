import { fork } from 'node:child_process';

const childInboxes = new WeakMap();

/** Attach a persistent IPC inbox before any child message can be lost between awaits. */
export function attachChildInbox(child, label = 'child') {
  const inbox = { messages: [], waiters: [], ended: undefined };
  childInboxes.set(child, inbox);
  child.on('message', (message) => {
    const waiter = inbox.waiters.shift();
    if (waiter) waiter.resolve(message);
    else inbox.messages.push(message);
  });
  const end = (error) => {
    if (inbox.ended) return;
    inbox.ended = error;
    for (const waiter of inbox.waiters.splice(0)) waiter.reject(error);
  };
  child.once('exit', (code, signal) =>
    end(
      new Error(
        `${label} exited before its next IPC message: code=${String(code)} signal=${String(signal)}`,
      ),
    ),
  );
  child.once('error', (error) =>
    end(new Error(`${label} process error: ${error.message}`, { cause: error })),
  );
  return child;
}

/** Fork a child and immediately attach its persistent IPC inbox. */
export function forkWithInbox(modulePath, args, options, label) {
  return attachChildInbox(fork(modulePath, args, options), label);
}

/** Consume a buffered child IPC message or await the next one with a bounded timeout. */
export function nextChildMessage(child, timeoutMs = 15000) {
  const inbox = childInboxes.get(child);
  if (!inbox) throw new Error('Child IPC inbox was not initialized');
  if (inbox.messages.length) return Promise.resolve(inbox.messages.shift());
  if (inbox.ended) return Promise.reject(inbox.ended);
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    };
    const timer = setTimeout(() => {
      const index = inbox.waiters.indexOf(waiter);
      if (index >= 0) inbox.waiters.splice(index, 1);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for child IPC message`));
    }, timeoutMs);
    inbox.waiters.push(waiter);
  });
}
