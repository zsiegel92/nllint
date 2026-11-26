import {useQueryStates} from 'nuqs';
import {useNavigate} from 'react-router';
import {annotationSources} from './api';
import type {Api, Key, Labeler, Project} from './api';
import {closedReview, gatewayQuery, issueLabels, navigation, tracePath} from './navigation';
import {RulePicker} from './rule-picker';

type TraceQuery = ReturnType<typeof useQueryStates<typeof navigation>>;

export function traceSearchParams(scope: URLSearchParams, query: TraceQuery[0], {limit, offset}: {
  limit: number; offset: number;
}) {
  const {issue, sort} = query;
  const traceParams = new URLSearchParams(scope);
  traceParams.set('issue', issue);
  if (query.pathContains.trim()) traceParams.set('path', query.pathContains.trim());
  if (query.sourceContains.trim()) traceParams.set('source_text', query.sourceContains.trim());
  if (query.minConfidence !== '') traceParams.set('min_confidence', query.minConfidence);
  if (query.maxConfidence !== '') traceParams.set('max_confidence', query.maxConfidence);
  if (query.filterAgent) traceParams.set('agent_labeler_id', String(query.filterAgent));
  if (query.peerAgent) traceParams.set('peer_labeler_id', String(query.peerAgent));
  if (query.reviewerOrigin) traceParams.set('reviewer_origin', query.reviewerOrigin);
  if (query.extraIssue) traceParams.append('extra_issue', query.extraIssue);
  traceParams.set('match', query.match);
  traceParams.set('sort', sort);
  traceParams.set('limit', String(limit));
  traceParams.set('offset', String(offset));
  return traceParams;
}

export function TraceFilters({api, query, setQuery, project, projects, keys, labelers, ruleScope}: {
  api: Api; query: TraceQuery[0]; setQuery: TraceQuery[1]; project: string;
  projects: Project[]; keys: Key[]; labelers: Labeler[]; ruleScope: string;
}) {
  const navigate = useNavigate();
  const {issue, sort, key, rule, rules} = query;
  const activeIssues = new Set([issue, query.extraIssue]);
  const comparePeers = activeIssues.has('agent-agent-disagreements') || sort === 'disagreement';
  const compareAgent = comparePeers || ['agent-disagreements', 'agent-review-disagreements', 'agent-unlabeled'].some(filter => activeIssues.has(filter));
  const compareReviewer = sort === 'disagreement' || activeIssues.has('disagreements') || activeIssues.has('agent-review-disagreements');
  return <>
    <div className="filters">
      <label>Find<select value={issue} onChange={event => {
        const next = event.target.value;
        void setQuery({issue: next, page: null, sort: next === 'agent-disagreements' ? 'confidence-desc'
          : ['agent-review-disagreements', 'agent-agent-disagreements'].includes(next) ? 'disagreement'
          : next === 'low-confidence' ? 'confidence-asc' : 'relevance'});
      }}>
        {Object.entries(issueLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      <label>Sort<select value={sort} onChange={event => void setQuery({sort: event.target.value as typeof sort, page: null})}>
        <option value="relevance">Relevance</option><option value="disagreement">Most disagreeing rules</option><option value="newest">Newest</option>
        <option value="confidence-asc">Lowest file-check confidence</option>
        <option value="confidence-desc">Highest file-check confidence</option><option value="path">File path</option>
      </select></label>
      <label>Project<select value={project} onChange={event => void navigate(gatewayQuery(tracePath(event.target.value), {...query, ...closedReview, rules: null, rule: null, page: null}))}>
        <option value="">All projects</option>{projects.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
      </select></label>
      <label>API key<select value={key} onChange={event => void setQuery({key: event.target.value, page: null})}>
        <option value="">All keys</option>{keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <RulePicker api={api} scope={ruleScope} selected={rules}
        onChange={rules => void setQuery({rules, rule: null, page: null})}/>
      {rule && <button type="button" onClick={() => void setQuery({rule: null, page: null})}>Clear rule path filter</button>}
    </div>
    <details className="disclosure" open={Boolean(query.pathContains || query.sourceContains || query.extraIssue || query.filterAgent || query.peerAgent || query.reviewerOrigin || query.minConfidence || query.maxConfidence) || undefined}>
      <summary>Advanced filters</summary>
      <div className="filters">
        <label>File path contains<input maxLength={500} value={query.pathContains} onChange={event => void setQuery({pathContains: event.target.value, page: null}, {history: 'replace'})}/></label>
        <label>Source text contains<input maxLength={500} value={query.sourceContains} onChange={event => void setQuery({sourceContains: event.target.value, page: null}, {history: 'replace'})}/></label>
        <label>Min. file-check confidence<input type="number" min={0} max={1} step={0.01} value={query.minConfidence} onChange={event => void setQuery({minConfidence: event.target.value, page: null}, {history: 'replace'})}/></label>
        <label>Max. file-check confidence<input type="number" min={0} max={1} step={0.01} value={query.maxConfidence} onChange={event => void setQuery({maxConfidence: event.target.value, page: null}, {history: 'replace'})}/></label>
        {compareAgent && <label>Agent labeler<select value={query.filterAgent ?? ''} onChange={event => {
          const filterAgent = Number(event.target.value) || null;
          void setQuery({filterAgent, peerAgent: filterAgent === query.peerAgent ? null : query.peerAgent, page: null});
        }}>
          <option value="">Any agent</option>{labelers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
        </select><small>Use this labeler’s saved results for the comparison or missing-result filter.</small></label>}
        {comparePeers && <label>Compare against labeler<select value={query.peerAgent ?? ''} onChange={event => void setQuery({peerAgent: Number(event.target.value) || null, page: null})}>
          <option value="">Any different agent</option>{labelers.filter(item => item.id !== query.filterAgent).map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
        </select><small>Use this second labeler when comparing two agents.</small></label>}
        {compareReviewer && <label>Annotation source<select value={query.reviewerOrigin} onChange={event => void setQuery({reviewerOrigin: event.target.value, page: null})}>
          <option value="">Any source</option>
          {Object.entries(annotationSources).map(([origin, name]) => <option key={origin} value={origin}>{name}</option>)}
        </select><small>Compare only with annotations from this source.</small></label>}
        <label>Also look for<select value={query.extraIssue} onChange={event => void setQuery({extraIssue: event.target.value, page: null})}>
          <option value="">None</option>{Object.entries(issueLabels).filter(([id]) => id !== 'all').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        {query.extraIssue && <label>When using two filters<select value={query.match} onChange={event => void setQuery({match: event.target.value === 'any' ? 'any' : 'all', page: null})}>
          <option value="all">Match both</option><option value="any">Match either</option>
        </select></label>}
      </div>
    </details>
  </>;
}
