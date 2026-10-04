/**
 * 器材库台账：在库仪器（序列号 / 入库日期）、领用单与排队。
 * 要上仪器时按台站码开领用单，库房照单发料；同一台仪器不能同时挂在两张没回收的单上；
 * 在库仪器有容量上限，排不下的先排队等下一批。
 * 复用 <StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
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
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectStations } from '@/stores/arraySlice';
import {
  createInstrument,
  removeInstrument,
  selectInstruments,
  updateInstrument,
} from '@/stores/instrumentSlice';
import {
  dismissBackfillReport,
  issueRequisition,
  processQueue,
  recoverRequisition,
  restockInstrument,
  selectBackfillReport,
  setCapacityValue,
  selectRequisitions,
  selectWarehouseCapacity,
} from '@/stores/warehouseSlice';
import { INSTRUMENT_TYPES, type Instrument, type InstrumentType } from '@/types/instrument';
import { COMMON_MODELS } from '@/types/instrument';
import { LOGISTICS_STATES, type LogisticsState } from '@/types/instrument';
import { initDatabase } from '@/utils/db';

interface StockInFormValues {
  type: InstrumentType;
  model: string;
  serialNo: string;
  stockInDate: dayjs.Dayjs | null;
  remark: string;
}

interface IssueFormValues {
  stationCode: string;
  issueDate: dayjs.Dayjs | null;
  remark: string;
}

const LOGISTICS_COLOR: Record<LogisticsState, string> = {
  在库: 'green',
  排队: 'orange',
  已发料: 'blue',
  已安装: 'cyan',
  待回收: 'default',
};

export default function WarehouseBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const requisitions = useAppSelector(selectRequisitions);
  const capacity = useAppSelector(selectWarehouseCapacity);
  const backfillReport = useAppSelector(selectBackfillReport);

  const [stockInOpen, setStockInOpen] = useState(false);
  const [editingInstrument, setEditingInstrument] = useState<Instrument | null>(null);
  const [issueTarget, setIssueTarget] = useState<Instrument | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stockInForm] = Form.useForm<StockInFormValues>();
  const [issueForm] = Form.useForm<IssueFormValues>();

  useEffect(() => {
    if (instruments.length === 0) void initDatabase();
  }, [instruments.length]);

  const stationCodeOptions = useMemo(
    () =>
      stations
        .map((station) => ({ label: `${station.code}（${station.lat.toFixed(2)},${station.lng.toFixed(2)}）`, value: station.code }))
        .sort((a, b) => a.value.localeCompare(b.value, 'zh-Hans-CN')),
    [stations]
  );

  const stats = useMemo(() => {
    const count = (state: LogisticsState) =>
      instruments.filter((row) => row.logisticsState === state).length;
    return {
      在库: count('在库'),
      排队: count('排队'),
      已发料: count('已发料'),
      已安装: count('已安装'),
      待回收: count('待回收'),
    };
  }, [instruments]);

  const openStockIn = (instrument?: Instrument) => {
    setEditingInstrument(instrument ?? null);
    stockInForm.setFieldsValue({
      type: instrument?.type ?? '宽频带',
      model: instrument?.model ?? COMMON_MODELS[instrument?.type ?? '宽频带'][0] ?? '',
      serialNo: instrument?.serialNo ?? '',
      stockInDate: instrument ? dayjs(instrument.stockInDate) : dayjs(),
      remark: instrument?.remark ?? '',
    });
    setStockInOpen(true);
  };

  const submitStockIn = async () => {
    const values = await stockInForm.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        type: values.type,
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        stockInDate: values.stockInDate ? values.stockInDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        remark: values.remark?.trim() ?? '',
      };
      if (editingInstrument) {
        await dispatch(
          updateInstrument({
            id: editingInstrument.id,
            patch: payload,
          })
        ).unwrap();
        message.success('仪器档案已更新');
      } else {
        await dispatch(
          createInstrument({
            ...payload,
            stationId: null,
            installDate: null,
            state: '在用',
            requisitionNo: null,
          })
        ).unwrap();
        message.success('仪器已入库登记');
      }
      setStockInOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '入库失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openIssue = (instrument: Instrument) => {
    setIssueTarget(instrument);
    issueForm.setFieldsValue({
      stationCode: undefined,
      issueDate: dayjs(),
      remark: '',
    });
  };

  const submitIssue = async () => {
    if (!issueTarget) return;
    const values = await issueForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        issueRequisition({
          serialNo: issueTarget.serialNo,
          stationCode: values.stationCode,
          issueDate: values.issueDate ? values.issueDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          remark: values.remark,
        })
      ).unwrap();
      message.success(`领用单已发料：${issueTarget.serialNo} → ${values.stationCode}`);
      setIssueTarget(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '开单失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleProcessQueue = async () => {
    const result = await dispatch(processQueue()).unwrap();
    if (result.moved > 0) message.success(`下一批入库 ${result.moved} 台，已转在库`);
    else message.info(`库容已满（${result.capacity} 台），暂无空位`);
  };

  const requisitionColumns = [
    {
      title: '领用单号',
      dataIndex: 'requisitionNo',
      width: 200,
      render: (value: string) => <span className="gb-mono">{value}</span>,
    },
    { title: '台站码', dataIndex: 'stationCode', width: 110, render: (v: string) => <span className="gb-mono">{v}</span> },
    { title: '序列号', dataIndex: 'serialNo', width: 220, render: (v: string) => <span className="gb-mono">{v}</span> },
    { title: '发料日期', dataIndex: 'issueDate', width: 120, className: 'gb-mono' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (value: string) => <Tag color={value === '已发料' ? 'blue' : 'green'}>{value}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'backfilled',
      width: 100,
      render: (backfilled: boolean) =>
        backfilled ? <Tag color="gold">升级补单</Tag> : <Tag>正常领用</Tag>,
    },
    { title: '回收日期', dataIndex: 'recoveredAt', width: 120, className: 'gb-mono', render: (v: string | null) => v ?? '—' },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, row: (typeof requisitions)[number]) =>
        row.state === '已发料' ? (
          <Popconfirm
            title="回收领用单"
            description="回收后安装位拆回、仪器回库待验，确认回收？"
            okText="回收"
            cancelText="取消"
            onConfirm={() =>
              dispatch(recoverRequisition(row.id))
                .unwrap()
                .then(() => message.success('领用单已回收'))
            }
          >
            <Button size="small" icon={<CheckCircleOutlined />}>
              回收
            </Button>
          </Popconfirm>
        ) : (
          <span className="gb-hint">已闭环</span>
        ),
    },
  ];

  const instrumentColumns = [
    { title: '序列号', dataIndex: 'serialNo', width: 220, render: (v: string) => <span className="gb-mono">{v}</span> },
    { title: '类型', dataIndex: 'type', width: 90, render: (v: string) => <Tag>{v}</Tag> },
    { title: '型号', dataIndex: 'model', width: 150 },
    { title: '入库日期', dataIndex: 'stockInDate', width: 120, className: 'gb-mono' },
    {
      title: '物流状态',
      dataIndex: 'logisticsState',
      width: 100,
      render: (value: LogisticsState) => <Tag color={LOGISTICS_COLOR[value]}>{value}</Tag>,
    },
    {
      title: '当前领用单号',
      dataIndex: 'requisitionNo',
      width: 200,
      render: (v: string | null) => (v ? <span className="gb-mono">{v}</span> : '—'),
    },
    {
      title: '操作',
      width: 260,
      render: (_: unknown, row: Instrument) => (
        <Space size={6}>
          {row.logisticsState === '在库' ? (
            <Button size="small" type="primary" icon={<ExportOutlined />} onClick={() => openIssue(row)}>
              发料
            </Button>
          ) : null}
          {row.logisticsState === '待回收' ? (
            <Button
              size="small"
              icon={<ImportOutlined />}
              onClick={() =>
                dispatch(restockInstrument(row.id))
                  .unwrap()
                  .then(() => message.success('已验收入库，仪器可再次发料'))
              }
            >
              验收入库
            </Button>
          ) : null}
          <Button size="small" icon={<EditOutlined />} onClick={() => openStockIn(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除仪器档案"
            description="删除后其标定、更换记录与安装位一并删除，确认删除？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              dispatch(removeInstrument(row.id))
                .unwrap()
                .then(() => message.success('仪器档案已删除'))
            }
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const queued = instruments.filter((row) => row.logisticsState === '排队');
  const inStock = instruments.filter((row) => row.logisticsState !== '排队');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            器材库台账
          </Typography.Title>
          <p className="gb-hint">
            器材库管在库仪器的序列号、入库日期与领用单；要上仪器时按台站码开领用单，库房照单发料。
            同一台仪器不能同时挂在两张没回收的单上；在库仪器有容量上限，排不下的先排队等下一批。
          </p>
        </div>
        <Space wrap>
          <span className="gb-hint">在库容量</span>
          <InputNumber
            min={1}
            max={999}
            value={capacity}
            onChange={(value) => value && dispatch(setCapacityValue(value))}
            style={{ width: 80 }}
          />
          <Button icon={<ReloadOutlined />} onClick={handleProcessQueue}>
            下一批入库
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openStockIn()}>
            仪器入库
          </Button>
        </Space>
      </div>

      {backfillReport && backfillReport.failures.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => dispatch(dismissBackfillReport())}
          message={`升级补单：应补 ${backfillReport.total} 台，成功 ${backfillReport.done} 台，${backfillReport.failures.length} 台补不出来`}
          description={
            <div>
              <p className="gb-hint" style={{ marginBottom: 6 }}>
                旧数据没有领用单，升级时按安装日期补出；以下记录缺台站 / 台站码 / 序列号 / 安装日期，无法补单，请人工核对：
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {backfillReport.failures.map((row, index) => (
                  <li key={index} className="gb-mono" style={{ fontSize: 12 }}>
                    序列号 {row.serialNo} · 台站码 {row.stationCode} · 安装日期 {row.installDate} —— {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          }
        />
      ) : null}

      <div className="gb-stats-row">
        <StatBadge label="在库" value={stats.在库} suffix="台" tone="success" />
        <StatBadge label="排队" value={stats.排队} suffix="台" tone="warning" />
        <StatBadge label="已发料" value={stats.已发料} suffix="张" tone="info" />
        <StatBadge label="已安装" value={stats.已安装} suffix="台" tone="primary" />
        <StatBadge label="待回收" value={stats.待回收} suffix="台" tone="default" />
        <StatBadge label="在库容量" value={`${stats.在库}/${capacity}`} suffix="台" tone="default" />
      </div>

      <Card className="gb-panel" size="small" title="在库仪器">
        {inStock.length === 0 ? (
          <EmptyPanel
            title="器材库还没有仪器"
            description="新购仪器先入库登记序列号与入库日期；在库容量满了会自动排队等下一批。"
            actionText="仪器入库"
            onAction={() => openStockIn()}
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={inStock}
            pagination={false}
            columns={instrumentColumns}
          />
        )}
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title={
          <Space>
            <ClockCircleOutlined />
            排队等下一批（{queued.length} 台）
          </Space>
        }
        extra={
          <Button size="small" onClick={handleProcessQueue}>
            下一批入库
          </Button>
        }
      >
        {queued.length === 0 ? (
          <span className="gb-hint">没有排队仪器。库容有空位时，新入库仪器自动转在库。</span>
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={queued}
            pagination={false}
            columns={[
              { title: '序列号', dataIndex: 'serialNo', width: 240, render: (v: string) => <span className="gb-mono">{v}</span> },
              { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => <Tag>{v}</Tag> },
              { title: '型号', dataIndex: 'model', width: 180 },
              { title: '入库日期', dataIndex: 'stockInDate', width: 140, className: 'gb-mono' },
              {
                title: '状态',
                dataIndex: 'logisticsState',
                width: 100,
                render: () => <Tag color="orange">排队</Tag>,
              },
            ]}
          />
        )}
      </Card>

      <Card className="gb-panel" size="small" title="领用单">
        {requisitions.length === 0 ? (
          <EmptyPanel
            title="还没有领用单"
            description="在「在库仪器」表对在库仪器点「发料」，按台站码开领用单。"
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={[...requisitions].sort((a, b) => b.updatedAt - a.updatedAt)}
            pagination={false}
            columns={requisitionColumns}
          />
        )}
      </Card>

      <Modal
        open={stockInOpen}
        title={editingInstrument ? '编辑仪器档案' : '仪器入库'}
        onCancel={() => setStockInOpen(false)}
        onOk={() => void submitStockIn()}
        confirmLoading={submitting}
        okText={editingInstrument ? '保存修改' : '入库登记'}
        destroyOnClose
      >
        <Form form={stockInForm} layout="vertical" preserve={false}>
          <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
            <Select
              options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
              onChange={(value: InstrumentType) => {
                const models = COMMON_MODELS[value] ?? [];
                stockInForm.setFieldValue('model', models[0] ?? '');
              }}
            />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
            <Input placeholder="如：CMG-3ESPC" maxLength={40} />
          </Form.Item>
          <Form.Item
            name="serialNo"
            label="序列号（全局唯一）"
            rules={[{ required: true, message: '请填写序列号' }]}
          >
            <Input placeholder="如：CMG-3E-20250601-99" maxLength={60} disabled={!!editingInstrument} />
          </Form.Item>
          <Form.Item name="stockInDate" label="入库日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：新购备份仪器" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!issueTarget}
        title={`开领用单 · ${issueTarget?.serialNo ?? ''}`}
        onCancel={() => setIssueTarget(null)}
        onOk={() => void submitIssue()}
        confirmLoading={submitting}
        okText="发料"
        destroyOnClose
      >
        <Form form={issueForm} layout="vertical" preserve={false}>
          <Form.Item name="stationCode" label="台站码" rules={[{ required: true, message: '请选择台站码' }]}>
            <Select
              showSearch
              placeholder="选择要上仪器的台站"
              options={stationCodeOptions}
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="issueDate" label="发料日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：台站建设领用" />
          </Form.Item>
          <p className="gb-hint">
            发料后仪器状态变为「已发料」并挂在本张领用单上；同一台仪器不能同时挂在两张没回收的单上。
          </p>
        </Form>
      </Modal>
    </div>
  );
}
