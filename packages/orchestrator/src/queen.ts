import { checkPlanGraph, planSchema, type Plan, type Worker } from '@hive/core';
import { withRetries, type ChatClient, type ChatMessage } from '@hive/providers';
import { HiveError } from '@hive/shared';

export interface PlanRequest {
  objective: string;
  title: string;
  workers: Worker[];
  projectContext: string;
  chat: ChatClient;
  model: string;
  queen: Worker;
  signal?: AbortSignal;
  maxAttempts?: number;
  onAttempt?: (attempt: number, error: string | null) => void;
}

export interface PlanResult {
  plan: Plan;
  attempts: number;
  usage: { promptTokens: number; completionTokens: number };
}

const shape = `{
  "notes": "short rationale for the decomposition",
  "tasks": [
    {
      "key": "short-kebab-id",
      "title": "imperative title",
      "description": "what to do, which files or areas, and constraints",
      "workerId": "<one of the worker ids above, or null>",
      "dependsOn": ["keys of tasks that must finish first"],
      "acceptanceCriteria": ["verifiable statement", "..."]
    }
  ]
}`;

export function buildPlanPrompt(request: PlanRequest): ChatMessage[] {
  const workers = request.workers
    .filter((worker) => worker.role !== 'queen')
    .map(
      (worker) =>
        `- id: ${worker.id} | ${worker.name} (${worker.role}) — ${worker.description || 'no description'}`,
    )
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        request.queen.systemPrompt,
        'You produce execution plans as a single JSON object and nothing else — no prose, no code fences.',
        'Rules:',
        '- 1 to 6 tasks. Each task must be completable by one worker in one session.',
        '- Tasks that touch different files should not depend on each other, so they can run in parallel.',
        "- Use dependsOn only when a task needs another task's output.",
        '- Every task needs 1-5 concrete, verifiable acceptance criteria.',
        '- Assign workerId only from the provided list; match the worker role to the work.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `# Mission: ${request.title}\n\n${request.objective}\n\n## Available workers\n${workers || '(none)'}\n\n## Project context\n${request.projectContext}\n\nRespond with JSON exactly in this shape:\n${shape}`,
    },
  ];
}

/** Pull the first JSON object out of a model reply, tolerating code fences and stray prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in the reply.');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function validatePlan(
  value: unknown,
  workerIds: ReadonlySet<string>,
): { plan: Plan | null; errors: string[] } {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    return {
      plan: null,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`,
      ),
    };
  }
  const issues = checkPlanGraph(parsed.data, workerIds);
  if (issues.length)
    return { plan: null, errors: issues.map((issue) => `${issue.path}: ${issue.message}`) };
  return { plan: parsed.data, errors: [] };
}

/**
 * Ask the Queen's model for a plan and validate it against the plan schema and the dependency
 * graph rules. Validation errors are sent back to the model for a bounded number of retries.
 */
export async function planMission(request: PlanRequest): Promise<PlanResult> {
  const maxAttempts = request.maxAttempts ?? 3;
  const workerIds = new Set(request.workers.map((worker) => worker.id));
  const messages = buildPlanPrompt(request);
  const usage = { promptTokens: 0, completionTokens: 0 };
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    request.onAttempt?.(attempt, attempt === 1 ? null : lastError);
    // A rate limit or a provider hiccup is waited out a few times before planning gives up.
    const response = await withRetries(
      () =>
        request.chat.chat(
          { model: request.model, messages, temperature: request.queen.limits.temperature ?? 0.2 },
          request.signal,
        ),
      { signal: request.signal, maxAttempts: 5 },
    );
    usage.promptTokens += response.usage?.promptTokens ?? 0;
    usage.completionTokens += response.usage?.completionTokens ?? 0;
    const text = response.message.content ?? '';
    let value: unknown;
    try {
      value = extractJson(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      messages.push(
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `That was not valid JSON (${lastError}). Reply with only the JSON object.`,
        },
      );
      continue;
    }
    // Models sometimes invent worker ids; drop unknown ones rather than failing the whole plan.
    if (value && typeof value === 'object' && Array.isArray((value as { tasks?: unknown }).tasks)) {
      for (const task of (value as { tasks: Record<string, unknown>[] }).tasks) {
        if (
          task &&
          typeof task === 'object' &&
          (typeof task.workerId !== 'string' || !workerIds.has(task.workerId))
        )
          task.workerId = null;
      }
    }
    const { plan, errors } = validatePlan(value, workerIds);
    if (plan) return { plan, attempts: attempt, usage };
    lastError = errors.slice(0, 8).join('; ');
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content: `The plan is invalid: ${lastError}. Fix these problems and reply with only the corrected JSON object.`,
      },
    );
  }
  throw new HiveError(
    'VALIDATION',
    `The Queen could not produce a valid plan after ${maxAttempts} attempts: ${lastError}`,
  );
}
