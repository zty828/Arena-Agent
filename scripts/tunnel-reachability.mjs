#!/usr/bin/env node
/**
 * Tests which free SSH tunnel endpoints this host can actually reach, before
 * wiring one into the launcher. The host runs a Clash/Mihomo-style proxy, so
 * "the internet works" does not imply "port 22 to a tunnel service works".
 */
import net from 'node:net';

const targets = [
  { name: 'serveo.net', host: 'serveo.net', port: 22 },
  { name: 'localhost.run', host: 'localhost.run', port: 22 },
  { name: 'pinggy.io (443)', host: 'a.pinggy.io', port: 443 },
  { name: 'pinggy.io (22)', host: 'a.pinggy.io', port: 22 },
  { name: 'cloudflare edge (443)', host: 'one.one.one.one', port: 443 },
];

function probe({ host, port }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    const done = (ok, detail) => {
      socket.destroy();
      resolve({ ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(12000);
    socket.once('connect', () => done(true, 'connected'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error) => done(false, error.code ?? error.message));
  });
}

const results = [];
for (const target of targets) {
  const outcome = await probe(target);
  results.push({ ...target, reachable: outcome.ok, detail: outcome.detail, ms: outcome.ms });
}

const usable = results.filter((entry) => entry.reachable);
console.log(JSON.stringify({
  results,
  usable,
  verdict: usable.length
    ? `reachable: ${usable.map((entry) => `${entry.name}(${entry.port})`).join(', ')}`
    : 'no tunnel endpoint reachable from this host; the proxy is likely blocking outbound SSH',
}, null, 2));
