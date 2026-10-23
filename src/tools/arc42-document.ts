/** Fork extension: document operations with metadata and compare-and-swap. */
import { z } from 'zod';
import { getErrorMessage, type ToolContext, type ToolResponse } from '../types.js';
import { requireProduct, readDocument, readRawDocument, writeDocument } from '../product-workspace.js';

export const arc42DocumentInputSchema = {
  action: z.enum(['read', 'create', 'edit']), path: z.string().min(1).describe('Document path relative to configured docsDir'),
  content: z.string().optional().describe('Complete Markdown with YAML frontmatter, for create only'),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('SHA-256 returned by read; required for edit'),
  oldText: z.string().min(1).optional(), newText: z.string().optional(),
  targetFolder: z.string().optional(),
};
export const arc42DocumentDescription = 'Read, create or edit configured arc42 sections and owned subsections only. Child pages declare section (arc42 section ID) in YAML, or use building-block/runtime-scenario layout. Read returns SHA-256; edit requires expectedHash and one exact oldText match. All managed Markdown requires YAML frontmatter. Paths are docsDir-relative. Create never overwrites. External ADRs, requirements, plans and other methodology artifacts are independently managed; sections 1 and 9 link to them.';
export async function arc42DocumentHandler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResponse> {
  try {
    const input = z.object(arc42DocumentInputSchema).parse(args);
    const workspace = requireProduct(context, input.targetFolder);
    if (input.action === 'read') return { success: true, message: 'Document read', data: readRawDocument(workspace, input.path) };
    if (input.action === 'create') {
      if (!input.content) throw new Error('content is required for create');
      writeDocument(workspace, input.path, input.content);
    } else {
      if (!input.expectedHash || !input.oldText || input.newText === undefined) throw new Error('edit requires expectedHash, oldText and newText');
      const current = readRawDocument(workspace, input.path);
      if (current.sha256 !== input.expectedHash) throw new Error('Version conflict: read document again');
      const first = current.content.indexOf(input.oldText);
      if (first < 0 || current.content.indexOf(input.oldText, first + 1) >= 0) throw new Error('oldText must match exactly once');
      const next = current.content.slice(0, first) + input.newText + current.content.slice(first + input.oldText.length);
      writeDocument(workspace, input.path, next, input.expectedHash);
    }
    return { success: true, message: 'Document written; run arc42-validate', data: readDocument(workspace, input.path) };
  } catch (error) { return { success: false, message: getErrorMessage(error) }; }
}
