/** Fork extension: legacy inventory does not alter or classify sources as normative. */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { relative } from 'node:path';
import { projectRoot, loadProduct, safePath, sha256, parseDocument, isArc42Document, documentMetadata } from '../product-workspace.js';
import { scanDocuments } from '../product-validation.js';
import { scanLimitSchema, scanLimits } from './arc42-validate.js';
import { getErrorMessage, type ToolContext, type ToolResponse } from '../types.js';

export const arc42InventoryInputSchema = { targetFolder: z.string().optional(), roots: z.array(z.string().min(1)).min(1).optional().describe('Repository-relative scan roots; default entire project. No symlinks, dependencies or generated trees.'), ...scanLimitSchema };
export const arc42InventoryDescription = 'Inventory legacy Markdown, AsciiDoc and text without modifying files. Returns hashes, exact duplicate groups, encoding health and architecture candidates requiring review; frontmatter is checked only on managed arc42 pages. File/depth/size limits and skipped symlinks are explicit; truncated inventory must not be treated as complete.';
export async function arc42InventoryHandler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResponse> {
  try {
    const input = z.object(arc42InventoryInputSchema).parse(args);
    const root = projectRoot(context, input.targetFolder);
    const product = loadProduct(context, input.targetFolder);
    const scan = scanDocuments(root, input.roots ?? ['.'], scanLimits(input));
    const hashes = new Map<string, string[]>();
    const files = scan.paths.map(path => {
      const original = readFileSync(safePath(root, path));
      const content = original.toString('utf8');
      const encoding = isUtf8(original) ? 'utf8' : 'unknown';
      const hash = sha256(original);
      hashes.set(hash, [...(hashes.get(hash) ?? []), path]);
      let metadata: Record<string, unknown> | null = null;
      let metadataError: string | null = null;
      const docsPrefix = product ? relative(root, product.root).split('\\').join('/') + '/' : '';
      const docsPath = docsPrefix && path.startsWith(docsPrefix) ? path.slice(docsPrefix.length) : null;
      const rawMetadata = documentMetadata(content);
      const managed = !!product && docsPath !== null && isArc42Document(product, docsPath, rawMetadata);
      try {
        if (managed) {
          if (encoding !== 'utf8') throw new Error('Source is not UTF-8; review encoding before recovery');
          metadata = parseDocument(content).metadata;
        }
      } catch (error) { metadataError = String(error); }
      const architectureCandidate = /architecture|архитектур|building block/i.test(content);
      return { path, sha256: hash, bytes: original.length, encoding, metadata, metadataError, managedArc42: managed, architectureCandidate, requiresReview: true };
    });
    return { success: true, message: 'Read-only inventory; suggestions require review, no documents migrated.', data: { files, duplicates: [...hashes.entries()].filter(([, paths]) => paths.length > 1).map(([hash, paths]) => ({ sha256: hash, paths })), warnings: scan.warnings, truncated: scan.truncated, limits: scan.limits } };
  } catch (error) { return { success: false, message: getErrorMessage(error) }; }
}
