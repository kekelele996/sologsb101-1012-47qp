/**
 * 器材库：/warehouse
 * 四个页签：
 *  1. 在库仪器——序列号 / 入库日期 / 状态，库容容量上限，排不下的排队等下一批（FIFO 补位）；
 *  2. 领用单——按台站码开的单，库房照单发料，同一台仪器不能同时挂两张没回收的单；
 *  3. 对账——按台站码 + 序列号与中心安装位比对，对不上挂起，库房重试 / 中心认下不退回；
 *  4. 升级补单——旧数据按安装日期补单时补不出来的清单。
 */
import { useMemo, useState } from 'react';
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
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloudServerOutlined,
  PlusOutlined,
  RedoOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectStations } from '@/stores/arraySlice';
import {
  acceptRequisition,
  cancelOpenRequisition,
  changeCapacity,
  createRequisition,
  createStock,
  issueStock,
  promoteNext,
  removeStock,
  resolveIssue,
  runReconcile,
  selectRequisitions,
  selectStock,
  selectStockCapacity,
  selectUpgradeIssues,
} from '@/stores/warehouseSlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  COMMON_MODELS,
  INSTRUMENT_TYPES,
  type InstrumentType,
} from '@/types/instrument';
import {
  REQUISITION_STATES,
  isOpenRequisition,
  type Requisition,
  type StockInstrument,
} from '@/types/warehouse';
import { requisitionStateColor } from '@/utils/warehouse';

interface StockFormValues {
  type: InstrumentType;
  model: string;
  serialNo: string;
  inboundDate: dayjs.Dayjs | null;
  remark: string;
}

const stockStateColor: Record<StockInstrument['state'], string> = {
  在库: 'green',
  排队中: 'orange',
  已出库: 'blue',
  已核销: 'default',
};

/** 对账页签的展示行 */
interface ReconcileViewRow {
  key: string;
  code: string;
  reqId: string;
  stationCode: string;
  stationKnown: boolean;
  issuedSerial: string | null;
  slotSerial: string | null;
  result: Requisition['items'][number]['result'];
  note: string;
  retryCount: number;
  reqState: Requisition['state'];
}

export default function WarehouseBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const stock = useAppSelector(selectStock);
  const requisitions = useAppSelector(selectRequisitions);
  const issues = useAppSelector(selectUpgradeIssues);
  const capacity = useAppSelector(selectStockCapacity);
  const stations = useAppSelector(selectStations);
  const slots = useAppSelector(selectInstruments);

  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [issueReqId, setIssueReqId] = useState<string | null>(null);
  const [ackReqId, setAckReqId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stockForm] = Form.useForm<StockFormValues>();
  const [orderForm] = Form.useForm();
  const [issueForm] = Form.useForm();
  const [ackForm] = Form.useForm();

  const used = useMemo(() => stock.filter((row) => row.state === '在库').length, [stock]);
  const queueCount = stock.filter((row) => row.state === '排队中').length;
  const issuedCount = stock.filter((row) => row.state === '已出库').length;
  const openReqs = requisitions.filter((row) => isOpenRequisition(row.state));
  const suspendedReqs = requisitions.filter((row) => row.state === '对账挂起');
  const unresolvedIssues = issues.filter((row) => !row.resolved);

  const stationCodeById = useMemo(
    () => new Map(stations.map((station) => [station.id, station.code])),
    [stations]
  );

  const openStockCreate = () => {
    stockForm.setFieldsValue({
      type: '宽频带',
      model: COMMON_MODELS['宽频带'][0] ?? '',
      serialNo: '',
      inboundDate: dayjs(),
      remark: '',
    });
    setStockModalOpen(true);
  };

  const submitStock = async () => {
    const values = await stockForm.validateFields();
    setSubmitting(true);
    try {
      const result = await dispatch(
        createStock({
          type: values.type,
          model: values.model.trim(),
          serialNo: values.serialNo.trim(),
          inboundDate: values.inboundDate ? values.inboundDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success(result.enqueued ? `库容已满（${capacity} 台），已排队等下一批` : '仪器已入库');
      setStockModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '入库失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openOrderCreate = () => {
    orderForm.resetFields();
    orderForm.setFieldsValue({
      stationCode: stations[0]?.code,
      applicant: '',
      purpose: '',
      items: [{ type: '宽频带', model: COMMON_MODELS['宽频带'][0] ?? '', qty: 1 }],
    });
    setOrderModalOpen(true);
  };

  const submitOrder = async () => {
    const values = await orderForm.validateFields();
    setSubmitting(true);
    try {
      const req = await dispatch(
        createRequisition({
          draft: {
            stationCode: String(values.stationCode ?? '').trim(),
            applicant: String(values.applicant ?? '').trim(),
            purpose: String(values.purpose ?? '').trim(),
            items: (values.items ?? []).map((item: { type: InstrumentType; model: string; qty: number }) => ({
              type: item.type,
              model: String(item.model ?? '').trim(),
              qty: Number(item.qty ?? 1),
            })),
          },
          stations,
        })
      ).unwrap();
      message.success(`领用单 ${req.code} 已开出（台站 ${req.stationCode}），待库房发料`);
      setOrderModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '开单失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openIssue = (req: Requisition) => {
    setIssueReqId(req.id);
    const first = req.items[0];
    issueForm.setFieldsValue({
      assignments: req.items.map((item) => ({
        lineNo: item.lineNo,
        serialNo: item.serialNo ?? '',
      })),
      modelHint: first ? `${first.type} / ${first.model}` : '',
    });
  };

  const submitIssue = async () => {
    if (!issueReqId) return;
    const values = await issueForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        issueStock({
          reqId: issueReqId,
          assignments: (values.assignments ?? []).map(
            (row: { lineNo: number; serialNo: string }) => ({
              lineNo: row.lineNo,
              serialNo: String(row.serialNo ?? '').trim(),
            })
          ),
        })
      ).unwrap();
      message.success('库房已照单发料，等待上站安装后对账');
      setIssueReqId(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '发料失败');
    } finally {
      setSubmitting(false);
    }
  };

  const runReconcileNow = async () => {
    const result = await dispatch(runReconcile()).unwrap();
    if (result.suspended === 0) message.success(`对账完成，本次回收 ${result.recovered} 张单`);
    else message.warning(`回收 ${result.recovered} 张，仍有 ${result.suspended} 张挂起等确认`);
  };

  const submitAck = async () => {
    if (!ackReqId) return;
    const values = await ackForm.validateFields();
    setSubmitting(true);
    try {
      const req = await dispatch(
        acceptRequisition({ reqId: ackReqId, note: String(values.note ?? '').trim() })
      ).unwrap();
      message.success(`领用单 ${req.code} 已认下，不退回，单据回收销账`);
      setAckReqId(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '认下失败');
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------ 页签 1：在库仪器 ------------------------------ */

  const stockTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" className="gb-panel">
        <Row gutter={16} align="middle">
          <Col flex="none">
            <CloudServerOutlined style={{ fontSize: 28, color: '#1e3a5f' }} />
          </Col>
          <Col flex="auto">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Typography.Text strong>
                在库容量 {used} / {capacity} 台
              </Typography.Text>
              <Progress
                percent={capacity === 0 ? 0 : Math.min(100, Math.round((used / capacity) * 100))}
                size="small"
                style={{ width: 220, margin: 0 }}
                status={used >= capacity ? 'exception' : 'active'}
              />
              <InputNumber
                min={0}
                max={999}
                value={capacity}
                style={{ width: 110 }}
                onChange={(value) => {
                  if (value !== null) void dispatch(changeCapacity(Number(value)));
                }}
                addonAfter="台"
              />
              <Typography.Text type="secondary" className="gb-hint">
                容量上限（放不下的新仪器自动排队，空位后按 FIFO 补位）
              </Typography.Text>
            </div>
          </Col>
          <Col flex="none">
            <Space>
              <Tooltip title="空出位置时把队首仪器补进在库">
                <Button icon={<ThunderboltOutlined />} disabled={queueCount === 0 || used >= capacity}
                  onClick={() =>
                    void dispatch(promoteNext())
                      .unwrap()
                      .then((row) =>
                        row ? message.success(`队首 ${row.serialNo} 已补入在库`) : message.info('暂不能补位')
                      )
                  }
                >
                  队首补位
                </Button>
              </Tooltip>
              <Button type="primary" icon={<PlusOutlined />} onClick={openStockCreate}>
                仪器入库
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <div className="gb-stats-row">
        <StatBadge label="在库" value={used} suffix="台" tone="primary" />
        <StatBadge label="排队等下一批" value={queueCount} suffix="台" tone={queueCount > 0 ? 'warning' : 'success'} />
        <StatBadge label="已出库未回收" value={issuedCount} suffix="台" tone="info" />
        <StatBadge label="未回收领用单" value={openReqs.length} suffix="张" tone={openReqs.length > 0 ? 'warning' : 'success'} />
        <StatBadge label="对账挂起" value={suspendedReqs.length} suffix="张" tone={suspendedReqs.length > 0 ? 'danger' : 'success'} />
      </div>

      <Table
        rowKey="id"
        size="small"
        className="gb-table-compact"
        dataSource={[...stock].sort((a, b) => {
          const order = { 排队中: 0, 在库: 1, 已出库: 2, 已核销: 3 };
          if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
          return (a.queueNo ?? 0) - (b.queueNo ?? 0) || b.inboundDate.localeCompare(a.inboundDate);
        })}
        pagination={false}
        columns={[
          { title: '类型', dataIndex: 'type', width: 90, render: (value: string) => <Tag>{value}</Tag> },
          { title: '型号', dataIndex: 'model', width: 150 },
          {
            title: '序列号',
            dataIndex: 'serialNo',
            width: 200,
            render: (value: string) => <span className="gb-mono">{value}</span>,
          },
          { title: '入库日期', dataIndex: 'inboundDate', width: 120, className: 'gb-mono' },
          {
            title: '状态',
            dataIndex: 'state',
            width: 120,
            render: (value: StockInstrument['state'], row) => (
              <Space size={4}>
                <Tag color={stockStateColor[value]}>{value}</Tag>
                {value === '排队中' && row.queueNo !== null ? <Tag>第 {row.queueNo} 位</Tag> : null}
              </Space>
            ),
          },
          {
            title: '挂载单据',
            width: 180,
            render: (_: unknown, row: StockInstrument) => {
              if (!row.requisitionId) return <span className="gb-hint">—</span>;
              const req = requisitions.find((item) => item.id === row.requisitionId);
              return <span className="gb-mono">{req?.code ?? row.requisitionId}</span>;
            },
          },
          { title: '备注', dataIndex: 'remark', ellipsis: true },
          {
            title: '操作',
            width: 90,
            render: (_: unknown, row: StockInstrument) => (
              <Popconfirm
                title="删除在库仪器"
                description="已出库 / 已核销仪器不能删除。确认删除该仪器记录？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                disabled={row.state === '已出库' || row.state === '已核销'}
                onConfirm={() =>
                  void dispatch(removeStock(row.id))
                    .unwrap()
                    .then(() => message.success('已删除'))
                    .catch((error: unknown) => message.error(typeof error === 'string' ? error : '删除失败'))
                }
              >
                <Button size="small" danger disabled={row.state === '已出库' || row.state === '已核销'}>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  );

  /* ------------------------------ 页签 2：领用单 ------------------------------ */

  const reqTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          上仪器时由台网中心按台站码开单；库房照单发料，同一台仪器不能同时挂在两张没回收的单上。
        </Typography.Paragraph>
        <Button type="primary" icon={<PlusOutlined />} onClick={openOrderCreate}>
          按台站码开领用单
        </Button>
      </div>
      <Table
        rowKey="id"
        size="small"
        className="gb-table-compact"
        dataSource={[...requisitions].sort((a, b) => b.createdAt - a.createdAt)}
        pagination={false}
        expandable={{
          expandedRowRender: (req) => (
            <Table
              rowKey="lineNo"
              size="small"
              pagination={false}
              dataSource={req.items}
              columns={[
                { title: '行', dataIndex: 'lineNo', width: 60 },
                { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => <Tag>{v}</Tag> },
                { title: '型号', dataIndex: 'model', width: 160 },
                { title: '数量', dataIndex: 'qty', width: 70 },
                {
                  title: '发料序列号',
                  dataIndex: 'serialNo',
                  width: 200,
                  render: (v: string | null) =>
                    v ? <span className="gb-mono">{v}</span> : <Tag color="orange">待发料</Tag>,
                },
                {
                  title: '对账',
                  dataIndex: 'result',
                  width: 100,
                  render: (v: Requisition['items'][number]['result']) =>
                    v ? (
                      <Tag color={v === '一致' ? 'green' : v === '认下' ? 'purple' : 'red'}>{v}</Tag>
                    ) : (
                      <span className="gb-hint">未对账</span>
                    ),
                },
                { title: '备注', dataIndex: 'note', ellipsis: true },
              ]}
            />
          ),
        }}
        columns={[
          { title: '领用单号', dataIndex: 'code', width: 180, render: (v: string) => <span className="gb-mono">{v}</span> },
          {
            title: '台站码',
            dataIndex: 'stationCode',
            width: 100,
            render: (v: string) => {
              const known = stations.some((station) => station.code.toUpperCase() === v.toUpperCase());
              return (
                <Space size={4}>
                  <span className="gb-mono">{v}</span>
                  {known ? null : <Tooltip title="台站码不在中心名册中"><Tag color="red">无名册</Tag></Tooltip>}
                </Space>
              );
            },
          },
          { title: '领用人', dataIndex: 'applicant', width: 100 },
          { title: '开单日期', dataIndex: 'orderDate', width: 110, className: 'gb-mono' },
          { title: '发料日期', dataIndex: 'issuedAt', width: 110, render: (v: string | null) => v ?? '—', className: 'gb-mono' },
          {
            title: '状态',
            dataIndex: 'state',
            width: 110,
            render: (v: Requisition['state']) => <Tag color={requisitionStateColor(v)}>{v}</Tag>,
          },
          { title: '事由', dataIndex: 'purpose', ellipsis: true },
          {
            title: '操作',
            width: 200,
            render: (_: unknown, req: Requisition) => (
              <Space size={6}>
                {req.state === '待发料' ? (
                  <>
                    <Button size="small" type="primary" onClick={() => openIssue(req)}>
                      照单发料
                    </Button>
                    <Popconfirm
                      title="取消领用单"
                      description="仅待发料单可取消，取消后不占用仪器。"
                      okText="取消单据"
                      cancelText="返回"
                      onConfirm={() =>
                        void dispatch(cancelOpenRequisition(req.id))
                          .unwrap()
                          .then(() => message.success('领用单已取消'))
                      }
                    >
                      <Button size="small">取消</Button>
                    </Popconfirm>
                  </>
                ) : null}
                {req.state === '对账挂起' ? (
                  <Button size="small" type="primary" ghost icon={<CheckCircleOutlined />} onClick={() => {
                    ackForm.setFieldsValue({ note: '' });
                    setAckReqId(req.id);
                  }}>
                    中心认下
                  </Button>
                ) : null}
                {req.backfilled ? <Tag color="purple">升级补单</Tag> : null}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );

  /* ------------------------------ 页签 3：对账 ------------------------------ */

  const reconcileRows = useMemo<ReconcileViewRow[]>(() => {
    return openReqs
      .filter((req) => req.state === '已发料' || req.state === '对账挂起')
      .map((req) => {
        const station = stations.find((item) => item.code.toUpperCase() === req.stationCode.toUpperCase());
        return req.items.map((item): ReconcileViewRow => {
          const slot = slots.find((candidate) => {
            const code = stationCodeById.get(candidate.stationId) ?? '';
            if (code.toUpperCase() !== req.stationCode.toUpperCase()) return false;
            return (
              (candidate.requisitionId === req.id && candidate.serialNo) ||
              candidate.serialNo === item.serialNo
            );
          });
          return {
            key: `${req.id}-${item.lineNo}`,
            code: req.code,
            reqId: req.id,
            stationCode: req.stationCode,
            stationKnown: !!station,
            issuedSerial: item.serialNo,
            slotSerial: slot?.serialNo ?? null,
            result: item.result,
            note: item.note,
            retryCount: req.retryCount,
            reqState: req.state,
          };
        });
      })
      .flat();
  }, [openReqs, stations, slots, stationCodeById]);

  const reconcileTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="对账规则"
        description="两侧按台站码 + 序列号比对：对上即回收销账；对不上先摆着（对账挂起）等确认，由库房这侧重试；中心认下的不退回，单据随认下回收。"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Tag color="red">挂起 {suspendedReqs.length} 张</Tag>
          <Tag color="blue">已发料待装 {requisitions.filter((r) => r.state === '已发料').length} 张</Tag>
        </Space>
        <Button type="primary" icon={<RedoOutlined />} onClick={() => void runReconcileNow()}>
          库房重试对账
        </Button>
      </div>
      {reconcileRows.length === 0 ? (
        <EmptyPanel
          title="没有待对账的领用单"
          description="已发料的单据在上站安装后会自动对账；也可以随时点「库房重试对账」重跑。"
          compact
        />
      ) : (
        <Table
          size="small"
          className="gb-table-compact"
          dataSource={reconcileRows}
          pagination={false}
          columns={[
            { title: '领用单号', dataIndex: 'code', width: 180, render: (v: string) => <span className="gb-mono">{v}</span> },
            {
              title: '台站码',
              dataIndex: 'stationCode',
              width: 100,
              render: (v: string, row: ReconcileViewRow) =>
                row.stationKnown ? <span className="gb-mono">{v}</span> : <Tag color="red">{v} 无名册</Tag>,
            },
            { title: '库房发料序列号', dataIndex: 'issuedSerial', width: 200, render: (v: string | null) => v ?? '—', className: 'gb-mono' },
            {
              title: '中心安装位序列号',
              dataIndex: 'slotSerial',
              width: 200,
              render: (v: string | null) =>
                v ? <span className="gb-mono">{v}</span> : <Tag color="orange">未上站 / 缺序列号</Tag>,
            },
            {
              title: '结论',
              dataIndex: 'result',
              width: 90,
              render: (v: string | null) =>
                v ? (
                  <Tag color={v === '一致' ? 'green' : v === '认下' ? 'purple' : 'red'}>{v}</Tag>
                ) : (
                  <span className="gb-hint">待对账</span>
                ),
            },
            {
              title: '库房重试',
              dataIndex: 'retryCount',
              width: 90,
              align: 'center',
              render: (v: number) => <span className="gb-mono">{v} 次</span>,
            },
            { title: '说明', dataIndex: 'note', ellipsis: true },
            {
              title: '操作',
              width: 120,
              render: (_: unknown, row: ReconcileViewRow) =>
                row.reqState === '对账挂起' && row.result !== '认下' ? (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    onClick={() => {
                      ackForm.setFieldsValue({ note: '' });
                      setAckReqId(row.reqId);
                    }}
                  >
                    中心认下
                  </Button>
                ) : (
                  <span className="gb-hint">—</span>
                ),
            },
          ]}
        />
      )}
    </Space>
  );

  /* ------------------------------ 页签 4：升级补单问题 ------------------------------ */

  const issueTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message="旧数据升级补单"
        description="旧数据没有领用单，升级时按安装日期补出；缺台站码、缺序列号或序列号重复而补不出来的安装位列在这里，等人工确认。"
      />
      {issues.length === 0 ? (
        <EmptyPanel title="没有补单遗留问题" description="所有历史安装位都已按安装日期补出领用单。" compact />
      ) : (
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={[...issues].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.createdAt - a.createdAt)}
          pagination={false}
          columns={[
            {
              title: '问题类型',
              dataIndex: 'kind',
              width: 120,
              render: (v: string, row) => (
                <Tag color={row.resolved ? 'default' : v === '缺台站码' ? 'red' : 'orange'}>{v}</Tag>
              ),
            },
            { title: '台站码', dataIndex: 'stationCode', width: 100, render: (v: string) => v || <Tag>缺失</Tag>, className: 'gb-mono' },
            { title: '序列号', dataIndex: 'serialNo', width: 200, render: (v: string) => v || <Tag>缺失</Tag>, className: 'gb-mono' },
            { title: '安装日期', dataIndex: 'installDate', width: 120, className: 'gb-mono' },
            { title: '说明', dataIndex: 'detail', ellipsis: true },
            {
              title: '状态',
              dataIndex: 'resolved',
              width: 90,
              render: (v: boolean) => (v ? <Tag color="green">已确认</Tag> : <Tag color="orange">待确认</Tag>),
            },
            {
              title: '操作',
              width: 110,
              render: (_: unknown, row) =>
                row.resolved ? (
                  <span className="gb-hint">—</span>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    onClick={() =>
                      void dispatch(resolveIssue(row.id))
                        .unwrap()
                        .then(() => message.success('已标记为人工确认'))
                    }
                  >
                    确认已处理
                  </Button>
                ),
            },
          ]}
        />
      )}
    </Space>
  );

  const issueReq = issueReqId ? requisitions.find((req) => req.id === issueReqId) ?? null : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />
      <div>
        <Typography.Title level={4} style={{ margin: '4px 0', color: '#1e3a5f' }}>
          器材库 · 在库仪器与领用单
        </Typography.Title>
        <p className="gb-hint">
          器材库管在库仪器的序列号、入库日期与领用单；台网中心管台站名册与安装位。两本账按台站码与序列号对账。
        </p>
      </div>

      {unresolvedIssues.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${unresolvedIssues.length} 条旧数据在升级补单时补不出来，已列出等确认`}
        />
      ) : null}

      <Card className="gb-panel" styles={{ body: { padding: 12 } }}>
        <Tabs
          defaultActiveKey="stock"
          items={[
            { key: 'stock', label: `在库仪器（${stock.length}）`, children: stockTab },
            { key: 'requisitions', label: `领用单（${requisitions.length}）`, children: reqTab },
            { key: 'reconcile', label: `对账${suspendedReqs.length > 0 ? `（挂起 ${suspendedReqs.length}）` : ''}`, children: reconcileTab },
            { key: 'issues', label: `升级补单${unresolvedIssues.length > 0 ? `（${unresolvedIssues.length}）` : ''}`, children: issueTab },
          ]}
        />
      </Card>

      {/* 仪器入库 */}
      <Modal
        open={stockModalOpen}
        title="仪器入库"
        onCancel={() => setStockModalOpen(false)}
        onOk={() => void submitStock()}
        confirmLoading={submitting}
        okText="入库"
        destroyOnClose
      >
        <Form form={stockForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="type" label="仪器类型" rules={[{ required: true }]}>
                <Select
                  options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
                  onChange={(value: InstrumentType) =>
                    stockForm.setFieldValue('model', COMMON_MODELS[value]?.[0] ?? '')
                  }
                />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
                <Input placeholder="如：CMG-3ESPC" maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="serialNo" label="序列号（在库仪器唯一）" rules={[{ required: true, message: '请填写序列号' }]}>
            <Input placeholder="如：CMG-3E-20250925-50" maxLength={60} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="inboundDate" label="入库日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：到货时库容已满将自动排队" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 按台站码开领用单（库房侧也可代开；台站码必须在名册中） */}
      <Modal
        open={orderModalOpen}
        title="按台站码开领用单"
        onCancel={() => setOrderModalOpen(false)}
        onOk={() => void submitOrder()}
        confirmLoading={submitting}
        okText="开单"
        width={640}
        destroyOnClose
      >
        <Form form={orderForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="stationCode" label="台站码（取台站名册）" rules={[{ required: true, message: '请选择台站码' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={stations.map((station) => ({
                    label: `${station.code}`,
                    value: station.code,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="applicant" label="领用人" rules={[{ required: true, message: '请填写领用人' }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="purpose" label="用途说明">
                <Input maxLength={40} placeholder="如：台阵扩容" />
              </Form.Item>
            </Col>
          </Row>
          <Typography.Text type="secondary" className="gb-hint">
            明细（开单时只填型号与数量，具体序列号由库房照单发料时确定）
          </Typography.Text>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Row gutter={8} key={field.key} align="middle" style={{ marginTop: 8 }}>
                    <Col span={8}>
                      <Form.Item name={[field.name, 'type']} rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                        <Select
                          options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))}
                          onChange={(value: InstrumentType) =>
                            orderForm.setFieldValue(['items', field.name, 'model'], COMMON_MODELS[value]?.[0] ?? '')
                          }
                        />
                      </Form.Item>
                    </Col>
                    <Col span={9}>
                      <Form.Item name={[field.name, 'model']} rules={[{ required: true, message: '型号' }]} style={{ marginBottom: 8 }}>
                        <Input placeholder="型号" maxLength={40} />
                      </Form.Item>
                    </Col>
                    <Col span={4}>
                      <Form.Item name={[field.name, 'qty']} rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                        <InputNumber min={1} max={9} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col span={3}>
                      <Button danger size="small" onClick={() => remove(field.name)}>
                        删行
                      </Button>
                    </Col>
                  </Row>
                ))}
                <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => add({ type: '宽频带', model: COMMON_MODELS['宽频带'][0] ?? '', qty: 1 })}>
                  加一行
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      {/* 库房照单发料：逐行指定在库仪器序列号 */}
      <Modal
        open={issueReqId !== null}
        title={`照单发料 · ${issueReq?.code ?? ''}（台站 ${issueReq?.stationCode ?? ''}）`}
        onCancel={() => setIssueReqId(null)}
        onOk={() => void submitIssue()}
        confirmLoading={submitting}
        okText="确认发料"
        destroyOnClose
      >
        <Form form={issueForm} layout="vertical" preserve={false}>
          <Form.List name="assignments">
            {(fields) => (
              <>
                {fields.map((field, index) => {
                  const lineNo = issueReq?.items[index]?.lineNo ?? index + 1;
                  const type = issueReq?.items[index]?.type ?? '宽频带';
                  const model = issueReq?.items[index]?.model ?? '';
                  return (
                    <Row gutter={8} key={field.key} align="middle">
                      <Col span={10} style={{ paddingBottom: 24 }}>
                        <Tag>{type}</Tag>
                        <span>{model}</span>
                        <div className="gb-hint">第 {lineNo} 行</div>
                      </Col>
                      <Col span={14}>
                        <Form.Item
                          name={[field.name, 'serialNo']}
                          rules={[{ required: true, message: '请选择在库仪器序列号' }]}
                        >
                          <Select
                            showSearch
                            optionFilterProp="label"
                            placeholder="选择在库仪器（序列号）"
                            options={stock
                              .filter((row) => row.state === '在库' && row.type === type && row.model === model)
                              .map((row) => ({ label: row.serialNo, value: row.serialNo }))}
                            notFoundContent="该型号在库无可用仪器"
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  );
                })}
              </>
            )}
          </Form.List>
          <Alert
            type="info"
            showIcon
            message="同一台仪器不能同时挂在两张没回收的领用单上；发料后仪器状态变为「已出库」，空出的库容由排队队首 FIFO 补位。"
          />
        </Form>
      </Modal>

      {/* 中心认下 */}
      <Modal
        open={ackReqId !== null}
        title="中心认下（不退回）"
        onCancel={() => setAckReqId(null)}
        onOk={() => void submitAck()}
        confirmLoading={submitting}
        okText="确认认下并回收单据"
        destroyOnClose
      >
        <Form form={ackForm} layout="vertical" preserve={false}>
          <p className="gb-hint">
            对不上先摆着等确认；中心核实后认下现状，仪器不退回，领用单直接回收销账。
          </p>
          <Form.Item name="note" label="认下说明">
            <Input.TextArea rows={3} maxLength={120} placeholder="如：外业实物核对无误，以中心安装位为准" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
