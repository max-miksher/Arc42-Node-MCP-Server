import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createTestContext } from '../fixtures/test-helpers.js';
import type { ToolContext } from '../../types.js';
import { arc42InitHandler } from '../../tools/arc42-init.js';
import { handleToolCall } from '../../tools/index.js';
import { markdown, today, DEFAULT_SECTIONS } from '../../product-workspace.js';

describe('arc42 validation and incremental recovery', () => {
  let context: ToolContext;
  let cleanup: () => void;
  const blocks = 'architecture/05-building-block-view';
  const child = 'architecture/03-context-and-scope/interfaces.md';
  const owned = { section: '03_context_and_scope' };
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
    expect((await arc42InitHandler({ projectName: 'Test', profile: 'product' }, context)).success).toBe(true);
  });
  afterEach(() => cleanup());

  it('validates the full scaffold without pretending drafts are complete', async () => {
    const result = await call('arc42-validate');
    expect(result.data.valid).toBe(true);
    expect(result.data.checkedFiles).toBe(13);
    expect(result.data.issues.some((issue: any) => issue.code === 'draft')).toBe(true);
  });

  it('validates malformed owned subsections, dates and uppercase Markdown', async () => {
    put(child, markdown('Date', 'architecture', '# Date', owned).replace(today(), '2026-02-30'));
    put('architecture/03-context-and-scope/UPPER.MD', markdown('Upper', 'architecture', '# Upper', owned).replace('status: draft', 'status: invalid'));
    const result = await call('arc42-validate');
    expect(result.data.issues.filter((issue: any) => issue.code === 'metadata')).toHaveLength(2);
  });

  it('checks inline/reference links, images, encoded paths, fragments and ignores code examples', async () => {
    put('requirements/требование.md', '# Требование');
    put(child, markdown('Связи', 'architecture', '# Связи\n\n[req](../../requirements/%D1%82%D1%80%D0%B5%D0%B1%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5.md#требование)\n\n[bad][ref]\n\n[ref]: missing.md\n\n![img](missing.png)\n\n[anchor](#absent)\n\n`[example](ignore.md)`\n\n```md\n[example](also-ignore.md)\n```', owned));
    const result = await call('arc42-validate');
    const links = result.data.issues.filter((issue: any) => issue.code === 'link');
    expect(links).toHaveLength(3);
    expect(links.map((issue: any) => issue.message).join(' ')).not.toContain('ignore.md');
  });

  it('resolves headings with inline markup, HTML entities and colliding suffixes', async () => {
    put(child, markdown('Anchors', 'architecture', '# [API](https://example.org)\n\n## API-1\n\n## API\n\n## **API** &amp; `CLI`\n\n## &eacute;tage\n\n[One](#api) [Two](#api-1) [Three](#api-2) [Four](#api--cli) [Five](#étage)', owned));
    expect(await codes()).not.toContain('link');
  });

  it('checks arc42 superseded chains and inactive arc42 references', async () => {
    const other = child.replace('interfaces', 'previous');
    put(child, markdown('A', 'architecture', '# A', { ...owned, status: 'superseded', superseded_by: other }));
    put(other, markdown('B', 'architecture', '# B', { ...owned, status: 'superseded', superseded_by: child }));
    expect(await codes()).toContain('superseded-cycle');
    put(other, markdown('B', 'architecture', '# B', { ...owned, status: 'active', related: [child] }));
    expect(await codes()).toContain('inactive-reference');
  });

  it('supports nested building blocks without arbitrary decomposition triggers', async () => {
    const parent = `${blocks}/building-blocks/api/README.md`;
    const nested = `${blocks}/building-blocks/api/building-blocks/store/README.md`;
    put(parent, markdown('API', 'architecture', '# API\n\nHTTP interface.', { kind: 'building-block', parent: `${blocks}/README.md` }));
    put(nested, markdown('Store', 'architecture', '# Store\n\nPersistence.', { kind: 'building-block', parent }));
    put('architecture/06-runtime-view/scenarios/save.md', markdown('Save', 'architecture', '# Save\n\nAPI calls Store.', { kind: 'runtime-scenario', blocks: [parent, nested] }));
    expect((await call('arc42-validate')).data.valid).toBe(true);
    put('architecture/06-runtime-view/scenarios/bad.md', markdown('Bad', 'architecture', '# Bad', { kind: 'runtime-scenario', blocks: [`${blocks}/README.md`] }));
    expect(await codes()).toContain('runtime-block');
  });

  it('rejects a missing or wrong parent before writing a nested block', async () => {
    const path = `${blocks}/building-blocks/missing/building-blocks/child/README.md`;
    const result = await call('arc42-document', { action: 'create', path, content: markdown('Child', 'architecture', '# Child', { kind: 'building-block', parent: child }) });
    expect(result.success).toBe(false);
    expect(existsSync(join(context.projectPath, 'docs', path))).toBe(false);
  });

  it('inventories legacy read-only, identifies byte duplicates and reports limits and symlinks', async () => {
    mkdirSync(join(context.projectPath, 'old'));
    writeFileSync(join(context.projectPath, 'old/ARCH.md'), '# Architecture\n\nExisting content');
    writeFileSync(join(context.projectPath, 'old/copy.md'), '# Architecture\n\nExisting content');
    symlinkSync(context.projectPath, join(context.projectPath, 'old/link'));
    const result = await call('arc42-inventory', { roots: ['old'] });
    expect(result.data.files).toHaveLength(2);
    expect(result.data.duplicates).toHaveLength(1);
    expect(result.data.warnings).toContainEqual(expect.objectContaining({ code: 'symlink' }));
    expect(result.data.files.every((file: any) => file.metadataError === null && file.architectureCandidate)).toBe(true);
    expect((await call('arc42-inventory', { roots: ['old'], maxFiles: 1 })).data.truncated).toBe(true);
  });

  it('hashes original bytes without conflating different non-UTF8 sources', async () => {
    mkdirSync(join(context.projectPath, 'encoded'));
    writeFileSync(join(context.projectPath, 'encoded/one.txt'), Buffer.from([0xff]));
    writeFileSync(join(context.projectPath, 'encoded/two.txt'), Buffer.from([0xfe]));
    const result = await call('arc42-inventory', { roots: ['encoded'] });
    expect(result.data.duplicates).toHaveLength(0);
    expect(result.data.files.every((file: any) => file.bytes === 1 && file.encoding === 'unknown')).toBe(true);
    expect((await call('arc42-recover', { source: 'encoded/one.txt', section: '03_context_and_scope' })).success).toBe(false);
  });

  it('reads selected legacy architectural evidence in bounded pages and leaves sources untouched', async () => {
    mkdirSync(join(context.projectPath, 'old'));
    const source = '= Architecture\n\nAPI calls storage.';
    writeFileSync(join(context.projectPath, 'old/ARCH.adoc'), source);
    const first = await call('arc42-recover', { source: 'old/ARCH.adoc', section: '03_context_and_scope', maxChars: 10 });
    expect(first.success).toBe(true);
    expect(first.data.excerpt).toBe(source.slice(0, 10));
    expect(first.data.truncated).toBe(true);
    expect(first.data.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.data.targetHash).toMatch(/^[a-f0-9]{64}$/);
    const next = await call('arc42-recover', { source: 'old/ARCH.adoc', section: '03_context_and_scope', offset: first.data.nextOffset });
    expect(first.data.excerpt + next.data.excerpt).toBe(source);
    expect(next.data.nextOffset).toBeNull();
    expect(readFileSync(join(context.projectPath, 'old/ARCH.adoc'), 'utf8')).toBe(source);
    expect((await call('arc42-recover', { source: '../escape.md', section: '03_context_and_scope' })).success).toBe(false);
  });

  it('does not accept a directory in place of an arc42 section or index', async () => {
    for (const path of ['README.md', `${blocks}/README.md`]) {
      unlinkSync(join(context.projectPath, 'docs', path));
      mkdirSync(join(context.projectPath, 'docs', path));
    }
    const result = await call('arc42-validate');
    expect(result.data.valid).toBe(false);
    expect(result.data.issues.some((issue: any) => ['required-section', 'index'].includes(issue.code))).toBe(true);
  });

  it('supports custom roots, flat mapped sections and conventional runtime pages', async () => {
    const configPath = join(context.projectPath, '.arc42.yaml');
    const config = parse(readFileSync(configPath, 'utf8'));
    config.sections['05_building_block_view'] = 'design/components/index.md';
    config.sections['06_runtime_view'] = 'runtime.md';
    writeFileSync(configPath, stringify(config));
    put('design/components/index.md', markdown('Level 1', 'architecture', '# Level 1'));
    put('runtime.md', markdown('Runtime', 'architecture', '# Runtime'));
    const blockPath = 'design/components/building-blocks/api/README.md';
    expect((await call('arc42-document', { action: 'create', path: blockPath, content: markdown('API', 'architecture', '# API', { kind: 'building-block', parent: config.sections['05_building_block_view'] }) })).success).toBe(true);
    expect((await call('arc42-document', { action: 'create', path: 'scenarios/http.md', content: markdown('HTTP', 'architecture', '# HTTP', { kind: 'runtime-scenario', blocks: [blockPath] }) })).success).toBe(true);
  });

  it('checks HTML links and inactive arc42 targets without treating code examples as links', async () => {
    put(child, markdown('Retired', 'architecture', '# Retired', { ...owned, status: 'deprecated' }));
    put(child.replace('interfaces', 'current'), markdown('Current', 'architecture', '# Current\n\n[Old](interfaces.md)\n\n<a href="missing.md">Missing</a>\n\n`<a href="ignore.md">Example</a>`', { ...owned, status: 'active' }));
    const result = await call('arc42-validate');
    expect(result.data.issues.filter((issue: any) => issue.code === 'link')).toHaveLength(1);
    expect(result.data.issues.filter((issue: any) => issue.code === 'inactive-reference')).toHaveLength(1);
  });

  it('reports incomplete scans rather than a false successful validation', async () => {
    const result = await call('arc42-validate', { maxFiles: 1 });
    expect(result.data.truncated).toBe(true);
    expect(result.success).toBe(false);
  });

  it('reports missing required sections and rejects non-UTF8 arc42 edits without data loss', async () => {
    unlinkSync(join(context.projectPath, 'docs', DEFAULT_SECTIONS['12_glossary']));
    const file = join(context.projectPath, 'docs', DEFAULT_SECTIONS['01_introduction_and_goals']);
    const bytes = Buffer.from([0xff]);
    writeFileSync(file, bytes);
    const result = await call('arc42-validate');
    expect(result.data.issues.map((issue: any) => issue.code)).toEqual(expect.arrayContaining(['required-section', 'encoding']));
    expect((await call('arc42-document', { action: 'read', path: DEFAULT_SECTIONS['01_introduction_and_goals'] })).success).toBe(false);
    expect(readFileSync(file)).toEqual(bytes);
  });
  it('creates a new subsection with a self anchor before its file exists', async () => {
    const result = await call('arc42-document', { action: 'create', path: child, content: markdown('New', 'architecture', '# New\n\n[Jump](#new)', owned) });
    expect(result.success, result.message).toBe(true);
  });

  it('reports malformed YAML in an explicitly owned child and lists unassigned documents', async () => {
    put(child, markdown('Child', 'architecture', '# Child', owned).replace('title: Child', 'title: [Child'));
    put('adr/legacy.md', '# External decision');
    const result = await call('arc42-validate');
    expect(result.data.valid).toBe(false);
    expect(result.data.issues).toContainEqual(expect.objectContaining({ path: child, code: 'metadata' }));
    expect(result.data.unassignedFiles).toContain('adr/legacy.md');
  });

  it('can recover evidence when a mapped section is not yet present in an older workspace', async () => {
    const configPath = join(context.projectPath, '.arc42.yaml');
    const config = parse(readFileSync(configPath, 'utf8'));
    config.requiredSections = ['05_building_block_view'];
    writeFileSync(configPath, stringify(config));
    unlinkSync(join(context.projectPath, 'docs', DEFAULT_SECTIONS['03_context_and_scope']));
    writeFileSync(join(context.projectPath, 'old.md'), '# Architecture');
    const result = await call('arc42-recover', { source: 'old.md', section: '03_context_and_scope' });
    expect(result.success).toBe(true);
    expect(result.data.targetExists).toBe(false);
    expect(result.data.targetHash).toBeNull();
    expect(result.data.excerpt).toBe('# Architecture');
  });

});
