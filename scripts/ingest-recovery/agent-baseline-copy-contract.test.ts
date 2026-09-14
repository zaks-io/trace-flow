import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CATEGORIES, DATASOURCES, ROW_IDENTITY_FIELDS } from './agent-data';

describe('baseline Copy latest-row contracts', () => {
  test('all six copies select distinct full rows at the full-window ingestion maximum', () => {
    for (const category of CATEGORIES) {
      const source = DATASOURCES[category];
      const copy = readFileSync(`copies/repair_agent_${category}_versions_baseline.pipe`, 'utf8');
      const schema = readFileSync(`datasources/${source}.datasource`, 'utf8');
      const columns = [...schema.matchAll(/^\s+`([^`]+)`\s/gm)].map((match) => match[1]!);
      const selected = /AS IsDeleted,\n([\s\S]+?)\n    FROM/.exec(copy)?.[1];
      const hashed = /SHA256\(toJSONString\(tuple\(([^)]+)\)\)\)/.exec(copy)?.[1];
      const identity = ROW_IDENTITY_FIELDS[category];

      expect(columns.length).toBeGreaterThan(0);
      expect(copy).toContain('SELECT DISTINCT');
      expect([...(selected?.matchAll(/`([^`]+)`/g) ?? [])].map((match) => match[1])).toEqual(
        columns,
      );
      expect([...(hashed?.matchAll(/`([^`]+)`/g) ?? [])].map((match) => match[1])).toEqual(columns);
      expect(copy).toContain(`tuple(${identity.join(', ')}, IngestedAt) IN (`);
      expect(copy).toContain(`SELECT ${identity.join(', ')}, max(IngestedAt) AS IngestedAt`);
      expect(copy).toContain(`GROUP BY ${identity.join(', ')}`);
      expect(copy.match(/String\(org_id\)/g)).toHaveLength(2);
      expect(copy.match(/Date\(start_day\)/g)).toHaveLength(2);
      expect(copy.match(/Date\(end_day\)/g)).toHaveLength(2);
      expect(copy).toContain('AND {{ UInt64(copy_attempt) }} >= 1');
    }
  });
});
