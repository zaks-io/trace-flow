/**
 * Generates traceflow_client.py from the real TOOL_DEFINITIONS for the Python
 * behavior tests, so the suite runs against exactly what ships to a Pi run.
 *
 * Usage: bun generate-client.mts <output-path>
 */
import { writeFileSync } from 'node:fs';
import { buildTraceflowPythonClient } from '../src/pythonClient';
import { getTraceFlowToolDefinitions } from '@trace-flow/mcp-core';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('usage: bun generate-client.mts <output-path>');
  process.exit(1);
}

const definitions = getTraceFlowToolDefinitions('analyst');
const source = buildTraceflowPythonClient(definitions);
writeFileSync(outputPath, source);
const methodCount = (source.match(/def \w+\(self/g) ?? []).length;
console.log(`Generated ${outputPath}: ${source.length} chars, ${methodCount} methods`);
