import { resolve } from 'node:path';

export function hookCommand(node, script, directory, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('Route2 supports macOS and Codex only.');
  const quote = value => {
    const path = String(value);
    return `'${path.replaceAll("'", "'\\''")}'`;
  };
  return [node, script, '--event-dir', resolve(directory)].map(quote).join(' ');
}

// Definitions still require Codex's normal hook trust. The launcher never
// bypasses that review and does not register effort selection on PreToolUse.
export function hookOverrides(command) {
  const entry = `[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
  return ['-c', `hooks.PostToolUse=${entry}`, '-c', `hooks.UserPromptSubmit=${entry}`];
}
