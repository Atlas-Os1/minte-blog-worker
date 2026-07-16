// blog-helpers.ts - Memory parsing and GitHub API helpers

import type { MemoryEntry, GitHubActivity, GitHubCommit, GitHubPR } from './types/blog';
import { GITHUB_REPOS } from './blog-repos';

/**
 * Parse memory markdown files into structured entries
 */
export function parseMemoryFile(content: string, date: string): MemoryEntry {
  const headers = content.match(/^#{1,3}\s+.+$/gm) || [];
  const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
  
  return {
    date,
    content,
    headers,
    codeBlocks
  };
}

/**
 * Fetch recent GitHub activity from configured repos
 */
export async function fetchGitHubActivity(
  token: string,
  since: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)
): Promise<GitHubActivity> {
  const commits: GitHubCommit[] = [];
  const pullRequests: GitHubPR[] = [];

  for (const repo of GITHUB_REPOS) {
    try {
      // Fetch commits
      const commitsResp = await fetch(
        `https://api.github.com/repos/${repo}/commits?since=${since.toISOString()}&per_page=10`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DevFlo-BlogWorkflow'
          }
        }
      );

      if (commitsResp.ok) {
        const repoCommits = await commitsResp.json() as any[];
        commits.push(...repoCommits.map(c => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split('\n')[0],
          author: c.commit.author.name,
          date: c.commit.author.date,
          repo,
          url: c.html_url
        })));
      }

      // Fetch PRs
      const prsResp = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=5`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DevFlo-BlogWorkflow'
          }
        }
      );

      if (prsResp.ok) {
        const repoPRs = await prsResp.json() as any[];
        pullRequests.push(...repoPRs
          .filter(pr => new Date(pr.updated_at) >= since)
          .map(pr => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            author: pr.user.login,
            repo,
            url: pr.html_url,
            mergedAt: pr.merged_at
          })));
      }
    } catch (err) {
      console.error(`Failed to fetch from ${repo}:`, err);
    }
  }

  return {
    commits,
    pullRequests,
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Generate blog draft from memory entries and GitHub activity
 */
export function generateDraftContent(
  memories: MemoryEntry[],
  github: GitHubActivity,
  date: string
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# DevFlo Daily Update - ${date}\n`);
  sections.push(`*Automated summary of development activity*\n`);

  // GitHub Activity
  if (github.commits.length > 0 || github.pullRequests.length > 0) {
    sections.push(`## Code Activity\n`);
    
    if (github.commits.length > 0) {
      sections.push(`### Commits\n`);
      github.commits.slice(0, 10).forEach(c => {
        sections.push(`- **${c.repo.split('/')[1]}**: ${c.message} ([${c.sha}](${c.url}))`);
      });
      sections.push('');
    }

    if (github.pullRequests.length > 0) {
      sections.push(`### Pull Requests\n`);
      github.pullRequests.forEach(pr => {
        const status = pr.mergedAt ? '✅ Merged' : pr.state === 'open' ? '🔄 Open' : '❌ Closed';
        sections.push(`- ${status} **${pr.repo.split('/')[1]}** #${pr.number}: ${pr.title}`);
      });
      sections.push('');
    }
  }

  // Memory highlights
  if (memories.length > 0) {
    sections.push(`## Development Notes\n`);
    memories.forEach(mem => {
      if (mem.headers.length > 0) {
        sections.push(`### From ${mem.date}\n`);
        mem.headers.slice(0, 5).forEach(h => {
          sections.push(`- ${h.replace(/^#+\s*/, '')}`);
        });
        sections.push('');
      }
    });
  }

  return sections.join('\n');
}

/**
 * Generate slug from title
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate excerpt from content
 */
export function generateExcerpt(content: string, maxLength: number = 200): string {
  // Strip markdown formatting
  const plain = content
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}
