import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

test('strategy code loads separately from the scanner entry without writing build output', async () => {
  const result = await build({ root: fileURLToPath(new URL('.', import.meta.url)), logLevel: 'silent', build: { write: false } });
  const outputs = Array.isArray(result) ? result.flatMap(item => item.output) : result.output;
  const chunks = outputs.filter(item => item.type === 'chunk');
  const entry = chunks.find(item => item.isEntry);
  const strategy = chunks.find(item => Object.keys(item.modules).some(id => id.replaceAll('\\', '/').endsWith('/src/StrategyCenter.jsx')));
  const news = chunks.find(item => Object.keys(item.modules).some(id => id.replaceAll('\\', '/').endsWith('/src/NewsPanel.jsx')));
  assert.ok(news);
  assert.notEqual(news, entry);
  assert.ok(entry.dynamicImports.includes(news.fileName));
  assert.ok(!Object.keys(entry.modules).some(id => id.replaceAll('\\', '/').endsWith('/src/NewsPanel.jsx')));
  assert.ok(entry);
  assert.ok(strategy);
  assert.notEqual(strategy, entry);
  assert.ok(entry.dynamicImports.includes(strategy.fileName));
  assert.ok(!Object.keys(entry.modules).some(id => id.replaceAll('\\', '/').endsWith('/src/StrategyCenter.jsx')));
});
