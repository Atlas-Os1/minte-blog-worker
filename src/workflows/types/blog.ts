// blog.ts - TypeScript interfaces for Blog Workflow

export interface BlogPost {
  slug: string;
  title: string;
  content: string;
  excerpt: string;
  publishedAt: string;
  tags: string[];
  heroImage?: string;
  assets?: string[];
  author: string;
  github?: GitHubActivity;
}

export interface PostMeta {
  slug: string;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
  heroImage?: string;
}

export interface GitHubActivity {
  commits: GitHubCommit[];
  pullRequests: GitHubPR[];
  fetchedAt: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
  url: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  author: string;
  repo: string;
  url: string;
  mergedAt?: string;
}

export interface MemoryEntry {
  date: string;
  content: string;
  headers: string[];
  codeBlocks: string[];
}

export interface SecurityScanResult {
  clean: boolean;
  redactedContent: string;
  findings: SecurityFinding[];
}

export interface SecurityFinding {
  type: 'api_key' | 'token' | 'ip_address' | 'private_endpoint' | 'secret' | 'credential';
  pattern: string;
  line: number;
  redacted: string;
}

export interface PublishResult {
  indexUpdated: boolean;
  cachePurged: boolean;
  purgedUrls: string[];
  postUrl: string;
}

export interface WorkflowState {
  step: string;
  draft?: BlogPost;
  github?: GitHubActivity;
  heroImageUrl?: string;
  securityScan?: SecurityScanResult;
  approved?: boolean;
  published?: PublishResult;
  error?: string;
}

export interface BlogWorkflowEnv {
  BLOG_BUCKET: R2Bucket;
  CF_ZONE_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GITHUB_TOKEN: string;
  AI: Ai;
  DEV_MODE?: string;
}
