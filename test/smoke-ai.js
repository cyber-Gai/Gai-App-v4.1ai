// Smoke test for the AI Assistant feature, following the project's existing jsdom pattern.
// Run with: node test/smoke-ai.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok  :', msg);
}

async function run(gpuPresent, label) {
  console.log(`\n--- scenario: ${label} ---`);
  const dom = new JSDOM(html, {
    url: 'https://example.com/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      // localStorage polyfill
      const store = {};
      window.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
      };
      if (gpuPresent) window.navigator.gpu = {}; // fake WebGPU presence
      // jsdom doesn't implement matchMedia; the app's dark-mode detection needs it
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    },
  });

  await new Promise(res => dom.window.addEventListener('load', res));
  const { window } = dom;
  const $ = id => window.document.getElementById(id);
  // `let`-declared script globals (db, pendingItems, ...) are NOT own-properties of `window`
  // (this matches real browser semantics, not a jsdom quirk) — reach them via eval instead.
  const ev = expr => window.eval(expr);

  assert(!!$('assistant'), 'Assistant page section exists');
  assert(!!window.document.querySelector('.navbtn[data-page="assistant"]'), 'Assistant nav button exists');
  assert(typeof window.aiSupported === 'function', 'aiSupported() is defined');
  assert(window.aiSupported() === gpuPresent, `aiSupported() reflects navigator.gpu presence (${gpuPresent})`);

  window.renderAssistant();
  if (!gpuPresent) {
    assert($('aiUnsupportedBlock').style.display === 'block', 'unsupported block shown when no WebGPU');
    assert($('aiEnableBlock').style.display === 'none', 'enable block hidden when no WebGPU');
    assert($('aiBrainDumpCard').style.display === 'none', 'brain dump card hidden when no WebGPU');
  } else {
    assert($('aiEnableBlock').style.display === 'block', 'enable block shown pre-activation');
    assert($('aiBrainDumpCard').style.display === 'none', 'brain dump card hidden before model enabled');

    // Simulate a completed model activation without a real WebGPU device
    ev("db.settings.aiModelKey='fast'");
    window.renderAssistant();
    assert($('aiBrainDumpCard').style.display === 'block', 'brain dump card shown once aiModelKey set');
    assert($('aiEnableBlock').style.display === 'none', 'enable block hidden once aiModelKey set');

    // --- brain dump schema sanity ---
    const schemaRoundTrip = JSON.parse(JSON.stringify(ev('BRAIN_DUMP_SCHEMA')));
    assert(schemaRoundTrip.required.includes('items'), 'brain dump schema requires items array');
    const prompt = window.brainDumpSystemPrompt();
    assert(prompt.includes('json') || prompt.includes('JSON'), 'system prompt instructs JSON-only output');

    // --- commit logic: simulate a model response and confirm it lands in db correctly ---
    const before = {
      tasks: ev('db.tasks.length'),
      goals: ev('db.goals.length'),
      thoughts: ev('db.thoughts.length'),
    };
    const fakeItems = [
      { type: 'task', title: 'Buy groceries', body: '', priority: 'High', due: '2026-09-10', deadline: '', tags: ['errand'] },
      { type: 'goal', title: 'Learn Twi', body: '', priority: 'Medium', due: '', deadline: '2026-12-31', tags: ['learning'] },
      { type: 'thought', title: 'App idea', body: 'Local-first grocery list', priority: 'Medium', due: '', deadline: '', tags: [] },
    ];
    ev(`pendingItems = ${JSON.stringify(fakeItems)}`);
    window.renderBrainDumpPreview();
    assert($('brainDumpPreview').innerHTML.length > 0, 'preview renders extracted items');
    assert(!!$('bdInc0') && !!$('bdInc1') && !!$('bdInc2'), 'each item gets an include checkbox');

    // uncheck the goal item to verify selective commit works
    $('bdInc1').checked = false;
    window.confirmBrainDump();

    assert(ev('db.tasks.length') === before.tasks + 1, 'checked task item was added');
    assert(ev('db.goals.length') === before.goals, 'unchecked goal item was NOT added');
    assert(ev('db.thoughts.length') === before.thoughts + 1, 'checked thought item was added');

    const newTask = ev('db.tasks[0]');
    assert(newTask.title === 'Buy groceries' && newTask.priority === 'High' && newTask.due === '2026-09-10', 'task fields carried through correctly');
    const newThought = ev('db.thoughts[0]');
    assert(newThought.body === 'Local-first grocery list', 'thought body carried through correctly');

    // persisted to localStorage via save()
    const persisted = JSON.parse(window.localStorage.getItem('myLifeOS_v1'));
    assert(persisted.tasks.some(t => t.title === 'Buy groceries'), 'brain dump commit persisted to localStorage');

    assert(ev('pendingItems.length') === 0, 'pendingItems cleared after confirm');
    assert($('brainDumpText').value === '', 'brain dump textarea cleared after confirm');
  }

  dom.window.close();
}

(async () => {
  await run(false, 'no WebGPU (fallback / unsupported device)');
  await run(true, 'WebGPU present (simulated activation)');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
