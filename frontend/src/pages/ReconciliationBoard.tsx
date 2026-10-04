/**
 * 对账台：台网中心安装位与器材库领用单按（台站码 + 序列号）对账。
 * 对不上先摆着等确认；对账失败后库房这侧重试；中心认下的不退回。
 * 复用 <StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CheckCircleOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  acknowledgeReconciliation,
  retryReconciliation,
  runReconciliation,
  selectReconciliations,
  selectReconciling,
  selectWarehouseError,
} from '@/stores/warehouseSlice';
import { summarizeReconciliation, type ReconciliationRecord } from '@/types/reconciliation';

const RESULT_COLOR: Record<ReconciliationRecord['result'], string> = {
  平账: 'blue',
  待确认: 'orange',
  已确认: 'green',
};

const SIDE_TEXT: Record<ReconciliationRecord['side'], string> = {
  两边一致: '两边一致',
  中心有位无单: '中心有位无单',
  库房有单无位: '库房有单无位',
};

export default function ReconciliationBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const records = useAppSelector(selectReconciliations);
  const reconciling = useAppSelector(selectReconciling);
  const error = useAppSelector(selectWarehouseError);

  const summary = useMemo(() => summarizeReconciliation(records), [records]);

  useEffect(() => {
    if (records.length === 0 && !reconciling) {
      void dispatch(runReconciliation());
    }
    // 挂载时自动对账一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAcknowledge = async (record: ReconciliationRecord) => {
    try {
      await dispatch(acknowledgeReconciliation(record.id)).unwrap();
      message.success(`已认下：${record.stationCode} / ${record.serialNo}，不退回`);
    } catch (err) {
      message.error(typeof err === 'string' ? err : '认下失败');
    }
  };

  const columns = [
    { title: '台站码', dataIndex: 'stationCode', width: 110, render: (v: string) => <span className="gb-mono">{v}</span> },
    { title: '序列号', dataIndex: 'serialNo', width: 220, render: (v: string) => <span className="gb-mono">{v}</span> },
    {
      title: '中心安装日期',
      dataIndex: 'centerInstallDate',
      width: 130,
      className: 'gb-mono',
      render: (v: string | null) => v ?? <span className="gb-hint">无安装位</span>,
    },
    {
      title: '库房领用单号',
      dataIndex: 'warehouseRequisitionNo',
      width: 200,
      render: (v: string | null) => (v ? <span className="gb-mono">{v}</span> : <span className="gb-hint">无领用单</span>),
    },
    {
      title: '发料日期',
      dataIndex: 'warehouseIssueDate',
      width: 130,
      className: 'gb-mono',
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '差异方向',
      dataIndex: 'side',
      width: 130,
      render: (side: ReconciliationRecord['side']) => {
        const color = side === '两边一致' ? 'green' : side === '中心有位无单' ? 'orange' : 'volcano';
        return <Tag color={color}>{SIDE_TEXT[side]}</Tag>;
      },
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 100,
      render: (result: ReconciliationRecord['result']) => <Tag color={RESULT_COLOR[result]}>{result}</Tag>,
    },
    {
      title: '重试次数',
      dataIndex: 'failCount',
      width: 90,
      align: 'right' as const,
      className: 'gb-mono',
      render: (v: number) => (v > 0 ? <span className="gb-danger">{v}</span> : <span className="gb-hint">0</span>),
    },
    {
      title: '最近尝试',
      dataIndex: 'lastAttemptAt',
      width: 170,
      render: (v: number) => (v ? new Date(v).toLocaleString('zh-CN') : '—'),
    },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, record: ReconciliationRecord) =>
        record.result === '已确认' ? (
          <Tag color="green" icon={<CheckCircleOutlined />}>
            已认下
          </Tag>
        ) : (
          <Button
            size="small"
            type="primary"
            icon={<SafetyCertificateOutlined />}
            onClick={() => handleAcknowledge(record)}
          >
            中心认下
          </Button>
        ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            对账台
          </Typography.Title>
          <p className="gb-hint">
            台网中心安装位与器材库领用单按台站码 + 序列号对账；对不上先摆着等确认，对账失败后库房这侧重试，
            中心认下的不退回。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={reconciling}
            onClick={() =>
              dispatch(runReconciliation())
                .unwrap()
                .then(() => message.success('对账完成'))
            }
          >
            重新对账
          </Button>
          {error ? (
            <Button
              type="primary"
              danger
              icon={<ReloadOutlined />}
              onClick={() =>
                dispatch(retryReconciliation())
                  .unwrap()
                  .then(() => message.success('重试成功'))
              }
            >
              库房重试
            </Button>
          ) : null}
        </Space>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          message="对账失败"
          description={
            <Space direction="vertical" size={4}>
              <span>{error}</span>
              <span className="gb-hint">库房侧将重试，已生成的对账记录保留；点击「库房重试」重新发起对账。</span>
            </Space>
          }
        />
      ) : null}

      <div className="gb-stats-row">
        <StatBadge label="对账记录" value={summary.total} suffix="条" tone="default" />
        <StatBadge label="平账" value={summary.matched} suffix="条" tone="info" />
        <StatBadge label="待确认" value={summary.pending} suffix="条" tone="warning" />
        <StatBadge label="已认下" value={summary.acknowledged} suffix="条" tone="success" />
        <StatBadge label="失败" value={summary.failed} suffix="条" tone={summary.failed > 0 ? 'danger' : 'success'} />
      </div>

      <Card className="gb-panel" size="small" title="对账明细">
        {records.length === 0 ? (
          <EmptyPanel
            title={reconciling ? '正在对账…' : '还没有对账记录'}
            description="点击「重新对账」，按台站码 + 序列号勾稽安装位与领用单。"
            actionText="开始对账"
            onAction={() => dispatch(runReconciliation())}
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={records}
            pagination={false}
            columns={columns}
          />
        )}
      </Card>

      <p className="gb-hint">
        说明：平账表示两边台账一致（中心有在装安装位、库房有同站同序列号的已发料单）；待确认表示对不上，
        先摆着等中心核对；中心认下后该差异不退回（库房不要求拆回 / 中心补登安装位）。
      </p>
    </div>
  );
}
