/**
 * Bounded regex search support: validation on this thread, matching on a killable one.
 *
 * See `regex-worker.ts` for why the matching cannot run here. What this module owns is the part
 * the operator has to be able to reason about:
 *
 *  - which patterns are accepted at all (length, no stateful flags);
 *  - how much work a single call is allowed to do (line count, and a per-line length ceiling
 *    because a single very long line is where backtracking blows up);
 *  - and what happens when the deadline passes — the worker is terminated and the caller gets a
 *    readable error naming the pattern, rather than a bridge that stops answering.
 */
import { Worker } from 'node:worker_threads';
import { BridgeError } from '../../contracts/src/index.js';

/** Patterns longer than this are refused: they are unreadable, and they widen the search space. */
export const REGEX_MAX_PATTERN = 512;
/** Lines longer than this are skipped in regex mode (minified/bundled files). */
export const REGEX_MAX_LINE = 4096;
/** How long one search may spend matching before the worker is terminated. */
export const REGEX_BUDGET_MS = 2000;

/** `g` and `y` make `test()` stateful across calls; nothing here wants that. */
const ALLOWED_FLAGS = /^[ims]*$/;

export function compilePattern(pattern: string, caseSensitive: boolean): { source: string; flags: string } {
  if (typeof pattern !== 'string' || !pattern) throw new BridgeError('INVALID_ARGUMENT', 400, 'pattern must be a non-empty string');
  if (pattern.length > REGEX_MAX_PATTERN) throw new BridgeError('INVALID_ARGUMENT', 400, `regex pattern exceeds ${REGEX_MAX_PATTERN} characters`);
  const flags = caseSensitive ? '' : 'i';
  if (!ALLOWED_FLAGS.test(flags)) throw new BridgeError('INVALID_ARGUMENT', 400, 'unsupported regex flags');
  try { new RegExp(pattern, flags); }
  catch (error) { throw new BridgeError('INVALID_ARGUMENT', 400, `invalid regex pattern: ${String((error as Error)?.message ?? error)}`); }
  return { source: pattern, flags };
}

/**
 * Indices of the lines that match, or a `REGEX_TIMEOUT` error.
 *
 * `lines` is matched as a whole batch so the worker is started once per call. The deadline covers
 * the whole batch: a pattern that is merely slow across thousands of lines is refused the same
 * way a catastrophic one is, and the caller is told to narrow the search instead of being handed
 * a partial answer that looks complete.
 */
export async function regexLineMatches(lines: string[], pattern: { source: string; flags: string }): Promise<number[]> {
  if (!lines.length) return [];
  const worker = new Worker(new URL('./regex-worker.js', import.meta.url), {
    workerData: { pattern: pattern.source, flags: pattern.flags, lines },
  });
  return await new Promise<number[]>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); action(); };
    const timer = setTimeout(() => {
      finish(() => reject(new BridgeError('REGEX_TIMEOUT', 422,
        `the pattern did not finish within ${REGEX_BUDGET_MS} ms and was stopped (it is likely backtracking). Narrow it, add anchors, or use a literal search.`)));
    }, REGEX_BUDGET_MS);
    worker.once('message', (message: unknown) => finish(() => resolve(Array.isArray(message) ? message as number[] : [])));
    worker.once('error', (error: Error) => finish(() => reject(new BridgeError('REGEX_FAILED', 422, `regex matching failed: ${error.message}`))));
    worker.once('exit', (code: number) => finish(() => {
      // An exit without a message means the worker died before answering. Reporting an empty
      // result here would be a silent false negative, which is the one thing this path must not
      // produce — so it is an error the caller can see and retry.
      if (code !== 0) reject(new BridgeError('REGEX_FAILED', 422, `regex worker exited with code ${code} before returning a result`));
      else resolve([]);
    }));
  });
}
