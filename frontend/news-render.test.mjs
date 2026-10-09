import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('news presentation distinguishes source failure, scoped empty samples and unsafe source text', async () => {
  const vite = await createServer({root:fileURLToPath(new URL('.',import.meta.url)),server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
  try {
    const { NewsPanelContent } = await vite.ssrLoadModule('/src/NewsPanel.jsx');
    const render = (data, extra = {}, market = 'US') => renderToStaticMarkup(React.createElement(NewsPanelContent,{market,symbol:market==='CN'?'600000':'TEST',state:{data,error:null,loading:false,retrySeconds:0,...extra}}));
    const base = {status:'none',partial:false,stale:false,refreshing:false,items:[],sources:[],checkedAt:'2026-10-01T01:00:00Z',lastSuccessAt:'2026-09-30T01:00:00Z'};
    assert.match(render(base),/本次未找到标的匹配报道（Yahoo检索样本）/);assert.match(render(base),/<details class="news-details"><summary>查询详情<\/summary>/);assert.match(render(base),/最后尝试/);assert.match(render(base),/上次成功/);assert.match(render(base),/以上是来源查询时间；条目日期是原文发布时间/);
    assert.match(render(base,{},'CN'),/最近90天本次未找到匹配公告/);
    const refreshingEmpty = render({...base,refreshing:true},{},'CN');
    assert.match(refreshingEmpty,/来源更新中/);assert.match(refreshingEmpty,/上次成功结果/);assert.doesNotMatch(refreshingEmpty,/本次未找到/);
    const unavailable = render({...base,status:'unavailable',sources:[{id:'yahoo',status:'error'}]});
    assert.match(unavailable,/来源获取失败/);assert.match(unavailable,/不能据此判断没有新闻或公告/);assert.doesNotMatch(unavailable,/本次未找到/);
    const failed = render(base,{error:'核查请求超时，请稍后重试。'});
    assert.match(failed,/未完成本次核查/);assert.match(failed,/上次成功结果/);assert.doesNotMatch(failed,/本次未找到/);
    const found = render({...base,status:'found',stale:true,recentCount:0,items:[{id:'unsafe',title:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)',source:'Yahoo',publisher:'Publisher',evidenceType:'media',timePrecision:'unknown',timeStatus:'future',stale:true},{id:'safe',title:'原文公告',url:'https://static.cninfo.com.cn/test.pdf',source:'巨潮',evidenceType:'announcement',publishedDate:'2026-09-01',timePrecision:'day',timeStatus:'older'}]});
    assert.match(found,/&lt;img/);assert.doesNotMatch(found,/<img|href="javascript:/);assert.match(found,/rel="noreferrer noopener"/);assert.match(found,/Yahoo 收录的相关报道/);assert.match(found,/公司公告可追溯/);assert.match(found,/旧缓存：本次未取得最新来源记录。上次成功/);assert.match(found,/查询详情/);assert.match(found,/时间异常/);assert.match(found,/超过7天/);assert.match(found,/2026-09-01/);assert.match(found,/跟随榜单选股/);assert.doesNotMatch(found,/事实已核实|催化已证实/);
    const loading = render(null,{loading:true});assert.match(loading,/正在核查/);
  } finally {await vite.close();}
});
