import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  FileUp,
  History,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type {
  MarketplaceCatalog,
  MarketplaceCategory,
  MarketplaceInstalled,
  MarketplaceListing,
  MarketplacePreview,
} from '@hive/core';
import { useHive } from './context';
import { Empty, useTask } from './ui';

const categoryLabels: Record<MarketplaceCategory, string> = {
  agent: 'Agente',
  team: 'Equipe',
  skill: 'Skill',
  workflow: 'Workflow',
  template: 'Template',
  tool: 'Ferramenta',
};
type Tab = 'explore' | 'installed' | 'create';

/**
 * Hive Marketplace: agents, teams and skills to install and use in your projects, and your own
 * agents to share. Every package is checked before it is listed, and what it asks for is shown
 * before it is installed. Nothing here is a made-up rating or download count.
 */
export function MarketplacePage() {
  const { workers } = useHive();
  const [tab, setTab] = useState<Tab>('explore');
  const [catalog, setCatalog] = useState<MarketplaceCatalog | null>(null);
  const [installed, setInstalled] = useState<MarketplaceInstalled[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MarketplaceCategory | 'all'>('all');
  const [preview, setPreview] = useState<{ data: MarketplacePreview; token?: string } | null>(null);
  const [note, setNote] = useState('');
  const [registry, setRegistry] = useState('');
  const action = useTask();

  const load = useCallback(async (refresh = false) => {
    const [nextCatalog, nextInstalled] = await Promise.all([
      window.hive.invoke('marketplace.catalog', { refresh }),
      window.hive.invoke('marketplace.installed'),
    ]);
    setCatalog(nextCatalog);
    setInstalled(nextInstalled);
    setRegistry(nextCatalog.registryUrl ?? '');
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const listings = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (catalog?.listings ?? []).filter(
      (item) =>
        (category === 'all' || item.package.category === category) &&
        (!words ||
          [
            item.package.name,
            item.package.description,
            item.package.author.name,
            ...item.package.tags,
          ]
            .join(' ')
            .toLowerCase()
            .includes(words)),
    );
  }, [catalog, query, category]);
  const categories = useMemo(
    () => [...new Set((catalog?.listings ?? []).map((item) => item.package.category))],
    [catalog],
  );

  const run = (work: () => Promise<string | void>) =>
    void action.run(async () => {
      const message = await work();
      if (message) setNote(message);
      await load();
    });

  const open = (listing: MarketplaceListing) =>
    void action.run(async () =>
      setPreview({
        data: await window.hive.invoke('marketplace.preview', {
          source: listing.source,
          id: listing.package.id,
        }),
      }),
    );

  const install = () => {
    if (!preview) return;
    const { data, token } = preview;
    run(async () => {
      const done = token
        ? await window.hive.invoke('marketplace.installImported', token)
        : await window.hive.invoke('marketplace.install', {
            source: data.listing.source,
            id: data.listing.package.id,
          });
      setPreview(null);
      setTab('installed');
      return `${done.name} instalado. Escolha o modelo de ${Object.keys(done.workers).length === 1 ? 'seu agente' : 'cada agente'} na aba Agentes e ele já pode trabalhar nas suas missões.`;
    });
  };

  return (
    <div className="market">
      <section className="market-hero">
        <Store size={26} aria-hidden />
        <div>
          <h1>Marketplace</h1>
          <p className="muted">
            Agentes, equipes e skills para instalar e usar nos seus projetos. Cada pacote é
            conferido antes de aparecer aqui e mostra o que pede antes de ser instalado; nenhum traz
            chaves, modelos ou comandos que rodam sozinhos.
          </p>
        </div>
        <div className="market-hero-actions">
          <button
            className="ghost"
            disabled={action.running}
            onClick={() => run(async () => void (await load(true)))}
          >
            <RefreshCw size={14} /> Sincronizar
          </button>
          <button
            className="secondary"
            disabled={action.running}
            onClick={() =>
              void action.run(async () => {
                const opened = await window.hive.invoke('marketplace.import');
                if (opened) setPreview({ data: opened.preview, token: opened.token });
              })
            }
          >
            <FileUp size={14} /> Importar arquivo
          </button>
        </div>
      </section>

      <div className="market-tabs" role="tablist">
        {(
          [
            ['explore', 'Explorar', Search],
            ['installed', `Instalados (${installed.length})`, Package],
            ['create', 'Criar e exportar', Upload],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'ghost selected' : 'ghost'}
            onClick={() => setTab(id)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {(note || action.error) && (
        <p className={action.error ? 'error-text' : 'market-note'} role="status">
          {action.error || note}
        </p>
      )}

      {tab === 'explore' && (
        <>
          <div className="market-filters">
            <input
              aria-label="Buscar no Marketplace"
              placeholder="Buscar agentes, equipes e skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div role="group" aria-label="Categoria">
              {(['all', ...categories] as const).map((item) => (
                <button
                  key={item}
                  className={category === item ? 'ghost selected' : 'ghost'}
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
                >
                  {item === 'all' ? 'Todos' : `${categoryLabels[item]}s`}
                </button>
              ))}
            </div>
          </div>
          {!catalog ? (
            <p className="muted">Carregando o catálogo…</p>
          ) : listings.length ? (
            <ul className="market-grid">
              {listings.map((item) => (
                <li key={`${item.source}:${item.package.id}`}>
                  <button className="market-card" onClick={() => open(item)}>
                    <span className="market-card-head">
                      {item.package.category === 'team' ? (
                        <Users size={16} />
                      ) : (
                        <Package size={16} />
                      )}
                      <strong>{item.package.name}</strong>
                    </span>
                    <span className="market-card-meta">
                      {categoryLabels[item.package.category]} · v{item.package.version} ·{' '}
                      {item.package.author.name} · {item.source}
                    </span>
                    <span className="market-card-text">{item.package.description}</span>
                    <span className="market-card-tags">
                      {item.installedVersion && (
                        <span className="market-badge ok">
                          {item.updateAvailable
                            ? `Atualização: v${item.package.version}`
                            : 'Instalado'}
                        </span>
                      )}
                      {!item.installable && (
                        <span className="market-badge warn">Não instalável</span>
                      )}
                      {item.package.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="market-badge">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nada encontrado com esse filtro.</Empty>
          )}
          {catalog && catalog.rejected.length > 0 && (
            <details className="market-rejected">
              <summary>
                <ShieldAlert size={13} /> {catalog.rejected.length} pacote(s) recusado(s)
              </summary>
              <ul>
                {catalog.rejected.map((item) => (
                  <li key={`${item.source}:${item.path}`}>
                    {item.source} · {item.path}: {item.problem}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <form
            className="market-registry"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const next = await window.hive.invoke(
                  'marketplace.setRegistry',
                  registry.trim() || null,
                );
                setCatalog(next);
                return registry.trim()
                  ? 'Catálogo da comunidade sincronizado.'
                  : 'Catálogo da comunidade removido.';
              });
            }}
          >
            <label htmlFor="market-registry">
              Catálogo da comunidade (endereço https do index.json)
            </label>
            <div>
              <input
                id="market-registry"
                placeholder="https://raw.githubusercontent.com/<conta>/hive-marketplace/main"
                value={registry}
                onChange={(event) => setRegistry(event.target.value)}
              />
              <button className="ghost" disabled={action.running}>
                Salvar
              </button>
            </div>
          </form>
        </>
      )}

      {tab === 'installed' &&
        (installed.length ? (
          <ul className="market-installed">
            {installed.map((item) => {
              const listing = catalog?.listings.find(
                (entry) => entry.package.id === item.packageId,
              );
              return (
                <li key={item.packageId}>
                  <div>
                    <strong>{item.name}</strong>
                    <span className="muted">
                      {categoryLabels[item.category]} · v{item.version} · de {item.source} ·{' '}
                      {Object.keys(item.workers).length} agente(s)
                      {item.skills.length ? ` · ${item.skills.length} skill(s)` : ''}
                    </span>
                  </div>
                  {listing?.updateAvailable && (
                    <button
                      className="secondary"
                      disabled={action.running}
                      onClick={() =>
                        window.confirm(
                          `Atualizar ${item.name} para a v${listing.package.version}? O que você personalizou nos agentes é mantido.`,
                        ) &&
                        run(async () => {
                          const done = await window.hive.invoke(
                            'marketplace.update',
                            item.packageId,
                          );
                          return `Atualizado para v${done.installed.version}.${done.kept.length ? ` Mantido o que você mudou: ${done.kept.join(', ')}.` : ''}`;
                        })
                      }
                    >
                      <Download size={13} /> Atualizar
                    </button>
                  )}
                  {item.history.length > 0 && (
                    <button
                      className="ghost"
                      disabled={action.running}
                      onClick={() =>
                        window.confirm(
                          `Voltar ${item.name} para a v${item.history[0]!.version}?`,
                        ) &&
                        run(async () => {
                          const done = await window.hive.invoke(
                            'marketplace.restore',
                            item.packageId,
                          );
                          return `De volta à v${done.installed.version}.`;
                        })
                      }
                    >
                      <History size={13} /> Voltar à v{item.history[0]!.version}
                    </button>
                  )}
                  <button
                    className="ghost danger"
                    disabled={action.running}
                    onClick={() =>
                      window.confirm(
                        `Desinstalar ${item.name}? Os agentes dele são removidos (as skills ficam).`,
                      ) &&
                      run(async () => {
                        await window.hive.invoke('marketplace.uninstall', item.packageId);
                        return `${item.name} desinstalado.`;
                      })
                    }
                  >
                    <Trash2 size={13} /> Desinstalar
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>Nada instalado ainda. Explore o catálogo ou importe um arquivo.</Empty>
        ))}

      {tab === 'create' && (
        <ExportForm
          workers={workers.filter((item) => item.role !== 'queen' && !item.team)}
          busy={action.running}
          onExport={(input) =>
            run(async () => {
              const saved = await window.hive.invoke('marketplace.export', input);
              return saved
                ? `Pacote salvo em ${saved}. Para publicar, siga o guia em marketplace/CONTRIBUTING.md.`
                : undefined;
            })
          }
        />
      )}

      {preview && (
        <div
          className="market-modal"
          role="dialog"
          aria-modal="true"
          aria-label={preview.data.listing.package.name}
        >
          <div className="market-modal-body">
            <h2>{preview.data.listing.package.name}</h2>
            <p className="muted">
              {categoryLabels[preview.data.listing.package.category]} · v
              {preview.data.listing.package.version} · {preview.data.listing.package.author.name} ·
              licença {preview.data.listing.package.license} · {preview.data.listing.source}
            </p>
            <p>{preview.data.listing.package.description}</p>
            {preview.data.listing.problem && (
              <p className="error-text">{preview.data.listing.problem}</p>
            )}
            {preview.data.listing.package.agents.length > 0 && (
              <>
                <h3>Agentes</h3>
                <ul>
                  {preview.data.listing.package.agents.map((agent) => (
                    <li key={agent.key}>
                      <strong>{agent.name}</strong> ({agent.role}): {agent.description}
                      {agent.recommendedModels.length > 0 && (
                        <span className="muted">
                          {' '}
                          Modelo sugerido: {agent.recommendedModels.join('; ')}.
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3>O que ele pode fazer</h3>
            <ul className="market-permissions">
              {preview.data.permissions.map((item) => (
                <li key={item.tool} className={item.sensitive ? 'sensitive' : undefined}>
                  <code>{item.tool}</code> {item.description}
                  {item.sensitive && <strong> · altera o projeto ou executa comandos</strong>}
                </li>
              ))}
            </ul>
            {(preview.data.newSkills.length > 0 ||
              preview.data.keptSkills.length > 0 ||
              preview.data.missingSkills.length > 0) && (
              <>
                <h3>Skills</h3>
                <ul>
                  {preview.data.newSkills.map((name) => (
                    <li key={name}>{name}: será adicionada</li>
                  ))}
                  {preview.data.keptSkills.map((name) => (
                    <li key={name}>{name}: você já tem; a sua fica como está</li>
                  ))}
                  {preview.data.missingSkills.map((name) => (
                    <li key={name} className="error-text">
                      {name}: o agente usa, mas ela não existe neste Hive
                    </li>
                  ))}
                </ul>
              </>
            )}
            {[
              ...preview.data.warnings,
              ...preview.data.missingDependencies.map((item) => `Precisa também de ${item}.`),
            ].map((line) => (
              <p key={line} className="market-warning">
                {line}
              </p>
            ))}
            <div className="market-modal-actions">
              <button className="ghost" onClick={() => setPreview(null)}>
                Cancelar
              </button>
              <button
                className="primary"
                disabled={
                  action.running ||
                  !preview.data.listing.installable ||
                  !!preview.data.listing.installedVersion
                }
                onClick={install}
              >
                {preview.data.listing.installedVersion ? 'Já instalado' : 'Instalar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExportForm({
  workers,
  busy,
  onExport,
}: {
  workers: { id: string; name: string; role: string }[];
  busy: boolean;
  onExport: (input: {
    workerIds: string[];
    id: string;
    name: string;
    description: string;
    author: string;
    version: string;
    license: string;
    tags: string[];
    includeSkills: boolean;
  }) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    author: '',
    version: '1.0.0',
    license: 'MIT',
    tags: '',
    includeSkills: true,
  });
  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="market-export"
      onSubmit={(event) => {
        event.preventDefault();
        onExport({
          ...form,
          workerIds: picked,
          tags: form.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        });
      }}
    >
      <p className="muted">
        Escolha um agente (vira um pacote de agente) ou vários (uma equipe). O pacote leva nome,
        função, descrição, instruções, ferramentas e skills; nunca provedor, modelo, chaves,
        comandos aprovados automaticamente, servidores MCP ou memórias.
      </p>
      <fieldset>
        <legend>Agentes</legend>
        {workers.map((worker) => (
          <label key={worker.id} className="market-check">
            <input
              type="checkbox"
              checked={picked.includes(worker.id)}
              onChange={(event) =>
                setPicked((current) =>
                  event.target.checked
                    ? [...current, worker.id]
                    : current.filter((id) => id !== worker.id),
                )
              }
            />
            {worker.name} <span className="muted">({worker.role})</span>
          </label>
        ))}
      </fieldset>
      <div className="market-fields">
        <label>
          Id (minúsculas e hífens)
          <input
            required
            value={form.id}
            onChange={(event) => set('id', event.target.value)}
            placeholder="minha-qa"
          />
        </label>
        <label>
          Nome
          <input required value={form.name} onChange={(event) => set('name', event.target.value)} />
        </label>
        <label className="wide">
          Descrição
          <textarea
            required
            rows={3}
            value={form.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </label>
        <label>
          Autor
          <input
            required
            value={form.author}
            onChange={(event) => set('author', event.target.value)}
          />
        </label>
        <label>
          Versão
          <input
            required
            value={form.version}
            onChange={(event) => set('version', event.target.value)}
          />
        </label>
        <label>
          Licença
          <input
            required
            value={form.license}
            onChange={(event) => set('license', event.target.value)}
          />
        </label>
        <label>
          Tags (separadas por vírgula)
          <input value={form.tags} onChange={(event) => set('tags', event.target.value)} />
        </label>
      </div>
      <label className="market-check">
        <input
          type="checkbox"
          checked={form.includeSkills}
          onChange={(event) => set('includeSkills', event.target.checked)}
        />
        Levar as skills locais que esses agentes usam (as do Hive já estão em todo Hive; skills com
        scripts ficam de fora)
      </label>
      <button className="primary" disabled={busy || !picked.length}>
        <Upload size={14} /> Exportar pacote
      </button>
    </form>
  );
}
