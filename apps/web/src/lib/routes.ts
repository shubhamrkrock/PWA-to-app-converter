/** Path routes of the dashboard. Pure, so the tests run it in Node. */

export type Route =
  | { name: 'projects' }
  | { name: 'new-project' }
  | { name: 'project'; id: string; tab: ProjectTab }
  | { name: 'build'; id: string }
  | { name: 'integrations'; github: string | null }
  | { name: 'keys' }
  | { name: 'not-found' };

export const PROJECT_TABS = ['overview', 'settings', 'builds'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(pathname: string, search = ''): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const q = new URLSearchParams(search);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'projects')) return { name: 'projects' };
  if (parts[0] === 'projects' && parts[1] === 'new' && parts.length === 2) return { name: 'new-project' };
  if (parts[0] === 'projects' && parts[1] && UUID.test(parts[1]) && parts.length <= 3) {
    const tab = (parts[2] ?? 'overview') as ProjectTab;
    return PROJECT_TABS.includes(tab) ? { name: 'project', id: parts[1], tab } : { name: 'not-found' };
  }
  if (parts[0] === 'builds' && parts[1] && UUID.test(parts[1]) && parts.length === 2) return { name: 'build', id: parts[1] };
  if (parts[0] === 'integrations' && parts.length === 1) return { name: 'integrations', github: q.get('github') };
  if (parts[0] === 'keys' && parts.length === 1) return { name: 'keys' };
  return { name: 'not-found' };
}

export function hrefFor(r: Route): string {
  switch (r.name) {
    case 'projects':
      return '/projects';
    case 'new-project':
      return '/projects/new';
    case 'project':
      return r.tab === 'overview' ? `/projects/${r.id}` : `/projects/${r.id}/${r.tab}`;
    case 'build':
      return `/builds/${r.id}`;
    case 'integrations':
      return '/integrations';
    case 'keys':
      return '/keys';
    default:
      return '/';
  }
}
