import { useState, useEffect } from 'react';
import QuoteTime from './QuoteTime.jsx';

// ===== 策略中心：三步法 + 停工规则（依据《交易员罗斯卡梅伦的小账户挑战策略总结》） =====
const STRATEGY_STEPS = [
  {
    id: 1,
    title: '第一步 · 选股',
    icon: '🔍',
    intro: '满足条件越多，胜率越高。核心：找当天成交最活跃、最受关注的股票，只看涨幅榜最显眼的几只。主要交易时段：美东 7:00–10:00（消息多在一早出现）。',
    items: [
      '涨幅：当日收盘较昨收上涨超过 10%（严格版：超过 30%）',
      '相对成交量（必须满足）：当日成交量 ≥ 过去 50 天日均量的 5 倍',
      '消息驱动：涨幅和放量由明确新消息带动；无明确新闻但其余条件满足也可交易，仓位需减小',
      '股价范围：$2–$20，其中 $5–$10 更佳',
      '流通股本：< 2000 万股（严格版：< 1000 万股），流通盘小、消息一出易被抢筹'
    ]
  },
  {
    id: 2,
    title: '第二步 · 找买点',
    icon: '🎯',
    intro: '不追高：上涨途中追入，下方支撑远、止损空间差，盈亏比不合适。等回调再进场。',
    items: [
      '等待首次回调：冲高后回落几根 K 线，直至跌不动并横盘',
      '入场信号：一根 K 线价格越过前一根 K 线最高价，立即买入，无需等收线',
      '止损位：设在该次回调的最低点',
      '止盈目标：当日最高价附近',
      '盈亏比：入场前至少 1:1，最好 2 倍（看好的空间通常只能吃到一半）',
      '仓位控制：正常仓位，不突然重仓；正常仓位才拿得住、舍得卖'
    ]
  },
  {
    id: 3,
    title: '第三步 · 卖出',
    icon: '🏁',
    intro: '跌破回调低点 = 持仓理由消失，必须卖出。禁止向下移动止损，禁止补仓摊平。',
    items: [
      '保守止盈：涨到当日最高价先卖一半，继续上涨则边涨边卖',
      '激进做法：整笔持有，仅行情特别火爆时加仓，剩余等离场信号',
      '离场信号① 大卖单：卖一突然挂出远超买一的卖单（如买一 1000 股 vs 卖一 10 万股），刚入场遇到应立即离场',
      '离场信号② 隐藏卖家：热度很高、持续有人买入，但价格不涨不跌',
      '离场信号③ 主笔成交：买一价或更低价格成交增多、大片红色（卖方成交），突破可能是假的',
      '离场信号④ 冲高回落：长上影线或高位反复受阻，上涨势头转弱（不是见阴线就卖）',
      '离场信号⑤ 量能推动减弱：价格仍在升但量能萎缩（对比需用可同时段）'
    ]
  }
];

const POS_STATUS_LABEL = { holding: '持有中', stale: '行情过期 / 待报价', warning: '⚠️ 离场信号', stop_triggered: '🚨 止损触发', target_hit: '🎯 到达目标' };
const RADAR_STATE_LABEL = { rally: '📈 冲高中·勿追', pullback: '⏳ 回调中·等企稳', based: '🟡 横盘企稳·盯突破', trigger: '⚡ 买入信号', watch: '— 数据积累中' };

function StrategyCenter({ stocks, session, etMeta, selectedSymbol, onOpenPreset, trade, setTrade, onMarkBuy, onClosePosition, onAdjustPosition, pending, historyDates, onHistoryDate, historyDate }) {
  const [tradeInput, setTradeInput] = useState('');
  const addTrade = () => {
    const v = parseFloat(tradeInput);
    if (!Number.isFinite(v)) return;
    setTrade(s => ({ ...s, entries: [...s.entries, v] }));
    setTradeInput('');
  };

  const cum = trade.entries.reduce((a, b) => a + b, 0);
  let peak = 0;
  let run = 0;
  trade.entries.forEach(e => { run += e; if (run > peak) peak = run; });
  const givebackPct = peak > 0 ? Math.round(((peak - cum) / peak) * 100) : 0;

  // 交易计划计算器（第二步纪律：盈亏比至少 1:1，最好 2 倍）
  const [calc, setCalc] = useState(() => {
    try {
      return { entry: '', stop: '', target: '', shares: '100', ...(JSON.parse(localStorage.getItem('scanner-calc')) || {}) };
    } catch {
      return { entry: '', stop: '', target: '', shares: '100' };
    }
  });
  useEffect(() => {
    localStorage.setItem('scanner-calc', JSON.stringify(calc));
  }, [calc]);

  const entry = parseFloat(calc.entry);
  const stopP = parseFloat(calc.stop);
  const target = parseFloat(calc.target);
  const shares = parseInt(calc.shares, 10) || 0;
  const riskPer = entry - stopP;
  const rewardPer = target - entry;
  const rr = riskPer > 0 ? rewardPer / riskPer : null;
  const riskAmt = riskPer * shares;
  const rewardAmt = rewardPer * shares;

  const fillSelected = () => {
    if (!selectedSymbol) return;
    const lists = [stocks.gainers, stocks.losers, stocks.mostActive, stocks.premarket, stocks.afterhours];
    for (const list of lists) {
      const hit = (list || []).find(s => s.symbol === selectedSymbol);
      if (hit) {
        setCalc(c => ({ ...c, entry: String(hit.price), target: String(hit.high) }));
        return;
      }
    }
  };

  // 五条停工规则状态
  const goldenStart = 7 * 60;
  const goldenEnd = 10 * 60;
  let rule3;
  if (etMeta.minutes == null) {
    rule3 = { detail: '等待行情数据…', status: 'unknown' };
  } else if (etMeta.day === 0 || etMeta.day === 6) {
    rule3 = { detail: '周末休市', status: 'unknown' };
  } else if (etMeta.minutes >= goldenEnd) {
    rule3 = { detail: '主要交易时段（美东 7:00–10:00）已过', status: 'trigger' };
  } else if (etMeta.minutes >= goldenStart) {
    rule3 = { detail: '黄金时段进行中（美东 7:00–10:00）✓', status: 'ok' };
  } else {
    rule3 = { detail: '未到主要交易时段（美东 7:00–10:00）', status: 'ok' };
  }

  const docCount = stocks.docPick ? stocks.docPick.length : 0;
  const docStrictCount = stocks.docPickStrict ? stocks.docPickStrict.length : 0;
  let rule4;
  if (session === 'regular') {
    rule4 = docCount > 0
      ? { detail: `盘中符合量化条件 ${docCount} 只（严格版 ${docStrictCount} 只）`, status: 'ok' }
      : { detail: '盘中没有符合量化条件的股票', status: 'trigger' };
  } else {
    rule4 = { detail: `当前非盘中，量比数据不完整（盘前口径：标准 ${docCount} 只 / 严格 ${docStrictCount} 只，仅供参考）`, status: 'unknown' };
  }

  const rules = [
    {
      name: '当日利润从最高点回吐一半',
      detail: peak > 0
        ? `最高盈利 $${peak.toFixed(0)} → 当前 $${cum.toFixed(0)}（回吐 ${givebackPct}%，触发线 50%）`
        : '今日暂无盈亏记录',
      status: peak > 0 && cum <= peak / 2 ? 'trigger' : 'ok'
    },
    {
      name: '亏损达到当日最大亏损额',
      detail: `当日累计 ${cum >= 0 ? '+$' : '-$'}${Math.abs(cum).toFixed(0)} / 上限 -$${Math.abs(trade.maxLoss)}（连续止损次数不能替代金额限制）`,
      status: cum <= -Math.abs(trade.maxLoss) ? 'trigger' : 'ok'
    },
    { name: '自己表现最好的时段已过', detail: rule3.detail, status: rule3.status },
    { name: '市场上没有符合要求的机会', detail: rule4.detail, status: rule4.status },
    {
      name: '当天行情已明显转弱',
      detail: '由你人工判断并勾选',
      status: trade.marketWeak ? 'trigger' : 'ok'
    }
  ];
  const triggered = rules.filter(r => r.status === 'trigger');
  const ruleIcon = { trigger: '🚫', ok: '✅', unknown: '➖' };

  // 持仓监控 + 买点雷达数据
  const positionList = stocks.positions || [];
  const pool = stocks.strategyPool || { limited: false, rows: [] };
  const stopHit = positionList.filter(p => p.status === 'stop_triggered');
  const targetHit = positionList.filter(p => p.status === 'target_hit');
  const warned = positionList.filter(p => p.status === 'warning');

  const markFromRow = (r) => {
    const entry = parseFloat(r.price);
    onMarkBuy({
      symbol: r.symbol,
      entry,
      shares: 100,
      stop: r.pullbackLow != null ? Number(r.pullbackLow) : Math.round(entry * 0.98 * 100) / 100,
      target: Number(r.dayHigh) > entry ? Number(r.dayHigh) : null
    });
  };

  return (
    <div className="strategy">
      <section className={`shutdown-panel ${triggered.length > 0 ? 'shutdown-active' : ''}`}>
        <div className="panel-title">
          <h2>🛑 停工规则看板</h2>
          <span className="panel-sub">触发任一条：当天停止交易</span>
        </div>
        {triggered.length > 0 ? (
          <div className="shutdown-banner trigger">
            <strong>🚫 已触发：{triggered.map(r => r.name).join('、')}</strong>
            <span>停工三件事：① 处理剩余持仓 ② 撤销未成交订单 ③ 复盘休息，今天不再交易</span>
          </div>
        ) : (
          <div className="shutdown-banner ok">
            <strong>✅ 交易状态正常</strong>
            <span>按三步法纪律执行；触发任一停工规则立即收工。</span>
          </div>
        )}

        <div className="shutdown-grid">
          <div className="sub-card">
            <div className="sub-title">当日盈亏记录（手动录入每笔已实现盈亏，正盈利 / 负亏损）</div>
            <div className="pnl-summary">
              <span>累计：<b className={cum >= 0 ? 'pos' : 'neg'}>{cum >= 0 ? '+$' : '-$'}{Math.abs(cum).toFixed(2)}</b></span>
              <span>最高点：<b>${peak.toFixed(2)}</b></span>
              {peak > 0 && <span>回吐：<b className={givebackPct >= 50 ? 'neg' : ''}>{givebackPct}%</b></span>}
            </div>
            <div className="pnl-input-row">
              <input
                className="mini-input"
                type="number"
                step="any"
                placeholder="如 -150 或 300"
                value={tradeInput}
                onChange={e => setTradeInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTrade()}
              />
              <button className="btn" onClick={addTrade}>记一笔</button>
              <label className="weak-check">
                <input
                  type="checkbox"
                  checked={!!trade.marketWeak}
                  onChange={e => setTrade(s => ({ ...s, marketWeak: e.target.checked }))}
                />
                行情已明显转弱
              </label>
            </div>
            {trade.entries.length > 0 && (
              <div className="trade-chips">
                {trade.entries.map((v, i) => (
                  <span
                    key={i}
                    className={`trade-chip ${v >= 0 ? 'positive' : 'negative'}`}
                    title="点击删除这笔记录"
                    onClick={() => setTrade(s => ({ ...s, entries: s.entries.filter((_, j) => j !== i) }))}
                  >
                    {v >= 0 ? '+' : ''}{v} ×
                  </span>
                ))}
              </div>
            )}
            <div className="pnl-input-row max-loss-row">
              <label className="weak-check">当日最大亏损额：$</label>
              <input
                className="mini-input"
                type="number"
                value={trade.maxLoss}
                onChange={e => setTrade(s => ({ ...s, maxLoss: parseFloat(e.target.value) || 0 }))}
              />
              <button className="btn secondary" onClick={() => setTrade(s => ({ ...s, entries: [], marketWeak: false }))}>清空今日记录</button>
            </div>
            <TradeHistory dates={historyDates} selected={historyDate} onChange={onHistoryDate} market="US" />
          </div>

          <div className="sub-card">
            <div className="sub-title">五条停工规则</div>
            {rules.map(r => (
              <div key={r.name} className={`rule-row ${r.status}`}>
                <span className="rule-icon">{ruleIcon[r.status]}</span>
                <div>
                  <div className="rule-name">{r.name}</div>
                  <div className="rule-detail">{r.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 持仓监控（第三步：标记买入后自动盯盘） */}
      <section className="shutdown-panel">
        <div className="panel-title">
          <h2>📌 持仓监控</h2>
          <span className="panel-sub">标记买入后自动检测：止损 / 止盈 / 离场信号（15 秒快照驱动）</span>
        </div>
        {stopHit.length > 0 && (
          <div className="shutdown-banner trigger pulse">
            <strong>🚨 止损触发：{stopHit.map(p => `${p.symbol} 已跌破 $${Number(p.stop).toFixed(2)}`).join('；')}</strong>
            <span>持仓理由已消失 —— 必须立即卖出；禁止向下移动止损，禁止补仓摊平。</span>
          </div>
        )}
        {targetHit.length > 0 && (
          <div className="shutdown-banner ok">
            <strong>🎯 到达止盈目标：{targetHit.map(p => p.symbol).join('、')}</strong>
            <span>保守做法：先卖一半，继续上涨则边涨边卖。</span>
          </div>
        )}
        {warned.length > 0 && (
          <div className="shutdown-banner warn">
            <strong>⚠️ 出现离场信号：{warned.map(p => p.symbol).join('、')}</strong>
            <span>出现任一离场信号，至少减仓一部分。</span>
          </div>
        )}
        {positionList.length === 0 ? (
          <div className="empty-hint">暂无持仓 —— 在下方买点雷达出现 ⚡买入信号 时点击"标记买入"，也可"手动标记"应急入场。</div>
        ) : (
          <table className="pos-table">
            <thead>
              <tr><th>代码</th><th>入场</th><th>现价</th><th>浮动盈亏</th><th>止损（回调低点）</th><th>目标</th><th>股数</th><th>状态 / 自动检测信号</th><th>操作</th></tr>
            </thead>
            <tbody>
              {positionList.map(p => (
                <tr key={p.symbol} className={p.status === 'stop_triggered' ? 'row-alert' : ''}>
                  <td className="sym">{p.symbol}</td>
                  <td>${Number(p.entry).toFixed(2)}</td>
                  <td>{p.price == null ? '—' : `$${Number(p.price).toFixed(2)}`}</td>
                  <td className={p.pnlPct >= 0 ? 'pos' : 'neg'}>{p.pnlPct >= 0 ? '+' : ''}{p.pnlPct.toFixed(2)}%</td>
                  <td>
                    <input
                      className="mini-input tiny"
                      type="number"
                      step="any"
                      defaultValue={p.stop ?? ''}
                      disabled={pending(p.symbol)}
                      key={`stop-${p.symbol}-${p.stop}`}
                      onBlur={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v !== p.stop) onAdjustPosition(p.symbol, { stop: v }); }}
                    />
                  </td>
                  <td>{p.target != null ? `$${Number(p.target).toFixed(2)}` : '—'}</td>
                  <td>
                    <input
                      className="mini-input tiny"
                      type="number"
                      defaultValue={p.shares || ''}
                      disabled={pending(p.symbol)}
                      key={`sh-${p.symbol}-${p.shares}`}
                      onBlur={e => { const v = parseInt(e.target.value, 10) || 0; if (v !== p.shares) onAdjustPosition(p.symbol, { shares: v }); }}
                    />
                  </td>
                  <td>
                    <span className={`state-badge ${p.status}`}>{POS_STATUS_LABEL[p.status] || p.status}</span>
                    {(p.signals || []).map((sig, i) => <div key={i} className="sig-line">{sig}</div>)}
                  </td>
                  <td>
                    <button className="btn secondary" disabled={pending(p.symbol) || p.status === 'stale'} onClick={() => onClosePosition(p.symbol)}>{pending(p.symbol) ? '保存中…' : '平仓记录'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="manual-note">离场信号① 大卖单、③ 主笔成交（买一价/更低价格成交增多）需要盘口数据，无法从行情快照自动识别 —— 请在 Level2 / 分时成交中人工盯盘。</div>
      </section>

      {/* 买点雷达（第二步：自动检测所有候选股的买点） */}
      <section className="shutdown-panel">
        <div className="panel-title">
          <h2>🎯 买点雷达</h2>
          <span className="panel-sub">冲高 → 首次回调 → 横盘企稳 → 突破前一根高点 ⚡（盈亏比 ≥2 才发信号；止损 = 回调低点，目标 = 当日高点）</span>
        </div>
        {pool.limited && (
          <div className="shutdown-banner warn">
            <strong>观察池模式</strong>
            <span>当前非盘中，量比数据不完整 —— 以下为涨幅榜前 10 观察对象，买点信号仅供参考。</span>
          </div>
        )}
        {pool.rows.length === 0 ? (
          <div className="empty-hint">等待行情数据…（盘中将自动列出符合选股条件的股票并检测买点）</div>
        ) : (
          <table className="pos-table">
            <thead>
              <tr><th>代码</th><th>现价</th><th>涨幅</th><th>选股条件</th><th>状态（第二步）</th><th>止损参考（回调低点）</th><th>目标参考（当日高点）</th><th>盈亏比</th><th>操作</th></tr>
            </thead>
            <tbody>
              {pool.rows.map(r => (
                <tr key={r.symbol} className={r.state === 'trigger' ? 'row-trigger' : ''}>
                  <td className="sym">{r.symbol}<div className="sym-name">{r.name}</div></td>
                  <td>${Number(r.price).toFixed(2)}</td>
                  <td className={parseFloat(r.changePercent) >= 0 ? 'pos' : 'neg'}>{parseFloat(r.changePercent) >= 0 ? '+' : ''}{r.changePercent}%</td>
                  <td>{r.watchOnly ? <span className="cond-chip watch">观察池</span> : <span className="cond-chip ok">✓ 量化条件</span>}</td>
                  <td><span className={`state-badge ${r.state}`}>{RADAR_STATE_LABEL[r.state] || r.state}</span></td>
                  <td>{r.pullbackLow != null ? `$${Number(r.pullbackLow).toFixed(2)}` : '—'}</td>
                  <td>{r.dayHigh != null ? `$${Number(r.dayHigh).toFixed(2)}` : '—'}</td>
                  <td>{r.rr != null ? `1:${Number(r.rr).toFixed(2)}` : '—'}</td>
                  <td>
                    {r.held ? (
                      <span className="cond-chip held">已入场</span>
                    ) : r.state === 'trigger' ? (
                      <button className="btn" disabled={pending(r.symbol)} onClick={() => markFromRow(r)}>⚡ 标记买入</button>
                    ) : (
                      <button
                        className="btn secondary"
                        disabled={pending(r.symbol)}
                        title="⚠️ 非标准买入信号（标准买点：回调企稳后突破前一根高点，且盈亏比 ≥2）。仅作手动应急入场。"
                        onClick={() => markFromRow(r)}
                      >
                        手动标记
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="steps-row">
        {STRATEGY_STEPS.map(step => (
          <div key={step.id} className="step-card">
            <h3>{step.icon} {step.title}</h3>
            <div className="step-intro">{step.intro}</div>
            <ul>
              {step.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
            {step.id === 1 && (
              <div className="step-actions">
                <button className="btn" onClick={() => onOpenPreset('docPick')}>查看标准选股（{docCount} 只）</button>
                <button className="btn secondary" onClick={() => onOpenPreset('docPickStrict')}>严格版（{docStrictCount} 只）</button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="calc-panel">
        <div className="panel-title">
          <h2>🧮 交易计划计算器（第二步纪律）</h2>
          <span className="panel-sub">止损 = 回调低点 ｜ 目标 = 当日高点 ｜ 盈亏比至少 1:1，最好 2 倍</span>
        </div>
        <div className="calc-grid">
          <div className="calc-field">
            <label>入场价</label>
            <input type="number" step="any" value={calc.entry} onChange={e => setCalc(c => ({ ...c, entry: e.target.value }))} />
          </div>
          <div className="calc-field">
            <label>止损价（回调低点）</label>
            <input type="number" step="any" value={calc.stop} onChange={e => setCalc(c => ({ ...c, stop: e.target.value }))} />
          </div>
          <div className="calc-field">
            <label>目标价（当日高点）</label>
            <input type="number" step="any" value={calc.target} onChange={e => setCalc(c => ({ ...c, target: e.target.value }))} />
          </div>
          <div className="calc-field">
            <label>股数</label>
            <input type="number" value={calc.shares} onChange={e => setCalc(c => ({ ...c, shares: e.target.value }))} />
          </div>
          <button
            className="btn secondary"
            disabled={!selectedSymbol}
            title={selectedSymbol ? `填入 ${selectedSymbol} 的现价与当日最高价` : '先在扫描器中点击一只股票'}
            onClick={fillSelected}
          >
            填入选中股票
          </button>
        </div>
        <div className={`calc-verdict ${rr == null ? '' : rr >= 2 ? 'good' : rr >= 1 ? 'warn' : 'bad'}`}>
          {rr == null
            ? '请输入入场价与止损价（止损价需低于入场价）'
            : `单股风险 $${riskPer.toFixed(2)} ｜ 单股目标利润 $${rewardPer.toFixed(2)} ｜ 盈亏比 1:${rr.toFixed(2)} —— ${rr >= 2 ? '✓ 优秀，符合纪律' : rr >= 1 ? '△ 勉强合格（建议等更好的回调位置）' : '✗ 不合格，放弃这笔交易'}${shares > 0 ? ` ｜ ${shares} 股：最大亏损 $${Math.abs(riskAmt).toFixed(0)}，目标盈利 $${rewardAmt.toFixed(0)}` : ''}`}
        </div>
      </section>

      <details className="case-card">
        <summary>📖 实战案例：ZTG（46 天挑战实录）</summary>
        <ul>
          <li>美东 7:06 进入观察：成交活跃、价格快速翻倍、流通盘约 719 万股</li>
          <li>五条通过四条（无明确新闻、股价约 $1.6 略低于下限视为通过）→ 可入场，但仓位要小</li>
          <li>看 10 秒图，小回调后进场，买入价约 $1.55–1.62</li>
          <li>冲高至近 $2.8 后出现主笔卖方成交增加、大卖单、冲高回落 → 在 $2.6 / $2.3 / $2.23 / $2.12 分批卖出，7:30 前全部出清</li>
          <li>当日盈利约 $11,400；卖出后股价虽一度冲到 $3.6，但按纪律依据转弱信号离场是正确执行</li>
        </ul>
      </details>
    </div>
  );
}

function TradeHistory({ dates, market }) {
  const available = Object.keys(dates || {}).sort().reverse();
  const [selected, setSelected] = useState('');
  const date = available.includes(selected) ? selected : available[0];
  const entries = dates?.[date]?.entries || [];
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  return <details className="trade-history"><summary>历史盈亏记录（按{market === 'CN' ? '北京' : '美东'}日期归档）</summary>{available.length ? <><label>查看日期 <select value={date} onChange={event => setSelected(event.target.value)}>{available.map(value => <option key={value}>{value}</option>)}</select></label><p>{date} · {entries.length} 笔 · {market === 'CN' ? '¥' : '$'}{total.toFixed(2)}</p><div className="history-entries">{entries.map(entry => <span key={entry.id}>{entry.value >= 0 ? '+' : ''}{entry.value.toFixed(2)}</span>)}</div></> : <p>暂无历史记录</p>}</details>;
}

function CNStrategyCenter({ stocks, selectedStock, trade, setTrade, onMarkBuy, onClosePosition, onAdjustPosition, pending, historyDates, scope, calendarKnown }) {
  const [shares, setShares] = useState('100');
  const [pnlInput, setPnlInput] = useState('');
  const positions = stocks.positions || [];
  const rows = stocks.strategyPool?.rows || [];
  const cum = trade.entries.reduce((sum, value) => sum + value, 0);
  const mark = row => {
    const entry = Number(row.price);
    onMarkBuy({ symbol: row.symbol, entry, shares: Number(shares), stop: row.pullbackLow != null && Number(row.pullbackLow) < entry ? Number(row.pullbackLow) : Math.round(entry * 0.97 * 100) / 100, target: Number(row.dayHigh) > entry ? Number(row.dayHigh) : null });
  };
  return <div className="strategy cn-strategy">
    <section className="shutdown-panel">
      <div className="panel-title"><h2>A 股观察与持仓</h2><span className="panel-sub">人民币 · 北京时间 · 不连接券商、不下单</span></div>
      <div className="shutdown-banner warn"><strong>A 股规则：T+1、买入通常按 100 股整手</strong><span>当日买入不可当日卖出；观察信号基于行情快照，不能作为美股日内买卖规则使用。科创板等实际委托数量规则请以券商为准，本工具先按 100 股登记。</span>{!calendarKnown && <span>当前年度交易日历未知，T+1 可卖日期需人工核实；工具暂停自动放行平仓。</span>}</div>
      <div className="pnl-input-row"><label>登记股数（100 股整数倍） <input className="mini-input" type="number" min="100" step="100" value={shares} onChange={event => setShares(event.target.value)} /></label>{selectedStock && <button className="btn secondary" disabled={pending(selectedStock.symbol)} onClick={() => mark(selectedStock)}>登记选中股票 {selectedStock.symbol}</button>}</div>
    </section>
    <section className="shutdown-panel">
      <div className="panel-title"><h2>持仓监控</h2><span className="panel-sub">源报价过期或未知时不产生新的止损 / 止盈判断</span></div>
      {positions.length ? <div className="position-table-scroll"><table className="pos-table"><thead><tr><th>代码</th><th>入场 / 现价</th><th>盈亏</th><th>止损</th><th>目标</th><th>股数</th><th>状态 / 风险</th><th>可卖日期</th><th>操作</th></tr></thead><tbody>{positions.map(position => <tr key={position.symbol} className={position.status === 'stop_triggered' ? 'row-alert' : ''}>
        <td className="sym">{position.symbol}</td><td>¥{Number(position.entry).toFixed(2)} / {position.price == null ? '—' : `¥${Number(position.price).toFixed(2)}`}<div className="quote-time"><QuoteTime value={position.quoteTime} market="CN" /></div></td><td className={position.pnlPct >= 0 ? 'pos' : 'neg'}>{Number(position.pnlPct || 0).toFixed(2)}%</td>
        <td><input className="mini-input tiny" type="number" step="0.01" defaultValue={position.stop ?? ''} key={`${position.symbol}-${position.stop}`} disabled={pending(position.symbol)} onBlur={event => { const stop = Number(event.target.value); if (stop !== position.stop) onAdjustPosition(position.symbol, { stop }); }} /></td>
        <td>{position.target == null ? '—' : `¥${Number(position.target).toFixed(2)}`}</td><td>{position.shares}</td><td><span className={`state-badge ${position.status}`}>{POS_STATUS_LABEL[position.status] || position.status}</span>{(position.signals || []).map((signal, index) => <div className="sig-line" key={index}>{signal}</div>)}</td><td>{position.tradableOn || '待核实'}{position.sellable === false && <div className="risk-label">T+1：暂不可卖</div>}</td><td><button className="btn secondary" disabled={pending(position.symbol) || position.sellable === false || !calendarKnown} onClick={() => onClosePosition(position.symbol)}>{pending(position.symbol) ? '保存中…' : '平仓记录'}</button></td>
      </tr>)}</tbody></table></div> : <div className="empty-hint">暂无 A 股持仓。登记用于观察与记账，请填写实际成交数量与价格。</div>}
    </section>
    <section className="shutdown-panel"><div className="panel-title"><h2>A 股候选观察池</h2><span className="panel-sub">观察信号，不表示自动买入建议</span></div><div className="scope-note">{scope?.description || '仅行情源三类榜单样本'} · 价格 5–100 元、涨幅 ≥3%、量比 ≥1.5；排除已知 ST、新股及接近常规涨停的股票；上市日期和实际涨停价未提供时须人工核实。</div>
      {rows.length ? <div className="position-table-scroll"><table className="pos-table"><thead><tr><th>代码 / 名称</th><th>板块 / 风险</th><th>现价</th><th>涨幅</th><th>观察阶段</th><th>回调低点 / 日高</th><th>操作</th></tr></thead><tbody>{rows.map(row => <tr key={row.symbol}><td className="sym">{row.symbol}<div className="sym-name">{row.name}</div></td><td>{row.boardLabel || row.board || '板块待核实'}<div className="risk-label">{(row.riskTags || []).join(' / ') || '无已知风险标签'}</div></td><td>¥{Number(row.price).toFixed(2)}<div className="quote-time"><QuoteTime value={row.quoteTime} market="CN" /></div></td><td className={Number(row.changePercent) >= 0 ? 'pos' : 'neg'}>{row.changePercent}%</td><td>{row.state === 'trigger' ? '突破观察' : RADAR_STATE_LABEL[row.state] || '观察中'}</td><td>{row.pullbackLow ?? '—'} / {row.dayHigh ?? '—'}</td><td><button className="btn secondary" disabled={row.held || pending(row.symbol)} onClick={() => mark(row)}>{row.held ? '已登记' : '手动登记买入'}</button></td></tr>)}</tbody></table></div> : <div className="empty-hint">当前样本中没有满足数值条件的候选股；可在扫描器自定义筛选并人工核对。</div>}
    </section>
    <section className="shutdown-panel"><div className="panel-title"><h2>当日盈亏记录</h2><span className="panel-sub">{trade.date} · 按北京交易日期归档</span></div><div className="pnl-summary">累计：<b className={cum >= 0 ? 'pos' : 'neg'}>¥{cum.toFixed(2)}</b></div><div className="pnl-input-row"><input className="mini-input" type="number" step="any" placeholder="每笔已实现盈亏" value={pnlInput} onChange={event => setPnlInput(event.target.value)} /><button className="btn" onClick={() => { const value = Number(pnlInput); if (pnlInput !== '' && Number.isFinite(value)) { setTrade(previous => ({ ...previous, entries: [...previous.entries, value] })); setPnlInput(''); } }}>记一笔</button></div><div className="trade-chips">{trade.entries.map((value, index) => <button className={`trade-chip ${value >= 0 ? 'positive' : 'negative'}`} key={index} title="删除这笔展示记录；历史平仓收据仍在服务器保存" onClick={() => setTrade(previous => ({ ...previous, entries: previous.entries.filter((_, entryIndex) => entryIndex !== index) }))}>{value >= 0 ? '+' : ''}{value} ×</button>)}</div><TradeHistory dates={historyDates} market="CN" /></section>
  </div>;
}


export { StrategyCenter, CNStrategyCenter };
export default function StrategyView({ market, ...props }) {
  return market === 'CN' ? <CNStrategyCenter {...props} /> : <StrategyCenter {...props} />;
}
