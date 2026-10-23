/** Fork extension: structural checks; architectural truth still requires human review. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { marked, type Token } from 'marked';
import { z } from 'zod';
import {
  type ProductWorkspace, safePath, parseDocument, readDocument, sha256, dateSchema,
} from './product-workspace.js';

export interface Issue { code: string; path: string; message: string; severity: 'error' | 'warning' }
export interface ScanLimits { maxFiles: number; maxBytes: number; maxDepth: number }
export const DEFAULT_LIMITS: ScanLimits = { maxFiles: 5000, maxBytes: 2_000_000, maxDepth: 32 };
const IGNORED = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.superpowers']);
export interface ScanResult { paths: string[]; warnings: Issue[]; truncated: boolean; limits: ScanLimits }

export function scanDocuments(root: string, roots: string[], limits: ScanLimits = DEFAULT_LIMITS, ignoreGenerated = true): ScanResult {
  const result: ScanResult = { paths: [], warnings: [], truncated: false, limits };
  let visited = 0;
  function walk(absolute: string, depth: number): void {
    const path = relative(root, absolute).split('\\').join('/');
    if (++visited > limits.maxFiles || depth > limits.maxDepth) { result.truncated = true; return; }
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      result.warnings.push({ code: 'symlink', path, severity: 'warning', message: 'Symlink skipped' });
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        if (!ignoreGenerated || !IGNORED.has(entry)) walk(join(absolute, entry), depth + 1);
        if (visited > limits.maxFiles) break;
      }
    } else if (stats.isFile() && ['.md', '.adoc', '.txt'].includes(extname(path).toLowerCase())) {
      if (stats.size > limits.maxBytes) {
        result.truncated = true;
        result.warnings.push({ code: 'size-limit', path, severity: 'warning', message: 'Document exceeds maxBytes; skipped' });
      } else if (!result.paths.includes(path)) result.paths.push(path);
    }
  }
  for (const path of roots) walk(path === '.' ? root : safePath(root, path), 0);
  return result;
}

function tokens(body: string) { return marked.lexer(body); }
function anchors(body: string): Set<string> {
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  marked.walkTokens(tokens(body), (token: Token) => {
    if (token.type === 'heading') {
      const slug = token.text.replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      ids.add(slug + (count ? '-' + count : ''));
    } else if (token.type === 'html') {
      for (const match of token.raw.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
    }
  });
  return ids;
}

function resolveLocal(workspace: ProductWorkspace, path: string, href: string): { absolute: string; fragment: string } | null {
  if (/^(?:https?:|mailto:|tel:|data:)/i.test(href)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) throw new Error('Unsupported or absolute link: ' + href);
  const hash = href.indexOf('#');
  const fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
  const file = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0]);
  const absolute = resolve(dirname(safePath(workspace.root, path)), file || path.split('/').at(-1)!);
  const projectRelative = relative(workspace.projectPath, absolute).split('\\').join('/');
  return { absolute: safePath(workspace.projectPath, projectRelative), fragment };
}

export function documentIssues(workspace: ProductWorkspace, path: string, content: string): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, severity: Issue['severity'] = 'error') => issues.push({ code, path, message, severity });
  let document: ReturnType<typeof parseDocument>;
  try { document = parseDocument(content); }
  catch (error) { add('metadata', String(error)); return issues; }
  const { metadata, body } = document;
  const sequence = tokens(body);
  if (!body.trim() || !sequence.some(token => token.type === 'heading')) add('content', 'Document requires a heading and meaningful content');
  if (metadata.status === 'draft') add('draft', 'Draft requires content review; presence is not completeness', 'warning');
  if (metadata.updated > new Date().toISOString().slice(0, 10)) add('metadata', 'updated is in the future');

  function ref(target: unknown, code: string, role?: (doc: ReturnType<typeof readDocument>, path: string) => boolean) {
    try {
      if (typeof target !== 'string') throw new Error('Reference must be a docs-relative string');
      const referenced = target === path ? { ...parseDocument(content), relativePath: path, path, content, sha256: sha256(content), wordCount: 0, metadataError: null } : readDocument(workspace, target);
      if (role && !role(referenced, target)) throw new Error('Target has the wrong document role');
      if (metadata.status === 'active' && ['deprecated', 'superseded'].includes(referenced.metadata.status)) {
        add('inactive-reference', 'Active document refers to inactive source: ' + target, 'warning');
      }
    } catch (error) { add(code, `${String(target)}: ${String(error)}`); }
  }

  for (const field of ['related', 'requirements', 'blocks'] as const) {
    const value = metadata[field];
    if (value !== undefined) {
      if (!Array.isArray(value) || !value.length) add('metadata', `${field} must be a non-empty list of paths`);
      else for (const target of value) ref(target, 'reference', field === 'requirements' ? doc => doc.metadata.type === 'requirement' : undefined);
    }
  }
  if (metadata.superseded_by) {
    ref(metadata.superseded_by, 'superseded-target');
    const seen = new Set([path]);
    let next: string | undefined = metadata.superseded_by;
    for (let depth = 0; next && depth < DEFAULT_LIMITS.maxFiles; depth++) {
      if (seen.has(next)) { add('superseded-cycle', 'Cycle in superseded_by chain'); break; }
      seen.add(next);
      try { next = readDocument(workspace, next).metadata.superseded_by; }
      catch { break; }
    }
    if (metadata.status !== 'superseded') add('metadata', 'superseded_by requires status: superseded');
  }
  if (metadata.code !== undefined) {
    const codePaths = Array.isArray(metadata.code) ? metadata.code : [metadata.code];
    for (const target of codePaths) {
      try {
        if (typeof target !== 'string' || !existsSync(safePath(workspace.projectPath, target))) throw new Error('Code path not found');
      } catch (error) { add('code-reference', `${String(target)}: ${String(error)}`); }
    }
  }

  const section = Object.entries(workspace.config.sections).find(([, mapped]) => mapped === path)?.[0];
  if (section && metadata.type !== 'architecture') add('document-role', 'arc42 section must have type: architecture');
  const expectedTypes: Record<string, string> = { 'notes': 'note', 'plans': 'plan', 'requirements': 'requirement', 'how-to': 'how-to', 'reference': 'reference', 'tutorials': 'tutorial', 'explanation': 'explanation' };
  const category = path.split('/')[0];
  if (expectedTypes[category] && metadata.type !== expectedTypes[category] && metadata.type !== 'index') add('document-role', `${category} requires type: ${expectedTypes[category]}`);
  if (category === 'requirements' && !/^requirements\/\d{4}-\d{2}-\d{2}-[^/]+\/[^/]+\.md$/.test(path)) add('requirement-layout', 'Requirement must be inside YYYY-MM-DD-slug/');

  const decisionsRoot = dirname(workspace.config.sections['09_architecture_decisions']);
  const adrPrefix = join(decisionsRoot, 'ADR-').split('\\').join('/');
  if ((path.startsWith(adrPrefix) || metadata.type === 'adr')) {
    if (metadata.type !== 'adr' || !path.startsWith(adrPrefix) || !/^ADR-\d{4,}-[^/]+\.md$/.test(path.split('/').at(-1)!)) add('madr', 'Separate ADR requires ADR-xxxx-slug.md under section 9 and type: adr');
    const decision = z.object({ date: dateSchema, decision_status: z.enum(['proposed', 'accepted', 'rejected', 'deprecated', 'superseded']), 'decision-makers': z.array(z.string().min(1)).min(1).optional() }).safeParse(metadata);
    if (!decision.success) add('madr', 'ADR adapter requires date and decision_status; document status remains draft/active/deprecated/superseded');
    const headings = sequence.flatMap(token => token.type === 'heading' ? [token.text] : []);
    for (const heading of ['Context and Problem Statement', 'Considered Options', 'Decision Outcome']) {
      if (!headings.includes(heading)) add('madr', 'Missing MADR minimal heading: ' + heading);
      else {
        const start = sequence.findIndex(token => token.type === 'heading' && token.text === heading);
        const after = sequence.slice(start + 1);
        const boundary = after.findIndex(token => token.type === 'heading');
        const sectionTokens = boundary < 0 ? after : after.slice(0, boundary);
        if (!sectionTokens.some(token => token.type !== 'space' && token.type !== 'html' && token.raw.trim())) add('madr', 'Empty MADR section: ' + heading);
      }
    }
    const number = /^ADR-(\d+)-/.exec(path.split('/').at(-1)!)?.[1];
    const directory = safePath(workspace.root, decisionsRoot === '.' ? path : decisionsRoot);
    const parentDirectory = decisionsRoot === '.' ? dirname(directory) : directory;
    if (number && existsSync(parentDirectory)) {
      for (const sibling of readdirSync(parentDirectory)) {
        const siblingPath = join(decisionsRoot, sibling).split('\\').join('/');
        if (siblingPath !== path && Number(/^ADR-(\d+)-/.exec(sibling)?.[1]) === Number(number)) add('adr-number', 'Duplicate ADR number: ' + siblingPath);
      }
    }
    if (decision.success && ['deprecated', 'superseded'].includes(decision.data.decision_status) && metadata.status === 'active') add('madr', 'Inactive decision cannot have active document status');
  }

  const blocksRoot = dirname(workspace.config.sections['05_building_block_view']);
  const blockRelative = relative(blocksRoot, path).split('\\').join('/');
  const isBlock = /^(?:building-blocks\/[^/]+\/)+README\.md$/.test(blockRelative);
  if (isBlock || metadata.kind === 'building-block') {
    if (!isBlock || metadata.kind !== 'building-block' || metadata.type !== 'architecture') add('building-block', 'Block requires kind: building-block and nested building-blocks/name/README.md layout');
    const segments = blockRelative.split('/');
    const expectedParent = segments.length === 3 ? workspace.config.sections['05_building_block_view'] : join(blocksRoot, ...segments.slice(0, -3), 'README.md').split('\\').join('/');
    if (metadata.parent !== expectedParent) add('building-block', 'Expected parent: ' + expectedParent);
    ref(metadata.parent, 'building-block', (doc, target) => target === workspace.config.sections['05_building_block_view'] || doc.metadata.kind === 'building-block');
    if (segments.filter(segment => segment === 'building-blocks').length > 1) {
      const decomposition = z.object({ trigger: z.number().int().min(1).max(5), evidence: z.array(z.string().min(1)).min(1) }).safeParse(metadata.decomposition);
      if (!decomposition.success) add('decomposition', 'Nested block requires trigger 1..5 and evidence paths for the current requirement/ADR/scenario/risk/quality requirement');
      else for (const evidence of decomposition.data.evidence) ref(evidence, 'decomposition', (doc, target) => ['requirement', 'adr'].includes(doc.metadata.type) || doc.metadata.kind === 'runtime-scenario' || [workspace.config.sections['10_quality_requirements'], workspace.config.sections['11_technical_risks']].includes(target));
      add('decomposition-review', 'Review whether the selected trigger actually holds in the linked evidence; structural validation cannot establish that.', 'warning');
    }
  }
  const runtimeRoot = dirname(workspace.config.sections['06_runtime_view']);
  const scenarioPrefix = join(runtimeRoot, 'scenarios').split('\\').join('/') + '/';
  if (path.startsWith(scenarioPrefix) || metadata.kind === 'runtime-scenario') {
    if (!path.startsWith(scenarioPrefix) || metadata.kind !== 'runtime-scenario' || metadata.type !== 'architecture') add('runtime-block', 'Scenario requires kind: runtime-scenario under section 6/scenarios/');
    if (!Array.isArray(metadata.blocks) || !metadata.blocks.length) add('runtime-block', 'Scenario must identify building blocks');
    else for (const block of metadata.blocks) ref(block, 'runtime-block', doc => doc.metadata.kind === 'building-block' && doc.metadata.type === 'architecture');
  }

  function checkLink(href: string) {
    try {
      const target = resolveLocal(workspace, path, href);
      if (!target) return;
      if (target.absolute !== safePath(workspace.root, path) && !existsSync(target.absolute)) throw new Error('File not found');
      if (metadata.status === 'active' && target.absolute !== safePath(workspace.root, path) && extname(target.absolute).toLowerCase() === '.md') {
        try {
          const referenced = parseDocument(readFileSync(target.absolute, 'utf8'));
          if (['deprecated', 'superseded'].includes(referenced.metadata.status)) add('inactive-reference', 'Active document links to inactive source: ' + href, 'warning');
        } catch { /* Malformed target is reported by its own metadata check. */ }
      }
      if (target.fragment && extname(target.absolute) === '.md') {
        const targetContent = target.absolute === safePath(workspace.root, path) ? content : readFileSync(target.absolute, 'utf8');
        let targetBody = targetContent;
        try { targetBody = parseDocument(targetContent).body; } catch { /* Legacy text is still addressable. */ }
        if (!anchors(targetBody).has(target.fragment)) throw new Error('Heading/anchor not found');
      }
    } catch (error) { add('link', `${href}: ${String(error)}`); }
  }
  marked.walkTokens(sequence, (token: Token) => {
    if (token.type === 'link' || token.type === 'image') checkLink(token.href);
    else if (token.type === 'html') {
      const html = token.raw.replace(/<!--[\s\S]*?-->/g, '');
      for (const match of html.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        checkLink((match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, '&'));
      }
    }
  });
  return issues;
}

export function validateWorkspace(workspace: ProductWorkspace, limits = DEFAULT_LIMITS) {
  const scan = scanDocuments(workspace.root, ['.'], limits, false);
  const issues = [...scan.warnings];
  const isFile = (path: string) => {
    try { return lstatSync(safePath(workspace.root, path)).isFile(); } catch { return false; }
  };
  for (const section of workspace.config.requiredSections) {
    if (!isFile(workspace.config.sections[section])) issues.push({ code: 'required-section', path: workspace.config.sections[section], severity: 'error', message: 'Required arc42 section must be a regular file' });
  }
  if (!isFile('README.md')) issues.push({ code: 'index', path: 'README.md', severity: 'error', message: 'Documentation index must be a regular file' });
  for (const path of scan.paths.filter(path => path.toLowerCase().endsWith('.md'))) {
    try { issues.push(...documentIssues(workspace, path, readFileSync(safePath(workspace.root, path), 'utf8'))); }
    catch (error) { issues.push({ code: 'read', path, severity: 'error', message: String(error) }); }
  }
  for (const path of scan.paths.filter(path => /^requirements\//.test(path))) {
    const description = join(dirname(path), 'описание.md').split('\\').join('/');
    if (!existsSync(safePath(workspace.root, description))) issues.push({ code: 'requirement-layout', path, severity: 'error', message: 'Request folder requires описание.md' });
  }
  return { valid: !scan.truncated && !issues.some(issue => issue.severity === 'error'), issues, checkedFiles: scan.paths.length, truncated: scan.truncated, limits, scope: 'Configured docsDir; syntax, paths and explicit document relations. Semantic truth, code symbols and external URLs require review.' };
}
