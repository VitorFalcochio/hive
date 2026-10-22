import { useMemo, useState } from 'react';
import { Check, Eye, Search } from 'lucide-react';
import { compareByPrice, isFreeModel, type ModelInfo } from '@hive/core';

type Filter = 'all' | 'free' | 'vision';

const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'free', label: 'Grátis' },
  { value: 'vision', label: 'Vê imagens' },
];

const price = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** "US$ 0,15 / 0,60" per million tokens (input / output), the way catalogs quote it. */
function priceLabel(model: ModelInfo): string | null {
  if (!model.pricing) return null;
  return `US$ ${price.format(model.pricing.inputPerMTok)} / ${price.format(model.pricing.outputPerMTok)}`;
}

function contextLabel(tokens: number | null): string | null {
  if (!tokens) return null;
  return tokens >= 1_000_000
    ? `${price.format(tokens / 1_000_000)}M`
    : `${Math.round(tokens / 1000)}k`;
}

/**
 * The provider's models to choose from: free ones first, then from the cheapest, with what
 * matters at a glance (price per million tokens, vision, context). An id not in the catalog
 * can still be typed and used.
 */
export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (modelId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const term = query.trim().toLowerCase();

  const { free, paid } = useMemo(() => {
    const shown = models
      .filter((model) => !term || `${model.id} ${model.displayName}`.toLowerCase().includes(term))
      .filter((model) =>
        filter === 'free'
          ? isFreeModel(model)
          : filter === 'vision'
            ? model.capabilities.vision === 'yes'
            : true,
      )
      .sort(compareByPrice);
    return {
      free: shown.filter((model) => isFreeModel(model)),
      paid: shown.filter((model) => !isFreeModel(model)),
    };
  }, [models, term, filter]);

  const typed = query.trim();
  const custom = typed && !models.some((model) => model.id === typed) ? typed : null;

  const row = (model: ModelInfo) => {
    const selected = model.id === value;
    const cost = isFreeModel(model) ? null : priceLabel(model);
    const context = contextLabel(model.contextWindow);
    return (
      <button
        key={model.id}
        type="button"
        role="option"
        aria-selected={selected}
        className={selected ? 'model-row selected' : 'model-row'}
        onClick={() => onChange(model.id)}
        title={model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`}
      >
        <span className="model-row-check">{selected && <Check size={13} />}</span>
        <span className="model-row-id">{model.id}</span>
        <span className="model-row-tags">
          {model.capabilities.vision === 'yes' && (
            <span className="model-tag" title="Enxerga imagens">
              <Eye size={12} />
            </span>
          )}
          {context && (
            <span className="model-tag" title="Tamanho do contexto em tokens">
              {context}
            </span>
          )}
          {isFreeModel(model) ? (
            <span className="model-tag free">grátis</span>
          ) : cost ? (
            <span className="model-tag" title="Preço por milhão de tokens: entrada / saída">
              {cost}
            </span>
          ) : (
            <span className="model-tag muted">sem preço</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="model-picker">
      <div className="model-search">
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          value={query}
          maxLength={200}
          placeholder={value ? `Atual: ${value}` : 'Buscar ou digitar o ID do modelo'}
          aria-label="Buscar modelo"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter picks the only match, or the id as typed.
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const matches = [...free, ...paid];
            if (custom) onChange(custom);
            else if (matches.length === 1) onChange(matches[0]!.id);
          }}
        />
      </div>
      <div className="model-filters" role="radiogroup" aria-label="Filtrar modelos">
        {filters.map((item) => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={filter === item.value}
            className={filter === item.value ? 'model-filter selected' : 'model-filter'}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
        <span className="model-count">{free.length + paid.length} modelos</span>
      </div>
      <div className="model-list" role="listbox" aria-label="Modelos do provedor">
        {custom && (
          <button
            type="button"
            role="option"
            aria-selected={value === custom}
            className={value === custom ? 'model-row selected' : 'model-row'}
            onClick={() => onChange(custom)}
          >
            <span className="model-row-check">{value === custom && <Check size={13} />}</span>
            <span className="model-row-id">Usar “{custom}”</span>
            <span className="model-row-tags">
              <span className="model-tag muted">fora do catálogo</span>
            </span>
          </button>
        )}
        {free.length > 0 && (
          <>
            <p className="model-group">Grátis · {free.length}</p>
            {free.map(row)}
          </>
        )}
        {paid.length > 0 && (
          <>
            <p className="model-group">Pagos, do mais barato · {paid.length}</p>
            {paid.map(row)}
          </>
        )}
        {!free.length && !paid.length && !custom && (
          <p className="model-empty">
            {models.length ? 'Nenhum modelo com esse filtro.' : 'Carregando o catálogo…'}
          </p>
        )}
      </div>
    </div>
  );
}
