/**
 * 器材库台账：在库仪器与领用单。
 * 器材库只管在库仪器的序列号、入库日期与领用单；
 * 台站名册与仪器安装位归台网中心（types/installation.ts），两边按台站码 + 序列号对账。
 */

/** 领用单状态：已发料（未回收）/ 已回收 */
export type RequisitionState = '已发料' | '已回收';

export const REQUISITION_STATES: RequisitionState[] = ['已发料', '已回收'];

/**
 * 领用单：要上仪器时按台站码开单，库房照单发料。
 * 同一台仪器不能同时挂在两张没回收（已发料）的单上。
 */
export interface Requisition {
  id: string;
  /** 领用单号，如 LYD20261004-AB12（升级补单前缀为 LYB） */
  requisitionNo: string;
  /** 台站码（对账键之一） */
  stationCode: string;
  /** 领用仪器序列号（对账键之二） */
  serialNo: string;
  /** 发料日期（YYYY-MM-DD） */
  issueDate: string;
  /** 状态 */
  state: RequisitionState;
  /** 是否为升级时按安装日期补出的旧单 */
  backfilled: boolean;
  /** 回收日期（YYYY-MM-DD），未回收为 null */
  recoveredAt: string | null;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 领用单草稿（开单表单用） */
export interface RequisitionDraft {
  stationCode: string;
  serialNo: string;
  issueDate: string;
  remark: string;
}

export function createEmptyRequisitionDraft(): RequisitionDraft {
  return {
    stationCode: '',
    serialNo: '',
    issueDate: new Date().toISOString().slice(0, 10),
    remark: '',
  };
}

/** 在库仪器容量上限（排不下的先排队等下一批），可由 localStorage 覆盖 */
export const DEFAULT_WAREHOUSE_CAPACITY = 20;

export const LS_WAREHOUSE_CAPACITY = 'gbseisarray:warehouse-capacity';

/** 读取器材库在库容量上限（默认 20，可在器材库页调整） */
export function getWarehouseCapacity(): number {
  try {
    const raw = localStorage.getItem(LS_WAREHOUSE_CAPACITY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  } catch {
    // 隐私模式下忽略
  }
  return DEFAULT_WAREHOUSE_CAPACITY;
}

export function setWarehouseCapacity(capacity: number): void {
  try {
    localStorage.setItem(LS_WAREHOUSE_CAPACITY, String(capacity));
  } catch {
    // 忽略
  }
}

/**
 * 生成领用单号：LYD（正常领用）/ LYB（升级补单）+ 日期 + 随机串。
 */
export function createRequisitionNo(prefix: 'LYD' | 'LYB', date: string): string {
  const compact = (date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}${compact}-${rand}`;
}
