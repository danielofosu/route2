import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function menuBarExecutable(environment = process.env) {
  const codexHome = environment.CODEX_HOME ?? join(homedir(), '.codex');
  const app = environment.ROUTE2_MENU_BAR_APP ?? join(codexHome, 'Route2 Menu.app');
  return join(app, 'Contents', 'MacOS', 'Route2Menu');
}

const probe = executable => new Promise(resolve => {
  execFile('/usr/bin/pgrep', ['-f', executable], error => resolve(!error));
});

const launch = executable => {
  spawn(executable, [], { detached: true, stdio: 'ignore' }).unref();
};

const terminate = executable => {
  execFile('/usr/bin/pkill', ['-f', executable], () => {});
};

export function startMenuBarSupervisor({ executable, log = () => {}, intervalMs = 5000,
  exists = existsSync, isRunning = probe, start = launch, stop = terminate } = {}) {
  let stopped = false;
  let ticking = false;
  let lastEvent;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      let event;
      if (!exists(executable)) event = 'absent';
      else if (await isRunning(executable)) event = 'running';
      else {
        event = 'launch';
        start(executable);
      }
      if (event !== lastEvent) {
        lastEvent = event;
        log({ event, executable });
      }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (exists(executable)) {
        log({ event: 'terminate', executable });
        stop(executable);
      }
    },
  };
}
