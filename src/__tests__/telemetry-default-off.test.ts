// @invariant NN-02
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * NN-02: no telemetry by default. src/utils/logger.ts installs the OTLP transport at import time, only when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (logger.ts ~line 78). Because that decision happens on import, each case runs
 * in its own `bun -e` subprocess with a throwaway HOME, and is checked two ways:
 *  - structurally: the global OTel LoggerProvider is still the API's no-op proxy (no SDK provider was registered);
 *  - behaviourally: a local OTLP receiver counts the /v1/logs POSTs the process made after logging a line.
 * The "off" case also points the signal-specific OTEL_EXPORTER_OTLP_LOGS_ENDPOINT at the receiver, so a change that
 * made the exporter default-on (falling back to that variable or to localhost:4318) would be caught too.
 */

const ROOT = resolve(import.meta.dir, '..', '..');
const LOGGER = join(ROOT, 'src', 'utils', 'logger.ts');

const PROBE = `
const { logger } = await import(${JSON.stringify(LOGGER)});
await Bun.sleep(400); // the OTel transport is attached by a fire-and-forget dynamic import
const { logs } = await import('@opentelemetry/api-logs');
const provider = logs.getLoggerProvider();
logger.info('telemetry probe FAKE (dummy)', { amount: -12.34 });
await logger.shutdown();
console.log('RESULT ' + JSON.stringify({ provider: provider.constructor.name }));
`;

let receiver: ReturnType<typeof Bun.serve>;
let hits: string[] = [];
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'oa-otel-home-'));
  receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      hits.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    },
  });
});

afterAll(() => {
  receiver.stop(true);
  rmSync(home, { recursive: true, force: true });
});

async function probe(extraEnv: Record<string, string>): Promise<{ provider: string; hits: string[]; out: string }> {
  hits = [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('OTEL_')) env[k] = v;
  }
  Object.assign(env, { HOME: home, OA_DEBUG: '0' }, extraEnv);
  // Async spawn (not spawnSync) so this process can keep answering the receiver while the child runs.
  const child = Bun.spawn(['bun', '-e', PROBE], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`probe printed no RESULT (exit ${child.exitCode}):\n${out}\n${err}`);
  return { ...(JSON.parse(line.slice(7)) as { provider: string }), hits: [...hits], out };
}

describe('NN-02 telemetry is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
  test('unset: no OTel provider is registered and nothing is exported', async () => {
    const r = await probe({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${receiver.port}/v1/logs` });
    expect(r.provider).toBe('ProxyLoggerProvider');
    expect(r.hits).toEqual([]);
  }, 20_000);

  test('set: the SDK provider is registered and the log line is exported to that endpoint (control)', async () => {
    const r = await probe({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}` });
    expect(r.provider).toBe('LoggerProvider');
    expect(r.hits).toContain('POST /v1/logs');
  }, 20_000);
});
