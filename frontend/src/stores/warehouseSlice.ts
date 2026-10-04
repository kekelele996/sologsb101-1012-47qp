/**
 * 器材库 slice：在库仪器物流、领用单、排队与两边对账。
 * 器材库管在库仪器的序列号、入库日期与领用单；台站名册与安装位归台网中心。
 * 要上仪器时按台站码开领用单，库房照单发料；同一台仪器不能同时挂在两张没回收的单上。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable, readBackfillReport, type BackfillReport } from '@/utils/db';
import type { Instrument } from '@/types/instrument';
import type { Requisition } from '@/types/warehouse';
import {
  createRequisitionNo,
  getWarehouseCapacity,
  setWarehouseCapacity,
} from '@/types/warehouse';
import type { Installation } from '@/types/installation';
import type { ReconciliationRecord } from '@/types/reconciliation';
import { buildInstallFlow, buildRecoverFlow, computeReconciliation } from '@/utils/ledger';
import type { RootState } from '@/stores/store';

type WithWarehouse = RootState;

export interface WarehouseSliceState {
  requisitions: Requisition[];
  reconciliations: ReconciliationRecord[];
  backfillReport: BackfillReport | null;
  capacity: number;
  ready: boolean;
  error: string | null;
  lastReceipt: string;
  reconciling: boolean;
}

const initialState: WarehouseSliceState = {
  requisitions: [],
  reconciliations: [],
  backfillReport: readBackfillReport(),
  capacity: getWarehouseCapacity(),
  ready: false,
  error: null,
  lastReceipt: '',
  reconciling: false,
};

/* ------------------------------ 领用单与物流 ------------------------------ */

/** 校验：同一台仪器不能同时挂在两张没回收（已发料）的领用单上 */
async function findOpenRequisition(serialNo: string): Promise<Requisition | undefined> {
  const rows = await db.requisitions
    .where('serialNo')
    .equals(serialNo)
    .filter((row) => row.state === '已发料')
    .toArray();
  return rows[0];
}

/** 按台站码开领用单并由库房发料（仪器须在库，且无未回收领用单） */
export const issueRequisition = createAsyncThunk(
  'warehouse/issueRequisition',
  async (
    payload: { serialNo: string; stationCode: string; issueDate: string; remark?: string },
    { rejectWithValue }
  ) => {
    const instrument = await db.instruments.where('serialNo').equals(payload.serialNo).first();
    if (!instrument) return rejectWithValue(`序列号「${payload.serialNo}」不在器材库台账中`);
    if (instrument.logisticsState !== '在库' && instrument.logisticsState !== '已发料') {
      return rejectWithValue(`仪器当前物流状态为「${instrument.logisticsState}」，不能发料`);
    }
    const open = await findOpenRequisition(payload.serialNo);
    if (open) {
      return rejectWithValue(
        `同一台仪器不能同时挂在两张没回收的单上：序列号「${payload.serialNo}」已挂领用单 ${open.requisitionNo}（${open.stationCode}）`
      );
    }
    const now = Date.now();
    const requisitionNo = createRequisitionNo('LYD', payload.issueDate);
    const requisition: Requisition = {
      id: createId('lyr'),
      requisitionNo,
      stationCode: payload.stationCode.trim(),
      serialNo: payload.serialNo.trim(),
      issueDate: payload.issueDate,
      state: '已发料',
      backfilled: false,
      recoveredAt: null,
      remark: payload.remark?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.requisitions, db.instruments], async () => {
      await db.requisitions.put(requisition);
      await db.instruments.update(instrument.id, {
        logisticsState: '已发料',
        requisitionNo,
        updatedAt: now,
      } as never);
    });
    return requisition;
  }
);

/**
 * 上站安装：中心按台站码开单 → 库房发料 → 登记安装位，一笔事务完成。
 * 仪器须在库且无未回收领用单。
 */
export const installInstrumentAtStation = createAsyncThunk(
  'warehouse/installInstrumentAtStation',
  async (
    payload: { stationId: string; serialNo: string; installDate: string; remark?: string },
    { rejectWithValue }
  ) => {
    const station = await db.stations.get(payload.stationId);
    if (!station) return rejectWithValue('台站名册中找不到该台站');
    const instrument = await db.instruments.where('serialNo').equals(payload.serialNo).first();
    if (!instrument) return rejectWithValue(`序列号「${payload.serialNo}」不在器材库台账中`);
    if (instrument.logisticsState !== '在库') {
      return rejectWithValue(`仪器当前物流状态为「${instrument.logisticsState}」，请先回库验收入库`);
    }
    const open = await findOpenRequisition(payload.serialNo);
    if (open) {
      return rejectWithValue(
        `同一台仪器不能同时挂在两张没回收的单上：已挂领用单 ${open.requisitionNo}（${open.stationCode}）`
      );
    }
    const now = Date.now();
    const flow = buildInstallFlow({
      stationId: station.id,
      stationCode: station.code,
      serialNo: payload.serialNo.trim(),
      installDate: payload.installDate,
      remark: payload.remark?.trim() ?? '',
      now,
    });
    await db.transaction('rw', [db.requisitions, db.installations, db.instruments], async () => {
      await db.requisitions.put(flow.requisition);
      await db.installations.put(flow.installation);
      await db.instruments.update(instrument.id, flow.instrumentPatch as never);
    });
    return flow;
  }
);

/** 拆回 / 回收：领用单已回收、安装位已拆回、仪器回库待验 */
export const recoverRequisition = createAsyncThunk(
  'warehouse/recoverRequisition',
  async (requisitionId: string, { rejectWithValue }) => {
    const requisition = await db.requisitions.get(requisitionId);
    if (!requisition) return rejectWithValue('领用单不存在');
    if (requisition.state === '已回收') return rejectWithValue('领用单已回收，请勿重复操作');
    const instrument = await db.instruments.where('serialNo').equals(requisition.serialNo).first();
    const installation = await db.installations
      .where('serialNo')
      .equals(requisition.serialNo)
      .filter((row) => row.stationCode === requisition.stationCode && row.state === '在装')
      .first();
    const now = Date.now();
    const flow = buildRecoverFlow({ requisition, installation: installation ?? null, now });
    await db.transaction('rw', [db.requisitions, db.installations, db.instruments], async () => {
      await db.requisitions.update(requisitionId, flow.requisitionPatch as never);
      if (installation && flow.installationPatch) {
        await db.installations.update(installation.id, flow.installationPatch as never);
      }
      if (instrument) {
        await db.instruments.update(instrument.id, flow.instrumentPatch as never);
      }
    });
    return { requisitionId };
  }
);

/** 验收入库：待回收 → 在库（仪器重新可发料） */
export const restockInstrument = createAsyncThunk(
  'warehouse/restockInstrument',
  async (instrumentId: string, { rejectWithValue }) => {
    const instrument = await db.instruments.get(instrumentId);
    if (!instrument) return rejectWithValue('仪器档案不存在');
    if (instrument.logisticsState !== '待回收') return rejectWithValue('仅待回收仪器可验收入库');
    await db.instruments.update(instrumentId, {
      logisticsState: '在库',
      requisitionNo: null,
      updatedAt: Date.now(),
    } as never);
    return instrumentId;
  }
);

/** 下一批入库：库容有空位时，排队仪器按入库先后（FIFO）转在库 */
export const processQueue = createAsyncThunk('warehouse/processQueue', async () => {
  const capacity = getWarehouseCapacity();
  const instruments = await db.instruments.toArray();
  const stocked = instruments.filter(
    (row) => row.logisticsState === '在库' || row.logisticsState === '已发料'
  ).length;
  const vacancies = Math.max(0, capacity - stocked);
  if (vacancies === 0) return { moved: 0, capacity };
  const queued = instruments
    .filter((row) => row.logisticsState === '排队')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, vacancies);
  const now = Date.now();
  await db.transaction('rw', [db.instruments], async () => {
    for (const row of queued) {
      await db.instruments.update(row.id, { logisticsState: '在库', updatedAt: now } as never);
    }
  });
  return { moved: queued.length, capacity };
});

/* ------------------------------ 对账 ------------------------------ */

/**
 * 库房侧发起对账：按台站码 + 序列号勾稽安装位与领用单，
 * 生成 / 刷新对账记录。对账失败时 thunk reject，页面可重试。
 */
export const runReconciliation = createAsyncThunk(
  'warehouse/runReconciliation',
  async (_, { rejectWithValue }) => {
    try {
      const [installations, requisitions, previous] = await Promise.all([
        db.installations.toArray(),
        db.requisitions.toArray(),
        db.reconciliations.toArray(),
      ]);
      const now = Date.now();
      const fresh = computeReconciliation({ installations, requisitions, now });
      const prevMap = new Map(previous.map((row) => [`${row.stationCode}__${row.serialNo}`, row]));
      const rows: ReconciliationRecord[] = fresh.map((row) => {
        const prev = prevMap.get(`${row.stationCode}__${row.serialNo}`);
        if (prev && prev.result === '已确认') {
          // 中心已认下的不退回，保留已确认状态
          return { ...row, id: prev.id, result: '已确认', acknowledgedAt: prev.acknowledgedAt ?? now };
        }
        if (prev && prev.lastError.length > 0) {
          // 上次对账失败后重试：失败次数 +1，错误已清除
          return { ...row, id: prev.id, failCount: prev.failCount + 1, lastError: '' };
        }
        return row;
      });
      await db.transaction('rw', [db.reconciliations], async () => {
        await db.reconciliations.clear();
        await db.reconciliations.bulkPut(rows);
      });
      return { count: rows.length, at: now };
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '对账失败，请重试');
    }
  }
);

/**
 * 中心认下：对不上的差异先摆着等确认；中心认下后不退回。
 * - 中心有位无单：认下安装位（库房不要求拆回）；
 * - 库房有单无位：中心按台站码补登安装位（认下后不退回）。
 */
export const acknowledgeReconciliation = createAsyncThunk(
  'warehouse/acknowledgeReconciliation',
  async (recordId: string, { rejectWithValue }) => {
    const record = await db.reconciliations.get(recordId);
    if (!record) return rejectWithValue('对账记录不存在');
    const now = Date.now();
    await db.transaction('rw', [db.reconciliations, db.installations, db.stations], async () => {
      if (record.installationId) {
        await db.installations.update(record.installationId, {
          acknowledged: true,
          acknowledgedAt: now,
          updatedAt: now,
        } as never);
      } else if (record.requisitionId) {
        // 库房有单无位：中心认下 → 按台站码补登安装位
        const requisition = await db.requisitions.get(record.requisitionId);
        if (!requisition) throw new Error('领用单不存在');
        const station = await db.stations.where('code').equals(record.stationCode).first();
        if (!station) throw new Error(`台站名册中找不到台站码「${record.stationCode}」，请先补登台站`);
        const installation: Installation = {
          id: createId('ist'),
          stationId: station.id,
          stationCode: station.code,
          serialNo: record.serialNo,
          installDate: requisition.issueDate,
          requisitionNo: requisition.requisitionNo,
          state: '在装',
          acknowledged: true,
          acknowledgedAt: now,
          remark: '对账认下补登（中心认下，不退回）',
          createdAt: now,
          updatedAt: now,
        };
        await db.installations.put(installation);
      }
      await db.reconciliations.update(recordId, {
        result: '已确认',
        acknowledgedAt: now,
        lastError: '',
        updatedAt: now,
      } as never);
    });
    return recordId;
  }
);

/** 对账失败后库房这侧重试：重新发起对账 */
export const retryReconciliation = createAsyncThunk(
  'warehouse/retryReconciliation',
  async (_, { dispatch }) => {
    await dispatch(runReconciliation()).unwrap();
    return true;
  }
);

const warehouseSlice = createSlice({
  name: 'warehouse',
  initialState,
  reducers: {
    setRequisitions(state, action: PayloadAction<Requisition[]>) {
      state.requisitions = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReconciliations(state, action: PayloadAction<ReconciliationRecord[]>) {
      state.reconciliations = action.payload;
    },
    setWarehouseError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setWarehouseReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
    setCapacityValue(state, action: PayloadAction<number>) {
      state.capacity = action.payload;
      setWarehouseCapacity(action.payload);
    },
    dismissBackfillReport(state) {
      state.backfillReport = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(issueRequisition.fulfilled, (state, action) => {
        state.lastReceipt = `领用单 ${action.payload.requisitionNo} 已发料（${action.payload.stationCode} → ${action.payload.serialNo}）`;
        state.error = null;
      })
      .addCase(issueRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '开单失败';
      })
      .addCase(installInstrumentAtStation.fulfilled, (state, action) => {
        state.lastReceipt = `已开领用单 ${action.payload.requisition.requisitionNo} 并发料上站，安装位已登记`;
        state.error = null;
      })
      .addCase(installInstrumentAtStation.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '上站失败';
      })
      .addCase(recoverRequisition.fulfilled, (state) => {
        state.lastReceipt = '领用单已回收，安装位已拆回，仪器回库待验';
        state.error = null;
      })
      .addCase(recoverRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '回收失败';
      })
      .addCase(restockInstrument.fulfilled, () => {
        // 回流后由 liveQuery 刷新
      })
      .addCase(processQueue.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.moved > 0
            ? `下一批入库完成：${action.payload.moved} 台排队仪器已转在库（库容 ${action.payload.capacity}）`
            : `库容已满（${action.payload.capacity} 台），暂无空位，排队仪器继续等下一批`;
      })
      .addCase(runReconciliation.pending, (state) => {
        state.reconciling = true;
        state.error = null;
      })
      .addCase(runReconciliation.fulfilled, (state) => {
        state.reconciling = false;
        state.lastReceipt = '对账完成：平账与差异已列出，待中心认下';
      })
      .addCase(runReconciliation.rejected, (state, action) => {
        state.reconciling = false;
        state.error = typeof action.payload === 'string' ? action.payload : '对账失败，请重试';
      })
      .addCase(acknowledgeReconciliation.fulfilled, (state) => {
        state.lastReceipt = '中心已认下：该差异不退回';
        state.error = null;
      })
      .addCase(acknowledgeReconciliation.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '认下失败';
      });
  },
});

export const {
  setRequisitions,
  setReconciliations,
  setWarehouseError,
  setWarehouseReceipt,
  setCapacityValue,
  dismissBackfillReport,
} = warehouseSlice.actions;

let started = false;

/** 启动器材库台账实时订阅（幂等）：领用单 + 对账记录 */
export function startWarehouseSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Requisition>(() => db.requisitions).subscribe((rows) => {
    dispatch(setRequisitions(rows));
  });
  watchTable<ReconciliationRecord>(() => db.reconciliations).subscribe((rows) => {
    dispatch(setReconciliations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectWarehouseState = (state: WithWarehouse): WarehouseSliceState => state.warehouse;
export const selectRequisitions = (state: WithWarehouse): Requisition[] => state.warehouse.requisitions;
export const selectReconciliations = (state: WithWarehouse): ReconciliationRecord[] =>
  state.warehouse.reconciliations;
export const selectBackfillReport = (state: WithWarehouse): BackfillReport | null =>
  state.warehouse.backfillReport;
export const selectWarehouseCapacity = (state: WithWarehouse): number => state.warehouse.capacity;
export const selectWarehouseReady = (state: WithWarehouse): boolean => state.warehouse.ready;
export const selectWarehouseReceipt = (state: WithWarehouse): string => state.warehouse.lastReceipt;
export const selectWarehouseError = (state: WithWarehouse): string | null => state.warehouse.error;
export const selectReconciling = (state: WithWarehouse): boolean => state.warehouse.reconciling;

/** 序列号 → 当前未回收领用单 */
export const selectOpenRequisitionBySerial = (
  state: WithWarehouse,
  serialNo: string | null | undefined
): Requisition | null => {
  if (!serialNo) return null;
  return (
    state.warehouse.requisitions.find((row) => row.serialNo === serialNo && row.state === '已发料') ??
    null
  );
};

export default warehouseSlice.reducer;
