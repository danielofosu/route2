import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { menuBarExecutable, startMenuBarSupervisor } from '../scripts/menu_bar_supervisor.mjs';

const EXECUTABLE = '/fixture/Route2 Menu.app/Contents/MacOS/Route2Menu';
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

function fixture(overrides = {}, initial = {}) {
  const state = { events: [], launched: [], terminated: [], running: false, present: true, ...initial };
  const supervisor = startMenuBarSupervisor({
    executable: EXECUTABLE,
    intervalMs: 5,
    log: event => state.events.push(event.event),
    exists: () => state.present,
    isRunning: async () => state.running,
    start: () => { state.launched.push(EXECUTABLE); state.running = true; },
    stop: () => { state.terminated.push(EXECUTABLE); state.running = false; },
    ...overrides,
  });
  return { state, supervisor };
}

test('menuBarExecutable resolves the companion inside the Codex home by default', () => {
  assert.equal(menuBarExecutable({ CODEX_HOME: '/fixture/codex' }),
    join('/fixture/codex', 'Route2 Menu.app', 'Contents', 'MacOS', 'Route2Menu'));
  assert.equal(menuBarExecutable({ ROUTE2_MENU_BAR_APP: '/elsewhere/Route2 Menu.app' }),
    join('/elsewhere/Route2 Menu.app', 'Contents', 'MacOS', 'Route2Menu'));
});

test('supervisor launches the companion once and keeps it visible while the service runs', async () => {
  const { state, supervisor } = fixture();
  await settle();
  assert.deepEqual(state.launched, [EXECUTABLE]);
  assert.equal(state.events.at(-1), 'running');
  state.running = false;
  await settle();
  assert.deepEqual(state.launched, [EXECUTABLE, EXECUTABLE]);
  supervisor.stop();
  assert.deepEqual(state.terminated, [EXECUTABLE]);
});

test('supervisor waits for the companion to be installed and stops ticking after stop', async () => {
  const { state, supervisor } = fixture({}, { present: false });
  await settle();
  assert.deepEqual(state.launched, []);
  assert.equal(state.events.at(-1), 'absent');
  state.present = true;
  await settle();
  assert.deepEqual(state.launched, [EXECUTABLE]);
  supervisor.stop();
  const launches = state.launched.length;
  state.running = false;
  await settle();
  assert.equal(state.launched.length, launches);
});
