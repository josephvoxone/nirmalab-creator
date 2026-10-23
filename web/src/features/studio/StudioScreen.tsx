import techniques from './techniques.json' with { type: 'json' };
import { StudioPage } from './StudioPage.js';
import type { Technique } from './compose.js';
import type { FetchLike } from '../../lib/api.js';

export default function StudioScreen(props: { baseUrl: string; fetchImpl: FetchLike }) {
  return <StudioPage baseUrl={props.baseUrl} fetchImpl={props.fetchImpl} techniques={techniques as Technique[]} />;
}
