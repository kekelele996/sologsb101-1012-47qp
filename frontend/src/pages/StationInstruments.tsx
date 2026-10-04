/**
 * 模块 2（台网中心侧）：/stations/:id/instruments 台站名册与仪器安装位维护
 *
 * 账拆分后本页只管「台站名册 + 安装位」：
 * - 上仪器：按台站码开领用单（生成待发料安装位）→ 库房在「器材库」页照单发料；
 * - 已发料到本站的单据，可在本页做上站登记，序列号回流并自动对账；
 * - 序列号、入库日期、发料/回收均不可在本页手填，统一以器材库台账为准。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  PlusOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import RouteMissingPanel from '@/components/common/RouteMissingPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createStation,
  patchStationFilter,
  recomputeAperture,
  removeStation,
  resetStationFilter,
  selectArrayById,
  selectArrayReady,
  selectArrays,
  selectStationFilter,
  selectStationsOfArray,
  updateStation,
} from '@/stores/arraySlice';
import {
  bulkSetInstrumentState,
  createSlot,
  installFromRequisition,
  openStationRequisition,
  removeInstrument,
  selectInstruments,
  selectInstrumentsOfStation,
  updateInstrument,
} from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import { selectRequisitions } from '@/stores/warehouseSlice';
import { BEDROCK_TYPES, validateLatLng, type BedrockType, type SeisStation } from '@/types/station';
import {
  INSTRUMENT_STATES,
  INSTRUMENT_TYPES,
  daysUntilDue,
  type Instrument,
  type InstrumentState,
  type InstrumentType,
} from '@/types/instrument';
import { COMMON_MODELS } from '@/types/instrument';
import { requisitionStateColor } from '@/utils/warehouse';
import { formatLatLng, round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';

interface StationFormValues {
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: BedrockType;
  siteNote: string;
}

/** 开领用单表单（按台站码） */
interface RequisitionFormValues {
  applicant: string;
  purpose: string;
  type: InstrumentType;
  model: string;
}

/** 按已发料单上站登记表单 */
interface InstallFormValues {
  requisitionId: string;
  installDate: dayjs.Dayjs | null;
  state: InstrumentState;
  remark: string;
}

/** 直接登记安装位（无单的历史/特殊补录） */
interface DirectSlotFormValues {
  type: InstrumentType;
  model: string;
  installDate: dayjs.Dayjs | null;
  state: InstrumentState;
  serialNo: string;
  remark: string;
}

/** 台站行统计：安装位数、标定数、不合格数与超期台数 */
interface StationRow {
  station: SeisStation;
  instruments: Instrument[];
  calibrationCount: number;
  unqualified: number;
  overdue: number;
  pendingSlots: number;
  suspendedSlots: number;
  worstVerdict: string;
}

const reconcileTagColor = {
  一致: 'green',
  认下: 'purple',
  挂起: 'red',
} as const;

export default function StationInstruments() {
  const { id: arrayId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const ready = useAppSelector(selectArrayReady);
  const array = useAppSelector((state) => selectArrayById(state, arrayId));
  const stations = useAppSelector((state) => selectStationsOfArray(state, arrayId));
  const stationFilter = useAppSelector(selectStationFilter);
  const allInstruments = useAppSelector(selectInstruments);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const requisitions = useAppSelector(selectRequisitions);

  const [stationModalOpen, setStationModalOpen] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [directModalOpen, setDirectModalOpen] = useState(false);
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [activeStationId, setActiveStationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stationForm] = Form.useForm<StationFormValues>();
  const [reqForm] = Form.useForm<RequisitionFormValues>();
  const [installForm] = Form.useForm<InstallFormValues>();
  const [directForm] = Form.useForm<DirectSlotFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const activeStation = useMemo(
    () => stations.find((station) => station.id === activeStationId) ?? null,
    [activeStationId, stations]
  );

  const activeInstruments = useAppSelector((state) =>
    selectInstrumentsOfStation(state, activeStationId)
  );

  /** 本站已发料、可上站登记的领用单（未回收） */
  const installableReqs = useMemo(() => {
    if (!activeStation) return [];
    return requisitions
      .filter(
        (req) =>
          req.stationCode.toUpperCase() === activeStation.code.toUpperCase() &&
          (req.state === '已发料' || req.state === '对账挂起')
      )
      .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
  }, [activeStation, requisitions]);

  /** 台站行：附带安装位、标定与超期统计 */
  const rows = useMemo<StationRow[]>(
    () =>
      stations
        .filter((station) => {
          const keyword = stationFilter.keyword.trim();
          if (keyword.length > 0 && !`${station.code}${station.bedrock}${station.siteNote}`.includes(keyword)) {
            return false;
          }
          if (stationFilter.bedrocks.length > 0 && !stationFilter.bedrocks.includes(station.bedrock)) return false;
          if (stationFilter.minElevM !== null && station.elevM < stationFilter.minElevM) return false;
          const count = allInstruments.filter((instrument) => instrument.stationId === station.id).length;
          if (stationFilter.onlyEmpty && count > 0) return false;
          return true;
        })
        .map((station) => {
          const stationInstruments = allInstruments.filter(
            (instrument) => instrument.stationId === station.id
          );
          const instrumentIds = new Set(stationInstruments.map((instrument) => instrument.id));
          const stationCalibrations = calibrations.filter((calibration) =>
            instrumentIds.has(calibration.instrumentId)
          );
          const unqualified = stationCalibrations.filter(
            (calibration) => calibration.responseVerdict === '不合格'
          ).length;
          const overdue = stationInstruments.filter((instrument) => {
            const own = calibrations
              .filter((calibration) => calibration.instrumentId === instrument.id)
              .sort((a, b) => b.date.localeCompare(a.date));
            const last = own.length > 0 ? own[0].date : instrument.installDate;
            return daysUntilDue(last, instrument.installDate) < 0;
          }).length;
          const pendingSlots = stationInstruments.filter((slot) => !slot.serialNo).length;
          const suspendedSlots = stationInstruments.filter((slot) => slot.reconcileResult === '挂起').length;
          return {
            station,
            instruments: stationInstruments,
            calibrationCount: stationCalibrations.length,
            unqualified,
            overdue,
            pendingSlots,
            suspendedSlots,
            worstVerdict: unqualified > 0 ? '不合格' : stationCalibrations.length > 0 ? '合格' : '待判定',
          };
        }),
    [allInstruments, calibrations, stationFilter, stations]
  );

  const totals = useMemo(
    () => ({
      stations: rows.length,
      instruments: rows.reduce((sum, row) => sum + row.instruments.length, 0),
      calibrations: rows.reduce((sum, row) => sum + row.calibrationCount, 0),
      unqualified: rows.reduce((sum, row) => sum + row.unqualified, 0),
      overdue: rows.reduce((sum, row) => sum + row.overdue, 0),
      pendingSlots: rows.reduce((sum, row) => sum + row.pendingSlots, 0),
      suspendedSlots: rows.reduce((sum, row) => sum + row.suspendedSlots, 0),
    }),
    [rows]
  );

  const stationFilterModel: FilterModel = {
    keyword: stationFilter.keyword,
    bedrocks: stationFilter.bedrocks,
    minElevM: stationFilter.minElevM,
  };

  const openStationCreate = () => {
    setEditingStationId(null);
    stationForm.setFieldsValue({
      code: `ST${String(stations.length + 1).padStart(2, '0')}`,
      lat: 30.8,
      lng: 103.5,
      elevM: 1000,
      bedrock: '花岗岩',
      siteNote: '',
    });
    setStationModalOpen(true);
  };

  const openStationEdit = (station: SeisStation) => {
    setEditingStationId(station.id);
    stationForm.setFieldsValue({
      code: station.code,
      lat: station.lat,
      lng: station.lng,
      elevM: station.elevM,
      bedrock: station.bedrock,
      siteNote: station.siteNote,
    });
    setStationModalOpen(true);
  };

  const submitStation = async () => {
    const values = await stationForm.validateFields();
    const errors = validateLatLng(Number(values.lat), Number(values.lng));
    if (errors.length > 0) {
      message.warning(`经纬度校验未通过：${errors.join('；')}`);
      return;
    }
    const duplicated = stations.some(
      (station) => station.code === values.code.trim() && station.id !== editingStationId
    );
    if (duplicated) {
      message.warning(`台站码「${values.code.trim()}」在本台阵已存在`);
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        arrayId,
        code: values.code.trim(),
        lat: Number(values.lat),
        lng: Number(values.lng),
        elevM: Number(values.elevM),
        bedrock: values.bedrock,
        siteNote: values.siteNote?.trim() ?? '',
      };
      if (editingStationId) {
        await dispatch(updateStation({ id: editingStationId, patch: payload })).unwrap();
        message.success('台站已更新');
      } else {
        await dispatch(createStation(payload)).unwrap();
        message.success(`台站 ${payload.code} 已新增（${formatLatLng(payload.lat, payload.lng)}）`);
      }
      setStationModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  /** 打开「按台站码开领用单」弹窗 */
  const openReqCreate = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingSlotId(null);
    reqForm.setFieldsValue({
      applicant: '',
      purpose: '',
      type: '宽频带',
      model: COMMON_MODELS['宽频带'][0] ?? '',
    });
    setReqModalOpen(true);
  };

  const submitReq = async () => {
    if (!activeStation) return;
    const values = await reqForm.validateFields();
    setSubmitting(true);
    try {
      const result = await dispatch(
        openStationRequisition({
          station: activeStation,
          draft: {
            applicant: values.applicant.trim(),
            purpose: values.purpose?.trim() ?? '',
            items: [{ type: values.type, model: values.model.trim(), qty: 1 }],
          },
        })
      ).unwrap();
      message.success(`已按台站 ${activeStation.code} 开出领用单 ${result.requisition.code}，待库房发料`);
      setReqModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '开单失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 打开「按已发料单上站登记」弹窗 */
  const openInstall = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingSlotId(null);
    const first = installableReqs[0];
    installForm.setFieldsValue({
      requisitionId: first?.id,
      installDate: dayjs(),
      state: '在用',
      remark: '',
    });
    setInstallModalOpen(true);
  };

  const submitInstall = async () => {
    if (!activeStation) return;
    const values = await installForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        installFromRequisition({
          stationId: activeStation.id,
          requisitionId: values.requisitionId,
          installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          state: values.state,
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success('上站登记完成，序列号已回流并自动对账');
      setInstallModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '上站登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 直接补录安装位（无单的历史/特殊情形；序列号可空，不写器材库台账） */
  const openDirectCreate = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingSlotId(null);
    directForm.setFieldsValue({
      type: '宽频带',
      model: COMMON_MODELS['宽频带'][0] ?? '',
      installDate: dayjs(),
      state: '在用',
      serialNo: '',
      remark: '',
    });
    setDirectModalOpen(true);
  };

  const openSlotEdit = (station: SeisStation, slot: Instrument) => {
    setActiveStationId(station.id);
    setEditingSlotId(slot.id);
    directForm.setFieldsValue({
      type: slot.type,
      model: slot.model,
      installDate: dayjs(slot.installDate),
      state: slot.state,
      serialNo: slot.serialNo ?? '',
      remark: slot.remark,
    });
    setDirectModalOpen(true);
  };

  const submitDirect = async () => {
    if (!activeStation) return;
    const values = await directForm.validateFields();
    const serialNo = values.serialNo?.trim() || null;
    setSubmitting(true);
    try {
      if (editingSlotId) {
        await dispatch(
          updateInstrument({
            id: editingSlotId,
            patch: {
              type: values.type,
              model: values.model.trim(),
              installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
              state: values.state,
              remark: values.remark?.trim() ?? '',
            },
          })
        ).unwrap();
        message.success('安装位信息已更新（序列号以器材库台账为准，不在此修改）');
      } else {
        await dispatch(
          createSlot({
            stationId: activeStation.id,
            type: values.type,
            model: values.model.trim(),
            serialNo,
            installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
            state: values.state,
            requisitionId: null,
            reconcileResult: null,
            reconcileNote: serialNo ? '手工补录，未走领用单，待对账确认' : '',
            remark: values.remark?.trim() ?? '',
          })
        ).unwrap();
        message.success(serialNo ? '安装位已补录（未关联领用单，请在器材库侧核对）' : '待发料安装位已补录');
      }
      setDirectModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkPending = async () => {
    const ids = Array.from(new Set(allInstruments.map((instrument) => instrument.id)));
    const targetIds = ids.filter((id) =>
      rows.some((row) => row.instruments.some((instrument) => instrument.id === id))
    );
    if (targetIds.length === 0) {
      message.warning('当前筛选范围内没有可批量操作的安装位');
      return;
    }
    await dispatch(bulkSetInstrumentState({ ids: targetIds, state: '待标定' })).unwrap();
    message.success(`已将 ${targetIds.length} 个安装位状态置为待标定`);
  };

  if (!ready) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (!array) {
    return (
      <RouteMissingPanel
        entityLabel="台阵"
        missingId={arrayId}
        fallbackPath={ROUTES.arrays}
        fallbackText="返回台阵台账"
        candidates={arrays.slice(0, 3).map((row) => ({
          id: row.id,
          label: `${row.name} 的台站安装位`,
          path: ROUTES.stations(row.id),
        }))}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Breadcrumb
            items={[
              { title: <a onClick={() => navigate(ROUTES.arrays)}>台阵台账</a> },
              { title: array.name },
              { title: '台站安装位' },
            ]}
          />
          <Typography.Title level={4} style={{ margin: '8px 0 4px', color: '#1e3a5f' }}>
            {array.name} · 台站名册与仪器安装位
          </Typography.Title>
          <p className="gb-hint">
            台网中心只管台站名册与安装位；仪器序列号、入库日期与领用单归器材库。上仪器请按台站码开领用单，
            由库房照单发料后再做上站登记，两侧按台站码 + 序列号对账。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<SyncOutlined />}
            onClick={() =>
              void dispatch(recomputeAperture(array.id))
                .unwrap()
                .then((result) => message.success(`已按经纬度重算孔径：${result.apertureKm} km`))
            }
          >
            重算孔径
          </Button>
          <Button onClick={() => void handleBulkPending()}>批量置为待标定</Button>
          <Button onClick={() => navigate(ROUTES.warehouse)}>前往器材库</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openStationCreate}>
            新增台站
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站数" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="安装位" value={totals.instruments} suffix="个" tone="primary" />
        <StatBadge label="待发料安装位" value={totals.pendingSlots} suffix="个" tone={totals.pendingSlots > 0 ? 'warning' : 'success'} />
        <StatBadge label="对账挂起" value={totals.suspendedSlots} suffix="个" tone={totals.suspendedSlots > 0 ? 'danger' : 'success'} />
        <StatBadge label="累计标定" value={totals.calibrations} suffix="次" tone="default" />
        <StatBadge
          label="超期未标定"
          value={totals.overdue}
          suffix="台"
          tone={totals.overdue > 0 ? 'warning' : 'success'}
        />
      </div>

      <FilterBar
        modelValue={stationFilterModel}
        selects={[
          {
            key: 'bedrocks',
            label: '基岩类型',
            options: BEDROCK_TYPES.map((bedrock) => ({ label: bedrock, value: bedrock })),
          },
        ]}
        numberRanges={[{ key: 'minElevM', label: '高程不低于', placeholder: '不限', suffix: 'm' }]}
        hasSwitch
        switchLabel="仅看未安装仪器的台站"
        switchValue={stationFilter.onlyEmpty}
        keywordPlaceholder="搜索台站码 / 基岩 / 场地备注"
        onChange={(next, switchValue) => {
          dispatch(
            patchStationFilter({
              keyword: next.keyword,
              bedrocks: ((next.bedrocks as string[]) ?? []) as BedrockType[],
              minElevM: (next.minElevM as number | null) ?? null,
              onlyEmpty: switchValue,
            })
          );
        }}
        onReset={() => dispatch(resetStationFilter())}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={stations.length === 0 ? '该台阵还没有台站' : '没有符合条件的台站'}
          description="新增台站并录入经纬度、高程与基岩类型后，即可按台站码开领用单上仪器。"
          actionText="新增台站"
          secondaryText="重置筛选"
          onAction={openStationCreate}
          onSecondary={() => dispatch(resetStationFilter())}
        />
      ) : (
        <Table
          rowKey={(row) => row.station.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={false}
          columns={[
            {
              title: '台站码',
              width: 110,
              render: (_: unknown, row: StationRow) => <span className="gb-mono">{row.station.code}</span>,
            },
            {
              title: '经纬度',
              width: 200,
              render: (_: unknown, row: StationRow) => (
                <div>
                  <div className="gb-mono">
                    {row.station.lat.toFixed(4)}, {row.station.lng.toFixed(4)}
                  </div>
                  <div className="gb-hint gb-mono">{formatLatLng(row.station.lat, row.station.lng)}</div>
                </div>
              ),
            },
            {
              title: '高程 (m)',
              width: 100,
              align: 'right',
              render: (_: unknown, row: StationRow) => <span className="gb-mono">{row.station.elevM}</span>,
            },
            {
              title: '基岩',
              width: 110,
              render: (_: unknown, row: StationRow) => <Tag>{row.station.bedrock}</Tag>,
            },
            {
              title: '安装位数',
              width: 110,
              align: 'center',
              render: (_: unknown, row: StationRow) => (
                <Button type="link" size="small" onClick={() => setActiveStationId(row.station.id)}>
                  {row.instruments.length} 个
                  {row.pendingSlots > 0 ? <Tag color="orange" style={{ marginLeft: 4 }}>待发料 {row.pendingSlots}</Tag> : null}
                </Button>
              ),
            },
            {
              title: '对账',
              width: 120,
              align: 'center',
              render: (_: unknown, row: StationRow) =>
                row.suspendedSlots > 0 ? (
                  <Tooltip title="安装位与库房发料记录对不上，先摆着等确认；可在器材库页认下">
                    <Tag color="red">挂起 {row.suspendedSlots}</Tag>
                  </Tooltip>
                ) : (
                  <Tag color="green">正常</Tag>
                ),
            },
            {
              title: '标定 / 不合格',
              width: 130,
              align: 'right',
              render: (_: unknown, row: StationRow) => (
                <span className="gb-mono">
                  {row.calibrationCount} /{' '}
                  <span className={row.unqualified > 0 ? 'gb-danger' : ''}>{row.unqualified}</span>
                </span>
              ),
            },
            {
              title: '标定提醒',
              width: 120,
              render: (_: unknown, row: StationRow) =>
                row.overdue > 0 ? <Tag color="red">超期 {row.overdue} 台</Tag> : <Tag color="green">按期</Tag>,
            },
            {
              title: '综合结论',
              width: 110,
              render: (_: unknown, row: StationRow) => <QualifyTag verdict={row.worstVerdict as never} size="small" />,
            },
            { title: '场地备注', dataIndex: ['station', 'siteNote'], ellipsis: true },
            {
              title: '操作',
              width: 320,
              render: (_: unknown, row: StationRow) => (
                <Space size={6} wrap>
                  <Button size="small" type="primary" icon={<FileAddOutlined />} onClick={() => openReqCreate(row.station)}>
                    开领用单
                  </Button>
                  <Button
                    size="small"
                    icon={<UploadOutlined />}
                    onClick={() => openInstall(row.station)}
                    disabled={
                      !requisitions.some(
                        (req) =>
                          req.stationCode.toUpperCase() === row.station.code.toUpperCase() &&
                          (req.state === '已发料' || req.state === '对账挂起')
                      )
                    }
                  >
                    上站登记
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openStationEdit(row.station)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除台站"
                    description={`将同时删除其安装位、标定与更换记录，确认删除「${row.station.code}」？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeStation(row.station.id))
                        .unwrap()
                        .then(() => message.success('台站及其下级数据已删除'))
                    }
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}

      {activeStation ? (
        <Card
          className="gb-panel"
          size="small"
          title={`${activeStation.code} · 仪器安装位（${activeInstruments.length} 个）`}
          extra={
            <Space>
              <Button size="small" type="primary" icon={<FileAddOutlined />} onClick={() => openReqCreate(activeStation)}>
                开领用单
              </Button>
              <Button
                size="small"
                icon={<UploadOutlined />}
                disabled={installableReqs.length === 0}
                onClick={() => openInstall(activeStation)}
              >
                上站登记{installableReqs.length > 0 ? `（${installableReqs.length} 单可装）` : ''}
              </Button>
              <Button size="small" onClick={() => openDirectCreate(activeStation)}>
                补录安装位
              </Button>
            </Space>
          }
        >
          {activeInstruments.length === 0 ? (
            <EmptyPanel
              title="该台站还没有安装位"
              description="按台站码开领用单，等库房照单发料后做上站登记；序列号由器材库发料回流。"
              actionText="开领用单"
              onAction={() => openReqCreate(activeStation)}
              compact
            />
          ) : (
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={activeInstruments}
              pagination={false}
              columns={[
                { title: '类型', dataIndex: 'type', width: 90, render: (value: string) => <Tag>{value}</Tag> },
                { title: '型号', dataIndex: 'model', width: 150 },
                {
                  title: '序列号（库房回流）',
                  dataIndex: 'serialNo',
                  width: 210,
                  render: (value: string | null) =>
                    value ? (
                      <span className="gb-mono">{value}</span>
                    ) : (
                      <Tooltip title="已按台站码开单，等待器材库照单发料">
                        <Tag color="orange">待发料</Tag>
                      </Tooltip>
                    ),
                },
                { title: '安装日期', dataIndex: 'installDate', width: 110, className: 'gb-mono' },
                {
                  title: '状态',
                  dataIndex: 'state',
                  width: 90,
                  render: (value: string) => (
                    <Tag color={value === '在用' ? 'green' : value === '待标定' ? 'orange' : 'default'}>{value}</Tag>
                  ),
                },
                {
                  title: '对账',
                  width: 100,
                  render: (_: unknown, slot: Instrument) =>
                    slot.reconcileResult ? (
                      <Tag color={reconcileTagColor[slot.reconcileResult]}>{slot.reconcileResult}</Tag>
                    ) : slot.serialNo ? (
                      <span className="gb-hint">未对账</span>
                    ) : (
                      <span className="gb-hint">—</span>
                    ),
                },
                {
                  title: '来源单据',
                  width: 170,
                  render: (_: unknown, slot: Instrument) => {
                    if (!slot.requisitionId) return <span className="gb-hint">手工补录</span>;
                    const req = requisitions.find((item) => item.id === slot.requisitionId);
                    if (!req) return <span className="gb-mono">{slot.requisitionId}</span>;
                    return (
                      <Tooltip title={req.purpose}>
                        <Tag color={requisitionStateColor(req.state)}>
                          <span className="gb-mono">{req.code}</span>
                        </Tag>
                      </Tooltip>
                    );
                  },
                },
                {
                  title: '标定次数',
                  width: 80,
                  align: 'right',
                  render: (_: unknown, slot: Instrument) => (
                    <span className="gb-mono">
                      {calibrations.filter((row) => row.instrumentId === slot.id).length}
                    </span>
                  ),
                },
                {
                  title: '最近结论',
                  width: 150,
                  render: (_: unknown, slot: Instrument) => {
                    const own = calibrations
                      .filter((row) => row.instrumentId === slot.id)
                      .sort((a, b) => b.date.localeCompare(a.date));
                    const latest = own[0];
                    if (!latest) return <span className="gb-hint">尚未标定</span>;
                    return (
                      <QualifyTag
                        verdict={latest.responseVerdict}
                        sensitivity={round(latest.sensitivity, 2)}
                        size="small"
                      />
                    );
                  },
                },
                {
                  title: '距下次标定',
                  width: 120,
                  render: (_: unknown, slot: Instrument) => {
                    const own = calibrations
                      .filter((row) => row.instrumentId === slot.id)
                      .sort((a, b) => b.date.localeCompare(a.date));
                    const last = own.length > 0 ? own[0].date : slot.installDate;
                    const days = daysUntilDue(last, slot.installDate);
                    return (
                      <span className={days < 0 ? 'gb-danger gb-mono' : 'gb-mono'}>
                        {days < 0 ? `超期 ${Math.abs(days)} 天` : `剩余 ${days} 天`}
                      </span>
                    );
                  },
                },
                {
                  title: '操作',
                  width: 150,
                  render: (_: unknown, slot: Instrument) => (
                    <Space size={6}>
                      <Button size="small" onClick={() => openSlotEdit(activeStation, slot)}>
                        编辑
                      </Button>
                      <Popconfirm
                        title="删除安装位"
                        description="将同时删除其标定与更换记录（领用单留在器材库）。确认删除？"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          void dispatch(removeInstrument(slot.id))
                            .unwrap()
                            .then(() => message.success('安装位及其记录已删除'))
                        }
                      >
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </Card>
      ) : (
        <Card className="gb-panel" size="small">
          <EmptyPanel
            title="请选择台站查看安装位"
            description="在上表点击台站的「安装位数」或「开领用单」，即可维护该台站的仪器安装位。"
            compact
          />
        </Card>
      )}

      <p className="gb-hint">
        流程：按台站码开领用单 → 器材库照单发料（序列号唯一占用）→ 本站上站登记 → 两侧按台站码 + 序列号对账；
        对不上先摆着等确认，由库房重试，中心认下的不退回。更换/标定仍以安装位为对象，当前共 {replaces.length} 条更换记录。
      </p>

      {/* 台站新增/编辑 */}
      <Modal
        open={stationModalOpen}
        title={editingStationId ? '编辑台站' : '新增台站'}
        onCancel={() => setStationModalOpen(false)}
        onOk={() => void submitStation()}
        confirmLoading={submitting}
        okText={editingStationId ? '保存修改' : '新增台站'}
        destroyOnClose
      >
        <Form form={stationForm} layout="vertical" preserve={false}>
          <Form.Item name="code" label="台站码" rules={[{ required: true, message: '请填写台站码' }]}>
            <Input placeholder="如：LTX01" maxLength={20} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="lat" label="纬度" rules={[{ required: true, message: '请填写纬度' }]}>
                <InputNumber min={-90} max={90} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="lng" label="经度" rules={[{ required: true, message: '请填写经度' }]}>
                <InputNumber min={-180} max={180} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="elevM" label="高程 (m)" rules={[{ required: true }]}>
                <InputNumber min={-500} max={9000} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bedrock" label="基岩类型" rules={[{ required: true }]}>
                <Select options={BEDROCK_TYPES.map((bedrock) => ({ label: bedrock, value: bedrock }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="siteNote" label="场地备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：基岩出露，噪声本底低" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 按台站码开领用单 */}
      <Modal
        open={reqModalOpen}
        title={`按台站码开领用单 · ${activeStation?.code ?? ''}`}
        onCancel={() => setReqModalOpen(false)}
        onOk={() => void submitReq()}
        confirmLoading={submitting}
        okText="开单（生成待发料安装位）"
        destroyOnClose
      >
        <Form form={reqForm} layout="vertical" preserve={false}>
          <AlertLike />
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
                <Select
                  options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
                  onChange={(value: InstrumentType) =>
                    reqForm.setFieldValue('model', COMMON_MODELS[value]?.[0] ?? '')
                  }
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
                <Input placeholder="如：CMG-3ESPC" maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="applicant" label="领用人" rules={[{ required: true, message: '请填写领用人' }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="purpose" label="用途说明">
                <Input maxLength={40} placeholder="如：台阵扩容 / 故障更换" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 按已发料单上站登记 */}
      <Modal
        open={installModalOpen}
        title={`上站登记 · ${activeStation?.code ?? ''}`}
        onCancel={() => setInstallModalOpen(false)}
        onOk={() => void submitInstall()}
        confirmLoading={submitting}
        okText="登记并对账"
        destroyOnClose
      >
        <Form form={installForm} layout="vertical" preserve={false}>
          <Form.Item name="requisitionId" label="选择已发料到本站的领用单" rules={[{ required: true, message: '请选择领用单' }]}>
            <Select
              options={installableReqs.map((req) => {
                const item = req.items.find((line) => line.serialNo);
                return {
                  label: `${req.code} · ${item?.type ?? ''}/${item?.model ?? ''} · 发料 ${item?.serialNo ?? ''}`,
                  value: req.id,
                };
              })}
              notFoundContent="本站当前没有已发料、可上站登记的领用单"
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="state" label="安装后状态" rules={[{ required: true }]}>
                <Select options={INSTRUMENT_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="安装备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：井下安装，深度 42 m" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 补录 / 编辑安装位（序列号只读占位，不允许覆盖器材库台账） */}
      <Modal
        open={directModalOpen}
        title={`${editingSlotId ? '编辑安装位' : '补录安装位'} · ${activeStation?.code ?? ''}`}
        onCancel={() => setDirectModalOpen(false)}
        onOk={() => void submitDirect()}
        confirmLoading={submitting}
        okText={editingSlotId ? '保存修改' : '补录'}
        destroyOnClose
      >
        <Form form={directForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
                <Select
                  disabled={!!editingSlotId}
                  options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
                  onChange={(value: InstrumentType) =>
                    directForm.setFieldValue('model', COMMON_MODELS[value]?.[0] ?? '')
                  }
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="state" label="状态" rules={[{ required: true }]}>
                <Select options={INSTRUMENT_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="serialNo"
            label="序列号（正常流程由库房发料回流，仅特殊补录可填）"
            rules={[{ required: false }]}
          >
            <Input
              maxLength={60}
              disabled={!!editingSlotId}
              placeholder={editingSlotId ? undefined : '可留空，表示待发料安装位'}
            />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** 开单弹窗内的轻提示（避免额外引入 Alert 改动 import 块） */
function AlertLike() {
  return (
    <p className="gb-hint" style={{ marginBottom: 12 }}>
      按台站码开单后在本站生成一个「待发料」安装位；具体序列号由器材库照单发料时确定，发料后回流到安装位。
    </p>
  );
}
