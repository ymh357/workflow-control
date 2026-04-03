import { loadEnv } from "../lib/env.js";
loadEnv();

import { runPreflight, printPreflightResults } from "../lib/preflight.js";

const { passed, results } = runPreflight();
printPreflightResults(results);

process.exit(passed ? 0 : 1);
