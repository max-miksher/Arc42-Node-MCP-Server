/** Dogma fork: planning only; migrating remains an explicit reviewed change. */
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { requireProduct, readDocument, safePath, sha256 } from '../product-workspace.js';
import { getErrorMessage, type ToolContext, type ToolResponse } from '../types.js';

export const arc42MigrationPlanInputSchema = {
  targetFolder: z.string().optional(), requirement: z.string().min(1).describe('Existing docs-relative current requirement'),
  items: z.array(z.object({ source: z.string().min(1).describe('Repository-relative existing source'), target: z.string().min(1).describe('Docs-relative canonical destination'), reason: z.string().trim().min(1).describe('Why this requirement needs this source migrated now') })).min(1).max(100),
};
export const arc42MigrationPlanDescription = 'Build a read-only migration plan for explicitly selected legacy sources and an existing current requirement. Returns source/target hashes, create/update actions and conflict review steps. Does not copy, rewrite, supersede or delete documents; unrelated legacy remains untouched.';
export async function arc42MigrationPlanHandler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResponse> {
  try {
    const input = z.object(arc42MigrationPlanInputSchema).parse(args);
    const workspace = requireProduct(context, input.targetFolder);
    const requirement = readDocument(workspace, input.requirement);
    if (requirement.metadata.type !== 'requirement' || !['active', 'draft'].includes(requirement.metadata.status)) throw new Error('Migration requires a current requirement');
    const seen = new Set<string>();
    const items = input.items.map(item => {
      const source = safePath(workspace.projectPath, item.source);
      const target = safePath(workspace.root, item.target);
      if (!item.target.endsWith('.md') || source === target) throw new Error('Target must be a distinct canonical .md path');
      if (seen.has(item.target)) throw new Error('Duplicate destination: resolve canonical source conflict first');
      seen.add(item.target);
      const targetExists = existsSync(target);
      return { ...item, action: targetExists ? 'update' : 'create', sourceHash: sha256(readFileSync(source)), targetHash: targetExists ? sha256(readFileSync(target)) : null, conflictReviewRequired: targetExists };
    });
    return { success: true, message: 'Plan prepared; no filesystem changes.', data: { requirement: input.requirement, requirementHash: requirement.sha256, items, steps: ['Review conflicts between legacy, current requirement and code with the owner.', 'Read current source and target; verify snapshot hashes.', 'Create or edit only the selected canonical documents using arc42-document.', 'Update existing sources in place if the object is unchanged; if replaced, explicitly mark superseded and link superseded_by.', 'Validate structure and review whether affected active documents remain true.'] } };
  } catch (error) { return { success: false, message: getErrorMessage(error) }; }
}
