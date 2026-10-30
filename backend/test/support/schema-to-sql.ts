/**
 * TEST FIXTURE GENERATOR: turns prisma/schema.prisma into PostgreSQL DDL so integration tests can build a
 * throw-away schema without running `prisma migrate`. It understands exactly the Prisma subset this project uses.
 * It is NOT the production migration: production uses `prisma migrate` (see README).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

interface Field { name: string; type: string; optional: boolean; list: boolean; attrs: string; }
interface Model { name: string; table: string; fields: Field[]; blockAttrs: string[]; }

const SCALAR_SQL: Record<string, string> = {
  String: 'TEXT', Int: 'INTEGER', Float: 'DOUBLE PRECISION', Boolean: 'BOOLEAN', DateTime: 'TIMESTAMP(3)', Json: 'JSONB', BigInt: 'BIGINT',
};

const q = (s: string) => `"${s}"`;
const argList = (s: string) => s.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/\(.*\)$/, '')).filter(Boolean);

export function schemaToSql(schemaPath = join(__dirname, '../../prisma/schema.prisma')): string {
  const src = readFileSync(schemaPath, 'utf8').replace(/\/\/.*$/gm, '');
  const enums = new Map<string, string[]>();
  const models: Model[] = [];

  for (const m of src.matchAll(/^(enum|model)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, kind, name, body] = m;
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    if (kind === 'enum') { enums.set(name, lines); continue; }
    const model: Model = { name, table: name, fields: [], blockAttrs: [] };
    for (const l of lines) {
      if (l.startsWith('@@')) {
        model.blockAttrs.push(l);
        const map = l.match(/^@@map\("(.+)"\)/);
        if (map) model.table = map[1];
        continue;
      }
      const f = l.match(/^(\w+)\s+(Unsupported\(\"[^\"]*\"\)|\w+)(\?|\[\])?\s*(.*)$/);
      if (f) model.fields.push({ name: f[1], type: f[2], optional: f[3] === '?', list: f[3] === '[]', attrs: f[4] });
    }
    models.push(model);
  }
  const byName = new Map(models.map((m) => [m.name, m]));
  const out: string[] = ['CREATE EXTENSION IF NOT EXISTS postgis;'];

  for (const [name, values] of enums) out.push(`CREATE TYPE ${q(name)} AS ENUM (${values.map((v) => `'${v}'`).join(', ')});`);

  const fks: string[] = [];
  const indexes: string[] = [];

  for (const m of models) {
    const cols: string[] = [];
    const pk: string[] = [];
    const uniques: string[][] = [];
    for (const f of m.fields) {
      if (byName.has(f.type) || f.list) continue; // relation field → no column
      const unsupported = f.type.match(/^Unsupported\("(.+)"\)$/);
      const enumType = enums.has(f.type);
      let sql = unsupported ? unsupported[1] : enumType ? q(f.type) : SCALAR_SQL[f.type];
      if (!sql) throw new Error(`Unsupported type ${f.type} on ${m.name}.${f.name}`);
      if (/@db\.Uuid/.test(f.attrs)) sql = 'UUID';
      const def = f.attrs.match(/@default\(((?:[^()]|\([^)]*\))*)\)/)?.[1];
      let defaultSql = '';
      if (def === 'autoincrement()') sql = f.type === 'BigInt' ? 'BIGSERIAL' : 'SERIAL';
      else if (def === 'now()') defaultSql = ' DEFAULT CURRENT_TIMESTAMP';
      else if (def && def !== 'uuid()' && !def.startsWith('dbgenerated')) {
        defaultSql = ` DEFAULT ${/^".*"$/.test(def) ? `'${def.slice(1, -1)}'` : enumType ? `'${def}'` : def}`;
      }
      cols.push(`  ${q(f.name)} ${sql}${f.optional || sql.endsWith('SERIAL') ? (f.optional ? '' : ' NOT NULL') : ' NOT NULL'}${defaultSql}`);
      if (/@id\b/.test(f.attrs)) pk.push(f.name);
      if (/@unique\b/.test(f.attrs)) uniques.push([f.name]);

    }
    for (const f of m.fields) {
      const rel = byName.has(f.type) && f.attrs.match(/@relation\(([^)]*(?:\[[^\]]*\][^)]*)*)\)/)?.[1];
      if (!rel || !/fields:/.test(rel)) continue;
      const from = argList(rel.match(/fields:\s*(\[[^\]]*\])/)![1]);
      const to = argList(rel.match(/references:\s*(\[[^\]]*\])/)![1]);
      const onDelete = rel.match(/onDelete:\s*(\w+)/)?.[1] ?? (f.optional ? 'SetNull' : 'Restrict');
      const action = { Cascade: 'CASCADE', Restrict: 'RESTRICT', SetNull: 'SET NULL', NoAction: 'NO ACTION' }[onDelete];
      fks.push(`ALTER TABLE ${q(m.table)} ADD CONSTRAINT ${q(`${m.table}_${from.join('_')}_fkey`)} FOREIGN KEY (${from.map(q).join(', ')}) REFERENCES ${q(byName.get(f.type)!.table)} (${to.map(q).join(', ')}) ON DELETE ${action} ON UPDATE CASCADE;`);
    }
    for (const b of m.blockAttrs) {
      const id = b.match(/^@@id\((\[[^\]]*\])/);
      if (id) pk.push(...argList(id[1]));
      const uq = b.match(/^@@unique\((\[[^\]]*\])/);
      if (uq) uniques.push(argList(uq[1]));
      const ix = b.match(/^@@index\((\[[^\]]*\])(?:,\s*(.*))?\)/);
      if (ix) {
        const fieldsSql = ix[1].replace(/^\[|\]$/g, '').split(/,(?![^(]*\))/).map((x) => {
          const mm = x.trim().match(/^(\w+)(?:\(sort:\s*(Desc|Asc)\))?$/);
          return `${q(mm![1])}${mm![2] === 'Desc' ? ' DESC' : ''}`;
        });
        const gist = /type:\s*Gist/.test(ix[2] ?? '');
        const colNames = argList(ix[1]).join('_');
        indexes.push(`CREATE INDEX ${q(`${m.table}_${colNames}_idx`)} ON ${q(m.table)}${gist ? ' USING GIST' : ''} (${fieldsSql.join(', ')});`);
      }
    }
    if (pk.length) cols.push(`  PRIMARY KEY (${pk.map(q).join(', ')})`);
    out.push(`CREATE TABLE ${q(m.table)} (\n${cols.join(',\n')}\n);`);
    for (const u of uniques) out.push(`CREATE UNIQUE INDEX ${q(`${m.table}_${u.join('_')}_key`)} ON ${q(m.table)} (${u.map(q).join(', ')});`);
  }
  return [...out, ...indexes, ...fks].join('\n');
}

if (require.main === module) process.stdout.write(schemaToSql() + '\n');
