import { describe, expect, it } from 'vitest';
import { attachBrandAttachments, inferBrandAssets } from '../src/blog-branding';

describe('blog branding attachments', () => {
  it('detects the brands materially discussed by a post', () => {
    const assets = inferBrandAssets('A Cloudflare Worker sends an OpenMontage render through Hermes and GitHub.', ['cloudflare', 'openmontage']);
    expect(assets.map((asset) => asset.brand)).toEqual(['cloudflare', 'hermes-agent', 'openmontage', 'github']);
  });

  it('inserts a readable attachment section before the first technical heading', () => {
    const result = attachBrandAttachments('# Build log\n\nIntro.\n\n## What happened\n\nDetails.', 'Hermes + OpenMontage', 'A visual pipeline', ['hermes', 'openmontage']);
    expect(result.content.indexOf('Tools in this build')).toBeGreaterThan(-1);
    expect(result.content.indexOf('Tools in this build')).toBeLessThan(result.content.indexOf('## What happened'));
    expect(result.content).toContain('/assets/brands/hermes-agent/banner.png');
    expect(result.content).toContain('/assets/brands/openmontage/logo.png');
    expect(result.assets).toEqual(['/assets/brands/hermes-agent/banner.png', '/assets/brands/openmontage/logo.png']);
  });

  it('does not add a brand section when no supported topic is present', () => {
    const result = attachBrandAttachments('# A quiet note\n\n## Details\n\nNo platform names.', 'A quiet note', 'No platform names.', []);
    expect(result.content).not.toContain('Tools in this build');
    expect(result.assets).toEqual([]);
  });
});
