// security-scanner.ts - Sensitive data detection and redaction

import type { SecurityScanResult, SecurityFinding } from './types/blog';

// Patterns to detect sensitive data
const SENSITIVE_PATTERNS: Array<{
  type: SecurityFinding['type'];
  pattern: RegExp;
  description: string;
}> = [
  // API Keys
  {
    type: 'api_key',
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    description: 'OpenAI API key'
  },
  {
    type: 'api_key',
    pattern: /sk-ant-[a-zA-Z0-9-]{40,}/g,
    description: 'Anthropic API key'
  },
  {
    type: 'api_key',
    pattern: /AIza[a-zA-Z0-9_-]{35}/g,
    description: 'Google API key'
  },
  {
    type: 'api_key',
    pattern: /sk_[a-zA-Z0-9]{24,}/g,
    description: 'ElevenLabs/Generic API key'
  },
  
  // Tokens
  {
    type: 'token',
    pattern: /ghp_[a-zA-Z0-9]{36}/g,
    description: 'GitHub Personal Access Token'
  },
  {
    type: 'token',
    pattern: /gho_[a-zA-Z0-9]{36}/g,
    description: 'GitHub OAuth Token'
  },
  {
    type: 'token',
    pattern: /\b[A-Z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g,
    description: 'Discord Bot Token'
  },
  {
    type: 'token',
    pattern: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/g,
    description: 'Telegram Bot Token'
  },
  {
    type: 'token',
    pattern: /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
    description: 'Slack Token'
  },
  
  // Secrets
  {
    type: 'secret',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    description: 'Private Key'
  },
  {
    type: 'secret',
    pattern: /AKIA[A-Z0-9]{16}/g,
    description: 'AWS Access Key ID'
  },
  {
    type: 'secret',
    pattern: /[a-f0-9]{32,64}/gi,
    description: 'Potential secret hash (32-64 hex chars)'
  },
  
  // Credentials
  {
    type: 'credential',
    pattern: /password\s*[:=]\s*["']?[^\s"']{8,}/gi,
    description: 'Password in config'
  },
  {
    type: 'credential',
    pattern: /secret\s*[:=]\s*["']?[^\s"']{8,}/gi,
    description: 'Secret in config'
  },
  
  // Network endpoints. Public blog posts should not leak IPs or private/local endpoints.
  {
    type: 'private_endpoint',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?::\d+)?\b/g,
    description: 'Private/internal IP address or Tailscale endpoint'
  },
  {
    type: 'private_endpoint',
    pattern: /\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b/gi,
    description: 'Localhost endpoint'
  },
  {
    type: 'private_endpoint',
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/[^\s`)]*)?/gi,
    description: 'Private/internal URL'
  },
  {
    type: 'ip_address',
    pattern: /\b(?!10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    description: 'Public IP address'
  }
];

// Additional context patterns to reduce false positives
const FALSE_POSITIVE_CONTEXTS = [
  /example\.com/i,
  /placeholder/i,
  /your[-_]?api[-_]?key/i,
  /xxx+/i,
  /<[^>]+>/,  // HTML/template tags
];

/**
 * Scan content for sensitive data and redact it
 */
export function scanAndRedact(content: string): SecurityScanResult {
  const findings: SecurityFinding[] = [];
  let redactedContent = content;
  const lines = content.split('\n');

  for (const { type, pattern, description } of SENSITIVE_PATTERNS) {
    // Reset pattern state
    pattern.lastIndex = 0;
    
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const currentMatch = match;
      const matchedText = currentMatch[0];
      
      // Check for false positives
      const isFalsePositive = FALSE_POSITIVE_CONTEXTS.some(fp => {
        // Check surrounding context (50 chars before and after)
        const start = Math.max(0, currentMatch.index - 50);
        const end = Math.min(content.length, currentMatch.index + matchedText.length + 50);
        const context = content.slice(start, end);
        return fp.test(context);
      });

      if (isFalsePositive) continue;

      // Find line number
      let charCount = 0;
      let lineNum = 1;
      for (const line of lines) {
        charCount += line.length + 1; // +1 for newline
        if (charCount > currentMatch.index) break;
        lineNum++;
      }

      // Generate redaction
      const redacted = generateRedaction(matchedText, type);

      findings.push({
        type,
        pattern: description,
        line: lineNum,
        redacted
      });

      // Apply redaction
      redactedContent = redactedContent.replace(matchedText, redacted);
    }
  }

  return {
    clean: findings.length === 0,
    redactedContent,
    findings
  };
}

/**
 * Generate appropriate redaction for different secret types
 */
function generateRedaction(text: string, type: SecurityFinding['type']): string {
  switch (type) {
    case 'api_key':
      // Keep prefix for identification
      if (text.startsWith('sk-ant-')) return 'sk-ant-[REDACTED]';
      if (text.startsWith('sk-')) return 'sk-[REDACTED]';
      if (text.startsWith('AIza')) return 'AIza[REDACTED]';
      return '[API_KEY_REDACTED]';
    
    case 'token':
      if (text.startsWith('ghp_')) return 'ghp_[REDACTED]';
      if (text.startsWith('xox')) return 'xox[REDACTED]';
      return '[TOKEN_REDACTED]';
    
    case 'secret':
      if (text.includes('PRIVATE KEY')) return '[PRIVATE_KEY_REDACTED]';
      if (text.startsWith('AKIA')) return 'AKIA[REDACTED]';
      // For hex hashes, show first/last 4 chars
      if (/^[a-f0-9]+$/i.test(text) && text.length >= 32) {
        return `${text.slice(0, 4)}...[REDACTED]...${text.slice(-4)}`;
      }
      return '[SECRET_REDACTED]';
    
    case 'credential':
      return text.replace(/[:=]\s*["']?[^\s"']+/, ': [REDACTED]');
    
    case 'ip_address':
      return text.replace(/\d+\.\d+\.\d+\.\d+/, '[IP_REDACTED]');

    case 'private_endpoint':
      return '[PRIVATE_ENDPOINT_REDACTED]';
    
    default:
      return '[REDACTED]';
  }
}

/**
 * Quick check if content likely contains sensitive data
 */
export function quickScan(content: string): boolean {
  for (const { pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return true;
  }
  return false;
}
