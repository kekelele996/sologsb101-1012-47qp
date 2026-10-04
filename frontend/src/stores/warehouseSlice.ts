/**
 * 器材库 slice：在库仪器、领用单、升级补单问题清单与库容上限。
 * 中心侧只通过「按台站码开单」与「认下」参与，写操作落 IndexedDB，liveQuery 回流。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, watchTable } from '@/utils/db';
import { readStockCapacity } from '@/utils/db';
import type {
  Requisition,
  RequisitionDraft,
  StockInstrument,
  UpgradeIssue,
} from '@/types/warehouse';
import type { SeisStation } from '@/types/station';
import {
  WarehouseError,
  acknowledgeRequisition,
  cancelRequisition,
  inboundStock,
  issueRequisition,
  openRequisition,
  promoteQueueHead,
  resolveUpgradeIssue,
  retryReconcile,
  setCapacity,
} from '@/utils/warehouse';
import type { RootState } from '@/stores/store';

type WithWarehouse = RootState;

export interface WarehouseSliceState {
  stock: StockInstrument[];
  requisitions: Requisition[];
  issues: UpgradeIssue[];
  capacity: number;
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: WarehouseSliceState = {
  stock: [],
  requisitions: [],
  issues: [],
  capacity: readStockCapacity(),
  ready: false,
  error: null,
  lastReceipt: '',
};

/** 把工具层错误归一化成文案 */
function toMessage(error: unknown, fallback: string): string {
  if (error instanceof WarehouseError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/* ------------------------------ 异步动作 ------------------------------ */

export const createStock = createAsyncThunk(
  'warehouse/createStock',
  async (
    payload: { type: StockInstrument['type']; model: string; serialNo: string; inboundDate: string; remark: string },
    { rejectWithValue }
  ) => {
    try {
      return await inboundStock(payload);
    } catch (error) {
      return rejectWithValue(toMessage(error, '入库失败'));
    }
  }
);

export const updateStock = createAsyncThunk(
  'warehouse/updateStock',
  async (
    payload: { id: string; patch: Partial<Pick<StockInstrument, 'type' | 'model' | 'inboundDate' | 'remark'>> },
    { rejectWithValue }
  ) => {
    try {
      await db.stockInstruments.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
      return payload;
    } catch (error) {
      return rejectWithValue(toMessage(error, '在库仪器更新失败'));
    }
  }
);

/** 删除在库仪器：排队中 / 在库（未挂单）可删，已出库 / 已核销 需走单据流程 */
export const removeStock = createAsyncThunk(
  'warehouse/removeStock',
  async (id: string, { rejectWithValue }) => {
    try {
      const row = await db.stockInstruments.get(id);
      if (!row) throw new WarehouseError('在库仪器不存在');
      if (row.state === '已出库') throw new WarehouseError('该仪器已挂在未回收领用单上，不能直接删除');
      if (row.state === '已核销') throw new WarehouseError('该仪器已随单销账，不能删除');
      await db.stockInstruments.delete(id);
      // 删掉排队项后整理队列编号
      if (row.state === '排队中') {
        const waiting = (await db.stockInstruments.where('state').equals('排队中').toArray())
          .filter((item) => item.queueNo !== null)
          .sort((a, b) => (a.queueNo ?? 0) - (b.queueNo ?? 0));
        const now = Date.now();
        waiting.forEach(async (item, index) => {
          if (item.queueNo !== index + 1) {
            await db.stockInstruments.update(item.id, { queueNo: index + 1, updatedAt: now });
          }
        });
        await promoteQueueHead();
      }
      return id;
    } catch (error) {
      return rejectWithValue(toMessage(error, '删除失败'));
    }
  }
);

export const promoteNext = createAsyncThunk('warehouse/promoteNext', async () => {
  return await promoteQueueHead();
});

export const changeCapacity = createAsyncThunk(
  'warehouse/changeCapacity',
  async (capacity: number, { rejectWithValue }) => {
    try {
      return await setCapacity(capacity);
    } catch (error) {
      return rejectWithValue(toMessage(error, '库容设置失败'));
    }
  }
);

export const createRequisition = createAsyncThunk(
  'warehouse/createRequisition',
  async (payload: { draft: RequisitionDraft; stations: SeisStation[] }, { rejectWithValue }) => {
    try {
      return await openRequisition(payload.draft, payload.stations);
    } catch (error) {
      return rejectWithValue(toMessage(error, '开单失败'));
    }
  }
);

export const issueStock = createAsyncThunk(
  'warehouse/issueStock',
  async (
    payload: { reqId: string; assignments: Array<{ lineNo: number; serialNo: string }> },
    { rejectWithValue }
  ) => {
    try {
      return await issueRequisition(payload.reqId, payload.assignments);
    } catch (error) {
      return rejectWithValue(toMessage(error, '发料失败'));
    }
  }
);

export const cancelOpenRequisition = createAsyncThunk(
  'warehouse/cancelOpenRequisition',
  async (reqId: string, { rejectWithValue }) => {
    try {
      await cancelRequisition(reqId);
      return reqId;
    } catch (error) {
      return rejectWithValue(toMessage(error, '取消失败'));
    }
  }
);

export const runReconcile = createAsyncThunk('warehouse/runReconcile', async () => {
  return await retryReconcile();
});

export const acceptRequisition = createAsyncThunk(
  'warehouse/acceptRequisition',
  async (payload: { reqId: string; note: string }, { rejectWithValue }) => {
    try {
      return await acknowledgeRequisition(payload.reqId, payload.note);
    } catch (error) {
      return rejectWithValue(toMessage(error, '认下失败'));
    }
  }
);

export const resolveIssue = createAsyncThunk(
  'warehouse/resolveIssue',
  async (issueId: string) => {
    await resolveUpgradeIssue(issueId);
    return issueId;
  }
);

const warehouseSlice = createSlice({
  name: 'warehouse',
  initialState,
  reducers: {
    setStock(state, action: PayloadAction<StockInstrument[]>) {
      state.stock = action.payload;
      state.ready = true;
      state.error = null;
    },
    setRequisitions(state, action: PayloadAction<Requisition[]>) {
      state.requisitions = action.payload;
    },
    setIssues(state, action: PayloadAction<UpgradeIssue[]>) {
      state.issues = action.payload;
    },
    setCapacity(state, action: PayloadAction<number>) {
      state.capacity = action.payload;
    },
    setWarehouseError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setWarehouseReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createStock.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.enqueued
          ? `仪器已登记，但在库容量已满（${state.capacity} 台），已排队等下一批`
          : '仪器已入库';
        state.error = null;
      })
      .addCase(createStock.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '入库失败';
      })
      .addCase(removeStock.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '删除失败';
      })
      .addCase(changeCapacity.fulfilled, (state, action) => {
        state.capacity = action.payload;
        state.lastReceipt = `在库容量上限已调整为 ${action.payload} 台，排队仪器已按 FIFO 补位`;
      })
      .addCase(changeCapacity.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '库容设置失败';
      })
      .addCase(createRequisition.fulfilled, (state, action) => {
        state.lastReceipt = `领用单 ${action.payload.code} 已按台站 ${action.payload.stationCode} 开出，等待库房发料`;
        state.error = null;
      })
      .addCase(createRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '开单失败';
      })
      .addCase(issueStock.fulfilled, (state, action) => {
        state.lastReceipt = `库房已照单 ${action.payload.code} 发料，等待上站安装后对账`;
        state.error = null;
      })
      .addCase(issueStock.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '发料失败';
      })
      .addCase(cancelOpenRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '取消失败';
      })
      .addCase(runReconcile.fulfilled, (state, action) => {
        const { recovered, suspended } = action.payload;
        state.lastReceipt =
          suspended === 0
            ? `对账完成：本次回收 ${recovered} 张单，没有挂起项`
            : `对账完成：回收 ${recovered} 张，仍有 ${suspended} 张对不上，先摆着等确认`;
      })
      .addCase(acceptRequisition.fulfilled, (state, action) => {
        state.lastReceipt = `领用单 ${action.payload.code} 已由中心认下，不退回，单据回收销账`;
        state.error = null;
      })
      .addCase(acceptRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '认下失败';
      });
  },
});

export const {
  setStock,
  setRequisitions,
  setIssues,
  setCapacity: setCapacityAction,
  setWarehouseError,
  setWarehouseReceipt,
} = warehouseSlice.actions;

let started = false;

/** 启动器材库三表实时订阅（幂等） */
export function startWarehouseSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<StockInstrument>(() => db.stockInstruments).subscribe((rows) => {
    dispatch(setStock(rows));
  });
  watchTable<Requisition>(() => db.requisitions).subscribe((rows) => {
    dispatch(setRequisitions(rows));
  });
  watchTable<UpgradeIssue>(() => db.upgradeIssues).subscribe((rows) => {
    dispatch(setIssues(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectWarehouseState = (state: WithWarehouse): WarehouseSliceState => state.warehouse;
export const selectStock = (state: WithWarehouse): StockInstrument[] => state.warehouse.stock;
export const selectRequisitions = (state: WithWarehouse): Requisition[] => state.warehouse.requisitions;
export const selectUpgradeIssues = (state: WithWarehouse): UpgradeIssue[] => state.warehouse.issues;
export const selectStockCapacity = (state: WithWarehouse): number => state.warehouse.capacity;
export const selectWarehouseReady = (state: WithWarehouse): boolean => state.warehouse.ready;

/** 已发料到某台站、仍开放（未回收）的领用单：中心安装位登记时选择 */
export function selectOpenRequisitionsOfStation(
  state: WithWarehouse,
  stationCode: string
): Requisition[] {
  return state.warehouse.requisitions
    .filter(
      (req) =>
        req.stationCode.toUpperCase() === stationCode.toUpperCase() &&
        (req.state === '已发料' || req.state === '对账挂起')
    )
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
}

/** 在库（可发料）仪器，按型号过滤 */
export function selectAvailableStock(
  state: WithWarehouse,
  model: string,
  type: string
): StockInstrument[] {
  return state.warehouse.stock.filter(
    (row) => row.state === '在库' && row.model === model && row.type === type
  );
}

export default warehouseSlice.reducer;
