import {createSerializer, parseAsArrayOf, parseAsInteger, parseAsString, parseAsStringLiteral} from 'nuqs';

export const sectionPaths = {traces: '/traces', projects: '/pipelines', keys: '/api-keys'} as const;
export type Section = keyof typeof sectionPaths;

export const routes = [
  {id: 'home', path: '/'},
  {id: 'all-traces', path: '/traces'},
  {id: 'project-traces', path: '/traces/:projectId'},
  {id: 'trace', path: '/traces/:projectId/:traceId'},
  {id: 'projects', path: '/pipelines'},
  {id: 'models', path: '/pipelines/:pipelineId/models'},
  {id: 'keys', path: '/api-keys'},
  {id: 'find', path: '/find-ranges/:runId'},
] as const;

export function tracePath(project?: string, traceId?: string) {
  if (!project) return sectionPaths.traces;
  const projectPath = `${sectionPaths.traces}/${encodeURIComponent(project)}`;
  return traceId ? `${projectPath}/${encodeURIComponent(traceId)}` : projectPath;
}

export const modelsPath = (projectId: number | string) => `/pipelines/${projectId}/models`;
export const findRangesPath = (runId: number | string) => `/find-ranges/${runId}`;
export const modes = ['files', 'ranges', 'adjudication'] as const;
export const reviewModes = ['files', 'ranges'] as const;
export const issueLabels = {
  all: 'All traces',
  'file-range-positives': 'File- and Range-level positives',
  'adjudicated-positives': 'Adjudicated Positives',
  'no-ranges': 'Positive file, no ranges',
  'all-rejected': 'Positive file, all ranges rejected',
  disagreements: 'Human and model disagree',
  'rejected-candidates': 'Rejected candidates',
  unreviewed: 'Unreviewed decisions',
  failed: 'Processing failed',
};

export const navigation = {
  mode: parseAsStringLiteral(reviewModes).withDefault('files'),
  stages: parseAsArrayOf(parseAsStringLiteral(modes)).withDefault([...modes]),
  issue: parseAsStringLiteral(Object.keys(issueLabels)).withDefault('all'),
  key: parseAsString.withDefault(''),
  rule: parseAsString.withDefault(''),
  rules: parseAsArrayOf(parseAsString).withDefault([]),
  sort: parseAsStringLiteral(['relevance', 'newest']).withDefault('relevance'),
  page: parseAsInteger.withDefault(0),
  exportKind: parseAsStringLiteral(modes).withDefault('adjudication'),
  run: parseAsInteger,
  reviewTrace: parseAsString,
  range: parseAsString,
  syntax: parseAsString,
};

export const gatewayQuery = createSerializer(navigation);

export const closedReview = {
  run: null, reviewTrace: null, range: null, syntax: null,
} as const;

export const rangeParam = (range: {start: number; end: number}) => `${range.start}-${range.end}`;
