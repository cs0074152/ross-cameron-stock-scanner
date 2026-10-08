# AGENTS.md — 双市场股票扫描器交接

用户请求优先于本文件。项目是本机美股 / 沪深京 A 股行情观察、策略提示和模拟持仓记账工具，界面全中文，不连接券商、不执行交易。

## 环境与文件

- Node.js >=22.12.0（建议 Node 24），npm；后端 CommonJS / Express / ws / cheerio；前端 React 18 / Vite 8，JS/JSX。
- `backend/server.js` 协调刷新、REST 与 WS；源适配在 `market-us.js` / `market-cn.js`；日历在 `market-calendar.js` / `market-calendars.json`。
- `backend/safe-fetch.js` 统一出站保护；`scanner-filters.js` 纯筛选；`strategy.js` 快照策略；`positions.js` 原子本机 JSON 持仓与幂等收据。
- `frontend/src/App.jsx` 界面；`scanner-state.js` 日期 / 对账 / 镜像 / 盈亏 / 价格历史；`App.css` 深浅主题。
- `scripts/launch.cjs` 公共启动器，`start.bat` / `start.sh` 仅定位项目根并调用。仅管理自产子进程，不能全局 pkill / taskkill 同名进程。
- 桌面入口由 `frontend-build.cjs` 按输入内容/锁文件/环境计算指纹，校验全部构建产物后复用；`serve-ui.cjs` 只服务预读的生产构建、回环绑定、gzip/ETag/哈希资源缓存，HTML/身份不缓存。API/WS运行地址以 HTML 中的 `__SCANNER_CONFIG__` 注入。开发服务仍单独用 npm run dev。
- 后端默认 127.0.0.1:3001，前端默认 http://localhost:5173。占用时启动器选择空闲回环端口，并同步 PORT / VITE_API_BASE / VITE_WS_BASE / ALLOWED_ORIGIN；实际地址记在忽略入库的 .runtime/launcher.json。重复点击核对两端 launchId 和存活进程后复用；启动锁须原子发布，不能误开无关服务。Vite保持回环，不加 host:true。启动器读取后端 .env 并同步。

## 安全边界

1. 所有服务端行情请求必须经注入的 `safeFetch()`。白名单为 stockanalysis.com、query1.finance.yahoo.com、fc.yahoo.com、push2.eastmoney.com；新增源必须先登记。每跳重定向都校验协议 / 域名 / 非标准端口 / 凭据 / 保留地址，跨来源清除 cookie 和授权头。默认 8 秒期限包含响应 body，轮次 12 秒，合并调用方取消信号。
2. 服务仅允许回环 HOST，勿绑定 0.0.0.0 或公网。Vite不要 host:true；保留 strictPort。
3. 保留 Origin 白名单、同步 CORS、simple query parser、类别 / 市场白名单、WebSocket maxPayload=1MiB及error处理。
4. 本工具无多用户认证概念，仅本机用。持仓存储 / .env / 日志 / node_modules / dist 被Git忽略，不提交私人持仓。
5. 改依赖后跑双包 npm audit；不要把审计0漏洞当作业务正确性证明。

## 数据与策略约束

- 榜单三类各最多200，只是样本；来源可能少于200。筛选与“榜单样本”标签必须诚实，不称全市场广度。
- Yahoo预设榜单只有总股本时用保守回退；真实float cookie+crumb补全缓存6小时，每轮最多5只，补全受2.5秒预算约束。401只刷新凭证重试一次。
- StockAnalysis盘前 / 盘后分开路径；盘后没有可靠活跃榜则空，不抓盘前冒充。缺少精确quoteTime只展示参考；不伪造量比、float、跳空或volume。盘后quote不得配常规成交量做弱量信号。
- 东方财富榜单clist/get；独立报价采用已实测的ulist.np/get。成交量f5以手转股，流通股数f21/price为估算；代码保存前导零，北交所不伪造TradingView支持。
- 源quoteTime与fetch成功时间分开。源失败保留每类别旧缓存 / 时间并提示，合并择最新有效报价。缺报价或活动时段超过3分钟标stale，不推进updatedAt、不产生新监控判断或模拟平仓盈亏。
- 策略价格样本不是K线；累计dayHigh与sample price分开。真实15分钟窗、跨交易日清理、重复源时间戳去重。四状态rally/pullback/based/trigger需可达；US阈值保持回调>=1%、>=2tick、3tick振幅<=0.8%、盈亏比>=2。
- 美股三步法选股与5条停工规则来自用户策略文档，勿擅改语义。黄金时段仍用服务端ET分钟 / 星期。
- A股独立阈值与观察模式，不复制美元 / 美股日内规则。标板块、ST、新股信息未知、常规涨跌幅估算；ST规则必须依据当前交易所公告，不硬编码旧5%。T+1用最后买入日期及实际交易日，不以第二自然日放行，增持保守重新锁整笔模拟持仓。
- 盘口大卖单 / 主笔成交无法由快照推导，保持人工盯盘说明。
- 日历JSON当前US2026–2028、CN2026并附官方来源；未知年session=unknown，不能用工作日假冒已核实日历。

## 持仓与前端约定

- `backend/data/positions.json`（或STATE_FILE）原子写入；保留entryTime/lastBuyDate/peak/price/quoteTime/平仓receipt。损坏明显失败，不静默清仓。
- 服务端持仓为权威；每次WS连接GET对账后接受快照。migrationNeeded只在市场从未初始化时true，空仓也有权威状态，不能用旧浏览器镜像复活。
- 以instanceId+positionsRevision拒绝旧进程 / 旧快照；每股票同步pending锁；ack成功后更新。operationId贯穿DELETE重试，GET /api/trades恢复丢应答的收据且不得重复记账。
- US/CN镜像、盈亏和订阅隔离；按ET/北京日期归档历史，持续运行时检查跨日。保留旧localStorage只作首次US迁移。
- 不加回React.StrictMode（TradingView双实例）；TradingView中文，主题依赖保留。CSS颜色只用主题变量，新增硬编码rgba需light对应。
- 图表与选中股票元数据独立于榜单；报价订阅通过/api/watch续期。价格历史TTL，不积累已消失股票键。

## 验证与协作

- `backend: npm test`（含真实本机临时端口REST/WS集成测试）；`frontend: npm test && npm run build`；双包npm audit。GitHub Actions Node22/24执行以上。
- 接外部源必须先核对真实响应，不把fixture通过声称为live通过。针对失败缓存、重连、重复平仓、跨日、超大WS消息要保留回归。
- 默认保留用户现有未提交改动；用户未要求时不自动提交或推送。运行测试用临时持仓文件，勿修改实际用户持仓或停止用户既有服务。
