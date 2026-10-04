# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装、领用与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

> **账分两侧（v3）**：**台网中心**管「台站名册 + 仪器安装位」；**器材库**管「在库仪器（序列号 / 入库日期）+ 领用单」。
> 上仪器时由中心按**台站码**开领用单，库房照单发料，两侧按**台站码 + 序列号**对账。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice`（安装位）/ `warehouseSlice`（器材库）/ `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移（旧数据按安装日期补领用单）+ liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、安装位数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站名册与仪器安装位（台网中心） | Station、Instrument、Requisition | 维护台站与安装位；上仪器按台站码**开领用单**（生成待发料安装位）→ 库房发料后**上站登记**（序列号回流并自动对账）；安装位展示对账结论（一致/挂起/认下） |
| `/warehouse` | 器材库：在库仪器 / 领用单 / 对账 / 升级补单 | StockInstrument、Requisition、UpgradeIssue | 在库仪器序列号与入库日期、**库容容量上限**（放不下的排队 FIFO 等下一批）；按台站码开单、库房照单发料（同一台仪器不能挂两张没回收的单）；按台站码+序列号对账，挂起重试 / 中心认下；升级补单遗留清单 |
| `/calibrations` | 标定记录台 | Calibration、Instrument | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对上次的变化、批量改结论、灵敏度趋势折线图 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument | 按 365 天标定周期评定，超期未标定与不合格仪器高亮；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument（安装位）/ warehouse（器材库）/ calibration / replace / filter
        ├── stores/             # arraySlice / instrumentSlice / warehouseSlice / calibrationSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory
        ├── pages/              # ArrayList / StationInstruments / WarehouseBoard / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（含 /warehouse）
        ├── styles/main.css
        └── utils/              # geo.ts / db.ts（Dexie + v3 迁移补单）/ warehouse.ts（库容/发料/对账引擎）/ export.ts
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（八张，分两个域）**：
  - 台网中心：`arrays`（台阵）、`stations`（台站名册）、`instruments`（**仪器安装位**：序列号可空、挂领用单、带对账结论）；
  - 下游：`calibrations`（标定）、`replaces`（更换）；
  - 器材库：`stockInstruments`（在库仪器：序列号 / 入库日期 / 在库状态 / 排队序号）、`requisitions`（领用单及明细行 / 发料序列号 / 对账结论 / 重试次数）、`upgradeIssues`（升级补单遗留）。
- **升级迁移**：`db.version(1)`、`db.version(2)` 保留历史结构；`db.version(3).stores(...).upgrade(...)` 拆两域并新增器材库三表。**旧数据没有领用单，升级时按安装日期逐台补出「已回收（中心认下）」领用单**；缺台站码、缺序列号或序列号重复而补不出来的安装位写入 `upgradeIssues` 并挂起，在器材库「升级补单」页列出等人工确认。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成互相引用的演示数据（2 个台阵 / 5 个台站 / 11 个安装位（8 历史 + 3 在途）/ 14 条标定 / 3 条更换；器材库在库满容 6 台 + 排队 2 台 + 已出库 3 台，领用单覆盖待发料 / 已发料 / 序列号不符挂起 / 台站码无名册挂起，另有 1 条升级补单遗留）。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到各 Redux slice，页面只读 selector。
- **业务规则（两域对账）**：
  - 开单：中心按**台站码**开领用单（台站码必须在台站名册中），生成「待发料」安装位；
  - 发料：库房照单逐行指定在库仪器序列号；**同一台仪器不能同时挂在两张没回收的单上**；发料后仪器「已出库」，空出的库容由排队队首 FIFO 自动补位；
  - 库容：在库仪器有容量上限（默认 6，可在器材库页调整），排不下的新仪器「排队中」等下一批；
  - 对账：上站登记后按**台站码 + 序列号**与中心安装位比对，一致即回收销账（仪器「已核销」）；**对不上先摆着（对账挂起）等确认，由库房这侧重试（重试计数）；中心认下的不退回**，单据随认下回收并回写安装位「认下」。
  - 标定周期 365 天；响应结论自动初判规则不变；更换状态机为 待更换 → 已更换 → 已复核。
- **备份与恢复**：`/geometry` 页可导出包含八张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，跨域溯源关系解链后以台站码 + 序列号重新对账）」；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
