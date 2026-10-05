export function codexCommand(executable = 'codex', platform = process.platform) {
  if (platform !== 'darwin') throw new Error('Route2 supports macOS and Codex only.');
  return { executable, args: [] };
}
