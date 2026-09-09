import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';
const [path, mode, workerId] = process.argv.slice(2);
if (mode === 'open') {
  process.send?.({ ready: true });
  process.once('message', () => {
    try {
      const store = createSqliteStore(path);
      store.close();
      process.send?.({ opened: true });
    } catch (error) {
      process.send?.({ error: String(error) });
    } finally {
      process.disconnect?.();
    }
  });
} else {
  const store = createSqliteStore(path);
  const q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
    limits: { leaseMs: 3000 },
  });
  if (mode === 'claim') {
    process.send?.({ ready: true });
    process.once('message', async () => {
      try {
        const runs = await q.claim({ workerId });
        process.send?.({ claims: runs.map((r) => r.ref) });
      } catch (error) {
        process.send?.({ error: String(error) });
      } finally {
        store.close();
        process.disconnect?.();
      }
    });
  } else if (mode === 'crash') {
    const [run] = await q.claim({ workerId });
    process.send?.({ claim: run?.ref });
    // Test parent kills this process only after receiving its durable claim receipt.
    setInterval(() => {}, 1000);
  } else if (mode === 'late') {
    process.send?.({ ready: true });
    process.on('message', async (message) => {
      if (message.ref) {
        try {
          await q.renew(message.ref);
          process.send?.({ unexpected: 'renewed' });
        } catch (error) {
          process.send?.({
            code: error?.code,
            name: error?.name ?? typeof error,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          store.close();
          process.disconnect?.();
        }
      }
    });
  }
}
