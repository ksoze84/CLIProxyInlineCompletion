const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCompletion } = require('../out/completionText');
const { fetchCompletion } = require('../out/cliProxyClient');
const { startServer, reply } = require('./helpers.cjs');
const { RequestCoordinator, waitForIdle } = require('../out/requestCoordinator');
const { contextWindow, isSensitivePath } = require('../out/textContext');
const { EditHistory, buildNextEditRequest, parseNextEdit } = require('../out/nextEdit');
const { checkBaseUrl, fetchNextEdit, safeErrorMessage } = require('../out/cliProxyClient');

test('completion inserts a function body and removes a duplicated suffix', () => {
  assert.equal(sanitizeCompletion('return 1;\n}', '', '\n}'), 'return 1;');
});

test('completion unwraps a model code fence', () => {
  assert.equal(sanitizeCompletion('```ts\nreturn 1;\n```', '', ''), 'return 1;');
});

test('chat transport sends both sides of the cursor and supports typed text parts', async () => {
  const server = await startServer((_entry, response) => reply(response, [{ type: 'text', text: 'value;' }]));
  try {
    const config = { baseUrl: server.baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.1, apiKey: '', systemPrompt: '' };
    const request = { languageId: 'typescript', fileName: 'fixture.ts', prefix: 'return ', suffix: '\n}' };
    assert.equal(await fetchCompletion(config, request, new AbortController().signal), 'value;');
    assert.equal(server.requests[0].url, '/v1/chat/completions');
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(server.requests[0].body.messages[1].content), request);
  } finally {
    await server.close();
  }
});

test('reasoning effort is omitted by default and forwarded verbatim when set for both contracts', async () => {
  const server = await startServer((_entry, response) => reply(response, 'value;'));
  try {
    const base = { baseUrl: server.baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.1, apiKey: '' };
    const request = { languageId: 'typescript', fileName: 'fixture.ts', prefix: '', suffix: '' };
    await fetchCompletion(base, request, new AbortController().signal);
    assert.equal('reasoning_effort' in server.requests[0].body, false);
    await fetchCompletion({ ...base, reasoningEffort: 'high' }, request, new AbortController().signal);
    assert.equal(server.requests[1].body.reasoning_effort, 'high');
    await fetchCompletion({ ...base, reasoningEffort: '' }, request, new AbortController().signal);
    assert.equal('reasoning_effort' in server.requests[2].body, false);
    await fetchNextEdit({ ...base, reasoningEffort: 'minimal' }, { window: { text: 'data' } }, new AbortController().signal);
    assert.equal(server.requests[3].body.reasoning_effort, 'minimal');
    await fetchNextEdit(base, { window: { text: 'data' } }, new AbortController().signal);
    assert.equal('reasoning_effort' in server.requests[4].body, false);
  } finally {
    await server.close();
  }
});

test('preserves meaningful whitespace, Markdown fences, EOL and identifier characters', () => {
  assert.equal(sanitizeCompletion('  value  \n    ', '', ''), '  value  \n    ');
  assert.equal(sanitizeCompletion('```js\ncode\n```', '', '', 'markdown'), '```js\ncode\n```');
  assert.equal(sanitizeCompletion('class', '', 'something'), 'class');
  assert.equal(sanitizeCompletion('value;\n  ', '', '', 'typescript', '\r\n'), 'value;\r\n  ');
  assert.equal(sanitizeCompletion('Here is the code:', '', ''), '');
  assert.equal(sanitizeCompletion('Here is the code:', '', '', 'plaintext'), 'Here is the code:');
});

test('context windows respect line boundaries and reject oversized lines', () => {
  const text = 'first\nsecond\nthird\nfourth';
  const window = contextWindow(text, 8, 14);
  assert.ok(window.text.length <= 14);
  assert.equal(text.slice(window.start, window.start + window.text.length), window.text);
  assert.ok(window.text.includes('second'));
  assert.equal(contextWindow('x'.repeat(30), 15, 10), undefined);
  for (const name of ['.env', 'dir/.env.local', '.ssh/id_rsa', 'secret.pem', 'credentials.json']) {
    assert.equal(isSensitivePath(name), true);
  }
  assert.equal(isSensitivePath('src/example.ts'), false);
});

test('completion and NES only cancel their own channel; NES can wait for an idle completion', async () => {
  const coordinator = new RequestCoordinator();
  const completion = coordinator.start('completion');
  const nes = coordinator.start('nextEdit');
  assert.equal(completion.isCurrent(), true);
  assert.equal(nes.isCurrent(), true);
  let idle = false;
  const waitingIdle = coordinator.completionIdle(nes.signal).then(ready => { idle = ready; return ready; });
  const replacement = coordinator.start('completion');
  assert.equal(completion.isCurrent(), false);
  completion.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false, 'a replacement completion keeps NES waiting');
  replacement.finish();
  assert.equal(await waitingIdle, true);
  assert.equal(nes.isCurrent(), true);
  const waiting = waitForIdle(10000, nes.signal);
  const second = coordinator.start('nextEdit');
  assert.equal(await waiting, false);
  assert.equal(nes.isCurrent(), false);
  coordinator.start('completion');
  const blocked = coordinator.completionIdle(second.signal);
  second.cancel();
  assert.equal(await blocked, false);
  const third = coordinator.start('nextEdit');
  coordinator.dispose();
  assert.equal(third.isCurrent(), false);
  assert.equal(coordinator.isBusy('completion'), false);
});

test('NES accepts a replacement, anchored insertion and deletion at the exact document offset', () => {
  const text = 'const user = load();\nreturn user.name;\n';
  for (const newText of ['return user.displayName;', 'return user.name;\nlog();', '']) {
    const result = parseNextEdit(JSON.stringify({ edit: { oldText: 'return user.name;', newText } }), text);
    assert.deepEqual(result, { start: 21, end: 38, oldText: 'return user.name;', newText });
  }
  const fenced = '```json\n' + JSON.stringify({ edit: { oldText: 'return user.name;', newText: '' } }) + '\n```\n';
  assert.deepEqual(parseNextEdit(fenced, text), { start: 21, end: 38, oldText: 'return user.name;', newText: '' });
});

test('NES reports why ambiguous, invalid, extra, unchanged and excessive edits are rejected', () => {
  const window = 'same same\nunique';
  const edit = (oldText, newText) => JSON.stringify({ edit: { oldText, newText } });
  const cases = [
    ['', 'empty'],
    ['{', 'invalid-json'],
    ['{"edit":null}', 'null'],
    ['```json\n{"edit":null}\n```', 'null'],
    ['Sure:\n```json\n{"edit":null}\n```', 'invalid-json'],
    [edit('same', 'other'), 'anchor-ambiguous'],
    [edit('', 'other'), 'invalid-shape'],
    [edit('missing', 'other'), 'anchor-missing'],
    [edit('unique', 'unique'), 'unchanged'],
    [JSON.stringify({ edit: { oldText: 'unique', newText: 'other', command: 'bad' } }), 'invalid-shape'],
    [edit('unique', 'x'.repeat(8001)), 'too-large'],
    [edit('unique', '\n'.repeat(64)), 'too-large'],
    [JSON.stringify({ edit: [{ oldText: 'unique', newText: 'other' }] }), 'invalid-shape'],
    [JSON.stringify({ edit: null, extra: true }), 'invalid-shape']
  ];
  for (const [raw, reason] of cases) assert.equal(parseNextEdit(raw, window), reason, raw.slice(0, 100));
});

test('history groups contiguous typing into whole-line edits and keeps separate edits apart', () => {
  const history = new EditHistory();
  let text = 'function name() {}\nconst value = name();\n';
  const type = change => {
    const before = text;
    text = before.slice(0, change.rangeOffset) + change.text + before.slice(change.rangeOffset + change.rangeLength);
    history.record(before, text, [change], 100);
  };
  type({ rangeOffset: 9, rangeLength: 4, text: 'd' });
  [...'isplayName'].forEach((char, index) => type({ rangeOffset: 10 + index, rangeLength: 0, text: char }));
  assert.deepEqual(history.get(100), [{ line: 1, before: 'function name() {}', after: 'function displayName() {}' }]);
  const plural = text.indexOf('value') + 5;
  type({ rangeOffset: plural, rangeLength: 0, text: 's' });
  assert.deepEqual(history.get(100)[1], { line: 2, before: 'const value = name();', after: 'const values = name();' });
  type({ rangeOffset: plural, rangeLength: 1, text: '' });
  assert.equal(history.get(100).length, 1, 'an edit undone by typing disappears');
  const deleted = new EditHistory();
  deleted.record('a(x, y)', 'a(x, )', [{ rangeOffset: 5, rangeLength: 1, text: '' }], 100);
  deleted.record('a(x, )', 'a(x,)', [{ rangeOffset: 4, rangeLength: 1, text: '' }], 100);
  deleted.record('a(x,)', 'a(x)', [{ rangeOffset: 3, rangeLength: 1, text: '' }], 100);
  assert.deepEqual(deleted.get(100), [{ line: 1, before: 'a(x, y)', after: 'a(x)' }]);
});

test('history interprets multiple changes against the previous snapshot and expires', () => {
  const history = new EditHistory();
  history.record('abc def', 'ABC DEF', [
    { rangeOffset: 0, rangeLength: 3, text: 'ABC' },
    { rangeOffset: 4, rangeLength: 3, text: 'DEF' }
  ], 100);
  assert.deepEqual(history.get(100).map(edit => edit.after), ['ABC def', 'abc DEF']);
  assert.equal(history.get(60101).length, 0);
  const lines = 'a\n'.repeat(40);
  for (let index = 0; index < 20; index++) {
    const offset = index * 4;
    history.record(lines, lines.slice(0, offset) + 'b' + lines.slice(offset + 1), [{ rangeOffset: offset, rangeLength: 1, text: 'b' }], 60200);
  }
  assert.equal(history.get(60200).length, 16);
  history.record('a', 'invalid', [{ rangeOffset: 0, rangeLength: 1, text: 'b' }], 60300);
  assert.equal(history.get(60300).length, 0);
  const long = 'x'.repeat(7000);
  history.record('', long, [{ rangeOffset: 0, rangeLength: 0, text: long }]);
  assert.deepEqual(history.get(), [{ line: 1, before: '', after: long }], 'large edits are kept whole');
  const wide = `${'a'.repeat(500)}b${'c'.repeat(500)}`;
  const changed = new EditHistory();
  changed.record(wide, wide.replace('b', 'B'), [{ rangeOffset: 500, rangeLength: 1, text: 'B' }]);
  assert.equal(changed.get()[0].before, wide, 'the whole changed line is sent');
});

test('NES sends the whole document with line-based cursor and cannot invent edit history', () => {
  assert.equal(buildNextEditRequest('typescript', 'file.ts', 'x', 0, []), undefined);
  const history = [{ line: 1, before: 'x', after: 'y' }];
  const text = ('"\\\t'.repeat(500) + '\n').repeat(50);
  assert.equal(buildNextEditRequest('typescript', 'file.ts', text, 0, history).document, text);
  const small = buildNextEditRequest('typescript', 'file.ts', 'a\nbc\nd', 4, history);
  assert.deepEqual(small, { languageId: 'typescript', fileName: 'file.ts', cursor: { line: 2, column: 3 }, document: 'a\nbc\nd', recentEdits: history });
});

test('URL validation rejects unsafe or malformed values and warns about likely mistakes', () => {
  assert.deepEqual(checkBaseUrl('http://127.0.0.1:39575'), {});
  assert.deepEqual(checkBaseUrl(' https://proxy.example.com/ '), {});
  assert.deepEqual(checkBaseUrl('http://localhost:8317'), {});
  for (const value of ['', '127.0.0.1:8317', 'ftp://host', 'file:///etc/passwd', 'javascript:alert(1)',
    'http://user:secret@host', 'http://host/?key=1', 'http://host/#x']) {
    assert.ok(checkBaseUrl(value).error, value);
  }
  assert.match(checkBaseUrl('http://127.0.0.1:8317/v1').warning, /\/v1/);
  assert.match(checkBaseUrl('http://10.0.0.5:8317').warning, /unencrypted/);
  assert.equal(checkBaseUrl('http://user:secret@host').error.includes('secret'), false);
});

test('NES has a separate contract and model, no output limit; errors never contain backend content', async () => {
  const server = await startServer((entry, response) => {
    if (entry.body.model === 'failure') {
      response.writeHead(500);
      response.end('secret echoed prompt');
    } else if (entry.body.model === 'long') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"edit":' } }] }));
    } else reply(response, '{"edit":null}');
  });
  try {
    const config = { baseUrl: server.baseUrl, model: 'fixture', temperature: 0.1, apiKey: 'test-token' };
    assert.deepEqual(await fetchNextEdit(config, { window: { text: 'data' } }, new AbortController().signal),
      { content: '{"edit":null}', truncated: false });
    assert.equal('max_tokens' in server.requests[0].body, false);
    assert.equal(server.requests[0].body.model, 'fixture');
    assert.equal(server.requests[0].headers.authorization, 'Bearer test-token');
    assert.equal(server.requests[0].body.response_format, undefined);
    await fetchNextEdit({ ...config, reasoningEffort: 'high', nextEditsModel: 'nes', nextEditsReasoningEffort: 'low' },
      {}, new AbortController().signal);
    assert.equal(server.requests[1].body.model, 'nes');
    assert.equal(server.requests[1].body.reasoning_effort, 'low');
    assert.deepEqual(await fetchNextEdit({ ...config, nextEditsModel: 'long' }, {}, new AbortController().signal),
      { content: '', truncated: true });
    await assert.rejects(fetchNextEdit({ ...config, model: 'failure' }, {}, new AbortController().signal), error => {
      assert.equal(safeErrorMessage(error), 'CLIProxyApi returned HTTP 500');
      return true;
    });
    assert.ok(!safeErrorMessage(new Error('secret')).includes('secret'));
  } finally { await server.close(); }
});

test('transport discards truncated responses and aborts an in-flight request', async () => {
  let responseStarted;
  const started = new Promise(resolve => { responseStarted = resolve; });
  const server = await startServer((entry, response) => {
    if (entry.body.model === 'slow') {
      responseStarted();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'truncated' } }] }));
  });
  try {
    const config = { baseUrl: server.baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.1, apiKey: '', systemPrompt: '' };
    const request = { languageId: 'typescript', fileName: 'fixture.ts', prefix: '', suffix: '' };
    assert.equal(await fetchCompletion(config, request, new AbortController().signal), '');
    const controller = new AbortController();
    const result = fetchCompletion({ ...config, model: 'slow' }, request, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(result, error => error.name === 'AbortError');
  } finally { await server.close(); }
});

test('context preserves surrogate pairs and treats an initial newline correctly', () => {
  const text = '\nalpha\nemoji: \u{1f600}\nlast';
  assert.equal(contextWindow(text, 0, 1).text, '\n');
  const window = contextWindow(text, 12, 20);
  assert.ok(window.text.includes('\u{1f600}'));
  assert.equal(window.text.includes('\ufffd'), false);
  const crlf = 'first\r\nsecond\r\nthird';
  const crlfWindow = contextWindow(crlf, 8, 10);
  assert.equal(crlfWindow.text, 'second\r\n');
});