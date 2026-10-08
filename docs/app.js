const examples = {
  US: [['DEMOA','示例科技','8.62','18.40','5.6'],['DEMOB','示例医疗','6.15','12.80','4.2'],['DEMOC','示例能源','4.28','9.60','3.1']],
  CN: [['600000','演示样本 A','10.26','6.40','2.8'],['000001','演示样本 B','12.18','5.10','2.1'],['300001','演示样本 C','18.65','4.30','1.9']]
};
for (const button of document.querySelectorAll('[data-market]')) button.addEventListener('click', () => {
  const market = button.dataset.market;
  for (const other of document.querySelectorAll('[data-market]')) { const active = other === button; other.classList.toggle('active',active); other.setAttribute('aria-pressed',String(active)); }
  document.getElementById('demo-leader').textContent = examples[market][0][0];
  document.getElementById('demo-currency').textContent = market === 'CN' ? 'CNY · 北京时间' : 'USD · 美东时间';
  document.getElementById('demo-rule').textContent = market === 'CN' ? 'A 股 · T+1 与板块观察' : '美股 · 独立筛选条件';
  const tbody = document.getElementById('demo-rows'); tbody.replaceChildren();
  for (const [symbol,name,price,change,rvol] of examples[market]) {
    const row = document.createElement('tr');
    const first = document.createElement('td'); first.append(symbol); const small = document.createElement('small'); small.textContent=name; first.append(small); row.append(first);
    for (const [value, className] of [[`${market==='CN'?'¥':'$'}${price}`,''],[`+${change}%`,market==='CN'?'up-cn':'up-us'],[`${rvol}×`,'']]) { const cell=document.createElement('td'); cell.textContent=value; cell.className=className; row.append(cell); }
    tbody.append(row);
  }
});
const tabs = [...document.querySelectorAll('[data-platform]')];
function activateTab(tab, focus=false) {
  for (const button of tabs) { const active=button===tab; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); button.tabIndex=active?0:-1; document.getElementById(button.getAttribute('aria-controls')).hidden=!active; }
  if(focus) tab.focus();
}
for(const tab of tabs) { tab.addEventListener('click',()=>activateTab(tab)); tab.addEventListener('keydown',event=>{ if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return; event.preventDefault(); const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length; activateTab(tabs[index],true); }); }
for(const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click',async()=>{
  const text = button.closest('.command').querySelector('code').textContent;
  try { await navigator.clipboard.writeText(text); document.getElementById('copy-status').textContent='启动命令已复制。'; }
  catch { document.getElementById('copy-status').textContent='当前浏览器无法自动复制，请手动选中上方命令。'; }
});