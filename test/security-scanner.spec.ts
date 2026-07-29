import { describe, expect, it } from 'vitest';
import { scanAndRedact } from '../src/workflows/security-scanner';

describe('blog security scanner', () => {
	it('redacts secrets and private endpoints before generated posts publish', () => {
		const content = [
			'Yesterday we checked http://100.67.178.115:8644/v1 for local agent health.',
			'A config note accidentally included password = supersecret123.',
			'Public copy should not mention 192.168.1.25:8787 either.',
		].join('\n');

		const result = scanAndRedact(content);

		expect(result.clean).toBe(false);
		expect(result.redactedContent).toContain('[PRIVATE_ENDPOINT_REDACTED]');
		expect(result.redactedContent).toMatch(/password\s*:\s*\[REDACTED\]/);
		expect(result.redactedContent).not.toContain('100.67.178.115');
		expect(result.redactedContent).not.toContain('192.168.1.25');
		expect(result.findings.map((finding) => finding.type)).toContain('private_endpoint');
	});
});
