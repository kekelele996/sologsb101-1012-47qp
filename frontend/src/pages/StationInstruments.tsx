/**
 * 模块 2：/stations/:id/instruments 台站仪器登记与安装位置维护
 * 台网中心管台站名册与仪器安装位：要上仪器时按台站码开领用单，库房照单发料，
 * 安装位留痕（序列号 / 安装日期 / 领用单号 / 认下状态）。
 * 复用 <StatBadge>、<QualifyTag>。
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
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
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
  selectInstallationCountsByStation,
  selectInstallations,
  selectInstallationsOfStation,
  selectStationFilter,
  selectStationsOfArray,
  updateInstallationPosition,
  updateStation,
} from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { bulkSetInstrumentState } from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import {
  installInstrumentAtStation,
  recoverRequisition,
  selectRequisitions,
} from '@/stores/warehouseSlice';
import { BEDROCK_TYPES, validateLatLng, type BedrockType, type SeisStation } from '@/types/station';
import { daysUntilDue, type Instrument } from '@/types/instrument';
import type { Installation } from '@/types/installation';
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

interface InstallFormValues {
  serialNo: string;
  installDate: dayjs.Dayjs | null;
  remark: string;
}

/** 台站行统计：安装位数、标定数、不合格数与超期台数 */
interface StationRow {
  station: SeisStation;
  installations: Installation[];
  calibrationCount: number;
  unqualified: number;
  overdue: number;
  worstVerdict: string;
}

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
  const allInstallations = useAppSelector(selectInstallations);
  const requisitions = useAppSelector(selectRequisitions);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const installationCounts = useAppSelector(selectInstallationCountsByStation);

  const [stationModalOpen, setStationModalOpen] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [editingInstallationId, setEditingInstallationId] = useState<string | null>(null);
  const [activeStationId, setActiveStationId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stationForm] = Form.useForm<StationFormValues>();
  const [installForm] = Form.useForm<InstallFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const activeStation = useMemo(
    () => stations.find((station) => station.id === activeStationId) ?? null,
    [activeStationId, stations]
  );

  const activeInstallations = useAppSelector((state) =>
    selectInstallationsOfStation(state, activeStationId)
  );

  /** 序列号 → 仪器档案（类型 / 型号 / 标定id） */
  const instrumentBySerial = useMemo(() => {
    const map = new Map<string, Instrument>();
    allInstruments.forEach((row) => map.set(row.serialNo, row));
    return map;
  }, [allInstruments]);

  /** 在库可发料仪器（登记安装位时选） */
  const inStockInstruments = useMemo(
    () => allInstruments.filter((row) => row.logisticsState === '在库'),
    [allInstruments]
  );

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
          const count = installationCounts[station.id] ?? 0;
          if (stationFilter.onlyEmpty && count > 0) return false;
          return true;
        })
        .map((station) => {
          const stationInstallations = allInstallations
            .filter((row) => row.stationId === station.id && row.state === '在装')
            .sort((a, b) => b.installDate.localeCompare(a.installDate));
          const stationInstrumentIds = new Set(
            stationInstallations
              .map((row) => instrumentBySerial.get(row.serialNo)?.id)
              .filter((id): id is string => !!id)
          );
          const stationCalibrations = calibrations.filter((calibration) =>
            stationInstrumentIds.has(calibration.instrumentId)
          );
          const unqualified = stationCalibrations.filter(
            (calibration) => calibration.responseVerdict === '不合格'
          ).length;
          const overdue = stationInstallations.filter((installation) => {
            const instrument = instrumentBySerial.get(installation.serialNo);
            if (!instrument) return false;
            const own = calibrations
              .filter((calibration) => calibration.instrumentId === instrument.id)
              .sort((a, b) => b.date.localeCompare(a.date));
            const last = own.length > 0 ? own[0].date : installation.installDate;
            return daysUntilDue(last, installation.installDate) < 0;
          }).length;
          return {
            station,
            installations: stationInstallations,
            calibrationCount: stationCalibrations.length,
            unqualified,
            overdue,
            worstVerdict: unqualified > 0 ? '不合格' : stationCalibrations.length > 0 ? '合格' : '待判定',
          };
        }),
    [allInstruments, allInstallations, calibrations, installationCounts, stationFilter, stations, instrumentBySerial]
  );

  const totals = useMemo(
    () => ({
      stations: rows.length,
      instruments: rows.reduce((sum, row) => sum + row.installations.length, 0),
      calibrations: rows.reduce((sum, row) => sum + row.calibrationCount, 0),
      unqualified: rows.reduce((sum, row) => sum + row.unqualified, 0),
      overdue: rows.reduce((sum, row) => sum + row.overdue, 0),
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

  const openInstallCreate = (station: SeisStation) => {
    setActiveStationId(station.id);
    setEditingInstallationId(null);
    installForm.setFieldsValue({
      serialNo: undefined,
      installDate: dayjs(),
      remark: '',
    });
    setInstallModalOpen(true);
  };

  const openInstallEdit = (station: SeisStation, installation: Installation) => {
    setActiveStationId(station.id);
    setEditingInstallationId(installation.id);
    installForm.setFieldsValue({
      serialNo: installation.serialNo,
      installDate: dayjs(installation.installDate),
      remark: installation.remark,
    });
    setInstallModalOpen(true);
  };

  const submitInstall = async () => {
    if (!activeStationId || !activeStation) {
      message.warning('请先选择一个台站');
      return;
    }
    const values = await installForm.validateFields();
    setSubmitting(true);
    try {
      if (editingInstallationId) {
        await dispatch(
          updateInstallationPosition({
            id: editingInstallationId,
            patch: {
              installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
              remark: values.remark?.trim() ?? '',
            },
          })
        ).unwrap();
        message.success('安装位已更新');
      } else {
        await dispatch(
          installInstrumentAtStation({
            stationId: activeStationId,
            serialNo: values.serialNo,
            installDate: values.installDate ? values.installDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
            remark: values.remark?.trim() ?? '',
          })
        ).unwrap();
        message.success('已按台站码开领用单并发料上站，安装位已登记');
      }
      setInstallModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '上站失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 拆除：回收该序列号未回收领用单（安装位拆回、仪器回库待验） */
  const handleRecover = async (installation: Installation) => {
    const open = requisitions.find(
      (row) => row.serialNo === installation.serialNo && row.state === '已发料'
    );
    if (!open) {
      message.warning('该序列号没有未回收的领用单');
      return;
    }
    try {
      await dispatch(recoverRequisition(open.id)).unwrap();
      message.success('领用单已回收，安装位已拆回，仪器回库待验');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '回收失败');
    }
  };

  const handleBulkPending = async () => {
    const ids = Array.from(
      new Set(
        rows.flatMap((row) =>
          row.installations
            .map((installation) => instrumentBySerial.get(installation.serialNo)?.id)
            .filter((id): id is string => !!id)
        )
      )
    );
    if (ids.length === 0) {
      message.warning('当前筛选范围内没有可批量操作的仪器');
      return;
    }
    await dispatch(bulkSetInstrumentState({ ids, state: '待标定' })).unwrap();
    message.success(`已将 ${ids.length} 台仪器状态置为待标定`);
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
          label: `${row.name} 的台站仪器`,
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
              { title: '台站仪器' },
            ]}
          />
          <Typography.Title level={4} style={{ margin: '8px 0 4px', color: '#1e3a5f' }}>
            {array.name} · 台站仪器登记
          </Typography.Title>
          <p className="gb-hint">
            台网中心管台站名册与仪器安装位；要上仪器时按台站码开领用单，库房照单发料，同一台仪器不能同时挂在两张没回收的单上。
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openStationCreate}>
            新增台站
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="台站数" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="在装仪器" value={totals.instruments} suffix="台" tone="primary" />
        <StatBadge label="累计标定" value={totals.calibrations} suffix="次" tone="default" />
        <StatBadge
          label="不合格标定"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
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
          description="新增台站并录入经纬度、高程与基岩类型后，即可开领用单上仪器并登记安装位。"
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
              title: '在装仪器',
              width: 110,
              align: 'center',
              render: (_: unknown, row: StationRow) => (
                <Button type="link" size="small" onClick={() => setActiveStationId(row.station.id)}>
                  {row.installations.length} 台
                </Button>
              ),
            },
            {
              title: '标定 / 不合格',
              width: 140,
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
              width: 130,
              render: (_: unknown, row: StationRow) =>
                row.overdue > 0 ? <Tag color="red">超期 {row.overdue} 台</Tag> : <Tag color="green">按期</Tag>,
            },
            {
              title: '综合结论',
              width: 120,
              render: (_: unknown, row: StationRow) => <QualifyTag verdict={row.worstVerdict as never} size="small" />,
            },
            { title: '场地备注', dataIndex: ['station', 'siteNote'], ellipsis: true },
            {
              title: '操作',
              width: 250,
              render: (_: unknown, row: StationRow) => (
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => openInstallCreate(row.station)}>
                    上仪器
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openStationEdit(row.station)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除台站"
                    description="将同时删除其仪器、标定、更换记录与安装位，确认删除「{row.station.code}」？"
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
          title={`${activeStation.code} · 安装位清单（${activeInstallations.length} 台）`}
          extra={
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openInstallCreate(activeStation)}>
              上仪器
            </Button>
          }
        >
          {activeInstallations.length === 0 ? (
            <EmptyPanel
              title="该台站还没有安装位"
              description="选择器材库中在库的仪器，按台站码开领用单上站，安装位自动留痕。"
              actionText="上仪器"
              onAction={() => openInstallCreate(activeStation)}
              compact
            />
          ) : (
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={activeInstallations}
              pagination={false}
              columns={[
                {
                  title: '序列号',
                  dataIndex: 'serialNo',
                  width: 200,
                  render: (value: string) => <span className="gb-mono">{value}</span>,
                },
                {
                  title: '类型 / 型号',
                  width: 180,
                  render: (_: unknown, installation: Installation) => {
                    const instrument = instrumentBySerial.get(installation.serialNo);
                    return instrument ? (
                      <span>
                        <Tag>{instrument.type}</Tag>
                        {instrument.model}
                      </span>
                    ) : (
                      <span className="gb-hint">档案缺失</span>
                    );
                  },
                },
                { title: '安装日期', dataIndex: 'installDate', width: 120, className: 'gb-mono' },
                {
                  title: '领用单号',
                  dataIndex: 'requisitionNo',
                  width: 200,
                  render: (v: string | null) => (v ? <span className="gb-mono">{v}</span> : <span className="gb-hint">补单缺失</span>),
                },
                {
                  title: '状态',
                  dataIndex: 'state',
                  width: 90,
                  render: (value: string) => <Tag color={value === '在装' ? 'green' : 'default'}>{value}</Tag>,
                },
                {
                  title: '认下',
                  dataIndex: 'acknowledged',
                  width: 90,
                  render: (acknowledged: boolean) =>
                    acknowledged ? <Tag color="green">已认下</Tag> : <Tag>未认下</Tag>,
                },
                {
                  title: '标定次数',
                  width: 90,
                  align: 'right',
                  render: (_: unknown, installation: Installation) => {
                    const instrument = instrumentBySerial.get(installation.serialNo);
                    if (!instrument) return <span className="gb-mono">0</span>;
                    return (
                      <span className="gb-mono">
                        {calibrations.filter((row) => row.instrumentId === instrument.id).length}
                      </span>
                    );
                  },
                },
                {
                  title: '最近结论',
                  width: 170,
                  render: (_: unknown, installation: Installation) => {
                    const instrument = instrumentBySerial.get(installation.serialNo);
                    if (!instrument) return <span className="gb-hint">尚未标定</span>;
                    const own = calibrations
                      .filter((row) => row.instrumentId === instrument.id)
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
                  width: 130,
                  render: (_: unknown, installation: Installation) => {
                    const instrument = instrumentBySerial.get(installation.serialNo);
                    if (!instrument) return <span className="gb-hint">—</span>;
                    const own = calibrations
                      .filter((row) => row.instrumentId === instrument.id)
                      .sort((a, b) => b.date.localeCompare(a.date));
                    const last = own.length > 0 ? own[0].date : installation.installDate;
                    const days = daysUntilDue(last, installation.installDate);
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
                  render: (_: unknown, installation: Installation) => (
                    <Space size={6}>
                      <Button size="small" onClick={() => openInstallEdit(activeStation, installation)}>
                        编辑
                      </Button>
                      {installation.state === '在装' ? (
                        <Popconfirm
                          title="拆回仪器"
                          description="回收该序列号的领用单，安装位置为已拆回，仪器回库待验，确认拆回？"
                          okText="拆回"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void handleRecover(installation)}
                        >
                          <Button size="small" danger>
                            拆回
                          </Button>
                        </Popconfirm>
                      ) : null}
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
            description="在上表点击任一「在装仪器」或「上仪器」按钮，即可查看与维护该台站的安装位。"
            compact
          />
        </Card>
      )}

      <p className="gb-hint">
        对账：台网中心安装位与器材库领用单按台站码 + 序列号对账，对不上先摆着等确认，中心认下的不退回。
        当前共 {replaces.length} 条更换记录。
      </p>

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

      <Modal
        open={installModalOpen}
        title={`${editingInstallationId ? '编辑安装位' : '上仪器'} · ${activeStation?.code ?? ''}`}
        onCancel={() => setInstallModalOpen(false)}
        onOk={() => void submitInstall()}
        confirmLoading={submitting}
        okText={editingInstallationId ? '保存修改' : '开单上站'}
        destroyOnClose
      >
        <Form form={installForm} layout="vertical" preserve={false}>
          {!editingInstallationId ? (
            <Form.Item
              name="serialNo"
              label="领用仪器（器材库在库）"
              rules={[{ required: true, message: '请选择在库仪器' }]}
            >
              <Select
                showSearch
                placeholder="选择器材库在库仪器，按台站码开领用单"
                optionFilterProp="label"
                options={inStockInstruments.map((row) => ({
                  label: `${row.serialNo} · ${row.type} ${row.model}`,
                  value: row.serialNo,
                }))}
              />
            </Form.Item>
          ) : (
            <Form.Item name="serialNo" label="序列号">
              <Input disabled />
            </Form.Item>
          )}
          <Form.Item name="installDate" label="安装（上站）日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：井下安装，深度 42 m" />
          </Form.Item>
          {!editingInstallationId ? (
            <p className="gb-hint">
              提交后按台站码生成领用单（库房照单发料），同一台仪器不能同时挂在两张没回收的单上；安装位同步留痕。
            </p>
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
