import { spawnSync } from 'node:child_process';

const clis = [
  { name: 'claude', cmd: 'claude' },
  { name: 'codex', cmd: 'codex' },
  { name: 'agy', cmd: 'agy' },
  { name: 'grok', cmd: 'grok' },
  { name: 'vibe', cmd: 'vibe' },
  { name: 'devin', cmd: 'devin' },
  { name: 'cursor-agent', cmd: 'cursor-agent' }
];

for (const { name, cmd } of clis) {
  try {
    const result = spawnSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 5000 });
    console.log(`${name}: ${result.stdout?.trim() || result.stderr?.trim() || 'N/A'}`);
  } catch (e) {
    console.log(`${name}: ERROR - ${e.message}`);
  }
}
