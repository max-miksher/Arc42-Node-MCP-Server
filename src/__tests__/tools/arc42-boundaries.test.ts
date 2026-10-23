import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestContext } from '../fixtures/test-helpers.js';
import { arc42InitHandler } from '../../tools/arc42-init.js';
import { handleToolCall, TOOL_REGISTRY } from '../../tools/index.js';
import { DEFAULT_SECTIONS, markdown } from '../../product-workspace.js';
import { getTemplateForFormat, SUPPORTED_LANGUAGE_CODES } from '../../templates/index.js';
import type { ToolContext } from '../../types.js';

describe('arc42 responsibility boundary', () => {
  let context: ToolContext;
  let cleanup: () => void;
  beforeEach(async () => {
    ({ context, cleanup } = createTestContext());
    expect((await arc42InitHandler({ projectName: 'Boundary', profile: 'product' }, context)).success).toBe(true);
  });
  afterEach(() => cleanup());
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await handleToolCall(name, args, context);
    return JSON.parse(response.content[0].text);
  }
  function put(path: string, content: string) {
    const absolute = join(context.projectPath, 'docs', path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }

  it('initializes every arc42 section and no requirements or plans', () => {
    for (const path of Object.values(DEFAULT_SECTIONS)) expect(existsSync(join(context.projectPath, 'docs', path)), path).toBe(true);
    for (const category of ['requirements', 'plans', 'adr', 'tutorials']) expect(existsSync(join(context.projectPath, 'docs', category))).toBe(false);
  });

  it('does not publish a migration planning tool', () => {
    expect(TOOL_REGISTRY.map(tool => tool.name)).not.toContain('arc42-migration-plan');
    expect(TOOL_REGISTRY.map(tool => tool.name)).toContain('arc42-recover');
  });

  it('rejects creation and editing of external artifacts even inside section 9', async () => {
    for (const type of ['adr', 'requirement', 'plan', 'c4', 'tutorial', 'reference']) {
      const path = `architecture/09-architecture-decisions/${type}.md`;
      const content = `---\ntitle: External\ntype: ${type}\nstatus: draft\nupdated: 2026-10-23\n---\n\n# External\n`;
      expect((await call('arc42-document', { action: 'create', path, content })).success, type).toBe(false);
      expect(existsSync(join(context.projectPath, 'docs', path))).toBe(false);
      put(path, content);
      const before = readFileSync(join(context.projectPath, 'docs', path), 'utf8');
      const read = await call('arc42-document', { action: 'read', path });
      expect(read.success, type).toBe(false);
      expect(readFileSync(join(context.projectPath, 'docs', path), 'utf8')).toBe(before);
    }
  });

  it('checks links to external ADRs and requirements without validating their schemas', async () => {
    put('adr/decision.md', '# Storage\n\nExternal format without frontmatter.');
    put('requirements/request.md', '# Request\n\nSeparate owner.');
    const path = DEFAULT_SECTIONS['09_architecture_decisions'];
    put(path, markdown('Decisions', 'architecture', '# Decisions\n\n[Storage](../../adr/decision.md#storage)\n\n[Request](../../requirements/request.md#request)'));
    const checked = await call('arc42-validate');
    expect(checked.success, JSON.stringify(checked.data?.issues)).toBe(true);
    expect(checked.data.issues.some((issue: any) => issue.path.startsWith('adr/') || issue.path.startsWith('requirements/'))).toBe(false);
    put(path, markdown('Decisions', 'architecture', '# Decisions\n\n[Missing](../../adr/missing.md)'));
    expect((await call('arc42-validate')).data.valid).toBe(false);
  });

  it('creates explicitly owned arc42 subsections but rejects generic docs', async () => {
    expect((await call('arc42-document', { action: 'create', path: 'architecture/03-context-and-scope/interfaces/http.md', content: markdown('HTTP', 'architecture', '# HTTP\n\nPublic interface.', { section: '03_context_and_scope' }) })).success).toBe(true);
    expect((await call('arc42-document', { action: 'create', path: 'plans/work.md', content: markdown('Work', 'architecture', '# Work') })).success).toBe(false);
  });
  it.each(SUPPORTED_LANGUAGE_CODES)('initializes and validates all arc42 sections in %s', async language => {
    const targetFolder = join(context.projectPath, language);
    expect((await arc42InitHandler({ projectName: 'Localized', profile: 'product', language, targetFolder }, context)).success).toBe(true);
    const checked = await call('arc42-validate', { targetFolder });
    expect(checked.success, JSON.stringify(checked.data?.issues)).toBe(true);
    expect(checked.data.checkedFiles).toBe(13);
  });

  it.each(SUPPORTED_LANGUAGE_CODES)('generates overviews and architecture diagrams without external artifact templates in %s', language => {
    for (const format of ['markdown', 'asciidoc'] as const) {
      const decisions = getTemplateForFormat('09_architecture_decisions', language, format);
      expect(decisions).toContain('ADR');
      expect(decisions).not.toMatch(/ADR-00\d|decision_status|Deciders|Context and Problem Statement/);
      expect(getTemplateForFormat('01_introduction_and_goals', language, format)).not.toMatch(/REQ-\d/);
      for (const section of ['03_context_and_scope', '05_building_block_view', '07_deployment_view'] as const) {
        expect(getTemplateForFormat(section, language, format)).not.toContain('C4_');
      }
    }
  });

});
