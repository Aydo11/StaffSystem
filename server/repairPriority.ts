// Suggested repair priority from the words used to describe it. Shared with the web form (no Node imports here).
// It is a suggestion only: the reporter can raise it; lowering it needs repairs.manage and a reason.
export type Urgency = 'emergency' | 'urgent' | 'routine' | 'planned';
export const URGENCY_RANK: Record<Urgency, number> = { emergency: 0, urgent: 1, routine: 2, planned: 3 };

const RULES: [Urgency, RegExp, string][] = [
  ['emergency', /\b(gas (smell|leak)|smell(s|ing)? of gas|carbon monoxide|co alarm (going off|sounding)|fire(?! (door|alarm|extinguisher|blanket|exit))|smoke (coming|from|pouring)|burning smell|smell of burning|sparking|exposed wir(e|ing)|electric(al)? shock|flood(ing|ed)?|burst pipe|sewage|ceiling (collapse|falling|down)|structural|no (power|electric(ity)?)|no water|insecure|break-?in|front door (won'?t|will not|doesn'?t|does not) lock)\b/i, 'Risk to safety or security now'],
  ['urgent', /\b(leak(ing|s)?|no hot water|no heating|boiler|heating (not|isn'?t) working|toilet (blocked|not flushing|won'?t flush)|blocked (drain|sink|toilet)|broken window|smashed|lock (broken|jammed)|damp|mould|mold|rats?|mice|mouse|cockroach(es)?|bed ?bugs?|wasps?|trip hazard|fire door|alarm (beeping|chirping)|loose (stair|banister|handrail)|fridge|freezer|cooker|oven)\b/i, 'Affects comfort, hygiene or could get worse quickly'],
  ['planned', /\b(redecorat(e|ion)|(re-?)?paint(ing)?|garden(ing)?|hedge|lawn|upgrade|replace(ment)? when|cosmetic|scuff)\b/i, 'Improvement or cosmetic work'],
];

export function suggestUrgency(text: string): { urgency: Urgency; reason: string } {
  for (const [urgency, re, reason] of RULES) if (re.test(text)) return { urgency, reason };
  return { urgency: 'routine', reason: 'No safety, hygiene or security words found' };
}

export const CATEGORIES = ['plumbing', 'heating', 'electrical', 'appliances', 'locks', 'doors', 'windows', 'furniture', 'damp_mould', 'pest_control', 'gardening', 'communal', 'decoration', 'general'] as const;
