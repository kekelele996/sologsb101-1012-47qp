/**
 * 台网中心 slice：仪器安装位（挂在台站名册上）。
 *
 * 拆分后的边界：
 * - 中心只管安装位（类型/型号/安装日期/运行状态）与开单意图；
 * - 序列号、入库日期、发料与回收均归器材库（warehouseSlice / utils/warehouse.ts）；
 * - 上仪器流程：按台站码开领用单（生成待发料安装位）→ 库房照单发料 →
 *   中心按已发料单上站登记（序列号回流）→ 两侧按台站码 + 序列号对账。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Instrument, InstrumentDraft, InstrumentState, InstrumentType } from '@/types/instrument';
import { createEmptyInstrumentDraft } from '@/types/instrument';
import type { RequisitionDraft } from '@/types/warehouse';
import type { SeisStation } from '@/types/station';
import {
  WarehouseError,
  installSlot,
  openRequisition,
} from '@/utils/warehouse';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstrument = RootState;

export interface InstrumentSliceState {
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站仪器页上下文） */
  currentStationId: string | null;
  /** 安装位登记草稿（跨页面保留） */
  draft: InstrumentDraft;
  /** 最近一次保存回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: InstrumentSliceState = {
  instruments: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstrumentDraft(),
  lastReceipt: '',
};

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof WarehouseError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/**
 * 按台站码开领用单，同时在中心侧建一个「待发料」安装位（序列号暂缺）。
 * 库房发料后，序列号随对账回流到安装位。
 */
export const openStationRequisition = createAsyncThunk(
  'instrument/openStationRequisition',
  async (
    payload: { station: SeisStation; draft: Omit<RequisitionDraft, 'stationCode'> },
    { rejectWithValue }
  ) => {
    try {
      const fullDraft: RequisitionDraft = {
        stationCode: payload.station.code,
        purpose: payload.draft.purpose,
        applicant: payload.draft.applicant,
        items: payload.draft.items,
      };
      const req = await openRequisition(fullDraft, [payload.station]);
      const first = req.items[0];
      const now = Date.now();
      const slot: Instrument = {
        id: createId('ins'),
        stationId: payload.station.id,
        type: first.type,
        model: first.model,
        serialNo: null,
        installDate: req.orderDate,
        state: '待标定',
        requisitionId: req.id,
        reconcileResult: null,
        reconcileNote: '',
        remark: req.purpose,
        createdAt: now,
        updatedAt: now,
      };
      await db.instruments.put(slot);
      return { requisition: req, slot };
    } catch (error) {
      return rejectWithValue(toMessage(error, '开领用单失败'));
    }
  }
);

/**
 * 按已发料领用单上站登记：取单据明细的发料序列号回流到安装位，并自动触发一次对账。
 */
export const installFromRequisition = createAsyncThunk(
  'instrument/installFromRequisition',
  async (
    payload: {
      stationId: string;
      requisitionId: string;
      installDate: string;
      state: InstrumentState;
      remark: string;
    },
    { rejectWithValue }
  ) => {
    try {
      const req = await db.requisitions.get(payload.requisitionId);
      if (!req) throw new WarehouseError('领用单不存在');
      if (req.state !== '已发料' && req.state !== '对账挂起') {
        throw new WarehouseError(`单据当前为「${req.state}」，还不能上站登记`);
      }
      const issued = req.items.find((item) => item.serialNo);
      if (!issued || !issued.serialNo) throw new WarehouseError('该领用单尚未发料，没有可登记的序列号');
      const result = await installSlot({
        stationId: payload.stationId,
        type: issued.type,
        model: issued.model,
        serialNo: issued.serialNo,
        requisitionId: req.id,
        installDate: payload.installDate,
        state: payload.state,
        remark: payload.remark,
      });
      return { ...result, requisitionCode: req.code };
    } catch (error) {
      return rejectWithValue(toMessage(error, '上站登记失败'));
    }
  }
);

/**
 * 直接登记安装位（无领用单的历史/特殊情形）。序列号允许暂缺；
 * 有序列号时仅做安装位层面的重复提示，不做强制唯一（序列号台账以器材库为准）。
 */
export const createSlot = createAsyncThunk(
  'instrument/createSlot',
  async (payload: Omit<Instrument, 'id' | 'createdAt' | 'updatedAt'>, { rejectWithValue }) => {
    try {
      const now = Date.now();
      const row: Instrument = { ...payload, id: createId('ins'), createdAt: now, updatedAt: now };
      await db.instruments.put(row);
      return { row };
    } catch (error) {
      return rejectWithValue(toMessage(error, '安装位保存失败'));
    }
  }
);

/** 更新安装位元数据（序列号不在此修改，发料/认下由单据驱动） */
export const updateInstrument = createAsyncThunk(
  'instrument/updateInstrument',
  async (payload: { id: string; patch: Partial<Instrument> }) => {
    const patch = { ...payload.patch };
    delete patch.serialNo;
    delete patch.requisitionId;
    delete patch.reconcileResult;
    await db.instruments.update(payload.id, { ...patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除安装位：级联删除标定与更换记录（领用单留在器材库，按其自身流程处理） */
export const removeInstrument = createAsyncThunk(
  'instrument/removeInstrument',
  async (instrumentId: string) => {
    await db.transaction('rw', [db.instruments, db.calibrations, db.replaces], async () => {
      await db.calibrations.where('instrumentId').equals(instrumentId).delete();
      await db.replaces.where('instrumentId').equals(instrumentId).delete();
      await db.instruments.delete(instrumentId);
    });
    return instrumentId;
  }
);

/** 批量改状态（如把超期仪器统一置为待标定） */
export const bulkSetInstrumentState = createAsyncThunk(
  'instrument/bulkSetInstrumentState',
  async (payload: { ids: string[]; state: InstrumentState }) => {
    const now = Date.now();
    await db.instruments
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

/** 更换完成后回写安装位序列号并置为在用 */
export const applySerialReplace = createAsyncThunk(
  'instrument/applySerialReplace',
  async (payload: { instrumentId: string; newSerialNo: string }) => {
    await db.instruments.update(payload.instrumentId, {
      serialNo: payload.newSerialNo,
      state: '在用',
      updatedAt: Date.now(),
    } as never);
    return payload;
  }
);

const instrumentSlice = createSlice({
  name: 'instrument',
  initialState,
  reducers: {
    setInstruments(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
      state.ready = true;
      state.error = null;
    },
    setInstrumentError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstrument(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstrumentDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstrumentDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(openStationRequisition.fulfilled, (state, action) => {
        state.lastReceipt = `已按台站 ${action.payload.requisition.stationCode} 开出领用单 ${action.payload.requisition.code}，等待库房发料`;
        state.error = null;
      })
      .addCase(openStationRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '开领用单失败';
      })
      .addCase(installFromRequisition.fulfilled, (state, action) => {
        state.lastReceipt = `已按领用单 ${action.payload.requisitionCode} 完成上站登记，序列号已回流并触发对账`;
        state.error = null;
      })
      .addCase(installFromRequisition.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '上站登记失败';
      })
      .addCase(createSlot.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '安装位保存失败';
      })
      .addCase(updateInstrument.rejected, (state) => {
        state.error = '安装位更新失败';
      })
      .addCase(removeInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已删除安装位 ${action.payload}`;
      });
  },
});

export const {
  setInstruments,
  setInstrumentError,
  selectStationForInstrument,
  patchDraft,
  resetDraft,
  setReceipt,
} = instrumentSlice.actions;

let started = false;

/** 启动安装位表实时订阅（幂等） */
export function startInstrumentSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstruments(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstrumentState = (state: WithInstrument): InstrumentSliceState => state.instrument;
export const selectInstruments = (state: WithInstrument): Instrument[] => state.instrument.instruments;
export const selectInstrumentReady = (state: WithInstrument): boolean => state.instrument.ready;
export const selectInstrumentDraft = (state: WithInstrument): InstrumentDraft => state.instrument.draft;
export const selectInstrumentReceipt = (state: WithInstrument): string => state.instrument.lastReceipt;

export const selectInstrumentById = (
  state: WithInstrument,
  id: string | null | undefined
): Instrument | null => (id ? state.instrument.instruments.find((row) => row.id === id) ?? null : null);

export const selectInstrumentsOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Instrument[] => {
  if (!stationId) return [];
  return state.instrument.instruments
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN') || a.model.localeCompare(b.model));
};

/** 台站 id → 安装位台数 */
export const selectInstrumentCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.instruments.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

/** 仪器类型统计 */
export const selectInstrumentTypeCounts = (state: WithInstrument): Record<InstrumentType, number> => {
  const counts: Record<InstrumentType, number> = { 宽频带: 0, 短周期: 0, 强震: 0 };
  state.instrument.instruments.forEach((row) => {
    counts[row.type] += 1;
  });
  return counts;
};

export default instrumentSlice.reducer;
