/**
 * Regex matching, on a thread that can be killed.
 *
 * JavaScript regular expressions can backtrack catastrophically: `(a+)+$` against a few hundred
 * `a`s takes longer than the age of the universe. The daemon is single-threaded and serves all
 * three ports from one event loop, so one hostile (or merely careless) pattern would freeze the
 * whole bridge — including the operator's ability to revoke. There is no linear-time engine
 * available here, so the work is moved to a worker that the caller terminates on a deadline.
 *
 * This file runs in that worker. It receives the lines to test and returns the indices that
 * matched. It deliberately does no I/O and holds no state.
 */
import { parentPort, workerData } from 'node:worker_threads';

interface Request { pattern: string; flags: string; lines: string[] }

const { pattern, flags, lines } = workerData as Request;
const expression = new RegExp(pattern, flags);
const hits: number[] = [];
for (let index = 0; index < lines.length; index += 1) {
  if (expression.test(lines[index]!)) hits.push(index);
}
parentPort?.postMessage(hits);
