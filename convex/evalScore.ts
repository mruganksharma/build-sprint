// The rubric's 4-item rows (Document Read, Preference): 4 of 4 right → best; 2 or 3 → between;
// 0 or 1 → worst. Shared by evals.ts and grade.ts.
export type Score = "best" | "between" | "worst" | "pending";
export type Check = { item: string; ok: boolean; note: string };

export const scoreOfFour = (checks: Check[]): Score => {
  const right = checks.filter((c) => c.ok).length;
  return right === checks.length ? "best" : right >= 2 ? "between" : "worst";
};
