export type Label = boolean | null;
export type Mode = 'files' | 'adjudication' | 'ranges';
export type Range = {
  start: number;
  end: number;
  model_decision: Label;
  confidence: number | null;
  annotation: Label;
  candidate: boolean;
  preview?: string;
};
export type Cell = {
  run_id: number;
  pair_id: number;
  batch_id: string;
  rule_id: string;
  rule_path: string;
  file_confidence: number | null;
  file_decision: Label;
  file_label: Label;
  stage: 'file' | 'ranges' | 'adjudication' | 'ready' | 'failed';
  error: string | null;
  ranges: Range[];
};
export type Run = Cell & {file_path: string; source: string; rule: string; langfuse_url: string | null};
export type Trace = {
  id: string;
  file_path: string;
  project: string;
  project_id: number;
  key_name: string;
  created_at: string;
  cells: Cell[];
};
export type Key = {id: number; name: string; prefix: string; revoked_at: string | null};
export type Project = {id: number; name: string; parent: string | null; rules: number};
export type Provider = {base_url: string; model: string; custom_key: boolean; overridden: boolean};
export type Routing = {decision: Provider; ranges: Provider};
export type ProviderEdit = {base_url?: string; model?: string; api_key?: string; reset?: boolean};
export type History = {project: string; rule_hash: string; rule: string; first_seen: string};

export class Api {
  async request(path: string, method = 'GET', payload?: unknown): Promise<Response> {
    const response = await fetch('/api' + path, {
      method,
      headers: {
        'X-NLLint-UI': '1',
        ...(payload === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      cache: 'no-store',
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      throw new Error(typeof failure?.detail === 'string' ? failure.detail : `Gateway error (${response.status})`);
    }
    return response;
  }

  async json<T>(path: string, method?: string, payload?: unknown): Promise<T> {
    return (await this.request(path, method, payload)).json();
  }

  file(pair: number, run: number, decision: Label, rejectAll = false) {
    return this.json(`/pairs/${pair}/file`, 'PUT', {decision, reject_all: rejectAll, run_id: run});
  }

  range(pair: number, start: number, end: number, decision: Label) {
    return this.json(`/pairs/${pair}/range`, 'PUT', {start, end, decision});
  }
}

export const label = (decision: Label) => decision === null ? 'Unreviewed' : decision ? 'Violates' : 'No violation';
export const rangeText = (range: {start: number; end: number}) =>
  range.start === range.end ? `L${range.start}` : `L${range.start}–${range.end}`;
export const probability = (confidence: number | null) => confidence === null ? '' : `${Math.round(confidence * 100)}%`;
