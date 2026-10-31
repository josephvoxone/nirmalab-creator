import { describe, expect, it } from 'vitest';
import { MCP_CLIENTS, TOKEN_PLACEHOLDER, snippetFor, type McpClient } from './mcpSnippets.js';

const URL = 'https://creator.nirmalab.com/mcp';
const REAL = 'nmcp_live_0123456789abcdef';
const all = (s: ReturnType<typeof snippetFor>) => [s.text, s.extra?.text ?? '', ...s.steps].join('\n');

describe('snippetFor', () => {
  it('uses the literal <TOKEN> placeholder', () => {
    expect(TOKEN_PLACEHOLDER).toBe('<TOKEN>');
  });

  it.each(MCP_CLIENTS.map(c => c.id))('%s: has the URL and the placeholder by default, a real token only when passed', (client: McpClient) => {
    const plain = snippetFor(client, URL);
    expect(plain.text).toContain(URL);
    expect(all(plain)).toContain('<TOKEN>');
    expect(all(plain)).not.toContain(REAL);
    expect(plain.steps.length).toBeGreaterThanOrEqual(2);
    expect(plain.docUrl).toMatch(/^https:\/\//);
    const real = snippetFor(client, URL, REAL);
    expect(all(real)).toContain(REAL);
    expect(all(real)).not.toContain('<TOKEN>');
  });

  it('JSON snippets parse', () => {
    for (const client of ['claude-desktop', 'cursor', 'opencode'] as const) {
      const s = snippetFor(client, URL);
      expect(s.language).toBe('json');
      expect(() => JSON.parse(s.text)).not.toThrow();
    }
  });

  it('claude-code: remote HTTP transport with an Authorization header', () => {
    const s = snippetFor('claude-code', URL);
    expect(s.language).toBe('bash');
    expect(s.text).toBe(`claude mcp add --transport http shotweave ${URL} --header "Authorization: Bearer <TOKEN>"`);
    expect(s.docUrl).toBe('https://docs.claude.com/en/docs/claude-code/mcp');
  });

  it('claude-desktop: mcp-remote shim, header from AUTH_HEADER env, Node 18+ named', () => {
    const s = snippetFor('claude-desktop', URL);
    const server = JSON.parse(s.text).mcpServers.shotweave;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'mcp-remote', URL, '--header', 'Authorization:${AUTH_HEADER}']);
    expect(server.env).toEqual({ AUTH_HEADER: 'Bearer <TOKEN>' });
    expect(s.file).toMatch(/claude_desktop_config\.json/);
    expect(s.steps.join(' ')).toMatch(/Node\.js 18/);
  });

  it('cursor: url + headers', () => {
    const s = snippetFor('cursor', URL);
    expect(JSON.parse(s.text)).toEqual({ mcpServers: { shotweave: { url: URL, headers: { Authorization: 'Bearer <TOKEN>' } } } });
    expect(s.file).toMatch(/\.cursor\/mcp\.json/);
    expect(s.docUrl).toBe('https://cursor.com/docs/context/mcp');
  });

  it('opencode: type remote + headers', () => {
    const s = snippetFor('opencode', URL);
    expect(JSON.parse(s.text)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { shotweave: { type: 'remote', url: URL, enabled: true, headers: { Authorization: 'Bearer <TOKEN>' } } }
    });
    expect(s.file).toMatch(/opencode\.json/);
  });

  it('codex: TOML with bearer_token_env_var, token goes into an export line', () => {
    const s = snippetFor('codex', URL);
    expect(s.language).toBe('toml');
    expect(s.text).toBe(`[mcp_servers.shotweave]\nurl = "${URL}"\nbearer_token_env_var = "NIRMALAB_MCP_TOKEN"`);
    expect(s.text).not.toContain('<TOKEN>');
    expect(s.extra).toEqual({ label: expect.any(String), language: 'bash', text: 'export NIRMALAB_MCP_TOKEN="<TOKEN>"' });
    expect(s.file).toBe('~/.codex/config.toml');
  });
});
