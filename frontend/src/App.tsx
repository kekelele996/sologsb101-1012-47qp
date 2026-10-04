/**
 * 应用外壳：侧边导航 + 顶部上下文条 + 内容区 + 页脚。
 * 层级路由（/stations/:id/instruments）在导航中回落到父级入口，保证深链页面也能一键跳走。
 */
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Tag, Typography, message } from 'antd';
import {
  AppstoreOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  GlobalOutlined,
  SwapOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  selectArrays,
  selectCurrentArrayId,
  selectStations,
  startArraySubscription,
} from '@/stores/arraySlice';
import {
  selectInstruments,
  startInstrumentSubscription,
} from '@/stores/instrumentSlice';
import {
  selectCalibrations,
  selectReplaces,
  startCalibrationSubscription,
} from '@/stores/calibrationSlice';
import {
  selectRequisitions,
  selectStock,
  selectUpgradeIssues,
  startWarehouseSubscription,
} from '@/stores/warehouseSlice';
import { isOpenRequisition } from '@/types/warehouse';
import { DB_NAME, DB_VERSION, initDatabase } from '@/utils/db';

const { Header, Sider, Content, Footer } = Layout;

/** 按当前路径决定导航高亮项 */
function buildSelectedKey(pathname: string, currentArrayId: string | null): string {
  if (pathname.startsWith('/warehouse')) return ROUTES.warehouse;
  if (pathname.startsWith('/calibrations')) return ROUTES.calibrations;
  if (pathname.startsWith('/replacements')) return ROUTES.replacements;
  if (pathname.startsWith('/geometry')) return ROUTES.geometry;
  if (pathname.startsWith('/stations/') && currentArrayId) return ROUTES.stations(currentArrayId);
  return ROUTES.arrays;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [messageApi, contextHolder] = message.useMessage();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const stock = useAppSelector(selectStock);
  const requisitions = useAppSelector(selectRequisitions);
  const upgradeIssues = useAppSelector(selectUpgradeIssues);
  const currentArrayId = useAppSelector(selectCurrentArrayId);
  const ready = useAppSelector((state) => state.array.ready);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDatabase();
        if (cancelled) return;
        // 打开数据库后启动各表实时订阅，数据自动回流到 Redux
        startArraySubscription(dispatch);
        startInstrumentSubscription(dispatch);
        startCalibrationSubscription(dispatch);
        startWarehouseSubscription(dispatch);
      } catch (error) {
        if (cancelled) return;
        messageApi.error(
          `本地数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, messageApi]);

  const currentArray = arrays.find((row) => row.id === currentArrayId) ?? null;
  const selectedKey = buildSelectedKey(location.pathname, currentArrayId);
  const unqualified = calibrations.filter((row) => row.responseVerdict === '不合格').length;
  const pendingReplaces = replaces.filter((row) => row.state !== '已复核').length;
  const inStock = stock.filter((row) => row.state === '在库').length;
  const queued = stock.filter((row) => row.state === '排队中').length;
  const openReqCount = requisitions.filter((row) => isOpenRequisition(row.state)).length;
  const unresolvedIssues = upgradeIssues.filter((row) => !row.resolved).length;

  return (
    <>
      {contextHolder}
      <Layout style={{ minHeight: '100vh', background: 'var(--gb-paper)' }}>
        <Sider
          width={240}
          breakpoint="lg"
          collapsedWidth={0}
          style={{ background: '#16283f', borderRight: '3px solid #1e3a5f' }}
        >
          <div style={{ padding: '18px 16px 10px' }}>
            <Typography.Title level={5} style={{ color: '#e8f1fb', margin: 0 }}>
              地震台阵仪器标定台账
            </Typography.Title>
            <Typography.Text style={{ color: 'rgba(232,241,251,0.62)', fontSize: 12 }}>
              gbseisarray · 台阵运维班组
            </Typography.Text>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            style={{ background: 'transparent' }}
            onClick={({ key }) => navigate(key)}
            items={[
              { key: ROUTES.arrays, icon: <AppstoreOutlined />, label: '台阵与台站台账' },
              {
                key: currentArrayId ? ROUTES.stations(currentArrayId) : 'stations-disabled',
                icon: <ExperimentOutlined />,
                label: currentArray ? `安装位 · ${currentArray.name}` : '台站安装位（先选台阵）',
                disabled: !currentArrayId,
              },
              { key: ROUTES.warehouse, icon: <DatabaseOutlined />, label: '器材库（在库/领用单/对账）' },
              { key: ROUTES.calibrations, icon: <DashboardOutlined />, label: '标定记录台' },
              { key: ROUTES.replacements, icon: <SwapOutlined />, label: '合格评定与更换' },
              { key: ROUTES.geometry, icon: <GlobalOutlined />, label: '台阵几何与备份' },
            ]}
          />
          <div style={{ padding: '12px 16px', color: 'rgba(232,241,251,0.62)', fontSize: 12 }}>
            <Space direction="vertical" size={2}>
              <span>
                <AppstoreOutlined /> 台阵 {arrays.length} · 台站 {stations.length}
              </span>
              <span>
                <ExperimentOutlined /> 安装位 {instruments.length}
              </span>
              <span>
                <DatabaseOutlined /> 在库 {inStock} · 排队 {queued} · 未回收单 {openReqCount}
              </span>
              <span>
                <ThunderboltOutlined /> 标定 {calibrations.length} · 不合格 {unqualified}
              </span>
              <span>
                <SwapOutlined /> 更换未闭环 {pendingReplaces}
                {unresolvedIssues > 0 ? ` · 补单遗留 ${unresolvedIssues}` : ''}
              </span>
            </Space>
          </div>
        </Sider>

        <Layout style={{ background: 'var(--gb-paper)' }}>
          <Header
            style={{
              background: '#ffffff',
              borderBottom: '1px solid var(--gb-line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingInline: 20,
              gap: 12,
              flexWrap: 'wrap',
              height: 'auto',
              lineHeight: 'normal',
              paddingBlock: 10,
            }}
          >
            <Space size={10} wrap>
              <Typography.Text strong>当前台阵：</Typography.Text>
              {currentArray ? (
                <>
                  <Tag color="#1e3a5f">{currentArray.name}</Tag>
                  <Tag>孔径 {currentArray.apertureKm} km</Tag>
                  <Tag color={currentArray.state === '运行中' ? 'green' : 'orange'}>{currentArray.state}</Tag>
                  <Tag>布设 {currentArray.deployDate}</Tag>
                </>
              ) : (
                <Tag>未选择台阵</Tag>
              )}
            </Space>
            <Space>
              <Badge count={calibrations.length} showZero color="#3f7bbf" title="标定记录总数" />
              <Badge count={unqualified} showZero color="#c0392b" title="不合格标定" />
              <Badge count={pendingReplaces} showZero color="#d68910" title="未闭环更换" />
              {currentArrayId ? (
                <Button size="small" onClick={() => navigate(ROUTES.stations(currentArrayId))}>
                  台站仪器
                </Button>
              ) : null}
              <Button size="small" type="primary" onClick={() => navigate(ROUTES.arrays)}>
                台阵台账
              </Button>
            </Space>
          </Header>

          <Content style={{ padding: 20, minHeight: 360 }}>
            {!ready ? (
              <div className="gb-panel gb-hint">正在打开本地数据库（IndexedDB）并载入数据…</div>
            ) : null}
            <Outlet />
          </Content>

          <Footer style={{ textAlign: 'center', background: 'transparent', color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
            本地库 {DB_NAME} · 结构版本 v{DB_VERSION} · 数据仅存于本机浏览器（IndexedDB），不上传任何服务器 ·
            <Link to={ROUTES.arrays} style={{ marginLeft: 6 }}>
              返回台阵台账
            </Link>
          </Footer>
        </Layout>
      </Layout>
    </>
  );
}
