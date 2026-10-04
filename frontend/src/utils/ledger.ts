/**
 * 台账领域逻辑：台网中心安装位与器材库领用单的对账勾稽、
 * 旧数据升级补单、上站 / 拆回 / 入库流程的纯函数封装。
 * 页面与 slice 不直接拼装对账规则，统一走这里。
 */
import { createId } from '@/utils/db';
import type { Installation } from '@/types/installation';
import type { Requisition } from '@/types/warehouse';
import { createRequisitionNo } from '@/types/warehouse';
import type { ReconciliationRecord, ReconcileSide } from '@/types/reconciliation';
import type { Instrument, LogisticsState } from '@/types/instrument';

/** 对账行计算的输入（两台账当前快照） */
export interface ReconcileInput {
  installations: Installation[];
  requisitions: Requisition[];
  now?: number;
}

/**
 * 按（台站码 + 序列号）勾稽两边台账，生成对账记录：
 * - 两边一致（中心有在装安装位 + 库房有同站同序列号的已发料单）→ 平账（待中心认下）
 * - 中心有安装位但库房无对应单（或单开给了别的台站）→ 待确认（中心有位无单）
 * - 库房已发料但中心无安装位 → 待确认（库房有单无位）
 * 已认下的安装位对应记录为「已确认」，中心认下的不退回。
 */
export function computeReconciliation(input: ReconcileInput): ReconciliationRecord[] {
  const now = input.now ?? Date.now();
  const rows: ReconciliationRecord[] = [];
  const openReqs = input.requisitions.filter((req) => req.state === '已发料');
  const reqBySerial = new Map<string, Requisition[]>();
  openReqs.forEach((req) => {
    const list = reqBySerial.get(req.serialNo) ?? [];
    list.push(req);
    reqBySerial.set(req.serialNo, list);
  });
  const matchedReqIds = new Set<string>();

  input.installations
    .filter((inst) => inst.state === '在装')
    .forEach((inst) => {
      const candidates = reqBySerial.get(inst.serialNo) ?? [];
      const match = candidates.find((req) => req.stationCode === inst.stationCode);
      if (match) {
        matchedReqIds.add(match.id);
        rows.push(buildRow(inst, match, '两边一致', inst.acknowledged ? '已确认' : '平账', now));
      } else {
        // 中心有安装位，库房无同站同序列号的已发料单
        rows.push(buildRow(inst, null, '中心有位无单', inst.acknowledged ? '已确认' : '待确认', now));
      }
    });

  openReqs.forEach((req) => {
    if (matchedReqIds.has(req.id)) return;
    const inst = input.installations.find(
      (row) => row.state === '在装' && row.serialNo === req.serialNo && row.stationCode === req.stationCode
    );
    if (inst) return; // 已在上面按安装位生成过
    // 库房已发料，中心无安装位
    rows.push(buildRow(null, req, '库房有单无位', '待确认', now));
  });

  return rows.sort((a, b) =>
    a.stationCode.localeCompare(b.stationCode, 'zh-Hans-CN') ||
    a.serialNo.localeCompare(b.serialNo)
  );
}

function buildRow(
  inst: Installation | null,
  req: Requisition | null,
  side: ReconcileSide,
  result: ReconciliationRecord['result'],
  now: number
): ReconciliationRecord {
  return {
    id: createId('rec'),
    stationCode: inst?.stationCode ?? req?.stationCode ?? '',
    serialNo: inst?.serialNo ?? req?.serialNo ?? '',
    centerInstallDate: inst?.installDate ?? null,
    installationId: inst?.id ?? null,
    warehouseRequisitionNo: req?.requisitionNo ?? null,
    warehouseIssueDate: req?.issueDate ?? null,
    requisitionId: req?.id ?? null,
    side,
    result,
    failCount: 0,
    lastError: '',
    lastAttemptAt: now,
    acknowledgedAt: inst?.acknowledged ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 升级补单：旧数据没有领用单，升级时按安装日期补出领用单与安装位。
 * 返回补单结果；补不出来的（缺台站 / 缺台站码 / 缺序列号 / 缺安装日期）由调用方列入失败清单。
 */
export interface BackfillResult {
  ok: boolean;
  reason: string;
  requisition: Requisition | null;
  installation: Installation | null;
}

export function backfillForLegacyInstrument(args: {
  instrument: Instrument;
  stationCode: string | null;
  now: number;
}): BackfillResult {
  const { instrument, stationCode, now } = args;
  if (!stationCode) {
    return { ok: false, reason: '台站档案缺失或台站码为空，无法按台站码补单', requisition: null, installation: null };
  }
  if (!instrument.serialNo) {
    return { ok: false, reason: '序列号缺失，无法按序列号对账补单', requisition: null, installation: null };
  }
  if (!instrument.installDate) {
    return { ok: false, reason: '安装日期缺失，无法按安装日期补出领用单', requisition: null, installation: null };
  }
  const requisitionNo = createRequisitionNo('LYB', instrument.installDate);
  const requisition: Requisition = {
    id: createId('lyr'),
    requisitionNo,
    stationCode,
    serialNo: instrument.serialNo,
    issueDate: instrument.installDate,
    state: '已发料',
    backfilled: true,
    recoveredAt: null,
    remark: '升级补单（旧数据无领用单，按安装日期补出）',
    createdAt: now,
    updatedAt: now,
  };
  const installation: Installation = {
    id: createId('ist'),
    stationId: instrument.stationId ?? '',
    stationCode,
    serialNo: instrument.serialNo,
    installDate: instrument.installDate,
    requisitionNo,
    state: '在装',
    acknowledged: false,
    acknowledgedAt: null,
    remark: '升级补登安装位（旧数据无上站留痕）',
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, reason: '', requisition, installation };
}

/** 上站流程：开单 → 发料 → 登记安装位，返回应写入的各台账记录 */
export interface InstallFlowArgs {
  stationId: string;
  stationCode: string;
  serialNo: string;
  installDate: string;
  remark: string;
  now: number;
}

export interface InstallFlowResult {
  requisition: Requisition;
  installation: Installation;
  instrumentPatch: Partial<Instrument>;
}

export function buildInstallFlow(args: InstallFlowArgs): InstallFlowResult {
  const requisitionNo = createRequisitionNo('LYD', args.installDate);
  const requisition: Requisition = {
    id: createId('lyr'),
    requisitionNo,
    stationCode: args.stationCode,
    serialNo: args.serialNo,
    issueDate: args.installDate,
    state: '已发料',
    backfilled: false,
    recoveredAt: null,
    remark: args.remark,
    createdAt: args.now,
    updatedAt: args.now,
  };
  const installation: Installation = {
    id: createId('ist'),
    stationId: args.stationId,
    stationCode: args.stationCode,
    serialNo: args.serialNo,
    installDate: args.installDate,
    requisitionNo,
    state: '在装',
    acknowledged: false,
    acknowledgedAt: null,
    remark: args.remark,
    createdAt: args.now,
    updatedAt: args.now,
  };
  const instrumentPatch: Partial<Instrument> = {
    stationId: args.stationId,
    installDate: args.installDate,
    logisticsState: '已安装' as LogisticsState,
    requisitionNo,
    state: '在用',
    updatedAt: args.now,
  };
  return { requisition, installation, instrumentPatch };
}

/** 拆回流程：安装位已拆回、领用单已回收、仪器回库待验 */
export function buildRecoverFlow(args: {
  requisition: Requisition;
  installation: Installation | null;
  now: number;
}): { requisitionPatch: Partial<Requisition>; installationPatch: Partial<Installation> | null; instrumentPatch: Partial<Instrument> } {
  const { requisition, installation, now } = args;
  return {
    requisitionPatch: { state: '已回收', recoveredAt: new Date(now).toISOString().slice(0, 10), updatedAt: now },
    installationPatch: installation
      ? { state: '已拆回', updatedAt: now }
      : null,
    instrumentPatch: {
      logisticsState: '待回收' as LogisticsState,
      requisitionNo: null,
      stationId: null,
      installDate: null,
      updatedAt: now,
    },
  };
}
