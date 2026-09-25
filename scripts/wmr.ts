#!/usr/bin/env node
// Wikipedia Market Research CLI entry point. Runs directly on Node.js >= 24 (native TypeScript).
import { main } from '../src/cli/main.ts';

process.exitCode = await main(process.argv.slice(2));
