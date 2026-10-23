/**
 * MCP Protocol Contract Tests
 *
 * Spawns the BUILT server (dist/index.js) and drives it over stdio JSON-RPC,
 * asserting the contracts documented in .claude/skills/arc42-docs-mcp/SKILL.md:
 *
 * Modified in this fork: preserve upstream tools and test the product profile.
 * 1. tools/list exposes the 6 upstream tools plus product tools
 * 2. The "Starting Fresh" workflow works end-to-end with targetFolder
 * 3. Error paths return actionable recovery guidance
 *
 * The suite is skipped when dist/ has not been built yet (fresh clone) —
 * run `npm run build` first to include it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ToolResponse } from '../../types.js';
import { createTempDir } from '../fixtures/test-helpers.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: {
        properties?: Record<string, { enum?: string[]; default?: unknown }>;
        required?: string[];
      };
    }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

interface ToolCallResult {
  isError: boolean;
  protocolError?: { code: number; message: string };
  /** Parsed ToolResponse when the content text is JSON */
  payload?: ToolResponse;
  /** Raw content text (e.g., SDK validation errors are plain text) */
  rawText?: string;
}

/**
 * Minimal MCP client speaking JSON-RPC over the spawned server's stdio
 */
class McpTestClient {
  private child: ChildProcess;
  private buffer = '';
  private nextId = 0;
  private pending = new Map<number, (msg: JsonRpcResponse) => void>();

  constructor(workspaceArg: string) {
    // process.execPath guarantees the same Node version as the test runner
    this.child = spawn(process.execPath, [SERVER_ENTRY, workspaceArg], {
      stdio: ['pipe', 'pipe', 'ignore']
    });
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'contract-test', version: '0.0.0' }
    });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools(): Promise<NonNullable<NonNullable<JsonRpcResponse['result']>['tools']>> {
    const res = await this.request('tools/list', {});
    return res.result!.tools!;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) {
      return { isError: true, protocolError: res.error };
    }
    const text = res.result!.content![0].text;
    try {
      return { isError: res.result!.isError ?? false, payload: JSON.parse(text) as ToolResponse };
    } catch {
      return { isError: res.result!.isError ?? false, rawText: text };
    }
  }

  stop(): void {
    this.child.kill();
  }
}

describe.skipIf(!existsSync(SERVER_ENTRY))('MCP protocol contract (requires npm run build)', () => {
  let client: McpTestClient;
  let defaultWorkspace: { path: string; cleanup: () => void };
  let target: { path: string; cleanup: () => void };
  let uninitialized: { path: string; cleanup: () => void };

  beforeAll(async () => {
    defaultWorkspace = createTempDir('arc42-contract-default');
    target = createTempDir('arc42-contract-target');
    uninitialized = createTempDir('arc42-contract-void');
    client = new McpTestClient(defaultWorkspace.path);
    await client.initialize();
  }, 15000);

  afterAll(() => {
    client?.stop();
    defaultWorkspace?.cleanup();
    target?.cleanup();
    uninitialized?.cleanup();
  });

  describe('tools/list schema contract', () => {
    it('should preserve the 6 upstream tools and expose additive product tools', async () => {
      const tools = await client.listTools();
      const names = tools.map(t => t.name).sort();
      expect(names).toEqual(expect.arrayContaining([
        'arc42-init',
        'arc42-status',
        'arc42-workflow-guide',
        'generate-template',
        'get-section',
        'update-section'
      ]));
      expect(names).toContain('arc42-document');
      expect(names).toEqual(expect.arrayContaining(['arc42-validate', 'arc42-inventory', 'arc42-recover']));
    });

    it('should accept format aliases md/adoc in every format-bearing tool', async () => {
      const tools = await client.listTools();
      for (const name of ['arc42-workflow-guide', 'arc42-init', 'generate-template']) {
        const tool = tools.find(t => t.name === name)!;
        const formatEnum = tool.inputSchema?.properties?.format?.enum;
        expect(formatEnum, `${name} format enum`).toEqual(['markdown', 'asciidoc', 'md', 'adoc']);
      }
    });

    it('should declare asciidoc as the default format', async () => {
      const tools = await client.listTools();
      for (const name of ['arc42-workflow-guide', 'generate-template']) {
        const tool = tools.find(t => t.name === name)!;
        expect(tool.inputSchema?.properties?.format?.default, `${name} format default`).toBe('asciidoc');
      }
      // Init has a conditional runtime default: upstream=AsciiDoc, product=Markdown.
      expect(tools.find(t => t.name === 'arc42-init')!.inputSchema?.properties?.format?.default).toBeUndefined();
    });

    it('should declare replace as the default update-section mode', async () => {
      const tools = await client.listTools();
      const updateSection = tools.find(t => t.name === 'update-section')!;
      expect(updateSection.inputSchema?.properties?.mode?.default).toBe('replace');
      expect(updateSection.inputSchema?.properties?.mode?.enum).toEqual(['replace', 'append']);
    });

    it('should warn about replace and describe append mode in the update-section description', async () => {
      const tools = await client.listTools();
      const updateSection = tools.find(t => t.name === 'update-section')!;
      expect(updateSection.description).toContain('append');
      expect(updateSection.description).toContain('OVERWRITES');
    });
  });

  describe('"Starting Fresh" workflow with targetFolder', () => {
    it('step 1: arc42-workflow-guide normalizes the md alias to markdown', async () => {
      const { isError, payload } = await client.callTool('arc42-workflow-guide', { format: 'md' });
      expect(isError).toBe(false);
      expect(payload!.success).toBe(true);
      expect(payload!.data.format).toBe('markdown');
      expect(payload!.data.guide.length).toBeGreaterThan(100);
      expect(payload!.data.availableLanguages).toHaveLength(11);
      expect(payload!.nextSteps!.length).toBeGreaterThan(0);
    });

    it('step 2: arc42-init with adoc alias creates the documented structure', async () => {
      const { isError, payload } = await client.callTool('arc42-init', {
        projectName: 'Contract Test Project',
        format: 'adoc',
        targetFolder: target.path
      });
      expect(isError).toBe(false);
      expect(payload!.success).toBe(true);
      expect(payload!.data.sectionsCreated).toBe(12);
      expect(payload!.data.workspaceRoot).toBe(join(target.path, 'arc42-docs'));

      // config carries the arc42 template reference (SKILL.md "Returns" contract)
      const config = payload!.data.config;
      expect(config.arc42_template_version).toBeTruthy();
      expect(config.arc42_template_date).toBeTruthy();
      expect(config.arc42_template_commit).toBeTruthy();

      // created files match the SKILL.md structure tree for AsciiDoc
      const workspaceRoot = join(target.path, 'arc42-docs');
      expect(existsSync(join(workspaceRoot, 'README.adoc'))).toBe(true);
      expect(existsSync(join(workspaceRoot, 'arc42-documentation.adoc'))).toBe(true);
      expect(existsSync(join(workspaceRoot, 'config.yaml'))).toBe(true);
      expect(existsSync(join(workspaceRoot, 'images'))).toBe(true);
      const sectionFiles = readdirSync(join(workspaceRoot, 'sections')).filter(f => f.endsWith('.adoc'));
      expect(sectionFiles).toHaveLength(12);
    });

    it('step 3: arc42-status reports initialized state, language, and format', async () => {
      const { isError, payload } = await client.callTool('arc42-status', { targetFolder: target.path });
      expect(isError).toBe(false);
      const data = payload!.data;
      expect(data.projectName).toBe('Contract Test Project');
      expect(data.initialized).toBe(true);
      expect(data.language.code).toBe('EN');
      expect(data.format.code).toBe('asciidoc');
      expect(data.arc42TemplateReference.version).toBeTruthy();
      const section01 = data.sections['01_introduction_and_goals'];
      expect(section01.exists).toBe(true);
      expect(typeof section01.completeness).toBe('number');
      expect(typeof data.overallCompleteness).toBe('number');
    });

    it('step 4: generate-template returns the section template with metadata', async () => {
      const { isError, payload } = await client.callTool('generate-template', {
        section: '09_architecture_decisions',
        format: 'adoc'
      });
      expect(isError).toBe(false);
      expect(payload!.data.template.length).toBeGreaterThan(50);
      expect(payload!.data.metadata.order).toBe(9);
      expect(payload!.data.fileExtension).toBe('.adoc');
    });

    it('step 5: update-section applies the replace default when mode is omitted', async () => {
      const { isError, payload } = await client.callTool('update-section', {
        section: '09_architecture_decisions',
        content: '== Architecture Decisions\n\n=== Storage decision overview\n\n*Status:* Accepted',
        targetFolder: target.path
      });
      expect(isError).toBe(false);
      expect(payload!.data.mode).toBe('replace');
      expect(payload!.data.format).toBe('asciidoc');
      expect(payload!.data.wordCount).toBeGreaterThan(0);
      expect(payload!.data.path).toBeTruthy();
    });

    it('step 5b: append mode preserves existing decision overview entries', async () => {
      const { isError, payload } = await client.callTool('update-section', {
        section: '09_architecture_decisions',
        content: '=== Cache decision overview\n\n*Status:* Accepted',
        mode: 'append',
        targetFolder: target.path
      });
      expect(isError).toBe(false);
      expect(payload!.data.mode).toBe('append');
    });

    it('step 6: get-section returns both decision overviews with file metadata', async () => {
      const { isError, payload } = await client.callTool('get-section', {
        section: '09_architecture_decisions',
        targetFolder: target.path
      });
      expect(isError).toBe(false);
      expect(payload!.data.content).toContain('Storage decision overview');
      expect(payload!.data.content).toContain('Cache decision overview');
      const metadata = payload!.data.metadata;
      expect(metadata.path).toBeTruthy();
      expect(metadata.lastModified).toBeTruthy();
      expect(metadata.wordCount).toBeGreaterThan(0);
      expect(metadata.size).toBeGreaterThan(0);
    });
  });

  describe('error paths give actionable recovery guidance', () => {
    it('re-init without force mentions arc42-status and warns force OVERWRITES', async () => {
      const { isError, payload } = await client.callTool('arc42-init', {
        projectName: 'Contract Test Project',
        targetFolder: target.path
      });
      expect(isError).toBe(true);
      expect(payload!.success).toBe(false);
      expect(payload!.message).toContain('already exists');
      expect(payload!.message).toContain('arc42-status');
      expect(payload!.message).toContain('OVERWRITES');
    });

    it('status on an uninitialized folder points to arc42-init', async () => {
      const { isError, payload } = await client.callTool('arc42-status', {
        targetFolder: uninitialized.path
      });
      expect(isError).toBe(true);
      expect(payload!.message).toContain('arc42-init');
    });

    it('get-section on a missing section file names both expected extensions', async () => {
      rmSync(join(target.path, 'arc42-docs', 'sections', '12_glossary.adoc'));
      const { isError, payload } = await client.callTool('get-section', {
        section: '12_glossary',
        targetFolder: target.path
      });
      expect(isError).toBe(true);
      expect(payload!.message).toContain('12_glossary.adoc');
      expect(payload!.message).toContain('12_glossary.md');
      expect(payload!.message).toContain('arc42-status');
      expect(payload!.message).toContain('update-section');
    });

    it('rejects an invalid format value through schema validation', async () => {
      const result = await client.callTool('generate-template', {
        section: '01_introduction_and_goals',
        format: 'docx'
      });
      const rejected = result.protocolError !== undefined ||
        (result.isError && /validation/i.test(result.rawText ?? ''));
      expect(rejected).toBe(true);
    });
  });

  it('supports a product workspace through the built stdio server with safe patching and arc42-only validation', async () => {
    const product = createTempDir('arc42-product-protocol');
    try {
      const initialized = await client.callTool('arc42-init', {
        projectName: 'Product protocol', profile: 'product', language: 'RU',
        targetFolder: product.path
      });
      expect(initialized.isError).toBe(false);
      expect(initialized.payload!.data.format).toBe('markdown');
      const get = await client.callTool('get-section', { section: '05_building_block_view', targetFolder: product.path });
      expect(get.isError).toBe(false);
      const oldText = get.payload!.data.content;
      const edit = await client.callTool('arc42-document', {
        action: 'edit', path: 'architecture/05-building-block-view/README.md',
        expectedHash: get.payload!.data.sha256, oldText,
        newText: oldText + '\nImplementation remains to be verified.\n', targetFolder: product.path
      });
      expect(edit.isError).toBe(false);
      const stale = await client.callTool('arc42-document', {
        action: 'edit', path: 'architecture/05-building-block-view/README.md',
        expectedHash: get.payload!.data.sha256, oldText, newText: oldText, targetFolder: product.path
      });
      expect(stale.isError).toBe(true);
      expect(stale.payload!.message).toContain('Version conflict');
      const validated = await client.callTool('arc42-validate', { targetFolder: product.path });
      expect(validated.isError).toBe(false);
      expect(validated.payload!.data.valid).toBe(true);
      const inventory = await client.callTool('arc42-inventory', { targetFolder: product.path });
      expect(inventory.isError).toBe(false);
      expect(inventory.payload!.data.files.length).toBeGreaterThanOrEqual(3);
      expect(inventory.payload!.data.truncated).toBe(false);
      const legacy = '# Architecture\n\nAPI calls storage.';
      writeFileSync(join(product.path, 'legacy.md'), legacy);
      const recovered = await client.callTool('arc42-recover', { source: 'legacy.md', section: '03_context_and_scope', maxChars: 8, targetFolder: product.path });
      expect(recovered.isError).toBe(false);
      expect(recovered.payload!.data.excerpt).toBe(legacy.slice(0, 8));
      expect(recovered.payload!.data.truncated).toBe(true);
      expect(readFileSync(join(product.path, 'legacy.md'), 'utf8')).toBe(legacy);
      const forbidden = await client.callTool('arc42-document', { action: 'create', path: 'plans/task.md', content: '# Plan', targetFolder: product.path });
      expect(forbidden.isError).toBe(true);
      const wrongArgs = await client.callTool('arc42-document', { action: 'edit', path: 'x.md', expectedHash: 'wrong', targetFolder: product.path });
      expect(wrongArgs.isError || wrongArgs.protocolError).toBeTruthy();
    } finally { product.cleanup(); }
  });
});
