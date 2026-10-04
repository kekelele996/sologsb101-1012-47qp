/**
 * 器材库域：在库仪器台账与领用单。
 *
 * 与「台网中心域」（types/station.ts 的台站名册、types/instrument.ts 的仪器安装位）
 * 通过 台站码（stationCode）+ 序列号（serialNo）对账，两侧都不直接持有对方主键。
 */
import type { InstrumentType } from '@/types/instrument';

/* ------------------------------ 在库仪器 ------------------------------ */

/**
 * 在库仪器状态：
 * - 排队中：到货时在库容量已满，先排队等下一批（FIFO）
 * - 在库：在库可发料
 * - 已出库：已照单发出、挂在未回收领用单上（同一台仪器不能同时挂两张没回收的单）
 * - 已核销：领用单回收（对账一致 / 中心认下）后随单销账，仪器留在台站，不再占用在库容量
 */
export type StockState = '排队中' | '在库' | '已出库' | '已核销';

export const STOCK_STATES: StockState[] = ['排队中', '在库', '已出库', '已核销'];

/** 在库仪器容量上限（台）：放不下的新入库仪器先排队等下一批 */
export const DEFAULT_STOCK_CAPACITY = 6;

/** 器材库在库仪器：序列号、入库日期由器材库维护 */
export interface StockInstrument {
  id: string;
  /** 仪器类型（与中心安装位口径一致） */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 序列号（在库仪器全局唯一） */
  serialNo: string;
  /** 入库日期 */
  inboundDate: string;
  /** 在库状态 */
  state: StockState;
  /** 当前挂载的领用单 id（仅 已出库 时有值；同一台仪器不能同时挂在两张没回收的单上） */
  requisitionId: string | null;
  /** 排队序号：排队中仪器按该序号 FIFO 等下一批 */
  queueNo: number | null;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------ 领用单 ------------------------------ */

/**
 * 领用单状态机：
 *   待发料 → 已发料 → 已回收（对账一致 / 中心认下）
 *                 ↘ 对账挂起 → 已回收（库房重试成功，或中心认下）
 *   待发料 → 已取消
 */
export type RequisitionState = '待发料' | '已发料' | '对账挂起' | '已回收' | '已取消';

export const REQUISITION_STATES: RequisitionState[] = [
  '待发料',
  '已发料',
  '对账挂起',
  '已回收',
  '已取消',
];

/** 未回收（仍占用仪器）的状态：同一台仪器不能同时挂在两张这类单上 */
export const OPEN_REQUISITION_STATES: RequisitionState[] = ['待发料', '已发料', '对账挂起'];

/** 对账结论 */
export type ReconcileResult = '一致' | '挂起' | '认下';

/** 领用单：按台站码开具，库房照单逐台发料 */
export interface Requisition {
  id: string;
  /** 领用单号，如 LY-20261004-0007 */
  code: string;
  /** 台站码（中心台站名册口径，如 LTX01） */
  stationCode: string;
  /** 申请说明 */
  purpose: string;
  /** 领用人 */
  applicant: string;
  /** 开单日期 */
  orderDate: string;
  state: RequisitionState;
  /** 明细行：一行对应一台仪器，发料后填上序列号 */
  items: RequisitionItem[];
  /** 发料日期（库房照单发料时填写） */
  issuedAt: string | null;
  /** 回收日期（对账一致 / 中心认下、单据闭环时填写） */
  recoveredAt: string | null;
  /** 最近一次对账日期 */
  reconciledAt: string | null;
  /** 库房侧重试次数（对账失败后由库房这侧重试） */
  retryCount: number;
  /** 对账说明（挂起原因 / 认下说明） */
  reconcileNote: string;
  /** 升级补单标记：旧数据没有领用单，v3 升级时按安装日期补出 */
  backfilled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 领用单明细行 */
export interface RequisitionItem {
  /** 行内序号（从 1 开始） */
  lineNo: number;
  type: InstrumentType;
  model: string;
  /** 需求数量（一般为 1，支持同型号多台） */
  qty: number;
  /** 发料序列号：待发料时为 null；发料后逐台确定 */
  serialNo: string | null;
  /**
   * 该行对账结论：
   * - null：尚未对账（待发料/已发料但还没比过）
   * - 一致：台站码 + 序列号与中心安装位对上
   * - 挂起：对不上，先摆着等确认
   * - 认下：中心认下，不退回
   */
  result: ReconcileResult | null;
  /** 该行对账备注（如中心实际序列号、台站码不一致原因） */
  note: string;
}

/** 开单草稿 */
export interface RequisitionDraft {
  stationCode: string;
  purpose: string;
  applicant: string;
  items: Array<{ type: InstrumentType; model: string; qty: number }>;
}

export function createEmptyRequisitionDraft(): RequisitionDraft {
  return {
    stationCode: '',
    purpose: '',
    applicant: '',
    items: [{ type: '宽频带', model: '', qty: 1 }],
  };
}

/* ------------------------------ 升级补单报告 ------------------------------ */

/**
 * 旧数据（v2 及以前）没有领用单，升级到 v3 时按安装日期补出。
 * 台站码或序列号缺失、补不出来的安装位写进该报告，列出来等人工确认。
 */
export interface UpgradeIssue {
  id: string;
  /** 问题类型：缺台站码（找不到台站名册）/ 缺序列号 / 序列号重复无法补单 */
  kind: '缺台站码' | '缺序列号' | '序列号重复';
  /** 中心安装位（旧仪器档案）id */
  instrumentId: string;
  /** 安装位上的原始序列号（可能为空） */
  serialNo: string;
  /** 解析出的台站码（可能为空） */
  stationCode: string;
  /** 安装日期（本应按它补单） */
  installDate: string;
  detail: string;
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------ 领域工具函数 ------------------------------ */

/** 领用单是否仍占用仪器（没回收） */
export function isOpenRequisition(state: RequisitionState): boolean {
  return (OPEN_REQUISITION_STATES as RequisitionState[]).includes(state);
}

/** 生成领用单号：LY-YYYYMMDD-序号 */
export function formatRequisitionCode(date: string, seq: number): string {
  const compact = date.replace(/-/g, '').slice(0, 8);
  return `LY-${compact}-${String(seq).padStart(4, '0')}`;
}

/** 领用单上已发料的序列号 */
export function issuedSerialsOf(req: Requisition): string[] {
  return req.items.map((item) => item.serialNo).filter((value): value is string => !!value);
}
