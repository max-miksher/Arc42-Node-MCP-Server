import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestContext } from '../fixtures/test-helpers.js';
import type { ToolContext } from '../../types.js';
import { arc42InitHandler } from '../../tools/arc42-init.js';
import { handleToolCall } from '../../tools/index.js';
import { markdown, today } from '../../product-workspace.js';

describe('product validation and gradual migration', () => {
  let context: ToolContext;
  let cleanup: () => void;
  let requirement: string;
  const blocks = 'architecture/05-building-block-view';
  const adr = 'architecture/09-architecture-decisions/ADR-0001-storage.md';
  function put(path: string, content: string) {
    const absolute = join(context.projectPath, 'docs', path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await handleToolCall(name, args, context);
    return JSON.parse(response.content[0].text);
  }
  async function codes() {
    const result = await call('arc42-validate');
    expect(result.data).toBeDefined();
    return result.data.issues.map((issue: any) => issue.code);
  }
  beforeEach(async () => {
    ({ context, cleanup } = createTestContext());
    const result = await arc42InitHandler({ projectName: 'Test', profile: 'product' }, context);
    requirement = result.data.requirement;
  });
  afterEach(() => cleanup());

  it('validates a minimal project without pretending drafts are complete', async () => {
    const result = await call('arc42-validate');
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(true);
    expect(result.data.issues.some((issue: any) => issue.code === 'draft')).toBe(true);
    expect(result.data.limits).toBeDefined();
  });

  it('checks mandatory metadata, real dates, unknown types, and Markdown outside architecture', async () => {
    put('notes/bad.md', '# Missing metadata');
    put('reference/date.md', markdown('Date', 'reference', '# Date').replace(today(), '2026-02-30'));
    expect(await codes()).toEqual(expect.arrayContaining(['metadata']));
    const validation = await call('arc42-validate');
    expect(validation.data.valid).toBe(false);
    expect(validation.data.issues.filter((issue: any) => issue.code === 'metadata')).toHaveLength(2);
  });

  it('checks inline/reference links, images, encoded Russian paths, fragments and ignores code examples', async () => {
    put('notes/связи.md', markdown('Связи', 'note', `# Связи\n\n[req](../${encodeURI(requirement)}#требование)\n\n[bad][ref]\n\n[ref]: missing.md\n\n![img](missing.png)\n\n[anchor](#absent)\n\n\`[example](ignore.md)\`\n\n\`\`\`md\n[example](also-ignore.md)\n\`\`\``));
    const result = await call('arc42-validate');
    const links = result.data.issues.filter((issue: any) => issue.code === 'link');
    expect(links).toHaveLength(3);
    expect(links.map((issue: any) => issue.message).join(' ')).not.toContain('ignore.md');
  });

  it('checks superseded chains, missing targets and cycles', async () => {
    put('notes/a.md', markdown('A', 'note', '# A', { status: 'superseded', superseded_by: 'notes/b.md' }));
    put('notes/b.md', markdown('B', 'note', '# B', { status: 'superseded', superseded_by: 'notes/a.md' }));
    expect(await codes()).toContain('superseded-cycle');
    put('notes/b.md', markdown('B', 'note', '# B', { status: 'active', related: ['notes/a.md'] }));
    expect(await codes()).toContain('inactive-reference');
  });

  it('enforces separate MADR structure and distinct document/decision statuses', async () => {
    put(adr, markdown('Storage', 'adr', '# Storage\n\n## Context and Problem Statement\n\nPersist state.\n\n## Considered Options\n\n- Files\n- Database\n\n## Decision Outcome\n\nChosen option: Files, because it meets our needs.', { date: today(), decision_status: 'accepted', 'decision-makers': ['Bondar Maksim'] }));
    expect((await codes()).includes('madr')).toBe(false);
    put(adr, markdown('Storage', 'adr', '# Storage\n\n## Context\n\nIncomplete.', { decision_status: 'unknown' }));
    expect(await codes()).toContain('madr');
  });

  it('checks nested blocks, evidence, parent role, and runtime participants', async () => {
    const parent = `${blocks}/building-blocks/api/README.md`;
    const child = `${blocks}/building-blocks/api/building-blocks/store/README.md`;
    put(parent, markdown('API', 'architecture', '# API\n\nHTTP interface.', { kind: 'building-block', parent: `${blocks}/README.md` }));
    put(child, markdown('Store', 'architecture', '# Store\n\nPersistence.', { kind: 'building-block', parent }));
    expect(await codes()).toContain('decomposition');
    put(child, markdown('Store', 'architecture', '# Store\n\nPersistence.', { kind: 'building-block', parent, decomposition: { trigger: 2, evidence: [requirement] } }));
    put('architecture/06-runtime-view/scenarios/save.md', markdown('Save', 'architecture', '# Save\n\nAPI calls Store.', { kind: 'runtime-scenario', blocks: [parent, child] }));
    expect((await codes()).includes('decomposition')).toBe(false);
    expect((await codes()).includes('runtime-block')).toBe(false);
    put('architecture/06-runtime-view/scenarios/bad.md', markdown('Bad', 'architecture', '# Bad', { kind: 'runtime-scenario', blocks: [requirement] }));
    expect(await codes()).toContain('runtime-block');
  });

  it('rejects unsafe semantic creation before touching the filesystem', async () => {
    const path = `${blocks}/building-blocks/missing/building-blocks/child/README.md`;
    const result = await call('arc42-document', { action: 'create', path, content: markdown('Child', 'architecture', '# Child', { kind: 'building-block', parent: 'notes/unknown.md' }) });
    expect(result.success).toBe(false);
    expect(existsSync(join(context.projectPath, 'docs', path))).toBe(false);
  });

  it('inventories legacy read-only, identifies exact duplicates and reports limits/symlinks', async () => {
    mkdirSync(join(context.projectPath, 'old'));
    writeFileSync(join(context.projectPath, 'old/ARCH.md'), '# Architecture\n\nExisting content');
    writeFileSync(join(context.projectPath, 'old/copy.md'), '# Architecture\n\nExisting content');
    symlinkSync(context.projectPath, join(context.projectPath, 'old/link'));
    const result = await call('arc42-inventory', { roots: ['old'] });
    expect(result.success).toBe(true);
    expect(result.data.files).toHaveLength(2);
    expect(result.data.duplicates).toHaveLength(1);
    expect(result.data.warnings).toContainEqual(expect.objectContaining({ code: 'symlink' }));
    expect(readFileSync(join(context.projectPath, 'old/ARCH.md'), 'utf8')).toBe('# Architecture\n\nExisting content');
    const limited = await call('arc42-inventory', { roots: ['old'], maxFiles: 1 });
    expect(limited.data.truncated).toBe(true);
  });

  it('plans only explicit sources in the scope of an actual requirement without copying anything', async () => {
    mkdirSync(join(context.projectPath, 'old'));
    writeFileSync(join(context.projectPath, 'old/ARCH.md'), '# Architecture\n\nOriginal');
    const target = 'architecture/03-context-and-scope/README.md';
    const before = readFileSync(join(context.projectPath, 'old/ARCH.md'), 'utf8');
    const result = await call('arc42-migration-plan', { requirement, items: [{ source: 'old/ARCH.md', target, reason: 'Describes the boundary affected by this requirement' }] });
    expect(result.success).toBe(true);
    expect(result.data.items[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.items[0].action).toBe('create');
    expect(existsSync(join(context.projectPath, 'docs', target))).toBe(false);
    expect(readFileSync(join(context.projectPath, 'old/ARCH.md'), 'utf8')).toBe(before);
    expect((await call('arc42-migration-plan', { requirement: `${blocks}/README.md`, items: [{ source: 'old/ARCH.md', target, reason: 'Scope' }] })).success).toBe(false);
  });

  it('does not accept a directory in place of the required section or docs index', async () => {
    for (const path of ['README.md', `${blocks}/README.md`]) {
      unlinkSync(join(context.projectPath, 'docs', path));
      mkdirSync(join(context.projectPath, 'docs', path));
    }
    const result = await call('arc42-validate');
    expect(result.data.valid).toBe(false);
    expect(result.data.issues.some((issue: any) => ['required-section', 'index'].includes(issue.code))).toBe(true);
  });

  it('supports non-README section roots and flat ADR/runtime roots', async () => {
    const configPath = join(context.projectPath, '.arc42.yaml');
    const { parse, stringify } = await import('yaml');
    const config = parse(readFileSync(configPath, 'utf8'));
    config.sections['05_building_block_view'] = 'design/components/index.md';
    config.sections['09_architecture_decisions'] = 'decisions.md';
    config.sections['06_runtime_view'] = 'runtime.md';
    writeFileSync(configPath, stringify(config));
    put('design/components/index.md', markdown('Level 1', 'architecture', '# Level 1'));
    const blockPath = 'design/components/building-blocks/api/README.md';
    expect((await call('arc42-document', { action: 'create', path: blockPath, content: markdown('API', 'architecture', '# API\n\nHTTP API.', { kind: 'building-block', parent: config.sections['05_building_block_view'] }) })).success).toBe(true);
    expect((await call('arc42-document', { action: 'create', path: 'scenarios/http.md', content: markdown('HTTP', 'architecture', '# HTTP\n\nAPI processes a request.', { kind: 'runtime-scenario', blocks: [blockPath] }) })).success).toBe(true);
    expect((await call('arc42-document', { action: 'create', path: 'ADR-0001-api.md', content: markdown('API', 'adr', '# API\n\n## Context and Problem Statement\n\nNeed an API.\n\n## Considered Options\n\n- HTTP\n- RPC\n\n## Decision Outcome\n\nHTTP.', { date: today(), decision_status: 'proposed' }) })).success).toBe(true);
  });

  it('rejects treating the Level 1 system overview as a runtime participant', async () => {
    put('architecture/06-runtime-view/scenarios/root.md', markdown('Root', 'architecture', '# Root', { kind: 'runtime-scenario', blocks: [`${blocks}/README.md`] }));
    expect(await codes()).toContain('runtime-block');
  });

  it('requires review of decomposition evidence even after structural checks pass', async () => {
    const parent = `${blocks}/building-blocks/api/README.md`;
    put(parent, markdown('API', 'architecture', '# API', { kind: 'building-block', parent: `${blocks}/README.md` }));
    put(`${blocks}/building-blocks/api/building-blocks/store/README.md`, markdown('Store', 'architecture', '# Store', { kind: 'building-block', parent, decomposition: { trigger: 2, evidence: [requirement] } }));
    expect(await codes()).toContain('decomposition-review');
  });

  it('detects duplicate ADR numbers before creation', async () => {
    const content = markdown('Storage', 'adr', '# Storage\n\n## Context and Problem Statement\n\nPersistence.\n\n## Considered Options\n\n- Files\n- Database\n\n## Decision Outcome\n\nFiles.', { date: today(), decision_status: 'proposed' });
    expect((await call('arc42-document', { action: 'create', path: adr, content })).success).toBe(true);
    const second = await call('arc42-document', { action: 'create', path: adr.replace('storage', 'database'), content });
    expect(second.success).toBe(false);
    expect(second.message).toContain('adr-number');
  });

  it('checks HTML links and inactive Markdown targets without reading code examples', async () => {
    put('notes/retired.md', markdown('Retired', 'note', '# Retired', { status: 'deprecated' }));
    put('notes/current.md', markdown('Current', 'note', '# Current\n\n[Old](retired.md)\n\n<a href="missing.md">Missing</a>\n\n`<a href="ignore.md">Example</a>`', { status: 'active' }));
    const result = await call('arc42-validate');
    expect(result.data.issues.filter((issue: any) => issue.code === 'link')).toHaveLength(1);
    expect(result.data.issues.filter((issue: any) => issue.code === 'inactive-reference')).toHaveLength(1);
  });

  it('rejects empty accepted MADR sections and validates uppercase Markdown files', async () => {
    put(adr, markdown('Empty', 'adr', '# Empty\n\n## Context and Problem Statement\n\n## Considered Options\n\n## Decision Outcome', { status: 'active', decision_status: 'accepted', date: today() }));
    put('notes/UPPER.MD', '# Missing frontmatter');
    expect(await codes()).toContain('madr');
    expect(await codes()).toContain('metadata');
  });
});
