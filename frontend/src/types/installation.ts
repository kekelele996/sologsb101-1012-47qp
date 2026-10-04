/**
 * 台网中心台账：仪器安装位。
 * 台网中心管台站名册与仪器安装位（哪台仪器装在哪个台站、凭哪张领用单上的站）；
 * 在库仪器与领用单归器材库（types/warehouse.ts），两边按台站码 + 序列号对账。
 */

/** 安装位状态：在装 / 已拆回 */
export type InstallationState = '在装' | '已拆回';

export const INSTALLATION_STATES: InstallationState[] = ['在装', '已拆回'];

/**
 * 仪器安装位：中心侧「上站」留痕。
 * 与器材库领用单按（台站码 + 序列号）勾稽对账。
 */
export interface Installation {
  id: string;
  /** 所属台站 id（stations 表外键） */
  stationId: string;
  /** 台站码（对账键之一，冗余自台站名册） */
  stationCode: string;
  /** 安装仪器序列号（对账键之二） */
  serialNo: string;
  /** 安装（上站）日期（YYYY-MM-DD） */
  installDate: string;
  /** 对应领用单号（升级补单为 LYB 前缀） */
  requisitionNo: string | null;
  /** 状态 */
  state: InstallationState;
  /** 是否经中心认下（认下的对账差异不退回） */
  acknowledged: boolean;
  /** 认下时间（ISO 时间戳），未认下为 null */
  acknowledgedAt: number | null;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 安装位草稿（上站登记表单用） */
export interface InstallationDraft {
  stationId: string;
  serialNo: string;
  installDate: string;
  remark: string;
}

export function createEmptyInstallationDraft(stationId = ''): InstallationDraft {
  return {
    stationId,
    serialNo: '',
    installDate: new Date().toISOString().slice(0, 10),
    remark: '',
  };
}
