/** Fork extension: legacy inventory does not alter or classify sources as normative. */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { relative } from 'node:path';
import { projectRoot, loadProduct, safePath, sha256, parseDocument } from '../product-workspace.js';
import { scanDocuments } from '../product-validation.js';
import { scanLimitSchema, scanLimits } from './arc42-validate.js';
import { getErrorMessage, type ToolContext, type ToolResponse } from '../types.js';

export const arc42InventoryInputSchema = { targetFolder: z.string().optional(), roots: z.array(z.string().min(1)).min(1).optional().describe('Repository-relative scan roots; default entire project. No symlinks, dependencies or generated trees.'), ...scanLimitSchema };
export const arc42InventoryDescription = 'Inventory legacy Markdown, AsciiDoc and text without modifying files. Returns hashes, exact duplicate groups, metadata health and candidate types requiring review. File/depth/size limits and skipped symlinks are explicit; truncated inventory must not be treated as complete.';
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
      try {
        if (encoding !== 'utf8') throw new Error('Source is not UTF-8; explicit encoding review is required before migration');
        metadata = parseDocument(content).metadata;
      } catch (error) { metadataError = String(error); }
      const candidateType = /\bADR[- ]\d+|decision outcome/i.test(content) ? 'adr' : /architecture|архитектур|building block/i.test(content) ? 'architecture' : 'note';
      const docsPrefix = product ? relative(root, product.root).split('\\').join('/') + '/' : '';
      return { path, sha256: hash, bytes: original.length, encoding, metadata, metadataError, canonicalCandidate: !!docsPrefix && path.startsWith(docsPrefix) && !!metadata, suggestedType: candidateType, requiresReview: true };
    });
    return { success: true, message: 'Read-only inventory; suggestions require review, no documents migrated.', data: { files, duplicates: [...hashes.entries()].filter(([, paths]) => paths.length > 1).map(([hash, paths]) => ({ sha256: hash, paths })), warnings: scan.warnings, truncated: scan.truncated, limits: scan.limits } };
  } catch (error) { return { success: false, message: getErrorMessage(error) }; }
}
