import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createTestContext } from '../fixtures/test-helpers.js';
import { arc42InitHandler } from '../../tools/arc42-init.js';
import { getSectionHandler } from '../../tools/get-section.js';
import { updateSectionHandler } from '../../tools/update-section.js';
import { arc42StatusHandler } from '../../tools/arc42-status.js';
import { handleToolCall } from '../../tools/index.js';
import type { ToolContext } from '../../types.js';

describe('product profile workspace', () => {
  let context: ToolContext;
  let cleanup: () => void;
  const section = '05_building_block_view';
  const blockPath = 'architecture/05-building-block-view/README.md';
  beforeEach(() => ({ context, cleanup } = createTestContext()));
  afterEach(() => cleanup());
  async function init(extra = {}) {
    return arc42InitHandler({ projectName: 'Проект: #42', profile: 'product', language: 'RU', ...extra }, context);
  }
  async function document(args: Record<string, unknown>) {
    const response = await handleToolCall('arc42-document', args, context);
    return JSON.parse(response.content[0].text);
  }

  it('initializes only useful documents, metadata and an actual requirement', async () => {
    const result = await init();
    expect(result.success).toBe(true);
    expect(existsSync(join(context.projectPath, '.arc42.yaml'))).toBe(true);
    expect(existsSync(context.workspaceRoot)).toBe(false);
    const config = parse(readFileSync(join(context.projectPath, '.arc42.yaml'), 'utf8'));
    expect(config.projectName).toBe('Проект: #42');
    const root = join(context.projectPath, 'docs');
    const content = readFileSync(join(root, blockPath), 'utf8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('type: architecture');
    expect(existsSync(join(root, 'notes'))).toBe(false);
    expect(existsSync(join(root, 'architecture/06-runtime-view/scenarios'))).toBe(false);
    expect(result.data.requirement).toMatch(/requirements\/\d{4}-\d{2}-\d{2}-[^/]+\/описание.md/);
    expect(readFileSync(join(root, result.data.requirement), 'utf8')).toContain('type: requirement');
  });

  it('supports a full scaffold, custom roots and section mapping through existing tools', async () => {
    expect((await init({ docsDir: 'manual', scaffold: 'full', sections: { [section]: 'design/components/index.md' } })).success).toBe(true);
    const read = await getSectionHandler({ section }, context);
    expect(read.success).toBe(true);
    expect(read.data.metadata.path).toBe(join(context.projectPath, 'manual/design/components/index.md'));
    expect(read.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    const status = await arc42StatusHandler({}, context);
    expect(status.data.profile).toBe('product');
    expect(Object.values(status.data.sections).every((value: any) => value.exists)).toBe(true);
  });

  it('rejects overlapping mappings, traversal, invalid format and force before writing', async () => {
    for (const extra of [
      { docsDir: '../outside' }, { docsDir: '.' },
      { sections: { [section]: '../outside.md' } },
      { sections: { [section]: 'architecture/12-glossary.md' } },
      { format: 'adoc' }, { force: true }
    ]) {
      expect((await init(extra)).success, JSON.stringify(extra)).toBe(false);
      expect(existsSync(join(context.projectPath, '.arc42.yaml'))).toBe(false);
    }
  });

  it('never overwrites existing docs on init or re-init', async () => {
    mkdirSync(join(context.projectPath, 'docs'));
    writeFileSync(join(context.projectPath, 'docs/README.md'), 'original');
    expect((await init()).success).toBe(false);
    expect(readFileSync(join(context.projectPath, 'docs/README.md'), 'utf8')).toBe('original');
    expect(existsSync(join(context.projectPath, '.arc42.yaml'))).toBe(false);
  });

  it('reads and edits an exact fragment with CAS; preserves unknown metadata', async () => {
    await init();
    const file = join(context.projectPath, 'docs', blockPath);
    writeFileSync(file, readFileSync(file, 'utf8').replace('type: architecture', 'type: architecture\nowner: Bondar Maksim') + '\nAlpha\nBeta\n');
    const before = await document({ action: 'read', path: blockPath });
    const edited = await document({ action: 'edit', path: blockPath, expectedHash: before.data.sha256, oldText: 'Alpha', newText: 'Gamma' });
    expect(edited.success).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('Gamma\nBeta');
    expect(readFileSync(file, 'utf8')).toContain('owner: Bondar Maksim');
    const stale = await document({ action: 'edit', path: blockPath, expectedHash: before.data.sha256, oldText: 'Beta', newText: 'lost' });
    expect(stale.success).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('Beta');
  });

  it('rejects ambiguous edits, metadata removal and hashless legacy replace in profile mode', async () => {
    await init();
    const before = await document({ action: 'read', path: blockPath });
    expect((await document({ action: 'edit', path: blockPath, expectedHash: before.data.sha256, oldText: '\n', newText: '' })).success).toBe(false);
    expect((await updateSectionHandler({ section, content: '# Lost' }, context)).success).toBe(false);
    expect((await document({ action: 'edit', path: blockPath, expectedHash: before.data.sha256, oldText: 'type: architecture', newText: 'type: invented' })).success).toBe(false);
    expect((await document({ action: 'read', path: blockPath })).data.sha256).toBe(before.data.sha256);
  });

  it('rejects symlinks, escaping paths and ambiguous configuration', async () => {
    await init();
    symlinkSync(context.projectPath, join(context.projectPath, 'docs/escape'));
    expect((await document({ action: 'read', path: 'escape/package.json' })).success).toBe(false);
    expect((await document({ action: 'read', path: '../.arc42.yaml' })).success).toBe(false);
    const configPath = join(context.projectPath, '.arc42.yaml');
    const config = parse(readFileSync(configPath, 'utf8'));
    config.sections[section] = '../outside.md';
    writeFileSync(configPath, stringify(config));
    expect((await getSectionHandler({ section }, context)).success).toBe(false);
  });

  it('prevents upstream init from making a product project ambiguous', async () => {
    await init();
    const result = await arc42InitHandler({ projectName: 'Other' }, context);
    expect(result.success).toBe(false);
    expect(existsSync(context.workspaceRoot)).toBe(false);
    expect((await getSectionHandler({ section }, context)).success).toBe(true);
  });

  it('serializes concurrent init across both profile modes', async () => {
    const pendingUpstream = arc42InitHandler({ projectName: 'Legacy' }, context);
    // Upstream is suspended on its first async filesystem call. The lock must
    // already be present before product init can observe any directory changes.
    expect(existsSync(join(context.projectPath, '.arc42.lock'))).toBe(true);
    const [upstream, product] = await Promise.all([pendingUpstream, init()]);
    expect([upstream, product].filter(result => result.success)).toHaveLength(1);
    expect(existsSync(context.workspaceRoot) && existsSync(join(context.projectPath, '.arc42.yaml'))).toBe(false);
    expect((await arc42StatusHandler({}, context)).success).toBe(true);
  });

  it('initializes a missing target project and rejects conflicting document roles', async () => {
    expect((await init({ sections: { [section]: 'notes/level1.md' } })).success).toBe(false);
    const targetFolder = join(context.projectPath, 'new-project');
    const created = await init({ targetFolder });
    expect(created.success).toBe(true);
    expect(existsSync(join(targetFolder, '.arc42.yaml'))).toBe(true);
  });

  it('rejects config/lock collisions and ignored destinations before initialization', async () => {
    for (const docsDir of ['.arc42.yaml', '.arc42.yaml/nested', '.arc42.lock', 'arc42-docs', 'vendor/docs']) {
      expect((await init({ docsDir })).success, docsDir).toBe(false);
      expect(existsSync(join(context.projectPath, '.arc42.yaml'))).toBe(false);
      expect(existsSync(join(context.projectPath, docsDir))).toBe(false);
    }
    expect((await init({ sections: { [section]: 'vendor/level1.md' } })).success).toBe(false);
  });

  it('rejects explicit AsciiDoc formats in a product project', async () => {
    expect((await init({ format: 'asciidoc' })).success).toBe(false);
    expect((await init({ format: 'adoc' })).success).toBe(false);
    expect(existsSync(join(context.projectPath, '.arc42.yaml'))).toBe(false);
  });

  it('rejects a symlink project root and leaves its real target unchanged', async () => {
    mkdirSync(join(context.projectPath, 'real'));
    symlinkSync(join(context.projectPath, 'real'), join(context.projectPath, 'alias'));
    expect((await init({ targetFolder: join(context.projectPath, 'alias') })).success).toBe(false);
    expect(existsSync(join(context.projectPath, 'real/.arc42.yaml'))).toBe(false);
  });

  it('accepts repairs of malformed Markdown with a versioned exact patch', async () => {
    await init();
    const file = join(context.projectPath, 'docs', blockPath);
    writeFileSync(file, '# Existing architecture\n\nKeep this content.');
    const before = await document({ action: 'read', path: blockPath });
    expect(before.success).toBe(true);
    expect(before.data.metadataError).toBeTruthy();
    const content = '---\ntitle: Existing\ntype: architecture\nstatus: draft\nupdated: 2026-10-23\n---\n\n' + before.data.content;
    const repaired = await document({ action: 'edit', path: blockPath, expectedHash: before.data.sha256, oldText: before.data.content, newText: content });
    expect(repaired.success).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('Keep this content.');
  });

  it('rejects concurrent updates rather than losing one', async () => {
    await init();
    const before = await document({ action: 'read', path: blockPath });
    const edits = await Promise.all(['A', 'B'].map(newText => document({ action: 'edit', path: blockPath, expectedHash: before.data.sha256, oldText: before.data.content.split('\n').find((line: string) => line.startsWith('# ')), newText: '# ' + newText })));
    expect(edits.filter(result => result.success)).toHaveLength(1);
  });
});
