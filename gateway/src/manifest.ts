import type { SkillManifest } from './dsh-client.js';
import type { Logger } from './logger.js';

/**
 * 网关静态技能清单（gateway-interface §3）：仅元数据，不含提示词语义。
 * 启动/定时与 dsh-webapi GET /skills 对账，不一致告警并降级为网关侧清单。
 */
export const STATIC_MANIFEST: SkillManifest[] = [
  {
    id: 'mono-color',
    displayName: '单色海报',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '海报标题' },
        density: { type: 'string', enum: ['coarse', 'fine'], description: '网点密度' },
      },
      required: ['title'],
    },
  },
  {
    id: 'duo-poster',
    displayName: '双色海报',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '海报标题' },
        palette: { type: 'string', enum: ['cobalt-ivory', 'ink-mint'], description: '配色' },
      },
      required: ['title'],
    },
  },
  {
    id: 'text-poster',
    displayName: '文字海报',
    kind: 'txt2img',
    requiresSourceImage: false,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '海报标题' },
        style: { type: 'string', enum: ['minimal', 'brutal'], description: '风格' },
      },
      required: ['title'],
    },
  },
];

export class ManifestStore {
  private skills: SkillManifest[] = STATIC_MANIFEST;
  private mismatch = false;

  constructor(private readonly log: Logger) {}

  list(): SkillManifest[] {
    return this.skills;
  }

  get(id: string): SkillManifest | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /** 与 dsh-webapi 技能清单对账；不一致则告警并保持网关侧清单 */
  reconcile(remote: SkillManifest[]): { ok: boolean; missing: string[]; extra: string[] } {
    const localIds = new Set(this.skills.map((s) => s.id));
    const remoteIds = new Set(remote.map((s) => s.id));
    const missing = [...localIds].filter((id) => !remoteIds.has(id));
    const extra = [...remoteIds].filter((id) => !localIds.has(id));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) {
      this.mismatch = true;
      this.log.warn('manifest.mismatch', { missing, extra, degraded: 'gateway' });
    } else {
      this.mismatch = false;
      this.log.info('manifest.reconciled', { count: this.skills.length });
    }
    return { ok, missing, extra };
  }

  get degraded(): boolean {
    return this.mismatch;
  }
}
