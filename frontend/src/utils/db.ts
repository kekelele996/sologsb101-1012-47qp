/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 安装位 → 标定 / 更换；
 *   器材库 → 在库仪器 / 领用单 / 排队 / 对账挂起 / 升级补单问题）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * v3 起账拆成两个域：
 * - 台网中心：arrays / stations / instruments（仪器安装位）
 * - 器材库：stockInstruments（在库仪器）/ requisitions（领用单）/ upgradeIssues（升级补单问题）
 * 两域以「台站码 + 序列号」对账，互不持有对方主键（安装位只挂领用单 id 做溯源）。
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type {
  Requisition,
  StockInstrument,
  UpgradeIssue,
} from '@/types/warehouse';
import { formatRequisitionCode } from '@/types/warehouse';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
  stockCapacity: 'gbseisarray:stock-capacity',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  stockInstruments: StockInstrument[];
  requisitions: Requisition[];
  upgradeIssues: UpgradeIssue[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  /** 台网中心：仪器安装位 */
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  /** 器材库：在库仪器 */
  stockInstruments!: Table<StockInstrument, string>;
  /** 器材库：领用单 */
  requisitions!: Table<Requisition, string>;
  /** 升级补单：补不出来的旧安装位清单 */
  upgradeIssues!: Table<UpgradeIssue, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：账拆两域——中心管台站名册与仪器安装位，器材库管在库仪器与领用单
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments:
          'id, stationId, type, model, serialNo, installDate, state, requisitionId, reconcileResult, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
        stockInstruments: 'id, type, model, serialNo, state, inboundDate, queueNo, requisitionId',
        requisitions: 'id, code, stationCode, state, orderDate, issuedAt, recoveredAt, backfilled, updatedAt',
        upgradeIssues: 'id, kind, resolved, instrumentId, createdAt',
      })
      .upgrade(async (tx) => {
        // 1) 历史数据先补齐时间戳与必填字段（沿用 v2 的补默认逻辑）
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          ['instruments', () => ({
            type: '宽频带',
            model: '',
            state: '在用',
            remark: '',
            requisitionId: null,
            reconcileResult: null,
            reconcileNote: '',
          })],
          ['calibrations', () => ({ sensitivity: 0, selfNoise: 0, responseVerdict: '待判定', agency: '' })],
          ['replaces', () => ({ state: '待更换', newSerialNo: '', operator: '' })],
        ];
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now();
              if (typeof row.createdAt !== 'number') row.createdAt = now;
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
              Object.assign(row, factory());
            });
        }

        // 2) 旧数据没有领用单：按安装日期给每个历史安装位补一张已回收领用单；
        //    缺台站码 / 缺序列号 / 序列号对不上的，补不出来，列入 upgradeIssues 并挂起等确认。
        const stations = await tx.table<SeisStation, string>('stations').toArray();
        const stationCodeById = new Map(stations.map((station) => [station.id, station.code]));
        const slots = await tx.table<Instrument, string>('instruments').toArray();
        const { requisitions, issues, slotPatches } = buildBackfill(slots, stationCodeById);
        if (requisitions.length > 0) {
          await tx.table<Requisition, string>('requisitions').bulkPut(requisitions);
        }
        if (issues.length > 0) {
          await tx.table<UpgradeIssue, string>('upgradeIssues').bulkPut(issues);
        }
        if (slotPatches.size > 0) {
          await tx
            .table<Instrument, string>('instruments')
            .toCollection()
            .modify((row: Instrument) => {
              const patch = slotPatches.get(row.id);
              if (patch) Object.assign(row, patch);
            });
        }
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/* --------------------------- 旧数据按安装日期补单 --------------------------- */

/**
 * 旧安装位（v2 instruments）→ 领用单补单。
 * 规则：
 * - 能解析出台站码、有序列号且序列号不与同批补单重复：补一张「已回收」领用单（发料/回收日期取安装日期），
 *   安装位标记「认下」（中心认下的不退回）；
 * - 台站码缺失 / 序列号缺失 / 序列号重复：补不出来，写问题清单，安装位挂起等确认。
 */
export function buildBackfill(
  slots: Instrument[],
  stationCodeById: Map<string, string>,
  stamp: number = Date.now()
): {
  requisitions: Requisition[];
  issues: UpgradeIssue[];
  slotPatches: Map<string, Partial<Instrument>>;
} {
  const requisitions: Requisition[] = [];
  const issues: UpgradeIssue[] = [];
  const slotPatches = new Map<string, Partial<Instrument>>();
  const seenSerials = new Set<string>();
  const seqByDate = new Map<string, number>();

  const sorted = [...slots].sort((a, b) => a.installDate.localeCompare(b.installDate));

  sorted.forEach((slot) => {
    const stationCode = stationCodeById.get(slot.stationId) ?? '';
    const serialNo = typeof slot.serialNo === 'string' ? slot.serialNo.trim() : '';
    const baseIssue = {
      instrumentId: slot.id,
      serialNo,
      stationCode,
      installDate: slot.installDate,
      resolved: false,
      createdAt: stamp,
      updatedAt: stamp,
    };

    if (!stationCode) {
      issues.push({
        id: createId('iss'),
        ...baseIssue,
        kind: '缺台站码',
        detail: `安装位（${slot.model ?? '未知型号'}）找不到所属台站，无法按台站码补领用单`,
      });
      slotPatches.set(slot.id, {
        requisitionId: null,
        reconcileResult: '挂起',
        reconcileNote: '升级补单失败：缺台站码，待确认',
      });
      return;
    }
    if (!serialNo) {
      issues.push({
        id: createId('iss'),
        ...baseIssue,
        kind: '缺序列号',
        detail: `台站 ${stationCode} 的安装位（${slot.model ?? '未知型号'}，安装于 ${slot.installDate}）没有序列号，无法补单`,
      });
      slotPatches.set(slot.id, {
        requisitionId: null,
        reconcileResult: '挂起',
        reconcileNote: '升级补单失败：缺序列号，待确认',
      });
      return;
    }
    if (seenSerials.has(serialNo)) {
      issues.push({
        id: createId('iss'),
        ...baseIssue,
        kind: '序列号重复',
        detail: `序列号「${serialNo}」在多个历史安装位上重复出现，无法确定对应哪张领用单`,
      });
      slotPatches.set(slot.id, {
        requisitionId: null,
        reconcileResult: '挂起',
        reconcileNote: '升级补单失败：序列号重复，待确认',
      });
      return;
    }
    seenSerials.add(serialNo);

    const seq = (seqByDate.get(slot.installDate) ?? 0) + 1;
    seqByDate.set(slot.installDate, seq);
    const req: Requisition = {
      id: createId('rqy'),
      code: formatRequisitionCode(slot.installDate, seq),
      stationCode,
      purpose: '旧数据升级补单（按安装日期）',
      applicant: '系统补单',
      orderDate: slot.installDate,
      state: '已回收',
      items: [
        {
          lineNo: 1,
          type: slot.type,
          model: slot.model,
          qty: 1,
          serialNo,
          result: '认下',
          note: '历史安装记录，中心认下不退回',
        },
      ],
      issuedAt: slot.installDate,
      recoveredAt: slot.installDate,
      reconciledAt: slot.installDate,
      retryCount: 0,
      reconcileNote: '升级按安装日期补出，中心已认下',
      backfilled: true,
      createdAt: stamp,
      updatedAt: stamp,
    };
    requisitions.push(req);
    slotPatches.set(slot.id, {
      requisitionId: req.id,
      reconcileResult: '认下',
      reconcileNote: '升级按安装日期补单，中心认下不退回',
    });
  });

  return { requisitions, issues, slotPatches };
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string | null;
  installDate: string;
  state: Instrument['state'];
  requisitionId?: string | null;
  reconcileResult?: Instrument['reconcileResult'];
  reconcileNote?: string;
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 11 个安装位（8 个历史安装 + 3 个在途），
 * 器材库侧覆盖：在库满容、2 台排队、3 张在途领用单（待发料 / 已发料待装 / 对账挂起）、
 * 1 张台站码对不上的挂起单、1 条升级补单问题。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20210418-02',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '备份仪器，已逾标定周期',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已提交更换；替换仪器已发料在途',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格',
                },
              ],
            },
            // 在途安装位：中心已按 LTX03 开单，等库房发料
            {
              id: 'ins_ltx03_new',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: null,
              installDate: today,
              state: '待标定',
              requisitionId: 'rqy_ltx03_pending',
              reconcileResult: null,
              reconcileNote: '',
              remark: '扩容安装位，领用单待发料',
              calibrations: [],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格',
                },
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，合格',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格',
                },
              ],
            },
            // 在途安装位：已发料，但上站时装的序列号与单发的不一致 → 对账挂起，等中心确认
            {
              id: 'ins_hx01_new',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20250808-1B',
              installDate: daysAgo(6),
              state: '待标定',
              requisitionId: 'rqy_hx01_issued',
              reconcileResult: '挂起',
              reconcileNote: '中心实际安装序列号与发料序列号不符，待确认（可认下）',
              remark: '备用强震通道，外业领用串号',
              calibrations: [],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20190926-05',
              installDate: '2019-09-26',
              state: '待标定',
              remark: '夜间自噪抬升，待复标',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '自噪接近上限，判定不合格',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250920-30',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '替换仪器已由器材库发料，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已回写',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  /* ----------------- 器材库：在库仪器（满容 6 台 + 2 台排队 + 3 台已出库） ----------------- */
  const stockInstruments: StockInstrument[] = [
    // 在库（占用库容 6/6）
    { id: 'stk_42', type: '宽频带', model: 'STS-2.5', serialNo: 'STS25-20250901-42', inboundDate: daysAgo(33), state: '在库', requisitionId: null, queueNo: null, remark: '预留给 LTX03 扩容', createdAt: now - 33 * 86400000, updatedAt: now - 33 * 86400000 },
    { id: 'stk_45', type: '宽频带', model: 'CMG-3ESPC', serialNo: 'CMG-3E-20250910-45', inboundDate: daysAgo(24), state: '在库', requisitionId: null, queueNo: null, remark: '', createdAt: now - 24 * 86400000, updatedAt: now - 24 * 86400000 },
    { id: 'stk_46', type: '短周期', model: 'FSS-3B', serialNo: 'FSS3B-20250912-46', inboundDate: daysAgo(22), state: '在库', requisitionId: null, queueNo: null, remark: '', createdAt: now - 22 * 86400000, updatedAt: now - 22 * 86400000 },
    { id: 'stk_47', type: '强震', model: 'GL-P2B', serialNo: 'GLP2B-20250915-47', inboundDate: daysAgo(19), state: '在库', requisitionId: null, queueNo: null, remark: '', createdAt: now - 19 * 86400000, updatedAt: now - 19 * 86400000 },
    { id: 'stk_48', type: '宽频带', model: 'Trillium-Compact', serialNo: 'TC-20250918-48', inboundDate: daysAgo(16), state: '在库', requisitionId: null, queueNo: null, remark: '', createdAt: now - 16 * 86400000, updatedAt: now - 16 * 86400000 },
    { id: 'stk_49', type: '短周期', model: 'CDJ-S2C', serialNo: 'CDJ-20250922-49', inboundDate: daysAgo(12), state: '在库', requisitionId: null, queueNo: null, remark: '', createdAt: now - 12 * 86400000, updatedAt: now - 12 * 86400000 },
    // 排队（库容已满，等下一批）
    { id: 'stk_50', type: '宽频带', model: 'CMG-3ESPC', serialNo: 'CMG-3E-20250925-50', inboundDate: daysAgo(9), state: '排队中', requisitionId: null, queueNo: 1, remark: '到货时库容已满', createdAt: now - 9 * 86400000, updatedAt: now - 9 * 86400000 },
    { id: 'stk_51', type: '强震', model: 'ES-T', serialNo: 'EST-20250928-51', inboundDate: daysAgo(7), state: '排队中', requisitionId: null, queueNo: 2, remark: '排队等下一批入库', createdAt: now - 7 * 86400000, updatedAt: now - 7 * 86400000 },
    // 已出库（挂在未回收领用单上）
    { id: 'stk_30', type: '短周期', model: 'L-4C-3D', serialNo: 'L4C-20250920-30', inboundDate: daysAgo(45), state: '已出库', requisitionId: 'rqy_ltx02_issued', queueNo: null, remark: '替换 LTX02 雷击损坏仪器', createdAt: now - 45 * 86400000, updatedAt: now - 3 * 86400000 },
    { id: 'stk_18', type: '强震', model: 'ES-T', serialNo: 'EST-20250808-18', inboundDate: daysAgo(60), state: '已出库', requisitionId: 'rqy_hx01_issued', queueNo: null, remark: 'HX01 备用强震通道', createdAt: now - 60 * 86400000, updatedAt: now - 6 * 86400000 },
    { id: 'stk_99', type: '宽频带', model: 'CMG-3ESPC', serialNo: 'CMG-3E-20240101-99', inboundDate: daysAgo(300), state: '已出库', requisitionId: 'rqy_hx09_orphan', queueNo: null, remark: '台站码 HX09 在名册中查无此站', createdAt: now - 300 * 86400000, updatedAt: now - 40 * 86400000 },
  ];

  /* ----------------- 器材库：领用单（1 待发料 / 2 已发料含 1 挂起 / 1 台站码挂起） ----------------- */
  const requisitions: Requisition[] = [
    {
      id: 'rqy_ltx03_pending',
      code: formatRequisitionCode(today, 1),
      stationCode: 'LTX03',
      purpose: '台阵扩容，新增宽频带观测通道',
      applicant: '林之遥',
      orderDate: today,
      state: '待发料',
      items: [{ lineNo: 1, type: '宽频带', model: 'STS-2.5', qty: 1, serialNo: null, result: null, note: '' }],
      issuedAt: null,
      recoveredAt: null,
      reconciledAt: null,
      retryCount: 0,
      reconcileNote: '',
      backfilled: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rqy_ltx02_issued',
      code: formatRequisitionCode(daysAgo(3), 1),
      stationCode: 'LTX02',
      purpose: '替换雷击损坏的短周期仪器',
      applicant: '周渝',
      orderDate: daysAgo(4),
      state: '已发料',
      items: [
        { lineNo: 1, type: '短周期', model: 'L-4C-3D', qty: 1, serialNo: 'L4C-20250920-30', result: null, note: '' },
      ],
      issuedAt: daysAgo(3),
      recoveredAt: null,
      reconciledAt: null,
      retryCount: 0,
      reconcileNote: '',
      backfilled: false,
      createdAt: now - 4 * 86400000,
      updatedAt: now - 3 * 86400000,
    },
    {
      id: 'rqy_hx01_issued',
      code: formatRequisitionCode(daysAgo(8), 1),
      stationCode: 'HX01',
      purpose: '海岛台增补备用强震通道',
      applicant: '陈立群',
      orderDate: daysAgo(9),
      state: '对账挂起',
      items: [
        {
          lineNo: 1,
          type: '强震',
          model: 'ES-T',
          qty: 1,
          serialNo: 'EST-20250808-18',
          result: '挂起',
          note: '中心安装位实际序列号为 EST-20250808-1B，与发料序列号不符',
        },
      ],
      issuedAt: daysAgo(8),
      recoveredAt: null,
      reconciledAt: daysAgo(5),
      retryCount: 1,
      reconcileNote: '存在 1 行对不上：序列号不符，先摆着等确认，中心可认下',
      backfilled: false,
      createdAt: now - 9 * 86400000,
      updatedAt: now - 5 * 86400000,
    },
    {
      id: 'rqy_hx09_orphan',
      code: formatRequisitionCode(daysAgo(45), 1),
      stationCode: 'HX09',
      purpose: '新建台首批仪器（台站尚未编入名册）',
      applicant: '外业班组',
      orderDate: daysAgo(46),
      state: '对账挂起',
      items: [
        {
          lineNo: 1,
          type: '宽频带',
          model: 'CMG-3ESPC',
          qty: 1,
          serialNo: 'CMG-3E-20240101-99',
          result: '挂起',
          note: '台站码 HX09 在台站名册中不存在，仪器去向待确认',
        },
      ],
      issuedAt: daysAgo(45),
      recoveredAt: null,
      reconciledAt: daysAgo(40),
      retryCount: 2,
      reconcileNote: '存在 1 行对不上：缺台站码，库房已重试 2 次，先摆着等确认',
      backfilled: false,
      createdAt: now - 46 * 86400000,
      updatedAt: now - 40 * 86400000,
    },
  ];

  /* ----------------- 升级补单问题清单（演示「补不出来的列出来」） ----------------- */
  const upgradeIssues: UpgradeIssue[] = [
    {
      id: 'iss_seed_legacy',
      kind: '缺台站码',
      instrumentId: 'ins_hx99_legacy',
      serialNo: 'CMG3E-20180101-00',
      stationCode: 'HX09',
      installDate: '2018-06-01',
      detail: '历史仪器档案指向的台站已在名册调整中撤销，无法按台站码补领用单',
      resolved: false,
      createdAt: now - 100 * 86400000,
      updatedAt: now - 100 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.stockInstruments,
      db.requisitions,
      db.upgradeIssues,
    ],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const seedSlotRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, requisitionId, reconcileResult, reconcileNote, ...instrumentRest } =
              instrumentSeed;
            seedSlotRows.push({
              ...instrumentRest,
              requisitionId: requisitionId ?? null,
              reconcileResult: reconcileResult ?? null,
              reconcileNote: reconcileNote ?? '',
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise
              );
              calibrationRows.push({
                ...calibrationSeed,
                responseVerdict: verdict,
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      // 历史安装位（8 个）按安装日期补单；在途安装位（带 requisitionId）不参与补单
      const historySlots = seedSlotRows.filter((slot) => slot.requisitionId === null);
      const stationCodeById = new Map(stationRows.map((station) => [station.id, station.code]));
      const { requisitions: backfilledReqs, slotPatches } = buildBackfill(
        historySlots,
        stationCodeById,
        now
      );
      const instrumentRows = seedSlotRows.map((slot) => ({ ...slot, ...(slotPatches.get(slot.id) ?? {}) }));

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
      await db.stockInstruments.bulkPut(stockInstruments);
      await db.requisitions.bulkPut([...backfilledReqs, ...requisitions]);
      await db.upgradeIssues.bulkPut(upgradeIssues);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.stockInstruments,
      db.requisitions,
      db.upgradeIssues,
    ],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.stockInstruments.clear(),
        db.requisitions.clear(),
        db.upgradeIssues.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  // 确保结构已建出（首次直接调用 reset 时表可能尚不存在），再清空并播种
  if (!db.isOpen()) await db.open();
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [
    arrays,
    stations,
    instruments,
    calibrations,
    replaces,
    stockInstruments,
    requisitions,
    upgradeIssues,
  ] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.replaces.count(),
    db.stockInstruments.count(),
    db.requisitions.count(),
    db.upgradeIssues.count(),
  ]);
  return { arrays, stations, instruments, calibrations, replaces, stockInstruments, requisitions, upgradeIssues };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/* ------------------------------ 库容上限（localStorage） ------------------------------ */

export function readStockCapacity(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.stockCapacity);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 6;
  } catch {
    return 6;
  }
}

export function writeStockCapacity(capacity: number): void {
  try {
    localStorage.setItem(LS_KEYS.stockCapacity, String(capacity));
  } catch {
    // 忽略
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
