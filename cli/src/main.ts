import { text } from 'node:stream/consumers';
import { run } from './cli';

process.exitCode = await run(process.argv.slice(2), process.env, {
  stdout: (s) => console.log(s),
  stderr: (s) => console.error(s),
  stdin: () => text(process.stdin),
});
