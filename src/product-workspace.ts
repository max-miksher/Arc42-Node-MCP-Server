/** Dogma fork: opt-in Markdown profile; upstream workspaces retain their contract. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { documentIssues } from './product-validation.js';
import { ARC42_SECTIONS, type Arc42Section, type ToolContext, type ToolResponse, countWords } from './types.js';
import { getSectionMetadata, getTemplateForFormat, getArc42ReferenceConfig, isLanguageCode } from './templates/index.js';

export const CONFIG_FILE = '.arc42.yaml';
export const DEFAULT_SECTIONS: Record<Arc42Section, string> = {
  '01_introduction_and_goals': 'architecture/01-introduction-and-goals.md',
  '02_architecture_constraints': 'architecture/02-architecture-constraints.md',
  '03_context_and_scope': 'architecture/03-context-and-scope/README.md',
  '04_solution_strategy': 'architecture/04-solution-strategy.md',
  '05_building_block_view': 'architecture/05-building-block-view/README.md',
  '06_runtime_view': 'architecture/06-runtime-view/README.md',
  '07_deployment_view': 'architecture/07-deployment-view/README.md',
  '08_concepts': 'architecture/08-crosscutting-concepts/README.md',
  '09_architecture_decisions': 'architecture/09-architecture-decisions/README.md',
  '10_quality_requirements': 'architecture/10-quality-requirements.md',
  '11_technical_risks': 'architecture/11-risks-and-technical-debt.md',
  '12_glossary': 'architecture/12-glossary.md',
};
export const DOCUMENT_TYPES = ['architecture', 'adr', 'requirement', 'how-to', 'reference', 'tutorial', 'explanation', 'note', 'plan', 'index', 'policy'] as const;
export const DOCUMENT_STATUSES = ['draft', 'active', 'deprecated', 'superseded'] as const;
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected a real calendar date');
export const metadataSchema = z.object({
  title: z.string().trim().min(1), type: z.enum(DOCUMENT_TYPES),
  status: z.enum(DOCUMENT_STATUSES), updated: dateSchema,
  superseded_by: z.string().min(1).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.status === 'superseded' && !value.superseded_by) {
    ctx.addIssue({ code: 'custom', message: 'superseded requires superseded_by' });
  }
});
const configSchema = z.object({
  version: z.literal(1), profile: z.literal('product'), projectName: z.string().trim().min(1),
  docsDir: z.string().min(1), language: z.string().refine(isLanguageCode),
  sections: z.record(z.string()),
  requiredSections: z.array(z.enum(ARC42_SECTIONS as unknown as [Arc42Section, ...Arc42Section[]])),
  arc42: z.record(z.unknown()),
}).strict();
export type ProductConfig = z.infer<typeof configSchema>;
export interface ProductWorkspace { projectPath: string; root: string; config: ProductConfig }

export function projectRoot(context: ToolContext, targetFolder?: unknown): string {
  if (targetFolder !== undefined && (typeof targetFolder !== 'string' || !isAbsolute(targetFolder))) {
    throw new Error('targetFolder must be an absolute project path');
  }
  return resolve(typeof targetFolder === 'string' ? targetFolder : context.projectPath);
}

/** Reject lexical escapes AND symlink components, including dangling symlinks. */
export function safePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error('Expected a relative path');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part === '.git' || part === 'node_modules')) {
    throw new Error('Unsafe relative path: ' + path);
  }
  const absolute = resolve(root, ...parts);
  const inside = relative(resolve(root), absolute);
  if (inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('Path escapes project');
  // Validate the trust boundary itself, not only the path appended to it.
  for (let ancestor = resolve(root); ; ancestor = dirname(ancestor)) {
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Symlink root is not allowed: ' + ancestor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink paths are not allowed: ' + path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

function validateConfig(config: ProductConfig): void {
  const paths = ARC42_SECTIONS.map(section => {
    const path = config.sections[section];
    if (!path?.endsWith('.md')) throw new Error('Every section must map to a .md path: ' + section);
    safePath('/virtual-profile-root', path);
    if (path.split('/').some(part => ['vendor', 'dist', 'build', 'coverage', '.superpowers'].includes(part))) throw new Error('Section cannot be inside an ignored generated tree');
    return path;
  });
  if (Object.keys(config.sections).length !== ARC42_SECTIONS.length || new Set(paths).size !== paths.length) {
    throw new Error('Section mapping must contain exactly 12 unique paths');
  }
  const reserved = ['README.md', 'requirements', 'notes', 'plans', 'how-to', 'reference', 'tutorials', 'explanation'];
  for (const path of paths) {
    if (reserved.some(name => path === name || path.startsWith(name + '/')) || paths.some(other => path.startsWith(other + '/'))) {
      throw new Error('Overlapping or reserved section mapping: ' + path);
    }
  }
  if (!config.requiredSections.includes('05_building_block_view')) throw new Error('Level 1 building block view is required');
}

export function loadProduct(context: ToolContext, targetFolder?: unknown): ProductWorkspace | null {
  const projectPath = projectRoot(context, targetFolder);
  const configPath = safePath(projectPath, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  if (existsSync(join(projectPath, 'arc42-docs/config.yaml'))) throw new Error('Ambiguous workspace: both product and upstream configurations exist');
  const config = configSchema.parse(parse(readFileSync(configPath, 'utf8')));
  validateConfig(config);
  const root = safePath(projectPath, config.docsDir);
  return { projectPath, root, config };
}

export function requireProduct(context: ToolContext, targetFolder?: unknown): ProductWorkspace {
  const workspace = loadProduct(context, targetFolder);
  if (!workspace) throw new Error('Product workspace not initialized. Run arc42-init with profile: product.');
  return workspace;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
export function today(): string { return new Date().toISOString().slice(0, 10); }
export function markdown(title: string, type: typeof DOCUMENT_TYPES[number], body: string, extra: Record<string, unknown> = {}): string {
  return '---\n' + stringify({ title, type, status: 'draft', updated: today(), ...extra }) + '---\n\n' + body.trim() + '\n';
}
export function parseDocument(content: string): { metadata: z.infer<typeof metadataSchema>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('Markdown must start with YAML frontmatter');
  return { metadata: metadataSchema.parse(parse(match[1], { maxAliasCount: 20 })), body: content.slice(match[0].length) };
}
export function readDocument(workspace: ProductWorkspace, path: string) {
  const raw = readRawDocument(workspace, path);
  return { ...raw, metadata: parseDocument(raw.content).metadata };
}

/** Raw reads allow repairing legacy/broken metadata through the same CAS path. */
export function readRawDocument(workspace: ProductWorkspace, path: string) {
  const absolute = safePath(workspace.root, path);
  if (!path.endsWith('.md')) throw new Error('Expected a .md document');
  const content = readFileSync(absolute, 'utf8');
  let metadata: z.infer<typeof metadataSchema> | null = null;
  let metadataError: string | null = null;
  try { metadata = parseDocument(content).metadata; } catch (error) { metadataError = String(error); }
  return { path: absolute, relativePath: path, content, sha256: sha256(content), metadata, metadataError, wordCount: countWords(content) };
}

/** Cooperative lock across server processes. A crash leaves a lock for manual review. */
function acquireProjectLock(projectPath: string): () => void {
  const lock = safePath(projectPath, '.arc42.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Workspace locked. Retry after current operation; inspect .arc42.lock after a crash.');
    throw error;
  }
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created: new Date().toISOString() })); }
  catch (error) { closeSync(descriptor); unlinkSync(lock); throw error; }
  return () => { closeSync(descriptor); unlinkSync(lock); };
}

export function withProjectLock<T>(projectPath: string, action: () => T): T {
  const release = acquireProjectLock(projectPath);
  try { return action(); } finally { release(); }
}

export async function withProjectLockAsync<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
  const release = acquireProjectLock(projectPath);
  try { return await action(); } finally { release(); }
}

export function writeDocument(workspace: ProductWorkspace, path: string, content: string, expectedHash?: string): void {
  parseDocument(content);
  withProjectLock(workspace.projectPath, () => {
    const errors = documentIssues(workspace, path, content).filter(issue => issue.severity === 'error');
    if (errors.length) throw new Error(errors.map(issue => issue.code + ': ' + issue.message).join('\n'));
    const absolute = safePath(workspace.root, path);
    if (!path.endsWith('.md')) throw new Error('Expected a .md document');
    const exists = existsSync(absolute);
    if (exists && (!expectedHash || sha256(readFileSync(absolute)) !== expectedHash)) throw new Error('Version conflict: read document again and supply its current expectedHash');
    if (!exists && expectedHash) throw new Error('Version conflict: document no longer exists');
    mkdirSync(dirname(absolute), { recursive: true });
    const temporary = absolute + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: exists ? statSync(absolute).mode : 0o644 });
      // Recheck after writing the temporary file; external editors need not honor our lock.
      if (exists && sha256(readFileSync(absolute)) !== expectedHash) throw new Error('Version conflict during write');
      if (!exists && existsSync(absolute)) throw new Error('Document already exists');
      renameSync(temporary, absolute);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  });
}

export function initializeProduct(args: Record<string, unknown>, context: ToolContext): ToolResponse {
  const projectPath = projectRoot(context, args.targetFolder);
  if (args.force) throw new Error('force is not supported by product profile; existing documents must be preserved');
  if (args.format && args.format !== 'markdown' && args.format !== 'md') throw new Error('Product profile requires Markdown');
  const overrides = z.record(z.enum(ARC42_SECTIONS as unknown as [Arc42Section, ...Arc42Section[]]), z.string()).parse(args.sections ?? {});
  const docsDir = z.string().parse(args.docsDir ?? 'docs');
  if (docsDir.split('/').some(part => ['.arc42.yaml', '.arc42.lock', 'arc42-docs', 'vendor', 'dist', 'build', 'coverage', '.superpowers'].includes(part))) throw new Error('docsDir collides with service files or generated trees');
  const config = configSchema.parse({
    version: 1, profile: 'product', projectName: args.projectName,
    docsDir, language: String(args.language ?? 'EN').toUpperCase(),
    sections: { ...DEFAULT_SECTIONS, ...overrides },
    requiredSections: args.scaffold === 'full' ? [...ARC42_SECTIONS] : ['05_building_block_view'],
    arc42: getArc42ReferenceConfig(),
  });
  validateConfig(config);
  const root = safePath(projectPath, docsDir);
  const configPath = safePath(projectPath, CONFIG_FILE);
  if (existsSync(root) || existsSync(configPath) || existsSync(join(projectPath, 'arc42-docs'))) {
    throw new Error('Workspace already exists; use arc42-status and arc42-inventory. Initialization never overwrites or migrates existing docs.');
  }
  const requirement = `requirements/${today()}-initialize-architecture/описание.md`;
  const documents = new Map<string, string>();
  documents.set(requirement, markdown('Инициализация архитектурной документации', 'requirement', '# Требование\n\nСоздать и вести архитектурную документацию проекта ' + config.projectName + ' по arc42 с локальным профилем. Существующие материалы мигрировать только отдельными согласованными изменениями.'));
  for (const section of config.requiredSections) {
    const title = getSectionMetadata(section, config.language).title;
    const body = args.scaffold === 'full' ? getTemplateForFormat(section, config.language, 'markdown') : '# ' + title + '\n\nLevel 1: архитектурные границы и ответственности необходимо уточнить по коду и требованиям.';
    documents.set(config.sections[section], markdown(title, 'architecture', body));
  }
  const links = [...documents.keys()].map(path => `- [${path}](${encodeURI(path)})`).join('\n');
  documents.set('README.md', markdown(config.projectName + ' — документация', 'index', `# ${config.projectName}\n\n${links}\n\n[arc42](https://arc42.org/) — Gernot Starke, Peter Hruschka; шаблоны [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Локальная раскладка и метаданные изменены.\n\nЧерновики требуют проверки; наличие файлов не доказывает полноту или истинность архитектуры.`));
  for (const path of documents.keys()) safePath(root, path);
  mkdirSync(projectPath, { recursive: true });
  return withProjectLock(projectPath, () => {
    if (existsSync(root) || existsSync(configPath)) throw new Error('Workspace already exists');
    for (const [path, content] of documents) {
      const absolute = safePath(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, { flag: 'wx' });
    }
    // Publish configuration last; partial initialization remains visible and cannot be overwritten.
    writeFileSync(configPath, stringify(config), { flag: 'wx' });
    return { success: true, message: 'Product workspace initialized; no existing documentation migrated.', data: { workspaceRoot: root, profile: 'product', projectName: config.projectName, format: 'markdown', language: config.language, sectionsCreated: config.requiredSections.length, requirement, config }, nextSteps: ['Read the requirement and Level 1; create only documents needed now.', 'Run arc42-validate after edits.'] };
  });
}

export function productSection(workspace: ProductWorkspace, section: unknown) {
  if (!ARC42_SECTIONS.includes(section as Arc42Section)) throw new Error('Invalid arc42 section');
  return readDocument(workspace, workspace.config.sections[section as Arc42Section]);
}
export function productStatus(workspace: ProductWorkspace): ToolResponse {
  const sections = Object.fromEntries(ARC42_SECTIONS.map(section => {
    const path = workspace.config.sections[section];
    const absolute = safePath(workspace.root, path);
    if (!existsSync(absolute)) return [section, { exists: false, path, required: workspace.config.requiredSections.includes(section) }];
    const document = readDocument(workspace, path);
    return [section, { exists: true, path: absolute, wordCount: document.wordCount, status: document.metadata.status, required: workspace.config.requiredSections.includes(section) }];
  }));
  return { success: true, message: 'Product document status; content quality requires review.', data: { profile: 'product', initialized: true, projectName: workspace.config.projectName, workspaceRoot: workspace.root, language: { code: workspace.config.language }, format: { code: 'markdown' }, sections } };
}
