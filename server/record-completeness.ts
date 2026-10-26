// These checks establish whether a record has content, not whether its claims are verified.
export const REVIEW_FIELDS = ['objectives', 'achievements', 'development', 'feedback'] as const;
export const SUPERVISION_FIELDS = ['agenda', 'shared_notes'] as const;
export function missingFields(record: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter(field => typeof record[field] !== 'string' || !(record[field] as string).trim());
}
