/** Branch picker order: the repository's default branch first (always present, even if GitHub's list lacks it),
 *  then the usual release branches, then everything else alphabetically. */
const USUAL = ['main', 'master', 'dev', 'develop', 'prod', 'production'];

export function orderBranches(names: string[], defaultBranch: string): string[] {
  const rest = [...new Set(names)].filter((n) => n !== defaultBranch);
  const usual = USUAL.filter((n) => rest.includes(n));
  const others = rest.filter((n) => !USUAL.includes(n)).sort();
  return [...(defaultBranch ? [defaultBranch] : []), ...usual, ...others];
}
