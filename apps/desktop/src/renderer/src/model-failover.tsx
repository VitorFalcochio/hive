import { useEffect, useState } from 'react';
import { ArrowDown, Plus, Shuffle, X } from 'lucide-react';
import {
  compareByPrice,
  isFreeModel,
  type ModelInfo,
  type ModelRoute,
  type ModelRoutePlan,
  type Worker,
} from '@hive/core';
import { hasAccess, useHive } from './context';
import { Select } from './ui';

const sourceLabels: Record<ModelRoutePlan['source'], string> = {
  primary: 'Principal',
  backup: 'Reserva',
  automatic: 'Automático',
};

function resting(ms: number): string | null {
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  return minutes >= 60 ? `descansa ~${Math.round(minutes / 60)} h` : `descansa ~${minutes} min`;
}

/**
 * Backups for when the agent's model runs out, and the chain Hive will actually follow: the
 * agent's model, these backups, then free models of the other providers (when enabled in
 * Settings). Calls move along it at once and come back to the agent's model when it rests.
 */
export function FailoverSection({
  worker,
  value,
  onChange,
}: {
  worker: Worker;
  value: ModelRoute[];
  onChange: (next: ModelRoute[]) => void;
}) {
  const { providers } = useHive();
  const usable = providers.filter(hasAccess);
  const [plan, setPlan] = useState<ModelRoutePlan[] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    void window.hive
      .invoke('settings.get')
      .then((settings) => setEnabled(settings.failover.enabled))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const load = () =>
      void window.hive
        .invoke('worker.routes', worker.id)
        .then((routes) => active && setPlan(routes))
        .catch(() => active && setPlan([]));
    load();
    // Resting times count down; the chain is read again now and then while the drawer is open.
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [worker]);

  useEffect(() => {
    setModelId('');
    if (!providerId) return setModels([]);
    let active = true;
    void window.hive
      .invoke('provider.models', { providerId, refresh: false })
      .then((list) => {
        if (!active) return;
        // Free models first: backups are meant to keep work going at no cost.
        setModels(
          [...list].sort(
            (a, b) => Number(isFreeModel(b)) - Number(isFreeModel(a)) || compareByPrice(a, b),
          ),
        );
      })
      .catch(() => active && setModels([]));
    return () => {
      active = false;
    };
  }, [providerId]);

  const name = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
  const duplicate =
    (providerId === worker.providerId && modelId === worker.modelId) ||
    value.some((item) => item.providerId === providerId && item.modelId === modelId);
  const saved = JSON.stringify(value) === JSON.stringify(worker.fallbacks ?? []);

  return (
    <section className="agent-section">
      <h3>Troca automática de modelo</h3>
      <p className="field-hint">
        Quando o modelo esgota (limite, cota diária, créditos ou modelo removido), a tarefa segue na
        hora no próximo da cadeia, sem esperar, e volta ao principal quando ele libera.
        {!enabled && ' A troca está desligada em Configurações.'}
      </p>

      <h4 className="failover-subtitle">Reservas escolhidas por você</h4>
      {value.length === 0 ? (
        <p className="field-hint">Nenhuma. O Hive usa o pool automático, se estiver ligado.</p>
      ) : (
        <ol className="failover-backups">
          {value.map((item, index) => (
            <li key={`${item.providerId}:${item.modelId}`}>
              <span className="failover-index">{index + 1}</span>
              <span className="failover-name">
                <code>{item.modelId}</code>
                <small>{name(item.providerId)}</small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remover ${item.modelId}`}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {value.length < 8 && (
        <div className="failover-add">
          <Select
            value={providerId}
            placeholder="Provedor…"
            onChange={setProviderId}
            options={usable.map((provider) => ({ value: provider.id, label: provider.name }))}
          />
          <Select
            value={modelId}
            placeholder={
              providerId && !models.length ? 'Sem catálogo: liste em Provedores' : 'Modelo…'
            }
            disabled={!providerId || !models.length}
            onChange={setModelId}
            options={models.map((model) => ({
              value: model.id,
              label: model.id,
              hint: isFreeModel(model) ? 'grátis' : undefined,
            }))}
          />
          <button
            type="button"
            className="secondary"
            disabled={!providerId || !modelId || duplicate}
            onClick={() => {
              onChange([...value, { providerId, modelId }]);
              setModelId('');
            }}
          >
            <Plus size={13} /> Adicionar
          </button>
        </div>
      )}

      <h4 className="failover-subtitle">
        <Shuffle size={12} /> Cadeia que o Hive vai seguir
        {!saved && <small> (salve para atualizar)</small>}
      </h4>
      {!plan ? (
        <p className="field-hint">Carregando…</p>
      ) : plan.length <= 1 ? (
        <p className="field-hint">
          Só o modelo principal. Cadastre outros provedores gratuitos em Provedores (e liste os
          modelos deles) ou adicione reservas acima.
        </p>
      ) : (
        <ol className="failover-chain">
          {plan.map((route, index) => (
            <li
              key={`${route.providerId}:${route.model}`}
              className={route.restingMs ? 'resting' : undefined}
            >
              {index > 0 && <ArrowDown size={11} className="failover-arrow" aria-hidden />}
              <span className={`failover-source ${route.source}`}>
                {sourceLabels[route.source]}
              </span>
              <code className="truncate">{route.model}</code>
              <small className="truncate">{route.providerName}</small>
              {resting(route.restingMs) && <em>{resting(route.restingMs)}</em>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
