// manual-blog-gen.ts - Manual blog generation (simplified, no Workflows API)

import { scanAndRedact } from './workflows/security-scanner';
import { attachBrandAttachments } from './blog-branding';

export interface SimpleBlogPost {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  author: string;
  tags: string[];
  content: string;
  draft: boolean;
  project?: string;
  readingTime?: string;
  category?: string;
  type?: 'daily-update' | 'blog-draft' | 'memory';
  heroImage?: string;
  assets?: string[];
}

export interface PostIndex {
  posts: Array<Omit<SimpleBlogPost, 'content'>>;
  tags: Record<string, number>;
}

interface MemoryHighlight {
  date: string;
  content: string;
  headers: string[];
  bullets: string[];
  sourceKey: string;
}

const MEMORY_PREFIXES = [
  'workspace/memory/',
  'workspace/shared-memory/',
  'shared-memory/',
  'memory/',
  'hermes-memory/',
];

function extractBullets(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 8 && !/(token|secret|password|private key)/i.test(line))
    .slice(0, 12);
}

async function parseMemoryFile(bucket: R2Bucket, date: string): Promise<MemoryHighlight | null> {
  for (const prefix of MEMORY_PREFIXES) {
    const key = `${prefix}${date}.md`;
    try {
      const obj = await bucket.get(key);
      if (!obj) continue;
      const content = await obj.text();
      const headers = content.match(/^#{1,3} .+$/gm) || [];
      return {
        date,
        content: content.slice(0, 4000),
        headers: headers.map((h: string) => h.replace(/^#{1,3} /, '')),
        bullets: extractBullets(content),
        sourceKey: key,
      };
    } catch (error) {
      console.error(`Failed to parse memory for ${key}:`, error);
    }
  }
  return null;
}

function bulletSummary(memory: MemoryHighlight | null, githubActivity: string): string[] {
  const bullets = [...(memory?.bullets || [])];
  if (bullets.length === 0 && memory?.headers.length) {
    bullets.push(...memory.headers.slice(0, 8));
  }
  if (githubActivity.trim()) {
    bullets.push(summarizeGitHubActivity(githubActivity));
  }
  return Array.from(new Set(bullets))
    .slice(0, 8)
    .map((item) => item.replace(/[\r\n]+/g, ' ').trim());
}

async function fetchGitHubActivity(bucket: R2Bucket, date: string): Promise<string> {
  try {
    const obj = await bucket.get(`workspace/github/${date}.md`);
    if (!obj) return '';
    
    return await obj.text();
  } catch (error) {
    console.error(`Failed to fetch GitHub activity for ${date}:`, error);
    return '';
  }
}

function inferTagsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const tagMap: Array<[string, string[]]> = [
    ['handy-beaver', ['handy', 'beaver', 'invoice', 'payment']],
    ['kiamichi-biz-connect', ['kiamichi', 'kbc', 'business directory']],
    ['minte-blog-worker', ['blog', 'publishing', 'post', 'rss']],
    ['openclaw', ['openclaw', 'memory', 'vectorize']],
    ['cloudflare', ['cloudflare', 'worker', 'r2', 'd1', 'workflow']],
    ['ai-agents', ['agent', 'hermes', 'cleo', 'lil beaver', 'devflo']],
  ];
  const tags = tagMap.filter(([, needles]) => needles.some((needle) => lower.includes(needle))).map(([tag]) => tag);
  return Array.from(new Set(tags)).slice(0, 5);
}

function inferProjectFromText(text: string): string {
  const tags = inferTagsFromText(text);
  return tags.find((tag) => ['handy-beaver', 'kiamichi-biz-connect', 'minte-blog-worker', 'openclaw'].includes(tag)) || 'atlas-os';
}

function estimateReadingTime(content: string): string {
  const words = content.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.ceil(words / 220))} min read`;
}

function generateExcerpt(content: string, maxLength = 200): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= maxLength ? plain : `${plain.slice(0, maxLength).replace(/\s+\S*$/, '')}...`;
}

function summarizeGitHubActivity(activity: string): string {
  const lower = activity.toLowerCase();
  if (!activity.trim()) return '';
  if (lower.includes('handy')) return 'Handy Beaver repo activity';
  if (lower.includes('kiamichi') || lower.includes('kbc')) return 'Kiamichi Biz Connect updates';
  if (lower.includes('blog')) return 'Minte Blog Worker publishing updates';
  if (lower.includes('memory') || lower.includes('openclaw')) return 'OpenClaw memory infrastructure updates';
  if (lower.includes('cloudflare') || lower.includes('worker')) return 'Cloudflare Worker infrastructure updates';
  return 'Atlas / Minte repo activity';
}

export async function generateBlogPost(bucket: R2Bucket, githubToken?: string): Promise<SimpleBlogPost> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  
  // Parse yesterday's memory
  const memory = await parseMemoryFile(bucket, dateStr);
  
  // Fetch GitHub activity
  const githubActivity = await fetchGitHubActivity(bucket, dateStr);
  
  // Determine content based on what we have. Prefer specific, SEO-useful build-log headlines
  // over generic daily-update copy so the public blog consistently points back to repos/projects.
  let title = `Atlas / Minte Build Log - ${dateStr}`;
  let description = 'A focused build log from the Atlas / Minte project ecosystem.';
  let content = '';
  let tags = ['daily-update', 'development', 'building-in-public'];
  
  if (memory && memory.headers.length > 0) {
    // Build blog from memory
    const primaryTopic = memory.headers[0].replace(/^(daily update|building in public)[: -]*/i, '').trim() || 'Atlas / Minte project work';
    title = `${primaryTopic}: ${dateStr} Build Log`;
    description = `Project notes from ${dateStr}: ${memory.headers.slice(0, 3).join(', ')}`;
    tags = ['daily-update', 'development', 'building-in-public', ...inferTagsFromText(`${memory.content} ${githubActivity}`)];
    
    content = `# ${title}

## What Happened on ${dateStr}

${bulletSummary(memory, githubActivity).map((item) => `- **${item.split(':')[0]}**${item.includes(':') ? ':' + item.split(':').slice(1).join(':') : ''}`).join('\n')}

---

### Source memory context

${memory.content}

---

${githubActivity ? `\n## Development Activity\n\n${githubActivity}\n\n---\n\n` : ''}

**Development Notes:** Daily log automatically generated from shared workspace memory files${githubActivity ? ' and GitHub activity' : ''}. Source: ${memory.sourceKey}.

---

![Flo's Signature](https://blog.minte.dev/assets/branding/author-signature-flo.svg)`;
  } else {
    // Fallback: simple update that still reads like a specific build log
    const activitySummary = summarizeGitHubActivity(githubActivity);
    title = activitySummary ? `${activitySummary}: ${dateStr} Build Log` : `Atlas / Minte Systems Check - ${dateStr}`;
    description = activitySummary
      ? `Daily build note covering ${activitySummary.toLowerCase()} across the Atlas / Minte repos.`
      : `Daily build note for the Atlas / Minte project ecosystem on ${dateStr}.`;
    tags = ['daily-update', 'building-in-public', ...inferTagsFromText(githubActivity)];
    content = `# ${title}

${bulletSummary(memory, githubActivity).length ? bulletSummary(memory, githubActivity).map((item) => `- **${item}**`).join('\n') : '- **Systems check:** No major shared-memory bullets were logged for this date.\n- **Ongoing work:** Continuing development across Handy Beaver, Kiamichi Biz Connect, Minte Blog Worker, OpenClaw memory, and related Cloudflare repos.'}

${githubActivity ? `\n## Development Activity\n\n${githubActivity}\n\n---\n\n` : ''}

---

![Flo's Signature](https://blog.minte.dev/assets/branding/author-signature-flo.svg)`;
  }
  
  // TODO: Generate hero image using atlas-warhol when API is working
  // python3 /home/flo/.clawdbot/skills/frontend/atlas-warhol/scripts/generate_enhanced.py \
  //   --prompt "pop art daily update for ${dateStr}, vibrant tech aesthetic" \
  //   --width 1200 --height 630 \
  //   --output "daily-update-${dateStr}" \
  //   --store-r2
  // Then set heroImage to the R2 public URL

  const branded = attachBrandAttachments(content, title, description, tags);

  const post: SimpleBlogPost = {
    slug: `${dateStr}-daily-update`,
    title,
    description,
    pubDate: new Date().toISOString(),
    author: 'Flo',
    tags,
    content: branded.content,
    draft: false,
    type: 'daily-update',
    project: inferProjectFromText(`${title} ${description} ${tags.join(' ')}`),
    readingTime: estimateReadingTime(branded.content),
    assets: branded.assets
    // heroImage: 'https://pub-748cd0b5fd7d4d38a0c3ad5c09d205ae.r2.dev/skills/art_bucket/daily-update-${dateStr}.png'
  };

  return post;
}

export async function generateDetailedBlogDraft(bucket: R2Bucket, ai: Ai): Promise<SimpleBlogPost> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  const memory = await parseMemoryFile(bucket, dateStr);
  const githubActivity = await fetchGitHubActivity(bucket, dateStr);
  const sourceContext = [
    memory ? `MEMORY (${memory.sourceKey}):\n${memory.content}` : 'MEMORY: no source file found',
    githubActivity ? `GITHUB ACTIVITY:\n${githubActivity}` : 'GITHUB ACTIVITY: no source file found',
  ].join('\n\n').slice(0, 14000);

  const prompt = `You are preparing a private draft for the Minte.dev technical blog. Write a detailed, truthful teaching article from the source context below. Do not invent commits, metrics, URLs, deployments, or results. Keep the article separate from the short daily build note. Use Markdown only and include: a clear title as the first # heading, a practical explanation of what changed, why it matters, a code or configuration example only when supported by the source, a realistic terminal example only when supported by the source, and a short verification/checklist section. Do not include secrets or private data. Do not add documentation URLs unless they appear in the source; Cleo will verify current official documentation links during approval.\n\nSOURCE CONTEXT:\n${sourceContext}`;

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
    messages: [
      { role: 'system', content: 'Return only the Markdown article draft.' },
      { role: 'user', content: prompt },
    ],
  }) as { response?: unknown };

  const generated = typeof response?.response === 'string' ? response.response.trim() : '';
  if (!generated) {
    throw new Error('Workers AI returned no Markdown draft');
  }

  const content = generated.startsWith('#') ? generated : `# Atlas / Minte Build Review - ${dateStr}\n\n${generated}`;
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || `Atlas / Minte Build Review - ${dateStr}`;
  const description = generateExcerpt(content, 240);
  const tags = ['blog-draft', 'building-in-public', ...inferTagsFromText(`${title}\n${content}`)];
  const branded = attachBrandAttachments(content, title, description, tags);

  return {
    slug: `${dateStr}-blog-draft`,
    title,
    description,
    pubDate: new Date().toISOString(),
    author: 'Cleo',
    tags: Array.from(new Set(tags)),
    content: branded.content,
    draft: true,
    type: 'blog-draft',
    project: inferProjectFromText(`${title} ${content}`),
    readingTime: estimateReadingTime(branded.content),
    assets: branded.assets,
  };
}

export async function saveBlogDraft(bucket: R2Bucket, post: SimpleBlogPost): Promise<{ key: string }> {
  const safePost = {
    ...post,
    draft: true,
    type: 'blog-draft',
  };
  const key = `drafts/${post.slug}.json`;
  await bucket.put(key, JSON.stringify(safePost, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
  return { key };
}

export async function generateMemoryDigestPost(bucket: R2Bucket): Promise<SimpleBlogPost> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  const memory = await parseMemoryFile(bucket, dateStr);
  const bullets = bulletSummary(memory, '');
  const title = `Shared Memory Digest - ${dateStr}`;
  const summary = bullets.length
    ? bullets.map((item) => `- ${item}`).join('\n')
    : '- No shared-memory bullets were found for this date.';

  const content = `# ${title}

## Daily changes

${summary}

${memory ? `## Source context\n\n${memory.content}` : '## Source context\n\nNo memory source object was found in the configured blog/shared-memory prefixes.'}

---

Generated automatically for the protected memory section from shared workspace memory.`;

  const memoryTags = ['memory', 'daily-update', 'shared-memory', ...inferTagsFromText(content)];
  const branded = attachBrandAttachments(content, title, `Protected shared-memory digest for ${dateStr}.`, memoryTags);

  return {
    slug: `${dateStr}-shared-memory-digest`,
    title,
    description: `Protected shared-memory digest for ${dateStr}.`,
    pubDate: new Date().toISOString(),
    author: 'Dev',
    tags: memoryTags,
    content: branded.content,
    draft: false,
    category: 'memory',
    type: 'memory',
    project: 'openclaw',
    readingTime: estimateReadingTime(branded.content),
    assets: branded.assets,
  };
}

// Keep the old R2 collaboration post function for reference
export async function generateR2CollaborationPost(bucket: R2Bucket): Promise<SimpleBlogPost> {
  const today = new Date().toISOString().split('T')[0];
  
  const post: SimpleBlogPost = {
    slug: `${today}-r2-collaboration-pattern`,
    title: 'R2 Buckets as Collaboration Workspace: A Pattern for Multi-Agent Discord Workflows',
    description: 'How we use Cloudflare R2 buckets as a shared workspace to pass code, designs, and documentation between AI agents in Discord - solving the "long message" problem.',
    pubDate: new Date().toISOString(),
    author: 'Flo',
    tags: ['cloudflare', 'r2', 'ai-agents', 'workflow', 'collaboration', 'discord'],
    content: `# R2 Buckets as Collaboration Workspace

## The Problem

When working with AI agents in Discord, we hit a fundamental limitation: Discord messages have a 2000 character limit. When you're trying to share:
- Multi-file implementations
- Full code workflows
- Detailed technical specs
- Architecture diagrams

...you quickly run into this wall. Pasting code across 5-10 messages is messy, hard to review, and breaks flow.

## The Solution: R2 as Shared Workspace

We solved this by treating **Cloudflare R2 buckets as a shared workspace** between agents. Here's the pattern:

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│  Discord Thread: #2-blog-workflow-multi-step-pipeline          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  DevFlo: "Implementation complete! 📦"                          │
│  Link: https://pub-xxx.r2.dev/task-2-blog-workflow/status.md   │
│                                                                 │
│  ├── status.md (overview + checklist)                           │
│  ├── src/workflows/blog-workflow.ts (main code)                 │
│  ├── src/workflows/blog-helpers.ts                              │
│  └── src/workflows/types/blog.ts                                │
│                                                                 │
│  Flo: "Reviewing..." [fetches files via web_fetch]             │
│       "✅ APPROVED! Ship it."                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

### How It Works

**1. Public R2 Bucket**
\`\`\`bash
# Create a public bucket for collab docs
wrangler r2 bucket create atlas-collab-pub
\`\`\`

**2. Upload Files from Agent**
\`\`\`typescript
// DevFlo uploads implementation files
const files = [
  'status.md',
  'src/workflows/blog-workflow.ts',
  'src/workflows/types/blog.ts'
];

for (const file of files) {
  await env.R2_BUCKET.put(
    \`task-2-blog-workflow/\${file}\`,
    fileContent,
    { httpMetadata: { contentType: getMimeType(file) } }
  );
}
\`\`\`

**3. Share Link in Discord**
\`\`\`markdown
📦 **CODE: Blog Workflow - Complete Implementation**
https://pub-xxx.r2.dev/task-2-blog-workflow/status.md

**Files uploaded:**
- status.md
- src/workflows/blog-workflow.ts
- src/workflows/blog-helpers.ts

🔍 **REVIEW REQUEST:** Ready for your review!
\`\`\`

**4. Other Agent Reviews**
\`\`\`typescript
// Flo fetches and reviews
const statusMd = await web_fetch({
  url: 'https://pub-xxx.r2.dev/task-2-blog-workflow/status.md'
});

const workflow = await web_fetch({
  url: 'https://pub-xxx.r2.dev/task-2-blog-workflow/src/workflows/blog-workflow.ts'
});

// Review code, approve or request changes
\`\`\`

## Benefits

✅ **No message splitting** - Files stay intact, readable
✅ **Proper syntax highlighting** - Code is served with correct MIME types
✅ **Version control** - Bucket acts as artifact storage
✅ **Async review** - Agents can review on their own time
✅ **Clean Discord** - Just links, no walls of code
✅ **Professional** - Feels like a real review process

## Real Example: Blog Workflow Task

Today we used this pattern to build the blog workflow feature:

1. **DevFlo** implemented 7-step blog generation pipeline (~1,300 lines)
2. Uploaded to \`pub-xxx.r2.dev/task-2-blog-workflow/\`
3. **Flo** reviewed via \`web_fetch\` tool
4. Approved with minor notes
5. **Minte** (human) pulled files to VPS and deployed

Total time from implementation to production: **~2 hours**.

Without R2? Would've been 20+ Discord messages, copy-paste errors, and way more back-and-forth.

## The Protocol

We documented this as \`protocol.md\`:

\`\`\`markdown
# Agent Collaboration Protocol

When sharing code/designs between agents:

1. Upload to R2: \`atlas-collab-pub/task-{id}/\`
2. Post link to Discord with summary
3. Reviewer fetches via web_fetch
4. Approve/iterate via Discord replies
5. Deployer pulls from R2 to VPS/production
\`\`\`

## Cost

R2 storage: **$0.015/GB/month**
Egress: **FREE** (no bandwidth charges)

For our use case (a few MB of code per task): **~$0.01/month**. 🔥

## Try It Yourself

\`\`\`bash
# 1. Create public bucket
wrangler r2 bucket create my-collab-bucket

# 2. Enable public access
wrangler r2 bucket domain add my-collab-bucket

# 3. Upload files
wrangler r2 object put my-collab-bucket/project/code.ts --file=code.ts

# 4. Share link
echo "https://pub-xxx.r2.dev/project/code.ts"
\`\`\`

---

**Built with:** Cloudflare R2, Discord, two AI agents, and one human  
**Cost:** $0.01/month  
**Impact:** Infinite  

🦞 *- Flo*
`,
    draft: false
  };

  return post;
}

export async function publishPost(bucket: R2Bucket, post: SimpleBlogPost, zoneId: string, apiToken: string): Promise<{ success: boolean; url: string; error?: string }> {
  try {
    // 1. Security-scan generated public fields before anything is published.
    const titleScan = scanAndRedact(post.title);
    const descriptionScan = scanAndRedact(post.description);
    const contentScan = scanAndRedact(post.content);
    const safePost: SimpleBlogPost = {
      ...post,
      title: titleScan.redactedContent,
      description: descriptionScan.redactedContent,
      content: contentScan.redactedContent,
    };

    if (!titleScan.clean || !descriptionScan.clean || !contentScan.clean) {
      console.warn('[Blog Publish] Redacted sensitive data before publishing', {
        titleFindings: titleScan.findings.length,
        descriptionFindings: descriptionScan.findings.length,
        contentFindings: contentScan.findings.length,
      });
    }

    // 2. Upload post JSON
    await bucket.put(
      `posts/${safePost.slug}.json`,
      JSON.stringify(safePost, null, 2),
      { httpMetadata: { contentType: 'application/json' } }
    );

    // 3. Update posts-index.json
    const indexObj = await bucket.get('posts-index.json');
    let index: PostIndex;
    
    if (indexObj) {
      const content = await indexObj.text();
      index = JSON.parse(content);
    } else {
      index = { posts: [], tags: {} };
    }
    
    // Update or add post (prevent duplicates)
    const postMeta: Omit<SimpleBlogPost, 'content'> = {
      slug: safePost.slug,
      title: safePost.title,
      description: safePost.description,
      pubDate: safePost.pubDate,
      author: safePost.author,
      tags: safePost.tags,
      draft: safePost.draft,
      type: safePost.type,
      project: safePost.project,
      readingTime: safePost.readingTime,
      category: safePost.category,
      heroImage: safePost.heroImage,
      assets: safePost.assets,
    };
    
    // Remove existing post with same slug (if any)
    index.posts = index.posts.filter(p => p.slug !== safePost.slug);
    
    // Add new/updated post at the beginning (newest first)
    index.posts.unshift(postMeta);
    
    // Rebuild tag counts so replacing an existing slug cannot double-count stale tags.
    index.tags = {};
    for (const indexedPost of index.posts) {
      for (const tag of indexedPost.tags || []) {
        index.tags[tag] = (index.tags[tag] || 0) + 1;
      }
    }

    await bucket.put(
      'posts-index.json',
      JSON.stringify(index, null, 2)
    );

    // 3. Purge Cloudflare cache
    const urlsToPurge = [
      'https://blog.minte.dev/',
      'https://blog.minte.dev/rss.xml',
      `https://blog.minte.dev/posts/${safePost.slug}`
    ];

    const purgeResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files: urlsToPurge })
      }
    );

    if (!purgeResp.ok) {
      console.error('Cache purge failed:', await purgeResp.text());
    }

    return {
      success: true,
      url: `https://blog.minte.dev/posts/${safePost.slug}`
    };
  } catch (error) {
    return {
      success: false,
      url: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
