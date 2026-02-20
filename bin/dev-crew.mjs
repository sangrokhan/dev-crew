#!/usr/bin/env node
import { runBinCommand } from '../scripts/bin/dispatch.mjs';

runBinCommand({ invokedPath: process.argv[1], argv: process.argv.slice(2) })
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
