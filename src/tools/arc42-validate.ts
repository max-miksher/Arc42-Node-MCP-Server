/** Fork extension: read-only validation. */
import { z } from 'zod';
import { requireProduct } from '../product-workspace.js';
import { DEFAULT_LIMITS, validateWorkspace } from '../product-validation.js';
import { getErrorMessage, type ToolContext, type ToolResponse } from '../types.js';

export const scanLimitSchema = {
  maxFiles: z.number().int().min(1).max(50000).optional(),
  maxBytes: z.number().int().min(1).max(10_000_000).optional(),
  maxDepth: z.number().int().min(1).max(128).optional(),
};
export function scanLimits(args: { maxFiles?: number; maxBytes?: number; maxDepth?: number }) {
  return { maxFiles: args.maxFiles ?? DEFAULT_LIMITS.maxFiles, maxBytes: args.maxBytes ?? DEFAULT_LIMITS.maxBytes, maxDepth: args.maxDepth ?? DEFAULT_LIMITS.maxDepth };
}
export const arc42ValidateInputSchema = { targetFolder: z.string().optional(), ...scanLimitSchema };
export const arc42ValidateDescription = 'Validate arc42 structure, YAML metadata, Markdown links/anchors, nested building blocks, runtime participants and explicit arc42 relations. External artifacts are checked only as link targets; their formats and lifecycles are outside scope. Read-only. Errors or scan truncation return valid=false. This cannot prove architectural truth or check external URLs/code symbols.';
export async function arc42ValidateHandler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResponse> {
  try {
    const input = z.object(arc42ValidateInputSchema).parse(args);
    const data = validateWorkspace(requireProduct(context, input.targetFolder), scanLimits(input));
    return { success: data.valid, message: data.valid ? 'Structural validation passed; review draft content and architectural truth.' : 'Validation found errors or incomplete scan; inspect issues.', data };
  } catch (error) { return { success: false, message: getErrorMessage(error) }; }
}
