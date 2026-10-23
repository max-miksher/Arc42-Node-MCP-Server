/** Fork extension: structural checks; architectural truth still requires human review. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { marked, type Token } from 'marked';
import { decodeHTML } from 'entities';
import { isUtf8 } from 'node:buffer';
import {
  type ProductWorkspace, safePath, parseDocument, readDocument, sha256, sectionForDocument, isArc42Document, documentMetadata,
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
  function inlineText(sequence: Token[]): string {
    return sequence.map(token => 'tokens' in token && token.tokens ? inlineText(token.tokens) : 'text' in token ? String(token.text).replace(/<[^>]*>/g, '') : '').join('');
  }
  marked.walkTokens(tokens(body), (token: Token) => {
    if (token.type === 'heading') {
      const text = decodeHTML(inlineText(token.tokens ?? marked.Lexer.lexInline(token.text)));
      const slug = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
      let candidate = slug;
      for (let suffix = 1; ids.has(candidate); suffix++) candidate = slug + '-' + suffix;
      ids.add(candidate);
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

  if (!isArc42Document(workspace, path, metadata)) add('scope', 'Only arc42 sections, owned subsections and the arc42 index are managed');
  if (metadata.type !== (path === 'README.md' ? 'index' : 'architecture')) add('document-role', 'arc42 pages require type: architecture; the root index requires type: index');
  if (metadata.section !== undefined && metadata.section !== sectionForDocument(workspace, path, metadata)) add('section', 'Subsection owner conflicts with its configured section or location');
  for (const field of ['related', 'blocks'] as const) {
    const value = metadata[field];
    if (value !== undefined) {
      if (!Array.isArray(value) || !value.length) add('metadata', `${field} must be a non-empty list of arc42 paths`);
      else for (const target of value) ref(target, 'reference');
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

  const blocksRoot = dirname(workspace.config.sections['05_building_block_view']);
  const blockRelative = relative(blocksRoot, path).split('\\').join('/');
  const isBlock = /^(?:building-blocks\/[^/]+\/)+README\.md$/.test(blockRelative);
  if (isBlock || metadata.kind === 'building-block') {
    if (!isBlock || metadata.kind !== 'building-block' || metadata.type !== 'architecture') add('building-block', 'Block requires kind: building-block and nested building-blocks/name/README.md layout');
    const segments = blockRelative.split('/');
    const expectedParent = segments.length === 3 ? workspace.config.sections['05_building_block_view'] : join(blocksRoot, ...segments.slice(0, -3), 'README.md').split('\\').join('/');
    if (metadata.parent !== expectedParent) add('building-block', 'Expected parent: ' + expectedParent);
    ref(metadata.parent, 'building-block', (doc, target) => target === workspace.config.sections['05_building_block_view'] || doc.metadata.kind === 'building-block');

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
      if (target.fragment && target.absolute !== safePath(workspace.root, path) && lstatSync(target.absolute).size > DEFAULT_LIMITS.maxBytes) throw new Error('Anchor target exceeds maxBytes');
      if (metadata.status === 'active' && target.absolute !== safePath(workspace.root, path) && extname(target.absolute).toLowerCase() === '.md') {
        try {
          const targetPath = relative(workspace.root, target.absolute).split('\\').join('/');
          if (lstatSync(target.absolute).size > DEFAULT_LIMITS.maxBytes) throw new Error('Metadata target exceeds maxBytes');
          const referenced = documentMetadata(readFileSync(target.absolute, 'utf8'));
          if (isArc42Document(workspace, targetPath, referenced) && ['deprecated', 'superseded'].includes(String(referenced.status))) add('inactive-reference', 'Active document links to inactive source: ' + href, 'warning');
        } catch { /* Malformed target is reported by its own metadata check. */ }
      }
      if (target.fragment && extname(target.absolute).toLowerCase() === '.md') {
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
  let checkedFiles = 0;
  const unassignedFiles: string[] = [];
  for (const path of scan.paths.filter(path => path.toLowerCase().endsWith('.md'))) {
    try {
      const bytes = readFileSync(safePath(workspace.root, path));
      const content = bytes.toString('utf8');
      const metadata = documentMetadata(content);
      if (!isArc42Document(workspace, path, metadata)) { unassignedFiles.push(path); continue; }
      checkedFiles++;
      if (!isUtf8(bytes)) { issues.push({ code: 'encoding', path, severity: 'error', message: 'Managed arc42 document is not UTF-8' }); continue; }
      issues.push(...documentIssues(workspace, path, content));
    } catch (error) { issues.push({ code: 'read', path, severity: 'error', message: String(error) }); }
  }
  return { valid: !scan.truncated && !issues.some(issue => issue.severity === 'error'), issues, checkedFiles, unassignedFiles, truncated: scan.truncated, limits, scope: 'Configured arc42 sections, owned subsections and index only. Unassigned files are excluded; check ownership declarations if a page is missing. External artifacts are link targets, never schema-validated. Semantic truth and external URLs require review.' };
}
