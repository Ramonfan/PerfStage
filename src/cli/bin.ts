#!/usr/bin/env node
import { main } from "./index.js";

/**
 * Executable entry point.
 *
 * The shebang lives here (not in `index.ts`) so the library entry stays
 * importable by tests without executing anything.
 */
process.exitCode = await main(process.argv.slice(2));
