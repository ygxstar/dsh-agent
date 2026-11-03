import { createStubDsh, type StubMode } from './stub.js';

/** 联调入口：STUB_PORT / STUB_API_KEY / STUB_MODE=ok|fail|stall / STUB_DELAY_MS */
async function main(): Promise<void> {
  const mode = (process.env.STUB_MODE ?? 'ok') as StubMode;
  if (!['ok', 'fail', 'stall'].includes(mode)) {
    console.error(`STUB_MODE 非法: ${mode}（须为 ok|fail|stall）`);
    process.exit(1);
  }
  const stub = await createStubDsh({
    port: Number(process.env.STUB_PORT ?? 3080),
    apiKey: process.env.STUB_API_KEY ?? 'stub-secret',
    mode,
    delayMs: Number(process.env.STUB_DELAY_MS ?? 0),
  });
  console.log(`stub-dsh listening: ${stub.baseUrl} mode=${stub.mode}`);

  const shutdown = async (): Promise<void> => {
    await stub.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
