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

    // --- switch model flow ---
    assert($('aiSwitchModelBtn').style.display === 'inline-flex', 'Switch model button shown once AI enabled');
    $('aiSwitchModelBtn').click();
    assert(ev('aiSwitchingModel') === true, 'aiSwitchingModel flag set on click');
    assert($('aiEnableBlock').style.display === 'block', 'enable block reappears when switching');
    assert($('aiBrainDumpCard').style.display === 'none', 'brain dump card hidden while switching');
    assert($('aiModelSelect').value === 'fast', 'model select pre-filled with current model on switch');
    assert($('aiCancelSwitchBtn').style.display === 'inline-flex', 'Cancel button shown while switching');
    assert($('aiSwitchModelBtn').style.display === 'none', 'Switch model button hidden while its own picker is open');

    // cancel should revert cleanly, leaving the original model untouched
    $('aiCancelSwitchBtn').click();
    assert(ev('aiSwitchingModel') === false, 'aiSwitchingModel flag cleared on cancel');
    assert(ev("db.settings.aiModelKey") === 'fast', 'cancel does not change the active model');
    assert($('aiBrainDumpCard').style.display === 'block', 'brain dump card restored after cancel');

    // now actually switch, simulating a completed download of a different model without a real WebGPU device
    $('aiSwitchModelBtn').click();
    $('aiModelSelect').value = 'balanced';
    ev("db.settings.aiModelKey='balanced'; aiSwitchingModel=false");
    window.renderAssistant();
    assert(ev("db.settings.aiModelKey") === 'balanced', 'model key updated after switch');
    assert($('aiModelBadge').textContent.includes('1.5B'), 'badge reflects newly switched model');
    assert($('aiBrainDumpCard').style.display === 'block', 'brain dump card shown again after switch completes');
    assert($('aiEnableBlock').style.display === 'none', 'enable block hidden again after switch completes');

    // --- ensureAIEngine: verify the unload-old-model-before-switch logic is present ---
    // (ensureAIEngine dynamically imports the real WebLLM bundle, which isn't invokable in this
    // jsdom harness without a real WebGPU device, so this checks the guard logic statically.)
    const engineSrc = window.eval('ensureAIEngine.toString()');
    assert(engineSrc.includes('aiEngineModelKey!==modelKey'), 'ensureAIEngine checks for a model switch');
    assert(engineSrc.includes('.unload()'), 'ensureAIEngine calls unload() on the previous engine when switching');
  }

  dom.window.close();
}

(async () => {
  await run(false, 'no WebGPU (fallback / unsupported device)');
  await run(true, 'WebGPU present (simulated activation)');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
