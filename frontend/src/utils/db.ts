/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { Requisition } from '@/types/warehouse';
import { createRequisitionNo } from '@/types/warehouse';
import type { Installation } from '@/types/installation';
import type { ReconciliationRecord } from '@/types/reconciliation';
import { backfillForLegacyInstrument, computeReconciliation } from '@/utils/ledger';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
  backfillReport: 'gbseisarray:backfill-report',
} as const;

/** 升级补单报告（旧数据无领用单，升级时按安装日期补出，补不出来的列出来） */
export interface BackfillReport {
  /** 应补台数（有安装位的旧仪器数） */
  total: number;
  /** 成功补出台数 */
  done: number;
  /** 补不出来的清单 */
  failures: Array<{ serialNo: string; stationCode: string; installDate: string; reason: string }>;
  /** 补单时间（ISO 时间戳） */
  at: string;
}

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
  /** 器材库领用单 */
  requisitions: Requisition[];
  /** 台网中心仪器安装位 */
  installations: Installation[];
  /** 对账记录 */
  reconciliations: ReconciliationRecord[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  /** 器材库：领用单 */
  requisitions!: Table<Requisition, string>;
  /** 台网中心：仪器安装位 */
  installations!: Table<Installation, string>;
  /** 两边对账记录 */
  reconciliations!: Table<ReconciliationRecord, string>;

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

    // v3：台账拆分——器材库管在库仪器（入库日期/物流状态）与领用单，
    // 台网中心管安装位；两边按台站码 + 序列号对账。旧数据无领用单，升级时按安装日期补出。
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments:
          'id, stationId, type, model, serialNo, installDate, state, logisticsState, stockInDate, requisitionNo, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
        requisitions:
          'id, requisitionNo, stationCode, serialNo, issueDate, state, backfilled, recoveredAt, updatedAt',
        installations:
          'id, stationId, stationCode, serialNo, installDate, requisitionNo, state, acknowledged, updatedAt',
        reconciliations: 'id, stationCode, serialNo, result, failCount, lastAttemptAt, updatedAt',
      })
      .upgrade(async (tx) => {
        // v2 迁移：历史数据补齐时间戳与必填字段
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          [
            'instruments',
            () => ({
              type: '宽频带',
              model: '',
              state: '在用',
              remark: '',
              logisticsState: '已安装',
              requisitionNo: null,
              stockInDate: '',
            }),
          ],
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

        // v3 补单：旧数据领料和上站挤在一份记录里，没有领用单，
        // 升级时按安装日期补出领用单与安装位；补不出来的列入失败清单。
        const report = await backfillLegacyLedger(tx);
        stampBackfillReport(report);
      });
  }
}

export const db = new SeisArrayDatabase();

/**
 * v3 升级补单：旧数据领料和上站挤在仪器一份记录里、没有领用单，
 * 按安装日期补出器材库领用单与台网中心安装位；补不出来的（缺台站 / 台站码 /
 * 序列号 / 安装日期）列入失败清单，供升级后人工核对。幂等：已补过的不重复补。
 */
async function backfillLegacyLedger(tx: Dexie.Transaction): Promise<BackfillReport> {
  const now = Date.now();
  const [instruments, stations] = await Promise.all([
    tx.table('instruments').toArray() as Promise<Instrument[]>,
    tx.table('stations').toArray() as Promise<SeisStation[]>,
  ]);
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const failures: BackfillReport['failures'] = [];
  let done = 0;

  for (const instrument of instruments) {
    // 无安装位的是在库 / 排队仪器，不涉及补单
    if (!instrument.stationId) continue;
    const station = stationById.get(instrument.stationId);
    const stationCode = station?.code ?? '';
    const result = backfillForLegacyInstrument({ instrument, stationCode: stationCode || null, now });
    if (!result.ok || !result.requisition || !result.installation) {
      failures.push({
        serialNo: instrument.serialNo || '（缺序列号）',
        stationCode: stationCode || '（缺台站码）',
        installDate: instrument.installDate || '（缺安装日期）',
        reason: result.reason,
      });
      continue;
    }
    // 幂等：同序列号 + 同台站码已有安装位则跳过
    const existing = (await tx
      .table('installations')
      .where('serialNo')
      .equals(instrument.serialNo)
      .toArray()) as Installation[];
    if (existing.some((row) => row.stationCode === stationCode)) {
      done += 1;
      continue;
    }
    await tx.table('requisitions').put(result.requisition);
    await tx.table('installations').put(result.installation);
    await tx.table('instruments').update(instrument.id, {
      stockInDate: instrument.installDate,
      logisticsState: '已安装',
      requisitionNo: result.requisition.requisitionNo,
      updatedAt: now,
    });
    done += 1;
  }

  return { total: done + failures.length, done, failures, at: new Date(now).toISOString() };
}

/** 写入升级补单报告到 localStorage，供器材库 / 对账页展示 */
export function stampBackfillReport(report: BackfillReport): void {
  try {
    localStorage.setItem(LS_KEYS.backfillReport, JSON.stringify(report));
  } catch {
    // 忽略
  }
}

export function readBackfillReport(): BackfillReport | null {
  try {
    const raw = localStorage.getItem(LS_KEYS.backfillReport);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BackfillReport;
    return Array.isArray(parsed?.failures) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearBackfillReport(): void {
  try {
    localStorage.removeItem(LS_KEYS.backfillReport);
  } catch {
    // 忽略
  }
}

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
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
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
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
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 14 条标定 + 3 条更换，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及超期未标定样本。
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
              remark: '2024 年雷击损坏，已提交更换',
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
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
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

  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.requisitions,
      db.installations,
      db.reconciliations,
    ],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              stockInDate: instrumentRest.installDate,
              logisticsState: '已安装',
              requisitionNo: null,
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

      // 台账拆分：8 台已安装仪器补出器材库领用单（LYB 补单前缀）与台网中心安装位
      const requisitionRows: Requisition[] = [];
      const installationRows: Installation[] = [];
      instrumentRows.forEach((instrument) => {
        if (!instrument.stationId) return;
        const station = stationRows.find((row) => row.id === instrument.stationId);
        if (!station) return;
        const requisitionNo = createRequisitionNo('LYB', instrument.installDate ?? today);
        requisitionRows.push({
          id: createId('lyr'),
          requisitionNo,
          stationCode: station.code,
          serialNo: instrument.serialNo,
          issueDate: instrument.installDate ?? today,
          state: '已发料',
          backfilled: true,
          recoveredAt: null,
          remark: '升级补单（旧数据无领用单，按安装日期补出）',
          createdAt: now,
          updatedAt: now,
        });
        installationRows.push({
          id: createId('ist'),
          stationId: instrument.stationId,
          stationCode: station.code,
          serialNo: instrument.serialNo,
          installDate: instrument.installDate ?? today,
          requisitionNo,
          state: '在装',
          acknowledged: false,
          acknowledgedAt: null,
          remark: '升级补登安装位',
          createdAt: now,
          updatedAt: now,
        });
        instrument.requisitionNo = requisitionNo;
      });

      // 器材库另有 3 台未上站仪器：1 台在库、1 台已发料待上站、1 台排队等下一批
      const openReqNo = createRequisitionNo('LYD', today);
      requisitionRows.push({
        id: createId('lyr'),
        requisitionNo: openReqNo,
        stationCode: 'LTX03',
        serialNo: 'CMG-3E-20250601-99',
        issueDate: today,
        state: '已发料',
        backfilled: false,
        recoveredAt: null,
        remark: '新购仪器已开领用单，待上站安装',
        createdAt: now,
        updatedAt: now,
      });
      instrumentRows.push(
        {
          id: 'ins_wh_01',
          stationId: null,
          type: '宽频带',
          model: 'CMG-3ESPC',
          serialNo: 'CMG-3E-20250601-99',
          installDate: null,
          state: '在用',
          logisticsState: '已发料',
          stockInDate: daysAgo(40),
          requisitionNo: openReqNo,
          remark: '已开领用单，待上站',
          ...stamp(600),
        },
        {
          id: 'ins_wh_02',
          stationId: null,
          type: '强震',
          model: 'ES-T',
          serialNo: 'EST-20250715-12',
          installDate: null,
          state: '在用',
          logisticsState: '在库',
          stockInDate: daysAgo(20),
          requisitionNo: null,
          remark: '在库备份',
          ...stamp(601),
        },
        {
          id: 'ins_wh_03',
          stationId: null,
          type: '短周期',
          model: 'FSS-3B',
          serialNo: 'FSS3B-20250820-31',
          installDate: null,
          state: '在用',
          logisticsState: '排队',
          stockInDate: daysAgo(5),
          requisitionNo: null,
          remark: '库容排不下，等下一批',
          ...stamp(602),
        }
      );

      // 演示一笔对不上：中心侧有安装位，但库房无对应领用单
      installationRows.push({
        id: createId('ist'),
        stationId: 'stn_ltx_03',
        stationCode: 'LTX03',
        serialNo: 'UNKNOWN-001',
        installDate: '2023-09-02',
        requisitionNo: null,
        state: '在装',
        acknowledged: false,
        acknowledgedAt: null,
        remark: '中心侧有安装位，库房无对应领用单（演示差异）',
        createdAt: now,
        updatedAt: now,
      });

      // 按台站码 + 序列号对账，生成对账记录
      const reconciliationRows = computeReconciliation({
        installations: installationRows,
        requisitions: requisitionRows,
        now,
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
      await db.requisitions.bulkPut(requisitionRows);
      await db.installations.bulkPut(installationRows);
      await db.reconciliations.bulkPut(reconciliationRows);
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
      db.requisitions,
      db.installations,
      db.reconciliations,
    ],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.requisitions.clear(),
        db.installations.clear(),
        db.reconciliations.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, calibrations, replaces, requisitions, installations, reconciliations] =
    await Promise.all([
      db.arrays.count(),
      db.stations.count(),
      db.instruments.count(),
      db.calibrations.count(),
      db.replaces.count(),
      db.requisitions.count(),
      db.installations.count(),
      db.reconciliations.count(),
    ]);
  return { arrays, stations, instruments, calibrations, replaces, requisitions, installations, reconciliations };
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
