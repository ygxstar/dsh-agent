import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.js';
import { HttpDshClient, type DshClient } from './dsh-client.js';
import { CodeStore } from './code-store.js';
import { FileRegistry } from './files.js';
import { createAdminServer, createPublicServer, type HttpApiDeps } from './http-api.js';
import { createLogger, type Logger } from './logger.js';
import { ManifestStore } from './manifest.js';
import { Scheduler } from './scheduler.js';
import { TaskRuntime } from './task-runtime.js';
import { TokenStore } from './token-store.js';
import { Validator } from './validation.js';
import { WsServer } from './ws-server.js';

export interface CreateGatewayOptions {
  config?: Config;
  /** 注入 fake 用于单测；缺省为真实 HttpDshClient */
  dsh?: DshClient;
  log?: Logger;
}

export interface Gateway {
  config: Config;
  deps: HttpApiDeps;
  runtime: TaskRuntime;
  ws: WsServer;
  publicServer: Server;
  adminServer: Server;
  start(): Promise<void>;
  close(): Promise<void>;
  readonly publicUrl: string;
  readonly adminUrl: string;
  readonly wsUrl: string;
}

export async function createGateway(options: CreateGatewayOptions = {}): Promise<Gateway> {
  const config = options.config ?? loadConfig();
  const log = options.log ?? createLogger();
  const dsh = options.dsh ?? new HttpDshClient(config.dshBaseUrl, config.dshApiKey);

  const manifest = new ManifestStore(log);
  try {
    manifest.reconcile(await dsh.getSkills());
  } catch (err) {
    log.warn('manifest.reconcile_failed', { err: String(err), degraded: 'gateway' });
  }

  const tokens = new TokenStore();
  const codes = new CodeStore();
  const files = new FileRegistry();
  const scheduler = new Scheduler(config.maxConcurrentCells);
  const validator = new Validator({ manifest, files, commandRateLimit: config.commandRateLimit });
  const runtime = new TaskRuntime({ dsh, files, scheduler, tokens, log, stallTimeoutMs: config.stallTimeoutMs, taskTtlMs: config.taskTtlMs });

  const deps: HttpApiDeps = { config, tokens, codes, runtime, files, manifest, dsh, validator, log };
  const publicServer = createPublicServer(deps);
  const adminServer = createAdminServer(deps);
  const ws = new WsServer(deps);
  ws.attach(publicServer);
  runtime.onEmit((taskId, event) => ws.broadcast(taskId, event));

  let publicPort = config.port;
  let adminPort = config.adminPort;

  return {
    config,
    deps,
    runtime,
    ws,
    publicServer,
    adminServer,
    async start() {
      await new Promise<void>((resolve, reject) => {
        publicServer.once('error', reject);
        publicServer.listen(config.port, () => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        adminServer.once('error', reject);
        adminServer.listen(config.adminPort, config.adminHost, () => resolve());
      });
      publicPort = (publicServer.address() as AddressInfo).port;
      adminPort = (adminServer.address() as AddressInfo).port;
      runtime.startWatchdog();
      log.info('gateway.started', { publicPort, adminPort, adminHost: config.adminHost, staticDir: config.staticDir });
    },
    async close() {
      runtime.stopWatchdog();
      ws.close();
      await Promise.all([
        new Promise<void>((resolve) => publicServer.close(() => resolve())),
        new Promise<void>((resolve) => adminServer.close(() => resolve())),
      ]);
      log.info('gateway.closed', {});
    },
    get publicUrl() {
      return `http://127.0.0.1:${publicPort}`;
    },
    get adminUrl() {
      return `http://${config.adminHost}:${adminPort}`;
    },
    get wsUrl() {
      return `ws://127.0.0.1:${publicPort}/ws`;
    },
  };
}
