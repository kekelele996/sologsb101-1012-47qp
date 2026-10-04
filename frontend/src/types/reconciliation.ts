/**
 * 对账记录：台网中心安装位与器材库领用单按（台站码 + 序列号）勾稽的结果。
 * 对不上先摆着等确认；对账失败后库房这侧重试；中心认下的不退回。
 */

/** 对账结果：平账（两边一致，待中心认下）/ 待确认（对不上）/ 已确认（中心认下，不退回） */
export type ReconcileResult = '平账' | '待确认' | '已确认';

export const RECONCILE_RESULTS: ReconcileResult[] = ['平账', '待确认', '已确认'];

/** 差异方向：中心有安装位但库房无单 / 库房已发料但中心无安装位 */
export type ReconcileSide = '中心有位无单' | '库房有单无位' | '两边一致';

/** 对账记录：每个（台站码 + 序列号）一条 */
export interface ReconciliationRecord {
  id: string;
  /** 台站码（对账键之一） */
  stationCode: string;
  /** 序列号（对账键之二） */
  serialNo: string;
  /** 中心侧安装日期（YYYY-MM-DD），无安装位为 null */
  centerInstallDate: string | null;
  /** 中心侧安装位 id */
  installationId: string | null;
  /** 库房侧领用单号，无领用单为 null */
  warehouseRequisitionNo: string | null;
  /** 库房侧发料日期（YYYY-MM-DD），无领用单为 null */
  warehouseIssueDate: string | null;
  /** 库房侧领用单 id */
  requisitionId: string | null;
  /** 差异方向 */
  side: ReconcileSide;
  /** 对账结果 */
  result: ReconcileResult;
  /** 对账失败重试次数 */
  failCount: number;
  /** 最近一次失败原因（空串表示无失败） */
  lastError: string;
  /** 最近一次尝试时间（ISO 时间戳） */
  lastAttemptAt: number;
  /** 中心认下时间（ISO 时间戳），未认下为 null */
  acknowledgedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 对账汇总统计 */
export interface ReconcileSummary {
  total: number;
  matched: number;
  pending: number;
  acknowledged: number;
  failed: number;
}

export function summarizeReconciliation(records: ReconciliationRecord[]): ReconcileSummary {
  return {
    total: records.length,
    matched: records.filter((row) => row.result === '平账').length,
    pending: records.filter((row) => row.result === '待确认').length,
    acknowledged: records.filter((row) => row.result === '已确认').length,
    failed: records.filter((row) => row.lastError.length > 0).length,
  };
}
