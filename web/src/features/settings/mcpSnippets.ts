/**
 * Copy-paste MCP setup per client for Pengaturan › Integrasi. Formats checked against each client's
 * official docs on 2026-10-27:
 * - Claude Code:    https://docs.claude.com/en/docs/claude-code/mcp (remote HTTP, `--transport http`, `--header`)
 * - Claude Desktop: https://modelcontextprotocol.io/docs/develop/connect-remote-servers (Custom Connectors need
 *                   OAuth, no static bearer) → https://github.com/geelen/mcp-remote ("Custom Headers": no spaces
 *                   inside args, the bearer lives in env `AUTH_HEADER`; needs Node.js 18+)
 * - Cursor:         https://cursor.com/docs/context/mcp (mcp.json, remote entries = `url` + `headers`)
 * - OpenCode:       https://opencode.ai/docs/mcp-servers/ (`type: "remote"`, `url`, `enabled`, `headers`)
 * - Codex:          https://developers.openai.com/codex/mcp/ (streamable HTTP: `url` + `bearer_token_env_var`)
 * The token defaults to the literal placeholder; a real token is only passed while it is revealed once
 * after creation (kept in memory by the panel, never persisted).
 */
export type McpClient = 'claude-code' | 'claude-desktop' | 'cursor' | 'opencode' | 'codex';

export type McpSnippet = {
  file?: string;
  language: 'bash' | 'json' | 'toml';
  text: string;
  /** A second block to copy (Codex keeps the token in an env var set from the shell profile). */
  extra?: { label: string; language: 'bash'; text: string };
  steps: string[];
  docUrl: string;
};

export const TOKEN_PLACEHOLDER = '<TOKEN>';
const SERVER = 'shotweave';
const CODEX_ENV = 'NIRMALAB_MCP_TOKEN';

export const MCP_CLIENTS: Array<{ id: McpClient; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'codex', label: 'Codex' }
];

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function snippetFor(client: McpClient, url: string, token: string = TOKEN_PLACEHOLDER): McpSnippet {
  const bearer = `Bearer ${token}`;
  switch (client) {
    case 'claude-code':
      return {
        language: 'bash',
        text: `claude mcp add --transport http ${SERVER} ${url} --header "Authorization: ${bearer}"`,
        steps: [
          'Buka terminal di folder proyek tempat kamu memakai Claude Code.',
          'Jalankan perintah di bawah. Tambahkan --scope user agar tersedia di semua proyek.',
          'Cek dengan claude mcp list (shotweave ✓ connected) atau ketik /mcp di Claude Code.'
        ],
        docUrl: 'https://docs.claude.com/en/docs/claude-code/mcp'
      };
    case 'claude-desktop':
      return {
        file: '~/Library/Application Support/Claude/claude_desktop_config.json (macOS) · %APPDATA%\\Claude\\claude_desktop_config.json (Windows)',
        language: 'json',
        text: json({
          mcpServers: {
            [SERVER]: {
              command: 'npx',
              args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
              env: { AUTH_HEADER: bearer }
            }
          }
        }),
        steps: [
          'Pasang Node.js 18+ dulu: Claude Desktop belum menerima token tetap, jadi koneksi lewat perantara mcp-remote (npx).',
          'Buka Claude Desktop → Settings → Developer → Edit Config, lalu tempel blok di bawah (gabungkan dengan mcpServers yang sudah ada).',
          'Tutup Claude Desktop sepenuhnya lalu buka lagi.'
        ],
        docUrl: 'https://github.com/geelen/mcp-remote#custom-headers'
      };
    case 'cursor':
      return {
        file: '~/.cursor/mcp.json (semua proyek) atau .cursor/mcp.json (satu proyek)',
        language: 'json',
        text: json({ mcpServers: { [SERVER]: { url, headers: { Authorization: bearer } } } }),
        steps: [
          'Buka atau buat file mcp.json di lokasi di bawah.',
          'Tempel blok di bawah (gabungkan dengan mcpServers yang sudah ada), lalu simpan.',
          'Cek di Cursor Settings → MCP: shotweave bertitik hijau.'
        ],
        docUrl: 'https://cursor.com/docs/context/mcp'
      };
    case 'opencode':
      return {
        file: '~/.config/opencode/opencode.json (semua proyek) atau opencode.json (satu proyek)',
        language: 'json',
        text: json({
          $schema: 'https://opencode.ai/config.json',
          mcp: { [SERVER]: { type: 'remote', url, enabled: true, headers: { Authorization: bearer } } }
        }),
        steps: [
          'Buka atau buat file opencode.json di lokasi di bawah.',
          'Tempel blok di bawah (gabungkan dengan bagian mcp yang sudah ada), lalu simpan.',
          'Jalankan ulang OpenCode; tools shotweave muncul di daftar MCP.'
        ],
        docUrl: 'https://opencode.ai/docs/mcp-servers/'
      };
    case 'codex':
      return {
        file: '~/.codex/config.toml',
        language: 'toml',
        text: `[mcp_servers.${SERVER}]\nurl = "${url}"\nbearer_token_env_var = "${CODEX_ENV}"`,
        extra: { label: 'Variabel token (~/.zshrc atau ~/.bashrc)', language: 'bash', text: `export ${CODEX_ENV}="${token}"` },
        steps: [
          'Tempel blok config di bawah ke ~/.codex/config.toml.',
          'Tambahkan baris export ke ~/.zshrc atau ~/.bashrc, lalu buka terminal baru.',
          'Cek dengan codex mcp list.'
        ],
        docUrl: 'https://developers.openai.com/codex/mcp/'
      };
  }
}
