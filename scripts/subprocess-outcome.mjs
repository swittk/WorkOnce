import assert from 'node:assert/strict';

/** Return the combined stdout and stderr text of a synchronous child-process result. */
export function processOutput(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
}

function tail(output) {
  return output.slice(-4000);
}

/** Require spawnSync to have completed normally with a real numeric exit status. */
export function requireCompletedProcess(result, context = 'subprocess') {
  const output = processOutput(result);
  if (result?.error !== undefined) {
    const code = result.error?.code ? ` (${result.error.code})` : '';
    throw new Error(
      `${context} failed to execute${code}: ${result.error.message ?? String(result.error)}\n${tail(output)}`,
      {
        cause: result.error,
      },
    );
  }
  if (result?.signal !== null && result?.signal !== undefined)
    throw new Error(`${context} terminated by signal ${String(result.signal)}\n${tail(output)}`);
  if (!Number.isInteger(result?.status))
    throw new Error(`${context} did not produce a numeric exit status\n${tail(output)}`);
  return output;
}

/** Accept only a completed numeric nonzero exit as a mutation kill, optionally for an intended witness. */
export function requireExpectedProcessFailure(result, context, pattern) {
  const output = requireCompletedProcess(result, context);
  assert.notEqual(result.status, 0, `${context} unexpectedly passed\n${tail(output)}`);
  if (pattern) assert.match(output, pattern, `${context} failed for an unrelated reason`);
  return output;
}

/** Require a child to complete normally and exit zero, preserving infrastructure causes separately. */
export function requireSuccessfulProcess(result, context, pattern) {
  const output = requireCompletedProcess(result, context);
  assert.equal(
    result.status,
    0,
    `${context} exited with status ${String(result.status)}\n${tail(output)}`,
  );
  if (pattern)
    assert.match(output, pattern, `${context} output did not prove the expected witness`);
  return output;
}
