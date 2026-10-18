#!/usr/bin/env node
// Runs the TypeScript sources directly, like the server does in dev.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
