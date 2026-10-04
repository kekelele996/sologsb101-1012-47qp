/**
 * 器材库域业务逻辑（被 warehouseSlice / instrumentSlice 的 thunk 调用）：
 * - 在库仪器入库：容量上限校验，排不下的排队等下一批，空出位置 FIFO 补位
 * - 领用单：按台站码开单、库房照单发料（同一台仪器不能同时挂在两张没回收的单上）
 * - 对账：两侧按 台站码 + 序列号 比对；对不上先摆着（对账挂起）等确认；
 *   对账失败后库房这侧重试；中心认下的不退回，单据随认下回收销账
 */
import {
  createId,
  db,
  readStockCapacity,
  writeStockCapacity,
} from '@/utils/db';
import type { Instrument } from '@/types/instrument';
import type { SeisStation } from '@/types/station';
import {
  isOpenRequisition,
  issuedSerialsOf,
  type Requisition,
  type RequisitionDraft,
  type RequisitionItem,
  type RequisitionState,
  type StockInstrument,
} from '@/types/warehouse';
import { formatRequisitionCode } from '@/types/warehouse';

/** 业务错误：页面直接展示 message */
export class WarehouseError extends Error {}

/* ------------------------------ 查询辅助 ------------------------------ */

/** 在库仪器序列号是否冲突（在库域全局唯一） */
export async function findStockSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<StockInstrument | undefined> {
  const rows = await db.stockInstruments.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

/** 该序列号当前是否挂在某张「没回收」的领用单上 */
export async function findOpenRequisitionOfSerial(
  serialNo: string,
  excludeReqId?: string
): Promise<Requisition | undefined> {
  const open = await db.requisitions
    .where('state')
    .anyOf(['待发料', '已发料', '对账挂起'])
    .toArray();
  return open.find(
    (req) =>
      req.id !== excludeReqId &&
      issuedSerialsOf(req).includes(serialNo)
  );
}

/** 在库中可发料的同型号仪器（状态为「在库」） */
export async function findAvailableStock(model: string, type: string): Promise<StockInstrument | undefined> {
  const rows = await db.stockInstruments.where('state').equals('在库').toArray();
  return rows.find((row) => row.model === model && row.type === type);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------ 库容与排队 ------------------------------ */

/** 当前在库占用（仅状态「在库」计入容量；排队中 / 已出库 / 已核销 不计） */
export function usedCapacity(stock: StockInstrument[]): number {
  return stock.filter((row) => row.state === '在库').length;
}

/** 排队队首（queueNo 最小的排队仪器） */
export function queueHead(stock: StockInstrument[]): StockInstrument | null {
  const waiting = stock
    .filter((row) => row.state === '排队中' && row.queueNo !== null)
    .sort((a, b) => (a.queueNo ?? 0) - (b.queueNo ?? 0));
  return waiting[0] ?? null;
}

/**
 * 入库：在库容量还有位置则「在库」，否则「排队中」等下一批。
 * 返回落库行。
 */
export async function inboundStock(input: {
  type: StockInstrument['type'];
  model: string;
  serialNo: string;
  inboundDate: string;
  remark: string;
}): Promise<{ row: StockInstrument; enqueued: boolean }> {
  const serialNo = input.serialNo.trim();
  if (!serialNo) throw new WarehouseError('序列号不能为空');
  const conflict = await findStockSerialConflict(serialNo);
  if (conflict) throw new WarehouseError(`序列号「${serialNo}」在器材库已存在（${conflict.state}）`);

  const all = await db.stockInstruments.toArray();
  const capacity = readStockCapacity();
  const used = usedCapacity(all);
  const maxQueue = all.reduce((max, row) => Math.max(max, row.queueNo ?? 0), 0);
  const now = Date.now();
  const enqueued = used >= capacity;
  const row: StockInstrument = {
    id: createId('stk'),
    type: input.type,
    model: input.model.trim(),
    serialNo,
    inboundDate: input.inboundDate || todayStr(),
    state: enqueued ? '排队中' : '在库',
    requisitionId: null,
    queueNo: enqueued ? maxQueue + 1 : null,
    remark: input.remark.trim(),
    createdAt: now,
    updatedAt: now,
  };
  await db.stockInstruments.put(row);
  return { row, enqueued };
}

/**
 * 有空位时把队首仪器补进在库（FIFO）；返回被补位的仪器（没有则 null）。
 * capacity 显式传入，避免依赖 localStorage 回读（持久化可能不可用或滞后）。
 */
export async function promoteQueueHead(capacity: number = readStockCapacity()): Promise<StockInstrument | null> {
  const all = await db.stockInstruments.toArray();
  if (usedCapacity(all) >= capacity) return null;
  const head = queueHead(all);
  if (!head) return null;
  const now = Date.now();
  await db.stockInstruments.update(head.id, {
    state: '在库',
    queueNo: null,
    updatedAt: now,
  });
  // 其余排队项顺序前移，保持连续编号
  const rest = all
    .filter((row) => row.state === '排队中' && row.id !== head.id)
    .sort((a, b) => (a.queueNo ?? 0) - (b.queueNo ?? 0));
  let no = 1;
  for (const row of rest) {
    if (row.queueNo !== no) {
      await db.stockInstruments.update(row.id, { queueNo: no, updatedAt: now });
    }
    no += 1;
  }
  return { ...head, state: '在库', queueNo: null };
}

/** 调整库容上限；若放大后出现空位，自动把排队仪器 FIFO 补位 */
export async function setCapacity(nextCapacity: number): Promise<number> {
  if (!Number.isFinite(nextCapacity) || nextCapacity < 0) {
    throw new WarehouseError('库容上限应为非负整数');
  }
  writeStockCapacity(nextCapacity);
  // 逐台补位直到占满或队列为空（用刚设置的容量，不依赖回读）
  for (;;) {
    const promoted = await promoteQueueHead(nextCapacity);
    if (!promoted) break;
  }
  return nextCapacity;
}

/* ------------------------------ 领用单：开单 ------------------------------ */

/**
 * 台网中心按台站码开领用单（待发料）。
 * 台站码必须在台站名册中存在——库房只认名册上的台站码。
 */
export async function openRequisition(
  draft: RequisitionDraft,
  stations: SeisStation[]
): Promise<Requisition> {
  const stationCode = draft.stationCode.trim().toUpperCase();
  if (!stationCode) throw new WarehouseError('请填写台站码');
  const station = stations.find((row) => row.code.toUpperCase() === stationCode);
  if (!station) throw new WarehouseError(`台站码「${stationCode}」不在台站名册中，不能开单`);
  const items = draft.items
    .filter((item) => item.model.trim() && item.qty > 0)
    .map<RequisitionItem>((item, index) => ({
      lineNo: index + 1,
      type: item.type,
      model: item.model.trim(),
      qty: Math.floor(item.qty),
      serialNo: null,
      result: null,
      note: '',
    }));
  if (items.length === 0) throw new WarehouseError('请至少填写一行仪器型号与数量');

  const orderDate = todayStr();
  const seq = 1 + (await db.requisitions.where('code').startsWith(`LY-${orderDate.replace(/-/g, '')}`).count());
  const now = Date.now();
  const req: Requisition = {
    id: createId('rqy'),
    code: formatRequisitionCode(orderDate, seq),
    stationCode: station.code,
    purpose: draft.purpose.trim(),
    applicant: draft.applicant.trim(),
    orderDate,
    state: '待发料',
    items,
    issuedAt: null,
    recoveredAt: null,
    reconciledAt: null,
    retryCount: 0,
    reconcileNote: '',
    backfilled: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.requisitions.put(req);
  return req;
}

/* ------------------------------ 领用单：发料 ------------------------------ */

/**
 * 库房照单发料：逐行指定一台「在库」仪器序列号。
 * 约束：
 * - 仅「待发料」单可发料；
 * - 序列号必须在库（状态为「在库」）；
 * - 同一台仪器不能同时挂在两张没回收的单上。
 */
export async function issueRequisition(
  reqId: string,
  assignments: Array<{ lineNo: number; serialNo: string }>
): Promise<Requisition> {
  const req = await db.requisitions.get(reqId);
  if (!req) throw new WarehouseError('领用单不存在');
  if (req.state !== '待发料') throw new WarehouseError(`单据当前为「${req.state}」，不能发料`);

  const assignmentByLine = new Map(assignments.map((row) => [row.lineNo, row.serialNo.trim()]));
  const now = Date.now();
  const issuedDate = todayStr();

  await db.transaction('rw', [db.requisitions, db.stockInstruments], async () => {
    for (const item of req.items) {
      const serialNo = assignmentByLine.get(item.lineNo);
      if (!serialNo) throw new WarehouseError(`第 ${item.lineNo} 行还没有指定发料序列号`);
      const stock = await db.stockInstruments.where('serialNo').equals(serialNo).first();
      if (!stock) throw new WarehouseError(`序列号「${serialNo}」不在器材库，不能发料`);
      if (stock.state !== '在库') {
        // 已挂在没回收的单上：明确报占用冲突（同一台仪器不能同时挂两张没回收的单）
        const blocking = await findOpenRequisitionOfSerial(serialNo, req.id);
        if (blocking) {
          throw new WarehouseError(`「${serialNo}」已挂在未回收单据 ${blocking.code} 上，不能重复发料`);
        }
        throw new WarehouseError(`「${serialNo}」当前为「${stock.state}」，不在可发料在库状态`);
      }
      if (stock.model !== item.model || stock.type !== item.type) {
        throw new WarehouseError(
          `「${serialNo}」是 ${stock.type}/${stock.model}，与单据需求 ${item.type}/${item.model} 不符`
        );
      }
      const blocking = await findOpenRequisitionOfSerial(serialNo, req.id);
      if (blocking) {
        throw new WarehouseError(`「${serialNo}」已挂在未回收单据 ${blocking.code} 上，不能重复发料`);
      }
    }
    // 全部校验通过后一次性出库
    for (const item of req.items) {
      const serialNo = assignmentByLine.get(item.lineNo)!;
      const stock = (await db.stockInstruments.where('serialNo').equals(serialNo).first())!;
      await db.stockInstruments.update(stock.id, {
        state: '已出库',
        requisitionId: req.id,
        queueNo: null,
        updatedAt: now,
      });
      item.serialNo = serialNo;
      item.result = null;
      item.note = '';
    }
    req.state = '已发料';
    req.issuedAt = issuedDate;
    req.updatedAt = now;
    await db.requisitions.put(req);
  });

  // 出库后在库空出位置，排队队首自动补位（事务外，等待补位完成再返回，避免游离异步）
  await promoteQueueHead();
  return req;
}

/** 待发料单可取消：取消后单据关闭，不占用任何仪器 */
export async function cancelRequisition(reqId: string): Promise<void> {
  const req = await db.requisitions.get(reqId);
  if (!req) throw new WarehouseError('领用单不存在');
  if (req.state !== '待发料') throw new WarehouseError(`单据当前为「${req.state}」，仅待发料单可取消`);
  const now = Date.now();
  await db.requisitions.update(reqId, {
    state: '已取消',
    recoveredAt: todayStr(),
    updatedAt: now,
  } as never);
}

/* ------------------------------ 中心：上站安装 ------------------------------ */

export interface InstallSlotInput {
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string | null;
  requisitionId: string | null;
  installDate: string;
  state: Instrument['state'];
  remark: string;
}

/**
 * 台网中心登记上站安装：
 * - 若挂的是本站「已发料/挂起」领用单，按发料序列号回填安装位，并自动跑一次对账；
 * - 也可先登记没有序列号的安装位（待发料），后续发料回流。
 */
export async function installSlot(input: InstallSlotInput): Promise<{
  slot: Instrument;
  requisition: Requisition | null;
}> {
  const serialNo = input.serialNo?.trim() || null;
  let req: Requisition | null = null;
  if (input.requisitionId) {
    req = await db.requisitions.get(input.requisitionId) ?? null;
    if (!req) throw new WarehouseError('领用单不存在');
    const station = await db.stations.get(input.stationId);
    if (station && req.stationCode.toUpperCase() !== station.code.toUpperCase()) {
      throw new WarehouseError(`领用单 ${req.code} 属于台站 ${req.stationCode}，不能装到 ${station.code}`);
    }
  }
  const now = Date.now();
  const slot: Instrument = {
    id: createId('ins'),
    stationId: input.stationId,
    type: input.type,
    model: input.model.trim(),
    serialNo,
    installDate: input.installDate || todayStr(),
    state: input.state,
    requisitionId: input.requisitionId,
    reconcileResult: null,
    reconcileNote: '',
    remark: input.remark.trim(),
    createdAt: now,
    updatedAt: now,
  };
  await db.instruments.put(slot);
  if (req) {
    // 安装登记即触发一次库房侧对账（失败会挂起等确认）
    await reconcileAll();
  }
  return { slot, requisition: req };
}

/* ------------------------------ 对账引擎 ------------------------------ */

export interface ReconcileRow {
  requisition: Requisition;
  /** 每行：单据行 + 对上的安装位（可能为空） */
  lines: Array<{
    item: RequisitionItem;
    slot: Instrument | null;
    stationCode: string;
    matched: boolean;
    reason: string;
  }>;
}

/**
 * 全量对账：对每张「已发料 / 对账挂起」的单据，
 * 用 台站码（经 stations 表把安装位 stationId 翻成台站码）+ 序列号 与中心安装位比对。
 *
 * 规则：
 * - 对上：行结论「一致」；
 * - 对不上：行结论「挂起」，先摆着等确认（不覆盖已有「认下」结论）；
 * - 一张单所有行一致（或认下）→ 单据回收、出库仪器销账（已核销）；
 * - 还有挂起行 → 单据停留「对账挂起」，重试次数 +1（对账失败后库房这侧重试）。
 */
export async function reconcileAll(): Promise<{
  rows: ReconcileRow[];
  recovered: Requisition[];
  suspended: Requisition[];
}> {
  const [reqs, slots, stations] = await Promise.all([
    db.requisitions.where('state').anyOf(['已发料', '对账挂起']).toArray(),
    db.instruments.toArray(),
    db.stations.toArray(),
  ]);
  const stationCodeById = new Map(stations.map((station) => [station.id, station.code]));
  const now = Date.now();
  const date = todayStr();

  const rows: ReconcileRow[] = [];
  const recovered: Requisition[] = [];
  const suspended: Requisition[] = [];

  await db.transaction('rw', [db.requisitions, db.instruments, db.stockInstruments], async () => {
    for (const req of reqs) {
      // 已认下的行不再退回，跳过
      const lines = req.items.map((item) => {
        if (item.result === '认下') {
          return {
            item,
            slot: null,
            stationCode: req.stationCode,
            matched: true,
            reason: '中心已认下，不退回',
          };
        }
        // 安装位优先按领用单溯源 id 匹配，再按序列号兜底；台站码必须一致
        const candidates = slots.filter((slot) => {
          const code = stationCodeById.get(slot.stationId) ?? '';
          if (code.toUpperCase() !== req.stationCode.toUpperCase()) return false;
          if (!slot.serialNo) return false;
          if (slot.requisitionId === req.id) return true;
          return slot.serialNo === item.serialNo;
        });
        const slot = candidates.find((candidate) => candidate.serialNo === item.serialNo) ?? null;
        const matched = !!slot;
        return {
          item,
          slot,
          stationCode: req.stationCode,
          matched,
          reason: matched
            ? '台站码 + 序列号一致'
            : `台站 ${req.stationCode} 的安装位中找不到序列号「${item.serialNo ?? ''}」`,
        };
      });

      let hasSuspend = false;
      lines.forEach((line) => {
        if (line.item.result === '认下') return;
        if (line.matched) {
          line.item.result = '一致';
          line.item.note = line.reason;
        } else {
          line.item.result = '挂起';
          line.item.note = line.reason;
          hasSuspend = true;
        }
      });

      // 回写安装位对账结论
      for (const line of lines) {
        if (line.slot) {
          await db.instruments.update(line.slot.id, {
            reconcileResult: line.item.result === '认下' ? '认下' : line.matched ? '一致' : '挂起',
            reconcileNote: line.reason,
            updatedAt: now,
          });
        }
      }

      const pendingCount = lines.filter((line) => line.item.result === '挂起').length;
      req.reconciledAt = date;
      if (pendingCount === 0) {
        // 全部一致 / 认下 → 回收销账
        req.state = '已回收';
        req.recoveredAt = date;
        req.retryCount = 0;
        req.reconcileNote = '对账一致，单据已回收';
        req.updatedAt = now;
        await db.requisitions.put(req);
        for (const serialNo of issuedSerialsOf(req)) {
          const stock = await db.stockInstruments.where('serialNo').equals(serialNo).first();
          if (stock && stock.state === '已出库') {
            await db.stockInstruments.update(stock.id, {
              state: '已核销',
              requisitionId: null,
              updatedAt: now,
            });
          }
        }
        recovered.push(req);
      } else {
        // 对不上先摆着：库房这侧重试，计数 +1
        req.state = '对账挂起';
        req.retryCount += 1;
        req.reconcileNote = `存在 ${pendingCount} 行对不上，先摆着等确认（库房已重试 ${req.retryCount} 次）`;
        req.updatedAt = now;
        await db.requisitions.put(req);
        suspended.push(req);
      }
      rows.push({ requisition: req, lines });
    }
  });

  return { rows, recovered, suspended };
}

/**
 * 中心认下：对不上的单据，中心确认现状后认下，不退回。
 * 认下后整单回收、出库仪器销账；对应安装位（如有）标记「认下」。
 */
export async function acknowledgeRequisition(
  reqId: string,
  note: string
): Promise<Requisition> {
  const req = await db.requisitions.get(reqId);
  if (!req) throw new WarehouseError('领用单不存在');
  if (!isOpenRequisition(req.state)) throw new WarehouseError(`单据已${req.state}，无需认下`);
  const now = Date.now();
  const date = todayStr();

  // 台站名册是只读参照，在事务外解析 stationCode → stationId，避免跨表事务
  const stations = await db.stations.toArray();
  const stationIdByCode = new Map(
    stations.map((station) => [station.code.toUpperCase(), station.id])
  );
  const stationId = stationIdByCode.get(req.stationCode.toUpperCase());
  const slots = await db.instruments.toArray();

  await db.transaction('rw', [db.requisitions, db.instruments, db.stockInstruments], async () => {
    req.items.forEach((item) => {
      item.result = '认下';
      item.note = note.trim() || '中心认下，不退回';
    });
    req.state = '已回收';
    req.recoveredAt = date;
    req.reconciledAt = date;
    req.reconcileNote = `中心认下，不退回${note.trim() ? `：${note.trim()}` : ''}`;
    req.updatedAt = now;
    await db.requisitions.put(req);

    // 安装位（按单据 id 或台站码+序列号）一并标记认下
    for (const serialNo of issuedSerialsOf(req)) {
      const slot = slots.find(
        (candidate) =>
          (candidate.requisitionId === req.id ||
            (stationId && candidate.stationId === stationId && candidate.serialNo === serialNo))
      );
      if (slot) {
        await db.instruments.update(slot.id, {
          serialNo: slot.serialNo ?? serialNo,
          requisitionId: req.id,
          reconcileResult: '认下',
          reconcileNote: note.trim() || '中心认下，不退回',
          updatedAt: now,
        });
      }
      const stock = await db.stockInstruments.where('serialNo').equals(serialNo).first();
      if (stock && stock.state === '已出库') {
        await db.stockInstruments.update(stock.id, {
          state: '已核销',
          requisitionId: null,
          updatedAt: now,
        });
      }
    }
  });

  return req;
}

/** 库房手动重试对账（对账失败后库房这侧重试） */
export async function retryReconcile(): Promise<{
  recovered: number;
  suspended: number;
}> {
  const { recovered, suspended } = await reconcileAll();
  return { recovered: recovered.length, suspended: suspended.length };
}

/* ------------------------------ 升级问题处理 ------------------------------ */

/** 标记升级补单问题已人工处理（列出 → 确认） */
export async function resolveUpgradeIssue(issueId: string): Promise<void> {
  await db.upgradeIssues.update(issueId, { resolved: true, updatedAt: Date.now() } as never);
}

/** 领用单状态色板（页面共用） */
export function requisitionStateColor(state: RequisitionState): string {
  switch (state) {
    case '待发料':
      return 'orange';
    case '已发料':
      return 'blue';
    case '对账挂起':
      return 'red';
    case '已回收':
      return 'green';
    case '已取消':
      return 'default';
  }
}
