/** 仪器类型 */
export type InstrumentType = '宽频带' | '短周期' | '强震';

export const INSTRUMENT_TYPES: InstrumentType[] = ['宽频带', '短周期', '强震'];

/** 仪器在标定口径下的状态（由标定结论派生，标定页回显用） */
export type InstrumentState = '在用' | '待标定' | '已停用';

export const INSTRUMENT_STATES: InstrumentState[] = ['在用', '待标定', '已停用'];

/**
 * 仪器在器材库口径下的物流状态：
 * 在库（可发料）→ 已发料（挂在领用单上）→ 已安装（上站）→ 待回收（拆回待验）→ 回在库；
 * 入库时在库数量已达容量上限则先「排队」等下一批。
 */
export type LogisticsState = '在库' | '排队' | '已发料' | '已安装' | '待回收';

export const LOGISTICS_STATES: LogisticsState[] = ['在库', '排队', '已发料', '已安装', '待回收'];

/** 标定周期（天）：超过该天数未标定即视为超期 */
export const CALIBRATION_CYCLE_DAYS = 365;

/**
 * 仪器：器材库在库仪器档案（序列号、入库日期由器材库管）。
 * 台站与安装日期为上站后的回显（台网中心安装位见 types/installation.ts），
 * 标定状态由标定结论派生；物流状态见 logisticsState。
 */
export interface Instrument {
  id: string;
  /** 上站台站 id（安装后回显；在库/排队时为 null） */
  stationId: string | null;
  /** 仪器类型 */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 序列号（全局唯一，对账键） */
  serialNo: string;
  /** 安装（上站）日期（安装后回显；未上站为 null） */
  installDate: string | null;
  /** 标定口径状态：在用 / 待标定 / 已停用 */
  state: InstrumentState;
  /** 器材库物流状态 */
  logisticsState: LogisticsState;
  /** 入库日期（YYYY-MM-DD） */
  stockInDate: string;
  /** 当前未回收领用单号（已发料/已安装时有单；在库/排队/待回收为 null） */
  requisitionNo: string | null;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 仪器入库草稿（存于 instrumentSlice，器材库入库表单用） */
export interface InstrumentDraft {
  type: InstrumentType;
  model: string;
  serialNo: string;
  /** 入库日期 */
  stockInDate: string;
  remark: string;
}

export function createEmptyInstrumentDraft(): InstrumentDraft {
  return {
    type: '宽频带',
    model: '',
    serialNo: '',
    stockInDate: new Date().toISOString().slice(0, 10),
    remark: ''
  };
}

/** 常用型号（表单联想用） */
export const COMMON_MODELS: Record<InstrumentType, string[]> = {
  宽频带: ['CMG-3ESPC', 'STS-2.5', 'Trillium-120', 'Trillium-Compact'],
  短周期: ['FSS-3B', 'L-4C-3D', 'CDJ-S2C'],
  强震: ['ES-T', 'CMG-5TDE', 'ETNA2', 'GL-P2B']
};

/**
 * 计算距下次标定的天数：正数表示剩余天数，负数表示已超期天数。
 * 以最近一次标定日期（无标定则用安装日期）为基准。
 */
export function daysUntilDue(lastCalibrationDate: string | null, installDate: string | null): number {
  const base = lastCalibrationDate ?? installDate;
  if (!base) return CALIBRATION_CYCLE_DAYS;
  const baseTime = Date.parse(`${base}T00:00:00`);
  if (!Number.isFinite(baseTime)) return CALIBRATION_CYCLE_DAYS;
  const dueTime = baseTime + CALIBRATION_CYCLE_DAYS * 86400000;
  const diff = dueTime - Date.now();
  return Math.round(diff / 86400000);
}
