import { describe, expect, it } from 'vitest';
import { GITHUB_REPOS } from '../src/workflows/blog-repos';

describe('blog repository registry', () => {
  it('tracks the approved current repos and excludes legacy entries', () => {
    expect(GITHUB_REPOS).toContain('Atlas-Os1/Hermes-agents');
    expect(GITHUB_REPOS).toContain('Atlas-Os1/atlas-lanes');
    expect(GITHUB_REPOS).toContain('Atlas-Os1/openclaw-memory-vectorize');
    expect(GITHUB_REPOS).toContain('Atlas-Os1/flo-social-worker');
    expect(GITHUB_REPOS).toContain('mintedmaterial/cleo-agent');
    expect(GITHUB_REPOS).toContain('mintedmaterial/Twisted');
    expect(GITHUB_REPOS).not.toContain('Atlas-Os1/devflo-moltworker');
    expect(GITHUB_REPOS).not.toContain('Atlas-Os1/atlas-dashboard');
  });

  it('does not duplicate repos listed in multiple business areas', () => {
    expect(new Set(GITHUB_REPOS).size).toBe(GITHUB_REPOS.length);
    expect(GITHUB_REPOS).toContain('Atlas-Os1/trading-r2-dashboard');
  });
});
