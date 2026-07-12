export interface BlogBrandAsset {
  brand: string;
  label: string;
  path: string;
  alt: string;
  width: number;
  height?: number;
}

const BRAND_ASSETS: Array<BlogBrandAsset & { needles: string[] }> = [
  {
    brand: 'cloudflare',
    label: 'Cloudflare',
    path: '/assets/brands/cloudflare/cloudflare.ico',
    alt: 'Cloudflare logo',
    width: 112,
    needles: ['cloudflare', 'workers', 'worker', 'r2', 'd1', 'durable objects', 'queues', 'wrangler'],
  },
  {
    brand: 'hermes-agent',
    label: 'Hermes Agent',
    path: '/assets/brands/hermes-agent/banner.png',
    alt: 'Hermes Agent banner',
    width: 420,
    needles: ['hermes', 'cleo', 'devflo', 'agent runtime', 'nous research'],
  },
  {
    brand: 'photon',
    label: 'Photon',
    path: '/assets/brands/photon/photon.svg',
    alt: 'Photon logo',
    width: 300,
    needles: ['photon'],
  },
  {
    brand: 'openmontage',
    label: 'OpenMontage',
    path: '/assets/brands/openmontage/logo.png',
    alt: 'OpenMontage logo',
    width: 360,
    needles: ['openmontage', 'montage', 'video pipeline', 'media pipeline'],
  },
  {
    brand: 'github',
    label: 'GitHub',
    path: '/assets/brands/github/github.svg',
    alt: 'GitHub logo',
    width: 112,
    needles: ['github', 'pull request', 'repository', 'repo activity', 'commit'],
  },
  {
    brand: 'anthropic',
    label: 'Anthropic',
    path: '/assets/brands/anthropic/anthropic.ico',
    alt: 'Anthropic logo',
    width: 112,
    needles: ['anthropic', 'claude'],
  },
  {
    brand: 'openai',
    label: 'OpenAI',
    path: '/assets/brands/openai/openai.svg',
    alt: 'OpenAI logo',
    width: 180,
    needles: ['openai', 'gpt-', 'chatgpt', 'codex'],
  },
];

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function inferBrandAssets(text: string, tags: string[] = []): BlogBrandAsset[] {
  const haystack = `${text} ${tags.join(' ')}`.toLowerCase();
  return BRAND_ASSETS
    .filter((asset) => asset.needles.some((needle) => haystack.includes(needle)))
    .map(({ needles: _needles, ...asset }) => asset);
}

export function renderBrandAttachmentBlock(assets: BlogBrandAsset[]): string {
  if (assets.length === 0) return '';

  const cards = assets.map((asset) => `
<figure class="brand-attachment-card">
  <img src="${escapeAttribute(asset.path)}" alt="${escapeAttribute(asset.alt)}" width="${asset.width}" loading="lazy">
  <figcaption>${escapeAttribute(asset.label)}</figcaption>
</figure>`).join('');

  return `

<section class="brand-attachments" aria-label="Tools discussed in this post">
  <p class="eyebrow">Tools in this build</p>
  <h2>The systems behind the work</h2>
  <p class="brand-attachment-intro">These are the platforms and products that materially shape this post. Their marks are included as working references, not decoration.</p>
  <div class="brand-attachment-grid">${cards}
  </div>
</section>
`;
}

export function attachBrandAttachments(content: string, title: string, description: string, tags: string[]): { content: string; assets: string[] } {
  const assets = inferBrandAssets(`${title}\n${description}\n${content}`, tags);
  if (assets.length === 0) return { content, assets: [] };

  const block = renderBrandAttachmentBlock(assets);
  const firstTechnicalHeading = content.search(/\n##\s+/);
  if (firstTechnicalHeading >= 0) {
    return {
      content: `${content.slice(0, firstTechnicalHeading)}${block}${content.slice(firstTechnicalHeading)}`,
      assets: assets.map((asset) => asset.path),
    };
  }

  return {
    content: `${content}${block}`,
    assets: assets.map((asset) => asset.path),
  };
}
