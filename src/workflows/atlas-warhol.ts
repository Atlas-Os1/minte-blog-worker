// atlas-warhol.ts - Warhol-style hero image generation using Workers AI

import type { BlogWorkflowEnv } from './types/blog';

interface ImageGenerationResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

// Warhol-inspired color palettes
const WARHOL_PALETTES = [
  ['#FF6B6B', '#4ECDC4', '#FFE66D', '#95E1D3'],  // Vibrant pop
  ['#F38181', '#FCE38A', '#EAFFD0', '#95E1D3'],  // Sunset pop
  ['#6C5CE7', '#A29BFE', '#FD79A8', '#FDCB6E'],  // Purple dream
  ['#00B894', '#00CEC9', '#0984E3', '#6C5CE7'],  // Ocean tech
  ['#E17055', '#FDCB6E', '#00B894', '#74B9FF'],  // Warm contrast
];

/**
 * Generate a Warhol-style hero image for a blog post
 */
export async function generateHeroImage(
  title: string,
  tags: string[],
  env: BlogWorkflowEnv
): Promise<ImageGenerationResult> {
  try {
    // Build the prompt
    const palette = WARHOL_PALETTES[Math.floor(Math.random() * WARHOL_PALETTES.length)];
    const colorDesc = palette.join(', ');
    
    const prompt = buildWarholPrompt(title, tags, colorDesc);

    // Use Workers AI for image generation
    // @cf/stabilityai/stable-diffusion-xl-base-1.0 or @cf/bytedance/stable-diffusion-xl-lightning
    const response = await env.AI.run('@cf/bytedance/stable-diffusion-xl-lightning', {
      prompt,
      num_steps: 4,  // Lightning model uses fewer steps
    });

    if (!response) {
      return { success: false, error: 'No response from AI model' };
    }

    // Response is a ReadableStream of image bytes
    const imageBuffer = response as ArrayBuffer;
    
    // Upload to R2
    const imageKey = `images/hero-${Date.now()}.png`;
    await env.BLOG_BUCKET.put(imageKey, imageBuffer, {
      httpMetadata: { contentType: 'image/png' }
    });

    // Return the public URL
    const imageUrl = `https://blog.minte.dev/${imageKey}`;

    return { success: true, imageUrl };
  } catch (error) {
    console.error('Image generation failed:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * Build a Warhol-inspired prompt from blog title and tags
 */
function buildWarholPrompt(title: string, tags: string[], colors: string): string {
  // Extract key concepts from title
  const concepts = extractConcepts(title);
  
  // Map tech tags to visual elements
  const visualElements = tags.map(tagToVisual).filter(Boolean);

  const basePrompt = [
    'Andy Warhol pop art style',
    'bold flat colors',
    'high contrast',
    'screen print aesthetic',
    'repetition pattern',
    `color palette: ${colors}`,
    'clean graphic design',
    'modern tech illustration',
  ].join(', ');

  const subjectPrompt = [
    ...concepts.slice(0, 3),
    ...visualElements.slice(0, 2),
    'abstract geometric shapes',
    'digital circuit patterns',
  ].join(', ');

  return `${basePrompt}, featuring: ${subjectPrompt}`;
}

/**
 * Extract visual concepts from title
 */
function extractConcepts(title: string): string[] {
  const concepts: string[] = [];
  const lower = title.toLowerCase();

  // Tech concepts
  if (lower.includes('api') || lower.includes('endpoint')) concepts.push('API gateway icon');
  if (lower.includes('database') || lower.includes('d1') || lower.includes('sql')) concepts.push('database cylinder');
  if (lower.includes('worker') || lower.includes('serverless')) concepts.push('cloud computing');
  if (lower.includes('deploy') || lower.includes('ci/cd')) concepts.push('rocket launch');
  if (lower.includes('blog') || lower.includes('content')) concepts.push('newspaper layout');
  if (lower.includes('ai') || lower.includes('machine learning')) concepts.push('neural network');
  if (lower.includes('github') || lower.includes('git')) concepts.push('code branches');
  if (lower.includes('security') || lower.includes('auth')) concepts.push('lock and key');
  if (lower.includes('cache') || lower.includes('performance')) concepts.push('speedometer');

  // Default concepts if none found
  if (concepts.length === 0) {
    concepts.push('computer terminal', 'code symbols', 'tech icons');
  }

  return concepts;
}

/**
 * Map tags to visual elements
 */
function tagToVisual(tag: string): string | null {
  const mapping: Record<string, string> = {
    'cloudflare': 'orange cloud',
    'workers': 'serverless function',
    'r2': 'storage bucket',
    'd1': 'database icon',
    'kv': 'key-value pairs',
    'typescript': 'TS logo',
    'javascript': 'JS logo',
    'react': 'react atom logo',
    'api': 'REST endpoint',
    'github': 'octocat silhouette',
    'devops': 'infinity loop',
    'security': 'shield icon',
    'ai': 'brain circuit',
  };

  return mapping[tag.toLowerCase()] || null;
}

/**
 * Generate a fallback placeholder image URL if generation fails
 */
export function getFallbackImage(title: string): string {
  // Use a deterministic color based on title
  const hash = title.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const palette = WARHOL_PALETTES[hash % WARHOL_PALETTES.length];
  const bgColor = palette[0].replace('#', '');
  const textColor = palette[3].replace('#', '');
  
  // Use a placeholder service
  const encodedTitle = encodeURIComponent(title.slice(0, 30));
  return `https://via.placeholder.com/1200x630/${bgColor}/${textColor}?text=${encodedTitle}`;
}
