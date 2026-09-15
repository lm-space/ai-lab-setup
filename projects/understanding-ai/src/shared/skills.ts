export const SKILLS = [
  { id: "explain-simply", name: "Explain simply", description: "Define jargon and use a concrete example.", instructions: "Explain unfamiliar terms in plain language. Use one small concrete example. Separate observed facts from assumptions." },
  { id: "evidence-first", name: "Evidence first", description: "Ground answers in available documents and tool results.", instructions: "For factual claims about uploaded files, retrieve relevant evidence with the knowledge tools and cite the filename. If evidence is missing, say so. Never fabricate a source." },
  { id: "compare-options", name: "Compare options", description: "Show alternatives, tradeoffs, and a recommendation.", instructions: "When comparing options, use consistent criteria and a compact table. Explain tradeoffs, then recommend an option with its assumptions." },
];

export function resolveSkills(ids: string[]) {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (!SKILLS.some((skill) => skill.id === id)) throw new Error(`Unknown skill: ${id}`);
  }
  return SKILLS.filter((skill) => unique.includes(skill.id));
}
