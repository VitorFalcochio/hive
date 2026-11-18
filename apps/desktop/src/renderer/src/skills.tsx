import { Fragment, useEffect, useState } from 'react';
import { Check, ChevronRight, ExternalLink, Hexagon, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { SkillSummary, SkillValidation } from '@hive/core';
import { useHive } from './context';
import { AgentBee } from './mascot';
import { Drawer, Empty, PageHeader, useTask } from './ui';

const newSkillTemplate = `---
name: minha-skill
description: "O que esta skill ensina e quando o agente deve usá-la."
---

# Minha skill

## Quando usar
Descreva a situação em que o agente deve seguir estas instruções.

## Passos
1. Primeiro passo.
2. Segundo passo.

## Entrega
O que o agente deve entregar ou relatar no fim.
`;

/** Where the built-in skills come from, in the order the library shows them. */
const origins: { name: string; about: string }[] = [
  {
    name: 'Superpowers',
    about:
      'O método de trabalho de Jesse Vincent, o mais usado do GitHub: planejar, testar primeiro, depurar com método e conferir antes de concluir.',
  },
  {
    name: 'Addy Osmani',
    about:
      'Skills de engenharia de Addy Osmani (Google): planejamento, APIs, interface, acessibilidade, segurança, desempenho e revisão.',
  },
  {
    name: 'Anthropic',
    about:
      'Da Anthropic, criadora do Claude: design visual com personalidade, sem cara de genérico.',
  },
  { name: 'Hive', about: 'Escritas para o Hive.' },
];
const YOURS = 'Suas skills';

/** The library's group for a skill: its author, or the user's own. */
function originOf(skill: SkillSummary): string {
  if (skill.origin?.toLowerCase() === 'hive') return 'Hive';
  return skill.origin ?? (skill.builtin ? 'Hive' : YOURS);
}

function groupByOrigin(skills: SkillSummary[]) {
  const names = [...origins.map((origin) => origin.name)];
  for (const skill of skills) if (!names.includes(originOf(skill))) names.push(originOf(skill));
  // The user's own skills come last, after every author.
  names.sort((a, b) => Number(a === YOURS) - Number(b === YOURS));
  return names
    .map((name) => ({
      name,
      about:
        origins.find((origin) => origin.name === name)?.about ??
        (name === YOURS ? 'Criadas ou instaladas por você.' : ''),
      items: skills.filter((skill) => originOf(skill) === name),
    }))
    .filter((group) => group.items.length);
}

/** `'new'` is a skill being written in the drawer, not saved yet. */
type Selection = string | 'new' | null;

export function SkillsPage() {
  const { skills, workers, refresh, notify, fail } = useHive();
  const task = useTask();
  const [selected, setSelected] = useState<Selection>(null);
  const library = skills.filter((skill) => skill.source === 'local');
  const catalog = skills.filter((skill) => skill.source === 'skillforge' && !skill.installed);
  const users = (name: string) => workers.filter((worker) => worker.skills.includes(name));

  return (
    <>
      <PageHeader
        eyebrow="Conhecimento"
        title="Skills"
        description="Jeitos de trabalhar que os agentes abrem quando a tarefa pede. Cada vez que um agente usa uma skill, aparece no registro da tarefa. As de fábrica vêm com o Hive e podem ser editadas à vontade."
      >
        <button
          className="secondary"
          disabled={task.running}
          onClick={() =>
            void task.run(async () => {
              await window.hive.invoke('skill.pickCatalog');
              await refresh();
            })
          }
        >
          Conectar catálogo
        </button>
        <button onClick={() => setSelected('new')}>
          <Plus size={15} /> Nova skill
        </button>
      </PageHeader>
      {task.error && !selected && (
        <p role="alert" className="form-error">
          {task.error}
        </p>
      )}

      <section className="card flush">
        {library.length ? (
          <div className="rows">
            {groupByOrigin(library).map((group) => (
              <Fragment key={group.name}>
                <div className="skill-group">
                  <strong>{group.name}</strong>
                  <span>{group.about}</span>
                </div>
                {group.items.map((skill) => (
                  <button
                    key={skill.name}
                    className="row skill-row"
                    onClick={() => setSelected(skill.name)}
                  >
                    <div className="row-main">
                      <span className="row-title skill-name">
                        {skill.name}
                        {skill.builtin && (
                          <Hexagon
                            size={12}
                            strokeWidth={2.25}
                            className={`skill-builtin${skill.modified ? ' modified' : ''}`}
                            aria-label={
                              skill.modified
                                ? 'Skill de fábrica, editada por você'
                                : 'Skill de fábrica'
                            }
                          >
                            <title>
                              {skill.modified
                                ? 'Skill de fábrica, editada por você'
                                : 'Skill de fábrica'}
                            </title>
                          </Hexagon>
                        )}
                      </span>
                      <small>{skill.description}</small>
                    </div>
                    <span
                      className="skill-users"
                      title={users(skill.name)
                        .map((w) => w.name)
                        .join(', ')}
                    >
                      {users(skill.name).map((worker) => (
                        <AgentBee key={worker.id} worker={worker} size={16} />
                      ))}
                    </span>
                    <ChevronRight size={15} className="skill-chevron" />
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        ) : (
          <Empty>Nenhuma skill na biblioteca. Crie uma ou instale de um catálogo.</Empty>
        )}
      </section>

      {catalog.length > 0 && (
        <section className="card">
          <div className="card-heading">
            <h2>Catálogo SkillForge</h2>
            <button
              className="ghost"
              disabled={task.running}
              onClick={() =>
                void task.run(async () => {
                  await window.hive.invoke('settings.update', { skillforgeCatalogPath: null });
                  await refresh();
                  notify('Catálogo desconectado. As skills da biblioteca continuam.');
                })
              }
            >
              Desconectar
            </button>
          </div>
          <div className="rows">
            {catalog.map((skill) => (
              <div key={skill.name} className="row static">
                <div className="row-main">
                  <span className="row-title">{skill.name}</span>
                  <small>{skill.description}</small>
                </div>
                <button
                  className="ghost"
                  onClick={() =>
                    void window.hive
                      .invoke('skill.install', skill.name)
                      .then(() => {
                        notify(`${skill.name} instalada.`);
                        return refresh();
                      })
                      .catch(fail)
                  }
                >
                  Instalar
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {selected && (
        <SkillEditor
          key={selected}
          summary={library.find((skill) => skill.name === selected) ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/** The SKILL.md text, which agents use it, and for a built-in one a way back to the original. */
function SkillEditor({ summary, onClose }: { summary: SkillSummary | null; onClose: () => void }) {
  const { workers, refresh, notify } = useHive();
  const task = useTask();
  const [raw, setRaw] = useState<string | null>(summary ? null : newSkillTemplate);
  const [saved, setSaved] = useState<string | null>(summary ? null : '');
  const [using, setUsing] = useState(
    () =>
      new Set(
        summary ? workers.filter((w) => w.skills.includes(summary.name)).map((w) => w.id) : [],
      ),
  );
  const [validation, setValidation] = useState<SkillValidation | null>(null);

  // Loaded once per skill; the list refreshing around it must not wipe what is being typed.
  const loadName = summary?.name ?? null;
  useEffect(() => {
    if (!loadName) return;
    void window.hive.invoke('skill.get', { name: loadName, source: 'local' }).then((detail) => {
      setRaw(detail.raw);
      setSaved(detail.raw);
    });
  }, [loadName]);

  // Checked as the user types, a moment after they stop.
  useEffect(() => {
    if (raw === null) return;
    const timer = setTimeout(() => {
      void window.hive
        .invoke('skill.validateDraft', raw)
        .then(setValidation)
        .catch(() => setValidation(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [raw]);

  if (raw === null) return null;
  const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(raw)?.[1] ?? 'Sem nome';
  const errors = validation?.diagnostics.filter((item) => item.severity === 'error') ?? [];
  const warnings = validation?.diagnostics.filter((item) => item.severity === 'warning') ?? [];
  const usersBefore = summary
    ? workers.filter((w) => w.skills.includes(summary.name)).map((w) => w.id)
    : [];
  const dirty =
    raw !== saved || usersBefore.length !== using.size || usersBefore.some((id) => !using.has(id));

  const text = raw;
  async function save() {
    const result = await window.hive.invoke('skill.saveLocal', {
      raw: text,
      ...(summary ? { originalName: summary.name } : {}),
    });
    // A rename already moved the skill on its agents; only the switches are left to apply.
    const names = (skills: string[]) =>
      skills.map((skill) => (skill === summary?.name ? result.name : skill));
    for (const worker of workers) {
      const current = names(worker.skills);
      const has = current.includes(result.name);
      if (has === using.has(worker.id)) continue;
      await window.hive.invoke('worker.save', {
        ...worker,
        skills: has ? current.filter((skill) => skill !== result.name) : [...current, result.name],
      });
    }
    await refresh();
    notify(summary ? `Skill ${result.name} salva.` : `Skill ${result.name} criada.`);
    onClose();
  }

  return (
    <Drawer
      eyebrow={
        summary?.builtin
          ? `Skill de fábrica · ${originOf(summary)}`
          : summary
            ? 'Skill'
            : 'Nova skill'
      }
      title={name}
      onClose={onClose}
      onSubmit={() => void task.run(save)}
      footer={
        <>
          {summary && (
            <button
              type="button"
              className="ghost danger"
              disabled={task.running}
              onClick={() => {
                const note = summary.builtin
                  ? ' Skills de fábrica apagadas não voltam sozinhas.'
                  : '';
                if (!window.confirm(`Apagar a skill "${summary.name}"?${note}`)) return;
                void task.run(async () => {
                  await window.hive.invoke('skill.deleteLocal', summary.name);
                  await refresh();
                  notify(`Skill ${summary.name} apagada.`);
                  onClose();
                });
              }}
            >
              <Trash2 size={14} /> Apagar
            </button>
          )}
          {summary?.builtin && summary.modified && (
            <button
              type="button"
              className="ghost"
              disabled={task.running}
              title="Volta ao texto que vem com o Hive"
              onClick={() => {
                if (!window.confirm('Desfazer suas edições e voltar ao texto original do Hive?'))
                  return;
                void task.run(async () => {
                  await window.hive.invoke('skill.restore', summary.name);
                  const detail = await window.hive.invoke('skill.get', {
                    name: summary.name,
                    source: 'local',
                  });
                  setRaw(detail.raw);
                  setSaved(detail.raw);
                  await refresh();
                  notify('Texto original restaurado.');
                });
              }}
            >
              <RotateCcw size={14} /> Restaurar original
            </button>
          )}
          <span className="drawer-spacer" />
          {dirty && summary && <span className="agent-unsaved">Não salvo</span>}
          <button type="button" className="secondary" onClick={onClose}>
            {dirty && summary ? 'Descartar' : 'Fechar'}
          </button>
          <button type="submit" disabled={task.running || !dirty || errors.length > 0}>
            <Check size={15} /> {summary ? 'Salvar' : 'Criar skill'}
          </button>
        </>
      }
    >
      {summary?.origin && summary.origin.toLowerCase() !== 'hive' && (
        <section className="agent-section skill-credit">
          <h3>Origem</h3>
          <p>
            Escrita por <strong>{summary.origin}</strong>
            {summary.license ? ` · licença ${summary.license}` : ''}. Traduzida para o português e
            adaptada às ferramentas do Hive; a licença do autor fica junto da skill.
          </p>
          {summary.originUrl && (
            <a href={summary.originUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={13} /> Ver o original
            </a>
          )}
        </section>
      )}
      <section className="agent-section">
        <h3>SKILL.md</h3>
        <span className="field-hint">
          O cabeçalho entre <code>---</code> precisa de <code>name</code> (minúsculas e hífens) e{' '}
          <code>description</code>. O agente vê a descrição em toda tarefa e abre o resto quando ela
          pede: escreva na descrição quando usar a skill.
        </span>
        <textarea
          className="mono skill-source"
          spellCheck={false}
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          aria-label="Texto da skill"
        />
        {[...errors, ...warnings].map((item) => (
          <p
            key={`${item.code}:${item.message}`}
            className={item.severity === 'error' ? 'form-error' : 'field-hint'}
          >
            {item.message}
          </p>
        ))}
      </section>
      <section className="agent-section">
        <h3>Agentes que usam</h3>
        <div className="tool-list">
          {workers.map((worker) => (
            <label key={worker.id} className="tool-option skill-agent">
              <input
                type="checkbox"
                checked={using.has(worker.id)}
                onChange={(event) =>
                  setUsing((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(worker.id);
                    else next.delete(worker.id);
                    return next;
                  })
                }
              />
              <AgentBee worker={worker} size={16} />
              <span>{worker.name}</span>
            </label>
          ))}
        </div>
      </section>
      {task.error && (
        <p role="alert" className="form-error">
          {task.error}
        </p>
      )}
    </Drawer>
  );
}
