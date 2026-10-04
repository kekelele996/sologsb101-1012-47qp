/** 仪器类型 */
export type InstrumentType = '宽频带' | '短周期' | '强震';

export const INSTRUMENT_TYPES: InstrumentType[] = ['宽频带', '短周期', '强震'];

/** 仪器状态 */
export type InstrumentState = '在用' | '待标定' | '已停用';

export const INSTRUMENT_STATES: InstrumentState[] = ['在用', '待标定', '已停用'];

/** 标定周期（天）：超过该天数未标定即视为超期 */
export const CALIBRATION_CYCLE_DAYS = 365;

/**
 * 台网中心域：仪器安装位（挂在台站名册上的一个观测位置）。
 *
 * 拆分后的职责边界：
 * - 台网中心只管「台站名册 + 仪器安装位」：装什么类型、型号、计划/实际安装日期、运行状态；
 * - 仪器实体（序列号、入库日期、领用单）归器材库（见 types/warehouse.ts）；
 * - 上仪器时按台站码开领用单，库房照单发料，发料后序列号回流到安装位。
 *   尚未发料 / 未对上账的安装位 serialNo 允许为空。
 */
/** 仪器：台站安装位上的观测设备 */
export interface Instrument {
  id: string;
  /** 所属台站（安装位挂在台站名册上） */
  stationId: string;
  /** 仪器类型 */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /**
   * 序列号：由器材库发料回流（全局唯一，可能暂缺——待发料的安装位还没有序列号）。
   * 对账键之一（另一个是台站码）。
   */
  serialNo: string | null;
  /** 计划/实际安装日期 */
  installDate: string;
  /** 状态 */
  state: InstrumentState;
  /** 来源领用单 id（按台站码开单后挂接；历史补单数据同样回填） */
  requisitionId: string | null;
  /**
   * 安装位对账结论：
   * - null：尚未对账（历史数据升级时默认视为已认下）
   * - 一致：台站码 + 序列号与库房发料记录对上
   * - 挂起：对不上，先摆着等确认
   * - 认下：中心认下，不退回
   */
  reconcileResult: '一致' | '挂起' | '认下' | null;
  reconcileNote: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 安装位登记草稿（存于 instrumentSlice） */
export interface InstrumentDraft {
  stationId: string;
  type: InstrumentType;
  model: string;
  /** 选择已发料到本站的领用单明细（序列号）；也可先空着等发料 */
  requisitionId: string | null;
  serialNo: string | null;
  installDate: string;
  state: InstrumentState;
  remark: string;
}

export function createEmptyInstrumentDraft(): InstrumentDraft {
  return {
    stationId: '',
    type: '宽频带',
    model: '',
    requisitionId: null,
    serialNo: null,
    installDate: new Date().toISOString().slice(0, 10),
    state: '在用',
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
export function daysUntilDue(lastCalibrationDate: string | null, installDate: string): number {
  const base = lastCalibrationDate ?? installDate;
  const baseTime = Date.parse(`${base}T00:00:00`);
  if (!Number.isFinite(baseTime)) return CALIBRATION_CYCLE_DAYS;
  const dueTime = baseTime + CALIBRATION_CYCLE_DAYS * 86400000;
  const diff = dueTime - Date.now();
  return Math.round(diff / 86400000);
}
