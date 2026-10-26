import { useEffect, useState } from 'react';
import { Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import type { McpServer } from '@hive/core';
import { Section } from './settings';
import { useTask } from './ui';

type Template = Omit<McpServer, 'id' | 'enabled'>;

const blank: Template = {
  name: 'servidor',
  transport: 'stdio',
  command: 'npx',
  args: [],
  env: {},
  url: '',
  headers: {},
  approval: 'ask',
};

/** Servers worth one click: each gives the agents something they cannot do on their own. */
const presets: { label: string; detail: string; server: Template }[] = [
  {
    label: 'Playwright',
    detail: 'Um navegador de verdade: abrir páginas, clicar, preencher e testar fluxos.',
    server: {
      ...blank,
      name: 'playwright',
      args: ['-y', '@playwright/mcp@latest', '--headless'],
    },
  },
  {
    label: 'Context7',
    detail: 'Documentação atualizada de bibliotecas e frameworks.',
    server: {
      ...blank,
      name: 'context7',
      transport: 'http',
      command: '',
      url: 'https://mcp.context7.com/mcp',
      approval: 'auto',
    },
  },
  {
    label: 'GitHub',
    detail: 'Issues, pull requests e código no GitHub. Troque SEU_TOKEN por um token de acesso.',
    server: {
      ...blank,
      name: 'github',
      transport: 'http',
      command: '',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer SEU_TOKEN' },
    },
  },
];

function summary(server: McpServer): string {
  return server.transport === 'http'
    ? server.url || 'sem URL'
    : [server.command, ...server.args].join(' ').trim() || 'sem comando';
}

/** Tool names go to the model as `mcp__<name>__…`, so only letters, digits, - and _. */
function cleanName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
}

function uniqueName(name: string, servers: McpServer[]): string {
  let candidate = name;
  for (let n = 2; servers.some((server) => server.name === candidate); n++)
    candidate = `${name}-${n}`;
  return candidate;
}

/** The MCP servers in Settings, edited as part of the settings draft and saved with it. */
export function McpServersSection({
  servers,
  onChange,
}: {
  servers: McpServer[];
  onChange(servers: McpServer[]): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const update = (id: string, patch: Partial<McpServer>) =>
    onChange(servers.map((server) => (server.id === id ? { ...server, ...patch } : server)));

  function add(template: Template) {
    const server: McpServer = {
      ...template,
      id: crypto.randomUUID(),
      name: uniqueName(template.name, servers),
      enabled: true,
    };
    onChange([...servers, server]);
    setEditing(server.id);
  }

  return (
    <Section
      title="Servidores MCP"
      description="Dão ferramentas novas aos agentes: navegador, GitHub, banco de dados, documentação. Cada agente escolhe quais usa, na gaveta dele."
    >
      {servers.length > 0 && (
        <div className="rows">
          {servers.map((server) => (
            <McpRow
              key={server.id}
              server={server}
              editing={editing === server.id}
              onEdit={() => setEditing(editing === server.id ? null : server.id)}
              onChange={(patch) => update(server.id, patch)}
              onRemove={() => onChange(servers.filter((item) => item.id !== server.id))}
            />
          ))}
        </div>
      )}
      <div className="mcp-add">
        <button className="secondary" onClick={() => add(blank)}>
          <Plus size={13} /> Adicionar servidor
        </button>
        {presets.map((preset) => (
          <button
            key={preset.label}
            className="ghost"
            title={preset.detail}
            onClick={() => add(preset.server)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function McpRow({
  server,
  editing,
  onEdit,
  onChange,
  onRemove,
}: {
  server: McpServer;
  editing: boolean;
  onEdit(): void;
  onChange(patch: Partial<McpServer>): void;
  onRemove(): void;
}) {
  const task = useTask();
  const [tools, setTools] = useState<string[] | null>(null);

  function test() {
    setTools(null);
    void task.run(async () => {
      const probe = await window.hive.invoke('mcp.test', server);
      setTools(probe.tools.map((tool) => tool.name));
    });
  }

  return (
    <div className="mcp-server">
      <div className="row static">
        <input
          type="checkbox"
          className="mcp-toggle"
          checked={server.enabled}
          title={server.enabled ? 'Ligado' : 'Desligado'}
          aria-label={`Ligar ${server.name}`}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        <span className="row-main">
          <span>{server.name}</span>
          <small>
            <code>{summary(server)}</code>
          </small>
        </span>
        <button className="secondary" disabled={task.running} onClick={test}>
          <Plug size={13} /> {task.running ? 'Testando…' : 'Testar'}
        </button>
        <button
          className="icon-button"
          title="Editar"
          aria-label={`Editar ${server.name}`}
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-button"
          title="Remover"
          aria-label={`Remover ${server.name}`}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {(task.error || tools) && (
        <p className={task.error ? 'mcp-probe error-text' : 'mcp-probe'} role="status">
          {task.error
            ? task.error
            : tools!.length
              ? `${tools!.length} ferramenta${tools!.length > 1 ? 's' : ''}: ${tools!.join(', ')}`
              : 'Conectou, mas o servidor não oferece ferramentas.'}
        </p>
      )}
      {editing && <McpEditor server={server} onChange={onChange} />}
    </div>
  );
}

function McpEditor({
  server,
  onChange,
}: {
  server: McpServer;
  onChange(patch: Partial<McpServer>): void;
}) {
  return (
    <div className="mcp-editor">
      <div className="settings-grid">
        <label className="settings-field">
          <span>Nome</span>
          <input
            value={server.name}
            onChange={(event) => onChange({ name: cleanName(event.target.value) })}
          />
          <small>Aparece para os agentes nas ferramentas, como mcp__{server.name}__….</small>
        </label>
        <label className="settings-field">
          <span>Conexão</span>
          <select
            value={server.transport}
            onChange={(event) =>
              onChange({ transport: event.target.value as McpServer['transport'] })
            }
          >
            <option value="stdio">Programa local (stdio)</option>
            <option value="http">Servidor remoto (HTTP)</option>
          </select>
        </label>
      </div>
      {server.transport === 'stdio' ? (
        <>
          <label className="settings-field">
            <span>Comando</span>
            <input
              value={server.command}
              placeholder="npx"
              onChange={(event) => onChange({ command: event.target.value })}
            />
          </label>
          <LinesField
            label="Argumentos"
            hint="Um por linha."
            value={server.args}
            placeholder={'-y\n@playwright/mcp@latest'}
            onChange={(args) => onChange({ args })}
          />
          <PairsField
            label="Variáveis de ambiente"
            separator="="
            value={server.env}
            placeholder="GITHUB_TOKEN=..."
            onChange={(env) => onChange({ env })}
          />
        </>
      ) : (
        <>
          <label className="settings-field">
            <span>URL</span>
            <input
              value={server.url}
              placeholder="https://exemplo.com/mcp"
              onChange={(event) => onChange({ url: event.target.value })}
            />
          </label>
          <PairsField
            label="Cabeçalhos"
            separator=":"
            value={server.headers}
            placeholder="Authorization: Bearer ..."
            onChange={(headers) => onChange({ headers })}
          />
        </>
      )}
      <div className="choice-list" role="radiogroup" aria-label="Aprovação das chamadas">
        <label className="choice">
          <input
            type="radio"
            checked={server.approval === 'ask'}
            onChange={() => onChange({ approval: 'ask' })}
          />
          <span>
            <strong>Pedir aprovação a cada chamada</strong>
            <small>
              Como um comando. Para liberar sem perguntar, adicione <code>mcp {server.name} *</code>{' '}
              aos comandos liberados do agente.
            </small>
          </span>
        </label>
        <label className="choice">
          <input
            type="radio"
            checked={server.approval === 'auto'}
            onChange={() => onChange({ approval: 'auto' })}
          />
          <span>
            <strong>Confiar neste servidor</strong>
            <small>As chamadas rodam sem perguntar. Use só para servidores que apenas leem.</small>
          </span>
        </label>
      </div>
      <small className="field-hint">
        Variáveis e cabeçalhos ficam no banco local do Hive sem criptografia, como o resto das
        configurações.
      </small>
    </div>
  );
}

/** A textarea of one value per line that keeps what the user is typing as typed. */
function LinesField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string[];
  placeholder: string;
  onChange(value: string[]): void;
}) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <label className="settings-field">
      <span>{label}</span>
      <textarea
        rows={3}
        className="mono"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          onChange(
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          );
        }}
      />
      <small>{hint}</small>
    </label>
  );
}

function PairsField({
  label,
  separator,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  separator: '=' | ':';
  value: Record<string, string>;
  placeholder: string;
  onChange(value: Record<string, string>): void;
}) {
  const join = separator === '=' ? '=' : ': ';
  const [text, setText] = useState(
    Object.entries(value)
      .map(([key, item]) => `${key}${join}${item}`)
      .join('\n'),
  );
  return (
    <label className="settings-field">
      <span>
        {label} <span className="optional">(uma por linha)</span>
      </span>
      <textarea
        rows={2}
        className="mono"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          const pairs: Record<string, string> = {};
          for (const line of event.target.value.split('\n')) {
            const at = line.indexOf(separator);
            if (at <= 0) continue;
            pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
          }
          onChange(pairs);
        }}
      />
    </label>
  );
}

/** Which of the configured MCP servers one agent may call. */
export function AgentMcpSection({
  value,
  onChange,
}: {
  value: string[];
  onChange(value: string[]): void;
}) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  useEffect(() => {
    void window.hive
      .invoke('settings.get')
      .then((settings) => setServers(settings.mcpServers ?? []));
  }, []);
  if (!servers) return null;

  return (
    <section className="agent-section">
      <h3>Servidores MCP</h3>
      {servers.length ? (
        <div className="tool-list">
          {servers.map((server) => (
            <label key={server.id} className="tool-option">
              <input
                type="checkbox"
                checked={value.includes(server.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, server.id]
                      : value.filter((id) => id !== server.id),
                  )
                }
              />
              <span>
                {server.name}
                {!server.enabled && ' (desligado)'}
                <small>
                  {server.approval === 'auto' ? 'Sem pedir aprovação' : 'Pede aprovação'} ·{' '}
                  {summary(server)}
                </small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="field-hint">
          Nenhum servidor ainda. Adicione em Configurações → Servidores MCP.
        </p>
      )}
    </section>
  );
}
