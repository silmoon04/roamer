import { Check, ChevronDown, CircleHelp, ExternalLink, X } from 'lucide-react';
import { requirementResults, type Candidate, type Criteria, type TripRequirement } from '@/lib/domain';

export default function CandidateRequirements({ candidate, criteria, requirements }: { candidate: Candidate; criteria: Criteria; requirements: TripRequirement[] }) {
  const results = requirementResults(candidate, criteria, requirements);
  if (!results.length) return null;
  const contradicted = results.filter(result => result.status === 'contradicted').length;
  const unknown = results.filter(result => result.status === 'unknown').length;
  const overall = contradicted ? 'mismatch' : unknown ? 'unknown' : 'supported';
  return <details className={`candidate-requirements ${overall}`} aria-label={`Requirements for ${candidate.name}`}>
    <summary className="requirement-heading"><h5>Trip requirements</h5><span>{contradicted ? `${contradicted} ${contradicted === 1 ? 'mismatch' : 'mismatches'}${unknown?` · ${unknown} to verify`:''}` : unknown ? `${unknown} to verify` : `${results.length} verified`}</span><ChevronDown size={15} aria-hidden="true"/></summary>
    <p className="requirement-explanation">{contradicted ? 'This option does not meet every requirement.' : unknown ? 'Checked prices do not confirm these details.' : 'Evidence is linked for each requirement.'}</p>
    <ul>{results.map(result => {
      const Icon = result.status === 'supported' ? Check : result.status === 'contradicted' ? X : CircleHelp;
      const status = result.status === 'supported' ? 'Verified' : result.status === 'contradicted' ? 'Doesn’t meet' : 'Needs checking';
      return <li key={result.requirement.id} className={result.status}>
        <details>
          <summary><Icon size={16} aria-hidden="true"/><span><strong>{status}</strong><span className="requirement-preview">{result.requirement.text}</span></span><ChevronDown size={15} aria-hidden="true"/></summary>
          <div className="requirement-evidence"><small>Original request · Current dates and traveller count apply.</small><p className="requirement-original">{result.requirement.text}</p><p>{result.summary || 'No source has confirmed this requirement for the selected flights and stay.'}</p>
            {result.sources?.map((source,index) => <div className="requirement-source" key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink size={13} aria-hidden="true"/></a>{source.excerpt&&<blockquote>{source.excerpt}</blockquote>}</div>)}
            {result.checkedAt && <small>Checked {new Date(result.checkedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>}
          </div>
        </details>
      </li>;
    })}</ul>
  </details>;
}
