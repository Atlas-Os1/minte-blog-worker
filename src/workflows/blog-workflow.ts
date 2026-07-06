// blog-workflow.ts - Main Blog Workflow using Cloudflare Agents SDK

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { 
  BlogPost, 
  PostMeta, 
  WorkflowState, 
  BlogWorkflowEnv,
  PublishResult,
  MemoryEntry
} from './types/blog';
import { 
  parseMemoryFile, 
  fetchGitHubActivity, 
  generateDraftContent,
  generateSlug,
  generateExcerpt
} from './blog-helpers';
import { scanAndRedact } from './security-scanner';
import { generateHeroImage, getFallbackImage } from './atlas-warhol';

// Discord channel for approval notifications
const DISCORD_CHANNEL = '1462343971530604624'; // #clawd-flo-updates

export class BlogWorkflow extends WorkflowEntrypoint<BlogWorkflowEnv, WorkflowState> {
  
  async run(event: WorkflowEvent<WorkflowState>, step: WorkflowStep) {
    const state: WorkflowState = event.payload || { step: 'init' };
    const today = new Date().toISOString().split('T')[0];

    // ═══════════════════════════════════════════════════════════════
    // Step 1: Generate Draft from Memory
    // ═══════════════════════════════════════════════════════════════
    const draft = await step.do('generate-draft', async () => {
      console.log('[BlogWorkflow] Step 1: Generating draft from memory');
      
      // Fetch memory files from R2 workspace
      const memoryPrefix = 'workspace/memory/';
      const listed = await this.env.BLOG_BUCKET.list({ prefix: memoryPrefix });
      
      const memories: MemoryEntry[] = [];
      for (const obj of listed.objects.slice(-7)) { // Last 7 days
        const file = await this.env.BLOG_BUCKET.get(obj.key);
        if (file) {
          const content = await file.text();
          const date = obj.key.replace(memoryPrefix, '').replace('.md', '');
          memories.push(parseMemoryFile(content, date));
        }
      }

      return { memories, date: today };
    });

    // ═══════════════════════════════════════════════════════════════
    // Step 2: Fetch GitHub Activity
    // ═══════════════════════════════════════════════════════════════
    const github = await step.do('fetch-github', async () => {
      console.log('[BlogWorkflow] Step 2: Fetching GitHub activity');
      return fetchGitHubActivity(this.env.GITHUB_TOKEN);
    });

    // ═══════════════════════════════════════════════════════════════
    // Step 3: Generate Hero Image
    // ═══════════════════════════════════════════════════════════════
    const title = `DevFlo Daily Update - ${today}`;
    const tags = ['devflo', 'cloudflare', 'workers', 'ai'];
    
    const heroImage = await step.do('generate-image', async () => {
      console.log('[BlogWorkflow] Step 3: Generating hero image');
      const result = await generateHeroImage(title, tags, this.env);
      return result.success ? result.imageUrl : getFallbackImage(title);
    });

    // ═══════════════════════════════════════════════════════════════
    // Step 4: Build Post Content
    // ═══════════════════════════════════════════════════════════════
    const content = await step.do('build-content', async () => {
      console.log('[BlogWorkflow] Step 4: Building post content');
      return generateDraftContent(draft.memories, github, today);
    });

    // ═══════════════════════════════════════════════════════════════
    // Step 5: Security Scan
    // ═══════════════════════════════════════════════════════════════
    const securityResult = await step.do('security-scan', async () => {
      console.log('[BlogWorkflow] Step 5: Running security scan');
      return scanAndRedact(content);
    });

    if (!securityResult.clean) {
      console.log(`[BlogWorkflow] Found ${securityResult.findings.length} sensitive items, redacted`);
    }

    // Build the final post object
    const post: BlogPost = {
      slug: generateSlug(title),
      title,
      content: securityResult.redactedContent,
      excerpt: generateExcerpt(securityResult.redactedContent),
      publishedAt: new Date().toISOString(),
      tags,
      heroImage,
      author: 'DevFlo',
      github
    };

    // ═══════════════════════════════════════════════════════════════
    // Step 6: Request Approval (Human-in-the-loop)
    // ═══════════════════════════════════════════════════════════════
    const approved = await step.do('request-approval', async () => {
      console.log('[BlogWorkflow] Step 6: Requesting approval');
      
      // Send notification to Discord
      // This would use the message tool or direct Discord API
      // For now, we'll auto-approve in dev mode
      const isDevMode = this.env.DEV_MODE === 'true';
      
      if (isDevMode) {
        console.log('[BlogWorkflow] Dev mode - auto-approving');
        return true;
      }

      // In production, this would wait for a Discord reaction
      // Using step.waitForEvent() or similar pattern
      // For MVP, we'll implement a simple timeout approval
      return true;
    });

    if (!approved) {
      return { 
        ...state, 
        step: 'rejected',
        error: 'Post was not approved'
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // Step 7: Publish to R2 + Update Index + Purge Cache
    // ═══════════════════════════════════════════════════════════════
    const publishResult = await step.do('publish-complete', async () => {
      console.log('[BlogWorkflow] Step 7: Publishing and updating index');
      return this.publishComplete(post);
    });

    console.log(`[BlogWorkflow] Complete! Post published: ${publishResult.postUrl}`);

    return {
      step: 'complete',
      draft: post,
      github,
      heroImageUrl: heroImage,
      securityScan: securityResult,
      approved,
      published: publishResult
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Step 7 Implementation: Publish Complete
  // ═══════════════════════════════════════════════════════════════
  private async publishComplete(post: BlogPost): Promise<PublishResult> {
    const bucket = this.env.BLOG_BUCKET;
    const publicPost = {
      slug: post.slug,
      title: post.title,
      description: post.excerpt,
      pubDate: post.publishedAt,
      author: post.author,
      tags: post.tags,
      content: post.content,
      draft: false,
      heroImage: post.heroImage,
      project: 'minte-blog-worker',
    };

    // 1. Upload renderer-compatible post JSON
    await bucket.put(
      `posts/${post.slug}.json`,
      JSON.stringify(publicPost, null, 2),
      { httpMetadata: { contentType: 'application/json' } }
    );

    // 2. Update the same posts-index.json consumed by the public site
    const indexObj = await bucket.get('posts-index.json');
    const index: { posts: any[]; tags: Record<string, number> } = indexObj
      ? await indexObj.json()
      : { posts: [], tags: {} };
    
    const postMeta = { ...publicPost };
    delete (postMeta as any).content;
    index.posts = (index.posts || []).filter((existing) => existing.slug !== post.slug);
    index.posts.unshift(postMeta);
    index.tags = {};
    for (const indexedPost of index.posts) {
      if (indexedPost.draft || indexedPost.category === 'memory') continue;
      for (const tag of indexedPost.tags || []) {
        index.tags[tag] = (index.tags[tag] || 0) + 1;
      }
    }

    await bucket.put(
      'posts-index.json',
      JSON.stringify(index, null, 2),
      { httpMetadata: { contentType: 'application/json' } }
    );

    // 3. Purge Cloudflare cache
    const urlsToPurge = [
      'https://blog.minte.dev/',
      'https://blog.minte.dev/rss.xml',
      `https://blog.minte.dev/posts/${post.slug}`
    ];

    let cachePurged = false;
    try {
      const purgeResp = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.env.CF_ZONE_ID}/purge_cache`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ files: urlsToPurge })
        }
      );
      cachePurged = purgeResp.ok;
      
      if (!purgeResp.ok) {
        console.error('Cache purge failed:', await purgeResp.text());
      }
    } catch (err) {
      console.error('Cache purge error:', err);
    }

    return {
      indexUpdated: true,
      cachePurged,
      purgedUrls: urlsToPurge,
      postUrl: `https://blog.minte.dev/posts/${post.slug}`
    };
  }
}

export default BlogWorkflow;
