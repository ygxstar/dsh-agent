import type { SkillManifest } from './dsh-client.js';
import type { Logger } from './logger.js';

/** photo-story 风格分类（SKILL.md §风格分类）：id → 显示名 */
const PHOTO_STORY_CATEGORIES: Array<[string, string]> = [
  ['eastern', '东方故事类'],
  ['material', '模拟材质类'],
  ['painting', '绘画类'],
  ['nature', '自然类'],
  ['time', '时代氛围类'],
  ['digital', '数字媒体类'],
  ['anime', '日系动漫类'],
  ['illustration', '插画叙事类'],
  ['print', '版画印刷类'],
  ['editorial', '视觉编辑类'],
];

/** photo-story 风格名（references/styles/ 共 63 个，id = <分类>-<风格>） */
const PHOTO_STORY_STYLES: Array<[string, string]> = [
  ['anime-disney', '迪士尼风格'],
  ['anime-ghibli', '吉卜力风格'],
  ['anime-guochao', '新国潮风格'],
  ['anime-kyoto', '京都动画风格'],
  ['anime-marvel', '漫威风格'],
  ['anime-otomo', '大友克洋风格'],
  ['anime-pixar', '皮克斯风格'],
  ['anime-shinkai', '新海诚风格'],
  ['digital-block-world', '积木风格'],
  ['digital-fluid-raster', '流体光栅'],
  ['digital-fridge-magnet', '冰箱贴'],
  ['digital-pixel-art', '像素艺术'],
  ['digital-shell-pixel', '贝壳像素'],
  ['digital-torn-paper-poster', '撕纸海报'],
  ['digital-transparent-analysis', '透明解析'],
  ['digital-travel-journal', '旅行手账'],
  ['eastern-black-gold', '黑金风格'],
  ['eastern-chinese-xieyi', '中国写意'],
  ['eastern-cloud-realm', '东方云境'],
  ['eastern-dunhuang-mural', '敦煌壁画'],
  ['eastern-gold-foil-emboss', '金箔压纸'],
  ['eastern-ink-wash', '水墨写意'],
  ['eastern-jiangnan-light-color', '浅绛山水'],
  ['eastern-mogu-painting', '没骨画'],
  ['eastern-oriental-story', '东方故事'],
  ['eastern-relief-narrative', '浮雕叙事'],
  ['eastern-symbol-memory', '符号记忆'],
  ['eastern-zhise-qinglu', '只此青绿'],
  ['editorial-art-poster', '艺术海报'],
  ['editorial-cloth-collage', '布艺拼贴'],
  ['editorial-flat-poster', '扁平海报'],
  ['editorial-geometric-skeleton', '几何骨架'],
  ['editorial-ink-illustration', '水墨插画'],
  ['editorial-magazine-illustration', '杂志插画'],
  ['editorial-pantone-frame', '潘通相框海报'],
  ['editorial-paper-narrative', '纸面叙事'],
  ['editorial-postcard', '明信片'],
  ['illustration-children-book', '儿童绘本'],
  ['illustration-mbe', 'MBE插画'],
  ['illustration-misty-geometric', '朦胧几何插画'],
  ['illustration-naive', '稚拙插画'],
  ['material-embroidery', '刺绣'],
  ['material-knitting', '毛线编织'],
  ['material-origami', '折纸'],
  ['material-paper-cut', '剪纸'],
  ['material-sand-art', '沙画'],
  ['nature-leaf-collage', '树叶拼贴'],
  ['nature-light-shadow', '光影投影'],
  ['painting-charcoal', '炭笔画'],
  ['painting-childlike', '童真插画'],
  ['painting-line-drawing', '白描画'],
  ['painting-oil', '油画'],
  ['painting-pencil', '铅笔画'],
  ['painting-watercolor', '水彩画'],
  ['print-silkscreen', '丝网印刷'],
  ['print-ukiyoe', '浮世绘'],
  ['print-woodcut', '木刻版画'],
  ['time-cinematic-realism', '写实电影'],
  ['time-newspaper-print', '报纸印刷'],
  ['time-oil-print-woodcut', '油印版画'],
  ['time-temporal-construction', '时光筑建'],
  ['time-yellowed-letter', '泛黄信纸照片'],
  ['time-zen-minimal', '禅意简笔画'],
];

/**
 * 网关静态技能清单（gateway-interface §3）：仅元数据，不含提示词语义。
 * 只列 DSH 可执行技能（ADR-0007）；启动/定时与 dsh-webapi GET /skills 对账。
 * 全部 6 个技能需要源图（img2img）。
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
        density: { type: 'string', enum: ['coarse', 'fine'], enumLabels: ['粗网点', '细网点'], description: '网点密度' },
      },
      required: ['title'],
    },
  },
  {
    id: 'paperworldphoto',
    displayName: '纸艺微缩世界',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '标题' },
        subject_realism: { type: 'number', minimum: 0, maximum: 100, default: 92, description: '主体真实感' },
        scene_paperization: { type: 'number', minimum: 0, maximum: 100, default: 92, description: '场景纸艺化' },
        source_consistency: { type: 'number', minimum: 0, maximum: 100, default: 95, description: '与原图一致性' },
      },
      required: ['title'],
    },
  },
  {
    id: 'photo-story',
    displayName: '照片故事风格',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '标题' },
        category: {
          type: 'string',
          enum: PHOTO_STORY_CATEGORIES.map(([id]) => id),
          enumLabels: PHOTO_STORY_CATEGORIES.map(([, label]) => label),
          default: 'eastern',
          description: '风格分类',
        },
        style: {
          type: 'string',
          enum: PHOTO_STORY_STYLES.map(([id]) => id),
          enumLabels: PHOTO_STORY_STYLES.map(([, label]) => label),
          default: 'eastern-ink-wash',
          'x-filter': 'category',
          description: '风格名（按分类筛选）',
        },
      },
      required: ['title'],
    },
  },
  {
    id: 'real-qgraffiti-illusion',
    displayName: '涂鸦错觉人像',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '标题' },
      },
      required: ['title'],
    },
  },
  {
    id: 'second-world-poster',
    displayName: '第二世界海报',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '标题' },
      },
      required: ['title'],
    },
  },
  {
    id: 'western-animation-concept-portrait',
    displayName: '西方动画半身像',
    kind: 'img2img',
    requiresSourceImage: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 40, description: '标题' },
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
