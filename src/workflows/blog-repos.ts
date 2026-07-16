export type BlogRepoArea = 'agents-skills-tools' | 'projects' | 'blog-businesses';

export interface BlogRepository {
  repo: string;
  area: BlogRepoArea;
}

/**
 * Curated source-of-truth list for daily build notes and generated blog context.
 * Add new repositories here when Dev or LocDev onboards them; do not silently
 * expand the feed to every repository visible to the GitHub token.
 */
export const BLOG_REPOSITORIES: readonly BlogRepository[] = [
  { repo: 'Atlas-Os1/Hermes-agents', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/atlas-lanes', area: 'agents-skills-tools' },
  { repo: 'mintedmaterial/cleo-agent', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/atlas-skills', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/skills-minte-dev', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/atlas-cf-skills', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/openclaw-memory-vectorize', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/flo-social-worker', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/trading-judge-agent', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/OpenMontage', area: 'agents-skills-tools' },
  { repo: 'Atlas-Os1/r2-brain', area: 'projects' },
  { repo: 'Atlas-Os1/trading-r2-dashboard', area: 'projects' },
  { repo: 'Atlas-Os1/smart-alarm', area: 'projects' },
  { repo: 'Atlas-Os1/minte-blog-worker', area: 'blog-businesses' },
  { repo: 'Atlas-Os1/srvcflo-app-template', area: 'blog-businesses' },
  { repo: 'Atlas-Os1/handy-beaver', area: 'blog-businesses' },
  { repo: 'mintedmaterial/kiamichi-Biz-Connect', area: 'blog-businesses' },
  { repo: 'mintedmaterial/srvcflo-marketing', area: 'blog-businesses' },
  { repo: 'mintedmaterial/public-view', area: 'blog-businesses' },
  { repo: 'mintedmaterial/Twisted', area: 'blog-businesses' },
];

export const GITHUB_REPOS = BLOG_REPOSITORIES.map(({ repo }) => repo);
