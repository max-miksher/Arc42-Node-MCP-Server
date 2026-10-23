/** Read one legacy source for human review against an arc42 section; never migrate it. */
import { isUtf8 } from 'node:buffer';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { ARC42_SECTIONS, getErrorMessage, type Arc42Section, type ToolContext, type ToolResponse } from '../types.js';
import { requireProduct, safePath, sha256, readRawDocument } from '../product-workspace.js';

export const arc42RecoverInputSchema = {
  targetFolder: z.string().optional(),
  source: z.string().min(1).describe('One existing repository-relative legacy .md, .adoc or .txt file'),
  section: z.enum(ARC42_SECTIONS as unknown as [Arc42Section, ...Arc42Section[]]).describe('arc42 section to which architectural facts may contribute'),
  offset: z.number().int().min(0).optional().describe('UTF-16 character offset for a bounded source excerpt; default 0'),
  maxChars: z.number().int().min(1).max(50000).optional().describe('Maximum source characters returned; default 12000'),
};
export const arc42RecoverDescription = 'Read one selected legacy source and the current mapped arc42 section hash for incremental architectural recovery. Returns bounded source text, original-byte SHA-256 and explicit nextOffset/truncation. Never copies, rewrites, deletes, creates plans or changes source status. Review evidence before using arc42-document to patch verified facts into arc42; external artifacts stay independently managed.';
export async function arc42RecoverHandler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResponse> {
  try {
    const input = z.object(arc42RecoverInputSchema).parse(args);
    const workspace = requireProduct(context, input.targetFolder);
    const sourcePath = safePath(workspace.projectPath, input.source);
    if (!['.md', '.adoc', '.txt'].includes(extname(sourcePath).toLowerCase())) throw new Error('Expected a Markdown, AsciiDoc or text source');
    const stats = statSync(sourcePath);
    if (!stats.isFile() || stats.size > 10_000_000) throw new Error('Legacy source must be a regular file no larger than 10 MB');
    const bytes = readFileSync(sourcePath);
    if (!isUtf8(bytes)) throw new Error('Source is not UTF-8; review encoding separately, no conversion was performed');
    const content = bytes.toString('utf8');
    const offset = input.offset ?? 0;
    if (offset > content.length) throw new Error('offset exceeds source length');
    const excerpt = content.slice(offset, offset + (input.maxChars ?? 12000));
    const nextOffset = offset + excerpt.length;
    const target = readRawDocument(workspace, workspace.config.sections[input.section]);
    return { success: true, message: 'Read-only architectural evidence; no files changed.', data: {
      source: input.source, sourceHash: sha256(bytes), bytes: bytes.length, offset, excerpt,
      truncated: nextOffset < content.length, nextOffset: nextOffset < content.length ? nextOffset : null,
      section: input.section, target: target.relativePath, targetHash: target.sha256,
      requiresReview: true,
    }, nextSteps: ['Check architectural facts against current code and identify uncertainties.', 'Patch only verified facts into the arc42 section or an owned subsection using arc42-document and its current hash.', 'Keep source files untouched; validate arc42 and review semantic consistency.'] };
  } catch (error) { return { success: false, message: getErrorMessage(error) }; }
}
