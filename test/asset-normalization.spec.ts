import { describe, it, expect } from 'vitest';
import { normalizeAssetRef, collectAssetRefs, renderAssetGallery, type BlogPost } from '../src/index';

describe('normalizeAssetRef', () => {
	it('returns absolute /assets/posts/ paths unchanged', () => {
		expect(normalizeAssetRef('/assets/posts/my-slug/chart.svg', 'my-slug')).toBe('/assets/posts/my-slug/chart.svg');
	});

	it('normalizes a bare filename to a per-post asset path', () => {
		expect(normalizeAssetRef('diagram.png', 'my-slug')).toBe('/assets/posts/my-slug/diagram.png');
	});

	it('normalizes a relative ./filename to a per-post asset path', () => {
		expect(normalizeAssetRef('./diagram.png', 'my-slug')).toBe('/assets/posts/my-slug/diagram.png');
	});

	it('extracts the pathname from an absolute blog.minte.dev URL', () => {
		expect(normalizeAssetRef('https://blog.minte.dev/assets/posts/my-slug/hero.jpg', 'my-slug')).toBe(
			'/assets/posts/my-slug/hero.jpg'
		);
	});

	it('returns null for non-matching URLs', () => {
		expect(normalizeAssetRef('https://example.com/image.png', 'my-slug')).toBeNull();
	});

	it('returns null for disallowed extensions', () => {
		expect(normalizeAssetRef('malware.exe', 'my-slug')).toBeNull();
	});

	it('returns null for paths containing ..', () => {
		expect(normalizeAssetRef('../secret.txt', 'my-slug')).toBeNull();
	});

	it('trims trailing punctuation', () => {
		expect(normalizeAssetRef('diagram.png).', 'my-slug')).toBe('/assets/posts/my-slug/diagram.png');
		expect(normalizeAssetRef('diagram.png,', 'my-slug')).toBe('/assets/posts/my-slug/diagram.png');
	});

	it('returns null for empty strings', () => {
		expect(normalizeAssetRef('', 'my-slug')).toBeNull();
		expect(normalizeAssetRef('   ', 'my-slug')).toBeNull();
	});

	it('handles video and html extensions', () => {
		expect(normalizeAssetRef('demo.mp4', 'my-slug')).toBe('/assets/posts/my-slug/demo.mp4');
		expect(normalizeAssetRef('widget.html', 'my-slug')).toBe('/assets/posts/my-slug/widget.html');
	});
});

describe('collectAssetRefs', () => {
	it('collects heroImage as a normalized ref', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '',
			draft: false,
			heroImage: 'hero.png',
		};
		expect(collectAssetRefs(post)).toEqual(['/assets/posts/test-post/hero.png']);
	});

	it('collects items from the assets array', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '',
			draft: false,
			assets: ['chart.svg', 'table.csv'],
		};
		expect(collectAssetRefs(post)).toEqual(['/assets/posts/test-post/chart.svg']);
	});

	it('parses src/href attributes from content', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '<img src="/assets/posts/test-post/inline.png" />',
			draft: false,
		};
		expect(collectAssetRefs(post)).toEqual(['/assets/posts/test-post/inline.png']);
	});

	it('parses markdown-style asset links from content', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: 'See the [diagram](/assets/posts/test-post/diagram.svg) for details.',
			draft: false,
		};
		expect(collectAssetRefs(post)).toEqual(['/assets/posts/test-post/diagram.svg']);
	});

	it('parses absolute blog.minte.dev URLs from content', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: 'Check https://blog.minte.dev/assets/posts/test-post/hero.jpg here',
			draft: false,
		};
		expect(collectAssetRefs(post)).toEqual(['/assets/posts/test-post/hero.jpg']);
	});

	it('deduplicates repeated refs', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '<img src="same.png" /><img src="same.png" />',
			draft: false,
		};
		expect(collectAssetRefs(post)).toEqual(['/assets/posts/test-post/same.png']);
	});

	it('filters out refs that do not belong to the post slug', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '<img src="/assets/posts/other-post/image.png" />',
			draft: false,
		};
		expect(collectAssetRefs(post)).toEqual([]);
	});

	it('returns an empty array when there are no assets', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: 'Just text, no images.',
			draft: false,
		};
		expect(collectAssetRefs(post)).toEqual([]);
	});
});

describe('renderAssetGallery', () => {
	it('returns an empty string when there are no asset refs', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: 'Just text.',
			draft: false,
		};
		expect(renderAssetGallery(post)).toBe('');
	});

	it('renders a gallery section with image refs', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '<img src="/assets/posts/test-post/diagram.svg" />',
			draft: false,
		};
		const html = renderAssetGallery(post);
		expect(html).toContain('asset-gallery');
		expect(html).toContain('/assets/posts/test-post/diagram.svg');
		expect(html).toContain('▧');
		expect(html).toContain('image attachment');
	});

	it('renders a gallery section with video refs', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '',
			draft: false,
			assets: ['demo.mp4'],
		};
		const html = renderAssetGallery(post);
		expect(html).toContain('asset-gallery');
		expect(html).toContain('/assets/posts/test-post/demo.mp4');
		expect(html).toContain('▶');
		expect(html).toContain('video attachment');
	});

	it('renders a gallery section with embed/html refs', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '',
			draft: false,
			assets: ['widget.html'],
		};
		const html = renderAssetGallery(post);
		expect(html).toContain('asset-gallery');
		expect(html).toContain('/assets/posts/test-post/widget.html');
		expect(html).toContain('⌁');
		expect(html).toContain('embed attachment');
	});

	it('renders multiple asset link cards', () => {
		const post: BlogPost = {
			slug: 'test-post',
			title: 'Test',
			description: 'Test desc',
			pubDate: '2026-01-01T00:00:00Z',
			author: 'Dev',
			tags: [],
			content: '',
			draft: false,
			assets: ['a.png', 'b.svg'],
		};
		const html = renderAssetGallery(post);
		expect(html).toContain('/assets/posts/test-post/a.png');
		expect(html).toContain('/assets/posts/test-post/b.svg');
	});
});
