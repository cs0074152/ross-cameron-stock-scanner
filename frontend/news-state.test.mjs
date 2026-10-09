import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsSession, safeNewsUrl, newsTimeLabel } from './src/news-state.js';
async function flush() { for (let i=0;i<16;i++) await Promise.resolve(); }
function harness(fetchImpl, options={}) {
 let now=1000, sequence=0; const tasks=new Map(), states=[];
 const timers={setTimeout(fn,ms){const id=++sequence;tasks.set(id,{at:now+ms,fn});return id;},clearTimeout(id){tasks.delete(id);}};
 const session=createNewsSession({apiBase:'https://scanner.example',market:'US',symbol:'TEST',fetchImpl,timers,clock:()=>now,onState:s=>states.push(s),...options});
 return {session,states,tasks,async advance(ms){const until=now+ms;while(true){const next=[...tasks].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();await flush();}now=until;await flush();}};
}
const payload=(extra={})=>({market:'US',symbol:'TEST',status:'found',sources:[],items:[],...extra});
const response=body=>({ok:true,json:async()=>body});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
test('safe original links exclude credentials, private hosts, IPs and non-HTTPS',()=>{
 for(const url of ['https://finance.yahoo.com:444/news/report','javascript:alert(1)','http://finance.yahoo.com/a','https://user:pass@finance.yahoo.com','https://127.0.0.1/a','https://2130706433/a','https://[::1]/','https://10.0.0.1/','https://a.local/','https://localhost/','https://router.lan/','https://a.internal/','https://example.com./'])assert.equal(safeNewsUrl(url),null,url);
 assert.equal(safeNewsUrl('https://finance.yahoo.com:443/news/report'), 'https://finance.yahoo.com/news/report');
 assert.equal(safeNewsUrl('https://static.cninfo.com.cn/finalpage/report.pdf'),'https://static.cninfo.com.cn/finalpage/report.pdf');
 assert.equal(newsTimeLabel({timeStatus:'future'}),'时间异常');assert.equal(newsTimeLabel({timeStatus:'unknown'}),'时间未知');assert.match(newsTimeLabel({timeStatus:'older'}),/超过7天/);
});
test('debounce and disposal refuse late replies even if fetch ignores abort',async()=>{
 const p=deferred();let calls=0,signal;const h=harness(async(_,o)=>{calls++;signal=o.signal;return p.promise;});
 await h.advance(149);assert.equal(calls,0);await h.advance(1);assert.equal(calls,1);h.session.dispose();assert.equal(signal.aborted,true);const count=h.states.length;p.resolve(response(payload()));await flush();assert.equal(h.states.length,count);assert.equal(h.tasks.size,0);
});
test('hidden pages cancel requests and timers; resuming uses cache-respecting GET',async()=>{
 const p=deferred(),urls=[],signals=[];const h=harness(async(url,o)=>{urls.push(url);signals.push(o.signal);return urls.length===1?p.promise:response(payload());});
 await h.advance(150);h.session.setVisible(false);assert.equal(signals[0].aborted,true);assert.equal(h.tasks.size,0);p.resolve(response(payload({symbol:'OTHER'})));await flush();assert.equal(h.states.at(-1).data,null);await h.advance(300000);assert.equal(urls.length,1);h.session.setVisible(true);await h.advance(150);assert.equal(urls.length,2);assert.ok(urls.every(url=>!url.includes('refresh=1')));assert.equal(h.states.at(-1).data.symbol,'TEST');h.session.dispose();
});
test('refreshing yields at most four followup reads with no forced request loop',async()=>{
 const urls=[];const h=harness(async url=>{urls.push(url);return response(payload({refreshing:true}));});await h.advance(150);await h.advance(10000);assert.equal(urls.length,5);assert.ok(urls.every(url=>!url.includes('refresh=1')));await h.advance(20000);assert.equal(urls.length,5);h.session.dispose();
});
test('manual refresh is forced once, cooldown prevents floods, periodic reads remain ordinary',async()=>{
 const urls=[];const h=harness(async url=>{urls.push(url);return response(payload());});await h.advance(150);await h.session.refresh();await flush();assert.match(urls.at(-1),/refresh=1/);assert.equal(h.states.at(-1).retrySeconds,15);await h.session.refresh();assert.equal(urls.length,2);await h.advance(15000);assert.equal(h.states.at(-1).retrySeconds,0);await h.session.refresh();assert.equal(urls.length,3);await h.advance(300000);assert.equal(urls.length,4);assert.ok(!urls.at(-1).includes('refresh=1'));h.session.dispose();
});
test('deadline retains prior results, reports failure, and ignores late response',async()=>{
 const p=deferred();let calls=0;const h=harness(async()=>++calls===1?response(payload()):p.promise);await h.advance(150);const manual=h.session.refresh();await h.advance(8000);await manual;assert.match(h.states.at(-1).error,/超时/);assert.equal(h.states.at(-1).loading,false);assert.equal(h.states.at(-1).data.symbol,'TEST');p.resolve(response(payload({status:'none'})));await flush();assert.equal(h.states.at(-1).data.status,'found');h.session.dispose();
});
test('429 honors Retry-After and never masquerades as no news',async()=>{
 const h=harness(async()=>({ok:false,status:429,headers:{get:()=> '60'}}));await h.advance(150);assert.equal(h.states.at(-1).data,null);assert.match(h.states.at(-1).error,/较频繁/);assert.equal(h.states.at(-1).retrySeconds,60);await h.session.refresh();await h.advance(59000);assert.equal(h.states.at(-1).retrySeconds,1);h.session.dispose();
});
test('wrong-market payload cannot replace chosen-stock results',async()=>{
 const h=harness(async()=>response(payload({market:'CN'})));await h.advance(150);assert.equal(h.states.at(-1).data,null);assert.match(h.states.at(-1).error,/不匹配/);h.session.dispose();
});
